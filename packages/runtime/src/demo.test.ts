/**
 * Built-in moving-box demonstration tests (runtime.md §7) + the §4
 * determinism check (two instances, same fake-clock sequence ⇒
 * identical state sequences).
 *
 * Exact points per m1-acceptance §2.1 (the §7.1 `(stepIndex + 1)`
 * offset; SIM_HZ·T = 480 steps per period at the 120 Hz default):
 * stepIndex 119 ⇒ x0 + A; 239 ⇒ x0; 359 ⇒ x0 − A; 479 ⇒ x0.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODULES, createSimulationRegistry, instantiateRuntime, registerSimulationModule } from './index';
import type { InterpolatedState, Runtime, RuntimeError } from './index';
import { baseScene, BOX_ID, BOX_X0, CAM_ID, cloneJson, GROUP_ID, snapshotOf } from './test-helpers';

const A = 0.5;
const DT = 1 / 120;
const PERIOD_STEPS = 480; // SIM_HZ · T = 120 · 4.0

interface DemoHarness {
  rt: Runtime;
  /** Advance exactly `n` fixed steps (one wall step each). */
  step: (n: number) => void;
}

function makeDemo(modules?: string[]): DemoHarness {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  const res = instantiateRuntime({
    snapshot: snapshotOf(cloneJson(baseScene())),
    registry: r,
    driver: { kind: 'manual' },
    clock: () => 0,
    ...(modules !== undefined ? { modules } : {}),
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify((res as { error: RuntimeError }).error)}`);
  const rt = res.runtime;
  rt.start();
  // First tick = the anchor frame (§5.6): zero steps.
  let t = 0;
  rt.tick(t);
  return {
    rt,
    step: (n: number) => {
      for (let i = 0; i < n; i += 1) {
        t += DT;
        const res2 = rt.tick(t);
        if (!res2.ok) throw new Error(`tick failed: ${JSON.stringify(res2.error)}`);
      }
    },
  };
}

function stateOf(rt: Runtime): InterpolatedState {
  const st = rt.getInterpolatedState();
  if (!st.ok) throw new Error('state failed');
  return st.state;
}

function transformOf(st: InterpolatedState, id: string) {
  const t = st.transforms.find((x) => x.id === id);
  if (!t) throw new Error(`entity ${id} not found`);
  return t;
}

/** Exact §7.1 formula (the contract's normative math). */
function xAt(stepIndex: number, x0: number): number {
  return x0 + A * Math.sin((2 * Math.PI * (stepIndex + 1)) / PERIOD_STEPS);
}

describe('built-in moving-box demonstration (runtime.md §7)', () => {
  it('after N fixed steps the box x equals the §7.1 formula at all exact period points (119/239/359/479)', () => {
    const { rt, step } = makeDemo();
    step(119);
    expect(stateOf(rt).stepIndex).toBe(119);
    expect(transformOf(stateOf(rt), BOX_ID).position[0]).toBeCloseTo(xAt(119, BOX_X0), 9);
    expect(transformOf(stateOf(rt), BOX_ID).position[0]).toBeCloseTo(BOX_X0 + A, 9);

    step(120); // 119 + 120 = 239
    expect(stateOf(rt).stepIndex).toBe(239);
    expect(transformOf(stateOf(rt), BOX_ID).position[0]).toBeCloseTo(xAt(239, BOX_X0), 9);
    expect(transformOf(stateOf(rt), BOX_ID).position[0]).toBeCloseTo(BOX_X0, 9);

    step(120); // 359
    expect(stateOf(rt).stepIndex).toBe(359);
    expect(transformOf(stateOf(rt), BOX_ID).position[0]).toBeCloseTo(xAt(359, BOX_X0), 9);
    expect(transformOf(stateOf(rt), BOX_ID).position[0]).toBeCloseTo(BOX_X0 - A, 9);

    step(120); // 479
    expect(stateOf(rt).stepIndex).toBe(479);
    expect(transformOf(stateOf(rt), BOX_ID).position[0]).toBeCloseTo(xAt(479, BOX_X0), 9);
    expect(transformOf(stateOf(rt), BOX_ID).position[0]).toBeCloseTo(BOX_X0, 9);

    // alpha is exactly 0 after whole-multiple ticks (targetSim == simTime)
    // — the transforms above are the curr state exactly (§6).
    expect(stateOf(rt).alpha).toBe(0);
    rt.dispose();
  });

  it('y/z, rotation and scale are never touched; groups and the camera are static', () => {
    const { rt, step } = makeDemo();
    step(239);
    const box = transformOf(stateOf(rt), BOX_ID);
    expect(box.position[1]).toBe(0.5);
    expect(box.position[2]).toBe(0);
    expect(box.rotation).toEqual([0, 0, 0, 1]);
    expect(box.scale).toEqual([1, 1, 1]);
    const group = transformOf(stateOf(rt), GROUP_ID);
    expect(group.position).toEqual([0, 0, 0]);
    expect(group.rotation).toEqual([0, 0, 0, 1]);
    expect(group.scale).toEqual([1, 1, 1]);
    const cam = transformOf(stateOf(rt), CAM_ID);
    expect(cam.position).toEqual([0, 0.5, 4]);
    expect(cam.rotation).toEqual([0, 0, 0, 1]);
    rt.dispose();
  });

  it('bounded: |x − x0| ≤ 0.5 m at every step of a full period', () => {
    const { rt, step } = makeDemo();
    for (let i = 0; i < PERIOD_STEPS; i += 1) {
      step(1);
      const x = transformOf(stateOf(rt), BOX_ID).position[0];
      expect(Math.abs(x - BOX_X0)).toBeLessThanOrEqual(A + 1e-12);
    }
    rt.dispose();
  });

  it('modules: [] disables the demo (the box stays at its authored position)', () => {
    const { rt, step } = makeDemo([]);
    step(479);
    expect(stateOf(rt).stepIndex).toBe(479); // steps still run
    expect(transformOf(stateOf(rt), BOX_ID).position[0]).toBe(BOX_X0);
    rt.dispose();
  });

  it('determinism: two instances + the same fake-clock sequence ⇒ identical states (§4/§7.3)', () => {
    const a = makeDemo();
    const b = makeDemo();
    a.step(479);
    b.step(479);
    expect(JSON.stringify(stateOf(a.rt))).toBe(JSON.stringify(stateOf(b.rt)));
    a.rt.dispose();
    b.rt.dispose();
  });
});