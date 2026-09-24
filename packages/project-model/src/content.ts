/**
 * Content catalog validation, normalization and settings resolution —
 * project-model.md §18 (content catalog / asset records / import profile),
 * §19 (`captureContent`), §20 (prefabs, declared properties, settings
 * container), §21.4/§21.5 (the six-key gameplay settings registry) and
 * §22 (behavior source records and trust).
 *
 * Pure value validation: no I/O, no three.js, no Node built-ins. There is
 * deliberately no `parseContent(bytes)`: the content block has no standalone
 * file, so its bytes are governed by the envelope's strict parse (workspace
 * §4.3).
 */

import { animatorAssetIds, canonicalAnimators, validateAnimators, type AnimatorController } from './animator';
import { canonicalLighting, validateLighting } from './lighting';
import { canonicalInput, validateInput } from './input';
import { canonicalFlow, flowAssetRefs, validateFlow, type GameFlow } from './flow';
import { canonicalEnvironment, canonicalMaterialMapping, canonicalMaterials, validateEnvironment, validateMaterialMapping, validateMaterials } from './materials';
import { canonicalAnimatorComponent, validateAnimatorComponent } from './animator';
import { BLOCK_COMPONENTS } from './blocks';
import { canonicalSurface, validateSurfaceComponent } from './scene-v3';
import { utf8Encode } from './sha256';
import {
  canonicalBox,
  canonicalTransform,
  fail,
  fieldMissing,
  fieldType,
  fieldValue,
  idInvalid,
  isPlainObject,
  isValidName,
  isValidTimestamp,
  MAX_LEN,
  pointerSegment,
  unexpectedField,
  withFound,
} from './validate';
import type { ModelErrorV2, ModelResultV2, ModelResultV3 } from './errors';
import type {
  AssetMetrics,
  AssetVersion,
  BehaviorRecord,
  ConvertedFrom,
  BehaviorTrust,
  DeclaredProperty,
  GameplaySettings,
  ImportRecipe,
  PrefabDefinition,
  PrefabEntity,
  PropertyValue,
  SettingsMap,
} from './types-v2';
import {
  canonicalCollider,
  ID_RE_V2,
  PROPERTY_KEY_RE,
  validateBehaviorComponent,
  validateColliderComponent,
  validateModelComponent,
  validatePhysicsTransform,
} from './components';
import type {
  AssetRecordV3,
  AssetVersionV3,
  ContentCatalogV3,
  GameConfig,
  PcmWavMetrics,
  PcmWavRecipe,
} from './types-v3';
import { AUDIO_PCM_WAV_PROFILE, MAX_TAGS, type ContentCatalogV4 } from './types-v3';

// ---- limits (§18.4–§18.6, §20.3, §20.7, §22) ----------------------------------

export const MAX_ASSETS = 128;
export const MAX_ASSET_VERSIONS = 32;
export const MAX_VERSION_RECORDS = 1024;
export const MAX_CONTENT_BYTES = 1_048_576;
export const MAX_SOURCE_BYTES = 33_554_432;
export const MAX_PREFABS = 128;
export const MAX_PREFAB_ENTITIES = 256;
export const MAX_PREFAB_DEPTH = 16;
export const MAX_PREFAB_BYTES = 131_072;
export const MAX_BEHAVIORS = 64;
export const MAX_PROPERTIES = 32;
export const MAX_ENUM_VALUES = 32;
export const MAX_DECLARATION_BYTES = 32_768;
export const MAX_SETTINGS_KEYS = 32;
export const MAX_TRUST_ENTRIES = 64;
/** §23.10 v3 content limits. */
export const MAX_AUDIO_ASSETS = 16;
export const MAX_AUDIO_VERSIONS = 8;
/** Phase 9.4: texture asset records (PNG/JPEG/WebP) and their versions. */
export const MAX_TEXTURE_ASSETS = 256;
export const MAX_TEXTURE_VERSIONS = 8;
/** The largest texture edge (pixels). */
export const MAX_TEXTURE_EDGE = 4096;
/** Phase 9.10: music asset records (Ogg Vorbis/Opus, MP3, WAV) and their versions. */
export const MAX_MUSIC_ASSETS = 64;
export const MAX_MUSIC_VERSIONS = 8;
/** The longest music (ms) and its largest file (bytes). */
export const MAX_MUSIC_DURATION_MS = 600_000;
type AssetKindV3 = 'model' | 'audio' | 'texture' | 'music';
export const MAX_GAME_BYTES = 16_384;
export const MAX_BEHAVIOR_SOURCE_BYTES = 262_144;
export const MAX_BEHAVIOR_FILES = 16;
export const MAX_BEHAVIOR_OUTPUT_BYTES = 131_072;

/** §18.6 decoded-resource caps. */
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

const METRIC_LIMIT_NAMES: Partial<Record<keyof AssetMetrics, NonNullable<ModelErrorV2['limit']>>> = {
  animationChannels: 'animation_channels',
  clipDurationMs: 'clip_duration',
  decodedGeometryBytes: 'decoded_bytes',
  decodedImageBytes: 'decoded_bytes',
};

const METRIC_ORDER: Exclude<keyof AssetMetrics, 'bounds'>[] = [
  'nodes',
  'meshes',
  'primitives',
  'materials',
  'images',
  'textures',
  'vertices',
  'triangles',
  'animations',
  'animationChannels',
  'clipDurationMs',
  'decodedGeometryBytes',
  'decodedImageBytes',
];

/** §18.6 total-decoded cap (`decodedGeometryBytes + decodedImageBytes`). */
export const MAX_TOTAL_DECODED_BYTES = 536_870_912;

/**
 * presentation.md §41.4.1/§41.4.2/§41.4.3: the frozen `pcm-wav` profile
 * constants (the exact arithmetic §18.6 restates for the audio member).
 * `project-model` keeps its own copy because it has no dependency on
 * `asset-pipeline` (`dependencies.md` §4.1); the numbers are the contract's.
 */
const AUDIO_PCM_BYTES_MAX = AUDIO_PCM_WAV_PROFILE.maxPcmBytes;
const AUDIO_FRAMES_MAX = AUDIO_PCM_WAV_PROFILE.maxFrames;
const AUDIO_DURATION_MS_MAX = AUDIO_PCM_WAV_PROFILE.maxDurationMs;
const AUDIO_SOURCE_BYTES_MAX = AUDIO_PCM_WAV_PROFILE.maxSourceBytes;
const AUDIO_SOURCE_FILE_BYTES_MAX = AUDIO_PCM_WAV_PROFILE.maxSourceFileBytes;
const AUDIO_PIPELINE_NAME = 'asset-pipeline';
const AUDIO_PIPELINE_VERSION = AUDIO_PCM_WAV_PROFILE.audioPipelineVersion;

/** presentation.md §41.4.3: the `pcm-wav` metrics member key order (exact). */
const AUDIO_METRIC_ORDER = [
  'container',
  'encoding',
  'channels',
  'sampleRate',
  'bitsPerSample',
  'frames',
  'durationMs',
  'pcmBytes',
  'dataChunkBytes',
  'riffChunkBytes',
] as const;

/** §18.5: a `pcm-wav` recipe has no `extensions` key (a WAV has no glTF extensions). */
const AUDIO_RECIPE_FIELDS = new Set(['profile', 'recipeVersion', 'toolchain']);

const DIGEST_RE = /^[0-9a-f]{64}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** §18.8.1: the effective extension allowlist (asset-pipeline owns the list; restated here, kept equal by a cross-package test). */
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

/** §23.4: a v3 content block carries the five accepted keys plus `game`. */
const KNOWN_CONTENT_FIELDS_V3 = new Set(['assets', 'prefabs', 'behaviors', 'settings', 'behaviorTrust', 'game']);
const GAME_FIELDS = ['configVersion', 'title', 'objective', 'instructions', 'playerId', 'cameraId', 'spawnId', 'level', 'killY', 'cues'] as const;
const KNOWN_GAME_FIELDS = new Set<string>(GAME_FIELDS);
/** Phase 12 (c): the v4 game block — no level bounds, no kill height (game rules live in scripts). */
const GAME_FIELDS_V2 = ['configVersion', 'title', 'objective', 'instructions', 'playerId', 'cameraId', 'spawnId', 'cues'] as const;
/** Phase 15.3: the v4 game block's optional session timing (seconds; absent: `GAME_TIMING_DEFAULTS`). */
export const GAME_TIMING_FIELDS = ['respawnDelay', 'dropThroughTime', 'settleTime'] as const;
/**
 * Phase 15.3: the session timing every project played with before it became
 * data (recorded replays stay valid). Generic reasons: a 0.25 s pause after
 * a death reads as a beat before the respawn; falling through a one-way
 * platform ignores it for 0.125 s (enough to clear a thin platform at any
 * normal fall speed); the world settles for 0.1 s before the first frame so
 * resting bodies start at rest.
 */
export const GAME_TIMING_DEFAULTS = Object.freeze({ respawnDelay: 0.25, dropThroughTime: 0.125, settleTime: 0.1 });
export const GAME_TIMING_LIMITS = Object.freeze({ respawnDelay: { min: 0, max: 10 }, dropThroughTime: { min: 0.01, max: 2 }, settleTime: { min: 0, max: 1 } });
const KNOWN_GAME_FIELDS_V2 = new Set<string>([...GAME_FIELDS_V2, ...GAME_TIMING_FIELDS]);
/** Phase 12 (c): at most this many scenes per project. */
export const MAX_SCENES = 64;
const KNOWN_LEVEL_FIELDS = new Set(['minX', 'maxX', 'minY', 'maxY']);
const CUE_KEYS = ['start', 'jump', 'checkpoint', 'death', 'goal'] as const;
const KNOWN_CUE_FIELDS = new Set<string>(CUE_KEYS);
const GAME_STRING_BOUNDS: Readonly<Record<'title' | 'objective' | 'instructions', number>> = {
  title: 64,
  objective: 160,
  instructions: 320,
};
const KNOWN_ASSET_FIELDS = new Set(['assetId', 'kind', 'displayName', 'currentVersion', 'versions', 'vertexColors', 'materials', 'clipsFor']);
const KNOWN_VERSION_FIELDS = new Set([
  'version',
  'sourceDigest',
  'sourceByteLength',
  'sourcePath',
  'convertedFrom',
  'importRecipe',
  'metrics',
  'importedAt',
  'publishedRevision',
]);
const KNOWN_RECIPE_FIELDS = new Set(['profile', 'recipeVersion', 'toolchain', 'extensions']);
const KNOWN_PREFAB_DEF_FIELDS = new Set(['prefabId', 'displayName', 'createdRevision', 'entityCount', 'depth', 'entities']);
const KNOWN_PREFAB_ENTITY_FIELDS = new Set(['localId', 'name', 'parentLocalId', 'components']);
const KNOWN_BEHAVIOR_FIELDS = new Set(['behaviorId', 'displayName', 'declaration', 'source', 'publishedRevision']);
const KNOWN_DECLARATION_FIELDS = new Set(['properties']);
const KNOWN_PROPERTY_FIELDS = new Set(['key', 'label', 'type', 'default', 'min', 'max', 'step', 'maxLength', 'values', 'bounds', 'visibility', 'group', 'header', 'tooltip']);
/** Phase 15.4: the optional presentation texts of a declared property and their length caps. */
const PROPERTY_TEXT_FIELDS = [['group', 64], ['header', 64], ['tooltip', 256]] as const;
const KNOWN_BOUNDS_FIELDS = new Set(['min', 'max']);
const KNOWN_SOURCE_FIELDS = new Set([
  'sourceDigest',
  'sourceByteLength',
  'entryPath',
  'fileCount',
  'manifestDigest',
  'outputDigest',
  'outputByteLength',
  'requiredModules',
  'ownedTransforms',
  'declaredInCode',
  'publishedRevision',
]);
const KNOWN_TRUST_FIELDS = new Set(['entries']);
const KNOWN_TRUST_ENTRY_FIELDS = new Set(['sourceDigest', 'acknowledgedRevision']);
const PROPERTY_TYPES = new Set(['number', 'boolean', 'string', 'enum', 'vec3', 'entityRef', 'assetRef']);

// ---- small helpers ------------------------------------------------------------

function limitsError(
  path: string,
  limit: NonNullable<ModelErrorV2['limit']>,
  current: number,
  max: number,
  message: string,
): ModelErrorV2 {
  return withFound(
    { code: 'limits_exceeded', path, message, limit, current, max, expected: `<= ${max}` },
    current,
  );
}

function digestError(path: string, found: unknown): ModelErrorV2 {
  return withFound(
    {
      code: 'digest_invalid',
      path,
      message: 'digest must be exactly 64 lowercase hexadecimal characters',
      expected: '^[0-9a-f]{64}$',
    },
    found,
  );
}

/** The largest original accepted for conversion (an FBX), in bytes. */
export const MAX_CONVERTED_SOURCE_BYTES = 134_217_728;

/** The longest accepted `sourcePath` (UTF-16 code units). */
export const MAX_SOURCE_PATH_LENGTH = 512;

/**
 * A referenced asset version's `sourcePath`: relative to the game folder,
 * forward slashes only, 1–512 characters, no empty, `.` or `..` segment, no
 * leading `/`, no drive letter, no backslash and no control characters. It
 * is a name inside the game folder, never a host path (charter §4).
 */
export function isValidSourcePath(s: unknown): s is string {
  if (typeof s !== 'string' || s.length < 1 || s.length > MAX_SOURCE_PATH_LENGTH) return false;
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    if (c <= 0x1f || c === 0x7f || c === 0x5c /* backslash */ || c === 0x3a /* colon */) return false;
  }
  return s.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function canonicalBytes(text: string): number {
  return utf8Encode(text).length;
}

/** §12.2 canonical document bytes of any validated value. */
function canonicalDocBytes(value: unknown): number {
  return canonicalBytes(JSON.stringify(value, null, 2) + '\n');
}

/** Codepoint-order-ish key sort (ASCII keys in practice; UTF-16 is enough here). */
function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort();
}

// ---- assets (§18.3–§18.6) -----------------------------------------------------

