/**
 * The walk graph against a brute force on generated chunks, with the real
 * derive (the world rules, 16³ sections of 32³ chunks): the step rule on hand
 * scraps (a step, a 1 m wall, a stair run, a one-cell doorway, a low
 * ceiling, a diagonal past a corner, a ledge with and without drops), a
 * chunk's pieces against a flood, the stitching (arrival orders, leaving,
 * an edit: the graph equals one made from the whole box at once; slices on
 * a stepping clock), the two-level path against one A* over every cell and
 * against a Dijkstra over the brute force's graph, unknown against
 * unreachable, and what an edit makes again.
 */
import { describe, expect, it, vi } from 'vitest';

import { mulberry32 } from '@thirdlight/shared';
import { buildApron } from './apron';
import { jobRadius } from './assembly';
import { chunkGrid, sectionGrid, type CellGrid } from './coords';
import { deriveSectionsWithApron, sectionLocalOrigin } from './derive-assembly';
import type { DerivedData } from './derived-data';
import { createWorldStore, type PaletteStore } from './palette-store';
import { SHAPE_FULL, VOXEL_ROLE, voxel } from './record';
import { WORLD_RULES } from './rule-registry';
import type { DeriveOutput } from './stream-job';
import { NO_WALK_PIECE, sameWalkChunk, WALK_CLEARANCE_MAX, type WalkChunk } from './walk-graph-cells';
import { WalkGraph, type WalkGraphView } from './walk-graph';
import { WalkQueries, type WalkPathAnswer, type WalkQueryOptions, type WalkReachAnswer } from './walk-graph-queries';

const grid = chunkGrid(32);
const SECTIONS: CellGrid = sectionGrid(16);
const IDS = Array.from({ length: 8 }, (_, i) => i);
const R = jobRadius(WORLD_RULES);
const M = 0.5;

const WALL = voxel(5, VOXEL_ROLE.wall, SHAPE_FULL);
const ROCK = voxel(3, VOXEL_ROLE.terrain, SHAPE_FULL);
const OPENING = voxel(5, VOXEL_ROLE.opening, 0);
const AIR = voxel();

type Box = readonly [number, number, number, number, number, number];
type P3 = readonly [number, number, number];

/** A test world: a store, its chunks derived on demand, and which chunks are loaded. */
class TestWorld {
  readonly store: PaletteStore = createWorldStore(grid);
  readonly derived = new Map<string, DerivedData>();
  readonly loaded = new Set<string>();

  fill(b: Box, v: typeof WALL): void {
    for (let x = b[0]; x <= b[3]; x++) for (let y = b[1]; y <= b[4]; y++) for (let z = b[2]; z <= b[5]; z++) this.store.setVoxel(x, y, z, v);
  }

  derive(cx: number, cy: number, cz: number): void {
    const results = deriveSectionsWithApron(grid, WORLD_RULES, buildApron(this.store, cx, cy, cz, R), (out) => this.store.exportChunk(cx, cy, cz, out), 16, IDS);
    for (const r of results) {
      const [lx, ly, lz] = sectionLocalOrigin(grid.edge, 16, r.id);
      this.derived.set(`${cx * 2 + lx / 16},${cy * 2 + ly / 16},${cz * 2 + lz / 16}`, r.assembly!);
    }
  }

  load(cx: number, cy: number, cz: number): void {
    this.derive(cx, cy, cz);
    this.loaded.add(`${cx},${cy},${cz}`);
  }

  view(): WalkGraphView {
    return {
      grid,
      sections: SECTIONS,
      derivedOf: (sx, sy, sz) => {
        if (!this.loaded.has(`${sx >> 1},${sy >> 1},${sz >> 1}`)) return null;
        const d = this.derived.get(`${sx},${sy},${sz}`);
        return d === undefined ? null : ({ assembly: d } as unknown as DeriveOutput);
      },
    };
  }

  /** The brute force's own reading of a cell: a body (the scraps hold only walls and full rock: both block and support). */
  body(x: number, y: number, z: number): boolean {
    const v = voxel();
    this.store.voxelAt(x, y, z, v);
    return v.role !== VOXEL_ROLE.air && v.role !== VOXEL_ROLE.opening && v.role !== VOXEL_ROLE.liquid;
  }
}

