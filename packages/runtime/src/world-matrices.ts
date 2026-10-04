/**
 * Every realized entity's world matrix in flat arrays, for whoever presents
 * the world (the page's renderer): one row per entity, its parent, its
 * local transform as the frame interpolated it, and its world matrix
 * composed up its parents. No three.js — the renderer reads the matrices,
 * it does not keep a scene graph of entities to compose them.
 *
 * Rows are reused after removal, so an index is only stable while its
 * entity is in the table. Matrices are column-major (three.js
 * `Matrix4.elements` order), 16 floats per row.
 */
import { composeMat4 } from './rig-pose';

const STRIDE = 16;
/** Parent chains deeper than this are cut (a cycle cannot hang a frame). */
const MAX_DEPTH = 64;

export class WorldMatrices {
  private readonly rows = new Map<string, number>();
  private ids: (string | null)[] = [];
  private parents: (string | null)[] = [];
  private free: number[] = [];
  /** The parent's row, resolved per frame (-1: a root, or its parent is not in the table). */
  private parentRow = new Int32Array(0);
  private local = new Float64Array(0);
  private worldM = new Float64Array(0);
  /** The frame each row's world was last composed in (parents-first without sorting). */
  private stamp = new Uint32Array(0);
  private frame = 0;

  /** The world matrices, 16 per row (read with {@link indexOf}). */
  get world(): Float64Array {
    return this.worldM;
  }

  /** Add (or re-parent) an entity; its local transform starts at identity. */
  add(id: string, parentId: string | null): number {
    let i = this.rows.get(id);
    if (i === undefined) {
      i = this.free.pop() ?? this.ids.length;
      if (i === this.ids.length) {
        this.ids.push(null);
        this.parents.push(null);
        this.grow(i + 1);
      }
      this.rows.set(id, i);
      this.ids[i] = id;
      identity(this.local, i * STRIDE);
      identity(this.worldM, i * STRIDE);
    }
    this.parents[i] = parentId;
    return i;
  }

  remove(id: string): void {
    const i = this.rows.get(id);
    if (i === undefined) return;
    this.rows.delete(id);
    this.ids[i] = null;
    this.parents[i] = null;
    this.free.push(i);
  }

  has(id: string): boolean {
    return this.rows.has(id);
  }

  indexOf(id: string): number | undefined {
    return this.rows.get(id);
  }

  parentOf(id: string): string | null | undefined {
    const i = this.rows.get(id);
    return i === undefined ? undefined : this.parents[i];
  }

  /** Set an entity's local transform (relative to its parent); false when it is not in the table. */
  setLocal(id: string, p: ArrayLike<number>, r: ArrayLike<number>, s: ArrayLike<number>): boolean {
    const i = this.rows.get(id);
    if (i === undefined) return false;
    composeMat4(this.local.subarray(i * STRIDE, i * STRIDE + STRIDE), p, r, s);
    return true;
  }

  /** Compose every row's world matrix from the local transforms (parents first). */
  update(): void {
    this.frame = (this.frame + 1) >>> 0 || 1;
    const n = this.ids.length;
    for (let i = 0; i < n; i += 1) {
      const parent = this.parents[i];
      this.parentRow[i] = parent === null || parent === undefined ? -1 : (this.rows.get(parent) ?? -1);
    }
    for (let i = 0; i < n; i += 1) if (this.ids[i] !== null) this.compose(i, 0);
  }

  /** Copy a row's world position into `out` (false: not in the table). */
  position(id: string, out: number[]): boolean {
    const i = this.rows.get(id);
    if (i === undefined) return false;
    const o = i * STRIDE;
    out[0] = this.worldM[o + 12]!;
    out[1] = this.worldM[o + 13]!;
    out[2] = this.worldM[o + 14]!;
    return true;
  }

  private compose(i: number, depth: number): void {
    if (this.stamp[i] === this.frame) return;
    this.stamp[i] = this.frame;
    const o = i * STRIDE;
    const p = this.parentRow[i]!;
    if (p < 0 || depth >= MAX_DEPTH) {
      for (let k = 0; k < STRIDE; k += 1) this.worldM[o + k] = this.local[o + k]!;
      return;
    }
    this.compose(p, depth + 1);
    multiplyInto(this.worldM, o, this.worldM, p * STRIDE, this.local, o);
  }

  private grow(rows: number): void {
    if (this.parentRow.length >= rows) return;
    const cap = Math.max(rows, this.parentRow.length * 2, 64);
    const pr = new Int32Array(cap);
    pr.set(this.parentRow);
    this.parentRow = pr;
    const st = new Uint32Array(cap);
    st.set(this.stamp);
    this.stamp = st;
    const lo = new Float64Array(cap * STRIDE);
    lo.set(this.local);
    this.local = lo;
    const wo = new Float64Array(cap * STRIDE);
    wo.set(this.worldM);
    this.worldM = wo;
  }
}

function identity(m: Float64Array, o: number): void {
  for (let k = 0; k < STRIDE; k += 1) m[o + k] = k % 5 === 0 ? 1 : 0;
}

/** out[o..] := a[ao..] · b[bo..] (column-major; out may not alias b's row). */
function multiplyInto(out: Float64Array, o: number, a: Float64Array, ao: number, b: Float64Array, bo: number): void {
  const a0 = a[ao]!, a1 = a[ao + 1]!, a2 = a[ao + 2]!, a3 = a[ao + 3]!;
  const a4 = a[ao + 4]!, a5 = a[ao + 5]!, a6 = a[ao + 6]!, a7 = a[ao + 7]!;
  const a8 = a[ao + 8]!, a9 = a[ao + 9]!, a10 = a[ao + 10]!, a11 = a[ao + 11]!;
  const a12 = a[ao + 12]!, a13 = a[ao + 13]!, a14 = a[ao + 14]!, a15 = a[ao + 15]!;
  for (let c = 0; c < 4; c += 1) {
    const b0 = b[bo + c * 4]!, b1 = b[bo + c * 4 + 1]!, b2 = b[bo + c * 4 + 2]!, b3 = b[bo + c * 4 + 3]!;
    out[o + c * 4] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    out[o + c * 4 + 1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    out[o + c * 4 + 2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    out[o + c * 4 + 3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
  }
}
