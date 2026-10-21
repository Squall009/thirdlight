/**
 * Running a script's hooks: `step`, the callbacks and `dispose`, each for one
 * instance (one object carrying the script).
 *
 * A hook that throws (or breaks the hook contract: an async step, a returned
 * value) switches off that one instance for the rest of the run, at the
 * throw: its later hooks in this step and every later step are skipped, its
 * `dispose` runs once, and the runtime lists the error with the script, the
 * object and where in the compiled script it was thrown. Every other
 * instance, script and engine system keeps stepping, so one broken object
 * never freezes the game. The switch-off point is the throw itself, which
 * the fixed step order makes the same in every replay. What the hook did
 * before it threw (intents committed through `ctx.emit`, sounds, messages,
 * spawns) stands, as in any engine where an exception ends a method early.
 * A run restart makes the instance again from `instantiate` and switches it
 * back on. Only the run's first start fails on an `instantiate` that throws;
 * an object that arrives later (a loaded scene, a spawned copy) or a restart
 * gets its instance switched off the same way, and the load or spawn
 * completes.
 */
import type { BehaviorEntityHandle } from './entity-access';
import { EntityAccessError } from './entity-access';
import { DebugCallError } from './debug-commands';
import { RandomCallError, type InstanceRandom } from './random';
import { TimerCallError, type InstanceTimers } from './timers';
import { BehaviorIntentError, type BehaviorLogLevel } from './intents';
import { BehaviorHostError, BehaviorHostIntentLimit, compiledFramesOf, FrozenPreparedError, GRAPH_DETAIL_RE, graphNodeIdOf, isThenable, messageOf } from './behavior-errors';
import type { ErrorCode } from './errors';
import type { BehaviorCallbackName, BehaviorContext, BehaviorProperties, LoadedBehaviorSpec } from './behavior';
import type { AnimatorEventRecord, BehaviorMessages, ModuleConfig, PrimitiveEventRecord, SimulationPhase, StepContext, TriggerEventRecord } from './types';

/** One behavior instance (one entity carrying `components.behavior`). */
export interface BehaviorInstance {
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
   * Committed channels per entity (a bit mask tagged with its step,
   * `(counterStep + 1) * 64 + mask`, so nothing is cleared per step):
   * position x/y/z = 1/2/4, rotation 8, scale 16.
   */
  committed: Map<string, number>;
  /** Committed non-entity channels (`control_move`, `control_jump`, `respawn`): the tagged step. */
  committedKinds: Map<string, number>;
  /** `ctx.timers` of this instance. */
  timers: InstanceTimers;
  /** This step's `ctx.events` (built once per step, shared by its phases). */
  events: readonly (AnimatorEventRecord | TriggerEventRecord | PrimitiveEventRecord)[] | null;
  /** The step `events` belongs to. */
  eventsStep: number;
  /**
   * This instance's `ctx` per phase, made once for the runtime's
   * (reused) step context `src` and read live (step, frame, intents, events).
   */
  contexts: Map<SimulationPhase, { src: StepContext; ctx: BehaviorContext }>;
  /** `ctx.log` and `ctx.messages` of this instance (made once). */
  log: ((level: BehaviorLogLevel, message: string) => void) | null;
  messages: { src: StepContext; view: BehaviorMessages } | null;
  /** `ctx.random` of this instance (made on first use). */
  random: InstanceRandom | null;
  /** `ctx.entity` of this instance (it writes as this script on its object). */
  entity: { src: StepContext; fn: (ref: string | null) => BehaviorEntityHandle | null } | null;
  /** `onEnable` was the last lifecycle callback it got (its object is on, as far as the script knows). */
  enabled: boolean;
  /** One of its hooks threw: no hook of it runs again until a run restart makes it anew. */
  off: boolean;
  /** Its `dispose` ran (at most once per `instantiate`). */
  disposed: boolean;
}

export interface HookRunnerInput {
  behaviorId: string;
  spec: LoadedBehaviorSpec;
  /** The read-only `prepare` result every hook gets. */
  prepared: unknown;
  /** The script has `onTriggerEnter` or `onTriggerExit`. */
  triggerCallbacks: boolean;
  /** Reset the instance's per-step counters and fire its due timers. */
  beginInstanceStep(instance: BehaviorInstance, stepIndex: number): void;
  contextFor(instance: BehaviorInstance, phase: SimulationPhase, src: StepContext): BehaviorContext;
  /** The trigger or object is the instance's own (on it, below it, or named by one of its object properties). */
  ownsTrigger(instance: BehaviorInstance, id: string): boolean;
  cfg: Pick<ModuleConfig, 'behaviorLog' | 'scriptStopped'>;
}

