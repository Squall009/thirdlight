# Texture layout for voxel construction — v1 (edge model)

Status: **v1 — APPROVED by the owner on 2026-11-06.** It is written to the owner's acc46c-r answers (B0–B8,
2026-11-05 and 2026-11-06) and acc46c-r2 answers (O1, 2026-11-06), and describes the code as built through 46c.16k
(branch `phase-45` at 3a078a94).

**Owner note (2026-11-09, amendment 1, add-only):** a texture set's **height lives in the albedo's alpha**, as on
the engine's layered surfaces; the normal map keeps no height (its alpha unused). The v1 row "normal + height
(height in alpha …)" in §2 was a drafting slip carried into the approval; §9 holds the amendment, every other v1
number stands.

**Owner note (2026-11-06, acc46c-r2 S2):** "The role spec and texture layout are fine, no more changes for now." The
page froze as v1 with the role spec, once the 4 m crack map and a kit's own sheet layout (O1) were built (46c.16k);
the freeze commit is in plan 46c's 46c.16 progress row. From here a change is a new version with an owner note; kit
pipelines, Blender templates, spec sheets and art-factory graphs may treat these numbers as fixed. Sources:
[plan 46c](../plan-phase-46c.md) §6c and the decision log (OWNER 2026-11-04: tiling textures authored to a 4 × 4 m
full wall, grid-anchored; OWNER 2026-11-05/06: B1–B8); [plan 45](../plan-phase-45.md) §7 (R112: no trim sheet for
terrain or construction voxels); the [role spec](voxel-role-spec.md) (the cases, slots and kits). Code:
`voxel` `derived-shader.ts` (tile repeats), `three-adapter` `voxel-surface-projection.ts` (base UVs) and
`voxel-trim-u.ts` (world-anchored U on pieces), `project-model` `voxel-trim-layout.ts` (the example layout
`detail-trim`) and `voxel-kit-check.ts` (the rows of §5).

## 1. Two kinds of surface

| | Base surfaces | Detail pieces |
|---|---|---|
| What | wall, floor, ceiling and flat-roof voxel faces; the roof mesher's sloped planes | a kit's slot meshes: edges, corners, roof edges (ridge, eave, verge, hip, valley), damage pieces |
| Texture | the material's **tiling** texture set: one repeat = a **4 × 4 m full wall** (§2) | the **kit's one texture set**: its own trim sheet or its own bakes, laid out as the kit chooses (§3) |
| UVs | none in the mesh: the shader maps them from the world | in the mesh (UV0); along the edge per instance for a kit with a trim layout (named or its own) |
| Never | a trim sheet (R112) | a unique texture per piece instance; two texture sets in one kit |

**Terrain** is neither: triplanar at a **2 m** repeat (`TERRAIN_TILE_METRES`), its own materials, never this page's
layouts. The role of the cell picks the mapping, not the material: stone used as ground maps triplanar, stone used as
a wall maps to the grid.

## 2. Base surfaces: the 4 × 4 m grid-anchored tile

