/**
 * Test-only M2 helpers (NOT part of the package's public surface — not
 * exported from index.ts, imported only by .test.ts files).
 *
 * Contains no concrete physics library: the fake port is a deterministic,
 * dependency-free stand-in used to exercise the runtime's phase pipeline,
 * transform ownership and fail-stop contract.
 */
import type { ActionFrame } from './actions';
import type { CharacterMoveResult, PhysicsPort, PhysicsStepClient, Vec2 } from './ports';
import type { Runtime, SimulationModuleSpec, SimulationRegistry } from './index';
import { createSimulationRegistry, instantiateRuntime, registerSimulationModule } from './index';

/** A valid normalized schemaVersion 2 scene with the M2 component markers. */
export function v2Scene(): {
  schemaVersion: 4;
  sceneId: string;
  revision: number;
  entities: unknown[];
} {
  const transform = (position: number[]): unknown => ({
    position,
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
  });
  return {
    schemaVersion: 4,
    sceneId: 'scene-main',
    revision: 4,
    entities: [
      {
        id: 'cam-main',
        name: 'Main Camera',
        components: {
          transform: transform([0, 0.5, 4]),
          camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
        },
      },
      {
        id: 'floor-0001',
        components: {
          transform: transform([0, -0.3, 0]),
          collider: { shape: { type: 'box', hx: 8, hy: 0.3 } },
        },
      },
      {
        id: 'char-0001',
        components: {
          transform: transform([0, 1, 0]),
          controller: {},
        },
      },
      {
        id: 'box-0001',
        components: {
          transform: transform([0.5, 0.5, 0]),
          box: { size: [0.2, 0.2, 0.2], material: { color: '#ff8800' } },
        },
      },
    ],
  };
}

/** A well-formed v2 runtime snapshot over `v2Scene()`. */
export function v2Snapshot(projectId = 'demo-0001'): unknown {
  const scene = v2Scene();
  return {
    snapshotId: `${projectId}@r${scene.revision}`,
    projectId,
    revision: scene.revision,
    scene,
    game: null,
  };
}

/** A registry containing the built-ins plus the supplied test specs. */
export function registryWith(specs: readonly SimulationModuleSpec[]): SimulationRegistry {
  const r = createSimulationRegistry();
  for (const spec of specs) {
    const res = registerSimulationModule(r, spec.id, spec);
    if (!res.ok) throw new Error(`register ${spec.id} failed: ${JSON.stringify(res.error)}`);
  }
  return r;
}

export interface FakePortOptions {
  /** Authored character center (must match the snapshot transform). */
  character?: Vec2;
  /** Called at the start of every `step()`. */
  onStep?: () => void;
  /** Return a malformed result instead of the computed one. */
  malformed?: boolean;
  /** Throw from `step()`. */
  throwOnStep?: boolean;
}

export interface FakePort extends PhysicsPort {
  readonly steps: number;
  readonly staged: Vec2[];
  /** Override the next `step()` result position (tests only). */
  forcePosition: Vec2 | null;
}

/** Deterministic identity-motion port: applied == requested, no gravity. */
export function makeFakePort(opts: FakePortOptions = {}): FakePort {
  let pos: Vec2 = opts.character ?? { x: 0, y: 1 };
  let pending: Vec2 = { x: 0, y: 0 };
  let steps = 0;
  const staged: Vec2[] = [];
  const port: FakePort = {
    implementation: 'runtime-test-fake',
    steps: 0,
    staged,
    forcePosition: null,
    stageCharacterMove(delta: Vec2): void {
      pending = { x: delta.x, y: delta.y };
      staged.push({ ...pending });
    },
    step(): CharacterMoveResult {
      steps += 1;
      (port as { steps: number }).steps = steps;
      opts.onStep?.();
      if (opts.throwOnStep) throw new Error('port exploded');
      const requested = { ...pending };
      pending = { x: 0, y: 0 };
      const target = port.forcePosition ?? { x: pos.x + requested.x, y: pos.y + requested.y };
      port.forcePosition = null;
      const applied = { x: target.x - pos.x, y: target.y - pos.y };
      pos = target;
      const result: CharacterMoveResult = {
        requested,
        applied,
        position: { ...target },
        grounded: true,
        supportNormal: { x: 0, y: 1 },
        contacts: { ground: true, wall: false, head: false, steepSlope: false },
        snapped: false,
      };
      if (opts.malformed) {
        return { ...result, applied: { x: applied.x + 1, y: applied.y } };
      }
      return result;
    },
    dispose(): void {
      /* idempotent by construction */
    },
  };
  return port;
}

