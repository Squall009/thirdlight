# Make a voxel kit and a material set

A voxel world's walls, floors and roofs are plain voxel faces with their
material's tiling texture; a **kit** adds the detail pieces where faces meet
(edges, corners, roof edges) and round damage holes. This guide is the
workflow from an empty Blender template to a kit the engine draws, without
reading engine code. What the engine stores and draws is in
[voxel worlds](../features/voxel-worlds.md#voxel-kits); every slot has its
own sheet in [the slot sheets](voxel-kit-slots/index.md).

What you make for one material type (wood, stone, …):

| Part | What | Size |
|---|---|---|
| **Base tiles**, one set a material | the tiling texture of the voxel faces: one repeat is a **4 × 4 m wall** | 4096 × 4096 px (1024 px/m) |
| **The kit's texture set**, one a kit | the sheet (or bakes) every piece of the kit uses | the kit's own layout, e.g. 2048² at 1024 px/m |
| **The kit's meshes** | one GLB, one node a piece, filling any of the 17 slots | ≤ 48 / 64 / 32 triangles a piece (edges / corners and roofs / damage) |
| **The kit record** | `setVoxelKit {kit}`: slots → meshes, jitter, sheet layout, damage stages | a few kB |
| A crack map (optional) | the kit's own crack pattern over one 4 × 4 m tile | 512² or larger, red channel |

Every piece is game-ready by these rules: one mesh a piece and **no LODs**
(pieces draw in the near ring only; from 1 m cells out the edges are plain
voxels), **collision from the voxels** (never from a piece), no hidden faces,
fine detail in baked normals, one texture set for the whole kit. Report for
every kit: triangles a mesh and in all, texture sizes, file size (the kit
check prints all three).

## 1. Textures on plain voxels first

A material without a kit draws plain voxel faces, and every slot of a kit is
optional (an empty slot draws the plain square edge). So start with the base
tiles and no pieces at all, and add pieces one slot at a time.

**Base tiles** (the owner-approved texture layout, v1):

- **4096 × 4096 px for a 4 × 4 m wall, 1024 px/m.** One repeat covers exactly
  a 4 m wide, 4 m high wall, anchored to the build grid in metres: a band at
  2 m sits at 2 m on every wall. Floors and ceilings use the same tile on the
  same grid; a sloped roof lays its material's tile up the slope (4 m of
  slope a repeat). The device loads the mip level its quality level and
  texture budget allow; you make one set.
- **Seamless** left–right and top–bottom; the tile's **bottom edge is the 0 m
  line** of the grid.
- **Grid features at 0.5 m** (a recommendation, not a rule): courses, boards,
  log lines and joints at multiples of 0.5 m (or 0.25 m inside a cell) meet
  the voxel edges and the edge pieces.
- **Maps:** albedo (sRGB), normal + height (height in alpha; OpenGL, green
  up), ORM (AO, roughness, metalness). Height is **0–1 in the map**; each
  material states its own height depth in metres (sand shallow, jagged rock
  deep) in its material record.
- **Dirt, moss and soot are decals** and whole-voxel material swaps, never
  painted into the tile ([decals](decals.md)).
- **Avoid one eye-catching mark** in the tile: it shows once every 4 m.

**Where you see them.** A voxel material's `voxel.surfaces` names the three
maps ([voxel materials](../features/voxel-worlds.md#voxel-materials)); the
world draws them on the build grid, blends neighbouring materials by height
in metres and fills the low parts with water as cells get wet. Check a tile
in Blender on the template's `wall-tile-4m` plane (4 × 4 m with its 0.5 m
grid, UV 0–1 over the plane) or in the Texture Designer's preview, and see
the grid it follows on the voxel world page with `?bands=1` (a line every
0.5 m, thick lines at 0 and 2 m, a tick every metre).

## 2. The Blender templates

The templates are written by a script in the engine repository (Blender 5.2,
run headless; it writes nothing outside `--out`):

```sh
blender --background --python tools/voxel-bench/kits/kit_templates.py -- templates --out <folder>
```

It writes `voxel-kit-templates.blend` (a committed copy is
`tools/voxel-bench/kits/voxel-kit-templates.blend`, about 135 kB). In it:

- **One collection a slot** (17), in rows: outer edges, inner edges, outer
  corners, inner corners, roof edges, damage. Each holds its slot empty
  `SLOT <slot>` (the **anchor cell's centre**: the piece's origin), the 0.5 m
  **cell** as wire, the **touch box** (the piece must reach it) and the
  **fit box** (it should stay inside), the **anchor** point on the edge or
  corner, and arrows for the **open side** and the **run**. These numbers
  come from the engine's catalogue and kit check (the slot contract,
  `tools/voxel-bench/kits/slot-contract.json`), so the template and the
  check agree.
