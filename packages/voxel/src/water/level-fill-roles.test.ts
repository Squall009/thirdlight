/**
 * The level fill with its role and fade as parameters: a liquid fill is the
 * fill water bodies always had (checked against the walk as it was before
 * the role was a parameter, kept here), and a gas, a fade, a drain and a
 * floor do what the module says.
 */
import { describe, expect, it } from 'vitest';
import { MATERIAL_ID_MAX, recordValue, ROLE_MASK, ROLE_SHIFT, SHAPE_FULL, VOXEL_ROLE } from '../record';
import { isGasRole } from '../role-traits';
import { CellQueue, CellSet } from './cell-set';
import { FILL_BREACH, FILL_OUTSIDE, fillShape, fillStartRow, fillTopRow, levelFill, type FillWorld, type LevelFillSpec } from './level-fill';

const WATER = 40;
const FOG = 50;
const ROCK = recordValue(7, VOXEL_ROLE.terrain, SHAPE_FULL, 0);

/** The liquid fill as it was written with the liquid role inside it: the answers a water body's fill must still give. */
function liquidFillBefore(spec: LevelFillSpec, world: FillWorld): { status: string; start: readonly number[] | null; cells: number[]; values: number[]; breaches: number[]; kinds: number[] } {
  const shapeAt = (level: number, y: number): number => {
    const share = level - y;
    if (share >= 1) return SHAPE_FULL;
    if (share <= 0) return 0;
    return Math.round(share * SHAPE_FULL);
  };
  const isLiquidOf = (v: number): boolean => v > 0 && ((v >>> ROLE_SHIFT) & ROLE_MASK) === VOXEL_ROLE.liquid && (v & MATERIAL_ID_MAX) === spec.material;
  const passes = (v: number): boolean => v === 0 || isLiquidOf(v) || (v > 0 && isGasRole((v >>> ROLE_SHIFT) & ROLE_MASK));
  const within = (x: number, z: number): boolean => (x - spec.seed[0]) ** 2 + (z - spec.seed[2]) ** 2 <= spec.reach * spec.reach;
  let top = Math.ceil(spec.level) - 1;
  const topFills = shapeAt(spec.level, top) > 0;
  let startRow = top;
  if (!topFills) startRow--;
  const none = { status: 'seed_blocked', start: null as readonly number[] | null, cells: [], values: [], breaches: [], kinds: [] };
  if (!Number.isFinite(startRow)) return none;
  const start = [spec.seed[0], Math.min(spec.seed[1], startRow), spec.seed[2]] as const;
  const sv = world.value(start[0], start[1], start[2]);
  if (sv === FILL_OUTSIDE || !passes(sv) || world.stops?.(start[0], start[1], start[2]) === true) return { ...none, start };
  const into = new CellSet();
  const met = new CellSet();
  const q = new CellQueue();
  const cells: number[] = [...start];
  const breaches: number[] = [];
  const kinds: number[] = [];
  into.add(start[0], start[1], start[2]);
  q.push(start[0], start[1], start[2]);
  const at: [number, number, number] = [0, 0, 0];
  const sides = [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1], [0, 0, 1], [0, 1, 0]] as const;
  top = Math.ceil(spec.level) - 1;
  while (q.shift(at)) {
    for (const [dx, dy, dz] of sides) {
      const nx = at[0] + dx;
      const ny = at[1] + dy;
      const nz = at[2] + dz;
      if (ny > top || (ny === top && !topFills)) continue;
      if (into.has(nx, ny, nz) || met.has(nx, ny, nz)) continue;
      const v = world.value(nx, ny, nz);
      if (v === FILL_OUTSIDE) {
        met.add(nx, ny, nz);
        breaches.push(nx, ny, nz);
        kinds.push(FILL_BREACH.world);
        continue;
      }
      if (!passes(v) || world.stops?.(nx, ny, nz) === true) continue;
      if (!within(nx, nz)) {
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
  const values: number[] = [];
  for (let i = 0; i < cells.length; i += 3) values.push(recordValue(spec.material, VOXEL_ROLE.liquid, shapeAt(spec.level, cells[i + 1]!), 0));
  return { status: kinds.length > 0 ? 'breached' : 'filled', start, cells, values, breaches, kinds };
}

/** A small made-up world from a seed: rolling ground, a few pillars, pools of this water, another water and fog, a roofed corner; round it the world's edge, or a wall of rock. */
function madeWorld(seed: number, size: number, walled: boolean): FillWorld {
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  const h: number[] = [];
  for (let i = 0; i < size * size; i++) h.push(1 + Math.floor(rnd() * 4) + (rnd() < 0.15 ? 5 : 0));
  const extra = new Map<string, number>();
  for (let i = 0; i < size * 2; i++) {
    const x = Math.floor(rnd() * size);
    const z = Math.floor(rnd() * size);
    const y = h[x * size + z]! + Math.floor(rnd() * 3);
    const pick = rnd();
    extra.set(`${x},${y},${z}`, pick < 0.3 ? recordValue(WATER, VOXEL_ROLE.liquid, 1 + Math.floor(rnd() * 15), 0) : pick < 0.5 ? recordValue(WATER + 1, VOXEL_ROLE.liquid, SHAPE_FULL, 0) : pick < 0.8 ? recordValue(FOG, VOXEL_ROLE.gas, 1 + Math.floor(rnd() * 15), 0) : recordValue(5, VOXEL_ROLE.opening, SHAPE_FULL, 0));
  }
  return {
    value: (x, y, z) => {
      if (x < 0 || z < 0 || x >= size || z >= size) return walled && y < 12 ? ROCK : FILL_OUTSIDE;
      if (y < -2) return FILL_OUTSIDE;
      const e = extra.get(`${x},${y},${z}`);
      if (e !== undefined) return e;
      return y < h[x * size + z]! ? ROCK : 0;
    },
    stops: (x, y, z) => x >= 2 && x <= 4 && z >= 2 && z <= 4 && y === 6,
  };
}

describe('the level fill, its role a parameter', () => {
  it('gives a liquid the cells, values, breaches and order it always gave (300 made worlds)', () => {
    let filled = 0;
    let breached = 0;
    let blocked = 0;
    for (let k = 0; k < 300; k++) {
      const size = 8 + (k % 9);
      const w = madeWorld(k * 7919 + 13, size, k % 2 === 1);
      const spec: LevelFillSpec = { seed: [k % size, (k * 3) % 9, (k * 5) % size], level: 1.5 + (k % 23) * 0.31, material: WATER, reach: k % 4 === 0 ? 3 + (k % 5) : 64 };
      const was = liquidFillBefore(spec, w);
      // Without a role, and with the liquid named: the same fill.
      for (const s of [spec, { ...spec, role: VOXEL_ROLE.liquid }]) {
        const now = levelFill(s, w);
        expect(now.status).toBe(was.status);
        expect(now.start === null ? null : [...now.start]).toEqual(was.start === null ? null : [...was.start]);
        expect([...now.cells]).toEqual(was.cells);
        expect([...now.values]).toEqual(was.values);
        expect([...now.breaches]).toEqual(was.breaches);
        expect([...now.breachKinds]).toEqual(was.kinds);
      }
      if (was.status === 'filled') filled++;
      else if (was.status === 'breached') breached++;
      else blocked++;
    }
    // The worlds reach every answer.
    expect(filled).toBeGreaterThan(10);
    expect(breached).toBeGreaterThan(50);
    expect(blocked).toBeGreaterThan(10);
  });

  /** An open box [0, 9]² with a rock floor at y ≤ 0 and the world's edge round it: nothing leaks under row 4. */
  const box = (extra?: (x: number, y: number, z: number) => number | undefined): FillWorld => ({
    value: (x, y, z) => {
      const e = extra?.(x, y, z);
      if (e !== undefined) return e;
      if (y <= 0 || x < 0 || z < 0 || x > 9 || z > 9) return ROCK;
      return 0;
    },
  });
  const gas = (level: number, more: Partial<LevelFillSpec> = {}): LevelFillSpec => ({ seed: [5, 1, 5], level, material: FOG, reach: 64, role: VOXEL_ROLE.gas, ...more });
  const shapes = (f: ReturnType<typeof levelFill>): Map<number, number> => {
    const rows = new Map<number, number>();
    for (let i = 0; i < f.values.length; i++) rows.set(f.cells[3 * i + 1]!, (f.values[i]! >>> 16) & 15);
    return rows;
  };

  it('writes a gas at full density, or fading to none at the level', () => {
    const full = levelFill(gas(3.5), box());
    expect(full.status).toBe('filled');
    expect(full.values.length).toBe(300);
    expect([...full.values].every((v) => v === recordValue(FOG, VOXEL_ROLE.gas, SHAPE_FULL, 0))).toBe(true);
    // A fade of 3 cells under a level of 4: centres 0.5, 1.5, 2.5 and 3.5 under it.
    const faded = levelFill(gas(4, { fade: 3 }), box((x, y) => (x === 5 && y <= 0 && y >= -3 ? 0 : undefined)));
    expect([...shapes(faded)].sort((a, b) => a[0] - b[0])).toEqual([[-3, 15], [-2, 15], [-1, 15], [0, 15], [1, 13], [2, 8], [3, 3]]);
    expect(fillShape(gas(4, { fade: 3 }), 3)).toBe(Math.round((0.5 / 3) * SHAPE_FULL));
    // Rows whose density rounds to none are not entered: the fill's top row is under them, and so is its start.
    const long = gas(4, { fade: 60, seed: [5, 3, 5] });
    expect(fillTopRow(long)).toBe(1);
    expect(fillStartRow(long)).toBe(1);
    expect([...shapes(levelFill(long, box()))]).toEqual([[1, 1]]);
  });

  it('bounds a gas by a liquid and by another gas, and passes its own', () => {
    const lake = recordValue(WATER, VOXEL_ROLE.liquid, SHAPE_FULL, 0);
    const other = recordValue(FOG + 1, VOXEL_ROLE.gas, 9, 0);
    const own = recordValue(FOG, VOXEL_ROLE.gas, 2, 0);
    const w = box((x, y, z) => (x < 0 || z < 0 || x > 9 || z > 9 || y <= 0 ? undefined : y === 1 ? lake : x === 9 ? other : x === 2 && y === 2 ? own : undefined));
    const f = levelFill(gas(4, { seed: [5, 2, 5] }), w);
    expect(f.status).toBe('filled');
    // Rows 2 and 3 over the lake, but the other gas's column: 90 cells a row, the thin own gas among them made full.
    expect(f.values.length).toBe(180);
    expect(f.set.has(2, 2, 5)).toBe(true);
    expect(f.set.has(9, 2, 5)).toBe(false);
    expect(f.set.has(5, 1, 5)).toBe(false);
    expect(levelFill(gas(4, { seed: [5, 1, 5] }), w).status).toBe('seed_blocked');
  });

  it('drains with air: every medium reached becomes air', () => {
    const w = box((x, y, z) => (x < 0 || z < 0 || x > 9 || z > 9 || y <= 0 ? undefined : y === 1 ? recordValue(WATER, VOXEL_ROLE.liquid, SHAPE_FULL, 0) : y === 2 && x < 5 ? recordValue(FOG, VOXEL_ROLE.gas, 7, 0) : undefined));
    const f = levelFill({ seed: [5, 2, 5], level: 3, material: 0, reach: 64, role: VOXEL_ROLE.air }, w);
    expect(f.status).toBe('filled');
    expect(f.values.length).toBe(200);
    expect([...f.values].every((v) => v === 0)).toBe(true);
    // The row above the level is not entered.
    expect(f.set.has(5, 3, 5)).toBe(false);
  });

  it('holds a floor: an open cell under it is a breach of the reach, and none is entered', () => {
    const w = box((x, y, z) => (x === 5 && z === 5 && y <= 0 && y >= -6 ? 0 : undefined));
    const free = levelFill({ seed: [5, 1, 5], level: 3, material: WATER, reach: 64 }, w);
    expect(free.status).toBe('filled');
    expect(free.values.length).toBe(200 + 7);
    const floored = levelFill({ seed: [5, 1, 5], level: 3, material: WATER, reach: 64, floor: -3 }, w);
    expect(floored.status).toBe('breached');
    expect([...floored.breaches]).toEqual([5, -4, 5]);
    expect([...floored.breachKinds]).toEqual([FILL_BREACH.reach]);
    expect(floored.set.has(5, -3, 5)).toBe(true);
    expect(floored.set.has(5, -4, 5)).toBe(false);
  });
});
