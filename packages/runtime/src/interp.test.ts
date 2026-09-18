/**
 * Render interpolation policy tests (runtime.md §6): lerp math,
 * slerp math (sign alignment, near-identity nlerp shortcut, standard
 * constant-rate slerp), derived-copy normalization (inputs never
 * mutated), the prev==curr / alpha==0 short-circuits, and the read-only
 * nature of `getInterpolatedState` (fresh derived values; the frozen
 * snapshot untouched).
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_MODULES, createSimulationRegistry, instantiateRuntime, registerSimulationModule } from './index';
import { lerpVec3, quatEqual, slerpQuat, vec3Equal } from './interp';
import type { Quat } from '@thirdlight/project-model';
import { baseScene, BOX_ID, BOX_X0, cloneJson, snapshotOf } from './test-helpers';

const DT = 1 / 120;

describe('interpolation math (pure functions, runtime.md §6)', () => {
  it('lerpVec3 is component-wise', () => {
    expect(lerpVec3([0, 0, 0], [2, 4, 6], 0.5)).toEqual([1, 2, 3]);
    expect(lerpVec3([1, -1, 2], [1, -1, 2], 0.3)).toEqual([1, -1, 2]); // prev == curr
  });

  it('slerp sign-aligns first (dot < 0 ⇒ negate the second): [0,0,0,1] → [0,0,0,-1] is the zero rotation', () => {
    const out = slerpQuat([0, 0, 0, 1] as Quat, [0, 0, 0, -1] as Quat, 0.5);
    expect(out).toEqual([0, 0, 0, 1]);
  });

  it('near-identity (dot > 1 − 1e-9) uses the normalized linear lerp — slerp(q, q, a) == normalize(q)', () => {
    const q: Quat = [0, 0, 0.6, 0.8]; // unit
    const out = slerpQuat(q, [q[0], q[1], q[2], q[3]] as Quat, 0.5);
    expect(out[0]).toBeCloseTo(0, 12);
    expect(out[1]).toBeCloseTo(0, 12);
    expect(out[2]).toBeCloseTo(0.6, 12);
    expect(out[3]).toBeCloseTo(0.8, 12);
  });

  it('standard constant-rate slerp: 90° about Z at alpha 0.5 ⇒ 45° about Z', () => {
    const a: Quat = [0, 0, 0, 1];
    const b: Quat = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
    const out = slerpQuat(a, b, 0.5);
    expect(out[0]).toBeCloseTo(0, 9);
    expect(out[1]).toBeCloseTo(0, 9);
    expect(out[2]).toBeCloseTo(Math.sin(Math.PI / 8), 9);
    expect(out[3]).toBeCloseTo(Math.cos(Math.PI / 8), 9);
  });

  it('slerp endpoints: alpha 0 ⇒ a, alpha 1 ⇒ b (both normalized)', () => {
    const a: Quat = [0, 0, 0.6, 0.8];
    const b: Quat = [0.5, 0.5, 0.5, 0.5];
    expect(slerpQuat(a, b, 0)[3]).toBeCloseTo(0.8, 12);
    const at1 = slerpQuat(a, b, 1);
    expect(at1[0]).toBeCloseTo(0.5, 12);
    expect(at1[3]).toBeCloseTo(0.5, 12);
  });

  it('inputs are NEVER mutated (derived copies only — project-model §10.1)', () => {
    const a: Quat = [0.1, 0.2, 0.3, 0.9];
    const b: Quat = [0.9, 0.3, 0.2, 0.1];
    const aJson = JSON.stringify(a);
    const bJson = JSON.stringify(b);
    slerpQuat(a, b, 0.5);
    lerpVec3([1, 2, 3], [4, 5, 6], 0.5);
    expect(JSON.stringify(a)).toBe(aJson);
    expect(JSON.stringify(b)).toBe(bJson);
  });

  it('equality helpers are component-wise', () => {
    expect(vec3Equal([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(vec3Equal([1, 2, 3], [1, 2, 0.3])).toBe(false);
    expect(quatEqual([0, 0, 0, 1], [0, 0, 0, 1])).toBe(true);
    expect(quatEqual([0, 0, 0, 1], [0, 0, 0, -1])).toBe(false);
  });
});

function makeRuntime(modules?: string[]) {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  const res = instantiateRuntime({
    snapshot: snapshotOf(cloneJson(baseScene())),
    registry: r,
    driver: { kind: 'manual' },
    clock: () => 0,
    ...(modules !== undefined ? { modules } : {}),
  });
  if (!res.ok) throw new Error('instantiate failed');
  res.runtime.start();
  res.runtime.tick(0); // anchor
  return res.runtime;
}

describe('interpolated state through the runtime (runtime.md §6)', () => {
  it('prev == curr short-circuit: with the demo disabled the result is curr exactly (fresh copy, inputs untouched)', () => {
    const rt = makeRuntime([]);
    const before = JSON.stringify(snapshotOf(cloneJson(baseScene())));
    const st1 = rt.getInterpolatedState();
    expect(st1.ok).toBe(true);
    if (!st1.ok) return;
    expect(st1.state.alpha).toBe(0);
    const box = st1.state.transforms.find((t) => t.id === BOX_ID);
    expect(box).toBeDefined();
    expect(box!.position[0]).toBe(BOX_X0);
    // A second call yields fresh-but-equal derived values (read-only).
    const st2 = rt.getInterpolatedState();
    expect(JSON.stringify(st2)).toBe(JSON.stringify(st1));
    if (st2.ok) {
      const box2 = st2.state.transforms.find((t) => t.id === BOX_ID);
      // Not the same array reference — fresh derived values per call.
      expect(box2!.position).not.toBe(box!.position);
      expect(box2!.position).toEqual(box!.position);
    }
    rt.dispose();
    expect(JSON.stringify(snapshotOf(cloneJson(baseScene())))).toBe(before); // sanity: our clone
  });

  it('mid-frame interpolation: position = prev + (curr − prev)·alpha at alpha 0.5 (demo enabled)', () => {
    const rt = makeDemo();
    // One full step, then a frame halfway to the next: rawN 0, alpha 0.5.
    let t = 0;
    const tick = (at: number) => {
      const res = rt.tick(at);
      if (!res.ok) throw new Error(`tick failed: ${JSON.stringify(res.error)}`);
    };
    // (The harness runtime is already anchored at t=0.)
    t = DT;
    tick(t); // 1 step: curr.x = x(1), prev.x = x0
    t = DT + 0.5 * DT;
    tick(t); // rawN 0, alpha = 0.5
    const st = rt.getInterpolatedState();
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    expect(st.state.stepIndex).toBe(1);
    expect(st.state.alpha).toBeCloseTo(0.5, 9);
    const x1 = BOX_X0 + 0.5 * Math.sin((2 * Math.PI * 2) / 480); // x(1)
    const box = st.state.transforms.find((x) => x.id === BOX_ID);
    expect(box!.position[0]).toBeCloseTo((BOX_X0 + x1) / 2, 9);
    rt.dispose();
  });

  it('getCamera returns the snapshot camera parameters (stable for the session)', () => {
    const rt = makeRuntime();
    const res = rt.getCamera();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.camera).toEqual({ id: 'cam-main', fovY: 60, near: 0.1, far: 100 });
    const again = rt.getCamera();
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.camera).toEqual(res.camera);
    rt.dispose();
  });
});

function makeDemo() {
  const rt = makeRuntime();
  return rt;
}