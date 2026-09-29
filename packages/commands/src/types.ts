/**
 * Public types.
 *
 * These are the command-layer wire shapes: the mutation request envelope,
 * the mutation success/failure results, the structured
 * error model, the change data, the inverse specs and the
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
  AssetRecord,
  AssetVersion,
  ConvertedFrom,
  PackedFrom,
  BehaviorComponent,
  BehaviorRecord,
  BehaviorTrust,
  ContentCatalog,
  EntityV3,
  TagDefinition,
  SceneIndexEntry,
  ImportRecipe,
  ImportRecipeV3,
  LimitName,
  Manifest,
  ModelError,
  PrefabDefinition,
  PropertyDeclaration,
  PropertyValue,
  SceneV3,
  SettingsMap,
  TransformComponent,
  TrustEntry,
  SceneV4,
  EnvironmentConfig,
  LightingBake,
  AnimatorController,
  InputConfig,
  MaterialDef,
  EffectDef,
  GraphData,
  GraphDocument,
  GraphOp,
  UiDocument,
  UiTheme,
  GameMode,
  TimelineAsset,
} from '@thirdlight/project-model';
import type { EntityHeader, EntityHeaderField, PartialTransformArgs, BoxArgs, ModelArgs, CreateEntityArgs, UpdateEntityArgs } from './entity-types';

export type { EntityHeader, EntityHeaderField, PartialTransformArgs, BoxArgs, ModelArgs, CreateEntityArgs, UpdateEntityArgs } from './entity-types';

// ---- ops and origins --------------------------------------------------------

/** The five entity/history mutation ops. Queries are workspace-served. */
export type M1MutationOp =
  | 'createEntity'
  | 'setTransform'
  | 'deleteEntity'
  | 'undo'
  | 'redo';

/**
 * The non-prefab content/property mutation ops. Prefab ops (`createPrefab`,
 * `instantiatePrefab`) are listed separately.
 */
export type ContentMutationOp =
  | 'publishAsset'
  | 'publishBehavior'
  | 'setBehaviorProperties'
  | 'setComponent'
  | 'setSettings'
  | 'acknowledgeBehaviorTrust';

/**
 * The prefab mutation ops.
 * `createPrefab` captures an immutable definition; `instantiatePrefab`
 * materializes independent copies in ONE transaction.
 */
export type PrefabMutationOp = 'createPrefab' | 'instantiatePrefab';

/**
 * The v3 presentation mutation ops:
 * `applySurfacePreset` copies a preset row.
 */
export type V3MutationOp =
  | 'applySurfacePreset'
  | 'updateEntity'
  | 'moveEntities'
  | 'setTags'
  | 'setAssetOptions'
  | 'pasteEntities'
  | 'setMaterial'
  | 'deleteMaterial'
  | 'setEnvironment'
  | 'setLighting'
  | 'setAnimator'
  | 'deleteAnimator'
  | 'setInput'
  // Named collision layers (3D physics)
  | 'setCollisionLayers'
  // The project save schema
  | 'setSaveSchema'
  // the scene index of a v4 project
  | 'createScene'
  | 'renameScene'
  | 'deleteScene'
  | 'setStartScenes'
  // Graphs (standalone graph documents and the generic graph edit)
  | 'setGraph'
  | 'deleteGraph'
  | 'graphEdit'
  // Visual effects
  | 'setEffect'
  | 'deleteEffect'
  | 'renameEffect'
  // Shared script libraries
  | 'setScriptLibrary'
  | 'deleteScriptLibrary'
  // Staged library edits (several patches, one commit)
  | 'commitScriptLibraryStage'
  // Block layers
  | 'editBlocks'
  | 'setBlockType'
  | 'deleteBlockType'
  | 'setCellFields'
  | 'setBlockStamp'
  | 'deleteBlockStamp'
  // Project UI documents and themes
  | 'setUiDocument'
  | 'deleteUiDocument'
  | 'setUiTheme'
  | 'deleteUiTheme'
  // Dialogue (conversations, speakers, settings)
  | 'setDialogue'
  | 'deleteDialogue'
  | 'setSpeaker'
  | 'deleteSpeaker'
  | 'setDialogueSettings'
  // Game modes and behavior groups
  | 'setModes'
  | 'setBehaviorGroups'
  // The event → cue table
  | 'setEventCues'
  // The game shell
  | 'setShell'
  | 'deleteUiTheme'
  // timelines
  | 'setTimeline'
  | 'deleteTimeline'
  // Remove an asset record / a prefab definition (refused while anything references it)
  | 'deleteAsset'
  | 'deletePrefab'
  // Many entities in one transaction (one revision, one undo)
  | 'createEntities';

/** Every implemented mutation op. */
export type MutationOp = M1MutationOp | ContentMutationOp | PrefabMutationOp | V3MutationOp;

/**
 * The forward ops that create history entries (undo/redo never do).
 * Every content/prefab mutation op is forward; its inverse is recorded in the
 * entry.
 */
export type ForwardOp =
  | 'createEntity'
  | 'setTransform'
  | 'deleteEntity'
  | ContentMutationOp
  | PrefabMutationOp
  | V3MutationOp;

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
  detailDocument?: 'result-scene';
  details?: readonly ModelError[];
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

