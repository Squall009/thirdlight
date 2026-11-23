import { describe, expect, it } from 'vitest';
import { chunkGrid } from '../coords';
import { createWorldStore, type PaletteStore } from '../palette-store';
import { DERIVED_PART, readValue, recordValue, SHAPE_FULL, valueOf, valueRole, valueShape, VOXEL_ROLE, type VoxelRecord } from '../record';
import { applyUndo } from '../edit-apply';
import { bodyCells, fillLeaks, followBody, regenerateBody } from './body';
import { CellSet } from './cell-set';
import { FILL_BREACH, FILL_OUTSIDE, isLiquidOf, levelFill, liquidValue, type FillWorld, type LevelFillSpec } from './level-fill';
import { writeCells } from './write-cells';

const WATER = 40;
const ROCK = recordValue(7, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
const grid = chunkGrid(32);

/** A world in a palette store, read as the backend reads it; cells outside `edge` (default: outside the box) are outside the world. */
function world(fill: (x: number, y: number, z: number) => number, box: [number, number, number, number, number, number], edge?: (x: number, y: number, z: number) => boolean): { store: PaletteStore; w: FillWorld } {
  const store = createWorldStore(grid, 'pick');
  const r: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const [x0, y0, z0, x1, y1, z1] = box;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    const v = fill(x, y, z);
    if (v !== 0) store.setVoxel(x, y, z, readValue(v, r));
  }
  const scratch: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const inside = edge ?? ((x: number, y: number, z: number): boolean => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1);
  return { store, w: { value: (x, y, z) => (!inside(x, y, z) ? FILL_OUTSIDE : valueOf(store.voxelAt(x, y, z, scratch))) } };
}

/** A square basin: floor at y = 0, walls of height `wall` round an inside of [1, n]², rock below. */
const basin = (n: number, wall: number) => (x: number, y: number, z: number): number => {
  if (y <= 0) return ROCK;
  const inside = x >= 1 && x <= n && z >= 1 && z <= n;
  return !inside && y <= wall ? ROCK : 0;
};

const spec = (seed: [number, number, number], level: number, reach = 256): LevelFillSpec => ({ seed, level, material: WATER, reach });

/** The cells a fill writes as "x,y,z=value", sorted (what two runs are compared by). */
const asText = (cells: Int32Array, values: Uint32Array): string[] => [...values].map((v, i) => `${cells[3 * i]},${cells[3 * i + 1]},${cells[3 * i + 2]}=${v}`).sort();

/** Makes the writes of a regenerate or follow-up, as the backend does. */
function apply(store: PaletteStore, writes: { cells: Int32Array; values: Uint32Array }): ReturnType<typeof writeCells> {
  return writeCells(store, 0, writes);
}

/** Every liquid cell of the store within a box, as text. */
function liquidIn(store: PaletteStore, box: [number, number, number, number, number, number]): string[] {
  const r: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  const out: string[] = [];
  const [x0, y0, z0, x1, y1, z1] = box;
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
    const v = valueOf(store.voxelAt(x, y, z, r));
    if (valueRole(v) === VOXEL_ROLE.liquid) out.push(`${x},${y},${z}=${v}`);
  }
  return out.sort();
}

