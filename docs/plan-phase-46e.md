# Phase 46e — Lighting, regions and the walk graph

Status: **46e-a done 2026-11-16, the owner chose the voxel light volume (2026-11-16); 46e-b planned in the owner's order (§6), not started** on branch `phase-45` (worktree `~/projects/thirdlight-p45`, base
32faf2c0; main frozen at d4053cab). Planned from `docs/roadmap.md` (order of 2026-11-12), plan 45's 46e scope and
§5c, requirements R40, R45, R97–R104 and R110 (`docs/architecture/voxel-format-requirements.md`),
`docs/architecture/voxel-engine.md` §6 (foundations 2 and 7) and the 46f close (`docs/plan-phase-46f.md` §10: the
owner let the five defaults stand, 2026-11-14). It runs in two parts with an owner stop between them: **46e-a**
ends at the lighting storage choice; **46e-b** builds the choice out.

## 1. Scope

- **In, 46e-a:** GPU time per pass in the profiler (D655); one occupancy walk over voxels (CPU and GPU, one
  definition); open-region labelling with chunk connectivity and sky visibility; direct light and shadows on voxel
  worlds in Play; both lighting stores on voxels (phase 42's surface cache ported, the voxel light volume
  prototyped) and their A/B on one scene (R110), alone and as near cache + far volume; an acceptance page and a
  stop.
- **In, 46e-b (detailed after the owner's choice):** the chosen storage built out per tier, with edits, props and
  moving objects; rooms for light, cut-away and audio size; connectivity culling only if it measures better than
  the depth pyramid; the walk graph on a generic A* core with `ctx.voxels` path queries.
- **Out, with the phase that takes it:** structures on their own grids and their stitched walk graphs (47a, R40);
  door and window portal state as props (47a, R45's leaf and glass); far-cache channels, far water and fog (49);
  lit fog (51); retiring phase 42's cache, tracer scene kinds, room culling and `ctx.grid` (48, with the old
  systems they read); the world edit mode (47b); relief, detail-piece LODs, the mesh far field; anything inside
  block layers, heightfield terrain or generated architecture; WebGL 2 beyond its smoke test.
- **Carried defects in scope:** D655 (46e.1), D607 (far shade lit at the camera, 46e.4), D448 (prop coverage
  stamping, 46e-b), D654 (travel readings, a bounded trace in 46e.0). **Carried, not in scope unless touched:**
  D652, D656–D658, D646, D282, D601, D604, D594, D620, D621, D634, D644.

## 2. Owner requirements (quoted; REQUIREMENTS, never silently dropped)

- R110: "Lighting storage decided by the 46e A/B (phase-42 surface cache vs voxel light volume) with performance
  first; the owner leans to removing lightmaps, surfel caches and their texture reads even at a quality cost."
- R104 (proposal the A/B judges): "Voxel light volume (air-side, 6 directional values, coarse 1/2/4 m levels, saved
  settled bake per tile for low tier/WebGL 2) vs phase-42 cache."
- R97: "Chunk connectivity: per chunk, which of its six faces join through air." R98: "Sky visibility = highest
  solid voxel per column." R99: "Rays step 6-connected (no diagonal slip)."
- R101: "Rooms and portals come from roles (floor/wall/roof enclose, door/window are portals)."
- R100: "Walk graph samples the same surfaces, hierarchical per chunk; an edit rebuilds one chunk's piece."
- 2026-11-12: "Voxels are the single source of truth"; "name the foundation first".
- 2026-11-10: WebGPU first; the low tier at 720p upscaled, capped at 30 Hz on the Iris Xe; measure at the cap.
- 2026-11-11: budgets come from the hardware target; hobby pace; gates by affected area.
- 2026-11-12: no steering mid-phase; a new idea waits in the decisions register for the phase boundary.

## 3. What exists (survey of 2026-11-14)

- A voxel surface is a standard lit material: sun, ambient, the sky's environment and the clustered local lights
  reach it. It casts and receives **no shadow in Play**, has no occlusion from the voxels, and reads no bounce
  light. Far bricks carry baked occlusion in their colour and are lit at the camera's position (D607).
- Phase 42–43's stack (surface cache, tracer, live and baked probes, rooms) reads block layers, heightfield
  terrain, generated architecture and model bricks. **None of it has a voxel input**; most of its scene kinds
  retire in 48. Clustered lights, the shadow atlas and the cached sun map are generic.
- Derived per chunk today, in workers, never stored: occupancy (flag, 4³ brick bits, cell bits), light coverage
  (bits plus a partial list), nav (blocking bits, standable cells with clearance). **Nothing reads light or nav at
  run time** except `ctx.voxels.coverageAt`. The GPU holds "material is not air" per cell for resident chunks
  (`VoxelShaderGrids`), and distance bricks for the far field.
- **No ray walk over level-0 voxel chunks, no flood fill over voxel cells, no path query on voxels.** The only A*
  is `block-walk.ts` over block layers (retiring).
- Worlds with interiors: the town (houses with rooms, stairs, openings), alone and at the centre of the 8 km
  world; the caves and vertical worlds.

## 3a. three.js check

Done 2026-11-14 (46e.0): `npm view three version` (run by the lead) gave 0.187.0, equal to the pin; nothing to
assess, no update. No update without the owner.

Again 2026-11-16 at the start of 46e-b (the lead): `npm view three version` gave 0.187.0, equal to the pin; nothing
to assess, no update.

## 4. Budgets and how each item is judged

