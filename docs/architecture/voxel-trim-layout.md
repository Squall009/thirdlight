# Texture layout for voxel construction — DRAFT — v1 candidate (edge model)

Status: **DRAFT — awaiting owner approval (46c hard stop); nothing builds on it as final.** No kit pipeline, Blender
template, spec sheet or art-factory graph treats these numbers as fixed until the owner approves them. The owner's
2026-11-04 review replaced the earlier draft (a trim sheet sized for pieces over whole walls and their run sections);
that text is in git history. Sources: [plan 46c](../plan-phase-46c.md) §6b and the decision log (OWNER 2026-11-04:
walls and floors are plain voxel faces, tiling textures authored to a 4 × 4 m full wall, grid-anchored; R4 and R5
results); [plan 45](../plan-phase-45.md) §1d and §7a (trim optional per kit, own bakes allowed), §7 (R112: no trim
sheet for terrain or construction voxels); the [role spec draft](voxel-role-spec.md) (the cases); code:
`project-model` `voxel-trim-layout.ts` (the layout `detail-trim` as built), `voxel-kit-check.ts` (rows T1–T10),
`voxel` `derived-shader.ts` (tile repeats), `three-adapter` `voxel-surface-projection.ts` (base UVs) and
`voxel-trim-u.ts` (`pieceU`, edge U). Open questions are in §7, the checklist in §8.

**Owner 2026-11-05:** pieces are drawn near only; from the middle ring out the edges are plain square voxels. There are
no low pieces (removed from the kit format, the check and the placeholder kits in 46c.16a), so every "high / low"
mention below now means the one piece mesh; the rewrite of this draft (46c.16g) removes them.

## 1. Two kinds of surface, two layouts

| | Base surfaces | Detail pieces |
|---|---|---|
| What | wall, floor, ceiling and flat-roof voxel faces; the roof mesher's sloped planes | edge strips, corners, roof-edge trims (ridge, eave, verge, hip, valley), debris, beams and banisters |
| Texture | the material's **tiling** texture set: one repeat = a **4 × 4 m full wall** | path A: the **detail trim sheet** (§3), or path B: the piece's **own bakes** + the material's tiling set (§4) |
| UVs | none in the mesh: the shader maps them from the world (§2) | in the mesh (UV0), offset along the edge per instance by the engine |
| Never | a trim sheet (R112) | a unique texture per piece instance |

Terrain is neither: triplanar at a 2 m repeat, its own materials, never this page's layouts.

## 2. Base surfaces: the 4 × 4 m grid-anchored tile

**The rule (owner 2026-11-04):** a construction material's tiling texture is authored to one full-size wall, **4 m
wide and 4 m high**, and one texture repeat covers exactly that in both directions. It is anchored to the build grid
in metres, so a band painted at 2 m sits at 2 m on every wall, across every chunk, and floors use the same grid.

