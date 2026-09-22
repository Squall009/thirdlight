/**
 * `@thirdlight/asset-pipeline` — public surface (dependencies.md §3/§4.1).
 *
 * Pure bounded media inspection over supplied bytes
 * (project-model.md §18.7/§18.8; presentation.md §41.3/§41.4). Bytes in, an
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
export { inspectAudio } from './inspect-audio';

export {
  ANIMATION_PROFILE_MAX_CLIPS,
  ANIMATION_PROFILE_MAX_CLIP_MS,
  ANIMATION_PROFILE_MAX_TRACKS,
  ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP,
  ANIMATION_PROFILE_MAX_TRACK_TIMES,
  ANIMATION_ROLE_KEYS,
  ANIMATION_ROLE_NAME_CHARS,
  AUDIO_PCM_WAV_BITS_PER_SAMPLE,
  AUDIO_PCM_WAV_BLOCK_ALIGN,
  AUDIO_PCM_WAV_BYTE_RATE,
  AUDIO_PCM_WAV_CHANNELS,
  AUDIO_PCM_WAV_HEADER_BYTES,
  AUDIO_PCM_WAV_LIMITS,
  AUDIO_PCM_WAV_MAX_DURATION_MS,
  AUDIO_PCM_WAV_MAX_FRAMES,
  AUDIO_PCM_WAV_MAX_PCM_BYTES,
  AUDIO_PCM_WAV_MAX_SOURCE_BYTES,
  AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES,
  AUDIO_PCM_WAV_SAMPLE_RATE,
  AUDIO_PCM_WAV_TOOLCHAIN,
  AUDIO_PIPELINE_NAME,
  AUDIO_PIPELINE_VERSION,
  AUDIO_REPORTED_LIMITS,
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
  AudioImportInspection,
  AudioImportLimits,
  AudioImportOptions,
  AudioImportProposal,
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
  PcmWavMetrics,
  PcmWavRecipe,
  PrepareImportOptions,
} from './types';
