# Phase 46f — Shared foundations

Status: **46f started 2026-11-13** (46f.0 baseline done) on branch `phase-45` (worktree `~/projects/thirdlight-p45`, base
dea68d37; main frozen at d4053cab). Planned from the owner's decisions of 2026-11-10 to 11-12
(`docs/decisions/owner-decisions.md`), `docs/research/duplication-audit.md` and
`docs/architecture/voxel-engine.md` §6. It comes before 46e (lighting): 46e's choice is made by GPU time, and
water, fog, vegetation and lighting all sit on what this phase builds.

## 1. Scope

Four foundations and a set of cheap merges; no new feature a player or designer would see beyond the profiler.

- **In:** a frame profiler with one budget table and one frame arbiter; a camera-following window helper and
  the interaction field; trees and ground cover in the culled-instance table; one undo for scene and voxels;
  the cheap merges of §6 (46f.5).
- **Out, with the phase that takes it:** derived fields, the world edit mode, the fill, the fog role, dressing
  rules (47b); open-region labelling, the grid walk, lighting (46e); regenerated structures and water bodies
  (47a); far-node channels (49); `VolumeShape`, one texture-set type, `setRecord`, form fields, the key-scope
  stack (with 47b and 51, when those files are open anyway); anything inside block layers, heightfield terrain
  or generated architecture (retired in 48).
- **Carried from 46d-c, not in scope unless an item touches them:** D594 (run-time edits do not reach the far
  field), D620 (full detail after a 150 m/s stop), D621 (a body under the coarse floor waits), D634 (hole
  frames at medium with fine bricks on), D644 (a full far-cache rebuild drops baked fine levels).

## 2. Owner requirements (quoted; REQUIREMENTS, never silently dropped)

- 2026-11-12: "I like the idea of having a very solid foundation that things are shared upon … make sure we are
  not duplicating work for different purposes."
- 2026-11-12: "yes, a single undo path for both the scene and voxels".
- 2026-11-11 (the profiler): "a dedicated frame time profiler that we build into the engine. I feel like that
  would be helpful like the unity profiler."
- 2026-11-11 (the budget): the frame budget table must cover "items, props, characters, gpu compute particle
  effects, lighting … game logic, path finding, and everything else we will have running on the main thread".
- 2026-11-12 (interaction): ground fog "should be interactible with the character … tie it like how we do
  vegetation bending for entities moving" — one mechanism for foliage, fog and water.
- 2026-11-10: WebGPU first; the low tier at 720p upscaled, capped at 30 Hz, is the target on the Iris Xe;
  measure at the cap, never uncapped; medium and high are unverified on this host.
- 2026-11-11: hobby pace: the quick, reversible route; gates by affected area.
- 2026-11-12: no steering mid-phase: a new idea goes to the decisions register and waits for the phase
  boundary unless something is broken.

## 3. three.js check

Done 2026-11-13 (46f.0): `npm view three version` gave 0.187.0, equal to the pin; nothing to assess. No update
without the owner.

## 4. Baseline (46f.0, before any change)

Low tier, WebGPU, 1280 × 720 at the 30 Hz cap, the 8 km world and the village class: the headroom meter's room
and pass shares; the coverage bench's hitches and settle at 60 and 150 m/s; the page-thread and
simulation-worker CPU a frame as far as today's stats give them (the gap the profiler closes); a scene with
stored trees and ground cover (the phase 40 meadow class) for 46f.3: draws, triangles, frame room. Fast gate
time and the per-area times.

**Measured** 2026-11-13 14:54–15:31 UTC at 3fcd896d (product code as at dea68d37; dist built after the last
package commit), Iris Xe, each run alone (no gate, build or other agent; `thirdlight-gate` inactive), uptime
20.9 d, load 1-min 0.5–3.2; every run in a `MemoryMax=10G` scope with `TMPDIR` on disk. Staging's 8 km world
(`voxel-slice`, world `far`) as it stands: bake level 2 m (the default), fine bricks off. Raw outputs and an
`*.uptime` beside each: `~/.cache/thirdlight-phase46f/work/46f.0/`. `<capped>` = the brief's scope prefix.

