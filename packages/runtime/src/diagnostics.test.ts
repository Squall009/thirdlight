/**
 * Structured diagnostics tests (runtime.md §8): the full shape (every
 * field present, types per the contract), values consistent with a
 * known run, defaults (120 Hz, "performance" clock), and operation in
 * every state including disposed.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODULES, createSimulationRegistry, instantiateRuntime, registerSimulationModule } from './index';
import type { RuntimeDiagnostics } from './index';
import { baseScene, cloneJson, snapshotOf } from './test-helpers';

const DT = 1 / 120;

const EXPECTED_KEYS = [
  'state',
  'snapshotId',
  'revision',
  'simTime',
  'stepIndex',
  'fixedStepHz',
  'droppedSteps',
  'frameCount',
  'entityCount',
  'modules',
  'clock',
  'clockWarningCount',
  'errors',
  'errorCount',
] as const;

function makeDiagnostics(opts?: { withClock?: boolean }) {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  let now = 0;
  const res = instantiateRuntime({
    snapshot: snapshotOf(cloneJson(baseScene())),
    registry: r,
    driver: { kind: 'manual' },
    ...(opts?.withClock ? { clock: () => now } : {}),
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  const diag = (): RuntimeDiagnostics => {
    const d = rt.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    return d.diagnostics;
  };
  return { rt, diag, setNow: (t: number) => (now = t) };
}

describe('structured diagnostics (runtime.md §8)', () => {
  it('has exactly the contract field set, with types per the contract', () => {
    const { rt, diag } = makeDiagnostics({ withClock: true });
    const d = diag();
    expect(Object.keys(d).sort()).toEqual([...EXPECTED_KEYS].sort());
    expect(typeof d.state).toBe('string');
    expect(['instantiated', 'running', 'stopped', 'disposed']).toContain(d.state);
    expect(d.snapshotId).toBe('demo-0001@r4');
    expect(d.revision).toBe(4);
    expect(typeof d.simTime).toBe('number');
    expect(typeof d.stepIndex).toBe('number');
    expect(d.fixedStepHz).toBe(120); // the M1 default
    expect(typeof d.droppedSteps).toBe('number');
    expect(typeof d.frameCount).toBe('number');
    expect(d.entityCount).toBe(3);
    expect(d.modules).toEqual(['thirdlight.demo:box-motion']);
    expect(d.clock).toBe('injected');
    expect(d.clockWarningCount).toBe(0);
    expect(Array.isArray(d.errors)).toBe(true);
    expect(typeof d.errorCount).toBe('number');
    expect(d.state).toBe('instantiated');
    rt.dispose();
  });

  it('values are consistent with a known run (steps, drops, frames, simTime invariant)', () => {
    const { rt, diag, setNow } = makeDiagnostics({ withClock: true });
    rt.start();
    rt.tick(0); // frame 1: anchor (zero steps)
    setNow(DT * 2);
    rt.tick(DT * 2); // frame 2: 2 steps
    setNow(DT * 2 + 0.1);
    rt.tick(DT * 2 + 0.1); // frame 3: 12 raw ⇒ 8 executed, 4 dropped
    setNow(DT * 2 + 0.1 + 1e-4);
    rt.tick(DT * 2 + 0.1 + 1e-4); // frame 4: zero-step frame
    setNow(DT * 2 + 0.1 - 0.05);
    rt.tick(DT * 2 + 0.1 - 0.05); // frame 5: non-monotonic (warning)
    const d = diag();
    expect(d.state).toBe('running');
    expect(d.stepIndex).toBe(10); // 2 + 8
    expect(d.simTime).toBe(10 / 120);
    expect(d.droppedSteps).toBe(4);
    expect(d.frameCount).toBe(5);
    expect(d.clockWarningCount).toBe(1);
    expect(d.droppedSteps).toBe(4);
    expect(d.errors).toEqual([]);
    expect(d.errorCount).toBe(0);
    rt.stop();
    expect(diag().state).toBe('stopped');
    rt.dispose();
    const dFinal = diag();
    expect(dFinal.state).toBe('disposed');
    // Diagnostics survive disposal with the final counters.
    expect(dFinal.stepIndex).toBe(10);
    expect(dFinal.frameCount).toBe(5);
  });

  it('defaults: fixedStepHz 120, clock "performance" (Node has globalThis.performance)', () => {
    const { rt, diag } = makeDiagnostics(); // no clock injected
    const d = diag();
    expect(d.fixedStepHz).toBe(120);
    expect(d.clock).toBe('performance');
    // The default clock is live: two ticks at real time advance ≥ 0 steps
    // without error (we do not assert a step count — the wall clock is
    // uncontrolled here).
    rt.start();
    rt.tick(0);
    expect(diag().frameCount).toBe(1);
    rt.dispose();
  });

  it('a configured fixedStepHz is honored (dt = 1/hz; the demo period stays 4 s of sim time)', () => {
    const r = createSimulationRegistry();
    for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
    const res = instantiateRuntime({
      snapshot: snapshotOf(cloneJson(baseScene())),
      registry: r,
      driver: { kind: 'manual' },
      clock: () => 0,
      fixedStepHz: 60,
    });
    if (!res.ok) throw new Error('instantiate failed');
    const rt = res.runtime;
    rt.start();
    rt.tick(0); // anchor
    // 239 steps in wall chunks of ≤ 8 (the catch-up cap): 29 × 8 + 7.
    let t = 0;
    for (let i = 0; i < 29; i += 1) {
      t += 8 / 60;
      rt.tick(t);
    }
    t += 7 / 60;
    rt.tick(t);
    const d = rt.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    expect(d.diagnostics.fixedStepHz).toBe(60);
    expect(d.diagnostics.stepIndex).toBe(239);
    expect(d.diagnostics.droppedSteps).toBe(0);
    expect(d.diagnostics.simTime).toBe(239 / 60);
    // The demo completes its 4.0 s period in 240 steps at 60 Hz —
    // x(239) = x0 + 0.5·sin(2π) ≈ x0 (the period is in sim TIME, not
    // step count: 60 Hz × 4 s = 240 steps).
    const st = rt.getInterpolatedState();
    if (!st.ok) throw new Error('state failed');
    const box = st.state.transforms.find((x) => x.id === 'box-0001');
    expect(box!.position[0]).toBeCloseTo(0.5, 9);
    rt.dispose();
  });
});