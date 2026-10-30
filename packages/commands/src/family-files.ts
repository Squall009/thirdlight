/**
 * The project's scenes and files: the scene index, imported assets and
 * resources, file and folder moves, labels and addresses. The host prepares
 * the file work; each op stores it in one transaction. Each op's step and the
 * undo and redo of what it records.
 */

import type { ApplyResult, OpFamily } from './op-table-types';
import { contentOf } from './content-ops';
import { historyInvalid } from './errors';
import { applySceneIndexOp } from './scene-ops';
import { applyImportAssets, redoImportAssets, undoImportAssets } from './import-assets';
import { applyImportResources, redoImportResources, undoImportResources } from './import-resources';
import { applyMoveResources, redoMoveResources, undoMoveResources } from './move-ops';
import { applySetAddress, applySetLabels, loadingItemsExist, redoSetLoading, undoSetLoading } from './loadable-ops';
import { bumped, finish, sceneIndexOf } from './history-steps';
import { deepClone } from './ops';
import type { ChangeData, CommandState, ContentDocument, HistoryEntry, SceneDocument, SetLoadingChange } from './types';

/** Redo of a labels or address change: the recorded values again. */
function redoLoading(state: CommandState<SceneDocument>, entry: HistoryEntry, f: SetLoadingChange): ApplyResult {
  const scene = state.scene;
  const content = contentOf(state.content);
  if (!loadingItemsExist(content, f.items)) return { ok: false, error: historyInvalid(entry.requestId) };
  const r = redoSetLoading(scene, content, f);
  return finish(state, r.scene, r.content, r.change, entry.requestId);
}

export const fileFamily = {
  ops: {
    createScene: { apply: (input, args, state) => applySceneIndexOp(input, args, state.sceneEnvironments), records: [['setSceneIndex', 'setSceneIndex']] },
    renameScene: { apply: (input, args, state) => applySceneIndexOp(input, args, state.sceneEnvironments), records: [['setSceneIndex', 'setSceneIndex']] },
    deleteScene: { apply: (input, args, state) => applySceneIndexOp(input, args, state.sceneEnvironments), records: [['setSceneIndex', 'setSceneIndex']] },
    setStartScenes: { apply: (input, args, state) => applySceneIndexOp(input, args, state.sceneEnvironments), records: [['setSceneIndex', 'setSceneIndex']] },
    // A folder's files, prepared by the host, as assets in one transaction.
    importAssets: { apply: (input, args, state) => applyImportAssets(input, args, state.preparedAssetImport), records: [['importAssets', 'importAssets']] },
    // Resource and scene files the file check read, into the project in one transaction.
    importResources: { apply: (input, _args, state) => applyImportResources(input, state.preparedResourceImport), records: [['importResources', 'importResources']] },
    // Files and folders moved as the host prepared them, in one transaction (one undo).
    moveResources: { apply: (input, _args, state) => applyMoveResources(input, state.preparedMoves), records: [['moveResources', 'moveResources']] },
    renameFolder: { apply: (input, _args, state) => applyMoveResources(input, state.preparedMoves), records: [['moveResources', 'moveResources']] },
    createFolder: { apply: (input, _args, state) => applyMoveResources(input, state.preparedMoves), records: [['moveResources', 'moveResources']] },
    // Many items' labels, or one item's address, in one transaction (one undo).
    setLabels: { apply: (input, args) => applySetLabels(input, args), records: [['setLabels', 'setLoading']] },
    setAddress: { apply: (input, args) => applySetAddress(input, args), records: [['setAddress', 'setLoading']] },
  },
  undo: {
    setSceneIndex: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = sceneIndexOf(content);
      const after = deepClone(inv.restore);
      // The looks of the scenes the undo brings back (or of those it removes) travel with it.
      const change: ChangeData = { type: 'setSceneIndex', previous: before, next: after, ...(inv.environments !== undefined ? { environments: deepClone(inv.environments) } : {}) };
      return finish(state, bumped(scene), { ...content, scenes: after.scenes, startScenes: after.startScenes } as ContentDocument, change, entry.requestId);
    },
    importResources: (state, entry) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      if (entry.change.type !== 'importResources') return { ok: false, error: historyInvalid(entry.requestId) };
      const r = undoImportResources(scene, content, entry.change);
      if (r === null) return { ok: false, error: historyInvalid(entry.requestId) };
      return finish(state, r.scene, r.content, r.change, entry.requestId);
    },
    moveResources: (state, entry) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      if (entry.change.type !== 'moveResources') return { ok: false, error: historyInvalid(entry.requestId) };
      const r = undoMoveResources(scene, content, entry.change);
      if (r === null) return { ok: false, error: historyInvalid(entry.requestId) };
      // Only resource, scene and folder moves: the content block is the same (the host moves the files).
      if (r.content === content) return { ok: true, applied: { scene: r.scene, content, change: r.change } };
      return finish(state, r.scene, r.content, r.change, entry.requestId);
    },
    setLoading: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      if (!loadingItemsExist(content, inv.items)) return { ok: false, error: historyInvalid(entry.requestId) };
      const r = undoSetLoading(scene, content, inv);
      return finish(state, r.scene, r.content, r.change, entry.requestId);
    },
    importAssets: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      if (entry.change.type !== 'importAssets') return { ok: false, error: historyInvalid(entry.requestId) };
      const r = undoImportAssets(scene, content, inv, entry.change);
      if (r === null) return { ok: false, error: historyInvalid(entry.requestId) };
      return finish(state, r.scene, r.content, r.change, entry.requestId);
    },
  },
  redo: {
    setSceneIndex: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = sceneIndexOf(content);
      const after = deepClone(f.next);
      const change: ChangeData = { type: 'setSceneIndex', previous: before, next: after, ...(f.environments !== undefined ? { environments: deepClone(f.environments) } : {}) };
      return finish(state, bumped(scene), { ...content, scenes: after.scenes, startScenes: after.startScenes } as ContentDocument, change, entry.requestId);
    },
    importResources: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const r = redoImportResources(scene, content, f);
      if (r === null) return { ok: false, error: historyInvalid(entry.requestId) };
      return finish(state, r.scene, r.content, r.change, entry.requestId);
    },
    moveResources: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const r = redoMoveResources(scene, content, f);
      if (r === null) return { ok: false, error: historyInvalid(entry.requestId) };
      // Only resource, scene and folder moves: the content block is the same (the host moves the files).
      if (r.content === content) return { ok: true, applied: { scene: r.scene, content, change: r.change } };
      return finish(state, r.scene, r.content, r.change, entry.requestId);
    },
    setLabels: redoLoading,
    setAddress: redoLoading,
    importAssets: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const r = redoImportAssets(scene, content, f);
      if (r === null) return { ok: false, error: historyInvalid(entry.requestId) };
      return finish(state, r.scene, r.content, r.change, entry.requestId);
    },
  },
} satisfies OpFamily;
