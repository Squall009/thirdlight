/**
 * Public types.
 *
 * These are the command-layer wire shapes: the mutation request envelope,
 * the mutation success/failure results, the structured
 * error model, the change data and inverse specs (`change-types.ts`), the
 * in-memory history model, and the per-project command state the
 * pure apply function works on.
 *
 * Ownership: this package owns command
 * semantics only. Request canonicalization/digests, durable retry
 * records, the revision's durable storage, and project resolution
 * belong to the workspace package. Nothing here touches the
 * filesystem, transport, UI, or three.js (the only allowed edge is
 * project-model).
 *
 * Runtime inputs to the public entry points are `unknown` where marked:
 * the strict validators re-check every rule (contract strictness);
 * TypeScript types alone never make a value safe.
 */

import type {
  AssetMetrics,
  AssetKind,
  ConvertedFrom,
  PackedFrom,
  ImportRecipe,
  ImportRecipeV3,
  LimitName,
  Manifest,
  ModelError,
  ModelErrorV3,
  PropertyDeclaration,
  PropertyValue,
  SceneV3,
  SettingsMap,
  SceneV4,
  SceneEnvironment,
  EffectDef,
  GraphData,
  GraphDocument,
  UiDocument,
  UiTheme,
  GameMode,
  TimelineAsset,
  StoredVertexColors,
} from '@thirdlight/project-model';
import type { PartialTransformArgs, CreateEntityArgs, UpdateEntityArgs } from './entity-types';

export type { EntityHeader, EntityHeaderField, PartialTransformArgs, BoxArgs, ModelArgs, CreateEntityArgs, UpdateEntityArgs } from './entity-types';
import type { ImportAssetsArgs, PreparedAssetImport } from './import-assets';
export type { ImportAssetsArgs, ImportAssetsChange, ImportAssetsInverse, PreparedAssetImport, PreparedAssetImportItem } from './import-assets';
import type { ImportResourcesArgs, PreparedResourceImport } from './import-resources';
import type { SetAddressArgs, SetLabelsArgs } from './loadable-ops';
import type { PreparedMoves } from './move-ops';
export type { CreateFolderArgs, FileMove, FolderMove, MoveItemRef, MoveResourcesArgs, MoveResourcesChange, MoveResourcesInverse, PreparedMoves, RenameFolderArgs } from './move-ops';
export type { LoadableItemRef, LoadingItemChange, LoadingValue, SetAddressArgs, SetLabelsArgs, SetLoadingChange, SetLoadingInverse } from './loadable-ops';
export type { SetCollisionLayersChange, SetCollisionLayersInverse, SetLightLayersChange, SetLightLayersInverse } from './layer-types';
export type { AdoptedScene, ImportResourcesArgs, ImportResourcesChange, ImportResourcesInverse, PreparedResourceImport, PreparedResourceRecord } from './import-resources';

// ---- ops and origins --------------------------------------------------------

import type { ContentMutationOp, ForwardOp, M1MutationOp, MutationOp, PrefabMutationOp, V3MutationOp } from './mutation-ops';
export type { ContentMutationOp, ForwardOp, M1MutationOp, MutationOp, PrefabMutationOp, V3MutationOp } from './mutation-ops';

/** Request origin: absent ⇒ recorded as `null` in the history entry. */
export interface Origin {
  kind: 'browser' | 'mcp' | 'admin';
  /** 1–128 chars, no control characters. */
  clientId: string;
}

// ---- error model --------------------------------------------------

/** Client policy classes. */
export type ErrorClass =
  | 'conflict'
  | 'validation'
  | 'unavailable'
  | 'not_found'
  | 'internal';

/**
 * One structured error.
 *
 * Key order in emitted payloads: `code`, `cls`, then the code-specific
 * fields in error table order, then (result-scene failures)
 * `detailDocument`, `details`, `detailCount`, `detailsTruncated`, then
 * `message`, `hint` — the byte-exact scenario fixtures pin this order.
 *
 * Code-specific fields (present only where the error table lists them):
 * - `invalid_request`, `field_missing`/`field_unexpected`/`field_type`/
 *   `field_value`: `path` (JSON Pointer into the request), `found`
 *   (bounded), `expected`.
 * - `revision_conflict`: `expectedRevision`, `currentRevision`.
 * - `request_id_reused`, `revision_exhausted`: `currentRevision`.
 * - `entity_not_found`: `entityId`.
 * - `reference_missing`: `found`, `expected`.
 * - `camera_count_invalid`: `cameraId`.
 * - `limits_exceeded`: `limit` ("entities" | "depth"), `current`, `max`.
 * - `id_exhaustion`: `kind`.
 * - `history_empty`: `which` ("undo" | "redo").
 * - `history_invalid`: `requestId` (of the history entry).
 * - result-scene validation failure: `detailDocument: "result-scene"`,
 *   `details` (project-model error objects in document order, capped
 *   at 32), `detailCount` (true total), `detailsTruncated` (when capped).
 *
 * The workspace-level codes (`project_not_found`, `project_unavailable`,
 * `workspace_closed`, `request_id_reused`, `external_change_unresolved`,
 * `write_failed`, …) are in `ERROR_CODES` but are constructed by the
 * workspace package, never by this pure layer.
 */
