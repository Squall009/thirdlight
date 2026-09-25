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
export type IntentKind = 'control_move' | 'control_jump' | 'transform' | 'pose' | 'respawn';

/**
 * `−1 ≤ value ≤ 1`, quantized at commit (§14.4).
 * @graphNode Control move
 * @graphPhase intent
 */
export interface ControlMoveIntent {
  kind: 'control_move';
  value: number;
}

/**
 * One `JumpPhase` value (§14.4).
 * @graphNode Control jump
 * @graphPhase intent
 */
export interface ControlJumpIntent {
  kind: 'control_jump';
  value: JumpPhase;
}

/**
 * A position write on ONE owned entity axis set (§14.4/§14.6).
 * @graphNode Move object
 * @graphPhase transform
 */
export interface TransformIntent {
  kind: 'transform';
  entityId: string;
  position: { x?: number; y?: number; z?: number };
}

/**
 * Phase 9.9 (wrap-up): an owned entity's rotation (degrees: yaw about +Y,
 * pitch about +X, roll about +Z, applied yaw · pitch · roll; missing axes are
 * 0) and/or scale (one number, or [x, y, z]) — transform phase only, visual
 * (colliders keep their shape). Fields in the order kind, entityId,
 * rotation, scale; at least one of rotation and scale.
 * @graphNode Pose object
 * @graphPhase transform
 */
export interface PoseIntent {
  kind: 'pose';
  entityId: string;
  rotation?: { yaw?: number; pitch?: number; roll?: number };
  scale?: number | [number, number, number];
}

/**
 * Phase 12 (c): kill the player (intent phase; ignored unless the run is playing).
 * @graphNode Respawn player
 * @graphPhase intent
 */
export interface RespawnIntent {
  kind: 'respawn';
}

export type BehaviorIntent = ControlMoveIntent | ControlJumpIntent | TransformIntent | PoseIntent | RespawnIntent;

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
  pose: ['kind', 'entityId', 'rotation', 'scale'],
  respawn: ['kind'],
};
const ROTATION_KEYS = ['yaw', 'pitch', 'roll'] as const;
const MAX_DEGREES = 1e6;
const SCALE_MIN = 0.001;
const SCALE_MAX = 1000;

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

const hasOwn = Object.prototype.hasOwnProperty;
const isNumber = (v: unknown): boolean => typeof v === 'number';

/**
 * Phase 21.2: the last accepted shape. The behavior host validates a script's
 * intent and hands the parsed copy (never seen by the script) to the runtime,
 * which validates it again (§14.4 steps 1–4 are repeated); that second call
 * returns the same result instead of copying the copy.
 */
let lastParsed: BehaviorIntent | null = null;
let lastResult: IntentShapeResult | null = null;

function accepted(kind: IntentKind, intent: BehaviorIntent): IntentShapeResult {
  const result: IntentShapeResult = { ok: true, kind, intent };
  lastParsed = intent;
  lastResult = result;
  return result;
}

/** Own enumerable keys, in `Object.keys` order, without making the array (phase 21.2). */
function firstUnknownKey(value: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key in value) {
    if (!hasOwn.call(value, key)) continue;
    if (!allowed.includes(key)) return key;
  }
  return null;
}

/** The keys are exactly `allowed`, in that order. */
function exactOrder(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  let i = 0;
  for (const key in value) {
    if (!hasOwn.call(value, key)) continue;
    if (allowed[i] !== key) return false;
    i += 1;
  }
  return i === allowed.length;
}

/** The keys are all in `order`, each at most once and in that order; returns how many (−1: not). */
function inOrderCount(value: Record<string, unknown>, order: readonly string[]): number {
  let last = -1;
  let n = 0;
  for (const key in value) {
    if (!hasOwn.call(value, key)) continue;
    const rank = order.indexOf(key);
    if (rank <= last) return -1;
    last = rank;
    n += 1;
  }
  return n;
}

