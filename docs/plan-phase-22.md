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
| 22.1 editor workers | todo | |
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
