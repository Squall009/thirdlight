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
  mipCellMetres,
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
  materialSwap,
  swapFrom,
  swapTo,
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
  CONSTRUCTION_ROLES,
  fillLevel,
  isConstructionRole,
  valueDensity,
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
export { checkPayloadEdge, payloadBytes, payloadHolds, payloadTransfer, type ChunkPayload } from './chunk-wire';
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
  type MipInput,
  type MipOutput,
  type SaveContentWire,
  type StoredChunk,
  type StreamJobInputs,
  type StreamJobKind,
  type StreamJobOutputs,
} from './stream-job';
export { serveJobs, type JobEndpoint, type JobHandler, type JobHandlers, type JobResult } from './job-worker';
export { deriveNow, streamJobHandlers, type StreamHandlerOptions } from './stream-handlers';
export { JobQueue } from './job-queue';
export { defaultVoxelWorkers, eventTargetWorker, SampleRing, STREAM_POOL_SETTINGS, WorkerPool, type JobOutcome, type PoolJob, type PoolStats, type PoolWorker, type WorkerPoolOptions } from './worker-pool';
export { RegionChunkSource, type ChunkSource, type RegionChunkSourceOptions } from './region-source';
export { DEFAULT_STREAM_READS, FocusMotion, readOrder, STREAM_PREFETCH_SECONDS, type WantedChunk } from './stream-reads';
export { checkRing, chunkDistance2, DEFAULT_COLLISION_RING, DEFAULT_LEVEL_RINGS, DEFAULT_MIP_RINGS, DEFAULT_STREAM_RING, inLoadRing, inNearRing, MIP_RING_HYSTERESIS_CELLS, pastUnloadRing, RESIDENT_CHUNK_OVERHEAD_BYTES, ringChunks, VOXEL_STREAM_BUDGET_BYTES, type Focus, type MipRing, type StreamRing, type StreamTier } from './stream-ring';
export { StreamMips, type MipEvent, type MipHost } from './stream-mips';
export { checkLevelRings, chooseLevels, DrawnLevels, levelNodeDistance, type LevelChoice, type LevelChoiceStats, type LevelNode, type LevelRings } from './lod-select';
export { StreamLod, type LevelEvent, type LodHost } from './stream-lod';
export { faceLevels, StreamSeams, type LevelSelection, type SeamEvent, type SeamHold, type SeamHost, type SeamKey } from './stream-seams';
export { COLLISION_ADD_MS_PER_UPDATE, COLLISION_PART, COLLISION_RING_HYSTERESIS_CELLS, CollisionRing, collisionRingBounds, type CollisionBodies, type CollisionRingBounds, type CollisionRingFeed, type CollisionRingOptions, type CollisionRingUpdate } from './collision-ring';
export { sectionsOfChunk, type SwapReport } from './stream-sections';
export { joinCollision, joinInstances, joinSections, joinSectionsForDraw, joinShader, joinShaderCells, joinSurfaces, type JoinedChunk, type JoinedDraw, type JoinTimes } from './chunk-join';
export { ChunkDrawBatcher, chunkDrawBatchTransfer, MESH_PART, type ChunkDrawBatch, type ChunkDrawBatcherOptions, type ChunkDrawFeed, type ChunkDrawLevels, type ChunkDrawWire, type ChunkSwapWire, type SeamDrawWire, type SeamPieceWire } from './chunk-batch';
export { VoxelStreamer, type DerivedChunk, type StreamCounters, type StreamEvent, type StreamMetrics, type VoxelStreamerOptions } from './voxel-streamer';
export { StreamPieces, type PiecesHost } from './stream-pieces';
export { worldLevelRings, worldPieceTable, worldStreamer, worldStreamRing, type WorldLevelsMetres, type WorldRingMetres } from './world-streamer';
export { DEFAULT_REBASE_DISTANCE_M, FloatingOrigin, type FloatingOriginOptions, type RebaseEvent } from './floating-origin';
export {
  ASSEMBLY_CLASS,
  CLASS_MASK,
  CONSUMER_REACH,
  createNeighbourhood,
  evaluateAssembly,
  fillNeighbourhood,
  jobRadius,
  PLACEHOLDER_RULES,
  rulesRef,
  RUN_X,
  RUN_Z,
  type AssemblyRuleSet,
  type AssemblyRulesRef,
  type Neighbourhood,
} from './assembly';
export { assemblyRules, registerAssemblyRules, registeredAssemblyRules, WORLD_RULES } from './rule-registry';
export { TERRAIN_FEATURE, TERRAIN_FEATURE_SHIFT, TERRAIN_RULES, TERRAIN_RULES_RADIUS, TERRAIN_THRESHOLDS, terrainFeatureOf, withTerrainFeatures } from './terrain-rules';
export { CREASE_SPLIT_DEG, LATTICE_WINDOW, TERRAIN_MESHER_REACH, terrainSurface } from './terrain-mesher';
export {
  cellBit,
  COLLISION_STEPS_PER_CELL,
  DERIVED_FORMAT_VERSION,
  deriveChunk,
  derivedBytes,
  derivedPartBytes,
  derivedTransfer,
  encodeDerived,
  NAV_CLEARANCE_CELLS,
  NAV_CLEARANCE_CONTINUES,
  OCCUPANCY,
  type CollisionOut,
  type DerivedData,
  type DerivedCounts,
  type DerivePieces,
  type DeriveTimes,
  type LightOut,
  type NavOut,
  type OccupancyOut,
} from './derived-data';
export { INSTANCE_BYTES, INSTANCE_FLAG, PIECE_DETAIL, PIECE_FAMILY, PIECE_SECTION, pieceDetailAt, POSITION_STEPS_PER_CELL, snorm8, SURFACE_ISO, SURFACE_VERTEX_BYTES, type CellPiece, type InstanceList, type SurfaceBuffer } from './derived-mesh';
export { DEFAULT_KIT_ID, DEFAULT_KIT_PIECES, DEFAULT_KIT_UNITS, defaultKitSource, type DefaultKitBox, type DefaultKitPiece } from './default-kit';
export {
  buildPieceTable,
  defaultPiece,
  defaultPieceFamily,
  defaultPieceSection,
  KIT_PIECE_BASE,
  kitPieceList,
  NO_KIT,
  NO_PIECE,
  PIECE_TABLE_FORMAT,
  PIECE_VARIANT_MASK,
  PIECE_VARIANT_MIRROR,
  pieceTableBindsKits,
  pieceTableKitChanges,
  pieceTableChanges,
  pieceVariant,
  readPieceTable,
  RUN_SECTION_IDS,
  RUN_SECTIONS,
  tablePiece,
  type KitPiece,
  type PieceKitSource,
  type PieceTable,
  type PieceTableKit,
} from './piece-table';
export { cropNeighbourhood, type ChunkPieces, deriveFromStore, deriveSectionFromStore, deriveSectionsWithApron, deriveWithApron, sectionIdOf, sectionLocalOrigin, type SectionResult } from './derive-assembly';
export { encodeShader, SHADER_BORDER_CELLS, SHADER_READ_DEPTH_CELLS, shaderBytes, shaderEntry, shaderEntryAt, shaderGridEntries, shaderGridSide, shaderOfNeighbourhood, shaderSolidEntry, type ShaderOut } from './derived-shader';
export {
  applyFold,
  CASE_BASES,
  CASE_INDEX_LIMIT,
  CASE_REACH,
  CASE_ROLES,
  CASE_SHAPES,
  CASE_SYMBOL,
  CASE_WINDOW,
  CASE_WINDOW_CELLS,
  CaseCatalogue,
  caseFoldOf,
  caseFormProblem,
  catalogueReadsMaterial,
  caseIndexOf,
  caseSymbol,
  caseWindowAt,
  caseWindowIndex,
  CELL,
  composeFolds,
  FOLD_TRANSFORMS,
  foldTransform,
  foldWindow,
  NO_CASE,
  notCell,
  type CaseBase,
  type CaseCatalogueDef,
  type CaseDef,
  type CaseMatch,
  type CaseRule,
  type CaseRuleCell,
  type CaseShape,
  type InferredFeature,
} from './kit-cases';
export { DRAFT_CASE_CATALOGUE } from './cases-draft-catalogue';
export { BEAM_BANISTER_CASES, BEAM_BANISTER_RULES, EDGE_CASE_CATALOGUE } from './kit-case-catalogue';
export {
  CORNER_SLOTS,
  createEdgeMasks,
  EDGE_CASE_IDS,
  EDGE_REACH,
  EDGE_SLOTS,
  edgeCaseOf,
  edgePiecesOf,
  edgeYawOf,
  extractEdges,
  PIECE_SLOT_TABLE,
  PIECE_SLOTS,
  type EdgeCaseId,
  type EdgeMasks,
  type EdgePiece,
} from './edge-cases';
export { caseFormTable, classForm, evaluateForms, FORM_BASE, FORM_BODY, FORM_NONE, FORM_SHAPE, FORM_SHAPE_BOX, FORM_STEPS, formBaseOf, formBox, formCoverage, formFoldOf, formFullFaces, formShapeOf, formSupports, LIGHT_COVERAGE, packForm } from './case-forms';
export { EDGE_RULES, evaluateCases, evaluateEdges, evaluateRuns, KIT_RULES, levelHasCases, withCases, withEdges } from './kit-rules';
export { KIT_TEST_SCENE_PITCH, kitTestExhibits, kitTestScene, voxelRoleName, type KitTestExhibit, type KitTestLabel, type KitTestScene, type KitTestSceneOptions } from './kit-test-scene';
export { NO_SECTION, packRunSection, resolveRunSections, RUN_AXIS, RUN_END, RUN_SECTION, runAxisOf, runEndEndOf, runSectionOf, runStartEndOf, RunTable, runU } from './kit-runs';
export { RULE_CONFORMANCE_EXTRA_PAD, ruleRadiusMismatches, type RuleRadiusMismatch } from './rule-conformance';
export { cellOutputs, resolvedClassAt, type CellOutputs } from './derived-cell';
export { collisionBodyParts, collisionGeometry, type CollisionBodyPart, type CollisionGeometry, type CollisionHeightfield, type CollisionMesh, type CollisionMeshLimits, type CollisionSource, type HeightfieldUse } from './derived-collision';
export { groundHeightfield, groundHeightfieldPatches, GROUND_HEIGHTFIELD_TOLERANCE_M, MIN_HEIGHTFIELD_PATCH_CELLS, type GroundHeightfield, type GroundHeightfieldPatches, type HeightfieldPatchOptions, type HeightfieldRefusal } from './ground-heightfield';
export { ChunkTreeFlags, downsampleMip, MIP_ROLE_PRIORITY, MIP_SHEET_CELLS, MIP_SHEET_NEIGHBOURS, mipChildren, mipNodeKey, mipNodeOf, MipStaleSet, type MipNode } from './voxel-mips';
export { deriveMipNode, MipTree, type MipLevelView, type MipSource } from './mip-derive';
export { buildFaceSeam, seamBytes, SEAM_PIECE_PAD_CELLS, SEAM_RIM_CELLS, SEAM_WALK_STEPS, type FaceSeam, type NodeFace, type SeamCounts, type SeamFaceInput, type SeamPiece, type SeamSurface } from './lod-seam';
export { combineCoverage, lightCoverage, lightCoverageAt, PROP_SAMPLES_PER_AXIS, propBounds, propCoverageChunk, type PropShape } from './prop-coverage';
export { PROP_COVERAGE_PART, PropLightChannel, type PropChannelHost } from './prop-channel';
export { VoxelOverlay } from './voxel-overlay';
export { canonicalShippedVoxelWorld, OPEN_REGION_FILES, shippedChunkSource, shippedVoxelWorldsProblem, wholeFileByteSource, type ShippedVoxelFile, type ShippedVoxelWorld } from './shipped-world';
