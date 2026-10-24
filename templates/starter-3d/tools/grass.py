"""The 3D starter's grass: three clumps of blade grass with three levels each, for ground cover.

  bpipe templates/starter-3d/tools/grass.py --out <dir> [--seed 5]

Writes <dir>/meadow-grass.glb, <dir>/grass_albedo.png (the colour texture, encoded to KTX2 by
build-template.mts), <dir>/meadow-grass.blend, a job export (<dir>/job/manifest.json beside copies
of the model, texture and a preview) and review renders under <dir>/preview/.

The file holds pieces `grass_a` (tall), `grass_b` (medium, spread) and `grass_c` (short, some dry
blades), each `_LOD0..2`: about 60-70, 21 and 6 triangles. One material, `grass`. Blades are
single-sided tapered strips (the engine's foliage shader draws both sides); the pivot is at the
root, +Y up. No collision node: cover doesn't collide.

COLOR_0 is data for the engine's foliage shader, not a tint:
  R  bend weight, 0 at the root and 1 at the tip, linear in height (the shader squares it)
  G  phase, random per blade, so neighbouring blades sway out of step
  B  flutter, 0 along the blade's middle, rising to 1 at its edges towards the tip
  A  thinness (the shader's translucency term), 0.9 for a blade

The look is all here: the blades' shape and their colours (a darker base, lighter tips, one drier
column), nothing in the engine. The file's own base colour is the texture's mean green so the
model reads without its texture; the template's material sets the texture and a white colour.
"""
import hashlib
import json
import math
import os
import random
import shutil

import bpy
from mathutils import Vector

from bp import export, util
from bp.foliage import Atlas, FoliageBuilder, tri_count

NAME = "meadow-grass"
MATERIAL = "grass"
TEX_W, TEX_H = 64, 256

# The atlas's columns, sRGB stops from root to tip: three living greens and one dry, all muted
# and of a plausible albedo (green ~0.1-0.25 linear), not a stylised palette.
COLUMNS = {
    "green0": ["#33491f", "#4c6a2b", "#6b8a3b", "#8aa152"],
    "green1": ["#2e451d", "#47662a", "#628238", "#7d9a4a"],
    "green2": ["#3a4f22", "#567431", "#779540", "#97ab5e"],
    "dry": ["#4c5226", "#76773c", "#9a9455", "#b7aa71"],
}

# Per piece: blades, height (m), how far roots spread from the middle (m), lean (tip offset as a
# share of the height), blade width at the base (m) and which atlas columns it draws from.
PIECES = {
    "grass_a": dict(blades=14, height=0.85, spread=0.09, lean=(0.10, 0.50), width=(0.020, 0.030),
                    columns=["green0", "green1", "green2"]),
    "grass_b": dict(blades=12, height=0.65, spread=0.13, lean=(0.20, 0.70), width=(0.020, 0.032),
                    columns=["green0", "green1", "green2"]),
    "grass_c": dict(blades=11, height=0.50, spread=0.15, lean=(0.30, 0.85), width=(0.018, 0.028),
                    columns=["green1", "green2", "green2", "dry"]),
}

# Levels: blades kept (tallest first), segments per blade (tris = 2 * segments - 1) and how much
# wider the kept blades get, so a far clump covers about as much ground as a near one.
LEVELS = [
    dict(keep=None, segments=3, widen=1.0),
    dict(keep=7, segments=2, widen=1.4),
    dict(keep=6, segments=1, widen=2.0),
]
UP_BIAS = 0.5          # normals: half straight up, half out from the clump (soft, even field lighting)
THIN = 0.9


def args(p):
    p.add_argument("--out", required=True)
    p.add_argument("--seed", type=int, default=5)
    p.add_argument("--samples", type=int, default=48)


class GrassBuilder(FoliageBuilder):
    """FoliageBuilder with the engine's COLOR_0 convention (R linear in height: the shader squares it)."""

    @staticmethod
    def wind(co, height_ref, phase, flutter, thin):
        hf = min(max(co.z / height_ref, 0.0), 1.0) if height_ref > 0 else 0.0
        return (hf, phase % 1.0, min(max(flutter, 0.0), 1.0), thin)

    def build(self, name, material):
        # Smooth faces, so the soft vertex normals are what the file carries (flat faces would split
        # every vertex and export face normals).
        obj = super().build(name, material)
        me = obj.data
        me.shade_smooth()
        me.normals_split_custom_set_from_vertices([tuple(n) for n in self.normals])
        return obj