describe('level fill', () => {
  it('fills a basin to its level, every cell full below the level row and the row at its share', () => {
    const { w } = world(basin(10, 6), [-2, -1, -2, 13, 8, 13]);
    const full = levelFill(spec([5, 2, 5], 4), w);
    expect(full.status).toBe('filled');
    expect(full.values.length).toBe(100 * 3);
    expect([...full.values].every((v) => v === liquidValue(WATER, SHAPE_FULL))).toBe(true);
    const half = levelFill(spec([5, 2, 5], 3.5), w);
    expect(half.values.length).toBe(100 * 3);
    const top = [...half.values].filter((_, i) => half.cells[3 * i + 1] === 3);
    expect(top.length).toBe(100);
    expect(top.every((v) => valueShape(v) === Math.round(0.5 * SHAPE_FULL))).toBe(true);
    // A share that rounds to empty fills nothing and is not entered.
    expect(levelFill(spec([5, 2, 5], 3.02), w).values.length).toBe(100 * 2);
  });

  it('follows a sloped shore: partial top cells where the ground is under the level, dry above', () => {
    // Ground rises one cell every two along x; the surface at 5.25 cells.
    const ground = (x: number): number => Math.floor(x / 2);
    const { w } = world((x, y, z) => (y <= ground(x) || x < 0 || z < 0 || z > 8 ? ROCK : 0), [-2, -1, -1, 30, 10, 9]);
    const f = levelFill(spec([1, 3, 4], 5.25), w);
    expect(f.status).toBe('filled');
    const cols = new Map<number, number[]>();
    for (let i = 0; i < f.values.length; i++) cols.set(f.cells[3 * i]!, [...(cols.get(f.cells[3 * i]!) ?? []), f.cells[3 * i + 1]!]);
    // Columns whose ground top lies under row 5 hold water up to row 5, the top row at a quarter.
    for (const [x, ys] of cols) {
      expect(Math.min(...ys)).toBe(ground(x) + 1);
      expect(Math.max(...ys)).toBe(5);
    }
    expect(Math.max(...cols.keys())).toBe(9);
    const topShapes = new Set([...f.values].filter((_, i) => f.cells[3 * i + 1] === 5).map(valueShape));
    expect([...topShapes]).toEqual([Math.round(0.25 * SHAPE_FULL)]);
  });

  it('leaves an island dry and fills round it', () => {
    const { w } = world((x, y, z) => (x >= 4 && x <= 6 && z >= 4 && z <= 6 && y <= 9 ? ROCK : basin(10, 6)(x, y, z)), [-2, -1, -2, 13, 10, 13]);
    const f = levelFill(spec([1, 1, 1], 4), w);
    expect(f.status).toBe('filled');
    expect(f.values.length).toBe((100 - 9) * 3);
    for (let i = 0; i < f.values.length; i++) expect(f.cells[3 * i]! >= 4 && f.cells[3 * i]! <= 6 && f.cells[3 * i + 2]! >= 4 && f.cells[3 * i + 2]! <= 6).toBe(false);
  });

  it('fills a cave under the level joined to the basin and leaves a sealed pocket dry', () => {
    // A tunnel under the wall at x = 11 (rows 1..2) into a cave x 12..15; a pocket at x 20..21 sealed in rock.
    const f0 = basin(10, 6);
    const cell = (x: number, y: number, z: number): number => {
      if (x >= 11 && x <= 15 && y >= 1 && y <= 2 && z >= 3 && z <= 5) return 0;
      if (x >= 20 && x <= 21 && y >= 1 && y <= 2 && z >= 3 && z <= 5) return 0;
      if (x > 10 && y <= 8) return ROCK;
      return f0(x, y, z);
    };
    const { w } = world(cell, [-2, -1, -2, 24, 9, 13]);
    const f = levelFill(spec([5, 1, 5], 4), w);
    expect(f.status).toBe('filled');
    expect(f.set.has(14, 1, 4)).toBe(true);
    expect(f.set.has(15, 2, 5)).toBe(true);
    expect(f.set.has(20, 1, 4)).toBe(false);
    expect(f.values.length).toBe(300 + 5 * 2 * 3);
  });

  it('reports a breach at the reach, cells at its edge, and writes nothing past it', () => {
    // An open plain: water under the level runs to the reach on every side.
    const { w } = world((_x, y) => (y <= 0 ? ROCK : 0), [-30, -1, -30, 30, 4, 30]);
    const f = levelFill(spec([0, 1, 0], 2, 10), w);
    expect(f.status).toBe('breached');
    expect(f.breachKinds.length).toBeGreaterThan(0);
    expect([...f.breachKinds].every((k) => k === FILL_BREACH.reach)).toBe(true);
    for (let i = 0; i < f.values.length; i++) expect(f.cells[3 * i]! ** 2 + f.cells[3 * i + 2]! ** 2).toBeLessThanOrEqual(100);
    for (let i = 0; i < f.breachKinds.length; i++) expect(f.breaches[3 * i]! ** 2 + f.breaches[3 * i + 2]! ** 2).toBeGreaterThan(100);
    const leaks = fillLeaks(f);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.every((l) => l.kind === 'reach')).toBe(true);
    expect(leaks.reduce((n, l) => n + l.cells, 0)).toBe(f.breachKinds.length);
  });

  it('reports a breach where the water would leave the world it can read', () => {
    const { w } = world(basin(10, 6), [-2, -1, -2, 13, 8, 13], (x) => x <= 8);
    const f = levelFill(spec([2, 1, 2], 4), w);
    expect(f.status).toBe('breached');
    expect([...f.breachKinds].every((k) => k === FILL_BREACH.world)).toBe(true);
    expect([...new Set(Array.from({ length: f.breachKinds.length }, (_, i) => f.breaches[3 * i]))]).toEqual([9]);
    expect(fillLeaks(f).every((l) => l.kind === 'world')).toBe(true);
  });

  it('is deterministic: the same world gives the same cells in the same order', () => {
    const { w } = world(basin(12, 6), [-2, -1, -2, 15, 8, 15]);
    const a = levelFill(spec([3, 2, 7], 3.7), w);
    const b = levelFill(spec([3, 2, 7], 3.7), w);
    expect([...a.cells]).toEqual([...b.cells]);
    expect([...a.values]).toEqual([...b.values]);
  });

  it('fills nothing from a seed in solid ground, and starts at the level from a seed above it', () => {
    const { w } = world(basin(10, 6), [-2, -1, -2, 13, 8, 13]);
    const buried = levelFill(spec([5, -1, 5], 4), w);
    expect(buried.status).toBe('seed_blocked');
    expect(buried.values.length).toBe(0);
    expect(levelFill(spec([0, 2, 5], 4), w).status).toBe('seed_blocked');
    const above = levelFill(spec([5, 20, 5], 4), w);
    expect(above.start).toEqual([5, 3, 5]);
    expect(above.values.length).toBe(300);
  });

  it('never enters a cell another grid closes', () => {
    const { store } = world(basin(10, 6), [-2, -1, -2, 13, 8, 13]);
    const r: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
    const w: FillWorld = { value: (x, y, z) => valueOf(store.voxelAt(x, y, z, r)), stops: (x, _y, z) => x >= 6 && z >= 6 };
    expect(levelFill(spec([2, 1, 2], 4), w).values.length).toBe((100 - 25) * 3);
  });
});

