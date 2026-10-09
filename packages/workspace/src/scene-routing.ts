/**
 * The command argument the workspace reads before the commands' validator:
 * the scene a new object goes into. Commands run on one scene at a time, so
 * the workspace picks the scene and strips the field; the validator (and so
 * its argument types) never sees it. The reference generator adds it to these
 * ops' arguments from here, so a reader learns a field the validator's types
 * cannot show. Import-free so the generator can load it alone.
 */
export const SCENE_ROUTED_ARG = 'sceneId';

/** The object-creating ops that take `sceneId`, with what it means for each. */
export const SCENE_ROUTED_CREATES: Readonly<Record<string, string>> = Object.freeze({
  createEntity: 'The scene the new object goes into. Required unless `parentId` names an object (then the object\'s scene; naming both, they must match). Missing both: refused with `field_missing` at `/args/sceneId`.',
  instantiatePrefab: 'The scene the copy goes into. Required unless `parentId` names an object (then the object\'s scene; naming both, they must match). Missing both: refused with `field_missing` at `/args/sceneId`.',
  pasteEntities: 'The scene the pasted objects go into. Required unless `parentId` names an object (then the object\'s scene; naming both, they must match). Missing both: refused with `field_missing` at `/args/sceneId`.',
  createEntities: 'The scene every new object goes into. Required unless the items\' `parentId`s name objects (all of one scene, which must match a named scene). Missing both: refused with `field_missing` at `/args/sceneId`.',
});
