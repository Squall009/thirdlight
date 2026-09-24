/**
 * Public types — commands.md §2–§9 (M1).
 *
 * These are the command-layer wire shapes: the mutation request envelope
 * (§3), the mutation success/failure results (§5.1/§5.2), the structured
 * error model (§5.4), the change data (§5.3), the inverse specs and the
 * in-memory history model (§9.1), and the per-project command state the
 * pure apply function works on.
 *
 * Ownership (commands.md §1, workspace.md §1): this package owns command
 * semantics only. Request canonicalization/digests (§6.6), durable retry
 * records (§7.1), the revision's durable storage, and project resolution
 * belong to the workspace package (packet 07). Nothing here touches the
 * filesystem, transport, UI, or three.js (dependencies.md §4.1: the only
 * allowed edge is project-model).
 *
 * Runtime inputs to the public entry points are `unknown` where marked:
 * the strict validators re-check every rule (contract strictness, §3);
 * TypeScript types alone never make a value safe.
 */

import type {
  AssetMetrics,
  AssetKind,
  AssetRecord,
  AssetVersion,
  ConvertedFrom,
  BehaviorComponent,
  BehaviorRecord,
  BehaviorTrust,
  ContentCatalog,
  Entity,
  EntityV2,
  GameConfig,
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
  Scene,
  SceneV2,
  SceneV3,
  SettingsMap,
  TransformComponent,
  TrustEntry,
  SceneV4,
  EnvironmentConfig,
  MaterialDef,
} from '@thirdlight/project-model';

// ---- ops and origins --------------------------------------------------------

/** The five M1 mutation ops (commands.md §2). Queries are workspace-served (packet 07). */
export type M1MutationOp =
  | 'createEntity'
  | 'setTransform'
  | 'deleteEntity'
  | 'undo'
  | 'redo';

/**
 * The non-prefab M2 content/property mutation ops (commands.md §2/§8.5–§8.12,
 * packet 21). Prefab ops (`createPrefab`, `instantiatePrefab`) are packet 22.
 */
export type ContentMutationOp =
  | 'publishAsset'
  | 'publishBehavior'
  | 'setBehaviorProperties'
  | 'setComponent'
  | 'setSettings'
  | 'acknowledgeBehaviorTrust';

/**
 * The prefab M2 mutation ops (commands.md §2/§8.6–§8.7, packet 22).
 * `createPrefab` captures an immutable definition; `instantiatePrefab`
 * materializes independent copies in ONE transaction.
 */
export type PrefabMutationOp = 'createPrefab' | 'instantiatePrefab';

/**
 * The v3 game/presentation mutation ops (commands.md §2/§8.13–§8.14, packet
 * 45): `applySurfacePreset` copies a preset row; `setGameConfig` is the sole
 * writer of `content.game`.
 */
export type V3MutationOp =
  | 'applySurfacePreset'
  | 'setGameConfig'
  | 'updateEntity'
  | 'moveEntities'
  | 'setTags'
  | 'setAssetOptions'
  | 'pasteEntities'
  | 'setMaterial'
  | 'deleteMaterial'
  | 'setEnvironment'
  // phase 12 (c): the scene index of a v4 project
  | 'createScene'
  | 'renameScene'
  | 'deleteScene'
  | 'setStartScenes';

/** Every implemented mutation op. */
export type MutationOp = M1MutationOp | ContentMutationOp | PrefabMutationOp | V3MutationOp;

/**
 * The forward ops that create history entries (undo/redo never do, §9.1).
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

/** Request origin (§3): absent ⇒ recorded as `null` in the history entry. */
export interface Origin {
  kind: 'browser' | 'mcp' | 'admin';
  /** 1–128 chars, no control characters. */
  clientId: string;
}

// ---- error model (§5.2/§5.4) --------------------------------------------------

/** Client policy classes (§5.5). */
export type ErrorClass =
  | 'conflict'
  | 'validation'
  | 'unavailable'
  | 'not_found'
  | 'internal';

