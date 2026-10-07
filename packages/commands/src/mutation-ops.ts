/**
 * The mutation op names: which ops exist, which are forward (make history
 * entries), grouped by the format generation that brought them. Kept apart
 * from the wire types so adding an op does not grow that file.
 */
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
  // Light layer names (editor labels)
  | 'setLightLayers'
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
  // Every supported file of a folder as assets, with labels (one undo)
  | 'importAssets'
  // Resource and scene files the file check found (one undo)
  | 'importResources'
  // Many entities in one transaction (one revision, one undo)
  | 'createEntities'
  // Labels on many assets and resources, and one's address (one undo each)
  | 'setLabels'
  | 'setAddress'
  // The project window: files and folders moved, a folder renamed or made (one undo each)
  | 'moveResources'
  | 'renameFolder'
  | 'createFolder'
  // An instance set painted or erased with the brush (one stroke, one undo)
  | 'paintInstances'
  // An object's collider made from its model file (one undo)
  | 'colliderFromModel'
  // A terrain's tiles sculpted, painted, cut, imported or converted (one edit, one undo)
  | 'editTerrain';

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
