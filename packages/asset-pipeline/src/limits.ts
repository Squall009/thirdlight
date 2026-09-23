/**
 * The M2 GLB import profile constants (project-model.md §18.6/§18.7/§18.8,
 * dependencies.md §3: `M2_GLTF_EXTENSION_ALLOWLIST`,
 * `M2_GLTF_PROFILE_LIMITS`).
 *
 * These are **frozen data**, not configuration: `inspectGlb` has no way to
 * raise a cap, and the same constants are the ones the workspace re-checks a
 * persisted version's metrics against on load (project-model.md §18.6).
 */

import type { ImportLimitName } from './types';

/** §18.7.2 step 1: the whole-source byte cap (also §18.4 `sourceByteLength`). */
export const M2_GLTF_SOURCE_BYTES = 33_554_432;

/** §18.7.2 step 4: the JSON chunk byte cap. */
export const M2_GLTF_JSON_CHUNK_BYTES = 8_388_608;

/** §18.7.2 step 11: per-image byte cap. */
export const M2_GLTF_IMAGE_BYTES = 33_554_432;

/** §18.8.2: at most this many diagnostics are returned, plus the true count. */
export const M2_GLTF_MAX_DIAGNOSTICS = 10;

/** §8 (`inspection`): entries per display list and characters per name. */
export const M2_GLTF_INSPECTION_ENTRIES = 64;
export const M2_GLTF_INSPECTION_NAME_CHARS = 128;

/** content-storage.md §9 / workspace.md §14: the bounded inspection job budget. */
export const M2_GLTF_INSPECTION_TIMEOUT_MS = 30_000;

/** §18.5: the only accepted toolchain (the repository's pinned loader line). */
export const M2_GLTF_TOOLCHAIN = Object.freeze({ three: '0.186.0' });

/**
 * presentation.md §41.3.3 A1–A5: the frozen animated-model GLB profile caps.
 * They are additional constraints on a requested animation profile; the
 * accepted M2 caps above still apply first.
 */
export const ANIMATION_PROFILE_MAX_CLIPS = 8;
export const ANIMATION_PROFILE_MAX_TRACKS = 64;
export const ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP = 32;
export const ANIMATION_PROFILE_MAX_TRACK_TIMES = 4_096;
export const ANIMATION_PROFILE_MAX_CLIP_MS = 10_000;

/** presentation.md §41.3.1: the fixed role key order. */
export const ANIMATION_ROLE_KEYS = Object.freeze(['idle', 'run', 'airborne'] as const);

/** §41.3.1: `clipName` is 1–128 characters with no control characters. */
export const ANIMATION_ROLE_NAME_CHARS = 128;

/**
 * presentation.md §41.4.1/§41.4.2: the frozen PCM-WAV profile constants. Every
 * one is contract data, not configuration; the same numbers are re-checked on
 * load by `project-model`'s audio branch (§18.6).
 */
export const AUDIO_PCM_WAV_HEADER_BYTES = 44;
export const AUDIO_PCM_WAV_CHANNELS = 1;
export const AUDIO_PCM_WAV_SAMPLE_RATE = 48_000;
export const AUDIO_PCM_WAV_BITS_PER_SAMPLE = 16;
export const AUDIO_PCM_WAV_BYTE_RATE = 96_000;
export const AUDIO_PCM_WAV_BLOCK_ALIGN = 2;
export const AUDIO_PCM_WAV_MAX_PCM_BYTES = 192_000;
export const AUDIO_PCM_WAV_MAX_FRAMES = 96_000;
export const AUDIO_PCM_WAV_MAX_DURATION_MS = 2_000;
export const AUDIO_PCM_WAV_MAX_SOURCE_BYTES = 192_044;
/** §41.4.4 stage 1: the hard source-file bound, before any profile cap. */
export const AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES = 196_608;

/**
 * presentation.md §41.4.3: the only tool whose version can change an inspected
 * WAV — this package, at the repository pin (`package.json`, `version`).
 */
export const AUDIO_PIPELINE_NAME = 'asset-pipeline';
export const AUDIO_PIPELINE_VERSION = '0.1.0';

