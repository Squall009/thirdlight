/**
 * Packet 29 — runtime fixture replay (integration of the fixture tree with
 * the real `@thirdlight/runtime` build).
 *
 * This suite reads the accepted packet-17 fixture
 * (`fixtures/m2/contracts/runtime/catchup.json`) and the new packet-29
 * fixtures (`fixtures/m2/runtime/**`) from disk and replays every case
 * through the runtime: the fixed-step/sampling arithmetic, the ownership and
 * unsupported-combination table, the frozen M1 §7.1 demo points and the
 * fail-stop outcomes. The fixtures are the expectations; nothing here invents
 * a result.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_MODULES,
  createRecordedActionSource,
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionFrame,
  type PhysicsPort,
  type Runtime,
  type SimulationModuleSpec,
} from '@thirdlight/runtime';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolveRepo(HERE);

function resolveRepo(start: string): string {
  // tests/m2-runtime -> repository root
  return join(start, '..', '..');
}

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
}

const DT = 1 / 120;

function v2Scene(controllerCount = 1): any {
  const transform = (position: number[]): any => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  const entities: any[] = [
    {
      id: 'camera-0001',
      components: { transform: transform([0, 0.5, 4]), camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } },
    },
    { id: 'floor-0001', components: { transform: transform([0, -0.3, 0]), collider: { shape: { type: 'box', hx: 8, hy: 0.3 } } } },
    { id: 'box-0001', components: { transform: transform([0.5, 0.5, 0]), box: { size: [0.2, 0.2, 0.2], material: { color: '#ff8800' } } } },
  ];
  for (let i = 0; i < controllerCount; i += 1) {
    entities.push({ id: `char-${String(i + 1).padStart(4, '0')}`, components: { transform: transform([0, 1, 0]), controller: {} } });
  }
  return { schemaVersion: 2, sceneId: 'scene-main', revision: 4, entities };
}

function snapshot(scene: any, projectId = 'demo-0001'): any {
  return { snapshotId: `${projectId}@r${scene.revision}`, projectId, revision: scene.revision, scene };
}

/** A valid normalized schemaVersion 1 scene (accepted M1 shape). */
function v1Scene(): any {
  const transform = (position: number[]): any => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  return {
    schemaVersion: 1,
    sceneId: 'scene-main',
    revision: 4,
    entities: [
      { id: 'cam-main', components: { transform: transform([0, 0.5, 4]), camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } },
      { id: 'box-0001', components: { transform: transform([0.5, 0.5, 0]), box: { size: [0.2, 0.2, 0.2], material: { color: '#ff8800' } } } },
    ],
  };
}

function fakePort(): PhysicsPort {
  let pos = { x: 0, y: 1 };
  let pending = { x: 0, y: 0 };
  return {
    stageCharacterMove(delta) {
      pending = { x: delta.x, y: delta.y };
    },
    step() {
      const requested = { ...pending };
      pending = { x: 0, y: 0 };
      const target = { x: pos.x + requested.x, y: pos.y + requested.y };
      const applied = { x: target.x - pos.x, y: target.y - pos.y };
      pos = target;
      return {
        requested,
        applied,
        position: { ...target },
        grounded: true,
        supportNormal: { x: 0, y: 1 },
        contacts: { ground: true, wall: false, head: false, steepSlope: false },
        snapped: false,
      };
    },
    dispose() {},
  };
}

interface Harness {
  rt: Runtime;
  diag: () => any;
  tick: (t: number) => void;
  boot: () => void;
  sampled: ActionFrame[];
}

