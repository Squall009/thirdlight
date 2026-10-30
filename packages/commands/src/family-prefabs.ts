/**
 * Prefabs: capture, contents, copies, overrides, variants and deletion, and
 * the linked-copy edits any op is routed to when it names a copy's part.
 * Each op's step and the undo and redo of what it records.
 */

import type { OpFamily } from './op-table-types';
import { contentOf } from './content-ops';
import { applyDeletePrefab } from './delete-content-ops';
import { applyPrefabOp } from './prefab-link-ops';
import { historyInvalid } from './errors';
import { bumped, finish, removePrefabOf, replayLinked, sortedPrefabs } from './history-steps';
import { deepClone, type AnyEntity } from './ops';
import type { ContentDocument, CreatePrefabChange, InstantiatePrefabChange, UpdatePrefabChange } from './types';

export const prefabFamily = {
  ops: {
    createPrefab: { apply: (input, args) => applyPrefabOp(input, { op: 'createPrefab', args }), records: [['createPrefab', 'removePrefab']] },
    updatePrefab: { apply: (input, args) => applyPrefabOp(input, { op: 'updatePrefab', args }), records: [['updatePrefab', 'updatePrefab']] },
    instantiatePrefab: { apply: (input, args) => applyPrefabOp(input, { op: 'instantiatePrefab', args }), records: [['instantiatePrefab', 'delete']] },
    revertPrefabOverrides: { apply: (input, args) => applyPrefabOp(input, { op: 'revertPrefabOverrides', args }), records: [['prefabLinkEdit', 'prefabLinkEdit']] },
    applyPrefabOverrides: { apply: (input, args) => applyPrefabOp(input, { op: 'applyPrefabOverrides', args }), records: [['prefabLinkEdit', 'prefabLinkEdit']] },
    unpackPrefab: { apply: (input, args) => applyPrefabOp(input, { op: 'unpackPrefab', args }), records: [['prefabLinkEdit', 'prefabLinkEdit']] },
    createPrefabVariant: { apply: (input, args) => applyPrefabOp(input, { op: 'createPrefabVariant', args }), records: [['createPrefab', 'removePrefab']] },
    deletePrefab: { apply: (input, args) => applyDeletePrefab(input, args), records: [['removePrefab', 'restorePrefab']] },
  },
  undo: {
    prefabLinkEdit: (state, entry) => {
      return replayLinked(state, entry, false);
    },
    restorePrefab: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // Undo of a deletePrefab puts the definition back verbatim.
      if (content.prefabs.some((d) => d.prefabId === inv.prefabId)) return { ok: false, error: historyInvalid(entry.requestId) };
      const nextContent: ContentDocument = { ...content, prefabs: sortedPrefabs([...content.prefabs, deepClone(inv.definition)]) };
      const change: CreatePrefabChange = { type: 'createPrefab', prefabId: inv.prefabId, definition: deepClone(inv.definition) };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
    updatePrefab: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // Undo of an updatePrefab puts the replaced definition back.
      const current = content.prefabs.find((d) => d.prefabId === inv.prefabId);
      if (current === undefined) return { ok: false, error: historyInvalid(entry.requestId) };
      const nextContent: ContentDocument = { ...content, prefabs: content.prefabs.map((d) => (d.prefabId === inv.prefabId ? deepClone(inv.restore) : d)) };
      const change: UpdatePrefabChange = { type: 'updatePrefab', prefabId: inv.prefabId, previous: deepClone(current), next: deepClone(inv.restore) };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
    // Undo of a createPrefab: remove the definition. By LIFO no later command exists, so no instance can still reference it.
    removePrefab: (state, entry, inv) => {
      const content = contentOf(state.content);
      return removePrefabOf(state, content, inv.prefabId, entry.requestId);
    },
  },
  redo: {
    prefabLinkEdit: (state, entry) => {
      return replayLinked(state, entry, true);
    },
    instantiatePrefab: (state, entry, f) => {
      const scene = state.scene;
      // Redo of an instantiation: re-insert the recorded entries at their
      // recorded indices with their recorded IDs — no ID re-scan, no new
      // allocation.
      const ents = deepClone(scene.entities) as unknown as AnyEntity[];
      const existing = new Set(ents.map((e) => e.id));
      for (const en of f.entries) {
        if (
          !Number.isInteger(en.index) ||
          en.index < 0 ||
          en.index > ents.length ||
          existing.has(en.entity.id)
        ) {
          return { ok: false, error: historyInvalid(entry.requestId) };
        }
        ents.splice(en.index, 0, deepClone(en.entity) as unknown as AnyEntity);
        existing.add(en.entity.id);
      }
      const result = { ...scene, revision: scene.revision + 1, entities: ents };
      const change: InstantiatePrefabChange = {
        type: 'instantiatePrefab',
        prefabId: f.prefabId,
        rootId: f.rootId,
        entries: f.entries.map((e) => ({ index: e.index, entity: deepClone(e.entity) })),
        mapping: f.mapping.map((m) => ({ ...m })),
      };
      return finish(state, result, state.content, change, entry.requestId);
    },
    createPrefab: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // Redo of a capture: re-insert the recorded definition value verbatim
      // (never re-capture).
      if (content.prefabs.some((d) => d.prefabId === f.prefabId)) {
        return { ok: false, error: historyInvalid(entry.requestId) };
      }
      const prefabs = sortedPrefabs([...content.prefabs, deepClone(f.definition)]);
      const nextContent: ContentDocument = { ...content, prefabs };
      const change: CreatePrefabChange = {
        type: 'createPrefab',
        prefabId: f.prefabId,
        definition: deepClone(f.definition),
      };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
    updatePrefab: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      // Redo of an updatePrefab re-applies the recorded contents (never re-captures).
      if (!content.prefabs.some((d) => d.prefabId === f.prefabId)) return { ok: false, error: historyInvalid(entry.requestId) };
      const nextContent: ContentDocument = { ...content, prefabs: content.prefabs.map((d) => (d.prefabId === f.prefabId ? deepClone(f.next) : d)) };
      const change: UpdatePrefabChange = { type: 'updatePrefab', prefabId: f.prefabId, previous: deepClone(f.previous), next: deepClone(f.next) };
      return finish(state, bumped(scene), nextContent, change, entry.requestId);
    },
    // Redo of a deletePrefab.
    removePrefab: (state, entry, f) => {
      const content = contentOf(state.content);
      return content.prefabs.some((d) => d.prefabId === f.prefabId) ? removePrefabOf(state, content, f.prefabId, entry.requestId) : { ok: false, error: historyInvalid(entry.requestId) };
    },
  },
} satisfies OpFamily;
