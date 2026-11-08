/**
 * The far tree's pure parts: the selection by on-screen error (hysteresis,
 * no cut-off, the near box, the budget), the stale ancestors of an edit, the
 * uniform shortcut against the downsample, and openings closing at the level
 * where they would leave a one-cell gap (no "legs" under a far wall).
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid, localIndex } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { buildFarNode, downsampleCells, farAncestors, FarNodeIndex, farNodeBox, FarSelection, farSelectionDiff, farTopLevel, isUniformKeepable, uniformCells, type FarCells } from './far-tree';
import { recordValue, SHAPE_FULL, VOXEL_ROLE } from './record';
import { downsampleMip, mipNodeKey, mipNodeOf, type MipNode } from './voxel-mips';

const grid = chunkGrid(32);
const PPR = 720 / (2 * Math.tan(Math.PI / 6));

/** Every node of levels 2 … 6 over chunks [0, 256) on x and z, one node row high (a flat world 4 km a side). */
function flatIndex(): FarNodeIndex {
  const idx = new FarNodeIndex(grid, 2, 6);
  for (let l = 2; l <= 6; l++) {
    const n = 256 >> l;
    for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) idx.add({ level: l, nx: x, ny: 0, nz: z }, 1000 << (l - 2));
  }
  return idx;
}

/** The drawn node covering a level-2 node (itself or an ancestor), or null. */
function coverOf(drawn: ReadonlySet<string>, n: MipNode): string | null {
  for (let l = n.level; l <= 6; l++) {
    const k = mipNodeKey({ level: l, nx: n.nx >> (l - n.level), ny: n.ny >> (l - n.level), nz: n.nz >> (l - n.level) });
    if (drawn.has(k)) return k;
  }
  return null;
}

describe('far selection', () => {
  it('opens a node only past the error threshold and closes it only below (1 − hysteresis) of it', () => {
    const idx = flatIndex();
    // The level-6 node at the world's corner, seen along x from the eye d cells off its −x face: its error is 64 · PPR / d.
    const corner: MipNode = { level: 6, nx: 0, ny: 0, nz: 0 };
    const t = 2;
    // The distance at which its error is `ratio` × the threshold.
    const at = (ratio: number): number => (64 * PPR) / (t * ratio);
    const eye = (d: number): readonly [number, number, number] => [-d, 20, 1024];
    const sel = new FarSelection();
    const drawnKeys = (d: number, s = sel): Set<string> => new Set(s.select(idx, { eye: eye(d), pixelsPerRadian: PPR, errorPixels: t, hysteresis: 0.25, budgetBytes: 1e12, near: null }).drawn.map((x) => mipNodeKey(x.node)));
    // Past the threshold (1.1 ×): opened, so not drawn itself.
    expect(drawnKeys(at(1.1)).has(mipNodeKey(corner))).toBe(false);
    // Moving away to 0.9 of the threshold: still open (hysteresis); a fresh selection there keeps it closed.
    expect(drawnKeys(at(0.9)).has(mipNodeKey(corner))).toBe(false);
    expect(drawnKeys(at(0.9), new FarSelection()).has(mipNodeKey(corner))).toBe(true);
    // Below (1 − h) of it, it closes.
    expect(drawnKeys(at(0.7)).has(mipNodeKey(corner))).toBe(true);
  });

  it('covers every node of the world exactly once, coarser with distance, with no distance past which nothing is drawn', () => {
    const idx = flatIndex();
    const s = new FarSelection().select(idx, { eye: [100, 20, 100], pixelsPerRadian: PPR, errorPixels: 2, budgetBytes: 1e12, near: null });
    const drawn = new Set(s.drawn.map((d) => mipNodeKey(d.node)));
    for (const n of idx.nodes(2)) expect(coverOf(drawn, n), mipNodeKey(n)).not.toBeNull();
    // Nothing drawn twice: no drawn node has a drawn ancestor.
    for (const d of s.drawn) for (let l = d.node.level + 1; l <= 6; l++) expect(drawn.has(mipNodeKey({ level: l, nx: d.node.nx >> (l - d.node.level), ny: 0, nz: d.node.nz >> (l - d.node.level) }))).toBe(false);
    // Every opened node's error was past the threshold; every drawn node above the lowest level is within it.
    for (const d of s.drawn) if (d.node.level > 2) expect(d.errorPixels).toBeLessThanOrEqual(2);
    // The far corner (5.6 km) is drawn, coarser than the near corner.
    const near = s.drawn.find((d) => d.distance === 0)!;
    const far = s.drawn.reduce((a, b) => (b.distance > a.distance ? b : a));
    expect(far.distance / 2000).toBeGreaterThan(5);
    expect(far.node.level).toBeGreaterThan(near.node.level);
    expect(s.bytes).toBe(s.drawn.reduce((a, d) => a + d.bytes, 0));
  });

  it('leaves the near box to the near rings and meets it with lowest-level nodes only', () => {
    const idx = flatIndex();
    const near = { min: [1000, -500, 1000] as const, max: [1800, 500, 1800] as const };
    const s = new FarSelection().select(idx, { eye: [1400, 20, 1400], pixelsPerRadian: PPR, errorPixels: 50, budgetBytes: 1e12, near });
    const drawn = new Set(s.drawn.map((d) => mipNodeKey(d.node)));
    for (const d of s.drawn) {
      const b = farNodeBox(grid, d.node);
      const insideNear = b.min[0] >= near.min[0] && b.max[0] <= near.max[0] && b.min[2] >= near.min[2] && b.max[2] <= near.max[2];
      expect(insideNear).toBe(false);
      if (d.nearOverlap) expect(d.node.level).toBe(2);
    }
    expect(s.drawn.some((d) => d.nearOverlap)).toBe(true);
    // Every level-2 node outside the near box is still covered.
    for (const n of idx.nodes(2)) {
      const b = farNodeBox(grid, n);
      const insideNear = b.min[0] >= near.min[0] && b.max[0] <= near.max[0] && b.min[2] >= near.min[2] && b.max[2] <= near.max[2];
      if (!insideNear) expect(coverOf(drawn, n)).not.toBeNull();
    }
  });

  it('keeps nodes closed past the byte budget, largest error opened first', () => {
    const idx = flatIndex();
    const view = { eye: [100, 20, 100] as const, pixelsPerRadian: PPR, errorPixels: 1, near: null };
    const free = new FarSelection().select(idx, { ...view, budgetBytes: 1e12 });
    const tight = new FarSelection().select(idx, { ...view, budgetBytes: free.bytes / 4 });
    expect(tight.bytes).toBeLessThanOrEqual(free.bytes / 4);
    expect(tight.heldByBudget).toBeGreaterThan(0);
    expect(tight.drawn.length).toBeLessThan(free.drawn.length);
    // The finest nodes drawn under the budget are the nearest.
    const finest = Math.min(...tight.drawn.map((d) => d.node.level));
    expect(tight.drawn.filter((d) => d.node.level === finest).every((d) => d.distance < 2000)).toBe(true);
    const diff = farSelectionDiff(free.drawn, tight.drawn);
    expect(diff.load.length).toBeGreaterThan(0);
    expect(diff.unload.length).toBeGreaterThan(0);
  });

  it('puts two top nodes or fewer across the world', () => {
    expect(farTopLevel(512)).toBe(8);
    expect(farTopLevel(64)).toBe(5);
    expect(farTopLevel(1)).toBe(2);
  });
});

