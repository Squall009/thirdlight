"""
Blender templates for voxel kits, their one-click export, and the recommended sample kit built through both.

    blender --background --python tools/voxel-bench/kits/kit_templates.py -- templates [--out DIR]
        writes voxel-kit-templates.blend: one collection a slot (17) with its guides, a 4 x 4 m wall tile reference,
        the UV guide of the kit's sheet layout and this script inside (Text editor: "kit_templates.py")
    blender --background --python tools/voxel-bench/kits/kit_templates.py -- sample [--out DIR] [--blend]
        builds the templates, models the recommended sample kit into its slots and exports it through the same
        export as an artist's kit: voxel-kit-sample.glb + sample.voxelkit.json (and voxel-kit-sample.blend with --blend)
    blender --background my-kit.blend --python tools/voxel-bench/kits/kit_templates.py -- export [--out DIR]
        exports an edited template: <id>.voxelkit.json + voxel-kit-<id>.glb (DIR: the .blend's folder)
    ... sample|export --sheet DIR
        puts the kit's sheet (DIR/albedo.png, DIR/normal.png, DIR/orm.png) on the kit's one material first
    In Blender's UI: open the template, Text editor, kit_templates.py, Run Script: the same export.

Why it is built this way:
- Every number comes from slot-contract.json (generated from the engine's catalogue and kit check by
  tools/voxel-bench/gen-slot-sheets.mjs): the anchor, open side, run, the touch and fit boxes, the rotations that let a
  slot borrow another's mesh. The templates and the kit check therefore hold the same envelope.
- Blender is Z up; the engine (glTF) is +y up. The export turns it (+Y up), so in Blender a piece's open side is -Y
  (the Front view), its run +X, up +Z, the voxel body toward +Y.
- One collection a slot, its slot empty `SLOT <id>` at the collection's place in the scene. A piece is modelled at
  that place; the export writes it relative to the empty, so every piece lands at the GLB's origin as the engine
  expects (the origin is the anchor cell's centre). Guides carry `tl_guide` and are never exported.
- A slot borrows another slot's meshes (the empty's `tl_source`, `tl_rotation`): one mesh fills many slots, turned by
  one of the 24 cube rotations, as the slot sheets list.
- One texture set a kit: the export draws every piece with the kit's one material (the kit check's rule). The
  material's real images go into the GLB when it has them (an albedo image on Base Color that is not the UV guide;
  normal map, and ORM as occlusion / roughness / metal), so the import extracts the kit's sheet into KTX2 textures
  the pieces draw with; a material still on the UV guide is written as a placeholder (no images).
- No LODs (pieces draw at level 0 only), collision from the voxels: the export writes one mesh a piece and nothing else.
- The kit record's other fields live in the scene's `tl_kit` property (JSON), so the .blend is the whole source.
"""
import hashlib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import make_placeholder_kits as mpk  # noqa: E402  the geometry helpers the sample kit is built with

CONTRACT_FILE = os.path.join(HERE, 'slot-contract.json')
TEMPLATES_BLEND = 'voxel-kit-templates.blend'
GUIDE_COLLECTION = 'reference (not exported)'
# Where slot collections sit in the scene: one row a family, SPACING metres apart.
SPACING = 2.0
FAMILY_ROWS = ['outer-edge', 'inner-edge', 'outer-corner', 'inner-corner', 'roof-edge', 'damage']
GUIDE_IMAGE_MAX = 1024  # px a side of the packed UV guide (the sheet itself is the kit's size)

# The recommended sheet for a kit's pieces: 2048 px, 2 m wide at 1024 px/m (the base tile's density; U repeats every
# 2 m along a run), two strips for profiles along an edge, a 1 m field for faces up a roof's slope and across a hip, two caps for
# ends, 32 px gutters; unused space neutral. A kit may declare any layout.
DEFAULT_SHEET_LAYOUT = {
    'size': 2048, 'pxPerMetre': 1024, 'regions': [
        {'id': 'S25', 'kind': 'strip', 'metres': 0.25, 'y': [32, 288]},
        {'id': 'S12', 'kind': 'strip', 'metres': 0.125, 'y': [352, 480]},
        {'id': 'F1', 'kind': 'field', 'metres': 1.0, 'y': [544, 1568]},
        {'id': 'C25a', 'kind': 'cap', 'metres': 0.25, 'y': [1632, 1888], 'x': [32, 288]},
        {'id': 'C12a', 'kind': 'cap', 'metres': 0.125, 'y': [1632, 1760], 'x': [352, 480]},
    ],
}

