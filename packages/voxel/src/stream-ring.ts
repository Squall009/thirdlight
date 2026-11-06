/**
 * The streaming ring and the memory budget: which chunks should be loaded
 * around a focus point, and what the loaded ones may cost.
 *
 * - **Ring.** A chunk is wanted when its centre is within the load radius
 *   horizontally and within the load height vertically of the focus, and
 *   it stays until it is past the (larger) unload radius or height: the gap
 *   is the hysteresis that keeps a focus moving back and forth across a
 *   chunk edge from loading and unloading the same chunks.
 * - **Budget.** One budget in bytes per tier covers everything the
 *   streamer keeps per chunk (the store's arrays, its bookkeeping, every
 *   derived result registered against it) plus the open region tables.
 *   There is no chunk count limit: a world of mostly air or uniform chunks
 *   simply fits more of them.
 *
 * Distances are in cells (0.5 m), measured from a focus in cell units.
 */
import { chunkInWorld, type ChunkGrid } from './coords';

export interface StreamRing {
  /** Horizontal radius (cells) within which chunks are loaded. */
  readonly loadRadius: number;
  /** Horizontal radius (cells) past which loaded chunks are unloaded (≥ loadRadius). */
  readonly unloadRadius: number;
  /** Vertical half-height (cells) within which chunks are loaded. */
  readonly loadHeight: number;
  /** Vertical half-height (cells) past which loaded chunks are unloaded (≥ loadHeight). */
  readonly unloadHeight: number;
  /** Horizontal radius (cells) inside which loads go in the `near` lane; past it, `far`. */
  readonly nearRadius: number;
}

/**
 * The default ring: voxel data loaded 192 m around the focus and 96 m above
 * and below it, kept to 224 m and 128 m (two 16 m chunks of hysteresis),
 * near work within 96 m. Full detail is drawn to about 150 m (the plan's
 * LOD table); what lies beyond comes from the chunk tree, not from here.
 */
export const DEFAULT_STREAM_RING: StreamRing = Object.freeze({ loadRadius: 384, unloadRadius: 448, loadHeight: 192, unloadHeight: 256, nearRadius: 192 });

/**
 * The default collision ring (cells): loaded chunks get physics bodies only
 * within 48 m horizontally and 24 m vertically of a focus, since characters
 * and scripts touch the ground near them while the far ring is only drawn;
 * physics memory then follows the ring, not the whole loaded area.
 */
export const DEFAULT_COLLISION_RING: Readonly<{ radius: number; height: number }> = Object.freeze({ radius: 96, height: 48 });

/**
 * A level of the chunk tree the streamer keeps derived nodes of
 * (voxel-mips.ts): level L ≥ 1 within `radius` cells (horizontal box
 * distance from the focus to the node).
 */
export interface MipRing {
  readonly level: number;
  readonly radius: number;
}

/** The coarser levels a streamer keeps derived by default: level 1 (1 m cells) and level 2 (2 m cells). */
export const DEFAULT_MIP_LEVELS: readonly number[] = Object.freeze([1, 2]);

/**
 * The levels kept derived for a load ring: each of {@link DEFAULT_MIP_LEVELS}
 * to the load radius. Level 1 reaches the load ring although it is drawn
 * only to its own ring: a level-2 node is complete only where the chunks a
 * level-1 node round it hold are resident (about 100 m out in a 192 m ring),
 * so past that level 1 stands in for it (lod-select.ts). Nodes exist only
 * over resident chunks, so no level reaches past the load ring.
 */
export function mipRingsFor(ring: Pick<StreamRing, 'loadRadius'>): MipRing[] {
  return DEFAULT_MIP_LEVELS.map((level) => Object.freeze({ level, radius: ring.loadRadius }));
}

/** The levels kept derived for the default ring. */
export const DEFAULT_MIP_RINGS: readonly MipRing[] = Object.freeze(mipRingsFor(DEFAULT_STREAM_RING));

/**
 * Where the levels are drawn by default (cells, horizontal box distance from
 * the nearest focus; lod-select.ts): level 0 within 64 m, level 1 within
 * 128 m, level 2 past it, with 8 m of hysteresis. Level 0 covers the default
 * collision ring and its hysteresis (56 m), so what a character touches is
 * what is drawn.
 */
export const DEFAULT_LEVEL_RINGS: Readonly<{ radii: readonly number[]; hysteresis: number }> = Object.freeze({ radii: Object.freeze([128, 256]), hysteresis: 16 });

/** Cells past its ring's radius a node's derived result is kept, so a focus moving back and forth does not drop and rebuild it (8 m). */
export const MIP_RING_HYSTERESIS_CELLS = 16;

/** Quality tiers with a streaming budget of their own. */
export type StreamTier = 'low' | 'medium' | 'high';

const MIB = 1024 * 1024;

/**
 * The streaming memory budget per tier (bytes): one number covering voxel
 * chunks, derived data and open region tables. Low is the Iris Xe floor.
 */
