/**
 * 3D geometry for the gameplay blocks (pure, deterministic).
 * Its own module, shared by the blocks and the generic primitives.
 */

type Vec3 = [number, number, number];
export type V3 = readonly [number, number, number];

/** Rotate `p` by the unit quaternion `q` ([x, y, z, w]); `inverse` rotates by its conjugate. */
export function rotate3(q: readonly number[], p: V3, inverse = false): Vec3 {
  const qx = inverse ? -(q[0] ?? 0) : (q[0] ?? 0);
  const qy = inverse ? -(q[1] ?? 0) : (q[1] ?? 0);
  const qz = inverse ? -(q[2] ?? 0) : (q[2] ?? 0);
  const qw = q[3] ?? 1;
  const [x, y, z] = p;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

export const sub3 = (a: V3, b: V3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Squared distance from point `p` to segment `a`–`b`. */
export function segmentPointDistance2(a: V3, b: V3, p: V3): number {
  const ab = sub3(b, a);
  const len2 = dot3(ab, ab);
  const t = len2 > 0 ? clamp01(dot3(sub3(p, a), ab) / len2) : 0;
  const d = sub3(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
  return dot3(d, d);
}

/** Squared distance between segments `p1`–`q1` and `p2`–`q2` (closest points, Ericson, Real-Time Collision Detection). */
export function segmentSegmentDistance2(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = sub3(q1, p1);
  const d2 = sub3(q2, p2);
  const r = sub3(p1, p2);
  const a = dot3(d1, d1);
  const e = dot3(d2, d2);
  const f = dot3(d2, r);
  let s: number;
  let t: number;
  if (a <= 1e-12 && e <= 1e-12) return dot3(r, r);
  if (a <= 1e-12) {
    s = 0;
    t = clamp01(f / e);
  } else {
    const c = dot3(d1, r);
    if (e <= 1e-12) {
      t = 0;
      s = clamp01(-c / a);
    } else {
      const b = dot3(d1, d2);
      const denom = a * e - b * b;
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1: Vec3 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s];
  const c2: Vec3 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t];
  const d = sub3(c1, c2);
  return dot3(d, d);
}

/**
 * Squared distance from segment `a`–`b` to the box of half extents `half`
 * centred at the origin (axis-aligned; the caller works in the box's frame).
 * The distance along the segment is convex, so a fixed golden-section search
 * finds its minimum (80 rounds: far below a micrometre; deterministic).
 */
export function segmentBoxDistance2(a: V3, b: V3, half: V3): number {
  const at = (t: number): number => {
    let d = 0;
    for (let i = 0; i < 3; i += 1) {
      const v = a[i]! + (b[i]! - a[i]!) * t;
      const o = Math.abs(v) - half[i]!;
      if (o > 0) d += o * o;
    }
    return d;
  };
  const g = (Math.sqrt(5) - 1) / 2;
  let lo = 0;
  let hi = 1;
  let x1 = hi - g * (hi - lo);
  let x2 = lo + g * (hi - lo);
  let f1 = at(x1);
  let f2 = at(x2);
  for (let i = 0; i < 80; i += 1) {
    if (f1 <= f2) {
      hi = x2;
      x2 = x1;
      f2 = f1;
      x1 = hi - g * (hi - lo);
      f1 = at(x1);
    } else {
      lo = x1;
      x1 = x2;
      f1 = f2;
      x2 = lo + g * (hi - lo);
      f2 = at(x2);
    }
  }
  return Math.min(at(0), at(1), f1, f2);
}
