/**
 * A water body's liquid written again: the whole body from its seed, or
 * only round the cells an edit changed.
 *
 * A body owns the liquid of its material joined face to face to its start
 * cell, within its reach ({@link bodyCells}): no list of its cells is
 * stored, so liquid painted by hand against a body is part of it, and a
 * regenerate clears what it owns and fills again ({@link regenerateBody}).
 *
 * A breach writes nothing past the bound and holds no water inside it
 * either: a body whose fill leaves its bound (past the reach, out of the
 * world) is drained, so the designer sees a dry basin and the leak's place
 * instead of a wall of water standing where the bank was; closing the leak
 * fills it again. So a body's liquid is always a function of its record
 * and the world round it: what the fill makes, or nothing.
 *
 * {@link followBody} redoes the fill only round a change: cells the change
 * opened under the level next to the body take the liquid (and whatever
 * they open onto), cells it closed leave the body. It answers `whole`, and
 * the caller regenerates the body whole, when it cannot be local: the body
 * held nothing, its start cell changed, a closed cell may have cut the body
 * in two (the cells round it do not join again near the change), or the
 * new water leaks past the bound. The result equals the whole regenerate
 * but for liquid painted above the level by hand, which a local follow-up
 * keeps (it is the body's) and a whole one clears.
 *
 * Pure: the world is read through the caller's reader; the writes are
 * returned, never made.
 */
import { ROLE_MASK, ROLE_SHIFT, VOXEL_ROLE } from '../record';
import type { CellBox } from '../stroke';
import { CellQueue, CellSet } from './cell-set';
import { fillShapeAt, fillStartRow, isLiquidOf, levelFill, liquidValue, Triples, walkFill, withinReach, FILL_BREACH, FILL_OUTSIDE, type FillWorld, type LevelFillResult, type LevelFillSpec } from './level-fill';

/** Cells to change and the value each takes (0: air). */
export interface CellWrites {
  /** x, y, z each. */
  readonly cells: Int32Array;
  readonly values: Uint32Array;
}

/** Why a follow-up could not stay local. */
export type FollowWholeWhy = 'empty' | 'seed' | 'cut' | 'breach';

/** How far round a closed cell the follow-up looks for the body joining again before it calls it a cut (cells). */
export const FOLLOW_CUT_MARGIN_CELLS = 16;

const SIDES: readonly (readonly [number, number, number])[] = [
  [0, -1, 0],
  [-1, 0, 0],
  [1, 0, 0],
  [0, 0, -1],
  [0, 0, 1],
  [0, 1, 0],
];

/** The cell the body's fill starts from (null: its column has no row under the level). */
export function bodyStart(spec: LevelFillSpec): [number, number, number] | null {
  const row = fillStartRow(spec);
  return row === null ? null : [spec.seed[0], row, spec.seed[2]];
}

/** The liquid a body owns now: its material's liquid joined to its start cell within its reach (empty: the start cell holds none). */
export function bodyCells(spec: LevelFillSpec, world: FillWorld): CellSet {
  const out = new CellSet();
  const s = bodyStart(spec);
  if (s === null || !isLiquidOf(world.value(s[0], s[1], s[2]), spec.material)) return out;
  absorb(spec, world, [s], out);
  return out;
}

/** Adds to `owned` the liquid of the body's material joined to `from`, within the reach. */
function absorb(spec: LevelFillSpec, world: FillWorld, from: readonly (readonly [number, number, number])[], owned: CellSet): void {
  const q = new CellQueue();
  for (const [x, y, z] of from) {
    owned.add(x, y, z);
    q.push(x, y, z);
  }
  const at: [number, number, number] = [0, 0, 0];
  while (q.shift(at)) {
    const [x, y, z] = at;
    for (const [dx, dy, dz] of SIDES) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (owned.has(nx, ny, nz) || !withinReach(spec, nx, nz)) continue;
      const v = world.value(nx, ny, nz);
      if (v === FILL_OUTSIDE || !isLiquidOf(v, spec.material)) continue;
      owned.add(nx, ny, nz);
      q.push(nx, ny, nz);
    }
  }
}

/** Collects writes, each cell once, only where the value changes. */
class Writes {
  private readonly t = new Triples();
  private v = new Uint32Array(256);
  add(world: FillWorld, x: number, y: number, z: number, value: number): void {
    const now = world.value(x, y, z);
    if (now === value || now === FILL_OUTSIDE) return;
    const i = this.t.count;
    if (i === this.v.length) {
      const b = new Uint32Array(this.v.length * 2);
      b.set(this.v);
      this.v = b;
    }
    this.v[i] = value;
    this.t.push(x, y, z);
  }
  done(): CellWrites {
    return { cells: this.t.a.slice(0, this.t.n), values: this.v.slice(0, this.t.count) };
  }
}

/** What a body's regenerate does. */
export interface BodyRegenerate {
  /** The fill from the seed (its breaches are where the body leaks). */
  readonly fill: LevelFillResult;
  readonly writes: CellWrites;
  /** The liquid the body owns once the writes are made. */
  readonly owned: CellSet;
}

