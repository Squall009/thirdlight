/**
 * The GLB import profile constants (project-model.md,
 * `M2_GLTF_EXTENSION_ALLOWLIST`, `M2_GLTF_PROFILE_LIMITS`).
 *
 * These are **frozen data**, not configuration: `inspectGlb` has no way to
 * raise a cap, and the same constants are the ones the workspace re-checks a
 * persisted version's metrics against on load.
 */

import {
  ASSET_METRIC_CAPS,
  AUDIO_PCM_WAV_PROFILE,
  M2_GLTF_EXTENSION_ALLOWLIST,
  MAX_SOURCE_BYTES,
  MAX_TOTAL_DECODED_BYTES,
  MODEL_JSON_CHUNK_BYTES_MAX,
} from '@thirdlight/project-model/limits';
import type { ImportLimitName } from './types';

/** The whole-source byte cap (also bounds `sourceByteLength`). */
export const M2_GLTF_SOURCE_BYTES = MAX_SOURCE_BYTES;

/** The JSON chunk byte cap. */
export const M2_GLTF_JSON_CHUNK_BYTES = MODEL_JSON_CHUNK_BYTES_MAX;

/** Per-image byte cap. */
export const M2_GLTF_IMAGE_BYTES = 33_554_432;

/** At most this many diagnostics are returned, plus the true count. */
export const M2_GLTF_MAX_DIAGNOSTICS = 10;

/** `inspection`: entries per display list and characters per name. */
export const M2_GLTF_INSPECTION_ENTRIES = 64;
export const M2_GLTF_INSPECTION_NAME_CHARS = 128;

/** The bounded inspection job budget. */
export const M2_GLTF_INSPECTION_TIMEOUT_MS = 30_000;

/**
 * The only accepted toolchain: the GLTFLoader line a model's import
 * recipe was made with. It moves when a three release changes that loader,
 * not with every three patch: the recipe digest of every imported model
 * depends on it, and a patch that leaves the loader alone changes no import.
 */
export const M2_GLTF_TOOLCHAIN = Object.freeze({ three: '0.186.0' });

/**
 * A1–A5: the frozen animated-model GLB profile caps. They are additional
 * constraints on a requested animation profile; the `M2_GLTF_*` caps above
 * still apply first.
 */
/** Skinned models: skins per file, joints per skin, morph targets per primitive. */
export const MODEL_MAX_SKINS = 4;
export const MODEL_MAX_SKIN_JOINTS = 128;
export const MODEL_MAX_MORPH_TARGETS = 32;

export const ANIMATION_PROFILE_MAX_CLIPS = 8;
export const ANIMATION_PROFILE_MAX_TRACKS = 64;
export const ANIMATION_PROFILE_MAX_TRACKS_PER_CLIP = 32;
export const ANIMATION_PROFILE_MAX_TRACK_TIMES = 4_096;
export const ANIMATION_PROFILE_MAX_CLIP_MS = 10_000;

/** The fixed role key order. */
export const ANIMATION_ROLE_KEYS = Object.freeze(['idle', 'run', 'airborne'] as const);

/** `clipName` is 1–128 characters with no control characters. */
export const ANIMATION_ROLE_NAME_CHARS = 128;

/**
 * The frozen PCM-WAV profile constants. Every
 * one is contract data, not configuration; the same numbers are re-checked on
 * load by `project-model`'s audio branch.
 */
export const AUDIO_PCM_WAV_HEADER_BYTES = AUDIO_PCM_WAV_PROFILE.headerBytes;
export const AUDIO_PCM_WAV_CHANNELS = AUDIO_PCM_WAV_PROFILE.channels;
export const AUDIO_PCM_WAV_SAMPLE_RATE = AUDIO_PCM_WAV_PROFILE.sampleRate;
export const AUDIO_PCM_WAV_BITS_PER_SAMPLE = AUDIO_PCM_WAV_PROFILE.bitsPerSample;
export const AUDIO_PCM_WAV_BYTE_RATE = AUDIO_PCM_WAV_PROFILE.byteRate;
export const AUDIO_PCM_WAV_BLOCK_ALIGN = AUDIO_PCM_WAV_PROFILE.blockAlign;
export const AUDIO_PCM_WAV_MAX_PCM_BYTES = AUDIO_PCM_WAV_PROFILE.maxPcmBytes;
export const AUDIO_PCM_WAV_MAX_FRAMES = AUDIO_PCM_WAV_PROFILE.maxFrames;
export const AUDIO_PCM_WAV_MAX_DURATION_MS = AUDIO_PCM_WAV_PROFILE.maxDurationMs;
export const AUDIO_PCM_WAV_MAX_SOURCE_BYTES = AUDIO_PCM_WAV_PROFILE.maxSourceBytes;
/** Audio inspection stage 1: the hard source-file bound, before any profile cap. */
export const AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES = AUDIO_PCM_WAV_PROFILE.maxSourceFileBytes;

