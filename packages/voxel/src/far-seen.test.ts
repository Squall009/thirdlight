/**
 * What the far field's draws were seen at (far-seen.ts) and the selection
 * that uses it: stale rounds dropped, a node seen through itself, a node
 * under it or its stand-in over it, unseen only after a whole turn window
 * of rounds, and the selection drawing what the eye has not met coarser
 * (never nothing) while what it sees keeps its detail and takes the budget.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { FAR_SEEN_STRIDE, FAR_SEEN_TURN_MS, FAR_UNSEEN_ERROR_SCALE, FarSeenLog, type FarSeenWire } from './far-seen';
import { FarNodeIndex, FarSelection } from './far-tree';
import { mipNodeKey, type MipNode } from './voxel-mips';

const grid = chunkGrid(32);
const PPR = 720 / (2 * Math.tan(Math.PI / 6));

function round(n: number, nodes: Array<[MipNode, number, number]>, farSeq = n): FarSeenWire {
  return { round: n, farSeq, nodes: nodes.flatMap(([m, px, near]) => [m.level, m.nx, m.ny, m.nz, px, near]) };
}

/** Every node of levels 2 … 6 over chunks [0, 256) on x and z, one node row high (a flat world 4 km a side). */
function flatIndex(): FarNodeIndex {
  const idx = new FarNodeIndex(grid, 2, 6);
  for (let l = 2; l <= 6; l++) {
    const n = 256 >> l;
    for (let x = 0; x < n; x++) for (let z = 0; z < n; z++) idx.add({ level: l, nx: x, ny: 0, nz: z }, 1000 << (l - 2));
  }
  return idx;
}

describe('the far seen log', () => {
  it('drops stale rounds and calls nothing unseen until rounds have come for a whole turn window', () => {
    const log = new FarSeenLog(1000, 6);
    const a: MipNode = { level: 2, nx: 5, ny: 0, nz: 9 };
    expect(log.apply(round(3, [[a, 40, 300]]), 0)).toBe(true);
    // Not newer than the last taken, or of an older frame: dropped, nothing changes.
    expect(log.apply(round(3, [[a, 1, 1]]), 10)).toBe(false);
    expect(log.apply(round(2, []), 20)).toBe(false);
    expect(log.apply({ round: 9, farSeq: 1, nodes: [] }, 30)).toBe(false);
    expect(log.counters).toMatchObject({ rounds: 1, stale: 3 });
    expect(log.pixelsOf(a)).toBe(40);
    // Its error where it showed: a level-2 cell (4 cells) at its nearest pixel's 300 cells.
    expect(log.seenError(a, 500, PPR)).toBeCloseTo((4 * PPR) / 300, 9);
    const b: MipNode = { level: 2, nx: 6, ny: 0, nz: 9 };
    // Rounds for less than the window: nothing is unseen, whatever was seen.
    expect(log.running(900)).toBe(false);
    expect(log.unseen(b, 900)).toBe(false);
    expect(log.apply(round(4, [[a, 40, 300]]), 1000)).toBe(true);
    expect(log.running(1000)).toBe(true);
    // b never seen: unseen; a seen at 1000: seen until the window has passed since.
    expect(log.unseen(b, 1000)).toBe(true);
    expect(log.unseen(a, 1999)).toBe(false);
    expect(log.unseen(a, 2001)).toBe(true);
    expect(log.seenError(a, 2001, PPR)).toBeNull();
  });

  it('counts a node seen through itself, a node under it, or the stand-in drawn over it', () => {
    const log = new FarSeenLog(1000, 6);
    const leaf: MipNode = { level: 2, nx: 9, ny: 0, nz: 4 };
    const coarse: MipNode = { level: 5, nx: 6, ny: 0, nz: 0 };
    log.apply(round(1, []), 0);
    log.apply(round(2, [[leaf, 8, 50], [coarse, 100, 900]]), 1500);
    // Every ancestor of the leaf was seen through it.
    expect(log.unseen({ level: 3, nx: 4, ny: 0, nz: 2 }, 1600)).toBe(false);
    expect(log.unseen({ level: 6, nx: 0, ny: 0, nz: 0 }, 1600)).toBe(false);
    // The leaf's sibling was not (an ancestor seen through another child does not make it seen).
    expect(log.unseen({ level: 2, nx: 8, ny: 0, nz: 4 }, 1600)).toBe(true);
    // Under the coarse stand-in, any node may be what showed: seen.
    expect(log.unseen({ level: 2, nx: 6 * 8 + 3, ny: 0, nz: 5 }, 1600)).toBe(false);
    expect(log.seenAt({ level: 3, nx: 6 * 4 + 1, ny: 0, nz: 1 })).toBe(1500);
    expect(FAR_SEEN_STRIDE).toBe(6);
  });
});