function validateImportRecipe(r: unknown, path: string, errors: ModelErrorV2[], kind: AssetKindV3 = 'model'): void {
  const bad = (message: string, found: unknown): void => {
    errors.push(withFound({ code: 'recipe_invalid', path, message, expected: 'a valid import recipe' }, found));
  };
  if (!isPlainObject(r)) {
    errors.push(fieldType(path, r, 'object'));
    return;
  }
  if (kind === 'music') {
    if (r['profile'] !== 'music') bad('a music import recipe profile must be "music"', r['profile']);
    if (r['recipeVersion'] !== 1) bad('a music import recipe version must be exactly 1', r['recipeVersion']);
    const toolchain = r['toolchain'];
    if (!isPlainObject(toolchain) || Object.keys(toolchain).length !== 1 || toolchain[AUDIO_PIPELINE_NAME] !== AUDIO_PIPELINE_VERSION) {
      bad(`the music toolchain must name exactly "${AUDIO_PIPELINE_NAME}" at '${AUDIO_PIPELINE_VERSION}'`, toolchain);
    }
    for (const k of Object.keys(r)) {
      if (!AUDIO_RECIPE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...AUDIO_RECIPE_FIELDS].join(', ')));
    }
    return;
  }
  if (kind === 'texture') {
    if (r['profile'] !== 'image') bad('a texture import recipe profile must be "image"', r['profile']);
    if (r['recipeVersion'] !== 1) bad('a texture import recipe version must be exactly 1', r['recipeVersion']);
    const toolchain = r['toolchain'];
    if (!isPlainObject(toolchain) || Object.keys(toolchain).length !== 1 || toolchain[AUDIO_PIPELINE_NAME] !== AUDIO_PIPELINE_VERSION) {
      bad(`the image toolchain must name exactly "${AUDIO_PIPELINE_NAME}" at '${AUDIO_PIPELINE_VERSION}'`, toolchain);
    }
    for (const k of Object.keys(r)) {
      if (!AUDIO_RECIPE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...AUDIO_RECIPE_FIELDS].join(', ')));
    }
    return;
  }
  if (kind === 'audio') {
    // §18.5/§41.4.3 (packet 47, CC-44-2): the promoted `pcm-wav` recipe is
    // enforced, not merely container-checked. Exactly `asset-pipeline` at the
    // repository pin, `recipeVersion` 1, and **no** `extensions` key.
    if (r['profile'] !== 'pcm-wav') bad('an audio import recipe profile must be "pcm-wav"', r['profile']);
    if (r['recipeVersion'] !== AUDIO_PCM_WAV_PROFILE.recipeVersion) {
      bad(`an audio import recipe version must be exactly ${AUDIO_PCM_WAV_PROFILE.recipeVersion}`, r['recipeVersion']);
    }
    const toolchain = r['toolchain'];
    if (!isPlainObject(toolchain)) {
      bad('import recipe must name a toolchain', toolchain);
    } else {
      const names = Object.keys(toolchain);
      if (names.length !== 1 || names[0] !== AUDIO_PIPELINE_NAME) {
        bad(`the pcm-wav toolchain must name exactly "${AUDIO_PIPELINE_NAME}"`, names);
      } else if (toolchain[AUDIO_PIPELINE_NAME] !== AUDIO_PIPELINE_VERSION) {
        bad(
          `toolchain["${AUDIO_PIPELINE_NAME}"] must be the pinned '${AUDIO_PIPELINE_VERSION}'`,
          toolchain[AUDIO_PIPELINE_NAME],
        );
      }
    }
    // §18.5/§41.4.3: the key set is exactly profile/recipeVersion/toolchain.
    // `extensions` is not merely empty — it must be absent.
    for (const k of Object.keys(r)) {
      if (!AUDIO_RECIPE_FIELDS.has(k)) {
        errors.push(
          unexpectedField(
            `${path}/${pointerSegment(k)}`,
            k,
            k === 'extensions'
              ? 'absent for profile "pcm-wav" (a WAV has no glTF extensions)'
              : [...AUDIO_RECIPE_FIELDS].join(', '),
          ),
        );
      }
    }
    return;
  }
  if (r['profile'] !== 'gltf-glb') bad('import recipe profile must be "gltf-glb"', r['profile']);
  if (r['recipeVersion'] !== 1) bad('import recipe version must be exactly 1 in M2', r['recipeVersion']);
  const toolchain = r['toolchain'];
  if (!isPlainObject(toolchain)) {
    bad('import recipe must name a toolchain', toolchain);
  } else {
    const names = Object.keys(toolchain);
    if (names.length < 1 || names.length > 8) bad('toolchain must have 1-8 entries', names.length);
    for (const n of names) {
      const v = toolchain[n];
      if (typeof v !== 'string' || !SEMVER_RE.test(v)) bad(`toolchain entry "${n}" must be an exact version string`, v);
    }
    if (names.some((n) => !(n === 'three'))) {
      // M2 accepts only the pinned loader line; unknown tools are recorded as
      // unaccepted toolchain names (repository pins are the only accepted values).
    }
  }
  const ext = r['extensions'];
  if (!Array.isArray(ext)) {
    bad('extensions must be an array of strings', ext);
  } else {
    for (let i = 0; i < ext.length; i++) {
      const e = ext[i];
      if (typeof e !== 'string') bad('extensions members must be strings', e);
      else if (!M2_GLTF_EXTENSION_ALLOWLIST.includes(e)) {
        bad(`extension "${e}" is outside the effective allowlist`, e);
      }
      if (i > 0 && typeof ext[i - 1] === 'string' && typeof e === 'string' && (ext[i - 1] as string) >= e) {
        bad('extensions must be ascending and unique', ext);
      }
    }
  }
  for (const k of Object.keys(r)) {
    if (!KNOWN_RECIPE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'profile, recipeVersion, toolchain, extensions'));
  }
}

function validateMetrics(
  m: unknown,
  path: string,
  errors: ModelErrorV2[],
  kind: AssetKindV3 = 'model',
  sourceByteLength?: unknown,
): void {
  if (!isPlainObject(m)) {
    errors.push(fieldType(path, m, 'object'));
    return;
  }
  if (kind === 'audio') {
    validateAudioMetrics(m, path, errors, sourceByteLength);
    return;
  }
  if (kind === 'texture') {
    validateTextureMetrics(m, path, errors);
    return;
  }
  if (kind === 'music') {
    validateMusicMetrics(m, path, errors);
    return;
  }
  for (const key of METRIC_ORDER) {
    const value = m[key];
    if (value === undefined) {
      errors.push(fieldMissing(`${path}/${key}`, key));
      continue;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      errors.push(fieldType(`${path}/${key}`, value, 'non-negative integer'));
      continue;
    }
    const cap = ASSET_METRIC_CAPS[key];
    if (value > cap) {
      const limitName = METRIC_LIMIT_NAMES[key] ?? (key as NonNullable<ModelErrorV2['limit']>);
      errors.push(
        limitsError(`${path}/${key}`, limitName, value, cap, `decoded-resource metric "${key}" exceeds its cap`),
      );
    }
  }
  for (const k of Object.keys(m)) {
    if (!(METRIC_ORDER as string[]).includes(k) && k !== 'bounds') {
      errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...METRIC_ORDER, 'bounds'].join(', ')));
    }
  }
  // Phase 15.3: the model's axis-aligned bounds in its own space (optional; recorded at import).
  const bounds = m['bounds'];
  if (bounds !== undefined) {
    const vec = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= MAX_LEN);
    const ok = isPlainObject(bounds) && Object.keys(bounds).every((k) => k === 'min' || k === 'max') && vec(bounds['min']) && vec(bounds['max']) && [0, 1, 2].every((i) => (bounds['min'] as number[])[i]! <= (bounds['max'] as number[])[i]!);
    if (!ok) errors.push(fieldValue(`${path}/bounds`, bounds, '{ min: [x, y, z], max: [x, y, z] } with min <= max', 'model bounds are the axis-aligned box of its vertices in metres'));
  }
  const g = m['decodedGeometryBytes'];
  const i = m['decodedImageBytes'];
  if (typeof g === 'number' && typeof i === 'number' && g + i > MAX_TOTAL_DECODED_BYTES) {
    errors.push(
      limitsError(path, 'decoded_bytes', g + i, MAX_TOTAL_DECODED_BYTES, 'total decoded bytes exceed the cap'),
    );
  }
}

/**
 * presentation.md §41.4.2/§41.4.3 + §18.6: the `PcmWavMetrics` member is
 * re-validated against every cap and against the record's own
 * `sourceByteLength` on every load. A disagreeing record is invalid
 * (`limits_exceeded`/`field_value`) and is **never normalized**.
 */
/** Phase 9.10: `{format, channels, sampleRate, durationMs}` of a music version. */
function validateMusicMetrics(m: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  if (!['ogg-vorbis', 'ogg-opus', 'mp3', 'wav'].includes(m['format'] as string)) {
    errors.push(fieldValue(`${path}/format`, m['format'], '"ogg-vorbis" | "ogg-opus" | "mp3" | "wav"', 'music is Ogg Vorbis/Opus, MP3 or WAV'));
  }
  if (m['channels'] !== 1 && m['channels'] !== 2) errors.push(fieldValue(`${path}/channels`, m['channels'], '1 | 2', 'music is mono or stereo'));
  const rate = m['sampleRate'];
  if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 8000 || rate > 48000) errors.push(fieldValue(`${path}/sampleRate`, rate, 'integer 8000..48000', 'the sample rate is 8-48 kHz'));
  const ms = m['durationMs'];
  if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 1 || ms > MAX_MUSIC_DURATION_MS) errors.push(fieldValue(`${path}/durationMs`, ms, `integer 1..${MAX_MUSIC_DURATION_MS}`, 'music lasts at most 10 minutes'));
  for (const k of Object.keys(m)) {
    if (!['format', 'channels', 'sampleRate', 'durationMs'].includes(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'format, channels, sampleRate, durationMs'));
  }
}

/** Phase 9.4: `{format, width, height, decodedBytes}` of a texture version. */
function validateTextureMetrics(m: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  if (m['format'] !== 'png' && m['format'] !== 'jpeg' && m['format'] !== 'webp') {
    errors.push(fieldValue(`${path}/format`, m['format'], '"png" | "jpeg" | "webp"', 'a texture is a PNG, JPEG or WebP image'));
  }
  for (const k of ['width', 'height'] as const) {
    const v = m[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_TEXTURE_EDGE) {
      errors.push(fieldValue(`${path}/${k}`, v, `integer 1..${MAX_TEXTURE_EDGE}`, `texture ${k} must be 1-${MAX_TEXTURE_EDGE} pixels`));
    }
  }
  if (typeof m['width'] === 'number' && typeof m['height'] === 'number' && m['decodedBytes'] !== m['width'] * m['height'] * 4) {
    errors.push(fieldValue(`${path}/decodedBytes`, m['decodedBytes'], 'width × height × 4', 'decodedBytes is derived from the size'));
  }
  for (const k of Object.keys(m)) {
    if (!['format', 'width', 'height', 'decodedBytes'].includes(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'format, width, height, decodedBytes'));
  }
}

function validateAudioMetrics(
  m: Record<string, unknown>,
  path: string,
  errors: ModelErrorV2[],
  sourceByteLength: unknown,
): void {
  const valueError = (field: string, value: unknown, expected: string, message: string): void => {
    errors.push(withFound({ code: 'field_value', path: `${path}/${field}`, message, expected }, value));
  };

  const int = (field: string): number | null => {
    const value = m[field];
    // Absence is already reported by the exact-key-set loop above.
    if (value === undefined) return null;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(fieldType(`${path}/${field}`, value, 'integer'));
      return null;
    }
    return value;
  };

  // Exact key set (the member is profile-determined, §18.6).
  for (const key of AUDIO_METRIC_ORDER) {
    if (m[key] === undefined) errors.push(fieldMissing(`${path}/${key}`, key));
  }
  for (const k of Object.keys(m)) {
    if (!(AUDIO_METRIC_ORDER as readonly string[]).includes(k)) {
      errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, AUDIO_METRIC_ORDER.join(', ')));
    }
  }

  // The two constant discriminators and the three constant header facts.
  if (m['container'] !== undefined && m['container'] !== 'riff-wave') {
    valueError('container', m['container'], '"riff-wave"', 'the audio metrics container must be "riff-wave"');
  }
  if (m['encoding'] !== undefined && m['encoding'] !== 'pcm-s16le') {
    valueError('encoding', m['encoding'], '"pcm-s16le"', 'the audio metrics encoding must be "pcm-s16le"');
  }
  if (m['channels'] !== undefined && m['channels'] !== AUDIO_PCM_WAV_PROFILE.channels) {
    valueError('channels', m['channels'], String(AUDIO_PCM_WAV_PROFILE.channels), 'the pcm-wav profile is mono');
  }
  if (m['sampleRate'] !== undefined && m['sampleRate'] !== AUDIO_PCM_WAV_PROFILE.sampleRate) {
    valueError('sampleRate', m['sampleRate'], String(AUDIO_PCM_WAV_PROFILE.sampleRate), 'the pcm-wav profile is 48000 Hz');
  }
  if (m['bitsPerSample'] !== undefined && m['bitsPerSample'] !== AUDIO_PCM_WAV_PROFILE.bitsPerSample) {
    valueError('bitsPerSample', m['bitsPerSample'], String(AUDIO_PCM_WAV_PROFILE.bitsPerSample), 'the pcm-wav profile is signed 16-bit');
  }

  const frames = int('frames');
  const durationMs = int('durationMs');
  const pcmBytes = int('pcmBytes');
  const dataChunkBytes = int('dataChunkBytes');
  const riffChunkBytes = int('riffChunkBytes');

  // Caps (§41.4.2; the single normative PCM bound names the limit).
  if (frames !== null && frames > AUDIO_FRAMES_MAX) {
    errors.push(limitsError(`${path}/frames`, 'audio_pcm_bytes', frames, AUDIO_FRAMES_MAX, 'frames exceed the PCM cap'));
  }
  if (pcmBytes !== null && pcmBytes > AUDIO_PCM_BYTES_MAX) {
    errors.push(limitsError(`${path}/pcmBytes`, 'audio_pcm_bytes', pcmBytes, AUDIO_PCM_BYTES_MAX, 'PCM bytes exceed the profile cap'));
  }
  if (durationMs !== null && durationMs > AUDIO_DURATION_MS_MAX) {
    errors.push(limitsError(`${path}/durationMs`, 'audio_pcm_bytes', durationMs, AUDIO_DURATION_MS_MAX, 'duration exceeds the derived cap'));
  }

  // Exact derived arithmetic (§41.4.2) — a disagreeing record is invalid.
  if (frames !== null && frames < 1) {
    valueError('frames', frames, 'an integer >= 1', 'a pcm-wav carries at least one frame');
  }
  if (frames !== null && pcmBytes !== null && pcmBytes !== frames * 2) {
    valueError('pcmBytes', pcmBytes, `frames * 2 (${frames * 2})`, 'pcmBytes must equal frames * 2');
  }
  if (frames !== null && durationMs !== null && durationMs !== Math.floor(frames / 48)) {
    valueError('durationMs', durationMs, `floor(frames / 48) (${Math.floor(frames / 48)})`, 'durationMs must equal floor(frames / 48)');
  }
  if (pcmBytes !== null && dataChunkBytes !== null && dataChunkBytes !== pcmBytes) {
    valueError('dataChunkBytes', dataChunkBytes, `pcmBytes (${pcmBytes})`, 'the data chunk holds exactly pcmBytes bytes');
  }
  if (pcmBytes !== null && riffChunkBytes !== null && riffChunkBytes !== 36 + pcmBytes) {
    valueError('riffChunkBytes', riffChunkBytes, `36 + pcmBytes (${36 + pcmBytes})`, 'riffChunkBytes must equal 36 + pcmBytes');
  }
  if (pcmBytes !== null && typeof sourceByteLength === 'number') {
    if (sourceByteLength !== 44 + pcmBytes) {
      valueError(
        'pcmBytes',
        pcmBytes,
        `sourceByteLength - 44 (${sourceByteLength - 44})`,
        'sourceByteLength must equal 44 + pcmBytes on every load',
      );
    } else if (sourceByteLength > AUDIO_SOURCE_BYTES_MAX) {
      errors.push(
        limitsError(
          `${path}/pcmBytes`,
          'audio_pcm_bytes',
          sourceByteLength,
          AUDIO_SOURCE_BYTES_MAX,
          'sourceByteLength exceeds the derived 44 + pcmBytes cap',
        ),
      );
    } else if (sourceByteLength > AUDIO_SOURCE_FILE_BYTES_MAX) {
      errors.push(
        limitsError(
          `${path}/pcmBytes`,
          'audio_pcm_bytes',
          sourceByteLength,
          AUDIO_SOURCE_FILE_BYTES_MAX,
          'sourceByteLength exceeds the source-file hard bound',
        ),
      );
    }
  }
}

