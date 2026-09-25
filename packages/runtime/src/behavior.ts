/**
 * The trusted behavior host — runtime.md §14 (promoted packet-18
 * behavior contract; implemented by packet 34).
 *
 * This module is the runtime's ONLY behavior-execution surface. It implements
 * the contract's `BehaviorSpec` lifecycle (`prepare → instantiate → step →
 * dispose`) for one **already-compiled artifact** supplied by the host, feeds
 * the declaration-materialized property values and the action/state views to
 * the behavior, and enforces the per-instance parts of the intent/log bounds.
 * The runtime owns the per-step `IntentSet`, cross-module writer conflicts and
 * the fail-stop; this host owns instance identity, the prepared object and the
 * per-instance log ring.
 *
 * Trust boundary (normative, §14.1/§14.2 — no claim to the contrary may be
 * made by any packet, UI string, handoff or acceptance record):
 *
 * 1. **No hard runtime timeout exists.** Trusted behavior code runs on the
 *    same thread as the renderer and the fixed-step loop. A same-thread
 *    infinite loop cannot be preempted by a watchdog, an iframe removal, a
 *    Stop button or `dispose()`.
 * 2. **No hostile-code sandbox exists.** A behavior reaches every global of
 *    its game origin. The compiler checks are defense in depth, not a sandbox.
 * 3. Scripts observe their origin's globals; the preview exposes no
 *    credentials.
 *
 * This module never evaluates, imports, requires or `eval`s source: it only
 * reads the artifact namespace the host provides (the host is responsible for
 * loading the compiled bytes in its own bounded way). No Node builtin, no
 * three.js, no authoring/backend edge.
 */
import type {
  DeclaredProperty,
  PropertyDeclaration,
  PropertyType,
  PropertyValue,
} from '@thirdlight/project-model';
import type { ActionFrame } from './actions';
import type { PhysicsStepClient } from './ports';
import { clipMessage } from './errors';
import { LiveTagIndex } from './scene-set';
import { InstanceTimers, TimerCallError } from './timers';
import {
  BEHAVIOR_LOG_CODE,
  BEHAVIOR_LOG_LEVELS,
  BehaviorIntentError,
  INTENT_LIMITS,
  validateIntentPhase,
  validateIntentShape,
  validateIntentValue,
  type BehaviorIntent,
  type BehaviorLogLevel,
  type IntentSet,
} from './intents';
import type {
  AnimatorEventRecord,
  BehaviorAnimatorHandle,
  BehaviorAudio,
  BehaviorGameState,
  BehaviorMessages,
  BehaviorSave,
  BehaviorSceneControl,
  BehaviorSignals,
  BehaviorTagQuery,
  BehaviorTimers,
  BehaviorWorldView,
  GameplaySettings,
  ModuleConfig,
  RuntimeSnapshot,
  SimulationModuleSpec,
  SimulationPhase,
  SimulationPhaseModule,
  StepContext,
  TriggerEventRecord,
} from './types';

/** The declared-property value map fed to one behavior instance (§14.3). */
export type BehaviorProperties = Readonly<Record<string, PropertyValue>>;

// Phase 16.3: the public behavior API. The host builds exactly this object
// each step (`stepBehavior` below is typed by it); the script editor's typings
// (tools/gen-behavior-api.mjs → editor `behavior-api.generated.ts`) are
// generated from these declarations, so their doc comments are what a script
// author reads in completion — keep them author-facing.

/** What a behavior's `step(state, ctx)` receives each fixed step (once per phase it runs in). */
export interface BehaviorContext {
  /**
   * The behavior's id.
   * @graphNode Script id
   */
  readonly behaviorId: string;
  /**
   * The entity carrying this script instance.
   * @graphNode This object
   */
  readonly entityId: string;
  /** The fixed step counter of the run. */
  readonly stepIndex: number;
  /** The phase being stepped: `'intent'`, then `'transform'` (only with owned transforms). */
  readonly phase: SimulationPhase;
  /** The instance's property values (declaration defaults with the object's overrides). */
  readonly properties: BehaviorProperties;
  /** The step's sampled input frame (the same for every phase of the step). */
  readonly action: ActionFrame;
  /** The intents committed so far in this step. */
  readonly intents: IntentSet;
  /** The game's gameplay settings. */
  readonly settings: Readonly<GameplaySettings>;
  /** Physics queries for this step. */
  readonly physics: PhysicsStepClient;
  /** Find entities by tag. */
  readonly tags: BehaviorTagQuery;
  /** Read-only positions of the loaded entities. */
  readonly world: BehaviorWorldView;
  /** Load and switch scenes (projects with a scene catalog). */
  readonly scenes?: BehaviorSceneControl;
  /** The step's input actions by name. */
  readonly input: BehaviorInputView;
  /** An entity's animator (`ctx.animator(id)?.set('speed', 1)`), or null when it has none. */
  readonly animator?: (entityId: string) => BehaviorAnimatorHandle | null;
  /**
   * Last step's clip events and the enter/exit events of the triggers this instance owns.
   * @graphNode skip the event nodes (On trigger, On animator event) read them one by one
   */
  readonly events?: readonly (AnimatorEventRecord | TriggerEventRecord)[];
  /** Named timers of this instance, counted in fixed steps. */
  readonly timers: BehaviorTimers;
  /** Signals (seen one step after they are emitted). */
  readonly signals?: BehaviorSignals;
  /** Phase 19.1: messages to other scripts, with a value (seen one step after they are sent). */
  readonly messages?: BehaviorMessages;
  /** The run's counters, the player's health and object visibility. */
  readonly game?: BehaviorGameState;
  /** Play sounds (presentation only, never part of the simulation). */
  readonly audio?: BehaviorAudio;
  /** Values kept in the player's save. */
  readonly save?: BehaviorSave;
  /**
   * Copy a project prefab into the running game; returns the new root id (or null at an engine limit).
   * @graphNode Spawn prefab
   * @graphLabel prefabId prefab
   */
  readonly spawn?: (
    prefabId: string,
    options: {
      /** Where the copy's root goes: [x, y] (keeping the root's authored z) or [x, y, z]. */
      position: readonly number[];
      /**
       * The root's rotation as a quaternion [x, y, z, w].
       * @graphType list
       */
      rotation?: readonly number[];
      /** The root's scale: one number or [x, y, z]. */
      scale?: number | readonly number[];
    },
  ) => string | null;
  /**
   * Remove a spawned entity at the next step boundary.
   * @graphNode Destroy spawned
   */
  readonly destroy?: (entityId: string) => boolean;
  /** Commit one intent (a transform/pose of an owned entity, or a gameplay intent). */
  emit(intent: BehaviorIntent): void;
  /**
   * Write to the play log (`'info' | 'warn' | 'error'`).
   * @graphNode skip the Log node (debug.log) writes any value as text
   */
  log(level: BehaviorLogLevel, message: string): void;
}

