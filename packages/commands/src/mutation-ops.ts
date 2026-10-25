/**
 * The mutation op names: which ops exist, which are forward (make history
 * entries), grouped by the format generation that brought them. Plain lists
 * with no other imports, so the wire layer (protocol) and MCP read the very
 * list the validator checks against. Kept apart from the wire types so adding
 * an op does not grow that file.
 */
/** The five entity/history mutation ops. Queries are workspace-served. */
export const M1_MUTATION_OPS = ['createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo'] as const;
export type M1MutationOp = (typeof M1_MUTATION_OPS)[number];

/**
 * The non-prefab content/property mutation ops. Prefab ops (`createPrefab`,
 * `instantiatePrefab`) are listed separately.
 */
export const CONTENT_MUTATION_OPS = ['publishAsset', 'publishBehavior', 'setBehaviorProperties', 'setComponent', 'setSettings', 'acknowledgeBehaviorTrust'] as const;
export type ContentMutationOp = (typeof CONTENT_MUTATION_OPS)[number];

/**
 * The prefab mutation ops.
 * `createPrefab` captures an immutable definition; `instantiatePrefab`
 * materializes independent copies in ONE transaction.
 */
export const PREFAB_MUTATION_OPS = [
  'createPrefab',
  'instantiatePrefab',
  // Linked copies: their overrides reverted or applied to the prefab, a copy unpacked, a variant of a prefab.
  'revertPrefabOverrides',
  'applyPrefabOverrides',
  'unpackPrefab',
  'createPrefabVariant',
] as const;
export type PrefabMutationOp = (typeof PREFAB_MUTATION_OPS)[number];

/**
 * The v3 presentation mutation ops:
 * `applySurfacePreset` copies a preset row.
 */
export const V3_MUTATION_OPS = [
  'applySurfacePreset',
  'updateEntity',
  // hierarchy + tags:
  'moveEntities',
  'setTags',
  'setAssetOptions',
  'pasteEntities',
  'setMaterial',
  'deleteMaterial',
  'setEnvironment',
  'setScenePlane',
  'setLighting',
  'setAnimator',
  'deleteAnimator',
  'setInput',
  'setCollisionLayers',
  'setLightLayers',
  'setSaveSchema',
  'createScene',
  'renameScene',
  'deleteScene',
  'setStartScenes',
  // graphs
  'setGraph',
  'deleteGraph',
  'graphEdit',
  // Visual effects
  'setEffect',
  'deleteEffect',
  'renameEffect',
  // Shared script libraries
  'setScriptLibrary',
  'deleteScriptLibrary',
  // Block layers
  'editBlocks',
  'setBlockType',
  'deleteBlockType',
  'setCellFields',
  'setBlockStamp',
  'deleteBlockStamp',
  // Kits
  'setKit',
  'deleteKit',
  // Project UI documents and themes
  'setUiDocument',
  'deleteUiDocument',
  'setUiTheme',
  'deleteUiTheme',
  'setDialogue',
  'deleteDialogue',
  'setSpeaker',
  'deleteSpeaker',
  'setDialogueSettings',
  // Game modes and behavior groups
  'setModes',
  'setBehaviorGroups',
  // The event → cue table
  'setEventCues',
  // The game shell
  'setShell',
  // timelines
  'setTimeline',
  'deleteTimeline',
  // Asset and prefab deletion
  'deleteAsset',
  'deletePrefab',
  // A prefab's contents replaced from an object
  'updatePrefab',
  // A folder's files as assets
  'importAssets',
  // Resource and scene files the file check found
  'importResources',
  // Bulk creation
  'createEntities',
  // Staged library edits (several patches, one commit)
  'commitScriptLibraryStage',
  // Labels and addresses (what scripts load by name)
  'setLabels',
  'setAddress',
  // The project window's file operations
  'moveResources',
  'renameFolder',
  'createFolder',
  // The instance brush (one stroke)
  'paintInstances',
  // The vertex paint brush (one stroke)
  'paintVertices',
  'colliderFromModel',
  // A terrain edit (one stroke, import or conversion)
  'editTerrain',
  // Script deletion and trust withdrawal
  'deleteBehavior',
  'revokeBehaviorTrust',
] as const;
export type V3MutationOp = (typeof V3_MUTATION_OPS)[number];

/** Every implemented mutation op. */
export type MutationOp = M1MutationOp | ContentMutationOp | PrefabMutationOp | V3MutationOp;

/** Every mutation op a request may name (the one list: records, the host, the wire and MCP check against it). */
export const MUTATION_OPS: readonly MutationOp[] = [...M1_MUTATION_OPS, ...CONTENT_MUTATION_OPS, ...PREFAB_MUTATION_OPS, ...V3_MUTATION_OPS];

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
