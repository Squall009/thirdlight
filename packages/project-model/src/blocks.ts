/**
 * Phase 9.9: gameplay building blocks (v4 components).
 *
 * - `mover`: the entity moves along waypoints (offsets from where it is
 *   placed); with a collider it is a moving platform that carries the player.
 *   `startOn` makes it wait for a signal (a door: `mode: "once"`).
 * - `trigger`: a box (or, phase 14.2, a circle) that emits a signal when the
 *   player enters it (`mode: "stay"`: every step while the player is inside).
 * - `switch`: a lever/button (`interact` + the interact action) or a pressure
 *   plate (`stand`) that emits a signal.
 * - `health`: the player's health; hazard zones with `damage` take some,
 *   `invulnerableSeconds` of grace follow a hit.
 * - `pickup`: a collectable (coin, gem, heart, life, key or a custom counter).
 * - `enemy`: walks back and forth (between two offsets, or until a ledge or a
 *   wall), hurts on contact, can be stomped; with `chase` it walks toward a
 *   player in range (still within its range / not off a ledge).
 */
import type { ModelErrorV2 } from './errors';

export const MOVER_MODES = ['loop', 'pingpong', 'once'] as const;
export const MOVER_EASINGS = ['linear', 'smooth'] as const;
export const SWITCH_MODES = ['interact', 'stand'] as const;
export const PICKUP_KINDS = ['coin', 'gem', 'heart', 'life', 'key', 'custom'] as const;
export const PICKUP_RESPAWN = ['never', 'death'] as const;
export const ENEMY_PATROLS = ['points', 'edges'] as const;
/** Phase 14.2: a trigger's area (absent: box) and when it emits (absent: enter). */
export const TRIGGER_SHAPES = ['box', 'circle', 'sphere', 'capsule'] as const;
/** Phase 23.1: a capsule trigger's total height range (m, end caps included; at least twice its radius). */
export const TRIGGER_HEIGHT = { min: 0.05, max: 500 } as const;
export const TRIGGER_MODES = ['enter', 'stay'] as const;
/** Phase 14.2: a circle trigger's radius range (m) — the same extent a box trigger may have (0.05–500 m across). */
export const TRIGGER_RADIUS = { min: 0.025, max: 250 } as const;
/** Phase 15.3: how a defeated enemy leaves (absent: squash). */
export const DEFEAT_EFFECTS = ['none', 'squash', 'fade'] as const;

/**
 * Phase 15.3: the gameplay blocks' tuning when a component carries none —
 * the values every project played with before they became data (recorded
 * replays stay valid), except the pickup area (see `pickupSize`). Generic
 * reasons: a 9 m/s stomp bounce and a 5 m/s hit bounce throw a character
 * about a jump's height and half of it at standard gravity; a hit pushes for
 * 0.25 s and grants 1 s of grace (the usual flicker window); a defeated
 * enemy squashes for 0.3 s (readable, then gone); an enemy notices a player
 * within 2 m of its feet (one storey); a stomp counts when the feet were at
 * most 0.2 m below the enemy's top (the fall of a few steps at speed); an
 * edge walker looks 0.05 m ahead for walls and 0.4 m down (a drop deeper than
 * 0.3 m below its feet is a ledge); a mover shoves a player out of its way
 * at up to 60 m/s (0.5 m per step at 120 Hz — a safety limit, not a feel);
 * a pickup without a size or a model with recorded bounds collects in a
 * neutral 1 × 1 m square.
 */
export const BLOCK_DEFAULTS = Object.freeze({
  hitBounce: 5,
  knockbackTime: 0.25,
  invulnerableSeconds: 1,
  stompBounce: 9,
  stompTolerance: 0.2,
  defeat: 'squash' as (typeof DEFEAT_EFFECTS)[number],
  defeatTime: 0.3,
  chaseHeight: 2,
  chaseSpeed: 0,
  chaseMemory: 0,
  wallProbe: 0.05,
  ledgeProbe: 0.4,
  maxPush: 60,
  pickupSize: Object.freeze([1, 1]) as readonly [number, number],
});

/** Phase 15.3: the ranges of the blocks' tuning fields. */
export const BLOCK_TUNING_LIMITS = Object.freeze({
  hitBounce: { min: 0, max: 50 },
  knockbackTime: { min: 0, max: 5 },
  stompBounce: { min: 0, max: 50 },
  stompTolerance: { min: 0, max: 5 },
  defeatTime: { min: 0, max: 5 },
  chaseHeight: { min: 0, max: 100 },
  chaseSpeed: { min: 0, max: 50 },
  chaseMemory: { min: 0, max: 10 },
  wallProbe: { min: 0, max: 5 },
  ledgeProbe: { min: 0.1, max: 20 },
  maxPush: { min: 1, max: 1000 },
});

export interface MoverComponent {
  /** Offsets from the placed position (the start is [0, 0, 0], not listed). */
  waypoints: [number, number, number][];
  /** Meters per second. */
  speed: number;
  mode: (typeof MOVER_MODES)[number];
  /** Seconds to wait at each point. */
  wait?: number;
  easing?: (typeof MOVER_EASINGS)[number];
  /** Wait for this signal before moving (absent: moves from the start). */
  startOn?: string;
  /** Phase 15.3: the fastest (m/s) it shoves a player out of its way (absent: 60). */
  maxPush?: number;
}

export interface TriggerComponent {
  /** A box's [w, h] (required for a box, refused for the round shapes); phase 23.1: [w, h, d] in a 3D project. */
  size?: [number, number] | [number, number, number];
  signal: string;
  once?: boolean;
  /** Emitted when the player leaves the area. */
  exitSignal?: string;
  /** Phase 14.2: the area's shape (absent: box). */
  shape?: (typeof TRIGGER_SHAPES)[number];
  /** Phase 14.2: a circle's radius in meters (required for a circle, refused for a box); phase 23.1: a sphere's or capsule's too. */
  radius?: number;
  /** Phase 23.1: a capsule's total height (m, end caps included), standing along the entity's local Y. */
  height?: number;
  /** Phase 14.2: `enter` (absent) emits once per entry, `stay` every step while the player is inside. */
  mode?: (typeof TRIGGER_MODES)[number];
  /**
   * Phase 24.4e: entering the area moves the character to another scene: `scene` is loaded,
   * `unload` scenes are unloaded, and once `scene` is loaded the character stands at `spawn`
   * (a player spawn in that scene or the trigger's own; absent: it stays where it is).
   */
  sceneTransition?: SceneTransitionAction;
}

