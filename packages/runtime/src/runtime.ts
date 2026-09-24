/**
 * Runtime core — runtime.md §3 (lifecycle), §4 (mutable simulation state),
 * §5 (fixed steps with bounded catch-up), §6 (interpolation + frame
 * ordering), §8 (diagnostics), §12 (M2 phases, ports, transform ownership)
 * and §13 (M2 fail-stop lifecycle).
 *
 * The runtime owns the single frame driver (rAF or manual). Every public
 * call returns a result object and never throws on protocol misuse. The
 * runtime core is three-free (dependencies.md §4.1: project-model only) and
 * carries no hidden globals (every instance is an explicit object).
 *
 * Two module-set modes share the same constructor:
 *
 * - **M1 mode** (no selected spec declares phases): the accepted M1
 *   semantics, byte-for-byte. A module throw is a no-op step (the `curr`
 *   copy is restored) and `failed` is unreachable.
 * - **M2 mode** (at least one selected spec declares phases): the canonical
 *   phase order `intent → controller → physics → transform`, the write
 *   guard, transform-ownership validation, the settle pre-roll, per-step
 *   action sampling and fail-stop with no rollback.
 */
import {
  resolveGameplaySettings,
  type CheckpointActivationAppearance,
  type EntityV3,
  type GameConfig,
  type GameZoneRole,
} from '@thirdlight/project-model';
import {
  NEUTRAL_ACTION_SOURCE,
  neutralFrame,
  validateActionFrame,
  InputFrameError,
  type ActionFrame,
  type ActionSource,
  type JumpPhase,
} from './actions';
import { clipMessage, type ErrorCode, type RuntimeError } from './errors';
import { BehaviorHostError, BehaviorHostIntentLimit, BEHAVIOR_MODULE_PREFIX, createTagQuery } from './behavior';
import { byEntityId, capsuleInZone, offsetEntities, sceneContribution, type LiveTagIndex, type SceneContribution } from './scene-set';
import {
  BehaviorIntentError,
  INTENT_LIMITS,
  quantizeIntentMove,
  validateIntentPhase,
  validateIntentShape,
  validateIntentValue,
  type BehaviorIntent,
  type BehaviorLogLevel,
  type IntentSet,
  type IntentTransformWrite,
} from './intents';
import { DuplicateMoveError, PhaseViolationError, frozenContext, phaseScopedState } from './guard';
import { lerpVec3, quatEqual, slerpQuat, vec3Equal } from './interp';
import { isSimulationRegistry, validatePhaseList } from './registry';
import { deepFreeze, validateRuntimeSnapshot } from './snapshot';
import { AnimatorMachine, type AnimatorControllerLike, type AnimatorPose } from './animator';
import {
  DEFAULT_ASPECT,
  GameSession,
  type BoundaryOutcome,
  type GameCommandAccepted,
  type GameCommandRejection,
  type RunCommand,
} from './game-session';
import {
  validateCharacterMoveResult,
  type CharacterClearanceResult,
  type CharacterMoveResult,
  type PhysicsPort,
  type PhysicsResetPort,
  type PhysicsStepClient,
  type Vec2,
} from './ports';
import {
  SIM_REGISTRY_BRAND,
  SIMULATION_PHASE_ORDER,
  type AnimatorEventRecord,
  type BehaviorAnimatorControl,
  type BehaviorAnimatorHandle,
  type BehaviorSceneControl,
  type CameraInfo,
  type DiagnosticErrorEntry,
  type GameContent,
  type GameZoneSpec,
  type RuntimeSceneRow,
  type SceneLoadOptions,
  type SceneLoadRequest,
  type SceneSetView,
  type SceneStatus,
  type GameCameraBounds,
  type GameSessionPort,
  type GameView,
  type GameplaySettings,
  type InterpolatedState,
  type InterpolatedTransform,
  type ModuleConfig,
  type MotionSegment,
  type ModuleResetContext,
  type PlayerMotion,
  type RunState,
  type Runtime,
  type RuntimeDiagnostics,
  type RuntimeScene,
  type RuntimeSnapshot,
  type RuntimeStateName,
  type RunSnapshot,
  type SimEntityData,
  type SimState,
  type SimulationModule,
  type SimulationModuleSpec,
  type SimulationPhase,
  type SimulationPhaseModule,
  type SimulationRegistry,
  type StepContext,
  type TransformState,
  type ViewportInfo,
} from './types';

/** runtime.md §3.1 default (the M1 constant). */
const DEFAULT_FIXED_STEP_HZ = 120;
const MIN_FIXED_STEP_HZ = 1;
const MAX_FIXED_STEP_HZ = 1000;
/** runtime.md §5 (normative M1 constant). */
export const MAX_CATCHUP_STEPS = 8;
/** runtime.md §3.2 (M2 settle pre-roll). */
export const SETTLE_PREROLL_STEPS = 12;
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
/** runtime.md §12.4 `config_invalid` reason for a physics-bearing set. */
const PHYSICS_PORT_REASON = 'physics_port';

// ---------------------------------------------------------------------------
// M3 reset transaction (gameplay.md §5) — the §4.2 capsule constants (the
// runtime's own copy for the R2 hazard check; the `gameplay`-phase module
// carries its own) and the reset-fault signatures (the test-only seam's
// fail-stop codes, pinned by `fixtures/m3/gameplay/run/failure-phases.json`).
// ---------------------------------------------------------------------------

/** gameplay.md §8.2: the character capsule radius (m). */
const GAME_CAPSULE_RADIUS = 0.3;
/** gameplay.md §8.2: the character capsule centre-line half-height (m). */
const GAME_CAPSULE_HALF_HEIGHT = 0.6;
/** gameplay.md §8.2: the zone overlap tolerance (m). */
const GAME_ZONE_OVERLAP_EPS = 1e-9;

/**
 * The reset-fault signatures (gameplay.md §5.1 R1–R8, pinned by
 * `failure-phases.json`): the exact `code`/`reason` a reset-phase failure
 * fail-stops with. The test-only seam (`injectResetFault`) uses this to
 * reproduce each phase's failure deterministically.
 */
const RESET_FAULT_SIGNATURES: Readonly<Record<string, { code: ErrorCode; reason: string }>> = {
  R1: { code: 'game_spawn_invalid', reason: 'reference' },
  R2: { code: 'game_spawn_blocked', reason: 'hazard' },
  R3: { code: 'game_spawn_blocked', reason: 'blocked' },
  R4: { code: 'physics_port_error', reason: 'reset' },
  R5: { code: 'physics_port_error', reason: 'reset' },
  R6: { code: 'module_error', reason: 'module_threw' },
  R7: { code: 'module_error', reason: 'phase_violation' },
  R8: { code: 'module_error', reason: 'phase_violation' },
};

interface BehaviorLogSink {
  handler: ((moduleId: string, level: BehaviorLogLevel, message: string) => void) | null;
}

/** The runtime-owned mutable per-step intent set (runtime.md §14.5). */
interface MutableIntentSet {
  stepIndex: number;
  move: number | null;
  jump: JumpPhase | null;
  moveWriter: string | null;
  jumpWriter: string | null;
  transformWrites: IntentTransformWrite[];
  /** Committed `(entityId, axis)` keys in this step. */
  axes: Set<string>;
  /** Accepted intents committed in this step. */
  count: number;
}

function emptyMutableIntents(stepIndex: number): MutableIntentSet {
  return {
    stepIndex,
    move: null,
    jump: null,
    moveWriter: null,
    jumpWriter: null,
    transformWrites: [],
    axes: new Set(),
    count: 0,
  };
}

interface WallAnchor {
  /** Wall seconds of the anchor frame. */
  wall: number;
  /** simTime at the anchor frame. */
  simTime: number;
}

interface ModuleEntry {
  id: string;
  /** The declared phases; `['transform']` for an accepted M1 module. */
  phases: readonly SimulationPhase[];
  phased: boolean;
  instance: SimulationModule | SimulationPhaseModule;
  owners: readonly string[];
}

/** An `ActionSource.sample()` throw (module_error, reason `input_source_threw`). */
class InputSourceError extends Error {
  readonly reason = 'input_source_threw';
}

/**
 * A gameplay port commit call that violates a run-state rule (gameplay.md
 * §8.1: `module_error`, reason `gameplay_invalid` — e.g. `beginRespawn` while
 * `respawning`). Fail-stop, like every module contract violation.
 */
class GameplayInvalidError extends Error {
  readonly reason = 'gameplay_invalid';
  constructor(message: string) {
    super(clipMessage(message));
    this.name = 'GameplayInvalidError';
  }
}

/**
 * A gameplay port commit call made outside the `gameplay` phase (gameplay.md
 * §3.3: from any other phase the commit calls throw `module_error`,
 * reason `phase_violation`).
 */
class GameplayPhaseError extends Error {
  readonly reason = 'phase_violation';
  constructor() {
    super('the gameplay port commit calls are callable in the gameplay phase only');
    this.name = 'GameplayPhaseError';
  }
}

/** A `PhysicsPort` throw/validation failure (fail-stop `physics_port_error`). */
class PhysicsPortFailure extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(clipMessage(message));
    this.name = 'PhysicsPortFailure';
    this.reason = reason;
  }
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
  // Duck-typed: an artifact executed in another realm (the Node `vm` test host)
  // throws an Error that is not `instanceof` this realm's Error.
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
    const m = (e as { message: string }).message;
    if (m !== '') return clipMessage(m);
  }
  if (e instanceof Error) return clipMessage(e.message !== '' ? e.message : 'Error');
  try {
    const s = JSON.stringify(e);
    if (typeof s === 'string' && s.length > 0) return clipMessage(s);
  } catch {
    /* non-serializable — fall through */
  }
  return clipMessage(String(e));
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

function isPhysicsPort(v: unknown): v is PhysicsPort {
  return (
    isPlainObject(v) &&
    typeof v['stageCharacterMove'] === 'function' &&
    typeof v['step'] === 'function' &&
    typeof v['dispose'] === 'function'
  );
}

function isFiniteVec2(v: unknown): v is Vec2 {
  return (
    isPlainObject(v) &&
    typeof v['x'] === 'number' &&
    typeof v['y'] === 'number' &&
    Number.isFinite(v['x']) &&
    Number.isFinite(v['y'])
  );
}

