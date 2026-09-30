/**
 * Asset records of the content catalog: import recipes, metrics (model, audio,
 * font, texture), packed and converted sources, versions, and their
 * canonical form.
 */

import { ID_RE } from './validate';
import { canonicalMaterialMapping } from './materials';
import {
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
import type { ModelErrorV2 } from './errors';
import type {
  AssetMetrics,
  AssetVersion,
  ConvertedFrom,
  PackedFrom,
  ImportRecipe,
} from './types-v2';
import { ID_RE_V2 } from './components';
import type { AssetRecordV3, AssetVersionV3 } from './types-v3';
import { AUDIO_PIPELINE_NAME, AUDIO_PIPELINE_VERSION, canonicalAudioMetrics, validateAudioLoadFields, validateAudioMetrics, validateAudioRecipe, type AudioMetrics } from './audio-assets';
import {
  ASSET_LABEL_RE,
  ADDRESS_RE,
  ASSET_METRIC_CAPS,
  M2_GLTF_EXTENSION_ALLOWLIST,
  MAX_ASSET_VERSIONS,
  MAX_AUDIO_VERSIONS,
  MAX_CONVERTED_SOURCE_BYTES,
  MAX_FONT_FAMILY_NAME,
  MAX_FONT_VERSIONS,
  MAX_SOURCE_BYTES,
  MAX_TEXTURE_EDGE,
  MAX_TEXTURE_LAYERS,
  MAX_TEXTURE_VERSIONS,
  MAX_TOTAL_DECODED_BYTES,
} from './content-limits';
import { DIGEST_RE, digestError, isValidSourcePath, limitsError, SEMVER_RE, sortedKeys } from './content-helpers';

type AssetKindV3 = 'model' | 'audio' | 'texture' | 'font';

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

/** A header-only recipe (font, texture) has no `extensions` key. */
const AUDIO_RECIPE_FIELDS = new Set(['profile', 'recipeVersion', 'toolchain']);
const KNOWN_ASSET_FIELDS = new Set(['assetId', 'kind', 'displayName', 'currentVersion', 'versions', 'vertexColors', 'materials', 'clipsFor', 'labels', 'address', 'loadType', 'preload']);
const KNOWN_VERSION_FIELDS = new Set([
  'version',
  'sourceDigest',
  'sourceByteLength',
  'sourcePath',
  'convertedFrom',
  'packedFrom',
  'importRecipe',
  'metrics',
  'importedAt',
  'publishedRevision',
]);
const KNOWN_RECIPE_FIELDS = new Set(['profile', 'recipeVersion', 'toolchain', 'extensions']);

// ---- assets -----------------------------------------------------

function validateImportRecipe(r: unknown, path: string, errors: ModelErrorV2[], kind: AssetKindV3 = 'model'): void {
  const bad = (message: string, found: unknown): void => {
    errors.push(withFound({ code: 'recipe_invalid', path, message, expected: 'a valid import recipe' }, found));
  };
  if (!isPlainObject(r)) {
    errors.push(fieldType(path, r, 'object'));
    return;
  }
  if (kind === 'font') {
    if (r['profile'] !== 'font') bad('a font import recipe profile must be "font"', r['profile']);
    if (r['recipeVersion'] !== 1) bad('a font import recipe version must be exactly 1', r['recipeVersion']);
    const toolchain = r['toolchain'];
    if (!isPlainObject(toolchain) || Object.keys(toolchain).length !== 1 || toolchain[AUDIO_PIPELINE_NAME] !== AUDIO_PIPELINE_VERSION) {
      bad(`the font toolchain must name exactly "${AUDIO_PIPELINE_NAME}" at '${AUDIO_PIPELINE_VERSION}'`, toolchain);
    }
    for (const k of Object.keys(r)) {
      if (!AUDIO_RECIPE_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...AUDIO_RECIPE_FIELDS].join(', ')));
    }
    return;
  }
  if (kind === 'audio') {
    validateAudioRecipe(r, path, errors);
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
      // Only the pinned loader line is accepted; unknown tools are recorded as
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
): void {
  if (!isPlainObject(m)) {
    errors.push(fieldType(path, m, 'object'));
    return;
  }
  if (kind === 'audio') {
    validateAudioMetrics(m, path, errors);
    return;
  }
  if (kind === 'texture') {
    validateTextureMetrics(m, path, errors);
    return;
  }
  if (kind === 'font') {
    validateFontMetrics(m, path, errors);
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
  // The model's axis-aligned bounds in its own space (optional; recorded at import).
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

/** `{format, familyName?}` of a font version. */
function validateFontMetrics(m: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  if (!['ttf', 'otf', 'woff2', 'woff'].includes(m['format'] as string)) {
    errors.push(fieldValue(`${path}/format`, m['format'], '"ttf" | "otf" | "woff2" | "woff"', 'a font is TrueType, OpenType, WOFF2 or WOFF'));
  }
  const name = m['familyName'];
  if (name !== undefined && (typeof name !== 'string' || name.length < 1 || name.length > MAX_FONT_FAMILY_NAME || !isValidName(name))) {
    errors.push(fieldValue(`${path}/familyName`, name, `string, 1-${MAX_FONT_FAMILY_NAME} chars, no control characters`, 'the family name is a short label read from the font'));
  }
  for (const k of Object.keys(m)) {
    if (k !== 'format' && k !== 'familyName') errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'format, familyName'));
  }
}

