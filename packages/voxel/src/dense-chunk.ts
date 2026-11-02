/**
 * A chunk as plain typed arrays, one per plane, in {@link localIndex} order.
 *
 * The exchange shape between test-world generators, store candidates and the
 * correctness oracle: every candidate can import and export it, so any two
 * candidates are compared cell by cell. It is the uncompressed layout, not a
 * storage proposal.
 */
import type { ChunkGrid } from './coords';
import { MATERIAL_AIR, PLANE_BIT, SHAPE_EMPTY, SHAPE_FULL, type VoxelRecord } from './record';

/** One chunk's planes (each `grid.cellsPerChunk` long). */
export interface DenseChunk {
  readonly material: Uint32Array;
  readonly category: Uint8Array;
  readonly shape: Uint8Array;
  readonly orientation: Uint8Array;
}

/** A chunk of air for `grid`. */
export function createDenseChunk(grid: ChunkGrid): DenseChunk {
  const n = grid.cellsPerChunk;
  return { material: new Uint32Array(n), category: new Uint8Array(n), shape: new Uint8Array(n), orientation: new Uint8Array(n) };
}

/** Typed-array bytes one dense chunk holds (material 4, category, shape and orientation 1 each). */
export function denseChunkBytes(grid: ChunkGrid): number {
  return grid.cellsPerChunk * 7;
}

/** Resets every cell to air. */
export function clearDenseChunk(chunk: DenseChunk): void {
  chunk.material.fill(0);
  chunk.category.fill(0);
  chunk.shape.fill(0);
  chunk.orientation.fill(0);
}

/** Copies every plane of `from` into `to`. */
export function copyDenseChunk(from: DenseChunk, to: DenseChunk): void {
  to.material.set(from.material);
  to.category.set(from.category);
  to.shape.set(from.shape);
  to.orientation.set(from.orientation);
}

/** Reads cell `i` into `out`. */
export function readCell(chunk: DenseChunk, i: number, out: VoxelRecord): VoxelRecord {
  out.material = chunk.material[i] ?? 0;
  out.category = chunk.category[i] ?? 0;
  out.shape = chunk.shape[i] ?? 0;
  out.orientation = chunk.orientation[i] ?? 0;
  return out;
}

/** Writes `v` into cell `i`; air is written as all zeros so equal cells have equal bytes. */
export function writeCell(chunk: DenseChunk, i: number, v: Readonly<VoxelRecord>): void {
  if (v.material === MATERIAL_AIR) {
    chunk.material[i] = 0;
    chunk.category[i] = 0;
    chunk.shape[i] = 0;
    chunk.orientation[i] = 0;
    return;
  }
  chunk.material[i] = v.material;
  chunk.category[i] = v.category;
  chunk.shape[i] = v.shape;
  chunk.orientation[i] = v.orientation;
}

/** Whether every cell is air. */
export function isAirChunk(chunk: DenseChunk): boolean {
  const m = chunk.material;
  for (let i = 0; i < m.length; i++) if (m[i] !== 0) return false;
  return true;
}

/** Whether every cell holds the same record (all air, or all one solid voxel). */
export function isUniformChunk(chunk: DenseChunk): boolean {
  const { material: m, category: c, shape: s, orientation: o } = chunk;
  const m0 = m[0];
  const c0 = c[0];
  const s0 = s[0];
  const o0 = o[0];
  for (let i = 1; i < m.length; i++) {
    if (m[i] !== m0 || c[i] !== c0 || s[i] !== s0 || o[i] !== o0) return false;
  }
  return true;
}

/** Whether two chunks are equal in every cell and plane. */
export function sameDenseChunk(a: DenseChunk, b: DenseChunk): boolean {
  const eq = (x: ArrayLike<number>, y: ArrayLike<number>): boolean => {
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  };
  return eq(a.material, b.material) && eq(a.category, b.category) && eq(a.shape, b.shape) && eq(a.orientation, b.orientation);
}

/**
 * Clears the planes outside `mask` ({@link planeMask}) in place, as a store
 * keeping only those planes reads them: category and orientation become 0,
 * the shape becomes the one the material implies (air empty, else full).
 */
export function maskDenseChunk(chunk: DenseChunk, mask: number): void {
  if (!(mask & PLANE_BIT.category)) chunk.category.fill(0);
  if (!(mask & PLANE_BIT.orientation)) chunk.orientation.fill(0);
  if (!(mask & PLANE_BIT.shape)) for (let i = 0; i < chunk.shape.length; i++) chunk.shape[i] = chunk.material[i] === MATERIAL_AIR ? SHAPE_EMPTY : SHAPE_FULL;
}
