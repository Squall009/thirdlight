/**
 * The content catalog's limits: the sizes of one file, one record and one
 * model. A leaf module (no imports), so every model module can use them
 * without an import cycle; `content.ts` re-exports them.
 *
 * Nothing here bounds how many assets or resources a project holds: a game
 * has as many as it needs, each stored as its own file, so only a file's size
 * and the runtime's memory are bounded (a guard test fails if a count of
 * assets or resources comes back as a `MAX_*` here).
 */

export const MAX_ASSET_VERSIONS = 32;
/**
 * The largest content file, in canonical bytes: one resource record (a
 * material, dialogue, UI document, …, each its own file) or the project-wide
 * settings `content.json` holds. It bounds what one parse and one change
 * carry; the number of files is not bounded.
 */
export const MAX_CONTENT_FILE_BYTES = 1_048_576;
/**
 * The largest imported file (bytes): a model, an image, a font, an audio file
 * of any length. It is the upload stage's bound too; the number of files is
 * not bounded.
 */
export const MAX_SOURCE_BYTES = 33_554_432;
/**
 * One prefab: its entities (a building or a vehicle of many parts) and its
 * depth. A prefab is one content file, so its bytes
 * have the content file cap.
 */
export const MAX_PREFAB_ENTITIES = 1024;
export const MAX_PREFAB_DEPTH = 16;
export const MAX_PREFAB_BYTES = MAX_CONTENT_FILE_BYTES;
/** The most overrides one prefab instantiation request carries (commands and the editor's planner check it). */
export const MAX_PREFAB_OVERRIDES = 64;
export const MAX_PROPERTIES = 32;
export const MAX_ENUM_VALUES = 32;
export const MAX_DECLARATION_BYTES = 32_768;
/** A declared `string` property's length (code points) when it sets no `maxLength`, and the largest `maxLength` it may set. */
export const DECLARATION_STRING_LENGTH_DEFAULT = 256;
export const MAX_DECLARATION_STRING_LENGTH = 1024;
export const MAX_SETTINGS_KEYS = 32;
/** Versions of one audio record (its file's size is bounded by `MAX_SOURCE_BYTES`, as every imported file's). */
export const MAX_AUDIO_VERSIONS = 8;
/** Versions of one texture asset record (PNG/JPEG/WebP/KTX2). */
export const MAX_TEXTURE_VERSIONS = 8;
/** The largest texture edge (pixels): every GPU the engine targets samples it; texture streaming revisits it. */
export const MAX_TEXTURE_EDGE = 4096;
/** Versions of one font asset record (TTF, OTF, WOFF2, WOFF). */
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

/** The largest original accepted for conversion (an FBX), in bytes. */
export const MAX_CONVERTED_SOURCE_BYTES = 134_217_728;

/** The longest accepted `sourcePath` (UTF-16 code units). */
export const MAX_SOURCE_PATH_LENGTH = 512;

/** The layers of a texture array (WebGL 2 and WebGPU both guarantee 256). */
export const MAX_TEXTURE_LAYERS = 256;

/** The engine cap on concurrent sound voices (the `audio_voices` setting's maximum): mixing cost per voice, as common engines' real-voice defaults. */
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

/**
 * An asset label (the name a script may load a group of assets by): a letter
 * or digit, then letters, digits, `_`, `-`, `.` or `/`, at most this many
 * characters. No spaces, so a search can say `l:voice`.
 */
export const ASSET_LABEL_MAX_LENGTH = 64;
export const ASSET_LABEL_RE = new RegExp(`^[\\p{L}\\p{N}][\\p{L}\\p{N}_.\\-/]{0,${ASSET_LABEL_MAX_LENGTH - 1}}$`, 'u');

/** The folder of the game folder uploads land in when the user names none. */
export const DEFAULT_ASSET_FOLDER = 'assets';

/**
 * The commands that create a scene or a project resource. Each takes an
 * optional `folder` (a folder of the game folder) the backend writes what it
 * creates into; a record the command only changes stays where its file is.
 * The backend consumes the arg before the command runs, as it does an
 * upload's folder; the editor adds its current folder to these.
 */
export const RESOURCE_CREATING_OPS: readonly string[] = [
  'createScene',
  'createPrefab',
  'publishBehavior',
  'setMaterial',
  'setAnimator',
  'setGraph',
  'setEffect',
  'setScriptLibrary',
  'setUiDocument',
  'setUiTheme',
  'setTimeline',
  'setDialogue',
  'setEnvironment',
];