function loadAll(w: TestWorld, lo: P3, hi: P3, order?: (l: number[][]) => number[][]): WalkGraph {
  let list: number[][] = [];
  for (let cx = lo[0]; cx <= hi[0]; cx++) for (let cy = lo[1]; cy <= hi[1]; cy++) for (let cz = lo[2]; cz <= hi[2]; cz++) list.push([cx, cy, cz]);
  if (order !== undefined) list = order(list);
  const g = new WalkGraph(w.view(), M);
  for (const [cx, cy, cz] of list) {
    if (!w.derived.has(`${cx! * 2},${cy! * 2},${cz! * 2}`)) w.derive(cx!, cy!, cz!);
    w.loaded.add(`${cx},${cy},${cz}`);
    g.touch(cx!, cy!, cz!);
  }
  g.update();
  return g;
}

function path(g: WalkGraph, from: P3, to: P3, options: WalkQueryOptions = {}): WalkPathAnswer {
  const q = new WalkQueries(g);
  let out: WalkPathAnswer | null = null;
  q.path(from, to, options, (a) => (out = a));
  while (out === null) q.serve(Infinity);
  return out;
}

function reach(g: WalkGraph, from: P3, maxCost: number, options: WalkQueryOptions = {}): WalkReachAnswer {
  const q = new WalkQueries(g);
  let out: WalkReachAnswer | null = null;
  q.reach(from, maxCost, { ...options, cells: true }, (a) => (out = a));
  while (out === null) q.serve(Infinity);
  return out;
}

const cellsOf = (a: { readonly cells: Int32Array | null }): P3[] => {
  const out: P3[] = [];
  for (let k = 0; k < (a.cells?.length ?? 0); k += 3) out.push([a.cells![k]!, a.cells![k + 1]!, a.cells![k + 2]!]);
  return out;
};

/**
 * The brute force: the step rule written out over the store's cells, a Dijkstra over every cell of the loaded box.
 * Standable: free over a body; clearance: free cells up to the rule's limit; a step to the 8 columns round, one cell up
 * or down, room for the walker at both ends and a cell more at the lower end; a diagonal inside one chunk, both
 * columns beside walked the same way.
 */
class Brute {
  constructor(
    readonly w: TestWorld,
    readonly lo: P3,
    readonly hi: P3,
    readonly h = 4,
  ) {}

  inBox(x: number, y: number, z: number): boolean {
    return [x, y, z].every((v, a) => v >= this.lo[a]! * 32 && v <= this.hi[a]! * 32 + 31);
  }

  clear(x: number, y: number, z: number): number {
    let f = 0;
    while (f < WALK_CLEARANCE_MAX && !this.w.body(x, y + f, z)) f++;
    return f;
  }

  standable(x: number, y: number, z: number): boolean {
    return this.inBox(x, y, z) && !this.w.body(x, y, z) && this.w.body(x, y - 1, z) && this.clear(x, y, z) >= this.h;
  }

  fits(a: P3, b: P3): boolean {
    const dy = b[1] - a[1];
    const ca = this.clear(...a);
    const cb = this.clear(...b);
    if (dy === 0) return ca >= this.h && cb >= this.h;
    if (dy === 1) return ca >= this.h + 1 && cb >= this.h;
    if (dy === -1) return ca >= this.h && cb >= this.h + 1;
    return false;
  }

  /** The straight step from `a` toward (dx, dz) (at most one of the three levels fits), or null. */
  straight(a: P3, dx: number, dz: number): P3 | null {
    for (const dy of [0, 1, -1]) {
      const b: P3 = [a[0] + dx, a[1] + dy, a[2] + dz];
      if (this.standable(...b) && this.fits(a, b)) return b;
    }
    return null;
  }

  steps(a: P3): Array<[P3, number]> {
    const out: Array<[P3, number]> = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const b = this.straight(a, dx, dz);
      if (b !== null) out.push([b, Math.hypot(dx, b[1] - a[1], dz) * M]);
    }
    const chunk = (p: P3): string => p.map((v) => v >> 5).join(',');
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      const oa = this.straight(a, dx, 0);
      const ob = this.straight(a, 0, dz);
      if (oa === null || ob === null) continue;
      for (const dy of [0, 1, -1]) {
        const b: P3 = [a[0] + dx, a[1] + dy, a[2] + dz];
        if (!this.standable(...b) || !this.fits(a, b)) continue;
        if (![oa, ob, b].every((p) => chunk(p) === chunk(a))) break;
        if (this.fits(oa, b) && this.fits(ob, b)) out.push([b, Math.hypot(1, dy, 1) * M]);
        break;
      }
    }
    return out;
  }

  /** Every cell's cost from `from` (by key). */
  dijkstra(from: P3): Map<string, number> {
    const dist = new Map<string, number>([[from.join(','), 0]]);
    const open: Array<[number, P3]> = [[0, from]];
    const done = new Set<string>();
    while (open.length > 0) {
      open.sort((p, q) => p[0] - q[0]);
      const [d, a] = open.shift()!;
      const k = a.join(',');
      if (done.has(k)) continue;
      done.add(k);
      for (const [b, c] of this.steps(a)) {
        const kb = b.join(',');
        if ((dist.get(kb) ?? Infinity) <= d + c + 1e-12) continue;
        dist.set(kb, d + c);
        open.push([d + c, b]);
      }
    }
    return dist;
  }
}

