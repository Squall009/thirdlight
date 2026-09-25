# Phase 22 — Multithreading

Goal: move work with clean boundaries off the main thread — the game
simulation (runtime + physics) first, then optional off-thread rendering —
without concurrency hazards and without changing game results. Read
`docs/roadmap.md` (principles) first.

## 1. Where things stand and why this order

- The runtime is pure (no DOM, no three.js); physics is behind the
  `PhysicsPort` interface; the adapter reads interpolated transforms and a few
  views (hidden entities, animator poses, counters) per frame. The runtime
  calls physics synchronously inside each step, so moving physics alone to a
  worker would add a step of latency or a round trip per step: the whole
  simulation (runtime + physics + gameplay blocks + scripts) moves together.
- Asset decoding already uses workers (Draco/Basis).
- Rendering off-thread needs OffscreenCanvas and moves input/audio/DOM
  interplay; it is optional and comes after the simulation worker.

## 2. Decisions

- Determinism is the rule: the worker runs the same fixed steps; replays
  and the headless bot give identical results on and off the worker (a test
  pins it).
- Message passing by default (structured clone of compact typed arrays per
  frame: transforms, visibility, poses); SharedArrayBuffer ring buffers only
  where cross-origin isolation is available (COOP/COEP headers on the Play
  and export pages; the export must work without them — then the message
  path is used). Log what each page gets.
- Single-thread mode stays available (setting/URL flag) and is the fallback
  when workers are unavailable.

## 3. Work items

### 22.0 Simulation worker

- A worker entry (runtime + physics-rapier + behaviors + blocks) in the
  preview and export bundles; the main thread keeps input sampling (sent as
  action frames with step indices), audio (the worker sends audio requests),
  DOM menus/HUD (the worker sends flow/HUD state), and rendering (the worker
  sends per-frame state with the interpolation alpha).
- Game host split: a thin main-thread host and a worker host with the same
  observable behaviour (the `GameHost` surface, `observe`, `control`,
  MCP relay).
- Scene loading/unloading and spawn (14.1) cross the boundary as messages.
- Tests: identical replays on/off the worker; the Sprout bot and the blocks
  integration tests run in both modes; e2e Play and export in worker mode.

### 22.1 Editor-side workers

- Move heavy editor jobs off the main thread: the browser lightmap baker,
  thumbnail rendering (OffscreenCanvas), scatter generation, graph compile
  (materials, visual scripts), big projection diffs.

### 22.2 Optional render worker

- Spike: Play/export rendering in a worker with OffscreenCanvas
  (WebGPU/WebGL2 both), input forwarded; measure with the phase 21 harness.
  Adopt only if it wins on the benchmarks without breaking audio/input
  latency; otherwise document why not and keep the spike archived.

### 22.3 Physics details

- Rapier WASM in the worker, memory growth limits, disposal on unload; the
  physics query budget and overlap queries (9.9) unchanged.

### 22.4 Wrap-up

- Harness numbers before/after (phase 21) in §4; `docs/deployment.md`
  (threading mode, headers for SharedArrayBuffer, how to force single
  thread); STATUS row 22.

## 4. Progress

| Item | Status | Commits |
|---|---|---|
| 22.0 simulation worker | todo | |
| 22.1 editor workers | done 2026-09-25 | 61edf98 |
| 22.2 render worker spike | todo | |
| 22.3 physics details | todo | |
| 22.4 wrap-up | todo | |

## 5. Results and decision log

### 22.1 Editor-side workers (2026-09-25)

Measured with `tests/e2e/editor-workers.e2e.ts` (Chromium, `default`
project: WebGPURenderer on WebGL 2 over SwiftShader, 1920×1080), long tasks
(`PerformanceObserver('longtask')`, > 50 ms) over each job's window. Before =
the pre-22.1 editor bundle (main 7f68d81) served by the same backend
(`TL_EDITOR_DIR`), with one `performance.mark('tl:bake:rendered')` added after
its PNG encoding so both builds end the bake window at the same point; after
= this branch. Same host, shared with other agents' runs: **load average (1 /
5 / 15 min) before 12.5–15.6 / 12.6–13.4 / 12.4–12.6, after 12.3–15.0 /
12.0–12.9 / 12.2–12.4** (runs `221-before-3` and `221-after-2`,
`~/.cache/thirdlight-logs/`; the first runs of each, load 9.8–17.7, agree).
CPU-rendered: GPU work that a real GPU does in milliseconds shows here as
main-thread waits on the GPU process.

