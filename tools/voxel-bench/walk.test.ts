/**
 * The occupancy walk on real derived data (the town's houses with their
 * openings, the caves' tunnels and overhangs), across chunk faces and
 * negative coordinates: thousands of random rays against a cell-by-cell
 * walk over the same derived occupancy, light stops read from the derived
 * light coverage, the packed blocks (what the GPU reads) walking the same,
 * and rays leaving level 0 into far nodes hitting within a stated distance
 * of where level 0 would have stopped them.
 */
import { describe, expect, it } from 'vitest';
import { lightStops, packWalkBlock, walkRay, walkVoxels, WalkTable, type WalkRay, type WalkSource, type WalkStop } from '@thirdlight/voxel';

import { walkWorld, type WalkWorld } from './walk-world';
import { cavesWorld, cliffWorld, townWorld } from './worlds';

/** A seeded generator. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** The reference: cell by cell over a predicate, crossing times computed directly in 32 bits, ties x, y, z. */
function reference(r: WalkRay, stops: (x: number, y: number, z: number) => boolean, maxT: number): { cell: number[]; normal: number[]; t: number } | null {
  const c = [...r.cell];
  const f = Math.fround;
  let t = 0;
  let axis = -1;
  for (let k = 0; k < 200000; k++) {
    if (t > maxT) return null;
    if (stops(c[0]!, c[1]!, c[2]!)) {
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

/** Rays from inside the box (metres) in random directions, a share aimed down or along an axis. */
function rays(w: WalkWorld, seed: number, n: number, yRange: readonly [number, number]): WalkRay[] {
  const r = rng(seed);
  const lo = w.min.map((m) => m * 16);
  const hi = w.max.map((m) => (m + 1) * 16);
  const out: WalkRay[] = [];
  while (out.length < n) {
    const o = [lo[0]! + 4 + r() * (hi[0]! - lo[0]! - 8), yRange[0] + r() * (yRange[1] - yRange[0]), lo[2]! + 4 + r() * (hi[2]! - lo[2]! - 8)];
    const k = r();
    const d = k < 0.08 ? [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, -1, 0], [1, 0, 1]][Math.floor(r() * 5)]! : [r() * 2 - 1, r() * 2 - 1.3, r() * 2 - 1];
    const ray = walkRay(o, d);
    if (ray !== null) out.push(ray);
  }
  return out;
}

/** The stop's truth cell by cell from the derived results. */
function stopsOf(w: WalkWorld, stop: WalkStop): (x: number, y: number, z: number) => boolean {
  if (stop === 'solid') return (x, y, z) => w.solidAt(x, y, z);
  return (x, y, z) => {
    const a = w.sections.get(`${x >> 4},${y >> 4},${z >> 4}`);
    if (a == null) return false;
    return lightStops(a.occupancy, a.light, (((x & 15) * 16 + (z & 15)) * 16) + (y & 15));
  };
}

// The town's centre lots (houses with doors, windows and stairs) moved so the box spans chunks −3 … 2.
const town = walkWorld(townWorld({ footprint: 512 }), [-3, -1, -3], [2, 1, 2], [8, 0, 8], 2);
// The caves' tunnels under rough ground.
const caves = walkWorld(cavesWorld({ footprint: 512 }), [-2, -2, -2], [2, 1, 2], [6, 0, 6]);
// A 20 m cliff on a diagonal through the origin, with far nodes of 2 m cells over it.
const cliff = walkWorld(cliffWorld({ footprint: 512 }), [-3, -1, -3], [2, 2, 2], [0, 0, 0], 2);

describe('the occupancy walk on derived worlds', () => {
  for (const [name, w, ys] of [['town', town, [0.5, 14]], ['caves', caves, [-40, 30]]] as const) {
    for (const stop of ['solid', 'light'] as const) {
      it(`${name}, ${stop}: every hit equals the cell-by-cell walk's, with and without skipping`, () => {
        const src = w.source();
        const truth = stopsOf(w, stop);
        let hits = 0;
        let misses = 0;
        for (const ray of rays(w, name.length * 31 + stop.length, 1200, ys)) {
          const want = reference(ray, truth, 30);
          for (const skip of [true, false]) {
            const got = walkVoxels(src, ray, 30, { stop, skip });
            expect(got.hit === null ? null : [got.hit.cell, got.hit.normal, got.hit.t]).toEqual(want === null ? null : [want.cell, want.normal, want.t]);
          }
          if (want === null) misses++;
          else hits++;
        }
        expect(hits).toBeGreaterThan(200);
        expect(misses).toBeGreaterThan(20);
      });
    }
  }

  it('reads the hit cell\'s record (material and role) at level 0', () => {
    const hit = walkVoxels(town.source(), walkRay([3, 10, 3], [0.1, -1, 0.05])!, 30).hit;
    expect(hit).not.toBeNull();
    expect(hit!.record).not.toBeNull();
    expect(hit!.record! & 0xfff).toBeGreaterThan(0);
  });

  it('stops light where light coverage is half or more: the light stops are a subset of the solid stops, and the town has both kinds', () => {
    // Every light stop is solid; damaged and partial cells may be solid and let light on.
    let solid = 0;
    let light = 0;
    const s = stopsOf(town, 'solid');
    const l = stopsOf(town, 'light');
    for (let x = -48; x < 48; x++) for (let z = -48; z < 48; z++) for (let y = -4; y < 24; y++) {
      if (l(x, y, z)) {
        expect(s(x, y, z)).toBe(true);
        light++;
      }
      if (s(x, y, z)) solid++;
    }
    expect(light).toBeGreaterThan(1000);
    expect(solid).toBeGreaterThanOrEqual(light);
  });

  it('walks the packed blocks (the GPU mirror) exactly as the derive sections they were packed from', () => {
    const src = town.source();
    const table = new WalkTable(64, 4);
    for (let bx = town.min[0]; bx <= town.max[0]; bx++) for (let by = town.min[1]; by <= town.max[1]; by++) for (let bz = town.min[2]; bz <= town.max[2]; bz++) {
      const p = packWalkBlock(src, 0, bx, by, bz);
      expect(p).not.toBeNull();
      table.set(0, bx, by, bz, p!);
    }
    const packed = table.source();
    let hits = 0;
    for (const stop of ['solid', 'light'] as const) {
      for (const ray of rays(town, 77, 600, [0.5, 14])) {
        const a = walkVoxels(src, ray, 30, { stop });
        const b = walkVoxels(packed, ray, 30, { stop });
        expect([b.hit?.cell, b.hit?.normal, b.hit?.t]).toEqual([a.hit?.cell, a.hit?.normal, a.hit?.t]);
        if (a.hit !== null) hits++;
      }
    }
    expect(hits).toBeGreaterThan(200);
  });

  it('packs each block from the derive sections\' bit words as it does cell by cell, byte for byte, in a fraction of the time', () => {
    const src = town.source();
    // The same views without their column words: the packing reads them cell by cell.
    const cells: WalkSource = { maxLevel: 0, blockShift: (l) => src.blockShift(l), block: (l, x, y, z, stop) => {
      const v = src.block(l, x, y, z, stop);
      return v === null ? null : { flag: v.flag, brick: (i) => v.brick(i), cell: (i) => v.cell(i) };
    } };
    const keys: Array<[number, number, number]> = [];
    for (let bx = town.min[0]; bx <= town.max[0]; bx++) for (let by = town.min[1]; by <= town.max[1]; by++) for (let bz = town.min[2]; bz <= town.max[2]; bz++) keys.push([bx, by, bz]);
    let pages = 0;
    for (const [bx, by, bz] of keys) {
      const a = packWalkBlock(cells, 0, bx, by, bz)!;
      const b = packWalkBlock(src, 0, bx, by, bz)!;
      expect([b.solid, b.light]).toEqual([a.solid, a.light]);
      expect(b.page === null).toBe(a.page === null);
      if (a.page === null) continue;
      pages++;
      expect(Buffer.compare(Buffer.from(b.page!.buffer), Buffer.from(a.page.buffer)), `${bx},${by},${bz}`).toBe(0);
    }
    expect(pages).toBeGreaterThan(30);
    const time = (s: WalkSource): number => {
      const t0 = performance.now();
      for (let r = 0; r < 3; r++) for (const [bx, by, bz] of keys) packWalkBlock(s, 0, bx, by, bz);
      return (performance.now() - t0) / (3 * keys.length);
    };
    time(src);
    const [slow, fast] = [time(cells), time(src)];
    console.log(`[walk pack] town, ${keys.length} blocks (${pages} with a page): cell by cell ${slow.toFixed(3)} ms a block, by words ${fast.toFixed(3)}`);
    expect(fast).toBeLessThan(slow / 2);
  });

  it('continues into far nodes past level 0 and hits the ground within 1.5 m of where level 0 stops the ray', () => {
    // Level 0 knows only the sections within 12 m of the box's middle; far nodes (2 m cells) cover the rest.
    const near = (sx: number, sy: number, sz: number): boolean => Math.hypot(sx * 8 + 4, sz * 8 + 4) < 12 && sy >= -2;
    const full = cliff.source();
    const ring = cliff.source({ known: near, far: true });
    const r = rng(5);
    let far = 0;
    let within = 0;
    let n = 0;
    let worst = 0;
    for (let k = 0; k < 600; k++) {
      // From over the cliff's top, outward and down at 10°–40° below the horizon, to the ground past level 0's ring.
      const yaw = r() * 2 * Math.PI;
      const pitch = (10 + r() * 30) * (Math.PI / 180);
      const ray = walkRay([r() * 4 - 2, 34 + r() * 8, r() * 4 - 2], [Math.cos(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch)])!;
      const truth = walkVoxels(full, ray, 60).hit;
      const got = walkVoxels(ring, ray, 60);
      if (truth === null) continue;
      expect(got.hit).not.toBeNull();
      n++;
      if (got.hit!.far) far++;
      const p = (h: { t: number }): number[] => ray.origin.map((o, a) => o + ray.dir[a]! * h.t);
      const d = Math.hypot(...p(got.hit!).map((v, a) => v - p(truth)[a]!));
      worst = Math.max(worst, d);
      if (d <= 1.5) within++;
    }
    expect(n).toBeGreaterThan(300);
    expect(far).toBeGreaterThan(150);
    // Stated tolerance: 1.5 m (three 0.5 m cells; the far node's cells are 2 m) for 95 % of the rays. A ray grazing an
    // edge may pass it in the far nodes (their surface lies up to a far cell off level 0's) and land beyond: on this
    // cliff 7 of 415 (the worst 34 m, over the cliff's top edge onto the low ground).
    expect(within / n, `${within} of ${n} within 1.5 m, worst ${worst.toFixed(1)} m`).toBeGreaterThanOrEqual(0.95);
  });
});
