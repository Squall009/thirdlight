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

/**
 * A growable word buffer with f32 views of the same words. Its words may
 * start at `base` (a section packed where it will lie in a larger buffer):
 * `alloc` and the setters take indices counted from the larger buffer's
 * start, and indices below `base` go to `header` (the larger buffer's
 * header slots, written by whoever places the section).
 */
export class Words {
  private u = new Uint32Array(1024);
  private f = new Float32Array(this.u.buffer);
  /** Words allocated (from `base`). */
  length = 0;
  constructor(readonly base = 0, private readonly header: Uint32Array | null = null) {}
  private grow(n: number): void {
    if (this.length + n <= this.u.length) return;
    let size = this.u.length;
    while (size < this.length + n) size *= 2;
    const u = new Uint32Array(size);
    u.set(this.u.subarray(0, this.length));
    this.u = u;
    this.f = new Float32Array(u.buffer);
  }
  /** The end of the allocated words (an index, as `alloc` returns). */
  get end(): number {
    return this.base + this.length;
  }
  alloc(n: number): number {
    this.grow(n);
    const at = this.base + this.length;
    this.length += n;
    return at;
  }
  setU(i: number, v: number): void {
    if (i < this.base) this.header![i] = v >>> 0;
    else this.u[i - this.base] = v >>> 0;
  }
  getU(i: number): number {
    return i < this.base ? this.header![i]! : this.u[i - this.base]!;
  }
  setF(i: number, v: number): void {
    this.f[i - this.base] = v;
  }
  orU(i: number, v: number): void {
    const k = i - this.base;
    this.u[k] = (this.u[k]! | v) >>> 0;
  }
  /** Allocated words [at, at + n) as u32 and f32 views (valid until the next `alloc`). */
  views(at: number, n: number): { u: Uint32Array; f: Float32Array } {
    const k = at - this.base;
    return { u: this.u.subarray(k, k + n), f: this.f.subarray(k, k + n) };
  }
  done(): Uint32Array {
    return this.u.slice(0, this.length);
  }
}

export function putAffine(w: Words, at: number, m: Affine): void {
  for (let k = 0; k < 12; k += 1) w.setF(at + k, m[k] ?? 0);
}

