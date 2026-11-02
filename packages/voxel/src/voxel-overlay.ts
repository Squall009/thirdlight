/**
 * The runtime overlay: what a running game changed, held as whole voxel
 * values over the authored base world.
 *
 * The base (the shipped region files, read into a store) is never written
 * at runtime. Every change goes into the overlay as the cell's new value:
 * one u32 per changed cell, so a read or write of a voxel is one value,
 * whatever fields it changes. Reads look in the overlay first, then in the
 * base. A write that puts a cell back to its base value removes its
 * override, so the overlay holds exactly the cells that differ.
 *
 * On quit the overlay is dropped; a save keeps of it only the fields the
 * game marks saved (record.ts `DEFAULT_SAVED_FIELDS`: everything but
 * wetness, which weather sets again), merged onto the base value, through
 * the save format's entries (save-file.ts), so changed-cell masks and base
 * hashes work as for any save. The editor's authoring path does not use the
 * overlay: it writes base files.
 *
 * In memory, a chunk's overrides are two sorted arrays (cells as u16 local
 * indices, values as u32), found by binary search: 6 bytes a changed cell.
 */
import { decodeDenseChunk, denseValue, encodeDenseChunk, exportOrAir } from './cell-delta';
import { chunkKey, chunkOfKey, localIndex, type ChunkCoord, type ChunkGrid } from './coords';
import { createDenseChunk, type DenseChunk } from './dense-chunk';
import { checkVoxel, DEFAULT_SAVED_FIELDS, readValue, valueOf, type VoxelRecord } from './record';
import { saveChunkOf, type SaveChunk } from './save-file';
import type { VoxelStoreCandidate } from './store';
import { applyStrokeCells, type VoxelStroke } from './stroke';

/** One chunk's overrides: cells ascending, a value each. */
class ChunkOverlay {
  cells = new Uint16Array(8);
  values = new Uint32Array(8);
  count = 0;

  private find(cell: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = this.cells[mid]!;
      if (c < cell) lo = mid + 1;
      else if (c > cell) hi = mid - 1;
      else return mid;
    }
    return ~lo;
  }

  /** The override of a cell, or −1. */
  get(cell: number): number {
    const k = this.find(cell);
    return k >= 0 ? this.values[k]! : -1;
  }

  put(cell: number, value: number): void {
    const k = this.find(cell);
    if (k >= 0) {
      this.values[k] = value;
      return;
    }
    const at = ~k;
    if (this.count === this.cells.length) {
      const c = new Uint16Array(this.count * 2);
      const v = new Uint32Array(this.count * 2);
      c.set(this.cells);
      v.set(this.values);
      this.cells = c;
      this.values = v;
    }
    this.cells.copyWithin(at + 1, at, this.count);
    this.values.copyWithin(at + 1, at, this.count);
    this.cells[at] = cell;
    this.values[at] = value;
    this.count++;
  }

  remove(cell: number): void {
    const k = this.find(cell);
    if (k < 0) return;
    this.cells.copyWithin(k, k + 1, this.count);
    this.values.copyWithin(k, k + 1, this.count);
    this.count--;
  }

  bytes(): number {
    return this.cells.byteLength + this.values.byteLength;
  }
}

export class VoxelOverlay implements VoxelStoreCandidate {
  readonly name: string;
  readonly grid: ChunkGrid;
  private readonly base: VoxelStoreCandidate;
  private readonly chunks = new Map<number, ChunkOverlay>();
  private readonly scratch: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
  private readonly cells: DenseChunk;

  constructor(base: VoxelStoreCandidate, name = 'overlay') {
    this.base = base;
    this.grid = base.grid;
    this.name = name;
    this.cells = createDenseChunk(base.grid);
  }

  /** Cells the overlay holds (cells that differ from the base). */
  get changedCells(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.count;
    return n;
  }

  /** The chunks with at least one override, in key order. */
  changedChunks(): ChunkCoord[] {
    return [...this.chunks.keys()].sort((a, b) => a - b).map((k) => chunkOfKey(this.grid, k));
  }

  /** Drops every override (a game quitting, or loading another save). */
  clear(): void {
    this.chunks.clear();
  }

  voxelAt(x: number, y: number, z: number, out: VoxelRecord): VoxelRecord {
    // Most of a world has no runtime change: reads then cost what the base's do.
    if (this.chunks.size === 0) return this.base.voxelAt(x, y, z, out);
    const s = this.grid.shift;
    const o = this.chunks.get(chunkKey(this.grid, x >> s, y >> s, z >> s));
    if (o !== undefined) {
      const m = this.grid.mask;
      const v = o.get(localIndex(this.grid, x & m, y & m, z & m));
      if (v >= 0) return readValue(v, out);
    }
    return this.base.voxelAt(x, y, z, out);
  }

  /** Sets a cell to a value: an override, or none when it equals the base's. */
  private put(x: number, y: number, z: number, value: number): void {
    const s = this.grid.shift;
    const m = this.grid.mask;
    const key = chunkKey(this.grid, x >> s, y >> s, z >> s);
    const cell = localIndex(this.grid, x & m, y & m, z & m);
    const base = valueOf(this.base.voxelAt(x, y, z, this.scratch));
    let o = this.chunks.get(key);
    if (value === base) {
      if (o === undefined) return;
      o.remove(cell);
      if (o.count === 0) this.chunks.delete(key);
      return;
    }
    if (o === undefined) this.chunks.set(key, (o = new ChunkOverlay()));
    o.put(cell, value);
  }