// ---- change data --------------------------------------------------------

/** `position`/`rotation`/`scale` in canonical order. */
export type ChangedField = 'position' | 'rotation' | 'scale';

/**
 * The six v3 add-capable components.
 * `playerSpawn` is a field-less marker; the rest are partial-replaceable.
 */
export type V3OwnedComponent =
  | 'playerSpawn'
  | 'light'
  | 'surface'
  | 'modelAnimation'
  /** v4 scenes only: an instance set. */
  | 'instances'
  /** v4 scenes only: the object's material mapping. */
  | 'materials'
  /** v4 scenes only: a fog volume. */
  | 'fogVolume'
  /** v4 scenes only: a grid of blocks. */
  | 'blockLayer'
  /** v4 scenes only: the metadata a prop writes into the block cells beneath it. */
  | 'blockFootprint'
  /** v4 scenes only: an animator controller on a model. */
  | 'animator'
  /** v4 scenes only: gameplay building blocks. */
  | 'mover'
  | 'trigger'
  | 'switch'
  | 'health'
  | 'audioSource'
  | 'faceMovement'
  /** v4 scenes only: overrides of graph-material parameters. */
  | 'materialParams'
  /** v4 scenes only: a visual effect played from the entity. */
  | 'effect'
  /** v4 scenes only: a virtual camera shot and a camera path. */
  | 'virtualCamera'
  | 'cameraPath'
  /** v4 scenes only: rides on a node of another entity's model. */
  | 'socketAttach'
  /** v4 scenes only: the behavior group the entity's behavior belongs to. */
  | 'behaviorGroup'
  /** v4 scenes only: generic primitives. */
  | 'collectible'
  | 'patrol'
  | 'hitbox'
  /** v4 scenes only: a climb volume and a gravity body. */
  | 'climbVolume'
  | 'gravity'
  /** v4 scenes only: a camera region. */
  | 'cameraRegion';

/** Every `setComponent`-owned component (the base five plus the six v3 ones). */
export type OwnedComponent =
  | 'box'
  | 'camera'
  | 'model'
  | 'collider'
  | 'controller'
  | V3OwnedComponent;

/** The three built-in surface-preset names. */
export type SurfacePresetName = 'matte-ground' | 'signal-red' | 'emissive-accent';

/**
 * The command layer's asset-version value: the v2 record with the v3
 * `pcm-wav` recipe shape permitted (the WAV profile itself is checked by
 * the model's audio rules).
 */
export type CommandAssetVersion = Omit<AssetVersion, 'importRecipe'> & {
  importRecipe: ImportRecipe | ImportRecipeV3;
};

/**
 * The command layer's asset record: the v2 record widened to the v3 `kind`
 * discriminator (`model` | `audio`). A v2 record and a
 * v3 record are both assignable to it, so one command state carries either.
 */
export type CommandAssetRecord = Omit<AssetRecord, 'kind' | 'versions'> & {
  kind: AssetKind;
  versions: CommandAssetVersion[];
  /** Model only: `tint` = COLOR_0 multiplies the albedo (absent = shader data). */
  vertexColors?: 'tint';
};

/**
 * The command layer's per-project content block: the accepted v2
 * {@link ContentCatalog} plus the optional v3 `game` key. The v3 envelope's
 * content block always carries `game` (possibly `null`); its absence is how
 * `serializeCanonical` distinguishes the v2 catalog. Both directions are assignable, so the workspace's v2 state
 * and a v3 state share this one type.
 *
 * The v3 `AssetRecord.kind` discriminator and the `pcm-wav` recipe shape are
 * carried by {@link CommandAssetRecord}/{@link CommandAssetVersion}; the v3
 * ops view `assets` through those types (`assetsOf`), so audio records are
 * typed end to end without changing the accepted v2 catalog shape.
 */
export interface ContentDocument extends ContentCatalog {
  /** The game block key (always null when present; the engine has no game block). */
  game?: null;
  /** The project tag registry (ascending bit; absent = none). */
  tags?: TagDefinition[];
}

/** The scene index (`content.scenes` + `content.startScenes`) before and after. */
export interface SetSceneIndexChange {
  type: 'setSceneIndex';
  previous: { scenes: SceneIndexEntry[]; startScenes: string[] };
  next: { scenes: SceneIndexEntry[]; startScenes: string[] };
}

/** The args of the four scene-index ops, tagged with the op. */
export type SceneIndexArgs =
  | { op: 'createScene'; sceneId?: string; name: string }
  | { op: 'renameScene'; sceneId: string; name: string }
  | { op: 'deleteScene'; sceneId: string }
  | { op: 'setStartScenes'; sceneIds: string[] };

/** `setMaterial`/`deleteMaterial` change data: the whole materials list before and after. */
export interface SetMaterialsChange {
  type: 'setMaterials';
  previous: MaterialDef[];
  next: MaterialDef[];
}

/** `setEnvironment` change data (null = no environment block). */
export interface SetEnvironmentChange {
  type: 'setEnvironment';
  previous: EnvironmentConfig | null;
  next: EnvironmentConfig | null;
}

