/**
 * A terrain's edit layers: its heights as a stack combined offline.
 *
 * At the bottom is the ground as sculpted by hand (a tile's `base`, or its
 * `data` while no layer reaches it). Above it come the layers in their
 * listed order, each a function of the heights below it:
 *
 * - **stamps**: heightmap brushes (a texture asset's first channel) placed
 *   with a centre, a size, a turn and a height; added to the ground, or
 *   raising it to (max) or cutting it down to (min) the stamp's shape;
 * - **erosion**: what a hydraulic or thermal run (`terrain-erosion.ts`)
 *   changed, stored per tile as a difference (a blob of 16-bit steps,
 *   {@link encodeTerrainDelta}), so the ground below can be sculpted again
 *   and the channels stay on it, and running it again over a rectangle
 *   replaces only that rectangle's result;
 * - **splines**: every spline that shapes the terrain (`terrain-splines.ts`;
 *   on top when the list names no splines layer, as before layers existed);
 * - **blocks**: block layers standing on the terrain (`terrain-blocks.ts`):
 *   the ground round them follows their border, the ground under them is
 *   cut away or flattened below them, and their paint carries across.
 *
 * A layer can be switched off (`enabled: false`) and weighed (`strength`
 * 0–1: the share of its change kept). The combined heights are what is
 * drawn, collides and ships (`data`); the stack and the hand-made tiles stay
 * in the editor. A terrain without `layers` is one base layer (and splines),
 * exactly as stored before.
 *
 * Every layer changes a sample from the sample below it and its place only
 * (erosion's neighbourhood work happened when it ran; what it stored is per
 * sample), so recombining a rectangle gives the same bytes as recombining
 * everything.
 *
 * Pure and deterministic.
 */
import type { ModelErrorV2 } from './errors';
import type { ScatterRect } from './scatter';
import { validateErosionSettings, type ErosionSettings } from './terrain-erosion';
import type { Heightmap } from './terrain-import';
import type { TerrainSplineLayer, TerrainSplinePaint } from './terrain-splines';
import { TERRAIN_BLOCKS_BLEND_LIMITS, TERRAIN_BLOCKS_MODES, type TerrainBlockSeam, type TerrainBlocksMode } from './terrain-blocks';
import { TERRAIN_HEIGHT_LIMIT, TERRAIN_TILE_COORD_MAX, terrainHeightOf, terrainStepOf, terrainTileKey, type TerrainComponent } from './terrain';
import { ID_RE } from './validate';

export type TerrainLayerKind = 'stamps' | 'erosion' | 'splines' | 'blocks';
export const TERRAIN_LAYER_KINDS: readonly TerrainLayerKind[] = ['stamps', 'erosion', 'splines', 'blocks'];
export type TerrainStampMode = 'add' | 'max' | 'min';
export const TERRAIN_STAMP_MODES: readonly TerrainStampMode[] = ['add', 'max', 'min'];
/** Metres a stamp's side may span. */
export const TERRAIN_STAMP_SIZE_LIMITS = Object.freeze({ min: 0.5, max: 100_000 });
/** The id the splines take in the stack when the list names no splines layer. */
export const TERRAIN_SPLINES_LAYER_ID = 'splines';

/** One heightmap brush placed on the terrain. */
export interface TerrainStamp {
  /** The texture asset whose first channel (16- or 8-bit PNG) is the shape. */
  asset: string;
  /** World centre (x, z). */
  at: [number, number];
  /** Metres along a side (the image is square on the ground whatever its pixels). */
  size: number;
  /** Degrees about +y (as an object's yaw; absent: 0). */
  rotation?: number;
  /** Metres the image's white stands for (negative digs); black is 0. */
  height: number;
  /** add (absent): raised by the shape; max: raised up to it; min: cut down to it. */
  mode?: TerrainStampMode;
  /** max/min: the world height of the shape's 0 (absent: the terrain object's y). */
  y?: number;
  /** The share of the side (0–0.5) over which the stamp fades in from its edges (absent: 0.15). */
  falloff?: number;
}

/** The stamp's edge fade when absent. */
export const TERRAIN_STAMP_FALLOFF_DEFAULT = 0.15;

