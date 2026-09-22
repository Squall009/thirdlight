/**
 * Packet 30 — the replayable step-input source (the injectable source the
 * runtime consumes, separate from the browser attachment).
 *
 * Proves that a recorded `(stepIndex, RawInputSnapshot)` sequence replays
 * through the same pure mapping state as a live binding: same frames, one
 * sample per index, neutral frames for unlisted indexes (the settle pre-roll
 * representation), a strict ascending index check, and a no-op `reset`.
 */
import { describe, expect, it } from 'vitest';

import { mapRawInput } from './mapping';
import { createStepInputSource, type StepInputStep } from './step-source';
import type { RawInputSnapshot } from './types';

const NEUTRAL: RawInputSnapshot = {
  keyboardLeft: false,
  keyboardRight: false,
  keyboardJump: false,
};

function snap(overrides: Partial<RawInputSnapshot> = {}): RawInputSnapshot {
  return { ...NEUTRAL, ...overrides };
}

function pad(
  overrides: Partial<NonNullable<RawInputSnapshot['gamepad']>> = {},
): NonNullable<RawInputSnapshot['gamepad']> {
  return {
    index: 0,
    id: 'pad-0',
    mapping: 'standard',
    axis0: 0,
    button0: false,
    button14: false,
    button15: false,
    ...overrides,
  };
}

const STEPS: StepInputStep[] = [
  { stepIndex: 12, raw: snap({ keyboardRight: true }) },
  { stepIndex: 13, raw: snap({ keyboardRight: true, keyboardJump: true }) },
  { stepIndex: 14, raw: snap({ keyboardJump: true, gamepad: pad({ axis0: 0.6 }) }) },
  { stepIndex: 15, raw: snap({ gamepad: pad({ axis0: 0.6 }) }) },
  { stepIndex: 16, raw: snap() },
];

describe('createStepInputSource', () => {
  it('replays the same frames as a live binding with threaded state', () => {
    const source = createStepInputSource(STEPS);
    let down = false;
    let awaitingRelease = false;
    for (const step of STEPS) {
      const expected = mapRawInput(step.raw, {
        stepIndex: step.stepIndex,
        previousJumpDown: down,
        jumpAwaitingRelease: awaitingRelease,
      });
      const actual = source.sample(step.stepIndex);
      expect(actual).toEqual(expected);
      down = expected.jump === 'pressed' || expected.jump === 'held';
      awaitingRelease = false;
    }
  });

  it('produces exactly one frame per index and neutral frames elsewhere', () => {
    const source = createStepInputSource([
      { stepIndex: 12, raw: snap({ keyboardLeft: true, keyboardJump: true }) },
    ]);
    expect(source.sample(0)).toEqual({ stepIndex: 0, moveX: 0, jump: 'none' });
    expect(source.sample(11)).toEqual({ stepIndex: 11, moveX: 0, jump: 'none' });
    expect(source.sample(12)).toEqual({ stepIndex: 12, moveX: -1, jump: 'pressed' });
    // A repeated sample of the same index is a pure lookup (never a second edge).
    expect(source.sample(12)).toEqual({ stepIndex: 12, moveX: -1, jump: 'pressed' });
    expect(source.sample(13)).toEqual({ stepIndex: 13, moveX: 0, jump: 'none' });
  });

  it('represents the settle pre-roll as neutral steps 0–11', () => {
    const source = createStepInputSource(STEPS);
    for (let n = 0; n < 12; n += 1) {
      expect(source.sample(n)).toEqual({ stepIndex: n, moveX: 0, jump: 'none' });
    }
  });

  it('has a no-op reset (recorded sequences never change on focus events)', () => {
    const source = createStepInputSource(STEPS);
    const before = source.sample(13);
    source.reset?.('blur');
    expect(source.sample(13)).toEqual(before);
  });

  it('rejects non-ascending, duplicate and negative step indexes', () => {
    expect(() =>
      createStepInputSource([
        { stepIndex: 12, raw: snap() },
        { stepIndex: 12, raw: snap() },
      ]),
    ).toThrow(/strictly ascend/);
    expect(() =>
      createStepInputSource([
        { stepIndex: 12, raw: snap() },
        { stepIndex: 11, raw: snap() },
      ]),
    ).toThrow(/strictly ascend/);
    expect(() => createStepInputSource([{ stepIndex: -1, raw: snap() }])).toThrow(/integer >= 0/);
  });

  it('rejects malformed entries', () => {
    expect(() => createStepInputSource([{ stepIndex: 12, raw: null as never }])).toThrow(
      /raw must be a snapshot/,
    );
  });
});
