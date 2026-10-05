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
| 28c.2 | done 2026-10-04 — only drawables in the scene (`render-graph.ts`, world matrices in the runtime's `WorldMatrices`); class 9,725 → 5,066 Object3Ds (groups 2,605 → 166, bones 440 → 0; the rest is LOD, 28c.3), main thread 14.5 → 10.2 ms, mean 58 → 62 fps (p50 still 17.9 ms: the worker wait, 28c.6); Skyforge copy 8,629 → 5,311, main thread 13.8 → 12.3 ms, Sprout opens; pixels vs before: WebGPU mean 0.01, WebGL 2 mean 0.35 (0.44 % > 32, near the fires, unverified why). Baseline re-recorded. |
| 28c.3 | done 2026-10-04 — only moved entities are composed and placed (the worker's frame carries the moved indices); an idle scene writes 0 matrices (`sceneGraph.matrixWrites`, e2e); LODs are data, our switch (`lod-switch.ts`, three's rule) attaches one level; a static mesh's child nodes hang beside it; hidden entities leave the scene. Class 5,066 → 1,382 Object3Ds (LOD 1,178 → 0, hidden 2,370 → 14, groups 166 → 16 = effect groups), main thread 10.2 → 7.5–8.2 ms, draws 1,016 → 904, frame mean unchanged (worker wait, 28c.6; baseline kept); Skyforge copy 5,311 → 897, main thread 12.3 → 10.0 ms, Sprout opens; pixels: mean ≤ 0.5 both renderers (fire flicker). |
| 28c.4 | done 2026-10-05 — the Scene view draws through `createSceneAdapter` (authoring source `scene-source.ts`; lights and shadows in `lights-shadows.ts`; the viewport's lighting, lightmap and placement code deleted; selection is an outline). Village class, Scene view (orbit, `run.mjs village --scene-view`): WebGPU 11.5 → 8.2 ms p50 (83.8 → 117.2 fps), WebGL 2 12.7 → 8.9 ms, 10,135 → 1,763 Object3Ds, main thread 11.9 → 8.4 ms; Play/export unchanged (WebGPU 62.7 → 64.4 fps, WebGL 2 63.1 → 66.6). Pixels Scene view vs Play (`scene-view-parity.e2e.ts`): mean 0.13, 0.19 % > 32, both renderers. |
| 28c.5 | done 2026-10-05 — the batcher never walks the scene: the render graph tells it what is listed/unlisted and whose matrix it wrote, hosts `touch` an entity whose material/look/lightmap changed; groups persist, only changed members regroup, only moved members are copied (diagnostics `regroups`/`matrixCopies` per frame and totals). e2e (`batch-dispose.e2e.ts`, both renderers): idle 0/0; move 0 regroups/1 copy, hide 1/1, LOD switch 2/1; pixels vs `?batching=off` mean 0.00. Class (the village batches nothing yet: model materials are per placement, 28c.7): Scene view WebGPU 8.1 → 7.3 ms p50 (120 → 128 fps), WebGL 2 8.8 → 7.9 ms (111 → 124), main thread 8.3 → 7.7 ms; export unchanged within noise (WebGPU 61.5 → 64.8 fps, WebGL 2 67.6 → 64.4, main thread 7.0–7.3 ms, worker wait 28c.6). |
| 28c.6 | done 2026-10-05 — the page draws a frame behind and never waits (apply the newest worker frame, send the next tick, draw at once, each entity blended between its last two steps by the page clock: `FrameMirror.present`); D154: catch-up is 100 ms of game time (`MAX_CATCHUP_SECONDS`, `frame-clock.ts`). Play diagnostics `simulation.pipeline`; e2e: worker slowed to 40 ms → Play draws 60.7 fps at a 60 fps display (0.9 ms max before a draw), 240 Hz game at 30 fps runs 241.5 steps/s, 0 dropped. Class export WebGPU 57.5 → 79.8 fps (p50 17.9 → 12.4 ms), WebGL 2 59.9 → 81.8 fps (p50 17.8 → 7.7 ms), but p99 25.8 → 43 / 29.3 → 111 ms and main thread now 100 % busy (12.6 ms/frame, was 8.2 waiting), GPU passes reported ~2× (now GPU- and CPU-bound, unverified why the scene pass grew); Skyforge copy 55.8 → 60.5 fps WebGPU (p50 17.8 → 16.3, p95 18.6 → 33.3), 55.4 → 61.8 WebGL 2 (p50 18 → 10.8, p95 18.7 → 62.2). Input to screen: an input sample is drawn 16.9–17.2 ms after it is sent at 60 fps (`inputToDrawMs`, Play e2e; the worker answers in 2.4–2.9 ms), i.e. +1 frame. Baseline re-recorded (16.4/15.8 → 12.3/11.4 ms). Main thread runs only on request: `?threads=off`, a play's `threads`, or `sim_thread` 2 (kept: changing a stored setting is a deprecation; owner call). |
| 28c.7 | done 2026-10-05 — **effect lights:** the pool is one `EffectLights` object with its own light node (uniform arrays, a loop over the slots in use; after three's `PointLightDataNode`), built once, so no recompile and a dark slot costs nothing (`effect-light-pool.e2e.ts`: 0 builds from 1 to 16 lights, panel brighter; both renderers). Class export WebGPU 81 → 118 fps (p50/p95/p99 12.2/14/30 → 7.6/11.6/24.8 ms, scene pass 11.4 → 3.5 ms, main thread 12.4 → 8.5 ms), WebGL 2 86 → 128 fps (7.2/12.4/146 → 7.5/8.2/8.8 ms); Skyforge copy WebGPU 60.5 → 83.7 fps (16.3/33.3/50.9 → 11.2/16.9/30.2), WebGL 2 61.8 → 92.1 (10.8/62.2/80.9 → 10.7/12/12.6); pixels vs before mean 0.42/0.32 (fire flicker). **Materials:** nothing to share — model placements already share one clone per resource material; a probe of the drawn scenes found no two equal materials on one geometry (village 600 of 1,198 batchable meshes batched, 435 unique geometry×material; Skyforge 310 of 742, 382 unique: mirrored L/R parts, distinct models), so no change (static batching, 28c.8, is what merges these); uniform buffers equal the plain page's. **Pacing:** at the display's rate (`run.mjs village --vsync`) no frame is dropped, class and Skyforge, both renderers (max 16.8 ms); uncapped WebGPU tails are GPU backpressure (see §7). Perf check also gates p95 (+50 %); baseline re-recorded (12.3/11.4 → 8.4/7.7 ms mean). |
| 28c.8 | done 2026-10-05 — static meshes drawn alone merge per scene, material, shadow flags, vertex layout and 64 m cell into one world-space geometry (`static-merge.ts`, driven by the batcher): every LOD level is copied and the index lists the attached ones (a level switch, a hide or a move rewrites the index; a moved member rejoins in place after 0.5 s); built at load in Play/export, in the background in the editor; materials reading the object frame never merge; members drawn through batches or cells leave the scene's children (picking, the texture streamer and the scene dump read them). Village class v2 (props `static`), vs `?merging=off` in the same session: export WebGPU 133.6 → 134.2 fps (p50/p95/p99 7.3/8.7/11.1 → 6.6/10.1/24 ms), WebGL 2 131 → 137 fps (7.5/8.4/12.2 → 6.2/7.7/23.6), draws 904 → 641 (scene 252 → 197, shadow 634 → 426) in 161 cells, merged copies 3.2 MiB, Object3Ds 767 → 533; Scene view WebGPU 133.8 → 140.2 fps, WebGL 2 119.8 → 135, draws 1,117 → 875; plain page 149.9 / 154.8 fps. Skyforge copy (547 of its 575 main-scene models marked static in the copy, `TL_GAME_STATIC=1`): WebGPU 90.9 → 89.2 fps, WebGL 2 82.6 → 89.6, draws 644 → 514 in 31 cells, 7.9 MiB; plain page 138 / 135. `batch-dispose.e2e.ts` (both renderers): a click selects an object inside a merged cell, a moved one leaves and rejoins, a script-hidden one leaves without a build, Play pixels vs `?batching=off` mean 0.00. WebGPU gains nothing (GPU-bound, §7). Baseline re-recorded for class v2 (7.42/7.11 ms). |
| 28c.9–28c.13 | — |

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
- 2026-10-04, 28c.2 design (render only what is drawn), after reading the adapter, models, pieces,
  batching, block layers, the animator player, effects and the worker mirror:
  - **World transforms:** a `WorldMatrices` table in `@thirdlight/runtime` (no three.js): one row per
    realized entity (parent id, local TRS, a column-major world matrix in one `Float64Array`), composed
    parents-first once per frame from the interpolated transforms. Scripts, sockets and physics already
    compose worlds in the runtime (`world-transform.ts`, `sockets.ts`); picking, bounds and camera
    follow in Play are runtime queries; fog volumes, UI anchoring and effect anchors read the table.
  - **Entities that draw nothing** (logic-only, markers, triggers) get a table row and no Object3D. One
    that draws (box, model, instance set, light) or anchors an effect gets a detached `EntityNode`
    (never in the scene, matrix = its world); what it shows hangs below it as bookkeeping, so material,
    look, lightmap and animation code keeps walking the same subtrees.
  - **The scene** (`render-graph.ts`) lists only the top-most drawables of those subtrees (meshes,
    instanced meshes, LODs, local lights; their `.parent` stays the logical one). Static subtrees: matrix
    updates off, the file hierarchy baked into an offset, world = entity world × offset. Animated ones
    (animator, `modelAnimation`, skinned): posed in their detached hierarchy after the mixer, so bones
    are not in the scene at all. Block chunks, batches and effects add their meshes directly.
  - **Hiding** propagates down the table's parents; the drawable→entity map is the node's part list.
  - **Diagnostics:** Play's renderer block reports the scene's Object3Ds by kind (`sceneGraph`);
    `containers` (none of drawable, light, bone, LOD level) is the number that must be zero.
- 2026-10-04, 28c.4 design (one render path), after reading the viewport's lighting, lightmap and model
  code, the adapter and the runtime surface it reads:
  - **The Scene view hosts `createSceneAdapter`**, driven by an authoring source (editor) answering what the
    adapter reads: `sceneSet()` (each open scene a batch of entity documents, the stored components; block
    cells keep the editor's incremental path), `forEachMoved`/`forEachInterpolated` (authored local
    transforms), `readCameraView` (the orbit camera), `hiddenEntities` (inactive objects). The adapter's
    `WorldMatrices` composes the worlds as in Play.
  - **Edits mark rows:** a transform (a command landing, each gizmo frame, a timeline scrub) comes out of
    `forEachMoved` for that entity only; a component edit hands over a new document object, and the adapter
    re-realizes the changed entities of a batch whose list was replaced (Play's never are: no cost there).
    Environment, bakes and quality are setters.
  - **Lighting:** game = the scene's lights through the lights-and-shadows module (`lights-shadows.ts`, out
    of `createSceneAdapter`; the Scene view gets realtime shadows); editor = a key/fill rig fed as documents
    of its own instead of the scene's lights, no look, no lightmaps.
  - **Picking, gizmo, bounds:** a ray against the listed drawables walks a hit's logical parents to its
    `EntityNode` (the drawable→entity map); the gizmo moves a stand-in whose parent frame is the parent's
    world matrix (its pose is the local transform); bounds, outlines and bake inputs read the entity node.
  - **The viewport owns only overlays:** grid, gizmo, handles, icons, light ranges and arrows, fog boxes,
    camera frustums, collider/trigger outlines, brush previews and a selection outline (no material tint).
    Per-entity ones ride on the entity's node (`attachOverlay`: they move and hide with it).
- 2026-10-05, 28c.7 frame pacing (CDP trace of the class export, WebGPU, uncapped, vs the plain page):
  - **The long frames are GPU backpressure.** Every ~400 ms the GPU process runs one WebGPU flush of
    15–16 ms (two frames of GPU work; normally ≤ 8 ms) and the page's animation-frame callback blocks in
    `CommandBufferProxyImpl::WaitForToken` for 11–16 ms. Nothing else is in those frames: no GC, no
    worker message, no shader build, no texture upload. The plain page shows the same 7–8 ms flushes and
    a bimodal WebGPU frame time (p95 14 ms at p50 6 ms), only without the doubled flush.
  - **Ruled out by experiment:** the GPU particles' living-count readback (off: tails unchanged);
    one frame in flight (`onSubmittedWorkDone` before the next draw): 119 → 39 fps, its callback comes
    a frame or two late, so the pacing is left to the browser.
  - **Not a player-visible tail:** drawn at the display's rate (60 Hz, `--vsync`) no frame is dropped.
    The uncapped tail shrinks with GPU work per frame (28c.8–28c.9); Skyforge's scene pass is still
    3.5× the plain page's (6.8 vs 1.9 ms; its real textures and graph materials against the plain page's
    noise textures, unverified which).
- 2026-10-05, 28c.8 static batching, measured:
  - **Cells follow materials.** The village's 598 singles wear ~160 distinct materials, so they merge into
    161 cells, not a handful; the shadow pass still draws 426 (each cell once more). Cached static shadows
    (28c.9) take the static casters out of that pass.
  - **Why WebGPU does not speed up.** The frame is GPU-bound on both pages: the plain page's main thread
    spends 21 % blocked in `submit`. Our WebGPU pass timings are ~1.9× the plain page's for every pass, post
    passes with the same shaders and pixels included, and add up to more than the frame (11.3 ms at 7.4 ms),
    so they include overlapping work and are not shading cost.
  - **Skyforge's scene pass** (8.3 ms against the plain page's 2.3), switched off one at a time on the running
    export (cumulative, single runs): environment lighting −2.3 ms, fog −0.2, shadow receiving −0.9, material
    nodes (graph, kit and foliage nodes stripped, same maps) −1.6, leaving 3.25 ms. The plain page has no
    environment map at all (`bare.js` sets a background colour only), so that part is not like for like.
  - **WebGL 2 uncapped stalls:** once the frame gets faster, the GPU process stalls 200–300 ms every ~2 s
    (trace: one `CommandBuffer::Flush`); it happens with the merged meshes hidden too, so it is the frame rate,
    not the merged draws. At the display's rate (`--vsync`) no frame is dropped on either renderer, merged or
    not.

