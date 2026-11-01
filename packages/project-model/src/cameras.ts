/**
 * The camera framework's data (v4 components).
 *
 * - `virtualCamera`: one shot the game can cut or blend to. A camera brain in
 *   the runtime picks the live one (the highest `priority` among the enabled
 *   cameras; on a tie the one activated last, then the first in the scene)
 *   and blends from the shot on screen to it; the brain owns the view (there
 *   is no scene camera). Without an enabled virtual camera the view holds a
 *   default pose (`DEFAULT_VIEW_POSE`) and Play warns. Rigs:
 *   - `follow`: orbits a target at `distance`, `yaw` and `pitch` (pitch
 *     limits), player-rotatable through input actions, pulled in front of
 *     colliders (3D projects);
 *   - `orbitPoint`: circles a point (or the target, or where it is placed),
 *     turning in snapped `yawStep`s on input, with zoom and tilt;
 *   - `topDown`: straight down onto the target from `distance`, turned by `yaw`;
 *   - `fixed`: where it is placed; with a target it looks at it;
 *   - `rail`: rides a `cameraPath` (a `progress` 0–1 along it, moving at
 *     `railSpeed`), looking at the target or along the path;
 *   - `track`: keeps its placed rotation and follows a target
 *     at an offset (`trackOffset`; absent: where it is placed relative to the
 *     target), moving only once the target leaves a dead zone around the
 *     point it frames, smoothed by `damping`, kept inside optional bounds
 *     (`boundsMin`/`boundsMax`, per axis) — a side view, a fixed-angle
 *     top-down or isometric view, a 3D chase that does not turn.
 *   A track camera may look ahead of a moving target
 *   (`lookAhead` seconds per axis — a vertical look-ahead is `[0, t, 0]` —
 *   capped at `lookAheadMax`, its velocity eased over `lookAheadSmoothing`),
 *   and camera regions change its dead zone, bounds and distance while the
 *   target is inside one.
 *   Each camera chooses what it does about what stands between it and its
 *   target (`occlusion`): `pullIn` moves a follow camera in front of the
 *   colliders a sphere of `collisionRadius` meets on the way from the target
 *   (fast in, held once clear, eased back out over `pullInTime`,
 *   `pullHoldTime` and `pullOutTime`); `seeThrough` leaves the camera where
 *   its rig puts it and thins what stands in front of the target (the
 *   project's see-through settings); `none` does neither.
 *   A camera may expose the picture itself (`autoExposure`, eye adaptation):
 *   the renderer meters the frame's average brightness (centre-weighted or
 *   the whole frame, `exposureMetering`) and moves the exposure toward
 *   middle grey, offset by `exposureCompensation` stops, at
 *   `exposureBrightenSpeed` while it rises and `exposureDarkenSpeed` while it
 *   falls, held between `exposureMin` and `exposureMax`. Off, the
 *   environment look's fixed exposure stands. The settings blend with the
 *   camera blend.
 *   Each camera also sets how the view blends to it (cut, linear, eased over
 *   `blendTime`), its lens (`fovY`, `near`, `far`: absent = the project's camera settings),
 *   a letterbox amount and a constant shake.
 * - `cameraRegion`: an axis-aligned box (centred on its object;
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
import { isPlainObject } from '@thirdlight/shared';

export const VIRTUAL_CAMERA_RIGS = ['follow', 'orbitPoint', 'topDown', 'fixed', 'rail', 'track'] as const;
export type VirtualCameraRig = (typeof VIRTUAL_CAMERA_RIGS)[number];
export const CAMERA_BLENDS = ['cut', 'linear', 'eased'] as const;
export type CameraBlendStyle = (typeof CAMERA_BLENDS)[number];
export const CAMERA_RAIL_MODES = ['once', 'loop', 'pingpong'] as const;
export type CameraRailMode = (typeof CAMERA_RAIL_MODES)[number];
export const CAMERA_OCCLUSION_MODES = ['pullIn', 'seeThrough', 'none'] as const;
export type CameraOcclusion = (typeof CAMERA_OCCLUSION_MODES)[number];
export const CAMERA_EXPOSURE_METERING = ['centerWeighted', 'average'] as const;
export type CameraExposureMetering = (typeof CAMERA_EXPOSURE_METERING)[number];

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
 * - collisionRadius 0.2 m: a head's width of clearance from walls (the
 *   sphere pull-in casts, so the near plane stays out of a wall);
 * - occlusion pullIn: a camera that never sits behind a wall and needs no
 *   material support (the third-person default of Unity's and Unreal's rigs);
 * - pullInTime 0.1 s: in within a few frames, so a wall swinging in is never
 *   seen through (the camera is never left inside a collider whatever the time);
 * - pullHoldTime 0.3 s: a doorway frame or a pillar passing by does not pump
 *   the camera in and out;
 * - pullOutTime 0.6 s: back out as a calm move, slower than the way in;
 * - autoExposure off: a camera shows the look's exposure as authored until
 *   a project asks for adaptation;
 * - exposureMin 0.0625 / exposureMax 2 (multipliers, as the look's exposure):
 *   four stops down for sunlit ground and sky (an evening outdoor look meters
 *   about three stops over at exposure 1, noon more), one stop up for a dim room, so a
 *   night or a cellar stays dark instead of being lifted to grey;
 * - exposureBrightenSpeed 1 / exposureDarkenSpeed 3 (per second, of the
 *   remaining gap in stops): stepping into the light settles in about a
 *   second, into the dark in about three, as the eye does (Unity's and
 *   Unreal's defaults alike);
 * - exposureMetering centerWeighted: the subject in the middle of the frame
 *   counts most, a bright sky at the edge less;
 * - exposureCompensation 0 stops: the frame's average lands on middle grey;
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
  occlusion: 'pullIn' as CameraOcclusion,
  pullInTime: 0.1,
  pullHoldTime: 0.3,
  pullOutTime: 0.6,
  autoExposure: false,
  exposureMin: 0.0625,
  exposureMax: 2,
  exposureBrightenSpeed: 1,
  exposureDarkenSpeed: 3,
  exposureMetering: 'centerWeighted' as CameraExposureMetering,
  exposureCompensation: 0,
});

/**
 * What a camera does about occluders: its own choice; else, for a camera that
 * never chose, the project's see-through setting when it is on (the setting
 * is the default of cameras without one, so a project that had see-through
 * keeps it), then `none` for a camera whose older `collision` is off, else
 * `pullIn`.
 */