- **`reference (not exported)`:** the 4 × 4 m wall tile with its 0.5 m grid,
  and a 2 m **U ruler** mapped the way the engine maps a run.
- **The kit's material** `<kit>-sheet`, showing the **UV guide** of the
  kit's sheet layout (each region its own hue with a 1/8 m checker, gutters
  grey).
- **Text blocks:** `README` (this guide in short) and `kit_templates.py`
  (the export).
- **The scene's `tl_kit` property** (JSON): the kit record's own fields
  (`voxelKitId`, `name`, `version`, `materialType`, `materials`, `jitter`,
  `sheetLayout` or `trimLayout`, `damage`, `wallTopFill`, `gameData`).

**Axes.** Blender is Z up, the engine +y up; the export turns it. In Blender
a piece's **open side faces −Y** (the Front view), its **run is +X** (a
vertical edge: +Z), up is +Z, and the voxel body is toward +Y. The cell is
−0.25 … +0.25 m round the slot empty. Each [slot sheet](voxel-kit-slots/index.md)
gives the anchor, open side, run and both boxes in Blender's axes too.

## 3. Model one slot at a time

Start with **`edge-out-top`** (a wall's top edge, a floor's edge, a stair's
nosing): it is the edge seen most.

1. Model the piece inside the slot's collection at the slot (select the
   collection first so new objects land in it). Apply rotation and scale.
2. **Stay in the envelope:** touch the touch box (else the kit check's
   `pivot` error: the piece draws beside its cell) and stay inside the fit
   box (else a `fit` warning: it overlaps its neighbours). A roof edge's
   boxes reach a cell higher (the roof planes run up to a cell above the
   voxel's top).
3. **Stand proud of the faces.** Each piece moves 0.8–1.6 cm into the solid
   (the kit's `jitter` scales it, 0–4, default 1) and twists up to 2°, so a
   row reads hand-built. A piece standing less proud than that sinks under
   its faces in places (the sample stands 3 cm proud).
4. **No hidden geometry:** leave out faces against the voxel body or under a
   roof plane. Voxel edges are square (not chamfered): the piece sits over
   them.
5. **Variants:** several meshes in one slot are picked per piece by the
   project's voxel detail seed (`voxel_piece_seed`) and the piece's place, so
   a scene always draws the same. A mesh's custom property `tl_weight`
   (default 1) weights it; `tl_mirror` = 1 draws it mirrored across the run
   (one carving for both hands).
6. **Borrow instead of modelling.** Most slots are another slot's mesh
   turned: set the slot empty's `tl_source` to the other slot and
   `tl_rotation` to the rotation its slot sheet lists. Three meshes fill all
   ten edge and corner slots: `edge-out-top` (→ `edge-out-bottom` rotation 5,
   `edge-out-vertical` rotation 9), `edge-in-bottom` (→ `edge-in-top` 5,
   `edge-in-vertical` 9) and `corner-out-top` (→ `corner-out-bottom` 5).
   Inner corners can stay empty when the coves close them.
7. **Roof edges** are authored for a 45° roof (`roof-ridge`, `roof-eave`,
   `roof-gable` = the verge, `roof-hip`, `roof-valley`); the engine pitches
   the same mesh onto a 1:2 roof (eaves and verges turned, ridges, hips and
   valleys squashed to half height). Author one verge rising toward +x: the
   gable's other side is drawn mirrored.
8. **Damage pieces** (`damage-stage-2`, `damage-stage-3`): one fragment each,
   centred on the face toward the hole (+z in the engine, −Y in Blender); the
   engine spreads several over every face round the hole and spins them.

**Openings.** Next to an `opening` cell (a door or window gap) the edge
slots are still drawn, cut flush 4 mm inside the faces toward the opening:
nothing stands in the doorway. A jamb is a vertical outer edge, a lintel a
bottom edge, a sill a top edge; there are no jamb slots of their own.

## 4. UVs: the kit's one texture set

**One kit uses exactly one texture set** (one sheet or one set of bakes);
the export gives every piece the kit's one material, and two are a kit
check error. Timber beams on stone are two kits.

The **layout is per kit.** Declare it in `tl_kit.sheetLayout` (the record's
`sheetLayout`): `{size, pxPerMetre, regions: [{id, kind, metres, y, x?}]}`,
`kind` one of `field`, `strip`, `profiled`, `cap`, `y` its pixel rows
`[top, end)`, `x` only for a cap. The templates' default, which the sample
uses:

| Region | Kind | Real size | Rows (px) | For |
|---|---|---|---|---|
| `S25` | strip | 0.25 m | 32–288 | profiles along an edge |
| `S12` | strip | 0.125 m | 352–480 | coves, small fragments |
| `F1` | field | 1 m | 544–1568 | faces up a roof slope and across a hip |
| `C25a` | cap | 0.25 m | 1632–1888, x 32–288 | ends up to 0.25 m across |
| `C12a` | cap | 0.125 m | 1632–1760, x 352–480 | ends up to 0.125 m |

on a 2048² sheet at 1024 px/m (the base tile's density, so a piece and the
wall behind it are equally sharp), 32 px gutters (clean to mip 5), unused
space neutral (height 0.5, flat normal).

- **Faces along the run** take a **world-anchored U**: U = (x + 0.25) ×
  pxPerMetre / size, from 0 on the cell's −X face (0.5 a metre on the
  default sheet; the U ruler shows it). The engine adds each piece's offset
  along the world, so neighbouring pieces continue the pattern without a
  seam, whatever their turn. V at the same density (square texels).
- **End faces** go into a cap cell of their size; name caps with ids ending
  in `a`.
- **Every triangle inside one region**, none in a gutter.
- A kit **without** a layout keeps its UVs as authored (right for own bakes
  and sculpted pieces: each piece repeats its own pattern).

The kit check's trim rows (T1–T7, T9, T10) test all of this against the
kit's own layout. The pieces draw with the kit's sheet (§5); to check the
UVs, open the voxel world page with `?trimDebug=1`: the pieces then draw
the layout's **debug set** (each region its own colour and id, a 3 cm
checker, a tick every 0.125 m along U), so a face in the wrong region or a
stretched one shows at once.