def make_atlas():
    a = Atlas(TEX_W, height=TEX_H, pad=2)
    col_w = TEX_W // len(COLUMNS)
    for i, (key, stops) in enumerate(COLUMNS.items()):
        # A lighter midrib (across), faint lengthwise streaks; no AO painted in: SSAO gives the contact.
        a.add(key, (i * col_w, 0, (i + 1) * col_w, TEX_H), stops, across=0.18, streaks=0.05, seed=31 + i,
              relief="flat", rough=0.6, ao=0.0)
    return a


def blade_specs(rng, spec):
    out = []
    for _ in range(spec["blades"]):
        a = rng.uniform(0, 2 * math.pi)
        r = spec["spread"] * math.sqrt(rng.random())
        base = Vector((math.cos(a) * r, math.sin(a) * r, 0.0))
        # Blades lean mostly outward from the middle, with some scatter.
        out_a = a + rng.gauss(0, 0.6)
        out.append(dict(
            base=base,
            dir=Vector((math.cos(out_a), math.sin(out_a), 0.0)),
            h=spec["height"] * rng.uniform(0.62, 1.0),
            lean=rng.uniform(*spec["lean"]),
            w=rng.uniform(*spec["width"]),
            column=rng.choice(spec["columns"]),
            phase=rng.random(),
        ))
    # Tallest first: the lower levels keep the blades that shape the silhouette.
    out.sort(key=lambda b: -b["h"])
    return out


def spine(b, segments):
    pts = []
    for k in range(segments + 1):
        t = k / segments
        # The lean grows along the blade (a curve); the height drops a little as it bends, so the
        # blade's length stays about the same.
        off = b["lean"] * b["h"] * t * t
        z = b["h"] * t * (1 - 0.3 * b["lean"] * b["lean"] * t)
        pts.append(b["base"] + b["dir"] * off + Vector((0, 0, z)))
    return pts


def widths(b, segments, widen):
    # Even width over most of the blade, tapering to a point at the tip.
    return [b["w"] * widen * min(1.0, (1 - k / segments) * 1.6) for k in range(segments + 1)]


def build_pieces(atlas, mat, seed):
    report = {}
    for p_i, (piece, spec) in enumerate(PIECES.items()):
        blades = blade_specs(random.Random(seed * 101 + p_i), spec)
        height_ref = max(b["h"] for b in blades)
        center = Vector((0, 0, 0))
        tris = []
        for lod, lv in enumerate(LEVELS):
            fb = GrassBuilder(atlas, up_bias=UP_BIAS)
            kept = blades if lv["keep"] is None else blades[:lv["keep"]]
            for b in kept:
                fb.strip(spine(b, lv["segments"]), widths(b, lv["segments"], lv["widen"]), b["column"], center,
                         b["phase"], height_ref, thin=THIN)
            obj = fb.build(f"{piece}_LOD{lod}", mat)
            tris.append(tri_count(obj))
        report[piece] = tris
    return report


def preview_material(albedo):
    """Blender-only stand-in for the engine's foliage material: the albedo, roughness 0.6 and a
    little light through the blade (the shader's translucency term)."""
    mat = bpy.data.materials.new("grass_preview")
    mat.use_backface_culling = False
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(albedo, check_existing=True)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Roughness"].default_value = 0.6
    trans = nt.nodes.new("ShaderNodeBsdfTranslucent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs[0].default_value = 0.25
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Color"], trans.inputs["Color"])
    nt.links.new(bsdf.outputs[0], mix.inputs[1])
    nt.links.new(trans.outputs[0], mix.inputs[2])
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return mat


def file_material(mean):
    """The exported material: no texture (the engine's material brings it), the texture's mean colour."""
    mat = bpy.data.materials.new(MATERIAL)
    mat.use_backface_culling = False
    mat.use_nodes = True
    p = mat.node_tree.nodes["Principled BSDF"]
    p.inputs["Base Color"].default_value = (*mean, 1)
    p.inputs["Roughness"].default_value = 0.6
    return mat


def mean_colour(path):
    img = bpy.data.images.load(path, check_existing=False)
    px = list(img.pixels)
    n = len(px) // 4
    # The PNG holds sRGB values as stored; glTF's baseColorFactor is linear.
    lin = lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return tuple(lin(sum(px[c::4]) / n) for c in range(3))


def stage(res_x, res_y, samples):
    s = bpy.context.scene
    s.render.engine = "CYCLES"
    s.cycles.device = "CPU"
    s.cycles.samples = samples
    s.cycles.use_denoising = True
    s.render.resolution_x, s.render.resolution_y = res_x, res_y
    s.view_settings.view_transform = "AgX"
    world = bpy.data.worlds.new("sky")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.45, 0.55, 0.7, 1)
    bg.inputs["Strength"].default_value = 0.8
    s.world = world
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.0
    sun.data.angle = math.radians(2)
    sun.rotation_euler = (math.radians(55), 0, math.radians(30))
    s.collection.objects.link(sun)
    bpy.ops.mesh.primitive_plane_add(size=40, location=(0, 0, 0))
    floor = bpy.context.active_object
    fm = bpy.data.materials.new("soil")
    fm.use_nodes = True
    fp = fm.node_tree.nodes["Principled BSDF"]
    fp.inputs["Base Color"].default_value = (0.09, 0.075, 0.05, 1)
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


