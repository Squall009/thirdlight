/**
 * The travel measures' arithmetic (travel.ts) on recorded-shaped sequences: when counts settle after a stop, a
 * dropped body's outcomes (landed, suspended, fallen through), the long gaps between frames and what took them,
 * the flight's frame measures and the bottom rows' dark share. Counts and ratios only: no clock is read.
 */
import { describe, expect, it } from 'vitest';
import { frameCap } from './headroom';
import { bottomDarkShare, dropOutcomes, FALL_THROUGH_M, firstAfter, flightFrames, longGaps, settleAfter, spikeCause, spikeCauses, type BodySample, type CountSample, type LongFrame } from './travel';

/** Samples every 0.1 s from `from` to `to` seconds with the counts `v(t)`. */
const series = (from: number, to: number, v: (t: number) => number[]): CountSample[] => Array.from({ length: Math.round((to - from) * 10) + 1 }, (_, i) => ({ t: from + i / 10, v: v(from + i / 10) }));

describe('settling after the stop', () => {
  it('is the first sample from which every later one stays within the stillness of the last values', () => {
    // Level-0 chunks fill in for 1.5 s after the stop, pieces until 2.0 s, then hold for 10 s.
    const s = series(-2, 12, (t) => [t < 0 ? 40 : Math.min(120, 40 + Math.floor(t * 60)), t < 2 ? Math.floor(Math.max(0, t) * 300) : 600]);
    expect(settleAfter(s, 0, { share: 0, abs: 0 }, 3)).toBeCloseTo(2, 5);
    // A count churning by one either way (visibility feedback) still settles within its stillness.
    const churn = series(0, 12, (t) => [t < 4 ? Math.floor(t * 100) : 400 + (Math.round(t * 10) % 2)]);
    expect(settleAfter(churn, 0, { share: 0, abs: 0 }, 3)).toBeNull();
    expect(settleAfter(churn, 0, { share: 0.01, abs: 2 }, 3)).toBeCloseTo(4, 5);
    // Per-count stillness: the second (far) count may move 2 %.
    const far = series(0, 10, (t) => [100, t < 1 ? 50 : 1000 + (Math.round(t * 10) % 3) * 5]);
    expect(settleAfter(far, 0, [{ share: 0, abs: 0 }, { share: 0.02, abs: 0 }], 3)).toBeCloseTo(1, 5);
  });

  it('is null while the counts have not held still for the hold, or with nothing after the stop', () => {
    const late = series(0, 5, (t) => [t < 3 ? Math.floor(t * 10) : 30]);
    expect(settleAfter(late, 0, { share: 0, abs: 0 }, 3)).toBeNull();
    expect(settleAfter(late, 0, { share: 0, abs: 0 }, 2)).toBeCloseTo(3, 5);
    expect(settleAfter(series(-3, -1, () => [1]), 0, { share: 0, abs: 0 }, 1)).toBeNull();
    // Already still at the stop: settled at once.
    expect(settleAfter(series(-1, 6, () => [7, 8]), 0, { share: 0, abs: 0 }, 3)).toBe(0);
  });

  it('finds the first sample after the stop that holds', () => {
    const s = [{ t: -1, ok: true }, { t: 0.2, ok: false }, { t: 0.7, ok: true }, { t: 1.1, ok: true }];
    expect(firstAfter(s, 0, (x) => x.ok)).toBeCloseTo(0.7, 5);
    expect(firstAfter(s, 2, (x) => x.ok)).toBeNull();
  });
});

describe('the dropped body', () => {
  /** A drop's readings every 0.1 s for 2 s: suspended for `wait` s, then falling from 2.5 m over the ground onto `floor` (none: no collider holds it). */
  const drop = (n: number, t0: number, wait: number, floor: number | null, ground = 100): BodySample[] =>
    Array.from({ length: 20 }, (_, i) => {
      const t = i / 10;
      const falling = Math.max(0, t - wait);
      const free = ground + 2.5 + 0.9 - 4.905 * falling * falling;
      const y = t < wait ? ground + 3.4 : floor === null ? free : Math.max(floor + 0.9, free);
      return { t: t0 + t, drop: n, groundY: ground, y, grounded: t >= wait && floor !== null && y <= floor + 0.9 + 1e-9, suspended: t < wait };
    });

  it('counts the drops that landed, stayed suspended and fell through, and where', () => {
    const samples = [...drop(1, 0, 0, 100), ...drop(2, 2, 2.5, 100), ...drop(3, 4, 0.5, null), ...drop(4, 6, 0.3, 99.2)];
    const o = dropOutcomes(samples);
    // A drop standing on a coarse floor at its end counts as on the floor.
    expect(dropOutcomes(drop(1, 0, 0, 100).map((s) => ({ ...s, onFloor: true }))).end).toEqual({ suspended: 0, onFloor: 1, onFine: 0 });
    expect(o.drops).toBe(4);
    expect(o.landed).toBe(2);
    expect(o.suspendedOnly).toBe(1);
    expect(o.fellThrough).toBe(1);
    // At their last readings: the second still suspended, the third falling, the others standing on fine collision.
    expect(o.end).toEqual({ suspended: 1, onFloor: 0, onFine: 2 });
    expect(o.events[0]!.drop).toBe(3);
    expect(o.events[0]!.y).toBeLessThan(100 - FALL_THROUGH_M);
  });

  it('does not call a body standing low on a slope, or one still suspended deep, a fall-through', () => {
    // The 2 m cells put the ground 3 m high: the body stands 3 m under the estimate, grounded.
    const low = drop(1, 0, 0, 97);
    expect(dropOutcomes(low).fellThrough).toBe(0);
    // Readings with the body suspended never count, wherever it hangs.
    const hung: BodySample[] = [{ t: 0, drop: 1, groundY: 100, y: 50, grounded: false, suspended: true }];
    expect(dropOutcomes(hung)).toMatchObject({ drops: 1, suspendedOnly: 1, fellThrough: 0 });
    // A body that landed and then lost its floor (a collider swapped out) counts as both.
    const swapped: BodySample[] = [...drop(1, 0, 0, 100).slice(0, 12), { t: 1.5, drop: 1, groundY: 100, y: 92, grounded: false, suspended: false }];
    expect(dropOutcomes(swapped)).toMatchObject({ landed: 1, fellThrough: 1 });
    // Readings before the first drop are not a drop.
    expect(dropOutcomes([{ t: 0, drop: 0, groundY: 0, y: -50, grounded: false, suspended: false }]).drops).toBe(0);
  });
});