DEFAULT_KIT = {
    'voxelKitId': 'my-kit', 'name': 'My kit', 'version': 1, 'materialType': 'stone', 'materials': [],
    'jitter': 1, 'sheetLayout': DEFAULT_SHEET_LAYOUT,
}


def load_contract():
    with open(CONTRACT_FILE) as f:
        return json.load(f)


def node_name(slot, k):
    # Letters, digits, - and _ only: three's loader strips '.', ':' and '/' from node names.
    return f'{slot}_v{k}'


# ---------------------------------------------------------------------------------------------------------------------
# Templates

def wire_box(bpy, name, lo, hi, coll, parent):
    """A box drawn as wire (a guide: never exported, never rendered)."""
    xs, ys, zs = (lo[0], hi[0]), (lo[1], hi[1]), (lo[2], hi[2])
    verts = [(x, y, z) for x in xs for y in ys for z in zs]
    edges = [(0, 1), (2, 3), (4, 5), (6, 7), (0, 2), (1, 3), (4, 6), (5, 7), (0, 4), (1, 5), (2, 6), (3, 7)]
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, edges, [])
    return guide(bpy, bpy.data.objects.new(name, me), coll, parent)


def guide(bpy, ob, coll, parent):
    ob['tl_guide'] = 1
    ob.hide_render = True
    ob.hide_select = True
    if parent is not None:
        ob.parent = parent
    coll.objects.link(ob)
    return ob


def arrow(bpy, name, at, direction, size, coll, parent):
    """A single-arrow empty at `at` pointing along `direction` (Blender axes)."""
    from mathutils import Vector
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = 'SINGLE_ARROW'
    ob.empty_display_size = size
    ob.location = at
    ob.rotation_mode = 'QUATERNION'
    ob.rotation_quaternion = Vector((0.0, 0.0, 1.0)).rotation_difference(Vector(direction))
    return guide(bpy, ob, coll, parent)


def label(bpy, name, text, at, size, coll, parent):
    cu = bpy.data.curves.new(name, 'FONT')
    cu.body = text
    cu.size = size
    ob = bpy.data.objects.new(name, cu)
    ob.location = at
    ob.rotation_euler = (math.pi / 2, 0.0, 0.0)  # upright, read from the Front view
    return guide(bpy, ob, coll, parent)


def slot_place(contract):
    """Each slot's place in the scene: a row a family, along X."""
    rows = {f: 0 for f in FAMILY_ROWS}
    out = {}
    for s in contract['slots']:
        r = FAMILY_ROWS.index(s['family'])
        out[s['id']] = (rows[s['family']] * SPACING, r * SPACING * 1.5, 0.0)
        rows[s['family']] += 1
    return out


def layout_regions(layout):
    """A kit sheet layout (the record's sheetLayout) in the form the geometry helpers read."""
    out = {}
    for r in layout['regions']:
        out[r['id']] = (r['kind'], r['metres'], r['y'][0], r['y'][1]) + ((r['x'][0], r['x'][1]) if 'x' in r else ())
    return out


