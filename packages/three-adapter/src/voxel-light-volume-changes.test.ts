import { describe, expect, it } from 'vitest';
import { frameSliceMs } from '@thirdlight/shared';

import { VolumeHistory, VolumePendingChanges } from './voxel-light-volume-changes';

/**
 * A batch's changes taken in the volume's slice of later frames: a stepping clock (each change costs `costMs` of it),
 * drained a frame at a time while the frame's time is under the slice. Returns the frames it took and every change
 * in the order taken.
 */
function sliced(n: number, costMs: number, slice: number): { frames: number; taken: string[]; perFrame: number[] } {
  const q = new VolumePendingChanges<number>();
  for (let i = 0; i < n; i++) q.add(`${i},0,0`, i);
  const taken: string[] = [];
  const perFrame: number[] = [];
  let clock = 0;
  let frames = 0;
  while (q.size > 0) {
    const t0 = clock;
    perFrame.push(q.drain(() => clock - t0 < slice, (key) => {
      taken.push(key);
      clock += costMs;
    }));
    frames++;
    clock += 33.3;
  }
  return { frames, taken, perFrame };
}

describe('the light volume changes taken in its frame slice', () => {
  const slice = frameSliceMs('surfacePrepare');

  it('spreads a batch of many blocks over frames, each frame within its slice but one change at least', () => {
    // A flight's start: the level-0 ring's blocks at once, 0.3 ms each.
    const { frames, taken, perFrame } = sliced(240, 0.3, slice);
    const each = Math.ceil(slice / 0.3);
    expect(frames).toBeGreaterThanOrEqual(Math.floor(240 / each));
    expect(Math.max(...perFrame)).toBe(each);
    expect(taken.length).toBe(240);
    // The same changes as taken all at once, in the order they came.
    expect(taken).toEqual(Array.from({ length: 240 }, (_, i) => `${i},0,0`));
    // A change dearer than the whole slice still moves one a frame.
    const slow = sliced(5, 3 * slice, slice);
    expect(slow.frames).toBe(5);
    expect(slow.perFrame.every((k) => k === 1)).toBe(true);
  });

  it('keeps the first state of a block changed again before it was looked at', () => {
    const q = new VolumePendingChanges<string>();
    q.add('1,2,3', 'before the first batch');
    q.add('1,2,3', 'between the batches');
    q.add('4,5,6', 'only');
    const got: Array<[string, string]> = [];
    q.drain(() => true, (k, v) => got.push([k, v]));
    expect(got).toEqual([['1,2,3', 'before the first batch'], ['4,5,6', 'only']]);
    expect(q.size).toBe(0);
  });
});

describe('the light volume history through a change of light', () => {
  const SETTLE = 8;
  const CONTINUE = 30;

  /**
   * One cell of a brick as the update blends it (the WGSL's `mix(old, estimate, 1 / (updates + 1))`, the estimate
   * alone from nothing), updated once a frame while stale, under the light `light(frame)` and the changes `changes`
   * (frames at which the light changed and the brick was marked). Returns the cell's light once it settled after the
   * last change, and the frames that took.
   */
  function model(light: (f: number) => number, changes: ReadonlySet<number>, frames: number): { value: number; settledAt: number | null } {
    const b = { updates: 0, samples: 0, target: SETTLE, value: 0 };
    let stale = true;
    const h = new VolumeHistory<typeof b>(SETTLE, CONTINUE, () => void (stale = true));
    let settledAt: number | null = null;
    for (let f = 0; f < frames; f++) {
      if (changes.has(f)) h.marked(b, h.change(f));
      h.frame(f);
      if (stale) {
        const est = light(f);
        b.value = b.updates === 0 ? est : b.value + (est - b.value) / (b.updates + 1);
        b.updates++;
        b.samples++;
        if (b.updates >= SETTLE) stale = false;
        settledAt = stale || h.waiting > 0 ? null : (settledAt ?? f);
      }
    }
    return { value: b.value, settledAt };
  }

  it('a lamp taken out: nothing of its light is left once the brick settles again', () => {
    // Lit (1) until frame 100, then out (0): one change.
    const r = model((f) => (f < 100 ? 1 : 0), new Set([100]), 200);
    expect(Math.abs(r.value)).toBeLessThan(0.01);
    expect(r.settledAt).toBe(100 + SETTLE - 1);
  });

  it('a light changing every frame for two seconds (a blend of looks): followed, and nothing of the old once it stops', () => {
    const changes = new Set(Array.from({ length: 60 }, (_, i) => 100 + i));
    const light = (f: number): number => (f < 100 ? 1 : f < 160 ? 1 - (f - 100) / 60 : 0);
    const r = model(light, changes, 400);
    expect(Math.abs(r.value)).toBeLessThan(0.01);
    // It starts again once the changes have stopped for `CONTINUE` frames, and settles from there.
    expect(r.settledAt).toBe(159 + CONTINUE + 1 + SETTLE - 1);
    // Meanwhile it follows: half its history kept a change, never from nothing.
    const mid = model(light, changes, 130);
    expect(mid.value).toBeGreaterThan(light(129));
    expect(mid.value).toBeLessThan(1);
  });
});

