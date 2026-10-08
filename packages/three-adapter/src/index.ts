/**
 * @thirdlight/three-adapter — public surface (the dependencies.md rows:
 * `createSceneAdapter(canvas, opts) → SceneAdapter { renderFrame,
 * captureScreenshot(maxWidth), diagnostics, dispose }`, `ERROR_CODES`, and
 * "the GLB realization/resource-owner helpers + an injected byte
 * resolver: the adapter accepts **bytes or a resolver function**, never a
 * token/URL/fetch; GLTFLoader/AnimationClip preview helpers").
 *
 * The root subpath stays loader-free: the real `three/examples/jsm` GLTFLoader
 * binding is on the `./gltf-loader` subpath so the export/preview bundle
 * graphs keep their recorded `export.md` counts.
 *
 * Thirdlight three.js scene adapter + shared GLB realization
 * path. Node-side dependencies:
 * @thirdlight/runtime, three.
 */
export { createSceneAdapter, type SceneAdapter, type SceneAdapterDiagnostics, type SceneAdapterOptions, type ScreenshotResult, type FrameDrawnInfo } from './adapter';
export type { SceneRuntime } from './adapter-types';
export { ERROR_CODES, RENDER_NOT_READY, type AdapterError, type AdapterErrorCode } from './errors';
// The one renderer factory (Play/export, the Scene view, previews).
export {
  createRenderer,
  decideBackend,
  DEFAULT_RENDERER_PREFERENCE,
  isNodeRenderer,
  MAX_RENDERER_RECOVERIES,
  pageSearch,
  probeWebGpu,
  RENDER_BACKEND_SETTING_VALUES,
  RENDERER_PREFERENCES,
  RENDERER_URL_PARAM,
  rendererMemory,
  type RendererMemoryCounts,
  rendererPreferenceFromSetting,
  rendererPreferenceFromUrl,
  resolveRendererPreference,
  type AnyRenderer,
  type CreateRendererOptions,
  type RendererBackend,
  type RendererFactoryDeps,
  type RendererHandle,
  type RendererInfo,
  type RendererPreference,
  type RendererPreferenceSource,
  type RendererState,
  type WebGpuProbe,
} from './renderer-factory';
// The delivered-rendering `models` block on `createSceneAdapter` options
// (presentation.md): the resolved model-asset map, the per-`modelAnimation`-entity
// committed mappings and the injected byte resolver; the adapter realizes
// `model` entities as attached `ModelInstance`s under the entity holders
// and drives one role controller per animated entity from the single
// `renderFrame` loop (delivery.md). All on the root subpath.
export {
  createModelsRealization,
  validateModelsBlock,
  type ModelAnimationRoles,
  type ModelsRealization,
  type ModelsRealizationContext,
  type ModelsSettledResult,
  type SceneAdapterModelAsset,
  type SceneAdapterModels,
  type SceneAdapterModelsDiagnostics,
} from './models';
// The light/shadow/surface realization surface (presentation.md
// "shadow/light realization options on the accepted
// `createSceneAdapter` options"; the pure math is exported so the browser
// checklist and the tests compare realized values against the frozen
// rows and the promoted fixture).
export {
  decideShadows,
  deriveShadowCamera,
  planSceneLights,
  DIRECTIONAL_SHADOW_DEFAULTS,
  directionalShadowSettings,
  SHADOW_PROFILE,
  SURFACE_PRESETS,
  type AuthoredLight,
  type AuthoredSurface,
  type ShadowRegion,
  type ShadowOutcome,
  type ShadowPlan,
  type ShadowReason,
} from './lighting';
// Which lights of the loaded scenes are on (lights-shadows.ts switches them; exported for tests and tools).
export { LOCAL_LIGHT_BUDGET, selectSceneLights, type SceneLightEntry, type SceneLightKind, type SceneLightSelection } from './scene-lights';
// The runtime role selector and the bounded crossfade
// (root subpath):
// `createAnimationRoleController`/`AnimationRoleController` + the
// profile/state types; the pure selection/weight/validation helpers are
// exported so the browser checklist and the tests compare realized values
// against the contract constants and the promoted fixture rows.
export {
  ANIMATION_CROSSFADE_SECONDS,
  ANIMATION_MAX_DELTA_SECONDS,
  ANIMATION_ROLES,
  RUN_SPEED_EPS,
  crossfadeIncomingWeight,
  createAnimationRoleController,
  selectAnimationRole,
  validateAnimationRoles,
  type AnimationRoleBindingInput,
  type AnimationRoleController,
  type AnimationRoleMotion,
  type AnimationRoleName,
  type AnimationRoleState,
  type AnimationRoleValidationFailure,
  type AnimationRoleView,
  type AnimationRolesInput,
} from './animation';
export type { OwnershipCounts, OwnershipKind, ResourceOwnership } from './ownership';
export {
  createVisualResourceStore,
  injectedResolver,
  prepareVisualResource,
  suppliedBytes,
  VISUAL_SOURCE_BYTES_MAX,
  visualLoadFailure,
  type AssetByteSource,
  type AssetPreviewController,
  type AssetVersionDescriptor,
  type GlbLoaderPort,
  type ExtractedImages,
  type LoadedGlb,
  type ModelInstance,
  type PrepareVisualOptions,
  type PrepareVisualResult,
  type PreparedVisualResource,
  type PreviewMaterialMode,
  type PreviewResult,
  type PreviewState,
  type VisualClipInfo,
  type VisualLoadFailure,
  type VisualLoadFailureReason,
  type VisualResourceDiagnostics,
  type VisualResourceHandle,
  type VisualResourceState,
  type VisualResourceStore,
  type VisualResourceStoreOptions,
} from './visual';
export { buildInstanceSet, chunkCopies, INSTANCE_BUFFER_FLOATS, INSTANCE_CHUNK_COPIES, INSTANCE_CHUNK_METERS, INSTANCE_MAX_CHUNKS, INSTANCE_MAX_SPATIAL_CHUNKS, type BuiltInstanceSet } from './instancing';
// Multi-piece GLBs (pieces, LOD groups, `_COL` colliders) and
// vertex colours as shader data.
export {
  applyLodGroups,
  applyVertexColorMode,
  COLLIDER_POLYGON_MAX,
  convexHull,
  LOD_SCREEN_FRACTIONS,
  lodDistanceForSize,
  lodSwitchDistance,
  modelPieces,
  pieceBaseName,
  pieceBounds,
  pieceCollider2D,
  pieceCollider3D,
  pieceCollisionParts,
  COLLIDER_3D_FROM_MODEL,
  type ModelCollider3D,
  type ModelPiece,
  type VertexColorMode,
} from './pieces';
export type { CreateInstanceOptions } from './visual';
// KTX2 texture assets (the page names where the Basis transcoder is served).
export { isKtx2, setKtx2DecoderBase } from './ktx2';
export { createTextureStreamer, isStreamedTexture, SAMPLED_TEXTURES_KEY, StreamedDataTexture, StreamedTexture, type AnyStreamed, type MipPartRef, type StreamSource, type TextureStreamer, type TextureStreamerOptions, type TextureStreamingObservation } from './texture-streaming';
export { planMipLevels, residentBytes, type MipCandidate, type MipPlan } from './texture-budget';
// Project materials (shader types, global wind) at runtime.
export {
  createMaterialLibrary,
  decodeTexture,
  DEFAULT_WIND_LIKE,
  resolveMaterialInstancesLike,
  type MaterialDefLike,
  type MaterialLibrary,
  type MaterialLibraryOptions,
  type MaterialOverridesLike,
  type MaterialShaderName,
  type WindLike,
} from './material-library';
// Material graphs compiled to TSL (the library uses it; tests and the editor's problem list too).
export {
  compileMaterialGraph,
  digestOf,
  materialGraphCanonical,
  materialGraphProblems,
  resolveMaterialGraphPorts,
  COMPILER_NODES,
  COMPILER_FIELD_DEFAULTS,
  LIGHTING_TYPES,
  type CompiledMaterialGraph,
  type GraphProblem,
  type MaterialFunctionLike,
  type MaterialGraphLike,
  type MaterialParameterLike,
  // Run-time values per object (the keys on a mesh) and data textures.
  makeDataTexture,
  MATERIAL_IDS_KEY,
  RUNTIME_VALUES_KEY,
  type RuntimeValuesLike,
} from './material-graph';
// The Custom-lit surface (a graph's own shading from the gathered lights).
export { mainLightIndex, MeshCustomLitNodeMaterial } from './custom-lit';
// The simulation's material parameter changes on the objects.
export { RuntimeMaterialView, type MaterialRenderChangeLike, type RuntimeMaterialsDiagnostics } from './runtime-materials';
// Node-material (TSL) helpers and the per-mesh looks (selection tint, ctx.look).
export {
  cloneMaterial,
  isNodeMaterial,
  SELECTION_HIGHLIGHT_EMISSIVE,
  SHARED_MATERIAL_KEY,
  setEntityLook,
  setSelectionHighlight,
  toNodeMaterial,
  withoutAmbientLight,
} from './node-materials';
// Automatic instancing of repeated objects (Play, export, the Scene view).
export {
  BATCH_KEY,
  BATCHED_LAYER,
  BATCHING_URL_PARAM,
  batchingFromUrl,
  batchKey,
  batchKeyParts,
  batchRefusal,
  createAutoBatcher,
  instanceCapacity,
  MIN_INSTANCE_CAPACITY,
  markBatchable,
  MERGING_URL_PARAM,
  mergingFromUrl,
  unitBoxGeometry,
  type AutoBatcher,
  type AutoBatcherDiagnostics,
  type AutoBatcherOptions,
  type BatchHint,
} from './batching';
export { isStaticCaster, SHADOW_CACHE_URL_PARAM, shadowCacheFromUrl, STATIC_CASTER_KEY } from './shadow-casters';
export { TERRAIN_HORIZON_URL_PARAM, TERRAIN_PAGE_LAYERS, TERRAIN_URL_PARAM, terrainFromUrl, terrainHorizonFromUrl, type TerrainPreviewStats, type TerrainView, type TerrainViewDiagnostics } from './terrain-view';
export { SCATTER_BUILD_MS, SCATTER_GROUP_METRES, SCATTER_URL_PARAM, scatterFromUrl, type ScatterView, type ScatterViewDiagnostics } from './scatter-view';
export { SPLINES_URL_PARAM, splinesFromUrl, type SplineViewDiagnostics } from './spline-view';
export { ARCHITECTURE_URL_PARAM, architectureFromUrl, type ArchitectureChunkStore, type ArchitectureViewDiagnostics } from './architecture-view';
export { brushDabOf, type PreviewDiff, type TerrainPreviewDab } from './terrain-preview';
export type { TerrainBrushKind } from './terrain-brush-gpu';
export { TERRAIN_DEFAULT_COLOURS } from './terrain-material';
export { TERRAIN_GRID_QUADS, terrainLodLayout, terrainMinLodDistance } from './terrain-quadtree';
export { TerrainTileStore, terrainPackShape, type PackedTerrainTile } from './terrain-tile-store';
export { snapToLightGrid, staticShadowSize, STATIC_SHADOW_STEP, STATIC_SHADOW_TURN_DEGREES, type CachedShadowCounts } from './cached-shadow';
// Static batching: static objects' meshes merged per material and world cell.
export { markStatic, MERGE_QUIET_MS, mergeRefusal, OBJECT_FRAME_KEY, STATIC_KEY, type StaticMergeDiagnostics } from './static-merge';
// Height fog (its defaults: what the Environment window shows for an absent field).
export { HEIGHT_FOG_DEFAULTS } from '@thirdlight/runtime';
// Sky, fog, fog volumes, tone mapping and the post stack.
export {
  createEnvironmentRenderer,
  environmentHasLook,
  layerEnvironment,
  MAX_RENDER_PIXEL_RATIO,
  renderPixelRatio,
  type EnvironmentBlendLike,
  type EnvironmentLayerLike,
  type EnvironmentLike,
  type EnvironmentRenderer,
  type EnvironmentRendererOptions,
  type FogLike,
  type FogVolumeLike,
  type PostLike,
  type QualityLevel,
  RENDER_OPTIONS_DEFAULT,
  type RenderOptions,
  type SkyLike,
} from './environment';
export { alignedSkyRotation, applySkyRotation, azimuthDeg, cubePixelDirection, equirectPixelDirection, findSkySun, skyRotationRadians, skyTurnDegrees, wrapDegrees, type SkyPixels, type SkySun } from './sky-rotation';
// Ambient occlusion on the indirect light, render scale with FSR 1 upscaling, dynamic resolution.
export { AO_RESOLUTION_SCALE } from './post-ao';
export { FSR_SHARPNESS, UPSCALE_URL_PARAM, upscaleFilterFromUrl, type UpscaleFilter } from './post-upscale';
export { DynamicResolution, SLOW_FRAMES_URL_PARAM, slowFramesFromUrl, type DynamicResolutionFrame, type DynamicResolutionState } from './dynamic-resolution';
export { createRenderControl, RENDER_URL_PARAMS, renderSettingsFromUrl, type RenderControl, type RenderControlDiagnostics, type RenderControlOptions, type RenderSettingsLike } from './render-control';
export { createQualityControl, QUALITY_URL_PARAM, qualityFromUrl, type QualityControl, type QualityDiagnostics, type QualityProjectLike } from './quality-control';
// Lightmaps (runtime application; the editor's baker uses the same UV1 layout).
export {
  addBoxLightmapUv,
  applyLightmap,
  boxLightmapSize,
  createLightmapSet,
  lightmappedMaterial,
  lightmapTexture,
  refreshLightmappedMaterial,
  type LightingBakeLike,
  type LightmapSet,
} from './lightmaps';
// Decoded textures held in a resource manager by who draws with them (the editor's Scene view holds its cookies, sky and lightmaps so).
export { textureHolds, type TextureHolds } from './texture-holds';
export { bakeLightmapsInBrowser, type BakedAtlas, type BakeLightInput, type BakeMeshInput, type BakeTargetInput, type BrowserBakeInput, type BrowserBakeResult } from './lightmap-baker';
// Probe grids: the bake (the editor's Scene view), the tile files, and the loaded tiles (Play, export, the Scene view).
export { bakeProbeGrids, type BakedProbeTile, type ProbeBakeInput, type ProbeBakeMesh, type ProbeBakeResult } from './probe-bake';
export { atlasFromSamples, decodeProbeArtifact, encodePng16, packProbeTexels } from './probe-artifact';
export { createProbeGridSet, createProbeLightingHost, type LoadedProbeTile, type ProbeBakeLike, type ProbeGridSet, type ProbeGridsObservation, type ProbeLightingHost, type ProbeTileEntry } from './probe-grids';
export { PROBE_ATLAS_SLACK, PROBE_RESIDENT_BYTES } from './probe-residency';
export { PROBE_PACK_MAX_EDGE } from './probe-atlas';
// Poses a model from an animator pose (the Animator window's live preview).
export { createAnimatorPlayer, type AnimatorPlayer, type AnimatorPlayerOptions, type AnimatorPoseLike, type RenderedNodePose } from './animator-player';
// Visual effects — the player (Play, exports, the Scene view's edit-mode preview) and its executors.
export {
  createEffectsPlayer,
  effectsOptionFrom,
  EFFECT_CAPS,
  EFFECTS_CPU_KEY,
  POOL_PER_EFFECT,
  type EffectAssetRowLike,
  type EffectCaps,
  type EffectComponentLike,
  type EffectDefLike,
  type EffectRequestLike,
  type EffectsDiagnostics,
  type EffectsPlayer,
  type EffectsPlayerOptions,
  type EffectSystemExecutor,
} from './effects-player';
export { cpuSystemReason, cpuSystemReasons, cpuSystemsOf, GPU_MIN_PARTICLES, GPU_SORT_LIMIT, GPU_STATE_FIELDS, GPU_STATE_STRIDE, GpuEffectExecutor, gpuUnsupportedReason } from './effects-gpu';
export { EFFECT_LIGHT_LIMIT } from './effects-draw';
// One effect on a controllable timeline (the Effect tab's preview; same executors as Play).
export { EFFECT_TIMELINE_STEP, EffectTimeline, type EffectSystemCounter, type EffectTimelineOptions } from './effects-timeline';

