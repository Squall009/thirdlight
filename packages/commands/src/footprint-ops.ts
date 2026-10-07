/**
 * Props' block footprints, written by the command that moves them.
 *
 * A prop carrying `blockFootprint` writes its fields into the block cells
 * beneath it. Any entity command that moves, turns, places, re-shapes or
 * deletes such a prop moves its footprint in the same transaction: the
 * fields leave the cells it stood on (set to null) and land where it stands
 * now, in one revision and one undo step, for the browser and MCP alike.
 * A prop moved to another scene leaves its cells as they are.
 *
 * The history entry keeps the chunks of each touched layer the footprint
 * writes changed, before and after; undo puts the "before" back ahead of the
 * command's own inverse (the reverse order of the forward step), redo puts
 * the "after" back once the command is re-applied. The change names the chunks so
 * clients re-read them as they do for `editBlocks`.
 */
import {
  applyBlockEdits,
  BlockGrid,
  cellFieldValueError,
  footprintCells,
  footprintEdits,
  footprintPlaces,
  type BlockEdit,
  type BlockLayerData,
  type CellField,
  type CellMetaValue,
  type FootprintLayer,
  type FootprintNode,
  type FootprintProp,
  type Manifest,
} from '@thirdlight/project-model';

import { blockStampsOf, blockTypesOf, cellFieldsOf, layerDataOf, withLayerData } from './block-ops';
import { layerPatch, patchDelta, patchedLayer, patchIsEmpty, type BlockLayerPatch } from './block-patch';
import { contentOf } from './content-ops';
import { fieldValue, type CommandError } from './errors';
import { gateResultState } from './ops';
import { deepEqual } from './properties';
import type { ChangeData, ContentDocument, SceneDocument } from './types';

/** The chunks (and regions) of one layer a command's footprint writes changed. */
export interface FootprintChunks {
  entityId: string;
  chunks: [number, number][];
  regions: string[];
}

function hasFootprint(scene: SceneDocument): boolean {
  return scene.entities.some((e) => (e as unknown as FootprintNode).components.blockFootprint !== undefined);
}

function placesOf(scene: SceneDocument): ReturnType<typeof footprintPlaces> {
  return footprintPlaces(scene.entities as unknown as FootprintNode[]);
}

/** Why a footprint field cannot be written into cells (null: it can). */
function fieldProblem(fields: ReadonlyMap<string, CellField>, key: string, value: CellMetaValue): string | null {
  const f = fields.get(key);
  if (f === undefined) return `"${key}" is not a cell field (content.cellFields)`;
  const why = cellFieldValueError(f, value);
  return why === null ? null : `"${key}": ${why}`;
}

function cellsOn(layerId: string, layer: FootprintLayer | undefined, p: FootprintProp | undefined): number[] {
  if (layer === undefined || p === undefined || (p.fp.layer !== undefined && p.fp.layer !== layerId)) return [];
  return footprintCells(layer, p.position, p.rotation, p.fp);
}

export type FootprintOutcome =
  | { ok: true; scene: SceneDocument; layers: BlockLayerPatch[]; chunks: FootprintChunks[] }
  | { ok: true; scene: null }
  | { ok: false; error: CommandError };

/**
 * The footprint writes of a command that took `before` to `after` (an
 * applied, gated scene). `scene: null` when no footprint moved.
 */