describe('far selection with visibility feedback', () => {
  it('draws what the eye has not met coarser, never nothing, and gives the budget to what it sees first', () => {
    const idx = flatIndex();
    const eye = [4096, 40, 4096] as const;
    // The half of the world east of the eye is unseen (behind the camera).
    const behind = (n: MipNode): boolean => (n.nx + 1) * (32 << n.level) <= eye[0];
    const view = { eye, pixelsPerRadian: PPR, errorPixels: 2, budgetBytes: 1e12, near: null };
    const plain = new FarSelection().select(idx, view);
    const fed = new FarSelection().select(idx, { ...view, unseen: behind, unseenScale: FAR_UNSEEN_ERROR_SCALE });
    const count = (s: typeof plain, f: (n: MipNode) => boolean): number => s.drawn.filter((d) => f(d.node)).length;
    // The seen half is drawn as before; the unseen half with fewer, coarser nodes, and still all of it.
    expect(count(fed, (n) => !behind(n))).toBe(count(plain, (n) => !behind(n)));
    expect(count(fed, behind)).toBeLessThan(count(plain, behind) / 2);
    const covered = (s: typeof plain, n: MipNode): boolean => {
      const keys = new Set(s.drawn.map((d) => mipNodeKey(d.node)));
      for (let l = n.level; l <= 6; l++) if (keys.has(mipNodeKey({ level: l, nx: n.nx >> (l - n.level), ny: 0, nz: n.nz >> (l - n.level) }))) return true;
      return false;
    };
    for (const n of idx.nodes(2)) expect(covered(fed, n)).toBe(true);
    // Its error counts a quarter: 2 km behind the eye the unseen ground stands two levels coarser (a level halves the
    // error), next to the eye at the finest level still.
    const levelAt = (s: typeof plain, x: number): number => s.drawn.find((d) => d.node.ny === 0 && x >= d.node.nx * (32 << d.node.level) && x < (d.node.nx + 1) * (32 << d.node.level) && eye[2] >= d.node.nz * (32 << d.node.level) && eye[2] < (d.node.nz + 1) * (32 << d.node.level))!.node.level;
    expect(levelAt(plain, eye[0] - 4000)).toBe(3);
    expect(levelAt(fed, eye[0] - 4000)).toBe(5);
    expect(levelAt(fed, eye[0] - 8)).toBe(2);
    // A tight budget: what is seen is opened first, the unseen held.
    const budget = plain.bytes / 2;
    const tight = new FarSelection().select(idx, { ...view, budgetBytes: budget, unseen: behind, unseenScale: FAR_UNSEEN_ERROR_SCALE });
    const tightPlain = new FarSelection().select(idx, { ...view, budgetBytes: budget });
    expect(count(tight, (n) => !behind(n) && n.level === 2)).toBeGreaterThan(count(tightPlain, (n) => !behind(n) && n.level === 2));
    expect(FAR_SEEN_TURN_MS).toBeGreaterThan(0);
  });
});
