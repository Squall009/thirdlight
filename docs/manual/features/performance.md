# Performance

How to measure your own game and what to aim for: [the performance guide](../guides/performance.md). This page describes the engine's own measuring tools.

## Performance

The engine is measured against written budgets with generated
benchmark projects and an automated harness. The budgets (frame time,
heap and GPU memory, load time, draw calls, simulation step cost and
garbage, editor command latency, per scene class) are in
`docs/plan-phase-21.md` §2 and `tools/perf/classes.ts`; they are for a
mid-range desktop GPU at 1920×1080. Measured numbers are in §4 there.

**Benchmark projects.** Five classes — small (100 entities), medium (2000
entities, 50 materials, 20 effects), large (16 000 entities over 10 scenes,
four instance sets of 50 000 copies, 200 colliders per scene), script-heavy (500 scripted objects),
effect-heavy (20 effects, 50 000 particles) — are generated
deterministically (`tools/perf/generate.ts`, seed 21) and built through the
real HTTP API into a throwaway data root under
`~/.cache/thirdlight-perf/runs/` (deleted after the run unless `--keep`).
Effects are generated with their emitter objects, and Play and exports draw them.

**Run the harness** (needs `dist/`; not part of `npm test` or the default
Playwright run):

```sh
npm run build
node tools/perf/run.mjs                                  # every class, WebGPURenderer on WebGL 2
node tools/perf/run.mjs --classes small,medium --quick   # a short smoke run
node tools/perf/run.mjs --renderers webgpu               # WebGPURenderer on (headless) WebGPU
node tools/perf/run.mjs --compare tests/perf/baseline.json   # exit 1 on a regression
```