interface LayerCommon {
  /** Unique within the terrain. */
  id: string;
  name?: string;
  /** Stored only when false: the layer changes nothing until switched on again. */
  enabled?: boolean;
  /** 0–1, the share of the layer's change kept (absent: 1). */
  strength?: number;
}

export interface TerrainStampsLayer extends LayerCommon {
  kind: 'stamps';
  /** Applied in order. */
  stamps: TerrainStamp[];
}

/** One tile's stored erosion difference (a blob named by digest). */
export interface TerrainLayerTileRef {
  x: number;
  z: number;
  data: string;
}

export interface TerrainErosionLayer extends LayerCommon {
  kind: 'erosion';
  /** What its runs changed, per tile (absent tiles: nothing). */
  tiles?: TerrainLayerTileRef[];
  /** The settings it last ran with (the tools offer them again). */
  settings?: ErosionSettings;
}

export interface TerrainSplinesLayer extends LayerCommon {
  kind: 'splines';
}

/** Block layers standing on the terrain (`terrain-blocks.ts`). */
export interface TerrainBlocksLayer extends LayerCommon {
  kind: 'blocks';
  /** The block layer objects the ground meets (absent: every block layer of the scene). */
  blockLayers?: string[];
  /** cut (absent): holes under the blocks; flatten: the ground kept, just under them. */
  mode?: TerrainBlocksMode;
  /** Metres over which the ground round them fades from their border's height and paint to its own (absent: `TERRAIN_BLOCKS_BLEND_DEFAULT`). */
  blend?: number;
  /** Stored only when false: the blocks' paint does not carry across the border. */
  paint?: boolean;
}

export type TerrainLayer = TerrainStampsLayer | TerrainErosionLayer | TerrainSplinesLayer | TerrainBlocksLayer;

const DIGEST_RE = /^[0-9a-f]{64}$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}

const LAYER_KEYS: Readonly<Record<TerrainLayerKind, readonly string[]>> = {
  stamps: ['id', 'name', 'kind', 'enabled', 'strength', 'stamps'],
  erosion: ['id', 'name', 'kind', 'enabled', 'strength', 'tiles', 'settings'],
  splines: ['id', 'name', 'kind', 'enabled', 'strength'],
  blocks: ['id', 'name', 'kind', 'enabled', 'strength', 'blockLayers', 'mode', 'blend', 'paint'],
};
const STAMP_KEYS = ['asset', 'at', 'size', 'rotation', 'height', 'mode', 'y', 'falloff'];