/**
 * Flat rock to `top` over chunks x, z 0 … n − 1 (cy 0 holds the ground's top cells), walled round the box's outer
 * cells to the chunk's top: no step leaves the box, so nothing of it is on a frontier (a way into a chunk not loaded).
 */
function ground(w: TestWorld, nx: number, nz: number, top = 7): void {
  w.fill([-32, -40, -32, nx * 32 + 31, top, nz * 32 + 31], ROCK);
  const X = nx * 32 - 1;
  const Z = nz * 32 - 1;
  for (const b of [[0, top + 1, 0, X, 31, 0], [0, top + 1, Z, X, 31, Z], [0, top + 1, 0, 0, 31, Z], [X, top + 1, 0, X, 31, Z]] as const) w.fill(b, WALL);
}

describe('walk graph: the step rule on hand scraps', () => {
  it('steps up a cell, not two (a 1 m wall), walks a stair run, and passes a one-cell doorway but not a low ceiling', () => {
    const w = new TestWorld();
    ground(w, 1, 1);
    // A one-cell step at x 6 (y 8 becomes the floor), a two-cell wall at x 12 across z 0 … 9.
    w.fill([6, 8, 0, 9, 8, 31], ROCK);
    w.fill([12, 8, 0, 12, 9, 9], WALL);
    // A stair: one cell up a cell along z, from z 20 to 25, x 20 … 21, to a landing 6 cells up.
    for (let k = 0; k < 6; k++) w.fill([20, 8 + k, 20 + k, 21, 8 + k, 20 + k], WALL);
    w.fill([20, 8, 26, 23, 13, 29], WALL);
    // A wall at z 14 across x 13 … 31 with a doorway one cell wide (x 16, 4 cells high), and a low passage under a
    // ceiling 3 cells up (x 26).
    w.fill([13, 8, 14, 31, 15, 14], WALL);
    w.fill([16, 8, 14, 16, 11, 14], AIR);
    w.fill([26, 8, 14, 26, 10, 14], AIR);
    const g = loadAll(w, [0, 0, 0], [0, 0, 0]);
    // On the floor at y 8: up onto the step (y 9) and on.
    const up = path(g, [2, 8, 4], [8, 9, 4]);
    expect(up.status).toBe('found');
    expect(cellsOf(up).some(([x, y]) => x === 6 && y === 9)).toBe(true);
    // Over the 1 m wall: no step; the way round its end at z 10.
    const over = path(g, [11, 8, 4], [13, 8, 4]);
    expect(over.status).toBe('found');
    expect(cellsOf(over).some(([, , z]) => z >= 10)).toBe(true);
    // Up the stair onto the landing (y 14 on top of it).
    const stair = path(g, [20, 8, 18], [21, 14, 28]);
    expect(stair.status).toBe('found');
    expect(cellsOf(stair).filter(([, y]) => y > 8 && y < 14).length).toBe(5);
    // Through the doorway at x 16 (2 m: exactly a walker's height), never through the 1.5 m gap at x 26.
    const door = path(g, [16, 8, 12], [16, 8, 16]);
    expect(door.status).toBe('found');
    expect(cellsOf(door).some(([x, , z]) => x === 16 && z === 14)).toBe(true);
    const low = path(g, [26, 8, 12], [26, 8, 16]);
    expect(cellsOf(low).some(([x, , z]) => x === 26 && z === 14)).toBe(false);
    // A walker 1.5 m tall goes under it (the cell level alone: the pieces are the default walker's).
    const short = path(g, [26, 8, 12], [26, 8, 16], { height: 3 });
    expect(short.status).toBe('found');
    expect(short.hierarchy).toBe(false);
    expect(cellsOf(short).some(([x, , z]) => x === 26 && z === 14)).toBe(true);
    expect(short.cost).toBeCloseTo(4 * M, 9);
  });

  it('takes no diagonal past a corner and none across a chunk face', () => {
    const w = new TestWorld();
    ground(w, 2, 1);
    // A pillar at (10, 8 … 11, 10): from (9, 8, 9) to (11, 8, 11) every diagonal near it would cut its corner, so the
    // walk round it is four straight steps (2 m), not √2 + √2.
    w.fill([10, 8, 10, 10, 11, 10], WALL);
    const g = loadAll(w, [0, 0, 0], [1, 0, 0]);
    const a = path(g, [9, 8, 9], [11, 8, 11]);
    expect(a.status).toBe('found');
    expect(a.cost).toBeCloseTo(4 * M, 9);
    expect(cellsOf(a).some(([x, , z]) => x === 10 && z === 10)).toBe(false);
    // Open ground across the face at x 32: two diagonal steps inside, one straight across.
    const b = path(g, [30, 8, 4], [33, 8, 7]);
    expect(b.cost).toBeCloseTo((2 * Math.SQRT2 + 1 + 1) * M, 9);
  });

  it('walks off a ledge only when drops are allowed, as far as the drop allowed', () => {
    const w = new TestWorld();
    ground(w, 1, 1);
    // A platform 4 cells up (x 0 … 9), a sheer edge at x 10.
    w.fill([0, 8, 0, 9, 11, 31], ROCK);
    const g = loadAll(w, [0, 0, 0], [0, 0, 0]);
    const none = path(g, [4, 12, 4], [14, 8, 4]);
    expect(none.status).toBe('unreachable');
    const shallow = path(g, [4, 12, 4], [14, 8, 4], { maxDrop: 3 });
    expect(shallow.status).toBe('unreachable');
    const drop = path(g, [4, 12, 4], [14, 8, 4], { maxDrop: 4 });
    expect(drop.status).toBe('found');
    // The drop is straight off the edge and goes one way.
    const back = path(g, [14, 8, 4], [4, 12, 4], { maxDrop: 4 });
    expect(back.status).toBe('unreachable');
  });
});

