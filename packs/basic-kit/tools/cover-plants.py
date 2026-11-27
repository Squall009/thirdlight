"""The Basic Kit's starter cover plants: a grass clump, a flower, a reed clump and pebbles, for ground cover.

  bpipe packs/basic-kit/tools/cover-plants.py --out <dir> [--seed 7] [--samples 48] [--no-previews]

Writes into <dir>: basic-grass.glb, basic-flower.glb, basic-reed.glb, basic-pebbles.glb, cover_albedo.png (the
one shared colour atlas, encoded to KTX2 by build-basic-kit.mts --cover <dir>), cover-plants.blend, manifest.json
(triangles per level, bounds, file sizes, digests) and review renders under <dir>/preview/.

Game-ready ground cover, drawn by the tens of thousands, so every model is small:
  - three levels each, nodes `<model>_LOD0..2` (the engine's importer reads the suffix); budgets in BUDGET below,
    checked here: a model over its budget fails the run;
  - fully modelled low-poly strips and fans, no alpha cut-outs (no overdraw of see-through cards on an integrated
    GPU) and no hidden geometry: blades are single-sided strips the foliage shader draws from both sides, stones
    have no underside;
  - the pivot at the ground in the clump's middle, +Y up in the file;
  - normals bent toward straight up (UP_BIAS), so a field is lit like the ground it stands on instead of each
    blade by its own facing;
  - one 128 x 128 colour atlas for all four (a column a part: gradients from root to tip). No normal map: a
    blade is 1-3 cm wide and seen from 2 m to 40 m, where a tangent-space normal carries nothing the bent
    vertex normals do not; no ORM map: roughness is one number on the material;
  - no collision node: ground cover never collides (a collider a clump would be the defect).

COLOR_0 on the three plants is data for the engine's foliage shader, not a tint:
  R  bend weight, 0 at the root and 1 at the tip, linear in height (the shader squares it)
  G  phase, random per blade, so neighbouring blades sway out of step
  B  flutter, 0 along a blade's middle, rising to 1 at its edges towards the tip
  A  thinness (the shader's translucency term)
The pebbles carry no COLOR_0 (they wear a standard material and do not sway).

Materials in the files: `cover` (the plants; the kit maps it to its foliage material) and `stone` (the pebbles; the
kit maps it to a standard material). Both read the same atlas. The files carry no texture: their base colour is the
mean of the part of the atlas they use, so a model reads without its material.
"""
import hashlib
import json
import math
import os
import random

import bpy
from mathutils import Vector

from bp import export, util
from bp.foliage import Atlas, FoliageBuilder, tri_count

TEX = 128
COLUMN = 16

# The atlas's columns, sRGB stops from root to tip (stones: underside to top). Muted, plausible albedos: the greens
# sit a little yellow of a mown-grass ground texture so a blade reads as grass on it, not as a dark stroke.
COLUMNS = {
    # Neighbours are alike (the small mips blend a column into the ones beside it, and the atlas wraps).
    "head": ["#3a2a1b", "#4a3421", "#573d26", "#4a3421"],
    "reed": ["#66722f", "#85913c", "#a9aa55", "#c8bb76"],
    "stem": ["#567030", "#67843a", "#7b9a44", "#8eaa50"],
    "green0": ["#5f7a34", "#75933c", "#93ad4b", "#b3c268"],
    "green1": ["#587436", "#6d8c3c", "#89a548", "#a8ba60"],
    "dry": ["#6c7438", "#8f9448", "#b0ab5f", "#c9bf80"],
    "petal": ["#f1eee2", "#f6f3ea", "#efd35c", "#e0ae22"],
    "stone": ["#5f5c56", "#7c7971", "#99968d", "#b0ada4"],
}

# Triangles a level may hold (LOD0, LOD1, LOD2). A clump in view costs its level's count; within the cover's
# reach most clumps draw LOD1 or LOD2.
BUDGET = {
    "basic-grass": (48, 16, 4),
    "basic-flower": (40, 14, 5),
    "basic-reed": (44, 18, 6),
    "basic-pebbles": (48, 14, 7),
}
UP_BIAS = 0.6
THIN = 0.9


def args(p):
    p.add_argument("--out", required=True)
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--samples", type=int, default=48)
    p.add_argument("--no-previews", action="store_true")