export function virtualCameraOcclusion(c: { readonly occlusion?: unknown; readonly collision?: unknown }, projectSeeThrough: boolean): CameraOcclusion {
  if ((CAMERA_OCCLUSION_MODES as readonly unknown[]).includes(c.occlusion)) return c.occlusion as CameraOcclusion;
  if (projectSeeThrough) return 'seeThrough';
  return c.collision === false ? 'none' : VIRTUAL_CAMERA_DEFAULTS.occlusion;
}

/**
 * The project's default lens (the `camera_fov_deg`, `camera_near_m` and
 * `camera_far_m` settings; a virtual camera without its own lens uses them):
 * 60° vertical (the common game default, three.js's too) and 0.1–100 m, from
 * arm's length to a large level — what the scene camera entity defaulted to
 * before the engine owned the view, so an upgraded project draws the same.
 */
export const VIEW_LENS_DEFAULTS = Object.freeze({ fovY: 60, near: 0.1, far: 100 });

/**
 * Where the view looks from while no virtual camera is live (Play warns):
 * 1.6 m up (eye height) and 6 m back along +Z, level and looking down −Z
 * at the origin, where a new project's first objects land — something is on
 * screen instead of a black frame, and nothing about it is game-specific.
 */
export const DEFAULT_VIEW_POSE = Object.freeze({ position: Object.freeze([0, 1.6, 6]) as readonly [number, number, number], rotation: Object.freeze([0, 0, 0, 1]) as readonly [number, number, number, number] });

/**
 * The view a game draws through. Every API that reads or sets the view takes
 * a view key; there is one view today (`DEFAULT_VIEW_ID`), so a second one (a
 * split screen, a networked player's) is a new key, not a new API.
 */
export const DEFAULT_VIEW_ID = 'main';

