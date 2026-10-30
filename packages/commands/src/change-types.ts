/**
 * Change data and inverse specs: what an applied command reports to clients
 * (a client projection updates from the change alone) and what its history
 * entry keeps to undo it. Wire shapes only; `types.ts` re-exports them.
 */

import type { AssetKind, AssetRecord, AssetVersion, BehaviorComponent, BehaviorRecord, ContentCatalog, EntityV3, TagDefinition, SceneIndexEntry, ImportRecipe, ImportRecipeV3, PrefabDefinition, SettingsMap, TransformComponent, TrustEntry, EnvironmentConfig, SceneEnvironment, PlaneLock, LightingBake, AnimatorController, InputConfig, MaterialDef, EffectDef, GraphDocument, GraphOp, UiDocument, UiTheme, GameMode, TimelineAsset, StoredVertexColors } from '@thirdlight/project-model';
import type { EntityHeader, EntityHeaderField } from './entity-types';
import type { ImportAssetsChange, ImportAssetsInverse } from './import-assets';
import type { ImportResourcesChange, ImportResourcesInverse } from './import-resources';
import type { SetLoadingChange, SetLoadingInverse } from './loadable-ops';
import type { MoveResourcesChange, MoveResourcesInverse } from './move-ops';
import type { SetCollisionLayersChange, SetCollisionLayersInverse, SetLightLayersChange, SetLightLayersInverse } from './layer-types';
import type { ModelAnimationComponentValue } from './types';

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
  | 'cameraRegion'
  /** v4 scenes only: a box the probe bake fills with probes. */
  | 'probeVolume'
  /** v4 scenes only: a heightfield of tiles. */
  | 'terrain'
  /** v4 scenes only: a curve through points (roads, rivers, rails). */
  | 'spline'
  /** v4 scenes only: generated architecture (parameters; geometry made at load). */
  | 'architecture'
  /** v4 scenes only: a decal (a projector box; a clipped one's mesh is made at load). */
  | 'decal'
  /** v4 scenes only: vertex paint on a model's meshes or a generated mesh's paths (written by paintVertices). */
  | 'vertexPaint'
  /** v4 scenes only: a box or sphere overriding the scene's wind. */
  | 'windZone'
  /** v4 scenes only: how a view subject parts foliage. */
  | 'foliageBend';

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
  /** Model only: `tint` = COLOR_0 multiplies the albedo, `trim` = it is trim data (absent = shader data). */
  vertexColors?: StoredVertexColors;
  /** The labels a script may load the asset by (ascending, unique). */
  labels?: string[];
  /** Model only: the "extract textures" import setting (stored only as true). */
  extractTextures?: true;
  /** Model only: the texture asset each image of the current version was extracted into. */
  textures?: Record<string, string>;
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
  /**
   * The looks of the scenes this change adds or removes (by scene id; a scene
   * without a look is not listed): the workspace writes an added scene's file
   * with its look, so an undone delete or a redone create keeps it.
   */
  environments?: Record<string, SceneEnvironment>;
}

/** The args of the four scene-index ops, tagged with the op. */
export type SceneIndexArgs =
  /** `environmentFrom`: a scene whose look the new scene copies (absent: the engine defaults). */
  | { op: 'createScene'; sceneId?: string; name: string; environmentFrom?: string }
  | { op: 'renameScene'; sceneId: string; name: string }
  | { op: 'deleteScene'; sceneId: string }
  | { op: 'setStartScenes'; sceneIds: string[] };

/**
 * `setMaterial`/`deleteMaterial` change data: the one material before and
 * after (null: none). Each material is its own file; a change carries only
 * what it changed, however many materials the project has.
 */
export interface SetMaterialChange {
  type: 'setMaterial';
  materialId: string;
  previous: MaterialDef | null;
  next: MaterialDef | null;
}

/**
 * `setEnvironment` change data: with `sceneId` that scene's look (sky, fog,
 * post, wind), else the project's part (quality, presets); null = none.
 */
export interface SetEnvironmentChange {
  type: 'setEnvironment';
  sceneId?: string;
  previous: EnvironmentConfig | SceneEnvironment | null;
  next: EnvironmentConfig | SceneEnvironment | null;
}

/** `setScenePlane` change data: the scene's default plane before and after (null: none). */
export interface SetScenePlaneChange {
  type: 'setScenePlane';
  sceneId: string;
  previous: PlaneLock | null;
  next: PlaneLock | null;
}

/** `setAnimator`/`deleteAnimator` (and a `graphEdit` of a controller) change data: the one controller before and after (null: none). */
export interface SetAnimatorChange {
  type: 'setAnimator';
  controllerId: string;
  previous: AnimatorController | null;
  next: AnimatorController | null;
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
  /** Columns whose top row moved under the command's `surface` / `sculpt` edits (absent: it had none). */
  rebased?: number;
}