export interface CommandError {
  code: string;
  cls: ErrorClass;
  /** One actionable sentence, safe for logs, no secrets. */
  message: string;
  hint?: string;
  path?: string;
  found?: unknown;
  expected?: string;
  /** `project`: the workspace's rules across the scenes of a v4 project. */
  detailDocument?: 'result-scene' | 'project';
  details?: readonly (ModelError | ModelErrorV3)[];
  detailCount?: number;
  detailsTruncated?: boolean;
  expectedRevision?: number;
  currentRevision?: number;
  entityId?: string;
  cameraId?: string;
  limit?: LimitName;
  current?: number;
  max?: number;
  kind?: string;
  which?: 'undo' | 'redo';
  /** `history_invalid` only: the requestId of the failed history entry. */
  requestId?: string;
  // content/property ops:
  assetId?: string;
  assetVersion?: number;
  behaviorId?: string;
  mode?: string;
  key?: string;
  keys?: readonly string[];
  uses?: readonly { entityId: string; key: string }[];
  component?: string;
  entityIds?: readonly string[];
  referencingEntityIds?: readonly string[];
  // v3 presentation rows:
  /** `animation_role_*` rows: the role key the diagnostic names. */
  role?: string;
  /** `animation_role_out_of_range`/`animation_role_duplicate` rows. */
  clipIndex?: number;
  /** `animation_role_out_of_range` only: the version's clip count. */
  clips?: number;
  /** `animation_role_duplicate` only: the roles sharing one clip index. */
  roles?: readonly string[];
  sourceDigest?: string;
  // prefab ops:
  prefabId?: string;
  sourceEntityId?: string;
  localId?: string;
  prefabInstanceIds?: readonly string[];
  // workspace-level only (not emitted by the pure layer):
  projectId?: string;
  reason?: string;
  holder?: unknown;
  pendingChange?: unknown;
  onDiskState?: 'previous' | 'new-undurable';
  errno?: unknown;
}

// ---- change data and inverse specs (their own module) -----------------------

import type {
  ChangeData,
  ContentDocument,
  ForwardChange,
  GraphEditArgs,
  InverseSpec,
  OwnedComponent,
  SceneIndexArgs,
  SurfacePresetName,
} from './change-types';
export type {
  AcknowledgeBehaviorTrustChange, AcknowledgeBehaviorTrustInverse, ApplySurfacePresetChange, ChangeData,
  ChangedField, CommandAssetRecord, CommandAssetVersion, ContentDocument, CreateEntityChange, CreatePrefabChange,
  DeleteEntityChange, DeleteInverse, DialogueKind, EditBlocksChange, EditBlocksInverse, ForwardChange,
  GraphEditArgs, GraphEditChange, GraphEditInverse, GraphOwner, InstantiatePrefabChange, InstantiatePrefabEntry,
  InverseSpec, MoveEntitiesChange, MoveEntitiesInverse, MoveEntitiesSceneChange, MoveEntitiesSceneInverse,
  MovedEntity, OwnedComponent, PasteEntitiesChange, PublishAssetChange, PublishAssetInverse,
  PublishBehaviorChange, PublishBehaviorInverse, RemoveAssetChange, RemoveEntitiesInverse, RemovePrefabChange,
  RemovePrefabInverse, RestorePrefabInverse, RestoreSubtreeChange, RestoreSubtreeEntry, RestoreSubtreeInverse,
  SceneIndexArgs, SetAnimatorChange, SetAnimatorInverse, SetAssetOptionsChange, SetAssetOptionsInverse,
  SetBehaviorGroupsChange, SetBehaviorGroupsInverse, SetBehaviorPropertiesChange, SetBehaviorPropertiesInverse,
  SetBlockStampChange, SetBlockStampInverse, SetBlockTypeChange, SetBlockTypeInverse, SetCellFieldsChange,
  SetCellFieldsInverse, SetComponentChange, SetComponentInverse, SetDialogueChange, SetDialogueInverse,
  SetEffectChange, SetEffectInverse, SetEnvironmentChange, SetEnvironmentInverse, SetEventCuesChange,
  SetEventCuesInverse, SetGraphChange, SetGraphInverse, SetInputChange, SetInputInverse, SetKitChange,
  SetKitInverse, SetLightingChange, SetLightingInverse, SetMaterialChange, SetMaterialInverse, SetModesChange,
  SetModesInverse, SetSaveSchemaChange, SetSaveSchemaInverse, SetSceneIndexChange, SetSceneIndexInverse,
  SetScenePlaneChange, SetScenePlaneInverse, SetScriptLibrariesChange, SetScriptLibrariesInverse,
  SetScriptLibraryChange, SetScriptLibraryInverse, SetSettingsChange, SetSettingsInverse, SetShellChange,
  SetShellInverse, SetTagsChange, SetTagsInverse, SetTimelineChange, SetTimelineInverse, SetTransformChange,
  SetTransformInverse, SetUiChange, SetUiInverse, SurfacePresetName, UpdateEntityChange, UpdateEntityInverse,
  UpdatePrefabChange, UpdatePrefabInverse, V3OwnedComponent,
} from './change-types';