/**
 * One structured error (§5.2/§5.4).
 *
 * Key order in emitted payloads: `code`, `cls`, then the code-specific
 * fields in §5.4 table order, then (result-scene failures)
 * `detailDocument`, `details`, `detailCount`, `detailsTruncated`, then
 * `message`, `hint` — the byte-exact scenario fixtures pin this order.
 *
 * Code-specific fields (present only per the §5.4 "Carries" column):
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
 *   `details` (project-model §12.5 error objects in document order, capped
 *   at 32), `detailCount` (true total), `detailsTruncated` (when capped).
 *
 * The workspace-level codes (`project_not_found`, `project_unavailable`,
 * `workspace_closed`, `request_id_reused`, `external_change_unresolved`,
 * `write_failed`, …) are in `ERROR_CODES` but are constructed by the
 * workspace package (packet 07), never by this pure layer.
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
  // content/property ops (§5.4 rows added by packet 16):
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
  // v3 game/presentation rows (packet 45):
  /** `game_reference_in_use` only (§23.6): the envelope-document pointers, ascending. */
  references?: readonly string[];
  /** `zone_checkpoint_count_invalid` only (§23.9). */
  zoneIds?: readonly string[];
  /** `animation_role_*` rows: the role key the diagnostic names. */
  role?: string;
  /** `animation_role_out_of_range`/`animation_role_duplicate` rows. */
  clipIndex?: number;
  /** `animation_role_out_of_range` only: the version's clip count. */
  clips?: number;
  /** `animation_role_duplicate` only: the roles sharing one clip index. */
  roles?: readonly string[];
  sourceDigest?: string;
  // prefab ops (§5.4 rows, packet 22):
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

// ---- change data (§5.3) --------------------------------------------------------

/** `position`/`rotation`/`scale` in canonical order. */
export type ChangedField = 'position' | 'rotation' | 'scale';

/**
 * The six v3 add-capable components (commands.md §8.10, project-model §23.3).
 * `playerSpawn` is a field-less marker; the rest are partial-replaceable.
 */
export type V3OwnedComponent =
  | 'gameZone'
  | 'playerSpawn'
  | 'cameraFollow'
  | 'light'
  | 'surface'
  | 'modelAnimation'
  /** Phase 12 (c), v4 scenes only: an instance set. */
  | 'instances'
  /** Phase 9.4, v4 scenes only: the object's material mapping. */
  | 'materials'
  /** Phase 9.5, v4 scenes only: a fog volume. */
  | 'fogVolume';

/** Every `setComponent`-owned component (the M2 five plus the six v3 ones). */
export type OwnedComponent =
  | 'box'
  | 'camera'
  | 'model'
  | 'collider'
  | 'controller'
  | V3OwnedComponent;

/** The three built-in surface-preset names (project-model §23.3.5). */
export type SurfacePresetName = 'matte-ground' | 'hazard' | 'beacon';

/**
 * The command layer's asset-version value: the v2 record with the v3
 * `pcm-wav` recipe shape permitted (project-model §23.3.7; the WAV profile
 * itself is packet 41/47's).
 */
export type CommandAssetVersion = Omit<AssetVersion, 'importRecipe'> & {
  importRecipe: ImportRecipe | ImportRecipeV3;
};

/**
 * The command layer's asset record: the v2 record widened to the v3 `kind`
 * discriminator (`model` | `audio`, project-model §23.3.7). A v2 record and a
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
 * `serializeCanonical` distinguishes the v2 catalog (project-model
 * §12.2/§23.7). Both directions are assignable, so the workspace's v2 state
 * and a v3 state share this one type.
 *
 * The v3 `AssetRecord.kind` discr iminator and the `pcm-wav` recipe shape are
 * carried by {@link CommandAssetRecord}/{@link CommandAssetVersion}; the v3
 * ops view `assets` through those types (`assetsOf`), so audio records are
 * typed end to end without changing the accepted v2 catalog shape.
 */
export interface ContentDocument extends ContentCatalog {
  game?: GameConfig | null;
  /** Phase 12 (b): the project tag registry (ascending bit; absent = none). */
  tags?: TagDefinition[];
}

/** Phase 12 (c): the scene index (`content.scenes` + `content.startScenes`) before and after. */
export interface SetSceneIndexChange {
  type: 'setSceneIndex';
  previous: { scenes: SceneIndexEntry[]; startScenes: string[] };
  next: { scenes: SceneIndexEntry[]; startScenes: string[] };
}

/** Phase 12 (c): the args of the four scene-index ops, tagged with the op. */
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