/**
 * The body written whole: what it owns (`before`, else read from the world
 * by {@link bodyCells}) cleared, the fill from its seed written, or nothing
 * when the fill breaches or its seed is blocked.
 */
export function regenerateBody(spec: LevelFillSpec, world: FillWorld, before?: CellSet): BodyRegenerate {
  const held = before ?? bodyCells(spec, world);
  const fill = levelFill(spec, world);
  const keep = fill.status === 'filled';
  const w = new Writes();
  held.forEach((x, y, z) => {
    if (keep && fill.set.has(x, y, z)) return;
    // Only liquid is cleared: a cell an edit made ground since is not the body's any more (a material changed: the old liquid goes).
    if (isLiquid(world.value(x, y, z))) w.add(world, x, y, z, 0);
  });
  const owned = keep ? fill.set : new CellSet();
  if (keep) for (let i = 0; i < fill.values.length; i++) w.add(world, fill.cells[3 * i]!, fill.cells[3 * i + 1]!, fill.cells[3 * i + 2]!, fill.values[i]!);
  return { fill, writes: w.done(), owned };
}

/** The liquid a body owned cleared (a body deleted, or moved to another world): its cells that still hold liquid become air. */
export function clearBody(owned: CellSet, world: FillWorld): CellWrites {
  const w = new Writes();
  owned.forEach((x, y, z) => {
    if (isLiquid(world.value(x, y, z))) w.add(world, x, y, z, 0);
  });
  return w.done();
}

const isLiquid = (v: number): boolean => v > 0 && ((v >>> ROLE_SHIFT) & ROLE_MASK) === VOXEL_ROLE.liquid;

/** A local follow-up's answer: the writes and the liquid owned after them, or why it must be whole. */
export type BodyFollow =
  | { readonly kind: 'local'; readonly writes: CellWrites; readonly owned: CellSet; readonly added: number; readonly removed: number }
  | { readonly kind: 'whole'; readonly why: FollowWholeWhy };

/**
 * The body's liquid followed round a change inside `box` (the cells it can
 * have changed, world cells; see the module's comment). `owned` is what the
 * body owned before the change and is not changed; the answer's own set
 * replaces it.
 */
export function followBody(spec: LevelFillSpec, world: FillWorld, owned: CellSet, box: CellBox): BodyFollow {
  if (owned.size === 0) return { kind: 'whole', why: 'empty' };
  const start = bodyStart(spec);
  if (start === null || !owned.has(start[0], start[1], start[2]) || !isLiquidOf(world.value(start[0], start[1], start[2]), spec.material)) return { kind: 'whole', why: 'seed' };
  const top = Math.ceil(spec.level) - 1;
  const r = Math.ceil(spec.reach);
  const minX = Math.max(box.minX - 1, spec.seed[0] - r);
  const maxX = Math.min(box.maxX + 1, spec.seed[0] + r);
  const minZ = Math.max(box.minZ - 1, spec.seed[2] - r);
  const maxZ = Math.min(box.maxZ + 1, spec.seed[2] + r);
  const minY = box.minY - 1;
  const maxY = box.maxY + 1;
  const next = owned.clone();
  const under = (y: number): boolean => y < top || (y === top && fillShapeAt(spec.level, y) > 0);
  const holes: Array<[number, number, number]> = [];
  const candidates: Array<[number, number, number]> = [];
  const closed: Array<[number, number, number]> = [];
  const w = new Writes();
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      if (!withinReach(spec, x, z)) continue;
      for (let y = minY; y <= maxY; y++) {
        const v = world.value(x, y, z);
        if (v === FILL_OUTSIDE) continue;
        const stopped = world.stops?.(x, y, z) === true;
        if (next.has(x, y, z)) {
          if (stopped || (v !== 0 && !isLiquidOf(v, spec.material))) {
            closed.push([x, y, z]);
            next.delete(x, y, z);
            // Liquid a structure now stands over leaves the body (it would show through the walls).
            if (stopped && isLiquidOf(v, spec.material)) w.add(world, x, y, z, 0);
          } else if (v === 0) {
            next.delete(x, y, z);
            if (under(y)) holes.push([x, y, z]);
          }
        } else if (!stopped && under(y) && (v === 0 || isLiquidOf(v, spec.material))) candidates.push([x, y, z]);
      }
    }
  }
  if (closed.some(([x, y, z]) => x === start[0] && y === start[1] && z === start[2])) return { kind: 'whole', why: 'seed' };
  if (closed.length > 0 && !rejoins(next, closed, box)) return { kind: 'whole', why: 'cut' };
  const touches = ([x, y, z]: readonly [number, number, number]): boolean => SIDES.some(([dx, dy, dz]) => next.has(x + dx, y + dy, z + dz));
  const starts = [...holes, ...candidates.filter(touches)];
  const reached = new CellSet();
  const walk = walkFill(spec, world, starts, reached, next);
  if (walk.kinds.length > 0) return { kind: 'whole', why: 'breach' };
  const cells = walk.cells;
  for (let i = 0; i < cells.count; i++) {
    const x = cells.a[3 * i]!;
    const y = cells.a[3 * i + 1]!;
    const z = cells.a[3 * i + 2]!;
    w.add(world, x, y, z, liquidValue(spec.material, fillShapeAt(spec.level, y)));
    next.add(x, y, z);
  }
  // Liquid of the body's material the new water now touches (painted by hand, or a pool it joined) is the body's.
  const absorbFrom: Array<readonly [number, number, number]> = [];
  for (let i = 0; i < cells.count; i++) absorbFrom.push([cells.a[3 * i]!, cells.a[3 * i + 1]!, cells.a[3 * i + 2]!]);
  for (const c of candidates) if (next.has(c[0], c[1], c[2])) absorbFrom.push(c);
  absorbNew(spec, world, absorbFrom, next);
  return { kind: 'local', writes: w.done(), owned: next, added: cells.count, removed: closed.length };
}