function validateAssetVersion(v: unknown, path: string, errors: ModelErrorV2[], kind: AssetKindV3 = 'model'): void {
  if (!isPlainObject(v)) {
    errors.push(fieldType(path, v, 'object'));
    return;
  }
  const version = v['version'];
  if (typeof version !== 'number' || !Number.isInteger(version)) {
    errors.push(fieldType(`${path}/version`, version, 'integer'));
  }
  const digest = v['sourceDigest'];
  if (digest === undefined) errors.push(fieldMissing(`${path}/sourceDigest`, 'sourceDigest'));
  else if (typeof digest !== 'string') errors.push(fieldType(`${path}/sourceDigest`, digest, 'string'));
  else if (!DIGEST_RE.test(digest)) errors.push(digestError(`${path}/sourceDigest`, digest));

  const len = v['sourceByteLength'];
  if (len === undefined) errors.push(fieldMissing(`${path}/sourceByteLength`, 'sourceByteLength'));
  else if (typeof len !== 'number' || !Number.isInteger(len) || len < 1 || len > MAX_SOURCE_BYTES) {
    errors.push(
      withFound(
        {
          code: 'number_out_of_range',
          path: `${path}/sourceByteLength`,
          message: `sourceByteLength must be an integer in [1, ${MAX_SOURCE_BYTES}]`,
          expected: `integer 1..${MAX_SOURCE_BYTES}`,
        },
        len,
      ),
    );
  }
  const sourcePath = v['sourcePath'];
  if (sourcePath !== undefined) {
    if (typeof sourcePath !== 'string') errors.push(fieldType(`${path}/sourcePath`, sourcePath, 'string'));
    else if (!isValidSourcePath(sourcePath)) {
      errors.push(
        fieldValue(
          `${path}/sourcePath`,
          sourcePath,
          'a relative path with forward slashes, 1-512 characters, no "..", "." or empty segments, no ":" or "\\"',
          'sourcePath must be a relative path inside the game folder',
        ),
      );
    }
  }
  const converted = v['convertedFrom'];
  if (converted !== undefined) {
    const cpath = `${path}/convertedFrom`;
    if (kind !== 'model') errors.push(unexpectedField(cpath, 'convertedFrom', 'only a model version can be converted'));
    else if (sourcePath !== undefined) errors.push(unexpectedField(cpath, 'convertedFrom', 'a converted version is stored; it cannot also have a sourcePath'));
    else if (!isPlainObject(converted)) errors.push(fieldType(cpath, converted, 'object'));
    else {
      if (converted['format'] !== 'fbx') errors.push(fieldValue(`${cpath}/format`, converted['format'], '"fbx"', 'the converted format must be "fbx"'));
      const d = converted['sourceDigest'];
      if (typeof d !== 'string') errors.push(fieldType(`${cpath}/sourceDigest`, d, 'string'));
      else if (!DIGEST_RE.test(d)) errors.push(digestError(`${cpath}/sourceDigest`, d));
      const n = converted['sourceByteLength'];
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_CONVERTED_SOURCE_BYTES) {
        errors.push(withFound({ code: 'number_out_of_range', path: `${cpath}/sourceByteLength`, message: `sourceByteLength must be an integer in [1, ${MAX_CONVERTED_SOURCE_BYTES}]`, expected: `integer 1..${MAX_CONVERTED_SOURCE_BYTES}` }, n));
      }
      const sp = converted['sourcePath'];
      if (sp !== undefined && !isValidSourcePath(sp)) {
        errors.push(fieldValue(`${cpath}/sourcePath`, sp, 'a relative path inside the game folder', 'convertedFrom.sourcePath must be a relative path inside the game folder'));
      }
      const c = converted['converter'];
      if (!isPlainObject(c) || c['name'] !== 'blender' || typeof c['version'] !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(c['version']) || Object.keys(c).length !== 2) {
        errors.push(fieldValue(`${cpath}/converter`, c, '{ name: "blender", version: "X.Y.Z" }', 'the converter must name blender and its exact version'));
      }
      for (const k of Object.keys(converted)) {
        if (!['format', 'sourceDigest', 'sourceByteLength', 'sourcePath', 'converter'].includes(k)) {
          errors.push(unexpectedField(`${cpath}/${pointerSegment(k)}`, k, 'format, sourceDigest, sourceByteLength, sourcePath, converter'));
        }
      }
    }
  }
  if (v['importRecipe'] === undefined) errors.push(fieldMissing(`${path}/importRecipe`, 'importRecipe'));
  else validateImportRecipe(v['importRecipe'], `${path}/importRecipe`, errors, kind);
  if (v['metrics'] === undefined) errors.push(fieldMissing(`${path}/metrics`, 'metrics'));
  else validateMetrics(v['metrics'], `${path}/metrics`, errors, kind, len);

  const importedAt = v['importedAt'];
  if (importedAt === undefined) errors.push(fieldMissing(`${path}/importedAt`, 'importedAt'));
  else if (typeof importedAt !== 'string') errors.push(fieldType(`${path}/importedAt`, importedAt, 'string'));
  else if (!isValidTimestamp(importedAt)) {
    errors.push(fieldValue(`${path}/importedAt`, importedAt, 'YYYY-MM-DDTHH:mm:ssZ denoting an existing UTC date', 'importedAt must be a UTC timestamp with second precision'));
  }
  const published = v['publishedRevision'];
  if (published === undefined) errors.push(fieldMissing(`${path}/publishedRevision`, 'publishedRevision'));
  else if (typeof published !== 'number' || !Number.isInteger(published) || published < 0 || published > Number.MAX_SAFE_INTEGER) {
    errors.push(
      withFound(
        {
          code: 'number_out_of_range',
          path: `${path}/publishedRevision`,
          message: 'publishedRevision must be an integer in [0, 2^53-1]',
          expected: 'integer in [0, 2^53-1]',
        },
        published,
      ),
    );
  }
  for (const k of Object.keys(v)) {
    if (!KNOWN_VERSION_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_VERSION_FIELDS].join(', ')));
  }
}

function validateAsset(a: unknown, path: string, errors: ModelErrorV2[], v3 = false): number {
  if (!isPlainObject(a)) {
    errors.push(fieldType(path, a, 'object'));
    return 0;
  }
  const assetId = a['assetId'];
  if (assetId === undefined) errors.push(fieldMissing(`${path}/assetId`, 'assetId'));
  else if (typeof assetId !== 'string') errors.push(fieldType(`${path}/assetId`, assetId, 'string'));
  else if (!ID_RE_V2.test(assetId)) errors.push(idInvalid(`${path}/assetId`, assetId));

  const rawKind = a['kind'];
  let kind: AssetKindV3 = 'model';
  if (v3) {
    if (rawKind !== 'model' && rawKind !== 'audio' && rawKind !== 'texture' && rawKind !== 'music') {
      errors.push(fieldValue(`${path}/kind`, rawKind, '"model" | "audio" | "texture" | "music"', 'the v3 asset kind must be model, audio, texture or music'));
    } else {
      kind = rawKind;
    }
  } else if (rawKind !== 'model') {
    errors.push(fieldValue(`${path}/kind`, rawKind, '"model"', 'only the whole-GLB model kind exists in M2'));
  }
  const displayName = a['displayName'];
  if (displayName === undefined) errors.push(fieldMissing(`${path}/displayName`, 'displayName'));
  else if (typeof displayName !== 'string') errors.push(fieldType(`${path}/displayName`, displayName, 'string'));
  else if (!isValidName(displayName)) {
    errors.push(fieldValue(`${path}/displayName`, displayName, 'string, 1-128 chars, no control characters', 'asset displayName must be 1-128 characters without control characters'));
  }

  const versions = a['versions'];
  let count = 0;
  if (versions === undefined) {
    errors.push(fieldMissing(`${path}/versions`, 'versions'));
  } else if (!Array.isArray(versions)) {
    errors.push(fieldType(`${path}/versions`, versions, 'array'));
  } else {
    count = versions.length;
    const maxVersions = v3 && kind === 'audio' ? MAX_AUDIO_VERSIONS : v3 && kind === 'texture' ? MAX_TEXTURE_VERSIONS : v3 && kind === 'music' ? MAX_MUSIC_VERSIONS : MAX_ASSET_VERSIONS;
    if (versions.length < 1 || versions.length > maxVersions) {
      errors.push(
        limitsError(`${path}/versions`, kind === 'audio' ? 'audio_versions' : 'asset_versions', versions.length, maxVersions, `an asset record must have 1-${maxVersions} versions`),
      );
    }
    let contiguous = true;
    for (let i = 0; i < versions.length; i++) {
      const v = versions[i];
      if (!isPlainObject(v) || v['version'] !== i + 1) contiguous = false;
    }
    if (!contiguous) {
      errors.push(
        withFound(
          {
            code: 'asset_version_invalid',
            path: `${path}/versions`,
            message: 'versions must be contiguous strictly ascending 1..N (append-only)',
            expected: 'version[i] == i + 1',
          },
          versions.map((v) => (isPlainObject(v) ? v['version'] : null)),
        ),
      );
    }
    for (let i = 0; i < versions.length; i++) {
      validateAssetVersion(versions[i], `${path}/versions/${i}`, errors, kind);
    }
    const last = versions[versions.length - 1];
    if (isPlainObject(last) && a['currentVersion'] !== last['version']) {
      errors.push(
        fieldValue(
          `${path}/currentVersion`,
          a['currentVersion'],
          `the last version (${String(last['version'])})`,
          'currentVersion must equal the record\'s last version (a derived pointer, never normalized)',
        ),
      );
    }
  }
  if (a['currentVersion'] !== undefined && (typeof a['currentVersion'] !== 'number' || !Number.isInteger(a['currentVersion']))) {
    errors.push(fieldType(`${path}/currentVersion`, a['currentVersion'], 'integer'));
  } else if (a['currentVersion'] === undefined) {
    errors.push(fieldMissing(`${path}/currentVersion`, 'currentVersion'));
  }
  const vertexColors = a['vertexColors'];
  if (vertexColors !== undefined) {
    if (!v3 || kind !== 'model') errors.push(unexpectedField(`${path}/vertexColors`, 'vertexColors', 'only a v3/v4 model asset has vertexColors'));
    else if (vertexColors !== 'tint') {
      errors.push(fieldValue(`${path}/vertexColors`, vertexColors, '"tint" (absent = data)', 'vertexColors is stored only as "tint"; the default treats COLOR_0 as shader data'));
    }
  }
  // Phase 14.6: an animation-only model whose clips play on another model's rig (checked against the catalog in v4).
  const clipsFor = a['clipsFor'];
  if (clipsFor !== undefined) {
    if (!v3 || kind !== 'model') errors.push(unexpectedField(`${path}/clipsFor`, 'clipsFor', 'only a v4 model asset has clipsFor'));
    else if (typeof clipsFor !== 'string' || !ID_RE_V2.test(clipsFor)) errors.push(fieldValue(`${path}/clipsFor`, clipsFor, 'a model assetId', 'clipsFor names the model asset whose rig these clips are for'));
  }
  for (const k of Object.keys(a)) {
    if (!KNOWN_ASSET_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_ASSET_FIELDS].join(', ')));
  }
  return count;
}

// ---- prefabs (§20.2/§20.3) ----------------------------------------------------

function prefabDepth(entities: Record<string, unknown>[]): number {
  const byLocal = new Map<string, Record<string, unknown>>();
  for (const e of entities) {
    const id = e['localId'];
    if (typeof id === 'string') byLocal.set(id, e);
  }
  const depth = new Map<string, number>();
  let max = 0;
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    const e = byLocal.get(id);
    if (!e) return 0;
    seen.add(id);
    const parent = e['parentLocalId'];
    const d = typeof parent === 'string' ? depthOf(parent, seen) + 1 : 1;
    depth.set(id, d);
    if (d > max) max = d;
    return d;
  };
  for (const e of entities) {
    const id = e['localId'];
    if (typeof id === 'string') depthOf(id, new Set());
  }
  return max;
}

/**
 * Phase 14.1: the components a v4 prefab entity may carry besides transform,
 * model, box and behavior — what a spawned (`ctx.spawn`) or placed copy needs
 * to collide, look right and take part in the game (a crate, a coin, an
 * enemy, a moving projectile). Scene-only components (camera, controller,
 * lights, zones, spawn markers, instance sets, fog volumes, the player's
 * health) stay out: a copy is never the player, the camera or level wiring.
 */
export const PREFAB_V4_COMPONENTS = ['collider', 'surface', 'materials', 'animator', 'mover', 'trigger', 'switch', 'pickup', 'enemy', 'audioSource', 'faceMovement'] as const;
const PREFAB_BLOCKS = ['mover', 'trigger', 'switch', 'pickup', 'enemy', 'audioSource', 'faceMovement'] as const;

function validatePrefabExtras(comps: Record<string, unknown>, parentLocalId: unknown, path: string, errors: ModelErrorV2[]): void {
  const col = comps['collider'];
  if (col !== undefined) {
    const oneWay = isPlainObject(col) ? col['oneWay'] : undefined;
    if (oneWay !== undefined && oneWay !== true) errors.push(fieldValue(`${path}/collider/oneWay`, oneWay, 'true', 'oneWay is true or absent'));
    validateColliderComponent(isPlainObject(col) && oneWay !== undefined ? Object.fromEntries(Object.entries(col).filter(([k]) => k !== 'oneWay')) : col, `${path}/collider`, errors);
    // A collider sits on the definition root at unit scale, rotated about Z only (as on a scene entity).
    validatePhysicsTransform(comps, typeof parentLocalId === 'string' ? parentLocalId : undefined, path, false, errors);
    if (comps['enemy'] !== undefined) {
      errors.push(withFound({ code: 'component_conflict', path, message: 'an enemy has no collider (its size is its body)', expected: 'enemy or collider' }, ['enemy', 'collider']));
    }
  }
  if (comps['surface'] !== undefined) {
    validateSurfaceComponent(comps['surface'], `${path}/surface`, errors as never);
    if (comps['box'] === undefined && comps['model'] === undefined) errors.push({ code: 'component_missing', path: `${path}/surface`, message: 'a surface component sits only on an entity carrying box or model', expected: 'box|model' });
  }
  if (comps['materials'] !== undefined) {
    validateMaterialMapping(comps['materials'], `${path}/materials`, errors);
    if (comps['box'] === undefined && comps['model'] === undefined) errors.push({ code: 'component_missing', path: `${path}/materials`, message: 'a materials component sits only on an entity with a model or a box', expected: 'model|box' });
  }
  if (comps['animator'] !== undefined) {
    validateAnimatorComponent(comps['animator'], `${path}/animator`, errors);
    if (comps['model'] === undefined) errors.push({ code: 'component_missing', path: `${path}/animator`, message: 'an animator sits only on an entity with a model', expected: 'model' });
  }
  for (const name of PREFAB_BLOCKS) {
    if (comps[name] !== undefined) (BLOCK_COMPONENTS[name].validate as (c: unknown, p: string, e: ModelErrorV2[]) => void)(comps[name], `${path}/${name}`, errors);
  }
}

function validatePrefabEntity(e: unknown, idx: number, path: string, errors: ModelErrorV2[], localIndex: Map<string, number>, version: 3 | 4 = 3): void {
  if (!isPlainObject(e)) {
    errors.push(fieldType(path, e, 'object'));
    return;
  }
  const localId = e['localId'];
  if (localId === undefined) errors.push(fieldMissing(`${path}/localId`, 'localId'));
  else if (typeof localId !== 'string') errors.push(fieldType(`${path}/localId`, localId, 'string'));
  else {
    if (!ID_RE_V2.test(localId)) errors.push(idInvalid(`${path}/localId`, localId));
    const first = localIndex.get(localId);
    if (first === undefined) localIndex.set(localId, idx);
    else {
      errors.push(
        withFound(
          { code: 'id_duplicate', path: `${path}/localId`, message: 'localId is already used in this definition (first occurrence wins)', expected: 'a unique localId within the definition' },
          localId,
        ),
      );
    }
  }
  const name = e['name'];
  if (name !== undefined) {
    if (typeof name !== 'string') errors.push(fieldType(`${path}/name`, name, 'string'));
    else if (!isValidName(name)) errors.push(fieldValue(`${path}/name`, name, 'string, 1-128 chars, no control characters', 'prefab entity name must be 1-128 characters without control characters'));
  }
  const parent = e['parentLocalId'];
  if (parent !== undefined && parent !== null) {
    if (typeof parent !== 'string') errors.push(fieldType(`${path}/parentLocalId`, parent, 'string or null'));
    else {
      const pidx = localIndex.get(parent);
      if (pidx === undefined) {
        errors.push(
          withFound(
            { code: 'prefab_reference_missing', path: `${path}/parentLocalId`, message: 'parentLocalId must reference an earlier entity localId in this definition', expected: 'an earlier localId' },
            parent,
          ),
        );
      } else if (pidx >= idx) {
        errors.push(
          withFound(
            { code: 'order_parent_before_child', path: `${path}/parentLocalId`, message: 'a prefab entity must appear before its parent (definition document order)', expected: 'parent index < child index' },
            parent,
          ),
        );
      }
    }
  }
  const comps = e['components'];
  if (comps === undefined) {
    errors.push(fieldMissing(`${path}/components`, 'components'));
  } else if (!isPlainObject(comps)) {
    errors.push(fieldType(`${path}/components`, comps, 'object'));
  } else {
    const allowed = new Set<string>(['transform', 'model', 'box', 'behavior', ...(version === 4 ? PREFAB_V4_COMPONENTS : [])]);
    const allowedText = version === 4 ? `transform, model, box, behavior, ${PREFAB_V4_COMPONENTS.join(', ')}` : 'transform, model, box, behavior';
    for (const k of Object.keys(comps)) {
      if (!allowed.has(k)) {
        if (k === 'camera' || k === 'prefab') {
          errors.push(
            withFound(
              {
                code: 'prefab_component_forbidden',
                path: `${path}/components/${pointerSegment(k)}`,
                message: `a prefab definition entity must not carry ${k}`,
                expected: allowedText,
              },
              k,
            ),
          );
        } else {
          errors.push(withFound({ code: 'component_unknown', path: `${path}/components/${pointerSegment(k)}`, message: 'component is not permitted in a prefab definition', expected: allowedText }, k));
        }
      }
    }
    if (comps['transform'] === undefined) {
      errors.push({ code: 'component_missing', path: `${path}/components/transform`, message: 'every prefab entity requires the transform component', expected: 'transform present' });
    }
    if (comps['model'] !== undefined) validateModelComponent(comps['model'], `${path}/components/model`, errors);
    if (comps['box'] !== undefined) {
      // box uses the M1 rules (size/material); canonicalization reuses §10.2.
      void canonicalBox;
    }
    if (comps['behavior'] !== undefined) validateBehaviorComponent(comps['behavior'], `${path}/components/behavior`, errors);
    if (version === 4) validatePrefabExtras(comps, parent, `${path}/components`, errors);
  }
  for (const k of Object.keys(e)) {
    if (!KNOWN_PREFAB_ENTITY_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'localId, name, parentLocalId, components'));
  }
}

