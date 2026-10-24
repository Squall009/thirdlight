/**
 * Undo and redo of a `prefabLinkEdit`: the change holds both sides (the
 * stored objects it replaced and put in, the prefabs before and after), so
 * either direction swaps one side for the other.
 */
import type { EntityV3 } from '@thirdlight/project-model';

import type { PrefabLinkEditChange } from './prefab-link-types';
import type { ContentDocument, SceneDocument } from './types';

/**
 * Replay a `prefabLinkEdit` (redo: forward; undo: backward): the objects of
 * one side out, the other side's in at their places, the prefabs set. Null
 * when the scene no longer holds what the change expects.
 */
export function replayLinkEdit(
  scene: SceneDocument,
  content: ContentDocument,
  change: PrefabLinkEditChange,
  forward: boolean,
): { scene: SceneDocument; content?: ContentDocument; change: PrefabLinkEditChange } | null {
  const put = forward ? change.next : change.previous;
  const take = forward ? change.previous : change.next;
  const out = new Set(take.map((t) => t.entity.id));
  const entities = scene.entities.filter((e) => !out.has(e.id)) as EntityV3[];
  if (entities.length !== scene.entities.length - out.size) return null;
  const present = new Set(entities.map((e) => e.id));
  for (const p of [...put].sort((a, b) => a.index - b.index)) {
    if (present.has(p.entity.id) || p.index > entities.length) return null;
    entities.splice(p.index, 0, JSON.parse(JSON.stringify(p.entity)) as EntityV3);
  }
  let nextContent: ContentDocument | undefined;
  if (change.prefabs !== undefined) {
    const set = new Map(change.prefabs.map((p) => [p.prefabId, forward ? p.next : p.previous]));
    if (![...set.keys()].every((id) => content.prefabs.some((d) => d.prefabId === id))) return null;
    nextContent = { ...content, prefabs: content.prefabs.map((d) => (set.has(d.prefabId) ? JSON.parse(JSON.stringify(set.get(d.prefabId))) : d)) };
  }
  const applied: PrefabLinkEditChange = forward
    ? change
    : { ...change, previous: change.next, next: change.previous, removedIds: change.next.map((n) => n.entity.id).filter((id) => !change.previous.some((p) => p.entity.id === id)), ...(change.prefabs !== undefined ? { prefabs: change.prefabs.map((p) => ({ prefabId: p.prefabId, previous: p.next, next: p.previous })) } : {}) };
  return { scene: { ...scene, revision: scene.revision + 1, entities } as SceneDocument, ...(nextContent !== undefined ? { content: nextContent } : {}), change: applied };
}