Options: `--classes`, `--renderers webgl2,webgpu,auto` (`legacy` is accepted and draws with WebGL 2, as `?renderer=legacy` does), `--surfaces
play,export,editor,sim`, `--threads worker,off` (Play and the export with the simulation in the worker and/or with `?threads=off`), `--record-ms`, `--warmup-ms`, `--commands`,
`--sim-steps`, `--viewport WxH` (default 1280x720), `--seed`, `--keep`,
`--out FILE`, `--write-baseline FILE`, `--plays N` (N Plays in
the same editor page, each start split into its stages in the report and the
log; a class with scenes that do not start also loads one during the first
Play) and `--gpu` (draw on the host's GPU instead of SwiftShader). The
`asset-heavy` class has 48 distinct model files and 24 textures over
four scenes, one of which starts. For each class and renderer it
measures:

- **Play** (the editor's preview iframe) and the **export** (served by a
  plain static server): first-frame time, rendered-frame intervals
  (p50/p95/p99), draw calls and triangles per frame, live programs or
  pipelines, textures, buffers and an estimate of GPU memory — counted at
  the WebGL / WebGPU API, so WebGL 2 and WebGPU are
  measured the same way — the JS heap after a forced collection
  (`performance.memory`; `measureUserAgentSpecificMemory` needs a
  cross-origin-isolated page and is reported unavailable), and for Play
  three's own renderer counts from the play diagnostics;
- the **editor**: time to the Scene view's first frame, frame intervals while
  orbiting, heap, and the p95 round trip of `setTransform` commands with the
  project open; and (once per class) the Hierarchy — rows in the
  page, click-to-Inspector and rename latency, scrolling — and what each
  command costs after its response: the delay until the editor's second
  frame after the `mutation.applied` arrived, long tasks, WebSocket bytes per
  change, the bytes and files the backend writes (stat diff of the project
  folder, plus the process's `/proc` write counter), and the bytes one
  material edit puts on the socket;
- the **simulation** in Node (runtime, character controller, Rapier and the project's
  scripts, headless, `--expose-gc`): step cost percentiles and the bytes
  allocated per steady step.

The JSON report goes to `~/.cache/thirdlight-perf/reports/<time>.json`
(and `latest.json`) with the machine, its load average at start and end, the
calibrations and every number above.

**Regression check.** This server renders on the CPU (SwiftShader) and
shares its cores, so absolute times say little. The checked-in baseline
`tests/perf/baseline.json` stores only machine-independent metrics: counts,
memory, and times divided by a calibration measured in the same run (a fixed
raw-WebGL page for frame times, a fixed arithmetic workload for Node times).
`TL_PERF=1 npx vitest run tests/perf/regression.test.ts` runs the harness
and fails on a regression beyond the tolerance (`tools/perf/stats.ts`:
counts +10 %, memory +25 %, calibrated times +75 %);
`TL_PERF_REPORT=<report.json>` compares an existing report,
`TL_PERF_CLASSES=small` limits it and `TL_PERF_KINDS=count,memory` leaves
out the calibrated times (the noisiest here). The always-on check is
`tests/perf/plumbing.test.ts` (generator and comparison);
`TL_PERF=1 npx playwright test tests/e2e/perf-harness.e2e.ts` runs the whole
harness on the small benchmark (run it when `tools/perf` changes).
Frame and load times on a real GPU: owner look pending.

**The village class against plain three.js.** `node tools/perf/run.mjs
village` builds the village class (`tools/perf/village.ts`: ~1,000 entities,
650 placed models with `_LOD` levels, 50 instance sets, 20 animated skinned
figures, a block ground, 16 effect lights, the shadowed sun and the full post
stack; generated, no game content) through a private backend, exports it and
measures the export on the host's GPU at 1920×1080, DPR 1, uncapped, on WebGPU
and WebGL 2: fps and frame p50/p95/p99, the main thread's time per frame and
its split by package (a CPU profile), the Object3Ds three walks, draws,
triangles, uniform buffers and GPU time per render pass (three's timestamp
queries; WebGPU only — on WebGL 2 three times just the outermost pass). It
then dumps the drawn frame and measures the same content as a plain three.js
page (`tools/perf/bare/`) the same way. `--ablation` adds the per-draw
ablation on the plain page (+16 dark point lights, +per-object material
copies, +the engine's node materials, each alone); `--no-bare`,
`--renderers webgpu`, `--keep` (keep the run folder with screenshots and the
dump), `--vsync` (draw at the display's rate, as a player's browser does,
instead of uncapped: dropped frames show as intervals of two refreshes). Each
page's line also gives the frame max and a histogram (share of frames below
8.3, 11.1, 16.7, 25, 33.3, 50 ms and above). Reports go to `~/.cache/thirdlight-perf/reports/village-<time>.json`.
`tools/perf/games.sh [game-folder …]` (local, not in the gate) measures copies
of game projects the same way (default: the game folders the script names; the copy is what
gets registered, never the game's folder).

**The frame-time gate.** On a host with a usable GPU (`gpuAvailable()` in
`tests/e2e/browser-env.mjs`), `tools/gate.sh fast` ends with
`node tools/perf/run.mjs village --gate --check tests/perf/village-baseline.json`
(about 40 s): it fails when the export's median frame time on either renderer
is more than 10 % (`FRAME_REGRESSION` in `tools/perf/village-run.ts`) above
the baseline's (the median, not the mean: uncapped on WebGL 2 the GPU process
stalls for 100–300 ms every ~2 s once frames are fast, so the mean counts the
stalls that fell in the window; a baseline without a median is checked on its
mean), when its 95th-percentile frame time is more than 50 %
(`FRAME_P95_REGRESSION`) above the baseline's (generous: uncapped, WebGPU's
GPU-bound frames are bimodal, a few % of them near twice the median, on the
plain three.js page too), or when a renderer was not measured; `tools/gate.sh rerun`
repeats a failed check alone. Without a GPU it is skipped. The baseline holds
absolute times for this host's GPU, so it is re-recorded when the class
changes (`VILLAGE_VERSION`), on another machine, or when a change makes the
village faster on purpose:

```sh
npm run build
node tools/perf/run.mjs village --gate --write-baseline tests/perf/village-baseline.json
```

and the new file is committed with the change that moved it.

**The frame path: limits, constants and switches.** Each number below is
defined once, in the package named, and imported wherever else it is used:

| What | Value | Defined in | Why |
|---|---|---|---|
| Catch-up per frame (`MAX_CATCHUP_SECONDS`, `catchUpSteps`) | 100 ms of game time (12 steps at 120 Hz, 24 at 240 Hz; the rest dropped) | `runtime/src/frame-clock.ts`; the page's runtime, the simulation worker and the editor's dialogue preview | A slow frame must not make the next one slower; a time, so a 240 Hz game keeps real-time speed at 30 fps |
| Worker pipeline | One tick per drawn frame, sent on the animation frame before the draw; the page never blocks on it (Play diagnostics `simulation.pipeline`) | `game-host/src/sim-remote.ts` | Simulation and drawing overlap; one frame of latency accepted |
| Frame-rate cap (`FRAME_RATE_CAPS`, `FRAME_RATE_CAP_CHOICES`) | 30, 60, 120 or none | `project-model/src/frame-rate-cap.ts` | The values a game, a player setting and the UI action may set |
| Frame pacing (`EARLY_SHARE`, `DISPLAY_MATCH`, `DISPLAY_SAMPLES`, `DISPLAY_MIN_SAMPLES`) | A frame up to a quarter of the cap's interval and at most half a refresh early draws; a cap at ≥ 0.9× the display's rate draws every frame; the display's rate is the median of the last 15 intervals, pacing starts after 5 | `runtime/src/frame-pacing.ts` (the loop that uses it: `runtime/src/frame-loop.ts`) | vsync jitter must not move a draw to the neighbouring refresh |
| Block mesh workers (`MESH_WORKERS_MAX`, `meshWorkerCount`) | The host's cores − 2, at least 1, at most 2 | `three-adapter/src/block-mesh-pool.ts` | Leave the page and the simulation worker their cores |
| Edit meshing on the page (`SYNC_MESH_BUDGET_MS`) | An edit's chunks mesh on the page while their measured cost fits 8 ms a frame; the rest go to the workers | `three-adapter/src/block-layers.ts` | A small edit shows in the same frame, a large one never hitches |
| Worker meshes swapped in (`MESH_APPLY_BUDGET_MS`) | 4 ms a frame | `three-adapter/src/block-layers.ts` | Uploading many chunks at once would be the hitch the workers removed |
| Instancing and merge cell (`createAutoBatcher` options) | 64 m cells; an instanced group needs 4 members; geometry from 256 triangles is split per cell | `three-adapter/src/batching.ts` (static merging gets the cell size from the batcher) | Off-screen cells are culled while a cell still holds many objects |
| Culling inside a draw (`ViewCuller`, `VIEW_SAME_TOLERANCE`) | The members of a batch, the copies of an instance-set chunk and the objects of a merged cell are tested against the view one by one; those in view lead the draw nearest first and the view draws only them, shadow maps draw all; a draw is put in order again only when what is in view changes (camera matrices equal within 1e-9 count as still) | `three-adapter/src/view-cull.ts` | three culls a whole draw: a batch spread over the scene drew its members out of view too (the village class: 204k → 107k triangles a frame). The cell size then barely matters: 16, 32, 64 and 128 m measured within noise on the class and on a game's copy, so 64 m stays |
| Merged cells (`MIN_MERGE`, `MERGE_QUIET_MS`, `MERGE_BACKGROUND_BUDGET_MS`, `MERGED_RENDER_ORDER`) | At least 2 members; a moved static member rejoins after 500 ms still; the editor builds 4 ms of cells a frame (Play and the export at load); cells draw first (render order −1) | `three-adapter/src/static-merge.ts` | Cells are the level's occluders; a cell's centre would otherwise sort it behind what stands in front of it |
| Cached sun shadow (`STATIC_SHADOW_STEP`, `STATIC_SHADOW_TURN_DEGREES`) | The static map follows the camera in steps of half the shadow square's half side (1,288² texels at the default 1,024² map); drawn again at a step, a turn of more than 0.05°, or a change within its reach | `three-adapter/src/cached-shadow.ts` | Static casters are drawn once, not every frame; texels line up with the dynamic map |
| Effect lights (`EFFECT_LIGHT_LIMIT`) | 16 slots in one light node | `project-model/src/effect-graph-kinds.ts` | A fixed shader: a new effect light never recompiles, a dark slot costs nothing |
| Perf check (`FRAME_REGRESSION`, `FRAME_P95_REGRESSION`) | Export median frame time +10 %, p95 +50 % over `tests/perf/village-baseline.json`, either renderer | `tools/perf/village-run.ts` | See [the frame-time gate](#performance) above; re-record with the command there |

Switches, for comparisons (on the editor's URL they are passed on to Play;
on an export's URL they apply directly):

- `?batching=off` — no automatic instancing and no static merging: one draw
  per object;
- `?merging=off` — instancing kept, static merging off;
- `?shadowcache=off` — the sun's whole shadow map drawn every frame;
- `?threads=off` — the simulation on the page's main thread (a debug
  switch; also a play's `threads` and the `sim_thread` setting);
- `?frameRateCap=none|30|60|120` — pins the frame-rate cap;
- `?probes=off` — draws without the probe grids (the flat ambient light);
- `?vertexLights=off` — every local light per pixel;
- `?quality=<id>` — pins a quality level;
- `?ao=off|ssao|gtao`, `?renderScale=0.5…1`, `?dynamicResolution=on|off` —
  pin the render settings over the project's (an export's URL; the perf
  harness's `--switches`);
- `?upscale=bilinear` — a render scale below 1 upscaled with plain bilinear
  filtering instead of FSR 1;
- `?slowFrames=N` — dynamic resolution counts the first N seconds' frames as
  two frames slower than they were (a forced overload: the scale steps down,
  and back up after);
- `?simDelayMs=N` — slows the simulation worker by N ms a frame (tests of the
  pipeline);
- `?buildKeep=N` — holds a released node program or pipeline N ms (0 to the
  default 10,000) for a re-bake to reuse, then releases it (leak tests read
  the renderer's counts back sooner);
- `?workers=off` (editor only) — the editor's jobs inline (block meshing
  in Play and the export has no switch: without `Worker` it meshes on the
  page).

`node tools/perf/run.mjs village --switches 'batching=off,merging=off,shadowcache=off,threads=off'`
measures the export again with each switch in the same browser after its own
run (each one's share; the numbers are in `docs/plan-phase-28c.md` §6).
`--vsync --busy 5000 --switches 'frameRateCap=60,frameRateCap=30'` measures what a
frame-rate cap saves: busy time per second of the page's main thread, its
workers and the GPU process (a Chrome trace; three's pass timestamps include
the waits between passes, so they do not measure GPU busy time at a capped
rate).

**Instance sets cast no shadow unless they say so.** An instance set's
`castShadow` is off when absent (the Inspector's "Casts shadows" on an instance
set; `setComponent instances … castShadow: true`). Older engines had instance
sets cast the sun's shadow by default, so an existing game's foliage, scatter, rocks
and trees placed as instance sets stop casting unless the set turns it on;
boxes and models still cast by default.

**Runtime and simulation.** The fixed step does not allocate per
entity: the step's backup and the committed state are reused copies that are
overwritten in place (one pass over index-aligned arrays), the motion segments
are numbers (the frozen segment objects are made only when a module asks for
one), and the state views, step contexts and script contexts are made once
per module, phase and script instance and read the step's values live. Intent
checks, action frames, timers, trigger events, messages, trigger decisions and
the committed game view avoid per-step collections; the
physics port visits only its one-way and moving colliders. Garbage per steady
step is a constant 13–60 KiB whatever the size (what is left: Rapier's JS
glue, the physics results and scripts' own intents; per-entity copies once
cost ~1.4 KiB an entity), and a 16 000-entity step takes ~1.4 ms. The render
side reads the interpolated transforms through `forEachInterpolated` (reused
arrays; no per-frame copy of every transform) and the host reads the
committed game view without copying it each frame. The per-step intent cap
grows with the script instances (see
[Engine limits](tuning.md#engine-limits-constants)). `tests/perf/alloc.test.ts` (always on; needs
`dist/`) builds the medium benchmark and fails when its steady step allocates
64 KiB or more; `node tools/perf/run.mjs --surfaces sim` measures every
class, and the sim child's `profile` input (tools/perf/sim.ts) writes the
steady loop's allocation sites.

**Large projects in the editor.**

- *Play of a large project.* The editor gets `play.started` over its
  WebSocket, whose messages are at most 1 MiB. A runtime snapshot that does
  not fit (a few thousand entities and up) is not sent inline: the message
  carries a reference, and the editor fetches the snapshot from
  `GET /api/v1/projects/<id>/play/<playSessionId>/snapshot` (owner token)
  and hands it to the preview. If that fails, the editor shows the
  error and the play stops. Nothing waits silently on the frame bound: an
  oversized change record makes the editor re-read the project instead, and
  any other oversized message is dropped with an entry under Problems.
- *Changes on the socket.* A `mutation.applied` carries the change without
  its "before" side (the HTTP result and the undo history keep it), and a
  change to a keyed list (materials, animators) carries only the items that
  changed plus the order, so one material edit in a project with 500
  materials is one material on the wire.
- *The editor's projection* updates incrementally: a change replaces only the
  entities it touched, the Hierarchy rebuilds its rows only when the tree's
  shape or names change and draws only the rows in view (above 400 rows),
  and the editor's panels keep what did not change, so a transform edit does
  not redraw every panel. The Scene view syncs only the changed objects
  (below).
- *Commands.* A command runs against its one scene; only that scene's file
  (and, when content changed, `content.json`) is written, in the one-item-per-
  line layout above. Unchanged scenes are no longer re-serialized to find out
  they did not change.
- *Thumbnails.* The cache keeps its per-project count (a write no longer lists
  the cache) and answers revalidation (`ETag` / `If-None-Match`) with 304.
- The editor bundle uses React's production build.

**Editor workers.** Heavy editor jobs run in a worker
(`dist/editor/editor-worker.js`, loaded next to the editor page on first
use), so the page keeps answering input while they run:

- *Bake preview (browser):* the whole bake — drawing the lightmaps with
  WebGPURenderer on an `OffscreenCanvas` (WebGPU or WebGL 2, the editor's
  renderer choice), reading them back, filling the padding, sRGB and the PNG
  encoding — runs in its own worker, which ends after the bake. The Lighting
  window's message says "(in a worker)". Placing the lightmaps in the atlas
  still happens on the page (it reads the Scene view's objects).
- *Asset thumbnails:* the model is still drawn on the page (the loaded models
  live there), but the PNG is encoded in the worker from a snapshot of the
  canvas instead of a synchronous read-back.
- *Instance set scatter:* the placements are computed in the worker.
- *Problems tab:* the diagnostics of graphs and graph materials (the kind's
  rules and the material compiler's problems) are computed in the worker and
  appear a moment after an edit. The open graph editor checks its own graph
  on the page.

Every job gives the same result on the page: add `?workers=off` to the
editor URL (like `?renderer=webgl2`) to run them all inline. The editor does so by itself when the browser has no
`Worker` or `OffscreenCanvas`, when the worker script does not load (it is
not tried again until the page reloads), when a worker stops during a job,
and — for the bake — when the worker's canvas gets no renderer. The editor
page needs no extra headers for this (no SharedArrayBuffer is used). Numbers
(main-thread long tasks before and after) are in `docs/plan-phase-22.md` §5;
`tests/e2e/editor-workers.e2e.ts` measures them.

**Rendering.**

- *Automatic instancing.* Play, exports and the Scene view draw repeated
  objects together: boxes, and the meshes of placed models, that share a
  geometry, a material and their shadow flags become one instanced draw
  (boxes of any size share one unit box scaled by their size; boxes with the
  same colour or surface values share one material). Nothing to set up and
  nothing changes in the picture: every object stays an object — selection,
  picking, the gizmo, bounds, bakes and per-object looks (the selection
  tint, a look override, a fade, a lightmap, per-object graph material
  parameters) work as for any object; an object with its own look is drawn on its
  own. A group needs at least four members; transparent, skinned and morphed
  objects are always drawn on their own; detailed geometry (256 triangles
  and up) is grouped per 64 m cell so off-screen parts are still culled.
  `?batching=off` on the editor, Play or export URL draws one object per
  draw call (for comparisons).
- *Instance sets* are drawn in chunks of about 2048 copies (at most 64 per
  set by count, 256 when also split by extent; see
  [Instance sets](instance-sets.md#instance-sets)): chunks out of view are
  culled, and a model with levels of detail draws each chunk at the level
  its distance asks for.
- *Render on demand.* The Scene view draws only when something changed: an
  edit, a camera move, a selection, an arriving model or texture, an
  animated material (wind, water) or a playing effect preview. Left alone it
  draws nothing (three's own animation-frame tick still runs, drawing
  nothing). After an edit it syncs only the objects the edit touched.
- *Play is not paid for twice.* While the Game view is in front the Scene
  view draws nothing at all, animated materials and effect previews
  included; shown again (its tab during Play, or after Stop) it draws from
  the next frame. A Scene view lent to an editor window's preview pane keeps
  drawing there.
- *MSAA is the quality level's choice.* The environment's (or the player's)
  quality level decides: the engine's low draws without MSAA, medium and high
  with it, and a project's level says with `msaa` (a post stack uses its own
  anti-aliasing instead). The Scene view follows the project's level with the
  editor lighting too, and Play applies a player's level also in projects
  without an environment.
- *Textures.* Decoded textures get mipmaps (three's default trilinear
  filtering); imported GLB files may carry KTX2/Basis textures (read by the
  importer and transcoded in the browser). The backend encodes PNG/JPEG
  textures to KTX2 on import and packs texture arrays; see
  [KTX2 textures](assets.md#ktx2-textures).
- *What the view reports.* The Scene view's canvas carries `data-frames`
  (frames drawn), `data-draw-calls` and `data-triangles` (the last frame),
  `data-batches` (instanced groups, objects drawn through them, marked
  objects drawn alone), `data-msaa` (samples) and `data-sync` (what the last
  sync touched). Play's diagnostics (`tl_diagnostics`) carry `batching` and
  `frame` (draw calls, triangles); an export's canvas carries
  `data-tl-draws` and `data-tl-msaa`. The harness adds the Scene view's
  frames while idle and its draw calls while orbiting.

**Memory.** What is opened and closed again gives its memory
back: an editor session with many tab, preview and Play round trips, and a
game that loads and unloads scenes or spawns and destroys objects for a long
time, stay at the memory they started with.

- *Closed windows and previews* (the editor window's preview pane, which
  draws materials, effects, models with their animator, timelines,
  conversations and UI documents, and the asset preview) release their
  renderer at once — also the WebGL context or the WebGPU device (browsers keep up
  to ~16 WebGL contexts and then drop the oldest, which could be the Scene
  view's) — and nothing keeps the closed pane reachable.
  Switching the renderer backend (the project setting) replaces the Scene
  view's canvas the same way.
- *Play stop and new Play snapshots* release the game's input listeners, its
  sound (the audio context, looping sounds, music) and the page listeners; the
  simulation worker ends with the play.
- *Scene unloads, level restarts and destroyed spawns* release their objects
  in the renderer (render objects, shadow maps, instancing buffers, per-object
  material copies of fades and look overrides) as well as the objects
  themselves; a project material's built copy goes with its last object.
- *The Scene view* releases what a closed editor scene or a removed object
  used (also lightmapped material copies) and the edit-mode effect preview's
  material holders.
- Three.js (0.186) itself keeps some GPU objects until the garbage collector
  finds them (WebGL programs, shaders and vertex arrays) or never frees them
  (a texture shared between renderers kept every renderer that drew it); the
  engine releases these explicitly through the renderer's internals of the
  pinned three version (guarded: another version would only lose the early
  release).

`tests/e2e/memory.e2e.ts` checks it: each document tab kind opened and closed
50×, the preview panes 50×, an editor scene closed and opened 50×, instancing
groups formed and dissolved 50×, the backend swapped 10×, Play started and
stopped 20×, and in one Play session an additive scene loaded and unloaded
50×, a level restarted 20× and ~100 spawned pairs destroyed — the JS heap
(after a garbage collection), the WebGL/WebGPU objects per live context and
the renderer's own counts come back to where they were. The Scene view's
canvas carries the renderer's counts in `data-memory`; Play's diagnostics
(`tl_diagnostics` renderer.gpu) carry the same counts. Run it after
`npm run build` with `TL_MEMORY=1 npx playwright test tests/e2e/memory.e2e.ts` (both
projects; 10–15 min on a CPU renderer; `[memory] …` lines print each
scenario's baseline and end counts); `TL_MEMORY_CYCLES=5` shortens it for a
quick smoke run. Without `TL_MEMORY=1` the spec is skipped (the full gate
sets it).

**Scale bench.** A project of a full game's size — 10,000 voice lines
(Ogg Opus, 1–15 s), 1,000 other sounds, 5,000 textures, 2,000 models, 5,000
prefabs, 2,000 materials, 300 scenes, 2,000 voiced dialogue lines — is
generated deterministically (`tools/perf/scale-generate.ts`) straight into the
backend's on-disk format, every file distinct and every asset record the one
the backend's own inspector makes from its bytes. The bench
(`tools/perf/scale.ts`) opens it with a real backend and the editor in
Chromium and measures the open, one command's latency (a scene edit and a
content edit), the Play start, 50 scenes loaded and unloaded one after
another (load times, heap, graphics objects, asset bytes read, the backend's
resident set), a 500-line voiced dialogue played through (each line's start
to its voice playing, and the silence between voices) and the export (time,
files, bytes, the exported page's first frame). It also checks the game
folder's files (`files`), drives the editor at that size (`editor`: open to
usable, a scroll through every tile, a picker search, a placement, a line's
voice, and the project window labelling and moving 1,000 files and undoing
both), loads the labelled assets through a script's handle and releases them
(`handles`), and, when named, imports a folder of new voice files (`import`)
and streams large KTX2 textures under a small budget (`stream`). The
renderer that drew Play is in the report. A step that cannot be taken
records why (a refused open, a Play build that fails).

```sh
npm run build
node tools/perf/run.mjs scale --preset full --gpu        # the full size (about 25 min today)
node tools/perf/run.mjs scale --preset small             # a few of each (seconds)
node tools/perf/run.mjs scale --factor 0.1 --lines 200   # the full size × 0.1
node tools/perf/scale-summary.mjs ~/.cache/thirdlight-perf/reports/scale-*.json
```

Presets: `full`, `caps` (every kind at the count caps older engines had), `half-caps`,
`small`, `starter` (the Starter template, nothing generated). Options:
`--steps files,open,commands,editor,import,play,walk,handles,dialogue,stream,export`
(export last: it stops the backend), `--import N`, `--stream N --budget MB`,
`--walk N`, `--lines N`, `--commands N`, `--seed N`,
`--renderer webgl2|webgpu`, `--gpu`, `--keep`, `--out FILE`.
The generated project is kept under `~/.cache/thirdlight-perf/scale/<preset>/`
and copied for each run. `tests/e2e/count-caps.e2e.ts` (in the fast gate)
runs the files, open, commands, play, walk and export steps on a project over
every old count cap. The measured numbers are in
`docs/plan-phase-26.md` §6.