function validatePrefabDefinition(d: unknown, path: string, errors: ModelErrorV2[], version: 3 | 4 = 3): void {
  if (!isPlainObject(d)) {
    errors.push(fieldType(path, d, 'object'));
    return;
  }
  const prefabId = d['prefabId'];
  if (prefabId === undefined) errors.push(fieldMissing(`${path}/prefabId`, 'prefabId'));
  else if (typeof prefabId !== 'string') errors.push(fieldType(`${path}/prefabId`, prefabId, 'string'));
  else if (!ID_RE_V2.test(prefabId)) errors.push(idInvalid(`${path}/prefabId`, prefabId));

  const displayName = d['displayName'];
  if (displayName === undefined) errors.push(fieldMissing(`${path}/displayName`, 'displayName'));
  else if (typeof displayName !== 'string') errors.push(fieldType(`${path}/displayName`, displayName, 'string'));
  else if (!isValidName(displayName)) errors.push(fieldValue(`${path}/displayName`, displayName, 'string, 1-128 chars, no control characters', 'prefab displayName must be 1-128 characters without control characters'));

  const created = d['createdRevision'];
  if (created === undefined) errors.push(fieldMissing(`${path}/createdRevision`, 'createdRevision'));
  else if (typeof created !== 'number' || !Number.isInteger(created) || created < 0 || created > Number.MAX_SAFE_INTEGER) {
    errors.push(withFound({ code: 'number_out_of_range', path: `${path}/createdRevision`, message: 'createdRevision must be an integer in [0, 2^53-1]', expected: 'integer in [0, 2^53-1]' }, created));
  }

  const entities = d['entities'];
  if (entities === undefined) errors.push(fieldMissing(`${path}/entities`, 'entities'));
  else if (!Array.isArray(entities)) errors.push(fieldType(`${path}/entities`, entities, 'array'));
  else {
    if (entities.length < 1 || entities.length > MAX_PREFAB_ENTITIES) {
      errors.push(limitsError(`${path}/entities`, 'prefab_entities', entities.length, MAX_PREFAB_ENTITIES, `a definition must have 1-${MAX_PREFAB_ENTITIES} entities`));
    }
    const localIndex = new Map<string, number>();
    for (let i = 0; i < entities.length; i++) {
      validatePrefabEntity(entities[i], i, `${path}/entities/${i}`, errors, localIndex, version);
    }
    if (d['entityCount'] !== entities.length) {
      errors.push(fieldValue(`${path}/entityCount`, d['entityCount'], `entities.length (${entities.length})`, 'entityCount is derived and must equal entities.length'));
    }
    const depth = prefabDepth(entities.filter(isPlainObject));
    if (depth > MAX_PREFAB_DEPTH) {
      errors.push(limitsError(`${path}/entities`, 'prefab_depth', depth, MAX_PREFAB_DEPTH, `definition depth exceeds ${MAX_PREFAB_DEPTH}`));
    }
    if (d['depth'] !== undefined && d['depth'] !== depth) {
      errors.push(fieldValue(`${path}/depth`, d['depth'], `the derived depth (${depth})`, 'depth is derived and must equal the definition hierarchy depth'));
    } else if (d['depth'] === undefined) {
      errors.push(fieldMissing(`${path}/depth`, 'depth'));
    }
  }
  for (const k of Object.keys(d)) {
    if (!KNOWN_PREFAB_DEF_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_PREFAB_DEF_FIELDS].join(', ')));
  }
}

/**
 * Phase 14.1: validate a list of prefab definitions on their own (the runtime
 * snapshot's `prefabs`, the manifest's): each definition by the content rules
 * (`version` 4 allows `PREFAB_V4_COMPONENTS`), ids unique, at most `MAX_PREFABS`.
 */
export function validatePrefabDefinitions(value: unknown, path: string, errors: ModelErrorV2[], version: 3 | 4 = 4): void {
  if (!Array.isArray(value)) {
    errors.push(fieldType(path, value, 'array'));
    return;
  }
  if (value.length > MAX_PREFABS) errors.push(limitsError(path, 'prefabs', value.length, MAX_PREFABS, `at most ${MAX_PREFABS} prefab definitions`));
  const seen = new Set<string>();
  value.forEach((d, i) => {
    validatePrefabDefinition(d, `${path}/${i}`, errors, version);
    const id = isPlainObject(d) ? d['prefabId'] : undefined;
    if (typeof id === 'string') {
      if (seen.has(id)) errors.push(withFound({ code: 'id_duplicate', path: `${path}/${i}/prefabId`, message: 'prefabId is already used (first occurrence wins)', expected: 'a unique prefabId' }, id));
      seen.add(id);
    }
  });
}

/** Phase 14.1: the canonical form of a prefab definition list (sorted by id). */
export function canonicalPrefabs(defs: readonly PrefabDefinition[]): PrefabDefinition[] {
  return sortedRecord([...defs], (d) => d.prefabId).map(canonicalPrefab);
}

// ---- declared properties and behaviors (§20.5/§20.8/§22.2) ---------------------

function checkPropertyValueShape(
  type: string,
  v: unknown,
  prop: Record<string, unknown>,
  path: string,
  errors: ModelErrorV2[],
): void {
  const failType = (expected: string): void => {
    errors.push(withFound({ code: 'property_type', path, message: `value must match declared type ${type}`, expected }, v));
  };
  const failValue = (expected: string): void => {
    errors.push(withFound({ code: 'property_value', path, message: `value violates the declared constraints of ${type}`, expected }, v));
  };
  switch (type) {
    case 'number': {
      if (typeof v !== 'number' || !Number.isFinite(v)) return failType('finite number');
      const min = prop['min'];
      const max = prop['max'];
      if (typeof min === 'number' && v < min) return failValue(`v >= ${min}`);
      if (typeof max === 'number' && v > max) return failValue(`v <= ${max}`);
      return;
    }
    case 'boolean':
      if (typeof v !== 'boolean') failType('boolean');
      return;
    case 'string': {
      if (typeof v !== 'string') return failType('string');
      const maxLength = typeof prop['maxLength'] === 'number' ? prop['maxLength'] : 256;
      if ([...v].length > maxLength) return failValue(`length <= ${maxLength} code points`);
      for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c <= 0x1f || c === 0x7f) return failValue('no control characters');
      }
      return;
    }
    case 'enum': {
      if (typeof v !== 'string') return failType('string enum member');
      const values = prop['values'];
      if (!Array.isArray(values) || !values.includes(v)) return failValue('one of the declared enum values');
      return;
    }
    case 'vec3': {
      if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        return failType('[number, number, number]');
      }
      const bounds = prop['bounds'];
      if (isPlainObject(bounds) && Array.isArray(bounds['min']) && Array.isArray(bounds['max'])) {
        for (let i = 0; i < 3; i++) {
          const n = v[i] as number;
          if (n < (bounds['min'][i] as number) || n > (bounds['max'][i] as number)) return failValue('component-wise within bounds');
        }
      }
      return;
    }
    case 'entityRef':
    case 'assetRef':
      if (v === null) return;
      if (typeof v !== 'string' || !ID_RE_V2.test(v)) return failType('an ID string or null');
      return;
    default:
      return failType('a known property type');
  }
}

/** Phase 15.4: no C0 control character or DEL (the declared text fields). */
function isControlFreeText(v: string): boolean {
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

function validateDeclaredProperty(p: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(p)) {
    errors.push(fieldType(path, p, 'object'));
    return;
  }
  const key = p['key'];
  if (key === undefined) errors.push(fieldMissing(`${path}/key`, 'key'));
  else if (typeof key !== 'string') errors.push(fieldType(`${path}/key`, key, 'string'));
  else if (!PROPERTY_KEY_RE.test(key)) errors.push(fieldValue(`${path}/key`, key, '^[a-z][a-z0-9_]{0,63}$', 'property keys must match the declared key syntax'));

  const label = p['label'];
  if (label === undefined) errors.push(fieldMissing(`${path}/label`, 'label'));
  else if (typeof label !== 'string') errors.push(fieldType(`${path}/label`, label, 'string'));
  else if (label.length < 1 || label.length > 64) errors.push(fieldValue(`${path}/label`, label, 'string, 1-64 chars', 'property labels must be 1-64 characters'));

  const type = p['type'];
  if (type === undefined) errors.push(fieldMissing(`${path}/type`, 'type'));
  else if (typeof type !== 'string' || !PROPERTY_TYPES.has(type)) {
    errors.push(fieldValue(`${path}/type`, type, 'one of the seven M2 property types', 'property type must be one of the seven M2 types'));
  }
  if (p['default'] === undefined) errors.push(fieldMissing(`${path}/default`, 'default'));
  else checkPropertyValueShape(String(type), p['default'], p, `${path}/default`, errors);

  for (const field of ['min', 'max'] as const) {
    const v = p[field];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12)) {
      errors.push(fieldValue(`${path}/${field}`, v, 'finite number with |v| <= 1e12', `${field} must be a finite number with |v| <= 1e12`));
    }
  }
  if (typeof p['min'] === 'number' && typeof p['max'] === 'number' && (p['min'] as number) > (p['max'] as number)) {
    errors.push(fieldValue(`${path}/min`, p['min'], 'min <= max', 'property min must be <= max'));
  }
  const step = p['step'];
  if (step !== undefined && (typeof step !== 'number' || !Number.isFinite(step) || step <= 0 || step > 1e6)) {
    errors.push(fieldValue(`${path}/step`, step, 'number with 0 < v <= 1e6', 'property step must satisfy 0 < v <= 1e6'));
  }
  const maxLength = p['maxLength'];
  if (maxLength !== undefined && (typeof maxLength !== 'number' || !Number.isInteger(maxLength) || maxLength < 1 || maxLength > 1024)) {
    errors.push(fieldValue(`${path}/maxLength`, maxLength, 'integer 1-1024', 'string maxLength must be an integer 1-1024'));
  }
  const values = p['values'];
  if (values !== undefined) {
    if (type !== 'enum') errors.push(fieldValue(`${path}/values`, values, 'only enum properties declare values', 'values is only valid for the enum type'));
    else if (!Array.isArray(values)) errors.push(fieldType(`${path}/values`, values, 'array'));
    else {
      if (values.length < 1 || values.length > MAX_ENUM_VALUES) {
        errors.push(limitsError(`${path}/values`, 'enum_values', values.length, MAX_ENUM_VALUES, `enum members must be 1-${MAX_ENUM_VALUES}`));
      }
      const seen = new Set<string>();
      for (let i = 0; i < values.length; i++) {
        const m = values[i];
        if (typeof m !== 'string' || m.length < 1 || m.length > 64) errors.push(fieldValue(`${path}/values/${i}`, m, 'string, 1-64 chars', 'enum members must be 1-64 characters'));
        else if (seen.has(m)) errors.push(fieldValue(`${path}/values/${i}`, m, 'unique enum members', 'enum members must be unique'));
        else seen.add(m);
      }
    }
  }
  const bounds = p['bounds'];
  if (bounds !== undefined) {
    if (type !== 'vec3') errors.push(fieldValue(`${path}/bounds`, bounds, 'only vec3 properties declare bounds', 'bounds is only valid for the vec3 type'));
    else if (!isPlainObject(bounds)) errors.push(fieldType(`${path}/bounds`, bounds, 'object'));
    else {
      const bmin = bounds['min'];
      const bmax = bounds['max'];
      const validVec = (x: unknown): x is [number, number, number] =>
        Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6);
      if (!validVec(bmin)) errors.push(fieldValue(`${path}/bounds/min`, bmin, 'finite [x, y, z] with |v| <= 1e6', 'bounds.min must be a finite triple with |v| <= 1e6'));
      if (!validVec(bmax)) errors.push(fieldValue(`${path}/bounds/max`, bmax, 'finite [x, y, z] with |v| <= 1e6', 'bounds.max must be a finite triple with |v| <= 1e6'));
      if (validVec(bmin) && validVec(bmax)) {
        for (let i = 0; i < 3; i++) {
          if ((bmin[i] as number) > (bmax[i] as number)) errors.push(fieldValue(`${path}/bounds`, bounds, 'component-wise min <= max', 'bounds must satisfy component-wise min <= max'));
        }
      }
      for (const k of Object.keys(bounds)) {
        if (!KNOWN_BOUNDS_FIELDS.has(k)) errors.push(unexpectedField(`${path}/bounds/${pointerSegment(k)}`, k, 'min, max'));
      }
    }
  }
  // Phase 15.4: visibility (absent = public) and the Inspector texts.
  const visibility = p['visibility'];
  if (visibility !== undefined && visibility !== 'public' && visibility !== 'private') {
    errors.push(fieldValue(`${path}/visibility`, visibility, '"public" or "private"', 'property visibility must be "public" or "private"'));
  }
  for (const [field, max] of PROPERTY_TEXT_FIELDS) {
    const v = p[field];
    if (v === undefined) continue;
    if (typeof v !== 'string') errors.push(fieldType(`${path}/${field}`, v, 'string'));
    else if (v.length < 1 || v.length > max || !isControlFreeText(v)) {
      errors.push(fieldValue(`${path}/${field}`, v, `string, 1-${max} chars, no control characters`, `property ${field} must be 1-${max} characters without control characters`));
    }
  }
  for (const k of Object.keys(p)) {
    if (!KNOWN_PROPERTY_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_PROPERTY_FIELDS].join(', ')));
  }
}