/** {@link absorb} from cells already owned: their unowned neighbours of the body's liquid join. */
function absorbNew(spec: LevelFillSpec, world: FillWorld, from: readonly (readonly [number, number, number])[], owned: CellSet): void {
  const fresh: Array<[number, number, number]> = [];
  for (const [x, y, z] of from) {
    for (const [dx, dy, dz] of SIDES) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (owned.has(nx, ny, nz) || !withinReach(spec, nx, nz)) continue;
      const v = world.value(nx, ny, nz);
      if (v !== FILL_OUTSIDE && isLiquidOf(v, spec.material)) fresh.push([nx, ny, nz]);
    }
  }
  if (fresh.length > 0) absorb(spec, world, fresh, owned);
}

/**
 * Whether the owned cells round the closed ones still join one another
 * without leaving the change's box grown by {@link FOLLOW_CUT_MARGIN_CELLS}:
 * then every path through a closed cell can go round it, and the body is
 * one piece as before.
 */
function rejoins(owned: CellSet, closed: readonly (readonly [number, number, number])[], box: CellBox): boolean {
  const m = FOLLOW_CUT_MARGIN_CELLS;
  const inBox = (x: number, y: number, z: number): boolean => x >= box.minX - m && x <= box.maxX + m && y >= box.minY - m && y <= box.maxY + m && z >= box.minZ - m && z <= box.maxZ + m;
  const ends: Array<[number, number, number]> = [];
  const isEnd = new CellSet();
  for (const [x, y, z] of closed) {
    for (const [dx, dy, dz] of SIDES) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (owned.has(nx, ny, nz) && isEnd.add(nx, ny, nz)) ends.push([nx, ny, nz]);
    }
  }
  if (ends.length <= 1) return true;
  const seen = new CellSet();
  const q = new CellQueue();
  const [sx, sy, sz] = ends[0]!;
  seen.add(sx, sy, sz);
  q.push(sx, sy, sz);
  let found = 1;
  const at: [number, number, number] = [0, 0, 0];
  while (q.shift(at)) {
    const [x, y, z] = at;
    for (const [dx, dy, dz] of SIDES) {
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (!inBox(nx, ny, nz) || !owned.has(nx, ny, nz) || !seen.add(nx, ny, nz)) continue;
      if (isEnd.has(nx, ny, nz) && ++found === ends.length) return true;
      q.push(nx, ny, nz);
    }
  }
  return false;
}

/** Where a fill leaks, grouped a place per 16 m of ground: the mean of each group's cells (cell units, centres) and the bound it crossed (the reach where any did). */
export interface FillLeak {
  readonly at: readonly [number, number, number];
  readonly kind: 'reach' | 'world';
  readonly cells: number;
}

/** Cells of ground a leak place groups (along x and z). */
export const LEAK_GROUP_CELLS = 32;

/** The places a fill leaks, from its breaches ({@link FillLeak}), sorted by place. */
export function fillLeaks(fill: Pick<LevelFillResult, 'breaches' | 'breachKinds'>): FillLeak[] {
  const groups = new Map<string, { x: number; y: number; z: number; n: number; reach: boolean }>();
  const g = LEAK_GROUP_CELLS;
  for (let i = 0; i < fill.breachKinds.length; i++) {
    const x = fill.breaches[3 * i]!;
    const y = fill.breaches[3 * i + 1]!;
    const z = fill.breaches[3 * i + 2]!;
    const key = `${Math.floor(x / g)},${Math.floor(z / g)}`;
    let e = groups.get(key);
    if (e === undefined) groups.set(key, (e = { x: 0, y: 0, z: 0, n: 0, reach: false }));
    e.x += x + 0.5;
    e.y += y + 0.5;
    e.z += z + 0.5;
    e.n++;
    if (fill.breachKinds[i] === FILL_BREACH.reach) e.reach = true;
  }
  return [...groups.values()]
    .map((e) => ({ at: [e.x / e.n, e.y / e.n, e.z / e.n] as const, kind: e.reach ? ('reach' as const) : ('world' as const), cells: e.n }))
    .sort((a, b) => a.at[0] - b.at[0] || a.at[2] - b.at[2] || a.at[1] - b.at[1]);
}

