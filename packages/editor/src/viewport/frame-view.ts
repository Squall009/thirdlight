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
export function framePose(box: { readonly min: V3; readonly max: V3 }, eye: V3, target: V3, fovYDeg: number, aspect: number): FramePose {
  const center: [number, number, number] = [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
  const half = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2;
  const radius = Math.max(FRAME_RADIUS_MIN, half);
  const halfY = (fovYDeg * Math.PI) / 360;
  const halfX = Math.atan(Math.tan(halfY) * Math.max(1e-3, aspect));
  // The bounding sphere touches the narrower half-angle's sides: the camera is outside it (sin < 1), so outside the box.
  const distance = radius / Math.sin(Math.min(halfY, halfX));
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
  return { target: center, position: [center[0] + dir[0] * distance, center[1] + dir[1] * distance, center[2] + dir[2] * distance], distance };
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
