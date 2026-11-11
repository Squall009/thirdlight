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
 * chunks, derived data and open region tables. Low is the Iris Xe floor,
 * sized inside the low tier's share of an 8 GB machine
 * (`LOW_MEMORY_BUDGET_MIB` in project-model); no tier holds less than low
 * (medium and high are not measured on their own hardware yet).
 */
export const VOXEL_STREAM_BUDGET_BYTES: Readonly<Record<StreamTier, number>> = Object.freeze({ low: 768 * MIB, medium: 768 * MIB, high: 1024 * MIB });

/**
 * How much a tier scales every ring distance a world sets (load, collision,
 * the levels) by default: low 0.71, medium 1, high 1.41, so the area a tier
 * loads halves or doubles from medium's (they were the square roots of the
 * budgets when those were 256 / 512 / 1024 MiB). Not derived from the budget
 * any more: the rings cost GPU and worker time, the budget only memory, and
 * a larger budget is room (edits, dense places), not a reason to draw more.
 * Medium is 1: the default distances were measured on the Iris Xe.
 */
export const VOXEL_RING_SCALES: Readonly<Record<StreamTier, number>> = Object.freeze({ low: Math.SQRT1_2, medium: 1, high: Math.SQRT2 });

/**
 * How much a tier scales the near field's reach (the load ring and the
 * level-1 ring) by default: its ring scale, but never under medium's. Past
 * the near field the far field's finest level draws (2 m cells), and a
 * building in 2 m cells is a rounded blob until a cell is about the low
 * tier's far error on screen (8 px at the far field's 720-px projection,
 * ~156 m out); the low tier's budget-sized 0.71 ended the near field at
 * ~95 m, so the town's back row of houses drew as blobs at 9–13 px a cell.
 * Level 0, collision and relief keep the ring scale (they cost the most).
 */
export const VOXEL_REACH_SCALES: Readonly<Record<StreamTier, number>> = Object.freeze({
  low: Math.max(1, VOXEL_RING_SCALES.low),
  medium: Math.max(1, VOXEL_RING_SCALES.medium),
  high: Math.max(1, VOXEL_RING_SCALES.high),
});

/**
 * Bookkeeping bytes per resident chunk, air ones included: its entry in the
 * store's index and the streamer's own state (a map entry and a small
 * object). An estimate, so the budget is never blind to many tiny chunks.
 */
export const RESIDENT_CHUNK_OVERHEAD_BYTES = 96;

/**
 * Travel speed (cells a second; 20 m/s) up to which the load ring keeps its
 * full radius. Faster, the ring narrows so the ground it sweeps a second
 * stays what it is at this speed: a ring the pool cannot fill as fast as it
 * moves holds chunks it never derives, and the chunks under the camera (its
 * collision) wait behind them. Measured at 60 and 150 m/s on the Iris Xe:
 * with the full ring the ground under the camera was missing in 57–90 % of
 * updates; past the near field the far field draws the world anyway.
 */
export const STREAM_FULL_RING_SPEED = 40;

/** The narrowest a load ring gets at speed (cells; 48 m): the default collision ring's radius, what a character stands on. */
export const STREAM_MIN_SPEED_RADIUS = DEFAULT_COLLISION_RING.radius;

/**
 * The load ring for a focus moving at `speed` cells a second: `base` up to
 * {@link STREAM_FULL_RING_SPEED}, then its radius times that speed over
 * `speed` (never under {@link STREAM_MIN_SPEED_RADIUS} or over `base`),
 * rounded down to whole chunks so a speed that wavers does not plan again
 * every update; the unload gap, the heights and the near lane's radius
 * (at most the load radius) kept.
 */
export function speedRing(base: StreamRing, speed: number, chunkEdge: number): StreamRing {
  if (!(speed > STREAM_FULL_RING_SPEED)) return base;
  const narrow = Math.max(STREAM_MIN_SPEED_RADIUS, Math.floor((base.loadRadius * STREAM_FULL_RING_SPEED) / speed / chunkEdge) * chunkEdge);
  if (narrow >= base.loadRadius) return base;
  return { loadRadius: narrow, unloadRadius: narrow + (base.unloadRadius - base.loadRadius), loadHeight: base.loadHeight, unloadHeight: base.unloadHeight, nearRadius: Math.min(base.nearRadius, narrow) };
}

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