export interface HookRunner {
  stepBehavior(instance: BehaviorInstance, phase: SimulationPhase, ctx: StepContext): void;
  /** Run one callback of an instance (in the intent phase; `event` for the event callbacks). */
  callback(instance: BehaviorInstance, name: BehaviorCallbackName, src: StepContext, event?: unknown): void;
  /** The object's switched-on state changed since the script last heard: onEnable / onDisable. */
  lifecycle(instance: BehaviorInstance, src: StepContext): void;
  /** The event callbacks of one ticking instance, in their fixed order. */
  dispatchEvents(instance: BehaviorInstance, src: StepContext): void;
  /** Run the instance's `dispose` once (a throw is a log line: the object is leaving anyway). */
  disposeInstance(instance: BehaviorInstance): void;
  /**
   * `instantiate` threw for an object that arrived after the run's start (a loaded scene, a spawned copy)
   * or at a run restart: that instance stays switched off, the error is reported, and the run goes on.
   */
  instantiateFailed(instance: BehaviorInstance, failure: Error): void;
}

export function createHookRunner(input: HookRunnerInput): HookRunner {
  const { behaviorId, spec, prepared, triggerCallbacks, beginInstanceStep, contextFor, ownsTrigger, cfg } = input;
  const hasStep = typeof spec.step === 'function';

  /** A script error thrown by `step` or a callback (`what`), as the host's failure. */
  const scriptFailure = (e: unknown, what: string): Error => {
    if (e instanceof BehaviorHostIntentLimit || e instanceof BehaviorIntentError || e instanceof BehaviorHostError) {
      return e;
    }
    // A visual script's error keeps the node it came from.
    // And every error where in the compiled script it was thrown.
    const withNode = (err: BehaviorHostError): BehaviorHostError => {
      const nodeId = graphNodeIdOf(e);
      if (nodeId !== undefined) err.nodeId = nodeId;
      const frames = compiledFramesOf(e);
      if (frames.length > 0) err.frames = frames;
      return err;
    };
    if (e instanceof TimerCallError || e instanceof RandomCallError || e instanceof DebugCallError || e instanceof EntityAccessError) {
      return withNode(new BehaviorHostError('module_error', e.reason, `behavior "${behaviorId}" ${e.message}`));
    }
    if (e instanceof FrozenPreparedError) {
      return withNode(new BehaviorHostError('module_error', 'behavior_state_shared', `behavior "${behaviorId}" mutated its prepare() result: ${messageOf(e)}`));
    }
    const detail = graphNodeIdOf(e) !== undefined ? (e as { detail?: unknown }).detail : undefined;
    return withNode(new BehaviorHostError('module_error', 'behavior_step_failed', `behavior "${behaviorId}" ${what} threw: ${messageOf(e)}`, typeof detail === 'string' && GRAPH_DETAIL_RE.test(detail) ? detail : undefined));
  };
  const resultFailure = (result: unknown, what: string): BehaviorHostError =>
    isThenable(result)
      ? new BehaviorHostError('module_error', 'behavior_step_async', `behavior "${behaviorId}" ${what === 'step' ? '' : `${what} `}returned a thenable (${what} must be synchronous)`)
      : new BehaviorHostError('module_error', 'behavior_step_async', `behavior "${behaviorId}" ${what === 'step' ? '' : `${what} `}returned a value (${what} must return undefined)`);

  const disposeInstance = (instance: BehaviorInstance): void => {
    if (instance.disposed) return;
    instance.disposed = true;
    try {
      spec.dispose?.(prepared, instance.state);
    } catch (e) {
      cfg.behaviorLog?.('error', `behavior "${behaviorId}" dispose threw: ${messageOf(e)}`, compiledFramesOf(e, 1)[0]);
    }
  };

  /** Report a switched-off instance once (the runtime fills in the step when the hook ran outside one). */
  const report = (instance: BehaviorInstance, failure: Error, hook: string, phase?: SimulationPhase, stepIndex?: number): void => {
    const f = failure as Error & { code?: unknown; reason?: unknown; detail?: unknown; nodeId?: unknown; frames?: unknown };
    const frames = compiledFramesOf(f);
    const stop = {
      behaviorId,
      entityId: instance.entityId,
      hook,
      ...(phase !== undefined ? { phase } : {}),
      ...(stepIndex !== undefined ? { stepIndex } : {}),
      code: (typeof f.code === 'string' ? f.code : 'module_error') as ErrorCode,
      reason: typeof f.reason === 'string' ? f.reason : 'behavior_step_failed',
      message: messageOf(f),
      ...(typeof f.detail === 'string' ? { detail: f.detail } : {}),
      ...(typeof f.nodeId === 'string' ? { nodeId: f.nodeId } : {}),
      ...(frames.length > 0 ? { frames } : {}),
    };
    if (cfg.scriptStopped !== undefined) cfg.scriptStopped(stop);
    else cfg.behaviorLog?.('error', `${stop.message} (switched off on "${instance.entityId}")`, frames[0]);
  };
  /** Switch the instance off at its failing hook, report it once, and let it clean up. */
  const switchOff = (instance: BehaviorInstance, failure: Error, hook: string, phase: SimulationPhase, stepIndex: number): void => {
    instance.off = true;
    report(instance, failure, hook, phase, stepIndex);
    disposeInstance(instance);
  };
  /** An instance made after the run's start whose `instantiate` threw: it is switched off (with no state to dispose). */
  const instantiateFailed = (instance: BehaviorInstance, failure: Error): void => {
    instance.off = true;
    instance.disposed = true;
    report(instance, failure, 'instantiate');
  };

  const stepBehavior = (instance: BehaviorInstance, phase: SimulationPhase, ctx: StepContext): void => {
    if (instance.off) return;
    beginInstanceStep(instance, ctx.stepIndex);
    if (!hasStep) return;
    const behaviorCtx = contextFor(instance, phase, ctx);
    let result: unknown;
    try {
      result = spec.step!(instance.state, behaviorCtx);
    } catch (e) {
      switchOff(instance, scriptFailure(e, 'step'), 'step', phase, ctx.stepIndex);
      return;
    }
    if (result !== undefined) switchOff(instance, resultFailure(result, 'step'), 'step', phase, ctx.stepIndex);
  };

  const callback = (instance: BehaviorInstance, name: BehaviorCallbackName, src: StepContext, event?: unknown): void => {
    if (instance.off) return;
    const fn = spec[name];
    if (typeof fn !== 'function') return;
    beginInstanceStep(instance, src.stepIndex);
    const behaviorCtx = contextFor(instance, 'intent', src);
    let result: unknown;
    try {
      result = event === undefined ? (fn as (s: unknown, c: unknown) => unknown).call(spec, instance.state, behaviorCtx) : (fn as (s: unknown, e: unknown, c: unknown) => unknown).call(spec, instance.state, event, behaviorCtx);
    } catch (e) {
      switchOff(instance, scriptFailure(e, name), name, 'intent', src.stepIndex);
      return;
    }
    if (result !== undefined) switchOff(instance, resultFailure(result, name), name, 'intent', src.stepIndex);
  };

  const lifecycle = (instance: BehaviorInstance, src: StepContext): void => {
    const on = src.inactiveEntities?.has(instance.entityId) !== true;
    if (on === instance.enabled) return;
    instance.enabled = on;
    callback(instance, on ? 'onEnable' : 'onDisable', src);
  };

  const dispatchEvents = (instance: BehaviorInstance, src: StepContext): void => {
    if (triggerCallbacks) {
      const list = src.triggerEvents;
      if (list !== undefined) for (let i = 0; i < list.length; i += 1) {
        const t = list[i]!;
        if (ownsTrigger(instance, t.trigger)) callback(instance, t.type === 'enter' ? 'onTriggerEnter' : 'onTriggerExit', src, t);
      }
    }
    if (spec.onContact !== undefined) {
      const list = src.primitiveEvents;
      if (list !== undefined) for (let i = 0; i < list.length; i += 1) {
        const e = list[i]!;
        if ((e.type === 'contact' || e.type === 'separate') && ownsTrigger(instance, e.entity)) callback(instance, 'onContact', src, e);
      }
    }
    if (spec.onMessage !== undefined) {
      const list = src.messages?.all?.(instance.entityId);
      if (list !== undefined) for (let i = 0; i < list.length; i += 1) callback(instance, 'onMessage', src, list[i]);
    }
    if (spec.onUiEvent !== undefined) {
      const list = src.ui?.events();
      if (list !== undefined) for (let i = 0; i < list.length; i += 1) callback(instance, 'onUiEvent', src, list[i]);
    }
    if (spec.onAnimatorEvent !== undefined) {
      const list = src.animatorEvents;
      if (list !== undefined) for (let i = 0; i < list.length; i += 1) if (ownsTrigger(instance, list[i]!.entityId)) callback(instance, 'onAnimatorEvent', src, list[i]);
    }
  };

  return { stepBehavior, callback, lifecycle, dispatchEvents, disposeInstance, instantiateFailed };
}
