/**
 * The light volume's layout: its words, the window's wrapped index, which cells hold light and which bricks are kept
 * against a cell-by-cell reference on generated chunks, the bricks an edit changes and marks (and a batch's walk
 * changes taken in one pass as block by block), and the surfaces' read
 * (the ambient cube, and that a reader beside a 0.5 m wall reads only the cells on its own side); the lamps a brick
 * lists against a brute-force reference over 240 lamps (overflow, a lamp moved), and the lamp table from the clustered
 * lights' record.
 */
import { describe, expect, it } from 'vitest';
import { CPU_SCALAR_OPS } from '@thirdlight/shared';
import { applyWalkWires, OCCUPANCY, packWalkBlock, WalkTable, type WalkBlockView, type WalkSource } from '@thirdlight/voxel';

import { ClusterLights } from './cluster-build';
import { volumeLampSet } from './voxel-light-volume-lamps';
import { ambientCubeSteps, VOLUME_BLOCK_BRICKS, VOLUME_BRICK_M, VOLUME_LAMP_FLOATS, VOLUME_LAMP_LIST_ENTRIES, volumeBrickLamps, volumeLampBrickBox, volumeLampListBrick, volumeLampStrength, volumeLampReaches, volumeLampFacesBrick, VOLUME_LAMP_NEGLIGIBLE, VOLUME_INDEX_ROW_BASE, VOLUME_INDEX_ROWS, VOLUME_INDEX_WIDTH, VOLUME_LEVEL_WINDOWS, VOLUME_LEVELS, VOLUME_MARK_NEAR_BRICKS, VOLUME_WINDOW_BRICKS, volumeBlockBrick, volumeBlockBricks, volumeBrickKept, volumeBrickKey, volumeCellHolds, volumeCellM, volumeChangedBricks, volumeCoarseSolid, volumeDecode, volumeEncode, volumeIndexTexel, volumeLevelBrickKept, volumeLevelCellHolds, volumeLevelIndexTexel, volumeMarkBoxes, volumeMarkedUpdates, volumeReadAt, volumeReadLevelCount, volumeReadLevels, volumeWeightShare, type VolumeBlockBricks } from './voxel-light-volume-layout';

/** A cached brick lookup over a walk source's level-0 blocks (as the volume keeps them). */
function brickLookup(tsrc: WalkSource): (bx: number, by: number, bz: number) => VolumeBlockBricks | null {
  const blocks = new Map<string, VolumeBlockBricks | null>();
  return (bx, by, bz) => {
    const k = `${bx},${by},${bz}`;
    if (!blocks.has(k)) {
      const v = tsrc.block(0, bx, by, bz, 'light');
      blocks.set(k, v === null ? null : volumeBlockBricks(v));
    }
    return blocks.get(k)!;
  };
}

/** A level-0 source of 32³ blocks over a cell predicate (light and solid alike), known in `[lo, hi)` blocks. */
function predicateSource(solid: (x: number, y: number, z: number) => boolean, lo: readonly number[], hi: readonly number[]): WalkSource {
  const cache = new Map<string, WalkBlockView>();
  return {
    maxLevel: 0,
    blockShift: () => 5,
    block: (_level, bx, by, bz) => {
      if (bx < lo[0]! || by < lo[1]! || bz < lo[2]! || bx >= hi[0]! || by >= hi[1]! || bz >= hi[2]!) return null;
      const key = `${bx},${by},${bz}`;
      const had = cache.get(key);
      if (had !== undefined) return had;
      const cells = new Uint8Array(32 ** 3);
      let n = 0;
      for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) for (let y = 0; y < 32; y++) {
        const s = solid(bx * 32 + x, by * 32 + y, bz * 32 + z);
        cells[(x * 32 + z) * 32 + y] = s ? 1 : 0;
        if (s) n++;
      }
      const bricks = new Uint8Array(512);
      for (let i = 0; i < 512; i++) {
        const [x0, y0, z0] = [Math.floor(i / 64), i % 8, Math.floor(i / 8) % 8];
        let k = 0;
        for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) k += cells[((x0 * 4 + x) * 32 + z0 * 4 + z) * 32 + y0 * 4 + y]!;
        bricks[i] = k === 0 ? OCCUPANCY.empty : OCCUPANCY.mixed;
      }
      const v: WalkBlockView = { flag: n === 0 ? OCCUPANCY.empty : n === 32 ** 3 ? OCCUPANCY.solid : OCCUPANCY.mixed, brick: (i) => bricks[i]!, cell: (i) => cells[i] === 1 };
      cache.set(key, v);
      return v;
    },
  };
}

/** The source's blocks packed into a walk table (what the page holds). */
function tableOf(src: WalkSource, lo: readonly number[], hi: readonly number[]): WalkTable {
  const t = new WalkTable();
  for (let bx = lo[0]!; bx < hi[0]!; bx++) for (let by = lo[1]!; by < hi[1]!; by++) for (let bz = lo[2]!; bz < hi[2]!; bz++) {
    const p = packWalkBlock(src, 0, bx, by, bz);
    if (p !== null) t.set(0, bx, by, bz, p);
  }
  return t;
}

/** A town-like scrap: rolling ground, two houses with 0.5 m walls (a door, a window), a dug tunnel, across negative cells. */
function townCell(x: number, y: number, z: number): boolean {
  const ground = Math.floor(2 + 2 * Math.sin(x * 0.11) + Math.cos(z * 0.07) * 2);
  if (y <= ground && !(y > ground - 6 && y < ground - 1 && Math.abs(z - 10) < 3 && x > -20 && x < 20)) return true;
  for (const [hx, hz] of [[-24, -18], [14, 20]] as const) {
    const inX = x >= hx && x < hx + 16;
    const inZ = z >= hz && z < hz + 12;
    const floorY = 7;
    if (!inX || !inZ || y < floorY || y > floorY + 8) continue;
    const wall = x === hx || x === hx + 15 || z === hz || z === hz + 11 || y === floorY || y === floorY + 8;
    const door = z === hz && x >= hx + 6 && x < hx + 8 && y < floorY + 5;
    const window = x === hx + 15 && z >= hz + 4 && z < hz + 6 && y >= floorY + 3 && y < floorY + 5;
    if (wall && !door && !window) return true;
  }
  return false;
}

const LO = [-2, -1, -2];
const HI = [2, 1, 2];