def guide_image(bpy, layout):
    """The sheet layout as an image: each region its own hue (a 1/8 m checker in it), gutters and spare space grey."""
    import numpy as np
    size = layout['size']
    n = min(size, GUIDE_IMAGE_MAX)
    k = size / n
    px = np.full((n, n, 4), (0.5, 0.5, 0.5, 1.0), dtype=np.float32)
    hues = [(0.85, 0.35, 0.3), (0.3, 0.7, 0.4), (0.3, 0.45, 0.85), (0.85, 0.7, 0.25), (0.65, 0.35, 0.8), (0.3, 0.75, 0.8)]
    check = max(1, int(round(layout['pxPerMetre'] / 8 / k)))
    yy, xx = np.mgrid[0:n, 0:n]
    for i, r in enumerate(layout['regions']):
        y0, y1 = int(r['y'][0] / k), int(r['y'][1] / k)
        x0, x1 = (int(r['x'][0] / k), int(r['x'][1] / k)) if 'x' in r else (0, n)
        c = np.array(hues[i % len(hues)] + (1.0,), dtype=np.float32)
        tile = ((xx[y0:y1, x0:x1] // check + yy[y0:y1, x0:x1] // check) % 2)[..., None]
        px[y0:y1, x0:x1, :3] = c[:3] * (0.8 + 0.2 * tile)
    img = bpy.data.images.new('uv-guide', n, n, alpha=False)
    # glTF v runs down from the top; Blender's image rows run up from the bottom.
    img.pixels.foreach_set(px[::-1].ravel())
    img.pack()
    return img


def kit_material(bpy, kit_id, img):
    """The kit's one material: the UV guide in the viewport (the export writes a placeholder of it, no image)."""
    mat = bpy.data.materials.new(f'{kit_id}-sheet')
    if mat.node_tree is None:  # older Blender: a new material has no node tree until asked
        mat.use_nodes = True
    nodes = mat.node_tree.nodes
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = img
    tex.interpolation = 'Closest'
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    return mat


def use_sheet(bpy, mat, folder):
    """Put a kit's sheet (albedo.png, normal.png, orm.png in `folder`) on its one material, as the glTF exporter reads it."""
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = next(n for n in nodes if n.type == 'BSDF_PRINCIPLED')
    for n in [n for n in nodes if n.type == 'TEX_IMAGE']:
        nodes.remove(n)

    def image(name, colour):
        tex = nodes.new('ShaderNodeTexImage')
        tex.image = bpy.data.images.load(os.path.join(folder, f'{name}.png'))
        tex.image.name = f'{mat.name}-{name}'
        tex.image.colorspace_settings.name = 'sRGB' if colour else 'Non-Color'
        return tex

    albedo = image('albedo', True)
    # The albedo's A is the height (texture layout v1 as amended), not a coverage: channel-packed so Blender never
    # premultiplies the colour by it, and its Alpha is left unlinked so the exporter writes an OPAQUE material with
    # the image as it is.
    albedo.image.alpha_mode = 'CHANNEL_PACKED'
    links.new(albedo.outputs['Color'], bsdf.inputs['Base Color'])
    nm = nodes.new('ShaderNodeNormalMap')
    links.new(image('normal', False).outputs['Color'], nm.inputs['Color'])
    links.new(nm.outputs['Normal'], bsdf.inputs['Normal'])
    orm = image('orm', False)
    sep = nodes.new('ShaderNodeSeparateColor')
    links.new(orm.outputs['Color'], sep.inputs['Color'])
    links.new(sep.outputs['Green'], bsdf.inputs['Roughness'])
    links.new(sep.outputs['Blue'], bsdf.inputs['Metallic'])
    # Occlusion: the exporter's "glTF Material Output" group (its Occlusion socket, the ORM's R).
    group = bpy.data.node_groups.get('glTF Material Output')
    if group is None:
        group = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
        group.interface.new_socket('Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
    out = nodes.new('ShaderNodeGroup')
    out.node_tree = group
    links.new(sep.outputs['Red'], out.inputs['Occlusion'])


def has_sheet(mat):
    """Whether the kit's material carries a real sheet: an albedo image on Base Color other than the UV guide."""
    bsdf = next((n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None) if mat.node_tree else None
    if bsdf is None or not bsdf.inputs['Base Color'].is_linked:
        return False
    src = bsdf.inputs['Base Color'].links[0].from_node
    return src.type == 'TEX_IMAGE' and src.image is not None and src.image.name != 'uv-guide'


def wall_tile(bpy, coll, at, mat):
    """The 4 x 4 m base tile as a wall (the material's tiling texture covers it once), its 0.5 m grid as wire."""
    me = bpy.data.meshes.new('wall-tile-4m')
    verts, faces = [], []
    n = 8
    for j in range(n + 1):
        for i in range(n + 1):
            verts.append((at[0] + i * 0.5, at[1], at[2] + j * 0.5))
    for j in range(n):
        for i in range(n):
            a = j * (n + 1) + i
            faces.append((a, a + 1, a + n + 2, a + n + 1))
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name='UVMap')
    for loop in me.loops:
        x, _, z = verts[loop.vertex_index]
        uv.data[loop.index].uv = ((x - at[0]) / 4.0, (z - at[2]) / 4.0)
    me.materials.append(mat)
    ob = guide(bpy, bpy.data.objects.new('wall-tile-4m (base texture, 1024 px/m, grid 0.5 m)', me), coll, None)
    ob.show_wire = True
    label(bpy, 'wall-tile-label', '4 x 4 m base tile: 4096 px, grid 0.5 m, bottom edge = 0 m', (at[0], at[1] - 0.01, at[2] - 0.3), 0.15, coll, None)
    return ob


def u_ruler(bpy, coll, at, layout, mat):
    """A 2 m strip along X mapped as the engine maps a run: U = (x + 0.25) x pxPerMetre / size, so it repeats per sheet width."""
    rate = layout['pxPerMetre'] / layout['size']
    strip = next((r for r in layout['regions'] if r['kind'] in ('strip', 'profiled', 'field')), None)
    if strip is None:
        return None
    v0, v1 = strip['y'][0] / layout['size'], strip['y'][1] / layout['size']
    me = bpy.data.meshes.new('u-ruler')
    length = 2.0
    verts = [(at[0], at[1], at[2]), (at[0] + length, at[1], at[2]), (at[0] + length, at[1], at[2] + strip['metres']), (at[0], at[1], at[2] + strip['metres'])]
    me.from_pydata(verts, [], [(0, 1, 2, 3)])
    uv = me.uv_layers.new(name='UVMap')
    for loop in me.loops:
        x, _, z = verts[loop.vertex_index]
        uv.data[loop.index].uv = ((x - at[0]) * rate, 1.0 - (v1 if z == at[2] else v0))
    me.materials.append(mat)
    guide(bpy, bpy.data.objects.new(f'u-ruler ({strip["id"]}: U = (x + 0.25) x {rate:g} a metre)', me), coll, None)
    label(bpy, 'u-ruler-label', f'world-anchored U: {rate:g} a metre from the cell -X face, along the run', (at[0], at[1] - 0.01, at[2] - 0.2), 0.1, coll, None)


def build_templates(bpy, contract, kit):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = 'METRIC'
    scene['tl_kit'] = json.dumps(kit, indent=1)
    layout = kit.get('sheetLayout', DEFAULT_SHEET_LAYOUT)
    img = guide_image(bpy, layout)
    mat = kit_material(bpy, kit['voxelKitId'], img)
    ref = bpy.data.collections.new(GUIDE_COLLECTION)
    scene.collection.children.link(ref)
    places = slot_place(contract)
    for s in contract['slots']:
        coll = bpy.data.collections.new(s['id'])
        scene.collection.children.link(coll)
        at = places[s['id']]
        empty = bpy.data.objects.new(f'SLOT {s["id"]}', None)
        empty.empty_display_type = 'PLAIN_AXES'
        empty.empty_display_size = 0.1
        empty.location = at
        empty['tl_slot'] = s['id']
        empty['tl_source'] = ''
        empty['tl_rotation'] = 0
        coll.objects.link(empty)
        b = s['blender']
        wire_box(bpy, f'{s["id"]} cell', (-0.25, -0.25, -0.25), (0.25, 0.25, 0.25), coll, empty)
        wire_box(bpy, f'{s["id"]} touch box', b['touch']['min'], b['touch']['max'], coll, empty)
        wire_box(bpy, f'{s["id"]} fit box', b['fit']['min'], b['fit']['max'], coll, empty)
        anchor = bpy.data.objects.new(f'{s["id"]} anchor', None)
        anchor.empty_display_type = 'SPHERE'
        anchor.empty_display_size = 0.02
        anchor.location = b['anchor']
        guide(bpy, anchor, coll, empty)
        arrow(bpy, f'{s["id"]} open side', b['anchor'], b['open'], 0.2, coll, empty)
        arrow(bpy, f'{s["id"]} run', b['anchor'], (0.0, 0.0, 1.0) if b['run'] == 'Z' else (1.0, 0.0, 0.0), 0.3, coll, empty)
        label(bpy, f'{s["id"]} label', s['id'], (-0.5, -0.6, -0.6), 0.09, coll, empty)
    rows = len(FAMILY_ROWS) * SPACING * 1.5
    wall_tile(bpy, ref, (-1.0, rows + 1.0, 0.0), mat)
    u_ruler(bpy, ref, (4.0, rows + 1.0, 0.0), layout, mat)
    readme = bpy.data.texts.new('README')
    readme.write(README.format(guide='docs/manual/guides/voxel-kits.md', sheets='docs/manual/guides/voxel-kit-slots/'))
    script = bpy.data.texts.new('kit_templates.py')
    with open(os.path.abspath(__file__)) as f:
        script.write(f.read())
    script['tl_contract'] = json.dumps(contract)
    return mat


README = """Thirdlight voxel kit template (metres; Blender Z up, exported +Y up)

One collection a slot. Model a piece inside its slot's collection, at the slot (the empty SLOT <id> is the anchor
cell's centre; the wire cube is the 0.5 m cell). The open side faces -Y (Front view), the run is +X (vertical edges:
+Z), the voxel body is toward +Y. Stay inside the 'fit box'; touch the 'touch box'.
- Several meshes in one slot are its variants (picked per piece by the project seed); a mesh's custom properties
  tl_weight (relative weight, default 1) and tl_mirror (1: drawn mirrored across the run) are exported.
- To fill a slot with another slot's meshes, set the slot empty's tl_source to that slot and tl_rotation to the
  rotation the slot sheet lists (e.g. edge-out-bottom: edge-out-top, 5).
- Kit fields (id, name, material type, jitter, sheetLayout or trimLayout, damage, wallTopFill, gameData): the scene's
  custom property tl_kit (JSON).
- No faces against the voxel body or under a roof plane; smooth members, flat cut faces; fine detail as baked normals.
  At most the slot sheet's triangles a mesh. No LODs; collision comes from the voxels.
- UVs: the kit's one material shows the sheet layout (uv-guide). Faces along the run: U = (x + 0.25) x pxPerMetre /
  size from the cell's -X face (the u-ruler shows it), V at the same density; end faces in a cap cell (id ending 'a').
Export: Text editor -> kit_templates.py -> Run Script (writes <id>.voxelkit.json and voxel-kit-<id>.glb next to the
.blend). Then import the GLB into the project's assets, set the kit (setVoxelKit) and read the kit check.
Guide: {guide}   Slot sheets: {sheets}
"""


# ---------------------------------------------------------------------------------------------------------------------
# Export

def scene_kit(bpy):
    raw = bpy.context.scene.get('tl_kit')
    kit = dict(DEFAULT_KIT)
    if raw:
        kit.update(json.loads(raw))
    return kit


def slot_meshes(bpy, contract):
    """Each slot's own meshes (objects in its collection that are not guides), in name order, with its empty."""
    out = {}
    ids = {s['id'] for s in contract['slots']}
    for coll in bpy.data.collections:
        if coll.name not in ids:
            continue
        empty = next((o for o in coll.objects if o.get('tl_slot') == coll.name), None)
        meshes = sorted((o for o in coll.all_objects if o.type == 'MESH' and not o.get('tl_guide')), key=lambda o: o.name)
        out[coll.name] = (empty, meshes)
    return out


def export_kit(bpy, contract, out_dir, materials=None):
    """Write the kit's GLB (one node a mesh, at the origin) and its record; return their paths and a report."""
    kit = scene_kit(bpy)
    kit_id = kit['voxelKitId']
    slots = slot_meshes(bpy, contract)
    mat = bpy.data.materials.get(f'{kit_id}-sheet') or bpy.data.materials.new(f'{kit_id}-sheet')
    # The kit's real images when its material has them; a material still on the UV guide as a placeholder.
    if materials is None:
        materials = 'EXPORT' if has_sheet(mat) else 'PLACEHOLDER'
    depsgraph = bpy.context.evaluated_depsgraph_get()
    copies, own, renamed = [], {}, []
    bpy.ops.object.select_all(action='DESELECT')
    for sid, (empty, meshes) in slots.items():
        base = empty.matrix_world.inverted() if empty is not None else None
        for k, ob in enumerate(meshes):
            # The mesh as drawn (modifiers applied), moved from the slot's place to the GLB's origin.
            me = bpy.data.meshes.new_from_object(ob.evaluated_get(depsgraph))
            me.transform(base @ ob.matrix_world if base is not None else ob.matrix_world)
            me.materials.clear()
            me.materials.append(mat)
            name = node_name(sid, k)
            # The export's node takes the name exactly: an object already holding it steps aside until the end.
            held = bpy.data.objects.get(name)
            if held is not None:
                renamed.append((held, name))
                held.name = f'{name}~source'
            cp = bpy.data.objects.new(name, me)
            bpy.context.scene.collection.objects.link(cp)
            cp.select_set(True)
            copies.append(cp)
            own.setdefault(sid, []).append((name, ob))
    os.makedirs(out_dir, exist_ok=True)
    glb = os.path.join(out_dir, f'voxel-kit-{kit_id}.glb')
    bpy.ops.export_scene.gltf(
        filepath=glb, export_format='GLB', use_selection=True, export_yup=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_materials=materials, export_cameras=False,
        export_lights=False, export_apply=False, export_animations=False, export_skins=False, export_morph=False,
        export_extras=False,
    )
    for cp in copies:
        me = cp.data
        bpy.data.objects.remove(cp)
        bpy.data.meshes.remove(me)
    for held, name in renamed:
        held.name = name
    with open(glb, 'rb') as f:
        data = f.read()
    digest = hashlib.sha256(data).hexdigest()
    asset_id = f'voxel-kit-{kit_id}'

    def entries(sid, rotation):
        out = []
        for name, ob in own.get(sid, []):
            m = {'mesh': {'assetId': asset_id, 'digest': digest, 'node': name}}
            if rotation:
                m['rotation'] = rotation
            w = ob.get('tl_weight')
            if w is not None and float(w) != 1:
                m['weight'] = float(w)
            if ob.get('tl_mirror'):
                m['mirror'] = True
            out.append(m)
        return out

    record_slots = {}
    for sid, (empty, _) in slots.items():
        source = empty.get('tl_source', '') if empty is not None else ''
        meshes = entries(source, int(empty.get('tl_rotation', 0))) if source else entries(sid, 0)
        if meshes:
            record_slots[sid] = {'meshes': meshes}
    record = {'kitFormat': 1, 'voxelKitId': kit_id, 'name': kit['name'], 'version': kit['version'], 'materialType': kit['materialType']}
    if kit.get('materials'):
        record['materials'] = sorted(kit['materials'])
    record['slots'] = dict(sorted(record_slots.items()))
    for key in ('jitter', 'trimLayout', 'sheetLayout', 'damage', 'wallTopFill', 'gameData'):
        if key in kit and not (key == 'jitter' and kit[key] == contract['jitter']['default']) and not (key == 'wallTopFill' and not kit[key]):
            record[key] = kit[key]
    path = os.path.join(out_dir, f'{kit_id}.voxelkit.json')
    with open(path, 'w') as f:
        json.dump(record, f, indent=1)
        f.write('\n')
    tris = {name: count_tris(bpy, ob) for sid in own for name, ob in own[sid]}
    return glb, path, len(data), digest, tris


def count_tris(bpy, ob):
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    me.calc_loop_triangles()
    n = len(me.loop_triangles)
    bpy.data.meshes.remove(me)
    return n


# ---------------------------------------------------------------------------------------------------------------------
# The recommended sample kit: a dressed trim (bevelled rims proud of the faces, chamfer fillets in the coves, a corner
# block, roof caps, a drip lip, a verge board, chips for damage), on the recommended 2048 sheet. Three meshes fill the ten
# edge and corner slots by the slot sheets' rotations; the inner corners stay empty (the fillets close them).

SAMPLE_KIT = {
    'voxelKitId': 'sample', 'name': 'Sample dressed trim (authoring package)', 'version': 1, 'materialType': 'stone',
    'materials': [12], 'jitter': 1, 'sheetLayout': DEFAULT_SHEET_LAYOUT,
    'gameData': {'sample': True, 'break': 'crumble', 'sound': 'stone'},
}


def sample_pieces():
    H = mpk.HALF
    P = 0.03  # stands proud of its faces: more than the stagger sinks it at jitter 1 (1.6 cm)
    back = H - 0.07
    k = {}

    def rim(chip):
        pts = [(back, H), (back, H + P), (H + P - chip, H + P), (H + P, H + P - chip), (H + P, back), (H, back)]
        p = mpk.ext_x(pts, 'S25', -H, H, (H, H))
        for x, out in ((-H, (-1.0, 0.0, 0.0)), (H, (1.0, 0.0, 0.0))):
            p.add(mpk.poly([(x, H, H)] + [(x, y, z) for z, y in pts], out, 'C12a'))
        return p

    k['edge-out-top'] = [rim(0.02), rim(0.035)]

    f = 0.04
    fillet = mpk.poly([(-H, H + f, H), (H, H + f, H), (H, H, H + f), (-H, H, H + f)], (0.0, 1.0, 1.0), 'S12')
    for x, out in ((-H, (-1.0, 0.0, 0.0)), (H, (1.0, 0.0, 0.0))):
        fillet.add(mpk.poly([(x, H, H), (x, H + f, H), (x, H, H + f)], out, 'C12a'))
    k['edge-in-bottom'] = [fillet]

    a, b = back, H + P + 0.004
    block = mpk.Piece()
    block.add(mpk.poly([(b, a, a), (b, b, a), (b, b, b), (b, a, b)], (1.0, 0.0, 0.0), 'C12a'))
    block.add(mpk.poly([(a, b, a), (b, b, a), (b, b, b), (a, b, b)], (0.0, 1.0, 0.0), 'S25'))
    block.add(mpk.poly([(a, a, b), (b, a, b), (b, b, b), (a, b, b)], (0.0, 0.0, 1.0), 'S25'))
    k['corner-out-top'] = [block]

    w = 0.07
    k['roof-ridge'] = [mpk.line_cap((-H, mpk.RIDGE_Y, H), (H, mpk.RIDGE_Y, H), (0.0, 0.0, w), -w, 0.03, 'F1')]
    lip = [(H, H), (H, H + 0.02), (H + 0.04, H + 0.02), (H + 0.04, H - 0.08), (H, H - 0.08)]
    k['roof-eave'] = [mpk.ext_x(lip, 'S25', -H, H, (H + 0.02, H - 0.03), cap0=True, cap1=True)]
    sec = lambda x: [mpk.square_to_slope(mpk.verge_point(x, s, t), x) for s, t in ((0.0, 0.0), (0.0, 0.02), (0.03, 0.02), (0.03, -0.1), (0.0, -0.1))]
    va, vb = sec(-H), sec(H)
    segs = [(1, 2, mpk.VERGE_N), (2, 3, (0.0, 0.0, 1.0)), (3, 4, mpk.neg(mpk.VERGE_N)), (0, 1, (0.0, 0.0, -1.0))]
    k['roof-gable'] = [mpk.loft(va, vb, segs, 'F1', caps=[[0, 1, 2, 3, 4]], cap_rid='C12a')]
    hip, valley = mpk.hip_caps('F1')
    k['roof-hip'] = [hip]
    k['roof-valley'] = [valley]

    def chip(cw, ch, d):
        return mpk.box(-cw / 2, cw / 2, -ch / 2, ch / 2, H - 0.01, H + d, {'+z': 'S12', '+x': 'S12', '-x': 'S12', '+y': 'S12', '-y': 'S12'})

    k['damage-stage-2'] = [chip(0.06, 0.04, 0.025), chip(0.045, 0.05, 0.035)]
    k['damage-stage-3'] = [chip(0.11, 0.08, 0.05), chip(0.09, 0.1, 0.04)]
    return k


# Variant weights of the sample (the finer rim three times as often as the chipped one).
SAMPLE_WEIGHTS = {'edge-out-top': [3, 1]}


def build_sample(bpy, contract):
    mat = build_templates(bpy, contract, SAMPLE_KIT)
    layout = SAMPLE_KIT['sheetLayout']
    mpk.use_layout(layout_regions(layout), layout['size'], layout['pxPerMetre'])
    pieces = sample_pieces()
    places = slot_place(contract)
    for sid, variants in pieces.items():
        coll = bpy.data.collections[sid]
        for k, piece in enumerate(variants):
            ob = bpy.data.objects.new(node_name(sid, k), mpk.blender_mesh(bpy, node_name(sid, k), piece, mat))
            ob.location = places[sid]
            w = SAMPLE_WEIGHTS.get(sid)
            if w is not None:
                ob['tl_weight'] = w[k]
            coll.objects.link(ob)
    # Slots the sample fills with another slot's mesh: the first slot the contract says it may share with that has one.
    for s in contract['slots']:
        if s['id'] in pieces:
            continue
        share = next((x for x in s['shares'] if x['from'] in pieces), None)
        if share is None:
            continue
        empty = bpy.data.objects[f'SLOT {s["id"]}']
        empty['tl_source'] = share['from']
        empty['tl_rotation'] = share['rotation']


def main():
    import bpy
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    contract = load_contract()
    if not argv and not bpy.app.background:
        # Run Script inside Blender: export the open template next to its .blend.
        argv = ['export']
    mode = argv[0] if argv else 'templates'
    out = argv[argv.index('--out') + 1] if '--out' in argv else (os.path.dirname(bpy.data.filepath) if mode == 'export' and bpy.data.filepath else os.getcwd())
    if mode == 'templates':
        build_templates(bpy, contract, DEFAULT_KIT)
        path = os.path.join(out, TEMPLATES_BLEND)
        bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)
        print(f'[templates] {path}: {os.path.getsize(path)} bytes, {len(contract["slots"])} slots')
        return
    sheet = argv[argv.index('--sheet') + 1] if '--sheet' in argv else None
    if mode == 'sample':
        build_sample(bpy, contract)
        if sheet is not None:
            use_sheet(bpy, bpy.data.materials[f"{SAMPLE_KIT['voxelKitId']}-sheet"], sheet)
        if '--blend' in argv:
            path = os.path.join(out, 'voxel-kit-sample.blend')
            bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)
            print(f'[sample] {path}: {os.path.getsize(path)} bytes')
    elif mode != 'export':
        raise SystemExit(f'kit_templates: unknown mode {mode} (templates, sample, export)')
    elif sheet is not None:
        use_sheet(bpy, bpy.data.materials[f"{scene_kit(bpy)['voxelKitId']}-sheet"], sheet)
    glb, record, size, digest, tris = export_kit(bpy, contract, out)
    print(f'[export] {glb}: {size} bytes, sha256 {digest}')
    print(f'[export] {record}')
    for name, n in sorted(tris.items()):
        print(f'  {name:22} {n:4} tris')
    images = [n.image for n in bpy.data.materials[f"{scene_kit(bpy)['voxelKitId']}-sheet"].node_tree.nodes if n.type == 'TEX_IMAGE' and n.image is not None]
    textures = ', '.join(f'{i.name} {i.size[0]}x{i.size[1]}' for i in images) if has_sheet(bpy.data.materials[f"{scene_kit(bpy)['voxelKitId']}-sheet"]) else 'none (placeholder material)'
    print(f'[export] {len(tris)} meshes, {sum(tris.values())} triangles, textures: {textures}, LODs: none (L0 only), collision: from the voxels')


if __name__ == '__main__':
    main()
