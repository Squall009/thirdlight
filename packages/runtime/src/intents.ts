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
 * Phase 23.7: it may also set the rotation, as a `quaternion` or a `facing`
 * direction (fields in the order kind, entityId, position, quaternion, facing, up).
 * @graphNode Move object
 * @graphPhase transform
 */
export interface TransformIntent {
  kind: 'transform';
  entityId: string;
  position: { x?: number; y?: number; z?: number };
  /**
   * Phase 23.7: the rotation as a quaternion [x, y, z, w] (normalized when applied; not all zero).
   * One rotation form per intent.
   * @graphNode skip a quaternion is set by scripts; the node takes angles
   */
  quaternion?: readonly [number, number, number, number];
  /**
   * Phase 23.7: turn the entity so its forward axis (+Z, the glTF forward) points along
   * this direction [x, y, z] (not all zero), its top towards `up`. One rotation form per intent.
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  facing?: readonly [number, number, number];
  /**
   * Phase 23.7: with `facing`, the direction the entity's top (+Y) leans towards
   * (default [0, 1, 0]; must not be parallel to `facing`).
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  up?: readonly [number, number, number];
}

/**
 * Phase 9.9 (wrap-up): an owned entity's rotation (degrees: yaw about +Y,
 * pitch about +X, roll about +Z, applied yaw · pitch · roll; missing axes are
 * 0) and/or scale (one number, or [x, y, z]) — transform phase only, visual
 * (colliders keep their shape). Fields in the order kind, entityId,
 * rotation, scale; at least one of rotation and scale.
 * Phase 23.7: the rotation may instead be a `quaternion` or a `facing`
 * direction (order kind, entityId, rotation, quaternion, facing, up, scale;
 * exactly one of rotation, quaternion and facing when turning).
 * @graphNode Pose object
 * @graphPhase transform
 */
export interface PoseIntent {
  kind: 'pose';
  entityId: string;
  rotation?: { yaw?: number; pitch?: number; roll?: number };
  /**
   * Phase 23.7: the rotation as a quaternion [x, y, z, w] (normalized when applied; not all zero).
   * One rotation form per intent.
   * @graphNode skip a quaternion is set by scripts; the node takes angles
   */
  quaternion?: readonly [number, number, number, number];
  /**
   * Phase 23.7: turn the entity so its forward axis (+Z, the glTF forward) points along
   * this direction [x, y, z] (not all zero), its top towards `up`. One rotation form per intent.
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  facing?: readonly [number, number, number];
  /**
   * Phase 23.7: with `facing`, the direction the entity's top (+Y) leans towards
   * (default [0, 1, 0]; must not be parallel to `facing`).
   * @graphNode skip a facing is set by scripts; the node takes angles
   */
  up?: readonly [number, number, number];
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
  pose: ['kind', 'entityId', 'rotation', 'quaternion', 'facing', 'up', 'scale'],
  respawn: ['kind'],
};
const ROTATION_KEYS = ['yaw', 'pitch', 'roll'] as const;
/** Phase 23.7: a transform intent's fields with the optional rotation forms, in order. */
const TRANSFORM_KEYS_ROTATED: readonly string[] = ['kind', 'entityId', 'position', 'quaternion', 'facing', 'up'];
/** Phase 23.7: bounds of quaternion/direction components, and the smallest length (all-zero is refused). */
const MAX_ROTATION_COMPONENT = 1e6;
const MIN_ROTATION_LENGTH = 1e-9;
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
  // Phase 23.7: a transform may carry a rotation form after its position.
  if (kind === 'transform' && !exactOrder(value, INTENT_KEYS.transform)) return rotatedTransformShape(value);
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
  const parsed = transformBase(value);
  if (!('entityId' in parsed)) return parsed;
  return accepted(kind, parsed);
}

/** The kind/entityId/position part of a transform intent (shape checks), or the failure. */
function transformBase(value: Record<string, unknown>): TransformIntent | { ok: false; error: BehaviorIntentError } {
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
  return { kind: 'transform', entityId: value['entityId'], position: parsed };
}