describe('the light volume layout', () => {
  it('words: RGB9E5 within its precision, the word 0 only for none held', () => {
    let worst = 0;
    let s = 7;
    const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    for (let i = 0; i < 4000; i++) {
      const top = 10 ** (rnd() * 8 - 4);
      const c = [rnd() * top, rnd() * top, rnd() * top] as const;
      const w = volumeEncode(c[0], c[1], c[2]);
      expect(w).not.toBe(0);
      const d = volumeDecode(w);
      const m = Math.max(...c);
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(d[k]! - c[k]!) / m);
    }
    // Nine bits of mantissa under the largest channel: within 1/256 of it.
    expect(worst).toBeLessThan(1 / 256);
    expect(volumeEncode(0, 0, 0)).not.toBe(0);
    expect(volumeDecode(volumeEncode(0, 0, 0))).toEqual([0, 0, 0]);
    expect(volumeDecode(0)).toEqual([0, 0, 0]);
  });

  it('the window index: a brick and its neighbours in distinct places, wrapped across negative bricks', () => {
    const [W, H, D] = VOLUME_WINDOW_BRICKS;
    for (const o of [[0, 0, 0], [-37, -5, 1201], [-4096, 900, -3]]) {
      const seen = new Set<string>();
      for (let x = 0; x < W; x += 3) for (let y = 0; y < H; y += 2) for (let z = 0; z < D; z += 3) {
        const t = volumeIndexTexel(o[0]! + x, o[1]! + y, o[2]! + z);
        expect(t[0]).toBeGreaterThanOrEqual(0);
        expect(t[0]).toBeLessThan(W * D);
        expect(t[1]).toBeGreaterThanOrEqual(0);
        expect(t[1]).toBeLessThan(H);
        seen.add(t.join(','));
      }
      expect(seen.size).toBe(Math.ceil(W / 3) * Math.ceil(H / 2) * Math.ceil(D / 3));
    }
    // A window moved by one brick keeps every place but the column that left.
    expect(volumeIndexTexel(5, 1, 7)).toEqual(volumeIndexTexel(5 + W, 1 + H, 7 + D));
  });

  it('which cells hold light, against a cell-by-cell reference; every one in a kept brick', () => {
    const src = predicateSource(townCell, LO, HI);
    const table = tableOf(src, LO, HI);
    const tsrc = table.source();
    const blocks = new Map<string, VolumeBlockBricks | null>();
    const lookup = (bx: number, by: number, bz: number): VolumeBlockBricks | null => {
      const k = `${bx},${by},${bz}`;
      if (!blocks.has(k)) {
        const v = tsrc.block(0, bx, by, bz, 'light');
        blocks.set(k, v === null ? null : volumeBlockBricks(v));
      }
      return blocks.get(k)!;
    };
    let holds = 0;
    let kept = 0;
    const keptBricks = new Set<string>();
    for (let x = -60; x < 60; x++) for (let y = -8; y < 24; y++) for (let z = -60; z < 60; z++) {
      // The reference: open by the predicate, with a solid one across a face (unknown space is open).
      const known = (cx: number, cy: number, cz: number): boolean => cx >= LO[0]! * 32 && cy >= LO[1]! * 32 && cz >= LO[2]! * 32 && cx < HI[0]! * 32 && cy < HI[1]! * 32 && cz < HI[2]! * 32;
      const solid = (cx: number, cy: number, cz: number): boolean => known(cx, cy, cz) && townCell(cx, cy, cz);
      const ref = !solid(x, y, z) && [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => solid(x + dx!, y + dy!, z + dz!));
      expect(volumeCellHolds(tsrc, x, y, z), `cell ${x},${y},${z}`).toBe(ref);
      if (!ref) continue;
      holds++;
      const b = [x >> 2, y >> 2, z >> 2];
      if (!keptBricks.has(b.join(','))) {
        expect(volumeBrickKept(lookup, b[0]!, b[1]!, b[2]!), `brick ${b.join(',')} of cell ${x},${y},${z}`).toBe(true);
        keptBricks.add(b.join(','));
      }
    }
    // Kept bricks over the same box (some keep no cell: the rule is by bricks).
    for (let bx = -15; bx < 15; bx++) for (let by = -2; by < 6; by++) for (let bz = -15; bz < 15; bz++) if (volumeBrickKept(lookup, bx, by, bz)) kept++;
    expect(holds).toBeGreaterThan(10_000);
    expect(keptBricks.size).toBeLessThanOrEqual(kept);
    // Bricks kept that hold no light cell (by the update's rule) are a minority of those kept.
    expect(kept - keptBricks.size).toBeLessThan(0.5 * kept);
    console.log(`[light volume] ${holds} cells hold light in ${keptBricks.size} bricks; ${kept} kept (${((holds * 24) / 1024).toFixed(0)} KiB at 24 B a cell; ${((kept * 64 * 24) / 1024).toFixed(0)} KiB as kept bricks)`);
  });

  it('an edit box: the changed bricks are those whose cells changed, and the marks reach no farther than the rays', () => {
    const lo = [0, 0, 0];
    const hi = [1, 1, 1];
    const before = predicateSource(townCell, lo, hi);
    const box = { x0: 9, x1: 14, y0: 1, y1: 5, z0: 17, z1: 18 };
    const inBox = (x: number, y: number, z: number): boolean => x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1 && z >= box.z0 && z <= box.z1;
    const after = predicateSource((x, y, z) => (inBox(x, y, z) ? !townCell(x, y, z) : townCell(x, y, z)), lo, hi);
    const changed = volumeChangedBricks(before.block(0, 0, 0, 0, 'light'), after.block(0, 0, 0, 0, 'light')).map((bi) => volumeBlockBrick(bi).join(','));
    const want = new Set<string>();
    for (let x = box.x0; x <= box.x1; x++) for (let y = box.y0; y <= box.y1; y++) for (let z = box.z0; z <= box.z1; z++) want.add([x >> 2, y >> 2, z >> 2].join(','));
    expect(new Set(changed)).toEqual(want);
    expect(volumeChangedBricks(before.block(0, 0, 0, 0, 'light'), before.block(0, 0, 0, 0, 'light'))).toEqual([]);
    // Every brick of a block arriving where none was known, that holds a solid cell, is changed.
    const arrived = volumeChangedBricks(null, before.block(0, 0, 0, 0, 'light'));
    expect(arrived.length).toBeGreaterThan(0);
    // Marks: the reach (in bricks) of 12 round the box's bricks 2 … 3: those past it untouched, those near from nothing.
    const b0 = [2, 0, 4];
    const b1 = [3, 1, 4];
    let marked = 0;
    let fresh = 0;
    for (let x = -20; x < 26; x++) for (let y = -14; y < 16; y++) for (let z = -14; z < 22; z++) {
      const u = volumeMarkedUpdates([x, y, z], b0, b1, 8, 12, 8);
      const gap = Math.max(Math.max(b0[0]! - x, 0, x - b1[0]!), Math.max(b0[1]! - y, 0, y - b1[1]!), Math.max(b0[2]! - z, 0, z - b1[2]!));
      if (gap > 12) expect(u).toBeNull();
      else expect(u).toBe(gap <= VOLUME_MARK_NEAR_BRICKS ? 0 : 4);
      if (u !== null) marked++;
      if (u === 0) fresh++;
    }
    expect(marked).toBe((2 + 24) * (2 + 24) * (1 + 24));
    expect(fresh).toBe((2 + 4) * (2 + 4) * (1 + 4));
    expect(VOLUME_BLOCK_BRICKS).toBe(8);
  });

  it("a batch's walk changes in one pass: the blocks' copies, their changed bricks and the marks as block by block", () => {
    const lo = [-2, -1, -2];
    const hi = [2, 1, 2];
    const t = tableOf(predicateSource(townCell, lo, hi), lo, hi);
    const keys: Array<[number, number, number]> = [];
    for (let bx = lo[0]!; bx < hi[0]!; bx++) for (let by = lo[1]!; by < hi[1]!; by++) for (let bz = lo[2]!; bz < hi[2]!; bz++) keys.push([bx, by, bz]);
    const stops = (v: WalkBlockView | null, i: number): boolean => v !== null && (v.flag === OCCUPANCY.solid || (v.flag === OCCUPANCY.mixed && v.cell(i)));
    // The copies, then the batch: half the blocks taken out (a flight's start), the rest dug through by a tunnel.
    const before = keys.map(([bx, by, bz]) => t.viewCopy(0, bx, by, bz, 'light'));
    const live = keys.map(([bx, by, bz]) => t.view(0, bx, by, bz, 'light'));
    const dug = (x: number, y: number, z: number): boolean => townCell(x, y, z) && !(Math.abs(y - 2) < 3 && Math.abs(z + 5) < 3);
    const after = predicateSource(dug, lo, hi);
    const gone = (k: number): boolean => k % 2 === 0;
    applyWalkWires(t, keys.map(([bx, by, bz], k) => (gone(k) ? { level: 0, bx, by, bz } : { level: 0, bx, by, bz, packed: packWalkBlock(after, 0, bx, by, bz)! })));
    let mixed = 0;
    let differ = 0;
    let moved = 0;
    keys.forEach(([bx, by, bz], k) => {
      const src = predicateSource(townCell, lo, hi).block(0, bx, by, bz, 'light');
      const b = before[k]!;
      expect(b.flag).toBe(src!.flag);
      if (b.flag === OCCUPANCY.mixed) mixed++;
      // The copy is what the block was; the table's own view now reads what the batch wrote.
      for (let i = 0; i < 32 ** 3; i++) if (stops(b, i) !== stops(src, i)) differ++;
      const now = t.view(0, bx, by, bz, 'light');
      if (gone(k)) expect(now).toBeNull();
      else for (let i = 0; i < 32 ** 3; i++) if (stops(live[k]!, i) !== stops(src, i)) moved++;
    });
    expect(mixed).toBeGreaterThan(4);
    expect(differ).toBe(0);
    // A view taken before the batch without a copy reads the pages the batch wrote (why the copy is taken).
    expect(moved).toBeGreaterThan(0);
    // The changed bricks against a cell-by-cell reference, and the boxes they give.
    const boxes: Array<readonly [number[], number[]]> = [];
    let changedAll = 0;
    keys.forEach(([bx, by, bz], k) => {
      const a = t.view(0, bx, by, bz, 'light');
      const want: number[] = [];
      for (let bi = 0; bi < 512; bi++) {
        const [x0, y0, z0] = volumeBlockBrick(bi);
        let d = false;
        for (let x = 0; x < 4 && !d; x++) for (let z = 0; z < 4 && !d; z++) for (let y = 0; y < 4 && !d; y++) {
          const i = ((x0 * 4 + x) * 32 + z0 * 4 + z) * 32 + y0 * 4 + y;
          d = stops(before[k]!, i) !== stops(a, i);
        }
        if (d) want.push(bi);
      }
      const got = volumeChangedBricks(before[k]!, a);
      expect(got).toEqual(want);
      changedAll += got.length;
      if (got.length === 0) return;
      const l = [Infinity, Infinity, Infinity];
      const h = [-Infinity, -Infinity, -Infinity];
      for (const bi of got) {
        const g = volumeBlockBrick(bi).map((v, ax) => [bx, by, bz][ax]! * 8 + v);
        for (let ax = 0; ax < 3; ax++) {
          l[ax] = Math.min(l[ax]!, g[ax]!);
          h[ax] = Math.max(h[ax]!, g[ax]!);
        }
      }
      boxes.push([l, h]);
    });
    expect(changedAll).toBeGreaterThan(100);
    expect(boxes.length).toBeGreaterThan(8);
    // Kept bricks of every level round the blocks, some already part-way settled.
    const reach = [12, 6, 3, 2];
    const kept = (): Array<{ bx: number; by: number; bz: number; level: number; updates: number }> => {
      const out = [];
      for (let level = 0; level < 4; level++) {
        const n = 48 >> level;
        for (let x = -n; x < n; x += 1 + level) for (let y = -(n >> 2); y < n >> 2; y++) for (let z = -n; z < n; z += 2) out.push({ bx: x, by: y, bz: z, level, updates: (x * 7 + y * 3 + z) & 7 });
      }
      return out;
    };
    // Block by block, as each change was marked before: every box over every brick, the stale list in order.
    const ref = kept();
    const stale = new Set<(typeof ref)[number]>();
    for (const [l, h] of boxes) {
      for (const b of ref) {
        const s = 1 << b.level;
        const u = volumeMarkedUpdates([b.bx, b.by, b.bz], l.map((v) => Math.floor(v / s)), h.map((v) => Math.floor(v / s)), b.updates, reach[b.level]!, 8, b.level === 0 ? undefined : 1);
        if (u === null) continue;
        b.updates = u;
        stale.add(b);
      }
    }
    const one = kept();
    const marked = volumeMarkBoxes(one, boxes, reach, 8);
    expect(marked.length).toBe(stale.size);
    expect(marked.length).toBeGreaterThan(1000);
    expect(one.map((b) => b.updates)).toEqual(ref.map((b) => b.updates));
    const index = new Map(one.map((b, i) => [b, i]));
    const refIndex = new Map(ref.map((b, i) => [b, i]));
    expect(marked.map((b) => index.get(b))).toEqual([...stale].map((b) => refIndex.get(b)));
    expect(one.filter((b) => b.updates === 0).length).toBeGreaterThan(100);
  });

  it('the ambient cube: a face along each axis, squares of the normal between, against a reference', () => {
    const faces: [number, number, number, number, number, number] = [1, 2, 3, 4, 5, 6];
    const at = (n: readonly number[]): number => ambientCubeSteps(CPU_SCALAR_OPS, n[0]!, n[1]!, n[2]!, faces);
    expect(at([1, 0, 0])).toBe(1);
    expect(at([-1, 0, 0])).toBe(2);
    expect(at([0, 1, 0])).toBe(3);
    expect(at([0, -1, 0])).toBe(4);
    expect(at([0, 0, 1])).toBe(5);
    expect(at([0, 0, -1])).toBe(6);
    let s = 3;
    const rnd = (): number => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
    for (let i = 0; i < 500; i++) {
      const v = [rnd(), rnd(), rnd()];
      const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
      const n = v.map((c) => c / l);
      const ref = n[0]! ** 2 * (n[0]! >= 0 ? 1 : 2) + n[1]! ** 2 * (n[1]! >= 0 ? 3 : 4) + n[2]! ** 2 * (n[2]! >= 0 ? 5 : 6);
      expect(at(n)).toBeCloseTo(ref, 12);
    }
  });

  it('the read: a floor reads the cell over it, and a wall 0.5 m thick keeps each side to its own cells', () => {
    const cellM = 0.5;
    // A wall one cell thick at x = 10 (cells), from y 0 up; ground below y 0. Room side lit 1, street side 100.
    const solid = (x: number, y: number): boolean => x === 10 || y < 0;
    const faces = (x: number, y: number, _z: number): number[][] | null => {
      if (solid(x, y) || !(solid(x + 1, y) || solid(x - 1, y) || solid(x, y - 1))) return null;
      const v = x < 10 ? 1 : 100;
      return Array.from({ length: 6 }, () => [v, v, v]);
    };
    for (let k = 0; k < 200; k++) {
      // Points on the room side of the wall (its face at x = 5 m), at every height and across.
      const p = [10 * cellM, 0.01 + (k % 20) * 0.37, (k * 0.173) % 3];
      const r = volumeReadAt(p, [-1, 0, 0], cellM, faces, CPU_SCALAR_OPS);
      expect(r.weight).toBeGreaterThan(0);
      expect(r.light[0]).toBeCloseTo(1, 9);
      const q = [11 * cellM, p[1]!, p[2]!];
      const o = volumeReadAt(q, [1, 0, 0], cellM, faces, CPU_SCALAR_OPS);
      expect(o.light[0]).toBeCloseTo(100, 9);
    }
    // A floor point reads the open cells over the ground with all its weight.
    const f = volumeReadAt([2.1, 0, 1.3], [0, 1, 0], cellM, (x, y) => (y === 0 && x < 10 ? [[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4], [5, 5, 5], [6, 6, 6]] : null), CPU_SCALAR_OPS);
    expect(f.weight).toBeCloseTo(1, 6);
    expect(f.light).toEqual([3, 3, 3]);
    // Past every cell holding light, no weight: the reader keeps its flat term.
    expect(volumeReadAt([40, 40, 40], [0, 1, 0], cellM, () => null, CPU_SCALAR_OPS).weight).toBe(0);
  });
});

