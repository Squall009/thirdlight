/**
 * The decal index changing in place (DecalGrid.set): a moved, added or
 * removed decal rewrites only its cells, and every lookup then finds what a
 * whole build of the same decals finds. Pure, no GPU.
 */
import { describe, expect, it } from 'vitest';

import { DECAL_CELL_BUDGET } from '@thirdlight/project-model';

import { DecalGrid, decalRowsAt, type DecalBox } from './decal-index';

/** A seeded random in [0, 1) (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const box = (x: number, y: number, z: number, side = 1, sortOrder = 0): DecalBox => ({ min: [x - side / 2, y - side / 2, z - side / 2], max: [x + side / 2, y + side / 2, z + side / 2], sortOrder });

/** Every point a lookup can tell apart near the boxes: each box's centre and corners, and points between. */
function probes(boxes: readonly (DecalBox | undefined)[], r: () => number): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (const b of boxes) {
    if (b === undefined) continue;
    for (let k = 0; k < 6; k++) out.push({ x: b.min[0]! + r() * (b.max[0]! - b.min[0]!), y: b.min[1]! + r() * (b.max[1]! - b.min[1]!), z: b.min[2]! + r() * (b.max[2]! - b.min[2]!) });
  }
  for (let k = 0; k < 200; k++) out.push({ x: -60 + r() * 120, y: -4 + r() * 8, z: -60 + r() * 120 });
  return out;
}

