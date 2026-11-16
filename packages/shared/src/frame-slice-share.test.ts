/**
 * A slice shared by a frame's steps: on a clock that steps as work is done, a frame of four catch-up steps spends one
 * slice (and the last unit that passed it), not four; the next frame has the whole slice again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { frameSliceMs, FrameSliceShare } from './frame-arbiter';

afterEach(() => vi.restoreAllMocks());

describe('a slice shared by a frame’s steps', () => {
  it('a frame of four steps spends the slice once; the next frame has it again', () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const slice = frameSliceMs('voxelDerive');
    expect(slice).toBeGreaterThan(0);
    const share = new FrameSliceShare('voxelDerive');
    // Work that takes 0.5 ms a unit until its slice is spent (one unit past it at most), as the stitching does.
    const work = (ms: number): void => {
      const t0 = clock;
      do clock += 0.5;
      while (clock - t0 < ms);
    };
    const frame = (steps: number): number => {
      const t0 = clock;
      for (let s = 0; s < steps; s++) share.run(work);
      share.frameDone();
      return clock - t0;
    };
    // Four catch-up steps: the first takes the slice, the other three nothing.
    expect(frame(4)).toBe(slice);
    expect(frame(1)).toBe(slice);
    // Work that stops early leaves the rest to the frame's later steps.
    let calls = 0;
    share.run((ms) => {
      calls++;
      clock += ms / 4;
    });
    share.run((ms) => {
      calls++;
      expect(ms).toBeCloseTo((3 * slice) / 4, 9);
      clock += ms;
    });
    share.run(() => calls++);
    expect(calls).toBe(2);
    expect(share.left()).toBeLessThanOrEqual(0);
    share.frameDone();
    expect(share.left()).toBe(slice);
  });
});