/** A random scrap: ground of terraces (0–2 cells between columns' blocks), walls with gaps, over 2 × 1 × 2 chunks. */
function scrap(seed: number): TestWorld {
  const w = new TestWorld();
  const r = mulberry32(seed);
  ground(w, 2, 2, 5);
  // Terraces of 4 × 4 cells, each within a cell of the mean of those before it (mostly walkable, some 2-cell cliffs).
  const hs: number[][] = [];
  for (let bx = 0; bx < 16; bx++) {
    hs.push([]);
    for (let bz = 0; bz < 16; bz++) {
      const prev = bx === 0 && bz === 0 ? 1 : ((bx > 0 ? hs[bx - 1]![bz]! : hs[bx]![bz - 1]!) + (bz > 0 ? hs[bx]![bz - 1]! : hs[bx - 1]![bz]!)) / 2;
      const h = Math.max(0, Math.min(3, Math.round(prev + (r() * 2.4 - 1.2))));
      hs[bx]!.push(h);
      if (h > 0) w.fill([bx * 4, 6, bz * 4, bx * 4 + 3, 5 + h, bz * 4 + 3], ROCK);
    }
  }
  for (let k = 0; k < 14; k++) {
    const x = Math.floor(r() * 60);
    const z = Math.floor(r() * 60);
    const along = r() < 0.5;
    const len = 4 + Math.floor(r() * 20);
    w.fill(along ? [x, 6, z, Math.min(63, x + len), 13, z] : [x, 6, z, x, 13, Math.min(63, z + len)], WALL);
    // A doorway in it.
    const d = 1 + Math.floor(r() * (len - 2));
    w.fill(along ? [Math.min(63, x + d), 6, z, Math.min(63, x + d), 13, z] : [x, 6, Math.min(63, z + d), x, 13, Math.min(63, z + d)], AIR);
  }
  return w;
}

/** A standable cell of the brute force near (x, z) (its highest), or null. */
function standAt(b: Brute, x: number, z: number): P3 | null {
  for (let y = 20; y >= 0; y--) if (b.standable(x, y, z)) return [x, y, z];
  return null;
}