/** §41.4.3: the exact `pcm-wav` toolchain object. */
export const AUDIO_PCM_WAV_TOOLCHAIN: Readonly<Record<string, string>> = Object.freeze({
  [AUDIO_PIPELINE_NAME]: AUDIO_PIPELINE_VERSION,
});

/** §41.4.2/§41.4.3: the caps reported by an audio proposal. */
export const AUDIO_PCM_WAV_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  audio_pcm_bytes: AUDIO_PCM_WAV_MAX_PCM_BYTES,
  frames: AUDIO_PCM_WAV_MAX_FRAMES,
  duration_ms: AUDIO_PCM_WAV_MAX_DURATION_MS,
  source_bytes: AUDIO_PCM_WAV_MAX_SOURCE_BYTES,
  source_file_bytes: AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES,
});

/**
 * §18.8.1 extension allowlist: the glTF extensions the pinned
 * `three@0.186.0` GLTFLoader honors (Draco and Basis/KTX2 through the decoders
 * three ships, delivered with the game only when an asset needs them), each
 * covered by a committed fixture that imports here and renders in the editor,
 * Play and export (fixtures/import-ext). Meshopt streams are decoded by the
 * importer itself (meshopt.ts); Draco and KTX2 payloads are checked for
 * structure and declared sizes here and decoded at load. The same list is restated in project-model (recipe
 * validation) and three-adapter (the loader guard); a cross-package test keeps
 * the three equal. Everything else is `asset_extension_unsupported`.
 */
export const M2_GLTF_EXTENSION_ALLOWLIST: readonly string[] = Object.freeze([
  'EXT_meshopt_compression',
  'EXT_texture_webp',
  'KHR_draco_mesh_compression',
  'KHR_materials_clearcoat',
  'KHR_materials_emissive_strength',
  'KHR_materials_ior',
  'KHR_materials_sheen',
  'KHR_materials_specular',
  'KHR_materials_transmission',
  'KHR_materials_unlit',
  'KHR_materials_volume',
  'KHR_mesh_quantization',
  'KHR_texture_basisu',
  'KHR_texture_transform',
]);

/** §18.6 decoded-resource caps keyed by the §18.9.3 `limits_exceeded` limit name. */
export const M2_GLTF_PROFILE_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  source_bytes: M2_GLTF_SOURCE_BYTES,
  json_chunk_bytes: M2_GLTF_JSON_CHUNK_BYTES,
  image_bytes: M2_GLTF_IMAGE_BYTES,
  nodes: 4_096,
  meshes: 1_024,
  primitives: 8_192,
  materials: 512,
  images: 64,
  textures: 512,
  vertices: 2_000_000,
  triangles: 4_000_000,
  animations: 64,
  animation_channels: 4_096,
  clip_duration: 600_000,
  decoded_bytes: 268_435_456,
  total_decoded_bytes: 536_870_912,
  diagnostics: M2_GLTF_MAX_DIAGNOSTICS,
});

/** Caps that are reported with the shared `decoded_bytes` limit name (§18.9.3). */
export const M2_GLTF_DECODED_GEOMETRY_BYTES = 268_435_456;
export const M2_GLTF_DECODED_IMAGE_BYTES = 268_435_456;
export const M2_GLTF_TOTAL_DECODED_BYTES = 536_870_912;

/** The §18.9.3 limit names this profile can report, in evaluation order. */
export const M2_GLTF_REPORTED_LIMITS: readonly ImportLimitName[] = Object.freeze([
  'nodes',
  'meshes',
  'primitives',
  'materials',
  'images',
  'textures',
  'vertices',
  'triangles',
  'animations',
  'animation_channels',
  'clip_duration',
  'decoded_bytes',
  // presentation.md §41.3.3 A1–A5 (only produced when the animated profile is
  // requested, in A1 → A5 order).
  'animation_clips',
  'animation_tracks',
  'animation_track_times',
  'animation_clip_duration',
]);

/** The §41.4.4 limit names `inspectAudio` can report (stage 11). */
export const AUDIO_REPORTED_LIMITS: readonly ImportLimitName[] = Object.freeze(['audio_pcm_bytes']);
