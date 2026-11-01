/**
 * The chunk index every store finds its chunks through: an open-addressing
 * hash table keyed by a chunk's (x, z) column and its y, both small
 * integers.
 *
 * A chunk key ({@link chunkKey}) reaches 2^35, past the small-integer range
 * a JavaScript engine hashes cheaply, so a `Map` keyed by it boxes and
 * hashes a double on every lookup. Here the key is split into a column part
 * (below 2^24) and a y part (below 2^10), held in two Int32Arrays and hashed
 * with integer multiplies: a lookup touches two typed arrays and one value
 * slot. One index type serves every candidate, so stores compare on their
 * chunk encoding, not on how they find a chunk.
 */
import type { ChunkGrid } from './coords';

/** Smallest table (slots); the table doubles when half full. */
const MIN_SLOTS = 64;

/** Marks an empty slot in the column-key array (column keys are ≥ 0). */
const EMPTY = -1;

export class ChunkIndex<T> {
  readonly grid: ChunkGrid;
  private colKeys: Int32Array;
  private yKeys: Int32Array;
  private values: Array<T | undefined>;
  private bits: number;
  private count = 0;

  constructor(grid: ChunkGrid) {
    this.grid = grid;
    this.bits = Math.log2(MIN_SLOTS);
    this.colKeys = new Int32Array(MIN_SLOTS).fill(EMPTY);
    this.yKeys = new Int32Array(MIN_SLOTS);
    this.values = new Array<T | undefined>(MIN_SLOTS).fill(undefined);
  }

  /** Chunks held. */
  get size(): number {
    return this.count;
  }

  /** Bytes of the table's own arrays (8 per slot for the keys, 8 per value slot). */
  bytes(): number {
    return this.colKeys.length * 16;
  }

  /**
   * The column part of a chunk's key, or −1 when the chunk is outside the
   * world. Callers on a per-cell path keep it with the y part to skip the
   * lookup when the next cell is in the same chunk.
   */
  colKey(cx: number, cz: number): number {
    const g = this.grid;
    const x = cx - g.chunkMinXZ;
    const z = cz - g.chunkMinXZ;
    if (x < 0 || x >= g.chunkSpanXZ || z < 0 || z >= g.chunkSpanXZ) return -1;
    return x * g.chunkSpanXZ + z;
  }

  /** The y part of a chunk's key, or −1 when outside the world. */
  yKey(cy: number): number {
    const y = cy - this.grid.chunkMinY;
    return y < 0 || y >= this.grid.chunkSpanY ? -1 : y;
  }

  private slot(col: number, y: number): number {
    return (Math.imul(col, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca77)) >>> (32 - this.bits);
  }

  /** The value under a split key (from {@link colKey} and {@link yKey}); undefined when absent. */
  getKey(col: number, y: number): T | undefined {
    if (col < 0 || y < 0) return undefined;
    const mask = (1 << this.bits) - 1;
    const cols = this.colKeys;
    for (let s = this.slot(col, y); ; s = (s + 1) & mask) {
      const c = cols[s]!;
      if (c === EMPTY) return undefined;
      if (c === col && this.yKeys[s] === y) return this.values[s];
    }
  }

  /** The chunk at (cx, cy, cz); undefined when absent or outside the world. */
  get(cx: number, cy: number, cz: number): T | undefined {
    return this.getKey(this.colKey(cx, cz), this.yKey(cy));
  }

  /** Stores a chunk (the caller checks the chunk is inside the world). */
  set(cx: number, cy: number, cz: number, value: T): void {
    const col = this.colKey(cx, cz);
    const y = this.yKey(cy);
    if (col < 0 || y < 0) throw new RangeError(`chunk (${cx}, ${cy}, ${cz}) is outside the world`);
    if ((this.count + 1) * 2 > this.colKeys.length) this.grow();
    const mask = (1 << this.bits) - 1;
    for (let s = this.slot(col, y); ; s = (s + 1) & mask) {
      const c = this.colKeys[s]!;
      if (c === EMPTY) {
        this.colKeys[s] = col;
        this.yKeys[s] = y;
        this.values[s] = value;
        this.count++;
        return;
      }
      if (c === col && this.yKeys[s] === y) {
        this.values[s] = value;
        return;
      }
    }
  }

  /** Removes a chunk; false when it was absent. */
  delete(cx: number, cy: number, cz: number): boolean {
    const col = this.colKey(cx, cz);
    const y = this.yKey(cy);
    if (col < 0 || y < 0) return false;
    const mask = (1 << this.bits) - 1;
    let s = this.slot(col, y);
    for (; ; s = (s + 1) & mask) {
      const c = this.colKeys[s]!;
      if (c === EMPTY) return false;
      if (c === col && this.yKeys[s] === y) break;
    }
    // Backward-shift deletion: later entries of the probe run move into the hole, so no tombstones build up.
    let hole = s;
    for (let t = (s + 1) & mask; ; t = (t + 1) & mask) {
      const c = this.colKeys[t]!;
      if (c === EMPTY) break;
      const home = this.slot(c, this.yKeys[t]!);
      // Move t into the hole unless its home lies cyclically in (hole, t].
      const inRange = hole <= t ? home > hole && home <= t : home > hole || home <= t;
      if (inRange) continue;
      this.colKeys[hole] = c;
      this.yKeys[hole] = this.yKeys[t]!;
      this.values[hole] = this.values[t];
      hole = t;
    }
    this.colKeys[hole] = EMPTY;
    this.values[hole] = undefined;
    this.count--;
    return true;
  }

  /** Every held chunk's {@link chunkKey} and value. */
  *entries(): IterableIterator<[number, T]> {
    const spanY = this.grid.chunkSpanY;
    for (let s = 0; s < this.colKeys.length; s++) {
      const c = this.colKeys[s]!;
      if (c !== EMPTY) yield [c * spanY + this.yKeys[s]!, this.values[s] as T];
    }
  }

  /** Every held chunk's {@link chunkKey}. */
  *keys(): IterableIterator<number> {
    for (const [k] of this.entries()) yield k;
  }

  /** Every held chunk's value. */
  *valuesIter(): IterableIterator<T> {
    for (let s = 0; s < this.colKeys.length; s++) if (this.colKeys[s] !== EMPTY) yield this.values[s] as T;
  }

  private grow(): void {
    const cols = this.colKeys;
    const ys = this.yKeys;
    const vals = this.values;
    this.bits++;
    const n = 1 << this.bits;
    this.colKeys = new Int32Array(n).fill(EMPTY);
    this.yKeys = new Int32Array(n);
    this.values = new Array<T | undefined>(n).fill(undefined);
    const mask = n - 1;
    for (let s = 0; s < cols.length; s++) {
      const c = cols[s]!;
      if (c === EMPTY) continue;
      let t = this.slot(c, ys[s]!);
      while (this.colKeys[t] !== EMPTY) t = (t + 1) & mask;
      this.colKeys[t] = c;
      this.yKeys[t] = ys[s]!;
      this.values[t] = vals[s];
    }
  }
}
