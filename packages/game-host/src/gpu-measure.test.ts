import { describe, expect, it } from 'vitest';
import { FRAME_BUDGET_BY_TIER, type GpuPassCategory } from '@thirdlight/runtime';

import { budgetReadings, categoryReading, GpuMeasureRun, measureGpu, readingStats, resolutionOf, windowMean, type GpuMeasureTarget } from './gpu-measure';

/** A deterministic pseudo-random sequence (the same noise every run). */
function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32 - 0.5;
  };
}

/**
 * A GPU at a 30 Hz cap: a frame takes the passes shown plus the ballast, and
 * never less than the cap; its clock drifts (every frame a little slower as
 * the run goes on, as a warming GPU would) and each frame jitters.
 */
function fakeGpu(passes: Partial<Record<GpuPassCategory, number>>, o: { jitter?: number; drift?: number; failAt?: number } = {}) {
  const rand = noise(7);
  let ballast = 0;
  let hidden: readonly GpuPassCategory[] = [];
  let held = false;
  let windows = 0;
  let t = 0;
  const log: string[] = [];
  const target: GpuMeasureTarget & { log: string[]; state(): { ballast: number; hidden: readonly GpuPassCategory[]; held: boolean } } = {
    log,
    state: () => ({ ballast, hidden, held }),
    unavailable: () => null,
    present: () => Object.fromEntries(Object.keys(passes).map((c) => [c, [`${c} pass`]])),
    hide: (c) => void (hidden = c),
    ballast: (n) => void (ballast = n),
    ballastMax: 4096,
    hold: (on) => void (held = on),
    record: async (seconds) => {
      windows += 1;
      if (o.failAt !== undefined && windows >= o.failAt) throw new Error('lost the device');
      const out: number[] = [];
      for (let i = 0; i < Math.round(seconds * 30); i++) {
        t += 1;
        const work = 8 + Object.entries(passes).reduce((n, [c, ms]) => n + (hidden.includes(c as GpuPassCategory) ? 0 : ms!), 0) + ballast * 0.13;
        const clock = 1 + (o.drift ?? 0) * t;
        out.push(Math.max(1000 / 30, work * clock) + (o.jitter ?? 0.5) * rand());
      }
      log.push(`${ballast}:${hidden.join('+')}`);
      return out;
    },
  };
  return target;
}

const LOW = FRAME_BUDGET_BY_TIER.low;
const FAST = { windowS: 1, settleS: 0, repeats: 5 };

describe('the GPU measurement', () => {
  it('reads each category’s ms past the cap and holds them against the GPU budget rows', async () => {
    const gpu = fakeGpu({ near: 6, far: 3, lighting: 1, shadows: 0.02 }, { drift: 2e-5 });
    const m = await measureGpu(gpu, 1000 / 30, LOW, FAST);
    const by = Object.fromEntries(m.categories.map((c) => [c.category, c]));
    expect(by['near']!.ms).toBeCloseTo(6, 0);
    expect(by['far']!.ms).toBeCloseTo(3, 0);
    // A 1 ms pass is told from none, its spread well under it.
    expect(by['lighting']!.ms).not.toBeNull();
    expect(Math.abs(by['lighting']!.ms! - 1)).toBeLessThan(0.3);
    // A pass under the routine's resolution is no number.
    expect(by['shadows']).toMatchObject({ belowResolution: true, ms: null });
    expect(m.resolutionMs).toBeLessThan(0.5);
    expect([...m.absent].sort()).toEqual(['effects', 'post']);
    // Loaded past the cap (about 1.5 intervals) and the frame's own GPU ms from the line.
    expect(m.ballast.frameMs).toBeGreaterThan(45);
    expect(m.frameMs).toBeCloseTo(18, 0);
    // Lighting's row holds lighting and shadows: 20 % of low's 33.3 ms frame.
    const lighting = m.budget.rows.find((r) => r.budget === 'lighting')!;
    expect(lighting.budgetMs).toBeCloseTo(6.67, 2);
    expect(lighting.categories).toEqual(['shadows', 'lighting']);
    expect(lighting.ms).toBeCloseTo(by['lighting']!.ms!, 5);
    expect(m.budget.rows.find((r) => r.budget === 'render')!.ms).toBeCloseTo(by['near']!.ms! + by['far']!.ms!, 5);
    // Everything given back.
    expect(gpu.state()).toEqual({ ballast: 0, hidden: [], held: false });
    // Interleaved: every hidden window sits between two windows with everything shown.
    const timed = gpu.log.slice(gpu.log.findIndex((l) => l.startsWith(`${m.ballast.n}:`)));
    for (let i = 0; i < timed.length; i++) if (timed[i]!.includes(':') && timed[i]!.split(':')[1] !== '') expect([timed[i - 1], timed[i + 1]].map((l) => l!.split(':')[1])).toEqual(['', '']);
  });

  it('a drifting clock read in one pass before and one after would read a pass that is not there; interleaving does not', async () => {
    // No pass costs anything: every reading is drift and jitter.
    const gpu = fakeGpu({ near: 0, far: 0 }, { drift: 2e-4, jitter: 2 });
    const m = await measureGpu(gpu, 1000 / 30, LOW, FAST);
    for (const c of m.categories) expect(c).toMatchObject({ ms: null, belowResolution: true });
  });

  it('gives everything back when a window fails, and the run reports the failure', async () => {
    const gpu = fakeGpu({ near: 4 }, { failAt: 12 });
    await expect(measureGpu(gpu, 1000 / 30, LOW, FAST)).rejects.toThrow('lost the device');
    expect(gpu.state()).toEqual({ ballast: 0, hidden: [], held: false });
    const run = new GpuMeasureRun(() => ({ target: fakeGpu({ near: 4 }, { failAt: 3 }), intervalMs: 1000 / 30, budget: LOW }));
    expect(run.start(FAST).state).toBe('running');
    // A second start while one runs is the same run.
    expect(run.start(FAST).state).toBe('running');
    await expect.poll(() => run.state().state).toBe('failed');
    expect(new GpuMeasureRun(() => ({ target: null, intervalMs: 33, budget: LOW })).start()).toEqual({ state: 'unavailable', reason: 'no renderer on this page' });
  });
});