/**
 * `{format, width, height, decodedBytes}` of a texture version.
 * A KTX2 (Basis Universal) texture adds `codec` (etc1s | uastc)
 * and `levels` (its mip levels, 1–13); `decodedBytes` stays width × height × 4
 * (the budget counts the uncompressed size, an upper bound of the GPU's).
 * A KTX2 texture array adds `layers` (2–{@link MAX_TEXTURE_LAYERS});
 * its `decodedBytes` counts every layer (width × height × 4 × layers).
 */
function validateTextureMetrics(m: Record<string, unknown>, path: string, errors: ModelErrorV2[]): void {
  const ktx2 = m['format'] === 'ktx2';
  if (m['format'] !== 'png' && m['format'] !== 'jpeg' && m['format'] !== 'webp' && !ktx2) {
    errors.push(fieldValue(`${path}/format`, m['format'], '"png" | "jpeg" | "webp" | "ktx2"', 'a texture is a PNG, JPEG, WebP or KTX2 image'));
  }
  if (ktx2) {
    if (m['codec'] !== 'etc1s' && m['codec'] !== 'uastc') errors.push(fieldValue(`${path}/codec`, m['codec'], '"etc1s" | "uastc"', 'a KTX2 texture is Basis Universal ETC1S or UASTC'));
    const levels = m['levels'];
    if (typeof levels !== 'number' || !Number.isInteger(levels) || levels < 1 || levels > 13) errors.push(fieldValue(`${path}/levels`, levels, 'integer 1..13', 'a KTX2 texture has 1-13 mip levels'));
    const layers = m['layers'];
    if (layers !== undefined && (typeof layers !== 'number' || !Number.isInteger(layers) || layers < 2 || layers > MAX_TEXTURE_LAYERS)) {
      errors.push(fieldValue(`${path}/layers`, layers, `integer 2..${MAX_TEXTURE_LAYERS}`, `a texture array has 2-${MAX_TEXTURE_LAYERS} layers (absent: a plain texture)`));
    }
  } else if (m['layers'] !== undefined) errors.push(unexpectedField(`${path}/layers`, 'layers', 'only a KTX2 texture can be a texture array'));
  for (const k of ['width', 'height'] as const) {
    const v = m[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_TEXTURE_EDGE) {
      errors.push(fieldValue(`${path}/${k}`, v, `integer 1..${MAX_TEXTURE_EDGE}`, `texture ${k} must be 1-${MAX_TEXTURE_EDGE} pixels`));
    }
  }
  const layerCount = ktx2 && typeof m['layers'] === 'number' ? m['layers'] : 1;
  if (typeof m['width'] === 'number' && typeof m['height'] === 'number' && m['decodedBytes'] !== m['width'] * m['height'] * 4 * layerCount) {
    errors.push(fieldValue(`${path}/decodedBytes`, m['decodedBytes'], layerCount > 1 ? 'width × height × 4 × layers' : 'width × height × 4', 'decodedBytes is derived from the size'));
  }
  const known = ktx2 ? ['format', 'width', 'height', 'decodedBytes', 'codec', 'levels', 'layers'] : ['format', 'width', 'height', 'decodedBytes'];
  for (const k of Object.keys(m)) {
    if (!known.includes(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, known.join(', ')));
  }
}

