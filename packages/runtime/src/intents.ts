/**
 * The validated-intent API — runtime.md §14.4/§14.5/§14.6/§14.8 (the packet-18
 * behavior contract, promoted at Gate E; implemented by packet 34).
 *
 * A behavior module declares phases (`intent`, and `transform` when it owns
 * entities) and commits **intents** through `ctx.emit`. The runtime owns the
 * per-step `IntentSet`: it validates every intent in the contract's
 * exhaustive order, commits exactly one writer per control channel, applies
 * committed `transform` intents to the owned entity's `curr.position` axes,
 * and turns every rejection into a fail-stop (`module_error`) reason.
 *
 * Pure and closed: no I/O, no three.js, no Node builtins, no
 * editor/backend/workspace edge. The `IntentSet` is the runtime's own
 * step-scoped data; nothing here reads a clock or a global.
 */
import { JUMP_PHASES, type JumpPhase } from './actions';
import { clipMessage } from './errors';
import type { SimulationPhase } from './types';

/**
 * The intent kinds (runtime.md §14.4). Phase 12 (c) adds `respawn`: the
 * player dies and respawns (a game's own fall/kill rules live in scripts).
 */
export type IntentKind = 'control_move' | 'control_jump' | 'transform' | 'respawn';

/** `−1 ≤ value ≤ 1`, quantized at commit (§14.4). */
export interface ControlMoveIntent {
  kind: 'control_move';
  value: number;
}

/** One `JumpPhase` value (§14.4). */
export interface ControlJumpIntent {
  kind: 'control_jump';
  value: JumpPhase;
}

/** A position write on ONE owned entity axis set (§14.4/§14.6). */
export interface TransformIntent {
  kind: 'transform';
  entityId: string;
  position: { x?: number; y?: number; z?: number };
}

/** Phase 12 (c): kill the player (intent phase; ignored unless the run is playing). */
export interface RespawnIntent {
  kind: 'respawn';
}

export type BehaviorIntent = ControlMoveIntent | ControlJumpIntent | TransformIntent | RespawnIntent;

/** One committed transform write in commit order (§14.5). */
export interface IntentTransformWrite {
  moduleId: string;
  entityId: string;
  position: { x?: number; y?: number; z?: number };
}

/** The runtime's per-step intent set (runtime.md §14.5). */
export interface IntentSet {
  readonly stepIndex: number;
  /** The committed `control_move` (quantized) or `null`. */
  readonly move: number | null;
  /** The committed `control_jump` or `null`. */
  readonly jump: JumpPhase | null;
  /** The module ID that committed `move`, or `null`. */
  readonly moveWriter: string | null;
  readonly jumpWriter: string | null;
  /** Committed transform writes, in commit order. */
  readonly transformWrites: readonly IntentTransformWrite[];
  /** Phase 9.9: an upward speed the runtime gives the controller this step (a stomp or a hit). */
  readonly bounce?: number;
}

/**
 * The runtime.md §14.8 intent/log bounds. (The per-instance log bound is a
 * per-step count; the retained ring is the behavior host's per-instance ring.)
 */
export const INTENT_LIMITS = Object.freeze({
  /** Accepted intents per instance per step (defense in depth: the closed maximum). */
  perInstancePerStep: 5,
  /** Accepted intents per step across all instances/modules. */
  perStep: 64,
  /** Transform writes per owned entity per step (one per axis). */
  transformWritesPerEntity: 3,
  /** `ctx.log` calls accepted into the ring per step per instance. */
  logsPerStepPerInstance: 16,
  /** `ctx.log` message length (truncated with an ellipsis). */
  logMessageLength: 256,
  /** Log entries retained per instance (last-N ring). */
  logsRetainedPerInstance: 32,
  /** Behavior modules per runtime instance. */
  behaviorModules: 64,
} as const);

/** The `ctx.log` levels (runtime.md §14.3). */
export type BehaviorLogLevel = 'info' | 'warn' | 'error';

export const BEHAVIOR_LOG_LEVELS: readonly BehaviorLogLevel[] = ['info', 'warn', 'error'];

/** A bounded intent/log diagnostic entry the runtime ring records. */
export const BEHAVIOR_LOG_CODE = 'behavior_log';

/**
 * An intent rejection (`module_error` fail-stop). The `reason`/`detail` pair
 * is the contract's §14.4 table; the message is bounded and log-safe.
 */
export class BehaviorIntentError extends Error {
  readonly code = 'module_error';
  readonly reason: string;
  readonly detail: string;
  constructor(reason: string, detail: string, message: string) {
    super(clipMessage(message));
    this.name = 'BehaviorIntentError';
    this.reason = reason;
    this.detail = detail;
  }
}

/** The canonical key order of each intent shape (§14.4). */
const INTENT_KEYS: Record<IntentKind, readonly string[]> = {
  control_move: ['kind', 'value'],
  control_jump: ['kind', 'value'],
  transform: ['kind', 'entityId', 'position'],
  respawn: ['kind'],
};

const POSITION_KEYS = new Set(['x', 'y', 'z']);
const MAX_POSITION = 1e6;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function invalid(detail: string, message: string): BehaviorIntentError {
  return new BehaviorIntentError('behavior_intent_invalid', detail, message);
}

/**
 * Step 1 of the validation order: strict shape (kind, fields, field types,
 * unknown fields, canonical key order). Returns the parsed intent or the
 * failure. Membership/range checks are the caller's steps 3+.
 */
export type IntentShapeResult =
  | { ok: true; kind: IntentKind; intent: BehaviorIntent }
  | { ok: false; error: BehaviorIntentError };