def previews(glb, albedo, out, samples, seed):
    """Renders of the exported file: every piece and level in a row, and a patch of field."""
    util.reset_scene()
    bpy.ops.import_scene.gltf(filepath=glb)
    mat = preview_material(albedo)
    parts = {o.name: o for o in bpy.context.scene.objects if o.type == "MESH"}
    for o in parts.values():
        o.data.materials.clear()
        o.data.materials.append(mat)
        o.matrix_world.translation = (0, 0, 0)
    cam = stage(1600, 800, samples)
    # Lineup: pieces along X, levels along -Y.
    for i, piece in enumerate(PIECES):
        for lod in range(len(LEVELS)):
            parts[f"{piece}_LOD{lod}"].location = (i * 1.2 - 1.2, lod * 1.2, 0)
    aim(cam, (0, 1.2, 0.35), (0.6, -4.4, 1.5), lens=40)
    render(os.path.join(out, "preview", f"{NAME}_lineup.png"))
    # Field: LOD0 copies at about 8 per m² (the cover budget), random turn and scale, in a 4 m square.
    originals = [parts[f"{p}_LOD0"] for p in PIECES]
    for o in parts.values():
        o.hide_render = True
    rng = random.Random(seed)
    side = 4.0
    count = int(side * side * 8)
    for _ in range(count):
        src = rng.choice(originals)
        c = src.copy()
        bpy.context.scene.collection.objects.link(c)
        c.hide_render = False
        c.location = (rng.uniform(-side / 2, side / 2), rng.uniform(-side / 2, side / 2), 0)
        c.rotation_euler = (src.rotation_euler.x, src.rotation_euler.y, rng.uniform(0, 2 * math.pi))
        s = rng.uniform(0.8, 1.3)
        c.scale = (s, s, s)
    aim(cam, (0, 0.5, 0.3), (-1.6, -3.4, 1.0), lens=35)
    render(os.path.join(out, "preview", f"{NAME}_field.png"))
    aim(cam, (0.2, 0.2, 0.35), (-0.6, -1.2, 0.55), lens=35)
    render(os.path.join(out, "preview", f"{NAME}_closeup.png"))


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    a = util.parse_args(args)
    out = os.path.abspath(a.out)
    os.makedirs(os.path.join(out, "preview"), exist_ok=True)
    util.reset_scene()
    atlas = make_atlas()
    albedo = atlas.bake(os.path.join(out, "grass_albedo.png"))
    mat = file_material(mean_colour(albedo))
    report = build_pieces(atlas, mat, a.seed)
    for o in bpy.context.scene.objects:
        o.select_set(o.type == "MESH")
    glb = os.path.join(out, f"{NAME}.glb")
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True, export_texcoords=True,
                              export_normals=True, export_tangents=False, export_vertex_color="ACTIVE",
                              export_all_vertex_colors=False, export_image_format="NONE", export_yup=True)
    export.save_blend(os.path.join(out, f"{NAME}.blend"))

    previews(glb, albedo, out, a.samples, a.seed)

    # The job export: the model, its colour texture and a preview, with digests and triangle counts.
    job = os.path.join(out, "job")
    os.makedirs(job, exist_ok=True)
    files = []
    for src, role in ((glb, "model"), (albedo, "texture"), (os.path.join(out, "preview", f"{NAME}_lineup.png"), "preview")):
        dst = os.path.join(job, os.path.basename(src))
        shutil.copyfile(src, dst)
        files.append({"path": os.path.basename(src), "role": role, "digest": sha(dst)})
    # Triangles as an importer counts them (every node of the file), and per level across the pieces.
    lods = [sum(r[l] for r in report.values()) for l in range(len(LEVELS))]
    manifest = {"name": "Meadow grass", "files": files, "triangles": sum(lods), "lods": lods,
                "pieces": report, "texture": {"file": os.path.basename(albedo), "size": [TEX_W, TEX_H]}}
    with open(os.path.join(job, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)
    print("[grass] tris per piece (LOD0 / LOD1 / LOD2):")
    for piece, tris in report.items():
        print(f"[grass]   {piece}: {tris[0]} / {tris[1]} / {tris[2]}")
    print(f"[grass] {glb}: {os.path.getsize(glb)} B; {albedo}: {TEX_W}x{TEX_H}")


main()