From `FRAME_BUDGET_BY_TIER` and `MEMORY_BUDGET_BY_TIER` (46f): at the low tier's 30 Hz frame the GPU's `lighting`
share is 20 % (6.7 ms) and the page's 6 % (2.0 ms); end-of-46f room on the 8 km town orbit is 21.8–22.0 ms.
Every lighting item reports, on the low tier at the cap and alone: GPU ms per pass (46e.1's reading), page and
simulation ms a frame from the profiler, memory against its table entry, the time for an edit to show in the
light, and pictures at five fixed cameras (street at noon, a room with a window, a cave, night with lamps, the far
view). Medium and high: pass shares only, "unverified on target hardware". A miss is recorded with its cause and
does not block; a tier that cannot afford a feature gets it switched off or cheaper, by a tier setting.

## 4a. Baseline (46e.0)

**Measured** 2026-11-14 14:24–15:05 UTC, Iris Xe, WebGPU, 1280 × 720, each run alone (`thirdlight-gate`
inactive, no build or other agent), every run in the brief's `MemoryMax=10G` scope with `TMPDIR` on disk; uptime
21.9 d, load (1 min) 1.3–4.1 (6.3 once, at the trace's export). Product code as at the phase start (the bench
commit bec4c31d, dist built at it before the runs); the D654 trace at d2cc91a3 (the profiler fixes below).
Staging's 8 km world (`voxel-slice`, world `far`), bake level 2 m, fine bricks off. Raw outputs with an `*.uptime`
beside each: `~/.cache/thirdlight-phase46e/work/46e.0/` (`measure.sh`, `trace.sh`). `<capped>` = the brief's
scope prefix; staging running unless the row says an export.

| What | Numbers | Reproduce |
|---|---|---|
| Headroom, low 30 Hz, 8 km town orbit (2 rounds) | room 176 ballast × 0.131 ms = 23.1 ms of 33.3 (both rounds); no load 0/89 missed both; frame GPU from the edge 8.2–10.3 ms (the line 6.3 / 5.7: they disagree, quote ms past the edge); hidden near 0 / 4.20 ms, far 2.73 / 5.14, shadows −0.93 / 1.83, post −4.33 / 0.54; shares of the four (round 2): near 36 %, far 44 %, shadows 16 %, post 5 % (round 1: far alone positive, noise at the cap as in 46f.6) | `<capped> node tools/voxel-bench/run.mjs headroom --quality low --rounds 2` (`headroom-low.*`) |
| Headroom, medium 60 Hz (1 round, unverified on target hardware) | room 64 × 0.129 = 8.3 ms; near 0.85, far 2.23, shadows 0.28, post −3.54 ms: near 25 %, far 66 %, shadows 8 % | same, `--quality medium --rounds 1 --scales none` |
| Headroom, high 60 Hz (1 round, unverified on target hardware) | misses at no load 15/178; near 4.42, far 7.34, shadows −1.16, post −3.76 ms: near 38 %, far 62 % | same, `--quality high` |
| Page and simulation a frame, 8 km town orbit (profile own time, no load, 2 rounds) | page 4.57 / 4.13 ms, simulation 2.05 / 1.82, job workers 0.07 / 0.08; **lighting (page) 0.050 / 0.045 ms of its 2.0 ms budget (worst 0.3 / 0.2)**; render 3.91 / 3.48 of 8.33, props 0.43 / 0.41; simulation voxel streaming 1.91 / 1.71 of 6.67 | the headroom rows' `profile` |
| Page and simulation at the five cameras (1 run) | page 5.29 / 4.58 / 3.35 / 3.61 / 3.30 ms, simulation 2.32 / 2.41 / 2.31 / 1.54 / 1.83 (street, room, cave, night, far); lighting 0.21 / 0.17 / 0.17 / 0.16 / 0.12 ms of 2.0 (worst ≤ 0.5): the page's lights, shadows and environment spans | `<capped> … light-shots --quality low --out DIR` (`shots/light-shots.json`) |
| Memory | page heap 594 MiB, GPU process 936 MiB at the town (low's 1,536 / 2,560: under). Resident-bytes table at the cameras: voxel streaming 47–98 MiB of 768, far on the GPU 77–92 of 384, textures 152 of 512; **surface cache and probe tiles: no reading (nothing registered on a voxel scene), budgets 32 and 128 MiB** | headroom `memory`; light-shots `shots[].memory` |
| Time for an edit to show in the light | **no light responds to a voxel edit today**; the floor is the edit to the first frame drawing the changed mesh: 53.3 / 22.3 / 32.7 ms (3 / 1 / 2 frames) for a 1 m runtime dig in the street (`ctx.voxels.dig`, 2–4 chunks rebuilt, swap 13–23 ms) | light-shots `edits` (`__tlVoxelPlay.edits()`) |
| Coverage, export, 60 m/s (2 rounds) | longest 53.8 / 51.7 ms, 0 > 100, missed 1.5 / 1.5 a min; ground 0.03 s, stands 0.25 s; detail 4.2 / 3.9 s, pending 7.8 / 7.8 s; falls 1/83 onto lower ground (0 through); 0 holes | staging up: `<capped> … coverage --export --quality low`; stopped: `<capped> … coverage --dir <export> --quality low --speed 60` (`cov-low-60-r*`) |
| Coverage, export, 150 m/s (2 rounds) | longest 45.9 / 51.9 ms, 0 > 100, missed 2.7 / 3.7 a min; detail 4.7 / 4.4 s, pending 8.5 / 8.2 s; falls 0/34; 0 holes | `--speed 150` (`cov-low-150-r*`) |

**The five pictures** (low tier, `run.mjs light-shots`, refused unless settled, drawing voxels and changing with
them hidden; looked at; a second run 40 min apart differed by 0.21 % of pixels at the street and 0 at the others):
`~/.cache/thirdlight-phase46e/work/46e.0/shots/` (each with a `-voxels-hidden.png` beside it).

| Picture | What it shows today |
|---|---|
| `street-noon.png` | the street between the house rows of lots 4 and 5, gable ends and fences; every surface lit by sun and ambient as if alone: no shadow anywhere (not from the houses on the grass, nor the fence on itself) |
| `room-window.png` | the centre house's ground floor, three windows in its west wall and the stairs: the room as bright as the street, walls, floor and ceiling lit evenly; no patch of sun under the windows, no darker corner |
| `cave.png` | 22 m into the dug cave looking out at the mouth and the valley: the tube's rock is as bright as the hillside outside; no occlusion, no falloff into the cave |
| `night-lamps.png` | the same street at night, five warm point lamps: lamp light falls on the house fronts, fences and grass with distance falloff; no shadow from the fence posts or houses is visible though the lamps ask for shadows, and the unlit fronts are near black (no bounce) |
| `far-view.png` | from 40 m over the town's east edge across the roofs to the western massif: far bricks and near meshes lit alike by the sun, no shadow from the mountains or the houses visible, no darkening in the valleys or between the houses |

**The content they needed** (engine-owned test data, made by the bench at each run, nothing in the generators):
the town has no cave and no lamps. The cave is one `editVoxels` dig stroke (spheres 6 m across along a horizontal
axis from 4 m outside to 26 m into the 45° hillside at (−406, 118.7, 558) m, 24,238 cells), kept in staging's
world after the first run (a later run's stroke answers `no_change`); the lamps are five point-light objects added
before Play and taken out after; the looks are two environment presets (`bench-noon`, `bench-night`, a clear
physical sky) kept in the project. A regenerated far world gets its cave back from the next `light-shots` run.
Auto-exposure is off on the camera, so the look's fixed exposure stands; the render scale is pinned to the tier's.

**D654, the bounded trace** (`trace-60.*`, `trace-150.*`, 1 round a speed after the 2 baseline rounds): why the
bench kept no long frame: (1) its own spike rule keeps gaps over 100 ms and long animation frames over 50 ms, and
none happened; (2) it never read the profiler; (3) the profiler counted a frame as a spike past 1.5 intervals,
which under a 30 Hz cap on a 60 Hz display is one missed frame exactly (50 ms), so a miss was never kept; (4) the
profiler's page global dropped `read(after)`'s cursor and answered every kept spike on each read. Fixed (3) and (4)
in `page-profile.ts` (threshold 1.25 intervals; the global passes the cursor) and the bench now reads the spikes
once a second. With the fixes, flights of 55.4 ms longest (60 m/s, 4 missed) and 46.2 ms (150 m/s, 6 missed) kept
no interval or page spike: the page's frames started on time by their animation-frame clock and no page frame's
own work passed the interval, yet the meter's stamps (taken when a frame's draw submission ends) were 46–55 ms
apart. The two simulation spikes (45.6 and 33.9 ms ticks, voxel streaming 39 / 27 ms, at the flight's first 2 s)
sit in the worker and did not stall the page. Cause not found; what is left is work on the page thread outside the
frame's spans or before its callback runs (worker messages, GC) under 50 ms, which neither rule sees. D654 stays open.

## 4b. GPU ms per pass, the baseline (46e.1)

**Measured** 2026-11-14 17:01–17:34 UTC at 2a43b318 (built), Iris Xe, WebGPU, 1280 × 720, each run alone
(`thirdlight-gate` inactive), in the brief's `MemoryMax=10G` scope; uptime 21.9 d, load (1 min) 0.9–2.6. The
page's GPU measurement (§8a 46e.1: `run.mjs headroom`, defaults: 5 interleaved repeats, 1.5 s windows) on the
8 km world's town orbit. Raw files with an `*.uptime` beside each: `~/.cache/thirdlight-phase46e/work/46e.1/`
(`measure.sh`; `m-low-r1..3`, `m-medium`, `m-high`, `shots/`, `village.*`). A category's number is its median
over the repeats; "±" its spread (interquartile range); "below" is below resolution (no number is given).

| Low, 30 Hz cap | run 1 | run 2 | run 3 | median of runs (range) |
|---|---|---|---|---|
| near (voxel near surfaces, kit pieces) | 1.48 ± 0.25 | 1.93 ± 0.21 | 1.61 ± 0.17 | **1.61** (0.45) |
| far (far field) | 3.63 ± 0.33 | 3.49 ± 0.10 | 3.24 ± 0.13 | **3.49** (0.39) |
| shadows | 0.18 ± 0.08 | 0.09 ± 0.05 | below (0.07 ± 0.10) | **0.09** (0.11) |
| post | below (−1.47) | below (−1.74) | below (−1.72) | below: the hide costs more than the stack (D661) |
| lighting, effects | no pass on this page | | | — |
| the control (hides nothing) | −0.06 ± 0.01 | 0.03 ± 0.04 | 0.06 ± 0.10 | resolution 0.04–0.10 |
| GPU budget render (near + far) of 18.33 | 5.11 | 5.42 | 4.85 | 5.11 (28 %) |
| GPU budget lighting (shadows + lighting) of 6.67 | 0.18 | 0.09 | — | ≤ 0.2 (≤ 3 %) |
| the whole frame's GPU ms (the line through the ballast) | 9.02 | 8.01 | 8.97 | 8.97; a ballast copy 0.128–0.132 ms, the frame past the cap 51–53 ms |
| the measurement's own time | 125.6 s | 125.6 s | 125.6 s | |

Medium and high, one run each, **unverified on target hardware** (shares of what was measured): medium (60 Hz)
near 2.14 ± 0.50, far 3.97 ± 0.66, lighting 0.25 ± 0.19 (phase 42's live light runs at medium), shadows and post
below — near 34 %, far 62 %, lighting 4 %; 146 s. High: near 5.86 ± 0.41, far 8.71 ± 0.69, shadows, lighting and
post below — near 40 %, far 60 % (the frame misses 60 Hz with no load: 15 of 174); 146 s.

At the five lighting cameras (low, `light-shots --gpu`, one run, `shots/light-shots.json`): far 1.20 / 0.94 /
0.98 / 1.91 / 4.12 ms (street, room, cave, night, far view), shadows 0.13 / below / below / 0.40 / below, near
below at the four close cameras (−0.6 … −2.2: D660) and 1.58 at the far view; post below everywhere.

An old-stack scene (the perf village class's export, medium, 60 Hz, the camera flying a 60 m loop so the
surface cache keeps relighting; `node tools/perf/run.mjs village --renderers webgpu --vsync --no-bare
--gpu-measure --flight 60 --viewport 1280x720 --query quality=medium`, `village.json`): **lighting 0.33 ± 0.01
ms** (phase 42's surface light, probes and reflection tracer), shadows 0.32 ± 0.05, post 1.48 ± 0.24, effects
below, near and far absent; 131 s.

## 5. Where things live (reuse first; never copy)

| Thing | Home | Reuse |
|---|---|---|
| GPU time per pass | `three-adapter` (`gpu-headroom.ts`), `game-host` (`voxel-meter.ts`, `page-profile.ts`), editor Profiler tab | the headroom meter's hide-a-pass method (`tools/voxel-bench/headroom.ts`), moved where the page can call it |
| Occupancy walk | `@thirdlight/voxel` (CPU), `three-adapter` (the same steps in WGSL over the shader grids and distance bricks) | `ScalarOps` (shared), `ChunkTreeFlags`, `far-bricks-node.ts` march, the derived occupancy and light coverage |
| Region labelling, connectivity, sky columns | `@thirdlight/voxel` derive workers; stitched in the streamer | the derive contract, `WorkerPool`, `job-queue` |
| Region and ray queries for games | `runtime` (`ctx.voxels`) | `voxel-world-host.ts` |
| Voxel shadows | `three-adapter` (`voxel-chunk-view.ts`) | `cached-shadow.ts`, `shadow-atlas.ts`, `?voxelShadows=static`'s path |
| Surface cache on voxels | `three-adapter` (a voxel tile source and a voxel tracer scene kind) | `surface-cache.ts`, `surface-cache-scene.ts`, `surface-light-pass.ts`, `surface-probes.ts`, `tracer-scene.ts`; `surface-cache-blocks.ts` and `-terrain.ts` are the charting patterns (retiring code, read not touched) |
| Light volume prototype | `three-adapter` | `camera-window.ts` and the region-texture helper (46f), the walk, clustered lights |
| A* core, walk graph | `@thirdlight/shared` (the core), `@thirdlight/voxel` (the graph) | the derived nav cells; `block-walk.ts` is the pattern and is left to retire |
| Time slices and budgets | `shared` `frame-arbiter.ts`, `project-model` tables | no new constant |

## 6. Items

### 46e-a

| Item | Builds |
|---|---|
| 46e.0 | The three.js check; the baseline (§4's numbers and five pictures as they are today, on the town inside the 8 km world); a bounded trace of D654 with the profiler's spike capture. |
| 46e.1 | **GPU time per pass in the profiler (D655).** The meter's hide-a-pass measurement callable from the page: an on-demand "Measure GPU" in the Profiler tab, the overlay and `tl_diagnostics`, filling the GPU budget rows per category (near, far, shadows, lighting, post, effects); the bench reads the same routine. **Built as** (§4b, §8a 46e.1): a category's ms is the frame's GPU time with that category hidden, under ballast past the cap, net of what the hide changes elsewhere (D660, D661); not a timestamp per pass. |
| 46e.2 | **One occupancy walk.** A 6-connected walk (R99) over level-0 cells, skipping empty space by the chunk tree's flags and continuing into far bricks; one definition for the CPU and the GPU; partial cells by light coverage; `ctx.voxels.raycast`; the editor's voxel picking through it. Measured: rays a millisecond on both. **Built as** (§8a 46e.2): not one definition. Three arithmetic step helpers (`walk-steps.ts`: crossing time, first of three, order of two) are shared and generated into the WGSL; the loop, the block and brick traversal, the hash lookup and the box crossings are written twice (`occupancy-walk.ts`, `voxel-walk-wgsl.ts`) and held equal by a 1,200-ray check; the GPU walk stops at the mips (D662), the CPU's goes on into far nodes. |
| 46e.3 | **Open regions.** Connected non-solid cells labelled per chunk in the derive workers and stitched across chunk faces as chunks arrive: face connectivity (R97), sky columns (R98), regions with an enclosed flag, volume and portals from the opening role (R101); rebuilt for one chunk on an edit; `ctx.voxels.regionAt`; a tint overlay to see them. A derived output: an add-only note in the format spec (§8, owner). **Built as** (§8a 46e.3): regions come from derived occupancy (open = not drawn as a body), not from roles; only portals use a role (`opening`); "enclosed" means no sky column, complete and not at the world's edge. |
| 46e.4 | **Direct light.** Voxel surfaces and kit pieces cast and receive sun shadows in Play through the cached static map plus the dynamic map, and local-light shadows through the atlas; an edit refreshes what it touched; the far shade lit at the hit (D607); a far sun shadow by a short march through distance bricks, kept only on the tiers that afford it. **Built as** (§8a 46e.4a, 46e.4b): the far sun shadow is a per-column height-field shade line, not a march per pixel through distance bricks: two windows of column tops (sky heights; far bricks' tops) are marched toward the sun in compute, a tile row a frame, and lit pixels past the map read their column's line; on every tier (`voxelSunSteps` 12 / 16 / 24), WebGPU only. |
| 46e.5 | **The surface cache on voxels.** Phase 42's cache fed by voxel surfaces: a voxel tile source (charts over the mesher's faces by their main axis, as block chunk columns and terrain rings are charted today), the tracer walking voxel occupancy as a scene kind (46e.2's walk), direct light and live probes over it, edits marking tiles stale. A candidate, built only as far as a fair measurement needs. |
| 46e.6 | **The voxel light volume.** R104's volume on the same town: air-side cells beside surfaces with six directional values, the 1/2/4 m levels for open air, sky and sun by the walk, one bounce, local lights; read by voxel surfaces, kit pieces and moving objects. A candidate, to the same depth. **Built as** (§8a 46e.6a, 46e.6b): the volume holds sky light and one bounce (of the sun and of lamps); the sun's and lamps' direct light stay per pixel (the shadow maps and the atlas), not in the volume; level 0 in 2 m bricks in a fixed window round the eye (one size on every tier) and a pool of fixed size (D702). |
| 46e.7 | **The lighting storage A/B (R110), same scene, same cameras.** Three arrangements on the town inside the 8 km world: the cache alone, the volume alone, and the cache near with the volume beyond a distance (the owner's hybrid, the hand-over distance a setting); §4's table and pictures for each, on the low tier at the cap, with medium and high as shares. **Built as** (§8b): the hybrid measured is the cache's live probes near (its texels lit but not read per pixel, its lookup hash made but unused: D699) and the volume beyond, not the cache's surfels near. |
| 46e.8 | Close of 46e-a: the gate, the independent review, fixes, results, an acceptance page (pictures of the three side by side, at most five questions, the lead's recommendation by "performance first"), STATUS. **Stop for the owner.** |

### 46e-b (owner 2026-11-16: the volume; the order below is the owner's)

**The item list and its order were approved by the owner on 2026-11-16** ("The suggested order and phase layout is approved"). The lead's handoff for a fresh session: `docs/briefs/handoff-46e-b.md`.

The store is the voxel light volume. Nothing is tuned until every light type is in it and its observed defects are
fixed, so the tuning is done once, on the whole thing. The low tier's target is 720p at the 30 Hz cap. The item
numbers 46e.9–46e.13 of the plan's first outline are replaced by these.

| Item | Builds |
|---|---|
| 46e.9 | **Remove the cache's voxel port and the hybrid.** The voxel tile source and charts, the faces' hashes, the chart worker, the tracer's voxel scene kind, the probes over voxel marks, the hand-over, the `cache` and `hybrid` values of `?voxelLight` (left: `off`, `volume`) and their bench flags and tests. Phase 42's own stack is not touched (it retires in 48). The rows that only described them are closed as superseded (D679, D682–D686, D699, D700, D704, D706). The e2e Play test loses their checks. |
| 46e.10 | **The default path's cost** (owner's answer 5; shadows and the sun field stay on at every tier): fix D667 (stitching at speed), D675 (the sun field's march at speed), D701 (the later settle after a stop); trace D672 (page render +0.9–1.8 ms with no store on) and the end-of-phase round that held only 7 copies of room at the cap. Same-hour, interleaved against the 46e base. |
| 46e.11 | **The emissive material entry: a proposal, then a stop.** The glow is a property of the voxel's material, never stored per voxel; the volume keeps it per cell as it keeps the bounce colour. This item writes the add-only entry for the material record (`voxel-render-spec.md`) and what the volume reads of it, for the owner's approval. Nothing of it is built before the owner's note. Written first so the approval can arrive while 46e.12 is built. |
| 46e.12 | **Every light type in the volume.** (a) A lamp list per brick, in world space, built in compute, in place of the flat loop over every lamp in the window (`voxel-light-volume-wgsl.ts` `direct_light`); the clustered lists are per camera and cannot serve bricks off screen. (b) Spot lights bounce with their cone, not as points. (c) Area lights add bounce. (d) Emissive materials light the cells beside them, after the owner's note on 46e.11. |
| 46e.13 | **The observed defects, fixed on the update side.** Blotches (D692), rooms too dark, the gable patches (D695), the stale texture swap (D696), the update running over its budget (D690, a pacing bug). The look is fixed where cells are written (accumulate while idle, filter as cells are written), not in the per-pixel read, so the tuning that follows cannot undo it. |
| 46e.14 | **A many-lamps scene, then the tuning.** First an engine-owned bench scene with many lamps of every type beside the town (every figure so far is from a town with a few lamps). Then, measured on both: the per-pixel read's cost (D705), the update's share of the frame, the low tier's setting; the volume's bare constants become tier settings or table entries as they are tuned (D702, D703, D708). The volume is switched on per tier here. |
| 46e.15 | Props through the coverage channel (D448) and particles reading the volume: what is left of the first outline's build-out. (Placement after the tuning is the lead's default, owner to confirm: props entering the volume's rays change its cost, so if it should count in the tuning it moves before 46e.14.) |
| 46e.16 | Rooms from regions: light kept indoors, cut-away and see-through "enclosed air", a room size for audio. |
| 46e.17 | Connectivity culling measured against the depth pyramid on the town's interiors and the caves; built only if it wins. |
| 46e.18 | The walk graph (R100) on a generic A* core; `ctx.voxels` path and reach queries; the path-finding span in the profiler. |
| 46e.19 | Close: gate, review, acceptance page, STATUS, the design page. |

**Not in 46e-b (owner 2026-11-16):** a compute build of the clustered light lists (the CPU build is 0.2–1.6 ms and
the Iris Xe is bound by its GPU); baking the volume to disk (a possible later item; it would need a format entry);
measuring the hybrid with the cache's texels near.

**Owner stops in 46e-b:** the emissive material entry (46e.11) before anything of 46e.12 (d) is built; any other
change to an approved format or spec; a newer three.js.

## 7. Progress

| Item | Status |
|---|---|
| 46e.0 | Done 2026-11-14 (bec4c31d, d2cc91a3): three.js 0.187.0 = pin; five lighting cameras + `run.mjs light-shots` (cave dug, lamps, two looks; refuses unsettled or voxel-less shots); baseline §4a: room 23.1 ms, page 4.1–4.6 / sim 1.8–2.0 ms, lighting 0.05 of 2.0 ms, edit to screen 22–53 ms (no light responds); D654 traced, profiler spike fixes, cause open |
| 46e.1 | Done 2026-11-14 (1129d456…16e5e566): Measure GPU (Profiler, overlay, `tl_diagnostics` gpu/gpuMeasure, benches) — ballast past the cap, a category hidden between two shown windows, GPU completion times burst to burst, 5 repeats; low town near 1.61, far 3.49, shadows 0.09 ms, run-to-run ≤ 0.45 ms (§4b); D660 near's hide, D661 post's |
| 46e.2 | Done 2026-11-14 (f17f4a48…): one 6-connected walk (CPU; a WGSL twin sharing 3 step helpers, equal by check) over level 0 and mips (the CPU also far nodes; the GPU not: D662); `ctx.voxels.raycast`; picks walk it; GPU = CPU 0 of 1,200 differ; rays/ms worker 360–430 / 170–215 / 19–20, GPU 28k / 17k / 1.6k (short, medium, long; §8a); D662–D664 |
| 46e.3 | Done 2026-11-15 (531a2d5b, 5bf24807): open regions derived per section (v32, spec entry), stitched where the world runs, `ctx.voxels.regionAt`, voxel page overlay, sky heights to the page; town 120 enclosed / 3,181 portals; derive 7 % of a section; stitch 1.4 ms/frame loading, 0 settled; edit → answer 91 ms; 150 m/s sim spikes 1 → 14 (D667); D665–D669 |
| 46e.4 | Done 2026-11-15 (cd2ce0ac; a3a8f2cf, 76f3ef48): near voxel draws and kit pieces in the sun's cached map and the atlas; past the map sun heights (sky heights, far bricks' tops) marched in compute into per-column shade lines, faded in at its edge; far shade lit at the hit; low shadows 0.63 vs 0.43 ms off; edit → field 0.6–1.2 s; D607, D670 fixed, D671 narrowed, D673–D675 |
| 46e.5 | Done 2026-11-15 (a, b; c: 52c88694…f6c8bcd0): charts on the view's worker, faces' hashes kept across changes, a chunk marks what it can shadow; street lit 18.9 s from Play (30), 1.5 M texels for 1.4 M; settled GPU lighting below res., page 0.25–0.44 ms; relighting 6.7–18.9 ms GPU; orbit no room at 30 Hz; edit → light 0.3 s, settled 2.4–2.9 s (§8a 46e.5c) |
| 46e.6 | Done 2026-11-15 (a; b: e3d86ffb, 4d04a538): coarse 1/2/4 m levels, read by every lit draw; one pool (D691 fixed); settled no GPU, updating 8.9–11.2 ms (D690), orbit 5.9–6.5; near +1.3–4.8 read or not (invalid: the read was not off, D698; see §8b); 29.8 MB; edit → light 0.07–0.11 s, settled 0.5–1.7 s; Play → settled ≈ 20 s |
| 46e.7 | Done 2026-11-16 (225ec7b5, b99489b2): `?voxelLight=hybrid` (cache probes near, volume past `voxelLightHandoverM`, 12 m low); A/B in one session, §8b: orbit room off 136 / cache 1 / volume 76 / hybrid −1 copies; settled near over off +2.3 / +4.1 / +5.9 ms (room); edit → settled 2.5 / 1.7 / 4.7 s; D693 = the read (D698); D697–D700 |
| 46e.8 | Done 2026-11-16: travel fixes (D694 fixed; D667, D675 narrowed); phase gate 37 min (46f: 30), unit green, e2e 324/328, a chart-worker leak found and fixed (rerun green); review "close after fixes", fixed (derived v32, travel row re-measured, D699 counted); acceptance `docs/briefs/acceptance-46e-a.md`. **Stop: the owner chooses the store.** |
| 46e.9 | Done 2026-11-16 (0c832013, 086737dc): cache port + hybrid removed, 54 files +206 −5,089; `?voxelLight=off|volume` (else off), off by default; Play e2e 3.4–3.8 → 2.5 min, voxel area 364–374 → 288 s; pictures as at the 46e-a end (A B A B: within run-to-run); orbit room 192 copies; D679, D682–D686, D704, D706 superseded, D699/D700 narrowed |
| 46e.10 | not started |
| 46e.11 | Proposed 2026-11-16 (24296e84), published as acc46e-11: `docs/briefs/proposal-46e.11-emissive.md` — no new stored field (the voxel path reads the record's `params.emissive` × `params.emissiveIntensity`; the volume keeps one more word a cell, 28 → 32 B); three questions with defaults. **Waiting for the owner's note; nothing built.** |
| 46e.12 | not started |
| 46e.13 | not started |
| 46e.14 | not started |
| 46e.15 | not started |
| 46e.16 | not started |
| 46e.17 | not started |
| 46e.18 | not started |
| 46e.19 | not started |

## 8. Format and spec steps (owner stops)

- **Region labels, face connectivity and sky columns** are new derived outputs (worker-built, never stored).
  **Approved by the owner 2026-11-14** for this phase: "Yes I approve of the spec change for the proposed testing
  of lighting voxels in this phase." 46e.3 writes the add-only entry in `voxel-format-spec.md` §3.7 (and the
  format register) with that note, in the commit that lands the outputs. The approval covers these three derived
  outputs only; anything else in an approved spec is still a stop.
- **Light coverage on the GPU** (if the shader grids' "material is not air" is not enough for the walk): a GPU-side
  texture built from the derived coverage; no stored format.
- **A saved light bake** (R104's "saved settled bake per tile", O19) is stored data: not built in 46e-a; a
  proposal and a hard stop in 46e-b if wanted.
- No change to the voxel value, the region files, the far cache, the render, role or kit specs is planned.

## 8a. Results

### 46e.1 — GPU ms per pass category, on demand

**Built.** One routine, game-host `gpu-measure.ts` (`measureGpu`, `GpuMeasureRun`): on the running page it holds
the render scale (dynamic resolution off) and texture streaming, warms each category's hidden programs, loads
the frame past its cap with ballast (doubling from 32 copies, then a line through the points past the cap gives
a copy's ms and the frame's own GPU ms; it settles at max(1.5 intervals, interval + 20 ms)), then runs the
categories present (and a control that hides nothing) interleaved: everything shown, one category hidden,
everything shown, … , five times with the order rotated; a reading is the mean of the two shown windows less the
hidden one. Frames are timed by the GPU's own completions (`onSubmittedWorkDone` after each frame, three-adapter
`gpu-headroom.ts`'s `gpu` clock), taken burst to burst (`windowMean`). A category is its median with its
interquartile spread, and **below resolution** (no number, never a negative) unless its median is above both its
spread and the control's. Results carry each budget row (`GPU_PASS_BUDGET`: near, far → render; shadows,
lighting → lighting; post → other; effects → effects; budgets from `FRAME_BUDGET_BY_TIER`), the frame's GPU ms,
every window's trace, and how long it took. WebGL 2: "not available" (no completions).

Passes register how to hide themselves (three-adapter `gpu-pass-hides.ts`, one registry a page; a hide that
throws leaves everything shown): `near`, `far` (the voxel draws), `shadows`, `post` (the GPU load), `lighting`
(phase 42's surface light, probe and reflection passes: not dispatched while hidden, `adapter-surface-light.ts`),
`effects` (particles: not stepped or drawn; the interaction field's pass not run). A later lighting pass
registers with one call where it is made:
`const off = gpuPassHides.register({ category: 'lighting', name: '…', present: () => live, hide: (h) => (hidden = h) })`
(and `off()` on dispose); its frame code then skips its dispatch while `hidden`.

Callers: the Profiler tab's **Measure GPU** (bar: progress, Stop; Budget: the per-pass table and the GPU budget
rows), the overlay's Shift+F3 view (a Measure GPU button, the lines), `tl_diagnostics` sections `gpuMeasure`
(starts) and `gpu` (reads), `__tlProfiler.gpu` (`start`, `state`, `cancel`), the profile report's optional
`gpu.measure` (capture `version: 1` unchanged for older readers), `run.mjs headroom` (its own hide-a-pass copy,
past-edge line and pass shares deleted; it keeps the room search, copies and scales), `light-shots --gpu`
(per camera, with a picture after; `--gpu-only`) and perf `village --gpu-measure`. A pass of known size for
checks: `__tlVoxelPlay.meter.set({ knownPass: { category, units } })` (ballast copies under a category).

**Why the old reading swung (46e.0: near 0 then 4.20, post −4.33 then 0.54).** Four causes, in order of size,
each seen in the windows: (1) past the cap the page *submits* frames in bursts (46e.0's windows: p50 33 ms, p95
280 ms at a 106 ms mean), so a window's mean from the page's stamps moved by a burst over its ~56 frames, ±4
ms; (2) the shown frame was read once at the start and once at the end of the hides, minutes apart, so drift
landed in every pass; (3) one window a pass, no repeat; (4) the load sat at 3× the cap (106 ms frames, few
frames a window). Bounded experiments on the town (`e1`–`e4.*`): GPU completions with a trimmed mean — they
arrive in pairs (0.2 ms apart, 128 ms between), the trim dropped the gaps, control ±26 ms (`e2`); the plain
span — ±1 burst a window, control spread 1.98 ms (`e3`); burst to burst — control 0.19 ms with 3 repeats
(`e4`), 0.04–0.10 ms with 5 (§4b).

**Resolution.** In one run a category's spread is 0.05–0.33 ms and the control's 0.04–0.10 ms; the same
scene's medians move by up to 0.45 ms between runs minutes apart. So a 1 ms pass is told from none in one run,
and two runs compared need a difference over about 0.5 ms (interleave runs A B A B for less). With another
GPU load on the machine (an e2e worker beside it) the control's spread rose to 2–5 ms: measure alone.

**What it cannot read.** A pass whose hide changes what others draw reads its *net* cost: near at close
cameras reads below zero (with it hidden the far field draws where its depth used to stop it), and post's hide
draws the scene plainly and copies it, which costs more than the low tier's stack (D661). Both are reported
below resolution, never as a number. Hiding near leaves the close cameras' pictures changed (D660).

**Tested.** vitest: `game-host/src/gpu-measure.test.ts` (a simulated GPU at a 30 Hz cap with a drifting clock:
near 6, far 3 and a 1 ms lighting pass read back within 0.3 ms, a 0.02 ms pass below resolution, the budget
rows, everything given back, hidden windows always between shown ones; nothing to read when no pass costs
anything; a failing window gives everything back; median/spread/below-resolution from fed samples; the burst
mean), `page-profile.test.ts` (the run through the profile's source, its state in the read),
`three-adapter/src/gpu-pass-hides.test.ts` (exact hides, present, late registration, a hide that throws leaves
nothing hidden), `gpu-headroom.test.ts` (shadows and post as registry hides, GPU-clock stamps, the known pass),
`lighting-cameras.test.ts` (`--gpu`). Playwright, real backend, WebGPU: `voxel-world.e2e.ts` Play (high tier):
Measure GPU shows progress, Stop ends it; two runs of `lighting` with a known pass of 40 ballast copies and of 0:
with it 4.34 ± 0.65 ms (40 × 0.133 = 5.3 expected; ratio 0.82, the test asks 0.6–1.6), without it below
resolution, the difference past both spreads; the Budget tab's GPU table (now first in Budget) and lighting row;
the Play test 37 s → 90 s, the voxel area 163 → 216 s (gate-fast-20261114-150640 → -174938): two short runs are
the least that proves a reading against a known size.
`engine-stats.e2e.ts` (export overlay: the Measure GPU button and its line), `mcp.e2e.ts` (`gpu` starts nothing,
`gpuMeasure` starts, neither in an unnamed answer), `playtest.e2e.ts` (whole answer without them).
**With the feature broken:** a routine returning zeros or hides wired to nothing reads the known pass below
resolution and the e2e fails at "the known pass reads above resolution" (run once on the vitest twin:
`broken-hides-vitest.log`, `near` read null for 6 ms); one that never finishes fails its 60 s poll; a button
wired to nothing fails the "running" note.

**Gate.** `gate-fast-20261114-161750` red on the new Play check (the test world's far field reads 0.16 ms,
under resolution with another worker's GPU load: replaced by the known pass) and 4 tests under the all-areas
load (project-items D331, shadows D645, terrain-cdlod D428 on watch; frame-rate-cap D659), all green in
`gate-rerun-20261114-165345`. At da090501: `gate-fast-20261114-180035` red on project-items (D331, watch) and the
46f Profiler check's job lane (no job bar in the panel's first read, before this item's part; passed on rerun),
`gate-rerun-20261114-181214` green (the known pass read 5.13 ± 0.19 ms against 40 × 0.128 = 5.10; without it
below resolution; village perf at 60 Hz 0/360 missed, main 6.01 ms).

**Looked at** (opened): the e2e's Profiler at 1280 × 720 with the GPU rows filled (lighting 5.13 ± 0.19 ms, the
lighting budget row 3.33 ms at high: 154 % over, red; `~/.cache/thirdlight-phase46e/work/46e.1/e2e-shots/profiler-gpu-1280-final.png`;
the earlier `profiler-gpu-1280.png` had the table below the fold, now first in Budget), the light-shots pictures
`~/.cache/thirdlight-phase46e/work/46e.1/shots/*.png` and `shots6-near/room-window-after-gpu-later.png`
(softer, with green in the ceiling's plank gaps: D660).

### 46e.2 — one occupancy walk

**Built.** A ray walk over the voxels' derived occupancy, 6-connected (R99: one axis a step, ties x, then y, then z,
so it never passes between two cells that touch by an edge). `@thirdlight/voxel` `occupancy-walk.ts` (`walkVoxels`,
`walkRay`): a world is read as blocks of one level's cells (a derive section at level 0, a mip node above), each
empty, solid or mixed, a mixed one as 4³ bricks, a mixed brick cell by cell; empty blocks and bricks are crossed in one
step that lands in exactly the cell a cell-by-cell walk would reach (the crossing times along the other axes are
searched, never summed). At each block the finest level that knows it is taken; where none does, a far node's bricks
are marched (`marchFarNodeFrom`, the brick renderer's march entered from wherever the walk is); where nothing is known
it passes as through air. A hit gives the distance, the level-0 cell, the face's normal, the level, `far`, and at
level 0 the voxel record. Sources: `walk-sources.ts` (`streamerWalkSource` over a streamer's sections and mip nodes;
`FarWalkNodes`, the far nodes drawn, copied before the batches hand them over in a worker, counted in `voxelStream`).

**One definition, and proven equal.** The arithmetic (a crossing's time `(rel − frac) × inv` from integers, the
first of three crossings, the order of two) is written once over `ScalarOps` (`walk-steps.ts`): the CPU runs it in
32-bit floats (`F32_SCALAR_OPS`, new in `shared`), the WGSL is written from it (`wgslScalarWriter`, new in `shared`).
The loop, box crossings and lookups are written on each side (`three-adapter` `voxel-walk-wgsl.ts`, `voxel_walk`), so
the browser check runs both on the same rays.

**GPU.** The draw batches carry the walk's blocks packed (`walk-pages.ts`: 32³ blocks of every level, a page of
brick and cell bits per stop for a mixed block, 8,320 bytes; a hash table, linear probing, half full at most) and the
page mirrors them as two storage buffers (`voxel-walk-gpu.ts`, `VoxelWalkGpu`; WebGPU only, WebGL 2 drops them). A pass
that walks rays includes `voxelWalkWgsl({ group, table, pages })` and calls
`voxel_walk(cell: vec3<i32>, frac: vec3<f32>, inv: vec3<f32>, max_t: f32, stop: u32, max_level: u32) -> VoxelWalkHit`
(`voxel_walk_ray(origin_m, dir, …)` makes the first three); it binds the table (`array<vec4<u32>>`) and the pages
(`array<u32>`). Levels 0 and the mips are walked; the far bricks are not (D662). Memory at the 8 km town (low): 2,877
blocks, 333 pages: 4.9 MB on the page, 8.5 MB on the GPU, a share of the chunks drawn (no budget row).

**Partial cells (default, owner to confirm).** `solid` (picks, the default): a cell drawn as a body (the derived
occupancy bit: a whole-box form, or ground half full or more). `light`: a solid cell whose light coverage is
`LIGHT_STOP_COVERAGE` = 128 of 255 or more (R103's half): ground by its fill, a damaged construction cell by its
integrity, so a cracked wall at a low stage lets light through though a pick still hits it. Liquid, openings and air
stop neither; props' coverage is not in the walk.

**API.** `ctx.voxels.raycast(origin, direction, maxDistance, { stop?: 'solid' | 'light' })` → `{ distance, point, at,
normal, voxel, far }` or null (runtime `voxel-world-host.ts`, in Play and exports; reference regenerated). The voxel
world page's picker walks its streamer (`cellPicker`, `aimAtPointer` kept), not the meshes drawn.

**Measured** 2026-11-14 19:19–19:28 UTC, built at 62a9194c, alone (gate inactive), the brief's 10G scope; uptime 22.1 d,
load 0.9–2.6; 2 rounds; raw `~/.cache/thirdlight-phase46e/work/46e.2/walk-r1.*`, `walk-r2.*`
(`node tools/voxel-bench/run.mjs walk --play`). Rays (stop: light) from points within 2 m of the street camera: short
8 m in every direction, medium 64 m, long 2 km at 0°–30° up. Node: the generated town derived in-process (level 0 over
192 m, far nodes of 2 m cells over it). Worker: Play on staging's 8 km world, low tier, a script walking ~770–930 rays
a step, its `scripts` ms a frame against none. GPU: the bench pass (8,192 rays a frame, `lighting`) read by
`measureGpu({ only: ['lighting'] })` at the 30 Hz cap.

| Rays a ms | short (8 m) | medium (64 m) | long (2 km) |
|---|---|---|---|
| CPU, Node, skipping (cell by cell) | 627 / 669 (561 / 613) | 215 / 193 (112 / 109) | 9.2 / 7.8 (8.4 / 7.0) |
| CPU, simulation worker | 426 / 359 | 215 / 170 | 20.2 / 18.7 |
| GPU, Iris Xe, low, 8,192 rays a frame | 0.29 ms / below resolution (0.17): ≈ 28,000 | 0.47 / 0.48 ms: ≈ 17,000 | 5.06 / 5.04 ms: ≈ 1,600 |

So **in 1 ms**: a worker walks ~360–430 short, ~170–215 medium or ~20 long rays; the GPU ~28,000 short, ~17,000 medium
or ~1,600 long (long GPU rays cross unknown space block by block with a lookup at every level: D662). Long CPU rays
march far nodes (D663).

**GPU = CPU.** The page's GPU walk against the CPU walk over the same blocks, ray by ray (end, distance to the bit,
cell, face, level): Play e2e 1,200 rays (370 hits, 830 misses), **0 mismatches**; the 8 km town 1,200 rays (840 hits,
360 misses), 0 mismatches, both rounds. Level 0 and the mips only: no tolerance needed (the far bricks are not on the
GPU).

**Far continuation at the ring edge.** Past what level 0 knows the walk takes the mip node, then the far node drawn
there. vitest on a 20 m cliff (level 0 within 12 m, far nodes of 2 m cells past it): 408 of 415 rays meet the ground
within 1.5 m of where level 0 stops them (the stated tolerance: 95 %); a ray grazing an edge may pass it in the coarse
bricks (7 rays, the worst 34 m over the cliff's top onto the low ground). Walls and roofs thinner than half a far cell
are not in the far nodes.

**Tested.** vitest: `packages/voxel/src/occupancy-walk.test.ts` (4,500 random rays on blob worlds across negative
coordinates and block faces equal to a cell-by-cell reference, with and without skipping; edge and corner contacts
hit; start inside; a coarser level where level 0 does not know; the packed table equal to its views; the table through
growth and deletions); `tools/voxel-bench/walk.test.ts` (town and caves, solid and light, 1,200 rays each equal to the
reference both ways; records; light stops a subset of solid; packed blocks equal; far tolerance). Playwright
(`voxel-world.e2e.ts`, WebGPU): the Play script's rays meet the pad (distance 6 m, normal up, a voxel) and the sky,
light too; the GPU check above; a click right after the camera's jump digs the wall (no frame waited).
**With the walk broken:** ties counted as crossed (a diagonal step) fail the reference test
(`broken-diagonal-vitest.log`); a walk returning null fails `rayGround`; a WGSL walk reading wrong bits shows
mismatches; a WGSL that did not compile hung the check's read back (found so: `from` is reserved in WGSL) and is now
said on the console. The Play test 90 s → 84–86 s alone (the GPU check 25–50 ms).

**Gate.** At 43e8af8b: `gate-fast-20261114-192922` (every area: `shared` changed) red on two watched tests under the
all-areas load, block-editor's Paint step (D412) and shadows' cached map (D645), both green in
`gate-rerun-20261114-200347` (village perf at 60 Hz 0/360 missed, main 6.16 ms); the voxel area 216 s (216 s before).

### 46e.3 — open regions

**Built.** Shared foundation 2 (voxel-engine.md §6). Per level-0 derive unit, in the derive job beside the other
consumers (`@thirdlight/voxel` `open-regions.ts`, derived v32, radius 0: only the unit's own cells): the open cells
labelled 6-connected into components, each with its cells, the unit faces it reaches and its region–portal contacts;
the 15 face pairs joined through open cells (R97); the highest solid cell + 1 of each column (R98). Where the world
runs (the simulation worker in Play and exports, the page on the voxel world page) `OpenRegionStitch`
(`open-region-stitch.ts`) joins each storage chunk's units into its components (a uniform air or solid chunk is one
value) and those across chunk faces: a region that lost a node is walked again from its remaining nodes (the largest
part keeps the id), a new node joins the regions it touches (the largest takes in the others, keeping its id). A chunk
derived again with the same regions is left standing. It runs in the derive slice (`voxelDerive`, at least one chunk
an update). Sky heights a column are stitched upward over the chunks known and sent to the page with the draw batches
(`sky-columns.ts`, `SkyColumns`: 2 KB a chunk column, plain arrays on every renderer, counted in `voxelStream`).

**Definitions.** *Open cell*: not drawn as a body (the derived occupancy; the walk's `solid` stop): air, liquid,
openings, rails, posts, beams' bars. *Region*: open cells joined across faces (never by an edge alone), `opening`
cells excepted. *Portal*: joined `opening` cells, a boundary between regions (a doorway separates the room from the
street; a dug hole is air and joins them). *Sky*: a cell at or above its column's sky height (nothing solid above
it in the chunks known; space no chunk knows counts as open, the walk's rule). *Complete*: no node of the region
reaches a chunk face whose neighbour has no piece yet. *Enclosed*: complete, no cell under sky, not at the world's
edge; a region reaching a chunk not loaded is never enclosed.

**API.** `ctx.voxels.regionAt(x, y, z)` → `{ id, portal, enclosed, complete, volume (m³), sky (this cell),
seesSky, portals }` or null (solid, not loaded, not stitched yet). On the CPU where the world runs (runtime host
`openRegions`): `regionAt`, `regionIdAt(x, y, z)` (a number, 0 solid/unknown: what a light store compares to stop
leaks), `region(id)`, `portalsOf(id)` (extent, cells, regions joined), `skyHeight(x, z)`, `skyAt`, `columnSky`,
`stats()`, `bytes`. On the page: `VoxelWorldDraws.sky(world)` → `SkyColumns.heightAt(x, z)` (Play hook
`__tlVoxelPlay.skyHeight`). No GPU buffer yet, no region ids on the GPU (default below).

**Measured** 2026-11-15 01:46–02:30 UTC, built at 5bf24807, each run alone (gate inactive), the brief's 10G scope,
uptime 22.4 d, load (1 min) 1.3–3.2; raw `~/.cache/thirdlight-phase46e/work/46e.3/` (`*.uptime` beside each).

| What | Numbers |
|---|---|
| Derive a section (Node, the town box, 864 sections, 2 rounds; `derive-node.log`) | regions p50 68 / p95 383 µs (mean 126–143); mesh producers p50 0 / p95 1,992–2,268 (mean 756–850); the whole derive p50 242–335 / p95 4,295–4,582; regions **7.0–7.4 %** of it |
| Derive in Play's job workers (8 km town, low, 80,286 sections; `light-shots.log`) | regions p50 0 / p95 100 µs, mesh p95 500, whole p50 100 / p95 800: the workers' clock steps 100 µs (D669) |
| Stitch on the simulation (profile spans, `voxelStream`) | the town loading (first 4 s): **1.39 ms a frame** beside voxel streaming 17.7; settled at the five cameras: 0 (no stitch); Play e2e at high while loading: 1.5–1.7 ms of voxelStream's 3.3 ms budget; Node: 0.2–0.3 ms a chunk, an edit's chunk ~1 ms |
| Memory at the town (low) | stitch 4.17 MB (3,376 pieces, 5,816 nodes); the region part 9.3 KB a chunk in the town box (25.6 KB a mixed chunk; 18 % of 51 KB derived), in derived bytes; voxelStream resident 89–140 MiB of 768; page sky 2 KB a chunk column (not read) |
| Town counts | 121 regions, **120 enclosed**, 3,181 portals (each door and window run); room camera: enclosed, 653 m³, 24 portals; street: sky; cave: the outdoors' region (open to the valley), not under sky. Node box: 19 whole houses = 19 enclosed regions, 340–1,528 m³, 12–49 portals each (storeys join by the stair holes: one region a house) |
| Edit → regions | a 1 m hole through the room camera's wall: the answer at the eye changed 91 ms after the command (4 steps; 50 ms polls included), enclosed → the outdoors; e2e: four room edits → answers 173 ms, a shaft → 155 ms |
| 150 m/s, export, low, base 05b4e44b vs HEAD, 1 round each same hour | longest 46.9 / 50.6 ms, 0 / 0 > 100, missed 3.7 / 2.7 a min, detail 4.6 / 5.4 s, pending 9.1 / 10.7 s, sim spikes 1 / **14** (a tick with 8.3 ms of stitching): D667 |

**Pictures** (looked at). Voxel page, staging's 8 km world, low, `?regions` hooks, at the lighting cameras
(`~/.cache/thirdlight-phase46e/work/46e.3/overlay/`): `room-window-on.png` (every wall, the floor, ceiling and stairs
of the room one hue, the five windows cyan; `-off` beside it), `street-noon-on.png` (windows cyan; thin green slivers
along the eaves: the attic's tinted faces show above the roof planes, D668), `cave-on.png` (untinted: the cave is the
outdoors' region). E2e (`e2e-shots/regions-on.png`, `-off`): from inside a test hut's first room, its walls one hue,
the door in the partition cyan, the second room behind.

**Tested.** vitest `packages/voxel/src/open-regions.test.ts` (labels against a flood fill; face pairs with a tunnel;
sky columns against a scan and through `SkyColumns`; radius 0 with junk in the pad; closed box; door portal; two
rooms and one portal; cave open vs sealed cavity; 2 × 2 × 2 chunks one region; edge contact apart; four shuffled
arrival orders equal; unload → not complete, reload → enclosed; an edit re-derives one chunk (1 derive, 1 piece
built) and merges, then splits), `tools/voxel-bench/open-regions-town.test.ts` (≥ 15 enclosed houses of 190–2,000 m³
with portals; the street under sky). Playwright `voxel-world.e2e.ts`: Play, two rooms dug under the pad (enclosed,
apart, one portal, 20–60 m³; the pad under sky), a shaft → not enclosed, sees sky; the voxel page's hut, overlay on
differs from off by > 20,000 px. **Broken** (openings not portals, run once: `broken-no-portals-vitest.log`): 7 of 14
vitest fail (door, two rooms, town, order, edit…); with nothing labelled the Play gauge `roomKnown` stays 0; with
stitching skipped no room is complete (never enclosed); all cells one region: rooms not apart. The voxel area 216 →
222 s.

**Gate.** `gate-fast-20261114-211154` (every area) red on `rendering.e2e.ts:491` (export box field, 240 s timeout
under the all-areas load, not touched here), green in `gate-rerun-20261115-014237` (village perf 0/360 missed, main
6.2 ms). Fixed on the way: the stitch walked the whole outdoors on every new chunk (sim 63 ms/frame in the Play e2e,
starving the Profiler's job lane); it now merges.

### 46e.4a — sun and lamp shadows on the near field's voxel surfaces

**Built.** On game pages (Play, exports; `VoxelWorldDraws` option `shadows`, set by game-host) every near-field voxel
draw casts and receives like any lit draw: level-0 chunk surfaces, level 1–2 mesh-ring nodes and seams, the kit
piece draws (rows of the culled-instance table; a shadow camera draws the chunks it or the view sees, 46f.3a's
order) and a relief chunk through its plain caster. They are **static casters** of the key light's cached map
(`STATIC_CASTER_KEY`; the voxel surface material is marked steady in shape, its position node moving relief vertices
only), so the static map holds them and the dynamic map, drawn every frame, holds the static depths plus moving
objects: moving objects shadow voxel surfaces and voxel surfaces shadow moving objects through the one map
receivers sample. Point, spot and area lights draw them into their **shadow atlas** tiles. The far field neither
casts nor receives (46e.4b). Shared foundation: the culled-instance table (row 6) for the pieces; nothing new culls.

**An edit refreshes what it touched.** `VoxelChunkView` reports each chunk, node or seam shown, replaced or taken
away as its box's sphere (grown 1 m for pieces) to the scene's `StaticShadowRevision` (`changedWithin`; the link
is kept on the scene by the adapter, `attachSceneShadows`, as the decal link is). The cached map is drawn again
only when a sphere lies in its frustum (drained at the frame's start). The atlas reads the same spheres
(`takeLocal`): a light whose reach one touches is redrawn, and of a point or area light only the faces whose
frustum holds it (`FaceRedraws`' static faces: no extra redraw the frame after). Hiding the near field (a GPU
measurement) is a change everywhere. **Pacing:** chunk draws commit within the batch stage's `voxelBatch` slice of
the frame arbiter, the cached map is drawn at most once a frame (on a frame whose drained changes lie in its reach),
the atlas within its existing redraw share (a quarter of its texels a frame); no new constant. **At 150 m/s** no
level 0 is built and the near field around the camera is level 1 or nothing, so the cached map holds what meshes
lie in its square and steps with the camera (as for any caster); full shadows return with level 0 after the stop.

**The ground under the camera.** The key light's square followed the camera on the plane y = 0; on a voxel world
it is now centred on the top solid cell under the camera (`SkyColumns` through the scene's shadow link,
`VoxelWorldDraws.groundAt`), else y = 0 as before: the cave 120 m up is inside the shadow camera's depth range
(the street's town at y ≈ 0 is unchanged).

**The ring edge.** The sun's shadow covers its light's square, ± (extent + 2) m round the ground under the camera:
the scene's sun keeps the default 24 m, so 26 m (the cached static map 33 m), inside the detail ring (about 45 m at
low). Past it nothing is shadowed by the sun on any level, so the hand-over at the detail ring's edge sees no
shadow on either side and is not changed. A light with a larger extent shadows the level 1–2 meshes too, up to the
far field's start, where the shadow stops (D670; 46e.4b's march).

**Also fixed on the way.** The atlas's face and spot cameras took the view's layers only, so whatever is drawn off
the view (a voxel relief chunk's plain caster, a cut-away roof, a room no portal shows) cast no lamp shadow; they
now see the off-view layer as the key light's cameras do (found by the e2e: its high tier draws relief).

**Tiers.** From the existing settings: the largest shadow map (`shadowMapSize`: low 2048; the scene's sun asks
1024), the atlas side (low 2048, medium 4096, high 8192), contact shadows (medium, high). No new setting: the low
tier affords voxel casting (below). **Switch:** `?voxelShadows=static` (a measurement, the old static-casters
flag) is folded into the real path; `?voxelShadows=off` turns voxel shadows off on a page (comparisons; the
editor passes it to Play). **GPU measurement:** no new registration: the `shadows` hide stops every casting
light, which takes the voxel casters with it (the reading rises against §4b's 0.09 ms and falls below resolution
with the switch off, below). **WebGL 2:** the same shared material and maps draw the shadows there too; the voxel
area's smoke is green. The editor's Scene view draws voxel worlds without shadows as before.

**Measured** 2026-11-15 02:57–03:40 UTC at cd2ce0ac (built), Iris Xe, WebGPU, 1280 × 720, each run alone
(`thirdlight-gate` inactive) in the brief's 10G scope; uptime 22.4 d, load (1 min) 1.2–3.6. Raw files with an
`*.uptime` beside each: `~/.cache/thirdlight-phase46e/work/46e.4a/` (`measure.sh`). On = the build as committed,
off = the same with `&voxelShadows=off`, interleaved A B A B A.

| What | On (voxel shadows) | Off | Against |
|---|---|---|---|
| GPU `shadows`, low, 8 km town orbit (`m-low-*`) | 0.47 ± 0.07, 0.21 ± 0.15, 0.37 ± 0.25 ms (median 0.37) | below resolution both (−0.09, −0.05) | §4b 0.09 |
| GPU near / far, low | 1.60 / 1.77 / 1.81 and 3.11 / 3.37 / 3.43 | 1.55 / 1.76 and 3.50 / 3.41 | §4b 1.61, 3.49: unchanged |
| GPU lighting budget row (shadows + lighting) of 6.67 ms | 0.37 (6 %) | — | §4b ≤ 0.2 |
| GPU `shadows` at the five cameras (`light-shots --gpu --gpu-only shadows,lighting`) | street below (0.45, spread 3.76), room 0.31, cave 0.21, night 0.82, far below (0.20) | below, below, below, 0.44 (the lamps' other casters), below | §4b 0.13 / below / below / 0.40 / below |
| Page ms a frame, orbit (profile) | 6.68 / 7.32 / 7.79 | 7.33 / 6.57 | §4a 4.57 / 4.13: the orbit's profile here caught streaming (jobs 3.5–12.6 ms), on and off alike |
| Page `lighting` (orbit) of 2.0 ms | 0.082 / 0.084 / 0.086 (worst 0.3) | 0.088 / 0.079 | §4a 0.050 / 0.045 |
| Page at the five cameras (street, room, cave, night, far) | 5.52 / 4.54 / 2.99 / 4.13 / 4.24; render 4.68 / 3.86 / 2.51 / 3.56 / 3.69 | 5.60 / 3.82 / 2.59 / 3.68 / 3.45; render 4.63 / 3.09 / 2.12 / 3.12 / 2.92 | +0.4–0.8 ms of render at four cameras: the shadow passes' submission (D672); lighting 0.13–0.21 both |
| Worst page frame while settling (street, render) | 12.1 ms | 15.1 ms | one run each |
| Memory (orbit, after the fill) | page heap 637 / 608 / 579 MiB, GPU process 938 / 959 / 941 | 559 / 596, 897 / 892 | low's 1,536 / 2,560: under; GPU +~45 MiB on (pipelines with shadows received; one reading a run, ±30) |
| Shadow maps and atlas | fixed allocations, not table entries: sun dynamic 1,024² depth (4 MiB), static 1,288² (6.3 MiB), atlas 2,048² at low (12 MiB) — all there before (the sun cast with nothing to cast) | | new bytes: the change spheres (≤ 4,096 × 4 numbers, twice), none on the GPU |
| Edit → shadow (`light-shots` edits: 1 m digs in the street) | mesh 54.6 / 30.9 / 30.4 ms, static map drawn again 87.0 / 64.1 / 62.8 ms (one frame later, read once a frame: 0–1 frame) | — | §4a floor 22–53 ms |
| Medium, 60 Hz, one run (unverified on target hardware) | near 2.41, far 3.94, shadows 0.31, lighting 0.18 ms: 35 / 58 / 4.5 / 2.6 % | — | §4b shadows below |
| High, 60 Hz, one run (unverified on target hardware) | near 6.56, far 8.17, shadows 0.55 ± 0.44, lighting 0.32: 42 / 52 / 3.5 / 2 % (20 of 160 missed with no load) | — | §4b shadows below |
| 150 m/s, export, low, one round each (`cov-150-*`) | longest 49.2 ms, 0 > 100, missed 1.8 a min, detail 7.65 s, pending 10.62 s, sim spikes 5, holes 0, falls 0/34 | 43.2 ms, 0, 0.9, 8.19 s, 10.79 s, 6, 0, 0/34 | the same within one round's noise |

`light-shots` exits 1 on both runs for its after-measurement pictures (they differ from the first by 0.8–3.5 %,
softer, as in 46e.1 with only `shadows` and `lighting` measured: D660); the five pictures are the first ones.

**The five pictures** (low, `shots/` and `shots-off/` beside each other, against 46e.0's `46e.0/shots/`; looked
at; where on and off differ mapped by 20–32 px blocks): `street-noon.png` — the brick house on the right throws
its shadow across the street's grass, the eave and ridge pieces darken the roof tiles under them, the fence's foot
a little; the houses 30 m and further down the street throw none (the sun's square ends at 26 m: D670).
`room-window.png` — the room is now in its house's shadow: the floor and stairs a step darker, the walls slightly
(the ceiling was never sunlit); the sun through the west windows lands in a band 0.2–0.6 m wide at the foot of that
wall, out of this eye's sight; no light leaks under the walls at the 0.5 m cells. `cave.png` — the tube is in the hill's shadow (darker walls and floor than 46e.0), the sunlit floor at
the mouth stays bright: the square now follows the ground (120 m up). `night-lamps.png` — the lamps' shadows: the
fence posts and rails throw shadows on the grass behind them, the near posts' feet are dark, the eaves' kit pieces
throw a stepped shadow on the white house's gable. `far-view.png` — no block differs from off: the square lies under
the camera, out of the picture's ground, and the far field casts nothing yet. No acne or peter-panning seen at these
cameras; the town's shadows are soft-edged (the map's 2.5 cm texels, 4-tap PCF).

**Tested.** vitest `voxel-chunk-view.test.ts`: with shadows, every surface and piece draw casts, receives and is
a static caster; one report a chunk drawn, its sphere round the chunk's 16 m box; an edit to one chunk reports that
chunk twice (gone, come) and nothing else; a map whose reach lies 60 m off is not drawn again; of a lamp 12 m out
along +x some (not all) faces reach the change, those are drawn and nothing the frame after; a lamp 40 m off is not
reached; a chunk taken away reports; hiding the near field bumps; without shadows nothing casts or reports.
`lighting-cameras.test.ts`: the edit → shadow timing from watched frames. Playwright `voxel-world.e2e.ts` Play
(WebGPU, high tier, the preview's 670 × 253 picture; checks in `tests/e2e/voxel-shadows.ts`): a 4 m wall built by
the script — its sun shadow on the grass (1,161 px past 1.06 × darker; bound 400) goes when the wall is dug (a shot
without it 179–196 ms after the command, screenshots included), a blue moving box in it is 1.62 × as bright without
it (bound 1.25); a red lamp's light on the grass east of the rebuilt wall is gone once its tile is drawn again
(16,120 px; bound 5,000); a moving box shadows the voxel grass (375 px; bound 120). **With voxel shadows off**
(`?voxelShadows=off`, run once by hand: `e2e-off.log`): 0 px, 1.00, 1 px and 0 px — each check fails. With the
chunk view's change reports cut (run once: `broken-no-reports-vitest.log`) the vitest fails at the first count (0 of
8 chunks reported); the e2e was not run so. Before the atlas fix the lamp check read 0–3 px (relief chunks cast
from their plain caster at the high tier). The Play test 1.4 min in the gate; the voxel area 222 → 224 s.

**Gate.** `gate-fast-20261115-024306` GREEN at cd2ce0ac (39 e2e files: core, voxel, rendering, lighting, play
and `shadows.e2e.ts`; 70 passed; village perf at 60 Hz 0/360 missed, main 6.38 ms).

### 46e.4b — the far field lit at its hit; the sun past the shadow map

**The far shade at its hit (D607).** The far field's one shade gives three's lights and the clustered lights the hit's
view and world position through its context (`positionView`, `positionWorld`; voxel-far-visibility.ts): a point or
spot light's reach, cluster cell, spot cone and atlas shadow are read where the pixel's surface is. Area lights in such
a build take the form-factor path that reads the context (three's rect-area term reads the fragment's own place;
cluster-area.ts). The shade receives the key light's shadow at the hit, with the hit's own normal.

**What the far sun shadow is.** Not a per-pixel march and not a cascade: a **shade line per column** over two
camera-following windows of column tops (`@thirdlight/voxel` sun-heights.ts, three-adapter voxel-sun-field.ts):

- **Tops.** Near: the worlds' sky heights (46e.3), 0.5 m columns, 1,024² over 512 m, a chunk column a tile. Far: the
  far field's drawn brick nodes, 4 m columns over 4 km: a node's tops are where its stored field first falls below the
  march's hit distance coming down each sample column (the field is linear between samples along a column, so this is
  the surface the brick march converges to: vitest compares every column with the CPU brick march, worst 0.35 cell);
  a column takes the highest of the drawn nodes over it. Both windows are wrapped by tile (a move writes only what
  enters, cleared to "unknown" at once), composed on the page within the lighting preparation slice
  (`surfacePrepare`), uploaded as ranges of one storage buffer.
- **Lines.** A compute pass marches each column toward the sun over the tops (geometric samples from 0.5 m to the
  reach or the highest top: a house beside the column and a mountain kilometres off each get samples at their scale;
  the tier's samples) and keeps two lines: the height below which the column cannot see the sun over any caster, and
  over casters farther across than the key light's map reaches toward the sun (its near plane). One tile row of each
  window a frame, while anything changed (tops, the windows' place, the sun turning by 0.01°): a change is in the
  lines within 32 rows (32 frames); written to a storage texture, copied row by row into the texture lit programs read.
- **Read.** The key light's shadow node is wrapped (`sunShadowed`): inside the map's square the map times the far line,
  past it the whole line, blended across the square's outer fifth (0.8–0.96 of its half side), so the map hands over
  with no step. A point is offset by 0.75 of its column's width along its normal and lit by
  clamp((y − line) / width + 1). Near draws read at their vertices (a varying), the far shade at its pixels: with the
  read in the voxel surfaces' fragment stage (a storage buffer, then a texture) their draws flickered frame to frame
  in the Play e2e, the values used or not (D673; bisected: no read, no flicker; the read at the vertices, none).
- **The way there.** A per-pixel march over the tops (24 samples, bilinear reads) was built first: at the high tier
  the Play e2e's pictures never settled and nothing was gained by fewer reads; the lines march once per column and a
  pixel reads two texels.

**What it cannot show.** A line is a height field's: what stands over a column shades all of it, so no sun under an
arch, a bridge or an eave seen past the map, none through a window past the map; overhangs shade the whole column under
them. Near the camera past the map an edge is as fine as the mesh's vertices (merged flat faces interpolate over
their size); the far field's are 4 m columns. Walls thinner than a far cell are not in the far tops (D663). Casters
are voxels only: props and models cast only through the map.

**The 26 m gap (D670), how it is closed.** Option (a): near surfaces past the map's reach take the same lines (the near
window's 0.5 m columns cover the load ring), faded in across the map's edge; not a wider map (b): a cascade would draw
every caster again into a second map when the camera steps, and would still end; the lines also give the far field
its shadow, so one term serves both.

**Tiers.** `LightingTierSettings.voxelSunSteps` (project-model quality-levels.ts): low 12, medium 16, high 24 samples
a column; 0 off. `?voxelSun=off` on the editor page turns it off in Play (comparisons). The GPU measurement registers
it under `shadows` ("voxel sun march": the hide skips the march pass and the reads).

**Measured** 2026-11-15 06:52–07:38 UTC at 76f3ef48 (built), Iris Xe, WebGPU, 1280 × 720, each run alone
(`thirdlight-gate` inactive) in the brief's 10G scope; uptime 22.6 d, load (1 min) 1.2–2.2. Raw files with an
`*.uptime` beside each: `~/.cache/thirdlight-phase46e/work/46e.4b/` (`measure.sh`). On = as committed, off = the same
with `&voxelSun=off`, interleaved A B A B A. (At 76f3ef48 an off page still composed the tops, only the march and the
reads were off; since then `?voxelSun=off` makes no field and nothing is composed while the march is off.)

| What | On | Off | Against |
|---|---|---|---|
| GPU `shadows`, low, 8 km town orbit (the camera moving: the lines march every frame) | 0.73 ± 0.13, 0.63 ± 0.24, 0.56 ± 0.21 ms (median 0.63) | 0.42 ± 0.07, 0.43 ± 0.05 | 46e.4a 0.37: the field ≈ +0.2 ms |
| GPU near / far, low orbit | 2.22 / 1.56 / 1.89 and 3.34 / 3.17 / 3.46 | 1.92 / 1.70 and 3.31 / 3.38 | unchanged within the runs' spread |
| GPU lighting row (shadows + lighting) of 6.67 ms | 0.63 (9 %) | 0.43 | |
| GPU at the five cameras (street, room, cave, night, far; `light-shots --gpu`) | far 1.20 / 0.96 / 1.14 / 1.96 / 4.19; shadows 0.59 / 0.49 / 0.32 / 0.95 / 0.52 | far 1.23 / 1.03 / 1.15 / 1.93 / 4.16; shadows 0.57 / 0.39 / 0.20 / 0.86 / 0.49 | still cameras (no march): the reads +0.02–0.12 ms |
| Page ms a frame, orbit (profile) | 6.71 / 6.69 / 6.74; lighting 0.10 / 0.12 / 0.12 (worst 0.4–2.1) of 2.0 | 6.56 / 6.89; lighting 0.12 / 0.13 | |
| Page at the five cameras | 6.43 / 4.49 / 3.08 / 4.31 / 3.94 | 6.22 / 4.31 / 3.03 / 4.48 / 4.27 | |
| Memory (orbit) | page heap 601 / 585 / 642 MiB, GPU process 940 / 933 / 953 | 578 / 585, 917 / 903 | the field: tops buffer 8 MiB and two line textures of 16 MiB on the GPU, the tops 8 MiB and the far nodes' tops (4.3 KB a node, ~1,100 nodes) on the page: ≈ 55 MB in `voxelStream`'s resident bytes; no budget entry |
| Medium, 60 Hz, one run (unverified on target hardware) | near 2.04, far 3.52, shadows 0.63, lighting below | — | 46e.4a shadows 0.31 |
| High, 60 Hz, one run (unverified on target hardware) | near 6.77, far 7.60, shadows 0.86, lighting below (40 of 159 missed with no load) | — | 46e.4a shadows 0.55 |
| Edit → in the field (Play e2e, high tier: the long wall) | built: 1.05–1.24 s from the command; dug: 0.62–0.63 s (the batch, the tops composed, 32 rows marched a row a frame) | — | the map's redraw (town, `light-shots` edits) 95 / 63 / 57 ms, as 46e.4a |
| 150 m/s, export, low, one round each | longest 49.7 ms, 0 > 100, missed 5.5 a min, detail 6.22 s, pending 11.5 s, sim spikes 26, falls 2/34 (none through) | 60.6 ms, 0, 4.6, 9.23 s, 11.84 s, 54, 0/34 | the same within one round's noise; both show page frames with 2.5–3.4 ms of `voxel sun heights` (the near tiles were composed whole: now within the slice) |

**The five pictures** (low; `shots/` and `shots-off/` beside 46e.4a's `46e.4a/shots/`; looked at; differing pixels at
>10 a channel, a quarter sampled): `far-view.png` — 4,941 against off: the ground in the town's lanes is darker beside
houses past the map (their short noon shadows toward +x, −z); the mountains put no shadow in the valley at noon (the
sun 63° up); no banding or seam seen. `street-noon.png` — 54: the houses 30 m and more down the street throw their
short noon shadows mostly behind themselves from this eye; nothing visibly new. `room-window.png` — 117, `cave.png` —
19: unchanged to the eye. `night-lamps.png` — 0 against off and 34 against 46e.4a: no lamp reaches a far-field
surface at this camera, so the shade at the hit changes nothing seen (D607 stays open). Two shots 1 m apart: not
taken (the cameras are fixed); swimming unverified.

**Tested.** vitest `packages/voxel/src/sun-heights.test.ts`: a far node's tops against the CPU brick march straight
down every sample column (worst under 0.35 cell); the far window the highest of the nodes over a column, composed again
as nodes come and go; a move clears the entering tiles and keeps the rest (wrapped by tile); the near window from two
worlds' sky heights; the shade line's reference (the wall's far side shaded, its near side and past the shadow lit;
the far line leaves the map's part; a low sun and no samples shade nothing). `lights-shadows.test.ts`: the cached
node found under the wrappers. Playwright `voxel-world.e2e.ts` Play (high tier, `voxel-shadows.ts`
`voxelFarLightChecks`): a long wall 8 m tall from 4 to 38 m ahead, the camera 10 m back and 15 m up: the march shades
731 grass pixels past the map that the map alone leaves lit (bound 300); along the strip the wall/dug brightness
ratio is 0.854–0.866 band to band, largest step 0.008 (bound 0.03); **with the march off** (`setSunOff`, read in the
same run) the strip is lit past the map (ratio 1.0, the step 0.058, required > 2 × on). The field caught up 1.05–1.24 s
after the build and 0.62 s after the dig. The D607 lamp check (a red lamp 45 or 56 m out) was dropped: the test world
ends within ~60 m, the lit ground was the near field's, and the reading was the same with the fix taken out (90 px,
0.99 ×). The Play test 1.4 → 1.6 min alone.

**Gate.** `gate-fast-20261115-061406` (every area: project-model changed) red on three watched tests under the
all-areas load (layered-material D349, ui-editor D653, frame-rate-cap D659), green in `gate-rerun-20261115-064824`
(village perf at 60 Hz 0/360 missed, main 6.34 ms); the voxel area 238 s (224 s before).

**Follow-ups (the lead's review, 2026-11-15 07:50–08:06 UTC, alone, uptime 22.6 d, load 1.5–3.4; raw in
`~/.cache/thirdlight-phase46e/work/46e.4b/` `f1/`, `f2-nofix/`, `cov2-*`).** (1) **D607 seen.** `light-shots --only
far-lamp-a,far-lamp-b` (bench checks beside the five cameras, not in the default set): a lamp 2 m before the cave's
hillside at its foot (range 20 m, the night look), the far field drawing it from 230 m, two cameras 60 m apart. With
the fix the lit ring round the cave mouth stays on the rock at the lamp from both places (`f1/far-lamp-a.png`,
`f1/far-lamp-b.png`: 373 and 387 orange pixels, centred at 638,368 and 637,367); with the shade's context taken out
(a local stub, not committed) nothing is lit (`f2-nofix/far-lamp-a.png`, `-b.png`: 0 pixels; the lamp lights at the
camera, 230 m off). Kept as a bench check: the Play e2e's world ends within ~60 m, so no lamp there reaches far-field
ground. (2) **150 m/s at 2d3314b3** (export, low, one round each): on longest 47.9 ms, 0 > 100, missed 8.2 a min,
detail 6.79 s, pending 12.8 s, sim spikes 20, falls 0/34; `?voxelSun=off` 51.3 ms, 0, 3.7, 5.91 s, 10.94 s, 5, 0/34.
The `voxel sun heights` span in the kept long frames (two page frames each) 0.2–5.9 ms, so up to about 3 ms a frame
at speed: the slice bounds composition only; the first tile of each window, the range uploads and the march's
dispatch and copy lie outside it (D675). (3) **Swimming.** `far-view` and `street-noon` against the same cameras 1 m
over (`f1/*-1m.png`): 26,498 and 44,701 sampled pixels differ, all parallax and, at the far view, the near field
drawn a level coarser at the moved camera (it arrived by a jump); the shade lines beside the houses and on the
valley move with the ground, no strip seen to pop or crawl. A sub-pixel crawl under the frame's jitter is not
resolved by this comparison (unverified).

### 46e.5a — the surface cache lights voxel surfaces (a candidate, behind a switch)

**Built.** Less than the item's words: tiles, direct light with soft traced shadows, and the read; no probes, bounce,
sky occlusion, kit-piece or moving-object reading, no measured edit path (46e.5b).

- **The switch.** `?voxelLight=off|cache|volume|hybrid` on a game page (default `off`: today's picture; the editor
  passes it to Play), read where the page's voxel worlds are drawn (`voxel-surface-path.ts`, `VoxelWorldDraws`);
  `__tlVoxelPlay.light.setStore` changes it at run time (checks, benches). `cache` acts on WebGPU only; `volume` and
  `hybrid` exist as values for 46e.6/46e.7. Query only, not a project field (§9).
- **Tiles** (`surface-cache-voxels.ts`, `surface-cache-host-voxels.ts`). Each level-0 chunk's drawn surface mesh (the
  draw batch's ground and construction faces; a page-side structure from existing derived data, nothing new derived or
  stored) is a cache tile, versioned by its mesh (a chunk drawn again is a new version; the old tile stays until the new
  charts are made). A triangle is charted by its main axis into the 0.5 m columns its projection covers (a height and a
  normal a column; columns more than a cell apart are separate layers); columns whose surfaces lie within 1.5 cells and
  turn less than ~45° make one chart (greedy rectangles: a flat wall or floor one chart, as block faces; a slope a
  projected chart per axis and slab, its texels on the surface's height). A surface with a body half a cell in front of
  it (the ground under a floor: 21 % of the town's drawn triangle points) is charted nowhere. Faces are keyed by cell
  and face, as block faces: the cells a column's surface spans and the cell behind them (a walk's hit). Charting runs in
  steps, nearest chunk first, inside the `surfacePrepare` slice (1 ms).
- **Texels and bytes.** Phase 42's levels by distance (10 cm to 12 m, 20 cm to 24, 40 cm to 48, 80 cm to 96 m …).
  A town chunk (Node, the test town, 32 chunks): **714 / 290 / 154 / 58 / 35 / 25 KiB** at levels 0–5 (caves: 936 /
  456 / 229 / 89 / 50 / 33); ~114 charts and ~1,600 chart cells a chunk.
- **The tracer's voxel kind** (`tracer-wgsl.ts`, `tracer-gpu.ts`, `TRACE_VOXELS`). A second tracer program also walks
  the first voxel world's occupancy by calling 46e.2's `voxel_walk` (stop `light`): bindings 7 and 8 are the walk's
  table and pages (six storage buffers in all, within the default eight); pages without voxels keep the first program.
  A hit names its level-0 cell and its place across the face (a0, a1); `SurfaceScene.resolve` → `locateVoxelHit`
  (the hit's face, then the cell's others, nearest charted point within 0.75 m) gives the texel or "not resident".
  GPU only (the CPU tracer twin has no voxel kind; the page's check walks the same rays on the CPU walk).
- **Direct light.** The existing light pass, scheduler and arbiter slices light the voxel units' stale texels: the
  sun's share (taken back out where the sun is drawn per pixel) and point/spot/area lights with soft traced shadows.
  On the low tier (no live budget of its own) the cache takes the tier's GPU `lighting` row (6.67 ms) while texels
  are stale, none once settled. Registered under `lighting` by phase 42's own registration (`measureGpu` reads it).
- **The read** (`surface-cache-lookup.ts`, `surface-cache-read.ts`, `SURFACE_READ.voxels`). Level-0 chunk meshes read
  their local lights' diffuse from the texel under the pixel: the cell behind the face the geometry normal faces most
  (else the next axis) in a hash of every resident chunk's faces; not found, the pixel keeps its per-pixel lights.
- **Resident bytes**: in the cache's own reading and its 32 MiB budget (`voxelDiagnostics`, `__tlVoxelPlay.light.cache()`).

**Measured** 2026-11-15 09:32–10:02 UTC at 2b11b6ec (built), Iris Xe, WebGPU, 1280 × 720, low, 30 Hz cap, each run
alone (`thirdlight-gate` inactive), the brief's 10G scope; uptime 22.7 d, load (1 min) 1.6–3.2. Raw files with an
`*.uptime` beside each: `~/.cache/thirdlight-phase46e/work/46e.5a/` (`measure.sh`). Store `cache` unless said.

| What | Numbers | Against |
|---|---|---|
| GPU `lighting`, still cameras, settled (`light-shots --gpu`) | below resolution at all five (0.09–0.3 ms) | §4b: no pass |
| GPU `shadows` at the cameras | 0.70 / 0.61 / 0.42 / 1.10 / 0.55 ms (street, room, cave, night, far) | 46e.4b 0.59 / 0.49 / 0.32 / 0.95 / 0.52 |
| GPU `near` at the cameras (the read inside it) | 0.30 / below / below / 0.75 / 2.21 ms | D660: near reads below at close cameras |
| GPU on the 8 km town orbit (`headroom`, 2 rounds cache, 2 without the read, interleaved; 1 off) | **not resolved**: the frame's GPU 22.6 / 31.8 ms with the read, 38.8 / 43.0 without, 17.8 off; resolution 8–16 ms (off 0.10). On the moving orbit the cache relights all the time (levels change with distance, each new or relevelled tile marks lights' reach: D678), so windows differ by whole relights; `lighting` read 6.4 / 2.4 / 0.29 / 8.6 ms, near 3.0 / 5.9 / 3.8 / −0.6. The read's own cost is under this noise: not measured | §4b frame 8–9 ms |
| Page `lighting` at the cameras (profile) | page 10.7 / 9.0 / 5.0 / 9.7 / 4.2 ms a frame; of it `surface lookup packed` mean 3.8 / 3.4 / 1.1 / 2.0 / 0 (worst 54 / 40 / 19 / 24 / 0), `surface cache residency` 0.5 / 0.5 / 0.7 / 1.2 / 0.0 (worst 2–8), `surface light pass` 0.1 / 0.1 / 0.3 / 1.9 / 0.0 (worst 13) | 2.0 ms budget: **over** at four cameras (D676, D677); 46e.4b page 6.4 / 4.5 / 3.1 / 4.3 / 3.9 |
| Night camera first (`--only night-lamps`): Play start → walls fully lit | **29.4 s** (the scene settled at 10.8 s, the cache 13.7 s later: charting in the 1 ms slice, D676); 37.8 M texels written for 1.3 M resident (D678); page lighting spans then residency 1.7, light pass 1.8, lookup 2.5 ms mean (worst 9 / 15 / 45) | |
| Surface cache memory at the cameras | 23.5 / 23.1 / 12.7 / 23.6 / 3.2 MB of 32 MiB, every level-0 chunk resident at its distance's level (street levels 0–4: 13 / 17 / 50 / 100 / 12 tiles): the whole detail ring fits; 1.2–1.4 M texels | `MEMORY_BUDGET_BY_TIER` surfaceCache 32 MiB |
| Memory, orbit | page heap 628–667 MiB, GPU process 1,021–1,063 MiB; off 582 / 953 | low's 1,536 / 2,560 |
| Tracer through the voxels, GPU vs CPU (1,200 rays a camera) | hits 883 / 999 / 1,035 / 753 / 0 (the far view's eye is 40 m up), 0 hit mismatches; texel mismatches 0 / 0 / **1** / 0 / 0 (cave: the same cell, face and t; the place across the face one byte apart → the next texel) | target 0 |

**The pictures** (low, `shots/`, looked at beside `46e.4b/shots/`; pixels differing by >10 a channel): `night-lamps.png`
— 22,939 px: the lamps' light on the grass, fences and house fronts from the cache, softer pools on the grass; the
stepped shadow the eave pieces threw on the brick gable is gone (kit pieces cast nothing into the cache's rays: D679);
no seams at chart borders, light leaking through walls or blockiness seen at this distance (texels 10–80 cm).
`street-noon.png` — 11,859 px, `far-view.png` — 2,428, `cave.png` — 338, `room-window.png` — 0: no local lights there,
the sun is drawn per pixel, so the cache changes almost nothing (the differences are the TAA's settle, by eye none).
`street-noon-1m.png` beside `street-noon.png`: parallax only (398,666 px), no popping seen (1 m, not 2: the bench's
moved cameras). The pictures after each GPU measurement differ by 1.1–3.4 % (D660, as in 46e.1).

**Tested.** vitest `tools/voxel-bench/surface-voxels.test.ts` on the town's and the caves' derived chunks: 99.90 /
99.95 % of points on drawn (not hidden) triangles found in a chart under their own face, on the drawn surface (≤ 0.75
m); every chart cell found back at itself (≥ 99.9 %: two surfaces of one face two cells apart share keys); no keys
deeper than two cells in bodies; walk hits aimed at surface points (1,452 / 1,945) resolved within 0.75 m 100 / 99.9
%, to the aimed point's own texel 90 / 92 %; chart bytes by level. `packages/three-adapter/src/surface-cache-voxels.test.ts`:
the lookup finds every drawn point's texel where the cache addresses it; a voxel hit's words resolve to the same texel
(> 99 %); the host lists a page's chunks, plans texels on their surface, makes a chunk drawn again a new version, and
the source's budget stands in where the tier has none. Playwright `voxel-world.e2e.ts` Play (high tier; checks in
`voxel-shadows.ts` `voxelCacheLightChecks`): the store off, the page has no cache tiles; switched to the cache, its
voxel texels are lit (the page's counters, waited for: 29.5 s after the switch, 351 chunks); the lamp adds red to
28,835 px by the cache's light (bound 8,000); a pillar's traced shadow keeps it off 554 px (bound 250); the cache
changes the picture in 1,793 px (bound 500); off again, the picture equals the store-off one (0 px, bound 40).
**Broken:** the tracer's voxel walk always missing (run once, `e2e-broken-walk/`): the pillar's shadow 5 px, the test
fails; a tile source returning nothing would fail the "texels lit" wait (resident 0), not run. The Play test 1.6 →
2.4–2.6 min alone.

**Gate.** `gate-fast-20261115-091250` at 2b11b6ec red on the Play test's projected wall mark (0 px at the first
picture: D566, on watch; passed alone before) and the m41 upgrade vitest under load (passed alone), green in
`gate-rerun-20261115-092837` (village perf at 60 Hz 0/361 missed, main 6.06 ms).

**Notes for 46e.5b** (what 46e.5a leaves, and where it plugs in).

- *Probes over voxels.* `SurfaceCacheHost.probeGeometry` places probe bricks from block, architecture and model tiles
  only; voxel tiles are skipped. Their geometry is at hand: each `VoxelTile.made` holds every chart cell's surface
  height and normal (`samples`), so `ProbeMarks.mark` can take a box per chart (or per chart cell row) as
  `blockTileMarks` does per face; what is solid for probe validity (`probeSolid`) can read the walk's blocks on the
  page (`walkSolidAt` over `VoxelWalkGpu.table.source()`). Rooms: phase 42's `SurfaceRooms` come from architecture
  (`LightingRooms`); a voxel stand-in is the open regions (46e.3): `regionIdAt` on the CPU where the world runs, so a
  probe's room is its region id, enclosed regions as rooms and `portalsOf` as their portals. The page has no region
  ids (they stay in the simulation): either the batches carry a per-chunk region map, or the probes are placed where
  the world runs.
- *Sky occlusion.* The probe pass's sky rays walk the voxels already (the tracer's second program): a probe under a
  roof or in the cave sees the walk's hit, not the sky. A texel's own sky term needs the probes (or a sky ray a texel
  in the light pass: the pass's sun share does this for the sun only).
- *Bounce.* The GPU resolve (`surface-resolve-wgsl.ts`) must learn `TRACE_VOXELS` (D680): the hit's cell and face
  (a0, a1) → the chunk's tile → its chart → texel, the CPU twin being `SurfaceScene.resolve` → `locateVoxelHit`
  (its own face, then the cell's others, nearest charted point within 0.75 m). A hash of resident voxel faces in the
  resolve table (as the materials' lookup packs one, `packVoxels`) gives the GPU the same.
- *Edits.* A chunk drawn again is a new tile version already (`VoxelLightFeed` counts a chunk's mesh arrivals); the
  host keeps the old tile until the new charts are made, then lets it go and marks its box as a geometry change
  (lights reaching it relight; D678). The walk table is updated by the same batch, so shadow rays see the edit at
  once. Not measured: the edit → light time (46e.0's edits with the cache store), and whether the mark is too wide.
- *Kit pieces and moving objects.* They do not read the cache (no `SURFACE_READ_KEY`); kit pieces could read their
  dressing cell's face (the lookup by position and normal works for any mesh over a charted face) or the probes;
  moving objects the probes. Neither casts into the cache's rays (D679).
- *Costs to take on* (performance first): charting on the page (D676: a worker), the lookup packed whole (D677:
  incremental), the relight churn while streaming (D678).

**For 46e.6 (the volume), what a fair A/B needs from it**: the same switch (`voxelLightStoreFromUrl`,
`VOXEL_LIGHT_STORES`; `VoxelWorldDraws.lightStore` and `setLightStore`, which today only acts on `cache`/`hybrid`),
the same GPU time while stale (`frameBudgetMs(level, 'gpu', 'lighting')`), its passes registered under `lighting`
(`gpuPassHides`), the same depth (local lights' soft light with traced shadows through the same walk; read by voxel
surfaces), and the same readings on the bench: `__tlVoxelPlay.light.cache()`-like stats (`store`, resident bytes,
lit/stale, waiting) for `light-shots`' wait (`cacheLit`) and record, the tracer-style check against the CPU walk,
and its page spans (the bench's `LIGHTING_SPANS`). `light-shots --query '&voxelLight=volume'` and `run.mjs headroom
--query …` take it as they take the cache.

### 46e.5b — live probes over voxels (a candidate, behind the same switch)

**Built.** Phase 42's live probes standing over voxel worlds, with `?voxelLight=cache` (WebGPU), and nothing else of
phase 42's indirect light: bricks only (no room grids, no cut-away or audio rooms), one update path (the probe pass),
read through the probe lighting every lit material already takes.

- **Placement** (`probe-geometry.ts` `voxelTileMarks`, `probeSolid`'s `voxels`; `SurfaceCacheHost.probeGeometry`):
  each charted level-0 chunk's charts mark the bricks: a flat construction chart as a plane (level 0 where planes meet,
  else 1, as block faces), a curved one its box (level 1 when its mean normal faces up, else 0: cave walls and roofs).
  A probe is valid where the walk's blocks on the page say its cell is open (`walkSolidAt` through the feed's
  `solidAt`); one in a body is dropped. Less than phase 42 does on terrain: no probe is moved onto voxel ground.
  Placement re-runs in steps within the `probePlace` slice as tiles come and change, as for the old kinds.
- **The resolve learns the voxel hit (D680).** `packResolveTable` adds one hash of the resident chunks' keyed faces
  (header words 14–15; the hit's cell and face, behind keys included); `resolveVoxelCpu` and the WGSL's
  `resolveVoxels` take the hit's face, then the cell's others, and find the texel in whole numbers (255ths of a cell),
  so GPU and CPU agree exactly. A probe ray that meets a voxel reads that texel's direct light and colour and the
  probes' light there (bounce builds over updates); one that meets nothing sees the sky. The sun's share at a hit is
  the texel's own (traced through the walk by the cache's light pass): `SunField.lit` was not needed.
- **Sky light.** On a voxel page lit by the cache the probes hold the scene's ambient and hemisphere lights
  (`AdapterLiveProbes.holdAmbient`): their sky carries that light, the flat term goes inside bricks and stays outside
  them. Probes under a roof or in the cave see the walk's hits, not the sky.
- **Leaks.** The bricks' own wall rule (axis rays cut edges; `probeSamplePoint` keeps a sample on its side): no rooms,
  no region map carried to the page. At the room camera the 0.5 m walls hold: no outdoor light seen through them.
- **Readers.** Voxel surfaces, kit pieces and moving objects all read the probes through the probe light (per pixel
  brick lookup); the voxel surfaces' read of the cache's direct light (46e.5a) is unchanged. `?voxelLight=off`: no
  voxel source, no probes, nothing held: the Play e2e's store-off picture before and after is 0 px apart.
- **GPU measurement:** nothing new to register: phase 42's `lighting` registration hides the probe pass.
- **Readings:** `__tlVoxelPlay.light.cache().probes` (count, lit, stale, settled, drawn, behind, bricks, bytes,
  albedo cells drawn) and `__tlVoxelPlay.light.resolveCheck(at, n)` (GPU against CPU resolve); `light-shots` waits for
  the probes.

**Measured** 2026-11-15 11:09–11:21 UTC at 90f60c4a (built), Iris Xe, WebGPU, 1280 × 720, low, 30 Hz cap, alone
(`thirdlight-gate` inactive), the brief's 10G scope; uptime 22.8 d, load (1 min) 1.0–2.5. Raw: `~/.cache/thirdlight-
phase46e/work/46e.5b/` (`measure.sh`, `shots/`, `shots2/`, `*.uptime`). Interim; the full table is 46e.5c's.

| What | Street / room / cave / night / far | Against |
|---|---|---|
| GPU `lighting`, settled (`light-shots --gpu`) | below resolution at all five (no stale work: nothing dispatched) | 46e.5a below |
| GPU `shadows` | street not measured (the ballast line failed), 1.18 / 1.17 / 2.21 / 0.76 ms | 46e.5a 0.61 / 0.42 / 1.10 / 0.55: higher, not explained by this item (no shadow work added); one run |
| GPU while settling (stale > 0) at the room camera | **not measured** (the bench measures settled pictures only): 46e.5c | |
| Page `lighting` (profile, settled) | 0.87 / 1.03 / 0.76 / 0.99 / 0.36 ms (worst 12 / 8 / 10 / 7 / 3) of 2.0 | 46e.5a page lighting 4–11 (D676/D677 while settling) |
| Play → cache and probes settled | 30 s (street, first); later cameras 2–15 s after their jump; room first in `shots2`: 37 s | 46e.5a night 29 s |
| Probes | 32 k / 35 k / 29 k / 28 k / 12 k placed, 27 k / 30 k / 16 k / 24 k / 10 k lit; bricks 741 / 164 / 28 by level (street) | |
| Probe bytes | page 4.9 / 5.4 / 4.4 / 4.3 / 1.8 MB; GPU (records + tiles) 8.1 / 13.3 / 8.0 / 7.7 / 6.1 MB, of `probes` 128 MiB; the memory table's `probes` row reads no value (the live tiles are not reported there) | |
| Resolve table (probe and reflection rays) | 17.1 / 17.1 / 8.6 / 17.1 / 8.5 MB (D681) | |
| Surface cache | 23.5 / 23.1 / 12.7 / 23.6 / 3.2 MB of 32 MiB | 46e.5a the same |
| GPU = CPU resolve (Play e2e, 1,200 rays in the hut) | 673 voxel hits, 673 resolved, 673 lit, **0 mismatches**; the scene's own CPU way (nearest charted point) puts 14 in another texel | |

**The five pictures** (`46e.5b/shots/`, looked at beside `46e.0/shots/` and `46e.4b/shots/`; mean brightness 46e.4b →
now; pixels differing by > 10 a channel): `room-window.png` — 120 → 9.5: the room is dark, the wall under the left
windows and the floor near them lit by the sun band's bounce, the far wall and the ceiling near black, the stairs'
kit pieces dark like the walls (kit pieces read the probes); the windows show the bright street. `cave.png` — 122 →
65: the tube darkens inward, the floor at the mouth stays bright, dark blotches about a cell across on the floor and
two thin black slits on the right wall (D683). `night-lamps.png` — 12.9 → 13.7 (17,800 px): the lamps' light bounces
onto the brick gable and the house fronts a little; unlit fronts stay near black. `street-noon.png` — 120 → 99: the
windows and doors are dark inside, soft shade under the eaves; the outdoors is darker overall (the probes see
ground below them where the flat term lit every face alike); a black sliver along the right brick house's edge (D683).
`far-view.png` — 102 → 98: the near houses' windows dark, the far field unchanged: **the cached light ends with the
level-0 chunks** (the probes' bricks stand only over charted chunks, ~45 m round the eye at low), and past them the
probe light fades out over a probe spacing to the flat ambient term; no seam seen at this camera. Run to run (`shots`
against `shots2`, a few minutes apart): room 4.7 % of pixels differ (the probes' turned rays settle within 5 %),
cave 0.2 %; frame-to-frame flicker unverified.

**Tested.** vitest `tools/voxel-bench/surface-voxels.test.ts` (town / caves: bricks 205/25/7 and 622/36/8 by level,
probes lit 7,486 / 13,194, dropped inside bodies 608 / 9,553, none lit inside a body, 192 / 184 lit under a roof and
walled within 8 m, every brick near a chart); `packages/three-adapter/src/surface-cache-voxels.test.ts` (the resolve
table's voxel hits against the scene's resolve: none unresolved, > 99 % the same texel; an unkeyed face resolves to
nothing; the host places probes over a chunk, none lit under the ground). Playwright `voxel-world.e2e.ts` Play (high,
`voxel-shadows.ts` `probeHutChecks`): a hut on the pad, the camera inside: shut, its walls 6.3 by the probes against
118.9 by the flat term (bound share 0.5), the blue box 5.6 against 19.1; the roof opened by an edit, the probes go
stale and settle again in 4.9 s, walls 77.7 (bound 3 × shut); the GPU/CPU resolve check above. **Broken:** the voxel
resolve returning nothing (both sides, run once: `e2e-broken-resolve/`): resolved 0, the test fails at "voxel hits
resolve"; the pictures still pass (open walls 75.4 against 77.7: the bounce is ~3 % of the open hut's light).
Probes unplaced: the wait for probes lit times out (not run). Readers not wired (no probe light): the shut hut reads
the flat term (as the store-off picture: 118.9), failing the 0.5 share (not run). The coloured bounce (a floor of
another colour tinting the walls) is not seen (D682); the Play test 2.4–2.6 → 2.9 min alone.

**Gate.** `gate-fast-20261115-104943` at 90f60c4a red on `shadows.e2e.ts` 'Play after the steps' (worst 40 against
≤ 32: D645, on watch), green in `gate-rerun-20261115-110734` (village perf 0/360 missed, main 6.25 ms); the voxel area
311 s (238 s at 46e.4b; 46e.5a's run not recorded here), lighting 173 s.

**Notes for 46e.5c.** Costs seen: the resolve table packed whole with its voxel hash on every residency change (D681,
up to 17 MB beside the lookup's D677); probe placement 38–68 ms of main thread a placement in `probePlace` steps;
page lighting settled 0.4–1.0 ms, its worst frames 7–12 ms (residency 4–8, surface light 3–4). Edits enter as a new
tile version (geometry box → relight marks → `probes.markBox`); the hut's roof edit reached settled probes in 4.9 s
(Play, high). To measure: GPU `lighting` while stale (room camera, first settle), edit → light time at low, the probe
update's share of the 6.67 ms row, the memory table's `probes` row (wire the live tiles), D682's cause.

**For 46e.6 (the volume), the same depth at each camera:** room — clearly darker than the street (mean ~10 of 255
here, against 120 with the flat term), light near the windows from the sun band; cave — darker inward from the mouth,
the mouth's floor bright; night — some lamp light bounced onto the brick gable and fronts; street — dark window and
door interiors, soft shade under eaves; far view — the far field as before (the cache ends at the level-0 ring), the
near houses' windows dark. Read by voxel surfaces, kit pieces (the room's stairs) and a moving object (the e2e's box
inside the shut hut, 5.6 against 19.1). An edit opening a roof brightens the room after it settles.

### 46e.5c — the cache's port artefacts taken out, and its column measured

**Built (wiring, not features).** What 46e.5a/b left that was how the port was wired, not what a surface cache is:

- **Charts on a worker (D676).** A voxel chunk's charts are made on a worker of the view's worker script
  (`voxel-chart-worker.ts` `runVoxelChartWorker`, beside the block mesher; the editor's and preview's
  `mesh-worker.js`, and exports with voxel worlds now ship it), from a copy of the chunk's mesh and the walk's level-0
  blocks round it (`solidBlocksOf`: the 3³ blocks a surface's front cell can lie in), so a hidden surface is hidden as on
  the page; two jobs in flight, nearest chunk first; no worker: the page charts in steps as before. Not the voxel job
  pool: that runs in the simulation worker, the charts are the page's (no new job kind, nothing derived or stored).
- **The faces' hashes kept across changes (D677, D681).** One class (`surface-voxel-faces.ts` `VoxelFaceTable`) keeps
  the lookup's hash (≤ 1/2 full) and the resolve's (≤ 3/4, with the cells behind surfaces) and writes only the slots of
  chunks that came, went or moved on the pages (backward-shift deletion; a face two chunks key goes to the chunk whose
  box holds its cell, else the first by key, so any order reads as one table made at once). The resolve's slot now holds
  its chart's place like the lookup's (no chart records; `voxelAreaTexels` in whole numbers on both sides). When the
  other words are unchanged only the dirty slots are written (texture rows, buffer runs).
- **Marks from a voxel chunk by what it can shadow (D678).** A chunk that came, went or was drawn again marks the units
  touching its box and those some segment from which to a lamp (or ray toward a sun) the box can stand across
  (`SurfaceChanges.castersChanged`: an exact per-axis interval test for boxes, the light's size and the sun disc's
  spread grown in; a sun under 0.1 sine falls back to the old sweep); the probes hear of the box ± the bounce reach and of
  each marked region apart.
- **Also:** the memory table's `probes` row reads the live probes' GPU bytes; `__tlVoxelPlay.light.progress()` (cheap,
  every frame) and `relightAll()` (benches); `light-shots --cache-edits`, `--arrival-shots`, `--gpu-stale`.

**Measured** 2026-11-15 13:30–14:32 UTC at f6c8bcd0 (built), Iris Xe, WebGPU, 1280 × 720, low, 30 Hz cap, each run
alone (`thirdlight-gate` inactive), the brief's 10G scope; uptime 22.9 d, load (1 min) 1.2–2.0. Raw:
`~/.cache/thirdlight-phase46e/work/46e.5c/` (`measure.sh`; `m-*`, `shots/`, `shots-off/`, `room-first/`, `cov-150-*`,
`*.uptime`). Cameras: one run `cache` (`shots`) and one `off` (`shots-off`) back to back; orbit: cache / off / cache
without the texel read (`&surfaceRead=0`) (invalid: the read was not off, D698; see §8b), interleaved, two rounds. Cameras in order street / room / cave / night / far.

| What | Cache | Off | Note |
|---|---|---|---|
| GPU settled, `lighting` | 0.12 / below / below / below / below | no pass | nothing stale: nothing dispatched |
| GPU settled, `near` (the texel and probe reads inside it) | 2.57 / 0.47 / 1.34 / 3.66 / 3.06 | below / below / below / below / 1.88 | +0.5–3.7 ms, one run each; near reads below at close cameras when off (D660) |
| GPU settled, `shadows` | 1.46 / 1.45 / 1.14 / 1.96 / 0.68 | 0.59 / 0.36 / 0.36 / 0.84 / 0.44 | higher with the cache, not explained (one run each) |
| GPU settled, frame (ballast line) | 22.3 / 9.4 / 8.1 / 12.2 / 10.7 | 13.1 / 6.8 / 5.9 / 8.5 / 9.6 | |
| GPU while relighting (every texel and probe kept stale), `lighting` | 15.0 / 12.6 / not read (the ballast line failed) / 6.7 / 18.9 | — | against the 6.67 ms row: over at four (D685) |
| GPU, 8 km town orbit (moving eye) | **no room at no load** (2–7 of 89 frames missed), so not resolved: `lighting` 10.5 ± 2.3 (r2), 7.6 ± 4.2 and 11.6 ± 2.8 without the read; frame line 40.6 (r2), 29.3 without the read (invalid: the read was not off, D698; see §8b); resolution 7.6–9.5 ms | room 44 / 152 copies; near 2.00 / 1.93, far 3.43 / 3.47, shadows 0.52 / 0.59; frame 8.5 / 9.4 | the moving eye relevels tiles and streams chunks all the time: the cache relights at its budget every frame (D685); the read's own cost on the orbit is under this noise (invalid: the read was not off, D698; see §8b) |
| Page ms a frame, settled (profile) | 6.47 / 4.75 / 3.05 / 4.82 / 4.40; `lighting` 0.44 / 0.30 / 0.25 / 0.41 / 0.28 (worst 10 / 8 / 5 / 17 / 12) | 6.49 / 4.53 / 2.84 / 4.27 / 4.56; 0.26 / 0.16 / 0.14 / 0.17 / 0.16 | of 2.0: under |
| Page while relighting | `lighting` 5.6 / 6.0 / 8.8 / 12.3 / 2.6 (residency 4.0–4.6, light pass 0.8–6.8) | — | over 2.0 (D685) |
| Page on the orbit | 9.1 / 9.3 ms; `lighting` 3.0 / 2.6 (worst 25 / 38) | 6.4 / 6.6; 0.16 / 0.17 | over 2.0 (D685) |
| Charting | worker 3.0–3.6 ms a chunk (227–637 chunks a run, slowest 63 ms), page 0–0.1 ms a frame | — | was 1 ms a frame on the page for ~30 s |
| Texels written to light the street from Play (192 chunks resident) | 1.49 M for 1.37 M resident (room first: 1.62 M for 1.2 M) | — | 46e.5a: 20 M for 1.2 M |
| Surface cache | 22.4 / 22.1 / 12.1 / 22.5 / 3.0 MB of 32 MiB | — | |
| Probes (the table's row, now wired) | 12.2 / 12.7 / 7.6 / 7.3 / 5.8 MB of 128 MiB (GPU: records and tiles); page 4.9 / 5.4 / 4.4 / 4.3 / 1.8 MB | — | 27–35 k probes, 12 k at the far view |
| The faces' hashes | page: lookup 30.4 / 31.2 / 15.9 / 29.2 / 8.4 MB, resolve 34.7 / 36.3 / 17.3 / 32.5 / 16.6 MB; GPU: lookup texture 16 / 16 / 8 / 16 / 4 MB, resolve buffer 16.8 / 16.8 / 8.4 / 16.8 / 8.4 MB | — | uploads by the street's settle: lookup 104 MB in 55 packs (8 whole, as it grew), resolve 150 MB in 18 (5 whole) (D684) |
| Page heap / GPU process, orbit | 787 / 832 MiB; 1,086 / 1,093 MiB | 585 / 609; 934 / 927 | +200 MiB page, +155 MiB GPU; low's 1,536 / 2,560: under |
| Edit → light: a window dug in the room's wall | reached the cache 272 ms, first texels 318 ms, texels settled 1.93 s, probes settled 2.43 s (smoke run: 287 / 353 / 1,852 / 2,864) | — | 337 k texels written; 16 % of the picture changed |
| Edit → light: a wall between lamp 3 and the fronts (night), then dug | built: 313 / 375 / 692 ms / 2.89 s; dug: 189 / 246 / 464 ms / 2.50 s | — | 0.83 M texels each; the wall is 36 m down the street: 0.9 % of the picture |
| Play start → settled | street first 18.9 s, room first 19.1 s (both runs) | — | 46e.5b 30 s / 37 s |
| Meanwhile (`room-first/`, `shots/`) | 2 s after arriving: 14 k units stale, 35–77 chunks waiting for charts, the flat ambient still drawn (the room as bright as the street); 10 s: texels lit, probes all but ~900 lit (room first) or settled | — | |
| 150 m/s, export, low, one round each | longest 98 ms (a page frame of 23 ms `surface light pass` at the flight's start), 0 > 100, missed 13.7 a min, detail 9.3 s, pending 9.7 s, falls 0/34, holes 0 | 45 ms, 0, 4.6, 5.8 s, 10.1 s, 0/34, 0 | the cache's light pass and packs at speed (D685) |
| Medium / high, one run each (unverified on target hardware) | medium: no room at no load (15 of 89 missed); near 5.7, far 5.2, lighting 6.1 ms (frame line 17.7). High: misses at no load (42 of 89), nothing resolved | — | |

**The cache's column for 46e.7**

- GPU settled at the five cameras: `lighting` below resolution (0.12 ms at the street); `near` 0.5–3.7 ms over off; frame 8–22 ms (off 6–13).
- GPU while relighting: `lighting` 6.7–18.9 ms at four cameras against its 6.67 ms row.
- GPU on the moving orbit: no room at the 30 Hz cap with no load; `lighting` 7.6–11.6 ms; frame line 29–41 ms (off 8.5–9.4 ms).
- Page a frame: settled 3.1–6.5 ms, `lighting` 0.25–0.44 (worst 17) of 2.0; relighting `lighting` 2.6–12.3; orbit 9.1–9.3 ms, `lighting` 2.6–3.0 (worst 38).
- Memory: cache 3–22.5 of 32 MiB; probes 5.8–12.7 of 128 MiB; faces' hashes 25–68 MB page, 12–33 MB GPU; orbit +200 MiB page heap, +155 MiB GPU process.
- Edit → light: first texels 0.25–0.38 s, texels settled 0.46–1.93 s, probes settled 2.4–2.9 s.
- Play start → settled: 18.9 s (street), 19.1 s (room).
- Travel 150 m/s: longest 98 ms (off 45), missed 13.7 a min (off 4.6), detail 9.3 s (off 5.8).

**What is left is the cache's own cost** (performance first, for the A/B): (1) texel density by distance — a moving eye
changes tiles' levels all the time, every change is a relight, so on the orbit it never settles and holds its whole
GPU row; (2) the relight's own scheduling on the page (each frame it orders every stale unit: 4–4.6 ms while 15 k are
stale); (3) one global hash per table, a change's faces scattered over it: a pack's upload is rows (lookup) or runs
(resolve) all over it, 2–8 MB a pack on average, and the two tables hold 25–68 MB on the page; (4) the reads: `near` +0.5–3.7 ms settled (lookup,
filtered texel, probe light), unresolved on the orbit; (5) memory: 22 MiB of texels and ~13 MiB of probes at the town,
+200 MiB page heap on the orbit. The wiring costs are gone: charting 0–0.1 ms a frame on the page, a pack's CPU work
by the changed chunks, the streaming relight 1.5 M texels for 1.4 M resident.

**Pictures** (`shots/`, looked at beside `46e.5b/shots/`; mean brightness 46e.5b → now): `street-noon.png` 95.5 → 92.7,
`room-window.png` 9.3 → 9.9, `cave.png` 65.9 → 65.8, `night-lamps.png` 12.2 → 12.1, `far-view.png` 94.5 → 94.4: the same
looks; the cave's step risers stand out a little sharper and the cell-sized dark blotches on its floor and the black
slit on its right wall are still there, as the black sliver at the street camera's brick edge (D683). In settle:
`room-first/room-window-arrive-2s.png` (the flat ambient, as with the store off) and `-10s.png` (dark, the windows'
bands lit); edits: `shots/edit-window-before.png` / `-after.png` (the hole's light on the floor and the walls by it),
`edit-lamp-wall-*.png`. The pictures after each GPU measurement differ by 0.8–5.4 % (D660).

**D682, the trace.** Not a port bug found, and not a grey constant: (a) the sun's share at a hit is read (a texel's
rgb holds every light with its traced shadow; the sun is only taken out where a pixel draws it); (b) a hit's colour is
the materials' own (`TSL.diffuseColor`, the voxel surface's textured colour, written into the albedo cells on capture
frames), `BOUNCE_ALBEDO` (0.3 grey) only where no material drew; (c) the "3 %" of 46e.5b was the open hut's walls with
the voxel resolve returning nothing on both sides, which still bounced the probes' own light at the hits (0.3/π ×
probes there): it is the first bounce of the hits' direct light (the sun patch) only. Whether 3 % is right for that hut
is not verified (no reference).

**D683, a bounded look.** Still seen at the cave and street. Not traced; the likeliest cause is a texel's point lying
in a cell the walk counts solid at a concave step (the tracer leaves at most two such cells, then calls the ray
blocked), not chart cells without a texel (every chart cell is found back, 46e.5a's test).

**Tested.** vitest `surface-voxel-faces.test.ts` (90 random steps of chunks coming, going, drawn again and moving on
the pages, listing order shuffled, with and without the cells behind: every face reads as a table made at once; slots
written ≤ 4 × the changed faces + 8 a step and ≤ 2 × over the run; margins keyed twice held once; a chunk that comes
writes only its own; `voxelAreaTexels` = `areaTexels` for 1–255 columns × 8 levels; **broken** (the tie by key made
"newest wins", run once: `broken-faces-order-vitest.log`): 3 of 5 fail), `surface-caster-marks.test.ts` (700 units of a
street, three lamps, an area light, a sun, 24 boxes a look: every unit a brute-force sample of segments to the light or
rays toward the sun's disc finds the box can shadow is marked; 39 % / 31 % of the old rule's marks at noon / night;
**broken** (no shadow test, `broken-no-shadow-test-vitest.log`): both fail on the first unit), `voxel-chart-worker.test.ts`
(charts through a real message port equal the page's for a chunk part of whose ground a slab hides; the host makes its
tile from the worker's charts), `lighting-cameras.test.ts` (the cache edit timing, the lamp wall's place). Playwright
`voxel-world.e2e.ts` Play (`voxel-shadows.ts`): the pillar built under the lit lamp, the light settled: 13 of 470 /
10 of 487 shadowed px still lit (bound < 1/5); dug, 470 / 487 lit again (bound > 7/10). **With the caster marks off**
(`castersChanged` marking nothing, run once by hand: `e2e-broken-marks.log`) it still passes (15 of 467, 464): the lit
wall lies in the pillar's own chunk, whose new tile is lit afresh, so the check proves the edit path, not the marks
across chunks (the vitest does). The Play test 2.6–2.8 min alone (2.9 before); nothing to move to vitest yet.

**Gate.** `gate-fast-20261115-120519` and `-123431` red on the Play test's first cache settle (60 s) under the
all-areas load (the levels area beside it: probes 6,821 of 56,618 stale after 433 updates; alone 34 s): D686, watch;
`gate-fast-20261115-125819` red on lint (ESLint out of heap), its rerun `gate-rerun-20261115-130123` green on the
Play test (lit 32 s), red on two watched tests (`rendering.e2e.ts:491`, D643's terrain impostor ratio 0.583). At the
close (with the docs): `gate-fast-20261115-143421` (Play lit 40 s) red on four watched tests (block-editor D412,
project-items D331, terrain-cdlod D643, frame-rate-cap D659), green in `gate-rerun-20261115-145359` (village perf 0/360
missed, main 6.07 ms).

### 46e.6a — the voxel light volume: the store, its compute and the voxel surfaces' read (a candidate, behind the switch)

**Built.** Less than the item's words: no coarse 1/2/4 m levels, no kit-piece or moving-object read, the edit path
not timed (46e.6b). With `?voxelLight=volume` (WebGPU; `__tlVoxelPlay.light.setStore('volume')`) a page's first walked
voxel world gets a light volume (three-adapter `voxel-light-volume.ts`, `-layout.ts`, `-wgsl.ts`); `off` makes none and
draws as before. Foundations: the camera-following window (row 4, `CameraWindow` across), the region-texture helper
(uploads, grow by copy), the occupancy walk (`voxel_walk`, 46e.2), sky heights (the window's floor under a high eye),
the frame budget table and the profiler (row 7), the live probes' sky (`SkyProbe`).

- **Cells and the leak rule.** Light is kept in the open cells (0.5 m) that touch a solid one across a face (the walk's
  `light` stop), six values a cell: the light on a surface facing +X, −X, +Y, −Y, +Z, −Z there (an ambient cube). Each
  side of a 0.5 m wall has its own cells. A reader takes the eight cells round its point moved half a cell off its
  surface along the geometry normal, trilinearly, **only cells holding light counted** (a face word is never 0 in a cell
  that holds light, so the word 0 is "solid or not lit"), and divides by their weight: on an axis face the stencil's
  far half has weight 0, so a cell across a one-cell wall is never read (vitest: a wall between 1 and 100 reads 1 on one
  side and 100 on the other at every height). No region ids are needed. The room picture shows no light through the
  0.5 m walls.
- **Layout.** Bricks of 4³ cells (2 m, the walk's own bricks) kept in a window of 48 × 24 × 48 bricks (96 × 48 × 96 m)
  round the eye (across by `CameraWindow`, up centred on the eye, lowered to keep the ground under a high eye in it;
  2-brick hysteresis up and down). A brick is kept when it holds an open cell and it or a face neighbour holds a solid
  one (by brick bits of the walk's level-0 blocks; every cell that holds light lies in a kept brick, vitest). A kept
  brick takes a slot of the **pool**, an r32uint texture three owns (384 words a brick: six RGB9E5 faces a cell, the
  exponent never 0 where light is held), written by the compute pass (`texture_storage_2d<r32uint, read_write>`, the
  language feature this Chrome has) and read by the surfaces; a slot's colours (a word a cell: the mean look colour of
  the solid cells across its faces) are a second texture written from the page. The window's **index** (a slot a brick,
  wrapped) is a 2,304 × 24 texture written by rows. 1,792 bytes a slot: 24 B a cell of light + 4 B of colour. Why not
  dense windows per level: on the Iris Xe the read is one index texel and three face texels a cell (16 loads on an axis
  face, 32 on a slope), and memory is only for kept bricks (~3–9 k bricks at the cameras, 15–30 MB); a dense 0.5 m
  window of the same reach would hold 3.5 M cells (85 MB) mostly empty.
- **The update** (compute, WebGPU): a workgroup a listed brick and face, a thread a cell. A cell not holding light writes
  0; one that does casts 4 rays over the face's hemisphere (cosine-weighted, a new set each update) by the walk: past
  24 m, or out of the world, the ray sees the **sky** (the live probes' sky radiance as SH: the environment and the held
  ambient and hemisphere lights); at a surface it sees that surface's **bounce**: the colour of the open cell in front
  of the hit times (the **sun** if a walk toward it meets nothing within 48 m + each **lamp** in range whose walk to it
  meets nothing + the volume's own light in that cell facing the hit's normal, so bounces build over updates) ÷ π. The
  estimate (π × mean radiance) is blended in by 1 / the brick's updates; a brick settles after 8 updates (32 rays a
  face). Direct sun and lamp light stay per pixel (shadow maps, atlas); the volume carries sky and bounce.
- **What is stale.** A brick new in the window or newly kept (from nothing); a changed level-0 block (an edit or an
  arrival): the bricks whose cells changed are found against a copy of the block's cells taken before the batch, and
  kept bricks within 2 bricks of their box start from nothing, those within the rays' 24 m keep half their history; a
  repaint (a chunk's shader grid changed where the walk saw nothing change) marks its changed cells' box the same way;
  the sun turned by 0.01° or its light changed by 1 %, the sky changed, or a lamp moved: half history in what it reaches.
- **Pacing.** Stale bricks with a slot, nearest the eye (by brick distance buckets) first, as many a frame as the tier's
  GPU `lighting` row (6.67 ms at low) holds at the pass's own measured ms a brick (timestamp queries, a running mean);
  32 bricks a frame before the first reading; nothing once settled. The page's share (window, keeping blocks, colours,
  index rows) runs in the `surfacePrepare` slice, one block at least a frame (span `voxel light volume`, `lighting`).
  Registered with `gpuPassHides` under `lighting` (hidden: nothing dispatched).
- **The read** (`VoxelVolumeLight`, a light of the scene whose node `ProbeOrderedLightsNode` builds after the held lights
  and the probes, as the probe node): per pixel, in the voxel surfaces' fragment stage (materials marked
  `VOLUME_READ_KEY`); in place of the held ambient and hemisphere light and the environment's diffuse light, faded by
  the weight found (smoothstep 0–0.25), so past the window or before a cell is lit the flat term stays. Per vertex is not
  an option here: merged faces span metres between vertices. `?surfaceRead=0` (the cache's flag, one plumbing) keeps the
  volume lit but unread (a comparison).
- **Readings.** `__tlVoxelPlay.light.volume()` (kept bricks, slots, stale, waiting, settled, ms a brick, bytes, the sky's
  up and down light), `progress()` (the cache's shape: cell faces written, stale bricks, waiting, settled), `relightAll()`,
  `volumeCells(points)` (cells read back from the GPU with the CPU's rule beside each). `light-shots` waits for the
  volume's settle (`storeLit`), reads cells round each eye, takes a picture a second later; `--gpu-stale` keeps every
  brick stale; `--cache-edits` times the volume through `progress()`.

**Measured** 2026-11-15 17:05–17:38 UTC at b7b90f44 (built), Iris Xe, WebGPU, 1280 × 720, low, 30 Hz cap, each run
alone (`thirdlight-gate` inactive), the brief's 10G scope; uptime 23.0 d, load (1 min) 1.1–1.8. Raw:
`~/.cache/thirdlight-phase46e/work/46e.6a/` (`measure.sh`; `shots/`, `moved/`, `room-first/`, `m-*`, `*.uptime`). Interim:
the full column is 46e.6b's. Against: the cache's column (46e.5c, same cameras) and `off` (46e.5c `shots-off`).
Cameras in order street / room / cave / night / far.

| What | Volume | Cache (46e.5c) / off | Note |
|---|---|---|---|
| GPU settled, `lighting` | no pass at all five (nothing stale, nothing dispatched) | cache 0.12 / below ×4 | |
| GPU settled, `near` (the read inside it) | 2.52 / 0.55 / 2.26 / 3.61 / 2.35 | cache 2.57 / 0.47 / 1.34 / 3.66 / 3.06; off below ×4 / 1.88 | one run each; the read's own share not split out (below) |
| GPU settled, `shadows` | 1.38 / 1.16 / 1.03 / 1.83 / 0.58 | cache 1.46 / 1.45 / 1.14 / 1.96 / 0.68; off 0.59 / 0.36 / 0.36 / 0.84 / 0.44 | higher with either store on, not explained (one run each) |
| GPU settled, frame (ballast line) | 12.0 / 9.4 / 9.5 / 11.4 / 10.6 | cache 22.3 / 9.4 / 8.1 / 12.2 / 10.7; off 13.1 / 6.8 / 5.9 / 8.5 / 9.6 | |
| GPU while updating (room, every brick stale from nothing every 0.5 s; `--gpu-stale`) | `lighting` **10.89 ± 0.57 ms** (frame 18.8); `near` below | cache 12.6 at the room | over its 6.67 ms row: paced by its own timestamps, which under-read at the cap (D690) |
| GPU, 8 km town orbit (moving eye; 2 rounds, interleaved with off and with the read off) | no load 0 / 1 of 89 missed; frame 11.0 / 9.4 ms; `lighting` 6.15 ± 3.46 (r1), not present in r2's windows; `near` below / 3.34 ± 1.31; resolution 2.6 / 0.9 ms | off: 1 / 1 missed, frame 9.4 / 8.9, near 1.88 / 2.00, shadows 0.67 / 0.71 (res 0.4 / 0.1). Read off (invalid: the read was not off, D698; see §8b): frame 9.7 / 4.8, `lighting` — / 4.44 ± 1.97, near below / 3.34 | the cache had no room at no load on the orbit; the read's own cost is under this noise: not resolved (invalid: the read was not off, D698; see §8b) |
| Page a frame, settled (profile) | 6.31 / 4.62 / 2.93 / 4.40 / 4.41; span `voxel light volume` 0.09 / 0.12 / 0.04 / 0.05 / 0.04 (worst 3.0 / 0.5 / 0.2 / 0.2 / 0.2) | cache 6.47 / 4.75 / 3.05 / 4.82 / 4.40, `lighting` 0.25–0.44 | of the 2.0 ms `lighting` row: under |
| Page while updating (room) | 3.63 ms; span 0.24 (worst 0.6) | cache `lighting` 6.0 | under |
| Page on the orbit | 7.80 / 7.88; `lighting` 0.88 / 0.86 (worst 3.6 / 4.3) | off 7.15 / 6.88; 0.19 / 0.14 | under 2.0; worst frames over (new blocks looked at, window moves) |
| Cost a brick (the pass's timestamps) | 0.04–0.10 ms (8.8 k bricks at the room) | | 4 rays a face × 6 faces × 64 cells, plus a sun walk and lamp walks a hit |
| Memory, GPU | pool and colours 14.9 / 29.6 / 29.6 / 29.6 / 29.6 MB (8,192 → 16,384 slots: the pool grows by doubling and keeps its size), index 0.2 MB | of 160 MiB (the tier's surface cache 32 + probes 128); cache 22.5 + probes 12.7 + hashes 12–33 MB | the table's rows: `surfaceCache` 14.9–29.6 of 32 MiB, `probes` 0 |
| Memory, page | 10.3 / 10.3 / 11.7 / 10.5 / 7.7 MB (the chunks' shader grids kept for colours, brick records, the index mirror) in `voxelStream` | cache's hashes 25–68 MB | |
| Kept bricks | 6,994 / 8,846 / 3,726 / 8,275 / 3,161 (cells holding light round the eye ±4 m: 454 / 860 / 24 / 336 / 0) | | 28 B a cell held (24 light + 4 colour), 1,792 B a brick |
| Page heap / GPU process, orbit | 581 / 601 MiB; 1,016 / 1,012 MiB | off 606 / 596; 978 / 941 | ~+50 MiB GPU |
| Play start → settled | street first 16 s (the scene's own settle 10.2 s); room first 19.2 s; arriving at the room: 6 k of 8.8 k bricks stale after 2 s, settled by 10 s | cache 18.9 / 19.1 s | |
| GPU cells against the CPU's rule (±4 m round each eye, every brick updated) | 454 / 860 / 24 / 336 / 0 cells hold light on both, **0 differ**; moved cameras the same | | |
| A picture a second later | 0 % of pixels differ at all five | | no flicker (D673 not seen) |

**Pictures** (low, `shots/`, looked at beside `46e.5c/shots/` and `46e.5c/shots-off/`; mean brightness volume / cache / off;
pixels differing by > 10 a channel from the cache's): `room-window.png` **5.9 / 10.0 / 119.8** (263 k px): the room dark,
the window reveals bright, soft blotches a cell to a metre across on the walls round the windows (single cells that
saw the sky through a window: 32 rays a face, D692), the floor near black; darker than the cache's (whose walls are a
dim grey and whose lit band at the west wall's foot shows). The stairs' kit pieces are lit by the flat term, bright
against the room (kit pieces do not read the volume yet: 46e.6b); in the cache's they read the probes and are dark.
`street-noon.png` 100.8 / 96.9 / 119.6: the windows and doors dark inside, soft shade under the eaves; the white gable
mottled at a metre's scale (D692); otherwise the cache's look. `cave.png` 63.4 / 65.8 / 122.4: the tube darkens inward
from a bright mouth floor; the cache's black slit on the right wall and cell-sized black blotches (D683) are not here;
the floor mottled. `night-lamps.png` 13.7 / 13.6 / 12.9: the lamps' bounce onto the gable and fronts as the cache's
(17 k px differ). `far-view.png` 102.1 / 97.9 / 102.2: the far field as before; **the near houses' windows show their
flat-lit interiors as with the store off, where the cache's are dark** (D691; `far-crop.png` beside the cache's). No
leak through the 0.5 m walls seen in the room. Popping: `moved/` street and room against the same 2 m over (the
window's step): parallax only, the gable's mottling the same pattern on the wall in both (stable, not swimming); no
seam at chunk or brick borders seen at these cameras. The pictures after each GPU measurement differ by 1.7–5.9 %
(D660, as before).

**Tested.** vitest `packages/three-adapter/src/voxel-light-volume-layout.test.ts`: the words (RGB9E5 within 1/256 of
the largest channel over 4,000 colours, black held is not the word 0); the window index (distinct places, wrapped across
negative bricks); which cells hold light against a cell-by-cell reference over a generated scrap (rolling ground, two
houses with 0.5 m walls, a door and a window, a tunnel, across negative cells; 17,710 cells, every one in a kept brick);
an edit box's changed bricks exactly those whose cells changed, an arrival's every solid brick, the marks' counts (near
from nothing, half within the reach, none past it); the ambient cube against a reference over 500 normals; the read
(a floor reads the cell over it with all its weight, a 0.5 m wall keeps 1 and 100 apart, no weight past every cell).
Playwright `voxel-world.e2e.ts` Play (high tier, `voxel-shadows.ts` `voxelVolumeLightChecks`, after the cache's): the
shut hut's walls **0.6** by the volume against **122.4** by the flat term (bound share 0.5; the cache: 6.5), the green gate's run (`gate-rerun-20261115-165623`); the GPU's
cells round the hut against the CPU's rule: 2,592 updated, 1,087 holding light, **0 differ**; the cell inside the shut
hut holds exactly 0 on every face (bound 1/20 of the sky); the cell over its roof faces up at 1.00 of the sky term
(1.72, 2.34, 3.47 against the sky's; bound 0.6–1.3); the roof opened, walls 73.8 (bound 3 × shut), settled
1.5 s after the command; under the open roof the floor repainted green, the walls' green over red 0.774 against 0.729
over plaster (+6.2 %, 91,794 wall px, the floor's own pixels left out; bound +2 %); off again, the store-off picture equal to before (0 px). **Broken** (run once, the read not wired: the volume lit, no surface reading it; `e2e-broken-read.log`): walls shut
122.4 (= off), the test fails at "the shut hut is darker"; open 125.9; the tint 0.9121 against 0.9120 (none: the
green/red check reads the bounce, not the floor's own pixels); the GPU cells check still passes (it reads the store,
not the picture). The update not dispatched would never settle: the first wait fails (not run). The Play test
3.1 min alone (timeout 180 → 240 s).

**Gate.** `gate-fast-20261115-155716` and `gate-rerun-20261115-160005` red on lint (ESLint out of heap: D688, fixed);
`gate-fast-20261115-160930` (whole suite: `package.json` changed) red on `gen-behavior-graph-api.test.mjs` (D689, a
hidden regression, fixed); `gate-rerun-20261115-162050` (every area, 180 files, 25.4 min) red on four: the Play test's
180 s timeout (raised) and three watched (D320, D453, D428/D643); `gate-rerun-20261115-164836` and `-165232` red on the
Play test's first cache settle beside terrain-cdlod (D686, watch; terrain-cdlod 0.5996 / 0.5955 against 0.6, D643);
`gate-rerun-20261115-165623` (one worker) GREEN (village perf 0/361 missed, main 6.14 ms). The voxel area 325 s in the
every-area run (311 s at 46e.5b).

**What differs from the cache** (same scene, same cameras): the room is darker (5.9 against 10.0) with soft cell-scale blotches where the cache is
smooth; kit pieces (the stairs) are lit by the flat term where the cache's read its probes; the cave has no black slits;
the far view's near-house windows are lit where the cache's are dark (D691); the cache relights texels at 10 cm–3.2 m by
distance, the volume holds 0.5 m cells only near surfaces, so its light is softer at edges (the hut's floor patch edge
in the e2e pictures is the shadow map's, per pixel, in both).

**Notes for 46e.6b.**

- *Coarse levels for open air.* The 0.5 m level keeps only cells beside surfaces; a 1 / 2 / 4 m level is the same pool
  with bricks of coarser cells (a level field in the index entry, or one index a level), filled from the 0.5 m cells
  beneath (a mean of the cells holding light, a pass after the update) and from rays where no fine cell is near. A
  reader then falls back to the coarse level where its eight 0.5 m cells hold no weight, instead of the flat term.
- *Kit pieces and moving objects.* The read is a light node gated by `VOLUME_READ_KEY` in the material's userData:
  setting it on the kit pieces' material (`voxel-kit-pieces.ts`) and on lit materials of moving objects makes them read
  it. Kit pieces sit at surfaces (the 0.5 m cells reach them); moving objects in open air need the coarse levels. The
  room picture's stairs are lit by the flat term today (bright against the dark room).
- *Edits.* `--cache-edits` works on the volume (`progress()`), not run here. A chunk drawn before the store came has no
  shader grid kept, so its bricks bounce the default grey until drawn again (runtime switching only; a page opened with
  the store has every grid). The marks keep half the history within 24 m: whether that is too wide (D678's question) is
  for the edit timing.
- *Costs seen.* the update's ms a brick are read from timestamps that under-read at the cap, so while it has work it
spends ~11 ms of GPU against its 6.67 ms row (D690); every stale brick is bucketed by distance each frame (0.2 ms
page at 8.8 k bricks); the pool never shrinks (30 MB once grown); new blocks are looked at whole (512 bricks) in the
1 ms slice, worst page frames 3–4 ms on the orbit.

**For 46e.7 (cache near, volume far).** The two reads compose as the probes and the volume do now: the volume's node is
built after the probes' and replaces where its weight is up. A hand-over distance d is a fade on the volume's weight by
the pixel's distance to the eye (smoothstep d − w … d) and the opposite on the cache's read (its surface read and its
probes past d keep the volume); the cache's tiles past d need not exist (its residency ring set to d), and the volume's
window need not hold bricks inside d − w (kept from d − w out: fewer bricks, less update). Both read by voxel surfaces
per pixel, so the hand-over is a per-pixel blend with no seam of geometry.

### 46e.6b — the volume's coarse levels and readers, its wiring artefacts taken out, and its column measured

**Built.** The rest of the contract, and the wiring found while measuring; nothing tuned past 46e.6a's defaults (4 rays
a face, 8 updates to settle, 24 m reach).

- **Coarse levels for open air** (`voxel-light-volume-layout.ts`: `VOLUME_LEVELS`, `VOLUME_LEVEL_WINDOWS`,
  `volumeCoarseSolid`, `volumeLevelBrickKept`, `volumeReadLevels`). Levels 1, 2, 3 hold cells of 1, 2 and 4 m (2^level
  level-0 cells a side, as the voxel mips) in bricks of 4³ in the same pool, each in its own rows of the one index
  texture (2,304 × 42), as a clipmap round the eye: 12 × 6 × 12 bricks a level, **reach 48 × 24 × 48 m at 1 m, 96 × 48 ×
  96 m at 2 m, 192 × 96 × 192 m at 4 m** (level 0 stays 96 × 48 × 96 m). A coarse cell **stops light where some level-0
  cell in it does** (by the walk's level-0 blocks: cell bits at 1 m, the 2 m bricks' bits at 2 and 4 m; unknown space is
  open, as at level 0), and **holds light wherever it is open** (open air too); a coarse brick is kept where it holds an
  open cell and it or a brick across a face holds a light-stopping cell (by the level-0 bricks' bits; exact at 2 and 4
  m, at 1 m a brick partly solid may still be kept with no open cell: 60 of 543 in the vitest town scrap). The update
  is the same pass: a coarse cell casts its rays from its centre, its hits bounce the level-0 cells' light and colour.
  Kept at the cameras: 213–401 bricks at 1 m, 179–379 at 2 m, 209–291 at 4 m (0 at 1 m at the far view, 40 m up);
  **bytes** 1,792 a brick as at level 0, so ≤ 864 bricks a level = ≤ 1.5 MB a coarse level, 1.2–2.0 MB the three at the
  cameras.
- **Which level a point reads.** Level 0 first; each coarser level takes the smooth step of its own weight (to 0.25) of
  what the finer ones left, and is not read once less than 1/1000 is left; no level holding light keeps the flat term
  (TSL `volumeReadLevels`, its CPU reference the same name in the layout file). A surface beside its 0.5 m cells reads
  only them; a point 1.7 m over a field or in a room's middle reads the 1 m level (vitest).
- **Every lit draw reads it** (`VOLUME_READ_KEY` is now `false` to opt out): voxel surfaces, kit pieces, props and moving
  objects, in place of the held ambient, hemisphere and environment diffuse light. The far field's shade opts out (it
  finds cells by its quad's position). `off` makes no volume and draws as before (the Play e2e's store-off pictures
  before and after equal, 0 px).

**Wiring artefacts (B).**

- **The pool is made once** (16,384 slots, 29.8 MB, within the 160 MiB budget). With the pool grown by copy, draws made
  before the copy kept reading the old texture (three refreshes a texture node's binding for one draw of the program,
  not every draw's group; disposing the old texture two frames later did not help: walls half lit, the moving box flat;
  never resized: right). That is **D691's cause** at the far view (the near houses' chunks were drawn before the pool
  grew), and why "the texture never shrinks" is gone: it neither grows nor shrinks. Bricks past it wait for a slot to
  free (nearest first). D696 for the other stores swapped the same way.
- **Pacing past a stalled stamp (D690, part).** In the Play e2e a one-brick update read 6.3–7.0 ms by its timestamps
  every other frame (the pass's first stamp written while the GPU still drew the last frame), so the running mean went
  to 1.3 ms a brick and the update fell to one brick a frame (never settled in 60 s). A reading past twice the least of
  the last 16 is now taken at that; with it the e2e settles in 13–14 s.
- **A face's rays are one sequence** over its updates (the brick's own count, never reset), not jumps of the frame
  count: its first 32 rays are consecutive points of the R2 sequence. The blotches stayed (D692 below).
- **The pass is present for the measurement while the volume exists**, as the cache's: a moving eye leaves bricks
  stale between windows, and at 4d04a538's predecessor the orbit's update was read as absent (orbit rows below are from
  the run after it).
- Not changed: chunks drawn before a run-time switch to the volume still bounce the default grey until drawn again (the
  grids are on the GPU only; reading them back is more than a small fix; the A/B opens pages with the store in the URL).

**Measured** 2026-11-15 19:10–20:34 UTC at e3d86ffb (built), the orbit again 20:35–20:56 UTC at 4d04a538 (built), Iris Xe,
WebGPU, 1280 × 720, low, 30 Hz cap, each run alone (`thirdlight-gate` inactive), the brief's 10G scope; uptime 23.1–23.2
d, load (1 min) 0.9–2.1. Raw: `~/.cache/thirdlight-phase46e/work/46e.6b/` (`measure.sh`, `measure2.sh`, `summ.py`;
`shots/`, `shots-off/`, `shots2/`, `shots-off2/`, `shots-noread/`, `room-first/`, `m-*`, `orbit1/` (the first orbit),
`cov-150-*`, `*.uptime`). The cache's `measure.sh` with the query swapped; the cameras this time **A B A B** (volume,
off, volume, off) and the volume lit but unread (`&surfaceRead=0`); the cache's cameras were one run each. Cameras in
order street / room / cave / night / far.

| What | Volume | Off / unread | Note |
|---|---|---|---|
| GPU settled, `lighting` | nothing dispatched (no brick stale): absent at e3d86ffb, below resolution since | — | cache 0.12 / below ×4 |
| GPU settled, `near` (run 1, run 2) | — (ballast line failed) / 1.29 / 2.93 / 4.77 / 4.82; 3.64 / 1.52 / 2.95 / 4.75 / 4.93 | off below ×3 / 0.16 / 1.93; below ×3 / 0.05 / 1.84. Unread 3.61 / 1.63 / 3.00 / 4.73 / 4.79 | **+1.3–4.8 ms on**, the same with the read off (within 0.15): the read's own cost is below resolution at the cameras; the rise comes with the store (D693; the cache's column shows the same, +0.5–3.7) (invalid: the read was not off, D698; see §8b) |
| GPU settled, `shadows` | —, 0.88 / 0.69, 0.74 / 0.50, 0.46 / 1.09, 1.08 / 0.56, 0.56 | off 0.67, 0.56 / 0.46, 0.50 / 0.37, 0.31 / 0.97, 0.88 / 0.55, 0.52 | +0.1–0.3 |
| GPU settled, frame (ballast line) | 14.2 / 10.2, 10.0 / 9.7, 9.4 / 12.9, 13.0 / 12.7, 12.6 | off 4.8, 10.7 / 5.9, 5.8 / 5.1, 5.3 / 8.5, 8.2 / 9.6, 9.8 | |
| GPU while updating (every brick stale every 0.5 s), `lighting` | **10.14 / 11.17 / 9.64 / 8.91** / not read (ballast line failed) | — | over its 6.67 ms row; its own stamps read 5.2–8.6 ms a dispatch (D690) |
| GPU, 8 km town orbit (moving eye) | room at the cap 60 / 44 ballast copies (r1 / r2), no load 0 / 1 of 89 missed; `lighting` **6.12 ± 0.34** (r1; r2 the ballast line failed), `near` 4.38 ± 0.66, frame 6.7; resolution 1.5 ms | off: room 30 / 26 copies, 1 / 1 missed; near 2.02 / 1.84, far 3.43 / 3.39, shadows 0.59 / 0.53, frame 9.1 / 7.6 (res 0.1). Unread: room 60 / 76; `lighting` 6.50 / 5.87, near 5.44 / 5.06 (res 3.9 / 1.9) | the moving eye keeps bricks entering: the update holds its row (~6 ms) all the time; the read's own cost is under the orbit's noise (unread near ≥ read near): not resolved. The first orbit (at e3d86ffb, `orbit1/`) read `lighting` absent and near 4.6–6.9 |
| Page ms a frame, settled (profile) | 6.60 / 4.55 / 2.93 / 4.43 / 4.45; `lighting` 0.33 / 0.21 / 0.18 / 0.21 / 0.22 (worst 3.2 / 0.6 / 0.7 / 0.6 / 1.1); span `voxel light volume` 0.05–0.08 (worst 0.3–1.4) | off 5.90 / 4.56 / 2.95 / 4.25 / 4.01; 0.28 / 0.15 / 0.15 / 0.16 / 0.14 | of 2.0: under |
| Page while updating | 4.54 / 5.11 / 2.62 / 4.48 / —; `lighting` 0.60 / 0.81 / 0.42 / 0.69; span 0.44 / 0.66 / 0.30 / 0.54 (worst ≤ 1.2) | — | under 2.0 (cache 2.6–12.3) |
| Page on the orbit | 7.14 / 6.97; `lighting` 0.93 / 0.82 (worst 4.0 / 4.4) | off 6.71 / 6.90; 0.18 / 0.17 | |
| Memory, GPU | pool, colours, index **29.8 MB fixed** (16,384 slots); table rows `surfaceCache` 28.4 of 32 MiB, `probes` 0 of 128 | — | of 160 MiB; cache 3–22.5 + probes 5.8–12.7 + hashes 12–33 MB |
| Memory, page | 8.0–12.0 MB (grids kept for colours, brick records, the index) in `voxelStream` | — | cache's hashes 25–68 MB |
| Kept bricks (level 0 / 1 / 2 / 4 m) | 6,994 / 348 / 340 / 291; 8,846 / 401 / 375 / 288; 3,726 / 213 / 182 / 215; 8,275 / 353 / 379 / 264; 3,161 / 0 / 179 / 209 | | 4.3–9.9 k of 16,384 slots |
| Page heap / GPU process, orbit | 624 / 646 MiB; 1,002 / 1,007 MiB | off 578 / 591; 942 / 942 | |
| Edit → light: a window dug in the room's wall | reached 93 ms, first light 112 ms, settled **1.74 s** | — | 4.8 M cell faces written; 13.9 % of the picture changed |
| Edit → light: a wall between lamp 3 and the fronts (night), then dug | built: 61 / 85 ms / **0.51 s**; dug: 44 / 73 ms / **0.61 s** | — | 2.9 M cell faces each; 16.2 / 10.5 % of the picture |
| Play start → settled | street first ≈ 19.8 s, room first ≈ 19.6 s (the scene's own settle 3 s at the camera, then the volume 0.8 s) | — | cache 18.9 / 19.1 s |
| Meanwhile (`room-first/`, `shots/`) | 2 s after arriving: 3.2–7.4 k bricks stale (room first 6.8 k), blocks waiting; the room already dark (most bricks updated once); 10 s: settled (street 66 stale) | — | cache: the flat term at 2 s |
| 150 m/s, export, low, one round each | longest **293 ms** (a page frame of 266 ms `voxel draws made` at the flight's start: D694), 1 > 100, missed 6.4 a min, detail 9.4 s, pending 13.7 s, falls 0/34, holes 0 | off 57.8 ms, 0, 10.1, 6.9 s, 12.3 s, 0/34, 0 | |
| Medium / high, one run each (unverified on target hardware) | medium: 6 of 179 missed at no load, room 3 copies; near 5.18, far 4.12, lighting 3.83 ms (frame 16.3). High: 37 of 108 missed at no load; near 11.1, far 9.2, shadows 1.8, lighting 3.4 ms | — | |

**The volume's column for 46e.7**

- GPU settled at the five cameras: `lighting` nothing dispatched (below resolution); `near` 1.3–4.8 ms over off, the same with the read off (invalid: the read was not off, D698; see §8b); frame 9.4–14.2 ms (off 4.8–10.7).
- GPU while updating: `lighting` 8.9–11.2 ms at four cameras against its 6.67 ms row.
- GPU on the moving orbit: room at the cap with no load (44–60 copies; off 26–30); `lighting` 5.9–6.5 ms (the update at its row all the time); `near` 4.4 ms (off 1.8–2.0), the read's share not resolved.
- Page a frame: settled 2.9–6.6 ms, `lighting` 0.18–0.33 (worst 3.2) of 2.0; updating `lighting` 0.42–0.81; orbit 7.0–7.1 ms, `lighting` 0.82–0.93 (worst 4.4).
- Memory: volume 29.8 MB GPU fixed (of 160 MiB: `surfaceCache` 28.4 of 32, `probes` 0 of 128); page 8–12 MB; orbit +50 MiB page heap, +62 MiB GPU process.
- Edit → light: first light 0.07–0.11 s, settled 0.51–1.74 s.
- Play start → settled: ≈ 19.8 s (street), ≈ 19.6 s (room).
- Travel 150 m/s: longest 293 ms (off 58), missed 6.4 a min (off 10.1), detail 9.4 s (off 6.9).

**What is left is the volume's own cost** (performance first, for the A/B): (1) the update while it has work, 8.9–11.2 ms
of GPU against its 6.67 ms row: paced by its own stamps, which read it 1.3–1.7× short at the cap (D690: the pass's
cost outside its stamps, the pool's barrier and the reads waiting on it, is the volume's); (2) open air: the coarse
levels are 864 bricks a level of cells that all cast rays, so a settle from nothing takes 13–14 s in the e2e (10 s
without them in 46e.6a); (3) `near` +1.3–4.8 ms with the store on, read or not (D693) (invalid: the read was not off, D698; see §8b); (4) a fixed 29.8 MB pool;
(5) the look at 32 rays a face: blotches (D692). The wiring costs are gone: the pool's stale bindings, the stalled
stamps, the presence for the measurement.

**Pictures** (`shots/`, looked at beside `46e.5c/shots/` (the cache) and `46e.6a/shots/`; mean brightness volume /
46e.6a / cache): `room-window.png` 5.3 / 5.9 / 10.0 — the room dark, **the stairs' kit pieces dark now** (46e.6a: lit
by the flat term), the soft cell-to-metre blotches on the walls round the windows still there (D692); the cache's dim
grey walls and lit band at the west wall's foot are its own. `street-noon.png` 98.4 / 100.8 / 96.9 — the cache's look
(dark doors, shade under eaves); the eave pieces lit like the gable where the cache shows a black sliver (D683); the
white house's window interiors light grey where the cache's are darker; the gable's metre-scale mottling as in
46e.6a. `cave.png` 62.4 / 63.4 / 65.8 — the tube darkens inward from a bright mouth floor; no black slit (the cache
has one). `night-lamps.png` 13.9 / 13.7 / 13.6 — the lamps' bounce on the gable and fronts as the cache's. `far-view.png`
95.2 / 102.1 / 97.9 — the far field as before; at the near houses (`far-crop.png`: 46e.6a, now, the cache) the window
openings show beige: their frames and reveals, lit by the opening's own cells (they see the street and sky), where the
cache's openings are black; the gables there carry darker cloud-shaped patches 46e.6a did not show (D695). Settle:
`room-first/room-window-arrive-2s.png` (already dark, a few stair pieces still lit) and `-10s.png`; edits:
`shots/edit-window-before.png` / `-after.png` (the hole lights the walls and floor round it), `edit-lamp-*.png`. The
pictures after each GPU measurement differ by 0.7–5.9 % (D660, as before). Composites: `cmp-*.png`.

**D691, traced.** The flat-lit windows of 46e.6a were draws made before the pool grew, reading the old texture (above).
With one pool, the near houses read the volume; what the openings show from 40 m up is their frames and reveals in the
0.5 m wall, whose cells lie in the opening and see the street: the volume's look at an opening (a cell is not inside
or outside), not a bug. Past its windows (level 0 to ±48 m, the 4 m level to ±96 m) a pixel keeps the flat term,
faded by the weight: part of the volume's design, and what the hybrid's hand-over meets.

**D692, the bounded look.** Not the accumulation weight (1 / updates is the running mean) and not unjittered
directions (each cell's own offset); the sequence across updates was broken (above) and is fixed, and the blotches
stayed: single cells whose few rays find a bright opening. The volume's look at 32 rays a face; more rays or a filter
cost more (not done).

**Tested.** vitest `voxel-light-volume-layout.test.ts`: the index's rows a level, distinct places in each level's
window, no texel shared across levels, keys apart; coarse cells' light stop against a cell-by-cell reference (3
levels, ~80 k cells at 1 m) and kept bricks (every brick with an open cell near a solid one kept, none far from one;
those kept with no open cell counted: 60 of 543 at 1 m, 0 at 2 and 4 m); the read: beside a floor, a wall and the street
level 0 alone, 1.7 m over open ground and in a closed room's middle the 1 m level with no light from across the 0.5 m
walls, the 2 m level where the 1 m has none, no weight where nothing holds light, and each level's share against the
steps written out. Playwright `voxel-world.e2e.ts` Play (high tier, `voxel-shadows.ts` `voxelVolumeLightChecks`): the
shut hut's walls 0.5 by the volume against 122.6 by the flat term; **a blue box mid-room** (1.2–2 m up, ≥ 0.8 m from
walls) **0.0 against 19.1**, **the stone stub's kit pieces 0.0 against 119.7** (2,436 px; bound 0.5 share each); the
GPU's 1 m cells round the hut against the CPU's rule: 2,600 updated, 1,288 holding light, **0 differ**; the 1 m cell in
the shut hut's middle holds 0 on every face; outside, the box 1.7 m over the pad 104.6 against 71.6 by the flat term
(bound 0.7); **a pillar built between a red lamp and the script's wall takes the lamp's red bounce off the cells up the
wall's lit face (1,917 → 320, bound 0.7), dug it comes back (1,953, bound 0.8)**, each settled 3.6–3.9 s after the
command; the pillar and those cells lie in one chunk (no chunk boundary falls between them at the test's pad; the
volume marks by brick distance, so a chunk boundary is no special case); the earlier checks as 46e.6a. **Broken** (run
once: the coarse levels not read, `e2e-broken-coarse2.log`): the box in the hut 19.1 = the flat term, the test fails
at "the moving box inside reads the volume"; the box over the pad 67.1 (passes: a sanity bound); with the box at 0.8 m
over the floor beside it (the first placement, `e2e-broken-coarse.log`) it read 3.9 by the 0.5 m cells and passed, so
it was moved. Kit pieces with the read off would read the flat term as the box does (not run). The Play test 3.1 → 3.3–3.4
min alone, 3.3 min in the gate (timeout 240 s, not raised); the 46e.6a hut's plaster-floor step folded into the open
roof's picture to keep it so.

**Gate.** `gate-fast-20261115-185454` GREEN at e3d86ffb (39 files: core, voxel, rendering, lighting, play; 70 passed;
village perf at 60 Hz 0/361 missed, main 6.06 ms); voxel area 335 s (325 s at 46e.6a's every-area run). `gate-fast-20261115-205914` GREEN at db9e697e (with 4d04a538; core, voxel, lighting: 21 passed; village perf 0/361 missed, main 6.26 ms).

**Notes for 46e.7 (the hand-over).** (1) *Skipping bricks inside the hand-over distance d:* the level-0 kept rule
gets one more condition, the brick's box farther than d − w from the eye horizontally (`lookBrick`'s `keep`; the
window's follow already re-looks entering blocks; a move of the eye must re-look the ring d − w, cheaply by the blocks
crossing it); the coarse levels likewise, or kept whole for moving objects near the eye (the cache's probes cover them
there). (2) *The fade:* the volume's read takes `weight × smoothstep(d − w, d, distance to the eye)`, the cache's
surface read and probes the complement past d (both are per pixel in the voxel surfaces' programs; the light nodes
already compose in order: probes, then the volume over what is held). (3) *Measure* the same column for the hybrid,
plus the update with fewer bricks (the window's level-0 bricks inside d are most of them at the cameras: 7–9 k), and
`near` with both reads on. (4) *Traps:* with both stores on, the volume and the probes both hold the ambient lights
(`markProbeHeld`): give back only what each took (the volume tracks its own); both register under `lighting` (the
measurement hides both at once: register the hybrid's two passes apart or read them together); the fixed pool and a
texture node swapped by value (D696) — do not grow either store's texture while lit draws bind it; `near` rises with any
store on (D693), so compare hybrid against both alone, not against off.

### 46e.8 — travel fixes (D667, D675, D694)

The owner's travel criterion (owner-decisions 2026-11-11: up to 150 m/s judged by hitches and the settle after a
stop). Three defects this phase brought into travel, two on the default path (no lighting store), one with the volume.

**What changed, in plain words.**

- **Open regions when chunks leave** (`open-region-stitch.ts`, D667). A region that lost nodes was walked whole from
  its remaining nodes: each row the ring left behind walked the whole outdoors (2,208 nodes in the vitest ring of
  24 × 24 chunks). Now a search starts from each live node that touched a lost one, the searches take a node each in
  turn and join when they meet, and once at most one can still grow the rest is its part (every part holds such a
  node): a row left behind reaches 192 nodes. The same parts and ids as the whole walk (the largest part keeps the
  id; ties by the region's list order). The sky heights of the chunk columns a stitch changed are refreshed inside the
  same `voxelDerive` slice (at least one column a call; the stitch says it has work until they are done); before, they
  were all refreshed after the slice's last chunk.
- **The sun heights' frame** (`voxel-sun-field.ts`, `sun-heights.ts`, D675). Everything the field does in a frame is
  inside the `surfacePrepare` slice: the march's row first (its dispatch carries the uploads of the tops changed
  since), then tiles while the slice lasts. One piece goes whatever the slice says: the row, or, when the last frame
  composed no tile while tiles waited, a tile in its place (before: the first tile of each window always, and the
  dispatch, uploads and copy after the slice). A far tile reads, of each node over it, only the columns the node can
  cover (before: all 1,024 of the tile's for each node).
- **The near sun window at speed.** While the camera moves faster than the streamer's level-0 speed
  (`STREAM_DETAIL_SPEED`, 40 m/s on 0.5 m cells) the near window stays where it was and reads as no window: nothing
  is composed into it, the march skips its columns, and lit points past the key light's map read the far window's
  lines (4 m columns) instead of the near window's (0.5 m). It is let go once the camera stayed slower for the
  streamer's stop time (`STREAM_STOPPED_MS`, 200 ms): the window comes to the camera, composes nearest first within
  the slice and its lines are marched again (32 rows, a row a frame). **What the picture shows meanwhile:** at speed
  the near field draws levels 1–2 anyway; past the map the sun's shade on near surfaces is the far field's 4 m
  columns (a house's shadow past the map coarser or, under 4 m, gone); inside the map nothing changes. After a stop
  the 0.5 m lines return over about 1–2 s (unverified to the eye: no picture taken of the held state or the return).
- **The light volume's batch** (`voxel-light-volume.ts`, `-layout.ts`, `walk-pages.ts`, D694). Its share of a batch
  shown now has spans of its own (`voxel light volume grids`, `voxel light volume walk changes`); the spike capture
  then named the cause (below). A block is copied by its page (`WalkTable.viewCopy`) instead of cell by cell; a brick
  with nothing that stops light on either side is skipped, and a marked brick against nothing differs without reading
  its cells (a page marks a brick only for a stopping cell); the batch's boxes are marked in one pass over the kept
  bricks (`volumeMarkBoxes`: what marking them box by box gives, the stale list in the same order) instead of a pass
  per block.

**D694's cause** (spike capture, `diag-volume-150.*`, built at aba4985b with the spans): the 200 ms page frame at the
flight's start was 191.7 ms of `voxel light volume walk changes`: when the flight starts, level 0 leaves the whole
ring in one batch, and for each of its walk blocks the volume copied the block cell by cell (32,768 calls), compared
it 64 cells a brick against nothing, and marked every kept brick (3.5–9.8 k) against it. Node, 72 blocks taken out:
copy 0.6 ms, the brick scan 2.4 ms and the marks 6.7 → 1.6 ms (best of five, warmed).

**The way there** (all raw in the work folder): set 1 (05:41–06:10 UTC, C at 5609d287) showed C missing more frames
than B (15.5 / 10.1 against 8.2 / 4.6 a minute), the volume frame gone; set 2 (06:24–06:53, C2 at 83ac15af: the held
window hidden from the march) the same (15.5 / 11.9 against 7.3 / 9.1); set 3 (06:55–07:03) with `&voxelSun=off`
read B 1.8 / 1.8 and C2 2.7 / 2.7: the sun field, not the stitch. Cause: the flight's camera is posed by the
simulation's steps, so a page frame can show the last pose again; the one-frame speed read 0, the window was let go,
jumped (clearing and composing what entered, up to the whole window, uploaded at once) and was held again the next
frame. Fixed by the stop time (e4832067, set 4, 07:13–07:42: C3 4.6 / 0.9 against B 7.3 / 10.1); then the one-piece rule
and the splat (9ec1e77a), measured as set 5 below.
A last change tried in Node (searches stepping only the growing ones) gained nothing measurable and was not kept.

**Measured** (set 5) 2026-11-16 08:04–08:34 UTC, Iris Xe, WebGPU, 1280 × 720, low, the 30 Hz cap, each run alone
(`thirdlight-gate` inactive, nothing else running), the brief's 10G scope; uptime 23.7 d, load (1 min) 2.6–3.9.
Coverage bench from exports made of the same staging world (`voxel-slice`, world `far`) by each code's own staging
backend, served with the backend stopped. **A** = the phase base 2ff4af22 plus the profiler's measurement fix
d2cc91a3 (`page-profile.ts` only: the 1.25-interval spike rule and the reader's cursor; without it A's spikes would be
counted by the old rule), in a scratch worktree with a copy of the branch's node_modules, built with
`node tools/build.mjs`, removed after; **B** = 1da714dd (the head before these fixes), the same way; **C** = 9ec1e77a.
The exports differ only in their code and the scene's revision number (the world's content files were identical
and linked into one copy); A derives v31 (no regions, no sun field: nothing of 46e) at run time as built. The bench
is the head's (`run.mjs coverage --dir <export> --quality low --speed <s> [--query]`). Order A B C, A B C (150 m/s),
A B C (60 m/s), then B C, B C with `&voxelLight=volume`. Raw: `~/.cache/thirdlight-phase46e/work/46e.8-fix/`
(`s5-*.json` / `.log` / `.uptime`; `measure5.sh`, `lib.sh`, `summ.py`). "Sim spikes": the profiler's simulation
spikes in flight (top span: the largest tick's first span); "sun": the page's worst `voxel sun heights` span in the
kept spikes (over the page frames it covers); falls: 0 through the true ground in every run (the 60 m/s fall is onto
lower ground, as at 46e.0).

| Run | Longest ms | > 100 | Missed /min | Sim spikes (stitch in the flight's first 0.5 s) | Sun span ms (frames) | Ground s | Full detail s | Nothing pending s | Holes |
|---|---|---|---|---|---|---|---|---|---|
| A 150, r1 / r2 | 48.3 / 44.1 | 0 / 0 | 0.9 / 1.8 | 3 / 1 (none) | — | 0.06 / 0.03 | 5.18 / 4.98 | 7.81 / 8.32 | 0 / 0 |
| B 150, r1 / r2 | 48.9 / 49.1 | 0 / 0 | 7.3 / 5.5 | 5 / 2 (7.3 / 6.8 ms) | 4.3 (2) / 4.3 (2) | 0.03 / 0.07 | 5.85 / 5.45 | 10.34 / 10.46 | 0 / 0 |
| C 150, r1 / r2 | 46.2 / 55.1 | 0 / 0 | 4.6 / 3.7 | 1 / 7 (7.5 / 8.0 ms) | 0.2 (1) / 4.5 (2) | 0.03 / 0.03 | 7.17 / 6.51 | 11.02 / 11.25 | 2 / 0 of 1,970 |
| A 60 | 61.0 | 0 | 1.1 | 1 (none) | — | 0.03 | 5.77 | 8.17 | 0 |
| B 60 | 57.9 | 0 | 4.4 | 3 (7.5 ms) | 2.7 (1) | 0.03 | 6.92 | 9.71 | 0 |
| C 60 | 54.8 | 0 | 1.8 | 2 (10.0 ms) | 0.4 (2) | 0.03 | 7.74 | 10.66 | 1 of 4,920 |
| B volume 150, r1 / r2 | **228.3 / 244.3** | 1 / 1 | 8.2 / 6.4 | 8 / 11 | 4.8 (2) / 7.7 (4) | 0.02 / 0.03 | 7.11 / 9.62 | 11.23 / 11.56 | 2 / 0 |
| C volume 150, r1 / r2 | **47.9 / 59.3** | 0 / 0 | 5.5 / 4.6 | 13 / 12 | 4.9 (2) / 4.7 (2) | 0.02 / 0.03 | 11.75 / 8.11 | 13.47 / 12.22 | 0 / 0 |

Set 4 (07:13–07:42, C at e4832067, the same A and B) read alike: A 2.7 / 4.6 missed, B 7.3 / 10.1, C 4.6 / 0.9; at
60 m/s A 1.1, B 2.9, C 1.8; volume B 274.7 / 214.6 ms longest, C 57.7 / 52.0. Set 3 (sun field off, `&voxelSun=off`):
B 1.8 / 1.8, C2 2.7 / 2.7 missed a minute. B's long volume frame is `voxel draws made` 183–257 ms (no volume spans at
B); C's volume runs kept no page spike at all.

**Still worse than the base, with the cause** (none blocks):

- **Missed frames at 150 m/s:** C 3.7–4.6 a minute against A 0.9–1.8 in the same hour (B 5.5–7.3), though within
  A's own spread over the session (0–4.6, eight rounds). With the sun field off both heads read 1.8–2.7: what is left
  is the sun field at speed. Its composition is inside the slice now; the piece left is the march's row itself
  (`renderer.compute` with the uploads it carries, then the copy), about 2 ms of page a frame while the far window
  changes (a row every frame), over the 1.0 ms `surfacePrepare` slice; and its GPU march (D675, narrowed).
- **The flight's first stitch tick:** 6.8–10.0 ms of `open regions stitched` in one simulation tick 0.4–0.5 s into
  every flight, in B and C alike (A has no stitching). The ring narrows from 192 m to ~48 m and ~3,000 chunks unload
  at once: each call drops 2 ms of them (the slice) and then searches the regions that lost nodes, which in Node costs
  about 0.6 times the drops again; the searches are outside the slice (D667, narrowed).
- **The settle after the stop:** full detail +1–2 s and nothing pending +2–3 s against A, in B and C (C's nothing
  pending 0.6–0.9 s over B's at 150 m/s, 1 s at 60 m/s, but within B's spread over sets 4–5: 10.2–11.2 s). After the
  stop level 0 comes back up to a second later than at A in some rounds, and the outer ring's level 1 about 3 s later
  (`afterSeries`). Not traced here (D701).

**D654** (150 m/s missed against the 0.9–1.8 baseline): A, the base without 46e, reads 0–4.6 a minute over eight
rounds this session (sets 1, 2, 4, 5), so the base still shows it in some rounds; it is not this phase's.

**Tested.** vitest `packages/voxel/src/open-regions.test.ts` (three new: a row unloaded at the open air's edge in a
24 × 24 ring reaches at most 192 nodes, the region keeps its id and equals a flood fill; a tunnel cut by unloads
splits as a whole walk does, the larger part keeping the id, twice, and rejoins; sky heights stitched in slices on a
clock that steps 1 ms a reading: 6 calls, one with columns only, a column seen stale on the way, then every column and
every region as one unbounded update and a flood fill); `packages/three-adapter/src/voxel-sun-field.test.ts` (new: with
the slice spent, 21 frames march 10 rows and compose 11 tiles, never both in one; at 150 m/s with every fifth frame
repeating its pose the near window stays, composes nothing and reads as no window, the far window follows; held until
200 ms after the stop; then it comes, composes the 480 tiles that entered within ceil(480 / 64) + 1 frames, marches
32 rows and holds the same tops as a field that never moved); `packages/voxel/src/sun-heights.test.ts` (new: every
column of five far nodes smaller and larger than a tile, off the tiles' grid, against a reference over all nodes);
`packages/three-adapter/src/voxel-light-volume-layout.test.ts` (new: a batch of 32 town blocks, half taken out, half
dug: the copies equal the blocks before, an uncopied view does not, the changed bricks equal a cell-by-cell
reference, and the one-pass marks equal box-by-box marking in updates and stale order: 34 k of 118 k bricks of four
levels marked).
**Broken** (each run once, logs `broken-*-vitest.log`): the whole walk back (searches to exhaustion) fails the ring
test; column refreshes never done or not counted as work fail the slice test; the sun field as at 1da714dd fails both
its tests; a hold never let go, or let go on one slow frame, fails the hold test; the marks taking the first box
instead of the nearest, the stale list out of order, a wrong skip in the changed bricks, the shortcut that reports a
marked brick against nothing as unchanged, or stopping at a box one brick too far, each fail the batch test; a far
node's column range three columns short fails the reference test.

**Gate.** `gate-fast-20261116-052148` (5609d287; every area of the changed files: 745 vitest files, 21 e2e, village
perf 0/360 missed), `gate-fast-20261116-061315` (ec61172d), `gate-fast-20261116-070248` (e4832067),
`gate-fast-20261116-074634` (9ec1e77a): all GREEN on the first run. The voxel area 337–343 s (no e2e file touched).

### 46e.8 — the close

**Phase gate** `gate-phase-20261116-083948` (start 2ff4af22, at 9ee771fd; 37 min against 46f's 30 and 46d-c's 28):
build, lint, every unit test green (923 files, 518 s); e2e 324 of 328 in 20.8 min, by area: core 31 s, startup 7,
voxel 374 (46f: 171–189; the Play test grew from about 1 to 3.5 min with the shadow, cache, volume and hybrid checks),
rendering 429, materials 338, lighting 189, environment 138, effects 64, levels 400, editor-ui 326, scenes 141,
content 232, play 328, mcp 120, physics 144, audio 57, input 72, scripting 146, animation 60 s. Of the four failures
three passed alone in the gate's own rerun step (`frame-rate-cap.e2e.ts:70` D659, `terrain-cdlod.e2e.ts:133` D428 /
D610 / D643's family, `memory.e2e.ts:494` D710: watch rows). The fourth failed alone too and was real:
`memory.e2e.ts:342`, workers alive 7 → 27 across renderer backend swaps: every scene adapter's surface cache started a
voxel chart worker on its first frame and nothing ended it (46e.5c). Fixed (4eadd022, 918efa3f: the worker starts
with the first chunk to chart and ends with the adapter; the sun heights' 8 MB buffer and undrawn worlds' walks are
released too); `gate-rerun-20261116-092339` green (workers +0), then `gate-fast-20261116-103007` green at the review
fixes. The phase gate was run once. The gate's growth is the voxel area's: new coverage in one existing file, no new
e2e file; the Play test is at 3.3–3.5 min of its 240 s timeout and must be split before it grows again.

**The default path before and after** (no lighting store; low, the 30 Hz cap, alone; after: 048f1f83, 2026-11-16
10:42–10:52 UTC, load 2.1–3.5, `~/.cache/thirdlight-phase46e/work/46e.8-end/`, `measure.sh`, the baseline's commands):

| Measure | 46e.0 / 46e.1 | End of 46e-a | Note |
|---|---|---|---|
| GPU `near` / `far` / `shadows` ms, town orbit | 1.61 (0.45) / 3.49 (0.39) / 0.09 (3 runs) | 1.80, 1.81 / 3.13, 3.50 / 0.60, 0.69 (2 rounds) | shadows +0.5–0.6: voxels cast, the sun field; near +0.2 inside the baseline's run-to-run range |
| GPU lighting row (shadows + lighting) of 6.67 | ≤ 0.2 | 0.60–0.69 | no store on |
| Room at the cap | 176 copies × 0.131 = 23.1 ms, both rounds | 176 × 0.130 in round 1; **7 copies in round 0**, which missed 8 of 89 at its clock check and 1 of 89 at no load | one round as the baseline, one not: not settled; the 46e.7 off rounds read 60–192 |
| Page a frame, orbit (profile) | 4.57 / 4.13 (render 3.91 / 3.48) | **6.32 / 5.03** (render 5.56 / 4.42; lighting 0.09 / 0.10 of 2.0) | +0.9–1.8 ms, in render: more than D672's 0.4–0.8 at the cameras; D672 widened, not traced |
| Simulation a frame, orbit | 2.05 / 1.82 | 2.23 / 1.88 | |
| Page heap / GPU process at the town | 594 / 936 MiB | 611 / 923 MiB | |
| `voxelStream` resident at the five cameras (of 768 MiB) | 47–98 MiB | 137–186 MiB | sun field ≈ 55 MB, walk blocks, sky columns, stitch (D703: no budget entry of their own) |
| Edit → mesh; → shadow | 22–53 ms; no light | 30–59 ms; 61–93 ms | |
| Travel 150 m/s (46e.8 travel fixes, same hour) | longest 48.3 / 44.1, missed 0.9 / 1.8 a min, detail 5.0–5.2 s | 46.2 / 55.1, 4.6 / 3.7, 6.5–7.2 s | D667, D675, D701 open |

**Overstatements, in plain words** (the review's five; the item text of §6 keeps the contract, the rows say what was built): the list is at the end of §8b.

## 8b. The lighting storage A/B (46e.7)

### What was built for it: the hybrid

`?voxelLight=hybrid` runs both stores on one page (`voxel-light-handover.ts`, `-nodes.ts`; `VoxelWorldDraws`): **near the
eye the surface cache's live probes give the sky and bounce light, beyond a hand-over distance d the light volume does,
and across a fade of a quarter of d before it each pixel blends the two** (the volume's share smoothstep(0.75 d, d) of
the pixel's distance to the eye across, x and z; the probes' the rest: the volume's read is built after the probes' and
mixes over what they gave). Each store keeps only what its share needs: the cache lists the level-0 chunks whose box
lies within 1.25 d across of the eye (its tiles, texels, faces' hashes and probes are all it holds; a chunk leaving is a
tile gone), the volume keeps no brick (any level) wholly within 0.75 d − 2 m (one level-0 brick: the eye's step between
re-looks) and looks again at the bricks round the old and new place when the eye has moved 2 m. d is a lighting tier
setting, `voxelLightHandoverM` (low 12 m, medium and high 24 m), `?voxelLightHandover=<m>` for benches,
`__tlVoxelPlay.light.setHandover` for checks. The tier's GPU `lighting` row is split between the two stores' updates
(half each). Lamps' direct light is per pixel (shadow atlas) in both zones.

**What the cache keeps near: its probes, not its per-pixel texel read** (default chosen, owner to confirm). With both
reads a voxel surface's program samples more textures than the Iris Xe's fragment stage allows (16): the texture-unit
guard then draws it with a plain fallback, white and untextured, and the fallback stayed on the objects after the store
changed (D699; found by the first hybrid pictures: the street's shaded grass 164, 173, 184 against 42, 68, 39 with
either store alone; with the cache's texel read off in the hybrid the colours are right). So the cache's texels are lit
only for its probes' bounce (the resolve), the lookup hash is still made (unused: a cost by design here). Of the two
options the brief named (the cache's probes near with its texels; the volume for all bounce and sky with only the
cache's texels near), the second puts both reads in every near program too, so it is ruled out on the same count; the
first without the texel read is the cheaper sound one: it is the only one that fits.

**D699 counted** (the independent review, 46e.8; `d699/` in its work folder): the texture-unit guard's own record of
each program (`light-shots --texture-units <store>`, the street camera; `hybrid-texels` forces the cache's texel read on
in the hybrid, a bench switch). The Iris Xe's adapter and a default device both allow 16 sampled textures a fragment
stage. The lit voxel surface program samples: **off 11** (the shader grids, a 3D texture; the material table; three
compressed texture arrays of the materials; the crack maps; DFG_LUT; the sun's shadow map; the clustered lights' lists;
the shadow atlas; PMREM), **cache 15** (+ the cache's lookup and its atlas, + the probes' table and their 3D texture),
**volume 13** (+ the volume's index and its pool), **hybrid as built 15** (+ probes 2, volume 2), **hybrid with the texel
read 17**: refused, 51–58 objects drawn by the guard's plain fallback (`d699/shots-hybrid-texels/street-noon.png`: the
voxel ground and walls white, the kit pieces textured; beside it `d699/shots-hybrid/street-noon.png`). So the white was
the count, nothing else. **The smallest way to fit both** (not built; for the owner, 46e-b): one unit fewer gives 16,
exactly the limit. The volume's index and its pool are both one-channel 32-bit integer textures, so the index can sit
in spare rows of the pool texture (one binding; the read offsets its rows; its row uploads go to the pool): some 50–100
lines in `voxel-light-volume.ts` and its read, a vitest. At 16 no headroom is left (a decal layer or a second shadow
read on a surface would go over again); a second unit, the cache's integer lookup read from a storage buffer instead of
a texture (storage buffers have their own limit), would leave one spare, about as much again.

**The hand-over distance: 12 m carried, 24 m a side row** (default chosen, owner to confirm). On the moving orbit
(3 rounds each, interleaved) neither has room at the cap; GPU `lighting` 13.3 [13.2–13.4] (two rounds resolved) against
12.1 [11.5–13.0] ms: not resolved; page `lighting` 3.8 [2.9–4.0] against 4.3 [4.1–5.2] ms (apart), cache tiles 8–25
against more; so 12 m (the cache's finest level's reach, the low tier's setting).

**Also fixed on the way (a few lines each, re-measured for every arrangement here):** the editor passed Play only its
listed page flags and `surfaceRead` was not among them, so every "read off" comparison of 46e.5c and 46e.6b drew with
the read on (D698; now passed, with `voxelLightHandover`). A hidden regression in the visual-script catalogue test
(D697). The hybrid at first read `voxelLightHandoverM` while the page's adapter was not made yet (Play refused to
start): read each frame instead.

**Tests.** vitest `voxel-light-handover.test.ts`: the shares sum to 1 at every distance, the volume's rises
monotonically from 0 before the fade to 1 after it; the keep rule against every brick of four sizes round an eye, from
the eye and from an eye moved a step (no brick wholly inside kept, every brick a lit pixel lies in kept); the page flag;
the cache's host lists only the chunks within its reach and follows the eye (3 of 8 chunks, then the next 3; all 8 with
no reach). `gpu-pass-hides.test.ts`: a pass held by name stays hidden and absent whatever the categories. Playwright
`voxel-world.e2e.ts` Play (`voxel-shadows.ts`, inside the volume checks, from the volume settled): hand-over 6 m in the
shut hut, both settled 6.2–8.6 s after the switch; near (the floor before the eye) 6.6–7.0 against 131.2 by the flat
term, far (the far wall, 7.5 m) 5.0–5.3 against 120.3 (bound share 0.5); the cache 8 tiles, its farthest 4.3 m from the
eye within its 7.5 m reach, 343 chunks left out; the volume's nearest kept level-0 brick reaches 3.0 m from the eye, past
its 2.5 m inner ring; back to the volume alone settled in 0.3 s; the store-off picture after equals the one before (0 px).
**With the fade stubbed to "cache everywhere"** (the volume's share 0 in the hybrid, run once:
`e2e-stub-cache-everywhere2.log`) the hybrid checks still pass (far 5.0): the hut's chunk is inside the cache's reach, so
its probes darken the far wall too; the check proves the two residency rules and the darkness, not the fade. A first stub
(share 0 everywhere, `e2e-stub-cache-everywhere.log`) failed at the volume's own check. The fade's shape is proved by the
vitest; a brightness step across the hand-over is read on the pictures (below), not in the e2e: the shut hut is too dark
to show one, and an outdoor hybrid view cost a cache settle more than the Play test's 240 s allows (it ran 3.5 min alone,
3.3–3.4 before).

### D693, the bounded trace

Three experiments, all at the room camera (`d693-*`, `light-shots --only room-window --gpu --gpu-only near,lighting`,
2 interleaved rounds) and on the orbit (`m-volnr-*`, `m-cachenr-*`, 2 rounds):

1. The read off for real (D698 fixed): `near` with the volume lit but not read −1.97 / −2.02 ms, as off (−1.93 / −1.89);
   read on +2.19 / +2.11. **The volume's per-pixel read costs +4.1 ms at the room camera** (2 rounds, spreads 0.02–0.32).
   The cache: its texel read +1.9 / +2.0 ms (cache 0.21 / 0.20 against read off −1.68 / −1.77), its probes' read
   +0.25 / +0.12 (read off against off).
2. The volume's light taken out of the scene's lights (read off, `--light-out`): −1.96 / −1.92, as read off: a light
   in the programs whose node adds nothing costs nothing measurable.
3. The whole frame from the ballast line (not a hide): off 5.6 / 8.2, read off 11.2 / 13.1, read on 17.9 / 18.1, light out
   −1.2 / 14.4, cache 7.8 / 10.8, cache read off −0.3 / 9.9 ms: negative values and 15 ms swings between rounds of one
   arrangement (the copy's ms moved 0.116–0.175 between runs: the GPU's clock under the load). **Not usable**: the frame
   line does not resolve a whole-frame difference at these cameras, so it is reported in no row of the table below.

So the rise D693 named was the read itself (with the store's other work nothing at a settled camera); the earlier "the
same with its read off" compared the read with itself. On the moving orbit the read's share is not resolved (`near` with
the read off below resolution, spreads 0.7–3.3 ms; with it 4.1–4.4 against off 1.8–2.0). **Which rows are pass readings:**
`near`, `shadows`, `lighting`, `far` are hide-a-pass readings (`near` is net of the far field drawing where near's depth
stopped it, D660, the same in every arrangement, so differences between arrangements are the near draws' own); the
orbit's room (ballast copies the frame holds at the cap with no load) is a whole-frame reading; the frame line is not
used. Page ms are the profiler's.

### Measured

2026-11-15 22:58 – 2026-11-16 04:48 UTC at b99489b2 (built, the fast gate green: `gate-fast-20261115-221528` →
`gate-rerun-20261115-222647` → `gate-rerun-20261115-225301`), Iris Xe, WebGPU, 1280 × 720, low, 30 Hz cap, each run
alone (`thirdlight-gate` inactive, nothing else), the brief's 10G scope; uptime 23.3 d, load (1 min) 1.0–5.4 (70 runs, every one with the gate inactive and the code tree clean at b99489b2). Staging's
8 km world, the town. Raw files, an `*.uptime` beside each, and the scripts: `~/.cache/thirdlight-phase46e/work/46e.7/`
(`ab1.sh`: D693 and the orbit; `ab2.sh`: cameras, room first, tiers, travel; `summ.py`; `sheets.py`). Order interleaved:
off, cache, volume, hybrid, then again (the orbit three rounds, also with the 24 m hybrid; the cameras two rounds, the
24 m hybrid one). Values: the median of rounds with the range in brackets (two rounds: both values); a difference
smaller than the range between rounds is "not resolved". Cameras in order street / room / cave / night / far.

| Row | Off (shadows only) | Cache | Volume | Hybrid (12 m) |
|---|---|---|---|---|
| **1. GPU, the 8 km town orbit (moving eye), 3 rounds** | | | | |
| room at the cap with no load (ballast copies; whole frame) | 136 [60–192]; missed 0–1 of 89 | 1 [−1–6]: **no room**; missed 4–6 | 76 [60–88]; missed 0 | −1 [−1–3]: **no room**; missed 0–1 |
| `lighting` ms (of 6.67) | no pass | 10.3 (one round resolved; 6.9 ± 7.2, 8.5 ± 7.3 below) | 6.0 [5.8–6.3] | 13.3 [13.2–13.4] (one round below: 0.42 ± 0.25) |
| of it, each store apart (the other held, one round) | — | — | — | volume 5.1 ± 0.9; cache **not read** (the measurement returned nothing); at 24 m: volume 5.5 ± 1.6, cache 8.3 ± 6.6 (below) |
| `near` / `far` / `shadows` ms | 1.8 [1.8–2.0] / 3.6 [3.3–3.6] / 0.6 [0.5–0.7] | 3.1 / 6.1 (one round each resolved) / below: **not resolved** (resolution 2.5–9 ms) | 4.3 [4.1–4.4] / 4.0 [3.9–4.6] / below | below (resolution 3.6–6.8 ms): **not resolved** |
| **1. GPU settled at the cameras** (street / room / cave / night / far), r1, r2 | | | | |
| `near` ms (the read inside it; net of D660) | failed, −0.14 / −1.98, −1.95 / −0.93, −0.91 / 0.14, 0.09 / 1.79, 1.74 | 2.28, 2.38 / 0.28, 0.43 / 1.20, 1.17 / 3.48, 3.32 / 2.97, 2.96 | 4.19, 4.28 / 2.18, 2.14 / 3.55, 3.49 / 5.40, 5.40 / 4.95, 4.97 | 5.75, 5.95 / 3.83, 4.06 / 4.57, 4.60 / 7.19, 7.36 / 5.47, 5.52 |
| `near` over off (median) | — | +2.5 / +2.3 / +2.1 / +3.3 / +1.2 | +4.4 / +4.1 / +4.4 / +5.3 / +3.2 | +6.0 / +5.9 / +5.5 / +7.2 / +3.7 |
| `shadows` ms | failed, 0.59 / 0.48, 0.42 / 0.40, 0.40 / 1.06, 0.83 / 0.53, 0.59 | 1.44, 1.26 / 1.08, 1.20 / 1.01, 1.21 / 2.15, 1.82 / 0.77, 0.76 | 1.50, 1.65 / 1.34, 1.39 / 1.32, 1.20 / 2.03, 1.98 / 0.62, 0.53 | 0.68, 0.84 / 0.54, 0.61 / 0.26, below / 0.97, 1.09 / 0.39, 0.32 |
| `lighting` ms | no pass | below everywhere (≤ 0.09) | below or 0.10–0.29 | below or 0.15–0.24 |
| **1. GPU while computing** (every texel / brick stale every 0.5 s), `lighting` ms of 6.67 | — | 15.1, 15.1 / 12.7, 13.0 / 7.5, below (11.4) / 6.9, 6.7 / 19.7, 18.9 | 10.8, 9.9 / 12.4, 10.4 / failed, failed / 9.2, 9.3 / 10.5, 10.7 | 18.3, 17.8 / 14.7, 13.4 / 3.8, 16.3 / 7.2, 7.3 / 7.4, 7.6 |
| of it, each store apart (the other held) | — | — | — | cache 14.4, 14.3 / 9.9, 9.9 / below, 13.9 ± 8.4 / 4.2, 4.1 / 3.5, 3.9; volume 5.4, 5.7 / failed, 5.5 / 5.6, 6.0 / 4.5, 5.6 / 3.7, failed |
| **2. Page ms a frame** (profiler; `lighting` against 2.0) | | | | |
| orbit: page, `lighting` mean (worst) | 6.7 [6.4–7.0]; 0.16 [0.15–0.18] (2.2–2.5) | 9.4 [9.3–9.7]; **2.7 [2.4–3.2] (27–35)** | 7.5 [7.3–7.8]; 1.1 [1.1–1.1] (3.8–4.8) | 10.1 [9.3–10.6]; **3.8 [2.9–4.0] (8–17)** |
| settled cameras: page; `lighting` | 2.8–6.4; 0.12–0.28 | 3.0–7.2; 0.24–0.62 (worst 28 at the street) | 2.9–6.7; 0.18–0.38 | 3.0–6.6; 0.22–0.65 (worst 23–25 at the street) |
| while computing: `lighting` | — | **4.9–11.7** | 0.36–0.87 | 0.56–4.6 |
| simulation; job workers (orbit) | 3.6–4.1; 4.1–6.1 | 2.5–2.7; 0.07–0.08 | 2.6–3.2; 0.07–2.4 | 2.6–4.2; 0.05–8.9 | 
| **3. Memory** (cameras: the stores' own readings; orbit: the process) | | | | |
| store, GPU | — | texels 3.0–22.5 of 32 MiB; probes 5.8–12.7 of 128 MiB; lookup texture and resolve buffer 4–17 MB | 29.8 MB fixed (pool, colours, index) of 160 MiB | texels 0.3–11.2 MB, probes 0.1–1.8 MB, lookup + resolve 2–4 MB; + the volume's 29.8 MB (the table's rows show only the cache's: D700) |
| store, page | — | faces' hashes 25–68 MB (lookup 8.4–31.2, resolve 16.6–36.3); probes 1.8–5.4 MB | 8–12 MB | hashes 4.3–8.4 MB; probes 0.07–0.9 MB; volume 8–12 MB |
| tiles / probes / bricks | — | 78–218 tiles; 11.7–35 k probes | 3.5–9.8 k bricks | 8–25 tiles (reach 15 m; 70–197 chunks left out); 0.4–6.0 k probes; 3.5–9.8 k bricks (level 0 3.1–8.7 k, the nearest reaching 7.1–7.2 m) |
| orbit page heap / GPU process MiB | 569–608 / 934–957 | 699–806 / 1,098–1,163 | 602–688 / 978–1,010 | 610–751 / 1,070–1,128 (low's 1,536 / 2,560: all under) |
| **4. Edit → light** (first changed light / settled, ms; r1, r2) | edit → shadow map redrawn 59–95 (street digs) | window 341, 294 / 2,485, 2,477; lamp wall 355, 121 / 3,034, 2,702; dug 354, 121 / 2,707, 2,338 | window 130, 118 / 1,756, 1,689; wall 78, 93 / 505, 520; dug 75, 71 / 562, 560 | window 109, 108 / **4,747, 4,681**; wall 96, 99 / 1,054, 1,057; dug 87, 81 / 1,243, 1,232 |
| **5. Play start → settled** (street first; room first), s | 18.3, 18.6; 18.5, 18.6 (the scene) | 19.1, 19.5; 19.2, 18.9 | 19.2, 19.3; 19.1, 19.0 | **26.8, 26.9; 29.9, 29.5** |
| 2 s / 10 s after arriving at the room | flat term / — | 14 k units stale, the room dark (probes not yet: flat term gone) / texels settled, 1.5–2.6 k probes stale | 6.8–7.0 k bricks stale, the room already dark / settled | 9.6–10 k units + 42–49 k blocks waiting, the room mid-grey / settled at 11.4–11.9 s |
| **6. Travel 150 m/s** (export of 4923a802, after D694's fix; r1, r2; measured again in the review, below the table) | longest 49.3, 52.5 ms; 0, 0 > 100; missed 6.4, 2.7 a min; detail 6.0, 5.1 s; pending 11.3, 9.9 s; falls 0, 0 of 34 | 77.1, 95.9; 0, 0; 11.0, 11.0; 5.3, 5.8; 11.2, 10.6; 0, 1 | 56.0, 46.9; 0, 0; 6.4, 2.7; 8.6, 7.5; 11.2, 11.0; 0, 0 | 46.4, **145.8**; 0, 1; 5.5, 7.3; 8.3, 8.0; 11.3, 11.3; 0, 0 |
| 6, before the D694 fix, 46e.7 (b99489b2) | longest 49.5, 57.1 ms; 0 > 100; missed 8.2, 11.0 a min; detail 7.3, 6.2 s; pending 10.6, 10.1 s; falls 0, 0 of 34 | 63.6, 75.9; 0; 13.7, 13.7; 5.9, 5.7; 10.6, 10.6; 0, 0 | **212.7, 223.5**; 1, 1; 5.5, 10.1; 7.4, 7.2; 12.4, 12.3; 0, 2 | **235.9, 213.5**; 2, 1; 11.0, 11.9; 6.0, 5.1; 12.1, 11.4; 0, 1 |
| **8. Medium / high** (one run each, **unverified on target hardware**) | medium: missed 0/179, `near` 2.4, far 4.5, shadows 0.5; high: missed 33/159, near 6.5, far 7.6 | medium: missed 15/160, lighting 6.1 ± 1.2, near below; high: missed 30/68, lighting 12.1 ± 8.1 (below) | medium: 3/179, near 5.2, lighting 2.8; high: 45/107, near 14.7, lighting 3.0 | medium: 16/164, lighting 8.6 ± 5.9 (below); high: 42/89, near 17.0, lighting 13.7 |

**Row 6, measured again** (the independent review, 46e.8): 2026-11-16 10:11–10:26 UTC, one export of 4923a802 (the travel
fixes and the review's code fixes, built) from staging's world, low, the 30 Hz cap, `run.mjs coverage --dir <export> --speed
150 --query &voxelLight=<store>`, off / cache / volume / hybrid interleaved, two rounds, each run alone (`thirdlight-gate`
inactive), the brief's 10G scope; uptime 23.7 d, load (1 min) 3.1–5.4. Raw: `~/.cache/thirdlight-phase46e/work/46e.8-review/`
(`cov-150-*.json` / `.log` / `.uptime`, `measure.sh`, `summ.py`). The volume's flight-start frame is gone (D694 fixed): the
volume and the hybrid miss as many frames as off (2.7–7.3 a minute), the cache 11.0 (its light pass and lookup packs:
the worst kept frame 75 ms with `surface light pass` 40.6 and `surface lookup packed` 19.0). The hybrid's 145.8 ms (one
round of two) is an interval frame: 133 ms between page frames whose own spans total 14 ms (`voxel draws made` 8.3, draw
submit 3.1, the volume 2.0): not page work, not traced. Both arrangements with the volume settle later after the stop: full
detail 7.5–8.6 s against 5.1–6.0 (off) and 5.3–5.8 (cache) (D701's settle, more with the volume; not traced).

**The 24 m hybrid (side row, cameras one round; orbit three rounds above):** settled `near` 6.57 / 6.32 / 6.26 / 7.91 / 5.81
ms (12 m: 5.75–7.36); computing `lighting` 18.1 / 13.3 / below / 7.8 / 15.6 (cache 14.9 / 8.9 / below / 4.1 / 12.1, volume
4.7 / below / 4.4 / 5.0 / 3.8); 24–61 cache tiles (reach 30 m), 2.0–12.4 k probes, hashes 9.9–17 MB page; edits: window
first 132 / settled 4,013 ms, wall 80 / 3,120, dug 74 / 2,877; Play → settled 26.4 s; orbit page `lighting` 4.3
[4.1–5.2] ms.

**D694 repeats** (volume, both rounds; and the hybrid): one page frame of 182–217 ms at the flight's first 0.5 s whose
spans are `voxel draws made` 199–213 ms (the spike capture, `cov-150-volume-r*.json` / `-hyb12-*` `spikes.profile.worst`);
the cache alone and off have none (the cache's worst 51–57 ms: `surface light pass` 17–35 ms and `surface lookup packed`
17 ms). Not traced further then; D694 was traced and fixed in 46e.8 (ec61172d): row 6 above is measured again after it.

**Not resolved / not read:** the frame line (D693 above); on the orbit the cache's and the hybrid's `near`, `far` and
`shadows` (resolution 2.5–9 ms: the stores' relight swings the windows), the cache's `lighting` in two of three rounds;
the hybrid's cache share on the orbit (the held measurement returned nothing); at the cave the volume's computing
reading failed both rounds (the ballast line); the street's `off` GPU reading failed in round 1. `shadows` with a single
store reads 0.4–1.0 ms over off at the close cameras, with both under off's: not explained (one more term in the shadow
programs? not traced). The hybrid's step across the hand-over at the street (grass rows across 9–12 m; `steps.py`): the
largest row-to-row change of the grass's brightness 13.1 against 10.6 (cache) and 10.3 (volume) (a fence edge in all
three); its step beyond both alone at most 2.5 (rows 398–421) where the two stores' grass differs by 5–13: blended, not
switched at a line (one picture; to the eye no seam at the street, room or night camera).

### Pictures

Sheets for the owner's page, labelled in the image, panels at half size (`sheets.py`, the first round's pictures; the
second round's beside them in `shots-*-r2/`): `~/.cache/thirdlight-phase46e/work/46e.7/sheets/` — `street-noon.png`,
`room-window.png`, `cave.png`, `night-lamps.png`, `far-view.png` (before 46e.0 | shadows only | cache | volume | hybrid 12 m);
`edit-window-*.png`, `edit-lamp-wall-*.png`, `edit-lamp-unwall-*.png` per store (before | at the first changed light,
taken 74–373 ms after the command | settled); `room-arrive-2s.png`, `-10s.png` (off | cache | volume | hybrid). Every
camera picture looked at (the five × four arrangements of round 1, the sheets); the pictures after each GPU measurement
differ by 0.7–3.9 % (D660, as before).

| Camera | How the arrangements differ to the eye |
|---|---|
| street | Off: everything lit by the flat term, window and door interiors bright. Cache, volume and hybrid alike at a glance: dark interiors, soft shade under the eaves, the outdoors a little darker. Cache: a black sliver along the right brick house's edge (D683). Volume: the white gable mottled at a metre's scale (D692). Hybrid: the cache's look near, the volume's past 12 m; no seam seen on the grass or walls across 9–12 m. |
| room | Off: as bright as the street. Cache: dim grey walls, the lit band at the west wall's foot, the stairs dark. Volume: darker still (walls near black), soft cell-to-metre blotches round the windows (D692), the window reveals bright. Hybrid: the cache's look (the room lies within 12 m), the left wall's foot a touch brighter. |
| cave | Off: the tube as bright as outside. Cache: darker inward, softer step faces, two thin black slits on the right wall (D683). Volume: darker inward with hard-contrast step faces (dark risers, bright treads), no slits. Hybrid: the cache's softness on the walls near the eye, the volume's high-contrast risers toward the mouth, no slits. |
| night | Lamp pools on grass, fences and fronts in all; off: the unlit fronts near black. Cache: softer pools, the eave pieces' stepped shadow on the brick gable missing (kit pieces cast nothing into the cache's rays, D679). Volume and hybrid alike: the pools per pixel with the atlas's shadows (the stepped shadow there), bounce on the gable and fronts. |
| far view | Far field the same in all. Near houses (horizontally within ~20 m under the 40 m-high eye): cache — white gables, window openings black; volume — darker cloud-shaped patches on the gables (D695), the openings' reveals light; hybrid — the volume's patches on the gables past 12 m, the openings dark near. |

### What each arrangement cannot do, or costs, by design

- **Off:** no occlusion, sky or bounce from voxels; interiors and the cave as bright as the street. Costs nothing.
- **Cache:** lamps' light per texel with soft traced shadows, but kit pieces and moving objects cast nothing into its
  rays (D679); its light ends with the level-0 ring (~45 m at low; past it the flat term); a moving eye relevels and
  relights tiles all the time, so on the orbit it never settles and takes its whole GPU row and 2.4–3.2 ms of page a
  frame (D685); at 150 m/s it misses 11 frames a minute (off 2.7–6.4; longest 77–96 ms: its light pass and lookup packs); 25–68 MB of faces' hashes on the page; slits and blotches at concave steps (D683).
- **Volume:** sky and bounce only (lamps and sun per pixel); its read costs +3–5 ms of `near` per pixel at every
  camera (the largest single cost measured here, D693); soft blotches at 32 rays a face (D692), gable patches from 40 m
  up (D695); a fixed 29.8 MB pool; its update holds ~6 ms of GPU on a moving eye; at 150 m/s no frame over 100 ms since
  D694's fix (46.9–56.0 ms longest, missed as off), but full detail about 2.5 s later than off after the stop; reach 96 × 48 × 96 m at 0.5 m, coarse levels to ±96 m, the flat term past them.
- **Hybrid:** both stores' work on a moving eye (orbit `lighting` 13 ms, no room, page `lighting` 2.9–4.0 ms), `near`
  +5.5–7.2 ms over off, 1.6–1.8 ms more than the volume alone at every camera though the probes' read measured
  +0.1–0.25: unexplained (D706), the volume's update at half the row
  (a window dug settles in 4.7 s against 1.7–2.5 alone; Play → settled 27–30 s), the 29.8 MB pool beside the cache's
  smaller set; no per-pixel cache texel read (16 textures, D699), so the cache's soft lamp shadows are not seen;
  the cache's lookup hash made but unused; at 150 m/s missed as off, one 146 ms interval frame in two rounds (not page
  work, not traced), full detail about 2.5 s later than off.

### Overstatements, in plain words (the independent review, 46e.8)

- **"One occupancy walk, one definition":** three arithmetic helpers (`walk-steps.ts`: crossing time, first of three,
  order of two) are shared and generated into the WGSL; the loop, block and brick traversal, hash lookup and box
  crossings are written twice (`occupancy-walk.ts`, `voxel-walk-wgsl.ts`) and held equal by a 1,200-ray check; the
  GPU walk stops at the mips (D662).
- **"Open regions from roles" (R101):** regions come from derived occupancy; only portals use a role (`opening`);
  "enclosed" means no sky, complete and not at the world's edge.
- **"A far sun shadow by a march through distance bricks":** a per-column height-field shade line over two windows of
  column tops, marched in compute a row a frame; lit pixels read their column's line.
- **"GPU time per pass":** the frame's GPU time with a category hidden, under ballast, net of what the hide changes
  elsewhere (D660, D661).
- **"The hybrid: the cache near, the volume beyond":** the cache's probes near (its texels lit but not read per pixel,
  its lookup hash made but unused: D699), the volume beyond.

### Tests the review judged weak (logged, not fixed in this phase)

- Hybrid fade, Play e2e: passes with the volume's share stubbed to 0 (`e2e-stub-cache-everywhere2.log`): it proves the
  residency rules, not the hand-over. Real: the far wall outside the cache's reach (> 1.25 d), or a pixel row read
  across d.
- Cache caster marks, e2e: passes with `castersChanged` marking nothing; the lit wall must lie in another chunk than
  the pillar.
- Volume and cache tint: the volume's bound is +2 % (`VOLUME_TINT_FACTOR` 1.02, measured 1.062); the cache's colour
  check (`HUT_TINT_MIN` 1.5) was deleted when it failed (D682): the cache has no colour-bounce test.
- Play test timeout raised 180 → 240 s; it runs 3.3–3.5 min: the next growth splits the test, never a longer timeout.
- The "broken" runs were stubbed once by hand: believable from the test code, none repeatable.
- Fixed here (minutes each): the known GPU pass's ratio bounds no longer skip a missing ballast reading (it fails);
  the light volume's lamp bounce must exceed 480 (a third of the least of 1,461–1,921 logged), not 0.

## 8c. Results, 46e-b

### 46e.9 — the cache's voxel port and the hybrid removed

**What went** (0c832013; the code stays at the tag `ab-46e-a`): the surface cache's voxel tile source and charts
(`surface-cache-voxels.ts`, `surface-cache-host-voxels.ts`), the faces' hashes (`surface-voxel-faces.ts`), the chart
worker (`voxel-chart-worker.ts`, and its place in the view's worker script and in the export's worker bundle, which
again ships only for games with block layers), the page's feed of voxel chunks to the cache (`voxel-world-light.ts`),
the tracer's voxel scene kind, the live probes placed over voxel charts, the voxel chunks' caster marks, the
hand-over (`voxel-light-handover*.ts`), the tier setting `voxelLightHandoverM`, the editor's Play passthrough of
`voxelLightHandover`, and the page hooks that served them (`cache`, `check`, `resolveCheck`, `handover`,
`setHandover`, `holdPass`, `setHybridTexels`); the benches' cache and hybrid branches (`--hold`, `hybrid-texels`, the
tracer check, the cache's settle wait); their tests (six vitest files, the bench's `surface-voxels.test.ts`, the Play
e2e's cache checks and the hybrid's). 54 files, +206 −5,089 lines (tests −1,467).

**What stayed.** Phase 42's files (`adapter-live-probes`, `adapter-surface-cache`, `probe-geometry`, the
`surface-cache-*`, `surface-changes`, `surface-light-runtime`, `surface-probes`, `surface-relight`, `surface-resolve*`,
`surface-texels`, `tracer-*`) are byte for byte as at the 46e start (2ff4af22); `adapter-surface-light.ts` and
`adapter-surface.ts` keep only the GPU measurement's hide of the live light (46e.1); `probe-lighting.ts` keeps the
volume's place after the probes (`KEPT_IRRADIANCE`). The volume keeps its full GPU `lighting` row (the hybrid halved
it), its read, `?surfaceRead=0` and the light-out switch; `gpuPassHides.hold` (now unused outside its test) and the
texture-unit guard's record (`light-shots --texture-units off|volume`) stay as measurement tools. `VoxelWalkBuffers`
moved to `voxel-walk-gpu.ts` (the volume binds the walk). The switch: `?voxelLight=off|volume`, any other value is
`off` (a vitest); the volume stays off on every tier.

**Gate.** `gate-fast-20261116-185445` (35 min; build, lint, the whole unit suite since files were deleted: 918 files,
531 s; e2e 319/322) → `gate-rerun-20261116-193012` green: the three failures were known rows, not this item's area —
two exports refused with "the configured exportRoot is not a directory" (D642's watch: `painted-terrain.e2e.ts`,
`physics-3d-colliders.e2e.ts`) and `terrain-cdlod.e2e.ts:520` at 0.594 against 0.6 (D643). `tests/e2e/memory.e2e.ts`
is opt-in (`TL_MEMORY=1`), so the fast gate skipped it though named; `gate-area-20261116-193623` (the `play` area, the
leak test on) green: the backend swap ×10 workers +0/−0. **The Play test** (`voxel-world.e2e.ts:1369`, in the gate,
2 e2e workers): 3.4–3.8 min in the gates before (gate-fast-20261116-074634, gate-phase-20261116-083948,
gate-fast-20261116-092847) → 2.5 min, under its 240 s timeout (not run alone; the gate's readings both sides).
Voxel area 364–374 s → 288 s.

**Nothing visible changed** (from committed, built 086737dc, staging's 8 km world, low, the 30 Hz cap, each run alone;
work folder `~/.cache/thirdlight-phase46e/work/46e.9/`; pixels differing by more than 10 a channel, `tool/compare.ts`):
- Store off (`shots-off/`) against 46e-a's end (`46e.8-end/shots/`): street 0.30 %, room 0.000, cave 0.000, night
  0.000, far 0.02 % (46e.0's run-to-run: up to 0.2 %). Looked at: the same pictures.
- Volume (`shots-volume/`) against 46e.7's (`46e.7/shots-volume-r1`, `-r2`, b99489b2): room 9.0 %, cave 3.2–3.7 %,
  far 0.6–0.7 % (46e.7's two rounds 0.000 / 0.15 / 0.4 % apart). Traced: not this item. Interleaved A B A B
  against the tag `ab-46e-a` built in a worktree of its own (`ab-base-r1/2`, `ab-head-r1/2`, `ab.sh`): the room
  0.000 % in every pair, so the 9 % came from 46e.8's volume commits after the 46e.7 pictures (5609d287, ec61172d);
  base against head street 0.12–1.11 %, cave 0.61–1.59 %, night 0.00–0.08 %, far 0.00–0.84 %, within each version's
  own spread (base r1/r2 street 0.26, cave 0.65; head r1/r2 street 0.86, cave 1.16, far 0.84 %: head r2 the noisy run
  against both). Looked at: the cave pair (the same risers, treads and floor blotches), head's street, room, night and
  far view: the volume's look as in 46e.7 (§8b's pictures table), the gable patches (D695) and room blotches (D692) where
  they were.
- `?surfaceRead=0` reaches Play: the room camera with the volume lit but not read (`shots-noread/`, the volume settled,
  9,910 bricks kept) against the store-off room: 0.002 %; against the volume read: 99.6 %.

**Default path, a sanity reading** (`headroom-low.json`, one round, the town orbit; 46e.10 measures it properly): room
192 ballast copies held at the cap (46e-a end 176; 46e.7's off 136 [60–192]), near 1.58 ms, shadows 0.70 ms, no
`lighting` pass, page 7.1 ms a frame at no load (one reading; 46e-a end 5.0–6.3, 46e.7 orbit 6.4–7.0); uptime 24.1 d,
load (1 min) 5.3 → 1.7. No per-frame work was added (the off path lost the hand-over's uniform set each frame and the
cache host's voxel residency pass).

**Page memory freed with no store:** nothing measurable. The memory table's rows at the street camera, off, equal
46e-a's end (voxelStream 187.23 MB both; no surfaceCache or probes row): the chart worker only started with a chunk
to chart under the cache store, and the faces' hashes were empty arrays until a voxel tile came.

**D-rows.** Superseded by 0c832013: D679, D682, D683, D684, D685, D686, D704, D706 (they described the cache's port
or the hybrid only). Left open, narrowed to what survives: D699 (the texture-unit guard's plain fallback stays on an
object after the program that went over is gone; the voxel surface program samples 11 of 16 with the store off, 13
with the volume) and D700 (the volume's 29.8 MB shows in the memory table's `surfaceCache` row; it has no row of its
own). D702 lost its `CHART_JOBS_IN_FLIGHT` clause. D696 stays open.

## 9. Decision log

- 2026-11-14 (OWNER): the A/B runs **both stores on voxels, on the same scene**: "we had at one point wondered if
  we would run both on voxels with surfels up close and voxels cache further away depending on the look and
  performance. I think we need to port this to voxels in order to do a fair comparison." The plan's first
  default (the cache measured on the old scenes) is withdrawn; 46e.5 ports the cache, 46e.6 builds the volume,
  46e.7 measures each alone and the hybrid. The loser's code is removed or left behind a switch by the owner's
  choice at the stop, not before.
- 2026-11-14 (plan, default chosen, owner to confirm): 46e stops after the A/B (46e.8); the owner agreed to the stop (2026-11-14); the walk graph and
  culling wait in 46e-b though they do not depend on the choice, so the stop comes early.
- 2026-11-14 (plan): the generic A* core is new in `shared`; `block-walk.ts` keeps its own until it retires in 48
  (retiring code is not touched).
- 2026-11-14 (plan): 46f's defaults stand (owner): the arbiter stays a table, D652 waits for the performance
  phase, job kinds wait for 48, voxel redo stays as built (the spec sentence waits for the owner's note).

- 2026-11-14 (46e.0, default chosen, owner to confirm): the cave the cave camera needs is dug by the bench's set-up
  (one `editVoxels` stroke into the hillside nearest the town, kept in staging's world) rather than added to the
  far-world generator: regenerating the 8 km world and its far cache costs far more, and no format changes. The
  lamps are scene objects the bench adds and takes out each run, so no other bench sees them.
- 2026-11-14 (46e.0, default chosen, owner to confirm): the lighting pictures use a clear physical sky (clouds 0)
  in both looks: clouds drift with time, so two runs' skies would differ; noon keeps the scene's own sun
  (direction [0.4, −1, −0.3], 1.2) and ambient, night turns the sun off under the horizon with a dim blue ambient.
- 2026-11-14 (46e.0): the profiler's spike threshold is 1.25 frame intervals (was 1.5): under a 30 Hz cap on a
  60 Hz display one missed frame is 1.5 intervals exactly and was never kept, against the Profiler page's
  definition of a long frame ("a missed frame"); and `__tlProfiler.read(after)` now passes its cursor on.

- 2026-11-14 (46e.1, default chosen, owner to confirm): shadows are held against the GPU's `lighting` row and
  the post stack against `other` (`GPU_PASS_BUDGET`); the draws are `render`.
- 2026-11-14 (46e.1, default chosen, owner to confirm): the measurement's defaults: 5 interleaved repeats, 1.5 s
  windows, 0.4 s settle, load to max(1.5 frame intervals, interval + 20 ms); a reading is below resolution unless
  its median is above both its spread (IQR) and the control's (about 2 minutes a run on the low town).
- 2026-11-14 (46e.1, default chosen, owner to confirm): `tl_diagnostics` starts the measurement with the section
  name `gpuMeasure` and reads it with `gpu` (no new argument); both only when named.
- 2026-11-14 (46e.1, default chosen, owner to confirm): WebGL 2 answers "not available" (the reading needs the
  GPU's completion times); the page holds the render scale and texture streaming while it measures.
- 2026-11-14 (46e.1): the profile report carries the measurement as an optional `gpu.measure`; capture files stay
  `version: 1` (an older reader ignores it).

- 2026-11-14 (46e.2, default chosen, owner to confirm): a cell stops a pick when drawn as a body (derived occupancy),
  light when solid and its light coverage is 128 of 255 or more; liquid, openings and props' coverage stop neither.
- 2026-11-14 (46e.2, default chosen, owner to confirm): the walk's GPU data are storage buffers (a hash table of 32³
  blocks and bit pages), not a texture through `region-texture.ts`: exact u32 words, read by compute passes only; no
  stored format. The batches carry them; WebGL 2 pages drop them.
- 2026-11-14 (46e.2, default chosen, owner to confirm): empty space is skipped by the walk's own blocks and bricks,
  not `ChunkTreeFlags` (it counts a chunk never given as empty, so it cannot tell air from not loaded); where no level
  and no far node knows a place, a ray passes as through air (light reaches it).
- 2026-11-14 (46e.2, default chosen, owner to confirm): `ctx.voxels.raycast` stops at `solid` by default; hits in the
  mips or far nodes carry no voxel (`far: true`).

- 2026-11-15 (46e.3, default chosen, owner to confirm): open = not drawn as a body (the walk's `solid` stop), so
  liquid, rails, posts and beams' bars are open; `opening` cells are portals apart; damaged walls stay closed.
- 2026-11-15 (46e.3, default chosen, owner to confirm): stitched per storage chunk where the world runs, in the
  derive slice (`voxelDerive`, no new constant), at least one chunk an update; space no chunk knows counts as open
  for sky; enclosed needs complete, no sky and not the world's edge; ids: the largest part or the largest merged
  region keeps its id (the outdoors' id moves as the ring moves).
- 2026-11-15 (46e.3, default chosen, owner to confirm): the page gets sky heights as plain arrays per chunk column
  with the batches; the GPU form (a texture over the resident area through `region-texture.ts`, or beside the walk's
  buffers) is 46e.4's first step, made in the shape its shader reads; region labels stay on the CPU (4 KB a mixed
  section); the overlay is the voxel page's (`?regions=1`), not Play's.
- 2026-11-15 (46e.3, default chosen, owner to confirm): `ctx.voxels.regionAt(x, y, z)` takes numbers like `get` and
  `coverageAt`; the region part is in the canonical bytes (derived v32).

- 2026-11-15 (46e.4a, default chosen, owner to confirm): voxel surfaces (every near-field level) and kit pieces cast
  and receive on game pages only (Play, exports); the editor's Scene view stays without (an edit view; one flag
  turns it on). They are static casters; a change is reported as the changed draw's whole box (a chunk's 16 m
  sphere, not the edit's cells): cheap, and the cached map is one draw either way.
- 2026-11-15 (46e.4a, default chosen, owner to confirm): the key light's square is centred on a voxel world's top
  solid cell under the camera (else y = 0, as before); the top cell, not the camera's height, so what stands over a
  room or a cave stays in range.
- 2026-11-15 (46e.4a, default chosen, owner to confirm): no new tier setting: low affords voxel shadows (0.37 ms of
  its 6.67 ms lighting row, page render +0.4–0.8 ms at four of five cameras); the existing shadow map size, atlas
  side and contact-shadow settings decide per tier. `?voxelShadows=off` replaces `?voxelShadows=static`.
- 2026-11-15 (46e.4a, default chosen, owner to confirm): the atlas's lamp and spot cameras see the off-view layer
  (what is hidden from the view still casts, as for the sun), so a relief chunk's plain caster, a cut-away roof and a
  room no portal shows cast lamp shadows too.

- 2026-11-15 (46e.4b, default chosen, owner to confirm): the far sun shadow and the gap past the map are one term,
  shade lines a column over the sun heights (the sky heights near, the far field's brick tops far) marched in compute,
  not a per-pixel march through the bricks (a second far pass's cost at low, and a GPU far-node lookup, D662) nor a
  cascade (a second map, still ending). The brick tops are a column scan of the field the brick march walks (vitest:
  within 0.35 cell of the CPU march), not the march itself, whose cost a column is far higher.
- 2026-11-15 (46e.4b, default chosen, owner to confirm): the windows: near 1,024² columns of 0.5 m (512 m, a chunk
  column a tile), far 1,024² of 4 m (4 km), the march's reach the far window's half side; tops composed within the
  lighting preparation slice (`surfacePrepare`); the lines marched one tile row of each window a frame while anything
  changed in the last full pass (32 frames); no new slice or budget constant.
- 2026-11-15 (46e.4b, default chosen, owner to confirm): `voxelSunSteps` on the lighting tiers, low 12, medium 16,
  high 24 samples a column (0 off): low affords it (+0.2 ms moving, +0.02–0.12 ms still, of 6.67).
- 2026-11-15 (46e.4b, default chosen, owner to confirm): near draws read the lines at their vertices (D673), the far
  shade at its pixels; the map hands over across 0.8–0.96 of its half side; inside it only casters past its near plane
  (farther across than (20 − 0.5) m × the sun's horizontal share) shade.

- 2026-11-15 (46e.5a, default chosen, owner to confirm): the cache's voxel charts are made on the page from each
  level-0 chunk's drawn mesh (the draw batch's ground and construction faces), not in the derive workers: no new
  derived output, no format step. A triangle is charted by its main axis into the 0.5 m columns its projection covers;
  columns whose surfaces lie within 1.5 cells and whose normals turn less than about 45° (cos 0.7) are one chart
  (greedy rectangles); a surface with a body half a cell in front of it (the walk's blocks on the page) is hidden and
  charted nowhere. Texels as phase 42's levels by distance (10 cm to 12 m, doubling to 3.2 m); no new constant.
- 2026-11-15 (46e.5a, default chosen, owner to confirm): only level-0 chunks (the detail ring) are cache tiles; the
  level 1–2 mesh rings, kit pieces and the far field keep their lights per pixel (46e.5b and the hybrid decide more).
- 2026-11-15 (46e.5a, default chosen, owner to confirm): where the tier gives live light no GPU time (low), a page
  lighting voxels by the cache takes its tier's GPU `lighting` row (20 % of the frame: 6.67 ms at low) for the work
  while texels are stale, none once settled; medium and high keep `surfaceLightMs`. The volume (46e.6) takes the
  same row.
- 2026-11-15 (46e.5a, default chosen, owner to confirm): the lighting store is a page query, `?voxelLight=off|cache|
  volume|hybrid` (default `off`), passed from the editor to Play, and `__tlVoxelPlay.light.setStore` at run time for
  checks and benches; not a project field yet (a `voxelWorld` field would need its validator, canonicalizer,
  descriptor and the world option carried to the page's draws: more than a small add-only field).
- 2026-11-15 (46e.5a, default chosen, owner to confirm): the tracer walks one voxel world (the first with walk blocks
  on the GPU) in a second program, so pages without voxels keep the first; a shadow ray that starts inside a body
  (its own surface's partly filled cell) goes on from where it leaves that cell, twice at most. GPU only: the CPU
  tracer twin has no voxel kind (the page's check walks the same rays on the CPU walk instead).
- 2026-11-15 (46e.5a, default chosen, owner to confirm): a voxel pixel finds its face by the geometry normal's main
  axis, else the next axis (a flat normal from derivatives flickered at triangle edges under the upscale's jitter).

- 2026-11-15 (46e.5b, default chosen, owner to confirm): the live probes over voxels are phase 42's bricks, marked from
  the cache's voxel charts (a flat construction chart is a plane: level 0 where planes meet, else 1; a curved chart its
  box, level 1 when its mean normal faces up (y ≥ 0.5: ground), else 0: a cave's walls and roof, an overhang), valid
  where the walk's blocks on the page say a cell is open; a probe in a body is dropped, never moved (no virtual offset
  onto voxel ground). No rooms: the bricks' own wall rule (the axis rays' edge cuts) keeps light on its side.
- 2026-11-15 (46e.5b, default chosen, owner to confirm): on a page whose voxel worlds the cache lights, the live probes
  hold the scene's realtime ambient and hemisphere lights (their sky holds that light, as a bake's mixed mode does),
  so the flat ambient term is replaced by the probes inside their bricks and kept outside them; given back when the
  probes leave (`?voxelLight=off` draws as before).
- 2026-11-15 (46e.5b, default chosen, owner to confirm): the sun's share at a probe ray's voxel hit is the texel's own
  (the cache's light pass traces it through the walk), not `SunField.lit`: the texel holds the sun with its traced
  shadow, which is what phase 42 reads for its other kinds.
- 2026-11-15 (46e.5b, default chosen, owner to confirm): the resolve table holds its own hash of the resident voxel
  chunks' keyed faces (the walk's hit cell and face, behind keys included), at most 3/4 full, and finds the texel in
  whole numbers so the GPU and its CPU twin agree exactly; the materials' lookup keeps its own (no shared buffer).
- 2026-11-15 (46e.5b, default chosen, owner to confirm): `light-shots` and the Play e2e count the cache settled only
  with its probes lit, none stale, drawn and nothing held back (`__tlVoxelPlay.light.cache().probes`).

- 2026-11-15 (46e.5c, default chosen, owner to confirm): the cache's voxel charts are made on a worker of the view's
  worker script (the page's, beside the block mesher), not in the voxel job pool (it runs in the simulation worker) nor
  as part of the draw batch (a derived output): no new job kind; a job carries the chunk's mesh and the walk's level-0
  blocks round it; two jobs in flight, nearest first; the page charts in steps where no worker starts.
- 2026-11-15 (46e.5c, default chosen, owner to confirm): the lookup's and the resolve's voxel hashes are kept across
  changes (≤ 1/2 and ≤ 3/4 full, made again with a third more room when they outgrow it, or at an eighth of their load);
  a face two chunks key is the one whose chunk's box holds its cell, else the first chunk by key (was: the first resident
  one); the resolve's slot holds its chart's place as the lookup's does.
- 2026-11-15 (46e.5c, default chosen, owner to confirm): a voxel chunk that comes, goes or is drawn again marks the
  units touching its box and those it can stand across from a light or a sun (exact for boxes, the light's size and the
  sun disc's spread grown in), not every unit a touching light reaches; old scene kinds keep their rule. A sun under 0.1
  sine falls back to the old sweep.
- 2026-11-15 (46e.5c, default chosen, owner to confirm): the memory table's `probes` row on a page whose probes are
  live (no bake's probe set) is the live probes' GPU bytes (the pass's records and the probe lighting's tiles).
- 2026-11-15 (46e.5c, default chosen, owner to confirm): "GPU while the light is being computed" is read with every
  texel and probe of the cache marked stale every half second while the measurement runs (`light-shots --gpu-stale`):
  a stale state lasting seconds after an arrival or an edit is too short for a two-minute measurement.

- 2026-11-15 (46e.6a, default chosen, owner to confirm): the light volume keeps 2 m bricks (4³ cells, the walk's own) in
  a pool texture three owns, found through a wrapped index of a 48 × 24 × 48-brick window round the eye (96 × 48 × 96 m,
  the low tier's detail ring and more; one size for every tier until 46e.6b), not dense windows per level: memory only
  where cells hold light, and a read of one index texel and three face texels a cell. A face is one RGB9E5 word (24 B a
  cell) and a cell's bounce colour one more (1,792 B a brick).
- 2026-11-15 (46e.6a, default chosen, owner to confirm): the leak rule is the cells' own: a reader blends only cells
  holding light (a face word is never 0 there) round its point half a cell off the surface; no region ids.
- 2026-11-15 (46e.6a, default chosen, owner to confirm): 4 rays a face an update, 8 updates to settle (32 a face),
  cosine-weighted; past 24 m a ray sees the sky. Cost first: fewer rays showed cell-sized blotches round the room's
  windows (D692 remains at 32).
- 2026-11-15 (46e.6a, default chosen, owner to confirm): the sun at a bounce hit is seen by a walk toward the sun
  within 48 m (as the cache's light pass traces it through the walk), not the shadow map and `SunField.lit`: the compute
  pass has the walk at hand, and reading three's two shadow maps and the shade lines there would take more private
  hooks for the same answer near the map. Lamps: a walk to each lamp in range (a spot as a point, its cone not read).
- 2026-11-15 (46e.6a, default chosen, owner to confirm): the bounce takes the material look's colour (the chunks' shader
  grids kept on the page while the store is the volume); a textured look without a colour of its own bounces the live
  probes' default grey (0.3): the textures' texels are not read, where the cache captures the drawn colour.
- 2026-11-15 (46e.6a, default chosen, owner to confirm): the volume's GPU bytes are held against the tier's
  `surfaceCache` + `probes` entries together (160 MiB at low; read from the table, no constant), shown in the cache's
  row first, the rest in the probes'; the grids kept for colours count in `voxelStream`.
- 2026-11-15 (46e.6a, default chosen, owner to confirm): a changed block marks by the bricks whose cells changed: those
  within 2 bricks start from nothing, the rest within the rays' 24 m keep half their history; the sun, the sky and a
  lamp's move keep half too. Pacing: the tier's GPU `lighting` row by the pass's own timestamps, nearest first; the
  page's share in the `surfacePrepare` slice.
- 2026-11-15 (46e.6a, default chosen, owner to confirm): voxel surfaces read the volume per pixel (merged faces span
  metres between vertices, so a vertex read is not one), in place of the held ambient and hemisphere light and the
  environment's diffuse light, as the probes replace them; `?surfaceRead=0` keeps it lit and unread. `hybrid` does not
  make a volume yet (46e.7).
- 2026-11-15 (46e.6a): `npm run lint` gives ESLint a 7 GB heap (D688); the Play e2e's timeout 180 → 240 s (both
  lighting stores' checks on one page).

- 2026-11-15 (46e.6b, default chosen, owner to confirm): the volume's coarse levels are three clipmap windows of 12 × 6 ×
  12 bricks (1 m cells to ±24 m, 2 m to ±48 m, 4 m to ±96 m across) in the same pool and index; a coarse cell stops light
  where some level-0 cell in it does (the mips' rule, from the walk's level-0 blocks) and holds light wherever it is
  open; a coarse brick is kept near what is solid (the level-0 kept rule over its bricks), not in the open sky. A point
  reads level 0, then each coarser level for what it left (a smooth step of its weight to 0.25); none: the flat term.
- 2026-11-15 (46e.6b, default chosen, owner to confirm): every lit draw on a page the volume lights reads it (voxel
  surfaces, kit pieces, props, moving objects; `VOLUME_READ_KEY = false` opts out, the far field's shade does), as the
  live probes are read by every lit draw for the cache.
- 2026-11-15 (46e.6b, default chosen, owner to confirm): the volume's pool is made once at 16,384 slots (29.8 MB, of the
  160 MiB budget), not grown by copy (a swapped texture left older draws reading the old one: D691, D696); bricks past
  it wait for a freed slot. A timestamp reading past twice the least of the last 16 is taken at that (pacing).
- 2026-11-15 (46e.6b, default chosen, owner to confirm): the volume's GPU pass is present for the measurement while the
  volume exists (as the cache's), so settled cameras read it below resolution and the moving orbit reads its update.
- 2026-11-15 (46e.6b): a face's rays over its updates are consecutive points of its sequence (the brick's own count); the
  defaults stay 4 rays a face, 8 updates, 24 m (no tuning: D692 named). The Play e2e's hut steps: the plaster-floor
  picture is the open roof's (one edit and settle fewer); its timeout stays 240 s.

- 2026-11-16 (46e.7, default chosen, owner to confirm): the hybrid keeps the cache's live probes near the eye (its
  texels lit for their bounce only) and the volume past the hand-over; voxel surfaces do not read the cache's texels
  there: with both reads a voxel surface's program samples more than the Iris Xe's 16 fragment textures and is drawn by
  the guard's plain fallback (D699). Lamps stay per pixel in both zones.
- 2026-11-16 (46e.7, default chosen, owner to confirm): the hand-over distance is a lighting tier field,
  `voxelLightHandoverM` (low 12 m: the cache's finest level's reach, and cheaper than 24 m on the orbit's page
  `lighting` and at every camera's `near`; medium and high 24 m, unmeasured on target hardware), the fade a quarter of
  it, measured across (x, z) from the eye; the cache lists chunks within 1.25 d, the volume keeps no brick wholly within
  0.75 d − 2 m. `?voxelLightHandover=<m>` for benches.
- 2026-11-16 (46e.7, default chosen, owner to confirm): with both stores on, each store's update takes half the tier's
  GPU `lighting` row (the row is the lighting budget, not one store's); no new constant: the share is one over the
  stores on.
- 2026-11-16 (46e.7): the GPU measurement can hold a pass by name (`gpuPassHides.hold`; `__tlVoxelPlay.light.holdPass`,
  `headroom --hold`), so the hybrid's `lighting` is read a store at a time; the ballast line's whole-frame GPU ms is not
  used in the A/B (it swung −1 … 18 ms at a still camera, §8b).
- 2026-11-16 (46e.8, default chosen, owner to confirm): at speed the near sun window is held: the page reads the
  camera's ground speed against the streamer's own two values (held past `STREAM_DETAIL_SPEED`, let go once slower for
  `STREAM_STOPPED_MS`) rather than the streamer sending its state to the page. Meanwhile, past the key light's map,
  near surfaces take the far window's 4 m lines; after a stop the 0.5 m lines return over about 1–2 s (unverified to
  the eye).
- 2026-11-16 (46e.8, default chosen, owner to confirm): the sun field does one piece a frame whatever the slice says
  (the march's row, or a tile in its place when the last frame composed none), so neither the lines nor the tops wait
  behind the other; its worst frame is about one row's dispatch (~2 ms of page at low, over the 1.0 ms slice: D675).
- 2026-11-16 (46e.8): the travel A/B's base ran with the profiler's measurement fix (d2cc91a3, `page-profile.ts`
  only) applied to 2ff4af22, so its spikes are counted by the rule the heads use; the bench was the head's for all.

- 2026-11-16 — **46e-a review (independent, a fresh agent that built none of it; `~/.cache/thirdlight-phase46e/review-46e-a.md`).**
  Verdict: **close after fixes.** The scope fence held (no 46e-b work, no stored light, no stored format; the only
  touch to retiring code is one export line in the shared worker barrel; phase 42's stack extended, not retired); no
  spec sentence changed beyond the approved derived-outputs entry; ratchets only shrank; no history comments. Its
  spot-checks of §8b against the raw files all matched (orbit room, `lighting`, page `lighting`, settled `near`,
  edit times, all eight travel rows, the D693 readings), and the five sheets match their descriptions. Must-fix and
  what was done: (1) `DERIVED_FORMAT_VERSION` still 31 in code against the approved 32: set (36ef2a17; nothing stored
  keys on it). (2) results the D698 fix disproved still read as findings: each marked invalid. (3) §8b stale on
  D694: the travel row measured again for all four arrangements after the fix. (4) D699 without evidence: counted
  (the voxel surface program samples 11 textures with no store, 15 with the cache, 13 with the volume, 17 of the
  Iris Xe's 16 with both reads) and the white fallback pictured; the smallest fit named, not built. Logged as rows:
  the volume's bare constants (D702), default-path memory without a budget entry (D703), the hybrid's lighting miss
  (D704), the volume's read cost (D705), the hybrid's unexplained `near` (D706), a third copy of the walk's
  addressing in WGSL (D707), the volume's unsliced batch work (D708), WebGL 2 voxel shadows never pictured (D709);
  D692 back to open, D688 to watch. The reviewer's "white shape at the far view's top left" is the sky above the
  ridge (lead looked): no row. **Tests the review judged weak (logged, not fixed in this phase):** the hybrid's fade
  check passes with the fade stubbed (it proves residency and darkness, not the hand-over); the cache's caster-mark
  check passes without the marks (lit wall and pillar share a chunk); the volume's tint bound is +2 % and the cache
  has no colour-bounce check (D682); the "broken variant" runs were done once by hand and are not repeatable; the Play
  test sits at its timeout. Not checked by the review: the four largest new files line by line, the raw files of
  46e.0–46e.6 and 46e.8, anything run.
- 2026-11-16 (lead, default chosen, owner to confirm): every lighting store stays **off** by default until the
  owner's choice; voxel shadows and the sun field are on at every tier.
- 2026-11-16 (lead): recommendation at the stop, by "performance first": **the volume** (the only store that keeps
  the cap on a moving eye: 76 [60–88] copies of room against none for the cache and the hybrid; least memory;
  fastest after an edit; travel like no store), its per-pixel read (+3.2 to +5.3 ms of `near` standing still, D705)
  and its update's pacing (D690) the first work of 46e-b. The acceptance page and its five questions:
  `docs/briefs/acceptance-46e-a.md`.
- 2026-11-16 (lead): 46e.5 and 46e.6 were each run as slices (5a tile source, tracer kind, direct light, read; 5b
  probes and readers; 5c the port's wiring costs and the column; 6a store, update, read; 6b coarse levels, readers,
  wiring costs, the column), 46e.4 as a (near shadows) and b (far shade, sun field); the fair-depth contract both
  stores were held to is in the agent brief's 46e-a section and each slice's brief.


- 2026-11-16 (OWNER, answers at the 46e-a stop): (1) the store is **the voxel light volume**; (2) the cache's
  voxel port (charts, face hashes, chart worker) and the hybrid switch are removed first in 46e-b, phase 42's own
  stack still retires in 48; (3) the hybrid with the cache's texels near is not measured; (4) **no tuning first**:
  the order is remove → every light type in the volume (a per-brick lamp list in world space built in compute,
  spot lights with their cone, area lights' bounce, emissive materials) → the observed defects fixed on the update
  side (D692, dark rooms, D695, D696, D690) → only then the tuning (the read's cost D705, the update's share, the
  low tier's setting), on the town and on a many-lamps scene added before it, the low tier at 720p and the 30 Hz
  cap; (5) shadows and the sun field stay on at every tier; D667, D675 and D701 are fixed, D672 and the round with
  7 copies of room are traced. Emissive: "the glow is a property of the voxel's material, not stored per voxel. The
  volume keeps it per cell the way it keeps the bounce colour. Propose the add-only material format entry for my
  approval before building it." Not in scope: a compute build of the clustered light lists; baking the volume to
  disk.
- 2026-11-16 (lead, default chosen, owner to confirm): where the owner's order is silent — the default-path work
  (answer 5) runs as 46e.10, straight after the removal and before the light types, so later lighting figures are
  taken on a settled base; the emissive proposal (46e.11) is written before 46e.12 starts so the approval does not
  hold the other light types; props through the coverage channel and particles (46e.15) come after the tuning;
  rooms, culling and the walk graph keep their place after the lighting work.

- 2026-11-16 (OWNER): 46e-b's item list and order (§6) approved as shown, the lead's placements included (the
  default-path work as 46e.10, the emissive proposal before 46e.12, props and particles after the tuning). 46e-b
  starts in a fresh session from `docs/briefs/handoff-46e-b.md`. Added there by the lead (default chosen, owner to
  confirm): a moving-sun measurement in 46e.14, the many-lamps scene at about 32, 128 and 512 lights, an interim
  look page after 46e.14 without stopping, and no tuning without emissive (46e.15–46e.18 run first if the owner's
  note on 46e.11 is late).

- 2026-11-16 (46e.9, default chosen, owner to confirm): `?voxelLight=` with any value but `off` or `volume` (the removed
  `cache` and `hybrid` among them) draws as `off`, not an error; the export no longer ships the view's worker bundle
  for a game with voxel worlds only (it was added for the chart worker alone); D699 and D700 stay open, narrowed to
  what survives the removal, rather than closed with the rest (the sticky fallback and the missing volume row are
  the volume's and the guard's, not the hybrid's).

- 2026-11-16 (lead, 46e.11, proposed for the owner's note): the emissive entry adds no stored field. A material
  record already carries a glow colour and strength (`params.emissive`, `params.emissiveIntensity`, 0–16) that
  meshes draw and voxel surfaces ignore; the step proposed is that the voxel surface draws them and the volume keeps
  the mean glow of the faces a cell borders (one more word a cell) and adds it to what a ray sees at a hit. Defaults
  proposed with it: reuse the two fields (not a separate `voxel.glow`), no glow mask texture, no glow in the brick
  far field. The page: `docs/briefs/proposal-46e.11-emissive.md` (acc46e-11). The spec text goes into
  `voxel-render-spec.md` §1 with the owner's note, not before.
- 2026-11-16 (lead): 46e.9 verified: phase 42's files compared with 2ff4af22 by the lead (18 identical; the three
  that differ keep 46e.1's measurement hide and the volume's place in the light order), gate
  `gate-rerun-20261116-193012` green, the leak test in `gate-area-20261116-193623`, the room picture with the volume
  looked at (`46e.9/shots-volume/room-window.png`: 46e-a's look, blotches and all). The leak test runs only with the
  `area` or `phase` modes: an item that adds an adapter-lifetime resource runs `gate.sh start area play`.

## 10. Open questions for the owner (asked with the plan)

1. The two parts with a stop at the lighting choice. **Owner 2026-11-14: yes.**
2. The A/B on different scenes. **Owner 2026-11-14: no; both on voxels, same scene, and the hybrid (§9).**
3. The add-only spec entry for the derived region outputs (§8). **Owner 2026-11-14: approved** ("Yes I approve of
   the spec change for the proposed testing of lighting voxels in this phase").

### At the 46e-a stop (2026-11-16): five questions, each with the default that stands if unanswered

The page with pictures and the table: `docs/briefs/acceptance-46e-a.md` (published as acc46e-a). **Owner 2026-11-16: answered** — 1 the volume; 2 remove, first in 46e-b; 3 no; 4 changed: no tuning first, the order of §6's 46e-b table; 5 keep on, fix D667, D675, D701, trace D672 and the 7-copy round (§9).

1. **Which lighting store?** Default: the voxel light volume, switched on per tier in 46e-b.
2. **The other one.** Default: the voxel port of the cache (charts, face hashes, chart worker) and the hybrid switch
   are removed at the start of 46e-b; phase 42's own stack retires in 48 as planned.
3. **The owner's hybrid measured for real** (cache texels near; needs both reads fitted into 16 textures)? Default:
   no.
4. **First work of 46e-b.** Default: cut the volume's per-pixel read and pace its update inside the lighting budget,
   a cheaper read as the low tier's setting if it still does not fit.
5. **The default path's cost** (shadows and the sun field on: GPU +0.5–0.6 ms, page about +1 ms, about 90 MB,
   more missed frames at 150 m/s). Default: keep them on at every tier; D667, D675, D701 fixed in 46e-b's first item.