describe('long frames in flight', () => {
  const frames = (times: number[], chunks: number[]) => times.map((t, i) => ({ t, counts: { chunks: chunks[i]!, applied: i } }));
  const lf = (t: number, ms: number, renderMs: number, scripts: Array<[string, number]>): LongFrame => ({ t, ms, renderMs, blockingMs: ms - 50, scripts: scripts.map(([invoker, s]) => ({ invoker, fn: '', ms: s })) });

  it('finds the gaps over 100 ms, the long frame over each, and what the draws changed across it', () => {
    const f = frames([0, 33, 66, 230, 263, 296, 450, 483], [10, 10, 10, 40, 40, 40, 40, 41]);
    const long = [lf(70, 150, 20, [['Worker.onmessage', 120]]), lf(300, 140, 130, [['FrameRequestCallback', 20]])];
    const gaps = longGaps(f, long);
    expect(gaps.map((g) => g.ms)).toEqual([164, 154]);
    expect(gaps[0]!.frame?.scripts[0]!.invoker).toBe('Worker.onmessage');
    expect(gaps[0]!.delta).toEqual({ chunks: 30, applied: 1 });
    expect(gaps[1]!.delta).toEqual({ applied: 1 });
    expect(gaps[1]!.frame?.ms).toBe(140);
    // A gap with no long frame on the page's thread is the GPU's or another process's.
    expect(longGaps(frames([0, 200], [1, 1]), [])[0]!.frame).toBeNull();
  });

  it('names a long frame by the script that took most of it, else render or other', () => {
    expect(spikeCause(lf(0, 150, 20, [['Worker.onmessage', 120], ['FrameRequestCallback', 10]]))).toBe('Worker.onmessage');
    expect(spikeCause(lf(0, 150, 130, [['FrameRequestCallback', 20]]))).toBe('render');
    expect(spikeCause(lf(0, 150, 10, [['TimerHandler', 20]]))).toBe('other');
    expect(spikeCause(null)).toBe('off-thread');
    const groups = spikeCauses([
      { t: 0, ms: 150, frame: lf(0, 150, 20, [['Worker.onmessage', 120]]), delta: { chunks: 30 } },
      { t: 1, ms: 130, frame: lf(1, 130, 20, [['Worker.onmessage', 100]]), delta: { chunks: 10 } },
      { t: 2, ms: 120, frame: null, delta: {} },
    ]);
    expect(groups.map((g) => [g.cause, g.gaps, g.ms])).toEqual([['Worker.onmessage', 2, 280], ['off-thread', 1, 120]]);
    expect(groups[0]!.meanDelta).toEqual({ chunks: 20 });
  });

  it('gives the longest frame, those over 100 ms and missed frames a minute at the cap', () => {
    // 30 Hz: 600 frames over 20 s, 6 missed (over 41.7 ms), two of them over 100 ms.
    const intervals = [...Array.from({ length: 594 }, () => 33.3), 50, 50, 60, 70, 120, 173];
    const f = flightFrames(intervals, frameCap(30), 20);
    expect(f).toMatchObject({ frames: 600, longestMs: 173, over100: 2, missed: 6, missedPerMin: 18 });
  });
});

describe('the bottom rows\' dark share', () => {
  it('counts near-black pixels in the bottom rows only', () => {
    // 10 × 10: the bottom two rows half black, a black row above them not counted.
    const px = (x: number, y: number): number[] => (y >= 8 && x < 5) || y === 7 ? [5, 8, 4] : [90, 140, 60];
    expect(bottomDarkShare(10, 10, px, 2)).toBeCloseTo(0.5, 9);
    expect(bottomDarkShare(10, 10, px, 3)).toBeCloseTo(20 / 30, 9);
    expect(bottomDarkShare(10, 10, () => [200, 200, 200], 2)).toBe(0);
  });
});