// Releasing objects that leave the scene for good (render objects, node-made buffers, shadow maps).
export { disposeObjectTree, disposeSharingGeometry, installProgramRelease, installVaoSweep, liveRenderers, releaseNodeAttributes, trackRenderer, trackTextureListeners, type DisposeTreeOptions } from './dispose';
// Block layers — merged chunk meshes (the Play/export adapter and the editor's Scene view share it).
export { BlockLayerView, MESH_APPLY_BUDGET_MS, SYNC_MESH_BUDGET_MS, blockChunkKey, blockLookFromObject, type BlockChunkLightmapTarget, type BlockLayerViewDeps, type BlockLayerViewDiagnostics, type BlockModelLook } from './block-layers';
export { MESH_WORKERS_MAX, createBrowserMeshWorker, meshWorkerCount, type MeshWorkerFactory, type MeshWorkerPort } from './block-mesh-pool';
// Probe lighting: the probe light every lit material samples, and the editor's probe debug view.
export { isProbeLighting, PROBES_URL_PARAM, probesFromUrl, ProbeLighting } from './probe-lighting';
export { packProbeTile, PROBE_WEIGHT_FILLED, PROBE_WEIGHT_MOVED, PROBE_WEIGHT_VALID, probeWeight, type PackedProbeTile } from './probe-pack';
export { createProbeDebugView, type ProbeDebugView } from './probe-debug';
// Local lights per vertex: an object's or material's mode, a light's importance.
export { applyObjectLightLayers } from './light-layers';
export { LIGHT_IMPORTANCE_KEY, LOCAL_LIGHTS_KEY, VERTEX_LIGHTS_URL_PARAM, localLightVariantCount, vertexLightsFromUrl } from './local-lights';
