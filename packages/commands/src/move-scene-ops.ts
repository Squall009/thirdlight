/**
 * `moveEntities` with a `sceneId`: entities (with their subtrees) move from
 * the scene they are in into another scene of the project, keeping their ids
 * (so every reference to them still holds) and their world transforms, filed
 * under a parent of the destination (or at its root), before a sibling or at
 * the end. One transaction edits both scenes; its undo puts the objects back
 * where they were, its redo moves them again.
 *
 * The host gives the command the destination as `otherScene` (for an undo or
 * redo: the scene the entry's objects are in now, besides the carrier).
 */
import type { EntityV3 } from '@thirdlight/project-model';

import { entityNotFound, fieldValue, historyInvalid, referenceMissing } from './errors';
import { closureInArrayOrder, deepClone, entitiesById, folderParentError, gateResultState, isFolder, subtreeClosure, type AnyEntity } from './ops';
import type { CommandError, ContentDocument, MoveEntitiesArgs, MoveEntitiesSceneChange, MoveEntitiesSceneInverse, SceneDocument } from './types';
import { worldKeepingLocal, type HierarchyNode } from './world-transform';

export interface SceneMoveResult {
  /** The carrier scene after (the source of a forward move). */
  scene: SceneDocument;
  otherScene: { sceneId: string; scene: SceneDocument };
  change: MoveEntitiesSceneChange;
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: CommandError };

/** Where moved objects go in `order`: before `beforeId`, after the parent's last descendant, or at the end. */
function insertAt(target: SceneDocument, parentId: string | null, beforeId: string | null, without: ReadonlySet<string>): number {
  const ids = target.entities.map((e) => e.id).filter((id) => !without.has(id));
  if (beforeId !== null) return ids.indexOf(beforeId);
  if (parentId === null) return ids.length;
  const inside = new Set(subtreeClosure(target, parentId) ?? [parentId]);
  let at = ids.indexOf(parentId) + 1;
  while (at < ids.length && inside.has(ids[at]!)) at += 1;
  return at;
}

/** Both scenes through the result gate (each as its own scene; the host checks the whole project). */
function gateBoth(
  from: SceneDocument,
  fromNext: unknown,
  to: SceneDocument,
  toNext: unknown,
  content: ContentDocument | undefined,
): Outcome<{ from: SceneDocument; to: SceneDocument }> {
  const a = content !== undefined ? gateResultState({ scene: from, content }, fromNext, content) : gateResultState({ scene: from }, fromNext);
  if (!a.ok) return a;
  const b = content !== undefined ? gateResultState({ scene: to, content }, toNext, content) : gateResultState({ scene: to }, toNext);
  if (!b.ok) return b;
  return { ok: true, value: { from: a.scene, to: b.scene } };
}