describe('far stale nodes', () => {
  it('an edit marks exactly the ancestors of its chunks at the kept levels', () => {
    const a = farAncestors([{ cx: 5, cy: 0, cz: -3 }], 2, 6);
    expect(a.map(mipNodeKey)).toEqual([2, 3, 4, 5, 6].map((l) => mipNodeKey(mipNodeOf(5, 0, -3, l))));
    // Two chunks in one level-2 node share every ancestor.
    expect(farAncestors([{ cx: 4, cy: 0, cz: 4 }, { cx: 7, cy: 3, cz: 7 }], 2, 6)).toHaveLength(5);
  });
});

/** A chunk's cells from (x, y, z) → [material, role] or null. */
function cellsOf(f: (x: number, y: number, z: number) => [number, number] | null, ox = 0, oy = 0, oz = 0): DenseChunk {
  const c = createDenseChunk(grid);
  for (let x = 0; x < 32; x++) for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) {
    const v = f(ox + x, oy + y, oz + z);
    if (v === null) continue;
    const i = localIndex(grid, x, y, z);
    c.material[i] = v[0];
    c.role[i] = v[1];
    c.shape[i] = SHAPE_FULL;
  }
  return c;
}

describe('the uniform shortcut', () => {
  it('gives what the downsample gives', () => {
    const rock = recordValue(1, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
    expect(isUniformKeepable(rock)).toBe(true);
    expect(downsampleCells(grid, Array<FarCells>(8).fill(rock))).toBe(rock);
    const out = createDenseChunk(grid);
    downsampleMip(grid, Array.from({ length: 8 }, () => uniformCells(grid, rock)), out);
    expect(out).toEqual(uniformCells(grid, rock));
    // A roof is laid again by the downsample, and a damaged wall comes out whole: never short-cut.
    expect(isUniformKeepable(recordValue(13, VOXEL_ROLE.roof, SHAPE_FULL, 0))).toBe(false);
    expect(isUniformKeepable(recordValue(10, VOXEL_ROLE.wall, 7, 0))).toBe(false);
    expect(downsampleCells(grid, Array<FarCells>(8).fill(null))).toBeNull();
  });

  it('builds a node from a source the same with or without cached children', () => {
    const ground = (x: number, y: number): [number, number] | null => (y < 20 + (x % 7) ? [2, VOXEL_ROLE.terrain] : null);
    const chunk = (cx: number, cy: number, cz: number): FarCells => (cy < 0 ? recordValue(1, VOXEL_ROLE.terrain, SHAPE_FULL, 0) : cy > 0 ? null : cellsOf(ground, cx * 32, cy * 32, cz * 32));
    const kept = new Map<string, FarCells>();
    const n: MipNode = { level: 3, nx: 0, ny: 0, nz: 0 };
    const whole = buildFarNode({ grid, chunk }, n, (k, c) => kept.set(mipNodeKey(k), c));
    expect(kept.size).toBe(1 + 8 + 64);
    const again = buildFarNode({ grid, chunk: () => { throw new Error('read a chunk'); }, cached: (k) => (k.level === 2 ? kept.get(mipNodeKey(k)) ?? null : undefined) }, n);
    expect(again).toEqual(whole);
  });
});

describe('openings at the coarser levels (no legs)', () => {
  // A one-cell wall along x at z = 10, 16 cells tall, x 0 … 63: a door 2 wide × 4 tall, a window 2 × 2, and a gate 6 wide × 4 tall.
  const WALL = 10;
  const door = (x: number, y: number): boolean => x >= 10 && x <= 11 && y >= 1 && y <= 4;
  const window = (x: number, y: number): boolean => x >= 20 && x <= 21 && y >= 8 && y <= 9;
  const gate = (x: number, y: number): boolean => x >= 32 && x <= 37 && y >= 1 && y <= 4;
  const wall = (x: number, y: number, z: number): [number, number] | null => {
    if (z !== WALL || y >= 16) return null;
    return door(x, y) || window(x, y) || gate(x, y) ? [10, VOXEL_ROLE.opening] : [10, VOXEL_ROLE.wall];
  };
  const children = (): Array<DenseChunk | null> => [0, 1, 2, 3, 4, 5, 6, 7].map((o) => ((o >> 1) & 1 ? null : cellsOf(wall, (o & 1) * 32, 0, ((o >> 2) & 1) * 32)));
  const at = (c: DenseChunk, x: number, y: number, z: number): [number, number] => {
    const i = localIndex(grid, x, y, z);
    return [c.material[i]!, c.role[i]!];
  };

  it('closes a door and a window in the wall at level 1, keeps a wide gate open there and closes it at level 2', () => {
    const l1 = createDenseChunk(grid);
    downsampleMip(grid, children(), l1);
    // Door: x 5, y 0 … 2 at level 1 (cells 10–11, 0–5); window: x 10, y 4.
    for (const y of [0, 1, 2]) expect(at(l1, 5, y, 5), `door y ${y}`).toEqual([10, VOXEL_ROLE.wall]);
    expect(at(l1, 10, 4, 5)).toEqual([10, VOXEL_ROLE.wall]);
    // The gate (cells 32–37, 1–4): its middle stays open at level 1, as an opening.
    expect(at(l1, 17, 1, 5)).toEqual([10, VOXEL_ROLE.opening]);
    expect(at(l1, 17, 4, 5)[1]).toBe(VOXEL_ROLE.wall);
    // Level 2 from level 1: the gate is 3 cells wide there, narrower than two of level 2's: closed.
    const l2 = createDenseChunk(grid);
    downsampleMip(grid, [l1, null, null, null, null, null, null, null], l2);
    for (let x = 16; x <= 18; x++) for (const y of [0, 1]) expect(at(l2, x >> 1, y, 2)[1], `gate ${x} ${y}`).toBe(VOXEL_ROLE.wall);
  });

  it('left a gap at level 1 before openings closed (the legs): the door cell was air', () => {
    // The same wall with its door as air instead of an opening: the downsample alone leaves the gap.
    const air = [0, 1, 2, 3, 4, 5, 6, 7].map((o) => ((o >> 1) & 1 ? null : cellsOf((x, y, z) => (door(x, y) ? null : wall(x, y, z)), (o & 1) * 32, 0, ((o >> 2) & 1) * 32)));
    const l1 = createDenseChunk(grid);
    downsampleMip(grid, air, l1);
    expect(at(l1, 5, 1, 5)).toEqual([0, VOXEL_ROLE.air]);
  });
});
