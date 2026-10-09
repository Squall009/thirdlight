# Command op arguments

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Each op's arguments as the validator types them. The full validation rules for a document value are its descriptor's (components and content pages).

<a id="op-acknowledgeBehaviorTrust"></a>
## acknowledgeBehaviorTrust

Writes: [`content.behaviorTrust`](content-blocks-save-schema.md#content-behaviorTrust).

Arguments (`args`):

```ts
/** `acknowledgeBehaviorTrust` args. */
interface AcknowledgeBehaviorTrustArgs {
  sourceDigest: string;
}
```

<a id="op-applySurfacePreset"></a>
## applySurfacePreset

Arguments (`args`):

```ts
/** `applySurfacePreset` args. */
interface ApplySurfacePresetArgs {
  entityId: string;
  preset: SurfacePresetName;
}
```

<a id="op-colliderFromModel"></a>
## colliderFromModel

Arguments (`args`):

```ts
/** `colliderFromModel` args: the object and what to make. */
interface ColliderFromModelArgs {
  entityId: string;
  kind: ModelColliderKind;
}
```

<a id="op-commitScriptLibraryStage"></a>
## commitScriptLibraryStage

Arguments (`args`):

```ts
{ stageId: string }
```

<a id="op-createEntities"></a>
## createEntities

Arguments (`args`):

```ts
{ entities: (CreateEntityArgs & { ref?: string })[] }
```

Types: [`CreateEntityArgs`](types-a-d.md#type-create-entity-args).

<a id="op-createEntity"></a>
## createEntity

Arguments (`args`):

```ts
interface CreateEntityArgs {
  /** `folder`: organisation only — no transform, box, model or components. */
  kind: 'group' | 'box' | 'model' | 'folder';
  parentId?: string | null;
  name?: string;
  /** The entity flags and tags, as `updateEntity` sets them (absent: active, visible, unlocked, not static, not kept loaded, no tags). */
  active?: boolean;
  visible?: boolean;
  locked?: boolean;
  static?: boolean;
  keepLoaded?: boolean;
  /** Tag names of the project's registry. */
  tags?: string[];
  transform?: PartialTransformArgs;
  /** Only when `kind` is `"box"`. */
  box?: BoxArgs;
  /** Only when `kind` is `"model"` (required then). */
  model?: ModelArgs;
  /**
   * The add-capable components created in the same transaction:
   * `collider`, `controller`, `playerSpawn`, `light`, `surface`,
   * `modelAnimation`; never `null`.
   */
  components?: Record<string, unknown>;
  /** Copies a built-in preset row onto `components.surface`. */
  surfacePreset?: SurfacePresetName;
  /**
   * `folder` only: objects created inside the new folder in the same
   * transaction (one undo), e.g. every piece of a multi-piece model. Each is
   * a `box`/`model`/`group` create without `parentId` or `children`.
   */
  children?: CreateEntityArgs[];
}
```

<a id="op-createFolder"></a>
## createFolder

Arguments (`args`):

```ts
/** `createFolder` args: the folder to make (its parents are made too). */
interface CreateFolderArgs {
  folder: string;
}
```

<a id="op-createPrefab"></a>
## createPrefab

Writes: [`content.prefabs`](content-blocks-save-schema.md#content-prefabs).

Arguments (`args`):

```ts
/** `createPrefab` args. */
interface CreatePrefabArgs {
  /** ID syntax; not already in `content.prefabs`. */
  prefabId: string;
  /** 1–128 chars, no control characters. */
  displayName: string;
  /** Existing entity ID in the current scene. */
  sourceEntityId: string;
}
```

<a id="op-createScene"></a>
## createScene

Writes: [`content.scenes`](content-blocks-save-schema.md#content-scenes).

Arguments (`args`):

```ts
/** The args of the four scene-index ops, tagged with the op. */
type SceneIndexArgs =
  /** `environmentFrom`: a scene whose look the new scene copies (absent: the engine defaults). */
  | { op: 'createScene'; sceneId?: string; name: string; environmentFrom?: string }
  | { op: 'renameScene'; sceneId: string; name: string }
  | { op: 'deleteScene'; sceneId: string }
  | { op: 'setStartScenes'; sceneIds: string[] };
```

<a id="op-deleteAnimator"></a>
## deleteAnimator

Writes: [`content.animators`](content-blocks-animators.md#content-animators).

Arguments (`args`):

```ts
{ controllerId: string }
```

<a id="op-deleteAsset"></a>
## deleteAsset

Writes: [`content.assets`](content-blocks-save-schema.md#content-assets).

Arguments (`args`):

```ts
{ assetId: string }
```

<a id="op-deleteBehavior"></a>
## deleteBehavior

Writes: [`content.behaviors`](content-blocks-save-schema.md#content-behaviors).

Arguments (`args`):

```ts
{ behaviorId: string }
```

<a id="op-deleteBlockStamp"></a>
## deleteBlockStamp

Writes: [`content.blockStamps`](content-blocks-animators.md#content-blockStamps).

Arguments (`args`):

```ts
{ stampId: string }
```

<a id="op-deleteBlockType"></a>
## deleteBlockType

Writes: [`content.blockTypes`](content-blocks-animators.md#content-blockTypes).

Arguments (`args`):

```ts
{ blockId: string }
```

<a id="op-deleteDialogue"></a>
## deleteDialogue

Writes: [`content.dialogues`](content-blocks-animators.md#content-dialogues).

Arguments (`args`):

```ts
{ dialogueId: string }
```

<a id="op-deleteEffect"></a>
## deleteEffect

Writes: [`content.effects`](content-blocks-animators.md#content-effects).

Arguments (`args`):

```ts
{ effectId: string }
```

<a id="op-deleteEntity"></a>
## deleteEntity

Arguments (`args`):

```ts
interface DeleteEntityArgs {
  entityId: string;
}
```

<a id="op-deleteGraph"></a>
## deleteGraph

Writes: [`content.graphs`](content-blocks-animators.md#content-graphs).

Arguments (`args`):

```ts
{ graphId: string }
```

<a id="op-deleteMaterial"></a>
## deleteMaterial

Writes: [`content.materials`](content-blocks-environment.md#content-materials).

Arguments (`args`):

```ts
{ materialId: string }
```

<a id="op-deletePrefab"></a>
## deletePrefab

Writes: [`content.prefabs`](content-blocks-save-schema.md#content-prefabs).

Arguments (`args`):

```ts
{ prefabId: string }
```

<a id="op-deleteScene"></a>
## deleteScene

Writes: [`content.scenes`](content-blocks-save-schema.md#content-scenes).

Arguments (`args`):

```ts
/** The args of the four scene-index ops, tagged with the op. */
type SceneIndexArgs =
  /** `environmentFrom`: a scene whose look the new scene copies (absent: the engine defaults). */
  | { op: 'createScene'; sceneId?: string; name: string; environmentFrom?: string }
  | { op: 'renameScene'; sceneId: string; name: string }
  | { op: 'deleteScene'; sceneId: string }
  | { op: 'setStartScenes'; sceneIds: string[] };
```

<a id="op-deleteScriptLibrary"></a>
## deleteScriptLibrary

Writes: [`content.scriptLibraries`](content-blocks-animators.md#content-scriptLibraries).

Arguments (`args`):

```ts
{ libraryId: string }
```

<a id="op-deleteSpeaker"></a>
## deleteSpeaker

Writes: [`content.speakers`](content-blocks-animators.md#content-speakers).

Arguments (`args`):

```ts
{ speakerId: string }
```

<a id="op-deleteTimeline"></a>
## deleteTimeline

Writes: [`content.timelines`](content-blocks-animators.md#content-timelines).

Arguments (`args`):

```ts
{ timelineId: string }
```

<a id="op-deleteUiDocument"></a>
## deleteUiDocument

Writes: [`content.uiDocuments`](content-blocks-animators.md#content-uiDocuments).

Arguments (`args`):

```ts
{ uiDocumentId: string }
```

<a id="op-deleteUiTheme"></a>
## deleteUiTheme

Writes: [`content.uiThemes`](content-blocks-animators.md#content-uiThemes).

Arguments (`args`):

```ts
{ uiThemeId: string }
```

<a id="op-editBlocks"></a>
## editBlocks

Arguments (`args`):

```ts
{ entityId: string; edits: BlockEdit[] }
```

Types: [`BlockEdit`](types-a-d.md#type-block-edit).

<a id="op-editTerrain"></a>
## editTerrain

Arguments (`args`):

```ts
/** `editTerrain` args (which keys a kind takes: `EDIT_TERRAIN_KEYS`). */
interface EditTerrainArgs {
  entityId: string;
  kind: EditTerrainKind;
  /** Brush kinds: the stroke's points (world x, z). */
  dabs?: [number, number][];
  /** Metres (a ramp: half its width). */
  radius?: number;
  /** raise, lower, noise: metres at the centre; the others: the blend at the centre (0–1]. */
  strength?: number;
  falloff?: BrushFalloff;
  /** flatten: the world height levelled to. */
  height?: number;
  /** noise: the size of its bumps (metres) and its seed. */
  scale?: number;
  seed?: number;
  /** ramp: its two ends (world x, y, z). */
  from?: [number, number, number];
  to?: [number, number, number];
  /** paint: the material layer painted (0–255). */
  layer?: number;
  /** paint: take hand paint back toward the baked layers; holes: fill holes back; scatter: take the rule's copies off. */
  erase?: boolean;
  /** scatter: the scatter rule whose copies the stroke puts on (or, with erase, takes off). */
  rule?: string;
  /** import: the staged file, its form, (raw16) its size and byte order, the tile it starts at, and the heights its 0 and 65535 stand for (metres above the terrain object; absent: the terrain's range). */
  stageId?: string;
  format?: HeightmapFormat;
  size?: [number, number];
  byteOrder?: 'little' | 'big';
  at?: [number, number];
  range?: [number, number];
  /** fromBlocks: the block layer object converted. */
  source?: string;
  /** bake: the material rules set and baked (absent: the terrain's own baked again — unless only `scatter` is given; empty: none, every sample layer 0 again). */
  rules?: SurfaceRule[];
  /** bake: the scatter rules set and baked (absent: the terrain's own baked again; empty: none, their copies and hand edits gone). */
  scatter?: ScatterRule[];
  /** erode: the erosion layer written (absent: "erosion"), the world box [x0, z0, x1, z1], the runs (and `seed`). */
  layerId?: string;
  rect?: [number, number, number, number];
  hydraulic?: ErosionSettings['hydraulic'];
  thermal?: ErosionSettings['thermal'];
}
```

<a id="op-graphEdit"></a>
## graphEdit

Writes: [`content.effects`](content-blocks-animators.md#content-effects), [`content.dialogues`](content-blocks-animators.md#content-dialogues), [`content.graphs`](content-blocks-animators.md#content-graphs).

Arguments (`args`):

```ts
{ owner: { kind: string; id: string }; ops: GraphOp[] }
```

Types: [`GraphOp`](types-d-p.md#type-graph-op).

<a id="op-importAssets"></a>
## importAssets

Writes: [`content.assets`](content-blocks-save-schema.md#content-assets).

Arguments (`args`):

```ts
/** `importAssets` args. */
interface ImportAssetsArgs {
  /** The folder, relative to the game folder (forward slashes). */
  folder: string;
  /** Labels every imported asset gets (besides those its own sidecar names). */
  labels?: string[];
  /** How PNG/JPEG textures in the folder are imported: encoded to KTX2 with this encoding (absent: as they are). */
  ktx2?: 'color' | 'normal' | 'data';
  /** Whether new models' images are extracted into texture assets (absent: yes; read by the host that prepares the files). */
  extractTextures?: boolean;
  /** Whether new GLB models without authored levels get generated ones (absent: no; read by the host that prepares the files). */
  generateLods?: boolean;
}
```

<a id="op-importResources"></a>
## importResources

Arguments (`args`):

```ts
/** `importResources` takes no args: the host prepared what the files hold. */
type ImportResourcesArgs = Record<string, never>;
```

<a id="op-instantiatePrefab"></a>
## instantiatePrefab

Writes: [`content.prefabs`](content-blocks-save-schema.md#content-prefabs).

Arguments (`args`):

```ts
/** `instantiatePrefab` args. */
interface InstantiatePrefabArgs {
  /** Existing definition. */
  prefabId: string;
  /** Existing entity ID or `null` (default `null`). */
  parentId?: string | null;
  /** Partial transform applied to the instance root only. */
  transform?: PartialTransformArgs;
  /** ≤ 64 `{ localId, key, value }`; `(localId, key)` unique. */
  overrides?: readonly PropertyOverride[];
}
```

<a id="op-moveEntities"></a>
## moveEntities

Arguments (`args`):

```ts
/**
 * `moveEntities`: up to 64 entities, moved with their subtrees
 * under `parentId` (null = root), just before the sibling `beforeId` or
 * (absent/null) after the parent's last child. World transforms are kept.
 */
interface MoveEntitiesArgs {
  entityIds: string[];
  parentId: string | null;
  beforeId?: string | null;
  /** Another scene to move them into (the host gives the command that scene as `otherScene`). */
  sceneId?: string;
}
```

<a id="op-moveResources"></a>
## moveResources

Arguments (`args`):

```ts
/** `moveResources` args: the items and folders moved into `to` (a folder of the game folder; `""`: its top). */
interface MoveResourcesArgs {
  items?: MoveItemRef[];
  folders?: string[];
  to: string;
}
```

<a id="op-paintInstances"></a>
## paintInstances

Arguments (`args`):

```ts
/** `paintInstances` args: the instance set and one stroke. */
interface PaintInstancesArgs extends InstanceStroke {
  entityId: string;
}
```

<a id="op-pasteEntities"></a>
## pasteEntities

Arguments (`args`):

```ts
/**
 * `pasteEntities`: create copies of full entity values in one transaction
 * (Duplicate, Copy/Paste — also across scenes). See `paste-ops.ts`.
 */
interface PasteEntitiesArgs {
  entities: { id: string; parentId?: string; components: Record<string, unknown> }[];
  /** The parent of the pasted roots (null = scene root); absent = each root's own parentId. */
  parentId?: string | null;
  /** Added to the positions of the copies placed in world space. */
  offset?: [number, number, number];
}
```

<a id="op-publishAsset"></a>
## publishAsset

Writes: [`content.assets`](content-blocks-save-schema.md#content-assets).

Arguments (`args`):

```ts
/** `publishAsset` args. */
interface PublishAssetArgs {
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
}
```

<a id="op-publishBehavior"></a>
## publishBehavior

Writes: [`content.behaviors`](content-blocks-save-schema.md#content-behaviors).

Arguments (`args`):

```ts
/** `publishBehavior` args. */
interface PublishBehaviorArgs {
  behaviorId: string;
  displayName: string;
  mode: 'declaration-create' | 'declaration-update' | 'source';
  declaration: PropertyDeclaration;
  /** Only with `mode: "source"`. */
  source?: { sourceDigest: string; sourceByteLength: number };
  /** Only with `mode: "declaration-create"` — the new behavior is a visual script with this graph. */
  graph?: GraphData;
}
```

<a id="op-redo"></a>
## redo

Arguments (`args`):

```ts
/** undo/redo args: exactly the empty object (strictly enforced at runtime). */
interface EmptyArgs {
  // intentionally empty — any field is rejected (field_unexpected)
}
```

<a id="op-renameEffect"></a>
## renameEffect

Writes: [`content.effects`](content-blocks-animators.md#content-effects).

Arguments (`args`):

```ts
{ effectId: string; name: string }
```

<a id="op-renameFolder"></a>
## renameFolder

Arguments (`args`):

```ts
/** `renameFolder` args: a folder and its new name (one path segment). */
interface RenameFolderArgs {
  folder: string;
  name: string;
}
```

<a id="op-renameScene"></a>
## renameScene

Writes: [`content.scenes`](content-blocks-save-schema.md#content-scenes).

Arguments (`args`):

```ts
/** The args of the four scene-index ops, tagged with the op. */
type SceneIndexArgs =
  /** `environmentFrom`: a scene whose look the new scene copies (absent: the engine defaults). */
  | { op: 'createScene'; sceneId?: string; name: string; environmentFrom?: string }
  | { op: 'renameScene'; sceneId: string; name: string }
  | { op: 'deleteScene'; sceneId: string }
  | { op: 'setStartScenes'; sceneIds: string[] };
```

<a id="op-revokeBehaviorTrust"></a>
## revokeBehaviorTrust

Writes: [`content.behaviorTrust`](content-blocks-save-schema.md#content-behaviorTrust).

Arguments (`args`):

```ts
{ sourceDigest: string }
```

<a id="op-setAddress"></a>
## setAddress

Writes: [`content.loadable`](content-blocks-animators.md#content-loadable), [`content.assets`](content-blocks-save-schema.md#content-assets).

Arguments (`args`):

```ts
/** `setAddress` args: one item's address (null: none). */
interface SetAddressArgs {
  kind: string;
  id: string;
  address: string | null;
}
```

<a id="op-setAnimator"></a>
## setAnimator

Writes: [`content.animators`](content-blocks-animators.md#content-animators).

Arguments (`args`):

```ts
{ controller: AnimatorController }
```

Types: [`AnimatorController`](types-a-d.md#type-animator-controller).

<a id="op-setAssetOptions"></a>
## setAssetOptions

Writes: [`content.assets`](content-blocks-save-schema.md#content-assets).

Arguments (`args`):

```ts
interface SetAssetOptionsArgs {
  assetId: string;
  vertexColors?: 'data' | 'tint';
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
  lod?: ModelLodSettings | null;
}
```

<a id="op-setBehaviorGroups"></a>
## setBehaviorGroups

Writes: [`content.behaviorGroups`](content-blocks-animators.md#content-behaviorGroups).

Arguments (`args`):

```ts
{ groups: string[] }
```

<a id="op-setBehaviorProperties"></a>
## setBehaviorProperties

Arguments (`args`):

```ts
/** `setBehaviorProperties` args. */
interface SetBehaviorPropertiesArgs {
  entityId: string;
  /** `null` removes the component. */
  behaviorId: string | null;
  /** Partial map of declared keys; omitted keys take their declaration default. */
  values?: Record<string, PropertyValue>;
}
```

<a id="op-setBlockStamp"></a>
## setBlockStamp

Writes: [`content.blockStamps`](content-blocks-animators.md#content-blockStamps).

Arguments (`args`):

```ts
{ stamp?: BlockStamp; stampId?: string; name?: string; entityId?: string; box?: number[] }
```

Types: [`BlockStamp`](types-a-d.md#type-block-stamp).

<a id="op-setBlockType"></a>
## setBlockType

Writes: [`content.blockTypes`](content-blocks-animators.md#content-blockTypes).

Arguments (`args`):

```ts
{ block: BlockType }
```

Types: [`BlockType`](types-a-d.md#type-block-type).

<a id="op-setCellFields"></a>
## setCellFields

Writes: [`content.cellFields`](content-blocks-animators.md#content-cellFields).

Arguments (`args`):

```ts
{ fields: CellField[] }
```

Types: [`CellField`](types-a-d.md#type-cell-field).

<a id="op-setCollisionLayers"></a>
## setCollisionLayers

Writes: [`content.collisionLayers`](content-blocks-animators.md#content-collisionLayers).

Arguments (`args`):

```ts
{ layers: string[] }
```

<a id="op-setComponent"></a>
## setComponent

Arguments (`args`):

```ts
/** `setComponent` args. */
interface SetComponentArgs {
  entityId: string;
  component: OwnedComponent;
  /** Non-empty partial object of that component's fields; `null` removes an
   *  add-capable component (the collider/controller pair and the six v3 ones) and is
   *  never a removal for `box`/`camera`/`model`. */
  value: Record<string, unknown> | null;
}
```

<a id="op-setDialogue"></a>
## setDialogue

Writes: [`content.dialogues`](content-blocks-animators.md#content-dialogues).

Arguments (`args`):

```ts
{ dialogue: { dialogueId: string; name: string; graph?: GraphData } }
```

Types: [`GraphData`](types-d-p.md#type-graph-data).

<a id="op-setDialogueSettings"></a>
## setDialogueSettings

Writes: [`content.dialogueSettings`](content-blocks-animators.md#content-dialogueSettings).

Arguments (`args`):

```ts
{ settings: DialogueSettings | null }
```

Types: [`DialogueSettings`](types-d-p.md#type-dialogue-settings).

<a id="op-setEffect"></a>
## setEffect

Writes: [`content.effects`](content-blocks-animators.md#content-effects).

Arguments (`args`):

```ts
{ effect: EffectDef }
```

Types: [`EffectDef`](types-d-p.md#type-effect-def).

<a id="op-setEnvironment"></a>
## setEnvironment

Writes: [`content.environment`](content-blocks-environment.md#content-environment).

Arguments (`args`):

```ts
{ environment: EnvironmentConfig | SceneEnvironment; sceneId?: string }
```

Types: [`EnvironmentConfig`](types-d-p.md#type-environment-config), [`SceneEnvironment`](types-p-w.md#type-scene-environment).

<a id="op-setEventCues"></a>
## setEventCues

Writes: [`content.eventCues`](content-blocks-animators.md#content-eventCues).

Arguments (`args`):

```ts
{ cues: EventCue[] }
```

Types: [`EventCue`](types-d-p.md#type-event-cue).

<a id="op-setGraph"></a>
## setGraph

Writes: [`content.graphs`](content-blocks-animators.md#content-graphs).

Arguments (`args`):

```ts
{ graph: GraphDocument }
```

Types: [`GraphDocument`](types-d-p.md#type-graph-document).

<a id="op-setInput"></a>
## setInput

Writes: [`content.input`](content-blocks-environment.md#content-input).

Arguments (`args`):

```ts
{ input: InputConfig | null }
```

Types: [`InputConfig`](types-d-p.md#type-input-config).

<a id="op-setLabels"></a>
## setLabels

Writes: [`content.loadable`](content-blocks-animators.md#content-loadable), [`content.assets`](content-blocks-save-schema.md#content-assets).

Arguments (`args`):

```ts
/** `setLabels` args: labels added to and removed from every item named. */
interface SetLabelsArgs {
  items: LoadableItemRef[];
  add?: string[];
  remove?: string[];
}
```

<a id="op-setLighting"></a>
## setLighting

Writes: [`content.lighting`](content-blocks-save-schema.md#content-lighting).

Arguments (`args`):

```ts
{ sceneId: string; lighting: LightingBake | null }
```

Types: [`LightingBake`](types-d-p.md#type-lighting-bake).

<a id="op-setLightLayers"></a>
## setLightLayers

Writes: [`content.lightLayers`](content-blocks-animators.md#content-lightLayers).

Arguments (`args`):

```ts
{ layers: string[] }
```

<a id="op-setMaterial"></a>
## setMaterial

Writes: [`content.materials`](content-blocks-environment.md#content-materials).

Arguments (`args`):

```ts
{ material: MaterialDef }
```

Types: [`MaterialDef`](types-d-p.md#type-material-def).

<a id="op-setModes"></a>
## setModes

Writes: [`content.modes`](content-blocks-animators.md#content-modes).

Arguments (`args`):

```ts
{ modes: GameMode[] }
```

Types: [`GameMode`](types-d-p.md#type-game-mode).

<a id="op-setSaveSchema"></a>
## setSaveSchema

Writes: [`content.saveSchema`](content-blocks-save-schema.md#content-saveSchema).

Arguments (`args`):

```ts
{ schema: SaveSchema | null }
```

Types: [`SaveSchema`](types-p-w.md#type-save-schema).

<a id="op-setScriptLibrary"></a>
## setScriptLibrary

Writes: [`content.scriptLibraries`](content-blocks-animators.md#content-scriptLibraries).

Arguments (`args`):

```ts
ScriptLibraryPatch
```

Types: [`ScriptLibraryPatch`](types-p-w.md#type-script-library-patch).

<a id="op-setSettings"></a>
## setSettings

Writes: [`content.settings`](content-blocks-save-schema.md#content-settings).

Arguments (`args`):

```ts
/** `setSettings` args. */
interface SetSettingsArgs {
  /** Non-empty partial map over the declared keys. */
  settings: SettingsMap;
}
```

<a id="op-setShell"></a>
## setShell

Writes: [`content.shell`](content-blocks-animators.md#content-shell).

Arguments (`args`):

```ts
{ shell: GameShell | null }
```

Types: [`GameShell`](types-d-p.md#type-game-shell).

<a id="op-setSpeaker"></a>
## setSpeaker

Writes: [`content.speakers`](content-blocks-animators.md#content-speakers).

Arguments (`args`):

```ts
{ speaker: DialogueSpeaker }
```

Types: [`DialogueSpeaker`](types-d-p.md#type-dialogue-speaker).

<a id="op-setStartScenes"></a>
## setStartScenes

Writes: [`content.startScenes`](content-blocks-save-schema.md#content-startScenes).

Arguments (`args`):

```ts
/** The args of the four scene-index ops, tagged with the op. */
type SceneIndexArgs =
  /** `environmentFrom`: a scene whose look the new scene copies (absent: the engine defaults). */
  | { op: 'createScene'; sceneId?: string; name: string; environmentFrom?: string }
  | { op: 'renameScene'; sceneId: string; name: string }
  | { op: 'deleteScene'; sceneId: string }
  | { op: 'setStartScenes'; sceneIds: string[] };
```

<a id="op-setTags"></a>
## setTags

Writes: [`content.tags`](content-blocks-animators.md#content-tags).

Arguments (`args`):

```ts
/**
 * `setTags`: the whole tag registry. An entry with `bit` keeps
 * that bit (a rename keeps the bit); an entry without one gets the lowest
 * free bit. A tag an entity still carries cannot be left out.
 */
interface SetTagsArgs {
  tags: { bit?: number; name: string }[];
}
```

<a id="op-setTimeline"></a>
## setTimeline

Writes: [`content.timelines`](content-blocks-animators.md#content-timelines).

Arguments (`args`):

```ts
{ timeline: TimelineAsset }
```

Types: [`TimelineAsset`](types-p-w.md#type-timeline-asset).

<a id="op-setTransform"></a>
## setTransform

Arguments (`args`):

```ts
interface SetTransformArgs {
  entityId: string;
  transform: PartialTransformArgs;
}
```

<a id="op-setUiDocument"></a>
## setUiDocument

Writes: [`content.uiDocuments`](content-blocks-animators.md#content-uiDocuments).

Arguments (`args`):

```ts
{ document: UiDocument }
```

Types: [`UiDocument`](types-p-w.md#type-ui-document).

<a id="op-setUiTheme"></a>
## setUiTheme

Writes: [`content.uiThemes`](content-blocks-animators.md#content-uiThemes).

Arguments (`args`):

```ts
{ theme: UiTheme }
```

Types: [`UiTheme`](types-p-w.md#type-ui-theme).

<a id="op-undo"></a>
## undo

Arguments (`args`):

```ts
/** undo/redo args: exactly the empty object (strictly enforced at runtime). */
interface EmptyArgs {
  // intentionally empty — any field is rejected (field_unexpected)
}
```

<a id="op-updateEntity"></a>
## updateEntity

Arguments (`args`):

```ts
/** `updateEntity` args: at least one field besides `entityId` (`parentId` null = make root). */
interface UpdateEntityArgs {
  entityId: string;
  name?: string;
  parentId?: string | null;
  active?: boolean;
  visible?: boolean;
  locked?: boolean;
  static?: boolean;
  /** The object (with its children and scripts) survives scene loads, unloads and reloads. */
  keepLoaded?: boolean;
  /** The entity's own tags, by name (replaces the whole set; [] clears). */
  tags?: string[];
}
```
