/**
 * Changed cells of one chunk, and whole-chunk images: the two ways an undo
 * record and a save hold a chunk.
 *
 * A delta lists cells (local index, ascending) with one voxel each: the
 * value before an edit in an undo record, the value now in a save. It costs
 * 7 bytes a cell, so a dab of a few cells costs tens of bytes where a chunk
 * image costs one to a few KB; past a few hundred cells the image (the
 * chunk's canonical palette codec bytes; in a save, with a mask of the
 * changed cells) is smaller, and writers keep whichever is smaller. At rest
 * the fields are written as planes (all
 * cells, then all values, then all shapes), which a compressor packs better
 * than interleaved records.
 */
import type { ChunkGrid } from './coords';
import { clearDenseChunk, createDenseChunk, isAirChunk, type DenseChunk } from './dense-chunk';
import { createChunkImage, imageToCells, recordImageFromCells, recordValue, valueCategory, valueMaterial, valueOrientation, type ChunkImage } from './palette-image';
import { checkRecordValue, decodePaletteImage, encodePaletteImage } from './palette-codec';
import { ALL_PLANES, type VoxelRecord } from './record';
import type { VoxelStoreCandidate } from './store';

/** Bytes one delta cell costs: u16 cell, u32 record value, u8 shape. */
export const DELTA_CELL_BYTES = 7;

/** Changed cells of one chunk, ascending by local index. */
export class CellDelta {
  cells: Uint16Array;
  values: Uint32Array;
  shapes: Uint8Array;
  count = 0;

  constructor(capacity = 16) {
    this.cells = new Uint16Array(capacity);
    this.values = new Uint32Array(capacity);
    this.shapes = new Uint8Array(capacity);
  }

  /** Appends a cell (callers append in ascending order; {@link CellDelta.decode} checks it). */
  push(cell: number, value: number, shape: number): void {
    if (this.count === this.cells.length) {
      const n = this.count * 2;
      const c = new Uint16Array(n);
      const v = new Uint32Array(n);
      const s = new Uint8Array(n);
      c.set(this.cells);
      v.set(this.values);
      s.set(this.shapes);
      this.cells = c;
      this.values = v;
      this.shapes = s;
    }
    this.cells[this.count] = cell;
    this.values[this.count] = value;
    this.shapes[this.count] = shape;
    this.count++;
  }

  /** Bytes it takes at rest (and, as counted for budgets, in memory once trimmed). */
  get byteLength(): number {
    return this.count * DELTA_CELL_BYTES;
  }

  /** Writes every cell into a chunk of `store` (fields already valid). */
  applyToStore(store: VoxelStoreCandidate, cx: number, cy: number, cz: number): void {
    const g = store.grid;
    const ox = cx << g.shift;
    const oy = cy << g.shift;
    const oz = cz << g.shift;
    const v: VoxelRecord = { material: 0, category: 0, shape: 0, orientation: 0 };
    for (let k = 0; k < this.count; k++) {
      const i = this.cells[k]!;
      const val = this.values[k]!;
      v.material = valueMaterial(val);
      v.category = valueCategory(val);
      v.orientation = valueOrientation(val);
      v.shape = this.shapes[k]!;
      store.setVoxel(ox + (i >>> (g.shift << 1)), oy + (i & g.mask), oz + ((i >>> g.shift) & g.mask), v);
    }
  }

  /** Writes every cell into a dense chunk. */
  applyToDense(chunk: DenseChunk): void {
    for (let k = 0; k < this.count; k++) {
      const i = this.cells[k]!;
      const val = this.values[k]!;
      const m = valueMaterial(val);
      chunk.material[i] = m;
      chunk.category[i] = m === 0 ? 0 : valueCategory(val);
      chunk.orientation[i] = m === 0 ? 0 : valueOrientation(val);
      chunk.shape[i] = m === 0 ? 0 : this.shapes[k]!;
    }
  }

