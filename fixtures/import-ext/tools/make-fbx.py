"""Blender (5.2.2) FBX fixtures for the FBX import (convert-to-GLB) path.

  fbx/crate.fbx            1 m cube, checker texture in fbx/crate_checker.png
                           next to it (referenced by relative path, the usual
                           game-folder layout), and a 1 s spin animation
  fbx/crate-blue.fbx       the same cube with a blue checker (a "rebuild")
                           in fbx/crate_checker_blue.png
  fbx/crate-embedded.fbx   the red cube with its texture embedded (an upload)

Run:  blender -b --factory-startup --python make-fbx.py -- <fixtures/import-ext/fbx>
FBX headers carry a creation time, so a rerun gives new bytes (the tests do
not pin these digests).
"""
import math
import os
import sys
import bpy

out = sys.argv[sys.argv.index("--") + 1]


def checker(name, a, b, path):
    size = 64
    img = bpy.data.images.new(name, width=size, height=size, alpha=False)
    px = []
    for y in range(size):
        for x in range(size):
            px.extend(a if ((x // 8) + (y // 8)) % 2 == 0 else b)
    img.pixels = px
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return img


def build(tex_name, a, b, png):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    cube = bpy.context.active_object
    cube.name = "crate"
    img = checker(tex_name, a, b, os.path.join(out, png))
    mat = bpy.data.materials.new("crate_mat")
    mat.use_nodes = True
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    tex.interpolation = "Closest"
    nt.links.new(tex.outputs["Color"], nt.nodes["Principled BSDF"].inputs["Base Color"])
    cube.data.materials.append(mat)
    # a 1 s spin about the vertical axis
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = 1, 25
    cube.rotation_euler = (0, 0, 0)
    cube.keyframe_insert("rotation_euler", frame=1)
    cube.rotation_euler = (0, 0, math.pi)
    cube.keyframe_insert("rotation_euler", frame=25)
    return cube


def export(path, embed):
    bpy.ops.export_scene.fbx(
        filepath=path,
        path_mode="COPY" if embed else "RELATIVE",
        embed_textures=embed,
        bake_anim=True,
        add_leaf_bones=False,
    )


red = (0.8, 0.05, 0.05, 1.0)
cream = (0.95, 0.9, 0.75, 1.0)
blue = (0.05, 0.15, 0.8, 1.0)
build("crate_checker", red, cream, "crate_checker.png")
export(os.path.join(out, "crate.fbx"), False)
export(os.path.join(out, "crate-embedded.fbx"), True)
build("crate_checker_blue", blue, cream, "crate_checker_blue.png")
export(os.path.join(out, "crate-blue.fbx"), False)