function makeRuntime(specs: readonly SimulationModuleSpec[], modules: string[]): Harness {
  const registry = createSimulationRegistry();
  for (const spec of specs) {
    const res = registerSimulationModule(registry, spec.id, spec);
    if (!res.ok) throw new Error(`register ${spec.id}: ${JSON.stringify(res.error)}`);
  }
  const res = instantiateRuntime({
    snapshot: snapshot(v2Scene(1)),
    registry,
    modules,
    driver: { kind: 'manual' },
    clock: () => 0,
    ...(modules.some((m) => specs.find((s) => s.id === m)?.requiresPhysicsPort) ? { physics: fakePort() } : {}),
  });
  if (!res.ok) throw new Error(`instantiate: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  const sampled: ActionFrame[] = [];
  const diag = (): any => {
    const d = rt.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    return d.diagnostics;
  };
  return {
    rt,
    sampled,
    diag,
    tick: (t) => {
      const r = rt.tick(t);
      if (!r.ok) throw new Error(`tick: ${JSON.stringify(r.error)}`);
    },
    boot: () => {
      const s = rt.start();
      if (!s.ok) throw new Error(`start: ${JSON.stringify(s.error)}`);
      const r = rt.tick(0); // pre-roll frame
      if (!r.ok) throw new Error(`boot: ${JSON.stringify(r.error)}`);
    },
  };
}

function intentTracer(seen: ActionFrame[]): SimulationModuleSpec {
  return {
    id: 'thirdlight.test:fixture-tracer',
    phases: ['intent'],
    create() {
      return {
        transformOwners: [],
        step(phase, ctx) {
          seen.push({ ...ctx.action });
        },
      };
    },
  };
}

function replaySchedule(
  frames: ReadonlyArray<{ elapsed: number }>,
  recorded: readonly ActionFrame[],
  preRollInFirstFrame: boolean,
): { stepIndex: number; droppedSteps: number; droppedInputSteps: number; sampleCalls: number[]; sampled: ActionFrame[] } {
  const seen: ActionFrame[] = [];
  const sampleCalls: number[] = [];
  const spec = intentTracer(seen);
  const registry = createSimulationRegistry();
  registerSimulationModule(registry, spec.id, spec);
  const source = createRecordedActionSource(recorded);
  const res = instantiateRuntime({
    snapshot: snapshot(v2Scene(1)),
    registry,
    modules: [spec.id],
    driver: { kind: 'manual' },
    clock: () => 0,
    actions: {
      sample: (n) => {
        sampleCalls.push(n);
        return source.sample(n);
      },
    },
  });
  if (!res.ok) throw new Error('instantiate failed');
  const rt = res.runtime;
  rt.start();
  if (!preRollInFirstFrame) rt.tick(0); // settle pre-roll frame before the listed frames
  let t = 0;
  for (const frame of frames) {
    t += frame.elapsed;
    const r = rt.tick(t);
    if (!r.ok) throw new Error('tick failed');
  }
  const d = rt.getDiagnostics();
  if (!d.ok) throw new Error('diagnostics failed');
  const out = {
    stepIndex: d.diagnostics.stepIndex,
    droppedSteps: d.diagnostics.droppedSteps,
    droppedInputSteps: d.diagnostics.droppedInputSteps ?? 0,
    sampleCalls,
    sampled: seen,
  };
  rt.dispose();
  return out;
}

describe('accepted packet-17 scheduler fixture (fixtures/m2/contracts/runtime/catchup.json)', () => {
  const doc = readJson('fixtures/m2/contracts/runtime/catchup.json');
  for (const c of doc.cases) {
    it(`${c.caseId}: ${c.title}`, () => {
      const recorded = (c.expect.recordedFrames ?? []) as ActionFrame[];
      const out = replaySchedule(c.frames, recorded, (c.preRollSteps ?? 0) > 0);
      expect(out.stepIndex).toBe(c.expect.stepIndexEnd);
      expect(out.droppedSteps).toBe(c.expect.droppedSteps);
      expect(out.sampleCalls).toEqual(c.expect.sampledStepIndices);
      expect(out.droppedInputSteps).toBe(c.expect.droppedSteps);
      if (c.expect.pressedCount !== undefined) {
        const pressed = out.sampled.filter((f) => f.jump === 'pressed');
        expect(pressed).toHaveLength(c.expect.pressedCount);
        if (pressed.length > 0) expect(pressed[0]!.stepIndex).toBe(c.expect.pressedAtStepIndex);
      }
      // No dropped step was sampled and every executed step was sampled once.
      expect(out.sampleCalls.length).toBe(new Set(out.sampleCalls).size);
      for (let i = 1; i < out.sampleCalls.length; i += 1) {
        expect(out.sampleCalls[i]).toBe(out.sampleCalls[i - 1] + 1);
      }
    });
  }

  it('ownership/combination table (O1–O8)', () => {
    for (const c of doc.ownershipCases) {
      const specs: SimulationModuleSpec[] = [];
      const owners = c.owners ?? {};
      for (const [moduleId, entityIds] of Object.entries(owners as Record<string, string[]>)) {
        const isController = moduleId.includes('platformer');
        specs.push({
          id: moduleId,
          phases: isController ? ['controller', 'transform'] : ['transform'],
          ...(isController ? { requiresPhysicsPort: true } : {}),
          create() {
            return { transformOwners: entityIds, step() {} };
          },
        });
      }
      for (const moduleId of c.modules as string[]) {
        if (specs.some((s) => s.id === moduleId)) continue;
        const isController = moduleId.includes('platformer');
        specs.push({
          id: moduleId,
          phases: isController ? ['controller', 'transform'] : ['transform'],
          ...(isController ? { requiresPhysicsPort: true } : {}),
          ...(c.caseId === 'O6-module-combination' && moduleId === 'thirdlight.demo:box-motion'
            ? { excludes: ['thirdlight.platformer:controller'] }
            : {}),
          create() {
            return { transformOwners: [], step() {} };
          },
        });
      }
      const registry = createSimulationRegistry();
      for (const spec of specs) {
        const r = registerSimulationModule(registry, spec.id, spec);
        if (!r.ok && spec.phases !== undefined) throw new Error(`register ${spec.id}: ${JSON.stringify(r.error)}`);
      }
      const controllerCount = c.scene?.controllerCount === undefined ? 1 : c.scene.controllerCount;
      const scene = c.scene?.schemaVersion === 1 ? v1Scene() : v2Scene(controllerCount);
      const res = instantiateRuntime({
        snapshot: snapshot(scene),
        registry,
        modules: c.modules,
        driver: { kind: 'manual' },
        clock: () => 0,
        ...(c.modules.some((m: string) => m.includes('platformer')) ? { physics: fakePort() } : {}),
      });
      if (c.outcome === 'ok') {
        expect(res.ok, `${c.caseId} expected ok`).toBe(true);
        if (res.ok) res.runtime.dispose();
      } else {
        expect(res.ok, `${c.caseId} expected an error`).toBe(false);
        if (!res.ok) {
          expect(res.error.code, c.caseId).toBe(c.code);
          if (c.reason !== undefined) expect(res.error.reason, c.caseId).toBe(c.reason);
          else if (c.code !== 'module_combination_unsupported') expect(res.error.reason, c.caseId).toBeUndefined();
          if (c.sceneErrorCode !== undefined) {
            expect(res.error.errors?.[0]?.code, c.caseId).toBe(c.sceneErrorCode);
          }
        }
      }
    }
  });
});

describe('packet-29 scheduler fixtures (fixtures/m2/runtime/scheduler-traces.json)', () => {
  const doc = readJson('fixtures/m2/runtime/scheduler-traces.json');
  for (const c of doc.cases) {
    it(`${c.caseId}`, () => {
      const recorded = (c.recordedFrames ?? []) as ActionFrame[];
      const out = replaySchedule(c.frames, recorded, (c.preRollSteps ?? 0) > 0);
      expect(out.stepIndex).toBe(c.expect.stepIndex);
      expect(out.droppedSteps).toBe(c.expect.droppedSteps);
      expect(out.droppedInputSteps).toBe(c.expect.droppedSteps);
      expect(out.sampleCalls).toEqual(c.expect.sampledStepIndices);
      if (c.expect.pressedCount !== undefined) {
        const pressed = out.sampled.filter((f) => f.jump === 'pressed');
        expect(pressed).toHaveLength(c.expect.pressedCount);
        if (pressed.length > 0) expect(pressed[0]!.stepIndex).toBe(c.expect.pressedAtStepIndex);
      }
    });
  }
});

describe('frozen M1 demo points (fixtures/m2/runtime/demo-traces.json)', () => {
  const doc = readJson('fixtures/m2/runtime/demo-traces.json');
  it('reproduces every §7.1 exact point bit-for-bit', () => {
    const registry = createSimulationRegistry();
    for (const spec of BUILTIN_MODULES) registerSimulationModule(registry, spec.id, spec);
    const res = instantiateRuntime({
      snapshot: snapshot(v1Scene()),
      registry,
      driver: { kind: 'manual' },
      clock: () => 0,
    });
    if (!res.ok) throw new Error('instantiate failed');
    const rt = res.runtime;
    rt.start();
    rt.tick(0);
    const maxStep = doc.samples[doc.samples.length - 1].completedSteps;
    let next = 0;
    for (let step = 0; step <= maxStep; step += 1) {
      if (step > 0) {
        const r = rt.tick(step * DT);
        if (!r.ok) throw new Error('tick failed');
      }
      const sample = doc.samples[next];
      if (sample && step === sample.completedSteps) {
        const st = rt.getInterpolatedState();
        if (!st.ok) throw new Error('state failed');
        const x = st.state.transforms.find((t) => t.id === doc.entityId)!.position[0];
        expect(x, `stepIndex ${step}`).toBe(sample.x);
        next += 1;
      }
    }
    expect(next).toBe(doc.samples.length);
    rt.dispose();
  });
});

describe('fail-stop fixture cases (fixtures/m2/runtime/failstop.json)', () => {
  const doc = readJson('fixtures/m2/runtime/failstop.json');
  const byScenario = new Map<string, any>(doc.cases.map((c: any) => [c.scenario, c]));

  function expectCase(scenario: string): any {
    const c = byScenario.get(scenario);
    if (!c) throw new Error(`no fixture case for scenario ${scenario}`);
    return c;
  }

  it('module_throw_after_mutation: fail-stop, last committed state only, no resume', () => {
    const c = expectCase('module_throw_after_mutation');
    let mutated = false;
    const spec: SimulationModuleSpec = {
      id: 'thirdlight.test:thrower',
      phases: ['controller', 'transform'],
      requiresPhysicsPort: true,
      create() {
        return {
          transformOwners: ['char-0001'],
          step(phase, ctx) {
            if (phase === 'transform' && ctx.stepIndex >= 13) {
              ctx.state.curr.get('char-0001')!.position[0] = 9;
              mutated = true;
              throw new Error('boom');
            }
          },
        };
      },
    };
    const h = makeRuntime([spec], [spec.id]);
    const registry = createSimulationRegistry();
    registerSimulationModule(registry, spec.id, spec);
    const res = instantiateRuntime({
      snapshot: snapshot(v2Scene(1)),
      registry,
      modules: [spec.id],
      driver: { kind: 'manual' },
      clock: () => 0,
      physics: fakePort(),
    });
    if (!res.ok) throw new Error('instantiate failed');
    const rt = res.runtime;
    rt.start();
    rt.tick(0);
    rt.tick(DT); // step 12 ok
    const st1 = rt.getInterpolatedState();
    if (!st1.ok) throw new Error('state failed');
    rt.tick(2 * DT); // step 13 throws
    const d = rt.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    expect(mutated).toBe(true);
    expect(d.diagnostics.state).toBe(c.expect.state);
    expect(d.diagnostics.errors[0].code).toBe(c.expect.code);
    expect(d.diagnostics.errors[0].reason).toBe(c.expect.reason);
    expect(d.diagnostics.failedPhase).toBe(c.expect.failedPhase);
    const st2 = rt.getInterpolatedState();
    if (!st2.ok) throw new Error('state failed');
    expect(st2.state.transforms).toEqual(st1.state.transforms); // the 9 is not observable
    expect(rt.start().ok).toBe(false);
    expect(rt.tick(3 * DT).ok).toBe(false);
    rt.dispose();
    void h;
  });

  it('first_step_transform_throw (F1b): a fail-stop on pre-roll step 0 never publishes the abandoned transform', () => {
    const c = expectCase('first_step_transform_throw');
    const expectInitial = [0, 1, 0];

    const bootFailing = (spec: SimulationModuleSpec, port: PhysicsPort): Runtime => {
      const registry = createSimulationRegistry();
      registerSimulationModule(registry, spec.id, spec);
      const res = instantiateRuntime({
        snapshot: snapshot(v2Scene(1)),
        registry,
        modules: [spec.id],
        driver: { kind: 'manual' },
        clock: () => 0,
        physics: port,
      });
      if (!res.ok) throw new Error('instantiate failed');
      const rt = res.runtime;
      rt.start();
      rt.tick(0); // the settle pre-roll fails on its first step
      return rt;
    };

    // (a) a transform-phase mutation followed by a throw on step 0.
    const mutating: SimulationModuleSpec = {
      id: 'thirdlight.test:first-step-thrower',
      phases: ['controller', 'transform'],
      requiresPhysicsPort: true,
      create() {
        return {
          transformOwners: ['char-0001'],
          step(phase, ctx) {
            if (phase === 'transform' && ctx.stepIndex === 0) {
              ctx.state.curr.get('char-0001')!.position[0] = 9;
              throw new Error('boom at step 0');
            }
          },
        };
      },
    };
    const rt1 = bootFailing(mutating, fakePort());
    const d1 = rt1.getDiagnostics();
    if (!d1.ok) throw new Error('diagnostics failed');
    expect(d1.diagnostics.state).toBe(c.expect.state);
    expect(d1.diagnostics.errors[0].code).toBe(c.expect.code);
    expect(d1.diagnostics.errors[0].reason).toBe(c.expect.reason);
    expect(d1.diagnostics.failedPhase).toBe(c.expect.failedPhase);
    expect(d1.diagnostics.failedStepIndex).toBe(c.expect.failedStepIndex);
    expect(d1.diagnostics.stepIndex).toBe(0);
    const st1 = rt1.getInterpolatedState();
    if (!st1.ok) throw new Error('state failed');
    expect(st1.state.stepIndex).toBe(0); // no step committed
    expect(st1.state.alpha).toBe(0);
    // The abandoned x = 9 is never observable: the committed initial state is rendered.
    expect(st1.state.transforms.find((t) => t.id === 'char-0001')!.position).toEqual(expectInitial);
    expect(rt1.tick(DT).ok).toBe(false);
    rt1.dispose();

    // (b) the port's step-0 result was committed to `curr`, then transform threw.
    const afterPortCommit: SimulationModuleSpec = {
      ...mutating,
      id: 'thirdlight.test:port-commit-thrower',
      create() {
        return {
          transformOwners: ['char-0001'],
          step(phase, ctx) {
            if (phase === 'controller') ctx.physics.stageCharacterMove('char-0001', { x: 1, y: 0 });
            if (phase === 'transform' && ctx.stepIndex === 0) throw new Error('boom after port commit');
          },
        };
      },
    };
    let portSteps = 0;
    const basePort = fakePort();
    const movingPort: PhysicsPort = {
      stageCharacterMove: (delta) => basePort.stageCharacterMove(delta),
      step: () => {
        portSteps += 1;
        return basePort.step();
      },
      dispose: () => basePort.dispose(),
    };
    const rt2 = bootFailing(afterPortCommit, movingPort);
    expect(portSteps).toBe(1); // the port's step-0 result reached the physics phase
    const st2 = rt2.getInterpolatedState();
    if (!st2.ok) throw new Error('state failed');
    expect(st2.state.transforms.find((t) => t.id === 'char-0001')!.position).toEqual(expectInitial);
    rt2.dispose();
  });

  it('port_malformed / port_throw', () => {
    const c1 = expectCase('port_malformed');
    const spec: SimulationModuleSpec = {
      id: 'thirdlight.test:port',
      phases: ['controller', 'transform'],
      requiresPhysicsPort: true,
      create() {
        return { transformOwners: ['char-0001'], step() {} };
      },
    };
    const badPort: PhysicsPort = {
      stageCharacterMove() {},
      step() {
        return {
          requested: { x: 0, y: 0 },
          applied: { x: 1, y: 0 },
          position: { x: 1, y: 1 },
          grounded: true,
          supportNormal: { x: 0, y: 1 },
          contacts: { ground: true, wall: false, head: false, steepSlope: false },
          snapped: false,
        };
      },
      dispose() {},
    };
    const registry1 = createSimulationRegistry();
    registerSimulationModule(registry1, spec.id, spec);
    const res1 = instantiateRuntime({
      snapshot: snapshot(v2Scene(1)),
      registry: registry1,
      modules: [spec.id],
      driver: { kind: 'manual' },
      clock: () => 0,
      physics: badPort,
    });
    if (!res1.ok) throw new Error('instantiate failed');
    res1.runtime.start();
    res1.runtime.tick(0);
    const d1 = res1.runtime.getDiagnostics();
    if (!d1.ok) throw new Error('diagnostics failed');
    expect(d1.diagnostics.state).toBe(c1.expect.state);
    expect(d1.diagnostics.errors[0].code).toBe(c1.expect.code);
    expect(d1.diagnostics.errors[0].reason).toBe(c1.expect.reason);
    res1.runtime.dispose();

    const c2 = expectCase('port_throw');
    const throwing: PhysicsPort = {
      stageCharacterMove() {},
      step() {
        throw new Error('nope');
      },
      dispose() {},
    };
    const registry2 = createSimulationRegistry();
    registerSimulationModule(registry2, spec.id, spec);
    const res2 = instantiateRuntime({
      snapshot: snapshot(v2Scene(1)),
      registry: registry2,
      modules: [spec.id],
      driver: { kind: 'manual' },
      clock: () => 0,
      physics: throwing,
    });
    if (!res2.ok) throw new Error('instantiate failed');
    res2.runtime.start();
    res2.runtime.tick(0);
    const d2 = res2.runtime.getDiagnostics();
    if (!d2.ok) throw new Error('diagnostics failed');
    expect(d2.diagnostics.errors[0].code).toBe(c2.expect.code);
    expect(d2.diagnostics.errors[0].reason).toBe(c2.expect.reason);
    res2.runtime.dispose();
  });

  it('stage_outside_controller / write_curr_in_intent are phase violations', () => {
    for (const scenario of ['stage_outside_controller', 'write_curr_in_intent']) {
      const c = expectCase(scenario);
      const spec: SimulationModuleSpec = {
        id: 'thirdlight.test:guard',
        phases: ['intent', 'controller', 'transform'],
        requiresPhysicsPort: true,
        create() {
          return {
            transformOwners: ['char-0001'],
            step(phase, ctx) {
              if (scenario === 'stage_outside_controller' && phase === 'transform') {
                ctx.physics.stageCharacterMove('char-0001', { x: 1, y: 0 });
              }
              if (scenario === 'write_curr_in_intent' && phase === 'intent') {
                ctx.state.curr.get('char-0001')!.position[0] = 1;
              }
            },
          };
        },
      };
      const registry = createSimulationRegistry();
      registerSimulationModule(registry, spec.id, spec);
      const res = instantiateRuntime({
        snapshot: snapshot(v2Scene(1)),
        registry,
        modules: [spec.id],
        driver: { kind: 'manual' },
        clock: () => 0,
        physics: fakePort(),
      });
      if (!res.ok) throw new Error('instantiate failed');
      res.runtime.start();
      res.runtime.tick(0);
      const d = res.runtime.getDiagnostics();
      if (!d.ok) throw new Error('diagnostics failed');
      expect(d.diagnostics.state, scenario).toBe(c.expect.state);
      expect(d.diagnostics.errors[0].code, scenario).toBe(c.expect.code);
      expect(d.diagnostics.errors[0].reason, scenario).toBe(c.expect.reason);
      res.runtime.dispose();
    }
  });

  it('duplicate_writer_registration / module_order_mismatch / unsupported_combination / missing_physics_port / controller_target / scene_version', () => {
    const dup = expectCase('duplicate_writer_registration');
    const dupA: SimulationModuleSpec = { id: 'thirdlight.test:a', phases: ['transform'], create: () => ({ transformOwners: ['box-0001'], step() {} }) };
    const dupB: SimulationModuleSpec = { id: 'thirdlight.test:b', phases: ['transform'], create: () => ({ transformOwners: ['box-0001'], step() {} }) };
    const regDup = createSimulationRegistry();
    registerSimulationModule(regDup, dupA.id, dupA);
    registerSimulationModule(regDup, dupB.id, dupB);
    const resDup = instantiateRuntime({ snapshot: snapshot(v2Scene(1)), registry: regDup, modules: [dupA.id, dupB.id], driver: { kind: 'manual' }, clock: () => 0 });
    expect(resDup.ok).toBe(false);
    if (!resDup.ok) expect(resDup.error.code).toBe(dup.expect.code);

    const order = expectCase('module_order_mismatch');
    const regOrder = createSimulationRegistry();
    const badSpec: SimulationModuleSpec = { id: 'thirdlight.test:bad', phases: ['transform', 'intent'] as never, create: () => ({ transformOwners: [], step() {} }) };
    const regOrderRes = registerSimulationModule(regOrder, badSpec.id, badSpec);
    expect(regOrderRes.ok).toBe(false);
    if (!regOrderRes.ok) {
      expect(regOrderRes.error.code).toBe(order.expect.code);
      expect(regOrderRes.error.reason).toBe(order.expect.reason);
    }

    const combo = expectCase('unsupported_combination');
    const regCombo = createSimulationRegistry();
    const demo: SimulationModuleSpec = {
      id: 'thirdlight.demo:box-motion',
      phases: ['transform'],
      excludes: ['thirdlight.platformer:controller'],
      create: () => ({ transformOwners: [], step() {} }),
    };
    const platformer: SimulationModuleSpec = {
      id: 'thirdlight.platformer:controller',
      phases: ['controller', 'transform'],
      requiresPhysicsPort: true,
      create: () => ({ transformOwners: ['char-0001'], step() {} }),
    };
    registerSimulationModule(regCombo, demo.id, demo);
    registerSimulationModule(regCombo, platformer.id, platformer);
    const resCombo = instantiateRuntime({
      snapshot: snapshot(v2Scene(1)),
      registry: regCombo,
      modules: [demo.id, platformer.id],
      driver: { kind: 'manual' },
      clock: () => 0,
      physics: fakePort(),
    });
    expect(resCombo.ok).toBe(false);
    if (!resCombo.ok) expect(resCombo.error.code).toBe(combo.expect.code);

    const missing = expectCase('missing_physics_port');
    const regMissing = createSimulationRegistry();
    registerSimulationModule(regMissing, platformer.id, platformer);
    const resMissing = instantiateRuntime({ snapshot: snapshot(v2Scene(1)), registry: regMissing, modules: [platformer.id], driver: { kind: 'manual' }, clock: () => 0 });
    expect(resMissing.ok).toBe(false);
    if (!resMissing.ok) {
      expect(resMissing.error.code).toBe(missing.expect.code);
      expect(resMissing.error.reason).toBe(missing.expect.reason);
    }

    const target = expectCase('controller_target');
    const regTarget = createSimulationRegistry();
    registerSimulationModule(regTarget, platformer.id, platformer);
    const resTarget = instantiateRuntime({
      snapshot: snapshot(v2Scene(0)),
      registry: regTarget,
      modules: [platformer.id],
      driver: { kind: 'manual' },
      clock: () => 0,
      physics: fakePort(),
    });
    expect(resTarget.ok).toBe(false);
    if (!resTarget.ok) {
      expect(resTarget.error.code).toBe(target.expect.code);
      expect(resTarget.error.reason).toBe(target.expect.reason);
    }

    const version = expectCase('scene_version');
    const regVersion = createSimulationRegistry();
    registerSimulationModule(regVersion, platformer.id, platformer);
    const resVersion = instantiateRuntime({
      snapshot: snapshot(v1Scene()),
      registry: regVersion,
      modules: [platformer.id],
      driver: { kind: 'manual' },
      clock: () => 0,
      physics: fakePort(),
    });
    expect(resVersion.ok).toBe(false);
    if (!resVersion.ok) {
      expect(resVersion.error.code).toBe(version.expect.code);
      expect(resVersion.error.reason).toBe(version.expect.reason);
    }
  });

  it('dispose_idempotent / restart_after_failure', () => {
    const disposeCase = expectCase('dispose_idempotent');
    let moduleDisposals = 0;
    let portDisposals = 0;
    const spec: SimulationModuleSpec = {
      id: 'thirdlight.test:failing',
      phases: ['controller', 'transform'],
      requiresPhysicsPort: true,
      create() {
        return {
          transformOwners: ['char-0001'],
          step() {
            throw new Error('always');
          },
          dispose() {
            moduleDisposals += 1;
          },
        };
      },
    };
    const port = fakePort();
    const originalDispose = port.dispose.bind(port);
    port.dispose = () => {
      portDisposals += 1;
      originalDispose();
    };
    const registry = createSimulationRegistry();
    registerSimulationModule(registry, spec.id, spec);
    const res = instantiateRuntime({
      snapshot: snapshot(v2Scene(1)),
      registry,
      modules: [spec.id],
      driver: { kind: 'manual' },
      clock: () => 0,
      physics: port,
    });
    if (!res.ok) throw new Error('instantiate failed');
    res.runtime.start();
    res.runtime.tick(0);
    expect(res.runtime.dispose().ok).toBe(true);
    expect(moduleDisposals).toBe(disposeCase.expect.moduleDisposals);
    expect(portDisposals).toBe(disposeCase.expect.portDisposals);
    expect(res.runtime.dispose()).toEqual({ ok: true, alreadyDisposed: disposeCase.expect.repeatDispose.alreadyDisposed });
    expect(moduleDisposals).toBe(1);

    const restart = expectCase('restart_after_failure');
    const snapshotObj = snapshot(v2Scene(1));
    const before = JSON.stringify(snapshotObj);
    const failing: SimulationModuleSpec = {
      id: 'thirdlight.test:failing2',
      phases: ['transform'],
      create() {
        return {
          transformOwners: ['box-0001'],
          step() {
            throw new Error('always');
          },
        };
      },
    };
    const reg1 = createSimulationRegistry();
    registerSimulationModule(reg1, failing.id, failing);
    const r1 = instantiateRuntime({ snapshot: snapshotObj, registry: reg1, modules: [failing.id], driver: { kind: 'manual' }, clock: () => 0 });
    if (!r1.ok) throw new Error('instantiate failed');
    r1.runtime.start();
    r1.runtime.tick(0);
    expect(r1.runtime.getDiagnostics().ok).toBe(true);
    r1.runtime.dispose();
    expect(JSON.stringify(snapshotObj)).toBe(before);
    const healthy: SimulationModuleSpec = {
      id: 'thirdlight.test:healthy',
      phases: ['transform'],
      create() {
        return {
          transformOwners: ['box-0001'],
          step(_phase, ctx) {
            ctx.state.curr.get('box-0001')!.position[0] = 1;
          },
        };
      },
    };
    const reg2 = createSimulationRegistry();
    registerSimulationModule(reg2, healthy.id, healthy);
    const r2 = instantiateRuntime({ snapshot: snapshotObj, registry: reg2, modules: [healthy.id], driver: { kind: 'manual' }, clock: () => 0 });
    if (!r2.ok) throw new Error('fresh instantiate failed');
    r2.runtime.start();
    const t = r2.runtime.tick(0);
    expect(t.ok).toBe(restart.expect.freshInstanceRuns);
    r2.runtime.dispose();
  });
});
