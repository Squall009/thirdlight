/**
 * A terrain as the tracer takes it: rings of its height grid round the eye
 * (a clipmap), not the whole field. Ring 0 holds the field's own samples in
 * a window of `TRACE_RING_CELLS` cells a side round the eye; each next ring
 * has samples twice as far apart over a window twice as wide, with the
 * finer ring's cells left open, until a ring holds every loaded tile.
 *
 * Why: the shadow and bounce rays the cache lights with start round the eye
 * (its texels are resident there), and far ground only shades them as a
 * horizon, which a coarser grid draws as well. The whole field at its own
 * spacing grows with the world (a 6 km landscape at 2 m was 138 MB, over a
 * storage binding's 128 MiB); rings grow with the log of its width.
 *
 * A ring moves only when the eye has gone a quarter of its window from its
 * centre (ring 0), or when the finer ring no longer fits inside it, so a
 * walk re-makes ring 0 now and then and the coarse rings seldom. Windows
 * snap to their ring's grid so a ring's open cells are exactly the finer
 * ring's.
 *
 * Pure (no three.js, no device).
 */
import { terrainHeightOf, terrainHoleAt, type TerrainField, type TerrainTile } from '@thirdlight/project-model';

import { packTerrainSteps, type TraceTerrain } from './tracer-scene';

/** Cells a side of a trace ring's window (in the ring's own cells). */
export const TRACE_RING_CELLS = 512;
/** How far (in the ring's cells) ring 0's centre snaps, and how far the eye goes from it before it moves. */
const RING_STEP = TRACE_RING_CELLS / 4;

/** A cell rectangle [x0, z0, x1, z1) of the field's base grid. */
type Rect = readonly [number, number, number, number];

/** Where a terrain's rings stand: each one's centre in base cells (even multiples of its step). */
export interface TraceRingPlan {
  readonly centres: readonly (readonly [number, number])[];
}

/** Ring k's window in base cells round `c`. */
function windowOf(k: number, c: readonly number[]): Rect {
  const h = (TRACE_RING_CELLS / 2) * 2 ** k;
  return [c[0]! - h, c[1]! - h, c[0]! + h, c[1]! + h];
}

const contains = (a: Rect, b: Rect): boolean => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

/**
 * The rings for an eye at base cell `eye` over the loaded rectangle `loaded`,
 * keeping `prev`'s centres where they still serve (pure: a plan is the same
 * for the same inputs).
 */
export function planTraceRings(eye: readonly number[], loaded: Rect, prev: TraceRingPlan | null): TraceRingPlan {
  const centres: [number, number][] = [];
  const snap = (v: number, q: number): number => Math.round(v / q) * q;
  for (let k = 0; ; k += 1) {
    const q = RING_STEP * 2 ** k;
    const was = prev?.centres[k];
    let c: [number, number];
    if (k === 0) {
      c = was !== undefined && Math.abs(eye[0]! - was[0]) <= q && Math.abs(eye[1]! - was[1]) <= q ? [was[0], was[1]] : [snap(eye[0]!, q), snap(eye[1]!, q)];
    } else {
      const inner = windowOf(k - 1, centres[k - 1]!);
      c = was !== undefined && contains(windowOf(k, was), inner) ? [was[0], was[1]] : [snap(centres[k - 1]![0], q), snap(centres[k - 1]![1], q)];
    }
    centres.push(c);
    if (contains(windowOf(k, c), loaded)) return { centres };
  }
}

/** A field's loaded tiles by tile index, and the base-cell rectangle they cover. */
export interface TraceRingTiles {
  readonly n: number;
  /** Tiles' rectangle (tile indices, max exclusive). */
  readonly tx0: number;
  readonly tz0: number;
  readonly tw: number;
  readonly th: number;
  readonly grid: readonly (TerrainTile | undefined)[];
  readonly loaded: Rect;
}

export function traceRingTilesOf(field: TerrainField): TraceRingTiles | null {
  const tiles = field.loadedTiles();
  if (tiles.size === 0) return null;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  const at: [number, number, TerrainTile][] = [];
  for (const [key, t] of tiles) {
    const [x, z] = key.split(',').map(Number) as [number, number];
    at.push([x, z, t]);
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x + 1);
    z1 = Math.max(z1, z + 1);
  }
  const tw = x1 - x0;
  const th = z1 - z0;
  const grid: (TerrainTile | undefined)[] = new Array(tw * th);
  for (const [x, z, t] of at) grid[(z - z0) * tw + (x - x0)] = t;
  const n = field.n;
  return { n, tx0: x0, tz0: z0, tw, th, grid, loaded: [x0 * n, z0 * n, x1 * n, z1 * n] };
}

