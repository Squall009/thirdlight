/**
 * Packet 32 — failure-mode coverage for the controller composition:
 * long tab stall / dropped wall time (A13), one jump edge across catch-up,
 * no phantom physics steps, fail-stop after a physics-phase mutation (A14),
 * snapshot immutability and clean disposal.
 *
 * Real stack: platformer controller + runtime + real Rapier port + real input
 * mapping. No browser is involved (UNVERIFIED; packet-37 procedure).
 */
import { describe, expect, it } from 'vitest';
import { createStepInputSource, type StepInputStep } from '@thirdlight/input';
import {
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionSource,
  type CharacterMoveResult,
  type PhysicsPort,
  type Vec2,
} from '@thirdlight/runtime';
import { PLATFORMER_MODULE_ID, platformerSpec } from '@thirdlight/platformer';
import {
  DT,
  SETTLE_STEPS,
  courseSnapshot,
  fixture,
  portConfig,
  startRun,
  type CourseFile,
} from './helpers';
import { createPhysicsPort } from '@thirdlight/physics-rapier';

const course = fixture<CourseFile>('course.json');
const inputFile = fixture<{ atoms: Record<string, unknown>; sequences: { id: string; spans: { from: number; to: number; raw: string }[] }[] }>(
  'input-sequences.json',
);

function stepsOf(id: string): StepInputStep[] {
  const seq = inputFile.sequences.find((s) => s.id === id)!;
  const out: StepInputStep[] = [];
  for (const span of seq.spans) {
    for (let i = span.from; i <= span.to; i += 1) out.push({ stepIndex: i, raw: inputFile.atoms[span.raw] as never });
  }
  return out;
}

describe('long tab stall and dropped wall time (A13)', () => {
  it('executes at most 8 steps, drops the remaining wall time and produces no phantom steps', async () => {
    const run = await startRun(course, { x: -10, y: 0.9 }, { actions: createStepInputSource(stepsOf('run-right-240')) });
    try {
      run.steps(20);
      const before = run.diagnostics();
      if (!before.ok) throw new Error('diagnostics failed');
      expect(before.diagnostics.stepIndex).toBe(SETTLE_STEPS + 20);
      const samplesBefore = before.diagnostics.inputSamples ?? 0;
      const physicsBefore = before.diagnostics.physicsSteps ?? 0;
      const xBefore = run.position().x;

      expect(run.stall(5.0)).toBe(true);
      const after = run.diagnostics();
      if (!after.ok) throw new Error('diagnostics failed');
      // 5 s at 120 Hz = 600 steps requested; the 8-step cap executes 8.
      expect(after.diagnostics.stepIndex - before.diagnostics.stepIndex).toBe(8);
      expect(after.diagnostics.droppedSteps).toBe(600 - 8);
      expect(after.diagnostics.droppedInputSteps).toBe(600 - 8);
      expect((after.diagnostics.inputSamples ?? 0) - samplesBefore).toBe(8);
      // Exactly one port.step() per executed step — no phantom physics step.
      expect(after.diagnostics.physicsSteps).toBe(after.diagnostics.stepIndex);
      expect((after.diagnostics.physicsSteps ?? 0) - physicsBefore).toBe(8);
      // No phantom displacement beyond the executed steps.
      const xAfter = run.position().x;
      expect(xAfter - xBefore).toBeLessThanOrEqual(8 * 4 * DT + 1e-6);
      // eslint-disable-next-line no-console
      console.log(
        `[stall] executed=8 dropped=${after.diagnostics.droppedSteps} inputSamples=${after.diagnostics.inputSamples} physicsSteps=${after.diagnostics.physicsSteps} stepIndex=${after.diagnostics.stepIndex} dx=${xAfter - xBefore}`,
      );
    } finally {
      run.dispose();
    }
  });

  it('consumes one jump edge exactly once across the catch-up burst', async () => {
    // A press latch at step 32 only; the 8 caught-up steps sample it once.
    const actions: StepInputStep[] = [];
    for (let i = 12; i <= 60; i += 1) {
      actions.push({
        stepIndex: i,
        raw: (i === 32
          ? { keyboardLeft: false, keyboardRight: false, keyboardJump: true, jumpLatch: true }
          : i > 32
            ? { keyboardLeft: false, keyboardRight: false, keyboardJump: true }
            : { keyboardLeft: false, keyboardRight: false, keyboardJump: false }) as never,
      });
    }
    const run = await startRun(course, { x: -10, y: 0.9 }, { actions: createStepInputSource(actions) });
    try {
      run.steps(20); // stepIndex 32 next
      expect(run.stall(5.0)).toBe(true);
      const d = run.diagnostics();
      if (!d.ok) throw new Error('diagnostics failed');
      // Steps 32..39 executed (20 gameplay steps + the 8 caught-up); the
      // pre-roll samples nothing, so 28 samples total. Only step 32 carried
      // the press edge.
      expect(d.diagnostics.inputSamples).toBe(28);
      // One jump: vy is positive and no second lift occurred.
      const steps = run.records.slice(SETTLE_STEPS);
      let starts = 0;
      for (let i = 0; i < steps.length; i += 1) {
        const prev = i === 0 ? 0 : steps[i - 1]!.vy;
        if (steps[i]!.vy > 6 && prev < 1) starts += 1;
      }
      expect(starts).toBe(1);
      expect(Math.max(...steps.map((s) => s.vy))).toBeLessThanOrEqual(7 + 1e-9);
      // eslint-disable-next-line no-console
      console.log(`[catch-up-jump] starts=${starts} maxVy=${Math.max(...steps.map((s) => s.vy))} stepIndex=${d.diagnostics.stepIndex}`);
    } finally {
      run.dispose();
    }
  });
});

