/**
 * A chunk as plain typed arrays, one per plane, in {@link localIndex} order.
 *
 * The exchange shape between test-world generators, store candidates and the
 * correctness oracle: every candidate can import and export it, so any two
 * candidates are compared cell by cell. It is the uncompressed layout, not a
 * storage proposal.
 */
import type { ChunkGrid } from './coords';
import { MATERIAL_AIR, PLANE_BIT, type VoxelRecord } from './record';

/** One chunk's planes (each `grid.cellsPerChunk` long). */
export interface DenseChunk {
  readonly material: Uint16Array;
  readonly role: Uint8Array;
  readonly shape: Uint8Array;
  readonly wetness: Uint8Array;
}

/** A chunk of air for `grid`. */
export function createDenseChunk(grid: ChunkGrid): DenseChunk {
  const n = grid.cellsPerChunk;
  return { material: new Uint16Array(n), role: new Uint8Array(n), shape: new Uint8Array(n), wetness: new Uint8Array(n) };
}

/** Typed-array bytes one dense chunk holds (material 2, role, shape and wetness 1 each). */
export function denseChunkBytes(grid: ChunkGrid): number {
  return grid.cellsPerChunk * 5;
}

/** Resets every cell to air. */
export function clearDenseChunk(chunk: DenseChunk): void {
  chunk.material.fill(0);
  chunk.role.fill(0);
  chunk.shape.fill(0);
  chunk.wetness.fill(0);
}

/** Copies every plane of `from` into `to`. */
export function copyDenseChunk(from: DenseChunk, to: DenseChunk): void {
  to.material.set(from.material);
  to.role.set(from.role);
  to.shape.set(from.shape);
  to.wetness.set(from.wetness);
}

/** Reads cell `i` into `out`. */
export function readCell(chunk: DenseChunk, i: number, out: VoxelRecord): VoxelRecord {
  out.material = chunk.material[i] ?? 0;
  out.role = chunk.role[i] ?? 0;
  out.shape = chunk.shape[i] ?? 0;
  out.wetness = chunk.wetness[i] ?? 0;
  return out;
}

/** Writes `v` into cell `i`; air is written as all zeros so equal cells have equal bytes. */
export function writeCell(chunk: DenseChunk, i: number, v: Readonly<VoxelRecord>): void {
  if (v.material === MATERIAL_AIR) {
    chunk.material[i] = 0;
    chunk.role[i] = 0;
    chunk.shape[i] = 0;
    chunk.wetness[i] = 0;
    return;
  }
  chunk.material[i] = v.material;
  chunk.role[i] = v.role;
  chunk.shape[i] = v.shape;
  chunk.wetness[i] = v.wetness;
}

/** Whether every cell is air. */
export function isAirChunk(chunk: DenseChunk): boolean {
  const m = chunk.material;
  for (let i = 0; i < m.length; i++) if (m[i] !== 0) return false;
  return true;
}

/** Whether every cell holds the same record (all air, or all one solid voxel). */
export function isUniformChunk(chunk: DenseChunk): boolean {
  const { material: m, role: c, shape: s, wetness: o } = chunk;
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
  return eq(a.material, b.material) && eq(a.role, b.role) && eq(a.shape, b.shape) && eq(a.wetness, b.wetness);
}

/**
 * Clears the fields outside `mask` ({@link planeMask}) in place, as a store
 * keeping only those fields reads them: each reads 0 (material is always
 * kept).
 */
export function maskDenseChunk(chunk: DenseChunk, mask: number): void {
  if (!(mask & PLANE_BIT.role)) chunk.role.fill(0);
  if (!(mask & PLANE_BIT.wetness)) chunk.wetness.fill(0);
  if (!(mask & PLANE_BIT.shape)) chunk.shape.fill(0);
}
