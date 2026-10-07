/**
 * The `terrain` component: a heightfield for landscape, a grid of square
 * tiles. Each tile holds `tileSamples × tileSamples` height samples
 * (2ⁿ + 1, so a tile's edge samples are shared with its neighbours and a
 * quadtree halves it cleanly) `spacing` metres apart; tile (x, z) covers
 * [x, x + 1) × [z, z + 1) tile widths from the object's position. The tiles'
 * data (heights, layer weights, holes, hand paint) are content-addressed
 * binary blobs (`terrain-tile.ts`) the component names by digest, like an
 * instance set's buffer: a scene file stays small however large the terrain,
 * and an undo step only points back at the tiles' old digests.
 *
 * Heights are 16-bit steps of `heightRange` (metres above the object's y):
 * a 512 m range is held to 8 mm. A tile without `data` is flat at the step
 * nearest 0 m, unpainted and whole, so a terrain is made by naming its tiles.
 *
 * The terrain is placed by its object's position only (no rotation or scale),
 * as a block layer is: tiles stay axis-aligned squares in the world, which
 * the renderer's quadtree and a heightfield collider need.
 *
 * Pure.
 */
import type { ModelErrorV2 } from './errors';

/** The tile sizes a terrain may use (samples per side, 2ⁿ + 1). */
export const TERRAIN_TILE_SAMPLES: readonly number[] = Object.freeze([17, 33, 65, 129, 257, 513, 1025]);
/** A new terrain's tile size: 256 m tiles at 1 m spacing. */
export const TERRAIN_TILE_SAMPLES_DEFAULT = 257;
/** Metres between samples. */
export const TERRAIN_SPACING_LIMITS = Object.freeze({ min: 0.05, max: 64 });
/** The farthest a height range reaches (metres either way). */
export const TERRAIN_HEIGHT_LIMIT = 100_000;
/**
 * The tile coordinates a terrain may use (either way): a dimension of the
 * grid, not a count — 4,096 tiles of 1,025 samples at 64 m reach far past any
 * view distance.
 */
export const TERRAIN_TILE_COORD_MAX = 4096;
/** The largest stored height step (16 bits). */
export const TERRAIN_HEIGHT_STEPS = 65535;

/**
 * Metres a terrain's finest level reaches from the camera (each coarser level
 * twice as far): the renderer's level-of-detail distance. Absent: the
 * nearest the renderer allows for the tile size, which is also the floor a
 * smaller value is raised to (its levels must stay within one of their
 * neighbours' to meet without cracks).
 */
export const TERRAIN_LOD_DISTANCE_LIMITS = Object.freeze({ min: 1, max: 100_000 });

/** One tile of the grid: its coordinates and, when it is not flat and bare, its data blob's digest. */
export interface TerrainTileRef {
  x: number;
  z: number;
  /** SHA-256 of the tile's blob (absent: flat at 0 m, unpainted, no holes). */
  data?: string;
}

export interface TerrainComponent {
  /** Samples per tile side (2ⁿ + 1, one of `TERRAIN_TILE_SAMPLES`). */
  tileSamples: number;
  /** Metres between samples. */
  spacing: number;
  /** The heights the 16-bit samples span, metres above the object [low, high]. */
  heightRange: [number, number];
  tiles: TerrainTileRef[];
  /** Metres the finest level of detail reaches ({@link TERRAIN_LOD_DISTANCE_LIMITS}; absent: the renderer's nearest). */
  lodDistance?: number;
}

/** The component's fields in canonical order. */
export const TERRAIN_FIELDS: readonly string[] = Object.freeze(['tileSamples', 'spacing', 'heightRange', 'tiles', 'lodDistance']);

const DIGEST_RE = /^[0-9a-f]{64}$/;

function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}) } as ModelErrorV2);
}
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The tile's key in maps (`"x,z"`). */
export const terrainTileKey = (x: number, z: number): string => `${x},${z}`;

