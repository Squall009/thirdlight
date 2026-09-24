/**
 * Phase 9.6: baked lighting (lightmaps).
 *
 * `content.lighting` maps a sceneId to that scene's bake: the lightmap atlases
 * (texture assets), where each static entity's lightmap sits in its atlas
 * (`scaleOffset` maps the mesh's UV1 into the atlas), and the hashes of the
 * baked lights and static objects the bake was made from (the editor marks a
 * bake stale when they no longer match; a stale bake is still used).
 *
 * Atlas texels store irradiance / `range`, sRGB-encoded (8-bit PNG); the
 * renderer multiplies by `range`.
 */
import type { ModelErrorV2 } from './errors';

export interface LightingEntry {
  entityId: string;
  /** Index into `atlases`. */
  atlas: number;
  /**
   * UV1 → atlas: `uv * [sx, sy] + [ox, oy]` (the object's UV1 bounding box
   * onto its rectangle, so a piece using part of a shared UV1 atlas scales up).
   */
  scaleOffset: [number, number, number, number];
}

export interface LightingBake {
  bakeId: string;
  /** ISO-8601 time of the bake. */
  createdAt: string;
  source: 'browser' | 'blender';
  /** Irradiance at texel value 1.0. */
  range: number;
  texelsPerMeter: number;
  samples: number;
  bounces: number;
  /** Texture asset ids, one per atlas. */
  atlases: string[];
  entries: LightingEntry[];
  /**
   * The light entities baked in full (mode "baked"): they are not realtime
   * while this bake is used; baked ambient/hemisphere lights still light
   * dynamic objects, lightmapped surfaces ignore them.
   */
  bakedLights: string[];
  /** Hashes of the baked/mixed lights and of the static objects at bake time. */
  lightsHash: string;
  staticsHash: string;
}

export type LightingMap = Record<string, LightingBake>;

export const MAX_LIGHTMAP_ATLASES = 16;
export const MAX_LIGHTMAP_ENTRIES = 4096;
export const MAX_BAKED_LIGHTS = 64;
export const LIGHTMAP_SOURCES = ['browser', 'blender'] as const;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HASH_RE = /^[0-9a-f]{16}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
const num = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const int = (v: unknown, lo: number, hi: number): boolean => num(v, lo, hi) && Number.isInteger(v);

const BAKE_FIELDS = ['bakeId', 'createdAt', 'source', 'range', 'texelsPerMeter', 'samples', 'bounces', 'atlases', 'entries', 'bakedLights', 'lightsHash', 'staticsHash'];