class CoverBuilder(FoliageBuilder):
    """FoliageBuilder with the engine's COLOR_0 convention (R linear in height: the shader squares it)."""

    @staticmethod
    def wind(co, height_ref, phase, flutter, thin):
        hf = min(max(co.z / height_ref, 0.0), 1.0) if height_ref > 0 else 0.0
        return (hf, phase % 1.0, min(max(flutter, 0.0), 1.0), thin)

    def build(self, name, material):
        obj = super().build(name, material)
        me = obj.data
        # Smooth faces, so the bent vertex normals are what the file carries.
        me.shade_smooth()
        me.normals_split_custom_set_from_vertices([tuple(n) for n in self.normals])
        return obj


def make_atlas():
    a = Atlas(TEX, height=TEX, pad=2)
    for i, (key, stops) in enumerate(COLUMNS.items()):
        flat = key in ("stone", "petal", "head")
        a.add(key, (i * COLUMN, 0, (i + 1) * COLUMN, TEX), stops, across=0.0 if flat else 0.16,
              streaks=0.06 if key == "stone" else 0.04, seed=41 + i, relief="flat", rough=0.7, ao=0.0)
    return a


def spine(base, direction, height, lean, segments):
    """A blade's middle line: the lean grows along it, and it drops a little as it bends so its length holds."""
    pts = []
    for k in range(segments + 1):
        t = k / segments
        off = lean * height * t * t
        z = height * t * (1 - 0.3 * lean * lean * t)
        pts.append(base + direction * off + Vector((0, 0, z)))
    return pts


def taper(width, segments, widen=1.0, tip=1.6):
    """Even width over most of the blade, to a point at its tip."""
    return [width * widen * min(1.0, (1 - k / segments) * tip) for k in range(segments + 1)]


def blades(rng, count, height, spread, lean, width, columns, h_var=(0.6, 1.0)):
    out = []
    for _ in range(count):
        a = rng.uniform(0, 2 * math.pi)
        r = spread * math.sqrt(rng.random())
        out_a = a + rng.gauss(0, 0.6)
        out.append(dict(base=Vector((math.cos(a) * r, math.sin(a) * r, 0.0)), dir=Vector((math.cos(out_a), math.sin(out_a), 0.0)),
                        h=height * rng.uniform(*h_var), lean=rng.uniform(*lean), w=rng.uniform(*width),
                        column=rng.choice(columns), phase=rng.random()))
    # Tallest first: the lower levels keep the blades that shape the silhouette.
    out.sort(key=lambda b: -b["h"])
    return out


CENTER = Vector((0, 0, 0))


def add_blades(fb, bl, segments, widen, height_ref, thin=THIN):
    for b in bl:
        fb.strip(spine(b["base"], b["dir"], b["h"], b["lean"], segments), taper(b["w"], segments, widen), b["column"],
                 CENTER, b["phase"], height_ref, thin=thin)


def grass(atlas, mat, rng):
    """A clump of blade grass, 0.4 m at its tallest."""
    bl = blades(rng, 14, 0.40, 0.14, (0.2, 0.75), (0.032, 0.046), ["green0", "green1", "green0", "dry"])
    ref = bl[0]["h"]
    # Two segments a blade up close: more blades for the same triangles reads fuller than rounder blades.
    levels = [(14, 2, 1.0), (5, 2, 1.6), (3, 1, 2.6)]
    objs = []
    for lod, (keep, segments, widen) in enumerate(levels):
        fb = CoverBuilder(atlas, up_bias=UP_BIAS)
        add_blades(fb, bl[:keep], segments, widen, ref)
        objs.append(fb.build(f"basic-grass_LOD{lod}", mat))
    return objs


def flower_head(fb, at, tilt, radius, sides, phase, ref):
    """A shallow cup tilted outward, so it shows from above and from the side: a fan whose rim is the petals' tips and whose middle is the flower's eye."""
    up = (Vector((0, 0, 1)) + tilt * 0.7).normalized()
    a = up.cross(Vector((1, 0, 0)))
    if a.length < 1e-4:
        a = Vector((0, 1, 0))
    a.normalize()
    b = up.cross(a).normalized()
    ring = [at + (a * math.cos(k * 2 * math.pi / sides) + b * math.sin(k * 2 * math.pi / sides)) * radius + up * (radius * 0.35)
            for k in range(sides)]
    fb.fan(at, ring, "petal", CENTER, phase, ref, up=up, thin=0.6)


