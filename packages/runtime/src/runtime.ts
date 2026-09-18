/**
 * Runtime core — runtime.md §3 (lifecycle), §4 (mutable simulation state),
 * §5 (fixed steps with bounded catch-up), §6 (interpolation + frame
 * ordering), §8 (diagnostics).
 *
 * The runtime owns the single frame driver (rAF or manual). Every public
 * call returns a result object and never throws on protocol misuse. The
 * runtime core is three-free (dependencies.md §4.1: project-model only)
 * and carries no hidden globals (every instance is an explicit object).
 */
import { clipMessage, type ErrorCode, type RuntimeError } from './errors';
import { lerpVec3, quatEqual, slerpQuat, vec3Equal } from './interp';
import { isSimulationRegistry } from './registry';
import { deepFreeze, validateRuntimeSnapshot } from './snapshot';
import {
  SIM_REGISTRY_BRAND,
  type CameraInfo,
  type DiagnosticErrorEntry,
  type InterpolatedState,
  type InterpolatedTransform,
  type Runtime,
  type RuntimeDiagnostics,
  type RuntimeStateName,
  type RuntimeSnapshot,
  type SimEntityData,
  type SimState,
  type SimulationModule,
  type SimulationModuleSpec,
  type SimulationRegistry,
  type TransformState,
} from './types';

/** runtime.md §3.1 default (the M1 constant). */
const DEFAULT_FIXED_STEP_HZ = 120;
const MIN_FIXED_STEP_HZ = 1;
const MAX_FIXED_STEP_HZ = 1000;
/** runtime.md §5 (normative M1 constant). */
export const MAX_CATCHUP_STEPS = 8;
/** runtime.md §8: the error ring keeps the last 32 entries. */
const MAX_ERROR_ENTRIES = 32;
/**
 * Floating-point guard for the floor-based step count (§5.3). When the
 * wall-derived `elapsed` is a mathematical multiple of `dt`,
 * `(targetSim − simTime) / dt` can round to e.g. 11.999999999999998;
 * double-precision rounding at realistic elapsed values is ~1e-13 in step
 * units, so a 1e-9 guard corrects exact-multiple cases without ever
 * running a step early (at most ~1e-9 of a step ≈ 8e-12 s). Determinism
 * is preserved: the same floating-point inputs yield the same count
 * (§4/§7.3) — the guard is a fixed part of the computation.
 */
const STEP_COUNT_EPS = 1e-9;

/** runtime.md §3.1 default module selection (M1). */
const DEFAULT_MODULES = ['thirdlight.demo:box-motion'];

interface WallAnchor {
  /** Wall seconds of the anchor frame. */
  wall: number;
  /** simTime at the anchor frame. */
  simTime: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasRaf(): boolean {
  return typeof globalThis.requestAnimationFrame === 'function';
}

function defaultClock(): (() => number) | null {
  const p = globalThis.performance;
  if (p && typeof p.now === 'function') return () => p.now() / 1000;
  return null;
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  // The §6 invariant is 0 ≤ alpha < 1; a defensive clamp for the
  // (mathematically impossible) v ≥ 1 edge.
  if (v >= 1) return 1 - 1e-9;
  return v;
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message !== '' ? e.message : 'Error';
  try {
    const s = JSON.stringify(e);
    if (typeof s === 'string' && s.length > 0) return s;
  } catch {
    /* non-serializable — fall through */
  }
  return String(e);
}

function fail(code: ErrorCode, message: string, extra?: Partial<RuntimeError>): RuntimeError {
  return { code, message: clipMessage(message), ...extra };
}

function cloneTransform(t: TransformState): TransformState {
  return {
    position: [t.position[0], t.position[1], t.position[2]],
    rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]],
    scale: [t.scale[0], t.scale[1], t.scale[2]],
  };
}

function cloneCurr(curr: Map<string, TransformState>): Map<string, TransformState> {
  const out = new Map<string, TransformState>();
  for (const [id, t] of curr) out.set(id, cloneTransform(t));
  return out;
}

