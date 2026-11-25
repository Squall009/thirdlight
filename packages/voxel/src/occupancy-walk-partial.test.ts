/**
 * What a light ray keeps through partly covered cells: rows of fence-like cells, a shutter-like cell, a wall damaged
 * through its integrity (real derived data), a coarse level over a wall, and the packed table (the GPU's words) walking
 * the same transmittance as the views it was packed from.
 */
import { describe, expect, it } from 'vitest';

import { chunkGrid } from './coords';
import { deriveFromStore } from './derive-assembly';
import { MipTree, deriveMipNode } from './mip-derive';
import { OCCUPANCY } from './derived-data';
import { walkCoverPass, walkVoxels, WALK_COVER_STEPS, type WalkBlockView, type WalkSource } from './occupancy-walk';
import { createWorldStore } from './palette-store';
import { SHAPE_FULL, VOXEL_ROLE } from './record';
import { WORLD_RULES } from './rule-registry';
import { packWalkBlock, WalkTable } from './walk-pages';
import { derivedWalkView, propStopView, walkPartialOf, WALK_EMPTY_VIEW } from './walk-sources';
import { walkRay } from './walk-steps';

const E = 32;

/** A level-0 source of 32³ blocks over a stop predicate and a coverage function (bytes; read where the stop passes). */
function coverSource(stop: (x: number, y: number, z: number) => boolean, cover: (x: number, y: number, z: number) => number): WalkSource {
  const cache = new Map<string, WalkBlockView>();
  return {
    maxLevel: 0,
    blockShift: () => 5,
    block(level, bx, by, bz) {
      const key = `${bx},${by},${bz}`;
      const had = cache.get(key);
      if (had !== undefined) return had;
      const stops = new Uint8Array(E * E * E);
      const parts = new Map<number, number>();
      let n = 0;
      for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) for (let y = 0; y < E; y++) {
        const i = (x * E + z) * E + y;
        const [gx, gy, gz] = [bx * E + x, by * E + y, bz * E + z];
        if (stop(gx, gy, gz)) {
          stops[i] = 1;
          n++;
        } else if (cover(gx, gy, gz) > 0) parts.set(i, cover(gx, gy, gz));
      }
      const bricks = new Uint8Array((E / 4) ** 3);
      for (let i = 0; i < stops.length; i++) if (stops[i] === 1) bricks[((Math.floor(i / (E * E)) >> 2) * 8 + ((Math.floor(i / E) % E) >> 2)) * 8 + ((i % E) >> 2)] = OCCUPANCY.mixed;
      const v: WalkBlockView = { flag: n === 0 ? OCCUPANCY.empty : OCCUPANCY.mixed, brick: (i) => bricks[i]!, cell: (i) => stops[i] === 1, ...(parts.size > 0 ? { partial: walkPartialOf(parts, E) } : {}) };
      cache.set(key, v);
      return v;
    },
  };
}

/** A horizontal ray along +x at the middle of cell row (y 4, z 4), from cell x 1, `maxT` metres. */
function along(src: WalkSource, maxT = 20): ReturnType<typeof walkVoxels> {
  return walkVoxels(src, walkRay([0.75, 2.25, 2.25], [1, 0, 0])!, maxT, { stop: 'light' });
}