/** What `prepare(cfg)` receives (once per run, before any instance). */
export interface BehaviorPrepareConfig {
  readonly behaviorId: string;
  readonly sourceDigest: string;
  readonly declaration: PropertyDeclaration;
  readonly enginePins: readonly BehaviorEnginePin[];
}

/** What `instantiate(prepared, inst)` receives (once per entity carrying the behavior). */
export interface BehaviorInstanceInfo {
  readonly entityId: string;
  readonly properties: BehaviorProperties;
  readonly tags: BehaviorTagQuery;
}

/**
 * A behavior module's `export default`: only `step` is required; it must be
 * synchronous and return nothing. State is per entity (from `instantiate`).
 */
export interface BehaviorSpec<State = unknown, Prepared = unknown> {
  prepare?(cfg: BehaviorPrepareConfig): Prepared;
  instantiate?(prepared: Prepared, inst: BehaviorInstanceInfo): State;
  step(state: State, ctx: BehaviorContext): void;
  dispose?(prepared: Prepared, state: State): void;
  /**
   * Phase 19.2: what a debugger may read of an instance's state (Play's
   * visual-script debugger: the trace of the step, wire values, variables).
   * Never called during a step; its result is read-only. Optional.
   */
  debug?(state: State): unknown;
}

/** Phase 19.2: one running instance's `debug(state)` answer (Play debugging). */
export interface BehaviorDebugView {
  behaviorId: string;
  entityId: string;
  debug: unknown;
}

/**
 * Phase 15.4: the property values one running behavior instance reads
 * (public and private, declaration order) — the Play debug view's data.
 */
export interface BehaviorPropertyView {
  behaviorId: string;
  properties: { key: string; label: string; type: PropertyType; visibility: 'public' | 'private'; value: PropertyValue }[];
}

/** One compiled engine pin the manifest carries (read-only here). */
export interface BehaviorEnginePin {
  id: string;
  version: string;
  apiVersion: number;
}

/**
 * The host-loaded compiled artifact. `namespace` is the evaluated ESM
 * namespace (or `{ default: spec }`); the runtime never loads or evaluates it.
 * Every other field is a fact the manifest published, copied by the host.
 */
export interface BehaviorArtifact {
  behaviorId: string;
  /** sha256 of the canonical container bytes (64 lowercase hex). */
  sourceDigest: string;
  manifestDigest: string;
  outputDigest: string;
  /** Entities this behavior's source declares (project-model §22.1.6). */
  ownedTransforms: readonly string[];
  /** Type-only engine module IDs the source named. */
  requiredModules: readonly string[];
  /** The engine pins the manifest was compiled against. */
  enginePins: readonly BehaviorEnginePin[];
  /** The evaluated compiled artifact (a `default` export). */
  namespace: unknown;
}

/** The host input for one behavior module. */
export interface BehaviorHostInput {
  declaration: PropertyDeclaration;
  artifact: BehaviorArtifact;
}

/** The behavior module ID prefix (runtime.md §12.1/§14.8.1). */
export const BEHAVIOR_MODULE_PREFIX = 'thirdlight.behavior:';

/** The module ID of one published behavior. */
/**
 * Phase 14.1: the `ownedTransforms` entry meaning "the entity carrying this
 * behavior": each instance may move (transform/pose intents) its own entity —
 * an authored one or a spawned copy, whose runtime id is only known at spawn.
 */
export const BEHAVIOR_SELF_OWNER = '@self';

export function behaviorModuleId(behaviorId: string): string {
  return `${BEHAVIOR_MODULE_PREFIX}${behaviorId}`;
}

/**
 * A behavior-host failure. Behavior-host failures are `config_invalid`
 * (prepare/instantiate), `module_error` (step/frozen-state) or
 * `transform_owner_forbidden` (ownership) with the contract's exact reasons.
 */
export class BehaviorHostError extends Error {
  readonly code: 'config_invalid' | 'module_error' | 'transform_owner_forbidden';
  readonly reason: string;
  readonly detail?: string;
  /** Phase 19.0: the visual-script node that was running (see `graphNodeIdOf`). */
  nodeId?: string;
  constructor(
    code: BehaviorHostError['code'],
    reason: string,
    message: string,
    detail?: string,
  ) {
    super(clipMessage(message));
    this.name = 'BehaviorHostError';
    this.code = code;
    this.reason = reason;
    if (detail !== undefined) this.detail = detail;
  }
}

// Phase 19.1: a node inside a function is `fn:<functionId>/<nodeId>` or `lib:<graphId>/<nodeId>`.
const GRAPH_NODE_ID_RE = /^(?:(?:fn|lib):[A-Za-z0-9_-]{1,64}\/)?[A-Za-z0-9_-]{1,64}$/;
const GRAPH_DETAIL_RE = /^[a-z_]{1,32}$/;

/**
 * Phase 19.0: the visual-script node an error came from. Code generated from
 * a behavior graph tags every error thrown while a node runs with the node's
 * id (`nodeId`); the runtime copies it into the script error (diagnostics,
 * Play) so the failure points at the node. Any other error has none.
 */
export function graphNodeIdOf(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const id = (e as { nodeId?: unknown }).nodeId;
  return typeof id === 'string' && GRAPH_NODE_ID_RE.test(id) ? id : undefined;
}

/** A write to the frozen `prepare` result (§14.3.1 `behavior_state_shared`). */
class FrozenPreparedError extends Error {
  constructor(message: string) {
    super(clipMessage(message));
    this.name = 'FrozenPreparedError';
  }
}

const PROPERTY_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PROPERTY_TYPES: readonly PropertyType[] = [
  'number',
  'boolean',
  'string',
  'enum',
  'vec3',
  'entityRef',
  'assetRef',
];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODULE_BEHAVIOR_ID_RE = /^[a-z0-9-]+$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isThenable(v: unknown): boolean {
  return (
    (typeof v === 'object' && v !== null) || typeof v === 'function'
  ) && typeof (v as { then?: unknown }).then === 'function';
}

