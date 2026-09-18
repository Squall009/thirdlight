/**
 * Registry and module-isolation tests (dependencies.md §6; runtime.md
 * §3.1/§5.1/§8): duplicate-registration refusal, name syntax, unknown /
 * duplicate module selection, the BUILTIN_MODULES contents, the
 * module_error no-op rollback (no partial module application), the
 * bounded 32-entry error ring with cumulative errorCount, and module
 * `dispose?` on runtime disposal.
 */
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MODULES,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
} from './index';
import type { RuntimeSnapshot, SimState, SimulationModuleSpec } from './index';
import { baseScene, BOX_ID, BOX_X0, cloneJson, snapshotOf } from './test-helpers';

const DT = 1 / 120;

function makeRegistryWithDemo() {
  const r = createSimulationRegistry();
  for (const spec of BUILTIN_MODULES) registerSimulationModule(r, spec.id, spec);
  return r;
}

function makeRuntime(modules: string[], extraSpecs?: SimulationModuleSpec[]) {
  const r = makeRegistryWithDemo();
  for (const spec of extraSpecs ?? []) {
    const res = registerSimulationModule(r, spec.id, spec);
    if (!res.ok) throw new Error(`register failed: ${JSON.stringify(res.error)}`);
  }
  const res = instantiateRuntime({
    snapshot: snapshotOf(cloneJson(baseScene())),
    registry: r,
    driver: { kind: 'manual' },
    clock: () => 0,
    modules,
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  res.runtime.start();
  res.runtime.tick(0); // anchor
  return res.runtime;
}

const throwerSpec: SimulationModuleSpec = {
  id: 'thirdlight.test:thrower',
  create() {
    return {
      step() {
        throw new Error('boom');
      },
    };
  },
};

const goodSpec: SimulationModuleSpec = {
  id: 'thirdlight.test:good',
  create() {
    return {
      step(state: SimState) {
        const t = state.curr.get(BOX_ID);
        if (t) t.position[2] += 1; // a mutation that must be rolled back on failure
      },
    };
  },
};

const disposeSpySpec: SimulationModuleSpec = {
  id: 'thirdlight.test:dispose-spy',
  create() {
    const spec = disposeSpySpec as unknown as { disposed?: number };
    return {
      step() {
        /* no-op */
      },
      dispose() {
        spec.disposed = (spec.disposed ?? 0) + 1;
      },
    };
  },
};

describe('registry (dependencies.md §6)', () => {
  it('BUILTIN_MODULES is exactly the M1 built-in module', () => {
    expect(BUILTIN_MODULES.length).toBe(1);
    expect(BUILTIN_MODULES[0]?.id).toBe('thirdlight.demo:box-motion');
    expect(typeof BUILTIN_MODULES[0]?.create).toBe('function');
  });

  it('duplicate registration ⇒ config_invalid (rejected at registration time)', () => {
    const r = createSimulationRegistry();
    expect(registerSimulationModule(r, 'thirdlight.test:a', { id: 'thirdlight.test:a', create: () => ({ step() {} }) }).ok).toBe(true);
    const dup = registerSimulationModule(r, 'thirdlight.test:a', { id: 'thirdlight.test:a', create: () => ({ step() {} }) });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error.code).toBe('config_invalid');
    }
  });

  it('module names outside the §6 syntax ⇒ config_invalid', () => {
    const r = createSimulationRegistry();
    const spec = { id: 'x', create: () => ({ step() {} }) };
    for (const bad of ['other.demo:x', 'thirdlight.demo', 'thirdlight.Demo:x', 'thirdlight.demo:Box', 'thirdlight.demo:x_1', '', 'thirdlight..demo:x']) {
      const res = registerSimulationModule(r, bad, spec);
      expect(res.ok, bad).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('config_invalid');
    }
    // A conforming name is accepted.
    expect(registerSimulationModule(r, 'thirdlight.a:b-c', spec).ok).toBe(true);
  });

  it('a non-registry registry argument ⇒ config_invalid (registration and instantiate)', () => {
    expect(registerSimulationModule('nope' as never, 'thirdlight.test:a', { id: 'thirdlight.test:a', create: () => ({ step() {} }) }).ok).toBe(false);
    const r = makeRegistryWithDemo();
    const res = instantiateRuntime({
      snapshot: snapshotOf(cloneJson(baseScene())),
      registry: 'nope' as never,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('config_invalid');
  });

  it('unknown module ID at instantiate ⇒ config_invalid', () => {
    const res = instantiateRuntime({
      snapshot: snapshotOf(cloneJson(baseScene())),
      registry: makeRegistryWithDemo(),
      driver: { kind: 'manual' },
      clock: () => 0,
      modules: ['thirdlight.demo:box-motion', 'thirdlight.unknown:module'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('config_invalid');
      expect(res.error.reason).toBe('unknown_module');
    }
  });

  it('duplicate module ID in the selection ⇒ config_invalid', () => {
    const res = instantiateRuntime({
      snapshot: snapshotOf(cloneJson(baseScene())),
      registry: makeRegistryWithDemo(),
      driver: { kind: 'manual' },
      clock: () => 0,
      modules: ['thirdlight.demo:box-motion', 'thirdlight.demo:box-motion'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('config_invalid');
      expect(res.error.reason).toBe('duplicate_module');
    }
  });
});

describe('module step isolation (runtime.md §5.1/§8)', () => {
  it('a throwing module: state restored (no partial application), step not advanced, module_error recorded', () => {
    const rt = makeRuntime(['thirdlight.test:thrower'], [throwerSpec]);
    rt.tick(DT); // the step attempt throws
    const d = rt.getDiagnostics();
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.diagnostics.stepIndex).toBe(0); // not advanced
    expect(d.diagnostics.simTime).toBe(0);
    expect(d.diagnostics.errorCount).toBe(1);
    expect(d.diagnostics.errors.length).toBe(1);
    expect(d.diagnostics.errors[0]?.code).toBe('module_error');
    expect(d.diagnostics.errors[0]?.stepIndex).toBe(1); // the attempted step ordinal
    expect(d.diagnostics.errors[0]?.message.length).toBeLessThanOrEqual(256);
    // curr restored: the box is at its authored position.
    const st = rt.getInterpolatedState();
    if (!st.ok) throw new Error('state failed');
    const box = st.state.transforms.find((t) => t.id === BOX_ID);
    expect(box!.position[0]).toBe(BOX_X0);
    // The step keeps no-opping on every subsequent step until disposed:
    // the failed module instance is not re-created (no retry of create),
    // the state stays frozen (stepIndex/simTime/transforms unchanged),
    // and each further failed step attempt records a module_error (the
    // stateless thrower throws on every attempt — this is what makes the
    // m1-acceptance 33-error ring check below drive 33 recorded failures;
    // the per-frame attempt count is bounded by MAX_CATCHUP_STEPS because
    // the frozen simTime makes rawN grow with wall time, and capped frames
    // drop the remainder + resync per §5.4).
    rt.tick(2 * DT);
    rt.tick(3 * DT);
    const d2 = rt.getDiagnostics();
    if (!d2.ok) throw new Error('diagnostics failed');
    expect(d2.diagnostics.stepIndex).toBe(0);
    expect(d2.diagnostics.simTime).toBe(0);
    expect(d2.diagnostics.errorCount).toBeGreaterThan(1);
    for (const e of d2.diagnostics.errors) expect(e.code).toBe('module_error');
    const st2 = rt.getInterpolatedState();
    if (!st2.ok) throw new Error('state failed');
    const box2 = st2.state.transforms.find((t) => t.id === BOX_ID);
    expect(box2!.position[0]).toBe(BOX_X0); // still frozen
    rt.dispose();
  });

  it('no partial module application: an earlier module mutation is rolled back when a later module throws', () => {
    const rt = makeRuntime(['thirdlight.test:good', 'thirdlight.test:thrower'], [goodSpec, throwerSpec]);
    rt.tick(DT);
    const st = rt.getInterpolatedState();
    expect(st.ok).toBe(true);
    if (!st.ok) return;
    const box = st.state.transforms.find((t) => t.id === BOX_ID);
    expect(box!.position[2]).toBe(0); // the good module's z += 1 was rolled back
    const d = rt.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    expect(d.diagnostics.errorCount).toBe(1);
    expect(d.diagnostics.stepIndex).toBe(0);
    rt.dispose();
  });

  it('the error ring keeps the last 32 entries; errorCount is cumulative (33 recorded failures ⇒ 32 kept, 33 counted)', () => {
    const rt = makeRuntime(['thirdlight.test:thrower'], [throwerSpec]);
    const diag = () => {
      const d = rt.getDiagnostics();
      if (!d.ok) throw new Error('diagnostics failed');
      return d.diagnostics;
    };
    // Drive EXACTLY 33 recorded failures. With the frozen simTime the
    // per-frame attempt count is rawN = floor(elapsed/dt) since the last
    // anchor resync (§5.3/§5.4), so the ticks below are chosen so the
    // attempts sum to exactly 33: 4 + 5 + 6 + 7 (cumulative rawN 4..7 from
    // the t=0 anchor) + 8 (rawN 9 ⇒ capped at 8, anchor resyncs) + 3
    // (rawN 3 from the resynced anchor). The CONTRACT observables are the
    // ring bound and the cumulative count.
    for (const k of [4.5, 5.5, 6.5, 7.5, 9.5, 13]) {
      rt.tick(k * DT);
    }
    const d = diag();
    expect(d.errorCount).toBe(33);
    expect(d.errors.length).toBe(32);
    expect(d.stepIndex).toBe(0);
    for (const e of d.errors) {
      expect(e.code).toBe('module_error');
      expect(e.message.length).toBeLessThanOrEqual(256);
    }
    rt.dispose();
  });

  it('module dispose? is called exactly once by runtime.dispose (even for a failed module)', () => {
    const spy = disposeSpySpec as unknown as { disposed?: number };
    const rt = makeRuntime(['thirdlight.test:dispose-spy', 'thirdlight.test:thrower'], [disposeSpySpec, throwerSpec]);
    rt.tick(DT); // fails
    rt.dispose();
    rt.dispose(); // idempotent — no second dispose call
    expect(spy.disposed).toBe(1);
  });

  it('a module whose create() throws ⇒ config_invalid (never a half-created runtime)', () => {
    const badCreate: SimulationModuleSpec = {
      id: 'thirdlight.test:bad-create',
      create(_snap: RuntimeSnapshot) {
        throw new Error('create exploded');
      },
    };
    const r = makeRegistryWithDemo();
    expect(registerSimulationModule(r, badCreate.id, badCreate).ok).toBe(true);
    const res = instantiateRuntime({
      snapshot: snapshotOf(cloneJson(baseScene())),
      registry: r,
      driver: { kind: 'manual' },
      clock: () => 0,
      modules: ['thirdlight.test:bad-create'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('config_invalid');
      expect(res.error.message).toContain('create exploded');
    }
  });
});