describe('the light volume past a changed lamp\'s reach', () => {
  const SETTLE = 8;
  const OUTER = 2;

  /**
   * Two bricks under a lamp switched off at frame 50: one in its reach (its light: the lamp's 1 and the rest's 0.2) and
   * one past it (its bounce: 0.3, the rest 0.2), each updated once a frame while stale by the WGSL's blend (its
   * weight by `volumeBlendWeight`'s rule: the estimate alone from nothing). Returns the frames each took to settle again
   * and what was left of the lamp's light in each once both settled.
   */
  function lampOff(outer: number): { settled: [number, number]; left: [number, number] } {
    const inner = { updates: SETTLE, samples: SETTLE, target: SETTLE, value: 1.2 };
    const past = { updates: SETTLE, samples: SETTLE, target: SETTLE, value: 0.5 };
    const stale = new Set<typeof inner>();
    const h = new VolumeHistory<typeof inner>(SETTLE, 30, (b) => void stale.add(b));
    const settled: [number, number] = [-1, -1];
    for (let f = 0; f < 200; f++) {
      if (f === 50) {
        const continuing = h.change(f);
        h.restart(inner);
        h.marked(past, continuing, true, outer);
      }
      h.frame(f);
      for (const [i, b] of [inner, past].entries()) {
        if (!stale.has(b)) continue;
        const est = 0.2;
        const w = 1 / (Math.ceil(b.updates / 4) + 1);
        b.value = b.updates === 0 ? est : b.value + (est - b.value) * w;
        b.updates++;
        if (b.updates >= b.target) {
          stale.delete(b);
          settled[i] = f;
        }
      }
    }
    return { settled, left: [(inner.value - 0.2) / 1, (past.value - 0.2) / 0.3] };
  }

  it('settles the bricks past the reach in fewer updates, with nothing of the lamp left in either', () => {
    const r = lampOff(OUTER);
    expect(r.settled).toEqual([50 + SETTLE - 1, 50 + OUTER - 1]);
    expect(Math.abs(r.left[0])).toBeLessThan(0.01);
    expect(Math.abs(r.left[1])).toBeLessThan(0.01);
    // The settle count for both, as every brick took before.
    expect(lampOff(SETTLE).settled).toEqual([50 + SETTLE - 1, 50 + SETTLE - 1]);
  });

  it('gives a brick past the reach its fewer updates, the settle count while changes continue, and the larger target once they stop', () => {
    const b = { updates: SETTLE, samples: SETTLE, target: SETTLE };
    const marks: number[] = [];
    const h = new VolumeHistory<typeof b>(SETTLE, 30, () => void marks.push(b.target));
    h.marked(b, h.change(0), true, OUTER);
    expect(b.target).toBe(OUTER);
    expect(b.updates).toBe(0);
    // A lamp moving: within the continue frames, half its history and the settle count; once they stop, from nothing
    // with the larger of the targets it was marked with (the nearer change's).
    b.updates = SETTLE;
    h.marked(b, h.change(10), true, OUTER);
    expect(b.updates).toBe(SETTLE >> 1);
    expect(b.target).toBe(SETTLE);
    h.marked(b, h.change(12), true, SETTLE);
    h.frame(100);
    expect(b.updates).toBe(0);
    expect(b.target).toBe(SETTLE);
  });
});