function validateStamp(s: unknown, p: string, errors: ModelErrorV2[]): void {
  if (!isObj(s)) return err(errors, 'field_type', p, 'a stamp is {asset, at, size, rotation?, height, mode?, y?, falloff?}', s);
  for (const k of Object.keys(s)) if (!STAMP_KEYS.includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown stamp field "${k}"`, k);
  if (typeof s['asset'] !== 'string' || !ID_RE.test(s['asset'])) err(errors, 'field_value', `${p}/asset`, 'asset is the texture asset whose first channel is the stamp\'s shape', s['asset']);
  const at = s['at'];
  if (!(Array.isArray(at) && at.length === 2 && at.every((v) => finite(v) && Math.abs(v) <= TERRAIN_HEIGHT_LIMIT * 100))) err(errors, 'field_value', `${p}/at`, 'at is the stamp\'s world centre [x, z]', at);
  const L = TERRAIN_STAMP_SIZE_LIMITS;
  if (!(finite(s['size']) && s['size'] >= L.min && s['size'] <= L.max)) err(errors, 'field_value', `${p}/size`, `size is ${L.min}-${L.max} metres along a side`, s['size']);
  if (s['rotation'] !== undefined && !(finite(s['rotation']) && Math.abs(s['rotation']) <= 360)) err(errors, 'field_value', `${p}/rotation`, 'rotation is degrees about +y (-360 to 360)', s['rotation']);
  if (!(finite(s['height']) && Math.abs(s['height']) <= TERRAIN_HEIGHT_LIMIT)) err(errors, 'field_value', `${p}/height`, `height is the metres the image's white stands for (within ±${TERRAIN_HEIGHT_LIMIT})`, s['height']);
  if (s['mode'] !== undefined && !TERRAIN_STAMP_MODES.includes(s['mode'] as TerrainStampMode)) err(errors, 'field_value', `${p}/mode`, `mode is ${TERRAIN_STAMP_MODES.join(', ')}`, s['mode']);
  if (s['y'] !== undefined && !(finite(s['y']) && Math.abs(s['y']) <= TERRAIN_HEIGHT_LIMIT)) err(errors, 'field_value', `${p}/y`, 'y is the world height of the shape\'s 0', s['y']);
  if (s['falloff'] !== undefined && !(finite(s['falloff']) && s['falloff'] >= 0 && s['falloff'] <= 0.5)) err(errors, 'field_value', `${p}/falloff`, 'falloff is the share of the side the stamp fades over (0-0.5)', s['falloff']);
}

export function validateTerrainLayers(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!Array.isArray(value)) return err(errors, 'field_type', path, 'layers is a list of edit layers [{id, kind: stamps|erosion|splines, …}]', value);
  const ids = new Set<string>();
  let splines = 0;
  value.forEach((l, i) => {
    const p = `${path}/${i}`;
    if (!isObj(l)) return err(errors, 'field_type', p, 'a layer is {id, kind, name?, enabled?, strength?, …}', l);
    const kind = l['kind'] as TerrainLayerKind;
    if (!TERRAIN_LAYER_KINDS.includes(kind)) return err(errors, 'field_value', `${p}/kind`, `kind is ${TERRAIN_LAYER_KINDS.join(', ')}`, l['kind']);
    for (const k of Object.keys(l)) if (!LAYER_KEYS[kind].includes(k)) err(errors, 'field_unexpected', `${p}/${k}`, `unknown ${kind} layer field "${k}"`, k);
    if (typeof l['id'] !== 'string' || !ID_RE.test(l['id'])) err(errors, 'field_value', `${p}/id`, 'id is 1-64 of a-z, 0-9, _ and - (starting with a letter or digit)', l['id']);
    else if (ids.has(l['id'])) err(errors, 'field_value', `${p}/id`, `layer id "${l['id']}" is used twice`, l['id']);
    else ids.add(l['id']);
    if (l['name'] !== undefined && !(typeof l['name'] === 'string' && l['name'].length <= 64)) err(errors, 'field_value', `${p}/name`, 'name is up to 64 characters', l['name']);
    if (l['enabled'] !== undefined && typeof l['enabled'] !== 'boolean') err(errors, 'field_type', `${p}/enabled`, 'enabled is a boolean', l['enabled']);
    if (l['strength'] !== undefined && !(finite(l['strength']) && l['strength'] >= 0 && l['strength'] <= 1)) err(errors, 'field_value', `${p}/strength`, 'strength is 0-1 (the share of the layer\'s change kept)', l['strength']);
    if (kind === 'splines' && ++splines > 1) err(errors, 'field_value', p, 'a terrain has one splines layer', l['id']);
    if (kind === 'stamps') {
      if (!Array.isArray(l['stamps'])) err(errors, 'field_type', `${p}/stamps`, 'stamps is a list of stamps', l['stamps']);
      else l['stamps'].forEach((s, j) => validateStamp(s, `${p}/stamps/${j}`, errors));
    }
    if (kind === 'blocks') {
      const names = l['blockLayers'];
      if (names !== undefined && !(Array.isArray(names) && names.length > 0 && names.every((x) => typeof x === 'string' && ID_RE.test(x)) && new Set(names).size === names.length)) err(errors, 'field_value', `${p}/blockLayers`, 'blockLayers names block layer objects (distinct entity ids; absent: every block layer)', names);
      if (l['mode'] !== undefined && !TERRAIN_BLOCKS_MODES.includes(l['mode'] as TerrainBlocksMode)) err(errors, 'field_value', `${p}/mode`, `mode is ${TERRAIN_BLOCKS_MODES.join(' or ')}`, l['mode']);
      const B = TERRAIN_BLOCKS_BLEND_LIMITS;
      if (l['blend'] !== undefined && !(finite(l['blend']) && l['blend'] >= B.min && l['blend'] <= B.max)) err(errors, 'field_value', `${p}/blend`, `blend is ${B.min}-${B.max} metres`, l['blend']);
      if (l['paint'] !== undefined && typeof l['paint'] !== 'boolean') err(errors, 'field_type', `${p}/paint`, 'paint is a boolean', l['paint']);
    }
    if (kind === 'erosion') {
      if (l['settings'] !== undefined) validateErosionSettings(l['settings'], `${p}/settings`, errors);
      const tiles = l['tiles'];
      if (tiles !== undefined) {
        if (!Array.isArray(tiles)) err(errors, 'field_type', `${p}/tiles`, 'tiles is a list of {x, z, data}', tiles);
        else {
          const seen = new Set<string>();
          tiles.forEach((t, j) => {
            const q = `${p}/tiles/${j}`;
            if (!isObj(t)) return err(errors, 'field_type', q, 'a tile is {x, z, data}', t);
            for (const k of Object.keys(t)) if (k !== 'x' && k !== 'z' && k !== 'data') err(errors, 'field_unexpected', `${q}/${k}`, `unknown tile field "${k}"`, k);
            for (const k of ['x', 'z'] as const) if (!(Number.isInteger(t[k]) && Math.abs(t[k] as number) <= TERRAIN_TILE_COORD_MAX)) err(errors, 'field_value', `${q}/${k}`, `${k} is a whole tile coordinate`, t[k]);
            if (typeof t['data'] !== 'string' || !DIGEST_RE.test(t['data'])) err(errors, 'field_value', `${q}/data`, 'data is the SHA-256 of the tile\'s erosion blob', t['data']);
            const key = terrainTileKey(t['x'] as number, t['z'] as number);
            if (seen.has(key)) err(errors, 'field_value', q, `tile [${key}] is listed twice`, key);
            seen.add(key);
          });
        }
      }
    }
  });
}

