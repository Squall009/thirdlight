/**
 * How a palette chunk maps each cell to its palette entry, in memory: bit
 * packing, vertical runs or sparse bricks (brick-layout.ts). All answer the
 * same three calls (read one cell, write one cell, unpack every cell), so a
 * palette chunk is measured with any of them without changing anything else.
 */
import { BrickLayout } from './brick-layout';
import type { ChunkGrid } from './coords';
import { MAX_PALETTE, packedWidth } from './packed-width';

/** Cells → palette entry ids. */
export interface CellLayout {
  readonly kind: LayoutKind;
  /** The most entry ids it can address (a palette that grows past it needs a wider layout). */
  readonly capacity: number;
  /** Entry id of cell `i` ({@link localIndex} order). */
  get(i: number): number;
  /** Sets cell `i` to entry `e` (< capacity). */
  set(i: number, e: number): void;
  /** Writes every cell's entry id into `ids`. */
  unpack(ids: Uint16Array): void;
  /** Bytes of its arrays. */
  bytes(): number;
}

export type LayoutKind = 'packed' | 'runs' | 'bricks';

/** A packed layout's words, as they cross to or from a worker (see chunk-wire.ts). */
export interface PackedWire {
  readonly kind: 'packed';
  readonly width: number;
  readonly words: Uint32Array;
}

/**
 * Entry ids bit-packed into 32-bit words, cell `i` at bit `i × width`
 * (little-endian word order, so the words' bytes are the packed bit
 * stream). Width 0 holds one word and reads 0 for every cell, so a chunk
 * whose palette has one entry needs no per-cell storage and no branch.
 */
export class PackedIndices implements CellLayout {
  readonly kind = 'packed';
  readonly width: number;
  readonly capacity: number;
  private words: Uint32Array;
  /** log2(cells per word); 31 for width 0, so every cell reads word 0. */
  private readonly perWordShift: number;
  private readonly perWordMask: number;
  private readonly valueMask: number;

  constructor(cells: number, width: number) {
    if (![0, 1, 2, 4, 8, 16].includes(width)) throw new RangeError(`packed width must be 0, 1, 2, 4, 8 or 16, got ${width}`);
    this.width = width;
    this.capacity = 2 ** width;
    if (width === 0) {
      this.words = new Uint32Array(1);
      this.perWordShift = 31;
      this.perWordMask = 0;
      this.valueMask = 0;
    } else {
      this.perWordShift = 5 - Math.log2(width);
      this.perWordMask = (1 << this.perWordShift) - 1;
      this.valueMask = (1 << width) - 1;
      this.words = new Uint32Array((cells * width) >>> 5);
    }
  }

  /** A layout of the narrowest width for `count` entries holding `ids`. */
  static from(ids: Uint16Array, count: number): PackedIndices {
    const p = new PackedIndices(ids.length, packedWidth(count));
    if (p.width === 0) return p;
    const w = p.width;
    const per = 32 / w;
    const words = p.words;
    for (let k = 0, i = 0; k < words.length; k++) {
      let word = 0;
      for (let j = 0; j < per; j++, i++) word |= ids[i]! << (j * w);
      words[k] = word >>> 0;
    }
    return p;
  }

  /** The words for a worker message (copied when `copy`, else handed over). */
  toWire(copy: boolean): PackedWire {
    return { kind: 'packed', width: this.width, words: copy ? this.words.slice() : this.words };
  }

  /** A layout over a wire's words (adopted); throws unless they fit `cells`. */
  static fromWire(cells: number, w: PackedWire): PackedIndices {
    const p = new PackedIndices(cells, w.width);
    if (w.words.length !== p.words.length) throw new RangeError('packed wire: words do not fit the chunk');
    p.words = w.words;
    return p;
  }

  get(i: number): number {
    return (this.words[i >>> this.perWordShift]! >>> ((i & this.perWordMask) * this.width)) & this.valueMask;
  }

  set(i: number, e: number): void {
    if (this.width === 0) return;
    const k = i >>> this.perWordShift;
    const shift = (i & this.perWordMask) * this.width;
    this.words[k] = ((this.words[k]! & ~(this.valueMask << shift)) | (e << shift)) >>> 0;
  }

  unpack(ids: Uint16Array): void {
    if (this.width === 0) {
      ids.fill(0);
      return;
    }
    const w = this.width;
    const per = 32 / w;
    const m = this.valueMask;
    const words = this.words;
    for (let k = 0, i = 0; k < words.length; k++) {
      const word = words[k]!;
      for (let j = 0; j < per; j++, i++) ids[i] = (word >>> (j * w)) & m;
    }
  }

  bytes(): number {
    return this.words.byteLength;
  }
}

/** Per chunk-edge scratch for rebuilding one column. */
const columnScratch = new Map<number, { ids: Uint16Array; starts: Uint8Array; ents: Uint16Array }>();

function scratchFor(edge: number): { ids: Uint16Array; starts: Uint8Array; ents: Uint16Array } {
  let s = columnScratch.get(edge);
  if (s === undefined) {
    s = { ids: new Uint16Array(edge), starts: new Uint8Array(edge), ents: new Uint16Array(edge) };
    columnScratch.set(edge, s);
  }
  return s;
}