function validateBehaviorSource(s: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(s)) {
    errors.push(fieldType(path, s, 'object or null'));
    return;
  }
  for (const [field, max] of [
    ['sourceDigest', 0],
    ['manifestDigest', 0],
    ['outputDigest', 0],
  ] as const) {
    const v = s[field];
    if (v === undefined) errors.push(fieldMissing(`${path}/${field}`, field));
    else if (typeof v !== 'string') errors.push(fieldType(`${path}/${field}`, v, 'string'));
    else if (!DIGEST_RE.test(v)) errors.push(digestError(`${path}/${field}`, v));
    void max;
  }
  const sourceLen = s['sourceByteLength'];
  if (sourceLen !== undefined && (typeof sourceLen !== 'number' || !Number.isInteger(sourceLen) || sourceLen < 1 || sourceLen > MAX_BEHAVIOR_SOURCE_BYTES)) {
    errors.push(limitsError(`${path}/sourceByteLength`, 'graph_bytes', Number(sourceLen), MAX_BEHAVIOR_SOURCE_BYTES, `sourceByteLength must be an integer in [1, ${MAX_BEHAVIOR_SOURCE_BYTES}]`));
  } else if (sourceLen === undefined) errors.push(fieldMissing(`${path}/sourceByteLength`, 'sourceByteLength'));

  if (s['entryPath'] !== 'src/index.ts') {
    errors.push(fieldValue(`${path}/entryPath`, s['entryPath'], '"src/index.ts"', 'a stored source record entryPath is exactly "src/index.ts"'));
  }
  const fileCount = s['fileCount'];
  if (fileCount === undefined) errors.push(fieldMissing(`${path}/fileCount`, 'fileCount'));
  else if (typeof fileCount !== 'number' || !Number.isInteger(fileCount) || fileCount < 1 || fileCount > MAX_BEHAVIOR_FILES) {
    errors.push(limitsError(`${path}/fileCount`, 'files', Number(fileCount), MAX_BEHAVIOR_FILES, `fileCount must be an integer in [1, ${MAX_BEHAVIOR_FILES}]`));
  }
  const outputLen = s['outputByteLength'];
  if (outputLen === undefined) errors.push(fieldMissing(`${path}/outputByteLength`, 'outputByteLength'));
  else if (typeof outputLen !== 'number' || !Number.isInteger(outputLen) || outputLen < 1 || outputLen > MAX_BEHAVIOR_OUTPUT_BYTES) {
    errors.push(limitsError(`${path}/outputByteLength`, 'output_bytes', Number(outputLen), MAX_BEHAVIOR_OUTPUT_BYTES, `outputByteLength must be an integer in [1, ${MAX_BEHAVIOR_OUTPUT_BYTES}]`));
  }
  const modules = s['requiredModules'];
  if (modules === undefined) errors.push(fieldMissing(`${path}/requiredModules`, 'requiredModules'));
  else if (!Array.isArray(modules)) errors.push(fieldType(`${path}/requiredModules`, modules, 'array'));
  else {
    for (let i = 0; i < modules.length; i++) {
      const m = modules[i];
      if (typeof m !== 'string') errors.push(fieldType(`${path}/requiredModules/${i}`, m, 'string'));
      else if (i > 0 && typeof modules[i - 1] === 'string' && (modules[i - 1] as string) >= m) {
        errors.push(fieldValue(`${path}/requiredModules/${i}`, m, 'ascending unique module ids', 'requiredModules must be ascending and unique'));
      }
    }
  }
  const owned = s['ownedTransforms'];
  if (owned !== undefined) {
    // Phase 14.1: entity ids or "@self", ascending, unique, 1..16 (the container's rules).
    if (!Array.isArray(owned) || owned.length < 1 || owned.length > 16) errors.push(fieldValue(`${path}/ownedTransforms`, owned, '1-16 entity ids or "@self"', 'ownedTransforms is absent or lists 1-16 entries'));
    else {
      owned.forEach((id, i) => {
        if (typeof id !== 'string' || (id !== '@self' && !ID_RE_V2.test(id))) errors.push(fieldValue(`${path}/ownedTransforms/${i}`, id, 'an entity id or "@self"', 'an owned transform names an entity id or "@self"'));
        else if (i > 0 && typeof owned[i - 1] === 'string' && (owned[i - 1] as string) >= id) errors.push(fieldValue(`${path}/ownedTransforms/${i}`, id, 'ascending unique entries', 'ownedTransforms must be ascending and unique'));
      });
    }
  }
  // Phase 15.4: present only as `true` (the declaration was derived from the code).
  if (s['declaredInCode'] !== undefined && s['declaredInCode'] !== true) {
    errors.push(fieldValue(`${path}/declaredInCode`, s['declaredInCode'], 'true or absent', 'declaredInCode is absent or true'));
  }
  const published = s['publishedRevision'];
  if (published === undefined) errors.push(fieldMissing(`${path}/publishedRevision`, 'publishedRevision'));
  else if (typeof published !== 'number' || !Number.isInteger(published) || published < 0) {
    // `project-model.md` §12 step 5 / §22.2 rule 4: a stored source record
    // written by the preparation path carries the revision it landed at
    // (`>= 1`), while the `workspace.md` §16.5.2 copy resets it to `0` for the
    // new project identity. A document cannot tell the two provenances apart,
    // so the load bound is the union: `>= 0`. The preparation/publication
    // command still writes `>= 1`.
    errors.push(withFound({ code: 'number_out_of_range', path: `${path}/publishedRevision`, message: 'a source record publishedRevision must be an integer >= 0', expected: 'integer >= 0' }, published));
  }
  for (const k of Object.keys(s)) {
    if (!KNOWN_SOURCE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_SOURCE_FIELDS].join(', ')));
  }
}

function validateBehaviorRecord(b: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(b)) {
    errors.push(fieldType(path, b, 'object'));
    return;
  }
  const behaviorId = b['behaviorId'];
  if (behaviorId === undefined) errors.push(fieldMissing(`${path}/behaviorId`, 'behaviorId'));
  else if (typeof behaviorId !== 'string') errors.push(fieldType(`${path}/behaviorId`, behaviorId, 'string'));
  else if (!ID_RE_V2.test(behaviorId)) errors.push(idInvalid(`${path}/behaviorId`, behaviorId));

  const displayName = b['displayName'];
  if (displayName === undefined) errors.push(fieldMissing(`${path}/displayName`, 'displayName'));
  else if (typeof displayName !== 'string') errors.push(fieldType(`${path}/displayName`, displayName, 'string'));
  else if (!isValidName(displayName)) errors.push(fieldValue(`${path}/displayName`, displayName, 'string, 1-128 chars, no control characters', 'behavior displayName must be 1-128 characters without control characters'));

  const declaration = b['declaration'];
  if (declaration === undefined) errors.push(fieldMissing(`${path}/declaration`, 'declaration'));
  else if (!isPlainObject(declaration)) errors.push(fieldType(`${path}/declaration`, declaration, 'object'));
  else {
    const props = declaration['properties'];
    if (props === undefined) errors.push(fieldMissing(`${path}/declaration/properties`, 'properties'));
    else if (!Array.isArray(props)) errors.push(fieldType(`${path}/declaration/properties`, props, 'array'));
    else {
      if (props.length < 1 || props.length > MAX_PROPERTIES) {
        errors.push(limitsError(`${path}/declaration/properties`, 'properties', props.length, MAX_PROPERTIES, `a declaration must have 1-${MAX_PROPERTIES} properties`));
      }
      const seen = new Set<string>();
      for (let i = 0; i < props.length; i++) {
        const p = props[i];
        validateDeclaredProperty(p, `${path}/declaration/properties/${i}`, errors);
        if (isPlainObject(p) && typeof p['key'] === 'string') {
          if (seen.has(p['key'])) {
            errors.push(withFound({ code: 'id_duplicate', path: `${path}/declaration/properties/${i}/key`, message: 'property key is already declared (first occurrence wins)', expected: 'a unique key' }, p['key']));
          } else seen.add(p['key']);
        }
      }
      if (canonicalDocBytes(declaration) > MAX_DECLARATION_BYTES) {
        errors.push(limitsError(`${path}/declaration`, 'declaration_bytes', canonicalDocBytes(declaration), MAX_DECLARATION_BYTES, 'canonical declaration exceeds the byte cap'));
      }
    }
    for (const k of Object.keys(declaration)) {
      if (!KNOWN_DECLARATION_FIELDS.has(k)) errors.push(unexpectedField(`${path}/declaration/${pointerSegment(k)}`, k, 'properties'));
    }
  }

  const source = b['source'];
  if (source === undefined) errors.push(fieldMissing(`${path}/source`, 'source'));
  else if (source !== null) validateBehaviorSource(source, `${path}/source`, errors);

  const published = b['publishedRevision'];
  if (published === undefined) errors.push(fieldMissing(`${path}/publishedRevision`, 'publishedRevision'));
  else if (typeof published !== 'number' || !Number.isInteger(published) || published < 0 || published > Number.MAX_SAFE_INTEGER) {
    errors.push(withFound({ code: 'number_out_of_range', path: `${path}/publishedRevision`, message: 'publishedRevision must be an integer in [0, 2^53-1]', expected: 'integer in [0, 2^53-1]' }, published));
  }
  for (const k of Object.keys(b)) {
    if (!KNOWN_BEHAVIOR_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_BEHAVIOR_FIELDS].join(', ')));
  }
}

// ---- settings registry (§20.9/§21.4) ------------------------------------------

export interface SettingsKeySpec {
  key: string;
  type: 'number';
  default: number;
  min?: number;
  max?: number;
  minExclusive?: boolean;
  maxExclusive?: boolean;
  unit: string;
  /** Phase 15.3: whole numbers only. */
  integer?: boolean;
  /** Phase 15.3: exactly one of these values. */
  values?: readonly number[];
  /**
   * Phase 15.3: an engine setting resolved only when the project sets it
   * (absent: the engine uses `default`), so a project that never sets it
   * keeps its exact resolved settings, manifest and digests.
   */
  optional?: boolean;
  /** Phase 15.3: display text and Inspector group. */
  label?: string;
  tooltip?: string;
  group?: string;
}

/** The six-key M2 gameplay settings registry (§21.4; the fixed M2 table). */
export const M2_SETTINGS_KEYS: readonly SettingsKeySpec[] = [
  // Phase 15.5 reasons (these six are always resolved into the manifest, so they
  // stay the recorded contract values): gravity 2 g — the snappy fall most action
  // games use (1 g feels floaty); a 4 m/s run — an adult's jog; a 7 m/s jump —
  // 1.25 m high at 2 g, clearing obstacles up to chest height of the default
  // 1.8 m character; falls capped at 30 m/s (keeps landings catchable); climbs
  // slopes up to 45° (a steep ramp or hillside), slides on slopes from 30°.
  { key: 'gravity_y', type: 'number', default: -19.62, min: -100, max: -1, unit: 'm/s^2' },
  { key: 'run_speed', type: 'number', default: 4, min: 0, minExclusive: true, max: 50, unit: 'm/s' },
  { key: 'jump_velocity', type: 'number', default: 7, min: 0, max: 50, unit: 'm/s' },
  { key: 'max_fall_speed', type: 'number', default: -30, min: -100, max: 0, maxExclusive: true, unit: 'm/s' },
  { key: 'max_slope_climb_deg', type: 'number', default: 45, min: 0, max: 89.9, unit: 'degrees' },
  { key: 'min_slope_slide_deg', type: 'number', default: 30, min: 0, max: 89.9, unit: 'degrees' },
  // Phase 15.3: engine settings (optional: resolved only when set). Defaults
  // are the values every project ran with before they became data.
  // 120 Hz: two simulation steps per 60 Hz display frame (smooth on common
  // displays, cheap for any 2D scene); 60 halves the cost, 240 halves the
  // step for fast motion.
  { key: 'fixed_step_hz', type: 'number', default: 120, values: [60, 120, 240], integer: true, unit: 'Hz', optional: true, group: 'Engine', label: 'Fixed step', tooltip: 'Simulation steps per second (60, 120 or 240). Timings in seconds keep their length; replays are recorded at one rate.' },
  // 8 voices: enough for overlapping effects in any scene; the engine cap is 32.
  { key: 'audio_voices', type: 'number', default: 8, min: 1, max: 32, integer: true, unit: 'voices', optional: true, group: 'Audio', label: 'Sound voices', tooltip: 'How many sound effects play at once (a new one is dropped while all are busy; at most 32).' },
  // 1 s: a gentle crossfade between two music tracks.
  { key: 'music_fade_s', type: 'number', default: 1, min: 0, max: 10, unit: 's', optional: true, group: 'Audio', label: 'Music fade', tooltip: 'Seconds a music change crossfades (0: cut).' },
  // 0.2 s: a quick blend between two animation roles (idle, run, airborne).
  { key: 'animation_crossfade_s', type: 'number', default: 0.2, min: 0, max: 2, unit: 's', optional: true, group: 'Animation', label: 'Animation blend', tooltip: 'Seconds a model blends between its idle, run and airborne animations (animator transitions set their own).' },
];

/** Phase 15.3: the engine cap on concurrent sound voices (the `audio_voices` setting's maximum). */
export const AUDIO_VOICE_CAP = 32;

const SETTINGS_BY_KEY = new Map(M2_SETTINGS_KEYS.map((s) => [s.key, s]));

function settingsValueError(path: string, spec: SettingsKeySpec, found: unknown): ModelErrorV2 {
  return withFound(
    {
      code: 'field_value',
      path,
      message: `setting "${spec.key}" must be a number within its declared range`,
      expected: spec.values !== undefined ? `one of ${spec.values.join(', ')}` : `${spec.integer === true ? 'integer' : spec.type} within the ${spec.key} range`,
    },
    found,
  );
}

function validateSettings(settings: unknown, path: string, errors: ModelErrorV2[], registry = SETTINGS_BY_KEY): void {
  if (!isPlainObject(settings)) {
    errors.push(fieldType(path, settings, 'object'));
    return;
  }
  const keys = Object.keys(settings);
  if (keys.length > MAX_SETTINGS_KEYS) {
    errors.push(limitsError(path, 'settings_keys', keys.length, MAX_SETTINGS_KEYS, `content.settings may declare at most ${MAX_SETTINGS_KEYS} keys`));
  }
  for (const key of keys) {
    if (!PROPERTY_KEY_RE.test(key)) {
      errors.push(fieldValue(`${path}/${pointerSegment(key)}`, key, '^[a-z][a-z0-9_]{0,63}$', 'setting keys must match the declared key syntax'));
      continue;
    }
    const spec = registry.get(key);
    if (!spec) {
      errors.push(withFound({ code: 'setting_unknown', path: `${path}/${pointerSegment(key)}`, message: `setting "${key}" is not in the M2 settings registry`, expected: `one of: ${[...registry.keys()].join(', ')}` }, key));
      continue;
    }
    const value = settings[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(settingsValueError(`${path}/${pointerSegment(key)}`, spec, value));
      continue;
    }
    if (spec.min !== undefined && (spec.minExclusive ? value <= spec.min : value < spec.min)) {
      errors.push(settingsValueError(`${path}/${pointerSegment(key)}`, spec, value));
    } else if (spec.max !== undefined && (spec.maxExclusive ? value >= spec.max : value > spec.max)) {
      errors.push(settingsValueError(`${path}/${pointerSegment(key)}`, spec, value));
    } else if ((spec.integer === true && !Number.isInteger(value)) || (spec.values !== undefined && !spec.values.includes(value))) {
      errors.push(settingsValueError(`${path}/${pointerSegment(key)}`, spec, value));
    }
  }
  const climb = settings['max_slope_climb_deg'];
  const slide = settings['min_slope_slide_deg'];
  if (typeof climb === 'number' && typeof slide === 'number' && slide > climb) {
    errors.push(
      fieldValue(
        `${path}/min_slope_slide_deg`,
        slide,
        'min_slope_slide_deg <= max_slope_climb_deg',
        'min_slope_slide_deg must not exceed max_slope_climb_deg',
      ),
    );
  }
}

// ---- trust (§22.5) ------------------------------------------------------------

function validateTrust(trust: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(trust)) {
    errors.push(fieldType(path, trust, 'object'));
    return;
  }
  const entries = trust['entries'];
  if (entries === undefined) errors.push(fieldMissing(`${path}/entries`, 'entries'));
  else if (!Array.isArray(entries)) errors.push(fieldType(`${path}/entries`, entries, 'array'));
  else {
    if (entries.length > MAX_TRUST_ENTRIES) {
      errors.push(limitsError(`${path}/entries`, 'trust_entries', entries.length, MAX_TRUST_ENTRIES, `behaviorTrust may hold at most ${MAX_TRUST_ENTRIES} entries`));
    }
    let prev: string | null = null;
    const seen = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const epath = `${path}/entries/${i}`;
      if (!isPlainObject(e)) {
        errors.push(fieldType(epath, e, 'object'));
        continue;
      }
      const digest = e['sourceDigest'];
      if (digest === undefined) errors.push(fieldMissing(`${epath}/sourceDigest`, 'sourceDigest'));
      else if (typeof digest !== 'string') errors.push(fieldType(`${epath}/sourceDigest`, digest, 'string'));
      else if (!DIGEST_RE.test(digest)) errors.push(digestError(`${epath}/sourceDigest`, digest));
      else {
        if (seen.has(digest)) errors.push(withFound({ code: 'id_duplicate', path: `${epath}/sourceDigest`, message: 'trust entries must be unique by sourceDigest', expected: 'unique ascending sourceDigest' }, digest));
        seen.add(digest);
        if (prev !== null && digest <= prev) {
          errors.push(withFound({ code: 'digest_invalid', path: `${epath}/sourceDigest`, message: 'trust entries must be ascending by sourceDigest', expected: 'ascending sourceDigest' }, digest));
        }
        prev = digest;
      }
      const rev = e['acknowledgedRevision'];
      if (rev === undefined) errors.push(fieldMissing(`${epath}/acknowledgedRevision`, 'acknowledgedRevision'));
      else if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0 || rev > Number.MAX_SAFE_INTEGER) {
        errors.push(withFound({ code: 'number_out_of_range', path: `${epath}/acknowledgedRevision`, message: 'acknowledgedRevision must be an integer >= 0', expected: 'integer >= 0' }, rev));
      }
      for (const k of Object.keys(e)) {
        if (!KNOWN_TRUST_ENTRY_FIELDS.has(k)) errors.push(unexpectedField(`${epath}/${pointerSegment(k)}`, k, 'sourceDigest, acknowledgedRevision'));
      }
    }
  }
  for (const k of Object.keys(trust)) {
    if (!KNOWN_TRUST_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'entries'));
  }
}

