/**
 * The level choice (lod-select.ts), pure: every chunk covered once across
 * the levels, the levels by box distance, the hysteresis under a jittering
 * focus, stand-ins where a level is not ready, and the 2 : 1 rule, all
 * checked by brute force (lod-checks.ts) rather than by the choice's own
 * bookkeeping.
 */
import { describe, expect, it } from 'vitest';
import { chooseLevels, chunkGrid, COLLISION_RING_HYSTERESIS_CELLS, DEFAULT_COLLISION_RING, DEFAULT_LEVEL_RINGS, levelNodeDistance, worldLevelRings, type DrawnLevels, type Focus, type LevelNode, type LevelRings } from '@thirdlight/voxel';
import { checkLevels, chunkId, nodeChunks } from './lod-checks';

const grid = chunkGrid(32);
/** Level-2 roots over chunks x, z −32 … 31, y −8 … 7 (2 km of ground, 256 m up). */
const ROOTS: LevelNode[] = [];
for (let nx = -8; nx < 8; nx++) for (let nz = -8; nz < 8; nz++) for (let ny = -2; ny < 2; ny++) ROOTS.push({ level: 2, nx, ny, nz });
const ALL_CHUNKS = ROOTS.length * 64;

type Ready = (level: number, nx: number, ny: number, nz: number) => boolean;
const always: Ready = () => true;

function choose(foci: Focus[], rings: LevelRings, ready: Ready = always, previous: DrawnLevels | null = null): { drawn: DrawnLevels; unbalanced: number } {
  const r = chooseLevels({ grid, maxLevel: 2, rings, foci, roots: ROOTS, ready, previous });
  return { drawn: r.drawn, unbalanced: r.stats.unbalanced };
}

const parent = (n: LevelNode): LevelNode => ({ level: n.level + 1, nx: n.nx >> 1, ny: n.ny >> 1, nz: n.nz >> 1 });
const dist = (foci: Focus[], n: LevelNode): number => levelNodeDistance(grid, foci, n);
const same = (a: DrawnLevels, b: DrawnLevels): boolean => a.size === b.size && a.minus(b).length === 0;