/** The KTX2 encodings (color: ETC1S sRGB; normal: UASTC normal map; data: UASTC linear). */
export const KTX2_ENCODINGS = ['color', 'normal', 'data'] as const;
export type Ktx2Encoding = (typeof KTX2_ENCODINGS)[number];

/**
 * `packedFrom` — a KTX2 texture (a texture array when it has
 * several layers) packed at import from texture assets of the project, channel
 * by channel: per layer the four sources of R, G, B and A, each a channel of a
 * texture asset's version (its id and bytes digest) or a constant 0–255.
 */
function validatePackedFrom(v: Record<string, unknown>, path: string, errors: ModelErrorV2[], kind: AssetKindV3): void {
  const pf = v['packedFrom'];
  if (kind !== 'texture') return void errors.push(unexpectedField(path, 'packedFrom', 'only a texture version can be packed'));
  if (v['convertedFrom'] !== undefined) return void errors.push(unexpectedField(path, 'packedFrom', 'a packed version is its own KTX2 file; it has no convertedFrom'));
  if (!isPlainObject(pf)) return void errors.push(fieldType(path, pf, 'object'));
  for (const k of Object.keys(pf)) if (!['layers', 'converter', 'encoding'].includes(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, 'layers, converter, encoding'));
  if (!(KTX2_ENCODINGS as readonly unknown[]).includes(pf['encoding'])) errors.push(fieldValue(`${path}/encoding`, pf['encoding'], '"color" | "normal" | "data"', 'the KTX2 encoding is "color" (ETC1S), "normal" or "data" (UASTC)'));
  const c = pf['converter'];
  if (!isPlainObject(c) || c['name'] !== 'ktx2-encoder' || typeof c['version'] !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(c['version']) || Object.keys(c).length !== 2) {
    errors.push(fieldValue(`${path}/converter`, c, '{ name: "ktx2-encoder", version: "X.Y.Z" }', 'the converter must name ktx2-encoder and its exact version'));
  }
  const layers = pf['layers'];
  if (!Array.isArray(layers) || layers.length < 1 || layers.length > MAX_TEXTURE_LAYERS) return void errors.push(fieldValue(`${path}/layers`, layers, `1-${MAX_TEXTURE_LAYERS} layers`, 'packedFrom.layers lists each layer\'s four channel sources'));
  layers.forEach((layer, i) => {
    const lp = `${path}/layers/${i}`;
    if (!Array.isArray(layer) || layer.length !== 4) return void errors.push(fieldValue(lp, layer, '[R, G, B, A] sources', 'a layer lists its R, G, B and A sources'));
    layer.forEach((src, j) => {
      const sp = `${lp}/${j}`;
      const ok =
        isPlainObject(src) &&
        ((Object.keys(src).length === 1 && Number.isInteger(src['value']) && (src['value'] as number) >= 0 && (src['value'] as number) <= 255) ||
          (Object.keys(src).length === 3 && typeof src['assetId'] === 'string' && ID_RE_ASSET.test(src['assetId']) && typeof src['digest'] === 'string' && DIGEST_RE.test(src['digest']) && ['r', 'g', 'b', 'a'].includes(src['channel'] as string)));
      if (!ok) errors.push(fieldValue(sp, src, '{assetId, digest, channel: r|g|b|a} | {value: 0-255}', 'a channel source is a texture version\'s channel or a constant'));
    });
  });
  const m = v['metrics'];
  if (isPlainObject(m)) {
    if (m['format'] !== 'ktx2') errors.push(fieldValue(`${path}`, m['format'], 'metrics.format "ktx2"', 'a packed texture version holds the KTX2'));
    else if ((typeof m['layers'] === 'number' ? m['layers'] : 1) !== layers.length) errors.push(fieldValue(`${path}/layers`, layers.length, `metrics.layers (${String(m['layers'] ?? 1)})`, 'packedFrom lists one entry per layer of the texture'));
  }
}

