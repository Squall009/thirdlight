/** The light volume's refining order and its index's first-update rule (voxel-light-volume-refine.ts). */
import { describe, expect, it } from 'vitest';

import { VOLUME_HISTORY_UPDATES } from './voxel-light-volume-layout';
import { VolumeIndexRows, VolumeRefiner } from './voxel-light-volume-refine';

interface B {
  level: number;
  bx: number;
  by: number;
  bz: number;
  slot: number;
  updates: number;
  published: boolean;
}

const brick = (bx: number, bz: number, updates = 8): B => ({ level: 0, bx, by: 0, bz, slot: bx * 100 + bz + 1, updates, published: false });

describe('the refining', () => {
  it('takes the bricks in front of the eye before those behind, the near before the far, each to its history, then stops until a change', () => {
    // A row of bricks along z through the eye at brick 0, the camera looking along −z.
    const bricks = Array.from({ length: 101 }, (_, i) => brick(0, i - 50));
    const r = new VolumeRefiner<B>();
    const idle = (b: B): boolean => b.updates < VOLUME_HISTORY_UPDATES;
    const firstTaken: B[] = [];
    r.take(() => bricks, idle, [0.5, 0.5, 0.5], [0, 0, -1], 4, firstTaken);
    // Nearest first: the brick holding the eye, the two beside it, then the next in front.
    expect(firstTaken.map((b) => b.bz)).toEqual([0, -1, 1, -2]);
    let frames = 0;
    let order: number[] = [];
    while (!r.refined && frames < 100_000) {
      const list: B[] = [];
      r.take(() => bricks, idle, [0.5, 0.5, 0.5], [0, 0, -1], 4, list);
      for (const b of list) b.updates++;
      if (frames === 400) order = bricks.map((b) => b.updates);
      frames++;
    }
    expect(r.refined).toBe(true);
    expect(bricks.every((b) => b.updates === VOLUME_HISTORY_UPDATES)).toBe(true);
    // Partway, the bricks round the eye are ahead of the far ones (40 bricks off) and of those behind it.
    expect(order[50]! - order[10]!).toBeGreaterThanOrEqual(40);
    expect(order[49]! - order[60]!).toBeGreaterThanOrEqual(10);
    const none: B[] = [];
    r.take(() => bricks, idle, [0.5, 0.5, 0.5], [0, 0, -1], 4, none);
    expect(none).toEqual([]);
    // A change: refining again (here a brick restarted below its history).
    bricks[3]!.updates = 8;
    r.changed();
    expect(r.refined).toBe(false);
    const again: B[] = [];
    r.take(() => bricks, idle, [0.5, 0.5, 0.5], [0, 0, -1], 4, again);
    expect(again).toEqual([bricks[3]]);
    // Taken once a call however the order is made again within it.
    expect(new Set(again).size).toBe(again.length);
  });
});

describe("the volume's index", () => {
  it('puts a brick in at the publish after its first update, never before; a brick forgotten never goes in', () => {
    const ix = new VolumeIndexRows<B>();
    const a = brick(1, 2, 0);
    const b = brick(3, 4, 0);
    ix.firstUpdate(a);
    ix.firstUpdate(b);
    const at = (x: B): number => ix.words[ix.place(x.level, x.bx, x.by, x.bz)]!;
    expect([at(a), at(b)]).toEqual([0, 0]);
    ix.forget(b);
    ix.publish();
    expect([at(a), at(b)]).toEqual([a.slot + 1, 0]);
    expect(a.published).toBe(true);
    const rows: number[] = [];
    ix.flush((_, r) => rows.push(...r));
    expect(rows.length).toBe(1);
  });
});
