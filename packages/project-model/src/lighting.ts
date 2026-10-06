/**
 * Baked lighting (lightmaps).
 *
 * `content.lighting` maps a sceneId to that scene's bake: the lightmap atlases
 * (texture assets), where each static entity's lightmap sits in its atlas
 * (`scaleOffset` maps the mesh's UV1 into the atlas), and the hashes of the
 * baked lights and static objects the bake was made from (the editor marks a
 * bake stale when they no longer match; a stale bake is still used).
 *
 * Atlas texels store irradiance / `range`, sRGB-encoded (8-bit PNG); the
 * renderer multiplies by `range`.
 *
 * A scene's probe grids (`probes`, see probe-grids.ts) are baked separately and
 * ride in the same record: a scene with probes and no lightmaps has no
 * atlases and no entries.
 */
import { ID_RE } from './validate';
import { BLOCK_LIMITS, CHUNK_SIZE } from './block-layers';
import type { ModelErrorV2 } from './errors';
import { canonicalProbeBake, validateProbeBake, type ProbeBake } from './probe-grids';

export interface LightingEntry {
  entityId: string;
  /**
   * A block layer's chunk [cx, cz]: the entry is that chunk's lightmap (the
   * entity is the layer). Its UV1 is the chunk's lightmap layout
   * (`chunkLightmapLayout`), and `layout` is that layout's digest at bake
   * time: a chunk whose geometry changed since is drawn without it.
   */
  chunk?: [number, number];
  layout?: string;
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
  /** The scene's baked probe grids (absent: none). */
  probes?: ProbeBake;
}

export type LightingMap = Record<string, LightingBake>;

/** One scene bake's atlases, entries and baked lights: the bake format's own bounds (scalable lighting reworks the bake). */
export const MAX_LIGHTMAP_ATLASES = 16;
export const MAX_LIGHTMAP_ENTRIES = 4096;
export const MAX_BAKED_LIGHTS = 64;
export const LIGHTMAP_SOURCES = ['browser', 'blender'] as const;
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
const OPTIONAL_BAKE_FIELDS = ['probes'];

/** One scene's bake (structure and ranges; asset kinds are checked with the content). */
export function validateLightingBake(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) {
    err(errors, 'field_type', path, 'a bake is an object', value);
    return;
  }
  for (const k of Object.keys(value)) if (!BAKE_FIELDS.includes(k) && !OPTIONAL_BAKE_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown bake field "${k}"`, k, [...BAKE_FIELDS, ...OPTIONAL_BAKE_FIELDS].join(', '));
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
  if (v['probes'] !== undefined) validateProbeBake(v['probes'], `${path}/probes`, errors);
  const atlases = v['atlases'];
  let atlasCount = 0;
  // Without probes a bake is lightmaps, so it has at least one atlas.
  const fewestAtlases = v['probes'] !== undefined ? 0 : 1;
  if (atlases !== undefined) {
    if (!Array.isArray(atlases) || atlases.length < fewestAtlases || atlases.length > MAX_LIGHTMAP_ATLASES || !atlases.every((a) => typeof a === 'string' && ID_RE.test(a))) {
      err(errors, 'field_value', `${path}/atlases`, `atlases is ${fewestAtlases}–${MAX_LIGHTMAP_ATLASES} texture asset ids`, atlases);
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
    for (const k of Object.keys(e)) if (!['entityId', 'chunk', 'layout', 'atlas', 'scaleOffset'].includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown entry field "${k}"`, k, 'entityId, chunk, layout, atlas, scaleOffset');
    const id = e['entityId'];
    const chunk = e['chunk'];
    if (chunk !== undefined && !(Array.isArray(chunk) && chunk.length === 2 && chunk.every((c) => int(c, -BLOCK_LIMITS.coordinateXZ / CHUNK_SIZE, BLOCK_LIMITS.coordinateXZ / CHUNK_SIZE)))) err(errors, 'field_value', `${p}/chunk`, 'chunk is a block layer chunk [cx, cz]', chunk);
    if ((chunk === undefined) !== (e['layout'] === undefined)) err(errors, 'field_value', `${p}/layout`, 'a chunk entry has its layout digest, and only a chunk entry', e['layout']);
    else if (e['layout'] !== undefined && (typeof e['layout'] !== 'string' || !HASH_RE.test(e['layout']))) err(errors, 'field_value', `${p}/layout`, 'layout is 16 lowercase hex digits', e['layout']);
    const key = Array.isArray(chunk) ? `${String(id)}#${chunk.join(',')}` : String(id);
    if (typeof id !== 'string' || !ID_RE.test(id)) err(errors, 'field_value', `${p}/entityId`, 'entityId is an entity id', id);
    else if (seen.has(key)) err(errors, 'field_value', `${p}/entityId`, chunk !== undefined ? 'a chunk has at most one lightmap entry' : 'an entity has at most one lightmap entry', id);
    else seen.add(key);
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
      .sort((x, y) => (x.entityId < y.entityId ? -1 : x.entityId > y.entityId ? 1 : 0) || (x.chunk?.[1] ?? -Infinity) - (y.chunk?.[1] ?? -Infinity) || (x.chunk?.[0] ?? -Infinity) - (y.chunk?.[0] ?? -Infinity))
      .map((e) => ({
        entityId: e.entityId,
        ...(e.chunk !== undefined ? { chunk: [e.chunk[0], e.chunk[1]] as [number, number], layout: e.layout! } : {}),
        atlas: e.atlas,
        scaleOffset: [e.scaleOffset[0], e.scaleOffset[1], e.scaleOffset[2], e.scaleOffset[3]],
      })),
    bakedLights: [...b.bakedLights].sort(),
    lightsHash: b.lightsHash,
    staticsHash: b.staticsHash,
    ...(b.probes !== undefined ? { probes: canonicalProbeBake(b.probes) } : {}),
  };
}

export function canonicalLighting(m: LightingMap): LightingMap {
  const out: LightingMap = {};
  for (const k of Object.keys(m).sort()) out[k] = canonicalLightingBake(m[k]!);
  return out;
}
