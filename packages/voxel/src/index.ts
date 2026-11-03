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
  isRegionFootprint,
  localIndex,
  REGION_FOOTPRINTS,
  localOf,
  regionKey,
  regionOfCell,
  regionOfChunk,
  regionOfKey,
  DEFAULT_SECTION_EDGE,
  SECTION_EDGES,
  sectionGrid,
  type CellGrid,
  type ChunkCoord,
  type ChunkEdge,
  type ChunkGrid,
  type RegionFootprint,
  type SectionEdge,
} from './coords';
export {
  AIR,
  ALL_DERIVED_PARTS,
  ALL_PLANES,
  changedFields,
  checkRecordValue,
  checkValueForm,
  checkVoxel,
  DEFAULT_SAVED_FIELDS,
  DENSITY_FULL,
  DERIVED_PART,
  FIELD_FEEDS,
  fieldsFeed,
  isAir,
  MATERIAL_AIR,
  MATERIAL_BITS,
  MATERIAL_ID_MAX,
  PLANE_BIT,
  PLANE_BYTES,
  planeMask,
  readValue,
  RECORD_VALUE_FORM,
  recordValue,
  RESERVED_BITS,
  ROLE_BITS,
  sameVoxel,
  savedValue,
  SHAPE_BITS,
  SHAPE_EMPTY,
  SHAPE_FULL,
  shapeDensity,
  valueMaterial,
  valueOf,
  valueRole,
  valueShape,
  valueWetness,
  voxel,
  VOXEL_PLANES,
  VOXEL_ROLE,
  VOXEL_ROLE_COUNT,
  WETNESS_BITS,
  WETNESS_MAX,
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
export { createPlaneImage, PalettePlane, type PlaneImage } from './palette-plane';
export { createChunkImage, imageIsUniform, imageToCells, planesImageFromCells, recordImageFromCells, uniformImageValue, type ChunkImage, type PaletteKind } from './palette-image';
export { CHUNK_CODEC_UPGRADES, decodePaletteImage, encodePaletteImage, liftChunkBytes, PALETTE_CODEC_VERSION, readPaletteHeader, type PaletteCodecHeader } from './palette-codec';
export { decodeMeasuredImage, encodeMeasuredImage, readMeasuredHeader } from './palette-codec-measure';
export { liftVersion, type UpgradeStep } from './format-upgrade';
export { PlanesChunk, RecordChunk, type PaletteChunk } from './palette-chunk';
export { PaletteStore, type PaletteStoreOptions } from './palette-store';
export {
  checkRegionTile,
  damagedRegionChunks,
  liftRegionIndex,
  openRegion,
  parseRegionFileName,
  REGION_UPGRADES,
  regionIndexEnd,
  packRegionChunk,
  readRegionChunks,
  REGION_READ_GAP_BYTES,
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
  VOXEL_WORLD_NAME_RE,
  WORLD_ID_BYTES,
  writeRegion,
  type RegionByteSource,
  type RegionChunkRead,
  type RegionCompressor,
  type RegionEntry,
  type RegionExpect,
  type RegionHeader,
  type RegionReadOptions,
  type RegionUpgradeStep,
  type RegionLayout,
  type RegionRange,
  type RegionTile,
} from './region-file';
export { canonicalEditCommand, BRUSH_SHAPES, EDIT_MODES, EditCommandError, VOXEL_EDIT_VERSION, type BrushEdit, type BrushShape, type DigEdit, type EditMode, type EditVoxel, type FillEdit, type SetEdit, type SetVoxel, type StampEdit, type VoxelEditCommand } from './edit-command';
export { CellDelta, chunkScratch, decodeDenseChunk, DELTA_CELL_BYTES, denseValue, diffDense, encodeDenseChunk, exportOrAir, writeDenseValue } from './cell-delta';
export { checkStampShape, STAMP_SIDE_MAX, stampShapeHash, type StampResolver, type StampShape } from './stamp-shape';
export { applyEdit, applyUndo, chunkWorstUndoBytes, editBounds, editChunks, EditRefused, UNDO_CHUNK_HEADER_BYTES, UNDO_IMAGE_CHECK_BYTES, UNDO_MEMORY_BUDGET_BYTES, undoRecordBytes, type ChunkBefore, type ChunkUndo, type EditGrids, type EditOptions, type EditOutcome, type EditRefusal } from './edit-apply';
export { decodeUndoRecord, encodeUndoRecord, UNDO_RECORD_VERSION, UndoStore, type UndoSpill } from './undo-store';
export {
  applySave,
  applySaveChunk,
  BASE_FORM_CODEC_VERSION,
  BASE_HASH_BYTES,
  baseChunkHash,
  baseContentHash,
  changedMaskBytes,
  persistedCells,
  playerCells,
  readSave,
  readSaveVersion,
  SAVE_ENTRY_HEADER_BYTES,
  SAVE_FIRST_VERSION,
  SAVE_FORMAT_VERSION,
  SAVE_HEADER_BYTES,
  SAVE_UPGRADES,
  saveChunkOf,
  saveContentFromPayload,
  saveContentOf,
  savePayloadOf,
  SaveFileError,
  sameHash,
  writeSave,
  type BaseMismatch,
  type MismatchChoice,
  type SaveApplied,
  type SaveChunk,
  type SaveContent,
  type SaveContentKind,
  type SaveFile,
  type SaveUpgradeStep,
} from './save-file';
export { chunkOverridesOf, decodeOverrides, encodeOverrides, OVERRIDE_CELL_BYTES, OVERRIDE_FIRST_VERSION, OVERRIDE_FORMAT_VERSION, OVERRIDE_UPGRADES, overridesOf, reapplyOverrides, type ChunkOverrides, type OverrideUpgradeStep, type OverrideMisfit, type OverrideReport, type StructureOverrides } from './structure-overrides';
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
export { eventTargetWorker, SampleRing, STREAM_POOL_SETTINGS, WorkerPool, type JobOutcome, type PoolJob, type PoolStats, type PoolWorker, type WorkerPoolOptions } from './worker-pool';
export { RegionChunkSource, type ChunkSource, type RegionChunkSourceOptions } from './region-source';
export { DEFAULT_STREAM_READS, FocusMotion, readOrder, STREAM_PREFETCH_SECONDS, type WantedChunk } from './stream-reads';
export { checkRing, chunkDistance2, DEFAULT_COLLISION_RING, DEFAULT_STREAM_RING, inLoadRing, inNearRing, pastUnloadRing, RESIDENT_CHUNK_OVERHEAD_BYTES, ringChunks, VOXEL_STREAM_BUDGET_BYTES, type Focus, type StreamRing, type StreamTier } from './stream-ring';
export { COLLISION_ADD_MS_PER_UPDATE, COLLISION_PART, COLLISION_RING_HYSTERESIS_CELLS, CollisionRing, collisionRingBounds, type CollisionBodies, type CollisionRingBounds, type CollisionRingFeed, type CollisionRingOptions, type CollisionRingUpdate } from './collision-ring';
export { sectionsOfChunk, type SwapReport } from './stream-sections';
export { joinCollision, joinInstances, joinSections, joinSectionsForDraw, joinShader, joinShaderCells, joinSurfaces, type JoinedChunk, type JoinedDraw, type JoinTimes } from './chunk-join';
export { ChunkDrawBatcher, chunkDrawBatchTransfer, MESH_PART, type ChunkDrawBatch, type ChunkDrawFeed, type ChunkDrawWire, type ChunkSwapWire } from './chunk-batch';
export { VoxelStreamer, type DerivedChunk, type StreamCounters, type StreamEvent, type StreamMetrics, type VoxelStreamerOptions } from './voxel-streamer';
export { worldStreamer, worldStreamRing, type WorldRingMetres } from './world-streamer';
export { DEFAULT_REBASE_DISTANCE_M, FloatingOrigin, type FloatingOriginOptions, type RebaseEvent } from './floating-origin';
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
  registeredAssemblyRules,
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
export { INSTANCE_BYTES, INSTANCE_FLAG, PIECE_FAMILY, PIECE_SECTION, POSITION_STEPS_PER_CELL, SURFACE_ISO, SURFACE_VERTEX_BYTES, type InstanceList, type SurfaceBuffer } from './derived-mesh';
export { deriveFromStore, deriveSectionFromStore, deriveSectionsWithApron, deriveWithApron, sectionIdOf, sectionLocalOrigin, type SectionResult } from './derive-assembly';
export { encodeShader, SHADER_BORDER_CELLS, shaderBytes, shaderEntry, shaderEntryAt, shaderGridEntries, shaderGridSide, shaderOfNeighbourhood, shaderSolidEntry, type ShaderOut } from './derived-shader';
export { RULE_CONFORMANCE_EXTRA_PAD, ruleRadiusMismatches, type RuleRadiusMismatch } from './rule-conformance';
export { cellOutputs, resolvedClassAt, type CellOutputs } from './derived-cell';
export { collisionBodyParts, collisionGeometry, type CollisionBodyPart, type CollisionGeometry, type CollisionHeightfield, type CollisionMesh, type CollisionMeshLimits, type CollisionSource } from './derived-collision';
export { groundHeightfield, GROUND_HEIGHTFIELD_TOLERANCE_M, type GroundHeightfield, type HeightfieldRefusal } from './ground-heightfield';
export { ChunkTreeFlags, downsampleMip, mipChildren, mipNodeKey, mipNodeOf, MipStaleSet, type MipNode } from './voxel-mips';
export { combineCoverage, lightCoverage, lightCoverageAt, PROP_SAMPLES_PER_AXIS, propBounds, propCoverageChunk, type PropShape } from './prop-coverage';
export { PROP_COVERAGE_PART, PropLightChannel, type PropChannelHost } from './prop-channel';
export { VoxelOverlay } from './voxel-overlay';