/** Rows of samples or cells a step of `traceRingSteps` makes before it yields. */
const RING_ROWS = 16;

/**
 * Ring `k` of a plan as a traced terrain, in steps (a few rows each; the
 * last packs its item too, `packTerrainSteps`): its window clipped to the
 * loaded tiles, samples `2^k` base samples apart. A cell is open where a
 * corner has no loaded tile, where the base cell at its middle is a hole,
 * and inside the finer ring's window (null: the window holds nothing loaded).
 */
export function* traceRingSteps(field: TerrainField, tiles: TraceRingTiles, plan: TraceRingPlan, k: number): Generator<void, TraceTerrain | null> {
  const step = 2 ** k;
  const w = windowOf(k, plan.centres[k]!);
  const L = tiles.loaded;
  const n = tiles.n;
  // Ring cells (in units of `step` base cells): the window, clipped to the loaded rectangle rounded out.
  const cx0 = Math.max(w[0] / step, Math.floor(L[0] / step));
  const cz0 = Math.max(w[1] / step, Math.floor(L[1] / step));
  const cx1 = Math.min(w[2] / step, Math.ceil(L[2] / step));
  const cz1 = Math.min(w[3] / step, Math.ceil(L[3] / step));
  if (cx1 <= cx0 || cz1 <= cz0) return null;
  const cellsX = cx1 - cx0;
  const cellsZ = cz1 - cz0;
  const sx = cellsX + 1;
  const range = field.heightSpan();
  const h0 = terrainHeightOf(range, 0);
  const dh = terrainHeightOf(range, 1) - h0;
  const heights = new Float32Array(sx * (cellsZ + 1));
  const missing = new Uint8Array(sx * (cellsZ + 1)).fill(1);
  // Tile columns the window's samples fall in (a sample on a tile edge is read from either tile).
  const tc0 = Math.max(tiles.tx0, Math.floor(((cx0 * step) - 1) / n));
  const tc1 = Math.min(tiles.tx0 + tiles.tw - 1, Math.floor((cx1 * step) / n));
  for (let z = 0; z <= cellsZ; z += 1) {
    if (z % RING_ROWS === RING_ROWS - 1) yield;
    const gz = (cz0 + z) * step;
    const tzA = Math.floor(gz / n);
    for (const [tz, lz] of gz - tzA * n === 0 ? [[tzA, 0], [tzA - 1, n]] : [[tzA, gz - tzA * n]]) {
      const tj = tz! - tiles.tz0;
      if (tj < 0 || tj >= tiles.th) continue;
      for (let tx = tc0; tx <= tc1; tx += 1) {
        const tile = tiles.grid[tj * tiles.tw + tx - tiles.tx0];
        if (tile === undefined) continue;
        const xs = Math.max(0, Math.ceil((tx * n) / step) - cx0);
        const xe = Math.min(cellsX, Math.floor((tx * n + n) / step) - cx0);
        const row = lz! * (n + 1) - tx * n;
        const H = tile.heights;
        for (let x = xs; x <= xe; x += 1) {
          const i = z * sx + x;
          heights[i] = h0 + H[row + (cx0 + x) * step]! * dh;
          missing[i] = 0;
        }
      }
    }
  }
  const inner = k > 0 ? windowOf(k - 1, plan.centres[k - 1]!).map((v) => v / step) : null;
  const open = new Uint8Array(cellsX * cellsZ);
  const half = step >> 1;
  for (let z = 0; z < cellsZ; z += 1) {
    if (z % RING_ROWS === RING_ROWS - 1) yield;
    const gz = cz0 + z;
    const bz = gz * step + half;
    const tj = Math.floor(bz / n) - tiles.tz0;
    const lz = bz - Math.floor(bz / n) * n;
    const innerRow = inner !== null && gz >= inner[1]! && gz < inner[3]!;
    for (let x = 0; x < cellsX; x += 1) {
      const i = z * sx + x;
      let o = missing[i]! | missing[i + 1]! | missing[i + sx]! | missing[i + sx + 1]!;
      const gx = cx0 + x;
      if (o === 0 && innerRow && gx >= inner![0]! && gx < inner![2]!) o = 1;
      if (o === 0) {
        const bx = gx * step + half;
        const ti = Math.floor(bx / n) - tiles.tx0;
        const tile = tj < 0 || ti < 0 || tj >= tiles.th || ti >= tiles.tw ? undefined : tiles.grid[tj * tiles.tw + ti];
        if (tile === undefined || (tile.holes !== null && terrainHoleAt(tile, bx - Math.floor(bx / n) * n, lz))) o = 1;
      }
      open[z * cellsX + x] = o;
    }
  }
  const og = field.origin;
  const trace: TraceTerrain = { worldToLocal: [1, 0, 0, -og[0], 0, 1, 0, -og[1], 0, 0, 1, -og[2]], spacing: field.spacing * step, cellsX, cellsZ, cellX0: cx0, cellZ0: cz0, heights, open };
  trace.packed = yield* packTerrainSteps(trace);
  return trace;
}

