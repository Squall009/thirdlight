# Phase 46b — Terrain mesher and dynamic LOD

Status: **46b: in progress (started 2026-11-03, after 46a closed)** on branch `phase-45` (worktree `~/projects/thirdlight-p45`;
main frozen at d4053cab). Planned from `docs/plan-phase-45.md` §4 (46b), the owner decisions of 2026-11-02 (§7:
R107–R109), §7a (surface subdivision separate from voxel shape LOD), the §6 results 45.6, 45.10a–c and the 46a
as-built (`docs/plan-phase-46a.md`), against format spec v1 (APPROVED, `docs/architecture/voxel-format-spec.md`).
The baseline below is re-read from 46a.12's acceptance at the start; where 46a.12 differs, its numbers win.

## 1. Scope

From plan-45 §4 and R108/R109 (owner, 2026-11-02): **terrain mesh rules on voxel-neighbourhood thresholds** — what
makes a cliff, a gentle slope, a terrace, an overhang, a cave roof — as rule sets on the existing assembly/derive
contract, each declaring its radius and passing the conformance check (`ruleRadiusMismatches`), **replacing the
reference surface nets** (`derived-mesh.ts` `groundSurface`). Never assume flat terrain: bumps, hills, caves,
overhangs, cliffs, thin walls and one-voxel features are the test cases. **Dynamic LOD (R109):** coarser voxel mips
meshed by the same mesher in distance rings, crack-free seams between levels, the shader's material blend identical at
every level (shader data per level), architecture detail pieces high → low → none, the base surface following the
mips (not flat-quad merging). Targets:
- triangles: beat the naive mesher's **0.90 M (slice ring, cold) / 2.87 M (town)** (45.10c);
- the mesher's cost per 16³ section stays in **0.1–0.2 ms p50** (45.10c's measured reference cost, its budget);
- **remesh within a frame (R107)** stays the goal: blasts recorded on the Iris Xe at the 60 Hz cap, never blocking;
- ordinary ground collides as a heightfield (46a.6a's finding: heightfields need one ground vertex a column on the
  lattice; slice/hilly share today 0 %, town 24 %).

