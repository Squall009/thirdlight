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
| 46b.2 | not started |
| 46b.3a | not started |
| 46b.3b | not started |
| 46b.4 | not started |
| 46b.5 | not started |
| 46b.6a | not started |
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

## 9. Open questions for the owner

- Ring distances (64/128/192 m) and whether 46b should also reach past the load ring or leave that to 46d's far field.
- Whether one composed rule set per world (terrain + construction) is right, or terrain should be selectable per world.
- Deferring the displacement prototype to 46d (with the material model) instead of a 46b experiment.
