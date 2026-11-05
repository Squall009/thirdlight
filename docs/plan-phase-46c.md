# Phase 46c — Kits and cases

Status: **46c: owner reviewed the drafts 2026-11-04 and changed the approach (decision log, owner 2026-11-04): a 46c revision (§6b, items R1–R9) redoes the case catalogue (edges only), adds a roof mesher and debris from integrity, and re-presents. Nothing builds on the old drafts.** on branch `phase-45` (worktree `~/projects/thirdlight-p45`;
main frozen at d4053cab). Planned from `docs/plan-phase-45.md` §4 (46c) as revised by §7a (the kit and surface
session, which takes precedence) and the owner decisions of 2026-11-02 (§7: the ten stored roles, beams, banisters
and soffits inferred; R112: no trim sheet for terrain or construction voxels), with §1 (roles, kits per material
type, rule matching, fallbacks, kit check and test scene, foundation skirts, the role spec), §1d (layout and tiling)
and §5b (placeholder kit art), against format spec v1 (APPROVED, `docs/architecture/voxel-format-spec.md`) and the
46a/46b as-built. The baseline below is re-read from 46b's close (46b.13) at the start; where it differs, it wins.

## 1. Scope

**The case pass and the kits that fill it.** Stored voxels carry only material, role, shape and wetness (spec §2.2);
everything architectural beyond the role is read from the arrangement (§7a, O20 settled). 46c builds:
- **The case pass:** per detail-bearing cell, a neighbourhood case (roles and fill classes within two cells, the
  reach the Enshrouded reference describes, §7a research), folded over yaw turns and mirrors, matched by rules with
  priorities and wildcards to a canonical case, with a **mandatory fallback** per role; one `AssemblyRuleSet` (the
  shared evaluation, R75) composed with 46b's terrain rules, radius declared and passing `ruleRadiusMismatches`.
- **Merge-compatible sections (R86 → §7a):** runs built from body, junction, corner and termination sections, never
  hand-made run lengths; beams, banisters, soffits, ceiling mouldings and running boards **inferred** from the
  arrangement (the 45.7b wall → beam → banister proof is the seed). Whether runs draw as instanced sections or a
  merged cache is measured, not an artist obligation.
- **Base surfaces resolved first (R75, R77):** per case the voxel base surface is kept, suppressed or reshaped;
  collision, navigation and light occupancy follow the resolved case (an open rail is not a wall).
- **Authored high and low pieces, then voxel fallback (R90):** 46b.9's per-level hooks (L0 high, L1 low, L2+ none,
  the cell meshed from its mip shape) filled by kit pieces.
- **Kit data:** a kit belongs to a material *type* (§1); pieces per case and level, join profiles, variants, and
  default break/sound/physics data as **opaque game data** (no engine behaviour); add-only, versioned, unknown
  version refused. A default fallback kit (engine-owned, procedural) so any world draws without a game kit.
- **Kit check** in Problems and a **generated kit test scene** (every canonical case laid out, labelled).
- **The two owner hard-stop drafts:** role spec v1 (`docs/architecture/voxel-role-spec.md`) and the trim layout spec
  for **detail pieces only** (`docs/architecture/voxel-trim-layout.md`, R112), prototyped on two placeholder kits
  (log, stone) and presented. Trim sheets are optional per kit (§7a); base construction and terrain never use trim.
- **The §7a "what to prove" list** on staging, both renderers, measured.

