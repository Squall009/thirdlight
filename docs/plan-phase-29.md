# Phase 29 — Scalable lighting

Goal: a lit 3D scene with dense foliage and several flickering local lights
holds 60 fps at 1080p on an integrated GPU. Indirect light comes from probes
baked from the scene's static objects and lights every 3D object; static
shadows are rendered once and cached; only moving objects cast shadows each
frame. The design follows Unity HDRP, Unity's probe volumes and Unreal (§3).
Read `docs/roadmap.md` (principles 1, 1b and 7) first. Phase 29 starts after
phase 28b (immediate block and texture fixes, after phase 28's second batch of game requests). Requests: Skyforge Tactics E45 and E43 (effect lights;
`~/projects/skyforge-tactics/docs/engine-gaps.md`), and the owner.

## 1. Owner decisions (2026-09-29)

- **Tiers 1 and 2 of the lighting review are this phase; tier 3 is written
  down (§5) and done only if the measurements demand it.**
- **The lighting model:**
  - Objects marked `static` are what the bake sees: they bake the indirect
    light into probes and the static shadows into cached shadow maps.
  - **Probes light every 3D object** with indirect light, placed
    automatically over the scene. Lightmaps stay optional, for surfaces that
    want baked detail.
  - **Static objects** get direct light, the cached static shadows, and the
    shadows moving objects cast.
  - **Dynamic objects** (characters, anything that moves) get direct light,
    indirect light from the probes, and the static shadows. Only they cast
    shadows every frame, into a separate dynamic map combined with the static
    one where they are.
- **Target:** 60 fps at 1080p on this host's Intel Iris Xe, measured
  uncapped. 30 fps is not acceptable for timed input. The owner's laptop (an
  AMD Ryzen 4000-series APU, Radeon Vega graphics) is the low end: getting
  near 1080p 60 fps there, dynamic resolution included, counts as a win.
  Its Chrome reports WebGPU hardware accelerated (owner, 2026-09-29).
- **Foliage is real geometry** (no alpha cutouts), so the cost is vertices
  and many small triangles, not overdraw from alpha testing.

## 2. Where things stand (checked at `ccc682b`, 2026-09-29)

- **Local lights** are three `PointLight`/`SpotLight`s
  (`three-adapter/src/adapter.ts:573-597`). three evaluates every visible light
  per pixel on every lit material, grass instances included. No culling.
  Budget: 16 per view (`scene-v3.ts:165`, `scene-lights.ts:23`, over-budget
  lights switched off), plus a separate pool of 16 effect lights
  (`effects-draw.ts:627`).
- **Light modes** `realtime | baked | mixed` exist (`scene-v3.ts:304`). A
  baked light's contribution is summed into one lightmap atlas; the only
  runtime change is a tint over the whole map (`lightmaps.ts:85-95`).
- **Lightmaps** (phase 9.6): browser baker (direct only) and Blender Cycles
  (bounces). Bake targets are static `box`/`model` entities only
  (`editor/src/viewport/bake-run.ts:110`); instance sets and block layers are
  skipped (block-layer lightmaps are 25.20).
- **Shadows:** one directional map, no cascades, around the camera's start
  square (`three-adapter/src/lighting.ts:136-245`); point 512 cube, spot
  1024. Every shadow map is re-rendered every frame with every caster
  (no `autoUpdate`/`needsUpdate` use); instance sets always cast.
- **No light probes, no ambient occlusion, no render scale, no light
  layers.** A material can already be given a subset of lights internally
  (`withoutAmbientLight`, `node-materials.ts:96-115`).
- **Effects:** a system with a light output moves the whole effect to the CPU
  executor (`effects-gpu.ts:63`).
- **Two realizations:** the editor's Scene view builds lights, materials and
  lightmaps itself (`editor/src/viewport/viewport.ts:469`, `:1417`) next to
  the adapter's (`adapter.ts:805`, `:1371`); defect D27 was the two drifting.
  `adapter.ts`'s `createSceneAdapter` is one 1,700-line closure.
- **Perf harness** (`tools/perf`): classes up to 16 point lights, no foliage
  or block-layer class, 1280×720 default, frame time from
  `requestAnimationFrame` (vsync-capped), no GPU pass timings.
- **Skyforge's numbers** (E45; small headless canvas, likely capped, so they
  understate 1080p): 7–8 flickering point lights over ~4,000 grass instances
  drop Play from ~58 to 38–42 fps on this host's iGPU; draw calls, shadows
  (off) and the wind shader were ruled out.