/** Strict config parsing (runtime.md §3.1). */
function parseConfig(config: unknown): { cfg: ParsedConfig } | { error: RuntimeError } {
  if (!isPlainObject(config)) {
    return { error: fail('config_invalid', 'config must be an object', { reason: 'shape', path: '' }) };
  }
  const allowed = new Set([
    'snapshot',
    'registry',
    'modules',
    'actions',
    'physics',
    'settings',
    'clock',
    'driver',
    'fixedStepHz',
    'onFrame',
  ]);
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
  let actions: ActionSource;
  if (config.actions === undefined) {
    actions = NEUTRAL_ACTION_SOURCE;
  } else if (!isPlainObject(config.actions) || typeof config.actions['sample'] !== 'function') {
    return {
      error: fail('config_invalid', 'config field "actions" must be an ActionSource ({ sample(stepIndex) })', {
        reason: 'actions',
        path: '/actions',
      }),
    };
  } else {
    actions = config.actions as unknown as ActionSource;
  }
  let physics: PhysicsPort | undefined;
  if (config.physics !== undefined) {
    if (!isPhysicsPort(config.physics)) {
      return {
        error: fail('config_invalid', 'config field "physics" must be an initialized PhysicsPort', {
          reason: PHYSICS_PORT_REASON,
          path: '/physics',
        }),
      };
    }
    physics = config.physics;
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
      actions,
      physics,
      settings: config.settings,
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
  actions: ActionSource;
  physics?: PhysicsPort;
  settings: unknown;
  clock: () => number;
  clockLabel: 'performance' | 'injected';
  driverKind: 'raf' | 'manual';
  hz: number;
  onFrame?: () => void;
}

/**
 * Create a runtime instance (runtime.md §3.1). Validates the snapshot
 * (deep-freezing it on success), resolves the selected modules, validates
 * the M2 phase/ownership/exclusion rules, builds the initial mutable state
 * (`prev = curr = snapshot transforms`, stepIndex 0, simTime 0), and creates
 * one module instance per selection entry. No loop, timer, listener, or
 * renderer is installed at instantiate.
 */
export function instantiateRuntime(
  config: unknown,
): { ok: true; runtime: Runtime } | { ok: false; error: RuntimeError } {
  const parsed = parseConfig(config);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const { snapshot, registry, modules, actions, physics, settings, clock, clockLabel, driverKind, hz, onFrame } = parsed.cfg;

  const snap = validateRuntimeSnapshot(snapshot);
  if ('error' in snap) return { ok: false, error: snap.error };
  const { scene, sceneVersion, snapshotId, revision, game } = snap;
  // Phase 12 (c): the scene catalog (v4 only; null: one fixed scene).
  const sceneRows = snap.scenes;

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

  // §12.1: validate every declared phase list (non-empty, unique, canonical).
  for (const spec of selected) {
    if (spec.phases === undefined) continue;
    const check = validatePhaseList(spec.phases);
    if (!check.ok) {
      return {
        ok: false,
        error: fail('config_invalid', `module "${spec.id}": ${check.message}`, {
          reason: 'module_phases',
          path: '/modules',
        }),
      };
    }
  }

  const isM2 = selected.some((s) => s.phases !== undefined);
  // M3 (gameplay.md §3.1): a runtime is M3-enabled iff at least one selected
  // module declares `gameplay` or `camera`. M1/M2 sets keep the accepted
  // validation byte-for-byte (gameplay.md §3.5); M3 sets take the §3.4
  // composition table (the §12.4 M3 supersession, runtime.md §12.4).
  const isM3 = selected.some(
    (s) => s.phases !== undefined && (s.phases.includes('gameplay') || s.phases.includes('camera')),
  );
  // §14.8: at most 64 behavior modules per runtime instance.
  if (selected.filter((s) => s.id.startsWith(BEHAVIOR_MODULE_PREFIX)).length > INTENT_LIMITS.behaviorModules) {
    return {
      ok: false,
      error: fail('config_invalid', `at most ${INTENT_LIMITS.behaviorModules} behavior modules may be selected`, {
        reason: 'behavior_modules',
        path: '/modules',
      }),
    };
  }

  // Deep-freeze the snapshot (normative, runtime.md §2) — the input is
  // never written to; all mutable data lives in the simulation state.
  // Phase 12: for a v3 scene, modules see the scene with folders and
  // inactive entities resolved away (the input stays frozen as well).
  const inputSnapshot = deepFreeze(snapshot as RuntimeSnapshot);
  const frozenSnapshot = sceneVersion >= 3 ? deepFreeze({ ...inputSnapshot, scene } as RuntimeSnapshot) : inputSnapshot;

  // Resolve + deep-freeze the gameplay settings (runtime.md §3.1/§12.2).
  const settingsResult = resolveSettings(settings);
  if ('error' in settingsResult) return { ok: false, error: settingsResult.error };
  const resolvedSettings = deepFreeze(settingsResult.settings);

  // M2/M3 module-set validation (runtime.md §12.4) — before any instance is
  // created and before any port method is called.
  const controllerSpecs = selected.filter((s) => s.phases?.includes('controller') === true);
  const controllerIds =
    sceneVersion >= 2
      ? scene.entities
          .filter((e) => (e.components as { controller?: unknown }).controller !== undefined)
          .map((e) => e.id)
      : [];
  const sceneCameraEntity = scene.entities.find((e) => (e.components as { camera?: unknown }).camera !== undefined);
  if (isM2) {
    if (isM3) {
      // ---- M3 composition (gameplay.md §3.4; runtime.md §12.4 supersession)
      if (sceneVersion < 3) {
        return {
          ok: false,
          error: fail('config_invalid', 'an M3 module requires a schemaVersion 3 snapshot scene', {
            reason: 'scene_version',
            path: '/modules',
          }),
        };
      }
      if (game === null) {
        return {
          ok: false,
          error: fail('config_invalid', 'an M3 module set requires a non-null content.game block on the v3 snapshot', {
            reason: 'game_config',
            path: '/modules',
          }),
        };
      }
      const gameplayCount = selected.filter((s) => s.phases?.includes('gameplay') === true).length;
      if (gameplayCount > 1) {
        return {
          ok: false,
          error: fail('config_invalid', 'at most one module may declare the gameplay phase', {
            reason: 'gameplay_module',
            path: '/modules',
          }),
        };
      }
      const cameraModuleCount = selected.filter((s) => s.phases?.includes('camera') === true).length;
      if (cameraModuleCount === 0) {
        return {
          ok: false,
          error: fail('config_invalid', 'an M3 module set requires exactly one camera-phase module', {
            reason: 'camera_owner',
            detail: 'missing',
            path: '/modules',
          }),
        };
      }
      if (cameraModuleCount > 1) {
        return {
          ok: false,
          error: fail('config_invalid', 'an M3 module set requires exactly one camera-phase module (multiple found)', {
            reason: 'camera_owner',
            detail: 'multiple',
            path: '/modules',
          }),
        };
      }
      const cameraFollow = sceneCameraEntity
        ? (sceneCameraEntity.components as { cameraFollow?: unknown }).cameraFollow
        : undefined;
      if (!sceneCameraEntity || cameraFollow === undefined) {
        return {
          ok: false,
          error: fail('config_invalid', 'the scene camera entity carries no cameraFollow component', {
            reason: 'camera_follow',
            path: '/modules',
          }),
        };
      }
    } else if (sceneVersion !== 2) {
      return {
        ok: false,
        error: fail('config_invalid', 'an M2 module requires a schemaVersion 2 snapshot scene', {
          reason: 'scene_version',
          path: '/modules',
        }),
      };
    }
    const selectedIds = new Set(selected.map((s) => s.id));
    for (const spec of selected) {
      for (const excluded of spec.excludes ?? []) {
        if (selectedIds.has(excluded)) {
          return {
            ok: false,
            error: fail('module_combination_unsupported', `modules "${spec.id}" and "${excluded}" cannot coexist`, {
              reason: `${spec.id}+${excluded}`,
              detail: `${spec.id}+${excluded}`,
            }),
          };
        }
      }
    }
    if (controllerSpecs.length > 0 && controllerIds.length !== 1) {
      return {
        ok: false,
        error: fail(
          'config_invalid',
          `a controller module requires exactly one components.controller entity (found ${controllerIds.length})`,
          { reason: 'controller_target', path: '/modules' },
        ),
      };
    }
    const needsPort = selected.some((s) => s.requiresPhysicsPort === true);
    if (needsPort && physics === undefined) {
      return {
        ok: false,
        error: fail('config_invalid', 'the selected module set requires an injected physics port', {
          reason: PHYSICS_PORT_REASON,
          path: '/physics',
        }),
      };
    }
  }

  // Build the initial mutable state (runtime.md §4): prev = curr = the
  // snapshot transforms (both deep copies — the snapshot is never aliased).
  const order = scene.entities.map((e) => e.id);
  const entities = new Map<string, SimEntityData>();
  const prev = new Map<string, TransformState>();
  const curr = new Map<string, TransformState>();
  const cameraEntityIds: string[] = [];
  const colliderEntityIds = new Set<string>();
  const controllerEntityIds: string[] = [];
  // M3 (gameplay.md §4.1): the scene-side sources of the frozen gameplay
  // content projection (collected in document order; the projection sorts by
  // entityId codepoint order — document order is explicitly not used).
  const zoneSpecs: { entityId: string; role: GameZoneRole; center: Vec2; half: Vec2; safeSpawnId?: string; activation?: Readonly<CheckpointActivationAppearance> }[] = [];
  const spawnSpecs: { entityId: string; center: Vec2 }[] = [];
  let cameraFollowData: { deadZone: Vec2; smoothing: number; bounds: GameCameraBounds } | undefined;
  for (const e of scene.entities) {
    const t = e.components.transform;
    const components = e.components;
    const data: SimEntityData = { id: e.id, parentId: e.parentId ?? null, transform: cloneTransform(t) };
    if (e.name !== undefined) data.name = e.name;
    const box = components.box;
    if (box) data.box = { size: [box.size[0], box.size[1], box.size[2]], material: { color: box.material.color } };
    const cam = components.camera;
    if (cam) {
      data.camera = { type: cam.type, fovY: cam.fovY, near: cam.near, far: cam.far };
      cameraEntityIds.push(e.id);
    }
    const v2 = components as { collider?: unknown; controller?: unknown };
    if (v2.collider !== undefined) {
      data.hasCollider = true;
      colliderEntityIds.add(e.id);
    }
    if (v2.controller !== undefined) {
      data.hasController = true;
      controllerEntityIds.push(e.id);
    }
    const v3 = components as {
      gameZone?: { role: GameZoneRole; size: [number, number]; safeSpawnId?: string; activation?: CheckpointActivationAppearance };
      playerSpawn?: unknown;
      cameraFollow?: { deadZone: { x: number; y: number }; smoothing: number; bounds?: GameCameraBounds };
    };
    if (v3.gameZone !== undefined) {
      const z = v3.gameZone;
      zoneSpecs.push({
        entityId: e.id,
        role: z.role,
        center: { x: t.position[0], y: t.position[1] },
        half: { x: z.size[0] / 2, y: z.size[1] / 2 },
        ...(z.safeSpawnId !== undefined ? { safeSpawnId: z.safeSpawnId } : {}),
        ...(z.activation !== undefined ? { activation: z.activation } : {}),
      });
    }
    if (v3.playerSpawn !== undefined) {
      spawnSpecs.push({ entityId: e.id, center: { x: t.position[0], y: t.position[1] } });
    }
    if (cam && v3.cameraFollow !== undefined) {
      const f = v3.cameraFollow;
      cameraFollowData = {
        deadZone: { x: f.deadZone.x, y: f.deadZone.y },
        smoothing: f.smoothing,
        // v4: bounds are optional (unbounded when absent).
        bounds: f.bounds !== undefined
          ? { minX: f.bounds.minX, maxX: f.bounds.maxX, minY: f.bounds.minY, maxY: f.bounds.maxY }
          : { minX: Number.NEGATIVE_INFINITY, maxX: Number.POSITIVE_INFINITY, minY: Number.NEGATIVE_INFINITY, maxY: Number.POSITIVE_INFINITY },
      };
    }
    entities.set(e.id, data);
    prev.set(e.id, cloneTransform(t));
    curr.set(e.id, cloneTransform(t));
  }

  // The camera entity (validateScene guarantees exactly one — defensive
  // guard for the invariant).
  const cameraId = cameraEntityIds[0];
  let cameraInfo: CameraInfo | undefined;
  const cameraEntity = cameraId !== undefined ? entities.get(cameraId) : undefined;
  if (cameraEntity?.camera) {
    cameraInfo = { id: cameraEntity.id, fovY: cameraEntity.camera.fovY, near: cameraEntity.camera.near, far: cameraEntity.camera.far };
  }
  if (!cameraInfo) {
    return {
      ok: false,
      error: fail('snapshot_invalid', 'scene has no camera entity (project-model §10.3 requires exactly one)', {
        reason: 'scene_validation',
      }),
    };
  }

  // M3 (gameplay.md §4.1): the frozen gameplay-content projection — the zones
  // in ascending entityId codepoint order, the spawn markers, the player and
  // camera references of the frozen `content.game` block. Deep-frozen at
  // instantiate and never written (the port exposes it read-only).
  let gameContent: GameContent | null = null;
  if (isM3) {
    const g = game as GameConfig; // non-null: the §3.4 composition check above
    const byId = (a: { entityId: string }, b: { entityId: string }): number =>
      a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0;
    gameContent = deepFreeze({
      game: g,
      zones: [...zoneSpecs].sort(byId),
      spawns: [...spawnSpecs].sort(byId),
      player: { entityId: g.playerId },
      camera: {
        entityId: cameraId as string,
        deadZone: cameraFollowData?.deadZone ?? { x: 0, y: 0 },
        smoothing: cameraFollowData?.smoothing ?? 0,
        bounds: cameraFollowData?.bounds ?? { minX: 0, maxX: 0, minY: 0, maxY: 0 },
      },
    });
  }

  // One module instance per selection entry (created at instantiate). The
  // behavior-log sink routes a behavior's accepted `ctx.log` entries into the
  // runtime's own bounded diagnostics ring (runtime.md §14.8.1); the holder
  // is bound to the RuntimeInstance once it exists (no log can be emitted
  // before the first step).
  const logSink: BehaviorLogSink = { handler: null };
  // Phase 12 (c): with a scene catalog the tag index follows loads/unloads.
  const liveTags = sceneRows !== null ? createTagQuery(frozenSnapshot) : null;
  const configFor = (specId: string): ModuleConfig => ({
    fixedStepHz: hz,
    settings: resolvedSettings,
    sceneVersion,
    // M3 (runtime.md §12.1/§15): the frozen `content.game` block, v3 only.
    ...(sceneVersion >= 3 ? { game } : {}),
    behaviorLog: (level: BehaviorLogLevel, message: string) => logSink.handler?.(specId, level, message),
    ...(liveTags !== null ? { tags: liveTags } : {}),
  });
  const entries: ModuleEntry[] = [];
  const disposeCreated = (): void => {
    for (const entry of entries) {
      const d = entry.instance.dispose;
      if (typeof d === 'function') {
        try {
          d.call(entry.instance);
        } catch {
          /* a failing module dispose must not break instantiation */
        }
      }
    }
  };
  for (const spec of selected) {
    let instance: SimulationModule | SimulationPhaseModule;
    try {
      instance = spec.create(frozenSnapshot, configFor(spec.id));
    } catch (e) {
      disposeCreated();
      // §14.3.1: a behavior host create() failure carries its own contract code
      // (`config_invalid` prepare/instantiate/property, `transform_owner_forbidden`
      // ownership) instead of the generic `module_create`.
      if (e instanceof BehaviorHostError) {
        return {
          ok: false,
          error: fail(e.code, `module "${spec.id}" create() failed: ${messageOf(e)}`, {
            reason: e.reason,
            moduleId: spec.id,
            ...(e.detail !== undefined ? { detail: e.detail } : {}),
          }),
        };
      }
      return {
        ok: false,
        error: fail('config_invalid', `module "${spec.id}" create() threw: ${messageOf(e)}`, {
          reason: 'module_create',
        }),
      };
    }
    if (typeof instance?.step !== 'function') {
      disposeCreated();
      return {
        ok: false,
        error: fail('config_invalid', `module "${spec.id}" create() did not return { step }`, {
          reason: 'module_step',
        }),
      };
    }
    const phased = spec.phases !== undefined;
    const phases: readonly SimulationPhase[] = phased ? (spec.phases as readonly SimulationPhase[]) : ['transform'];
    if (phased) {
      const owners = (instance as SimulationPhaseModule).transformOwners;
      if (!Array.isArray(owners) || owners.some((o) => typeof o !== 'string')) {
        disposeCreated();
        return {
          ok: false,
          error: fail('config_invalid', `module "${spec.id}" must declare string transformOwners at create`, {
            reason: 'module_owners',
          }),
        };
      }
    }
    entries.push({ id: spec.id, phases, phased, instance, owners: [] });
  }

  // §12.3/§12.4: transform ownership (declared at create), duplicate-writer
  // and forbidden-entity rejection. A failure disposes every created
  // instance — no runtime instance is created and no port method is called.
  if (isM2) {
    // First pass: collect owners, then detect duplicate claims and missing
    // entities (runtime.md §12.4 table order).
    const ownerByEntity = new Map<string, string>();
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]!;
      const spec = selected[i]!;
      const owners = entry.phased
        ? (entry.instance as SimulationPhaseModule).transformOwners
        : spec.legacyTransformOwners
          ? spec.legacyTransformOwners(frozenSnapshot)
          : [];
      entry.owners = owners;
      for (const entityId of owners) {
        // Phase 12 (c): an owner in a scene that is not loaded is checked when it loads.
        if (!entities.has(entityId) && sceneRows === null) {
          disposeCreated();
          return {
            ok: false,
            error: fail('transform_owner_conflict', `module "${entry.id}" claims missing entity "${entityId}"`, {
              reason: entityId,
              moduleId: entry.id,
            }),
          };
        }
        const other = ownerByEntity.get(entityId);
        if (other !== undefined && other !== entry.id) {
          disposeCreated();
          return {
            ok: false,
            error: fail('transform_owner_conflict', `entity "${entityId}" is claimed by "${other}" and "${entry.id}"`, {
              reason: entityId,
              moduleId: entry.id,
            }),
          };
        }
        ownerByEntity.set(entityId, entry.id);
      }
    }
    // Second pass: camera and physics-entity protections.
    for (const entry of entries) {
      const isController = entry.phases.includes('controller');
      for (const entityId of entry.owners) {
        if (cameraEntityIds.includes(entityId) && !isM3) {
          disposeCreated();
          return {
            ok: false,
            error: fail('transform_owner_forbidden', `module "${entry.id}" claims the camera entity "${entityId}"`, {
              reason: 'camera',
              moduleId: entry.id,
              detail: 'camera',
            }),
          };
        }
        if ((colliderEntityIds.has(entityId) || controllerEntityIds.includes(entityId)) && !isController) {
          disposeCreated();
          return {
            ok: false,
            error: fail('transform_owner_forbidden', `module "${entry.id}" claims physics entity "${entityId}" without the controller phase`, {
              reason: 'physics_entity',
              moduleId: entry.id,
              detail: 'physics_entity',
            }),
          };
        }
      }
    }
    // M3 (gameplay.md §3.4): the single camera-phase module must own exactly
    // the scene's camera entity (`transformOwners` declared at create).
    if (isM3) {
      const cameraEntry = entries.find((en) => en.phases.includes('camera'));
      const owners = cameraEntry ? cameraEntry.owners : [];
      if (owners.length !== 1 || owners[0] !== cameraId) {
        disposeCreated();
        return {
          ok: false,
          error: fail('config_invalid', `the camera-phase module "${cameraEntry?.id ?? '(none)'}" must own exactly the scene camera entity "${cameraId}"`, {
            reason: 'camera_owner',
            detail: 'owner_mismatch',
            moduleId: cameraEntry?.id,
          }),
        };
      }
    }
  }

  // Phase 12 (c): the start scenes as batches (members listed by the host;
  // unlisted entities belong to the first start scene).
  const startBatches: { sceneId: string; entities: EntityV3[] }[] = [];
  if (sceneRows !== null) {
    const starts = sceneRows.filter((r) => r.start);
    const sceneOfEntity = new Map<string, string>();
    for (const row of starts) for (const id of row.entityIds ?? []) sceneOfEntity.set(id, row.sceneId);
    const bySceneId = new Map<string, EntityV3[]>(starts.map((r) => [r.sceneId, []]));
    for (const e of scene.entities) {
      bySceneId.get(sceneOfEntity.get(e.id) ?? starts[0]!.sceneId)!.push(e as unknown as EntityV3);
    }
    for (const row of starts) startBatches.push({ sceneId: row.sceneId, entities: bySceneId.get(row.sceneId)! });
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
    entries,
    isM2,
    isM3,
    gameContent,
    actions,
    physics,
    settings: resolvedSettings,
    controllerEntityId: controllerEntityIds[0],
    order,
    entities,
    cameraInfo,
    prev,
    curr,
    logSink,
    sceneRows,
    startBatches,
    liveTags,
    animatorControllers: snap.animators as unknown as readonly AnimatorControllerLike[],
    initialEntities: scene.entities as unknown as readonly EntityV3[],
  });
  return { ok: true, runtime: rt };
}

