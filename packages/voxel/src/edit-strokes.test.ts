/**
 * The strokes of command version 3 on made cases: a flood to a level (a
 * basin, a breached basin, the reach, the world's edge, a drain), the brush
 * modes smooth and flatten, and a paint that keeps each cell's role; each
 * deterministic, with an exact undo and redo; version 2 read as before.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid, chunkOfKey, WORLD_CELL_MAX_XZ } from './coords';
import { applyEdit, applyUndo, editBounds, editChunks, EditRefused, type EditOutcome } from './edit-apply';
import { canonicalEditCommand, EditCommandError, VOXEL_EDIT_VERSION, type VoxelEditCommand } from './edit-command';
import { createWorldStore, type PaletteStore } from './palette-store';
import { DERIVED_PART, readValue, recordValue, SHAPE_FULL, valueMaterial, valueOf, valueRole, valueShape, valueWetness, VOXEL_ROLE, type VoxelRecord } from './record';

const grid = chunkGrid(32);
const ROCK_M = 7;
const WATER = 40;
const FOG = 50;
const ROCK = recordValue(ROCK_M, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
const WALL = recordValue(5, VOXEL_ROLE.wall, SHAPE_FULL, 0);

type Box = readonly [number, number, number, number, number, number];

function build(fill: (x: number, y: number, z: number) => number, box: Box): PaletteStore {
  const store = createWorldStore(grid, 'pick');
  const r: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const [x0, y0, z0, x1, y1, z1] = box;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    const v = fill(x, y, z);
    if (v !== 0) store.setVoxel(x, y, z, readValue(v, r));
  }
  return store;
}

const scratch: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
const at = (store: PaletteStore, x: number, y: number, z: number): number => valueOf(store.voxelAt(x, y, z, scratch));

/** Every cell's value in a box: what two worlds are compared by, byte for byte. */
function dump(store: PaletteStore, box: Box): Uint8Array {
  const [x0, y0, z0, x1, y1, z1] = box;
  const out = new Uint32Array((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1));
  let i = 0;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out[i++] = at(store, x, y, z);
  return new Uint8Array(out.buffer);
}

