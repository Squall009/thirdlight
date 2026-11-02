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
  ALL_PLANES,
  BYTE_PLANE_MAX,
  MATERIAL_AIR,
  MATERIAL_ID_MAX,
  PLANE_BIT,
  PLANE_BYTES,
  SHAPE_EMPTY,
  SHAPE_FULL,
  VOXEL_CATEGORY,
  VOXEL_PLANES,
  checkVoxel,
  isAir,
  planeMask,
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
  maskDenseChunk,
  readCell,
  sameDenseChunk,
  writeCell,
  type DenseChunk,
} from './dense-chunk';
export { applyStrokeCells, checkStroke, strokeBounds, strokeCovers, type BoxStroke, type Cell, type CellBox, type CellWriter, type SphereStroke, type VoxelStroke } from './stroke';
export type { VoxelStoreCandidate, VoxelStoreFactory } from './store';
export { ChunkIndex } from './chunk-index';
export { DenseReferenceStore, checkChunk, storeChunkCoords } from './dense-store';
export { ColumnRuns, PackedIndices, type CellLayout, type LayoutKind } from './cell-layout';
export { MAX_PALETTE, packedWidth } from './packed-width';
export { BRICK_CELLS, BRICK_EDGE, BrickLayout, brickOrder, bricksPerChunk, brickUniform } from './brick-layout';
export { impliedShape, isSurfaceVoxel, SurfaceDensity } from './surface-density';
export { createPlaneImage, PalettePlane, type PlaneImage } from './palette-plane';
export {
  createChunkImage,
  imageToCells,
  planesImageFromCells,
  recordImageFromCells,
  recordValue,
  valueCategory,
  valueMaterial,
  valueOrientation,
  type ChunkImage,
  type PaletteKind,
} from './palette-image';
export { decodePaletteImage, encodePaletteImage, PALETTE_CODEC_VERSION, readPaletteHeader, type PaletteCodecHeader } from './palette-codec';
export { PlanesChunk, RecordChunk, type PaletteChunk } from './palette-chunk';
export { PaletteStore, type PaletteStoreOptions } from './palette-store';
