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
| 21.0 budgets and benchmarks | todo | |
| 21.1 harness | todo | |
| 21.2 runtime | todo | |
| 21.3 rendering | todo | |
| 21.4 editor and backend | todo | |
| 21.5 memory | todo | |
| 21.6 wrap-up | todo | |

## 4. Results and decision log