/** Whether two dumps are the same bytes. */
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The store's own bytes, chunk by chunk in key order. */
function chunkBytes(store: PaletteStore): string {
  const keys = [...store.chunkKeys()].sort((a, b) => a - b);
  return keys
    .map((k) => {
      const c = chunkOfKey(grid, k);
      return `${k}:${[...(store.encodeChunk(c.cx, c.cy, c.cz) ?? new Uint8Array(0))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
    })
    .join('|');
}

const grids = (store: PaletteStore) => ({ store: (g: number) => (g === 0 ? store : undefined) });
const run = (store: PaletteStore, cmd: unknown): EditOutcome => applyEdit(grids(store), canonicalEditCommand(cmd));

/** Applies, checks the undo gives the first bytes back and the redo the second, and that a twin world gets the same bytes. */
function proven(make: () => PaletteStore, cmd: unknown, box: Box): { store: PaletteStore; out: EditOutcome } {
  const store = make();
  const before = dump(store, box);
  const out = run(store, cmd);
  const after = dump(store, box);
  expect(out.cells).toBeGreaterThan(0);
  expect(same(before, after)).toBe(false);
  // Deterministic: an equal world, the same command, equal bytes (cells and the store's own chunks).
  const twin = make();
  run(twin, cmd);
  expect(same(dump(twin, box), after)).toBe(true);
  expect(chunkBytes(twin)).toBe(chunkBytes(store));
  // Undo exact, redo exact.
  applyUndo(grids(store), out.chunks);
  expect(same(dump(store, box), before)).toBe(true);
  const again = run(store, cmd);
  expect(same(dump(store, box), after)).toBe(true);
  expect(again.cells).toBe(out.cells);
  return { store, out };
}

/** A square basin: rock at y ≤ 0, walls of height `wall` round an inside of [1, n]², open air round it. */
const basin = (n: number, wall: number, hole?: readonly [number, number, number]) => (x: number, y: number, z: number): number => {
  if (y <= 0) return ROCK;
  if (hole !== undefined && x === hole[0] && y === hole[1] && z === hole[2]) return 0;
  const inside = x >= 1 && x <= n && z >= 1 && z <= n;
  const rim = x >= 0 && x <= n + 1 && z >= 0 && z <= n + 1;
  return !inside && rim && y <= wall ? ROCK : 0;
};
const BASIN: Box = [-24, -2, -24, 36, 9, 36];
const makeBasin = (hole?: readonly [number, number, number]) => () => build(basin(10, 6, hole), BASIN);

const flood = (value: { material: number; role: number }, level: number, more: Record<string, unknown> = {}): Record<string, unknown> => ({ v: 3, grid: 0, kind: 'flood', seed: [5, 2, 5], level, value, reach: 16, ...more });

function count(store: PaletteStore, box: Box, pick: (v: number) => boolean): number {
  let n = 0;
  const [x0, y0, z0, x1, y1, z1] = box;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) if (pick(at(store, x, y, z))) n++;
  return n;
}

describe('command version 3: what it reads', () => {
  it('writes version 3 and reads version 2 as it was', () => {
    expect(VOXEL_EDIT_VERSION).toBe(3);
    const v2 = { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 9, 9], points: [1, 2, 3], mode: 'add', voxel: { material: 3, role: 1, wetness: 0 }, smooth: true };
    expect(canonicalEditCommand(v2)).toEqual({ ...v2, size: [2, 2, 2] });
    expect(canonicalEditCommand({ v: 2, grid: 0, kind: 'dig', cells: [3, 0, 0, 1, 0, 0] })).toEqual({ v: 2, grid: 0, kind: 'dig', cells: [1, 0, 0, 3, 0, 0] });
    // The same stroke sent as version 3 is the same stroke, and stays version 3.
    expect(canonicalEditCommand({ ...v2, v: 3 })).toEqual({ ...v2, v: 3, size: [2, 2, 2] });
    expect(() => canonicalEditCommand({ ...v2, v: 4 })).toThrow(EditCommandError);
    expect(() => canonicalEditCommand({ ...v2, v: 1 })).toThrow(EditCommandError);
  });

  it('refuses in version 2 everything version 3 added', () => {
    const brush = { v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [1, 2, 3], smooth: false };
    expect(() => canonicalEditCommand({ ...flood({ material: WATER, role: VOXEL_ROLE.liquid }, 4), v: 2 })).toThrow(/kind/);
    expect(() => canonicalEditCommand({ ...brush, mode: 'smooth' })).toThrow(/mode/);
    expect(() => canonicalEditCommand({ ...brush, mode: 'flatten', height: 3 })).toThrow(/height|mode/);
    expect(() => canonicalEditCommand({ ...brush, mode: 'paint', voxel: { material: 3, wetness: 0 } })).toThrow(/role/);
    // And a version 2 paint with its role is the paint it always was.
    expect(canonicalEditCommand({ ...brush, mode: 'paint', voxel: { material: 3, role: 4, wetness: 0 } }).v).toBe(2);
  });

  it('holds a flood to its fields', () => {
    const ok = canonicalEditCommand(flood({ material: FOG, role: VOXEL_ROLE.gas }, 4, { fade: 1.5 }));
    expect(ok).toEqual({ v: 3, grid: 0, kind: 'flood', seed: [5, 2, 5], level: 4, value: { material: FOG, role: VOXEL_ROLE.gas }, reach: 16, fade: 1.5 });
    expect(canonicalEditCommand(flood({ material: 0, role: 0 }, 4))).toMatchObject({ value: { material: 0, role: 0 } });
    // A body role is no flood value; air is one value; only a gas fades; a fade is more than nothing.
    for (const role of [VOXEL_ROLE.terrain, VOXEL_ROLE.wall, VOXEL_ROLE.opening, VOXEL_ROLE.air]) expect(() => canonicalEditCommand(flood({ material: 3, role }, 4))).toThrow(/medium/);
    expect(() => canonicalEditCommand(flood({ material: 0, role: VOXEL_ROLE.gas }, 4))).toThrow(/role/);
    expect(() => canonicalEditCommand(flood({ material: WATER, role: VOXEL_ROLE.liquid }, 4, { fade: 1 }))).toThrow(/fade/);
    expect(() => canonicalEditCommand(flood({ material: 0, role: 0 }, 4, { fade: 1 }))).toThrow(/fade/);
    expect(() => canonicalEditCommand(flood({ material: FOG, role: VOXEL_ROLE.gas }, 4, { fade: 0 }))).toThrow(/fade/);
    expect(() => canonicalEditCommand(flood({ material: FOG, role: VOXEL_ROLE.gas }, 4, { reach: -1 }))).toThrow(/reach/);
    expect(() => canonicalEditCommand(flood({ material: FOG, role: VOXEL_ROLE.gas }, 4, { seed: [5, 2.5, 5] }))).toThrow(/seed/);
    expect(() => canonicalEditCommand(flood({ material: FOG, role: VOXEL_ROLE.gas }, 4, { mode: 'add' }))).toThrow(/unknown field/);
    expect(() => canonicalEditCommand(flood({ material: FOG, role: VOXEL_ROLE.gas, wetness: 0 } as never, 4))).toThrow(/unknown field/);
  });

  it('holds the brush modes to their fields', () => {
    const brush = { v: 3, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [1, 2, 3], smooth: true };
    expect(canonicalEditCommand({ ...brush, mode: 'smooth' })).toEqual({ ...brush, mode: 'smooth' });
    expect(canonicalEditCommand({ ...brush, mode: 'flatten', height: 3.5 })).toEqual({ ...brush, mode: 'flatten', height: 3.5 });
    expect(canonicalEditCommand({ ...brush, mode: 'smooth', voxel: { material: FOG, role: VOXEL_ROLE.gas, wetness: 0 } })).toMatchObject({ voxel: { material: FOG, role: VOXEL_ROLE.gas } });
    expect(() => canonicalEditCommand({ ...brush, mode: 'flatten' })).toThrow(/height/);
    expect(() => canonicalEditCommand({ ...brush, mode: 'flatten', height: 3, voxel: { material: 3, role: 1, wetness: 0 } })).toThrow(/voxel/);
    expect(() => canonicalEditCommand({ ...brush, mode: 'smooth', height: 3 })).toThrow(/height/);
    expect(() => canonicalEditCommand({ ...brush, mode: 'add', height: 3, voxel: { material: 3, role: 1, wetness: 0 } })).toThrow(/height/);
    expect(() => canonicalEditCommand({ ...brush, mode: 'smooth', voxel: { material: 3, role: VOXEL_ROLE.terrain, wetness: 0 } })).toThrow(/gas/);
    expect(() => canonicalEditCommand({ ...brush, mode: 'smooth', voxel: { material: WATER, role: VOXEL_ROLE.liquid, wetness: 0 } })).toThrow(/gas/);
    // Only a brush smooths or flattens.
    expect(() => canonicalEditCommand({ v: 3, grid: 0, kind: 'fill', min: [0, 0, 0], max: [1, 1, 1], mode: 'smooth' })).toThrow(/mode/);
    // A paint may leave the role out; no other mode may.
    expect(canonicalEditCommand({ ...brush, smooth: false, mode: 'paint', voxel: { material: 3, wetness: 2 } })).toMatchObject({ voxel: { material: 3, wetness: 2 } });
    expect(() => canonicalEditCommand({ ...brush, mode: 'add', voxel: { material: 3, wetness: 2 } })).toThrow(/role/);
    expect(() => canonicalEditCommand({ ...brush, smooth: false, mode: 'place', voxel: { material: 3, wetness: 2 } })).toThrow(/role/);
  });
});

describe('flood', () => {
  const LIQUID = { material: WATER, role: VOXEL_ROLE.liquid };
  const GAS = { material: FOG, role: VOXEL_ROLE.gas };

  it('fills a basin to a level with liquid: full rows under it, the level\'s own row to the level', () => {
    const { store, out } = proven(makeBasin(), flood(LIQUID, 3.5), BASIN);
    expect(out.cells).toBe(300);
    for (const [y, shape] of [[1, SHAPE_FULL], [2, SHAPE_FULL], [3, 8]] as const) {
      expect(at(store, 5, y, 5)).toBe(recordValue(WATER, VOXEL_ROLE.liquid, shape, 0));
      expect(at(store, 10, y, 1)).toBe(recordValue(WATER, VOXEL_ROLE.liquid, shape, 0));
    }
    expect(at(store, 5, 4, 5)).toBe(0);
    expect(count(store, BASIN, (v) => valueRole(v) === VOXEL_ROLE.liquid)).toBe(300);
    // Only liquid moved: the liquid part alone is made again.
    expect(out.parts).toBe(DERIVED_PART.liquid);
  });

  it('fills a basin with gas at full density, and answers the gas part alone', () => {
    const { store, out } = proven(makeBasin(), flood(GAS, 4), BASIN);
    expect(out.cells).toBe(300);
    expect(count(store, BASIN, (v) => v === recordValue(FOG, VOXEL_ROLE.gas, SHAPE_FULL, 0))).toBe(300);
    expect(out.parts).toBe(DERIVED_PART.gas);
  });

  it('fades a gas: full density a fade under the level, none at the level, read at each cell\'s centre', () => {
    // A fade of 1 m is 2 cells: centres 2.5, 1.5 and 0.5 cells under the level hold 15, round(11.25) and round(3.75).
    const { store, out } = proven(makeBasin(), flood(GAS, 4, { fade: 1 }), BASIN);
    expect([1, 2, 3, 4].map((y) => valueShape(at(store, 5, y, 5)))).toEqual([SHAPE_FULL, 11, 4, 0]);
    expect(out.parts).toBe(DERIVED_PART.gas);
    // A fade so long that the top rows round to none: they are not filled, and the fill starts under them.
    const long = makeBasin()();
    run(long, flood(GAS, 4, { fade: 30, seed: [5, 3, 5] }));
    // 60 cells of fade: a centre 0.5 under holds round(0.125) = 0, 1.5 under round(0.375) = 0, 2.5 under round(0.625) = 1.
    expect([1, 2, 3].map((y) => valueShape(at(long, 5, y, 5)))).toEqual([1, 0, 0]);
  });

  it('drains with air: the same seed and level take a flood back, liquid or gas', () => {
    for (const value of [LIQUID, GAS]) {
      const store = makeBasin()();
      const dry = dump(store, BASIN);
      run(store, flood(value, 3.5));
      const { out } = proven(() => {
        const s = makeBasin()();
        run(s, flood(value, 3.5));
        return s;
      }, flood({ material: 0, role: 0 }, 3.5), BASIN);
      run(store, flood({ material: 0, role: 0 }, 3.5));
      expect(same(dump(store, BASIN), dry)).toBe(true);
      expect(out.parts).toBe(value === GAS ? DERIVED_PART.gas : DERIVED_PART.liquid);
    }
    // Nothing to drain: no cell changes (the command layer's no_change).
    expect(run(makeBasin()(), flood({ material: 0, role: 0 }, 3.5)).cells).toBe(0);
  });

  it('refuses a breached basin and names where it leaks, writing nothing', () => {
    const store = makeBasin([11, 1, 5])();
    const before = dump(store, BASIN);
    let refusal: EditRefused | null = null;
    try {
      run(store, flood(LIQUID, 3.5));
    } catch (e) {
      refusal = e as EditRefused;
    }
    expect(refusal).toBeInstanceOf(EditRefused);
    expect(refusal!.code).toBe('flood_leaks');
    expect(same(dump(store, BASIN), before)).toBe(true);
    const leaks = refusal!.leaks!;
    expect(leaks.length).toBeGreaterThan(0);
    // Out of the hole the water runs over the open ground to the reach: every place named lies just past it, in the rows under the level.
    for (const l of leaks) {
      expect(l.kind).toBe('reach');
      expect(l.cells).toBeGreaterThan(0);
      expect(l.at[1]).toBeGreaterThan(1);
      expect(l.at[1]).toBeLessThan(4);
      const d = Math.hypot(l.at[0] - 5.5, l.at[2] - 5.5);
      expect(d).toBeGreaterThan(12);
      expect(d).toBeLessThan(18.5);
    }
    expect(refusal!.message).toMatch(/leaks in \d+ places?: past its reach near cell \(/);
    // The hole closed, the same flood fills.
    store.setVoxel(11, 1, 5, readValue(ROCK, { material: 0, role: 0, shape: 0, wetness: 0 }));
    expect(run(store, flood(LIQUID, 3.5)).cells).toBe(300);
  });

  it('refuses where it meets the reach inside a sound basin, sideways and downward', () => {
    const tight = makeBasin()();
    expect(() => run(tight, flood(LIQUID, 3.5, { reach: 3 }))).toThrow(/past its reach/);
    // A shaft under the seed deeper than the reach: the reach bounds the rows under the start cell too.
    const shaft = () => build((x, y, z) => (x === 5 && z === 5 && y <= 0 && y >= -20 ? 0 : y < -20 ? ROCK : basin(10, 6)(x, y, z)), [-24, -24, -24, 36, 9, 36]);
    let refusal: EditRefused | null = null;
    try {
      run(shaft(), flood(LIQUID, 3.5, { reach: 8 }));
    } catch (e) {
      refusal = e as EditRefused;
    }
    expect(refusal?.code).toBe('flood_leaks');
    // The start cell is row 2: the floor is row −6, and the leak the cell under it.
    expect(refusal!.leaks).toEqual([{ at: [5.5, -6.5, 5.5], kind: 'reach', cells: 1 }]);
    // Deep enough a reach, and the shaft fills with the basin.
    expect(run(shaft(), flood(LIQUID, 3.5, { reach: 24 })).cells).toBe(300 + 21);
  });

  it('refuses at the world\'s edge', () => {
    const E = WORLD_CELL_MAX_XZ;
    // A trough open only toward the world's edge.
    const store = build((x, y, z) => (y <= 0 ? ROCK : (x === E - 13 || z === -6 || z === 6) && y <= 6 ? ROCK : 0), [E - 13, -1, -6, E, 8, 6]);
    let refusal: EditRefused | null = null;
    try {
      run(store, { v: 3, grid: 0, kind: 'flood', seed: [E - 6, 1, 0], level: 3, value: LIQUID, reach: 30 });
    } catch (e) {
      refusal = e as EditRefused;
    }
    expect(refusal?.code).toBe('flood_leaks');
    expect(refusal!.leaks!.length).toBeGreaterThan(0);
    for (const l of refusal!.leaks!) {
      expect(l.kind).toBe('world');
      expect(l.at[0]).toBe(E + 1.5);
    }
    expect(refusal!.message).toMatch(/past the world's edge/);
    expect(count(store, [E - 13, 1, -6, E, 8, 6], (v) => valueRole(v) === VOXEL_ROLE.liquid)).toBe(0);
  });

  it('refuses a start cell that is not open, and passes what each medium passes', () => {
    expect(() => run(makeBasin()(), flood(LIQUID, 3.5, { seed: [5, 0, 5] }))).toThrow(/not open/);
    try {
      run(makeBasin()(), flood(LIQUID, 3.5, { seed: [5, 0, 5] }));
    } catch (e) {
      expect((e as EditRefused).code).toBe('flood_blocked');
    }
    // Water takes fog's cells; fog lies on water and takes none of it.
    const store = makeBasin()();
    run(store, flood(GAS, 5));
    run(store, flood(LIQUID, 3));
    expect([1, 2, 3, 4].map((y) => valueRole(at(store, 5, y, 5)))).toEqual([VOXEL_ROLE.liquid, VOXEL_ROLE.liquid, VOXEL_ROLE.gas, VOXEL_ROLE.gas]);
    expect(() => run(store, flood(GAS, 5, { seed: [5, 1, 5] }))).toThrow(/not open/);
    // A drain takes both.
    run(store, flood({ material: 0, role: 0 }, 5));
    expect(count(store, BASIN, (v) => v !== 0 && valueRole(v) !== VOXEL_ROLE.terrain)).toBe(0);
  });

  it('tells its cells from the command alone, and is bounded by the undo budget', () => {
    const cmd = canonicalEditCommand(flood(LIQUID, 3.5));
    // The reach's square with the ring where a bound is met, from under the floor (start row 2 − 16) to the level's row.
    expect(editBounds(grid, cmd)).toEqual({ minX: -12, maxX: 22, minZ: -12, maxZ: 22, minY: -15, maxY: 3 });
    expect(editChunks(grid, cmd).length).toBe(2 * 2 * 2);
    expect(() => editChunks(grid, canonicalEditCommand(flood(LIQUID, 3.5, { reach: 4000 })))).toThrow(/budget/);
    // Every chunk it can read must be loaded: a flood is never applied on part of its cells.
    expect(() => applyEdit(grids(makeBasin()()), cmd, { loaded: (_g, cx) => cx === 0 })).toThrow(/not loaded/);
  });

  it('runs on a structure\'s grid as on the world\'s', () => {
    const store = makeBasin()();
    const cmd = canonicalEditCommand({ ...flood(GAS, 4), grid: 7 });
    const out = applyEdit({ store: (g) => (g === 7 ? store : undefined) }, cmd);
    expect(out.cells).toBe(300);
    expect(out.chunks.every((c) => c.grid === 7)).toBe(true);
  });
});

/** Ground whose height (cells) is `h(x, z)` over [0, 16]², rock under it; the top cell holds the height's fraction. */
const ground = (h: (x: number, z: number) => number, material = ROCK_M) => (x: number, y: number, z: number): number => {
  const f = h(x, z) - y;
  if (f <= 0) return 0;
  return recordValue(material, VOXEL_ROLE.terrain, f >= 1 ? SHAPE_FULL : Math.max(1, Math.round(f * SHAPE_FULL)), 0);
};
const FIELD: Box = [-4, -4, -4, 20, 14, 20];

/** A column's surface height: its highest ground cell's row plus its fill. */
function heightAt(store: PaletteStore, x: number, z: number): number {
  for (let y = FIELD[4]; y >= FIELD[1]; y--) {
    const v = at(store, x, y, z);
    if (v !== 0 && valueRole(v) === VOXEL_ROLE.terrain) return y + valueShape(v) / SHAPE_FULL;
  }
  return NaN;
}

describe('smooth', () => {
  const cliff = () => build(ground((x) => (x < 8 ? 4 : 8)), FIELD);
  const stroke = { v: 3, grid: 0, kind: 'brush', shape: 'sphere', size: [6, 6, 6], points: [8, 6, 8], mode: 'smooth', smooth: true };

  it('relaxes a cliff into a slope: the step shrinks, the profile stays in order, the ground is kept', () => {
    const { store, out } = proven(cliff, stroke, FIELD);
    const row = (s: PaletteStore): number[] => Array.from({ length: 17 }, (_, x) => heightAt(s, x, 8));
    const before = row(cliff());
    const after = row(store);
    const step = (h: number[]): number => Math.max(...h.slice(1).map((v, i) => Math.abs(v - h[i]!)));
    expect(step(before)).toBe(4);
    expect(step(after)).toBeLessThan(3);
    // The low side rose, the high side fell, nothing overshot, and the profile still climbs.
    for (let x = 0; x <= 16; x++) {
      if (x < 8) expect(after[x]!).toBeGreaterThanOrEqual(4);
      else expect(after[x]!).toBeLessThanOrEqual(8);
      expect(after[x]!).toBeGreaterThanOrEqual(4);
      expect(after[x]!).toBeLessThanOrEqual(8);
      if (x > 0) expect(after[x]!).toBeGreaterThanOrEqual(after[x - 1]!);
    }
    expect(after[7]!).toBeGreaterThan(4);
    expect(after[8]!).toBeLessThan(8);
    // Far from the brush nothing moved.
    expect(after[0]).toBe(4);
    expect(after[16]).toBe(8);
    // The ground's volume is kept to within the fill's rounding (a fifteenth of a cell a column moved).
    let sumBefore = 0;
    let sumAfter = 0;
    let moved = 0;
    const flat = cliff();
    for (let x = 0; x <= 16; x++) for (let z = 0; z <= 16; z++) {
      const a = heightAt(flat, x, z);
      const b = heightAt(store, x, z);
      sumBefore += a;
      sumAfter += b;
      if (a !== b) moved++;
    }
    expect(moved).toBeGreaterThan(20);
    expect(Math.abs(sumAfter - sumBefore)).toBeLessThanOrEqual(moved / SHAPE_FULL);
    // New ground is the ground it grew from; a second stroke relaxes further and never roughens.
    expect(count(store, FIELD, (v) => v !== 0 && (valueRole(v) !== VOXEL_ROLE.terrain || valueMaterial(v) !== ROCK_M))).toBe(0);
    run(store, stroke);
    expect(step(row(store))).toBeLessThanOrEqual(step(after));
    expect(out.parts & DERIVED_PART.mesh).toBe(DERIVED_PART.mesh);
  });

  it('leaves flat ground as it is', () => {
    expect(run(build(ground(() => 5.4), FIELD), stroke).cells).toBe(0);
  });

  it('leaves built cells, and the ground under them, alone', () => {
    // A wall across the cliff's foot and a floor slab over the high side.
    const made = () => build((x, y, z) => (x === 6 && y >= 4 && y <= 9 ? WALL : x >= 10 && x <= 12 && y === 8 && z >= 6 && z <= 10 ? recordValue(5, VOXEL_ROLE.floor, SHAPE_FULL, 0) : ground((gx) => (gx < 8 ? 4 : 8))(x, y, z)), FIELD);
    const { store } = proven(made, stroke, FIELD);
    const first = made();
    for (let y = FIELD[1]; y <= FIELD[4]; y++) for (let z = FIELD[2]; z <= FIELD[5]; z++) {
      // The wall's column: every cell as it was (the wall, and the ground it stands on).
      expect(at(store, 6, y, z)).toBe(at(first, 6, y, z));
      // The slab's columns too.
      if (z >= 6 && z <= 10) for (const x of [10, 11, 12]) expect(at(store, x, y, z)).toBe(at(first, x, y, z));
    }
    expect(count(store, FIELD, (v) => valueRole(v) === VOXEL_ROLE.wall)).toBe(count(first, FIELD, (v) => valueRole(v) === VOXEL_ROLE.wall));
  });

  it('relaxes a gas\'s density, in air and that gas only, and answers the gas part alone', () => {
    const OTHER = recordValue(FOG + 1, VOXEL_ROLE.gas, SHAPE_FULL, 0);
    const made = () => build((x, y, z) => (y <= 4 ? ROCK : x >= 6 && x <= 10 && z >= 6 && z <= 10 && y <= 7 ? recordValue(FOG, VOXEL_ROLE.gas, SHAPE_FULL, 0) : x === 12 && y === 5 ? OTHER : 0), FIELD);
    const gas = { ...stroke, points: [8, 7, 8], voxel: { material: FOG, role: VOXEL_ROLE.gas, wetness: 0 } };
    const { store, out } = proven(made, gas, FIELD);
    expect(out.parts).toBe(DERIVED_PART.gas);
    const first = made();
    // The bank's edge thinned, the air beside it took some, its middle on the ground is as dense as it was.
    expect(valueShape(at(store, 10, 7, 8))).toBeLessThan(SHAPE_FULL);
    expect(valueShape(at(store, 11, 6, 8))).toBeGreaterThan(0);
    expect(valueMaterial(at(store, 11, 6, 8))).toBe(FOG);
    expect(at(store, 8, 5, 8)).toBe(at(first, 8, 5, 8));
    // Density is roughly kept (each cell rounds to a sixteenth).
    const density = (s: PaletteStore): number => {
      let n = 0;
      for (let x = FIELD[0]; x <= FIELD[3]; x++) for (let y = FIELD[1]; y <= FIELD[4]; y++) for (let z = FIELD[2]; z <= FIELD[5]; z++) {
        const v = at(s, x, y, z);
        if (v !== 0 && valueMaterial(v) === FOG) n += valueShape(v);
      }
      return n;
    };
    expect(Math.abs(density(store) - density(first)) / density(first)).toBeLessThan(0.1);
    // Ground and the other gas are as they were.
    expect(count(store, FIELD, (v) => v === ROCK)).toBe(count(first, FIELD, (v) => v === ROCK));
    expect(count(store, FIELD, (v) => v === OTHER)).toBe(count(first, FIELD, (v) => v === OTHER));
    expect(count(store, FIELD, (v) => v !== 0 && valueRole(v) === VOXEL_ROLE.gas && valueWetness(v) !== 0)).toBe(0);
  });
});

describe('flatten', () => {
  const mound = () => build(ground((x, z) => 4 + Math.max(0, 3 - 0.75 * Math.hypot(x - 8, z - 8))), FIELD);
  const stroke = { v: 3, grid: 0, kind: 'brush', shape: 'cylinder', size: [6, 4, 6], points: [8, 5, 8], mode: 'flatten', height: 4, smooth: false };

  it('takes a mound down to the plane under a hard brush', () => {
    expect(heightAt(mound(), 8, 8)).toBe(7);
    const { store } = proven(mound, stroke, FIELD);
    for (let x = 0; x <= 16; x++) for (let z = 0; z <= 16; z++) expect(heightAt(store, x, z)).toBe(4);
    expect(count(store, FIELD, (v) => v !== 0 && v !== ROCK)).toBe(0);
  });

  it('raises a pit to the plane with the ground\'s own material, wetness and role', () => {
    const WET = recordValue(9, VOXEL_ROLE.terrain, SHAPE_FULL, 3);
    const pit = () => build((x, y, z) => {
      const h = 4 - Math.max(0, 2.5 - 0.75 * Math.hypot(x - 8, z - 8));
      const v = ground(() => h, 9)(x, y, z);
      return v === 0 ? 0 : recordValue(9, VOXEL_ROLE.terrain, valueShape(v), 3);
    }, FIELD);
    expect(heightAt(pit(), 8, 8)).toBeCloseTo(1.5, 1);
    const { store } = proven(pit, stroke, FIELD);
    for (let x = 0; x <= 16; x++) for (let z = 0; z <= 16; z++) expect(heightAt(store, x, z)).toBe(4);
    expect(at(store, 8, 3, 8)).toBe(WET);
    expect(at(store, 8, 4, 8)).toBe(0);
  });

  it('moves part of the way under a soft rim, and to a plane between rows', () => {
    const soft = { ...stroke, shape: 'sphere', size: [5, 5, 5], points: [8.5, 5, 8.5], smooth: true, height: 4.4 };
    const { store } = proven(mound, soft, FIELD);
    // Full weight at the middle: on the plane, to the fill's sixteenth.
    expect(heightAt(store, 8, 8)).toBeCloseTo(4.4, 1);
    expect(valueShape(at(store, 8, 4, 8))).toBe(6);
    // A column at the rim (its cells' centres 5.02 cells from the dab: 0.475 covered) moved less than half of the way up from 4.
    const first = mound();
    expect(heightAt(first, 13, 8)).toBe(4);
    expect(heightAt(store, 13, 8)).toBeCloseTo(4 + 3 / SHAPE_FULL, 6);
    expect(heightAt(store, 0, 8)).toBe(heightAt(first, 0, 8));
    // The same brush hard: the rim's column is under half covered and stays.
    const hard = mound();
    run(hard, { ...soft, smooth: false });
    expect(heightAt(hard, 13, 8)).toBe(4);
    expect(heightAt(hard, 12, 8)).toBeCloseTo(4.4, 1);
  });

  it('moves the ground only inside the brush\'s rows, and leaves built columns', () => {
    // A brush two rows tall over a mound 3 high: it cuts down to its own bottom, no further.
    const thin = { ...stroke, size: [6, 1, 6], points: [8, 6.5, 8], height: 0 };
    const store = mound();
    run(store, thin);
    expect(heightAt(store, 8, 8)).toBe(5);
    const made = () => build((x, y, z) => (x === 8 && z === 8 && y >= 4 && y <= 8 ? WALL : ground(() => 6)(x, y, z)), FIELD);
    // A wall standing in the ground: the plane lies under its foot, the ground round it comes down, its own column stays whole.
    const built = made();
    run(built, { ...stroke, height: 2 });
    expect(heightAt(built, 7, 8)).toBe(2);
    for (let y = FIELD[1]; y <= FIELD[4]; y++) expect(at(built, 8, y, 8)).toBe(at(made(), 8, y, 8));
    expect(at(built, 8, 3, 8)).toBe(ROCK);
  });
});

describe('a paint that keeps each cell\'s role', () => {
  const made = () => build((x, y) => {
    if (y !== 0) return 0;
    if (x === 0) return recordValue(3, VOXEL_ROLE.terrain, 9, 1);
    if (x === 1) return recordValue(5, VOXEL_ROLE.wall, SHAPE_FULL, 0);
    if (x === 2) return recordValue(5, VOXEL_ROLE.roof, 4, 0);
    if (x === 3) return recordValue(WATER, VOXEL_ROLE.liquid, 6, 0);
    if (x === 4) return recordValue(FOG, VOXEL_ROLE.gas, 11, 0);
    return 0;
  }, [0, 0, 0, 6, 0, 0]);
  const BOX: Box = [0, 0, 0, 6, 0, 0];

  it('changes material and wetness, and leaves role and shape, over ground, built cells, a liquid and a gas', () => {
    const { store, out } = proven(made, { v: 3, grid: 0, kind: 'fill', min: [0, 0, 0], max: [6, 0, 0], mode: 'paint', voxel: { material: 12, wetness: 2 } }, BOX);
    expect(out.cells).toBe(5);
    expect([0, 1, 2, 3, 4, 5].map((x) => at(store, x, 0, 0))).toEqual([
      recordValue(12, VOXEL_ROLE.terrain, 9, 2),
      recordValue(12, VOXEL_ROLE.wall, SHAPE_FULL, 2),
      recordValue(12, VOXEL_ROLE.roof, 4, 2),
      recordValue(12, VOXEL_ROLE.liquid, 6, 2),
      // A gas holds no wetness.
      recordValue(12, VOXEL_ROLE.gas, 11, 0),
      0,
    ]);
    // By a brush too.
    const b = made();
    run(b, { v: 3, grid: 0, kind: 'brush', shape: 'box', size: [1, 0.5, 0.5], points: [1.5, 0.5, 0.5], mode: 'paint', voxel: { material: 12, wetness: 0 }, smooth: false });
    expect([1, 2].map((x) => valueRole(at(b, x, 0, 0)))).toEqual([VOXEL_ROLE.wall, VOXEL_ROLE.roof]);
    expect([1, 2].map((x) => valueMaterial(at(b, x, 0, 0)))).toEqual([12, 12]);
  });

  it('with a role, in either version, writes the one role as before', () => {
    for (const v of [2, 3]) {
      const store = made();
      run(store, { v, grid: 0, kind: 'fill', min: [0, 0, 0], max: [6, 0, 0], mode: 'paint', voxel: { material: 12, role: VOXEL_ROLE.floor, wetness: 2 } });
      expect([0, 1, 2, 3, 4].map((x) => valueRole(at(store, x, 0, 0)))).toEqual(Array(5).fill(VOXEL_ROLE.floor));
    }
  });
});

describe('version 2 strokes apply as before', () => {
  it('gives the same voxels sent as version 2 or 3', () => {
    const strokes: Array<Record<string, unknown>> = [
      { grid: 0, kind: 'brush', shape: 'sphere', size: [3, 3, 3], points: [8, 4, 8, 10, 5, 9], mode: 'add', voxel: { material: 3, role: VOXEL_ROLE.terrain, wetness: 1 }, smooth: true },
      { grid: 0, kind: 'brush', shape: 'cylinder', size: [2, 3, 2], points: [6, 4, 6], mode: 'dig', smooth: true },
      { grid: 0, kind: 'fill', min: [2, 3, 2], max: [5, 5, 5], mode: 'place', voxel: { material: 5, role: VOXEL_ROLE.wall, wetness: 0 } },
      { grid: 0, kind: 'set', cells: [1, 6, 1, 2, 6, 1], voxel: { material: FOG, role: VOXEL_ROLE.gas, shape: 4, wetness: 0 } },
      { grid: 0, kind: 'dig', cells: [8, 3, 8] },
    ];
    const a = build(ground(() => 4), FIELD);
    const b = build(ground(() => 4), FIELD);
    for (const s of strokes) {
      const oa = run(a, { v: 2, ...s });
      const ob = run(b, { v: 3, ...s });
      expect(oa.cells).toBe(ob.cells);
      expect(oa.cells).toBeGreaterThan(0);
    }
    expect(same(dump(a, FIELD), dump(b, FIELD))).toBe(true);
  });
});

/** The command type's own check: a flood is a version 3 command. */
const _typed: VoxelEditCommand = { v: 3, grid: 0, kind: 'flood', seed: [0, 0, 0], level: 1, value: { material: 0, role: 0 }, reach: 1 };
void _typed;