export const VOXEL_STREAM_BUDGET_BYTES: Readonly<Record<StreamTier, number>> = Object.freeze({ low: 256 * MIB, medium: 512 * MIB, high: 1024 * MIB });

/**
 * How much a tier scales every ring distance a world sets (load, collision,
 * the levels) by default: the square root of its budget over the medium
 * tier's, so the area a tier loads grows as its budget does (low 0.71,
 * medium 1, high 1.41). Medium is 1: the default distances were measured on
 * the Iris Xe, an integrated GPU, which starts at the medium tier.
 */
export const VOXEL_RING_SCALES: Readonly<Record<StreamTier, number>> = Object.freeze({
  low: Math.sqrt(VOXEL_STREAM_BUDGET_BYTES.low / VOXEL_STREAM_BUDGET_BYTES.medium),
  medium: 1,
  high: Math.sqrt(VOXEL_STREAM_BUDGET_BYTES.high / VOXEL_STREAM_BUDGET_BYTES.medium),
});

/**
 * Bookkeeping bytes per resident chunk, air ones included: its entry in the
 * store's index and the streamer's own state (a map entry and a small
 * object). An estimate, so the budget is never blind to many tiny chunks.
 */
export const RESIDENT_CHUNK_OVERHEAD_BYTES = 96;

/** Throws unless a ring's radii are positive and its unload bounds hold its load bounds. */
export function checkRing(r: StreamRing): void {
  for (const v of [r.loadRadius, r.unloadRadius, r.loadHeight, r.unloadHeight, r.nearRadius]) if (!(v >= 0) || !Number.isFinite(v)) throw new RangeError('ring radii must be finite and ≥ 0');
  if (r.unloadRadius < r.loadRadius || r.unloadHeight < r.loadHeight) throw new RangeError('unload bounds must hold the load bounds');
}

/** A focus point in cells. */
export interface Focus {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Horizontal and vertical offsets (cells) of a chunk's centre from the focus. */
function offsets(grid: ChunkGrid, f: Focus, cx: number, cy: number, cz: number): [number, number, number] {
  const h = grid.edge / 2;
  return [(cx << grid.shift) + h - f.x, (cy << grid.shift) + h - f.y, (cz << grid.shift) + h - f.z];
}

/** Squared distance (cells²) from the focus to a chunk's centre: the queue's distance key. */
export function chunkDistance2(grid: ChunkGrid, f: Focus, cx: number, cy: number, cz: number): number {
  const [dx, dy, dz] = offsets(grid, f, cx, cy, cz);
  return dx * dx + dy * dy + dz * dz;
}

/** Whether a chunk is inside the load bounds. */
export function inLoadRing(grid: ChunkGrid, r: StreamRing, f: Focus, cx: number, cy: number, cz: number): boolean {
  const [dx, dy, dz] = offsets(grid, f, cx, cy, cz);
  return dx * dx + dz * dz <= r.loadRadius * r.loadRadius && Math.abs(dy) <= r.loadHeight;
}

/** Whether a chunk is past the unload bounds. */
export function pastUnloadRing(grid: ChunkGrid, r: StreamRing, f: Focus, cx: number, cy: number, cz: number): boolean {
  const [dx, dy, dz] = offsets(grid, f, cx, cy, cz);
  return dx * dx + dz * dz > r.unloadRadius * r.unloadRadius || Math.abs(dy) > r.unloadHeight;
}

/** Whether a chunk is close enough for the near lane. */
export function inNearRing(grid: ChunkGrid, r: StreamRing, f: Focus, cx: number, cz: number): boolean {
  const h = grid.edge / 2;
  const dx = (cx << grid.shift) + h - f.x;
  const dz = (cz << grid.shift) + h - f.z;
  return dx * dx + dz * dz <= r.nearRadius * r.nearRadius;
}

/** Every chunk inside the load bounds, nearest first. */
export function ringChunks(grid: ChunkGrid, r: StreamRing, f: Focus): Array<{ cx: number; cy: number; cz: number; d2: number }> {
  const out: Array<{ cx: number; cy: number; cz: number; d2: number }> = [];
  const x0 = Math.floor((f.x - r.loadRadius) / grid.edge);
  const x1 = Math.floor((f.x + r.loadRadius) / grid.edge);
  const z0 = Math.floor((f.z - r.loadRadius) / grid.edge);
  const z1 = Math.floor((f.z + r.loadRadius) / grid.edge);
  const y0 = Math.floor((f.y - r.loadHeight) / grid.edge);
  const y1 = Math.floor((f.y + r.loadHeight) / grid.edge);
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) for (let cy = y0; cy <= y1; cy++) {
    if (!chunkInWorld(grid, cx, cy, cz) || !inLoadRing(grid, r, f, cx, cy, cz)) continue;
    out.push({ cx, cy, cz, d2: chunkDistance2(grid, f, cx, cy, cz) });
  }
  return out.sort((a, b) => a.d2 - b.d2);
}