**The rule (owner 2026-11-04):** a construction material's tiling texture is authored to one full-size wall, **4 m
wide and 4 m high**, and one texture repeat covers exactly that in both directions (`CONSTRUCTION_TILE_METRES` = 4).
It is anchored to the build grid in metres, so a band painted at 2 m sits at 2 m on every wall, across every chunk,
and floors use the same grid. A repeat must divide 512 m (the grid's phase), else it is refused.

As built:
- **Walls:** U runs along the face to the right seen from outside, V is the world height (patterns are never
  mirrored on a face). **Floors:** U = x, V = −z; **ceilings:** U = x, V = z.
- **Roof planes along the slope** (owner B6): U level along the ridge, V the true distance up the slope at both
  pitches (a 45° cell is √2 × 0.5 m of slope, a 1:2 cell √5 × 0.25 m), each slope on its own phase so V runs on across a whole
  roof; a 4 m tile covers 4 m of slope.
- **Debug bands** (`?bands=1` on the slice page): a line every 0.5 m, thick lines at 0 and 2 m, a tick every 1 m.

**Authoring a base texture:**

| | v1 |
|---|---|
| Size | **authored at 4096 × 4096 px = 4 × 4 m, 1024 px/m** (owner B1) |
| Resident size | the **mip level resident on a device is chosen by the quality level and the texture memory budget** (owner B1); one asset set for every device. Residency and compression are 46d's |
| Tiling | seamless left–right and top–bottom (a wall taller or wider than 4 m repeats it) |
| Grid features | **recommendation, not a rule** (owner B2): courses, boards, log lines and joints at multiples of **0.5 m** (or 0.25 m inside a cell) meet the voxel edges and the edge pieces; the tile's bottom edge is the 0 m line of the grid. The kit check does not test it |
| Floors and ceilings | the same 4 × 4 m tile on the same grid |
| Roof planes | the roof material's tile laid up the slope (above) |
| Maps | albedo (sRGB), normal + height (height in alpha; OpenGL green up), ORM (AO, roughness, metalness). **Amended 2026-11-09 (§9): the height is the albedo's alpha; the normal map's alpha is unused** |
| Height | **0–1 in the map; each material declares its own height depth in metres** (owner B8: sand shallow, jagged rock deep), so no texture is crushed to a shared scale and height blending compares in metres. The field belongs to 46d's material model (not built) |
| Dirt, moss, soot | **decals** (projected or clipped) and whole-voxel material swaps, never painted into the tile or an overlay layer (owner B3 correction; role spec §11) |
| Anti-tiling | one repeat per 4 m wall already avoids per-cell repetition; avoid a single eye-catching mark in the tile. Macro variation and stochastic sampling are 46d proposals |

## 3. Detail pieces: one texture set a kit, laid out by the kit

**The rule (owner B5): one kit uses exactly one texture set** (one trim sheet or one material) for all its pieces,
for batching. The kit check makes two an error (§5). A game that wants mixed detail (timber beams on stone; granite
and marble) makes two kits; there is no per-slot material override.

**The layout is per kit, a recommendation, not a standard** (owner B3/B4; replaces the 2026-10-27 decision "one
standardized trim UV layout for every kit"). A kit chooses its own sheet size and regions, or its own bakes, for the
pieces it has; whether two kits share UVs is the game's business. Textures therefore no longer swap freely between
kits (the owner accepted that trade).

**Recommendation for a kit's sheet (sizes for 0.5 m pieces).** A piece is never larger than its 0.5 m cell plus half
a cell round it (roof edges a cell higher), so sheets are small:

- **Density:** 1024 px/m, the base tile's, so a piece and the wall behind it are equally sharp; resident size by
  quality level as §2.
- **Strips along an edge:** a piece's faces along its edge map into strips at real size (a 3–15 cm profile is a
  31–154 px strip); U along the edge. A round member wraps a strip as tall as its circumference.
- **Caps** for ends and corners at real size (a 0.25 m end = 256 px).
- **Gutters** of 32 px round every region (clean to mip 5); unused space neutral (height 0.5, flat normal).
- **Own bakes** are the other way: a sculpted piece (a rough stone quoin, a broken rim, a damage fragment) carries
  its own normal and AO bakes on its own UVs, as one texture set for the whole kit (one atlas). The bake is local
  (no occlusion from neighbours).

**World-anchored U (as built, kits with a trim layout):** a kit that names a layout (`trimLayout`) or declares its own
(`sheetLayout`, below) gets its strips' U continued from piece to piece along the world: the mesh is authored with U
from 0 on the cell's −x face at the layout's px a metre over its size a metre (0.25 for `detail-trim`: the sheet's
4 m width, in step with the wall's tile), and the draw adds each instance's offset from its world
cell along the world's positive axis (x, z, or y for vertical edges), so neighbouring pieces meet without a seam
whatever their yaw, rotation or mirror. End faces and caps keep their authored UVs. A kit without a layout keeps
its authored UVs as they are.

**The example layout `detail-trim` v0** (the only layout the engine knows by id; the placeholder kits use it): a
4096² sheet at 1024 px/m with a 1 m field `F1`, plain and profiled strips of 0.5 / 0.25 / 0.125 m (`S50`, `S25`,
`S12`; `S50p`, `S25p`, `S12p`) and caps of 0.5 / 0.25 / 0.125 m in four cells each (`C50a–d`, `C25a–d`, `C12a–d`),
32 px gutters. It was sized for the earlier draft's larger pieces: the edge-model placeholders use 4 (log) and 6
(stone) of its regions, none of the profiled strips. It stays an example.

**A kit's own layout** (owner O1, 2026-11-06: yes; built in 46c.16k). A kit with its own sheet (the per-kit layout
the owner chose, B3/B4) declares it in its record instead of naming one: `sheetLayout: {size, pxPerMetre, regions:
[{id, kind: field | strip | profiled | cap, metres, y: [top, end), x?: [left, end) (caps only)}]}` (kit format 1,
add-only; a kit names `trimLayout` or declares `sheetLayout`, not both). Its strips then get world-anchored U at its
own density and the trim rows (T1–T10) check it against its own regions, labelled "(the kit's layout)", not draft.
Voxel faces always use the 4 × 4 m tiling textures, whatever a kit declares. A kit with neither keeps its authored
UVs (a pattern repeats per piece), which suits own bakes and sculpted pieces.

**What draws today:** kit pieces draw with a stand-in material a kit and a labelled debug texture (a kit naming
`detail-trim`: the layout's debug set, each region its own colour and id). A kit's own textures are drawn once 46d's
material model exists.

## 4. Materials on pieces

- A piece draws with its **kit's** one texture set; the kit is the dressing cell's material's (role spec §3), so a
  wall standing on a foundation dresses its foot in the wall's kit.
- Dirt and moss on pieces are **projected decals** (clipped decals cut voxel faces only; role spec §11).

## 5. Kit check rows (what `voxel-kit-check.ts` does)

Every kit is checked when the project opens and after a kit or a model it names changes (Problems, `tl_diagnostics`
as `voxel_kit_check`):

| Row | State | What |
|---|---|---|
| `catalogue` | err / ok | a slot the case catalogue does not have (never drawn) |
| `slots` | info | how many slots are filled; an empty slot is never a warning (every slot optional) |
| `damage` | info | the kit's damage stages (or the engine's) and crack texture |
| `texture-set` | err / ok | **one texture set a kit**: every drawn primitive of every piece names the same material, with the same images (CRC-32) |
| `assets` | err / ok | a mesh whose model is missing, unreadable or has no such node (its slot draws nothing) |
| `digests` | warn | a mesh names a model version the project does not have (the current one ships) |
| `pinned` | warn | a mesh names an older version of its model |
| `pivot` | err / ok | a piece, turned by its slot rotation, does not touch its cell (±0.25 m) |
| `fit` | warn / ok | a piece reaches past half a cell round its cell (±0.5 m; roof edges a cell higher) |
| `budget` | info | triangles a mesh and in all, texture sizes; reported, never capped |

**Trim rows**, only for a kit with a trim layout: one it names, labelled "(draft layout)" (the example
`detail-trim`), or its own `sheetLayout`, labelled "(the kit's layout)" and checked against its own regions: **T1**
every triangle inside one region (err), **T2** no UV in gutters or reserved space (err), **T3** square texels, V at
the layout's density (warn), **T4** U at the layout's rate from 0 along the run (its px a metre over its size: 0.25 a
metre for `detail-trim`), read along the mesh axis its slot rotation turns onto the slot's run (the same axis the
renderer uses; err), **T5** profiled strips on faces of their height (warn), **T6** end faces in a cap of the right
size (warn), **T7** the meshes of one slot on the same regions (warn), **T9** the texture set's maps not checked yet
(info), **T10** regions used (info). Grid features at 0.5 m (§2) are not checked (a recommendation).

