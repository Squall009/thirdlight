/**
 * Block-layer commands.
 *
 * Scene: `editBlocks {entityId, edits[]}` applies bulk edits (fill a box,
 * set listed cells, set cells from a run-length array, replace a block type,
 * paint metadata, flood fill, raise/lower columns, place a stamp, copy /
 * move / mirror a selection, region set/add/remove/rename/delete, import a
 * heightmap PNG) to one layer's cells, as one undo step. Every edit takes a
 * compact encoding (boxes, runs), so a whole map fits a few requests under
 * the 64 KiB cap. The change names the chunks and regions it touched (the
 * cells themselves are read back with `queryBlocks`): a fill of a large area
 * keeps the change, the retry record and the live event small.
 *
 * Content: `setBlockType {block}` / `deleteBlockType {blockId}`,
 * `setCellFields {fields}` (the whole schema), `setBlockStamp {stamp}` or
 * `setBlockStamp {stampId, name, entityId, box}` (save a selection of a
 * layer) / `deleteBlockStamp {stampId}`. A block type still named by a cell,
 * or a field a cell still carries, is refused by the project rules.
 */
import {
  applyBlockEdits,
  BlockGrid,
  CHUNK_SIZE,
  canonicalBlockStamp,
  canonicalBlockTypes,
  canonicalCellFields,
  canonicalBlockStamps,
  edgeInBox,
  type BlockEdit,
  type BlockLayerComponent,
  type BlockLayerData,
  type BlockStamp,
  type BlockType,
  type CellField,
  type SceneV4,
} from '@thirdlight/project-model';

import { layerPatch, patchDelta, patchIsEmpty } from './block-patch';
import { entityNotFound, fieldValue, noChangeContent, type CommandError } from './errors';
import { contentOf, type OpInput } from './content-ops';
import { deepClone, gateResultState, type OpOutcome } from './ops';
import type { ContentDocument, EditBlocksChange, SetBlockStampChange, SetBlockTypeChange, SetCellFieldsChange, SceneDocument } from './types';

type BlockContent = ContentDocument & { blockTypes?: BlockType[]; cellFields?: CellField[]; blockStamps?: BlockStamp[] };

export const blockTypesOf = (c: ContentDocument): BlockType[] => (c as BlockContent).blockTypes ?? [];
export const cellFieldsOf = (c: ContentDocument): CellField[] => (c as BlockContent).cellFields ?? [];
export const blockStampsOf = (c: ContentDocument): BlockStamp[] => (c as BlockContent).blockStamps ?? [];

/** A scene's layer entry (null: none). */
export function layerDataOf(scene: SceneDocument, entityId: string): BlockLayerData | null {
  return (scene as SceneV4).blocks?.find((b) => b.entityId === entityId) ?? null;
}

/** The scene with one layer entry replaced (null removes it); the list stays sorted and is absent when empty. */
export function withLayerData(scene: SceneDocument, entityId: string, data: BlockLayerData | null): SceneDocument {
  const list = ((scene as SceneV4).blocks ?? []).filter((b) => b.entityId !== entityId);
  if (data !== null) list.push(data);
  list.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  const out = { ...(scene as SceneV4) } as SceneV4;
  if (list.length > 0) out.blocks = list;
  else delete out.blocks;
  return out as SceneDocument;
}

function layerComponent(scene: SceneDocument, entityId: string): { ok: true; comp: BlockLayerComponent } | { ok: false; error: CommandError } {
  const e = scene.entities.find((x) => x.id === entityId);
  if (e === undefined) return { ok: false, error: entityNotFound(entityId) };
  const comp = (e.components as { blockLayer?: BlockLayerComponent }).blockLayer;
  if (comp === undefined) return { ok: false, error: fieldValue('/args/entityId', entityId, 'an entity carrying blockLayer', 'the entity has no blockLayer component (add one first)') };
  return { ok: true, comp };
}

