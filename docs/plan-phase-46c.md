# Phase 46c — Kits and cases

Status: **46c: in progress (started 2026-11-04, after 46b closed)** on branch `phase-45` (worktree `~/projects/thirdlight-p45`;
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
| 46c.2 | **Case catalogue + extraction + matcher (pure):** `kit-cases.ts`: a detail-bearing cell's case key from roles and fill classes (open / built / ground / same-material) within reach 2, folded over 4 yaw turns and the vertical mirror (no vertical flip); rules {pattern with wildcards and role sets, priority, case id}, first match by priority, a fallback per role mandatory (catalogue refused without it); the draft catalogue per role. | vitest: every key maps to exactly one case; fold invariance under turns/mirrors; priorities and wildcards on hand cases; no cell unmatched on random worlds | keys seen, µs a 16³ section | catalogue complete for its roles |
| 46c.3 | **The registered rule set:** `kit-rules.ts` composes the case pass with the terrain rules into one `AssemblyRuleSet` (`kits` v1, radius the larger, apron stays 3 if R ≤ 2); case ids live only in the job (a u16 a cell beside the class byte); `WORLD_RULES` switches with a derived version step and owner note. | `derived.test.ts`: conformance on random assembly + terrain worlds at 16/32 and at chunk/section edges; joined sections = whole chunk | eval µs a section vs §4 | conformance passes, budget met or the miss's cause recorded |
| 46c.4 | **Merge-compatible run sections:** runs of beams, banisters, soffits, mouldings, running boards (and foundation skirts where a foundation meets terrain) with body / junction / corner / termination sections, read across chunk faces within the reach; the 45.7b neighbours (wall ↔ beam ↔ banister) as the seed cases. | `derived.test.ts`: section per cell on hand runs incl. across chunk faces; adding/removing a neighbour changes only cells within R | sections a run, µs | 45.7b proof passes with the new sections |
| 46c.5 | **Base and consumers from the case:** per case keep / suppress / reshape the base surface; collision, nav and light from the case's declared coarse shape (box, slab, bar, none), never from piece meshes (R77). | `collision.test.ts` (real Rapier: ball through a banister's gaps, capsule on a beam), nav/light outputs per case | bytes, boxes a chunk | an open rail is open for every consumer |
| 46c.6 | **Instances carry kit pieces; high/low filled:** instance u16 piece = kit-local piece index, reserved u16 = variant (hash of the world cell, stable under unrelated edits) — still 8 B, derived version step with owner note; 46b.9 hooks get the kit's high at L0, low at L1, none from L2; D465 rechecked with low pieces. | `derived.test.ts` (variant stable after dig/rebuild elsewhere; per-level lists); `stream.test.ts` (real workers) | instances a chunk per level | hooks filled; D465 closed or re-recorded |
| 46c.7 | **Pieces drawn (adapter + hosts):** GLB pieces through the content closure (no URL), one instanced draw per (kit piece, level) a chunk, section ends meeting by join profile; stand-in material + labelled debug UV texture; page, Play, Scene view. Default fallback kit (procedural, engine-owned) covers every case. | e2e `voxel-world.e2e.ts` (one test extended: kit pieces drawn, a banister → wall edit swaps pieces, `png.ts` reads); export served statically, backend stopped | render() CPU, draws, instances | both renderers draw kits |
| 46c.8 | **Kit check + kit test scene:** `kit-check.ts` rows (ok/warn/err/info): every required case present, fallback present, high/low pairs, pivots and cell sizes, join profiles matching at section ends, triangle and texture budgets reported, trim conformance only for kits that opt in; backend Problems; a command writes the generated test scene (every case in a labelled grid) into a staging world. | vitest (bad kits fail each row), e2e (Problems shows a broken kit; test scene opens) | check ms a kit | check green on both placeholder kits |
| 46c.9 | **Two placeholder kits (log, stone):** produced through the Blender pipeline on this host (`/usr/local/bin/blender`, the blender-pipeline skill; the lead confirms at the item) else procedural meshes from a script in `tools/voxel-bench`; engine-owned test data, high + low per case, debug UVs, small GLBs with their generating script. | kit check green; GLB bytes read by the real loader | tris per piece per level, texture sizes, file sizes | both kits drawn in the test scene |
| 46c.10 | **Prototype scene on staging (§7a list):** wall, beam and banister as neighbours are added/removed; openings and corners; material changes (no remesh, spec §2.2 feeds); chunk and section boundaries; a long uninterrupted surface (repetition); local dig/rebuild (variant stability); high/low in motion across the L0/L1 ring; both renderers. Rotated grids recorded as 47a's. | staging, `run.mjs slice` scene, pictures looked at | — | each item observed or "unverified" with why |
| 46c.11 | **Measurement:** pieces and instances drawn per ring, case pass µs a section p50/p95 (Node + browser), blast → shown with kits, GPU ms at the cap, memory; vs §4. | `run.mjs` phases on staging | all of the above | numbers + causes recorded |
| 46c.12 | **Role spec v1 DRAFT** (`docs/architecture/voxel-role-spec.md`): per role the canonical cases (required / optional / fallback, neighbour roles that change it), ASCII or SVG diagrams from the catalogue; a vitest checks the doc lists exactly the catalogue's case ids. | vitest + check-docs | — | draft complete for every role |
| 46c.13 | **Trim layout DRAFT, detail pieces only** (`docs/architecture/voxel-trim-layout.md`): texel density (authored 1024 px/m, tiers cap at 256/512/1024), field, strips (0.125/0.25/0.5 m), caps, no unique regions, U from world distance along the run; optional per kit; the alternative (own sculpt bakes + material arrays, §7a); the log and stone kits as examples. | check-docs; the debug texture in the test scene | — | draft complete |
| 46c.14 | **Docs:** spec §3.7 (case pass, kit rule set, instance meaning, derived version steps with owner notes), requirements traceability (R73–R77, R86, R87, R90, R112), manual `features/voxel-worlds.md` (kits, kit check), reference regenerated. | check-docs, `tools/manual-links.test.mjs` | — | pages match the built code |
| 46c.15 | **Presentation (lead):** acceptance shots of every §7a case, both renderers; README in `~/.cache/thirdlight-phase46/acceptance/46c`; review page acc46c with both drafts and exactly what the owner must approve. **Then STOP.** | staging | — | owner has the page |
| 46c.16 | *After approval:* specs frozen as v1 (owner note), kit pipeline final, changes the owner asked for. | vitest, fast gate | — | v1 in the docs |
| 46c.17 | *After approval:* authoring package: spec sheets, Blender templates per role (UV guides, scale/pivot, high/low naming), manual guide "make a kit and a material set"; an art-factory request doc for the Texture Designer graphs (made there, not here). | check-docs | — | package complete |
| 46c.14b | *Close before the stop (lead):* full gate once (detached), independent review, High/Medium fixes (fast gates), acceptance shots → acc46c. | full gate | gate time and peak; voxel e2e time | review in the decision log |
| 46c.18 | *After approval (lead):* rows closed, STATUS; then 46d on the owner's word. | — | — | — |