  setVoxel(x: number, y: number, z: number, v: Readonly<VoxelRecord>): void {
    if (v.material !== 0) checkVoxel(v);
    this.put(x, y, z, valueOf(v));
  }

  applyStroke(stroke: VoxelStroke): number {
    return applyStrokeCells(this, stroke);
  }

  importChunk(cx: number, cy: number, cz: number, cells: DenseChunk): void {
    const g = this.grid;
    const s = g.shift;
    for (let i = 0; i < g.cellsPerChunk; i++) this.put((cx << s) | (i >>> (s << 1)), (cy << s) | (i & g.mask), (cz << s) | ((i >>> s) & g.mask), denseValue(cells, i));
  }

  /** Whether a chunk holds any override. */
  hasChunk(cx: number, cy: number, cz: number): boolean {
    return this.chunks.has(chunkKey(this.grid, cx, cy, cz));
  }

  /**
   * A chunk's overrides (local cell indices ascending, a value each; null:
   * none). The arrays are the overlay's own: read them before the next write.
   */
  chunkOverrides(cx: number, cy: number, cz: number): { readonly cells: Uint16Array; readonly values: Uint32Array; readonly count: number } | null {
    const o = this.chunks.get(chunkKey(this.grid, cx, cy, cz));
    return o === undefined ? null : { cells: o.cells, values: o.values, count: o.count };
  }

  /**
   * A chunk with overrides may differ from the base's form anywhere, so it
   * reads as stored cells (readers then ask each cell); without, the base's.
   */
  chunkForm(cx: number, cy: number, cz: number): 'absent' | 'uniform' | 'stored' {
    if (this.chunks.has(chunkKey(this.grid, cx, cy, cz))) return 'stored';
    return this.base.chunkForm?.(cx, cy, cz) ?? 'stored';
  }

  exportChunk(cx: number, cy: number, cz: number, out: DenseChunk): boolean {
    return this.exportOver(this.base, cx, cy, cz, out);
  }

  /** {@link exportChunk} with the overrides laid over another base (the same chunk read again from the world's files). */
  private exportOver(base: VoxelStoreCandidate, cx: number, cy: number, cz: number, out: DenseChunk): boolean {
    const had = base.exportChunk(cx, cy, cz, out);
    const o = this.chunks.get(chunkKey(this.grid, cx, cy, cz));
    if (o === undefined) return had;
    if (!had) exportOrAir(base, cx, cy, cz, out);
    const v: VoxelRecord = { material: 0, role: 0, shape: 0, wetness: 0 };
    for (let k = 0; k < o.count; k++) {
      const i = o.cells[k]!;
      readValue(o.values[k]!, v);
      out.material[i] = v.material;
      out.role[i] = v.role;
      out.shape[i] = v.shape;
      out.wetness[i] = v.wetness;
    }
    for (let i = 0; i < this.grid.cellsPerChunk; i++) if (out.material[i] !== 0) return true;
    return false;
  }

  dropChunk(cx: number, cy: number, cz: number): void {
    const air = this.cells;
    air.material.fill(0);
    air.role.fill(0);
    air.shape.fill(0);
    air.wetness.fill(0);
    this.importChunk(cx, cy, cz, air);
  }

  *chunkKeys(): Iterable<number> {
    const seen = new Set<number>();
    for (const k of this.base.chunkKeys()) {
      seen.add(k);
      yield k;
    }
    for (const k of this.chunks.keys()) if (!seen.has(k)) yield k;
  }

  encodeChunk(cx: number, cy: number, cz: number): Uint8Array | null {
    return this.exportChunk(cx, cy, cz, this.cells) ? encodeDenseChunk(this.grid, this.cells) : null;
  }

  decodeChunk(cx: number, cy: number, cz: number, bytes: Uint8Array): void {
    this.importChunk(cx, cy, cz, decodeDenseChunk(this.grid, bytes, this.cells));
  }

  /** Bytes of the overrides' arrays (the base counts its own). */
  memoryBytes(): number {
    let n = 0;
    for (const c of this.chunks.values()) n += c.bytes();
    return n;
  }

  /**
   * The save entries of the overlay: each changed chunk against the base,
   * keeping the fields in `saved` (a PLANE_BIT mask, default all but
   * wetness). Chunks whose kept fields equal the base give no entry.
   */
  saveChunks(gridId: number, saved: number = DEFAULT_SAVED_FIELDS): SaveChunk[] {
    const out: SaveChunk[] = [];
    const now = createDenseChunk(this.grid);
    for (const c of this.changedChunks()) {
      const entry = this.saveChunk(gridId, c.cx, c.cy, c.cz, this.base, saved, now);
      if (entry !== null) out.push(entry);
    }
    return out;
  }

  /**
   * One chunk's save entry against `base` (this overlay's base, or the same
   * chunk read again from the world's files when the base has unloaded it);
   * null when the kept fields equal the base.
   */
  saveChunk(gridId: number, cx: number, cy: number, cz: number, base: VoxelStoreCandidate, saved: number = DEFAULT_SAVED_FIELDS, scratch: DenseChunk = createDenseChunk(this.grid)): SaveChunk | null {
    if (base.grid.edge !== this.grid.edge) throw new RangeError(`a base of edge ${base.grid.edge} for an overlay of edge ${this.grid.edge}`);
    // A chunk with overrides always writes its cells (air included).
    this.exportOver(base, cx, cy, cz, scratch);
    return saveChunkOf(this.grid, gridId, cx, cy, cz, base.encodeChunk(cx, cy, cz), scratch, saved);
  }
}