/** An `ActionSource` that records every sampled step index. */
export function recordingSource(frames: readonly ActionFrame[] = []): {
  sample: (n: number) => ActionFrame;
  sampled: number[];
} {
  const byIndex = new Map(frames.map((f) => [f.stepIndex, f]));
  const sampled: number[] = [];
  return {
    sampled,
    sample(n: number): ActionFrame {
      sampled.push(n);
      return byIndex.get(n) ?? { stepIndex: n, moveX: 0, jump: 'none' };
    },
  };
}

export interface M2Harness {
  rt: Runtime;
  diag: () => import('./types').RuntimeDiagnostics;
  tick: (t: number) => void;
  /** start + first frame (the 12-step pre-roll) at t=0. */
  boot: () => void;
}

export function makeM2Runtime(config: {
  modules: string[];
  specs: readonly SimulationModuleSpec[];
  registry?: SimulationRegistry;
  snapshot?: unknown;
  actions?: { sample: (n: number) => ActionFrame };
  physics?: PhysicsPort;
  onFrame?: () => void;
}): M2Harness {
  const registry = config.registry ?? registryWith(config.specs);
  const res = instantiateRuntime({
    snapshot: config.snapshot ?? v2Snapshot(),
    registry,
    modules: config.modules,
    driver: { kind: 'manual' },
    clock: () => 0,
    ...(config.actions ? { actions: config.actions } : {}),
    ...(config.physics ? { physics: config.physics } : {}),
    ...(config.onFrame ? { onFrame: config.onFrame } : {}),
  });
  if (!res.ok) throw new Error(`instantiate failed: ${JSON.stringify(res.error)}`);
  const rt = res.runtime;
  const diag = (): import('./types').RuntimeDiagnostics => {
    const d = rt.getDiagnostics();
    if (!d.ok) throw new Error('diagnostics failed');
    return d.diagnostics;
  };
  let now = 0;
  return {
    rt,
    diag,
    tick: (t: number) => {
      now = t;
      const r = rt.tick(now);
      if (!r.ok) throw new Error(`tick failed: ${JSON.stringify(r.error)}`);
    },
    boot: () => {
      const s = rt.start();
      if (!s.ok) throw new Error(`start failed: ${JSON.stringify(s.error)}`);
      now = 0;
      const r = rt.tick(0); // frame 1: M2 pre-roll
      if (!r.ok) throw new Error(`boot tick failed: ${JSON.stringify(r.error)}`);
    },
  };
}

/** A minimal phased module used across tests. */
export interface ProbeModuleSpecOptions {
  id: string;
  phases: readonly import('./types').SimulationPhase[];
  owners?: readonly string[];
  requiresPhysicsPort?: boolean;
  excludes?: readonly string[];
  step?: (
    phase: import('./types').SimulationPhase,
    ctx: import('./types').StepContext,
  ) => void;
  create?: () => void;
  dispose?: () => void;
}

export function probeSpec(opts: ProbeModuleSpecOptions): SimulationModuleSpec {
  return {
    id: opts.id,
    phases: opts.phases,
    ...(opts.requiresPhysicsPort ? { requiresPhysicsPort: true } : {}),
    ...(opts.excludes ? { excludes: opts.excludes } : {}),
    create() {
      opts.create?.();
      return {
        transformOwners: opts.owners ?? [],
        step(
          phase: import('./types').SimulationPhase,
          ctx: import('./types').StepContext,
        ) {
          opts.step?.(phase, ctx);
        },
        ...(opts.dispose ? { dispose: opts.dispose } : {}),
      };
    },
  };
}

export type { PhysicsStepClient };
