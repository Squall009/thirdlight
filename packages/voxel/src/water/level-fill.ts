/**
 * The level fill: the liquid a basin holds up to a level, from a seed.
 *
 * From the seed's cell the fill walks the open cells joined face to face
 * (air, a gas, or liquid of the fill's own material), never a cell whose bottom is
 * at or above the level, bounded by everything else (ground, built cells,
 * an opening, another liquid) and by the bound it is given: the reach, a
 * horizontal distance from the seed's column. Every cell it reaches holds
 * the liquid: full below the level's row, the level's own row filled to the
 * level (the shape's 16 fill levels, rounded; a share that rounds to empty
 * is not filled and not entered).
 *
 * Where the walk would step out of its bound (past the reach, or into a
 * cell the reader cannot give: past the world's edge, a region it cannot
 * read) it does not go on; it reports the cell and which bound, so a caller
 * can flag the place the water would leak. It still walks every other cell
 * it can reach, so every leak is reported, not only the first.
 *
 * A seed above the level starts from the level's row in the seed's column
 * (a marker standing over the water fills the water under it); a start cell
 * that is not open, outside the world or above the level fills nothing
 * (`seed_blocked`).
 *
 * One function for every caller: a water body's regenerate in the editor's
 * backend, a fill stroke and a later settle call it with their own reader.
 * Deterministic: the same reader gives the same cells in the same order.
 * Pure: the reader is the only input, nothing is written.
 */
import { MATERIAL_ID_MAX, recordValue, ROLE_MASK, ROLE_SHIFT, SHAPE_FULL, VOXEL_ROLE } from '../record';
import { isGasRole } from '../role-traits';
import { CellQueue, CellSet } from './cell-set';

/** What a reader answers for a cell the fill may not know (past the world's edge, a region it cannot read): a breach. */
export const FILL_OUTSIDE = -1;

/** What the fill reads of a world. */
export interface FillWorld {
  /** A cell's record value (u32), or {@link FILL_OUTSIDE}. */
  value(x: number, y: number, z: number): number;
  /** Whether something beside the cell's own voxel closes it (a structure's wall standing over it): never filled. */
  stops?(x: number, y: number, z: number): boolean;
}

/** Which bound a breach crossed. */
export const FILL_BREACH = Object.freeze({ reach: 1, world: 2 });

export interface LevelFillSpec {
  /** The seed's cell (world cells). */
  readonly seed: readonly [number, number, number];
  /** The surface's height in cells (metres over the cell size): a cell fills while its bottom lies below it. */
  readonly level: number;
  /** The liquid's voxel material. */
  readonly material: number;
  /** How far from the seed's column the fill may spread, in cells (between column centres, horizontal). */
  readonly reach: number;
}

export type LevelFillStatus = 'filled' | 'breached' | 'seed_blocked';

export interface LevelFillResult {
  readonly status: LevelFillStatus;
  /** The cell the walk started from (null: the seed's column has no row under the level). */
  readonly start: readonly [number, number, number] | null;
  /** Cells reached, x, y, z each, in the order the walk reached them. */
  readonly cells: Int32Array;
  /** The value each reached cell holds after the fill (the liquid at its fill level). */
  readonly values: Uint32Array;
  /** Cells just past the bound, x, y, z each, in the order the walk met them. */
  readonly breaches: Int32Array;
  /** Which bound each breach crossed ({@link FILL_BREACH}). */
  readonly breachKinds: Uint8Array;
  /** The reached cells as a set (what a caller compares or keeps). */
  readonly set: CellSet;
}

/** A liquid voxel of `material` at fill level `shape`. */
export function liquidValue(material: number, shape: number): number {
  return recordValue(material, VOXEL_ROLE.liquid, shape, 0);
}

/** Whether a value is a liquid of `material` (any fill level). */
export function isLiquidOf(v: number, material: number): boolean {
  return v > 0 && ((v >>> ROLE_SHIFT) & ROLE_MASK) === VOXEL_ROLE.liquid && (v & MATERIAL_ID_MAX) === material;
}

/** Whether the fill of `material` may pass a cell holding `v`: air, a gas (the liquid takes its cell: a cell holds one), or its own liquid. */
export function fillPasses(v: number, material: number): boolean {
  return v === 0 || isLiquidOf(v, material) || (v > 0 && isGasRole((v >>> ROLE_SHIFT) & ROLE_MASK));
}

/** Whether the fill may enter a cell of the world (inside it, its own liquid or air, nothing standing over it). */
export function fillOpen(spec: Pick<LevelFillSpec, 'material'>, world: FillWorld, x: number, y: number, z: number): boolean {
  const v = world.value(x, y, z);
  return v !== FILL_OUTSIDE && fillPasses(v, spec.material) && world.stops?.(x, y, z) !== true;
}

