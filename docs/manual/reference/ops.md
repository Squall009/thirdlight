# Command ops

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

Every edit of a project is a command (the one mutation path; the editor and MCP send the same ops). A request names its `op`, the project, the revision it expects and its `args`; the backend validates it strictly (an unknown field is refused) and answers with the new revision and the change, or an error naming the field.

<a id="op-request"></a>
## The request

```ts
/**
 * The mutation request envelope. This type documents the wire
 * shape; `applyMutation` accepts `unknown` and validates strictly.
 */
interface MutationRequest {
  op: MutationOp;
  projectId: string;
  expectedRevision: number;
  /** `req-` + 32 lowercase hex chars (client-generated CSPRNG). */
  requestId: string;
  origin?: Origin;
  args: MutationArgs;
}
```

Results:

```ts
/** Mutation success; canonical key order in emitted payloads. */
interface MutationSuccess {
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
interface MutationFailure {
  ok: false;
  op?: string;
  projectId?: string;
  requestId?: string;
  error: CommandError;
}
```

<a id="op-index"></a>
## Every op

| Op | Arguments | Writes |
|---|---|---|
| [`acknowledgeBehaviorTrust`](ops-detail.md#op-acknowledgeBehaviorTrust) | AcknowledgeBehaviorTrustArgs | `behaviorTrust` |
| [`applySurfacePreset`](ops-detail.md#op-applySurfacePreset) | ApplySurfacePresetArgs |  |
| [`colliderFromModel`](ops-detail.md#op-colliderFromModel) | ColliderFromModelArgs |  |
| [`commitScriptLibraryStage`](ops-detail.md#op-commitScriptLibraryStage) | { stageId: string } |  |
| [`createEntities`](ops-detail.md#op-createEntities) | { entities: (CreateEntityArgs & { ref?: string })[] } |  |
| [`createEntity`](ops-detail.md#op-createEntity) | CreateEntityArgs |  |
| [`createFolder`](ops-detail.md#op-createFolder) | CreateFolderArgs |  |
| [`createPrefab`](ops-detail.md#op-createPrefab) | CreatePrefabArgs | `prefabs` |
| [`createScene`](ops-detail.md#op-createScene) | SceneIndexArgs | `scenes` |
| [`deleteAnimator`](ops-detail.md#op-deleteAnimator) | { controllerId: string } | `animators` |
| [`deleteAsset`](ops-detail.md#op-deleteAsset) | { assetId: string } | `assets` |
| [`deleteBehavior`](ops-detail.md#op-deleteBehavior) | { behaviorId: string } | `behaviors` |
| [`deleteBlockStamp`](ops-detail.md#op-deleteBlockStamp) | { stampId: string } | `blockStamps` |
| [`deleteBlockType`](ops-detail.md#op-deleteBlockType) | { blockId: string } | `blockTypes` |
| [`deleteDialogue`](ops-detail.md#op-deleteDialogue) | { dialogueId: string } | `dialogues` |
| [`deleteEffect`](ops-detail.md#op-deleteEffect) | { effectId: string } | `effects` |
| [`deleteEntity`](ops-detail.md#op-deleteEntity) | DeleteEntityArgs |  |
| [`deleteGraph`](ops-detail.md#op-deleteGraph) | { graphId: string } | `graphs` |
| [`deleteMaterial`](ops-detail.md#op-deleteMaterial) | { materialId: string } | `materials` |
| [`deletePrefab`](ops-detail.md#op-deletePrefab) | { prefabId: string } | `prefabs` |
| [`deleteScene`](ops-detail.md#op-deleteScene) | SceneIndexArgs | `scenes` |
| [`deleteScriptLibrary`](ops-detail.md#op-deleteScriptLibrary) | { libraryId: string } | `scriptLibraries` |
| [`deleteSpeaker`](ops-detail.md#op-deleteSpeaker) | { speakerId: string } | `speakers` |
| [`deleteTimeline`](ops-detail.md#op-deleteTimeline) | { timelineId: string } | `timelines` |
| [`deleteUiDocument`](ops-detail.md#op-deleteUiDocument) | { uiDocumentId: string } | `uiDocuments` |
| [`deleteUiTheme`](ops-detail.md#op-deleteUiTheme) | { uiThemeId: string } | `uiThemes` |
| [`editBlocks`](ops-detail.md#op-editBlocks) | { entityId: string; edits: BlockEdit[] } |  |
| [`editTerrain`](ops-detail.md#op-editTerrain) | EditTerrainArgs |  |
| [`graphEdit`](ops-detail.md#op-graphEdit) | { owner: { kind: string; id: string }; ops: GraphOp[] } | `effects`, `dialogues`, `graphs` |
| [`importAssets`](ops-detail.md#op-importAssets) | ImportAssetsArgs | `assets` |
| [`importResources`](ops-detail.md#op-importResources) | ImportResourcesArgs |  |
| [`instantiatePrefab`](ops-detail.md#op-instantiatePrefab) | InstantiatePrefabArgs | `prefabs` |
| [`moveEntities`](ops-detail.md#op-moveEntities) | MoveEntitiesArgs |  |
| [`moveResources`](ops-detail.md#op-moveResources) | MoveResourcesArgs |  |
| [`paintInstances`](ops-detail.md#op-paintInstances) | PaintInstancesArgs |  |
| [`pasteEntities`](ops-detail.md#op-pasteEntities) | PasteEntitiesArgs |  |
| [`publishAsset`](ops-detail.md#op-publishAsset) | PublishAssetArgs | `assets` |
| [`publishBehavior`](ops-detail.md#op-publishBehavior) | PublishBehaviorArgs | `behaviors` |
| [`redo`](ops-detail.md#op-redo) | EmptyArgs |  |
| [`renameEffect`](ops-detail.md#op-renameEffect) | { effectId: string; name: string } | `effects` |
| [`renameFolder`](ops-detail.md#op-renameFolder) | RenameFolderArgs |  |
| [`renameScene`](ops-detail.md#op-renameScene) | SceneIndexArgs | `scenes` |
| [`revokeBehaviorTrust`](ops-detail.md#op-revokeBehaviorTrust) | { sourceDigest: string } | `behaviorTrust` |
| [`setAddress`](ops-detail.md#op-setAddress) | SetAddressArgs | `loadable`, `assets` |
| [`setAnimator`](ops-detail.md#op-setAnimator) | { controller: AnimatorController } | `animators` |
| [`setAssetOptions`](ops-detail.md#op-setAssetOptions) | SetAssetOptionsArgs | `assets` |
| [`setBehaviorGroups`](ops-detail.md#op-setBehaviorGroups) | { groups: string[] } | `behaviorGroups` |
| [`setBehaviorProperties`](ops-detail.md#op-setBehaviorProperties) | SetBehaviorPropertiesArgs |  |
| [`setBlockStamp`](ops-detail.md#op-setBlockStamp) | { stamp?: BlockStamp; stampId?: string; name?: string; entityId?: string; box?: number[] } | `blockStamps` |
| [`setBlockType`](ops-detail.md#op-setBlockType) | { block: BlockType } | `blockTypes` |
| [`setCellFields`](ops-detail.md#op-setCellFields) | { fields: CellField[] } | `cellFields` |
| [`setCollisionLayers`](ops-detail.md#op-setCollisionLayers) | { layers: string[] } | `collisionLayers` |
| [`setComponent`](ops-detail.md#op-setComponent) | SetComponentArgs |  |
| [`setDialogue`](ops-detail.md#op-setDialogue) | { dialogue: { dialogueId: string; name: string; graph?: GraphData } } | `dialogues` |
| [`setDialogueSettings`](ops-detail.md#op-setDialogueSettings) | { settings: DialogueSettings \| null } | `dialogueSettings` |
| [`setEffect`](ops-detail.md#op-setEffect) | { effect: EffectDef } | `effects` |
| [`setEnvironment`](ops-detail.md#op-setEnvironment) | { environment: EnvironmentConfig \| SceneEnvironment; sceneId?: string } | `environment` |
| [`setEventCues`](ops-detail.md#op-setEventCues) | { cues: EventCue[] } | `eventCues` |
| [`setGraph`](ops-detail.md#op-setGraph) | { graph: GraphDocument } | `graphs` |
| [`setInput`](ops-detail.md#op-setInput) | { input: InputConfig \| null } | `input` |
| [`setLabels`](ops-detail.md#op-setLabels) | SetLabelsArgs | `loadable`, `assets` |
| [`setLighting`](ops-detail.md#op-setLighting) | { sceneId: string; lighting: LightingBake \| null } | `lighting` |
| [`setLightLayers`](ops-detail.md#op-setLightLayers) | { layers: string[] } | `lightLayers` |
| [`setMaterial`](ops-detail.md#op-setMaterial) | { material: MaterialDef } | `materials` |
| [`setModes`](ops-detail.md#op-setModes) | { modes: GameMode[] } | `modes` |
| [`setSaveSchema`](ops-detail.md#op-setSaveSchema) | { schema: SaveSchema \| null } | `saveSchema` |
| [`setScriptLibrary`](ops-detail.md#op-setScriptLibrary) | ScriptLibraryPatch | `scriptLibraries` |
| [`setSettings`](ops-detail.md#op-setSettings) | SetSettingsArgs | `settings` |
| [`setShell`](ops-detail.md#op-setShell) | { shell: GameShell \| null } | `shell` |
| [`setSpeaker`](ops-detail.md#op-setSpeaker) | { speaker: DialogueSpeaker } | `speakers` |
| [`setStartScenes`](ops-detail.md#op-setStartScenes) | SceneIndexArgs | `startScenes` |
| [`setTags`](ops-detail.md#op-setTags) | SetTagsArgs | `tags` |
| [`setTimeline`](ops-detail.md#op-setTimeline) | { timeline: TimelineAsset } | `timelines` |
| [`setTransform`](ops-detail.md#op-setTransform) | SetTransformArgs |  |
| [`setUiDocument`](ops-detail.md#op-setUiDocument) | { document: UiDocument } | `uiDocuments` |
| [`setUiTheme`](ops-detail.md#op-setUiTheme) | { theme: UiTheme } | `uiThemes` |
| [`undo`](ops-detail.md#op-undo) | EmptyArgs |  |
| [`updateEntity`](ops-detail.md#op-updateEntity) | UpdateEntityArgs |  |