// ---- canonicalization ---------------------------------------------------------

function sortedRecord<T>(items: T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0));
}

function canonicalRecipe(r: ImportRecipe): ImportRecipe {
  const toolchain: Record<string, string> = {};
  for (const k of sortedKeys(r.toolchain as unknown as Record<string, unknown>)) {
    toolchain[k] = (r.toolchain as Record<string, string>)[k] as string;
  }
  return {
    profile: r.profile,
    recipeVersion: r.recipeVersion,
    toolchain,
    extensions: [...r.extensions].sort(),
  };
}

/** §18.5/§41.4.3: the `pcm-wav` recipe has no `extensions` key. */
function canonicalAudioRecipe(r: PcmWavRecipe): PcmWavRecipe {
  const toolchain: Record<string, string> = {};
  for (const k of sortedKeys(r.toolchain)) toolchain[k] = r.toolchain[k] as string;
  return { profile: 'pcm-wav', recipeVersion: 1, toolchain };
}

/** §18.6/§41.4.3: the `PcmWavMetrics` member in its exact canonical key order. */
function canonicalAudioMetrics(m: PcmWavMetrics): PcmWavMetrics {
  return {
    container: m.container,
    encoding: m.encoding,
    channels: m.channels,
    sampleRate: m.sampleRate,
    bitsPerSample: m.bitsPerSample,
    frames: m.frames,
    durationMs: m.durationMs,
    pcmBytes: m.pcmBytes,
    dataChunkBytes: m.dataChunkBytes,
    riffChunkBytes: m.riffChunkBytes,
  };
}

function canonicalMetrics(m: AssetMetrics): AssetMetrics {
  const out = {} as AssetMetrics;
  for (const key of METRIC_ORDER) out[key] = m[key];
  // Phase 15.3: optional, last (a version imported before keeps its exact bytes).
  if (m.bounds !== undefined) out.bounds = { min: [m.bounds.min[0], m.bounds.min[1], m.bounds.min[2]], max: [m.bounds.max[0], m.bounds.max[1], m.bounds.max[2]] };
  return out;
}

/** Canonical key order of a `convertedFrom` record. */
function canonicalConvertedFrom(c: ConvertedFrom): ConvertedFrom {
  return {
    format: c.format,
    sourceDigest: c.sourceDigest,
    sourceByteLength: c.sourceByteLength,
    ...(c.sourcePath !== undefined ? { sourcePath: c.sourcePath } : {}),
    converter: { name: c.converter.name, version: c.converter.version },
  };
}

/**
 * §23.7: the kind-aware v3 version canonicalizer. The `audio` member keeps
 * `PcmWavMetrics`/`pcm-wav` (no `extensions` and no GLB metric fields); the
 * `model` member keeps the accepted M2 field set.
 */
function canonicalVersionV3(v: AssetVersionV3, kind: AssetKindV3): AssetVersionV3 {
  const head = {
    version: v.version,
    sourceDigest: v.sourceDigest,
    sourceByteLength: v.sourceByteLength,
    ...(v.sourcePath !== undefined ? { sourcePath: v.sourcePath } : {}),
    ...(v.convertedFrom !== undefined ? { convertedFrom: canonicalConvertedFrom(v.convertedFrom) } : {}),
  };
  const tail = { importedAt: v.importedAt, publishedRevision: v.publishedRevision };
  if (kind === 'music') {
    const r = v.importRecipe as unknown as { toolchain: Record<string, string> };
    const m = v.metrics as unknown as { format: string; channels: number; sampleRate: number; durationMs: number };
    return {
      ...head,
      importRecipe: { profile: 'music', recipeVersion: 1, toolchain: { ...r.toolchain } } as unknown as AssetVersionV3['importRecipe'],
      metrics: { format: m.format, channels: m.channels, sampleRate: m.sampleRate, durationMs: m.durationMs } as unknown as AssetVersionV3['metrics'],
      ...tail,
    };
  }
  if (kind === 'texture') {
    const r = v.importRecipe as unknown as { toolchain: Record<string, string> };
    const m = v.metrics as unknown as { format: string; width: number; height: number; decodedBytes: number };
    return {
      ...head,
      importRecipe: { profile: 'image', recipeVersion: 1, toolchain: { ...r.toolchain } } as unknown as AssetVersionV3['importRecipe'],
      metrics: { format: m.format, width: m.width, height: m.height, decodedBytes: m.decodedBytes } as unknown as AssetVersionV3['metrics'],
      ...tail,
    };
  }
  if (kind === 'audio') {
    return {
      ...head,
      importRecipe: canonicalAudioRecipe(v.importRecipe as PcmWavRecipe),
      metrics: canonicalAudioMetrics(v.metrics as PcmWavMetrics),
      ...tail,
    };
  }
  const model = v as unknown as AssetVersion;
  return {
    ...head,
    importRecipe: canonicalRecipe(model.importRecipe),
    metrics: canonicalMetrics(model.metrics),
    ...tail,
  };
}

/** §23.7: the kind-aware v3 asset canonicalizer (record order is untouched). */
function canonicalAssetV3(a: AssetRecordV3): AssetRecordV3 {
  const kind: AssetKindV3 = a.kind === 'audio' ? 'audio' : a.kind === 'texture' ? 'texture' : a.kind === 'music' ? 'music' : 'model';
  return {
    assetId: a.assetId,
    kind,
    displayName: a.displayName,
    currentVersion: a.currentVersion,
    versions: a.versions.map((v) => canonicalVersionV3(v, kind)),
    ...(a.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
    ...(a.materials !== undefined ? { materials: canonicalMaterialMapping(a.materials) } : {}),
    ...(a.clipsFor !== undefined ? { clipsFor: a.clipsFor } : {}),
  };
}

function canonicalProperty(p: DeclaredProperty): DeclaredProperty {
  const out: DeclaredProperty = {
    key: p.key,
    label: p.label,
    type: p.type,
    default: Array.isArray(p.default) ? [p.default[0], p.default[1], p.default[2]] : p.default,
  };
  if (p.min !== undefined) out.min = p.min;
  if (p.max !== undefined) out.max = p.max;
  if (p.step !== undefined) out.step = p.step;
  if (p.maxLength !== undefined) out.maxLength = p.maxLength;
  if (p.values !== undefined) out.values = [...p.values];
  if (p.bounds !== undefined) out.bounds = { min: [...p.bounds.min], max: [...p.bounds.max] };
  // Phase 15.4: public is the default and is omitted (older declarations stay byte-identical).
  if (p.visibility === 'private') out.visibility = 'private';
  if (p.group !== undefined) out.group = p.group;
  if (p.header !== undefined) out.header = p.header;
  if (p.tooltip !== undefined) out.tooltip = p.tooltip;
  return out;
}

function canonicalBehavior(b: BehaviorRecord): BehaviorRecord {
  return {
    behaviorId: b.behaviorId,
    displayName: b.displayName,
    declaration: { properties: b.declaration.properties.map(canonicalProperty) },
    source:
      b.source === null
        ? null
        : {
            sourceDigest: b.source.sourceDigest,
            sourceByteLength: b.source.sourceByteLength,
            entryPath: b.source.entryPath,
            fileCount: b.source.fileCount,
            manifestDigest: b.source.manifestDigest,
            outputDigest: b.source.outputDigest,
            outputByteLength: b.source.outputByteLength,
            requiredModules: [...b.source.requiredModules],
            ...(b.source.ownedTransforms !== undefined && b.source.ownedTransforms.length > 0 ? { ownedTransforms: [...b.source.ownedTransforms] } : {}),
            ...(b.source.declaredInCode === true ? { declaredInCode: true as const } : {}),
            publishedRevision: b.source.publishedRevision,
          },
    publishedRevision: b.publishedRevision,
  };
}

function canonicalPrefabEntity(e: PrefabEntity): PrefabEntity {
  const components: PrefabEntity['components'] = { transform: canonicalTransform(e.components.transform) };
  if (e.components.model !== undefined) {
    const piece = e.components.model.piece;
    components.model = { asset: { assetId: e.components.model.asset.assetId }, ...(piece !== undefined ? { piece } : {}) };
  }
  if (e.components.box !== undefined) components.box = canonicalBox(e.components.box);
  if (e.components.behavior !== undefined) {
    const values: Record<string, PropertyValue> = {};
    for (const k of Object.keys(e.components.behavior.values)) {
      const v = e.components.behavior.values[k] ?? null;
      values[k] = Array.isArray(v) ? [v[0], v[1], v[2]] : v;
    }
    components.behavior = { behaviorId: e.components.behavior.behaviorId, values };
  }
  // Phase 14.1 (v4): the gameplay components, canonical as on a scene entity.
  const x = e.components;
  if (x.collider !== undefined) components.collider = { shape: canonicalCollider(x.collider), ...(x.collider.oneWay === true ? { oneWay: true as const } : {}) };
  if (x.surface !== undefined) components.surface = canonicalSurface(x.surface);
  if (x.materials !== undefined) components.materials = canonicalMaterialMapping(x.materials);
  if (x.animator !== undefined) components.animator = canonicalAnimatorComponent(x.animator);
  for (const name of PREFAB_BLOCKS) {
    if (x[name] !== undefined) (components as unknown as Record<string, unknown>)[name] = (BLOCK_COMPONENTS[name].canonical as (c: unknown) => unknown)(x[name]);
  }
  return {
    localId: e.localId,
    ...(e.name !== undefined ? { name: e.name } : {}),
    ...(e.parentLocalId !== undefined ? { parentLocalId: e.parentLocalId } : {}),
    components,
  };
}

function canonicalPrefab(d: PrefabDefinition): PrefabDefinition {
  return {
    prefabId: d.prefabId,
    displayName: d.displayName,
    createdRevision: d.createdRevision,
    entityCount: d.entityCount,
    depth: d.depth,
    entities: d.entities.map(canonicalPrefabEntity),
  };
}

function canonicalSettings(s: SettingsMap): SettingsMap {
  const out: SettingsMap = {};
  for (const k of sortedKeys(s as unknown as Record<string, unknown>)) {
    out[k] = (s as Record<string, SettingsMap[string]>)[k] as SettingsMap[string];
  }
  return out;
}

function canonicalTrust(t: BehaviorTrust): BehaviorTrust {
  return {
    entries: sortedRecord(t.entries, (e) => e.sourceDigest).map((e) => ({
      sourceDigest: e.sourceDigest,
      acknowledgedRevision: e.acknowledgedRevision,
    })),
  };
}

// ---- content schemaVersion 3: `audio` kind and `content.game` (§23.4) ---------

function gameError(
  path: string,
  reason: 'field_missing' | 'field_unexpected' | 'field_type' | 'field_value',
  message: string,
  expected: string,
  found?: unknown,
): ModelErrorV2 {
  const e: ModelErrorV2 = { code: 'game_config_invalid', path, message, reason, expected };
  return found === undefined ? e : withFound(e, found);
}

/**
 * §23.4/§23.8 step 7: the bounded `content.game` block fails as one
 * block-level `game_config_invalid` carrying `path` and `reason`, except for
 * the §23.10 numeric bounds (`number_not_finite`/`number_out_of_range`).
 * References inside the block are resolved by the cross-block check, never
 * here. `path` is relative to the content block (`/game`, `/game/cues/goal`, …).
 */
export function validateGameConfig(g: unknown, path: string, errors: ModelErrorV2[], version: 1 | 2 = 1): void {
  if (!isPlainObject(g)) {
    errors.push(gameError(path, 'field_type', 'content.game must be null or a game-configuration object', 'null or object', g));
    return;
  }
  const fields: readonly string[] = version === 2 ? GAME_FIELDS_V2 : GAME_FIELDS;
  const known = version === 2 ? KNOWN_GAME_FIELDS_V2 : KNOWN_GAME_FIELDS;
  for (const k of fields) {
    if (!Object.prototype.hasOwnProperty.call(g, k)) {
      errors.push(gameError(`${path}/${k}`, 'field_missing', `required game field '${k}' is missing`, 'present'));
      return;
    }
  }
  for (const k of Object.keys(g)) {
    if (!known.has(k)) {
      errors.push(gameError(`${path}/${pointerSegment(k)}`, 'field_unexpected', 'unknown game field is not permitted (the block has exactly its bounded keys)', `known fields: ${[...known].join(', ')}`, k));
      return;
    }
  }
  if (g['configVersion'] !== version) {
    errors.push(gameError(`${path}/configVersion`, 'field_value', `configVersion must be exactly ${version} (a shape change is a version change)`, String(version), g['configVersion']));
    return;
  }
  for (const k of ['title', 'objective', 'instructions'] as const) {
    const v = g[k];
    if (typeof v !== 'string') {
      errors.push(gameError(`${path}/${k}`, 'field_type', `${k} must be a plain-text string`, 'string', v));
      return;
    }
    const max = GAME_STRING_BOUNDS[k];
    if (v.length < 1 || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) {
      errors.push(
        gameError(`${path}/${k}`, 'field_value', `${k} must be 1-${max} characters of plain text without control characters`, `string, 1-${max} chars, no control characters`, v),
      );
      return;
    }
  }
  for (const k of ['playerId', 'cameraId', 'spawnId'] as const) {
    const v = g[k];
    if (typeof v !== 'string') {
      errors.push(gameError(`${path}/${k}`, 'field_type', `${k} must be an entity ID string`, 'string', v));
      return;
    }
    if (!ID_RE_V2.test(v)) {
      errors.push(gameError(`${path}/${k}`, 'field_value', `${k} must match the §5.1 ID syntax`, '1-64 chars, ^[a-z0-9][a-z0-9_-]{0,63}$', v));
      return;
    }
  }
  if (version === 1) {
  const level = g['level'];
  if (!isPlainObject(level)) {
    errors.push(gameError(`${path}/level`, 'field_type', 'level must be an object with minX, maxX, minY, maxY', 'object', level));
    return;
  }
  for (const k of ['minX', 'maxX', 'minY', 'maxY'] as const) {
    if (level[k] === undefined) {
      errors.push(gameError(`${path}/level/${k}`, 'field_missing', `required level field '${k}' is missing`, 'present'));
      return;
    }
  }
  for (const k of Object.keys(level)) {
    if (!KNOWN_LEVEL_FIELDS.has(k)) {
      errors.push(gameError(`${path}/level/${pointerSegment(k)}`, 'field_unexpected', 'unknown level field is not permitted', 'minX, maxX, minY, maxY', k));
      return;
    }
  }
  for (const k of ['minX', 'maxX', 'minY', 'maxY'] as const) {
    const v = level[k];
    if (typeof v !== 'number') {
      errors.push(gameError(`${path}/level/${k}`, 'field_type', 'level must hold finite numbers', 'finite number', v));
      return;
    }
    if (!Number.isFinite(v)) {
      errors.push(withFound({ code: 'number_not_finite', path: `${path}/level/${k}`, message: 'number must be finite (non-finite values are not JSON-encodable)', expected: 'finite number' }, v));
      return;
    }
    if (Math.abs(v) > MAX_LEN) {
      errors.push(withFound({ code: 'number_out_of_range', path: `${path}/level/${k}`, message: 'number is outside the allowed range', expected: `|v| <= ${MAX_LEN}` }, v));
      return;
    }
  }
  const minX = level['minX'] as number;
  const maxX = level['maxX'] as number;
  const minY = level['minY'] as number;
  const maxY = level['maxY'] as number;
  if (!(minX < maxX) || !(minY < maxY)) {
    errors.push(gameError(`${path}/level`, 'field_value', 'level must satisfy minX < maxX and minY < maxY', 'minX < maxX and minY < maxY', level));
    return;
  }
  const killY = g['killY'];
  if (killY === undefined) {
    errors.push(gameError(`${path}/killY`, 'field_missing', `required game field 'killY' is missing`, 'present'));
    return;
  }
  if (typeof killY !== 'number') {
    errors.push(gameError(`${path}/killY`, 'field_type', 'killY must be a finite number', 'finite number', killY));
    return;
  }
  if (!Number.isFinite(killY)) {
    errors.push(withFound({ code: 'number_not_finite', path: `${path}/killY`, message: 'number must be finite (non-finite values are not JSON-encodable)', expected: 'finite number' }, killY));
    return;
  }
  if (Math.abs(killY) > MAX_LEN) {
    errors.push(withFound({ code: 'number_out_of_range', path: `${path}/killY`, message: 'number is outside the allowed range', expected: `|v| <= ${MAX_LEN}` }, killY));
    return;
  }
  if (!(killY < maxY)) {
    errors.push(gameError(`${path}/killY`, 'field_value', 'killY must be strictly below level.maxY', `killY < ${maxY}`, killY));
    return;
  }
  }
  const cues = g['cues'];
  if (!isPlainObject(cues)) {
    errors.push(gameError(`${path}/cues`, 'field_type', 'cues must be an object with exactly the five cue keys', 'object', cues));
    return;
  }
  for (const k of CUE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(cues, k)) {
      errors.push(gameError(`${path}/cues/${k}`, 'field_missing', `required cue '${k}' is missing`, 'present (null or an audio assetId)'));
      return;
    }
  }
  for (const k of Object.keys(cues)) {
    if (!KNOWN_CUE_FIELDS.has(k)) {
      errors.push(gameError(`${path}/cues/${pointerSegment(k)}`, 'field_unexpected', 'unknown cue key is not permitted', `known cues: ${CUE_KEYS.join(', ')}`, k));
      return;
    }
  }
  for (const k of CUE_KEYS) {
    const v = cues[k];
    if (v === null) continue;
    if (typeof v !== 'string') {
      errors.push(gameError(`${path}/cues/${k}`, 'field_type', 'a cue must be null or an audio assetId string', 'string or null', v));
      return;
    }
    if (!ID_RE_V2.test(v)) {
      errors.push(gameError(`${path}/cues/${k}`, 'field_value', 'a cue assetId must match the §5.1 ID syntax', '1-64 chars, ^[a-z0-9][a-z0-9_-]{0,63}$', v));
      return;
    }
  }
  // Phase 15.3 (v4): the optional session timing.
  for (const k of GAME_TIMING_FIELDS) {
    const v = g[k];
    const lim = GAME_TIMING_LIMITS[k];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < lim.min || v > lim.max)) {
      errors.push(gameError(`${path}/${k}`, 'field_value', `${k} must be ${lim.min}-${lim.max} seconds`, `a number ${lim.min}-${lim.max}`, v));
      return;
    }
  }
}

