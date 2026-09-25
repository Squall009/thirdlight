# Phase 21 — Performance and memory pass

Goal: every feature built so far is fast and lean, measured against written
budgets by an automated harness, so regressions show up in tests. Read
`docs/roadmap.md` (principles) first.

## 1. Decisions

- Budgets first, then optimisation: nothing is "optimised" without a
  before/after number from the harness recorded in §4.
- Budgets are generic (per scene size class), not tuned to the demo.

## 2. Work items

### 21.0 Budgets and benchmark scenes

- Write budgets in this file: frame time (Play: 60 fps target on a
  mid-range GPU, 16.6 ms; editor Scene view ≤ 16.6 ms while orbiting),
  JS heap and GPU memory per scene class, load time (first frame of the
  export), draw calls, garbage per simulation step (0 allocations in the
  steady step loop as the goal), editor command latency (p95).
- Generated benchmark projects (neutral, scripted — not Sprout): small
  (100 entities), medium (2k entities, 50 materials, 20 effects), large
  (16k entities incl. instance sets of 50k copies, 10 scenes), script-heavy
  (500 script instances), effect-heavy (50k GPU particles).

#### Budgets (written 2026-09-25, 21.0)

Generic per scene class, never tuned to a demo. The reference machine for
frame and load times is a **mid-range desktop**: a 2020-class mid-range GPU
(GTX 1660 / RX 5600 / Apple M1 class) at 1920×1080, device pixel ratio 1,
and a 4-core ~3 GHz CPU. This server renders on the CPU (SwiftShader), so
its absolute frame and load times are not judged against these budgets
(owner look on a real GPU); its runs are judged relative to a stored
baseline (21.1). `tools/perf/classes.ts` holds the same numbers.

| Budget | small | medium | large | script-heavy | effect-heavy |
|---|---|---|---|---|---|
| Play frame time p95 (60 fps) | 16.6 ms | 16.6 ms | 16.6 ms | 16.6 ms | 16.6 ms |
| Editor Scene view frame time p95 while orbiting | 16.6 ms | 16.6 ms | 16.6 ms | 16.6 ms | 16.6 ms |
| JS heap, exported game (after GC) | 64 MiB | 128 MiB | 384 MiB | 128 MiB | 128 MiB |
| JS heap, editor with the project open | 128 MiB | 256 MiB | 768 MiB | 192 MiB | 192 MiB |
| GPU memory (buffers + textures) | 64 MiB | 256 MiB | 512 MiB | 128 MiB | 256 MiB |
| Export: first frame from navigation | 1.5 s | 3 s | 6 s | 2 s | 2 s |
| Editor: Scene view first frame from navigation | 3 s | 5 s | 15 s | 4 s | 4 s |
| Draw calls per Play frame | 150 | 600 | 1500 | 700 | 200 |
| Simulation: one 120 Hz step p95 (Node, runtime + physics + scripts) | 1 ms | 1 ms | 2 ms | 2 ms | 1 ms |
| Garbage per steady simulation step | 0 B (goal) | 0 B | 0 B | 0 B | 0 B |
| Editor command round trip p95 (HTTP, editor open) | 50 ms | 100 ms | 250 ms | 75 ms | 50 ms |

Why these numbers: 16.6 ms is one frame at 60 Hz; at 120 Hz simulation two
steps run per frame, so ≤ 2 ms per step leaves ≥ 12 ms of the frame for
rendering; zero garbage in the steady loop means no collector pauses in
play; a command round trip under ~100 ms feels immediate in the editor; draw
calls scale with what a class shows (instancing and batching, 21.3, are how
large scenes stay under 1500). Heap and GPU memory budgets leave room for the
browser on an 8 GB machine.

#### Benchmark classes (21.0)

`tools/perf/generate.ts` generates each project deterministically from the
class and a seed (default 21): a neutral platformer lane with a floor and
platforms (colliders), background blocks, props of a generated three-piece
model kit (two LODs and a collision box per piece), scripted boxes (five
generic scripts: spin, bob, timer counter, raycast probe, messages), effect
emitters, point lights and instance sets. Every class carries a little of
everything; its headline is the class's own emphasis:

| Class | Entities | Scenes | Materials | Effects × particles | Scripted | Instance sets × copies | Props |
|---|---|---|---|---|---|---|---|
| small | 100 | 1 | 4 | 1 × 200 | 4 | 1 × 1000 | 10 |
| medium | 2000 | 1 | 50 | 20 × 500 | 20 | 2 × 5000 | 400 |
| large | 16 000 | 10 (all start scenes) | 50 | 20 × 500 | 50 | 4 × 50 000 | 5500 |
| script-heavy | 600 | 1 | 8 | 1 × 200 | 500 | 1 × 1000 | 20 |
| effect-heavy | 100 | 1 | 4 | 20 × 2500 (50 000) | 4 | 1 × 1000 | 10 |

`tools/perf/build.ts` builds a plan into a project through the real HTTP API
(commands, stages, the model import, behavior publishing, instance buffers).
Effects are generated now but drawn only after 20.2.

### 21.1 Harness