export function writeFootprints(before: SceneDocument, after: SceneDocument, content: ContentDocument | undefined, manifest: Manifest | undefined): FootprintOutcome {
  if (before.entities === after.entities || (!hasFootprint(before) && !hasFootprint(after))) return { ok: true, scene: null };
  const was = placesOf(before);
  const now = placesOf(after);
  const fields = new Map(cellFieldsOf(contentOf(content)).map((f) => [f.key, f]));
  // Clears first, then writes: a prop moving off cells another prop covers does not undo the other's write.
  const clears = new Map<string, BlockEdit[][]>();
  const writes = new Map<string, BlockEdit[][]>();
  const cleared = new Map<string, Set<string>>();
  const unchanged: string[] = [];
  for (const id of new Set([...was.props.keys(), ...now.props.keys()])) {
    const b = was.props.get(id);
    const a = now.props.get(id);
    if (b !== undefined && a !== undefined && deepEqual(b, a)) {
      unchanged.push(id);
      continue;
    }
    // A footprint the command sets or changes must name valid cell fields: refused, naming the field. A footprint
    // that only moves (it, or an object above it) skips the fields the cell schema no longer has, so a field
    // dropped from the schema later does not block every move of the prop and its parents.
    let set = a?.fp.set ?? {};
    const own = b === undefined || a === undefined || !deepEqual(b.fp.set ?? {}, a.fp.set ?? {});
    for (const [k, v] of Object.entries(set)) {
      const why = fieldProblem(fields, k, v);
      if (why === null) continue;
      if (own) {
        const on = [...now.layers].filter(([layerId, layer]) => cellsOn(layerId, layer, a).length > 0).map(([layerId]) => layerId);
        const where = on.length > 0 ? `on layer ${on.join(', ')}` : a?.fp.layer !== undefined ? `for layer ${a.fp.layer}` : 'over no block layer yet';
        return { ok: false, error: fieldValue('/args', k, 'a block footprint field of the cell schema', `the block footprint of ${id} (${where}) cannot be written: ${why}`) };
      }
      set = Object.fromEntries(Object.entries(set).filter(([key, value]) => fieldProblem(fields, key, value) === null));
      break;
    }
    for (const [layerId, layer] of now.layers) {
      const edits = footprintEdits(cellsOn(layerId, was.layers.get(layerId), b), cellsOn(layerId, layer, a), set, b?.fp.set ?? {});
      if (edits === null) continue;
      const writing = (e: BlockEdit): boolean => e.kind === 'meta' && Object.values(e.set).some((v) => v !== null);
      const c = edits.filter((e) => !writing(e));
      const w = edits.filter(writing);
      if (c.length > 0) clears.set(layerId, [...(clears.get(layerId) ?? []), c]);
      if (w.length > 0) writes.set(layerId, [...(writes.get(layerId) ?? []), w]);
      for (const e of c) if (e.kind === 'meta') for (let i = 0; i < (e.at ?? []).length; i += 3) addCell(cleared, layerId, e.at!, i);
    }
  }
  // The props that stay where they were write their fields again on the cells a clear just emptied: deleting or
  // moving one prop does not wipe another's metadata from cells they share. Before the moved props' writes, so the
  // prop the command moved has the last word on a cell both cover.
  const rewrites = new Map<string, BlockEdit[][]>();
  for (const id of unchanged) {
    const a = now.props.get(id)!;
    const set = Object.fromEntries(Object.entries(a.fp.set ?? {}).filter(([k, v]) => fieldProblem(fields, k, v) === null));
    if (Object.keys(set).length === 0) continue;
    for (const [layerId, layer] of now.layers) {
      const hit = cleared.get(layerId);
      if (hit === undefined) continue;
      const cells = cellsOn(layerId, layer, a);
      const at: number[] = [];
      for (let i = 0; i < cells.length; i += 3) if (hit.has(`${cells[i]},${cells[i + 1]},${cells[i + 2]}`)) at.push(cells[i]!, cells[i + 1]!, cells[i + 2]!);
      if (at.length > 0) rewrites.set(layerId, [...(rewrites.get(layerId) ?? []), [{ kind: 'meta', set, at }]]);
    }
  }
  if (clears.size === 0 && writes.size === 0) return { ok: true, scene: null };
  const c = contentOf(content);
  const ctx = { types: new Map(blockTypesOf(c).map((t) => [t.blockId, t])), stamps: new Map(blockStampsOf(c).map((s) => [s.stampId, s])) };
  let scene = after;
  const touched: { entityId: string; restore: BlockLayerData | null; written: string[] }[] = [];
  for (const [layerId, layer] of now.layers) {
    // One prop's edits per call: the per-command cell budget holds for each footprint, not for all of them together.
    const steps = [...(clears.get(layerId) ?? []), ...(rewrites.get(layerId) ?? []), ...(writes.get(layerId) ?? [])];
    if (steps.length === 0) continue;
    const previous = layerDataOf(scene, layerId);
    const grid = BlockGrid.from(layer.component, previous);
    for (const edits of steps) {
      const r = applyBlockEdits(grid, edits, ctx);
      if (!r.ok) return { ok: false, error: fieldValue('/args', undefined, 'a block footprint that fits its layer', `a prop's block footprint on layer ${layerId}: ${r.message}`) };
    }
    const written = grid.takeDirty().chunks;
    const next = grid.toData(layerId, previous, written);
    if (patchIsEmpty(layerPatch(layerId, previous, next, written))) continue;
    scene = withLayerData(scene, layerId, next);
    touched.push({ entityId: layerId, restore: previous, written });
  }
  if (touched.length === 0) return { ok: true, scene: null };
  const gate = gateResultState({ scene: before, content, manifest }, scene, content);
  if (!gate.ok) return gate;
  const layers = touched.map((t) => layerPatch(t.entityId, t.restore, layerDataOf(gate.scene, t.entityId), t.written));
  return { ok: true, scene: gate.scene, layers, chunks: footprintChunks(layers) };
}

function addCell(cells: Map<string, Set<string>>, layerId: string, at: readonly number[], i: number): void {
  let set = cells.get(layerId);
  if (set === undefined) cells.set(layerId, (set = new Set()));
  set.add(`${at[i]},${at[i + 1]},${at[i + 2]}`);
}

/** The chunks each layer entry changes (the same in both directions). */
export function footprintChunks(layers: readonly BlockLayerPatch[]): FootprintChunks[] {
  return layers.map((l) => ({ entityId: l.entityId, ...patchDelta(l) }));
}

/** The scene with each layer's footprint entry put back (`restore` for undo, `next` for redo). */
export function withFootprintLayers(scene: SceneDocument, layers: readonly BlockLayerPatch[], side: 'restore' | 'next'): SceneDocument {
  let out = scene;
  for (const l of layers) out = withLayerData(out, l.entityId, patchedLayer(layerDataOf(out, l.entityId), l, side));
  return out;
}

/** The change with the footprint chunks named (clients re-read them). */
export function withFootprintChunks<C extends ChangeData>(change: C, layers: readonly BlockLayerPatch[]): C {
  return { ...change, footprints: footprintChunks(layers) };
}
