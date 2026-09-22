/**
 * Packet 29 — M2 fixed-step scheduling, sampling discipline and
 * initialization cancellation (runtime.md §5 + §12.5 + §13).
 *
 * Proves: at most eight steps per frame; a dropped interval executes (and
 * samples) nothing; a jump edge is delivered exactly once; the 12-step
 * settle pre-roll samples no input; initialization is cancellable by
 * stop/dispose before the first frame; and repeated teardown is idempotent
 * (no duplicate loops).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ActionFrame, SimulationModuleSpec } from './index';
import { instantiateRuntime } from './index';
import { makeFakePort, makeM2Runtime, probeSpec, recordingSource, registryWith, v2Snapshot } from './m2-helpers';

const DT = 1 / 120;
const restorers: Array<() => void> = [];

interface RafFake {
  live: Set<number>;
  pump: () => void;
}

function installRafFake(): RafFake {
  const live = new Set<number>();
  const cbs = new Map<number, (time: number) => void>();
  let next = 1;
  const g = globalThis as unknown as {
    requestAnimationFrame?: (cb: (time: number) => void) => number;
    cancelAnimationFrame?: (id: number) => void;
  };
  const savedRaf = g.requestAnimationFrame;
  const savedCaf = g.cancelAnimationFrame;
  g.requestAnimationFrame = (cb) => {
    const id = next;
    next += 1;
    cbs.set(id, cb);
    live.add(id);
    return id;
  };
  g.cancelAnimationFrame = (id) => {
    cbs.delete(id);
    live.delete(id);
  };
  restorers.push(() => {
    g.requestAnimationFrame = savedRaf;
    g.cancelAnimationFrame = savedCaf;
  });
  return {
    live,
    pump: () => {
      const first = [...live][0];
      const cb = first !== undefined ? cbs.get(first) : undefined;
      if (first === undefined || !cb) throw new Error('no live rAF callback');
      cbs.delete(first);
      live.delete(first);
      cb(0);
    },
  };
}

afterEach(() => {
  while (restorers.length > 0) restorers.pop()!();
});

function traceSpec(seen: Array<{ stepIndex: number; frame: ActionFrame }>): SimulationModuleSpec {
  return probeSpec({
    id: 'thirdlight.test:trace',
    phases: ['intent'],
    step: (_phase, ctx) => {
      seen.push({ stepIndex: ctx.stepIndex, frame: { ...ctx.action } });
    },
  });
}

describe('M2 scheduling (runtime.md §5/§12.5)', () => {
  it('the settle pre-roll executes 12 neutral steps, samples nothing, then the first sample is at step 12', () => {
    const seen: Array<{ stepIndex: number; frame: ActionFrame }> = [];
    const frames = recordingSource();
    const h = makeM2Runtime({
      modules: ['thirdlight.test:trace'],
      specs: [traceSpec(seen)],
      actions: frames,
    });
    h.boot();
    const d = h.diag();
    expect(d.settleSteps).toBe(12);
    expect(d.stepIndex).toBe(12);
    expect(d.inputSamples).toBe(0);
    expect(frames.sampled).toEqual([]);
    expect(seen.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const row of seen) expect(row.frame).toEqual({ stepIndex: row.stepIndex, moveX: 0, jump: 'none' });

    seen.length = 0;
    h.tick(0.0167);
    expect(frames.sampled).toEqual([12, 13]);
    expect(seen.map((s) => s.stepIndex)).toEqual([12, 13]);
    expect(h.diag().stepIndex).toBe(14);
    expect(h.diag().inputSamples).toBe(2);
    h.rt.dispose();
  });

  it('a long stall executes at most 8 steps, drops the remainder and executes/samples no dropped step', () => {
    const seen: Array<{ stepIndex: number; frame: ActionFrame }> = [];
    const frames = recordingSource();
    const h = makeM2Runtime({
      modules: ['thirdlight.test:trace'],
      specs: [traceSpec(seen)],
      actions: frames,
    });
    h.boot(); // stepIndex 12
    seen.length = 0;
    h.tick(1.0); // 120 raw steps of wall time
    const d = h.diag();
    expect(d.stepIndex).toBe(20); // 12 + 8
    expect(d.droppedSteps).toBe(112);
    expect(d.droppedInputSteps).toBe(112);
    expect(frames.sampled).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    expect(seen.map((s) => s.stepIndex)).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    // The next frame resumes contiguously from 20 (no phantom replay).
    seen.length = 0;
    h.tick(1.0 + 0.0167);
    expect(frames.sampled).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    expect(seen.map((s) => s.stepIndex)).toEqual([20, 21]);
    expect(h.diag().droppedSteps).toBe(112);
    h.rt.dispose();
  });

  it('a jump/action edge delivered inside an 8-step catch-up frame is consumed exactly once', () => {
    const seen: Array<{ stepIndex: number; frame: ActionFrame }> = [];
    const frames = recordingSource([{ stepIndex: 12, moveX: 1, jump: 'pressed' }]);
    const h = makeM2Runtime({
      modules: ['thirdlight.test:trace'],
      specs: [traceSpec(seen)],
      actions: frames,
    });
    h.boot();
    seen.length = 0;
    h.tick(0.0668); // 8 raw steps, no drop
    const pressed = seen.filter((s) => s.frame.jump === 'pressed');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]!.stepIndex).toBe(12);
    expect(seen.filter((s) => s.frame.moveX === 1)).toHaveLength(1);
    expect(h.diag().stepIndex).toBe(20);
    expect(h.diag().droppedSteps).toBe(0);
    h.rt.dispose();
  });

  it('initialization (settle pre-roll) is cancellable: stop before the first frame executes no step and the pre-roll runs once on restart', () => {
    const seen: Array<{ stepIndex: number; frame: ActionFrame }> = [];
    const h = makeM2Runtime({
      modules: ['thirdlight.test:trace'],
      specs: [traceSpec(seen)],
      actions: recordingSource(),
    });
    expect(h.rt.start().ok).toBe(true);
    expect(h.rt.stop().ok).toBe(true); // cancelled before the pre-roll frame
    expect(h.diag().stepIndex).toBe(0);
    expect(h.diag().settleSteps).toBe(0);
    expect(seen).toEqual([]);
    expect(h.rt.start().ok).toBe(true);
    h.tick(0);
    expect(h.diag().stepIndex).toBe(12);
    expect(h.diag().settleSteps).toBe(12);
    expect(seen).toHaveLength(12);
    h.tick(DT);
    expect(h.diag().stepIndex).toBe(13);
    expect(seen).toHaveLength(13); // pre-roll ran exactly once
    h.rt.dispose();
  });

  it('initialize/dispose race: dispose before the first frame leaves no loop and no step; a failed boot never runs', () => {
    const fake = installRafFake();
    const seen: Array<{ stepIndex: number; frame: ActionFrame }> = [];
    const spec = traceSpec(seen);
    const registry = registryWith([spec]);
    const res = instantiateRuntime({
      snapshot: v2Snapshot(),
      registry,
      modules: [spec.id],
      clock: () => 0,
    });
    if (!res.ok) throw new Error('instantiate failed');
    const rt = res.runtime;
    expect(rt.start().ok).toBe(true);
    expect(fake.live.size).toBe(1);
    expect(rt.dispose().ok).toBe(true);
    expect(fake.live.size).toBe(0);
    expect(seen).toEqual([]);
    expect(rt.getInterpolatedState().ok).toBe(false);
    const diag = rt.getDiagnostics();
    if (!diag.ok) throw new Error('diagnostics failed');
    expect(diag.diagnostics.state).toBe('disposed');
    // A late pump cannot run the cancelled callback.
    expect(() => fake.pump()).toThrow();
    expect(rt.dispose()).toEqual({ ok: true, alreadyDisposed: true });
  });

  it('repeated start/stop/dispose installs exactly one loop each time and releases it on teardown', () => {
    const fake = installRafFake();
    const spec = probeSpec({ id: 'thirdlight.test:noop', phases: ['intent'] });
    const res = instantiateRuntime({
      snapshot: v2Snapshot(),
      registry: registryWith([spec]),
      modules: [spec.id],
      clock: () => 0,
    });
    if (!res.ok) throw new Error('instantiate failed');
    const rt = res.runtime;
    for (let i = 0; i < 3; i += 1) {
      expect(rt.start().ok).toBe(true);
      expect(fake.live.size).toBe(1);
      fake.pump(); // pre-roll on the first cycle, planned frames later
      expect(fake.live.size).toBe(1);
      expect(rt.stop().ok).toBe(true);
      expect(fake.live.size).toBe(0);
    }
    expect(rt.dispose().ok).toBe(true);
    expect(fake.live.size).toBe(0);
    expect(rt.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    expect(fake.live.size).toBe(0);
  });

  it('M2 diagnostics expose the port/input counters', () => {
    const spec = probeSpec({
      id: 'thirdlight.test:port-probe',
      phases: ['controller', 'transform'],
      owners: ['char-0001'],
      requiresPhysicsPort: true,
    });
    const h = makeM2Runtime({
      modules: [spec.id],
      specs: [spec],
      physics: makeFakePort(),
      actions: recordingSource(),
    });
    h.boot();
    const d = h.diag();
    expect(d.failed).toBe(false);
    expect(d.settleSteps).toBe(12);
    expect(d.physicsSteps).toBe(12);
    expect(d.inputSamples).toBe(0);
    expect(d.droppedInputSteps).toBe(0);
    expect(d.physicsStallSteps).toBe(0);
    expect(d.inputSuspendCount).toBe(0);
    h.rt.dispose();
  });
});
