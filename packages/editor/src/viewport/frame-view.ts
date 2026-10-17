/**
 * Where the Scene view's camera goes to frame a box (Home in an editor, the
 * selection's or the object's; F on a selected object; framing the level).
 *
 * The camera looks at the box's centre from outside its bounding sphere,
 * far enough that the sphere fits the narrower of the two view angles, so a
 * building framed is seen whole from outside its walls, never from inside.
 * It keeps the view's heading and its pitch while that looks down at a
 * sensible slope: a level view (or one from below) is lifted, a view
 * straight down eased off, so walls and their tops both show.
 *
 * Docked panels cover part of the view: the frame fits and centres in what
 * they leave free (`FrameInsets`), so a wide building is never half under a
 * panel column. The orbit's target moves sideways with it, so the box's
 * centre sits in the middle of the free part, not behind a panel.
 *
 * On entering an editor the view is kept when it already shows the object
 * sensibly (`viewShowsBox`), and framed otherwise.
 *
 * Pure maths: vitest checks it without a renderer.
 */

import type { TerrainStamp } from '@thirdlight/project-model';

type V3 = readonly [number, number, number];

/** The shallowest a framing view looks down (degrees below the horizon): lower would see walls edge-on, or a building's floor through its open top from inside. */
export const FRAME_PITCH_MIN_DEG = 20;
/** The steepest (degrees): straight down shows roofs and floors but no walls. */
export const FRAME_PITCH_MAX_DEG = 65;
/** The smallest radius framed (metres): a point or a tiny object is framed as this much around it. */
export const FRAME_RADIUS_MIN = 2;

/** A view looking down less than this (degrees) is nearly level: on entering an editor it is framed, not kept. */
export const ENTRY_LEVEL_DEG = 10;
/** The least part of the view's width or height a frame keeps free, however much the panels cover. */
const FRAME_FREE_MIN = 0.25;

