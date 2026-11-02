/**
 * One palette and the cells that point into it: the unit both palette
 * chunk kinds are built from. A palette entry is a 32-bit value (a record
 * palette holds whole voxel values, record.ts; a per-plane palette one
 * field per value).
 *
 * Entries are reference-counted, so an edit that empties an entry frees it
 * for the next new value, and the palette shrinks (and the layout narrows)
 * once few entries are left, with hysteresis so an edit that toggles one
 * value does not repack the chunk each time.
 */
import { BrickLayout, type BrickWire } from './brick-layout';
import { buildLayout, PackedIndices, type CellLayout, type LayoutKind, type PackedWire } from './cell-layout';
import { MAX_PALETTE, packedWidth } from './packed-width';
import type { ChunkGrid } from './coords';

/** A plane's arrays, as they cross to or from a worker (see chunk-wire.ts). */
export interface PlaneWire {
  readonly values: Uint32Array;
  /** Per entry: its cell count. */
  readonly meta: Uint32Array;
  readonly size: number;
  readonly live: number;
  readonly layout: BrickWire | PackedWire;
}


/** A palette with its cells' entry ids, as plain arrays (built by import and decode; read by encode). */
export interface PlaneImage {
  /** Entries used (the arrays may be longer). */
  count: number;
  values: Uint32Array;
  /** Cells per entry. */
  counts: Uint32Array;
  /** Entry id per cell ({@link localIndex} order). */
  ids: Uint16Array;
}

/** A plane image with room for every cell of `grid` to have its own entry. */
export function createPlaneImage(grid: ChunkGrid): PlaneImage {
  const n = grid.cellsPerChunk;
  return { count: 0, values: new Uint32Array(n), counts: new Uint32Array(n), ids: new Uint16Array(n) };
}

/** Per chunk-edge scratch ids for compaction (single-threaded use only). */
const idScratch = new Map<number, Uint16Array>();

function scratchIds(n: number): Uint16Array {
  let s = idScratch.get(n);
  if (s === undefined) {
    s = new Uint16Array(n);
    idScratch.set(n, s);
  }
  return s;
}

export class PalettePlane {
  values: Uint32Array;
  meta: Uint32Array;
  /** Entries in use or freed (the next new entry's slot when none is free). */
  size: number;
  /** Entries with at least one cell. */
  live: number;
  layout: CellLayout;
  private readonly grid: ChunkGrid;

  private constructor(grid: ChunkGrid, values: Uint32Array, meta: Uint32Array, size: number, live: number, layout: CellLayout) {
    this.grid = grid;
    this.values = values;
    this.meta = meta;
    this.size = size;
    this.live = live;
    this.layout = layout;
  }

  /** A plane holding an image's palette and cells. */
  static fromImage(grid: ChunkGrid, kind: LayoutKind, img: PlaneImage): PalettePlane {
    const n = img.count;
    const values = img.values.slice(0, n);
    const meta = new Uint32Array(n);
    let live = 0;
    for (let e = 0; e < n; e++) {
      meta[e] = img.counts[e]!;
      if (img.counts[e]! > 0) live++;
    }
    return new PalettePlane(grid, values, meta, n, live, buildLayout(kind, grid, img.ids, n));
  }

  /**
   * The plane's arrays for a worker message (copied when `copy`, else handed
   * over). Bricks and packed layouts only: run layouts are a measured
   * candidate that the streaming path does not carry.
   */
  toWire(copy: boolean): PlaneWire {
    const l = this.layout;
    if (!(l instanceof BrickLayout) && !(l instanceof PackedIndices)) throw new RangeError(`a ${l.kind} layout has no wire form`);
    return {
      values: copy ? this.values.slice(0, this.size) : this.values,
      meta: copy ? this.meta.slice(0, this.size) : this.meta,
      size: this.size,
      live: this.live,
      layout: l.toWire(copy),
    };
  }

  /** A plane over a wire's arrays (adopted); throws unless they are consistent with `grid`. */
  static fromWire(grid: ChunkGrid, w: PlaneWire): PalettePlane {
    if (!Number.isInteger(w.size) || w.size < 1 || w.size > MAX_PALETTE || w.values.length < w.size || w.meta.length < w.size) throw new RangeError('plane wire: palette arrays shorter than its size');
    let cells = 0;
    let live = 0;
    for (let e = 0; e < w.size; e++) {
      const n = w.meta[e]!;
      cells += n;
      if (n > 0) live++;
    }
    if (cells !== grid.cellsPerChunk || live !== w.live) throw new RangeError('plane wire: entry counts do not add up to the chunk');
    const layout = w.layout.kind === 'bricks' ? BrickLayout.fromWire(grid, w.layout, w.size) : PackedIndices.fromWire(grid.cellsPerChunk, w.layout);
    if (layout.capacity < w.size) throw new RangeError('plane wire: layout narrower than the palette');
    return new PalettePlane(grid, w.values, w.meta, w.size, w.live, layout);
  }

