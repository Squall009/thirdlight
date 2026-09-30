/**
 * @thirdlight/commands — public surface: types (mutation envelopes, results, errors,
 * change/inverse data), the pure apply function (the forward/inverse
 * application core of the mutation pipeline), the history model, the
 * bounded content queries, and `ERROR_CODES`.
 *
 * The content ops cover assets, components, declared properties, settings,
 * behavior publication, trust acknowledgment and prefabs (`createPrefab`,
 * `instantiatePrefab`, the `removePrefab` undo change), with
 * `queryAssets`/`queryBehaviors`/`queryPrefabs`. Prepared blobs are identifiers/validated data only: this package never
 * reads files or mutates the workspace.
 *
 * The workspace package is the sole command executor: it runs the full
 * pipeline —
 * project resolution, deduplication, pause check, then `applyMutation`
 * (steps 4–6), then the durability write, publish, and acknowledge.
 *
 * Pure logic: no filesystem, no transport, no UI, no three.js, no Node
 * built-ins (the only allowed edge is
 * `project-model`, used for scene/content re-validation of resulting
 * documents, the ID syntax, and canonical byte comparison).
 *
 * All entry points are total: malformed requests yield structured error
 * results, never thrown exceptions; the input state is never mutated.
 */

// Entry points (the ONLY mutation path into command state — the workspace
// service's runCommand calls `applyMutation` and nothing else; AGENTS.md:
// no duplicate scene mutation paths).
export { applyMutation, createCommandState } from './apply';

// Bounded content queries (read-only), including `queryGameConfig` and the
// `queryEntities` component filter helper.
export {
  contentCounts,
  filterEntitiesByComponent,
  queryAssets,
  queryBehaviors,
  queryGameConfig,
  queryPrefabs,
} from './queries';

// Error model and constants.
export { ERROR_CODES, MAX_REQUEST_BYTES, MAX_REVISION } from './errors';
export type { CommandErrorCode } from './errors';

