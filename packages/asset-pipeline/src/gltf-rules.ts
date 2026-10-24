/**
 * The glTF format's tables the import inspection checks a file against: the
 * GLB container's magic numbers, component and accessor types, the vertex
 * attributes and material fields it accepts, animation paths, samplers and
 * where each allowlisted extension may sit. Kept apart from the inspection
 * (inspect.ts) so a format rule is changed in one short file.
 */
import { DECAL_FADE_GLTF_ATTRIBUTE } from '@thirdlight/project-model/decal-clip-glb';
import { TRIM_DATA_GLTF_ATTRIBUTE } from '@thirdlight/project-model/limits';

export const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
export const GLB_VERSION = 2;
export const CHUNK_JSON = 0x4e4f534a; // 'JSON'
export const CHUNK_BIN = 0x004e4942; // 'BIN\0'

export const COMPONENT_SIZES: Readonly<Record<number, number>> = {
  5120: 1, // BYTE
  5121: 1, // UNSIGNED_BYTE
  5122: 2, // SHORT
  5123: 2, // UNSIGNED_SHORT
  5125: 4, // UNSIGNED_INT
  5126: 4, // FLOAT
};

export const TYPE_COMPONENTS: Readonly<Record<string, number>> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};

export const UNSIGNED_COMPONENTS = new Set([5121, 5123, 5125]);

export const ATTRIBUTE_ALLOWLIST = new Set([
  'POSITION',
  'NORMAL',
  'TANGENT',
  'TEXCOORD_0',
  'TEXCOORD_1',
  'COLOR_0',
  'JOINTS_0',
  'WEIGHTS_0',
  // A baked clipped decal's per-vertex fade (the engine's own custom attribute: decal materials read it).
  DECAL_FADE_GLTF_ATTRIBUTE,
  // Trim data (R occlusion, A wetness): what the file check moves a trim model's authored COLOR_0 into.
  TRIM_DATA_GLTF_ATTRIBUTE,
]);

export const ANIMATION_PATHS = new Set(['translation', 'rotation', 'scale', 'weights']);

export const ANIMATION_OUTPUT_TYPES: Readonly<Record<string, string>> = {
  translation: 'VEC3',
  rotation: 'VEC4',
  scale: 'VEC3',
  weights: 'SCALAR',
};

export const INTERPOLATIONS = new Set(['LINEAR', 'STEP', 'CUBICSPLINE']);

export const CORE_MATERIAL_FIELDS = new Set([
  'name',
  'pbrMetallicRoughness',
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
  'emissiveFactor',
  'alphaMode',
  'alphaCutoff',
  'doubleSided',
  'extensions',
  // Application data (glTF allows it on every object); accepted and ignored.
  'extras',
]);

export const CORE_PBR_FIELDS = new Set([
  'baseColorFactor',
  'baseColorTexture',
  'metallicFactor',
  'roughnessFactor',
  'metallicRoughnessTexture',
  'extras',
]);

export const SAMPLER_FILTERS = new Set([9728, 9729, 9984, 9985, 9986, 9987]);

/** The glTF object kinds an `extensions` member can sit on. */
export type ExtensionPlace =
  | 'root'
  | 'buffer'
  | 'bufferView'
  | 'accessor'
  | 'mesh'
  | 'primitive'
  | 'material'
  | 'textureInfo'
  | 'texture'
  | 'animation'
  | 'node'
  | 'scene';

/**
 * Where each allowlisted extension may carry an object. An allowlisted
 * extension in any other place is refused: it would be ignored there, and
 * ignoring an extension changes what the file means.
 * `KHR_mesh_quantization` is a declaration only (it widens attribute types).
 */
export const EXTENSION_PLACES: Readonly<Record<string, readonly ExtensionPlace[]>> = {
  EXT_meshopt_compression: ['buffer', 'bufferView'],
  EXT_texture_webp: ['texture'],
  KHR_draco_mesh_compression: ['primitive'],
  KHR_texture_basisu: ['texture'],
  KHR_materials_clearcoat: ['material'],
  KHR_materials_emissive_strength: ['material'],
  KHR_materials_ior: ['material'],
  KHR_materials_sheen: ['material'],
  KHR_materials_specular: ['material'],
  KHR_materials_transmission: ['material'],
  KHR_materials_unlit: ['material'],
  KHR_materials_volume: ['material'],
  KHR_mesh_quantization: [],
  KHR_texture_transform: ['textureInfo'],
};

/** The image containers a texture may use, by where it references the image. */
export const CORE_TEXTURE_MIMES = new Set(['image/png', 'image/jpeg']);
export const SAMPLER_WRAPS = new Set([33071, 33648, 10497]);
