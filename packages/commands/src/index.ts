/**
 * @thirdlight/commands — public surface (dependencies.md §3;
 * commands.md §2/§5/§8/§9): types (mutation envelopes, results, errors,
 * change/inverse data), the pure apply function (the forward/inverse
 * application core of the mutation pipeline), the history model, the
 * bounded content queries, and `ERROR_CODES`.
 *
 * Packet 21 adds the approved non-prefab M2 request/change/inverse types for
 * assets, components, declared properties, settings, behavior publication and
 * trust acknowledgment, plus `queryAssets`/`queryBehaviors`. Packet 22 adds
 * the prefab M2 request/change/inverse types (`createPrefab`,
 * `instantiatePrefab`, the `removePrefab` undo change) and `queryPrefabs`.
 * Prepared blobs are identifiers/validated data only: this package never
 * reads files or mutates the workspace.
 *
 * The workspace package (packet 07) is the sole command executor
 * (dependencies.md §4.3): it runs the full commands.md §6.1 pipeline —
 * project resolution, deduplication, pause check, then `applyMutation`
 * (steps 4–6), then the durability write, publish, and acknowledge.
 *
 * Pure logic: no filesystem, no transport, no UI, no three.js, no Node
 * built-ins (dependencies.md §4.1: the only allowed edge is
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

// Bounded content queries (read-only, commands.md §4/§5.6). Packet 45 adds
// `queryGameConfig` and the `queryEntities` component filter helper.
export {
  contentCounts,
  filterEntitiesByComponent,
  queryAssets,
  queryBehaviors,
  queryGameConfig,
  queryPrefabs,
} from './queries';

// Error model (§5.4) and constants.
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
  SetGameConfigArgs,
  SetGameConfigChange,
  SetGameConfigInverse,
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
  SetAssetOptionsArgs,
  SetAssetOptionsChange,
  PasteEntitiesArgs,
  PasteEntitiesChange,
  SetMaterialsChange,
  SetEnvironmentChange,
  SetTagsInverse,
  SetTransformInverse,
  GraphOwner,
  GraphEditArgs,
  GraphEditChange,
  SetAnimatorsChange,
  SetAnimatorsInverse,
  GraphEditInverse,
  SetGraphArgs,
  DeleteGraphArgs,
  SetGraphChange,
  SetEffectChange,
  SetEffectInverse,
  SetEffectArgs,
  DeleteEffectArgs,
  RenameEffectArgs,
  SetGraphInverse,
} from './types';
// Phase 16.1: graph commands (owner kinds and the shared apply used by undo/redo).
export { GRAPH_OWNER_KINDS, GRAPH_OWNERS, editOwnerGraph, type GraphOwnerAdapter } from './graph-ops';