/** `setAnimator`/`deleteAnimator` change data (the whole list before and after). */
export interface SetAnimatorsChange {
  type: 'setAnimators';
  previous: AnimatorController[];
  next: AnimatorController[];
}

/**
 * The graph a `graphEdit` addresses — an owner kind (where the
 * graph is stored) and the owning document's id. Owner kinds: `graph` (a
 * standalone document in `content.graphs`); later phases add animator
 * controllers, materials, behaviors and effects.
 */
export interface GraphOwner {
  kind: string;
  id: string;
}

/** `graphEdit` args: graph ops applied atomically to one owner's graph (one undo step). */
export interface GraphEditArgs {
  owner: GraphOwner;
  ops: GraphOp[];
}

/** `graphEdit` change data: the ops applied (an undo carries the inverse ops). */
export interface GraphEditChange {
  type: 'graphEdit';
  owner: GraphOwner;
  ops: GraphOp[];
}

/** Undo of a `graphEdit`: the inverse ops, in order. */
export interface GraphEditInverse {
  kind: 'graphEdit';
  owner: GraphOwner;
  ops: GraphOp[];
}

/** `setGraph`/`deleteGraph` change data: one standalone graph document before and after (null = none). */
export interface SetGraphChange {
  type: 'setGraph';
  graphId: string;
  previous: GraphDocument | null;
  next: GraphDocument | null;
}

/** `setEffect`/`deleteEffect`/`renameEffect` change data: one effect before and after (null = none). */
export interface SetEffectChange {
  type: 'setEffect';
  effectId: string;
  previous: EffectDef | null;
  next: EffectDef | null;
}

/**
 * `setScriptLibrary`/`deleteScriptLibrary` change data: the library
 * before and after (null = none) and the published behaviors recompiled
 * against it in the same command (their records before and after).
 */
export interface SetScriptLibraryChange {
  type: 'setScriptLibrary';
  libraryId: string;
  previous: import('@thirdlight/project-model').ScriptLibrary | null;
  next: import('@thirdlight/project-model').ScriptLibrary | null;
  behaviors: { behaviorId: string; previous: BehaviorRecord; next: BehaviorRecord }[];
}

/**
 * `commitScriptLibraryStage` change data: every staged library
 * before and after (null = none) and the published behaviors recompiled
 * against the committed set (once each, whatever the number of patches).
 */
export interface SetScriptLibrariesChange {
  type: 'setScriptLibraries';
  libraries: { libraryId: string; previous: import('@thirdlight/project-model').ScriptLibrary | null; next: import('@thirdlight/project-model').ScriptLibrary | null }[];
  behaviors: { behaviorId: string; previous: BehaviorRecord; next: BehaviorRecord }[];
}

/**
 * `editBlocks` change data — the layer, the chunks [cx, cz] and
 * regions whose contents changed, and how many cells changed. Compact on
 * purpose (a large fill stays small in events and retry records); clients
 * read the chunks back with `queryBlocks`.
 */
export interface EditBlocksChange {
  type: 'editBlocks';
  entityId: string;
  chunks: [number, number][];
  regions: string[];
  cells: number;
}

/** undo/redo of `editBlocks` — the layer's whole entry before and after (null = none). */
export interface EditBlocksInverse {
  kind: 'editBlocks';
  entityId: string;
  restore: import('@thirdlight/project-model').BlockLayerData | null;
  next: import('@thirdlight/project-model').BlockLayerData | null;
}

/** `setBlockType`/`deleteBlockType` change data. */
export interface SetBlockTypeChange {
  type: 'setBlockType';
  blockId: string;
  previous: import('@thirdlight/project-model').BlockType | null;
  next: import('@thirdlight/project-model').BlockType | null;
}
export interface SetBlockTypeInverse {
  kind: 'setBlockType';
  blockId: string;
  restore: import('@thirdlight/project-model').BlockType | null;
}

/** `setCellFields` change data (the whole schema before and after). */
export interface SetCellFieldsChange {
  type: 'setCellFields';
  previous: import('@thirdlight/project-model').CellField[];
  next: import('@thirdlight/project-model').CellField[];
}
export interface SetCellFieldsInverse {
  kind: 'setCellFields';
  restore: import('@thirdlight/project-model').CellField[];
}

/** `setBlockStamp`/`deleteBlockStamp` change data. */
export interface SetBlockStampChange {
  type: 'setBlockStamp';
  stampId: string;
  previous: import('@thirdlight/project-model').BlockStamp | null;
  next: import('@thirdlight/project-model').BlockStamp | null;
}
export interface SetBlockStampInverse {
  kind: 'setBlockStamp';
  stampId: string;
  restore: import('@thirdlight/project-model').BlockStamp | null;
}

/** Undo of a library op: restore the library and its dependents' records. */
export interface SetScriptLibraryInverse {
  kind: 'setScriptLibrary';
  libraryId: string;
  restore: import('@thirdlight/project-model').ScriptLibrary | null;
  behaviors: { behaviorId: string; restore: BehaviorRecord }[];
}

/** Undo of a staged commit: restore every library and the dependents' records. */
export interface SetScriptLibrariesInverse {
  kind: 'setScriptLibraries';
  libraries: { libraryId: string; restore: import('@thirdlight/project-model').ScriptLibrary | null }[];
  behaviors: { behaviorId: string; restore: BehaviorRecord }[];
}

