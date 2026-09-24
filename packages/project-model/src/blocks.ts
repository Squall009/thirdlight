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
export const TRIGGER_SHAPES = ['box', 'circle'] as const;
export const TRIGGER_MODES = ['enter', 'stay'] as const;
/** Phase 14.2: a circle trigger's radius range (m) — the same extent a box trigger may have (0.05–500 m across). */
export const TRIGGER_RADIUS = { min: 0.025, max: 250 } as const;

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
}

export interface TriggerComponent {
  /** A box's [w, h] (required for a box, refused for a circle). */
  size?: [number, number];
  signal: string;
  once?: boolean;
  /** Emitted when the player leaves the area. */
  exitSignal?: string;
  /** Phase 14.2: the area's shape (absent: box). */
  shape?: (typeof TRIGGER_SHAPES)[number];
  /** Phase 14.2: a circle's radius in meters (required for a circle, refused for a box). */
  radius?: number;
  /** Phase 14.2: `enter` (absent) emits once per entry, `stay` every step while the player is inside. */
  mode?: (typeof TRIGGER_MODES)[number];
}

export interface SwitchComponent {
  mode: (typeof SWITCH_MODES)[number];
  signal: string;
  size: [number, number];
  once?: boolean;
}

export interface HealthComponent {
  max: number;
  /** Health at the start of a level and after a respawn (default: max). */
  start?: number;
  invulnerableSeconds?: number;
  /** A hit pushes the player away from what hurt it at this speed (m/s). */
  knockback?: number;
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

function fields(v: Record<string, unknown>, allowed: readonly string[], required: readonly string[], path: string, errors: ModelErrorV2[]): void {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, allowed.join(', '));
  for (const k of required) if (v[k] === undefined) err(errors, 'field_missing', `${path}/${k}`, `"${k}" is required`, undefined, k);
}

export function validateMoverComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'mover is an object', value);
  fields(value, ['waypoints', 'speed', 'mode', 'wait', 'easing', 'startOn'], ['waypoints', 'speed', 'mode'], path, errors);
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
  const circle = value['shape'] === 'circle';
  fields(value, ['size', 'signal', 'once', 'exitSignal', 'shape', 'radius', 'mode'], circle ? ['radius', 'signal'] : ['size', 'signal'], path, errors);
  if (value['exitSignal'] !== undefined && (typeof value['exitSignal'] !== 'string' || !NAME_RE.test(value['exitSignal']))) err(errors, 'field_value', `${path}/exitSignal`, 'exitSignal is a name', value['exitSignal']);
  if (value['shape'] !== undefined && !(TRIGGER_SHAPES as readonly unknown[]).includes(value['shape'])) err(errors, 'field_value', `${path}/shape`, 'shape is box or circle', value['shape']);
  if (circle && value['size'] !== undefined) err(errors, 'field_unexpected', `${path}/size`, 'a circle trigger has a radius, not a size', value['size']);
  if (!circle && value['radius'] !== undefined) err(errors, 'field_unexpected', `${path}/radius`, 'only a circle trigger has a radius (set shape to circle)', value['radius']);
  if (value['size'] !== undefined && !circle && !vec2(value['size'], 0.05, 500)) err(errors, 'field_value', `${path}/size`, 'size is [w, h] in meters', value['size']);
  if (value['radius'] !== undefined && circle && !num(value['radius'], TRIGGER_RADIUS.min, TRIGGER_RADIUS.max)) err(errors, 'field_value', `${path}/radius`, `radius is ${TRIGGER_RADIUS.min}–${TRIGGER_RADIUS.max} m`, value['radius']);
  if (value['mode'] !== undefined && !(TRIGGER_MODES as readonly unknown[]).includes(value['mode'])) err(errors, 'field_value', `${path}/mode`, 'mode is enter or stay', value['mode']);
  if (value['signal'] !== undefined && (typeof value['signal'] !== 'string' || !NAME_RE.test(value['signal']))) err(errors, 'field_value', `${path}/signal`, 'signal is a name', value['signal']);
  if (value['once'] !== undefined && typeof value['once'] !== 'boolean') err(errors, 'field_type', `${path}/once`, 'once is true or false', value['once']);
}

