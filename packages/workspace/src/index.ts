/**
 * @thirdlight/workspace — public surface (dependencies.md §3.5).
 *
 * The only entry point. Everything the editor backend, the MCP tool and
 * (via their shared commands layer) future harness flows use goes through
 * this module: the durable write, ownership, the §6.1 pipeline execution,
 * recovery and the external-change protocol live inside the package.
 */

export * from './types';
export { openWorkspaceService } from './service';
export { ERROR_CODES } from './errors';
// Re-exported command/model surface so a consumer never reaches into
// another package's internals (strict-boundary rule, dependencies.md §2):
// commands' MutationResult/CommandError and the model's document types.
// (commands' own `QueryResult` is intentionally NOT re-exported — the
// workspace's own `QueryResult` owns that name on this surface.)
export type { CommandError, MutationResult, MutationSuccess } from '@thirdlight/commands';
export type { WriteOps } from './write';
export { defaultOps as defaultWriteOps } from './write';
export type { Entity, Scene, Manifest, ModelError } from '@thirdlight/project-model';
// Packet-23 content storage (workspace.md §11/§13): the public result/request
// types of the stage/blob/integrity/capture operations and the operator
// migration copy. The operations themselves are methods on `WorkspaceService`.
export type {
  BlobPublishRequest,
  BlobPublishResult,
  BlobReadRequest,
  BlobReadResult,
  BlobSource,
  PreparedMediaFacts,
  SourceBlobReadRequest,
  SourceBlobReadResult,
  CaptureViewResult,
  CapturedV3Read,
  CapturedV3ReadResult,
  ContentIntegrityEntry,
  ContentIntegrityResult,
  ContentIntegritySummary,
  ImportedProposal,
  ConversionSourceResult,
  InspectProjectFileResult,
  InspectStageOptions,
  InspectStageResult,
  InspectorRequest,
  ProjectFileEntry,
  ProjectFileListResult,
  StageDiscardResult,
  StageInspector,
  StageRequest,
  StageResult,
} from './content-store';
export type {
  AnyMigrationMarker,
  MigrationMarker,
  MigrationMarkerV3,
  MigrationPhase,
  MigrationResult,
  MigrationResultV3,
} from './migration';
export type {
  PrepareBehaviorSourceOk,
  PrepareBehaviorSourceRequest,
  PrepareBehaviorSourceResult,
} from './behavior';
export type { AssetRecord, AssetVersion, CapturedContent, ContentCatalog, ImportRecipe } from '@thirdlight/project-model';
// Packet 25: the injected inspector's proposal type is asset-pipeline's
// (dependencies.md §3/§4.1 — the workspace's edge is types-only).
export type { ImportProposal, AudioImportProposal, ImportJobPort } from '@thirdlight/asset-pipeline';
// Packet 33: the injected behavior-source compiler is `behavior-build`'s
// (dependencies.md §3/§4.1 — the workspace's edge is types-only).
export type { BehaviorCompiler, PreparedBehaviorSource } from '@thirdlight/behavior-build';

export { MARKER_FILE, DEFAULT_PROJECT_SUBDIR, REGISTRY_FILE, readMarker, type EnginePin, type ProjectMarker } from './registry';
