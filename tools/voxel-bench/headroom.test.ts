import { describe, expect, it } from 'vitest';

import { CAP_MS, fitLine, frameGpu, frameWindow, misses, passShare, saturated, searchLimit, spread, type FrameWindow } from './headroom';

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
    expect(saturated(capped(30))).toBe(true);
    expect(misses(capped(17.2))).toBe(true);
    expect(saturated(capped(10, 180, 4))).toBe(false);
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

  it('recovers the unit’s ms and the frame’s GPU ms from windows past the edge, and a copy’s ms from its own window', () => {
    const unit = 0.37;
    const base = 6.2;
    const pts = [60, 90, 120].map((n) => ({ n, ms: capped(base + n * unit).meanMs }));
    const line = fitLine(pts)!;
    expect(line.slope).toBeCloseTo(unit, 2);
    expect(line.intercept).toBeCloseTo(base, 0);
    expect(line.worstResidual).toBeLessThan(0.2);
    expect(fitLine([{ n: 5, ms: 20 }, { n: 5, ms: 21 }])).toBeNull();
    // The frame's GPU ms from the edge (26 units of room) and from the line agree.
    const g = frameGpu(line, 26, 27);
    expect(g.agree).toBe(true);
    expect(g.fromEdge![0]).toBeLessThan(base + 0.6);
    expect(frameGpu({ ...line, intercept: 17 }, 26, 27).agree).toBe(false);
    expect(frameGpu(line, -1, 0)).toMatchObject({ fromEdge: null, agree: false });
    // A pass of 2.5 ms, hidden or copied once more, past the edge at 90 units.
    const at = capped(base + 90 * unit).meanMs;
    const hidden = passShare('far', 'hidden', at, capped(base - 2.5 + 90 * unit), line.slope, 26);
    expect(hidden.ms).toBeCloseTo(2.5, 0);
    expect(hidden.units).toBeCloseTo(2.5 / unit, -1);
    expect(hidden.headroomX).toBeCloseTo(1 + (26 * unit) / 2.5, 0);
    expect(hidden.lowerBound).toBe(false);
    expect(passShare('near', 'copy', at, capped(base + 2.5 + 90 * unit), line.slope, 0)).toMatchObject({ headroomX: null, lowerBound: false });
    // Hidden, a 20 ms pass takes the frame under the cap: the share is only a lower bound.
    expect(passShare('post', 'hidden', at, capped(base - 20 + 90 * unit), line.slope, 26)).toMatchObject({ lowerBound: true });
    expect(spread([3.1, 2.9, Number.NaN, 3.4])).toEqual({ min: 2.9, max: 3.4, range: 0.5 });
    expect(spread([])).toBeNull();
  });
});
