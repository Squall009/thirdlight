/**
 * Voxel world storage: coordinates, the chunk store contract and its
 * candidates. Runtime-safe (no three.js, no Node built-ins) so module
 * workers, exported games and the backend share one implementation.
 *
 * The voxel record and the dense store are measurement tools while the
 * storage format is chosen: the record is PROVISIONAL (see record.ts) and
 * the dense store is the correctness oracle and naive baseline.
 */
export {
  CHUNK_EDGES,
  DEFAULT_REGION_FOOTPRINT,
  VOXEL_SIZE_M,
  WORLD_CELL_MAX_XZ,
  WORLD_CELL_MAX_Y,
  WORLD_CELL_MIN_XZ,
  WORLD_CELL_MIN_Y,
  cellInWorld,
  chunkGrid,
  chunkInWorld,
  chunkKey,
  chunkKeyOrNone,
  chunkOf,
  chunkOfKey,
  chunkOrigin,
  chunksPerRegionSide,
  localIndex,
  localOf,
  regionKey,
  regionOfCell,
  regionOfChunk,
  regionOfKey,
  type ChunkCoord,
  type ChunkEdge,
  type ChunkGrid,
  type RegionFootprint,
} from './coords';
export {
  AIR,
  BYTE_PLANE_MAX,
  MATERIAL_AIR,
  MATERIAL_ID_MAX,
  PLANE_BYTES,
  SHAPE_EMPTY,
  SHAPE_FULL,
  VOXEL_CATEGORY,
  VOXEL_PLANES,
  checkVoxel,
  isAir,
  sameVoxel,
  voxel,
  type VoxelPlane,
  type VoxelRecord,
} from './record';
export {
  clearDenseChunk,
  copyDenseChunk,
  createDenseChunk,
  denseChunkBytes,
  isAirChunk,
  isUniformChunk,
  readCell,
  sameDenseChunk,
  writeCell,
  type DenseChunk,
} from './dense-chunk';
export { checkStroke, strokeBounds, strokeCovers, type BoxStroke, type Cell, type CellBox, type SphereStroke, type VoxelStroke } from './stroke';
export type { VoxelStoreCandidate, VoxelStoreFactory } from './store';
export { DenseReferenceStore, storeChunkCoords } from './dense-store';