/** `traceRingSteps` run to its end. */
export function traceRingOf(field: TerrainField, tiles: TraceRingTiles, plan: TraceRingPlan, k: number): TraceTerrain | null {
  const steps = traceRingSteps(field, tiles, plan, k);
  for (let s = steps.next(); ; s = steps.next()) if (s.done === true) return s.value;
}

/** The base cell a world point is over. */
export function baseCellOf(field: TerrainField, eye: ArrayLike<number>): [number, number] {
  return [Math.floor((eye[0]! - field.origin[0]) / field.spacing), Math.floor((eye[2]! - field.origin[2]) / field.spacing)];
}

/**
 * One terrain's trace rings kept up to date. When the eye or the tiles call
 * for new rings, the ones to make again (those whose window moved, the one
 * round each, whose open cells did, or all when the tiles changed) are made
 * a few rows at a time within `budgetMs` a frame, off the frame's critical
 * path; the rings before stay traced until all are made, then are swapped
 * at once (`version` moves).
 */
export class TerrainTraceRings {
  private plan: TraceRingPlan | null = null;
  private rings: (TraceTerrain | null)[] = [];
  private tilesFor: TerrainField | null = null;
  private tilesVersion = -1;
  private tiles: TraceRingTiles | null = null;
  /** Rings being made: the plan they are for, what is made so far, and the steps of the one in hand. */
  private job: { plan: TraceRingPlan; tiles: TraceRingTiles; field: TerrainField; made: (TraceTerrain | null)[]; remake: boolean[]; k: number; steps: Generator<void, TraceTerrain | null> | null } | null = null;
  version = 0;

  /** The rings now (finest first; empty when nothing is loaded). */
  traces(): TraceTerrain[] {
    return this.rings.filter((r): r is TraceTerrain => r !== null);
  }

  /** Whether rings are being made. */
  get busy(): boolean {
    return this.job !== null;
  }

  /**
   * Follow the eye and the field (`tilesVersion`: bumped when its tiles
   * changed), spending at most about `budgetMs` (Infinity: all at once).
   * Returns whether the traced rings changed.
   */
  update(field: TerrainField, tilesVersion: number, eye: ArrayLike<number>, budgetMs = Infinity): boolean {
    const fresh = field !== this.tilesFor || tilesVersion !== this.tilesVersion;
    if (fresh) {
      this.tilesFor = field;
      this.tilesVersion = tilesVersion;
      this.tiles = traceRingTilesOf(field);
      this.job = null;
    }
    const tiles = this.tiles;
    if (tiles === null) {
      const had = this.rings.length > 0;
      this.rings = [];
      this.plan = null;
      if (had) this.version += 1;
      return had;
    }
    if (this.job === null) {
      const plan = planTraceRings(baseCellOf(field, eye), tiles.loaded, fresh ? null : this.plan);
      const old = fresh ? null : this.plan;
      const moved = (k: number): boolean => old === null || old.centres[k]?.[0] !== plan.centres[k]![0] || old.centres[k]?.[1] !== plan.centres[k]![1];
      const remake = plan.centres.map((_, k) => old === null || moved(k) || (k > 0 && moved(k - 1)) || k >= this.rings.length);
      if (!remake.some((r) => r) && plan.centres.length === this.rings.length) return false;
      this.job = { plan, tiles, field, made: [], remake, k: 0, steps: null };
    }
    return this.advance(budgetMs);
  }

  private advance(budgetMs: number): boolean {
    const job = this.job!;
    const t0 = performance.now();
    while (job.k < job.plan.centres.length) {
      if (!job.remake[job.k]) {
        job.made.push(this.rings[job.k]!);
        job.k += 1;
        continue;
      }
      job.steps ??= traceRingSteps(job.field, job.tiles, job.plan, job.k);
      for (;;) {
        const s = job.steps.next();
        if (s.done === true) {
          job.made.push(s.value);
          job.steps = null;
          job.k += 1;
          break;
        }
        if (performance.now() - t0 >= budgetMs) return false;
      }
    }
    this.rings = job.made;
    this.plan = job.plan;
    this.job = null;
    this.version += 1;
    return true;
  }
}
