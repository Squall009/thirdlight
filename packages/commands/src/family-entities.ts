/**
 * Scene objects: create, transform, header, hierarchy and scene moves,
 * paste and delete. Each op's step and the undo and redo of what it records.
 */

import type { OpFamily } from './op-table-types';
import { assembledView } from './prefab-copy-edit';
import { applyMoveEntitiesScene, replaySceneMove } from './move-scene-ops';
import { applyPasteEntities } from './paste-ops';
import { withLayerData, withoutLayersOf } from './block-ops';
import { historyInvalid, type CommandError } from './errors';
import { applyHeader, applyMove, finish, requireEntity } from './history-steps';
import {
  applyCreateEntities,
  applyCreateEntity,
  applyDeleteEntity,
  applyMoveEntities,
  applySetTransform,
  applyUpdateEntity,
  deepClone,
  subtreeClosure,
  type AnyEntity,
} from './ops';
import type { EntityV3, TransformComponent } from '@thirdlight/project-model';
import type { ChangeData, DeleteEntityChange, MoveEntitiesChange, RestoreSubtreeChange, SceneDocument, SetTransformChange } from './types';

export const entityFamily = {
  ops: {
    createEntity: { apply: (input, args, state) => applyCreateEntity(input.scene, args, state.content, input.reservedIds), records: [['createEntity', 'delete']] },
    // Several creates, one transaction (one revision, one undo).
    createEntities: { apply: (input, args, state) => applyCreateEntities(input.scene, args, state.content, input.reservedIds), records: [['pasteEntities', 'removeEntities']] },
    setTransform: { apply: (input, args, state) => applySetTransform(input.scene, args, state.content), records: [['setTransform', 'setTransform']] },
    updateEntity: { apply: (input, args, state) => applyUpdateEntity(input.scene, args, state.content), records: [['updateEntity', 'updateEntity']] },
    pasteEntities: { apply: (input, args, state) => applyPasteEntities(input.scene, args, state.content, input.reservedIds), records: [['pasteEntities', 'removeEntities']] },
    moveEntities: {
      apply: (input, args, state) => {
        // Into another scene: the host gave the command that scene.
        if (args.sceneId !== undefined) {
          const other = state.otherScene;
          if (other === undefined || other.sceneId !== args.sceneId) return { ok: false, error: { code: 'reference_missing', cls: 'validation', path: '/args/sceneId', reason: 'scene', found: args.sceneId, message: 'no such scene in this project' } as CommandError };
          const m = applyMoveEntitiesScene(input.scene, other, args, state.content);
          if (!m.ok) return m;
          return { ok: true, op: { scene: m.result.scene, change: m.result.change, inverse: m.inverse, otherScene: m.result.otherScene } };
        }
        return applyMoveEntities(input.scene, args, state.content);
      },
      records: [['moveEntities', 'moveEntities'], ['moveEntitiesScene', 'moveEntitiesScene']],
    },
    deleteEntity: { apply: (input, args, state) => applyDeleteEntity(input.scene, args, state.content, assembledView(input.scene, state.content)), records: [['deleteEntity', 'restoreSubtree']] },
  },
  undo: {
    updateEntity: (state, entry, inv) => {
      return applyHeader(state, inv.id, inv.restore, inv.order, entry.requestId, inv.transform);
    },
    moveEntities: (state, entry, inv) => {
      const f = entry.change as MoveEntitiesChange;
      return applyMove(state, inv.order, inv.restore, f.entities[0]?.previous.parentId ?? null, null, entry.requestId);
    },
    moveEntitiesScene: (state, entry, inv) => {
      const scene = state.scene;
      // The objects go back to the carrier (the scene they came from), as they were.
      const r = replaySceneMove(scene, state.otherScene, inv.restore, inv.order, true, inv.restore[0]?.parentId ?? null, entry.requestId, state.content);
      if (!r.ok) return r;
      return { ok: true, applied: { scene: r.result.scene, content: state.content, change: r.result.change, otherScene: r.result.otherScene } };
    },
    delete: (state, entry, inv) => {
      const scene = state.scene;
      // Undo of a createEntity/instantiatePrefab: subtree deletion at undo time.
      const closure = subtreeClosure(scene, inv.rootId);
      if (closure === null) return { ok: false, error: historyInvalid(entry.requestId) };
      const closureSet = new Set(closure);
      const nextEntities = scene.entities.filter((e) => !closureSet.has(e.id));
      const index = new Map(scene.entities.map((e, i) => [e.id, i]));
      const deletedIds = [...closure].sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
      const change: DeleteEntityChange = { type: 'deleteEntity', rootId: inv.rootId, deletedIds };
      const result = { ...withoutLayersOf(scene, closureSet).scene, revision: scene.revision + 1, entities: nextEntities };
      return finish(state, result, state.content, change, entry.requestId);
    },
    setTransform: (state, entry, inv) => {
      const scene = state.scene;
      const index = requireEntity(scene, inv.id);
      if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
      const current = scene.entities[index] as AnyEntity;
      const restore: TransformComponent = {
        position: [...inv.restore.position],
        rotation: [...inv.restore.rotation],
        scale: [...inv.restore.scale],
      };
      const cloned = deepClone(current);
      const newEntity = { ...cloned, components: { ...cloned.components, transform: restore } };
      const nextEntities = [...scene.entities];
      nextEntities[index] = newEntity as unknown as EntityV3;
      const change: SetTransformChange = {
        type: 'setTransform',
        id: inv.id,
        previous: deepClone(current.components.transform as TransformComponent),
        next: deepClone(restore),
        changedFields: ['position', 'rotation', 'scale'],
      };
      const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
      return finish(state, result, state.content, change, entry.requestId);
    },
    restoreSubtree: (state, entry, inv) => {
      const scene = state.scene;
      let ents: AnyEntity[] = deepClone(scene.entities) as AnyEntity[];
      for (const e of inv.entries) {
        if (
          typeof e.index !== 'number' ||
          !Number.isInteger(e.index) ||
          e.index < 0 ||
          e.index > ents.length
        ) {
          return { ok: false, error: historyInvalid(entry.requestId) };
        }
        ents.splice(e.index, 0, deepClone(e.entity) as AnyEntity);
      }
      const rootEntry = inv.entries[0];
      if (rootEntry === undefined) return { ok: false, error: historyInvalid(entry.requestId) };
      if ((rootEntry.entity.parentId ?? null) !== inv.restoredParentId) {
        return { ok: false, error: historyInvalid(entry.requestId) };
      }
      const change: RestoreSubtreeChange = {
        type: 'restoreSubtree',
        rootId: rootEntry.entity.id,
        entities: inv.entries.map((e) => deepClone(e.entity)),
      };
      // The deleted block layers' cells come back with them.
      let restored: SceneDocument = scene;
      for (const b of inv.blocks ?? []) restored = withLayerData(restored, b.entityId, b);
      const result = { ...restored, revision: scene.revision + 1, entities: ents };
      return finish(state, result, state.content, change, entry.requestId);
    },
    removeEntities: (state, entry, inv) => {
      const scene = state.scene;
      const gone = new Set(inv.ids);
      if (!inv.ids.every((id) => scene.entities.some((e) => e.id === id))) return { ok: false, error: historyInvalid(entry.requestId) };
      const nextEntities = scene.entities.filter((e) => !gone.has(e.id));
      const change: DeleteEntityChange = { type: 'deleteEntity', rootId: inv.ids[0] ?? '', deletedIds: [...inv.ids] };
      return finish(state, { ...withoutLayersOf(scene, gone).scene, revision: scene.revision + 1, entities: nextEntities }, state.content, change, entry.requestId);
    },
  },
  redo: {
    updateEntity: (state, entry, f) => {
      return applyHeader(state, f.id, f.next, f.order?.next ?? null, entry.requestId, f.transform?.next);
    },
    moveEntitiesScene: (state, entry, f) => {
      const scene = state.scene;
      // Out of the carrier (the source) into the other scene again, as the move left them.
      const r = replaySceneMove(scene, state.otherScene, f.entities, f.toOrder, false, f.parentId, entry.requestId, state.content);
      if (!r.ok) return r;
      return { ok: true, applied: { scene: r.result.scene, content: state.content, change: r.result.change, otherScene: r.result.otherScene } };
    },
    moveEntities: (state, entry, f) => {
      return applyMove(
        state,
        f.order.next,
        f.entities.map((m) => ({ id: m.id, parentId: m.next.parentId, transform: m.next.transform })),
        f.parentId,
        f.beforeId,
        entry.requestId,
      );
    },
    createEntity: (state, entry, f) => {
      const scene = state.scene;
      const created = [f.entity, ...(f.children ?? [])];
      if (scene.entities.some((e) => created.some((c) => c.id === e.id))) {
        return { ok: false, error: historyInvalid(entry.requestId) };
      }
      const nextEntities = [...scene.entities, ...created.map((c) => deepClone(c) as unknown as EntityV3)];
      const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
      const change: ChangeData = {
        type: 'createEntity',
        id: f.id,
        entity: deepClone(f.entity),
        ...(f.children !== undefined ? { children: f.children.map((c) => deepClone(c)) } : {}),
      };
      return finish(state, result, state.content, change, entry.requestId);
    },
    setTransform: (state, entry, f) => {
      const scene = state.scene;
      const index = requireEntity(scene, f.id);
      if (index < 0) return { ok: false, error: historyInvalid(entry.requestId) };
      const current = scene.entities[index] as AnyEntity;
      const next: TransformComponent = {
        position: [...f.next.position],
        rotation: [...f.next.rotation],
        scale: [...f.next.scale],
      };
      const cloned = deepClone(current);
      const newEntity = { ...cloned, components: { ...cloned.components, transform: next } };
      const nextEntities = [...scene.entities];
      nextEntities[index] = newEntity as unknown as EntityV3;
      const change: SetTransformChange = {
        type: 'setTransform',
        id: f.id,
        previous: deepClone(current.components.transform as TransformComponent),
        next: deepClone(next),
        changedFields: [...f.changedFields],
      };
      const result = { ...scene, revision: scene.revision + 1, entities: nextEntities };
      return finish(state, result, state.content, change, entry.requestId);
    },
    deleteEntity: (state, entry, f) => {
      const scene = state.scene;
      const byId = new Map(scene.entities.map((e) => [e.id, e]));
      for (const id of f.deletedIds) {
        if (!byId.has(id)) return { ok: false, error: historyInvalid(entry.requestId) };
      }
      const gone = new Set(f.deletedIds);
      const nextEntities = scene.entities.filter((e) => !gone.has(e.id));
      const change: DeleteEntityChange = {
        type: 'deleteEntity',
        rootId: f.rootId,
        deletedIds: [...f.deletedIds],
      };
      // A deleted block layer takes its cells along.
      const result = { ...withoutLayersOf(scene, gone).scene, revision: scene.revision + 1, entities: nextEntities };
      return finish(state, result, state.content, change, entry.requestId);
    },
    pasteEntities: (state, entry, f) => {
      const scene = state.scene;
      if (scene.entities.some((e) => f.entities.some((c) => c.id === e.id))) return { ok: false, error: historyInvalid(entry.requestId) };
      const nextEntities = [...scene.entities, ...f.entities.map((c) => deepClone(c) as unknown as EntityV3)];
      const change: ChangeData = { type: 'pasteEntities', entities: f.entities.map((c) => deepClone(c)) };
      return finish(state, { ...scene, revision: scene.revision + 1, entities: nextEntities }, state.content, change, entry.requestId);
    },
  },
} satisfies OpFamily;