export function validateTerrainComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isObj(value)) {
    err(errors, 'field_type', path, 'a terrain is an object { tileSamples, spacing, heightRange, tiles, lodDistance? }', value);
    return;
  }
  for (const k of Object.keys(value)) if (!TERRAIN_FIELDS.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown terrain field "${k}"`, k);
  const n = value['tileSamples'];
  if (n === undefined) err(errors, 'field_missing', `${path}/tileSamples`, 'tileSamples is required');
  else if (!TERRAIN_TILE_SAMPLES.includes(n as number)) err(errors, 'field_value', `${path}/tileSamples`, `tileSamples is one of ${TERRAIN_TILE_SAMPLES.join(', ')} (2^n + 1 samples per tile side)`, n);
  const spacing = value['spacing'];
  if (spacing === undefined) err(errors, 'field_missing', `${path}/spacing`, 'spacing is required');
  else if (!finite(spacing) || spacing < TERRAIN_SPACING_LIMITS.min || spacing > TERRAIN_SPACING_LIMITS.max) err(errors, 'field_value', `${path}/spacing`, `spacing is ${TERRAIN_SPACING_LIMITS.min}-${TERRAIN_SPACING_LIMITS.max} metres between samples`, spacing);
  const range = value['heightRange'];
  if (range === undefined) err(errors, 'field_missing', `${path}/heightRange`, 'heightRange is required');
  else if (!(Array.isArray(range) && range.length === 2 && range.every((v) => finite(v) && Math.abs(v) <= TERRAIN_HEIGHT_LIMIT) && (range[0] as number) < (range[1] as number))) {
    err(errors, 'field_value', `${path}/heightRange`, `heightRange is [low, high] metres (low < high, within ±${TERRAIN_HEIGHT_LIMIT})`, range);
  }
  const lod = value['lodDistance'];
  if (lod !== undefined && !(finite(lod) && lod >= TERRAIN_LOD_DISTANCE_LIMITS.min && lod <= TERRAIN_LOD_DISTANCE_LIMITS.max)) {
    err(errors, 'field_value', `${path}/lodDistance`, `lodDistance is ${TERRAIN_LOD_DISTANCE_LIMITS.min}-${TERRAIN_LOD_DISTANCE_LIMITS.max} metres`, lod);
  }
  const tiles = value['tiles'];
  if (tiles === undefined) {
    err(errors, 'field_missing', `${path}/tiles`, 'tiles is required (a list of {x, z, data?})');
    return;
  }
  if (!Array.isArray(tiles)) {
    err(errors, 'field_type', `${path}/tiles`, 'tiles is a list of {x, z, data?}', tiles);
    return;
  }
  const seen = new Set<string>();
  tiles.forEach((t, i) => {
    const p = `${path}/tiles/${i}`;
    if (!isObj(t)) return err(errors, 'field_type', p, 'a tile is {x, z, data?}', t);
    for (const k of Object.keys(t)) if (k !== 'x' && k !== 'z' && k !== 'data') err(errors, 'field_unexpected', `${p}/${k}`, `unknown tile field "${k}"`, k);
    for (const k of ['x', 'z'] as const) {
      const v = t[k];
      if (!(Number.isInteger(v) && Math.abs(v as number) <= TERRAIN_TILE_COORD_MAX)) err(errors, 'field_value', `${p}/${k}`, `${k} is a whole tile coordinate within ±${TERRAIN_TILE_COORD_MAX}`, v);
    }
    if (t['data'] !== undefined && (typeof t['data'] !== 'string' || !DIGEST_RE.test(t['data']))) err(errors, 'field_value', `${p}/data`, 'data is the SHA-256 of the tile\'s blob (64 lowercase hex)', t['data']);
    const key = terrainTileKey(t['x'] as number, t['z'] as number);
    if (seen.has(key)) err(errors, 'field_value', p, `tile [${key}] is listed twice`, key);
    seen.add(key);
  });
}

/** The component in canonical form (fields in order, tiles sorted by z then x). */
export function canonicalTerrain(c: TerrainComponent): TerrainComponent {
  const tiles = c.tiles.map((t) => ({ x: t.x, z: t.z, ...(t.data !== undefined ? { data: t.data } : {}) }));
  tiles.sort((a, b) => a.z - b.z || a.x - b.x);
  return { tileSamples: c.tileSamples, spacing: c.spacing, heightRange: [c.heightRange[0], c.heightRange[1]], tiles, ...(c.lodDistance !== undefined ? { lodDistance: c.lodDistance } : {}) };
}

/** Metres along one tile side. */
export function terrainTileSize(c: Pick<TerrainComponent, 'tileSamples' | 'spacing'>): number {
  return (c.tileSamples - 1) * c.spacing;
}

/** A stored step's height (metres above the object). */
export function terrainHeightOf(range: readonly number[], step: number): number {
  return range[0]! + (step / TERRAIN_HEIGHT_STEPS) * (range[1]! - range[0]!);
}

/** The step nearest a height (metres above the object), clamped to the range. */
export function terrainStepOf(range: readonly number[], height: number): number {
  const t = (height - range[0]!) / (range[1]! - range[0]!);
  return Math.max(0, Math.min(TERRAIN_HEIGHT_STEPS, Math.round(t * TERRAIN_HEIGHT_STEPS)));
}

/** The step a tile without data holds everywhere: the one nearest 0 m. */
export function terrainFlatStep(range: readonly number[]): number {
  return terrainStepOf(range, 0);
}