## 3. How other engines do it (checked 2026-09-29)

| Topic | Unity | Godot 4 | Unreal | Thirdlight after phase 29 |
|---|---|---|---|---|
| Cached shadows | HDRP Update Mode Every Frame / On Enable / On Demand; "Always draw dynamic": static casters cached, dynamic casters each frame (a blit from the cached map, both atlases in memory) [1] | Omni/spot shadow atlas cached until something changes; directional shadows are not cached [5] | Virtual Shadow Maps: separate static and dynamic page caches, only pages a moving caster overlaps re-render; moving the light invalidates all [6] | Static map cached per light, dynamic map each frame with only moving casters, combined in the shader (29.4) |
| Probes | Adaptive Probe Volumes: placed by geometry density, sampled per pixel; leak tools Virtual Offset, Dilation, Adjustment Volumes, rendering layers [2] | LightmapGI generates probes for dynamic objects (indirect only) [5] | Volumetric lightmap | Probe grid placed over the static bounds, sampled per pixel by every 3D object; validity, offset and dilation against leaks (29.5) |
| Static vs dynamic lighting | Mixed modes Baked Indirect, Shadowmask, Distance Shadowmask, Subtractive [3] | Light bake mode Static (direct + indirect baked) / Dynamic (indirect only) [5] | Stationary lights: static shadows baked, movable objects cast dynamic ones [6] | `mixed` lights: indirect in probes, direct realtime; `baked` lights: all in probes/lightmaps (29.5) |
| Which lights hit what | Rendering layers; built-in pipeline light Culling Mask [4] | `light_cull_mask` against VisualInstance3D layers; `shadow_caster_mask` [5] | Lighting channels | Light layers and a shadow caster mask (29.3) |
| Cheap lights | Built-in "Not Important" lights: vertex/object light mode [4] | Mobile renderer: 8 omni + 8 spot per mesh [5] | — | Per-vertex local lights per object or material (29.6) |
| Many lights | URP Forward+ | Forward+ clustered, 512 elements per view [5] | Clustered deferred | Tier 3 (§5): three's `ClusteredLighting` is WebGPU-only and skips shadowed and spot lights |

three.js r186 (pinned) provides: `LightProbeGrid` (+ `LightProbeGridWebGL`;
GPU bake to L2 SH in a 3D texture atlas, `bake()` needs WebGPURenderer; no
leak handling beyond a half-spacing normal offset, no bake layer filter)
[7]; shadow `autoUpdate`/`needsUpdate` and `shadow.camera.layers` filtering;
`light.shadow.shadowNode` replacement, with `CSMShadowNode` and
`TileShadowNode` as patterns for a node combining several shadow maps (no API
to draw into an existing map; depth copies are not portable on WebGPU) [8];
`SSAONode` and `GTAONode` (fragment passes, both backends expected) [9];
`PassNode.setResolutionScale`, `FSR1Node`, `TAAUNode` [11]. No per-vertex
lighting exists in node materials [10].

Sources:
[1] https://docs.unity3d.com/Packages/com.unity.render-pipelines.high-definition@17.0/manual/shadow-update-mode.html, …/Shadows-in-HDRP.html
[2] https://docs.unity3d.com/6000.0/Documentation/Manual/urp/probevolumes-concept.html, https://unity.com/blog/engine-platform/new-ways-of-applying-global-illumination-in-unity-6
[3] https://docs.unity3d.com/6000.5/Documentation/Manual/lighting-mode.html
[4] https://docs.unity3d.com/6000.0/Documentation/Manual/class-Light.html
[5] https://docs.godotengine.org/en/stable/classes/class_lightmapgi.html, …/class_light3d.html, …/tutorials/3d/lights_and_shadows.html, https://github.com/godotengine/godot/pull/85653
[6] https://dev.epicgames.com/documentation/en-us/unreal-engine/virtual-shadow-maps-in-unreal-engine, …/stationary-light-mobility-in-unreal-engine
[7] `node_modules/three/examples/jsm/lighting/LightProbeGrid.js:56,299-372,454-459`, `…/tsl/lighting/LightProbeGridNode.js:110,122`
[8] `node_modules/three/src/nodes/lighting/ShadowNode.js:632-655,675-679,810-830`, `…/AnalyticLightNode.js:214-224`, `…/examples/jsm/tsl/shadows/TileShadowNode.js:207-209`, `…/examples/jsm/csm/CSMShadowNode.js`
[9] `node_modules/three/examples/jsm/tsl/display/SSAONode.js`, `GTAONode.js`
[10] `node_modules/three/src/materials/nodes/MeshLambertNodeMaterial.js:74-76`
[11] `node_modules/three/src/nodes/display/PassNode.js:497`, `…/examples/jsm/tsl/display/FSR1Node.js`, `TAAUNode.js`

