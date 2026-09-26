/**
 * Phase 23.4: the camera framework's data (v4 components).
 *
 * - `virtualCamera`: one shot the game can cut or blend to. A camera brain in
 *   the runtime picks the live one (the highest `priority` among the enabled
 *   cameras; on a tie the one activated last, then the first in the scene)
 *   and blends from the shot on screen to it. Without an enabled virtual
 *   camera the scene camera shows its own pose (a `cameraFollow`, or where it
 *   was placed) exactly as before. Rigs:
 *   - `follow`: orbits a target at `distance`, `yaw` and `pitch` (pitch
 *     limits), player-rotatable through input actions, pulled in front of
 *     colliders (3D projects);
 *   - `orbitPoint`: circles a point (or the target, or where it is placed),
 *     turning in snapped `yawStep`s on input, with zoom and tilt;
 *   - `topDown`: straight down onto the target from `distance`, turned by `yaw`;
 *   - `fixed`: where it is placed; with a target it looks at it;
 *   - `rail`: rides a `cameraPath` (a `progress` 0–1 along it, moving at
 *     `railSpeed`), looking at the target or along the path.
 *   Each camera also sets how the view blends to it (cut, linear, eased over
 *   `blendTime`), its lens (`fovY`, `near`, `far`: absent = the scene camera's),
 *   a letterbox amount and a constant shake.
 * - `cameraPath`: points (offsets from the entity, like a mover's waypoints)
 *   a rail camera rides — a separate object so several cameras (and later the
 *   sequencer) can share one path; drawn and edited with the path handle.
 *
 * Pure: no I/O, no three.js.
 */
import type { ModelErrorV2 } from './errors';

export const VIRTUAL_CAMERA_RIGS = ['follow', 'orbitPoint', 'topDown', 'fixed', 'rail'] as const;
export type VirtualCameraRig = (typeof VIRTUAL_CAMERA_RIGS)[number];
export const CAMERA_BLENDS = ['cut', 'linear', 'eased'] as const;
export type CameraBlendStyle = (typeof CAMERA_BLENDS)[number];
export const CAMERA_RAIL_MODES = ['once', 'loop', 'pingpong'] as const;
export type CameraRailMode = (typeof CAMERA_RAIL_MODES)[number];

/**
 * The engine defaults (every one genre-neutral):
 * - priority 0: every camera equal until a project ranks them (the one
 *   activated last wins a tie);
 * - distance 5 m: a few body lengths from a person-size target — the whole
 *   figure and some ground around it at a 60° lens;
 * - pitch 20° with limits −30°…80°: slightly above (the ground ahead shows),
 *   never flipping over the top or far under the floor;
 * - minDistance 0.5 m / maxDistance 100 m: the closest a pulled-in or zoomed
 *   camera comes (just outside a head) and the farthest it zooms (a small
 *   field in view);
 * - rotateSpeed 120°/s: a third of a turn per second at full stick;
 * - zoomSpeed 10 m/s: across the default range in a few seconds;
 * - yawStep 90°: a quarter turn — the four sides of anything built on a grid;
 * - turnTime 0.25 s: a snapped turn reads as a move, not a cut, and is done
 *   before the next press;
 * - collisionRadius 0.2 m: a head's width of clearance from walls;
 * - damping 0 s: rigid (the camera sits exactly where its rig says);
 * - blend eased over 0.5 s: reads as a camera move without holding up play;
 * - shakeFrequency 8 Hz: a handheld/impact tremor, not a vibration.
 */
export const VIRTUAL_CAMERA_DEFAULTS = Object.freeze({
  priority: 0,
  enabled: true,
  targetOffset: Object.freeze([0, 0, 0]) as readonly [number, number, number],
  distance: 5,
  minDistance: 0.5,
  maxDistance: 100,
  yaw: 0,
  pitch: 20,
  pitchMin: -30,
  pitchMax: 80,
  rotateSpeed: 120,
  zoomSpeed: 10,
  yawStep: 90,
  turnTime: 0.25,
  collision: true,
  collisionRadius: 0.2,
  damping: 0,
  progress: 0,
  railSpeed: 0,
  railMode: 'once' as CameraRailMode,
  blend: 'eased' as CameraBlendStyle,
  blendTime: 0.5,
  letterbox: 0,
  shakeAmplitude: 0,
  shakeFrequency: 8,
  shakeRotation: 0,
});