def flower(atlas, mat, rng):
    """Three flowers on thin stems over a few low leaves, 0.36 m: white heads with a yellow eye."""
    stems = blades(rng, 3, 0.36, 0.07, (0.15, 0.45), (0.012, 0.014), ["stem"], h_var=(0.7, 1.0))
    leaves = blades(rng, 3, 0.16, 0.07, (0.5, 0.95), (0.034, 0.044), ["green1", "green0"], h_var=(0.7, 1.0))
    ref = stems[0]["h"]
    # (stems kept, stem segments, leaves kept, leaf segments, head sides, widen)
    levels = [(3, 2, 3, 2, 6, 1.0), (2, 1, 2, 1, 4, 1.6), (1, 1, 0, 1, 3, 2.4)]
    objs = []
    for lod, (n_stem, seg_stem, n_leaf, seg_leaf, sides, widen) in enumerate(levels):
        fb = CoverBuilder(atlas, up_bias=UP_BIAS)
        for s in stems[:n_stem]:
            pts = spine(s["base"], s["dir"], s["h"], s["lean"], seg_stem)
            # A stem keeps its width to the head.
            fb.strip(pts, [s["w"] * widen] * (seg_stem + 1), "stem", CENTER, s["phase"], ref, thin=0.4)
            flower_head(fb, pts[-1], s["dir"], 0.055 * (1.0 + 0.35 * (widen - 1.0)), sides, s["phase"], ref)
        add_blades(fb, leaves[:n_leaf], seg_leaf, widen, ref)
        objs.append(fb.build(f"basic-flower_LOD{lod}", mat))
    return objs


def reed(atlas, mat, rng):
    """A clump of reeds, 1.3 m: broad upright leaves, two with a dark seed head."""
    bl = blades(rng, 6, 1.30, 0.10, (0.04, 0.24), (0.036, 0.050), ["reed", "reed", "stem"], h_var=(0.65, 1.0))
    ref = bl[0]["h"]
    levels = [(6, 3, 1.0, 2), (4, 2, 1.4, 2), (3, 1, 2.2, 1)]
    objs = []
    for lod, (keep, segments, widen, heads) in enumerate(levels):
        fb = CoverBuilder(atlas, up_bias=UP_BIAS)
        add_blades(fb, bl[:keep], segments, widen, ref)
        for b in bl[:heads]:
            # The seed head sits on the leaf's upper part: a three-sided tube up close, a flat strip from afar.
            pts = spine(b["base"], b["dir"], b["h"], b["lean"], 8)
            lo, hi = pts[5], pts[7]
            if lod == 0:
                fb.tube([lo, hi], [0.020, 0.015], 3, "head", b["phase"], ref, flutter=0.0, thin=0.1)
            else:
                w = 0.045 * widen
                fb.strip([lo, hi], [w, w * 0.8], "head", CENTER, b["phase"], ref, thin=0.2)
        objs.append(fb.build(f"basic-reed_LOD{lod}", mat))
    return objs


def stone(rng, at, radius, height, sides, mid):
    """A low dome with no underside: a ring on the ground, a ring halfway up when `mid`, a top."""
    turn = rng.uniform(0, 2 * math.pi)
    squash = rng.uniform(0.7, 1.0)
    ring = lambda r, z: [at + Vector((math.cos(turn + k * 2 * math.pi / sides) * r * rng.uniform(0.85, 1.1),
                                      math.sin(turn + k * 2 * math.pi / sides) * r * squash * rng.uniform(0.85, 1.1), z))
                         for k in range(sides)]
    verts = ring(radius, 0.0)
    faces = []
    if mid:
        verts += ring(radius * 0.72, height * 0.62)
        for k in range(sides):
            a, b = k, (k + 1) % sides
            faces += [(a, b, sides + b), (a, sides + b, sides + a)]
    top = len(verts)
    verts.append(at + Vector((rng.uniform(-0.2, 0.2) * radius, rng.uniform(-0.2, 0.2) * radius, height)))
    base = sides if mid else 0
    for k in range(sides):
        faces.append((base + k, base + (k + 1) % sides, top))
    return verts, faces


def pebbles(atlas, mat, seed):
    """Three stones, the largest 0.2 m across."""
    stones = [(Vector((0.0, 0.0, 0.0)), 0.10, 0.075), (Vector((0.16, 0.05, 0.0)), 0.065, 0.05), (Vector((-0.05, -0.14, 0.0)), 0.045, 0.035)]
    # (stones kept, sides per stone, a ring halfway up)
    levels = [(3, (6, 5, 4), True), (3, (5, 4, 3), False), (2, (4, 3), False)]
    objs = []
    for lod, (keep, sides, mid) in enumerate(levels):
        fb = CoverBuilder(atlas, up_bias=UP_BIAS)
        for i, (at, radius, height) in enumerate(stones[:keep]):
            # The same stone at every level: the same random turn and squash.
            rng = random.Random(seed * 13 + i)
            verts, faces = stone(rng, at, radius, height, sides[i], mid)
            fb.faceted(verts, faces, "stone", at + Vector((0, 0, -radius * 0.4)), 0.0, 1.0, (0.0, 0.075), facet=0.45, jitter=0.1,
                       rng=random.Random(seed * 17 + i))
        obj = fb.build(f"basic-pebbles_LOD{lod}", mat)
        # A stone does not sway and is not thin: it carries no foliage data (a standard material would read it as a tint).
        me = obj.data
        while me.color_attributes:
            me.color_attributes.remove(me.color_attributes[0])
        objs.append(obj)
    return objs


