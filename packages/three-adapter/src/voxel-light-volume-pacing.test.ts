import { describe, expect, it } from 'vitest';
import { FRAME_BUDGET_BY_TIER, gpuPassBudgetMs } from '@thirdlight/project-model';

import { VolumePacing } from './voxel-light-volume-pacing';

/** A small deterministic generator (the readings' noise). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Frames of a modelled GPU: a brick costs `perBrick` ms and every dispatch `fixed` ms more (the wait for the pool to be
 * readable); a reading is that times a noise of ±`noise`, and every `stallEvery`-th reading holds `stallMs` of the
 * frame before it. Returns the bricks a frame and the modelled cost of each frame.
 */
function run(opts: { budget: number; perBrick: number; fixed: number; noise: number; stallEvery: number; stallMs: number; frames: number; read?: (cost: number) => number }): { bricks: number[]; cost: number[] } {
  const pacing = new VolumePacing(32);
  const r = rng(7);
  const bricks: number[] = [];
  const cost: number[] = [];
  for (let f = 0; f < opts.frames; f++) {
    const n = pacing.bricks(opts.budget);
    const c = n * opts.perBrick + opts.fixed;
    bricks.push(n);
    cost.push(c);
    // One reading in flight: every other frame is timed.
    if (f % 2 === 0) {
      let ms = (opts.read ?? ((x: number) => x))(c) * (1 + (r() * 2 - 1) * opts.noise);
      if (opts.stallEvery > 0 && f % opts.stallEvery === 0) ms += opts.stallMs;
      pacing.read(n, ms);
    }
  }
  return { bricks, cost };
}

const mean = (v: readonly number[]): number => v.reduce((a, b) => a + b, 0) / v.length;

describe('the light volume update pacing', () => {
  const budget = gpuPassBudgetMs(FRAME_BUDGET_BY_TIER.low, 'lighting');

  it('takes the live light share of the low tier lighting row, the shadow maps share left out', () => {
    expect(budget).toBeCloseTo(6.0, 2);
  });

  it('settles the bricks a frame so that the modelled cost of a frame sits at the budget', () => {
    for (const perBrick of [0.021, 0.03, 0.07, 0.24]) {
      const { bricks, cost } = run({ budget, perBrick, fixed: 0.4, noise: 0.15, stallEvery: 0, stallMs: 0, frames: 400 });
      const late = cost.slice(200);
      // Within 5 % of the budget over the later frames, never past it by more than the noise.
      expect(Math.abs(mean(late) / budget - 1)).toBeLessThan(0.05);
      expect(Math.max(...late) / budget).toBeLessThan(1.25);
      expect(bricks[0]).toBe(32);
      expect(bricks[399]!).toBeGreaterThan(0);
    }
  });

  it('is not cut down by stalled readings (a reading holding the frame before it)', () => {
    const plain = run({ budget, perBrick: 0.03, fixed: 0.4, noise: 0.1, stallEvery: 0, stallMs: 0, frames: 400 });
    const stalled = run({ budget, perBrick: 0.03, fixed: 0.4, noise: 0.1, stallEvery: 4, stallMs: 6.5, frames: 400 });
    const p = mean(plain.bricks.slice(200));
    const s = mean(stalled.bricks.slice(200));
    // Half the readings hold a whole frame's wait: the bricks a frame stay within a tenth of the unstalled ones.
    expect(Math.abs(s / p - 1)).toBeLessThan(0.1);
  });

  it('follows a cost that really rose (more lamps in reach) within a second of frames', () => {
    const pacing = new VolumePacing(32);
    let perBrick = 0.03;
    const bricks: number[] = [];
    for (let f = 0; f < 300; f++) {
      if (f === 150) perBrick = 0.09;
      const n = pacing.bricks(budget);
      bricks.push(n);
      if (f % 2 === 0) pacing.read(n, n * perBrick);
    }
    expect(bricks[149]! / bricks[299]!).toBeGreaterThan(2.8);
    // 30 frames (a second at the low tier's cap) after the rise the cost is within a tenth of the budget.
    expect(Math.abs((bricks[180]! * 0.09) / budget - 1)).toBeLessThan(0.1);
    // Each reading high: the second is taken (the bricks a frame fall from the fifth frame after the rise).
    expect(bricks[155]!).toBeLessThan(bricks[149]!);
  });

  it('runs over by the factor its reading falls short: why the reading must hold the whole cost', () => {
    // A reading of the dispatch alone, 1.5 × short of what the frame pays: the frame's cost settles at 1.5 × the budget.
    const short = run({ budget, perBrick: 0.03, fixed: 0, noise: 0.05, stallEvery: 0, stallMs: 0, frames: 400, read: (c) => c / 1.5 });
    expect(mean(short.cost.slice(200)) / budget).toBeGreaterThan(1.4);
  });
});
