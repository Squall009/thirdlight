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
 *
 * Only what moved is composed: a local transform equal to the one the row
 * has marks nothing, and `update` composes the rows whose local transform
 * changed and their descendants — an idle scene composes none. The rows
 * composed by the last `update` are listed for the presenter
 * ({@link changedCount}, {@link changedId}), so it places only their drawables.
 */
import { composeMat4 } from './rig-pose';

const STRIDE = 16;
/** Floats of a local transform as it was given (position, rotation, scale). */
const TRS = 10;
/** Parent chains deeper than this are cut (a cycle cannot hang a frame). */
const MAX_DEPTH = 64;

export class WorldMatrices {
  private readonly rows = new Map<string, number>();
  private ids: (string | null)[] = [];
  private parents: (string | null)[] = [];
  private free: number[] = [];
  /** Each row's local transform as last given (compared, so an unchanged one marks nothing). */
  private trs = new Float64Array(0);
  /** Rows whose local transform (or parent) changed since the last `update`. */
  private dirty = new Uint8Array(0);
  private anyDirty = false;
  /** Rows were added, removed or re-parented: the parent rows are resolved again. */
  private structure = false;
  /** Per row in the running `update`: 1 composed this frame, 2 unchanged. */
  private state = new Uint8Array(0);
  /** The rows the last `update` composed. */
  private changed = new Int32Array(0);
  private changedN = 0;
  /** World matrices composed since the table was made. */
  private composedTotal = 0;
  /** The parent's row, resolved per frame (-1: a root, or its parent is not in the table). */
  private parentRow = new Int32Array(0);
  private local = new Float64Array(0);
  private worldM = new Float64Array(0);

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
      this.trs.fill(0, i * TRS, i * TRS + TRS);
      this.trs[i * TRS + 6] = 1;
      this.trs[i * TRS + 7] = 1;
      this.trs[i * TRS + 8] = 1;
      this.trs[i * TRS + 9] = 1;
      this.mark(i);
      this.structure = true;
    } else if (this.parents[i] !== parentId) {
      this.mark(i);
      this.structure = true;
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
    this.dirty[i] = 0;
    this.free.push(i);
    this.structure = true;
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

  /**
   * Set an entity's local transform (relative to its parent); false when it
   * is not in the table. The same values as the row has change nothing.
   */
  setLocal(id: string, p: ArrayLike<number>, r: ArrayLike<number>, s: ArrayLike<number>): boolean {
    const i = this.rows.get(id);
    if (i === undefined) return false;
    const t = this.trs;
    const o = i * TRS;
    if (
      t[o] === p[0] && t[o + 1] === p[1] && t[o + 2] === p[2] &&
      t[o + 3] === r[0] && t[o + 4] === r[1] && t[o + 5] === r[2] && t[o + 6] === r[3] &&
      t[o + 7] === s[0] && t[o + 8] === s[1] && t[o + 9] === s[2]
    ) return true;
    t[o] = p[0]!;
    t[o + 1] = p[1]!;
    t[o + 2] = p[2]!;
    t[o + 3] = r[0]!;
    t[o + 4] = r[1]!;
    t[o + 5] = r[2]!;
    t[o + 6] = r[3]!;
    t[o + 7] = s[0]!;
    t[o + 8] = s[1]!;
    t[o + 9] = s[2]!;
    composeMat4(this.local.subarray(i * STRIDE, i * STRIDE + STRIDE), p, r, s);
    this.mark(i);
    return true;
  }

  /**
   * Compose the world matrices of the rows that changed and their
   * descendants (parents first); nothing when nothing changed.
   */
  update(): void {
    this.changedN = 0;
    if (!this.anyDirty && !this.structure) return;
    const n = this.ids.length;
    if (this.structure) {
      this.structure = false;
      for (let i = 0; i < n; i += 1) {
        const parent = this.parents[i];
        const row = parent === null || parent === undefined ? -1 : (this.rows.get(parent) ?? -1);
        // A parent that came or went changes the row's world.
        if (row !== this.parentRow[i] && this.ids[i] !== null) this.dirty[i] = 1;
        this.parentRow[i] = row;
      }
    }
    this.anyDirty = false;
    this.state.fill(0, 0, n);
    for (let i = 0; i < n; i += 1) if (this.ids[i] !== null) this.resolve(i, 0);
    this.dirty.fill(0, 0, n);
  }

  /** How many rows the last `update` composed. */
  get changedCount(): number {
    return this.changedN;
  }

  /** The entity of the k-th row the last `update` composed. */
  changedId(k: number): string {
    return this.ids[this.changed[k]!]!;
  }

  /** World matrices composed since the table was made (diagnostics). */
  get composed(): number {
    return this.composedTotal;
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

  private mark(i: number): void {
    this.dirty[i] = 1;
    this.anyDirty = true;
  }

  /** Whether row i's world changes this update (composed then, its parent first). */
  private resolve(i: number, depth: number): boolean {
    const known = this.state[i]!;
    if (known !== 0) return known === 1;
    const p = this.parentRow[i]!;
    const root = p < 0 || depth >= MAX_DEPTH;
    const parentChanged = !root && this.resolve(p, depth + 1);
    if (this.dirty[i] === 0 && !parentChanged) {
      this.state[i] = 2;
      return false;
    }
    this.state[i] = 1;
    const o = i * STRIDE;
    if (root) for (let k = 0; k < STRIDE; k += 1) this.worldM[o + k] = this.local[o + k]!;
    else multiplyInto(this.worldM, o, this.worldM, p * STRIDE, this.local, o);
    this.changed[this.changedN] = i;
    this.changedN += 1;
    this.composedTotal += 1;
    return true;
  }

  private grow(rows: number): void {
    if (this.parentRow.length >= rows) return;
    const cap = Math.max(rows, this.parentRow.length * 2, 64);
    const pr = new Int32Array(cap);
    pr.set(this.parentRow);
    pr.fill(-1, this.parentRow.length);
    this.parentRow = pr;
    const ch = new Int32Array(cap);
    ch.set(this.changed);
    this.changed = ch;
    const di = new Uint8Array(cap);
    di.set(this.dirty);
    this.dirty = di;
    this.state = new Uint8Array(cap);
    const tr = new Float64Array(cap * TRS);
    tr.set(this.trs);
    this.trs = tr;
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
