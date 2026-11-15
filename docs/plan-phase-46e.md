# Phase 46e — Lighting, regions and the walk graph

Status: **46e: planned 2026-11-14, not started** on branch `phase-45` (worktree `~/projects/thirdlight-p45`, base
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
| 46e.1 | **GPU time per pass in the profiler (D655).** The meter's hide-a-pass measurement callable from the page: an on-demand "Measure GPU" in the Profiler tab, the overlay and `tl_diagnostics`, filling the GPU budget rows per category (near, far, shadows, lighting, post, effects); the bench reads the same routine. |
| 46e.2 | **One occupancy walk.** A 6-connected walk (R99) over level-0 cells, skipping empty space by the chunk tree's flags and continuing into far bricks; one definition for the CPU and the GPU; partial cells by light coverage; `ctx.voxels.raycast`; the editor's voxel picking through it. Measured: rays a millisecond on both. |
| 46e.3 | **Open regions.** Connected non-solid cells labelled per chunk in the derive workers and stitched across chunk faces as chunks arrive: face connectivity (R97), sky columns (R98), regions with an enclosed flag, volume and portals from the opening role (R101); rebuilt for one chunk on an edit; `ctx.voxels.regionAt`; a tint overlay to see them. A derived output: an add-only note in the format spec (§8, owner). |
| 46e.4 | **Direct light.** Voxel surfaces and kit pieces cast and receive sun shadows in Play through the cached static map plus the dynamic map, and local-light shadows through the atlas; an edit refreshes what it touched; the far shade lit at the hit (D607); a far sun shadow by a short march through distance bricks, kept only on the tiers that afford it. |
| 46e.5 | **The surface cache on voxels.** Phase 42's cache fed by voxel surfaces: a voxel tile source (charts over the mesher's faces by their main axis, as block chunk columns and terrain rings are charted today), the tracer walking voxel occupancy as a scene kind (46e.2's walk), direct light and live probes over it, edits marking tiles stale. A candidate, built only as far as a fair measurement needs. |
| 46e.6 | **The voxel light volume.** R104's volume on the same town: air-side cells beside surfaces with six directional values, the 1/2/4 m levels for open air, sky and sun by the walk, one bounce, local lights; read by voxel surfaces, kit pieces and moving objects. A candidate, to the same depth. |
| 46e.7 | **The lighting storage A/B (R110), same scene, same cameras.** Three arrangements on the town inside the 8 km world: the cache alone, the volume alone, and the cache near with the volume beyond a distance (the owner's hybrid, the hand-over distance a setting); §4's table and pictures for each, on the low tier at the cap, with medium and high as shares. |
| 46e.8 | Close of 46e-a: the gate, the independent review, fixes, results, an acceptance page (pictures of the three side by side, at most five questions, the lead's recommendation by "performance first"), STATUS. **Stop for the owner.** |

### 46e-b (outline; made final after the owner's choice)

| Item | Builds |
|---|---|
| 46e.9 | The chosen storage built out: tiers and budgets, updates after edits, props through the coverage channel (D448), moving objects and particles reading the same light, the old path it replaces switched off for voxel worlds. |
| 46e.10 | Rooms from regions: light kept indoors, cut-away and see-through "enclosed air", a room size for audio. |
| 46e.11 | Connectivity culling measured against the depth pyramid on the town's interiors and the caves; built only if it wins. |
| 46e.12 | The walk graph (R100) on a generic A* core; `ctx.voxels` path and reach queries; the path-finding span in the profiler. |
| 46e.13 | Close: gate, review, acceptance page, STATUS, the design page. A saved light bake for the low tier is a format proposal (O19) and a hard stop if the measurements ask for it. |

## 7. Progress

| Item | Status |
|---|---|
| 46e.0 | Done 2026-11-14 (bec4c31d, d2cc91a3): three.js 0.187.0 = pin; five lighting cameras + `run.mjs light-shots` (cave dug, lamps, two looks; refuses unsettled or voxel-less shots); baseline §4a: room 23.1 ms, page 4.1–4.6 / sim 1.8–2.0 ms, lighting 0.05 of 2.0 ms, edit to screen 22–53 ms (no light responds); D654 traced, profiler spike fixes, cause open |
| 46e.1 | Done 2026-11-14 (1129d456…16e5e566): Measure GPU (Profiler, overlay, `tl_diagnostics` gpu/gpuMeasure, benches) — ballast past the cap, a category hidden between two shown windows, GPU completion times burst to burst, 5 repeats; low town near 1.61, far 3.49, shadows 0.09 ms, run-to-run ≤ 0.45 ms (§4b); D660 near's hide, D661 post's |
| 46e.2 | Done 2026-11-14 (f17f4a48…): one 6-connected walk (CPU; WGSL from the same steps) over level 0 and mips (the CPU also far nodes; the GPU not: D662); `ctx.voxels.raycast`; picks walk it; GPU = CPU 0 of 1,200 differ; rays/ms worker 360–430 / 170–215 / 19–20, GPU 28k / 17k / 1.6k (short, medium, long; §8a); D662–D664 |
| 46e.3 | Done 2026-11-15 (531a2d5b, 5bf24807): open regions derived per section (v32, spec entry), stitched where the world runs, `ctx.voxels.regionAt`, voxel page overlay, sky heights to the page; town 120 enclosed / 3,181 portals; derive 7 % of a section; stitch 1.4 ms/frame loading, 0 settled; edit → answer 91 ms; 150 m/s sim spikes 1 → 14 (D667); D665–D669 |
| 46e.4 | a done 2026-11-15 (cd2ce0ac): near-field voxel surfaces and kit pieces cast and receive via the cached sun map, the dynamic map and the atlas; edits redraw only what they reach; sun square on the voxel ground; low shadows 0.21–0.47 vs off below resolution; edit → shadow 63–87 ms; D670–D672. b next (far shade at the hit, far sun march) |
| 46e.5 | not started |
| 46e.6 | not started |
| 46e.7 | not started |
| 46e.8 | not started |

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

## 10. Open questions for the owner (asked with the plan)

1. The two parts with a stop at the lighting choice. **Owner 2026-11-14: yes.**
2. The A/B on different scenes. **Owner 2026-11-14: no; both on voxels, same scene, and the hybrid (§9).**
3. The add-only spec entry for the derived region outputs (§8). **Owner 2026-11-14: approved** ("Yes I approve of
   the spec change for the proposed testing of lighting voxels in this phase").
