/**
 * Runtime core: lifecycle, mutable simulation state, fixed steps with
 * bounded catch-up, interpolation and frame ordering, diagnostics, module
 * phases, ports, transform ownership and the fail-stop lifecycle.
 *
 * The runtime owns the single frame driver (rAF or manual). Every public
 * call returns a result object and never throws on protocol misuse. The
 * runtime core is three-free (project-model only) and
 * carries no hidden globals (every instance is an explicit object).
 *
 * Two module-set modes share the same constructor:
 *
 * - **M1 mode** (no selected spec declares phases): a module throw is a
 *   no-op step (the `curr`
 *   copy is restored) and `failed` is unreachable.
 * - **M2 mode** (at least one selected spec declares phases): the canonical
 *   phase order `intent → controller → physics → transform`, the write
 *   guard, transform-ownership validation, the settle pre-roll, per-step
 *   action sampling and fail-stop with no rollback.
 */
import { RuntimeGrid, type GridRenderChange } from './grid';
import { RuntimeMaterials, type MaterialRenderChange, type RuntimeMaterialCatalog } from './material-params';
import { MAX_FRAME_SAVE_EVENTS, RuntimeSaves, validateSaveEvents, type SaveEvent, type SaveRequest, type SaveSectionsPort, type WorldSave } from './project-saves';
import type { SaveSchema } from '@thirdlight/project-model';

/** One spawned copy as a save document's `spawned` section keeps it. */
interface SavedSpawnCopy {
  prefabId: string;
  ids: string[];
  position: number[];
  rotation: number[];
  scale: number[];
}
import { RuntimeInputStatus, type InputBindingRequest } from './input-status';
import type { BlockType, CellField } from '@thirdlight/project-model';
import {
  ENGINE_TIMING_DEFAULTS,
  controllerActionsOf,
  controllerMovementOf,
  controllerTuningOf,
  controllerCapsuleOffsetZ,
  resolveGameplaySettings,
  type EntityV3,
  type PrefabDefinition,
  type Quat,
  type RuntimeUiDocumentRow,
  MAX_TRANSITION_FADE, MAX_TRANSITION_UNLOADS, SAVE_LIMITS, SCRIPT_SAVE_LIMITS,
} from '@thirdlight/project-model';
import {
  actionPhase,
  NEUTRAL_ACTION_SOURCE,
  neutralFrame,
  validateActionFrame,
  InputFrameError,
  MAX_FRAME_COMMANDS,
  type ActionFrame,
  type ActionSource,
  type DebugCommandCall,
  type JumpPhase,
  type PointerSample,
} from './actions';

import { clipMessage, type ErrorCode, type RuntimeError } from './errors';
import { DebugCommands } from './debug-commands';
import { MAX_FRAME_UI_EVENTS, UiState, validateUiEvent, type UiEventRecord, type UiOutput, type UiStateView } from './ui';
import { ModeState, type ModeView } from './modes';
import { BehaviorHostError, BehaviorHostIntentLimit, BEHAVIOR_MODULE_PREFIX, compiledFramesOf, createTagQuery, graphNodeIdOf, type BehaviorDebugView, type BehaviorPropertyView, type CompiledFrame } from './behavior';
import { character3DPhysicsOf, offsetEntities, playerCapsuleOf, sceneContribution, staticColliderOf, staticColliderOf3D, type LiveTagIndex, type SceneContribution } from './scene-set';
import {
  BehaviorIntentError,
  INTENT_LIMITS,
  facingQuaternion,
  normalizedQuaternion,
  quantizeIntentMove,
  validateIntentPhase,
  validateIntentShape,
  validateIntentValue,
  type BehaviorIntent,
  type BehaviorLogLevel,
  type IntentSet,
  type IntentTransformWrite,
} from './intents';
import { DuplicateMoveError, PhaseViolationError, frozenContext, liveScopedState, phaseScopedState } from './guard';
import { lerpVec3, lerpVec3Into, quatEqual, slerpQuat, slerpQuatInto, vec3Equal } from './interp';
import { isSimulationRegistry, validatePhaseList } from './registry';
import { deepFreeze, validateRuntimeSnapshot } from './snapshot';
import { AnimatorMachine, type AnimatorControllerLike, type AnimatorPose } from './animator';
import { AudioMixer, type AudioCommand } from './audio-mixer';
import { DialogueRunner, validateDialogueInput, type DialogueInputRecord } from './dialogue';
import { CameraBrain, type CameraViewInfo } from './camera-brain';
import { EnvironmentDirector, type EnvironmentSaveState } from './environment-director';
import type { EnvironmentBlendView } from './environment-blend';
import type { ClimbQuery } from './types';
import { SocketSystem } from './sockets';
import { TimelineSystem, type TimelineView } from './timeline';
import type { TimelineAsset } from '@thirdlight/project-model';
import { screenToRay as poseScreenToRay, worldToScreen as poseWorldToScreen, type CameraPose } from './camera-rig';
import { GameplayBlocks, MAX_SIGNAL_NAME, type SceneTransitionRequest } from './blocks';
import { EntityAccess, type EntityFieldsSave, type LightOverride } from './entity-access';
import { MAX_LIVE_SPAWNED, MAX_SPAWNS_PER_STEP, SPAWN_ID_PREFIX, expandPrefab, parseSpawnOptions } from './spawn';
import { TransformMirror } from './step-buffers';
import {
  validateCharacterMoveResult,
  validateCharacterMoveResult3D,
  type CharacterClearanceResult,
  type CharacterMoveResult,
  type CharacterMoveResult3D,
  type CharacterState3D,
  type PhysicsPort,
  type PhysicsPort3D,
  type PhysicsVec3,
  type PhysicsHit,
  type PhysicsQueryFilter3D,
  type OverlapShape3D,
  type PhysicsQuat,
  type StaticColliderSpec3D,
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
  type BehaviorMessage,
  type BehaviorSceneControl,
  type BehaviorSpawnControl,
  type CameraInfo,
  type DiagnosticErrorEntry,
  type RuntimeSceneRow,
  type SceneLoadOptions,
  type SceneLoadRequest,
  type SceneLoadingView,
  type SceneTransitionView,
  type SceneSetView,
  type SceneStatus,
  type EffectRequest,
  type GameplaySettings,
  type InterpolatedState,
  type InterpolatedTransform,
  type InterpolatedVisitor,
  type ModuleConfig,
  type ModelBounds,
  type ModuleResetContext,
  type Runtime,
  type RuntimeDiagnostics,
  type RuntimeScene,
  type RuntimeSnapshot,
  type RuntimeStateName,
  type SimEntityData,
  type SimState,
  type SimulationModule,
  type SimulationModuleSpec,
  type SimulationPhase,
  type SimulationPhaseModule,
  type SimulationRegistry,
  type StepContext,
  type TransformState,
  type DebugCommandOptions,
  type DebugCommandState,
  type BehaviorUi,
} from './types';

/** The pointer state the runtime keeps — a pointer sample plus this step's enter/leave edges. */
export interface HeldPointer extends PointerSample {
  readonly entered?: boolean;
  readonly left?: boolean;
}


/**
 * At most this many 3D physics queries (rays, overlaps, picks) a
 * step, for every script together — twice the 2D plane's 32, because a 3D
 * scene's scripts pick, test line of sight and probe volumes around several
 * objects each step; beyond it a query finds nothing (warned once).
 */
export const QUERY_LIMIT_3D = 64;

/** A query's [x, y, z] (a script error when it is not three finite numbers). */
function queryVec3(v: unknown, what: string): [number, number, number] {
  if (!Array.isArray(v) || v.length < 3 || !v.slice(0, 3).every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${what} is [x, y, z] (finite numbers)`);
  return [v[0] as number, v[1] as number, v[2] as number];
}

/** A query's optional rotation quaternion [x, y, z, w] (normalized; absent: none). */
function queryQuat(v: unknown, what: string): PhysicsQuat | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length !== 4 || !v.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${what} is a quaternion [x, y, z, w]`);
  const len = Math.hypot(v[0] as number, v[1] as number, v[2] as number, v[3] as number);
  if (!(len > 1e-9)) throw new Error(`${what} is a quaternion [x, y, z, w] of non-zero length`);
  return { x: (v[0] as number) / len, y: (v[1] as number) / len, z: (v[2] as number) / len, w: (v[3] as number) / len };
}

function queryPositive(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${what} is a positive number (m)`);
  return v;
}

/**
 * The entity a physics collider belongs to — a block layer's
 * chunk collider (`<layer>#blocks:<chunk>:<piece>`) is its layer.
 */
function colliderEntityOf(colliderId: string): string {
  const i = colliderId.indexOf('#blocks:');
  return i > 0 ? colliderId.slice(0, i) : colliderId;
}

/** A query's reach (absent: `fallback`; at most 10 km). */
function queryDistance(v: unknown, fallback: number, what: string): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) throw new Error(`${what} maxDistance is a positive number (m)`);
  return Math.min(v, 10_000);
}

/** The default step rate. */
const DEFAULT_FIXED_STEP_HZ = 120;
/** A script message name (the timer-name syntax). */
const MESSAGE_NAME_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const MIN_FIXED_STEP_HZ = 1;
const MAX_FIXED_STEP_HZ = 1000;
/** Steps a frame may catch up before the rest is dropped. */
export const MAX_CATCHUP_STEPS = 8;
/**
 * The M2 settle pre-roll at 120 Hz — the engine's settle time
 * (0.1 s, `ENGINE_TIMING_DEFAULTS.settleTime`) converted at the step rate.
 */
export const SETTLE_PREROLL_STEPS = 12;
/** Steps a one-way platform lets the character drop through at 120 Hz (`ENGINE_TIMING_DEFAULTS.dropThroughTime`, 0.125 s). */
export const DROP_THROUGH_STEPS = 15;

/**
 * The engine timing in whole steps at `hz` (120 Hz gives
 * `SETTLE_PREROLL_STEPS` and `DROP_THROUGH_STEPS`).
 */
export function engineTimingSteps(hz: number): { settleSteps: number; dropThroughSteps: number } {
  return {
    settleSteps: Math.max(0, Math.round(ENGINE_TIMING_DEFAULTS.settleTime * hz)),
    dropThroughSteps: Math.max(1, Math.round(ENGINE_TIMING_DEFAULTS.dropThroughTime * hz)),
  };
}
/** The error ring keeps the last 32 entries. */
const MAX_ERROR_ENTRIES = 32;
/** Dialogue inputs per input frame (DIALOGUE_LIMITS.frameInputs). */
const DIALOGUE_FRAME_INPUTS = 8;
/**
 * Floating-point guard for the floor-based step count. When the
 * wall-derived `elapsed` is a mathematical multiple of `dt`,
 * `(targetSim − simTime) / dt` can round to e.g. 11.999999999999998;
 * double-precision rounding at realistic elapsed values is ~1e-13 in step
 * units, so a 1e-9 guard corrects exact-multiple cases without ever
 * running a step early (at most ~1e-9 of a step ≈ 8e-12 s). Determinism
 * is preserved: the same floating-point inputs yield the same count
 *  — the guard is a fixed part of the computation.
 */
const STEP_COUNT_EPS = 1e-9;

/** The default module selection. */
const DEFAULT_MODULES = ['thirdlight.demo:box-motion'];
/** The `config_invalid` reason for a physics-bearing set. */
const PHYSICS_PORT_REASON = 'physics_port';

interface BehaviorLogSink {
  handler: ((moduleId: string, level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }) => void) | null;
}

/** The runtime-owned mutable per-step intent set. */
interface MutableIntentSet {
  stepIndex: number;
  move: number | null;
  jump: JumpPhase | null;
  moveWriter: string | null;
  jumpWriter: string | null;
  transformWrites: IntentTransformWrite[];
  /**
   * Committed channels per entity in this step: `axesTag * 64 +
   * mask` with position x/y/z = 1/2/4, rotation 8, scale 16; a value with an
   * older tag counts as none, so nothing is cleared per step.
   */
  axes: Map<string, number>;
  axesTag: number;
  /** Accepted intents committed in this step. */
  count: number;
  /** The committed control_move's second axis, and the character intents with their writers (null: none this step). */
  moveY: number | null;
  characterMove: { x: number; z: number; run: boolean } | null;
  characterPlace: { x: number; y: number; z: number } | null;
  characterEnabled: boolean | null;
  characterWriters: Map<string, string>;
}

function emptyMutableIntents(stepIndex: number): MutableIntentSet {
  return {
    stepIndex,
    move: null,
    jump: null,
    moveWriter: null,
    jumpWriter: null,
    transformWrites: [],
    axes: new Map(),
    axesTag: 1,
    count: 0,
    moveY: null,
    characterMove: null,
    characterPlace: null,
    characterEnabled: null,
    characterWriters: new Map(),
  };
}

function resetMutableIntents(s: MutableIntentSet, stepIndex: number): void {
  s.stepIndex = stepIndex;
  s.move = null;
  s.jump = null;
  s.moveWriter = null;
  s.jumpWriter = null;
  s.transformWrites.length = 0;
  s.axesTag += 1;
  s.count = 0;
  s.moveY = null;
  s.characterMove = null;
  s.characterPlace = null;
  s.characterEnabled = null;
  if (s.characterWriters.size > 0) s.characterWriters.clear();
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
  /** The reused state view and step context per phase. */
  views?: Map<SimulationPhase, PhaseViews>;
  /** `owners` as a set (remade when `owners` is replaced). */
  ownerSet?: ReadonlySet<string>;
  ownerSetSource?: readonly string[];
}

/** A module's owners as a set, remade only when the owners list is replaced. */
function ownerSetOf(entry: ModuleEntry): ReadonlySet<string> {
  if (entry.ownerSet === undefined || entry.ownerSetSource !== entry.owners) {
    entry.ownerSet = new Set(entry.owners);
    entry.ownerSetSource = entry.owners;
  }
  return entry.ownerSet;
}

/** One module's reused views for one phase. */
interface PhaseViews {
  state: SimState;
  /** The step context (phased modules). */
  ctx: StepContext | null;
  /** The intents view the module's current call sees. */
  intents: IntentSet | null;
}

