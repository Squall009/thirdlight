"""Blender (5.2.2) half of the import-ext fixtures.

Builds a 1 m cube with a generated 64x64 checker texture (red/cream, so a
render shows at a glance whether the texture arrived) and exports it twice:

  base-png.glb   PNG texture, plain Principled BSDF (the input for the
                 gltf-transform variants in make-variants.mjs)
  webp-cube.glb  what the Blender exporter writes for a WebP game asset:
                 EXT_texture_webp (required), plus KHR_texture_transform
                 (the mapping node repeats the checker 2x), and
                 KHR_materials_specular / KHR_materials_ior from the BSDF.
  draco-cube.glb the PNG cube with Blender's own Draco mesh compression
                 (KHR_draco_mesh_compression, required).

Run:  blender -b --factory-startup --python make-base.py -- <out dir>
"""
import sys
import bpy

out = sys.argv[sys.argv.index("--") + 1]

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1.0)
cube = bpy.context.active_object
cube.name = "checker_cube"

size = 64
img = bpy.data.images.new("checker", width=size, height=size, alpha=False)
red = (0.8, 0.05, 0.05, 1.0)
cream = (0.95, 0.9, 0.75, 1.0)
px = []
for y in range(size):
    for x in range(size):
        px.extend(red if ((x // 8) + (y // 8)) % 2 == 0 else cream)
img.pixels = px
img.pack()

mat = bpy.data.materials.new("checker_mat")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
tex = nt.nodes.new("ShaderNodeTexImage")
tex.image = img
tex.interpolation = "Closest"
nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.6
cube.data.materials.append(mat)


def export(path, fmt, draco=False):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_image_format=fmt,
        export_draco_mesh_compression_enable=draco,
        export_yup=True,
        export_animations=False,
        export_extras=False,
        export_cameras=False,
        export_lights=False,
    )


export(f"{out}/base-png.glb", "AUTO")
export(f"{out}/draco-cube.glb", "AUTO", draco=True)

# The WebP variant: repeat the checker through a mapping node and set
# specular tint / IOR so the exporter writes those extensions.
coord = nt.nodes.new("ShaderNodeTexCoord")
mapping = nt.nodes.new("ShaderNodeMapping")
mapping.inputs["Scale"].default_value = (2.0, 2.0, 1.0)
nt.links.new(coord.outputs["UV"], mapping.inputs["Vector"])
nt.links.new(mapping.outputs["Vector"], tex.inputs["Vector"])
bsdf.inputs["Specular Tint"].default_value = (1.0, 0.8, 0.6, 1.0)
bsdf.inputs["IOR"].default_value = 1.45
export(f"{out}/webp-cube.glb", "WEBP")