  /** The bytes at rest: cells, then values, then shapes, little-endian. */
  encode(): Uint8Array {
    const n = this.count;
    const out = new Uint8Array(n * DELTA_CELL_BYTES);
    const view = new DataView(out.buffer);
    for (let k = 0; k < n; k++) {
      view.setUint16(k * 2, this.cells[k]!, true);
      view.setUint32(n * 2 + k * 4, this.values[k]!, true);
      out[n * 6 + k] = this.shapes[k]!;
    }
    return out;
  }

  /**
   * Reads {@link CellDelta.encode}'s bytes (record values of form 1, see
   * record.ts); throws unless every cell lies in `grid`'s chunk, ascending,
   * once, every value is one the format holds, and air has shape 0.
   */
  static decode(grid: ChunkGrid, bytes: Uint8Array): CellDelta {
    if (bytes.length === 0 || bytes.length % DELTA_CELL_BYTES !== 0) throw new RangeError(`a cell delta of ${bytes.length} bytes`);
    const n = bytes.length / DELTA_CELL_BYTES;
    const d = new CellDelta(n);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let prev = -1;
    for (let k = 0; k < n; k++) {
      const cell = view.getUint16(k * 2, true);
      if (cell <= prev || cell >= grid.cellsPerChunk) throw new RangeError(`cell delta: cell ${cell} out of order or outside the chunk`);
      prev = cell;
      const value = view.getUint32(n * 2 + k * 4, true);
      const shape = bytes[n * 6 + k]!;
      checkRecordValue(value, false, 'cell delta');
      if (value === 0 && shape !== 0) throw new RangeError(`cell delta: cell ${cell} is air with shape ${shape}`);
      d.push(cell, value, shape);
    }
    return d;
  }
}

/** The record value and shape of a voxel, as a delta holds them. */
export function deltaValue(v: Readonly<VoxelRecord>): number {
  return v.material === 0 ? 0 : recordValue(v.material, v.category, v.orientation);
}

const scratch = new Map<number, { cells: DenseChunk; image: ChunkImage }>();

/** Reusable dense chunk and image for `grid` (single-threaded use only). */
export function chunkScratch(grid: ChunkGrid): { cells: DenseChunk; image: ChunkImage } {
  let s = scratch.get(grid.edge);
  if (s === undefined) {
    s = { cells: createDenseChunk(grid), image: createChunkImage(grid) };
    scratch.set(grid.edge, s);
  }
  return s;
}

/** A chunk's canonical codec bytes (every plane, packed body), or null when all air. */
export function encodeDenseChunk(grid: ChunkGrid, cells: DenseChunk): Uint8Array | null {
  if (isAirChunk(cells)) return null;
  const img = chunkScratch(grid).image;
  recordImageFromCells(cells, ALL_PLANES, img);
  return encodePaletteImage(img);
}

/** A chunk's cells from its codec bytes (null: all air) into `out`. */
export function decodeDenseChunk(grid: ChunkGrid, bytes: Uint8Array | null, out: DenseChunk): DenseChunk {
  if (bytes === null) {
    clearDenseChunk(out);
    return out;
  }
  const img = chunkScratch(grid).image;
  decodePaletteImage(bytes, img);
  imageToCells(img, out);
  return out;
}

/** A chunk of `store` into `out` (air when absent). */
export function exportOrAir(store: VoxelStoreCandidate, cx: number, cy: number, cz: number, out: DenseChunk): DenseChunk {
  if (!store.exportChunk(cx, cy, cz, out)) clearDenseChunk(out);
  return out;
}

/** The cells where `b` differs from `a`, with b's values. */
export function diffDense(grid: ChunkGrid, a: DenseChunk, b: DenseChunk): CellDelta {
  const d = new CellDelta();
  const n = grid.cellsPerChunk;
  for (let i = 0; i < n; i++) {
    const m = b.material[i]!;
    if (m === a.material[i] && b.category[i] === a.category[i] && b.shape[i] === a.shape[i] && b.orientation[i] === a.orientation[i]) continue;
    d.push(i, m === 0 ? 0 : recordValue(m, b.category[i]!, b.orientation[i]!), m === 0 ? 0 : b.shape[i]!);
  }
  return d;
}