describe('walk graph against the brute force', () => {
  it('gives a chunk the brute force’s cells and pieces (a flood inside it)', () => {
    for (const seed of [1, 2, 3]) {
      const w = scrap(seed);
      const g = loadAll(w, [0, 0, 0], [1, 0, 1]);
      const b = new Brute(w, [0, 0, 0], [1, 0, 1]);
      for (const c of g.parts()) {
        if (c.cy !== 0) continue;
        // Cells: every standable cell (clearance ≥ the default walker's in a piece), with its clearance.
        let inPieces = 0;
        for (let i = 0; i < c.ys.length; i++) {
          const x = c.cx * 32 + ((c.col[i]! / 32) | 0);
          const z = c.cz * 32 + (c.col[i]! % 32);
          const y = c.ys[i]!;
          expect(b.w.body(x, y, z)).toBe(false);
          expect(b.w.body(x, y - 1, z)).toBe(true);
          expect(Math.min(c.clear[i]!, WALK_CLEARANCE_MAX)).toBe(b.clear(x, y, z));
          if (c.piece[i] !== NO_WALK_PIECE) inPieces++;
        }
        // Pieces: a flood over the brute force's steps that stay in the chunk.
        const key = (p: P3): string => p.join(',');
        const pieceOf = new Map<string, number>();
        for (let i = 0; i < c.ys.length; i++) if (c.piece[i] !== NO_WALK_PIECE) pieceOf.set(key([c.cx * 32 + ((c.col[i]! / 32) | 0), c.ys[i]!, c.cz * 32 + (c.col[i]! % 32)]), c.piece[i]!);
        expect(pieceOf.size).toBe(inPieces);
        const seen = new Set<string>();
        let floods = 0;
        for (const [k] of pieceOf) {
          if (seen.has(k)) continue;
          floods++;
          const want = pieceOf.get(k)!;
          const queue: P3[] = [k.split(',').map(Number) as unknown as P3];
          seen.add(k);
          while (queue.length > 0) {
            const a = queue.pop()!;
            expect(pieceOf.get(key(a))).toBe(want);
            for (const [n] of b.steps(a)) {
              const kn = key(n);
              if (!pieceOf.has(kn) || seen.has(kn)) continue;
              seen.add(kn);
              queue.push(n);
            }
          }
        }
        expect(floods).toBe(c.pieces.length);
      }
    }
  });

  it('finds the brute force’s cheapest cost over every cell (one A*), and two levels within 8 % of it', () => {
    let pairs = 0;
    let worst = 1;
    let worstWalked = 1;
    let sum = 0;
    let unreachable = 0;
    for (const seed of [11, 12, 13, 14]) {
      const w = scrap(seed);
      const g = loadAll(w, [0, 0, 0], [1, 0, 1]);
      const b = new Brute(w, [0, 0, 0], [1, 0, 1]);
      const r = mulberry32(seed * 7);
      for (let k = 0; k < 8; k++) {
        const s = standAt(b, Math.floor(r() * 64), Math.floor(r() * 64));
        if (s === null) continue;
        const truth = b.dijkstra(s);
        for (let m = 0; m < 4; m++) {
          const t = standAt(b, Math.floor(r() * 64), Math.floor(r() * 64));
          if (t === null) continue;
          const want = truth.get(t.join(','));
          const flat = path(g, s, t, { hierarchy: false });
          const two = path(g, s, t, { flatFirst: 0 });
          const walked = path(g, s, t, { flatFirst: 0, exitCosts: 'walk' });
          if (want !== undefined) {
            expect(walked.status).toBe('found');
            worstWalked = Math.max(worstWalked, want > 0 ? walked.cost / want : 1);
          }
          if (want === undefined) {
            expect(flat.status).toBe('unreachable');
            expect(two.status).toBe('unreachable');
            unreachable++;
            continue;
          }
          expect(flat.status).toBe('found');
          expect(flat.cost).toBeCloseTo(want, 9);
          expect(two.status).toBe('found');
          expect(two.hierarchy).toBe(true);
          expect(two.cost).toBeGreaterThanOrEqual(want - 1e-9);
          const ratio = want > 0 ? two.cost / want : 1;
          worst = Math.max(worst, ratio);
          sum += ratio;
          pairs++;
          // The path is the brute force's steps, start to end.
          const cells = cellsOf(two);
          expect(cells[0]).toEqual(s);
          expect(cells[cells.length - 1]).toEqual(t);
          for (let i = 1; i < cells.length; i++) expect(b.steps(cells[i - 1]!).some(([n]) => n.join(',') === cells[i]!.join(','))).toBe(true);
        }
      }
    }
    console.log(`[walk graph] ${pairs} pairs found, ${unreachable} unreachable; two levels over one A* (straight exit costs): mean ${(sum / pairs).toFixed(4)}, worst ${worst.toFixed(4)}; with walked exit costs worst ${worstWalked.toFixed(4)}`);
    expect(pairs).toBeGreaterThan(40);
    expect(unreachable).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(1.08);
  });

  it('reaches the brute force’s cells within a cost', () => {
    const w = scrap(21);
    const g = loadAll(w, [0, 0, 0], [1, 0, 1]);
    const b = new Brute(w, [0, 0, 0], [1, 0, 1]);
    const s = standAt(b, 30, 30)!;
    const truth = b.dijkstra(s);
    for (const limit of [3, 8, 20]) {
      const a = reach(g, s, limit);
      expect(a.status).toBe('found');
      const want = [...truth].filter(([, d]) => d <= limit + 1e-9).map(([k]) => k).sort();
      expect(cellsOf(a).map((p) => p.join(',')).sort()).toEqual(want);
    }
  });
});