/** Phase 23.7: a transform intent with fields past `position` (a quaternion, or a facing and up). */
function rotatedTransformShape(value: Record<string, unknown>): IntentShapeResult {
  const unknownKey = firstUnknownKey(value, TRANSFORM_KEYS_ROTATED);
  if (unknownKey !== null) {
    return { ok: false, error: invalid('shape', `unknown transform field "${unknownKey}" (strict shape)`) };
  }
  let keys = 0;
  for (const key in value) if (hasOwn.call(value, key)) keys += 1;
  if (inOrderCount(value, TRANSFORM_KEYS_ROTATED) !== keys || !hasOwn.call(value, 'entityId') || !hasOwn.call(value, 'position')) {
    return { ok: false, error: invalid('shape', `intent fields must be in canonical order (${TRANSFORM_KEYS_ROTATED.join(', ')}; kind, entityId and position required)`) };
  }
  const base = transformBase(value);
  if (!('entityId' in base)) return base;
  const error = rotationFormShape(value, base, 'transform');
  if (error !== null) return { ok: false, error };
  return accepted('transform', base);
}

/** A tuple of `n` numbers (copied), or null. */
function numberTuple(v: unknown, n: number): number[] | null {
  if (!Array.isArray(v) || v.length !== n) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x: unknown = v[i];
    if (typeof x !== 'number') return null;
    out.push(x);
  }
  return out;
}

/**
 * Phase 23.7: the quaternion/facing/up fields of a transform or pose (shape):
 * copied onto `into`; at most one rotation form (`rotation` counts for a pose);
 * `up` only with `facing`.
 */
function rotationFormShape(value: Record<string, unknown>, into: TransformIntent | PoseIntent, kind: 'transform' | 'pose'): BehaviorIntentError | null {
  const q = value['quaternion'];
  const f = value['facing'];
  const u = value['up'];
  const forms = (value['rotation'] !== undefined ? 1 : 0) + (q !== undefined ? 1 : 0) + (f !== undefined ? 1 : 0);
  if (forms > 1) return invalid('shape', `a ${kind} takes one rotation form: ${kind === 'pose' ? 'rotation, ' : ''}quaternion or facing`);
  if (u !== undefined && f === undefined) return invalid('shape', `${kind}.up needs ${kind}.facing`);
  if (q !== undefined) {
    const t = numberTuple(q, 4);
    if (t === null) return invalid('shape', `${kind}.quaternion must be [x, y, z, w]`);
    into.quaternion = [t[0]!, t[1]!, t[2]!, t[3]!];
  }
  if (f !== undefined) {
    const t = numberTuple(f, 3);
    if (t === null) return invalid('shape', `${kind}.facing must be [x, y, z]`);
    into.facing = [t[0]!, t[1]!, t[2]!];
  }
  if (u !== undefined) {
    const t = numberTuple(u, 3);
    if (t === null) return invalid('shape', `${kind}.up must be [x, y, z]`);
    into.up = [t[0]!, t[1]!, t[2]!];
  }
  return null;
}

const AXIS_ORDER: readonly string[] = ['x', 'y', 'z'];

