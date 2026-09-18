/**
 * Fixed-step scheduling tests (runtime.md §5): exact step counts,
 * bounded catch-up (n = min(rawN, 8)), drop-and-resync with
 * `droppedSteps`, zero-step frames, the non-monotonic clock warning,
 * and the first-frame anchor (§5.6: time before start is never
 * simulated).
 *
 * All tests use the manual driver + an injected clock (runtime.md §9:
 * the Node test harness runs the same code with injected fakes).
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODULES, createSimulationRegistry, instantiateRuntime, registerSimulationModule } from './index';
import type { Runtime } from './index';
import { baseScene, cloneJson, snapshotOf } from './test-helpers';

interface Harness {
  rt: Runtime;
  diag: () => import('./types').RuntimeDiagnostics;
  setNow: (t: number) => void;
  tick: () => void;
  reset: (t: number) => void;
}

function makeManual(startClock = 0): Harness {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  let now = startClock;
  const res = instantiateRuntime({
    snapshot: snapshotOf(cloneJson(baseScene())),
    registry: r,
    driver: { kind: 'manual' },
    clock: () => now,
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  const diag = (): import('./types').RuntimeDiagnostics => {
    const d = rt.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    return d.diagnostics;
  };
  rt.start();
  return {
    rt,
    diag,
    setNow: (t) => {
      now = t;
    },
    tick: () => {
      const res2 = rt.tick(now);
      if (!res2.ok) throw new Error(`tick failed: ${JSON.stringify(res2.error)}`);
    },
    reset: (t) => {
      now = t;
    },
  };
}

const DT = 1 / 120;

describe('fixed steps with bounded catch-up (runtime.md §5)', () => {
  it('the first frame after start initializes the anchor — time before start is never simulated', () => {
    const h = makeManual();
    h.rt.tick(0); // anchor at t=0 (zero steps)
    expect(h.diag().stepIndex).toBe(0);
    expect(h.diag().frameCount).toBe(1);
    // A LATE first tick at t=100 must not burst 12000 steps: the anchor
    // is set at that frame (§5.6).
    const h2 = makeManual();
    h2.rt.tick(100); // first frame at t=100
    expect(h2.diag().stepIndex).toBe(0);
    h2.rt.tick(100 + DT); // one step
    expect(h2.diag().stepIndex).toBe(1);
    h2.rt.stop();
    h.rt.stop();
  });

  it('normal frames: exact step counts (2 steps per 1/60 s frame at 120 Hz)', () => {
    const h = makeManual();
    h.rt.tick(0); // anchor
    h.setNow(DT * 2);
    h.tick();
    expect(h.diag().stepIndex).toBe(2);
    h.setNow(DT * 4);
    h.tick();
    expect(h.diag().stepIndex).toBe(4);
    expect(h.diag().droppedSteps).toBe(0);
    expect(h.diag().frameCount).toBe(3);
    h.rt.stop();
  });

  it('a 100 ms stall: rawN 12 ⇒ 8 executed, 4 dropped, anchor resynced (§5.4)', () => {
    const h = makeManual();
    h.rt.tick(0); // anchor
    h.setNow(DT * 2);
    h.tick(); // stepIndex 2
    h.setNow(DT * 4);
    h.tick(); // stepIndex 4
    h.setNow(DT * 4 + 0.1); // +12 steps of wall time
    h.tick();
    const d = h.diag();
    expect(d.stepIndex).toBe(12); // 4 + 8 (capped)
    expect(d.droppedSteps).toBe(4);
    expect(d.frameCount).toBe(4);
    expect(d.errorCount).toBe(0);
    // Resync: the NEXT frame counts from the resynced anchor.
    h.setNow(DT * 4 + 0.1 + DT * 2);
    h.tick();
    expect(h.diag().stepIndex).toBe(14); // 12 + 2
    expect(h.diag().droppedSteps).toBe(4); // no new drops
    h.rt.stop();
  });

  it('no unbounded burst ever executes after a stall (cap is hard)', () => {
    const h = makeManual();
    h.rt.tick(0); // anchor
    h.setNow(100); // 12000 raw steps of wall time
    h.tick();
    const d = h.diag();
    expect(d.stepIndex).toBe(8); // exactly MAX_CATCHUP_STEPS
    expect(d.droppedSteps).toBe(12000 - 8);
    h.rt.stop();
  });

  it('zero-step frames: rawN == 0 runs no step but still counts as a frame', () => {
    const h = makeManual();
    h.rt.tick(0); // anchor
    h.setNow(DT * 2);
    h.tick(); // stepIndex 2
    h.setNow(DT * 2 + 0.4 * DT); // less than one step of wall time
    h.tick();
    const d = h.diag();
    expect(d.stepIndex).toBe(2);
    expect(d.frameCount).toBe(3);
    expect(d.droppedSteps).toBe(0);
    // The frame renders the current state with a fractional alpha (§5.5/§6).
    const st = h.rt.getInterpolatedState();
    expect(st.ok).toBe(true);
    if (st.ok) {
      expect(st.state.alpha).toBeCloseTo(0.4, 9);
      expect(st.state.stepIndex).toBe(2);
    }
    h.rt.stop();
  });

  it('a non-monotonic clock yields zero steps + one clock_warning (no error)', () => {
    const h = makeManual();
    h.rt.tick(0); // anchor
    h.setNow(DT * 2);
    h.tick(); // stepIndex 2
    h.setNow(DT * 2 - 0.05); // clock goes backwards
    h.tick();
    const d = h.diag();
    expect(d.stepIndex).toBe(2);
    expect(d.clockWarningCount).toBe(1);
    expect(d.errorCount).toBe(0);
    // The anchor is left in place: the next monotonic frame resumes.
    h.setNow(DT * 4);
    h.tick();
    expect(h.diag().stepIndex).toBe(4);
    expect(h.diag().clockWarningCount).toBe(1);
    h.rt.stop();
  });

  it('simTime is always stepIndex / fixedStepHz (single division, no accumulation)', () => {
    const h = makeManual();
    h.rt.tick(0);
    for (let i = 1; i <= 50; i += 1) {
      h.setNow(DT * i);
      h.tick();
    }
    const d = h.diag();
    expect(d.stepIndex).toBe(50);
    expect(d.simTime).toBe(50 / 120); // exact — the §4 invariant
    h.rt.stop();
  });
});