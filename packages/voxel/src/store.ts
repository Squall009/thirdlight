/**
 * The chunk store contract every storage candidate implements.
 *
 * The benchmark harness and the correctness tests drive candidates only
 * through this interface, so candidates are compared on equal terms and any
 * of them can be checked cell by cell against the dense reference store.
 * Every reader goes through `voxelAt`; a cheaper special form behind it must
 * not change what it answers.
 */
import type { ChunkGrid } from './coords';
import type { DenseChunk } from './dense-chunk';
import type { VoxelPlane, VoxelRecord } from './record';
import type { VoxelStroke } from './stroke';

export interface VoxelStoreCandidate {
  /** A short name for reports. */
  readonly name: string;
  /** The chunk layout this store uses. */
  readonly grid: ChunkGrid;

  /** The voxel at a cell, written into `out` (air where no chunk is stored). */
  voxelAt(x: number, y: number, z: number, out: VoxelRecord): VoxelRecord;
  /** Writes one cell. */
  setVoxel(x: number, y: number, z: number, v: Readonly<VoxelRecord>): void;
  /** Writes every cell a stroke covers; returns how many cells it wrote. */
  applyStroke(stroke: VoxelStroke): number;

  /** Replaces a chunk with the given cells (an all-air chunk is stored as absent). */
  importChunk(cx: number, cy: number, cz: number, cells: DenseChunk): void;
  /** Writes a chunk's cells into `out`; false (and `out` untouched) when the chunk is absent. */
  exportChunk(cx: number, cy: number, cz: number, out: DenseChunk): boolean;
  /** Forgets a chunk (it reads as air afterwards). */
  dropChunk(cx: number, cy: number, cz: number): void;
  /** Keys ({@link chunkKey}) of the chunks the store holds. */
  chunkKeys(): Iterable<number>;

  /**
   * The chunk's bytes in this candidate's encoding, holding the given planes
   * (all by default); null when the chunk is absent. Leaving a plane out
   * measures what that plane costs; such bytes decode with the plane zeroed.
   */
  encodeChunk(cx: number, cy: number, cz: number, planes?: readonly VoxelPlane[]): Uint8Array | null;
  /** Replaces a chunk with one decoded from {@link encodeChunk}'s bytes. */
  decodeChunk(cx: number, cy: number, cz: number, bytes: Uint8Array): void;

  /** Bytes the store's chunk data occupies in memory (its arrays; what the report states it counts). */
  memoryBytes(): number;
}

/** Makes an empty store of one candidate for a chunk layout. */
export type VoxelStoreFactory = (grid: ChunkGrid) => VoxelStoreCandidate;