function canonicalStamp(s: TerrainStamp): TerrainStamp {
  return {
    asset: s.asset,
    at: [s.at[0], s.at[1]],
    size: s.size,
    ...(s.rotation !== undefined && s.rotation !== 0 ? { rotation: s.rotation } : {}),
    height: s.height,
    ...(s.mode !== undefined && s.mode !== 'add' ? { mode: s.mode } : {}),
    ...(s.y !== undefined ? { y: s.y } : {}),
    ...(s.falloff !== undefined ? { falloff: s.falloff } : {}),
  };
}

export function canonicalTerrainLayers(list: readonly TerrainLayer[]): TerrainLayer[] {
  return list.map((l) => {
    const common = { id: l.id, ...(l.name !== undefined ? { name: l.name } : {}), kind: l.kind, ...(l.enabled === false ? { enabled: false } : {}), ...(l.strength !== undefined && l.strength !== 1 ? { strength: l.strength } : {}) };
    if (l.kind === 'stamps') return { ...common, kind: 'stamps', stamps: l.stamps.map(canonicalStamp) } as TerrainStampsLayer;
    if (l.kind === 'erosion') {
      const tiles = (l.tiles ?? []).map((t) => ({ x: t.x, z: t.z, data: t.data })).sort((a, b) => a.z - b.z || a.x - b.x);
      return { ...common, kind: 'erosion', ...(tiles.length > 0 ? { tiles } : {}), ...(l.settings !== undefined ? { settings: l.settings } : {}) } as TerrainErosionLayer;
    }
    if (l.kind === 'blocks') {
      return { ...common, kind: 'blocks', ...(l.blockLayers !== undefined ? { blockLayers: [...l.blockLayers] } : {}), ...(l.mode !== undefined && l.mode !== 'cut' ? { mode: l.mode } : {}), ...(l.blend !== undefined ? { blend: l.blend } : {}), ...(l.paint === false ? { paint: false } : {}) } as TerrainBlocksLayer;
    }
    return { ...common, kind: 'splines' } as TerrainSplinesLayer;
  });
}

/** The layers in the order they apply: the list, with the splines on top when it names none. */
export function terrainLayerOrder(comp: Pick<TerrainComponent, 'layers'>): TerrainLayer[] {
  const list = comp.layers ?? [];
  return list.some((l) => l.kind === 'splines') ? [...list] : [...list, { id: TERRAIN_SPLINES_LAYER_ID, kind: 'splines' }];
}