function poseShape(value: Record<string, unknown>): IntentShapeResult {
  let keys = 0;
  for (const key in value) if (hasOwn.call(value, key)) keys += 1;
  if (inOrderCount(value, INTENT_KEYS.pose) !== keys) {
    return { ok: false, error: invalid('shape', `pose fields must be among and in the order ${INTENT_KEYS.pose.join(', ')}`) };
  }
  if (typeof value['entityId'] !== 'string') return { ok: false, error: invalid('shape', 'pose.entityId must be a string') };
  if (value['rotation'] === undefined && value['quaternion'] === undefined && value['facing'] === undefined && value['scale'] === undefined) {
    return { ok: false, error: invalid('shape', value['up'] !== undefined ? 'pose.up needs pose.facing' : 'a pose needs rotation or scale') };
  }
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
  const formError = rotationFormShape(value, intent, 'pose');
  if (formError !== null) return { ok: false, error: formError };
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
    if (intent.quaternion !== undefined || intent.facing !== undefined) {
      const formError = rotationFormValue(intent, 'pose');
      if (formError !== null) return formError;
    }
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
  if (intent.quaternion !== undefined || intent.facing !== undefined) {
    const formError = rotationFormValue(intent, 'transform');
    if (formError !== null) return formError;
  }
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

/** Phase 23.7: the quaternion/facing/up values (finite, bounded, not all zero, up not parallel to facing). */
function rotationFormValue(intent: TransformIntent | PoseIntent, kind: 'transform' | 'pose'): BehaviorIntentError | null {
  const e = vectorError(kind, 'quaternion', intent.quaternion) ?? vectorError(kind, 'facing', intent.facing) ?? vectorError(kind, 'up', intent.up);
  if (e !== null) return e;
  if (intent.facing !== undefined && intent.up !== undefined && facingQuaternion(intent.facing, intent.up) === null) {
    return invalid('value', `${kind}.up must not be parallel to ${kind}.facing`);
  }
  return null;
}

function vectorError(kind: string, name: string, v: readonly number[] | undefined): BehaviorIntentError | null {
  if (v === undefined) return null;
  let len2 = 0;
  for (const x of v) {
    if (!Number.isFinite(x) || Math.abs(x) > MAX_ROTATION_COMPONENT) return invalid('value', `${kind}.${name} components must be finite and |v| <= ${MAX_ROTATION_COMPONENT}`);
    len2 += x * x;
  }
  if (!(Math.sqrt(len2) > MIN_ROTATION_LENGTH)) return invalid('value', `${kind}.${name} must not be all zero`);
  return null;
}

/**
 * Phase 23.7: the unit quaternion [x, y, z, w] of a (validated, non-zero)
 * quaternion — each component divided by the length.
 */
export function normalizedQuaternion(q: readonly number[]): [number, number, number, number] {
  const len = Math.sqrt(q[0]! * q[0]! + q[1]! * q[1]! + q[2]! * q[2]! + q[3]! * q[3]!);
  return [q[0]! / len, q[1]! / len, q[2]! / len, q[3]! / len];
}

/**
 * Phase 23.7: the rotation [x, y, z, w] that turns +Z (forward) along
 * `facing` and +Y (top) towards `up` (default +Y; a facing straight up or
 * down without an `up` leans its top away from / towards +Z, as pitching a
 * +Z-facing object would). `null` when `up` is parallel to `facing` (or
 * either is all zero). Facing +Z with the default up is exactly the identity.
 */
export function facingQuaternion(facing: readonly number[], up?: readonly number[]): [number, number, number, number] | null {
  const fl = Math.hypot(facing[0]!, facing[1]!, facing[2]!);
  if (!(fl > 0)) return null;
  const fx = facing[0]! / fl;
  const fy = facing[1]! / fl;
  const fz = facing[2]! / fl;
  let ux = 0;
  let uy = 1;
  let uz = 0;
  if (up !== undefined) {
    ux = up[0]!;
    uy = up[1]!;
    uz = up[2]!;
  }
  const ul = Math.hypot(ux, uy, uz);
  if (!(ul > 0)) return null;
  // right = up × forward
  let rx = uy * fz - uz * fy;
  let ry = uz * fx - ux * fz;
  let rz = ux * fy - uy * fx;
  let rl = Math.hypot(rx, ry, rz);
  if (!(rl > 1e-6 * ul)) {
    if (up !== undefined) return null;
    // Straight up or down with the default up: the top leans along -Z / +Z.
    uz = fy > 0 ? -1 : 1;
    rx = -uz * fy;
    ry = uz * fx;
    rz = 0;
    rl = Math.hypot(rx, ry, rz);
  }
  rx /= rl;
  ry /= rl;
  rz /= rl;
  // top = forward × right (unit: both are unit and perpendicular)
  const tx = fy * rz - fz * ry;
  const ty = fz * rx - fx * rz;
  const tz = fx * ry - fy * rx;
  // The rotation matrix has the columns right, top, forward; to a quaternion (Shepperd's method).
  const trace = rx + ty + fz;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2; // 4w
    return [(tz - fy) / s, (fx - rz) / s, (ry - tx) / s, s / 4];
  }
  if (rx > ty && rx > fz) {
    const s = Math.sqrt(1 + rx - ty - fz) * 2; // 4x
    return [s / 4, (tx + ry) / s, (fx + rz) / s, (tz - fy) / s];
  }
  if (ty > fz) {
    const s = Math.sqrt(1 + ty - rx - fz) * 2; // 4y
    return [(tx + ry) / s, s / 4, (fy + tz) / s, (fx - rz) / s];
  }
  const s = Math.sqrt(1 + fz - rx - ty) * 2; // 4z
  return [(fx + rz) / s, (fy + tz) / s, s / 4, (ry - tx) / s];
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
