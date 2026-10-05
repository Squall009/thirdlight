import { describe, expect, it } from 'vitest';

import { displayControlOf, FramePacer, frameRateCapFromUrl } from './frame-pacing';

/** A seeded jitter in [-1, 1) (the same run every time). */
function jitter(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 2 ** 32) * 2 - 1;
  };
}

/**
 * Drive a pacer with a display of `hz` for `seconds` (callback times with up
 * to `jitterMs` of vsync jitter either way); returns the drawn times.
 */
function run(pacer: FramePacer, hz: number, seconds: number, jitterMs = 0, seed = 7): number[] {
  const rnd = jitter(seed);
  const drawn: number[] = [];
  const period = 1000 / hz;
  // A second before the counted run: the pacer learns the display's rate (every frame draws meanwhile).
  for (let i = 0; i * period < (seconds + 1) * 1000; i += 1) {
    const t = clock + i * period + rnd() * jitterMs;
    if (pacer.frame(t) && i * period >= 1000) drawn.push(t);
  }
  clock += (seconds + 1) * 1000 + 1000;
  return drawn;
}
let clock = 1000;

const gaps = (ts: number[]): number[] => ts.slice(1).map((t, i) => t - ts[i]!);

describe('frame pacing', () => {
  it('draws every frame without a cap', () => {
    const p = new FramePacer();
    expect(run(p, 144, 2).length).toBe(288);
    // The second before the counted two draws too.
    expect(p.stats()).toMatchObject({ frameRateCap: null, skippedFrames: 0, drawnFrames: 432 });
  });

  it('a 60 Hz display at a 60 cap keeps every frame through vsync jitter and clock drift', () => {
    // ±2 ms of jitter, and displays a little off 60 Hz (an exact grid would slip a refresh now and then).
    for (const hz of [60, 59.94, 60.05, 61]) {
      const p = new FramePacer(60);
      run(p, hz, 10, 2);
      expect(p.stats().skippedFrames, `${hz} Hz`).toBe(0);
    }
  });

  it('a 60 Hz display at a 30 cap draws every other frame, jitter or not', () => {
    const p = new FramePacer(30);
    const drawn = run(p, 60, 10, 2);
    // 600 refreshes → 300 draws, each two refreshes apart (never one or three).
    expect(drawn.length).toBe(300);
    for (const g of gaps(drawn)) {
      expect(g).toBeGreaterThan(2 * 16.667 - 7);
      expect(g).toBeLessThan(2 * 16.667 + 7);
    }
  });

  it('a 144 Hz display at a 60 cap draws 60 a second, alternating two and three refreshes', () => {
    const p = new FramePacer(60);
    const drawn = run(p, 144, 10, 0.5);
    expect(drawn.length).toBeGreaterThanOrEqual(599);
    expect(drawn.length).toBeLessThanOrEqual(601);
    const refreshes = gaps(drawn).map((g) => Math.round(g / (1000 / 144)));
    expect(new Set(refreshes)).toEqual(new Set([2, 3]));
    // Never two long or two short gaps more than twice in a row (12 refreshes per 5 frames: 3,2,3,2,2).
    expect(refreshes.join('')).not.toMatch(/333|2222/);
  });

  it('a 120 Hz display at a 30 cap draws every fourth refresh; 240 Hz at 120 every other', () => {
    const p30 = new FramePacer(30);
    const d30 = run(p30, 120, 5, 1);
    expect(d30.length).toBe(150);
    expect(new Set(gaps(d30).map((g) => Math.round(g / (1000 / 120))))).toEqual(new Set([4]));
    const p120 = new FramePacer(120);
    const d120 = run(p120, 240, 5, 0.5);
    expect(d120.length).toBe(600);
  });

  it('a cap above the display rate draws every frame (a 60 Hz display at 120)', () => {
    const p = new FramePacer(120);
    expect(run(p, 60, 5, 2).length).toBe(300);
  });

  it('an uncapped browser (1000 callbacks a second) draws the cap', () => {
    for (const cap of [30, 60, 120] as const) {
      const p = new FramePacer(cap);
      const n = run(p, 1000, 5, 0.1).length;
      expect(n, `cap ${cap}`).toBeGreaterThanOrEqual(cap * 5 - 1);
      expect(n, `cap ${cap}`).toBeLessThanOrEqual(cap * 5 + 1);
    }
  });

  it('after a hitch the grid starts again (no burst of catch-up draws)', () => {
    const p = new FramePacer(30);
    const drawn: number[] = [];
    // A second at 60 Hz, a 200 ms stall, then a second more.
    for (let i = 0; i < 120; i += 1) {
      const t = 1000 + i * (1000 / 60) + (i >= 60 ? 200 : 0);
      if (p.frame(t) && i >= 60) drawn.push(t);
    }
    expect(drawn.length).toBe(30);
    for (const g of gaps(drawn)) expect(g).toBeGreaterThan(30);
  });

  it('the cap changes live; a pinned cap wins over the game; only caps are taken', () => {
    const p = new FramePacer(null);
    expect(run(p, 240, 1).length).toBe(240);
    expect(p.setCap(60)).toBe(true);
    expect(run(p, 240, 1).length).toBe(60);
    expect(p.setCap(45)).toBe(false);
    expect(p.setCap('none')).toBe(true);
    expect(p.frameRateCap).toBeNull();
    expect(p.setCap(30)).toBe(true);
    expect(p.pinCap(null)).toBe(true);
    expect(p.pacingCap).toBeNull();
    expect(p.frameRateCap).toBe(30);
    const pinned = run(p, 240, 1).length;
    expect(pinned).toBe(240);
    expect(p.stats()).toMatchObject({ frameRateCap: 30, pinned: 'none' });
    expect(p.pinCap(undefined)).toBe(true);
    expect(p.stats().pinned).toBeUndefined();
  });

  it('the frame before a draw is told so (the worker tick goes there)', () => {
    const p = new FramePacer(30);
    const period = 1000 / 120;
    const before: boolean[] = [];
    let last = false;
    for (let i = 0; i < 240; i += 1) {
      const t = 1000 + i * period;
      const draws = p.frame(t);
      if (draws && i > 20) before.push(last);
      last = p.drawsNext(t);
    }
    // Every draw after the display rate is known came right after a frame that expected it.
    expect(before.length).toBeGreaterThan(50);
    expect(before.every((b) => b)).toBe(true);
    // ...and only about one frame in four sends one.
    let sends = 0;
    for (let i = 240; i < 480; i += 1) {
      const t = 1000 + i * period;
      p.frame(t);
      if (p.drawsNext(t)) sends += 1;
    }
    expect(sends).toBe(60);
  });

  it('ctx.display reads and sets the cap; the URL flag pins one', () => {
    const p = new FramePacer(60);
    const d = displayControlOf(p);
    expect(d.frameRateCap).toBe(60);
    expect(d.setFrameRateCap(null)).toBe(true);
    expect(d.frameRateCap).toBeNull();
    expect(d.setFrameRateCap(144)).toBe(false);
    expect(d.frameRateCap).toBeNull();
    expect(frameRateCapFromUrl('?project=p&frameRateCap=none')).toBeNull();
    expect(frameRateCapFromUrl('?frameRateCap=30&renderer=webgl2')).toBe(30);
    expect(frameRateCapFromUrl('?frameRateCap=45')).toBeUndefined();
    expect(frameRateCapFromUrl('?project=p')).toBeUndefined();
  });
});