| Job (window) | before: long tasks / longest / total | after |
|---|---|---|
| Scatter 50 000 copies (click → set drawn + 3 s) | 2 / 92 / 147 ms | 3 / 117 / 253 ms |
| Bake preview, 13 static objects on a 40 m ground, 64 samples (click → baked, `tl:bake:rendered`) | 2 / 785 / 977 ms | 0 / 0 / 0 ms |
| Bake preview (click → the Scene view shows the new lightmap) | 3 / 1090 / 2067 ms | 1 / 78 / 78 ms (two other runs: 2533 and 2812 ms, see below) |
| 2 model thumbnails (connected → both tiles show one) | 2 / 1252 / 1331 ms | 0 / 0 / 0 ms |
| 5 edits of a 2000-node graph (Graphs list open) | 2 / 55 / 105 ms | 0 / 0 / 0 ms |
| 5 `setTransform` in a 3000-object scene | 0 | 0 |

Where the main thread went (CDP CPU profiles, `TL_WORKERS_PROFILE=1`, before):
the bake's CPU side — the conversion loop 126 ms, sRGB 121 ms, dilation
120 ms, the half-float read-back 67 + 24 ms, `getBufferSubData` 51 ms, PNG
`toBlob` 77 ms, in one task per atlas; a thumbnail's `toDataURL` 612 ms
(synchronous canvas read-back + encoding); the Problems tab's graph
diagnostics 26 ms per edit of the 2000-node graph (a per-problem `find` over
the nodes: every node of that graph has a warning). After, none of these is
on the main thread; the bake's total time is unchanged (10.1–12.7 s before,
12.4–13.3 s after, same load). Worker and inline give the same results: the
scatter buffer (same digest), the lightmap PNG (same sha-256), each thumbnail
PNG (same bytes) and the Problems count (2006), all compared in the e2e; the
unit tests (`tests/editor-workers.test.ts`) compare the jobs' outputs with
the pre-22.1 computations through a structured-clone channel. In the
`webgpu` project the worker bake on WebGPU passes `lightmaps.e2e.ts`
(shadow in the lightmap, observed in Play's pixels) and the thumbnails from
a WebGPU canvas snapshot are the same bytes as inline, with no long task.

What is left: the scatter was never long here (`scatterTransforms` 13 ms at
50 000 copies); its longest task is the Scene view building and drawing the
set (instancing, rendering: 21.3's area) and the buffer upload. After a
bake, the Scene view uploads the new atlas (`texSubImage2D` of the decoded
bitmap): 78 ms in one run, 2.5 and 2.8 s in two others — the upload waits for the GPU
process, which on this CPU renderer is busy drawing frames; it belongs to the
Scene view's GPU context (rendering). Projection diffs: after 21.4 a change
in a 3000-object scene has no long task; nothing moved.

Decision log (22.1):

- 2026-09-25 (22.1): one worker bundle, `dist/editor/editor-worker.js` (the editor package's `workers/editor-worker.ts`; three + three-adapter, 4.5 MB unminified, built by tools/build.mjs with the same pinned option set and the `three` → `three/webgpu` alias), with the job table shared with the page (`workers/jobs.ts`): the same functions run inline, so the results cannot drift. It uses only public exports (editor → three-adapter/protocol/project-model types), so the boundary check passes unchanged.
- 2026-09-25 (22.1): two lanes of the same script — `cpu` (one kept worker: scatter, diagnostics, PNG encoding) and `gpu` (a worker per bake, terminated after it: its renderer, scene and shadow maps are released at once and a bake never holds up the small jobs).
- 2026-09-25 (22.1): spike — WebGPURenderer runs in a dedicated worker on an `OffscreenCanvas` here, on WebGL 2 (both Playwright projects) and on WebGPU (the `webgpu` project), with `readRenderTargetPixelsAsync` working. So the whole browser bake moved, not only its CPU part; the baker's change is one optional `canvas` input (three-adapter `lightmap-baker.ts`), otherwise untouched.
- 2026-09-25 (22.1): the bake input crosses as copied typed arrays (position, normal, uv1, index, draw range; each geometry once, shared as before; the array type and `normalized` flag kept, interleaved attributes de-interleaved raw), so the GPU reads the same values and the Scene view's own arrays are never detached by the transfer.
- 2026-09-25 (22.1): UV1 boxes, the lightmap sizes and `packLightmaps` stay on the page: they read the Scene view's live objects and did not show in the profiles; moving them would copy every geometry twice.
- 2026-09-25 (22.1): thumbnails keep rendering on the page — the models are loaded there by the editor's asset loader (with its Draco/KTX2 decoders and the Scene view's cache); a worker would need a second loader and a second copy of every model. What was long was `toDataURL`; it is replaced by a `createImageBitmap(canvas)` snapshot taken in the render's task (no CPU read-back) whose PNG the worker encodes (`OffscreenCanvas.convertToBlob`); the page encodes it the same way when there is no worker.
- 2026-09-25 (22.1): graph compile — material graph → TSL for drawing stays with the renderer (node materials live there); what moved is the Problems tab's diagnostics: the kind's rules with data-dependent ports for standalone graphs and graph materials, and the material compiler's problems (`materialGraphProblems` builds the TSL nodes without a renderer, so it runs in the worker). The open graph editor keeps its own diagnostics and port resolution synchronous (it draws with them every frame); visual-script compile already happens on the backend and the editor has no other compile step for it. Worker results come a moment after an edit; a burst of edits runs one job per result (the newest input), stale results are dropped.
- 2026-09-25 (22.1): node labels of the Problems entries are looked up through a map instead of a `find` per problem (quadratic at 2000 warned nodes); the output is the same (tested against the old code).
- 2026-09-25 (22.1): fallback to inline — `?workers=off` (for comparisons and support), no `Worker` or `OffscreenCanvas`, a worker script that does not load within 30 s or errors (then no worker is tried again until reload, so no job waits twice), a worker that dies during a job (the job reruns inline from the caller's own data), and for the bake a worker canvas without a renderer (`bake_unsupported`). A job that fails in the worker reports its error (no silent rerun).
- 2026-09-25 (22.1): the e2e bound — no long task above 400 ms during a scatter of 50 000 copies (click → set drawn + 3 s) and a preview bake (click → `tl:bake:rendered`), with the load average logged. Generous and relative to this host: the pre-22.1 bake measured 785–980 ms there (so the bound catches it moving back), while the load on this shared CPU-rendered host (8–25) stretches every task several times; the scatter was never above ~120 ms, so for it the bound only guards against a regression. The Scene view's atlas upload after the bake is logged, not bounded (rendering).
- 2026-09-25 (run): 22.1 was built in parallel with 21.3/21.5 and 22.0 and merged first (editor-only worker seams).
### Results (22.0 + 22.3)

- Determinism: `tests/integration/m22-worker/parity.test.ts` runs a neutral
  level (player on Rapier, pickups, a patrolling stompable enemy, a moving
  platform, a one-way shelf, a checkpoint, a plate and door, a script that
  spawns coins on a timer and plays sounds) in the page and in the worker (a
  Node worker thread running the same game-host worker core as the browser
  bundles) and compares a digest of every executed step's committed state
  (game view, every transform bit for bit, counters, hidden entities, the
  scene set, the save state): identical for 1200+ steps with a recorded
  replay in frames of 0–3 steps, and with live per-step input one step per
  frame. The blocks suites (`m9-blocks`, 16 + 1 cases), the saves suite and
  the Sprout play-through run in both modes (Sprout: the same level times,
  deaths, counters and spawned coins in both).
- e2e (`tests/e2e/sim-worker.e2e.ts`): Play runs in the worker by default
  (transforms by messages; the editor is not isolated by default), with
  `?threads=off` in the page; in both a held key moves the player within
  2 frames (upper bound measured through the relays, which add their own
  round trips) and a pickup's sound request reaches the page's audio owner
  and plays; with `THIRDLIGHT_CROSS_ORIGIN_ISOLATION=1` Play is
  `crossOriginIsolated` and uses shared memory; the export runs in the
  worker (messages), in the page with `?threads=off`, and in the worker with
  shared memory under COOP/COEP headers, started and moved by the keyboard
  (pixels observed). The existing Play/export/flow/blocks/debugger/MCP e2e
  specs run in worker mode (the default).
- Harness (`node tools/perf/run.mjs --classes medium,large --surfaces play
  --renderers webgl2 --threads worker,off`), Play in the editor's preview on
  this CPU-rendered (SwiftShader) host shared with other agents; "before" =
  `threads=off` (the unchanged in-page composition), "after" = the worker,
  both in the same run. Main thread = the preview process's CDP
  `TaskDuration` per rendered frame (its workers excluded; the idle editor
  shares the process). Reports `~/.cache/thirdlight-perf/reports/22-play-medium-large.json`
  (run 1, worker first; load 11.0 → 14.1) and `22-play-medium-large-2.json`
  (run 2, off first; load 11.2 → 17.0). Commit d496734 + this branch
  (before the asset-read overlap below).

  | Play (webgl2) | medium off → worker | large off → worker |
  |---|---|---|
  | run 1: frame mean / p95 (ms) | 635 / 1467 → 638 / 1333 | 767 / 1467 → 226 / 1167 |
  | run 1: frames drawn in the 5 s window | 8 → 7 | 2 → 9 |
  | run 1: main thread per frame (ms) | 44.1 → 37.2 | 211.8 → 130.8 |
  | run 1: first frame after "Play" (ms) | 1364 → 2453 | 7356 → 15 527 |
  | run 2: frame mean / p95 (ms) | 571 / 1350 → 786 / 1700 | — (no frame drawn in the window) → 928 / 2617 |
  | run 2: frames drawn in the 5 s window | 8 → 6 | 0 → 3 |
  | run 2: main thread per frame (ms) | 42.7 → 45.6 | (275 ms in the window) → 182.2 |
  | run 2: first frame after "Play" (ms) | 1868 → 1534 | 17 407 → 8592 |

  Reading: on this host the frame rate is set by the CPU-rendered GPU
  process (a handful of frames per 5 s; the page's main thread is 5–23 %
  busy), and the page's main-thread time per frame is dominated by the
  render side (the adapter's sync of 2 000 / 16 000 objects and three's
  submission), so the gain cannot be separated from the noise: medium moves
  within it (the simulation is ≤ 1.4 ms of a frame there: ≤ 8 catch-up steps
  × 0.17 ms, 21.2), large shows less main-thread time per frame in run 1
  (212 → 131 ms; the simulation's share is ≤ 8 × 1.36 ms ≈ 11 ms) and more
  frames drawn in both runs, but with 0–9 frames per window this is not a
  measurement to lean on. The first-frame numbers flip with the order (the
  first measurement of a class pays the cold start), so worker start-up is
  not measurably slower; since these runs the worker composes while the
  page reads the assets. What is certain by construction: the page's main
  thread no longer runs any simulation step (the worker does), and a long
  step no longer blocks input or a frame. Real-GPU frame times: owner look
  pending.

### Results (22.2 render worker spike, 2026-09-25) — not adopted

What was built (`archive/spike-22-render-worker/`, outside the build and the
tests): a variant of the export page. The canvas goes to a render worker
(`transferControlToOffscreen`) that draws with the same `createSceneAdapter`
and options as the page (one shared options function), on WebGL 2 or WebGPU.
The simulation worker sends each frame to the page as before and also sends a
structured-clone copy straight to the render worker over a MessageChannel, so
the page's main thread does not relay it. The render worker keeps its own
`FrameMirror`. Input sampling, audio, HUD, menus, flow and saves stay on the
page. Quality, level look and title camera offset reach the worker as
messages. `?render=main` is the product composition with the same probes.
Play was not spiked. It composes the same host and adapter, but its relays
call the adapter synchronously (`captureScreenshot` for `tl_screenshot`,
`diagnostics` for the play diagnostics). Those calls would have to become
round trips to the render worker. The spike renders correctly: screenshots
(`--shots`) of the page's and the render worker's frames show the same
scene. Viewed: medium on WebGL 2 and large on WebGPU; only the particles
differ, since they are captured at different moments.

Measured with `node archive/spike-22-render-worker/run.mjs` (phase 21 pieces:
the benchmark generator and builder, the export, the API instrumentation,
installed in the render worker too). Classes medium and large, Chromium on
SwiftShader, 1280×720, 2 repeats in rotating order, a 5 s window per mode
while the run plays. Modes:

- product: the untouched export.
- main: the spike page with `?render=main`.
- worker-co: the render worker drawing the newest frame in a zero-delay task.
- worker-raf: the render worker drawing on its own animation frame.

Metrics:

- main thread: CDP `TaskDuration` of the page per drawn frame.
- audio: the simulation posting a frame → the page's host taking its audio
  requests.
- sim→drawn: the simulation posting a frame → that frame drawn.
- key→moved: a key's event time stamp → the first drawn frame in which the
  player's x moved (the input-to-photon proxy). It is also given in drawn
  frames.

Load average 10.1–17.8 at the start, 14.5–15.8 at the end, on a host shared
with other agents' runs. Report:
`archive/spike-22-render-worker/results/run2-2026-09-25.json`. Frames per
repeat; the other columns the lower of the two repeats' values
(`summarize.mjs`):

| Class / backend / mode | frames drawn in 5 s (repeat 1, 2) | main thread ms/frame (busy) | audio p50 / p95 ms | sim→drawn p50 / p95 ms | key→moved p50 / max ms | frames |
|---|---|---|---|---|---|---|
| medium webgl2 product | 10, 3 | 22.7 (2.4 %) | — | — | — | — |
| medium webgl2 main | 8, 4 | 22.7 (1.8 %) | 0.2 / 0.9 | 12 / 27 | 176 / 394 | 1 |
| medium webgl2 worker-co | 9, 5 | 1.2 (0.1 %) | 0.2 / 0.2 | 21 / 41 | 135 / 894 | 1 |
| medium webgl2 worker-raf | 7, 12 | 1.1 (0.3 %) | 0.1 / 0.4 | 27 / 909 | 206 / 320 | 1 |
| medium webgpu product | 4, 4 | 44.8 (3.5 %) | — | — | — | — |
| medium webgpu main | 4, 4 | 41.8 (3.3 %) | 0.1 / 0.4 | 21 / 31 | 353 / 389 | 1 |
| medium webgpu worker-co | 4, 2 | 1.2 (0 %) | 0.1 / 0.4 | 22 / 28 | 278 / 970 | 1 |
| medium webgpu worker-raf | 5, 3 | 1.2 (0.1 %) | 0.1 / 0.1 | 33 / 50 | 423 / 909 | 1 |
| large webgl2 product | 5, 3 | 90.3 (5.3 %) | — | — | — | — |
| large webgl2 main | 5, 4 | 83.1 (6.6 %) | 0.1 / 0.1 | 68 / 86 | 359 / 996 | 1 |
| large webgl2 worker-co | 6, 12 | 0.8 (0.2 %) | 0.4 / 3 | 81 / 102 | 970 / 2669 | 1 |
| large webgl2 worker-raf | 4, 4 | 3.4 (0.3 %) | 0.1 / 0.4 | 974 / 1430 | 526 / 1857 | 1–2 |
| large webgpu product | 2, 3 | 97.2 (5 %) | — | — | — | — |
| large webgpu main | 2, 3 | 110.8 (4.4 %) | 0 / 0.2 | 54 / 76 | 1053 / 1248 | 1 |
| large webgpu worker-co | 4, 0 | 0.7 (0 %) | (no frame in one window) | 74 (one repeat) | 841 / 1275 | 1 |
| large webgpu worker-raf | 4, 2 | 1.6 (0.1 %) | 0.1 / 0.1 | 1689 / 1712 | 904 / 2018 | 1–2 |

A first run (`results/run1-2026-09-25.log`, medium, stopped part way) measured
a third pacing: the render worker drawing every frame as it arrived, as the
page host does. It kept up on the small benchmark and failed on medium. The
page no longer waited for a draw, so it ticked the simulation every animation
frame, and frames queued behind the slow draws: sim→drawn p50 11.8 s and
41 s, with 4 and 2 of 6 key presses never seen moving within 4 s.

Reading:

- **Main thread.** The page's main thread goes from 23–111 ms per drawn
  frame to about 1 ms. That follows from how the spike is built. But the
  page's main thread was only 2–7 % busy in the current mode.
- **Frame rate.** On this host the frame rate is set by the CPU-rendered GPU
  process: 0–12 frames per 5 s in every mode. The differences between modes
  are within the spread between repeats of the same mode (medium webgl2
  main: 8 and 4 frames).
- **Latency.** The worker adds no measurable audio latency (sub-ms in all
  modes). Every mode shows the move in the first drawn frame after the key.
  Its milliseconds are the frame time and within the noise. The worker's
  sim→drawn delay is equal to or longer than the page's (it also carries a
  second copy of the frame).
- **Stalls.** The worker modes showed stalls that main mode never did: a
  5 s window with no frame and no host frame at all (large webgpu
  worker-co, and a small webgpu smoke run with 4 host frames in 3 s). The
  cause was not found.

So the spike does not win on the benchmarks here, and it adds real costs:

- a second pipeline to keep equal to the page's, with an async adapter
  surface for Play's relays;
- a per-frame copy of the transforms;
- a pacing choice that makes latency unbounded when it is wrong;
- stalls that were not explained.

Real-GPU numbers: owner look pending. On a real GPU the three.js submission on
the main thread (the 23–111 ms per frame measured here are mostly the
adapter's sync and submission of 2 000 / 16 000 objects) is what a render
worker would remove. Revisit when a real-GPU host shows the page's main
thread as the frame-rate limit.

### Decision log

- 2026-09-25 (22.0): the whole simulation moves as one unit — runtime with
  its fixed steps, Rapier, gameplay blocks, animators, timers, spawns, effect
  and sound requests, the project's scripts — composed in the worker by the
  same `composeGameRuntime` the in-page host uses (extracted from
  `createGameHost.mount`) — one place for the deterministic simulation, no
  second composition.
- 2026-09-25 (22.0): game flow, HUD, menus, audio, saves (localStorage) and
  rendering stay on the page and read the worker's committed state through a
  `Runtime`-shaped mirror (`startRemoteSimulation`), so `createGameHost` (and
  the three-adapter, unchanged) present it exactly as an in-page runtime; the
  host gets it through the new `GameHostConfig.runtimeFactory`. The flow's
  effects on the simulation are commands (startLevel, setPaused, run
  start/replay, scene loads, viewport) that reach the worker in order before
  the next tick and apply at its next step boundary — the boundary they reach
  in single-thread mode — so a flow driven by the same inputs gives the same
  run (the Sprout and save suites pass identically in both modes).
- 2026-09-25 (22.0): live input is sampled once per frame on the page (the
  browser input owner is DOM-bound, and sampling per step would need the page
  to predict the worker's step count) and expanded per step in the worker:
  the first step of a tick gets the sample, the rest its continuation
  (pressed → held, released → none — what a second sample in the same frame
  returns), and a tick without a step merges into the next keeping every
  edge. Recorded input (replays, the MCP input exercise) runs per step in the
  worker exactly as recorded. The first frame after start samples nothing
  (it runs the settle pre-roll or installs the clock, as in the page).
- 2026-09-25 (22.0): the page drives the worker's manual clock: one tick per
  animation frame with the page's clock, at most one tick in flight (a slow
  step never queues frames; the next tick covers more time with the
  runtime's bounded catch-up), and the host's frame (menus, HUD, sound,
  render) runs as soon as the worker's frame arrives — no added frame of
  latency.
- 2026-09-25 (22.0): transport — messages by default: per frame only what
  changed (the committed view when a step committed one, hidden/fading
  entities, poses, counters, save state, queued sound and effect requests,
  the scene set when rebuilt with each batch's entities sent once and spawned
  entities by a stable token so the renderer keeps its objects); transforms
  as Float64 (the page reads exactly the simulation's values — bots,
  observations and the parity test compare them), the full array or only the
  moved entities when fewer than 25 % moved, buffers returned for reuse. A
  two-slot SharedArrayBuffer carries the transforms only when the page is
  cross-origin isolated (one frame in flight makes one slot always free).
- 2026-09-25 (22.0): cross-origin isolation for Play is opt-in
  (`THIRDLIGHT_CROSS_ORIGIN_ISOLATION=1`: COOP + COEP on the editor page and
  every preview-origin response, CORP cross-origin on the play page, the
  iframe allows `cross-origin-isolated`). Off by default: the Play iframe is
  only isolated when the editor page is too, and isolating the editor blocks
  any cross-origin resource without CORP — a deployment decision; the
  message path gives the same results. Exports need nothing (COOP/COEP from
  the host enable shared memory; without them messages are used).
- 2026-09-25 (22.0): where the code lives — the worker core, the mirror,
  the per-tick input, the protocol and the threading choice are in
  `game-host` (DOM-free, no physics-rapier or dynamic-import edge: the two
  platform pieces — `createPhysicsPort` and the script importer — are
  injected by two small entries, `editor/src/preview/sim-worker.ts` (Play,
  `dist/preview/sim-worker.js`, served as `/sim-worker.js`) and
  `exporter/src/export-sim-worker.ts` (the export's `js/sim-worker.js`); Node
  tests use a third one over worker_threads). No new workspace package (it
  would change the shared lockfile/node_modules).
- 2026-09-25 (22.0): the worker is a separate bundle file, not a blob of
  source inside the main bundle — no second copy of Rapier/runtime in the
  page's bundle, no blob URL; the preview CSP gains `worker-src 'self'`.
  Rapier's WASM is inlined in that bundle (no URL); the export graph check
  and the forbidden-content scan run on it like on `js/main.js`.
- 2026-09-25 (22.0): project setting `sim_thread` (Engine → Simulation
  thread: 1 worker, 2 main thread; optional, absent = worker) through the
  settings descriptors; `?threads=off|on` overrides it (the editor passes its
  flag on to Play); no worker available → single thread. Every page logs its
  mode and transport; `tl_game_observe`/`tl_diagnostics` report
  `simulation {mode, transport, isolated}`, an export `window.__thirdlightThreading`.
- 2026-09-25 (22.0): the visual-script debugger (19.2) and the MCP input
  exercise run where the simulation runs: `PlayDebugger` and
  `RelayActionSource` moved to `game-host` (the editor UI keeps the
  debugger's wire types; it may not import the game host). What only the
  simulation can answer (script property values, the debugger, fresh
  diagnostics, physics rays) goes through one async surface (`SimAccess`) in
  both modes; the preview's observe/control/debug/diagnostics relays await it.
- 2026-09-25 (22.0): the mirror answers run-command validity with the game
  session's own rule on the mirrored state (so `control('start')` still
  refuses synchronously); a level switch the worker refuses is logged
  instead of refused synchronously (rare: the page checks the scenes exist).
- 2026-09-25 (22.0): the worker composes while the page reads and verifies
  the assets (they overlap); an asset failure disposes the worker before
  anything plays.
- 2026-09-25 (22.0): `sound.played {sfx, ui}` added to the observation's
  sound block (sounds the page's audio owner started) — the observable that
  a request made in the simulation reached the audio owner.
- 2026-09-25 (22.0): tests that captured script results in test variables
  (script queries, saves) now have the script keep them in `ctx.save` (a
  worker's script cannot reach the test's closures); the Sprout bot asks its
  rays in one batch per decision (the same rays, the same order). Single-mode
  ticks in the shared harness are awaited too, so scene loads resolve a few
  steps earlier than before — Sprout's level 2 time 15.9 → 15.8 s, identical
  in both modes.
- 2026-09-25 (22.3): Rapier runs in the worker with its WASM inside the
  worker bundle. Its WebAssembly memory is observed (physics-rapier watches
  `WebAssembly.instantiate` during the first init; the library exposes no
  handle) and capped at 512 MiB (`PHYSICS_MEMORY_CAP_BYTES`, an engine
  limit): past it the worker stops the simulation with
  `physics_memory_limit` instead of growing without bound. Stopping Play or
  leaving an export disposes the runtime (which frees the Rapier world) and
  acknowledges before the worker ends. The physics query budget and overlap
  queries are unchanged (the script-queries suite runs in both modes).
- 2026-09-25 (22.0): harness `--threads worker,off` and a `mainThread`
  metric (CDP `TaskDuration` per frame) added; metrics of `threads=off` runs
  get a `.threads-off` key suffix (the default worker keeps the old keys).
- 2026-09-25 (22.2): the render worker spike is **not adopted**. It is
  archived under `archive/spike-22-render-worker/`. That folder is outside
  the build, the typecheck and the tests, and has its own `tsconfig.json`
  for a manual `tsc -p`. No product code changed.
  - What it measured on this host: no frame-rate win. Frames drawn per 5 s
    are the same within the repeat-to-repeat spread, because the
    CPU-rendered GPU process sets the frame rate. Audio request latency is
    unchanged (sub-ms). Key-to-moved is the first drawn frame in every mode.
  - What it did gain: the page's main thread goes from 23–111 ms per frame
    to about 1 ms. But the page was only 2–7 % busy in the current mode.
  - Why that is not enough: unexplained whole-pipeline stalls in the worker
    modes, a per-frame copy of the transforms, and an async adapter surface
    that Play's relays would need.
  - Results are in §5 above. Revisit on a real-GPU host where the page's
    main thread limits the frame rate.
- 2026-09-25 (22.2): scope — the export only. Play composes the same host
  and adapter; its synchronous adapter calls (screenshot, diagnostics) are
  the extra work adoption would need. The two workers talk directly over a
  MessageChannel: the simulation worker sends the render worker a
  structured-clone copy of every frame message, before the page's copy
  transfers the transform buffer. The render worker keeps its own
  `FrameMirror`, so the main thread relays nothing. The simulation's
  shared-memory transport was not adapted for two readers.
- 2026-09-25 (22.2): pacing is the part that decides latency once the page
  no longer draws, because the page then ticks the simulation every
  animation frame. Three pacings were measured:
  - drawing each frame as it arrives, as the page host does: frames queued
    behind slow draws, 11.8–41 s behind on medium;
  - drawing on the worker's animation frame: up to ~1.7 s behind on large;
  - drawing the newest state in a zero-delay task queued after the frames
    that are already waiting (coalesce): as close as the page. The spike
    defaults to this.
- 2026-09-25 (22.2): the latency probes live only in the spike page and
  worker:
  - input: a key's event time stamp (so a busy main thread counts) → the
    first drawn frame in which the player's x changed, in ms and in drawn
    frames;
  - audio: the simulation's post time stamp on each frame → the page's host
    taking its audio requests (every frame, with or without sounds);
  - frame intervals: the phase 21 API instrumentation, also installed in
    the render worker, plus the adapter's own render times.