def linear(v):
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def mean_colour(keys):
    """The mean of some atlas columns' stops, linear (glTF's baseColorFactor)."""
    rgb = [0.0, 0.0, 0.0]
    n = 0
    for k in keys:
        for stop in COLUMNS[k]:
            for c in range(3):
                rgb[c] += linear(int(stop[1 + 2 * c:3 + 2 * c], 16) / 255)
            n += 1
    return tuple(c / n for c in rgb)


def file_material(name, keys):
    """An exported material: no texture (the kit's material brings the atlas), the mean colour of what it shows."""
    mat = bpy.data.materials.new(name)
    mat.use_backface_culling = False
    mat.use_nodes = True
    p = mat.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*mean_colour(keys), 1)
    p.inputs["Roughness"].default_value = 0.7
    return mat


def export_model(objs, path, colours):
    for o in bpy.context.scene.objects:
        o.select_set(o in objs)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_texcoords=True,
                              export_normals=True, export_tangents=False,
                              export_vertex_color="ACTIVE" if colours else "NONE", export_all_vertex_colors=False,
                              export_image_format="NONE", export_yup=True)


def preview_material(albedo):
    mat = bpy.data.materials.new("cover_preview")
    mat.use_backface_culling = False
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(albedo, check_existing=True)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.7
    # Half the light passes to the far side, so a blade seen from behind is not black here (the engine's foliage
    # shader lights both sides by the bent normal; this stands in for it in the review renders only).
    trans = nt.nodes.new("ShaderNodeBsdfTranslucent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs[0].default_value = 0.5
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Color"], trans.inputs["Color"])
    nt.links.new(bsdf.outputs[0], mix.inputs[1])
    nt.links.new(trans.outputs[0], mix.inputs[2])
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


def stage(res_x, res_y, samples):
    s = bpy.context.scene
    s.render.engine = "CYCLES"
    s.cycles.device = "CPU"
    s.cycles.samples = samples
    s.cycles.use_denoising = True
    s.render.resolution_x, s.render.resolution_y = res_x, res_y
    s.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.45, 0.55, 0.7, 1)
    bg.inputs["Strength"].default_value = 0.8
    s.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.data.angle = math.radians(2)
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    s.collection.objects.link(sun)
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
    floor = bpy.context.active_object
    fm = bpy.data.materials.new("ground")
    fm.use_nodes = True
    fp = fm.node_tree.nodes["Principled BSDF"]
    # A mown-grass green, as a voxel ground's grass texture reads from eye height.
    fp.inputs["Base Color"].default_value = (0.16, 0.24, 0.07, 1)
    fp.inputs["Roughness"].default_value = 0.95
    floor.data.materials.append(fm)
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    s.collection.objects.link(cam)
    s.camera = cam
    return cam


def aim(cam, target, eye, lens=50):
    cam.location = Vector(eye)
    cam.data.lens = lens
    cam.rotation_euler = (Vector(target) - cam.location).to_track_quat("-Z", "Y").to_euler()