/** An asset id (the id syntax of every asset). */
const ID_RE_ASSET = ID_RE;

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
    // A texture version may be a KTX2 encoded from a PNG/JPEG at import.
    const texture = kind === 'texture';
    if (kind !== 'model' && !texture) errors.push(unexpectedField(cpath, 'convertedFrom', 'only a model or texture version can be converted'));
    else if (sourcePath !== undefined) errors.push(unexpectedField(cpath, 'convertedFrom', 'a converted version is stored; it cannot also have a sourcePath'));
    else if (!isPlainObject(converted)) errors.push(fieldType(cpath, converted, 'object'));
    else {
      if (!texture && converted['format'] !== 'fbx') errors.push(fieldValue(`${cpath}/format`, converted['format'], '"fbx"', 'the converted format must be "fbx"'));
      if (texture && converted['format'] !== 'png' && converted['format'] !== 'jpeg') errors.push(fieldValue(`${cpath}/format`, converted['format'], '"png" | "jpeg"', 'a texture is encoded from a PNG or JPEG'));
      if (texture && !(KTX2_ENCODINGS as readonly unknown[]).includes(converted['encoding'])) errors.push(fieldValue(`${cpath}/encoding`, converted['encoding'], '"color" | "normal" | "data"', 'the KTX2 encoding is "color" (ETC1S), "normal" or "data" (UASTC)'));
      if (texture && isPlainObject(v['metrics']) && v['metrics']['format'] !== 'ktx2') errors.push(fieldValue(`${cpath}/format`, v['metrics']['format'], 'metrics.format "ktx2"', 'an encoded texture version holds the KTX2'));
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
      const converterName = texture ? 'ktx2-encoder' : 'blender';
      if (!isPlainObject(c) || c['name'] !== converterName || typeof c['version'] !== 'string' || !/^\d+\.\d+(\.\d+)?$/.test(c['version']) || Object.keys(c).length !== 2) {
        errors.push(fieldValue(`${cpath}/converter`, c, `{ name: "${converterName}", version: "X.Y.Z" }`, `the converter must name ${converterName} and its exact version`));
      }
      const known = texture ? ['format', 'sourceDigest', 'sourceByteLength', 'sourcePath', 'converter', 'encoding'] : ['format', 'sourceDigest', 'sourceByteLength', 'sourcePath', 'converter'];
      for (const k of Object.keys(converted)) {
        if (!known.includes(k)) {
          errors.push(unexpectedField(`${cpath}/${pointerSegment(k)}`, k, known.join(', ')));
        }
      }
    }
  }
  if (v['packedFrom'] !== undefined) validatePackedFrom(v, `${path}/packedFrom`, errors, kind);
  if (v['importRecipe'] === undefined) errors.push(fieldMissing(`${path}/importRecipe`, 'importRecipe'));
  else validateImportRecipe(v['importRecipe'], `${path}/importRecipe`, errors, kind);
  if (v['metrics'] === undefined) errors.push(fieldMissing(`${path}/metrics`, 'metrics'));
  else validateMetrics(v['metrics'], `${path}/metrics`, errors, kind);

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