describe('walk graph: stitching', () => {
  /** The graph's parts and exits, as comparable text (exits by their cells, not ids). */
  function shape(g: WalkGraph): { parts: Map<string, WalkChunk>; exits: string[] } {
    const parts = new Map<string, WalkChunk>();
    const exits: string[] = [];
    for (const c of g.parts()) {
      parts.set(`${c.cx},${c.cy},${c.cz}`, c);
      for (let p = 0; p < c.pieces.length; p++) for (const x of g.exitsOf(c, p)) exits.push(`${x.from.key}:${x.a}>${x.to.key}:${x.b}`);
    }
    return { parts, exits: exits.sort() };
  }

  function same(a: WalkGraph, b: WalkGraph): void {
    const sa = shape(a);
    const sb = shape(b);
    expect([...sa.parts.keys()].sort()).toEqual([...sb.parts.keys()].sort());
    for (const [k, c] of sa.parts) expect(sameWalkChunk(c, sb.parts.get(k)!)).toBe(true);
    expect(sa.exits).toEqual(sb.exits);
  }

  it('makes the same graph for chunks arriving in any order, as one made at once', () => {
    const w = scrap(31);
    const whole = loadAll(w, [0, -1, 0], [1, 1, 1]);
    expect(whole.stats().exits).toBeGreaterThan(10);
    for (const seed of [1, 2, 3, 4]) {
      const r = mulberry32(seed);
      const g = new WalkGraph(w.view(), M);
      const list: P3[] = [];
      for (let cx = 0; cx <= 1; cx++) for (let cy = -1; cy <= 1; cy++) for (let cz = 0; cz <= 1; cz++) list.push([cx, cy, cz]);
      list.sort(() => r() - 0.5);
      // Arrivals with updates between them (a part made before its neighbours and its chunk above).
      for (const c of list) {
        g.touch(...c);
        if (r() < 0.6) g.update();
      }
      g.update();
      same(g, whole);
    }
  });

  it('answers unknown past a chunk not loaded, unreachable from a sealed room, and drops what leaves', () => {
    const w = scrap(41);
    // A sealed room on chunk (0, 0, 0)'s ground: walls round x 2 … 8, z 2 … 8.
    w.fill([2, 6, 2, 8, 15, 8], WALL);
    w.fill([3, 9, 3, 7, 14, 7], AIR);
    w.fill([3, 6, 3, 7, 8, 7], ROCK);
    for (const c of [[0, 0, 0], [0, -1, 0], [0, 1, 0]] as P3[]) w.load(...c);
    const g = new WalkGraph(w.view(), M);
    for (const c of [[0, 0, 0], [0, -1, 0], [0, 1, 0]] as P3[]) g.touch(...c);
    g.update();
    const b = new Brute(w, [0, -1, 0], [0, 1, 0]);
    const s = standAt(b, 20, 20)!;
    // The end in chunk (1, 0, 0), not loaded: unknown, the path ending on the frontier (x 31).
    const far = path(g, s, [44, 9, 20], { flatFirst: 0 });
    expect(far.status).toBe('unknown');
    const end = cellsOf(far).at(-1)!;
    expect(end[0]).toBe(31);
    const flatFar = path(g, s, [44, 9, 20], { hierarchy: false });
    expect(flatFar.status).toBe('unknown');
    expect(cellsOf(flatFar).at(-1)![0]).toBe(31);
    // From inside the sealed room: every way out is known and none leaves it.
    const sealed = path(g, [5, 9, 5], [44, 9, 20], { flatFirst: 0 });
    expect(sealed.status).toBe('unreachable');
    expect(path(g, [5, 9, 5], [44, 9, 20], { hierarchy: false }).status).toBe('unreachable');
    expect(reach(g, [5, 9, 5], 100).status).toBe('found');
    expect(reach(g, s, 100).status).toBe('unknown');
    // Loaded, the end is found; unloaded again, unknown again (its part and exits gone).
    w.load(1, 0, 0);
    w.load(1, -1, 0);
    w.load(1, 1, 0);
    for (const c of [[1, 0, 0], [1, -1, 0], [1, 1, 0]] as P3[]) g.touch(...c);
    g.update();
    const t = standAt(new Brute(w, [1, -1, 0], [1, 1, 0]), 44, 20)!;
    const near = path(g, s, t);
    expect(['found', 'unreachable']).toContain(near.status);
    const exits = g.stats().exits;
    for (const c of [[1, 0, 0], [1, -1, 0], [1, 1, 0]] as P3[]) {
      w.loaded.delete(c.join(','));
      g.touch(...c);
    }
    g.update();
    expect(g.stats().exits).toBeLessThan(exits);
    expect(g.chunkAt(1, 0, 0)).toBeNull();
    expect(path(g, s, t).status).toBe('unknown');
  });

  it('makes again only the chunk an edit changes (and the one its cell touches), and answers the new truth', () => {
    const w = scrap(51);
    // Level ground round x 36 … 44, z 16 … 24 (floor y 8), and a wall across the whole box at x 40 to y 20 with one
    // doorway 2 m high at z 20.
    w.fill([36, 6, 16, 44, 7, 24], ROCK);
    w.fill([36, 8, 16, 44, 20, 24], AIR);
    w.fill([40, 6, 1, 40, 20, 62], WALL);
    w.fill([40, 8, 20, 40, 11, 20], AIR);
    const g = loadAll(w, [0, -1, 0], [1, 1, 1]);
    const s: P3 = [37, 8, 20];
    const t: P3 = [43, 8, 20];
    const open = path(g, s, t, { flatFirst: 0 });
    expect(open.status).toBe('found');
    expect(cellsOf(open).some(([x, , z]) => x === 40 && z === 20)).toBe(true);
    // Wall the doorway up: an edit inside chunk (1, 0, 0) (x 40 is its local 8).
    const before = g.stats();
    const doorY = 8;
    w.fill([40, doorY, 20, 40, doorY + 3, 20], WALL);
    for (const c of [[1, 0, 0]] as P3[]) {
      w.derive(...c);
      g.touch(...c);
    }
    g.update();
    const after = g.stats();
    expect(after.built - before.built).toBe(1);
    expect(path(g, s, t).status).toBe('unreachable');
    // Dig it again: found, one chunk made again.
    w.fill([40, doorY, 20, 40, doorY + 3, 20], AIR);
    w.derive(1, 0, 0);
    g.touch(1, 0, 0);
    // Its neighbours derived again with nothing changed for them stand (the streamer sends them too).
    w.derive(0, 0, 0);
    g.touch(0, 0, 0);
    const mid = g.stats();
    g.update();
    expect(g.stats().built - mid.built).toBe(1);
    expect(g.stats().kept - mid.kept).toBe(1);
    expect(path(g, s, t).status).toBe('found');
  });

  it('frees any number of exit ids retired while queries waited (a streaming ring retires tens of thousands)', () => {
    const g = new WalkGraph(new TestWorld().view(), M);
    const held = g as unknown as { retiredIds: number[]; freeIds: number[] };
    for (let i = 0; i < 300_000; i++) held.retiredIds.push(i);
    expect(() => g.releaseIds()).not.toThrow();
    expect([held.retiredIds.length, held.freeIds.length]).toEqual([0, 300_000]);
  });

  it('spreads its work over slices on a stepping clock, never past a slice by more than one unit, to the same graph', () => {
    const w = scrap(61);
    const whole = loadAll(w, [0, -1, 0], [1, 1, 1]);
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 0.25));
    try {
      const g = new WalkGraph(w.view(), M);
      for (let cx = 0; cx <= 1; cx++) for (let cy = -1; cy <= 1; cy++) for (let cz = 0; cz <= 1; cz++) g.touch(cx, cy, cz);
      let calls = 0;
      while (g.pending) {
        const units = g.update(1);
        expect(units).toBeGreaterThan(0);
        // The clock steps 0.25 ms a reading: a 1 ms slice holds at most a few units (each unit reads it twice or so).
        expect(units).toBeLessThanOrEqual(4);
        calls++;
      }
      expect(calls).toBeGreaterThanOrEqual(6);
      clock.mockRestore();
      same(g, whole);
    } finally {
      clock.mockRestore();
    }
  });
});