def render(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def previews(glbs, albedo, out, samples, seed):
    """Renders of the exported files: every model and level in a row with a door-high post for scale, and a patch of each."""
    util.reset_scene()
    for g in glbs.values():
        bpy.ops.import_scene.gltf(filepath=g)
    mat = preview_material(albedo)
    parts = {o.name: o for o in bpy.context.scene.objects if o.type == "MESH"}
    for o in parts.values():
        o.data.materials.clear()
        o.data.materials.append(mat)
        o.matrix_world.translation = (0, 0, 0)
    cam = stage(1600, 800, samples)
    names = list(glbs)
    for i, name in enumerate(names):
        for lod in range(3):
            parts[f"{name}_LOD{lod}"].location = (i * 1.1 - 1.65, lod * 1.1, 0)
    # A 2 m post: a door's height.
    bpy.ops.mesh.primitive_cube_add(size=1, location=(2.6, 0, 1.0), scale=(0.08, 0.08, 2.0))
    aim(cam, (0.3, 1.0, 0.45), (0.9, -5.2, 1.7), lens=38)
    render(os.path.join(out, "preview", "cover_lineup.png"))
    # Patches: each model's LOD0 copies in its own 3 m square at a starter dressing's density.
    for o in parts.values():
        o.hide_render = True
    rng = random.Random(seed)
    density = {"basic-grass": 7, "basic-flower": 1.5, "basic-reed": 3, "basic-pebbles": 2.5}
    for i, name in enumerate(names):
        src = parts[f"{name}_LOD0"]
        ox = (i - 1.5) * 3.4
        # Grass under the flowers too, as a meadow has it.
        for model, n in ((src, density[name]),) + (((parts["basic-grass_LOD0"], 6),) if name == "basic-flower" else ()):
            for _ in range(int(9 * n)):
                c = model.copy()
                bpy.context.scene.collection.objects.link(c)
                c.hide_render = False
                c.location = (ox + rng.uniform(-1.5, 1.5), rng.uniform(-1.5, 1.5), 0)
                c.rotation_euler = (model.rotation_euler.x, model.rotation_euler.y, rng.uniform(0, 2 * math.pi))
                s = rng.uniform(0.75, 1.3)
                c.scale = (s, s, s)
    aim(cam, (0, 0.2, 0.3), (0.0, -9.0, 2.6), lens=30)
    render(os.path.join(out, "preview", "cover_patches.png"))
    aim(cam, (-5.1, 0.0, 0.2), (-5.6, -2.6, 0.9), lens=35)
    render(os.path.join(out, "preview", "cover_closeup.png"))


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def bounds(obj):
    xs = [v.co for v in obj.data.vertices]
    return [round(max(abs(c.x) for c in xs), 3), round(max(abs(c.y) for c in xs), 3), round(max(c.z for c in xs), 3)]


def main():
    a = util.parse_args(args)
    out = os.path.abspath(a.out)
    os.makedirs(os.path.join(out, "preview"), exist_ok=True)
    util.reset_scene()
    atlas = make_atlas()
    albedo = atlas.bake(os.path.join(out, "cover_albedo.png"))
    cover = file_material("cover", ["green0", "green1", "reed"])
    stone_mat = file_material("stone", ["stone"])
    rng = lambda i: random.Random(a.seed * 101 + i)
    models = {
        "basic-grass": grass(atlas, cover, rng(0)),
        "basic-flower": flower(atlas, cover, rng(1)),
        "basic-reed": reed(atlas, cover, rng(2)),
        "basic-pebbles": pebbles(atlas, stone_mat, a.seed),
    }
    report = {}
    glbs = {}
    for name, objs in models.items():
        tris = [tri_count(o) for o in objs]
        for lod, (n, most) in enumerate(zip(tris, BUDGET[name])):
            if n > most:
                raise SystemExit(f"{name} LOD{lod}: {n} triangles, over its budget of {most}")
        glb = os.path.join(out, f"{name}.glb")
        export_model(objs, glb, colours=name != "basic-pebbles")
        glbs[name] = glb
        report[name] = {"file": os.path.basename(glb), "bytes": os.path.getsize(glb), "digest": sha(glb), "triangles": tris,
                        "budget": list(BUDGET[name]), "halfExtentAndHeight": bounds(objs[0]),
                        "material": "stone" if name == "basic-pebbles" else "cover", "collision": "none"}
    export.save_blend(os.path.join(out, "cover-plants.blend"))
    if not a.no_previews:
        previews(glbs, albedo, out, a.samples, a.seed)
    manifest = {"name": "Basic Kit cover plants", "seed": a.seed, "models": report,
                "texture": {"file": os.path.basename(albedo), "size": [TEX, TEX], "bytes": os.path.getsize(albedo), "digest": sha(albedo),
                            "columns": list(COLUMNS), "maps": "albedo only (no alpha, no normal, no ORM)"}}
    with open(os.path.join(out, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print("[cover] triangles per level (LOD0 / LOD1 / LOD2), budget, file:")
    for name, r in report.items():
        print(f"[cover]   {name}: {' / '.join(map(str, r['triangles']))} (budget {' / '.join(map(str, r['budget']))}), {r['bytes']} B, "
              f"half extent and height {r['halfExtentAndHeight']} m")
    print(f"[cover] {albedo}: {TEX}x{TEX}, {os.path.getsize(albedo)} B")


main()
