/**
 * Building blocks of the synthetic test worlds: the world/grid shapes the
 * harness walks, the test material ids, and fast per-chunk helpers (a
 * column filler for layered ground and liquid, a coarse 3D noise lattice).
 *
 * Test data only: these worlds exist to measure storage candidates. Every
 * cell is a pure function of the world's parameters and the cell position,
 * so a chunk is the same whichever order or process generates it, and a
 * world is generated chunk by chunk without ever being held whole.
 */
import { localIndex, SHAPE_FULL, VOXEL_ROLE, type ChunkGrid, type DenseChunk } from '@thirdlight/voxel';

/** Material ids of the test worlds (0 is air). */
export const MAT = Object.freeze({
  rock: 1,
  soil: 2,
  grass: 3,
  sand: 4,
  water: 5,
  gravel: 6,
  snow: 7,
  stone: 10,
  timber: 11,
  plaster: 12,
  roofTile: 13,
  plank: 14,
  brick: 15,
});

/** Inclusive-exclusive cell bounds of a grid's content. */
export interface CellBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** One voxel grid of a test world: the world grid, or a structure's own rotated grid. */
export interface TestGrid {
  readonly name: string;
  /** Yaw in degrees and origin in world metres of the grid's cell (0, 0, 0); the world grid is 0 and the origin. */
  readonly yawDeg: number;
  readonly originM: readonly [number, number, number];
  /** Where content can be: chunks outside are absent. */
  readonly bounds: CellBounds;
  /** Writes one chunk into `out` (every cell) and returns whether any cell is not air. */
  fill(grid: ChunkGrid, cx: number, cy: number, cz: number, out: DenseChunk): boolean;
}

/** A synthetic test world: one or more grids plus what it stands for. */
export interface TestWorld {
  readonly name: string;
  readonly description: string;
  readonly seed: number;
  /** Ground footprint in m² the world stands for (per-km² figures divide by it). */
  readonly areaM2: number;
  readonly grids: readonly TestGrid[];
  /** Footprint (cells per side) of the window the access/edit benchmarks load, centred on the world grid. */
  readonly benchFootprint: number;
}

/** The chunk index range [lo, hi) covering cells [min, max). */
export function chunkRange(grid: ChunkGrid, min: number, max: number): [number, number] {
  return [min >> grid.shift, ((max - 1) >> grid.shift) + 1];
}

/** Hermite step of v from a to b (0 below a, 1 above b). */
export function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Clamp to [0, 1]. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A cover fraction 0 … 1 as a shape byte: full is 255, any cover above zero at least 1. */
export function shapeByte(fraction: number): number {
  if (fraction >= 1) return SHAPE_FULL;
  if (fraction <= 0) return 0;
  return Math.max(1, Math.round(fraction * SHAPE_FULL));
}

/** Layered ground of one column: where its surface is and what it is made of. */
export interface GroundColumn {
  /** Surface height in cells (fractional: the top cell is partly full). */
  surface: number;
  /** Lowest solid cell (the world's base). */
  base: number;
  /** Top material (grass, or rock where the slope is too steep). */
  top: number;
  /** Cells of soil below the top cell. */
  soilDepth: number;
  /** Liquid surface height in cells (−Infinity: none); liquid fills air below it. */
  liquidLevel: number;
}

/**
 * Writes one column of a chunk from its ground: rock, soil and the top
 * material up to the surface (the top cell's shape is its fill), then liquid
 * up to the liquid level (its top cell's shape is its fill), air above.
 * A cell partly ground and below the liquid stays ground (one material per
 * cell). Returns whether any cell is not air.
 */
export function fillGroundColumn(grid: ChunkGrid, out: DenseChunk, lx: number, lz: number, y0: number, col: GroundColumn): boolean {
  const edge = grid.edge;
  const base = localIndex(grid, lx, 0, lz);
  const { surface, liquidLevel } = col;
  let any = false;
  for (let ly = 0; ly < edge; ly++) {
    const y = y0 + ly;
    const i = base + ly;
    const solid = y < col.base ? 0 : clamp01(surface - y);
    if (solid > 0) {
      const depth = surface - (y + 1);
      out.material[i] = depth < 1 ? col.top : depth < 1 + col.soilDepth ? MAT.soil : MAT.rock;
      out.role[i] = VOXEL_ROLE.terrain;
      out.shape[i] = shapeByte(solid);
      out.wetness[i] = 0;
      any = true;
    } else if (y >= col.base && y < liquidLevel) {
      out.material[i] = MAT.water;
      out.role[i] = VOXEL_ROLE.liquid;
      out.shape[i] = shapeByte(liquidLevel - y);
      out.wetness[i] = 0;
      any = true;
    } else {
      out.material[i] = 0;
      out.role[i] = 0;
      out.shape[i] = 0;
      out.wetness[i] = 0;
    }
  }
  return any;
}

/**
 * A scalar field sampled every `step` cells over one chunk (and its far
 * faces), then read with trilinear interpolation: 3D noise at chunk scale
 * costs (edge/step + 1)³ evaluations instead of edge³.
 */
export class CoarseField {
  private readonly values: Float32Array;
  private readonly n: number;

  constructor(
    private readonly grid: ChunkGrid,
    private readonly step: number,
  ) {
    this.n = grid.edge / step + 1;
    this.values = new Float32Array(this.n * this.n * this.n);
  }

  /** Samples `fn` (world cell coordinates) on the lattice of the chunk starting at cell (x0, y0, z0). */
  sample(x0: number, y0: number, z0: number, fn: (x: number, y: number, z: number) => number): void {
    const { n, step } = this;
    let i = 0;
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) for (let c = 0; c < n; c++) this.values[i++] = fn(x0 + a * step, y0 + c * step, z0 + b * step);
  }

  /** The interpolated value at a cell of the chunk (local coordinates). */
  at(lx: number, ly: number, lz: number): number {
    const { n, step, values: v } = this;
    const fx = lx / step;
    const fy = ly / step;
    const fz = lz / step;
    const ix = Math.min(n - 2, Math.floor(fx));
    const iy = Math.min(n - 2, Math.floor(fy));
    const iz = Math.min(n - 2, Math.floor(fz));
    const tx = fx - ix;
    const ty = fy - iy;
    const tz = fz - iz;
    const idx = (a: number, b: number, c: number): number => v[((ix + a) * n + (iz + b)) * n + (iy + c)] ?? 0;
    const l = (p: number, q: number, t: number): number => p + (q - p) * t;
    const c00 = l(idx(0, 0, 0), idx(1, 0, 0), tx);
    const c10 = l(idx(0, 1, 0), idx(1, 1, 0), tx);
    const c01 = l(idx(0, 0, 1), idx(1, 0, 1), tx);
    const c11 = l(idx(0, 1, 1), idx(1, 1, 1), tx);
    return l(l(c00, c10, tz), l(c01, c11, tz), ty);
  }

  /** The chunk layout this field samples. */
  get layout(): ChunkGrid {
    return this.grid;
  }
}

/** A one-entry cache of per-column data for the chunk column last filled (a sweep fills a column's chunks in a row). */
export class ColumnCache<T> {
  private key = '';
  private value: T | undefined;

  get(cx: number, cz: number, edge: number, make: () => T): T {
    const key = `${edge}:${cx}:${cz}`;
    if (key !== this.key || this.value === undefined) {
      this.value = make();
      this.key = key;
    }
    return this.value;
  }
}