/** `ctx.log` message clipping (§14.8: 256 chars, ellipsis). */
export function clipLogMessage(message: string): string {
  const limit = INTENT_LIMITS.logMessageLength;
  if (typeof message !== 'string') return String(message).slice(0, limit);
  if (message.length <= limit) return message;
  return `${message.slice(0, limit - 1)}…`;
}

/**
 * A read-only deep view of the `prepare` result. Plain objects and arrays are
 * frozen and wrapped so any write throws `FrozenPreparedError`, which the host
 * maps to `behavior_state_shared` (§14.3.1). Non-plain values (functions,
 * class instances, Maps) are returned as-is.
 */
function readonlyPrepared(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  const existing = seen.get(value as object);
  if (existing !== undefined) return existing;
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  // Copy-then-freeze (never mutate the author's object): the runtime-owned
  // view is a frozen snapshot of the prepare() result.
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? (value as unknown[]).map((v) => readonlyPrepared(v, seen))
    : {};
  if (!Array.isArray(value)) {
    for (const key of Object.keys(source)) {
      (target as Record<string, unknown>)[key] = readonlyPrepared(source[key], seen);
    }
  }
  Object.freeze(target);
  const proxy = new Proxy(target, {
    get(t, key, receiver): unknown {
      return Reflect.get(t, key, receiver);
    },
    set(): boolean {
      throw new FrozenPreparedError('the prepare() result is read-only (private state belongs to instantiate/step)');
    },
    defineProperty(): boolean {
      throw new FrozenPreparedError('the prepare() result is read-only (private state belongs to instantiate/step)');
    },
    deleteProperty(): boolean {
      throw new FrozenPreparedError('the prepare() result is read-only (private state belongs to instantiate/step)');
    },
  });
  seen.set(value as object, proxy);
  return proxy;
}

function propertyError(key: string, message: string, detail: string): BehaviorHostError {
  return new BehaviorHostError('config_invalid', 'behavior_property_invalid', message, `${key}:${detail}`);
}

/** Validate one stored value against its declaration (§20.5). */
function checkValue(prop: DeclaredProperty, value: unknown): string | null {
  switch (prop.type) {
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'type';
      if (prop.min !== undefined && value < prop.min) return 'value';
      if (prop.max !== undefined && value > prop.max) return 'value';
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : 'type';
    case 'string': {
      if (typeof value !== 'string') return 'type';
      const maxLength = prop.maxLength ?? 256;
      if (value.length > maxLength) return 'value';
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(value)) return 'value';
      return null;
    }
    case 'enum': {
      if (typeof value !== 'string') return 'type';
      return (prop.values ?? []).includes(value) ? null : 'value';
    }
    case 'vec3': {
      if (!Array.isArray(value) || value.length !== 3 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
        return 'type';
      }
      if (prop.bounds) {
        for (let i = 0; i < 3; i += 1) {
          if ((value[i] as number) < prop.bounds.min[i]! || (value[i] as number) > prop.bounds.max[i]!) return 'value';
        }
      }
      return null;
    }
    case 'entityRef':
    case 'assetRef':
      if (value === null) return null;
      return typeof value === 'string' && ID_RE.test(value) ? null : 'type';
  }
}

/**
 * Materialize one entity's whole values map from its stored values and the
 * declaration (defaults filled for absent keys and — phase 15.4 — for private
 * properties, declaration order preserved). An undeclared stored key is never
 * dropped (§20.8.4).
 */
export function materializeBehaviorValues(
  declaration: PropertyDeclaration,
  stored: Readonly<Record<string, unknown>>,
): { ok: true; values: Record<string, PropertyValue> } | { ok: false; error: BehaviorHostError } {
  const out: Record<string, PropertyValue> = {};
  for (const prop of declaration.properties) {
    // Phase 15.4: a private property always reads its declared default (a
    // stored value left from when it was public is inert).
    const has = prop.visibility !== 'private' && Object.prototype.hasOwnProperty.call(stored, prop.key);
    const raw = has ? stored[prop.key] : prop.default;
    const detail = checkValue(prop, raw);
    if (detail !== null) {
      return {
        ok: false,
        error: propertyError(
          prop.key,
          `stored value for "${prop.key}" does not satisfy its declared ${prop.type} constraints (${detail})`,
          detail,
        ),
      };
    }
    out[prop.key] = Array.isArray(raw) ? ([raw[0], raw[1], raw[2]] as [number, number, number]) : (raw as PropertyValue);
  }
  for (const key of Object.keys(stored)) {
    if (!declaration.properties.some((p) => p.key === key)) {
      return {
        ok: false,
        error: propertyError(key, `stored key "${key}" is not declared by this behavior`, 'unknown'),
      };
    }
  }
  return { ok: true, values: out };
}

/** Validate the declaration shape the host was given (§20.5/§20.7). */
function validateDeclaration(declaration: unknown): PropertyDeclaration {
  if (!isPlainObject(declaration) || !Array.isArray(declaration['properties'])) {
    throw new BehaviorHostError('config_invalid', 'behavior_declaration_invalid', 'a declaration must be { properties: [] }');
  }
  const properties = declaration['properties'] as unknown[];
  // Phase 19.1: 0–32 (a script may declare no property at all).
  if (properties.length > 32) {
    throw new BehaviorHostError('config_invalid', 'behavior_declaration_invalid', 'a declaration has at most 32 properties');
  }
  const seen = new Set<string>();
  for (const raw of properties) {
    if (!isPlainObject(raw)) {
      throw new BehaviorHostError('config_invalid', 'behavior_declaration_invalid', 'every property must be an object');
    }
    const key = raw['key'];
    if (typeof key !== 'string' || !PROPERTY_KEY_RE.test(key)) {
      throw new BehaviorHostError('config_invalid', 'behavior_declaration_invalid', `invalid property key ${JSON.stringify(String(key))}`);
    }
    if (seen.has(key)) {
      throw new BehaviorHostError('config_invalid', 'behavior_declaration_invalid', `duplicate property key "${key}"`);
    }
    seen.add(key);
    if (typeof raw['type'] !== 'string' || !PROPERTY_TYPES.includes(raw['type'] as PropertyType)) {
      throw new BehaviorHostError('config_invalid', 'behavior_declaration_invalid', `unknown property type for "${key}"`);
    }
  }
  return declaration as unknown as PropertyDeclaration;
}