| What | Numbers | Reproduce |
|---|---|---|
| Headroom, low 30 Hz, 8 km world town orbit (2 rounds) | room 176 ballast × 0.127–0.131 ms = 22.4–23.1 ms of 33.3; no load 0/89 missed; frame GPU from the edge 8.2–11.0 ms (line 5.6–7.8: they disagree, quote ms past the edge); hidden near 3.44–5.02 ms, far 5.06–5.89, shadows −0.69–2.67, post 1.69–2.48 (shares of the four: near 31–33 %, far 39–46 %, shadows 0–17 %, post 11–23 %); page heap 569 / GPU 863 MiB | staging up; `<capped> node tools/voxel-bench/run.mjs headroom --quality low --rounds 2` (`headroom-low.*`) |
| Headroom, medium 60 Hz (1 round, unverified on target hardware) | room 64 × 0.129 = 8.3 ms; hidden near 0.77, far 1.98, shadows 0.57, post −3.5 ms (noise): near 23 %, far 60 %, shadows 17 % | same, `--quality medium --rounds 1 --scales none` |
| Headroom, high 60 Hz (1 round, unverified on target hardware) | misses at no load (15/169, mean 17.7 ms; frame GPU from the line 17.6 ms); hidden near 7.41, far 6.77, shadows 0.78, post −1.38 ms: near 50 %, far 45 %, shadows 5 % | same, `--quality high` |
| Coverage, low 30 Hz, export, 9.84 km line 30 m up, 60 m/s (2 rounds) | longest 49.2 / 53.5 ms, 0 frames > 100 ms, missed 1.1 / 1.8 a min; ground solid 0.03 s, body stands 0.25 s; full detail 4.6 / 4.0 s, nothing pending 8.0 / 7.0 s; through the true ground 0 of 83 (1 onto lower ground a run, as 46d.24); 0 hole frames | staging up: `<capped> … coverage --export --quality low`; staging stopped: `<capped> … coverage --dir <export> --quality low --speed 60` (`cov-low-60-r*`) |
| Coverage, same, 150 m/s (2 rounds) | longest 42.5 / 44.1 ms, 0 > 100 ms, missed 1.8 / 0.9 a min; ground solid 0.03 s; full detail 4.7 / 4.5 s, nothing pending 8.4 / 7.9 s; falls 0 of 34; 0 holes | `--speed 150` (`cov-low-150-r*`) |
| Page-thread CPU a frame (village class, below) | traced 4.54 ms task / 4.83 ms CPU a frame; busy: main 274 ms/s traced, all workers together 59.8 ms/s (≈ 2.0 ms a frame at 30 fps), GPU process 176 ms/s | `village … --busy 5000` (below) |
| Cover: meadow class (phase 40; 1 km² heightfield, grass cover 8 /m² to 60 m, no stored copies), low, `frameRateCap=30` | page 1920 × 1080, scene at 1280 × 720 (TAAU); grass: p95 33.4 ms, 0 missed, 10 draws (scene 6), 977 k tris, main 1.51 ms (CPU 1.76); ground alone: 5 draws (scene 1), 47 k tris, main 1.42 ms. Frame room: not measurable (the headroom meter loads only voxel pages; GPU timestamps unusable at the cap, D544) | `<capped> node tools/perf/run.mjs meadow --renderers webgpu --no-sweep --query 'quality=low&frameRateCap=30'` (no `--viewport` in this bench; its camera is the class's own) |
| Cover: meadow class at its phase 40 setting (60 Hz cap, project quality) | grass: p95 16.7, 0 missed, 25 draws (scene 6), 977 k tris, main 2.19 ms (CPU 2.38); ground alone 20 draws, 47 k tris, main 1.95 ms | same without `--query` |
| Stored copies: village class export, low, 1280 × 720, `frameRateCap=30` | p95 33.4 ms, 0 missed; 242 draws (scene 218, shadow 21), 292 k tris, 900 instance copies drawn (copies-gpu path), 168 merged cells; main 4.54 ms (CPU 4.83). Frame room: not measurable (as the meadow) | `<capped> node tools/perf/run.mjs village --renderers webgpu --vsync --no-bare --viewport 1280x720 --query 'quality=low&frameRateCap=30' --busy 5000` |
| Fast gate (last green, voxel change, gate-fast-20261113-030759) | 14 min: build 46 s, lint 132 s, vitest related 486 s, e2e 2.5 min (core 29 s, voxel 158 s, rendering/webgl2 smoke 27 s), village perf 29 s (60 Hz 1080p: 0/361 missed, main 5.93 ms vs baseline 5.64) | `~/.cache/thirdlight-logs/gate-fast-20261113-030759/summary.txt` |
| 46d-c phase gate | 28 min (vs 23 for 46d-b) + 1 min rerun green: vitest 490 s; e2e 17.3 min: core 30, startup 7, voxel 189, rendering 395, materials 320, lighting 180, environment 137, effects 64, levels 415, editor-ui 318, scenes 141, content 228, play 318, mcp 118, physics 141, audio 53, input 71, scripting 150, animation 59 s | `gate-phase-20261113-062934`, `gate-rerun-20261113-065936` |

**What today's stats give, and the gap 46f.1 closes.** On the page: `ctx.stats` / the F3 overlay (`frame-stats.ts`)
give frame time, the page thread's work a frame (`cpuMs`, avg and worst over 0.5 s: host work and draw submission,
plus the simulation's steps only when it runs on the page), GPU ms only with timestamps (null or meaningless at the
cap), draws, triangles, texture and geometry bytes; no bench records `cpuMs` on a voxel world (the voxel benches
read `__tlVoxelPlay.stats()` counts and the meter's per-copy CPU only). The perf harness traces the page thread
and all workers summed (`--busy`), on the perf classes only. The **simulation worker** has no timing at all
(`sim-worker.ts` measures nothing a step); the voxel job workers keep per-job queue and run times
(`worker-pool.ts` rings) but no per-frame sum; `perf-marks.ts` marks are events, not spans. Unverified, for that
reason: page-thread CPU a frame on the 8 km world, and simulation-worker CPU a frame anywhere.

**For 46f.3:** neither perf class has stored trees and cover together, and neither can be loaded by the headroom
meter (`__tlVoxelPlay.meter` exists only on voxel pages): re-measure both rows above with the same commands, same
hour, before and after; compare draws, triangles, main-thread ms and missed frames, not room.

## 5. Where things live (reuse first; never copy)

| Thing | Home | Reuse |
|---|---|---|
| Budget table per quality tier | `project-model` (`quality-levels.ts`) | the existing tier records; the 13 time-slice constants become entries |
| Spans, frame ring, arbiter | `runtime` (simulation side), `three-adapter` (page side), `@thirdlight/shared` for the span type | `engine-stats.ts`, `frame-stats.ts`, `perf-marks.ts`, `gpu-timing.ts`, `gpu-headroom.ts`, the `voxel-batch-stage` share model |
| Profiler panel and overlay | `editor`, `game-host` | `stats-overlay.ts`; `tl_diagnostics` for MCP |
| Window helper, interaction field, wind sampler | `three-adapter` | `wind-field.ts` (the pattern), `foliage-bend.ts` (replaced), the see-through subject list |
| Interactor component | `project-model` (schema, upgrade step renaming `foliageBend`), `commands` | component descriptors |
| Culled rows for copies and cover | `three-adapter` | `occlusion-instances.ts`, `attribute-instancing.ts`, `view-cull.ts`, `dither-fade.ts`; `copies-gpu.ts` and `cover-gpu.ts` are the ones moved |
| Level helper (screen size → level, hysteresis) | `@thirdlight/shared` | replaces the per-system copies as each is touched; voxel rings stay |
| Undo dispatch | `workspace` / `backend` (one user-facing undo, redo), `commands` | project `history.ts`, the voxel `UndoStore` |
| Job kinds on the voxel pool | `voxel` (`worker-pool.ts`, `job-queue.ts`) | cover, scatter and decal-clip workers become kinds |
| Region texture helper, buffer grow | `three-adapter` | `VoxelShaderGrids`, `tracer-gpu.ts` |
| Test support | `tests/support` | `tests/e2e/backend.ts`; names added to `tools/check-redefinitions.mjs` |

## 6. Items

| Item | Builds |
|---|---|
| 46f.0 | The three.js check (§3) and the baseline (§4), before any change. |
| 46f.1 | **Profiler, budget table, frame arbiter.** Named CPU spans on the page thread, the simulation worker and the job workers (a ring of recent frames each; workers post theirs with the tick); GPU pass shares, with the headroom meter called on demand for real room (D544: timestamps are not usable at the cap); counters (draws, triangles, instances, GPU and page memory, queues); one budget table per tier; the per-frame time-slice constants draw from one arbiter; spike capture (the long frame and what every thread was doing); an editor panel with a timeline and a frame breakdown, a Play/export overlay off by default, a capture file, a read through `tl_diagnostics`. May split a (spans, table, arbiter) / b (panel, overlay, MCP). |
| 46f.2 | **Window helper and the interaction field.** The helper generalised from `wind-field.ts`; the wind sampler public and read by GPU effects; a 256² field at 0.25 m (about 1 MB) that any entity with an interactor component stamps into (velocity in m/s, pressed amount, stamp foot height, top height), decayed and scrolled each frame; it replaces `foliage-bend.ts`'s four subjects in uniforms; foliage reads it (same bend look, any number of entities); fog and water read it later. Visual only: scripts do not read it. |
| 46f.3 | **Trees and ground cover into the culled-instance table.** `copies-gpu.ts` and `cover-gpu.ts` become rows of `occlusion-instances.ts` with level and thinning rank chosen in compute; one screen-size → level helper; `view-cull.ts` the one in-view ordering; `dither-fade.ts` for level changes; shadows keep the near-ring rule. Measured against §4's meadow class before and after. |
| 46f.4 | **One undo.** One user-facing undo and redo that dispatches to the project history or the voxel undo store by the last edit, in the editor and over MCP; redo for voxel edits; `expectedRevision` on voxel ops if it is cheap. |
| 46f.5 | **Cheap merges.** Cover, scatter and decal-clip workers as job kinds of the voxel `WorkerPool`; one region-texture helper (partial upload, grow by copy) and one buffer grow; one memory budget table and a resident-bytes report; `tests/support` replacing the `serveDir` copies and per-spec command helpers, guarded by the redefinition check; one `QUERY_OPS` list; pointer → ray through `SceneQueries`; stale headers (`store-v4.ts`, `project-v4.ts`, `play-content.ts`). May split by package. |
| 46f.6 | Close: the phase gate, the independent review, results, STATUS, the design page's §6 states. |

## 7. Progress

| Item | Status |
|---|---|
| 46f.0 | Done 2026-11-13: three 0.187.0 = pin. Baseline §4 (low 30 Hz, 720p, alone): 8 km world room 22.4–23.1 ms, far 39–46 % / near 31–33 %; 150 m/s longest 42–44 ms, 0 > 100 ms, detail 4.5–4.7 s; meadow 977 k tris 10 draws; village 242 draws, main 4.5 ms. Sim-worker CPU unmeasured (no timing). Last fast gate 14 min. |
| 46f.1 | Done 2026-11-13. a: spans on every thread, `__tlProfiler.read()`, budget table per tier, 10 slices from one arbiter. b: editor Profiler tab (timeline, frame breakdown, budget, counters, spikes, captures), overlay Shift+F3, capture file v1, `tl_diagnostics` profile digest. 150 m/s A/B: HEAD 43.9–50.5 ms inside base 42.0–53.9; spike settle fixed. |
| 46f.2 | Done 2026-11-13: `camera-window.ts` (wind rebuilt on it), wind sample public, `interactor` (schema 8 step from `foliageBend`), interaction field 256² × 0.25 m (one compute pass, any number of stamps) read by foliage; WebGL 2 no bend. E2e: 8 objects bend, recover, export. Meadow low 30 Hz: page +0.03–0.14 ms, pass 0.1 (1) / 0.8 ms (8) at ~520 MHz. |
| 46f.3 | Done 2026-11-14: stored copies (a) and point-set ground cover (b) are culled-table rows on WebGPU (level + hysteresis + fade, thinning, frustum, pyramid in compute); one level helper. b, walking slab A/B: GPU frame 6.0→3.6 ms at full clock, page +0.15 ms; meadow (terrain texel cover) unchanged. WebGL 2 keeps vertex paths; texel cover retires in 48. |
| 46f.4 | Done 2026-11-14: one undo line per project in the backend (workspace `undo-timeline.ts`): `undo`/`redo` step scene entries and voxel strokes in order, redo across kinds cleared by any new edit; voxel redo (exact bytes); gone strokes skipped and named; optional world `expectedRevision`; `undoVoxels` removed (bench Z = one undo). |
| 46f.5 | a done 2026-11-14 (slices 1–2): one buffer grow (shared `grownCapacity`/`grownArray`, `grownGpuBuffer`), one region-texture helper (4 upload copies, 2 grows, 4 version rules); `MEMORY_BUDGET_BY_TIER` (10 entries) + resident-bytes report (Profiler Memory table). Slice 3 (job kinds) left: not cheap (decision log). D649 open (hidden). b pending. |
| 46f.6 | not started |

## 8. Results

(Each item's built / tested / measured / looked-at goes here, or in `docs/results-phase-46f.md` if this file
passes about 1,000 lines.)

### 46f.1a — the profiler's data side (spans, budget table, arbiter)

**Built.** `@thirdlight/shared` `profiler.ts`: `SpanRecorder` (names registered once as ids; nested spans with own
time; 14 categories from the owner's list; a ring of 120 frames × 128 spans in typed arrays; `pack`/`ingest` move
closed frames between threads in one Float64Array; `lap` for a sequence of stages) and `threadProfiler`, one per
thread. `frame-arbiter.ts`: `FrameArbiter` / `frameSliceMs(id)`, slices as a share of the frame interval or fixed
ms. `project-model` `quality-levels.ts`: `FRAME_BUDGET_BY_TIER` (per tier: target Hz, interval, shares per category
for the page, the simulation, one job worker and the GPU, and the arbiter's slices); engine constants, no format
field. Spans recorded: the runtime's step (scene loads, voxel streaming, scripts, gameplay blocks, physics,
timelines, camera, sounds, animation; `runtime/src/step-spans.ts`), the host's frame stages, the adapter's stages
(scene sync, effects, animation poses, texture streaming, decals, level views, surface light, copies and cover,
lights, materials, culling, batches, draw submit), the voxel draws made and grids uploaded, far selection, and every
answered pool job (its worker's own time, on the job workers' lane by worker index). The simulation worker packs
its frames onto the `frame` message it already sends for each tick (`profile`, `queues`). `game-host`
`page-profile.ts`: `pageProfile.read()` → `ProfileReport` (threads page/sim/jobs; per-frame draw calls, triangles,
heap; the stats window; instances, GPU resources, voxel counters, pool queues; GPU pass shares (render vs compute,
never ms) and where room comes from; the tier's budget rows with mean/worst use; the arbiter's slices; spikes; the
profiler's own cost). Reached as `window.__tlProfiler.read()` on every game page (Play and export) and
`GameHost.profile()`; `profileSummary()` for benches (headroom bench, perf harness, village run print it).

**Moved to the arbiter** (defaults = the old values at 30 and 60 Hz): `VOXEL_BATCH_FRAME_SHARE` (0.25 of the
interval), `FAR_SELECT_SLICE_MS` (2), the streamer's derive aprons (2; used by `stream-sections`, `stream-mips`,
`stream-collision`, `stream-pieces`) and edit derives (8), `COLLISION_ADD_MS_PER_UPDATE` (4), `MERGE_BACKGROUND_BUDGET_MS`
(4), `PAGE_CLIP_BUDGET_MS` (4), `SURFACE_PREPARE_MS` (1; also the budget `tracer-terrain-rings` is called with) and
`PROBE_PLACE_SHARE_MS` (1), `SCENE_PREP_BUDGET_MS` (4). **Left:** `block-layers.ts` (`SYNC_MESH_BUDGET_MS`,
`MESH_APPLY_BUDGET_MS`) and `terrain-view.ts` (`TERRAIN_UPLOAD_BUDGET_MS`, `TERRAIN_MACRO_BUDGET_MS`): block layers
and heightfield terrain retire in 48 (scope fence).

**Tested.** vitest: `shared/src/profiler.test.ts` (nesting and own time, ring and dropped spans, job lane, pack →
ingest equal, laps and a throw's open span, no buffer growth over 10 000 frames; the arbiter reproduces every moved
value at 30 and 60 Hz); `project-model/src/quality-levels.test.ts` (each tier's Hz and interval, shares ≤ 1 per
thread, every category planned, slices = defaults); `game-host/src/page-profile.test.ts` (a spike keeps the page,
the worker's tick and a job over its window; spike ring bound; GPU shares not ms; JSON round trip);
`tests/integration/m22-worker/parity.test.ts` (a real worker_threads simulation worker: one frame a tick, in order,
step stages nested, sums = own times; single-thread mode: steps on the page); `tools/voxel-bench/world-host.test.ts`
(real pool workers: `job load` / `job derive` spans by worker, `voxel streaming` in the step, pool queues).
Browser, WebGPU: `voxel-world.e2e.ts` Play (8 km world, worker): page/sim/job spans present, ticks in order, busy
share 0–1 per thread, the stats' draws and triangles among the profile's frames, budget = the high tier at 60 Hz
(about 1 s added to the test).

**Measured** 2026-11-13 16:19–16:37 UTC, each run alone, low tier, WebGPU, 1280 × 720 at the 30 Hz cap, uptime 21.0 d
(raw: `~/.cache/thirdlight-phase46f/work/46f.1a/`, `*.uptime` beside each):

| What | Before (46f.0) | After |
|---|---|---|
| Page-thread CPU a frame, 8 km world town orbit (headroom no load, profile own time, 2 rounds) | unverified (no stat) | 4.46 / 4.01 ms (busy 13.5 / 12.1 %): render 3.5–3.8, props 0.4, voxel draws 0.1–0.2 |
| Simulation-worker CPU a frame, same | unverified (no timing) | 2.07 / 1.82 ms: voxel streaming 1.7–1.9, scripts 0.04–0.06; job workers 0.1–0.2 ms a frame (settled) |
| Village class export (`--busy 5000`), page / sim a frame | trace 4.54 task / 4.83 CPU | profile 3.96 / 0.35 ms; trace 4.69 task / 4.97 CPU (the profile sees 84 % of the traced task time) |
| Headroom, 8 km town, low (2 rounds) | 176 ballast × 0.127–0.131 ms | 176 × 0.126–0.131 ms; no load 1/89, 0/89 missed |
| Coverage 150 m/s, export, low (2 rounds) | longest 42.5 / 44.1 ms, 0 > 100, missed 1.8 / 0.9 a min, detail 4.7 / 4.5 s, pending 8.4 / 7.9 s | longest 48.0 / 49.7 ms, 0 > 100, missed 1.8 / 2.7 a min, detail 4.4 / 5.4 s, pending 9.0 / 8.2 s; falls 0/34, holes 0 |
| The profiler's own cost | — | 480–700 ns a span (measured on the page, 5 000 spans; the page's clock is 0.1 ms coarse), ~25 page spans a frame: ~15 µs a frame; worker ticks ~10 spans a step |

The 150 m/s longest frame read 5 ms higher than the baseline's in both rounds, inside the 60 m/s baseline's
49–53 ms range; no same-hour A/B was run (≤ 2 rounds): not called a regression, not ruled out. In the e2e at the
high tier while the world fills, the worker's voxel streaming took 40–45 ms a tick (D646).


### 46f.1b — the profiler's visible side (panel, overlay, capture, MCP)

**Built.** Editor **Profiler** tab in the bottom dock (`packages/editor/src/ui/profiler/`, `styles/profiler.css`):
a canvas timeline, one column a page frame (the page's 120), lanes page / simulation / job workers (per worker)
stacked by category with one colour each and a legend, the frame interval's dashed line half way up each lane, long
frames ticked red, the GPU as pass shares (never ms); a click picks a frame: its spans per thread as a tree (a tick
under its own row, jobs by worker); Budget (the tier's rows grouped by thread, over-budget rows red, the GPU plan,
the arbiter's slices), Counters, Spikes (Open shows the spike's own frames); Pause/Resume, Save capture, Open
capture (marked as a file). It polls the play page twice a second over the preview bridge (`tl.profile.request` →
`tl.profile.result`, bound 1 MiB; the editor's own poll like the debugger's) with a cursor: `PageProfile.read(after)`
returns only frames and spikes taken in since (`seq` counts by arrival, so a late tick is not missed); frames are
made into objects once each. The views, capture file and digest are game-host `profile-view.ts` /
`profile-capture.ts`, reached by the editor through the `@thirdlight/game-host/profile-view` subpath (boundary rule
in its own commit). Overlay: the F3 stats overlay (`stats-overlay.ts`) gets a profiler view on **Shift+F3** (one
line a thread: own ms a frame, top three categories as ms/budget, over-budget, GPU shares, last spike) and a Save
capture button; read only while shown. Capture file: `{version: 1, kind: 'thirdlight-frame-profile', header:
{build, tier, quality, frameRateCap, renderer, date, source}, report}`; a reader refuses another version with the
reason. MCP: `tl_diagnostics {sections: ['profile']}` answers a digest (≤ 6 KiB: per thread and category mean,
worst, budget, use; over-budget list; counters; GPU; the worst spike's longest spans), made on the play page from
`host.profile()` through the same relay as every Play diagnostics part; left out unless named. Manual:
`docs/manual/features/profiler.md` (+ performance, debugging, index); reference regenerated.

**Fix from the A/B (below).** A spike settling on the page made every kept frame of every thread into objects
(120 page + 120 simulation frames with spans) inside a page frame; at 150 m/s many ticks pass the interval, so it
happened in flight. It now reads only the frames over the spike's window (`framesOver`, counting back without
making objects).

**Tested.** vitest: `game-host/src/profile-view.test.ts` (columns: ticks and jobs in the frame they started in, a
job per worker, the late frame marked; bar stacking and the cut at the top; column under a pixel; breakdown with
tick rows and job lanes; the digest's bound and what a tight bound drops; overlay lines; reads after a cursor add up
to the whole read with ticks arriving after their frames, an empty cut after the newest; capture round trip,
version and kind refused; the overlay reads nothing while hidden), `protocol/src/bridge.test.ts` (the two
messages, the cursor's shape, the answer's own bound). Playwright, real backend, WebGPU: `voxel-world.e2e.ts` Play
(8 km world, worker, high tier): the tab's page / simulation / job lanes have bars, Pause, a picked frame lists only
span names the profile has, Budget is the high tier's (page render 4.17 ms), Save capture → a version 1 file (tier
high, source editor, renderer webgpu, 64-hex build), opened again it shows as a file with its frames, a spike
opens, Counters (~5 s added to the test); `engine-stats.e2e.ts` export served with the backend stopped: the
profiler view hidden and `data-reads` 0 over 1.5 s, Shift+F3 shows page / sim / jobs lines and reads, Save
capture → version 1, source export, Shift+F3 hides it and the reads stop; `mcp.e2e.ts`: `tl_diagnostics`
sections ['profile'] over a real Play: only that part, digest ≤ 6 KiB and answer ≤ 16 KiB, page and sim frames,
render's budget, draw calls; not in an answer that does not name it. `project-items` / `project-window`: the dock's
fourth tab; `playtest.e2e.ts`: a whole diagnostics answer has every section but `mode` and `profile`. Gate:
`gate-fast-20261113-180707` red only on that playtest list (fixed, f82684a2), `gate-rerun-20261113-182705` green;
e2e 8.8 min over 68 files (voxel area 157 s, 158 before); village perf at 60 Hz 0/360 missed, main 6.32 ms
(baseline 5.64, limit 9.02).

**Measured** 2026-11-13 17:32–17:58 UTC, each run alone, uptime 21.0 d, load (1 min) 1.0–3.4: coverage, export,
low 30 Hz, 1280 × 720, 150 m/s, interleaved; base b556103f built in a scratch worktree, removed after (raw:
`~/.cache/thirdlight-phase46f/work/46f.1b/cov-*`, `*.uptime` beside each).

| Round | base b556103f | HEAD 44e497e2 | after the fix |
|---|---|---|---|
| 1 | 44.4 ms, 0 > 100, 0.9 missed/min | 50.5, 0, 0.9 | |
| 2 | 42.0, 0, 1.8 | 48.5, 0, 1.8 | |
| 3 | 42.7, 0, 1.8 | 43.9, 0, 3.7 | |
| 4–5 (a first try: frame objects cached only) | 42.2, 0, 2.7 / 44.4, 0, 0.9 | | 52.3, 0, 0.9 / 46.3, 0, 2.7 |
| 6–7 (the spike window fix) | 53.9, 0, 0.9 / 45.3, 0, 3.7 | | 43.5, 0, 1.8 / 45.2, 0, 1.8 |

Seven base rounds read 42.0–53.9 ms: HEAD's 43.9–50.5 lies inside that spread, so no regression is shown; the one
page cost found is fixed and the fixed build read 43.5 / 45.2 beside base 53.9 / 45.3 in the same hour. No frame
over 100 ms in any round.

**Looked at** (opened, `~/.cache/thirdlight-phase46f/work/46f.1b/shots/`): the tab at 1280 × 720 (Frame, Budget)
and 1920 × 1080 (a capture file's spike, Counters), and the export overlay's profiler view at 1920 × 1080. Seen and
fixed: the interval's label over the lane names, a budget table too narrow for its category names (now grouped by
thread), children listed before parents where the page's 0.1 ms clock ties starts, a spike's two frames drawn as
slivers. Page spans read 0.00 ms where they take under the page clock's 0.1 ms (truthful, not hidden).

### 46f.2 — the window helper and the interaction field

**Built.** three-adapter `camera-window.ts`: `CameraWindow` (texels, cell size, step in cells as parameters; origin
snapped to whole steps round the eye, `moved` in whole cells, `wouldMove`; world ↔ texture mapping as nodes and CPU
maths from one definition, `windowUvSteps` / `windowEdgeSteps` over `field-ops.ts` `ScalarOps`), `scrolledSource`
(the scroll's source texel; entering texels have none) and `WindowTargets` (pairs of RGBA half-float storage
textures, the written one copied back after the pass so readers bind one texture). `wind-field.ts` is rebuilt on it
(64 × 4 m, steps of 8 cells); its `sample` is public as `MaterialLibrary.windSample` (type `WindSample`, index).
project-model `interactor` (`interactor.ts`, `interactor-descriptor.ts`; fields `radius`, `strength`, `recovery`, as
`foliageBend`'s), renamed by the recorded schema 8 step `interactor` (`upgrade-interactor.ts`: objects, prefab parts,
linked copies' override paths; an object with both keeps `interactor`, with a note); commands, validation, the
editor's rule card text, MCP docs, reference regenerated, manual (environment, terrain, meadow guide).
`interaction-field.ts`: 256² × 0.25 m on the window; state A = velocity x, z (m/s), pressed, foot; B = top, rate,
radius, the press as stamped; heights relative to a base that follows the eye in whole metres. One compute pass a
frame: scroll by whole cells, linear stand-up at the stamped rate (what an object pressed stands up over its
recovery, as the old path did), then every stamp (a capsule swept from last frame's place, strength eased in over
the recovery; a stamp buffer that doubles: no cap) with a box test first. The pass runs only while something
changes (a stamp moved, eased or left, for the slowest recovery after) or the window must follow; nothing reaches
the GPU until something presses; readers skip it when idle. `interactors.ts` (`InteractorView`) gathers every
object with the component (adapter-entities keeps the set) plus see-through's subjects (camera target or the
script's list) with the defaults. `foliage-nodes.ts` reads `InteractionField.foliageOffset` (one node function;
cover, stored copies, instances and placed models all go through it): lean down the stamped press's slope by
pressed × capacity, faded outside foot..top over the radius, held under 0.95 of the height with the same drop.
`foliage-bend.ts` and its test are deleted. Profiler: page span *interaction field* (category effects), counters
`interaction` (stamps, live, bytes) and the Profiler tab's Counters row; diagnostics `renderer.interaction`.

**Tested.** vitest: `camera-window.test.ts` (snap, whole-cell moves, the 8-cell wind step, scroll sources, mapping
CPU = node steps, WGSL); `interaction-field.test.ts` (the CPU twin `interaction-field-reference.ts` against the
analytic push it replaced: every distance within 6 % of the plant's capacity, direction, strength, rule, weight²,
bridge, lean held; the path behind a 2 m/s mover: about half at 0.5 s, none at 1.5 s, sideways out of the path,
stands up after a stop, gone after a recovery; carried with the window and through a moved base; nine objects each
pressed; the gatherer: ease, sweep, velocity, jump, interactors beside subjects, strength 0; the GPU pass runs only
while changing, holds 0 bytes before the first stamp, the buffer grows to 64 for 40 stamps, none on WebGL 2; the
foliage program reads the field on WebGPU, one program for any number of stamps, none on WebGL 2; the pass's WGSL;
the wind sample in a compute node); `upgrade-interactor.test.ts`; `page-profile.test.ts` (counter); the schema 8
lists in backend/workspace/integration tests; script-access digest re-pinned at 8. Playwright, WebGPU, real backend:
`materials.e2e.ts` (no e2e covered bending before): 2 m posts in a foliage material, seven interactors and one
script subject without the component walk in while P is held; in the export served with the backend stopped every
ring round them changes 405–925 px against 0–4 px for an empty ring, and after release every ring is back to the
first picture (0 px); the Inspector shows *interactor component* (about 11 s). Gate: `gate-fast-20261113-191259` red
in vitest (the fixtures' and templates' upgrade lists, the foliage WGSL pins: fixed 69bf10cb; `tracer-terrain-rings` under
load, passed alone: D411), `gate-rerun-20261113-192520` green, 23 min (every area: e2e 22.3 min over 181 files, materials
301 s; village at 60 Hz 0/360 missed, main 5.83 ms against 5.64).

**Measured** 2026-11-13 18:33–19:20 UTC, each run alone, uptime 21.0 d, load (1 min) 0.45–2.4; meadow class, low,
WebGPU, `frameRateCap=30`, the §4 command (`--walker`: the moving box named by a script; `--interactors 8`: eight
movers with the component, new flag); raw `~/.cache/thirdlight-phase46f/work/46f.2/{before,after,after2,after3}-*`.

| Run | p95, missed | draws, tris | main ms (CPU) | page profile ms (field span) | GPU compute pass |
|---|---|---|---|---|---|
| before, grass | 33.4, 0 | 10, 977 k | 1.78 (2.01) | 1.04 | none |
| after, grass | 33.4, 0 | 10, 977 k | 1.67 (1.91) | 0.94 (0.007) | none (no stamp: no pass) |
| before, walker | 33.4, 0 | 12, 977 k | 1.76 (2.00) | 1.01 | none |
| after, walker | 33.4, 0 | 12, 977 k | 1.86 (2.10) | 1.05 (0.14) | 0.10 ms |
| after, 8 interactors (3 rounds) | 33.4, 0 | 12, 977 k | 1.71–1.75 (1.95–2.00) | 1.02–1.06 (0.026–0.029) | 0.78 ms |

GPU ms are timestamps at the cap (GPU clock ~520 of 1400 MHz; D544: not trustworthy there): 0.78 ms is about 0.29
ms at full clock, at the research's ~0.3 ms target; the step from 0.1 ms (one stamp) to 0.78 ms (eight) did not
move with a box test that skips far stamps (round 3), so its cause is not found (the pass's arithmetic per stamp
is small); recorded, not tuned further. Memory: 2 MiB of state textures + 768 B of stamps once something presses.

**Looked at** (opened, `~/.cache/thirdlight-phase46f/work/46f.2/shots/`): `before-standing.png`,
`before-standing3.png`, `before-moving15.png` (1e1a500b) and `after-standing3.png`, `after-moving15.png` (the meadow
camera, a 1.8 m box standing with radius 3 m, walking with radius 1.5 m): the parting at its base reads the same
before and after; from eye height 7 m away it is subtle in both. `e2e-press-before.png` / `-pressed.png` /
`-after.png` (top-down posts): round every one of the eight objects the posts lean away radially, the empty ring
and the picture after release are unchanged. Unverified by eye: the recovering trail in motion (pixels only), a
camera moving through the field's window edge, ground cover on a voxel world (none draws there yet).

### 46f.3a — stored copies as rows of the culled-instance table; the level helper

**Built.** `@thirdlight/shared` `lod-level.ts`: the level by screen size with hysteresis, written once over
`ScalarOps` (moved to shared, `scalar-ops.ts`): `lodSwitchMargin`, `lodLevelStep` (one switch; a shader steps it in a
loop) and `lodLevelOf`; placed models' LODs (`pickLodLevel`), the copies' compute pass, the WebGL 2 vertex stage and the
diagnostics all run it (`copyLevel` deleted; the thinning share is `copyDensitySteps` the same way). three-adapter:
`copy-rows.ts` (a set's copies once in the table's pools, its state per copy and group, a range per list, rows per
mesh: a list's first row compacts it on the pyramid's path and writes its sharers' arguments, near-shadow rows are
drawn by shadow cameras only), `copy-rows-select.ts` (three dispatches in one compute call: select — level by
`lodLevelStep` with hysteresis and a fade state, thinning by rank, sphere, frustum, appended with atomics, in view from
the front of a list and the rest from its back; counts; each row's indirect arguments for the view and for other
cameras), `copy-rows-rule.ts` (the CPU reference), `copy-rows-draw.ts` (the vertex placement reading the pools; the
cross-fade as a keep term in see-through's existing `setupDiffuseColor` step). `occlusion-instances.ts`: table rows of
12 u32 (copies' place, list's counts, sharers), arguments of 15 (pass 1, pass 2, other cameras), a row's copies tested
from the selection's count, the table owned by `occlusion.ts` on every path (not only the pyramid's). `copies-gpu.ts`:
a set asks the scene's table to take it at its first draw (WebGPU); a set whose blocks draw one level each hands its
blocks' levels (picked on the page with the hysteresis, as before) to the pass; the page only hides draws no block can
reach. Profiler: counters `copyRows` (sets, rows, lists, in view, listed, drawn after the pyramid, triangles, bytes) in
`__tlProfiler.read()` and the Profiler tab. Manual (instance sets), design page §6, three checklist row.

**Found and fixed on the way.** A compute node made with a thread count (`compute(64, …)`) gets three's
`if (instanceIndex >= count) return;`: the counts and arguments passes wrote their first 64 entries only, so in the
landscape every set past the first eight drew nothing (the trees were gone in the first picture). Both passes are now
dispatched by size (as the table's own passes are); a WGSL test fails on such a return. The fast gate found two more:
the table's late pass bound the copies' counts as a 9th storage buffer, past WebGPU's default 8 a stage (every
pyramid-path test red: voxel far field, rendering's occlusion): the rows pass now writes each copy row's count into
its table row, and a test counts every pass's storage buffers; and the editor draws on demand, so a set taken by the
table in a frame was never listed (the instance brush's new copies drew nothing): the table asks for a frame when it
takes a set and while picks settle. three's draw counts leave indirect draws out, so the diagnostics count the rows'
shadow-map draws (`occlusion.copies.otherDraws`; `instances.e2e.ts`'s casting check adds them). And the table now outlives the two-pass
frame: its late pass was cached by the pyramid's generation, which a new frame's pyramid counts from the start again,
so after the path was pinned off and on the pass read the disposed pyramid and left every copy row out (rendering's
export, leg 2); the pass is keyed by the pyramid's buffer too.

**Tested.** vitest: `shared/src/lod-level.test.ts` (the stated rule on a grid of distances, scales, shown levels and
hysteresis; the same steps recorded as an expression and evaluated equal to the CPU answer; walk out and back);
`lod-switch.test.ts` unchanged and green on the shared step; `copy-rows.test.ts` (first pick without a fade, a switch
listed in both levels for 0.25 s, never for shadow cameras; hysteresis at a rocking switch; cull, thinning, near list,
a hidden copy; zero is a fresh state; rows, ranges and the selection data of two sets, block levels; no pick for a
still view after the fade, a moved view picks; the three passes' WGSL: atomics, workgroup 64, no baked count);
`page-profile.test.ts` (the counter). Playwright, WebGPU, real backend: `instances.e2e.ts` LOD test extended — Play:
the set is 1 set, 2 rows, 2 lists with near + mid copies in view; the export served with the backend stopped: rows
and all 21 copies in view drawn off the pyramid's path; a second export with a wall 60 m ahead on `?occlusion=hiz`:
copies in view unchanged, fewer drawn (the hidden ones left out); the existing level pictures (green near, magenta
past the switch, culled past the cull size, LOD bias 2) unchanged. WebGL 2: `webgl2-smoke.e2e.ts` (vertex path). Gate: `gate-fast-20261113-225756` red in vitest (the fixture generator
lacked the `interactor` upgrade: D647, red at the branch head too; the three checklist row; an unhandled read-back in
a test), reruns red on the table's 9th storage buffer, on-demand frames, the shadow-draw observable and the stale
pyramid key (all fixed, above; D643's impostor ratio 0.589 / 0.574 / 0.624, D319's export root); `gate-fast-20261114-
000248` (every area: e2e 22.7 min over 180 files, rendering 372 s, levels 374 s) red only on D319 and a voxel read-ring
timing (D648), `gate-rerun-20261114-003641` green: village at 60 Hz 0/360 missed, main 6.16 ms (baseline 5.64).

**Measured** 2026-11-13, each run alone (`thirdlight-gate` inactive), low tier, WebGPU, 1280 × 720 at the 30 Hz cap,
`--busy 5000`; before at 54bf2e50 (19:59–20:15 UTC, uptime 21.1 d, load 0.5–2.9), after at 88b97054 (22:45–22:57,
load 0.9–1.4; the later fixes touch the pyramid's path, on-demand hosts and counters only). The dense case is the level class's landscape with impostors (`node tools/perf/run.mjs level --classes
landscape --impostors 0.05 …`, same flags): stored trees, pines and rocks (near shadows, blobs, impostors) and the
foliage instance sets, ~29 k copies listed. Raw: `~/.cache/thirdlight-phase46f/work/46f.3a/{before,after5}-*`.

| Class (2 rounds) | Before | After |
|---|---|---|
| Village: p95, frames ≥ 50 ms | 33.4, 0 % | 33.4, 0 % |
| Village: draws (scene / shadow / indirect) | 242 (218 / 21 / –) | 242 (168 / 21 / 50) |
| Village: triangles | 292 k | 184 k + 50 indirect draws (three cannot count them) |
| Village: main thread ms a frame (CPU), profile page / sim | 4.31 / 4.77 (4.62 / 5.05); 3.47 / 3.96, 0.34 | 4.77 / 4.69 (5.05 / 4.98); 3.76 / 3.99, 0.33 |
| Village: scene pass GPU (300 MHz) → frame at full clock | 3.53 / 3.44 → 1.47 / 1.49 ms | 2.94 / 2.94 → 1.38 / 1.37 ms |
| Landscape: p95, ≥ 50 ms | 33.4, 0 % | 33.4, 0 % |
| Landscape: draws (scene / shadow / indirect) | 237 (230 / 4 / –) | 237 (149 / 1 / 84) |
| Landscape: triangles | 1,396 k | 735 k + 84 indirect draws |
| Landscape: main thread ms (CPU), profile page | 3.79 / 3.85 (4.05 / 4.10); 3.01 / 2.95 | 4.23 / 4.11 (4.48 / 4.35); 3.34 / 3.10 |
| Landscape: scene pass GPU → frame at full clock | 10.13 / 10.99 ms at 387–393 MHz → 3.59 / 3.64 ms | 9.86 / 9.89 ms at 300 MHz → 2.77 / 2.78 ms |

GPU ms are timestamps at the cap (D544: the clock moves under them; compared at full clock they are an estimate):
the scene pass is cheaper with copies picked in compute (no vertex work for left-out copies). The page thread is
equal on the village (inside the before rounds' spread) and +0.2–0.4 ms on the landscape (cause not isolated: the
per-frame listing of ~70 sets and 235 lists, their parameters and the rows' per-draw binding; a still view runs no
pick). A first build that let a level's draw stay shown for every reachable level drew 342 / 318 draws and cost
+0.7 / +0.8 ms on the page; hiding the draws no copy can reach brought the counts back to the baseline's. Frame room:
not measurable (the headroom meter drives only voxel pages). Medium and high: not measured here. The meadow class
(ground cover only) is 46f.3b's.

**Looked at** (opened, `~/.cache/thirdlight-phase46f/work/46f.3a/shots/`): `before/` and `after2/` (an instance set of
352 markers, LOD0 green, LOD1 magenta, cull past 139 m; export, 1280 × 720): `near`, `mid-switch`, `far-cull` are
pixel-equal (0 px over 16 levels), also on `?occlusion=hiz` (`after-hiz/`); `moving-*` (the camera moving through the
switch at 6 m/s) differ by timing only — cropped at the switch (`crops/`) the boundary rows look the same, the temporal
upscale smooths the fade's dither: the stipple itself is unverified by eye. `landscape/base.png` vs `head2.png` (the
landscape with impostors, near shadows, blobs): the same trees, pines, rocks and shadows; 1,033 of 921,600 pixels
differ by more than 16 levels. `moved/` (a set moved and turned) and `foliage/` (a foliage material) draw in place.

**For 46f.3b (ground cover).** A second producer registers like a copy set: implement `CopyRowsSource` (count, groups,
meshes with their level/near/staticAll, `writeCopies` into the pools' 16 floats a copy, world, density, near reach,
`blockLevels`, `shown`, `released`) and ask `InstanceOcclusion.adoptCopies` at the first draw (`copies-gpu.ts`
`adopt`). Room in the row format: a copy's floats keep the thinning rank in float 3 (cover's 16 B points would be
expanded to 16 floats, or the pools taught a second copy layout); floats 13–15 are free but float 13 holds the block
index where blocks pick; the selection header has no spare field (10 u32), the selection floats take a level's
switch distances after 25 fixed floats. Cover sorted by threshold thins by rank exactly as copies do
(`copyDensitySteps` over a rank); its rings and per-texel placement are cover's own. `cover-gpu.ts` shares with copies
the placement hook (`installCoverPlacement`, which copy rows use too), the copy root/bend stash, and the list texture
idea the rows replace. Untouched: `cover-gpu.ts` itself.

### 46f.3b — ground cover from point sets as rows of the culled-instance table

**Which cover the meadow class draws.** The §4 meadow class is a 1 km² heightfield whose grass is placed in the vertex
stage from the terrain's texels (vegetation.md §1 path A: old terrain, retiring in 48, scope fence): it exercises no
point set, so its rows can only show "no regression". Point-set cover (path B: block layers, a model's upward faces,
architecture floors; the path voxel worlds will use) was measured on the same class with a new flag, `--slab`: the
terrain goes and a flat 320 m model slab at the camera's ground height carries the same grass rule (8 clumps a m² to
60 m, its terrain-layer condition left out). The level class's `area` was run first and dropped: it has no block
cover (its block scatter is the landscape's only).

**Built.** three-adapter `cover-rows.ts`: `CoverRows`, one per cover rule of a point source, a `CopyRowsSource` of
the table: its places are the rule's point atlas's blocks (`cover-points-gpu.ts` now keeps each block's owner, first
point and version), each point expanded on arrival into a copy's 16 floats by `coverPointAt` + `coverPointCopy` (the
CPU reference of the vertex stage: place less the sink, threshold as the rank, turn, size), so a chunk's set arriving
or leaving writes only its blocks (`writeCopies(target, at, since)` returns the ranges; the table uploads only
those); when the atlas grows the set is taken again at the new size. `copy-rows-select.ts`: flag `SELECT_COVER`
thins by `coverShareSteps` (new in `cover-placement.ts`, one definition over `ScalarOps`; `coverShare` is it on
numbers) across the ground (horizontal metres, as the rings did) with the cover's full/reach/least share in the
falloff's three floats; level, hysteresis, fade, frustum and the pyramid as for stored copies. The table is found
by the rings' first draw offering its scene (as copies sets find it at their first draw); from the next frame the
table draws the rule and the rule's rings are dropped; where the scene has no table (WebGL 2) the rings go on.
`cover-gpu.ts` asks for point sets in reach as before but lists no blocks and culls no chunks on the page while
rows draw. Shadows keep the cover's rule: a rule's draws cast only with `castShadow` (shadow cameras draw every point
the lists hold, in view or not) and always receive; a cached static shadow map draws none. Bending reads the copy's
root through `installFoliage` → `InteractionField.foliageOffset` as the rings did (the copy rows' placement). Diagnostics: `occlusion.copies.cover` (sets, places, rows, lists, in view, drawn, triangles) apart from
the stored copies; profile counter `coverRows` and a Profiler tab row; `renderer.cover.gpu.rowRules/rowPlaces`.
Manual (terrain: point sets on WebGPU), design page §6 row 6.

**Tested.** vitest: `cover-rows.test.ts` (a point's row = `coverPointAt`/`coverPointCopy`, an empty place is never
kept; on 4,000 points × three thinnings the pass's CPU reference keeps exactly the points the rings kept; the shared
steps = `coverShare`; taken once a scene with a table is offered, written block by block as sets come and go, taken
again when the atlas grows, never without a table, out of the scene when hidden); `copy-rows.test.ts` (a cover set's
flag and floats in the selection data, counted apart, only changed ranges uploaded); `page-profile.test.ts`
(counter). Playwright, WebGPU, real backend, `instances.e2e.ts` (one new test, ~8 s): a 140 m model slab with green
tufts 2 a m² to 40 m; the export served with the backend stopped counts 1 rule set, 1 row, 6,572 points in view, all
drawn; from 100 m straight down the green share is 0.37 at 3–12 m, 0.13 at 31–37 m, 0.000 at 44–60 m; a second
export from eye height with a wall 8 m ahead on `?occlusion=hiz`: 134 of 1,541 points in view drawn. Bending:
`materials.e2e.ts` (46f.2's interactor check) unchanged and green. WebGL 2: `webgl2-smoke.e2e.ts`. Gate:
`gate-fast-20261114-012326` green, 12 min (named instances, materials, block-layers — its interior cover now draws as
rows —, webgl2-smoke; e2e 105 tests 7.5 min, rendering 380 s; village at 60 Hz 0/360 missed, main 6.34 ms against
5.64), its tree carried these notes uncommitted, so `gate-fast-20261114-013649` (green, 12 min) recorded it after the docs commit.

**Row layout (chosen on paper first).** Default budget 8 clumps/m² to 30 m + 2/m² to 80 m, sets baked per 16 m
square at full density: about 42 k + 52 k points held (squares meeting each reach), ~22 % of them in a 50° view,
~15 k kept. Expanded (chosen): 64 B floats + 16 B sphere + 4 B state + 16 B a list (order, visibility, two pass
lists) = 116 B a place for a two-level model; two atlases of 65,536 places ≈ 15 MB GPU (+2 MB of 16 B points on the
page). Compact second layout: 16 + 16 + 4 + 32 = 68 B ≈ 9 MB: 41 % less, not 4×, because the lists' ranges and
spheres are the same in both; the pass reads 32 B (two of four vec4) against 16 B a point, ~7 MB against ~5 MB a
picking frame (a still view picks nothing); the draw reads four vec4s a vertex against decoding the octahedral
normal and two quaternions with trig a vertex (today's vertex stage). Expanded keeps one layout, one pass and one
draw program for copies and cover.

**Measured** 2026-11-14, each run alone (`thirdlight-gate` inactive), low tier, WebGPU, `frameRateCap=30` (page
1920 × 1080, scene 1280 × 720 TAAU, the meadow bench has no viewport flag), uptime 21.4 d, load (1 min) 0.7–1.6;
before at 121ddfc1 (00:48–01:04 UTC), after at b308a711 (01:11–01:22); the walking A/B interleaved base (121ddfc1
built in a scratch worktree, removed after) / head. Raw: `~/.cache/thirdlight-phase46f/work/46f.3b/` (`before-*`,
`after-*`, `ab-*`, `*.uptime`). GPU ms are timestamps at the cap (D544; "full clock" scales by the clock read).
Frames ≥ 50 ms: 0 % in every run; p95 33.4 ms in every run.

| Run (2 rounds) | Before | After |
|---|---|---|
| Meadow (terrain cover), grass: draws, tris | 10, 977 k | 10, 977 k |
| Meadow: main ms (CPU); page profile | 1.79 / 1.83 (2.04 / 2.06); 1.01 / 1.04 | 1.71 / 1.73 (1.95 / 1.97); 1.00 / 1.06 |
| Meadow: scene pass | 8.80 @ 529 / 10.40 @ 544 MHz | 11.89 @ 543 / 8.41 @ 527 MHz |
| Meadow `--interactors 8`: main ms (CPU); field pass | 1.77 / 1.74 (2.01 / 1.99); 0.78 ms | 1.68 / 1.86 (1.91 / 2.09); 0.78 ms |
| Slab, still camera: draws (scene), tris | 10 (6), 1,496 k | 8 (1 + 3 indirect), indirect unknown to three |
| Slab, still: main ms (CPU); page profile | 1.73 / 1.72 (1.95 / 1.95); 0.97 / 0.90 | 1.70 / 1.67 (1.95 / 1.92); 0.95 / 0.97 |
| Slab, still: scene pass → at full clock | 8.77 @ 543 / 12.82 @ 525 → 3.4 / 4.8 ms | 5.21 @ 343 / 5.07 @ 345 → 1.3 / 1.2 ms (no pick: still view) |
| Slab `--walk 1.4` A/B: main ms (CPU); page profile | 1.72 / 1.74 (1.94 / 1.97); 1.00 / 0.98 | 1.86 / 1.89 (2.11 / 2.18); 1.18 / 1.05 |
| Slab walking: frame GPU at full clock (scene; compute) | 5.98 / 6.04 (15.0 / 12.7 @ 596 MHz; –) | 3.56 / 3.63 (5.97 / 6.87; pick 1.83 / 2.11 @ 368 MHz) |

The meadow's terrain cover is the same path before and after: equal draws and triangles, page within the rounds'
spread, scene pass inside the clock's noise. Point-set cover as rows: the GPU frame while walking is 40 % cheaper
(the vertex stage no longer runs a clump's vertices for every point thinned away), the page +0.14–0.17 ms a frame
while the view moves (cause not isolated: the pick's selection data and parameters are written and its compute
dispatch encoded every moving frame; a still view picks nothing). Triangles of indirect draws: three's counters leave them out; the profile's `coverRows.triangles`
counts them (the picture scene: 13.3 k points, 160 k triangles in view). Frame room: not measurable (the headroom
meter drives only voxel pages). Medium and high: not measured (unverified on target hardware).

**Looked at** (opened, `~/.cache/thirdlight-phase46f/work/46f.3b/shots/`): `before/` and `after/` (a 120 × 240 m
model slab, tufts LOD0 green / LOD1 magenta, 8 a m² to 60 m; export, 1280 × 720): `far` 1 px and `grazing` 0 px of
921,600 differ by more than 16 levels; `near`, `switch`, `occluder` differ only at the level switch (11.9 k, 23.6 k,
7.4 k px): before, the switch was a ring line at one distance for the rule's mean size; after, each tuft switches
by its own size (the shared rule, as placed models and stored copies), so the boundary is ragged a few metres
either side. Thinning, density and the wall look the same. `before/slab-*.png` (the perf slab). Not looked at: the
cross-fade's stipple in motion (pixels only), cover casting shadows (no rule here casts).

### 46f.4 — one undo for scene and voxels

**Built.** workspace `undo-timeline.ts`: `UndoTimeline`, one line per project in the backend: each undoable edit as
a project entry (its request id) or a voxel stroke (world, stroke id), a cursor, steps one at a time per project, a
request id answered once (256 kept). `undo` / `redo` (the existing project ops, the same envelope with the project's
`expectedRevision`) step the newest applied step (or the next undone one) through its own store: a project entry
through the project pipeline as before (groups still taken whole), a stroke through `VoxelWorlds.step` (refused
`revision_conflict` against the project's revision as a project entry is). The two stores stay apart: the project
history (`history.ts`) is not changed; the line is brought level with it before each use by request id (entries it
gained are new edits: the line's redo tail of both kinds goes; a history started afresh keeps the strokes). A stroke
through the line drops the project's redo tail (`dropRedoTail`, new in `service-history.ts`, where the service's
history functions moved out of `buildService`). Voxel worlds: every history entry has a stroke id (unique in the
process); a **redo stack**; an undo writes back the stroke's record and keeps the chunks it found (images) as the
redo record in the same `UndoStore` (same 64 MiB budget, spilled past it; no count); a redo writes that back (the
exact voxels, no brush re-run) and keeps what it found as the next undo record; a new stroke drops the redo; derived
data follows through the edit path (the answer's chunks, box, parts, material swaps; far cache rebuilt by
`farAfter`; the feed's `voxelsChanged`). A stroke whose world no longer holds it (read again after a change on disk,
closed with its project, deleted, record lost: `history_gone`) is left out and named in the answer's `skipped` and
on the Problems list; the next step goes on. `editVoxels` / `writeKitTestScene` take an optional `expectedRevision`
(the world's; stale → `revision_conflict` with `currentRevision`). Backend: voxel commands go through the line;
`undo`/`redo` answer a stroke's step as `{ok, op, requestId, revision (the project's), duplicated, voxels, skipped?}`;
`queryProject` and the session's start answer the line's depths. Editor: depths re-read on `voxelsChanged`; a stroke
step's answer moves no own revision; skipped steps shown in the status line. `undoVoxels` removed (catalogue, MCP
enum and docs, reference regenerated); the voxel world page's Z sends the one undo. Manual: editor, voxel worlds
("One undo for scene and voxels"), MCP docs.

**Tested.** vitest, real service and worlds on disk (`undo-timeline.test.ts`): move, stroke, move undone in reverse
and redone in order, the region files' bytes after redo equal to after the stroke, twice; a new edit of either kind
clears both kinds' redo (the other world's redo records dropped); a checkout and a deleted world skipped and named,
the next step taken; history started afresh keeps the stroke; a resent undo steps once; stale project and world
revisions refused. `voxel-worlds.test.ts`, far-cache tests (`voxel-far-jobs`, `voxel-far-fine`, `far-world`)
through `step`. HTTP (`tests/integration/voxel-world`): undo/redo as commands (world answer under `voxels`, revision,
box, chunks, redo's chunks equal the oracle's), a repeat answered once, `history_empty`, world `revision_conflict`,
skipped strokes after a checkout (2) and a release (4), none after a restart; MCP undo/redo/undo on the feed
(revisions 1–7), a stale undo refused. Playwright, WebGPU, real backend: `voxel-world.e2e.ts` Scene view test
(marker moved in the Inspector, a 3 m pit through the command route — the editor has no voxel brush yet —, moved
again; Ctrl+Z ×3: 501 / ground as before (< 50 px from the picture before the dig) / 500; Ctrl+Shift+Z ×3: 501 / the
pit (< 50 px from the dug picture) / 502; undo then a new move: Edit → Redo disabled); the bench page's Z (the
assembly test's undos) on the one undo; `mcp.e2e.ts` (the same interleaving with `tl_command`, positions by
`tl_inspect`, the world's region files byte for byte, `redoDepth` 0 and `history_empty` after a new edit). Gate:
`gate-fast-20261114-022542` green, 30 min (backend plumbing: every area; vitest related 305 s; e2e 322 tests 22.5 min).
Times before (`gate-fast-20261114-000248`, 46f.3a's, whose Play test failed and was retried there) → after: voxel area
183 → 162 s, the Scene view test 13.8 → 13.5 s (by hand, alone: the whole `voxel-world.e2e.ts` 2.2 min), mcp area
109 → 108 s, the extended MCP test 2.8 → 2.9 s.

**Looked at** (opened, `~/.cache/thirdlight-phase46f/work/46f.4/shots/`): `scene-view-before-dig.png`,
`scene-view-dug.png` (the pit and the hole through the wall), `scene-view-undone.png` (the same as before the dig;
the PNG files are byte-equal), `scene-view-redone.png` (byte-equal to the dug one).

### 46f.5a — cheap merges, the runtime and renderer half

**Slice 1, built.** `@thirdlight/shared` `grow.ts`: `grownCapacity` (double from what is held, or a floor, until the
need fits) and `grownArray` (a typed array grown by copy). Replaced: `copy-rows.ts` `grown`, the instance pools'
copies in `occlusion-instances.ts` `makePools`, `cover-points-gpu.ts` (the point atlas's doubling and its block
tables), `cluster-build.ts` `grow` (four typed copies) and `growEntries`, `cluster-pack.ts` (two grows, `grownRows`),
`tracer-words.ts` `grow`, `adapter-lighting-views.ts`'s line buffers; `tracer-gpu.ts` `grownGpuBuffer` replaces the
identical `grow` of `surface-light-pass.ts` and `surface-probe-pass.ts`. three-adapter `region-texture.ts`:
`uploadTextureRegion` (WebGPU `queue.writeTexture` into three's `GPUTexture`; WebGL 2 a copy from a staging texture
three never uploaded), `copyTextureInto` (grow or trim by copy on the GPU) and `freshTexture`; replaced: the upload
pairs of `voxel-surface.ts` `VoxelShaderGrids` (and the far bricks through it), `probe-atlas.ts`, `cookie-atlas.ts`,
`cluster-gpu.ts`; the grows of `VoxelShaderGrids` (`grow`, `trim`) and `probe-atlas.ts` `growTexture`; the version
rules of those four and `projected-decals.ts`. The three checklist names the one module. Left (decision log):
`tracer-gpu.ts`'s atlas and the surface light's own textures (not three's), the tracer's exact-size ray buffers,
terrain's uploads (retiring). Lines (source, tests apart): +241 / −253 (c54f2d0f).

**Slice 2, built.** `MEMORY_BUDGET_BY_TIER` (project-model `quality-levels.ts`, beside the frame budget): ten entries
at today's values, page and GPU sums against the tier's target (low: page 1,360 of 1,536 MiB, GPU 1,824 of 2,560;
medium and high: no target of their own). `@thirdlight/shared` `resident-bytes.ts` (a registry per thread); the
voxel streamer's count (`StreamHeld`, the same sum as its stats) registered by the runtime's world host, physics
by the simulation worker, which posts its reading with each tick's frame; game-host `page-memory.ts`
`memoryReport` → `ProfileReport.counters.memory` (optional: capture stays `version: 1`), `PageProfile.memory()`,
the digest's `memoryMiB`; the editor's Counters view shows a Memory table. Lines (source and styles, tests and docs
apart): +392 / −36 (9508ed99, 5698efff): a new report, not a merge of code; the merge is the constants.

**Slice 3, left** (decision log): the voxel pool lives where the simulation runs, the three hosts on the page's
mesh-worker script with retiring code; making them kinds needs a page-side pool or routing through the simulation
worker — a design change, proposed for phase 48.

**Also.** `instances.e2e.ts`'s walled export waits for and requires `drawn > 0` (748c5760): it then fails at HEAD and
at da591dc7 alike (20 of 21 drawn behind the wall): D649, open, a hidden regression to fix before the phase gate.

**Tested.** vitest: `shared/src/grow.test.ts` (policy, copies of a growing run, every kind kept), `region-texture.test.ts`
(a CPU texture twin of both backends' writes: exactly the box's texels in 2D and 3D, the staging kind on WebGL 2, a
grow's kept box, the version rule; the voxel grid store keeps 200 regions' bytes through its grows and a trim on both
backends; the clusters send only the rows written), the existing upload tests unchanged and green (`voxel-surface`,
`voxel-far-view`, `voxel-chunk-view`, `probe-scale`, cluster, cookie, copy and cover rows); `quality-levels.test.ts`
(every entry equals its system's constant at every tier, in MiB and by import; the sums and targets),
`resident-bytes.test.ts`, `page-memory.test.ts` (rows, the project's own budgets, nulls, sums, JSON),
`tools/voxel-bench/world-host.test.ts` (a real streamed world with real pool workers: the streaming row non-null
and under budget, gone with the scene). Playwright, WebGPU, real backend: `voxel-world.e2e.ts` Play (the live profile's
streaming row non-zero; the Profiler tab's Memory table from the capture: every row, the streamer's bytes, the far
field counted, the page sum). Gate `gate-fast-20261114-034934` (every area, 34 min, e2e 322 tests 23.0 min): red only
on `instances.e2e.ts:378` (D649) and `rendering.e2e.ts` render scale (D320 watch, passed in
`gate-rerun-20261114-042844`); vitest whole suite green (904 files); e2e times by area as 46f.4's (voxel 169 s). After the docs and the e2e picture, `gate-fast-20261114-043324` (34 min): red on D649 and `smooth-tops.e2e.ts` (D650 watch: red in its rerun `gate-rerun-20261114-050745` too, passed alone twice); every other test green. The fast gate is not green while D649 stands (the corrected check is right; the product is not).

**Measured** 2026-11-14, each run alone (`thirdlight-gate` inactive), low tier, WebGPU, 1280 × 720 at the 30 Hz cap,
uptime 21.4 d, load (1 min) 0.8–3.1; before at da591dc7's build (03:09–03:26 UTC), after at 5698efff (03:31–03:47).
Raw: `~/.cache/thirdlight-phase46f/work/46f.5a/` (`before*`, `after*`, `*.uptime`). (The first before coverage run
failed: the bench's driver is bundled from the working tree, which then held a project-model import order that broke
it; fixed before the commit, `before2-*` are the rerun against the same base export build.)

| Run (2 rounds) | Before | After |
|---|---|---|
| Headroom, 8 km town orbit: ballast held × a copy | 176 × 0.131 / 176 × 0.126 ms | 192 × 0.131 / 176 × 0.128 ms |
| Headroom: no load missed | 0/89, 0/89 | 0/89, 0/89 |
| Coverage 150 m/s, export: longest, > 100 ms, missed/min | 42.9 / 44.1 ms, 0, 1.8 / 1.8 | 46.8 / 40.8 ms, 0, 1.8 / 0 |
| Coverage: full detail, nothing pending, falls, holes | 5.1 / 4.6 s, 8.6 / 8.0 s, 0/34, 1/1970 a run | 4.5 / 5.1 s, 8.2 / 8.6 s, 0/34, 0 |
| Meadow `--slab --walk 1.4`: p95, main ms (CPU), GPU at full clock | 33.4; 1.85 / 1.86 (2.11 / 2.13); 3.71 / 3.79 ms | 33.4; 1.90 / 1.83 (2.17 / 2.11); 3.59 / 3.64 ms |

No regression shown: every after round lies inside the before rounds' spread or the 46f.1b base spread (42.0–53.9 ms
longest at 150 m/s); no A/B was needed.

**Looked at** (opened, `~/.cache/thirdlight-phase46f/work/46f.5a/shots/`): `profiler-memory-1920.png` (the Memory table
over a Play of the 8 km world at the high tier: voxel streaming 73.2 of 1,024 MiB, physics 17.3 of 512, far field 4.3
of 384 MiB on the GPU, textures 0.3 of 512, scene cells 0.0; the far nodes drawn, a scene's objects, surface cache,
probes and undo "not counted here"; page total 90.5 of 1,616 MiB, "no target of its own at this tier"; long labels cut
with an ellipsis), `profiler-counters-1920.png`. Unverified by eye: the GPU total row (below the panel's fold in that
picture), WebGL 2's staging uploads (only `webgl2-smoke.e2e.ts`, in the gate), `walled-base.png` (the D649 view: the far copies behind the wall, hidden in the picture, still drawn).

## 9. Decision log

- 2026-11-13 (plan): the phase is planned from the owner-approved consolidation of 2026-11-12; item order is
  0 → 1 → 2 → 3 → 4 → 5 → 6, with 46f.4 and 46f.5 free to run beside the rendering items since they touch
  other packages (one writing session per worktree still holds).
- 2026-11-13 (plan, default chosen, owner to confirm): the interaction field is visual only; a game that needs
  "is the fog cleared here" asks for it as a later request.
- 2026-11-13 (46f.0, default chosen, owner to confirm): §4's "village class" headroom could not be measured: the
  meter drives only voxel pages, and the village perf class is not one. The headroom rows are the 8 km world's town
  orbit (its village); the perf village class is measured at the low cap with the perf harness instead (§4).
- 2026-11-13 (plan, default chosen, owner to confirm): the profiler's GPU lane shows pass shares, not
  milliseconds, on hardware where timestamps follow the clock governor.

- 2026-11-13 (46f.1a, default chosen, owner to confirm): the time slices' default values live in
  `@thirdlight/shared` (`FRAME_SLICE_DEFAULTS`) beside the arbiter, not in project-model: `@thirdlight/voxel`
  cannot import project-model (project-model imports voxel), and the voxel package's own tests run with no host to
  install a table. Each tier's `FRAME_BUDGET_BY_TIER[tier].slices` is that table, installed on the page from the
  stats window and in the simulation from `setStats`; no tier changes a slice yet, so no pacing changed.
- 2026-11-13 (46f.1a, default chosen, owner to confirm): the budget shares, the same at every tier (ms follow the
  tier's rate: low 30 Hz, medium and high 60): page render 0.25, voxel apply 0.25, props 0.08, characters 0.04,
  effects 0.04, lighting 0.06, UI 0.04, audio 0.02, other 0.07 (0.15 left to the browser); simulation scripts 0.25,
  physics 0.15, path finding 0.10, characters 0.10, voxel streaming 0.20, audio 0.02, other 0.08; one job worker
  voxel meshing 0.80, streaming 0.10; GPU render 0.55, lighting 0.20, effects 0.08, other 0.12 (compared with
  pass shares). Made from the frame interval, not from today's use.
- 2026-11-13 (46f.1a, default chosen, owner to confirm): a spike is a page frame whose interval passes 1.5 frame
  intervals at the cap (a missed frame), or a page frame's or a tick's own time past one interval; the last 8 are
  kept with every thread's frames over their window, gathered 4 frames later.
- 2026-11-13 (46f.1a): no path-finding span yet: the only path query is `ctx.grid` over block layers (retire in
  48); the category is in the table. A job's span ends at its answer and starts its worker time before it (the
  worker sends no start). Frame times on a page read to 0.1 ms (no cross-origin isolation).
- 2026-11-13 (46f.1a): the GPU lane is the render/compute split of the last timestamp resolve where the renderer
  tracks timestamps (shares only), and `room: 'headroom meter'` where the page has the meter; calling the meter's
  room search from the panel is 46f.1b's (it runs for minutes and loads the GPU).
- 2026-11-13 (46f.1a, for 46f.1b): read `window.__tlProfiler.read()` (game-host `ProfileReport`, plain JSON) or
  `GameHost.profile()`; `profileSummary()` gives a bench's line. Threads are aligned by wall-clock `start`; a
  worker frame's `tick` is the tick it ran. MCP `tl_diagnostics` can carry the same object.

- 2026-11-13 (46f.1b, default chosen, owner to confirm): the Profiler is a tab of the bottom dock (beside Console
  and Problems), read only while it shows; the panel reads the play page over the preview bridge (a
  `tl.profile.request` the editor sends itself, as the visual-script debugger does), not the backend's diagnostics
  relay: that relay's 16 KiB bound cannot carry frames with spans. MCP reads the digest through `tl_diagnostics`
  (the relay); both are answered on the play page from the same `host.profile()`.
- 2026-11-13 (46f.1b, default chosen, owner to confirm): `tl_diagnostics`' `profile` part only when named in
  `sections` (a read makes the profile's frames into objects; the Play toolbar polls diagnostics every 0.4 s).
- 2026-11-13 (46f.1b, default chosen, owner to confirm): the overlay's profiler view is Shift+F3 inside the stats
  overlay, so it exists only where a game turned the overlay on (`stats_overlay` 1 or 2; off by default) — an
  export without the setting has no profiler view.
- 2026-11-13 (46f.1b, default chosen, owner to confirm): "measure room" is left to the bench (`run.mjs
  headroom`): it takes minutes and loads the GPU; the panel's Counters say so.
- 2026-11-13 (46f.1b, default chosen, owner to confirm): the capture file is the page's `ProfileReport` under a
  header, `version: 1`, `kind: 'thirdlight-frame-profile'`; a later shape is a new version, never an edit.

- 2026-11-13 (46f.2, default chosen, owner to confirm): the view's subjects (the camera's target or a script's
  list) keep pressing without the component, with the defaults, beside every object that has an `interactor`: a
  project where the player parted grass keeps doing so after the rename.
- 2026-11-13 (46f.2, default chosen, owner to confirm): WebGL 2 runs no field (no compute): foliage does not bend
  round objects there (it did with the four uniforms); the WebGL 2 smoke stays the only check.
- 2026-11-13 (46f.2, default chosen, owner to confirm): the field's layout is two RGBA16F pairs (A velocity m/s,
  pressed, foot; B top, recovery rate, radius, the press as stamped), 2 MiB with the read/write pairs, against the
  research's RGBA16F + R16F (1.3 MB): the rate keeps each object's recovery, the radius fades the bend above and
  below the body, the stamped press gives the lean its direction (the pressed amount's own slope leans plants in a
  path partly backward, which the old push never did). Heights are kept relative to a base that follows the eye in
  whole metres (half floats at a 500 m altitude would hold them to 0.25 m). Foliage does not read the velocity: the
  old push had none; fog and water will.
- 2026-11-13 (46f.2, default chosen, owner to confirm): every texel loops over the frame's stamps (a box test
  first): cost grows with the number of objects pressing, with no cap; a tile list per workgroup is the next step if
  a scene with hundreds of interactors misses.
- 2026-11-13 (46f.2): GPU particle effects do not read the public wind sample yet: their `update.wind` block mirrors
  the CPU evaluator (CPU/GPU parity tests), so switching it to the wind field is a change to the effect model, not a
  wiring; the sample is exported and proven in a compute node, and waits for a consumer.
- 2026-11-13 (46f.2): the rename re-pins the script access digest at schema 8 (a recorded step, as earlier
  same-version changes); a script that read `foliageBend` reads `interactor` now (games are on hold).
- 2026-11-13 (46f.2, default chosen, owner to confirm): the profile's counters gain an optional `interaction` entry
  inside capture `version: 1` (a reader of an older capture finds none); no new capture version.

- 2026-11-13 (46f.3a, default chosen, owner to confirm): on WebGPU every stored copy keeps its own level with the
  project's LOD hysteresis (`lod_hysteresis`) and a switch cross-fades over 0.25 s (`COPY_LEVEL_FADE_S`: both levels'
  draws keep complementary pixels of one dither) instead of popping at the exact switch distance. A look change only
  while a copy crosses a switch; a still view is the same picture (pixel-equal in the 46f.3a pictures). Thinning
  stays a hard cut by rank, as before.
- 2026-11-13 (46f.3a, default chosen, owner to confirm): the culled-instance table now lives with the occlusion culler
  on every path on WebGPU (it was made only for the depth pyramid's path, which `auto` takes only beside a voxel far
  field): stored copies are its rows whatever the occlusion setting, the pyramid's tests come on top where it runs.
  The other instanced draws join the table only on the pyramid's path, as before.
- 2026-11-13 (46f.3a, default chosen, owner to confirm): a set with **Level per copy** off keeps one level a block, as
  before: the page picks each block's level with the hysteresis (as it did) and the compute pass applies it to the
  block's copies (a per-copy pick there drew every level's draw of a set straddling a switch: +70 draws in the
  village). The flag is honoured on both renderers.
- 2026-11-13 (46f.3a, default chosen, owner to confirm): WebGL 2 keeps the vertex-stage path of `copies-gpu.ts` (no
  compute there): the page's block lists and the vertex stage's level and thinning, now through the shared level
  steps (`lodLevelStep`) and `copyDensitySteps`, without hysteresis or a fade. On WebGPU that path no longer runs (a
  set is taken by the table at its first draw; it falls back only if the table is gone or three lacks the observer
  hook). The plan's "copies-gpu.ts becomes rows" is therefore: the WebGPU draw moved, the file stays as the set
  (copies, picking, rays, editing) and the WebGL 2 fallback.
- 2026-11-13 (46f.3a, default chosen, owner to confirm): copies are not put nearest first: a list holds the copies
  in view in the order the pass met them (the old path listed whole blocks, also not by depth); the "in view first"
  split is done in compute (in view from the list's front, the rest from its back for the shadow cameras), with the
  view's frustum from `view-cull.ts`'s `CullView` (its planes now public). The page's per-frame block listing is gone
  on WebGPU; it only hides a draw no block can reach (and keeps it 1.5 s, or while the GPU still counted copies in
  its list, for hysteresis and fades).
- 2026-11-13 (46f.3a, default chosen, owner to confirm): a still view (same view, copies, rows and parameters for a
  fade's time and 0.25 s) runs no pick: the last lists and arguments hold; a moving view picks every frame.
- 2026-11-13 (46f.3a): memory: a set holds a pool place per copy and LOD group (its floats, sphere, state) and each of
  its lists a range of its copies' count (order, visibility, two pass lists): about 96 B a copy a list in the shared
  pools, which grow by the table's own path. A 3-level tree with near shadows has 4 lists (~480 B a copy, against
  48 B a copy in the old copy texture plus its list textures); a later pass can shrink lists that never fill.
- 2026-11-13 (46f.3a): the frame probe's "instance copies drawn" (perf harness) now counts the copies the GPU listed
  in view (read back), not the copies in the blocks the page saw: other numbers for the same picture (village 900 →
  582, landscape 28,673 → 29,464). Triangles of indirect draws are unknown to three's counters; the profile's
  `copyRows.triangles` counts them.

- 2026-11-14 (46f.3b, default chosen, owner to confirm): ground cover on point sets picks its level per point by
  the shared screen-size rule (each point's own size, the eye's distance, the project's hysteresis, the 0.25 s
  cross-fade) instead of the rings' fixed cuts at the rule's mean size: the switch is no longer a line at one
  distance (the pictures differ there and only there). Thinning keeps the rings' share across the ground exactly.
- 2026-11-14 (46f.3b, default chosen, owner to confirm): a point is expanded into a copy's 16 floats (64 B) in the
  table's pools rather than a compact second row layout (16 B): on paper 116 against 68 B a place at the default
  budget (the lists' ranges and spheres are the same in both), one layout, pass and draw program for copies and
  cover, no per-vertex decoding; about 15 MB of GPU memory at the default budget.
- 2026-11-14 (46f.3b): only point-set cover moved. Terrain cover placed from heightfield texels (path A) keeps its
  rings and vertex stage until heightfield terrain retires in 48 (scope fence); the §4 meadow class measures that
  path, so 46f.3b's change is measured on the new `--slab` flag of the same class. On WebGL 2 point-set cover keeps
  its rings (no compute); on WebGPU the rings draw only until their first draw finds the scene's table (one frame).
- 2026-11-14 (46f.3b): the cover's per-frame page work while rows draw is asking for the point sets in reach; its
  own chunk frustum test and block lists are gone there (the frustum is the table's, from `view-cull.ts`'s planes).
  A rule's places are its atlas's capacity (blocks of 256, doubling): free places are copies of no size the pass
  tests and drops; the set is taken again at each doubling (no count cap; 46f.5's one buffer grow can absorb it).

- 2026-11-14 (46f.4, default chosen, owner to confirm): the one undo line lives in the backend, per project, shared
  by every client (editor tabs, MCP agents), for as long as the backend runs — the rule the project history already
  had (in memory, per project; a restart starts with nothing to undo). It is not per client.
- 2026-11-14 (46f.4, default chosen, owner to confirm): the undo of a stroke is checked against the project's
  revision (the one the editor's undo sends); a stroke moves only its world's revision, so an undo can take back
  another client's stroke the view has not drawn yet (another client's scene edit still refuses it, as before).
  Fine for one owner + agents; a per-line sequence number would close it if it matters.
- 2026-11-14 (46f.4, default chosen, owner to confirm): a stroke its world no longer holds is skipped and named
  (`skipped`, Problems, the status line) and the undo goes on to the next step, rather than refusing; strokes left
  out by a read of the line (depths) are named with the next step.
- 2026-11-14 (46f.4, default chosen, owner to confirm): redo writes back the chunks the undo found (full chunk
  images in the same TLVU v2 record, not cell deltas), so redo records are larger than undo deltas; both count against
  the world's 64 MiB undo budget and spill past it. The format spec §3.4 says "Redo re-applies the command": the result
  is the same voxels (the apply is deterministic), but the text describes the other way; the approved spec is left as
  it is for the owner to note (no stored format changed).
- 2026-11-14 (46f.4): `expectedRevision` on voxel ops was cheap (an optional envelope field checked in the world's
  queue; no stored format, record or command-format change): built. `undoVoxels` had no user left once the bench
  page's Z went through the one undo: removed. The Edit menu shows "Undo" / "Redo" without what they would take back
  (it never did); not added.

- 2026-11-14 (46f.5a, default chosen, owner to confirm): one growth policy for every buffer that grows by copy:
  double what is held (from a floor) until the need fits (`grownCapacity`). The copy rows' buffers grew to exactly
  the need when it passed twice what was held; they now round up to the doubling (at most twice the bytes, never
  more often). The tracer's ray and hit buffers keep their exact size (a batch's own, one pair a pass): not a copy.
- 2026-11-14 (46f.5a): one region-texture helper (`region-texture.ts`) for every CPU write into a part of a texture
  three owns and every grow or trim by copy: the voxel grid store (and the far bricks through it), the probe atlas,
  the cookie atlas, the light clusters' rows; projected decals use its texture version rule. The WebGL 2 staging
  textures are two per page (2D and 3D, their image swapped per write) instead of one per store or per write. The
  tracer's atlas (its own `GPUTexture`, written whole) and the surface light's atlas (a texture of its own device,
  not three's) are not three's textures and stay as they are. Heightfield terrain's uploads (`terrain-view.ts`,
  `terrain-quadtree.ts`) are left: they retire in 48.
- 2026-11-14 (46f.5a, default chosen, owner to confirm): the memory budget table (`MEMORY_BUDGET_BY_TIER` in
  `quality-levels.ts`) lists ten budgets with today's values: voxel streaming (768 / 768 / 1,024 MiB), physics
  memory (512, the cap that stops the simulation), the far nodes drawn (48, their stored bytes), a scene's objects
  (32 a scene), the far field's GPU bytes (384), streamed textures (512, the project's default), streamed scene
  cells (768, the project's default), the surface cache (32 / 64 / 128), probe tiles (128) and the voxel undo (64 a
  world, the backend's: not summed). Low's page entries sum to 1,360 of 1,536 MiB, its GPU entries to 1,824 of
  2,560. Medium and high have no target of their own (as `LOW_MEMORY_BUDGET_MIB` says); high's page entries sum to
  1,616 MiB. Not entries: fixed allocations (shadow atlas, cookie atlas, interaction field), counts (scene
  read-ahead), per-frame upload limits, block layers', terrain's and architecture's budgets (retire in 48), editor
  and backend limits other than the undo. The physics cap and the probe budget moved into project-model so the
  table can read them (game-host and three-adapter re-export them).
- 2026-11-14 (46f.5a): the resident-bytes report reads each system's own count: the voxel streamers' (the same
  sum as their `stats().bytes.total`) and the physics memory through a per-thread registry (`residentBytes`, shared;
  the simulation worker posts its reading with each tick's frame), textures, scene streaming, probes and the surface
  cache from the adapter's diagnostics, the far field's GPU bytes from the voxel draws. The far nodes drawn, a
  scene's objects and the undo have no count on a game page: null. The profile's `counters.memory` is optional, so
  the capture file stays `version: 1`.
- 2026-11-14 (46f.5a): cover, scatter and decal-clip workers as job kinds of the voxel `WorkerPool` was NOT cheap,
  so it was left (the three hosts are unchanged). What was found: the voxel pool lives where the simulation runs
  (in the simulation worker, a pool a world, started by it; on the page only in single-thread mode), while cover,
  scatter and decal clips are asked for by the page's views and run on the page's mesh-worker script (one script
  with the block mesher, the terrain packer and generated architecture's generator; decal clips run on
  architecture's own workers, `runArchitectureWorker`). Making them kinds needs either a second voxel pool on the
  page (two sets of workers again: the opposite of the merge) or the page's requests routed through the simulation
  worker to its pool and back (new messages, one more hop for every point set and clip, the answers' transfers
  through two threads); the voxel worker entry would also have to be built with three-adapter's handlers by each
  host (editor, Play, export), and a scene without a voxel world would need a pool of its own. The mesh-worker
  script itself mostly holds retiring code (block layers, heightfield terrain, architecture: phase 48). Proposed:
  do it with phase 48, when that script loses its retiring handlers: the page then needs a job pool only for cover,
  scatter and decal clips, and the choice (a page pool shared with single-thread voxel streaming, or routing through
  the simulation worker) can be measured on the voxel world's cover.

## 10. Open questions for the owner

(None at planning. Questions the phase raises are listed here, at most five, each with a default that stands
if unanswered.)

Collected by the lead while the phase runs (final wording at the close, 46f.6):

- **Voxel redo against the approved format spec.** `voxel-format-spec.md` §3.4 (line 695; summary point 16) says
  "Redo re-applies the command". 46f.4's redo writes back the chunks the undo removed (the lead's brief asked for
  that: exact bytes, no brush re-run). The voxels are the same and no stored format changed, but the behaviour
  is not the spec's sentence. The spec text is NOT edited. Default if unanswered: keep the built redo and amend
  the sentence with an owner note at the phase boundary; the other choice is to rebuild redo as a command re-run.
