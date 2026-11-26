/**
 * The level fill: the medium a basin holds up to a level, from a seed.
 *
 * From the seed's cell the fill walks the open cells joined face to face,
 * never a cell whose bottom is at or above the level, bounded by everything
 * else (ground, built cells, an opening, another medium) and by the bound
 * it is given: the reach, a horizontal distance from the seed's column,
 * and, when the caller gives one, a floor (the lowest row). What it writes
 * is the caller's: a role and a material.
 *
 * - **A liquid** (the default) passes air, a gas (the liquid takes its
 *   cell: a cell holds one) and liquid of its own material. Every cell it
 *   reaches holds the liquid: full below the level's row, the level's own
 *   row filled to the level (the shape's 16 fill levels, rounded; a share
 *   that rounds to empty is not filled and not entered).
 * - **A gas** passes air and gas of its own material; a liquid bounds it
 *   (fog lies on water). Its cells hold the full density, or with a fade
 *   the density falls from full, `fade` cells under the level, to none at
 *   the level, read at each cell's centre (a cell whose density rounds to
 *   none is not filled and not entered).
 * - **Air** (material 0) drains: it passes air and every medium, and the
 *   media it reaches become air.
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
 * backend, the `flood` stroke and a later settle call it with their own reader.
 * Deterministic: the same reader gives the same cells in the same order.
 * Pure: the reader is the only input, nothing is written.
 */
import { MATERIAL_AIR, MATERIAL_ID_MAX, recordValue, ROLE_MASK, ROLE_SHIFT, SHAPE_FULL, VOXEL_ROLE } from '../record';
import { isGasRole, isLiquidRole, isMediumRole, roleShape } from '../role-traits';
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
  /** The voxel material written (0: air, a drain). */
  readonly material: number;
  /** How far from the seed's column the fill may spread, in cells (between column centres, horizontal). */
  readonly reach: number;
  /** The role written: a medium (left out: a liquid). Not read when the material is air. */
  readonly role?: number;
  /** A gas only: the cells under the level over which its density falls from full to none at the level (left out: full density everywhere). */
  readonly fade?: number;
  /** The lowest row the fill may enter (left out: none): an open cell under it is a breach of the reach. */
  readonly floor?: number;
}

export type LevelFillStatus = 'filled' | 'breached' | 'seed_blocked';

export interface LevelFillResult {
  readonly status: LevelFillStatus;
  /** The cell the walk started from (null: the seed's column has no row under the level). */
  readonly start: readonly [number, number, number] | null;
  /** Cells reached, x, y, z each, in the order the walk reached them. */
  readonly cells: Int32Array;
  /** The value each reached cell holds after the fill (the medium at its shape; air for a drain). */
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

/** The role a fill writes (a liquid unless the spec names one). */
export function fillRole(spec: Pick<LevelFillSpec, 'role'>): number {
  return spec.role ?? VOXEL_ROLE.liquid;
}

/**
 * Whether a fill may pass a cell holding `v`: air, or its own medium of its
 * own material; a liquid also a gas (it takes the cell: a cell holds one);
 * a drain every medium.
 */
export function fillPasses(v: number, spec: Pick<LevelFillSpec, 'material' | 'role'>): boolean {
  if (v === 0) return true;
  if (v < 0) return false;
  const role = (v >>> ROLE_SHIFT) & ROLE_MASK;
  if (spec.material === MATERIAL_AIR) return isMediumRole(role);
  const own = fillRole(spec);
  if (role === own && (v & MATERIAL_ID_MAX) === spec.material) return true;
  return isLiquidRole(own) && isGasRole(role);
}

/** Whether the fill may enter a cell of the world (inside it, a cell it passes, nothing standing over it). */
export function fillOpen(spec: Pick<LevelFillSpec, 'material' | 'role'>, world: FillWorld, x: number, y: number, z: number): boolean {
  const v = world.value(x, y, z);
  return v !== FILL_OUTSIDE && fillPasses(v, spec) && world.stops?.(x, y, z) !== true;
}

/** The fill level a cell of row `y` takes under a surface at `level` cells (0: the cell stays dry). */
export function fillShapeAt(level: number, y: number): number {
  const share = level - y;
  if (share >= 1) return SHAPE_FULL;
  if (share <= 0) return 0;
  return Math.round(share * SHAPE_FULL);
}

/**
 * The shape a cell of row `y` takes from a fill (0: the fill leaves it and
 * does not enter it): a liquid's fill level ({@link fillShapeAt}); a gas's
 * density, full wherever a liquid would fill, or with a fade the share of
 * the fade the cell's centre lies under the level; a drain's is only read
 * as entered or not.
 */
export function fillShape(spec: Pick<LevelFillSpec, 'level' | 'role' | 'fade'>, y: number): number {
  const level = fillShapeAt(spec.level, y);
  if (level === 0 || roleShape(fillRole(spec)) !== 'density') return level;
  if (spec.fade === undefined) return SHAPE_FULL;
  const depth = spec.level - y - 0.5;
  if (depth >= spec.fade) return SHAPE_FULL;
  if (depth <= 0) return 0;
  return Math.round((depth / spec.fade) * SHAPE_FULL);
}

/** The value a fill leaves in a cell of row `y` it reached (0: air, a drain's, or a cell it does not fill). */
export function fillValue(spec: Pick<LevelFillSpec, 'level' | 'role' | 'fade' | 'material'>, y: number): number {
  if (spec.material === MATERIAL_AIR) return 0;
  const shape = fillShape(spec, y);
  return shape === 0 ? 0 : recordValue(spec.material, fillRole(spec), shape, 0);
}

/** The highest row a fill enters (not finite: none). */
export function fillTopRow(spec: Pick<LevelFillSpec, 'level' | 'role' | 'fade'>): number {
  let top = Math.ceil(spec.level) - 1;
  while (Number.isFinite(top) && fillShape(spec, top) === 0) top--;
  return top;
}

/** The row the walk starts from in the seed's column: the seed's, or the highest row the fill enters when the seed is above it. */
export function fillStartRow(spec: Pick<LevelFillSpec, 'seed' | 'level' | 'role' | 'fade'>): number | null {
  const top = fillTopRow(spec);
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
  const top = fillTopRow(spec);
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
      if (ny > top) continue;
      if (into.has(nx, ny, nz) || skip?.has(nx, ny, nz) === true || met.has(nx, ny, nz)) continue;
      const v = world.value(nx, ny, nz);
      if (v === FILL_OUTSIDE) {
        met.add(nx, ny, nz);
        breaches.push(nx, ny, nz);
        kinds.push(FILL_BREACH.world);
        continue;
      }
      if (!fillPasses(v, spec) || world.stops?.(nx, ny, nz) === true) continue;
      if (!withinReach(spec, nx, nz) || (spec.floor !== undefined && ny < spec.floor)) {
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
  for (let i = 0; i < values.length; i++) values[i] = fillValue(spec, cells[3 * i + 1]!);
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
