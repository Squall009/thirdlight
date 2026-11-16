/**
 * The occupancy walk against a cell-by-cell reference on synthetic blocks:
 * every hit equal (cell, face, distance) with and without skipping, rays
 * never slipping between two cells that touch by an edge, coarser levels
 * taken where level 0 does not know a place, and the packed table (the
 * GPU's blocks) walking the same as the views it was packed from.
 */
import { describe, expect, it } from 'vitest';

import { OCCUPANCY, type DerivedData } from './derived-data';
import { walkVoxels, type WalkBlockView, type WalkSource } from './occupancy-walk';
import { packWalkBlock, WalkTable } from './walk-pages';
import { derivedWalkView } from './walk-sources';
import { walkRay, type WalkRay } from './walk-steps';

/** A source over a cell predicate at level 0 (`known` limits where level 0 knows), blocks of 2^shift cells, and an optional level 1. */
function predicateSource(solid: (x: number, y: number, z: number) => boolean, opts: { shift?: number; known?: (bx: number, by: number, bz: number) => boolean; level1?: (x: number, y: number, z: number) => boolean } = {}): WalkSource {
  const shift = opts.shift ?? 4;
  const cache = new Map<string, WalkBlockView>();
  const view = (level: number, bx: number, by: number, bz: number): WalkBlockView => {
    const key = `${level}:${bx},${by},${bz}`;
    const had = cache.get(key);
    if (had !== undefined) return had;
    const E = 1 << (level === 0 ? shift : 5);
    const f = level === 0 ? solid : opts.level1!;
    const cells = new Uint8Array(E * E * E);
    let n = 0;
    for (let x = 0; x < E; x++) for (let z = 0; z < E; z++) for (let y = 0; y < E; y++) {
      const s = f(bx * E + x, by * E + y, bz * E + z);
      cells[(x * E + z) * E + y] = s ? 1 : 0;
      if (s) n++;
    }
    const nb = E / 4;
    const bricks = new Uint8Array(nb * nb * nb);
    for (let i = 0; i < bricks.length; i++) {
      const bxx = Math.floor(i / (nb * nb));
      const bzz = Math.floor(i / nb) % nb;
      const byy = i % nb;
      let k = 0;
      for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) k += cells[((bxx * 4 + x) * E + bzz * 4 + z) * E + byy * 4 + y]!;
      bricks[i] = k === 0 ? OCCUPANCY.empty : k === 64 ? OCCUPANCY.solid : OCCUPANCY.mixed;
    }
    const v: WalkBlockView = { flag: n === 0 ? OCCUPANCY.empty : n === E * E * E ? OCCUPANCY.solid : OCCUPANCY.mixed, brick: (i) => bricks[i]!, cell: (i) => cells[i] === 1 };
    cache.set(key, v);
    return v;
  };
  return {
    maxLevel: opts.level1 !== undefined ? 1 : 0,
    blockShift: (level) => (level === 0 ? shift : 5),
    block: (level, bx, by, bz) => (level === 0 ? (opts.known === undefined || opts.known(bx, by, bz) ? view(0, bx, by, bz) : null) : view(1, bx, by, bz)),
  };
}

/** The reference: a plain cell-by-cell walk over the predicate, crossing times computed directly in 32 bits, ties x, y, z. */
function referenceHit(r: WalkRay, solid: (x: number, y: number, z: number) => boolean, maxT: number): { cell: number[]; normal: number[]; t: number } | null {
  const c = [...r.cell];
  const f = Math.fround;
  let t = 0;
  let axis = -1;
  for (let k = 0; k < 100000; k++) {
    if (t > maxT) return null;
    if (solid(c[0]!, c[1]!, c[2]!)) {
      const normal = [0, 0, 0];
      if (axis >= 0) normal[axis] = -r.step[axis]!;
      return { cell: c, normal, t: t + 0 };
    }
    const ts = [0, 1, 2].map((a) => f(f(f((r.step[a]! > 0 ? c[a]! + 1 : c[a]!) - r.cell[a]!) - r.frac[a]!) * r.inv[a]!));
    let a = 0;
    if (ts[1]! < ts[a]!) a = 1;
    if (ts[2]! < ts[a]!) a = 2;
    t = ts[a]!;
    axis = a;
    c[a]! += r.step[a]!;
  }
  return null;
}

/** A seeded generator. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Blobs, a floor and thin walls around the origin, across negative coordinates and block faces. */
function blobWorld(seed: number): (x: number, y: number, z: number) => boolean {
  const r = rng(seed);
  const balls = Array.from({ length: 40 }, () => [r() * 120 - 60, r() * 60 - 20, r() * 120 - 60, 1 + r() * 6] as const);
  const walls = Array.from({ length: 12 }, () => [Math.floor(r() * 100 - 50), Math.floor(r() * 3)] as const);
  return (x, y, z) => {
    if (y < -16 + Math.floor(4 * Math.sin(x / 9) + 3 * Math.cos(z / 7))) return true;
    for (const [w, axis] of walls) if ((axis === 0 ? x : axis === 1 ? z : x + z) === w && y < 20 && Math.abs(axis === 0 ? z : x) < 40) return true;
    for (const [bx, by, bz, br] of balls) if ((x + 0.5 - bx) ** 2 + (y + 0.5 - by) ** 2 + (z + 0.5 - bz) ** 2 < br * br) return true;
    return false;
  };
}

