/**
 * The tracer's packing helpers: a growable word buffer (u32 and f32 views of
 * the same words) and the world → local affine maps every placement is
 * stored as. Pure.
 */

/** A world → local affine map, row-major 3 × 4 (x' = m0 x + m1 y + m2 z + m3, …). */
export type Affine = readonly number[];

/** The identity map. */
export const IDENTITY_AFFINE: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** The inverse of an affine map (the local → world of a world → local, and back). */
export function invertAffine(m: Affine): number[] {
  const [a, b, c, tx, d, e, f, ty, g, h, i, tz] = m as [number, number, number, number, number, number, number, number, number, number, number, number];
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-30) throw new Error('tracer: a placement does not invert (zero scale)');
  const r = 1 / det;
  const inv = [A * r, (c * h - b * i) * r, (b * f - c * e) * r, 0, B * r, (a * i - c * g) * r, (c * d - a * f) * r, 0, C * r, (b * g - a * h) * r, (a * e - b * d) * r, 0];
  inv[3] = -(inv[0]! * tx + inv[1]! * ty + inv[2]! * tz);
  inv[7] = -(inv[4]! * tx + inv[5]! * ty + inv[6]! * tz);
  inv[11] = -(inv[8]! * tx + inv[9]! * ty + inv[10]! * tz);
  return inv;
}

/** The world → local map of a placement given local → world as position, rotation (quaternion xyzw) and scale. */
export function worldToLocalOf(position: readonly number[], rotation: readonly number[], scale: readonly number[]): number[] {
  const [x, y, z, w] = [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1];
  const [sx, sy, sz] = [scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1];
  // Local → world: columns are the rotated, scaled axes.
  const m = [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y - z * w) * sy, 2 * (x * z + y * w) * sz, position[0] ?? 0,
    2 * (x * y + z * w) * sx, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z - x * w) * sz, position[1] ?? 0,
    2 * (x * z - y * w) * sx, 2 * (y * z + x * w) * sy, (1 - 2 * (x * x + y * y)) * sz, position[2] ?? 0,
  ];
  return invertAffine(m);
}

/** A growable word buffer with f32 views of the same words. */
export class Words {
  private u = new Uint32Array(1024);
  private f = new Float32Array(this.u.buffer);
  length = 0;
  private grow(n: number): void {
    if (this.length + n <= this.u.length) return;
    let size = this.u.length;
    while (size < this.length + n) size *= 2;
    const u = new Uint32Array(size);
    u.set(this.u.subarray(0, this.length));
    this.u = u;
    this.f = new Float32Array(u.buffer);
  }
  alloc(n: number): number {
    this.grow(n);
    const at = this.length;
    this.length += n;
    return at;
  }
  setU(i: number, v: number): void {
    this.u[i] = v >>> 0;
  }
  getU(i: number): number {
    return this.u[i]!;
  }
  setF(i: number, v: number): void {
    this.f[i] = v;
  }
  orU(i: number, v: number): void {
    this.u[i] = (this.u[i]! | v) >>> 0;
  }
  done(): Uint32Array {
    return this.u.slice(0, this.length);
  }
}

export function putAffine(w: Words, at: number, m: Affine): void {
  for (let k = 0; k < 12; k += 1) w.setF(at + k, m[k] ?? 0);
}

