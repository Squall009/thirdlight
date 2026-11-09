# Thirdlight → art-factory: textures for voxel construction (2026-11-08)

From the Thirdlight engine team, for the art-factory (Studio / Texture
Designer) team. Thirdlight never edits the art-factory repo; please accept,
change or decline each item. The engine side works without them (a material
without textures draws a stand-in, a kit without a sheet draws its layout's
debug set); they let an artist make a voxel material set and a kit's sheet in
the Texture Designer and have it pass the engine's checks unchanged.

The contract is the owner-approved texture layout v1
(`docs/architecture/voxel-trim-layout.md` in the Thirdlight repo) and role
spec v1 (`voxel-role-spec.md`); the artist's workflow is
`docs/manual/guides/voxel-kits.md`, the slot sheets
`docs/manual/guides/voxel-kit-slots/`. Voxel materials (material records,
texture arrays, a material's height depth) are the engine's next sub-phase:
the formats below are what that work will read, so the earlier the
Designer writes them the fewer conversions later.

## Update 2026-11-09: what the engine's material work changed

The engine now draws voxel materials with real texture sets (sub-phase 46d,
on its branch, not yet merged or released). Everything below still holds;
four points are new or more precise:

- **Height lives only in the normal map's alpha** (§1, §5 as written): the
  engine reads no height from the albedo's alpha, and a normal map without
  alpha draws no relief. White is the surface, black is the material's height
  depth below it.
- **The height depth is a field of the material record**: `voxel.heightDepth`,
  0–0.25 m (default 0.02). Please keep writing it in the export report; an
  artist copies it into the record (the engine's test sets: rock 0.10, stone
  and brick 0.04, sand and soil 0.03, grass 0.02, timber 0.015, plaster
  0.008 m).
- **Terrain materials are 4096² too.** Terrain repeats every 2 m and is
  projected from three axes; all voxel materials' maps join one texture array
  a map whose layers are one size, so a terrain tile at 4096² carries
  2048 px/m. A graph per terrain type (grass, rock, sand, soil, gravel …) at
  4096², seamless, bottom edge the 0 m line, the same three maps.
- **Sources the engine imports:** 8-bit RGBA PNG up to 65.3 MiB a file (a
  4096² PNG fits even uncompressed; a 16-bit 4096² PNG may not). The engine
  makes its own KTX2 from the PNG (images over 12 Mpix in UASTC), so a KTX2
  next to the PNG is optional.

**Not built yet** (the "checked when voxel materials land" list in §5): the
engine does not yet check a construction tile's size, maps, normal
convention, seamless edges or the crack map, nor the kit check's T9 row
(sheet against its layout). They remain planned; a set is drawn as given.

The artist's workflow for a material set is now in
`docs/manual/guides/voxel-kits.md` §1 (base tiles, the three maps, height
depth, wall / floor / ceiling sets, the material record, physical profiles,
variants, kit binding, what each quality level keeps).

## 1. A graph per material type that makes the 4 × 4 m construction tile

**Engine.** Walls, floors, ceilings and flat roofs of a voxel world are plain
voxel faces. Their texture is the material's **tiling construction tile**:
one repeat covers a **4 m wide, 4 m high wall**, anchored to the build grid
in metres (a band at 2 m sits at 2 m on every wall); floors and ceilings use
the same tile on the same grid, sloped roofs lay it up the slope. No trim
sheet is used for these faces.

**Request.** One graph per material **type** (cut stone, rubble stone,
brick, plaster, planks, logs, shingles, thatch …), each exposing its
material's own parameters (colour, wear, course height, seed), rendering:

| | |
|---|---|
| Size | **4096 × 4096 px = 4 × 4 m (1024 px/m)**; the engine picks the resident mip per device, so one size is enough |
| Tiling | seamless both ways; **the bottom edge is the 0 m line** of the grid |
| Grid features | courses, boards, log lines, joints at **multiples of 0.5 m** (0.25 m inside a cell) by default, so they meet the voxel edges and the kit pieces; an exposed parameter may move them (the engine recommends, never checks) |
| Maps | **albedo** (sRGB RGB), **normal + height** (normal RGB, OpenGL / green up; **height in A**, linear 0–1), **ORM** (R AO, G roughness, B metalness) |
| Height | **0–1 normalised per material**, and the material's **height depth in metres** written beside it (sand shallow, jagged rock deep): the engine blends heights in metres, so no material is crushed to a shared scale |
| No marks | no dirt, moss or soot painted in (the engine puts them on as decals) and no single eye-catching feature (it repeats every 4 m) |

**Why.** These are the numbers the owner approved; a tile made any other
way either blurs against the 1024 px/m pieces, misaligns with the 0.5 m
voxel edges, or tiles visibly on a 4 m wall.

## 2. A detail sheet per kit, following a declared `sheetLayout`

**Engine.** A kit's pieces (edges, corners, roof edges, damage fragments)
all use **one texture set** (a kit-check error otherwise). The layout of
that sheet is **per kit**: the kit record declares it,

```json
"sheetLayout": {"size": 2048, "pxPerMetre": 1024, "regions": [
  {"id": "S25", "kind": "strip", "metres": 0.25, "y": [32, 288]},
  {"id": "S12", "kind": "strip", "metres": 0.125, "y": [352, 480]},
  {"id": "F1", "kind": "field", "metres": 1, "y": [544, 1568]},
  {"id": "C25a", "kind": "cap", "metres": 0.25, "y": [1632, 1888], "x": [32, 288]},
  {"id": "C12a", "kind": "cap", "metres": 0.125, "y": [1632, 1760], "x": [352, 480]}]}
```

(`y` pixel rows `[top, end)` from the top, `x` only for a cap; kinds
`field`, `strip`, `profiled`, `cap`; regions never overlap; a sheet
16–16,384 px a side). Faces along an edge take a **world-anchored U**
(U = (x + 0.25) × pxPerMetre / size along the run), so a strip must tile
horizontally across the full sheet width; caps (ends of members) do not
tile. This is the sample kit's layout in the engine repository.

**Request.**

- **Read a `sheetLayout`** (or write one): a trim document (`trim/1`) whose
  layers are the declared regions — `strip` / `field` → a `tile_u` /
  `tile_uv` layer at that height, `profiled` → a layer with an edge profile,
  `cap` → a decal-row cell at that size — at the sheet's px/m, and the
  export's `layout.json` able to emit the same `sheetLayout` block so the
  artist pastes it into the kit unchanged.
- **Defaults for a voxel kit sheet:** 2048² at **1024 px/m** (the base
  tile's density), **32 px gutters** (clean to mip 5), unused space neutral
  (height 0.5, flat normal), the same three maps as §1 (albedo, normal +
  height in A, ORM). Cap ids end in `a` (the kit check reads the first cap
  cell of a size).
- **One sheet a kit.** Two kits may share a graph, never need to share a
  sheet; whether they share UVs is the game's choice.

**Why.** The kit check's trim rows (T1–T7) test the pieces' UVs against the
kit's own regions; a sheet made from the same declaration lines up by
construction.

## 3. The 4 × 4 m crack map

**Engine.** A damaged construction cell (integrity 11–14 by default) keeps
its block and shows a crack overlay. The engine has one generated crack map
(512², 128 px/m over a 4 × 4 m tile); a kit may replace it with its own image
(`damage.crackTexture`). Only the **red channel** is read: 0 no crack,
brighter cracks appear first as integrity drops, dimmer ones join later. The
map is laid on the build grid like the construction tile, so neighbouring
cracked cells show one continuous pattern.

**Request.** A crack graph (shared, parameters per material type: crack
width, branching, how many levels) rendering a **seamless 4 × 4 m** single
channel map, its bottom edge the 0 m line, **1024² (256 px/m) by default**
(512² minimum), cracks preferring the material's joints where the type has
them (mortar lines, board edges), exported as a single-channel PNG
(R8, linear) or KTX2 `R8`.

## 4. A "Kit Designer" helper (an idea, for discussion)

The engine's authoring package is a Blender template (one collection a slot
with its envelope and axes, a one-click export that writes the GLB and the
kit record; `tools/voxel-bench/kits/kit_templates.py`). A Studio-side helper
could take an artist from a material type to a whole kit:

- pick the material type's graph → render the construction tile (§1), the
  kit's sheet (§2) and the crack map (§3) with one `sheetLayout`;
- generate the piece meshes per slot from profiles (a bevel, a round log, a
  fillet) swept along the slot's run, with UVs made to the layout, the
  envelope and triangle guidance of the engine's slot contract
  (`tools/voxel-bench/kits/slot-contract.json`, generated from the engine's
  catalogue: anchor, open side, run, the boxes the kit check tests, which
  slots share a mesh by which rotation, triangles a mesh);
- write the GLB and the kit record (`kitFormat` 1).

The engine reads only the results (§5), so the helper is entirely the
art-factory's design.

## 5. Formats, sizes, compression, naming, and how the engine checks them

| Item | Format | Size | Name (suggested) |
|---|---|---|---|
| Construction tile | albedo sRGB RGB8, normal + height RGBA8 (A linear), ORM RGB8 | 4096², power of two | `<material>_albedo`, `<material>_normal_height`, `<material>_orm` |
| Kit sheet | the same three maps | the declared `size` | `<kit>_sheet_albedo`, … |
| Crack map | R8 linear | 1024² (512² min) | `<kit>_cracks` |
| Height depth | a number in metres in the export report (and later the material record) | — | — |

- **Containers:** PNG (lossless, the source) plus KTX2 for shipping, UASTC
  for the normal + height map (BC7-class quality), ETC1S acceptable for
  albedo and ORM; mips filtered with wrap (all three tile), normals
  renormalised per mip, alpha straight. Each KTX2 records its PNG's digest
  (`thirdlight.sourceSha256`, request 1 of `art-factory-2026-10-22.md`).
- **Names:** lower case, digits, `-` and `_` (the engine's id syntax).
- **Report with every set:** sizes, file sizes, the maps, the height depth.

**Checked by the engine today:** the kit check reads a kit's GLB (one
texture set across every piece, by material name and image CRC-32; the
pieces' UVs against the declared `sheetLayout`, T1–T7; triangles and
embedded texture sizes reported). **Checked when voxel materials land (the
engine's next sub-phase):** the construction tile's size (4096², power of
two), its three maps and the normal convention, the height depth present,
seamless edges (a wrap-difference test), the crack map single channel and
seamless; the kit check's T9 row will then test the kit sheet's size and
maps against its `sheetLayout`. A set that fails is reported in Problems,
never refused.
