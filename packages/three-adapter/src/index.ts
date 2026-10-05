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
// Static batching: static objects' meshes merged per material and world cell.
export { markStatic, MERGE_QUIET_MS, mergeRefusal, OBJECT_FRAME_KEY, STATIC_KEY, type StaticMergeDiagnostics } from './static-merge';
// Sky, fog, fog volumes, tone mapping and the post stack.
export {
  createEnvironmentRenderer,
  environmentHasLook,
  layerEnvironment,
  MAX_RENDER_PIXEL_RATIO,
  QUALITY_PROFILE,
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
  type SkyLike,
} from './environment';
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
// Poses a model from an animator pose (the Animator window's live preview).
export { createAnimatorPlayer, type AnimatorPlayer, type AnimatorPlayerOptions, type AnimatorPoseLike, type RenderedNodePose } from './animator-player';
// Visual effects — the player (Play, exports, the Scene view's edit-mode preview) and its executors.
export {
  createEffectsPlayer,
  effectsOptionFrom,
  EFFECT_CAPS,
  POOL_PER_EFFECT,
  type EffectAssetRowLike,
  type EffectCaps,
  type EffectComponentLike,
  type EffectDefLike,
  type EffectRequestLike,
  type EffectsDiagnostics,
  type EffectsPlayer,
  type EffectsPlayerOptions,
} from './effects-player';
export { GPU_SORT_LIMIT, GPU_STATE_FIELDS, GPU_STATE_STRIDE, GpuEffectExecutor, gpuUnsupportedReason } from './effects-gpu';
export { EFFECT_LIGHT_LIMIT } from './effects-draw';
// One effect on a controllable timeline (the Effect tab's preview; same executors as Play).
export { EFFECT_TIMELINE_STEP, EffectTimeline, type EffectSystemCounter, type EffectTimelineOptions } from './effects-timeline';

// Releasing objects that leave the scene for good (render objects, node-made buffers, shadow maps).
export { disposeObjectTree, disposeSharingGeometry, installProgramRelease, installVaoSweep, liveRenderers, releaseNodeAttributes, trackRenderer, trackTextureListeners, type DisposeTreeOptions } from './dispose';
// Block layers — merged chunk meshes (the Play/export adapter and the editor's Scene view share it).
export { BlockLayerView, blockChunkKey, blockLookFromObject, type BlockChunkLightmapTarget, type BlockLayerViewDeps, type BlockLayerViewDiagnostics, type BlockModelLook } from './block-layers';