/** An `ActionSource.sample()` throw (module_error, reason `input_source_threw`). */
class InputSourceError extends Error {
  readonly reason = 'input_source_threw';
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
  // The interpolation invariant is 0 ≤ alpha < 1; a defensive clamp for the
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

/**
 * Whether a script may drive this entity's collider (a 3D
 * project): it has a collider, and neither a controller (the character is
 * the controller's) nor a mover (which moves it itself). The runtime turns
 * such a collider into a kinematic body posed from the entity's transform.
 */
function scriptDrivableCollider(components: unknown): boolean {
  if (!isPlainObject(components)) return false;
  return components['collider'] !== undefined && components['controller'] === undefined && components['mover'] === undefined;
}

/** A 3D port carries `dimension: 3` (the 2D port has no such field). */
function isPhysicsPort3D(v: unknown): v is PhysicsPort3D {
  return isPlainObject(v) && v['dimension'] === 3 && typeof v['stageCharacterMove'] === 'function' && typeof v['step'] === 'function' && typeof v['dispose'] === 'function';
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

/** Strict config parsing. */
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
    'variables',
    'startMode',
    'projectSettings',
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
  let physics3d: PhysicsPort3D | undefined;
  if (config.physics !== undefined && isPhysicsPort3D(config.physics)) {
    // A 3D project's port (the runtime holds one or the other).
    physics3d = config.physics;
  } else if (config.physics !== undefined) {
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
  // Injected script variables (ctx.save from step 0), under ctx.save's own rules.
  let variables: Record<string, unknown> | undefined;
  if (config.variables !== undefined) {
    const v = config.variables;
    if (!isPlainObject(v) || Object.keys(v).length > SAVE_MAX_KEYS) {
      return { error: fail('config_invalid', `config field "variables" must map at most ${SAVE_MAX_KEYS} keys to JSON values`, { reason: 'shape', path: '/variables' }) };
    }
    variables = {};
    for (const [k, value] of Object.entries(v)) {
      const text = saveValueText(value);
      if (!SAVE_KEY_RE.test(k) || text === null) {
        return { error: fail('config_invalid', `variable ${JSON.stringify(k.slice(0, 64))}: a key is 1-64 of A-Z a-z 0-9 _ . : - and a value JSON of at most ${SAVE_MAX_VALUE_CHARS} characters`, { reason: 'shape', path: `/variables/${k.slice(0, 64)}` }) };
      }
      variables[k] = JSON.parse(text) as unknown;
    }
  }
  // The game mode runs start in (checked against the snapshot's modes at instantiate).
  const startMode = config.startMode;
  if (startMode !== undefined && (typeof startMode !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(startMode))) {
    return { error: fail('config_invalid', 'config field "startMode" must be a game mode id', { reason: 'shape', path: '/startMode' }) };
  }
  // The stored project settings document (checked field by field against the save schema by the runtime).
  let projectSettings: Record<string, unknown> | undefined;
  if (config.projectSettings !== undefined) {
    if (!isPlainObject(config.projectSettings) || Object.keys(config.projectSettings).length > SAVE_LIMITS.settingsFields) {
      return { error: fail('config_invalid', `config field "projectSettings" must map at most ${SAVE_LIMITS.settingsFields} keys to values`, { reason: 'shape', path: '/projectSettings' }) };
    }
    projectSettings = { ...(config.projectSettings as Record<string, unknown>) };
  }
  return {
    cfg: {
      snapshot: config.snapshot,
      registry: config.registry as SimulationRegistry,
      modules,
      actions,
      physics,
      ...(physics3d !== undefined ? { physics3d } : {}),
      settings: config.settings,
      clock,
      clockLabel,
      driverKind,
      hz,
      onFrame,
      ...(variables !== undefined ? { variables } : {}),
      ...(startMode !== undefined ? { startMode } : {}),
      ...(projectSettings !== undefined ? { projectSettings } : {}),
    },
  };
}

/** `ctx.save` rules (shared by the start's injected script variables). */
const SAVE_MAX_KEYS = SCRIPT_SAVE_LIMITS.keys;
const SAVE_MAX_VALUE_CHARS = SCRIPT_SAVE_LIMITS.valueChars;
const SAVE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
/** A value's JSON text when it fits a save value, else null. */
function saveValueText(value: unknown): string | null {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  return text === undefined || text.length > SAVE_MAX_VALUE_CHARS ? null : text;
}

interface ParsedConfig {
  snapshot: unknown;
  registry: SimulationRegistry;
  modules: string[];
  actions: ActionSource;
  physics?: PhysicsPort;
  /** The 3D port (instead of `physics`). */
  physics3d?: PhysicsPort3D;
  settings: unknown;
  clock: () => number;
  clockLabel: 'performance' | 'injected';
  driverKind: 'raf' | 'manual';
  hz: number;
  onFrame?: () => void;
  variables?: Record<string, unknown>;
  startMode?: string;
  projectSettings?: Record<string, unknown>;
}

/**
 * Create a runtime instance. Validates the snapshot
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
  const { snapshot, registry, modules, actions, physics, physics3d, settings, clock, clockLabel, driverKind, hz, onFrame, variables, projectSettings, startMode } = parsed.cfg;

  const snap = validateRuntimeSnapshot(snapshot);
  if ('error' in snap) return { ok: false, error: snap.error };
  // A start mode names one of the project's modes (ignored without modes).
  if (startMode !== undefined && snap.modes !== undefined && !snap.modes.modes.some((m) => m.modeId === startMode)) {
    return { ok: false, error: fail('config_invalid', `config field "startMode": the project has no game mode "${startMode}"`, { reason: 'reference', path: '/startMode' }) };
  }
  const { scene, sceneVersion, snapshotId, revision } = snap;
  // The scene catalog (v4 only; null: one fixed scene).
  const sceneRows = snap.scenes;

  // Resolve the selection: unknown or duplicate
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

  // Validate every declared phase list (non-empty, unique, canonical).
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
  // At most 64 behavior modules per runtime instance.
  if (selected.filter((s) => s.id.startsWith(BEHAVIOR_MODULE_PREFIX)).length > INTENT_LIMITS.behaviorModules) {
    return {
      ok: false,
      error: fail('config_invalid', `at most ${INTENT_LIMITS.behaviorModules} behavior modules may be selected`, {
        reason: 'behavior_modules',
        path: '/modules',
      }),
    };
  }

  // Deep-freeze the snapshot (normative) — the input is
  // never written to; all mutable data is in the simulation state.
  // For a v3 scene, modules see the scene with folders and
  // inactive entities resolved away (the input stays frozen as well).
  const inputSnapshot = deepFreeze(snapshot as RuntimeSnapshot);
  const frozenSnapshot = deepFreeze({ ...inputSnapshot, scene } as RuntimeSnapshot);

  // Resolve + deep-freeze the gameplay settings.
  const settingsResult = resolveSettings(settings);
  if ('error' in settingsResult) return { ok: false, error: settingsResult.error };
  const resolvedSettings = deepFreeze(settingsResult.settings);

  // M2 module-set validation — before any instance is
  // created and before any port method is called.
  const controllerSpecs = selected.filter((s) => s.phases?.includes('controller') === true);
  const controllerIds = scene.entities
    .filter((e) => (e.components as { controller?: unknown }).controller !== undefined)
    .map((e) => e.id);
  if (isM2) {
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
    // A 3D port serves a module that needs physics too (the 3D character controller).
    if (needsPort && physics === undefined && physics3d === undefined) {
      return {
        ok: false,
        error: fail('config_invalid', 'the selected module set requires an injected physics port', {
          reason: PHYSICS_PORT_REASON,
          path: '/physics',
        }),
      };
    }
  }

  // Build the initial mutable state: prev = curr = the
  // snapshot transforms (both deep copies — the snapshot is never aliased).
  const order = scene.entities.map((e) => e.id);
  const entities = new Map<string, SimEntityData>();
  const prev = new Map<string, TransformState>();
  const curr = new Map<string, TransformState>();
  const cameraEntityIds: string[] = [];
  const colliderEntityIds = new Set<string>();
  const controllerEntityIds: string[] = [];
  for (const e of scene.entities) {
    const t = e.components.transform;
    const components = e.components;
    const data: SimEntityData = { id: e.id, parentId: e.parentId ?? null, transform: cloneTransform(t) };
    if (e.name !== undefined) data.name = e.name;
    data.componentKinds = Object.freeze(Object.keys(components));
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

  // One module instance per selection entry (created at instantiate). The
  // behavior-log sink routes a behavior's accepted `ctx.log` entries into the
  // runtime's own bounded diagnostics ring; the holder
  // is bound to the RuntimeInstance once it exists (no log can be emitted
  // before the first step).
  const logSink: BehaviorLogSink = { handler: null };
  // With a scene catalog the tag index follows loads/unloads.
  const liveTags = sceneRows !== null ? createTagQuery(frozenSnapshot) : null;
  const configFor = (specId: string): ModuleConfig => ({
    fixedStepHz: hz,
    settings: resolvedSettings,
    sceneVersion,
    behaviorLog: (level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }) => logSink.handler?.(specId, level, message, at),
    ...(liveTags !== null ? { tags: liveTags } : {}),
    // A 3D project (scripts may drive colliders through intents there).
    ...(physics3d !== undefined ? { physicsDimension: 3 as const } : {}),
    // The 3D character controller's read-only world queries.
    ...(physics3d !== undefined
      ? {
          character3D: {
            raycast: (origin: PhysicsVec3, direction: PhysicsVec3, maxDistance: number) => (typeof physics3d.raycast === 'function' ? physics3d.raycast(origin, direction, maxDistance) : null),
            clearance: (origin: PhysicsVec3) => (typeof physics3d.characterClearance === 'function' ? physics3d.characterClearance(origin) : null),
          },
        }
      : {}),
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
      // A behavior host create() failure carries its own contract code
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

  // Transform ownership (declared at create), duplicate-writer
  // and forbidden-entity rejection. A failure disposes every created
  // instance — no runtime instance is created and no port method is called.
  if (isM2) {
    // First pass: collect owners, then detect duplicate claims and missing
    // entities (the error table's order).
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
        // An owner in a scene that is not loaded is checked when it loads.
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
        if (cameraEntityIds.includes(entityId)) {
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
        // In a 3D project a transform-phase module (a script) may drive a collider
        // that no mover moves — the runtime poses it as a kinematic body (scriptDrivableCollider).
        const drivable = physics3d !== undefined && scriptDrivableCollider(scene.entities.find((x) => x.id === entityId)?.components);
        if ((colliderEntityIds.has(entityId) || controllerEntityIds.includes(entityId)) && !isController && !drivable) {
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
  }

  // The start scenes as batches (members listed by the host;
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
    timing: engineTimingSteps(hz),
    actions,
    physics,
    ...(physics3d !== undefined ? { physics3d } : {}),
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
    // The tag index 3D queries filter by (the live one when the project has a scene catalog).
    queryTags: liveTags ?? (physics3d !== undefined ? createTagQuery(frozenSnapshot) : null),
    animatorControllers: snap.animators as unknown as readonly AnimatorControllerLike[],
    initialEntities: scene.entities as unknown as readonly EntityV3[],
    prefabs: snap.prefabs,
    modelBounds: snap.modelBounds,
    audioDurations: snap.audioDurations,
    ...(snap.rigs !== undefined ? { rigs: snap.rigs } : {}),
    ...(variables !== undefined ? { variables } : {}),
    blockTypes: snap.blockTypes,
    cellFields: snap.cellFields,
    ...(snap.materialCatalog !== undefined ? { materialCatalog: snap.materialCatalog } : {}),
    ...(snap.saveSchema !== undefined ? { saveSchema: snap.saveSchema } : {}),
    ...(projectSettings !== undefined ? { projectSettings } : {}),
    environmentPresets: snap.environmentPresets ?? [],
    uiDocuments: snap.uiDocuments,
    ...(snap.dialogue !== undefined ? { dialogue: snap.dialogue } : {}),
    ...(snap.modes !== undefined ? { modes: snap.modes } : {}),
    ...(startMode !== undefined ? { startMode } : {}),
    ...(snap.timelines !== undefined ? { timelines: snap.timelines } : {}),
    ...(snap.eventCues !== undefined ? { eventCues: snap.eventCues } : {}),
    ...(snap.sceneList !== undefined ? { sceneList: snap.sceneList } : {}),
  });
  return { ok: true, runtime: rt };
}

/**
 * Write an intent's quaternion (normalized) or facing rotation
 * (validated before: finite, not all zero, up not parallel) into `rotation`.
 */
function writeRotationForm(rotation: Quat, intent: { quaternion?: readonly number[]; facing?: readonly number[]; up?: readonly number[] }): void {
  const q = intent.quaternion !== undefined ? normalizedQuaternion(intent.quaternion) : facingQuaternion(intent.facing!, intent.up);
  if (q === null) return;
  rotation[0] = q[0];
  rotation[1] = q[1];
  rotation[2] = q[2];
  rotation[3] = q[3];
}

function resolveSettings(input: unknown): { settings: GameplaySettings } | { error: RuntimeError } {
  // project-model owns the settings registry and validation; the runtime
  // consumes the resolved, frozen object.
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
  /** The engine timing in steps. */
  timing: { settleSteps: number; dropThroughSteps: number };
  actions: ActionSource;
  physics?: PhysicsPort;
  /** The 3D port (a project with physics_dimension 3), instead of `physics`. */
  physics3d?: PhysicsPort3D;
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
  queryTags: LiveTagIndex | null;
  /** The controllers, and the snapshot scene's entities (their `animator` components). */
  animatorControllers: readonly AnimatorControllerLike[];
  initialEntities: readonly EntityV3[];
  /** The prefab definitions scripts spawn. */
  prefabs: readonly PrefabDefinition[];
  /** Model assetId -> its recorded bounds. */
  modelBounds: Readonly<Record<string, ModelBounds>>;
  /** audio/music assetId -> its recorded duration (ms). */
  audioDurations: Readonly<Record<string, number>>;
  /** Model rigs (sockets are resolved on them). */
  rigs?: Readonly<Record<string, import('@thirdlight/project-model').ModelRig>>;
  /** Injected script variables (validated; ctx.save from step 0). */
  variables?: Readonly<Record<string, unknown>>;
  /** The block types and cell fields of the project's block layers. */
  blockTypes: readonly BlockType[];
  cellFields: readonly CellField[];
  /** The graph materials' parameters (ctx.materials). */
  materialCatalog?: RuntimeMaterialCatalog;
  /** The project save schema and the stored project settings document. */
  saveSchema?: SaveSchema;
  projectSettings?: Readonly<Record<string, unknown>>;
  /** The project's UI documents (id, layer, modal). */
  uiDocuments: readonly RuntimeUiDocumentRow[];
  /** The compiled conversations, speakers and dialogue settings. */
  dialogue?: import('@thirdlight/project-model').RuntimeDialogueData;
  /** The project's game modes (absent: none) and the mode runs start in. */
  modes?: import('@thirdlight/project-model').RuntimeModes;
  startMode?: string;
  /** The project's timelines. */
  timelines?: readonly TimelineAsset[];
  /** The event → cue table. */
  eventCues?: readonly import('./types').RuntimeEventCue[];
  /** The shell's ordered scene list. */
  sceneList?: readonly import('./types').ListedScene[];
  /** The environment preset ids (ctx.environment). */
  environmentPresets: readonly string[];
}

/** One requested spawn or destroy, applied at the next step boundary in request order. */
type SpawnOp = { op: 'spawn'; entities: readonly EntityV3[] } | { op: 'destroy'; entityId: string };

/** One loaded scene inside the runtime. */
interface SceneBatchState {
  sceneId: string;
  start: boolean;
  entities: readonly EntityV3[];
  ids: ReadonlySet<string>;
  contribution: SceneContribution;
}

/** One requested scene operation, committed with its step. */
/** What a transition does once its scene is in: the scenes it unloads (in the same step), its fade (seconds, colour). */
interface TransitionSpec {
  readonly unload: readonly string[];
  readonly fade: number;
  readonly color: string;
}
type SceneOp = { op: 'load'; sceneId: string; at?: readonly [number, number, number]; transition?: TransitionSpec } | { op: 'unload'; sceneId: string };
/**
 * The time a step boundary spends preparing loaded scenes'
 * entities (copying and freezing them) before it attaches them; a large
 * scene is prepared over several steps and attached in one.
 */
const SCENE_PREP_BUDGET_MS = 4;
const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const FADE_COLOR_RE = /^#[0-9a-f]{6}$/;

/** The largest impulse component a script may give the character (m/s; a safety limit, far above a jump). */
export const CHARACTER_IMPULSE_MAX = 100;
const NO_LOOKS: ReadonlyMap<string, import('./primitives').EntityLook> = new Map();
const NO_IDS: ReadonlySet<string> = new Set();

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
  private readonly actions: ActionSource;
  private readonly physics?: PhysicsPort;
  /**
   * The 3D port. With it the runtime runs the 3D character phase
   * (`runPhysicsPhase3D`) and commits the full position; `physics` is then
   * absent, so every 2D path (movers, drop-through, queries, respawn) is inert.
   */
  private readonly physics3d?: PhysicsPort3D;
  /** The 3D moves staged in this step's controller phase. */
  private staged3d = new Map<string, PhysicsVec3>();
  /** The character's vertical speed under gravity (m/s; 3D, no movement input yet). */
  private fallSpeed3d = 0;
  private lastCharacterResult3D?: CharacterMoveResult3D;
  /** The character's step-up height and ground snap (the 3D result check allows them). */
  private character3DClimb?: { stepHeight: number; groundSnap: number };
  /** Where the active camera's yaw comes from (the camera framework sets it; null: world axes). */
  private cameraYawSource: (() => number | undefined) | null = null;
  /**
   * The collider-bearing entities of a 3D world (their authored
   * components, to re-add a collider as kinematic), the colliders scripts
   * drive (posed each step from their transforms), and whether that set must
   * be brought up to date with the modules' owners before the next step.
   */
  private readonly colliderComponents3D = new Map<string, Readonly<Record<string, unknown>>>();
  private readonly scriptColliders3D = new Set<string>();
  private scriptCollidersDirty = true;
  private readonly settings: GameplaySettings;
  private readonly controllerEntityId?: string;
  /** The input actions the character's controller reads (its moveAction / jumpAction). */
  private readonly characterActions: { move: string; jump: string };
  private readonly characterActionNames: readonly string[];
  private order: readonly string[];
  private entities: Map<string, SimEntityData>;
  private readonly cameraInfo: CameraInfo;
  private entityCount: number;
  private prev: Map<string, TransformState>;
  private curr: Map<string, TransformState>;
  /** The last fully committed step's transforms (fail-stop rendering). */
  private committed: Map<string, TransformState> | null = null;
  /**
   * The step's backup (`prev` after the step) alternates between
   * two reused copies, and the committed state is a third, so a steady step
   * allocates no transform objects.
   */
  private readonly stepMirrors: readonly [TransformMirror, TransformMirror] = [new TransformMirror(), new TransformMirror()];
  private readonly committedMirror = new TransformMirror();
  /** Bumped whenever transforms are added to or removed from `curr` (the mirrors' shape key). */
  private currShape = 0;
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
  /** The engine timing in steps. */
  private readonly timing: { settleSteps: number; dropThroughSteps: number };
  private failedModuleId?: string;
  private failedPhase?: SimulationPhase;
  private failedStepIndex?: number;
  private errorRing: DiagnosticErrorEntry[] = [];
  /** The visual-script node of the error being fail-stopped (consumed by `failStop`). */
  private failNodeId: string | undefined = undefined;
  /** The failing error's compiled script frames (consumed by the fail-stop entry). */
  private failFrames: CompiledFrame[] = [];
  private errorCount = 0;
  private rafId: number | null = null;
  /** The settle pre-roll is initialization: cancellable before the first frame. */
  private prerollDone = false;
  private needsPreroll = false;
  private currentPhase?: SimulationPhase;
  private currentModuleId?: string;
  private staged = new Map<string, Vec2>();
  private lastCharacterResult?: CharacterMoveResult;
  /** The runtime's per-step intent set. */
  private intents: MutableIntentSet = emptyMutableIntents(-1);
  /** Bumped at every commit and step start; the intents view is remade only when it moved. */
  private intentsVersion = 0;
  private intentViewVersion = -1;
  private intentViewCache: IntentSet | null = null;
  /** The per-step intent cap for the current entity order (`intentStepLimit`). */
  private intentLimit: number = INTENT_LIMITS.perStep;
  private intentLimitOrder: readonly string[] | null = null;
  /** The frame the current phase runs with (read by the reused step contexts). */
  private phaseAction: ActionFrame = neutralFrame(0);
  /** The last validated input frame (its frozen action values are reused when equal). */
  private lastInputFrame: ActionFrame | null = null;
  /** The pointer state after the last sampled step (null before the first pointer sample). */
  private heldPointer: HeldPointer | null = null;
  /** The cursor a script asked for (null: the active input map decides). */
  private cursorMode: 'free' | 'locked' | null = null;
  /** What the host last sent about bindings and devices, this step's rebind events, the scripts' requests. */
  private readonly inputStatus = new RuntimeInputStatus();
  /** `ctx.input.setCursor` (the StepContext's cursor channel). */
  private readonly cursorControl = Object.freeze({
    request: (mode: 'free' | 'locked' | 'auto'): void => {
      this.cursorMode = mode === 'auto' ? null : mode;
    },
  });
  private frozenOrderSource: readonly string[] | null = null;
  private frozenOrderCopy: readonly string[] = Object.freeze([]);
  /** Accepted intents committed in this runtime instance. */
  private intentCommitCount = 0;
  /** The behavior-log ring sink bound to this instance. */
  private readonly logSink: BehaviorLogSink;
  /** Last observed behavior log totals (retained after disposal). */
  private behaviorLogTotals = { logCount: 0, logDropped: 0 };
  // ---- Scene set ---------------------------------------------------------
  /** Every scene of the project (null: one fixed scene, no scene API). */
  private readonly sceneRows: readonly RuntimeSceneRow[] | null;
  private startBatchSource: ReadonlyMap<string, readonly EntityV3[]>;
  /** The scripts' saved values (ctx.save; kept across restarts). */
  private readonly saveStore = new Map<string, unknown>();
  /** Paused — frames render and call onFrame, no steps run. */
  private paused = false;
  /**
   * Play debugging: held at a step boundary — like `paused`
   * but owned by the debugger, never by the game (the flow's pause does not
   * release it), and nothing at all happens at the boundary until a step is
   * allowed (`debugStep`) or the hold is released.
   */
  private debugHold = false;
  /** Steps the debugger allowed while held (each runs, then the hold stays). */
  private debugSteps = 0;
  /** Called after every executed step with the completed step index; true holds there (a breakpoint). */
  private stepWatcher: ((stepIndex: number) => boolean) | null = null;
  /** Told after every executed step (tools: the run digest after an input exercise); never holds. */
  private stepObserver: ((stepIndex: number) => void) | null = null;
  /** The start's injected script variables (applied again at every restart). */
  private startVariables: Readonly<Record<string, unknown>> | undefined;
  /** The step count when this run began (0; a restart's boundary) and the last spawned copy's number then. */
  private runStartStep = 0;
  private runSpawnBase = 0;
  /** Loaded scenes, in load order. */
  private batches = new Map<string, SceneBatchState>();
  private sceneStatus = new Map<string, SceneStatus>();
  /** Loads requested and not yet handed to the host. */
  private requestedLoads = new Map<string, { at?: readonly [number, number, number] }>();
  /** Loads the host is fetching. */
  private fetchingLoads = new Map<string, { at?: readonly [number, number, number] }>();
  /** Fetched scenes waiting for the next step boundary. */
  private readyLoads = new Map<string, readonly EntityV3[]>();
  /** Fetched scenes being prepared (copied and frozen, a budget per step boundary) before they attach. */
  private preparedLoads = new Map<string, { readonly out: EntityV3[]; next: number }>();
  private pendingUnloads = new Set<string>();
  /**
   * Transitions waiting for their scene (keyed by it): the
   * scenes they unload stay loaded (and drawn) until it is in, then both
   * happen at one step boundary. `outLeft`: steps of fade-out still to go.
   */
  private transitions = new Map<string, TransitionSpec & { readonly fadeSteps: number; outLeft: number }>();
  /** The last swap a transition made (the page fades back in once it drew that revision). */
  private lastSwap: { readonly scene: string; readonly revision: number; readonly seconds: number; readonly color: string } | null = null;
  private loadingViewCache: { key: string; view: import('./types').SceneLoadingView } | null = null;
  /** Scene ops issued during the running step (committed with it). */
  private stepSceneOps: SceneOp[] = [];
  private sceneRevision = 0;
  private sceneSetCache: SceneSetView | null = null;
  private readonly liveTags: LiveTagIndex | null;
  /** The tag index 3D queries filter by. */
  private readonly queryTags: LiveTagIndex | null;
  // ---- Animators ----
  private readonly animatorControllers = new Map<string, AnimatorControllerLike>();
  private readonly animatorMachines = new Map<string, { machine: AnimatorMachine; entity: EntityV3 }>();
  /** Parent ids of the loaded entities (the player's model may be a child of the player). */
  private readonly parentOf = new Map<string, string>();
  private animatorEvents: readonly AnimatorEventRecord[] = Object.freeze([]);
  private animatorWasGrounded = true;
  private readonly animatorControl: BehaviorAnimatorControl;
  // ---- The camera brain (virtual cameras; inert without one) ----
  private readonly cameras: CameraBrain;
  private readonly cameraControl: import('./types').BehaviorCamera;
  /** Sockets (entities riding on model nodes) and the script API over them. */
  private readonly sockets: SocketSystem;
  private readonly socketControl: import('./types').BehaviorSockets;
  // ---- The project UI (view model, shown documents, UI events) ----
  private readonly ui: UiState;
  /** UI events the host queued for the next sampled frame. */
  private uiQueue: UiEventRecord[] = [];
  /** The dialogue runner (inert without conversations) and dialogue inputs waiting for the next sampled step. */
  private readonly dialogue: DialogueRunner;
  private dialogueQueue: DialogueInputRecord[] = [];
  private readonly uiControls = new Map<SimulationPhase, BehaviorUi>();
  // ---- Game modes and the run lifecycle ----
  private readonly modes: ModeState;
  private readonly modeControls = new Map<SimulationPhase, import('./types').BehaviorModes>();
  /** The behavior group of each loaded entity that carries one (`behaviorGroup` component). */
  private readonly behaviorGroupOf = new Map<string, string>();
  /** The mode's time scale the frame clock was anchored with (a change re-anchors it). */
  private anchorScale = 1;
  /** The player spawn respawns use (null: the first one loaded, else where the player started). */
  private activeSpawn: string | null = null;
  /** A respawn (or a restart's placement) waiting for the next intent phase: where the character goes. */
  private pendingRespawn: [number, number, number] | null = null;
  /** A run restart waiting for the next step boundary (ctx.lifecycle.restart, a restart UI event). */
  private pendingRestart = false;
  /** The yaw (radians) the character faces on its next placement (a spawn's yaw), and this step's one for the controller. */
  private pendingFacing: number | null = null;
  private stepFacing: number | null = null;
  /** Impulses scripts gave the character (m/s, summed) waiting for the next controller phase. */
  private impulseAcc: [number, number, number] | null = null;
  /** A trigger's scene transition waiting for its scene (then the character moves to the spawn). */
  private pendingArrival: { spawnId: string; waitFor: string } | null = null;
  /** A loaded save's character placement, once the scenes it waits for are in. */
  private pendingRestore: { position: readonly [number, number, number]; velocity: readonly [number, number, number]; waitFor: readonly string[] } | null = null;
  /** The shell's ordered scene list, the entry the run is at (-1: none; null: not worked out yet this run) and a move asked for by a `scene` UI event. */
  private readonly sceneList: readonly import('./types').ListedScene[];
  private listedScene: number | null = null;
  private pendingListedScene: number | null = null;
  /** The event → cue table (empty: no event sounds). */
  private readonly eventCues: readonly import('./types').RuntimeEventCue[];
  private readonly lifecycleControl: import('./types').BehaviorLifecycle;
  private behaviorTicksFn: ((entityId: string) => boolean) | undefined = undefined;
  // ---- The sequencer (inert without timelines) ----
  private readonly timelines: TimelineSystem;
  private readonly timelineControl: import('./types').BehaviorTimeline;
  // ---- Gameplay building blocks ----
  private blocks: GameplayBlocks | null = null;
  /** The loaded block layers (`ctx.grid`, their colliders and render changes). */
  private readonly grid: RuntimeGrid;
  /** Graph-material parameters scripts set per object (`ctx.materials`). */
  private readonly materials: RuntimeMaterials;
  /** `ctx.entity(ref).get/set` — the written fields, the switched-off objects and the end-of-step writes. */
  private readonly entityAccess: EntityAccess;
  /** The step's pre-step transforms (what `get('transform')` reads during the step). */
  private stepStart: Map<string, TransformState> | null = null;
  /** `ctx.shell` (the shell's scene list from scripts). */
  private readonly shellControl: import('./types').BehaviorShell;
  /** Project saves (`ctx.saves`). */
  private readonly saves: RuntimeSaves;
  /** The environment preset blend (`ctx.environment`; inert until a script uses it). */
  private readonly environment: EnvironmentDirector;
  private raycastsThisStep = 0;
  /** The 3D query budget ran out once (warned in the play log). */
  private queryLimitWarned = false;
  private readonly signalControl = Object.freeze({
    emit: (name: string): void => {
      if (typeof name === 'string' && name.length > 0 && name.length <= MAX_SIGNAL_NAME) this.blocks?.emit(name);
    },
    on: (name: string): boolean => this.blocks?.signaled(String(name)) ?? false,
  });
  /** Script messages (`ctx.messages`; the behavior host passes sender and receiver). */
  private readonly messageControl = Object.freeze({
    send: (from: string, name: unknown, value: unknown, target: unknown): boolean => {
      if (typeof name !== 'string' || !MESSAGE_NAME_RE.test(name)) return false;
      let v: number | string | boolean | null;
      if (value === undefined || value === null) v = null;
      else if (typeof value === 'number') {
        if (!Number.isFinite(value)) return false;
        v = value;
      } else if (typeof value === 'string') {
        if (value.length > 256) return false;
        v = value;
      } else if (typeof value === 'boolean') v = value;
      else return false;
      let to: string | null = null;
      if (target !== undefined && target !== null && target !== '') {
        if (typeof target !== 'string' || target.length > 128) return false;
        to = target;
      }
      return this.blocks?.sendMessage({ name, value: v, from, stepIndex: this.stepIndex }, to) ?? false;
    },
    received: (to: string, name: unknown): readonly BehaviorMessage[] => (typeof name === 'string' ? (this.blocks?.messagesFor(to, name) ?? []) : []),
    all: (to: string): readonly BehaviorMessage[] => this.blocks?.messagesTo(to) ?? [],
  });
  private readonly gameControl = Object.freeze({
    counter: (name: string): number => this.blocks?.counter(String(name)) ?? 0,
    add: (name: string, delta: number): void => {
      if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name)) this.blocks?.addCounter(name, Number(delta));
    },
    health: (): { current: number; max: number } | null => this.blocks?.healthView() ?? null,
    setVisible: (entityId: string, visible: boolean): void => {
      if (typeof entityId === 'string' && this.curr.has(entityId)) this.blocks?.setVisible(entityId, visible === true);
    },
  });
  /** Any object's health (`ctx.health`; changes apply at once, events are seen next step). */
  private readonly healthControl = Object.freeze({
    get: (entityId: string): { current: number; max: number } | null => (typeof entityId === 'string' ? (this.blocks?.primitives.healthOf(entityId) ?? null) : null),
    damage: (entityId: string, amount: number, source?: string): boolean =>
      typeof entityId === 'string' && typeof amount === 'number' && (source === undefined || (typeof source === 'string' && source.length <= 128)) ? (this.blocks?.primitives.damage(entityId, amount, source ?? '') ?? false) : false,
    heal: (entityId: string, amount: number): boolean => (typeof entityId === 'string' && typeof amount === 'number' ? (this.blocks?.primitives.heal(entityId, amount) ?? false) : false),
    events: () => this.blocks?.primitives.healthEvents() ?? [],
  });
  /** Patrollers (`ctx.patrol`). */
  private readonly patrolControl = Object.freeze({
    get: (entityId: string) => (typeof entityId === 'string' ? (this.blocks?.primitives.patrolOf(entityId) ?? null) : null),
    setActive: (entityId: string, active: boolean): boolean => (typeof entityId === 'string' ? (this.blocks?.primitives.setPatrolActive(entityId, active === true) ?? false) : false),
    turn: (entityId: string): boolean => (typeof entityId === 'string' ? (this.blocks?.primitives.turnPatrol(entityId) ?? false) : false),
  });
  /** Hitboxes (`ctx.hitbox`). */
  private readonly hitboxControl = Object.freeze({
    setActive: (entityId: string, active: boolean): boolean => (typeof entityId === 'string' ? (this.blocks?.primitives.setHitboxActive(entityId, active === true) ?? false) : false),
    touching: (entityId: string): readonly string[] => (typeof entityId === 'string' ? (this.blocks?.primitives.touching(entityId) ?? []) : []),
  });
  /** Collectibles (`ctx.collectible`). */
  private readonly collectibleControl = Object.freeze({
    collected: (entityId: string): boolean => (typeof entityId === 'string' ? (this.blocks?.primitives.isCollected(entityId) ?? false) : false),
    restore: (entityId: string): boolean => (typeof entityId === 'string' ? (this.blocks?.primitives.restore(entityId) ?? false) : false),
  });
  /** The climb volume the character's capsule centre is in (read by the character controllers in the controller phase). */
  private readonly climbQuery: ClimbQuery = Object.freeze({ volume: () => this.blocks?.climbVolume() ?? null });
  /** The character (`ctx.character`): an impulse (m/s added to its velocity) for its next controller phase. */
  private readonly characterControl = Object.freeze({
    impulse: (v: unknown): boolean => {
      if (this.controllerEntityId === undefined) return false;
      if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= CHARACTER_IMPULSE_MAX)) return false;
      const a = this.impulseAcc ?? [0, 0, 0];
      // The 2D plane has no depth: its z is dropped.
      this.impulseAcc = [a[0] + (v[0] as number), a[1] + (v[1] as number), this.physics3d !== undefined ? a[2] + (v[2] as number) : 0];
      this.intentsVersion += 1;
      return true;
    },
  });
  /** Per-object look overrides (`ctx.look`; the renderer applies them). */
  private readonly lookControl = Object.freeze({
    set: (entityId: string, look: unknown): boolean => (typeof entityId === 'string' ? (this.blocks?.primitives.setLook(entityId, look) ?? false) : false),
    clear: (entityId: string): boolean => (typeof entityId === 'string' ? (this.blocks?.primitives.clearLook(entityId) ?? false) : false),
    get: (entityId: string): import('./primitives').EntityLook | null => (typeof entityId === 'string' ? (this.blocks?.primitives.lookOf(entityId) ?? null) : null),
  });
  /** The audio intent log (handles, fades, music, duck; the host plays its commands). */
  private readonly audio: AudioMixer;
  private readonly saveControl = Object.freeze({
    get: (key: string): unknown => (this.saveStore.has(String(key)) ? structuredClone(this.saveStore.get(String(key))) : undefined),
    set: (key: string, value: unknown): boolean => {
      if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) return false;
      if (!this.saveStore.has(key) && this.saveStore.size >= SAVE_MAX_KEYS) return false;
      let text: string | undefined;
      try {
        text = JSON.stringify(value);
      } catch {
        return false;
      }
      if (text === undefined || text.length > SAVE_MAX_VALUE_CHARS) return false;
      this.saveStore.set(key, JSON.parse(text) as unknown);
      return true;
    },
    remove: (key: string): void => {
      this.saveStore.delete(String(key));
    },
    keys: (): string[] => [...this.saveStore.keys()].sort(),
  });
  /** Debug commands: declared ones, calls waiting for the next step, this step's calls. */
  private readonly debugCommands = new DebugCommands({
    emitSignal: (name) => this.blocks?.emit(name),
    dropped: (problem, stepIndex) => this.recordError({ code: 'module_error', message: clipMessage(`debug command dropped: ${problem}`), stepIndex, reason: 'debug_command_invalid' }),
  });
  /** Storage answers queued by the host for the next sampled step. */
  private saveQueue: SaveEvent[] = [];
  private readonly audioControl: import('./types').BehaviorAudio;
  // ---- Visual effect requests (presentation only) ----
  /** Requests since the adapter last took them (bounded: the oldest are dropped beyond 256). */
  private effectQueue: EffectRequest[] = [];
  /** The last play handle handed out (never reset while the game runs: handles stay unique). */
  private effectHandle = 0;
  /** Script plays in the current step (at most 32). */
  private effectPlaysStep = -1;
  private effectPlaysThisStep = 0;
  private pushEffect(r: Omit<EffectRequest, 'stepIndex' | 'handle'> & { handle?: number }): number {
    const handle = r.op === 'play' ? ++this.effectHandle : (r.handle ?? 0);
    const req: EffectRequest = Object.freeze({ ...r, handle, stepIndex: this.stepIndex + 1, position: Object.freeze([r.position[0], r.position[1], r.position[2]]) as unknown as readonly [number, number, number] });
    this.effectQueue.push(req);
    // Nobody takes them (no renderer, e.g. a headless run): keep only the newest.
    if (this.effectQueue.length > 256) this.effectQueue.splice(0, this.effectQueue.length - 256);
    return handle;
  }
  private readonly effectsControl = Object.freeze({
    play: (effectId: string, options?: { position?: readonly number[]; entityId?: string; params?: Readonly<Record<string, number | readonly number[] | string>> }): number => {
      if (typeof effectId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(effectId)) return 0;
      if (this.effectPlaysStep !== this.stepIndex) {
        this.effectPlaysStep = this.stepIndex;
        this.effectPlaysThisStep = 0;
      }
      if (this.effectPlaysThisStep >= 32) return 0;
      this.effectPlaysThisStep += 1;
      const p = options?.position;
      const position: [number, number, number] = [Number(p?.[0] ?? 0), Number(p?.[1] ?? 0), Number(p?.[2] ?? 0)].map((v) => (Number.isFinite(v) ? v : 0)) as [number, number, number];
      const entityId = typeof options?.entityId === 'string' && options.entityId !== '' ? options.entityId : null;
      let params: Record<string, number | readonly number[] | string> | null = null;
      if (options?.params !== undefined && options.params !== null && typeof options.params === 'object') {
        params = {};
        for (const [k, v] of Object.entries(options.params).slice(0, 32)) {
          if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
          else if (typeof v === 'string' && v.length <= 16) params[k] = v;
          else if (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) params[k] = Object.freeze([...v]);
        }
        params = Object.freeze(params);
      }
      return this.pushEffect({ op: 'play', effectId, entityId, position, params, source: 'script' });
    },
    stop: (target: number | string): void => {
      if (typeof target === 'number' && Number.isInteger(target) && target > 0) this.pushEffect({ op: 'stop', effectId: '', handle: target, entityId: null, position: [0, 0, 0], params: null, source: 'script' });
      else if (typeof target === 'string' && target !== '') this.pushEffect({ op: 'stop', effectId: '', handle: 0, entityId: target, position: [0, 0, 0], params: null, source: 'script' });
    },
  });

  /** Entities that are never unloaded with their scene (camera, player, start spawn). Lights go with their scene. */
  private readonly pinnedIds: ReadonlySet<string>;
  private readonly sceneControl: BehaviorSceneControl;
  // ---- Spawned prefab copies ----
  private readonly prefabs: ReadonlyMap<string, PrefabDefinition>;
  /** The live spawned entities, in spawn order (parents before children). */
  private readonly spawnedEntities = new Map<string, EntityV3>();
  /** Spawns and destroys waiting for the next step boundary. */
  private spawnOps: SpawnOp[] = [];
  /** Ids handed out to spawns that are not live yet. */
  private readonly reservedSpawnIds = new Set<string>();
  /** Destroys queued (so a second destroy of the same id reports false). */
  private readonly pendingDestroys = new Set<string>();
  /** The last `spawn-<n>` number handed out (never reset while the game runs). */
  private spawnSerial = 0;
  private spawnsThisStep = 0;
  private spawnRefusalLogged = false;
  private readonly spawnControl: BehaviorSpawnControl;

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
    this.timing = args.timing;
    this.actions = args.actions;
    // Injected variables are the scripts' saved values from step 0.
    // And again at every restart (a replay, a shell's new game), so every start begins with them.
    this.startVariables = args.variables;
    this.applyStartVariables();
    this.physics = args.physics;
    if (args.physics3d !== undefined) {
      this.physics3d = args.physics3d;
      for (const e of args.initialEntities) {
        const c = e.components as unknown as Record<string, unknown>;
        if (c['collider'] !== undefined && c['controller'] === undefined) this.colliderComponents3D.set(e.id, c);
        // The character's step-up height and ground snap.
        if (c['controller'] !== undefined) {
          const climb = character3DPhysicsOf(c['controller'], args.settings.max_slope_climb_deg);
          this.character3DClimb = { stepHeight: climb.stepHeight, groundSnap: climb.groundSnap };
        }
      }
    }
    this.settings = args.settings;
    this.controllerEntityId = args.controllerEntityId;
    this.order = args.order;
    this.entities = args.entities;
    this.cameraInfo = args.cameraInfo;
    this.entityCount = args.order.length;
    this.prev = args.prev;
    this.curr = args.curr;
    // The state committed at the end of the last fully completed step.
    // Initialized to the instantiate-time state so a fail-stop during the
    // 12-step settle pre-roll (before any step completes) renders only the
    // committed initial state — never the abandoned step's transform.
    this.committedMirror.copyFrom(args.curr, this.currShape);
    this.committed = this.committedMirror.map;
    this.logSink = args.logSink;
    args.logSink.handler = (moduleId: string, level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }): void =>
      this.recordBehaviorLog(moduleId, level, message, at);
    this.sceneRows = args.sceneRows;
    this.liveTags = args.liveTags;
    this.queryTags = args.queryTags;
    this.startBatchSource = new Map(args.startBatches.map((b) => [b.sceneId, b.entities]));
    const pinned = new Set<string>([args.cameraInfo.id]);
    if (args.controllerEntityId !== undefined) pinned.add(args.controllerEntityId);
    for (const e of args.entities.values()) if (e.camera !== undefined) pinned.add(e.id);
    this.pinnedIds = pinned;
    if (args.sceneRows !== null) {
      for (const row of args.sceneRows) this.sceneStatus.set(row.sceneId, 'unloaded');
      for (const b of args.startBatches) {
        this.batches.set(b.sceneId, { sceneId: b.sceneId, start: true, entities: Object.freeze(b.entities), ids: new Set(b.entities.map((e) => e.id)), contribution: sceneContribution(b.entities) });
        this.sceneStatus.set(b.sceneId, 'loaded');
      }
    }
    this.sceneControl = this.buildSceneControl();
    this.prefabs = new Map(args.prefabs.map((d) => [d.prefabId, d]));
    this.spawnControl = this.buildSpawnControl();
    // The start scenes' block layers; in 3D their chunks collide (a 2D plane draws them only).
    this.grid = new RuntimeGrid(args.blockTypes, args.cellFields, args.physics3d !== undefined, args.settings.max_slope_climb_deg);
    this.grid.addLayers(args.initialEntities);
    this.grid.flushCollision(args.physics3d);
    // The start set's graph materials (the values scripts set per object).
    this.materials = new RuntimeMaterials(args.materialCatalog);
    this.entityAccess = this.buildEntityAccess();
    this.shellControl = this.buildShellControl();
    this.materials.addEntities(args.initialEntities);
    // The environment preset blend (before the saves, whose sections read it).
    this.environment = new EnvironmentDirector(this.hz, args.environmentPresets, (message) => this.recordBehaviorLog('thirdlight.runtime:environment', 'warn', message));
    // Project saves (the document, slots, settings; inert without a save schema).
    this.saves = new RuntimeSaves(args.saveSchema, this.hz, this.buildSaveSections(), args.projectSettings, (message) => this.recordBehaviorLog('thirdlight.runtime:saves', 'warn', message));
    for (const c of args.animatorControllers) this.animatorControllers.set(c.controllerId, c);
    this.addAnimators(args.initialEntities);
    // The audio intent log (clip lengths from the snapshot's recorded durations).
    this.audio = new AudioMixer(this.hz, args.audioDurations, () => this.stepIndex);
    this.audioControl = this.buildAudioControl();
    // The virtual cameras of the start set (the brain is inert without one).
    this.cameras = new CameraBrain(this.hz, { fovY: args.cameraInfo.fovY, near: args.cameraInfo.near, far: args.cameraInfo.far }, (message) => this.recordBehaviorLog('thirdlight.runtime:camera', 'warn', message));
    this.cameras.add(args.initialEntities);
    this.cameraControl = this.buildCameraControl();
    // The project UI (inert until a script or a frame uses it).
    this.ui = new UiState(args.uiDocuments);
    // Conversations (the view model under `dialogue.`, voice through the audio intent log).
    const ui = this.ui;
    const durations = args.audioDurations;
    this.dialogue = new DialogueRunner(
      args.dialogue ?? null,
      { set: (p, v) => ui.set(p, v), clear: (p) => ui.clear(p), show: (d) => ui.show(d), hide: (d) => ui.hide(d), isShown: (d) => ui.isShown(d), focus: (d, w) => ui.command('focus', d, w, undefined) },
      this.audio,
      this.hz,
      (id) => {
        const ms = durations[id];
        return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
      },
    );
    // The game modes (inert without modes) — the first run begins in the start mode.
    this.modes = new ModeState(args.modes, this.hz, {
      showUi: (doc) => void this.ui.show(doc),
      hideUi: (doc) => void this.ui.hide(doc),
      isShown: (doc) => this.ui.isShown(doc),
      setCamera: (id, blend) => this.cameras.setOverride(id, blend),
      warn: (message) => this.recordBehaviorLog('thirdlight.runtime:modes', 'warn', message),
    });
    this.modes.setStartMode(args.startMode);
    this.modes.beginRun(1);
    this.anchorScale = this.modes.active ? this.modes.timeScale() : 1;
    this.noteBehaviorGroups(args.initialEntities);
    this.lifecycleControl = this.buildLifecycleControl();
    this.eventCues = args.eventCues ?? [];
    this.sceneList = args.sceneList ?? [];
    // Movers, triggers, switches, one-way colliders and the generic primitives
    // (the character is the controller's object in both dimensions).
    const rt = this;
    const characterComponents = args.initialEntities.find((e) => e.id === args.controllerEntityId)?.components.controller;
    this.characterActions = controllerActionsOf(characterComponents);
    // And its climb action (a game mode that switches gameplay off holds it too).
    const climbAction = controllerMovementOf(characterComponents).climbAction;
    this.characterActionNames = Object.freeze([this.characterActions.move, this.characterActions.jump, ...(climbAction !== null ? [climbAction] : [])]);
    this.blocks = new GameplayBlocks(
      {
        hz: this.hz,
        physics: this.physics,
        curr: this.curr,
        characterId: args.controllerEntityId ?? '',
        // The character's own capsule (its controller's, else the default).
        characterCapsule: playerCapsuleOf(characterComponents),
        // The character's skin (a pushing mover keeps it).
        characterSkin: controllerTuningOf(characterComponents).skin,
        // Gravity bodies fall under the project's gravity, capped at its fall speed.
        gravityY: this.settings.gravity_y,
        maxFallSpeed: this.settings.max_fall_speed,
        character: () => {
          const t = rt.controllerEntityId !== undefined ? rt.curr.get(rt.controllerEntityId) : undefined;
          return t === undefined ? null : { x: t.position[0], y: t.position[1] };
        },
        groundEntityId: () => (rt.physics3d !== undefined ? (rt.lastCharacterResult3D?.groundEntityId ?? null) : (rt.lastCharacterResult?.groundEntityId ?? null)),
        // The 3D world (movers posed on it, triggers in 3D).
        ...(args.physics3d !== undefined
          ? {
              physics3d: args.physics3d,
              characterOffsetZ: controllerCapsuleOffsetZ(args.initialEntities.find((e) => e.id === args.controllerEntityId)?.components.controller),
              character3: () => {
                const t = rt.controllerEntityId !== undefined ? rt.curr.get(rt.controllerEntityId) : undefined;
                return t === undefined ? null : [t.position[0], t.position[1], t.position[2]];
              },
              scriptColliders3D: () => rt.scriptColliderPoses3D(),
            }
          : {}),
        // A trigger's scene transition.
        sceneTransition: (triggerId, t) => rt.beginSceneTransition(triggerId, t),
        effect: (r) => void rt.pushEffect({ op: r.op, effectId: r.effectId, entityId: r.entityId, position: r.position, params: null, source: r.source }),
      },
      args.initialEntities,
    );
    this.animatorControl = Object.freeze({
      of: (entityId: string): BehaviorAnimatorHandle | null => {
        const rec = this.animatorMachines.get(String(entityId));
        if (rec === undefined) return null;
        const m = rec.machine;
        return Object.freeze({
          set: (name: string, value: number | boolean) => m.set(String(name), value),
          trigger: (name: string) => m.trigger(String(name)),
          get: (name: string) => m.get(String(name)),
          state: (layer?: number) => m.stateName(typeof layer === 'number' && Number.isInteger(layer) && layer >= 0 ? layer : 0),
          // Per-instance playback speed and morph weights.
          setSpeed: (speed: number) => m.setSpeed(speed),
          speed: () => m.speed(),
          setMorph: (name: string, weight: number) => m.setMorph(String(name), weight),
          morph: (name: string) => m.morph(String(name)),
        });
      },
    });
    // Sockets — the start set's authored ones attach now and sit on their nodes from the first frame.
    this.sockets = new SocketSystem(args.rigs, {
      get curr() {
        return rt.curr;
      },
      parentOf: (id: string) => rt.entities.get(id)?.parentId ?? (rt.entities.has(id) ? null : undefined),
      componentsOf: (id: string) => rt.entities.get(id)?.componentKinds ?? (rt.entities.has(id) ? [] : undefined),
      poseOf: (id: string) => rt.animatorMachines.get(id)?.machine.pose() ?? null,
      warn: (message: string) => rt.recordBehaviorLog('thirdlight.runtime:sockets', 'warn', message),
    });
    this.sockets.add(args.initialEntities);
    this.settleSockets();
    this.socketControl = this.buildSocketControl();
    // The timelines (inert while the project has none).
    this.timelines = new TimelineSystem(args.timelines ?? [], this.hz, this.buildTimelineHost());
    this.timelineControl = this.buildTimelineControl();
    // The event → cue table listens to the blocks' signals and events.
    if (this.eventCues.length > 0) this.blocks?.enableCueLog();
  }

  // ---- Sockets ---------------------------------------------------------

  /**
   * Pose the attached entities now and make `prev` (and the committed copy)
   * agree, so the next frame draws them on their nodes without a streak from
   * where they were (the start of a game or a run).
   */
  private settleSockets(): void {
    if (!this.sockets.active) return;
    this.sockets.resolve(this.committed);
    for (const a of this.sockets.list()) {
      const c = this.curr.get(a.entityId);
      const p = this.prev.get(a.entityId);
      if (c === undefined || p === undefined || p === c) continue;
      for (let k = 0; k < 3; k += 1) p.position[k] = c.position[k]!;
      for (let k = 0; k < 4; k += 1) p.rotation[k] = c.rotation[k]!;
      for (let k = 0; k < 3; k += 1) p.scale[k] = c.scale[k]!;
    }
  }

  /** The step's socket pass (after the animators stepped): attached entities follow their nodes. */
  private stepSockets(mirror: Map<string, TransformState> | null): void {
    if (this.sockets.active) this.sockets.resolve(mirror);
  }

  socketAttachments(): readonly { readonly entityId: string; readonly target: string; readonly node: string }[] {
    return this.sockets.list();
  }

  private buildSocketControl(): import('./types').BehaviorSockets {
    const sockets = this.sockets;
    const vec = (v: unknown): readonly number[] | undefined => (Array.isArray(v) ? (v as number[]) : undefined);
    return Object.freeze({
      attach: (entityId: string, targetId?: string, node?: string, position?: readonly number[], rotation?: readonly number[], scale?: readonly number[]): boolean =>
        sockets.attach(String(entityId), targetId === undefined || targetId === null ? undefined : String(targetId), node === undefined || node === null ? undefined : String(node), vec(position), vec(rotation), vec(scale)),
      detach: (entityId: string, keepWorld?: boolean): boolean => sockets.detach(String(entityId), keepWorld !== false),
      attachedTo: (entityId: string) => {
        const a = sockets.attachedTo(String(entityId));
        return a === null ? null : Object.freeze({ target: a.target, nodeName: a.node });
      },
      nodePose: (targetId: string, node: string) => {
        const p: number[] = [0, 0, 0];
        const r: number[] = [0, 0, 0, 1];
        if (!sockets.nodeWorld(String(targetId), String(node), p, r)) return null;
        return Object.freeze({ position: Object.freeze([p[0]!, p[1]!, p[2]!] as const), rotation: Object.freeze([r[0]!, r[1]!, r[2]!, r[3]!] as const) });
      },
    });
  }

  // ---- Animators -------------------------------------------------

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
    this.animatorLastPos = null;
  }

  /** The character the locomotion parameters describe: the controller's object. */
  private animatedCharacter(): string {
    return this.controllerEntityId ?? '';
  }

  private isPlayerOrChild(id: string): boolean {
    const character = this.animatedCharacter();
    if (character === '') return false;
    let cur: string | undefined = id;
    for (let depth = 0; cur !== undefined && depth < 64; depth++) {
      if (cur === character) return true;
      cur = this.parentOf.get(cur);
    }
    return false;
  }

  /**
   * The character's motion over the last step (its position a
   * step ago; null after a reset): horizontal speed (x and z), vertical
   * velocity and the controller's grounding.
   */
  private animatorLastPos: [number, number, number] | null = null;
  private characterMotion(): { speed: number; vy: number; grounded: boolean } {
    const id = this.animatedCharacter();
    const t = id !== '' ? this.curr.get(id) : undefined;
    const grounded = this.physics3d !== undefined ? this.lastCharacterResult3D?.grounded ?? true : this.lastCharacterResult?.grounded ?? true;
    if (t === undefined) return { speed: 0, vy: 0, grounded };
    const p = t.position;
    const last = this.animatorLastPos;
    this.animatorLastPos = [p[0], p[1], p[2]];
    if (last === null) return { speed: 0, vy: 0, grounded };
    return { speed: Math.hypot(p[0] - last[0], p[2] - last[2]) * this.hz, vy: (p[1] - last[1]) * this.hz, grounded };
  }

  /**
   * Advance every animator by one fixed step. The character's animators get
   * `speed` (horizontal, m/s), `grounded`, `velocityY` and the `landed`
   * trigger from the committed motion, when their controller has them — the
   * controller's object.
   */
  private stepAnimators(): void {
    if (this.animatorMachines.size === 0) return;
    const { speed, vy, grounded } = this.characterMotion();
    const landed = grounded && !this.animatorWasGrounded;
    this.animatorWasGrounded = grounded;
    const fired: AnimatorEventRecord[] = [];
    const dt = 1 / this.hz;
    const off = this.entityAccess.inactive();
    for (const [id, { machine }] of this.animatorMachines) {
      // A switched-off object's animator holds its pose.
      if (off.size > 0 && off.has(id)) continue;
      if (this.isPlayerOrChild(id)) {
        machine.set('speed', speed);
        machine.set('grounded', grounded);
        machine.set('velocityY', vy);
        if (landed) machine.trigger('landed');
      }
      for (const e of machine.step(dt)) fired.push(Object.freeze({ entityId: id, name: e.name, clip: e.clip, stepIndex: this.stepIndex }));
    }
    this.animatorEvents = Object.freeze(fired);
  }

  /**
   * The effect requests since the last call (scripts'
   * `ctx.effects`, effect components' signals, gameplay hooks), in the order
   * they were made; the adapter plays them. Taking them changes nothing the
   * simulation computes.
   */
  takeEffectRequests(): EffectRequest[] {
    const out = this.effectQueue;
    this.effectQueue = [];
    return out;
  }

  /**
   * The block-layer chunks to re-mesh since the last call (their
   * cells now; null: no cells left) — cells scripts wrote, layers of scenes
   * loaded, a new run back to the authored cells. The renderer applies them
   * to its copy of each layer. Taking them changes nothing the simulation computes.
   */
  takeGridChanges(): GridRenderChange[] {
    return this.grid.takeRenderChanges();
  }

  /** The cells changed since the run started (tests, saves). */
  gridDiff(): import('./grid').GridDiff {
    return this.grid.api.diff();
  }

  /**
   * The material parameters scripts changed since the last call
   * (the latest value of each, a cleared one, a data parameter's grid) — the
   * renderer applies them per object. Taking them changes nothing the simulation computes.
   */
  takeMaterialChanges(): MaterialRenderChange[] {
    return this.materials.takeRenderChanges();
  }

  /** The values scripts set, as digest text (null while none is set). */
  materialState(): string | null {
    return this.materials.digestText();
  }

  /**
   * The environment preset weights interpolated like the
   * transforms (the renderer blends the look from them), or null until a
   * script changed the environment. Reading changes nothing the simulation computes.
   */
  readEnvironmentBlend(): EnvironmentBlendView | null {
    if (this.stateName === 'disposed') return null;
    return this.environment.view(this.stateName === 'failed' ? 1 : this.lastAlpha);
  }

  /** The committed environment blend as digest text (null until a script changed it). */
  environmentState(): string | null {
    return this.environment.digestText();
  }

  /** The player's save from the game shell, made now (between steps) and handed to the host with the next requests. */
  requestSave(slot: number, meta?: import('./project-saves').SaveMeta): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (this.saves.schema === null) return { ok: false, error: fail('game_command_invalid', 'this game has no project save schema', { reason: 'saves' }) };
    const problem = this.saves.saveNow(slot, meta ?? {});
    return problem === null ? { ok: true } : { ok: false, error: fail('game_command_invalid', problem, { reason: 'saves' }) };
  }

  /** Every object's health now (the HUD's bindings). */
  healthsView(): Readonly<Record<string, { readonly current: number; readonly max: number }>> {
    return this.blocks?.primitives.healthsView() ?? {};
  }

  /** The save/load/delete/settings requests since the last call; the host (the storage owner) carries them out. */
  takeSaveRequests(): SaveRequest[] {
    return this.saves.takeRequests();
  }

  /**
   * Queue one storage answer (the slot list, a save/delete
   * outcome, a loaded document) for the next sampled step — it rides on that
   * step's input frame, so a recording replays it and the worker applies it
   * at the same step. Refused for a project without a save schema, a bad
   * entry, or when 64 are already waiting.
   */
  queueSaveEvent(event: SaveEvent): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (this.saves.schema === null) return { ok: false, error: fail('game_command_invalid', 'this game has no project save schema', { reason: 'saves' }) };
    const checked = validateSaveEvents([event]);
    if (!checked.ok) return { ok: false, error: fail('game_command_invalid', `save entry: ${checked.message}`, { reason: 'saves' }) };
    if (this.saveQueue.length >= 64) return { ok: false, error: fail('game_command_invalid', 'at most 64 storage answers may wait for the next step', { reason: 'pending' }) };
    this.saveQueue.push(checked.events[0]!);
    return { ok: true };
  }

  /** The project saves state as digest text (null without a save schema or before any save activity). */
  savesState(): string | null {
    return this.saves.digestText();
  }

  /** The project settings document now (empty without a save schema). */
  projectSettings(): Readonly<Record<string, boolean | number | string>> {
    return this.saves.settingsNow();
  }

  /** The engine state a save document's sections capture and restore. */
  private buildSaveSections(): SaveSectionsPort {
    const rt = this;
    return {
      capture(section) {
        switch (section) {
          case 'grid':
            return rt.grid.api.diff();
          case 'materials':
            return rt.materials.saveState();
          case 'storage':
            return Object.fromEntries([...rt.saveStore.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
          case 'spawned':
            return rt.spawnedCopies();
          case 'dialogue':
            return rt.dialogue.saveState();
          case 'environment':
            return rt.environment.saveState();
          case 'components': {
            // The named counters travel with the objects' state (a collectible's total with it being collected).
            const state = rt.blocks?.primitives.saveState() ?? {};
            const counters = rt.blocks?.countersView() ?? {};
            // The fields scripts wrote (ctx.entity(id).set), only when there are any.
            const fields = rt.entityAccess.saveState();
            return { ...state, ...(Object.keys(counters).length > 0 ? { counters } : {}), ...(Object.keys(fields).length > 0 ? { fields } : {}) };
          }
        }
      },
      check(section, value) {
        switch (section) {
          case 'grid':
            return null;
          case 'materials':
            return rt.materials.checkState(value);
          case 'storage': {
            if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length > SAVE_MAX_KEYS) return `the storage section maps at most ${SAVE_MAX_KEYS} keys to values`;
            for (const [k, v] of Object.entries(value)) if (!SAVE_KEY_RE.test(k) || saveValueText(v) === null) return `storage key "${k.slice(0, 64)}" does not fit ctx.save's rules`;
            return null;
          }
          case 'spawned':
            return rt.spawnedCopiesProblem(value);
          case 'dialogue':
            return rt.dialogue.checkState(value);
          case 'environment':
            return rt.environment.checkState(value);
          case 'components': {
            if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'fields' in value) {
              const { fields, ...others } = value as Record<string, unknown>;
              const problem = rt.entityAccess.checkState(fields);
              if (problem !== null) return problem;
              value = others;
            }
            if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'counters' in value) {
              const { counters, ...rest } = value as Record<string, unknown>;
              if (typeof counters !== 'object' || counters === null || Array.isArray(counters) || Object.keys(counters).length > 256) return 'the components section\'s counters map at most 256 names to numbers';
              for (const [k, v] of Object.entries(counters)) if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v)) return `counter "${k.slice(0, 40)}" is not a counter name with a number`;
              return rt.blocks?.primitives.checkState(rest) ?? null;
            }
            return rt.blocks?.primitives.checkState(value) ?? null;
          }
        }
      },
      captureWorld: (): WorldSave => rt.captureWorld(),
      checkWorld: (world: WorldSave): string | null => rt.worldProblem(world),
      applyWorld: (world: WorldSave): void => rt.applyWorld(world),
      apply(section, value) {
        switch (section) {
          case 'grid':
            return rt.grid.restoreDiff(value);
          case 'materials':
            rt.materials.restoreState(value as import('./material-params').MaterialSaveEntry[] | undefined);
            return null;
          case 'storage':
            rt.saveStore.clear();
            for (const [k, v] of Object.entries((value ?? {}) as Record<string, unknown>)) rt.saveStore.set(k, JSON.parse(saveValueText(v)!) as unknown);
            return null;
          case 'spawned':
            rt.restoreSpawnedCopies((value ?? []) as SavedSpawnCopy[]);
            return null;
          case 'dialogue':
            rt.dialogue.restoreState(value);
            // The dialogue case fell through into the environment's restore.
            return null;
          case 'environment':
            rt.environment.restoreState(value as EnvironmentSaveState | undefined);
            return null;
          case 'components': {
            const { counters, fields, ...rest } = (value ?? {}) as Record<string, unknown>;
            rt.blocks?.primitives.restoreState(rest as import('./primitives').PrimitivesSaveState);
            rt.blocks?.setCounters((counters ?? {}) as Record<string, number>);
            rt.entityAccess.restoreState(fields as EntityFieldsSave | undefined);
            return null;
          }
        }
      },
    };
  }

  /** The live spawned copies (prefab, ids in prefab order, the root's placement now). */
  private spawnedCopies(): SavedSpawnCopy[] {
    const out: SavedSpawnCopy[] = [];
    const copyOf = new Map<string, string[]>();
    const roots: string[] = [];
    for (const e of this.spawnedEntities.values()) {
      if (this.pendingDestroys.has(e.id)) continue;
      const parent = e.parentId;
      const ids = parent !== undefined ? copyOf.get(parent) : undefined;
      // Parents come before children: a child joins its parent's copy.
      if (ids !== undefined) {
        ids.push(e.id);
        copyOf.set(e.id, ids);
      } else {
        const own = [e.id];
        copyOf.set(e.id, own);
        roots.push(e.id);
      }
    }
    for (const rootId of roots) {
      const root = this.spawnedEntities.get(rootId)!;
      const prefabId = (root.components as { prefab?: { prefabId?: string } }).prefab?.prefabId;
      const t = this.curr.get(rootId);
      if (prefabId === undefined || t === undefined) continue;
      out.push({ prefabId, ids: [...copyOf.get(rootId)!], position: [t.position[0], t.position[1], t.position[2]], rotation: [t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]], scale: [t.scale[0], t.scale[1], t.scale[2]] });
    }
    return out;
  }

  private spawnedCopiesProblem(value: unknown): string | null {
    if (!Array.isArray(value)) return 'the spawned section is a list';
    const seen = new Set<string>();
    let total = 0;
    for (const c of value as SavedSpawnCopy[]) {
      if (typeof c !== 'object' || c === null || typeof c.prefabId !== 'string' || !Array.isArray(c.ids)) return 'a spawned copy is { prefabId, ids, position, rotation, scale }';
      const def = this.prefabs.get(c.prefabId);
      if (def === undefined) return `prefab "${c.prefabId.slice(0, 64)}" is not in this game`;
      if (c.ids.length !== def.entities.length) return `the copy of "${c.prefabId}" has ${c.ids.length} ids; the prefab has ${def.entities.length} objects`;
      for (const id of c.ids) {
        if (typeof id !== 'string' || !/^spawn-[1-9][0-9]{0,15}$/.test(id) || seen.has(id)) return 'spawned ids are spawn-<n>, each once';
        if (this.entities.has(id) && !this.spawnedEntities.has(id)) return `"${id}" is an object of the scene`;
        seen.add(id);
      }
      total += c.ids.length;
      const parsed = parseSpawnOptions(def, { position: c.position, rotation: c.rotation, scale: c.scale });
      if (!parsed.ok) return `the copy of "${c.prefabId}": ${parsed.message}`;
    }
    if (total > MAX_LIVE_SPAWNED) return `at most ${MAX_LIVE_SPAWNED} spawned objects`;
    return null;
  }

  /** The spawned copies become the saved ones at the next step boundary (checked with `spawnedCopiesProblem`). */
  private restoreSpawnedCopies(copies: readonly SavedSpawnCopy[]): void {
    this.spawnOps = [];
    this.reservedSpawnIds.clear();
    this.pendingDestroys.clear();
    for (const e of this.spawnedEntities.values()) {
      if (e.parentId !== undefined && this.spawnedEntities.has(e.parentId)) continue;
      this.pendingDestroys.add(e.id);
      this.spawnOps.push({ op: 'destroy', entityId: e.id });
    }
    for (const c of copies) {
      const def = this.prefabs.get(c.prefabId)!;
      const parsed = parseSpawnOptions(def, { position: c.position, rotation: c.rotation, scale: c.scale });
      if (!parsed.ok) continue;
      for (const id of c.ids) {
        this.reservedSpawnIds.add(id);
        const n = Number(id.slice(SPAWN_ID_PREFIX.length));
        if (n > this.spawnSerial) this.spawnSerial = n;
      }
      this.spawnOps.push({ op: 'spawn', entities: expandPrefab(def, c.ids, parsed.placement, this.entityRefKeysOf) });
    }
  }


  /**
   * The sounds scripts played since the last call; the host plays
   * them. The audio intent log's commands (plays with handles,
   * stops, fades, music, duck, bus mix, reset), in the order they were made.
   * Taking them changes nothing the simulation computes.
   */
  takeAudioRequests(): AudioCommand[] {
    return this.audio.take();
  }

  /** The audio intent log's deterministic state (null while scripts never used audio). */
  audioState(): Record<string, unknown> | null {
    return this.audio.state();
  }

  /** Pause or resume the simulation (frames still render and reach onFrame). */
  setPaused(paused: boolean): void {
    this.paused = paused === true;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** The last frame's interpolation alpha (what `getInterpolatedState().state.alpha` reports), without building the state. */
  get interpolationAlpha(): number {
    return this.stateName === 'failed' ? 0 : this.lastAlpha;
  }

  /**
   * Play debugging: hold the simulation at the next step
   * boundary (true) or let it run on (false). Frames still render and reach
   * onFrame; the clock resumes from where it was released (no catch-up).
   * Holding changes nothing the simulation computes: the same steps run
   * with the same inputs, only later.
   */
  setDebugHold(hold: boolean): void {
    this.debugHold = hold === true;
    if (!this.debugHold) this.debugSteps = 0;
  }

  /** Held at a step boundary by the debugger. */
  get debugHeld(): boolean {
    return this.debugHold;
  }

  /** While held, run exactly one more step on the next frame (then stay held). */
  debugStep(): void {
    if (this.debugHold) this.debugSteps += 1;
  }

  /**
   * A check after every executed step (settle steps excluded):
   * returning true holds the simulation right there — the rest of that
   * frame's steps do not run (a breakpoint pauses at a step boundary, the
   * same one whatever the frame rate). null removes it.
   */
  setStepWatcher(watcher: ((stepIndex: number) => boolean) | null): void {
    this.stepWatcher = watcher;
  }

  /** An observer told after every executed step (settle steps excluded) with the step count; null removes it. */
  setStepObserver(observer: ((stepIndex: number) => void) | null): void {
    this.stepObserver = observer;
  }

  /**
   * Where this run began — the step count (0, or the boundary
   * of the last restart) and the number of the last spawned copy then (a
   * run's copies are numbered after it: ids are never reused in a play).
   */
  runStart(): { readonly step: number; readonly spawnBase: number } {
    return { step: this.runStartStep, spawnBase: this.runSpawnBase };
  }

  /**
   * Entities hidden (collected collectibles, ctx.game.setVisible; the renderer hides them).
   * With the objects scripts switched off (and their children), which are not drawn either.
   */
  hiddenEntities(): ReadonlySet<string> {
    const hidden = this.blocks?.hiddenEntities() ?? NO_IDS;
    const off = this.entityAccess.inactive();
    if (off.size === 0) return hidden;
    if (hidden.size === 0) return off;
    if (this.hiddenUnion === null || this.hiddenUnion.hidden !== hidden || this.hiddenUnion.off !== off || this.hiddenUnion.size !== hidden.size) {
      this.hiddenUnion = { hidden, off, size: hidden.size, set: new Set([...hidden, ...off]) };
    }
    return this.hiddenUnion.set;
  }
  private hiddenUnion: { hidden: ReadonlySet<string>; off: ReadonlySet<string>; size: number; set: ReadonlySet<string> } | null = null;

  /** The objects scripts switched off, with their children (not drawn, no collision, no triggers, no ticking; audio sources silent). */
  inactiveEntities(): ReadonlySet<string> {
    return this.entityAccess.inactive();
  }

  /** The light values scripts wrote (`ctx.entity(id).set('light', …)`), by object; the renderer applies them. */
  lightOverrides(): ReadonlyMap<string, LightOverride> {
    return this.entityAccess.lightOverrides();
  }

  /** The fields scripts wrote, as digest text (null while none: every other digest is unchanged). */
  entityFieldsState(): string | null {
    return this.entityAccess.digestText();
  }

  /** `ctx.entity` — what the generic component access reads and writes in this runtime. */
  private buildEntityAccess(): EntityAccess {
    const rt = this;
    return new EntityAccess({
      doc: (id) => rt.entityDocument(id),
      stepStartTransform: (id) => rt.stepStart?.get(id) ?? rt.curr.get(id),
      get curr() {
        return rt.curr;
      },
      order: () => rt.order,
      parentOf: (id) => rt.entities.get(id)?.parentId ?? undefined,
      get cameraId() {
        return rt.cameraInfo.id ?? undefined;
      },
      get controllerId() {
        return rt.controllerEntityId;
      },
      isPhysicsBody: (id) => id === rt.controllerEntityId || rt.entities.get(id)?.hasCollider === true,
      transformIntentWrote: (id) => {
        const stored = rt.intents.axes.get(id);
        const tag = rt.intents.axesTag * 64;
        return stored !== undefined && stored >= tag && stored < tag + 64 && stored !== tag;
      },
      hiddenAtStepStart: (id) => rt.blocks?.hiddenAtStepStart(id) ?? false,
      setVisible: (id, visible) => rt.blocks?.setVisible(id, visible),
      moverState: (id) => rt.blocks?.moverState(id) ?? null,
      setMover: (id, patch) => rt.blocks?.setMover(id, patch),
      get materials() {
        return rt.materials;
      },
      inactiveChanged: (off, on) => rt.onInactiveChanged(off, on),
      record: (entry) => rt.recordError(entry),
      stepIndex: () => rt.stepIndex,
    });
  }

  /**
   * Objects were switched off or on (with their children): the
   * blocks skip them, their colliders leave the physics world (and come back
   * where they are now), their scripts and animators stop ticking (read per
   * step), the renderer hides them (`hiddenEntities`).
   */
  private onInactiveChanged(off: readonly string[], on: readonly string[]): void {
    const set = this.entityAccess.inactive();
    this.blocks?.setInactive(set);
    this.behaviorTicksFn = undefined;
    this.behaviorTicksOff = null;
    const colliderOf = (id: string): boolean => id !== this.controllerEntityId && this.entities.get(id)?.hasCollider === true;
    const leaving = off.filter(colliderOf);
    const coming = on.filter(colliderOf);
    if (leaving.length === 0 && coming.length === 0) return;
    try {
      if (leaving.length > 0) {
        this.physics3d?.removeStaticColliders?.(leaving);
        this.physics?.removeStaticColliders?.(leaving);
        for (const id of leaving) this.scriptColliders3D.delete(id);
      }
      if (coming.length > 0) {
        const at = (id: string): Record<string, unknown> => {
          const c = (this.entityDocument(id)?.components ?? {}) as unknown as Record<string, unknown>;
          const t = this.curr.get(id);
          return t === undefined ? c : { ...c, transform: { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] } };
        };
        if (this.physics3d !== undefined) {
          const specs = coming.map((id) => staticColliderOf3D(id, at(id))).filter((x): x is StaticColliderSpec3D => x !== null);
          if (specs.length > 0) this.physics3d.addStaticColliders?.(specs);
          // A collider a script owns becomes kinematic again at the next boundary.
          this.scriptCollidersDirty = true;
        } else if (this.physics !== undefined) {
          const specs = coming.map((id) => staticColliderOf(id, at(id))).filter((x): x is NonNullable<typeof x> => x !== null);
          if (specs.length > 0) this.physics.addStaticColliders?.(specs);
        }
      }
    } catch (e) {
      this.failStop('physics_port_error', 'entity_active', `switching the colliders of ${[...leaving, ...coming].slice(0, 4).join(', ')} failed: ${messageOf(e)}`, this.stepIndex);
    }
  }

  /**
   * A behavior's `entityRef` property keys (its module's
   * declaration), for the typed remap of prefab-local references in spawned
   * copies; undefined for a behavior this game has no module for.
   */
  private readonly entityRefKeysOf = (behaviorId: string): readonly string[] | undefined => {
    const entry = this.entries.find((e) => e.id === `thirdlight.behavior:${behaviorId}`);
    const probe = entry?.instance as { behaviorEntityRefKeys?: () => readonly string[] } | undefined;
    return typeof probe?.behaviorEntityRefKeys === 'function' ? probe.behaviorEntityRefKeys() : undefined;
  };

  /** `ctx.shell` — the shell's scene list (the same move as the shell's nextScene UI action). */
  private buildShellControl(): import('./types').BehaviorShell {
    const rt = this;
    return Object.freeze({
      nextScene(): boolean {
        // From the entry the run is at (calling it twice in a step asks for the same move).
        const next = rt.listedSceneIndex() + 1;
        if (rt.sceneList.length === 0 || next >= rt.sceneList.length) return false;
        rt.pendingListedScene = next;
        return true;
      },
      sceneIndex(): number {
        return rt.listedSceneIndex();
      },
      sceneCount(): number {
        return rt.sceneList.length;
      },
    });
  }

  /** The run's named counters and the character's health. */
  gameCounters(): { counters: Record<string, number>; health: { current: number; max: number } | null } {
    return { counters: this.blocks?.countersView() ?? {}, health: this.blocks?.healthView() ?? null };
  }

  /** Every loaded animator's pose (the renderer plays these). */
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
      // Exactly one driver at any time (normative): one rAF loop,
      // installed here, cancelled on stop/dispose. The wall anchor is set
      // on the FIRST frame, not here.
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
      // stop() from `failed` returns { ok: true } (no driver).
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
    // Works in every state, including disposed.
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
        // Alpha == 0 or prev == curr ⇒ the result is curr exactly.
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

  /**
   * The interpolated transform of every entity (draw order), the
   * values `getInterpolatedState` would return, handed to `visit` in three
   * arrays the runtime reuses (copy them; they change at the next entity) —
   * no objects per frame. False when the runtime is disposed.
   */
  forEachInterpolated(visit: InterpolatedVisitor): boolean {
    if (this.stateName === 'disposed') return false;
    const failed = this.stateName === 'failed' && this.committed !== null;
    const prev = failed ? this.committed! : this.prev;
    const curr = failed ? this.committed! : this.curr;
    const alpha = this.stateName === 'failed' ? 0 : this.lastAlpha;
    const order = this.order;
    for (let i = 0; i < order.length; i += 1) {
      const id = order[i]!;
      if (this.interpolateInto(id, prev, curr, alpha)) visit(id, this.interpPosition, this.interpRotation, this.interpScale);
    }
    return true;
  }

  /** Every entity's committed transform (the last step's state; no interpolation). */
  forEachCommitted(visit: InterpolatedVisitor): boolean {
    if (this.stateName === 'disposed') return false;
    const curr = this.stateName === 'failed' && this.committed !== null ? this.committed : this.curr;
    const order = this.order;
    for (let i = 0; i < order.length; i += 1) {
      const id = order[i]!;
      // alpha 0 reads the committed transform as it is.
      if (this.interpolateInto(id, curr, curr, 0)) visit(id, this.interpPosition, this.interpRotation, this.interpScale);
    }
    return true;
  }

  /**
   * One entity's interpolated transform into the caller's arrays
   * (no allocation). False when the runtime is disposed or has no such entity.
   */
  readInterpolated(id: string, position: number[], rotation: number[], scale: number[]): boolean {
    if (this.stateName === 'disposed') return false;
    const failed = this.stateName === 'failed' && this.committed !== null;
    const prev = failed ? this.committed! : this.prev;
    const curr = failed ? this.committed! : this.curr;
    if (!this.interpolateInto(id, prev, curr, this.stateName === 'failed' ? 0 : this.lastAlpha)) return false;
    for (let k = 0; k < 3; k += 1) position[k] = this.interpPosition[k]!;
    for (let k = 0; k < 4; k += 1) rotation[k] = this.interpRotation[k]!;
    for (let k = 0; k < 3; k += 1) scale[k] = this.interpScale[k]!;
    return true;
  }

  private readonly interpPosition: number[] = [0, 0, 0];
  private readonly interpRotation: number[] = [0, 0, 0, 1];
  private readonly interpScale: number[] = [1, 1, 1];

  // ---- The resolved camera (virtual cameras) ------------------------

  /**
   * The view the camera brain resolved, interpolated like the transforms
   * (`position`, `rotation` written; its lens returned), or null when the
   * game has no virtual camera (the renderer then draws the camera entity
   * as before) or the brain has not stepped yet.
   */
  readCameraView(position: number[], rotation: number[]): { fovY: number; near: number; far: number; letterbox: number } | null {
    if (this.stateName === 'disposed' || !this.cameras.active || !this.cameras.hasView()) return null;
    return this.cameras.readInterpolated(this.stateName === 'failed' ? 1 : this.lastAlpha, position, rotation);
  }

  /** The committed camera view (the live camera, a blend in progress, the pose and lens), or null without a virtual camera. */
  cameraView(): CameraViewInfo | null {
    if (this.stateName === 'disposed' || !this.cameras.active || !this.cameras.hasView()) return null;
    return this.cameras.view();
  }

  /**
   * The viewport the view is drawn in (the renderer reports it): screen↔world
   * projection (`ctx.camera`) uses its aspect (16:9 until reported). It
   * moves no camera, so games without virtual cameras keep their exact
   * framing.
   */
  setCameraViewport(width: number, height: number): boolean {
    if (this.stateName === 'disposed') return false;
    return this.cameras.setViewport(width, height);
  }

  /** One camera-brain step on the step's committed transforms. */
  private stepCameras(action: ActionFrame | null): void {
    if (!this.cameras.active) return;
    const base = this.curr.get(this.cameraInfo.id);
    const pos = this.cameraWorldPos;
    const rot = this.cameraWorldRot;
    if (base === undefined || !this.worldTransformOf(this.cameraInfo.id, pos, rot)) {
      pos[0] = 0;
      pos[1] = 0;
      pos[2] = 0;
      rot[0] = 0;
      rot[1] = 0;
      rot[2] = 0;
      rot[3] = 1;
    }
    this.cameras.step({ position: pos, rotation: rot }, action, this.cameraWorld);
  }

  private readonly cameraWorldPos: number[] = [0, 0, 0];
  private readonly cameraWorldRot: number[] = [0, 0, 0, 1];
  private readonly cameraWorld = {
    worldOf: (id: string, position: number[], rotation: number[]): boolean => this.worldTransformOf(id, position, rotation),
    raycast: (origin: [number, number, number], direction: [number, number, number], maxDistance: number): { distance: number } | null => {
      // 3D projects only: a 2D plane's colliders lie in the plane a camera looks at, never between it and the target.
      const port = this.physics3d;
      if (port === undefined || typeof port.raycast !== 'function') return null;
      const hit = port.raycast({ x: origin[0], y: origin[1], z: origin[2] }, { x: direction[0], y: direction[1], z: direction[2] }, maxDistance);
      return hit === null ? null : { distance: hit.distance };
    },
  };

  /** An entity's world position and rotation, composed up its parents from the step's transforms (false: not loaded). */
  private worldTransformOf(id: string, position: number[], rotation: number[]): boolean {
    const t = this.curr.get(id);
    if (t === undefined) return false;
    let px = t.position[0], py = t.position[1], pz = t.position[2];
    let qx = t.rotation[0], qy = t.rotation[1], qz = t.rotation[2], qw = t.rotation[3];
    let parent = this.entities.get(id)?.parentId ?? null;
    for (let depth = 0; parent !== null && depth < 64; depth += 1) {
      const pt = this.curr.get(parent);
      if (pt === undefined) break;
      // p := parentPos + parentRot · (parentScale ⊙ p); q := parentRot · q
      const sx = px * pt.scale[0], sy = py * pt.scale[1], sz = pz * pt.scale[2];
      const [ax, ay, az, aw] = pt.rotation;
      const tx = 2 * (ay * sz - az * sy), ty = 2 * (az * sx - ax * sz), tz = 2 * (ax * sy - ay * sx);
      px = pt.position[0] + sx + aw * tx + (ay * tz - az * ty);
      py = pt.position[1] + sy + aw * ty + (az * tx - ax * tz);
      pz = pt.position[2] + sz + aw * tz + (ax * ty - ay * tx);
      const nx = aw * qx + ax * qw + ay * qz - az * qy;
      const ny = aw * qy - ax * qz + ay * qw + az * qx;
      const nz = aw * qz + ax * qy - ay * qx + az * qw;
      const nw = aw * qw - ax * qx - ay * qy - az * qz;
      qx = nx;
      qy = ny;
      qz = nz;
      qw = nw;
      parent = this.entities.get(parent)?.parentId ?? null;
    }
    position[0] = px;
    position[1] = py;
    position[2] = pz;
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    rotation[0] = qx / len;
    rotation[1] = qy / len;
    rotation[2] = qz / len;
    rotation[3] = qw / len;
    return true;
  }

  /** `ctx.audio` (arguments checked by the mixer; every change is a command in step order). */
  private buildAudioControl(): import('./types').BehaviorAudio {
    const a = this.audio;
    return Object.freeze({
      play: (assetId: string, options?: import('./types').AudioPlayOptions): number => a.play(assetId, options),
      stop: (handle: number, fadeSeconds?: number): void => a.stop(handle, fadeSeconds),
      fade: (handle: number, to: number, seconds: number): void => a.fade(handle, to, seconds),
      setVolume: (handle: number, volume: number): void => a.setVolume(handle, volume),
      setPitch: (handle: number, pitch: number): void => a.setPitch(handle, pitch),
      setLoop: (handle: number, loop: boolean): void => a.setLoop(handle, loop),
      playing: (handle: number): boolean => a.playing(handle),
      volumeOf: (handle: number): number => a.volumeOf(handle),
      finished: (handle: number): boolean => a.finished(handle),
      events: () => a.events(),
      music: (assetId: string | null, fadeSeconds?: number): void => a.music(assetId, fadeSeconds),
      releaseMusic: (fadeSeconds?: number): void => a.releaseMusic(fadeSeconds),
      stinger: (assetId: string, options?: import('./types').AudioStingerOptions): number => a.stinger(assetId, options),
      duck: (level: number, seconds?: number): void => a.duck(level, seconds),
      unduck: (seconds?: number): void => a.unduck(seconds),
      musicState: () => a.musicState(),
      setBusVolume: (bus: 'sfx' | 'music' | 'voice' | 'ui', volume: number, seconds?: number): void => a.setBusVolume(bus, volume, seconds),
      busVolume: (bus: 'sfx' | 'music' | 'voice' | 'ui'): number => a.busVolume(bus),
    });
  }

  /** `ctx.camera` (arguments checked here; the brain applies them in order). */
  private buildCameraControl(): import('./types').BehaviorCamera {
    const brain = this.cameras;
    const blendOf = (o: unknown): unknown => (typeof o === 'object' && o !== null ? o : undefined);
    return Object.freeze({
      activate: (cameraId: string, options?: unknown): boolean => brain.activate(String(cameraId), blendOf(options)),
      deactivate: (cameraId: string, options?: unknown): boolean => brain.deactivate(String(cameraId), blendOf(options)),
      setPriority: (cameraId: string, priority: number): boolean => brain.setPriority(String(cameraId), Number(priority)),
      setTarget: (cameraId: string, entityId: string): boolean => brain.setTarget(String(cameraId), typeof entityId === 'string' ? entityId : null),
      set: (cameraId: string, params: unknown): boolean => brain.set(String(cameraId), params),
      turn: (cameraId: string, steps: number): boolean => brain.turn(String(cameraId), Number(steps)),
      shake: (amplitude: number, seconds: number, frequency?: number, rotation?: number, seed?: number): void => brain.shake(Number(amplitude), Number(seconds), frequency, rotation, seed),
      live: (): string | null => brain.live(),
      blending: (): boolean => brain.blending(),
      get: (cameraId: string) => brain.get(String(cameraId)),
      // Without a live virtual camera the projection is the scene camera's (it was a fixed default pose).
      worldToScreen: (position: readonly number[]) => (this.brainHasView() ? brain.worldToScreen(Array.isArray(position) ? position : [0, 0, 0]) : this.baseWorldToScreen(Array.isArray(position) ? position : [0, 0, 0])),
      screenToRay: (x: number, y: number) => this.screenRay(Number(x), Number(y)),
    }) as import('./types').BehaviorCamera;
  }

  /** The interpolation rule for one entity into the reused arrays (see `getInterpolatedState`). */
  private interpolateInto(id: string, prev: ReadonlyMap<string, TransformState>, curr: ReadonlyMap<string, TransformState>, alpha: number): boolean {
    const p = prev.get(id);
    const c = curr.get(id);
    if (!p || !c) return false;
    const pos = this.interpPosition;
    const rot = this.interpRotation;
    const scl = this.interpScale;
    if (alpha === 0 || (vec3Equal(p.position, c.position) && vec3Equal(p.scale, c.scale) && quatEqual(p.rotation, c.rotation))) {
      pos[0] = c.position[0];
      pos[1] = c.position[1];
      pos[2] = c.position[2];
      rot[0] = c.rotation[0];
      rot[1] = c.rotation[1];
      rot[2] = c.rotation[2];
      rot[3] = c.rotation[3];
      scl[0] = c.scale[0];
      scl[1] = c.scale[1];
      scl[2] = c.scale[2];
    } else {
      lerpVec3Into(pos, p.position, c.position, alpha);
      slerpQuatInto(rot, p.rotation, c.rotation, alpha);
      lerpVec3Into(scl, p.scale, c.scale, alpha);
    }
    return true;
  }

  getCamera(): { ok: true; camera: CameraInfo } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    }
    // Stable for the session: the snapshot's camera
    // projection parameters; aspect is a viewport property.
    return {
      ok: true,
      camera: { id: this.cameraInfo.id, fovY: this.cameraInfo.fovY, near: this.cameraInfo.near, far: this.cameraInfo.far },
    };
  }

  // ---- Scene set ---------------------------------------------------------

  sceneSet(): SceneSetView {
    if (this.sceneSetCache === null) {
      this.sceneSetCache = Object.freeze({
        revision: this.sceneRevision,
        batches: Object.freeze([...this.batches.values()].map((b) => Object.freeze({ sceneId: b.sceneId, start: b.start, entities: b.entities }))),
        status: Object.freeze(Object.fromEntries(this.sceneStatus)),
        spawned: Object.freeze([...this.spawnedEntities.values()]),
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
      // A transition to a scene that could not be read keeps the world it has.
      this.transitions.delete(sceneId);
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
    this.enqueueSceneOp(op === 'load' ? this.loadOp(sceneId, options) : { op, sceneId });
    return { ok: true };
  }

  /** A load op from (validated) load options: its offset, and a transition when it unloads or fades. */
  private loadOp(sceneId: string, options: SceneLoadOptions | undefined): SceneOp {
    const at = options?.at;
    const unload = options?.unload ?? [];
    const fade = options?.fade ?? 0;
    return {
      op: 'load',
      sceneId,
      ...(at !== undefined ? { at: Object.freeze([at[0], at[1], at[2]] as const) } : {}),
      ...(unload.length > 0 || fade > 0 ? { transition: Object.freeze({ unload: Object.freeze([...unload]), fade, color: options?.fadeColor ?? '#000000' }) } : {}),
    };
  }

  /** The scenes being loaded, the transition waiting and the last swap (unchanged views are the same object). */
  sceneLoadingView(): import('./types').SceneLoadingView {
    const loading: string[] = [];
    for (const [id, st] of this.sceneStatus) if (st === 'loading') loading.push(id);
    let transition: import('./types').SceneTransitionView | null = null;
    for (const [scene, t] of this.transitions) {
      if (this.sceneStatus.get(scene) !== 'loading') continue;
      const fade = t.fadeSteps === 0 ? 1 : Math.round((1 - t.outLeft / t.fadeSteps) * 1000) / 1000;
      transition = { scene, phase: t.outLeft > 0 ? 'out' : 'loading', fade, seconds: t.fade, color: t.color, unload: t.unload };
      break;
    }
    const key = `${loading.join(',')}|${transition === null ? '' : `${transition.scene}:${transition.phase}:${transition.fade}`}|${this.lastSwap?.revision ?? -1}`;
    if (this.loadingViewCache !== null && this.loadingViewCache.key === key) return this.loadingViewCache.view;
    const view = deepFreeze({ loading, transition, swap: this.lastSwap === null ? null : { ...this.lastSwap } });
    this.loadingViewCache = { key, view };
    return view;
  }

  /**
   * A test or debug start's spawn in a game without the game
   * session (Play from a scene, `tl_play_start sceneId`): the character
   * arrives at `spawnId` once `sceneId` is loaded, as a scene transition's
   * arrival (the spawn becomes the active one).
   */
  requestArrival(sceneId: string, spawnId: string): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (!this.sceneStatus.has(sceneId)) return { ok: false, error: fail('scene_invalid', `unknown scene ${JSON.stringify(String(sceneId).slice(0, 64))}`, { reason: 'transfer' }) };
    this.pendingArrival = { spawnId, waitFor: sceneId };
    return { ok: true };
  }

  dispose(): { ok: true; alreadyDisposed?: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') {
      return { ok: true, alreadyDisposed: true };
    }
    this.cancelDriver();
    this.stateName = 'disposed';
    // Capture the behavior log totals before the instances are released so
    // `logCount`/`logDropped` stay observable after disposal.
    this.behaviorLogDiagnostics();
    // Release the module instances and all references held by the
    // runtime so the heap is reclaimable: dispose is
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
    if (this.physics3d) {
      try {
        this.physics3d.dispose();
      } catch {
        /* a failing port dispose must not break runtime disposal */
      }
    }
    this.prev = new Map();
    this.curr = new Map();
    this.committed = null;
    this.entities = new Map();
    this.order = [];
    if (this.staged.size > 0) this.staged.clear();
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
    // running; stop/dispose cancel it (no duplicate loops).
    if (this.stateName === 'running') {
      this.rafId = globalThis.requestAnimationFrame(this.onRafFrame);
    }
  };

  /** One frame update + onFrame (frame ordering: step → onFrame). */
  private runFrame(t: number): void {
    this.frameCount += 1; // frame updates, including zero-step frames
    if (this.needsPreroll) {
      // Settle pre-roll: exactly `settleTime` of steps (default
      // SETTLE_PREROLL_STEPS) with neutral frames, no input sampling, no wall
      // time; the anchor is installed at this frame's simTime afterwards.
      this.needsPreroll = false;
      this.prerollDone = true;
      this.settleSteps = this.timing.settleSteps;
      for (let i = 0; i < this.timing.settleSteps; i += 1) {
        if (!this.stepOnceM2(neutralFrame(this.stepIndex))) return; // failed
      }
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
      this.onFrame?.();
      return;
    }
    if (!this.anchor) {
      // First frame after start: initialize the anchor at that frame
      //  — time before start is never simulated (zero steps).
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
      this.onFrame?.();
      return;
    }
    const elapsed = t - this.anchor.wall;
    if (elapsed < 0) {
      // Non-monotonic clock: zero steps + one clock_warning diagnostic
      // count, no error. The anchor is left in place.
      this.clockWarningCount += 1;
      this.lastAlpha = 0;
      this.onFrame?.();
      return;
    }
    if (this.debugHold) {
      // Held by the debugger — no steps (and nothing applied at the
      // boundary) except the single steps it allowed; the clock resumes from here.
      if (this.debugSteps > 0) {
        this.debugSteps -= 1;
        if (this.isM2) {
          if (!this.stepOnceM2()) return;
        } else if (!this.stepOnce()) return;
        this.stepObserver?.(this.stepIndex);
      }
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
      this.onFrame?.();
      return;
    }
    if (this.paused) {
      // No steps while paused; the clock resumes from here.
      // Scene loads/unloads still apply (a paused game's menu may
      // show another scene — the title background); this is the same step
      // boundary the next step would apply them at, so runs replay alike.
      if (!this.applySceneOps(false)) return;
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
      this.onFrame?.();
      return;
    }
    // The game mode's time scale — fewer or more fixed steps per wall second, each
    // step unchanged (1 without modes: exactly the arithmetic before).
    const targetSim = this.anchor.simTime + elapsed * this.anchorScale;
    const rawN = Math.floor((targetSim - this.simTime) / this.dt + STEP_COUNT_EPS);
    const n = Math.min(rawN, MAX_CATCHUP_STEPS);
    let held = false;
    for (let i = 0; i < n; i += 1) {
      if (this.isM2) {
        if (!this.stepOnceM2()) return; // fail-stop: no further frame/onFrame
      } else if (!this.stepOnce()) {
        return; // a 3D physics fail-stop (the only way a plain step stops)
      }
      this.stepObserver?.(this.stepIndex);
      // An observer that held the simulation (an input exercise with `hold`) stops the frame's steps right there.
      if (this.debugHold) {
        this.debugSteps = 0;
        held = true;
        break;
      }
      // A breakpoint holds right after the step it hit.
      if (this.stepWatcher !== null && this.stepWatcher(this.stepIndex)) {
        this.debugHold = true;
        this.debugSteps = 0;
        held = true;
        break;
      }
    }
    if (held) {
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
    } else if (rawN > MAX_CATCHUP_STEPS) {
      // Bounded catch-up (normative): drop the remainder and
      // resync the anchor — no unbounded burst after a stall. The
      // resync makes targetSim == simTime for the display, so
      // alpha = 0.
      this.droppedSteps += rawN - MAX_CATCHUP_STEPS;
      if (this.isM2) this.droppedInputSteps += rawN - MAX_CATCHUP_STEPS;
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
    } else {
      this.lastAlpha = clamp01((targetSim - this.simTime) / this.dt);
    }
    // A switch changed the time scale — the clock is re-anchored here (no jump).
    if (this.modes.active && this.modes.timeScale() !== this.anchorScale) {
      this.anchorScale = this.modes.timeScale();
      this.anchor = { wall: t, simTime: this.simTime };
      this.lastAlpha = 0;
    }
    this.onFrame?.();
  }

  /** One fixed M1 step (with module isolation). */
  private stepOnce(): boolean {
    // Scene loads/unloads requested by the host apply here too.
    if (!this.applySceneOps()) return true;
    // A scene transition's arrival once its scene is loaded.
    if (this.pendingArrival !== null && !this.runArrival(this.stepIndex + 1)) return false;
    // A loaded save's placement once its scenes are in.
    if (this.pendingRestore !== null && !this.runRestorePlace(this.stepIndex + 1)) return false;
    // A restart asked for, then the game mode's step start.
    if (this.pendingRestart && !this.restartRun(this.stepIndex + 1)) return false;
    if (this.pendingListedScene !== null) this.goToListedScene();
    this.modes.beginStep(this.stepIndex + 1);
    this.grid.beginStep(this.stepIndex + 1);
    this.materials.beginStep(this.stepIndex + 1);
    // Copy curr before the step; restore it if any module throws
    // (no partial module application). Into the reused step
    // buffer `prev` does not hold (as the M2 step does) — a 3D scene plays on
    // this path, and a fresh copy per step would be ~0.5 KiB of garbage per
    // entity per step.
    const backupMirror = this.stepMirrors[this.stepMirrors[0].map === this.prev ? 1 : 0];
    backupMirror.copyFrom(this.curr, this.currShape);
    const backup = backupMirror.map;
    let failed = false;
    // The module receives the 1-based ordinal of the step being executed:
    // the step completes the stepIndex it is called with
    // ("curr := step(curr, stepIndex); stepIndex++") — the demo's exact
    // points (x0+A at stepIndex 119 under its `(stepIndex + 1)` offset) pin
    // this ordinal semantics. The SimState view still carries completed
    // steps (stepIndex = completed steps at call time;
    // simTime = stepIndex / fixedStepHz).
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
      // Registration order (each module in registration order).
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
      // subsequent step until disposed.
      this.curr = cloneCurr(backup);
      return true;
    }
    // A 2D-plane plain step runs the generic primitives (patrols walk; no physics world for their probes).
    if (this.physics3d === undefined && !this.modes.physicsHeld) this.blocks?.stepPrimitivesOnly(stepOrdinal);
    // A respawn places the character (a plain step has no intent phase).
    if (this.physics3d !== undefined && this.pendingRespawn !== null) {
      const [x, y, z] = this.pendingRespawn;
      this.pendingRespawn = null;
      try {
        this.placeCharacter3D(x, y, z);
        // A spawn's yaw turns the character as it is placed.
        if (this.pendingFacing !== null) this.faceCharacter3D(this.pendingFacing);
        this.pendingFacing = null;
      } catch (e) {
        this.curr = cloneCurr(backup);
        this.failStopFromError(e, stepOrdinal);
        return false;
      }
    }
    if (this.physics3d !== undefined && !this.modes.physicsHeld) {
      // A 3D game steps its physics in a plain (scene-mode) step
      // too — its character falls and rests under the runtime's 3D phase
      // even without a controller module. The 2D plane's scene mode has no
      // physics step.
      // Movers advance and are posed (script-driven colliders too), then after physics
      // the triggers test the player (a scene has no run state: always "playing").
      if (this.scriptCollidersDirty && !this.syncScriptColliders3D()) {
        this.curr = cloneCurr(backup);
        return false;
      }
      try {
        this.raycastsThisStep = 0;
        this.blocks?.beforeStep(stepOrdinal);
        this.runPhysicsPhase3D(this.physics3d);
        this.blocks?.afterPhysics(neutralFrame(stepOrdinal - 1));
      } catch (e) {
        this.curr = cloneCurr(backup);
        this.failStopFromError(e, stepOrdinal);
        return false;
      }
    }
    // The timelines (no input frame in a plain step: a wait key needs its timeout).
    if (this.timelines.active) this.timelines.step(stepOrdinal, null);
    // The camera brain resolves the view on the step's transforms.
    this.stepCameras(null);
    // Conversations advance (before the audio: a voice started now plays from this step).
    this.dialogue.endStep();
    // The environment blend advances with the step.
    this.environment.step();
    // The event → cue table plays the sounds of this step's signals and events.
    if (this.eventCues.length > 0) this.playEventCues();
    // Fades and clips advance; finished sounds are seen next step.
    this.audio.endStep();
    this.prev = backup; // prev := curr at the end of step n−1
    this.stepIndex += 1;
    this.simTime = this.stepIndex / this.hz; // single division
    this.stepAnimators();
    // Attached entities follow their nodes (posed by the animators just stepped).
    this.stepSockets(null);
    // Cells written after the physics phase collide from the next step.
    this.grid.flushCollision(this.physics3d);
    return true;
  }

  /**
   * One fixed M2 step. Returns `false` after a fail-stop, so the
   * caller stops the frame loop immediately.
   */
  private stepOnceM2(actionOverride?: ActionFrame): boolean {
    const stepIndex = this.stepIndex;
    const ordinal = stepIndex + 1; // the 1-based executed-step index (fixtures)
    // Scene unloads/loads take effect at the step boundary,
    // before the arrivals (a spawn may be in a scene that just loaded).
    if (!this.applySceneOps()) return false;
    // A scene transition's arrival once its scene is loaded.
    if (this.pendingArrival !== null && !this.runArrival(ordinal)) return false;
    // A loaded save's placement once its scenes are in.
    if (this.pendingRestore !== null && !this.runRestorePlace(ordinal)) return false;
    // The spawns and destroys the last step requested, in order.
    if (!this.applySpawnOps()) return false;
    this.spawnsThisStep = 0;
    this.spawnRefusalLogged = false;
    // A restart asked for last step, then the game mode's step start
    // (last step's events end; a script's switch applies now).
    if (this.pendingRestart && !this.restartRun(ordinal)) return false;
    if (this.pendingListedScene !== null) this.goToListedScene();
    // A 2D-plane respawn (ctx.lifecycle, a restart's placement) places the character at the boundary.
    if (this.physics3d === undefined && this.pendingRespawn !== null && !this.runRespawn2D(ordinal)) return false;
    this.modes.beginStep(ordinal);
    if (this.stepSceneOps.length > 0) this.stepSceneOps = [];
    this.grid.beginStep(ordinal);
    this.materials.beginStep(ordinal);
    this.saves.beginStep();
    let action: ActionFrame;
    if (actionOverride !== undefined) {
      action = actionOverride;
      this.debugCommands.clearStep();
      this.ui.deliver(undefined);
      this.dialogue.deliver(undefined);
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
    // The actions of input maps the game mode does not activate read as released
    // (the sampled frame stays the recorded input).
    if (this.modes.active) action = this.modes.mask(action, this.characterActionNames);
    // Movers advance (and are posed for physics), a pending bounce
    // reaches the controller; down + jump on a one-way platform drops through.
    this.raycastsThisStep = 0;
    // The colliders scripts drive become kinematic bodies before they are first posed.
    if (this.physics3d !== undefined && this.scriptCollidersDirty && !this.syncScriptColliders3D()) return false;
    // A game mode may hold physics (the controller, physics, movers and triggers stand still).
    const held = this.modes.physicsHeld;
    if (!held) this.blocks?.beforeStep(ordinal);
    this.stepFacing = null;
    // The character's jump action (its controller's jumpAction; frame version 2 has no jump channel).
    const jumpName = this.characterActions.jump;
    if (
      actionPhase(action, jumpName) === 'pressed' &&
      (action.actions?.['navigate']?.y ?? 0) < -0.5 &&
      this.blocks?.isOneWay(this.lastCharacterResult?.groundEntityId ?? null) === true
    ) {
      this.physics?.dropThrough?.(this.timing.dropThroughSteps);
      action = { ...action, actions: { ...action.actions, [jumpName]: { v: 0, p: 'none' } } };
    }
    // The pre-step copy goes into the reused buffer `prev` does not hold.
    const backupMirror = this.stepMirrors[this.stepMirrors[0].map === this.prev ? 1 : 0];
    backupMirror.copyFrom(this.curr, this.currShape);
    const backup = backupMirror.map;
    // `ctx.entity(id).get('transform')` reads the step-start transforms; the hidden set's step-start copy starts over.
    this.stepStart = backup;
    this.blocks?.beginScriptStep();
    if (this.staged.size > 0) this.staged.clear();
    this.currentPhase = undefined;
    this.currentModuleId = undefined;
    // The intent set is cleared at the start of every fixed step.
    // Reset in place (the committed writes are frozen copies, never handed out mutable).
    resetMutableIntents(this.intents, stepIndex);
    this.intentsVersion += 1;
    try {
      this.runPhase('intent', action);
      // A respawn (ctx.lifecycle, a restart) places the character unless a script placed it this step.
      if (this.physics3d !== undefined && this.pendingRespawn !== null) {
        if (this.intents.characterPlace === null) {
          const [x, y, z] = this.pendingRespawn;
          this.intents.characterPlace = { x, y, z };
          this.intentsVersion += 1;
          // A spawn's yaw turns the character as it is placed.
          if (this.pendingFacing !== null) {
            this.stepFacing = this.pendingFacing;
            this.faceCharacter3D(this.pendingFacing);
          }
        }
        this.pendingRespawn = null;
        this.pendingFacing = null;
      }
      // A script's character_place takes effect before the controller runs.
      if (this.physics3d !== undefined && this.intents.characterPlace !== null) this.applyCharacterPlace3D();
      // On the 2D plane too — the 2D placement of arrivals and respawns (from rest, the controller reset),
      // before the controller runs; a respawn asked for in this step gives way to it (as in 3D).
      if (this.physics3d === undefined && this.intents.characterPlace !== null) {
        this.pendingRespawn = null;
        this.pendingFacing = null;
        this.placeCharacter2D(this.intents.characterPlace.x, this.intents.characterPlace.y, ordinal);
      }
      if (!held) {
        this.runPhase('controller', action);
        // The impulses reached the controller (a held step keeps them for the next one).
        if (this.impulseAcc !== null) {
          this.impulseAcc = null;
          this.intentsVersion += 1;
        }
        this.runPhysicsPhase();
      }
      this.runPhase('transform', action);
      // After the transform phase the blocks test the character (triggers,
      // switches, the primitives; not while a game mode holds physics).
      if (!held) this.blocks?.afterPhysics(action);
    } catch (e) {
      this.failStopFromError(e, stepIndex);
      return false;
    }
    // The component writes scripts queued in this step, in script order.
    this.entityAccess.applyQueued();
    if (this.stateName === 'failed') return false;
    // The timelines, after every script phase and before the camera brain (on this step's input frame).
    if (this.timelines.active) {
      try {
        this.timelines.step(ordinal, action);
      } catch (e) {
        this.failStopFromError(e, stepIndex);
        return false;
      }
    }
    // The camera brain, after every phase (the camera phase included):
    // the view is resolved in the step, so replays and the worker resolve it alike.
    this.stepCameras(action);
    // Conversations advance: the frame's dialogue inputs and the scripts' calls apply, the view model follows.
    this.dialogue.endStep();
    // The environment blend advances with the step.
    this.environment.step();
    // Saves asked for this step are assembled, loaded ones restored (a step boundary).
    this.saves.endStep();
    // The event → cue table plays the sounds of this step's signals and events.
    if (this.eventCues.length > 0) this.playEventCues();
    // Fades and clips advance; finished sounds are seen next step.
    this.audio.endStep();
    // The step-end promotion (`state.prev` during step n holds the state at
    // the end of step n−2): `prev := backup`
    // below, where `backup` is the pre-step `curr` — the post-reset `curr`
    // when a reset wrote at this step's boundary (the no-streak mechanism).
    this.prev = backup;
    this.stepIndex += 1;
    this.simTime = this.stepIndex / this.hz;
    // Cells written after the physics phase collide from the next step.
    this.grid.flushCollision(this.physics3d);
    this.committedMirror.copyFrom(this.curr, this.currShape);
    this.committed = this.committedMirror.map;
    this.stepAnimators();
    // Attached entities follow their nodes (posed by the animators just stepped); the committed copy too.
    this.stepSockets(this.committed);
    // The step's scene requests commit with it.
    if (this.stepSceneOps.length > 0) {
      for (const op of this.stepSceneOps) this.enqueueSceneOp(op);
      this.stepSceneOps = [];
    }
    return true;
  }

  /** `ctx.ui` for one phase (the UI events are read in the intent phase only, once per step). */
  private uiControlFor(phase: SimulationPhase): BehaviorUi {
    let c = this.uiControls.get(phase);
    if (c !== undefined) return c;
    const ui = this.ui;
    const none: readonly UiEventRecord[] = Object.freeze([]);
    const events = (): readonly UiEventRecord[] => (phase === 'intent' ? ui.events() : none);
    c = Object.freeze({
      set: (path: string, value: unknown): boolean => ui.set(path, value),
      get: (path: string): unknown => ui.get(path),
      clear: (path: string): boolean => ui.clear(path),
      show: (docId: string, options?: { layer?: number; modal?: boolean }): boolean => ui.show(docId, options),
      hide: (docId: string): boolean => ui.hide(docId),
      isShown: (docId: string): boolean => ui.isShown(docId),
      play: (docId: string, tween: string, widgetId?: string): boolean => ui.command('play', docId, tween, widgetId),
      focus: (docId: string, widgetId: string): boolean => ui.command('focus', docId, widgetId, undefined),
      events,
      event: (name: string): UiEventRecord | null => events().find((e) => e.name === name) ?? null,
    });
    this.uiControls.set(phase, c);
    return c;
  }

  /** Queue a UI event for the next sampled step (see `Runtime.queueUiEvent`). */
  queueUiEvent(event: UiEventRecord): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    const checked = validateUiEvent(event);
    if (!checked.ok) return { ok: false, error: fail('game_command_invalid', `UI event: ${checked.message}`, { reason: 'ui_event', path: `/${checked.field}` }) };
    if ((checked.event.kind === 'show' || checked.event.kind === 'hide' || checked.event.kind === 'toggle') && !this.ui.hasDocument(checked.event.doc)) {
      return { ok: false, error: fail('game_command_invalid', `no UI document "${checked.event.doc}"`, { reason: 'ui_event' }) };
    }
    if (this.uiQueue.length >= MAX_FRAME_UI_EVENTS * 4) return { ok: false, error: fail('game_command_invalid', `at most ${MAX_FRAME_UI_EVENTS * 4} UI events may wait for the next step`, { reason: 'pending' }) };
    this.uiQueue.push(checked.event);
    return { ok: true };
  }

  /**
   * Queue a dialogue input (advance, choose, skip, auto,
   * backlog — the dialogue UI's buttons) for the next sampled step; it rides
   * on that step's input frame (`ActionFrame.dialogue`), so a recording
   * replays it and the worker applies it at the same step.
   */
  queueDialogueInput(input: DialogueInputRecord): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    if (!this.dialogue.enabled) return { ok: false, error: fail('game_command_invalid', 'this game has no conversations', { reason: 'dialogue' }) };
    const checked = validateDialogueInput(input);
    if (!checked.ok) return { ok: false, error: fail('game_command_invalid', `dialogue input: ${checked.message}`, { reason: 'dialogue', path: `/${checked.field}` }) };
    if (this.dialogueQueue.length >= DIALOGUE_FRAME_INPUTS * 4) return { ok: false, error: fail('game_command_invalid', `at most ${DIALOGUE_FRAME_INPUTS * 4} dialogue inputs may wait for the next step`, { reason: 'pending' }) };
    this.dialogueQueue.push(checked.input);
    return { ok: true };
  }

  /** The dialogue runner's state as digest text (null while nothing used dialogue). */
  dialogueState(): string | null {
    return this.dialogue.digestText();
  }

  /** The conversation now, for observers (null while nothing used dialogue). */
  dialogueView(): Record<string, unknown> | null {
    return this.dialogue.observe();
  }

  /** The UI changes since the host last took them. */
  takeUiOutput(): UiOutput | null {
    return this.ui.takeOutput();
  }

  /** The committed view model and shown documents. */
  uiView(): UiStateView {
    return this.ui.view();
  }

  // ---- Game modes and the run lifecycle -------------------------------

  /** The game modes as of the last step (null without modes). */
  modeView(): ModeView | null {
    return this.modes.active ? this.modes.view() : null;
  }

  /** The behavior groups of entities that came in. */
  private noteBehaviorGroups(entities: readonly EntityV3[]): void {
    for (const e of entities) {
      const g = (e.components as { behaviorGroup?: { group?: unknown } }).behaviorGroup?.group;
      if (typeof g === 'string') this.behaviorGroupOf.set(e.id, g);
    }
  }

  /**
   * `StepContext.behaviorTicks`: whether an entity's behavior runs this step
   * (undefined — every behavior runs — without modes or while the mode ticks
   * every group; one function per runtime).
   */
  private behaviorTicks(): ((entityId: string) => boolean) | undefined {
    // A switched-off object's scripts do not tick.
    const off = this.entityAccess.inactive();
    if (!this.modes.active || this.modes.ticksAll) {
      if (off.size === 0) return undefined;
      if (this.behaviorTicksOff === null || this.behaviorTicksOff.set !== off) this.behaviorTicksOff = { set: off, fn: (entityId: string): boolean => !off.has(entityId) };
      return this.behaviorTicksOff.fn;
    }
    if (this.behaviorTicksFn === undefined) this.behaviorTicksFn = (entityId: string): boolean => !this.entityAccess.inactive().has(entityId) && this.modes.ticks(this.behaviorGroupOf.get(entityId));
    return this.behaviorTicksFn;
  }
  private behaviorTicksOff: { set: ReadonlySet<string>; fn: (entityId: string) => boolean } | null = null;

  /** `ctx.modes` for one phase (the enter/exit events are read in the intent phase only, once per step). */
  private modeControlFor(phase: SimulationPhase): import('./types').BehaviorModes {
    let c = this.modeControls.get(phase);
    if (c !== undefined) return c;
    const modes = this.modes;
    const none: readonly import('./modes').ModeEventRecord[] = Object.freeze([]);
    const events = (): readonly import('./modes').ModeEventRecord[] => (phase === 'intent' ? modes.events(this.stepIndex + 1) : none);
    c = Object.freeze({
      current: (): string => modes.current ?? '',
      previous: (): string => modes.previous ?? '',
      is: (modeId: string): boolean => modes.current !== null && modes.current === modeId,
      switch: (modeId: string, transition?: import('./types').BehaviorModeTransition): boolean => modes.request(modeId, transition),
      events,
      entered: (modeId?: string): boolean => events().some((e) => e.kind === 'enter' && (modeId === undefined || modeId === '' || e.mode === modeId)),
      exited: (modeId?: string): boolean => events().some((e) => e.kind === 'exit' && (modeId === undefined || modeId === '' || e.mode === modeId)),
      time: (): number => modes.secondsIn(this.stepIndex + 1),
    });
    this.modeControls.set(phase, c);
    return c;
  }

  /** The player spawns loaded now, in entity order. */
  private playerSpawnIds(): string[] {
    const out: string[] = [];
    for (const id of this.order) if (this.entities.get(id)?.componentKinds?.includes('playerSpawn') === true) out.push(id);
    return out;
  }

  /** Where a respawn puts the character: the spawn's position, else where the player started (null: no character). */
  private respawnTarget(spawnId: string | null): [number, number, number] | null {
    const id = spawnId ?? this.activeSpawn ?? this.playerSpawnIds()[0] ?? null;
    const t = id !== null ? this.curr.get(id) : undefined;
    if (t !== undefined) return [t.position[0], t.position[1], t.position[2]];
    const player = this.controllerEntityId !== undefined ? this.entities.get(this.controllerEntityId) : undefined;
    return player === undefined ? null : [player.transform.position[0], player.transform.position[1], player.transform.position[2]];
  }

  /** `ctx.lifecycle`: respawn (both dimensions), the spawn point and the restart. */
  private buildLifecycleControl(): import('./types').BehaviorLifecycle {
    const spawnOk = (id: unknown): id is string => typeof id === 'string' && this.entities.get(id)?.componentKinds?.includes('playerSpawn') === true;
    return Object.freeze({
      respawn: (spawnId?: string): boolean => {
        if (this.controllerEntityId === undefined) return false;
        if (spawnId !== undefined && spawnId !== '' && !spawnOk(spawnId)) return false;
        if (spawnId !== undefined && spawnId !== '') this.activeSpawn = spawnId;
        const target = this.respawnTarget(null);
        if (target === null) return false;
        this.pendingRespawn = target;
        return true;
      },
      setSpawn: (spawnId: string): boolean => {
        if (!spawnOk(spawnId)) return false;
        this.activeSpawn = spawnId;
        return true;
      },
      spawnPoint: (): string => this.activeSpawn ?? this.playerSpawnIds()[0] ?? '',
      restart: (): boolean => {
        this.pendingRestart = true;
        return true;
      },
    });
  }

  /** The start's injected variables into ctx.save (at the start and at every restart). */
  private applyStartVariables(): void {
    if (this.startVariables !== undefined) for (const [k, v] of Object.entries(this.startVariables)) this.saveControl.set(k, v);
  }

  /**
   * Restart the run, at
   * a step boundary: the start scenes (later loads unloaded, spawned copies
   * gone), every object at its authored transform, the scripts started over
   * (their reset hook, as a replay), cameras, animators, sockets, blocks,
   * cells, material values, the UI and the start mode as at the start, the
   * character placed where it started (from rest). `ctx.save` values stay (as
   * across a replay), except that the start's variables are set again.
   * Returns false after a fail-stop.
   */
  private restartRun(ordinal: number): boolean {
    this.pendingRestart = false;
    // Every start begins with the start's variables (other ctx.save values stay, as across a replay).
    this.applyStartVariables();
    // A new run — its steps count from here (tools compare a run with its replay by run step).
    this.runStartStep = ordinal - 1;
    this.listedScene = null;
    this.pendingRestore = null;
    // scripts' impulses and a spawn facing do not outlive the run.
    this.impulseAcc = null;
    this.pendingFacing = null;
    this.clearSpawned();
    this.runSpawnBase = this.spawnSerial;
    if (!this.restoreStartSet()) return false;
    for (const [id, data] of this.entities) {
      const t = this.curr.get(id);
      if (t === undefined) continue;
      for (let k = 0; k < 3; k += 1) t.position[k] = data.transform.position[k]!;
      for (let k = 0; k < 4; k += 1) t.rotation[k] = data.transform.rotation[k]!;
      for (let k = 0; k < 3; k += 1) t.scale[k] = data.transform.scale[k]!;
    }
    this.cameras.reset();
    this.timelines.reset();
    this.cursorMode = null;
    this.resetAnimators();
    this.sockets.reset();
    this.settleSockets();
    this.blocks?.resetRun();
    // Every field scripts wrote back as authored (switched-off objects come back, colliders included).
    this.entityAccess.reset();
    this.grid.reset();
    this.grid.flushCollision(this.physics3d);
    this.materials.reset();
    this.ui.resetRun();
    this.modes.beginRun(ordinal);
    this.activeSpawn = null;
    const player = this.controllerEntityId !== undefined ? this.entities.get(this.controllerEntityId) : undefined;
    const start: Vec2 = player === undefined ? { x: 0, y: 0 } : { x: player.transform.position[0], y: player.transform.position[1] };
    for (const entry of this.entries) {
      if (!entry.phased) continue;
      const instance = entry.instance as SimulationPhaseModule;
      if (typeof instance.reset !== 'function') continue;
      this.currentModuleId = entry.id;
      try {
        instance.reset(this.buildResetContext('replay', ordinal, start, new Set(entry.owners)));
      } catch (e) {
        this.failStopFromError(e, this.stepIndex);
        return false;
      }
    }
    // The character from rest where it started (its controller module sees the placement in the next intent phase).
    if (this.physics3d !== undefined && player !== undefined) {
      const p = player.transform.position;
      try {
        this.placeCharacter3D(p[0], p[1], p[2]);
      } catch (e) {
        this.failStopFromError(e, this.stepIndex);
        return false;
      }
      this.pendingRespawn = [p[0], p[1], p[2]];
    } else if (player !== undefined && this.resetPort() !== null) {
      // The 2D-plane character too (else its port keeps the previous place and the next controller step fails its check).
      try {
        this.placeCharacter2D(start.x, start.y, ordinal);
      } catch (e) {
        this.failStopFromError(e, this.stepIndex);
        return false;
      }
    }
    // No render streak: prev := curr for the restarted state.
    const prevMirror = this.stepMirrors[this.stepMirrors[1].map === this.prev ? 1 : 0];
    prevMirror.copyFrom(this.curr, this.currShape);
    this.prev = prevMirror.map;
    return true;
  }

  // ---- Scene transitions -------------------------------------------------

  /**
   * A trigger's scene transition (the character entered it): its unloads and
   * its load are queued like `ctx.scenes` calls, and the character moves to
   * the spawn once the scene is loaded, at the next step boundary after the
   * load (`runArrival`).
   */
  private beginSceneTransition(triggerId: string, t: SceneTransitionRequest): void {
    // The unloads wait for the scene (they leave in the step it arrives), so the view is never empty.
    const unload: string[] = [];
    for (const sceneId of t.unload) {
      const problem = sceneId === t.scene ? `it unloads the scene it loads (${JSON.stringify(sceneId)})` : this.sceneOpProblem('unload', sceneId);
      if (problem !== null) {
        this.recordError({ code: 'scene_invalid', message: clipMessage(`scene transition "${triggerId}": ${problem}`), stepIndex: this.stepIndex, reason: 'unload' });
        continue;
      }
      unload.push(sceneId);
    }
    const problem = this.sceneOpProblem('load', t.scene);
    if (problem !== null) {
      this.recordError({ code: 'scene_invalid', message: clipMessage(`scene transition "${triggerId}": ${problem}`), stepIndex: this.stepIndex, reason: 'load' });
      // Nothing to wait for: the unloads go as before.
      for (const sceneId of unload) this.enqueueSceneOp({ op: 'unload', sceneId });
      return;
    }
    const fade = t.fade !== undefined && Number.isFinite(t.fade) ? Math.max(0, Math.min(MAX_TRANSITION_FADE, t.fade)) : 0;
    const color = t.fadeColor !== undefined && FADE_COLOR_RE.test(t.fadeColor) ? t.fadeColor : '#000000';
    this.enqueueSceneOp({ op: 'load', sceneId: t.scene, transition: Object.freeze({ unload: Object.freeze(unload), fade, color }) });
    if (t.spawn === null) return;
    this.pendingArrival = { spawnId: t.spawn, waitFor: t.scene };
  }

  /**
   * Move to an entry of the shell's scene list (a `scene` UI
   * event, at a step boundary): the previous listed scene is unloaded unless
   * it is a start scene or the same scene; the entry's scene is loaded when
   * it is not; the character moves to the entry's spawn once it is (as a
   * trigger's scene transition). At a new run the run is at the first entry
   * whose scene is a start scene (else none).
   */
  private goToListedScene(): void {
    const index = this.pendingListedScene!;
    this.pendingListedScene = null;
    const entry = Number.isInteger(index) ? this.sceneList[index] : undefined;
    if (entry === undefined) {
      this.recordError({ code: 'scene_invalid', message: clipMessage(`the scene list has no entry ${String(index)}`), stepIndex: this.stepIndex, reason: 'load' });
      return;
    }
    if (this.listedScene === null) this.listedScene = this.sceneList.findIndex((x) => this.startBatchSource.has(x.scene));
    const prev = this.listedScene >= 0 ? this.sceneList[this.listedScene] : undefined;
    this.listedScene = index;
    const unload = prev !== undefined && prev.scene !== entry.scene && !this.startBatchSource.has(prev.scene) && this.batches.has(prev.scene) ? [prev.scene] : [];
    if (!this.batches.has(entry.scene) && this.sceneStatus.get(entry.scene) !== 'loading') {
      this.beginSceneTransition(`scene list ${index}`, { scene: entry.scene, spawn: entry.spawn ?? null, unload, ...(entry.fade !== undefined ? { fade: entry.fade } : {}), ...(entry.fadeColor !== undefined ? { fadeColor: entry.fadeColor } : {}) });
      return;
    }
    for (const sceneId of unload) {
      const problem = this.sceneOpProblem('unload', sceneId);
      if (problem === null) this.enqueueSceneOp({ op: 'unload', sceneId });
    }
    if (entry.spawn !== undefined) this.pendingArrival = { spawnId: entry.spawn, waitFor: entry.scene };
  }

  /** The shell's scene list entry the run is at (-1: none). */
  listedSceneIndex(): number {
    return this.listedScene ?? this.sceneList.findIndex((x) => this.startBatchSource.has(x.scene));
  }

  /** The arrival of a scene transition, at a step boundary once its scene is loaded. Returns false after a fail-stop. */
  private runArrival(ordinal: number): boolean {
    const a = this.pendingArrival;
    if (a === null || this.sceneStatus.get(a.waitFor) === 'loading') return true;
    this.pendingArrival = null;
    const t = this.curr.get(a.spawnId);
    const spawn = this.entityDocument(a.spawnId);
    const marker = (spawn?.components as { playerSpawn?: { yaw?: unknown } } | undefined)?.playerSpawn;
    if (t === undefined || marker === undefined) {
      this.recordError({ code: 'scene_invalid', message: clipMessage(`scene transition spawn "${a.spawnId}" is not loaded; the character stays`), stepIndex: this.stepIndex, reason: 'transfer' });
      return true;
    }
    // The spawn becomes the one respawns use (ctx.lifecycle).
    this.activeSpawn = a.spawnId;
    const yaw = typeof marker.yaw === 'number' && Number.isFinite(marker.yaw) ? (marker.yaw * Math.PI) / 180 : null;
    const [x, y, z] = [t.position[0], t.position[1], t.position[2]];
    if (this.physics3d !== undefined) {
      this.pendingRespawn = [x, y, z];
      this.pendingFacing = yaw;
      return true;
    }
    try {
      this.placeCharacter2D(x, y, ordinal);
    } catch (e) {
      this.failStopFromError(e, this.stepIndex);
      return false;
    }
    if (yaw !== null && this.controllerEntityId !== undefined) this.blocks?.faceSpawn(this.controllerEntityId, yaw);
    return true;
  }

  // ---- Where the play stands in a save --------------------------------

  /** The loaded scenes, the active spawn, the scene list entry and the character with its velocity (m/s). */
  private captureWorld(): WorldSave {
    const id = this.controllerEntityId;
    const t = id !== undefined ? this.curr.get(id) : undefined;
    let character: WorldSave['character'] = null;
    if (t !== undefined) {
      const r = this.physics3d !== undefined ? this.lastCharacterResult3D?.applied : this.lastCharacterResult?.applied;
      const v = (n: number | undefined): number => {
        const x = (n ?? 0) * this.hz;
        return Number.isFinite(x) ? Math.max(-CHARACTER_IMPULSE_MAX, Math.min(CHARACTER_IMPULSE_MAX, x)) : 0;
      };
      const z = (r as { z?: number } | undefined)?.z;
      character = { position: [t.position[0], t.position[1], t.position[2]], velocity: [v(r?.x), v(r?.y), this.physics3d !== undefined ? v(z) : 0] };
    }
    return { scenes: [...this.batches.keys()], activeSpawn: this.activeSpawn, listedScene: this.listedSceneIndex(), character };
  }

  /** Why a saved world cannot be restored in this game (null: it can). */
  private worldProblem(world: WorldSave): string | null {
    if (this.sceneRows === null) return null;
    for (const sceneId of world.scenes) if (!this.sceneStatus.has(sceneId)) return `the save names scene "${sceneId}", which this game does not have`;
    if (world.listedScene >= this.sceneList.length) return `the save is at scene list entry ${world.listedScene}; the list has ${this.sceneList.length}`;
    return null;
  }

  /**
   * Restore where the play stood: scenes not in the save are unloaded (the
   * start set's pinned ones stay), the saved ones loaded; the spawn and the
   * scene list entry are the saved ones; the character is placed at its saved
   * position once the scenes are in (`runRestorePlace`) and gets its saved
   * velocity back (as an impulse for its next controller phase).
   */
  private applyWorld(world: WorldSave): void {
    if (this.sceneRows !== null) {
      const want = new Set(world.scenes);
      for (const sceneId of [...this.batches.keys()]) {
        if (want.has(sceneId) || this.sceneOpProblem('unload', sceneId) !== null) continue;
        this.enqueueSceneOp({ op: 'unload', sceneId });
      }
      for (const sceneId of world.scenes) if (!this.batches.has(sceneId) && this.sceneOpProblem('load', sceneId) === null) this.enqueueSceneOp({ op: 'load', sceneId });
    }
    this.activeSpawn = world.activeSpawn;
    this.listedScene = world.listedScene >= 0 ? world.listedScene : null;
    this.pendingArrival = null;
    this.pendingRestore = world.character === null || this.controllerEntityId === undefined ? null : { position: world.character.position, velocity: world.character.velocity, waitFor: [...world.scenes] };
  }

  /** A loaded save's placement at a step boundary once no scene it waits for is loading. Returns false after a fail-stop. */
  private runRestorePlace(ordinal: number): boolean {
    const r = this.pendingRestore;
    if (r === null || r.waitFor.some((sceneId) => this.sceneStatus.get(sceneId) === 'loading')) return true;
    this.pendingRestore = null;
    const [x, y, z] = r.position;
    if (this.physics3d !== undefined) {
      this.pendingRespawn = [x, y, z];
      this.pendingFacing = null;
    } else {
      try {
        this.placeCharacter2D(x, y, ordinal);
      } catch (e) {
        this.failStopFromError(e, this.stepIndex);
        return false;
      }
    }
    const [vx, vy, vz] = r.velocity;
    if (vx !== 0 || vy !== 0 || vz !== 0) this.impulseAcc = [vx, vy, this.physics3d !== undefined ? vz : 0];
    return true;
  }

  /**
   * A 2D-plane respawn (`ctx.lifecycle.respawn`, the respawn
   * intent) at the step boundary: the character is placed at the target from
   * rest (as an arrival). Returns false after a fail-stop.
   */
  private runRespawn2D(ordinal: number): boolean {
    const target = this.pendingRespawn;
    this.pendingRespawn = null;
    this.pendingFacing = null;
    if (target === null) return true;
    try {
      this.placeCharacter2D(target[0], target[1], ordinal);
    } catch (e) {
      this.failStopFromError(e, this.stepIndex);
      return false;
    }
    return true;
  }

  /** A loaded entity's document (its components), or undefined. */
  private entityDocument(id: string): EntityV3 | undefined {
    for (const b of this.batches.values()) {
      if (!b.ids.has(id)) continue;
      return b.entities.find((e) => e.id === id);
    }
    return this.spawnedEntities.get(id);
  }

  /**
   * Put the 2D-plane character at an origin, from rest: the
   * port's character is cleared and
   * placed, its transform set, and the controller module's windows and
   * velocity reset (its reset hook, as a transfer).
   */
  private placeCharacter2D(x: number, y: number, ordinal: number): void {
    const id = this.controllerEntityId;
    const port = this.resetPort();
    if (id === undefined || port === null) return;
    try {
      port.clearCharacterMotion();
      port.placeCharacter({ x, y });
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port placeCharacter() threw: ${messageOf(e)}`);
    }
    this.blocks?.placed(id);
    const t = this.curr.get(id);
    if (t !== undefined) {
      t.position[0] = x;
      t.position[1] = y;
    }
    const target: Vec2 = { x, y };
    for (const entry of this.entries) {
      if (!entry.phased || !entry.owners.includes(id)) continue;
      const instance = entry.instance as SimulationPhaseModule;
      if (typeof instance.reset !== 'function') continue;
      this.currentModuleId = entry.id;
      instance.reset(this.buildResetContext('transfer', ordinal, target, new Set(entry.owners)));
    }
  }

  /** Turn the 3D character to a yaw (radians about +Y) — its transform now, its controller with the placement. */
  private faceCharacter3D(yaw: number): void {
    const id = this.controllerEntityId;
    const t = id !== undefined ? this.curr.get(id) : undefined;
    if (t === undefined) return;
    t.rotation[0] = 0;
    t.rotation[1] = Math.sin(yaw / 2);
    t.rotation[2] = 0;
    t.rotation[3] = Math.cos(yaw / 2);
  }

  // ---- The event → cue table -----------------------------------------------

  /**
   * Play the cue of every table row a signal or event of this step matches
   * (and last step's animator clip events, which scripts see this step) —
   * each row at most once per step, in table order, through the audio intent
   * log (the host plays it; the simulation never reads it back).
   */
  private playEventCues(): void {
    const log = this.blocks?.takeCueLog() ?? null;
    const clips = this.animatorEvents;
    if (log === null && clips.length === 0) return;
    for (const c of this.eventCues) {
      let hit = false;
      if (c.on === 'signal') hit = log !== null && log.signals.includes(c.name);
      else {
        hit = log !== null && log.events.some((e) => e.name === c.name && (c.entity === undefined || e.entity === c.entity));
        if (!hit) hit = clips.some((e) => e.name === c.name && (c.entity === undefined || e.entityId === c.entity));
      }
      if (hit) this.audio.play(c.assetId, { volume: c.volume ?? 1, ...(c.bus !== undefined ? { bus: c.bus } : {}) });
    }
  }

  /** The look overrides now (object → emissive/tint), for the renderer. */
  entityLooks(): ReadonlyMap<string, import('./primitives').EntityLook> {
    return this.blocks?.primitives.looksView() ?? NO_LOOKS;
  }

  /** The timelines' screen overlay, plays and last events (null until a timeline played). */
  timelineView(): TimelineView | null {
    return this.timelines.view();
  }

  /** The timelines' state for the step digest (null until a timeline played). */
  timelineState(): string | null {
    return this.timelines.digestState();
  }

  /** What the sequencer drives — the runtime's own channels. */
  private buildTimelineHost(): import('./timeline').TimelineHost {
    const rt = this;
    const warn = (message: string): void => rt.recordBehaviorLog('thirdlight.runtime:timeline', 'warn', message);
    return {
      writeTransform: (id, pose) => {
        const t = rt.curr.get(id);
        if (t === undefined) return false;
        if (rt.physics3d !== undefined && id === rt.controllerEntityId && pose.position !== undefined && typeof rt.physics3d.placeCharacter === 'function') {
          // The 3D character's body moves with it (as a script's character_place does).
          rt.physics3d.placeCharacter({ x: pose.position[0], y: pose.position[1], z: pose.position[2] });
          rt.lastCharacterResult3D = undefined;
          rt.fallSpeed3d = 0;
        } else if (rt.physics3d === undefined && id === rt.controllerEntityId && pose.position !== undefined) {
          warn(`timeline: the 2D player "${id}" is moved by its physics body; a transform track does not move it`);
          return true;
        }
        if (pose.position !== undefined) for (let k = 0; k < 3; k += 1) t.position[k] = pose.position[k]!;
        if (pose.rotation !== undefined) for (let k = 0; k < 4; k += 1) t.rotation[k] = pose.rotation[k]!;
        if (pose.scale !== undefined) for (let k = 0; k < 3; k += 1) t.scale[k] = pose.scale[k]!;
        return true;
      },
      cameraOverride: (id, blend) => void rt.cameras.setTimelineOverride(id, blend ?? undefined),
      cameraProgress: (id, progress) => void rt.cameras.set(id, { progress }),
      cameraActivate: (id) => void rt.cameras.activate(id),
      animator: (id) => {
        const m = rt.animatorMachines.get(id)?.machine;
        if (m === undefined) return null;
        return { set: (name, value) => m.set(name, value), trigger: (name) => m.trigger(name), play: (state, fade, layer) => m.play(state, fade, layer) };
      },
      audio: {
        music: (assetId, fade) => rt.audio.music(assetId, fade),
        releaseMusic: (fade) => rt.audio.releaseMusic(fade),
        stinger: (assetId, volume) => rt.audio.stinger(assetId, volume !== undefined ? { volume } : undefined),
        play: (assetId, options) => rt.audio.play(assetId, options),
        stop: (handle, fade) => rt.audio.stop(handle, fade),
        playing: (handle) => rt.audio.playing(handle),
      },
      effects: {
        play: (effectId, options) => rt.effectsControl.play(effectId, options),
        stop: (handle) => rt.effectsControl.stop(handle),
      },
      setVisible: (id, visible) => {
        if (rt.curr.has(id)) rt.blocks?.setVisible(id, visible);
      },
      emitSignal: (name) => rt.signalControl.emit(name),
      signaled: (name) => rt.signalControl.on(name),
      setMaterial: (id, param, value, materialId) => rt.materials.api.set(id, param, value, materialId),
      // The same path as ctx.modes.switch (applies at the next step boundary).
      switchMode: (modeId, transition) => rt.modes.request(modeId, transition),
      // The environment track switches presets through ctx.environment's own path.
      environment: { apply: (presetId, blendSeconds) => rt.environment.api.set(presetId, blendSeconds > 0 ? { blend: blendSeconds } : {}) },
      // The dialogue track runs a node through the dialogue runner and waits while it runs.
      ...(rt.dialogue.enabled ? { dialogue: rt.dialogue.timelinePort() } : {}),
      warn,
    };
  }

  /** `ctx.timeline` (arguments checked by the system; requests apply at the end of the step). */
  private buildTimelineControl(): import('./types').BehaviorTimeline {
    const t = this.timelines;
    return Object.freeze({
      play: (timelineId: string, bindings?: Readonly<Record<string, string>>): number => t.play(timelineId, bindings),
      pause: (handle: number): boolean => t.pause(handle),
      resume: (handle: number): boolean => t.resume(handle),
      stop: (handle: number): boolean => t.stop(handle),
      skip: (handle: number): boolean => t.skip(handle),
      seek: (handle: number, seconds: number): boolean => t.seek(handle, seconds),
      state: (handle: number) => t.state(handle),
      time: (handle: number): number => t.time(handle),
      isPlaying: (timelineId: string): boolean => t.isPlaying(timelineId),
      events: () => t.events(),
      ended: (handle: number): boolean => t.events().some((e) => e.kind === 'ended' && e.handle === handle),
      marker: (name: string, handle?: number): boolean => t.events().some((e) => e.kind === 'marker' && e.name === name && (handle === undefined || handle === 0 || e.handle === handle)),
    });
  }

  private sampleAction(stepIndex: number): ActionFrame {
    let raw: unknown;
    try {
      raw = this.actions.sample(stepIndex);
    } catch (e) {
      throw new InputSourceError(messageOf(e));
    }
    // storage's queued answers ride on this step's frame too.
    if (this.saveQueue.length > 0 && typeof raw === 'object' && raw !== null) {
      const have = (raw as ActionFrame).saves ?? [];
      const room = Math.max(0, MAX_FRAME_SAVE_EVENTS - (Array.isArray(have) ? have.length : 0));
      if (room > 0) raw = { ...(raw as ActionFrame), saves: [...have, ...this.saveQueue.splice(0, room)] };
    }
    // Queued debug commands ride on this step's frame (so a recording keeps them).
    if (this.debugCommands.pending && typeof raw === 'object' && raw !== null) {
      const have = (raw as ActionFrame).commands ?? [];
      const room = Math.max(0, MAX_FRAME_COMMANDS - (Array.isArray(have) ? have.length : 0));
      if (room > 0) raw = { ...(raw as ActionFrame), commands: [...have, ...this.debugCommands.take(room)] };
    }
    // Queued UI events ride on this step's frame (so a recording keeps them).
    if (this.uiQueue.length > 0 && typeof raw === 'object' && raw !== null) {
      const have = (raw as ActionFrame).ui ?? [];
      const room = Math.max(0, MAX_FRAME_UI_EVENTS - (Array.isArray(have) ? have.length : 0));
      if (room > 0) raw = { ...(raw as ActionFrame), ui: [...have, ...this.uiQueue.splice(0, room)] };
    }
    // Queued dialogue inputs ride on this step's frame (so a recording keeps them).
    if (this.dialogueQueue.length > 0 && typeof raw === 'object' && raw !== null) {
      const have = (raw as ActionFrame).dialogue ?? [];
      const room = Math.max(0, DIALOGUE_FRAME_INPUTS - (Array.isArray(have) ? have.length : 0));
      if (room > 0) raw = { ...(raw as ActionFrame), dialogue: [...have, ...this.dialogueQueue.splice(0, room)] };
    }
    // Equal action values of the last frame are shared (immutable).
    const check = validateActionFrame(raw, stepIndex, this.lastInputFrame ?? undefined);
    if (!check.ok) throw new InputFrameError(check.field, check.message);
    this.lastInputFrame = check.frame;
    this.inputSamples += 1;
    this.debugCommands.deliver(check.frame);
    // storage's answers (the slot list, outcomes, a loaded document).
    if (check.frame.saves !== undefined) this.saves.deliver(check.frame.saves);
    // The host's input status (device, bindings, rebind events).
    this.inputStatus.apply(check.frame.input);
    // The frame's show/hide entries apply before any script runs.
    this.ui.deliver(check.frame.ui);
    // The frame's dialogue inputs (applied at the end of the step).
    this.dialogue.deliver(check.frame.dialogue);
    // A mode action switches now (before the scripts); a restart applies at the next boundary.
    if (check.frame.ui !== undefined) {
      this.modes.deliver(check.frame.ui, stepIndex + 1);
      if (check.frame.ui.some((e) => e.kind === 'restart')) this.pendingRestart = true;
      // A move along the shell's scene list applies at the next boundary (after a restart of the same frame).
      for (const e of check.frame.ui) if (e.kind === 'scene' && typeof e.value === 'number') this.pendingListedScene = e.value;
    }
    return this.withHeldPointer(check.frame);
  }

  /**
   * The frame modules see carries the complete pointer state —
   * the sample's own values, or (a frame without a sample) the last
   * position, buttons and over/locked state with no movement — and its edges:
   * a button pressed/released when the held mask changed (or the sample says
   * so: a click between two samples), `entered`/`left` when `over` changed.
   * Before the first sample there is no pointer (the frame is unchanged, so
   * every recorded replay without pointer samples plays exactly as before).
   */
  private withHeldPointer(frame: ActionFrame): ActionFrame {
    const sample = frame.pointer;
    const prev = this.heldPointer;
    if (sample === undefined && prev === null) return frame;
    const prevButtons = prev?.buttons ?? 0;
    const prevOver = prev === null ? false : prev.over !== false;
    let next: HeldPointer;
    if (sample === undefined) {
      const p = prev!;
      // No new sample: the same state without this step's movement and edges (reused when it had none).
      if (p.dx === undefined && p.dy === undefined && p.wheel === undefined && p.pressed === undefined && p.released === undefined && p.entered === undefined && p.left === undefined) return { ...frame, pointer: p };
      next = { x: p.x, y: p.y, buttons: prevButtons, over: prevOver, locked: p.locked === true, ...(p.overUi === true ? { overUi: true } : {}) };
    } else {
      const buttons = sample.buttons ?? 0;
      const over = sample.over !== false;
      const pressed = (sample.pressed ?? 0) | (buttons & ~prevButtons);
      const released = (sample.released ?? 0) | (prevButtons & ~buttons);
      next = {
        x: sample.x,
        y: sample.y,
        buttons,
        over,
        locked: sample.locked === true,
        // Over a UI element (absent false, so every recording without it is unchanged).
        ...(sample.overUi === true ? { overUi: true } : {}),
        ...(sample.dx !== undefined && sample.dx !== 0 ? { dx: sample.dx } : {}),
        ...(sample.dy !== undefined && sample.dy !== 0 ? { dy: sample.dy } : {}),
        ...(sample.wheel !== undefined && sample.wheel !== 0 ? { wheel: sample.wheel } : {}),
        ...(pressed !== 0 ? { pressed } : {}),
        ...(released !== 0 ? { released } : {}),
        ...(over && !prevOver ? { entered: true } : {}),
        ...(!over && prevOver ? { left: true } : {}),
      };
    }
    this.heldPointer = Object.freeze(next);
    return { ...frame, pointer: this.heldPointer };
  }

  /** The pointer state as of the last step (null before the first sample; observers, the host). */
  readPointer(): Readonly<HeldPointer> | null {
    return this.heldPointer;
  }

  /**
   * The cursor a script asked for (`ctx.input.setCursor`): 'free',
   * 'locked', or null — the active input map decides. Simulation state: a new
   * run starts with none.
   */
  cursorRequest(): 'free' | 'locked' | null {
    return this.cursorMode;
  }

  /** The binding requests scripts made since the last call (see `Runtime.takeBindingRequests`). */
  takeBindingRequests(): { readonly requests: readonly InputBindingRequest[]; readonly dropped: number } {
    return this.inputStatus.take();
  }

  /** The declared debug commands (the engine's `signal` first) and the calls run (newest last). */
  debugCommandState(): DebugCommandState {
    return this.debugCommands.state();
  }

  /** Queue a debug command call for the next sampled step (see `Runtime.queueDebugCommand`). */
  queueDebugCommand(call: DebugCommandCall): { ok: true } | { ok: false; error: RuntimeError } {
    if (this.stateName === 'disposed') return { ok: false, error: fail('runtime_disposed', 'runtime is disposed') };
    const r = this.debugCommands.enqueue(call);
    return r.ok ? r : { ok: false, error: fail('game_command_invalid', r.message, { reason: r.reason, ...(r.path !== undefined ? { path: r.path } : {}) }) };
  }

  /** Narrow the injected physics port to the reset/clearance surface (placing the 2D character). */
  private resetPort(): PhysicsResetPort | null {
    const port = this.physics as (PhysicsPort & Partial<PhysicsResetPort>) | undefined;
    if (port === undefined) return null;
    if (typeof port.clearCharacterMotion !== 'function') return null;
    if (typeof port.placeCharacter !== 'function') return null;
    if (typeof port.characterClearance !== 'function') return null;
    return port as PhysicsResetPort;
  }

  /** Build one `ModuleResetContext` (the character was placed). */
  private buildResetContext(
    reset: 'replay' | 'transfer',
    ordinal: number,
    target: Vec2,
    writableOwners: ReadonlySet<string>,
  ): ModuleResetContext {
    return Object.freeze({
      reason: reset,
      stepIndex: ordinal,
      playerCenter: Object.freeze({ ...target }),
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

  // ---- Scene set internals ------------------------------------------------

  private setSceneStatus(sceneId: string, status: SceneStatus): void {
    this.sceneStatus.set(sceneId, status);
    this.sceneSetCache = null;
  }

  /** Why a scene op cannot be requested (null: it can). */
  /** Why `requestScene(op, sceneId)` would be refused now (null: it would be accepted); changes nothing. */
  sceneRequestProblem(op: 'load' | 'unload', sceneId: string): string | null {
    if (this.stateName === 'disposed') return 'runtime is disposed';
    return this.sceneOpProblem(op, sceneId);
  }

  private sceneOpProblem(op: 'load' | 'unload', sceneId: unknown, options?: SceneLoadOptions): string | null {
    if (this.sceneRows === null) return 'this game has no scene catalog (a v4 project runs with one)';
    if (typeof sceneId !== 'string' || !this.sceneStatus.has(sceneId)) return `unknown scene ${JSON.stringify(String(sceneId))}`;
    if (op === 'load' && options !== undefined) {
      if (typeof options !== 'object' || options === null) return 'load options must be an object';
      const at = (options as { at?: unknown }).at;
      if (at !== undefined && !(Array.isArray(at) && at.length === 3 && at.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6))) {
        return 'load option "at" must be [x, y, z] (finite, |v| <= 1e6)';
      }
      // A transition's unloads and fade.
      const o = options as { unload?: unknown; fade?: unknown; fadeColor?: unknown };
      if (o.unload !== undefined) {
        if (!Array.isArray(o.unload) || o.unload.length > MAX_TRANSITION_UNLOADS || !o.unload.every((x) => typeof x === 'string')) return `load option "unload" must be up to ${MAX_TRANSITION_UNLOADS} scene ids`;
        for (const u of o.unload as string[]) {
          if (u === sceneId) return `load option "unload" names the scene it loads (${JSON.stringify(u)})`;
          const p = this.sceneOpProblem('unload', u);
          if (p !== null) return `load option "unload": ${p}`;
        }
      }
      if (o.fade !== undefined && !(typeof o.fade === 'number' && Number.isFinite(o.fade) && o.fade >= 0 && o.fade <= MAX_TRANSITION_FADE)) return `load option "fade" must be seconds (0–${MAX_TRANSITION_FADE})`;
      if (o.fadeColor !== undefined && !(typeof o.fadeColor === 'string' && FADE_COLOR_RE.test(o.fadeColor))) return 'load option "fadeColor" must be "#rrggbb" (lower case)';
    }
    if (op === 'unload') {
      const batch = this.batches.get(sceneId);
      if (batch !== undefined) {
        for (const id of batch.ids) {
          if (this.pinnedIds.has(id)) return `scene "${sceneId}" holds "${id}" (the camera, player and start spawn stay loaded)`;
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
        // A transition to a scene that is in: its unloads go now (nothing to wait for).
        for (const u of op.transition?.unload ?? []) if (u !== op.sceneId && this.sceneOpProblem('unload', u) === null) this.enqueueSceneOp({ op: 'unload', sceneId: u });
        return;
      }
      // A transition waits for its scene (a later one for the same scene replaces it).
      if (op.transition !== undefined) {
        const fadeSteps = Math.round(op.transition.fade * this.hz);
        this.transitions.set(op.sceneId, { ...op.transition, fadeSteps, outLeft: fadeSteps });
        this.loadingViewCache = null;
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
      this.preparedLoads.delete(op.sceneId);
      this.transitions.delete(op.sceneId);
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
        rt.stepSceneOps.push(rt.loadOp(sceneId, options));
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
      loading(): readonly string[] {
        return rt.sceneLoadingView().loading;
      },
      transition() {
        return rt.sceneLoadingView().transition;
      },
    });
  }

  /**
   * The step boundary for scenes: pending unloads, then fetched loads.
   * Returns `false` after a fail-stop (a module refused a loaded scene).
   */
  private applySceneOps(stepped = true): boolean {
    if (this.sceneRows === null) return true;
    if (this.pendingUnloads.size > 0) {
      for (const sceneId of this.pendingUnloads) this.removeBatch(sceneId);
      this.pendingUnloads.clear();
    }
    // Fade-outs advance one step per step (a paused game draws no fade: it is done at once).
    for (const t of this.transitions.values()) {
      if (t.outLeft === 0) continue;
      t.outLeft = stepped ? t.outLeft - 1 : 0;
      this.loadingViewCache = null;
    }
    if (this.readyLoads.size === 0) return true;
    const deadline = nowMs() + SCENE_PREP_BUDGET_MS;
    for (const [sceneId, entities] of [...this.readyLoads]) {
      // Copy and freeze its entities within the step's budget (a large scene over several steps).
      let prep = this.preparedLoads.get(sceneId);
      if (prep === undefined) this.preparedLoads.set(sceneId, (prep = { out: [], next: 0 }));
      while (prep.next < entities.length) {
        prep.out.push(deepFreeze(structuredClone(entities[prep.next]!)));
        prep.next += 1;
        if ((prep.next & 63) === 0 && nowMs() > deadline) break;
      }
      if (prep.next < entities.length) continue;
      const t = this.transitions.get(sceneId);
      if (t !== undefined && t.outLeft > 0) continue; // the view fades out first
      this.readyLoads.delete(sceneId);
      this.preparedLoads.delete(sceneId);
      const at = this.fetchingLoads.get(sceneId)?.at;
      this.fetchingLoads.delete(sceneId);
      // A transition's unloads leave in the step its scene arrives (never an empty world between).
      if (t !== undefined) {
        this.transitions.delete(sceneId);
        for (const u of t.unload) if (u !== sceneId && this.batches.has(u) && this.sceneOpProblem('unload', u) === null) this.removeBatch(u);
      }
      if (!this.addBatch(sceneId, offsetEntities(prep.out, at), false, at === undefined)) return false;
      if (t !== undefined) {
        this.lastSwap = { scene: sceneId, revision: this.sceneRevision, seconds: t.fade, color: t.color };
        this.loadingViewCache = null;
      }
    }
    return true;
  }

  /**
   * Add one scene. A scene that does not fit (duplicate ids, a start-only
   * entity, colliders without a capable port) is refused: logged, left
   * unloaded, the run continues. Returns `false` only after a fail-stop.
   */
  private addBatch(sceneId: string, entities: readonly EntityV3[], start: boolean, prepared = false): boolean {
    const refuse = (why: string): boolean => {
      this.setSceneStatus(sceneId, 'unloaded');
      this.recordError({ code: 'scene_load_failed', message: clipMessage(`scene "${sceneId}" was not loaded: ${why}`), stepIndex: this.stepIndex, reason: 'refused' });
      return true;
    };
    for (const e of entities) {
      if (this.entities.has(e.id)) return refuse(`entity "${e.id}" is already loaded`);
      const c = e.components as unknown as Record<string, unknown>;
      // Lights belong to their scene (any kind, any scene); the camera and the player stay start-scene only.
      if (!start && (c['camera'] !== undefined || c['controller'] !== undefined)) {
        return refuse(`entity "${e.id}" belongs in a start scene (camera, player)`);
      }
    }
    // A loaded scene's entities arrive copied and frozen (prepared over the steps before).
    const frozen = prepared ? Object.freeze([...entities]) : deepFreeze(entities.map((e) => structuredClone(e)));
    const contribution = sceneContribution(frozen);
    if (this.physics3d !== undefined && !this.addColliders3D(frozen, (why) => refuse(why), `scene "${sceneId}"`)) return false;
    if (contribution.colliders.length > 0 && this.physics !== undefined) {
      if (typeof this.physics.addStaticColliders !== 'function') return refuse('the physics port cannot add colliders');
      try {
        this.physics.addStaticColliders(contribution.colliders);
      } catch (e) {
        this.failStop('physics_port_error', 'scene_colliders', `adding the colliders of scene "${sceneId}" failed: ${messageOf(e)}`, this.stepIndex);
        return false;
      }
    }
    const ids = new Set(frozen.map((e) => e.id));
    this.attachEntities(frozen);
    // The scene's block layers and their colliders (at this step boundary).
    if (this.grid.addLayers(frozen).length > 0) {
      try {
        this.grid.flushCollision(this.physics3d);
      } catch (e) {
        this.failStop('physics_port_error', 'scene_colliders', `adding the block colliders of scene "${sceneId}" failed: ${messageOf(e)}`, this.stepIndex);
        return false;
      }
    }
    this.batches.set(sceneId, { sceneId, start, entities: frozen, ids, contribution });
    this.setSceneStatus(sceneId, 'loaded');
    this.sceneRevision += 1;
    return this.notifyLoaded(frozen);
  }

  /**
   * Put resolved, frozen entities into the simulation: state, draw order,
   * tags, animators and gameplay blocks (a loaded scene, a spawned copy).
   */
  private attachEntities(frozen: readonly EntityV3[]): void {
    this.materials.addEntities(frozen);
    for (const e of frozen) {
      const t = e.components.transform;
      const data: SimEntityData = { id: e.id, parentId: e.parentId ?? null, transform: cloneTransform(t) };
      if (e.name !== undefined) data.name = e.name;
      data.componentKinds = Object.freeze(Object.keys(e.components));
      const box = e.components.box;
      if (box) data.box = { size: [box.size[0], box.size[1], box.size[2]], material: { color: box.material.color } };
      if ((e.components as { collider?: unknown }).collider !== undefined) data.hasCollider = true;
      if (this.physics3d !== undefined && data.hasCollider === true && (e.components as { controller?: unknown }).controller === undefined) this.colliderComponents3D.set(e.id, e.components as unknown as Record<string, unknown>);
      this.entities.set(e.id, data);
      this.prev.set(e.id, cloneTransform(t));
      this.curr.set(e.id, cloneTransform(t));
      this.currShape += 1;
      this.committed?.set(e.id, cloneTransform(t));
    }
    this.order = [...this.order, ...frozen.map((e) => e.id)];
    this.entityCount = this.order.length;
    // Their behavior groups (game modes tick groups).
    this.noteBehaviorGroups(frozen);
    this.liveTags?.add(frozen as readonly { id: string; tags?: number }[]);
    this.addAnimators(frozen);
    this.blocks?.add(frozen);
    this.cameras.add(frozen);
    // Their models and authored sockets (resolved at the end of the step).
    this.sockets.add(frozen);
    // Children of a switched-off object arrive switched off.
    this.entityAccess.added();
  }

  /** Tell the phased modules (the behavior host) about attached entities. Returns false after a fail-stop. */
  private notifyLoaded(frozen: readonly EntityV3[]): boolean {
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
      if (!this.refreshOwners(entry)) return false;
    }
    return true;
  }

  /**
   * Re-read a module's transform owners after entities came or
   * went (a behavior that owns "@self" owns each carrier, spawned copies
   * included). A new owner gets the instantiate-time checks: claimed by no
   * other module, not the camera, not a physics body. Returns false after a
   * fail-stop.
   */
  private refreshOwners(entry: ModuleEntry): boolean {
    if (!entry.phased) return true;
    const next = (entry.instance as SimulationPhaseModule).transformOwners;
    if (next === entry.owners || !Array.isArray(next)) return true;
    const before = new Set(entry.owners);
    for (const id of next) {
      if (before.has(id)) continue;
      const other = this.entries.find((en) => en !== entry && en.owners.includes(id));
      if (other !== undefined) {
        this.failStop('transform_owner_conflict', id, `entity "${id}" is claimed by "${other.id}" and "${entry.id}"`, this.stepIndex, entry.id);
        return false;
      }
      const data = this.entities.get(id);
      // In 3D a script may drive a collider no mover moves (posed as a kinematic body).
      const drivable = this.physics3d !== undefined && scriptDrivableCollider(this.colliderComponents3D.get(id));
      const physicsBody = (data?.hasCollider === true && !drivable) || id === this.controllerEntityId;
      if (id === this.cameraInfo.id || (physicsBody && !entry.phases.includes('controller'))) {
        const what = id === this.cameraInfo.id ? 'camera' : 'physics_entity';
        this.failStop('transform_owner_forbidden', what, `module "${entry.id}" claims ${what === 'camera' ? 'the camera' : 'physics'} entity "${id}"`, this.stepIndex, entry.id, undefined, what);
        return false;
      }
    }
    entry.owners = [...next];
    this.scriptCollidersDirty = true;
    return true;
  }

  /** Take entities out of the simulation and release what belongs to them (`what` names them in diagnostics). */
  private detachEntities(ids: ReadonlySet<string>, colliderIds: readonly string[], what: string): void {
    // Sockets of (and on) these entities let go.
    this.sockets.remove(ids);
    this.materials.removeEntities(ids);
    for (const id of ids) {
      this.colliderComponents3D.delete(id);
      this.scriptColliders3D.delete(id);
      this.behaviorGroupOf.delete(id);
    }
    for (const entry of this.entries) {
      const instance = entry.instance as SimulationPhaseModule;
      if (!entry.phased || typeof instance.sceneUnloaded !== 'function') continue;
      try {
        instance.sceneUnloaded(ids);
      } catch (e) {
        this.recordError({ code: 'scene_load_failed', message: clipMessage(`module "${entry.id}" failed to release ${what}: ${messageOf(e)}`), stepIndex: this.stepIndex, reason: 'unload', moduleId: entry.id });
      }
      // Owners that left ("@self" carriers) are released.
      const owners = instance.transformOwners;
      if (Array.isArray(owners)) entry.owners = owners.filter((id) => !ids.has(id));
    }
    // Unloaded block layers take their chunk colliders along.
    const gridColliders = this.grid.removeLayers(ids);
    if (gridColliders.length > 0 && typeof this.physics3d?.removeStaticColliders === 'function') {
      try {
        this.physics3d.removeStaticColliders(gridColliders);
      } catch (e) {
        this.recordError({ code: 'scene_load_failed', message: clipMessage(`removing the block colliders of ${what} failed: ${messageOf(e)}`), stepIndex: this.stepIndex, reason: 'unload' });
      }
    }
    if (colliderIds.length > 0 && typeof this.physics3d?.removeStaticColliders === 'function') {
      try {
        this.physics3d.removeStaticColliders(colliderIds);
      } catch (e) {
        this.recordError({ code: 'scene_load_failed', message: clipMessage(`removing the colliders of ${what} failed: ${messageOf(e)}`), stepIndex: this.stepIndex, reason: 'unload' });
      }
    }
    if (colliderIds.length > 0 && typeof this.physics?.removeStaticColliders === 'function') {
      try {
        this.physics.removeStaticColliders(colliderIds);
      } catch (e) {
        this.recordError({ code: 'scene_load_failed', message: clipMessage(`removing the colliders of ${what} failed: ${messageOf(e)}`), stepIndex: this.stepIndex, reason: 'unload' });
      }
    }
    for (const id of ids) {
      this.entities.delete(id);
      this.prev.delete(id);
      this.curr.delete(id);
      this.currShape += 1;
      this.committed?.delete(id);
      this.intents.axes.delete(id);
    }
    this.order = this.order.filter((id) => !ids.has(id));
    this.entityCount = this.order.length;
    this.liveTags?.remove(ids);
    this.removeAnimators(ids);
    this.blocks?.remove(ids);
    this.cameras.remove(ids);
    // Their written fields go with them.
    this.entityAccess.removed(ids);
  }

  /** Remove one scene and release what belongs to it. */
  private removeBatch(sceneId: string): void {
    const batch = this.batches.get(sceneId);
    if (batch === undefined) return;
    const ids = batch.ids;
    this.detachEntities(ids, batch.contribution.colliders.map((c) => c.entityId), `scene "${sceneId}"`);
    // A pending arrival at a spawn of the unloaded scene is dropped.
    if (this.pendingArrival !== null && ids.has(this.pendingArrival.spawnId)) this.pendingArrival = null;
    this.batches.delete(sceneId);
    this.setSceneStatus(sceneId, 'unloaded');
    this.sceneRevision += 1;
  }

  // ---- Spawned prefab copies ------------------------------------

  /** `ctx.spawn` / `ctx.destroy`: requests queue with the step; ids are handed out at once. */
  private buildSpawnControl(): BehaviorSpawnControl {
    const rt = this;
    const refuse = (reason: string, message: string): never => {
      throw new BehaviorHostError('module_error', reason, message);
    };
    return Object.freeze({
      spawn(prefabId: string, options: { position: readonly number[]; rotation?: readonly number[]; scale?: number | readonly number[] }): string | null {
        const def = typeof prefabId === 'string' ? rt.prefabs.get(prefabId) : undefined;
        if (def === undefined) {
          const known = [...rt.prefabs.keys()].slice(0, 8).join(', ') || 'none in this game';
          return refuse('behavior_spawn_invalid', `ctx.spawn: unknown prefab ${JSON.stringify(String(prefabId))} (known: ${known})`);
        }
        const parsed = parseSpawnOptions(def, options);
        if (!parsed.ok) return refuse('behavior_spawn_invalid', `ctx.spawn("${def.prefabId}"): ${parsed.message}`);
        const live = rt.spawnedEntities.size + rt.reservedSpawnIds.size;
        if (rt.spawnsThisStep >= MAX_SPAWNS_PER_STEP || live + def.entities.length > MAX_LIVE_SPAWNED) {
          rt.logSpawnRefusal(rt.spawnsThisStep >= MAX_SPAWNS_PER_STEP
            ? `ctx.spawn("${def.prefabId}") refused: at most ${MAX_SPAWNS_PER_STEP} spawns per step`
            : `ctx.spawn("${def.prefabId}") refused: at most ${MAX_LIVE_SPAWNED} spawned entities alive (destroy some)`);
          return null;
        }
        rt.spawnsThisStep += 1;
        const ids = def.entities.map(() => rt.allocateSpawnId());
        rt.spawnOps.push({ op: 'spawn', entities: expandPrefab(def, ids, parsed.placement, rt.entityRefKeysOf) });
        return ids[0]!;
      },
      destroy(entityId: string): boolean {
        if (typeof entityId !== 'string') return refuse('behavior_destroy_invalid', 'ctx.destroy: entityId must be a string');
        if (rt.spawnedEntities.has(entityId) || rt.reservedSpawnIds.has(entityId)) {
          if (rt.pendingDestroys.has(entityId)) return false;
          rt.pendingDestroys.add(entityId);
          rt.spawnOps.push({ op: 'destroy', entityId });
          return true;
        }
        if (rt.curr.has(entityId)) {
          return refuse('behavior_destroy_refused', `ctx.destroy: "${entityId}" is not a spawned entity (authored entities stay; hide one with ctx.game.setVisible)`);
        }
        return false;
      },
    });
  }

  /** The next free `spawn-<n>` id of this run (skipping any id already in the game). */
  private allocateSpawnId(): string {
    for (;;) {
      this.spawnSerial += 1;
      const id = `${SPAWN_ID_PREFIX}${this.spawnSerial}`;
      if (!this.entities.has(id) && !this.reservedSpawnIds.has(id)) {
        this.reservedSpawnIds.add(id);
        return id;
      }
    }
  }

  /** One `spawn_refused` diagnostic per step (a runaway loop does not flood the ring). */
  private logSpawnRefusal(message: string): void {
    if (this.spawnRefusalLogged) return;
    this.spawnRefusalLogged = true;
    this.recordError({ code: 'spawn_refused', message: clipMessage(message), stepIndex: this.stepIndex });
  }

  /** The queued spawns and destroys, in request order. Returns false after a fail-stop. */
  private applySpawnOps(): boolean {
    if (this.spawnOps.length === 0) return true;
    const ops = this.spawnOps;
    this.spawnOps = [];
    for (const op of ops) {
      if (op.op === 'destroy') {
        this.pendingDestroys.delete(op.entityId);
        this.removeSpawned(op.entityId);
        continue;
      }
      for (const e of op.entities) this.reservedSpawnIds.delete(e.id);
      if (!this.addSpawned(op.entities)) return false;
    }
    return true;
  }

  /** Add one spawned copy (colliders, state, blocks, scripts). Returns false after a fail-stop. */
  private addSpawned(entities: readonly EntityV3[]): boolean {
    const root = entities[0]!;
    const clash = entities.find((e) => this.entities.has(e.id));
    if (clash !== undefined) {
      this.recordError({ code: 'spawn_refused', message: clipMessage(`spawn "${root.id}" was not added: entity "${clash.id}" is already in the game`), stepIndex: this.stepIndex });
      return true;
    }
    const frozen = deepFreeze(entities.map((e) => structuredClone(e)));
    const colliders = sceneContribution(frozen).colliders;
    if (this.physics3d !== undefined && !this.addColliders3D(frozen, (why) => {
      this.recordError({ code: 'spawn_refused', message: clipMessage(`spawn "${root.id}" was not added: ${why}`), stepIndex: this.stepIndex });
      return true;
    }, `spawn "${root.id}"`)) return false;
    if (colliders.length > 0 && this.physics !== undefined) {
      if (typeof this.physics.addStaticColliders !== 'function') {
        this.recordError({ code: 'spawn_refused', message: clipMessage(`spawn "${root.id}" was not added: the physics port cannot add colliders`), stepIndex: this.stepIndex });
        return true;
      }
      try {
        this.physics.addStaticColliders(colliders);
      } catch (e) {
        this.failStop('physics_port_error', 'spawn_colliders', `adding the colliders of spawn "${root.id}" failed: ${messageOf(e)}`, this.stepIndex);
        return false;
      }
    }
    this.attachEntities(frozen);
    for (const e of frozen) this.spawnedEntities.set(e.id, e);
    this.sceneRevision += 1;
    this.sceneSetCache = null;
    return this.notifyLoaded(frozen);
  }

  /** Remove a spawned entity and every spawned entity below it. */
  private removeSpawned(entityId: string): void {
    if (!this.spawnedEntities.has(entityId)) return;
    const ids = new Set<string>([entityId]);
    // Spawn order puts parents before children: one pass collects the subtree.
    for (const e of this.spawnedEntities.values()) if (e.parentId !== undefined && ids.has(e.parentId)) ids.add(e.id);
    this.removeSpawnedIds(ids);
  }

  private removeSpawnedIds(ids: ReadonlySet<string>): void {
    if (ids.size === 0) return;
    const colliderIds = [...ids].filter((id) => (this.spawnedEntities.get(id)?.components as { collider?: unknown } | undefined)?.collider !== undefined);
    this.detachEntities(ids, colliderIds, `spawned "${[...ids][0]}"`);
    for (const id of ids) this.spawnedEntities.delete(id);
    this.sceneRevision += 1;
    this.sceneSetCache = null;
  }

  /**
   * A new run: every spawned entity goes and pending requests are dropped. Ids
   * keep counting (never reused in one game), so an id a script kept from the
   * last run cannot name a new copy.
   */
  private clearSpawned(): void {
    this.removeSpawnedIds(new Set(this.spawnedEntities.keys()));
    this.spawnOps = [];
    this.reservedSpawnIds.clear();
    this.pendingDestroys.clear();
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
    this.preparedLoads.clear();
    this.pendingUnloads.clear();
    // Transitions and their fades do not outlive the run.
    this.transitions.clear();
    this.lastSwap = null;
    this.loadingViewCache = null;
    // A scene transition's arrival, a spawn facing and scripts' impulses do not outlive the run.
    this.pendingArrival = null;
    this.pendingRestore = null;
    this.pendingFacing = null;
    this.impulseAcc = null;
    for (const [sceneId, entities] of this.startBatchSource) {
      if (this.batches.has(sceneId)) continue;
      if (!this.addBatch(sceneId, entities, true)) return false;
    }
    return true;
  }

  private runPhase(phase: SimulationPhase, action: ActionFrame): void {
    this.phaseAction = action;
    for (const entry of this.entries) {
      if (!entry.phases.includes(phase)) continue;
      this.currentPhase = phase;
      this.currentModuleId = entry.id;
      const views = this.phaseViewsOf(entry, phase);
      if (entry.phased) {
        // The intents committed before this module runs (it does not see its own in `ctx.intents`).
        views.intents = this.intentView();
        (entry.instance as SimulationPhaseModule).step(phase, views.ctx!);
      } else {
        // Accepted M1 module participating in an M2 set (implicit
        // transform phase): the M1 `(state, stepIndex)` call is preserved.
        (entry.instance as SimulationModule).step(views.state, this.stepIndex + 1);
      }
    }
  }

  /** The frozen copy of the entity order modules see (remade only when the order changes). */
  private frozenOrder(): readonly string[] {
    if (this.frozenOrderSource !== this.order) {
      this.frozenOrderSource = this.order;
      this.frozenOrderCopy = Object.freeze([...this.order]);
    }
    return this.frozenOrderCopy;
  }

  /**
   * A module's state view and step context for one phase, made
   * once and reused every step. They read the step's values when accessed
   * (step index, time, transforms, the frame, the events) — what a context
   * made at the call would hold, since the runtime changes none of them while
   * a module runs.
   */
  private phaseViewsOf(entry: ModuleEntry, phase: SimulationPhase): PhaseViews {
    let byPhase = entry.views;
    if (byPhase === undefined) {
      byPhase = new Map();
      entry.views = byPhase;
    }
    const cached = byPhase.get(phase);
    if (cached !== undefined) return cached;
    // The closures live in another function: V8 would allocate their scope at every call, cache hits included.
    const made = this.makePhaseViews(entry, phase);
    byPhase.set(phase, made);
    return made;
  }

  private makePhaseViews(entry: ModuleEntry, phase: SimulationPhase): PhaseViews {
    const rt = this;
    // The accepted rule: the transform phase writes the declared owners.
    const writablePhase = phase === 'transform';
    const state = liveScopedState({
      order: () => rt.frozenOrder(),
      entities: () => rt.entities,
      stepIndex: () => rt.stepIndex,
      simTime: () => rt.simTime,
      prev: () => rt.prev,
      curr: () => rt.curr,
      writableOwners: () => (writablePhase ? ownerSetOf(entry) : null),
    });
    const views: PhaseViews = { state, ctx: null, intents: null };
    if (entry.phased) {
      const fields: PropertyDescriptorMap = {
        stepIndex: { get: () => rt.stepIndex, enumerable: true },
        phase: { value: phase, enumerable: true },
        action: { get: () => rt.phaseAction, enumerable: true },
        settings: { value: this.settings, enumerable: true },
        physics: { value: this.physicsClient, enumerable: true },
        state: { value: state, enumerable: true },
        intents: { get: () => views.intents, enumerable: true },
        emit: { value: (intent: BehaviorIntent): void => rt.commitIntent(entry, phase, intent), enumerable: true },
      };
      if (this.sceneRows !== null) fields['scenes'] = { value: this.sceneControl, enumerable: true };
      fields['animators'] = { value: this.animatorControl, enumerable: true };
      fields['animatorEvents'] = { get: () => rt.animatorEvents, enumerable: true };
      fields['signals'] = { value: this.signalControl, enumerable: true };
      fields['messages'] = { value: this.messageControl, enumerable: true };
      fields['game'] = { value: this.gameControl, enumerable: true };
      // The generic primitives.
      fields['health'] = { value: this.healthControl, enumerable: true };
      fields['patrol'] = { value: this.patrolControl, enumerable: true };
      fields['hitbox'] = { value: this.hitboxControl, enumerable: true };
      fields['collectible'] = { value: this.collectibleControl, enumerable: true };
      // The character's impulse and the per-object look overrides.
      fields['character'] = { value: this.characterControl, enumerable: true };
      fields['look'] = { value: this.lookControl, enumerable: true };
      fields['audio'] = { value: this.audioControl, enumerable: true };
      fields['effects'] = { value: this.effectsControl, enumerable: true };
      fields['save'] = { value: this.saveControl, enumerable: true };
      fields['spawner'] = { value: this.spawnControl, enumerable: true };
      // The virtual cameras (ctx.camera).
      fields['camera'] = { value: this.cameraControl, enumerable: true };
      // Sockets (ctx.sockets).
      fields['sockets'] = { value: this.socketControl, enumerable: true };
      // The cursor channel (ctx.input.setCursor).
      fields['cursor'] = { value: this.cursorControl, enumerable: true };
      // Bindings, the device in use and rebinding (ctx.input).
      fields['inputStatus'] = { value: this.inputStatus.view, enumerable: true };
      // Debug commands (this phase's calls; the behavior host adds the handler).
      const debugCommands = this.debugCommands;
      fields['debug'] = { value: Object.freeze({ command: (name: string, options?: DebugCommandOptions) => debugCommands.declare(name, options, phase === 'intent') }), enumerable: true };
      // The block layers.
      fields['grid'] = { value: this.grid.api, enumerable: true };
      // Graph-material parameters per object.
      fields['materials'] = { value: this.materials.api, enumerable: true };
      // Generic component access (the behavior host names the writing script) and the shell's scene list.
      fields['entities'] = { value: this.entityAccess.control, enumerable: true };
      fields['shell'] = { value: this.shellControl, enumerable: true };
      // Project saves (ctx.saves).
      fields['saves'] = { value: this.saves.api, enumerable: true };
      // The project UI (the step's UI events in the intent phase).
      fields['ui'] = { value: this.uiControlFor(phase), enumerable: true };
      // Conversations (ctx.dialogue; calls apply at the end of the step).
      fields['dialogue'] = { value: this.dialogue.api, enumerable: true };
      // The game modes, the run lifecycle, and which behaviors tick in the current mode.
      fields['modes'] = { value: this.modeControlFor(phase), enumerable: true };
      fields['lifecycle'] = { value: this.lifecycleControl, enumerable: true };
      fields['behaviorTicks'] = { get: () => rt.behaviorTicks(), enumerable: true };
      // The switched-off objects (the behavior host's onEnable/onDisable).
      fields['inactiveEntities'] = { get: () => rt.entityAccess.inactive(), enumerable: true };
      // Timelines (ctx.timeline).
      fields['timeline'] = { value: this.timelineControl, enumerable: true };
      // The environment presets (ctx.environment).
      fields['environment'] = { value: this.environment.api, enumerable: true };
      // Last step's trigger enter/exit events (each script gets those it owns).
      const blocks = this.blocks;
      if (blocks !== null) fields['triggerEvents'] = { get: () => blocks.triggerEvents(), enumerable: true };
      // The primitives' events of the last step (each script gets those of the objects it owns).
      if (blocks !== null) fields['primitiveEvents'] = { get: () => blocks.primitiveEvents(), enumerable: true };
      // The climb volume the character is in (the character controllers read it).
      if (blocks !== null) fields['climb'] = { value: this.climbQuery, enumerable: true };
      // 3D: the active camera's yaw for the character's move input (absent: world axes).
      if (this.physics3d !== undefined) fields['cameraYaw'] = { get: () => rt.cameraYaw3D(), enumerable: true };
      views.ctx = frozenContext(Object.defineProperties({}, fields) as StepContext);
    }
    return views;
  }

  /**
   * A frozen read-only view of the intents committed so far this step (phase
   * The same object until the next commit or step).
   */
  private intentView(): IntentSet {
    if (this.intentViewCache !== null && this.intentViewVersion === this.intentsVersion) return this.intentViewCache;
    const s = this.intents;
    const view: IntentSet = Object.freeze({
      stepIndex: s.stepIndex,
      move: s.move,
      jump: s.jump,
      moveWriter: s.moveWriter,
      jumpWriter: s.jumpWriter,
      // The writes are frozen when committed.
      transformWrites: Object.freeze(s.transformWrites.slice()),
      // Present only when committed (a 2D step's view has no such field).
      ...(s.moveY !== null ? { moveY: s.moveY } : {}),
      ...(s.characterMove !== null ? { characterMove: Object.freeze({ ...s.characterMove }) } : {}),
      ...(s.characterPlace !== null ? { characterPlace: Object.freeze({ ...s.characterPlace }) } : {}),
      ...(s.characterEnabled !== null ? { characterEnabled: s.characterEnabled } : {}),
      // scripts' impulses for the controller, and the yaw a placement faces (present only when set).
      ...(this.impulseAcc !== null ? { impulse: Object.freeze({ x: this.impulseAcc[0], y: this.impulseAcc[1], z: this.impulseAcc[2] }) } : {}),
      ...(this.stepFacing !== null ? { characterYaw: this.stepFacing } : {}),
    });
    this.intentViewCache = view;
    this.intentViewVersion = this.intentsVersion;
    return view;
  }

  /**
   * Commit one intent (steps 1–7). The runtime owns the
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
      // The second axis (a 3D character's forward input).
      if (intent.y !== undefined) this.intents.moveY = quantizeIntentMove(intent.y);
      return;
    }
    if (intent.kind === 'character_move' || intent.kind === 'character_place' || intent.kind === 'character_enable') {
      // The 3D character controller's channels (one writer each per step).
      // character_place on the 2D plane too (a character with a physics port).
      if (this.physics3d === undefined && (intent.kind !== 'character_place' || this.controllerEntityId === undefined || this.resetPort() === null)) {
        throw new BehaviorIntentError('behavior_intent_invalid', 'value', intent.kind === 'character_place' ? 'a character_place intent needs a character (a controller) with physics' : `a ${intent.kind} intent needs a 3D project (physics_dimension 3)`);
      }
      const writer = this.intents.characterWriters.get(intent.kind);
      if (writer !== undefined) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_writer', `${intent.kind} already committed by "${writer}" and "${entry.id}"`);
      }
      this.bumpIntentCount();
      this.intents.characterWriters.set(intent.kind, entry.id);
      if (intent.kind === 'character_move') this.intents.characterMove = { x: intent.x, z: intent.z, run: intent.run === true };
      else if (intent.kind === 'character_place') this.intents.characterPlace = { x: intent.position[0], y: intent.position[1], z: intent.position[2] };
      else this.intents.characterEnabled = intent.enabled;
      return;
    }
    if (intent.kind === 'respawn') {
      // The respawn intent is ctx.lifecycle's respawn (at the active spawn, else where the character started).
      this.bumpIntentCount();
      this.lifecycleControl.respawn();
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
    if (!ownerSetOf(entry).has(intent.entityId)) {
      throw new BehaviorIntentError('behavior_transform_forbidden', 'not_owner', `entity "${intent.entityId}" is not owned by module "${entry.id}"`);
    }
    const transform = this.curr.get(intent.entityId);
    if (transform === undefined) {
      throw new BehaviorIntentError('behavior_transform_forbidden', 'not_owner', `entity "${intent.entityId}" does not exist`);
    }
    // The written channels of an entity are bits in one map entry
    // tagged with the step (x/y/z 1/2/4, rotation 8, scale 16): no key strings per intent.
    const axes = this.intents.axes;
    const tag = this.intents.axesTag * 64;
    const stored = axes.get(intent.entityId);
    const have = stored !== undefined && stored >= tag && stored < tag + 64 ? stored - tag : 0;
    // A quaternion or a facing is a rotation write too (one form per intent).
    const turns = intent.quaternion !== undefined || intent.facing !== undefined;
    if (intent.kind === 'pose') {
      if ((intent.rotation !== undefined || turns) && (have & 8) !== 0) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `module "${entry.id}" already committed a rotation write to "${intent.entityId}" in this step`);
      }
      if (intent.scale !== undefined && (have & 16) !== 0) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `module "${entry.id}" already committed a scale write to "${intent.entityId}" in this step`);
      }
      this.bumpIntentCount();
      let bits = 0;
      if (intent.rotation !== undefined) {
        const rad = Math.PI / 360; // half-angle per degree
        const y = (intent.rotation.yaw ?? 0) * rad;
        const x = (intent.rotation.pitch ?? 0) * rad;
        const z = (intent.rotation.roll ?? 0) * rad;
        // q = qYaw · qPitch · qRoll
        const cy = Math.cos(y);
        const sy = Math.sin(y);
        const cx = Math.cos(x);
        const sx = Math.sin(x);
        const cz = Math.cos(z);
        const sz = Math.sin(z);
        // qYaw · qPitch as [x, y, z, w]
        const qx = cy * sx;
        const qy = sy * cx;
        const qz = -sy * sx;
        const qw = cy * cx;
        transform.rotation[0] = qx * cz + qy * sz;
        transform.rotation[1] = qy * cz - qx * sz;
        transform.rotation[2] = qw * sz + qz * cz;
        transform.rotation[3] = qw * cz - qz * sz;
        bits |= 8;
      } else if (turns) {
        writeRotationForm(transform.rotation, intent);
        bits |= 8;
      }
      if (intent.scale !== undefined) {
        const sc = intent.scale;
        if (typeof sc === 'number') {
          transform.scale[0] = sc;
          transform.scale[1] = sc;
          transform.scale[2] = sc;
        } else {
          transform.scale[0] = sc[0];
          transform.scale[1] = sc[1];
          transform.scale[2] = sc[2];
        }
        bits |= 16;
      }
      axes.set(intent.entityId, tag + (have | bits));
      return;
    }
    const position = intent.position;
    let bits = 0;
    for (const axis in position) {
      const bit = axis === 'x' ? 1 : axis === 'y' ? 2 : axis === 'z' ? 4 : 0;
      if (bit === 0) continue;
      if ((have & bit) !== 0) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `module "${entry.id}" already committed a write to "${intent.entityId}".${axis} in this step`);
      }
      bits |= bit;
    }
    if (turns) {
      if ((have & 8) !== 0) {
        throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `module "${entry.id}" already committed a rotation write to "${intent.entityId}" in this step`);
      }
      bits |= 8;
    }
    this.bumpIntentCount();
    if ((bits & 1) !== 0) transform.position[0] = position.x as number;
    if ((bits & 2) !== 0) transform.position[1] = position.y as number;
    if ((bits & 4) !== 0) transform.position[2] = position.z as number;
    if (turns) writeRotationForm(transform.rotation, intent);
    axes.set(intent.entityId, tag + (have | bits));
    // Frozen once here; every `ctx.intents` view shares it.
    this.intents.transformWrites.push(Object.freeze({
      moduleId: entry.id,
      entityId: intent.entityId,
      position: Object.freeze({ ...intent.position }),
    }));
  }

  /** The per-step intent cap, then the cumulative count. */
  private bumpIntentCount(): void {
    if (this.intents.count + 1 > INTENT_LIMITS.perStep) {
      const limit = this.intentStepLimit();
      if (this.intents.count + 1 > limit) {
        throw new BehaviorIntentError('behavior_intent_limit', 'per_step', `more than ${limit} intents were committed in one step`);
      }
    }
    this.intents.count += 1;
    this.intentCommitCount += 1;
    this.intentsVersion += 1;
  }

  /**
   * The per-step intent cap scales with the live behavior
   * instances — `max(INTENT_LIMITS.perStep, perInstancePerStep × instances)` —
   * so every instance may use its own bound in the same step (hundreds of
   * moving objects), while the floor keeps every run the fixed cap of 64
   * accepted valid. Instances come and go only with entities, so the count is
   * re-read when the entity order changes.
   */
  private intentStepLimit(): number {
    if (this.intentLimitOrder !== this.order) {
      let instances = 0;
      for (const entry of this.entries) {
        const probe = entry.instance as { behaviorDiagnostics?: () => { instanceCount?: number } };
        if (typeof probe.behaviorDiagnostics !== 'function') continue;
        try {
          const n = probe.behaviorDiagnostics().instanceCount;
          if (typeof n === 'number' && Number.isInteger(n) && n > 0) instances += n;
        } catch {
          /* a failing diagnostics read counts no instances */
        }
      }
      this.intentLimit = Math.max(INTENT_LIMITS.perStep, INTENT_LIMITS.perInstancePerStep * instances);
      this.intentLimitOrder = this.order;
    }
    return this.intentLimit;
  }

  /**
   * Record one accepted behavior `ctx.log` entry in the runtime's bounded
   * ring. A log flood cannot grow a diagnostics frame beyond
   * the 32-entry ring; the per-instance ring and counters live in the host.
   */
  private recordBehaviorLog(moduleId: string, level: BehaviorLogLevel, message: string, at?: { file: string; line: number; column: number }): void {
    this.recordError({
      code: 'behavior_log',
      reason: level,
      moduleId,
      message: clipMessage(message),
      stepIndex: this.stepIndex,
      ...(at !== undefined ? { at } : {}),
    });
  }

  private readonly physicsClient: PhysicsStepClient = {
    stageCharacterMove: (entityId: string, delta: Vec2): void => this.stageMove(entityId, delta),
    // In 3D the 3D result (its vectors carry z too).
    characterResult: (): CharacterMoveResult | undefined => (this.physics3d !== undefined ? (this.lastCharacterResult3D as unknown as CharacterMoveResult | undefined) : this.lastCharacterResult),
    characterState: (): CharacterState3D | undefined => this.characterState3D(),
    // 3D: rays, overlaps and picks with filters; at most QUERY_LIMIT_3D a step.
    raycast3d: (origin: readonly number[], direction: readonly number[], maxDistance?: number, filter?: unknown) => {
      const o = queryVec3(origin, 'raycast3d origin');
      const d = queryVec3(direction, 'raycast3d direction');
      return this.castRay3D(o, d, queryDistance(maxDistance, 100, 'raycast3d'), filter);
    },
    overlapSphere: (center: readonly number[], radius: number, filter?: unknown): string[] =>
      this.overlap3D({ type: 'sphere', radius: queryPositive(radius, 'overlapSphere radius') }, queryVec3(center, 'overlapSphere center'), undefined, filter),
    overlapBox3d: (center: readonly number[], half: readonly number[], rotation?: readonly number[], filter?: unknown): string[] => {
      const h = queryVec3(half, 'overlapBox3d half');
      return this.overlap3D({ type: 'box', hx: queryPositive(h[0], 'overlapBox3d half x'), hy: queryPositive(h[1], 'overlapBox3d half y'), hz: queryPositive(h[2], 'overlapBox3d half z') }, queryVec3(center, 'overlapBox3d center'), queryQuat(rotation, 'overlapBox3d rotation'), filter);
    },
    overlapCapsule: (center: readonly number[], radius: number, height: number, rotation?: readonly number[], filter?: unknown): string[] => {
      const r = queryPositive(radius, 'overlapCapsule radius');
      const h = queryPositive(height, 'overlapCapsule height');
      return this.overlap3D({ type: 'capsule', radius: r, halfHeight: Math.max(0, h / 2 - r) }, queryVec3(center, 'overlapCapsule center'), queryQuat(rotation, 'overlapCapsule rotation'), filter);
    },
    pickAt: (x: number, y: number, maxDistance?: number, filter?: unknown) => {
      if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) throw new Error('pickAt takes a screen point x, y (numbers, 0-1 from the top left)');
      const ray = this.screenRay(x, y);
      return this.castRay3D(ray.origin, ray.direction, queryDistance(maxDistance, 1000, 'pickAt'), filter);
    },
    pickAtPointer: (maxDistance?: number, filter?: unknown) => {
      const max = queryDistance(maxDistance, 1000, 'pickAtPointer');
      const p = this.heldPointer;
      if (p === null || (p.over === false && p.locked !== true)) return null;
      const ray = p.locked === true ? this.screenRay(0.5, 0.5) : this.screenRay(p.x, p.y);
      return this.castRay3D(ray.origin, ray.direction, max, filter);
    },
    // At most 32 queries (rays and overlaps) per step for modules and scripts.
    raycast: (origin: Vec2, direction: Vec2, maxDistance: number) => {
      if (this.raycastsThisStep >= 32 || this.physics?.raycast === undefined) return null;
      this.raycastsThisStep += 1;
      return this.physics.raycast(origin, direction, maxDistance);
    },
    overlapBox: (center: Vec2, half: Vec2): string[] => {
      if (this.raycastsThisStep >= 32 || this.physics?.overlap === undefined || half === null || typeof half !== 'object') return [];
      this.raycastsThisStep += 1;
      return this.physics.overlap({ type: 'box', hx: Number(half.x), hy: Number(half.y) }, { x: Number(center?.x), y: Number(center?.y) });
    },
    overlapCircle: (center: Vec2, radius: number): string[] => {
      if (this.raycastsThisStep >= 32 || this.physics?.overlap === undefined) return [];
      this.raycastsThisStep += 1;
      return this.physics.overlap({ type: 'circle', radius: Number(radius) }, { x: Number(center?.x), y: Number(center?.y) });
    },
  };

  /** One query from the step's 3D budget (null past it — warned once — or without a 3D port). */
  private takeQuery3D(): PhysicsPort3D | null {
    const port = this.physics3d;
    if (port === undefined) return null;
    if (this.raycastsThisStep >= QUERY_LIMIT_3D) {
      if (!this.queryLimitWarned) {
        this.queryLimitWarned = true;
        this.recordBehaviorLog('thirdlight.runtime:physics', 'warn', `more than ${QUERY_LIMIT_3D} physics queries in one step (step ${this.stepIndex}): the rest of the step's queries find nothing (warned once)`);
      }
      return null;
    }
    this.raycastsThisStep += 1;
    return port;
  }

  /** A script's query filter as the port takes it (tags and exclusions become the accept test). */
  private queryFilter3D(filter: unknown): PhysicsQueryFilter3D | undefined {
    if (filter === undefined || filter === null) return undefined;
    if (typeof filter !== 'object' || Array.isArray(filter)) throw new Error('a query filter is { tags?, layers?, exclude? }');
    const f = filter as Record<string, unknown>;
    for (const k of Object.keys(f)) if (k !== 'tags' && k !== 'layers' && k !== 'exclude') throw new Error(`unknown query filter field "${k.slice(0, 32)}" (tags, layers, exclude)`);
    const names = (v: unknown, what: string): string[] | undefined => {
      if (v === undefined) return undefined;
      if (!Array.isArray(v) || v.length > 64 || !v.every((s) => typeof s === 'string')) throw new Error(`query filter ${what} is a list of up to 64 names`);
      return v as string[];
    };
    const tags = names(f['tags'], 'tags');
    const layers = names(f['layers'], 'layers');
    const exclude = names(f['exclude'], 'exclude');
    // Tag names resolve like ctx.tags.mask (an unknown name is a script error).
    const tagIndex = this.queryTags;
    const mask = tags === undefined ? undefined : tags.length === 0 ? 0 : tagIndex === null ? 0 : tagIndex.mask(...tags);
    const skip = exclude === undefined || exclude.length === 0 ? null : new Set(exclude);
    const accept =
      mask === undefined && skip === null
        ? undefined
        : (colliderId: string): boolean => {
            const id = colliderEntityOf(colliderId);
            return (skip === null || !skip.has(id)) && (mask === undefined || (mask !== 0 && tagIndex !== null && tagIndex.has(id, mask)));
          };
    return { ...(layers !== undefined ? { layers } : {}), ...(accept !== undefined ? { accept } : {}) };
  }

  /** A filtered 3D ray (origin, direction not normalized) into a script's hit. */
  private castRay3D(origin: readonly number[], direction: readonly number[], maxDistance: number, filter: unknown): PhysicsHit | null {
    const f = this.queryFilter3D(filter);
    const len = Math.hypot(direction[0]!, direction[1]!, direction[2]!);
    if (!(len > 0)) return null;
    const port = this.takeQuery3D();
    if (port === null || typeof port.raycast !== 'function') return null;
    const u = [direction[0]! / len, direction[1]! / len, direction[2]! / len];
    const hit = port.raycast({ x: origin[0]!, y: origin[1]!, z: origin[2]! }, { x: u[0]!, y: u[1]!, z: u[2]! }, maxDistance, f);
    if (hit === null) return null;
    const p = hit.point ?? { x: origin[0]! + u[0]! * hit.distance, y: origin[1]! + u[1]! * hit.distance, z: origin[2]! + u[2]! * hit.distance };
    const entityId = colliderEntityOf(hit.entityId);
    // A block layer's chunk: the layer, and the cell just inside the surface the ray hit (1 mm behind it).
    let cell: [number, number, number] | undefined;
    if (entityId !== hit.entityId) {
      const c = this.grid.api.worldToCell(entityId, [p.x - hit.normal.x * 1e-3, p.y - hit.normal.y * 1e-3, p.z - hit.normal.z * 1e-3]);
      if (c !== null) cell = [c.x, c.y, c.z];
    }
    return Object.freeze({ entityId, point: [p.x, p.y, p.z], normal: [hit.normal.x, hit.normal.y, hit.normal.z], distance: hit.distance, ...(cell !== undefined ? { cell } : {}) }) as PhysicsHit;
  }

  /** A filtered 3D overlap (sorted ids, at most 64). */
  private overlap3D(shape: OverlapShape3D, center: readonly number[], rotation: PhysicsQuat | undefined, filter: unknown): string[] {
    const f = this.queryFilter3D(filter);
    const port = this.takeQuery3D();
    if (port === null || typeof port.overlap !== 'function') return [];
    // A block layer's chunk colliders are reported as their layer (once).
    return [...new Set(port.overlap(shape, { x: center[0]!, y: center[1]!, z: center[2]! }, rotation, f).map(colliderEntityOf))].sort();
  }

  /** The camera brain has resolved a view (a virtual camera is loaded and it has stepped). */
  private brainHasView(): boolean {
    return this.cameras.active && this.cameras.hasView();
  }

  /** The scene camera's pose now (its world transform and lens) — the view when no virtual camera is live. */
  private basePose(): CameraPose {
    const pos = [0, 0, 0];
    const rot = [0, 0, 0, 1];
    if (!this.worldTransformOf(this.cameraInfo.id, pos, rot)) {
      pos.fill(0);
      rot[0] = 0;
      rot[1] = 0;
      rot[2] = 0;
      rot[3] = 1;
    }
    return { position: [pos[0]!, pos[1]!, pos[2]!], rotation: [rot[0]!, rot[1]!, rot[2]!, rot[3]!], fovY: this.cameraInfo.fovY, near: this.cameraInfo.near, far: this.cameraInfo.far, letterbox: 0 };
  }

  /**
   * The ray from the active camera through a screen point
   * (normalized, 0,0 top left): the camera brain's resolved view when a
   * virtual camera is live, else the scene camera's.
   */
  private screenRay(x: number, y: number): { origin: readonly [number, number, number]; direction: readonly [number, number, number] } {
    if (this.brainHasView()) return this.cameras.screenToRay(x, y);
    return poseScreenToRay(this.basePose(), this.cameras.viewportSize().aspect, Number.isFinite(x) ? x : 0.5, Number.isFinite(y) ? y : 0.5);
  }

  private baseWorldToScreen(position: readonly number[]): { x: number; y: number; depth: number; onScreen: boolean } {
    const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    return poseWorldToScreen(this.basePose(), this.cameras.viewportSize().aspect, n(position[0]), n(position[1]), n(position[2]));
  }

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
    if (this.physics3d !== undefined) {
      // A 3D move (z optional: a module written for the plane moves in it).
      const z = (delta as { z?: unknown }).z;
      // The player moves with what it stands on (and a mover's push).
      const c3 = entityId === this.controllerEntityId ? (this.blocks?.carryDelta3() ?? [0, 0, 0]) : [0, 0, 0];
      // Lifted by what it stands on, its own fall is cancelled — the port poses the
      // movers after the sweep, so a grounded character's small fall would end inside the risen platform.
      const ownY = c3[1]! > 0 && delta.y < 0 ? 0 : delta.y;
      const moved3 = { x: delta.x + c3[0]!, y: ownY + c3[1]!, z: (typeof z === 'number' && Number.isFinite(z) ? z : 0) + c3[2]! };
      this.staged.set(entityId, { x: moved3.x, y: moved3.y });
      this.staged3d.set(entityId, moved3);
      this.physics3d.stageCharacterMove(moved3);
      return;
    }
    // The player moves with the platform it stands on.
    const carry = entityId === this.controllerEntityId ? (this.blocks?.carryDelta() ?? { x: 0, y: 0 }) : { x: 0, y: 0 };
    const moved = { x: delta.x + carry.x, y: delta.y + carry.y };
    this.staged.set(entityId, moved);
    this.physics?.stageCharacterMove(moved);
  }

  /** The physics phase (runtime, not a module): one validated `port.step()`. */
  private runPhysicsPhase(): void {
    if (this.physics3d !== undefined) {
      this.runPhysicsPhase3D(this.physics3d);
      return;
    }
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
        // phase-transform module runs.
        t.position[0] = check.result.position.x;
        t.position[1] = check.result.position.y;
      }
    }
    if (this.staged.size > 0) this.staged.clear();
  }

  /**
   * The 3D physics phase — one validated `port.step()`. The
   * character falls under the project's gravity (`gravity_y` along Y, capped
   * at `max_fall_speed`) and rests on what it lands on (its fall speed is
   * zeroed while grounded); a move a module staged in the controller phase
   * replaces the fall. Walking, jumping and turning are the controller's.
   * The full position (x, y and z) is committed to the controller's transform.
   */
  private runPhysicsPhase3D(port: PhysicsPort3D): void {
    // Cells written this step collide in this step's sweep.
    this.grid.flushCollision(port);
    const controllerId = this.controllerEntityId;
    const t = controllerId !== undefined ? this.curr.get(controllerId) : undefined;
    const previous: PhysicsVec3 = t ? { x: t.position[0], y: t.position[1], z: t.position[2] } : { x: 0, y: 0, z: 0 };
    const dt = 1 / this.hz;
    let requested = controllerId !== undefined ? this.staged3d.get(controllerId) : undefined;
    if (requested === undefined && controllerId === undefined) {
      // A world without a character (colliders for queries and movers): nothing falls.
      requested = { x: 0, y: 0, z: 0 };
      port.stageCharacterMove(requested);
    } else if (requested === undefined) {
      const grounded = this.lastCharacterResult3D?.grounded === true;
      this.fallSpeed3d = grounded ? 0 : Math.max(this.settings.max_fall_speed, this.fallSpeed3d + this.settings.gravity_y * dt);
      // Plus the platform it stands on (a mover's or script-driven collider's motion) and a mover's push.
      const c3 = this.blocks?.carryDelta3() ?? [0, 0, 0];
      requested = { x: c3[0]!, y: this.fallSpeed3d * dt + c3[1]!, z: c3[2]! };
      port.stageCharacterMove(requested);
    }
    let raw: unknown;
    this.physicsSteps += 1;
    try {
      raw = port.step();
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port step() threw: ${messageOf(e)}`);
    }
    const check = validateCharacterMoveResult3D(raw, previous, requested, this.character3DClimb);
    if (!check.ok) throw new PhysicsPortFailure('result', `physics port returned an invalid result: ${check.failure.detail}`);
    this.lastCharacterResult3D = check.result;
    // A landing (or a head bump) ends the fall; the next step starts from rest.
    if (check.result.grounded || check.result.contacts.head) this.fallSpeed3d = 0;
    if (t) {
      t.position[0] = check.result.position.x;
      t.position[1] = check.result.position.y;
      t.position[2] = check.result.position.z;
    }
    if (this.staged.size > 0) this.staged.clear();
    if (this.staged3d.size > 0) this.staged3d.clear();
  }

  /**
   * The active camera's yaw for the 3D character's move input —
   * radians about +Y (0 looking along −Z) — or undefined (world axes). It is
   * the camera brain's committed view (resolved in the simulation at the
   * end of the previous step, so a replay reads the same yaw); without virtual cameras the character moves along world axes. An
   * injected source (`cameraYawSource`) takes precedence.
   */
  private cameraYaw3D(): number | undefined {
    const source = this.cameraYawSource;
    if (source !== null) {
      const v = source();
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    }
    if (!this.cameras.active || !this.cameras.hasView()) return undefined;
    const q = this.cameras.view().rotation;
    // The view's forward (−Z turned by the rotation), flattened onto the ground.
    const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
    let fx = -2 * (x * z + w * y);
    let fz = -(1 - 2 * (x * x + y * y));
    if (!(Math.hypot(fx, fz) > 1e-3)) {
      // Looking straight down (or up): the screen's up is the way forward on the ground.
      fx = 2 * (x * y - w * z);
      fz = 2 * (y * z + w * x);
      if (!(Math.hypot(fx, fz) > 1e-9)) return undefined;
    }
    return Math.atan2(-fx, -fz);
  }

  /**
   * Apply a committed `character_place` (after the intent phase,
   * before the controller runs): the port re-places the capsule and clears
   * its motion; the controller's transform takes the new origin (the
   * controller module starts from rest there).
   */
  private applyCharacterPlace3D(): void {
    const place = this.intents.characterPlace;
    if (place === null) return;
    this.placeCharacter3D(place.x, place.y, place.z);
  }

  /** Put the 3D character at an origin (the port's clearance rules), from rest. */
  private placeCharacter3D(x: number, y: number, z: number): void {
    const place = { x, y, z };
    const port = this.physics3d;
    const id = this.controllerEntityId;
    if (port === undefined || id === undefined) return;
    if (typeof port.placeCharacter !== 'function') throw new PhysicsPortFailure('threw', 'the 3D physics port cannot place the character');
    try {
      port.placeCharacter({ x: place.x, y: place.y, z: place.z });
    } catch (e) {
      throw new PhysicsPortFailure('threw', `physics port placeCharacter() threw: ${messageOf(e)}`);
    }
    this.blocks?.placed(id);
    const t = this.curr.get(id);
    if (t !== undefined) {
      t.position[0] = place.x;
      t.position[1] = place.y;
      t.position[2] = place.z;
    }
    this.lastCharacterResult3D = undefined;
    this.fallSpeed3d = 0;
  }

  /** `ctx.physics.characterState` — the 3D character after the last step (undefined in 2D or before it). */
  private characterState3D(): CharacterState3D | undefined {
    const r = this.lastCharacterResult3D;
    if (this.physics3d === undefined || r === undefined) return undefined;
    let status: { enabled?: unknown; climbing?: unknown; yaw?: unknown } | null = null;
    for (const entry of this.entries) {
      const probe = entry.instance as { character3DStatus?: () => { enabled: boolean; climbing: boolean; yaw: number } };
      if (typeof probe.character3DStatus === 'function') {
        status = probe.character3DStatus();
        break;
      }
    }
    const yaw = typeof status?.yaw === 'number' ? status.yaw : 0;
    return Object.freeze({
      position: Object.freeze({ x: r.position.x, y: r.position.y, z: r.position.z }),
      velocity: Object.freeze({ x: r.applied.x * this.hz, y: r.applied.y * this.hz, z: r.applied.z * this.hz }),
      grounded: r.grounded,
      contacts: Object.freeze({ ...r.contacts }),
      supportNormal: Object.freeze({ x: r.supportNormal.x, y: r.supportNormal.y, z: r.supportNormal.z }),
      groundEntityId: r.groundEntityId ?? null,
      enabled: status?.enabled !== false,
      climbing: status?.climbing === true,
      facing: (yaw * 180) / Math.PI,
    });
  }

  /**
   * Bring the colliders scripts drive up to date with the
   * modules' transform owners (at a step boundary): an owned collider that is
   * still a fixed body is re-added to the 3D port as a kinematic one at its
   * current transform (posed from then on with the movers). False after a
   * fail-stop.
   */
  private syncScriptColliders3D(): boolean {
    this.scriptCollidersDirty = false;
    const port = this.physics3d;
    if (port === undefined) return true;
    const owned = new Set<string>();
    const off = this.entityAccess.inactive();
    for (const entry of this.entries) for (const id of entry.owners) if (!off.has(id) && scriptDrivableCollider(this.colliderComponents3D.get(id))) owned.add(id);
    const add: StaticColliderSpec3D[] = [];
    for (const id of [...owned].sort()) {
      if (this.scriptColliders3D.has(id)) continue;
      const comps = this.colliderComponents3D.get(id)!;
      const t = this.curr.get(id);
      const spec = staticColliderOf3D(id, t !== undefined ? { ...comps, transform: { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] } } : comps, true);
      if (spec !== null) add.push(spec);
    }
    if (add.length === 0) return true;
    if (typeof port.addStaticColliders !== 'function' || typeof port.removeStaticColliders !== 'function' || typeof port.setKinematicPoses !== 'function') {
      this.failStop('physics_port_error', 'script_colliders', 'the 3D physics port cannot pose colliders scripts drive', this.stepIndex);
      return false;
    }
    try {
      port.removeStaticColliders(add.map((sp) => sp.entityId));
      port.addStaticColliders(add);
    } catch (e) {
      this.failStop('physics_port_error', 'script_colliders', `making the colliders scripts drive kinematic failed: ${messageOf(e)}`, this.stepIndex);
      return false;
    }
    for (const sp of add) this.scriptColliders3D.add(sp.entityId);
    return true;
  }

  /** Where the colliders scripts drive are now (their committed transforms), in id order. */
  private scriptColliderPoses3D(): { entityId: string; position: [number, number, number]; rotation: readonly number[] }[] {
    if (this.scriptColliders3D.size === 0) return [];
    const out: { entityId: string; position: [number, number, number]; rotation: readonly number[] }[] = [];
    for (const id of [...this.scriptColliders3D].sort()) {
      const t = this.curr.get(id);
      if (t !== undefined) out.push({ entityId: id, position: [t.position[0], t.position[1], t.position[2]], rotation: t.rotation });
    }
    return out;
  }

  /** Add the 3D colliders of loaded / spawned entities (false after a fail-stop). */
  private addColliders3D(entities: readonly EntityV3[], refuse: (why: string) => boolean, what: string): boolean {
    const port = this.physics3d!;
    const specs: StaticColliderSpec3D[] = [];
    for (const e of entities) {
      const c = e.components as unknown as Record<string, unknown>;
      if (c['controller'] !== undefined) continue;
      const spec = staticColliderOf3D(e.id, c);
      if (spec !== null) specs.push(spec);
    }
    if (specs.length === 0) return true;
    if (typeof port.addStaticColliders !== 'function') {
      refuse('the physics port cannot add colliders');
      return false;
    }
    try {
      port.addStaticColliders(specs);
    } catch (e) {
      this.failStop('physics_port_error', 'scene_colliders', `adding the colliders of ${what} failed: ${messageOf(e)}`, this.stepIndex);
      return false;
    }
    return true;
  }

  private failStopFromError(e: unknown, stepIndex: number): void {
    const moduleId = this.currentModuleId;
    const phase = this.currentPhase;
    // A visual script's error names the node it came from.
    this.failNodeId = graphNodeIdOf(e);
    // And where in the compiled scripts it was thrown.
    this.failFrames = compiledFramesOf(e);
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
    // Behavior contract: the validated-intent API's
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
   * Fail-stop: abandon the step (no transform rollback), cancel the
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
    if (this.failNodeId !== undefined) entry.nodeId = this.failNodeId;
    this.failNodeId = undefined;
    if (this.failFrames.length > 0) {
      entry.at = this.failFrames[0];
      entry.frames = this.failFrames;
      this.failFrames = [];
    }
    this.recordError(entry);
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
    const diag = this.physics ?? this.physics3d;
    if (diag && typeof diag.diagnostics === 'function') {
      try {
        const d = diag.diagnostics() ?? {};
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

  /**
   * The property values every behavior instance on `entityId`
   * reads (public and private) — read-only, for the Play debug view.
   */
  /**
   * Play debugging: what the running behavior instances expose
   * for a debugger (their module's optional `debug(state)`; a visual script
   * built for Play returns its trace, wire values and variables), for one
   * behavior and/or one entity. Read-only by contract; exported games carry
   * no module that answers.
   */
  behaviorDebug(filter: { behaviorId?: string; entityId?: string } = {}): BehaviorDebugView[] {
    const out: BehaviorDebugView[] = [];
    for (const entry of this.entries) {
      const probe = entry.instance as { behaviorDebug?: (f: { behaviorId?: string; entityId?: string }) => BehaviorDebugView[] };
      if (typeof probe.behaviorDebug !== 'function') continue;
      out.push(...probe.behaviorDebug(filter));
    }
    return out;
  }

  behaviorProperties(entityId: string): BehaviorPropertyView[] {
    const out: BehaviorPropertyView[] = [];
    for (const entry of this.entries) {
      const probe = entry.instance as { behaviorProperties?: (id: string) => BehaviorPropertyView | null };
      if (typeof probe.behaviorProperties !== 'function') continue;
      const view = probe.behaviorProperties(entityId);
      if (view !== null) out.push(view);
    }
    return out;
  }

  /** Cumulative behavior log totals the host instances report. */
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
    // Generic component writes (only once a script used them: every other diagnostics frame keeps its shape).
    const ea = this.entityAccess;
    if (ea.applied + ea.refused + ea.conflicts > 0) m2.entityWrites = { applied: ea.applied, refused: ea.refused, conflicts: ea.conflicts, inactive: ea.inactive().size };
    if (this.failedModuleId !== undefined) m2.failedModuleId = this.failedModuleId;
    if (this.failedPhase !== undefined) m2.failedPhase = this.failedPhase;
    if (this.failedStepIndex !== undefined) m2.failedStepIndex = this.failedStepIndex;
    return m2;
  }
}