**Not in 46c:** the material model, texture arrays and slot residency, wall/floor/ceiling tileable surfaces, kit
instancing with GPU culling, HLOD and the far field (46d: 46c draws pieces with stand-in materials and a labelled
debug UV texture); surface subdivision/displacement (46d prototype, §7a); lighting, connectivity culling and the walk
graph (46e; 46c only keeps the light/nav inputs agreeing with the case); structure objects, rotated grids, standard
openings with door/window props placed into them (47a: 46c resolves an opening's frame case only); brushes, role
painting, pillar/terrace options and stamps (47b); 2 × 2 variation sections (optional research, §7a); material-driven
dressing (deferred, §7a). **Kit Designer** is an art-factory proposal (§7a) and is never built from this repo; the
engine owns the contract, catalogue and validation it would consume. Game repos and art-factory are not edited. The
existing block kits, connect rules and trim sheets (`project-model` `kits.ts`, `block-connect.ts`, `kit-checks.ts`,
`trim-sheet.ts`) stay untouched (48 retires them); ideas may be read, code is imported or moved to
`@thirdlight/shared` in its own commit, never copied.

## 2. OWNER HARD STOP

Two specs are owner hard stops (§1, owner 2026-10-28; R112 narrowed the second on 2026-11-02):
1. **Role spec v1**: per stored role (air, terrain, liquid, wall, floor, roof, foundation, stair, pillar, opening)
   the complete canonical case list (rotations and mirrors folded), each with a diagram, required / optional /
   fallback, and the neighbour roles that change the choice; the inferred features (beam, banister, soffit,
   moulding, running board, foundation skirt) as cases, not roles.
2. **Trim layout spec, detail pieces only**: texel density, field, strips, caps, optional per kit, and the
   alternative (a piece's own sculpt bakes plus the material arrays, §7a).

Both are **drafted, prototyped on the two placeholder kits (log, stone) and presented on review page acc46c** with
exactly what the owner must approve (46c.15). **The run STOPS there.** Until the owner approves each one, nothing
builds on it as final: not the kit pipeline as final, not the authoring package (spec sheets, Blender templates, the
manual's kit guide), not an art-factory request for graphs or templates. The drafts carry `DRAFT — not v1` in their
title. After approval: 46c.16–46c.18 (§6). Work that does not depend on the specs may continue meanwhile.

## 3. three.js check

Checked 2026-11-04 at the 46c start: three 0.187.0 (released 2026-10-30) is still the newest on npm. No newer
release, so nothing to assess against `docs/three-upgrade-checklist.md`; no update (owner-only).

## 4. Baseline (re-read at 46b.13; the numbers 46c reports against)

| What | Number | Source |
|---|---|---|
| Rule evaluation µs a 16³ section p50 (Node) | placeholder 38–45; terrain rules 92–116 | 46b.2 |
| Evaluate + mesh µs a 16³ section p50 | slice 217, town 207, caves 307 | 46b.3b |
| Town triangles (32³, terrain rules) | 1.62 M (base 0.30 M after merges) | 46b.5 |
| render() CPU slice / town; triangles drawn | 1.4–1.5 / 3.0–3.2 ms; 0.31 / 0.80 M | 46b.8b |
| Detail pieces | placeholder families beam/rail/post, stand-in boxes grouped by family; per level per 46b.9 | 46b.8b, 46b.9 |
| Instance format | 8 B: cell, turn + flags (`replacesBase`), piece = family << 2 \| section, u16 reserved 0 | spec §3.7 |
| Job apron | R + 1 = 3 (terrain rules R 2) | spec §3.7 |
| `tests/e2e/voxel-world.e2e.ts` | 47.9 s at 46b start (re-read at 46b.13) | brief |
| Open D-rows touching 46c | D465 (roofless houses at L1: thin shells and pieces per level) | 46b.8b |

## 5. Where things live

- `@thirdlight/voxel`: `assembly.ts` (`AssemblyRuleSet`, class byte bits 0–5, `PLACEHOLDER_RULES` v2 R 2),
  `terrain-rules.ts` (`withTerrainFeatures` composes construction + ground features into one set),
  `rule-registry.ts` (`WORLD_RULES`, `registerAssemblyRules`), `rule-conformance.ts`, `derived-mesh.ts`
  (`detailInstances`, `PIECE_FAMILY`, `PIECE_SECTION`, `INSTANCE_FLAG`), `base-surface.ts` ("46c replaces the
  producer"), `derive-assembly.ts`, `derived-collision.ts`, `mip-derive.ts`; new: `kit-cases.ts` (catalogue,
  extraction, matcher), `kit-format.ts` (kit data), `kit-rules.ts` (the registered set), `kit-check.ts`.
- three-adapter `voxel-chunk-view.ts` (`addPieces`: stand-in boxes by family, scaled by level).
- Seeds to read, not copy: `project-model` `block-connect.ts` (end/straight/corner/t/cross, base/cap from
  neighbours), `kit-checks.ts` (piece origin, cell sizing, LOD naming, check rows ok/warn/err/info), docs
  `manual/guides/trim-sheet-spec.md` (today's layout and checklist); 45.7b probes (`probes.ts`: `cellAt`,
  `cellOutputs`, `staleAgainstFresh`).

## 6. Items

Order inside an item per AGENTS.md: schema/commands → runtime/adapter → editor → tests → docs. One agent an item,
~1–2 h, fast gate green. Browser checks extend `tests/e2e/voxel-world.e2e.ts` only (no new e2e file); everything
else is vitest at real boundaries (real derive, real workers, region files on disk, real Rapier, real GLB bytes).
Perf: Iris Xe, 1280×720, 60 Hz cap, both renderers, ≤ 3 rounds, `uptime` recorded. Every placeholder piece is a
game-ready asset: triangles per level, texture sizes and file size reported (owner's standing rule).

| Item | Builds | Tested at | Measures | Done when / closes |
|---|---|---|---|---|
| 46c.1 | **Kit data format (schema):** `kit-format.ts`: kit {id, version, materialType, pieces[case][section] {high, low, variants with weights}, join profiles (section end outlines in 1/16 cell), opaque `gameData` per kit and per case (JSON, passed through), optional trim layout ref}; canonical form field by field, add-only, `kitFormat` 1, unknown refused; a world's material id → kit binding (test binding until 46d's material model owns it). | vitest (round trip, unknown fields dropped by the canonicalizer are tested present, unknown version refused) | bytes a kit | format and binding in the spec draft |
| 46c.2 *(superseded by the 2026-11-04 revision, §6b)* | **Case catalogue + extraction + matcher (pure):** `kit-cases.ts`: a detail-bearing cell's case key from roles and fill classes (open / built / ground / same-material) within reach 2, folded over 4 yaw turns and the vertical mirror (no vertical flip); rules {pattern with wildcards and role sets, priority, case id}, first match by priority, a fallback per role mandatory (catalogue refused without it); the draft catalogue per role. | vitest: every key maps to exactly one case; fold invariance under turns/mirrors; priorities and wildcards on hand cases; no cell unmatched on random worlds | keys seen, µs a 16³ section | catalogue complete for its roles |
| 46c.3 | **The registered rule set:** `kit-rules.ts` composes the case pass with the terrain rules into one `AssemblyRuleSet` (`kits` v1, radius the larger, apron stays 3 if R ≤ 2); case ids live only in the job (a u16 a cell beside the class byte); `WORLD_RULES` switches with a derived version step and owner note. | `derived.test.ts`: conformance on random assembly + terrain worlds at 16/32 and at chunk/section edges; joined sections = whole chunk | eval µs a section vs §4 | conformance passes, budget met or the miss's cause recorded |
| 46c.4 *(partly superseded by the 2026-11-04 revision, §6b)* | **Merge-compatible run sections:** runs of beams, banisters, soffits, mouldings, running boards (and foundation skirts where a foundation meets terrain) with body / junction / corner / termination sections, read across chunk faces within the reach; the 45.7b neighbours (wall ↔ beam ↔ banister) as the seed cases. | `derived.test.ts`: section per cell on hand runs incl. across chunk faces; adding/removing a neighbour changes only cells within R | sections a run, µs | 45.7b proof passes with the new sections |
| 46c.5 *(partly superseded by the 2026-11-04 revision, §6b)* | **Base and consumers from the case:** per case keep / suppress / reshape the base surface; collision, nav and light from the case's declared coarse shape (box, slab, bar, none), never from piece meshes (R77). | `collision.test.ts` (real Rapier: ball through a banister's gaps, capsule on a beam), nav/light outputs per case | bytes, boxes a chunk | an open rail is open for every consumer |
| 46c.6 | **Instances carry kit pieces; high/low filled:** instance u16 piece = kit-local piece index, reserved u16 = variant (hash of the world cell, stable under unrelated edits) — still 8 B, derived version step with owner note; 46b.9 hooks get the kit's high at L0, low at L1, none from L2; D465 rechecked with low pieces. | `derived.test.ts` (variant stable after dig/rebuild elsewhere; per-level lists); `stream.test.ts` (real workers) | instances a chunk per level | hooks filled; D465 closed or re-recorded |
| 46c.6b | **Fix (lead): the feeds rule with kits bound:** wetness never re-derives meshes or instances; a material paint only where a cell changes kit (old material's kit ≠ new's); within a kit shader data only; variant hash from cell + kit seed only. | `stream.test.ts` (real workers), `kit-pieces.test.ts` | derives per paint | owner rule kept; the cross-kit exception logged |
| 46c.7 *(partly superseded by the 2026-11-04 revision, §6b)* | **Pieces drawn (adapter + hosts):** GLB pieces through the content closure (no URL), one instanced draw per (kit piece, level) a chunk, section ends meeting by join profile; stand-in material + labelled debug UV texture; page, Play, Scene view. Default fallback kit (procedural, engine-owned) covers every case. | e2e `voxel-world.e2e.ts` (one test extended: kit pieces drawn, a banister → wall edit swaps pieces, `png.ts` reads); export served statically, backend stopped | render() CPU, draws, instances | both renderers draw kits |
| 46c.8 *(partly superseded by the 2026-11-04 revision, §6b)* | **Kit check + kit test scene:** `kit-check.ts` rows (ok/warn/err/info): every required case present, fallback present, high/low pairs, pivots and cell sizes, join profiles matching at section ends, triangle and texture budgets reported, trim conformance only for kits that opt in; backend Problems; a command writes the generated test scene (every case in a labelled grid) into a staging world. | vitest (bad kits fail each row), e2e (Problems shows a broken kit; test scene opens) | check ms a kit | check green on both placeholder kits |
| 46c.9 *(superseded by the 2026-11-04 revision, §6b)* | **Two placeholder kits (log, stone):** produced through the Blender pipeline on this host (`/usr/local/bin/blender`, the blender-pipeline skill; the lead confirms at the item) else procedural meshes from a script in `tools/voxel-bench`; engine-owned test data, high + low per case, debug UVs, small GLBs with their generating script. | kit check green; GLB bytes read by the real loader | tris per piece per level, texture sizes, file sizes | both kits drawn in the test scene |
| 46c.10 *(superseded by the 2026-11-04 revision, §6b)* | **Prototype scene on staging (§7a list):** wall, beam and banister as neighbours are added/removed; openings and corners; material changes (no remesh, spec §2.2 feeds); chunk and section boundaries; a long uninterrupted surface (repetition); local dig/rebuild (variant stability); high/low in motion across the L0/L1 ring; both renderers. Rotated grids recorded as 47a's. | staging, `run.mjs slice` scene, pictures looked at | — | each item observed or "unverified" with why |
| 46c.11 *(superseded by the 2026-11-04 revision, §6b; its numbers are R6's baseline)* | **Measurement:** pieces and instances drawn per ring, case pass µs a section p50/p95 (Node + browser), blast → shown with kits, GPU ms at the cap, memory; vs §4. | `run.mjs` phases on staging | all of the above | numbers + causes recorded |
| 46c.12 *(superseded by the 2026-11-04 revision, §6b)* | **Role spec v1 DRAFT** (`docs/architecture/voxel-role-spec.md`): per role the canonical cases (required / optional / fallback, neighbour roles that change it), ASCII or SVG diagrams from the catalogue; a vitest checks the doc lists exactly the catalogue's case ids. | vitest + check-docs | — | draft complete for every role |
| 46c.13 *(superseded by the 2026-11-04 revision, §6b)* | **Trim layout DRAFT, detail pieces only** (`docs/architecture/voxel-trim-layout.md`): texel density (authored 1024 px/m, tiers cap at 256/512/1024), field, strips (0.125/0.25/0.5 m), caps, no unique regions, U from world distance along the run; optional per kit; the alternative (own sculpt bakes + material arrays, §7a); the log and stone kits as examples. | check-docs; the debug texture in the test scene | — | draft complete |
| 46c.14 *(partly superseded by the 2026-11-04 revision, §6b)* | **Docs:** spec §3.7 (case pass, kit rule set, instance meaning, derived version steps with owner notes), requirements traceability (R73–R77, R86, R87, R90, R112), manual `features/voxel-worlds.md` (kits, kit check), reference regenerated. | check-docs, `tools/manual-links.test.mjs` | — | pages match the built code |
| 46c.15 *(superseded by the 2026-11-04 revision, §6b)* | **Presentation (lead):** acceptance shots of every §7a case, both renderers; README in `~/.cache/thirdlight-phase46/acceptance/46c`; review page acc46c with both drafts and exactly what the owner must approve. **Then STOP.** | staging | — | owner has the page |
| 46c.16 | *After approval:* specs frozen as v1 (owner note), kit pipeline final, changes the owner asked for. | vitest, fast gate | — | v1 in the docs |
| 46c.17 | *After approval:* authoring package: spec sheets, Blender templates per role (UV guides, scale/pivot, high/low naming), manual guide "make a kit and a material set"; an art-factory request doc for the Texture Designer graphs (made there, not here). | check-docs | — | package complete |
| 46c.14b | *Close before the stop (lead):* full gate once (detached), independent review, High/Medium fixes (fast gates), acceptance shots → acc46c. | full gate | gate time and peak; voxel e2e time | review in the decision log |
| 46c.14c | **Review fixes (before the stop):** the 46c review's Mediums M1–M5 and its code Lows (M6, the two drafts, by a docs agent beside it); what is not small gets a D-row. | vitest, integration (backend + export), fast gate | town stream total on staging | Mediums fixed; Lows fixed or D-rows |
| 46c.18 | *After approval (lead):* rows closed, STATUS; then 46d on the owner's word. | — | — | — |

## 6b. Revision items (owner 2026-11-04)

The owner reviewed acc46c on 2026-11-04 and changed the approach (decision log, the three OWNER 2026-11-04 entries;
memory note "detail pieces = edges only"; the reference images at the main repo root and the build menu
`sbpuwkoh6s0h1.png`: 1 m / 2 m / 4 m blocks, 2 m / 4 m stair-step roofs). The items of §6 marked superseded stay as
history; their code is replaced or retired by the items below. Same rules as §6: one agent an item, ~1–2 h, fast gate
green, browser checks only in `tests/e2e/voxel-world.e2e.ts`, everything else vitest at real boundaries, perf at the
60 Hz cap on the Iris Xe, both renderers, ≤ 3 rounds, `uptime` recorded, every placeholder piece reported as a
game-ready asset (triangles per level, LODs, texture sizes, file size). Progress rows R1–R9 are in §7.

**The model in one paragraph.** Walls, floors, stairs, pillars, foundations and flat roofs are plain voxel faces: the
base surface keeps every flat face, and no piece is ever placed on one. Detail pieces go only where faces meet: per
0.5 m lattice edge and per lattice corner, classified by local rules from the cells around it, each its own instance
(no merged run geometry), with a small hashed stagger; one mesh serves several cases rotated. Sloped roofs get their
own mesher (flat 45° planes over the stair-step roof voxels, a tileable material) with pieces only along its ridge,
eave, gable edge, hip and valley. A construction cell's shape is its **integrity**: shape < 15 draws the cell as
debris and the neighbour faces opening toward it as broken faces; collision and light keep the voxel until it is air.
Far = flat square voxels (pieces high at L0, low at L1, none from L2, as 46b.9). Beams and banisters stay as built.
Ground contact fringe and scatter are 47b's terrain material rules; relief, the material model and texture sets 46d's.

**Edge case list (draft, extend only if needed).** A lattice edge has 4 cells round it, a lattice corner 8; "solid"
= any built role or terrain (opening, air, liquid = open). A piece only where at least one construction cell and no
terrain cell touch the edge (construction ↔ terrain contact is 47b's), and no roof-plane cell (R2 owns those):
| Case | Where | Orientation |
|---|---|---|
| `edge-out-top` | 1 of 4 solid, the solid cell below the edge (a wall's top edge, a stair nosing, a floor's edge) | yaw 4 |
| `edge-out-vertical` | 1 of 4 solid, a vertical edge (an outside wall corner, a jamb's edge) | yaw 4 |
| `edge-out-bottom` | 1 of 4 solid, the solid cell above (a lintel's or overhang's underside edge) | yaw 4 |
| `edge-in-top` | 3 of 4 solid, open cell below (wall meets ceiling) | yaw 4 |
| `edge-in-vertical` | 3 of 4 solid, vertical (an inside wall corner) | yaw 4 |
| `edge-in-bottom` | 3 of 4 solid, open cell above (wall meets floor, a stair's riser foot) | yaw 4 |
| `corner-out-top` / `corner-out-bottom` | 1 of 8 solid round a lattice corner (a box corner) | yaw 4 |
| `corner-in-top` / `corner-in-bottom` | 7 of 8 solid | yaw 4 |

2 of 4 solid side by side is a flat face (no piece); 2 diagonal is two outer edges (two pieces, one a cell). Mixed
corners (outer and inner edges meeting) get no corner piece: the edges overlap. Roof (R2): `roof-ridge`, `roof-eave`,
`roof-gable` (verge), `roof-hip`, `roof-valley`. Damage (R3): `debris` (a cell with shape < 15, stage by shape band)
and `debris-face` (an intact neighbour's face toward it). Kept as built: `beam`, `banister-rail`, `banister-post`
with their run sections. 10 edge + 5 roof + 2 debris + 3 kept = 20 cases (46 before), many drawn by one mesh rotated.

| Item | Builds | Tested at | Measures | Done when / closes |
|---|---|---|---|---|
| R1 | **Edge catalogue + matcher + integrity (pure, `@thirdlight/voxel`):** `edge-cases.ts`: per section the exposed lattice edges and corners of construction cells, classified by the table above from the 4 / 8 cells round each (a bitmask a cell: 12 edges + 8 corners, then case + yaw), the owning cell and material (outer: the one solid cell; inner: the cell diagonal to the open one; ties by role priority, then the lower material id); `kit-case-catalogue.ts` rewritten to the 20 cases (the window/fold/priority machinery of `kit-cases.ts` kept for beam/banister only, the other 43 cases and their rules removed); catalogue id `edges-draft` v0 (DRAFT). **Role-aware shape:** construction shape = integrity (15 intact), so every construction shape reader (`voxel-mips.ts` downsample, the case window's fill classes, `case-forms.ts`, collision, light, nav, base surface) treats a construction cell with shape 1–14 as whole; terrain and liquid unchanged. | vitest (new `edge-cases.test.ts` in `tools/voxel-bench`): every 4-cell / 8-cell pattern → exactly the table's case, yaw-invariant on turned hand scenes, no case on a flat face, terrain contact gives none; integrity: a wall at shape 7 collides, occludes and mips like shape 15, terrain at 7 still half full | µs a 16³ section (town, slice) vs the old case pass 256 / 508 (46c.11, D497) | catalogue + matcher pure and tested; D497 rechecked |
| R2 | **Roof mesher (derive):** `roof-mesher.ts` beside `terrain-mesher.ts`, on the derive contract (declared reach ≤ 2, conformance check): role `roof` cells read as a 45° stair (a roof neighbour one up and one across) get a slope direction; classified straight / ridge / eave / gable (open along the ridge direction) / hip (convex 90° corner of two slopes) / valley (concave) / peak; emits a top plane through the stair's outer corners and an underside plane through its inner corners, per cell polygons from a small table (straight = one quad, hip/valley = two triangles a side), coplanar cells merged along the ridge, a gable's side face as a sloped-top strip; planes stop at a non-roof built neighbour (a wall through the roof keeps its faces). Output into the base surface layout (same shader, no new vertex data); `base-surface.ts` skips the faces of cells the mesher draws. A roof cell the mesher cannot classify (non-45° steps, a one-cell spike) keeps its voxel faces (the mandatory fallback). Runs at every level (mips keep the stair). Roof-edge cases for R3 are written per cell (case + yaw). Damaged roof cells (shape < 15) are left out of the planes (a hole R3 dresses). | `derived.test.ts`/new `roof-mesher.test.ts`: gable, hip, valley and peak hand roofs: plane vertices within 1/1024 of the expected planes, watertight with the gable strips (every edge shared twice or on a declared boundary), every triangle wound out; sections joined = chunk; conformance at 16/32; a wall through a roof keeps its faces; fallback cells keep voxel faces | µs a section p50/p95 (budget 0.1–0.2 ms, 46b), town roof triangles before → after (stair faces vs planes) | gable, hip and valley roofs mesh as planes, conformance passes |
| R3 | **Pieces on edges only (derive) + debris:** detail instances from R1's edges, R2's roof edges and the kept beam/banister cases only; the base surface keeps every flat face (no case suppresses or reshapes a wall, floor or roof face any more; `suppress` stays for beam/banister, `reshape`/soffit removed). An instance = cell + case + yaw + variant word (variant hash of the world cell + edge index + kit seed; stagger comes from the same hash, R3b); several instances a cell (up to 12 edges + 8 corners). Piece table rebuilt for the 20 cases (kit-local pieces, missing case → the kit's alias → engine default → none). **Debris:** a construction cell with shape < 15 is drawn by the `debris` piece of its stage (default 2 stages: shape 8–14 and 1–7) with its base faces suppressed; every intact neighbour face toward it is drawn as a face plus a `debris-face` piece; edges round it are not dressed. Derived version step with owner note; the 8 B instance unchanged. Runs (`kit-runs.ts`) kept only for beam/banister. | `kit-pieces.test.ts`, `case-forms.test.ts` (forms of beam/banister only), new invariant test in `kit-house.test.ts` (rewritten): on the log/stone houses, the town and random worlds **no instance stands on a flat face** (every edge instance's 4 cells are 1 or 3 solid), every exposed outer edge of a construction cell has exactly one instance, variants stable after a dig elsewhere; damage: a wall cell set to shape 7 → one debris piece + a debris-face on each intact neighbour face toward it, collision/light unchanged, at air the debris goes and the faces stay; `stream.test.ts` (real workers): a damage edit re-derives only the sections within R | instances a chunk per level (town 1,355 p50 at 46c.6 with a full kit), derive µs | no piece on a flat face anywhere; D480 superseded, D481 rechecked |
| R3b | **Adapter: edge instances drawn:** `voxel-chunk-view.ts`/`voxel-kit-pieces.ts`: one instanced draw a (kit piece, variant, level) a chunk, as built, now with far fewer piece kinds (no start/end/body sections, no mirrored copies for edge cases); **alias rotation** (a kit case may name another case's mesh with one of the 24 cube rotations, so `edge-out-bottom` can be `edge-out-top` flipped); **stagger** from the variant hash: ≤ 1/32 cell out of the faces and ≤ 2° twist (constants once, in the voxel package); edge U along the edge's world axis (`voxel-trim-u.ts` `pieceU` kept for edges, corners their own pieces); default kit (`default-kit.ts`) rewritten: a rounded box bevel per edge case, a corner cap, a ridge/eave/verge/hip/valley board, two debris boxes. Hosts unchanged (page, Play, Scene view, export). | `voxel-kit-pieces.test.ts` (real loader port: alias rotation determinant +1, stagger within its bounds and stable per cell, a flipped alias's normals out), e2e `voxel-world.e2e.ts` (the existing kit test reworked, no new test: a stone test kit's edge piece on a wall's top edge, none on its face; a banister → wall edit swaps pieces; `png.ts` reads) | piece draws, instances, render() CPU on the slice | both renderers draw edge pieces; e2e time before → after recorded |
| R4 | **Grid-anchored 4 m UVs (minimal part of 46d's material model):** the base surface and roof planes keep their world-space projection (already anchored to the grid by the chunk's integer phase), with the repeat taken per material from the material table: construction materials 4 m (owner: one repeat = one 4 × 4 m full wall), terrain stays 2 m. A debug **band pattern** layer (horizontal bands at fixed heights in the 4 m tile: a line every 0.5 m, a thick line at 0 and 2 m, a vertical tick every 1 m) the slice's construction materials take under `?bands=1`, so pictures show bands at the same height on every wall and floor. Roof planes: a material-table flag samples along the slope (U along the ridge in world metres, V the distance up the slope) instead of the 45° triplanar blur; terrain never takes it. | `voxel-surface` adapter vitest (the table carries period and flag; the shader's U/V for given world points on WebGL 2 and WebGPU program builds), e2e (`?bands=1`: two walls in different chunks, a band row at the same screen height read by `png.ts`) | GPU ms at the cap slice/town vs 46c.11 | bands line up across walls, floors and chunks (seen, both renderers) |
| R5 | **Two placeholder kits regenerated + kit check + test scene:** `make_placeholder_kits.py` rewritten: log and stone kits with the 10 edge/corner cases (aliases where one mesh serves: e.g. bottom = top flipped), 5 roof-edge pieces, 2 debris stages + debris face, the beam/banister pieces kept; 2 variants on the outer edges; high + low; no faces hidden against voxel bodies; debug UVs, no textures (the runtime debug set); budgets (default): edge ≤ 48 / 16 tris high/low, corner ≤ 64 / 24, roof edge ≤ 64 / 24, debris ≤ 160 / 48. Kit records regenerated (kitFormat 1 stays a DRAFT; the alias is an add-only optional field, canonicalizer + test). `voxel-kit-check.ts` rows follow the 20 cases (alias rows, "piece on a flat face" impossible by construction, so not a row). `writeKitTestScene` exhibits from a fixed sampler: a stepped block giving every edge/corner case, a gable, a hip and a valley roof, a wall with damage stages, a beam-banister balcony. | `placeholder-kits.test.ts` (records valid, every node through both loaders, kit check 0 err), `kit-test-scene.test.ts` (every case of the catalogue reached by the sampler), `voxel-kit.test.ts` (alias survives the canonical form) | per kit: pieces, tris high/low, GLB bytes, record bytes, texture sizes (game-ready report) | both kits check green and draw in the test scene |
| R6 | **Prototype on staging + measurement:** the 46c.10 pad rebuilt: log and stone houses with roofs (gable, hip, L-plan with a valley), a wall through a roof, a damaged wall (stages 12, 7, then air), a stair, door and window; L0/L1 walked in motion; chunk faces crossed; `?bands=1`; both renderers; every edit undone. Measured like 46c.11 (same scenes, same kit configurations a/b): instances (L0/L1), piece draws, draw calls, render() CPU p50/p95, GPU ms, orbit and flight missed frames, edge + roof pass µs (Node and workers), damage edit → shown frames, stream bytes incl. kits. | staging, `run.mjs` phases, pictures looked at | all of the above vs 46c.11 (town b: 63,149 instances, 4,133 piece draws, render() CPU 17–18 ms, 31–65 missed) | each case observed or "unverified" with why; D485, D483, D465 rechecked |
| R7 | **Role spec + trim layout drafts rewritten (still DRAFT, hard stop):** the reviewed drafts first `git mv` to `archive/architecture/` (the owner's reviewed text kept), then `docs/architecture/voxel-role-spec.md` rewritten: roles and what each draws (faces / roof planes / edges), the 20 cases with diagrams (edge and corner patterns, roof classification), integrity and debris, the beam/banister cases kept, what moved to 47b (fringe, scatter) and 46d (relief, materials); `voxel-trim-layout.md` rewritten for edge, roof-edge and debris pieces only (U along the edge's world axis, cap regions for corners), the 4 × 4 m base tile stated as the base surface's (not trim). `role-spec-doc.test.ts` kept, pinned to the new catalogue. | vitest (doc = catalogue), check-docs | — | both drafts match the built code; open questions listed |
| R8 | **Docs/spec:** format spec §3.7 rewritten (edge pass, roof mesher, integrity meaning of shape for construction, piece table, instances, derived version steps with owner notes; no stored format change), requirements traceability (R73–R77, R86, R90, R112), manual `features/voxel-worlds.md` (what draws where: faces, roofs, edges, debris; kit authoring is still a draft), reference regenerated if APIs changed; audit rows closed or superseded (D480, D481, D497 …). | check-docs, `tools/manual-links.test.mjs` | — | pages match the built code |
| R9 | **Close + presentation (lead):** fast gate green on the revision's e2e files, acceptance shots (every case of R6 on both renderers: houses with gable/hip/valley roofs, edges near, flat voxels far, damage stages, bands, the town a/b), README in `~/.cache/thirdlight-phase46/acceptance/46c-r`, review page **acc46c-r** with both rewritten drafts and exactly what the owner must approve. **Then STOP** (owner hard stop). | staging, fast gate | gate time, voxel e2e time | owner has the page |

**Retired by the revision** (archive with `git mv` into `archive/` where a whole file goes, AGENTS.md; parts removed in
place, history in git): the 43 non-beam/banister cases and their rules of `cases-draft` v5 (`kit-case-catalogue.ts`
rewritten); `wall-thin`, the copings, plinths, mouldings, running boards, foundation skirts (skirts → 47b scatter),
soffits and the `reshape` base mode and `slab` shape (`case-forms.ts`, `base-surface.ts`); run sections for anything
but beams/banisters (`kit-runs.ts` narrowed); the old default kit table (`default-kit.ts` rewritten); the window-
enumeration exhibit generator in `kit-test-scene.ts` (rewritten to the fixed sampler); the log/stone kit records and
GLBs (regenerated); `kit-house.test.ts`'s per-cell front expectations (rewritten to the edge invariant); the reviewed
role spec and trim drafts (`git mv` to `archive/architecture/`, R7). **Kept:** kit format, records and commands
(46c.1), the rule set composition and conformance (46c.3), the window/fold/priority machinery (for beam/banister), the
piece table, instance format and feeds rule (46c.6, 46c.6b), the adapter's GLB path and instancing (46c.7), the kit
check frame and Problems (46c.8), `pieceU` (edge U), the trim debug texture.

**Risks (recorded for the owner; none blocks):**
- **Roof planes vs walls at gables:** a gable wall under a stair-step roof is itself stair-stepped below the verge;
  the plane through the outer corners covers the roof but the wall's steps show under the gable edge. Default: the
  verge piece covers them; a "gable fill" (wall cells under a slope take the plane as their top) is offered, not built.
- **Hips and valleys only at 90° in plan with 45° slopes on both sides;** other slopes (1:2 stairs) and odd plans take
  the voxel-face fallback.
- **Collision stays voxel** (owner): the top plane through the outer corners is up to 0.5 m above a tread's centre,
  so a character on a roof stands visibly in it; shown in R6/R9 for the owner (alternative: a declared slope form for
  roof collision).
- **Edge pieces over square corners:** pieces sit over the base surface's square edges (bulging ≤ 1/16 cell out of
  the faces) because the base is not chamfered; z-fighting where a piece meets its face is authored out (a small
  offset). Chamfered/relief faces are 46d's.
- **LOD seams for roof planes** at ring changes (L0 planes vs L1 planes one cell coarser): checked in R2's tests and
  R6's walk; skirts as 46b's if a crack shows.
- **Draw count (D485):** instances drop a lot (no piece on faces), but draws are per (piece kind, chunk); if the town
  still misses the cap with two kits, the cause is recorded and cross-chunk instancing stays 46d's.
- **Integrity meaning step:** existing worlds with construction cells below shape 15 (digs into walls) start drawing
  them as debris; the slice and town worlds are regenerated by `run.mjs slice-world` / the town bench if needed.

## 7. Progress

| Item | Status |
|---|---|
| 46c.1 | done: voxel kit format 1 (DRAFT) as a project content item `voxelKits` (`project-model` `voxel-kit.ts`), setVoxelKit/deleteVoxelKit one undo each (editor, MCP, HTTP), own file `assets/voxel-kits/*.voxelkit.json`, catalog block `voxelKits` + mesh model versions in exports; newer format/unknown fields refused. Test kit 535 B (file 1,043 B). Spec §3.9 |
| 46c.2 | done: `kit-cases.ts` case pass (40-cell reach-2 window, 4-bit role/fill symbols, folded over 4 turns × mirror, rules by priority, fallback per role mandatory) + catalogue v0 **DRAFT** (45 cases, 43 rules; `kit-case-catalogue.ts`). Town (Node): 726 keys, µs a 16³ section with cells p50/p95 111/267 (all 13/115). 15 vitest |
| 46c.3 | done: `kit-rules.ts` `KIT_RULES` (`kits` v1 = terrain rules + case pass, R 2, apron 3) registered, `WORLD_RULES`; cases a u16 a cell in the job only; L0/L1 run, L2+ skip; derived v9 → v10 (spec note). Outputs byte-equal to terrain rules. Conformance class+case at 16/32. 16³ evaluation with detail p50/p95 town 90/115 → 207/419 µs; eval+ground 242/299 → 255/408 |
| 46c.4 | done: `kit-runs.ts` run sections (job only, u16 a cell: single/start/body/end/corner/junction, ends joined/open/butt/inner mitre, world axis); catalogue `cases-draft` v1 (+6 rules: rail L/T/X, beam corners, storey-line corner), `kits` v2; U world-anchored (`runU`). 6 tests. Town eval with detail cells p50/p95 207/419 → 241/479 µs; run pass alone 34/49 (slice 45/55) |
| 46c.5 | done: `case-forms.ts`: each case declares base keep/suppress/reshape + shape box/slab/panel/bar/post/none; every consumer reads the form (class's without a case); soffit reshaped to a slab. Catalogue v2, `kits` v3, derived v10 → v11 (spec note). Town 229 chunks: 15.29 → 15.80 MB, boxes full 22,429 → 23,201, partial 18,792 → 20,154; slice unchanged. 4 + 1 Rapier tests |
| 46c.6 | done: `piece-table.ts` (material → kit by test binding, kit-local pieces, missing case → body → single → same-form role fallback → engine default), variant word (hash of cell + kit seed, bit 15 mirror), still 8 B; derived v11 → v12. Kit change re-derives only chunks/L1 nodes holding its materials. Table 1.65 kB a full kit; town L0 instances/chunk p50 80 → 1,355 with a full kit |
| 46c.6b | done: wetness and a same-kit material paint re-derive shader data only, kit bound or not (real workers: 0 mesh derives); a cross-kit paint derives whole exactly the sections holding the painted cells. Edits report `materialSwaps`. Case windows drop the same-material bit unless a rule reads it (D478 fixed); derived v12 → v13. L1+ nodes still derive whole (D479) |
| 46c.7 | done: kit pieces drawn on the slice page, Play, Scene view, export: hosts build `worldPieceTable(kits)` (+ engine default kit `default-kit.ts`, 45 cases: 29 box pieces, 16 none; table format 2), GLBs via the content closure/backend, one instanced draw a (kit piece, variant, mirror, level) a chunk. Town render() CPU 3.2 → 8.1 ms (1,420 piece draws), slice unchanged; frames at the cap |
| 46c.8 | done: `voxel-kit-check.ts` (project-model) rows ok/warn/err/info: cases, role fallbacks, high/low, assets/digests, pivot/fit, join profiles, budgets, trim T1–T10 (draft, opt-in) → Problems + tl_diagnostics; `writeKitTestScene` op: 53 exhibits (45 cases × roles) from the catalogue, 98×7×49 cells, one undo; page `?kitScene=` labels. Default kit: 0 err, check 0.11 ms |
| 46c.9 | done: placeholder kits log (11 cases, 28 pieces, 768/385 tris high/low, GLB 92,956 B) and stone (12 cases, 18 pieces, 272/272, 32,436 B) from Blender 5.2 (`kits/make_placeholder_kits.py`), draft trim UVs, no textures; kit check 0 err, T1–T8 ok; on staging both renderers (`run.mjs kits`); trim debug set drawn; check T6 per face, T8 on the run axis |
| 46c.10 | done: lead's log-corner shot was a real bug: plain walls (fallback), lintels, sills, opening tops took a free front, pieces faced into the wall; fixed (`cases-draft` v4: fronts, `wall-thin` both faces; `kits` v5), pinned by `kit-house.test.ts`; trim U offset per instance (`pieceU`). §7a list on staging both renderers: 12 cases, table in results; D480–D484 |
| 46c.11 | done: staging both renderers at the cap, default kit vs log + stone. Town: 40.8 k → 63.1 k instances, piece draws 1,366 → 4,133, render() CPU 7.2 → 17–18 ms, **orbit misses 31–65 of 480 frames** (cause: draws a chunk); flight 0 → 1–3 missed. Houses 0 missed. Case pass Node 256/508, browser 300/800 µs. Blasts 1/4 m 1 frame, 8 m 2–3; kit swap 1 frame. Hooks: `kits=default`, evaluateUs |
| 46c.12 | draft v1 candidate (DRAFT — awaiting owner, hard stop): `docs/architecture/voxel-role-spec.md` from `cases-draft` v4: 10 roles, 6 inferred features, reach-2 window + folds, 46 cases (40 required, 7 fallbacks, 6 optional) with rule diagrams, sections, base/shape, engine default, levels, piece/Blender convention, D480–D483, 15 questions; `role-spec-doc.test.ts` (5) pins doc = catalogue |
| 46c.13 | draft v0 (DRAFT — awaiting owner, hard stop): `docs/architecture/voxel-trim-layout.md`: 4096² sheet authored 1024 px/m (tiers 256/512/1024), 32 px gutters, field 1 m + strips 0.5/0.25/0.125 m plain/profiled + caps 3 sizes × 4, U from world run distance (4 m repeat), path B (own bakes) beside it, kit-check rows T1–T10, log/stone examples, 10 owner questions |
| 46c.14 | done (docs only): spec §3.7 one "Kits and cases" section (case pass, catalogue v4 DRAFT, `kits` v5, runs, forms, piece table 2, instance, levels, paints, v9 → v13 owner notes in one table; no stored format change), §3.8/§4; requirements R73–R77, R86, R87, R90, R112; manual kits, kit check, `writeKitTestScene` (draft); D485 (kit draw count). Reference unchanged |
| 46c.15 | presented, awaiting owner approval (hard stop): 50 shots × 2 renderers re-taken at b6ec7d2f (kit scenes, log/stone houses, two-thick jambs, wall-beam-banister, long walls, cross-kit paint, town L0/L1, default kit) in `acceptance/46c/final`, older shots in `older/`; README + approve-46c.md: 65 questions. Seen: D480–D482, stone plinth breaks at jamb cells |
| 46c.16 | not started (waits for owner approval of the revised drafts, R9) |
| 46c.17 | not started (waits for owner approval of the revised drafts, R9) |
| 46c.14b | not started: runs once after the owner approves the revision (decision log 2026-11-04 revision plan) |
| 46c.14c | done: review M1–M5 fixed (D486–D490): jamb fronts (`cases-draft` v5, `kits` v6), run cells keep their axis, kit pins never move other refs, `_COL`/`_OCC` never drawn, kits + trim U + late pieces in the stream budget (town 105.7 → 112.7 MB, kits 6.58 MB). Lows: 5 fixed, D491–D497 open, D498 watch. Role spec blocks to regenerate (wall/opening jamb) |
| 46c.18 | not started (after approval) |
| R1 | done: `edge-cases.ts` edge pass (12 edges + 8 corners a cell, 10 cases × yaw 4, reach 1) + `edges-draft` v0 (20 cases; window rules beam/banister only) as `edges` v1 (registered, conformance incl. edges); construction shape = integrity in every reader, derived v13 → v14. Town µs a section p50/p95: old case pass 123/318, new passes 144/290 (edge pass 52/111) |
| R2 | done (53c71768): `roof-mesher.ts`: 45° roof stairs → closed sloped prisms (ridge, hip, valley, pyramid apex; underside onto gable/eave walls), appended to the base, collide as ramps (`collision.ramps`); roof-edge words for R3; derived v15, `edges` v2. Town base tris 328 k → 303 k, roof mesher 188/403 µs a section; fast gate green 13 min; D500–D503 |
| R3 | partial: `derive-pieces.ts`: instances only on edges, corners, roof edges, beams/banisters and debris (integrity < 15, exposed); `WORLD_RULES` = `edges` v3, placement bits, derived v16; no piece on a flat face (tested). Town L0 320 k → 131 k instances (p50 1,355 → 555 a chunk), L1 53 k → 73 k (D505). Left: archive the old catalogue, reshape/slab; D504–D505 |
| R3b | not started (adapter: edge instances, alias rotation, stagger, default kit) |
| R4 | not started (grid-anchored 4 m UVs, band debug pattern, roof slope projection) |
| R5 | not started (log + stone kits regenerated, kit check, test scene sampler) |
| R6 | not started (prototype on staging + measurement vs 46c.11) |
| R7 | not started (role spec + trim drafts rewritten, still DRAFT) |
| R8 | not started (spec, requirements, manual) |
| R9 | not started (fast gate, acceptance, acc46c-r; owner hard stop) |

## 8. Results

(Filled per item: numbers, rounds, uptime, report paths.)

### 46c.1 kit data format

- **Built:** `packages/project-model/src/voxel-kit.ts` (record, validator, canonicalizer, `voxelKitMeshes`), content key
  `voxelKits` (resource kind `voxelkit`, folder `assets/voxel-kits`, not addressable: `unaddressed: 'block'`),
  `commands` `voxel-kit-ops.ts` (`setVoxelKit`/`deleteVoxelKit`, change `setVoxelKit`), `queryGameConfig.voxelKits`,
  MCP docs, catalog block `voxelKits` (manifest v5), capture ships each mesh's model at the version its digest names.
- **Tests:** `voxel-kit.test.ts` (8: every leaf survives canonical form but the default weight, order-independent,
  idempotent, game data untouched; newer format refused whole; unknown fields at 7 levels; bad values with paths; game
  data depth/non-JSON; catalog block), `voxel-kit-ops.test.ts` (3: create/replace/delete, undo/redo, refusals change
  nothing, no address/labels), `tests/integration/voxel-world/voxel-world.test.ts` (+1 test, export test extended: a
  real backend over HTTP and MCP's tl_command, a GLB imported and named by digest, the kit's file on disk, deleted and
  undone, read back after a restart; the export's catalog carries the kit with its game data and the GLB byte for byte).
- **Bytes:** the integration kit (2 cases, 1 section, 1 variant, 1 profile, game data) 535 B compact, 1,043 B on disk.
- **Gate:** fast gate gate-fast-20261104-010023 GREEN (15 min, peak 5.6 GB; vitest 833 files; 36 e2e; perf at the cap
  0 missed both renderers). `voxel-world.e2e.ts` untouched (no browser behaviour): its 7 tests sum to 66.9 s (load
  average 2.8–5.3, 46c start ~58–65 s), the kit test went to vitest.

### 46c.2 case catalogue, extraction and matcher

- **Built:** `packages/voxel/src/kit-cases.ts` (`CaseCatalogue`: checks and compiles a catalogue, `extract(n, lo, hi, out)`
  fills a u16 a cell = case index << 3 | transform, `NO_CASE` for cells with no case; `matchWindow` the slow path tests
  read), `kit-case-catalogue.ts` (`DRAFT_CASE_CATALOGUE`, id `cases-draft` v0, `draft: true`: **DRAFT — not v1, the
  role spec draft's source**), `cropNeighbourhood` exported from `derive-assembly.ts`, `run.mjs cases` (`cases-cli.ts`).
  Nothing draws or registers yet (46c.3+).
- **Window and key:** 40 cells within reach 2 (the 26 touching, 6 two out along an axis, 8 beside the cells two above
  and below), each a 4-bit symbol: open (air, liquid, filled below the surface), opening, ground, or one of the six
  built roles × same/other material than the centre. The key is the smallest packed fold (5 u32) after the centre's
  role; the result keeps the transform that places the matched rule's pattern (authored front +z, run x, up +y) on
  the world.
- **Catalogue v0 (DRAFT):** `enclosed` (all built roles); wall: plain (fallback), top, end, corner, base, jamb,
  lintel, sill; floor: plain, edge, corner; roof: plain, peak, ridge, hip, valley, verge, eave, slope, edge;
  foundation: plain, corner, edge; stair: plain, step, side; pillar: plain, single, base, capital, shaft; opening:
  plain, single, threshold, sill, head, jamb; inferred: beam (wall, floor), banister-rail (wall), banister-post (wall,
  pillar), running-board, moulding, soffit (floor, roof), foundation-skirt.
- **Tests:** `kit-cases.test.ts` (10: 8 distinct transforms forming a group over the window; 3,000 random windows turned
  /mirrored give the same case, key and rule, the pattern fits under the returned transform, and it is the world's
  turn after the original's when the window has no symmetry; no vertical flip (soffit vs floor edge); priority, table
  order, wildcards, symbol sets, rule roles; refusal without a fallback for each of the 7 roles and 9 other broken
  definitions; every one of the 45 cases reached by a window; 20,000 random windows each a case of their role) and
  `tools/voxel-bench/kit-cases.test.ts` (5, real stores: the 45.7b scene's wall, top, end, beam (run along x, wall
  behind), rails and posts, and exactly the 24 cells the placeholder rules read as beam/rail/post; banister grown →
  wall, beam cut → stub; the scene turned/mirrored 7 ways gives the same case at every one of 152 cells; on 6 random
  assembly/terrain worlds with every role dabbed in, the cached extraction equals the window path at every cell and
  no other cell gets a case; the town smoke).
- **Measured** (`run.mjs cases`, 6 GB scope, Node 22, i5-12600H, 2026-11-04 01:32, load 1.3, uptime 11.4 d, 3 rounds):
  whole 512² town, 12,072 sections of 16³, 1,394 with detail-bearing cells (320,430 cells), **726 case keys seen**;
  µs a section **p50 / p95 111 / 267 with cells, 13 / 115 all** (rounds 329 / 324 / 326 ms; cold pass, empty window
  cache, 347 ms). Against §4: the case pass costs about the terrain rules' evaluation again on built sections
  (92–116); 46c.3 measures the composed set. Under vitest the same pass reads ~3× slower (380 µs): the CLI is the
  number. Town cases: wall-plain 73,475, roof-slope 57,772, foundation-plain 47,130, floor-plain 46,574, moulding
  14,850, wall-end 13,352, banister-rail 12,331, foundation-skirt 9,992, … ; 24 cases never occur there (the town
  writes no openings, pillars, hip/valley/peak roofs or flat roofs): they are reached by window enumeration only.
- **Gate:** fast gate gate-fast-20261104-013505 GREEN (13 min, peak 4.5 GB; vitest 835 files; 36 e2e; perf at the cap
  0 missed both renderers). `voxel-world.e2e.ts` untouched (no browser behaviour).

### 46c.3 the registered kit rule set

- **Built:** `packages/voxel/src/kit-rules.ts`: `withCases(base, catalogue, id, version)` and `KIT_RULES` (`kits` v1 =
  `terrain` v1 + catalogue `cases-draft` v0, radius max(2, `CASE_REACH` 2) = 2, job apron 3); `evaluateCases`,
  `levelHasCases`. `AssemblyRuleSet` gained an optional `resolveCases(n, lo, hi, level, out: Uint16Array)`; the derive
  (`deriveChunk`) runs it after the classes into a per-thread u16 scratch (never in the result, never stored);
  `ruleRadiusMismatches` compares every consumer-read cell's class and case (`part`). Registered; `WORLD_RULES` =
  `KIT_RULES`. `DERIVED_FORMAT_VERSION` 9 → 10, spec §3.7 (kit rule set, contract, history row and owner note), §3.8.
  `run.mjs cases` now measures town and the slice ring, the case pass alone and composed with the terrain rules.
- **Tests** (`tools/voxel-bench/derived.test.ts`): conformance for every registered set now on random assembly and
  terrain worlds with every detail role dabbed in (`scenes.ts` `dabDetailRoles`, also used by `kit-cases.test.ts`) at
  chunk edges 16 and 32, `kits` included; a case pass reading 3 cells under a declared 2 is caught as `case` at the
  reach cells; new block "the kit rule set" (5): world set, radius 2, apron 3, classes = terrain rules', terrain rules
  give no case; cases at L0 = L1, none at L2 (beam cells get the beam case, rail cells the banister cases); **byte
  equality** with the terrain rules but the rule set named on chunks, 16³ sections and L1/L2 nodes of the town, the
  wall-beam-banister scene, the feature cases and a mixed random world; 16³ and 8³ sections joined = the whole chunk's
  case grid cell for cell incl. the reach margin; the random worlds reach cases of all 7 detail roles (> 20 cases).
- **Measured** (`run.mjs cases`, 6 GB scope, Node 22, i5-12600H, 2026-11-04 02:04, load 1.8, uptime 11.4 d; 2 runs,
  the second's numbers, the first within 5 %): µs a 16³ section p50 / p95, terrain rules → kit rules.
  | | town (12,072 sections) | slice ring (9,616) |
  |---|---|---|
  | evaluation, sections with detail cells (1,394 / 4) | 90 / 115 → 207 / 419 | 112 / 166 → 231 / 269 |
  | evaluation, all sections | 52 / 104 → 65 / 259 | 50 / 99 → 63 / 112 |
  | evaluation + ground mesh, ground sections (2,489 / 1,297): 46b's measure | 242 / 299 → 255 / 408 | 214 / 315 → 227 / 330 |
  | whole section derive (all meshes and consumers), sections with a surface | 418 / 532 → 476 / 763 | 390 / 513 → 402 / 526 |
  | case extraction alone, sections with cells | 109 / 269 | 102 / 112 |

  Against §4 (evaluate + mesh 207–307 µs p50) and the 0.1–0.2 ms budget: **missed, cause recorded**. The terrain
  rules' evaluation was already the cause of 46b's miss; the case pass adds about that again on built sections
  (+117 µs p50 town), from gathering the 40-cell window and hashing it for every detail-bearing cell (~230 a built
  section) even when the window cache hits; p95 grows most (+304 µs) in roof and wall shells dense in such cells.
  Ground-only sections pay ~13 µs (the role scan). Left for the performance phase (ideas: skip cells with six solid
  faces from the class pass, slide the window along y); not tuned here. The 46c.2 "all sections" figure (13 / 115)
  read the last 8,192 samples only (`SampleRing`); with every sample it is 11 / 125.
- **Gate:** fast gate gate-fast-20261104-020807 GREEN (12 min, peak 4.3 GB; vitest 835 files; 36 e2e; perf at the cap
  0 missed both renderers). `voxel-world.e2e.ts` untouched, its 7 tests sum to 58.0 s (was 66.9 s at 46c.1, load).
  Before the gate, one `stream.test.ts` test ('never holds an edit for another … two digs … swap apart') failed once
  in an ad-hoc run of all voxel suites at 3 workers and passed alone and in its whole file; it passed in the gate.

### 46c.4 merge-compatible run sections

- **Built:** `packages/voxel/src/kit-runs.ts` (`RunTable` per packed case: run group, world axis, sign of the piece's
  own +x; `resolveRunSections`; packing `packRunSection`/`runSectionOf`/`runStartEndOf`/`runEndEndOf`/`runAxisOf`;
  `RUN_SECTION` = `PIECE_SECTION` + corner 4, junction 5; `RUN_END`; `runU`), `AssemblyRuleSet.resolveRuns` (optional),
  `kit-rules.ts` `evaluateRuns` (skips to a clear when the case pass found no cell), `deriveChunk` runs it into a
  per-thread u16 scratch after the cases (never in the result). Catalogue `cases-draft` v0 → v1 (49 rules, still
  DRAFT): rail L, T and cross on a wider support, beam round a wall's inside and outside corner, the storey line's
  outside corner. `KIT_RULES` `kits` v1 → v2; derived bytes unchanged (no output reads sections yet), so no derived
  version step: results name `kits` v2. Spec §3.7 kit rule set updated. `run.mjs cases` times the run pass.
- **Tests** (`tools/voxel-bench/derived.test.ts`, block "run sections", 6): an 80-cell beam over three chunks: bodies,
  two open terminations, world U stepping one cell a cell across every chunk face, the wall's coping a run too; a dig
  in a 40-cell beam: both sides of the cut become open terminations, every changed section within the job reach (3)
  of the dig, the run's other cells unchanged; rail L (corner), T and X (junction) across chunk faces, arms bodies on
  x and z; a foundation skirt round the block's outside corner (corner); mouldings under a ceiling meeting at an
  inside corner end in `inner` mitres; the 45.7b scene: one beam run, one rail run over single posts (no axis), and
  sections of a chunk equal to its 16³ and 8³ sections' cell for cell (scene, long beam, town); exactly the cells
  with a case get a section, none for a set without the pass. `kits` version expectations updated (2).
- **Measured** (`run.mjs cases`, 6 GB scope, Node 22, i5-12600H, 2026-11-04 02:36, load 1.0, uptime 11.4 d; round 2,
  round 1 within 2 % on detail sections): µs a 16³ section p50 / p95.
  | | town (1,394 sections with detail cells) | slice ring (4) |
  |---|---|---|
  | run pass alone, sections with detail cells | 34 / 49 | 45 / 55 |
  | evaluation (classes + cases + runs), detail sections (46c.3 without runs) | 241 / 479 (207 / 419) | 273 / 336 (231 / 269) |
  | evaluation, all sections | 69 / 306 (65 / 259) | 66 / 115 (63 / 112) |
  | evaluation + ground mesh, ground sections | 259 / 438 (255 / 408) | 230 / 332 (227 / 330) |

  The first run had the pass clear every section without a case cell by cell (+15 µs each, all-sections p50 99);
  it now skips on the case pass's count (3 µs). Sections (town, one pass over its 320,430 case cells): single 186,792
  (cases without a run axis, and one-cell runs), body 99,070, start 14,376, end 19,460, corner 732, junction 0 (the
  town builds no fences): ~16.9 k runs of two or more cells, ~7.9 cells a run on average (from the terminations).
- **Gate:** fast gate gate-fast-20261104-024059 GREEN (12 min, peak 4.7 GB; vitest 834 files + `scan-bounded-log.test.ts`
  timed out once and passed alone, D418 watch noted; 36 e2e; perf at the cap 0 missed both renderers).
  `voxel-world.e2e.ts` untouched (no browser behaviour): its 7 tests sum to 57.8 s (58.0 s at 46c.3).

### 46c.5 base and consumers from the case

- **Built:** `packages/voxel/src/case-forms.ts` (form byte a cell in the job: shape, transform, base; `FORM_SHAPE_BOX`
  in 1/16 cell, case orientation; `LIGHT_COVERAGE` = the shape's share; `classForm` for cells without a case;
  `evaluateForms`), `CaseDef.base`/`shape` + `caseFormProblem` (a catalogue pairing them wrongly is refused),
  `AssemblyRuleSet.caseForms`. Consumers (`derived-data.ts`): render solid = box, nav blocks = any shape, supports =
  shape covers the top, light = share, collision = merged boxes + one shape box a cell; base surface (`base-surface.ts`):
  keep = body, suppress = nothing (a body at levels without pieces), reshape = the shape's own quads (lattice corners
  stamped so merged rectangles split there); instances from suppressed cells, family by shape, sections from the run
  pass (corner/junction → body). A uniform body region takes the short path only when every form is the box.
  Catalogue `cases-draft` v1 → v2 (beam suppress/bar, banister-rail suppress/panel, banister-post suppress/post,
  soffit reshape/slab, openings keep/none, the rest keep/box), `kits` v2 → v3, derived v10 → v11 with an owner note
  (spec §3.7). `scenes.ts` `placeBalcony`; `run.mjs cases` measures consumers (`--consumers-only`).
- **Tests:** `tools/voxel-bench/case-forms.test.ts` (4): shapes and class forms (beam/rail/post boxes as before);
  every cell of chunks and level-1/2 nodes of the town, both hand scenes and two random worlds gives light, nav
  blocking, standability, render occupancy, collision (full or the exact box) and piece exactly from its form
  (> 5,000 case cells, all six shapes seen); the balcony: soffit/floor-plain cases, slab box, light 128, standable on
  top, free below, the base's underside at y 4.5 under a soffit and 4 under the floor, every base triangle wound
  out; 16³ and 8³ sections = the whole chunk's consumers cell for cell, base area equal in every face plane (scene,
  balcony, town, random). `collision.test.ts` +1 (real Rapier): capsule stands on the soffit and the floor (y 5), a
  ball rising under the floor stops at 4, under the front and side soffits at 4.5; the banister-gap ball, beam and
  rail capsules still pass. `derived.test.ts`: the 46c.3 byte-equality test now holds where no consumer-read cell's
  case form differs from its class's (and on every level-2 node); the rest differ only through forms. `kit-cases`
  refusal test +5 form rows. 45.7b proof (rail ↔ wall ↔ beam per consumer) unchanged and green.
- **Measured** (`run.mjs cases`, 6 GB scope, Node 22, i5-12600H, 2026-11-04 03:00 (before) and 03:16 (after), load
  0.6 / 3.0, uptime 11.4 d), whole 32³ chunks with construction, 46c.4 → 46c.5:
  | | town (229 chunks) | slice ring (4) |
  |---|---|---|
  | derived bytes | 15,291,705 → 15,795,018 (+3.3 %) | 259,994 → 259,994 |
  | base / collision / light / nav bytes | 6.43 → 6.90 M / 495 → 520 k / 994 → 998 k / 1.93 → 1.93 M | unchanged |
  | boxes full / partial | 22,429 → 23,201 / 18,792 → 20,154 | 4 / 24 unchanged |
  | a chunk p50 / p95: bytes; full; partial boxes | 67.8 / 98.0 → 70.1 / 103.8 kB; 102 / 187 → 104 / 193; 78 / 164 → 85 / 175 | 66.0 kB; 2; 6 |
  | base triangles; instances | 304,218 → 323,886; 18,792 → 18,879 | 128; 24 |

  The growth is the town's 1,275 soffit cells (0.4 % of its 320,430 case cells): each a slab box (no longer merged
  into the full boxes, which also split round it) and up to 5 base quads in place of merged faces; instances net +87
  (18,879 = beam 4,911 + banister-rail 12,383 + post 1,585 cases) where the cases and the placeholder classes
  disagree on a beam or banister cell. Section derive (all meshes and consumers) on the town's sections
  with a surface, kit rules: p50 / p95 563 / 911 µs (46c.3 476 / 763, load 1.8 then, 3.0 now; terrain rules in the
  same run 477 / 592): the forms pass and the reshaped quads, recorded, not tuned (perf phase after 49).
- **Gate:** fast gate gate-fast-20261104-031848 RED on one e2e assertion: the assembly proof read the old placeholder
  coverages (rail 51, beam 128) as literals; it now reads `LIGHT_COVERAGE.panel`/`.bar` (the meaning step above, not
  a widened bound); `scan-bounded-log.test.ts` failed once and passed alone (D418 watch). Rerun
  gate-rerun-20261104-033226 GREEN (perf at the cap 0 missed both renderers). `voxel-world.e2e.ts` (no test added):
  its 7 tests sum to 57.9 s (57.8 s at 46c.4). The slice world has no soffits, so the page draws as before
  (unverified by eye).

### 46c.6 instances carry kit pieces

- **Built:** `packages/voxel/src/piece-table.ts` (`buildPieceTable(kits, rules)` → canonical bytes, format 1, read back
  by `readPieceTable`, kept by hash in each worker; `kitPieceList`, `tablePiece`, `pieceVariant`, `pieceTableChanges`,
  `defaultPiece`/`defaultPieceFamily`), `AssemblyRuleSet.catalogue` (set by `withCases`), `deriveChunk(…, pieces)`
  with the derive unit's world origin (chunks, sections and mip nodes pass theirs), `DeriveInput.pieces` (the table's
  bytes), `stream-pieces.ts` (`VoxelStreamer.pieces`: `table`, `set(table)` → group + chunks re-derived, `feeds`),
  `SectionDerives.rederiveChunk`, `StreamMips.piecesChanged`, `payloadHolds`. Instance: u16 piece kit-local (default
  pieces family << 3 | run section below 32, so corners and junctions keep their sections), u16 variant word. Kept or
  reshaped cells get a kit piece (no `replacesBase`) only where they show. Derived v11 → v12, spec §3.7 (kit pieces,
  instance, history, owner note), §3.8. Adapter stand-ins decode the default family; kit pieces draw from 46c.7.
- **Tests:** `tools/voxel-bench/kit-pieces.test.ts` (new vitest file: `derived.test.ts` is at 1,823 of 2,000 lines),
  4: the table (piece order, fallback order case → body → single → same-form role fallback → default/none, a material
  two kits bind, canonical bytes, newer format and short bytes refused, a table of other rules refused, changes by
  material); the wall-beam-banister scene (kit pieces on timber/stone, default post where the kit lacks it, kept
  pieces only where a face shows, every suppressed cell still has its piece, an unbound table = no table byte for
  byte, 3 variants seen, 8 B an instance); the town (variant stable after a 3³ dig: every cell farther than pad + 2
  identical, every cell keeping its piece keeps its variant; 16³ sections = the chunk cell for cell); per level
  (kit pieces high at L0, `low` at L1, none at L2; the cells a piece replaces are the same with and without a kit at
  L0 and L1). `stream.test.ts` +1 (real workers): `pieces.set` re-derives exactly the resident chunks holding the
  kit's material (8 sections each, nothing else), joined pieces = in-thread derive with the table; a second kit
  touches only its chunks; the same table again nothing; a paint of log cells to an unbound material rebuilds their
  pieces. Existing tests decode default families (`defaultPieceFamily`).
- **Measured** (`run.mjs cases --pieces`, 6 GB scope, 2026-11-04 04:01, load 3.2, uptime 11.5 d; one run, counts are
  deterministic): table bytes one full test kit (every case but `enclosed`, 6 sections, 2 variants) 1,650 B, six
  kits (4 variants) 16,032 B, no kit none sent. Whole 512² town: L0 chunks with pieces 218 → 229, instances 18,879 →
  320,160 (p50 / p95 / max a chunk 80 / 164 / 217 → 1,355 / 3,012 / 3,857); L1 nodes 62: 4,710 → 53,333 (73 / 127 /
  154 → 876 / 1,546 / 1,799), 51,377 kit pieces. Slice ring: L0 24 → 152, L1 0 → 26. A full kit puts a piece on every
  shown construction cell (the worst case: a kit that leaves walls to the base surface adds none there); whole-chunk
  derive time unchanged within noise (town L0 4.97 s → 4.94 s for 229 chunks).
- **D465 rechecked with low pieces:** at L1 every cell a piece replaces has one with and without a kit (tested), the
  bodies past L1 are unchanged; drawing real low meshes is 46c.7, so the look stays unverified (no picture taken).
- **Gate:** fast gate gate-fast-20261104-040147 GREEN (13 min, peak 4.8 GB; vitest 837 files; 36 e2e; perf at the cap
  0 missed both renderers). `voxel-world.e2e.ts` untouched (no browser behaviour): its 7 tests sum to 61.8 s (57.9 s at
  46c.5, load 3.2). Staging slice world needs no regenerating (derived data only).

### 46c.6b the feeds rule with kits bound (fix)

- **Built:** `EditOutcome.materialSwaps` (distinct `materialSwap(from, to)`, record.ts; the worker's `edit` output,
  the command answer, history and `voxelsChanged` carry it; an undo answers its edit's turned round);
  `pieceTableKitChanges(table, swaps)`; `StreamPieces.feeds(parts, swaps)`: wetness or a paint within one kit →
  shader parts only; a paint between kits → `PIECES_AT_CELLS` (stream-sections.ts), with which `invalidate` also
  derives whole the sections holding the edit box (radius 0, a piece reads only its own cell's material); a refresh
  without swaps, kits bound, counts as between kits. `CaseCatalogue.readsMaterial` / `catalogueReadsMaterial`: the
  same-material bit is set in a window only when a rule reads it (the draft reads none), else materials decided the
  fold of symmetric windows (D478); a catalogue that reads it makes a material paint feed geometry. Derived v12 → v13.
- **Tests:** `kit-pieces.test.ts` +1 (16 town chunks, two kits wood {timber, plank} / masonry): wetness on every built
  cell, timber → plank, stone → brick: every derived byte but the shader data equal (fails at v12: chunk 1,0,0 under
  timber → plank); plank → brick (cross-kit) in a quarter: instances change only at painted cells (> 50), everything
  but instances and shader equal. `stream.test.ts` (real workers, extended the pieces test): rain on the log wall and
  log → a second log-kit material: 0 `derived` events, shader only, joined instances = in-thread derive; log → an
  unbound material: `derived` = exactly the sections overlapping the edit box, each once. `kit-cases.test.ts` +1:
  repainting a window's neighbours never changes the draft's case, fold or key; a rule with `CELL.same` reads material.
  No kit bound: the existing overlay and refresh paint tests pass unchanged. `voxel-world.test.ts` (command route):
  answers and the `voxelsChanged` feed carry `materialSwaps`, an undo's turned round.
- **Gate:** gate-fast-20261104-043713 RED only on `voxel-world.test.ts` (the feed's exact shape lacked the new field:
  test updated); rerun gate-rerun-20261104-044807 vitest + 36 e2e green, perf webgpu main-thread CPU 10.32 ms > 9.02
  (load 6.3, a one-off: the village draws no voxels); rerun gate-rerun-20261104-045317 GREEN (perf 0 missed both,
  5.94 / 4.17 ms). `voxel-world.e2e.ts` untouched: 7 tests sum 63.8 s (61.8 s at 46c.6). Staging slice world needs no
  regenerating (derived data only).

### 46c.7 pieces drawn

- **Built:** `@thirdlight/voxel` `default-kit.ts` (`DEFAULT_KIT_ID` `@engine-default`, `DEFAULT_KIT_PIECES`: every catalogue
  case a procedural piece of boxes in sixteenths in the case's orientation, or none; `defaultKitSource`), piece table
  format 1 → 2 (a default-kit slot: every material no kit binds draws it), `worldPieceTable(kits)` (the world rules'
  table with the default kit), `worldStreamer` and `VoxelWorldConnection` take `pieces`. Three-adapter
  `voxel-kit-pieces.ts`: `VoxelKitMeshes` (GLB meshes parsed by the page's loader port from bytes the host hands it,
  merged per mesh/node with `mergeWorldGeometry`, mirrored copies, default pieces built from boxes, a 256² labelled
  debug UV texture, a stand-in tint a kit, `world(kits)`), `VoxelKitSet` (`resolve`, `describe`); `VoxelChunkView`
  draws kit pieces (kit from the cell's material in the shader grid; one `InstancedMesh` a (kit piece, variant,
  mirror, detail) a chunk; turn −90° a quarter (+x → +z, `applyFold`); waiting meshes built on arrival; `setKits`;
  `pieceDraws`, `piecesDrawn.kit`); `VoxelWorldDraws.setKits`, stats `kitInstances`/`pieceDraws`. Hosts: slice page
  (`queryGameConfig` kits, GLBs from the asset bytes route; `?kits=0` = no table; state `kits`, `pieceDraws`,
  `drawCalls`; probes derive fresh with the table, `cellAt.kitPiece`), Play and export (`manifest.voxelKits` to the
  sim init; GLBs by catalog row through the verified reader; hook `kits()`), Scene view (kits read once per open, sent
  with `open`; the worker derives with them). Spec §3.7 table format 2; manual voxel worlds (how worlds draw kits).
- **Default kit (engine-owned, procedural, game-ready report):** 29 pieces of 34 boxes (12 triangles a box high, 10 low
  without the downward face: 12–48 / 10–40 a piece, 408 / 340 all); beam, rail, post stay the engine's stand-ins
  (12 / 8). Texture: one 256² RGBA8 debug texture (256 KiB, mips ~341 KiB), shared by every kit piece. No files (code
  only, `default-kit.ts`). Mirror-symmetric pieces share their unmirrored draw. The e2e test kit's GLB: 1,732 B, 12
  triangles, no low, no texture.
- **Tests:** `voxel-kit-pieces.test.ts` (adapter, 3: real derive + real GLB through `createGltfLoaderPort`: draws a
  (kit piece, detail), instance at its cell, +x turned onto the run, determinant +1; waiting coping built when the GLB
  arrives; L1 low; remove frees counts; a kit swap: untouched chunk keeps kit A's mesh, re-derived uses B's; the
  mirrored copy; default geometry triangles/UVs and the debug texture's labels). `kit-pieces.test.ts` +2 (default kit
  covers exactly the catalogue; world table binds, refuses the reserved id, paints within the default kit; on the
  wall-beam-banister scene every no-table piece unchanged, default pieces only on kept feature cases). e2e
  `voxel-world.e2e.ts` (no new test): a stone test kit (GLB end board) imported in `beforeAll`; per renderer: kit ids,
  mesh ready, kit pieces > 5, the wall end's piece is the kit's, banister grown → wall: rail piece gone, default
  coping on the new top, > 300 pixels changed (png.ts), dug back; Play (worker, single), Scene view, export (backend
  stopped): kit meshes ready, kit instances > 5. Assembly proof: the beam stub's piece may now be a default trim on
  the kept body (was `null`: no kit drew kept cells), never one replacing it.
- **Measured** (staging, 1280 × 720 at the 60 Hz cap, `frames(8)` orbit, `?gpuTime=1`, 2026-11-04 05:19–05:24, uptime
  11.5 d, load 2.3–2.8; 2 rounds; slice `[0,106,-30]`, town `[256,6,256]` as 46b.8b):
  | | slice: kits / `?kits=0` | town: kits / `?kits=0` |
  |---|---|---|
  | draw calls | 193 / 183 | 1,179 / 414 (round 1: 1,496) |
  | instances drawn (kit; L0 / L1) | 70 (51; 70 / 0) / 19 | 42,548 (34,247; 24,927 / 17,621) / 8,301 |
  | instanced piece meshes | 16 / 6 | 1,420 / 273 (round 1: 1,904) |
  | render() CPU p50 / p95 WebGPU | 1.3 / 2.1 vs 1.4 / 2.3 ms | 8.1 / 9.0 vs 3.2 / 5.2 ms (round 1: 10.8 / 18.9) |
  | render() CPU p50 / p95 WebGL 2 | 1.4 / 2.6 vs 1.4 / 1.7 ms | 7.9 / 9.3 vs 3.0 / 3.8 ms (round 1: 10.6 / 12.0) |
  | GPU ms a frame WebGPU / WebGL 2 | 8.0 / 3.8 vs 8.3 / 4.3 | 2.6 / 3.7 vs 4.6 / 3.9 |
  | frame p50 / p95 | 16.7 / 16.8 both | 16.7 / 16.8 both |

  Round 2's one change: mirror-symmetric default pieces share their draw (−26 % piece draws). **Miss, cause recorded:**
  town render() CPU +4.9 ms from one instanced draw a (kit piece, variant, mirror, level) a chunk: 387 chunks and
  nodes × ~4 piece kinds each (skirts, sills, headers, verges, mouldings at L0 and L1); frames still at the cap.
  Fewer draws (pieces of a kind across chunks in one instanced draw, GPU culling, merged caches) is 46d's measurement
  as planned; not tuned here. WebGPU GPU ms in the town read lower with kits (2.6 vs 4.6) in both rounds' orbits:
  unexplained, recorded as read. Looked at (shots in `~/.cache/thirdlight-phase46/work/46c.7/shots`): slice close
  (coping, end/corner boards, slab band with the debug texture; banister stand-ins), town near (foundation skirts,
  sills and headers, running boards, verge boards stepped up the gables): pieces sit on their faces, no floating
  pieces seen; WebGL 2 shots not looked at.
- **Gate:** fast gate gate-fast-20261104-053229 GREEN (12 min, peak 4.3 GB; vitest 838 files; 36 e2e; perf at the cap
  0 missed both renderers, 5.92 / 4.16 ms). `voxel-world.e2e.ts`: 7 tests sum 55.6 s alone (63.8 s at 46c.6b). Staging
  slice world needs no regenerating (derived data and a job table only).

### 46c.8 kit check and kit test scene

- **Built:** `project-model` `voxel-kit-check.ts` (`voxelKitCheck`, `worldVoxelKitCheck`, `voxelKitMeshFacts` from GLB bytes:
  triangles, bounds, UV0, one node, embedded image sizes) and `voxel-trim-layout.ts` (`DRAFT_TRIM_LAYOUT` `detail-trim`,
  the draft's regions; **DRAFT**). Rows: `catalogue` (unknown case/section: err), `required:<case>` (warn, naming what
  draws it: the role's fallback piece of the same form, the base surface, or the engine stand-in), `optional` (info),
  `fallback:<role>` (warn), `pairs` (no low: info; low heavier: warn), `assets` (missing/not a model/unreadable/no node:
  err), `digests` (unknown digest: warn), `pivot` (not touching its cell: err), `fit` (past ±0.5 m: warn), `joins`
  (different outlines: warn; unnamed end: info), `budget` (info: triangles per piece and kit, textures; never capped),
  `trim:T1–T10` only with `trimLayout`, titled "(draft layout)" (T9 info: the kit format names no texture set). Backend
  `voxel-kit-problems.ts`: on load and after kit/asset changes, warn/err rows → problems log code `voxel_kit_check`,
  repeated per-case rows folded into one line a rule. Boundary: backend value subpath `voxel-kit-check` (own entry).
- **Test scene:** `@thirdlight/voxel` `kit-test-scene.ts` (`kitTestScene(rules, {origin, material})`): per (case, role)
  a window the matcher resolves to the case (readable fillers + the rule's cells first, else seeded random windows cut
  down cell by cell), realised voxel for voxel, centres 7 cells apart in a box first emptied; each label's case and
  run section from the real case + run passes (checked before it is handed out). Workspace op `writeKitTestScene`
  {world, origin, material} (VOXEL_WORLD_OPS: editor, MCP, HTTP alike): the box dug, one `set` a voxel, one history
  entry, cells = cells that end different (the same scene again: `no_change`), answer `scene {min, max, labels}`.
  Slice page `?kitScene=x,y,z,material` / hook `writeKitScene` labels each exhibit (role · case · section).
- **Numbers** (Node, 2026-11-04 06:15): 53 exhibits, box 98 × 7 × 49 cells, 1,432 voxels in 10 `set`s + 1 dig (11.8 kB of
  commands); sections at the labels single 51, body 2; generation 31 ms cold, 4–13 ms warm. Default kit checked from its
  boxes: 30 rows (5 ok, 21 warn, 4 info, 0 err), 29 pieces, 408 triangles high, 0 low, no textures; check p50 0.11 ms.
- **Tests:** `voxel-kit-check.test.ts` (6: a full kit passes; the default kit has no err; each rule fires alone on its
  broken kit; T1–T8 each fire on their own fault and a good strip passes; GLB facts read from bytes);
  `tools/voxel-bench/kit-test-scene.test.ts` (3: every (case, role) reached; written into a busy random world across
  chunk faces, each label's cell gets its case and section, and the real derive with a full test kit draws that case's
  and section's piece); `voxel-world.test.ts` (+2, real backend: a broken kit's rows in GET …/problems and MCP
  tl_diagnostics, mended kit no err; the scene command, files read back by range: every label derives as labelled,
  `no_change` again, one undo restores the world); e2e `voxel-world.e2e.ts` (webgpu test extended: scene written,
  labels on screen, wall-top/end/corner exhibits draw the default kit's pieces, undone).
- **Looked at** (staging slice, WebGPU only, 1280 × 720, 2026-11-04 06:31, load 1.5, uptime 11.6 d; shots in
  `~/.cache/thirdlight-phase46/work/46c.8/shots`): the scene written at [-20, 106, -10] in timber (1,432 cells, visible
  231 ms after the send), then undone. Seen: a row a role, each exhibit labelled role · case · section above it, the
  default kit's pieces (copings, end boards, corner posts, edge bands, opening frames) on the labelled cells with the
  debug texture; exhibits are blocky (the generator's readable fillers: a face of the role with the front open), and
  opening exhibits are bare frames around open cells. Labels hide past 30 m, so the overview shows none. WebGL 2
  not looked at (unverified there).
- **Gate:** gate-fast-20261104-061226 RED on one e2e assertion (the reload picture: the scene's labels were still on
  the page and the camera was not put back; fixed in the test with `clearKitScene` and the opening view, not a bound);
  rerun gate-rerun-20261104-062824 GREEN (perf at the cap 0 missed both renderers, 6.22 / 3.99 ms). vitest 840 files.
  `voxel-world.e2e.ts`: 7 tests sum 60.9 s (55.6 s at 46c.7; the scene step ~0.8 s in the webgpu stream test).

### 46c.9 two placeholder kits (log, stone)

- **Built:** `tools/voxel-bench/kits/make_placeholder_kits.py` (Blender 5.2.2 headless, 4 GB scope; `--dry-run` under plain
  Python checks the geometry and layout fit without Blender): pieces as extrusions of small profiles along one axis
  (x runs; y for posts; z for a corner's crossing stubs), only faces that can show (backs against the voxel body left
  out), smooth normals on round members, flat on cut faces, no bakes (placeholder: nothing fine to bake); one GLB a kit,
  a node a piece (`<case>_<section>_v<k>_<high|low>`, all at the origin; a low equal to its high shares the mesh), and
  its kit record (`log.voxelkit.json`, `stone.voxelkit.json`: kitFormat 1, digest of the GLB, materials log 11/14
  (timber, plank), stone 10/15 (stone, brick), join profiles, `trimLayout: detail-trim`, opaque game data). Output is
  deterministic (the stone GLB's digest was the same across reruns with unchanged geometry). `run.mjs kits`
  (`kits-cli.ts`): GLBs into the project's `assets/kits`, `importAssets`, "check files" (a regenerated file becomes a
  new version), `setVoxelKit` with the imported asset id, the backend's kit-check problem rows printed.
  Three-adapter `voxel-trim-debug-texture.ts`: a kit naming a known trim layout draws untinted with that layout's
  debug set (1024², the low tier: a hue and id a region, 3.125 cm checker, U ticks every 0.125 m and the cell number
  every 0.5 m, gutters/reserved magenta), generated once per layout; other kits keep the cell debug texture. Kit check
  fixes found by these kits: **T6** measured all of a region's cap triangles in a mesh as one box (both ends of a beam,
  two rail poles: a false warn); it now measures each end face (triangles sharing a corner). **T8** compared the x
  planes for every case; it now meets sections along the case's run axis (y for wall ends, corners, jambs) and skips
  cases without a run.
- **Asset table** (triangles per piece high / low; the GLB holds both levels; textures: none embedded, the debug set is
  generated at runtime, 1024² RGBA8 4 MiB + mips once a layout, shared by every trim kit; collision, nav and light from
  each case's declared shape, never these meshes):
  | log (wood) | high / low | stone | high / low |
  |---|---|---|---|
  | wall-plain body (two half-logs Ø 0.24, S50) | 32 / 12 | wall-plain body ×2 variants (two ashlar courses, S25p faces, joint staggered) | 22 / 22 each |
  | wall-top body ×2 variants (half-log Ø 0.40 / 0.36, F1) | 16 / 6 | wall-top body (coping: S50 top, S12p drips) | 10 / 10 |
  | wall-top start / end ×2 (end grain C50a, 7 cm overhang) | 25 / 10 | wall-top start / end (cap C50a) | 16 / 16 |
  | wall-top single ×2 | 34 / 14 | wall-top single | 22 / 22 |
  | wall-end body (two stubs Ø 0.22 out of the end, C25a) | 60 / 30 | wall-end body (quoins, S25p, returns) | 44 / 44 |
  | wall-corner body (crossing stubs x and z) | 60 / 30 | wall-corner body (quoins long/short a course) | 32 / 32 |
  | beam body / start / end / single (log Ø 0.32, F1, C50a) | 24 / 12, 36 / 18, 36 / 18, 48 / 24 | moulding body / start / end (cornice S12p) | 8 / 8, 10 / 10, 10 / 10 |
  | banister-rail body / start / end / single (two poles Ø 0.08, S25, C12a) | 32 / 16, 48 / 24, 48 / 24, 64 / 32 | wall-base, foundation-skirt body (plinth S50p) | 6 / 6 each |
  | banister-post body (Ø 0.14 post, F1, top C25a) | 30 / 15 | opening-jamb, -head, -sill, -threshold body | 6 / 6 each |
  | running-board body / start / end (S12p front) | 6 / 6, 8 / 8, 8 / 8 | opening-single body (head, sill, two jambs) | 24 / 24 |
  | moulding body / start / end; foundation-skirt; soffit body | 4 / 4, 6 / 6, 6 / 6; 6 / 6; 6 / 6 | | |
  | **total, 28 pieces; GLB 92,956 B; record 14,716 B (9,949 compact)** | 768 / 385 | **total, 18 pieces; GLB 32,436 B; record 9,550 B (6,598)** | 272 / 272 |

  Flat-faced pieces' low is their high (nothing to drop without changing a face's region, T7); round members halve
  their sides. Kit check (vitest and staging Problems): **0 err**; ok: catalogue, pairs, assets, pivot, fit, trim T1–T8;
  warn: the required cases the kits leave to the role fallback, base surface or stand-ins (log 32, stone 30) and 6
  role fallbacks each (floor, roof, foundation, stair, pillar, opening); info: optional cases, unchecked joins (log 6,
  stone 10), budget, T9 (no texture set yet), T10 (log 9 regions, stone 8).
- **Tests:** `tools/voxel-bench/placeholder-kits.test.ts` (6, both kits: the committed record validates and names the
  committed GLB's digest; every node read by the project model's GLB reader passes the kit check with no err and T1–T8
  ok; every node through the renderer's loader port (three's GLTFLoader) ready with the same triangles and UVs);
  `voxel-kit-check.test.ts` +1 test and one T6 case (two end faces of one mesh each checked alone; a wall end's sections
  meet up y, never across x); `voxel-kit-pieces.test.ts` +1 (the trim debug set: magenta gutters, a distinct hue a
  region; trim kits share one material on it, others keep the cell texture).
- **Looked at** (staging slice, 1280 × 720, both renderers, 2026-11-04 06:53–06:57, load 2.0, uptime 11.6 d; shots
  `~/.cache/thirdlight-phase46/acceptance/46c/kits/`, script beside them): the kit test scene written in timber (log)
  and in stone at [-20, 106, -10], 1,432 cells, visible in 182–235 ms, undone after; every one of the kit's cases'
  exhibit cells draws the kit's own piece (log 20 exhibits, stone 18; the cases a kit lacks show its wall-plain
  fallback or the default stand-ins), all 92 meshes ready on both renderers, no page errors. Seen on both: half-log
  courses, top logs with green C50 end grain, log stubs with blue C25 caps, yellow S25 rail poles and a pink F1 post,
  stone copings (green S50 tops), olive S25p ashlar courses, quoins, red F1 jambs and frames round open cells; region
  ids legible. **Not right yet, for 46c.10/46d:** every cell shows U 0–0.125 of the sheet (cell number 0): the renderer
  does not add the run offset from the instance's cell (draft §5), and mirrored instances show the debug text
  mirrored (§5's mirrored U is not applied either); opening exhibits are frames round open cells with no wall
  (the generator's fillers), so frames float there.
- **Gate:** fast gate gate-fast-20261104-065848 GREEN (12 min, peak 4.9 GB; vitest 841 files; 36 e2e; perf at the cap
  0 missed both renderers, 5.87 / 4.01 ms). `voxel-world.e2e.ts` untouched (browser behaviour seen on staging): its 7
  tests sum 60.5 s (60.9 s at 46c.8). Staging keeps both kits in voxel-slice (`assets/kits`, set) for 46c.10; the slice
  world needs no regenerating.

### 46c.10 prototype scene on staging (§7a list)

- **The lead's observation** (`acceptance/46c/kits/log-wall-corner-webgpu.png`: log ends out of the middle of faces,
  logs laid across faces): **both (a) and (b)**. (a), a placement bug: built as a real one-cell-thick house through the
  real derive with the committed kits (`tools/voxel-bench/kit-house.test.ts`), the plain wall had no rule, so its
  fallback took the window's *key* fold, whose front could face along the wall: in the probe every plain cell of the
  house pointed its front along its wall, so the log kit's half-logs (and the stone kit's ashlar, 2 cm into the next
  cell) lay on a face against the neighbouring wall cell; `wall-lintel`, `wall-sill`, `opening-threshold`/`-sill`/`-head` left the front free the same way (stone frames
  ran across the wall). The instancer, pivots and turn convention (a turn takes +x to +z, mirror first) were right.
  (b): the remaining stubs in the test-scene shots are `wall-corner` pieces on the blocky exhibits' many outside
  vertical edges (the generator's fillers), which a real wall does not have.
- **Fixed (catalogue `cases-draft` v3 → v4, DRAFT; `kits` v3 → v5; derived layout unchanged, spec §3.7 versions):**
  `wall-plain` gets a lowest rule "front open"; lintels and sills name their front open, opening tops/bottoms their
  front air; new case `wall-thin` (open in front and behind, priority above the plinth): a one-cell-thick wall's piece
  dresses both faces (one face only made the dressed side flip wherever the window changed). Kits: log `wall-thin`
  (half-logs both faces) and two-faced `wall-end`, stone `wall-thin` (2 variants); regenerated in Blender: log 29
  pieces, 896 / 433 triangles high / low, GLB 104,700 B; stone 20 pieces, 360 / 360, 40,276 B; no textures (the
  runtime debug set). Default kit: `wall-thin` none.
- **Trim U along runs (46c.9's "not right yet"):** `three-adapter` `voxel-trim-u.ts`: a trim kit's run faces (not end-on
  to the piece's x, not in a cap region; flagged per triangle, mesh non-indexed) read U' = offset + factor × U from a
  per-instance `pieceU` (offset = world coordinate along the run × 0.25 / m, modulo the sheet in 64 bits; factor ±
  the cell's size in level-0 cells), U growing along the world's positive axis. Seen on staging: cells along a run
  show 0…7 of the 4 m sheet and continue across chunk faces. **Mirrored debug text is kept, by design** (decision log).
- **Tests:** `kit-house.test.ts` (new, 9): the log and stone house (7 m and 5 m runs, 4 corners, a T with a free end,
  door, window) through the real derive and the GLBs: no piece triangle stands inside a solid neighbour (5 of its 7
  tests fail with the front rules taken out), thin cells `wall-thin` running along their wall (foot included), lintel/sill/jamb fronts on the
  wall face, corners' +x/+z on the two open sides, the T's end out of its end, stone frames in the wall plane; the
  drawn view (real loader port, chunk view): every run-face vertex of every instance reads U = 0.25 × its world
  coordinate (≤ 0.0025), ≥ 8 distinct offsets. `kit-cases`, `kit-test-scene`, `derived` expectations follow the meaning
  step (45.7b's one-cell wall is `wall-thin`; 46 cases; `kits` v5).
- **§7a list on staging** (1280 × 720 at the 60 Hz cap, both renderers, 2026-11-04 07:54–08:03, load 1.1–5.5, uptime
  11.6 d; shots and script `~/.cache/thirdlight-phase46/acceptance/46c/proto/`, every edit undone after): a pad at
  x −76…−28, z 14…58 (crossing chunk faces x −64, −32 and z 32) with the log house, the stone house, a 20 m log and a
  20 m stone wall and the wall-beam-banister scene rebuilt on it (the slice's own scene is dug by earlier runs). Every
  shot below was looked at on both renderers; WebGPU and WebGL 2 shots match.

  | Case | Renderer | Looks right / wrong + why |
  |---|---|---|
  | Log house, thin walls (7 m, 5 m runs) | both | right: half-logs on both faces, top logs along every run, cell numbers 0–7 along the run. **Wrong:** the top course's faces, the cells round the door and window, and the corner and end cells' faces are bare base surface (one case a cell, D480; corners one U axis, D481) |
  | Outside corners | both | right: log ends out of the two open sides, alternating courses (interlock); stone quoins long/short a course |
  | T wall, inside corners | both | right: the T's free end shows its log ends into the room; inside corners meet without overlap |
  | Openings (door, window) | both | stone: jambs, head, sill and threshold in the wall plane (right after the fix). Log kit: no opening pieces (bare reveals, as authored); the wall cells round them one face only (D480) |
  | Wall ↔ beam ↔ banister | both | right: the beam a log along the wall, posts and rails on the slab; the rail grown into a wall becomes a thin log wall with a top log and end logs (2 sections derived). **Wrong:** the wall behind the beam dug, the freed beam cells are a bare bar with a top log, not a free beam (D482) |
  | Material, same kit (timber → plank, back wall) | both | right, no remesh: the swap re-sent 4 sections' shader data, mesh and derive µs 0; pieces unchanged (untinted debug set until 46d) |
  | Material, across kits (timber → stone) | both | right: the wall's pieces swap to quoins, coping and ashlar; 4 sections derived |
  | Chunk faces through a wall (x −64, −32) | both | right: pieces and U continue across the faces, no seam or gap |
  | Long 20 m wall (repetition) | both | the debug sheet repeats every 4 m as designed; the stone kit's 2 ashlar variants barely show under the debug set: repetition with real art is 46d's (unverified) |
  | Dig 2 × 2 + rebuild mid-wall | both | right: the hole's sides end with log ends, a top log under it; 42 probed cells: 0 changed farther than 5 cells while dug, 4 near, 0 changed after the rebuild (variants stable) |
  | High → low in motion (focus walked 60 → 285 m, 16 frames) | both | L0 high to 75 m, low from 90 m, none from 240 m (counts); no pop seen at L0 → L1 (stone low = high). **Wrong/unexplained:** at L1 the stone coping shows a second band beneath it (D483). Past 256 m the camera's area is not streamed with the focus that far (test set-up), so L2 was not seen |
  | Rotated grids | — | 47a's (recorded only) |

  The 400 responses in the page's console are the script's edits refused as `no_change`. Frame times were not
  measured here (46c.11).
- **Gates:** gate-fast-20261104-073018 RED (two expectations of the meaning step: `kits` version, the trim material's
  `map`), rerun gate-rerun-20261104-074303 GREEN (perf at the cap 0 missed both renderers, 5.92 / 4.10 ms) → 46a46ce6;
  gate-fast-20261104-080430 GREEN (13 min, peak 4.6 GB; `world-host.test.ts` failed once and passed alone, D484
  watch; perf 0 missed, 5.92 / 4.06 ms). `voxel-world.e2e.ts` untouched: its 7 tests sum 65.1 / 65.4 s (60.5 s at
  46c.9, load). Staging: the kits re-imported (`run.mjs kits`); the slice world needs no regenerating (no format change).

### 46c.11 measurement

- **Set-up:** staging, Iris Xe, 1280 × 720 at the 60 Hz cap, WebGPU and WebGL 2, 2 rounds (round 2 a plain repeat; all
  numbers below are the two rounds' range), 2026-11-04 08:26–08:50, load 0.7–2.3, uptime 11.7 d; script, rounds and
  `summ.py` in `~/.cache/thirdlight-phase46/work/46c.11`. Two kit configurations on the same page and world: **(a)**
  `?kits=default` (new: the engine's default kit alone, the project's kits left out) and **(b)** the project's log +
  stone kits bound (timber, plank → log; stone, brick → stone; every other material the default kit). Scenes: the
  **town** world (orbit from [256, 6, 256], 60 m, as 46c.7/46b.8b) and the **prototype houses** (46c.10's pad on the
  slice world: log house, stone house, 20 m log and stone walls; 17 commands, undone after). Per page: cold fill,
  8 s orbit (frames, `render()` CPU, GPU timestamps), state, a 160 m flight out and back at 12 m/s with a 16 m camera
  (the slice fly phase's); on the houses local blasts 1/4/8 m (×2) in the log house's back wall and local paints of
  that wall (×2 each), each read back. Measuring hooks added: `?kits=default`, `state().evaluateUs` (worker µs a
  level-0 section evaluating the rules, all sections and those drawing pieces; `VoxelStreamer.metrics().evaluateUs`),
  `state().kitBytes` (`VoxelKitMeshes.bytes()`: kit mesh arrays and texture texels held). Node: `run.mjs cases --worlds
  town,slice --rounds 3` (load 1.1, `cases.md` there).

  | | town (a) default kit | town (b) log + stone | houses (a) | houses (b) | vs §4 / earlier |
  |---|---|---|---|---|---|
  | instances drawn (L0 / L1; of them kit pieces) | 40,819 (23,198 / 17,621; 32,518) | 63,149 (40,060 / 23,089; 59,130) | 379 (379 / 0) | 1,140 (1,140 / 0) | 46c.7 town 42,548; §4 placeholder families |
  | piece draws (instanced meshes) / draw calls | 1,366 / 1,135 | 4,133 / 2,647–2,650 | 42 / 136 | 108 / 176 | 46c.7 1,420 / 1,179 |
  | after the flight: instances / piece draws | 45,560 / 1,554 | 72,089 / 4,562 | 379 / 42 | 1,140 / 108 | |
  | `render()` CPU p50 / p95 WebGPU | 7.1–7.2 / 8.0–9.5 ms | **17.4–17.5 / 19.2–19.4** | 1.2 / 2.0 | 1.8 / 2.2–2.4 | §4 town 3.0–3.2, 46c.7 8.1 |
  | `render()` CPU p50 / p95 WebGL 2 | 7.2–7.4 / 8.1–8.7 | **17.0–18.1 / 18.9–20.6** | 1.2 / 1.4–1.5 | 1.7–1.8 / 2.4–3.0 | 46c.7 7.9 |
  | GPU ms a frame WebGPU / WebGL 2 | 2.3–2.4 / 4.2 | 2.4 / 5.0–5.3 | 7.6–7.9 / 3.9–4.3 | 8.4–8.5 / 3.9–4.2 | 46c.7 town 2.6 / 3.7, slice 8.0 / 3.8 |
  | orbit frame p50 / p95, missed (> 25 ms) of ~480 | 16.7 / 16.7–16.8, 0 | **16.7 / 33.3, 40–44 WebGPU, 31–65 WebGL 2** | 16.7 / 16.7–16.8, 0 | 16.7 / 16.7–16.8, 0 | 46c.7 0 |
  | 160 m flight p95 / max, missed of ~1,618 | 16.7–16.8 / 16.8, 0 | 16.7–16.8 / 33.3–49.9, **1–3** | 16.7 / 16.8, 0 | 16.7–16.8 / 16.8, 0 | 46b.11b 0 missed |
  | flight `render()` CPU p50 / p95; level changes | 3.0–3.4 / 5.5–5.9; 100–103 | 6.3–6.8 / 11.7–12.8; 99–109 | 1.0–1.1 / 1.6–1.7; 142–148 | 1.2–1.3 / 2.0–2.1; 137–145 | |
  | stream total (derived; mips) MB, after flight | 103.7 (72.6; 28.6), 111.2 | 105.7 (74.2; 29.0), 113.4 | 62.8 (36.4; 19.9), 76.8–77.5 | 62.9 (36.5; 19.9), 77.0–78.0 | |
  | kit meshes + textures held (CPU; GPU a copy) | 0.02 + 0.35 MB | 0.64 + 5.94 MB | 0.01 + 0.35 | 0.34 (0.45 after flight) + 5.94 | |
  | page JS heap | 254–269 MB | 254–304 MB | 131–188 | 177–199 | |

  Instance buffers are not read by a hook: at 64 B a matrix (+ 8 B `pieceU` for trim pieces) the town's (b) holds about
  4.5 MB of them and (a) 2.6 MB (estimate). The 5.9 MB of (b)'s textures is the generated trim debug set (1024² RGBA8 +
  mips, 5.6 MB) beside the 256² cell debug texture; real texture sets are 46d's.
- **Case pass µs a 16³ section p50 / p95:**
  | | Node (this thread, 3 rounds) | browser workers (cold fill, 4 workers, both renderers and configs) |
  |---|---|---|
  | town, evaluation (classes + cases + runs), sections with detail cells (1,394) / drawing pieces (1,308–1,311) | 256 / 508 (46c.4 241 / 479, 46c.3 207 / 419; terrain rules alone 98 / 123) | 300 / 800–900 |
  | town, all sections (12,072 / 17,664) | 71 / 327 | 100 / 300–400 |
  | town, case extraction alone; run pass alone | 114 / 284; 35 / 54 | — |
  | slice ring, detail sections (4); prototype houses, sections drawing pieces (14) | 280 / 325 | houses 800–2,100 / 5,800–13,600 |

  Browser workers time with `performance.now()` at 100 µs resolution (no cross-origin isolation), so their numbers are
  multiples of 100. The town's piece sections read ~15–75 % over Node (workers derive four at a time beside meshes and
  consumers). The houses' 14 sections are the first sections each fresh worker derives (cold code), not a steady
  number. The case pass reads no kit: (a) and (b) time the same within the resolution.
- **Blast → shown with kits** (local, the log house's back wall, one cell thick, 4 blasts a radius per renderer and
  configuration): 1 m: 1 frame, 8 sections, main 2.5–4.1 ms, workers 7.2–11.6 ms summed; 4 m: 1 frame, 12 sections,
  main 3.1–4.6 ms, workers 8.5–15.4 ms; 8 m: **2–3 frames**, 48 sections, main 9.3–13.8 ms, workers 23.4–43.1 ms; no
  frame missed during any. (a) and (b) are the same within noise: kit pieces add no blast cost here.
- **Kit swap (cross-kit paint, the 14 × 6 back wall timber → stone, local):** (b) 1 frame every time, 4 sections derived
  whole (meshes and pieces), workers 4.4–7.3 ms summed, main 1.6–2.9 ms, page build 13–19 ms the first time (the stone
  pieces' first draws of the page) and 4–6 ms again. Same-kit paint (timber → plank): 1 frame, shader data only,
  workers 2.1–3.5 ms, main 0.4–0.7 ms. In (a) both paints are between unbound materials: shader only, 1 frame.
- **Misses and causes (recorded, not tuned; perf phase after 49 / 46d):**
  1. **Town with the log + stone kits misses the cap:** orbit p95 33.3 ms, 31–65 of ~480 frames missed, both
     renderers. Cause: `render()` CPU 17–18 ms from **4,133 piece draws** (one instanced draw a (kit piece, variant,
     mirror, level) a chunk, 46c.7's choice): the two kits give ~10.7 piece kinds a chunk or node (variants, mirrored
     copies, start/end/body sections, L0 and L1) against ~3.5 for the default kit, over 387 chunks and nodes. GPU is
     not the limit (2.4 / 5.0 ms). The close-camera flight shows fewer draws and misses 1–3 frames. Cross-chunk
     instancing, GPU culling or merged caches (46d) are the measured remedy.
  2. **Case pass over the 0.1–0.2 ms section budget** (as 46c.3): Node 256 µs p50 on detail sections, browser workers
     300 µs; cause the 40-cell window gathered and hashed for every detail cell (46c.3); catalogue v4 added +15 µs.
  3. **8 m blast 2–3 frames (R107):** the derive of 48 sections (23–43 ms of workers over 4 threads) and 9–14 ms of main
     thread; the same with the default kit only, so not a kit cost (46b.11a: 2–3 frames).
  4. **WebGPU GPU ms on the prototype pad 7.6–8.5 vs WebGL 2 3.9–4.3** in both configurations (46c.7's slice read 8.0 /
     3.8): not kit-related; unexplained, recorded as read.
- **Looked at** (`~/.cache/thirdlight-phase46/acceptance/46c/measure/`, both renderers): the town with the log + stone
  kits (WebGPU and WebGL 2 identical: log-brown timber houses, grey stone houses, roofs, verge boards); the prototype
  pad (log house of half-logs with top logs and end grain, stone house with coping and quoins, both 20 m walls); the
  4 m blast (back wall opened through to the front wall's door and window, crater in the pad); the cross-kit paint
  (the back wall in stone ashlar, coping and quoins, the side walls still log). The (a) shots (looked at, WebGL 2) show the
  base walls in their stand-in colours with the default kit's copings on top. Kit-swap and blast frames were counted, not watched in motion.
- **Gate:** fast gate gate-fast-20261104-085017 GREEN (12 min, peak 4.9 GB; vitest 843 files, `stream.test.ts` pieces test
  now also reads `evaluateUs`; 36 e2e; perf at the cap 0 missed both renderers, 5.72 / 4.12 ms). `voxel-world.e2e.ts`
  untouched: its 7 tests sum 65.8 s (65.1–65.4 s at 46c.10). Staging stopped; the pad undone (17 commands); the slice
  world needs no regenerating.

### 46c.14c review fixes

- **M1 (D486):** `wall-jamb` and `opening-jamb` name their front (`[0, 0, 1, O]` / `[0, 0, 1, A]`); catalogue
  `cases-draft` v5, `kits` v6 (no derived step: results name the rules' version). `kit-house.test.ts` gains a house two
  cells thick (door and window through both layers) for the default, log and stone kits: 36 cells pinned (jambs of both
  layers with the side toward the opening, lintels, sills) and 24 outer corner cells, the front's sign checked; it failed before
  (`4,0,2` jamb faced +z into the other layer). The one-cell house tests are unchanged and pass.
- **M2 (D487):** a run cell joined only across its own axis keeps its axis and is a `junction` (default chosen, owner to
  confirm: the reviewer's second option; turning the instance instead would leave the collision bar and the case's
  front on the old axis). Hand case in `derived.test.ts` (a z run of beams ending at a beam folded along x).
- **M3 (D488):** `collectAssetRefsV3` adds kit pins last and only for a model nothing else names (first mesh decides
  between kits); the editor reads the digest's version, else `currentVersion` (was the newest). Kit check row `pinned`
  (warn). Found while testing: a reimport **replaces** a model's version (older ones stay only while an animation
  binding names them), so a kit's digest usually goes stale (`digests` warn, current ships) rather than pinning an
  older version. Tests: `voxel-kit.test.ts` (capture rules, fails on the old code), `voxel-kit-check.test.ts`,
  integration `voxel-world.test.ts` (real backend: reimport through "check files", export with the kit alone and with a
  scene placing the model: the current version ships both times, the old digest's file does not).
- **M4 (D489, rest D495):** `glbGeometry` skips meshes under `_COL`/`_OCC` nodes with `pieces.ts` `underHelperNode`
  (the model import convention, now exported). Test GLB: render triangle + hull child + `_OCC` stand-in; fails on the
  old code.
- **M5 (D490):** `VoxelKitMeshes.gpuBytes()` goes back with every draw report (4th argument through Play's worker
  message, Play's single-thread ports, the Scene view's worker and the slice page) into `StreamPieces.gpuBytes`,
  counted whole in each world's budget (`metrics().bytes.kits`; default chosen, owner to confirm: every world on a page
  counts the shared kits, as each must leave room for them). Trim draws count 72 B an instance; a view tells
  (`rebuilt`) when waiting pieces are built and the draws, nodes and kits are reported again. Staging, town with
  log + stone, WebGPU at the cap, 1 round, 10:34, load 1.8–1.9: stream total cold **112.7 MB** (46c.11: 105.7;
  derived 74.4, mips 29.2, **kits 6.58** = 0.64 meshes + 5.94 textures), after the flight 120.7 MB (113.4). Orbit
  57 of 419 missed (D485, unchanged).
- **Lows fixed:** L1 (Scene view: a kit read finishing after the renderer was replaced or the view disposed makes no
  meshes; comment says when an edited kit shows; no test: a guard), L5 (`voxelKitMeshKey` once, the check's sections
  are `RUN_SECTION_IDS`, `WORLD_GRID_ID` in the test scene), L6 (no phase names in `cases-cli.ts`, no version history in
  the catalogue and kit rules comments, `pageAssetBytes`' doc block back on it), L7 (spec: 51 rules). **D-rows:** L2
  D491, L3 D492, L4 D493, L5 rest D494, M4 rest D495, L7 split D496, the 46c.3 case-pass miss D497; D498 watch.
- **Role spec:** this item's catalogue change leaves `role-spec-doc.test.ts` red until the draft says `cases-draft` v5
  and its `wall-jamb` and `opening-jamb` blocks are regenerated (`ROLE_SPEC_PRINT=1`; fresh blocks in
  `~/.cache/thirdlight-phase46/work/46c14c/role-spec-blocks.txt`). Not edited here (owner hard-stop draft, docs agent).
- **Gate:** fast gate gate-fast-20261104-102008 RED only on `role-spec-doc.test.ts` (above; build, lint and every other
  vitest file green, peak 4.7 GB); the gate's e2e set then run capped by hand (smoke + `voxel-world.e2e.ts` +
  `play-export.e2e.ts`, 2 workers): 36 passed, 2.9 min. `voxel-world.e2e.ts` untouched: 7 tests sum 60.8 s (65.8 s at
  46c.11). Perf step not run (no draw-path change beyond byte counts). Staging stopped; the slice world needs no
  regenerating.

### R1 edge catalogue, matcher and integrity

- **Built.** `packages/voxel/src/edge-cases.ts` (`extractEdges`, `EdgeMasks`: per cell a 20-bit piece mask + inner
  flags; `edgeCaseOf`/`edgeYawOf` per slot; owner = the one solid cell or the cell diagonal to the open one; none
  with terrain (any fill) or an `excluded` cell round it). `kit-case-catalogue.ts` rewritten: `EDGE_CASE_CATALOGUE`
  `edges-draft` v0 (DRAFT): 10 edge/corner, 5 roof-edge, 2 debris (forms keep/box until R3), beam/banister kept with
  their 10 rules (`BEAM_BANISTER_CASES/RULES`, also spread into the old draft, so no copy). `cases-draft` v5 moved
  (`git mv`) to `cases-draft-catalogue.ts`; it stays the world's catalogue until R3 draws pieces from edges, then goes
  to `archive/`. A catalogue's fallback may be `null` (no case); a role without one skips the 40-cell window when no
  rule's face cells match (exact prefilter, tested against the window path). `withEdges`/`EDGE_RULES` (`edges` v1,
  radius 2) registered; `ruleRadiusMismatches` compares edge pieces (`part: 'edge'`).
- **Integrity.** `record.ts` `CONSTRUCTION_ROLES`, `fillLevel`, `valueDensity`: the job's neighbourhood (both fill
  paths) and the mip downsample read a construction cell of any integrity as full; a construction mip parent is 15;
  a smooth add stroke of a construction role places whole blocks (≥ half covered) at 15. Derived v13 → v14 (spec
  §3.7 owner note). Slice/town write construction at 15: not regenerated.
- **Tests** (vitest, real stores/derive): `tools/voxel-bench/edge-cases.test.ts` (11): all 16 × 3 edge patterns (+
  terrain variants) and all 256 corner patterns give exactly the table's case, owner and yaw; a 12 × 8 wall gives
  rim pieces only (26/26/32 edges, 4 + 4 corners); a box house gives the expected 32/32/24 outer, 24/24/16 inner
  edges and 4 + 4 + 4 + 4 corners, inner owners floor/roof; a door adds 8 jamb edges and 2 lintel edges; terrain
  contact removes the bottom edges/corners only; a turned L-house scene (all 10 cases) gives the same pieces at
  yaw + 1 per turn; random worlds: no piece on a flat face, one a slot; wall at integrity 7 = 15 for occupancy,
  light, collision, nav, base, ground, instances and edges (`kits` and `edges`); terrain at 7 differs; mips equal.
  Plus the edge catalogue's window cases on random worlds = slow path; far-reading edge pass caught.
- **Measured** (`run.mjs cases --edges`, 6 GB scope, 2026-11-04 21:20, load 1.4, uptime 12.2 d, 3 rounds; 16³
  sections with construction): town 2,511 sections: superseded case pass alone 123 / 318 µs p50 / p95; edge
  catalogue window pass + edge pass 144 / 290 (edge pass alone 52 / 111); slice 8 sections 101 / 160 vs 131 / 195
  (50 / 69). vs 46c.3 207–479 µs (that figure is classes + cases). Still over the 0.1–0.2 ms budget: D497 open,
  numbers updated. Town edge pieces: 493,310 (out-top 177 k, out-bottom 157 k, out-vertical 54 k, in-* 89 k, corners
  16 k) on 156,969 owner cells, about 1.6 k a chunk: R3/R6 should expect instance counts near the 46c.6 full kit's.

### R2 roof mesher

- **Built.** `packages/voxel/src/roof-mesher.ts` on the derive (job reach 2 = plane cells one round the job, each
  read one cell round): `classifyRoofs` (a u32 word a plane cell: rising directions, valley, seated, eave / verge /
  ridge sides, centre ridge) and `roofSurface` (each plane cell a closed prism: top through the stair's outer corners,
  underside one cell lower or the voxel's floor where a solid cell carries it; ridge/hip/apex = lowest plane, valley
  = highest; sides that meet exactly are dropped, unequal ones leave their difference read at the segment middle;
  single-direction rows merged along the level line inside a section; every edge split at the job's corners, on a
  section face at every half-cell point). `deriveChunk` appends the planes to the base surface, `base-surface.ts`
  skips plane cells and hides nothing behind them, collision drops their boxes and carries `collision.ramps`
  (joined like the surfaces, a mesh part of the chunk body), pieces skip them; light/occupancy/nav unchanged. Edge pass
  (`edges` v2) places no piece round a plane cell. `ruleRadiusMismatches` compares roof words (`part: 'roof'`).
  `roofEdgesOf(word)` gives R3 the cases `roof-ridge/eave/gable/hip/valley` with yaw. Derived v14 → v15 (spec §3.7
  owner note). Tests updated where their reference was the stair: `base-cases.ts` naive faces treat plane cells as
  open and compare the bodies only (`bodySurface`), `case-forms.test.ts` plane cells collide as the ramp, no piece.
- **Tests** (`tools/voxel-bench/roof-mesher.test.ts`, 7, real derive, sections joined, mip nodes, real Rapier):
  gable (odd), hip (13 × 8), pyramid (9 × 9), L hip roof with a valley and a large hip: every roof cell a plane cell;
  ramps welded over all chunks closed (0 unbalanced edges), every top/underside vertex on the expected surface within
  1/1024 cell; eave/verge/ridge/hip/valley counts and yaws on hand cells; 16³ sections joined = whole chunk (area per
  normal), conformance at 16³ and 32³ chunks (world, edges, terrain rules); swept sphere and dropped capsule on all
  four within 2 cm of the plane; L1/L2 closed with 45° planes, L1 within 1.5 cells (D501); gable walls + 2 × 2
  chimney: bodies + planes closed, rays under the verge all stop at the gable face, chimney keeps its faces, no edge
  piece on plane cells; damaged (shape 7), lone and 1:2 cells keep voxel faces (1:2: every other cell, D500). The shell
  houses' L1/L2 test (gable/hip/flat, watertight, rays, silhouettes) passes with the planes.
- **Measured** (`run.mjs cases --roofs`, 6 GB scope, Node 22, 2026-11-04 22:55, load 2.3, uptime 12.2 d, 2 rounds;
  town 512², 1,070 16³ sections with plane cells, 68,244 plane cells): roof mesher (classify + planes) **188 / 403 µs**
  p50 / p95 (classify 34 / 44), whole section derive 913 / 1,396 µs; base triangles with the same cells as stair
  faces 328,168 → **302,508** with planes (113,362 of them roof, 1.66 a plane cell; collision carries the same
  triangles again). First cut was 422,924 / 337 µs: raw side strips and fans; cut by differencing at segment middles,
  pre-cancelling matched sides, typed stamps. p95 over budget: D502. Fast gate GREEN at 53c71768 (13 min,
  voxel-world.e2e.ts 62.0 s, was ~58–65; village perf 0 missed both renderers).
- **Looked at** (staging town world, the four roofs written floating at y 24 through `editVoxels` and undone after,
  1280 × 720, both renderers, 2026-11-04 22:57, load 3.8; shots `~/.cache/thirdlight-phase46/acceptance/46c-r/r2`):
  the town's gables, the hip, pyramid and L (hips meeting at the apex, the valley crease at the inner corner) draw as
  flat slopes on WebGPU and WebGL 2, no cracks seen; the gable over its walls closes (geometry); the planes and
  verges show grey bands a cell apart where the shader reads air cells above the treads (D503); the town's old
  wall pieces (cases-draft copings) still step along the verges until R3; far houses keep planes at L1. Frames were
  not measured here (R6); the town's rotated-grid houses (if any are drawn) were not identified: unverified.
- **Remaining for later items / owner:** visible T-junctions between roof planes and walls are not removed (separate
  shells meet edge to edge, unsplit); thick (2+ cell) roofs plane only the top cells (lower ones keep voxel faces);
  only 90° hips/valleys at 45°.

### R3 pieces on edges only and debris

- **Built.** `derive-pieces.ts` (`cellPieces`): a cell owns several instances, in cell order then its beam/banister
  piece (alone), its debris, its edge and corner pieces in slot order (R1's case + yaw; dropped where a cell round the
  edge is a beam or banister), its roof-edge pieces (R2's words), and a `debris-face` on each intact body face toward a
  debris cell. `WORLD_RULES = EDGE_RULES` (`edges` v3, catalogue `edges-draft` v1: 21 cases, `debris-heavy` added with
  `standIn: 'debris'`, piece table and kit check follow stand-ins). No case keeps a piece on a kept face (the
  `keep + shows` path is gone). Rotation byte bits 2–3 = placement (`INSTANCE_PLACE`: upright, faceUp, faceDown,
  centred); `roofEdgesOf` gives a ridge the yaw of its side and `centred` on a middle ridge. Variant hash + (case,
  placement, yaw). Debris: `isDebrisCell` (construction, integrity 1–14, a face open; buried damage stays a body) →
  `FORM_DEBRIS` (box for collision/light/nav/occupancy, faces left to the piece, hides no neighbour face); the edge
  pass excludes debris cells like roof plane cells. Derived v15 → v16 (spec §3.7 owner note); 8 B instance kept.
  Adapter: the view applies tip and centring (stand-in drawing kept); default kit = square stand-in boxes for the 18
  edge/roof/debris cases (bevels and aliases R3b). Page probe `kitPieces`; `kitTestExhibits` skips cases no window rule
  names (the edge catalogue took 21 s searching for them). Manual and spec updated.
- **Tests** (vitest, real derive): `kit-house.test.ts` rewritten (8): box house with door and window, a 40-cell wall,
  a floor slab: every edge piece's 4 cells 1 or 3 solid (2 diagonal) and every corner's 8 cells 1 or 7, read from
  the store; the pieces equal a brute-force list of exposed lattice edges and corners exactly (one owner each); the
  wall's flat faces none, its rim 188 edges + 8 corners; town and random worlds: no piece on a flat face, ≤ 2 an edge
  (2 only diagonal); every default stand-in box placed as the renderer places it stays in its cell or open air; a
  gable gets ridge (centred, top row), eave and verge pieces on roof cells and no edge piece round them; a wall cell at
  12 / 7 / 1 → `debris` / `debris-heavy` on it, `debris-face` on its 4 in-plane neighbours (yaws and tips checked),
  every other piece and every output but base and instances as intact; at air no debris, the same base surface,
  edge pieces round the hole; buried damage byte-equal to intact; 16³ sections joined = chunk with damage; an edit
  past the reach changes no instance. `kit-pieces.test.ts`, `kit-test-scene.test.ts`, adapter `voxel-kit-pieces.test.ts`,
  kit check, collision (balcony edge a whole block), integrity, roof words and integration tests moved to the edge
  catalogue. `role-spec-doc.test.ts` archived (pinned the reviewed draft to the superseded catalogue; R7).
- **Measured** (`run.mjs cases --pieces`, 6 GB scope, Node 22, 2026-11-04 23:46, load 1.4, uptime 12.3 d; counts are
  deterministic): whole 512² town, L0 chunks with pieces 229: instances with a full test kit **320,160 → 130,926**
  (p50 / p95 / max a chunk 1,355 / 3,012 / 3,857 → **555 / 1,267 / 1,492**), the default kit the same count (111,707
  of them its own pieces, the rest stand-ins); no kit 19,219 (beam/banister stand-ins). vs R1's 493,310 raw edge
  pieces: R2's roof planes take the stair edges (most out-top/out-bottom), and terrain contact and beams/banisters
  none. L1 nodes 62: 53,333 → **72,610** (p50 876 → 1,131): several edge pieces a 1 m cell where the old catalogue
  put one a cell (D505). Slice ring L0 152 → 110, L1 26 → 48. Table bytes one full kit 1,650 → 813 B, six 16,032 →
  7,683 B. Whole-town L0 derive 6.30 s without a kit, 6.70 s with one, 229 chunks (46c.6: 4.97 / 4.94 s at
  another hour; edge pass and pieces now in it; one run, not tuned).
  Drawn instances, draws and frames (vs 46c.11's 63.1 k drawn) are R6's.
- **Not done here (slice 2, left for the next item or a follow-up):** the superseded catalogue (`cases-draft-catalogue.ts`,
  `KIT_RULES`, the `kits` rule set) is still registered beside the world's (tests of the case window, case forms and
  `cases-cli` read it), and the `reshape` base / `slab` shape and their base-surface code stay (no case of the world's
  catalogue uses them); kit-runs needs no narrowing (it reads only the catalogue's run cases). The placeholder log /
  stone kits name the superseded cases (kit check `catalogue` err; they draw only beams and banisters until R5).
  Unverified: nothing was looked at on staging (R3b/R6).
- **Gate.** Fast gate (`voxel-world.e2e.ts`) at 6dff42ce: lint clean, vitest 844 files green, every voxel e2e green
  (voxel-world.e2e.ts 69.2 s, was 62.0 at R2: the kit test reworked, host load 2.4–3.6); `rendering.e2e.ts` render
  scale (D320 watch) failed in the gate and its first rerun at load 3.6 and passed on the second at load 0.5 (GREEN,
  village perf 0 missed both renderers). D320's row says a second failure in a row calls for its fix: noted for the
  lead (not this item's area). D480 superseded (a cell owns one piece an edge now); D481 rechecked: an edge runs
  along one axis, so one U offset an instance serves it, but `pieceU` reads the axis from the turns only (x or z), so
  vertical edges need the edge's axis in R3b; open.

## 9. Decision log

- 2026-11-03 (plan, default chosen, owner to confirm): **case reach 2 cells (Chebyshev)**, the two-voxel reach the
  Enshrouded reference describes (§7a, podcast 3:01–3:04); composed with the terrain rules the radius stays 2, so the
  job apron (3) and invalidation are unchanged. A case that needs more is measured first and grows the apron only
  with an owner note.
- 2026-11-03 (plan, default chosen, owner to confirm): **cases fold over the four yaw turns and the vertical mirror,
  never a vertical flip** (gravity distinguishes a soffit from a running board); an instance's turn bits carry the
  fold, a mirror bit takes one of the rotation byte's free flag bits.
- 2026-11-03 (plan, default chosen, owner to confirm): **case ids live only in the job**, like classes; instances
  keep 8 B: the piece u16 becomes a kit-local piece index and the reserved u16 the variant. Derived data is never
  stored, so this is a derived version step with an owner note, not a format change.
- 2026-11-03 (plan, default chosen, owner to confirm): **variants by a hash of the world cell** (and the case),
  never of load order or neighbours outside the case, so a dig/rebuild elsewhere never reshuffles a surviving piece.
- 2026-11-03 (plan, default chosen, owner to confirm): **collision, nav and light come from the case's declared
  coarse shape** (box, slab, bar, none in 1/16 cell), never from a piece mesh (R77): a kit cannot change gameplay
  shapes by its art, and every kit of a material type collides the same.
- 2026-11-03 (plan, default chosen, owner to confirm): **the material → kit binding is a test binding in 46c**
  (a table on the world), because the material model that owns it is 46d's; 46d moves it without changing kits.
- 2026-11-03 (plan, default chosen, owner to confirm): **opaque game data** (break, sound, physics defaults per kit
  and per case, a material may override in 46d) is carried and readable by scripts, never interpreted by the engine.
- 2026-11-03 (plan, default chosen, owner to confirm): **a default fallback kit** (procedural boxes and slabs from
  the case shapes) ships in the engine, so a world with no game kit, or a kit missing an optional case, still draws.
- 2026-11-03 (plan, default chosen, owner to confirm): **pieces drawn one instanced draw per (kit piece, level) a
  chunk** in 46c; merged caches, GPU culling and cross-chunk instancing are 46d's measurement.
- 2026-11-03 (plan, default chosen, owner to confirm): **placeholder kit art**: Blender is on this host, so the log
  and stone kits go through the Blender pipeline headless (§5b); if it fails at the item, a procedural script makes
  them. Their small GLBs and the generating script are committed as engine-owned test data; triangles, LOD pairs,
  texture sizes and file sizes are reported with them.
- 2026-11-03 (plan, default chosen, owner to confirm): **trim layout draft numbers** from §1d: authored 1024 px/m,
  tier caps 256/512/1024, strips 0.125/0.25/0.5 m, a cap region, U from world distance along the run; trim is a kit's
  option, the alternative (own bakes + material arrays) is described beside it.
- 2026-11-03 (lead, replaces the planner's order): **full gate before the presentation.** The owner's run ends at the
  hard stop, so 46c's one full gate, the independent review (`~/.cache/thirdlight-phase46/review-46c.md`), the High and
  Medium fixes and the acceptance shots all run before 46c.15 presents; 46c.16–46c.17 after the approval are verified
  by fast gates (no second full gate), and 46c.18 then only closes the rows.
- 2026-11-03 (lead, default chosen, owner to confirm): **kits are project content items** (add-only, canonicalized
  field by field), reusable by every world of the project; **the material → kit binding in 46c is a test binding
  inside the kit file** (the material ids it applies to), with no world or schema field; 46d's material model owns the
  real binding (§1c: a material names its kit) and replaces it.
- 2026-11-04 (46c.1, default chosen, owner to confirm): **the kit record lives in `project-model`** (`voxel-kit.ts`),
  not `@thirdlight/voxel` as §5 planned: it names model assets and uses the project's id syntax and error shape,
  which the voxel package must not import. The derive job (46c.3/46c.6) gets a plain case → piece table from it.
- 2026-11-04 (46c.1, default chosen, owner to confirm): **a mesh is `{assetId, digest, node?}`**: the model asset
  (so it ships through the content closure as every model, never a URL) plus the SHA-256 source digest of the GLB
  version the piece was made from. A build ships the version with that digest (the current one when none has it); a
  digest no version has, or an asset the project lacks, is a kit-check row (46c.8), never a refusal, and an absent
  asset ships nothing (the fallback kit draws the case). Deleting an asset is never refused for a kit.
- 2026-11-04 (46c.1, default chosen, owner to confirm): **case and section ids are opaque id-syntax strings** in the
  record; `low` is optional (the kit check reports a missing pair); join profiles are one closed outline (≥ 3 points,
  whole sixteenths 0–16) a section end names, a dangling name refused; `trimLayout` is an optional id; `version` is
  the kit's own revision; game data is JSON ≤ 32 deep (the only bound: no count caps, the 1 MiB record file cap).
- 2026-11-04 (46c.1, default chosen, owner to confirm): **no project schema bump**: `voxelKits` is a new optional
  content key (as `kits` and `timelines` were added); an older engine refuses a project holding one (unknown field).
- 2026-11-04 (46c.1, default chosen, owner to confirm): **the editor has no voxel kit page yet** (setVoxelKit and
  deleteVoxelKit are API-only in `tests/editor-op-reach.test.ts`, with the reason); its project-window icon is the
  block kit's picture copied as `voxelkit.webp` until one is drawn (unverified visually).
- 2026-11-04 (46c.2, default chosen, owner to confirm): **the case window is 40 cells of 4-bit symbols** (open,
  opening, ground, six built roles × the centre's material or another): a case sees roles and fill classes, never
  material ids, so every material of a kit gets the same cases; partly filled cells below the surface read as open.
  The key is the smallest of the 8 folds (mirror x, then quarter turns taking +x to +z); the result's transform
  places the matched pattern on the world (the fold's turn bits and a mirror bit for 46c.6).
- 2026-11-04 (46c.2, default chosen, owner to confirm): **a rule is a conjunction of window cells, each a symbol set**;
  an "or" is several rules naming one case; rules go by priority, ties in table order, each tried under all 8
  transforms; the **fallback per detail role is mandatory** and outside the rules (a catalogue missing one is
  refused). Cases carry roles, required/optional, a run axis (x, y or none) and the inferred feature they draw.
- 2026-11-04 (46c.2, default chosen, owner to confirm): **catalogue v0 is a DRAFT** (45 cases, 43 rules), the source
  of the role spec draft (46c.12); its known limits for the owner: openings resolve one frame case a cell (corners
  left to 46c.4's sections); a soffit is any floor/roof edge open below and in front (reach 2 cannot tell an eave from
  an inside stairwell edge, nor see a wall 2+ cells behind a deep eave); beams come from wall and floor cells,
  banister rails from wall cells only; a rail spanning between posts does not check its support's thickness; hip,
  valley, peak and flat-roof cases are reached by window enumeration only (no test world builds them).
- 2026-11-04 (46c.2, default chosen, owner to confirm): **a per-thread direct-mapped cache of 16,384 windows**
  (~400 KB, a memory budget, not a count) skips folding and matching for windows seen before; results are identical
  with or without it (tested on random worlds against the window path).
- 2026-11-04 (46c.3, default chosen, owner to confirm): **the case pass runs at levels 0 and 1, not from level 2**:
  a level-1 node picks its low piece by case as a chunk picks its high one (46b.9: L0 high, L1 low), and from level 2
  no piece is drawn (cells are base-surface bodies), so no case is needed there. A uniform region (one class and
  shape) draws no piece and skips the pass as well.
- 2026-11-04 (46c.3, default chosen, owner to confirm): **the case pass is an optional part of `AssemblyRuleSet`**
  (`resolveCases`, a u16 a cell beside the class byte, only inside the job), so one rule set, one radius and one
  conformance check cover classes and cases; `kits` v1 names terrain v1 + catalogue `cases-draft` v0 (a DRAFT), and a
  change to either part takes a new `kits` version. **Derived v9 → v10** with an owner note in the spec although no
  output reads cases yet, so a result of a job that resolves cases is never mixed with an older one.
- 2026-11-04 (46c.3, default chosen, owner to confirm): **the composed evaluation misses the 0.1–0.2 ms section
  budget** (town 207 µs p50 for the evaluation alone on built sections; evaluate + ground mesh 255 µs): recorded with
  its cause (results), not tuned (perf phase after 49).
- 2026-11-04 (46c.4, default chosen, owner to confirm): **U along a run is world-anchored**, not counted from the
  run's start: a cell's U is its world coordinate along the run axis × the cell size (`runU`). Counting from the start
  needs the whole run, however far past the reach and the chunk it goes, and an edit at one end would shift the texture
  of every cell after it; world-anchored U needs no reach, matches whichever chunk/section/level derives the cell, and
  keeps bays on the world grid (owner: edits never shift things far away). Its offset is the cell's own coordinate in
  its derive unit, which the instance already carries, so the job stores no U. Corners restart U on the other axis.
- 2026-11-04 (46c.4, default chosen, owner to confirm): **runs join by run group and axis**: the same inferred feature
  (beam, banister, …) or else the same case, the step along at least one of the two cells' run axes (parallel bars
  side by side never join). Sections: single/start/body/end/corner/junction; each end joined, open (exposed
  termination), butt (against a solid cell) or inner (an inside corner across the diagonal: a mitre). Start/end are by
  the piece's own −x/+x: mirror-image ends fold to one orientation, so a run's two ends are often both "end", the one
  termination piece placed mirrored. Every case with a run axis gets sections (copings, edges, eaves too), not only
  the inferred features; cases without one (posts) are single with no axis.
- 2026-11-04 (46c.4, default chosen, owner to confirm): **catalogue v1 adds the meeting cells** (rail L/T/X on a wider
  support, beam inside/outside corners, the storey line's outside corner) as rules naming the existing cases: in v0
  those cells fell to wall cases and every run stopped one cell short of its corner. Known limits for the owner: beam
  T junctions do not arise (a beam needs a wall behind); rails on posts over gaps do not turn corners (only on a wider
  support); a running board's inside corner and a soffit's inside corner are mitres (`inner`), copings stop against
  `wall-corner` cells (butt).
- 2026-11-04 (46c.5, default chosen, owner to confirm): **a case declares one coarse shape box and a base mode**
  (keep / suppress / reshape) in the catalogue, the role spec's vocabulary, not the kit's: shapes box, slab (upper
  half), panel (z 6–10/16), bar (y, z 3–13/16), post (x, z 6–10/16), none. Every consumer reads it (light = its
  share of the cell, supports = it covers the top); cells without a case keep their class's form, which is the
  placeholder shapes unchanged, so levels ≥ 2 and rule sets without a case pass behave as before but for light.
- 2026-11-04 (46c.5, default chosen, owner to confirm): **"reshape" means the base surface draws the declared shape
  itself** (a soffit's underside raised to half the cell, no piece needed to close it), not a hole for a piece:
  suppress is the piece's mode. Its quads meet the merged faces with a T-junction only where a sub-cell corner
  touches a face (the slab's underside against the wall or floor behind), as a piece standing on a face does.
- 2026-11-04 (46c.5, default chosen, owner to confirm): **soffit = reshape/slab (upper half)**: the only reshaping
  case in draft v2; a balcony or flat-roof overhang edge is now a 0.25 m slab where it is open below and in front
  (town: +3.3 % derived bytes). Mouldings, running boards, skirts, copings stay keep/box (their pieces add on in
  46c.6); openings keep/none.
- 2026-11-04 (46c.5, default chosen, owner to confirm): **light coverage from the declared shape**: beam 128 → 100,
  rail 51 → 64, post 51 → 16, slab 128 (was the placeholder 128/51/51 per class).
- 2026-11-04 (46c.5, default chosen, owner to confirm): **pieces until 46c.6** stay the placeholder families, now
  chosen by the suppressed case's shape (bar → beam, panel → rail, post → post) with the run pass's section (corner
  and junction drawn as body: the u16 piece has 2 section bits until kit-local pieces) and the case's quarter turns.
- 2026-11-04 (46c.6, default chosen, owner to confirm): **piece indices are kit-local**, the engine's default pieces
  first (below 32, the same in every kit) and the instance's kit is its cell's material's. A table-wide numbering
  would shift every kit after one that gains a piece, re-deriving chunks of unrelated kits; kit-local numbers keep
  "a kit change re-derives only its materials' chunks" exact. The renderer (46c.7) reads the material from the shader
  data as it already does for colour.
- 2026-11-04 (46c.6, default chosen, owner to confirm): **the mirror bit is bit 15 of the variant word**, not one of the
  rotation byte's free flags (the earlier plan line): the lead's item brief put it there, and it keeps the rotation
  byte's meaning unchanged; the variant has 15 bits.
- 2026-11-04 (46c.6, default chosen, owner to confirm): **missing pieces**: the case's section, its body, its single;
  then the role's fallback case only when it declares the same base and shape; then the engine default where the base
  is suppressed, nothing where the base surface draws the cell. A kit's piece on a kept cell is drawn only where the
  cell shows (no pieces inside masses or for `enclosed`). The variant seed is a hash of the kit's id, so a kit's
  revision never reshuffles variants.
- 2026-11-04 (46c.6, default chosen, owner to confirm): **with a kit bound, a material paint rebuilds meshes too**: a
  paint can move cells to another kit's pieces, so `fieldsFeed`'s shader-only rule (owner: material/wetness never
  remesh) holds only while no kit binds a material. With kits, a material or wetness change re-derives the sections
  within R as a shape change does (wetness included: the streamer cannot tell them apart in a refresh). Alternative
  for the owner: pieces resolved per kit at draw time from the material (no derive), at the cost of the derive no
  longer choosing variants by weight per kit.
- 2026-11-04 (46c.6b, lead fix, supersedes the 46c.6 entry above): **the owner's feeds rule holds with kits bound**:
  wetness never re-derives meshes or instances; a material paint within one kit is shader data only (pieces and
  variants read the material only through its kit). **For the owner: a material paint that changes the cell's kit
  DOES change geometry** (sections holding the painted cells, nothing within R): by design, since kits are per
  material type (§1), a stone wall painted timber must draw timber pieces. It is the one exception to "material →
  shader data only", proposed for the owner. Alternative: resolve pieces at draw time (instances carry a
  kit-independent case + section + cell hash; the renderer maps material → kit → piece per frame or per material
  change). Costs: the derive no longer knows which kit pieces exist (missing-piece fallbacks, kept cells' pieces only
  where they show, and per-kit variant weights move to the renderer, per instance on the GPU or in a CPU pass per
  paint); instance lists grow to every cell any kit might draw; the low/high choice per level and kit checks at
  derive time are lost. Default chosen (owner to confirm): the derive-time exception.
- 2026-11-04 (46c.6b, default chosen, owner to confirm): **the same-material bit only where a rule reads it**: the
  draft catalogue has no rule telling the centre's material from another, but the bit decided which transform a
  symmetric window took, so a material paint (shader-only) could turn or mirror its neighbours' pieces without
  re-deriving them (D478). A catalogue whose rules read the bit (a future role spec) makes material paints feed
  geometry: the owner should keep the role spec free of material-reading rules, or accept that exception.
- 2026-11-04 (46c.6b): **level-1+ nodes still derive whole on any edit** (paints and wetness included): a mip node
  has no shader-only derive (46b design); out of this fix's scope, D479 (proposed for 46d with the per-level shader).
- 2026-11-04 (46c.6, default chosen, owner to confirm): **the piece table is not stored in a result**: staleness is
  carried by the stamps of what a table change re-derives; results of untouched chunks are the same under both tables.

- 2026-11-04 (46c.7, default chosen, owner to confirm): **the default kit binds every material no kit binds** through
  a default-kit slot in the piece table (format 2), not a 4,095-pair binding list (16 KB a job); its pieces add to kept
  bases only (copings, plinths, sills, edges, mouldings, skirts, frames); suppressed cases (beam, rail, post) stay the
  engine's stand-in pieces, which every kit falls back to. A paint between two unbound materials stays shader data.
- 2026-11-04 (46c.7, default chosen, owner to confirm): **one instanced draw a (kit piece, variant, mirror, level) a
  chunk**: variants and mirrors are separate meshes (a mirrored copy keeps instance matrices unmirrored, so culling
  and winding stay right); symmetric default pieces share their unmirrored draw. Cost recorded (town 1,420 piece
  draws); cross-chunk instancing is 46d's.
- 2026-11-04 (46c.7, default chosen, owner to confirm): **kit meshes stay loaded while the page has them** (a few dozen
  a project); a table change keeps untouched chunks on the meshes they were built with until derived again; a mesh
  still loading draws when it arrives, a failed one draws nothing (the slice page's status names it). The Scene view
  reads the kits once a world opens: a kit edited while it is open shows after the world is opened again.
- 2026-11-04 (46c.7, default chosen, owner to confirm): **kit pieces draw with a stand-in tint a kit and the debug UV
  texture**, not the cell's material colour: a same-kit material paint is shader data only and builds no piece, so
  pieces follow materials when 46d's material model gives them their own.

- 2026-11-04 (46c.8, default chosen, owner to confirm): **kit check lives in `project-model`** (`voxel-kit-check.ts`, not
  `@thirdlight/voxel`): it reads the kit record and GLB geometry the project model owns; it takes the catalogue from the
  voxel package. **No err for a missing required case**: every case is drawn by something (kit fallback, base surface,
  engine stand-in), so a missing one is a warn naming which; err is for what draws wrong or not at all (unknown
  case/section, missing or unreadable mesh, pivot off the cell, trim T1/T2/T4). "Passes" = no err.
- 2026-11-04 (46c.8, default chosen, owner to confirm): **cell envelope ±0.5 m** (the cell plus half a cell round it):
  trims may overhang (the default kit's finial reaches +6/16); past that a warn. Trim B checks (UV1 for own bakes) are
  not built: the draft lists them, the brief limits trim rows to opted-in kits.
- 2026-11-04 (46c.8, default chosen, owner to confirm): **the test scene is a voxel world op `writeKitTestScene`**
  (one undoable change, no edit-format change), one exhibit a (case, role) pair generated from the catalogue rather
  than hand-built, one labelled cell each (run sections shown are what the derive gives: mostly single; a run of every
  section per case is not laid out). Labels are not stored: the page recomputes them from the same pure generator.

- 2026-11-04 (46c.9, default chosen, owner to confirm): **the placeholder kits are made in Blender headless from a
  committed Python script** (geometry computed in the script, Blender builds the meshes and writes the GLB with its
  glTF exporter), engine-owned test data in `tools/voxel-bench/kits/`; the art-factory `bp` library is not used (this
  repo never depends on or edits art-factory). One GLB a kit, a node a piece; game kits may split files as they like.
- 2026-11-04 (46c.9, default chosen, owner to confirm): **faces end-on to x take U across them from z**, and a vertical
  run (post, quoin, wall end) maps its faces planar with U from x, V up the piece: the kit check's T4 reads the run
  along x only, where the draft (§5) says "U up the post". The draft and T4 disagree for runs up y; for the owner:
  either T4 learns the case's run axis (U from y on y runs) or §5 says vertical members map planar.
- 2026-11-04 (46c.9, default chosen, owner to confirm): **the draft's region sizes force odd member sizes**: a face must
  be half a texel inside its band, so a full 0.5 m cell height does not fit S50 (posts and jambs use F1), a 0.125 m
  board is 0.124 m, a log wrapping F1 is a 12-gon of perimeter 0.99 m (Ø 0.32 m nominal), and a cap is at most its cell
  less a texel. For the owner (draft question 1/5): size bands with a texel to spare, or accept these.
- 2026-11-04 (46c.9, lead-scope fix): **T6 per end face, T8 along the run axis** (kit check; tests added): both were
  false warnings on valid placeholder pieces, not widened bounds.
- 2026-11-04 (46c.9, default chosen, owner to confirm): **a trim kit draws with its layout's generated debug set**
  (adapter, until 46d's material model gives texture sets), untinted so the region hues read; the run U offset and the
  mirrored U of draft §5 are not applied by the renderer yet (46d, with the material model).

- 2026-11-04 (46c.10, default chosen, owner to confirm): **a fallback case names its front by a rule** (lowest priority:
  "front open"), and every case whose piece shows on its front names that front: a fallback took the window's key
  fold, which is arbitrary, and a rule without a front lets the matcher pick any turn that fits. Proposed for the
  role spec: "a case whose piece shows on a face names the face in its rule".
- 2026-11-04 (46c.10, default chosen, owner to confirm): **`wall-thin`** (a one-cell-thick wall, open in front and
  behind; above the plinth) is a case of the draft, required: no (a kit without it draws its plain piece on one face).
  A thin wall with a second feature (top, opening surround, end, corner) still dresses one face or none (D480): the
  owner chooses between thin variants of those cases and per-face pieces in the role spec.
- 2026-11-04 (46c.10, default chosen, owner to confirm): **trim U grows along the world's positive axis**, not along
  each piece's +x: cells of one run placed with different turns or mirrors (symmetric cases) meet without a seam. The
  cost: debug text reads mirrored on faces seen from the negative side (no reading direction in real trim art). This
  refines the trim draft §5's mirrored-U rule (which made U follow each piece) for the owner's review.

- 2026-11-04 (46c review, independent, range 6ffc2031..9107abbd; fixes 46c.14c): **0 H, 6 M, 8 L.** M1 jamb without a
  front, M2 a run cell's section on another axis than its piece, M3 a kit pin moving other references, M4 hulls drawn,
  M5 kits outside the stream budget: fixed (D486–D490). M6 (the trim draft against the built kits, two owner questions,
  a doc test): docs agent, in the drafts. Lows: L1, L5 (part), L6, L7 (count) fixed; L2–L4, L5 rest, L7 split, M4 rest
  and the 46c.3 case-pass miss as D491–D497. L8 (tests reading `LIGHT_COVERAGE`, the trim tests' hand facts) recorded,
  no change. Hard stop clean. For the owner's eyes: the cross-kit paint exception, D485 town draws, the role spec gaps
  D480–D482 and its 15 questions, `kitFormat: 1` stored as a draft (a changed case list gives "unknown case" rows,
  not a migration).

- 2026-11-03 (lead): **art-factory graphs and the Kit Designer** come only through a request doc
  (`docs/requests/art-factory-<date>.md`); this repo never edits art-factory. Blender templates per role ship in this
  repo's authoring package (46c.17).

- 2026-11-04 (OWNER, after reviewing acc46c; replaces the 46c case approach): **walls and floors are plain voxel faces;
  detail meshes only where faces meet.** The 46c build dressed every wall cell (logs over flat walls) and grew a
  46-case role catalogue; that drifted from the 2026-10-27 rule "flat-wall cases get no piece". Revised direction:
  (1) **edge cases, small list** (start; extend only if needed; many share one mesh rotated): outer edge top /
  vertical / bottom, inner edge, outer corner, inner corner, plus the roof edges below; each per 0.5 m voxel with a
  little hashed stagger, no merged run geometry; far = flat square voxels, near = edge pieces + material relief.
  (2) **Roofs get their own mesher** (role roof): flat sloped planes over the stair-step voxels with tileable
  materials, like the terrain mesher is for terrain; detail pieces only at ridge, eave, gable edge, hip and valley.
  The stair-step voxels stay the data for lighting, occlusion and collision. (3) **Construction UVs are anchored to
  the grid in metres** with the tiling textures authored to the defined full-size wall, so a detail band sits at the
  same height on every wall and floor (material model, 46d). (4) **Beams and banisters stay as planned** until the
  system is solid. (5) **Ground-contact fringe and all ground scatter belong to the terrain material's runtime
  scatter rules** (keyed on the terrain voxel's material id, with the climate field's temperature/humidity), in the
  phase that builds the terrain tools and dressing (47b; plan-45 §7a "deferred material-driven terrain dressing"),
  not to building kits. (6) **Far field: no arbitrary draw cut-off** — mountains must be visible from several km;
  this needs extremely cheap chunk/region stand-ins at distance (Enshrouded's brick renderer is the reference);
  a requirement for 46d's far field (D463). (7) **Damage display:** when a game damages a voxel enough, the cell is
  replaced by debris: every neighbour face that opens toward the damaged cell gets broken-piece detail meshes; when
  fully broken the cell disappears (or the seam moves to the next damaged cell). The engine shows damage states;
  when and how much damage is game logic. Next: a 46c revision (case catalogue, roof mesher, kits, role spec and
  trim drafts re-done), then re-present.

- 2026-11-04 (OWNER): **construction tiling textures are authored to a 4 × 4 m full wall**: one texture repeat = one
  full-size wall (4 m) in both directions, anchored to the build grid in metres, floors on the same grid (46d material
  model; replaces the trim draft's 4 m U period / 1 m field assumptions for base surfaces).

- 2026-11-04 (OWNER): **damage uses the shape field, no new bits.** Shape means fill for terrain, fill level for
  liquid, and **integrity for construction roles** (15 intact; lower = damage stages, as many as the game uses; fully
  broken = air). The engine has no "damage" value: construction rules read shape < 15 and draw the cell as debris
  pieces and the neighbour faces opening toward it as debris; a damaged cell stays solid for collision/light until
  it becomes air. What lowers it and when is game logic. No format change; the 9 reserved bits stay free (O15
  shoreline first). Consequences: shape readers for construction (mips, case window, collision/light) are role-aware;
  digs and damage share the saved shape field; a construction cell placed over terrain is written at shape 15.

- 2026-11-04 (revision plan, default chosen, owner to confirm): **the detail unit is the 0.5 m lattice edge and the
  lattice corner**, not the cell: an edge's case comes from its 4 cells (1 solid = outer, 3 = inner, 2 side by side =
  flat, no piece), a corner's from its 8; top / vertical / bottom by gravity, yaw turns only (no vertical flip in the
  case; a kit may alias a flipped mesh). Terrain counts as solid; an edge touching terrain gets no piece (47b's
  fringe). 10 edge/corner + 5 roof-edge + 2 debris + beam/banister 3 = 20 cases.
- 2026-11-04 (revision plan, default chosen, owner to confirm): **an edge piece belongs to one cell's material**:
  outer edges the one solid cell, inner edges the cell diagonal to the open one, ties by role priority then the lower
  material id; a flat seam between two materials gets no piece (the shader blend draws it).
- 2026-11-04 (revision plan, default chosen, owner to confirm): **edge pieces span the full 0.5 m, corners are their
  own pieces over the vertex**; mixed corners (outer and inner edges meeting) get none; pieces sit over the square
  base edges (no chamfer until 46d's relief). Stagger from the variant hash in the adapter: ≤ 1/32 cell out, ≤ 2°
  twist, stable per cell.
- 2026-11-04 (revision plan, default chosen, owner to confirm): **roof mesher**: 45° stairs only, top plane through
  the stair's outer corners, underside through its inner corners, planes stop at non-roof built neighbours, unclassified
  roof cells keep voxel faces; it runs at every level (planes read better than stairs far away; pieces still
  L0/L1 only). Collision, light and occlusion stay the voxels (owner); the visual gap on treads is shown, not fixed.
- 2026-11-04 (revision plan, default chosen, owner to confirm): **debris stages**: shape 15 intact, 8–14 and 1–7 two
  debris pieces a kit (a kit may author fewer: the lower stage falls back to the higher), the damaged cell's base
  faces suppressed, intact neighbour faces toward it drawn with a `debris-face` piece; the cell stays solid for
  collision and light until it is air (owner).
- 2026-11-04 (revision plan, default chosen, owner to confirm): **minimal UV part now**: the existing grid-anchored
  world projection with a per-material repeat (construction 4 m, terrain 2 m), a debug band pattern under `?bands=1`,
  and a slope projection flag for roof materials; texture arrays, relief and the real material model stay 46d.
- 2026-11-04 (revision plan, default chosen, owner to confirm): **kitFormat 1 stays the draft format**; the case ids
  change (opaque strings, so old kits give "unknown case" rows) and a case may alias another case's mesh with one of the
  24 cube rotations (add-only optional field, canonicalized field by field).
- 2026-11-04 (revision plan, default chosen, owner to confirm): **one full gate for 46c, after approval**: 46c.14b's
  full gate and independent review were not run; running them now and again after the owner's changes would run the
  full gate twice, so the revision closes on fast gates (R9) and 46c.14b runs once after approval, before 46c.18.
- 2026-11-04 (revision plan, default chosen, owner to confirm): **retired code is removed in place where a file is
  rewritten and `git mv`'d to `archive/` where a whole file or reviewed draft goes** (§6b list); the reviewed role spec
  and trim drafts stay readable in `archive/architecture/`.

- 2026-11-04 (R1, default chosen, owner to confirm): **the world's rule set stays `kits` (cases-draft v5) until R3**:
  switching now would leave walls without any piece and break the kit check, test scene, placeholder kits and e2e
  kit expectations that R3/R3b/R5 rebuild; the edge catalogue and pass are built, registered and tested beside it.
- 2026-11-04 (R1, default chosen, owner to confirm): **a mip parent of construction is intact (15)**: damage stages
  show at level 0 only; an L1 debris stage would need a min-integrity rule.
- 2026-11-04 (R1, default chosen, owner to confirm): **terrain with any fill blocks an edge piece** (not only
  terrain at the surface), so partial ground cells beside a wall foot give no piece (47b's fringe there).
- 2026-11-04 (R1, default chosen, owner to confirm): **required edge cases**: outer edges and outer corners required,
  inner edges/corners, roof valley and debris optional (a kit may leave inner seams plain).
- 2026-11-04 (R1, default chosen, owner to confirm): **smooth construction strokes place whole blocks** (cells at
  least half covered, integrity 15): a fill level would now read as damage.

- 2026-11-04 (R2, lead note + owner 2026-10-27 "roof slope cases collide as ramps"; replaces the revision plan's
  "collision stays voxel"): **roof plane cells collide as the drawn planes** (`collision.ramps`, a mesh), not as
  their stair boxes; light, occupancy and navigation keep the voxels. Default chosen, owner to confirm.
- 2026-11-04 (R2, default chosen, owner to confirm): **the underside sits on what carries the roof**: a plane cell
  with a solid cell under it (a gable or eave wall) takes its voxel's floor as underside, so the slab closes onto
  the wall and the wall's steps under the verge are filled (the risk "gable fill" in §6b, built instead of offered).
- 2026-11-04 (R2, default chosen, owner to confirm): **plane cells at one cell's reach** (the edge pass excludes them
  within its radius 2): a 1:2 stair is only half left to voxel faces (D500); a valley cell where it meets the ridges
  (an L's corner top) reads concave by its level neighbours.
- 2026-11-04 (R2, default chosen, owner to confirm): **plane cells hide nothing and take no piece**: walls beside,
  under or through a roof keep their faces; the superseded catalogue's roof pieces stop drawing on planes now (R3
  draws roof-edge pieces from the roof words).
- 2026-11-04 (R2, default chosen, owner to confirm): **roof-edge words and yaw** (`roofEdgesOf`): eave and verge open
  toward +z at yaw 0, ridge along x, hip/valley to the cell's +x +z corner; a ridge between two cells is owned by the
  one rising toward +x or +z; damaged roof cells (shape < 15) are holes for R3.
- 2026-11-04 (R2, default chosen, owner to confirm): **mips run the same mesher**; a stair off the level's grid sits
  up to 1.5 of its cells high (D501), not fixed here.

- 2026-11-04 (R3, default chosen, owner to confirm): **debris stages are two cases**, `debris` (integrity 8–14) and
  `debris-heavy` (1–7, `standIn: 'debris'`: a kit with one debris piece dresses both); 21 cases, not 20.
- 2026-11-04 (R3, default chosen, owner to confirm): **only exposed damage is debris**: a damaged cell with every
  face against solid stays a body (no hidden faces or pieces inside a mass); collision, light, navigation and
  occupancy keep every damaged cell whole until it is air (owner).
- 2026-11-04 (R3, default chosen, owner to confirm): **a debris face is owned by the intact cell** (its material's
  kit), placed on its face toward the debris by yaw or by a tip (`INSTANCE_PLACE` faceUp / faceDown, the rotation
  byte's free bits 2–3); a ridge along a cell's middle is `centred`. The instance stays 8 B.
- 2026-11-04 (R3, default chosen, owner to confirm): **no edge piece where a cell round the edge is a beam or a
  banister** (they are drawn thin by their own piece); a missing case in a bound kit draws nothing (its stand-in
  first; no role fallback, the engine default kit only for unbound materials).
- 2026-11-04 (R3, default chosen, owner to confirm): **the default kit stays square stand-ins** (a strip a little
  proud of both faces, a corner cap, coves in the open cell, roof boards, rubble boxes) until R3b's bevels.

## 10. Open questions for the owner

- Role spec v1 and the trim layout for detail pieces (the hard stops, 46c.15).
- Whether the case reach of 2 cells is enough for soffits and mouldings under deep eaves, or the apron may grow.
- Where kits live: project content items (schema, add-only) or files beside the world; and the binding's move to 46d.
- Who makes the Texture Designer graphs and Kit Designer after approval: art-factory's own sessions from a request doc.