/** Phase 24.4e: a trigger's scene transition (the generic form of a scene exit). */
export interface SceneTransitionAction {
  /** The scene loaded. */
  scene: string;
  /** Where the character arrives: a player spawn in `scene` (or the trigger's own scene). */
  spawn?: string;
  /** Scenes unloaded at the same time (absent: none). */
  unload?: string[];
}

/** Phase 24.4e: at most this many scenes a transition unloads (the exit zone's limit). */
export const MAX_TRANSITION_UNLOADS = 16;
export const SCENE_TRANSITION_FIELDS = ['scene', 'spawn', 'unload'] as const;

export interface SwitchComponent {
  mode: (typeof SWITCH_MODES)[number];
  signal: string;
  size: [number, number];
  once?: boolean;
  /** Phase 24.4f: `interact` mode: the input action that works it (absent: `interact`). */
  action?: string;
}

/** Phase 24.4f: the input action an `interact` switch reads when it names none. */
export const SWITCH_DEFAULT_ACTION = 'interact';

export interface HealthComponent {
  max: number;
  /** Health at the start of a level and after a respawn (default: max). */
  start?: number;
  invulnerableSeconds?: number;
  /** A hit pushes the player away from what hurt it at this speed (m/s). */
  knockback?: number;
  /** Phase 15.3: a hit throws the player up at this speed (m/s; absent: 5). */
  hitBounce?: number;
  /** Phase 15.3: seconds a knockback pushes (absent: 0.25). */
  knockbackTime?: number;
  /** Phase 20.2: a project effect played where the player is when it is hit (visual only). */
  hitEffect?: string;
}

export interface PickupComponent {
  kind: (typeof PICKUP_KINDS)[number];
  value: number;
  /** The counter a `custom` pickup adds to. */
  counter?: string;
  size?: [number, number];
  respawn?: (typeof PICKUP_RESPAWN)[number];
  /** An audio asset played when it is collected. */
  cue?: string;
  /** Phase 20.2: a project effect played where it was when it is collected (visual only). */
  effect?: string;
}

export interface EnemyComponent {
  patrol: (typeof ENEMY_PATROLS)[number];
  /** `points`: walks between these x offsets from where it is placed. */
  range?: [number, number];
  speed: number;
  size: [number, number];
  contactDamage: number;
  stompable: boolean;
  health: number;
  /** Walks toward the player within this many meters (absent or 0: never). */
  chase?: number;
  /** Phase 15.3: notices a chased player within this height of its feet (m; absent: 2). */
  chaseHeight?: number;
  /** Phase 24.0: the speed it runs at while chasing (m/s; absent or 0: its walking speed). */
  chaseSpeed?: number;
  /** Phase 24.0: it only notices a player it can see (nothing solid between them). */
  chaseSight?: boolean;
  /** Phase 24.0: it only notices a player in the direction it is walking. */
  chaseFacing?: boolean;
  /** Phase 24.0: keeps chasing for this long after it last noticed the player (s; absent: 0). */
  chaseMemory?: number;
  /** Phase 24.0: may leave its patrol range while chasing (it walks back when it gives up). */
  chaseBeyondPatrol?: boolean;
  /** Phase 15.3: a stomp throws the player up at this speed (m/s; absent: 9). */
  stompBounce?: number;
  /** Phase 15.3: a stomp counts when the feet were at most this far below its top (m; absent: 0.2). */
  stompTolerance?: number;
  /** Phase 15.3: how it leaves when defeated (absent: squash). */
  defeat?: (typeof DEFEAT_EFFECTS)[number];
  /** Phase 15.3: seconds the squash or fade takes (absent: 0.3). */
  defeatTime?: number;
  /** Phase 15.3 (edges patrol): how far ahead of its front it looks for a wall (m; absent: 0.05). */
  wallProbe?: number;
  /** Phase 15.3 (edges patrol): how far down it looks for floor, from 0.1 m above its feet (m; absent: 0.4). */
  ledgeProbe?: number;
  /** Phase 20.2: a project effect played where it is when a stomp hurts it (visual only). */
  hitEffect?: string;
  /** Phase 20.2: a project effect played where it is when it is defeated (visual only). */
  defeatEffect?: string;
}

/** Phase 20.2: an effect id (the `content.effects[]` id syntax). */
const EFFECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function effectRef(value: Record<string, unknown>, key: string, path: string, errors: ModelErrorV2[]): void {
  const v = value[key];
  if (v !== undefined && (typeof v !== 'string' || !EFFECT_ID_RE.test(v))) err(errors, 'field_value', `${path}/${key}`, `${key} names a project effect (an effect id)`, v);
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_:.-]{0,63}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
const num = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const vec2 = (v: unknown, lo: number, hi: number): boolean => Array.isArray(v) && v.length === 2 && v.every((x) => num(x, lo, hi));
const vec3 = (v: unknown, lo: number, hi: number): boolean => Array.isArray(v) && v.length === 3 && v.every((x) => num(x, lo, hi));

function fields(v: Record<string, unknown>, allowed: readonly string[], required: readonly string[], path: string, errors: ModelErrorV2[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, allowed.join(', '));
  for (const k of required) if (v[k] === undefined) err(errors, 'field_missing', `${path}/${k}`, `"${k}" is required`, undefined, k);
}

const MOVER_FIELDS = ['waypoints', 'speed', 'mode', 'wait', 'easing', 'startOn', 'maxPush'] as const;
const HEALTH_FIELDS = ['max', 'start', 'invulnerableSeconds', 'knockback', 'hitBounce', 'knockbackTime', 'hitEffect'] as const;
const ENEMY_FIELDS = ['patrol', 'range', 'speed', 'size', 'contactDamage', 'stompable', 'health', 'chase', 'chaseHeight', 'chaseSpeed', 'chaseSight', 'chaseFacing', 'chaseMemory', 'chaseBeyondPatrol', 'stompBounce', 'stompTolerance', 'defeat', 'defeatTime', 'wallProbe', 'ledgeProbe', 'hitEffect', 'defeatEffect'] as const;
const PICKUP_FIELDS = ['kind', 'value', 'counter', 'size', 'respawn', 'cue', 'effect'] as const;

/** Phase 15.3: optional tuning numbers within their `BLOCK_TUNING_LIMITS` range. */
function tuning(value: Record<string, unknown>, keys: readonly (keyof typeof BLOCK_TUNING_LIMITS)[], path: string, errors: ModelErrorV2[]): void {
  for (const k of keys) {
    const v = value[k];
    const lim = BLOCK_TUNING_LIMITS[k];
    if (v !== undefined && !num(v, lim.min, lim.max)) err(errors, 'field_value', `${path}/${k}`, `${k} is ${lim.min}–${lim.max}`, v);
  }
}

