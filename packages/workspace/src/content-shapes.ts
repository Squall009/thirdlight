/**
 * Typed readers between the model's v4 shapes and the command layer's.
 *
 * The session holds a v4 project as the model validated it
 * (`ContentCatalogV4`, `SceneV4`); the pure command layer reads and returns
 * the same values under its own names (`ContentDocument`, `SceneDocument`),
 * which describe the records by their older fields. Each reader checks the
 * keys that tell the shapes apart and narrows, so a value of the wrong shape
 * fails here instead of travelling on under a cast.
 */

import type { CommandError, ContentDocument, SceneDocument } from '@thirdlight/commands';
import type { ContentCatalogV4, ModelErrorV3, SceneV4 } from '@thirdlight/project-model';

function isCommandContent(c: ContentDocument | ContentCatalogV4): c is ContentDocument {
  return Array.isArray(c.assets) && Array.isArray(c.prefabs) && Array.isArray(c.behaviors) && typeof c.settings === 'object' && c.settings !== null && typeof c.behaviorTrust === 'object' && c.behaviorTrust !== null;
}

function isCatalogV4(c: ContentDocument | ContentCatalogV4): c is ContentCatalogV4 {
  return isCommandContent(c) && Array.isArray((c as { scenes?: unknown }).scenes) && Array.isArray((c as { startScenes?: unknown }).startScenes);
}

/** A v4 content block as the command layer reads it. */
export function commandContentOf(content: ContentCatalogV4): ContentDocument {
  const view: ContentDocument | ContentCatalogV4 = content;
  if (!isCommandContent(view)) throw new Error('a v4 content block without its asset, prefab and behavior lists');
  return view;
}

/** A command's resulting content block, read back as the v4 block it is (it has the scene index). */
export function catalogV4Of(content: ContentDocument): ContentCatalogV4 {
  const view: ContentDocument | ContentCatalogV4 = content;
  if (!isCatalogV4(view)) throw new Error('a v4 command returned a content block without the scene index');
  return view;
}

/** A command's resulting scene of a v4 project. */
export function sceneV4Of(scene: SceneDocument): SceneV4 {
  if (scene.schemaVersion !== 4) throw new Error(`a v4 command returned a scene of schemaVersion ${String(scene.schemaVersion)}`);
  return scene;
}

/** The rules across a v4 project's scenes refused the result (the first ten problems). */
export function projectRuleError(errors: readonly ModelErrorV3[]): CommandError {
  const first = errors[0];
  return {
    code: first?.code ?? 'field_value',
    cls: 'validation',
    detailDocument: 'project',
    details: errors.slice(0, 10),
    detailCount: errors.length,
    message: `the resulting project fails a rule across scenes: ${first?.message ?? 'unknown'}`,
    hint: 'fix the request (ids are unique across scenes; the start scenes hold the camera and the player)',
  };
}

/** A scene id that names no scene of the project. */
export function sceneMissing(found: unknown): CommandError {
  return { code: 'reference_missing', cls: 'validation', path: '/args/sceneId', reason: 'scene', found, message: 'no such scene in this project' };
}

/** A new object needs a scene: there is no default one (the editor sends the scene it has active). */
export function sceneRequired(): CommandError {
  return {
    code: 'field_missing',
    cls: 'validation',
    path: '/args/sceneId',
    message: 'a new object goes into a scene: name it (sceneId) or a parent (parentId)',
    expected: 'sceneId of a scene of the project, or the id of a parent object',
  };
}

/** One command's entities are in more than one scene. */
export function crossSceneEntities(path: string): CommandError {
  return {
    code: 'field_value',
    cls: 'validation',
    path,
    message: 'the entities of one command must be in one scene (moveEntities with a sceneId moves them into another)',
    expected: 'entities of a single scene',
  };
}

/** A scene that still holds entities cannot be deleted. */
export function sceneNotEmpty(sceneId: unknown, count: number): CommandError {
  return {
    code: 'field_value',
    cls: 'validation',
    path: '/args/sceneId',
    found: sceneId,
    expected: 'an empty scene',
    message: `scene "${String(sceneId)}" still holds ${count} entities; delete them (or move them out) first`,
  };
}
