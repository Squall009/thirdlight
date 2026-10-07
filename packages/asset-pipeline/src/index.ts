/**
 * `@thirdlight/asset-pipeline` — public surface.
 *
 * Pure bounded media inspection over supplied bytes. Bytes in, an
 * immutable non-authoritative `ImportProposal`/`AudioImportProposal` out: no
 * I/O, no Node built-ins, no `three`/GLTFLoader, no decoder, no cache writes,
 * no asset-ID decisions, no URL fetch (external and `data:` URIs are rejected,
 * never resolved). The caller/workspace owns staging, publication and
 * authoring state; this package cannot mutate either.
 */

export {
  inspectGlb,
  prepareImport,
  importRecipeDigest,
  importMetadataDigest,
  sanitizeDisplayName,
} from './inspect';
export {
  AUDIO_TOOLCHAIN,
  inspectAudio,
  type AudioFormat,
  type AudioImportOptions,
  type AudioImportProposal,
  type AudioMetrics,
  type AudioRecipe,
} from './inspect-audio';
export {
  IMAGE_TOOLCHAIN,
  inspectImage,
  TEXTURE_EDGE_MAX,
  TEXTURE_SOURCE_BYTES_MAX,
  type ImageImportOptions,
  type ImageImportProposal,
  type ImageMetrics,
  type ImageRecipe,
  type TextureFormat,
} from './inspect-image';
// A Basis Universal KTX2's facts (size, mip levels, codec); any accepted image's declared size.
export { imageDimensions, ktx2Info } from './images';
export {
  FONT_FAMILY_NAME_MAX,
  FONT_SOURCE_BYTES_MAX,
  FONT_TABLES_MAX,
  FONT_TOOLCHAIN,
  inspectFont,
  type FontFormat,
  type FontImportOptions,
  type FontImportProposal,
  type FontMetrics,
  type FontRecipe,
} from './inspect-font';

export {
  ANIMATION_PROFILE_MAX_CLIPS,
  ANIMATION_PROFILE_MAX_CLIP_MS,
  ANIMATION_PROFILE_MAX_TRACKS,
  ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP,
  ANIMATION_PROFILE_MAX_TRACK_TIMES,
  ANIMATION_ROLE_KEYS,
  ANIMATION_ROLE_NAME_CHARS,
  AUDIO_PIPELINE_NAME,
  AUDIO_PIPELINE_VERSION,
  M2_GLTF_EXTENSION_ALLOWLIST,
  M2_GLTF_PROFILE_LIMITS,
  M2_GLTF_SOURCE_BYTES,
  M2_GLTF_JSON_CHUNK_BYTES,
  M2_GLTF_IMAGE_BYTES,
  M2_GLTF_MAX_DIAGNOSTICS,
  M2_GLTF_INSPECTION_ENTRIES,
  M2_GLTF_INSPECTION_NAME_CHARS,
  M2_GLTF_INSPECTION_TIMEOUT_MS,
  M2_GLTF_TOOLCHAIN,
} from './limits';

export type {
  AnimationProfileRequest,
  AnimationRoleBindingInput,
  AnimationRolesInput,
  AssetMetrics,
  ImportDiagnostic,
  ImportDiagnosticCode,
  ImportInspection,
  ImportJobPort,
  ImportLimitName,
  ImportLimits,
  ImportMetadataFacts,
  ImportOptions,
  ImportProposal,
  ImportRecipe,
  PrepareImportOptions,
} from './types';

// Generated levels of detail: the mesh simplifier (the backend's import makes a model's levels with it).
export { MESH_LOD_KEEP_SHARE, MESH_SIMPLIFY_ERROR_DEFAULT, loadMeshSimplifier } from './simplify';
export type { MeshSimplifier, SimplifiedMesh, SimplifyMeshInput, SimplifyOptions } from './simplify';