export function validateMoverComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'mover is an object', value);
  fields(value, MOVER_FIELDS, ['waypoints', 'speed', 'mode'], path, errors);
  tuning(value, ['maxPush'], path, errors);
  const w = value['waypoints'];
  if (!Array.isArray(w) || w.length < 1 || w.length > 16 || !w.every((p) => Array.isArray(p) && p.length === 3 && p.every((x) => num(x, -1000, 1000)))) {
    err(errors, 'field_value', `${path}/waypoints`, 'waypoints is 1–16 offsets [x, y, z] from the placed position', w);
  }
  if (value['speed'] !== undefined && !num(value['speed'], 0.01, 50)) err(errors, 'field_value', `${path}/speed`, 'speed is 0.01–50 m/s', value['speed']);
  if (value['mode'] !== undefined && !(MOVER_MODES as readonly unknown[]).includes(value['mode'])) err(errors, 'field_value', `${path}/mode`, 'mode is loop, pingpong or once', value['mode']);
  if (value['wait'] !== undefined && !num(value['wait'], 0, 60)) err(errors, 'field_value', `${path}/wait`, 'wait is 0–60 s', value['wait']);
  if (value['easing'] !== undefined && !(MOVER_EASINGS as readonly unknown[]).includes(value['easing'])) err(errors, 'field_value', `${path}/easing`, 'easing is linear or smooth', value['easing']);
  if (value['startOn'] !== undefined && (typeof value['startOn'] !== 'string' || !NAME_RE.test(value['startOn']))) err(errors, 'field_value', `${path}/startOn`, 'startOn is a signal name', value['startOn']);
}

export function validateTriggerComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'trigger is an object', value);
  // Phase 23.1: sphere and capsule are round like a circle (a radius, no size); a capsule has a height.
  const shape = value['shape'];
  const round = shape === 'circle' || shape === 'sphere' || shape === 'capsule';
  const capsule = shape === 'capsule';
  const circle = round;
  fields(value, TRIGGER_FIELDS, round ? (capsule ? ['radius', 'height', 'signal'] : ['radius', 'signal']) : ['size', 'signal'], path, errors);
  if (value['sceneTransition'] !== undefined) validateSceneTransition(value['sceneTransition'], `${path}/sceneTransition`, errors);
  if (value['exitSignal'] !== undefined && (typeof value['exitSignal'] !== 'string' || !NAME_RE.test(value['exitSignal']))) err(errors, 'field_value', `${path}/exitSignal`, 'exitSignal is a name', value['exitSignal']);
  if (shape !== undefined && !(TRIGGER_SHAPES as readonly unknown[]).includes(shape)) err(errors, 'field_value', `${path}/shape`, 'shape is box or circle (a 3D project: box, sphere or capsule)', shape);
  if (circle && value['size'] !== undefined) err(errors, 'field_unexpected', `${path}/size`, `a ${String(shape)} trigger has a radius, not a size`, value['size']);
  if (!circle && value['radius'] !== undefined) err(errors, 'field_unexpected', `${path}/radius`, 'only a round trigger (circle, sphere, capsule) has a radius (set its shape)', value['radius']);
  if (!capsule && value['height'] !== undefined) err(errors, 'field_unexpected', `${path}/height`, 'only a capsule trigger has a height (set shape to capsule)', value['height']);
  if (value['size'] !== undefined && !circle && !vec2(value['size'], 0.05, 500) && !vec3(value['size'], 0.05, 500)) err(errors, 'field_value', `${path}/size`, 'size is [w, h] (or [w, h, d] in a 3D project) in meters', value['size']);
  if (value['radius'] !== undefined && circle && !num(value['radius'], TRIGGER_RADIUS.min, TRIGGER_RADIUS.max)) err(errors, 'field_value', `${path}/radius`, `radius is ${TRIGGER_RADIUS.min}–${TRIGGER_RADIUS.max} m`, value['radius']);
  if (value['height'] !== undefined && capsule) {
    const r = typeof value['radius'] === 'number' ? value['radius'] : 0;
    if (!num(value['height'], TRIGGER_HEIGHT.min, TRIGGER_HEIGHT.max)) err(errors, 'field_value', `${path}/height`, `height is ${TRIGGER_HEIGHT.min}–${TRIGGER_HEIGHT.max} m`, value['height']);
    else if ((value['height'] as number) < 2 * r) err(errors, 'field_value', `${path}/height`, 'a capsule trigger\'s height (end caps included) is at least twice its radius', value['height']);
  }
  if (value['mode'] !== undefined && !(TRIGGER_MODES as readonly unknown[]).includes(value['mode'])) err(errors, 'field_value', `${path}/mode`, 'mode is enter or stay', value['mode']);
  if (value['signal'] !== undefined && (typeof value['signal'] !== 'string' || !NAME_RE.test(value['signal']))) err(errors, 'field_value', `${path}/signal`, 'signal is a name', value['signal']);
  if (value['once'] !== undefined && typeof value['once'] !== 'boolean') err(errors, 'field_type', `${path}/once`, 'once is true or false', value['once']);
}

/** Phase 24.4e: a scene id (the `content.scenes[]` id syntax) and an entity id. */
const SCENE_OR_ENTITY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Phase 24.4f: an input action name. */
const ACTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const TRIGGER_FIELDS = ['size', 'signal', 'once', 'exitSignal', 'shape', 'radius', 'mode', 'height', 'sceneTransition'] as const;
export const SWITCH_FIELDS = ['mode', 'signal', 'size', 'once', 'action'] as const;

function validateSceneTransition(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'sceneTransition is an object { scene, spawn?, unload? }', value);
  fields(value, SCENE_TRANSITION_FIELDS, ['scene'], path, errors);
  if (value['scene'] !== undefined && (typeof value['scene'] !== 'string' || !SCENE_OR_ENTITY_RE.test(value['scene']))) err(errors, 'field_value', `${path}/scene`, 'scene names a scene (a scene id)', value['scene']);
  if (value['spawn'] !== undefined && (typeof value['spawn'] !== 'string' || !SCENE_OR_ENTITY_RE.test(value['spawn']))) err(errors, 'field_value', `${path}/spawn`, 'spawn names a player spawn (an entity id)', value['spawn']);
  const u = value['unload'];
  if (u !== undefined && (!Array.isArray(u) || u.length > MAX_TRANSITION_UNLOADS || !u.every((x) => typeof x === 'string' && SCENE_OR_ENTITY_RE.test(x)) || new Set(u).size !== u.length)) {
    err(errors, 'field_value', `${path}/unload`, `unload is up to ${MAX_TRANSITION_UNLOADS} different scene ids`, u);
  }
}