## 7. Progress

| Item | Status |
|---|---|
| 46c.1 | done: voxel kit format 1 (DRAFT) as a project content item `voxelKits` (`project-model` `voxel-kit.ts`), setVoxelKit/deleteVoxelKit one undo each (editor, MCP, HTTP), own file `assets/voxel-kits/*.voxelkit.json`, catalog block `voxelKits` + mesh model versions in exports; newer format/unknown fields refused. Test kit 535 B (file 1,043 B). Spec §3.9 |
| 46c.2 | done: `kit-cases.ts` case pass (40-cell reach-2 window, 4-bit role/fill symbols, folded over 4 turns × mirror, rules by priority, fallback per role mandatory) + catalogue v0 **DRAFT** (45 cases, 43 rules; `kit-case-catalogue.ts`). Town (Node): 726 keys, µs a 16³ section with cells p50/p95 111/267 (all 13/115). 15 vitest |
| 46c.3 | done: `kit-rules.ts` `KIT_RULES` (`kits` v1 = terrain rules + case pass, R 2, apron 3) registered, `WORLD_RULES`; cases a u16 a cell in the job only; L0/L1 run, L2+ skip; derived v9 → v10 (spec note). Outputs byte-equal to terrain rules. Conformance class+case at 16/32. 16³ evaluation with detail p50/p95 town 90/115 → 207/419 µs; eval+ground 242/299 → 255/408 |
| 46c.4 | not started |
| 46c.5 | not started |
| 46c.6 | not started |
| 46c.7 | not started |
| 46c.8 | not started |
| 46c.9 | not started |
| 46c.10 | not started |
| 46c.11 | not started |
| 46c.12 | not started |
| 46c.13 | draft v0 (DRAFT — awaiting owner, hard stop): `docs/architecture/voxel-trim-layout.md`: 4096² sheet authored 1024 px/m (tiers 256/512/1024), 32 px gutters, field 1 m + strips 0.5/0.25/0.125 m plain/profiled + caps 3 sizes × 4, U from world run distance (4 m repeat), path B (own bakes) beside it, kit-check rows T1–T10, log/stone examples, 10 owner questions |
| 46c.14 | not started |
| 46c.15 | not started (owner hard stop: the run stops here) |
| 46c.16 | not started (waits for owner approval) |
| 46c.17 | not started (waits for owner approval) |
| 46c.14b | not started |
| 46c.18 | not started (after approval) |

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
- 2026-11-03 (lead): **art-factory graphs and the Kit Designer** come only through a request doc
  (`docs/requests/art-factory-<date>.md`); this repo never edits art-factory. Blender templates per role ship in this
  repo's authoring package (46c.17).

## 10. Open questions for the owner

- Role spec v1 and the trim layout for detail pieces (the hard stops, 46c.15).
- Whether the case reach of 2 cells is enough for soffits and mouldings under deep eaves, or the apron may grow.
- Where kits live: project content items (schema, add-only) or files beside the world; and the binding's move to 46d.
- Who makes the Texture Designer graphs and Kit Designer after approval: art-factory's own sessions from a request doc.