/**
 * `setUiDocument`/`deleteUiDocument`/`setUiTheme`/`deleteUiTheme`
 * change data: one document or theme before and after (null = none).
 */
export interface SetUiChange {
  type: 'setUi';
  uiKind: 'document' | 'theme';
  id: string;
  previous: UiDocument | UiTheme | null;
  next: UiDocument | UiTheme | null;
}

/** `setModes` change data (the whole list; empty = no modes). */
export interface SetModesChange {
  type: 'setModes';
  previous: GameMode[];
  next: GameMode[];
}
/** Undo of `setModes`: restore the previous list. */
export interface SetModesInverse {
  kind: 'setModes';
  restore: GameMode[];
}
/** `setBehaviorGroups` change data (the whole list). */
export interface SetBehaviorGroupsChange {
  type: 'setBehaviorGroups';
  previous: string[];
  next: string[];
}
/** Undo of `setBehaviorGroups`: restore the previous list. */
export interface SetBehaviorGroupsInverse {
  kind: 'setBehaviorGroups';
  restore: string[];
}
/** `setEventCues` change data (the whole table). */
export interface SetEventCuesChange {
  type: 'setEventCues';
  previous: import('@thirdlight/project-model').EventCue[];
  next: import('@thirdlight/project-model').EventCue[];
}
/** `setShell` change data (null = no shell). */
export interface SetShellChange {
  type: 'setShell';
  previous: import('@thirdlight/project-model').GameShell | null;
  next: import('@thirdlight/project-model').GameShell | null;
}
/** Undo of `setShell`: restore the previous shell (null = none). */
export interface SetShellInverse {
  kind: 'setShell';
  restore: import('@thirdlight/project-model').GameShell | null;
}
/** Undo of `setEventCues`: restore the previous table. */
export interface SetEventCuesInverse {
  kind: 'setEventCues';
  restore: import('@thirdlight/project-model').EventCue[];
}


/** `setTimeline`/`deleteTimeline` change data: one timeline before and after (null = none). */
export interface SetTimelineChange {
  type: 'setTimeline';
  timelineId: string;
  previous: TimelineAsset | null;
  next: TimelineAsset | null;
}

/** Undo of a timeline op: restore the previous timeline (null = remove it). */
export interface SetTimelineInverse {
  kind: 'setTimeline';
  timelineId: string;
  restore: TimelineAsset | null;
}

/** Undo of a UI op: restore the previous document or theme (null = remove it). */
export interface SetUiInverse {
  kind: 'setUi';
  uiKind: 'document' | 'theme';
  id: string;
  restore: UiDocument | UiTheme | null;
}

/** What a dialogue op changes: one conversation, one speaker, or the dialogue settings (id ''). */
export type DialogueKind = 'dialogue' | 'speaker' | 'settings';
type DialogueValueOf = import('@thirdlight/project-model').DialogueDocument | import('@thirdlight/project-model').DialogueSpeaker | import('@thirdlight/project-model').DialogueSettings;

/**
 * `setDialogue`/`deleteDialogue`/`setSpeaker`/`deleteSpeaker`/
 * `setDialogueSettings` change data: the value before and after (null = none).
 */
export interface SetDialogueChange {
  type: 'setDialogue';
  dialogueKind: DialogueKind;
  id: string;
  previous: DialogueValueOf | null;
  next: DialogueValueOf | null;
}

/** Undo of a dialogue op: restore the previous value (null = remove it). */
export interface SetDialogueInverse {
  kind: 'setDialogue';
  dialogueKind: DialogueKind;
  id: string;
  restore: DialogueValueOf | null;
}

/** Undo of an effect op: restore the previous effect (null = remove it). */
export interface SetEffectInverse {
  kind: 'setEffect';
  effectId: string;
  restore: EffectDef | null;
}

/** Undo of `setGraph`/`deleteGraph`: restore the previous document (null = remove it). */
export interface SetGraphInverse {
  kind: 'setGraph';
  graphId: string;
  restore: GraphDocument | null;
}


/** `setCollisionLayers` change data (the whole list; empty = only "default"). */
export interface SetCollisionLayersChange {
  type: 'setCollisionLayers';
  previous: string[];
  next: string[];
}

/** `setSaveSchema` change data (the whole schema; null = no project saves). */
export interface SetSaveSchemaChange {
  type: 'setSaveSchema';
  previous: import('@thirdlight/project-model').SaveSchema | null;
  next: import('@thirdlight/project-model').SaveSchema | null;
}

/** `setInput` change data (null = the defaults). */
export interface SetInputChange {
  type: 'setInput';
  previous: InputConfig | null;
  next: InputConfig | null;
}

/** `setLighting` change data — one scene's bake (null = none). */
export interface SetLightingChange {
  type: 'setLighting';
  sceneId: string;
  previous: LightingBake | null;
  next: LightingBake | null;
}

/** `pasteEntities` change data: the created entities, parents first. */
export interface PasteEntitiesChange {
  type: 'pasteEntities';
  entities: EntityV3[];
}