**Not in 46b:** the case catalogue, run pieces, kits, the role spec and the trim layout spec (46c; **the 46c hard stop
— role spec v1 and trim layout spec for detail pieces, drafted, prototyped, presented to the owner — comes after
46b**; 46b's detail pieces are the placeholder families beam/rail/post with stand-ins); the material model, texture
arrays, wetness beyond darkening (R111), kit instancing, HLOD beyond 46b's rings and the far field past the load ring
(46d); lighting, culling and navigation (46e); structures (47a). **Surface subdivision and displacement** (§7a): not
built and not prototyped in 46b (decision log: it needs the material height maps of 46d's model and texture arrays,
and its shadow-pass and culling-bound costs belong with 46d's renderer work); 46b keeps the two LODs apart as §7a asks
— its levels are voxel *shape* levels only, chosen per node, so a later surface-subdivision level can be chosen
independently over the same mesh. No region, save or stroke format changes; derived data (never stored) gets an
add-only version step with an owner note if its layout or meaning changes (spec §3.8).

## 2. three.js check

Checked 2026-11-03 at the 46b start: three 0.187.0 (released 2026-10-30) is still the newest on npm. No newer
release, so nothing to assess against `docs/three-upgrade-checklist.md`; no update (owner-only).

## 3. Baseline (the numbers 46b reports against)

| What | Number | Source |
|---|---|---|
| Triangles, naive mesher (surface nets + a quad a base face) | slice ring 0.90 M cold, 1.13 M after a flight; town 2.87 M (equal at 32/16/8 sections) | 45.9, 45.10c |
| Mesher µs a 16³ section, browser, p50 / p95 / max | terrain 100 / 600 / 3,600; town 200 / 800 / 4,600 (whole derive 300–400 / 800–1,100) | 45.10c |
| Derive a 32³ chunk, Node, p50 (mesh share) | hilly 690 µs, caves 2,808, town 1,718 (mesh 480–2,392 µs mean of it) | 45.6, 45.10b |
| Surface bytes a chunk, mean | town 23.3 KB, hilly 6.3 KB, caves 43.3 KB (12-B vertices) | 45.10b |
| Slope error of the ground vertices (4-bit shape) | 5.5 cm on 1:20, 5.1 cm on 1:5 (quantization alone ≤ 1.8 / 2.2 cm) | 45.10a |
| Blast → shown (local, 16³, chunk draws + bodies) | terrain 1–4 m next frame, 8 m 2 frames; town 8 m corner 2–3 frames (main 50–54 ms), middle 2–3 (85–104 ms) | 45.10c, 46a.6a |
| Heightfield share of ground chunks | slice 0 %, hilly 0 %, town 24 %; 4.3 vs 37.5 KB a body | 46a.6a |
| render() CPU (chunk draws, slice / town) | 1.4–1.6 / 4.0 ms p50 | 46a.5b |
| GPU a frame, blend / flat (slice, 720p) | 7.1 / 3.1 ms WebGPU, 3.8 / 1.9 ms WebGL 2 | 45.10b |
| Stream memory (slice ring, shader grids included) | 114 MB of the low tier's 256 MiB | 45.10b |
| Voxel mips | built and tested (`voxel-mips.ts`), not streamed; L1 ≈ ¼ of L0 bytes; 0.4–1.3 ms a node | 45.6 |
| `tests/e2e/voxel-world.e2e.ts` | 46.5 s | 46a.11b |

## 4. Where things live (verified 2026-11-03)

- `@thirdlight/voxel`: `assembly.ts` (`AssemblyRuleSet` {id, version, radius, resolve}, class byte bits 0–5,
  `PLACEHOLDER_RULES` v2 R 2, `registerAssemblyRules`), `rule-conformance.ts` (`ruleRadiusMismatches`, +3 cells),
  `derived-mesh.ts` (329 lines: `groundSurface` naive surface nets, `baseSurface` a quad a face, `detailInstances`),
  `derive-assembly.ts` (sections, `deriveSectionsWithApron`), `chunk-join.ts` (joins 16³ sections, not welded),
  `derived-shader.ts` (34³ grid), `voxel-mips.ts` (`downsampleMip`, `MipStaleSet`, `ChunkTreeFlags`; used only in
  tests and `derive-cli.ts`), `ground-heightfield.ts` (5 mm lattice test), `stream-ring.ts` (load ring 384 cells =
  192 m, collision ring 96/48 cells).
- three-adapter: `voxel-chunk-view.ts` (one draw a chunk, stand-in pieces), `voxel-surface.ts` (the blend shader).
- Bench and tests: `tools/voxel-bench/worlds.ts` (plain, hilly, caves, town, vertical), `derived.test.ts` (934 lines:
  meshes, mips, conformance), `collision.test.ts`, `stream.test.ts`; existing terrain CDLOD for selection ideas only
  (`three-adapter/src/terrain-quadtree.ts`, a heightfield: no caves or overhangs, not reused as is).

## 5. Items

Order inside an item per AGENTS.md: schema/commands → runtime/adapter → editor → tests → docs. One agent an item,
~1–2 h, fast gate green. Browser checks extend `tests/e2e/voxel-world.e2e.ts` only (no new e2e file); everything else
is vitest at real boundaries (real derive, real workers, region files on disk, real Rapier). Perf: Iris Xe, 1280×720,
60 Hz cap, both renderers, ≤ 3 rounds, `uptime` recorded.

| Item | Builds | Tested at | Measures | Done when / closes |
|---|---|---|---|---|
| 46b.1 | **Hard-case test world + golden harness.** A `features` test world in `worlds.ts` (engine-owned test data): 1:20 and 1:5 slopes, a 1:1 bank, a 20 m cliff, terraces of 1 and 2 cells, an overhang, an arch, a cave with a roof and a mouth, a 1-cell wall, a 1-cell spike, pit and hole, plus bumps; analytic distance functions for each. `mesh-cases.ts`: per case watertight (every edge two triangles), max/mean error to the analytic surface, features kept (wall unbroken, spike and hole present), triangles. `slice-world --kind features`. | vitest `tools/voxel-bench/mesh-cases.test.ts` (reference surface nets recorded as "before") | per-case error, triangles, holes for the reference | goldens recorded for the reference; harness fails a broken mesh (checked once by hand) |
| 46b.2 | **Terrain rule set (classification).** `terrain-rules.ts`: each ground cell's neighbourhood classified by thresholds (fill gradient, solid above/below, column count) into a feature class: flat/gentle, steep, cliff, terrace lip, overhang, cave roof, thin, spike; composed with the placeholder construction rules into one `AssemblyRuleSet` (one evaluation, radius = the larger), registered; features live only in the job. | `derived.test.ts`: conformance (`ruleRadiusMismatches`) on random worlds at both chunk edges; every `features` case classified as named | evaluation µs a section | rule set registered, conformance passes |
| 46b.3a | **Mesher candidates, measured (bench only).** On the hard cases and the five worlds: (i) reference surface nets; (ii) column-lattice nets: height-function cells put their vertex at the column's lattice x/z, others as nets; (iii) dual contouring with sharp placement only where the rules say cliff/terrace lip (QEF clamped to the cell); (iv) a marching-cubes/transvoxel-style variant. | `mesh-cases.test.ts` + `run.mjs mesher` (new bench phase) | error, triangles, µs a 16³ section p50/p95 (Node), watertight, heightfield-eligible share, vertex bytes | pick + why in the decision log |
| 46b.3b | **The terrain mesher in `@thirdlight/voxel`** (`terrain-mesher.ts`): the pick, driven by 46b.2's classes, replaces `groundSurface` as the ground producer; edge ownership and lattice-exact boundary vertices keep chunks and sections crack-free; the reference moves to the bench. Derived version step (add-only, owner note) if the layout or meaning changes. | `derived.test.ts`, `mesh-cases.test.ts` goldens, `stream.test.ts` (real workers = in-thread derive; joined sections = whole chunk) | µs a section p50/p95, slice/town triangles (Node) | hard cases within their goldens, budget met or the miss's cause recorded |
| 46b.4 | **Normals and sharp edges:** smooth normals from the fill gradient; creases (cliff top, terrace lip, wall foot) split by class with face normals; the 4-bit fill's terracing on slopes checked against 45.10a. | `mesh-cases.test.ts` (normal angle error vs analytic, crease kept, no split on gentle ground) | vertices added by splits, µs | normals within goldens; pictures in 46b.11b |
| 46b.5 | **Base surface for built cells:** coplanar exposed faces merged inside a section (triangles), no T-junction against the neighbours' edges (merges stop where a neighbouring surface meets the plane). | `mesh-cases.test.ts` watertight + town window; `derived.test.ts` join = whole chunk | town triangles and base bytes vs 2.87 M / 23.3 KB | town triangles down, watertight |
| 46b.6a | **A mip level meshed by the same mesher (pure):** derive of a level-L node (the chunk's form, 0.5 m × 2^L cells) through the same rule set and mesher, its 34³ shader data from the node (dominant material, existing rule), a result recording its level; positions in the level's cells. | `derived.test.ts`: L1/L2 of the hard cases watertight, error vs analytic ≤ the level's cell; shader grid = the node's cells | µs a node, triangles a level | one mesher for every level |
| 46b.6b | **Mips at runtime (streamer):** nodes of levels 1…N built in workers from resident level-0 chunks (R85: never stored, spec §3.7), `MipStaleSet` on edits, mip jobs after level-0 jobs, bytes a budget part. | `stream.test.ts` (real workers, region files): every node = a fresh downsample + derive; a dig re-derives its ancestors only | mip bytes in the slice ring, build ms a node | mips live, in the budget |
| 46b.7a | **Seams between levels, measured:** finer-side stitch strip (the finer node meshes its boundary against the coarser node's samples), skirts, transvoxel-style transition cells. | `mesh-cases.test.ts`: two-level patches (hilly, caves, cliff) — watertight within tolerance, no ray through the ground on a grid of rays | triangles and µs added, crack count | pick + why in the decision log |
| 46b.7b | **The picked seam built** in the mesher and the join; a node's seam re-derives when its neighbour's level changes (part of that swap). | `derived.test.ts` + `stream.test.ts` | seam µs, triangles | crack-free across L0/L1/L2 in Node |
| 46b.8a | **LOD rings and selection (pure + streamer):** level per node by box distance from the foci with hysteresis; L0 always covers the collision ring; a level change swaps atomically (old level drawn until every new node and seam is ready); optional ring distances on the `voxelWorld` component (schema add-only, canonicalized field by field). | project-model vitest (fields survive); `stream.test.ts` (moving focus: no node missing or doubled at any task boundary) | level-change swaps a flight, ms | selection stable under jitter |
| 46b.8b | **Chunk view and hosts:** `voxel-chunk-view.ts` draws node meshes per level (one draw a node), the shader reads each level's grid with the blend distance in metres; slice page, Play and the Scene view share it. | e2e `voxel-world.e2e.ts` (one test extended: levels drawn, a grazing view across a level boundary shows no background pixels via `png.ts`, an edit in the L1 ring shows) | render() CPU, draws, GPU ms | rings drawn on both renderers |
| 46b.9 | **Detail pieces high → low → none (hooks, placeholders):** per level piece lists — L0 high stand-ins, L1 low stand-ins, L2+ none, the cell then meshed from its mip shape so the silhouette stays. | `derived.test.ts` (pieces per level, base under a removed piece present) | pieces drawn per ring | hooks ready for 46c's kits |
| 46b.10 | **Collision on the new mesh:** column-lattice ground becomes heightfields (spanning a chunk or patches); D443 re-checked (sphere sweeps on sloped heightfields vs trimesh) before sloped heightfields ship; collision only at L0. | `collision.test.ts` (real Rapier: drops, rays, sweeps on hard cases within 1 cm) | heightfield share slice/hilly/town vs 0/0/24 %, Rapier heap | share up, D443 closed or recorded |
| 46b.11a | **Blast and remesh check:** blasts 1/2/4/8 m on terrain, cliff, cave and town with the new mesher and mips (ancestors re-derived in the same swap or the next). | `run.mjs slice --phase blast` (staging) | frames edit → shown, main ms, worker ms | numbers vs §3, causes of misses |
| 46b.11b | **Acceptance:** triangles before/after (slice, town), mesher µs/section p50/p95 in the browser, flight with level changes (pops, frames), GPU ms, memory, both renderers at the cap; pictures of every hard case and seam looked at; report `~/.cache/thirdlight-phase46/acceptance/46b`. | staging, `run.mjs slice` phases | all of §3, before → after | numbers + causes recorded, pictures looked at |
| 46b.12 | **Docs:** spec §3.7 (terrain rule set, mesher, seams, levels, the derived version step with its owner note), requirements traceability R107–R109, manual `features/voxel-worlds.md` (rings), reference regenerated. | check-docs, `tools/manual-links.test.mjs` | — | pages match the built code |
| 46b.13 | **Close (lead):** full gate once (detached), independent review, fixes, acceptance by eye on staging, STATUS row; then 46c starts with its owner hard stops. | full gate | gate time and peak; voxel e2e time vs 46.5 s | review in the decision log; owner look pending |

## 6. Progress

| Item | Status |
|---|---|
| 46b.1 | done (this commit; fast gate green): `features` world (14 cases, analytic solids, 83 probes), harness `mesh-cases.ts`, goldens, `slice-world --kind features`. Reference: all closed, every probe kept; max error 4.4–5.0 cm on slopes, 12–23 cm at creases; mean 1.7–4.3 cm; 5.4–12.3 k triangles a case. Broken meshes fail. Voxel e2e 47.9 → 43.8 s (untouched). |
| 46b.2 | done (this commit; fast gate green): `terrain-rules.ts`, rule set `terrain` v1 (placeholder rules + 8 ground features, R 2, apron unchanged), registered; conformance on random assembly + terrain worlds at 16/32; every hard case classified as named; derived bytes unchanged. Evaluation a 16³ ground section p50 92–116 µs vs placeholder 38–45 (Node). |
| 46b.3a | done (this commit; fast gate green): `mesher-candidates.ts` (reference, lattice, dc, lattice+dc, mc), `run.mjs mesher`. Pick (owner to confirm): column-lattice nets + DC at the rules' creases. Slice/hilly triangles −11 %, heightfield chunks 0 → 32/33 %, slope mean error 2.7 → 0.4 cm, one golden miss (bump rim +2.8 cm); µs/section +30 (caves/vertical over budget). |
| 46b.3b | done (abcb8b7d; fast gate green): `terrain-mesher.ts` derives the ground (lattice+dc, reach 3 cells), derived v4, worlds on `WORLD_RULES` (terrain v1). Eval + mesh µs/16³ section p50 slice 256 → 217, town 227 → 207, caves 332 → 307 (mesh alone ~110; caves ~190); slice triangles −11 %; heightfield-eligible chunks slice 0 → 32 % (collision takes level ones only). |
| 46b.4 | done (this commit; fast gate green): lattice normals from 4 × 4 columns (slope max error 1:20 5.4 → 1.4°, 1:5 5.7 → 1.6°), crease vertices split with face normals (cliff top 64°, terrace lips 40/59°, ledge 57°, wall foot 64°; no split on slopes or bank), derived v5. Vertices slice +0.07 %, town +1 %, caves +26 %; µs a 16³ section p50 +26–35 (caves +100). |
| 46b.5 | done (05145625 + this commit; fast gates green): base faces merged per section, no T-junction (derived v6): town (terrain rules, 32³) 2.72 → 1.62 M triangles (base 1.41 → 0.30 M), base bytes a chunk 16.4 → 2.5 KB, drawn 2.96 → 1.96 M; derive µs equal. D461 fixed: lips on the true edge, terraces-1 max 12.2 → 2.5 cm, normal p95 73 → 4.5°. |
| 46b.6a | done (this commit; fast gate green after a rerun): nodes derive through the chunk derive (`mip-derive.ts`, level recorded, derived v7); downsample keeps fill = solid share, roles by priority. L1/L2 hard cases closed, max error 0.50 / 1.11 m (≤ the level cell), features ≥ the cell kept; triangles slice 1.05 M → 262 k → 66 k, town 1.62 M → 431 k → 82 k; derive µs a node ≈ a chunk's. |
| 46b.6b | not started |
| 46b.7a | not started |
| 46b.7b | not started |
| 46b.8a | not started |
| 46b.8b | not started |
| 46b.9 | not started |
| 46b.10 | not started |
| 46b.11a | not started |
| 46b.11b | not started |
| 46b.12 | not started |
| 46b.13 | not started |

## 7. Results

(Filled per item: numbers, rounds, uptime, report paths.)

### 46b.1 hard cases and goldens

The `features` world (`tools/voxel-bench/features.ts`, re-exported from `worlds.ts`; not in `allWorlds`, so storage
reports are unchanged): 14 cases on 32 m pads in a row 448 × 32 m, ground 8 m deep, ground level 8.3 cells (partial
cells), each case an analytic solid (cells, positive inside; max/min compositions are exact outside and a lower bound
near the joins of two parts). Fill = the cell's volume fraction inside the solid, measured to 1/8 cell, rounded to
the 16 levels. Slopes run 30° off the axes (not grid-aligned); one-cell features sit on whole cells. Harness
`mesh-cases.ts`: meshes every chunk that owns a surface edge (32³ chunks through the real `deriveFromStore`), welds
by exact position, then per case: open edges (every edge used once each way), max/mean distance to the analytic
surface at vertices and triangle centroids in the measuring box (pad less 6 cells, above the floor), probe rays (83
over all cases: first hit within half a cell of the analytic first hit, or both miss), triangles in the box.
Goldens `mesh-goldens.ts`. `run.mjs slice-world --kind features` writes it (116 chunks, 4 files, 5 s).

**Before (reference surface nets)**, Node 2026-11-03 (uptime 10 d 17 h, load 2.3–2.8): every case closed (0 open
edges, 0 degenerate), every probe kept (wall unbroken, spike, pit, hole, arch opening, cave mouth/roof present).

| Case | Triangles | Max error | Mean error | Where the max is |
|---|---|---|---|---|
| slope-1:20 | 5,768 | 4.95 cm | 2.67 cm | plane (45.10a, vertical: 5.5 cm) |
| slope-1:5 | 6,885 | 4.37 cm | 1.84 cm | plane (45.10a: 5.1 cm) |
| bank-1:1 | 8,052 | 12.0 cm | 1.74 cm | bank lip |
| cliff-20m | 9,568 | 17.3 cm | 2.81 cm | cliff top edge |
| terraces-1 | 6,344 | 15.0 cm | 3.88 cm | riser lips |
| terraces-2 | 6,864 | 15.0 cm | 4.32 cm | riser lips |
| overhang | 9,568 | 15.0 cm | 2.63 cm | ledge corners |
| arch | 7,544 | 23.3 cm | 2.66 cm | arch block corner |
| cave | 12,316 | 23.3 cm | 2.66 cm | hill corner |
| wall-1 | 6,332 | 16.7 cm | 2.69 cm | wall corners |
| spike-1 | 5,488 | 16.7 cm | 2.64 cm | spike corners |
| pit-1 | 5,432 | 16.7 cm | 2.55 cm | pit rim |
| hole-1 | 7,052 | 16.7 cm | 2.50 cm | slab corners |
| bumps | 6,384 | 13.3 cm | 2.63 cm | bump rim (concave crease) |

Reading: every max sits on a crease the nets round off (a third of a cell at a one-cell corner); smooth ground is
2–5 cm (flat ground 2.5 cm: 0.3 of a cell stored as 5/15). Flat ground costs 2 triangles a cell (a 52 × 52-cell box
5,408), the bulk of every count: the triangle target. Broken meshes fail (vitest): a torn patch (open edges), vertices
moved 15 cm (max error), the wall or spike removed (probes and open edges), the hole covered by a closed two-sided
patch (only the probe). `mesh-cases.test.ts` 14 s alone (world 5 s), 5.2 s in the gate. Fast gate
(gate-fast-20261103-093837, uptime 10 d 17 h, load 2.3–2.8): GREEN, 11 min, 5.9 GB peak; `voxel-world.e2e.ts` 43.8 s
(not touched; 47.9 s at the 46b start); D418 (watch) timed out once more and passed alone.

### 46b.2 terrain rule set

`packages/voxel/src/terrain-rules.ts`: `withTerrainFeatures(construction, id, version)` composes a construction rule
set with the ground features into one `AssemblyRuleSet` (radius the larger: 2, so the job apron stays 3);
`TERRAIN_RULES` = placeholder v2 + features, id `terrain` v1. The registry moved to `rule-registry.ts` and lists both
built-in sets (the package is side-effect free, so a set cannot register itself on import). A solid (non-open role,
fill ≥ the surface threshold) ground cell with an exposed face gets a feature in the high nibble of its class byte
(ground carries no run bits; every consumer masks the class, so derived bytes are unchanged: tested on every surface
chunk of the hard cases and a random world). Order: spike (open both sides along ≥ 2 axes) → thin (one axis) → open
below: overhang if within 2 cells the mass ends with 3 open cells above the end, else cave roof → open above and on a
side: cliff if the drop (column fill over the 5 cells level with the cell) exceeds 2.5 cells, terrace lip if it is
0.5–2.5 with flat ground (< 0.5 rise) behind and in front → else the rise per cell (column fill, across the cell when
a side is open, else the flatter side): ≥ 2 cliff, ≥ 0.5 steep, else gentle. Thresholds `TERRAIN_THRESHOLDS`.

Tests (`derived.test.ts`): conformance (`ruleRadiusMismatches`) for every registered set on random assembly and new
random terrain worlds (`randomTerrainWorld`: block heights, tilts, partial fills, ledges, one-cell walls/spikes,
caves, walls, pools) at 16 and 32; every feature occurs in those worlds; 16³ and 32³ evaluations agree cell for cell;
the hard cases: slopes 1:20, 1:5 and flat ground gentle; the 1:1 bank's middle steep; cliff face and top edge cliff
(foot and top ground gentle); every terrace lip (1- and 2-cell risers) and nothing else on the terraces; ledge front
and cave mouth overhang, cave ceiling cave roof; the one-cell wall thin, the spike spike.

Cost, evaluation µs a 16³ section (Node 22, i5-12600H, `deriveSectionsWithApron` evaluate time, 3 rounds, last kept,
192 × 192-cell windows; 2026-11-03, uptime 10 d 17 h, load 2.8–4.9), placeholder → terrain, p50 / p95, sections with
ground surface: features 44/47 → 104/114, plain 43/46 → 93/118, hilly 38/41 → 92/109, caves 40/43 → 116/152, town
45/51 → 103/124; all sections p50 52–109 (most skip: no solid ground or one value). The first version cost +90–120 µs:
the fill pass and a per-cell exposure scan; exposure now comes from per-column solid bit masks (exposed = solid and
not all six neighbour bits) and only exposed cells are classified. The rest is the fill pass over the 22³
neighbourhood (~25 µs). Scratch script, not committed (`~/.cache/thirdlight-phase46/work/46b.2/measure.ts`).
Fast gate (gate-fast-20261103-101542, uptime 10 d 17 h, load 4.8–6.4): vitest and lint green, e2e red only on D417
(`start.e2e.ts` stop exited 1), passed on the rerun (gate-rerun-20261103-102738, GREEN, perf at the cap in limits);
`voxel-world.e2e.ts` 48.1 s (not touched; 43.8 s at 46b.1, the host's load).

### 46b.3a mesher candidates

`tools/voxel-bench/mesher-candidates.ts`: five ground meshers over one density field (terrain-role cells' shape
density, the whole job neighbourhood), each writing the derive's 12-byte ground layout so the harness, the heightfield
check and byte counts apply unchanged. **reference**: the derive's surface nets (tested equal to the derive's ground,
triangle for triangle). **lattice**: nets whose dual cube over a height function (its four sample columns each full at
the bottom of a 6-cell window, empty at the top, never filling again upward) puts its vertex on the column lattice
(the cube's centre x/z, a cell corner) at the four columns' mean fill height; that height does not depend on the
window's start, so stacked cubes of a column weld into one vertex and the quads between them collapse; vertices
more than half a cell outside the cube's sample span fall back to the mean. **dc**: QEF placement (crossing planes from
the cube's own trilinear gradient, pulled 0.05 toward the crossings' mean, clamped to the cube) only in cubes touching
a cell the rules call cliff or terrace lip; central-difference normals first gave pit 17.6 / hole 24.4 cm (the
one-cell gap bent them), the in-cube gradient fixed it. **lattice+dc**: crease first, then lattice, then mean.
**mc**: marching cubes on the same samples, the case table built from the cube's faces (each run of inside corners on a
face cut off by one segment; ambiguous faces separate the inside corners, a face-local rule, so neighbours agree).
`run.mjs mesher` (`mesher-cli.ts`) measures all of them; one sweep, report `~/.cache/thirdlight-phase46/work/46b.3a/
sweep/mesher.md` (Node 22, i5-12600H, 2026-11-03 10:46, uptime 10 d 18 h, load 3.5–3.8; an earlier sweep with the
slice at ±384 cells agreed within 4 % on µs).

Hard cases (triangles in the box / max / mean error, cm; ! misses its golden; every candidate closed, every probe kept):

| Case | reference | lattice | dc | lattice+dc | mc |
|---|---|---|---|---|---|
| slope-1:20 | 5,768 / 5.0 / 2.7 | 5,408 / 3.1 / 0.4 | = ref | 5,408 / 3.1 / 0.4 | 5,772 / 5.9 / 2.8 ! |
| slope-1:5 | 6,885 / 4.4 / 1.8 | 5,408 / 2.2 / 0.6 | = ref | 5,408 / 2.2 / 0.6 | 6,896 / 5.8 / 2.4 ! |
| bank-1:1 | 8,052 / 12.0 / 1.7 | 6,796 / 9.9 / 1.5 | = ref | 6,796 / 9.9 / 1.5 | 8,053 / 6.7 / 1.8 ! |
| cliff-20m | 9,568 / 17.3 / 2.8 | 9,568 / 15.9 / 1.3 | 14.2 / 2.8 | 9,568 / 14.2 / 1.3 | 16.7 / 2.7 |
| terraces-1 | 6,344 / 15.0 / 3.9 | 5,408 / 16.7 / 3.9 ! | 12.2 / 3.6 | 6,344 / 12.2 / 3.1 | 12.5 / 3.4 |
| terraces-2 | 6,864 / 15.0 / 4.3 | 6,136 / 16.7 / 3.5 ! | 13.3 / 3.7 | 6,864 / 13.3 / 3.3 | 15.0 / 3.7 |
| overhang | 9,568 / 15.0 / 2.6 | 15.0 / 2.1 | 15.0 / 2.6 | 9,568 / 15.0 / 2.0 | 15.0 / 2.4 |
| arch | 7,544 / 23.3 / 2.7 | 23.3 / 2.0 | 17.6 / 2.5 | 7,544 / 17.6 / 1.9 | 16.7 / 2.4 |
| cave | 12,316 / 23.3 / 2.7 | 12,168 / 23.3 / 2.3 | 17.6 / 2.5 | 12,190 / 17.6 / 2.1 | 16.7 / 2.2 |
| wall-1, spike-1 | 16.7 / 2.7, 2.6 | 16.7 / 2.0, 1.8 | = ref | 16.7 / 2.0, 1.8 | 16.7 / 2.4 !, 2.5 ! |
| pit-1, hole-1 | 16.7 / 2.6, 2.5 | 16.7 / 1.7, 1.9 | 12.6 / 2.5, 14.2 / 2.4 | 12.6 / 1.7, 14.2 / 1.8 | 16.7 / 2.5 !, 2.2 ! |
| bumps | 6,384 / 13.3 / 2.6 | 5,688 / 16.1 / 2.4 ! | 13.3 / 2.7 ! | 5,840 / 16.1 / 2.4 ! | 6,384 / 10.0 / 2.5 |
| golden failures | 0 | 4 | 1 | 1 (bump rim max) | 9 |

Worlds (ground triangles; vertex KB at 12 B; heightfield chunks of ground chunks; µs a 16³ section with ground,
terrain rules' evaluation + mesh, p50 / p95; the evaluation alone 95–126 p50):

| World (window) | reference | lattice+dc | lattice | mc | dc µs |
|---|---|---|---|---|---|
| slice (±192 cells) | 663,980; 4,139 KB; 0/324; 251/308 | 589,944 (−11 %); 3,692 KB; 104/324 (32 %); 281/323 | 589,824; 104; 268/302 | 663,950; 0; 276/356 | 262/330 |
| hilly (192²) | 166,320; 0/81; 247/302 | 147,456 (−11 %); 27/81 (33 %); 273/309 | 147,456; 27; 261/292 | 166,306; 0; 268/319 | 257/319 |
| plain (192²) | 148,312; 21/72; 238/339 | 147,456; 36/72 (50 %); 259/327 | same; 36; 247/297 | 148,312; 0; 261/284 | 248/371 |
| caves (192²) | 1,434,266; 0/285; 349/556 | 1,353,357 (−6 %); 0; 440/779 | 1,312,326 (−9 %); 1; 379/626 | 1,434,170; 0; 362/538 | 407/710 |
| vertical (128²) | 1,654,524; 0/674; 281/396 | 1,570,428 (−5 %); 0; 355/549 | 1,541,951; 3; 304/446 | 1,654,222; 0; 299/394 | 332/504 |
| town (512²) | 1,315,712 (+ base 1,409,686); 197/605; 234/289 | 1,315,192; 197; 262/377 | 1,314,984; 197; 247/329 | 1,313,408; 197; 258/297 | 252/363 |
| features row | 315,366; 263/330 | 310,598; 301/452 | 308,148; 283/353 | 313,176; 284/334 | 281/440 |

Reading:
- The slice window here (±192 cells round the scene, the collision bench's) holds 0.66 M ground triangles; the page's
  0.90 M ring is larger, so 46b.11b re-measures it in the browser. The bench reference's ground equals the derive's
  on the slice and the town (same counts).
- Heightfields: the not-heightfield chunks of the lattice candidates are the world's underside (`facing`: the chunk
  under each column, 144 of 324 in the slice, 36 of 81 hilly), ground that leaves the chunk through its top or bottom
  (`uncovered`: 72 slice, 18 hilly) and built chunks; of the slice's top-surface chunks 104 of 180 (58 %) are
  heightfields, plain all 36. `deviation` (vertices off the lattice) is gone. MC's vertices sit at cell centres (the
  lattice shifted half a cell), so even plain ground fails the lattice check (0 %, reference 29 %).
- Flat ground (horizontal triangles): slice 1 %, hilly 0 %, plain 25 %, town 39 %, features 27 %. Natural ground is
  never exactly level, so a coplanar merge takes little outside towns and pads; the triangles there go with coarser
  levels (46b.6–8), which the lattice candidates make a regular grid problem.
- Cost: lattice +15–30 µs (the height-function test reads four columns of six cells a cube; caching it a column is the
  first saving), the crease QEF +10–90 µs where the rules call cliffs (caves, vertical). Mesh alone (total less the
  evaluation): slice reference ~150, lattice+dc ~180 µs; caves 223 → 314, vertical 176 → 250 (over the 0.1–0.2 ms
  budget; the reference already misses caves). The bench builds the density field over the whole 22³ neighbourhood
  for every candidate (the product's reference reads 18³), the same for all.

Flat-ground reduction and LOD seams per candidate:
- reference / dc: a horizontal patch's vertices sit on the lattice (only vertical sample edges cross), so coplanar
  quads can merge into larger polygons that keep every boundary vertex of their non-flat neighbours (no T-junction);
  sloped ground is off the lattice and never merges. Seams: finer-side stitch strip between the fine node's boundary
  dual cubes and the coarse node's (the plan's default).
- lattice / lattice+dc: everything above plus every height-function vertex on the lattice: a coarser pattern over
  the lattice (a restricted quadtree, the heightfield LOD the editor's terrain already uses) needs no new topology,
  and a coarse level's nodes are every second fine node, so a ground seam is a 2 : 1 fan with the fine boundary
  nodes snapped to the coarse heights (a coarse node's mean fill height differs from the fine one at the same x/z by
  up to the level's quantization); non-lattice cubes (creases, caves) take the stitch strip. Exact coplanar merging
  of slopes fails (4-bit fill makes their heights not exactly planar).
- mc: flat patches merge as with the reference; seams would be Transvoxel transition cells (published tables to
  import, their licence to check) — the one place it would win, not enough for 9 golden misses, no triangle saving
  and no heightfield.

Tests (`mesh-cases.test.ts`): the bench reference equals the derive's ground triangle for triangle (20 k+ triangles of
the row); MC and lattice+dc close every case with no degenerate triangle and keep every probe; lattice+dc meets the
goldens within 3 cm (only the bump rim needs it) with less than half the reference's mean error and fewer triangles on
both slopes; the lattice makes hilly ground chunks heightfields where the reference makes none. Tests 14.2 s alone
(the 46b.1 tests ~5 s of it; +9 s: two candidates over the row), 15.8 s in the gate. Fast gate
(gate-fast-20261103-104840, uptime 10 d 18 h, load 3.5–3.8): vitest (see-through D311/D435 timing, passed alone) and
lint green, e2e red only on D417 (`start.e2e.ts` stop), passed on the rerun (gate-rerun-20261103-110039, GREEN, perf at
the cap in limits); `voxel-world.e2e.ts` 47.9 s (not touched; 48.1 s at 46b.2).

### 46b.3b the terrain mesher

`packages/voxel/src/terrain-mesher.ts` (`terrainSurface`) is the derive's ground producer; `groundSurface` left the
package (the bench's `reference` candidate is the "before"). It is the 46b.3a pick (`lattice+dc`) with two changes,
both for the section join: only column-lattice vertices are shared (keyed by cube column and height; the candidate
welded any two cubes landing on one point, so a vertex's normal depended on which cube a section met first), and
every other vertex is kept one position step inside its cube and, on the cube's centre line, one step off it along
x, so it never meets a lattice vertex. Against the bench pick: the same triangles on the hard-case row, 0.5 mm moves
only where a mean vertex sat on its centre line (tested); caves +69 triangles of 1.35 M (non-lattice points no
longer weld). Goldens: as the pick, every case closed, every probe kept, one miss within the 3 cm slack (bump rim).
Reach: `TERRAIN_MESHER_REACH` = 3 cells above and below the chunk (the lattice window), classes one cell round it;
the job pad is 3, so aprons and invalidation are unchanged; `derived.test.ts` meshes random terrain at 16³ and 32³
with the job's pad and with 3 cells more (same bytes) and a narrower pad is refused. Derived data 3 → 4 (spec §3.7,
§3.8 owner note): layout unchanged, ground vertex meaning changed; no stored format changed, so no world was
regenerated. `WORLD_RULES` (= `TERRAIN_RULES`, `rule-registry.ts`) is what `worldStreamer` (Play, the Scene view),
the slice page, its probes and the voxel e2e derive with; `stream.test.ts`, `world-host.test.ts`, `collision.test.ts`
and the join/crack/invalidation tests of `derived.test.ts` moved to it, and the join test gained the cliff and
terrace cases (16³ and 8³ joined sections = whole chunk, crease vertices on section faces).

Cost: the per-column height test reads prefix sums of the column's fill and of its rises, built on first use per
column (O(1) a window instead of 24 reads a cube); `Math.hypot` → `sqrt`; typed scratch arrays. µs a 16³ section with
ground, terrain rules' evaluation + mesh, Node 22, i5-12600H, `run.mjs mesher --candidates reference,lattice+dc,terrain`
(report `~/.cache/thirdlight-phase46/work/46b.3b/r2/mesher.md`, 11:20, uptime 10 d 18.9 h, load 3.3–3.6; round 1
before the last two savings at load 5.0–5.2), p50 / p95:

| World | reference (before) | bench pick | terrain mesher | evaluation alone |
|---|---|---|---|---|
| slice (±192 cells) | 256 / 308 | 283 / 312 | 217 / 271 | 104 / 113 |
| hilly (192²) | 240 / 341 | 262 / 354 | 210 / 358 | 97 / 109 |
| caves (192²) | 332 / 537 | 425 / 756 | 307 / 506 | 117 / 159 |
| town (512²) | 227 / 309 | 261 / 370 | 207 / 269 | 95 / 114 |

The mesh alone (total less the evaluation) is ~110 µs p50 on slice, hilly and town, inside the 0.1–0.2 ms budget;
caves ~190 µs (a scratch micro-bench of the mesher alone: 256 → 224 µs p50, hilly 131 → 125). Miss's cause: the
evaluation (46b.2's terrain rules, ~100 µs) puts every total over 0.2 ms, and caves sections hold ~4× hilly's surface
cubes (each placed; the QEF at cliff cubes was ~18 % of the mesher's CPU profile there before the `sqrt`), on top
of the fixed field build (18 × 18 × 22 cells a section). Not tuned further (budget recorded, never blocking).
Triangles (Node, the same report): slice window 663,980 → 589,944 (−11 %), hilly 166,320 → 147,456, caves 1,434,266 →
1,353,426, town ground 1,315,712 → 1,315,192 (+ base 1,409,686: 2.73 M, built faces are 46b.5's). Heightfield-eligible
ground chunks (`groundHeightfield`): slice 0 → 104 / 324 (32 %), hilly 0 → 27 / 81, town 197 → 198 / 605, caves 0.
Collision takes a heightfield only where it is level (`collisionGeometry`'s default; `'sloped'` opts in, the slice
page's `?heightfields=sloped`) until 46b.10 re-checks D443; `collision.test.ts` green (the town's drops and sweeps
within 1 cm). Staging (dist of abcb8b7d, `slice-world --kind features` written into the staging project, kept for
46b.11b): the slice and the features row on WebGPU and WebGL 2 looked at — cliff block and terrace lips sharp,
arch, cave mouth, one-cell wall and spike present, no crack or hole seen at chunk faces; the slice ring 0.80 M
triangles drawn (493 chunks; 45.10c's 0.90 M was the old nets' cold ring). Pictures `~/.cache/thirdlight-phase46/
work/46b.3b/shots/`. Fast gate (gate-fast-20261103-112246, uptime 10 d 18.9 h, load 4.4–6.9): GREEN, 13 min, 4.5 GB
peak; `voxel-world.e2e.ts` 44.3 s (47.9 s at 46b.3a). `edits.test.ts` 'apply the same cells…' timed out once in an
ad-hoc run at load 5 (6.1 s of 5 s; passed alone and in the gate; untouched).

### 46b.4 normals and sharp edges

`terrain-mesher.ts` now builds dual vertices (position, smooth normal, split flag) and turns them into output vertices
as quads are emitted. **Smooth normals:** a column-lattice vertex takes the slope of the column heights over the
4 × 4 columns round it (least squares with weights 1, 3, 3, 1 both ways) when each is a height function over the two
cells either side of the cell boundary nearest the vertex's height, else its cube's four (as 46b.3b); the window
follows the vertex, so every cube of a stack, section and chunk gives the same normal (the field is one column wider
each side; the reach stays inside the job's pad, tested). Other vertices keep their cube's sample gradient.
**Creases:** a vertex whose cube touches a cliff, terrace-lip, overhang, thin or spike cell, whose inside corners are
not one half of the cube and whose crossing edges each have a whole cell or whole air at one end is a crease vertex;
each quad whose face (Newell's normal of its four placed positions) turns more than `CREASE_SPLIT_DEG` (10°) from
the vertex's gradient takes a copy carrying the face normal (copies with equal snorm8 normals are one vertex).
Derived data 4 → 5 (spec §3.7, §3.8 owner note): layout unchanged, a position may appear in several vertices.

Harness (`mesh-cases.ts`): the welded mesh keeps every corner's normal; `measureNormals` (angle to the analytic
normal at a point a quarter of the way to the triangle's centroid, so a corner on a crease is measured on its own
side; p50 / p95 / max; split vertices and the vertices they add), `creaseAngles` (the largest turn between normals at
one position). Goldens `TERRAIN_NORMAL_GOLDENS`. Node, 2026-11-03 12:00, degrees, reference → 46b.3b → 46b.4:

| Case | p50 / p95 / max | Splits (positions; vertices added) | Crease turn (min) |
|---|---|---|---|
| slope-1:20 | 1.1/2.9/3.1 → 0.8/2.9/5.4 → 0.2/1.2/1.4 | 0 | — |
| slope-1:5 | 2.8/6.3/7.1 → 0.4/3.8/5.7 → 0.7/1.2/1.6 | 0 | — |
| bank-1:1 | 0.6/9.7/35.3 → 0.3/9.7/35.3 → same | 0 | — |
| cliff-20m | 0/0/45 → 0/0/45 → 0/0/74.4 | 53; +53 | 0 → 64 (top edge) |
| terraces-1 | p95 45 → 45 → 73.1 | 954; +954 | 0 → 40 (lips) |
| terraces-2 | p95 45 → 45 → 45 | 371; +371 | 0 → 59 |
| overhang | p95 11.3 → 11.3 → 11.3 | 106; +106 | 0 → 57 (ledge front) |
| arch / cave | p95 26.6 → 26.6 → 11.4 / 11.9 | 170; +302 / 251; +329 | cave mouth p50 0 → 40 |
| wall-1 | p95 11.3 → 11.3 → 4.1 | 156; +212 | 0 → 64 (foot) |
| spike / pit / hole | p95 0 / 0 / 45 → 0 / 0 / 11.3 | 44 / 12 / 124 | — |
| bumps | p95 16.8 → 15.6 → 16.2 | 8; +20 (rims only) | — |

Reading: the 4-bit fill rounds a column by up to 1/30 cell, which across one cell turned 1:5 and 1:20 normals by up to
5.7° (stair banding, worse than the reference's 3.1° on 1:20 because 46b.3b's lattice normal spanned one cell);
across the 4 × 4 columns every slope corner is within 1.6°. Creases now turn by 40–64° where every normal was
shared. The max errors at creases (cliff 74°, terraces-1 p95 73°) are the placement's, not the normals': a placed
crease sits up to 0.3 cell off the true corner (46b.3b), and a face normal shows that offset where the smooth normal
hid it. Tests (`mesh-cases.test.ts`, +4): within the normal goldens; slopes within `SLOPE_NORMAL_MAX_DEG` (2°) where
the reference turns more; cliff top, terrace lips, ledge front and wall foot turn by at least `CREASE_KEPT_DEG` (35°)
and the reference by 0; cave mouth p50 ≥ 35°; no split on the slopes or the bank across chunk faces, bumps only at
their rims. Watertightness, probes and position goldens unchanged (same triangles); the join test (16³ and 8³ sections
= the whole chunk, normals included) green on the cliff and terraces.

Cost (`run.mjs mesher --worlds slice,hilly,caves,town --candidates terrain`, Node 22, i5-12600H, 12:11–12:12, uptime
10 d 19.7 h, load 4.6–5.2; before = HEAD in two rounds bracketing after): µs a 16³ section with ground (evaluation +
mesh) p50 / p95, before → after: slice 200–226 / 249–277 → 252 / 364, hilly 228–232 / 520–558 → 263 / 463, caves
299–302 / 498–504 → 399 / 741, town 213–231 / 268–315 → 258 / 406. Mesher alone, same process interleaved (scratch
micro-bench, 32³ chunks p50): hilly 615 → 694, caves 1,468 → 2,090, town 563 → 752 µs. Vertices: slice 315,061 →
315,281 (+0.07 %), hilly 78,738 → 78,735, town 698,087 → 705,442 (+1.1 %), caves 719,978 → 907,532 (+26 %, 8.4 → 10.6 MB
of vertices in the window); triangles unchanged. Causes: the lattice normal reads 16 columns (cached per column and
window), the field is two columns wider, the dual-vertex step, and in caves the crease test and copies (the carved
tunnels are real voxel edges). Recorded, not tuned further (never blocking).

Pictures (staging, dist before/after this change, `features` and the slice, WebGPU and WebGL 2, the page's fixed sun
at ~60° elevation; the page has no sun control, so a low sun was not looked at): the cliff's top edge lost its dark
blurred band and reads as one sharp line; the terraces' risers read as distinct dark bands with sharp lips (before:
soft rolls); the wall's foot and ends are crisp; the slice's dug ring and rocks read blockier. The 1:20 slope looks the
same before and after at this sun: banding was not visible in either (the numbers above are the evidence; a low sun
is 46b.11b's). Shots `~/.cache/thirdlight-phase46/work/46b.4/shots/{before,after}/`.
Fast gate (gate-fast-20261103-121415, uptime 10 d 19.8–20.0 h, load 5.6 at the start, 15–17 during e2e): GREEN, 14 min,
4.9 GB peak; vitest red only on D418 (`scan-bounded-log.test.ts`, 5 s timeout, passed alone in the gate's rerun);
`voxel-world.e2e.ts` 53.1 s (not touched; 44.3 s at 46b.3b, the host's load).

### 46b.5 base surface merges and the terrace lip (D461)

**D461 (05145625).** A crease cube (touching a cliff or terrace-lip cell) whose four sample columns are a straight
step (two columns a side; each a height function over the lattice window, or wholly full or empty there) now puts
its vertex on the column lattice at the higher column top between its two sample centres: the step's edge, or its
foot. The 4-bit fill is a height, so the step's face stands on the cell boundary; the QEF of the interpolated
density had put the lip (8.04, 8.96) for the true (8, 9.3), the foot (7.64, 8.36) for (8, 8.3). Two tops only and a
half-open span keep it from ever landing on a plain lattice vertex or another cube's (a first version allowing
three tops made 4 degenerate triangles on the bank; one column against three put a bump's rim 25 cm off).
Hard cases (cm, before → after): terraces-1 max 12.2 → 2.5, mean 3.1 → 1.3; terraces-2 mean 3.3 → 2.5; cliff mean
1.3 → 1.2; arch max 17.6 → 14.2; cave max 17.6 → 19.1 (within its 23.3 golden: a mouth rim vertex); others equal.
Normals (°, max or p95): terraces-1 p95 73.1 → 4.5, terraces-2 max 73 → 45, cliff max 74 → 45, overhang max 73 →
68, cave max 76.8 → 75.9; goldens tightened to these, none widened. New test: every terrace lip and the cliff top
within the fill rounding (1/30 cell) of the true edge. The 2-cell terraces' foot is not a crease cube (the lip cell
is two cells up) and keeps the nets' mean (0.4 cell in front); not chased. `groundHeightfield` now reads a triangle
whose footprint is at most 4 steps × a cell as a riser (it may lean a step back: off-lattice vertices are kept a
step off the lattice lines), not an underside; the collision test's block now refuses as `layers` at its corner (its
foot on the node) and a corner-free variant as `uncovered` (both asserted). Town heightfield-eligible chunks 198 →
211 of 605. Mesher µs a 16³ section p50 (Node, `run.mjs mesher`, 13:17, uptime 10 d 20.8 h, load 4.3–5.4): slice
245, hilly 274, caves 413, town 279 (46b.4: 252 / 263 / 399 / 258 at load 4.6–5.2): unchanged within the host's
noise; no cheap win taken.

**Base surface** (`packages/voxel/src/base-surface.ts`, replacing derived-mesh's quad a face): exposed faces of
wall-class cells merged per direction and layer into rectangles (greedy), across materials (vertices carry none).
T-junctions: each rectangle's edge takes every lattice point where another rectangle of the section has a corner,
and every lattice point on the section's faces; the ground and pieces share no edges with the base (separate,
overlapping meshes), so they set none. Fan from a corner whose two edges carry no extra point, else from the
centre. **Join invariant (chosen):** a whole-chunk derive and its joined 16³/8³ sections no longer give the same
triangles; both must cover every exposed face exactly once (a sample point a face, irrational offsets, and equal
area), have no vertex inside another triangle's edge, and have the naive quads' boundary cell for cell
(`tools/voxel-bench/base-cases.ts`). Tests: `derived.test.ts` join (hilly, town, scene, features at 16³ and 8³);
`mesh-cases.test.ts` a closed two-cell shell with a window floating across chunk and section faces (every edge
two triangles, opposite windings, at 32/16/8), the town's houses (windows, doors, stairs, roofs, banisters: 20 k+
faces), and the checks failing a torn face and a T-junction (also checked once by hand: without the inserted
points the join test reports 315 T-junctions). `derived-cell.ts` counts a cell's base faces by coverage.

Numbers (Node 22, i5-12600H, 13:13–13:17, uptime 10 d 20.8 h, load 4.3–5.7; before = 05145625 by `git stash`):
town (`run.mjs derive --worlds town`, placeholder rules, 32³) 3.12 → 1.91 M triangles, base vertices 3.08 → 0.42 M,
base bytes a chunk 16.4 → 2.5 KB, vertex bytes a drawn chunk 46.7 → 14.9 KB, mesh µs a chunk mean 631 → 630; town
with the terrain rules (`run.mjs mesher`) ground 1.32 M + base 1.41 → 0.30 M = 1.62 M (2.87 M baseline); a 96 m town
window as the streamer derives it (16³ sections, scratch `sect.ts`, two interleaved A/B rounds) base 207,660 →
63,416 triangles, 6.1 → 1.3 MB, whole section derive µs p50 553–555 → 493–552 (equal). Staging (dist of this
change vs 05145625, town at the page's scene, WebGPU and WebGL 2, 1280 × 720): drawn 2,962,446 → 1,964,346
triangles, stream MB 233 → 138; the wide view, a house's walls with windows and its stepped roof and the inside
looked at before and after: the same pictures (two thin dark lines on the inner roof are in both). Shots
`~/.cache/thirdlight-phase46/work/46b.5/shots/{before,after}/`.
Gates: D461 (gate-fast-20261103-124148 RED on the collision test's refusal reason, fixed as above;
gate-fast-20261103-125439 GREEN, 14 min, 4.5 GB, uptime 10 d 20.5 h, load 4–8); base (gate-fast-20261103-131801,
load 3–7: vitest and lint green, e2e red only on D320 (watch, `rendering.e2e.ts` dynamic resolution "back up to 1"),
passed on the rerun; perf at the cap green, gate-rerun-20261103-133417). `voxel-world.e2e.ts` 49.5 s and 48.1 s (not
touched; 53.1 s at 46b.4 under load 15–17).

### 46b.6a a mip level through the same mesher

`packages/voxel/src/mip-derive.ts`: `MipTree` (nodes built on demand from a level-0 store, a level read like a store
of chunks) and `deriveMipNode` = the node's cells and an apron of the same level's nodes through `deriveWithApron`
(the chunk derive: `WORLD_RULES`, terrain mesher, base surface, consumers, 34³ shader grid). `deriveChunk`,
`deriveWithApron` and `deriveSectionsWithApron` take a `level`; `DerivedData.level` is recorded and carried by
`encodeDerived` (derived 6 → 7, spec §3.8 owner note); `mipCellMetres(L)` (coords.ts) is the one scale to metres;
`groundHeightfield` takes the level's cell size. The downsample (`voxel-mips.ts`) now keeps the fill a share of
solid (open roles add nothing), takes the role by `MIP_ROLE_PRIORITY` (whole-cell bodies need half the node cell,
terrain any fill), the material dominant among the counted cells. Tests: `derived.test.ts` (downsample rules
cell by cell; a node's bytes = a chunk derive of the same cells except the level, crease splits present at L1/L2;
the shader grid = the node's 34³ cells, entry for entry), `mesh-cases.test.ts` (`meshFeaturesAtLevel`: L1/L2
closed, max error ≤ the level's cell, triangles ≤ 0.3 × the level below, lost probes exactly as expected; hilly
nodes heightfields at L1 and L2).

Hard cases (Node, triangles in the box / max / mean error cm; lost probes), L0 → L1 → L2:

| Case | L0 | L1 (1 m cells) | L2 (2 m cells) |
|---|---|---|---|
| slope-1:20 / 1:5 | 5,408 / 3.1 / 0.4, 2.2 / 0.6 | 1,352 / 3.7 / 0.7, 3.1 / 0.8 | 338 / 6.4 / 1.3, 12.7 / 1.8 |
| bank-1:1 | 6,796 / 9.9 / 1.5 | 1,520 / 28.9 / 4.8 | 378 / 40.6 / 11.6 |
| cliff-20m | 9,568 / 14.2 / 1.2 | 2,392 / 22.9 / 2.4 | 598 / 42.6 / 5.8; cliff foot |
| terraces-1 / -2 | 6,344 / 2.5 / 1.3, 6,864 / 13.3 / 2.5 | 1,352 / 20.6 / 7.1, 1,716 / 5.0 / 2.8 | 338 / 33.3 / 11.8, 338 / 58.3 / 18.1 |
| overhang / arch / cave | 15.0 / 1.9, 14.2 / 1.7, 19.1 / 1.9 | 35.0 / 6.3, 39.2 / 5.4, 45.4 / 5.7 | 77.1 / 17.7, 52.5 / 15.2, 111.1 / 20.8 |
| wall-1 | 16.7 / 2.0 | 50.0 / 7.0; wall ends (2), wall top | 51.6 / 14.0; all 33 probes |
| spike-1 / pit-1 | 16.7 / 1.8, 12.6 / 1.7 | 5.0, 6.7; spike (2), pit bottom | 11.8, 11.8; spike (2), pit bottom |
| hole-1 / bumps | 14.2 / 1.6, 16.1 / 2.4 | 50.0 / 7.5, 39.9 / 7.0 | 49.8 / 12.8; above and beside the hole, 96.4 / 17.6 |

Every level closed (0 open edges, 0 degenerate). The largest error is 0.5 of a level cell at L1 (50 cm) and 0.56 at
L2 (111 cm, the cave's mouth). Kept: everything of at least the level's cell (terraces-2's 2-cell risers, the
2-cell slab and its hole at L1; ledge, arch, cave and bumps at L2). The 1-cell wall (half an L1 cell) stays at L1,
drawn thin round its column's middle (fill 8/15 beside air puts the surface just off the cell centre): rays at its ends and beside its top miss it. The spike (a quarter)
and the pit leave L1. At L2 the wall, spike, pit and the 2-cell slab leave. The cliff-foot probe runs 0.5 cell from
the face, under half an L2 cell.

Worlds (`run.mjs mips`, Node 22, i5-12600H, 13:47, uptime 10 d 21.4 h, load 3.5–4.4; report
`~/.cache/thirdlight-phase46/work/46b.6a/r2/mips.md`; round 1 timed the apron inside the derive). The windows are
the same area at every level (whole L2 nodes):

| World (window) | Triangles L0 → L1 → L2 | Heightfield ground nodes L0 / L1 / L2 | Downsample µs a node p50 (L1 / L2) | Derive µs a node p50 L0 / L1 / L2 (mesh) |
|---|---|---|---|---|
| slice (512² round the scene) | 1,048,824 → 262,174 → 65,540 | 187/580, 45/150, 14/32 | 3,583 / 5,437 | 2,615 / 2,739 / 4,748 (964 / 1,008 / 3,128) |
| hilly (256²) | 460,407 → 115,135 → 28,814 | 34/227, 6/57, 1/11 | 5,062 / 5,959 | 2,610 / 2,466 / 5,334 (1,027 / 966 / 3,436) |
| town (512²) | 1,619,410 → 430,634 → 82,256 | 211/605, 37/143, 2/32 | 3,595 / 3,060 | 2,855 / 2,824 / 4,457 (1,165 / 1,206 / 2,508) |

Each level has 25–27 % of the triangles of the one below (town L2 19 %: houses under half a node cell leave). Vertex
KB a level: slice 6,568 → 1,642 → 408; shader KB 6,194 → 1,537 → 307. The derive (evaluation + mesh + consumers) of
a node costs what a chunk's does. The L2 mesh p50 (2.5–3.4 ms against ~1 ms) is the bench's single cold pass right
after building the tree; it is not the level. A warm scratch loop over the same hilly nodes measured mesh 1,108 /
1,126 / 1,218 µs a node at L0 / L1 / L2, i.e. 546 / 557 / 465 µs per 1,000 triangles. The per-level class mix is
the same (cliff ~42 % of featured cells at every level).

The downsample (3–6 ms a node, L1 reading its 8 chunks from the palette store) and the apron through the level
view (0.6–6.6 ms p50; up to 0.13–0.21 s at L2 p95 where it builds the neighbour nodes) are the bench's on-demand
tree, not what 46b.6b's worker path costs.
Fast gate (gate-fast-20261103-135535, uptime 10 d 21.5 h, load 5–8): vitest and lint green (`stream.test.ts`
worker-pool timeout, D454's file, failed once under load and passed alone); e2e red only on D417 (`start.e2e.ts`
stop), passed on the rerun (gate-rerun-20261103-140844, GREEN, perf at the cap in limits). `voxel-world.e2e.ts`
43.2 s (not touched; 48.1 s at 46b.5).

## 8. Decision log

- 2026-11-03 (plan, default chosen, owner to confirm): **LOD rings live inside the existing load ring** (192 m): mips
  are built at runtime from resident level-0 chunks in workers (R85; spec §3.7: mips are never stored), so no file or
  stream format changes. Past the load ring (the far field, exported high levels) is 46d's.
- 2026-11-03 (plan, default chosen, owner to confirm): **starting ring distances** L0 to 64 m, L1 to 128 m, L2 to
  192 m, box distance, 8 m hysteresis; L0 always covers the collision ring (48 m + hysteresis), so what a character
  touches is what is drawn. Tuned by 46b.11b's observation; not frozen as art guarantees (§7a).
- 2026-11-03 (plan, default chosen, owner to confirm): **one rule set per world**: the terrain rules compose with the
  construction placeholder rules into one registered `AssemblyRuleSet` (one evaluation, radius the larger of the
  two, default terrain radius 2), so the job, its apron and invalidation stay as they are; terrain feature classes
  live only inside the job like assembly classes.
- 2026-11-03 (plan, default chosen, owner to confirm): **mesher family by measurement (46b.3a), default candidate
  the dual (surface-nets) family with rule-driven placement**: it keeps the format's crack-free invariant (boundary
  vertex a function of its samples, edge ownership), the section join and one vertex a column on the lattice for
  heightfield ground; dual contouring only where the rules call a crease. Transvoxel-style cells win only if 46b.3a/
  46b.7a measure them better.
- 2026-11-03 (plan, default chosen, owner to confirm): **seams by measurement (46b.7a), default candidate the finer
  side's stitch strip**; skirts are the fallback if the strip misses the mesher budget.
- 2026-11-03 (plan, default chosen, owner to confirm): **shader data per level**: each node's 34³ grid from its mip
  (dominant material, existing rule), the blend distance and triplanar scale in metres, so a blend looks the same at
  every level; checked by pictures across a level boundary (46b.11b).
- 2026-11-03 (plan, default chosen, owner to confirm): **detail pieces** high at L0, low at L1, none from L2 (the
  cell then meshed from its mip shape); 46b only the placeholder families; kits fill the hooks in 46c.
- 2026-11-03 (plan, default chosen, owner to confirm): **no surface subdivision or displacement in 46b**, not even as
  an experiment: it needs material height maps (46d's material model and texture arrays), shadow-pass displacement
  and conservative culling bounds (46d's renderer work), and the mesher budget is spent on shape. Not ruled out
  (§7a): 46b's levels are shape levels only, so a subdivision level can be chosen separately later; 46d prototypes.
- 2026-11-03 (46b.1, default chosen, owner to confirm): **what the goldens bound.** A later mesher meets a case's
  golden when it is closed, loses no probe and its max and mean errors are at most the reference's (`goldenFailures`,
  an optional slack in metres for a mesher that trades a few millimetres on smooth ground for kept creases, logged when
  used); triangles are reported, not bounded. Error is measured at vertices and triangle centroids, one-sided (mesh to
  surface); a lost feature is caught by the probes, not by the error.
- 2026-11-03 (46b.1, default chosen, owner to confirm): **hard-case data**: fill = volume fraction (to 1/8 cell) of
  the analytic solid, as an import or a brush would store it; one-cell features on whole cells, the ground at 8.3
  cells; slopes 30° off the axes so the grid does not flatter them. The harness meshes 32³ chunks through the real
  derive (one function a chunk, so 46b.3a plugs candidates in); sections are checked by the join tests.
- 2026-11-03 (plan, default chosen, owner to confirm): **the reference surface nets leave the package** for the bench
  (`tools/voxel-bench`), kept as the "before" in the goldens; if the derived layout or meaning changes, derived data
  takes an add-only version step with an owner note in the spec (derived data is never stored: nothing to migrate).

- 2026-11-03 (46b.2, default chosen, owner to confirm): **ground features are local (radius 2)**: inside a ledge wider
  than the radius its underside reads as a cave roof and only the 2 cells behind its front as overhang; a cave mouth's
  roof is an overhang. Telling a wide ledge from a cave needs a reach of the cave's half width (6+ cells here), which
  would quadruple the job's neighbourhood; the mesher treats both as downward faces, so the radius stays 2.
- 2026-11-03 (46b.2, default chosen, owner to confirm): **feature thresholds** steep from 1:2 rise, cliff from 2:1,
  terrace risers 0.5–2.5 cells with treads flatter than 1:2 on both sides (a drop deeper than 2.5 cells is a cliff's
  top edge); terraces are read along the x and z axes only (a diagonal terrace reads as steep steps). Only solid
  exposed ground cells carry a feature; partly filled cells above them are `none` (the mesher reads the solid
  cells of a dual cell's corners).
- 2026-11-03 (46b.2): **the slice and Play keep the placeholder rules until 46b.3b** switches them to `terrain`
  (nothing reads the features before the mesher; switching now would add ~50–70 µs a ground section for nothing).

- 2026-11-03 (46b.3a, default chosen, owner to confirm): **the terrain mesher is the column-lattice surface nets
  with dual-contouring placement where the rules say cliff or terrace lip** (`lattice+dc`). Against the reference it
  keeps the nets' topology, edge ownership and section join (crack-free unchanged), cuts slice/hilly ground triangles
  11 % and vertex bytes 11 %, turns 32–33 % of slice/hilly ground chunks into heightfields (0 % today; 58 % of the
  slice's top-surface chunks), cuts slope mean error 2.7 → 0.4 cm (1:20) and sharpens cliffs, terraces, arch, cave,
  pit and hole; costs +30 µs a section p50. Lattice alone loses terraces (no crease placement); DC alone keeps the
  triangles and gains no heightfield; marching cubes misses 9 goldens, saves nothing and its vertices are off the
  heightfield lattice. Its one golden miss (a bump's concave rim, +2.8 cm max, mean better) is accepted with the
  goldens' slack at 3 cm (logged here, owner to confirm). Over budget on caves (314 µs mesh p50) and the vertical world
  (250): 46b.3b measures again after caching the column test.
- 2026-11-03 (46b.3a): **flat-ground merging is not the triangle lever on natural ground**: exactly level triangles
  are 0–1 % of the slice and hilly ground (25 % plain, 39 % town), so 46b.5 merges built faces and level patches
  only; terrain triangles come down through coarser levels over the lattice (46b.6–8).
- 2026-11-03 (46b.3a): the lattice test reads raw cell roles 2 cells past the chunk (inside the job's 3-cell pad, past
  the consumers' 1-cell reach): 46b.3b states the mesher's reach and keeps conformance covering it, or reads classes
  if ground ever depends on more than the role.

- 2026-11-03 (46b.3b, default chosen, owner to confirm): **sloped heightfields wait for D443**: the terrain mesher
  makes a third of slice and hilly ground chunks heightfield-eligible, but sphere casts on sloped Rapier
  heightfields land late (D443), so `collisionGeometry` takes only level heightfields by default until 46b.10
  re-checks D443 on this ground; sloped eligibility is measured and opt-in (`'sloped'`).
- 2026-11-03 (46b.3b): **only lattice vertices are shared, others stay inside their cube and off the lattice**: the
  candidate's weld-by-position made a shared vertex's normal depend on which cube a section met first (joined
  sections ≠ whole chunk); the change moves vertices by at most one step (0.5 mm).
- 2026-11-03 (46b.3b, default chosen, owner to confirm): **one rule set for every streamed world**, `WORLD_RULES` =
  the terrain rules (placeholder construction + ground features). The placeholder set stays registered for tests;
  under it the mesher places creases as plain nets.

- 2026-11-03 (46b.4, default chosen, owner to confirm): **crease vertices split by class and by the voxels' own
  edges**: a vertex splits only where its cube touches a cliff, terrace-lip, overhang, thin or spike cell, its inside
  corners are not one half of the cube and each crossing edge has a whole cell or whole air at one end; then each quad
  turning more than 10° from the vertex's gradient takes its face normal. Measured alternatives: the class and the
  angle alone (caves +70–83 % vertices: every rough cave wall faceted); the spread of the cube's own crossing normals
  (missed the cliff top and terrace lips: the in-cube field blurs a corner); a three-cell gradient as the reference
  (only one side of a lip split, 12–23° creases). Cost: caves +26 % vertices, +100 µs a section.
- 2026-11-03 (46b.4, default chosen, owner to confirm): **lattice normals over 4 × 4 columns** in a window that
  follows the vertex's height (deterministic for every cube, section and chunk); a cross of 12 columns was cheaper but
  left 1:20 at 1.9°, so the tent stays.
- 2026-11-03 (46b.4): **a low-sun look is still owed**: the slice page's sun is fixed at ~60°, where the 1:20 banding
  was invisible before and after; 46b.11b looks under a low sun (a page parameter or the Scene view's light).

- 2026-11-03 (46b.5, default chosen, owner to confirm): **merged base faces stop at section faces, and the join
  invariant is coverage, not bytes**: merging across sections would make a section's mesh depend on its
  neighbours' (more derive reach, more re-derives an edit); instead each section merges alone and puts every
  lattice point on its faces, so joined sections and a whole-chunk derive cover the same faces once each, crack-
  free, in different triangles. Inside a section T-junctions are avoided by inserting the other rectangles'
  corners rather than stopping merges there (same crack-freedom, fewer triangles). Derived v6.
- 2026-11-03 (46b.5): **a straight step's crease vertex goes on the column lattice** (D461); corners of steps
  (three tops) and rounded rims keep the QEF.

- 2026-11-03 (46b.6a, default chosen, owner to confirm): **the rule set's thresholds stay in cells at every level,
  not scaled to metres.** A node derives through the same rule set and mesher with no level input. A terrace lip at
  L2 is then a step of 0.5–2.5 two-metre cells, and a cliff a drop of more than 2.5 such cells. Why:
  - The radius, the job's apron and conformance stay one contract for every level.
  - The thresholds read the 4-bit fill, whose resolution is a fraction of a cell at any level. Scaled to metres,
    the L2 cliff drop would be 0.6 cells, inside the fill's rounding.
  - The mesher's crease and lattice rules are about the level's own voxel edges.
  - What a coarse level cannot hold (features under its cell) leaves through the downsample, not through the rules.
- 2026-11-03 (46b.6a, default chosen, owner to confirm): **the mip downsample** (derived v7):
  - The fill is the share of solid; liquid and openings add nothing. Before, they counted, and a lake shore became
    ground.
  - The role goes by `MIP_ROLE_PRIORITY`: wall, foundation, pillar, floor, stair, roof, terrain. A whole-cell body
    needs half the node cell, so a one-cell wall (exactly half) stays at L1 and a post or rail leaves.
  - Liquid takes the cell only when there is no solid.
  - The material is dominant among the counted cells (ties: the lower id), as before.
  - The alternative of the role of the dominant material's first cell (45.6) let one wall cell in eight turn a node
    cell into a full block, a 1 m cube from a 0.5 m post.
- 2026-11-03 (46b.6a): **a derived result records its level** and the canonical bytes carry it (derived 6 → 7). Every
  position and size stays in the level's cells, with one scale (`mipCellMetres`). The shader's blend distance
  stays a metres setting, converted per level by the chunk view (46b.8b), so a blend is equally wide at every
  level.


## 9. Open questions for the owner

- Ring distances (64/128/192 m) and whether 46b should also reach past the load ring or leave that to 46d's far field.
- Whether one composed rule set per world (terrain + construction) is right, or terrain should be selectable per world.
- The terrain mesher pick (46b.3a: column-lattice nets + crease placement) and the 3 cm slack it needs at a bump's rim.
- Deferring the displacement prototype to 46d (with the material model) instead of a 46b experiment.