/** One behavior instance (one entity carrying `components.behavior`). */
interface BehaviorInstance {
  entityId: string;
  properties: BehaviorProperties;
  state: unknown;
  /** Retained log entries (last `logsRetainedPerInstance`), oldest first. */
  logs: { level: BehaviorLogLevel; message: string }[];
  /** The step index the per-step counters below belong to. */
  counterStep: number;
  /** Accepted `ctx.log` calls in `counterStep`. */
  stepLogs: number;
  /** Committed intents in `counterStep`. */
  stepIntents: number;
  /**
   * Committed channels per entity (phase 21.2: a bit mask tagged with its
   * step, `(counterStep + 1) * 64 + mask`, so nothing is cleared per step):
   * position x/y/z = 1/2/4, rotation 8, scale 16.
   */
  committed: Map<string, number>;
  /** Committed non-entity channels (`control_move`, `control_jump`, `respawn`): the tagged step. */
  committedKinds: Map<string, number>;
  /** Phase 14.2: `ctx.timers` of this instance. */
  timers: InstanceTimers;
  /** Phase 14.2: this step's `ctx.events` (built once per step, shared by its phases). */
  events: readonly (AnimatorEventRecord | TriggerEventRecord)[] | null;
  /** The step `events` belongs to. */
  eventsStep: number;
  /**
   * Phase 21.2: this instance's `ctx` per phase, made once for the runtime's
   * (reused) step context `src` and read live (step, frame, intents, events).
   */
  contexts: Map<SimulationPhase, { src: StepContext; ctx: BehaviorContext }>;
  /** Phase 21.2: `ctx.log` and `ctx.messages` of this instance (made once). */
  log: ((level: BehaviorLogLevel, message: string) => void) | null;
  messages: { src: StepContext; view: BehaviorMessages } | null;
}

/**
 * Build the `SimulationModuleSpec` for one compiled artifact. Register it with
 * `registerSimulationModule` and select its ID in `instantiateRuntime.modules`
 * exactly like any other M2 module; the runtime's phase pipeline, write guard,
 * ownership validation and fail-stop apply unchanged.
 */
