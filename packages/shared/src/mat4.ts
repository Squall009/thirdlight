/**
 * Column-major 4×4 matrices (the three.js convention) with three.js's
 * formulas, in plain doubles: the simulation poses nodes and places sockets
 * with them the way the renderer does, with no three.js in a worker.
 */

import { quatFromRotation } from './quat';

/** A column-major 4×4 matrix. */
export type Mat4 = Float64Array;
/** Anything a matrix is written into: a typed array or a plain array of 16. */
export type Mat4Out = Float64Array | number[];

/** A new identity matrix. */
export function mat4(): Mat4 {
  const m = new Float64Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/** out := compose(t, r, s) (three.js `Matrix4.compose`). */
export function composeMat4<T extends Mat4Out>(out: T, t: ArrayLike<number>, r: ArrayLike<number>, s: ArrayLike<number>): T {
  const x = r[0]!, y = r[1]!, z = r[2]!, w = r[3]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const sx = s[0]!, sy = s[1]!, sz = s[2]!;
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = t[0]!;
  out[13] = t[1]!;
  out[14] = t[2]!;
  out[15] = 1;
  return out;
}

/** out := a · b (out may alias neither). */
export function mulMat4<T extends Mat4Out>(out: T, a: ArrayLike<number>, b: ArrayLike<number>): T {
  for (let c = 0; c < 4; c += 1) {
    const b0 = b[c * 4]!, b1 = b[c * 4 + 1]!, b2 = b[c * 4 + 2]!, b3 = b[c * 4 + 3]!;
    out[c * 4] = a[0]! * b0 + a[4]! * b1 + a[8]! * b2 + a[12]! * b3;
    out[c * 4 + 1] = a[1]! * b0 + a[5]! * b1 + a[9]! * b2 + a[13]! * b3;
    out[c * 4 + 2] = a[2]! * b0 + a[6]! * b1 + a[10]! * b2 + a[14]! * b3;
    out[c * 4 + 3] = a[3]! * b0 + a[7]! * b1 + a[11]! * b2 + a[15]! * b3;
  }
  return out;
}

/** out := m⁻¹ (three.js `Matrix4.invert`; a singular matrix gives zeros). */
export function invertMat4<T extends Mat4Out>(out: T, m: ArrayLike<number>): T {
  const n11 = m[0]!, n21 = m[1]!, n31 = m[2]!, n41 = m[3]!;
  const n12 = m[4]!, n22 = m[5]!, n32 = m[6]!, n42 = m[7]!;
  const n13 = m[8]!, n23 = m[9]!, n33 = m[10]!, n43 = m[11]!;
  const n14 = m[12]!, n24 = m[13]!, n34 = m[14]!, n44 = m[15]!;
  const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
  const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
  const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
  const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;
  const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
  if (det === 0) {
    out.fill(0);
    return out;
  }
  const d = 1 / det;
  out[0] = t11 * d;
  out[1] = (n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44) * d;
  out[2] = (n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44) * d;
  out[3] = (n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43) * d;
  out[4] = t12 * d;
  out[5] = (n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44) * d;
  out[6] = (n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44) * d;
  out[7] = (n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43) * d;
  out[8] = t13 * d;
  out[9] = (n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44) * d;
  out[10] = (n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44) * d;
  out[11] = (n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43) * d;
  out[12] = t14 * d;
  out[13] = (n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34) * d;
  out[14] = (n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34) * d;
  out[15] = (n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33) * d;
  return out;
}

/** Decompose a matrix into translation, rotation and scale (three.js `Matrix4.decompose`). */
export function decomposeMat4(m: ArrayLike<number>, t: Mat4Out, r: Mat4Out, s: Mat4Out): void {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const det = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  if (det < 0) sx = -sx;
  t[0] = m[12]!;
  t[1] = m[13]!;
  t[2] = m[14]!;
  const ix = sx === 0 ? 0 : 1 / sx, iy = sy === 0 ? 0 : 1 / sy, iz = sz === 0 ? 0 : 1 / sz;
  quatFromRotation(r, m[0]! * ix, m[4]! * iy, m[8]! * iz, m[1]! * ix, m[5]! * iy, m[9]! * iz, m[2]! * ix, m[6]! * iy, m[10]! * iz);
  s[0] = sx;
  s[1] = sy;
  s[2] = sz;
}