/** The world XZ box a stamp covers (its square turned). */
export function terrainStampRect(s: TerrainStamp): ScatterRect {
  const r = ((s.rotation ?? 0) * Math.PI) / 180;
  const half = (s.size / 2) * (Math.abs(Math.cos(r)) + Math.abs(Math.sin(r)));
  return [s.at[0] - half, s.at[1] - half, s.at[0] + half, s.at[1] + half];
}

// ---- erosion differences --------------------------------------------------------------------

const DELTA_MAGIC = [0x54, 0x4c, 0x54, 0x45]; // "TLTE"
const DELTA_HEADER = 8;

/** A tile's erosion difference (16-bit steps per sample) as bytes: "TLTE", version 1, samples a side, then the steps. */
export function encodeTerrainDelta(samples: number, delta: Int16Array): Uint8Array {
  if (delta.length !== samples * samples) throw new Error(`terrain delta: ${delta.length} steps for ${samples}² samples`);
  const out = new Uint8Array(DELTA_HEADER + delta.length * 2);
  out.set(DELTA_MAGIC, 0);
  out[4] = 1;
  const v = new DataView(out.buffer);
  v.setUint16(6, samples, true);
  for (let i = 0; i < delta.length; i++) v.setInt16(DELTA_HEADER + i * 2, delta[i]!, true);
  return out;
}