function resolveSettings(input: unknown): { settings: GameplaySettings } | { error: RuntimeError } {
  // project-model owns the settings registry and validation; the runtime
  // consumes the resolved, frozen object (runtime.md §3.1/§12.2).
  const content = input === undefined ? {} : input;
  const result = resolveGameplaySettings(content);
  if (!result.ok) {
    return {
      error: fail('config_invalid', 'gameplay settings are invalid', {
        reason: 'settings',
        path: '/settings',
      }),
    };
  }
  return { settings: result.normalized };
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
  entries: ModuleEntry[];
  isM2: boolean;
  /** M3-enabled (gameplay.md §3.1): at least one module declares `gameplay`/`camera`. */
  isM3: boolean;
  /** The frozen gameplay-content projection (M3 sets), else `null`. */
  gameContent: GameContent | null;
  actions: ActionSource;
  physics?: PhysicsPort;
  settings: GameplaySettings;
  controllerEntityId?: string;
  order: string[];
  entities: Map<string, SimEntityData>;
  cameraInfo: CameraInfo;
  prev: Map<string, TransformState>;
  curr: Map<string, TransformState>;
  logSink: BehaviorLogSink;
  sceneRows: readonly RuntimeSceneRow[] | null;
  startBatches: readonly { sceneId: string; entities: EntityV3[] }[];
  liveTags: LiveTagIndex | null;
  /** Phase 9.7: the controllers, and the snapshot scene's entities (their `animator` components). */
  animatorControllers: readonly AnimatorControllerLike[];
  initialEntities: readonly EntityV3[];
}

/** Phase 12 (c): one loaded scene inside the runtime. */
interface SceneBatchState {
  sceneId: string;
  start: boolean;
  entities: readonly EntityV3[];
  ids: ReadonlySet<string>;
  contribution: SceneContribution;
}

