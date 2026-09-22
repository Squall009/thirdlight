/**
 * Packet 32 — shared helpers for the real-adapter controller course suite
 * (`tests/m2-controller/**`).
 *
 * Every run composes the accepted pieces for real:
 *
 *   `@thirdlight/platformer` (the controller module)
 *   + `@thirdlight/runtime` (phases, pre-roll, transform commit, fail-stop)
 *   + `@thirdlight/physics-rapier` (the pinned `@dimforge/rapier2d-compat@0.20.0`)
 *   + `@thirdlight/input` (the pure raw-snapshot → ActionFrame mapping)
 *
 * The course geometry comes from `fixtures/m2/course/**` (the packet-14 frozen
 * course and the packet-31 derived slope/snap courses). Nothing here is a mock:
 * the port is the real WASM adapter and the frames are the real mapping's
 * output. A thin recording wrapper around the real port captures the per-step
 * `CharacterMoveResult` the runtime consumes, so the controller's observable
 * grounding/contact behaviour can be asserted; the wrapper adds no logic.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPhysicsPort,
  type RapierPhysicsInitConfig,
  type RapierStaticColliderSpec,
} from '@thirdlight/physics-rapier';
import {
  createSimulationRegistry,
  instantiateRuntime,
  registerSimulationModule,
  type ActionSource,
  type CharacterMoveResult,
  type GameplaySettings,
  type PhysicsPort,
  type Runtime,
  type Vec2,
} from '@thirdlight/runtime';
import { PLATFORMER_MODULE_ID, platformerSpec } from '@thirdlight/platformer';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..');
export const FIXTURES = join(REPO, 'fixtures', 'm2', 'course');

export const DT = 1 / 120;
export const SETTLE_STEPS = 12;

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function fixture<T>(name: string): T {
  return readJson<T>(join(FIXTURES, name));
}

export interface CourseFile {
  kind: string;
  id: string;
  packet: number;
  solver: { hz: 120; gravityY: number };
  character: {
    start: { x: number; y: number };
    capsule: { radius: number; halfHeight: number };
    runSpeed: number;
    jumpVelocity: number;
    maxFallSpeed: number;
  };
  controller: RapierPhysicsInitConfig['controller'];
  settings: GameplaySettings;
  statics: RapierStaticColliderSpec[];
}

/** project-model §5.1 ID syntax — `entityId`s of the frozen spec may not fit. */
function entityId(index: number): string {
  return `col-${String(index).padStart(4, '0')}`;
}

/**
 * A valid `schemaVersion` 2 runtime scene for a course: one camera, the course
 * statics as `components.collider` entities (so the snapshot and the injected
 * port describe the same world) and the single `components.controller`
 * character at `start`.
 */
