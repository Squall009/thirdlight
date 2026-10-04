# Phase 28c — Performance baseline

Goal: close the gap between Thirdlight and plain three.js before anything else
is built on top. Skyforge's village draws at 55 fps in the export and at
110–150 fps as the same scene in bare three.js (`docs/verdict-2026-10-04.md`
§3), so about 11 ms of every 18 ms frame is our own overhead. This phase removes
that overhead, then moves forward the planned items that take frame time below
bare parity (static batching, cached shadows), so lighting (29), blocks (28b)
and level building (30) start from a fast base. Read `docs/roadmap.md`
(principles 1, 1b and 7) first.

Phase 28c runs **before** 28b (owner, 2026-10-04). Items moved here keep a
pointer in their old plan.

## 1. Owner decisions (2026-10-04)

- Performance first: the overhead found by the audit is fixed before any new
  feature work, and the planned performance items that block the games'
  vertical slices move here.
- **three.js is the renderer, nothing more.**
  - Entities live in the runtime's own data.
  - The three.js scene holds only what is drawn: meshes, instanced and
    batched draws, lights, and the bones of skinned meshes.
  - Logic-only entities, empty transforms and grouping never become
    Object3Ds.
- **LOD keeps one level.** Only the level being drawn is handed to three.js.
  The other levels are data, attached only when the switch picks them.
- **The simulation runs in parallel, one frame behind.** The page draws
  between the last two finished steps while the worker computes the next one.
  The page never waits on the worker. One frame of latency at 60 fps is
  accepted.
- **The target is to beat plain three.js.** Run the same measurement on both:
  the village must run faster in Thirdlight than as an unoptimized plain
  three.js scene of the same content (§2's bare page, 110–150 fps on WebGPU,
  137–260 fps on WebGL2). Static batching and cached shadows are how it gets
  past parity.
- No format change: this phase adds no schema bump and no deprecation. It uses
  the `static` flag entities already have (`project-model/src/types-v3.ts:210`).
- The Scene view comes along (28c.4).

## 2. Why Thirdlight is slower than plain three.js (measured 2026-10-04)

Same geometry, placements, sun shadow, post stack and camera, 1920×1080,
DPR 1, Iris Xe, headless Chrome on the GPU. The GPU is not the limit: Play at
half the pixels runs at the same fps. The main thread is busy 75–81 % of the
frame, 71 % of it inside three.js. three.js is slow here because of what we
hand it:

1. **The render graph is ~10× bigger than what is drawn (~4–5 ms).** 8,629
   Object3Ds for ~800 drawn items:
   - 3,674 Groups (every entity gets one, logic-only entities included;
     `three-adapter/src/adapter.ts:603-693`).
   - 1,108 `THREE.LOD` nodes. three's LOD keeps every level attached, so
     2,217 hidden meshes stay in the graph.
   - Model hierarchies kept intact, and 354 bones.

   Every frame three's `updateMatrixWorld` (14 % of the main thread on its
   own) and its render-list projection walk all of them. Adding 8k empty
   Groups to the bare page cost it +2.8 ms.
2. **Nothing is treated as static.** Every entity's transform is copied into
   its Object3D every frame with no dirty check (`adapter.ts:1417-1436`,
   `game-host/src/sim-remote.ts:468-476`), and `matrixAutoUpdate` stays on, so
   ~1,000 world matrices are recomputed for a village where almost nothing
   moves. The data already marks static entities; the renderer ignores it.
3. **The simulation worker is waited on, not overlapped (~3.7 ms idle).**
   - The page sends a tick, waits for the worker's frame, then renders
     (`sim-remote.ts:143-171`). Simulation and drawing never run at the same
     time, and the message round trip is added on top.
   - With the simulation on the main thread (`?threads=off`) the village runs
     at 62 fps instead of 55.
4. **The batcher re-derives its groups every frame (~1.2 ms).** It walks the
   whole graph again, builds a string key per mesh and refills its maps,
   though nothing changed (`three-adapter/src/batching.ts:322-411`).
5. **Each draw costs more, and it is the dark lights (isolated by 28c.1's
   ablation).**
   - Adding the effect pool's 16 zero-intensity point lights to the plain
     page costs +4.3 ms on both renderers, all on the GPU: the scene pass
     goes from 1.9 to 6.1 ms.
   - Per-object material copies and our node materials cost about nothing.
   - This corrects "the GPU is not the limit" above: on WebGPU the class
     spends 11.2 ms of GPU time per frame against 6.0 ms on the plain page.
     The CPU and the GPU are both near the frame time, so both halves must be
     fixed.