/** The ranges of the numeric fields (engine limits that keep the maths sane). */
export const VIRTUAL_CAMERA_LIMITS = Object.freeze({
  priority: { min: -1000, max: 1000 },
  offset: { min: -1000, max: 1000 },
  distance: { min: 0.1, max: 10000 },
  minDistance: { min: 0, max: 10000 },
  maxDistance: { min: 0.1, max: 10000 },
  yaw: { min: -360, max: 360 },
  pitch: { min: -89, max: 90 },
  rotateSpeed: { min: 0, max: 1440 },
  zoomSpeed: { min: 0, max: 1000 },
  yawStep: { min: 1, max: 180 },
  turnTime: { min: 0, max: 10 },
  collisionRadius: { min: 0, max: 5 },
  damping: { min: 0, max: 10 },
  point: { min: -1e6, max: 1e6 },
  progress: { min: 0, max: 1 },
  railSpeed: { min: -1000, max: 1000 },
  fovY: { min: 1, max: 179 },
  near: { min: 0.001, max: 100000 },
  far: { min: 0.01, max: 10000000 },
  blendTime: { min: 0, max: 30 },
  letterbox: { min: 0, max: 0.5 },
  shakeAmplitude: { min: 0, max: 10 },
  shakeFrequency: { min: 0.1, max: 60 },
  shakeRotation: { min: 0, max: 45 },
});

export interface VirtualCameraComponent {
  rig: VirtualCameraRig;
  /** Higher wins (absent: 0). */
  priority?: number;
  /** Takes part from the start (absent: true); scripts activate and deactivate it. */
  enabled?: boolean;
  /** The entity it follows / circles / looks at. */
  target?: string;
  /** Added to the target's position (e.g. a character's head height). */
  targetOffset?: [number, number, number];
  distance?: number;
  minDistance?: number;
  maxDistance?: number;
  yaw?: number;
  pitch?: number;
  pitchMin?: number;
  pitchMax?: number;
  /** Input actions (by name) that turn and tilt the camera. */
  yawAction?: string;
  pitchAction?: string;
  rotateSpeed?: number;
  zoomAction?: string;
  zoomSpeed?: number;
  /** orbitPoint: a press of these turns one `yawStep`. */
  turnLeftAction?: string;
  turnRightAction?: string;
  yawStep?: number;
  turnTime?: number;
  /** orbitPoint: the world point it circles (absent: the target, else where it is placed). */
  point?: [number, number, number];
  collision?: boolean;
  collisionRadius?: number;
  damping?: number;
  /** rail: the entity carrying the `cameraPath`. */
  path?: string;
  progress?: number;
  railSpeed?: number;
  railMode?: CameraRailMode;
  fovY?: number;
  near?: number;
  far?: number;
  blend?: CameraBlendStyle;
  blendTime?: number;
  letterbox?: number;
  shakeAmplitude?: number;
  shakeFrequency?: number;
  shakeRotation?: number;
}

export interface CameraPathComponent {
  /** 2–64 points, offsets from where the path's entity is placed. */
  points: [number, number, number][];
  /** The path runs back from the last point to the first (absent: false). */
  closed?: boolean;
  /** A smooth curve through the points (absent: true); false: straight segments. */
  smooth?: boolean;
}

export const VIRTUAL_CAMERA_FIELDS = [
  'rig',
  'priority',
  'enabled',
  'target',
  'targetOffset',
  'distance',
  'minDistance',
  'maxDistance',
  'yaw',
  'pitch',
  'pitchMin',
  'pitchMax',
  'yawAction',
  'pitchAction',
  'rotateSpeed',
  'zoomAction',
  'zoomSpeed',
  'turnLeftAction',
  'turnRightAction',
  'yawStep',
  'turnTime',
  'point',
  'collision',
  'collisionRadius',
  'damping',
  'path',
  'progress',
  'railSpeed',
  'railMode',
  'fovY',
  'near',
  'far',
  'blend',
  'blendTime',
  'letterbox',
  'shakeAmplitude',
  'shakeFrequency',
  'shakeRotation',
] as const;
export const CAMERA_PATH_FIELDS = ['points', 'closed', 'smooth'] as const;
export const CAMERA_PATH_LIMITS = Object.freeze({ minPoints: 2, maxPoints: 64, coordinate: 1e6 });