/** The parts (0–1) of the view's width (left, right) and height (top, bottom) that open panels cover. */
export interface FrameInsets {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export const NO_INSETS: FrameInsets = { left: 0, right: 0, top: 0, bottom: 0 };

/** Two opposite insets, shrunk alike when they would leave less than `FRAME_FREE_MIN` free. */
function freeSpan(a: number, b: number): [number, number] {
  const lo = Math.max(0, a);
  const hi = Math.max(0, b);
  const room = 1 - FRAME_FREE_MIN;
  const k = lo + hi > room ? room / (lo + hi) : 1;
  return [lo * k, hi * k];
}

/** The camera's forward, right and up for the view from `eye` to `target` (up: the world's +y; straight down looks along -z's up). */
function axes(eye: V3, target: V3): { f: V3; r: V3; u: V3 } {
  const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
  const f: V3 = [d[0]! / l, d[1]! / l, d[2]! / l];
  let r: [number, number, number] = [-f[2], 0, f[0]];
  const rl = Math.hypot(r[0], r[2]);
  r = rl < 1e-6 ? [1, 0, 0] : [r[0] / rl, 0, r[2] / rl];
  const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
  return { f, r, u };
}

/** How far a view looks down (degrees below the horizon; negative: up). */
export function viewPitchDeg(eye: V3, target: V3): number {
  return (Math.atan2(eye[1] - target[1], Math.hypot(eye[0] - target[0], eye[2] - target[2])) * 180) / Math.PI;
}

export interface FramePose {
  readonly target: [number, number, number];
  readonly position: [number, number, number];
  /** The camera's distance from the target. */
  readonly distance: number;
}

/**
 * The pose that frames `box` (world metres) from the view at `eye` looking
 * at `target`, for a vertical view angle `fovYDeg` and `aspect` (width /
 * height).
 */
export function framePose(box: { readonly min: V3; readonly max: V3 }, eye: V3, target: V3, fovYDeg: number, aspect: number, insets: FrameInsets = NO_INSETS): FramePose {
  const center: [number, number, number] = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const half = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2;
  const radius = Math.max(FRAME_RADIUS_MIN, half);
  const [left, right] = freeSpan(insets.left, insets.right);
  const [top, bottom] = freeSpan(insets.top, insets.bottom);
  const tanY = Math.tan((fovYDeg * Math.PI) / 360);
  const tanX = tanY * Math.max(1e-3, aspect);
  // The free part's centre on screen (-1…1, y up), and its half-angles there: the sphere must fit those, seen off the
  // view's axis — where a sphere looks wider, by the square root of (1 + the offset's tangent squared).
  const cx = left - right;
  const cy = bottom - top;
  const off = Math.hypot(cx * tanX, cy * tanY);
  const freeY = Math.atan((tanY * (1 - top - bottom)) / (1 + off * off));
  const freeX = Math.atan((tanX * (1 - left - right)) / (1 + off * off));
  // The bounding sphere touches the narrower half-angle's sides: the camera is outside it (sin < 1), so outside the box.
  const distance = radius / Math.sin(Math.min(freeY, freeX));
  let hx = eye[0] - target[0];
  let hz = eye[2] - target[2];
  const flat = Math.hypot(hx, hz);
  const up = eye[1] - target[1];
  if (flat < 1e-6) {
    // Straight down (or no view yet): look from +z.
    hx = 0;
    hz = 1;
  } else {
    hx /= flat;
    hz /= flat;
  }
  const pitchNow = flat < 1e-6 ? (up >= 0 ? 90 : -90) : (Math.atan2(up, flat) * 180) / Math.PI;
  const pitch = (Math.min(FRAME_PITCH_MAX_DEG, Math.max(FRAME_PITCH_MIN_DEG, pitchNow)) * Math.PI) / 180;
  const c = Math.cos(pitch);
  const dir: V3 = [hx * c, Math.sin(pitch), hz * c];
  // The target moves so the box's centre shows at the free part's centre (`cx`, `cy` on screen at the target's depth).
  const { r, u } = axes([dir[0], dir[1], dir[2]], [0, 0, 0]);
  const sx = cx * tanX * distance;
  const sy = cy * tanY * distance;
  const aim: [number, number, number] = [0, 1, 2].map((i) => center[i]! - r[i]! * sx - u[i]! * sy) as [number, number, number];
  return { target: aim, position: [aim[0] + dir[0] * distance, aim[1] + dir[1] * distance, aim[2] + dir[2] * distance], distance };
}

/**
 * Whether the view from `eye` to `target` shows `box` sensibly, so entering
 * an editor keeps it: not from inside the box, not from below it, not nearly
 * level with the ground, and aimed at it (the target over its footprint, or
 * its centre inside the view's angles).
 */
export function viewShowsBox(box: { readonly min: V3; readonly max: V3 }, eye: V3, target: V3, fovYDeg: number, aspect: number): boolean {
  if (insideBox(eye, box) || eye[1] < box.min[1] || viewPitchDeg(eye, target) < ENTRY_LEVEL_DEG) return false;
  if (target[0] >= box.min[0] && target[0] <= box.max[0] && target[2] >= box.min[2] && target[2] <= box.max[2]) return true;
  const { f, r, u } = axes(eye, target);
  const d = [0, 1, 2].map((i) => (box.min[i]! + box.max[i]!) / 2 - eye[i]!);
  const dot = (a: V3): number => a[0] * d[0]! + a[1] * d[1]! + a[2] * d[2]!;
  const z = dot(f);
  const tanY = Math.tan((fovYDeg * Math.PI) / 360);
  return z > 0 && Math.abs(dot(r) / z) <= tanY * aspect && Math.abs(dot(u) / z) <= tanY;
}

/** Whether `p` is inside `box` grown by `margin` metres on every side. */
export function insideBox(p: V3, box: { readonly min: V3; readonly max: V3 }, margin = 0): boolean {
  return [0, 1, 2].every((i) => p[i]! >= box.min[i]! - margin && p[i]! <= box.max[i]! + margin);
}

/** A box to frame in world metres; `ground`: a terrain whose ground under the box's centre its heights are measured from. */
export interface FrameBox {
  readonly min: readonly number[];
  readonly max: readonly number[];
  readonly ground?: string;
}

/** The box around every box given (null: none); the ground stays only when all measure from the same one. */
export function unionBoxes(boxes: readonly (FrameBox | null)[]): FrameBox | null {
  const some = boxes.filter((b): b is FrameBox => b !== null);
  if (some.length === 0) return null;
  const min = [0, 1, 2].map((i) => Math.min(...some.map((b) => b.min[i]!)));
  const max = [0, 1, 2].map((i) => Math.max(...some.map((b) => b.max[i]!)));
  const ground = some[0]!.ground;
  return { min, max, ...(ground !== undefined && some.every((b) => b.ground === ground) ? { ground } : {}) };
}

/**
 * A terrain stamp's box in world metres: its square turned on the ground, as
 * high as it raises or digs — from its own height where it names one (max,
 * min with a `y`), else down (or up, a dig) from the ground under its
 * centre, which the stamp's full height has already raised (or lowered).
 */
export function stampFrameBox(stamp: TerrainStamp, terrainId: string): FrameBox {
  const turn = ((stamp.rotation ?? 0) * Math.PI) / 180;
  const half = (stamp.size / 2) * (Math.abs(Math.cos(turn)) + Math.abs(Math.sin(turn)));
  const [x, z] = stamp.at;
  const own = stamp.mode !== undefined && stamp.mode !== 'add' && stamp.y !== undefined;
  const [lo, hi] = own ? [stamp.y! + Math.min(0, stamp.height), stamp.y! + Math.max(0, stamp.height)] : [Math.min(0, -stamp.height), Math.max(0, -stamp.height)];
  return { min: [x - half, lo, z - half], max: [x + half, hi, z + half], ...(own ? {} : { ground: terrainId }) };
}
