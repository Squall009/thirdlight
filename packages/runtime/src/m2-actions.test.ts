/**
 * Packet 29 — step-indexed action frames and the recorded replay source
 * (runtime.md §12.5/§12.7). Mirrors the accepted packet-17 invalid-frame set
 * (`fixtures/m2/contracts/input/action-sequences.json`, I1–I8).
 */
import { describe, expect, it } from 'vitest';
import {
  InputFrameError,
  createRecordedActionSource,
  neutralFrame,
  quantizeMove,
  validateActionFrame,
  type ActionFrame,
} from './index';
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
  it('accepts the canonical shape and rejects every contracted malformation with the offending field', () => {
    expect(validateActionFrame({ stepIndex: 12, moveX: 0.5, jump: 'held' })).toEqual({
      ok: true,
      frame: { stepIndex: 12, moveX: 0.5, jump: 'held' },
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

  it('the neutral frame is what every unrecorded index yields', () => {
    expect(neutralFrame(7)).toEqual({ stepIndex: 7, moveX: 0, jump: 'none' });
  });
});

describe('createRecordedActionSource (runtime.md §12.7)', () => {
  it('rejects duplicate/decreasing step indices, out-of-range/unquantized moveX, unknown jump and a broken phase chain', () => {
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
    expectInputFrameError([{ stepIndex: 12, moveX: 0, jump: 'held' }], 'jump');
    // A gap after a down phase is not a valid chain (the gap is neutral).
    expectInputFrameError(
      [
        { stepIndex: 12, moveX: 0, jump: 'pressed' },
        { stepIndex: 14, moveX: 0, jump: 'held' },
      ],
      'jump',
    );
  });

  it('accepts a valid chain, samples recorded frames, yields neutral frames for gaps, and reset() is a no-op', () => {
    const src = createRecordedActionSource([
      { stepIndex: 12, moveX: 1, jump: 'pressed' },
      { stepIndex: 13, moveX: 1, jump: 'held' },
      { stepIndex: 14, moveX: 0, jump: 'released' },
      { stepIndex: 16, moveX: 0, jump: 'none' },
    ]);
    expect(src.sample(12)).toEqual({ stepIndex: 12, moveX: 1, jump: 'pressed' });
    expect(src.sample(13)).toEqual({ stepIndex: 13, moveX: 1, jump: 'held' });
    expect(src.sample(14)).toEqual({ stepIndex: 14, moveX: 0, jump: 'released' });
    expect(src.sample(15)).toEqual({ stepIndex: 15, moveX: 0, jump: 'none' });
    expect(src.sample(16)).toEqual({ stepIndex: 16, moveX: 0, jump: 'none' });
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
      actions: { sample: (n: number) => ({ stepIndex: n + 1, moveX: 0, jump: 'none' as const }) },
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
          if (phase === 'controller') ctx.physics.stageCharacterMove('char-0001', { x: ctx.action.moveX * 0.01, y: 0 });
        },
      });
      const h = makeM2Runtime({
        modules: [spec.id],
        specs: [spec],
        physics: makeFakePort(),
        actions: createRecordedActionSource([
          { stepIndex: 12, moveX: 1, jump: 'none' },
          { stepIndex: 13, moveX: 1, jump: 'none' },
          { stepIndex: 14, moveX: 1, jump: 'none' },
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