/** The forward move from `scene` (the carrier) into `other.scene`. */
export function applyMoveEntitiesScene(
  scene: SceneDocument,
  other: { sceneId: string; scene: SceneDocument },
  args: MoveEntitiesArgs,
  content?: ContentDocument,
): { ok: true; result: SceneMoveResult; inverse: MoveEntitiesSceneInverse } | { ok: false; error: CommandError } {
  const src = entitiesById(scene);
  const dst = entitiesById(other.scene);
  for (const id of args.entityIds) if (!src.has(id)) return { ok: false, error: entityNotFound(id) };
  const parentId = args.parentId;
  const beforeId = args.beforeId ?? null;
  if (parentId !== null && !dst.has(parentId)) return { ok: false, error: referenceMissing(parentId) };
  if (beforeId !== null) {
    const before = dst.get(beforeId);
    if (before === undefined) return { ok: false, error: referenceMissing(beforeId) };
    if ((before.parentId ?? null) !== parentId) return { ok: false, error: fieldValue('/args/beforeId', beforeId, 'a child of parentId', 'beforeId must be a sibling under the target parent') };
  }
  // An entity whose ancestor is also named moves with that ancestor.
  const named = new Set(args.entityIds);
  const hasNamedAncestor = (id: string): boolean => {
    for (let cur = src.get(id)?.parentId, guard = 0; cur !== undefined && guard < src.size; cur = src.get(cur)?.parentId, guard += 1) if (named.has(cur)) return true;
    return false;
  };
  const roots = scene.entities.map((e) => e.id).filter((id) => named.has(id) && !hasNamedAncestor(id));
  const moving = new Set<string>();
  for (const root of roots) {
    if (isFolder(src.get(root)) && parentId !== null && !isFolder(dst.get(parentId))) return { ok: false, error: folderParentError('/args/parentId', parentId) };
    for (const id of closureInArrayOrder(scene, subtreeClosure(scene, root) ?? [root])) moving.add(id);
  }
  // World transforms kept: the scenes share one world, so the two hierarchies are read as one.
  const nodes = new Map<string, HierarchyNode>([...src, ...dst] as [string, AnyEntity][] as unknown as [string, HierarchyNode][]);
  const rootSet = new Set(roots);
  const arriving: EntityV3[] = [];
  for (const e of scene.entities) {
    if (!moving.has(e.id)) continue;
    const doc = deepClone(e) as unknown as Record<string, unknown>;
    if (rootSet.has(e.id)) {
      delete doc['parentId'];
      const local = (e as AnyEntity).components.transform;
      const kept = local === undefined ? null : (worldKeepingLocal(nodes, e.id, parentId) ?? local);
      const placed: Record<string, unknown> = { id: doc['id'] };
      for (const [k, v] of Object.entries(doc)) {
        if (k === 'id') continue;
        if (k === 'components' && parentId !== null) placed['parentId'] = parentId;
        placed[k] = k === 'components' && kept !== null ? { ...(v as Record<string, unknown>), transform: deepClone(kept) } : v;
      }
      arriving.push(placed as unknown as EntityV3);
    } else arriving.push(doc as unknown as EntityV3);
  }
  const at = insertAt(other.scene, parentId, beforeId, new Set());
  const rest = [...other.scene.entities];
  const toEntities = [...rest.slice(0, at), ...arriving, ...rest.slice(at)];
  const fromNext = { ...scene, revision: scene.revision + 1, entities: scene.entities.filter((e) => !moving.has(e.id)) };
  const toNext = { ...other.scene, revision: other.scene.revision + 1, entities: toEntities };
  const gated = gateBoth(scene, fromNext, other.scene, toNext, content);
  if (!gated.ok) return gated;
  const after = new Map(gated.value.to.entities.map((e) => [e.id, e as EntityV3]));
  const change: MoveEntitiesSceneChange = {
    type: 'moveEntitiesScene',
    fromSceneId: scene.sceneId,
    toSceneId: other.sceneId,
    parentId,
    entities: arriving.map((e) => deepClone(after.get(e.id) ?? e)),
    toOrder: gated.value.to.entities.map((e) => e.id),
  };
  const inverse: MoveEntitiesSceneInverse = {
    kind: 'moveEntitiesScene',
    restore: scene.entities.filter((e) => moving.has(e.id)).map((e) => deepClone(e) as EntityV3),
    order: scene.entities.map((e) => e.id),
  };
  return { ok: true, result: { scene: gated.value.from, otherScene: { sceneId: other.sceneId, scene: gated.value.to }, change }, inverse };
}

/**
 * Put objects into `into` (taking them out of `outOf`): an undo (the
 * objects as they were, at their old place in the order) or a redo (as the
 * move left them). `intoIsCarrier` says which of the two is the command's
 * carrier scene (the result keeps that role).
 */
export function replaySceneMove(
  carrier: SceneDocument,
  other: { sceneId: string; scene: SceneDocument } | undefined,
  objects: readonly EntityV3[],
  intoOrder: readonly string[],
  intoIsCarrier: boolean,
  parentId: string | null,
  requestId: string,
  content: ContentDocument | undefined,
): { ok: true; result: SceneMoveResult } | { ok: false; error: CommandError } {
  if (other === undefined) return { ok: false, error: historyInvalid(requestId) };
  const into = intoIsCarrier ? carrier : other.scene;
  const outOf = intoIsCarrier ? other.scene : carrier;
  const ids = new Set(objects.map((e) => e.id));
  const present = new Set(outOf.entities.map((e) => e.id));
  for (const id of ids) if (!present.has(id)) return { ok: false, error: historyInvalid(requestId) };
  const byId = new Map<string, unknown>([...into.entities.map((e) => [e.id, e] as const), ...objects.map((e) => [e.id, deepClone(e)] as const)]);
  const order = intoOrder.filter((id) => byId.has(id));
  if (order.length !== byId.size) return { ok: false, error: historyInvalid(requestId) };
  const intoNext = { ...into, revision: into.revision + 1, entities: order.map((id) => byId.get(id)) };
  const outOfNext = { ...outOf, revision: outOf.revision + 1, entities: outOf.entities.filter((e) => !ids.has(e.id)) };
  const gated = gateBoth(outOf, outOfNext, into, intoNext, content);
  if (!gated.ok) return { ok: false, error: historyInvalid(requestId) };
  const fromScene = intoIsCarrier ? other.sceneId : carrier.sceneId;
  const toScene = intoIsCarrier ? carrier.sceneId : other.sceneId;
  const after = new Map(gated.value.to.entities.map((e) => [e.id, e as EntityV3]));
  const change: MoveEntitiesSceneChange = {
    type: 'moveEntitiesScene',
    fromSceneId: fromScene,
    toSceneId: toScene,
    parentId,
    entities: objects.map((e) => deepClone(after.get(e.id) ?? e)),
    toOrder: gated.value.to.entities.map((e) => e.id),
  };
  return {
    ok: true,
    result: intoIsCarrier
      ? { scene: gated.value.to, otherScene: { sceneId: other.sceneId, scene: gated.value.from }, change }
      : { scene: gated.value.from, otherScene: { sceneId: other.sceneId, scene: gated.value.to }, change },
  };
}