export function validateSwitchComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'switch is an object', value);
  fields(value, SWITCH_FIELDS, ['mode', 'signal', 'size'], path, errors);
  if (value['action'] !== undefined) {
    if (typeof value['action'] !== 'string' || !ACTION_NAME_RE.test(value['action'])) err(errors, 'field_value', `${path}/action`, 'action names an input action (a letter or _, then letters, digits or _; at most 32)', value['action']);
    else if (value['mode'] !== undefined && value['mode'] !== 'interact') err(errors, 'field_unexpected', `${path}/action`, 'only an interact switch reads an action', value['action']);
  }
  if (value['mode'] !== undefined && !(SWITCH_MODES as readonly unknown[]).includes(value['mode'])) err(errors, 'field_value', `${path}/mode`, 'mode is interact or stand', value['mode']);
  if (value['signal'] !== undefined && (typeof value['signal'] !== 'string' || !NAME_RE.test(value['signal']))) err(errors, 'field_value', `${path}/signal`, 'signal is a name', value['signal']);
  if (value['size'] !== undefined && !vec2(value['size'], 0.05, 100)) err(errors, 'field_value', `${path}/size`, 'size is [w, h] in meters', value['size']);
  if (value['once'] !== undefined && typeof value['once'] !== 'boolean') err(errors, 'field_type', `${path}/once`, 'once is true or false', value['once']);
}

export function validateHealthComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'health is an object', value);
  fields(value, HEALTH_FIELDS, ['max'], path, errors);
  tuning(value, ['hitBounce', 'knockbackTime'], path, errors);
  effectRef(value, 'hitEffect', path, errors);
  if (value['start'] !== undefined && !(Number.isInteger(value['start']) && num(value['start'], 1, typeof value['max'] === 'number' ? value['max'] : 1000))) err(errors, 'field_value', `${path}/start`, 'start is an integer 1–max', value['start']);
  if (value['knockback'] !== undefined && !num(value['knockback'], 0, 20)) err(errors, 'field_value', `${path}/knockback`, 'knockback is 0–20 m/s', value['knockback']);
  if (value['max'] !== undefined && !(Number.isInteger(value['max']) && num(value['max'], 1, 1000))) err(errors, 'field_value', `${path}/max`, 'max is an integer 1–1000', value['max']);
  if (value['invulnerableSeconds'] !== undefined && !num(value['invulnerableSeconds'], 0, 10)) err(errors, 'field_value', `${path}/invulnerableSeconds`, 'invulnerableSeconds is 0–10', value['invulnerableSeconds']);
}

export function validatePickupComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'pickup is an object', value);
  fields(value, PICKUP_FIELDS, ['kind', 'value'], path, errors);
  effectRef(value, 'effect', path, errors);
  if (value['cue'] !== undefined && (typeof value['cue'] !== 'string' || value['cue'].length === 0 || value['cue'].length > 128)) err(errors, 'field_value', `${path}/cue`, 'cue names an audio asset', value['cue']);
  if (value['kind'] !== undefined && !(PICKUP_KINDS as readonly unknown[]).includes(value['kind'])) err(errors, 'field_value', `${path}/kind`, 'kind is coin, gem, heart, life, key or custom', value['kind']);
  if (value['value'] !== undefined && !(Number.isInteger(value['value']) && num(value['value'], 1, 10000))) err(errors, 'field_value', `${path}/value`, 'value is an integer 1–10000', value['value']);
  if (value['kind'] === 'custom' && (typeof value['counter'] !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(value['counter']))) err(errors, 'field_value', `${path}/counter`, 'a custom pickup names its counter', value['counter']);
  if (value['kind'] !== 'custom' && value['counter'] !== undefined) err(errors, 'field_unexpected', `${path}/counter`, 'only a custom pickup names a counter', value['counter']);
  if (value['size'] !== undefined && !vec2(value['size'], 0.05, 20)) err(errors, 'field_value', `${path}/size`, 'size is [w, h] in meters', value['size']);
  if (value['respawn'] !== undefined && !(PICKUP_RESPAWN as readonly unknown[]).includes(value['respawn'])) err(errors, 'field_value', `${path}/respawn`, 'respawn is never or death', value['respawn']);
}

export function validateEnemyComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'enemy is an object', value);
  fields(value, ENEMY_FIELDS, ['patrol', 'speed', 'size', 'contactDamage', 'stompable', 'health'], path, errors);
  tuning(value, ['chaseHeight', 'chaseSpeed', 'chaseMemory', 'stompBounce', 'stompTolerance', 'defeatTime', 'wallProbe', 'ledgeProbe'], path, errors);
  effectRef(value, 'hitEffect', path, errors);
  effectRef(value, 'defeatEffect', path, errors);
  if (value['chaseSight'] !== undefined && typeof value['chaseSight'] !== 'boolean') err(errors, 'field_type', `${path}/chaseSight`, 'chaseSight is true or false', value['chaseSight']);
  if (value['chaseFacing'] !== undefined && typeof value['chaseFacing'] !== 'boolean') err(errors, 'field_type', `${path}/chaseFacing`, 'chaseFacing is true or false', value['chaseFacing']);
  if (value['chaseBeyondPatrol'] !== undefined && typeof value['chaseBeyondPatrol'] !== 'boolean') err(errors, 'field_type', `${path}/chaseBeyondPatrol`, 'chaseBeyondPatrol is true or false', value['chaseBeyondPatrol']);
  if (value['defeat'] !== undefined && !(DEFEAT_EFFECTS as readonly unknown[]).includes(value['defeat'])) err(errors, 'field_value', `${path}/defeat`, 'defeat is none, squash or fade', value['defeat']);
  if (value['chase'] !== undefined && !num(value['chase'], 0, 50)) err(errors, 'field_value', `${path}/chase`, 'chase is 0–50 m', value['chase']);
  if (value['patrol'] !== undefined && !(ENEMY_PATROLS as readonly unknown[]).includes(value['patrol'])) err(errors, 'field_value', `${path}/patrol`, 'patrol is points or edges', value['patrol']);
  if (value['patrol'] === 'points' && !(vec2(value['range'], -500, 500) && (value['range'] as number[])[0]! < (value['range'] as number[])[1]!)) err(errors, 'field_value', `${path}/range`, 'a points patrol walks between two x offsets [left, right]', value['range']);
  if (value['patrol'] === 'edges' && value['range'] !== undefined) err(errors, 'field_unexpected', `${path}/range`, 'an edges patrol has no range', value['range']);
  if (value['speed'] !== undefined && !num(value['speed'], 0, 20)) err(errors, 'field_value', `${path}/speed`, 'speed is 0–20 m/s', value['speed']);
  if (value['size'] !== undefined && !vec2(value['size'], 0.1, 20)) err(errors, 'field_value', `${path}/size`, 'size is [w, h] in meters', value['size']);
  if (value['contactDamage'] !== undefined && !(Number.isInteger(value['contactDamage']) && num(value['contactDamage'], 0, 1000))) err(errors, 'field_value', `${path}/contactDamage`, 'contactDamage is an integer 0–1000 (0: harmless)', value['contactDamage']);
  if (value['stompable'] !== undefined && typeof value['stompable'] !== 'boolean') err(errors, 'field_type', `${path}/stompable`, 'stompable is true or false', value['stompable']);
  if (value['health'] !== undefined && !(Number.isInteger(value['health']) && num(value['health'], 1, 100))) err(errors, 'field_value', `${path}/health`, 'health is an integer 1–100', value['health']);
}

