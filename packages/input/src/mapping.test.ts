/**
 * Packet 30 — pure mapping acceptance (no browser, no DOM).
 *
 * Establishes the **exact** sampled frames for every mapping/edge case the
 * packet names: keyboard defaults, dead zone including its boundary values,
 * source precedence with no summation, non-standard/absent device, the press
 * latch (including key-repeat coalescing), the press/hold/release chain,
 * fresh activation after suspension, simultaneous sources and deterministic
 * output. The committed `fixtures/m2/input/raw-sequences.json` is replayed
 * step by step (the Node checker re-derives the same values independently).
 */
import { describe, expect, it } from 'vitest';

import { mapRawInput, quantizeMove, rescaleStick, type MapRawOptions } from './mapping';
import { DEFAULT_KEYBOARD_MAP, GAMEPAD_DEAD_ZONE, type RawInputSnapshot } from './types';

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

function frame(snapshot: RawInputSnapshot, options: Partial<MapRawOptions> = {}) {
  return mapRawInput(snapshot, { stepIndex: 12, ...options });
}

describe('constants and public defaults', () => {
  it('exposes the contracted defaults', () => {
    expect(GAMEPAD_DEAD_ZONE).toBe(0.2);
    expect(DEFAULT_KEYBOARD_MAP.left).toEqual(['KeyA', 'ArrowLeft']);
    expect(DEFAULT_KEYBOARD_MAP.right).toEqual(['KeyD', 'ArrowRight']);
    expect(DEFAULT_KEYBOARD_MAP.jump).toEqual(['Space']);
    expect(Object.isFrozen(DEFAULT_KEYBOARD_MAP)).toBe(true);
  });
});

describe('keyboard digital movement (input.md §4.1/§4.3)', () => {
  it('maps each single control to exactly ±1', () => {
    expect(frame(snap({ keyboardLeft: true })).moveX).toBe(-1);
    expect(frame(snap({ keyboardRight: true })).moveX).toBe(1);
  });

  it('cancels opposing controls instead of summing them', () => {
    expect(frame(snap({ keyboardLeft: true, keyboardRight: true })).moveX).toBe(0);
  });

  it('emits no jump edge without a down control', () => {
    expect(frame(snap()).jump).toBe('none');
    expect(frame(snap()).moveX).toBe(0);
  });

  it('labels the frame with the sampled step index', () => {
    expect(frame(snap({ keyboardLeft: true }), { stepIndex: 4711 }).stepIndex).toBe(4711);
  });
});

describe('gamepad dead zone and rescaling (input.md §4.2)', () => {
  it('treats the exact boundary as zero on both sides', () => {
    expect(frame(snap({ gamepad: pad({ axis0: 0.2 }) })).moveX).toBe(0);
    expect(frame(snap({ gamepad: pad({ axis0: -0.2 }) })).moveX).toBe(0);
    expect(frame(snap({ gamepad: pad({ axis0: 0 }) })).moveX).toBe(0);
  });

  it('rescales linearly above the dead zone', () => {
    expect(frame(snap({ gamepad: pad({ axis0: 0.6 }) })).moveX).toBe(0.5);
    expect(frame(snap({ gamepad: pad({ axis0: -0.6 }) })).moveX).toBe(-0.5);
    expect(frame(snap({ gamepad: pad({ axis0: 1 }) })).moveX).toBe(1);
    expect(frame(snap({ gamepad: pad({ axis0: -1 }) })).moveX).toBe(-1);
  });

  it('quantizes just above the boundary to the 1e-4 grid', () => {
    expect(frame(snap({ gamepad: pad({ axis0: 0.2001 }) })).moveX).toBe(0.0001);
  });

  it('clamps out-of-range axis values', () => {
    expect(frame(snap({ gamepad: pad({ axis0: 2 }) })).moveX).toBe(1);
    expect(frame(snap({ gamepad: pad({ axis0: -2 }) })).moveX).toBe(-1);
  });

  it('rescales a non-finite axis to zero', () => {
    expect(rescaleStick(Number.NaN)).toBe(0);
    expect(frame(snap({ gamepad: pad({ axis0: Number.POSITIVE_INFINITY }) })).moveX).toBe(0);
  });

  it('quantizes to the agreed grid and normalizes negative zero', () => {
    expect(quantizeMove(-0)).toBe(0);
    expect(Object.is(quantizeMove(-0), 0)).toBe(true);
    expect(quantizeMove(0.00005)).toBe(0.0001);
    expect(quantizeMove(0.123456)).toBe(0.1235);
  });
});