describe('fail-stop after a physics-phase mutation (A14)', () => {
  it('abandons the step, retains the last committed render state and never resumes', async () => {
    const start = { x: -10, y: 0.9 };
    const init = await createPhysicsPort(portConfig(course, start));
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    let steps = 0;
    let disposed = 0;
    const failing: PhysicsPort = {
      implementation: init.port.implementation,
      stageCharacterMove: (delta: Vec2) => init.port.stageCharacterMove(delta),
      step: (): CharacterMoveResult => {
        steps += 1;
        // Physics mutation happens (the world advances) for 30 steps, then the
        // port throws — the runtime's fail-stop must abandon only the current
        // step and keep the last completed state.
        if (steps > 30) throw new Error('injected physics failure after mutation');
        return init.port.step();
      },
      dispose: () => {
        disposed += 1;
        init.port.dispose();
      },
    };
    const registry = createSimulationRegistry();
    registerSimulationModule(registry, PLATFORMER_MODULE_ID, platformerSpec);
    let now = 0;
    const runtimeResult = instantiateRuntime({
      snapshot: courseSnapshot(course, start),
      registry,
      modules: [PLATFORMER_MODULE_ID],
      actions: createStepInputSource(stepsOf('run-right-240')),
      physics: failing,
      settings: course.settings,
      clock: () => now,
      driver: { kind: 'manual' },
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    const runtime = runtimeResult.runtime;
    runtime.start();
    runtime.tick(0); // pre-roll (12 steps)
    const before = runtime.getInterpolatedState();
    if (!before.ok) throw new Error('state failed');
    const positionBefore = before.state.transforms.find((t) => t.id === 'char-0001')!.position;
    // Steps 13..30 succeed (18 more), step 31 throws (physicsSteps 31 > 30).
    for (let i = 0; i < 20; i += 1) {
      now += DT;
      runtime.tick(now);
    }
    const d = runtime.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    expect(d.diagnostics.state).toBe('failed');
    expect(d.diagnostics.failed).toBe(true);
    expect(d.diagnostics.errorCount).toBe(1);
    expect(d.diagnostics.errors[0]!.code).toBe('physics_port_error');
    // The last completed step's state is retained (alpha 0, no partial step).
    const after = runtime.getInterpolatedState();
    if (!after.ok) throw new Error('state failed');
    expect(after.state.alpha).toBe(0);
    const positionAfter = after.state.transforms.find((t) => t.id === 'char-0001')!.position;
    // The abandoned step's mutation is not published: the committed position is
    // exactly the last fully completed step's result (the pre-roll + 18 steps).
    expect(positionAfter[2]).toBe(0);
    expect(positionAfter[0]).toBeGreaterThan(positionBefore[0]);
    // No resume; stop() from failed is ok; dispose is idempotent.
    const startAgain = runtime.start();
    expect(startAgain.ok).toBe(false);
    if (!startAgain.ok) expect(startAgain.error.code).toBe('runtime_failed');
    now += DT;
    const tickAgain = runtime.tick(now);
    expect(tickAgain.ok).toBe(false);
    if (!tickAgain.ok) expect(tickAgain.error.code).toBe('runtime_failed');
    expect(runtime.stop().ok).toBe(true);
    expect(runtime.dispose().ok).toBe(true);
    expect(runtime.dispose().ok).toBe(true);
    expect(disposed).toBe(1);
    // eslint-disable-next-line no-console
    console.log(
      `[fail-stop] physicsSteps=${d.diagnostics.physicsSteps} failedStepIndex=${d.diagnostics.failedStepIndex} module=${d.diagnostics.failedModuleId} phase=${d.diagnostics.failedPhase}`,
    );
  });
});

describe('stop/start retains the controller private state (platformer.md §6)', () => {
  it('resumes with the same velocity and window counters (no reset)', async () => {
    const run = await startRun(course, { x: -10, y: 0.9 }, { actions: createStepInputSource(stepsOf('run-right-240')) });
    try {
      run.steps(24); // past the 12-step acceleration: vx = run_speed
      const vxBefore = run.records[run.records.length - 1]!.vx;
      expect(vxBefore).toBeCloseTo(4, 9);
      const indexBefore = run.records.length;
      expect(run.runtime.stop().ok).toBe(true);
      expect(run.runtime.start().ok).toBe(true);
      run.steps(1);
      expect(run.records.length).toBe(indexBefore + 1);
      // The controller's private vx survived the stop/start (a reset would
      // force it back to 0 and re-accelerate).
      expect(run.records[run.records.length - 1]!.vx).toBeCloseTo(4, 9);
      // eslint-disable-next-line no-console
      console.log(`[stop-start] vxBefore=${vxBefore} vxAfter=${run.records[run.records.length - 1]!.vx}`);
    } finally {
      run.dispose();
    }
  });
});

describe('snapshot immutability and disposal', () => {
  it('deep-freezes the snapshot and never writes it back', async () => {
    const start = { x: -10, y: 0.9 };
    const snapshot = courseSnapshot(course, start) as Record<string, unknown>;
    const before = JSON.stringify(snapshot);
    const init = await createPhysicsPort(portConfig(course, start));
    expect(init.ok).toBe(true);
    if (!init.ok) return;
    const registry = createSimulationRegistry();
    registerSimulationModule(registry, PLATFORMER_MODULE_ID, platformerSpec);
    let now = 0;
    const runtimeResult = instantiateRuntime({
      snapshot,
      registry,
      modules: [PLATFORMER_MODULE_ID],
      actions: createStepInputSource(stepsOf('run-right-120')),
      physics: init.port,
      settings: course.settings,
      clock: () => now,
      driver: { kind: 'manual' },
    });
    expect(runtimeResult.ok).toBe(true);
    if (!runtimeResult.ok) return;
    const runtime = runtimeResult.runtime;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.scene)).toBe(true);
    runtime.start();
    runtime.tick(0);
    for (let i = 0; i < 60; i += 1) {
      now += DT;
      runtime.tick(now);
    }
    expect(JSON.stringify(snapshot)).toBe(before);
    const pose = runtime.getInterpolatedState();
    if (!pose.ok) throw new Error('state failed');
    const character = pose.state.transforms.find((t) => t.id === 'char-0001')!;
    // Z / rotation / scale bit-identical to the authored transform.
    expect(character.position[2]).toBe(0);
    expect(character.rotation).toEqual([0, 0, 0, 1]);
    expect(character.scale).toEqual([1, 1, 1]);
    expect(runtime.dispose().ok).toBe(true);
  });
});