export function createBehaviorModuleSpec(input: BehaviorHostInput): SimulationModuleSpec {
  const artifact = input.artifact;
  const behaviorId = artifact.behaviorId;
  if (typeof behaviorId !== 'string' || !MODULE_BEHAVIOR_ID_RE.test(behaviorId)) {
    throw new BehaviorHostError(
      'config_invalid',
      'behavior_module_id',
      `behaviorId ${JSON.stringify(String(behaviorId))} cannot form a behavior module ID`,
    );
  }
  const declaration = validateDeclaration(input.declaration);
  const declaredOwned = [...new Set(artifact.ownedTransforms ?? [])].sort();
  // Phase 14.1: "@self" — each instance owns its own entity's transform.
  const selfOwned = declaredOwned.includes(BEHAVIOR_SELF_OWNER);
  const ownedTransforms = declaredOwned.filter((id) => id !== BEHAVIOR_SELF_OWNER);
  const spec = behaviorSpecOf(artifact.namespace);
  const prepareConfig = Object.freeze({
    behaviorId,
    sourceDigest: artifact.sourceDigest,
    declaration: Object.freeze({ properties: declaration.properties.map((p) => Object.freeze({ ...p })) }),
    enginePins: Object.freeze((artifact.enginePins ?? []).map((p) => Object.freeze({ ...p }))),
  });
  return {
    id: behaviorModuleId(behaviorId),
    phases: declaredOwned.length > 0 ? ['intent', 'transform'] : ['intent'],
    create(snapshot: RuntimeSnapshot, cfg: ModuleConfig): SimulationPhaseModule {
      // Phase 12 (b/c): the tag query — the runtime's live index (it follows
      // scene loads), else one built from the snapshot.
      const tags = cfg.tags ?? createTagQuery(snapshot);
      // Phase 12 (c): with a scene catalog an owner may live in a scene that
      // is not loaded yet; it is checked when its scene loads.
      const deferOwners = snapshot.scenes !== undefined;
      // §14.6: an owner must exist, carry THIS behavior's component, and be
      // neither the camera nor a physics-bearing entity.
      const entityIds = new Set<string>();
      const cameraIds = new Set<string>();
      const physicsIds = new Set<string>();
      const components = new Map<string, { behaviorId?: string; values?: Record<string, unknown> }>();
      // Phase 14.2: the hierarchy of the loaded entities (a script owns the triggers below its entity).
      const parentOf = new Map<string, string>();
      for (const e of snapshot.scene.entities) if (e.parentId !== undefined) parentOf.set(e.id, e.parentId);
      for (const e of snapshot.scene.entities) {
        const c = (e.components as { camera?: unknown; collider?: unknown; controller?: unknown; behavior?: { behaviorId?: string; values?: Record<string, unknown> } });
        if (c.camera !== undefined) cameraIds.add(e.id);
        if (c.collider !== undefined || c.controller !== undefined) physicsIds.add(e.id);
        if (c.behavior?.behaviorId === behaviorId) {
          entityIds.add(e.id);
          components.set(e.id, { behaviorId, values: c.behavior.values ?? {} });
        }
      }
      const checkOwner = (owner: string): void => {
        if (cameraIds.has(owner)) {
          throw new BehaviorHostError('transform_owner_forbidden', 'behavior_ownership_forbidden', `behavior "${behaviorId}" claims the camera entity "${owner}"`, 'camera');
        }
        if (physicsIds.has(owner)) {
          throw new BehaviorHostError('transform_owner_forbidden', 'behavior_ownership_forbidden', `behavior "${behaviorId}" claims physics entity "${owner}"`, 'physics_entity');
        }
        if (!entityIds.has(owner)) {
          throw new BehaviorHostError('transform_owner_forbidden', 'behavior_ownership_forbidden', `behavior "${behaviorId}" claims entity "${owner}" which does not carry this behavior`, 'not_behavior_entity');
        }
      };
      /** Phase 14.1: a carrier that owns itself ("@self") is neither the camera nor a physics body. */
      const checkSelf = (id: string): void => {
        if (cameraIds.has(id)) throw new BehaviorHostError('transform_owner_forbidden', 'behavior_ownership_forbidden', `behavior "${behaviorId}" (@self) is on the camera entity "${id}"`, 'camera');
        if (physicsIds.has(id)) throw new BehaviorHostError('transform_owner_forbidden', 'behavior_ownership_forbidden', `behavior "${behaviorId}" (@self) is on physics entity "${id}"`, 'physics_entity');
      };
      /** The current owners: the listed entities, plus every carrier when "@self" (the runtime re-reads it after loads). */
      let owners: readonly string[] = Object.freeze([...ownedTransforms]);
      const refreshOwners = (): void => {
        if (!selfOwned) return;
        owners = Object.freeze([...new Set([...ownedTransforms, ...[...entityIds].sort()])]);
      };
      if (selfOwned) for (const id of entityIds) checkSelf(id);
      refreshOwners();
      const presentIds = new Set(snapshot.scene.entities.map((e) => e.id));
      for (const owner of ownedTransforms) {
        if (deferOwners && !presentIds.has(owner)) continue;
        checkOwner(owner);
      }

      // prepare: once per runtime instance, before any instance.
      let prepared: unknown;
      try {
        prepared = spec.prepare === undefined ? undefined : spec.prepare(prepareConfig);
      } catch (e) {
        throw new BehaviorHostError('config_invalid', 'behavior_prepare_failed', `behavior "${behaviorId}" prepare() threw: ${messageOf(e)}`);
      }
      const readonlyResult = readonlyPrepared(prepared, new WeakMap());

      // instantiate: once per carrying entity, in snapshot document order.
      const instances: BehaviorInstance[] = [];
      const disposeInstances = (): void => {
        for (const instance of instances) {
          try {
            spec.dispose?.(readonlyResult, instance.state);
          } catch {
            /* a failing dispose must not mask the instantiate failure */
          }
        }
      };
      const instantiateFor = (entityId: string, stored: Record<string, unknown>): BehaviorInstance => {
        const materialized = materializeBehaviorValues(declaration, stored);
        if (!materialized.ok) throw materialized.error;
        const properties = Object.freeze({ ...materialized.values });
        let state: unknown;
        try {
          state = spec.instantiate?.(readonlyResult, Object.freeze({ entityId, properties, tags }));
        } catch (e) {
          throw new BehaviorHostError('config_invalid', 'behavior_instantiate_failed', `behavior "${behaviorId}" instantiate("${entityId}") threw: ${messageOf(e)}`);
        }
        return { entityId, properties, state, logs: [], counterStep: -1, stepLogs: 0, stepIntents: 0, committed: new Map(), committedKinds: new Map(), timers: new InstanceTimers(cfg.fixedStepHz), events: null, eventsStep: -1, contexts: new Map(), log: null, messages: null };
      };
      for (const entityId of [...entityIds].sort((a, b) => orderOf(snapshot, a) - orderOf(snapshot, b))) {
        try {
          instances.push(instantiateFor(entityId, components.get(entityId)?.values ?? {}));
        } catch (e) {
          disposeInstances();
          throw e;
        }
      }

      let disposed = false;
      let logCount = 0;
      let logDropped = 0;

      /** Reset the per-instance per-step counters when the step advances. */
      const beginInstanceStep = (instance: BehaviorInstance, stepIndex: number): void => {
        if (instance.counterStep !== stepIndex) {
          instance.counterStep = stepIndex;
          instance.stepLogs = 0;
          instance.stepIntents = 0;
        }
        // Phase 14.2: the timers due in this step fire (once per step, whatever the phases).
        instance.timers.begin(stepIndex);
      };

      /**
       * Phase 14.2: the triggers an instance owns — one on its own entity, on
       * a descendant of it, or named by one of its entityRef properties.
       */
      const entityRefKeys = declaration.properties.filter((p) => p.type === 'entityRef').map((p) => p.key);
      const ownsTrigger = (instance: BehaviorInstance, triggerId: string): boolean => {
        let cur: string | undefined = triggerId;
        for (let depth = 0; cur !== undefined && depth < 64; depth++) {
          if (cur === instance.entityId) return true;
          cur = parentOf.get(cur);
        }
        return entityRefKeys.some((k) => instance.properties[k] === triggerId);
      };
      /** `ctx.events`: last step's clip events, then the enter/exit events of the owned triggers. */
      const eventsFor = (instance: BehaviorInstance, ctx: StepContext): readonly (AnimatorEventRecord | TriggerEventRecord)[] => {
        if (instance.events !== null && instance.eventsStep === ctx.stepIndex) return instance.events;
        const clips = ctx.animatorEvents ?? NO_EVENTS;
        const triggers = ctx.triggerEvents;
        const owned = triggers === undefined || triggers.length === 0 ? NO_EVENTS : triggers.filter((t: TriggerEventRecord) => ownsTrigger(instance, t.trigger));
        const list = owned.length === 0 ? clips : Object.freeze([...clips, ...owned]);
        instance.events = list;
        instance.eventsStep = ctx.stepIndex;
        return list;
      };

      /** A listed entity, or (with "@self") the instance's own entity. */
      const owns = (instance: BehaviorInstance, entityId: string): boolean => ownedTransforms.includes(entityId) || (selfOwned && entityId === instance.entityId);
      const emitFor = (instance: BehaviorInstance, ctx: StepContext, phase: SimulationPhase) => (raw: unknown): void => {
        // The contract's §14.4 order, per instance: shape → phase → value →
        // ownership → duplicate → caps. The runtime repeats 1–4 and owns the
        // cross-module duplicate and per-step cap before it commits.
        const shape = validateIntentShape(raw);
        if (!shape.ok) throw shape.error;
        const intent = shape.intent;
        const phaseError = validateIntentPhase(intent, phase);
        if (phaseError !== null) throw phaseError;
        const valueError = validateIntentValue(intent);
        if (valueError !== null) throw valueError;
        // The channels this intent writes, as bits (phase 21.2: no per-intent strings or sets).
        const tag = (instance.counterStep + 1) * 64;
        let bits = 0;
        let key: string;
        let map: Map<string, number>;
        if (intent.kind === 'transform' || intent.kind === 'pose') {
          if (!owns(instance, intent.entityId)) {
            throw new BehaviorIntentError('behavior_transform_forbidden', 'not_owner', `entity "${intent.entityId}" is not in this behavior's ownedTransforms`);
          }
          if (intent.kind === 'transform') {
            for (const axis in intent.position) bits |= axis === 'x' ? 1 : axis === 'y' ? 2 : 4;
          } else {
            if (intent.rotation !== undefined) bits |= 8;
            if (intent.scale !== undefined) bits |= 16;
          }
          key = intent.entityId;
          map = instance.committed;
        } else {
          bits = 1;
          key = intent.kind;
          map = instance.committedKinds;
        }
        const stored = map.get(key);
        const have = stored !== undefined && stored >= tag && stored < tag + 64 ? stored - tag : 0;
        if ((have & bits) !== 0) {
          throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `behavior instance "${instance.entityId}" already committed ${channelName(intent, have & bits)} in this step`);
        }
        instance.stepIntents += 1;
        if (instance.stepIntents > INTENT_LIMITS.perInstancePerStep) {
          throw new BehaviorHostIntentLimit(instance.entityId);
        }
        ctx.emit(intent);
        map.set(key, tag + (have | bits));
      };

      const logFor = (instance: BehaviorInstance) => (level: BehaviorLogLevel, message: string): void => {
        if (level !== 'info' && level !== 'warn' && level !== 'error') {
          throw new BehaviorHostError('module_error', 'behavior_log_invalid', `ctx.log level must be one of ${BEHAVIOR_LOG_LEVELS.join(' | ')}`);
        }
        instance.stepLogs += 1;
        if (instance.stepLogs > INTENT_LIMITS.logsPerStepPerInstance) {
          logDropped += 1;
          return;
        }
        logCount += 1;
        const clipped = clipLogMessage(typeof message === 'string' ? message : String(message));
        instance.logs.push({ level, message: clipped });
        if (instance.logs.length > INTENT_LIMITS.logsRetainedPerInstance) instance.logs.shift();
        cfg.behaviorLog?.(level, clipped);
      };

      /** Phase 19.1: `ctx.messages` of one instance (it sends as, and receives for, its entity). */
      const messagesFor = (instance: BehaviorInstance, ctx: StepContext): BehaviorMessages => {
        const control = ctx.messages!;
        return Object.freeze({
          send: (name: string, value?: number | string | boolean, target?: string): boolean => control.send(instance.entityId, name, value, target),
          received: (name: string) => control.received(instance.entityId, name),
        });
      };

      /**
       * Phase 21.2: `ctx.input` of the step's frame — one view per frame object,
       * shared by every instance and phase of the step.
       */
      let inputFrame: ActionFrame | null = null;
      let inputOfFrame: BehaviorInputView | null = null;
      const inputFor = (frame: ActionFrame): BehaviorInputView => {
        if (inputFrame !== frame || inputOfFrame === null) {
          inputFrame = frame;
          inputOfFrame = inputView(frame);
        }
        return inputOfFrame;
      };
      /** Phase 21.2: `ctx.world` per runtime step context (it reads `state.curr` live). */
      const worlds = new WeakMap<StepContext, BehaviorWorldView>();
      const worldFor = (ctx: StepContext): BehaviorWorldView => {
        let w = worlds.get(ctx);
        if (w === undefined) {
          w = worldView(ctx);
          worlds.set(ctx, w);
        }
        return w;
      };

      /**
       * The frozen `ctx` of one instance in one phase. Made once per runtime
       * step context (the runtime reuses one per module and phase); the values
       * that change from step to step are getters reading `src`, so a script
       * sees exactly what a context made for this call would hold.
       */
      const contextFor = (instance: BehaviorInstance, phase: SimulationPhase, src: StepContext): BehaviorContext => {
        // No closures in this function: V8 would allocate their scope at every call, cache hits included.
        const cached = instance.contexts.get(phase);
        if (cached !== undefined && cached.src === src) return cached.ctx;
        return buildContext(instance, phase, src);
      };
      const buildContext = (instance: BehaviorInstance, phase: SimulationPhase, src: StepContext): BehaviorContext => {
        const fields: PropertyDescriptorMap = {
          behaviorId: { value: behaviorId, enumerable: true },
          entityId: { value: instance.entityId, enumerable: true },
          stepIndex: { get: () => src.stepIndex, enumerable: true },
          phase: { value: phase, enumerable: true },
          properties: { value: instance.properties, enumerable: true },
          action: { get: () => src.action, enumerable: true },
          intents: { get: () => src.intents, enumerable: true },
          settings: { value: src.settings, enumerable: true },
          physics: { value: src.physics, enumerable: true },
          tags: { value: tags, enumerable: true },
          world: { value: worldFor(src), enumerable: true },
        };
        if (src.scenes !== undefined) fields['scenes'] = { value: src.scenes, enumerable: true };
        // Phase 9.8: the step's input actions by name.
        fields['input'] = { get: () => inputFor(src.action), enumerable: true };
        // Phase 9.7: animators (`ctx.animator(id)?.set(...)`); last step's clip
        // events and (phase 14.2) the owned triggers' enter/exit events.
        if (src.animators !== undefined) fields['animator'] = { value: src.animators.of, enumerable: true };
        if (src.animators !== undefined || src.triggerEvents !== undefined) fields['events'] = { get: () => eventsFor(instance, src), enumerable: true };
        // Phase 14.2: named step-counted timers of this instance.
        fields['timers'] = { value: instance.timers.api, enumerable: true };
        // Phase 9.9: signals and the run's counters.
        if (src.signals !== undefined) fields['signals'] = { value: src.signals, enumerable: true };
        // Phase 19.1: messages between scripts (this instance sends and receives as its entity).
        if (src.messages !== undefined) fields['messages'] = { value: messagesOf(instance, src), enumerable: true };
        if (src.game !== undefined) fields['game'] = { value: src.game, enumerable: true };
        // Phase 9.10: sounds (played by the host; the simulation never waits on them).
        if (src.audio !== undefined) fields['audio'] = { value: src.audio, enumerable: true };
        // Phase 9.11: values kept in the player's save.
        if (src.save !== undefined) fields['save'] = { value: src.save, enumerable: true };
        // Phase 14.1: prefab copies in the running game.
        if (src.spawner !== undefined) {
          fields['spawn'] = { value: src.spawner.spawn, enumerable: true };
          fields['destroy'] = { value: src.spawner.destroy, enumerable: true };
        }
        fields['emit'] = { value: emitFor(instance, src, phase), enumerable: true };
        if (instance.log === null) instance.log = logFor(instance);
        fields['log'] = { value: instance.log, enumerable: true };
        const ctx = Object.freeze(Object.defineProperties({}, fields)) as BehaviorContext;
        instance.contexts.set(phase, { src, ctx });
        return ctx;
      };
      const messagesOf = (instance: BehaviorInstance, src: StepContext): BehaviorMessages => {
        if (instance.messages === null || instance.messages.src !== src) instance.messages = { src, view: messagesFor(instance, src) };
        return instance.messages.view;
      };

      const stepBehavior = (instance: BehaviorInstance, phase: SimulationPhase, ctx: StepContext): void => {
        beginInstanceStep(instance, ctx.stepIndex);
        const behaviorCtx = contextFor(instance, phase, ctx);
        let result: unknown;
        try {
          result = spec.step(instance.state, behaviorCtx);
        } catch (e) {
          if (e instanceof BehaviorHostIntentLimit || e instanceof BehaviorIntentError || e instanceof BehaviorHostError) {
            throw e;
          }
          // Phase 19.0: a visual script's error keeps the node it came from.
          const withNode = (err: BehaviorHostError): BehaviorHostError => {
            const nodeId = graphNodeIdOf(e);
            if (nodeId !== undefined) err.nodeId = nodeId;
            return err;
          };
          if (e instanceof TimerCallError) {
            throw withNode(new BehaviorHostError('module_error', e.reason, `behavior "${behaviorId}" ${e.message}`));
          }
          if (e instanceof FrozenPreparedError) {
            throw withNode(new BehaviorHostError('module_error', 'behavior_state_shared', `behavior "${behaviorId}" mutated its prepare() result: ${messageOf(e)}`));
          }
          const detail = graphNodeIdOf(e) !== undefined ? (e as { detail?: unknown }).detail : undefined;
          throw withNode(new BehaviorHostError('module_error', 'behavior_step_failed', `behavior "${behaviorId}" step threw: ${messageOf(e)}`, typeof detail === 'string' && GRAPH_DETAIL_RE.test(detail) ? detail : undefined));
        }
        if (result !== undefined) {
          if (isThenable(result)) {
            throw new BehaviorHostError('module_error', 'behavior_step_async', `behavior "${behaviorId}" returned a thenable (step must be synchronous)`);
          }
          throw new BehaviorHostError('module_error', 'behavior_step_async', `behavior "${behaviorId}" returned a value (step must return undefined)`);
        }
      };

      const module: SimulationPhaseModule & {
        behaviorDiagnostics(): { logCount: number; logDropped: number; instanceCount: number };
        behaviorProperties(entityId: string): BehaviorPropertyView | null;
        behaviorDebug(filter: { behaviorId?: string; entityId?: string }): BehaviorDebugView[];
      } = {
        get transformOwners(): readonly string[] {
          return owners;
        },
        /**
         * Phase 14.2: a new run (start, replay) clears every instance's timers.
         * Phase 19.0: and starts every instance with fresh state (dispose, then
         * `instantiate` again with the same properties), so a run — a replay
         * included — begins exactly like the first one and code that runs "on
         * the first step" runs again at the start of each run.
         */
        reset(rctx): void {
          if (rctx.reason !== 'start' && rctx.reason !== 'replay') return;
          for (const instance of instances) {
            instance.timers.clear();
            instance.events = null;
            instance.eventsStep = -1;
            try {
              spec.dispose?.(readonlyResult, instance.state);
            } catch (e) {
              cfg.behaviorLog?.('error', `behavior "${behaviorId}" dispose threw: ${messageOf(e)}`);
            }
            try {
              instance.state = spec.instantiate?.(readonlyResult, Object.freeze({ entityId: instance.entityId, properties: instance.properties, tags }));
            } catch (e) {
              throw new BehaviorHostError('config_invalid', 'behavior_instantiate_failed', `behavior "${behaviorId}" instantiate("${instance.entityId}") threw: ${messageOf(e)}`);
            }
          }
        },
        step(phase: SimulationPhase, ctx: StepContext): void {
          if (disposed) {
            throw new BehaviorHostError('module_error', 'behavior_step_failed', `behavior "${behaviorId}" was stepped after dispose`);
          }
          if (instances.length === 0) return;
          for (let i = 0; i < instances.length; i += 1) stepBehavior(instances[i]!, phase, ctx);
        },
        sceneLoaded(entities): void {
          // Phase 12 (c): new carriers get their instance (document order of
          // the loaded scene); owners that just appeared are checked.
          const added = new Set<string>();
          for (const e of entities) if (e.parentId !== undefined) parentOf.set(e.id, e.parentId);
          for (const e of entities) {
            const c = e.components as { camera?: unknown; collider?: unknown; controller?: unknown; behavior?: { behaviorId?: string; values?: Record<string, unknown> } };
            if (c.camera !== undefined) cameraIds.add(e.id);
            if (c.collider !== undefined || c.controller !== undefined) physicsIds.add(e.id);
            if (c.behavior?.behaviorId === behaviorId) {
              entityIds.add(e.id);
              added.add(e.id);
            }
          }
          for (const e of entities) if (ownedTransforms.includes(e.id)) checkOwner(e.id);
          if (selfOwned) {
            for (const id of added) checkSelf(id);
            refreshOwners();
          }
          for (const e of entities) {
            if (!added.has(e.id)) continue;
            const values = (e.components as { behavior?: { values?: Record<string, unknown> } }).behavior?.values ?? {};
            instances.push(instantiateFor(e.id, values));
          }
        },
        sceneUnloaded(ids): void {
          for (let i = instances.length - 1; i >= 0; i -= 1) {
            const instance = instances[i]!;
            if (!ids.has(instance.entityId)) continue;
            try {
              spec.dispose?.(readonlyResult, instance.state);
            } catch (e) {
              cfg.behaviorLog?.('error', `behavior "${behaviorId}" dispose threw: ${messageOf(e)}`);
            }
            instances.splice(i, 1);
          }
          for (const id of ids) {
            entityIds.delete(id);
            cameraIds.delete(id);
            physicsIds.delete(id);
            parentOf.delete(id);
          }
          refreshOwners();
        },
        dispose(): void {
          if (disposed) return;
          disposed = true;
          for (const instance of instances) {
            try {
              spec.dispose?.(readonlyResult, instance.state);
            } catch (e) {
              cfg.behaviorLog?.('error', `behavior "${behaviorId}" dispose threw: ${messageOf(e)}`);
            }
          }
          instances.length = 0;
        },
        behaviorDiagnostics(): { logCount: number; logDropped: number; instanceCount: number } {
          return { logCount, logDropped, instanceCount: instances.length };
        },
        behaviorDebug(filter: { behaviorId?: string; entityId?: string }): BehaviorDebugView[] {
          // Phase 19.2: only modules that answer (a Play debug build of a visual script).
          if (typeof spec.debug !== 'function' || (filter.behaviorId !== undefined && filter.behaviorId !== behaviorId)) return [];
          const out: BehaviorDebugView[] = [];
          for (const instance of instances) {
            if (filter.entityId !== undefined && instance.entityId !== filter.entityId) continue;
            let debug: unknown = null;
            try {
              debug = spec.debug(instance.state);
            } catch {
              debug = null; // a debugger read never breaks the game
            }
            out.push({ behaviorId, entityId: instance.entityId, debug });
          }
          return out;
        },
        behaviorProperties(entityId: string): BehaviorPropertyView | null {
          const instance = instances.find((i) => i.entityId === entityId);
          if (instance === undefined) return null;
          return {
            behaviorId,
            properties: declaration.properties.map((p) => ({
              key: p.key,
              label: p.label,
              type: p.type,
              visibility: p.visibility === 'private' ? 'private' : 'public',
              value: instance.properties[p.key] ?? null,
            })),
          };
        },
      };
      return module;
    },
  };
}

