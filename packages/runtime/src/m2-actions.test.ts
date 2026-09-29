/**
 * Step-indexed action frames and the recorded replay source. Mirrors the
 * invalid-frame set of `fixtures/m2/contracts/input/action-sequences.json`
 * (I1–I8).
 */
import { describe, expect, it } from 'vitest';
import {
  InputFrameError,
  createRecordedActionSource,
  neutralFrame,
  quantizeMove,
  validateActionFrame,
  upgradeActionFrameV1,
  type ActionFrame,
} from './index';

/** A version 1 frame (with the fixed moveX/moveY/jump channels), typed loosely: it is read through the upgrade. */
const v1 = (f: Record<string, unknown>): ActionFrame => f as unknown as ActionFrame;
/** The version 2 frame a version 1 frame without actions reads as. */
const up = (stepIndex: number, moveX: number, jump: string): ActionFrame =>
  ({ stepIndex, actions: { move: { v: moveX, p: 'none' }, jump: { v: jump === 'pressed' || jump === 'held' ? 1 : 0, p: jump } } }) as ActionFrame;
import { makeFakePort, makeM2Runtime, probeSpec, registryWith, v2Snapshot } from './m2-helpers';
import { instantiateRuntime } from './index';

const DT = 1 / 120;

function expectInputFrameError(frames: readonly unknown[], field: string): void {
  try {
    createRecordedActionSource(frames as ActionFrame[]);
    throw new Error('expected an InputFrameError');
  } catch (e) {
    expect(e).toBeInstanceOf(InputFrameError);
    expect((e as InputFrameError).code).toBe('input_frame_invalid');
    expect((e as InputFrameError).field).toBe(field);
  }
}

describe('ActionFrame validation (runtime.md §12.5.3)', () => {
  it('phase 24.8: a version 2 frame is named actions only; a fixed channel beside actions is refused only when malformed', () => {
    expect(validateActionFrame({ stepIndex: 12, actions: { move: { v: 0.5, p: 'none' } } })).toEqual({ ok: true, frame: { stepIndex: 12, actions: { move: { v: 0.5, p: 'none' } } } });
    expect(validateActionFrame({ stepIndex: 12 })).toEqual({ ok: true, frame: { stepIndex: 12 } });
    // A version 1 frame's channels become the move and jump actions (they replace those actions' values).
    expect(upgradeActionFrameV1({ stepIndex: 1, moveX: 0.5, jump: 'pressed', actions: { move: { v: 1, p: 'held' }, fire: { v: 1, p: 'held' } } })).toEqual({
      stepIndex: 1,
      actions: { move: { v: 0.5, p: 'held' }, fire: { v: 1, p: 'held' }, jump: { v: 1, p: 'pressed' } },
    });
    expect(upgradeActionFrameV1({ stepIndex: 1, moveX: 0.5, moveY: -1, jump: 'none' })).toEqual({ stepIndex: 1, actions: { move: { v: 0.5, x: 0.5, y: -1, p: 'none' }, jump: { v: 0, p: 'none' } } });
    const plain = { stepIndex: 2, actions: {} };
    expect(upgradeActionFrameV1(plain)).toBe(plain);
  });

  it('accepts the version 1 shape (upgraded) and rejects every contracted malformation with the offending field', () => {
    expect(validateActionFrame({ stepIndex: 12, moveX: 0.5, jump: 'held' })).toEqual({
      ok: true,
      frame: up(12, 0.5, 'held'),
    });
    const bad: Array<[unknown, string]> = [
      [{ stepIndex: 12, moveX: 1.5, jump: 'none' }, 'moveX'],
      [{ stepIndex: 12, moveX: 0.123456, jump: 'none' }, 'moveX'],
      [{ stepIndex: 12, moveX: 0, jump: 'down' }, 'jump'],
      [{ stepIndex: 12.5, moveX: 0, jump: 'none' }, 'stepIndex'],
      [{ stepIndex: 12, moveX: 0, jump: 'none', device: 'pad' }, 'device'],
      [{ stepIndex: 12, moveX: 0 }, 'jump'],
    ];
    for (const [value, field] of bad) {
      const result = validateActionFrame(value);
      expect(result.ok, JSON.stringify(value)).toBe(false);
      if (!result.ok) expect(result.field).toBe(field);
    }
    // Negative zero is normalized away.
    expect(validateActionFrame({ stepIndex: 12, moveX: -0, jump: 'none' }).ok).toBe(false);
    expect(quantizeMove(-0)).toBe(0);
  });

  it('the neutral frame is what every unrecorded index yields (phase 24.8: no action has a value)', () => {
    expect(neutralFrame(7)).toEqual({ stepIndex: 7 });
  });
});