const copy2 = (v: [number, number]): [number, number] => [v[0], v[1]];

export const canonicalMover = (c: MoverComponent): MoverComponent => ({
  waypoints: c.waypoints.map((p) => [p[0], p[1], p[2]] as [number, number, number]),
  speed: c.speed,
  mode: c.mode,
  ...(c.wait !== undefined ? { wait: c.wait } : {}),
  ...(c.easing !== undefined ? { easing: c.easing } : {}),
  ...(c.startOn !== undefined ? { startOn: c.startOn } : {}),
  // Phase 15.3: the tuning comes last (an existing component keeps its exact canonical bytes).
  ...(c.maxPush !== undefined ? { maxPush: c.maxPush } : {}),
});
// Phase 14.2: the new fields come last (an existing trigger keeps its exact canonical bytes).
export const canonicalTrigger = (c: TriggerComponent): TriggerComponent => ({
  // Phase 23.1: a 3D box keeps its depth.
  ...(c.size !== undefined ? { size: c.size.length === 3 ? [c.size[0], c.size[1], c.size[2]] : copy2(c.size as [number, number]) } : {}),
  signal: c.signal,
  ...(c.once !== undefined ? { once: c.once } : {}),
  ...(c.exitSignal !== undefined ? { exitSignal: c.exitSignal } : {}),
  ...(c.shape !== undefined ? { shape: c.shape } : {}),
  ...(c.radius !== undefined ? { radius: c.radius } : {}),
  ...(c.mode !== undefined ? { mode: c.mode } : {}),
  ...(c.height !== undefined ? { height: c.height } : {}),
  // Phase 24.4e: last, so an existing trigger keeps its exact canonical bytes.
  ...(c.sceneTransition !== undefined
    ? { sceneTransition: { scene: c.sceneTransition.scene, ...(c.sceneTransition.spawn !== undefined ? { spawn: c.sceneTransition.spawn } : {}), ...(c.sceneTransition.unload !== undefined ? { unload: [...c.sceneTransition.unload] } : {}) } }
    : {}),
});
// Phase 24.4f: `action` last (an existing switch keeps its exact canonical bytes).
export const canonicalSwitch = (c: SwitchComponent): SwitchComponent => ({ mode: c.mode, signal: c.signal, size: copy2(c.size), ...(c.once !== undefined ? { once: c.once } : {}), ...(c.action !== undefined ? { action: c.action } : {}) });
export const canonicalHealth = (c: HealthComponent): HealthComponent => ({
  max: c.max,
  ...(c.start !== undefined ? { start: c.start } : {}),
  ...(c.invulnerableSeconds !== undefined ? { invulnerableSeconds: c.invulnerableSeconds } : {}),
  ...(c.knockback !== undefined ? { knockback: c.knockback } : {}),
  ...(c.hitBounce !== undefined ? { hitBounce: c.hitBounce } : {}),
  ...(c.knockbackTime !== undefined ? { knockbackTime: c.knockbackTime } : {}),
  // Phase 20.2: last, so an existing component keeps its exact canonical bytes.
  ...(c.hitEffect !== undefined ? { hitEffect: c.hitEffect } : {}),
});
export const canonicalPickup = (c: PickupComponent): PickupComponent => ({
  kind: c.kind,
  value: c.value,
  ...(c.counter !== undefined ? { counter: c.counter } : {}),
  ...(c.size !== undefined ? { size: copy2(c.size) } : {}),
  ...(c.respawn !== undefined ? { respawn: c.respawn } : {}),
  ...(c.cue !== undefined ? { cue: c.cue } : {}),
  ...(c.effect !== undefined ? { effect: c.effect } : {}),
});
export const canonicalEnemy = (c: EnemyComponent): EnemyComponent => ({
  patrol: c.patrol,
  ...(c.range !== undefined ? { range: copy2(c.range) } : {}),
  speed: c.speed,
  size: copy2(c.size),
  contactDamage: c.contactDamage,
  stompable: c.stompable,
  health: c.health,
  ...(c.chase !== undefined ? { chase: c.chase } : {}),
  ...(c.chaseHeight !== undefined ? { chaseHeight: c.chaseHeight } : {}),
  // Phase 24.0: last, so an existing component keeps its exact canonical bytes.
  ...(c.chaseSpeed !== undefined ? { chaseSpeed: c.chaseSpeed } : {}),
  ...(c.chaseSight !== undefined ? { chaseSight: c.chaseSight } : {}),
  ...(c.chaseFacing !== undefined ? { chaseFacing: c.chaseFacing } : {}),
  ...(c.chaseMemory !== undefined ? { chaseMemory: c.chaseMemory } : {}),
  ...(c.chaseBeyondPatrol !== undefined ? { chaseBeyondPatrol: c.chaseBeyondPatrol } : {}),
  ...(c.stompBounce !== undefined ? { stompBounce: c.stompBounce } : {}),
  ...(c.stompTolerance !== undefined ? { stompTolerance: c.stompTolerance } : {}),
  ...(c.defeat !== undefined ? { defeat: c.defeat } : {}),
  ...(c.defeatTime !== undefined ? { defeatTime: c.defeatTime } : {}),
  ...(c.wallProbe !== undefined ? { wallProbe: c.wallProbe } : {}),
  ...(c.ledgeProbe !== undefined ? { ledgeProbe: c.ledgeProbe } : {}),
  ...(c.hitEffect !== undefined ? { hitEffect: c.hitEffect } : {}),
  ...(c.defeatEffect !== undefined ? { defeatEffect: c.defeatEffect } : {}),
});

/** Every block component, with its validator and canonical form (v4 scenes). */
/**
 * Phase 9.10: a sound that loops where the entity is, louder as the player
 * comes near (along X). Phase 23.13: in the panner model (the project's
 * `audio_spatial`) it plays through a panner, the listener on the active
 * camera, fading by its distance model; `range` is then the max distance.
 */