/** `pasteEntities` change data: the created entities, parents first. */
export interface PasteEntitiesChange {
  type: 'pasteEntities';
  entities: Entity[];
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

/** `publishAsset` change data (commands.md §5.3/§8.5). */
export interface PublishAssetChange {
  type: 'publishAsset';
  mode: 'create' | 'reimport';
  assetId: string;
  /** Full asset records in the direction applied; `null` = absent. */
  previous: CommandAssetRecord | null;
  next: CommandAssetRecord | null;
  /**
   * `publishAsset{animation}` only (commands.md §8.5.1): the entity's full
   * `modelAnimation` component (assetId, version, roles) moved atomically
   * with the record — on reimport `version` advances to the newly appended
   * version and `roles` is replaced with the submitted mapping. Full
   * components (not roles only) so the inverse restores the previous version
   * binding exactly and the recorded-value rule (§9.1) re-applies it.
   */
  animation?: { entityId: string; previous: ModelAnimationComponentValue; next: ModelAnimationComponentValue };
}

/** `publishBehavior` change data (commands.md §5.3/§8.8). */
export interface PublishBehaviorChange {
  type: 'publishBehavior';
  behaviorId: string;
  /** Full behavior records in the direction applied; `null` = absent. */
  previous: BehaviorRecord | null;
  next: BehaviorRecord | null;
}

/** `setBehaviorProperties` change data (commands.md §5.3/§8.9). */
export interface SetBehaviorPropertiesChange {
  type: 'setBehaviorProperties';
  id: string;
  /** Full component values; `null` = absent (removal). */
  previous: BehaviorComponent | null;
  next: BehaviorComponent | null;
  /** Declaration order. */
  changedKeys: readonly string[];
}

/** `setComponent` change data (commands.md §5.3/§8.10). */
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

/** `applySurfacePreset` change data (commands.md §5.3/§8.13, authoring §A4.2). */
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

/** `setGameConfig` change data (commands.md §5.3/§8.14, authoring §A4.2). */
export interface SetGameConfigChange {
  type: 'setGameConfig';
  /** Full `GameConfig` values or `null`; `null` = the block is absent. */
  previous: GameConfig | null;
  next: GameConfig | null;
  /** Replaced top-level names in canonical order. */
  changedFields: readonly string[];
}

/** `setSettings` change data (commands.md §5.3/§8.11). */
export interface SetSettingsChange {
  type: 'setSettings';
  /** Full maps. */
  previous: SettingsMap;
  next: SettingsMap;
  /** Ascending key codepoint order. */
  changedKeys: readonly string[];
}

/** `acknowledgeBehaviorTrust` change data (commands.md §5.3/§8.12). */
export interface AcknowledgeBehaviorTrustChange {
  type: 'acknowledgeBehaviorTrust';
  sourceDigest: string;
  /** Full `behaviorTrust` entry arrays before/after. */
  previous: readonly TrustEntry[];
  next: readonly TrustEntry[];
}

/** `createPrefab` change data (commands.md §5.3/§8.6.4). */
export interface CreatePrefabChange {
  type: 'createPrefab';
  prefabId: string;
  /** The full definition value (immutable; redo re-inserts it verbatim). */
  definition: PrefabDefinition;
}

/** Undo of a `createPrefab` (never a forward operation, §5.3). */
export interface RemovePrefabChange {
  type: 'removePrefab';
  prefabId: string;
}

/** One created entity of an instantiation, at its insertion index (§8.7.6). */
export interface InstantiatePrefabEntry {
  /** The pre-insertion `entities` length plus this entry's document-order offset. */
  index: number;
  /** The full created entity value (canonical). */
  entity: EntityV2;
}

/** `instantiatePrefab` change data (commands.md §5.3/§8.7.6). */
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
  entity: Entity;
  /** A folder created with children: the children, in insertion order after `entity`. */
  children?: Entity[];
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
 * An entity's hierarchy identity: its name, its parent (null = root) and its
 * own hierarchy flags (phase 12; the stored defaults are active, unlocked,
 * not static).
 */
export interface EntityHeader {
  name: string | null;
  parentId: string | null;
  active: boolean;
  locked: boolean;
  static: boolean;
  /** Phase 12 (b): the entity's own tag mask (0 = none; absent in older records). */
  tags: number;
}

/** The `updateEntity` fields a change can name. */
export type EntityHeaderField = 'name' | 'parentId' | 'active' | 'locked' | 'static' | 'tags';

/**
 * `updateEntity`: rename, reparent and/or set the hierarchy flags. When a
 * reparent has to move the entity's subtree after its new parent
 * (parent-before-child order), `order` carries the full entity-id order
 * before and after; otherwise it is null. A reparent keeps the entity's
 * world transform: when that changes its local transform, `transform`
 * carries both (absent otherwise, and in records written before phase 12).
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
 * `moveEntities` (phase 12): file one or more entities (with their subtrees)
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
  entities: readonly Entity[];
}

/** Structured change data (§5.3). A client projection updates from this alone. */
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
  | InstantiatePrefabChange
  | ApplySurfacePresetChange
  | SetGameConfigChange
  | UpdateEntityChange
  | MoveEntitiesChange
  | SetTagsChange
  | SetAssetOptionsChange
  | PasteEntitiesChange
  | SetMaterialsChange
  | SetEnvironmentChange
  | SetSceneIndexChange;

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
  | InstantiatePrefabChange
  | ApplySurfacePresetChange
  | SetGameConfigChange
  | UpdateEntityChange
  | MoveEntitiesChange
  | SetTagsChange
  | SetAssetOptionsChange
  | PasteEntitiesChange
  | SetMaterialsChange
  | SetEnvironmentChange
  | SetSceneIndexChange;

// ---- inverse specs (§9.1) --------------------------------------------------------

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
  entity: Entity;
}