// ---- history model --------------------------------------------------------

/**
 * One history entry. Per project, in memory only; `seq` is a
 * per-session diagnostic counter, not part of any durable record.
 */
export interface HistoryEntry {
  seq: number;
  requestId: string;
  /** The forward op that created the entry. */
  op: ForwardOp;
  /** The origin of the original command (or null). */
  origin: Origin | null;
  /** The revision this forward command produced. */
  appliedRevision: number;
  /** Forward change data. */
  change: ForwardChange;
  /** Inverse spec. */
  inverse: InverseSpec;
  /** The chunks and regions props' footprints changed with the command, before and after. */
  footprints?: import('./block-patch').BlockLayerPatch[];
  /**
   * Entries of one user action that ran several commands share a group (the
   * `seq` of its last entry): undo and redo take them together. Set by the
   * workspace after they ran.
   */
  group?: number;
  /** Components the project host wrote with the command (terrains shaped by splines, a spline's made mesh), before and after. */
  follows?: import('./follow-ops').ComponentFollow[];
  /**
   * The scene the entry edited in a v4 project (set by the
   * workspace; absent for content-only entries and in v1–v3).
   */
  sceneId?: string;
}

/**
 * The history stack: `entries[0..n-1]` with cursor `c`;
 * entries below `c` are applied, entries at or above `c` are undone (the
 * redo tail). Fresh edits truncate `entries[c..n-1]`.
 */
export interface HistoryState {
  entries: readonly HistoryEntry[];
  /** 0 ≤ cursor ≤ entries.length. */
  cursor: number;
  /** Next per-session diagnostic seq value. */
  seq: number;
}

/** Depths reported in results and queries. */
export interface HistoryDepths {
  undoDepth: number;
  redoDepth: number;
}

// ---- command state --------------------------------------------------------------

/**
 * A scene document the command layer can carry: a v4 scene (one of a
 * project's scene files — what the workspace edits) or a v3 scene (edited
 * the same way; kept for the v3 test corpus and the v3 → v4 upgrade path).
 */
export type SceneDocument = SceneV3 | SceneV4;

/**
 * The per-project in-memory state the pure apply function operates on.
 * `scene` must be a VALID canonical scene — the
 * workspace service guarantees this at load and after every
 * published mutation; the command layer re-validates only RESULT documents.
 *
 * `content` is the project's content block (for a v4 project the whole
 * project's block). When absent it is treated as the empty
 * v3 catalog. `manifest` is the v1 manifest of a v3 state when the caller
 * has one: with it, a v3 result is validated by the three-block
 * `validateProjectV3`.
 */