As built (R4, the minimal part ahead of 46d's material model):
- **Walls:** U runs along the face to the right seen from outside, V is the world height (so text and patterns are
  never mirrored on a face). **Floors:** U = x, V = −z; **ceilings:** U = x, V = z. **Sloped roof planes:** U level
  along the ridge, V the true distance up the slope (a 45° step is √2 × 0.5 m), on its own phase so V runs on across a
  whole roof.
- **Repeat per material**, in the material table: construction `CONSTRUCTION_TILE_METRES` = 4 m, terrain
  `TERRAIN_TILE_METRES` = 2 m; a repeat must divide 512 m (the grid's phase), else it is refused.
- The **role** of the cell, not the material, picks the mapping: stone used as ground maps triplanar, stone used as a
  wall maps to the grid.
- **Debug bands** (`?bands=1` on the slice page): a line every 0.5 m, thick lines at 0 and 2 m, a tick every 1 m over
  the 4 m tile. Seen on both renderers: bands at the same height on two houses across a chunk face, along a floor across
  a chunk face, parallel to the eaves on both roof slopes.

**Authoring a base texture (draft defaults):**

| | Default |
|---|---|
| Size | **4096 × 4096 px = 4 × 4 m**, authored at **1024 px/m** |
| Tiers | the tier caps the resident top mip: low 256 px/m (1024²), medium 512 (2048²), high 1024 (4096²); one asset set |
| Tiling | seamless left–right and top–bottom (a wall taller or wider than 4 m repeats it) |
| Grid features | courses, boards, log lines and joints at multiples of **0.5 m** (or 0.25 m inside a cell), so they meet the voxel edges and the edge pieces; the tile's bottom edge = the 0 m line of the grid |
| Floors and ceilings | the same 4 × 4 m tile on the same grid (a floor's board joints line up with the wall's verticals) |
| Roof planes | the roof material's tile laid up the slope: V counts true slope distance, so a 4 m tile covers 4 m of slope (≈ 2.83 m of rise at 45°) |
| Maps | albedo (sRGB), normal + height (height in alpha; OpenGL green up), ORM (AO, roughness, metalness); wetness and relief (46d) read the height |
| Anti-tiling | one repeat per 4 m wall already avoids per-cell repetition; avoid a single eye-catching mark in the tile. Macro variation, tint jitter and stochastic sampling are 46d proposals, not this draft |

The material model, texture arrays, residency and compression are 46d's; this draft fixes only the tile size, the
anchoring and the authoring conventions.

## 3. Detail pieces, path A: the detail trim sheet

A kit opts in with `trimLayout: "detail-trim"` (both placeholder kits do). Its pieces' UV0 lie in regions of one
shared sheet, so **any texture set painted in the layout dresses any kit of the layout** with no re-export (oak,
maple and burnt oak on the same log kit).

**The sheet:** 4096 × 4096 px = 4 × 4 m at 1024 px/m (the same density as the base tile), tiers as §2, 32 px gutters
round every region (clean to mip 5), regions on multiples of 32 px. Reserved space stays neutral (height 0.5, flat
normal); a later layout version may add regions there, never move one.

**How an edge piece maps (as built):**
- **U runs along the edge's world axis** at 0.25 a metre (the sheet's width = 4 m, the base tile's width), so a 0.5 m
  edge piece spans U 0.125 and the strip's pattern repeats every 4 m, in step with the wall's tile. The mesh is
  authored with U starting at 0 on the cell's −x face; the engine adds each instance's offset from its world cell
  (`pieceU`), growing along the world's positive axis, so neighbouring edge pieces meet without a seam whatever their
  yaw, alias or mirror. **Vertical edges take U up y** (from the edge's world axis after the alias's rotation).
- **V by region at real size:** each face across the edge maps into one strip whose height is the face's size
  (square texels). Round members (a log edge) wrap a plain strip whose height is their circumference.
- **Corners, ends and breaks** map once into a **cap** cell of the next size up, at real size, centred (corner blocks,
  log ends, a debris break). Every cap draws from cell `a`; b–d are unused (the hash-moved caps were never built).
- **Roof-edge pieces** take U along their case's own x like an edge: the ridge and eave lie along it; the verge, hip
  and valley run diagonally to it, so their U follows the horizontal x, not their sloped length.
- **High, low and variants use the same regions** for the same faces, so a level switch or a variant never jumps the
  texture.
- **Faces planar elsewhere:** a face that is not along the edge maps its own plane at real size into the field or a
  strip tall enough.

**Regions (layout `detail-trim` v0, as built; rectangles in px of the 4096² sheet, y from the top):**

| Id | Kind | Height | y px | Named by the edge-model placeholder script |
|---|---|---|---|---|
| F1 | field (tiles U and V) | 1.0 m | 32–1056 | yes: planar side faces |
| S50 / S50p | strip plain / profiled | 0.5 m | 1120–1632 / 1696–2208 | S50 yes; S50p no |
| S25 / S25p | strip plain / profiled | 0.25 m | 2272–2528 / 2592–2848 | S25 yes (bark, block faces); S25p no |
| S12 / S12p | strip plain / profiled | 0.125 m | 2912–3040 / 3104–3232 | S12 yes; S12p no |
| C50a–d | cap 0.5 × 0.5 m | 0.5 m | 3296–3808 | only through the by-size cap pick |
| C25a–d | cap 0.25 × 0.25 m | 0.25 m | 3296–3552 | yes (log ends, end faces) |
| C12a–d | cap 0.125 × 0.125 m | 0.125 m | 3616–3744 | yes (small ends) |

The region set was sized for the earlier draft's pieces over whole walls (half-log courses, copings, plinths, opening
frames): the **profiled strips are unused** by edge pieces, the 0.5 m caps fit only the largest ends, and the 1 m
field now serves only planar side faces. Question 3 asks whether v1 drops or shrinks them (a smaller sheet, or more strip heights in the
range edges actually use: 3–15 cm).

**Kit check rows (kits with `trimLayout` only, `voxel-kit-check.ts`):** T1 every triangle inside one region (err), T2
nothing in gutters or reserved space (err), T3 square texels (warn), T4 U at 0.25 a metre from 0 along the mesh's x
(err), T5 profiled strips on faces of their height (warn), T6 end faces in the right cap (warn), T7 high, low and
variants on the same regions (warn), T8 joined run sections on the same regions (warn; beams and banisters only now),
T9 the texture set (info: the kit format names no texture set yet), T10 regions used (info). **Gap:** T4 reads U
along the mesh's own x on every case; a vertical edge authored as its own mesh (running up y, like the log kit's log
ends) is not checked along y, though the renderer maps it up y.