/**
 * A view's forward flattened onto the ground shorter than this means it looks
 * straight down or up, and the screen's up is read as the way forward instead.
 * The runtime's view and the scene upgrade read a view's heading the same way.
 */
export const GROUND_FORWARD_MIN = 1e-3;

/** The project's default lens from its settings (absent keys: `VIEW_LENS_DEFAULTS`). */
export function viewLensOf(settings: unknown): { fovY: number; near: number; far: number } {
  const s = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : {};
  const n = (k: string, d: number): number => (typeof s[k] === 'number' && Number.isFinite(s[k]) ? (s[k] as number) : d);
  const fovY = n('camera_fov_deg', VIEW_LENS_DEFAULTS.fovY);
  const near = n('camera_near_m', VIEW_LENS_DEFAULTS.near);
  const far = n('camera_far_m', VIEW_LENS_DEFAULTS.far);
  return { fovY, near, far: far > near ? far : near * 1000 };
}

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
  /** A track camera's dead zone per axis (m). */
  deadZone: { min: 0, max: 1000 },
  /** A track camera's bounds (m). */
  bounds: { min: -1e6, max: 1e6 },
  /** A track camera's look-ahead (s of the target's velocity, per axis), its cap (m) and smoothing (s). */
  lookAhead: { min: 0, max: 10 },
  lookAheadMax: { min: 0, max: 1000 },
  lookAheadSmoothing: { min: 0, max: 10 },
  /** Pull-in's in, hold and out times (s). */
  pullTime: { min: 0, max: 10 },
  /** Auto-exposure's bounds (exposure multipliers, as the look's), its speeds (per second; 0: never that way) and compensation (stops). */
  exposure: { min: 0.01, max: 64 },
  exposureSpeed: { min: 0, max: 50 },
  exposureCompensation: { min: -8, max: 8 },
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
  /** Older switch of the follow rig's pull-in (false: none); `occlusion` supersedes it. */
  collision?: boolean;
  /** The radius of the sphere pull-in casts (the clearance from walls). */
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
  /** Track: the camera's position relative to the point it frames (absent: as placed relative to the target). */
  trackOffset?: [number, number, number];
  /** Track: the box (w, h, d; centred on the framed point) the target moves in before the camera follows (absent: none). */
  deadZone?: [number, number, number];
  /** Track: the framed point stays at or above this, per axis (absent: no limit). */
  boundsMin?: [number, number, number];
  /** Track: the framed point stays at or below this, per axis (absent: no limit). */
  boundsMax?: [number, number, number];
  /** Track: seconds of the target's velocity it looks ahead, per axis (absent: none; a vertical look-ahead is [0, t, 0]). */
  lookAhead?: [number, number, number];
  /** Track: the most it looks ahead, per axis (m; absent: 3). */
  lookAheadMax?: [number, number, number];
  /** Track: how long the target's velocity takes to ease in (s; absent: 0.2; 0: at once). */
  lookAheadSmoothing?: number;
  /** What it does about what stands in front of its target (absent: `virtualCameraOcclusion`). */
  occlusion?: CameraOcclusion;
  /** Pull-in: seconds to move in across its whole distance (0: at once), to hold once clear, and to ease back out. */
  pullInTime?: number;
  pullHoldTime?: number;
  pullOutTime?: number;
  /** The renderer adapts the exposure to the picture (absent: false: the look's fixed exposure). */
  autoExposure?: boolean;
  /** Auto-exposure: the lowest and highest exposure it reaches (multipliers). */
  exposureMin?: number;
  exposureMax?: number;
  /** Auto-exposure: how fast it rises (into the dark) and falls (into the light), per second of the gap in stops. */
  exposureBrightenSpeed?: number;
  exposureDarkenSpeed?: number;
  /** Auto-exposure: what it meters (absent: centre-weighted). */
  exposureMetering?: CameraExposureMetering;
  /** Auto-exposure: stops over (positive) or under middle grey. */
  exposureCompensation?: number;
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
  // Last, so every existing camera keeps its exact canonical bytes.
  'trackOffset',
  'deadZone',
  'boundsMin',
  'boundsMax',
  // Last again.
  'lookAhead',
  'lookAheadMax',
  'lookAheadSmoothing',
  // Last again.
  'occlusion',
  'pullInTime',
  'pullHoldTime',
  'pullOutTime',
  // Last again.
  'autoExposure',
  'exposureMin',
  'exposureMax',
  'exposureBrightenSpeed',
  'exposureDarkenSpeed',
  'exposureMetering',
  'exposureCompensation',
] as const;
export const CAMERA_PATH_FIELDS = ['points', 'closed', 'smooth'] as const;
export const CAMERA_PATH_LIMITS = Object.freeze({ minPoints: 2, maxPoints: 64, coordinate: 1e6 });

