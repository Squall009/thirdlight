/**
 * Arithmetic for generated architecture that gives the same bits in every
 * browser. `Math.sin`, `cos`, `atan2`, `hypot`, `pow`, … are only
 * approximately specified and differ between engines, so the generator
 * never calls them: its trig is the polynomials below, built from + − × ÷
 * and `Math.sqrt`, which IEEE 754 fixes to the bit (and JavaScript never
 * fuses into FMA). The same parameters then make the same bytes on the
 * page, in a worker and in another browser, so saves, replays and
 * cache keys hold.
 *
 * Pure.
 */

const TWO_PI_HI = 6.283185307179586;
const TWO_PI_LO = 2.4492935982947064e-16;
const HALF_PI = 1.5707963267948966;
const HALF_PI_LO = 6.123233995736766e-17;

/** sin and cos of a small angle (|x| ≤ π/4) by their Taylor series (error under 1e-16 there). */
function kernel(x: number, out: [number, number]): void {
  const x2 = x * x;
  out[0] = x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800 + x2 * (-1 / 1307674368000))))))));
  out[1] = 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200 + x2 * (1 / 20922789888000))))))));
}

const scratch: [number, number] = [0, 0];

/** [sin, cos] of `radians` (bit-identical everywhere). */
export function detSinCos(radians: number, out: [number, number] = [0, 0]): [number, number] {
  const k = Math.round(radians / TWO_PI_HI);
  let r = radians - k * TWO_PI_HI - k * TWO_PI_LO;
  const q = Math.round(r / HALF_PI);
  r = r - q * HALF_PI - q * HALF_PI_LO;
  kernel(r, scratch);
  const s = scratch[0];
  const c = scratch[1];
  switch (((q % 4) + 4) % 4) {
    case 0:
      out[0] = s;
      out[1] = c;
      break;
    case 1:
      out[0] = c;
      out[1] = -s;
      break;
    case 2:
      out[0] = -s;
      out[1] = -c;
      break;
    default:
      out[0] = -c;
      out[1] = s;
  }
  return out;
}

/** Degrees to radians. */
export const DEG = Math.PI / 180;

/** Length of a 3-vector without `Math.hypot` (whose rounding differs between engines). */
export function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}
export function len2(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/**
 * A rotation quaternion [x, y, z, w] from an orthonormal basis given as the
 * images of the local axes (columns of the matrix), by Shepperd's method.
 */
export function quatFromBasis(ax: readonly number[], ay: readonly number[], az: readonly number[], out: number[] = [0, 0, 0, 1]): number[] {
  const m00 = ax[0]!;
  const m10 = ax[1]!;
  const m20 = ax[2]!;
  const m01 = ay[0]!;
  const m11 = ay[1]!;
  const m21 = ay[2]!;
  const m02 = az[0]!;
  const m12 = az[1]!;
  const m22 = az[2]!;
  const tr = m00 + m11 + m22;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    out[3] = s / 4;
    out[0] = (m21 - m12) / s;
    out[1] = (m02 - m20) / s;
    out[2] = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out[3] = (m21 - m12) / s;
    out[0] = s / 4;
    out[1] = (m01 + m10) / s;
    out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out[3] = (m02 - m20) / s;
    out[0] = (m01 + m10) / s;
    out[1] = s / 4;
    out[2] = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out[3] = (m10 - m01) / s;
    out[0] = (m02 + m20) / s;
    out[1] = (m12 + m21) / s;
    out[2] = s / 4;
  }
  return out;
}

/** The quaternion turning +X toward the horizontal direction (cos, sin) = (dx, -dz) about +Y, i.e. a yaw whose +X lies along (dx, 0, dz) (unit). */
export function yawQuat(dx: number, dz: number, out: number[] = [0, 0, 0, 1]): number[] {
  return quatFromBasis([dx, 0, dz], [0, 1, 0], [-dz, 0, dx], out);
}

/** A 32-bit FNV-1a hash of a string (seeds per element and copy). */
export function hashString(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * A fast 64-bit hash of a string as 16 hex digits (two 32-bit multiply-xor
 * lanes, cyrb53's mixing): what keys each element's parameters, a hundred
 * times cheaper than SHA-256 on the page; the chunk key over them is SHA-256.
 */
export function hashText64(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** mulberry32: a small seeded generator in [0, 1) (integer arithmetic only). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