/**
 * The per-instance intent cap marker. The runtime maps it to
 * `module_error`/`behavior_intent_limit`/`per_instance`; it is thrown before
 * `ctx.emit` so no over-limit intent is ever committed.
 */
export class BehaviorHostIntentLimit extends Error {
  readonly code = 'module_error';
  readonly reason = 'behavior_intent_limit';
  readonly detail = 'per_instance';
  constructor(entityId: string) {
    super(clipMessage(`behavior instance "${entityId}" exceeded the per-instance intent bound`));
    this.name = 'BehaviorHostIntentLimit';
  }
}

const NO_EVENTS: readonly never[] = Object.freeze([]);

/** The first committed channel among `bits` of an intent, as the duplicate message names it. */
function channelName(intent: BehaviorIntent, bits: number): string {
  if (intent.kind === 'transform') {
    for (const axis in intent.position) {
      const bit = axis === 'x' ? 1 : axis === 'y' ? 2 : 4;
      if ((bits & bit) !== 0) return `t:${intent.entityId}:${axis}`;
    }
  }
  if (intent.kind === 'pose') return `p:${intent.entityId}:${(bits & 8) !== 0 ? 'rotation' : 'scale'}`;
  return intent.kind;
}

/**
 * Phase 12 (c): `ctx.world` — read-only transforms of loaded entities, as
 * they stand at this point of the step.
 */