/** Phase 12 (c): one requested scene operation, committed with its step. */
type SceneOp = { op: 'load'; sceneId: string; at?: readonly [number, number, number] } | { op: 'unload'; sceneId: string };

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
  private entries: ModuleEntry[];
  private readonly isM2: boolean;
  // ---- M3 game-session state (gameplay.md §2/§6; M3-enabled sets only) ----
  private readonly isM3: boolean;
  /** Replaced (never mutated) when a scene load/unload changes the zones or spawns. */
  private gameContent: GameContent | null;
  /** The runtime-owned run state machine (absent for M1/M2 sets). */
  private session: GameSession | null;
  /** The frozen `StepContext.gameplay` port (built once at instantiate). */
  private sessionPort: GameSessionPort | null;
  /** The last committed `GameView` (replaced at commit and boundaries, §6/R8). */
  private lastGameView: GameView | null;
  /**
   * Test-only reset fault-injection seam (gameplay.md §5.1/§5.4): when set to
   * a reset phase label (`R1`–`R8`), the reset transaction fail-stops at that
   * phase with the phase's exact failure signature before running the phase's
   * natural logic. Absent (`null`) in production; set only by the
   * `tests/m3-respawn/**` evidence through `injectResetFault`.
   */
  private resetFaultPhase: string | null = null;
  /** The presentation-only viewport record (gameplay.md §7.1). */
  private viewport: ViewportInfo;
  /** The committed player motion (gameplay.md §6, C41-1). */
  private playerMotion: PlayerMotion;
  /** The last completed motion segment per entity (the `lastMotionSegment` port). */
  private lastSegments: Map<string, Readonly<MotionSegment>>;
  /** The player entity id (`content.game.playerId`). */
  private readonly playerEntityId: string;
  /**
   * Executed steps since instantiate (the M3 settle gate: no run boundary
   * during the accepted 12-step settle pre-roll — the fixtures pin the first
   * boundary at step 12, the 12th executed step).
   */
  private executedSteps = 0;
  private readonly actions: ActionSource;
  private readonly physics?: PhysicsPort;
  private readonly settings: GameplaySettings;
  private readonly controllerEntityId?: string;
  private order: readonly string[];
  private entities: Map<string, SimEntityData>;
  private readonly cameraInfo: CameraInfo;
  private entityCount: number;
  private prev: Map<string, TransformState>;
  private curr: Map<string, TransformState>;
  /** The last fully committed step's transforms (fail-stop rendering). */
  private committed: Map<string, TransformState> | null = null;
  private stepIndex = 0;
  private simTime = 0;
  private anchor: WallAnchor | null = null;
  private lastAlpha = 0;
  private frameCount = 0;
  private droppedSteps = 0;
  private droppedInputSteps = 0;
  private clockWarningCount = 0;
  private inputSamples = 0;
  private physicsSteps = 0;
  private settleSteps = 0;
  private failedModuleId?: string;
  private failedPhase?: SimulationPhase;
  private failedStepIndex?: number;
  private errorRing: DiagnosticErrorEntry[] = [];
  private errorCount = 0;
  private rafId: number | null = null;
  /** The settle pre-roll is initialization: cancellable before the first frame. */
  private prerollDone = false;
  private needsPreroll = false;
  private currentPhase?: SimulationPhase;
  private currentModuleId?: string;
  private staged = new Map<string, Vec2>();
  private lastCharacterResult?: CharacterMoveResult;
  /** The runtime's per-step intent set (runtime.md §14.5). */
  private intents: MutableIntentSet = emptyMutableIntents(-1);
  /** Accepted intents committed in this runtime instance. */
  private intentCommitCount = 0;
  /** The behavior-log ring sink bound to this instance (§14.8.1). */
  private readonly logSink: BehaviorLogSink;
  /** Last observed behavior log totals (retained after disposal). */
  private behaviorLogTotals = { logCount: 0, logDropped: 0 };
  // ---- Phase 12 (c) scene set ---------------------------------------------
  /** Every scene of the project (null: one fixed scene, no scene API). */
  private readonly sceneRows: readonly RuntimeSceneRow[] | null;
  private readonly startBatchSource: ReadonlyMap<string, readonly EntityV3[]>;
  /** Loaded scenes, in load order. */
  private batches = new Map<string, SceneBatchState>();
  private sceneStatus = new Map<string, SceneStatus>();
  /** Loads requested and not yet handed to the host. */
  private requestedLoads = new Map<string, { at?: readonly [number, number, number] }>();
  /** Loads the host is fetching. */
  private fetchingLoads = new Map<string, { at?: readonly [number, number, number] }>();
  /** Fetched scenes waiting for the next step boundary. */
  private readyLoads = new Map<string, readonly EntityV3[]>();
  private pendingUnloads = new Set<string>();
  /** Scene ops issued during the running step (committed with it). */
  private stepSceneOps: SceneOp[] = [];
  private sceneRevision = 0;
  private sceneSetCache: SceneSetView | null = null;
  private readonly liveTags: LiveTagIndex | null;
  // ---- Phase 9.7: animators ----
  private readonly animatorControllers = new Map<string, AnimatorControllerLike>();
  private readonly animatorMachines = new Map<string, { machine: AnimatorMachine; entity: EntityV3 }>();
  /** Parent ids of the loaded entities (the player's model may be a child of the player). */
  private readonly parentOf = new Map<string, string>();
  private animatorEvents: readonly AnimatorEventRecord[] = Object.freeze([]);
  private animatorWasGrounded = true;
  private readonly animatorControl: BehaviorAnimatorControl;
  /** Exit zones the player is inside (entry is edge-triggered). */
  private exitsInside = new Set<string>();
  /** An exit's spawn: the player moves there once `waitFor` are loaded. */
  private pendingTransfer: { spawnId: string; waitFor: readonly string[] } | null = null;
  /** A `respawn` intent committed in this step. */
  private respawnRequested = false;
  /** Entities that are never unloaded with their scene (camera, player, start spawn, lights). */
  private readonly pinnedIds: ReadonlySet<string>;
  private readonly sceneControl: BehaviorSceneControl;

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
    this.entries = args.entries;
    this.isM2 = args.isM2;
    this.isM3 = args.isM3;
    this.gameContent = args.gameContent;
    if (args.isM3 && args.gameContent !== null) {
      this.session = new GameSession(args.snapshotId);
      this.playerEntityId = args.gameContent.player.entityId;
      this.viewport = Object.freeze({ width: 0, height: 0, aspect: DEFAULT_ASPECT });
      // gameplay.md §6 (game-view fixture note): awaitingStart/won have no
      // completed step, so the committed motion is { speed: 0, grounded: true }.
      this.playerMotion = Object.freeze({ speed: 0, grounded: true });
      this.lastSegments = new Map();
      this.sessionPort = this.buildGameSessionPort();
      // The instantiate-time committed view (stepIndex 0, simTime 0).
      this.lastGameView = this.buildGameView(0, 0);
    } else {
      this.session = null;
      this.sessionPort = null;
      this.lastGameView = null;
      this.viewport = Object.freeze({ width: 0, height: 0, aspect: DEFAULT_ASPECT });
      this.playerMotion = Object.freeze({ speed: 0, grounded: true });
      this.lastSegments = new Map();
      this.playerEntityId = '';
    }
    this.actions = args.actions;
    this.physics = args.physics;
    this.settings = args.settings;
    this.controllerEntityId = args.controllerEntityId;
    this.order = args.order;
    this.entities = args.entities;
    this.cameraInfo = args.cameraInfo;
    this.entityCount = args.order.length;
    this.prev = args.prev;
    this.curr = args.curr;
    // §13: the state committed at the end of the last fully completed step.
    // Initialized to the instantiate-time state so a fail-stop during the
    // 12-step settle pre-roll (before any step completes) renders only the
    // committed initial state — never the abandoned step's transform.
    this.committed = cloneCurr(args.curr);
    this.logSink = args.logSink;
    args.logSink.handler = (moduleId: string, level: BehaviorLogLevel, message: string): void =>
      this.recordBehaviorLog(moduleId, level, message);
    this.sceneRows = args.sceneRows;
    this.liveTags = args.liveTags;
    this.startBatchSource = new Map(args.startBatches.map((b) => [b.sceneId, b.entities]));
    const pinned = new Set<string>([args.cameraInfo.id]);
    if (args.controllerEntityId !== undefined) pinned.add(args.controllerEntityId);
    if (args.gameContent !== null) pinned.add(args.gameContent.game.spawnId);
    for (const e of args.entities.values()) if (e.camera !== undefined) pinned.add(e.id);
    for (const b of args.startBatches) {
      for (const e of b.entities) if ((e.components as { light?: unknown }).light !== undefined) pinned.add(e.id);
    }
    this.pinnedIds = pinned;
    if (args.sceneRows !== null) {
      for (const row of args.sceneRows) this.sceneStatus.set(row.sceneId, 'unloaded');
      for (const b of args.startBatches) {
        this.batches.set(b.sceneId, { sceneId: b.sceneId, start: true, entities: Object.freeze(b.entities), ids: new Set(b.entities.map((e) => e.id)), contribution: sceneContribution(b.entities) });
        this.sceneStatus.set(b.sceneId, 'loaded');
      }
      // The projection from the batches (it carries the exit-zone fields).
      this.rebuildGameContent();
    }
    this.sceneControl = this.buildSceneControl();
    for (const c of args.animatorControllers) this.animatorControllers.set(c.controllerId, c);
    this.addAnimators(args.initialEntities);
    this.animatorControl = Object.freeze({
      of: (entityId: string): BehaviorAnimatorHandle | null => {
        const rec = this.animatorMachines.get(String(entityId));
        if (rec === undefined) return null;
        const m = rec.machine;
        return Object.freeze({
          set: (name: string, value: number | boolean) => m.set(String(name), value),
          trigger: (name: string) => m.trigger(String(name)),
          get: (name: string) => m.get(String(name)),
          state: () => m.stateName(),
        });
      },
    });
  }

  // ---- Phase 9.7: animators -------------------------------------------------

  /** Start an animator for every entity of these that has one (and whose controller exists). */
  private addAnimators(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      if (e.parentId !== undefined) this.parentOf.set(e.id, e.parentId);
      const a = (e.components as { animator?: { controller: string; parameters?: Record<string, number | boolean> } }).animator;
      if (a === undefined) continue;
      const controller = this.animatorControllers.get(a.controller);
      if (controller === undefined) continue;
      this.animatorMachines.set(e.id, { machine: new AnimatorMachine(controller, a.parameters ?? {}), entity: e });
    }
  }

  private removeAnimators(ids: ReadonlySet<string>): void {
    for (const id of ids) {
      this.animatorMachines.delete(id);
      this.parentOf.delete(id);
    }
  }

  /** Back to the entry states (a replay or a new run). */
  private resetAnimators(): void {
    const entities = [...this.animatorMachines.values()].map((r) => r.entity);
    this.animatorMachines.clear();
    this.addAnimators(entities);
    this.animatorEvents = Object.freeze([]);
    this.animatorWasGrounded = true;
  }

  private isPlayerOrChild(id: string): boolean {
    if (this.playerEntityId === '') return false;
    let cur: string | undefined = id;
    for (let depth = 0; cur !== undefined && depth < 64; depth++) {
      if (cur === this.playerEntityId) return true;
      cur = this.parentOf.get(cur);
    }
    return false;
  }

  /**
   * Advance every animator by one fixed step. The player's animators get
   * `speed` (horizontal, m/s), `grounded`, `velocityY` and the `landed`
   * trigger from the committed motion, when their controller has them.
   */
  private stepAnimators(): void {
    if (this.animatorMachines.size === 0) return;
    const seg = this.lastSegments.get(this.playerEntityId);
    const vx = seg !== undefined ? (seg.to.x - seg.from.x) * this.hz : 0;
    const vy = seg !== undefined ? (seg.to.y - seg.from.y) * this.hz : 0;
    const grounded = this.playerMotion.grounded;
    const landed = grounded && !this.animatorWasGrounded;
    this.animatorWasGrounded = grounded;
    const fired: AnimatorEventRecord[] = [];
    const dt = 1 / this.hz;
    for (const [id, { machine }] of this.animatorMachines) {
      if (this.isPlayerOrChild(id)) {
        machine.set('speed', Math.abs(vx));
        machine.set('grounded', grounded);
        machine.set('velocityY', vy);
        if (landed) machine.trigger('landed');
      }
      for (const e of machine.step(dt)) fired.push(Object.freeze({ entityId: id, name: e.name, clip: e.clip, stepIndex: this.stepIndex }));
    }
    this.animatorEvents = Object.freeze(fired);
  }

  /** Phase 9.7: every loaded animator's pose (the renderer plays these). */
  animatorPoses(): ReadonlyMap<string, AnimatorPose> {
    const out = new Map<string, AnimatorPose>();
    for (const [id, { machine }] of this.animatorMachines) out.set(id, machine.pose());
    return out;
  }

  start(): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    if (this.stateName === 'failed') {
      return { ok: false, error: fail('runtime_failed', 'runtime is failed (dispose and instantiate fresh; a failed instance cannot resume)') };
    }
    if (this.stateName === 'running') {
      return { ok: false, error: fail('runtime_already_started', 'runtime is already running') };
    }
    // Settle pre-roll (M2 module sets): initialization on the first frame
    // after start, cancellable by stop()/dispose() before that frame.
    if (this.isM2 && !this.prerollDone) this.needsPreroll = true;
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
    if (this.stateName === 'failed') {
      // §13 effect 5: stop() from `failed` returns { ok: true } (no driver).
      return { ok: true };
    }
    if (this.stateName !== 'running') {
      return { ok: false, error: fail('runtime_not_running', 'runtime is not running (stop requires running)') };
    }
    // Cancel the driver (the owned listener is removed); the mutable
    // state is RETAINED — a restart continues (simTime/stepIndex keep
    // counting; M1 defines no reset).
    this.cancelDriver();
    // A stop before the pre-roll frame cancels the pending initialization.
    this.needsPreroll = false;
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
    if (this.stateName === 'failed') {
      return { ok: false, error: fail('runtime_failed', 'runtime is failed (a failed instance is never ticked again)') };
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
    const failed = this.stateName === 'failed' && this.committed !== null;
    const prev = failed ? this.committed! : this.prev;
    const curr = failed ? this.committed! : this.curr;
    const alpha = this.stateName === 'failed' ? 0 : this.lastAlpha;
    const transforms: InterpolatedTransform[] = [];
    for (const id of this.order) {
      const p = prev.get(id);
      const c = curr.get(id);
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

  // ---- M3 run surface (gameplay.md §6.1; M3-enabled runtimes only) --------

  getGameView(): { ok: true; view: GameView } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    if (this.session === null || this.lastGameView === null) {
      return {
        ok: false,
        error: fail('game_session_unavailable', 'this runtime has no M3 game session (no selected module declares the gameplay or camera phase)', {
          reason: 'schedule',
        }),
      };
    }
    // A new deep-frozen copy per call (gameplay.md §6): the caller may hold
    // any number of views without aliasing the committed one.
    return { ok: true, view: deepFreeze(structuredClone(this.lastGameView)) };
  }

  gameCommand(cmd: 'start' | 'replay'): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    if (this.session === null) {
      return {
        ok: false,
        error: fail('game_session_unavailable', 'this runtime has no M3 game session (no selected module declares the gameplay or camera phase)', {
          reason: 'schedule',
        }),
      };
    }
    if (this.stateName === 'failed') {
      return {
        ok: false,
        error: fail('runtime_failed', 'the runtime is failed (a failed instance never steps again; the run is frozen at its last committed value)'),
      };
    }
    const res = this.session.submit(cmd);
    if (!res.ok) {
      const rej = res.error;
      const error: RuntimeError = {
        code: 'game_command_invalid',
        reason: rej.reason,
        command: rej.command,
        message: rej.message,
      };
      if (rej.state !== undefined) error.state = rej.state;
      return { ok: false, error };
    }
    return { ok: true };
  }

  setViewport(width: number, height: number): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    if (this.session === null) {
      return {
        ok: false,
        error: fail('game_session_unavailable', 'this runtime has no M3 game session (no selected module declares the gameplay or camera phase)', {
          reason: 'schedule',
        }),
      };
    }
    const valid =
      typeof width === 'number' &&
      typeof height === 'number' &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width > 0 &&
      height > 0 &&
      width <= 16384 &&
      height <= 16384;
    if (!valid) {
      return {
        ok: false,
        error: fail('camera_viewport_invalid', `viewport dimensions must be finite, positive and ≤ 16384 (got ${width}×${height}); the previous record is retained`, {
          width,
          height,
        }),
      };
    }
    // Presentation-only (gameplay.md §7.1): never steps the simulation, never
    // advances the step counter; the camera module reads it in the camera
    // phase.
    this.viewport = Object.freeze({ width, height, aspect: width / height });
    return { ok: true };
  }

  // ---- Phase 12 (c) scene set ---------------------------------------------

  sceneSet(): SceneSetView {
    if (this.sceneSetCache === null) {
      this.sceneSetCache = Object.freeze({
        revision: this.sceneRevision,
        batches: Object.freeze([...this.batches.values()].map((b) => Object.freeze({ sceneId: b.sceneId, start: b.start, entities: b.entities }))),
        status: Object.freeze(Object.fromEntries(this.sceneStatus)),
      });
    }
    return this.sceneSetCache;
  }

  takeSceneRequests(): SceneLoadRequest[] {
    const out: SceneLoadRequest[] = [];
    for (const [sceneId, req] of this.requestedLoads) {
      this.fetchingLoads.set(sceneId, req);
      out.push(Object.freeze({ sceneId, ...(req.at !== undefined ? { at: req.at } : {}) }));
    }
    this.requestedLoads.clear();
    return out;
  }

  provideScene(
    sceneId: string,
    result: { ok: true; entities: readonly EntityV3[] } | { ok: false; message: string },
  ): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    // A load cancelled while it was fetched (an unload, a replay) is dropped.
    if (!this.fetchingLoads.has(sceneId)) return { ok: true };
    if (!result.ok) {
      this.fetchingLoads.delete(sceneId);
      this.setSceneStatus(sceneId, 'unloaded');
      this.recordError({ code: 'scene_load_failed', message: clipMessage(`scene "${sceneId}" could not be loaded: ${result.message}`), stepIndex: this.stepIndex, reason: 'fetch' });
      return { ok: true };
    }
    this.readyLoads.set(sceneId, result.entities);
    return { ok: true };
  }

  requestScene(op: 'load' | 'unload', sceneId: string, options?: SceneLoadOptions): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    const problem = this.sceneOpProblem(op, sceneId, options);
    if (problem !== null) return { ok: false, error: fail('scene_invalid', problem, { reason: op }) };
    this.enqueueSceneOp(op === 'load' ? { op, sceneId, ...(options?.at !== undefined ? { at: options.at } : {}) } : { op, sceneId });
    return { ok: true };
  }

  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: true, alreadyDisposed: true };
    }
    this.cancelDriver();
    this.stateName = 'disposed';
    // Capture the behavior log totals before the instances are released so
    // `logCount`/`logDropped` stay observable after disposal (runtime.md §8).
    this.behaviorLogDiagnostics();
    // Release the module instances and all references held by the
    // runtime so the heap is reclaimable (runtime.md §3.4/§13): dispose is
    // called exactly once on every module instance (including a failed one)
    // and on the port.
    for (const entry of this.entries) {
      const d = entry.instance.dispose;
      if (typeof d === 'function') {
        try {
          d.call(entry.instance);
        } catch {
          /* a failing module dispose must not break runtime disposal */
        }
      }
    }
    this.entries = [];
    if (this.physics) {
      try {
        this.physics.dispose();
      } catch {
        /* a failing port dispose must not break runtime disposal */
      }
    }
    this.prev = new Map();
    this.curr = new Map();
    this.committed = null;
    this.entities = new Map();
    this.order = [];
    this.staged.clear();
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
    if (this.needsPreroll) {
      // §3.2 settle pre-roll: exactly SETTLE_PREROLL_STEPS steps with
      // neutral frames, no input sampling, no wall time; the anchor is
      // installed at this frame's simTime afterwards.
      this.needsPreroll = false;
      this.prerollDone = true;
      this.settleSteps = SETTLE_PREROLL_STEPS;
      for (let i = 0; i < SETTLE_PREROLL_STEPS; i += 1) {
        if (!this.stepOnceM2(neutralFrame(this.stepIndex))) return; // failed
      }
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
      this.onFrame?.();
      return;
    }
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
    for (let i = 0; i < n; i += 1) {
      if (this.isM2) {
        if (!this.stepOnceM2()) return; // fail-stop: no further frame/onFrame
      } else {
        this.stepOnce();
      }
    }
    if (rawN > MAX_CATCHUP_STEPS) {
      // Bounded catch-up (normative, §5.4): drop the remainder and
      // resync the anchor — no unbounded burst after a stall. The
      // resync makes targetSim == simTime for the display, so
      // alpha = 0 (§6).
      this.droppedSteps += rawN - MAX_CATCHUP_STEPS;
      if (this.isM2) this.droppedInputSteps += rawN - MAX_CATCHUP_STEPS;
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
    } else {
      this.lastAlpha = clamp01((targetSim - this.simTime) / this.dt);
    }
    this.onFrame?.();
  }

  /** One fixed M1 step (§5.3 + §5.1 module isolation). */
  private stepOnce(): void {
    // Phase 12 (c): scene loads/unloads requested by the host apply here too.
    if (!this.applySceneOps()) return;
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
    for (const entry of this.entries) {
      // Registration order (§5.3: each module in registration order).
      try {
        (entry.instance as SimulationModule).step(view, stepOrdinal);
      } catch (e) {
        failed = true;
        this.recordError({ code: 'module_error', message: `module step threw: ${messageOf(e)}`, stepIndex: stepOrdinal });
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
    this.stepAnimators();
  }

  /**
   * One fixed M2 step (§12.1.1). Returns `false` after a fail-stop, so the
   * caller stops the frame loop immediately.
   *
   * M3 (gameplay.md §3.2): the per-executed-step order gains item 0 (the
   * boundary — consumed run commands, the reset transaction when due, the
   * `prev := curr` promotion and the R8 boundary view) before the action
   * sample, the §2.5 effective-frame override on the sampled frame, and the
   * item-8 committed `GameView` publication. For M1/M2 sets every line of the
   * accepted step function runs unchanged.
   */
  private stepOnceM2(actionOverride?: ActionFrame): boolean {
    const stepIndex = this.stepIndex;
    const ordinal = stepIndex + 1; // the 1-based executed-step index (fixtures)
    // M3 boundary (gameplay.md §3.2 item 0): before the action sample. No
    // boundary during the accepted 12-step settle pre-roll (the fixtures pin
    // the first boundary at the step after the settle steps).
    // Phase 12 (c): scene unloads/loads take effect at the boundary, before
    // the run bookkeeping (a respawn may land in a scene that just loaded).
    if (!this.applySceneOps()) return false;
    if (this.isM3 && this.executedSteps >= SETTLE_PREROLL_STEPS) {
      if (!this.runResetBarrier(ordinal)) return false;
      if (!this.runTransfer(ordinal)) return false;
    }
    this.stepSceneOps = [];
    this.respawnRequested = false;
    let action: ActionFrame;
    if (actionOverride !== undefined) {
      action = actionOverride;
    } else {
      try {
        action = this.sampleAction(stepIndex);
      } catch (e) {
        if (e instanceof InputFrameError) {
          this.failStop('module_error', 'input_frame_invalid', messageOf(e), stepIndex);
        } else {
          this.failStop('module_error', 'input_source_threw', messageOf(e), stepIndex);
        }
        return false;
      }
    }
    // M3 effective-frame override (gameplay.md §2.5): the sampled frame stays
    // the recorded input; the controller receives the effective frame.
    if (this.isM3) action = this.effectiveFrame(action, ordinal);
    const backup = cloneCurr(this.curr);
    this.staged.clear();
    this.currentPhase = undefined;
    this.currentModuleId = undefined;
    // §14.5: the intent set is cleared at the start of every fixed step.
    this.intents = emptyMutableIntents(stepIndex);
    try {
      this.runPhase('intent', action);
      this.runPhase('controller', action);
      this.runPhysicsPhase();
      this.runPhase('transform', action);
      if (this.isM3) {
        // M3 phases 6/7: the gameplay phase (the session module's zone
        // decisions through `ctx.gameplay`) and the camera phase, in the
        // accepted phase order (SIMULATION_PHASE_ORDER).
        this.runPhase('gameplay', action);
        // Phase 12 (c): a script's `respawn` intent, unless the zones already decided.
        if (this.respawnRequested && this.session !== null && this.session.runState === 'playing') {
          this.session.beginRespawn(ordinal, 'fall');
        }
        this.runPhase('camera', action);
      }
    } catch (e) {
      this.failStopFromError(e, stepIndex);
      return false;
    }
    // The accepted step-end promotion (runtime.md §12.1.1) runs unchanged
    // for M3 sets too (gameplay.md §3.5 invariance; segment-source.json pins
    // `state.prev` during step n at the end of step n−2): `prev := backup`
    // below, where `backup` is the pre-step `curr` — the post-reset `curr`
    // when a reset wrote at this step's boundary (the no-streak mechanism).
    this.prev = backup;
    this.stepIndex += 1;
    this.simTime = this.stepIndex / this.hz;
    this.committed = cloneCurr(this.curr);
    // M3 commit (gameplay.md §3.2 item 8): the last completed motion
    // segments, then the frozen committed `GameView` (stepIndex := n+1,
    // simTime = stepIndex / fixedStepHz, single division).
    if (this.isM3) {
      this.recordMotionSegments(backup);
      this.lastGameView = this.buildGameView(this.stepIndex, this.simTime);
    }
    this.stepAnimators();
    // Phase 12 (c): the step's scene requests commit with it; exit zones are
    // checked on the committed motion.
    if (this.stepSceneOps.length > 0) {
      for (const op of this.stepSceneOps) this.enqueueSceneOp(op);
      this.stepSceneOps = [];
    }
    this.checkExitZones();
    this.executedSteps += 1;
    return true;
  }

  private sampleAction(stepIndex: number): ActionFrame {
    let raw: unknown;
    try {
      raw = this.actions.sample(stepIndex);
    } catch (e) {
      throw new InputSourceError(messageOf(e));
    }
    const check = validateActionFrame(raw, stepIndex);
    if (!check.ok) throw new InputFrameError(check.field, check.message);
    this.inputSamples += 1;
    return check.frame;
  }

  // -------------------------------------------------------------------------
  // M3 game-session wiring (gameplay.md §2/§3.2/§3.3/§6/§7.1; runtime.md §15).
  // Absent from M1/M2 sets (session null; the run surface rejects with
  // `game_session_unavailable`, reason `schedule`).
  // -------------------------------------------------------------------------

  /**
   * The M3 step boundary (gameplay.md §3.2 item 0): consume the queued run
   * commands in consumption order, apply the T1/T5/T6 run-state and counter
   * bookkeeping (session.boundary) and the boundary events, run the reset
   * transaction the outcome makes due, and publish the boundary view (R8).
   * Returns `false` after a fail-stop.
   *
   * The run-state bookkeeping (the T1/T5/T6 updates and the boundary event)
   * is owned by `session.boundary` and runs BEFORE the reset transaction —
   * the `failure-phases.json` fixture pins that a reset-phase failure is
   * recorded on top of the already-applied bookkeeping (the runStarted event
   * is present, `state` is `playing`, and `failed` is `true`). The R1–R7
   * transaction (gameplay.md §5.1) — destination resolve/verify, the
   * clearance probe, the physics reset, the module reset hooks and the
   * rebase — is `runResetTransaction` over the `PhysicsResetPort`.
   */
  private runResetBarrier(ordinal: number): boolean {
    const session = this.session;
    if (session === null) return true;
    const outcome = session.boundary(ordinal);
    // Phase 12 (c): a replay starts from the start scenes again.
    if (outcome.reset === 'replay' && !this.restoreStartSet()) return false;
    if (outcome.reset !== null) {
      // The due reset: the R1–R7 transaction. A reset-phase failure fail-stops
      // (no rollback, gameplay.md §5.4) and publishes the retained view via
      // `failReset`; the R8 boundary publication below runs only on success.
      if (!this.runResetTransaction(outcome.reset, ordinal)) return false;
      // R8: the run bookkeeping is `session.boundary` (above); the publish is
      // the boundary view. A fault armed at `R8` fail-stops before the publish.
      if (this.checkResetFault('R8', ordinal)) return false;
    }
    // R8: the committed view at the boundary (stepIndex = the upcoming step
    // ordinal; simTime = ordinal / fixedStepHz — the boundary time).
    this.lastGameView = this.buildGameView(ordinal, ordinal * this.dt);
    return true;
  }

  /**
   * The packet-49 reset seam (gameplay.md §5.1): the consumed due-reset
   * request. Packet 50 replaces the body with the R1–R7 transaction (the
   * destination resolve/verify, the `characterClearance` probe, the physics
   * reset through `PhysicsResetPort`, the `module.reset()` hooks and the
   * rebase) — the run-state bookkeeping and the view publication stay here.
   */
  /**
   * Test-only reset fault-injection seam (gameplay.md §5.1/§5.4): set a reset
   * phase label (`R1`–`R8`) to make the next due reset fail-stop at that phase
   * with its exact failure signature, or `null` to clear. Not part of the
   * public `Runtime` surface; reached by the `tests/m3-respawn/**` evidence
   * through a typed cast.
   */
  injectResetFault(phase: string | null): void {
    this.resetFaultPhase = phase;
  }

  /**
   * The M3 reset transaction (gameplay.md §5.1 R1–R7): the one runtime-owned
   * discontinuity. Executed at the step boundary for a due reset (T1 `start`,
   * T5 `spawn`, T6 `replay`). Steps R1–R3 are pure reads; the first mutation
   * is R4. A reset-phase failure fail-stops with the phase's signature (no
   * rollback, §5.4); a failure is never a death. `ordinal` is the 1-based
   * upcoming-step index (the failure's `stepIndex`).
   */
  private runResetTransaction(reset: 'spawn' | 'replay' | 'start' | 'transfer', ordinal: number, transferSpawnId?: string): boolean {
    const session = this.session!;
    const content = this.gameContent!;
    const player = this.playerEntityId;

    // R1: resolve the destination (pure read).
    if (this.checkResetFault('R1', ordinal)) return false;
    let spawnEntityId: string;
    if (reset === 'transfer') {
      spawnEntityId = transferSpawnId as string;
    } else if (reset === 'spawn') {
      const cpId = session.checkpointTotal;
      if (cpId !== null) {
        const cpZone = content.zones.find((z) => z.entityId === cpId);
        if (cpZone === undefined || cpZone.safeSpawnId === undefined) {
          this.failReset('game_spawn_invalid', 'reference', ordinal, 'R1');
          return false;
        }
        spawnEntityId = cpZone.safeSpawnId;
      } else {
        spawnEntityId = content.game.spawnId;
      }
    } else {
      spawnEntityId = content.game.spawnId;
    }
    const spawn = content.spawns.find((s) => s.entityId === spawnEntityId);
    if (spawn === undefined) {
      this.failReset('game_spawn_invalid', 'reference', ordinal, 'R1');
      return false;
    }
    const target: Vec2 = { x: spawn.center.x, y: spawn.center.y };

    // R2: verify the destination (pure reads, no mutation).
    if (this.checkResetFault('R2', ordinal)) return false;
    // v3 snapshots carry level bounds and a kill height; v4 has neither (a
    // game's own rules live in scripts), so only the checks below apply.
    const level = content.game.level;
    const killY = content.game.killY;
    const insideLevel =
      level === undefined ||
      (target.x >= level.minX && target.x <= level.maxX && target.y >= level.minY && target.y <= level.maxY);
    if (!insideLevel || (killY !== undefined && target.y < killY)) {
      this.failReset('game_spawn_invalid', 'outside_level', ordinal, 'R2');
      return false;
    }
    // The capsule at `target` must not overlap a hazard zone (§4.2 zero-motion
    // segment: from === to === target).
    for (const zone of content.zones) {
      if (zone.role !== 'hazard') continue;
      if (this.capsuleOverlapsZone(target, zone)) {
        this.failReset('game_spawn_blocked', 'hazard', ordinal, 'R2');
        return false;
      }
    }

    // R3: clearance probe (port, query-only, no mutation).
    if (this.checkResetFault('R3', ordinal)) return false;
    const resetPort = this.resetPort();
    if (resetPort === null) {
      this.failReset('physics_port_error', 'reset', ordinal, 'R3');
      return false;
    }
    let probe: CharacterClearanceResult;
    try {
      probe = resetPort.characterClearance(target);
    } catch {
      this.failReset('physics_port_error', 'reset', ordinal, 'R3');
      return false;
    }
    if (!probe.ok) {
      this.failReset('game_spawn_blocked', probe.reason ?? 'query_failed', ordinal, 'R3');
      return false;
    }

    // R4: physics reset (port mutation). clearCharacterMotion then
    // placeCharacter (both the §5.2 restricted operations). A throw ⇒
    // physics_port_error (fail-stop; the world may be half-mutated — no
    // rollback, §5.4).
    if (this.checkResetFault('R4', ordinal)) return false;
    try {
      resetPort.clearCharacterMotion();
      resetPort.placeCharacter(target);
    } catch {
      this.failReset('physics_port_error', 'reset', ordinal, 'R4');
      return false;
    }

    // R5: stage the character pose (curr[player] = target, XY only; Z/rot/scale
    // untouched).
    if (this.checkResetFault('R5', ordinal)) return false;
    const playerTransform = this.curr.get(player);
    if (playerTransform === undefined) {
      this.failReset('module_error', 'phase_violation', ordinal, 'R5');
      return false;
    }
    playerTransform.position[0] = target.x;
    playerTransform.position[1] = target.y;

    // R6: module state reset (each selected module that declares `reset`, in
    // registration order; the controller clears its windows, the camera writes
    // the snapped pose). A throw ⇒ module_error (fail-stop).
    if (this.checkResetFault('R6', ordinal)) return false;
    for (const entry of this.entries) {
      if (!entry.phased) continue;
      const instance = entry.instance as SimulationPhaseModule;
      if (typeof instance.reset !== 'function') continue;
      const ctx = this.buildResetContext(reset, ordinal, target, new Set(entry.owners));
      try {
        instance.reset(ctx);
      } catch {
        this.failReset('module_error', 'module_threw', ordinal, 'R6');
        return false;
      }
    }

    // R7: apply + rebase. The staged pose is already in `curr` (R5) and the
    // camera hook wrote the camera pose (R6); the standard `prev := curr`
    // promotion makes `prev == curr` for the reset entities (the no-render-
    // streak guarantee — the step-end promotion captures the same post-reset
    // `curr` as the next step's backup). The last completed motion segment is
    // rebased to a zero-motion segment at the reset pose: the stale pre-reset
    // segment (e.g. the capsule falling in the pit) must not sweep below
    // killY in the respawn step's §4.2 death check.
    if (this.checkResetFault('R7', ordinal)) return false;
    this.prev = cloneCurr(this.curr);
    this.lastSegments.set(
      player,
      Object.freeze({
        from: Object.freeze({ x: target.x, y: target.y }),
        to: Object.freeze({ x: target.x, y: target.y }),
      }),
    );
    this.playerMotion = Object.freeze({
      speed: 0,
      grounded: true,
    });
    // Phase 9.7: a replay or a new run starts the animators over.
    if (reset === 'replay' || reset === 'start') this.resetAnimators();

    return true;
  }

  /**
   * The test-only reset fault check (gameplay.md §5.4): if a reset phase is
   * armed via `injectResetFault`, fail-stop at that phase with its exact
   * signature before running the phase's natural logic. Returns `true` after
   * a fail-stop (the caller must return `false`).
   */
  private checkResetFault(phase: string, ordinal: number): boolean {
    if (this.resetFaultPhase !== phase) return false;
    const sig = RESET_FAULT_SIGNATURES[phase];
    if (sig === undefined) return false;
    this.resetFaultPhase = null; // one-shot
    this.failReset(sig.code, sig.reason, ordinal, phase);
    return true;
  }

  /** Narrow the injected physics port to the M3 reset/clearance surface. */
  private resetPort(): PhysicsResetPort | null {
    const port = this.physics as (PhysicsPort & Partial<PhysicsResetPort>) | undefined;
    if (port === undefined) return null;
    if (typeof port.clearCharacterMotion !== 'function') return null;
    if (typeof port.placeCharacter !== 'function') return null;
    if (typeof port.characterClearance !== 'function') return null;
    return port as PhysicsResetPort;
  }

  /**
   * The R2 hazard predicate (gameplay.md §4.2 closed form over a zero-motion
   * segment, from === to === `target`): the swept centre-line rectangle
   * [target.x] × [target.y ± CAPSULE_HALF_HEIGHT] against the zone's
   * half-extent rectangle. `d < R − EPS` is an overlap.
   */
  private capsuleOverlapsZone(target: Vec2, zone: { center: Vec2; half: Vec2 }): boolean {
    const rx = target.x;
    const ry0 = target.y - GAME_CAPSULE_HALF_HEIGHT;
    const ry1 = target.y + GAME_CAPSULE_HALF_HEIGHT;
    const zx0 = zone.center.x - zone.half.x;
    const zx1 = zone.center.x + zone.half.x;
    const zy0 = zone.center.y - zone.half.y;
    const zy1 = zone.center.y + zone.half.y;
    const dx = Math.max(0, rx - zx1, zx0 - rx);
    const dy = Math.max(0, ry0 - zy1, zy0 - ry1);
    const limit = GAME_CAPSULE_RADIUS - GAME_ZONE_OVERLAP_EPS;
    return dx * dx + dy * dy < limit * limit;
  }

  /** Build one R6 `ModuleResetContext` (gameplay.md §5.1 / §3.3). */
  private buildResetContext(
    reset: 'spawn' | 'replay' | 'start' | 'transfer',
    ordinal: number,
    target: Vec2,
    writableOwners: ReadonlySet<string>,
  ): ModuleResetContext {
    return Object.freeze({
      reason: reset,
      stepIndex: ordinal,
      playerCenter: Object.freeze({ ...target }),
      viewport: { ...this.viewport },
      state: phaseScopedState({
        order: this.order,
        entities: this.entities,
        stepIndex: this.stepIndex,
        simTime: this.simTime,
        prev: this.prev,
        curr: this.curr,
        writableOwners,
      }),
    });
  }

  /**
   * The M3 reset fail-stop (gameplay.md §5.4): a reset-phase failure abandons
   * the step, cancels the driver, retains the last committed state for
   * rendering, marks the run failed with the reset phase label and publishes
   * the retained view. A failure is never a death (no `died` event,
   * `deathCount` unchanged). `ordinal` is the 1-based upcoming-step index
   * (the failure's `stepIndex`); `phaseLabel` is `R1`–`R8` (the view's
   * `failure.phase` is `reset:<label>`, as the fixture pins).
   */
  private failReset(code: ErrorCode, reason: string, ordinal: number, phaseLabel: string, detail?: string): void {
    const stepIndex = ordinal - 1; // 0-based
    this.cancelDriver();
    this.needsPreroll = false;
    this.stateName = 'failed';
    this.lastAlpha = 0;
    this.failedStepIndex = stepIndex;
    const entry: DiagnosticErrorEntry = {
      code,
      message: clipMessage(`reset ${phaseLabel} failed (${reason})`),
      stepIndex,
      reason,
      ...(detail !== undefined ? { detail } : {}),
    };
    this.recordError(entry);
    if (this.session !== null) {
      this.session.markFailure(code, reason, ordinal, `reset:${phaseLabel}`);
      this.lastGameView = this.buildGameView(ordinal, ordinal * this.dt);
    }
  }

  /**
   * The M3 effective-frame override (gameplay.md §2.5): movement is gated
   * (moveX 0) and the jump forced to `none` while the run state is not
   * `playing`; on the first `playing` step after a run-start/respawn/replay
   * boundary (`firstLive`) the jump is additionally forced to `none` (the
   * anti-phantom-jump gate). The sampled frame stays the recorded input.
   */
  private effectiveFrame(frame: ActionFrame, ordinal: number): ActionFrame {
    const session = this.session;
    if (session === null) return frame;
    if (session.runState !== 'playing') {
      return { ...frame, moveX: 0, jump: 'none' };
    }
    if (session.isFirstLiveStep(ordinal)) {
      return { ...frame, jump: 'none' };
    }
    return frame;
  }

  /** Build one committed `GameView` (gameplay.md §6) from the current run state. */
  private buildGameView(stepIndex: number, simTime: number): GameView {
    const session = this.session;
    const content = this.gameContent;
    if (session === null || content === null) {
      // Unreachable on an M3 set; the null branch keeps the types honest.
      throw new Error('buildGameView requires an M3 runtime');
    }
    const checkpoint = session.checkpointTotal === null ? undefined : content.zones.find((z) => z.entityId === session.checkpointTotal);
    return session.buildView({
      snapshotId: this.snapshotId,
      stepIndex,
      simTime,
      playerId: content.player.entityId,
      cameraId: content.camera.entityId,
      spawnId: content.game.spawnId,
      checkpointSafeSpawnId: checkpoint?.safeSpawnId ?? null,
      playerMotion: this.playerMotion,
    });
  }

  /**
   * Record the last completed motion segments (gameplay.md §3.3):
   * `from` = the entity's committed centre before the step, `to` = after.
   * Also refreshes the committed `playerMotion` (speed = |player segment|
   * × fixedStepHz; grounded = the controller's committed grounding, C41-1).
   */
  private recordMotionSegments(backup: Map<string, TransformState>): void {
    for (const id of this.order) {
      const before = backup.get(id);
      const after = this.curr.get(id);
      if (before === undefined || after === undefined) continue;
      this.lastSegments.set(id, Object.freeze({
        from: Object.freeze({ x: before.position[0], y: before.position[1] }),
        to: Object.freeze({ x: after.position[0], y: after.position[1] }),
      }));
    }
    const seg = this.lastSegments.get(this.playerEntityId);
    if (seg !== undefined) {
      this.playerMotion = Object.freeze({
        speed: Math.hypot(seg.to.x - seg.from.x, seg.to.y - seg.from.y) * this.hz,
        grounded: this.lastCharacterResult?.grounded ?? this.playerMotion.grounded,
      });
    }
  }

  /**
   * The frozen `StepContext.gameplay` port (gameplay.md §3.3 / runtime.md
   * §15.3): the committed run data and the frozen content are read-only in
   * every phase; the three commit calls are callable in the `gameplay` phase
   * only and enforce the run-state rules (a violation is `gameplay_invalid`).
   */
  // ---- Phase 12 (c) scene set internals ------------------------------------

  private setSceneStatus(sceneId: string, status: SceneStatus): void {
    this.sceneStatus.set(sceneId, status);
    this.sceneSetCache = null;
  }

  /** Why a scene op cannot be requested (null: it can). */
  private sceneOpProblem(op: 'load' | 'unload', sceneId: unknown, options?: SceneLoadOptions): string | null {
    if (this.sceneRows === null) return 'this game has no scene catalog (a v4 project runs with one)';
    if (typeof sceneId !== 'string' || !this.sceneStatus.has(sceneId)) return `unknown scene ${JSON.stringify(String(sceneId))}`;
    if (op === 'load' && options !== undefined) {
      if (typeof options !== 'object' || options === null) return 'load options must be an object';
      const at = (options as { at?: unknown }).at;
      if (at !== undefined && !(Array.isArray(at) && at.length === 3 && at.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6))) {
        return 'load option "at" must be [x, y, z] (finite, |v| <= 1e6)';
      }
    }
    if (op === 'unload') {
      const batch = this.batches.get(sceneId);
      if (batch !== undefined) {
        for (const id of batch.ids) {
          if (this.pinnedIds.has(id)) return `scene "${sceneId}" holds "${id}" (the camera, player, start spawn and lights stay loaded)`;
        }
      }
    }
    return null;
  }

  /** Queue a validated op: loads go to the host, unloads wait for the next boundary. */
  private enqueueSceneOp(op: SceneOp): void {
    const status = this.sceneStatus.get(op.sceneId);
    if (op.op === 'load') {
      if (status === 'loaded') {
        this.pendingUnloads.delete(op.sceneId); // load after unload in one step: stays loaded
        return;
      }
      if (status === 'loading') return;
      this.requestedLoads.set(op.sceneId, op.at !== undefined ? { at: op.at } : {});
      this.setSceneStatus(op.sceneId, 'loading');
      return;
    }
    if (status === 'loaded') {
      this.pendingUnloads.add(op.sceneId);
      return;
    }
    if (status === 'loading') {
      this.requestedLoads.delete(op.sceneId);
      this.fetchingLoads.delete(op.sceneId);
      this.readyLoads.delete(op.sceneId);
      this.setSceneStatus(op.sceneId, 'unloaded');
    }
  }

  /** `ctx.scenes`: requests are collected with the step and committed with it. */
  private buildSceneControl(): BehaviorSceneControl {
    const rt = this;
    const refuse = (message: string): never => {
      throw new BehaviorHostError('module_error', 'behavior_scene_invalid', message);
    };
    return Object.freeze({
      load(sceneId: string, options?: SceneLoadOptions): void {
        const problem = rt.sceneOpProblem('load', sceneId, options);
        if (problem !== null) refuse(`ctx.scenes.load: ${problem}`);
        const at = options?.at;
        rt.stepSceneOps.push({ op: 'load', sceneId, ...(at !== undefined ? { at: Object.freeze([at[0], at[1], at[2]] as const) } : {}) });
      },
      unload(sceneId: string): void {
        const problem = rt.sceneOpProblem('unload', sceneId);
        if (problem !== null) refuse(`ctx.scenes.unload: ${problem}`);
        rt.stepSceneOps.push({ op: 'unload', sceneId });
      },
      status(sceneId: string): SceneStatus {
        const st = rt.sceneStatus.get(sceneId);
        if (st === undefined) refuse(`ctx.scenes.status: unknown scene ${JSON.stringify(String(sceneId))}`);
        return st as SceneStatus;
      },
      loaded(): readonly string[] {
        return Object.freeze([...rt.batches.keys()]);
      },
    });
  }

  /**
   * The step boundary for scenes: pending unloads, then fetched loads.
   * Returns `false` after a fail-stop (a module refused a loaded scene).
   */
  private applySceneOps(): boolean {
    if (this.sceneRows === null) return true;
    if (this.pendingUnloads.size > 0) {
      for (const sceneId of this.pendingUnloads) this.removeBatch(sceneId);
      this.pendingUnloads.clear();
    }
    for (const [sceneId, entities] of [...this.readyLoads]) {
      this.readyLoads.delete(sceneId);
      const at = this.fetchingLoads.get(sceneId)?.at;
      this.fetchingLoads.delete(sceneId);
      if (!this.addBatch(sceneId, offsetEntities(entities, at), false)) return false;
    }
    return true;
  }

  /**
   * Add one scene. A scene that does not fit (duplicate ids, a start-only
   * entity, colliders without a capable port) is refused: logged, left
   * unloaded, the run continues. Returns `false` only after a fail-stop.
   */
  private addBatch(sceneId: string, entities: readonly EntityV3[], start: boolean): boolean {
    const refuse = (why: string): boolean => {
      this.setSceneStatus(sceneId, 'unloaded');
      this.recordError({ code: 'scene_load_failed', message: clipMessage(`scene "${sceneId}" was not loaded: ${why}`), stepIndex: this.stepIndex, reason: 'refused' });
      return true;
    };
    for (const e of entities) {
      if (this.entities.has(e.id)) return refuse(`entity "${e.id}" is already loaded`);
      const c = e.components as unknown as Record<string, unknown>;
      if (!start && (c['camera'] !== undefined || c['controller'] !== undefined || c['light'] !== undefined)) {
        return refuse(`entity "${e.id}" belongs in a start scene (camera, player, lights)`);
      }
    }
    const frozen = deepFreeze(entities.map((e) => structuredClone(e)));
    const contribution = sceneContribution(frozen);
    if (contribution.colliders.length > 0 && this.physics !== undefined) {
      if (typeof this.physics.addStaticColliders !== 'function') return refuse('the physics port cannot add colliders');
      try {
        this.physics.addStaticColliders(contribution.colliders);
      } catch (e) {
        this.failStop('physics_port_error', 'scene_colliders', `adding the colliders of scene "${sceneId}" failed: ${messageOf(e)}`, this.stepIndex);
        return false;
      }
    }
    const ids = new Set<string>();
    for (const e of frozen) {
      const t = e.components.transform;
      const data: SimEntityData = { id: e.id, parentId: e.parentId ?? null, transform: cloneTransform(t) };
      if (e.name !== undefined) data.name = e.name;
      const box = e.components.box;
      if (box) data.box = { size: [box.size[0], box.size[1], box.size[2]], material: { color: box.material.color } };
      if ((e.components as { collider?: unknown }).collider !== undefined) data.hasCollider = true;
      this.entities.set(e.id, data);
      this.prev.set(e.id, cloneTransform(t));
      this.curr.set(e.id, cloneTransform(t));
      this.committed?.set(e.id, cloneTransform(t));
      ids.add(e.id);
    }
    this.order = [...this.order, ...frozen.map((e) => e.id)];
    this.entityCount = this.order.length;
    this.liveTags?.add(frozen as readonly { id: string; tags?: number }[]);
    this.batches.set(sceneId, { sceneId, start, entities: frozen, ids, contribution });
    this.addAnimators(frozen as unknown as readonly EntityV3[]);
    this.setSceneStatus(sceneId, 'loaded');
    this.sceneRevision += 1;
    this.rebuildGameContent();
    for (const entry of this.entries) {
      const instance = entry.instance as SimulationPhaseModule;
      if (!entry.phased || typeof instance.sceneLoaded !== 'function') continue;
      this.currentModuleId = entry.id;
      this.currentPhase = undefined;
      try {
        instance.sceneLoaded(frozen);
      } catch (e) {
        this.failStopFromError(e, this.stepIndex);
        return false;
      }
    }
    return true;
  }

  /** Remove one scene and release what belongs to it. */
  private removeBatch(sceneId: string): void {
    const batch = this.batches.get(sceneId);
    if (batch === undefined) return;
    const ids = batch.ids;
    for (const entry of this.entries) {
      const instance = entry.instance as SimulationPhaseModule;
      if (!entry.phased || typeof instance.sceneUnloaded !== 'function') continue;
      try {
        instance.sceneUnloaded(ids);
      } catch (e) {
        this.recordError({ code: 'scene_load_failed', message: clipMessage(`module "${entry.id}" failed to release scene "${sceneId}": ${messageOf(e)}`), stepIndex: this.stepIndex, reason: 'unload', moduleId: entry.id });
      }
    }
    if (batch.contribution.colliders.length > 0 && typeof this.physics?.removeStaticColliders === 'function') {
      try {
        this.physics.removeStaticColliders(batch.contribution.colliders.map((c) => c.entityId));
      } catch (e) {
        this.recordError({ code: 'scene_load_failed', message: clipMessage(`removing the colliders of scene "${sceneId}" failed: ${messageOf(e)}`), stepIndex: this.stepIndex, reason: 'unload' });
      }
    }
    for (const id of ids) {
      this.entities.delete(id);
      this.prev.delete(id);
      this.curr.delete(id);
      this.committed?.delete(id);
      this.lastSegments.delete(id);
      this.exitsInside.delete(id);
    }
    this.order = this.order.filter((id) => !ids.has(id));
    this.entityCount = this.order.length;
    this.liveTags?.remove(ids);
    // A checkpoint in the unloaded scene no longer counts (death respawns at
    // the start spawn); a pending exit transfer into it is dropped.
    if (this.session !== null && this.session.checkpointTotal !== null && ids.has(this.session.checkpointTotal)) {
      this.session.clearCheckpoint();
    }
    if (this.pendingTransfer !== null && ids.has(this.pendingTransfer.spawnId)) this.pendingTransfer = null;
    this.removeAnimators(ids);
    this.batches.delete(sceneId);
    this.setSceneStatus(sceneId, 'unloaded');
    this.sceneRevision += 1;
    this.rebuildGameContent();
  }

  /** A replay starts from the start scenes again: others unloaded, unloaded start scenes restored. */
  private restoreStartSet(): boolean {
    if (this.sceneRows === null) return true;
    for (const b of [...this.batches.values()]) if (!b.start) this.removeBatch(b.sceneId);
    for (const sceneId of [...this.requestedLoads.keys(), ...this.fetchingLoads.keys(), ...this.readyLoads.keys()]) {
      if (!this.startBatchSource.has(sceneId)) this.setSceneStatus(sceneId, 'unloaded');
    }
    this.requestedLoads.clear();
    this.fetchingLoads.clear();
    this.readyLoads.clear();
    this.pendingUnloads.clear();
    this.pendingTransfer = null;
    this.exitsInside.clear();
    for (const [sceneId, entities] of this.startBatchSource) {
      if (this.batches.has(sceneId)) continue;
      if (!this.addBatch(sceneId, entities, true)) return false;
    }
    return true;
  }

  /** The gameplay projection over every loaded scene (zones/spawns in entity-id order). */
  private rebuildGameContent(): void {
    const current = this.gameContent;
    if (current === null) return;
    const zones: GameZoneSpec[] = [];
    const spawns: { entityId: string; center: Vec2 }[] = [];
    for (const b of this.batches.values()) {
      zones.push(...b.contribution.zones);
      spawns.push(...b.contribution.spawns);
    }
    this.gameContent = deepFreeze({ ...current, zones: zones.sort(byEntityId), spawns: spawns.sort(byEntityId) });
  }

  /**
   * Exit zones (after the step commits, while playing): entering one requests
   * its unloads and loads; its spawn becomes the pending transfer.
   */
  private checkExitZones(): void {
    const content = this.gameContent;
    const session = this.session;
    if (content === null || session === null || this.sceneRows === null || session.runState !== 'playing') return;
    const segment = this.lastSegments.get(this.playerEntityId);
    if (segment === undefined) return;
    for (const zone of content.zones) {
      if (zone.role !== 'exit') continue;
      const inside = capsuleInZone(segment.to, zone, GAME_CAPSULE_RADIUS, GAME_CAPSULE_HALF_HEIGHT, GAME_ZONE_OVERLAP_EPS);
      if (!inside) {
        this.exitsInside.delete(zone.entityId);
        continue;
      }
      if (this.exitsInside.has(zone.entityId)) continue;
      this.exitsInside.add(zone.entityId);
      const ops: SceneOp[] = [
        ...(zone.unload ?? []).map((sceneId): SceneOp => ({ op: 'unload', sceneId })),
        ...(zone.load ?? []).map((sceneId): SceneOp => ({ op: 'load', sceneId })),
      ];
      for (const op of ops) {
        const problem = this.sceneOpProblem(op.op, op.sceneId);
        if (problem !== null) {
          this.recordError({ code: 'scene_invalid', message: clipMessage(`exit "${zone.entityId}": ${problem}`), stepIndex: this.stepIndex, reason: op.op });
          continue;
        }
        this.enqueueSceneOp(op);
      }
      if (zone.spawnId !== undefined) this.pendingTransfer = { spawnId: zone.spawnId, waitFor: zone.load ?? [] };
    }
  }

  /**
   * The pending exit transfer, at the boundary once its scenes are loaded:
   * the player moves to the spawn through the reset transaction. Returns
   * `false` after a fail-stop.
   */
  private runTransfer(ordinal: number): boolean {
    const transfer = this.pendingTransfer;
    const session = this.session;
    if (transfer === null || session === null || session.runState !== 'playing') return true;
    if (transfer.waitFor.some((id) => this.sceneStatus.get(id) === 'loading')) return true;
    this.pendingTransfer = null;
    if (!this.gameContent!.spawns.some((sp) => sp.entityId === transfer.spawnId)) {
      this.recordError({ code: 'scene_invalid', message: clipMessage(`exit spawn "${transfer.spawnId}" is not loaded; the player stays`), stepIndex: this.stepIndex, reason: 'transfer' });
      return true;
    }
    return this.runResetTransaction('transfer', ordinal, transfer.spawnId);
  }

  private buildGameSessionPort(): GameSessionPort {
    const session = this.session!;
    const rt = this;
    const requireGameplayPhase = (): void => {
      if (rt.currentPhase !== 'gameplay') throw new GameplayPhaseError();
    };
    return Object.freeze({
      // Phase 12 (c): the projection follows scene loads (a getter over the current one).
      get content(): GameContent {
        return rt.gameContent!;
      },
      run: (): Readonly<RunSnapshot> => session.runSnapshot(rt.stepIndex + 1),
      lastMotionSegment: (entityId: string): Readonly<MotionSegment> | undefined => rt.lastSegments.get(entityId),
      viewport: (): Readonly<ViewportInfo> => rt.viewport,
      beginRespawn: (cause: 'hazard' | 'fall', zoneId?: string): void => {
        requireGameplayPhase();
        const st = session.runState;
        if (st !== 'playing') {
          throw new GameplayInvalidError(`beginRespawn is valid only while "playing" (state: "${st}")`);
        }
        session.beginRespawn(rt.stepIndex + 1, cause, zoneId);
      },
      activateCheckpoint: (zoneEntityId: string): void => {
        requireGameplayPhase();
        const st = session.runState;
        if (st !== 'playing') {
          throw new GameplayInvalidError(`activateCheckpoint is valid only while "playing" (state: "${st}")`);
        }
        if (session.checkpointTotal !== null) {
          throw new GameplayInvalidError('the checkpoint has already been activated in this run (single activation, §4.5)');
        }
        const zone = rt.gameContent!.zones.find((z) => z.entityId === zoneEntityId);
        if (zone === undefined || zone.role !== 'checkpoint') {
          throw new GameplayInvalidError(`entity "${zoneEntityId}" is not a checkpoint zone`);
        }
        session.activateCheckpoint(rt.stepIndex + 1, zoneEntityId);
      },
      reachGoal: (zoneEntityId: string): void => {
        requireGameplayPhase();
        const st = session.runState;
        if (st !== 'playing') {
          throw new GameplayInvalidError(`reachGoal is valid only while "playing" (state: "${st}")`);
        }
        const zone = rt.gameContent!.zones.find((z) => z.entityId === zoneEntityId);
        if (zone === undefined || zone.role !== 'goal') {
          throw new GameplayInvalidError(`entity "${zoneEntityId}" is not a goal zone`);
        }
        session.reachGoal(rt.stepIndex + 1, zoneEntityId);
      },
    });
  }

  private runPhase(phase: SimulationPhase, action: ActionFrame): void {
    for (const entry of this.entries) {
      if (!entry.phases.includes(phase)) continue;
      this.currentPhase = phase;
      this.currentModuleId = entry.id;
      const state = phaseScopedState({
        order: this.order,
        entities: this.entities,
        stepIndex: this.stepIndex,
        simTime: this.simTime,
        prev: this.prev,
        curr: this.curr,
        // Accepted rule (transform) + the M3 extension (gameplay.md §12.2
        // table): the camera phase is writable for the camera-phase module's
        // declared owners (exactly the scene camera entity — verified at
        // instantiate). M2 sets never reach a `camera` phase, so the
        // accepted rule is unchanged for them.
        writableOwners: phase === 'transform' || phase === 'camera' ? new Set(entry.owners) : null,
      });
      if (entry.phased) {
        const ctx: StepContext = frozenContext({
          stepIndex: this.stepIndex,
          phase,
          action,
          settings: this.settings,
          physics: this.physicsClient,
          state,
          intents: this.intentView(),
          emit: (intent: BehaviorIntent): void => this.commitIntent(entry, phase, intent),
          // M3 (gameplay.md §3.3 / runtime.md §15.3): the frozen gameplay
          // port, present iff this runtime is M3-enabled.
          ...(this.sessionPort !== null ? { gameplay: this.sessionPort } : {}),
          ...(this.sceneRows !== null ? { scenes: this.sceneControl } : {}),
          animators: this.animatorControl,
          animatorEvents: this.animatorEvents,
        });
        (entry.instance as SimulationPhaseModule).step(phase, ctx);
      } else {
        // Accepted M1 module participating in an M2 set (implicit
        // transform phase): the M1 `(state, stepIndex)` call is preserved.
        (entry.instance as SimulationModule).step(state, this.stepIndex + 1);
      }
    }
  }

  /** A frozen read-only view of the intents committed so far this step. */
  private intentView(): IntentSet {
    const s = this.intents;
    const writes = s.transformWrites.map((w) =>
      Object.freeze({ moduleId: w.moduleId, entityId: w.entityId, position: Object.freeze({ ...w.position }) }),
    );
    return Object.freeze({
      stepIndex: s.stepIndex,
      move: s.move,
      jump: s.jump,
      moveWriter: s.moveWriter,
      jumpWriter: s.jumpWriter,
      transformWrites: Object.freeze(writes),
    });
  }

  /**
   * Commit one intent (runtime.md §14.4/§14.5, steps 1–7). The runtime owns the
   * cross-module duplicate-writer check and the per-step cap; the transform
   * write is applied here (position axes only) so one step has at most one
   * writer per `(entityId, axis)`. Every rejection is a fail-stop.
   */
  private commitIntent(entry: ModuleEntry, phase: SimulationPhase, raw: unknown): void {
    const shape = validateIntentShape(raw);
    if (!shape.ok) throw shape.error;
    const intent = shape.intent;
    const phaseError = validateIntentPhase(intent, phase);
    if (phaseError !== null) throw phaseError;
    const valueError = validateIntentValue(intent);
    if (valueError !== null) throw valueError;

    if (intent.kind === 'control_move') {
      if (this.intents.move !== null) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_writer', `control_move already committed by "${this.intents.moveWriter}" and "${entry.id}"`);
      }
      this.bumpIntentCount();
      this.intents.move = quantizeIntentMove(intent.value);
      this.intents.moveWriter = entry.id;
      return;
    }
    if (intent.kind === 'respawn') {
      this.bumpIntentCount();
      this.respawnRequested = true;
      return;
    }
    if (intent.kind === 'control_jump') {
      if (this.intents.jump !== null) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_writer', `control_jump already committed by "${this.intents.jumpWriter}" and "${entry.id}"`);
      }
      this.bumpIntentCount();
      this.intents.jump = intent.value;
      this.intents.jumpWriter = entry.id;
      return;
    }
    if (!entry.owners.includes(intent.entityId)) {
      throw new BehaviorIntentError('behavior_transform_forbidden', 'not_owner', `entity "${intent.entityId}" is not owned by module "${entry.id}"`);
    }
    const transform = this.curr.get(intent.entityId);
    if (transform === undefined) {
      throw new BehaviorIntentError('behavior_transform_forbidden', 'not_owner', `entity "${intent.entityId}" does not exist`);
    }
    const axes = Object.keys(intent.position).filter(
      (axis): axis is 'x' | 'y' | 'z' => axis === 'x' || axis === 'y' || axis === 'z',
    );
    for (const axis of axes) {
      if (this.intents.axes.has(`${intent.entityId}\u0000${axis}`)) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `module "${entry.id}" already committed a write to "${intent.entityId}".${axis} in this step`);
      }
    }
    this.bumpIntentCount();
    for (const axis of axes) {
      const value = intent.position[axis] as number;
      if (axis === 'x') transform.position[0] = value;
      else if (axis === 'y') transform.position[1] = value;
      else transform.position[2] = value;
      this.intents.axes.add(`${intent.entityId}\u0000${axis}`);
    }
    this.intents.transformWrites.push({
      moduleId: entry.id,
      entityId: intent.entityId,
      position: { ...intent.position },
    });
  }

  /** The per-step intent cap (runtime.md §14.8), then the cumulative count. */
  private bumpIntentCount(): void {
    if (this.intents.count + 1 > INTENT_LIMITS.perStep) {
      throw new BehaviorIntentError('behavior_intent_limit', 'per_step', `more than ${INTENT_LIMITS.perStep} intents were committed in one step`);
    }
    this.intents.count += 1;
    this.intentCommitCount += 1;
  }

  /**
   * Record one accepted behavior `ctx.log` entry in the runtime's bounded ring
   * (runtime.md §14.8.1). A log flood cannot grow a diagnostics frame beyond
   * the 32-entry ring; the per-instance ring and counters live in the host.
   */
  private recordBehaviorLog(moduleId: string, level: BehaviorLogLevel, message: string): void {
    this.recordError({
      code: 'behavior_log',
      reason: level,
      moduleId,
      message: clipMessage(message),
      stepIndex: this.stepIndex,
    });
  }

  private readonly physicsClient: PhysicsStepClient = {
    stageCharacterMove: (entityId: string, delta: Vec2): void => this.stageMove(entityId, delta),
    characterResult: (): CharacterMoveResult | undefined => this.lastCharacterResult,
  };

  private stageMove(entityId: string, delta: unknown): void {
    if (this.currentPhase !== 'controller') {
      throw new PhaseViolationError('stageCharacterMove is callable only in the controller phase');
    }
    if (typeof entityId !== 'string' || !this.curr.has(entityId)) {
      throw new Error(`unknown character entity ${JSON.stringify(String(entityId))}`);
    }
    if (this.staged.has(entityId)) {
      throw new DuplicateMoveError(`entity "${entityId}" already staged a move in this step`);
    }
    if (!isFiniteVec2(delta)) {
      throw new Error('a staged character move must be a finite { x, y }');
    }
    this.staged.set(entityId, { x: delta.x, y: delta.y });
    this.physics?.stageCharacterMove({ x: delta.x, y: delta.y });
  }

  /** Phase 4 (runtime, not a module): one validated `port.step()`. */
  private runPhysicsPhase(): void {
    const port = this.physics;
    if (!port) return;
    const controllerId = this.controllerEntityId;
    const controllerTransform = controllerId !== undefined ? this.curr.get(controllerId) : undefined;
    const previousPosition: Vec2 = controllerTransform
      ? { x: controllerTransform.position[0], y: controllerTransform.position[1] }
      : { x: 0, y: 0 };
    const requested: Vec2 = (controllerId !== undefined ? this.staged.get(controllerId) : undefined) ?? { x: 0, y: 0 };
    let raw: unknown;
    this.physicsSteps += 1;
    try {
      raw = port.step();
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port step() threw: ${messageOf(e)}`);
    }
    const check = validateCharacterMoveResult(raw, previousPosition, requested);
    if (!check.ok) {
      throw new PhysicsPortFailure('result', `physics port returned an invalid result: ${check.failure.detail}`);
    }
    this.lastCharacterResult = check.result;
    if (controllerId !== undefined) {
      const t = this.curr.get(controllerId);
      if (t) {
        // Authoritative commit: position.x/position.y only, before any
        // phase-transform module runs (§12.1.1 item 5).
        t.position[0] = check.result.position.x;
        t.position[1] = check.result.position.y;
      }
    }
    this.staged.clear();
  }

  private failStopFromError(e: unknown, stepIndex: number): void {
    const moduleId = this.currentModuleId;
    const phase = this.currentPhase;
    if (e instanceof PhaseViolationError) {
      this.failStop('module_error', 'phase_violation', messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    if (e instanceof DuplicateMoveError) {
      this.failStop('module_error', 'duplicate_move', messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    if (e instanceof PhysicsPortFailure) {
      this.failStop('physics_port_error', e.reason, messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    if (e instanceof InputFrameError) {
      this.failStop('module_error', 'input_frame_invalid', messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    // M3 gameplay port (gameplay.md §3.3/§8.1): a commit call outside the
    // gameplay phase is a `phase_violation`; a run-state rule violation is a
    // `gameplay_invalid`.
    if (e instanceof GameplayPhaseError) {
      this.failStop('module_error', 'phase_violation', messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    if (e instanceof GameplayInvalidError) {
      this.failStop('module_error', 'gameplay_invalid', messageOf(e), stepIndex, moduleId, phase);
      return;
    }
    // Behavior contract (runtime.md §14.4/§14.8): the validated-intent API's
    // own rejection reasons, the per-instance cap and the host's step/shape
    // failures. Each is a fail-stop with the contract's exact reason.
    if (e instanceof BehaviorIntentError) {
      this.failStop('module_error', e.reason, messageOf(e), stepIndex, moduleId, phase, e.detail);
      return;
    }
    if (e instanceof BehaviorHostIntentLimit) {
      this.failStop('module_error', e.reason, messageOf(e), stepIndex, moduleId, phase, e.detail);
      return;
    }
    if (e instanceof BehaviorHostError) {
      this.failStop(e.code, e.reason, messageOf(e), stepIndex, moduleId, phase, e.detail);
      return;
    }
    this.failStop('module_error', 'module_threw', `module step threw: ${messageOf(e)}`, stepIndex, moduleId, phase);
  }

  /**
   * §13 fail-stop: abandon the step (no transform rollback), cancel the
   * driver, retain the last committed state for rendering, report the
   * failed module/step and refuse to resume.
   */
  private failStop(
    code: ErrorCode,
    reason: string,
    message: string,
    stepIndex: number,
    moduleId?: string,
    phase?: SimulationPhase,
    detail?: string,
  ): void {
    this.cancelDriver();
    this.needsPreroll = false;
    this.stateName = 'failed';
    this.lastAlpha = 0;
    this.failedModuleId = moduleId;
    this.failedPhase = phase;
    this.failedStepIndex = stepIndex;
    const entry: DiagnosticErrorEntry = { code, message: clipMessage(message), stepIndex, reason };
    if (moduleId !== undefined) entry.moduleId = moduleId;
    if (phase !== undefined) entry.phase = phase;
    if (detail !== undefined) entry.detail = detail;
    this.recordError(entry);
    // M3 (gameplay.md §2.2 T7): a runtime fail-stop freezes the run at its
    // last committed value — no run event is appended and a failure is never
    // a death. The last committed view is retained with `failed: true` and
    // the `failure` record (gameplay.md §5.4/§10 last-committed-state claim;
    // stepIndex = the failed step's 1-based ordinal, as in the failure
    // fixtures).
    if (this.session !== null) {
      // The fixture's failure phase label: the physics phase is a runtime
      // (non-module) phase, so a physics failure is labelled `physics`
      // (failure-phases.json); every other failure carries the failed
      // module phase (CC-49-1).
      const phaseLabel = code === 'physics_port_error' ? 'physics' : phase;
      this.session.markFailure(code, reason, stepIndex + 1, phaseLabel);
      this.lastGameView = this.buildGameView(stepIndex + 1, (stepIndex + 1) * this.dt);
    }
  }

  private recordError(entry: DiagnosticErrorEntry): void {
    this.errorRing.push(entry);
    if (this.errorRing.length > MAX_ERROR_ENTRIES) this.errorRing.shift();
    this.errorCount += 1;
  }

  private actionDiagnostics(): { suspend: number; activate: number; disconnect: number; mappingUnsupported: number } {
    let d: { suspendCount?: number; activateCount?: number; disconnectCount?: number; mappingUnsupportedCount?: number } = {};
    if (typeof this.actions.diagnostics === 'function') {
      try {
        d = this.actions.diagnostics() ?? {};
      } catch {
        d = {};
      }
    }
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    return {
      suspend: num(d.suspendCount),
      activate: num(d.activateCount),
      disconnect: num(d.disconnectCount),
      mappingUnsupported: num(d.mappingUnsupportedCount),
    };
  }

  private physicsDiagnostics(): { stall: number; penetration: number } {
    let stall = 0;
    let penetration = 0;
    if (this.physics && typeof this.physics.diagnostics === 'function') {
      try {
        const d = this.physics.diagnostics() ?? {};
        if (typeof d.stallSteps === 'number' && Number.isFinite(d.stallSteps)) stall = d.stallSteps;
        if (typeof d.penetrationCorrectedCount === 'number' && Number.isFinite(d.penetrationCorrectedCount)) {
          penetration = d.penetrationCorrectedCount;
        }
      } catch {
        /* diagnostics must never break getDiagnostics() */
      }
    }
    return { stall, penetration };
  }

  /** Cumulative behavior log totals the host instances report (§14.8.1). */
  private behaviorLogDiagnostics(): { logCount: number; logDropped: number } {
    if (this.entries.length === 0) return this.behaviorLogTotals;
    let logCount = 0;
    let logDropped = 0;
    for (const entry of this.entries) {
      const probe = entry.instance as { behaviorDiagnostics?: () => { logCount?: number; logDropped?: number } };
      if (typeof probe.behaviorDiagnostics !== 'function') continue;
      try {
        const d = probe.behaviorDiagnostics();
        if (typeof d?.logCount === 'number' && Number.isFinite(d.logCount)) logCount += d.logCount;
        if (typeof d?.logDropped === 'number' && Number.isFinite(d.logDropped)) logDropped += d.logDropped;
      } catch {
        /* diagnostics must never break getDiagnostics() */
      }
    }
    this.behaviorLogTotals = { logCount, logDropped };
    return this.behaviorLogTotals;
  }

  private buildDiagnostics(): RuntimeDiagnostics {
    const base: RuntimeDiagnostics = {
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
    if (!this.isM2) return base;
    const actions = this.actionDiagnostics();
    const physics = this.physicsDiagnostics();
    const logs = this.behaviorLogDiagnostics();
    const m2: RuntimeDiagnostics = {
      ...base,
      failed: this.stateName === 'failed',
      inputSamples: this.inputSamples,
      droppedInputSteps: this.droppedInputSteps,
      settleSteps: this.settleSteps,
      physicsSteps: this.physicsSteps,
      inputSuspendCount: actions.suspend,
      inputActivateCount: actions.activate,
      inputDisconnectCount: actions.disconnect,
      inputMappingUnsupportedCount: actions.mappingUnsupported,
      physicsStallSteps: physics.stall,
      physicsPenetrationCorrectedCount: physics.penetration,
      intentCommitCount: this.intentCommitCount,
      logCount: logs.logCount,
      logDropped: logs.logDropped,
    };
    if (this.failedModuleId !== undefined) m2.failedModuleId = this.failedModuleId;
    if (this.failedPhase !== undefined) m2.failedPhase = this.failedPhase;
    if (this.failedStepIndex !== undefined) m2.failedStepIndex = this.failedStepIndex;
    if (this.session !== null) {
      // M3 diagnostics (gameplay.md §8 / runtime.md §15.7): the committed
      // run surface — the last published view stays observable here.
      m2.runState = this.session.runState;
      m2.runId = this.session.runId;
      m2.deathCount = this.session.deathCountTotal;
      m2.checkpointId = this.session.checkpointTotal;
      m2.gameEventCount = this.session.eventCountTotal;
      m2.pendingCommands = [...this.session.pendingCommandsTotal];
    }
    return m2;
  }
}