- A Playwright/Node harness that loads each benchmark in Play/export and
  the editor, records frame times (percentiles), heap (performance.memory /
  `measureUserAgentSpecificMemory` where available), renderer info (draw
  calls, programs, textures, geometries), load timings, simulation step
  cost and allocations (Node for the runtime, with `--expose-gc` counters),
  and writes a JSON report under `~/.cache/thirdlight-perf/`. A CI-style
  test fails on regressions beyond a tolerance against a stored baseline
  (CPU-rendered here: compare relative, not absolute, and label real-GPU
  numbers owner-look).

### 21.2 Runtime and simulation

- Zero-allocation step loop (reuse vectors/arrays in blocks, animator,
  intents, physics port results); interpolation without per-frame object
  churn; bounded queues; profile Rapier usage (query pipeline updates,
  kinematic updates).

### 21.3 Rendering

- Instancing for repeated models (automatic batching of identical
  model pieces), material and program deduplication, texture compression
  (KTX2/Basis on import as an option, mipmaps), frustum/LOD culling
  (the 9.0 LODs), shadow cascades/extents tuned by data, lightmap atlas
  packing, render-on-demand in the editor when nothing changes.

### 21.4 Editor and backend

- Projection/hierarchy with 16k entities (virtualised lists, incremental
  updates), Inspector re-render costs, graph editors with 2000 nodes,
  command round trip and write sizes (v4 per-scene files), thumbnail cache,
  WebSocket message sizes.

### 21.5 Memory

- Dispose paths audited (every Object3D/geometry/material/texture/render
  target released on scene unload, preview close, tab close), leak tests
  (open/close a tab or load/unload a scene 50 times: heap and renderer
  counts return to baseline).

### 21.6 Wrap-up

- The report of before/after numbers in §4; `docs/deployment.md` "Performance"
  section (budgets, how to run the harness); STATUS row 21.

## 3. Progress

| Item | Status | Commits |
|---|---|---|
| 21.0 budgets and benchmarks | done 2026-09-25 | f5f331c |
| 21.1 harness | todo | |
| 21.2 runtime | todo | |
| 21.3 rendering | todo | |
| 21.4 editor and backend | todo | |
| 21.5 memory | todo | |
| 21.6 wrap-up | todo | |

## 4. Results and decision log

### Results

First baseline ("before"), 2026-09-25, commit 973524f, report
`~/.cache/thirdlight-perf/reports/baseline-2026-09-25.json`; relative
metrics checked in as `tests/perf/baseline.json`. Machine: i5-12600H (10
cores), 16 GiB, no GPU — WebGL 2 and WebGPU on SwiftShader (CPU), viewport
1280×720; shared with other agents' test runs: **load average 8.0 at the
start, 18–26 during the browser measurements, 18.0 at the end** (the load
at each measurement is in the report). CPU calibration 10.3 ms at the start,
14–23 ms per class. Frame and load times below are CPU-rendered and noisy:
compare them only with runs on this host under similar load; on a real GPU
they are owner look. Legacy renderer unless noted (webgl2 = WebGPURenderer
on WebGL 2, in the report).

| Before (legacy) | small | medium | large | script-heavy | effect-heavy |
|---|---|---|---|---|---|
| Play frame mean / p95 (ms) | 89 / 200 | 1311 / 2000 | — (Play does not start, see log) | 132 / 483 | 114 / 217 |
| Play draw calls / triangles per frame | 38 / 48k | 921 / 491k | — | 170 / 50k | 36 / 48k |
| Play first frame after "Play" (ms) | 1118 | 7658 | — | 1850 | 1473 |
| Heap editor + Play (MiB) | 46 | 138 | — | 69 | 46 |
| Export first frame (ms) | 540 | 766 | 2956 | 933 | 506 |
| Export frame mean (ms) / draw calls | 183 / 27 | 1639 / 632 | 150 / 537 | 275 / 131 | 230 / 27 |
| Export heap (MiB) / GPU estimate (MiB) | 20 / 2.2 | 46 / 3.7 | 212 / 14.6 | 26 / 2.3 | 20 / 2.2 |
| Editor Scene view first frame (ms) / connected (ms) | 581 / 904 | 577 / 1673 | 1481 / 16 017 | 1036 / 2077 | 966 / 1596 |
| Editor orbit frame mean / p95 (ms) | 42 / 67 | 152 / 300 | 561 / 4683 | 72 / 117 | 51 / 117 |
| Editor draw calls per frame / heap (MiB) | 139 / 27 | 2221 / 77 | 16 233 / 402 | 621 / 44 | 128 / 27 |
| Command round trip p50 / p95 (ms) | 19 / 30 | 169 / 190 | 332 / 666 | 64 / 96 | 28 / 55 |
| Sim step p50 / p95 (ms) | 0.44 / 0.75 | 2.8 / 13.4 | 19.5 / 34.6 | 2.5 / 5.5 | 0.30 / 0.70 |
| Garbage per steady step | 236 KiB | 2.6 MiB | 20.8 MiB | 2.2 MiB | 225 KiB |
| Build through the API (ms / commands) | 797 / 29 | 4914 / 109 | 35 304 / 233 | 1040 / 37 | 836 / 48 |