export interface CommandState<S extends SceneDocument = SceneDocument> {
  scene: S;
  /**
   * In a v4 project `scene` is the one scene an edit touches;
   * these are the entity ids of the project's other scenes (ids are unique
   * across the project, so none of them is ever minted).
   */
  reservedIds?: ReadonlySet<string>;
  content?: ContentDocument;
  manifest?: Manifest;
  history: HistoryState;
  /**
   * True when the host has registered a behavior-source preparer (the
   * workspace injects a compiler). Absent/false keeps the structural
   * refusal `behavior_publication_unavailable`
   * (`reason: "preparer_unavailable"`).
   */
  behaviorPreparerRegistered?: boolean;
  /**
   * The digest-bound prepared results the preparer derived from durable
   * bytes, keyed by `sourceDigest`. The `publishBehavior`
   * source branch reads ONLY these facts — never a caller-supplied record
   * field — so no unchecked write path exists.
   */
  preparedBehaviorSources?: ReadonlyMap<string, PreparedBehaviorSourceFact>;
  /** The host's staged library edit sets by stageId (`commitScriptLibraryStage` reads only these). */
  scriptLibraryStages?: ReadonlyMap<string, ScriptLibraryStageFact>;
  /** The host's prepared facts of a folder's files (`importAssets` reads only these). */
  preparedAssetImport?: PreparedAssetImport;
  /** The host's prepared facts of resource and scene files (`importResources` reads only these). */
  preparedResourceImport?: PreparedResourceImport;
  /** The host's prepared file and folder moves (`moveResources`, `renameFolder`, `createFolder` read only these). */
  preparedMoves?: PreparedMoves;
  /** The host's planned and published stroke (`paintInstances` reads only this). */
  preparedInstanceStroke?: import('./instance-stroke-ops').PreparedInstanceStroke;
  /** The host's planned and published vertex paint (`paintVertices` reads only this). */
  preparedVertexPaint?: import('./vertex-paint-ops').PreparedVertexPaint;
  /** The host's collider shape made from the object's model (`colliderFromModel` reads only this). */
  preparedModelCollider?: import('./collider-model-ops').PreparedModelCollider;
  /** The host's planned and published terrain edit (`editTerrain` reads only this). */
  preparedTerrainEdit?: import('./terrain-ops').PreparedTerrainEdit;
  /** The looks of the scenes a scene-index op names besides the edited one (a deleted scene, the scene a new one copies). */
  sceneEnvironments?: ReadonlyMap<string, SceneEnvironment>;
  /**
   * A second scene a cross-scene move edits (the destination; for its undo,
   * the scene the objects go back from). After the command: that scene as it
   * now is.
   */
  otherScene?: { sceneId: string; scene: S };
}

/**
 * One prepared behavior-source fact set: every
 * field is derived by the preparer from the durable container bytes and the
 * compiled output. Structurally identical to `behavior-build`'s
 * `PreparedBehaviorSource` (commands holds no edge to that Node-side unit).
 */
export interface PreparedBehaviorSourceFact {
  behaviorId: string;
  sourceDigest: string;
  sourceByteLength: number;
  entryPath: string;
  fileCount: number;
  manifestDigest: string;
  outputDigest: string;
  outputByteLength: number;
  requiredModules: string[];
  ownedTransforms: string[];
  declaration: PropertyDeclaration;
  /** The declaration was derived from `export const properties` in the code. */
  declaredInCode?: true;
  /** The source was generated from a visual-script graph. */
  sourceKind?: 'graph';
  /** The script library versions the output links (absent when none). */
  libraries?: { libraryId: string; sourceDigest: string }[];
  declarationDigest: string;
  recipeDigest: string;
  compiler: { id: string; version: string; esbuild: string; typescript: string };
}

// ---- mutation request envelopes ----------------------------------------------

/**
 * `setAssetOptions`: per-asset render options. `vertexColors` (model only):
 * `data` (default: COLOR_0 is shader data, never multiplied into the albedo),
 * `tint` (the glTF default) or `trim` (COLOR_0 was authored as trim data:
 * R occlusion, B wetness; it is moved into the trim data as the model loads).
 */
/**
 * `pasteEntities`: create copies of full entity values in one transaction
 * (Duplicate, Copy/Paste — also across scenes). See `paste-ops.ts`.
 */
export interface PasteEntitiesArgs {
  entities: { id: string; parentId?: string; components: Record<string, unknown> }[];
  /** The parent of the pasted roots (null = scene root); absent = each root's own parentId. */
  parentId?: string | null;
  /** Added to the positions of the copies placed in world space. */
  offset?: [number, number, number];
}