describe('source arbitration (input.md §4.3, no summation)', () => {
  it('lets the keyboard beat the D-pad and the stick', () => {
    expect(
      frame(snap({ keyboardLeft: true, gamepad: pad({ axis0: 1, button15: true }) })).moveX,
    ).toBe(-1);
    expect(frame(snap({ keyboardRight: true, gamepad: pad({ button14: true }) })).moveX).toBe(1);
  });

  it('lets the D-pad beat the stick and emits exact ±1', () => {
    expect(frame(snap({ gamepad: pad({ axis0: 0.9, button14: true }) })).moveX).toBe(-1);
    expect(frame(snap({ gamepad: pad({ axis0: -0.9, button15: true }) })).moveX).toBe(1);
  });

  it('cancels opposing D-pad buttons', () => {
    expect(frame(snap({ gamepad: pad({ button14: true, button15: true }) })).moveX).toBe(0);
  });

  it('never leaves [-1, 1] with all sources active', () => {
    const result = frame(
      snap({
        keyboardLeft: true,
        keyboardRight: true,
        gamepad: pad({ axis0: 1, button14: true, button15: false }),
      }),
    );
    expect(result.moveX).toBeGreaterThanOrEqual(-1);
    expect(result.moveX).toBeLessThanOrEqual(1);
  });
});

describe('non-standard and absent devices (input.md §4.1)', () => {
  it('ignores a non-standard mapping entirely', () => {
    const result = frame(
      snap({ gamepad: pad({ mapping: '', axis0: 0.9, button0: true, button15: true }) }),
    );
    expect(result.moveX).toBe(0);
    expect(result.jump).toBe('none');
  });

  it('keeps keyboard play working with no gamepad at all', () => {
    expect(frame(snap({ keyboardRight: true, gamepad: null })).moveX).toBe(1);
    expect(frame(snap({ keyboardJump: true, gamepad: null })).jump).toBe('pressed');
  });
});

describe('jump phase chain and the press latch (runtime.md §12.5.2)', () => {
  it('produces none → pressed → held → released → none across steps', () => {
    const options: MapRawOptions = { stepIndex: 12 };
    const a = mapRawInput(snap({ keyboardJump: true }), options);
    expect(a.jump).toBe('pressed');
    const b = mapRawInput(snap({ keyboardJump: true }), {
      stepIndex: 13,
      previousJumpDown: true,
    });
    expect(b.jump).toBe('held');
    const c = mapRawInput(snap(), { stepIndex: 14, previousJumpDown: true });
    expect(c.jump).toBe('released');
    const d = mapRawInput(snap(), { stepIndex: 15, previousJumpDown: false });
    expect(d.jump).toBe('none');
  });

  it('latches a tap shorter than one executed step exactly once', () => {
    const a = mapRawInput(snap({ jumpLatch: true }), { stepIndex: 12 });
    expect(a.jump).toBe('pressed');
    const b = mapRawInput(snap(), { stepIndex: 13, previousJumpDown: true });
    expect(b.jump).toBe('released');
    const c = mapRawInput(snap(), { stepIndex: 14, previousJumpDown: false });
    expect(c.jump).toBe('none');
  });

  it('coalesces a repeated press into the same held phase (no second edge)', () => {
    const a = mapRawInput(snap({ jumpLatch: true }), { stepIndex: 12 });
    const b = mapRawInput(snap({ jumpLatch: true }), { stepIndex: 13, previousJumpDown: true });
    expect(a.jump).toBe('pressed');
    expect(b.jump).toBe('held');
  });

  it('ORs simultaneous keyboard and gamepad jump sources into one edge', () => {
    const a = mapRawInput(snap({ keyboardJump: true, gamepad: pad({ button0: true }) }), {
      stepIndex: 12,
    });
    expect(a.jump).toBe('pressed');
    const b = mapRawInput(snap({ gamepad: pad({ button0: true }) }), {
      stepIndex: 13,
      previousJumpDown: true,
    });
    expect(b.jump).toBe('held');
  });

  it('never yields pressed while awaiting release after a suspension', () => {
    const a = mapRawInput(snap({ keyboardJump: true }), {
      stepIndex: 12,
      jumpAwaitingRelease: true,
    });
    expect(a.jump).toBe('held');
    const b = mapRawInput(snap({ keyboardJump: true }), {
      stepIndex: 13,
      previousJumpDown: true,
      jumpAwaitingRelease: true,
    });
    expect(b.jump).toBe('held');
    const c = mapRawInput(snap(), { stepIndex: 14, previousJumpDown: true, jumpAwaitingRelease: true });
    expect(c.jump).toBe('none');
    const d = mapRawInput(snap({ keyboardJump: true }), {
      stepIndex: 15,
      previousJumpDown: false,
      jumpAwaitingRelease: false,
    });
    expect(d.jump).toBe('pressed');
  });
});

