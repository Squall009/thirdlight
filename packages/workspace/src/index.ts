/**
 * @thirdlight/workspace — public surface.
 *
 * The only entry point. Everything the editor backend, the MCP tool and
 * (via their shared commands layer) future harness flows use goes through
 * this module: the durable write, ownership, the command pipeline execution,
 * recovery and the external-change protocol live inside the package.
 */

export * from './types';
export { openWorkspaceService } from './service';
export { ERROR_CODES } from './errors';
// Re-exported command/model surface so a consumer never reaches into
// another package's internals (strict-boundary rule):
// commands' MutationResult/CommandError and the model's document types.
// (commands' own `QueryResult` is intentionally NOT re-exported — the
// workspace's own `QueryResult` owns that name on this surface.)
export type { CommandError, MutationResult, MutationSuccess } from '@thirdlight/commands';
export type { WriteOps } from './write';
export { defaultOps as defaultWriteOps } from './write';
export type { EntityV3, SceneV4, Manifest, ModelError } from '@thirdlight/project-model';
// Content storage: the public result/request
// types of the stage/blob/integrity/capture operations. The operations
// themselves are methods on `WorkspaceService`.
export type {
  BlobPublishRequest,
  BlobPublishResult,
  BlobReadRequest,
  BlobReadResult,
  BlobSource,
  PreparedMediaFacts,
  SourceBlobReadRequest,
  SourceBlobReadResult,
  CapturedV3Read,
  CapturedV3ReadResult,
  ContentIntegrityEntry,
  ContentIntegrityResult,
  ContentIntegritySummary,
  IntegrityPage,
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
  PrepareBehaviorSourceOk,
  PrepareBehaviorSourceRequest,
  PrepareBehaviorSourceResult,
  PrepareLibraryDependentsOk,
  PrepareLibraryDependentsResult,
  LibraryStageResult,
  LibraryStageSummary,
  PrepareLibraryStageResult,
  StagedLibraryPatch,
  ScriptLibraryDraftCheckResult,
} from './behavior';
export type { AssetRecord, AssetVersion, ContentCatalog, ImportRecipe } from '@thirdlight/project-model';
// The injected inspector's proposal type is asset-pipeline's
// (the workspace's edge is types-only).
export type { ImportProposal, AudioImportProposal, ImportJobPort } from '@thirdlight/asset-pipeline';
// The injected behavior-source compiler is `behavior-build`'s
// (the workspace's edge is types-only).
export type { BehaviorCompiler, PreparedBehaviorSource } from '@thirdlight/behavior-build';

export { MARKER_FILE, DEFAULT_PROJECT_SUBDIR, REGISTRY_FILE, readMarker, type EnginePin, type ProjectMarker } from './registry';
// The asset database on disk: sidecars, the import cache's keys, the file check's entries.
export { DEFAULT_ASSET_FOLDER, SIDECAR_FORMAT, SIDECAR_SUFFIX, importKeyOfConverted, parseSidecar, type ImportHeader, type ImportKey, type SidecarDoc } from './asset-files';
export type { AssetFileEntry, AssetFilesResult } from './service-content';
export type { WatchedAssetsStats } from './watched-assets';
export { BlobChangedError, type BlobFile, type LocateBlobResult, type OpenBlobResult, type OpenedBlob } from './blob-files';
export { MIP_PARTS_IMPORTER, MIP_PARTS_VERSION, type MipPartFile } from './mip-parts';
export { UPGRADE_REPORT_FILE, type AssetUpgradeReport } from './upgrade-assets';
export { assetNameOfFile, importKindOf, type FolderImportFile, type FolderImportScan, type ImportKind, type PreparedImportFile } from './folder-import';
// Project resources as files (prefabs, materials, … one file each in the game folder) and the content file's format.
export { RESOURCE_FORMAT, RESOURCE_KINDS, defaultResourcePath, resourceFileBytes, resourceKindOfName, SCENE_SUFFIX, type ResourceKind } from './resource-files';
export { CONTENT_STORAGE_VERSION } from './store-v4';
export type { IndexEntry } from './project-index';
export type { ResourceCheckReport } from './resource-check';
// The ids scripts name in string literals (the delete guard, the loadability Problem, the upgrade).
export { literalsIn, scriptNamedAssets, scriptsNaming } from './script-names';
export { SCRIPT_NAMED_LABEL } from './upgrade-loadable';
