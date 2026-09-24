/**
 * `pasteEntities` (phase 3 leftovers, 2026-09-24): create copies of full
 * entity values — the editor's Duplicate and Copy/Paste, also across scenes —
 * in one transaction (one undo).
 *
 * The given entities keep their relative hierarchy: an entity whose
 * `parentId` names another given entity stays its child. Every copy gets a new
 * id (the usual derived prefix). References that point inside the copy are
 * remapped (a checkpoint's safe spawn, an exit zone's spawn, behavior values
 * naming a copied entity); references outside it are kept as they are, and
 * the result must validate like any other edit. The roots go under
 * `args.parentId` when it is given (null = scene root), else under their own
 * `parentId`. `offset` moves every copy that is placed in world space (no
 * copied ancestor with a transform).
 */

import { fieldValue, idExhaustion, limitsExceeded, type CommandError } from './errors';
import { deepClone, derivedPrefix, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, PasteEntitiesArgs, PasteEntitiesChange, SceneDocument } from './types';

/** Most entities one paste may create. */
export const PASTE_ENTITIES_MAX = 256;
const MAX_ENTITIES_SCENE_V4 = 16_384;
const ID_MAX = 9999;

type Value = { id: string; parentId?: string; name?: string; components: Record<string, unknown> } & Record<string, unknown>;

export function applyPasteEntities(scene: SceneDocument, args: PasteEntitiesArgs, content?: ContentDocument, reservedIds?: ReadonlySet<string>): OpOutcome {
  const given = args.entities as unknown as Value[];
  const sourceIds = new Set(given.map((e) => e.id));
  if (sourceIds.size !== given.length) return { ok: false, error: fieldValue('/args/entities', given.length, 'distinct entity ids', 'two given entities share an id') };
  const max = MAX_ENTITIES_SCENE_V4;
  if (scene.entities.length + given.length > max) return { ok: false, error: limitsExceeded('entities', scene.entities.length + given.length, max) };

  // Parents before children: roots first, then breadth first through the copy.
  const children = new Map<string, Value[]>();
  const roots: Value[] = [];
  for (const e of given) {
    if (e.parentId !== undefined && sourceIds.has(e.parentId)) {
      const list = children.get(e.parentId) ?? [];
      list.push(e);
      children.set(e.parentId, list);
    } else roots.push(e);
  }
  const ordered: Value[] = [];
  const queue = [...roots];
  while (queue.length > 0) {
    const e = queue.shift() as Value;
    ordered.push(e);
    for (const c of children.get(e.id) ?? []) queue.push(c);
  }
  if (ordered.length !== given.length) {
    return { ok: false, error: fieldValue('/args/entities', given.length, 'an acyclic set of entities', 'the given parent links form a cycle') };
  }

  // New ids (unique in this scene and across the project).
  const taken = new Set<string>([...scene.entities.map((e) => e.id), ...(reservedIds ?? [])]);
  const idMap = new Map<string, string>();
  for (const e of ordered) {
    const prefix = e.components['folder'] !== undefined ? 'folder' : derivedPrefix(e.components);
    let id: string | undefined;
    for (let n = 1; n <= ID_MAX; n += 1) {
      const candidate = `${prefix}-${String(n).padStart(4, '0')}`;
      if (!taken.has(candidate)) {
        id = candidate;
        break;
      }
    }
    if (id === undefined) return { ok: false, error: idExhaustion(prefix) };
    taken.add(id);
    idMap.set(e.id, id);
  }
  const remap = (v: unknown): unknown => (typeof v === 'string' && idMap.has(v) ? idMap.get(v) : v);

  const hasTransform = (e: Value | undefined): boolean => e !== undefined && e.components['transform'] !== undefined;
  const byId = new Map(given.map((e) => [e.id, e]));
  const inWorldSpace = (e: Value): boolean => {
    let p = e.parentId !== undefined ? byId.get(e.parentId) : undefined;
    while (p !== undefined) {
      if (hasTransform(p)) return false;
      p = p.parentId !== undefined ? byId.get(p.parentId) : undefined;
    }
    return true;
  };

  const created: Value[] = [];
  for (const e of ordered) {
    const copy = deepClone(e);
    copy.id = idMap.get(e.id) as string;
    const isRoot = e.parentId === undefined || !sourceIds.has(e.parentId);
    const parent = isRoot ? (args.parentId !== undefined ? args.parentId : (e.parentId ?? null)) : (idMap.get(e.parentId as string) as string);
    if (parent === null) delete copy.parentId;
    else copy.parentId = parent;
    const comps = copy.components;
    if (comps['camera'] !== undefined) {
      return { ok: false, error: fieldValue('/args/entities', e.id, 'entities without a camera', 'a scene has one camera; copy the objects without it') };
    }
    const zone = comps['gameZone'] as { safeSpawnId?: unknown; spawnId?: unknown } | undefined;
    if (zone !== undefined) {
      if (zone.safeSpawnId !== undefined) zone.safeSpawnId = remap(zone.safeSpawnId);
      if (zone.spawnId !== undefined) zone.spawnId = remap(zone.spawnId);
    }
    const behavior = comps['behavior'] as { values?: Record<string, unknown> } | undefined;
    if (behavior?.values !== undefined) for (const k of Object.keys(behavior.values)) behavior.values[k] = remap(behavior.values[k]);
    const t = comps['transform'] as { position?: number[] } | undefined;
    if (args.offset !== undefined && t?.position !== undefined && inWorldSpace(e)) {
      t.position = t.position.map((v, i) => round6(v + (args.offset?.[i] ?? 0)));
    }
    created.push(copy);
  }

  const result = { ...scene, revision: scene.revision + 1, entities: [...scene.entities, ...(created as unknown as SceneDocument['entities'])] };
  const gate = gateResultState({ scene, content }, result, content);
  if (!gate.ok) return gate;
  const committed = created.map((c) => deepClone(gate.scene.entities.find((x) => x.id === c.id)!));
  const change: PasteEntitiesChange = { type: 'pasteEntities', entities: committed as unknown as PasteEntitiesChange['entities'] };
  const first = committed[0] as unknown as { id: string };
  return {
    ok: true,
    op: {
      scene: gate.scene,
      change,
      inverse: { kind: 'removeEntities', ids: committed.map((c) => (c as unknown as { id: string }).id) },
      createdId: first.id,
    },
  };
}