/** undo/redo of `editBlocks` — the chunks and regions the edit changed, before and after. */
export interface EditBlocksInverse {
  kind: 'editBlocks';
  entityId: string;
  patch: import('./block-patch').BlockLayerPatch;
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

/** `setKit`/`deleteKit` change data: one kit before and after (null = none). */
export interface SetKitChange {
  type: 'setKit';
  kitId: string;
  previous: import('@thirdlight/project-model').KitDef | null;
  next: import('@thirdlight/project-model').KitDef | null;
}
export interface SetKitInverse {
  kind: 'setKit';
  kitId: string;
  restore: import('@thirdlight/project-model').KitDef | null;
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

/** `updatePrefab` change data (also its undo and redo): the whole definition before and after. */
export interface UpdatePrefabChange {
  type: 'updatePrefab';
  prefabId: string;
  previous: PrefabDefinition;
  next: PrefabDefinition;
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

/**
 * `moveEntities` with a `sceneId`: entities (with their subtrees) moved from
 * one scene into another, ids and references kept, world transforms kept.
 * `entities` are the moved objects as they arrive (parents first);
 * `toOrder` is the destination scene's id order after.
 */
export interface MoveEntitiesSceneChange {
  type: 'moveEntitiesScene';
  fromSceneId: string;
  toSceneId: string;
  parentId: string | null;
  entities: readonly EntityV3[];
  toOrder: readonly string[];
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
  | import('./prefab-link-types').PrefabLinkEditChange
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
  | UpdatePrefabChange
  | RemovePrefabChange
  | RemoveAssetChange
  | InstantiatePrefabChange
  | ApplySurfacePresetChange
  | UpdateEntityChange
  | MoveEntitiesChange
  | MoveEntitiesSceneChange
  | SetTagsChange
  | SetAssetOptionsChange
  | PasteEntitiesChange
  | SetMaterialChange
  | SetEnvironmentChange
  | SetScenePlaneChange
  | SetLightingChange
  | SetAnimatorChange
  | SetInputChange
  | SetCollisionLayersChange
  | SetLightLayersChange
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
  | SetKitChange
  | SetUiChange
  | SetDialogueChange
  | SetModesChange
  | SetBehaviorGroupsChange
  | SetEventCuesChange
  | SetShellChange
  | SetUiChange
  | SetTimelineChange
  | ImportAssetsChange
  | SetLoadingChange
  | ImportResourcesChange
  | MoveResourcesChange;

/** The change types a forward (non-undo/redo) command can produce. */
export type ForwardChange =
  | import('./prefab-link-types').PrefabLinkEditChange
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
  | UpdatePrefabChange
  | RemovePrefabChange
  | RemoveAssetChange
  | InstantiatePrefabChange
  | ApplySurfacePresetChange
  | UpdateEntityChange
  | MoveEntitiesChange
  | MoveEntitiesSceneChange
  | SetTagsChange
  | SetAssetOptionsChange
  | PasteEntitiesChange
  | SetMaterialChange
  | SetEnvironmentChange
  | SetScenePlaneChange
  | SetLightingChange
  | SetAnimatorChange
  | SetInputChange
  | SetCollisionLayersChange
  | SetLightLayersChange
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
  | SetKitChange
  | SetUiChange
  | SetDialogueChange
  | SetModesChange
  | SetBehaviorGroupsChange
  | SetEventCuesChange
  | SetShellChange
  | SetUiChange
  | SetTimelineChange
  | ImportAssetsChange
  | SetLoadingChange
  | ImportResourcesChange
  | MoveResourcesChange;

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

/** `updatePrefab` inverse: put the replaced definition back. */
export interface UpdatePrefabInverse {
  kind: 'updatePrefab';
  prefabId: string;
  restore: PrefabDefinition;
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

/** Undo of a cross-scene move: the moved objects as they were, at their place in the source scene's order. */
export interface MoveEntitiesSceneInverse {
  kind: 'moveEntitiesScene';
  restore: readonly EntityV3[];
  order: readonly string[];
}

/** Undo of a `moveEntities`: restore the order, parents and local transforms. */
export interface MoveEntitiesInverse {
  kind: 'moveEntities';
  order: readonly string[];
  restore: readonly { id: string; parentId: string | null; transform: TransformComponent | null }[];
}

/** Undo of a material op: put the one material back as it was (null: none). */
export interface SetMaterialInverse {
  kind: 'setMaterial';
  materialId: string;
  restore: MaterialDef | null;
}

/** Undo of `setEnvironment`: restore the previous block, or with `sceneId` the scene's look (null = none). */
export interface SetEnvironmentInverse {
  kind: 'setEnvironment';
  sceneId?: string;
  restore: EnvironmentConfig | SceneEnvironment | null;
}

/** Undo of `setScenePlane`: the scene's default plane as it was (null: none). */
export interface SetScenePlaneInverse {
  kind: 'setScenePlane';
  sceneId: string;
  restore: PlaneLock | null;
}

/** Undo of `setAnimator`/`deleteAnimator` (and a controller's `graphEdit`): put the one controller back as it was (null: none). */
export interface SetAnimatorInverse {
  kind: 'setAnimator';
  controllerId: string;
  restore: AnimatorController | null;
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

/** Undo of a scene-index op: restore the whole previous index (and the looks of the scenes it brings back). */
export interface SetSceneIndexInverse {
  kind: 'setSceneIndex';
  restore: { scenes: SceneIndexEntry[]; startScenes: string[] };
  environments?: Record<string, SceneEnvironment>;
}

export type InverseSpec =
  | import('./prefab-link-types').PrefabLinkEditInverse
  | EditBlocksInverse
  | SetBlockTypeInverse
  | SetCellFieldsInverse
  | SetBlockStampInverse
  | SetKitInverse
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
  | SetMaterialInverse
  | SetEnvironmentInverse
  | SetScenePlaneInverse
  | SetLightingInverse
  | SetAnimatorInverse
  | SetInputInverse
  | SetCollisionLayersInverse
  | SetLightLayersInverse
  | SetSaveSchemaInverse
  | RemoveEntitiesInverse
  | SetAssetOptionsInverse
  | SetSceneIndexInverse
  | SetTagsInverse
  | UpdateEntityInverse
  | MoveEntitiesInverse
  | MoveEntitiesSceneInverse
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
  | UpdatePrefabInverse
  | ImportAssetsInverse
  | SetLoadingInverse
  | ImportResourcesInverse
  | MoveResourcesInverse
;
