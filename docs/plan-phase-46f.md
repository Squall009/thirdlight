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
| 46f.1 | not started |
| 46f.2 | not started |
| 46f.3 | not started |
| 46f.4 | not started |
| 46f.5 | not started |
| 46f.6 | not started |

## 8. Results

(Each item's built / tested / measured / looked-at goes here, or in `docs/results-phase-46f.md` if this file
passes about 1,000 lines.)

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

## 10. Open questions for the owner

(None at planning. Questions the phase raises are listed here, at most five, each with a default that stands
if unanswered.)
