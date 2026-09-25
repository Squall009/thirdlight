/**
 * Pure transform math — runtime.md §6 (render interpolation policy).
 *
 * Read-only, normatively: every function returns FRESH derived values;
 * inputs (the snapshot, `prev`, `curr`, module state) are never mutated.
 * Quaternion inputs are normalized on derived COPIES only (project-model
 * §10.1 — accepted near-unit quaternions are never written back).
 *
 * Phase 21.2: the `…Into` forms write the same values into a caller's array
 * (the render path reuses its arrays); the fresh-array forms call them, so
 * both are the same arithmetic.
 */
import type { Quat, Vec3 } from '@thirdlight/project-model';

/** runtime.md §6: the near-identity slerp shortcut threshold. */
const NEAR_UNIT_DOT = 1 - 1e-9;

/** Component-wise lerp of two Vec3 into `out` (may not alias the inputs' use after writing). */
export function lerpVec3Into(out: number[], prev: Vec3, curr: Vec3, alpha: number): void {
  const x = prev[0] + (curr[0] - prev[0]) * alpha;
  const y = prev[1] + (curr[1] - prev[1]) * alpha;
  const z = prev[2] + (curr[2] - prev[2]) * alpha;
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

/** Component-wise lerp of two Vec3 (fresh array). */
export function lerpVec3(prev: Vec3, curr: Vec3, alpha: number): Vec3 {
  const out: [number, number, number] = [0, 0, 0];
  lerpVec3Into(out, prev, curr, alpha);
  return out;
}

/** Component-wise equality (the §6 `prev == curr` short-circuit). */
export function vec3Equal(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function quatEqual(a: Quat, b: Quat): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/** `out` := (x, y, z, w) normalized (the identity for a zero quaternion). */
function normalize4Into(out: number[], x: number, y: number, z: number, w: number): void {
  const len = Math.hypot(x, y, z, w);
  if (len === 0) {
    // defensive: the validator rejects zero quaternions
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 1;
    return;
  }
  out[0] = x / len;
  out[1] = y / len;
  out[2] = z / len;
  out[3] = w / len;
}

/**
 * Quaternion slerp into `out` (runtime.md §6, normative):
 * - inputs are derived copies (normalized copies — never written back);
 * - sign-align first (if dot < 0, negate the second — shortest arc);
 * - when dot > 1 − 1e-9 use the normalized linear lerp (avoids the
 *   zero-angle singularity);
 * - otherwise the standard constant-rate slerp.
 */
export function slerpQuatInto(out: number[], prev: Quat, curr: Quat, alpha: number): void {
  // The normalized copies, as locals.
  let len = Math.hypot(prev[0], prev[1], prev[2], prev[3]);
  let a0 = 0;
  let a1 = 0;
  let a2 = 0;
  let a3 = 1;
  if (len !== 0) {
    a0 = prev[0] / len;
    a1 = prev[1] / len;
    a2 = prev[2] / len;
    a3 = prev[3] / len;
  }
  len = Math.hypot(curr[0], curr[1], curr[2], curr[3]);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 1;
  if (len !== 0) {
    b0 = curr[0] / len;
    b1 = curr[1] / len;
    b2 = curr[2] / len;
    b3 = curr[3] / len;
  }
  let dot = a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
  if (dot < 0) {
    b0 = -b0;
    b1 = -b1;
    b2 = -b2;
    b3 = -b3;
    dot = -dot;
  }
  if (dot > NEAR_UNIT_DOT) {
    // Normalized linear lerp (near-identity / zero-angle case).
    normalize4Into(out, a0 + (b0 - a0) * alpha, a1 + (b1 - a1) * alpha, a2 + (b2 - a2) * alpha, a3 + (b3 - a3) * alpha);
    return;
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - alpha) * theta) / s;
  const wb = Math.sin(alpha * theta) / s;
  normalize4Into(out, a0 * wa + b0 * wb, a1 * wa + b1 * wb, a2 * wa + b2 * wb, a3 * wa + b3 * wb);
}

/** Quaternion slerp (fresh array; see `slerpQuatInto`). */
export function slerpQuat(prev: Quat, curr: Quat, alpha: number): Quat {
  const out: [number, number, number, number] = [0, 0, 0, 1];
  slerpQuatInto(out, prev, curr, alpha);
  return out;
}
