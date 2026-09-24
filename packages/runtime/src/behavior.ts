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
  SceneV2,
} from '@thirdlight/project-model';
import type { ActionFrame } from './actions';
import { clipMessage } from './errors';
import { LiveTagIndex } from './scene-set';
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
  BehaviorTagQuery,
  BehaviorWorldView,
  ModuleConfig,
  RuntimeSnapshot,
  SimulationModuleSpec,
  SimulationPhase,
  SimulationPhaseModule,
  StepContext,
} from './types';

/** The declared-property value map fed to one behavior instance (§14.3). */
export type BehaviorProperties = Readonly<Record<string, PropertyValue>>;

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
 * declaration (defaults filled for absent keys, declaration order preserved).
 * An undeclared stored key is never dropped (§20.8.4).
 */
export function materializeBehaviorValues(
  declaration: PropertyDeclaration,
  stored: Readonly<Record<string, unknown>>,
): { ok: true; values: Record<string, PropertyValue> } | { ok: false; error: BehaviorHostError } {
  const out: Record<string, PropertyValue> = {};
  for (const prop of declaration.properties) {
    const has = Object.prototype.hasOwnProperty.call(stored, prop.key);
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
  if (properties.length === 0 || properties.length > 32) {
    throw new BehaviorHostError('config_invalid', 'behavior_declaration_invalid', 'a declaration needs 1–32 properties');
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
  /** Committed channels in `counterStep` (`move`/`jump`/`t:<id>:<axis>`). */
  committed: Set<string>;
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
  const ownedTransforms = [...new Set(artifact.ownedTransforms ?? [])].sort();
  const spec = behaviorSpecOf(artifact.namespace);
  const prepareConfig = Object.freeze({
    behaviorId,
    sourceDigest: artifact.sourceDigest,
    declaration: Object.freeze({ properties: declaration.properties.map((p) => Object.freeze({ ...p })) }),
    enginePins: Object.freeze((artifact.enginePins ?? []).map((p) => Object.freeze({ ...p }))),
  });
  return {
    id: behaviorModuleId(behaviorId),
    phases: ownedTransforms.length > 0 ? ['intent', 'transform'] : ['intent'],
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
        return { entityId, properties, state, logs: [], counterStep: -1, stepLogs: 0, stepIntents: 0, committed: new Set() };
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
          instance.committed.clear();
        }
      };

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
        const channels: string[] = [];
        if (intent.kind === 'transform') {
          if (!ownedTransforms.includes(intent.entityId)) {
            throw new BehaviorIntentError('behavior_transform_forbidden', 'not_owner', `entity "${intent.entityId}" is not in this behavior's ownedTransforms`);
          }
          for (const axis of Object.keys(intent.position)) channels.push(`t:${intent.entityId}:${axis}`);
        } else {
          channels.push(intent.kind);
        }
        for (const channel of channels) {
          if (instance.committed.has(channel)) {
            throw new BehaviorIntentError('behavior_intent_conflict', 'duplicate_intent', `behavior instance "${instance.entityId}" already committed ${channel} in this step`);
          }
        }
        instance.stepIntents += 1;
        if (instance.stepIntents > INTENT_LIMITS.perInstancePerStep) {
          throw new BehaviorHostIntentLimit(instance.entityId);
        }
        ctx.emit(intent);
        for (const channel of channels) instance.committed.add(channel);
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

      const stepBehavior = (instance: BehaviorInstance, phase: SimulationPhase, ctx: StepContext, world: BehaviorWorldView): void => {
        beginInstanceStep(instance, ctx.stepIndex);
        const behaviorCtx = Object.freeze({
          behaviorId,
          entityId: instance.entityId,
          stepIndex: ctx.stepIndex,
          phase,
          properties: instance.properties,
          action: ctx.action,
          intents: ctx.intents,
          settings: ctx.settings,
          physics: ctx.physics,
          tags,
          world,
          ...(ctx.scenes !== undefined ? { scenes: ctx.scenes } : {}),
          // Phase 9.8: the step's input actions by name.
          input: inputView(ctx.action),
          // Phase 9.7: animators (`ctx.animator(id)?.set(...)`) and last step's clip events.
          ...(ctx.animators !== undefined ? { animator: ctx.animators.of, events: ctx.animatorEvents ?? [] } : {}),
          // Phase 9.9: signals and the run's counters.
          ...(ctx.signals !== undefined ? { signals: ctx.signals } : {}),
          ...(ctx.game !== undefined ? { game: ctx.game } : {}),
          emit: emitFor(instance, ctx, phase),
          log: logFor(instance),
        });
        let result: unknown;
        try {
          result = spec.step(instance.state, behaviorCtx);
        } catch (e) {
          if (e instanceof BehaviorHostIntentLimit || e instanceof BehaviorIntentError || e instanceof BehaviorHostError) {
            throw e;
          }
          if (e instanceof FrozenPreparedError) {
            throw new BehaviorHostError('module_error', 'behavior_state_shared', `behavior "${behaviorId}" mutated its prepare() result: ${messageOf(e)}`);
          }
          throw new BehaviorHostError('module_error', 'behavior_step_failed', `behavior "${behaviorId}" step threw: ${messageOf(e)}`);
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
      } = {
        transformOwners: Object.freeze([...ownedTransforms]),
        step(phase: SimulationPhase, ctx: StepContext): void {
          if (disposed) {
            throw new BehaviorHostError('module_error', 'behavior_step_failed', `behavior "${behaviorId}" was stepped after dispose`);
          }
          if (instances.length === 0) return;
          const world = worldView(ctx);
          for (const instance of instances) stepBehavior(instance, phase, ctx, world);
        },
        sceneLoaded(entities): void {
          // Phase 12 (c): new carriers get their instance (document order of
          // the loaded scene); owners that just appeared are checked.
          const added = new Set<string>();
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
          }
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

function behaviorSpecOf(namespace: unknown): BehaviorSpec {
  const ns = namespace as { default?: unknown } | null;
  const candidate = isPlainObject(ns) && 'default' in ns ? ns.default : ns;
  if (!isPlainObject(candidate) || typeof candidate['step'] !== 'function') {
    throw new BehaviorHostError(
      'config_invalid',
      'behavior_artifact_invalid',
      'the compiled artifact namespace must export a spec with a step() function',
    );
  }
  return candidate as unknown as BehaviorSpec;
}

/** The authored `export default` program (runtime.md §14.3). */
interface BehaviorSpec {
  prepare?(cfg: unknown): unknown;
  instantiate?(prepared: unknown, inst: unknown): unknown;
  step(state: unknown, ctx: unknown): unknown;
  dispose?(prepared: unknown, state: unknown): void;
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

/** The v2 scene view this host reads (`components.behavior`). */
export type BehaviorScene = SceneV2;

export type { BehaviorIntent, IntentSet };

/**
 * Phase 9.8: `ctx.input` — the step's input actions by name. Without named
 * actions in the frame, `move` and `jump` still answer from the frame.
 */
export interface BehaviorInputView {
  /** A button 0/1, a 1D axis −1..1, a 2D axis's length; 0 for an unknown name. */
  value(name: string): number;
  /** A 2D axis as [x, y] ([value, 0] for others). */
  vector(name: string): [number, number];
  pressed(name: string): boolean;
  released(name: string): boolean;
  /** Down this step (pressed or held). */
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
