/**
 * The content catalog's limits: asset, prefab, behavior and scene counts and
 * sizes. A leaf module (no imports), so every model module can use them
 * without an import cycle; `content.ts` re-exports them.
 */

export const MAX_ASSETS = 128;
export const MAX_ASSET_VERSIONS = 32;
export const MAX_VERSION_RECORDS = 1024;
export const MAX_CONTENT_BYTES = 1_048_576;
export const MAX_SOURCE_BYTES = 33_554_432;
export const MAX_PREFABS = 128;
export const MAX_PREFAB_ENTITIES = 256;
export const MAX_PREFAB_DEPTH = 16;
export const MAX_PREFAB_BYTES = 131_072;
/** The most overrides one prefab instantiation request carries (commands and the editor's planner check it). */
export const MAX_PREFAB_OVERRIDES = 64;
export const MAX_BEHAVIORS = 64;
export const MAX_PROPERTIES = 32;
export const MAX_ENUM_VALUES = 32;
export const MAX_DECLARATION_BYTES = 32_768;
/** A declared `string` property's length (code points) when it sets no `maxLength`, and the largest `maxLength` it may set. */
export const DECLARATION_STRING_LENGTH_DEFAULT = 256;
export const MAX_DECLARATION_STRING_LENGTH = 1024;
export const MAX_SETTINGS_KEYS = 32;
export const MAX_TRUST_ENTRIES = 64;
/**
 * Sound-effect records: as many as music tracks, since a game's many short
 * cues (steps, hits, UI) each need one; each record is bounded by its own PCM
 * byte cap.
 */
export const MAX_AUDIO_ASSETS = 64;
export const MAX_AUDIO_VERSIONS = 8;
/** Texture asset records (PNG/JPEG/WebP) and their versions. */
export const MAX_TEXTURE_ASSETS = 256;
export const MAX_TEXTURE_VERSIONS = 8;
/** The largest texture edge (pixels). */
export const MAX_TEXTURE_EDGE = 4096;
/** Music asset records (Ogg Vorbis/Opus, MP3, WAV) and their versions. */
export const MAX_MUSIC_ASSETS = 64;
export const MAX_MUSIC_VERSIONS = 8;
/** The longest music (ms) and its largest file (bytes). */
export const MAX_MUSIC_DURATION_MS = 600_000;
/** Font asset records (TTF, OTF, WOFF2, WOFF) for the project UI and their versions. */
export const MAX_FONT_ASSETS = 16;
export const MAX_FONT_VERSIONS = 8;
/** The longest family name a font version records (characters). */
export const MAX_FONT_FAMILY_NAME = 64;
export const MAX_BEHAVIOR_SOURCE_BYTES = 262_144;
export const MAX_BEHAVIOR_FILES = 16;
/** The one entry file of a script's source container. */
export const BEHAVIOR_ENTRY_PATH = 'src/index.ts' as const;
/** The largest file in a script's source container (bytes). */
export const MAX_BEHAVIOR_FILE_BYTES = 65_536;
/** The most entities a script may own the transforms of (`ownedTransforms`). */
export const MAX_OWNED_TRANSFORMS = 16;
/** The most compile diagnostics a failed compile reports (the compiler, the workspace and the editor all cut there). */
export const MAX_BEHAVIOR_DIAGNOSTICS = 32;
export const MAX_BEHAVIOR_OUTPUT_BYTES = 131_072;

/** The decoded-resource caps of one model. */
export const ASSET_METRIC_CAPS = {
  nodes: 4096,
  meshes: 1024,
  primitives: 8192,
  materials: 512,
  images: 64,
  textures: 512,
  vertices: 2_000_000,
  triangles: 4_000_000,
  animations: 64,
  animationChannels: 4096,
  clipDurationMs: 600_000,
  decodedGeometryBytes: 268_435_456,
  decodedImageBytes: 268_435_456,
} as const;

/** The total decoded bytes of one model (`decodedGeometryBytes + decodedImageBytes`). */
export const MAX_TOTAL_DECODED_BYTES = 536_870_912;

/** The most scenes in a project. */
export const MAX_SCENES = 64;

/** The largest original accepted for conversion (an FBX), in bytes. */
export const MAX_CONVERTED_SOURCE_BYTES = 134_217_728;

/** The longest accepted `sourcePath` (UTF-16 code units). */
export const MAX_SOURCE_PATH_LENGTH = 512;

/** The layers of a texture array (WebGL 2 and WebGPU both guarantee 256). */
export const MAX_TEXTURE_LAYERS = 256;

/** The engine cap on concurrent sound voices (the `audio_voices` setting's maximum). */
export const AUDIO_VOICE_CAP = 32;
/** The `audio_voices` default: enough for overlapping effects in any scene. */
export const AUDIO_VOICES_DEFAULT = 8;

/** The largest JSON chunk of an imported GLB (bytes). */
export const MODEL_JSON_CHUNK_BYTES_MAX = 8_388_608;

/**
 * The glTF extensions an imported model may use: the importer accepts, the
 * model's recipes record and the loader honors exactly these.
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

/** A page of the asset catalog (the asset queries' largest and default page). */
export const ASSET_QUERY_PAGE_MAX = 128;
export const ASSET_QUERY_PAGE_DEFAULT = 50;

/** Open import stages per project, and their staged bytes together. */
export const MAX_OPEN_STAGES = 8;
export const MAX_STAGED_BYTES_PER_PROJECT = 134_217_728;