export interface SetAssetOptionsArgs {
  assetId: string;
  vertexColors?: 'data' | StoredVertexColors;
  /** The default material mapping of every placement (null = none). */
  materials?: Record<string, string> | null;
  /** An animation-only file whose clips play on this model asset's rig (null = its clips are its own). */
  clipsFor?: string | null;
  /** The asset file's path in the game folder (any kind): a file moved there keeps its asset and every reference to it. */
  sourcePath?: string;
  /** Audio only: how the game holds the file (null = the default for its length). */
  loadType?: 'decode-on-load' | 'decode-while-playing' | 'stream' | null;
  /** Audio only: read with the scene that uses it (true, the default) or only when played. */
  preload?: boolean;
  /** Texture only: stream its mips (null = the default: on for a KTX2 texture over 1024 px). */
  streaming?: boolean | null;
  /** Model only: its LOD group settings — switch points and cull size (null = the defaults). */
  lod?: import('@thirdlight/project-model').ModelLodSettings | null;
  /** Model only: what of it counts as an occluder — auto (its `_OCC` nodes, else its opaque surfaces; stored as absence), occ or none. */
  occluder?: import('@thirdlight/project-model').ModelOccluderMode;
}

export interface SetTransformArgs {
  entityId: string;
  transform: PartialTransformArgs;
}

export interface DeleteEntityArgs {
  entityId: string;
  /**
   * More objects deleted with `entityId` (each with its subtree), in the same
   * transaction: one revision, one undo — a delete of a multi-selection.
   * Distinct, without `entityId`; a child named with its parent goes with it.
   */
  entityIds?: string[];
}

/**
 * `setTags`: the whole tag registry. An entry with `bit` keeps
 * that bit (a rename keeps the bit); an entry without one gets the lowest
 * free bit. A tag an entity still carries cannot be left out.
 */
export interface SetTagsArgs {
  tags: { bit?: number; name: string }[];
}

/**
 * `moveEntities`: any number of entities (one request's bytes), moved with their subtrees
 * under `parentId` (null = root), just before the sibling `beforeId` or
 * (absent/null) after the parent's last child. World transforms are kept.
 */
export interface MoveEntitiesArgs {
  entityIds: string[];
  parentId: string | null;
  beforeId?: string | null;
  /** Another scene to move them into (the host gives the command that scene as `otherScene`). */
  sceneId?: string;
}

/** undo/redo args: exactly the empty object (strictly enforced at runtime). */
export interface EmptyArgs {
  // intentionally empty — any field is rejected (field_unexpected)
}

/** One rigid animation role binding. */
export interface AnimationRoleBindingValue {
  clipIndex: number;
  clipName: string;
}

/** The three role keys, all required, in canonical order. */
export interface ModelAnimationRolesValue {
  idle: AnimationRoleBindingValue;
  run: AnimationRoleBindingValue;
  airborne: AnimationRoleBindingValue;
}

/**
 * The full `components.modelAnimation` component.
 * The binding is owned by that `(assetId, version)`: a `roles` value is only
 * valid against the clip list of the version it is recorded with, so the
 * atomic reimport moves `version` and `roles` together.
 */
export interface ModelAnimationComponentValue {
  assetId: string;
  version: number;
  roles: ModelAnimationRolesValue;
}

/** The version-local mapping moved with a reimport. */
export interface PublishAssetAnimation {
  entityId: string;
  roles: ModelAnimationRolesValue;
}

/** `publishAsset` args. */
export interface PublishAssetArgs {
  mode: 'create' | 'reimport';
  assetId: string;
  /** The kind discriminator: required on create; must match the record on reimport. */
  kind?: AssetKind;
  /** Display name; defaults to the assetId on create, unchanged on reimport. */
  displayName?: string;
  /** 64 lowercase hex; stage-free digest-addressed fact. */
  sourceDigest: string;
  sourceByteLength: number;
  /** A file referenced in place: its path relative to the game folder. */
  sourcePath?: string;
  /** The original a converted model was made from (FBX). */
  convertedFrom?: ConvertedFrom;
  /** A texture packed from texture assets (channel by channel, layer by layer). */
  packedFrom?: PackedFrom;
  importRecipe: ImportRecipe | ImportRecipeV3;
  metrics: AssetMetrics;
  /** A project-model timestamp; a prepared fact. */
  importedAt: string;
  /** Atomic version-local role mapping. */
  animation?: PublishAssetAnimation;
  /**
   * Model only: the "extract textures" import setting (true: on; false: off,
   * the extracted textures are forgotten; absent: a create leaves it off, a
   * reimport keeps the record's).
   */
  extractTextures?: boolean;
  /** Model only: the texture asset each image of this version was extracted into (absent: none). */
  textures?: Record<string, string>;
  /**
   * Model create only ("Bake to model"): the object whose clipped decal this
   * model was cut from. In the same change (one undo) the asset's material
   * map names the decal's material for the file's `<material>_decal`
   * material, and the object's `decal` component is replaced by a `model` of
   * this asset. Refused unless the object carries a clipped decal and no model.
   */
  bakeDecal?: { entityId: string };
}

