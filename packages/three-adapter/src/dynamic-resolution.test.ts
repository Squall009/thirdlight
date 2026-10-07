import { describe, expect, it } from 'vitest';

import { frameTargetMs } from '@thirdlight/runtime';

import { DRS_HOLD_MS, DRS_UP_WINDOWS, DRS_WINDOW_MS, DynamicResolution, slowFramesFromUrl } from './dynamic-resolution';

const BUDGET = 1000 / 60;

/** Frames 16 ms apart for `ms`, each with `gpu(scale)` ms of GPU time (null: not measured). */
function run(d: DynamicResolution, from: number, ms: number, gpu: ((scale: number) => number) | null, extra: { interval?: number; cpu?: number; budget?: number } = {}): { now: number; scales: number[] } {
  const scales: number[] = [];
  let now = from;
  const interval = extra.interval ?? 16;
  for (; now < from + ms; now += interval) {
    const s = d.frame({ now, gpuMs: gpu === null ? null : gpu(d.current()), measuresGpu: gpu !== null, intervalMs: interval, cpuMs: extra.cpu ?? 2, budgetMs: extra.budget ?? BUDGET });
    if (scales.at(-1) !== s) scales.push(s);
  }
  return { now, scales };
}

/** A GPU whose time grows with the pixels: `full` ms at scale 1. */
const pixels = (full: number) => (s: number) => full * s * s;

describe('dynamic resolution', () => {
  it('steps down while the GPU runs over budget, to a scale that fits, and stays there', () => {
    const d = new DynamicResolution(0.5, 1);
    // 24 ms at full resolution: over a 16.7 ms budget; the scale aims at 80 % of it.
    const { scales } = run(d, 0, 5000, pixels(24));
    expect(scales[0]).toBe(1);
    const settled = scales.at(-1)!;
    expect(settled).toBeLessThan(1);
    expect(24 * settled * settled).toBeLessThan(BUDGET * 0.9);
    // At most two changes (a first step, maybe a correction), never back up and down.
    expect(scales.length).toBeLessThanOrEqual(3);
    expect(d.state()).toMatchObject({ source: 'gpu', stepsUp: 0 });
  });

  it('steps back up when the GPU has room, and not past the most', () => {
    const d = new DynamicResolution(0.5, 0.9);
    const slow = run(d, 0, 3000, pixels(40));
    expect(d.current()).toBeLessThan(0.6);
    // Now light: room at the higher scale; up in a few steps of at most 0.25 each, ending at 0.9.
    const light = run(d, slow.now, 8000, pixels(4));
    expect(light.scales.at(-1)).toBe(0.9);
    for (let i = 1; i < light.scales.length; i++) expect(light.scales[i]! - light.scales[i - 1]!).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it('does not thrash at the edge: an up step that does not hold doubles the wait for the next', () => {
    const d = new DynamicResolution(0.5, 1);
    // A load the pixel model mispredicts: cheap up to 0.8, over budget above (an effect that only fits at lower
    // resolutions). Every up step is predicted to fit and does not.
    const edge = (s: number) => (s > 0.8 ? 20 : 5);
    const { scales } = run(d, 0, 60_000, edge);
    // Changes per minute stay few (a window is 250 ms: thrashing would be a change every few windows).
    expect(scales.length).toBeLessThan(20);
    expect(d.state().upWait).toBeGreaterThan(DRS_UP_WINDOWS);
  });

  it('without GPU timing, budgeted from the pacing\'s frame time: a 30 cap or a 50 Hz display is not slow, and it recovers', () => {
    // A 30 cap (pinned by the page or the game's): frames 33 ms apart are on time.
    const capped = new DynamicResolution(0.5, 1);
    run(capped, 0, 5000, null, { interval: 33.3, cpu: 3, budget: frameTargetMs({ frameRateCap: 30, displayMs: 16.7 }) });
    expect(capped.current()).toBe(1);
    const pinned = new DynamicResolution(0.5, 1);
    run(pinned, 0, 5000, null, { interval: 33.3, cpu: 3, budget: frameTargetMs({ frameRateCap: null, pinned: 30, displayMs: 16.7 }) });
    expect(pinned.current()).toBe(1);
    // A 50 Hz display, uncapped or a cap of 60 or 120 above it.
    const slowDisplay = new DynamicResolution(0.5, 1);
    run(slowDisplay, 0, 5000, null, { interval: 20, cpu: 3, budget: frameTargetMs({ frameRateCap: 120, displayMs: 20 }) });
    expect(slowDisplay.current()).toBe(1);
    // Forced slow frames step it down; after them it comes back to the most.
    slowDisplay.stress(2000);
    const down = run(slowDisplay, 5000, 2500, null, { interval: 20, cpu: 3, budget: 20 });
    expect(Math.min(...down.scales)).toBeLessThan(1);
    run(slowDisplay, 7500, 30_000, null, { interval: 20, cpu: 3, budget: 20 });
    expect(slowDisplay.current()).toBe(1);
  });

  it('without GPU timing reads the frame interval, and leaves CPU-bound frames alone', () => {
    const gpuBound = new DynamicResolution(0.5, 1);
    run(gpuBound, 0, 2000, null, { interval: 33, cpu: 3 });
    expect(gpuBound.current()).toBeLessThan(1);
    expect(gpuBound.state().source).toBe('frame');
    const cpuBound = new DynamicResolution(0.5, 1);
    run(cpuBound, 0, 2000, null, { interval: 33, cpu: 30 });
    expect(cpuBound.current()).toBe(1);
  });

  it('a forced overload steps it down, and after it ends the scale comes back up', () => {
    const d = new DynamicResolution(0.5, 1);
    d.stress(3000);
    const forced = run(d, 1000, 3000, pixels(3));
    expect(d.current()).toBeLessThan(1);
    expect(forced.scales[0]).toBe(1);
    const after = run(d, forced.now, 6000, pixels(3));
    expect(after.scales.at(-1)).toBe(1);
    expect(d.state()).toMatchObject({ stressed: false });
    expect(d.state().stepsUp).toBeGreaterThan(0);
  });

  it('decides per window, never per frame', () => {
    const d = new DynamicResolution(0.5, 1);
    // One very slow frame among fast ones: no change.
    let now = 0;
    for (let i = 0; i < 200; i++, now += 16) d.frame({ now, gpuMs: i === 50 ? 200 : 3, measuresGpu: true, intervalMs: 16, cpuMs: 2, budgetMs: BUDGET });
    expect(d.current()).toBe(1);
    expect(DRS_WINDOW_MS).toBeGreaterThan(100);
    expect(DRS_HOLD_MS).toBeGreaterThan(DRS_WINDOW_MS * DRS_UP_WINDOWS);
  });

  it('reads the page flag', () => {
    expect(slowFramesFromUrl('?slowFrames=3')).toBe(3000);
    expect(slowFramesFromUrl('?renderer=webgl2')).toBe(0);
    expect(slowFramesFromUrl('?slowFrames=x')).toBe(0);
  });
});
