/**
 * Phase 23.4: the camera framework's pure maths — rig poses, camera paths,
 * blends, seeded shake and screen projection. No three.js, no DOM, no I/O:
 * the camera brain (camera-brain.ts) runs it inside the simulation step, so
 * a replay or the simulation worker computes exactly the same camera; the
 * editor draws its frustum previews with the same functions.
 *
 * Conventions (three.js-compatible, the renderer applies the pose as is):
 * a camera looks down its local −Z with +Y up. `yaw` (degrees) turns about
 * +Y — 0 looks toward −Z, 90 toward −X; `pitch` (degrees) is how far the
 * view looks down (positive: from above). A rig at yaw ψ, pitch θ sits at
 * `pivot + distance · (sin ψ cos θ, sin θ, cos ψ cos θ)` looking at the pivot.
 */

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];

/** One resolved camera: where it is, where it looks, its lens and letterbox. */
export interface CameraPose {
  position: V3;
  rotation: Q4;
  /** Vertical field of view, degrees. */
  fovY: number;
  near: number;
  far: number;
  /** Each letterbox bar's share of the view height (0–0.5). */
  letterbox: number;
}

const DEG = Math.PI / 180;

export function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** `smoothstep` ease (0 → 0, 1 → 1, zero slope at both ends). */
export function easeInOut(t: number): number {
  const x = clampNum(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/** The camera rotation for a yaw and a pitch (degrees): qYaw(ψ) · qPitch(−θ), no roll. */
export function quatFromYawPitch(yawDeg: number, pitchDeg: number, out: Q4 = [0, 0, 0, 1]): Q4 {
  const hy = (yawDeg * DEG) / 2;
  const hp = (-pitchDeg * DEG) / 2;
  const sy = Math.sin(hy);
  const cy = Math.cos(hy);
  const sx = Math.sin(hp);
  const cx = Math.cos(hp);
  out[0] = cy * sx;
  out[1] = sy * cx;
  out[2] = -sy * sx;
  out[3] = cy * cx;
  return out;
}

/** The unit offset from the pivot to a rig camera at yaw/pitch (degrees). */
export function orbitOffset(yawDeg: number, pitchDeg: number, distance: number, out: V3 = [0, 0, 0]): V3 {
  const y = yawDeg * DEG;
  const p = pitchDeg * DEG;
  const cp = Math.cos(p);
  out[0] = distance * Math.sin(y) * cp;
  out[1] = distance * Math.sin(p);
  out[2] = distance * Math.cos(y) * cp;
  return out;
}

/** Yaw and pitch (degrees) of a view looking along `dir` (null: no direction). */
export function yawPitchOf(dx: number, dy: number, dz: number): { yaw: number; pitch: number } | null {
  const len = Math.hypot(dx, dy, dz);
  if (!(len > 1e-12)) return null;
  const pitch = Math.asin(clampNum(-dy / len, -1, 1)) / DEG;
  const horiz = Math.hypot(dx, dz);
  const yaw = horiz > 1e-12 ? Math.atan2(-dx, -dz) / DEG : 0;
  return { yaw, pitch };
}

/** The rotation looking from `from` at `to` (upright; `fallback` when they coincide). */
export function lookAtQuat(from: readonly number[], to: readonly number[], fallback: readonly number[], out: Q4 = [0, 0, 0, 1]): Q4 {
  const yp = yawPitchOf(to[0]! - from[0]!, to[1]! - from[1]!, to[2]! - from[2]!);
  if (yp === null) {
    out[0] = fallback[0]!;
    out[1] = fallback[1]!;
    out[2] = fallback[2]!;
    out[3] = fallback[3]!;
    return out;
  }
  return quatFromYawPitch(yp.yaw, yp.pitch, out);
}

export function quatMul(a: readonly number[], b: readonly number[], out: Q4 = [0, 0, 0, 1]): Q4 {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, aw = a[3]!;
  const bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/** `v` rotated by the unit quaternion `q`. */
export function rotateVec(q: readonly number[], vx: number, vy: number, vz: number, out: V3 = [0, 0, 0]): V3 {
  const qx = q[0]!, qy = q[1]!, qz = q[2]!, qw = q[3]!;
  // t = 2 · (q.xyz × v); v' = v + w·t + q.xyz × t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out[0] = vx + qw * tx + (qy * tz - qz * ty);
  out[1] = vy + qw * ty + (qz * tx - qx * tz);
  out[2] = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

export function normalizeQuat(q: Q4): Q4 {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len === 0) {
    q[0] = 0;
    q[1] = 0;
    q[2] = 0;
    q[3] = 1;
    return q;
  }
  q[0] /= len;
  q[1] /= len;
  q[2] /= len;
  q[3] /= len;
  return q;
}

/** Shortest-arc slerp of two unit quaternions (normalized lerp when nearly equal). */
export function slerp(a: readonly number[], b: readonly number[], t: number, out: Q4 = [0, 0, 0, 1]): Q4 {
  let bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!;
  let dot = a[0]! * bx + a[1]! * by + a[2]! * bz + a[3]! * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let ka: number;
  let kb: number;
  if (dot > 1 - 1e-9) {
    ka = 1 - t;
    kb = t;
  } else {
    const th = Math.acos(clampNum(dot, -1, 1));
    const s = Math.sin(th);
    ka = Math.sin((1 - t) * th) / s;
    kb = Math.sin(t * th) / s;
  }
  out[0] = a[0]! * ka + bx * kb;
  out[1] = a[1]! * ka + by * kb;
  out[2] = a[2]! * ka + bz * kb;
  out[3] = a[3]! * ka + bw * kb;
  return normalizeQuat(out);
}

export function newPose(): CameraPose {
  return { position: [0, 0, 0], rotation: [0, 0, 0, 1], fovY: 60, near: 0.1, far: 100, letterbox: 0 };
}

export function copyPose(from: CameraPose, to: CameraPose): CameraPose {
  to.position[0] = from.position[0];
  to.position[1] = from.position[1];
  to.position[2] = from.position[2];
  to.rotation[0] = from.rotation[0];
  to.rotation[1] = from.rotation[1];
  to.rotation[2] = from.rotation[2];
  to.rotation[3] = from.rotation[3];
  to.fovY = from.fovY;
  to.near = from.near;
  to.far = from.far;
  to.letterbox = from.letterbox;
  return to;
}

/** `out` := the blend of two poses at weight `w` (position and lens lerp, rotation slerp). */
export function blendPoses(a: CameraPose, b: CameraPose, w: number, out: CameraPose): CameraPose {
  for (let k = 0; k < 3; k += 1) out.position[k] = a.position[k]! + (b.position[k]! - a.position[k]!) * w;
  slerp(a.rotation, b.rotation, w, out.rotation);
  out.fovY = a.fovY + (b.fovY - a.fovY) * w;
  out.near = a.near + (b.near - a.near) * w;
  out.far = a.far + (b.far - a.far) * w;
  out.letterbox = a.letterbox + (b.letterbox - a.letterbox) * w;
  return out;
}

// ---- camera paths ------------------------------------------------------------------

/** Samples per curve segment of a smooth path (the arc-length table's resolution). */
const PATH_SEGMENT_SAMPLES = 16;

/** A path sampled once into a polyline with cumulative lengths (offsets from its entity). */
export interface SampledPath {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly zs: Float64Array;
  /** Cumulative length at each sample (0 … length). */
  readonly lengths: Float64Array;
  readonly length: number;
  readonly closed: boolean;
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** Sample a camera path (uniform Catmull-Rom through the points when smooth, else straight segments). */
export function samplePath(points: readonly (readonly number[])[], closed: boolean, smooth: boolean): SampledPath {
  const n = points.length;
  const segs = closed ? n : n - 1;
  const per = smooth ? PATH_SEGMENT_SAMPLES : 1;
  const count = Math.max(1, segs * per) + 1;
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const zs = new Float64Array(count);
  const at = (i: number): readonly number[] => {
    if (closed) return points[((i % n) + n) % n]!;
    return points[clampNum(i, 0, n - 1)]!;
  };
  let k = 0;
  for (let s = 0; s < segs; s += 1) {
    const p0 = at(s - 1);
    const p1 = at(s);
    const p2 = at(s + 1);
    const p3 = at(s + 2);
    for (let j = 0; j < per; j += 1) {
      const t = j / per;
      if (smooth) {
        xs[k] = catmull(p0[0]!, p1[0]!, p2[0]!, p3[0]!, t);
        ys[k] = catmull(p0[1]!, p1[1]!, p2[1]!, p3[1]!, t);
        zs[k] = catmull(p0[2]!, p1[2]!, p2[2]!, p3[2]!, t);
      } else {
        xs[k] = p1[0]! + (p2[0]! - p1[0]!) * t;
        ys[k] = p1[1]! + (p2[1]! - p1[1]!) * t;
        zs[k] = p1[2]! + (p2[2]! - p1[2]!) * t;
      }
      k += 1;
    }
  }
  const last = closed ? points[0]! : points[n - 1]!;
  xs[k] = last[0]!;
  ys[k] = last[1]!;
  zs[k] = last[2]!;
  const lengths = new Float64Array(count);
  for (let i = 1; i < count; i += 1) lengths[i] = lengths[i - 1]! + Math.hypot(xs[i]! - xs[i - 1]!, ys[i]! - ys[i - 1]!, zs[i]! - zs[i - 1]!);
  return { xs, ys, zs, lengths, length: lengths[count - 1]!, closed };
}

/** The point at `progress` (0–1, by arc length) and the direction of travel there. */
export function pointOnPath(path: SampledPath, progress: number, pos: V3, tangent: V3): void {
  const count = path.xs.length;
  const target = clampNum(progress, 0, 1) * path.length;
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (path.lengths[mid]! <= target) lo = mid;
    else hi = mid;
  }
  const span = path.lengths[hi]! - path.lengths[lo]!;
  const f = span > 0 ? (target - path.lengths[lo]!) / span : 0;
  pos[0] = path.xs[lo]! + (path.xs[hi]! - path.xs[lo]!) * f;
  pos[1] = path.ys[lo]! + (path.ys[hi]! - path.ys[lo]!) * f;
  pos[2] = path.zs[lo]! + (path.zs[hi]! - path.zs[lo]!) * f;
  tangent[0] = path.xs[hi]! - path.xs[lo]!;
  tangent[1] = path.ys[hi]! - path.ys[lo]!;
  tangent[2] = path.zs[hi]! - path.zs[lo]!;
}

// ---- seeded shake --------------------------------------------------------------------

/** A deterministic hash of three integers to [−1, 1]. */
function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** Smooth 1D value noise in [−1, 1] at time `t` (lattice per unit), one channel per `axis`. */
export function shakeNoise(seed: number, axis: number, t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash3(seed, axis, i);
  const b = hash3(seed, axis, i + 1);
  return a + (b - a) * easeInOut(f);
}

/** A seed from a text (FNV-1a), for a camera's constant shake. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h | 0;
}

/**
 * Offset a pose by a shake (in the camera's own frame: sideways and up by up
 * to `amplitude` metres, turned by up to `rotationDeg`), at time `t` seconds.
 */
export function applyShake(pose: CameraPose, seed: number, t: number, frequency: number, amplitude: number, rotationDeg: number): void {
  if (!(amplitude > 0) && !(rotationDeg > 0)) return;
  const u = t * frequency;
  if (amplitude > 0) {
    const off = rotateVec(pose.rotation, shakeNoise(seed, 0, u) * amplitude, shakeNoise(seed, 1, u) * amplitude, 0);
    pose.position[0] += off[0];
    pose.position[1] += off[1];
    pose.position[2] += off[2];
  }
  if (rotationDeg > 0) {
    const yaw = shakeNoise(seed, 2, u) * rotationDeg;
    const pitch = shakeNoise(seed, 3, u) * rotationDeg;
    const q = quatFromYawPitch(yaw, pitch);
    quatMul(pose.rotation, q, pose.rotation);
    normalizeQuat(pose.rotation);
  }
}

// ---- screen projection ---------------------------------------------------------------

export interface ScreenPoint {
  /** 0 at the left edge, 1 at the right. */
  x: number;
  /** 0 at the top edge, 1 at the bottom. */
  y: number;
  /** Distance in front of the camera (m; negative: behind it). */
  depth: number;
  /** Inside the view: on screen and between the near and far planes. */
  onScreen: boolean;
}

/** Where a world point appears on screen (normalized coordinates) through `pose` at `aspect`. */
export function worldToScreen(pose: CameraPose, aspect: number, px: number, py: number, pz: number): ScreenPoint {
  const r = pose.rotation;
  const inv: Q4 = [-r[0], -r[1], -r[2], r[3]];
  const v = rotateVec(inv, px - pose.position[0], py - pose.position[1], pz - pose.position[2]);
  const depth = -v[2];
  const t = Math.tan((pose.fovY * DEG) / 2);
  if (!(depth > 1e-9)) return { x: 0.5, y: 0.5, depth, onScreen: false };
  const nx = v[0] / depth / (t * aspect);
  const ny = v[1] / depth / t;
  const x = (nx + 1) / 2;
  const y = (1 - ny) / 2;
  return { x, y, depth, onScreen: x >= 0 && x <= 1 && y >= 0 && y <= 1 && depth >= pose.near && depth <= pose.far };
}

/** The ray from the camera through a screen point (normalized coordinates, 0,0 top-left). */
export function screenToRay(pose: CameraPose, aspect: number, x: number, y: number): { origin: V3; direction: V3 } {
  const t = Math.tan((pose.fovY * DEG) / 2);
  const nx = x * 2 - 1;
  const ny = 1 - y * 2;
  const dx = nx * t * aspect;
  const dy = ny * t;
  const len = Math.hypot(dx, dy, 1);
  const dir = rotateVec(pose.rotation, dx / len, dy / len, -1 / len);
  return { origin: [pose.position[0], pose.position[1], pose.position[2]], direction: dir };
}
