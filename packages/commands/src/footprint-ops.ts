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
 * The history entry keeps each touched layer's entry before and after the
 * footprint writes; undo puts the "before" back ahead of the command's own
 * inverse (the reverse order of the forward step), redo puts the "after"
 * back once the command is re-applied. The change names the chunks so
 * clients re-read them as they do for `editBlocks`.
 */
import {
  applyBlockEdits,
  BlockGrid,
  footprintCells,
  footprintEdits,
  type BlockEdit,
  type BlockFootprintComponent,
  type BlockLayerComponent,
  type BlockLayerData,
  type FootprintLayer,
  type Manifest,
} from '@thirdlight/project-model';

import { blockStampsOf, blockTypesOf, layerDataOf, layerDelta, withLayerData } from './block-ops';
import { contentOf } from './content-ops';
import { fieldValue, type CommandError } from './errors';
import { gateResultState } from './ops';
import { deepEqual } from './properties';
import type { ChangeData, ContentDocument, SceneDocument } from './types';
import { decompose, worldMatrix, type HierarchyNode } from './world-transform';

/** One layer's entry before and after a command's footprint writes (null = none). */
export interface FootprintLayerEntry {
  entityId: string;
  restore: BlockLayerData | null;
  next: BlockLayerData | null;
}

/** The chunks (and regions) of one layer a command's footprint writes changed. */
export interface FootprintChunks {
  entityId: string;
  chunks: [number, number][];
  regions: string[];
}

interface PropAt {
  fp: BlockFootprintComponent;
  position: readonly number[];
  rotation: readonly number[];
}

type Entity = HierarchyNode & { active?: boolean; components: HierarchyNode['components'] & { blockFootprint?: BlockFootprintComponent; blockLayer?: BlockLayerComponent } };

function hasFootprint(scene: SceneDocument): boolean {
  return scene.entities.some((e) => (e as unknown as Entity).components.blockFootprint !== undefined);
}

/** The props with footprints (world position and rotation) and the active block layers (world origin). */
function placesOf(scene: SceneDocument): { props: Map<string, PropAt>; layers: Map<string, FootprintLayer> } {
  const byId = new Map(scene.entities.map((e) => [e.id, e as unknown as Entity]));
  const props = new Map<string, PropAt>();
  const layers = new Map<string, FootprintLayer>();
  for (const e of byId.values()) {
    const fp = e.components.blockFootprint;
    const layer = e.components.blockLayer;
    if (fp === undefined && (layer === undefined || e.active === false)) continue;
    const m = worldMatrix(byId, e.id);
    if (fp !== undefined) props.set(e.id, { fp, position: [m[12]!, m[13]!, m[14]!], rotation: decompose(m).rotation });
    if (layer !== undefined && e.active !== false) layers.set(e.id, { component: layer, origin: [m[12]!, m[13]!, m[14]!] });
  }
  return { props, layers };
}

function cellsOn(layerId: string, layer: FootprintLayer | undefined, p: PropAt | undefined): number[] {
  if (layer === undefined || p === undefined || (p.fp.layer !== undefined && p.fp.layer !== layerId)) return [];
  return footprintCells(layer, p.position, p.rotation, p.fp);
}

export type FootprintOutcome =
  | { ok: true; scene: SceneDocument; layers: FootprintLayerEntry[]; chunks: FootprintChunks[] }
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
  // Clears first, then writes: a prop moving off cells another prop covers does not undo the other's write.
  const clears = new Map<string, BlockEdit[][]>();
  const writes = new Map<string, BlockEdit[][]>();
  for (const id of new Set([...was.props.keys(), ...now.props.keys()])) {
    const b = was.props.get(id);
    const a = now.props.get(id);
    if (b !== undefined && a !== undefined && deepEqual(b, a)) continue;
    for (const [layerId, layer] of now.layers) {
      const edits = footprintEdits(cellsOn(layerId, was.layers.get(layerId), b), cellsOn(layerId, layer, a), a?.fp.set ?? {}, b?.fp.set ?? {});
      if (edits === null) continue;
      const writing = (e: BlockEdit): boolean => e.kind === 'meta' && Object.values(e.set).some((v) => v !== null);
      const c = edits.filter((e) => !writing(e));
      const w = edits.filter(writing);
      if (c.length > 0) clears.set(layerId, [...(clears.get(layerId) ?? []), c]);
      if (w.length > 0) writes.set(layerId, [...(writes.get(layerId) ?? []), w]);
    }
  }
  if (clears.size === 0 && writes.size === 0) return { ok: true, scene: null };
  const c = contentOf(content);
  const ctx = { types: new Map(blockTypesOf(c).map((t) => [t.blockId, t])), stamps: new Map(blockStampsOf(c).map((s) => [s.stampId, s])) };
  let scene = after;
  const touched: { entityId: string; restore: BlockLayerData | null }[] = [];
  for (const [layerId, layer] of now.layers) {
    // One prop's edits per call: the per-command cell budget holds for each footprint, not for all of them together.
    const steps = [...(clears.get(layerId) ?? []), ...(writes.get(layerId) ?? [])];
    if (steps.length === 0) continue;
    const previous = layerDataOf(scene, layerId);
    const grid = BlockGrid.from(layer.component, previous);
    for (const edits of steps) {
      const r = applyBlockEdits(grid, edits, ctx);
      if (!r.ok) return { ok: false, error: fieldValue('/args', undefined, 'a block footprint that fits its layer', `a prop's block footprint on layer ${layerId}: ${r.message}`) };
    }
    const next = grid.toData(layerId, previous, grid.takeDirty().chunks);
    const delta = layerDelta(previous, next);
    if (delta.chunks.length === 0 && delta.regions.length === 0) continue;
    scene = withLayerData(scene, layerId, next);
    touched.push({ entityId: layerId, restore: previous });
  }
  if (touched.length === 0) return { ok: true, scene: null };
  const gate = gateResultState({ scene: before, content, manifest }, scene, content);
  if (!gate.ok) return gate;
  const layers = touched.map((t) => ({ entityId: t.entityId, restore: t.restore, next: layerDataOf(gate.scene, t.entityId) }));
  return { ok: true, scene: gate.scene, layers, chunks: footprintChunks(layers) };
}

/** The chunks each layer entry changes (the same in both directions). */
export function footprintChunks(layers: readonly FootprintLayerEntry[]): FootprintChunks[] {
  return layers.map((l) => ({ entityId: l.entityId, ...layerDelta(l.restore, l.next) }));
}

/** The scene with each layer's footprint entry put back (`restore` for undo, `next` for redo). */
export function withFootprintLayers(scene: SceneDocument, layers: readonly FootprintLayerEntry[], side: 'restore' | 'next'): SceneDocument {
  let out = scene;
  for (const l of layers) out = withLayerData(out, l.entityId, l[side]);
  return out;
}

/** The change with the footprint chunks named (clients re-read them). */
export function withFootprintChunks<C extends ChangeData>(change: C, layers: readonly FootprintLayerEntry[]): C {
  return { ...change, footprints: footprintChunks(layers) };
}
