/**
 * Quaternions as `[x, y, z, w]`, with three.js's formulas, so the
 * simulation, the editor and the renderer turn things the same way.
 */

/** A quaternion `[x, y, z, w]`. */
export type Quat = [number, number, number, number];

/**
 * `out := a · b` (apply `b`, then `a`); `out` may be `a` or `b`. The terms
 * are summed in three.js's order (`Quaternion.multiplyQuaternions`), so a
 * pose computed here matches the rendered one to the last bit.
 */
export function quatMultiply(a: ArrayLike<number>, b: ArrayLike<number>, out: Quat = [0, 0, 0, 1]): Quat {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, aw = a[3]!;
  const bx = b[0]!, by = b[1]!, bz = b[2]!, bw = b[3]!;
  out[0] = ax * bw + aw * bx + ay * bz - az * by;
  out[1] = ay * bw + aw * by + az * bx - ax * bz;
  out[2] = az * bw + aw * bz + ax * by - ay * bx;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

/**
 * The rotation of a pure rotation matrix (row-major arguments m11…m33) into
 * `out` (three.js `Quaternion.setFromRotationMatrix`).
 */
export function quatFromRotation(out: number[] | Float64Array, m11: number, m12: number, m13: number, m21: number, m22: number, m23: number, m31: number, m32: number, m33: number): void {
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    out[3] = 0.25 / s;
    out[0] = (m32 - m23) * s;
    out[1] = (m13 - m31) * s;
    out[2] = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m11 - m22 - m33);
    out[3] = (m32 - m23) / s;
    out[0] = 0.25 * s;
    out[1] = (m12 + m21) / s;
    out[2] = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2.0 * Math.sqrt(1.0 + m22 - m11 - m33);
    out[3] = (m13 - m31) / s;
    out[0] = (m12 + m21) / s;
    out[1] = 0.25 * s;
    out[2] = (m23 + m32) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + m33 - m11 - m22);
    out[3] = (m21 - m12) / s;
    out[0] = (m13 + m31) / s;
    out[1] = (m23 + m32) / s;
    out[2] = 0.25 * s;
  }
}