/** Strict config parsing (runtime.md §3.1). */
function parseConfig(config: unknown): { cfg: ParsedConfig } | { error: RuntimeError } {
  if (!isPlainObject(config)) {
    return { error: fail('config_invalid', 'config must be an object', { reason: 'shape', path: '' }) };
  }
  const allowed = new Set(['snapshot', 'registry', 'modules', 'clock', 'driver', 'fixedStepHz', 'onFrame']);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key)) {
      return {
        error: fail('config_invalid', `unknown config field "${key}" (strict shape)`, {
          reason: 'shape',
          path: `/${key}`,
        }),
      };
    }
  }
  if (!('snapshot' in config)) {
    return { error: fail('config_invalid', 'config field "snapshot" is required', { reason: 'missing', path: '/snapshot' }) };
  }
  if (!isSimulationRegistry(config.registry)) {
    return {
      error: fail('config_invalid', 'config field "registry" must be a simulation registry (createSimulationRegistry)', {
        reason: 'registry',
        path: '/registry',
      }),
    };
  }
  let modules: string[];
  if (config.modules === undefined) {
    modules = [...DEFAULT_MODULES];
  } else if (
    !Array.isArray(config.modules) ||
    config.modules.some((m) => typeof m !== 'string')
  ) {
    return { error: fail('config_invalid', 'config field "modules" must be an array of module ID strings', { reason: 'shape', path: '/modules' }) };
  } else {
    modules = [...(config.modules as string[])];
  }
  let clock: () => number;
  let clockLabel: 'performance' | 'injected';
  if (config.clock !== undefined) {
    if (typeof config.clock !== 'function') {
      return { error: fail('config_invalid', 'config field "clock" must be a function () => seconds', { reason: 'shape', path: '/clock' }) };
    }
    clock = config.clock as () => number;
    clockLabel = 'injected';
  } else {
    const def = defaultClock();
    if (!def) {
      return { error: fail('config_invalid', 'no default clock available — inject a clock (monotonic seconds)', { reason: 'clock', path: '/clock' }) };
    }
    clock = def;
    clockLabel = 'performance';
  }
  let driverKind: 'raf' | 'manual';
  if (config.driver === undefined) {
    driverKind = hasRaf() ? 'raf' : 'manual';
  } else if (!isPlainObject(config.driver) || Object.keys(config.driver).length !== 1 || !(config.driver.kind === 'raf' || config.driver.kind === 'manual')) {
    return { error: fail('config_invalid', 'config field "driver" must be { kind: "raf" | "manual" }', { reason: 'shape', path: '/driver' }) };
  } else if (config.driver.kind === 'raf' && !hasRaf()) {
    return { error: fail('config_invalid', 'the "raf" driver requires requestAnimationFrame (absent in this environment)', { reason: 'driver', path: '/driver' }) };
  } else {
    driverKind = config.driver.kind;
  }
  let hz = DEFAULT_FIXED_STEP_HZ;
  if (config.fixedStepHz !== undefined) {
    if (
      typeof config.fixedStepHz !== 'number' ||
      !Number.isInteger(config.fixedStepHz) ||
      config.fixedStepHz < MIN_FIXED_STEP_HZ ||
      config.fixedStepHz > MAX_FIXED_STEP_HZ
    ) {
      return { error: fail('config_invalid', `config field "fixedStepHz" must be an integer in [${MIN_FIXED_STEP_HZ}, ${MAX_FIXED_STEP_HZ}]`, { reason: 'shape', path: '/fixedStepHz' }) };
    }
    hz = config.fixedStepHz;
  }
  let onFrame: (() => void) | undefined;
  if (config.onFrame !== undefined) {
    if (typeof config.onFrame !== 'function') {
      return { error: fail('config_invalid', 'config field "onFrame" must be a function', { reason: 'shape', path: '/onFrame' }) };
    }
    onFrame = config.onFrame as () => void;
  }
  return {
    cfg: {
      snapshot: config.snapshot,
      registry: config.registry as SimulationRegistry,
      modules,
      clock,
      clockLabel,
      driverKind,
      hz,
      onFrame,
    },
  };
}