export interface RestoreSubtreeInverse {
  kind: 'restoreSubtree';
  /** Pre-deletion array order (ascending index); root first. */
  entries: readonly RestoreSubtreeEntry[];
  /** The root's parent (or null); the parent always survives subtree deletion. */
  restoredParentId: string | null;
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

/** `setGameConfig` inverse: restore the full previous block (or remove it). */
export interface SetGameConfigInverse {
  kind: 'setGameConfig';
  restore: GameConfig | null;
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

/** `createPrefab` inverse: remove the created definition (§9.1). */
export interface RemovePrefabInverse {
  kind: 'removePrefab';
  prefabId: string;
}

/** The inverse of a forward entry (§9.1). */
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
  | SetMaterialsInverse
  | SetEnvironmentInverse
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
  | SetGameConfigInverse;

// ---- history model (§9.1) --------------------------------------------------------

/**
 * One history entry. Per project, in memory only (M1, §9.1/§9.2); `seq` is a
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
  /** Forward change data (§5.3). */
  change: ForwardChange;
  /** Inverse spec (§9.1). */
  inverse: InverseSpec;
  /**
   * Phase 12 (c): the scene the entry edited in a v4 project (set by the
   * workspace; absent for content-only entries and in v1–v3).
   */
  sceneId?: string;
}

/**
 * The history stack (§9.1): `entries[0..n-1]` with cursor `c`;
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

/** Depths reported in results and queries (§5.1, §5.6). */
export interface HistoryDepths {
  undoDepth: number;
  redoDepth: number;
}

// ---- command state --------------------------------------------------------------

/**
 * A scene document the command layer can carry: the M1 standalone interchange
 * scene (schemaVersion 1), the embedded M2 scene (schemaVersion 2) or the v3
 * scene (schemaVersion 3).
 */
/** Phase 12 (c): a v4 scene (one of a project's scene files) is edited like a v3 scene. */
export type SceneDocument = Scene | SceneV2 | SceneV3 | SceneV4;

/**
 * The per-project in-memory state the pure apply function operates on.
 * `scene` must be a VALID canonical scene (project-model §12.2) — the
 * workspace service (packet 07) guarantees this at load and after every
 * published mutation; the command layer re-validates only RESULT documents.
 *
 * `content` is the envelope's M2 `content` block (project-model §18). It is
 * absent for an M1 (schemaVersion 1) state, where it is treated as the empty
 * catalog; M2 content/property ops read and write it. `manifest` is the v1
 * manifest when the caller has one: with it, a v2 result is validated by the
 * three-block `validateProjectV2` (project-model §13.1); without it the command
 * layer validates the v2 scene and content separately and relies on each op's
 * explicit reference checks (documented in handoff 21).
 */
export interface CommandState<S extends SceneDocument = Scene> {
  scene: S;
  /**
   * Phase 12 (c): in a v4 project `scene` is the one scene an edit touches;
   * these are the entity ids of the project's other scenes (ids are unique
   * across the project, so none of them is ever minted).
   */
  reservedIds?: ReadonlySet<string>;
  content?: ContentDocument;
  manifest?: Manifest;
  history: HistoryState;
  /**
   * True when the host has registered a behavior-source preparer (packet 33;
   * the workspace injects a compiler). Absent/false keeps the §22.6
   * structural refusal `behavior_publication_unavailable`
   * (`reason: "preparer_unavailable"`).
   */
  behaviorPreparerRegistered?: boolean;
  /**
   * The digest-bound prepared results the preparer derived from durable bytes
   * (project-model.md §22.4.1), keyed by `sourceDigest`. The `publishBehavior`
   * source branch reads ONLY these facts — never a caller-supplied record
   * field — so no unchecked write path exists.
   */
  preparedBehaviorSources?: ReadonlyMap<string, PreparedBehaviorSourceFact>;
}

/**
 * One prepared behavior-source fact set (project-model.md §22.4.1): every
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
  declarationDigest: string;
  recipeDigest: string;
  compiler: { id: string; version: string; esbuild: string; typescript: string };
}

// ---- mutation request envelopes (§3) ----------------------------------------------

/**
 * Partial transform args (§3.1): any non-empty subset; a present field
 * replaces the whole field (arrays are never merged component-wise).
 * Element values (length, finiteness, ranges, quaternion norm) are
 * re-checked by the project-model validation of the resulting scene.
 */
export interface PartialTransformArgs {
  position?: readonly number[];
  rotation?: readonly number[];
  scale?: readonly number[];
}

/** Box args for createEntity (§3.1): only when `kind` is `"box"`. */
export interface BoxArgs {
  size?: readonly number[];
  material?: { color?: string };
}

/** Model args for createEntity (§3.1/§5.1): only when `kind` is `"model"`. */
export interface ModelArgs {
  asset: { assetId: string };
  /** One named piece of a multi-piece GLB (absent = the whole file). */
  piece?: string;
}

export interface CreateEntityArgs {
  /** `folder` (phase 12): organisation only — no transform, box, model or components. */
  kind: 'group' | 'box' | 'model' | 'folder';
  parentId?: string | null;
  name?: string;
  transform?: PartialTransformArgs;
  /** Only when `kind` is `"box"`. */
  box?: BoxArgs;
  /** Only when `kind` is `"model"` (required then). */
  model?: ModelArgs;
  /**
   * The add-capable components created in the same transaction (commands.md
   * §3.1/authoring §A3.1): `collider`, `controller`, `gameZone`, `playerSpawn`,
   * `cameraFollow`, `light`, `surface`, `modelAnimation`; never `null`.
   */
  components?: Record<string, unknown>;
  /** Copies a built-in preset row onto `components.surface` (authoring §A3.1). */
  surfacePreset?: SurfacePresetName;
  /**
   * `folder` only: objects created inside the new folder in the same
   * transaction (one undo), e.g. every piece of a multi-piece model. Each is
   * a `box`/`model`/`group` create without `parentId` or `children`.
   */
  children?: CreateEntityArgs[];
}

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
  /** Phase 9.4: the default material mapping of every placement (null = none). */
  materials?: Record<string, string> | null;
}