const ENTITY_ID_RE = ID_RE;
const ACTION_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

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
  ['pullInTime', VIRTUAL_CAMERA_LIMITS.pullTime],
  ['pullHoldTime', VIRTUAL_CAMERA_LIMITS.pullTime],
  ['pullOutTime', VIRTUAL_CAMERA_LIMITS.pullTime],
  ['exposureMin', VIRTUAL_CAMERA_LIMITS.exposure],
  ['exposureMax', VIRTUAL_CAMERA_LIMITS.exposure],
  ['exposureBrightenSpeed', VIRTUAL_CAMERA_LIMITS.exposureSpeed],
  ['exposureDarkenSpeed', VIRTUAL_CAMERA_LIMITS.exposureSpeed],
  ['exposureCompensation', VIRTUAL_CAMERA_LIMITS.exposureCompensation],
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
  for (const k of ['enabled', 'collision', 'autoExposure'] as const) {
    if (value[k] !== undefined && typeof value[k] !== 'boolean') err(errors, 'field_type', `${path}/${k}`, `${k} is true or false`, value[k]);
  }
  for (const k of ['target', 'path'] as const) {
    const v = value[k];
    if (v !== undefined && (typeof v !== 'string' || !ENTITY_ID_RE.test(v))) err(errors, 'field_value', `${path}/${k}`, `${k} names an entity (an entity id)`, v);
  }
  // A rail without a path is allowed (it is picked after the rig in the Inspector); it stays where it is placed.
  if (value['targetOffset'] !== undefined && !vec3(value['targetOffset'], VIRTUAL_CAMERA_LIMITS.offset.min, VIRTUAL_CAMERA_LIMITS.offset.max)) err(errors, 'field_value', `${path}/targetOffset`, 'targetOffset is [x, y, z] metres, each −1000–1000', value['targetOffset']);
  if (value['point'] !== undefined && !vec3(value['point'], VIRTUAL_CAMERA_LIMITS.point.min, VIRTUAL_CAMERA_LIMITS.point.max)) err(errors, 'field_value', `${path}/point`, 'point is [x, y, z] metres', value['point']);
  // The track rig's offset, dead zone and bounds (only a track camera reads them).
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
    // Look-ahead.
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
  if (value['occlusion'] !== undefined && !(CAMERA_OCCLUSION_MODES as readonly unknown[]).includes(value['occlusion'])) err(errors, 'field_value', `${path}/occlusion`, `occlusion is one of ${CAMERA_OCCLUSION_MODES.join(', ')}`, value['occlusion']);
  if (value['exposureMetering'] !== undefined && !(CAMERA_EXPOSURE_METERING as readonly unknown[]).includes(value['exposureMetering'])) err(errors, 'field_value', `${path}/exposureMetering`, `exposureMetering is one of ${CAMERA_EXPOSURE_METERING.join(', ')}`, value['exposureMetering']);
  if (value['blend'] !== undefined && !(CAMERA_BLENDS as readonly unknown[]).includes(value['blend'])) err(errors, 'field_value', `${path}/blend`, `blend is one of ${CAMERA_BLENDS.join(', ')}`, value['blend']);
  // Cross-field rules (both sides present).
  const { pitchMin, pitchMax, minDistance, maxDistance, near, far, exposureMin, exposureMax } = value as Record<string, unknown>;
  if (typeof exposureMin === 'number' && typeof exposureMax === 'number' && exposureMin > exposureMax) err(errors, 'field_value', `${path}/exposureMax`, 'exposureMax is at least exposureMin', exposureMax);
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

// ---- Camera regions -------------------------------------------------

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