/** One scene's bake (structure and ranges; asset kinds are checked with the content). */
export function validateLightingBake(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'a bake is an object', value);
    return;
  }
  for (const k of Object.keys(value)) if (!BAKE_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown bake field "${k}"`, k, BAKE_FIELDS.join(', '));
  for (const k of BAKE_FIELDS) if (value[k] === undefined) err(errors, 'field_missing', `${path}/${k}`, `"${k}" is required`, undefined, k);
  const v = value;
  if (v['bakeId'] !== undefined && (typeof v['bakeId'] !== 'string' || !ID_RE.test(v['bakeId']))) err(errors, 'field_value', `${path}/bakeId`, 'bakeId is an id (a-z, 0-9, _ and -)', v['bakeId']);
  if (v['createdAt'] !== undefined && (typeof v['createdAt'] !== 'string' || !ISO_RE.test(v['createdAt']))) err(errors, 'field_value', `${path}/createdAt`, 'createdAt is an ISO-8601 UTC time', v['createdAt']);
  if (v['source'] !== undefined && !(LIGHTMAP_SOURCES as readonly unknown[]).includes(v['source'])) err(errors, 'field_value', `${path}/source`, 'source is browser or blender', v['source']);
  if (v['range'] !== undefined && !num(v['range'], 0.25, 64)) err(errors, 'field_value', `${path}/range`, 'range is a number in [0.25, 64]', v['range']);
  if (v['texelsPerMeter'] !== undefined && !num(v['texelsPerMeter'], 1, 256)) err(errors, 'field_value', `${path}/texelsPerMeter`, 'texelsPerMeter is a number in [1, 256]', v['texelsPerMeter']);
  if (v['samples'] !== undefined && !int(v['samples'], 1, 65536)) err(errors, 'field_value', `${path}/samples`, 'samples is an integer in [1, 65536]', v['samples']);
  if (v['bounces'] !== undefined && !int(v['bounces'], 0, 16)) err(errors, 'field_value', `${path}/bounces`, 'bounces is an integer in [0, 16]', v['bounces']);
  for (const k of ['lightsHash', 'staticsHash']) {
    if (v[k] !== undefined && (typeof v[k] !== 'string' || !HASH_RE.test(v[k] as string))) err(errors, 'field_value', `${path}/${k}`, `${k} is 16 lowercase hex digits`, v[k]);
  }
  const atlases = v['atlases'];
  let atlasCount = 0;
  if (atlases !== undefined) {
    if (!Array.isArray(atlases) || atlases.length < 1 || atlases.length > MAX_LIGHTMAP_ATLASES || !atlases.every((a) => typeof a === 'string' && ID_RE.test(a))) {
      err(errors, 'field_value', `${path}/atlases`, `atlases is 1–${MAX_LIGHTMAP_ATLASES} texture asset ids`, atlases);
    } else atlasCount = atlases.length;
  }
  const bakedLights = v['bakedLights'];
  if (bakedLights !== undefined && (!Array.isArray(bakedLights) || bakedLights.length > MAX_BAKED_LIGHTS || !bakedLights.every((a) => typeof a === 'string' && ID_RE.test(a)) || new Set(bakedLights).size !== bakedLights.length)) {
    err(errors, 'field_value', `${path}/bakedLights`, `bakedLights is at most ${MAX_BAKED_LIGHTS} distinct light entity ids`, bakedLights);
  }
  const entries = v['entries'];
  if (entries === undefined) return;
  if (!Array.isArray(entries) || entries.length > MAX_LIGHTMAP_ENTRIES) {
    err(errors, 'field_value', `${path}/entries`, `entries is a list of at most ${MAX_LIGHTMAP_ENTRIES}`, Array.isArray(entries) ? entries.length : entries);
    return;
  }
  const seen = new Set<string>();
  entries.forEach((e, i) => {
    const p = `${path}/entries/${i}`;
    if (!isPlainObject(e)) {
      err(errors, 'field_type', p, 'an entry is an object', e);
      return;
    }
    for (const k of Object.keys(e)) if (!['entityId', 'atlas', 'scaleOffset'].includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown entry field "${k}"`, k, 'entityId, atlas, scaleOffset');
    const id = e['entityId'];
    if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'field_value', `${p}/entityId`, 'entityId is an entity id', id);
    else if (seen.has(id)) err(errors, 'field_value', `${p}/entityId`, 'an entity has at most one lightmap entry', id);
    else seen.add(id);
    if (!int(e['atlas'], 0, Math.max(0, atlasCount - 1))) err(errors, 'field_value', `${p}/atlas`, 'atlas is an index into atlases', e['atlas']);
    const so = e['scaleOffset'];
    if (!Array.isArray(so) || so.length !== 4 || !so.every((x, j) => num(x, j < 2 ? 1e-6 : -4096, 4096))) {
      err(errors, 'field_value', `${p}/scaleOffset`, 'scaleOffset is [sx, sy, ox, oy], scales in (0, 4096], offsets in [-4096, 4096]', so);
    }
  });
}

/** `content.lighting`: sceneId → bake. */
export function validateLighting(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'lighting maps a sceneId to its bake', value);
    return;
  }
  for (const [sceneId, bake] of Object.entries(value)) {
    if (!ID_RE.test(sceneId)) err(errors, 'field_value', `${path}/${sceneId}`, 'lighting keys are scene ids', sceneId);
    validateLightingBake(bake, `${path}/${sceneId}`, errors);
  }
}

export function canonicalLightingBake(b: LightingBake): LightingBake {
  return {
    bakeId: b.bakeId,
    createdAt: b.createdAt,
    source: b.source,
    range: b.range,
    texelsPerMeter: b.texelsPerMeter,
    samples: b.samples,
    bounces: b.bounces,
    atlases: [...b.atlases],
    entries: [...b.entries]
      .sort((x, y) => (x.entityId < y.entityId ? -1 : x.entityId > y.entityId ? 1 : 0))
      .map((e) => ({ entityId: e.entityId, atlas: e.atlas, scaleOffset: [e.scaleOffset[0], e.scaleOffset[1], e.scaleOffset[2], e.scaleOffset[3]] })),
    bakedLights: [...b.bakedLights].sort(),
    lightsHash: b.lightsHash,
    staticsHash: b.staticsHash,
  };
}

export function canonicalLighting(m: LightingMap): LightingMap {
  const out: LightingMap = {};
  for (const k of Object.keys(m).sort()) out[k] = canonicalLightingBake(m[k]!);
  return out;
}