/** The cell the brute force reaches farthest from `s` (by cost). */
function farthest(b: Brute, s: P3): P3 {
  let best: [string, number] = [s.join(','), 0];
  for (const e of b.dijkstra(s)) if (e[1] > best[1]) best = e;
  return best[0].split(',').map(Number) as unknown as P3;
}

describe('walk graph: queries', () => {
  it('serves a queue in order within its slices, a long query over several slices, resumed to the same path', () => {
    const w = scrap(71);
    const g = loadAll(w, [0, -1, 0], [1, 1, 1]);
    const b = new Brute(w, [0, -1, 0], [1, 1, 1]);
    const s = standAt(b, 30, 30)!;
    const t = farthest(b, s);
    const whole = path(g, s, t, { hierarchy: false });
    expect(whole.status).toBe('found');
    const q = new WalkQueries(g);
    const answers: Array<[number, WalkPathAnswer]> = [];
    for (let k = 0; k < 5; k++) q.path(s, t, { hierarchy: false }, (a) => answers.push([k, a]));
    let now = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 0.05));
    let slices = 0;
    try {
      while (q.queued > 0) {
        q.serve(0.1);
        slices++;
      }
    } finally {
      clock.mockRestore();
    }
    expect(answers.map(([k]) => k)).toEqual([0, 1, 2, 3, 4]);
    for (const [, a] of answers) {
      expect(a.cost).toBeCloseTo(whole.cost, 9);
      expect([...a.cells]).toEqual([...whole.cells]);
      expect(a.run.slices).toBeGreaterThan(1);
    }
    expect(slices).toBeGreaterThan(10);
  });

  it('ends a query past its maxNodes partial, with the path to where it got closest', () => {
    const w = scrap(81);
    const g = loadAll(w, [0, -1, 0], [1, 1, 1]);
    const b = new Brute(w, [0, -1, 0], [1, 1, 1]);
    const s = standAt(b, 30, 30)!;
    const t = farthest(b, s);
    const a = path(g, s, t, { hierarchy: false, maxNodes: 50 });
    expect(a.status).toBe('partial');
    expect(a.run.cells).toBeLessThanOrEqual(50);
    expect(cellsOf(a)[0]).toEqual(s);
    expect(cellsOf(a).length).toBeGreaterThan(1);
  });
});