export interface AudioSourceComponent {
  /** An audio (cue) or music asset. */
  assetId: string;
  /** 0–1 at full volume. */
  volume: number;
  /** Heard within this many meters (full volume within a quarter of it). */
  range: number;
  /** Phase 23.13 (panner model): linear (absent), inverse or exponential. */
  distanceModel?: 'linear' | 'inverse' | 'exponential';
  /** Phase 23.13 (panner model): full volume within this distance (absent: a quarter of the range). */
  refDistance?: number;
  /** Phase 23.13 (panner model): how fast it fades (absent: 1). */
  rolloff?: number;
}

export const AUDIO_SOURCE_FIELDS = ['assetId', 'volume', 'range', 'distanceModel', 'refDistance', 'rolloff'] as const;

export function validateAudioSourceComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'audioSource is an object', value);
  fields(value, [...AUDIO_SOURCE_FIELDS], ['assetId', 'volume', 'range'], path, errors);
  if (value['assetId'] !== undefined && (typeof value['assetId'] !== 'string' || value['assetId'].length === 0 || value['assetId'].length > 128)) err(errors, 'field_value', `${path}/assetId`, 'assetId names an audio or music asset', value['assetId']);
  if (value['volume'] !== undefined && !num(value['volume'], 0, 1)) err(errors, 'field_value', `${path}/volume`, 'volume is 0–1', value['volume']);
  if (value['range'] !== undefined && !num(value['range'], 0.5, 500)) err(errors, 'field_value', `${path}/range`, 'range is 0.5–500 m', value['range']);
  if (value['distanceModel'] !== undefined && value['distanceModel'] !== 'linear' && value['distanceModel'] !== 'inverse' && value['distanceModel'] !== 'exponential') err(errors, 'field_value', `${path}/distanceModel`, 'distanceModel is linear, inverse or exponential', value['distanceModel']);
  if (value['refDistance'] !== undefined && !num(value['refDistance'], 0.01, 500)) err(errors, 'field_value', `${path}/refDistance`, 'refDistance is 0.01–500 m', value['refDistance']);
  if (value['rolloff'] !== undefined && !num(value['rolloff'], 0, 10)) err(errors, 'field_value', `${path}/rolloff`, 'rolloff is 0–10', value['rolloff']);
}

export const canonicalAudioSource = (c: AudioSourceComponent): AudioSourceComponent => ({
  assetId: c.assetId,
  volume: c.volume,
  range: c.range,
  ...(c.distanceModel !== undefined ? { distanceModel: c.distanceModel } : {}),
  ...(c.refDistance !== undefined ? { refDistance: c.refDistance } : {}),
  ...(c.rolloff !== undefined ? { rolloff: c.rolloff } : {}),
});

/**
 * Phase 9.13: a model that turns to face where its parent is going (the
 * player's model, a boar under its enemy): yaw (degrees about +Y) when the
 * parent moves right or left, reached over `turnSeconds`.
 */
export interface FaceMovementComponent {
  /** `sides` (absent): `yawRight`/`yawLeft` by the sign of the motion along X; phase 24.4f: `velocity`: the yaw of the horizontal motion (any direction, 3D too). */
  mode?: (typeof FACE_MOVEMENT_MODES)[number];
  /** `sides` only (required there). */
  yawRight?: number;
  yawLeft?: number;
  /** `sides`: time to turn from one side to the other; `velocity`: time for a half turn (180°). */
  turnSeconds?: number;
  /** Phase 24.4f, `velocity`: added to the motion's yaw (degrees; a model authored facing +X uses −90). */
  yawOffset?: number;
}

/** Phase 24.4f: how a face-movement model picks its yaw. */
export const FACE_MOVEMENT_MODES = ['sides', 'velocity'] as const;
export const FACE_MOVEMENT_FIELDS = ['yawRight', 'yawLeft', 'turnSeconds', 'mode', 'yawOffset'] as const;

export function validateFaceMovementComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'faceMovement is an object', value);
  const velocity = value['mode'] === 'velocity';
  fields(value, FACE_MOVEMENT_FIELDS, velocity ? [] : ['yawRight', 'yawLeft'], path, errors);
  if (value['mode'] !== undefined && !(FACE_MOVEMENT_MODES as readonly unknown[]).includes(value['mode'])) err(errors, 'field_value', `${path}/mode`, 'mode is sides or velocity', value['mode']);
  for (const k of ['yawRight', 'yawLeft'] as const) {
    if (value[k] === undefined) continue;
    if (velocity) err(errors, 'field_unexpected', `${path}/${k}`, `a velocity face-movement has no ${k} (it faces the way it moves; see yawOffset)`, value[k]);
    else if (!num(value[k], -360, 360)) err(errors, 'field_value', `${path}/${k}`, `${k} is −360–360 degrees`, value[k]);
  }
  if (value['yawOffset'] !== undefined) {
    if (!velocity) err(errors, 'field_unexpected', `${path}/yawOffset`, 'only a velocity face-movement has a yawOffset', value['yawOffset']);
    else if (!num(value['yawOffset'], -360, 360)) err(errors, 'field_value', `${path}/yawOffset`, 'yawOffset is −360–360 degrees', value['yawOffset']);
  }
  if (value['turnSeconds'] !== undefined && !num(value['turnSeconds'], 0, 5)) err(errors, 'field_value', `${path}/turnSeconds`, 'turnSeconds is 0–5', value['turnSeconds']);
}

// Phase 24.4f: `mode` and `yawOffset` last (an existing component keeps its exact canonical bytes).
export const canonicalFaceMovement = (c: FaceMovementComponent): FaceMovementComponent => ({
  ...(c.yawRight !== undefined ? { yawRight: c.yawRight } : {}),
  ...(c.yawLeft !== undefined ? { yawLeft: c.yawLeft } : {}),
  ...(c.turnSeconds !== undefined ? { turnSeconds: c.turnSeconds } : {}),
  ...(c.mode !== undefined ? { mode: c.mode } : {}),
  ...(c.yawOffset !== undefined ? { yawOffset: c.yawOffset } : {}),
});

// ---- phase 24.4: generic primitives (both physics dimensions) ------------------------

/**
 * Phase 24.4a: `collectible` — the character touching its area adds `amount`
 * to a named counter (any name), hides it and stops it collecting, sends the
 * `onCollect` signal, and brings it back after `respawn` seconds (absent or
 * 0: never; scripts may bring it back with `ctx.collectible.restore`).
 *
 * Phase 24.4c: `patrol` — the object walks by itself: along waypoints
 * (offsets from where it is placed, back and forth or in a loop), or straight
 * ahead turning around at walls and ledges (`edges`: a ray ahead at the middle
 * of its body, a ray down just past its front). It keeps its placed height.
 *
 * Phase 24.4d: `hitbox` — an area (a box or a sphere, a circle on the 2D
 * plane) whose contacts with other hitboxes and with the character are
 * events for scripts (the other object and the contact normal). With
 * `damage`, a new contact takes that much from the other object's health.
 *
 * The areas are centred on the object's position; a 2D-plane project ignores
 * a box's depth, a 3D one uses it (absent: the width).
 */
