/**
 * Pure transform math — runtime.md §6 (render interpolation policy).
 *
 * Read-only, normatively: every function returns FRESH derived values;
 * inputs (the snapshot, `prev`, `curr`, module state) are never mutated.
 * Quaternion inputs are normalized on derived COPIES only (project-model
 * §10.1 — accepted near-unit quaternions are never written back).
 */
import type { Quat, Vec3 } from '@thirdlight/project-model';

/** runtime.md §6: the near-identity slerp shortcut threshold. */
const NEAR_UNIT_DOT = 1 - 1e-9;

/** Component-wise lerp of two Vec3 (fresh array). */
export function lerpVec3(prev: Vec3, curr: Vec3, alpha: number): Vec3 {
  return [
    prev[0] + (curr[0] - prev[0]) * alpha,
    prev[1] + (curr[1] - prev[1]) * alpha,
    prev[2] + (curr[2] - prev[2]) * alpha,
  ];
}

/** Component-wise equality (the §6 `prev == curr` short-circuit). */
export function vec3Equal(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function quatEqual(a: Quat, b: Quat): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function normalize4(q: readonly [number, number, number, number]): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len === 0) return [0, 0, 0, 1]; // defensive: the validator rejects zero quaternions
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/**
 * Quaternion slerp (runtime.md §6, normative):
 * - inputs are derived copies (normalized copies — never written back);
 * - sign-align first (if dot < 0, negate the second — shortest arc);
 * - when dot > 1 − 1e-9 use the normalized linear lerp (avoids the
 *   zero-angle singularity);
 * - otherwise the standard constant-rate slerp.
 */
export function slerpQuat(prev: Quat, curr: Quat, alpha: number): Quat {
  const a = normalize4(prev);
  let b = normalize4(curr);
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  if (dot < 0) {
    b = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  if (dot > NEAR_UNIT_DOT) {
    // Normalized linear lerp (near-identity / zero-angle case).
    return normalize4([
      a[0] + (b[0] - a[0]) * alpha,
      a[1] + (b[1] - a[1]) * alpha,
      a[2] + (b[2] - a[2]) * alpha,
      a[3] + (b[3] - a[3]) * alpha,
    ]);
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const s = Math.sin(theta);
  const wa = Math.sin((1 - alpha) * theta) / s;
  const wb = Math.sin(alpha * theta) / s;
  return normalize4([
    a[0] * wa + b[0] * wb,
    a[1] * wa + b[1] * wb,
    a[2] * wa + b[2] * wb,
    a[3] * wa + b[3] * wb,
  ]);
}