interface ParsedConfig {
  snapshot: unknown;
  registry: SimulationRegistry;
  modules: string[];
  clock: () => number;
  clockLabel: 'performance' | 'injected';
  driverKind: 'raf' | 'manual';
  hz: number;
  onFrame?: () => void;
}

/**
 * Create a runtime instance (runtime.md §3.1). Validates the snapshot
 * (deep-freezing it on success), resolves the selected modules, builds
 * the initial mutable state (prev = curr = snapshot transforms, stepIndex
 * 0, simTime 0), and creates one module instance per selection entry.
 * No loop, timer, listener, or renderer is installed at instantiate.
 */
export function instantiateRuntime(
  config: unknown,
): { ok: true; runtime: Runtime } | { ok: false; error: RuntimeError } {
  const parsed = parseConfig(config);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const { snapshot, registry, modules, clock, clockLabel, driverKind, hz, onFrame } = parsed.cfg;

  const snap = validateRuntimeSnapshot(snapshot);
  if ('error' in snap) return { ok: false, error: snap.error };
  const { scene, snapshotId, revision } = snap;

  // Resolve the selection (runtime.md §3.1 / §8): unknown or duplicate
  // module ID ⇒ config_invalid; stepping order is the REGISTRATION order.
  const registered = registry[SIM_REGISTRY_BRAND];
  if (new Set(modules).size !== modules.length) {
    return {
      ok: false,
      error: fail('config_invalid', 'config field "modules" contains a duplicate module ID', {
        reason: 'duplicate_module',
        path: '/modules',
      }),
    };
  }
  const selection = new Set(modules);
  const selected: SimulationModuleSpec[] = [];
  for (const spec of registered.values()) {
    if (selection.has(spec.id)) selected.push(spec);
  }
  for (const id of selection) {
    if (!registered.has(id)) {
      return {
        ok: false,
        error: fail('config_invalid', `unknown module id "${id}" (not present in the registry)`, {
          reason: 'unknown_module',
          path: '/modules',
        }),
      };
    }
  }

  // Deep-freeze the snapshot (normative, runtime.md §2) — the input is
  // never written to; all mutable data lives in the simulation state.
  const frozenSnapshot = deepFreeze(snapshot as RuntimeSnapshot);

  // Build the initial mutable state (runtime.md §4): prev = curr = the
  // snapshot transforms (both deep copies — the snapshot is never aliased).
  const order = scene.entities.map((e) => e.id);
  const entities = new Map<string, SimEntityData>();
  const prev = new Map<string, TransformState>();
  const curr = new Map<string, TransformState>();
  for (const e of scene.entities) {
    const t = e.components.transform;
    const data: SimEntityData = { id: e.id, parentId: e.parentId ?? null, transform: cloneTransform(t) };
    if (e.name !== undefined) data.name = e.name;
    const box = e.components.box;
    if (box) data.box = { size: [box.size[0], box.size[1], box.size[2]], material: { color: box.material.color } };
    const cam = e.components.camera;
    if (cam) data.camera = { type: cam.type, fovY: cam.fovY, near: cam.near, far: cam.far };
    entities.set(e.id, data);
    prev.set(e.id, cloneTransform(t));
    curr.set(e.id, cloneTransform(t));
  }

  // The camera entity (validateScene guarantees exactly one — defensive
  // guard for the invariant).
  let cameraInfo: CameraInfo | undefined;
  for (const id of order) {
    const ent = entities.get(id);
    if (ent && ent.camera) {
      cameraInfo = { id, fovY: ent.camera.fovY, near: ent.camera.near, far: ent.camera.far };
      break;
    }
  }
  if (!cameraInfo) {
    return {
      ok: false,
      error: fail('snapshot_invalid', 'scene has no camera entity (project-model §10.3 requires exactly one)', {
        reason: 'scene_validation',
      }),
    };
  }

  // One module instance per selection entry (created at instantiate).
  const moduleInstances: SimulationModule[] = [];
  for (const spec of selected) {
    let instance: SimulationModule;
    try {
      instance = spec.create(frozenSnapshot, { fixedStepHz: hz });
    } catch (e) {
      return {
        ok: false,
        error: fail('config_invalid', `module "${spec.id}" create() threw: ${messageOf(e)}`, {
          reason: 'module_create',
        }),
      };
    }
    if (typeof instance?.step !== 'function') {
      return {
        ok: false,
        error: fail('config_invalid', `module "${spec.id}" create() did not return { step }`, {
          reason: 'module_step',
        }),
      };
    }
    moduleInstances.push(instance);
  }

  const rt = new RuntimeInstance({
    snapshotId,
    revision,
    hz,
    clock,
    clockLabel,
    driverKind,
    onFrame,
    modules: selected.map((s) => s.id),
    moduleInstances,
    order,
    entities,
    cameraInfo,
    prev,
    curr,
  });
  return { ok: true, runtime: rt };
}