describe('a water body written again', () => {
  const BOX: [number, number, number, number, number, number] = [-2, -1, -2, 25, 9, 25];

  it('regenerates: what it owned cleared, the fill written; a level lowered takes the top rows away; undo exact', () => {
    const { store, w } = world(basin(20, 6), BOX);
    const s = spec([10, 2, 10], 4);
    const first = regenerateBody(s, w);
    expect(first.fill.status).toBe('filled');
    apply(store, first.writes);
    expect(liquidIn(store, BOX).length).toBe(400 * 3);
    expect(bodyCells(s, w).size).toBe(1200);
    const before = liquidIn(store, BOX);
    const lower = regenerateBody(spec([10, 2, 10], 2.5), w);
    const done = apply(store, lower.writes);
    expect(liquidIn(store, BOX).length).toBe(400 * 2);
    expect(done.parts).toBe(DERIVED_PART.liquid);
    applyUndo({ store: () => store }, done.chunks);
    expect(liquidIn(store, BOX)).toEqual(before);
  });

  it('drains when its fill breaches, and fills again once the leak is closed', () => {
    const { store, w } = world(basin(20, 6), BOX);
    const s = spec([10, 2, 10], 4, 40);
    apply(store, regenerateBody(s, w).writes);
    // A trench through the wall at x = 21 out to open ground.
    const r: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
    for (let x = 21; x <= 25; x++) store.setVoxel(x, 1, 10, r);
    const leak = regenerateBody(s, w);
    expect(leak.fill.status).toBe('breached');
    expect(fillLeaks(leak.fill).length).toBeGreaterThan(0);
    apply(store, leak.writes);
    expect(liquidIn(store, BOX)).toEqual([]);
    store.setVoxel(21, 1, 10, readValue(ROCK, r));
    const again = regenerateBody(s, w, leak.owned);
    expect(again.fill.status).toBe('filled');
    apply(store, again.writes);
    expect(liquidIn(store, BOX).length).toBe(1200);
  });

  it('takes liquid painted against it as its own', () => {
    const { store, w } = world(basin(20, 6), BOX);
    const s = spec([10, 2, 10], 4);
    apply(store, regenerateBody(s, w).writes);
    const r: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
    // Painted a cell above the level on the water: the body owns it, a whole regenerate clears it.
    store.setVoxel(10, 4, 10, readValue(liquidValue(WATER, SHAPE_FULL), r));
    expect(bodyCells(s, w).has(10, 4, 10)).toBe(true);
    apply(store, regenerateBody(s, w).writes);
    expect(valueOf(store.voxelAt(10, 4, 10, r))).toBe(0);
  });

  /** Digs (air) or adds (rock) cells in a box, as a stroke would; the box changed. */
  const edit = (store: PaletteStore, b: [number, number, number, number, number, number], v: number) => {
    const r: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
    for (let x = b[0]; x <= b[3]; x++) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) store.setVoxel(x, y, z, readValue(v, r));
    return { minX: b[0], minY: b[1], minZ: b[2], maxX: b[3], maxY: b[4], maxZ: b[5] };
  };

  /** A follow-up after an edit, and the whole regenerate of the same world, compared. */
  function followEqualsWhole(build: (store: PaletteStore) => ReturnType<typeof edit>, s: LevelFillSpec): ReturnType<typeof followBody> {
    const a = world(basin(20, 6), BOX);
    const b = world(basin(20, 6), BOX);
    const owned = regenerateBody(s, a.w).owned;
    apply(a.store, regenerateBody(s, a.w).writes);
    // What the body owned before the edit is what a regenerate clears (a part cut off is the body's too).
    const ownedB = regenerateBody(s, b.w).owned;
    apply(b.store, regenerateBody(s, b.w).writes);
    const box = build(a.store);
    build(b.store);
    const f = followBody(s, a.w, owned, box);
    if (f.kind === 'local') apply(a.store, f.writes);
    else apply(a.store, regenerateBody(s, a.w, owned).writes);
    apply(b.store, regenerateBody(s, b.w, ownedB).writes);
    expect(liquidIn(a.store, BOX)).toEqual(liquidIn(b.store, BOX));
    return f;
  }

  it('follows a bank dug back locally, writing only round the dig: equal to a whole regenerate', () => {
    const s = spec([10, 2, 10], 4.5);
    // The east wall dug back two cells, from the floor up past the level.
    const f = followEqualsWhole((st) => edit(st, [21, 1, 8, 22, 7, 12], 0), s);
    expect(f.kind).toBe('local');
    if (f.kind === 'local') {
      expect(f.added).toBe(2 * 5 * 4);
      for (let i = 0; i < f.writes.values.length; i++) expect(f.writes.cells[3 * i]!).toBeGreaterThanOrEqual(21);
    }
  });

  it('follows a dab dug into the bed under water, and ground added under water that cuts nothing', () => {
    const s = spec([10, 2, 10], 4);
    expect(followEqualsWhole((st) => edit(st, [5, 0, 5, 6, 0, 6], 0), s).kind).toBe('local');
    const add = followEqualsWhole((st) => edit(st, [5, 1, 5, 6, 2, 6], ROCK), s);
    expect(add.kind).toBe('local');
    if (add.kind === 'local') expect(add.removed).toBe(8);
  });

  it('falls back to the whole body when a dam cuts it in two, when it leaks, and when it held nothing', () => {
    const s = spec([5, 2, 5], 4, 40);
    const dam = followEqualsWhole((st) => edit(st, [1, 1, 12, 20, 6, 12], ROCK), s);
    expect(dam).toEqual({ kind: 'whole', why: 'cut' });
    expect(followEqualsWhole((st) => edit(st, [21, 1, 10, 25, 1, 10], 0), s)).toEqual({ kind: 'whole', why: 'breach' });
    const { w } = world(basin(20, 6), BOX);
    expect(followBody(s, w, new CellSet(), { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 })).toEqual({ kind: 'whole', why: 'empty' });
  });

  it('a seeded run of random digs and adds round the shore: every follow-up equals the whole regenerate', () => {
    let seed = 12345;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const s = spec([10, 2, 10], 4.6, 60);
    const a = world(basin(20, 6), BOX);
    let owned = regenerateBody(s, a.w).owned;
    apply(a.store, regenerateBody(s, a.w).writes);
    let local = 0;
    for (let k = 0; k < 40; k++) {
      const x = 1 + rnd(22);
      const z = 1 + rnd(22);
      const y = rnd(6);
      const b: [number, number, number, number, number, number] = [x, y, z, x + rnd(2), y + rnd(2), z + rnd(2)];
      const box = edit(a.store, b, rnd(3) === 0 ? ROCK : 0);
      const f = followBody(s, a.w, owned, box);
      if (f.kind === 'local') {
        local++;
        apply(a.store, f.writes);
        owned = f.owned;
      } else {
        const g = regenerateBody(s, a.w, owned);
        apply(a.store, g.writes);
        owned = g.owned;
      }
      const fresh = regenerateBody(s, a.w);
      expect(fresh.writes.values.length).toBe(0);
      const held: string[] = [];
      owned.forEach((ox, oy, oz) => held.push(`${ox},${oy},${oz}`));
      expect(held.length).toBe(fresh.owned.size);
    }
    expect(local).toBeGreaterThan(20);
  });

  it('writes its cells with an exact undo record, feeding the liquid part alone between air and liquid', () => {
    const { store, w } = world(basin(20, 6), BOX);
    const g = regenerateBody(spec([10, 2, 10], 4), w);
    const done = apply(store, g.writes);
    expect(done.cells).toBe(1200);
    expect(done.parts).toBe(DERIVED_PART.liquid);
    expect(done.box).toEqual({ minX: 1, minY: 1, minZ: 1, maxX: 20, maxY: 3, maxZ: 20 });
    expect(isLiquidOf(valueOf(store.voxelAt(4, 2, 4, { material: 0, role: 0, shape: 0, wetness: 0 })), WATER)).toBe(true);
    applyUndo({ store: () => store }, done.chunks);
    expect(liquidIn(store, BOX)).toEqual([]);
    expect(asText(g.writes.cells, g.writes.values).length).toBe(1200);
  });
});
