# three.js upgrade checklist

The engine pins three 0.186.1 (r186). A few renderer hooks reach into three's
private or undocumented members because r186 has no public way to do what
they do. Almost all are guarded by `typeof` checks: on a three whose
internals moved they install nothing and throw nothing, so a broken hook
shows up as a hitch, a leak or wrong shading, never as an error. Their unit
tests run against hand-written fakes of r186's behaviour, so they keep
passing whatever three does. Every three upgrade (patch or minor) goes
through this list before it lands.

All paths are under `packages/three-adapter/src/` unless they say
otherwise. Most hooks are installed in `renderer-factory.ts`
(`registerLayeredLights`, `registerProbeLighting` round line 340; the
dispose and build hooks round line 520, in that order).

## 1. Read the release notes against these members

For each row, check the new three's source for the member, its signature
and the behaviour the hook relies on. A rename or a changed meaning is a
change to the hook (or its removal, if three now does the job itself).

| Hook | three internals it uses | What it does, and why |
|---|---|---|
| `node-builds.ts` `installBuildReuse` | `renderer._nodes` (`NodeManager`: `getForRender`, `getForRenderCacheKey`, `delete`, `get(ro).nodeBuilderState`, `nodeBuilderCache` Map), `renderer._pipelines` (`_getRenderPipeline`, `_releasePipeline`, `_releaseProgram`, `caches` Map), `usedTimes` as the reference count of builder states, pipelines and programs, `RenderObject.initialCacheKey` | Keeps a node build, pipeline and program its last user dropped for 10 s, so a re-bake's new objects reuse them (r186 releases them at once: 10–28 ms a program, 80–100 ms a re-bake). Runs in every renderer, exports included. The dangerous change is one the guard does not see: who decrements `usedTimes`, whether `delete` releases the state itself, or a cache key other than `getForRenderCacheKey`: builds leak or are released twice. |
| `node-builds.ts` `installBuildMarks` | `nodes.getForRender` (wrapped on the instance), `pipelines._getRenderPipeline`, `caches.size` | The `tl:node-build` / `tl:pipeline` marks the perf harness and e2e tests read. |
| `light-layers.ts` (layered lights) | `renderer.library.addLight(NodeClass, LightClass)`; subclasses of `DirectionalLightNode`, `SpotLightNode`, `PointLightNode`, `AmbientLightNode`, `HemisphereLightNode`, `ShadowNode`, `PointShadowNode`; overrides of `setup`, `setupDirect` (returning `{ lightColor }`), `setupShadowNode`, `getShadowRenderObjectFunction(renderer, shadow)` (object first in the render function it returns); `colorNode` / `groundColorNode`; `uniform().onObjectUpdate` | Light layers and room-bound lights: a per-object factor, and a per-draw branch that skips a light for objects outside its layers or room. **The branch's anchor** (`SURFACE_ANCHOR`): TSL declares the shared surface values (view and world position, view direction, normals) where they are first used; first used inside a skipped branch they stay unset and every later light shades black. Check whether the new TSL still declares on first use (the anchor may then be unnecessary, or a new shared value may need adding to it). Not guarded. |
| `probe-lighting.ts` `ProbeOrderedLightsNode` | extends `LightsNode`; overrides `setupLights(builder, nodes)`, `customCacheKey()`, `static type = 'LightsNode'`; replaces `renderer.lighting.createNode`; reads `builder.context.irradiance` | Orders the light nodes so the probe light replaces the ambient light, and splits local lights per vertex / per pixel. |
| `node-materials.ts` `withoutLights` | instance `material.setupLighting`, `customProgramCacheKey`, `builder.lightsNode`, `renderer.lighting.createNode` | Materials drawn without the scene's lights. |
| `local-lights.ts`, `effect-lights.ts` | `builder.lightsNode.getLights()`, `builder.material`, `builder.context.{ irradiance, lightingModel, reflectedLight, positionView }` | Per-vertex local lights; the effect light pool. |
| `dispose.ts` | `_objects._renderObjects`, `_attributes`, `_geometries._geometryDisposeListeners`, the WebGL backend's `_createVao` / `_getVaoKey` / `vaoCache`, `renderer._textures`, `_pipelines._releasePipeline` / `_releaseProgram` with `backend.gl` / `backend.get`, `_renderContexts._renderContexts` | r186 leaks: VAOs never deleted, texture dispose listeners kept, WebGL 2 programs and shaders never deleted, MRT contexts kept, a shared geometry's dispose refusing later submits. Each fix may be obsolete in a newer three (check the notes for these leaks first). `installProgramRelease` and `installBuildReuse` wrap the same two release methods: the program release must be installed first. |
| `adapter.ts` diagnostics | `ro._nodeBuilderState` over `_objects._renderObjects` | Counts distinct node programs (r186's `info.memory` has none). |
| `effects-gpu.ts` | `renderer._attributes.delete` | Frees compute-only storage buffers. |
| `probe-atlas.ts` | `backend.isWebGLBackend`, `backend.copyTextureToTexture`, `backend.device.queue`, `backend.get(texture).texture` | Copies probe tiles into the atlas on the GPU. |
| `renderer-factory.ts` | `backend.extensions`, the WebGL backend's lose-context on dispose, injecting a probed device / WebGL 2 context into the backends, `backend.isWebGPUBackend`, programs counted from internals | Renderer creation and teardown. |
| `ktx2.ts` | `KTX2Loader._createTextureFrom` (patched on the instance) | Texture arrays and streamed mips from KTX2. |
| `cached-shadow.ts` | `renderer._isPreCompiling` | The cached static shadow map is not redrawn during a precompile. |
| `post-ao.ts` | `scenePass._cameraNear`, `_cameraFar` | Depth to view distance for ambient occlusion. |
| backend flags | `backend.isWebGLBackend` (`terrain-macro.ts`, `terrain-brush-gpu.ts`), `backend.isWebGPUBackend` (`probe-bake.ts`), `backend.trackTimestamp` / `disjoint` (`gpu-timing.ts`, `editor/src/viewport/preview-effect.ts`) | Renderer-specific paths and GPU timing. |

Comments in `attribute-instancing.ts`, `custom-lit.ts` and
`material-graph.ts` also describe r186 behaviour (per-InstancedMesh program
builds, `LightsNode.setup`'s lighting flow, `updateType` reset); read them
against the notes too.

## 2. Check that the hooks still install

- The build hooks return whether they installed (`installBuildMarks`,
  `installBuildReuse`). After the upgrade, a level perf run must still show
  `tl:node-build` marks in its edit windows (`node tools/perf/run.mjs
  level --classes landscape --spline-edit`, the windows' `nodeBuilds`):
  none at all means the marks did not install; the edit windows' node builds on a re-bake should
  stay near zero (the reuse works), not 80–100 ms a re-bake.
- Leaks: `tests/e2e/memory.e2e.ts` (open/close and load/unload cycles back
  to their baseline: heap, graphics API counts, `info.memory`) and
  `play-memory.e2e.ts` (Play's counts flat frame over frame), both
  renderers.

## 3. Check the shading on both renderers

These hooks are only proven by pixels:

- Layered and room-bound lights: `tests/e2e/lights.e2e.ts` (every light
  after a skipped one still lights), the rooms lighting checks in
  `tests/e2e/layered-material.e2e.ts` (a lamp stops at the shared wall).
- Probe and local lights: `tests/e2e/lightmaps.e2e.ts`,
  `block-lightmaps.e2e.ts`, `effect-light-pool.e2e.ts`.
- Materials and AO: `tests/e2e/material-graph-render.e2e.ts` (every node
  kind drawn), `material-custom-lit.e2e.ts`.
- The village perf check (`tools/gate.sh fast` ends with it) against its
  baseline, both renderers.

Run them with `tools/gate.sh start fast <these files>` (memory-capped), then
the phase's full gate as usual.

## 4. Record

The upgrade's plan row lists each hook as kept, changed or removed (three
now does it), with the run that shows it.