/**
 * `deleteAsset` change data: the removed record (the undo puts it
 * back as a `publishAsset` change with `previous: null`).
 */
export interface RemoveAssetChange {
  type: 'removeAsset';
  assetId: string;
  previous: CommandAssetRecord;
}

/** `setAssetOptions` change data: the whole asset record before and after. */
export interface SetAssetOptionsChange {
  type: 'setAssetOptions';
  assetId: string;
  previous: CommandAssetRecord;
  next: CommandAssetRecord;
}

/** `setTags` change data: the whole registry before and after. */
export interface SetTagsChange {
  type: 'setTags';
  previous: TagDefinition[];
  next: TagDefinition[];
}

/** `publishAsset` change data. */
export interface PublishAssetChange {
  type: 'publishAsset';
  mode: 'create' | 'reimport';
  assetId: string;
  /** Full asset records in the direction applied; `null` = absent. */
  previous: CommandAssetRecord | null;
  next: CommandAssetRecord | null;
  /**
   * `publishAsset{animation}` only: the entity's full
   * `modelAnimation` component (assetId, version, roles) moved atomically
   * with the record — on reimport `version` advances to the newly appended
   * version and `roles` is replaced with the submitted mapping. Full
   * components (not roles only) so the inverse restores the previous version
   * binding exactly and the recorded-value rule re-applies it.
   */
  animation?: { entityId: string; previous: ModelAnimationComponentValue; next: ModelAnimationComponentValue };
}

/** `publishBehavior` change data. */
export interface PublishBehaviorChange {
  type: 'publishBehavior';
  behaviorId: string;
  /** Full behavior records in the direction applied; `null` = absent. */
  previous: BehaviorRecord | null;
  next: BehaviorRecord | null;
}

/** `setBehaviorProperties` change data. */
export interface SetBehaviorPropertiesChange {
  type: 'setBehaviorProperties';
  id: string;
  /** Full component values; `null` = absent (removal). */
  previous: BehaviorComponent | null;
  next: BehaviorComponent | null;
  /** Declaration order. */
  changedKeys: readonly string[];
}

/** `setComponent` change data. */
export interface SetComponentChange {
  type: 'setComponent';
  id: string;
  component: OwnedComponent;
  /** Full component values (canonical shape); `null` = absent in that direction. */
  previous: unknown | null;
  next: unknown | null;
  /** Canonical field order for the component. */
  changedFields: readonly string[];
}

/** `applySurfacePreset` change data. */
export interface ApplySurfacePresetChange {
  type: 'applySurfacePreset';
  id: string;
  preset: SurfacePresetName;
  /** Full `surface` values; `previous: null` when the component was absent. */
  previous: unknown | null;
  next: unknown | null;
  /** Surface canonical field order (all five names). */
  changedFields: readonly string[];
}


/** `setSettings` change data. */
export interface SetSettingsChange {
  type: 'setSettings';
  /** Full maps. */
  previous: SettingsMap;
  next: SettingsMap;
  /** Ascending key codepoint order. */
  changedKeys: readonly string[];
}

/** `acknowledgeBehaviorTrust` change data. */
export interface AcknowledgeBehaviorTrustChange {
  type: 'acknowledgeBehaviorTrust';
  sourceDigest: string;
  /** Full `behaviorTrust` entry arrays before/after. */
  previous: readonly TrustEntry[];
  next: readonly TrustEntry[];
}

/** `createPrefab` change data. */
export interface CreatePrefabChange {
  type: 'createPrefab';
  prefabId: string;
  /** The full definition value (immutable; redo re-inserts it verbatim). */
  definition: PrefabDefinition;
}

/** Undo of a `createPrefab` (never a forward operation). */
export interface RemovePrefabChange {
  type: 'removePrefab';
  prefabId: string;
}

/** One created entity of an instantiation, at its insertion index. */
export interface InstantiatePrefabEntry {
  /** The pre-insertion `entities` length plus this entry's document-order offset. */
  index: number;
  /** The full created entity value (canonical). */
  entity: EntityV3;
}

/** `instantiatePrefab` change data. */
export interface InstantiatePrefabChange {
  type: 'instantiatePrefab';
  prefabId: string;
  /** The first allocated ID (the instance root). */
  rootId: string;
  /** Ascending insertion index, definition document order. */
  entries: readonly InstantiatePrefabEntry[];
  /** The exact `localId` → `entityId` map, definition document order. */
  mapping: readonly { localId: string; entityId: string }[];
}

export interface CreateEntityChange {
  type: 'createEntity';
  id: string;
  /** The full created entity value (canonical, defaults filled). */
  entity: EntityV3;
  /** A folder created with children: the children, in insertion order after `entity`. */
  children?: EntityV3[];
}

export interface SetTransformChange {
  type: 'setTransform';
  id: string;
  /** Full transforms (all three fields), in the direction actually applied. */
  previous: TransformComponent;
  next: TransformComponent;
  /** Replaced field names, order position, rotation, scale. */
  changedFields: readonly ChangedField[];
}