/**
 * §23.4/§23.10: the six-key v3 content block. Validated with the accepted
 * v2 inner validators (prefabs/behaviors/settings/trust), the v3 asset-kind
 * discriminator and the bounded `game` block.
 */
function validateContentV3Value(doc: Record<string, unknown>, version: 3 | 4 = 3): { errors: ModelErrorV2[]; doc?: ContentCatalogV3 } {
  const errors: ModelErrorV2[] = [];
  const required = version === 4 ? [...KNOWN_CONTENT_FIELDS_V3, 'scenes', 'startScenes'] : [...KNOWN_CONTENT_FIELDS_V3];
  for (const key of required) {
    if (doc[key] === undefined) errors.push(fieldMissing(`/${pointerSegment(key)}`, key));
  }
  for (const k of Object.keys(doc)) {
    if (!required.includes(k) && k !== 'tags' && !(version === 4 && (k === 'materials' || k === 'environment' || k === 'lighting' || k === 'animators' || k === 'input' || k === 'flow'))) {
      errors.push(unexpectedField(`/${pointerSegment(k)}`, k, [...required, 'tags (optional)', ...(version === 4 ? ['materials (optional)', 'environment (optional)', 'lighting (optional)', 'animators (optional)', 'input (optional)', 'flow (optional)'] : [])].join(', ')));
    }
  }
  if (version === 4 && doc['scenes'] !== undefined) {
    // Phase 12 (c): the scene index — one entry per scene file.
    const scenes = doc['scenes'];
    if (!Array.isArray(scenes)) errors.push(fieldType('/scenes', scenes, 'array of { sceneId, name }'));
    else {
      if (scenes.length < 1 || scenes.length > MAX_SCENES) errors.push(fieldValue('/scenes', scenes.length, `1-${MAX_SCENES} scenes`, 'a project has 1 to 64 scenes'));
      const seen = new Set<string>();
      scenes.forEach((entry, i) => {
        const p = `/scenes/${i}`;
        if (!isPlainObject(entry)) {
          errors.push(fieldType(p, entry, 'object { sceneId, name }'));
          return;
        }
        for (const k of Object.keys(entry)) if (k !== 'sceneId' && k !== 'name') errors.push(unexpectedField(`${p}/${pointerSegment(k)}`, k, 'sceneId, name'));
        const id = entry['sceneId'];
        if (typeof id !== 'string' || !ID_RE_V2.test(id)) errors.push(fieldValue(`${p}/sceneId`, id, '1-64 chars, ^[a-z0-9][a-z0-9_-]{0,63}$', 'a scene id uses the id syntax'));
        else if (seen.has(id)) errors.push(withFound({ code: 'id_duplicate', path: `${p}/sceneId`, message: 'two scenes use the same id', expected: 'a unique scene id' }, id));
        else seen.add(id);
        const name = entry['name'];
        if (typeof name !== 'string' || !isValidName(name)) errors.push(fieldValue(`${p}/name`, name, '1-128 chars, no control characters', 'a scene name is 1-128 characters'));
      });
    }
  }
  if (version === 4 && doc['startScenes'] !== undefined) {
    // Phase 12 (c): the scenes loaded when the game starts.
    const start = doc['startScenes'];
    if (!Array.isArray(start)) errors.push(fieldType('/startScenes', start, 'array of scene ids'));
    else {
      if (start.length < 1 || start.length > MAX_SCENES) errors.push(fieldValue('/startScenes', start.length, `1-${MAX_SCENES} scene ids`, 'the game starts with at least one scene'));
      start.forEach((id, i) => {
        if (typeof id !== 'string') errors.push(fieldType(`/startScenes/${i}`, id, 'string (scene id)'));
        else if (!ID_RE_V2.test(id)) errors.push(fieldValue(`/startScenes/${i}`, id, '1-64 chars, ^[a-z0-9][a-z0-9_-]{0,63}$', 'a scene id uses the id syntax'));
      });
      if (new Set(start).size !== start.length) errors.push(fieldValue('/startScenes', start, 'distinct scene ids', 'a start scene is listed twice'));
      const listed = Array.isArray(doc['scenes']) ? new Set((doc['scenes'] as { sceneId?: unknown }[]).map((e) => e?.sceneId)) : null;
      if (listed !== null) {
        start.forEach((id, i) => {
          if (typeof id === 'string' && !listed.has(id)) errors.push(withFound({ code: 'reference_missing', path: `/startScenes/${i}`, reason: 'scene', message: 'a start scene is not in the scene index', expected: 'a scene id from content.scenes' }, id));
        });
      }
    }
  }

  const assets = doc['assets'];
  let versionRecords = 0;
  if (assets !== undefined) {
    if (!Array.isArray(assets)) errors.push(fieldType('/assets', assets, 'array'));
    else {
      const modelAssets = assets.filter((a) => isPlainObject(a) && a['kind'] !== 'audio' && a['kind'] !== 'texture' && a['kind'] !== 'music').length;
      if (modelAssets > MAX_ASSETS) {
        errors.push(limitsError('/assets', 'assets', modelAssets, MAX_ASSETS, `the catalog may hold at most ${MAX_ASSETS} model assets`));
      }
      let audioAssets = 0;
      let textureAssets = 0;
      let musicAssets = 0;
      const seen = new Set<string>();
      for (let i = 0; i < assets.length; i++) {
        versionRecords += validateAsset(assets[i], `/assets/${i}`, errors, true);
        const a = assets[i];
        if (isPlainObject(a)) {
          if (a['kind'] === 'audio') audioAssets += 1;
          if (a['kind'] === 'texture') textureAssets += 1;
          if (a['kind'] === 'music') musicAssets += 1;
          if (typeof a['assetId'] === 'string') {
            if (seen.has(a['assetId'])) {
              errors.push(withFound({ code: 'id_duplicate', path: `/assets/${i}/assetId`, message: 'assetId is already used by an earlier record (first occurrence wins)', expected: 'a unique assetId' }, a['assetId']));
            } else seen.add(a['assetId']);
          }
        }
      }
      if (musicAssets > MAX_MUSIC_ASSETS) {
        errors.push(limitsError('/assets', 'assets', musicAssets, MAX_MUSIC_ASSETS, `the catalog may hold at most ${MAX_MUSIC_ASSETS} music asset records`));
      }
      if (textureAssets > MAX_TEXTURE_ASSETS) {
        errors.push(limitsError('/assets', 'assets', textureAssets, MAX_TEXTURE_ASSETS, `the catalog may hold at most ${MAX_TEXTURE_ASSETS} texture asset records`));
      }
      if (audioAssets > MAX_AUDIO_ASSETS) {
        errors.push(limitsError('/assets', 'audio_assets', audioAssets, MAX_AUDIO_ASSETS, `the catalog may hold at most ${MAX_AUDIO_ASSETS} audio asset records`));
      }
      if (versionRecords > MAX_VERSION_RECORDS) {
        errors.push(limitsError('/assets', 'version_records', versionRecords, MAX_VERSION_RECORDS, `the catalog may hold at most ${MAX_VERSION_RECORDS} version records`));
      }
    }
  }

  const prefabs = doc['prefabs'];
  if (prefabs !== undefined) {
    if (!Array.isArray(prefabs)) errors.push(fieldType('/prefabs', prefabs, 'array'));
    else {
      if (prefabs.length > MAX_PREFABS) errors.push(limitsError('/prefabs', 'prefabs', prefabs.length, MAX_PREFABS, `the catalog may hold at most ${MAX_PREFABS} prefab definitions`));
      const seen = new Set<string>();
      for (let i = 0; i < prefabs.length; i++) {
        validatePrefabDefinition(prefabs[i], `/prefabs/${i}`, errors, version);
        const d = prefabs[i];
        if (isPlainObject(d) && typeof d['prefabId'] === 'string') {
          if (seen.has(d['prefabId'])) errors.push(withFound({ code: 'id_duplicate', path: `/prefabs/${i}/prefabId`, message: 'prefabId is already used (first occurrence wins)', expected: 'a unique prefabId' }, d['prefabId']));
          else seen.add(d['prefabId']);
        }
        if (isPlainObject(d) && canonicalDocBytes(d) > MAX_PREFAB_BYTES) {
          errors.push(limitsError(`/prefabs/${i}`, 'prefab_bytes', canonicalDocBytes(d), MAX_PREFAB_BYTES, 'canonical prefab definition exceeds the byte cap'));
        }
      }
    }
  }

  const behaviors = doc['behaviors'];
  if (behaviors !== undefined) {
    if (!Array.isArray(behaviors)) errors.push(fieldType('/behaviors', behaviors, 'array'));
    else {
      if (behaviors.length > MAX_BEHAVIORS) errors.push(limitsError('/behaviors', 'behaviors', behaviors.length, MAX_BEHAVIORS, `the catalog may hold at most ${MAX_BEHAVIORS} behavior records`));
      const seen = new Set<string>();
      for (let i = 0; i < behaviors.length; i++) {
        validateBehaviorRecord(behaviors[i], `/behaviors/${i}`, errors);
        const b = behaviors[i];
        if (isPlainObject(b) && typeof b['behaviorId'] === 'string') {
          if (seen.has(b['behaviorId'])) errors.push(withFound({ code: 'id_duplicate', path: `/behaviors/${i}/behaviorId`, message: 'behaviorId is already used (first occurrence wins)', expected: 'a unique behaviorId' }, b['behaviorId']));
          else seen.add(b['behaviorId']);
        }
      }
    }
  }

  const settings = doc['settings'];
  if (settings !== undefined) validateSettings(settings, '/settings', errors);

  // A missing behaviorTrust is reported once, by the required-key check above.
  if (doc['behaviorTrust'] !== undefined) validateTrust(doc['behaviorTrust'], '/behaviorTrust', errors);

  const game = doc['game'];
  if (game !== undefined && game !== null) validateGameConfig(game, '/game', errors, version === 4 ? 2 : 1);

  if (doc['tags'] !== undefined) validateTagRegistry(doc['tags'], '/tags', errors);

  // Phase 9.4 (v4): project materials, the asset default mappings and the environment.
  if (doc['materials'] !== undefined) validateMaterials(doc['materials'], '/materials', errors);
  if (doc['environment'] !== undefined) validateEnvironment(doc['environment'], '/environment', errors);
  if (doc['lighting'] !== undefined) validateLighting(doc['lighting'], '/lighting', errors);
  if (doc['animators'] !== undefined) validateAnimators(doc['animators'], '/animators', errors);
  if (doc['input'] !== undefined) validateInput(doc['input'], '/input', errors);
  if (doc['flow'] !== undefined) validateFlow(doc['flow'], '/flow', errors);
  if (version === 4) validateMaterialReferences(doc, errors);
  else if (Array.isArray(doc['assets'])) {
    // Phase 14.6: clips-only assets are v4 data (v3 projects upgrade on open).
    (doc['assets'] as unknown[]).forEach((a, i) => {
      if (isPlainObject(a) && a['clipsFor'] !== undefined) errors.push(unexpectedField(`/assets/${i}/clipsFor`, 'clipsFor', 'clipsFor is v4 data'));
    });
  }

  if (errors.length > 0) return { errors };
  const canonical = canonicalContentV3(doc as unknown as ContentCatalogV3);
  if (version === 4) {
    (canonical as ContentCatalogV4).scenes = (doc['scenes'] as { sceneId: string; name: string }[]).map((e) => ({ sceneId: e.sceneId, name: e.name }));
    (canonical as ContentCatalogV4).startScenes = [...(doc['startScenes'] as string[])];
  }
  if (canonical.game !== null && canonicalDocBytes(canonical.game) > MAX_GAME_BYTES) {
    return { errors: [limitsError('/game', 'game_bytes', canonicalDocBytes(canonical.game), MAX_GAME_BYTES, 'canonical content.game exceeds the byte cap')] };
  }
  if (canonicalDocBytes(canonical) > MAX_CONTENT_BYTES) {
    return { errors: [limitsError('/content', 'content_bytes', canonicalDocBytes(canonical), MAX_CONTENT_BYTES, 'canonical content block exceeds the byte cap')] };
  }
  return { errors, doc: canonical };
}

/** Phase 12 (b): a tag name — a letter, then letters, digits, `_` or `-`; 1–32 characters. */
export const TAG_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/**
 * Phase 12 (b): the tag registry — at most 32 `{ bit, name }` entries, each
 * bit 0–31 used once, names unique ignoring case.
 */