describe('the GPU measurement’s statistics', () => {
  it('median and interquartile spread; below resolution when the spread or the noise is not under the value; never a negative ms', () => {
    expect(readingStats([1, 2, 3, 4, 100])).toEqual({ medianMs: 3, spreadMs: 2 });
    expect(resolutionOf([0.1, -0.2, 0.05, 0.3, -0.1])).toBe(0.2);
    expect(resolutionOf([1.2, 1.1, 1.3, 1.25, 1.15])).toBe(1.2);
    expect(categoryReading('near', [], [2, 2.1, 1.9, 2.05, 2], 0.3)).toMatchObject({ ms: 2, belowResolution: false });
    // Spread over the value: no number.
    expect(categoryReading('far', [], [-1, 3, 0.5, 4, -2], 0.3)).toMatchObject({ ms: null, belowResolution: true });
    // A steady value under the noise: no number.
    expect(categoryReading('post', [], [0.2, 0.21, 0.19, 0.2, 0.2], 0.3)).toMatchObject({ ms: null, belowResolution: true });
    expect(categoryReading('post', [], [-0.9, -1, -1.1, -1, -0.95], 0.1)).toMatchObject({ ms: null, belowResolution: true });
  });

  it('a window’s mean is its span over its frames (a burst’s gap counts)', () => {
    expect(windowMean([50, 50, 50, 50, 400])).toBe(120);
    expect(windowMean([50, 50])).toBeNaN();
    // Past the cap two frames reach the page together every 128 ms: 64 ms a frame wherever the window starts.
    const pairs = Array.from({ length: 15 }, (_, i) => (i % 2 === 0 ? 0.2 : 127.8));
    expect(windowMean(pairs)).toBeCloseTo(64, 0);
    expect(windowMean(pairs.slice(1))).toBeCloseTo(64, 0);
    expect(windowMean(pairs.slice(0, 11))).toBeCloseTo(64, 0);
  });

  it('budget rows sum only readings above resolution', () => {
    const rows = budgetReadings(FRAME_BUDGET_BY_TIER.medium, [categoryReading('post', [], [1, 1, 1, 1, 1], 0.1), categoryReading('effects', [], [0, 0, 0, 0, 0], 0.1)]);
    expect(rows.find((r) => r.budget === 'other')).toMatchObject({ ms: 1, categories: ['post'] });
    expect(rows.find((r) => r.budget === 'effects')).toMatchObject({ ms: null });
    expect(rows.find((r) => r.budget === 'render')!.budgetMs).toBeCloseTo(0.55 * 1000 / 60, 2);
  });
});