/**
 * `updateEntity`: rename, reparent and/or set the hierarchy flags. When a
 * reparent has to move the entity's subtree after its new parent
 * (parent-before-child order), `order` carries the full entity-id order
 * before and after; otherwise it is null. A reparent keeps the entity's
 * world transform: when that changes its local transform, `transform`
 * carries both (absent otherwise, and in older records).
 */
export interface UpdateEntityChange {
  type: 'updateEntity';
  id: string;
  previous: EntityHeader;
  next: EntityHeader;
  changedFields: readonly EntityHeaderField[];
  order: { previous: readonly string[]; next: readonly string[] } | null;
  transform?: { previous: TransformComponent; next: TransformComponent };
}

/** One entity `moveEntities` moved: its parent and local transform before and after (null transform: a folder). */
export interface MovedEntity {
  id: string;
  previous: { parentId: string | null; transform: TransformComponent | null };
  next: { parentId: string | null; transform: TransformComponent | null };
}

/**
 * `moveEntities`: file one or more entities (with their subtrees)
 * under a parent, before a sibling or at the end, keeping world transforms.
 * `order` is the full entity-id order before and after.
 */
export interface MoveEntitiesChange {
  type: 'moveEntities';
  parentId: string | null;
  beforeId: string | null;
  entities: readonly MovedEntity[];
  order: { previous: readonly string[]; next: readonly string[] };
}

export interface DeleteEntityChange {
  type: 'deleteEntity';
  rootId: string;
  /** Full subtree closure in pre-deletion array order. */
  deletedIds: readonly string[];
}

export interface RestoreSubtreeChange {
  type: 'restoreSubtree';
  rootId: string;
  /** Restored entity values in pre-deletion array order, root first. */
  entities: readonly EntityV3[];
}

/** Structured change data. A client projection updates from this alone. */
export type ChangeData =
  | CreateEntityChange
  | SetTransformChange
  | DeleteEntityChange
  | RestoreSubtreeChange
  | PublishAssetChange
  | PublishBehaviorChange
  | SetBehaviorPropertiesChange
  | SetComponentChange
  | SetSettingsChange
  | AcknowledgeBehaviorTrustChange
  | CreatePrefabChange
  | RemovePrefabChange
  | RemoveAssetChange
  | InstantiatePrefabChange
  | ApplySurfacePresetChange
  | UpdateEntityChange
  | MoveEntitiesChange
  | SetTagsChange
  | SetAssetOptionsChange
  | PasteEntitiesChange
  | SetMaterialsChange
  | SetEnvironmentChange
  | SetLightingChange
  | SetAnimatorsChange
  | SetInputChange
  | SetCollisionLayersChange
  | SetSaveSchemaChange
  | SetSceneIndexChange
  | GraphEditChange
  | SetGraphChange
  | SetEffectChange
  | SetScriptLibraryChange
  | SetScriptLibrariesChange
  | EditBlocksChange
  | SetBlockTypeChange
  | SetCellFieldsChange
  | SetBlockStampChange
  | SetUiChange
  | SetDialogueChange
  | SetModesChange
  | SetBehaviorGroupsChange
  | SetEventCuesChange
  | SetShellChange
  | SetUiChange
  | SetTimelineChange;

/** The change types a forward (non-undo/redo) command can produce. */
export type ForwardChange =
  | CreateEntityChange
  | SetTransformChange
  | DeleteEntityChange
  | PublishAssetChange
  | PublishBehaviorChange
  | SetBehaviorPropertiesChange
  | SetComponentChange
  | SetSettingsChange
  | AcknowledgeBehaviorTrustChange
  | CreatePrefabChange
  | RemovePrefabChange
  | RemoveAssetChange
  | InstantiatePrefabChange
  | ApplySurfacePresetChange
  | UpdateEntityChange
  | MoveEntitiesChange
  | SetTagsChange
  | SetAssetOptionsChange
  | PasteEntitiesChange
  | SetMaterialsChange
  | SetEnvironmentChange
  | SetLightingChange
  | SetAnimatorsChange
  | SetInputChange
  | SetCollisionLayersChange
  | SetSaveSchemaChange
  | SetSceneIndexChange
  | GraphEditChange
  | SetGraphChange
  | SetEffectChange
  | SetScriptLibraryChange
  | SetScriptLibrariesChange
  | EditBlocksChange
  | SetBlockTypeChange
  | SetCellFieldsChange
  | SetBlockStampChange
  | SetUiChange
  | SetDialogueChange
  | SetModesChange
  | SetBehaviorGroupsChange
  | SetEventCuesChange
  | SetShellChange
  | SetUiChange
  | SetTimelineChange;

// ---- inverse specs --------------------------------------------------------

export interface DeleteInverse {
  kind: 'delete';
  rootId: string;
}

export interface SetTransformInverse {
  kind: 'setTransform';
  id: string;
  /** The full previous transform (all three fields). */
  restore: TransformComponent;
}

export interface RestoreSubtreeEntry {
  /** The entity's pre-deletion array index. */
  index: number;
  /** The full entity value. */
  entity: EntityV3;
}

export interface RestoreSubtreeInverse {
  kind: 'restoreSubtree';
  /** Pre-deletion array order (ascending index); root first. */
  entries: readonly RestoreSubtreeEntry[];
  /** The root's parent (or null); the parent always survives subtree deletion. */
  restoredParentId: string | null;
  /** The deleted block layers' cells and regions (absent: none). */
  blocks?: import('@thirdlight/project-model').BlockLayerData[];
}

