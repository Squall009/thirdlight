/**
 * The dense reference store: every stored chunk is plain typed arrays.
 *
 * It is the correctness oracle (the simplest store that can be right: each
 * cell is read and written where it lies) and the naive baseline the real
 * candidates must beat on memory and size. Absent chunks read as air; a
 * chunk that becomes all air through an edit stays allocated until it is
 * imported or dropped, as the simplest store would.
 */
import { ChunkIndex } from './chunk-index';
import { cellInWorld, chunkInWorld, chunkOfKey, localIndex, type ChunkGrid } from './coords';
import { copyDenseChunk, createDenseChunk, denseChunkBytes, isAirChunk, readCell, writeCell, type DenseChunk } from './dense-chunk';
import { AIR, MATERIAL_AIR, PLANE_BIT, PLANE_BYTES, VOXEL_PLANES, type VoxelPlane, type VoxelRecord } from './record';
import type { VoxelStoreCandidate } from './store';
import { applyStrokeCells, type VoxelStroke } from './stroke';

export class DenseReferenceStore implements VoxelStoreCandidate {
  readonly name = 'dense';
  readonly grid: ChunkGrid;
  private readonly chunks: ChunkIndex<DenseChunk>;
  // The last chunk read or written (its split key): neighbouring cells usually share a chunk.
  private lastCol = -2;
  private lastY = -2;
  private lastChunk: DenseChunk | undefined;

  constructor(grid: ChunkGrid) {
    this.grid = grid;
    this.chunks = new ChunkIndex<DenseChunk>(grid);
  }

  /** The chunk holding a cell; undefined when absent or outside the world. */
  private chunkAt(x: number, y: number, z: number): DenseChunk | undefined {
    const s = this.grid.shift;
    const col = this.chunks.colKey(x >> s, z >> s);
    const cy = this.chunks.yKey(y >> s);
    if (col === this.lastCol && cy === this.lastY) return this.lastChunk;
    const chunk = this.chunks.getKey(col, cy);
    this.lastCol = col;
    this.lastY = cy;
    this.lastChunk = chunk;
    return chunk;
  }

  private forget(): void {
    this.lastCol = -2;
    this.lastY = -2;
    this.lastChunk = undefined;
  }

  voxelAt(x: number, y: number, z: number, out: VoxelRecord): VoxelRecord {
    const chunk = this.chunkAt(x, y, z);
    if (chunk === undefined) {
      out.material = AIR.material;
      out.category = AIR.category;
      out.shape = AIR.shape;
      out.orientation = AIR.orientation;
      return out;
    }
    const g = this.grid;
    return readCell(chunk, localIndex(g, x & g.mask, y & g.mask, z & g.mask), out);
  }

  setVoxel(x: number, y: number, z: number, v: Readonly<VoxelRecord>): void {
    if (!cellInWorld(x, y, z)) throw new RangeError(`cell (${x}, ${y}, ${z}) is outside the world`);
    let chunk = this.chunkAt(x, y, z);
    if (chunk === undefined) {
      if (v.material === MATERIAL_AIR) return;
      const s = this.grid.shift;
      chunk = createDenseChunk(this.grid);
      this.chunks.set(x >> s, y >> s, z >> s, chunk);
      this.forget();
    }
    const g = this.grid;
    writeCell(chunk, localIndex(g, x & g.mask, y & g.mask, z & g.mask), v);
  }

  applyStroke(stroke: VoxelStroke): number {
    return applyStrokeCells(this, stroke);
  }

  importChunk(cx: number, cy: number, cz: number, cells: DenseChunk): void {
    checkChunk(this.grid, cx, cy, cz);
    this.forget();
    if (isAirChunk(cells)) {
      this.chunks.delete(cx, cy, cz);
      return;
    }
    let chunk = this.chunks.get(cx, cy, cz);
    if (chunk === undefined) {
      chunk = createDenseChunk(this.grid);
      this.chunks.set(cx, cy, cz, chunk);
    }
    copyDenseChunk(cells, chunk);
  }

  exportChunk(cx: number, cy: number, cz: number, out: DenseChunk): boolean {
    checkChunk(this.grid, cx, cy, cz);
    const chunk = this.chunks.get(cx, cy, cz);
    if (chunk === undefined) return false;
    copyDenseChunk(chunk, out);
    return true;
  }

  dropChunk(cx: number, cy: number, cz: number): void {
    checkChunk(this.grid, cx, cy, cz);
    this.chunks.delete(cx, cy, cz);
    this.forget();
  }

  chunkKeys(): Iterable<number> {
    return this.chunks.keys();
  }

  /**
   * One byte naming the planes present, then each present plane's raw cells
   * (material little-endian 24-bit). Uncompressed by design: the baseline
   * every encoding is measured against.
   */
  encodeChunk(cx: number, cy: number, cz: number, planes: readonly VoxelPlane[] = VOXEL_PLANES): Uint8Array | null {
    checkChunk(this.grid, cx, cy, cz);
    const chunk = this.chunks.get(cx, cy, cz);
    if (chunk === undefined) return null;
    const n = this.grid.cellsPerChunk;
    const present = VOXEL_PLANES.filter((p) => planes.includes(p));
    let size = 1;
    for (const p of present) size += n * PLANE_BYTES[p];
    const bytes = new Uint8Array(size);
    let mask = 0;
    let at = 1;
    for (const p of present) {
      mask |= PLANE_BIT[p];
      if (p === 'material') {
        const m = chunk.material;
        for (let i = 0; i < n; i++, at += 3) {
          const v = m[i] ?? 0;
          bytes[at] = v & 0xff;
          bytes[at + 1] = (v >>> 8) & 0xff;
          bytes[at + 2] = v >>> 16;
        }
      } else {
        bytes.set(chunk[p], at);
        at += n;
      }
    }
    bytes[0] = mask;
    return bytes;
  }

  decodeChunk(cx: number, cy: number, cz: number, bytes: Uint8Array): void {
    const n = this.grid.cellsPerChunk;
    const mask = bytes[0] ?? 0;
    let expected = 1;
    for (const p of VOXEL_PLANES) if (mask & PLANE_BIT[p]) expected += n * PLANE_BYTES[p];
    if (bytes.length !== expected || mask > 15) throw new RangeError(`dense chunk bytes: expected ${expected} bytes for plane mask ${mask}, got ${bytes.length}`);
    const chunk = createDenseChunk(this.grid);
    let at = 1;
    for (const p of VOXEL_PLANES) {
      if (!(mask & PLANE_BIT[p])) continue;
      if (p === 'material') {
        for (let i = 0; i < n; i++, at += 3) chunk.material[i] = bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
      } else {
        chunk[p].set(bytes.subarray(at, at + n));
        at += n;
      }
    }
    this.importChunk(cx, cy, cz, chunk);
  }

  memoryBytes(): number {
    return this.chunks.size * denseChunkBytes(this.grid);
  }
}

/** Throws unless a chunk index triple lies inside the world (the chunk-level calls refuse what `voxelAt` reads as air). */
export function checkChunk(grid: ChunkGrid, cx: number, cy: number, cz: number): void {
  if (!chunkInWorld(grid, cx, cy, cz)) throw new RangeError(`chunk (${cx}, ${cy}, ${cz}) is outside the world`);
}

/** Keys of a store's chunks as coordinates, sorted by key. */
export function storeChunkCoords(store: VoxelStoreCandidate): Array<{ cx: number; cy: number; cz: number }> {
  return [...store.chunkKeys()].sort((a, b) => a - b).map((k) => chunkOfKey(store.grid, k));
}