export function validateIntentShape(value: unknown): IntentShapeResult {
  if (value !== null && value === lastParsed && lastResult !== null) return lastResult;
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('shape', 'an intent must be an object') };
  }
  const kind = value['kind'];
  if (kind !== 'control_move' && kind !== 'control_jump' && kind !== 'transform' && kind !== 'pose' && kind !== 'respawn') {
    return { ok: false, error: invalid('shape', `unknown intent kind ${JSON.stringify(String(kind))}`) };
  }
  if (kind === 'pose') return poseShape(value);
  const allowed = INTENT_KEYS[kind];
  const unknownKey = firstUnknownKey(value, allowed);
  if (unknownKey !== null) {
    return { ok: false, error: invalid('shape', `unknown ${kind} field "${unknownKey}" (strict shape)`) };
  }
  // Canonical key order is also enforced as a data contract: the emitted
  // object's insertion order must match the contract's canonical order.
  if (!exactOrder(value, allowed)) {
    return { ok: false, error: invalid('shape', `intent fields must be in canonical order (${allowed.join(', ')})`) };
  }
  if (kind === 'respawn') return accepted(kind, { kind });
  if (kind === 'control_move') {
    if (typeof value['value'] !== 'number') {
      return { ok: false, error: invalid('shape', 'control_move.value must be a number') };
    }
    return accepted(kind, { kind, value: value['value'] });
  }
  if (kind === 'control_jump') {
    if (typeof value['value'] !== 'string') {
      return { ok: false, error: invalid('shape', 'control_jump.value must be a JumpPhase string') };
    }
    return accepted(kind, { kind, value: value['value'] as JumpPhase });
  }
  if (typeof value['entityId'] !== 'string') {
    return { ok: false, error: invalid('shape', 'transform.entityId must be a string') };
  }
  const position = value['position'];
  if (!isPlainObject(position)) {
    return { ok: false, error: invalid('shape', 'transform.position must be an object') };
  }
  let axes = 0;
  for (const key in position) if (hasOwn.call(position, key)) axes += 1;
  if (axes === 0) {
    return { ok: false, error: invalid('shape', 'transform.position needs at least one axis') };
  }
  for (const key in position) {
    if (hasOwn.call(position, key) && !POSITION_KEYS.has(key)) {
      return { ok: false, error: invalid('shape', `unknown transform.position axis "${key}"`) };
    }
  }
  if (inOrderCount(position, AXIS_ORDER) !== axes) {
    return { ok: false, error: invalid('shape', `transform.position axes must be in x, y, z order`) };
  }
  for (const key in position) {
    if (hasOwn.call(position, key) && typeof position[key] !== 'number') {
      return { ok: false, error: invalid('shape', `transform.position.${key} must be a number`) };
    }
  }
  const parsed: { x?: number; y?: number; z?: number } = {};
  for (const key in position) if (hasOwn.call(position, key)) parsed[key as 'x' | 'y' | 'z'] = position[key] as number;
  return accepted(kind, { kind, entityId: value['entityId'], position: parsed });
}

const AXIS_ORDER: readonly string[] = ['x', 'y', 'z'];

function poseShape(value: Record<string, unknown>): IntentShapeResult {
  let keys = 0;
  for (const key in value) if (hasOwn.call(value, key)) keys += 1;
  if (inOrderCount(value, INTENT_KEYS.pose) !== keys) {
    return { ok: false, error: invalid('shape', `pose fields must be among and in the order ${INTENT_KEYS.pose.join(', ')}`) };
  }
  if (typeof value['entityId'] !== 'string') return { ok: false, error: invalid('shape', 'pose.entityId must be a string') };
  if (value['rotation'] === undefined && value['scale'] === undefined) return { ok: false, error: invalid('shape', 'a pose needs rotation or scale') };
  const intent: PoseIntent = { kind: 'pose', entityId: value['entityId'] };
  const r = value['rotation'];
  if (r !== undefined) {
    if (!isPlainObject(r)) return { ok: false, error: invalid('shape', 'pose.rotation must be an object') };
    let rk = 0;
    for (const key in r) if (hasOwn.call(r, key)) rk += 1;
    if (rk === 0 || inOrderCount(r, ROTATION_KEYS) !== rk) {
      return { ok: false, error: invalid('shape', 'pose.rotation has yaw, pitch and/or roll, in that order') };
    }
    for (const key in r) {
      if (hasOwn.call(r, key) && typeof r[key] !== 'number') return { ok: false, error: invalid('shape', 'pose.rotation angles must be numbers') };
    }
    const rotation: { yaw?: number; pitch?: number; roll?: number } = {};
    for (const key in r) if (hasOwn.call(r, key)) rotation[key as 'yaw' | 'pitch' | 'roll'] = r[key] as number;
    intent.rotation = rotation;
  }
  const s = value['scale'];
  if (s !== undefined) {
    if (typeof s === 'number') intent.scale = s;
    else if (Array.isArray(s) && s.length === 3 && s.every(isNumber)) intent.scale = [s[0] as number, s[1] as number, s[2] as number];
    else return { ok: false, error: invalid('shape', 'pose.scale must be a number or [x, y, z]') };
  }
  return accepted('pose', intent);
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
  if (intent.kind === 'transform' || intent.kind === 'pose') {
    if (phase !== 'transform') {
      return invalid('phase', `a ${intent.kind} intent is valid only in the transform phase`);
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
  if (intent.kind === 'pose') {
    // Phase 21.2: walked in place (no entries/arrays per intent).
    const rotation = intent.rotation;
    if (rotation !== undefined) {
      for (const axis in rotation) {
        if (!hasOwn.call(rotation, axis)) continue;
        const v = rotation[axis as 'yaw' | 'pitch' | 'roll'] as number;
        if (!Number.isFinite(v) || Math.abs(v) > MAX_DEGREES) return invalid('value', `pose.rotation.${axis} must be finite and |v| <= ${MAX_DEGREES}`);
      }
    }
    const scale = intent.scale;
    if (scale !== undefined) {
      if (typeof scale === 'number' ? !scaleOk(scale) : !scale.every(scaleOk)) return invalid('value', `pose.scale must be within [${SCALE_MIN}, ${SCALE_MAX}]`);
    }
    return null;
  }
  const position = intent.position;
  let axes = 0;
  for (const axis in position) if (hasOwn.call(position, axis)) axes += 1;
  if (axes === 0) return invalid('value', 'transform.position needs at least one axis');
  for (const axis in position) {
    if (!hasOwn.call(position, axis)) continue;
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

function scaleOk(v: number): boolean {
  return Number.isFinite(v) && v >= SCALE_MIN && v <= SCALE_MAX;
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