// Types (envelopes, results, change/inverse data, history, state, queries).
export type {
  AcknowledgeBehaviorTrustArgs,
  AnimationRoleBindingValue,
  ApplySurfacePresetArgs,
  ApplySurfacePresetChange,
  CommandAssetRecord,
  CommandAssetVersion,
  ContentDocument,
  EntitiesQueryResult,
  GameConfigQueryResult,
  ModelAnimationRolesValue,
  PublishAssetAnimation,
  SurfacePresetName,
  V3OwnedComponent,
  AcknowledgeBehaviorTrustChange,
  AcknowledgeBehaviorTrustInverse,
  ApplyOutcome,
  AssetSummary,
  BehaviorQueryEntry,
  BehaviorSummary,
  BoxArgs,
  ChangeData,
  ChangedField,
  CommandError,
  CommandState,
  ContentCounts,
  ContentMutationOp,
  CreateEntityArgs,
  CreateEntityChange,
  CreatePrefabArgs,
  CreatePrefabChange,
  DeleteEntityArgs,
  DeleteEntityChange,
  DeleteInverse,
  EmptyArgs,
  ErrorClass,
  ForwardChange,
  ForwardOp,
  HistoryDepths,
  HistoryEntry,
  HistoryState,
  InstantiatePrefabArgs,
  InstantiatePrefabChange,
  InstantiatePrefabEntry,
  InverseSpec,
  M1MutationOp,
  ModelArgs,
  MutationArgs,
  MutationFailure,
  MutationOp,
  MutationRequest,
  MutationResult,
  MutationSuccess,
  PreparedBehaviorSourceFact,
  Origin,
  OwnedComponent,
  PartialTransformArgs,
  PrefabMutationOp,
  PrefabQueryEntry,
  PrefabSummary,
  PropertyOverride,
  PublishAssetArgs,
  PublishAssetChange,
  PublishAssetInverse,
  PublishBehaviorArgs,
  PublishBehaviorChange,
  PublishBehaviorInverse,
  QueryResult,
  RemovePrefabChange,
  RemovePrefabInverse,
  RemoveAssetChange,
  RestorePrefabInverse,
  CreateEntitiesArgs,
  DeleteAssetArgs,
  ImportAssetsArgs,
  ImportAssetsChange,
  ImportResourcesChange,
  PreparedResourceImport,
  PreparedResourceRecord,
  AdoptedScene,
  PreparedAssetImport,
  PreparedAssetImportItem,
  DeletePrefabArgs,
  RestoreSubtreeChange,
  RestoreSubtreeEntry,
  RestoreSubtreeInverse,
  SceneDocument,
  SetBehaviorPropertiesArgs,
  SetBehaviorPropertiesChange,
  SetBehaviorPropertiesInverse,
  SetComponentArgs,
  SetComponentChange,
  SetComponentInverse,
  SetSettingsArgs,
  SetSettingsChange,
  SetSettingsInverse,
  SetTransformArgs,
  SetTransformChange,
  UpdateEntityChange,
  UpdateEntityArgs,
  EntityHeader,
  EntityHeaderField,
  MoveEntitiesArgs,
  MoveEntitiesChange,
  MoveEntitiesInverse,
  MovedEntity,
  SetTagsArgs,
  SetTagsChange,
  SetCollisionLayersChange,
  SetSaveSchemaChange,
  SetAssetOptionsArgs,
  SetAssetOptionsChange,
  PasteEntitiesArgs,
  PasteEntitiesChange,
  SetMaterialChange,
  SetEnvironmentChange,
  SetTagsInverse,
  SetTransformInverse,
  GraphOwner,
  GraphEditArgs,
  GraphEditChange,
  SetAnimatorChange,
  SetAnimatorInverse,
  GraphEditInverse,
  SetGraphArgs,
  DeleteGraphArgs,
  SetGraphChange,
  SetEffectChange,
  SetEffectInverse,
  SetScriptLibraryChange,
  SetScriptLibraryInverse,
  SetScriptLibrariesChange,
  SetScriptLibrariesInverse,
  ScriptLibraryStageFact,
  SetUiChange,
  SetUiInverse,
  SetModesChange,
  SetModesInverse,
  SetModesArgs,
  SetBehaviorGroupsChange,
  SetBehaviorGroupsInverse,
  SetBehaviorGroupsArgs,
  SetEventCuesChange,
  SetEventCuesInverse,
  SetEventCuesArgs,
  SetShellChange,
  SetShellInverse,
  SetShellArgs,
  SetTimelineChange,
  SetTimelineInverse,
  SetTimelineArgs,
  DeleteTimelineArgs,
  SetUiDocumentArgs,
  DeleteUiDocumentArgs,
  SetUiThemeArgs,
  DeleteUiThemeArgs,
  DialogueKind,
  SetDialogueChange,
  SetDialogueInverse,
  SetDialogueArgs,
  DeleteDialogueArgs,
  SetSpeakerArgs,
  DeleteSpeakerArgs,
  SetDialogueSettingsArgs,
  SetScriptLibraryArgs,
  DeleteScriptLibraryArgs,
  CommitScriptLibraryStageArgs,
  SetEffectArgs,
  DeleteEffectArgs,
  RenameEffectArgs,
  SetGraphInverse,
  EditBlocksChange,
  EditBlocksInverse,
  EditBlocksArgs,
  SetBlockTypeChange,
  SetBlockTypeInverse,
  SetBlockTypeArgs,
  DeleteBlockTypeArgs,
  SetCellFieldsChange,
  SetCellFieldsInverse,
  SetCellFieldsArgs,
  SetBlockStampChange,
  SetBlockStampInverse,
  SetBlockStampArgs,
  DeleteBlockStampArgs,
} from './types';
// Block-layer commands and the helpers queries and projections share.
export { blockStampsOf, blockTypesOf, cellFieldsOf, layerDataOf, layerDelta, withLayerData } from './block-ops';
// Graph commands (owner kinds and the shared apply used by undo/redo).
export { GRAPH_OWNER_KINDS, GRAPH_OWNERS, editOwnerGraph, parseBehaviorOwnerId, type GraphOwnerAdapter } from './graph-ops';

// Asset and prefab deletion (the in-use refusal the workspace also raises), bulk creation.
export { contentInUse } from './delete-content-ops';
export { CREATE_ENTITIES_MAX } from './ops';
// A catalog record from import facts (the host rebuilds a lost sidecar's record the way an import makes one).
export { createdAssetRecord } from './content-ops';
export { validatePublishAssetArgs } from './validate-content-args';
