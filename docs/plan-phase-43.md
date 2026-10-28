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

