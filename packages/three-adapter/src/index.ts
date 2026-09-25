/**
 * @thirdlight/three-adapter — public surface (dependencies.md §3 rows:
 * `createSceneAdapter(canvas, opts) → SceneAdapter { renderFrame,
 * captureScreenshot(maxWidth), diagnostics, dispose }`, `ERROR_CODES`; packet-26
 * additions: "the GLB realization/resource-owner helpers + an injected byte
 * resolver: the adapter accepts **bytes or a resolver function**, never a
 * token/URL/fetch; GLTFLoader/AnimationClip preview helpers").
 *
 * The root subpath stays loader-free: the real `three/examples/jsm` GLTFLoader
 * binding lives on the `./gltf-loader` subpath (packet-26 contract-change
 * request C26-1) so the M1 export/preview bundle graphs keep their recorded
 * `export.md` §5.4.1 counts until packets 35/36 re-measure them.
 *
 * Thirdlight M1 three.js scene adapter (packet 08) + shared GLB realization
 * path (packet 26). Node-side dependencies (dependencies.md §4.1):
 * @thirdlight/runtime, three.
 */
export { createSceneAdapter, type SceneAdapter, type SceneAdapterDiagnostics, type SceneAdapterOptions, type ScreenshotResult } from './adapter';
export { ERROR_CODES, type AdapterError, type AdapterErrorCode } from './errors';
// Phase 17.1: the one renderer factory (Play/export, the Scene view, previews).
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
// Packet 69: the M4 delivered-rendering `models` block (presentation.md
// §41.9 row, C64-4 — "the M4 `models` block on `createSceneAdapter`
// options": the resolved model-asset map, the per-`modelAnimation`-entity
// committed mappings and the injected byte resolver; the adapter realizes
// `model` entities as attached `ModelInstance`s under the entity holders
// and drives one role controller per animated entity from the single
// `renderFrame` loop — delivery.md (M4) §2). All on the existing root
// subpath — no new subpath, no new three subpath, no pin change.
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
// Packet 52: the M3 light/shadow/surface realization surface (presentation.md
// §§41.1/41.2/§41.9 — "shadow/light realization options on the accepted
// `createSceneAdapter` options"; the pure math is exported so the named
// B11 checklist and the tests compare realized values against the frozen
// rows and the promoted fixture).
export {
  decideShadows,
  deriveShadowCamera,
  planSceneLights,
  SHADOW_PROFILE,
  SURFACE_PRESETS,
  type AuthoredLight,
  type AuthoredSurface,
  type ShadowLevel,
  type ShadowOutcome,
  type ShadowPlan,
  type ShadowReason,
} from './lighting';
// Packet 53: the runtime role selector and the bounded crossfade
// (presentation.md §41.3.6/§41.3.7/§41.9 — root subpath, no new subpath):
// `createAnimationRoleController`/`AnimationRoleController` + the
// profile/state types; the pure selection/weight/validation helpers are
// exported so the named B14 checklist and the tests compare realized values
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
export { buildInstanceSet, INSTANCE_BUFFER_FLOATS, type BuiltInstanceSet } from './instancing';
// 2026-09-24: multi-piece GLBs (pieces, LOD groups, `_COL` colliders) and
// vertex colours as shader data.
export {
  applyLodGroups,
  applyVertexColorMode,
  COLLIDER_POLYGON_MAX,
  convexHull,
  LOD_SCREEN_FRACTIONS,
  modelPieces,
  pieceBaseName,
  pieceBounds,
  pieceCollider2D,
  type ModelPiece,
  type VertexColorMode,
} from './pieces';
export type { CreateInstanceOptions } from './visual';
// Phase 9.4: project materials (shader types, global wind) at runtime.
export {
  createMaterialLibrary,
  decodeTexture,
  DEFAULT_WIND_LIKE,
  type MaterialDefLike,
  type MaterialLibrary,
  type MaterialLibraryOptions,
  type MaterialShaderName,
  type WindLike,
} from './material-library';
// Phase 9.5: sky, fog, fog volumes, tone mapping and the post stack.
export {
  createEnvironmentRenderer,
  environmentHasLook,
  layerEnvironment,
  QUALITY_PROFILE,
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
// Phase 9.6: lightmaps (runtime application; the editor's baker uses the same UV1 layout).
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
export { bakeLightmapsInBrowser, type BakedAtlas, type BakeLightInput, type BakeMeshInput, type BakeTargetInput, type BrowserBakeInput, type BrowserBakeResult } from './lightmap-baker';
// Phase 9.7: poses a model from an animator pose (the Animator window's live preview).
export { createAnimatorPlayer, type AnimatorPlayer, type AnimatorPlayerOptions, type AnimatorPoseLike } from './animator-player';