export function validateAsset(a: unknown, path: string, errors: ModelErrorV2[], v3 = false): number {
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
    if (rawKind !== 'model' && rawKind !== 'audio' && rawKind !== 'texture' && rawKind !== 'font') {
      errors.push(fieldValue(`${path}/kind`, rawKind, '"model" | "audio" | "texture" | "font"', 'the asset kind must be model, audio, texture or font'));
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
    const maxVersions = v3 && kind === 'audio' ? MAX_AUDIO_VERSIONS : v3 && kind === 'texture' ? MAX_TEXTURE_VERSIONS : v3 && kind === 'font' ? MAX_FONT_VERSIONS : MAX_ASSET_VERSIONS;
    if (versions.length < 1 || versions.length > maxVersions) {
      errors.push(
        limitsError(`${path}/versions`, kind === 'audio' ? 'audio_versions' : kind === 'font' ? 'font_versions' : 'asset_versions', versions.length, maxVersions, `an asset record must have 1-${maxVersions} versions`),
      );
    }
    // The file is the asset: a record keeps its current version (and, in a
    // project upgraded from the stored-version format, a version a legacy
    // animation binding still names). Version numbers only count changes, so
    // they ascend but need not be contiguous.
    let ascending = true;
    for (let i = 0; i < versions.length; i++) {
      const v = versions[i];
      const prev = i > 0 ? versions[i - 1] : null;
      if (!isPlainObject(v) || typeof v['version'] !== 'number' || v['version'] < 1 || (isPlainObject(prev) && typeof prev['version'] === 'number' && v['version'] <= prev['version'])) ascending = false;
    }
    if (!ascending) {
      errors.push(
        withFound(
          {
            code: 'asset_version_invalid',
            path: `${path}/versions`,
            message: 'versions must be strictly ascending, each at least 1',
            expected: 'version[i] > version[i - 1] >= 1',
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
  // An animation-only model whose clips play on another model's rig (checked against the catalog in v4).
  const clipsFor = a['clipsFor'];
  if (clipsFor !== undefined) {
    if (!v3 || kind !== 'model') errors.push(unexpectedField(`${path}/clipsFor`, 'clipsFor', 'only a v4 model asset has clipsFor'));
    else if (typeof clipsFor !== 'string' || !ID_RE_V2.test(clipsFor)) errors.push(fieldValue(`${path}/clipsFor`, clipsFor, 'a model assetId', 'clipsFor names the model asset whose rig these clips are for'));
  }
  validateAudioLoadFields(a, path, errors, v3 && kind === 'audio');
  const labels = a['labels'];
  if (labels !== undefined) {
    if (!v3) errors.push(unexpectedField(`${path}/labels`, 'labels', 'only a v3/v4 asset has labels'));
    else if (!isCanonicalLabelList(labels)) {
      errors.push(fieldValue(`${path}/labels`, labels, 'ascending unique labels (a letter or digit, then letters, digits, _ - . /; at most 64)', 'labels are a non-empty ascending list of unique labels'));
    }
  }
  const address = a['address'];
  if (address !== undefined) {
    if (!v3) errors.push(unexpectedField(`${path}/address`, 'address', 'only a v3/v4 asset has an address'));
    else if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
      errors.push(fieldValue(`${path}/address`, address, 'a letter or digit, then letters, digits, _ - . / (at most 128)', 'an address has no spaces or other punctuation'));
    }
  }
  for (const k of Object.keys(a)) {
    if (!KNOWN_ASSET_FIELDS.has(k)) errors.push(unexpectedField(`${path}/${pointerSegment(k)}`, k, [...KNOWN_ASSET_FIELDS].join(', ')));
  }
  return count;
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

function canonicalMetrics(m: AssetMetrics): AssetMetrics {
  const out = {} as AssetMetrics;
  for (const key of METRIC_ORDER) out[key] = m[key];
  // Optional, last (a version imported before keeps its exact bytes).
  if (m.bounds !== undefined) out.bounds = { min: [m.bounds.min[0], m.bounds.min[1], m.bounds.min[2]], max: [m.bounds.max[0], m.bounds.max[1], m.bounds.max[2]] };
  return out;
}

/** Canonical key order of a `packedFrom` record. */
function canonicalPackedFrom(p: PackedFrom): PackedFrom {
  return {
    layers: p.layers.map((l) => l.map((c) => ('value' in c ? { value: c.value } : { assetId: c.assetId, digest: c.digest, channel: c.channel }))),
    converter: { name: p.converter.name, version: p.converter.version },
    encoding: p.encoding,
  };
}

/** Canonical key order of a `convertedFrom` record. */
function canonicalConvertedFrom(c: ConvertedFrom): ConvertedFrom {
  return {
    format: c.format,
    sourceDigest: c.sourceDigest,
    sourceByteLength: c.sourceByteLength,
    ...(c.sourcePath !== undefined ? { sourcePath: c.sourcePath } : {}),
    converter: { name: c.converter.name, version: c.converter.version },
    // A KTX2 texture's encoding.
    ...('encoding' in c ? { encoding: c.encoding } : {}),
  } as ConvertedFrom;
}

/**
 * The kind-aware v3 version canonicalizer. The header-only kinds (audio,
 * font, texture) have no `extensions` and no GLB metric fields; the `model`
 * member keeps the v2 field set.
 */
function canonicalVersionV3(v: AssetVersionV3, kind: AssetKindV3): AssetVersionV3 {
  const head = {
    version: v.version,
    sourceDigest: v.sourceDigest,
    sourceByteLength: v.sourceByteLength,
    ...(v.sourcePath !== undefined ? { sourcePath: v.sourcePath } : {}),
    ...(v.convertedFrom !== undefined ? { convertedFrom: canonicalConvertedFrom(v.convertedFrom) } : {}),
    // A packed texture's channel sources.
    ...(v.packedFrom !== undefined ? { packedFrom: canonicalPackedFrom(v.packedFrom) } : {}),
  };
  const tail = { importedAt: v.importedAt, publishedRevision: v.publishedRevision };
  if (kind === 'font') {
    const r = v.importRecipe as unknown as { toolchain: Record<string, string> };
    const m = v.metrics as unknown as { format: string; familyName?: string };
    return {
      ...head,
      importRecipe: { profile: 'font', recipeVersion: 1, toolchain: { ...r.toolchain } } as unknown as AssetVersionV3['importRecipe'],
      metrics: { format: m.format, ...(m.familyName !== undefined ? { familyName: m.familyName } : {}) } as unknown as AssetVersionV3['metrics'],
      ...tail,
    };
  }
  if (kind === 'audio') {
    const r = v.importRecipe as unknown as { toolchain: Record<string, string> };
    return {
      ...head,
      importRecipe: { profile: 'audio', recipeVersion: 1, toolchain: { ...r.toolchain } } as unknown as AssetVersionV3['importRecipe'],
      metrics: canonicalAudioMetrics(v.metrics as unknown as AudioMetrics) as unknown as AssetVersionV3['metrics'],
      ...tail,
    };
  }
  if (kind === 'texture') {
    const r = v.importRecipe as unknown as { toolchain: Record<string, string> };
    const m = v.metrics as unknown as { format: string; width: number; height: number; decodedBytes: number; codec?: string; levels?: number; layers?: number };
    return {
      ...head,
      importRecipe: { profile: 'image', recipeVersion: 1, toolchain: { ...r.toolchain } } as unknown as AssetVersionV3['importRecipe'],
      // A KTX2's codec and mip levels last.
      metrics: { format: m.format, width: m.width, height: m.height, decodedBytes: m.decodedBytes, ...(m.codec !== undefined ? { codec: m.codec } : {}), ...(m.levels !== undefined ? { levels: m.levels } : {}), ...(m.layers !== undefined ? { layers: m.layers } : {}) } as unknown as AssetVersionV3['metrics'],
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

/** The kind-aware v3 asset canonicalizer (record order is untouched). */
export function canonicalAssetV3(a: AssetRecordV3): AssetRecordV3 {
  const kind: AssetKindV3 = a.kind === 'audio' ? 'audio' : a.kind === 'texture' ? 'texture' : a.kind === 'font' ? 'font' : 'model';
  return {
    assetId: a.assetId,
    kind,
    displayName: a.displayName,
    currentVersion: a.currentVersion,
    versions: a.versions.map((v) => canonicalVersionV3(v, kind)),
    ...(a.vertexColors === 'tint' ? { vertexColors: 'tint' as const } : {}),
    ...(a.materials !== undefined ? { materials: canonicalMaterialMapping(a.materials) } : {}),
    ...(a.clipsFor !== undefined ? { clipsFor: a.clipsFor } : {}),
    ...(a.loadType !== undefined ? { loadType: a.loadType } : {}),
    ...(a.preload === false ? { preload: false as const } : {}),
    ...(a.labels !== undefined ? { labels: [...a.labels] } : {}),
    ...(a.address !== undefined ? { address: a.address } : {}),
  };
}

/** Whether a value is one asset label. */
export function isAssetLabel(v: unknown): v is string {
  return typeof v === 'string' && ASSET_LABEL_RE.test(v);
}

/** A label list as records store it: ascending by code unit, without duplicates. */
export function canonicalLabels(labels: readonly string[]): string[] {
  return [...new Set(labels)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

function isCanonicalLabelList(v: unknown): boolean {
  if (!Array.isArray(v) || v.length === 0 || !v.every(isAssetLabel)) return false;
  for (let i = 1; i < v.length; i++) if (!((v[i - 1] as string) < (v[i] as string))) return false;
  return true;
}