Headlines for 21.2–21.5 (all generic, none demo-shaped): the step loop
allocates ~2.3 KiB per entity per step (20.8 MiB at 16k entities; the goal
is 0) and a 16k-entity step costs ~20 ms (budget 2 ms); Play of a large
project never starts (below); draw calls are one per object (921 for 2000
entities: no instancing of repeated boxes/kit pieces yet), programs are few
(4 legacy); the editor draws every object (16 233 draw calls at 16k) and a
command round trip grows with the project size (666 ms p95 at 16k).

### Decision log

- 2026-09-25 (21.0): budgets written per scene class for a mid-range desktop (2020-class GPU, 1920×1080, 4-core CPU) — generic sizes, not the demo; frame time is judged at p95.
- 2026-09-25 (21.0): the benchmark generator is a pure function of class and seed (mulberry32, no clock or Math.random) and builds through the real HTTP API (commands, stages, the model import, behavior publishing, instance buffers), fresh for each run (the large class builds in ~20–35 s), so no cached project can go stale.
- 2026-09-25 (21.0): every class carries a little of everything (materials, a generated three-piece model kit with LODs and collision, five generic scripts, effects, point lights, an instance set) so every path is exercised; the class's own emphasis is its headline number.
- 2026-09-25 (21.0): large = 10 scenes, all start scenes (the stress case is everything loaded at once), 4 instance sets of 50 000 copies (200 000 copies), 16 point lights (the model allows 16 in the loaded start set).
- 2026-09-25 (21.0): colliders are capped at 200 over a class's start scenes: the model allows 256 colliders per scene **and in the merged start set** (the export refused 2000; Play and exports cannot load more at once) — an engine limit a large world meets early; input for 21.4.
- 2026-09-25 (21.0): colliders stay ungrouped (physics-bearing objects must be roots); other objects sit in groups of 15 under a parent group (a flat but realistic hierarchy).
- 2026-09-25 (21.0): the moving scripts (spin, bob) move on one step in four (a slot from the entity id): the runtime caps one behavior at 64 intents per step over all its instances (`behavior_intent_limit`), so 200 moving instances failed the run at step 0; staggering keeps script-heavy at 500 instances — the cap is an input for 21.2.
- 2026-09-25 (21.0): pastes are split at group boundaries to stay under the 64 KiB command request cap (256 entities of the generated shape are ~68 KiB).
- 2026-09-25 (21.1): measurement at the graphics API (an init script wrapping WebGL/WebGL 2 draw/create/delete/bufferData/tex* and WebGPU createBuffer/createTexture/pipelines/draw*), not in the product: the legacy renderer and WebGPURenderer (WebGL 2 or WebGPU) are counted the same way, and the export bundle stays untouched. GPU memory is an estimate (buffer bytes, level-0 texels × 4, × 4/3 with mips). Play also reports three's own counts from the play diagnostics.
- 2026-09-25 (21.1): frame time = interval between animation frames that drew something, headline = mean: SwiftShader's GPU process runs behind the page, so rendered frames come in bursts and the median understates the cost (the editor's orbit p50 read 16.7 ms at 2221 draws).
- 2026-09-25 (21.1): the editor orbit is driven in the page (a real press on the Scene view, then one synthetic pointer move per animation frame), so input round trips never starve the renderer.
- 2026-09-25 (21.1): heap = `performance.memory` after `gc()` (Chromium with `--enable-precise-memory-info --js-flags=--expose-gc`); `measureUserAgentSpecificMemory` needs a cross-origin-isolated page and is reported unavailable. Play's heap includes the editor (same site, one renderer process).
- 2026-09-25 (21.1): simulation garbage = used-heap growth over a window of steps after a forced collection, discarding windows during which V8 collected (seen through `PerformanceObserver('gc')`) and halving the window until clean; the child runs with `--expose-gc --max-semi-space-size=64`. The harness input source reuses one frame object (the runtime copies it) so harness garbage is not counted.
- 2026-09-25 (21.1): the baseline holds only machine-independent metrics — counts, memory, and times divided by a calibration measured just before each class (a fixed raw-WebGL 2 page for frame times, a fixed arithmetic loop for Node times) — with tolerances counts +10 % (+2), memory +25 % (+2), calibrated times +75 % (+0.25); the opt-in test is `TL_PERF=1` (`TL_PERF_KINDS=count,memory` drops the noisy times). The always-on checks are the generator/plumbing unit tests and one short e2e on the small class.
- 2026-09-25 (21.1): viewport 1280×720 on this host (1080p on SwiftShader makes the heavy classes take minutes per frame); renderers legacy + webgl2 by default, webgpu/auto opt-in (they add the headless WebGPU flags).
- 2026-09-25 (21.1): finding — Play of the large project never starts: the backend holds the `play.started` message when it exceeds the 1 MiB WebSocket frame bound (the large snapshot is ~10 MiB; `play-routes.ts` logs "held") and the editor waits forever with no notice. The export of the same project runs. Input for 21.4 (deliver the snapshot by reference or in chunks, and show an error).