/** Ground below y 0 (cells), and a closed room: 0.5 m walls round an inside of 16 × 6 × 16 cells (8 × 3 × 8 m) from cell (0, 0, 0). */
function roomCell(x: number, y: number, z: number): boolean {
  if (y < 0) return true;
  const inX = x >= -1 && x <= 16;
  const inZ = z >= -1 && z <= 16;
  if (!inX || !inZ || y > 6) return false;
  return x === -1 || x === 16 || z === -1 || z === 16 || y === 6;
}

describe("the surfaces' read levels by the page's flag", () => {
  it('reads every level unless the flag asks for level 0 alone', () => {
    expect(volumeReadLevelCount(null)).toBe(VOLUME_LEVELS);
    expect(volumeReadLevelCount('1')).toBe(VOLUME_LEVELS);
    expect(volumeReadLevelCount('0')).toBe(VOLUME_LEVELS);
    expect(volumeReadLevelCount('level0')).toBe(1);
  });
});

describe('the light volume coarse levels', () => {
  it('addressing: each level its own rows of the index, a brick and its neighbours apart, keys apart across levels', () => {
    expect(VOLUME_INDEX_ROW_BASE).toEqual([0, 24, 30, 36]);
    expect(VOLUME_INDEX_ROWS).toBe(42);
    expect(VOLUME_LEVEL_WINDOWS.map((d, l) => d.map((n) => n * 4 * volumeCellM(l)))).toEqual([[96, 48, 96], [48, 24, 48], [96, 48, 96], [192, 96, 192]]);
    const seen = new Set<string>();
    for (let level = 0; level < VOLUME_LEVELS; level++) {
      const [W, H, D] = VOLUME_LEVEL_WINDOWS[level]!;
      for (const o of [[0, 0, 0], [-37, -5, 1201]]) {
        const here = new Set<string>();
        for (let x = 0; x < W; x++) for (let y = 0; y < H; y++) for (let z = 0; z < D; z++) {
          if (level === 0 && (x % 3 !== 0 || z % 3 !== 0)) continue;
          const t = volumeLevelIndexTexel(level, o[0]! + x, o[1]! + y, o[2]! + z);
          expect(t[0]).toBeGreaterThanOrEqual(0);
          expect(t[0]).toBeLessThan(level === 0 ? VOLUME_INDEX_WIDTH : W * D);
          expect(t[1]).toBeGreaterThanOrEqual(VOLUME_INDEX_ROW_BASE[level]!);
          expect(t[1]).toBeLessThan(VOLUME_INDEX_ROW_BASE[level]! + H);
          here.add(t.join(','));
          if (o[0] === 0) seen.add(`${level}:${t.join(',')}`);
        }
        expect(here.size, `level ${level}: distinct places in its window`).toBe(level === 0 ? Math.ceil(W / 3) * H * Math.ceil(D / 3) : W * H * D);
      }
      // The level-0 rows are the update's own index (the same texel as before the coarse levels).
      if (level === 0) expect(volumeLevelIndexTexel(0, 5, 1, 7)).toEqual(volumeIndexTexel(5, 1, 7));
    }
    // No two levels share a texel.
    const texels = [...seen].map((k) => k.split(':')[1]);
    expect(new Set(texels).size).toBe(texels.length);
    expect(new Set([0, 1, 2, 3].map((l) => volumeBrickKey(-3, 2, 9, l))).size).toBe(4);
  });

  it('which coarse cells stop light (some level-0 cell in them does) and which coarse bricks are kept, against a cell-by-cell reference', () => {
    const src = predicateSource(townCell, LO, HI);
    const tsrc = tableOf(src, LO, HI).source();
    const lookup = brickLookup(tsrc);
    const known = (cx: number, cy: number, cz: number): boolean => cx >= LO[0]! * 32 && cy >= LO[1]! * 32 && cz >= LO[2]! * 32 && cx < HI[0]! * 32 && cy < HI[1]! * 32 && cz < HI[2]! * 32;
    for (let level = 1; level < VOLUME_LEVELS; level++) {
      const n = 1 << level;
      const solidRef = (x: number, y: number, z: number): boolean => {
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
          const c = [x * n + i, y * n + j, z * n + k];
          if (known(c[0]!, c[1]!, c[2]!) && townCell(c[0]!, c[1]!, c[2]!)) return true;
        }
        return false;
      };
      const span = 64 / n;
      let solid = 0;
      let open = 0;
      for (let x = -span; x < span; x++) for (let y = -16 / n; y < 24 / n; y++) for (let z = -span; z < span; z++) {
        const ref = solidRef(x, y, z);
        expect(volumeCoarseSolid(tsrc, level, x, y, z), `level ${level} cell ${x},${y},${z}`).toBe(ref);
        expect(volumeLevelCellHolds(tsrc, level, x, y, z)).toBe(!ref);
        if (ref) solid++;
        else open++;
      }
      expect(solid).toBeGreaterThan(50);
      expect(open).toBeGreaterThan(50);
      // Kept bricks: always one with an open cell and a solid one in it or a brick across a face; never one with no solid
      // cell near. One with no open cell is kept unless all its level-0 bricks are solid through (the rule reads the
      // bricks' bits, not the cells'): a few, counted.
      const brickCells = (bx: number, by: number, bz: number): { open: number; solid: number } => {
        let o = 0;
        let sd = 0;
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) if (solidRef(bx * 4 + i, by * 4 + j, bz * 4 + k)) sd++;
        else o++;
        return { open: o, solid: sd };
      };
      const bspan = Math.ceil(span / 4);
      let kept = 0;
      let closed = 0;
      for (let bx = -bspan; bx < bspan; bx++) for (let by = -1; by < 2; by++) for (let bz = -bspan; bz < bspan; bz++) {
        const c = brickCells(bx, by, bz);
        const k = volumeLevelBrickKept(lookup, level, bx, by, bz);
        if (c.open === 0 && k) closed++;
        const near = c.solid > 0 || [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => brickCells(bx + dx!, by + dy!, bz + dz!).solid > 0);
        if (c.open > 0 && near) expect(k, `level ${level} brick ${bx},${by},${bz}`).toBe(true);
        if (!near) expect(k).toBe(false);
        if (k) kept++;
      }
      expect(kept).toBeGreaterThan(0);
      expect(closed, `level ${level}: kept bricks with no open cell`).toBeLessThan(0.25 * kept);
      console.log(`[light volume] level ${level} (${volumeCellM(level)} m): ${solid} cells stop light, ${open} open; ${kept} bricks kept, ${closed} of them with no open cell`);
    }
  });

  it('which level a point reads: level 0 beside a surface, a coarse level 1.7 m over open ground and in a room\'s middle, the flat term nowhere', () => {
    const src = predicateSource(roomCell, [-2, -1, -2], [2, 1, 2]);
    const tsrc = tableOf(src, [-2, -1, -2], [2, 1, 2]).source();
    // Each held cell's faces as its level + 1 inside the room and 10 × that outside: the read shows which level and side it took.
    const inside = (level: number, x: number, y: number, z: number): boolean => {
      const n = 1 << level;
      return x * n >= 0 && (x + 1) * n <= 16 && y * n >= 0 && (y + 1) * n <= 6 && z * n >= 0 && (z + 1) * n <= 16;
    };
    const faces = (level: number, x: number, y: number, z: number): number[][] | null => {
      if (!volumeLevelCellHolds(tsrc, level, x, y, z)) return null;
      const v = (level + 1) * (inside(level, x, y, z) ? 1 : 10);
      return Array.from({ length: 6 }, () => [v, v, v]);
    };
    const read = (p: number[], n: number[]): ReturnType<typeof volumeReadLevels> => volumeReadLevels(p, n, faces, CPU_SCALAR_OPS);
    // Beside the room's floor, its wall and on the street's ground: the 0.5 m cells alone.
    for (const [p, n, v] of [[[3.1, 0, 4.2], [0, 1, 0], 1], [[0, 1.3, 2.7], [1, 0, 0], 1], [[-6.3, 0, 2.2], [0, 1, 0], 10]] as const) {
      const r = read([...p], [...n]);
      expect(r.shares[0], `beside a surface at ${p.join(',')}`).toBeCloseTo(1, 9);
      expect(r.shares.slice(1)).toEqual([0, 0, 0]);
      expect(r.light[0]).toBeCloseTo(v, 9);
    }
    // 1.7 m over the open ground outside: no 0.5 m cell holds light there, the 1 m level does (the street's light).
    for (const n of [[1, 0, 0], [0, 1, 0], [0, 0, -1], [-0.6, 0.8, 0]]) {
      const r = read([-6.2, 1.7, 3.3], n);
      expect(r.shares[0]).toBe(0);
      expect(r.shares[1], 'a character\'s head over a field reads the 1 m level').toBeGreaterThan(0.5);
      expect(r.weight).toBeGreaterThan(0.99);
      expect(r.light[0]).toBeCloseTo(20, 9);
    }
    // The middle of the room, 1.5 m up: the 1 m cells inside the room, none of the street's across its 0.5 m walls.
    for (const n of [[1, 0, 0], [0, -1, 0], [0, 0, 1]]) {
      const r = read([4.1, 1.5, 3.9], n);
      expect(r.shares[0]).toBe(0);
      expect(r.shares[1]).toBeGreaterThan(0.5);
      expect(r.light[0], 'no light from across the walls').toBeCloseTo(2, 9);
    }
    // A point whose 1 m cells are out of their window (none held there): the 2 m level takes it.
    const far = volumeReadLevels([-6.2, 1.7, 3.3], [0, 1, 0], (l, x, y, z) => (l === 1 ? null : faces(l, x, y, z)), CPU_SCALAR_OPS);
    expect(far.shares[1]).toBe(0);
    expect(far.shares[2]).toBeGreaterThan(0.5);
    // No level holds light: weight 0, the flat term stays.
    expect(volumeReadLevels([40, 40, 40], [0, 1, 0], () => null, CPU_SCALAR_OPS).weight).toBe(0);
    // The shares: each a level's weight's smooth step of what the finer ones left (against the steps written out).
    const r = read([0.2, 0.3, 0.6], [0.3, 0.9, -0.3]);
    let left = 1;
    for (let level = 0; level < VOLUME_LEVELS; level++) {
      const w = volumeReadAt([0.2, 0.3, 0.6], [0.3, 0.9, -0.3], volumeCellM(level), (x, y, z) => faces(level, x, y, z), CPU_SCALAR_OPS).weight;
      const want = left > 1e-3 ? left * volumeWeightShare(w) : 0;
      expect(r.shares[level]).toBeCloseTo(want, 12);
      left -= want;
    }
    expect(r.weight).toBeCloseTo(1 - left, 12);
  });
});