interface RuntimeArgs {
  snapshotId: string;
  revision: number;
  hz: number;
  clock: () => number;
  clockLabel: 'performance' | 'injected';
  driverKind: 'raf' | 'manual';
  onFrame?: () => void;
  modules: string[];
  moduleInstances: SimulationModule[];
  order: string[];
  entities: Map<string, SimEntityData>;
  cameraInfo: CameraInfo;
  prev: Map<string, TransformState>;
  curr: Map<string, TransformState>;
}

class RuntimeInstance implements Runtime {
  private stateName: RuntimeStateName;
  private readonly snapshotId: string;
  private readonly revision: number;
  private readonly hz: number;
  private readonly dt: number;
  private readonly clock: () => number;
  private readonly clockLabel: 'performance' | 'injected';
  private readonly driverKind: 'raf' | 'manual';
  private onFrame?: () => void;
  private readonly modules: string[];
  private moduleInstances: SimulationModule[];
  private order: readonly string[];
  private entities: Map<string, SimEntityData>;
  private readonly cameraInfo: CameraInfo;
  private readonly entityCount: number;
  private prev: Map<string, TransformState>;
  private curr: Map<string, TransformState>;
  private stepIndex = 0;
  private simTime = 0;
  private anchor: WallAnchor | null = null;
  private lastAlpha = 0;
  private frameCount = 0;
  private droppedSteps = 0;
  private clockWarningCount = 0;
  private errorRing: DiagnosticErrorEntry[] = [];
  private errorCount = 0;
  private rafId: number | null = null;

  constructor(args: RuntimeArgs) {
    this.stateName = 'instantiated';
    this.snapshotId = args.snapshotId;
    this.revision = args.revision;
    this.hz = args.hz;
    this.dt = 1 / args.hz;
    this.clock = args.clock;
    this.clockLabel = args.clockLabel;
    this.driverKind = args.driverKind;
    this.onFrame = args.onFrame;
    this.modules = [...args.modules];
    this.moduleInstances = args.moduleInstances;
    this.order = args.order;
    this.entities = args.entities;
    this.cameraInfo = args.cameraInfo;
    this.entityCount = args.order.length;
    this.prev = args.prev;
    this.curr = args.curr;
  }