## 6. Worked examples: the two placeholder kits

Engine test data, not game art (Blender 5.2.2 headless, `tools/voxel-bench/kits/make_placeholder_kits.py`); they name
`detail-trim` and draw with its debug set; no textures embedded; no normal bakes (no fine detail to bake); no LODs
(pieces draw at L0 only); collision from the voxels.

| Kit | Meshes / slots | Triangles | GLB | Faces → regions |
|---|---|---|---|---|
| log | 14 meshes in 15 of 17 slots (inner corners empty) | 304 (404 counting each slot's meshes) | 26,748 B (record 4,569 B) | strips `S12` / `S25` / `S50` along the edge, log ends in caps by size, other faces planar in `F1` |
| stone | 13 meshes in 15 of 17 slots | 170 (264) | 19,956 B (record 4,834 B) | the same rule; 6 regions used |

Kit check on both: 0 errors, 0 warnings, T1–T7 ok, one texture set.

## 7. What the owner approved (2026-11-06)

- Base surfaces: the material's tiling texture, one repeat = a 4 × 4 m full wall, anchored to the build grid in
  metres (walls, floors, ceilings; roof planes along the slope at 45° and 1:2); terrain triplanar at 2 m (§1, §2).
- Base textures authored at 4096² (1024 px/m), the resident mip chosen by quality level and texture budget (§2).
- Grid features at 0.5 m multiples as a recommendation, not a rule (§2).
- Height maps 0–1 with a per-material height depth in metres, owned by 46d's material model (§2).
- Dirt and moss through decals and whole-voxel material swaps, no overlay layer (§2, §4).
- Detail pieces: one texture set a kit (a rule, checked); the layout per kit as a recommendation (sizes for 0.5 m
  pieces), own bakes allowed; `detail-trim` v0 kept only as an example (§3).
- The kit check rows as listed (§5).
- The defaults below (§8); O1 answered (yes, built: §3).

## 8. Decided defaults

Numbers this page carries that no owner answer set. 1–9 were put to the owner on acc46c-r2 and are
**owner-confirmed** (2026-11-06); the `sheetLayout` default after them came with 46c.16k and **stands as approved**
(owner review model: a default the owner has not answered stands).

1. **Piece density 1024 px/m**, the base tile's (§3), so a piece and the wall behind it are equally sharp.
2. **Gutters of 32 px** round every region (clean to mip 5), unused space neutral (height 0.5, flat normal) (§3).
3. **Strips and caps at real size** (a 3–15 cm profile a 31–154 px strip; a 0.25 m end a 256 px cap) (§3).
4. **World-anchored U at 0.25 a metre from 0 on the cell's −x face**, growing along the world's positive axis (x, z,
   y for vertical edges), so a debug sheet's text reads mirrored seen from the negative side (§3).
5. **End faces and caps keep their authored UVs**; only faces along the run take the world offset (§3).
6. **Pivot ±0.25 m** (a piece must touch its cell, an error) and **fit ±0.5 m** (a warning past half a cell round
   it; roof edges a cell higher) (§5).
7. **`detail-trim` v0 stays the one example layout** (4096², field 1 m, strips 0.5 / 0.25 / 0.125 m, caps in four
   cells each), not a standard (§3).
8. **The trim rows run only for a kit with a layout**, labelled "(draft layout)" for a named one and "(the kit's
   layout)" for its own; grid features are not checked (§5).