export function courseSnapshot(course: CourseFile, start: Vec2): unknown {
  const entities: unknown[] = [
    {
      id: 'cam-main',
      name: 'Main Camera',
      components: {
        transform: { position: [0, 0.5, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 },
      },
    },
  ];
  course.statics.forEach((spec, i) => {
    const half = spec.rotationZ / 2;
    entities.push({
      id: entityId(i),
      name: spec.entityId,
      components: {
        transform: {
          position: [spec.position.x, spec.position.y, 0],
          rotation: [0, 0, Math.sin(half), Math.cos(half)],
          scale: [1, 1, 1],
        },
        collider: { shape: spec.shape },
      },
    });
  });
  entities.push({
    id: 'char-0001',
    name: 'Character',
    components: {
      transform: { position: [start.x, start.y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      controller: {},
    },
  });
  return {
    snapshotId: 'demo-0001@r4',
    projectId: 'demo-0001',
    revision: 4,
    scene: { schemaVersion: 2, sceneId: 'scene-main', revision: 4, entities },
  };
}

export function portConfig(course: CourseFile, start: Vec2): RapierPhysicsInitConfig {
  return {
    character: { x: start.x, y: start.y },
    statics: course.statics,
    solver: course.solver,
    controller: course.controller,
  };
}

/** One recorded executed step of a run. */
export interface Step {
  stepIndex: number;
  /** The requested delta the controller staged (m). */
  requested: Vec2;
  result: CharacterMoveResult;
  position: Vec2;
  /** Controller velocity derived from the requested delta (m/s). */
  vx: number;
  vy: number;
}

export interface RunOptions {
  /** Gameplay settings override (defaults to the course settings). */
  settings?: Partial<GameplaySettings>;
  actions: ActionSource;
}

export interface Run {
  runtime: Runtime;
  /** The character's authored start (the basis of step 0). */
  start: Vec2;
  /** Per-step records in execution order (settle pre-roll first). */
  records: Step[];
  /** Advance `n` executed fixed steps at exactly one step per tick. */
  steps(n: number): boolean;
  /** Advance wall time by `seconds` in a single tick (catch-up/drop cases). */
  stall(seconds: number): boolean;
  /** Authoritative committed transform of the character (alpha 0). */
  transform(): { position: number[]; rotation: number[]; scale: number[] };
  position(): Vec2;
  diagnostics(): ReturnType<Runtime['getDiagnostics']>;
  dispose(): void;
}

/** Start a real run over the injected course; the caller disposes it. */
export async function startRun(
  course: CourseFile,
  start: Vec2,
  options: RunOptions,
): Promise<Run> {
  const init = await createPhysicsPort(portConfig(course, start));
  if (!init.ok) throw new Error(`physics init failed: ${JSON.stringify(init.error)}`);
  const port = init.port;
  const records: Step[] = [];
  let staged: Vec2 = { x: 0, y: 0 };
  let lastPosition: Vec2 = { x: start.x, y: start.y };
  const recordingPort: PhysicsPort = {
    implementation: port.implementation,
    stageCharacterMove(delta: Vec2): void {
      staged = { x: delta.x, y: delta.y };
      port.stageCharacterMove(delta);
    },
    step(): CharacterMoveResult {
      const result = port.step();
      const requested = { x: staged.x, y: staged.y };
      records.push({
        stepIndex: records.length,
        requested,
        result,
        position: { x: result.position.x, y: result.position.y },
        vx: requested.x / DT,
        vy: requested.y / DT,
      });
      lastPosition = { x: result.position.x, y: result.position.y };
      return result;
    },
    diagnostics: () => port.diagnostics(),
    dispose: () => port.dispose(),
  };
  void lastPosition;

  const registry = createSimulationRegistry();
  const registered = registerSimulationModule(registry, PLATFORMER_MODULE_ID, platformerSpec);
  if (!registered.ok) throw new Error(`register failed: ${JSON.stringify(registered.error)}`);
  let now = 0;
  const runtimeResult = instantiateRuntime({
    snapshot: courseSnapshot(course, start),
    registry,
    modules: [PLATFORMER_MODULE_ID],
    actions: options.actions,
    physics: recordingPort,
    settings: { ...course.settings, ...(options.settings ?? {}) },
    clock: () => now,
    driver: { kind: 'manual' },
  });
  if (!runtimeResult.ok) {
    port.dispose();
    throw new Error(`instantiateRuntime failed: ${JSON.stringify(runtimeResult.error)}`);
  }
  const runtime = runtimeResult.runtime;
  const started = runtime.start();
  if (!started.ok) {
    port.dispose();
    throw new Error(`start failed: ${JSON.stringify(started.error)}`);
  }
  // First tick runs the 12-step settle pre-roll and installs the wall anchor.
  const pre = runtime.tick(0);
  if (!pre.ok) throw new Error(`pre-roll tick failed: ${JSON.stringify(pre.error)}`);

  const transform = (): { position: number[]; rotation: number[]; scale: number[] } => {
    const state = runtime.getInterpolatedState();
    if (!state.ok) throw new Error('getInterpolatedState failed');
    const t = state.state.transforms.find((x) => x.id === 'char-0001');
    if (!t) throw new Error('character transform missing');
    return { position: t.position, rotation: t.rotation, scale: t.scale };
  };

  return {
    runtime,
    start: { x: start.x, y: start.y },
    records,
    steps(n: number) {
      for (let i = 0; i < n; i += 1) {
        now += DT;
        if (!runtime.tick(now).ok) return false;
      }
      return true;
    },
    stall(seconds: number) {
      now += seconds;
      return runtime.tick(now).ok;
    },
    transform,
    position() {
      const t = transform();
      return { x: t.position[0] as number, y: t.position[1] as number };
    },
    diagnostics: () => runtime.getDiagnostics(),
    dispose() {
      runtime.dispose();
    },
  };
}

/** The records that belong to gameplay (after the settle pre-roll). */
export function gameplay(run: Run): Step[] {
  return run.records.slice(SETTLE_STEPS);
}

/** The last measured step's resting centre for a flat start. */
export function restCenter(run: Run): number {
  const last = run.records[run.records.length - 1];
  return last ? last.position.y : run.start.y;
}
