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
export {
  damagedRegionChunks,
  openRegion,
  packRegionChunk,
  readRegionChunks,
  readRegionHeader,
  regionChunkCodecBytes,
  regionFileName,
  RegionChunkError,
  RegionFileError,
  RegionIndex,
  REGION_ENTRY_BYTES,
  REGION_FORMAT_VERSION,
  REGION_HEADER_BYTES,
  REGION_OPEN_PREFETCH,
  WORLD_GRID_ID,
  WORLD_ID_BYTES,
  writeRegion,
  type RegionByteSource,
  type RegionChunkRead,
  type RegionCompressor,
  type RegionEntry,
  type RegionHeader,
  type RegionLayout,
  type RegionRange,
  type RegionTile,
} from './region-file';
export { canonicalEditCommand, BRUSH_SHAPES, EDIT_MODES, EditCommandError, VOXEL_EDIT_VERSION, type BrushEdit, type BrushShape, type DigEdit, type EditMode, type EditVoxel, type FillEdit, type SetEdit, type SetVoxel, type StampEdit, type VoxelEditCommand } from './edit-command';
export { CellDelta, chunkScratch, decodeDenseChunk, deltaValue, DELTA_CELL_BYTES, diffDense, encodeDenseChunk, exportOrAir } from './cell-delta';
export { checkStampShape, STAMP_SIDE_MAX, stampShapeHash, type StampResolver, type StampShape } from './stamp-shape';
export { applyEdit, applyUndo, editBounds, editChunks, EditRefused, UNDO_CHUNK_HEADER_BYTES, UNDO_IMAGE_CHECK_BYTES, undoRecordBytes, type ChunkBefore, type ChunkUndo, type EditGrids, type EditOptions, type EditOutcome, type EditRefusal } from './edit-apply';
export { decodeUndoRecord, encodeUndoRecord, UNDO_MEMORY_BUDGET_BYTES, UNDO_RECORD_VERSION, UndoStore, type UndoSpill } from './undo-store';
export {
  applySave,
  applySaveChunk,
  BASE_HASH_BYTES,
  baseChunkHash,
  readSave,
  readSaveVersion,
  SAVE_ENTRY_HEADER_BYTES,
  SAVE_FORMAT_VERSION,
  SAVE_HEADER_BYTES,
  SAVE_UPGRADES,
  saveChunkOf,
  saveContentOf,
  SaveFileError,
  sameHash,
  writeSave,
  type BaseMismatch,
  type MismatchChoice,
  type SaveApplied,
  type SaveChunk,
  type SaveContent,
  type SaveFile,
  type SaveUpgradeStep,
} from './save-file';
export { chunkOverridesOf, decodeOverrides, encodeOverrides, OVERRIDE_CELL_BYTES, OVERRIDE_FORMAT_VERSION, overridesOf, reapplyOverrides, type ChunkOverrides, type OverrideMisfit, type OverrideReport, type StructureOverrides } from './structure-overrides';
export { repairChunks, type RepairOutcome, type RepairSource } from './chunk-repair';
export { DirtyTracker, type ChunkJob, type DirtyChunk, type JobRefusal, type SaveJob } from './dirty-tracker';
export { checkPayloadEdge, payloadBytes, payloadTransfer, type ChunkPayload } from './chunk-wire';
export type { RecordChunkWire } from './palette-chunk';
export type { PlaneWire } from './palette-plane';
export type { BrickWire } from './brick-layout';
export type { PackedWire } from './cell-layout';
export { createWorldStore, WORLD_STORE_OPTIONS } from './palette-store';
export { apronBytes, apronCellCount, apronTransfer, apronVoxelAt, APRON_STRIPS, buildApron, checkApron, checkRadius, dependentChunks, type Apron } from './apron';
export {
  JOB_LANES,
  STREAM_JOB_VERSION,
  type ApplySaveInput,
  type ApplySaveOutput,
  type ChunkRef,
  type DeriveInput,
  type DeriveOutput,
  type EditInput,
  type EditOutput,
  type JobErrorCode,
  type JobLane,
  type JobReply,
  type JobRequest,
  type LoadInput,
  type LoadOutput,
  type SaveContentWire,
  type StoredChunk,
  type StreamJobInputs,
  type StreamJobKind,
  type StreamJobOutputs,
} from './stream-job';
export { serveJobs, type JobEndpoint, type JobHandler, type JobHandlers, type JobResult } from './job-worker';
export { deriveNow, streamJobHandlers, type StreamHandlerOptions } from './stream-handlers';
export { JobQueue } from './job-queue';
export { eventTargetWorker, SampleRing, WorkerPool, type JobOutcome, type PoolJob, type PoolStats, type PoolWorker, type WorkerPoolOptions } from './worker-pool';
export { RegionChunkSource, type ChunkSource, type RegionChunkSourceOptions } from './region-source';
export { checkRing, chunkDistance2, DEFAULT_STREAM_RING, inLoadRing, inNearRing, pastUnloadRing, RESIDENT_CHUNK_OVERHEAD_BYTES, ringChunks, VOXEL_STREAM_BUDGET_BYTES, type Focus, type StreamRing, type StreamTier } from './stream-ring';
export { VoxelStreamer, type DerivedChunk, type StreamCounters, type StreamEvent, type StreamMetrics, type VoxelStreamerOptions } from './voxel-streamer';
export { DEFAULT_REBASE_DISTANCE_M, FloatingOrigin, ORIGIN_SNAP_CELLS, type FloatingOriginOptions, type RebaseEvent } from './floating-origin';
export {
  ASSEMBLY_CLASS,
  assemblyRules,
  CLASS_MASK,
  CONSUMER_REACH,
  createNeighbourhood,
  evaluateAssembly,
  fillNeighbourhood,
  jobRadius,
  PLACEHOLDER_RULES,
  registerAssemblyRules,
  rulesRef,
  RUN_X,
  RUN_Z,
  type AssemblyRuleSet,
  type AssemblyRulesRef,
  type Neighbourhood,
} from './assembly';
export {
  cellBit,
  COLLISION_STEPS_PER_CELL,
  DERIVED_FORMAT_VERSION,
  deriveChunk,
  derivedBytes,
  derivedPartBytes,
  derivedTransfer,
  encodeDerived,
  LIGHT_COVERAGE,
  NAV_CLEARANCE_CELLS,
  NAV_CLEARANCE_CONTINUES,
  OCCUPANCY,
  type CollisionOut,
  type DerivedData,
  type DerivedCounts,
  type DeriveTimes,
  type LightOut,
  type NavOut,
  type OccupancyOut,
} from './derived-data';
export { INSTANCE_BYTES, INSTANCE_FLAG, MaterialSlots, PIECE_FAMILY, PIECE_SECTION, POSITION_STEPS_PER_CELL, SURFACE_ISO, surfaceStride, type InstanceList, type SurfaceBuffer } from './derived-mesh';
export { deriveFromStore, deriveWithApron } from './derive-assembly';
export { downsampleMip, mipChildren, mipNodeKey, mipNodeOf, MipStaleSet, type MipNode } from './voxel-mips';
export { combineCoverage, lightCoverage, PROP_SAMPLES_PER_AXIS, propCoverageChunk, type PropShape } from './prop-coverage';
