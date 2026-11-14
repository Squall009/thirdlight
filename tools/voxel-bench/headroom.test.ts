import { describe, expect, it } from 'vitest';

import { CAP_MS, FarSettle, frameCap, frameWindow, misses, searchLimit, spread, type FrameWindow } from './headroom';

/**
 * A GPU at a 60 Hz cap: a frame of `work` ms within the budget shows one
 * vsync; past it the frames show for one or two vsyncs so that they average
 * `work` (the browser drops a frame now and then), and past two vsyncs the
 * GPU sets the interval with a little jitter. `hiccups`: missed frames of a
 * host's noise in a window that holds the cap.
 */
function capped(work: number, frames = 180, hiccups = 0): FrameWindow {
  const iv: number[] = [];
  let owed = 0;
  for (let i = 0; i < frames; i++) {
    const jitter = ((i * 7919) % 13) / 13 - 0.5;
    if (work <= CAP_MS) iv.push(CAP_MS + jitter * 0.2 + (hiccups > 0 && i % Math.floor(frames / hiccups) === 0 ? CAP_MS : 0));
    else if (work <= 2 * CAP_MS) {
      owed += (work - CAP_MS) / CAP_MS;
      if (owed >= 1) {
        owed -= 1;
        iv.push(2 * CAP_MS);
      } else iv.push(CAP_MS);
    } else iv.push(work + jitter);
  }
  return frameWindow(iv);
}

describe('the headroom meter’s arithmetic', () => {
  it('reads a window: missed frames over 25 ms, stalls over 100 ms, mean and quantiles', () => {
    const w = frameWindow([16.7, 16.7, 33.4, 16.6, 130, 16.7]);
    expect(w).toMatchObject({ frames: 6, missed: 2, stalls: 1, max: 130 });
    expect(w.meanMs).toBeCloseTo(38.35, 1);
    expect(misses(w)).toBe(true);
    // Two missed frames in 180 (1.1 %) hold the cap; four (2.2 %) miss it.
    expect(misses(capped(10, 180, 2))).toBe(false);
    expect(misses(capped(10, 180, 4))).toBe(true);
    expect(misses(capped(17.2))).toBe(true);
  });

  it('finds the load at which the frames start to miss within its precision, in few windows', async () => {
    // A frame of 6.2 ms GPU and a unit of 0.37 ms: the frames miss once the work is 2 % over the budget.
    const unit = 0.37;
    const base = 6.2;
    const edge = Math.floor((CAP_MS * 1.02 - base) / unit);
    const seen: number[] = [];
    const r = await searchLimit(async (n) => (seen.push(n), capped(base + n * unit)), { max: 4096, precision: 0.1 });
    expect(r.held).toBeLessThanOrEqual(edge);
    expect(r.missedAt).not.toBeNull();
    expect(r.missedAt!).toBeGreaterThan(edge);
    expect(r.missedAt! - r.held).toBeLessThanOrEqual(Math.max(1, Math.round(r.held * 0.1)));
    expect(edge - r.held).toBeLessThanOrEqual(Math.max(1, Math.round(edge * 0.1)));
    // No load, doubling to 32, then a few halvings.
    expect(seen.slice(0, 7)).toEqual([0, 1, 2, 4, 8, 16, 32]);
    expect(seen.length).toBeLessThanOrEqual(11);
    expect(r.probes.map((p) => p.n)).toEqual(seen);
  });

  it('says when even no load misses, and when the maximum load still holds', async () => {
    const over = await searchLimit(async (n) => capped(26 + n), { max: 64 });
    expect(over).toMatchObject({ held: -1, missedAt: 0 });
    expect(over.probes).toHaveLength(1);
    const room = await searchLimit(async (n) => capped(2 + n * 0.001), { max: 64 });
    expect(room).toMatchObject({ held: 64, missedAt: null });
  });

  it('gives the spread of repeated values', () => {
    expect(spread([3.1, 2.9, Number.NaN, 3.4])).toEqual({ min: 2.9, max: 3.4, range: 0.5 });
    expect(spread([])).toBeNull();
  });

  it('measures against a 30 Hz cap: a frame of two vsyncs holds it, three miss it', () => {
    const cap = frameCap(30);
    expect(cap.budgetMs).toBeCloseTo(33.333, 3);
    expect(cap.missMs).toBeCloseTo(41.667, 3);
    expect(frameCap(60).missMs).toBeCloseTo(25, 9);
    // 30 Hz pacing on a 60 Hz display: every drawn frame two vsyncs apart, with jitter.
    const held = frameWindow(Array.from({ length: 90 }, (_, i) => 33.3 + (i % 3) * 0.1), cap);
    expect([held.missed, misses(held, cap), misses(held)]).toEqual([0, false, true]);
    // A frame that took three vsyncs (50 ms) missed the 30 cap; four in 90 miss the window.
    const late = frameWindow(Array.from({ length: 90 }, (_, i) => (i % 22 === 0 ? 50 : 33.3)), cap);
    expect([late.missed, misses(late, cap)]).toEqual([5, true]);
  });
});

describe('the far field\'s fill', () => {
  it('ends once what is drawn stays within 2 % for the hold, a larger move starting it again', () => {
    const f = new FarSettle(5000);
    expect(f.step({ nodes: 0, bricks: 0 }, 0)).toBe(false);
    expect(f.step({ nodes: 1000, bricks: 20000 }, 1000)).toBe(false);
    // A few nodes come and go as a camera turns: still the same field.
    expect(f.step({ nodes: 1010, bricks: 20100 }, 4000)).toBe(false);
    expect(f.step({ nodes: 995, bricks: 19900 }, 6500)).toBe(true);
    expect(f.since).toBe(1000);
    // A move past 2 %: counted again from there.
    expect(f.step({ nodes: 1100, bricks: 20000 }, 7000)).toBe(false);
    expect(f.since).toBe(7000);
    expect(f.step({ nodes: 1100, bricks: 20000 }, 12500)).toBe(true);
  });
});
