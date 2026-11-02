# Voxel world formats — requirements trace

Status: **DRAFT — part of format spec v1, awaiting owner approval.** Nothing here is frozen. The format spec
is an owner hard stop at the end of phase 45 ([plan §1](../plan-phase-45.md#1-owner-decisions-2026-10-27)).

This list traces every plan decision that constrains a voxel **format** (chunk store, region files, edits/undo,
saves, streaming/coordinates, derived data, job contracts) to the rule that must serve it. Source:
[`docs/plan-phase-45.md`](../plan-phase-45.md) (§1–§1e, §2, §5–§5c, §7a, §8, §9) and the owner rules in
`AGENTS.md`. §7a (2026-10-30) takes precedence where it revises earlier sections; proposals it marks unresolved
are listed as open (§4 below), not as requirements. A decision that fails in measurement is not dropped: 45.7
records why and proposes replacements that keep its goal, and the owner chooses (§1, decision log 2026-10-28).
No measurements are claimed in this file.

**Status key.** *owner* = owner decision; *default* = default used unless the owner says otherwise; *proposal* =
direction recorded but not yet a settled spec; *superseded → X* = replaced by X (still listed so its goal is
kept); *revised → X* = still binding in part, X changes how. *Inferred* marks a consequence this trace draws
that the plan does not state.

**Area key.** store = chunk store / voxel record; region = region files and tiles on disk; edit = commands,
undo, structure overrides; save = game saves; stream = streaming, memory, coordinates, export delivery;
derived = rebuilt data (meshes, occupancy, mips, collision, nav, light); job = worker job contract and
invalidation.

## 1. Requirements

### 1.1 Process and versioning

| Id | Decision | Source | Status | Areas |
|---|---|---|---|---|
| R1 | Every format field/rule traces to a plan decision; a failing decision gets replacements with costs, owner chooses | §1, §7 2026-10-28 | owner | all |
| R2 | Format spec is drafted, prototyped and shown; v1 only after owner approval; nothing builds on it as final before | §1 hard stops | owner | all |
| R3 | Voxel formats are new and versioned; upgrades only add steps; an unknown version is refused | §2, brief | owner | store, region, save |
| R4 | A damaged chunk is repaired or regenerated, never silently dropped | §2 | owner | store, region, save |
| R5 | Binary chunk codec carries magic, version, checksum and a world-scoped key | §2 | owner | store, region |
| R6 | One mutation path: editor, MCP and game sessions send the same commands | AGENTS.md, §5b | owner | edit |
| R7 | No per-project count caps; counts become memory budgets; a limit is defined once in its owning package | AGENTS.md, brief | owner | store, stream |
| R8 | Hand-authored worlds only, no procedural/seeded world generation (derived scatter seeds are dressing, R71) | §1 scope | owner | store, region |

### 1.2 Voxel model and chunk store

| Id | Decision | Source | Status | Areas |
|---|---|---|---|---|
| R9 | Voxel size 0.5 m, no exceptions (world grid and every structure grid) | §1, §1e | owner | store, derived, stream |
| R10 | The backend is entirely voxels; block layers and heightfield terrain are retired onto it (48) | §1, §5 | owner | store |
| R11 | A voxel holds material id, role, shape/density, orientation; stored sparsely; target ~4 bytes, 45.2 measures | §1 | revised → §7a: role becomes a stored coarse category whose schema is unresolved (Q-a) | store |
| R12 | Roles list (terrain, foundation, floor, wall, roof, stair, window, door, beam/ledge, pillar, …) as per-cell labels | §1 | superseded → §7a: beams, banisters, soffits, mouldings are derived cases, not mandatory labels (Q-a) | store, derived |
| R13 | Rules live in authoring tools, mesher stays local: "what is in the voxels is what gets built" (tool writes ledge voxels) | §1 | superseded → §7a shared assembly evaluation inferring architecture from arrangement (Q-a, Q-c) | store, derived, job |
| R14 | Slopes come from roles: one diagonal pattern reads as roof, stair or smooth slope by role | §1 | owner (needs a stored category that tells roof/stair/terrain apart, inferred) | store, derived |
| R15 | Uniform storage: one compact format for every chunk, no hybrid second format | §1b | owner | store, region |
| R16 | Palette per chunk with bit packing | §1b | owner (candidate measured in 45.2) | store |
| R17 | Uniform chunks (all air, all one material) collapse to a few bytes; absent air allocates no cell arrays | §1b | owner | store, stream |
| R18 | Vertical run-length encoding per column | §1b, §3 45.2 | owner (candidate; 45.2 compares with/without and SVO-like bricks) | store |
| R19 | Density stored only at boundary voxels; inside/outside voxels carry none | §1b | owner | store |
| R20 | Each field in its own plane (material, role, shape, orientation), then zstd (45.2: zstd vs lz4) | §1b, §3 | owner (codec by measurement) | store, region |
| R21 | Every system reads through one function `voxelAt`; cheaper special forms may slot in behind it only | §1b | owner | store |
| R22 | Chunks are cubic, not full-height columns; 32³ (16 m) default, 16³ vs 32³ decided by 45.2 | §1b, §2, §5 | default | store, region, stream |
| R23 | Untouched terrain stored "as the field" (§5b git bullet) | §5b | superseded → §1b uniform storage + column RLE (inferred: §1b "replaces the hybrid idea") | store |
| R24 | Liquids are ordinary voxels with the `liquid` role; no separate fluid channel | §1, §8 | owner | store, save |
| R25 | Liquid surface fill level uses the same shape/density field as terrain; voxels below are full | §8 | owner | store |
| R26 | Shoreline: liquid fills the non-solid part of a partly-ground cell | §8 | owner (format implication open: one material per voxel cannot name both, O15; may need per-voxel bits the 32-bit record value has no room for, see spec §1) | store, derived |
| R27 | Material id refers to the one material record (§1c); voxel use (kit / projected / liquid) lives on the material, not in the voxel | §1c, §8 | proposal (material model settles in 46) | store |
| R28 | Material physical data (mass density, flow rate) is on the material, not per voxel | §8, §1c | owner (liquids); proposal (solids) | store |
| R29 | Stamps: a plain mesh is voxelized and reused anywhere with any material | §1 | owner | edit, store |

### 1.3 Structures, grids and overrides

| Id | Decision | Source | Status | Areas |
|---|---|---|---|---|
| R30 | A building is an editable structure (footprint, storeys, height, roof, material, openings); its voxels are a pure function of it | §1b | owner | edit, store |
| R31 | Material swap on a structure changes only material ids | §1b | owner | edit, store |
| R32 | Scale in 0.5 m steps, extend by footprint polygons, drag up adds storeys; wings join in voxel space | §1b | owner | edit |
| R33 | Hand edits on a structure are a delta over its generated voxels; regeneration keeps fitting overrides and reports the rest | §1b | owner | edit, store |
| R34 | Generator upgrades apply automatically to every structure (no version pinning); one undoable regenerate-all step reports misfits | §5c | owner | edit, store |
| R35 | Structures are authoring-time; exports ship resolved voxels; gameplay edits and saves act on voxels | §1b | owner | region, save |
| R36 | Every structure owns a local 0.5 m grid anchored on its foundation, any yaw, vertical-axis rotation only | §1e | owner | store, region, stream |
| R37 | Building over/next to a foundation joins its grid; grids at different angles never merge voxels | §1e | owner | store, edit |
| R38 | Terrain, liquids and stamps stay in the world grid (stamps rotated before voxelizing) | §1e | owner | store |
| R39 | Exports keep structures as voxel objects with transforms, never resampled into the world grid | §1e | owner | region, stream |
| R40 | Collision is one static body per structure; walk graph per grid stitched at doors/foundations; tracer steps each grid in its own space | §1e | owner | derived |
| R41 | Water bodies (lake, river, sea level) are structure objects until export; resolve order ground → buildings → water | §8 | owner | edit, store |
| R42 | Sea level is one plane per world | §8 | owner | store (world metadata, inferred) |
| R43 | Generated architecture tool writes voxels and roles, not its own meshes or colliders; one structure system | §5b | default | edit, store |
| R44 | Placed objects (props, furniture, trees, characters, prefabs) stay meshes, never world voxels | §5b | default | store |
| R45 | Doors/windows: opening and frame from voxels; leaf/glass are props placed by size; open/shut is portal state, not voxels | §1b, §1d | owner | store, derived |

### 1.4 Tiles, region files and git

| Id | Decision | Source | Status | Areas |
|---|---|---|---|---|
| R46 | Worlds grow tile by tile; 10 × 10 km is capacity, not the default; new worlds start as a few tiles | §1b, §5 | owner | region |
| R47 | Each tile is its own region file | §1b | owner | region |
| R48 | Tile = 16 × 16 chunks = 256 m footprint (512 m compared); 256 m is a footprint, never a height limit | §1b, §5 | default | region |
| R49 | Vertical extent ~1–2 km base to peak, headroom above; benchmark 2 km with deep caves and tall structures | §1b (owner 2026-10-31) | owner | store, region, stream |
| R50 | Full-height region columns are the current default; vertically stacked containers are a candidate to compare | §1b (2026-10-31) | default | region |
| R51 | Region files are deterministic: same content, same bytes | §1b | owner | region |
| R52 | Per-chunk offsets for partial reads and HTTP range streaming | §3 45.3, §2 | owner (item scope) | region, stream |
| R53 | Git-friendly: region files bound the file count of a 10 km world; LFS only if 45.3's repo-growth numbers call for it | §1b, §5b | owner | region |
| R54 | Derived data (meshes, HLOD proxies, bricks, occupancy) is never committed, always rebuilt | §5b, §3 45.6 | default | derived, region |
| R55 | Storage target: hundreds of MB for a large world, not gigabytes (to be measured) | §2 | owner target | store, region |

### 1.5 Edits, undo and saves

| Id | Decision | Source | Status | Areas |
|---|---|---|---|---|
| R56 | Commands work in strokes (brush, fill, stamp, room), one command each | §5b | default | edit |
| R57 | Undo is per chunk; copy/paste are voxel blocks | §2, §9 | owner | edit |
| R58 | The engine provides set/dig and a guaranteed path from a gameplay edit to meshes, collision, walk graph, lighting | §1 | owner | edit, job, derived |
| R59 | Saves hold only chunks a player changed, relative to the shipped world; never every generated chunk | §2 | owner | save |
| R60 | Saves record a content hash per base chunk; the engine detects a mismatch after re-export; the game chooses | §5c | owner | save |
| R61 | Local liquid settling is deterministic and saved | §8 | owner (phase 49) | save, job |

### 1.6 Streaming and coordinates

| Id | Decision | Source | Status | Areas |
|---|---|---|---|---|
| R62 | 10 × 10 km design target; coordinates must cover 10 km (today ±4096 cells/tiles) | §1, §2 | owner | stream, store |
| R63 | Floating origin, re-based about every 1 km of travel | §2, §5 | owner; interval default | stream |
| R64 | Everything streams by distance under one memory budget per tier; nothing loaded for the whole world | §2, §3 45.5 | owner | stream |
| R65 | The editor streams: loads only the region being edited; the backend never holds the whole world | §2 | owner | stream, edit |
| R66 | Exports stream chunks on demand (HTTP range or per-chunk files) with a local browser cache | §2 | owner | region, stream |
| R67 | Every job has an id; dirty state tracked (prevents unload/save/worker-timeout races) | §2 (cuubz) | owner | job |
| R68 | Priority queue: edits > near > far/LOD | §2, §3 45.5 | owner | job |
| R69 | Neighbours sent as thin strips (aprons), not whole chunks; transferable buffers | §2, §3 45.5 | owner | job |
| R70 | Runtime voxel code loads in module workers and exported games (no node:, no three.js in runtime parts) | AGENTS.md, brief | default (package home `packages/voxel` = `@thirdlight/voxel`, set in 45.1b; owner to confirm) | job, stream |

### 1.7 Derived data and job contracts

| Id | Decision | Source | Status | Areas |
|---|---|---|---|---|
| R71 | Rule scatter is disposable: rules + stable seed stored, placements derived deterministically, independent of load order and origin shifts | §7a (deferred) | proposal (deferred) | derived, job |
| R72 | Meshing in module workers is a pure function of the voxels | §2 | owner | derived, job |
| R73 | Base geometry is generated from the voxel world (also for construction), with projected tileables | §7a | owner direction (details open) | derived |
| R74 | Projected (smooth, surface nets) vs modular (complete hand-modelled kits) per material | §1, §2 | revised → §7a: voxel-derived base surfaces plus inferred detail pieces | derived |
| R75 | One shared assembly evaluation resolves base surfaces kept/suppressed/reshaped and detail pieces before emitting anything | §7a | proposal (contract to prove in 45.7) | derived, job |
| R76 | Original voxel data is authoritative; resolved meshes and all other representations are derived | §7a | owner direction | store, derived |
| R77 | Collision, navigation and light occupancy agree with the resolved architecture (an open rail is not a wall) | §7a | owner direction | derived |
| R78 | Modular roles collide as voxel boxes, stairs/roof slopes as ramps | §2 | superseded → R77 (§7a revisits blanket box collision) | derived |
| R79 | One occupancy bitmask (1 bit/voxel) shared by tracer, culling, physics, nav, audio, gameplay | §9 | superseded → §7a / Q-b (provisional; per-consumer representations) | derived |
| R80 | Kit pieces may stick out; lighting and collision use the voxels, not the pieces | §9 caveat | superseded → R77 | derived |
| R81 | Smooth ground: occupancy treats a voxel as solid when more than half full | §9 caveat | owner overview (needs measuring) | derived |
| R82 | Solid/empty/mixed flag per chunk and per tree node | §9, §3 45.6 | owner overview | derived |
| R83 | An edit re-meshes only its own chunk (plus a neighbour at a border); edits mark only their own chunks stale | §2, §9 | superseded → Q-c dependency radius R across chunk boundaries | job, derived |
| R84 | Chunk tree: 2 × 2 × 2 merge per level; level L holds voxels of 0.5 m × 2^L (density averaged, dominant material + paint colour) | §2 | owner | derived |
| R85 | A changed chunk marks its tree ancestors stale; runtime rebuilds only nearby low levels, high levels at export | §2 | owner | job, derived |
| R86 | Separate run models of 0.5/1/2/4 m | §2 | superseded → §7a merge-compatible sections (renderer instancing vs merged cache measured) | derived |
| R87 | One standard trim UV layout for every kit, no unique-UV exceptions | §1, §1d | superseded → §7a: trim optional; detail meshes may use own bakes | derived |
| R88 | No displacement tessellation | §1 | superseded → §7a: shader displacement of worker-generated topology is a pending prototype | derived |
| R89 | Surface subdivision LOD is separate from voxel shape LOD; displacement never updates collision/occupancy | §7a | proposal (prototype) | derived |
| R90 | Authored high/low detail meshes, then voxel-derived fallback | §7a | owner direction | derived |
| R91 | Mesh output: per vertex up to 4 overlay ids + weights; material id → slot table on GPU | §2 | owner | derived |
| R92 | Paint overlays blend in world space across kits and terrain | §1 | owner (storage location open, O16; per-voxel paint would need bits the 32-bit record value has no room for, see spec §1) | store, derived |
| R93 | Lighting occupancy channel for "affects lighting" props: coverage fraction per voxel, never in world voxels | §1b | owner | derived |
| R94 | Prop proxies voxelized at placement into each host grid they overlap (4 × 4 × 4 samples per cell from import bricks); overlaps combine 1 − (1 − a)(1 − b) | §1b | owner | derived, job |
| R95 | Occupancy channel is never stored in files; recomputed at placement, move and chunk load from the prop list | §1b | owner | derived, region, save |
| R96 | An occasional mover re-stamps its occupancy and marks only nearby chunks for re-lighting | §1b | owner | job |
| R97 | Chunk connectivity: per chunk, which of its six faces join through air | §9 | owner overview | derived |
| R98 | Sky visibility = highest solid voxel per column | §9 | owner overview | derived |
| R99 | Rays step 6-connected (no diagonal slip) | §9 | owner overview | derived |
| R100 | Walk graph samples the same surfaces, hierarchical per chunk; an edit rebuilds one chunk's piece | §2, §9 | owner (rebuild extent revised by Q-c) | derived, job |
| R101 | Rooms and portals come from roles (floor/wall/roof enclose, door/window are portals) | §2, §9 | owner (depends on stored category, Q-a) | store, derived |
| R102 | Scatter, cut-away and see-through rules read material and role/category directly | §9 | owner overview | store, derived |
| R103 | Proxy pull-in counts only voxels above a coverage threshold (~0.5) | §9 | owner | derived |
| R104 | Voxel light volume (air-side, 6 directional values, coarse 1/2/4 m levels, saved settled bake per tile for low tier/WebGL 2) vs phase-42 cache | §5c | proposal (46d decides) | derived, region |
| R105 | Projected roles collide against the extracted smooth surface per chunk; static trimeshes per chunk streamed (Rapier churn measured) | §2, §5c | owner | derived, stream |
| R106 | `ctx.grid` becomes a deprecated wrapper mapping layer coordinates to structure and world grids | §5c | owner | store (addressing) |

Count: 106 rows, of which 10 are superseded (R12, R13, R23, R78, R79, R80, R83, R86, R87, R88) and 2 revised
(R11, R74). The superseded goals stay: R12/R13 → inferred
architecture keeps "authors build with today's tools, the voxels decide the look"; R79 → "cheap exact grid
queries" kept by per-consumer derived occupancy; R83 → "edits rebuild locally" kept by a bounded radius R.

## 2. The three assembly-data questions (plan §3, owner 2026-10-30)

### Q-a. Stored intent versus inferred architecture

Requirement: store the minimum metadata that tells terrain, construction and roofs apart; beams, banisters,
soffits, mouldings and running boards are derived cases. Equivalent runtime voxel edits without
structure-authoring metadata (R30–R35) must yield the same result (§7a runtime building).

Options for the stored per-voxel record (candidates, none decided):
1. **Coarse category + material + shape/density (+ orientation?)**. Category set e.g. air, terrain,
   construction, roof, liquid, … (small, a few bits). Everything finer is inferred.
2. **R11 as written** (material, role, shape, orientation) with the role set reduced to the coarse categories.
3. **Category derived from material** (a material's voxel use names kit/projected/liquid, R27); no category
   plane at all. Risk (inferred): one material cannot then be both wall and roof, and R14's "same diagonal
   pattern under different roles" needs a stored distinction.

Format implications: the category plane's width and palette; whether orientation is stored per voxel or
derived from the arrangement (O8); how R14 slope cases are told apart; that structure-authoring data (R30, R33)
lives outside the chunk planes so that exported voxels alone are complete (R35).

45.2–45.6 must measure: bytes per voxel and compressed size per test world with and without a category and an
orientation plane (target ~4 bytes, R11); whether the category plane collapses in uniform chunks and runs.
45.7 must show: the wall → beam/banister example built from category + material + shape alone, with an
identical result from a runtime-style edit with no structure metadata, and the category surviving codec and
save round trips. *45.6:* the placeholder rules read only the category (air included); the consumers add material
and ground density; nothing reads orientation or structure data; a house written by its generator and by runtime `fill` commands derives to the same
bytes (plan **45.6 derived data**). That supports option 1 as the minimum contract; the owner decides it at 45.7.

### Q-b. Authoritative versus derived occupancy

Requirement: voxel data is authoritative (R76); each consumer gets a derived representation from one shared
assembly evaluation (R75): render surface/detail, collision, navigation, light occupancy (with coverage, R93).
An open banister must not become an opaque full wall for collision, navigation or lighting (R77). R79's single
bitmask is provisional.

Options:
1. **Per-consumer derived planes** per chunk (collision shape ids, nav standability, light coverage per
   voxel), all emitted by the assembly pass.
2. **Full-cell bitmask plus an exception list** of resolved thin/partial cells with their per-consumer
   shape (coverage fraction, collision primitive, walkable flag).
3. **Coverage byte per voxel** (like the prop channel, R93) for light, with collision/nav from resolved
   geometry.

Format implications: the derived-data layout in 45.6 (not committed, R54; never saved, R95); whether the
solid/empty/mixed flags (R82), connectivity (R97) and sky column (R98) are computed from the authoritative
voxels or from the resolved representation (inferred: from the resolved one, or a thin rail blocks
connectivity); how prop coverage (R94) and construction coverage combine in one light channel.

45.2–45.6 must measure: bytes per chunk and build time of each option on the town world; how often cells are
"partial" in practice. *45.6:* option 1 built (per-consumer outputs from one evaluation; light as bits plus a
partial list, which is option 2's shape for light only); measured in the plan's **45.6 derived data**; beams and
rails are 5.7 % of the town's construction cells. 45.7 must show: the same banister cell giving an open collision/nav/light result while
an adjacent wall cell gives a full one, both from one assembly evaluation.

### Q-c. Edit dependency radius and invalidation

Requirement: job inputs, neighbour-data requests and invalidation carry the assembly rules' dependency radius
R; all affected results are rebuilt, across chunk boundaries (supersedes R83). The 2024 Enshrouded source
says some rules inspect two voxels away (§7a research), so R ≥ 2 voxels is the working floor (inferred
floor; the full rule catalogue in 46b sets the final value).

Options:
1. **R in the job contract**: apron strips (R69) of width R per face/edge/corner; invalidation marks every
   chunk whose region within R of the edited voxels is non-empty.
2. **Two-stage**: an assembly pass over the edited box expanded by R writes resolved results per chunk, then
   per-chunk meshing; invalidation per stage.
3. **R per rule family**, with the job carrying the maximum of the families present in the chunk.

Format implications: apron width is a parameter of the job/transfer format, not a constant baked into
codecs; chunk size choice (O1) interacts with R (a larger chunk has fewer boundary rebuilds); the HLOD
ancestor marking (R85) and lighting/occupancy invalidation (R96) use the same dirty set; the version of the
rule catalogue is part of a derived result's key (inferred, R34).

45.2–45.6 must measure: apron bytes and transfer time for R = 1, 2, 4 at 16³ and 32³; number of chunks
re-built per stroke at chunk corners. *45.6:* option 1 with the consumers' reach added (apron = R + 1); results
record the rules' id, version and radius; corner and reach tests in the plan's **45.6 derived data**. The final R
stays 46b's (its catalogue). 45.7 must show: an edit at a chunk boundary (and corner) changes a
beam/banister in the neighbouring chunk and every dependent result (mesh, collision, nav, light, mip) is
rebuilt, none stale.

## 3. Open questions the phase must answer

| Id | Question | Bound to | Decided by |
|---|---|---|---|
| O1 | Chunk 16³ vs 32³ (interacts with R, apron cost, HLOD level 0 = 16 m) | R22, Q-c | 45.2 |
| O2 | Vertical bounds and their placement (world base, headroom; 2 km benchmark = 4,000 cells) | R49 | 45.2/45.3 |
| O3 | Full-height region columns vs vertically stacked region containers (file size, write amplification) | R50 | 45.3 |
| O4 | 256 m vs 512 m tiles (commit size, file count) | R48 | 45.3 |
| O5 | zstd vs lz4 vs browser-native deflate; JS/WASM decoder cost in a worker; export scan | R20, R70 | 45.2 |
| O6 | Bits per voxel achieved vs the ~4-byte target, per world type | R11 | 45.2 |
| O7 | Column RLE vs palette-only vs SVO-like bricks | R16–R18 | 45.2 |
| O8 | Orientation: stored per voxel or derivable from arrangement / structure grid | R11, Q-a | 45.2, 45.7 |
| O9 | Per-structure local grids on disk: structure objects with transform + own chunk set; where they live (in the tile of the foundation? own file?) and how they stream | R36–R39 | 45.3, 45.5 |
| O10 | Structure override deltas: stored as per-chunk voxel deltas over the generated voxels, in the project (not the region file?) | R33, R34 | 45.4 |
| O11 | Lighting-occupancy channel: memory form only, never saved; recompute cost at chunk load | R93–R95 | 45.6 |
| O12 | Material id width and id space without a per-project cap; stability across material variants | R7, R27 | 45.2 |
| O13 | Save diff format: changed chunks vs per-voxel deltas; base-chunk hash algorithm and what it covers | R59, R60 | 45.4 |
| O14 | Floating origin and 10 km coordinates: integer chunk keys range, world-scoped key layout, precision test far out | R5, R62, R63 | 45.5 |
| O15 | Liquids: role + fill on the shared density field; how a shoreline cell holds both ground and liquid | R24–R26 | 45.2 (format), 49 |
| O16 | Where paint overlay weights are stored (voxel plane, per-surface data, or structure/material data) — not stated in the plan | R92 | 45.1/45.2 (flag to owner) |
| O17 | Git determinism: canonical chunk order, palette order, codec settings fixed; LFS threshold | R51, R53 | 45.3 |
| O18 | Liquid simulation state in saves (sleeping/settled flags) beyond the voxel diff | R61 | 49 (format leaves room, inferred) |
| O19 | Persisted light bake per tile (R104) vs "derived never committed" (R54): exported artefact or rebuilt | R54, R104 | 46d |
| O20 | Stored category schema (Q-a) and the role spec boundary: what the format stores vs what 46b's catalogue derives | Q-a, R12 | 45.7 → owner |

## 4. Proposals not treated as requirements

Recorded so they are not mistaken for specs (§7a): surface subdivision/displacement levels (R88/R89 prototype);
Kit Designer in art-factory; construction-specific painted atlases and sculpt bakes; 2 × 2 variation sections
(unit unconfirmed; not a chunk-size proposal); macro noise, hashed piece variants, per-run jitter, hex-tile
sampling (§1d "for now"); material-driven terrain dressing (R71, deferred); solid-material physics block (§8);
the brick ray-marched far field (§2, measured in 46c).

## 5. Traceability (skeleton)

Evidence cells are filled by the item that decides them; empty means not yet decided.

| Requirement | Format field / rule | Decided by | Evidence |
|---|---|---|---|
| R3, R5 | Chunk codec header: magic, version, checksum, world-scoped key; add-only upgrade steps | 45.2 | 45.2a/45.2b (plan decision log): codec v1 DRAFT header: magic `VC`, version, flags, CRC-32 of the body; the world-scoped key goes in 45.3's region table. 45.7d (plan **45.7d format gaps**): add-only upgrade registries for the codec (`CHUNK_CODEC_UPGRADES`) and the region file (`REGION_UPGRADES`, index lifted, chunks read by range as stored), newer versions refused, proved with test-only version-0 steps; every reader checks the tile it expects (world id, grid id, layout, edge, footprint, region) and saves their world id (`format-rules.test.ts`, `edits.test.ts`) |
| R4 | Damaged-chunk repair/regenerate path; missing tiles | 45.3/45.4 | 45.3 (plan **45.3 region files**): detection and reporting: header and table CRC-32 refuse the file; each stored chunk's CRC-32 in its table entry marks it `damaged` with its coordinates (`RegionChunkError`), never read as air; tested on a flipped byte. Repair/regenerate path: 45.4 (plan **45.4 edits, undo, saves**, DRAFT): `repairChunks` takes the first source with a sound copy (shipped world, last commit, regeneration), the chunk is then dirty until saved; unrepaired chunks stay unloaded, edits into them are refused and rewrites carry their bytes and CRC verbatim (`RegionIndex.entry`); tested on real files. 45.7d: the world manifest lists its region files; a listed file that is missing or unreadable is damaged (route 409, chunks reported, edits refused), an unlisted region is air (`voxel-world.test.ts` through the real route) |
| R9, R22, O1 | Chunk edge length (cells), voxel size constant (defined once) | 45.2 | 45.2b (plan **45.2b bricks, codecs and the 45.2 pick**, DRAFT): 32³; 16³ re-meshes 3–5× fewer cells per edit but has 7.5× the chunks, 1.2–3.2× the zstd bytes, 95 % vs 42 % apron at R = 2 and, with bricks, 0.8–0.92× the memory. Harness (45.1b, `tools/voxel-bench`; numbers in the plan's 45.1 harness baseline): `VOXEL_SIZE_M` and `chunkGrid(16 \| 32)` in `@thirdlight/voxel`, every world swept at both edges |
| R11, Q-a, O6, O8 | Voxel planes: material, category, shape/density, orientation; widths | 45.2 | 45.2b: bricks in memory 0.04–0.27 B a voxel (O6). 45.2a (plan **45.2a palette candidates**): in a record palette the category plane costs 0 % memory and 0.2–2.9 % zstd, orientation ≤ 5 % / 3.2 % (town); as separate plane palettes category costs 6–31 %; 0.10–0.47 B a voxel in memory (O6). Harness (45.1b, `tools/voxel-bench`; numbers in the plan's 45.1 harness baseline): zstd size per world with and without the category and orientation planes; `VoxelRecord` is a PROVISIONAL test shape, not the format |
| R15–R20, O5, O7 | Encoding: palette, bit width, uniform collapse, column runs, surface-only density, codec | 45.2 | 45.2b (DRAFT pick): sparse 4³ bricks in memory (0.3–0.6× P's memory), bit-packed body + zstd 3 per chunk at rest, fzstd in workers (4–53 µs a chunk); lz4, per-chunk deflate (DecompressionStream 160–190 µs a chunk), a zstd dictionary and the bricks body at rest lose; runs lose under lz4 too (O5, O7). 45.2a (plan **45.2a palette candidates**, decision log): record palette, ids at 0/1/2/4/8/16 bits, uniform chunk = one number, density only on surface voxels, codec v1 DRAFT (header, CRC-32, planes apart, canonical bytes); column runs lose in memory and after zstd (R18 replacement proposed); 45.2b: bricks, lz4, browser decode, pick. Harness (45.1b, `tools/voxel-bench`; numbers in the plan's 45.1 harness baseline): raw / zstd / deflate per chunk, uniform-chunk share, materials-per-chunk histogram, material runs per chunk column, surface-cell share; lz4 not measured (needs a dependency) |
| R21 | `voxelAt` contract and special forms behind it | 45.2 | 45.2a: uniform chunks answer from the index entry, palette chunks from one packed read; one shared chunk index. Harness (45.1b, `tools/voxel-bench`; numbers in the plan's 45.1 harness baseline): `VoxelStoreCandidate` is the one contract a candidate is driven through, checked cell by cell against the dense reference store |
| R24–R26, O15 | Liquid category + fill on density field; shoreline rule | 45.2 | 45.2a: a liquid's partly full top cell is a surface voxel (density byte); full liquid below stores none; round trip checked; O15 still open. Harness (45.1b, `tools/voxel-bench`; numbers in the plan's 45.1 harness baseline): test worlds hold liquid with a partly filled top cell (hilly lakes, town ponds, cave water); shoreline cells stay ground, O15 still open |
| R27, R28, O12 | Material id space and reference to the material record | 45.2 | 45.7d (default chosen, owner to confirm; plan **45.7d format gaps**): material ids are 23 bits of the 32-bit record value (0 air, 1–8,388,607 a world, `MATERIAL_ID_MAX`), u24 at rest: a format width, no count cap (R7), measured +0.1–1.8 % zstd at rest over u16 and nothing per cell or in memory; a full u32 field measured at the same rest cost but +29 % per delta cell and 2× per apron cell. The reference to the material record is 46c's ([spec](voxel-format-spec.md) §2.2, §7 G7) |
| R30–R35, O10 | Structure records, override deltas, regenerate-all report | 45.4 | 45.4 (DRAFT): `TLVO` v1 overrides per chunk of the structure grid (cell, generated voxel, voxel now; 12 B a cell), kept with the structure record, never in region files or exports (R35); after regenerating: absorbed / kept (same kind as its base) / misfit reported (R33, R34); tested on a grown test room. Structure records themselves: 47a |
| R36–R39, O9 | Structure grid object: transform, own chunk set, storage location | 45.3/45.5 | 45.3 (DRAFT): a structure grid's chunks are region files of their own (grid id in the header, local region coordinates, a folder per grid id), round trip tested; the transform lives in the structure record (47a), not the voxel file; proposal: anchor a local grid at its foundation's minimum corner (test houses split into 4 files of ~200 B each). Streaming: 45.5 |
| R46–R53, O2–O4, O17 | Region file: tile size, vertical layout, header, per-chunk offsets, deterministic bytes, LFS | 45.3 | 45.3 (plan **45.3 region files**, DRAFT): `region-file.ts` v1 (64-byte header with world id, grid id, region x/y/z, CRCs; sorted 12-byte entries; uniform chunks inline; offsets from lengths; canonical, byte-identical for equal content in any edit order). O4: 256 m kept (512 m: same bytes, 4× rewrite per save, 3× loose git growth). O3: columns rewrite 12.3 MB per save on a 2 km tile; stacked 256 m cubes proposed (R1). O2: no world base in the format, ±8,192 cells. O17/R53: git +0.13–0.22 MB/h after gc, no LFS. R52: HTTP range reads 0.41 ms a chunk, 3×3×3 in 3 requests (4 KB gap). R55: 10 km ≈ 430–580 MB. Earlier harness (45.1b, `tools/voxel-bench`; numbers in the plan's 45.1 harness baseline): region key math for 256 m and 512 m footprints; a 4,000-cell-tall test world (R49) |
| R56, R57 | Stroke command payloads; per-chunk undo records and size | 45.4 | 45.4 (plan **45.4 edits, undo, saves**, DRAFT): command v1 (brush with dabs, fill, stamp by shape hash, set, dig; canonical JSON; one deterministic apply for editor, MCP and runtime, R6, R58); undo per changed chunk = cell delta (7 B a cell) or before-image, `TLVU` v1, 64 MiB memory budget spilling to disk (R7). Measured: 22 B a voxel, 1.5 KB a 4 m dab, 45–60 KB a 16 m fill; apply 3–102 µs for dabs, ~5 ms a 16 m fill |
| R59, R60, O13 | Save diff: changed chunks vs base, base-chunk hashes, save version | 45.4 | 45.4 (DRAFT), 45.8a: `TLVS` v1: changed chunks only, each a cell delta or the whole chunk plus a changed-cell mask (smaller), so a kept save lands only the player's cells on a re-exported base; 16-byte SHA-256 of the base chunk's content in the frozen base form (codec v1 canonical bytes); record value form byte; one zstd stream, CRCs, canonical bytes; newer version refused, older lifted by append-only steps (R3); base mismatch reported, the game picks save or base per chunk. Measured: 303–497 KB after 1,000 heavy strokes, write 8–11 ms, read 14–19 ms, hash 61–69 µs a chunk |
| R62–R66, O14 | Coordinates, floating origin, memory budget per tier, export chunk delivery | 45.5 | 45.5a (plan **45.5a streaming core**, DRAFT): `FloatingOrigin` re-bases past 1,000 m per axis, snapped to the grid's chunk edge (16 m at 32³; 45.7d), listeners shift 32-bit positions; < 0.1 mm at 9.9 km and ±2 km vs 0.49 mm absolute (vitest); one byte budget per tier (`VOXEL_STREAM_BUDGET_BYTES`, chunks + derived parts + tables, no count), farthest clean first, dirty never evicted; `RegionChunkSource` reads chunks by coalesced ranges from any byte source (R66's export delivery path); 45.5b (plan **45.5b browser streaming**): Chrome, Iris Xe, 720p at the 60 Hz cap, HTTP Range, 4 module workers, both renderers: frame p95 16.67 ms, 0 near holes at 40/80 m/s, ring 9–10 MB of 256 MiB; +40 ms latency empties the near ring (D432, R66 replacement proposed in the spec §1); Node flight 2 × 2 km: 0 near holes at 80 m/s, 9 MB ring; harness (45.1b, `tools/voxel-bench`; numbers in the plan's 45.1 harness baseline): integer cell bounds ±32,768 (x, z) and ±8,192 (y) with chunk keys below 2^35, tested at the extremes (default, owner to confirm); floating origin not touched |
| R67–R70, Q-c | Job id, priority, dirty state, apron width R, transfer buffers | 45.5 | 45.5a (DRAFT): job contract v1 (tracker ids, load/apply-save/edit/derive, lanes edit > near > far by distance, input stamps refuse results after an edit, reload or neighbour change within R), R per job with 26 apron strips (13 KB median at R = 2 vs 69 KB dense), `dependentChunks` (corner 8, spanning box 27), chunks moved as their memory arrays (transferred, adopted with no per-cell pass), real worker_threads workers running the browser's worker module, which passes the export scan; 45.2b (edge costs, `run.mjs costs`): apron at R = 1/2/4 is 20/42/95 % of a 32³ chunk, 42/95/238 % of 16³; a stroke with R = 2 rebuilds 1.7–4.3 chunks at 32³, 2.6–11.4 at 16³; 45.4 (DRAFT): `DirtyTracker` per-chunk versions, save jobs with ids committing only their snapshot, one job per file, late commits of expired jobs refused, unload guard, version-checked chunk-job results; atomic replace via the workspace's durable write; races tested on real files with simulated workers; real workers in 45.5a/45.5b (`stream.test.ts`, browser page); 45.6: apron = rules' radius + 1, results carry rules id/version/radius ([spec](voxel-format-spec.md) §3.6, §3.7); harness (45.1b, `tools/voxel-bench`; numbers in the plan's 45.1 harness baseline): copy vs transfer round trip of raw and zstd chunk bytes in a real worker; `@thirdlight/voxel` is pure (no three.js, no Node built-ins, boundary rule) for R70 |
| R54, R72–R105, Q-b | Derived formats: resolved assembly output, per-consumer occupancy, flags, mips, mesh buffers, collision/nav inputs | 45.6 | 45.6 (plan **45.6 derived data**, DRAFT): one versioned assembly evaluation (`AssemblyRuleSet` id/version/radius; placeholder rules R 2: beam, rail, post, wall) per derive job, classes never stored; per-consumer outputs from it: render occupancy (chunk flag, 2-bit brick flags, bits when mixed; R82), light (bits + partial list, 0.5–4.3 KB a chunk vs 3.5–19 KB dense), collision boxes in 1/16 cell + ground trimesh (R105; town 183 B a chunk), nav blocking bits + standable cells with clearance (R100), ground and base surface buffers (20-byte vertices, crack-free boundary rule; R72, R91), detail instances with `replacesBase` (R75, §7a); voxel mips with the chunk's form and stale ancestors (R84, R85); 45.7d: solid/empty/mixed flags per chunk-tree node (`ChunkTreeFlags`, stale on change, `derived.test.ts`; R82); derive p50 0.5–3.4 ms a chunk (Node); R79 replaced (for the owner); never committed or saved (R54); connectivity (R97), sky column (R98) and 6-connected rays (R99) not built (46d) |
| R93–R96, O11 | Light-occupancy channel (coverage), never saved, recompute at load | 45.6 | 45.6 (DRAFT): `propCoverageChunk` rebuilds a chunk's channel from the prop list (4³ samples a host cell, inverse yaw and scale; a 3 m canopy 675 µs, a crate 100 µs), overlaps 1 − (1 − a)(1 − b), joined with the construction's derived light coverage (`lightCoverage`); memory only, in no codec or file (O11: recompute at load); re-stamping a mover is a rebuild of the chunks it overlaps, which the dirty set (R96) names |
| Q-a, Q-b, Q-c | Wall → beam/banister proof, round trips, runtime-equivalent input, cross-chunk invalidation | 45.7 | contract in [spec](voxel-format-spec.md) §2.2 (Q-a minimum: category + material + shape) and §3.7 (Q-b, Q-c), 45.6 evidence (`derived.test.ts`); 45.7a/45.7b and the 45.9 acceptance on staging, both renderers: banister ↔ wall ↔ beam per consumer, 0 stale, 1–4 chunks re-derived, round trips and runtime-equivalent input give equal hashes and byte-identical files ([spec](voxel-format-spec.md) §6) |
| R1, R2 | Failed decisions with replacements; owner approval of format spec v1 | 45.7 → owner | format spec v1 DRAFT ([spec](voxel-format-spec.md)): §1 lists the decisions that did not pan out with their replacements (R18 → packing + zstd, R50 → stacked 256 m cubes, R79 → per-consumer outputs from one assembly evaluation, R66 read defaults → batched/wider reads, D432), §5 the 33 defaults to confirm, §7 code/plan gaps; owner approval pending (hard stop) |