/** `editBlocks`: bulk edits of one layer's cells and regions (one undo step). */
export function applyEditBlocks(input: OpInput, args: { entityId: string; edits: BlockEdit[] }): OpOutcome {
  const scene = input.scene;
  const lc = layerComponent(scene, args.entityId);
  if (!lc.ok) return lc;
  const content = contentOf(input.content);
  const previous = layerDataOf(scene, args.entityId);
  const grid = BlockGrid.from(lc.comp, previous);
  const res = applyBlockEdits(grid, args.edits, {
    types: new Map(blockTypesOf(content).map((t) => [t.blockId, t])),
    stamps: new Map(blockStampsOf(content).map((s) => [s.stampId, s])),
  });
  if (!res.ok) return { ok: false, error: fieldValue(res.path, undefined, 'an edit that fits the layer', res.message) };
  const dirty = grid.takeDirty();
  const next = grid.toData(args.entityId, previous, dirty.chunks);
  if (patchIsEmpty(layerPatch(args.entityId, previous, next, dirty.chunks))) return { ok: false, error: noChangeContent() };
  const result = { ...withLayerData(scene, args.entityId, next), revision: scene.revision + 1 };
  const gate = gateResultState({ scene, content: input.content, manifest: input.manifest }, result, input.content);
  if (!gate.ok) return gate;
  // The undo step keeps the changed chunks only (as stored: the gate's canonical values).
  const patch = layerPatch(args.entityId, previous, layerDataOf(gate.scene, args.entityId), dirty.chunks);
  const delta = patchDelta(patch);
  const change: EditBlocksChange = { type: 'editBlocks', entityId: args.entityId, chunks: delta.chunks, regions: delta.regions, cells: res.cells, ...(res.rebased !== undefined ? { rebased: res.rebased } : {}) };
  return { ok: true, op: { scene: gate.scene, change, inverse: { kind: 'editBlocks', entityId: args.entityId, patch } } };
}

function commitContent(input: OpInput, next: ContentDocument, change: SetBlockTypeChange | SetCellFieldsChange | SetBlockStampChange, inverse: import('./types').InverseSpec): OpOutcome {
  const resultScene = { ...input.scene, revision: input.scene.revision + 1 };
  const gate = gateResultState({ scene: input.scene, content: contentOf(input.content), manifest: input.manifest }, resultScene, next);
  if (!gate.ok) return gate;
  return { ok: true, op: { scene: gate.scene, content: gate.content, change, inverse } };
}

/** The content with one block type set (null removes it); the list stays canonical and is absent when empty. */
export function withBlockType(content: ContentDocument, blockId: string, t: BlockType | null): ContentDocument {
  const c = { ...(content as BlockContent) };
  const list = (c.blockTypes ?? []).filter((x) => x.blockId !== blockId);
  if (t !== null) list.push(deepClone(t));
  if (list.length > 0) c.blockTypes = canonicalBlockTypes(list);
  else delete c.blockTypes;
  return c;
}

export function withCellFields(content: ContentDocument, fields: CellField[]): ContentDocument {
  const c = { ...(content as BlockContent) };
  if (fields.length > 0) c.cellFields = canonicalCellFields(deepClone(fields));
  else delete c.cellFields;
  return c;
}

export function withBlockStamp(content: ContentDocument, stampId: string, s: BlockStamp | null): ContentDocument {
  const c = { ...(content as BlockContent) };
  const list = (c.blockStamps ?? []).filter((x) => x.stampId !== stampId);
  if (s !== null) list.push(deepClone(s));
  if (list.length > 0) c.blockStamps = canonicalBlockStamps(list);
  else delete c.blockStamps;
  return c;
}

/** `setBlockType`: create or replace one block type. */
export function applySetBlockType(input: OpInput, args: { block: BlockType }): OpOutcome {
  const content = contentOf(input.content);
  const previous = blockTypesOf(content).find((t) => t.blockId === args.block.blockId) ?? null;
  const next = withBlockType(content, args.block.blockId, args.block);
  const stored = blockTypesOf(next).find((t) => t.blockId === args.block.blockId) ?? null;
  return commitContent(input, next, { type: 'setBlockType', blockId: args.block.blockId, previous: previous === null ? null : deepClone(previous), next: deepClone(stored) }, { kind: 'setBlockType', blockId: args.block.blockId, restore: previous === null ? null : deepClone(previous) });
}