/** `publishAsset` inverse: restore the previous record (or remove it). */
export interface PublishAssetInverse {
  kind: 'publishAsset';
  assetId: string;
  restore: CommandAssetRecord | null;
}

/** `publishBehavior` inverse: restore the previous record (or remove it). */
export interface PublishBehaviorInverse {
  kind: 'publishBehavior';
  behaviorId: string;
  restore: BehaviorRecord | null;
}

/** `setBehaviorProperties` inverse: restore the previous component (or remove it). */
export interface SetBehaviorPropertiesInverse {
  kind: 'setBehaviorProperties';
  id: string;
  restore: BehaviorComponent | null;
}

/** `setComponent` inverse: restore the full previous component value (or remove it). */
export interface SetComponentInverse {
  kind: 'setComponent';
  id: string;
  component: OwnedComponent;
  restore: unknown | null;
}


/** `setSettings` inverse: restore the full previous settings map. */
export interface SetSettingsInverse {
  kind: 'setSettings';
  restore: SettingsMap;
}

/** `acknowledgeBehaviorTrust` inverse: restore the full previous entry array. */
export interface AcknowledgeBehaviorTrustInverse {
  kind: 'acknowledgeBehaviorTrust';
  sourceDigest: string;
  restore: readonly TrustEntry[];
}

/** `deletePrefab` inverse: put the removed definition back (its undo is a `createPrefab` change). */
export interface RestorePrefabInverse {
  kind: 'restorePrefab';
  prefabId: string;
  definition: PrefabDefinition;
}

/** `createPrefab` inverse: remove the created definition. */
export interface RemovePrefabInverse {
  kind: 'removePrefab';
  prefabId: string;
}

/** The inverse of a forward entry. */
/** Undo of an `updateEntity`: restore the header (and the entity order). */
export interface UpdateEntityInverse {
  kind: 'updateEntity';
  id: string;
  restore: EntityHeader;
  order: readonly string[] | null;
  /** The local transform before a world-keeping reparent (absent: unchanged). */
  transform?: TransformComponent;
}

/** Undo of a `moveEntities`: restore the order, parents and local transforms. */
export interface MoveEntitiesInverse {
  kind: 'moveEntities';
  order: readonly string[];
  restore: readonly { id: string; parentId: string | null; transform: TransformComponent | null }[];
}

/** Undo of a material op: restore the whole previous list. */
export interface SetMaterialsInverse {
  kind: 'setMaterials';
  restore: MaterialDef[];
}

/** Undo of `setEnvironment`: restore the previous block (null = none). */
export interface SetEnvironmentInverse {
  kind: 'setEnvironment';
  restore: EnvironmentConfig | null;
}

/** Undo of `setAnimator`/`deleteAnimator`: restore the previous list. */
export interface SetAnimatorsInverse {
  kind: 'setAnimators';
  restore: AnimatorController[];
}


/** Undo of `setCollisionLayers`: restore the previous list. */
export interface SetCollisionLayersInverse {
  kind: 'setCollisionLayers';
  restore: string[];
}

/** Undo of `setSaveSchema`: restore the previous schema (null = none). */
export interface SetSaveSchemaInverse {
  kind: 'setSaveSchema';
  restore: import('@thirdlight/project-model').SaveSchema | null;
}

/** Undo of `setInput`: restore the previous actions (null = the defaults). */
export interface SetInputInverse {
  kind: 'setInput';
  restore: InputConfig | null;
}

/** Undo of `setLighting`: restore the scene's previous bake (null = none). */
export interface SetLightingInverse {
  kind: 'setLighting';
  sceneId: string;
  restore: LightingBake | null;
}

/** Undo of a `pasteEntities`: remove the created entities. */
export interface RemoveEntitiesInverse {
  kind: 'removeEntities';
  ids: string[];
}

/** Undo of a `setAssetOptions`: restore the whole previous record. */
export interface SetAssetOptionsInverse {
  kind: 'setAssetOptions';
  assetId: string;
  restore: CommandAssetRecord;
}

/** Undo of a `setTags`: restore the whole previous registry. */
export interface SetTagsInverse {
  kind: 'setTags';
  restore: TagDefinition[];
}

/** Undo of a scene-index op: restore the whole previous index. */
export interface SetSceneIndexInverse {
  kind: 'setSceneIndex';
  restore: { scenes: SceneIndexEntry[]; startScenes: string[] };
}

