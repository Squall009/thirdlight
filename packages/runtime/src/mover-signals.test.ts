/**
 * Mover signals (`stopOn`, `toggleOn`, `reverseOn`, next to
 * `startOn`) and the `gravity` easing (constant acceleration from each point,
 * each stretch taking as long as at its speed).
 */
import { describe, expect, it } from 'vitest';
import type { EntityV3 } from '@thirdlight/project-model';

import { GameplayBlocks, type BlocksHost } from './blocks';
import type { TransformState } from './types';

const HZ = 120;
const ent = (id: string, mover: Record<string, unknown>): EntityV3 => ({ id, components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, mover } }) as unknown as EntityV3;

function blocksWith(mover: Record<string, unknown>): { blocks: GameplayBlocks; x: () => number; y: () => number; step: (signals?: string[]) => void } {
  const e = ent('lift-000001', mover);
  const curr = new Map<string, TransformState>([[e.id, { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }]]);
  const host: BlocksHost = {
    hz: HZ,
    physics: undefined,
    curr,
    characters: [],
    groundEntityId: () => null,
  };
  const blocks = new GameplayBlocks(host, [e]);
  let n = 0;
  return {
    blocks,
    x: () => curr.get(e.id)!.position[0],
    y: () => curr.get(e.id)!.position[1],
    // Signals emitted before a step (by last step's triggers or scripts) are what its movers read.
    step(signals = []) {
      for (const s of signals) blocks.emit(s);
      blocks.beforeStep(++n);
    },
  };
}

const steps = (h: { step: (s?: string[]) => void }, n: number): void => {
  for (let i = 0; i < n; i++) h.step();
};

describe('mover signals', () => {
  it('toggleOn moves a held mover and holds a moving one; stopOn holds it, startOn moves it again', () => {
    const h = blocksWith({ waypoints: [[10, 0, 0]], speed: 1.2, mode: 'once', active: false, toggleOn: 'lever', stopOn: 'halt', startOn: 'go' });
    steps(h, 10);
    expect(h.x()).toBe(0);
    h.step(['lever']);
    steps(h, 12);
    expect(h.x()).toBeCloseTo(0.13, 9); // moving from the step that reads the signal: 13 steps at 0.01 m
    expect(h.blocks.moverState('lift-000001')).toEqual({ speed: 1.2, active: true });
    h.step(['lever']);
    const held = h.x();
    steps(h, 20);
    expect(h.x()).toBe(held);
    expect(h.blocks.moverState('lift-000001')?.active).toBe(false);
    h.step(['go']);
    steps(h, 10);
    expect(h.x()).toBeGreaterThan(held);
    h.step(['halt']);
    const stopped = h.x();
    steps(h, 10);
    expect(h.x()).toBe(stopped);
  });

  it('startOn still waits for its signal first; a new run holds it again as authored', () => {
    const h = blocksWith({ waypoints: [[10, 0, 0]], speed: 1.2, mode: 'once', startOn: 'go', toggleOn: 'lever' });
    steps(h, 5);
    expect(h.x()).toBe(0);
    h.step(['lever']); // a toggle of a waiting mover starts it
    steps(h, 5);
    expect(h.x()).toBeGreaterThan(0);
    h.blocks.resetRun();
    steps(h, 5);
    expect(h.x()).toBe(0);
  });

  it('reverseOn turns it around: mid-way back to the start, and a finished once-mover travels back', () => {
    const h = blocksWith({ waypoints: [[1.2, 0, 0]], speed: 1.2, mode: 'once', reverseOn: 'back' });
    steps(h, 60);
    expect(h.x()).toBeCloseTo(0.6, 9);
    h.step(['back']);
    // The step that reads the signal already moves back.
    expect(h.x()).toBeCloseTo(0.59, 9);
    steps(h, 100);
    expect(h.x()).toBeCloseTo(0, 9);
    h.step(['back']);
    steps(h, 200);
    expect(h.x()).toBeCloseTo(1.2, 9);
    h.step(['back']);
    steps(h, 200);
    expect(h.x()).toBeCloseTo(0, 9);
  });

  it('a reversed loop goes round the other way', () => {
    // A 1 m square at 1.2 m/s (0.01 m a step): reversed at once it walks the last side (from [0, 1]) backwards.
    const h = blocksWith({ waypoints: [[1, 0, 0], [1, 1, 0], [0, 1, 0]], speed: 1.2, mode: 'loop', reverseOn: 'back' });
    h.step(['back']);
    expect(h.x()).toBeCloseTo(0, 9);
    expect(h.y()).toBeCloseTo(0.01, 9);
    steps(h, 150);
    // 1.51 m backwards: up the left side and half-way along the top from [0, 1] toward [1, 1].
    expect(h.x()).toBeCloseTo(0.51, 9);
    expect(h.y()).toBeCloseTo(1, 9);
  });
});

describe('gravity easing', () => {
  it('leaves each point from rest at a constant acceleration and arrives when a constant speed would', () => {
    // 1.2 m at 1.2 m/s: one second (120 steps); the distance is 1.2 (t)^2.
    const h = blocksWith({ waypoints: [[1.2, 0, 0]], speed: 1.2, mode: 'pingpong', easing: 'gravity' });
    const xs: number[] = [0];
    for (let i = 0; i < 120; i++) {
      h.step();
      xs.push(h.x());
    }
    for (const k of [30, 60, 90, 120]) expect(xs[k]).toBeCloseTo(1.2 * (k / 120) ** 2, 9);
    // Constant acceleration: the second difference is the same everywhere (2 × 1.2 m / (1 s)² × dt²).
    const acc = xs[2]! - 2 * xs[1]! + xs[0]!;
    for (let k = 1; k < 119; k++) expect(xs[k + 1]! - 2 * xs[k]! + xs[k - 1]!).toBeCloseTo(acc, 9);
    expect(acc).toBeCloseTo(2.4 / HZ / HZ, 12);
    // Back from the far end: from rest again (the first step back is the smallest).
    h.step();
    const first = 1.2 - h.x();
    h.step();
    const second = 1.2 - h.x() - first;
    expect(first).toBeGreaterThan(0);
    expect(second).toBeCloseTo(3 * first, 9);
  });

  it('a reverse part-way keeps the position (no jump) and heads back', () => {
    const h = blocksWith({ waypoints: [[1.2, 0, 0]], speed: 1.2, mode: 'once', easing: 'gravity', reverseOn: 'back' });
    steps(h, 60);
    const at = h.x();
    expect(at).toBeCloseTo(0.3, 9);
    h.step(['back']);
    expect(h.x()).toBeLessThan(at);
    expect(at - h.x()).toBeLessThan(0.02);
    steps(h, 200);
    expect(h.x()).toBeCloseTo(0, 9);
  });
});