function worldView(ctx: StepContext): BehaviorWorldView {
  const curr = ctx.state.curr;
  return Object.freeze({
    transform(entityId: string) {
      const t = curr.get(entityId);
      if (t === undefined) return undefined;
      return Object.freeze({
        position: Object.freeze([t.position[0], t.position[1], t.position[2]] as const),
        rotation: Object.freeze([t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]] as const),
        scale: Object.freeze([t.scale[0], t.scale[1], t.scale[2]] as const),
      });
    },
  });
}

/** The evaluated `default` export of a compiled artifact namespace. */
/**
 * Phase 12 (b): `ctx.tags` over the loaded (resolved) scene. The entities
 * already carry their effective masks; the registry maps names to bits.
 */
export function createTagQuery(snapshot: RuntimeSnapshot): BehaviorTagQuery & LiveTagIndex {
  return new LiveTagIndex(
    snapshot.tags ?? [],
    snapshot.scene.entities as readonly { id: string; tags?: number }[],
    (reason, message) => new BehaviorHostError('module_error', reason, message),
  );
}

function behaviorSpecOf(namespace: unknown): LoadedBehaviorSpec {
  const ns = namespace as { default?: unknown } | null;
  const candidate = isPlainObject(ns) && 'default' in ns ? ns.default : ns;
  if (!isPlainObject(candidate) || typeof candidate['step'] !== 'function') {
    throw new BehaviorHostError(
      'config_invalid',
      'behavior_artifact_invalid',
      'the compiled artifact namespace must export a spec with a step() function',
    );
  }
  return candidate as unknown as LoadedBehaviorSpec;
}