export interface SetTransformArgs {
  entityId: string;
  transform: PartialTransformArgs;
}

export interface DeleteEntityArgs {
  entityId: string;
}

/** `updateEntity` args: at least one of `name` / `parentId` (null = make root). */
export interface UpdateEntityArgs {
  entityId: string;
  name?: string;
  parentId?: string | null;
  active?: boolean;
  locked?: boolean;
  static?: boolean;
  /** Phase 12 (b): the entity's own tags, by name (replaces the whole set; [] clears). */
  tags?: string[];
}

/**
 * `setTags` (phase 12 b): the whole tag registry. An entry with `bit` keeps
 * that bit (a rename keeps the bit); an entry without one gets the lowest
 * free bit. A tag an entity still carries cannot be left out.
 */
export interface SetTagsArgs {
  tags: { bit?: number; name: string }[];
}

/**
 * `moveEntities` (phase 12): up to 64 entities, moved with their subtrees
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

/** §41.3.1 one rigid animation role binding. */
export interface AnimationRoleBindingValue {
  clipIndex: number;
  clipName: string;
}

/** §41.3.1 the three role keys, all required, in canonical order. */
export interface ModelAnimationRolesValue {
  idle: AnimationRoleBindingValue;
  run: AnimationRoleBindingValue;
  airborne: AnimationRoleBindingValue;
}

