/**
 * Block layers and terrain strokes: their ops' steps and the undo and redo of
 * what they record. Only the dispatch is here; the block and terrain
 * internals stay in their own modules.
 */

import type { OpFamily } from './op-table-types';
import type { BlockEdit, BlockType, CellField } from '@thirdlight/project-model';
import { contentOf } from './content-ops';
import { applyDeleteBlockStamp, applyDeleteBlockType, applyEditBlocks, applySetBlockStamp, applySetBlockType, applySetCellFields, blockStampsOf, blockTypesOf, cellFieldsOf, layerDataOf, withBlockStamp, withBlockType, withCellFields, withLayerData } from './block-ops';
import { patchDelta, patchedLayer } from './block-patch';
import { applyEditTerrain } from './terrain-ops';
import { bumped, finish } from './history-steps';
import { deepClone } from './ops';
import type { ChangeData, EditBlocksInverse } from './types';

export const blockTerrainFamily = {
  ops: {
    editBlocks: { apply: (input, args) => applyEditBlocks(input, args as { entityId: string; edits: BlockEdit[] }), records: [['editBlocks', 'editBlocks']] },
    setBlockType: { apply: (input, args) => applySetBlockType(input, args as { block: BlockType }), records: [['setBlockType', 'setBlockType']] },
    deleteBlockType: { apply: (input, args) => applyDeleteBlockType(input, args), records: [['setBlockType', 'setBlockType']] },
    setCellFields: { apply: (input, args) => applySetCellFields(input, args as { fields: CellField[] }), records: [['setCellFields', 'setCellFields']] },
    setBlockStamp: { apply: (input, args) => applySetBlockStamp(input, args), records: [['setBlockStamp', 'setBlockStamp']] },
    deleteBlockStamp: { apply: (input, args) => applyDeleteBlockStamp(input, args), records: [['setBlockStamp', 'setBlockStamp']] },
    // The tiles the host planned and published, stored as one setComponent change (one undo points back at the old tiles).
    editTerrain: { apply: (input, args, state) => applyEditTerrain(input, args, state.preparedTerrainEdit), records: [['setComponent', 'setComponent']] },
  },
  undo: {
    // Block layers (the changed chunks put back; content items by id).
    editBlocks: (state, entry, inv) => {
      const scene = state.scene;
      const delta = patchDelta(inv.patch);
      const change: ChangeData = { type: 'editBlocks', entityId: inv.entityId, chunks: delta.chunks, regions: delta.regions, cells: 0 };
      return finish(state, { ...withLayerData(scene, inv.entityId, patchedLayer(layerDataOf(scene, inv.entityId), inv.patch, 'restore')), revision: scene.revision + 1 }, state.content, change, entry.requestId);
    },
    setBlockType: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = blockTypesOf(content).find((t) => t.blockId === inv.blockId) ?? null;
      const change: ChangeData = { type: 'setBlockType', blockId: inv.blockId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withBlockType(content, inv.blockId, inv.restore), change, entry.requestId);
    },
    setCellFields: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const change: ChangeData = { type: 'setCellFields', previous: deepClone(cellFieldsOf(content)), next: deepClone(inv.restore) };
      return finish(state, bumped(scene), withCellFields(content, inv.restore), change, entry.requestId);
    },
    setBlockStamp: (state, entry, inv) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = blockStampsOf(content).find((x) => x.stampId === inv.stampId) ?? null;
      const change: ChangeData = { type: 'setBlockStamp', stampId: inv.stampId, previous: before === null ? null : deepClone(before), next: inv.restore === null ? null : deepClone(inv.restore) };
      return finish(state, bumped(scene), withBlockStamp(content, inv.stampId, inv.restore), change, entry.requestId);
    },
  },
  redo: {
    // Block layers — redo re-applies the recorded layer entry / content item.
    editBlocks: (state, entry, f) => {
      const scene = state.scene;
      const inv = entry.inverse as import('./types').EditBlocksInverse;
      const delta = patchDelta(inv.patch);
      const change: ChangeData = { type: 'editBlocks', entityId: f.entityId, chunks: delta.chunks, regions: delta.regions, cells: f.cells };
      return finish(state, { ...withLayerData(scene, f.entityId, patchedLayer(layerDataOf(scene, f.entityId), inv.patch, 'next')), revision: scene.revision + 1 }, state.content, change, entry.requestId);
    },
    setBlockType: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = blockTypesOf(content).find((t) => t.blockId === f.blockId) ?? null;
      const change: ChangeData = { type: 'setBlockType', blockId: f.blockId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withBlockType(content, f.blockId, f.next), change, entry.requestId);
    },
    setCellFields: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const change: ChangeData = { type: 'setCellFields', previous: deepClone(cellFieldsOf(content)), next: deepClone(f.next) };
      return finish(state, bumped(scene), withCellFields(content, f.next), change, entry.requestId);
    },
    setBlockStamp: (state, entry, f) => {
      const scene = state.scene;
      const content = contentOf(state.content);
      const before = blockStampsOf(content).find((x) => x.stampId === f.stampId) ?? null;
      const change: ChangeData = { type: 'setBlockStamp', stampId: f.stampId, previous: before === null ? null : deepClone(before), next: f.next === null ? null : deepClone(f.next) };
      return finish(state, bumped(scene), withBlockStamp(content, f.stampId, f.next), change, entry.requestId);
    },
  },
} satisfies OpFamily;