describe('the light volume lamp lists', () => {
  /** 240 lamps over a 48 × 12 × 48 m scrap across negative bricks: reaches 0.5–20 m (mixed), colours and decays apart. */
  function scrap(): Float32Array {
    const n = 240;
    const t = new Float32Array(n * VOLUME_LAMP_FLOATS);
    for (let i = 0; i < n; i++) {
      const o = i * VOLUME_LAMP_FLOATS;
      const f = (k: number): number => (0.5 + i * k) % 1;
      t.set([-24 + 48 * f(0.7548776662), -2 + 12 * f(0.5698402910), -24 + 48 * f(0.4301597090), i % 7 === 0 ? 0.5 + f(0.31) : i % 5 === 0 ? 12 + 8 * f(0.21) : 2 + 8 * f(0.13)], o);
      t.set([1 + 9 * f(0.17), 2 * f(0.23), 3 * f(0.29), i % 3 === 0 ? 1 : 2], o + 4);
      // Every fourth a spot shining down in a 40° cone (its axis and kind field; the cone's cos in word 15).
      t.set([0, -1, 0, i % 4 === 0 ? 1 : 0], o + 8);
      t[o + 15] = Math.cos((40 * Math.PI) / 180);
    }
    return t;
  }
  /** Brute force: a lamp reaches a brick where the box's nearest point to it (clamped) is nearer than its reach. */
  const reaches = (t: Float32Array, i: number, b: readonly number[]): boolean => {
    const o = i * VOLUME_LAMP_FLOATS;
    let d2 = 0;
    for (let a = 0; a < 3; a++) {
      const lo = b[a]! * VOLUME_BRICK_M;
      const q = Math.min(Math.max(t[o + a]!, lo), lo + VOLUME_BRICK_M);
      d2 += (t[o + a]! - q) ** 2;
    }
    return Math.sqrt(d2) < t[o + 3]!;
  };
  /**
   * Brute force: whether lamp i lights some point of the brick (a 5 × 5 × 5 grid of its points, corners and faces
   * included): within its reach, a spot's within its cone, a one-sided area light's in front of its plane.
   */
  const lights = (t: Float32Array, i: number, b: readonly number[], level = 0): boolean => {
    const o = i * VOLUME_LAMP_FLOATS;
    const m = VOLUME_BRICK_M * 2 ** level;
    const kind = t[o + 11]! & 3;
    for (let x = 0; x <= 4; x++) for (let y = 0; y <= 4; y++) for (let z = 0; z <= 4; z++) {
      const v = [b[0]! * m + (x * m) / 4 - t[o]!, b[1]! * m + (y * m) / 4 - t[o + 1]!, b[2]! * m + (z * m) / 4 - t[o + 2]!];
      const d = Math.hypot(v[0]!, v[1]!, v[2]!);
      if (!(d < t[o + 3]!)) continue;
      const along = v[0]! * t[o + 8]! + v[1]! * t[o + 9]! + v[2]! * t[o + 10]!;
      if (kind === 1 && d > 1e-6 && along / d <= t[o + 15]!) continue;
      if (kind >= 2 && (t[o + 11]! & 4) === 0 && along <= 0) continue;
      return true;
    }
    return false;
  };
  /** The lamps the rule ranks for a brick (reach and facing), strongest first (equal: lower index), with their strengths. */
  const ranked = (t: Float32Array, n: number, b: readonly number[], level = 0): Array<[number, number]> => {
    const r: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) if (volumeLampReaches(t, i, b[0]!, b[1]!, b[2]!, level) && volumeLampFacesBrick(t, i, b[0]!, b[1]!, b[2]!, level)) r.push([i, volumeLampStrength(t, i, b[0]!, b[1]!, b[2]!, level)]);
    return r.sort((p, q) => q[1] - p[1] || p[0] - q[0]);
  };
  const BRICKS: number[][] = [];
  for (let x = -14; x < 14; x++) for (let y = -2; y < 6; y++) for (let z = -14; z < 14; z++) BRICKS.push([x, y, z]);

  it('a lamp is ranked by a brick only where it can light it: its reach meets the box, a spot\'s cone and a one-sided area light\'s front too (brute force over the box\'s points)', () => {
    const t = scrap();
    const n = t.length / VOLUME_LAMP_FLOATS;
    let culled = 0;
    let lit = 0;
    for (const b of BRICKS) for (let i = 0; i < n; i++) {
      const ranks = volumeLampReaches(t, i, b[0]!, b[1]!, b[2]!) && volumeLampFacesBrick(t, i, b[0]!, b[1]!, b[2]!);
      // Never a lamp that lights some point of the box left out (the rule is conservative: a bounding sphere's cone).
      if (lights(t, i, b)) {
        lit++;
        expect(ranks, `lamp ${i} lights brick ${b.join(',')}`).toBe(true);
      }
      if (reaches(t, i, b) && !ranks) culled++;
    }
    // The spots' cones leave out bricks their reach meets above and beside them.
    expect(lit).toBeGreaterThan(1000);
    expect(culled).toBeGreaterThan(200);
  });

  it('a brick lists its strongest lamps by index, leaving out only what is negligible or past the entries; the rest counted (brute force)', () => {
    const t = scrap();
    const n = t.length / VOLUME_LAMP_FLOATS;
    let over = 0;
    let dropped = 0;
    let negligible = 0;
    let most = 0;
    let lit = 0;
    for (const b of BRICKS) {
      const want = ranked(t, n, b);
      const sum = want.reduce((x, w) => x + w[1], 0);
      // With no limit and nothing negligible: every lamp that can light it.
      const all = volumeBrickLamps(t, n, b[0]!, b[1]!, b[2]!, Infinity, 0, 0);
      expect(all.listed, `brick ${b.join(',')}`).toEqual(want.map((w) => w[0]).sort((p, q) => p - q));
      expect(all.total).toBe(want.length);
      const r = volumeBrickLamps(t, n, b[0]!, b[1]!, b[2]!);
      expect(r.total).toBe(want.length);
      most = Math.max(most, r.total);
      if (want.length > 0) lit++;
      // By index, the strongest: each listed at least as strong as every lamp left out.
      expect([...r.listed].sort((a, c) => a - c)).toEqual(r.listed);
      expect(r.listed).toEqual(want.slice(0, r.listed.length).map((w) => w[0]).sort((p, q) => p - q));
      const left = want.slice(r.listed.length).reduce((x, w) => x + w[1], 0);
      if (r.listed.length < VOLUME_LAMP_LIST_ENTRIES) {
        // A list not full left out only what is negligible, and listed no more than it needed.
        expect(left).toBeLessThanOrEqual(VOLUME_LAMP_NEGLIGIBLE * sum * (1 + 1e-9));
        if (r.listed.length > 0) expect(left + want[r.listed.length - 1]![1]).toBeGreaterThan(VOLUME_LAMP_NEGLIGIBLE * sum);
        negligible += want.length - r.listed.length;
      } else if (want.length > r.listed.length) {
        over++;
        dropped += want.length - r.listed.length;
      }
    }
    // The scrap reaches its bricks unevenly: some bricks over the list, most within it; the negligible rule leaves lamps out.
    expect(lit).toBeGreaterThan(BRICKS.length / 2);
    expect(over).toBeGreaterThan(5);
    expect(dropped).toBeGreaterThan(over);
    expect(negligible).toBeGreaterThan(100);
    expect(most).toBeGreaterThan(VOLUME_LAMP_LIST_ENTRIES);
    // A brick of the scrap reached by no lamp lists none.
    expect(volumeBrickLamps(t, n, 400, 0, 0)).toEqual({ listed: [], total: 0 });
  });

  it('equal strengths keep the lower index; the strength falls with distance and grows with the light', () => {
    const t = new Float32Array(20 * VOLUME_LAMP_FLOATS);
    // Twenty identical lamps at one place over brick (0, 0, 0): the first entries by index are kept.
    for (let i = 0; i < 20; i++) t.set([1, 1, 1, 6, 1, 1, 1, 2], i * VOLUME_LAMP_FLOATS);
    expect(volumeBrickLamps(t, 20, 0, 0, 0)).toEqual({ listed: [...Array(VOLUME_LAMP_LIST_ENTRIES).keys()], total: 20 });
    // Lamp 19 brighter: it takes the place of the last of the equals.
    t[19 * VOLUME_LAMP_FLOATS + 4] = 5;
    expect(volumeBrickLamps(t, 20, 0, 0, 0).listed).toEqual([...[...Array(VOLUME_LAMP_LIST_ENTRIES - 1).keys()], 19]);
    t.set([5, 1, 1], 0);
    expect(volumeLampStrength(t, 0, 0, 0, 0)).toBeLessThan(volumeLampStrength(t, 1, 0, 0, 0));
    expect(volumeLampStrength(t, 19, 0, 0, 0)).toBeGreaterThan(volumeLampStrength(t, 1, 0, 0, 0));
  });

  it('a lamp moved changes the lists of bricks its old or new reach meets and no other; those only one meets change', () => {
    const t = scrap();
    const n = t.length / VOLUME_LAMP_FLOATS;
    const before = BRICKS.map((b) => volumeBrickLamps(t, n, b[0]!, b[1]!, b[2]!));
    const beforeAll = BRICKS.map((b) => volumeBrickLamps(t, n, b[0]!, b[1]!, b[2]!, Infinity, 0, 0));
    const moved = 37;
    const old = t.slice(moved * VOLUME_LAMP_FLOATS, moved * VOLUME_LAMP_FLOATS + VOLUME_LAMP_FLOATS);
    const meetsOld = BRICKS.map((b) => reaches(t, moved, b) && volumeLampFacesBrick(t, moved, b[0]!, b[1]!, b[2]!));
    t[moved * VOLUME_LAMP_FLOATS] = old[0]! + 7.3;
    t[moved * VOLUME_LAMP_FLOATS + 2] = old[2]! - 3.1;
    const meetsNew = BRICKS.map((b) => reaches(t, moved, b) && volumeLampFacesBrick(t, moved, b[0]!, b[1]!, b[2]!));
    // The box a lamp's bricks are looked for in holds every brick it meets.
    const [lo, hi] = volumeLampBrickBox(t, moved);
    BRICKS.forEach((b, k) => {
      if (meetsNew[k]) for (let a = 0; a < 3; a++) expect(b[a]! >= lo[a]! && b[a]! <= hi[a]!).toBe(true);
    });
    let changed = 0;
    let onlyOne = 0;
    BRICKS.forEach((b, k) => {
      const after = volumeBrickLamps(t, n, b[0]!, b[1]!, b[2]!);
      const afterAll = volumeBrickLamps(t, n, b[0]!, b[1]!, b[2]!, Infinity, 0, 0);
      const differs = JSON.stringify(after) !== JSON.stringify(before[k]);
      if (differs) changed++;
      if (!meetsOld[k] && !meetsNew[k]) expect(differs, `brick ${b.join(',')} met by neither`).toBe(false);
      if (!meetsNew[k] && !reaches(t, moved, b) && meetsOld[k] === meetsNew[k]) expect(afterAll.listed.includes(moved)).toBe(false);
      if (meetsOld[k] !== meetsNew[k]) {
        onlyOne++;
        // Its reach gained or lost the lamp: the count reaching it changes, and the full list by exactly that lamp.
        expect(after.total - before[k]!.total).toBe(meetsNew[k] ? 1 : -1);
        expect(afterAll.listed.includes(moved)).toBe(meetsNew[k]);
        expect(afterAll.listed.filter((i) => i !== moved)).toEqual(beforeAll[k]!.listed.filter((i) => i !== moved));
      }
    });
    expect(onlyOne).toBeGreaterThan(10);
    expect(changed).toBeGreaterThanOrEqual(onlyOne);
  });

  it('a hit past the level-0 window is lit by the finest coarse brick holding it with a list, which lists the lamps reaching it', () => {
    // The eye at the origin: level 0 spans ±48 m across, level 1 ±24 m, level 2 ±48 m, level 3 ±96 m (corner bricks).
    const origins = VOLUME_LEVEL_WINDOWS.map((d) => d.map((n) => -(n >> 1)));
    const kept = new Set<string>();
    const listed = (level: number, bx: number, by: number, bz: number): boolean => kept.has(`${level},${bx},${by},${bz}`);
    const cellOf = (p: readonly number[]): number[] => p.map((v) => Math.floor(v / 0.5));
    // A lamp 60 m out, past the level-0, 1 and 2 windows (±48, ±24, ±48 m), inside level 3's (±96 m); another 10 m out.
    const t = new Float32Array(2 * VOLUME_LAMP_FLOATS);
    t.set([60, 2, 3, 14, 1, 0.8, 0.5, 2], 0);
    t.set([10, 2, 3, 6, 1, 1, 1, 2], VOLUME_LAMP_FLOATS);
    const hit = [55.25, 0.75, 3.25];
    const c = cellOf(hit);
    // No brick kept anywhere: no list, no lamp light.
    expect(volumeLampListBrick(c[0]!, c[1]!, c[2]!, origins, listed)).toBeNull();
    // Level 3 keeps the brick holding it (8 m bricks, 4 m cells): its list, and the lamp reaching the hit is on it.
    const b3 = c.map((v) => v >> (2 + 3));
    kept.add(`3,${b3.join(',')}`);
    const at = volumeLampListBrick(c[0]!, c[1]!, c[2]!, origins, listed);
    expect(at).toEqual([3, ...b3]);
    const list = volumeBrickLamps(t, 2, b3[0]!, b3[1]!, b3[2]!, undefined, 3);
    expect(Math.hypot(hit[0]! - 60, hit[1]! - 2, hit[2]! - 3)).toBeLessThan(14);
    expect(list.listed).toEqual([0]);
    // Past level 0's window the level-0 brick does not serve even if kept; inside it, it does, before any coarse one.
    kept.add(`0,${c.map((v) => v >> 2).join(',')}`);
    expect(volumeLampListBrick(c[0]!, c[1]!, c[2]!, origins, listed)![0]).toBe(3);
    const near = cellOf([10.25, 0.75, 3.25]);
    kept.add(`0,${near.map((v) => v >> 2).join(',')}`);
    kept.add(`1,${near.map((v) => v >> 3).join(',')}`);
    expect(volumeLampListBrick(near[0]!, near[1]!, near[2]!, origins, listed)![0]).toBe(0);
    // A level-0 brick without a slot yet: the finest coarse level holding it with one.
    kept.delete(`0,${near.map((v) => v >> 2).join(',')}`);
    expect(volumeLampListBrick(near[0]!, near[1]!, near[2]!, origins, listed)![0]).toBe(1);
    // Past every window: none.
    const out = cellOf([130, 0.75, 3]);
    kept.add(`3,${out.map((v) => v >> 5).join(',')}`);
    expect(volumeLampListBrick(out[0]!, out[1]!, out[2]!, origins, listed)).toBeNull();
  });

  it('a coarse brick lists every lamp whose reach meets its box (brute force, levels 1–3), by the same rule', () => {
    const t = scrap();
    const n = t.length / VOLUME_LAMP_FLOATS;
    for (const level of [1, 2, 3]) {
      const m = VOLUME_BRICK_M * 2 ** level;
      let lit = 0;
      for (let x = -4; x < 4; x++) for (let y = -1; y < 2; y++) for (let z = -4; z < 4; z++) {
        const want: number[] = [];
        for (let i = 0; i < n; i++) {
          const o = i * VOLUME_LAMP_FLOATS;
          const d = Math.hypot(...[x, y, z].map((b, a) => t[o + a]! - Math.min(Math.max(t[o + a]!, b * m), b * m + m)));
          if (d < t[o + 3]! && volumeLampFacesBrick(t, i, x, y, z, level)) want.push(i);
          if (lights(t, i, [x, y, z], level)) expect(want.includes(i), `level ${level}: lamp ${i} lights brick ${x},${y},${z}`).toBe(true);
        }
        const r = volumeBrickLamps(t, n, x, y, z, Infinity, level, 0);
        expect(r.listed, `level ${level} brick ${x},${y},${z}`).toEqual(want);
        if (want.length > 0) lit++;
        const k = volumeBrickLamps(t, n, x, y, z, undefined, level);
        expect(k.total).toBe(want.length);
        expect(k.listed).toEqual(ranked(t, n, [x, y, z], level).slice(0, k.listed.length).map((w) => w[0]).sort((p, q) => p - q));
      }
      expect(lit).toBeGreaterThan(10);
    }
  });

  it("the lamp table from the clustered lights' record: point and spot lights with a range and area lights, on, near the windows; their record passed through", () => {
    const l = new ClusterLights();
    const base = { position: [1, 2, 3], reach: 8, color: [2, 1, 0.5], decay: 2 };
    l.add({ ...base, kind: 'point' });
    l.add({ ...base, kind: 'spot', position: [4, 2, 3], direction: [0, -1, 0], cosOuter: 0.8, cosInner: 0.9 });
    l.add({ ...base, kind: 'rect', position: [6, 3, 3], u: [1, 0, 0], v: [0, 0, 0.5], direction: [0, -1, 0] });
    l.add({ ...base, kind: 'line', position: [7, 3, 3], u: [0.6, 0, 0], direction: [0, -1, 0] });
    l.add({ ...base, kind: 'rect', position: [8, 3, 3], u: [0, 0, 0.3], v: [0, 0.3, 0], direction: [1, 0, 0], twoSided: true });
    l.add({ ...base, kind: 'point', unbounded: true });
    l.add({ ...base, kind: 'point', uncached: true });
    l.add({ ...base, kind: 'point', visible: false });
    l.add({ ...base, kind: 'rect', u: [1, 0, 0], v: [0, 0, 1], visible: false });
    l.add({ ...base, kind: 'point', color: [0, 0, 0] });
    l.add({ ...base, kind: 'point', position: [500, 2, 3] });
    l.add({ ...base, kind: 'rect', position: [500, 2, 3], u: [1, 0, 0], v: [0, 0, 1] });
    const box: [number[], number[]] = [[-50, -20, -50], [50, 20, 50]];
    const set = volumeLampSet(l, box);
    expect([set.count, set.areas]).toEqual([5, true]);
    expect(set.spheres).toEqual([[1, 2, 3, 8], [4, 2, 3, 8], [6, 3, 3, 8], [7, 3, 3, 8], [8, 3, 3, 8]]);
    const rec = (i: number): number[] => [...set.data.subarray(i * VOLUME_LAMP_FLOATS, (i + 1) * VOLUME_LAMP_FLOATS)].map((v) => Number(v.toFixed(4)) + 0);
    expect(rec(0).slice(0, 8)).toEqual([1, 2, 3, 8, 2, 1, 0.5, 2]);
    // The spot's axis, kind (1) and cone: what its bounce by cone reads.
    expect(rec(1).slice(8, 12)).toEqual([0, -1, 0, 1]);
    expect([rec(1)[15], rec(1)[19]]).toEqual([0.8, 0.9]);
    // The rect: facing and kind (2) in words 8–11, its half sides u (12–14) and v (16–18), u × v along its facing.
    expect(rec(2).slice(8, 12)).toEqual([0, -1, 0, 2]);
    expect([rec(2).slice(12, 15), rec(2).slice(16, 19)]).toEqual([[1, 0, 0], [0, 0, 0.5]]);
    // The line (3): its v the strip across it, as the clustered lights keep it.
    expect(rec(3)[11]).toBe(3);
    expect(rec(3).slice(12, 15)).toEqual([0.6, 0, 0]);
    expect(rec(3).slice(16, 19).map((v, a) => Number((v - l.v[3 * 3 + a]!).toFixed(4)) + 0)).toEqual([0, 0, 0]);
    expect(Math.hypot(...rec(3).slice(16, 19))).toBeGreaterThan(0);
    // The two-sided rect: its flag kept in the kind field (2 | 4), not read as a range-less point light's.
    expect(rec(4)[11]).toBe(6);
    expect(volumeLampSet(l, box).key).toBe(set.key);
    // A spot turned, an area light moved or resized: the key changes (what the old and new reach is marked).
    for (const change of [(): void => void (l.direction[1 * 3 + 0] = 0.3), (): void => void (l.position[2 * 3 + 1] = 3.5), (): void => void (l.u[2 * 3 + 0] = 1.4), (): void => void (l.v[3 * 3 + 2] = l.v[3 * 3 + 2]! * 2)]) {
      const was = volumeLampSet(l, box).key;
      change();
      expect(volumeLampSet(l, box).key).not.toBe(was);
    }
    l.position[0] = 1.5;
    expect(volumeLampSet(l, box).key).not.toBe(set.key);
    expect(volumeLampSet(null, box).count).toBe(0);
    expect(volumeLampSet(l, [[100, 0, 0], [200, 1, 1]]).count).toBe(0);
    // Points and spots alone: the update runs without the area lights' code.
    const plain = new ClusterLights();
    plain.add({ ...base, kind: 'point' });
    plain.add({ ...base, kind: 'spot', direction: [0, -1, 0], cosOuter: 0.8, cosInner: 0.9 });
    expect([volumeLampSet(plain, box).count, volumeLampSet(plain, box).areas]).toEqual([2, false]);
  });

  it('an area light (rect, line, two-sided) is listed by every brick its reach meets in front of it (both sides when two-sided) and no other', () => {
    const l = new ClusterLights();
    l.add({ kind: 'rect', position: [3.2, 2.9, -1.1], reach: 6, color: [0, 0, 5], direction: [0, -1, 0], u: [0.5, 0, 0], v: [0, 0, 0.25] });
    l.add({ kind: 'line', position: [-6.4, 1.3, 4.7], reach: 9.5, color: [3, 3, 3], direction: [0, 0, 1], u: [0.6, 0, 0] });
    l.add({ kind: 'rect', position: [10.1, 4, -8], reach: 12, color: [1, 2, 1], direction: [1, 0, 0], u: [0, 0, 0.3], v: [0, 0.3, 0], twoSided: true });
    l.add({ kind: 'point', position: [0, 1, 0], reach: 5, color: [1, 1, 1] });
    const set = volumeLampSet(l, [[-50, -20, -50], [50, 20, 50]]);
    expect(set.count).toBe(4);
    const met = [0, 0, 0];
    const behind = [0, 0, 0, 0];
    for (const level of [0, 1]) {
      for (const b of BRICKS) {
        const want: number[] = [];
        for (let i = 0; i < 4; i++) {
          const o = i * VOLUME_LAMP_FLOATS;
          const m = VOLUME_BRICK_M * 2 ** level;
          const d = Math.hypot(...b.map((v, a) => set.data[o + a]! - Math.min(Math.max(set.data[o + a]!, v * m), v * m + m)));
          const front = lights(set.data, i, b, level);
          if (d < set.data[o + 3]! && front) want.push(i);
          // Behind a one-sided light's plane: met by its reach, never listed.
          if (d < set.data[o + 3]! && !front && level === 0) behind[i]!++;
        }
        expect(volumeBrickLamps(set.data, set.count, b[0]!, b[1]!, b[2]!, undefined, level, 0).listed, `level ${level} brick ${b.join(',')}`).toEqual(want);
        for (let i = 0; i < 3; i++) if (level === 0 && want.includes(i)) met[i]!++;
      }
    }
    expect(met.every((n) => n > 20), JSON.stringify(met)).toBe(true);
    // The one-sided rect and line leave out the bricks behind them; the two-sided rect and the point none.
    expect(behind[0]).toBeGreaterThan(10);
    expect(behind[1]).toBeGreaterThan(10);
    expect([behind[2], behind[3]]).toEqual([0, 0]);
  });
});
