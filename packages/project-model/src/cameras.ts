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
 *     `railSpeed`), looking at the target or along the path;
 *   - `track` (phase 24.4g): keeps its placed rotation and follows a target
 *     at an offset (`trackOffset`; absent: where it is placed relative to the
 *     target), moving only once the target leaves a dead zone around the
 *     point it frames, smoothed by `damping`, kept inside optional bounds
 *     (`boundsMin`/`boundsMax`, per axis) — a side view, a fixed-angle
 *     top-down or isometric view, a 3D chase that does not turn.
 *   Phase 25.14: a track camera may look ahead of a moving target
 *   (`lookAhead` seconds per axis — a vertical look-ahead is `[0, t, 0]` —
 *   capped at `lookAheadMax`, its velocity eased over `lookAheadSmoothing`),
 *   and camera regions change its dead zone, bounds and distance while the
 *   target is inside one.
 *   Each camera also sets how the view blends to it (cut, linear, eased over
 *   `blendTime`), its lens (`fovY`, `near`, `far`: absent = the scene camera's),
 *   a letterbox amount and a constant shake.
 * - `cameraRegion` (phase 25.14): an axis-aligned box (centred on its object;
 *   the object's rotation is not used) that, while a track camera's target is
 *   inside it, gives that camera its own dead zone, bounds (offsets from the
 *   region's position, so the region carries them when it is moved or
 *   placed from a prefab) and distance (along the camera's offset), each
 *   absent field keeping the camera's own. Entering or leaving blends the
 *   change over the region's `blendTime`. Overlapping regions: the highest
 *   `priority`, then the one entered last, then the first loaded.
 * - `cameraPath`: points (offsets from the entity, like a mover's waypoints)
 *   a rail camera rides — a separate object so several cameras (and later the
 *   sequencer) can share one path; drawn and edited with the path handle.
 *
 * Pure: no I/O, no three.js.
 */
import { ID_RE } from './validate';
import type { ModelErrorV2 } from './errors';

export const VIRTUAL_CAMERA_RIGS = ['follow', 'orbitPoint', 'topDown', 'fixed', 'rail', 'track'] as const;
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
 * - shakeFrequency 8 Hz: a handheld/impact tremor, not a vibration;
 * - lookAheadMax 3 m per axis: about a storey or a few strides — the ground
 *   below a fall or the way ahead shows, the target never leaves the view;
 * - lookAheadSmoothing 0.2 s: a take-off or a landing eases the look-ahead in
 *   and out instead of snapping the view.
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
  lookAheadMax: Object.freeze([3, 3, 3]) as readonly [number, number, number],
  lookAheadSmoothing: 0.2,
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
  /** Phase 24.4g: a track camera's dead zone per axis (m). */
  deadZone: { min: 0, max: 1000 },
  /** Phase 24.4g: a track camera's bounds (m). */
  bounds: { min: -1e6, max: 1e6 },
  /** Phase 25.14: a track camera's look-ahead (s of the target's velocity, per axis), its cap (m) and smoothing (s). */
  lookAhead: { min: 0, max: 10 },
  lookAheadMax: { min: 0, max: 1000 },
  lookAheadSmoothing: { min: 0, max: 10 },
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
  /** Phase 24.4g, track: the camera's position relative to the point it frames (absent: as placed relative to the target). */
  trackOffset?: [number, number, number];
  /** Phase 24.4g, track: the box (w, h, d; centred on the framed point) the target moves in before the camera follows (absent: none). */
  deadZone?: [number, number, number];
  /** Phase 24.4g, track: the framed point stays at or above this, per axis (absent: no limit). */
  boundsMin?: [number, number, number];
  /** Phase 24.4g, track: the framed point stays at or below this, per axis (absent: no limit). */
  boundsMax?: [number, number, number];
  /** Phase 25.14, track: seconds of the target's velocity it looks ahead, per axis (absent: none; a vertical look-ahead is [0, t, 0]). */
  lookAhead?: [number, number, number];
  /** Phase 25.14, track: the most it looks ahead, per axis (m; absent: 3). */
  lookAheadMax?: [number, number, number];
  /** Phase 25.14, track: how long the target's velocity takes to ease in (s; absent: 0.2; 0: at once). */
  lookAheadSmoothing?: number;
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
  // Phase 24.4g: last, so every existing camera keeps its exact canonical bytes.
  'trackOffset',
  'deadZone',
  'boundsMin',
  'boundsMax',
  // Phase 25.14: last again.
  'lookAhead',
  'lookAheadMax',
  'lookAheadSmoothing',
] as const;
export const CAMERA_PATH_FIELDS = ['points', 'closed', 'smooth'] as const;
export const CAMERA_PATH_LIMITS = Object.freeze({ minPoints: 2, maxPoints: 64, coordinate: 1e6 });

const ENTITY_ID_RE = ID_RE;
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
  // Phase 24.4g: the track rig's offset, dead zone and bounds (only a track camera reads them).
  const track = rig === 'track';
  for (const k of ['trackOffset', 'deadZone', 'boundsMin', 'boundsMax', 'lookAhead', 'lookAheadMax', 'lookAheadSmoothing'] as const) {
    if (value[k] !== undefined && !track) err(errors, 'field_unexpected', `${path}/${k}`, `only a track camera has ${k}`, value[k]);
  }
  if (track) {
    if (value['trackOffset'] !== undefined && !vec3(value['trackOffset'], VIRTUAL_CAMERA_LIMITS.offset.min, VIRTUAL_CAMERA_LIMITS.offset.max)) err(errors, 'field_value', `${path}/trackOffset`, 'trackOffset is [x, y, z] metres, each −1000–1000', value['trackOffset']);
    if (value['deadZone'] !== undefined && !vec3(value['deadZone'], VIRTUAL_CAMERA_LIMITS.deadZone.min, VIRTUAL_CAMERA_LIMITS.deadZone.max)) err(errors, 'field_value', `${path}/deadZone`, 'deadZone is [w, h, d] metres, each 0–1000', value['deadZone']);
    for (const k of ['boundsMin', 'boundsMax'] as const) {
      if (value[k] !== undefined && !vec3(value[k], VIRTUAL_CAMERA_LIMITS.bounds.min, VIRTUAL_CAMERA_LIMITS.bounds.max)) err(errors, 'field_value', `${path}/${k}`, `${k} is [x, y, z] metres`, value[k]);
    }
    const lo = value['boundsMin'];
    const hi = value['boundsMax'];
    if (vec3(lo, -Infinity, Infinity) && vec3(hi, -Infinity, Infinity) && (lo as number[]).some((x, i) => x > (hi as number[])[i]!)) err(errors, 'field_value', `${path}/boundsMax`, 'boundsMax is at least boundsMin on every axis', hi);
    // Phase 25.14: look-ahead.
    const L = VIRTUAL_CAMERA_LIMITS;
    if (value['lookAhead'] !== undefined && !vec3(value['lookAhead'], L.lookAhead.min, L.lookAhead.max)) err(errors, 'field_value', `${path}/lookAhead`, `lookAhead is [x, y, z] seconds, each ${L.lookAhead.min}–${L.lookAhead.max}`, value['lookAhead']);
    if (value['lookAheadMax'] !== undefined && !vec3(value['lookAheadMax'], L.lookAheadMax.min, L.lookAheadMax.max)) err(errors, 'field_value', `${path}/lookAheadMax`, `lookAheadMax is [x, y, z] metres, each ${L.lookAheadMax.min}–${L.lookAheadMax.max}`, value['lookAheadMax']);
    if (value['lookAheadSmoothing'] !== undefined && !num(value['lookAheadSmoothing'], L.lookAheadSmoothing.min, L.lookAheadSmoothing.max)) err(errors, 'field_value', `${path}/lookAheadSmoothing`, `lookAheadSmoothing is ${L.lookAheadSmoothing.min}–${L.lookAheadSmoothing.max} s`, value['lookAheadSmoothing']);
  }
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

// ---- Phase 25.14: camera regions -------------------------------------------------

/** Blend 0.5 s: the camera blend's own default (a region change reads as a camera move). */
export const CAMERA_REGION_DEFAULTS = Object.freeze({ priority: 0, blendTime: VIRTUAL_CAMERA_DEFAULTS.blendTime });
/** A region spans 5 cm (a doorway's sliver) to 100 km (a whole world). */
export const CAMERA_REGION_LIMITS = Object.freeze({ size: { min: 0.05, max: 100000 } });

export interface CameraRegionComponent {
  /** Width, height (and depth; absent: every depth), centred on the object, along the world axes. */
  size: [number, number] | [number, number, number];
  /** The track camera it applies to (absent: every track camera). */
  camera?: string;
  /** Overlapping regions: the highest wins (absent: 0). */
  priority?: number;
  /** The camera's dead zone while its target is inside (absent: the camera's own). */
  deadZone?: [number, number, number];
  /** Bounds of the framed point, offsets from the region's position (absent: the camera's own). */
  boundsMin?: [number, number, number];
  boundsMax?: [number, number, number];
  /** The camera's distance from the framed point, along its offset (absent: the camera's own offset). */
  distance?: number;
  /** How long entering or leaving blends (s; absent: 0.5; 0: at once). */
  blendTime?: number;
}

export const CAMERA_REGION_FIELDS = ['size', 'camera', 'priority', 'deadZone', 'boundsMin', 'boundsMax', 'distance', 'blendTime'] as const;

export function validateCameraRegionComponent(value: unknown, path: string, errors: ModelErrorV2[]): void {
  if (!isPlainObject(value)) return err(errors, 'field_type', path, 'a cameraRegion component is an object { size, … }', value);
  for (const k of Object.keys(value)) {
    if (!(CAMERA_REGION_FIELDS as readonly string[]).includes(k)) err(errors, 'field_unexpected', `${path}/${k}`, `unknown field "${k}"`, k, CAMERA_REGION_FIELDS.join(', '));
  }
  const L = VIRTUAL_CAMERA_LIMITS;
  const size = value['size'];
  const S = CAMERA_REGION_LIMITS.size;
  if (size === undefined) err(errors, 'field_missing', `${path}/size`, '"size" is required', undefined, 'size');
  else if (!(Array.isArray(size) && (size.length === 2 || size.length === 3) && size.every((x) => num(x, S.min, S.max)))) err(errors, 'field_value', `${path}/size`, `size is [w, h] or [w, h, d] metres, each ${S.min}–${S.max}`, size);
  const cam = value['camera'];
  if (cam !== undefined && (typeof cam !== 'string' || !ENTITY_ID_RE.test(cam))) err(errors, 'field_value', `${path}/camera`, 'camera names an entity (an entity id)', cam);
  const p = value['priority'];
  if (p !== undefined && !(num(p, L.priority.min, L.priority.max) && Number.isInteger(p))) err(errors, 'field_value', `${path}/priority`, 'priority is a whole number −1000–1000', p);
  if (value['deadZone'] !== undefined && !vec3(value['deadZone'], L.deadZone.min, L.deadZone.max)) err(errors, 'field_value', `${path}/deadZone`, 'deadZone is [w, h, d] metres, each 0–1000', value['deadZone']);
  for (const k of ['boundsMin', 'boundsMax'] as const) {
    if (value[k] !== undefined && !vec3(value[k], L.bounds.min, L.bounds.max)) err(errors, 'field_value', `${path}/${k}`, `${k} is [x, y, z] metres from the region's position`, value[k]);
  }
  const lo = value['boundsMin'];
  const hi = value['boundsMax'];
  if (vec3(lo, -Infinity, Infinity) && vec3(hi, -Infinity, Infinity) && (lo as number[]).some((x, i) => x > (hi as number[])[i]!)) err(errors, 'field_value', `${path}/boundsMax`, 'boundsMax is at least boundsMin on every axis', hi);
  if (value['distance'] !== undefined && !num(value['distance'], L.distance.min, L.distance.max)) err(errors, 'field_value', `${path}/distance`, `distance is ${L.distance.min}–${L.distance.max}`, value['distance']);
  if (value['blendTime'] !== undefined && !num(value['blendTime'], L.blendTime.min, L.blendTime.max)) err(errors, 'field_value', `${path}/blendTime`, `blendTime is ${L.blendTime.min}–${L.blendTime.max}`, value['blendTime']);
}

export function canonicalCameraRegion(c: CameraRegionComponent): CameraRegionComponent {
  const out: Record<string, unknown> = {};
  const src = c as unknown as Record<string, unknown>;
  for (const k of CAMERA_REGION_FIELDS) {
    const v = src[k];
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? [...(v as number[])] : v;
  }
  return out as unknown as CameraRegionComponent;
}