function randomRays(seed: number, n: number): WalkRay[] {
  const r = rng(seed);
  const out: WalkRay[] = [];
  while (out.length < n) {
    const o = [r() * 80 - 40, r() * 30 - 5, r() * 80 - 40];
    // Some rays along an axis or a diagonal exactly: the tie rules matter there.
    const kind = r();
    const d = kind < 0.1 ? [[1, 0, 0], [0, -1, 0], [0, 0, -1], [1, 1, 0], [-1, 0, 1], [1, -1, 1]][Math.floor(r() * 6)]! : [r() * 2 - 1, r() * 2 - 1.2, r() * 2 - 1];
    const ray = walkRay(kind < 0.15 ? o.map((v) => Math.round(v * 4) / 4) : o, d);
    if (ray !== null) out.push(ray);
  }
  return out;
}

describe('occupancy walk', () => {
  it('finds the reference hit on every ray, with and without skipping empty blocks and bricks', () => {
    for (const seed of [1, 2, 3]) {
      const solid = blobWorld(seed);
      const src = predicateSource(solid);
      let hits = 0;
      let misses = 0;
      let skipped = 0;
      for (const ray of randomRays(seed * 7, 1500)) {
        const want = referenceHit(ray, solid, 40);
        for (const skip of [true, false]) {
          const got = walkVoxels(src, ray, 40, { skip });
          if (want === null) {
            expect(got.hit, `seed ${seed}`).toBeNull();
            continue;
          }
          expect(got.hit, `seed ${seed}: ray ${JSON.stringify(ray)}`).not.toBeNull();
          expect([got.hit!.cell, got.hit!.normal, got.hit!.t]).toEqual([want.cell, want.normal, want.t]);
          if (skip) skipped += got.steps;
        }
        if (want === null) misses++;
        else hits++;
      }
      expect(hits).toBeGreaterThan(300);
      expect(misses).toBeGreaterThan(100);
      expect(skipped).toBeGreaterThan(0);
    }
  });

  it('takes fewer steps with skipping than cell by cell over open ground', () => {
    const solid = blobWorld(4);
    const src = predicateSource(solid);
    let a = 0;
    let b = 0;
    for (const ray of randomRays(11, 300)) {
      a += walkVoxels(src, ray, 40).steps;
      b += walkVoxels(src, ray, 40, { skip: false }).steps;
    }
    expect(a * 3).toBeLessThan(b);
  });

  it('never slips diagonally between two cells that touch only by an edge or a corner', () => {
    // Cells (1, 0, 0) and (0, 1, 0) touch along the edge x = y = 1; a ray from inside (0, 0, 0) aimed exactly at that edge.
    for (const [solidCells, dir, want] of [
      [[[1, 0, 0], [0, 1, 0]], [1, 1, 0], [1, 0, 0]],
      [[[1, 0, 0], [0, 1, 0]], [1, 1, 0.3], [1, 0, 0]],
      [[[0, 0, 1], [1, 0, 0]], [1, 0, 1], [1, 0, 0]],
      [[[-1, 0, 0], [0, -1, 0]], [-1, -1, 0], [-1, 0, 0]],
      [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [1, 1, 1], [1, 0, 0]],
      [[[0, 1, 0], [0, 0, 1]], [0, 1, 1], [0, 1, 0]],
    ] as const) {
      const set = new Set(solidCells.map((c) => c.join(',')));
      const solid = (x: number, y: number, z: number): boolean => set.has(`${x},${y},${z}`);
      // The centre of cell (0, 0, 0): 0.25 m on each axis.
      const ray = walkRay([0.25, 0.25, 0.25], dir)!;
      const got = walkVoxels(predicateSource(solid), ray, 10);
      expect(got.hit?.cell, `${JSON.stringify(solidCells)} along ${dir.join(',')}`).toEqual(want);
    }
  });

  it('hits at distance 0 in the cell it starts in, and reports the face it entered by', () => {
    const solid = (x: number, y: number): boolean => y < 0;
    const inside = walkVoxels(predicateSource(solid), walkRay([1.1, -0.3, 2.2], [0, 1, 0])!, 10);
    expect(inside.hit?.t).toBe(0);
    expect(inside.hit?.normal).toEqual([0, 0, 0]);
    const down = walkVoxels(predicateSource(solid), walkRay([1.1, 4.1, 2.2], [0, -1, 0])!, 10);
    expect(down.hit?.cell).toEqual([2, -1, 4]);
    expect(down.hit?.normal).toEqual([0, 1, 0]);
    expect(down.hit?.t).toBeCloseTo(4.1, 5);
    expect(walkVoxels(predicateSource(solid), walkRay([1.1, 4.1, 2.2], [0, 1, 0])!, 30).hit).toBeNull();
  });

  it('walks a coarser level where level 0 does not know a place, and air where nothing does', () => {
    // Level 0 knows only x < 0; level 1 (1 m cells) holds a wall at x in [40, 42) m.
    const wall1 = (x: number): boolean => x >= 40 && x < 42;
    const src = predicateSource(() => false, { known: (bx) => bx < 0, level1: (x) => wall1(x) });
    const hit = walkVoxels(src, walkRay([-5, 3, 3], [1, 0, 0])!, 100).hit;
    expect(hit?.level).toBe(1);
    expect(hit?.t).toBeCloseTo(45, 4);
    expect(hit?.cell[0]).toBe(80);
    const none = predicateSource(() => false, { known: (bx) => bx < 0 });
    expect(walkVoxels(none, walkRay([-5, 3, 3], [1, 0, 0])!, 100)).toMatchObject({ hit: null, end: 'distance' });
  });

  it("reads a derived result's columns as words exactly as its cells, for both stops: masks, partial cover, uniform cover", () => {
    const r = rng(21);
    let mixedLight = 0;
    for (const edge of [16, 32]) for (let k = 0; k < 24; k++) {
      const cells = edge ** 3;
      const words = cells / 32;
      const mask = (p: number): Uint32Array => Uint32Array.from({ length: words }, () => { let w = 0; for (let b = 0; b < 32; b++) if (r() < p) w |= 1 << b; return w >>> 0; });
      const occFlag = k % 6 === 0 ? OCCUPANCY.solid : OCCUPANCY.mixed;
      const partial = [...new Set(Array.from({ length: 300 }, () => Math.floor(r() * cells)))].sort((a, b) => a - b);
      // Uniform cover above and below the stop, else full cells and partly covering ones on both sides of it.
      const uniform = k % 4 === 1 ? 200 : k % 4 === 2 ? 60 : -1;
      const d = {
        edge,
        occupancy: { flag: occFlag, bricks: new Uint8Array((edge / 4) ** 3 / 4).fill(0xaa), mask: occFlag === OCCUPANCY.mixed ? mask(0.6) : null },
        light: { uniform, full: uniform >= 0 ? null : k % 3 === 0 ? null : mask(0.5), partialCells: Uint16Array.from(uniform >= 0 ? [] : partial), partialCover: Uint8Array.from(uniform >= 0 ? [] : partial.map(() => Math.floor(r() * 256))) },
      } as unknown as DerivedData;
      for (const stop of ['solid', 'light'] as const) {
        const v = derivedWalkView(d, stop);
        if (v.flag !== OCCUPANCY.mixed) continue;
        if (stop === 'light') mixedLight++;
        expect(v.column, `${edge} ${k} ${stop}`).toBeDefined();
        for (let c = 0; c < edge * edge; c++) {
          let want = 0;
          for (let y = 0; y < edge; y++) if (v.cell(c * edge + y)) want |= 1 << y;
          if ((v.column!(c) >>> 0) !== (want >>> 0)) throw new Error(`edge ${edge} case ${k} ${stop}: column ${c} ${v.column!(c) >>> 0} against ${want >>> 0}`);
        }
      }
    }
    expect(mixedLight).toBeGreaterThan(10);
  });

  it('walks the packed table (the GPU blocks) exactly as the views it was packed from', () => {
    const solid = blobWorld(5);
    const src = predicateSource(solid);
    const table = new WalkTable(64, 2);
    for (let bx = -4; bx < 4; bx++) for (let by = -2; by < 3; by++) for (let bz = -4; bz < 4; bz++) {
      const p = packWalkBlock(src, 0, bx, by, bz);
      if (p !== null) table.set(0, bx, by, bz, p);
    }
    expect(table.pagesUsed).toBeGreaterThan(0);
    const packed = table.source();
    let hits = 0;
    for (const ray of randomRays(13, 800)) {
      const a = walkVoxels(src, ray, 20);
      const b = walkVoxels(packed, ray, 20);
      expect([b.hit?.cell, b.hit?.normal, b.hit?.t]).toEqual([a.hit?.cell, a.hit?.normal, a.hit?.t]);
      if (a.hit !== null) hits++;
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('keeps the table findable through growth and deletions', () => {
    const t = new WalkTable(8, 1);
    const packed = { solid: OCCUPANCY.solid, light: OCCUPANCY.empty, page: null };
    const keys: Array<[number, number, number, number]> = [];
    const r = rng(9);
    for (let i = 0; i < 500; i++) keys.push([Math.floor(r() * 3), Math.floor(r() * 400 - 200), Math.floor(r() * 40 - 20), Math.floor(r() * 400 - 200)]);
    const uniq = [...new Map(keys.map((k) => [k.join(','), k])).values()];
    for (const k of uniq) t.set(...k, packed);
    expect(t.size).toBe(uniq.length);
    for (const [i, k] of uniq.entries()) if (i % 2 === 0) t.delete(...k);
    for (const [i, k] of uniq.entries()) expect(t.value(...k) >= 0, k.join(',')).toBe(i % 2 === 1);
  });
});