describe('createRecordedActionSource (runtime.md §12.7)', () => {
  it('rejects duplicate/decreasing step indices, out-of-range/unquantized moveX and an unknown jump (phase 24.8: no jump chain check)', () => {
    expectInputFrameError(
      [
        { stepIndex: 12, moveX: 0, jump: 'none' },
        { stepIndex: 12, moveX: 1, jump: 'none' },
      ],
      'stepIndex',
    );
    expectInputFrameError(
      [
        { stepIndex: 13, moveX: 0, jump: 'none' },
        { stepIndex: 12, moveX: 1, jump: 'none' },
      ],
      'stepIndex',
    );
    expectInputFrameError([{ stepIndex: 12, moveX: 1.5, jump: 'none' }], 'moveX');
    expectInputFrameError([{ stepIndex: 12, moveX: 0.123456, jump: 'none' }], 'moveX');
    expectInputFrameError([{ stepIndex: 12, moveX: 0, jump: 'down' }], 'jump');
    expectInputFrameError([{ stepIndex: 12, moveX: 0, jump: 'none', device: 'pad' }], 'device');
    // Frame version 2 has no fixed jump column, so no phase chain is checked across frames.
    expect(() => createRecordedActionSource([v1({ stepIndex: 12, moveX: 0, jump: 'held' })])).not.toThrow();
  });

  it('accepts a valid chain, samples recorded frames, yields neutral frames for gaps, and reset() is a no-op', () => {
    const src = createRecordedActionSource([
      v1({ stepIndex: 12, moveX: 1, jump: 'pressed' }),
      v1({ stepIndex: 13, moveX: 1, jump: 'held' }),
      v1({ stepIndex: 14, moveX: 0, jump: 'released' }),
      v1({ stepIndex: 16, moveX: 0, jump: 'none' }),
    ]);
    expect(src.sample(12)).toEqual(up(12, 1, 'pressed'));
    expect(src.sample(13)).toEqual(up(13, 1, 'held'));
    expect(src.sample(14)).toEqual(up(14, 0, 'released'));
    expect(src.sample(15)).toEqual({ stepIndex: 15 });
    expect(src.sample(16)).toEqual(up(16, 0, 'none'));
    const before = src.sample(12);
    src.reset?.('focus');
    expect(src.sample(12)).toEqual(before);
  });

  it('a malformed frame returned at sample time is a module_error (input_frame_invalid) fail-stop', () => {
    const spec = probeSpec({ id: 'thirdlight.test:sample', phases: ['intent'] });
    const res = instantiateRuntime({
      snapshot: v2Snapshot(),
      registry: registryWith([spec]),
      modules: [spec.id],
      driver: { kind: 'manual' },
      clock: () => 0,
      actions: { sample: (n: number) => ({ stepIndex: n + 1 }) },
    });
    if (!res.ok) throw new Error('instantiate failed');
    const rt = res.runtime;
    rt.start();
    rt.tick(0); // pre-roll: no sampling
    expect(rt.getDiagnostics().ok).toBe(true);
    rt.tick(DT); // first sample: stepIndex mismatch
    const d = rt.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    expect(d.diagnostics.state).toBe('failed');
    expect(d.diagnostics.errors[0]).toMatchObject({ code: 'module_error', reason: 'input_frame_invalid' });
    rt.dispose();
  });

  it('a throwing action source is a module_error (input_source_threw) fail-stop', () => {
    const spec = probeSpec({ id: 'thirdlight.test:sample', phases: ['intent'] });
    const res = instantiateRuntime({
      snapshot: v2Snapshot(),
      registry: registryWith([spec]),
      modules: [spec.id],
      driver: { kind: 'manual' },
      clock: () => 0,
      actions: {
        sample: () => {
          throw new Error('device exploded');
        },
      },
    });
    if (!res.ok) throw new Error('instantiate failed');
    const rt = res.runtime;
    rt.start();
    rt.tick(0);
    rt.tick(DT);
    const d = rt.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    expect(d.diagnostics.state).toBe('failed');
    expect(d.diagnostics.errors[0]).toMatchObject({ code: 'module_error', reason: 'input_source_threw' });
    rt.dispose();
  });

  it('a port-requiring set with a recorded source produces a deterministic trace (same inputs ⇒ same state)', () => {
    const run = (): number[] => {
      const spec = probeSpec({
        id: 'thirdlight.test:walker',
        phases: ['controller', 'transform'],
        owners: ['char-0001'],
        requiresPhysicsPort: true,
        step: (phase, ctx) => {
          if (phase === 'controller') ctx.physics.stageCharacterMove('char-0001', { x: (ctx.action.actions?.['move']?.v ?? 0) * 0.01, y: 0 });
        },
      });
      const h = makeM2Runtime({
        modules: [spec.id],
        specs: [spec],
        physics: makeFakePort(),
        actions: createRecordedActionSource([
          v1({ stepIndex: 12, moveX: 1, jump: 'none' }),
          v1({ stepIndex: 13, moveX: 1, jump: 'none' }),
          v1({ stepIndex: 14, moveX: 1, jump: 'none' }),
        ]),
      });
      h.boot();
      const xs: number[] = [];
      for (let i = 1; i <= 3; i += 1) {
        h.tick(i * DT);
        const st = h.rt.getInterpolatedState();
        if (!st.ok) throw new Error('state failed');
        xs.push(st.state.transforms.find((t) => t.id === 'char-0001')!.position[0]);
      }
      h.rt.dispose();
      return xs;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    expect(a).toEqual([0.01, 0.02, 0.03]);
  });
});
