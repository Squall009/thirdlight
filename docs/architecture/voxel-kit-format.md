# Voxel kits — format page (split from the format spec v1)

Status: **moved unchanged** from the [format spec](voxel-format-spec.md) v1 (APPROVED by the owner on 2026-11-02) in
46d.2 (D496), so the main spec stays under 2,000 lines before 46d adds to the formats. **Owner note:** a split; no
content, version or decision changed, only the cross-links. The kit record keeps its number §3.9; every other §
number names a section of the [format spec](voxel-format-spec.md) unless it is marked as this page's. The role spec
is [voxel-role-spec.md](voxel-role-spec.md), the texture layout [voxel-trim-layout.md](voxel-trim-layout.md), the
rendering and material additions of 46d [voxel-render-spec.md](voxel-render-spec.md).

---

## Kits: edges, roofs and damage (as built in 46c and its revision; derived v10 → v28)

**Owner note.** Kits change **no stored world format**: the chunk codec, region file, manifest, edit command, undo
record, save and overrides keep their v2 bytes ([format spec](voxel-format-spec.md) §3.8). Edge and corner pieces, roof words, forms and piece choices
live only inside a derive job; what 46c adds is derived data (versions 10–28, never stored, *Derived version
history* in the [format spec](voxel-format-spec.md) §3.7), one project setting (`voxel_piece_seed`) and one project content item, the voxel kit record (§3.9,
**`kitFormat` 1, final**). The owner approved the role spec (`voxel-role-spec.md`) and the texture layout
(`voxel-trim-layout.md`) as **v1 on 2026-11-06** (acc46c-r2 S1/S2); with them the edge catalogue (`edges-draft` v3,
the role spec's v1; the id is a label, nothing stores it) and kit format 1 froze: later changes are add-only versions
with an owner note.

**The model (owner 2026-11-04).** Walls, floors, stairs, pillars, foundations and flat roofs are plain voxel faces:
the base surface draws every flat face and no piece ever stands on one. Detail pieces go only where faces meet: one
instance a 0.5 m lattice edge or lattice corner, with a small hashed stagger, one mesh serving several cases turned.
Sloped roofs have their own mesher (planes over the 45° stair of roof voxels) with pieces only along its ridge,
eave, verge, hip and valley. A construction cell's shape is its **integrity** ([format spec](voxel-format-spec.md) §2.2): a damaged cell draws at its
kit's damage stage (cracks, or a hole dressed by its neighbours' damage pieces). From the middle ring out the cells draw as flat square voxels (two detail states: pieces at level 0 only,
owner 2026-11-05).
**Kits are slots (owner 2026-11-05/06):** every catalogue case is a slot of every kit, each optional (an empty slot
draws nothing, no warning, no fallback), holding 1..n meshes picked per piece by the project seed and position; one
texture set a kit; every piece jittered into the solid by the kit's `jitter`; no engine default kit (no kit: plain
voxel faces). Beams and banisters left the voxel phases (A1/A12): their cells are plain voxels. Ground-contact fringe and scatter are the terrain material's (47b); relief,
the material model and texture sets 46d's.