export const PATROL_MODES = ['waypoints', 'edges'] as const;
export const HITBOX_SHAPES = ['box', 'sphere'] as const;

/**
 * Phase 24.4: the primitives' values when a component leaves them out, with
 * genre-neutral reasons: a collectible adds 1 (one of something) over a 1 m
 * area (about a hand's reach around an object a person picks up); a patroller
 * is a 1 m body (a person-sized walker's width) that looks 0.05 m ahead for a
 * wall and 0.4 m down for floor from 0.1 m above its underside (a drop deeper
 * than 0.3 m, knee height, is a ledge) — the same probes the engine used
 * before; it starts walking along +X (the 2D plane's "ahead").
 */
export const PRIMITIVE_DEFAULTS = Object.freeze({
  collectibleAmount: 1,
  collectibleSize: Object.freeze([1, 1, 1]) as readonly [number, number, number],
  patrolSize: Object.freeze([1, 1, 1]) as readonly [number, number, number],
  patrolDirection: Object.freeze([1, 0, 0]) as readonly [number, number, number],
  wallProbe: 0.05,
  ledgeProbe: 0.4,
});

/** Phase 24.4: the primitives' value ranges. */
export const PRIMITIVE_LIMITS = Object.freeze({
  /** A collectible's amount (negative takes away). */
  amount: { min: -1_000_000, max: 1_000_000 },
  /** Seconds before a collected collectible comes back (0: never). */
  respawn: { min: 0, max: 3600 },
  /** An area's size along each axis (m). */
  size: { min: 0.05, max: 500 },
  /** A hitbox sphere's radius (m). */
  radius: { min: 0.025, max: 250 },
  /** A patroller's speed (m/s). */
  speed: { min: 0, max: 50 },
  /** Seconds a patroller waits at a waypoint or after turning. */
  wait: { min: 0, max: 60 },
  wallProbe: { min: 0, max: 5 },
  ledgeProbe: { min: 0.1, max: 20 },
  /** Health a new hitbox contact takes. */
  damage: { min: 0, max: 1000 },
});

export interface CollectibleComponent {
  /** The counter it adds to (a letter or _, then letters, digits or _). */
  counter: string;
  /** Added to the counter when collected (absent: 1). */
  amount?: number;
  /** Seconds until it comes back (absent or 0: never). */
  respawn?: number;
  /** A signal sent when it is collected. */
  onCollect?: string;
  /** The area that collects it: [w, h] or [w, h, d] (m; absent: 1 m each). */
  size?: [number, number] | [number, number, number];
}

export interface PatrolComponent {
  mode: (typeof PATROL_MODES)[number];
  /** `waypoints`: 1–16 offsets from the placed position (the start is not listed). */
  waypoints?: [number, number, number][];
  /** `waypoints`: from the last point back to the start (absent: back and forth). */
  loop?: boolean;
  /** Metres per second. */
  speed: number;
  /** Seconds it waits at each waypoint or after turning around. */
  wait?: number;
  /** `edges`: the way it starts walking (a 2D plane uses the sign of x; 3D the direction on the ground). */
  direction?: [number, number, number];
  /** `edges`: its body [w, h] or [w, h, d], centred on its position (where the probes look from). */
  size?: [number, number] | [number, number, number];
  /** `edges`: how far past its front it looks for a wall (m). */
  wallProbe?: number;
  /** `edges`: how far down it looks for floor, from 0.1 m above its underside (m). */
  ledgeProbe?: number;
}

export interface HitboxComponent {
  shape?: (typeof HITBOX_SHAPES)[number];
  /** A box's [w, h] or [w, h, d] (required for a box, refused for a sphere). */
  size?: [number, number] | [number, number, number];
  /** A sphere's radius (required for a sphere, refused for a box). */
  radius?: number;
  /** Health a new contact takes from the other object (its own, or the nearest parent's with health). */
  damage?: number;
}

const COUNTER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const COLLECTIBLE_FIELDS = ['counter', 'amount', 'respawn', 'onCollect', 'size'] as const;
const PATROL_FIELDS = ['mode', 'waypoints', 'loop', 'speed', 'wait', 'direction', 'size', 'wallProbe', 'ledgeProbe'] as const;
const HITBOX_FIELDS = ['shape', 'size', 'radius', 'damage'] as const;
const L = PRIMITIVE_LIMITS;
const area = (v: unknown): boolean => vec2(v, L.size.min, L.size.max) || vec3(v, L.size.min, L.size.max);
function limited(value: Record<string, unknown>, key: string, lim: { min: number; max: number }, unit: string, path: string, errors: ModelErrorV2[]): void {
  if (value[key] !== undefined && !num(value[key], lim.min, lim.max)) err(errors, 'field_value', `${path}/${key}`, `${key} is ${lim.min}–${lim.max}${unit}`, value[key]);
}

export function validateCollectibleComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'collectible is an object', value);
  fields(value, COLLECTIBLE_FIELDS, ['counter'], path, errors);
  if (value['counter'] !== undefined && (typeof value['counter'] !== 'string' || !COUNTER_RE.test(value['counter']))) err(errors, 'field_value', `${path}/counter`, 'counter is a name: a letter or _, then up to 31 letters, digits or _', value['counter']);
  limited(value, 'amount', L.amount, '', path, errors);
  limited(value, 'respawn', L.respawn, ' s', path, errors);
  if (value['onCollect'] !== undefined && (typeof value['onCollect'] !== 'string' || !NAME_RE.test(value['onCollect']))) err(errors, 'field_value', `${path}/onCollect`, 'onCollect is a signal name', value['onCollect']);
  if (value['size'] !== undefined && !area(value['size'])) err(errors, 'field_value', `${path}/size`, `size is [w, h] or [w, h, d], each ${L.size.min}–${L.size.max} m`, value['size']);
}

