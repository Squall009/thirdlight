/**
 * Phase 20.1: small vector maths and the effect origin transform.
 */

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];
export type Quat = [number, number, number, number];

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Rotate a vector by a unit quaternion [x, y, z, w]. */
export function rotate(q: Quat, v: Vec3): Vec3 {
  const [x, y, z, w] = q;
  // t = 2 × (q.xyz × v); v' = v + w t + q.xyz × t
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}
export const conjugate = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/**
 * Where an effect plays from: the entity's world position, rotation and
 * scale. Effect ("local") space is this frame: world = R·(S·p) + T.
 */
export interface EffectOrigin {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

export const IDENTITY_ORIGIN: EffectOrigin = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

const mul3 = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const div3 = (a: Vec3, b: Vec3): Vec3 => [b[0] !== 0 ? a[0] / b[0] : 0, b[1] !== 0 ? a[1] / b[1] : 0, b[2] !== 0 ? a[2] / b[2] : 0];

/** An effect-space point in world space. */
export const toWorldPoint = (o: EffectOrigin, p: Vec3): Vec3 => add(rotate(o.rotation, mul3(o.scale, p)), o.position);
/** An effect-space vector (offset, velocity) in world space. */
export const toWorldVector = (o: EffectOrigin, v: Vec3): Vec3 => rotate(o.rotation, mul3(o.scale, v));
/** An effect-space direction (axis, normal) in world space, unit length. */
export const toWorldDirection = (o: EffectOrigin, d: Vec3): Vec3 => normalize(rotate(o.rotation, div3(d, o.scale)));
/** A world point in effect space. */
export const toLocalPoint = (o: EffectOrigin, p: Vec3): Vec3 => div3(rotate(conjugate(o.rotation), sub(p, o.position)), o.scale);
/** A world vector in effect space. */
export const toLocalVector = (o: EffectOrigin, v: Vec3): Vec3 => div3(rotate(conjugate(o.rotation), v), o.scale);