## 4. Items

Order: measure → one realization → layers → shadows → probes → cheap
lights → effects → AO and render scale → draw-call cost (batcher, static
batching) → acceptance. Any item that adds to
`adapter.ts` first moves its area (lights, shadows, probes) into its own
module. Each item keeps the gate green, checks pixels on both renderers, and
has a Playwright test for any editor surface. Format changes ride on phase
28's schemaVersion 7 if it is still open, else an 8 with an upgrade.

| Item | What |
|---|---|
| 29.0 | This plan, and its rows in `docs/STATUS.md` and `docs/roadmap.md`. |
| 29.1 | *Moved to 28c (`docs/plan-phase-28c.md`, owner 2026-10-04); kept here for reference.* **Measure first.** (28.11 already reports CPU and GPU frame time in Play diagnostics and `ctx.stats`; the harness reads the same numbers.) A neutral perf class: a block-layer scene with ~5,000 foliage instances, 8 flickering local lights, a sun with shadows, a few moving characters. 1920×1080, uncapped (`--disable-gpu-vsync --disable-frame-rate-limit`), GPU timings per pass (`trackTimestamp`: shadows, main pass, post) next to CPU frame time, p50/p95/p99. Machine tag in the results: this host's Iris Xe, and the owner's Ryzen 4000 APU laptop (the harness runs there from a checkout, or the owner runs a one-command bench page against the running backend). The foliage is geometry blades, as the owner's are; the pass timings separate vertex-heavy and small-triangle cost from lighting cost. Both renderers. Record the before split in §6: which pass costs what. The later items are checked against it, and an item the split shows useless is dropped with a note. |
| 29.2 | *Moved to 28c as 28c.4 (`docs/plan-phase-28c.md`, owner 2026-10-04); kept here for reference.* **One realization path.** The Scene view builds lights, materials, lightmaps and shadows through the adapter's code, not its own (`viewport.ts:469`, `:1417`), so every lighting change lands once and the Scene view matches Play. Lights and shadows move out of `createSceneAdapter` into their own module. Pixel test: the same scene in the Scene view and Play. |
| 29.3 | **Light layers** (Godot `light_cull_mask`, Unity rendering layers). Objects, instance sets and block layers carry a layer mask (8 named layers in project settings); each light has a light mask and a shadow caster mask. A material or object only takes the lights whose mask matches, through the material's lights node (the `withoutAmbientLight` pattern); batching and instancing never merge objects with different masks. Inspector fields, MCP, `ctx.entity().set` for a light's mask. |
| 29.4 | *Moved to 28c (`docs/plan-phase-28c.md`, owner 2026-10-04); kept here for reference.* **Cached static shadows, dynamic shadows on top** (HDRP mixed cached shadows, Unreal's static/dynamic split). Each shadowed light gets a static map, rendered only from `static` casters and only when invalidated, and a dynamic map rendered each frame from moving casters only (layers split by `shadow.camera.layers`), combined in one custom shadow node (the `TileShadowNode` pattern). The sun's static map covers the loaded scenes' static bounds (fixed extent, not following the camera); its dynamic map can fit tightly around the moving casters for sharper character shadows. Invalidation: a static object added, moved or removed (editor or script), a scene load/unload, or the light moving or turning past a threshold (the 25.3 approach for environment blends; a sun sweeping every frame falls back to per-frame, as today). A flickering light keeps its cached map (only its intensity changes). Point and spot lights likewise; a light's shadows stay optional. Instance sets cast into the static map when static. Diagnostics count static and dynamic shadow renders per frame. |
| 29.5 | **Probe grids** (Unity probe volumes; three's `LightProbeGrid`). A scene gets probe grids placed automatically over its static bounds (spacing a scene setting, default 2 m horizontally, finer near the ground; several grids for large scenes), editable as a component. The bake renders only `static` objects and `baked`/`mixed` lights (other objects hidden during the bake), with bounces. Leak handling three lacks: a probe inside geometry (most of its cubemap sees back faces) is invalid, pushed out along the free direction (virtual offset) or left out and filled from valid neighbours (dilation). The baked grid is a scene artifact loaded like lightmaps (through phase 26's resource manager) in Play and export. Every 3D object samples it per pixel for indirect light in place of the flat ambient/hemisphere term inside the grid; lightmapped surfaces keep their lightmap and skip it. The bake runs in the browser (WebGPU; the Scene view says so on WebGL2, where baked grids still render) with a Bake button next to the lightmap one and a probe debug view. `mixed` lights' indirect light goes into the probes, their direct light stays realtime. |
| 29.6 | **Cheap local lights and dense foliage** (Unity's "Not Important" lights). Instance sets also get a density falloff by distance (each chunk draws fewer instances further away, on top of 25.7d's chunk LOD), so geometry foliage costs less where it's small on screen. LODs (`<piece>_LOD<n>` nodes, `three-adapter/src/pieces.ts`) get Unity LOD Group settings: switch points per level and a cull size below which the model isn't drawn, per model in its import settings (26.3's sidecar), instead of the engine-wide 8 / 3 / 1.2 / 0.5 % screen-height constants and no culling. On top of that (Skyforge E53, owner 2026-10-01): a project LOD bias (a quality setting that scales every switch point), hysteresis (a level switches back only past a margin, so a model at a switch point doesn't flicker), and instance sets pick levels per copy or per smaller cell instead of one level for a whole chunk from its centre (whichever measures cheaper in 29.1's class); a chunk past the cull size is skipped. A light's importance (auto, per pixel, per vertex) and an object's or material's local-light mode (per pixel, per vertex, none) — a custom TSL lighting setup that evaluates the matching local lights in the vertex stage and interpolates. Instance sets default to per vertex (foliage, dressing); characters and hero objects stay per pixel. Flicker still shows (the lights' uniforms change per frame). The sun stays per pixel everywhere. |
| 29.7 | **Effect lights without the CPU** (E43). A system with a light output no longer moves the whole effect to the CPU executor: the other systems stay on the GPU and only the light system's few particles are read back (or the light follows the effect's parameters: flicker, colour). Effect lights obey light layers and importance. The pool's lights already exist from the start of Play (28.3, Sprout TL-REQ-25), so a new effect light never changes the light count; this item keeps that. |
| 29.8 | **Ambient occlusion and render scale.** (A 2026-10-02 hotfix already draws GTAO at half resolution, renders without MSAA under a post stack, and caps the render pixel ratio at `MAX_RENDER_PIXEL_RATIO` = 1.) SSAO (default on, half resolution) or GTAO (quality) as a project setting, applied to the indirect term so probe-lit corners darken. Render scale (0.5–1) with FSR1 upscaling, and an optional dynamic resolution that lowers the scale when frames run over budget. Settings the game can expose to players. **Project-defined quality levels** (Skyforge E71): the fixed `QUALITY_PROFILE` becomes the default; a project may define its own levels, each overriding the scene's `post` per effect (as presets merge) and renderer settings (render scale, pixel-ratio cap, MSAA samples, shadow map size, local-light count, AO kind); the player's quality setting picks the level, and a running Play's level can be set from the game-control API to compare levels in one session. Both renderers. |
| 29.9 | *Moved to 28c (`docs/plan-phase-28c.md`, owner 2026-10-04); kept here for reference.* **The batcher regroups only on a change** (owner, 2026-10-02). `createAutoBatcher().update` walks the whole scene graph every frame, builds a string key per batchable mesh and refills every group's map, though nothing moved: ~18% of the main thread in Skyforge's village (§6, 2026-10-02 profile). Groups are kept between frames and rebuilt only when membership can have changed (a batchable mesh added, removed, shown/hidden, its material, geometry, shadow flags or layers changed, a refusal reason appearing or going: a scene revision counter the adapter bumps on those, not a per-frame scan); member matrices are copied only for members whose world matrix changed (a moved object, an animated parent). LOD level changes regroup only the LOD's meshes. Diagnostics count regroups and matrix copies per frame; an idle frame of a static scene does neither. A scene load, unload or `ctx.scenes.reload` (28.5) and objects kept loaded across them (28.4) regroup only the meshes they touch. |
| 29.10 | *Moved to 28c (`docs/plan-phase-28c.md`, owner 2026-10-04); kept here for reference.* **Static batching** (owner, 2026-10-02; Unity static batching, Godot's `MeshInstance3D` merging, Unreal's merge actors). Automatic instancing needs four copies of one mesh, so a scene of unique placed models draws them one by one: Skyforge's village draws ~640 of its ~1,200 meshes singly (674 distinct geometries, 323 models mostly placed once), and each is drawn again into the shadow map. Meshes of `static` entities (models and boxes) that share a material, shadow flags, light layers (29.3) and a world cell are merged into one geometry per (material, cell) at load (Play, export) and when the static set changes (editor: rebuilt off the frame, with the singles drawn until it is ready). Members keep their entities for picking, colliders and scripts; a static object a script moves or hides leaves its batch (the batch is rebuilt without it), as Unity does. Cells keep frustum culling for large scenes; 29.4's static shadow map draws the merged batches. Memory is shown in diagnostics (merged vertex bytes) and has no count cap. Batches are built per scene, so a scene unload or `ctx.scenes.reload` (28.5) drops or rebuilds only its own; objects kept loaded (28.4) are never merged into a scene's batch. Pixel test: the same scene merged and unmerged on both renderers. |
| 29.11 | **Sky rotation** (Skyforge E70). `sky.rotation` (degrees about +Y) for `texture` and `cube` skies, applied to the background and the environment lighting alike, with an Inspector field and an "align the sky's sun to the key light" action in the Environment window. |
| 29.12 | **Acceptance.** 29.1's class after the phase, split in §6. The limits and settings in `docs/deployment.md`. Each item's contribution is shown by switching it off in the class. |
| 29.13 | **Full gate back under its 15 min budget** (D181; run first in the phase). The phase-end `full --both-renderers` took 21–22 min in 28b/28c. Find where the e2e time goes and cut it without losing any behaviour's coverage: one backend per file where tests share a fixture, shorter authored game time, polls instead of fixed sleeps, one renderer pass where the subject is not a backend path. |

**Done when:**
- 29.1's class holds p95 ≤ 16.7 ms GPU and CPU frame time at 1080p uncapped
  on this host's Iris Xe on the default renderer, with the WebGL 2 numbers
  recorded. On the owner's Ryzen 4000 APU laptop the numbers are recorded;
  near 1080p 60 fps there with dynamic resolution is the stretch goal. If a target is missed,
  the §6 split says what is left and which tier-3 item would close it.
- A moving character casts a shadow over cached static shadows with no
  per-frame static re-render (diagnostics), and a static object moved in the
  editor updates its shadow.
- Probe-lit objects show no light leaking through a closed wall in the
  class's interior test (pixels).
- The Scene view and Play show the same lighting (pixels).
- `tools/gate.sh full` is green.

## 5. Tier 3 — only if the measurements demand it

- **Clustered lighting** (three's `ClusteredLighting`, URP Forward+, Godot
  Forward+): each surface pays only for nearby lights, and the per-view cap of
  16 local lights becomes per cluster. WebGPU only and shadowless point
  lights only in r186; WebGL 2 would need per-chunk light lists.
- **Shadows for large worlds:** cascades that follow the camera with cached
  cascades, or Unreal-style page caching (only the tiles a moving caster
  touches re-render). Phase 29 caches a fixed-extent map, which suits bounded
  levels.
- **Flickering baked light** (Quake/Source "light styles"): each switchable
  light's baked contribution stored separately and scaled at run time. Not in
  Unity or Godot; phase 29's `mixed` lights flicker their direct light and
  keep a steady baked bounce.
- **Adaptive probe placement** (APV bricks by geometry density) instead of
  grids, and probe baking in Cycles.

## 6. Progress and measurements

| Item | Status |
|---|---|
| 29.0 | done 2026-09-29 |
| 29.1–29.12 | — |
| 29.13 | done 2026-10-06, partly: e2e test time 2131 → ~1820 s (−15 %), so the projected full gate is ~19 min, not ≤ 14. Measured per file in fast gates on both renderers, logs gate-fast-2913a/b1/b2. Changes: `expect.poll` retries every 50/100/200 ms (`tests/e2e/pw.ts`), shorter authored game time, polls instead of sleeps, ~30 tests merged onto shared backends, block-lod and engine-view on the product renderer only. Not taken: lint beside vitest saves 30 s but its memory peak is 6.2 GB under the 7 GB cap; trace recording costs ~1.5 %; a minified editor bundle loads no faster. 3 workers would cut e2e wall time by 18 % at a 4.7 GB peak in a sample (owner to decide). The rest of the gap needs a coverage decision (§7). |

(29.1's before split and 29.12's after split.)

**Skyforge's village, 2026-10-02 (before the phase, r16998 export, this
host's Iris Xe, WebGPU, 1920 × 1080, headless Chrome).** 34–48 fps at device
pixel ratio 1, CPU-bound (main thread 94% busy); 17 fps at device pixel
ratio 2, GPU-bound (55% busy). ~840 draws a frame: 420 in the main pass, 401
in the 1024² sun shadow map (re-rendered every frame with every caster), the
rest post. Main thread: drawing ~31%, the shadow map ~27%, the batcher's
per-frame regroup ~18% (with `updateMatrixWorld`). 1,200 meshes: 638 drawn
singly (no partner), 54 block chunks, 22 skinned, 48 batches. The GPU half
was three defects (MSAA under the post stack, GTAO not building on WebGPU,
an uncapped device pixel ratio), fixed by the hotfix in 29.8's note; the CPU
half is 29.4, 29.9 and 29.10.

## 7. Decision log

- 2026-10-06 (gate budget): the e2e trim kept every assertion, so it reached 15 %, not the 35 % needed. The time left is game time the tests watch in real time (walks, blends, Play and export legs) and ~1 s for each Play or export. Under 14 min needs one of these (owner to choose): 3 workers (−18 % e2e wall time, 4.7 GB peak in a sample; the memory rule says 2); fewer export legs where a feature's export path is the same runtime code as Play; or fewer forced WebGL 2 variants (182 s of test time). Default chosen: none of them; the full gate reports its time.

- 2026-09-29: the lighting model is the owner's, checked against Unity HDRP,
  Unity probe volumes, Godot and Unreal (§3); it matches HDRP's mixed cached
  shadows plus probe volumes.
- 2026-09-29: static and dynamic shadows are two maps combined in the
  shader, not a copy of the static map with dynamic casters drawn on top
  (HDRP's blit). three has no API to draw into an existing shadow map, and
  WebGPU can't copy the `depth24plus` shadow format; two maps also let the
  dynamic one fit the characters tightly.
- 2026-09-29: static shadows come from cached shadow maps, not a baked
  shadowmask. A cached map needs no lightmap UVs, covers blocks and foliage,
  and looks like the dynamic shadows next to it; lightmaps stay for surfaces
  that want Cycles-quality penumbrae.
- 2026-09-29: static means the existing entity `static` flag (and instance
  sets and block layers marked static), not tags.
- 2026-09-29: three's `LightProbeGrid` is used for storage and sampling, with
  validity, offset and dilation added by the engine; if its bake can't be
  restricted to static objects cleanly (no layer option in r186), the engine
  hides the others during the bake.
- 2026-09-30: renumbered 27 → 28: the editor layout (`docs/plan-phase-27.md`,
  owner) goes first. It makes the environment per scene (sky, fog, post,
  wind in each scene file; the active scene's applies), so the sky light,
  probe bakes and fog of this phase are per scene too.
- 2026-10-01: Skyforge's E53 (LOD switch points fixed engine-wide, grass
  switching at 3.6 m, whole chunks switching at once) folded into 28.6, which
  already replaces the fixed screen fractions: a project LOD bias,
  hysteresis and per-copy or finer-cell LOD for instance sets added (owner).
- 2026-10-02: Skyforge measured at 12 fps by the owner. Three GPU-side
  defects were fixed at once as a hotfix (see 28.8's note and §6); the CPU
  side became items 28.9 (the batcher regroups only on a change) and 28.10
  (static batching), with acceptance moved to 28.11 (owner). Skyforge removes
  its inverted-hull outline meshes on its side (owner).
- 2026-10-02: renumbered 28 → 29: the second batch of game requests
  (`docs/plan-phase-28.md`, owner) goes first, so the batcher (29.9) and
  static batching (29.10) are built against keep-loaded objects and scene
  reloads. Added from the triage: project-defined quality levels (E71) in
  29.8, sky rotation (E70) as 29.11, acceptance moved to 29.12. E72's frame
  time and Sprout's TL-REQ-25 (a fixed effect-light pool) moved earlier, to
  28.11 and 28.3.
- 2026-10-03: phase 28b (immediate block and texture fixes) goes between 28
  and 29, and level building with terrain is phase 30 (owner). Terrain uses
  this phase's probes, cached shadows, LOD settings, density falloff and
  static batching; its far tiles need sparser probes and baked horizon terms
  rather than 29.5's 2 m grid, which 30.17 adds. Targets are soft from now on
  (roadmap principle 7).