export function decodeTerrainDelta(bytes: Uint8Array): { samples: number; delta: Int16Array } {
  if (bytes.length < DELTA_HEADER || DELTA_MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('terrain delta: not an erosion blob (TLTE)');
  if (bytes[4] !== 1) throw new Error(`terrain delta: version ${bytes[4]} is not read here`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = v.getUint16(6, true);
  if (bytes.length !== DELTA_HEADER + samples * samples * 2) throw new Error(`terrain delta: ${bytes.length} bytes for ${samples}² samples`);
  const delta = new Int16Array(samples * samples);
  for (let i = 0; i < delta.length; i++) delta[i] = v.getInt16(DELTA_HEADER + i * 2, true);
  return { samples, delta };
}

// ---- the stack --------------------------------------------------------------------------------

/** What the stack reads beside the tiles: stamps' shapes and erosion's stored differences. */
export interface TerrainLayerSources {
  /** A texture asset's shape (null: none — the stamp changes nothing). */
  heightmap(asset: string): Heightmap | null;
  /** An erosion blob's steps (throws when it cannot be read). */
  delta(digest: string): Int16Array;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * One terrain's stack: which tiles its layers reach, and a tile's combined
 * heights from its hand-made ones.
 */
export class TerrainLayerStack {
  readonly order: readonly TerrainLayer[];
  private readonly n: number;
  private readonly sp: number;
  private readonly size: number;
  private readonly range: readonly number[];
  private readonly stampRects: Map<string, ScatterRect[]>;
  private readonly deltaRefs: Map<string, Map<string, string>>;
  private readonly seams: Map<string, TerrainBlockSeam>;

  /** `blocks`: a blocks layer's seam (the block layers it names, read by the caller; null: none to meet). */
  constructor(
    comp: Pick<TerrainComponent, 'tileSamples' | 'spacing' | 'heightRange' | 'layers'>,
    private readonly origin: readonly number[],
    private readonly splines: TerrainSplineLayer,
    private readonly sources: TerrainLayerSources | null,
    blocks?: (layer: TerrainBlocksLayer) => TerrainBlockSeam | null,
  ) {
    this.order = terrainLayerOrder(comp);
    this.n = comp.tileSamples - 1;
    this.sp = comp.spacing;
    this.size = this.n * this.sp;
    this.range = comp.heightRange;
    this.stampRects = new Map(this.order.filter((l): l is TerrainStampsLayer => l.kind === 'stamps').map((l) => [l.id, l.stamps.map(terrainStampRect)]));
    this.deltaRefs = new Map(this.order.filter((l): l is TerrainErosionLayer => l.kind === 'erosion').map((l) => [l.id, new Map((l.tiles ?? []).map((t) => [terrainTileKey(t.x, t.z), t.data]))]));
    this.seams = new Map();
    for (const l of this.order) {
      if (l.kind !== 'blocks' || blocks === undefined) continue;
      const seam = blocks(l);
      if (seam !== null && !seam.empty) this.seams.set(l.id, seam);
    }
  }

  /** The layers that apply (on, with some strength). */
  private live(until?: string): TerrainLayer[] {
    const out: TerrainLayer[] = [];
    for (const l of this.order) {
      if (l.id === until) break;
      if (l.enabled === false || (l.strength ?? 1) <= 0) continue;
      out.push(l);
    }
    return out;
  }

  /** Whether no layer changes anything (splines included). */
  get empty(): boolean {
    return this.splines.empty && this.seams.size === 0 && [...this.stampRects.values()].every((r) => r.length === 0) && [...this.deltaRefs.values()].every((m) => m.size === 0);
  }

  private tileBox(tx: number, tz: number): ScatterRect {
    const x0 = this.origin[0]! + tx * this.size;
    const z0 = this.origin[2]! + tz * this.size;
    return [x0, z0, x0 + this.size, z0 + this.size];
  }

  /** Whether any layer (on or off) reaches tile (tx, tz): then its hand-made form is kept beside it. */
  reaches(tx: number, tz: number): boolean {
    if (this.splines.reaches(tx, tz)) return true;
    const b = this.tileBox(tx, tz);
    for (const rects of this.stampRects.values()) if (rects.some((r) => r[0] <= b[2] && r[2] >= b[0] && r[1] <= b[3] && r[3] >= b[1])) return true;
    const key = terrainTileKey(tx, tz);
    for (const m of this.deltaRefs.values()) if (m.has(key)) return true;
    for (const s of this.seams.values()) if (s.reaches(tx, tz)) return true;
    return false;
  }

  /**
   * Tile (tx, tz)'s heights (16-bit steps) with the layers applied over its
   * hand-made ones — all of them, or (`until`) those below that layer; the
   * same array when nothing changes.
   */
  heights(tx: number, tz: number, authored: Uint16Array, until?: string): Uint16Array {
    let h = authored;
    for (const l of this.order) {
      if (l.id === until) break;
      if (l.enabled === false) continue;
      const k = l.strength ?? 1;
      if (k <= 0) continue;
      if (l.kind === 'splines') {
        const out = this.splines.heights(tx, tz, h);
        h = out === h || k >= 1 ? out : mix(h, out, k);
      } else if (l.kind === 'stamps') h = this.stamps(tx, tz, h, l, k);
      else if (l.kind === 'blocks') h = this.seams.get(l.id)?.heights(tx, tz, h, k) ?? h;
      else h = this.erosion(tx, tz, h, l, k);
    }
    return h;
  }

  /** Tile (tx, tz)'s holes with the blocks layers' cuts over its hand-made ones (the same array, or null, when none). */
  holes(tx: number, tz: number, authored: Uint8Array | null, until?: string): Uint8Array | null {
    let out = authored;
    for (const l of this.live(until)) if (l.kind === 'blocks') out = this.seams.get(l.id)?.holes(tx, tz, out) ?? out;
    return out;
  }

  /**
   * The paint the layers put over tile (tx, tz)'s material rules, in the
   * order they apply: the splines' and the blocks layers' (null: none).
   */
  paint(tx: number, tz: number): TerrainSplinePaint[] | null {
    let out: TerrainSplinePaint[] | null = null;
    for (const l of this.order) {
      // The splines paint wherever their layer stands (their paint is not weighed by it, as before layers existed).
      if (l.kind === 'splines') {
        const p = this.splines.paint(tx, tz);
        if (p !== null) (out ??= []).push(...p);
        continue;
      }
      if (l.kind !== 'blocks' || l.enabled === false) continue;
      const p = this.seams.get(l.id)?.paint(tx, tz, l.strength ?? 1) ?? null;
      if (p !== null) (out ??= []).push(...p);
    }
    return out;
  }

  /** Whether any blocks layer paints. */
  get paints(): boolean {
    return this.order.some((l) => l.kind === 'blocks' && l.enabled !== false && l.paint !== false && this.seams.has(l.id));
  }

  /** Whether a world point lies on or under the footprint of a blocks layer that applies (scatter keeps off it); null: no such layer. */
  coveredTest(): ((x: number, z: number) => boolean) | null {
    const seams = this.live().filter((l) => l.kind === 'blocks').map((l) => this.seams.get(l.id)).filter((s): s is TerrainBlockSeam => s !== undefined);
    if (seams.length === 0) return null;
    return (x, z) => seams.some((s) => s.covered(x, z));
  }

  private erosion(tx: number, tz: number, src: Uint16Array, l: TerrainErosionLayer, k: number): Uint16Array {
    const digest = this.deltaRefs.get(l.id)?.get(terrainTileKey(tx, tz));
    if (digest === undefined || this.sources === null) return src;
    const d = this.sources.delta(digest);
    let out: Uint16Array | null = null;
    for (let i = 0; i < src.length; i++) {
      const v = d[i]!;
      if (v === 0) continue;
      const step = Math.max(0, Math.min(65535, src[i]! + Math.round(v * k)));
      if (step === src[i]) continue;
      out ??= src.slice();
      out[i] = step;
    }
    return out ?? src;
  }

  private stamps(tx: number, tz: number, src: Uint16Array, l: TerrainStampsLayer, k: number): Uint16Array {
    if (this.sources === null) return src;
    const rects = this.stampRects.get(l.id)!;
    const b = this.tileBox(tx, tz);
    const S = this.n + 1;
    const ox = this.origin[0]!;
    const oz = this.origin[2]!;
    const oy = this.origin[1]!;
    let out: Uint16Array | null = null;
    l.stamps.forEach((s, si) => {
      const r = rects[si]!;
      if (r[0] > b[2] || r[2] < b[0] || r[1] > b[3] || r[3] < b[1]) return;
      const map = this.sources!.heightmap(s.asset);
      if (map === null) return;
      const i0 = Math.max(0, Math.ceil((r[0] - b[0]) / this.sp));
      const i1 = Math.min(this.n, Math.floor((r[2] - b[0]) / this.sp));
      const j0 = Math.max(0, Math.ceil((r[1] - b[1]) / this.sp));
      const j1 = Math.min(this.n, Math.floor((r[3] - b[1]) / this.sp));
      const rot = ((s.rotation ?? 0) * Math.PI) / 180;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const fall = s.falloff ?? TERRAIN_STAMP_FALLOFF_DEFAULT;
      const mode = s.mode ?? 'add';
      const zero = (s.y ?? oy) - oy;
      const W = map.width;
      const H = map.height;
      for (let j = j0; j <= j1; j++) {
        // A sample's place from its global index, so a sample two tiles share is measured alike in both.
        const pz = oz + (tz * this.n + j) * this.sp - s.at[1];
        for (let i = i0; i <= i1; i++) {
          const px = ox + (tx * this.n + i) * this.sp - s.at[0];
          // The image's axes on the ground: +x turned by the rotation (as a yaw), +z likewise.
          const u = (px * cos - pz * sin) / s.size + 0.5;
          const v = (px * sin + pz * cos) / s.size + 0.5;
          if (u < 0 || u > 1 || v < 0 || v > 1) continue;
          const edge = Math.min(u, 1 - u, v, 1 - v);
          const mask = fall > 0 && edge < fall ? smooth(edge / fall) : 1;
          if (mask <= 0) continue;
          const fx = u * (W - 1);
          const fz = v * (H - 1);
          const cx = Math.min(W - 2, Math.floor(fx));
          const cz = Math.min(H - 2, Math.floor(fz));
          const ax = fx - cx;
          const az = fz - cz;
          const m = map.samples;
          const at = cz * W + cx;
          const val = ((m[at]! * (1 - ax) + m[at + 1]! * ax) * (1 - az) + (m[at + W]! * (1 - ax) + m[at + W + 1]! * ax) * az) / 65535;
          const idx = j * S + i;
          const cur: Uint16Array = out ?? src;
          const h = terrainHeightOf(this.range, cur[idx]!);
          const shape = val * s.height;
          let next = h;
          if (mode === 'add') next = h + shape * mask * k;
          else {
            const target = zero + shape;
            if ((mode === 'max' && target > h) || (mode === 'min' && target < h)) next = h + (target - h) * mask * k;
          }
          if (next === h) continue;
          const step = terrainStepOf(this.range, next);
          if (step === cur[idx]) continue;
          out ??= src.slice();
          out[idx] = step;
        }
      }
    });
    return out ?? src;
  }
}

function mix(a: Uint16Array, b: Uint16Array, k: number): Uint16Array {
  const out = a.slice();
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out[i] = Math.round(a[i]! + (b[i]! - a[i]!) * k);
  return out;
}

/**
 * The world boxes a change of a terrain's layers from `before` to `after`
 * changes the heights in (empty: none): stamps added, removed or changed;
 * erosion tiles written; a layer switched, weighed, added, removed or moved
 * (all it reaches). `splineRects` are the boxes the splines reach (a
 * splines layer switched or moved).
 */
export function terrainLayerChangeRects(before: readonly TerrainLayer[] | undefined, after: readonly TerrainLayer[] | undefined, tileRect: (x: number, z: number) => ScatterRect, splineRects: () => ScatterRect[], blocksRects: (l: TerrainBlocksLayer) => ScatterRect[] = () => []): ScatterRect[] {
  const a = terrainLayerOrder({ layers: before === undefined ? undefined : [...before] });
  const b = terrainLayerOrder({ layers: after === undefined ? undefined : [...after] });
  const extent = (l: TerrainLayer): ScatterRect[] => (l.kind === 'stamps' ? l.stamps.map(terrainStampRect) : l.kind === 'erosion' ? (l.tiles ?? []).map((t) => tileRect(t.x, t.z)) : l.kind === 'blocks' ? blocksRects(l) : splineRects());
  const out: ScatterRect[] = [];
  const byId = new Map(a.map((l, i) => [l.id, { l, i }]));
  const ids = new Set(b.map((l) => l.id));
  // Where the order changed: everything the moved layers reach (a layer's place decides what it applies over).
  const kept = (list: TerrainLayer[]): string[] => list.filter((l) => byId.has(l.id) && ids.has(l.id)).map((l) => l.id);
  const orderA = kept(a);
  const orderB = kept(b);
  for (const l of a) if (!ids.has(l.id)) out.push(...extent(l));
  b.forEach((l) => {
    const was = byId.get(l.id)?.l;
    if (was === undefined || was.kind !== l.kind) {
      out.push(...extent(l));
      if (was !== undefined) out.push(...extent(was));
      return;
    }
    const moved = orderA.indexOf(l.id) !== orderB.indexOf(l.id);
    const weighed = (was.enabled ?? true) !== (l.enabled ?? true) || (was.strength ?? 1) !== (l.strength ?? 1);
    if (moved || weighed) {
      out.push(...extent(was), ...extent(l));
      return;
    }
    if (l.kind === 'stamps' && was.kind === 'stamps') {
      // Stamps compared as lists: every stamp from the first that differs on (a stamp's place in the list decides what it applies over).
      let k = 0;
      while (k < l.stamps.length && k < was.stamps.length && JSON.stringify(canonicalStamp(l.stamps[k]!)) === JSON.stringify(canonicalStamp(was.stamps[k]!))) k++;
      for (const s of was.stamps.slice(k)) out.push(terrainStampRect(s));
      for (const s of l.stamps.slice(k)) out.push(terrainStampRect(s));
    } else if (l.kind === 'blocks' && was.kind === 'blocks') {
      // Another set of block layers, mode, blend or paint: what it reached and reaches.
      if (JSON.stringify(canonicalTerrainLayers([l])) !== JSON.stringify(canonicalTerrainLayers([was]))) out.push(...extent(was), ...extent(l));
    } else if (l.kind === 'erosion' && was.kind === 'erosion') {
      const old = new Map((was.tiles ?? []).map((t) => [terrainTileKey(t.x, t.z), t.data]));
      const now = new Map((l.tiles ?? []).map((t) => [terrainTileKey(t.x, t.z), t.data]));
      for (const key of new Set([...old.keys(), ...now.keys()])) {
        if (old.get(key) === now.get(key)) continue;
        const [x, z] = key.split(',').map(Number) as [number, number];
        out.push(tileRect(x, z));
      }
    }
  });
  return out;
}

/** Every erosion blob a terrain's layers name (the editor's; never shipped). */
export function terrainLayerTileDigests(comp: Pick<TerrainComponent, 'layers'>): string[] {
  return (comp.layers ?? []).flatMap((l) => (l.kind === 'erosion' ? (l.tiles ?? []).map((t) => t.data) : []));
}