describe('the light walk through partly covered cells', () => {
  it('a fence row at 20 % lets 80 % on, three rows 51 %, a shutter at 70 % about 30 %, open air all of it', () => {
    const fence = (rows: number[], c: number) => coverSource(() => false, (x, y, z) => (rows.includes(x) && y === 4 && z === 4 ? c : 0));
    const one = along(fence([6], 51));
    expect(one.hit).toBeNull();
    expect(one.trans).toBeCloseTo(0.8, 6);
    expect(along(fence([6, 9, 12], 51)).trans).toBeCloseTo(0.512, 6);
    const shutter = along(fence([6], Math.round(0.7 * 255))).trans;
    expect(Math.abs(shutter - 0.3)).toBeLessThanOrEqual(1 / WALK_COVER_STEPS);
    expect(along(fence([], 51)).trans).toBe(1);
    // A wall behind the fence: the ray stops there with what the fence let on.
    const walled = walkVoxels(coverSource((x) => x === 20, (x, y, z) => (x === 6 && y === 4 && z === 4 ? 51 : 0)), walkRay([0.75, 2.25, 2.25], [1, 0, 0])!, 20, { stop: 'light' });
    expect(walled.hit?.cell[0]).toBe(20);
    expect(walled.trans).toBeCloseTo(0.8, 6);
  });

  it('the cell a ray starts in is its own; a spent ray ends as stopped; the solid stop never reads coverage', () => {
    const src = coverSource(() => false, (x, y, z) => (x <= 30 && y === 4 && z === 4 ? 240 : 0));
    const own = walkVoxels(coverSource(() => false, (x, y, z) => (x === 1 && y === 4 && z === 4 ? 200 : 0)), walkRay([0.75, 2.25, 2.25], [1, 0, 0])!, 20, { stop: 'light' });
    expect(own.trans).toBe(1);
    const spent = along(src);
    expect(spent.end).toBe('hit');
    expect(spent.trans).toBe(0);
    expect(walkVoxels(src, walkRay([0.75, 2.25, 2.25], [1, 0, 0])!, 20, { stop: 'solid' }).trans).toBe(1);
  });

  it('the packed table (the GPU walk reads its words) walks the transmittance of the views it was packed from', () => {
    const stop = (x: number, y: number, z: number): boolean => (x * 7 + y * 13 + z * 3) % 41 === 0;
    const cover = (x: number, y: number, z: number): number => ((x * 5 + y * 11 + z * 17) % 9 === 0 ? ((x * 31 + z * 7 + y) % 255) + 1 : 0);
    const src = coverSource(stop, cover);
    const t = new WalkTable();
    for (let bx = -2; bx <= 1; bx++) for (let by = -2; by <= 1; by++) for (let bz = -2; bz <= 1; bz++) t.set(0, bx, by, bz, packWalkBlock(src, 0, bx, by, bz)!);
    let partial = 0;
    for (let k = 0; k < 400; k++) {
      const o = [Math.sin(k) * 10, Math.cos(k * 1.3) * 10, Math.sin(k * 0.7) * 10];
      const d = [Math.cos(k * 2.1), Math.sin(k * 0.9), Math.cos(k * 0.4 + 1)];
      const l = Math.hypot(d[0]!, d[1]!, d[2]!);
      const r = walkRay(o, d.map((x) => x / l))!;
      const a = walkVoxels(src, r, 14, { stop: 'light' });
      const b = walkVoxels(t.source(), r, 14, { stop: 'light' });
      expect(b.end).toBe(a.end);
      expect(b.hit?.cell ?? null).toEqual(a.hit?.cell ?? null);
      expect(b.trans).toBeCloseTo(a.trans, 12);
      if (a.trans < 1) partial++;
    }
    expect(partial).toBeGreaterThan(100);
  });

  it("props' cells: under half the ray keeps the rest, from half on they stop it (a sampled share of a closed body)", () => {
    const props = new Uint8Array(E * E * E);
    const at = (x: number, y: number, z: number): number => (x * E + z) * E + y;
    props[at(6, 4, 4)] = 64;
    props[at(9, 4, 4)] = 64;
    const thin = propStopView(WALK_EMPTY_VIEW, null, props, 0, 0, 0, E, 5);
    const one: WalkSource = { maxLevel: 0, blockShift: () => 5, block: (_l, bx, by, bz) => (bx === 0 && by === 0 && bz === 0 ? thin : WALK_EMPTY_VIEW) };
    const w = along(one, 12);
    expect(w.hit).toBeNull();
    expect(w.trans).toBeCloseTo(walkCoverPass(64) ** 2, 9);
    props[at(12, 4, 4)] = 200;
    const thick = propStopView(WALK_EMPTY_VIEW, null, props, 0, 0, 0, E, 5);
    const h = along({ ...one, block: (_l, bx, by, bz) => (bx === 0 && by === 0 && bz === 0 ? thick : WALK_EMPTY_VIEW) }, 12);
    expect(h.hit?.cell[0]).toBe(12);
    expect(h.trans).toBeCloseTo(walkCoverPass(64) ** 2, 9);
  });

  it('a wall damaged through its integrity: under half it lets on 1 − integrity / 15, smoothly; from half on it stops the ray', () => {
    const grid = chunkGrid(32);
    const got: Array<number | 'stop'> = [];
    for (let integrity = 1; integrity <= SHAPE_FULL; integrity++) {
      const store = createWorldStore(grid);
      // A wall one cell thick across the ray (x 10), 3 × 3 cells round the row, in an otherwise empty chunk.
      for (let y = 3; y <= 5; y++) for (let z = 3; z <= 5; z++) store.setVoxel(10, y, z, { material: 9, role: VOXEL_ROLE.wall, shape: integrity, wetness: 0 });
      const d = deriveFromStore(store, 0, 0, 0, WORLD_RULES);
      const view = derivedWalkView(d, 'light');
      const src: WalkSource = { maxLevel: 0, blockShift: () => 5, block: (_l, bx, by, bz) => (bx === 0 && by === 0 && bz === 0 ? view : WALK_EMPTY_VIEW) };
      const w = along(src, 12);
      got.push(w.hit !== null ? 'stop' : w.trans);
    }
    const passed = got.filter((v): v is number => v !== 'stop');
    expect(passed.length).toBe(7);
    passed.forEach((v, k) => expect(v).toBeCloseTo(walkCoverPass(17 * (k + 1)), 9));
    for (let k = 1; k < passed.length; k++) expect(passed[k - 1]! - passed[k]!).toBeCloseTo(1 / WALK_COVER_STEPS, 9);
    expect(got.slice(7).every((v) => v === 'stop')).toBe(true);
  });

  it('a coarse cell half full of a damaged wall stops light whole (a parent of construction is intact)', () => {
    const grid = chunkGrid(32);
    const store = createWorldStore(grid);
    // A wall two cells high and one thick at x 10: half of each 1 m cell it falls in, damaged to integrity 4.
    for (let y = 2; y <= 7; y++) for (let z = 2; z <= 7; z++) store.setVoxel(10, y, z, { material: 9, role: VOXEL_ROLE.wall, shape: 4, wetness: 0 });
    const tree = new MipTree(store);
    const d1 = deriveMipNode(tree, { level: 1, nx: 0, ny: 0, nz: 0 }, WORLD_RULES);
    const v1 = derivedWalkView(d1, 'light');
    const src: WalkSource = { maxLevel: 1, blockShift: () => 5, block: (l, bx, by, bz) => (l === 0 ? null : bx === 0 && by === 0 && bz === 0 ? v1 : WALK_EMPTY_VIEW) };
    const w = walkVoxels(src, walkRay([0.75, 2.25, 2.25], [1, 0, 0])!, 12, { stop: 'light' });
    expect(w.hit).not.toBeNull();
    expect(w.hit!.level).toBe(1);
    expect(w.trans).toBe(1);
  });
});