## 5. Export

In Blender: **Text editor → `kit_templates.py` → Run Script.** It writes
`<id>.voxelkit.json` and `voxel-kit-<id>.glb` next to the `.blend`. Headless:

```sh
blender --background my-kit.blend --python tools/voxel-bench/kits/kit_templates.py -- export --out <folder>
```

The export: each slot's meshes (modifiers applied) moved from the slot's
place to the GLB's origin, one node a mesh named `<slot>_v<k>`, glTF binary
with +Y up, normals and UV0, no tangents, cameras, lights or animation, and
the kit's one material **with its images**: put the sheet on the
`<kit>-sheet` material (Base Color the albedo image, Normal through a Normal
Map node, the ORM through Separate Color: G to Roughness, B to Metallic, R to
the glTF Material Output group's Occlusion), or headless pass
`--sheet <folder>` holding `albedo.png`, `normal.png` and `orm.png`. A
material still showing the UV guide is written as a placeholder (no
images; the pieces then draw a stand-in colour). The record names every mesh by the GLB's SHA-256,
with each borrowing slot's rotation, each mesh's weight and mirror, and the
`tl_kit` fields. It prints triangles a mesh and in all.

## 6. Into a project: `setVoxelKit`, then the kit check

1. **Import the GLB** as a model: copy it into the project's assets (for
   example `assets/kits/`) and **import folder…** in the project window
   (MCP: `tl_content_upload {dataBase64, writeTo}` for a file from another
   machine, then `tl_command importAssets {folder: "assets/kits"}`). A GLB
   exported again is imported again by **check files**.