Beyond parity, two structural costs remain that bare three.js has too:
- 640 unique meshes drawn one by one (no static merging).
- Every caster drawn again into the sun shadow map each frame (no cached
  shadows).

## 3. Items

Order: measure → the render path, with the Scene view on it (28c.2–28c.4) →
the rest of the overhead (28c.5–28c.7) → beyond parity (28c.8–28c.9) →
hitches and download (28c.10–28c.11) → the frame-rate cap (28c.12) →
acceptance. Each item records its before/after on 28c.1's class in §6, keeps
the gate green, and checks pixels on both renderers where it changes drawing.

| Item | What |
|---|---|
| 28c.0 | This plan, its rows in `docs/STATUS.md` and `docs/roadmap.md`, pointers in plans 28b and 29, and the three.js release check. |
| 28c.1 | **Measure, always on** (from 29.1). <br>• **Neutral perf class:** a committed `tools/perf` class shaped like the village: ~1,000 entities, ~1,200 meshes of which ~650 are unique placed models with `_LOD` levels, ~50 instance sets, block chunks, ~20 skinned characters, a shadowed sun, the post stack. 1080p, uncapped, both renderers.<br>• **What it reports:** fps and frame p50/p95/p99, the main-thread split by package, the Object3D count, draws, triangles, uniform buffers, and GPU pass timings (`trackTimestamp`).<br>• **In the fast gate:** it fails on a frame-time regression beyond a tolerance from the recorded baseline (§5).<br>• **Game copies:** a local script runs the same measurement on read-only copies of Sprout and Skyforge (copied out, never written).<br>• **Per-draw ablation:** add the dark lights, per-object materials and our node materials to the bare page one at a time, so 28c.6 fixes what the numbers show rather than a guess. |
| 28c.2 | **Render only what is drawn.** The adapter stops mirroring entities. <br>• **World transforms:** the runtime keeps every entity's world transform in its own flat arrays, so parents, children and scripts work without three.js.<br>• **The three.js scene:** a flat list of drawables (meshes, instanced and batched draws, lights, skinned meshes and their bones), each placed by a world matrix written from those arrays.<br>• **Never Object3Ds:** logic-only entities, empty transforms and model hierarchy nodes; a static model's meshes get their world matrices baked.<br>• **Picking, gizmos and bounds:** read the runtime's data and a drawable→entity map.<br>• **Target:** the Object3D count equals drawables + lights + bones (diagnostics report it). Editor picking, gizmos and `ctx` transform reads keep working (e2e). |
| 28c.3 | **Only what moved is updated, and LOD keeps one level.**<br>• **Matrices:** every drawable has `matrixAutoUpdate` and `matrixWorldAutoUpdate` off. The worker's frame carries the ids that moved this step (script, physics, mover, animation, timeline), and only those drawables get a new matrix. An idle static scene writes no matrices (diagnostics count them).<br>• **LOD:** our own switch, using the existing switch points, attaches only the level being drawn. Other levels stay unattached GPU resources, and nothing hidden sits in the graph. |
| 28c.4 | **One render path for the Scene view and Play** (29.2, moved here by the owner).<br>• **Same code for both:** the Scene view draws through 28c.2's render path: the same drawables, lights, materials, lightmaps, shadows and LOD switch as Play.<br>• **What the Scene view owns:** only editor overlays (gizmos, handles, grid, selection outline, icons).<br>• **Removed:** its own lights, model instances and lighting (`editor/src/viewport.ts`, `scene-lighting.ts`, `model-instances.ts`).<br>• **Lights and shadows** move out of `createSceneAdapter` into their own module.<br>• **Pixel test:** the same scene in the Scene view and Play matches.<br>• **Measured:** the Scene view's frame time on 28c.1's class, before and after. |
| 28c.5 | **The batcher regroups only on a change** (29.9, moved here unchanged). |
| 28c.6 | **The simulation runs in parallel, one frame behind.**<br>• **Each frame:** the page sends the next tick (with this frame's input) and draws straight away, blending between the last two finished steps. The worker computes in parallel, and its result is used next frame.<br>• **No waiting:** the page never waits on the round trip.<br>• **Latency:** input-to-screen latency grows by one frame; it is measured and recorded.<br>• **Determinism:** step digests and step-exact playtests are unchanged; they count steps, not frames.<br>• **The worker is the only path for Play and export;** the main-thread simulation stays only as a debug switch.<br>• **D154:** the catch-up cap becomes a time budget (steps worth ≤ 100 ms of game time) rather than 8 steps, so a 240 Hz game doesn't drop into slow motion at 30 fps. |
| 28c.7 | **Cheaper draws**, from 28c.1's ablation. Expected:<br>• **Effect lights:** the pool's lights are in the scene only while in use (the light count stays fixed through a stable shader variant, not through dark lights; the 28.3 promise that a new effect light never recompiles is kept).<br>• **Materials:** equal per-object materials are shared again.<br>• **Uniform buffers:** fewer per object.<br>Only what the ablation shows to cost is done. |
| 28c.8 | **Static batching** (29.10, moved here unchanged). |
| 28c.9 | **Cached static shadows, dynamic on top** (29.4, moved here unchanged). Also D152: the sun's shadow region follows the camera on X and Z (Y up), with a test that walks along Z. |
| 28c.10 | **Meshing off the frame** (28b.5, moved here unchanged). |
| 28c.11 | **A small export** (D157): the export bundle is minified and tree-shaken, the `.wasm` is external, and only the physics the project uses is linked. Exports still run with the backend stopped (existing e2e). Record the gzip size for a 2D and a 3D game. |
| 28c.12 | **A frame-rate cap games control** (owner, 2026-10-04: a phone shouldn't burn power drawing 155 fps).<br>• **Values:** the cap is `30`, `60`, `120` or none. None means the display's refresh rate, as now.<br>• **Pacing:** the page skips drawing on animation frames that come early for the cap. Game time is unaffected: the simulation keeps its fixed step and catches up on the next drawn frame.<br>• **How a game sets it:**<br>&nbsp;&nbsp;– a project setting `frame_rate_cap` (the default, absent = none);<br>&nbsp;&nbsp;– a player setting, through a settings field bound to the engine like `quality` and the volumes (`binding: 'frameRateCap'`), saved with the player's settings;<br>&nbsp;&nbsp;– the UI engine action `setting: 'frameRateCap'`;<br>&nbsp;&nbsp;– from scripts, `ctx.display.frameRateCap` (read) and `ctx.display.setFrameRateCap(fps \| null)`.<br>• **Reported:** `ctx.stats` and Play diagnostics report the cap. The perf harness always runs uncapped.<br>• **No schema change:** additive optional fields only.<br>• **Test:** e2e on an uncapped browser shows ~30 drawn fps at cap 30 and ~60 at cap 60, and the game's step count over 5 s is unchanged. |
| 28c.13 | **Acceptance.** 28c.1's class and the Skyforge copy before and after, split per item in §6, each item's share shown by switching it off. Limits and switches in `docs/deployment.md`. Owner look: the village on the owner's laptop, in Play and in the Scene view. |

**Done when:**
- **Thirdlight beats plain three.js.**
  - The Skyforge village copy, and 28c.1's class, run faster in the
    Thirdlight export than the same content as a plain three.js page with no
    optimizations, measured the same way.
  - Conditions: 1080p, DPR 1, Iris Xe, both renderers, with the simulation
    running.
  - The plain page is the 2026-10-04 bare page, rebuilt from the same dump.
- An idle static scene does no per-frame matrix updates, transform copies or
  regroups (diagnostics).
- The Object3D count equals drawables + lights + bones.
- The page never waits on the simulation worker (diagnostics: zero time
  blocked per frame).
- The perf class runs in the fast gate and fails on a regression.
- Both game copies open and play as before; nothing in either game repo
  changes.
- `tools/gate.sh full --both-renderers` is green, once, at the end.

## 4. Not in this phase

These stay in phase 29: light layers, probe grids, cheap local lights and LOD
settings, effect lights on the GPU, AO and render scale, and sky rotation. These stay in
phase 33: occlusion culling (low-poly scenes are not expected to need it; 28c.1
will show it if they do).

## 5. Settled with the owner

1. **Regression gate:** a commit that makes 28c.1's class more than ~10 %
   slower than its recorded baseline fails the fast gate (proposed default,
   not objected to).
2. **Scene view:** included (28c.4, owner 2026-10-04).

## 6. Progress and measurements

| Item | Status |
|---|---|
| 28c.0 | done 2026-10-04 — three.js `0.186.1` is pinned and is the latest on npm (no update) |
| 28c.1 | done 2026-10-04 — `tools/perf/run.mjs village` (class, export vs plain page, GPU passes, package split, `--ablation`), `tools/perf/games.sh`; the fast gate checks the class's frame time (+10 %, ~40 s, GPU hosts only). Before numbers below. |
| 28c.2–28c.13 | — |

Before (2026-10-04, `1c24eb23`, Skyforge village copy, Iris Xe, 1080p, DPR 1):

| | Thirdlight export | Bare three.js |
|---|---|---|
| WebGPU | 54–55 fps (18.0 ms p50), 598 draws | 114–152 fps (6.5–9 ms), 509 draws |
| WebGL2 | 54 fps (18.1 ms) | 137–260 fps |
| `?threads=off` | 61.7 fps (15.1 ms) | — |
| +200 animated characters | 38 fps (24.8 ms) | 72 fps (13.7 ms) |
| Object3Ds | 8,629 | ~800 drawn |

Before, measured by 28c.1's harness (2026-10-04, `dbeaf6a8`, Iris Xe, 1080p, DPR 1, uncapped; mean fps, frame
p50/p95/p99 ms; main thread = renderer-process task time per frame; GPU = timestamp queries, WebGPU only):

| | Thirdlight export | Plain three.js (same dump) |
|---|---|---|
| Class, WebGPU | 57.3 fps, 18.0/31.7/33.9; 1,016 draws, 423k tris; main thread 14.8 ms (three 73 %, three-adapter 15 %, native 11 %, game-host 1 %); GPU 11.2 ms (scene pass 6.4, GTAO 1.7, shadow 0.5) | 149.5 fps, 6.0/11.4/13.9; 889 draws; main thread 6.7 ms; GPU 6.0 ms (scene pass 1.9) |
| Class, WebGL2 | 57.7 fps, 17.8/31.1/32.4; main thread 14.1 ms | 154.8 fps, 6.3/7.1/11.1 |
| Class, graph | 9,725 Object3Ds: 2,605 groups, 1,178 LOD, 3,703 meshes (2,370 hidden), 440 bones, 16 point lights; 1,307 uniform buffers | 693 Object3Ds; 1,352 uniform buffers |
| Skyforge copy, WebGPU | 55.1 fps, 18.0/19.0/22.5; 598 draws, 384k tris; 8,629 Object3Ds; main thread 13.8 ms (three 71 %, three-adapter 11 %, native 15 %); GPU 13.6 ms (scene pass 8.4) | 144.4 fps, 5.4/12.8/13.1; 509 draws; GPU 6.5 ms (scene pass 1.8) |
| Skyforge copy, WebGL2 | 54.7 fps, 17.9/20.5/23.2; main thread 14.9 ms | 141.8 fps, 4.9/14.3/73.2 |
| Sprout copy (title only) | 268 fps both renderers, 40 draws, 121 Object3Ds | 285–290 fps |

Per-draw ablation (class, plain page + one addition, frame mean vs the plain page's 6.69 ms WebGPU / 6.46 ms
WebGL2 over its 889 draws):

| Added to the plain page | WebGPU | WebGL2 | Where |
|---|---|---|---|
| Dark point lights up to the pool's 16 (14 at intensity 0 beside the 2 lit fires) | +4.28 ms (+4.8 µs/draw) | +4.23 ms (+4.8 µs/draw) | GPU: scene pass 1.9 → 6.1 ms; not CPU |
| Per-object material copies (one per draw) | −0.08 ms (0) | +0.25 ms (+0.3 µs/draw) | noise |
| The engine's node materials (`toNodeMaterial`) | −0.02 ms (0) | +0.16 ms (+0.2 µs/draw) | noise |

So 28c.7 is the dark effect-pool lights (a GPU cost in every lit pixel); material copies and node materials cost
nothing measurable, and uniform buffers are the same in both pages. The rest of the gap is main-thread work
(28c.2–28c.6). Unverified: the plain page draws skinned meshes in their rest pose and textures as 512² noise.

## 7. Decision log

- 2026-10-04: planned with the owner after the engine audit (`docs/verdict-2026-10-04.md`).
  - **A phase of its own, ahead of 28b:** the games' vertical slices are
    blocked by performance more than by any one feature, and every later
    phase builds on the frame loop.
  - **Moved here:** 29.1 (measure), 29.4 (cached shadows), 29.9 (batcher),
    29.10 (static batching) and 28b.5 (meshing off the frame).
  - **New items:** 28c.2, 28c.3, 28c.5, 28c.6 and 28c.10, the overhead the
    audit measured.
- 2026-10-04 (owner):
  - **three.js is only the renderer:** entities live in code, and only
    drawables reach three.js.
  - **LOD:** only the drawn level is attached.
  - **Simulation:** always in parallel, one frame behind.
  - **Goal:** beat plain three.js, not reach 100 fps.
  - **Scene view:** the Scene view comes along (29.2 → 28c.4), so the render
    path is rewritten once for both.
  - **Frame-rate cap:** games get one they can expose in their settings
    (28c.12), so a fast engine doesn't drain a phone's battery.
  - **Start the phase:** implement it.