/** `deleteBlockType`: remove one (the project rules refuse it while a cell names it). */
export function applyDeleteBlockType(input: OpInput, args: { blockId: string }): OpOutcome {
  const content = contentOf(input.content);
  const previous = blockTypesOf(content).find((t) => t.blockId === args.blockId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/blockId', args.blockId, 'an existing blockId', 'no block type with this id'), code: 'reference_missing' } };
  return commitContent(input, withBlockType(content, args.blockId, null), { type: 'setBlockType', blockId: args.blockId, previous: deepClone(previous), next: null }, { kind: 'setBlockType', blockId: args.blockId, restore: deepClone(previous) });
}

/** `setCellFields`: replace the cell metadata schema. */
export function applySetCellFields(input: OpInput, args: { fields: CellField[] }): OpOutcome {
  const content = contentOf(input.content);
  const previous = cellFieldsOf(content);
  const next = withCellFields(content, args.fields);
  return commitContent(input, next, { type: 'setCellFields', previous: deepClone(previous), next: deepClone(cellFieldsOf(next)) }, { kind: 'setCellFields', restore: deepClone(previous) });
}

/**
 * `setBlockStamp`: store a stamp given whole (`stamp`), or save a selection
 * (`entityId` + `box` [x0, y0, z0, x1, y1, z1] of that layer) as a stamp named
 * `stampId` / `name`.
 */
export function applySetBlockStamp(input: OpInput, args: { stamp?: BlockStamp; stampId?: string; name?: string; entityId?: string; box?: number[] }): OpOutcome {
  const content = contentOf(input.content);
  let stamp: BlockStamp;
  if (args.stamp !== undefined) stamp = canonicalBlockStamp(args.stamp);
  else {
    const lc = layerComponent(input.scene, args.entityId as string);
    if (!lc.ok) return lc;
    const grid = BlockGrid.from(lc.comp, layerDataOf(input.scene, args.entityId as string));
    const [x0, y0, z0, x1, y1, z1] = args.box as number[];
    const cells: { x: number; y: number; z: number; idx: number }[] = [];
    grid.forEach((x, y, z, idx) => {
      if (x >= x0! && x < x1! && y >= y0! && y < y1! && z >= z0! && z < z1!) cells.push({ x: x - x0!, y: y - y0!, z: z - z0!, idx });
    });
    // The edge pieces on and inside the box go with it (a room's walls).
    const edgePalette: import('@thirdlight/project-model').BlockEdge[] = [];
    const edges: number[][] = [];
    const eIndex = new Map<number, number>();
    grid.forEachEdge((x, y, z, axis, idx) => {
      if (!edgeInBox(args.box as number[], x, y, z, axis)) return;
      let p = eIndex.get(idx);
      if (p === undefined) {
        p = edgePalette.length;
        eIndex.set(idx, p);
        edgePalette.push(deepClone(grid.edgeValueOf(idx)));
      }
      edges.push([x - x0!, z - z0!, y - y0!, axis, p]);
    });
    if (cells.length === 0 && edges.length === 0) return { ok: false, error: fieldValue('/args/box', args.box, 'a box holding cells', 'the selection holds no cells') };
    // Encode as run columns (x, z, then runs up y).
    const byColumn = new Map<string, { x: number; z: number; ys: { y: number; p: number }[] }>();
    const palette: import('@thirdlight/project-model').BlockCell[] = [];
    const pIndex = new Map<number, number>();
    for (const c of cells) {
      let p = pIndex.get(c.idx);
      if (p === undefined) {
        p = palette.length;
        pIndex.set(c.idx, p);
        palette.push(deepClone(grid.valueOf(c.idx)));
      }
      const k = `${c.x},${c.z}`;
      let col = byColumn.get(k);
      if (col === undefined) {
        col = { x: c.x, z: c.z, ys: [] };
        byColumn.set(k, col);
      }
      col.ys.push({ y: c.y, p });
    }
    const columns = [...byColumn.values()].map((c) => [c.x, c.z, ...c.ys.flatMap((v) => [v.y, 1, v.p])]);
    stamp = canonicalBlockStamp({ stampId: args.stampId as string, name: args.name as string, size: [x1! - x0!, y1! - y0!, z1! - z0!], palette, columns, ...(edges.length > 0 ? { edgePalette, edges } : {}) });
  }
  const previous = blockStampsOf(content).find((s) => s.stampId === stamp.stampId) ?? null;
  const next = withBlockStamp(content, stamp.stampId, stamp);
  return commitContent(input, next, { type: 'setBlockStamp', stampId: stamp.stampId, previous: previous === null ? null : deepClone(previous), next: deepClone(stamp) }, { kind: 'setBlockStamp', stampId: stamp.stampId, restore: previous === null ? null : deepClone(previous) });
}

/** `deleteBlockStamp`: remove one. */
export function applyDeleteBlockStamp(input: OpInput, args: { stampId: string }): OpOutcome {
  const content = contentOf(input.content);
  const previous = blockStampsOf(content).find((s) => s.stampId === args.stampId) ?? null;
  if (previous === null) return { ok: false, error: { ...fieldValue('/args/stampId', args.stampId, 'an existing stampId', 'no stamp with this id'), code: 'reference_missing' } };
  return commitContent(input, withBlockStamp(content, args.stampId, null), { type: 'setBlockStamp', stampId: args.stampId, previous: deepClone(previous), next: null }, { kind: 'setBlockStamp', stampId: args.stampId, restore: deepClone(previous) });
}

/** The layer entries of deleted entities (for a delete's undo) and the scene without them. */
export function withoutLayersOf(scene: SceneDocument, ids: ReadonlySet<string>): { scene: SceneDocument; removed: BlockLayerData[] } {
  const blocks = (scene as SceneV4).blocks;
  if (blocks === undefined) return { scene, removed: [] };
  const removed = blocks.filter((b) => ids.has(b.entityId));
  if (removed.length === 0) return { scene, removed: [] };
  let out = scene;
  for (const r of removed) out = withLayerData(out, r.entityId, null);
  return { scene: out, removed };
}

/** Chunk coordinates of a cell (exported for callers that route by chunk). */
export const chunkOf = (x: number, z: number): [number, number] => [Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)];