  /** A plane whose every cell holds one value. */
  static single(grid: ChunkGrid, kind: LayoutKind, value: number): PalettePlane {
    const ids = scratchIds(grid.cellsPerChunk);
    ids.fill(0);
    const meta = new Uint32Array([grid.cellsPerChunk]);
    return new PalettePlane(grid, new Uint32Array([value]), meta, 1, 1, buildLayout(kind, grid, ids, 1));
  }

  value(e: number): number {
    return this.values[e]!;
  }

  /** Cells pointing at entry `e`. */
  cellCount(e: number): number {
    return this.meta[e]!;
  }

  /** The live entry holding `value`, or −1. */
  find(value: number): number {
    const { values, meta } = this;
    // Palettes are small (a few entries in nearly every chunk), so a scan beats hashing.
    for (let e = 0; e < this.size; e++) if (values[e] === value && meta[e] !== 0) return e;
    return -1;
  }

  /** Points cell `i` at `value`; false when it already held it. */
  set(i: number, value: number): boolean {
    const old = this.layout.get(i);
    if (this.values[old] === value) return false;
    let e = this.find(value);
    if (e < 0) e = this.add(value);
    // add may have rebuilt the layout; the cell's old entry id is unchanged by that.
    this.layout.set(i, e);
    this.meta[e]!++;
    this.meta[old]!--;
    if (this.meta[old] === 0) {
      this.live--;
      this.maybeShrink();
    }
    return true;
  }

  /** A new entry (count 0): a freed slot, else the next one, widening the layout when it is full. */
  private add(value: number): number {
    let e = -1;
    if (this.live < this.size) {
      for (let k = 0; k < this.size; k++) {
        if (this.meta[k] === 0) {
          e = k;
          break;
        }
      }
    }
    if (e < 0) {
      if (this.size >= MAX_PALETTE) throw new RangeError('palette past 16-bit entry ids');
      e = this.size++;
      if (e >= this.values.length) {
        const cap = Math.min(MAX_PALETTE, Math.max(4, this.values.length * 2));
        const values = new Uint32Array(cap);
        const meta = new Uint32Array(cap);
        values.set(this.values);
        meta.set(this.meta);
        this.values = values;
        this.meta = meta;
      }
      if (this.size > this.layout.capacity) this.relayout(this.size);
    }
    this.values[e] = value;
    this.meta[e] = 0;
    this.live++;
    return e;
  }

  /** The same cells in a layout sized for `count` entries. */
  private relayout(count: number): void {
    const ids = scratchIds(this.grid.cellsPerChunk);
    this.layout.unpack(ids);
    this.layout = buildLayout(this.layout.kind, this.grid, ids, count);
  }

  /**
   * Drops freed entries and narrows the layout when the live entries fit in
   * half its width and fill at most a quarter of it, or when one is left.
   * Run layouts are never wider than they need, so they only compact at one.
   */
  private maybeShrink(): void {
    const width = this.layout.kind !== 'runs' ? packedWidth(this.layout.capacity) : -1;
    const fits = width >= 0 && packedWidth(this.live) <= width / 2 && this.live * 4 <= this.layout.capacity;
    if (this.live === 1 || fits) this.compact();
  }

  /** Renumbers the live entries 0 … live − 1 (in their old order) and rebuilds the layout. */
  compact(): void {
    if (this.live === this.size) return;
    const remap = new Uint16Array(this.size);
    const values = new Uint32Array(Math.max(1, this.live));
    const meta = new Uint32Array(Math.max(1, this.live));
    let n = 0;
    for (let e = 0; e < this.size; e++) {
      if (this.meta[e] === 0) continue;
      remap[e] = n;
      values[n] = this.values[e]!;
      meta[n] = this.meta[e]!;
      n++;
    }
    const ids = scratchIds(this.grid.cellsPerChunk);
    this.layout.unpack(ids);
    for (let i = 0; i < ids.length; i++) ids[i] = remap[ids[i]!]!;
    this.values = values;
    this.meta = meta;
    this.size = n;
    this.layout = buildLayout(this.layout.kind, this.grid, ids, n);
  }

  /** Writes the plane into an image (entries as they are, freed ones with count 0). */
  toImage(img: PlaneImage): void {
    img.count = this.size;
    for (let e = 0; e < this.size; e++) {
      img.values[e] = this.values[e]!;
      img.counts[e] = this.meta[e]!;
    }
    this.layout.unpack(img.ids);
  }

  /** Bytes of its arrays. */
  bytes(): number {
    return this.values.byteLength + this.meta.byteLength + this.layout.bytes();
  }
}