/**
 * Vertical runs: every column (cells of one x, z; contiguous because y runs
 * fastest) is a list of runs, each its first y and its entry id. A plain
 * ground column is two or three runs. A read scans its column's runs from
 * the top; a write that changes a run count shifts the runs after it.
 */
export class ColumnRuns implements CellLayout {
  readonly kind = 'runs';
  readonly capacity = MAX_PALETTE;
  private readonly edge: number;
  private readonly shift: number;
  private readonly mask: number;
  /** Run offsets per column (columns + 1): column c's runs are [offs[c], offs[c + 1]). */
  private readonly offs: Uint16Array;
  private starts: Uint8Array;
  private ents: Uint16Array;

  private constructor(grid: ChunkGrid, offs: Uint16Array, starts: Uint8Array, ents: Uint16Array) {
    this.edge = grid.edge;
    this.shift = grid.shift;
    this.mask = grid.mask;
    this.offs = offs;
    this.starts = starts;
    this.ents = ents;
  }

  /** The runs of `ids` (one chunk's entry ids in {@link localIndex} order). */
  static from(grid: ChunkGrid, ids: Uint16Array): ColumnRuns {
    const e = grid.edge;
    const cols = e * e;
    const offs = new Uint16Array(cols + 1);
    let runs = 0;
    for (let c = 0, i = 0; c < cols; c++) {
      offs[c] = runs;
      runs++;
      for (let y = 1, prev = ids[i]!; y < e; y++) {
        const v = ids[i + y]!;
        if (v !== prev) runs++;
        prev = v;
      }
      i += e;
    }
    offs[cols] = runs;
    const starts = new Uint8Array(runs);
    const ents = new Uint16Array(runs);
    for (let c = 0, i = 0, r = 0; c < cols; c++, i += e) {
      let prev = -1;
      for (let y = 0; y < e; y++) {
        const v = ids[i + y]!;
        if (v === prev) continue;
        starts[r] = y;
        ents[r] = v;
        r++;
        prev = v;
      }
    }
    return new ColumnRuns(grid, offs, starts, ents);
  }

  /** Runs in the chunk. */
  get runCount(): number {
    return this.offs[this.offs.length - 1]!;
  }

  get(i: number): number {
    const c = i >>> this.shift;
    const y = i & this.mask;
    const lo = this.offs[c]!;
    let k = this.offs[c + 1]! - 1;
    while (k > lo && this.starts[k]! > y) k--;
    return this.ents[k]!;
  }

  set(i: number, e: number): void {
    if (this.get(i) === e) return;
    const c = i >>> this.shift;
    const edge = this.edge;
    const s = scratchFor(edge);
    const lo = this.offs[c]!;
    const hi = this.offs[c + 1]!;
    // Unpack the column, change the cell, re-run it.
    for (let k = lo; k < hi; k++) {
      const end = k + 1 < hi ? this.starts[k + 1]! : edge;
      s.ids.fill(this.ents[k]!, this.starts[k]!, end);
    }
    s.ids[i & this.mask] = e;
    let n = 0;
    for (let y = 0, prev = -1; y < edge; y++) {
      const v = s.ids[y]!;
      if (v === prev) continue;
      s.starts[n] = y;
      s.ents[n] = v;
      n++;
      prev = v;
    }
    const delta = n - (hi - lo);
    if (delta !== 0) {
      const total = this.runCount;
      if (total + delta > this.starts.length) {
        const cap = Math.max(total + delta, Math.ceil(this.starts.length * 1.5));
        const starts = new Uint8Array(cap);
        const ents = new Uint16Array(cap);
        starts.set(this.starts.subarray(0, total));
        ents.set(this.ents.subarray(0, total));
        this.starts = starts;
        this.ents = ents;
      }
      this.starts.copyWithin(hi + delta, hi, total);
      this.ents.copyWithin(hi + delta, hi, total);
      for (let k = c + 1; k < this.offs.length; k++) this.offs[k] = this.offs[k]! + delta;
    }
    this.starts.set(s.starts.subarray(0, n), lo);
    this.ents.set(s.ents.subarray(0, n), lo);
  }

  unpack(ids: Uint16Array): void {
    const e = this.edge;
    const cols = e * e;
    for (let c = 0; c < cols; c++) {
      const lo = this.offs[c]!;
      const hi = this.offs[c + 1]!;
      const base = c * e;
      for (let k = lo; k < hi; k++) ids.fill(this.ents[k]!, base + this.starts[k]!, base + (k + 1 < hi ? this.starts[k + 1]! : e));
    }
  }

  bytes(): number {
    return this.offs.byteLength + this.starts.byteLength + this.ents.byteLength;
  }
}

/** A layout of `kind` holding `ids` for a palette of `count` entries. */
export function buildLayout(kind: LayoutKind, grid: ChunkGrid, ids: Uint16Array, count: number): CellLayout {
  if (kind === 'packed') return PackedIndices.from(ids, count);
  return kind === 'runs' ? ColumnRuns.from(grid, ids) : BrickLayout.from(grid, ids, count);
}