/** `publishBehavior` args. */
export interface PublishBehaviorArgs {
  behaviorId: string;
  displayName: string;
  mode: 'declaration-create' | 'declaration-update' | 'source';
  declaration: PropertyDeclaration;
  /** Only with `mode: "source"`. */
  source?: { sourceDigest: string; sourceByteLength: number };
  /** Only with `mode: "declaration-create"` — the new behavior is a visual script with this graph. */
  graph?: GraphData;
}

/** `setBehaviorProperties` args. */
export interface SetBehaviorPropertiesArgs {
  entityId: string;
  /** `null` removes the component. */
  behaviorId: string | null;
  /** Partial map of declared keys; omitted keys take their declaration default. */
  values?: Record<string, PropertyValue>;
}

/** `setComponent` args. */
export interface SetComponentArgs {
  entityId: string;
  component: OwnedComponent;
  /** Non-empty partial object of that component's fields; `null` removes an
   *  add-capable component (the collider/controller pair and the six v3 ones) and is
   *  never a removal for `box`/`camera`/`model`. */
  value: Record<string, unknown> | null;
  /**
   * More objects that take the same `value` (each merged into its own
   * component, as `entityId`'s is), in the same transaction: one revision,
   * one undo — an edit of a multi-selection. Distinct, without `entityId`.
   */
  entityIds?: string[];
  /**
   * With `entityIds`: each further object's own partial value, in the same
   * order (absent: `value` for each) — a field edited on a multi-selection
   * whose other parts differ per object (one decal's width among sizes).
   */
  values?: Record<string, unknown>[];
}

/** `applySurfacePreset` args. */
export interface ApplySurfacePresetArgs {
  entityId: string;
  preset: SurfacePresetName;
}

/** `setSettings` args. */
export interface SetSettingsArgs {
  /** Non-empty partial map over the declared keys. */
  settings: SettingsMap;
}

/** `acknowledgeBehaviorTrust` args. */
export interface AcknowledgeBehaviorTrustArgs {
  sourceDigest: string;
}

/** `createPrefab` args. */
export interface CreatePrefabArgs {
  /** ID syntax; not already in `content.prefabs`. */
  prefabId: string;
  /** 1–128 chars, no control characters. */
  displayName: string;
  /** Existing entity ID in the current scene. */
  sourceEntityId: string;
}

/** `updatePrefab` args. */
export interface UpdatePrefabArgs {
  /** An existing prefab; its id stays. */
  prefabId: string;
  /** The object whose subtree becomes the prefab's contents (absent: the contents stay, and `displayName` renames it). */
  fromEntity?: string;
  /** A new name (absent: the prefab keeps its own). */
  displayName?: string;
}

/** One declared-property override at instantiation. */
export interface PropertyOverride {
  localId: string;
  key: string;
  value: PropertyValue;
}

/** `instantiatePrefab` args. */
export interface InstantiatePrefabArgs {
  /** Existing definition. */
  prefabId: string;
  /** Existing entity ID or `null` (default `null`). */
  parentId?: string | null;
  /** Partial transform applied to the instance root only. */
  transform?: PartialTransformArgs;
  /** ≤ 64 `{ localId, key, value }`; `(localId, key)` unique. */
  overrides?: readonly PropertyOverride[];
}

/** `setGraph` creates or replaces one standalone graph document (by graphId). */
export interface SetGraphArgs {
  graph: GraphDocument;
}

/** `deleteGraph` removes one standalone graph document. */
export interface DeleteGraphArgs {
  graphId: string;
}

/**
 * `setScriptLibrary` creates a library or patches one: `files`
 * lists the files to add or replace (`text: null` removes one; files not
 * mentioned are kept); `name` is required for a new library.
 */
export type SetScriptLibraryArgs = import('@thirdlight/project-model').ScriptLibraryPatch;

/** `deleteScriptLibrary` removes one (refused while a published behavior imports it). */
export interface DeleteScriptLibraryArgs {
  libraryId: string;
}

/**
 * `commitScriptLibraryStage` commits a staged set of library
 * edits (built from several patches held by the host, see
 * `ScriptLibraryStageFact`) as one change: one revision, one undo, the
 * dependents recompiled once against the committed set.
 */
export interface CommitScriptLibraryStageArgs {
  stageId: string;
}