  start(): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    if (this.stateName === 'running') {
      return { ok: false, error: fail('runtime_already_started', 'runtime is already running') };
    }
    this.stateName = 'running';
    if (this.driverKind === 'raf') {
      // Exactly one driver at any time (normative, §3.2): one rAF loop,
      // installed here, cancelled on stop/dispose. The wall anchor is set
      // on the FIRST frame (§5.6), not here.
      this.rafId = globalThis.requestAnimationFrame(this.onRafFrame);
    }
    // Manual driver: no auto-loop; the host calls tick(), and the first
    // tick installs the anchor.
    return { ok: true };
  }

  stop(): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    if (this.stateName !== 'running') {
      return { ok: false, error: fail('runtime_not_running', 'runtime is not running (stop requires running)') };
    }
    // Cancel the driver (the owned listener is removed); the mutable
    // state is RETAINED — a restart continues (simTime/stepIndex keep
    // counting; M1 defines no reset).
    this.cancelDriver();
    this.stateName = 'stopped';
    return { ok: true };
  }

  tick(nowSeconds: number): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    if (this.driverKind === 'raf') {
      return {
        ok: false,
        error: fail('tick_not_allowed', 'tick() is manual-driver only (a second loop source would double-step the simulation)'),
      };
    }
    if (this.stateName !== 'running') {
      return { ok: false, error: fail('runtime_not_running', 'runtime is not running (tick requires running)') };
    }
    if (typeof nowSeconds !== 'number' || !Number.isFinite(nowSeconds)) {
      return { ok: false, error: fail('config_invalid', 'tick requires a finite number of seconds') };
    }
    this.runFrame(nowSeconds);
    return { ok: true };
  }

  getDiagnostics(): { ok: true; diagnostics: RuntimeDiagnostics } | { ok: false; error: RuntimeError } {
    // Works in every state, including disposed (runtime.md §8).
    return { ok: true, diagnostics: this.buildDiagnostics() };
  }

  getInterpolatedState(): { ok: true; state: InterpolatedState } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    const alpha = this.lastAlpha;
    const transforms: InterpolatedTransform[] = [];
    for (const id of this.order) {
      const p = this.prev.get(id);
      const c = this.curr.get(id);
      if (!p || !c) continue;
      if (
        alpha === 0 ||
        (vec3Equal(p.position, c.position) && vec3Equal(p.scale, c.scale) && quatEqual(p.rotation, c.rotation))
      ) {
        // §6: alpha == 0 or prev == curr ⇒ the result is curr exactly.
        transforms.push({
          id,
          position: [c.position[0], c.position[1], c.position[2]],
          rotation: [c.rotation[0], c.rotation[1], c.rotation[2], c.rotation[3]],
          scale: [c.scale[0], c.scale[1], c.scale[2]],
        });
      } else {
        transforms.push({
          id,
          position: lerpVec3(p.position, c.position, alpha),
          rotation: slerpQuat(p.rotation, c.rotation, alpha),
          scale: lerpVec3(p.scale, c.scale, alpha),
        });
      }
    }
    return { ok: true, state: { stepIndex: this.stepIndex, simTime: this.simTime, alpha, transforms } };
  }

  getCamera(): { ok: true; camera: CameraInfo } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    // Stable for the session (runtime.md §6): the snapshot's camera
    // projection parameters; aspect is a viewport property.
    return {
      ok: true,
      camera: { id: this.cameraInfo.id, fovY: this.cameraInfo.fovY, near: this.cameraInfo.near, far: this.cameraInfo.far },
    };
  }

  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: true, alreadyDisposed: true };
    }
    this.cancelDriver();
    this.stateName = 'disposed';
    // Release the module instances and all references held by the
    // runtime so the heap is reclaimable (runtime.md §3.4).
    for (const m of this.moduleInstances) {
      if (m.dispose) {
        try {
          m.dispose();
        } catch {
          /* a failing module dispose must not break runtime disposal */
        }
      }
    }
    this.moduleInstances = [];
    this.prev = new Map();
    this.curr = new Map();
    this.entities = new Map();
    this.order = [];
    this.onFrame = undefined;
    this.anchor = null;
    return { ok: true };
  }

  /** Cancel the owned driver (rAF callback removed). */
  private cancelDriver(): void {
    if (this.rafId !== null) {
      const caf = globalThis.cancelAnimationFrame;
      if (typeof caf === 'function') caf(this.rafId);
      this.rafId = null;
    }
  }

  /** The single rAF loop callback (manual driver never runs this). */
  private readonly onRafFrame = (): void => {
    if (this.stateName !== 'running' || this.driverKind !== 'raf') return; // cancelled
    this.runFrame(this.clock());
    // The loop reschedules itself: exactly ONE live rAF callback while
    // running; stop/dispose cancel it (no duplicate loops, §3.2).
    if (this.stateName === 'running') {
      this.rafId = globalThis.requestAnimationFrame(this.onRafFrame);
    }
  };

  /** One frame update (§5) + onFrame (§6 frame ordering: step → onFrame). */
  private runFrame(t: number): void {
    this.frameCount += 1; // §5 frame updates, including zero-step frames
    if (!this.anchor) {
      // First frame after start: initialize the anchor at that frame
      // (§5.6) — time before start is never simulated (zero steps).
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
      this.onFrame?.();
      return;
    }
    const elapsed = t - this.anchor.wall;
    if (elapsed < 0) {
      // Non-monotonic clock: zero steps + one clock_warning diagnostic
      // count, no error (§5.1). The anchor is left in place.
      this.clockWarningCount += 1;
      this.lastAlpha = 0;
      this.onFrame?.();
      return;
    }
    const targetSim = this.anchor.simTime + elapsed;
    const rawN = Math.floor((targetSim - this.simTime) / this.dt + STEP_COUNT_EPS);
    const n = Math.min(rawN, MAX_CATCHUP_STEPS);
    for (let i = 0; i < n; i += 1) this.stepOnce();
    if (rawN > MAX_CATCHUP_STEPS) {
      // Bounded catch-up (normative, §5.4): drop the remainder and
      // resync the anchor — no unbounded burst after a stall. The
      // resync makes targetSim == simTime for the display, so
      // alpha = 0 (§6).
      this.droppedSteps += rawN - MAX_CATCHUP_STEPS;
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
    } else {
      this.lastAlpha = clamp01((targetSim - this.simTime) / this.dt);
    }
    this.onFrame?.();
  }

  /** One fixed step (§5.3 + §5.1 module isolation). */
  private stepOnce(): void {
    // §5.1: copy curr before the step; restore it if any module throws
    // (no partial module application).
    const backup = cloneCurr(this.curr);
    let failed = false;
    // The module receives the 1-based ordinal of the step being executed:
    // per §5.3 the step completes the stepIndex it is called with
    // ("curr := step(curr, stepIndex); stepIndex++") — the m1-acceptance
    // exact points (x0+A at stepIndex 119 under the §7.1 `(stepIndex + 1)`
    // offset) pin this ordinal semantics. The SimState view still carries
    // the state fields as written in §4/§5.3 (stepIndex = completed steps
    // at call time; simTime = stepIndex / fixedStepHz).
    const stepOrdinal = this.stepIndex + 1;
    const view: SimState = {
      order: this.order,
      entities: this.entities,
      stepIndex: this.stepIndex,
      simTime: this.simTime,
      prev: this.prev,
      curr: this.curr,
    };
    for (const m of this.moduleInstances) {
      // Registration order (§5.3: each module in registration order).
      try {
        m.step(view, stepOrdinal);
      } catch (e) {
        failed = true;
        this.recordError('module_error', `module step threw: ${messageOf(e)}`, stepOrdinal);
        break;
      }
    }
    if (failed) {
      // The step is a no-op: curr restored, stepIndex and simTime do not
      // advance; a module_error diagnostic is recorded. The failed module
      // instance is not re-created; the step keeps no-opping on every
      // subsequent step until disposed (§5.1).
      this.curr = cloneCurr(backup);
      return;
    }
    this.prev = backup; // prev := curr at the end of step n−1
    this.stepIndex += 1;
    this.simTime = this.stepIndex / this.hz; // single division (§4)
  }

  private recordError(code: ErrorCode, message: string, stepIndex?: number): void {
    const entry: DiagnosticErrorEntry = { code, message: clipMessage(message) };
    if (stepIndex !== undefined) entry.stepIndex = stepIndex;
    this.errorRing.push(entry);
    if (this.errorRing.length > MAX_ERROR_ENTRIES) this.errorRing.shift();
    this.errorCount += 1;
  }

  private buildDiagnostics(): RuntimeDiagnostics {
    return {
      state: this.stateName,
      snapshotId: this.snapshotId,
      revision: this.revision,
      simTime: this.simTime,
      stepIndex: this.stepIndex,
      fixedStepHz: this.hz,
      droppedSteps: this.droppedSteps,
      frameCount: this.frameCount,
      entityCount: this.entityCount,
      modules: [...this.modules],
      clock: this.clockLabel,
      clockWarningCount: this.clockWarningCount,
      errors: [...this.errorRing],
      errorCount: this.errorCount,
    };
  }
}