2. **Set the kit:** the record's `assetId` is `voxel-kit-<id>`; replace it with
   the imported asset's id (`queryAssets`; its version's source digest is the
   record's `digest`; a GLB with its sheet inside is stored with the images
   extracted into KTX2 textures, so that version's digest is not the file's
   own: take it from `queryAssets`), then `setVoxelKit {kit}` (MCP:
   `tl_command setVoxelKit {kit}`; one undo). Bind it on each material
   that wears it: `setMaterial` with `voxel: {id, use: "construction", kit:
   "<voxelKitId>"}` ([Voxel materials](../features/voxel-worlds.md#voxel-materials)).
   The kit's own `materials` list still binds ids no material record names.
3. **Read the kit check** in **Problems** (MCP: `tl_diagnostics`, lines
   `voxel_kit_check`): errors draw wrong or not at all (an unknown slot, a
   missing model or node, a piece off its cell, two texture sets, trim T1,
   T2, T4); warnings overlap or name an old file version; the `slots`,
   `budget` and `damage` rows report how many slots are filled, triangles,
   texture sizes and the damage stages. An empty slot is never a warning. A
   kit passes when it has no error.

## 7. Look at it: the kit test scene

`writeKitTestScene {world, origin: [x, y, z], material}` (the editor, MCP and
scripts alike; one undo with `undoVoxels`) builds every case from voxels in
one material your kit binds, each labelled: notched blocks for every edge
and corner, a gable, a hip and an L roof, and a wall with a cell at each
damage stage. Open it on the voxel world page with
`?kitScene=x,y,z,material` (the labels show), in the Scene view, or in Play.
Filled slots draw their meshes; empty ones plain voxel edges. Edit and
export again: the Scene view follows the kit as you set it.

Look at it near (pieces draw only in the near ring, 64 m by default) and on
both renderers; check that rows read hand-built but never float or sink,
that coves meet at inner corners, and that a 1:2 roof's pitched edges sit
on its planes.

## 8. The rest of the kit record

- **Damage stages and the crack map.** A construction cell's shape is its
  integrity (15 intact, air broken). By default 11–14 crack (the block stays,
  its faces show the crack map, stronger as integrity drops), 6–10 are a
  hole with 6 `damage-stage-2` pieces on each face round it, 1–5 a hole with 3
  `damage-stage-3` pieces. A kit changes them in `damage` (`stage1`–`stage3`
  as `{min, max, pieces?}` or `null`), and may replace the engine's crack
  pattern with `damage.crackTexture` (an image asset; its **red channel**: 0
  no crack, the brightest cracks show first). The crack map covers **one
  4 × 4 m construction tile** laid on the build grid like the base texture,
  so neighbouring cracked cells show one pattern: make it seamless at 4 m,
  its bottom edge the 0 m line (the engine's is 512², 128 px/m).
- **Wall-top fill** (`wallTopFill`, a roof kit's, default off): the walls
  under its roofs are cut to the roof's underside, so no voxel steps show in
  the attic or under the eaves. An artistic choice: off keeps the steps.
- **Mirror** per slot mesh (`mirror`, from `tl_mirror`) and **rotation**
  (`rotation`, from `tl_rotation`): one of the 24 cube rotations, never a
  mirror.
- **Jitter** (`jitter`, 0–4, default 1) scales every piece's stagger; 0
  puts pieces exactly on the lattice.
- **`gameData`** (on the kit and on each slot): any JSON your game reads
  (break, sound, physics defaults); the engine never reads it.

## 9. The sample kit

The engine repository has a **recommended sample kit** built by the same
script from the templates through the same export
(`kit_templates.py -- sample`): `tools/voxel-bench/kits/sample.voxelkit.json`
and `voxel-kit-sample.glb`. It is a dressed trim: bevelled rims proud of the
faces (two variants, weights 3 : 1), a chamfer fillet in the coves, a
corner block, ridge, hip and valley caps, a drip lip at the eave, a verge
board, and stone chips as damage pieces, on the default 2048² layout above.
It is **never shipped or bound by default**: a material without a kit draws
plain voxels.

| Sample kit | |
|---|---|
| Meshes | 13 in 15 of 17 slots (inner corners empty: the fillets close them) |
| Triangles | 170 in all (264 counting each slot's meshes); a mesh 4–20 |
| GLB | 20,012 bytes; record 5,572 bytes |
| Textures | none embedded in the committed GLB (pieces draw a stand-in colour); `sample --sheet <folder>` exports it with a 2048² sheet (albedo, normal, ORM PNG inside, 2.2 MB GLB) |
| LODs | none (pieces draw at level 0 only) |
| Collision | from the voxels |
| Kit check | 0 errors, 0 warnings, trim T1–T7 ok on its own layout |

Open `voxel-kit-sample.blend` (the script's `sample --blend`) to see a
filled template.
