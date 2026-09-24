/**
 * Phase 9.6: the Blender (Cycles) side of the final light bake. Written to
 * the bake host next to the package and run as
 *   blender -b --factory-startup --python cycles_bake.py -- <package> <out dir>
 *
 * Units follow three.js so a baked surface looks like the realtime one:
 * three's irradiance E (a directional light's intensity × N·L, a point
 * light's candela / d², an ambient light's intensity) is what a lightmap
 * texel holds. Cycles' diffuse lighting passes (without colour) are E / π,
 * so texels are π × pass / range, sRGB-encoded. Geometry stays in three's
 * frame (+Y up; the world shader reads the sky from +Y). Baked lights give
 * direct + bounce light; mixed lights (realtime direct in the game) give
 * bounce light only — then two bakes are summed. Surfaces bounce as a
 * neutral 80 % grey. Output rows are flipped so row 0 is v = 0 (the runtime
 * loads lightmaps with flipY = false).
 */
export const CYCLES_BAKE_SCRIPT = String.raw`import json
import math
import os
import struct
import subprocess
import sys
import time

import bpy
import numpy as np
from mathutils import Matrix, Vector

args = sys.argv[sys.argv.index("--") + 1:]
PKG, OUT = args[0], args[1]
os.makedirs(OUT, exist_ok=True)
T0 = time.time()

raw = open(PKG, "rb").read()
if raw[:4] != b"TLBK" or struct.unpack_from("<I", raw, 4)[0] != 1:
    raise SystemExit("not a bake package")
hlen = struct.unpack_from("<I", raw, 8)[0]
header = json.loads(raw[12:12 + hlen].decode("utf-8"))
blob_at = 12 + hlen + ((4 - (12 + hlen) % 4) % 4)
blob = memoryview(raw)[blob_at:]
settings = header["settings"]
SAMPLES = int(settings.get("samples", 256))
BOUNCES = int(settings.get("bounces", 3))
RANGE = float(settings.get("range", 4.0))
PADDING = int(settings.get("padding", 2))


def f32(offset, count):
    if offset + count * 4 > len(blob):
        raise SystemExit("a bake array points outside the package")
    return np.frombuffer(blob, dtype="<f4", count=count, offset=offset)


def u32(offset, count):
    if offset + count * 4 > len(blob):
        raise SystemExit("a bake array points outside the package")
    return np.frombuffer(blob, dtype="<u4", count=count, offset=offset)


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"

# ---- device: OptiX when the GPU has room (>= 4 GB free), else the CPU ----
device = "CPU"
try:
    free = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=10)
    free_mb = min(int(x) for x in free.stdout.split()) if free.returncode == 0 and free.stdout.strip() else 0
    if free_mb >= 4096:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for kind in ("OPTIX", "CUDA"):
            try:
                prefs.compute_device_type = kind
                prefs.get_devices()
                gpus = [d for d in prefs.devices if d.type == kind]
                if gpus:
                    for d in prefs.devices:
                        d.use = d.type == kind
                    device = kind
                    break
            except Exception:
                continue
except Exception:
    pass
scene.cycles.device = "GPU" if device != "CPU" else "CPU"
print("TL_DEVICE " + device, flush=True)
scene.cycles.samples = SAMPLES
scene.cycles.use_denoising = False
scene.cycles.max_bounces = max(1, BOUNCES + 1)
scene.cycles.diffuse_bounces = BOUNCES
scene.cycles.glossy_bounces = 0
scene.cycles.transmission_bounces = 0
scene.cycles.transparent_max_bounces = 0
scene.render.bake.margin = PADDING + 1
scene.render.bake.margin_type = "EXTEND"
scene.render.bake.use_clear = True

# ---- atlases: one float image + one grey material per atlas ----
atlas_images = []
atlas_materials = []
for i, a in enumerate(header["atlases"]):
    img = bpy.data.images.new("atlas-%d" % i, int(a["width"]), int(a["height"]), alpha=False, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    atlas_images.append(img)
    mat = bpy.data.materials.new("bake-%d" % i)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    bsdf.inputs["Roughness"].default_value = 1.0
    node = nt.nodes.new("ShaderNodeTexImage")
    node.image = img
    nt.nodes.active = node
    atlas_materials.append(mat)
occluder_material = bpy.data.materials.new("occluder")
occluder_material.use_nodes = True
occluder_material.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)

# ---- geometry ----
meshes = {}
for g in header["geometries"]:
    n = int(g["vertexCount"])
    pos = f32(int(g["position"]), n * 3).reshape(n, 3)
    uv = f32(int(g["uv1"]), n * 2).reshape(n, 2) if g.get("uv1") is not None else None
    if g.get("index") is not None:
        idx = u32(int(g["index"]), int(g["indexCount"])).reshape(-1, 3)
    else:
        idx = np.arange(n, dtype=np.uint32).reshape(-1, 3)
    if idx.size and int(idx.max()) >= n:
        raise SystemExit("a bake index points past its vertices")
    me = bpy.data.meshes.new(g["id"])
    me.from_pydata(pos.tolist(), [], idx.tolist())
    me.validate(clean_customdata=False)
    meshes[g["id"]] = (me, uv, idx)

targets_by_atlas = [[] for _ in header["atlases"]]
all_objects = []
for o in header["objects"]:
    me, uv, idx = meshes[o["geometry"]]
    atlas = o.get("atlas")
    data = me.copy() if atlas is not None else me
    if atlas is not None:
        if uv is None:
            raise SystemExit("a lightmap target needs UV1")
        sx, sy, ox, oy = o["scaleOffset"]
        layer = data.uv_layers.new(name="UV1")
        corner_uv = uv[idx.reshape(-1)]
        corner_uv = corner_uv * np.array([sx, sy], dtype=np.float32) + np.array([ox, oy], dtype=np.float32)
        layer.data.foreach_set("uv", corner_uv.astype(np.float32).ravel())
        data.materials.append(atlas_materials[atlas])
    else:
        data.materials.append(occluder_material)
    ob = bpy.data.objects.new(o["entityId"], data)
    m = o["matrix"]  # column-major (three.js Matrix4.elements); Matrix() takes rows
    ob.matrix_world = Matrix(((m[0], m[4], m[8], m[12]), (m[1], m[5], m[9], m[13]), (m[2], m[6], m[10], m[14]), (m[3], m[7], m[11], m[15])))
    scene.collection.objects.link(ob)
    all_objects.append(ob)
    if atlas is not None:
        targets_by_atlas[atlas].append(ob)

# ---- lights (three.js units → Blender) ----
light_objects = []  # (object, mode)
world_modes = []  # (mode, kind, colours, strength)


def srgb_to_linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def colour(hexs):
    h = hexs.lstrip("#")
    return tuple(srgb_to_linear(int(h[i:i + 2], 16)) for i in (0, 2, 4))


for li in header["lights"]:
    kind, mode = li["type"], li["mode"]
    col = colour(li["color"])
    if kind in ("ambient", "hemisphere"):
        ground = colour(li.get("groundColor", "#444444")) if kind == "hemisphere" else col
        world_modes.append((mode, col, ground, float(li["intensity"])))
        continue
    if kind == "directional":
        data = bpy.data.lights.new(li["entityId"], "SUN")
        data.energy = float(li["intensity"])  # W/m² = irradiance
        data.angle = 0.03
        d = Vector(li.get("direction", [0, -1, 0])).normalized()
        ob = bpy.data.objects.new(li["entityId"], data)
        ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    else:
        data = bpy.data.lights.new(li["entityId"], "SPOT" if kind == "spot" else "POINT")
        data.energy = float(li["intensity"]) * 4.0 * math.pi  # candela → watts (irradiance = I / d²)
        data.shadow_soft_size = 0.05
        if hasattr(data, "use_soft_falloff"):
            data.use_soft_falloff = False
        ob = bpy.data.objects.new(li["entityId"], data)
        ob.location = li.get("position", [0, 0, 0])
        if kind == "spot":
            data.spot_size = math.radians(float(li.get("angle", 30))) * 2.0
            data.spot_blend = float(li.get("penumbra", 0.2))
            d = Vector(li.get("direction", [0, -1, 0])).normalized()
            ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    data.color = col
    scene.collection.objects.link(ob)
    light_objects.append((ob, mode))

# The world: ambient/hemisphere lights as sky radiance (open surface: E = π L → L = E / π), +Y is up.
world = bpy.data.worlds.new("tl-world")
scene.world = world
world.use_nodes = True
wn = world.node_tree
bg = wn.nodes.get("Background")
coord = wn.nodes.new("ShaderNodeTexCoord")
sep = wn.nodes.new("ShaderNodeSeparateXYZ")
mix = wn.nodes.new("ShaderNodeMix")
mix.data_type = "RGBA"
wn.links.new(coord.outputs["Generated"], sep.inputs[0])
step = wn.nodes.new("ShaderNodeMath")
step.operation = "GREATER_THAN"
step.inputs[1].default_value = 0.0
wn.links.new(sep.outputs["Y"], step.inputs[0])
MIX_A = next(sk for sk in mix.inputs if sk.identifier == "A_Color")
MIX_B = next(sk for sk in mix.inputs if sk.identifier == "B_Color")
MIX_OUT = next(sk for sk in mix.outputs if sk.identifier == "Result_Color")
wn.links.new(step.outputs[0], mix.inputs["Factor"])
wn.links.new(MIX_OUT, bg.inputs["Color"])


def set_world(modes):
    sky = [0.0, 0.0, 0.0]
    ground = [0.0, 0.0, 0.0]
    for mode, c, gc, strength in world_modes:
        if mode not in modes:
            continue
        for k in range(3):
            sky[k] += c[k] * strength / math.pi
            ground[k] += gc[k] * strength / math.pi
    MIX_A.default_value = (ground[0], ground[1], ground[2], 1.0)
    MIX_B.default_value = (sky[0], sky[1], sky[2], 1.0)
    bg.inputs["Strength"].default_value = 1.0


def set_lights(modes):
    for ob, mode in light_objects:
        ob.hide_render = mode not in modes


# ---- bake: baked lights direct+indirect, mixed lights indirect only ----
has_mixed = any(m == "mixed" for _, m in light_objects) or any(w[0] == "mixed" for w in world_modes)
passes = [({"baked", "mixed"}, {"INDIRECT"}), ({"baked"}, {"DIRECT"})] if has_mixed else [({"baked"}, {"DIRECT", "INDIRECT"})]
total = sum(1 for objs in targets_by_atlas if objs) * len(passes)
done = 0
print("TL_PROGRESS 0/%d" % total, flush=True)
results = [np.zeros((img.size[1], img.size[0], 3), dtype=np.float32) for img in atlas_images]
for modes, filt in passes:
    set_lights(modes)
    set_world(modes)
    for a, objs in enumerate(targets_by_atlas):
        if not objs:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        for ob in objs:
            ob.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        for ob in objs:
            ob.data.uv_layers.active = ob.data.uv_layers["UV1"]
        bpy.ops.object.bake(type="DIFFUSE", pass_filter=filt, use_selected_to_active=False, margin=PADDING + 1, use_clear=True)
        img = atlas_images[a]
        w, h = img.size
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        results[a] += px.reshape(h, w, 4)[:, :, :3]
        done += 1
        print("TL_PROGRESS %d/%d" % (done, total), flush=True)


def denoise(rgb):
    """OIDN through the compositor when this Blender has it; the input otherwise."""
    try:
        h, w = rgb.shape[:2]
        src = bpy.data.images.new("tl-denoise-in", w, h, alpha=False, float_buffer=True)
        src.pixels.foreach_set(np.concatenate([rgb, np.ones((h, w, 1), np.float32)], axis=2).ravel())
        dn = bpy.data.scenes.new("tl-denoise")
        dn.render.resolution_x, dn.render.resolution_y, dn.render.resolution_percentage = w, h, 100
        tree = bpy.data.node_groups.new("tl-denoise", "CompositorNodeTree") if hasattr(dn, "compositing_node_group") else None
        if tree is not None:
            dn.compositing_node_group = tree
        else:
            dn.use_nodes = True
            tree = dn.node_tree
        for nd in list(tree.nodes):
            tree.nodes.remove(nd)
        inp = tree.nodes.new("CompositorNodeImage")
        inp.image = src
        den = tree.nodes.new("CompositorNodeDenoise")
        if hasattr(den, "prefilter"):
            den.prefilter = "NONE"
        viewer = tree.nodes.new("CompositorNodeViewer")
        tree.links.new(inp.outputs[0], den.inputs[0])
        tree.links.new(den.outputs[0], viewer.inputs[0])
        out_node = None
        if hasattr(tree, "interface"):
            tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
            out_node = tree.nodes.new("NodeGroupOutput")
            tree.links.new(den.outputs[0], out_node.inputs[0])
        else:
            out_node = tree.nodes.new("CompositorNodeComposite")
            tree.links.new(den.outputs[0], out_node.inputs[0])
        dn.render.filepath = os.path.join(OUT, "_denoise.exr")
        dn.render.image_settings.file_format = "OPEN_EXR"
        dn.render.image_settings.color_depth = "32"
        with bpy.context.temp_override(scene=dn):
            bpy.ops.render.render(write_still=True, scene=dn.name)
        res = bpy.data.images.load(dn.render.filepath)
        res.colorspace_settings.name = "Non-Color"
        out = np.empty(w * h * 4, dtype=np.float32)
        res.pixels.foreach_get(out)
        os.remove(dn.render.filepath)
        print("TL_DENOISE ok", flush=True)
        return out.reshape(h, w, 4)[:, :, :3]
    except Exception as e:  # keep the noisy bake rather than fail it
        print("TL_DENOISE skipped: %s" % e, flush=True)
        return rgb


def encode(v):
    v = np.clip(v, 0.0, 1.0)
    return np.where(v <= 0.0031308, v * 12.92, 1.055 * np.power(v, 1.0 / 2.4) - 0.055)


for a, rgb in enumerate(results):
    rgb = denoise(rgb) if settings.get("denoise", True) else rgb
    texel = encode(rgb * math.pi / RANGE)
    h, w = texel.shape[:2]
    flipped = texel[::-1]  # row 0 of the PNG file = v 0
    out = bpy.data.images.new("out-%d" % a, w, h, alpha=False)
    out.colorspace_settings.name = "Non-Color"
    out.pixels.foreach_set(np.concatenate([flipped, np.ones((h, w, 1), np.float32)], axis=2).astype(np.float32).ravel())
    out.filepath_raw = os.path.join(OUT, "atlas-%d.png" % a)
    out.file_format = "PNG"
    out.save()

print("TL_DONE %.1f s" % (time.time() - T0), flush=True)
`;