9. **Roof planes' V is the true slope distance** on each slope's own phase, the grid anchored to the eave (§2;
   owner B6 set the rule, the phase per slope is the default).

**O1 (owner 2026-11-06: yes; built in 46c.16k).** A kit declares its own layout in `sheetLayout` (§3). Stands as
approved (owner review model): region kinds as `detail-trim`'s (field, strip, profiled strip, cap); a sheet
16–16,384 px a side; regions must not overlap; a kit has a named layout or its own, not both; its trim rows are not
marked draft (the kit owns its numbers).

## 9. Amendments

**Amendment 1 (owner 2026-11-09, add-only; built in 46d.10).** The maps of a base texture set and of a kit's sheet:

| Map | Channels |
|---|---|
| albedo | RGB colour (sRGB), **A the height 0–1** (linear; 1 the surface, 0 the material's height depth below it) |
| normal | RGB tangent-space normal (OpenGL, green up); A unused (write it opaque) |
| ORM | R ambient occlusion, G roughness, B metalness |

Why: the engine's layered surfaces and the owner's convention read the height from the albedo's alpha; one
convention for every texture set. An albedo without a height (opaque, or one value) gets a height from its
brightness when its array is assembled, the layered surfaces' rule. A kit's glTF material stays `OPAQUE` (no
`alphaMode`), so a glTF reader ignores that alpha instead of cutting the piece out; in Blender the albedo image is
channel-packed with its Alpha output unlinked (`kit_templates.py`). The gutters' neutral height 0.5 (§3) is now the
albedo's alpha there.
