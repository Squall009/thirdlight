/**
 * The scene index of a v4 project (`content.scenes`,
 * `content.startScenes`) — create, rename and delete scenes, and choose the
 * scenes the game starts with. Each is one content change (`setSceneIndex`,
 * undone by restoring the previous index); the workspace keeps the scene
 * files in step with the index (a created scene gets an empty file, a
 * removed one loses its file — the workspace only lets an empty scene go).
 * A scene's look travels with the change (`environments`): a new scene may
 * copy another's (`environmentFrom`), and an undone delete gets its look back.
 *
 * Pure: values in, values out.
 */
import { ID_RE } from '@thirdlight/project-model';

import type { SceneEnvironment, SceneIndexEntry } from '@thirdlight/project-model';

import { fieldValue, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, SceneIndexArgs, SetSceneIndexChange } from './types';

interface SceneIndex {
  scenes: SceneIndexEntry[];
  startScenes: string[];
}

function indexOf(content: ContentDocument): SceneIndex | null {
  const c = content as { scenes?: SceneIndexEntry[]; startScenes?: string[] };
  if (!Array.isArray(c.scenes) || !Array.isArray(c.startScenes)) return null;
  return { scenes: c.scenes.map((e) => ({ ...e })), startScenes: [...c.startScenes] };
}

function notV4(): CommandError {
  return {
    code: 'invalid_request',
    cls: 'validation',
    path: '/op',
    message: 'scenes are managed only in a v4 project (one file per scene)',
    expected: 'a storageVersion 4 project',
  } as CommandError;
}

function unknownScene(path: string, sceneId: string): CommandError {
  return { code: 'reference_missing', cls: 'validation', path, reason: 'scene', found: sceneId, message: `no scene "${sceneId}" in this project` } as unknown as CommandError;
}

/** The next index after the op, or an error. */
function nextIndex(index: SceneIndex, args: SceneIndexArgs): SceneIndex | { error: CommandError } {
  const next: SceneIndex = { scenes: index.scenes.map((e) => ({ ...e })), startScenes: [...index.startScenes] };
  const ids = new Set(next.scenes.map((e) => e.sceneId));
  const has = (id: string): boolean => ids.has(id);
  switch (args.op) {
    case 'createScene': {
      let id = args.sceneId;
      if (id === undefined) {
        // A free number is at most one past the scenes the project has.
        for (let n = 1; id === undefined; n++) {
          const candidate = `scene-${String(n).padStart(4, '0')}`;
          if (!has(candidate)) id = candidate;
        }
      } else if (!ID_RE.test(id)) {
        return { error: fieldValue('/args/sceneId', id, '^[a-z0-9][a-z0-9_-]{0,63}$', 'a scene id uses the id syntax') };
      } else if (has(id)) {
        return { error: fieldValue('/args/sceneId', id, 'an unused scene id', 'a scene with this id already exists') };
      }
      next.scenes.push({ sceneId: id, name: args.name });
      return next;
    }
    case 'renameScene': {
      const entry = next.scenes.find((e) => e.sceneId === args.sceneId);
      if (entry === undefined) return { error: unknownScene('/args/sceneId', args.sceneId) };
      entry.name = args.name;
      return next;
    }
    case 'deleteScene': {
      if (!has(args.sceneId)) return { error: unknownScene('/args/sceneId', args.sceneId) };
      if (next.scenes.length === 1) return { error: fieldValue('/args/sceneId', args.sceneId, 'another scene left', 'a project keeps at least one scene') };
      next.scenes = next.scenes.filter((e) => e.sceneId !== args.sceneId);
      next.startScenes = next.startScenes.filter((id) => id !== args.sceneId);
      if (next.startScenes.length === 0) {
        return { error: fieldValue('/args/sceneId', args.sceneId, 'a scene that is not the only start scene', 'the game needs at least one start scene; choose another start scene first') };
      }
      return next;
    }
    case 'setStartScenes': {
      for (let i = 0; i < args.sceneIds.length; i++) {
        const id = args.sceneIds[i] as string;
        if (!has(id)) return { error: unknownScene(`/args/sceneIds/${i}`, id) };
      }
      // Keep the index order (the editor's scene order).
      const chosen = new Set(args.sceneIds);
      next.startScenes = next.scenes.map((e) => e.sceneId).filter((id) => chosen.has(id));
      return next;
    }
  }
}

export function applySceneIndexOp(input: OpInput, args: SceneIndexArgs, looks?: ReadonlyMap<string, SceneEnvironment>): OpOutcome {
  const catalog = contentOf(input.content);
  const index = indexOf(catalog);
  if (index === null || input.scene.schemaVersion !== 4) return { ok: false, error: notV4() };
  const next = nextIndex(index, args);
  if ('error' in next) return { ok: false, error: next.error };
  // A scene's look: the edited scene's own, another's from the host's facts.
  const lookOf = (sceneId: string): SceneEnvironment | undefined => (sceneId === input.scene.sceneId ? (input.scene as { environment?: SceneEnvironment }).environment : looks?.get(sceneId));
  const environments: Record<string, SceneEnvironment> = {};
  if (args.op === 'createScene' && args.environmentFrom !== undefined) {
    if (!index.scenes.some((e) => e.sceneId === args.environmentFrom)) return { ok: false, error: unknownScene('/args/environmentFrom', args.environmentFrom) };
    const look = lookOf(args.environmentFrom);
    const created = next.scenes[next.scenes.length - 1]!.sceneId;
    if (look !== undefined) environments[created] = deepClone(look);
  }
  if (args.op === 'deleteScene') {
    const look = lookOf(args.sceneId);
    if (look !== undefined) environments[args.sceneId] = deepClone(look);
  }
  const withLooks = Object.keys(environments).length > 0 ? { environments } : {};
  // A scene's bake goes first (one undo each, nothing dropped silently).
  if (args.op === 'deleteScene' && (catalog as { lighting?: Record<string, unknown> }).lighting?.[args.sceneId] !== undefined) {
    return { ok: false, error: fieldValue('/args/sceneId', args.sceneId, 'a scene without baked lighting', 'this scene has baked lighting; clear it first (Lighting window or setLighting {sceneId, lighting: null})') };
  }
  const nextContent = { ...catalog, scenes: next.scenes, startScenes: next.startScenes } as ContentDocument;
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: catalog }, resultScene, nextContent);
  if (!gate.ok) return gate;
  const change: SetSceneIndexChange = {
    type: 'setSceneIndex',
    previous: deepClone(index),
    next: deepClone(next),
    ...withLooks,
  };
  return {
    ok: true,
    op: { scene: gate.scene, content: gate.content, change, inverse: { kind: 'setSceneIndex', restore: deepClone(index), ...(withLooks.environments !== undefined ? { environments: deepClone(withLooks.environments) } : {}) } },
  };
}