/**
 * One staged edit set as the host holds it (never caller input
 * to the command): each library's whole staged value and the digest of the
 * stored library it was staged on (null: a new library). A library changed
 * since it was staged refuses the commit.
 */
export interface ScriptLibraryStageFact {
  readonly libraries: readonly { readonly libraryId: string; readonly base: string | null; readonly library: import('@thirdlight/project-model').ScriptLibrary }[];
}

/** `setUiDocument` creates or replaces one UI document (by uiDocumentId). */
export interface SetUiDocumentArgs {
  document: UiDocument;
}
/** `deleteUiDocument` removes one (refused while another document or flow.screens names it). */
export interface DeleteUiDocumentArgs {
  uiDocumentId: string;
}
/** `setUiTheme` creates or replaces one UI theme (by uiThemeId). */
export interface SetUiThemeArgs {
  theme: UiTheme;
}
/** `deleteUiTheme` removes one (refused while a document uses it). */
export interface DeleteUiThemeArgs {
  uiThemeId: string;
}
/** `setModes` replaces the game modes (the first is the start mode). */
export interface SetModesArgs {
  modes: GameMode[];
}
/** `setBehaviorGroups` replaces the behavior group names. */
export interface SetBehaviorGroupsArgs {
  groups: string[];
}
/** `setShell` replaces the game shell (null: none). */
export interface SetShellArgs {
  shell: import('@thirdlight/project-model').GameShell | null;
}
/** `setEventCues` replaces the event → cue table. */
export interface SetEventCuesArgs {
  cues: import('@thirdlight/project-model').EventCue[];
}

/** `setDialogue` creates or replaces one conversation (by dialogueId; absent graph = a new one's Start node, or the stored graph when renaming). */
export interface SetDialogueArgs {
  dialogue: { dialogueId: string; name: string; graph?: import('@thirdlight/project-model').GraphData };
}
/** `deleteDialogue` removes one (refused while a Jump names it). */
export interface DeleteDialogueArgs {
  dialogueId: string;
}
/** `setSpeaker` creates or replaces one speaker (by speakerId). */
export interface SetSpeakerArgs {
  speaker: import('@thirdlight/project-model').DialogueSpeaker;
}
/** `deleteSpeaker` removes one (refused while a line names it). */
export interface DeleteSpeakerArgs {
  speakerId: string;
}
/** `setDialogueSettings` replaces the dialogue settings (null = the defaults). */
export interface SetDialogueSettingsArgs {
  settings: import('@thirdlight/project-model').DialogueSettings | null;
}

/** `setTimeline` creates or replaces one timeline (by timelineId). */
export interface SetTimelineArgs {
  timeline: TimelineAsset;
}
/** `deleteTimeline` removes one timeline. */
export interface DeleteTimelineArgs {
  timelineId: string;
}

/** `deleteAsset` removes one asset record (refused while anything references it; its stored bytes stay). */
export interface DeleteAssetArgs {
  assetId: string;
}
/** `deletePrefab` removes one prefab definition (refused while a copy or anything else references it). */
export interface DeletePrefabArgs {
  prefabId: string;
}
/**
 * `createEntities` creates several entities in one transaction
 * (one revision, one undo). Each item is a `createEntity` request's args
 * without `children`; `ref` (unique in the batch) lets a later item name an
 * earlier one as its `parentId`.
 */
export interface CreateEntitiesArgs {
  entities: (CreateEntityArgs & { ref?: string })[];
}

/** `setEffect` creates or replaces one effect (by effectId). */
export interface SetEffectArgs {
  effect: EffectDef;
}

/** `deleteEffect` removes one effect. */
export interface DeleteEffectArgs {
  effectId: string;
}

/** `renameEffect` changes one effect's name. */
export interface RenameEffectArgs {
  effectId: string;
  name: string;
}

/** `editBlocks` — bulk edits of one block layer (`entityId`) as one undo step. */
export interface EditBlocksArgs {
  entityId: string;
  edits: import('@thirdlight/project-model').BlockEdit[];
}
/** `setBlockType` creates or replaces one block type. */
export interface SetBlockTypeArgs {
  block: import('@thirdlight/project-model').BlockType;
}
export interface DeleteBlockTypeArgs {
  blockId: string;
}
/** `setCellFields` replaces the cell metadata schema. */
export interface SetCellFieldsArgs {
  fields: import('@thirdlight/project-model').CellField[];
}
/** `setBlockStamp` stores a stamp, or saves a layer selection (`entityId` + `box`) as one. */
export interface SetBlockStampArgs {
  stamp?: import('@thirdlight/project-model').BlockStamp;
  stampId?: string;
  name?: string;
  entityId?: string;
  box?: number[];
}
export interface DeleteBlockStampArgs {
  stampId: string;
}