const ENTITY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ACTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function err(errors: ModelErrorV2[], code: string, path: string, message: string, found?: unknown, expected?: string): void {
  errors.push({ code, path, message, ...(found !== undefined ? { found } : {}), ...(expected !== undefined ? { expected } : {}) } as ModelErrorV2);
}
const num = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const vec3 = (v: unknown, lo: number, hi: number): boolean => Array.isArray(v) && v.length === 3 && v.every((x) => num(x, lo, hi));

const NUMBER_FIELDS: readonly (readonly [keyof VirtualCameraComponent, { min: number; max: number }])[] = [
  ['distance', VIRTUAL_CAMERA_LIMITS.distance],
  ['minDistance', VIRTUAL_CAMERA_LIMITS.minDistance],
  ['maxDistance', VIRTUAL_CAMERA_LIMITS.maxDistance],
  ['yaw', VIRTUAL_CAMERA_LIMITS.yaw],
  ['pitch', VIRTUAL_CAMERA_LIMITS.pitch],
  ['pitchMin', VIRTUAL_CAMERA_LIMITS.pitch],
  ['pitchMax', VIRTUAL_CAMERA_LIMITS.pitch],
  ['rotateSpeed', VIRTUAL_CAMERA_LIMITS.rotateSpeed],
  ['zoomSpeed', VIRTUAL_CAMERA_LIMITS.zoomSpeed],
  ['yawStep', VIRTUAL_CAMERA_LIMITS.yawStep],
  ['turnTime', VIRTUAL_CAMERA_LIMITS.turnTime],
  ['collisionRadius', VIRTUAL_CAMERA_LIMITS.collisionRadius],
  ['damping', VIRTUAL_CAMERA_LIMITS.damping],
  ['progress', VIRTUAL_CAMERA_LIMITS.progress],
  ['railSpeed', VIRTUAL_CAMERA_LIMITS.railSpeed],
  ['fovY', VIRTUAL_CAMERA_LIMITS.fovY],
  ['near', VIRTUAL_CAMERA_LIMITS.near],
  ['far', VIRTUAL_CAMERA_LIMITS.far],
  ['blendTime', VIRTUAL_CAMERA_LIMITS.blendTime],
  ['letterbox', VIRTUAL_CAMERA_LIMITS.letterbox],
  ['shakeAmplitude', VIRTUAL_CAMERA_LIMITS.shakeAmplitude],
  ['shakeFrequency', VIRTUAL_CAMERA_LIMITS.shakeFrequency],
  ['shakeRotation', VIRTUAL_CAMERA_LIMITS.shakeRotation],
];
const ACTION_FIELDS = ['yawAction', 'pitchAction', 'zoomAction', 'turnLeftAction', 'turnRightAction'] as const;

