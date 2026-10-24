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
| `projected-decals.ts` (projected decals) | `NodeMaterial.prototype.setupDiffuseColor`, `setupAmbientOcclusion`, `setupNormal`, `setupLighting` and `MeshStandardNodeMaterial.prototype.setupVariants` / `setupSpecular` (patched once on the prototypes, in r186's call order: diffuse colour → AO → variants → lighting, normal lazily through `builder.context.setupNormal`); the TSL property nodes `diffuseColor`, `metalness`, `roughness`, `ambientOcclusion`, `diffuseContribution` and `builder.context.ambientOcclusion`; `renderer.renderObject` (wrapped: a draw a decal reaches wears an `Object.create` variant of its material with its own `_listeners` and `customProgramCacheKey`); `texture().load`, `.depth()`, `.grad()`; a bound texture node's swap rebinding on WebGL 2 only for a new `version` | The decal blend before lighting, for the draws a decal can reach only. A scene without projected decals must build the same WGSL (`projected-decals.test.ts` and `mesh-decals.test.ts` digests). If three changes what `setupVariants` derives from the metalness (specular colour, diffuse contribution) the hook must derive it again the same way. Not guarded. |
| `see-through.ts` (see-through) | `NodeMaterial.prototype.setupDiffuseColor` (patched once, beside the decal step; a discard added before three's own `maskNode` discard), `renderer.contextNode` (its `value` merged into every build's `builder.context` by `NodeBuilder.prebuild`; its `id` and `version` part of every render object's dynamic cache key, so `needsUpdate` rebuilds each program once), `material.isShadowPassMaterial` on the shadow pass's override material, `uniform().onObjectUpdate` per draw and `uniformArray(...).setGroup(renderGroup)` filled from an `onRenderUpdate` (the render's `camera`) before the group uploads, TSL `Loop` with a uniform `int` end, `shiftRight` / `bitAnd` on an `int` uniform (WGSL casts the shift to `u32`) | The see-through mask in every node material's fragment stage, only for renderers a view armed. An unarmed renderer must build the same WGSL (`see-through.test.ts` against the recorded `SHADER_TYPE_WGSL` / `PLAIN_GRAPH_WGSL` digests). If the context node stops being part of the cache key, arming would leave old programs drawn without the mask; if the shadow pass stops marking its material, faded walls would dither their shadows. Not guarded. |
| `vertex-paint-draw.ts` (vertex paint) | a render object's program key holding its geometry's attribute names (`RenderObject.getGeometryCacheKey`, part of `getMaterialCacheKey`): a painted draw's `tlPaint` attribute or `tlPaintSlot` marker gives it a program of its own; the marker (a view of each instance matrix's float 3, never read) bound only when a shader reads it (`renderObject.getAttributes()`); `uniform().onObjectUpdate` setting a texture node's `value` per draw before the bindings update (`_nodes.updateForRender` then `_bindings.updateForRender`); a `TextureNode` subclass without its transform and flip-Y (`setUpdateMatrix`, `setupUV`); `vertexIndex` | Painted copies in their one instanced draw read their paint stream by slot and vertex index; everything else keeps its program (`vertex-paint-draw.test.ts` digests). If the key stops holding attribute names, painted and unpainted draws would share a program: paint would read wrong or not at all. Not guarded. |
| `dispose.ts` | `_objects._renderObjects`, `_attributes`, `_geometries._geometryDisposeListeners`, the WebGL backend's `_createVao` / `_getVaoKey` / `vaoCache`, `renderer._textures`, `_pipelines._releasePipeline` / `_releaseProgram` with `backend.gl` / `backend.get`, `_renderContexts._renderContexts` | r186 leaks: VAOs never deleted, texture dispose listeners kept, WebGL 2 programs and shaders never deleted, MRT contexts kept, a shared geometry's dispose refusing later submits. Each fix may be obsolete in a newer three (check the notes for these leaks first). `installProgramRelease` and `installBuildReuse` wrap the same two release methods: the program release must be installed first. |
| `adapter-diagnostics.ts` | `ro._nodeBuilderState` over `_objects._renderObjects` | Counts distinct node programs (r186's `info.memory` has none). |
| `dispose.ts` `releaseStorage` (effects, the depth pyramid) | `renderer._attributes.delete` | Frees compute-only storage buffers. |
| `environment-nodes.ts` (the frame in two passes) | `PassNode.updateBefore` (patched on the scene pass's instance) calling `renderer.render(scene, camera)` once, with the pass's target, MRT and clears already set; `renderer.render` replaced for that one call | Occlusion culling's WebGPU frame: the scene pass's one render is drawn as two passes with the depth pyramid between them. If the pass renders more than once or sets its target inside `render`, the two passes split wrongly. |
| `occlusion-passes.ts` | `renderer.setRenderObjectFunction` / `getRenderObjectFunction`, `renderer.opaque` / `transparent`, `renderObject`'s arguments; `Background.update` clearing for a colour background unless `autoClearColor` / `Depth` / `Stencil` are all false; `RenderList.push`'s transparent rule (`transparent`, `transmission > 0`, `transmissionNode`, `backdropNode`), mirrored in `drawnAsTransparent`; MSAA targets loaded and stored between renders (`storeMultisampled*` not false) and resolved at each render's end (the pass descriptor caches `resolveTarget`) | Which pass draws what. A changed list rule would draw a transmissive draw in neither pass; a clear in the second pass would wipe the first. Pixels (rendering.e2e's export, culling on vs off) catch both. |
| `occlusion-pyramid.ts` | TSL `textureLoad` of a depth texture (on a multisampled one the level argument is the sample: `textureLoad(t, c, u32(level))`), `instancedArray` / `storage(...).toAtomic()` over one attribute, atomics in a fragment stage (r185 #33626), a `ComputeNode`'s `count` changed per frame (its `countNode` follows), several compute nodes in one `renderer.compute` call (one pass, dispatches in order), `Fn`'s builder argument (`builder.camera`) | The depth pyramid and the stand-ins' records. The e2e read-back checks the reduction rule level over level (`pyramidBreaks`). |
| `occlusion-instances.ts`, `attribute-instancing.ts` (instanced copies culled on the GPU) | `geometry.indirect` / `indirectOffset` read per draw (`Geometries.getIndirect`, `WebGPUBackend.draw`'s `drawIndexedIndirect` / `drawIndirect`), set per pass in `onBeforeRender`, which `renderObject` calls before it fetches the render object and updates its nodes; a draw whose CPU `instanceCount` is 0 is skipped (it stays the copies in view); an `IndirectStorageBufferAttribute` made `STORAGE \| INDIRECT \| COPY_SRC` and never uploaded again while its `version` stays; `RenderObject.getGeometryCacheKey` holding attribute names (the `tlCulledCopies` marker) and `RenderObjects.get` rebuilding only when `material.version` changed (marking a drawn draw bumps it); `uniform().onObjectUpdate` per draw, with a storage node's `value` swapped there and rebound because `Bindings._update` compares `bindingData.attribute`, which three does only on a full refresh: `NodeMaterial.prototype.setupObserver` is wrapped so a culled draw's observer's `needsRefresh` answers `RenderObjectRefreshType.FULL` whenever its list, range or pools changed for that render object (without it a draw of a plain material kept a destroyed pool bound and its pass was dropped); the passes and the dispatches submitted in order (`renderer.compute` and each `renderer.render` submit their own command buffers), so the pass flag the dispatches write into the list buffer is the one each pass reads; `instance_index` from 0 (no first instance); compute nodes with an array `dispatchSize` (no early return, so barriers stay in uniform flow over a read-only table); `getArrayBufferAsync(attribute, readbackBuffer, offset, count)` of the arguments into one `ReadbackBuffer` (mapped, read, `release()`d each read; a second read before the release throws); the render-object function setting a plain mesh's `geometry.indirect` / `indirectOffset` for one draw and putting it back after (`occlusion-whole.ts`: three reads them per draw, they are not part of the render object's cache key); a terrain page's node attributes read through the list (`culledCopyVec4` in `terrain-material.ts`, the `tlCulledCopies` marker on the node buffer) | The view's instanced draws draw the copies the compute listed. If the indirect slot became part of the pipeline, or the dispatches and passes were reordered, a pass would draw another pass's list: pixels (rendering.e2e's export, culling on vs off with batches and a painted instance set) catch it. |
| `probe-atlas.ts` | `backend.isWebGLBackend`, `backend.copyTextureToTexture`, `backend.device.queue`, `backend.get(texture).texture` | Copies probe tiles into the atlas on the GPU. |
| `renderer-factory.ts` | `backend.extensions`, the WebGL backend's lose-context on dispose, injecting a probed device / WebGL 2 context into the backends, `backend.isWebGPUBackend`, programs counted from internals | Renderer creation and teardown. |
| `ktx2.ts` | `KTX2Loader._createTextureFrom` (patched on the instance) | Texture arrays and streamed mips from KTX2. |
| `cached-shadow.ts` | `renderer._isPreCompiling` | The cached static shadow map is not redrawn during a precompile. |
| `post-ao.ts` | `scenePass._cameraNear`, `_cameraFar` | Depth to view distance for ambient occlusion. |
| backend flags | `backend.isWebGLBackend` (`terrain-macro.ts`, `terrain-brush-gpu.ts`), `backend.isWebGPUBackend` (`probe-bake.ts`), `backend.trackTimestamp` / `disjoint` (`gpu-timing.ts`, which resolves the `render` and `compute` pools; `editor/src/viewport/preview-effect.ts`) | Renderer-specific paths and GPU timing. |

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
- The frame in two passes and the depth pyramid (WebGPU): the export's
  culling on vs off pixels in `tests/e2e/rendering.e2e.ts` (the post stack
  with AO and glass behind a stand-in, the plain MSAA frame, a render scale,
  poses along a moving camera, instanced copies, models culled whole and
  terrain nodes culled) and its pyramid read-back.
- Projected decals: the decal reads in `tests/e2e/layered-material.e2e.ts`
  (terrain, blocks, props, a generated wall, normal only, a layer mask;
  Scene view, Play and the export).
- Vertex paint: the painted reads in `tests/e2e/level-acceptance.e2e.ts`
  (a model alone, in a batch, merged, an instance copy, a generated wall, a
  spline; Play and the export, and the painted draws counted).
- The village perf check (`tools/gate.sh fast` ends with it) against its
  baseline, both renderers.
- WGSL digests: `packages/three-adapter/src/material-graph-specular.test.ts`
  (and `vertex-paint-draw.test.ts`, every shader type alone and through
  instance columns) compares the WGSL three builds for graphs without a feature against
  recorded digests. A new three changes the text: check that the new WGSL
  is only three's change (no feature's nodes leaking in), then re-record the
  digests from the failure message.

Run them with `tools/gate.sh start fast <these files>` (memory-capped), then
the phase's full gate as usual.

## 4. Record

The upgrade's plan row lists each hook as kept, changed or removed (three
now does it), with the run that shows it.