describe('determinism', () => {
  it('returns an identical frame for identical inputs', () => {
    const snapshot = snap({ keyboardLeft: true, gamepad: pad({ axis0: 0.37, button15: false }) });
    const options: MapRawOptions = { stepIndex: 99, previousJumpDown: true };
    expect(mapRawInput(snapshot, options)).toEqual(mapRawInput(snapshot, options));
  });

  it('emits only the three contracted frame fields', () => {
    const result = frame(snap({ keyboardLeft: true, gamepad: pad({ axis0: 0.5 }) }));
    expect(Object.keys(result).sort()).toEqual(['jump', 'moveX', 'stepIndex']);
  });

  it('round-trips every frame through JSON unchanged', () => {
    const result = frame(snap({ gamepad: pad({ axis0: 0.123456 }) }));
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

// --- committed fixture replay -------------------------------------------------

const RAW = import.meta.glob('../../../fixtures/m2/input/raw-sequences.json', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>;

interface FixtureStep {
  stepIndex: number;
  raw: RawInputSnapshot;
  expect: { frame: { stepIndex: number; moveX: number; jump: string }; next: unknown };
}

interface FixtureSequence {
  caseId: string;
  initialState?: { down: boolean; awaitingRelease: boolean };
  steps: FixtureStep[];
}

function fixtureSequences(): FixtureSequence[] {
  const value = RAW['../../../fixtures/m2/input/raw-sequences.json'];
  if (typeof value !== 'string') {
    throw new Error('fixtures/m2/input/raw-sequences.json was not found by import.meta.glob');
  }
  return (JSON.parse(value) as { sequences: FixtureSequence[] }).sequences;
}

describe('fixtures/m2/input/raw-sequences.json', () => {
  const sequences = fixtureSequences();

  it('indexes the nine packet-30 sequences', () => {
    expect(sequences.map((s) => s.caseId)).toEqual([
      'S1-keyboard-digital',
      'S2-dead-zone-boundary',
      'S3-source-arbitration',
      'S4-jump-phase-chain',
      'S5-press-latch-and-repeat',
      'S6-suspension-fresh-activation',
      'S7-simultaneous-sources',
      'S8-absent-and-nonstandard',
      'S9-both-keys-cancel-then-stick',
    ]);
  });

  for (const sequence of sequences) {
    it(`${sequence.caseId} replays its exact frames and state`, () => {
      let state = sequence.initialState ?? { down: false, awaitingRelease: false };
      for (const step of sequence.steps) {
        const result = mapRawInput(step.raw, {
          stepIndex: step.stepIndex,
          previousJumpDown: state.down,
          jumpAwaitingRelease: state.awaitingRelease,
        });
        expect(result).toEqual(step.expect.frame);
        const nextDown = result.jump === 'pressed' || result.jump === 'held';
        const nextAwaiting =
          state.awaitingRelease && result.jump === 'held' && nextDown;
        state = { down: nextDown, awaitingRelease: nextAwaiting };
        expect(state).toEqual(step.expect.next);
      }
    });
  }
});
