/**
 * Packet 29 — M2 fail-stop lifecycle (runtime.md §13).
 *
 * A module throw after private-state mutation, a malformed/throwing physics
 * port and a phase violation all fail-stop the whole simulation: the step is
 * abandoned (no rollback attempt), only the last committed state is
 * observable, the failed module/step is reported, the instance refuses to
 * resume, and disposal is idempotent and releases modules + port exactly
 * once. Safe restart = dispose + a fresh instance.
 */
import { describe, expect, it } from 'vitest';
import type { SimulationModuleSpec } from './index';
import { makeFakePort, makeM2Runtime, probeSpec, recordingSource } from './m2-helpers';
import { v2Snapshot } from './m2-helpers';

const DT = 1 / 120;

function controllerSpec(step: SimulationModuleSpec extends never ? never : (
  phase: import('./index').SimulationPhase,
  ctx: import('./index').StepContext,
) => void, opts?: { dispose?: () => void }): SimulationModuleSpec {
  return probeSpec({
    id: 'thirdlight.test:char-controller',
    phases: ['controller', 'transform'],
    owners: ['char-0001'],
    requiresPhysicsPort: true,
    step,
    ...(opts?.dispose ? { dispose: opts.dispose } : {}),
  });
}

describe('M2 fail-stop (runtime.md §13)', () => {
  it('a throw after a private-state/transform mutation fail-stops and renders only the last committed state', () => {
    let privateState = 0;
    const spec = controllerSpec((phase, ctx) => {
      if (phase === 'transform' && ctx.stepIndex === 13) {
        privateState += 1;
        // Half-mutate the world, then throw (a stateful module cannot be
        // rolled back from prev/curr).
        ctx.state.curr.get('char-0001')!.position[0] = 9;
        throw new Error('boom after mutation');
      }
    });
    const port = makeFakePort();
    const h = makeM2Runtime({
      modules: [spec.id],
      specs: [spec],
      physics: port,
      actions: recordingSource(),
    });
    h.boot();
    h.tick(DT); // step 12 completes
    const before = h.rt.getInterpolatedState();
    if (!before.ok) throw new Error('state failed');
    const committedStepIndex = h.diag().stepIndex;
    expect(committedStepIndex).toBe(13);
    // Fail on the next step.
    h.tick(2 * DT);
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.failed).toBe(true);
    expect(d.failedModuleId).toBe('thirdlight.test:char-controller');
    expect(d.failedPhase).toBe('transform');
    expect(d.failedStepIndex).toBe(13);
    expect(d.stepIndex).toBe(committedStepIndex); // not advanced
    expect(d.errorCount).toBe(1);
    expect(d.errors[0]).toMatchObject({
      code: 'module_error',
      reason: 'module_threw',
      moduleId: 'thirdlight.test:char-controller',
      phase: 'transform',
      stepIndex: 13,
    });
    expect(d.errors[0]!.message).toContain('boom after mutation');
    expect(privateState).toBeGreaterThan(0);
    // Only the last committed state is observable (alpha 0).
    const after = h.rt.getInterpolatedState();
    if (!after.ok) throw new Error('state failed');
    expect(after.state.stepIndex).toBe(committedStepIndex);
    expect(after.state.alpha).toBe(0);
    expect(after.state.transforms).toEqual(before.state.transforms);
    // A failed instance cannot resume.
    const start = h.rt.start();
    expect(start.ok).toBe(false);
    if (!start.ok) expect(start.error.code).toBe('runtime_failed');
    const tick = h.rt.tick(3 * DT);
    expect(tick.ok).toBe(false);
    if (!tick.ok) expect(tick.error.code).toBe('runtime_failed');
    // stop() from failed is ok (there is no driver).
    expect(h.rt.stop().ok).toBe(true);
    h.rt.dispose();
  });

  it('a malformed port result or a port throw is physics_port_error (the invalid result is never applied)', () => {
    const spec = controllerSpec((phase, ctx) => {
      if (phase === 'controller') ctx.physics.stageCharacterMove('char-0001', { x: 1, y: 0 });
    });
    const malformed = makeFakePort({ malformed: true });
    const h1 = makeM2Runtime({ modules: [spec.id], specs: [spec], physics: malformed, actions: recordingSource() });
    // The pre-roll itself fails on the first port.step().
    h1.boot();
    const d1 = h1.diag();
    expect(d1.state).toBe('failed');
    expect(d1.errors[0]).toMatchObject({ code: 'physics_port_error', reason: 'result' });
    const st1 = h1.rt.getInterpolatedState();
    if (!st1.ok) throw new Error('state failed');
    expect(st1.state.transforms.find((t) => t.id === 'char-0001')!.position[1]).toBe(1); // authored, unapplied
    h1.rt.dispose();

    const thrower = makeFakePort({ throwOnStep: true });
    const h2 = makeM2Runtime({ modules: [spec.id], specs: [spec], physics: thrower, actions: recordingSource() });
    h2.boot();
    const d2 = h2.diag();
    expect(d2.state).toBe('failed');
    expect(d2.errors[0]).toMatchObject({ code: 'physics_port_error', reason: 'threw' });
    h2.rt.dispose();
  });

  it('stageCharacterMove outside the controller phase is a phase_violation fail-stop', () => {
    const spec = controllerSpec((phase, ctx) => {
      if (phase === 'transform') ctx.physics.stageCharacterMove('char-0001', { x: 1, y: 0 });
    });
    const h = makeM2Runtime({
      modules: [spec.id],
      specs: [spec],
      physics: makeFakePort(),
      actions: recordingSource(),
    });
    h.boot();
    const d = h.diag();
    expect(d.state).toBe('failed');
    expect(d.errors[0]).toMatchObject({ code: 'module_error', reason: 'phase_violation', phase: 'transform' });
    h.rt.dispose();
  });

  it('dispose from failed calls module and port dispose exactly once; repeated teardown is idempotent', () => {
    const spec = controllerSpec(() => {
      throw new Error('always fails');
    }, { dispose: undefined });
    let moduleDisposals = 0;
    const specWithDispose = controllerSpec(
      () => {
        throw new Error('always fails');
      },
      { dispose: () => (moduleDisposals += 1) },
    );
    let portDisposals = 0;
    const port = makeFakePort();
    const originalDispose = port.dispose.bind(port);
    port.dispose = (): void => {
      portDisposals += 1;
      originalDispose();
    };
    const h = makeM2Runtime({
      modules: [specWithDispose.id],
      specs: [specWithDispose],
      physics: port,
      actions: recordingSource(),
    });
    h.boot();
    expect(h.diag().state).toBe('failed');
    expect(h.rt.dispose().ok).toBe(true);
    expect(moduleDisposals).toBe(1);
    expect(portDisposals).toBe(1);
    const again = h.rt.dispose();
    expect(again).toEqual({ ok: true, alreadyDisposed: true });
    expect(moduleDisposals).toBe(1);
    expect(portDisposals).toBe(1);
    void spec;
  });

  it('safe restart: the snapshot is untouched and a fresh instance runs after disposal', () => {
    const spec = controllerSpec((phase) => {
      if (phase === 'transform') throw new Error('boom');
    });
    const snapshot = v2Snapshot();
    const before = JSON.stringify(snapshot);
    const h1 = makeM2Runtime({
      modules: [spec.id],
      specs: [spec],
      physics: makeFakePort(),
      actions: recordingSource(),
      snapshot,
    });
    h1.boot();
    expect(h1.diag().state).toBe('failed');
    expect(h1.rt.dispose().ok).toBe(true);
    // The snapshot stays deep-equal to its input.
    expect(JSON.stringify(snapshot)).toBe(before);

    const healthy = probeSpec({
      id: 'thirdlight.test:healthy',
      phases: ['transform'],
      owners: ['box-0001'],
      step: (_phase, ctx) => {
        ctx.state.curr.get('box-0001')!.position[0] = 1.25;
      },
    });
    const h2 = makeM2Runtime({
      modules: [healthy.id],
      specs: [healthy],
      actions: recordingSource(),
      snapshot,
    });
    h2.boot();
    h2.tick(DT);
    expect(h2.diag().state).toBe('running');
    expect(h2.diag().errorCount).toBe(0);
    const st = h2.rt.getInterpolatedState();
    if (!st.ok) throw new Error('state failed');
    expect(st.state.transforms.find((t) => t.id === 'box-0001')!.position[0]).toBe(1.25);
    h2.rt.dispose();
  });
});