## 4. Detail pieces, path B: own bakes + the material's tiling set

A kit without `trimLayout`: a piece samples the **cell's material tiling set** (the same 4 × 4 m tile its wall uses)
along the edge on UV0, and may carry its own sculpt bakes (normal, local AO) on a unique **UV1**, blended over the
material normal in the piece's tangent frame. Best for sculpted, irregular pieces (a rough stone quoin, carved
rubble) where the shape carries detail no strip can. The bake is local (no occlusion from neighbours). **Not built:** the renderer draws path-B pieces with the stand-in material today, and the kit
check has no UV1 rows yet (UV1 present, in 0–1, non-overlapping).

**Debris** is the likely path-B case: rubble and broken rims are irregular and few (one cell each), so own bakes on a
small unique UV cost little; the trim caps serve the simple ones.

## 5. Materials on pieces

- A piece draws with the texture set of its **owning cell's material** (role spec §3), read from the same per-chunk
  material + wetness grid the faces blend from, so wetness darkens it alike.
- A per-case material override (a stone kit's timber beams) is not in the kit format; question 5.
- Paint overlays (dirt, moss, snow) stay world-projected and cross pieces and faces without seams; they never use
  trim UVs (46d).

## 6. Worked examples: the two placeholder kits (R5, path A)

Engine test data, not game art; drawn with the layout's generated debug set (each region a hue with its id, a
3.125 cm checker, a U tick every 0.125 m), no textures embedded; no normal bakes (no fine detail to bake).

| Kit | Pieces | Faces → regions |
|---|---|---|
| log | round log over outer top edges (2 variants), log ends at vertical edges, crossing logs at corners, a pole in inner edges, ridge log, eave fascia, barge log up the verge, hip and valley caps, split logs (2 stages), splinters, beam, rails, post | U along the edge on faces along it (strips **S12** / **S25** / **S50**); log ends in caps by size; other faces planar at real size (**F1**) |
| stone | chamfered (v0) or chipped (v1) block edge 3.5 cm proud, chamfer fillet in inner edges, corner block, ridge/hip/valley tile caps, eave drip lip, verge board, broken blocks, chips | the same rule: strips along the edge, caps by size for ends, planar **F1** elsewhere |

Log: 22 pieces, 757 / 350 triangles high / low, GLB 96,744 B; stone: 21 pieces, 490 / 414, GLB 85,260 B; kit check 0
errors, T1–T8 ok on both.

## 7. Open questions for the owner

1. **Base tile:** 4096² at 1024 px/m for the 4 × 4 m wall, tiers 256 / 512 / 1024 px/m. Right density, or 512 px/m
   authored (2048²) since relief carries the near detail?
2. **Grid features at 0.5 m multiples** (courses, boards, joints meeting the voxel edges): a rule for every
   construction texture, or only a recommendation?
3. **The detail sheet's regions:** drop the unused profiled strips and 0.5 m caps (and shrink the sheet to 4096 ×
   2048), add thinner strips (0.0625 m) for edge profiles, or keep v0 as is?
4. **Path A vs B:** both allowed, per kit or per case? Should debris default to path B (own bakes)?
5. **Per-case material override** (a stone kit with timber beams): add an optional kit field?
6. **Diagonal roof edges** (verge, hip, valley): U along their sloped length (a new axis rule) or along the
   horizontal x as built?
7. **Cap variants b–d:** let the engine pick them by hash, or only through kit variants?
8. **Height scale:** one absolute scale for base tiles and the trim sheet (0–5 cm), so relief and wetness behave the
   same on faces and pieces?

## 8. What you are approving

- [ ] Base surfaces use the material's tiling texture, one repeat = a 4 × 4 m full wall, anchored to the build grid in
      metres (walls, floors, ceilings, roof planes up the slope); terrain stays triplanar at 2 m (§2).
- [ ] The base-texture authoring defaults of §2 (size, tiers, seamless, grid features, maps).
- [ ] Detail pieces may use the detail trim sheet (path A) or own bakes + the material set (path B) (§3, §4).
- [ ] Path A mapping: U along the edge's world axis at 0.25 a metre (4 m repeat, in step with the walls), vertical
      edges up y, V by region at real size, caps for corners, ends and breaks, same regions for high, low, variants.
- [ ] The region set as you answer question 3, and the kit check rows T1–T10.
- [ ] Pieces take their owning cell's material (§5).
- [ ] Your answers to §7.