/** The authored `export default` program as loaded (unchecked; runtime.md §14.3). */
interface LoadedBehaviorSpec {
  prepare?(cfg: unknown): unknown;
  instantiate?(prepared: unknown, inst: unknown): unknown;
  step(state: unknown, ctx: unknown): unknown;
  dispose?(prepared: unknown, state: unknown): void;
  debug?(state: unknown): unknown;
}

function orderOf(snapshot: RuntimeSnapshot, entityId: string): number {
  const i = snapshot.scene.entities.findIndex((e) => e.id === entityId);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
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
    /* non-serializable */
  }
  return clipMessage(String(e));
}

/** One recorded behavior log entry as the runtime ring stores it (§14.8.1). */
export interface BehaviorLogEntry {
  code: typeof BEHAVIOR_LOG_CODE;
  reason: BehaviorLogLevel;
  moduleId: string;
  message: string;
}

export type { BehaviorIntent, IntentSet };

/**
 * Phase 9.8: `ctx.input` — the step's input actions by name. Without named
 * actions in the frame, `move` and `jump` still answer from the frame.
 */
export interface BehaviorInputView {
  /**
   * A button 0/1, a 1D axis −1..1, a 2D axis's length; 0 for an unknown name.
   * @graphPure
   * @graphNode Input value
   * @graphLabel name action
   */
  value(name: string): number;
  /**
   * A 2D axis as [x, y] ([value, 0] for others).
   * @graphPure
   * @graphNode Input vector
   * @graphLabel name action
   */
  vector(name: string): [number, number];
  /**
   * Pressed in this step.
   * @graphPure
   * @graphNode Input pressed
   * @graphLabel name action
   */
  pressed(name: string): boolean;
  /**
   * Released in this step.
   * @graphPure
   * @graphNode Input released
   * @graphLabel name action
   */
  released(name: string): boolean;
  /**
   * Down this step (pressed or held).
   * @graphPure
   * @graphNode Input held
   * @graphLabel name action
   */
  held(name: string): boolean;
}

export function inputView(frame: ActionFrame): BehaviorInputView {
  const get = (name: string): { v: number; x?: number; y?: number; p: string } | undefined => {
    const a = frame.actions?.[name];
    if (a !== undefined) return a;
    if (name === 'move') return { v: frame.moveX, p: 'none' };
    if (name === 'jump') return { v: frame.jump === 'pressed' || frame.jump === 'held' ? 1 : 0, p: frame.jump };
    return undefined;
  };
  return Object.freeze({
    value: (name: string) => get(String(name))?.v ?? 0,
    vector: (name: string): [number, number] => {
      const a = get(String(name));
      return a === undefined ? [0, 0] : [a.x ?? a.v, a.y ?? 0];
    },
    pressed: (name: string) => get(String(name))?.p === 'pressed',
    released: (name: string) => get(String(name))?.p === 'released',
    held: (name: string) => {
      const p = get(String(name))?.p;
      return p === 'pressed' || p === 'held';
    },
  });
}