/** The fill level a cell of row `y` takes under a surface at `level` cells (0: the cell stays dry). */
export function fillShapeAt(level: number, y: number): number {
  const share = level - y;
  if (share >= 1) return SHAPE_FULL;
  if (share <= 0) return 0;
  return Math.round(share * SHAPE_FULL);
}

/** The row the walk starts from in the seed's column: the seed's, or the highest row under the level when the seed is above it. */
export function fillStartRow(spec: Pick<LevelFillSpec, 'seed' | 'level'>): number | null {
  let top = Math.ceil(spec.level) - 1;
  if (fillShapeAt(spec.level, top) === 0) top--;
  return Number.isFinite(top) ? Math.min(spec.seed[1], top) : null;
}

/** Whether cell (x, z)'s column lies within `reach` cells of the seed's column. */
export function withinReach(spec: Pick<LevelFillSpec, 'seed' | 'reach'>, x: number, z: number): boolean {
  const dx = x - spec.seed[0];
  const dz = z - spec.seed[2];
  return dx * dx + dz * dz <= spec.reach * spec.reach;
}

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [0, -1, 0],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 0, -1],
  [0, 0, 1],
  [0, 1, 0],
];

/** Grows typed arrays of triples (cells, breaches) as the walk adds to them. */
export class Triples {
  a = new Int32Array(3 * 256);
  n = 0;
  push(x: number, y: number, z: number): void {
    if (this.n + 3 > this.a.length) {
      const b = new Int32Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = x;
    this.a[this.n++] = y;
    this.a[this.n++] = z;
  }
  get count(): number {
    return this.n / 3;
  }
}

/** What a walk reached: its cells, and the cells past its bound with the bound each crossed. */
export interface FillWalk {
  readonly cells: Triples;
  readonly breaches: Triples;
  readonly kinds: number[];
}

/**
 * The walk of the fill from `starts` (cells already known to fill), through
 * cells the fill passes, under the level, within the reach; cells in
 * `skip` are neither entered nor reported (a caller's cells already
 * filled). Every reached cell, the start cells included, goes into `into`.
 */
export function walkFill(spec: LevelFillSpec, world: FillWorld, starts: readonly (readonly [number, number, number])[], into: CellSet, skip?: CellSet): FillWalk {
  const cells = new Triples();
  const breaches = new Triples();
  const kinds: number[] = [];
  const met = new CellSet();
  const q = new CellQueue();
  const top = Math.ceil(spec.level) - 1;
  const topFills = fillShapeAt(spec.level, top) > 0;
  for (const [x, y, z] of starts) {
    if (!into.add(x, y, z)) continue;
    cells.push(x, y, z);
    q.push(x, y, z);
  }
  const at: [number, number, number] = [0, 0, 0];
  while (q.shift(at)) {
    const [x, y, z] = at;
    for (const [dx, dy, dz] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (ny > top || (ny === top && !topFills)) continue;
      if (into.has(nx, ny, nz) || skip?.has(nx, ny, nz) === true || met.has(nx, ny, nz)) continue;
      const v = world.value(nx, ny, nz);
      if (v === FILL_OUTSIDE) {
        met.add(nx, ny, nz);
        breaches.push(nx, ny, nz);
        kinds.push(FILL_BREACH.world);
        continue;
      }
      if (!fillPasses(v, spec.material) || world.stops?.(nx, ny, nz) === true) continue;
      if (!withinReach(spec, nx, nz)) {
        met.add(nx, ny, nz);
        breaches.push(nx, ny, nz);
        kinds.push(FILL_BREACH.reach);
        continue;
      }
      into.add(nx, ny, nz);
      cells.push(nx, ny, nz);
      q.push(nx, ny, nz);
    }
  }
  return { cells, breaches, kinds };
}

/** The level fill from a seed ({@link LevelFillSpec}; see the module's comment). */
export function levelFill(spec: LevelFillSpec, world: FillWorld): LevelFillResult {
  const set = new CellSet();
  const row = fillStartRow(spec);
  const start = row === null ? null : ([spec.seed[0], row, spec.seed[2]] as const);
  const blocked = (): LevelFillResult => ({ status: 'seed_blocked', start, cells: new Int32Array(0), values: new Uint32Array(0), breaches: new Int32Array(0), breachKinds: new Uint8Array(0), set });
  if (start === null) return blocked();
  if (!fillOpen(spec, world, start[0], start[1], start[2])) return blocked();
  const walk = walkFill(spec, world, [start], set);
  const cells = walk.cells.a.slice(0, walk.cells.n);
  const values = new Uint32Array(walk.cells.count);
  for (let i = 0; i < values.length; i++) values[i] = liquidValue(spec.material, fillShapeAt(spec.level, cells[3 * i + 1]!));
  return {
    status: walk.kinds.length > 0 ? 'breached' : 'filled',
    start,
    cells,
    values,
    breaches: walk.breaches.a.slice(0, walk.breaches.n),
    breachKinds: Uint8Array.from(walk.kinds),
    set,
  };
}