describe('the decal index changing in place', () => {
  it('after moves, spawns and removals every lookup lists what a whole build lists', () => {
    const r = rng(7);
    const boxes: (DecalBox | undefined)[] = Array.from({ length: 300 }, () => box(-40 + r() * 80, -1 + r() * 2, -40 + r() * 80, 0.6 + r() * 1.4, Math.floor(r() * 3)));
    const seq = boxes.map((_, i) => i);
    const grid = new DecalGrid(DECAL_CELL_BUDGET);
    grid.build(boxes, seq);
    let rebuilds = 0;
    let next = boxes.length;
    for (let round = 0; round < 400; round++) {
      const u = r();
      let i: number;
      if (u < 0.6) {
        // A decal moves a little (a door, a cart).
        i = Math.floor(r() * boxes.length);
        const b = boxes[i];
        if (b === undefined) continue;
        boxes[i] = box((b.min[0]! + b.max[0]!) / 2 + r() - 0.5, (b.min[1]! + b.max[1]!) / 2, (b.min[2]! + b.max[2]!) / 2 + r() - 0.5, b.max[0]! - b.min[0]!, b.sortOrder);
      } else if (u < 0.8) {
        // A spawn takes a free row, or a new one.
        i = boxes.findIndex((b) => b === undefined);
        if (i < 0) i = boxes.length;
        boxes[i] = box(-40 + r() * 80, -1 + r() * 2, -40 + r() * 80, 0.5 + r(), Math.floor(r() * 3));
        seq[i] = next++;
      } else {
        i = Math.floor(r() * boxes.length);
        boxes[i] = undefined;
      }
      if (!grid.set(i, boxes[i], seq[i])) {
        rebuilds += 1;
        grid.build(boxes, seq);
      }
    }
    const whole = new DecalGrid(DECAL_CELL_BUDGET);
    whole.build(boxes, seq);
    const at = (g: DecalGrid, p: { x: number; y: number; z: number }): number[] => decalRowsAt(g.view(), p);
    for (const p of probes(boxes, r)) {
      // What each finds is every decal whose box holds the point, in drawing order (the cells differ, the boxes do not).
      const holds = (g: DecalGrid): number[] => at(g, p).filter((k) => boxes[k] !== undefined && [0, 1, 2].every((a) => boxes[k]!.min[a]! <= [p.x, p.y, p.z][a]! && [p.x, p.y, p.z][a]! <= boxes[k]!.max[a]!));
      expect(holds(grid), JSON.stringify(p)).toEqual(holds(whole));
    }
    expect(grid.entries).toBeGreaterThan(0);
    expect(grid.dropped).toBe(whole.dropped);
    expect(rebuilds).toBeLessThan(5);
  });

  it('large authored decals, then many small spawns: the cells follow the sizes as a whole build sizes them', () => {
    // Ten 4 m puddles on the floor, then bullet holes (0.15 m) spawned one by one in a cluster on a wall.
    const r = rng(11);
    const boxes: (DecalBox | undefined)[] = Array.from({ length: 10 }, (_, k) => ({ min: [k * 9 - 2, -0.25, -2], max: [k * 9 + 2, 0.25, 2], sortOrder: 0 }));
    const seq = boxes.map((_, i) => i);
    const grid = new DecalGrid(DECAL_CELL_BUDGET);
    grid.build(boxes, seq);
    let rebuilds = 0;
    for (let k = 0; k < 60; k++) {
      const x = 20 + (k % 12) * 0.2 + r() * 0.05;
      const y = 1 + Math.floor(k / 12) * 0.2;
      const i = boxes.length;
      boxes[i] = { min: [x - 0.075, y - 0.075, 9.95], max: [x + 0.075, y + 0.075, 10.05], sortOrder: 0 };
      seq[i] = i;
      if (!grid.set(i, boxes[i], seq[i])) {
        rebuilds += 1;
        grid.build(boxes, seq);
      }
    }
    const whole = new DecalGrid(DECAL_CELL_BUDGET);
    whole.build(boxes, seq);
    // Sized as a whole build sizes them (within the quarter octave the counts tell apart), dropping what it drops.
    const near = (a: readonly number[], b: readonly number[]): boolean => a.every((v, k) => Math.abs(Math.log2(v / b[k]!)) <= 0.25 + 1e-9);
    expect(near(grid.cell, whole.cell), `${grid.cell} vs ${whole.cell}`).toBe(true);
    expect(grid.dropped).toBe(whole.dropped);
    expect(grid.droppedDecals).toBe(whole.droppedDecals);
    // What each lookup draws: every decal whose box holds the point, in drawing order.
    for (const p of probes(boxes, r)) {
      const holds = (g: DecalGrid): number[] => decalRowsAt(g.view(), p).filter((k) => [0, 1, 2].every((a) => boxes[k]!.min[a]! <= [p.x, p.y, p.z][a]! && [p.x, p.y, p.z][a]! <= boxes[k]!.max[a]!));
      expect(holds(grid), JSON.stringify(p)).toEqual(holds(whole));
    }
    // The sizes changed once or twice on the way, not at every spawn.
    expect(rebuilds).toBeLessThan(6);
    // Taken out again: back to cells sized for the puddles.
    for (let i = 10; i < boxes.length; i++) {
      boxes[i] = undefined;
      if (!grid.set(i, undefined)) grid.build(boxes, seq);
    }
    const puddles = new DecalGrid(DECAL_CELL_BUDGET);
    puddles.build(boxes, seq);
    expect(near(grid.cell, puddles.cell), `${grid.cell} vs ${puddles.cell}`).toBe(true);
  });

  it('a moved decal leaves its old cells and enters its new ones, keeping the drawing order', () => {
    const grid = new DecalGrid(DECAL_CELL_BUDGET);
    grid.build([box(0, 0, 0, 1, 5), box(0.2, 0, 0, 1, -3), box(9, 0, 0, 1, 0)]);
    expect(decalRowsAt(grid.view(), { x: 0.1, y: 0, z: 0 })).toEqual([1, 0]);
    expect(grid.set(2, box(0.1, 0, 0, 1, 0))).toBe(true);
    expect(decalRowsAt(grid.view(), { x: 0.1, y: 0, z: 0 })).toEqual([1, 2, 0]);
    expect(decalRowsAt(grid.view(), { x: 9, y: 0, z: 0 })).toEqual([]);
    // Past the grid's corner (negative cells) it is still found.
    expect(grid.set(2, box(-30, -5, -30, 1, 0))).toBe(true);
    expect(decalRowsAt(grid.view(), { x: -30, y: -5, z: -30 })).toEqual([2]);
    // A higher sort order moves it on top.
    expect(grid.set(1, box(0.2, 0, 0, 1, 9))).toBe(true);
    expect(decalRowsAt(grid.view(), { x: 0.1, y: 0, z: 0 })).toEqual([0, 1]);
    // Removed: gone from its cells; the cells probed past an emptied slot move up and are still found.
    expect(grid.set(0, undefined)).toBe(true);
    expect(decalRowsAt(grid.view(), { x: 0.1, y: 0, z: 0 })).toEqual([1]);
  });

  it('counts the budget\'s drops as decals come and go, and says when its layout cannot take a change', () => {
    const grid = new DecalGrid(DECAL_CELL_BUDGET);
    const boxes = Array.from({ length: DECAL_CELL_BUDGET }, (_, i) => box(0, 0, 0, 1, i));
    grid.build(boxes);
    expect(grid.dropped).toBe(0);
    // One more on the same spot: the lowest order drops there.
    expect(grid.set(DECAL_CELL_BUDGET, box(0, 0, 0, 1, 100))).toBe(true);
    expect(grid.droppedDecals).toBe(1);
    expect(decalRowsAt(grid.view(), { x: 0, y: 0, z: 0 })[0]).toBe(1);
    expect(grid.set(DECAL_CELL_BUDGET, undefined)).toBe(true);
    expect(grid.dropped).toBe(0);
    expect(grid.droppedDecals).toBe(0);
    // A decal far larger than the cells were sized for asks for a build (larger cells).
    expect(grid.set(3, box(0, 0, 0, 200))).toBe(false);
    // An empty grid has no layout yet.
    const empty = new DecalGrid(DECAL_CELL_BUDGET);
    empty.build([]);
    expect(empty.set(0, box(0, 0, 0))).toBe(false);
  });

  it('moving one decal of a few hundred stays far inside the frame (≤ 0.2 ms each)', () => {
    const r = rng(3);
    const boxes = Array.from({ length: 400 }, () => box(-50 + r() * 100, 0, -50 + r() * 100, 0.6 + r() * 1.4));
    const grid = new DecalGrid(DECAL_CELL_BUDGET);
    grid.build(boxes);
    const moves = 2000;
    const t0 = performance.now();
    for (let k = 0; k < moves; k++) {
      const i = k % boxes.length;
      const b = boxes[i]!;
      const c = [(b.min[0]! + b.max[0]!) / 2 + 0.05, 0, (b.min[2]! + b.max[2]!) / 2];
      boxes[i] = box(c[0]!, c[1]!, c[2]!, b.max[0]! - b.min[0]!);
      if (!grid.set(i, boxes[i])) grid.build(boxes);
    }
    const each = (performance.now() - t0) / moves;
    console.log(`decal index: ${each.toFixed(4)} ms a moved decal (${boxes.length} decals)`);
    expect(each).toBeLessThan(0.2);
  });
});