describe('walk graph: shut doors', () => {
  it('a shut door is walked only by a query through shut doors; a flip makes again only the chunk its cells lie in, and opened the graph is as before', () => {
    const w = new TestWorld();
    ground(w, 2, 1);
    // A wall across the yard at x 40 (z 0 … 31, two chunks along x), its only way through a doorway of opening cells
    // (z 10 … 11, 4 cells high): the door.
    w.fill([40, 8, 0, 40, 15, 31], WALL);
    w.fill([40, 8, 10, 40, 11, 11], OPENING);
    for (let cx = 0; cx <= 1; cx++) w.derive(cx, 0, 0);
    const g = loadAll(w, [0, 0, 0], [1, 0, 0]);
    const from: P3 = [20, 8, 10];
    const to: P3 = [56, 8, 20];
    const open = path(g, from, to);
    expect(open.status).toBe('found');
    const before = [...g.parts()].map((c) => [c.key, c] as const);
    const built: string[] = [];
    g.onPart = (cx, cy, cz) => built.push(`${cx},${cy},${cz}`);
    const door: [number, number, number][] = [[40, 8, 10], [40, 8, 11]];
    g.setShut('door', door);
    g.update();
    // Only the chunk holding the door's cells was made again.
    expect(built).toEqual(['1,0,0']);
    const shut = path(g, from, to);
    expect(shut.status).toBe('unreachable');
    expect(path(g, from, to, { hierarchy: false }).status).toBe('unreachable');
    const through = path(g, from, to, { doors: 'shut-too' });
    expect(through.status).toBe('found');
    expect(through.cost).toBeCloseTo(open.cost, 6);
    // Its cells are in no piece while shut (the levels never cross it).
    const c = g.chunkAt(1, 0, 0)!;
    for (const [x, y, z] of door) {
      const k = c.colStart[(x - 32) * 32 + z]!;
      expect(c.ys[k]).toBe(y);
      expect(c.piece[k]).toBe(NO_WALK_PIECE);
    }
    g.setShut('door', null);
    g.update();
    expect(path(g, from, to).status).toBe('found');
    for (const [key, part] of before) {
      const now = [...g.parts()].find((p) => p.key === key)!;
      expect(sameWalkChunk(now, part)).toBe(true);
    }
  });
});