- **The rule set** (`kit-rules.ts`): `WORLD_RULES` = `EDGE_RULES` = `withEdges(TERRAIN_RULES, EDGE_CASE_CATALOGUE,
  'edges', 7)`: in **one** `AssemblyRuleSet` (R75) the terrain rules' classes, the forms, the **edge pass** (`resolveEdges`) and the roof words; radius max(terrain 2,
  `CASE_REACH` 2, `EDGE_REACH` 1 + `ROOF_PLANE_REACH` 1) = 2, so the job pad stays 3 and aprons and invalidation are
  unchanged. `ruleRadiusMismatches` compares each cell's class, case, edge pieces and roof word (`part` `class`,
  `case`, `edge`, `roof`) on random worlds at chunk edges 16 and 32. Versions: `edges` v1 the edge pass beside the old
  set (R1), v2 no edge piece round a roof plane cell (R2), v3 the world's set, pieces from edges (R3), v4 catalogue
  v2: no window pass (a catalogue without rules or fallbacks skips it), no run pass (46c.16b), v5 mixed corners
  (46c.16c), v6 1:2 roofs and roof gaps (46c.16d), v7 catalogue v3: only a hole (damage stages 2–3) excludes edges
  round it, a cracked cell keeps them (46c.16e); the edge pass reads the piece table for the stages
  (`resolveEdges(…, table)`, absent: the engine's).
- **The edge catalogue** (`kit-case-catalogue.ts`, `EDGE_CASE_CATALOGUE`, id `edges-draft` v3, `draft: false` since
  the v1 freeze, 17 cases, every one a kit slot, no window rules, no fallbacks; a case is id, roles, base, shape, note
  (v1's `required`, `run`, `feature`, `standIn` gone); the role spec v1 lists it case by case, `role-spec-doc.test.ts` pins
  doc = catalogue):

  | Cases | From |
  |---|---|
  | `edge-out-top`, `edge-out-vertical`, `edge-out-bottom`; `corner-out-top`, `corner-out-bottom` | the edge pass: 1 of 4 (corner: 1 of 8) cells solid |
  | `edge-in-top`, `edge-in-vertical`, `edge-in-bottom`; `corner-in-top`, `corner-in-bottom` | the edge pass: 3 of 4 (corner: 7 of 8) solid |
  | `roof-ridge`, `roof-eave`, `roof-gable` (verge), `roof-hip`, `roof-valley` | the roof words |
  | `damage-stage-2`, `damage-stage-3` (several a face toward a hole) | integrity by the kit's stages (`isHoleCell`, `damage-stages.ts`) |

- **The edge pass** (`edge-cases.ts`, `extractEdges`, reach 1). Per construction cell a 20-bit mask (12 edges, then
  8 corners; `PIECE_SLOT_TABLE`) and inner flags (`EdgeMasks`). A lattice edge reads its 4 cells, a lattice corner
  its 8; "solid" = any built role or terrain (opening, air, liquid = open). 1 solid = outer, 3 (7) = inner, 2 side by
  side = a flat face (no piece), 2 diagonal = two outer edges. **Mixed corners** (v23, rules `edges` v5; outer and
  inner edges meeting: a stair side's notch, an L's inside top corner, a wall's corner on a wider foundation) take one
  of the four corner cases: the solid cells' directions from the point, summed, name the anchor's octant (none when
  the sum is 0 on an axis); under five solid cells an outer corner of that (solid) cell, from five an inner corner on
  it opening the other way (that octant open) — `MIXED_CORNER`, the same rule giving 1 and 7. Top / vertical / bottom
  by gravity (no vertical flip), yaw 0–3 (`edgeCaseOf`, `edgeYawOf`). The **anchor** is the one solid cell (outer),
  the cell diagonal to the open one (inner) or the cell the corner rule names, so every piece has one anchor. **Who
  dresses it** (`slotDressing`, v23): an outer edge or a one-solid corner its anchor; elsewhere the solid cells
  showing a face there compete by role (roof > wall > pillar > stair > floor > foundation, `PIECE_ROLE_ORDER`), and
  winners of two kits leave the slot bare (the shader blend draws the seam); a dressing cell other than the anchor is
  named in the instance. **Openings:** an `opening` cell is open; an outer piece with an opening round it is cut
  flush at the anchor's faces toward it, an inner one (it would lie in the opening) is not placed; a dug hole (air)
  is an ordinary edge. No piece where a terrain cell (any fill) or an excluded cell (a roof plane cell or a hole)
  touches the edge: construction ↔ terrain contact is 47b's fringe.
- **The roof mesher** (`roof-mesher.ts` the planes, `roof-words.ts` which cells; reach `ROOF_MESHER_REACH` 3,
  inside the pad of 3; derived v15, 1:2 and support v24). A **plane cell** is a roof cell its kit draws whole (intact,
  cracked or at an integrity in no stage; v26) with nothing solid above, laid as a **45°** stair (a roof cell one up and across, or one down and across the other way; an eave corner
  of a hip by the diagonal) or a **1:2** stair (two cells along at a level, then one up; owner A7, v24): each
  direction of a cell is fitted, two cells along each way (`ROOF_PLANE_REACH` 2), to the 1:2 stair of the pair's low
  or high cell (its **phase**), a cell read at 45° first exactly as before and at 1:2 where a cell two along says so;
  one slope a roof (hips and valleys between equal slopes; default, owner to confirm). Flat and lone roof cells keep
  their voxel faces (the fallback; a hole-stage roof cell is a hole), and so do the few cells where a 1:2 L's two ridges cross.
  `classifyRoofs` gives each a u32 **roof word** (`ROOF_WORD`: rising directions, concave (valley), supported,
  shallow, gap, eave / verge / ridge sides, centre ridge, a phase bit a direction); `roofSurface` emits a closed
  prism a plane cell, in quarter cells: the top through the stair's outer corners (45°: T to T + 1 across a cell;
  1:2: T to T + ½ on a pair's low cell, T + ½ to T + 1 on its high one), the underside the parallel plane one cell
  lower (owner C4); where the roof's kit fills wall tops (`wallTopFill`, §3.9; v27, default off: the walls keep their
  steps) a cell over a body, or over one air cell over a body (`supported`, `gap`), closes down onto the
  body's top instead, its floor on the body's top face, so the body reads as cut to the underside slope (a gable's
  end wall under its verge, an eave wall up to the slope inside the attic) and the edge pass dresses no edge round that
  air cell (`isRoofGapCell`); ridge, hip and apex take the lowest plane, a valley the highest; shared sides cancel,
  each polygon names the cell it shows (the owner offset: the slab its plane cell, the closing floor and sides the
  body; v27), rows merging by geometry and crack only (v28, D525), every edge is split at the job's corners and,
  on a section face, at every half-cell point (quarter points up where a 1:2 plane cell meets that face; closed
  across sections and chunks). The planes are appended to the **base surface** (same 12-byte vertex, same shader); plane
  cells draw no voxel faces and hide none of their neighbours' (a wall through a roof keeps its faces). **Collision:**
  plane cells give no box; `collision.ramps` (a triangle mesh in the canonical bytes) carries the planes, so a
  character stands on the drawn roof (owner 2026-10-27, roof slopes collide as ramps); light, occupancy and
  navigation keep the stair voxels. `roofEdgesOf(word)` gives the roof-edge cases with yaw: eave and verge open toward
  +z at yaw 0, a ridge on the side it lies on (one along the cell's middle `centred`), hip and valley toward the
  cell's +x +z corner; a verge on the side before the rise carries the variant word's mirror bit (v18), an apex cell's
  ridge and hips the `half` flag (v19), a 1:2 roof's pieces `shallow` and `high` (v24). Only 90° hips and valleys.
  **One mesh a roof-edge slot, both slopes** (owner F3): authored for 45°, pitched by the renderer
  (`piece-placement.ts` `roofPitch`): an eave turned about its line, a verge about the gable's normal through its
  middle (rigid: the profile kept, a verge overlapping its neighbours on the shorter 1:2 run), a ridge, hip or
  valley squashed to half its height about its line (both its sides on the planes), each moved to the height of
  its plane's phase.
- **Pieces** (`derive-pieces.ts`, `cellPieces`; derived v16). A cell may own several instances, in cell order then:
  (a) its edge and corner pieces in slot order, (b) its roof-edge pieces, (c) on each intact body face opening toward
  a hole, its kit's stage count of that stage's damage pieces (scatter index 0 … n − 1, v25); only where its
  material's kit fills the case's slot. Every
  piece is its own instance (no merged run geometry). Run sections (`kit-runs.ts`, `runU`, `resolveRuns`) were
  removed in 46c.16b (`archive/removed-phase-46c/`).
- **Damage stages from integrity** (owner 2026-11-04: damage uses the shape field; 2026-11-05/06: A9 revised, G1,
  F4; derived v25; `damage-stages.ts`). A kit's `damage` (§3.9) sets three stages' integrity ranges, the default
  `DAMAGE_STAGES_DEFAULT`: **stage 1, 11–14** the block drawn with its edge pieces, its faces carrying the crack
  overlay's strength (0–255, higher as the integrity drops within the stage) in their vertices' position w (they
  merge only with faces of the same strength; the shader darkens the crack texture's texels at or above
  1 − strength: the engine's generated map or the kit's `crackTexture`, one map a construction tile (4 × 4 m),
  laid on the grid as the material's texture, so neighbouring cracked cells show one pattern; 46c.16k, owner
  2026-11-06); **stage 2, 6–10** and **stage 3, 1–5** a hole: a construction cell at either with a face open
  (`isHoleCell`, reach 1; buried damage stays a body) is `FORM_HOLE`, the whole box for collision, navigation and
  occupancy, drawing no face and hiding none of its neighbours', no edge piece round it; each intact neighbour face
  toward it carries `pieces` (default 6 and 3, at most `DAMAGE_PIECES_MAX` 16) instances of its own kit's
  `damage-stage-2` / `-3` slot, each with a scatter index (dressing word bits 11–14) the renderer spreads over the
  face (`damageScatter`: a jittered √n × √n grid within ±0.3 cell, spun about the face's normal). The hole's kit
  decides the stage, the face's kit the count; a material without a kit takes the default stages. An integrity in no
  stage of its kit draws intact. **Light** (F4): a damaged construction cell's coverage is its integrity's share
  (`integrityCoverage`, round(255 · integrity / 15)) at any stage, buried or not; 46e's tracer reads it. At air the
  neighbours' faces are the same faces and the hole's rim takes edge pieces. Damage shows at level 0 only (a
  construction mip parent is intact). What lowers integrity and when is game logic; smooth strokes place whole blocks.
- **Forms** (`case-forms.ts`, *Consumer tables* in the [format spec](voxel-format-spec.md) §3.7): bases keep / suppress, shapes box / panel / bar / post /
  none; a hole the box with its faces suppressed, every other cell its class's form (beam and rail cells: a body). Collision, light and navigation never read a piece mesh (R77).
- **Instance meaning** (*Detail instance* in the [format spec](voxel-format-spec.md) §3.7, 12 bytes): turn bits = the yaw; placement bits 2–3
  (`INSTANCE_PLACE`): upright, `faceUp` / `faceDown` (a damage piece on a top or bottom face), `centred` (half a cell
  in and half a cell down: one ridge mesh serves odd and even roofs); flags `shallow`, `high`, `half` (bit 4, once
  `replacesBase`, written 0 since v25). The piece
  u16 is the kit's filled-slot index; the variant word's bits 0–14 the slot's mesh, picked by
  `latticeHash4(cell, seed + level·φ + slot·c)` (slot = case index << 4 | placement << 2 | yaw, seed the project's
  `voxel_piece_seed`, replacing crc32(kitId)) among the meshes' weights, so a cell's edges vary on their own and an
  edit elsewhere never moves them; bit 15 (`PIECE_VARIANT_MIRROR`) the mirror (a verge rising toward its own −x).
- **The piece table** (format 5, `PIECE_TABLE_FORMAT`; `piece-table.ts`): built on the main thread from the
  project's kits (§3.9), the catalogue and the project seed, carried by every derive job, never stored. Bytes: u16
  format, rule id (text), u16 rule version, u16 case count, u32 project seed, u16 kit count; per kit (by id) its id
  (text), f32 jitter, u16 wall-top fill (0/1; format 5), its three damage stages (each u16 used, min, max, pieces a face; format 4), u16 piece count, case count × u16 (its piece, or `NO_PIECE` 0xffff: an empty slot), per piece a
  u16 count + u16 mesh weight thresholds; then u32 pair count and (u16 material, u16 kit) pairs. **Material → kit**
  from the material records (`voxel.kit`; a kit's own `materials` list binds only the ids no material record
  names: [render spec](voxel-render-spec.md) §1); a material no kit binds (`NO_KIT`) draws no pieces. No default kit (`default-kit.ts` archived). A kit's hash is crc32 of its part xor-mixed with the
  seed, so a seed change re-derives every bound material. Hosts build it with `worldPieceTable(kits, seed)`; slot
  rotations are the renderer's only. Canonical; a worker decodes it once and keeps it by hash; another format or rule
  set is refused.
- **Drawing** (three-adapter `voxel-kit-pieces.ts`, `voxel-piece-placement.ts`): GLBs from bytes the host hands the
  loader port (never a URL); **one instanced draw a (kit piece, variant, mirror, level) a chunk**; placement composes
  slot rotation · stagger · centring · tip · turns · scale. **Stagger** (`piece-placement.ts`, `PIECE_STAGGER`, owner
  2026-11-05/06: every piece jittered into the solid): every piece moves 1/64–1/32 cell into the solid and twists
  ≤ 2°, times the kit's `jitter` (0–4, `PIECE_JITTER_MAX`; default 1, `PIECE_JITTER_DEFAULT`), hashed per cell,
  level and the project seed (salted); `PIECE_STAGGER_FRAMES` gives every case its frame (edges and corners along
  the bisector, roof edges into the roof, a damage piece into the intact cell it dresses). Drawing
  only. `half` pieces draw the half of their run on the case's +x side (`pieceHalfRun`). A trim kit's U
  (`voxel-trim-u.ts` `pieceU`) runs along the edge's world axis (vertical edges up y, `pieceRunAxis`), along the mesh
  axis its slot rotation turns onto the run (`meshRunAxis`); pieces draw with a stand-in
  material and a 256² debug UV texture (a trim kit its layout's 1024² debug set) until 46d's materials.
- **Grid-anchored UVs** (derived v17): the base surface and roof planes are mapped from the build grid in metres by
  the shader data entry's construction bit (*Projection* in the [format spec](voxel-format-spec.md) §3.7: 4 m construction repeat, owner 2026-11-04; terrain
  triplanar 2 m; roofs up the slope), never from a trim sheet (R112).
- **Levels (two detail states, owner 2026-11-05, derived 21):** level 0 lists pieces, level 1 and coarser none
  (`levelHasCases`, `levelDrawsPieces`): from the middle ring out the edges are plain voxel faces. The roof
  mesher runs at every level. The mip downsample **lays sloped roofs again** (`voxel-mips.ts` `relayRoofs`, v19): one roof cell a parent column at floor(eave / 2) + ceil(ring / 2), so an off-grid 45° roof stays
  a one-cell 45° stair (eaves at one height, ridges, hips and valleys where the finer roof has them; v20: over the
  bodies it covers, such as a gable's end walls, whose coarse cells it takes), its planes
  within one level cell of the finer roof. A **1:2 roof** (most of its columns read 1:2, v24) is laid again at 1:2: a
  finer column's distance in from the eave is twice its ring plus its phase, a parent's half the smallest of its
  columns' (rounded up) and its rise half that, so the coarse stair starts with a pair at its eave; its planes lie
  within one and a half level cells of the finer roof (a small coarse 1:2 roof, four or five level cells across,
  may read a cell where an L's arms meet at 45°, `roof-mesher.test.ts`).
- **Changes and paints ([format spec](voxel-format-spec.md) §2.2 feeds).** A new piece table derives again only what holds a material whose pieces
  changed (`pieceTableChanges`), in one swap group. Wetness never changes a piece; a material paint within one kit
  keeps every piece and variant (shader data only); a paint moving cells to another kit's pieces also derives whole
  the sections holding the painted cells: **the one exception to "material → shader data only"**, by design (kits
  are per material type), for the owner. A `voxel_piece_seed` change re-derives every kit-bound material. A damage edit (integrity) is a shape change: it re-derives the sections
  within R. Level-1+ nodes still derive whole on any edit (D479).
- **Kit check and test scene.** `voxelKitCheck` (project-model; rows ok/warn/err/info: catalogue (an unknown slot
  an error), slots (info: n of 17 filled; an empty slot never warns, owner G2), assets, digests and pinned versions,
  pivot and fit (bounds turned by the slot rotation; a roof-edge piece's envelope a cell higher), texture set (an
  error when the pieces use more than one material / texture set: material name + CRC-32 of its images, owner B5),
  budgets reported never capped, trim T1–T7, T9, T10 only for kits with a trim layout (T4/T7 per slot mesh along its
  run axis; "(draft layout)" a named one, "(the kit's layout)" its `sheetLayout`) → Problems (`voxel_kit_check`), MCP
  `tl_diagnostics`. `writeKitTestScene {world, origin, material}` builds a fixed sampler (window exhibits only for a catalogue with
  window rules, none in v2: a block
  notched top and bottom, a gable, a hip, an L-plan roof, a wall at integrity 12 and 5) in an emptied box, one undo;
  every catalogue case is labelled at the first cell the passes give it.
- **Measured** (R6, staging, Iris Xe at the 60 Hz cap, plan 46c §8). Town with the log + stone kits: 88.1 k instances
  drawn (36.7 k L0 / 51.4 k L1; R6b re-laid roofs: L1 72.6 k → 32.5 k listed), 3,203 piece draws (46c.11: 4,133),
  `render()` CPU 14.6–15.3 ms p50, orbit 0–2 missed of ~480 (was 31–65, D485). Node µs a 16³ town section p50 / p95:
  edge catalogue passes 204 / 345 (edge pass alone 112 / 170, D497), roof mesher 193 / 418 (D502), over the 0.1–0.2
  ms budget. Base triangles with roof planes 361,642 vs 321,876 as stair faces (D512, won't fix). Blasts 1 / 4 m 1
  frame, 8 m 2–3 (R107).
- **Superseded** (owner 2026-11-04; history in git and plan 46c §8): the 46-case window catalogue `cases-draft` v0–v5
  with pieces on flat faces and its rule set `kits` v1–v6 (`KIT_RULES`) went to `archive/removed-phase-46c/` in R3c,
  with the `reshape` base and `slab` shape its soffit alone used; the case window, fold, priority and fallback
  machinery (`kit-cases.ts`, `withCases`) stays, unused by the edge catalogue since v2. In 46c.16b (owner
  2026-11-05/06) the beam and banister cases, run sections (`kit-runs.ts`), stand-in families and the default kit
  (`default-kit.ts`) went to `archive/removed-phase-46c/`. D480, D481, D483 superseded.

## 3.9 Voxel kit record, format 1 — final (`project-model` `voxel-kit.ts`; 46c)

**Owner note:** added in 46c as an add-only step beside the approved formats, changing none of them. **Final since
2026-11-06**, when the owner approved the role spec and texture layout as v1 (acc46c-r2 S1/S2): unknown versions are
refused, add-only from here. The changes below were made in place while it was a draft (`VOXEL_KIT_FORMAT` stays 1:
no record of an earlier shape ships, so no step).

- **Where it lives.** A kit is a project content item (`content.voxelKits`, resource kind `voxelkit`, one file a
  kit under `assets/voxel-kits/`), made by `setVoxelKit {kit}` and removed by `deleteVoxelKit {voxelKitId}`, one
  undo each; the editor, MCP and scripts send the same commands. It is not loadable by address or label: a build
  ships every kit whole in its catalog block `voxelKits`. It lives in `project-model`, not `@thirdlight/voxel`,
  because it names project assets and uses the project's id syntax; the voxel package stays free of both.
- **Fields, in canonical order:** `kitFormat` (1), `voxelKitId`, `name`, `version` (the kit's own revision, a
  positive integer), `materialType` (an id: a kit belongs to a material type, never to one material),
  `materials?` (test binding: voxel material ids 1–4095, ascending, each once; since 46d.3a it binds only the
  ids no material record names, the records deciding for theirs, [render spec](voxel-render-spec.md) §1, owner
  note there: no format change, never repurposed), `slots` (case id → `{meshes: [{mesh, rotation?, weight?, mirror?}, …]
  (one or more), gameData?}`; a mesh is `{assetId, digest, node?}`, the digest the GLB version's SHA-256 source
  digest; `rotation` a cube rotation 0–23, absent 0; `weight` absent 1; `mirror` true draws the mesh mirrored across
  its case's run, winding and tangents flipped, absent false, 46c.16k), `jitter?` (0–4, absent 1; a 1 is left out
  canonically), `trimLayout?` (an id; absent: no trim sheet), `sheetLayout?` (46c.16k, owner O1: the kit's own sheet,
  `{size 16–16384 px, pxPerMetre, regions: [{id, kind field|strip|profiled|cap, metres, y: [top, end), x? (caps)}]}`,
  regions not overlapping; instead of `trimLayout`, never both), `damage?` (46c.16e: `stage1?`, `stage2?`, `stage3?`
  each `{min, max, pieces?}` or null, `crackTexture?` `{assetId, digest}` an image asset; see below), `wallTopFill?`
  (46c.16j; a boolean, false left out canonically), `gameData?`.
- **Wall-top fill (owner 2026-11-06 follow-up choices; 46c.16j).** On a roof's kit (the kit of the
  roof cell's material): true closes the roof's slab down onto a body under it, or under one air cell under it (the
  body's top cut to the roof's underside, *The roof mesher* above); absent or false, and for a material without a kit, the
  walls keep their stepped tops under the parallel underside. 47a's building object may override it per building.
- **Damage (owner 2026-11-05/06 A9 revised, G1; 46c.16e).** A stage absent is the engine's
  (`DAMAGE_STAGES_DEFAULT`: 11–14 cracks, 6–10 a hole with 6 pieces a face, 1–5 with 3), null leaves it out; ranges
  are integrities 1–14, `min` ≤ `max`, no two stages sharing one; `pieces` (stages 2 and 3 only) 1–16. The checks are
  the voxel package's (`resolveDamageStages`), so the record and the table never disagree. `crackTexture` names an
  image whose red channel replaces the engine's crack map (one image a 4 × 4 m construction tile); the content closure ships it like a kit mesh (the
  version its digest names). An empty `damage` is left out canonically.
- **Slots (owner 2026-11-05/06; 46c.16a–b).** Every catalogue case is a slot; every slot is optional
  (left out: nothing drawn, no warning); a slot's meshes are picked per piece by the project seed and position,
  weighted; one mesh may fill many slots by rotation; one texture set a kit (a kit-check error, never a refusal); no
  engine default kit. Pieces are drawn at level 0 only, so a mesh has no `low` form. Removed from the draft:
  `cases`, `sections`, `variants`, `high`, `alias`, `joinProfiles`, `ends`; unknown fields are refused, so a stored
  kit of the old draft is refused (staging regenerates its kits); made in place before the freeze. Placeholder kits
  (Blender 5.2.2, 46c.16e): log 14 meshes in 15 slots, 304 tris, GLB 26,748 B; stone 13 meshes in 15 slots, 170 tris,
  19,956 B (the `debris` slots replaced by `damage-stage-2`/`-3`).
- **Slot rotation** (superseded the R3b `alias`, owner 2026-11-05/06). A mesh's `rotation` (`@thirdlight/voxel`
  `CUBE_ROTATIONS`: the signed permutation matrices of determinant +1, permutations in lexicographic order, then row
  signs in binary order, + before −; 0 the identity; never a mirror) turns it before the case's placement, so one
  mesh serves several slots; its trim U runs along the mesh axis the rotation turns onto the slot's run
  (`meshRunAxis`).
- **Canonical form.** Rebuilt field by field: maps by key, materials ascending, a weight of 1 and empty maps left
  out, game data with its object keys sorted and its values as given. Unknown fields at any level are refused.
- **Game data** (per kit and per slot) is any JSON nested at most 32 deep (finite numbers): break, sound and
  physics defaults are the game's; the engine validates, keeps and ships it and never reads a member.
- **What is not refused.** A slot id the catalogue lacks, a mesh naming an asset the project lacks or a
  digest no version has: these are kit-check rows (46c.8), never refusals, so a catalogue change or an asset
  re-import never invalidates a stored kit. A build ships, for each mesh, the asset version whose source digest the
  mesh names (the current one when none has it); a mesh naming an absent asset ships and draws nothing.
- **Size.** No count caps: a kit's file is held to the content file byte cap (1 MiB) like every resource.
  Measured before the slot format (the backend test's kit: 2 cases, 1 section, 1 variant, 1 join profile, game data):
  535 bytes compact, 1,043 bytes on disk; not re-measured for slots.
- **Versions (final, owner 2026-11-06).** A `kitFormat` other than 1 is refused whole (a newer one
  `kit_format_unsupported`, any other `field_value`), never read in part; a later format adds fields only.