export function validateIntentShape(value: unknown): IntentShapeResult {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('shape', 'an intent must be an object') };
  }
  const kind = value['kind'];
  if (kind !== 'control_move' && kind !== 'control_jump' && kind !== 'transform' && kind !== 'respawn') {
    return { ok: false, error: invalid('shape', `unknown intent kind ${JSON.stringify(String(kind))}`) };
  }
  const keys = Object.keys(value);
  const allowed = INTENT_KEYS[kind];
  for (const key of keys) {
    if (!allowed.includes(key)) {
      return { ok: false, error: invalid('shape', `unknown ${kind} field "${key}" (strict shape)`) };
    }
  }
  // Canonical key order is also enforced as a data contract: the emitted
  // object's insertion order must match the contract's canonical order.
  if (keys.length !== allowed.length || keys.some((k, i) => k !== allowed[i])) {
    return { ok: false, error: invalid('shape', `intent fields must be in canonical order (${allowed.join(', ')})`) };
  }
  if (kind === 'respawn') return { ok: true, kind, intent: { kind } };
  if (kind === 'control_move') {
    if (typeof value['value'] !== 'number') {
      return { ok: false, error: invalid('shape', 'control_move.value must be a number') };
    }
    return { ok: true, kind, intent: { kind, value: value['value'] } };
  }
  if (kind === 'control_jump') {
    if (typeof value['value'] !== 'string') {
      return { ok: false, error: invalid('shape', 'control_jump.value must be a JumpPhase string') };
    }
    return { ok: true, kind, intent: { kind, value: value['value'] as JumpPhase } };
  }
  if (typeof value['entityId'] !== 'string') {
    return { ok: false, error: invalid('shape', 'transform.entityId must be a string') };
  }
  const position = value['position'];
  if (!isPlainObject(position)) {
    return { ok: false, error: invalid('shape', 'transform.position must be an object') };
  }
  const posKeys = Object.keys(position);
  if (posKeys.length === 0) {
    return { ok: false, error: invalid('shape', 'transform.position needs at least one axis') };
  }
  for (const key of posKeys) {
    if (!POSITION_KEYS.has(key)) {
      return { ok: false, error: invalid('shape', `unknown transform.position axis "${key}"`) };
    }
  }
  const order = ['x', 'y', 'z'].filter((k) => posKeys.includes(k));
  if (posKeys.length !== order.length || posKeys.some((k, i) => k !== order[i])) {
    return { ok: false, error: invalid('shape', `transform.position axes must be in x, y, z order`) };
  }
  for (const key of posKeys) {
    if (typeof position[key] !== 'number') {
      return { ok: false, error: invalid('shape', `transform.position.${key} must be a number`) };
    }
  }
  const parsed: { x?: number; y?: number; z?: number } = {};
  for (const key of posKeys) parsed[key as 'x' | 'y' | 'z'] = position[key] as number;
  return { ok: true, kind, intent: { kind, entityId: value['entityId'], position: parsed } };
}

/** The runtime's phase names this module reasons about (type-only view). */
export type SimulationPhaseName = 'intent' | 'controller' | 'transform';

/**
 * Step 2: phase applicability. `control_*` is valid only in `intent`,
 * `transform` only in `transform` (runtime.md §14.4). M3 appends the
 * `gameplay`/`camera` phases to `SimulationPhase`; neither accepts an intent
 * here, so a widened `SimulationPhase` argument is safe (any non-`intent`/
 * non-`transform` phase yields the same `phase` rejection).
 */
export function validateIntentPhase(intent: BehaviorIntent, phase: SimulationPhase): BehaviorIntentError | null {
  if (intent.kind === 'transform') {
    if (phase !== 'transform') {
      return invalid('phase', 'a transform intent is valid only in the transform phase');
    }
    return null;
  }
  if (phase !== 'intent') {
    return invalid('phase', `a ${intent.kind === 'respawn' ? 'respawn' : 'control'} intent is valid only in the intent phase`);
  }
  return null;
}

/** Step 3: value/membership/range validation (shape already accepted). */
export function validateIntentValue(intent: BehaviorIntent): BehaviorIntentError | null {
  if (intent.kind === 'control_move') {
    if (!Number.isFinite(intent.value) || intent.value < -1 || intent.value > 1) {
      return invalid('value', 'control_move.value must be finite and within [-1, 1]');
    }
    return null;
  }
  if (intent.kind === 'control_jump') {
    if (!JUMP_PHASES.includes(intent.value)) {
      return invalid('value', `control_jump.value must be one of ${JUMP_PHASES.join(' | ')}`);
    }
    return null;
  }
  if (intent.kind === 'respawn') return null;
  const position = intent.position;
  const axes = Object.keys(position);
  if (axes.length === 0) return invalid('value', 'transform.position needs at least one axis');
  for (const axis of axes) {
    const v = position[axis as 'x' | 'y' | 'z'];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return invalid('value', `transform.position.${axis} must be finite`);
    }
    if (Math.abs(v) > MAX_POSITION) {
      return invalid('value', `transform.position.${axis} must satisfy |v| <= ${MAX_POSITION}`);
    }
  }
  return null;
}

/** The `control_move` commit quantization (§14.4, matching §12.5.3). */
export function quantizeIntentMove(v: number): number {
  const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
  const q = Math.round(clamped * 1e4) / 1e4;
  return q === 0 ? 0 : q;
}

/** The frozen empty intent set of a step before any commit. */
export function emptyIntentSet(stepIndex: number): IntentSet {
  return Object.freeze({
    stepIndex,
    move: null,
    jump: null,
    moveWriter: null,
    jumpWriter: null,
    transformWrites: Object.freeze([]),
  });
}
