# Phase 43 — Clustered forward lighting

Status: planned 2026-10-26 (owner), after phase 42 is merged.

Goal: any number of local lights reach every pixel that needs them, with
shadows, on both renderers. Phase 42 lights static surfaces from the surface
cache. This phase covers what the cache does not: lights reaching moving
objects, local-light shadows on moving objects, and per-pixel highlights. It
lifts the 16 local lights drawn per pixel (`MAX_LOCAL_LIGHTS`,
`project-model/src/local-lights.ts`; D204). Read `docs/roadmap.md`
(principles 1, 5 and 7) and `docs/plan-phase-42.md` first.

## 1. Owner decisions (2026-10-26)

- **Our own clustered lighting.** Per-cluster light lists built by the
  engine, not three's r186 `ClusteredLighting` addon. The addon is WebGPU
  only and leaves out spot and shadowed lights. That is a limit of its code,
  not of the technique.
- **Light kinds in the lists:** point and spot lights (a cone test per
  cluster) and `area` lights (rect and line, a box test).
- **Shadowed local lights use a shadow atlas.**
  - One depth texture. Each light's matrices and its rect in the atlas sit in
    the light buffer, so the light loop samples shadows by index.
  - Point lights take 6 faces.
  - The atlas size is a per-tier budget. Lights are ranked by screen size and
    distance; a light that gets no space draws unshadowed. That is a quality
    budget, not a count cap.
- **Hooking three's lighting nodes is private API.** Each hook goes in
  `docs/three-upgrade-checklist.md`.
- **Performance** is measured at the 60 Hz cap on the Iris Xe: village,
  landscape and the interior class.

- **One light path for both renderers** (owner, 2026-10-27). The light
  lists live in data textures read with `texelFetch`, and the shadow atlas
  is shared. WebGL 2 does not keep the 16-light per-pixel path as a
  fallback: one renderer path to maintain, and players are expected to have
  a GPU or iGPU with WebGPU.
- **Cluster lists built one way for both backends** (owner, 2026-10-27),
  e.g. on the CPU, which is cheap for a few hundred lights over a froxel
  grid. A WebGPU compute build is taken only if measured clearly faster, and
  then it must produce the same packed lists, so the shading code stays one
  path.

## 2. Plan

### 2.1 Where we start (base e52e891d)

- Each point/spot entity is a three light (`lights-shadows.ts`, layered ones
  in `light-layers.ts`): three unrolls a node per light into every lit
  program and the light set keys the programs. `scene-lights.ts` turns on at
  most `MAX_LOCAL_LIGHTS` (16). `probe-lighting.ts` `ProbeOrderedLightsNode`
  orders the builds (mode split `splitLocalLights`, cache readers through
  `buildReadLights`, probes last); `local-lights.ts` swaps mode variants per
  draw. Effect lights are one `EffectLights` node looping 16 slots.
- Area lights light only the surface cache; `surface-highlights.ts` draws
  the 4 nearest as LTC specular on cache readers (WebGPU). Moving objects
  get none.
- Shadows: a three map per light (point 512 × 6, spot 1,024), ranked by
  `shadow-budget.ts` within a level's `shadowedLights`. Cookies are three's
  `SpotLight.map` (a projector program each).
- Caps to retire: `lights_local` (scene-v3), level `localLights` /
  `shadowedLights`, furnishing budgets (`arch-lights.ts`, editor
  `building-interiors.ts`), `droppedLightChecks` (`lights_dropped`), MCP docs,
  the manual, `tools/perf/level-interior.ts`.
- three r186: `LightsNode.setupDirectLight` / `setupDirectRectAreaLight` call
  any lighting model's `direct` / `directRectArea` (Physical, Lambert, our
  `GraphLightingModel`); the addon `ClusteredLightsNode` (reference only:
  compute build, point lights, `Loop(max) + Break`); shadows draw through
  `ShadowNode.getShadowRenderObjectFunction`; data textures are read
  untransformed through `texel-reads.ts`. WebGL 2 is always tier `low`.

### 2.2 Design