describe('the level choice', () => {
  it('covers every chunk exactly once, level by box distance from the nearest focus, neighbours at most a level apart', () => {
    for (const foci of [[{ x: 10, y: 0, z: -20 }], [{ x: 0, y: 0, z: 0 }, { x: 700, y: 0, z: 300 }]]) {
      const { drawn, unbalanced } = choose(foci, DEFAULT_LEVEL_RINGS);
      const c = checkLevels(drawn.nodes());
      expect(c.doubled).toBe(0);
      expect(c.covered.size).toBe(ALL_CHUNKS);
      expect(c.unbalanced).toBe(0);
      expect(unbalanced).toBe(0);
      for (const n of drawn.nodes()) {
        // Level L is drawn where its parent is within ring L (split) and it is not (whole); the balance only ever splits.
        if (n.level < 2) expect(dist(foci, parent(n))).toBeLessThan(DEFAULT_LEVEL_RINGS.radii[n.level]!);
        if (n.level === 2) expect(dist(foci, n)).toBeGreaterThanOrEqual(DEFAULT_LEVEL_RINGS.radii[1]!);
      }
      for (const f of foci) {
        // Level 0 round every focus: the default collision ring with its hysteresis (112 cells) is inside it.
        for (const n of drawn.nodes()) if (dist([f], n) < 112) expect(n.level).toBe(0);
      }
      expect(drawn.countAt(0)).toBeGreaterThan(0);
      expect(drawn.countAt(1)).toBeGreaterThan(0);
      expect(drawn.countAt(2)).toBeGreaterThan(0);
    }
  });

  it('keeps a split node split under a jittering focus (hysteresis), where no hysteresis flips it every step', () => {
    // A level-1 node over x 192 … 255 is 127 cells from a focus at x 65 (split) and 133 at x 59 (whole without hysteresis).
    const at = (x: number): Focus[] => [{ x, y: 0, z: 30 }];
    // The first two steps may split nodes the jitter brings within a ring (a node on the other side at 124 cells); after them, only flips count.
    const flips = (rings: LevelRings): number => {
      let prev = choose(at(65), rings).drawn;
      let n = 0;
      for (let i = 0; i < 22; i++) {
        const next = choose(at(i % 2 === 0 ? 59 : 71), rings, always, prev).drawn;
        if (i >= 2 && !same(prev, next)) n++;
        prev = next;
      }
      return n;
    };
    expect(flips({ radii: [128, 256], hysteresis: 0 })).toBe(20);
    expect(flips({ radii: [128, 256], hysteresis: 16 })).toBe(0);
    // Past the hysteresis it does go whole.
    const split = choose(at(65), DEFAULT_LEVEL_RINGS).drawn;
    expect(split.drawn(0, 6, 0, 0)).toBe(true);
    expect(choose(at(65 - 17), DEFAULT_LEVEL_RINGS, always, split).drawn.drawn(1, 3, 0, 0)).toBe(true);
  });

  it('draws what is ready: the old level stays until the new one is ready; finer levels stand in up to a node past their ring', () => {
    const foci = [{ x: 0, y: 0, z: 0 }];
    const rings = DEFAULT_LEVEL_RINGS;
    // Level 2 never ready (the far edge of a load ring), level 1 only within 300 cells: level 1 stands in, nothing past.
    const l1Near: Ready = (l, nx, ny, nz) => l === 0 || (l === 1 && dist(foci, { level: 1, nx, ny, nz }) < 300);
    const a = choose(foci, rings, l1Near);
    const ca = checkLevels(a.drawn.nodes());
    expect(ca.doubled).toBe(0);
    expect(ca.unbalanced).toBe(0);
    expect(a.drawn.countAt(2)).toBe(0);
    for (const n of ROOTS) for (const [x, y, z] of nodeChunks(n)) {
      const c = { level: 0, nx: x, ny: y, nz: z };
      expect(ca.covered.has(chunkId(x, y, z)), `${x},${y},${z}`).toBe(dist(foci, parent(c)) < 300);
    }
    // Level 1 only within 150: past it level 0 stands in, but only within one level-1 node past its ring (128 + 64).
    const l1Nearer: Ready = (l, nx, ny, nz) => l === 0 || (l === 1 && dist(foci, { level: 1, nx, ny, nz }) < 150);
    const b = checkLevels(choose(foci, rings, l1Nearer).drawn.nodes());
    expect(b.doubled).toBe(0);
    for (const n of ROOTS) for (const [x, y, z] of nodeChunks(n)) {
      const c = { level: 0, nx: x, ny: y, nz: z };
      const covered = b.covered.get(chunkId(x, y, z));
      const wantL1 = dist(foci, parent(c)) < 150 && dist(foci, parent(c)) >= 128;
      if (dist(foci, parent(c)) < 128) expect(covered).toBe(0);
      else if (wantL1) expect(covered).toBe(1);
      else expect(covered).toBe(dist(foci, c) < 192 ? 0 : undefined);
    }
    // Moving in: level 0 wanted where level 1 is drawn, but one chunk of it is not ready yet: level 1 stays whole.
    const before = choose([{ x: 400, y: 0, z: 0 }], rings).drawn;
    expect(before.drawn(1, 2, 0, 0)).toBe(true);
    const notYet: Ready = (l, nx, ny, nz) => !(l === 0 && nx === 4 && ny === 0 && nz === 0);
    const moving = choose([{ x: 200, y: 0, z: 0 }], rings, notYet, before).drawn;
    expect(moving.drawn(1, 2, 0, 0)).toBe(true);
    expect(moving.drawn(0, 5, 0, 0)).toBe(false);
    expect(checkLevels(moving.nodes()).covered.size).toBe(ALL_CHUNKS);
    // Once it is, level 0 replaces it.
    const there = choose([{ x: 200, y: 0, z: 0 }], rings, always, moving).drawn;
    expect(there.drawn(1, 2, 0, 0)).toBe(false);
    expect(there.drawn(0, 4, 0, 0)).toBe(true);
  });

  it('splits a coarse node facing nodes two levels finer (no level-1 band), and reports what it cannot mend', () => {
    const foci = [{ x: 0, y: 0, z: 0 }];
    const noBand: LevelRings = { radii: [128, 128], hysteresis: 0 };
    const { drawn, unbalanced } = choose(foci, noBand);
    const c = checkLevels(drawn.nodes());
    expect(c.doubled).toBe(0);
    expect(c.covered.size).toBe(ALL_CHUNKS);
    expect(c.unbalanced).toBe(0);
    expect(unbalanced).toBe(0);
    // Level 1 is drawn between level 0 and level 2 (where a split level-2 node's children lie past the ring, and where the balance splits).
    expect(drawn.countAt(1)).toBeGreaterThan(0);
    // With level 1 never ready the level-2 nodes facing level 0 cannot be split: reported, not hidden.
    const noL1 = choose(foci, noBand, (l) => l !== 1);
    expect(noL1.unbalanced).toBeGreaterThan(0);
    expect(checkLevels(noL1.drawn.nodes()).unbalanced).toBeGreaterThan(0);
  });

  it("takes a world's level distances in metres, level 0 never short of where a chunk keeps its collider", () => {
    expect(worldLevelRings(undefined, undefined)).toEqual({ radii: [...DEFAULT_LEVEL_RINGS.radii], hysteresis: DEFAULT_LEVEL_RINGS.hysteresis });
    // The default collision ring with its hysteresis lies inside the default level 0.
    expect(DEFAULT_COLLISION_RING.radius + COLLISION_RING_HYSTERESIS_CELLS).toBeLessThanOrEqual(DEFAULT_LEVEL_RINGS.radii[0]!);
    expect(worldLevelRings({ level0: 70, level1: 90 }, 48).radii).toEqual([140, 180]);
    // Level 0 set inside the collision ring is widened to it (+ the hysteresis); level 1 never inside level 0.
    expect(worldLevelRings({ level0: 20, level1: 30 }, 48).radii).toEqual([96 + COLLISION_RING_HYSTERESIS_CELLS, 96 + COLLISION_RING_HYSTERESIS_CELLS]);
    expect(worldLevelRings({ level0: 20, level1: 30 }, 80).radii[0]).toBe(160 + COLLISION_RING_HYSTERESIS_CELLS);
  });
});