export function validateVirtualCameraComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a virtualCamera component is an object { rig, … }', value);
  for (const k of Object.keys(value)) {
    if (!(VIRTUAL_CAMERA_FIELDS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, VIRTUAL_CAMERA_FIELDS.join(', '));
  }
  const rig = value['rig'];
  if (rig === undefined) err(errors, 'field_missing', `${path}/rig`, '"rig" is required', undefined, 'rig');
  else if (!(VIRTUAL_CAMERA_RIGS as readonly unknown[]).includes(rig)) err(errors, 'field_value', `${path}/rig`, `rig is one of ${VIRTUAL_CAMERA_RIGS.join(', ')}`, rig);
  const p = value['priority'];
  if (p !== undefined && !(num(p, VIRTUAL_CAMERA_LIMITS.priority.min, VIRTUAL_CAMERA_LIMITS.priority.max) && Number.isInteger(p))) err(errors, 'field_value', `${path}/priority`, 'priority is a whole number −1000–1000', p);
  for (const k of ['enabled', 'collision'] as const) {
    if (value[k] !== undefined && typeof value[k] !== 'boolean') err(errors, 'field_type', `${path}/${k}`, `${k} is true or false`, value[k]);
  }
  for (const k of ['target', 'path'] as const) {
    const v = value[k];
    if (v !== undefined && (typeof v !== 'string' || !ENTITY_ID_RE.test(v))) err(errors, 'field_value', `${path}/${k}`, `${k} names an entity (an entity id)`, v);
  }
  // A rail without a path is allowed (it is picked after the rig in the Inspector); it stays where it is placed.
  if (value['targetOffset'] !== undefined && !vec3(value['targetOffset'], VIRTUAL_CAMERA_LIMITS.offset.min, VIRTUAL_CAMERA_LIMITS.offset.max)) err(errors, 'field_value', `${path}/targetOffset`, 'targetOffset is [x, y, z] metres, each −1000–1000', value['targetOffset']);
  if (value['point'] !== undefined && !vec3(value['point'], VIRTUAL_CAMERA_LIMITS.point.min, VIRTUAL_CAMERA_LIMITS.point.max)) err(errors, 'field_value', `${path}/point`, 'point is [x, y, z] metres', value['point']);
  for (const [k, lim] of NUMBER_FIELDS) {
    const v = value[k];
    if (v !== undefined && !num(v, lim.min, lim.max)) err(errors, 'field_value', `${path}/${k}`, `${k} is ${lim.min}–${lim.max}`, v);
  }
  for (const k of ACTION_FIELDS) {
    const v = value[k];
    if (v !== undefined && (typeof v !== 'string' || !ACTION_RE.test(v))) err(errors, 'field_value', `${path}/${k}`, `${k} names an input action (a letter or _, then letters, digits or _; at most 32)`, v);
  }
  if (value['railMode'] !== undefined && !(CAMERA_RAIL_MODES as readonly unknown[]).includes(value['railMode'])) err(errors, 'field_value', `${path}/railMode`, `railMode is one of ${CAMERA_RAIL_MODES.join(', ')}`, value['railMode']);
  if (value['blend'] !== undefined && !(CAMERA_BLENDS as readonly unknown[]).includes(value['blend'])) err(errors, 'field_value', `${path}/blend`, `blend is one of ${CAMERA_BLENDS.join(', ')}`, value['blend']);
  // Cross-field rules (both sides present).
  const { pitchMin, pitchMax, minDistance, maxDistance, near, far } = value as Record<string, unknown>;
  if (typeof pitchMin === 'number' && typeof pitchMax === 'number' && pitchMin > pitchMax) err(errors, 'field_value', `${path}/pitchMax`, 'pitchMax is at least pitchMin', pitchMax);
  if (typeof minDistance === 'number' && typeof maxDistance === 'number' && minDistance > maxDistance) err(errors, 'field_value', `${path}/maxDistance`, 'maxDistance is at least minDistance', maxDistance);
  if (typeof near === 'number' && typeof far === 'number' && !(far > near)) err(errors, 'field_value', `${path}/far`, 'far is beyond near', far);
}

export function canonicalVirtualCamera(c: VirtualCameraComponent): VirtualCameraComponent {
  const out: Record<string, unknown> = {};
  const src = c as unknown as Record<string, unknown>;
  for (const k of VIRTUAL_CAMERA_FIELDS) {
    const v = src[k];
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? [...(v as number[])] : v;
  }
  return out as unknown as VirtualCameraComponent;
}

export function validateCameraPathComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a cameraPath component is an object { points, closed?, smooth? }', value);
  for (const k of Object.keys(value)) {
    if (!(CAMERA_PATH_FIELDS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, CAMERA_PATH_FIELDS.join(', '));
  }
  const pts = value['points'];
  if (pts === undefined) err(errors, 'field_missing', `${path}/points`, '"points" is required', undefined, 'points');
  else if (!Array.isArray(pts) || pts.length < CAMERA_PATH_LIMITS.minPoints || pts.length > CAMERA_PATH_LIMITS.maxPoints || !pts.every((q) => vec3(q, -CAMERA_PATH_LIMITS.coordinate, CAMERA_PATH_LIMITS.coordinate))) {
    err(errors, 'field_value', `${path}/points`, `points is a list of ${CAMERA_PATH_LIMITS.minPoints}–${CAMERA_PATH_LIMITS.maxPoints} offsets [x, y, z] metres`, pts);
  }
  for (const k of ['closed', 'smooth'] as const) {
    if (value[k] !== undefined && typeof value[k] !== 'boolean') err(errors, 'field_type', `${path}/${k}`, `${k} is true or false`, value[k]);
  }
}

export function canonicalCameraPath(c: CameraPathComponent): CameraPathComponent {
  return {
    points: c.points.map((q) => [q[0], q[1], q[2]] as [number, number, number]),
    ...(c.closed !== undefined ? { closed: c.closed } : {}),
    ...(c.smooth !== undefined ? { smooth: c.smooth } : {}),
  };
}