**One light, one node.** All local lights (point, spot, area rect/line, and
the effect pool's slots) become records in one `ClusteredLights extends
THREE.Light` in the scene, with one `ClusterLightsNode`: one program shape
however many lights exist, so adding, switching or moving a light builds
nothing. Entities keep an `Object3D` for placement, picking and gizmos, not a
`THREE.Light`. The node runs where `splitLocalLights` puts local lights today
(mode `none` leaves it out), inside `ProbeOrderedLightsNode`.

**Froxel grid.** Fixed count, not fixed pixel size: 16 × 9 tiles (Y from the
aspect, 16 × round(16/aspect)) × 24 depth slices = 3,456 clusters. A pixel's
tile is `screenCoordinate / renderSize × grid`, so the render scale, dynamic
resolution and TAAU change nothing and no buffer resizes. Slices are
exponential, `slice = floor(log2(viewZ) × scale + bias)`, between
`max(near, 0.25 m)` and the farthest packed light's view depth + reach
(capped at the camera's far); nearer pixels use slice 0, farther ones get no
local light. One grid per drawing camera (game view, Scene view, capture);
shadow, probe-capture, reflection and override passes do not read it.

**CPU build, per frame.** (`cluster-build.ts`, pure, typed arrays, no
allocation per frame.) 1) Cull: lights whose bounds miss the frustum, are in
a room no portal shows (`roomKeyOf`), or are off are not packed. 2) Rank the
rest by intensity × screen size (used for overflow and shadows). 3) Per
light, its view-space bounds give a tile rect and slice range; each froxel in
that box gets an exact test: sphere-vs-AABB (point), sphere-vs-AABB then
cone-vs-sphere-of-the-froxel (spot), oriented box of the emitting half-space
within reach vs AABB (area rect/line). 4) Two passes: count per cluster,
prefix sum, write indices. Budget on the main thread (Iris Xe host CPU, at
the cap): ≤ 0.1 ms at 64 visible lights, ≤ 0.3 ms at 256, ≤ 1.0 ms at 1,000;
diagnostics `renderer.clusters` {lights, packed, indices, overflow, buildMs,
uploadBytes}.

**Packing (both renderers, `texelFetch` only).**
- *Light texture*, RGBA32F, 1,024 texels wide, 4 texels a light (64 B):
  t0 view position xyz, reach; t1 linear colour × intensity rgb, kind +
  decay packed; t2 spot axis xyz (view) or area half-width vector, cos outer;
  t3 spot cos inner or area half-height vector, layer mask (bits as float,
  exact < 2^24), shadow record index, cookie index. Positions and axes are
  written in view space each frame (the CPU rewrites them anyway; the shader
  saves a matrix multiply per light). Shadow records follow in the same
  texture: a spot 5 texels (world→atlas matrix, rect), a point/area 7 (near,
  far, bias; six face rects).
- *Cluster texture*, one R32UI texture, 1,024 wide: cluster headers first
  (one texel: offset 22 bits | count 10 bits; a cluster with more than 1,023
  lights uses a two-texel header, flagged), then the index lists (one light
  index a texel). Two samplers in all, plus the atlas and, while any cookie
  is loaded, the cookie atlas. If integer textures fail in TSL on either
  backend (43.1 spike), the fallback is RGBA32F with integer values (exact
  to 2^24).
- *Memory budget, not a count.* Both textures grow by doubling rows on
  demand, never shrink within a scene. The index list's ceiling is
  `CLUSTER_INDEX_MIB` (16 MiB, 4 M indices, three-adapter); over it, the
  lowest-ranked lights are left out of the clusters that did not fit that
  frame (never the nearest), `overflow` counts them and one console warning
  names the scene. No per-cluster cap: the loop's bound is the cluster's own
  count.

**The light loop.** `Loop(count)` over the cluster's indices: read the record,
range test, then per kind `setupDirectLight` (point, spot with smoothstep
cone and cookie) or `setupDirectRectAreaLight` (rect; line as a 2 cm strip,
as 42.7b). Models without `directRectArea` (Lambert, Phong, custom-lit) get
an area light through `direct` as its exact LTC form factor toward the
rect's centre. Shadow and cookie terms multiply the colour before the call,
as three's analytic lights do. Light layers: the record's mask against the
object's layer uniform (`light-layers.ts`), built only when some packed light
is layered (part of the key, like the effect pool today). Cache-reading builds
(`buildReadLights`) call the same loop in *highlight mode*: specular only,
plus each light's unshadowed diffuse summed for the visibility ratio
(`surface-highlights.ts`), which then drops its 4-light unrolled uniforms.
D352 (a texel-bounded loop ran to its bound on the Iris Xe) is the first
thing 43.1 tests: the loop is written as `Loop(uniform bound) + Break` if the
plain form stalls.

**Shadow atlas.** (`shadow-atlas.ts` pure allocation; `shadow-atlas-draw.ts`
the passes.) One depth32float `DepthTexture` per renderer, square, side from
the tier: low 2,048 (16 MiB), medium 4,096 (64 MiB), high 8,192 (256 MiB),
new tier field `shadowAtlas` in `LIGHTING_TIER_SETTINGS` and a level field of
the same name laid over it (sizes from `SHADOW_MAP_SIZES` extended by 8,192).
- *Ranking*: shadow-casting packed lights by screen size over distance
  (`shadow-budget.ts`'s rank, a point light's six faces at half weight), faded
  out by `LOCAL_SHADOW_DISTANCE`. *Tile size* from rank: spot 128–1,024,
  point/area faces 64–512 (today's map sizes are the ceilings), power of two,
  a quadtree allocator; a light keeps its size until its rank says another
  size for 30 frames (no thrash).
- *Point lights* take 6 faces (90° perspective each); the shader picks the
  face by the major axis and clamps into the rect less one texel. *Area
  lights* take 5 (no face behind the emitter), seen from the rect's centre.
  *Spots* one.
- *Unshadowed fallback*: a light the atlas cannot hold draws unshadowed,
  its shadow fading over 0.25 s when it loses a tile (no pop).
- *Redraws*: a tile is drawn when allocated or resized, when its light moves,
  when the static casters' revision changes, or while a mover is in its reach
  (today's rules). At most a quarter of the atlas's texels are drawn a frame,
  highest rank first; the rest keep last frame's depth one frame more.
- *Drawing*: `renderer.setRenderTarget(atlas)`, viewport + scissor per face,
  through three's shadow render-object function so alpha masks, see-through,
  bend and copies draw their casters as they do now; casters filtered by the
  light's `shadowCasterMask`.
- *Sampling*: hardware compare, 2×2 PCF (one `textureSampleCompare` a tap) on
  both renderers.
- *Cookies*: an RGBA8 cookie atlas (2,048², 256² tiles, 16 MiB), a cookie
  drawn into its tile when loaded, projected with the spot's matrix (kept in
  its shadow record even when unshadowed). Past the atlas's tiles the
  lowest-ranked spots draw no cookie (diagnostic `cookiesDropped`).

### 2.3 Items

| Item | What, files, tests, measurements |
|---|---|
| 43.0a | (lead) three.js release check; baseline in `tools/perf` with the many-lights scene (64/256/1,000 point+spot, some shadowed) on today's path as far as it compiles. |
| 43.0a | Done (027c9997): three 0.186.1 current. Baseline at the cap, both renderers: village/landscape/interior p95 16.7–16.8, 0 missed (~/.cache/thirdlight-phase43/baseline.md). Many-lights class (`run.mjs lights`) through today's loop: 64 lights scene pass 6.25 ms; 256 19.9 ms, p95 33.4 (WebGL 2 66.6); 1,000 ~99 ms (WebGL 2 5.7 fps). |
| 43.0b | This plan. |
| 43.1a | **Grid, build, packing (pure).** `cluster-build.ts`, `cluster-pack.ts`: grid math, the three tests, two-pass build, packing, overflow. Vitest against the real code: every froxel's corners and centre that a light's volume reaches are listed (no false negative over 10k random lights × grid; false-positive share recorded); cone and box tests against brute force; a JS twin of the shader's decode round-trips the packed textures; overflow drops lowest rank; render-scale change leaves the lists equal. Bench (vitest bench or `tools/perf`): build ms at 64/256/1,000 and bytes uploaded. |
| 43.1b | **Textures and the frame.** Upload (whole texture when rows grow, `updateRanges` otherwise), one grid per camera in `adapter-frame.ts`, diagnostics, a cluster heat-map view in `adapter-lighting-views.ts`. Spike first, both renderers on the Iris Xe: integer `textureLoad`, a texel-bounded loop (D352), the sampler count of the largest existing program (WebGL 2: 16 units). |
| 43.2a | **Loop for point and spot.** `cluster-lights.ts` (`ClusteredLights`, `ClusterLightsNode`), `lights-shadows.ts` realizes records not three lights, `light-layers.ts` local subclasses go, `probe-lighting.ts`/`local-lights.ts` split points use the node. Every lit kind reads it without its own code: standard/physical, Lambert blocks and boxes, graph (PBR and custom-lit), layered terrain/walls, kit, foliage and ground cover, water, architecture, decals, instanced and GPU copies, skinned, lit effect meshes; unlit stays unlit, mode `none` leaves it out. e2e (extend, no new files): `lights.e2e.ts` a 24-lamp room where each lamp lights its own floor patch, both renderers; `material-graph-render.e2e.ts` a custom-lit graph lit by a cluster light; `shader-parity`/`env-parity` baselines re-checked (same look as three's lights within the parity tolerance). |
| 43.2b | **Area lights, effect pool, cache highlights.** Area rect/line in the loop (moving objects get them on both renderers); `effect-lights.ts` slots packed as point records (its loop node goes; `effect-light-pool.e2e.ts` still passes); `surface-highlights.ts` loses `AREA_HIGHLIGHT_LIGHTS`, reading pixels keep highlights only through the loop's highlight mode. e2e: `block-lightmaps.e2e.ts` highlight check extended to 6 area lights; `lights.e2e.ts` a moving cube lit by a rect. Measure: scene pass vs 43.0 on village/interior/landscape/look scenes, both renderers. |
| 43.3a | **Atlas, spots.** `shadow-atlas.ts` (allocator, rank, hysteresis, redraw budget; vitest: no overlaps, sizes by rank, stable under small rank changes, fallback when full), `shadow-atlas-draw.ts`, `shadow-budget.ts` folded in; `shadowAtlas` tier/level field (project-model, descriptor, manual). e2e `shadows.e2e.ts`: a spot's shadow of a moving cube, and with `shadowAtlas` 512 a lit-not-shadowed second light, both renderers. Measure: atlas pass GPU ms, redraw texels a frame. |
| 43.3b | **Points, area, cookies.** 6 faces (vitest: face pick twin vs three's cube convention), area 5 faces, cookie atlas (existing cookie e2e step in `lights.e2e.ts` moved onto it). Measure the many-lights scene's shadowed share. |
| 43.4 | **Caps retired.** `MAX_LOCAL_LIGHTS`, `takesLocalLightSlot`, `LOCAL_LIGHT_BUDGET`, the `lights_local` scene error, `arch-lights.ts`/`building-interiors.ts` room budget, `droppedLightChecks` and the `lights_dropped` code, MCP docs, `level-interior.ts`'s lamp clamp; level `localLights`/`shadowedLights` dropped by a `SCHEMA_8_STEPS` step (they no longer mean anything). Vitest: a scene with 200 lights validates; a 40-room building keeps every furnishing light; the step drops the fields. e2e: `layered-material.e2e.ts`'s furnishing step sees no Problems line. D204 closed. |
| 43.5 | **Performance and the manual.** Village, landscape, interior, look scenes and many-lights 64/256/1,000 at the 60 Hz cap, Iris Xe, 1080p, both renderers, 3 rounds, GPU clock and `uptime` logged: GPU ms per pass (scene, atlas, upload), frame p95, missed frames, main-thread ms. Targets: today's scenes cost no more than 43.0's; many-lights far below today's loop at the counts 43.0a could compile (and its trend past them); p95 ≤ 16.7 with no missed frames. Misses get cause + D-row. Manual: lighting pages (no light count; atlas budget; cookies), limits.md, tuning.md, reference regenerated. |
| 43.6 | **Acceptance.** Pixel checks above on both renderers, look shots (interior 40 lamps, many-lights, corridor) looked at, full gate once detached, independent review into §4, fixes. |

**Risks.** (1) D352: a texel-bounded loop stalling the Iris Xe; spiked in
43.1b before 43.2. (2) WebGL 2: 16 fragment samplers; the plan adds 3–4, so
43.1b counts today's largest program first; uniforms are not a risk (none
per light). (3) Program variants: one node shape; the keys that remain are
mode, layered, cookies present, highlight mode, so the program count should
fall; measured with `adapter-diagnostics.ts`. (4) Atlas redraws: shadowed
point lights cost 6 scene draws; the redraw budget and caching bound it, the
many-lights scene measures it. (5) Hooking `setupDirectLight`,
`setupDirectRectAreaLight` and the shadow render-object function: each goes
in `docs/three-upgrade-checklist.md`, and the `local-lights.ts`/
`effect-lights.ts` rows change. (6) Depth precision in 32-bit float is
ample; memory on the iGPU (medium 64 MiB) is the cost, logged.

**Split points.** 43.1a/b, 43.2a/b and 43.3a/b above are commit and agent
boundaries; each is green on its own. 43.4 can run any time after 43.3a (it drops `shadowedLights`).

## 3. Progress

| Item | Status |
|---|---|
| 43.0b | done: full plan written (§2). |
| 43.1a | done: `cluster-build.ts`, `cluster-pack.ts` (three-adapter exports), vitest `cluster-build.test.ts` (10k random lights, 0 false negatives, false-positive share 0.16; decode round-trip incl. long lists; overflow; render size). Bench `run.mjs clusters` (Node, Iris Xe host CPU, 3 × 600 frames): build + pack mean 0.08 / 0.23 / 0.91 ms at 64 / 256 / 1,000 (68 / 260 / 1,004 lights with the area lights; p95 0.08–0.14 / 0.24 / 0.96; budget 0.1 / 0.3 / 1.0: met on the mean, 64's p95 over in 2 of 3 rounds), upload 27 / 65 / 212 KB a frame (first frame 37 / 98 / 328 KB). Fast gate green (10 min, e2e smoke unchanged). |
| 43.1b | partial (spike blocks 43.2a as planned, D398): `cluster-gpu.ts` (R32UI + RGBA32F textures, whole upload on growth, written rows only otherwise: `queue.writeTexture` / `texSubImage2D`), `cluster-frame.ts` (lights gathered past the 16-light selection, one grid per camera, diagnostics `clusters`, overflow warning, `data-tl-clusters`), heat map `cluster-heat.ts` (View → Light clusters, `?clusterView=1`). **Spike, Iris Xe, both renderers:** integer `textureLoad`/`texelFetch` of R32UI and RGBA32F works in TSL (WGSL `texture_2d<u32>`, GLSL `usampler2D`); the plain `Loop(count)` over a cell's list does not stall (D352 not hit): heat map at 64/256/1,000 lights 60 fps, 0 missed, p95 16.7, WebGPU scene pass 6.3 ms raw at 860 MHz at 1,000 (~70 records a pixel; today's loop 98.9 ms); both renderers draw the same cells. **Texture units:** WebGL 2 has 32; largest program today 10 (landscape) → 12 with the lists. WebGPU allows only 16 a fragment stage on this adapter; the landscape's largest programs bind 15, so +2 lists = 17 and those pipelines fail (D398): the plan's 4 added textures do not fit on WebGPU. **Cost at the cap, heat off** (gather / build+pack / upload ms a frame, WebGPU \| WebGL 2): 64: 0.02/0.16/0.03 \| 0.02/0.11/0.03; 256: 0.06/0.35/0.03 \| 0.04/0.31/0.04; 1,000: 0.21/1.02/0.04 \| 0.18/0.93/0.05; upload 41/86/225 KB; p95 16.7, 0 missed everywhere (build budget 0.1/0.3/1.0: over at 64 and 256, browser main thread ~2× the Node bench). Village 16.7/0 missed, main CPU 5.39 \| 4.03 ms (baseline 5.67 \| 3.99), GPU 5.01 ms full clock (4.76); landscape 16.8 \| 16.7, interior 16.8 \| 16.7, 0 missed. e2e `lights.e2e.ts` heat-map step on WebGPU and WebGL 2 (99.5 % of reddened samples list the light on both; first test 5.6 → 7.3 s). Fast gate green (10 min). |
| 43.1c | done (56c7c5a6, 101f7222; fixes D398): the clusters in ONE RGBA32UI texture (records bit-cast, headers after them at a uniform word; decode twin + vitest + heat map follow), one unit. Budget `LIT_TEXTURE_UNITS` 16 / `LIGHT_PATH_TEXTURE_UNITS` 3 (`texture-units.ts`); `lit-texture-units.test.ts` counts every lit kind's fragment textures under the worst case (sun shadow, contact shadows + AO, reflections, probes, cache read, lightmap, clusters). Landscape's 15 were terrain weights + indices, 3 layer arrays, DFG, cache table + atlas, sun shadow, contact, probe index + table + atlas, reflection colour + depth. Packing: probe index and tile table one texture (−1 everywhere), terrain weights/indices as layers 2L/2L+1 of one array (−1; page 256 → 128 tiles), contact shadows carried in the AO history's z when both draw (−1). Worst-case units, base (no clusters) → now (clusters in; atlas + cookie atlas add 2): textured/skinned/instanced 15 → 14, terrain 16 → 14, kit 13 → 12, layered/trim 14 → 13, lightmapped 13 → 13, graph 9 → 9, lambert 11 → 10; the plan's 4 on the base would have made 17–20. Projected decals still +4 (base already 17–20): D399, an expected-failure test. Iris Xe: `level --classes landscape,interior --query clusterView=1` 0 page errors on WebGPU (max 14 units, landscape; interior 13), heat map seen drawing on both renderers in landscape, interior and the lights class (village: black, it has no listed lights). At the cap, 1 round (WebGPU \| WebGL 2): village p95 16.8 \| 16.8, 0 missed, main 5.48 \| 3.87 ms (baseline 5.67 \| 3.99), GPU 4.77 ms full clock (4.76); landscape 16.7 \| 16.7, 0 missed, main 5.09 \| 3.36 (5.68 \| 3.61), GPU 10.94 at 1,400 MHz (10.99), 240 draws (same); interior 16.7 \| 16.7, 0 missed, main 3.59 \| 2.27 (3.66 \| 2.22), GPU ~7.2 full clock (7.03, within one round's drift). Fast gate green (10 min); e2e lights 8.8 → 10.9 s (43.1b's heat step), terrain-paint 24.4 → 12.7, terrain-brushes 6.7 → 6.9, env-parity 48.6 → 23.1 (full-gate vs fast-gate timing). |
| 43.2a | done (0b20abe0 + this row's commit): `cluster-lights.ts` (`ClusteredLights` + `ClusterLightsNode`): every lit program loops over its cell's list (one RGBA32UI texture, `texelFetch`/`textureLoad`) and calls its own lighting model's `direct` per point/spot light, WebGPU and WebGL 2 alike; `ProbeOrderedLightsNode.getBuiltinLights` leaves the lights it draws out of three's (one program for 0–40 lights, vitest on WGSL and GLSL). **Shadows and cookies until 43.3:** a point/spot light with `castShadow` or a cookie map stays three's own node and map and is left out of the lists (`drawsClustered`), so nothing is lit twice; the 16-light selection no longer caps point/spot lights. Cell from the view position through the unjittered build projection (TAAU-proof); grid uniforms in the render group (an unchanged object kept a stale grid: lamps vanished after an edit). **Pixel checks** (`lights.e2e.ts`, both renderers): a 12-lamp room drawn by the clusters vs six lamps through three's nodes: mean 0.000, 0 % of pixels off by > 16 (tolerance ≤ 1 level mean, ≤ 0.5 %; control with the six dark: 5.4 % / 0.3 % off); Play with five scenes: 24 lamps → 26 patches (24 + 2 rings), a ring of 20 lamps reaching one pixel brighter than a ring of 16 (peak 404 vs 366, both renderers); `material-graph-render.e2e.ts` custom-lit graph lit by a cluster light (box 255/232/196 vs 189, both). **At the cap, 1 round** (WebGPU \| WebGL 2; GPU full clock): lights 64: scene pass 1.62 ms (today's loop 6.25), p95 16.7 \| 16.7, 0 missed, main 3.81 \| 1.74; 256: scene 3.84 (19.9), p95 16.8 \| 16.7, 0 missed (loop: 33.4 \| 66.6), main 4.53 \| 2.78; 1,000: scene 12.3 (~99), p95 33.4 \| 33.4, 96/504 \| 79/377 missed, 50 \| 38 fps (loop: none \| 5.7), main 8.29 \| 6.49 (D400). Classes: village (no local lights; programs unchanged) p95 16.8 \| 16.7, 0 missed, main 5.72 \| 3.94 (baseline 5.67 \| 3.99; a first round right after the gate read 6.27 \| 4.35 at load 4–5), scene pass 3.0 raw at 1,241 MHz (3.87 at 908); landscape 16.7 \| 16.7, 0 missed, GPU 10.74 at 1,400 (10.99), scene 7.31 (7.67), main 5.97 \| 3.34 (5.68 \| 3.61); interior 16.8 \| 16.8, 0 missed, scene 4.08 full clock (4.41), main 3.66 \| 2.22 (3.66 \| 2.22). Shots looked at: 64/256/1,000 both renderers, the whole field lit. Fast gate green (start.e2e's backend exit failed once, passed on rerun; `lit-texture-units` timed out once at 5 s under load, given 60 s). e2e lights 10.9 → 17.9 s (lamp room), material-graph-render unchanged. |
| 43.2b | done (3945af19, cb6edc48): area lights (rect, line) in the clusters' loop (`cluster-area.ts`): the physical model's own `directRectArea` (LTC, both tables in one half-float texture read at level 0), Lambert/Phong/custom-lit their exact form factor through `direct`; the cache's window over the reach, so moving objects and cache-lit walls match (vitest twin vs the cache's CPU light, 4 %). Effect lights are cluster records (`effect-lights.ts` a growable pool, no node; `EFFECT_LIGHT_LIMIT` gone, a Lights block's max is `EFFECT_MAX_PARTICLES`); a kind bit marks lights the cache does not hold, kept whole on reading surfaces. Reading builds keep only the cache lights' highlights from the same loop; `AREA_HIGHLIGHT_LIGHTS`, its slots, the variant key and `?surfaceHighlights` gone. `areas` and `uncached` are program-shape flags like `layered` (built into every program, the area branch cost 0.5–1.5 ms of scene pass where no area light was). **Pixel checks:** `lights.e2e.ts` Play, moving floor, both renderers: ring of 6 area lights peak 502 vs ring of 4 419 (the old path drew none on moving objects); `block-lightmaps.e2e.ts` (WebGPU): pool 50.7 (today 50.5; saved pool 49.0, ratio < 1.4 asserted: no doubled diffuse), highlight 18.9 with 5 nearer area lights behind the camera (today's 4-light pick would drop it); `effect-light-pool.e2e.ts` both renderers: 16 glows then one effect lighting 24 particles, 40 lights, 0 programs/pipelines built, brightness 225 → 231. **At the cap** (WebGPU \| WebGL 2, scene pass full clock; 2–3 rounds, load 1.0–5.3): village p95 16.7 \| 16.7, 0 missed, scene 2.63 (43.2a 2.66, base 2.51), main 5.74 \| 4.09 (5.67 \| 3.99); landscape 16.8 \| 16.7, 0 missed, scene 7.18 at 1,400 (7.31; 7.67), main 5.23 \| 3.53; interior 16.7 \| 16.8, 0 missed, scene 4.18 (4.08; 4.41), main 3.70 \| 2.29 (3.66 \| 2.22). Lights class (its 4 area lights now drawn): 64 scene 2.22–2.47 (43.2a 1.62; today's loop 6.25), p95 16.7–16.8, 0 missed, main 3.71 \| 1.87; 256 4.68–4.84 (3.84; 19.9), 0 missed, main 4.78 \| 2.83; 1,000 10.7–13.2 (12.3; ~99), p95 16.8–33.4 \| 33.4, 19–73/~550 \| 71–103/~380 missed (D400), main 8.5–8.8 \| 6.3–6.6. Shots 64 both renderers looked at (field lit alike). Fast gate green (block-lightmaps' export 400 once, D319 watch, passed on rerun). e2e: lights 17.9 → 17.9 s, block-lightmaps ~12 → 12.3, effect-light-pool ~22–28 → 25.8. Effect editor's preview pane: D401. |
| 43.3a | done (a1699067 + this row's commit): `shadow-atlas.ts` (quadtree tiles 128–1,024 by rank, 30-frame hold, ¼ of the atlas redrawn a frame, 0.25 s fades; `shadow-budget.ts`'s rank folded in, its budget now point lights only), `shadow-atlas-draw.ts` (one 16-bit depth atlas per renderer drawn through three's shadow pass, tile viewport + wipe quad), 6-texel shadow records after the light records, four hardware compares in the loop (`shadows` program flag, one unit: `lit-texture-units` worst case now meets 16 with the atlas). Shadowed spots are clustered; their per-light maps are gone (any number share one unit and one program, `cluster-lights.test.ts` 1 vs 12). Level/tier `shadowAtlas` 2,048/4,096/8,192. **Pixel checks** (`lights.e2e.ts`, Scene view, both renderers): two spots' cube shadows vs today's maps (a63ac2c1, measured twice, same): WebGPU 759/2,549 samples, darkening 175.6/179.8 (today 765/2,552, 175.0/180.0); WebGL 2 124/169, 158.6/166.3 (121/169, 175.5/176.7; tolerance 20 %); a moved cube's shadow follows; at `shadowAtlas` 512 one spot shadowed, the other lit unshadowed; a rank swap: 0 wrong samples in 8 frames on the way, then the other spot's shadow. Shots looked at. **At the cap, 1 round** (WebGPU \| WebGL 2): interior (2 shadowed spots) p95 16.8 \| 16.8, 0 missed, scene 4.46 raw at 1,189 MHz (43.2b 4.18 full clock), its two spot maps (0.20 + 0.18 ms every frame) gone, atlas pass 0.95 ms in 2 of 180 frames, main 3.07 \| 1.95 (3.70 \| 2.29); landscape 16.7 \| 16.7, 0 missed, scene 7.09 at 1,400 (7.18), main 4.95 \| 3.27; village 16.7 \| 16.7, 0 missed, main 5.44 \| 4.07, GPU 5.88 full clock. Lights class (8 shadowed: 4 spot, 4 point): 64 scene 1.78 raw at 742 MHz (43.2b 2.22–2.47), 0 missed, main 3.40 \| 1.61 (3.71 \| 1.87); 256 scene 3.70 (4.68–4.84), 0 missed, main 4.05 \| 2.53 (4.78 \| 2.83); 1,000 scene 12.2 (10.7–13.2), p95 33.3 \| 33.4, 64/536 \| 73/382 missed (D400), main 7.30 \| 5.89 (8.5–8.8 \| 6.3–6.6); atlas pass 0.15–0.95 ms in 1 frame of 161–181 (static lights and casters: tiles drawn once). Fast gate green (vitest `scan-bounded-log` failed once under load, passed alone; lights' 512 step reordered after one red). e2e lights 17.9 → 41.4 s in the fast gate (the spot steps on both renderers and a page load each). |

## 4. Decision log

- 2026-10-26 (owner, relayed from session thirdlight-45): clustered lighting
  becomes its own phase after 42. The 2026-10-22 decision had made it "its
  own item inside 42", but no 42.x item was ever added.
- 2026-10-27 (owner, relayed from session thirdlight-d0): WebGL 2 gets the
  same clustered path (data textures, `texelFetch`, shared shadow atlas); the
  16-light per-pixel path is not kept as a fallback. Cluster lists are built
  one way for both backends (CPU by default); a compute build must produce
  the same packed lists.
- 2026-10-28 (43.0b): Default chosen, owner to confirm: (1) local lights
  stop being three.js lights: one `ClusteredLights` light and node carries
  them all (point, spot, area, effect slots), so a light change builds no
  program; (2) a fixed 16 × 9 × 24 froxel grid (exponential slices from
  0.25 m to the farthest light's reach), independent of render scale;
  (3) packing: RGBA32F light records (4 texels, view space, rewritten each
  frame) and one R32UI texture for headers and index lists; textures grow on
  demand under a 16 MiB index budget, overflow drops the lowest-ranked
  lights per cluster with a diagnostic; no per-cluster cap; (4) main-thread
  build ≤ 0.1/0.3/1.0 ms at 64/256/1,000 visible lights; (5) shadow atlas
  depth32float, tier sides 2,048/4,096/8,192 (16/64/256 MiB) in a new
  `shadowAtlas` tier and level field; tiles 128–1,024 (spot), 64–512 per face
  (point 6, area 5 faces from its centre), 30-frame hysteresis, a quarter of
  the atlas redrawn a frame at most, a lost tile fades in 0.25 s; 2×2 PCF;
  (6) cookies in a 2,048² RGBA8 atlas of 256² tiles; (7) area lights reach
  moving objects (diffuse and specular), Lambert/custom-lit through their
  form factor; (8) the level fields `localLights` and `shadowedLights` are
  dropped by a schema-8 step. Open: the effect pool's `EFFECT_LIGHT_LIMIT`
  (16 slots) stays this phase; lifting it is cheap once clusters exist
  (owner to say); whether high's 256 MiB atlas is wanted on discrete GPUs.
- 2026-10-28 (lead, default chosen, owner to confirm): the 43.0b open
  questions are settled so the phase need not stop. (a) The effect pool's
  16-slot `EFFECT_LIGHT_LIMIT` is lifted in 43.2b: effect lights join the
  cluster lists like any other local light (no per-project count caps).
  (b) The shadow atlas uses 16-bit depth (`depth16unorm` / `DEPTH_COMPONENT16`)
  unless 43.3a measures visible acne or peter-panning it cannot bias away;
  tier sides stay 2,048/4,096/8,192, so 8/32/128 MiB. High's 128 MiB atlas
  is kept for discrete GPUs.
- 2026-10-28 (43.1a, default chosen, owner to confirm): (1) record slots as
  packed: t2.w is the layer mask and t3.w the shadow record for every kind;
  a spot's t3 is cos outer, cos inner, cookie; an area light's t2/t3 are its
  half sides `u`, `v` (view) with `u × v` along its facing, a line's `v` the
  `LINE_HIGHLIGHT_METRES` strip; t1.w = kind (2 bits) + two-sided bit +
  8 × round(decay × 256). (2) A long list (≥ 1,023) keeps one header texel:
  count 1,023 flags it and the list's first texel holds the real count, so a
  header stays indexable by cell. (3) "Nearest" = the smallest centre
  distance from the eye; it ranks first whatever its brightness. (4) The
  list budget reserves two texels a cell (header, long-list count) off
  `CLUSTER_INDEX_TEXELS`. (5) Area volume: within reach of the rect (or
  segment), facing side only unless two-sided, reach measured from the
  emitter. Notes for 43.1b: tiles are numbered from NDC (x right, y up), so
  a fragment's y share must be flipped where the backend's screen origin is
  top-left; the overflow console warning naming the scene is the frame's
  job (the build only counts); the build's slice range (`sliceNear`,
  `sliceFar`, `scale`, `bias`) changes every frame and goes in uniforms.
- 2026-10-28 (43.1b spike, for the owner/lead before 43.2a): the Iris Xe's WebGPU adapter caps a fragment stage at
  16 sampled textures (no higher limit to request), and the landscape's largest programs already bind 15 (D398).
  The plan's lists (2), shadow atlas (1) and cookie atlas (1) do not fit there; WebGL 2 (32 units) has room. Options,
  none a second light path: (a) one list texture: records and lists in one RGBA32UI texture (floats as bits), +1;
  (b) a texture budget for lit programs (the engine's own maps leave room: 16 minus lists, atlas, cookies), the
  terrain/layered programs merged into arrays to meet it; (c) lists in storage buffers on WebGPU and textures on
  WebGL 2 (same packed data and decode; changes the owner's "texelFetch on both" decision); (d) cookies in the
  shadow atlas's texture as a second layer. Lead default proposed: (a)+(b), checked by the texture-unit count the
  perf harness now records (`textureUnits`). Not decided here: the item hands back.
- 2026-10-28 (43.1b, default chosen, owner to confirm): the lists hold every realized local light, not the 16 the
  per-pixel selection switches on (the build is measured at the counts 43.2a will pack); the heat map replaces the
  lit result (blue 1 → red 64+, dimmed where listed lights do not reach), custom-lit graph materials keep their own
  look under it.

- 2026-10-28 (lead, D398, default chosen, owner to confirm): the light path
  keeps data textures read with `texelFetch` on both renderers (the owner's
  one-path rule; WebGPU storage buffers are not used). (a) The records and
  the headers/lists share ONE RGBA32UI texture (records bit-cast), so the
  clusters take one unit. (b) Lit programs get a texture-unit budget of 16
  (WebGPU's per-stage floor on the Iris Xe), checked by a test over every
  lit program kind: the clusters, the shadow atlas and the cookie atlas take
  3 units, and pay for them by retiring today's per-light spot/point shadow
  maps and cookie textures; any program still over budget (the landscape's
  terrain programs) packs its own textures (e.g. into array layers) in a new
  item 43.1c before 43.2a.

- 2026-10-29 (43.1c, default chosen, owner to confirm): to meet the 16-unit budget, (1) a terrain page holds
  128 tiles, not 256 (its layer texture takes two array layers a tile within the 256 both renderers guarantee;
  the landscape's 144 tiles now take two pages at no measured cost); (2) when ambient occlusion and contact
  shadows both draw, the contact shadows ride in the AO history's third channel (one pass and one texture
  fewer); (3) projected decals stay over budget for now (D399), a material reached by a decal at the worst
  case can fail on WebGPU, as it already could before this phase. The worst case leaves a material 4 textures
  of its own (a standard PBR set) when it reads the cache; a graph with more fails on WebGPU at that worst case.

- 2026-10-29 (43.2a, default chosen, owner to confirm): (1) until the shared atlases (43.3), a point or
  spot light that casts a shadow or projects a cookie stays three's own light node with its own map, left
  out of the lists (nothing is lit twice); a cookie arriving moves a spot to that path (one program
  rebuild, as a cookie always caused). Every other point and spot light is drawn by the one
  `ClusteredLights` node. (2) The 16-light selection no longer caps point and spot lights: every loaded
  scene's lights are on (a quality level's `localLights` still holds when set; the per-scene
  `lights_local` rule stays until 43.4). (3) A pixel's cell comes from its view position through the
  unjittered projection the lists were built with, not its screen coordinate: TAAU's jitter no longer
  moves a pixel into a neighbouring tile (43.1b's note); the heat map does the same. (4) A light without a
  range keeps three's falloff with no window and stops at its reach (`LIGHT_REACH_FLOOR`); a record says
  which with the kind field's bit above the kind (the area lights' two-sided bit). (5) A layered light's
  record carries its room (room key + 1 above the 8 layer bits of the layer word, exact for 65,535 rooms)
  and the test runs per pixel (per vertex on a mesh spanning rooms); the layer and room test is built only
  while some clustered light is layered (in the lights node's key). The CPU's per-object skip of a lamp
  in another room is gone with three's per-light nodes. (6) The `ClusteredLights` object is in the scene
  while any point or spot light is realized: the first lamp builds the lit programs once, later ones
  build nothing; `light-layers.ts`'s point/spot subclasses stay for the shadowed and cookie lights (and
  carry masks for the gathering) until 43.3. (7) Cache-reading builds take the loop as a local light:
  `buildReadLights` keeps its highlights and drops its diffuse where the cache is found, as it did with
  three's nodes (43.2b's highlight mode refines it).

- 2026-10-29 (43.2b, default chosen, owner to confirm): (1) the LTC tables (area lights) take a texture unit only
  while an area light is realized; the light path's third unit is "the light tables": 43.3b puts the cookie atlas
  in the same texture (half float, the LTC tables in one corner tile; 2,048² RGBA16F = 32 MiB, not the planned
  16 MiB RGBA8), since the 16-unit budget has no room for a fourth unit (cache-reading textured/terrain programs
  reach 15 with the tables). (2) `areas` (area kinds' code) and `uncached` (a reading build's separate sums for
  effect lights) are program-shape flags like `layered`: the first area light or effect light pool in a scene
  builds the lit programs once more; scenes without them keep 43.2a's programs and cost. (3) An area light on a
  non-physical model (Lambert, Phong, custom-lit) is its exact LTC form factor toward the rect's centre through
  `direct` (N·L clamped at 0.05). (4) A Lights block's `maxLights` is bounded by the system data bound
  (`EFFECT_MAX_PARTICLES`, moved to `effect-graph-kinds.ts` and used by `EFFECT_LIMITS`), the effects' pool grows
  without a count; `renderer.effects.caps.lights` is gone and `lightPool` reports the slots held. (5) An area light
  in mode baked draws per pixel until its bake holds it (as the gathering already did), so before a bake WebGL 2
  draws it too. (6) The effect editor's preview pane has no light clusters: effect lights light nothing there
  (D401).

- 2026-10-29 (43.3a, default chosen, owner to confirm): (1) the atlas is 16-bit depth as the lead's default said
  (`depth16unorm` / `DEPTH_COMPONENT16`): a spot's camera reaches its range (its reach without one) from three's
  0.5 m near plane, and with a depth bias of −0.0002 and a one-texel normal offset no acne or peter-panning showed
  in the lamp room's shots on either renderer; (2) three's render targets need a colour attachment, so the atlas has
  an R8 one beside the depth (never written): low/medium/high 12/48/192 MiB in all, not 8/32/128; (3) a spot
  shadow record is 6 texels, not the plan's 5: the view → atlas matrix (the CPU folds the tile and the depth
  convention into it), the tile and strength, and near/far/bias/normal offset (near/far for a logarithmic depth
  buffer); (4) tile size from rank: the largest (1,024, never past the atlas) while the light's reach is at least
  half its distance from the eye, halving with it down to 128; a light that does not fit takes a smaller tile,
  else waits unshadowed; a better-ranked light without room makes the lowest-ranked holder fade out (0.25 s, one at
  a time) and takes its place; a light gaining a tile fades in over 0.25 s; a light out of view loses its tile at
  once; (5) `shadowedLights` budgets shadowed point lights only from now on (a spot's shadow is its atlas tile;
  the level's `shadowMapSize` no longer touches spots); (6) a host drawing on demand (the editor) is asked for
  frames while an atlas shadow fades or a tile waits to be drawn.