/**
 * project-model §23.3.6 the full `components.modelAnimation` component.
 * The binding is owned by that `(assetId, version)`: a `roles` value is only
 * valid against the clip list of the version it is recorded with, so the
 * atomic reimport moves `version` and `roles` together (commands.md §8.5.1,
 * presentation.md §41.3.1/§41.3.4 — CC-L-1 repair, Gate L).
 */
export interface ModelAnimationComponentValue {
  assetId: string;
  version: number;
  roles: ModelAnimationRolesValue;
}

/** commands.md §8.5.1: the version-local mapping moved with a reimport. */
export interface PublishAssetAnimation {
  entityId: string;
  roles: ModelAnimationRolesValue;
}

/** `publishAsset` args (commands.md §3.1.1/§8.5; workspace.md §13.3.1). */
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
  importRecipe: ImportRecipe | ImportRecipeV3;
  metrics: AssetMetrics;
  /** project-model §7.2 timestamp; a prepared fact (see handoff 21 C21-2). */
  importedAt: string;
  /** Atomic version-local role mapping (commands.md §8.5.1). */
  animation?: PublishAssetAnimation;
}

/** `publishBehavior` args (commands.md §3.1.4/§8.8). */
export interface PublishBehaviorArgs {
  behaviorId: string;
  displayName: string;
  mode: 'declaration-create' | 'declaration-update' | 'source';
  declaration: PropertyDeclaration;
  /** Only with `mode: "source"` (unavailable in M2). */
  source?: { sourceDigest: string; sourceByteLength: number };
}

/** `setBehaviorProperties` args (commands.md §3.1.5/§8.9). */
export interface SetBehaviorPropertiesArgs {
  entityId: string;
  /** `null` removes the component. */
  behaviorId: string | null;
  /** Partial map of declared keys; omitted keys take their declaration default. */
  values?: Record<string, PropertyValue>;
}

/** `setComponent` args (commands.md §3.1.6/§8.10). */
export interface SetComponentArgs {
  entityId: string;
  component: OwnedComponent;
  /** Non-empty partial object of that component's fields; `null` removes an
   *  add-capable component (the M2 physics pair and the six v3 ones) and is
   *  never a removal for `box`/`camera`/`model`. */
  value: Record<string, unknown> | null;
}

/** `applySurfacePreset` args (commands.md §3.1.9/§8.13). */
export interface ApplySurfacePresetArgs {
  entityId: string;
  preset: SurfacePresetName;
}

/**
 * `setGameConfig` args (commands.md §3.1.10/§8.14): `null` removes the block;
 * a complete object creates it when absent; a non-empty partial object of its
 * top-level fields edits it.
 */
export interface SetGameConfigArgs {
  game: GameConfig | null | Record<string, unknown>;
}

/** `setSettings` args (commands.md §3.1.7/§8.11). */
export interface SetSettingsArgs {
  /** Non-empty partial map over the declared keys. */
  settings: SettingsMap;
}

/** `acknowledgeBehaviorTrust` args (commands.md §3.1.8/§8.12). */
export interface AcknowledgeBehaviorTrustArgs {
  sourceDigest: string;
}

/** `createPrefab` args (commands.md §3.1.2/§8.6.1). */
export interface CreatePrefabArgs {
  /** ID syntax; not already in `content.prefabs`. */
  prefabId: string;
  /** 1–128 chars, no control characters. */
  displayName: string;
  /** Existing entity ID in the current scene. */
  sourceEntityId: string;
}

/** One declared-property override at instantiation (commands.md §8.7.3). */
export interface PropertyOverride {
  localId: string;
  key: string;
  value: PropertyValue;
}

/** `instantiatePrefab` args (commands.md §3.1.3/§8.7.1). */
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

export type MutationArgs =
  | SceneIndexArgs
  | SetTagsArgs
  | UpdateEntityArgs
  | MoveEntitiesArgs
  | CreateEntityArgs
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
  | ApplySurfacePresetArgs
  | SetGameConfigArgs;