export function validateSwitchComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'switch is an object', value);
  fields(value, ['mode', 'signal', 'size', 'once'], ['mode', 'signal', 'size'], path, errors);
  if (value['mode'] !== undefined && !(SWITCH_MODES as readonly unknown[]).includes(value['mode'])) err(errors, 'field_value', `${path}/mode`, 'mode is interact or stand', value['mode']);
  if (value['signal'] !== undefined && (typeof value['signal'] !== 'string' || !NAME_RE.test(value['signal']))) err(errors, 'field_value', `${path}/signal`, 'signal is a name', value['signal']);
  if (value['size'] !== undefined && !vec2(value['size'], 0.05, 100)) err(errors, 'field_value', `${path}/size`, 'size is [w, h] in meters', value['size']);
  if (value['once'] !== undefined && typeof value['once'] !== 'boolean') err(errors, 'field_type', `${path}/once`, 'once is true or false', value['once']);
}

export function validateHealthComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'health is an object', value);
  fields(value, ['max', 'start', 'invulnerableSeconds', 'knockback'], ['max'], path, errors);
  if (value['start'] !== undefined && !(Number.isInteger(value['start']) && num(value['start'], 1, typeof value['max'] === 'number' ? value['max'] : 1000))) err(errors, 'field_value', `${path}/start`, 'start is an integer 1–max', value['start']);
  if (value['knockback'] !== undefined && !num(value['knockback'], 0, 20)) err(errors, 'field_value', `${path}/knockback`, 'knockback is 0–20 m/s', value['knockback']);
  if (value['max'] !== undefined && !(Number.isInteger(value['max']) && num(value['max'], 1, 1000))) err(errors, 'field_value', `${path}/max`, 'max is an integer 1–1000', value['max']);
  if (value['invulnerableSeconds'] !== undefined && !num(value['invulnerableSeconds'], 0, 10)) err(errors, 'field_value', `${path}/invulnerableSeconds`, 'invulnerableSeconds is 0–10', value['invulnerableSeconds']);
}

export function validatePickupComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'pickup is an object', value);
  fields(value, ['kind', 'value', 'counter', 'size', 'respawn', 'cue'], ['kind', 'value'], path, errors);
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
  fields(value, ['patrol', 'range', 'speed', 'size', 'contactDamage', 'stompable', 'health', 'chase'], ['patrol', 'speed', 'size', 'contactDamage', 'stompable', 'health'], path, errors);
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
});
// Phase 14.2: the new fields come last (an existing trigger keeps its exact canonical bytes).
export const canonicalTrigger = (c: TriggerComponent): TriggerComponent => ({
  ...(c.size !== undefined ? { size: copy2(c.size) } : {}),
  signal: c.signal,
  ...(c.once !== undefined ? { once: c.once } : {}),
  ...(c.exitSignal !== undefined ? { exitSignal: c.exitSignal } : {}),
  ...(c.shape !== undefined ? { shape: c.shape } : {}),
  ...(c.radius !== undefined ? { radius: c.radius } : {}),
  ...(c.mode !== undefined ? { mode: c.mode } : {}),
});
export const canonicalSwitch = (c: SwitchComponent): SwitchComponent => ({ mode: c.mode, signal: c.signal, size: copy2(c.size), ...(c.once !== undefined ? { once: c.once } : {}) });
export const canonicalHealth = (c: HealthComponent): HealthComponent => ({
  max: c.max,
  ...(c.start !== undefined ? { start: c.start } : {}),
  ...(c.invulnerableSeconds !== undefined ? { invulnerableSeconds: c.invulnerableSeconds } : {}),
  ...(c.knockback !== undefined ? { knockback: c.knockback } : {}),
});
export const canonicalPickup = (c: PickupComponent): PickupComponent => ({
  kind: c.kind,
  value: c.value,
  ...(c.counter !== undefined ? { counter: c.counter } : {}),
  ...(c.size !== undefined ? { size: copy2(c.size) } : {}),
  ...(c.respawn !== undefined ? { respawn: c.respawn } : {}),
  ...(c.cue !== undefined ? { cue: c.cue } : {}),
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
});