/**
 * The only tool whose version can change an inspected
 * WAV — this package, at the repository pin (`package.json`, `version`).
 */
export const AUDIO_PIPELINE_NAME = 'asset-pipeline';
export const AUDIO_PIPELINE_VERSION = AUDIO_PCM_WAV_PROFILE.audioPipelineVersion;

/** The exact `pcm-wav` toolchain object. */
export const AUDIO_PCM_WAV_TOOLCHAIN: Readonly<Record<string, string>> = Object.freeze({
  [AUDIO_PIPELINE_NAME]: AUDIO_PIPELINE_VERSION,
});

/** The caps reported by an audio proposal. */
export const AUDIO_PCM_WAV_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  audio_pcm_bytes: AUDIO_PCM_WAV_MAX_PCM_BYTES,
  frames: AUDIO_PCM_WAV_MAX_FRAMES,
  duration_ms: AUDIO_PCM_WAV_MAX_DURATION_MS,
  source_bytes: AUDIO_PCM_WAV_MAX_SOURCE_BYTES,
  source_file_bytes: AUDIO_PCM_WAV_MAX_SOURCE_FILE_BYTES,
});

/**
 * Extension allowlist: the glTF extensions the pinned GLTFLoader
 * honors (Draco and Basis/KTX2 through the decoders three ships, delivered
 * with the game only when an asset needs them), each covered by a committed
 * fixture that imports here and renders in the editor, Play and export
 * (fixtures/import-ext). Meshopt streams are decoded by the importer itself
 * (meshopt.ts); Draco and KTX2 payloads are checked for structure and declared
 * sizes here and decoded at load. The list is the model's, so the importer,
 * the recipe validation and the loader guard agree. Everything else is
 * `asset_extension_unsupported`.
 */
export { M2_GLTF_EXTENSION_ALLOWLIST };

/** Decoded-resource caps keyed by the `limits_exceeded` limit name. */
export const M2_GLTF_PROFILE_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  source_bytes: M2_GLTF_SOURCE_BYTES,
  json_chunk_bytes: M2_GLTF_JSON_CHUNK_BYTES,
  image_bytes: M2_GLTF_IMAGE_BYTES,
  nodes: ASSET_METRIC_CAPS.nodes,
  meshes: ASSET_METRIC_CAPS.meshes,
  primitives: ASSET_METRIC_CAPS.primitives,
  materials: ASSET_METRIC_CAPS.materials,
  images: ASSET_METRIC_CAPS.images,
  textures: ASSET_METRIC_CAPS.textures,
  vertices: ASSET_METRIC_CAPS.vertices,
  triangles: ASSET_METRIC_CAPS.triangles,
  animations: ASSET_METRIC_CAPS.animations,
  animation_channels: ASSET_METRIC_CAPS.animationChannels,
  clip_duration: ASSET_METRIC_CAPS.clipDurationMs,
  decoded_bytes: ASSET_METRIC_CAPS.decodedGeometryBytes,
  total_decoded_bytes: MAX_TOTAL_DECODED_BYTES,
  diagnostics: M2_GLTF_MAX_DIAGNOSTICS,
});

/** Caps that are reported with the shared `decoded_bytes` limit name. */
export const M2_GLTF_DECODED_GEOMETRY_BYTES = ASSET_METRIC_CAPS.decodedGeometryBytes;
export const M2_GLTF_DECODED_IMAGE_BYTES = ASSET_METRIC_CAPS.decodedImageBytes;
export const M2_GLTF_TOTAL_DECODED_BYTES = MAX_TOTAL_DECODED_BYTES;

/** The limit names this profile can report, in evaluation order. */
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
  // A1–A5 (only produced when the animated profile is
  // requested, in A1 → A5 order).
  'animation_clips',
  'animation_tracks',
  'animation_track_times',
  'animation_clip_duration',
]);

/** The limit names `inspectAudio` can report (stage 11). */
export const AUDIO_REPORTED_LIMITS: readonly ImportLimitName[] = Object.freeze(['audio_pcm_bytes']);