/**
 * The M1 mutation request envelope (§3). This type documents the wire
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

// ---- results (§5.1/§5.2) ----------------------------------------------------------

/** Mutation success (§5.1); canonical key order in emitted payloads. */
export interface MutationSuccess {
  ok: true;
  // M2 content ops use the same success payload (commands.md §5.1).
  op: MutationOp;
  projectId: string;
  requestId: string;
  /** expectedRevision + 1 (every successful M1 mutation advances by exactly 1). */
  revision: number;
  /** Always `false` from the pure layer; workspace replays set `true` (§6.3). */
  duplicated: false;
  /** createEntity only. */
  createdId?: string;
  /** Phase 12 (c), v4 projects: the scene the command edited (absent for scene-index changes). */
  sceneId?: string;
  change: ChangeData;
  /** undo/redo only: the requestId of the original forward command. */
  appliedOf?: string;
  /** undo/redo only: the origin of that original command (or null). */
  originOfApplied?: Origin | null;
  history: HistoryDepths;
}

/**
 * Mutation failure (§5.2). `op`/`projectId`/`requestId` are echoed only
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
export type ApplyOutcome<S extends SceneDocument = Scene> =
  | { ok: true; result: MutationSuccess; state: CommandState<S> }
  | { ok: false; result: MutationFailure };
// ---- content queries (commands.md §4/§5.6, packet 21 non-prefab subset) -----------

/** One `queryAssets` summary (commands.md §5.6). */
export interface AssetSummary {
  assetId: string;
  kind: AssetKind;
  displayName: string;
  currentVersion: number;
  versionCount: number;
  /** The current version's file in the game folder, when it is referenced in place. */
  sourcePath?: string;
  /** The current version's original when it was converted at import (FBX). */
  convertedFrom?: { format: 'fbx'; sourcePath?: string };
  /** Model only: `tint` = COLOR_0 multiplies the albedo (absent = shader data). */
  vertexColors?: 'tint';
  /** Model only (phase 9.4): the default material mapping of every placement. */
  materials?: Record<string, string>;
  /** Present only with `includeVersions: true` (never bytes, never metrics). */
  versions?: readonly { version: number; sourceDigest: string; sourceByteLength: number; sourcePath?: string }[];
}

/** One `queryBehaviors` element: a summary, or the full record with `includeDeclaration`. */
export type BehaviorQueryEntry = BehaviorSummary | BehaviorRecord;

/** One `queryBehaviors` summary (commands.md §5.6). */
export interface BehaviorSummary {
  behaviorId: string;
  displayName: string;
  propertyCount: number;
  hasSource: boolean;
  publishedRevision: number;
  /** Present only with `includeDeclaration: true` (never source bytes). */
  declaration?: PropertyDeclaration;
}

/** One `queryPrefabs` summary (commands.md §5.6, packet 22). */
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
 * A query result (commands.md §5.6). Queries are read-only: no
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
 * The `queryProject` content count summary (commands.md §5.6/§4, packet 45):
 * counts only, except `game` which is a boolean (`content.game !== null`).
 */
export interface ContentCounts {
  assets: number;
  prefabs: number;
  behaviors: number;
  settingsKeys: number;
  /** v3 only: `assets` records with `kind === "audio"` (authoring §A6). */
  audioAssets?: number;
  /** v3 only: `true` iff `content.game !== null`. */
  game?: boolean;
  /** v3 only: entities carrying `components.gameZone`. */
  zones?: number;
  /** v3 only: entities carrying `components.playerSpawn`. */
  spawns?: number;
}

/** `queryGameConfig` result (commands.md §3.1.11/§A6): the block or `null`. */
export type GameConfigQueryResult =
  | { ok: true; projectId: string; revision: number; game: GameConfig | null; tags: TagDefinition[] }
  | { ok: false; op?: string; projectId?: string; error: CommandError };

/** One `queryEntities` page (commands.md §4/§5.6): filtered, document order. */
export interface EntitiesQueryResult {
  ok: true;
  projectId: string;
  revision: number;
  total: number;
  offset: number;
  limit: number;
  entities: readonly (Entity | EntityV2 | SceneV3['entities'][number])[];
}
