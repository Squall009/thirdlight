/**
 * Runtime public types — runtime.md §2 (snapshot), §3 (lifecycle API),
 * §4 (mutable simulation state), §5/§6 (scheduling + interpolation),
 * §7 (module shape), §8 (diagnostics).
 *
 * These are the type surface of the `runtime` package (dependencies.md §3:
 * "types (snapshot, diagnostics, module interfaces)").
 */
import type { Quat, Scene, Vec3 } from '@thirdlight/project-model';
import type { ErrorCode, RuntimeError } from './errors';

/**
 * The runtime snapshot (runtime.md §2) — the ONLY input of a runtime
 * instance. `scene` is a complete normalized scene document
 * (project-model §8/§12.2); the wrapper fields are the only extra fields.
 */
export interface RuntimeSnapshot {
  /** Exactly `<projectId>@r<revision>` (project-model §6). */
  snapshotId: string;
  projectId: string;
  /** Integer, 0 ≤ v ≤ 2^53−1; must equal `scene.revision`. */
  revision: number;
  scene: Scene;
}

/** Config accepted by `instantiateRuntime` (runtime.md §3.1; strict shape). */
export interface InstantiateConfig {
  snapshot: RuntimeSnapshot;
  registry: SimulationRegistry;
  /** Module IDs present in `registry`. Default `["thirdlight.demo:box-motion"]`. */
  modules?: readonly string[];
  /** Monotonic seconds. Default `performance.now() / 1000`. */
  clock?: () => number;
  /** `"raf"` requires `requestAnimationFrame`; `"manual"` = host calls `tick`. */
  driver?: { kind: 'raf' } | { kind: 'manual' };
  /** Integer 1 ≤ v ≤ 1000. Default 120 (the M1 constant). */
  fixedStepHz?: number;
  /** Called once per frame after the step update (runtime.md §6 frame ordering). */
  onFrame?: () => void;
}

/**
 * The independent mutable simulation state (runtime.md §4). `prev`/`curr`
 * hold the transforms at the end of step n−1 / step n; every simulation
 * mutation writes only here, never to the (deep-frozen) snapshot.
 */
export interface TransformState {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** Per-entity simulation data (runtime.md §4 `entities` map values). */
export interface SimEntityData {
  id: string;
  parentId: string | null;
  name?: string;
  transform: TransformState;
  box?: { size: Vec3; material: { color: string } };
  camera?: { type: 'perspective'; fovY: number; near: number; far: number };
}

export interface SimState {
  /** Entity IDs in snapshot document order. */
  order: readonly string[];
  entities: ReadonlyMap<string, SimEntityData>;
  stepIndex: number;
  /** Always `stepIndex / fixedStepHz` (single division, no accumulation). */
  simTime: number;
  /** Transforms at the end of step n−1. */
  prev: Map<string, TransformState>;
  /** Transforms at the end of step n (modules mutate this in place). */
  curr: Map<string, TransformState>;
}

/** Module config passed to `SimulationModuleSpec.create` (runtime.md §7.2). */
export interface ModuleConfig {
  fixedStepHz: number;
}

/**
 * Simulation module shape (runtime.md §7.2; dependencies.md §6):
 * `step` mutates `curr` consistently or throws; `dispose?` is called by
 * `runtime.dispose()`.
 */
export interface SimulationModule {
  step(state: SimState, stepIndex: number): void;
  dispose?(): void;
}

export interface SimulationModuleSpec {
  id: string;
  create(snapshot: RuntimeSnapshot, cfg: ModuleConfig): SimulationModule;
}

/**
 * Branded simulation-module registry (dependencies.md §6). Create with
 * `createSimulationRegistry()`; register engine modules with
 * `registerSimulationModule`.
 */
export interface SimulationRegistry {
  [registryBrand]: Map<string, SimulationModuleSpec>;
}
const registryBrand: unique symbol = Symbol('thirdlight.simulation-registry');
export { registryBrand as SIM_REGISTRY_BRAND };

/** Lifecycle states (runtime.md §3). */
export type RuntimeStateName = 'instantiated' | 'running' | 'stopped' | 'disposed';

/** The runtime instance (runtime.md §3 API; every call returns a result). */
export interface Runtime {
  start(): { ok: true } | { ok: false; error: RuntimeError };
  stop(): { ok: true } | { ok: false; error: RuntimeError };
  /** Manual driver only (runtime.md §3.5); rAF driver ⇒ `tick_not_allowed`. */
  tick(nowSeconds: number): { ok: true } | { ok: false; error: RuntimeError };
  getDiagnostics(): { ok: true; diagnostics: RuntimeDiagnostics } | { ok: false; error: RuntimeError };
  getInterpolatedState(): { ok: true; state: InterpolatedState } | { ok: false; error: RuntimeError };
  getCamera(): { ok: true; camera: CameraInfo } | { ok: false; error: RuntimeError };
  /** Idempotent: second call ⇒ `{ ok: true, alreadyDisposed: true }`. */
  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: RuntimeError };
}

/** One interpolated transform (runtime.md §6). */
export interface InterpolatedTransform {
  id: string;
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

/** Display state (runtime.md §6): `0 ≤ alpha < 1`, snapshot document order. */
export interface InterpolatedState {
  stepIndex: number;
  simTime: number;
  alpha: number;
  transforms: InterpolatedTransform[];
}

/** The snapshot's camera projection parameters (runtime.md §6 `getCamera`). */
export interface CameraInfo {
  id: string;
  fovY: number;
  near: number;
  far: number;
}

/** One bounded diagnostic error entry (runtime.md §8). */
export interface DiagnosticErrorEntry {
  code: ErrorCode;
  message: string;
  stepIndex?: number;
}

/** Structured diagnostics (runtime.md §8; works in every state). */
export interface RuntimeDiagnostics {
  state: RuntimeStateName;
  snapshotId: string;
  revision: number;
  simTime: number;
  stepIndex: number;
  fixedStepHz: number;
  /** Cumulative catch-up drops (runtime.md §5.4). */
  droppedSteps: number;
  /** §5 frame updates, including zero-step frames. */
  frameCount: number;
  entityCount: number;
  /** Selected module IDs (registration order). */
  modules: string[];
  /** `"performance"` (default clock) or `"injected"` (config clock). */
  clock: 'performance' | 'injected';
  /** Non-monotonic `clock()` observations (no step, no error). */
  clockWarningCount: number;
  /** Last 32 error entries (bounded ring). */
  errors: DiagnosticErrorEntry[];
  /** Cumulative (unbounded count; the ring stays bounded). */
  errorCount: number;
}