export type MutationArgs =
  | SetTimelineArgs
  | DeleteTimelineArgs
  | EditBlocksArgs
  | SetBlockTypeArgs
  | DeleteBlockTypeArgs
  | SetCellFieldsArgs
  | SetBlockStampArgs
  | DeleteBlockStampArgs
  | SetUiDocumentArgs
  | DeleteUiDocumentArgs
  | SetUiThemeArgs
  | DeleteUiThemeArgs
  | SetDialogueArgs
  | DeleteDialogueArgs
  | SetSpeakerArgs
  | DeleteSpeakerArgs
  | SetDialogueSettingsArgs
  | SetModesArgs
  | SetBehaviorGroupsArgs
  | SetEventCuesArgs
  | SetShellArgs
  | SetScriptLibraryArgs
  | DeleteScriptLibraryArgs
  | CommitScriptLibraryStageArgs
  | SetEffectArgs
  | DeleteEffectArgs
  | RenameEffectArgs
  | GraphEditArgs
  | SetGraphArgs
  | DeleteGraphArgs
  | SceneIndexArgs
  | SetTagsArgs
  | UpdateEntityArgs
  | MoveEntitiesArgs
  | CreateEntityArgs
  | CreateEntitiesArgs
  | DeleteAssetArgs
  | DeletePrefabArgs
  | ImportAssetsArgs
  | SetLabelsArgs
  | SetAddressArgs
  | ImportResourcesArgs
  | SetTransformArgs
  | DeleteEntityArgs
  | EmptyArgs
  | PublishAssetArgs
  | PublishBehaviorArgs
  | SetBehaviorPropertiesArgs
  | SetComponentArgs
  | SetSettingsArgs
  | AcknowledgeBehaviorTrustArgs
  | CreatePrefabArgs
  | InstantiatePrefabArgs
  | ApplySurfacePresetArgs;

/**
 * The mutation request envelope. This type documents the wire
 * shape; `applyMutation` accepts `unknown` and validates strictly.
 */
export interface MutationRequest {
  op: MutationOp;
  projectId: string;
  expectedRevision: number;
  /** `req-` + 32 lowercase hex chars (client-generated CSPRNG). */
  requestId: string;
  origin?: Origin;
  args: MutationArgs;
}

// ---- results ----------------------------------------------------------

/** Mutation success; canonical key order in emitted payloads. */
export interface MutationSuccess {
  ok: true;
  // Content ops use the same success payload.
  op: MutationOp;
  projectId: string;
  requestId: string;
  /** expectedRevision + 1 (every successful mutation advances by exactly 1). */
  revision: number;
  /** Always `false` from the pure layer; workspace replays set `true`. */
  duplicated: false;
  /** createEntity only. */
  createdId?: string;
  /** v4 projects: the scene the command edited (absent for scene-index changes). */
  sceneId?: string;
  change: ChangeData;
  /** undo/redo only: the requestId of the original forward command. */
  appliedOf?: string;
  /** undo/redo only: the origin of that original command (or null). */
  originOfApplied?: Origin | null;
  /** editTerrain only: the tiles it wrote and added ([x, z]), the samples (hole cells) it changed, the heights it clamped to the range. */
  terrain?: { tiles: [number, number][]; added: [number, number][]; changed: number; clamped?: number };
  history: HistoryDepths;
}

/**
 * Mutation failure. `op`/`projectId`/`requestId` are echoed only
 * when parseable (strings; `op` capped at 32 chars, `requestId` at 64).
 */
export interface MutationFailure {
  ok: false;
  op?: string;
  projectId?: string;
  requestId?: string;
  error: CommandError;
}

export type MutationResult = MutationSuccess | MutationFailure;

/**
 * Outcome of `applyMutation`: on success the NEW state (the input state is
 * never mutated); on failure the input state is left unchanged and no new
 * state is returned.
 */
export type ApplyOutcome<S extends SceneDocument = SceneDocument> =
  | { ok: true; result: MutationSuccess; state: CommandState<S> }
  | { ok: false; result: MutationFailure };
// ---- content queries (their own module) -----------
export type { AssetSummary, BehaviorQueryEntry, BehaviorSummary, PrefabSummary, PrefabQueryEntry, QueryResult, ContentCounts, GameConfigQueryResult, EntitiesQueryResult } from './types-queries';