export type InverseSpec =
  | EditBlocksInverse
  | SetBlockTypeInverse
  | SetCellFieldsInverse
  | SetBlockStampInverse
  | GraphEditInverse
  | SetGraphInverse
  | SetEffectInverse
  | SetScriptLibraryInverse
  | SetScriptLibrariesInverse
  | SetUiInverse
  | SetDialogueInverse
  | SetModesInverse
  | SetBehaviorGroupsInverse
  | SetEventCuesInverse
  | SetShellInverse
  | SetTimelineInverse
  | SetMaterialsInverse
  | SetEnvironmentInverse
  | SetLightingInverse
  | SetAnimatorsInverse
  | SetInputInverse
  | SetCollisionLayersInverse
  | SetSaveSchemaInverse
  | RemoveEntitiesInverse
  | SetAssetOptionsInverse
  | SetSceneIndexInverse
  | SetTagsInverse
  | UpdateEntityInverse
  | MoveEntitiesInverse
  | DeleteInverse
  | SetTransformInverse
  | RestoreSubtreeInverse
  | PublishAssetInverse
  | PublishBehaviorInverse
  | SetBehaviorPropertiesInverse
  | SetComponentInverse
  | SetSettingsInverse
  | AcknowledgeBehaviorTrustInverse
  | RemovePrefabInverse
  | RestorePrefabInverse
;

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
 * `data` (default: COLOR_0 is shader data, never multiplied into the albedo)
 * or `tint` (the glTF default).
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
  vertexColors?: 'data' | 'tint';
  /** The default material mapping of every placement (null = none). */
  materials?: Record<string, string> | null;
  /** An animation-only file whose clips play on this model asset's rig (null = its clips are its own). */
  clipsFor?: string | null;
}

export interface SetTransformArgs {
  entityId: string;
  transform: PartialTransformArgs;
}

export interface DeleteEntityArgs {
  entityId: string;
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
 * `moveEntities`: up to 64 entities, moved with their subtrees
 * under `parentId` (null = root), just before the sibling `beforeId` or
 * (absent/null) after the parent's last child. World transforms are kept.
 */
export interface MoveEntitiesArgs {
  entityIds: string[];
  parentId: string | null;
  beforeId?: string | null;
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
// ---- content queries -----------

/** One `queryAssets` summary. */
export interface AssetSummary {
  assetId: string;
  kind: AssetKind;
  displayName: string;
  currentVersion: number;
  versionCount: number;
  /** The current version's file in the game folder, when it is referenced in place. */
  sourcePath?: string;
  /** The current version's original when it was converted at import (FBX; a PNG/JPEG encoded to KTX2). */
  convertedFrom?: { format: 'fbx' | 'png' | 'jpeg'; sourcePath?: string; encoding?: 'color' | 'normal' | 'data' };
  /** The current version was packed from texture assets: its encoding and the source assets. */
  packedFrom?: { encoding: 'color' | 'normal' | 'data'; sources: string[] };
  /** Texture only: the current version's image facts (a KTX2's codec and mip levels; a texture array's layers). */
  image?: { format: string; width: number; height: number; codec?: 'etc1s' | 'uastc'; levels?: number; layers?: number };
  /** Model only: `tint` = COLOR_0 multiplies the albedo (absent = shader data). */
  vertexColors?: 'tint';
  /** Model only: the default material mapping of every placement. */
  materials?: Record<string, string>;
  /** Model only: an animation-only file whose clips play on this model asset's rig. */
  clipsFor?: string;
  /** Present only with `includeVersions: true` (never bytes, never metrics). */
  versions?: readonly { version: number; sourceDigest: string; sourceByteLength: number; sourcePath?: string }[];
}

/** One `queryBehaviors` element: a summary, or the full record with `includeDeclaration`. */
export type BehaviorQueryEntry = BehaviorSummary | BehaviorRecord;

/** One `queryBehaviors` summary. */
export interface BehaviorSummary {
  behaviorId: string;
  displayName: string;
  propertyCount: number;
  hasSource: boolean;
  publishedRevision: number;
  /** Present only with `includeDeclaration: true` (never source bytes). */
  declaration?: PropertyDeclaration;
}

/** One `queryPrefabs` summary. */
export interface PrefabSummary {
  prefabId: string;
  displayName: string;
  createdRevision: number;
  entityCount: number;
  depth: number;
}

/** One `queryPrefabs` element: a summary, or the full definition with `includeEntities`. */
export type PrefabQueryEntry = PrefabSummary | PrefabDefinition;

/**
 * A query result. Queries are read-only: no
 * `expectedRevision`/`requestId`, never deduplicated, never mutating.
 */
export type QueryResult<T> =
  | {
      ok: true;
      projectId: string;
      revision: number;
      total: number;
      offset: number;
      limit: number;
      assets?: readonly T[];
      behaviors?: readonly T[];
      prefabs?: readonly T[];
    }
  | { ok: false; op?: string; projectId?: string; error: CommandError };

/**
 * The `queryProject` content count summary:
 * counts only, except `game` which is a boolean (`content.game !== null`).
 */
export interface ContentCounts {
  assets: number;
  prefabs: number;
  behaviors: number;
  settingsKeys: number;
  /** v3 only: `assets` records with `kind === "audio"`. */
  audioAssets?: number;
  /** v3 only: entities carrying `components.playerSpawn`. */
  spawns?: number;
}

/** `queryGameConfig` result (the tags, no game block). */
export type GameConfigQueryResult =
  | { ok: true; projectId: string; revision: number; tags: TagDefinition[] }
  | { ok: false; op?: string; projectId?: string; error: CommandError };

/** One `queryEntities` page: filtered, document order. */
export interface EntitiesQueryResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  entities: readonly SceneV3['entities'][number][];
}