export function validatePatrolComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'patrol is an object', value);
  const mode = value['mode'];
  fields(value, PATROL_FIELDS, mode === 'waypoints' ? ['mode', 'speed', 'waypoints'] : ['mode', 'speed'], path, errors);
  if (mode !== undefined && !(PATROL_MODES as readonly unknown[]).includes(mode)) err(errors, 'field_value', `${path}/mode`, 'mode is waypoints or edges', mode);
  limited(value, 'speed', L.speed, ' m/s', path, errors);
  limited(value, 'wait', L.wait, ' s', path, errors);
  limited(value, 'wallProbe', L.wallProbe, ' m', path, errors);
  limited(value, 'ledgeProbe', L.ledgeProbe, ' m', path, errors);
  const w = value['waypoints'];
  if (w !== undefined) {
    if (mode !== 'waypoints') err(errors, 'field_unexpected', `${path}/waypoints`, 'only a waypoints patrol has waypoints', w);
    else if (!Array.isArray(w) || w.length < 1 || w.length > 16 || !w.every((p) => vec3(p, -1000, 1000))) err(errors, 'field_value', `${path}/waypoints`, 'waypoints is 1–16 offsets [x, y, z] from the placed position', w);
  }
  if (value['loop'] !== undefined) {
    if (mode !== 'waypoints') err(errors, 'field_unexpected', `${path}/loop`, 'only a waypoints patrol loops', value['loop']);
    else if (typeof value['loop'] !== 'boolean') err(errors, 'field_type', `${path}/loop`, 'loop is true or false', value['loop']);
  }
  for (const k of ['direction', 'size', 'wallProbe', 'ledgeProbe'] as const) {
    if (value[k] !== undefined && mode === 'waypoints') err(errors, 'field_unexpected', `${path}/${k}`, `only an edges patrol has ${k}`, value[k]);
  }
  const d = value['direction'];
  if (d !== undefined && mode !== 'waypoints' && !(vec3(d, -1, 1) && (d as number[]).some((x) => x !== 0))) err(errors, 'field_value', `${path}/direction`, 'direction is [x, y, z] (each −1–1, not all 0)', d);
  if (value['size'] !== undefined && mode !== 'waypoints' && !area(value['size'])) err(errors, 'field_value', `${path}/size`, `size is [w, h] or [w, h, d], each ${L.size.min}–${L.size.max} m`, value['size']);
}

export function validateHitboxComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'hitbox is an object', value);
  const shape = value['shape'];
  const sphere = shape === 'sphere';
  fields(value, HITBOX_FIELDS, sphere ? ['radius'] : ['size'], path, errors);
  if (shape !== undefined && !(HITBOX_SHAPES as readonly unknown[]).includes(shape)) err(errors, 'field_value', `${path}/shape`, 'shape is box or sphere', shape);
  if (sphere && value['size'] !== undefined) err(errors, 'field_unexpected', `${path}/size`, 'a sphere hitbox has a radius, not a size', value['size']);
  if (!sphere && value['radius'] !== undefined) err(errors, 'field_unexpected', `${path}/radius`, 'only a sphere hitbox has a radius (set its shape)', value['radius']);
  if (value['size'] !== undefined && !sphere && !area(value['size'])) err(errors, 'field_value', `${path}/size`, `size is [w, h] or [w, h, d], each ${L.size.min}–${L.size.max} m`, value['size']);
  if (sphere) limited(value, 'radius', L.radius, ' m', path, errors);
  if (value['damage'] !== undefined && !(Number.isInteger(value['damage']) && num(value['damage'], L.damage.min, L.damage.max))) err(errors, 'field_value', `${path}/damage`, `damage is an integer ${L.damage.min}–${L.damage.max}`, value['damage']);
}

const copyArea = (v: [number, number] | [number, number, number]): [number, number] | [number, number, number] => (v.length === 3 ? [v[0], v[1], v[2]] : [v[0], v[1]]);

export const canonicalCollectible = (c: CollectibleComponent): CollectibleComponent => ({
  counter: c.counter,
  ...(c.amount !== undefined ? { amount: c.amount } : {}),
  ...(c.respawn !== undefined ? { respawn: c.respawn } : {}),
  ...(c.onCollect !== undefined ? { onCollect: c.onCollect } : {}),
  ...(c.size !== undefined ? { size: copyArea(c.size) } : {}),
});
export const canonicalPatrol = (c: PatrolComponent): PatrolComponent => ({
  mode: c.mode,
  ...(c.waypoints !== undefined ? { waypoints: c.waypoints.map((p) => [p[0], p[1], p[2]] as [number, number, number]) } : {}),
  ...(c.loop !== undefined ? { loop: c.loop } : {}),
  speed: c.speed,
  ...(c.wait !== undefined ? { wait: c.wait } : {}),
  ...(c.direction !== undefined ? { direction: [c.direction[0], c.direction[1], c.direction[2]] as [number, number, number] } : {}),
  ...(c.size !== undefined ? { size: copyArea(c.size) } : {}),
  ...(c.wallProbe !== undefined ? { wallProbe: c.wallProbe } : {}),
  ...(c.ledgeProbe !== undefined ? { ledgeProbe: c.ledgeProbe } : {}),
});
export const canonicalHitbox = (c: HitboxComponent): HitboxComponent => ({
  ...(c.shape !== undefined ? { shape: c.shape } : {}),
  ...(c.size !== undefined ? { size: copyArea(c.size) } : {}),
  ...(c.radius !== undefined ? { radius: c.radius } : {}),
  ...(c.damage !== undefined ? { damage: c.damage } : {}),
});

export const BLOCK_COMPONENTS = {
  mover: { validate: validateMoverComponent, canonical: canonicalMover, fields: MOVER_FIELDS },
  trigger: { validate: validateTriggerComponent, canonical: canonicalTrigger, fields: TRIGGER_FIELDS },
  switch: { validate: validateSwitchComponent, canonical: canonicalSwitch, fields: SWITCH_FIELDS },
  health: { validate: validateHealthComponent, canonical: canonicalHealth, fields: HEALTH_FIELDS },
  pickup: { validate: validatePickupComponent, canonical: canonicalPickup, fields: PICKUP_FIELDS },
  enemy: { validate: validateEnemyComponent, canonical: canonicalEnemy, fields: ENEMY_FIELDS },
  audioSource: { validate: validateAudioSourceComponent, canonical: canonicalAudioSource, fields: AUDIO_SOURCE_FIELDS },
  faceMovement: { validate: validateFaceMovementComponent, canonical: canonicalFaceMovement, fields: FACE_MOVEMENT_FIELDS },
  // Phase 24.4: last, so every existing entity keeps its exact canonical bytes.
  collectible: { validate: validateCollectibleComponent, canonical: canonicalCollectible, fields: COLLECTIBLE_FIELDS },
  patrol: { validate: validatePatrolComponent, canonical: canonicalPatrol, fields: PATROL_FIELDS },
  hitbox: { validate: validateHitboxComponent, canonical: canonicalHitbox, fields: HITBOX_FIELDS },
} as const;
export type BlockComponentName = keyof typeof BLOCK_COMPONENTS;
export const BLOCK_COMPONENT_NAMES = Object.keys(BLOCK_COMPONENTS) as BlockComponentName[];