function round6(v: number): number {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

/** Arg validation for `pasteEntities` (shape only; values are the model's job). */
export function validatePasteArgs(args: Record<string, unknown>):
  | { ok: true; args: PasteEntitiesArgs }
  | { ok: false; error: CommandError } {
  for (const key of Object.keys(args)) {
    if (key !== 'entities' && key !== 'parentId' && key !== 'offset') {
      return { ok: false, error: { code: 'field_unexpected', cls: 'validation', path: `/args/${key}`, found: key, expected: 'entities, parentId (optional), offset (optional)', message: `unknown field "${key}"` } as unknown as CommandError };
    }
  }
  const entities = args['entities'];
  if (!Array.isArray(entities) || entities.length < 1 || entities.length > PASTE_ENTITIES_MAX) {
    return { ok: false, error: fieldValue('/args/entities', Array.isArray(entities) ? entities.length : entities, `array of 1-${PASTE_ENTITIES_MAX} entity values`, `a paste creates 1 to ${PASTE_ENTITIES_MAX} entities`) };
  }
  for (let i = 0; i < entities.length; i += 1) {
    const e = entities[i] as Record<string, unknown> | null;
    if (typeof e !== 'object' || e === null || Array.isArray(e) || typeof e['id'] !== 'string' || typeof e['components'] !== 'object' || e['components'] === null) {
      return { ok: false, error: fieldValue(`/args/entities/${i}`, e, 'an entity value { id, components, ... }', 'each pasted entity is a full entity value') };
    }
  }
  const parentId = args['parentId'];
  if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
    return { ok: false, error: fieldValue('/args/parentId', parentId, 'an entity id or null', 'parentId names the parent of the pasted roots') };
  }
  const offset = args['offset'];
  if (offset !== undefined && (!Array.isArray(offset) || offset.length !== 3 || !offset.every((v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e6))) {
    return { ok: false, error: fieldValue('/args/offset', offset, '[x, y, z] finite numbers', 'offset moves the pasted roots') };
  }
  return {
    ok: true,
    args: {
      entities: entities as PasteEntitiesArgs['entities'],
      ...(parentId !== undefined ? { parentId: parentId as string | null } : {}),
      ...(offset !== undefined ? { offset: offset as [number, number, number] } : {}),
    },
  };
}