/** Every block component, with its validator and canonical form (v4 scenes). */
/** Phase 9.10: a sound that loops where the entity is, louder as the player comes near (along X). */
export interface AudioSourceComponent {
  /** An audio (cue) or music asset. */
  assetId: string;
  /** 0–1 at full volume. */
  volume: number;
  /** Heard within this many meters (full volume within a quarter of it). */
  range: number;
}

export function validateAudioSourceComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'audioSource is an object', value);
  fields(value, ['assetId', 'volume', 'range'], ['assetId', 'volume', 'range'], path, errors);
  if (value['assetId'] !== undefined && (typeof value['assetId'] !== 'string' || value['assetId'].length === 0 || value['assetId'].length > 128)) err(errors, 'field_value', `${path}/assetId`, 'assetId names an audio or music asset', value['assetId']);
  if (value['volume'] !== undefined && !num(value['volume'], 0, 1)) err(errors, 'field_value', `${path}/volume`, 'volume is 0–1', value['volume']);
  if (value['range'] !== undefined && !num(value['range'], 0.5, 500)) err(errors, 'field_value', `${path}/range`, 'range is 0.5–500 m', value['range']);
}

export const canonicalAudioSource = (c: AudioSourceComponent): AudioSourceComponent => ({ assetId: c.assetId, volume: c.volume, range: c.range });

/**
 * Phase 9.13: a model that turns to face where its parent is going (the
 * player's model, a boar under its enemy): yaw (degrees about +Y) when the
 * parent moves right or left, reached over `turnSeconds`.
 */
export interface FaceMovementComponent {
  yawRight: number;
  yawLeft: number;
  turnSeconds?: number;
}

export function validateFaceMovementComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'faceMovement is an object', value);
  fields(value, ['yawRight', 'yawLeft', 'turnSeconds'], ['yawRight', 'yawLeft'], path, errors);
  for (const k of ['yawRight', 'yawLeft'] as const) if (value[k] !== undefined && !num(value[k], -360, 360)) err(errors, 'field_value', `${path}/${k}`, `${k} is −360–360 degrees`, value[k]);
  if (value['turnSeconds'] !== undefined && !num(value['turnSeconds'], 0, 5)) err(errors, 'field_value', `${path}/turnSeconds`, 'turnSeconds is 0–5', value['turnSeconds']);
}

export const canonicalFaceMovement = (c: FaceMovementComponent): FaceMovementComponent => ({ yawRight: c.yawRight, yawLeft: c.yawLeft, ...(c.turnSeconds !== undefined ? { turnSeconds: c.turnSeconds } : {}) });

export const BLOCK_COMPONENTS = {
  mover: { validate: validateMoverComponent, canonical: canonicalMover, fields: ['waypoints', 'speed', 'mode', 'wait', 'easing', 'startOn'] },
  trigger: { validate: validateTriggerComponent, canonical: canonicalTrigger, fields: ['size', 'signal', 'once', 'exitSignal', 'shape', 'radius', 'mode'] },
  switch: { validate: validateSwitchComponent, canonical: canonicalSwitch, fields: ['mode', 'signal', 'size', 'once'] },
  health: { validate: validateHealthComponent, canonical: canonicalHealth, fields: ['max', 'start', 'invulnerableSeconds', 'knockback'] },
  pickup: { validate: validatePickupComponent, canonical: canonicalPickup, fields: ['kind', 'value', 'counter', 'size', 'respawn', 'cue'] },
  enemy: { validate: validateEnemyComponent, canonical: canonicalEnemy, fields: ['patrol', 'range', 'speed', 'size', 'contactDamage', 'stompable', 'health', 'chase'] },
  audioSource: { validate: validateAudioSourceComponent, canonical: canonicalAudioSource, fields: ['assetId', 'volume', 'range'] },
  faceMovement: { validate: validateFaceMovementComponent, canonical: canonicalFaceMovement, fields: ['yawRight', 'yawLeft', 'turnSeconds'] },
} as const;
export type BlockComponentName = keyof typeof BLOCK_COMPONENTS;
export const BLOCK_COMPONENT_NAMES = Object.keys(BLOCK_COMPONENTS) as BlockComponentName[];