export function validateTagRegistry(tags: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(tags)) {
    errors.push(fieldType(path, tags, 'array of { bit, name }'));
    return;
  }
  if (tags.length > MAX_TAGS) {
    errors.push(limitsError(path, 'tags', tags.length, MAX_TAGS, `a project may define at most ${MAX_TAGS} tags`));
  }
  const bits = new Set<number>();
  const names = new Set<string>();
  tags.forEach((t, i) => {
    const p = `${path}/${i}`;
    if (!isPlainObject(t)) {
      errors.push(fieldType(p, t, 'object { bit, name }'));
      return;
    }
    for (const k of Object.keys(t)) if (k !== 'bit' && k !== 'name') errors.push(unexpectedField(`${p}/${pointerSegment(k)}`, k, 'bit, name'));
    const bit = t['bit'];
    if (bit === undefined) errors.push(fieldMissing(`${p}/bit`, 'bit'));
    else if (typeof bit !== 'number' || !Number.isInteger(bit) || bit < 0 || bit > 31) {
      errors.push(fieldValue(`${p}/bit`, bit, 'integer 0-31', 'a tag bit is an integer from 0 to 31'));
    } else if (bits.has(bit)) {
      errors.push(withFound({ code: 'id_duplicate', path: `${p}/bit`, message: 'another tag already uses this bit', expected: 'a unique bit' }, bit));
    } else bits.add(bit);
    const name = t['name'];
    if (name === undefined) errors.push(fieldMissing(`${p}/name`, 'name'));
    else if (typeof name !== 'string') errors.push(fieldType(`${p}/name`, name, 'string'));
    else if (!TAG_NAME_RE.test(name)) {
      errors.push(fieldValue(`${p}/name`, name, 'a letter, then letters, digits, _ or -; 1-32 characters', 'tag names are short identifiers'));
    } else if (names.has(name.toLowerCase())) {
      errors.push(withFound({ code: 'id_duplicate', path: `${p}/name`, message: 'another tag already has this name (names ignore case)', expected: 'a unique name' }, name));
    } else names.add(name.toLowerCase());
  });
}

export function canonicalGame(g: GameConfig): GameConfig {
  return {
    configVersion: g.configVersion === 2 ? 2 : 1,
    title: g.title,
    objective: g.objective,
    instructions: g.instructions,
    playerId: g.playerId,
    cameraId: g.cameraId,
    spawnId: g.spawnId,
    // v3 only (configVersion 1): v4 has no level bounds or kill height.
    ...(g.level !== undefined
      ? {
          level: {
            minX: canonNumV3(g.level.minX),
            maxX: canonNumV3(g.level.maxX),
            minY: canonNumV3(g.level.minY),
            maxY: canonNumV3(g.level.maxY),
          },
        }
      : {}),
    ...(g.killY !== undefined ? { killY: canonNumV3(g.killY) } : {}),
    cues: {
      start: g.cues.start,
      jump: g.cues.jump,
      checkpoint: g.cues.checkpoint,
      death: g.cues.death,
      goal: g.cues.goal,
    },
    // Phase 15.3 (v4): the timing comes last (an existing game block keeps its exact canonical bytes).
    ...(g.respawnDelay !== undefined ? { respawnDelay: g.respawnDelay } : {}),
    ...(g.dropThroughTime !== undefined ? { dropThroughTime: g.dropThroughTime } : {}),
    ...(g.settleTime !== undefined ? { settleTime: g.settleTime } : {}),
  };
}

function canonNumV3(n: number): number {
  return n === 0 ? 0 : n;
}

/** §23.7: canonical v3 content block (fixed six-key order, `game` last). */
export function canonicalContentV3(c: ContentCatalogV3): ContentCatalogV3 {
  return {
    assets: sortedRecord(c.assets, (a) => a.assetId).map(canonicalAssetV3),
    prefabs: sortedRecord(c.prefabs, (d) => d.prefabId).map(canonicalPrefab),
    behaviors: sortedRecord(c.behaviors, (b) => b.behaviorId).map(canonicalBehavior),
    settings: canonicalSettings(c.settings),
    behaviorTrust: canonicalTrust(c.behaviorTrust),
    game: c.game === null ? null : canonicalGame(c.game),
    // Phase 12 (c): v4 only — the scene index and the start set.
    ...((c as ContentCatalogV4).scenes !== undefined ? { scenes: (c as ContentCatalogV4).scenes.map((e) => ({ sceneId: e.sceneId, name: e.name })) } : {}),
    ...((c as ContentCatalogV4).startScenes !== undefined ? { startScenes: [...(c as ContentCatalogV4).startScenes] } : {}),
    // Phase 12 (b): present only when the project defines tags.
    ...(c.tags !== undefined && c.tags.length > 0
      ? { tags: [...c.tags].sort((a, b) => a.bit - b.bit).map((t) => ({ bit: t.bit, name: t.name })) }
      : {}),
    // Phase 9.4: present only when there are materials / environment settings.
    ...((c as ContentCatalogV4).materials !== undefined && (c as ContentCatalogV4).materials!.length > 0 ? { materials: canonicalMaterials((c as ContentCatalogV4).materials!) } : {}),
    ...((c as ContentCatalogV4).environment !== undefined ? { environment: canonicalEnvironment((c as ContentCatalogV4).environment!) } : {}),
    // Phase 9.7: present only when there are controllers.
    ...((c as ContentCatalogV4).animators !== undefined && (c as ContentCatalogV4).animators!.length > 0 ? { animators: canonicalAnimators((c as ContentCatalogV4).animators!) } : {}),
    // Phase 9.8: present only when the project has its own input actions.
    ...((c as ContentCatalogV4).input !== undefined ? { input: canonicalInput((c as ContentCatalogV4).input!) } : {}),
    // Phase 9.10: present only when the project has a game flow.
    ...((c as ContentCatalogV4).flow !== undefined ? { flow: canonicalFlow((c as ContentCatalogV4).flow!) } : {}),
    // Phase 9.6: present only when a scene has a bake.
    ...((c as ContentCatalogV4).lighting !== undefined && Object.keys((c as ContentCatalogV4).lighting!).length > 0 ? { lighting: canonicalLighting((c as ContentCatalogV4).lighting!) } : {}),
  };
}

/**
 * Phase 9.4: a material's texture slots name texture assets; an asset's
 * default material mapping (and only a model asset has one) names existing
 * materials.
 */
function validateMaterialReferences(doc: Record<string, unknown>, errors: ModelErrorV2[]): void {
  const assets = Array.isArray(doc['assets']) ? (doc['assets'] as unknown[]).filter(isPlainObject) : [];
  const kindOf = new Map(assets.map((a) => [a['assetId'], a['kind']]));
  const materials = Array.isArray(doc['materials']) ? (doc['materials'] as unknown[]).filter(isPlainObject) : [];
  const materialIds = new Set(materials.map((m) => m['materialId']));
  materials.forEach((m, i) => {
    const textures = m['textures'];
    if (!isPlainObject(textures)) return;
    for (const [slot, id] of Object.entries(textures)) {
      if (kindOf.get(id) !== 'texture') {
        errors.push(withFound({ code: 'asset_reference_missing', path: `/materials/${i}/textures/${pointerSegment(slot)}`, message: 'a material texture slot must name a texture asset of this project', expected: 'a texture assetId' }, id));
      }
    }
  });
  // Phase 9.5: sky images and the grading LUT are texture assets too.
  const env = doc['environment'];
  if (isPlainObject(env)) {
    const refs: [string, unknown][] = [];
    const sky = env['sky'];
    if (isPlainObject(sky)) {
      if (sky['texture'] !== undefined) refs.push(['/environment/sky/texture', sky['texture']]);
      if (Array.isArray(sky['cube'])) sky['cube'].forEach((id, i) => refs.push([`/environment/sky/cube/${i}`, id]));
    }
    const post = env['post'];
    if (isPlainObject(post) && isPlainObject(post['grading']) && post['grading']['lut'] !== undefined) refs.push(['/environment/post/grading/lut', post['grading']['lut']]);
    for (const [p, id] of refs) {
      if (kindOf.get(id) !== 'texture') errors.push(withFound({ code: 'asset_reference_missing', path: p, message: 'this environment image must name a texture asset of this project', expected: 'a texture assetId' }, id));
    }
  }
  // Phase 9.10: the flow's music and logo.
  const flow = doc['flow'];
  if (isPlainObject(flow) && Array.isArray(flow['levels'])) {
    const refs = flowAssetRefs(flow as unknown as GameFlow);
    for (const id of refs.music) {
      if (kindOf.get(id) !== 'music') errors.push(withFound({ code: 'asset_reference_missing', path: '/flow', message: 'flow music must name a music asset of this project', expected: 'a music assetId' }, id));
    }
    // Phase 14.5: the menu sounds are audio assets; a level's ambience audio or music.
    for (const id of refs.menuSounds) {
      if (kindOf.get(id) !== 'audio') errors.push(withFound({ code: 'asset_reference_missing', path: '/flow/sounds', message: 'a menu sound must name an audio asset of this project', expected: 'an audio assetId' }, id));
    }
    for (const id of refs.ambience) {
      if (kindOf.get(id) !== 'audio' && kindOf.get(id) !== 'music') {
        const at = (flow['levels'] as unknown[]).findIndex((l) => isPlainObject(l) && Array.isArray(l['ambience']) && (l['ambience'] as unknown[]).includes(id));
        errors.push(withFound({ code: 'asset_reference_missing', path: at >= 0 ? `/flow/levels/${at}/ambience` : '/flow', message: 'a level ambience must name an audio or music asset of this project', expected: 'an audio or music assetId' }, id));
      }
    }
    const logo = isPlainObject(flow['ui']) ? flow['ui']['logo'] : undefined;
    for (const id of refs.textures) {
      if (kindOf.get(id) === 'texture') continue;
      if (id === logo) errors.push(withFound({ code: 'asset_reference_missing', path: '/flow/ui/logo', message: 'the menu logo must name a texture asset of this project', expected: 'a texture assetId' }, id));
      else {
        // Phase 14.4: a level look's sky image or grading LUT.
        const at = (flow['levels'] as unknown[]).findIndex((l) => isPlainObject(l) && JSON.stringify(l['environment'] ?? null).includes(JSON.stringify(id)));
        errors.push(withFound({ code: 'asset_reference_missing', path: at >= 0 ? `/flow/levels/${at}/environment` : '/flow', message: 'this level look image must name a texture asset of this project', expected: 'a texture assetId' }, id));
      }
    }
  }
  // Phase 9.7: a controller's clips come from model assets of this project.
  if (Array.isArray(doc['animators'])) {
    (doc['animators'] as unknown[]).forEach((c, i) => {
      if (!isPlainObject(c) || !Array.isArray(c['states'])) return;
      for (const id of animatorAssetIds(c as unknown as AnimatorController)) {
        if (kindOf.get(id) !== 'model') errors.push(withFound({ code: 'asset_reference_missing', path: `/animators/${i}/states`, message: 'an animator clip must come from a model asset of this project', expected: 'a model assetId' }, id));
      }
    });
  }
  // Phase 9.6: a bake belongs to a scene of the index; its atlases are texture assets.
  const lighting = doc['lighting'];
  if (isPlainObject(lighting)) {
    const sceneIds = new Set(Array.isArray(doc['scenes']) ? (doc['scenes'] as unknown[]).map((e) => (isPlainObject(e) ? e['sceneId'] : undefined)) : []);
    for (const [sceneId, bake] of Object.entries(lighting)) {
      if (!sceneIds.has(sceneId)) errors.push(withFound({ code: 'reference_missing', reason: 'scene', path: `/lighting/${pointerSegment(sceneId)}`, message: 'a bake belongs to a scene of this project', expected: 'a sceneId of content.scenes' }, sceneId));
      if (!isPlainObject(bake) || !Array.isArray(bake['atlases'])) continue;
      bake['atlases'].forEach((id, i) => {
        if (kindOf.get(id) !== 'texture') errors.push(withFound({ code: 'asset_reference_missing', path: `/lighting/${pointerSegment(sceneId)}/atlases/${i}`, message: 'a lightmap atlas must name a texture asset of this project', expected: 'a texture assetId' }, id));
      });
    }
  }
  // Phase 14.6: "clips for rig of <asset>" names another model of this project that is not itself a clips-only asset.
  assets.forEach((a, i) => {
    const rig = a['clipsFor'];
    if (typeof rig !== 'string') return;
    const target = assets.find((x) => x['assetId'] === rig);
    if (rig === a['assetId']) errors.push(withFound({ code: 'reference_missing', path: `/assets/${i}/clipsFor`, message: 'an asset cannot hold clips for its own rig (absent = its clips are its own)', expected: 'another model assetId' }, rig));
    else if (target === undefined || target['kind'] !== 'model') errors.push(withFound({ code: 'asset_reference_missing', path: `/assets/${i}/clipsFor`, message: 'clipsFor must name a model asset of this project', expected: 'a model assetId' }, rig));
    else if (target['clipsFor'] !== undefined) errors.push(withFound({ code: 'reference_missing', path: `/assets/${i}/clipsFor`, message: 'clipsFor must name a model with its own rig, not another clips-only asset', expected: 'a model assetId without clipsFor' }, rig));
  });
  assets.forEach((a, i) => {
    const mapping = a['materials'];
    if (mapping === undefined) return;
    if (a['kind'] !== 'model') {
      errors.push(unexpectedField(`/assets/${i}/materials`, 'materials', 'only a model asset has a default material mapping'));
      return;
    }
    validateMaterialMapping(mapping, `/assets/${i}/materials`, errors);
    if (!isPlainObject(mapping)) return;
    for (const [slot, id] of Object.entries(mapping)) {
      if (!materialIds.has(id)) errors.push(withFound({ code: 'reference_missing', path: `/assets/${i}/materials/${pointerSegment(slot)}`, message: 'a material mapping names no material of this project', expected: 'a materialId in content.materials' }, id));
    }
  });
}

/** §12.1/§23.4: the explicit v3 content validator. */
export function validateContentV3(doc: unknown): ModelResultV3<ContentCatalogV3> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  const { errors, doc: canonical } = validateContentV3Value(doc);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as ContentCatalogV3 };
}

/**
 * Phase 12 (c): the v4 project content block (`content.json`): v3's keys plus
 * the required `startScenes`, with the v4 game block (configVersion 2).
 */
export function validateContentV4(doc: unknown): ModelResultV3<ContentCatalogV4> {
  if (!isPlainObject(doc)) return fail([fieldType('', doc, 'object')]);
  const { errors, doc: canonical } = validateContentV3Value(doc, 4);
  if (errors.length > 0) return fail(errors);
  return { ok: true, normalized: canonical as ContentCatalogV4 };
}

/** §12.1: validate, then return the new canonical v3 content block (§23.7). */
export function normalizeContentV3(doc: unknown): ModelResultV3<ContentCatalogV3> {
  return validateContentV3(doc);
}

// ---- settings resolution (§21.5) ---------------------------------------------

/** §21.5: `defaults ⊕ content.settings`, validated and deep-frozen. */
export function resolveGameplaySettings(content: unknown): ModelResultV2<GameplaySettings> {
  const errors: ModelErrorV2[] = [];
  const isContentBlock =
    isPlainObject(content) &&
    ['assets', 'prefabs', 'behaviors', 'behaviorTrust'].some((k) =>
      Object.prototype.hasOwnProperty.call(content, k),
    );
  const hasSettingsKey = isPlainObject(content) && Object.prototype.hasOwnProperty.call(content, 'settings');
  const raw: unknown = hasSettingsKey
    ? (content as Record<string, unknown>)['settings']
    : isContentBlock
      ? undefined
      : content;
  if (raw === undefined) {
    errors.push(fieldMissing('/settings', 'settings'));
  } else if (isPlainObject(raw)) {
    validateSettings(raw, '/settings', errors);
  } else {
    errors.push(fieldType('/settings', raw, 'object'));
  }
  if (errors.length > 0) return fail(errors);
  const settingsMap = isPlainObject(raw) ? (raw as SettingsMap) : {};
  const resolved: GameplaySettings = {
    gravity_y: M2_SETTINGS_KEYS[0]!.default,
    run_speed: M2_SETTINGS_KEYS[1]!.default,
    jump_velocity: M2_SETTINGS_KEYS[2]!.default,
    max_fall_speed: M2_SETTINGS_KEYS[3]!.default,
    max_slope_climb_deg: M2_SETTINGS_KEYS[4]!.default,
    min_slope_slide_deg: M2_SETTINGS_KEYS[5]!.default,
  };
  for (const spec of M2_SETTINGS_KEYS) {
    const provided = settingsMap[spec.key];
    if (typeof provided === 'number') {
      (resolved as unknown as Record<string, number>)[spec.key] = provided;
    }
  }
  deepFreeze(resolved);
  return { ok: true, normalized: resolved };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const k of Object.keys(value as Record<string, unknown>)) deepFreeze((value as Record<string, unknown>)[k]);
    Object.freeze(value);
  }
  return value;
}

