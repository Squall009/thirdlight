/**
 * Block-layer editing: the block tools' layers, types, cell fields and
 * stamps (the tools show in the Inspector while a block layer is selected,
 * and edit that layer), the Scene view's block tools, props' block
 * footprints and cell-top snapping. `receive` copies the layers from the
 * session client after every applied change and hands them to the Scene view.
 *
 * Footprints and snapping read world places (parents' transforms applied)
 * through the model's helpers, as the command layer does: a prop or a layer
 * under a moved group picks the cells the backend's next move clears.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SessionClient, type BlockLayerView } from '../../session/client';
import { effectiveFlagsOf } from '../../session/hierarchy';
import { presetValue } from '../../session/descriptor-fields';
import type { DescriptorRegistry, BlockEdit, BlockFootprintComponent, BlockLayerComponent, BlockStamp, BlockType, CellField } from '@thirdlight/project-model';
import type { BlockLayerRow, BlockPanelHandlers } from '../BlocksPanel';
import type { BlockEditor } from '../../viewport/block-editor';
import { BlockGrid, footprintCells, footprintEdits, footprintPlaces, placeInWorld, pointInParent, yawQuarterTurns, type FootprintNode } from '@thirdlight/runtime';
import { round4, snapToCellTop, type PropLayer } from '../../session/block-footprint';
import type { Stable } from './useProjectContent';
import type { ClientRef, ReportFailure, SetNotice, ViewportRef } from './commands';

export interface BlockLayersDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  registry: DescriptorRegistry | null;
  /** Moved and dropped objects land on the block cells under them. */
  cellTops: boolean;
  reportFailure: ReportFailure;
  setNotice: SetNotice;
  /** The selected object: the tools edit it while it is a block layer. */
  selectedId: string | null;
  /** Select an object (a new layer is selected, so its tools show). */
  select: (id: string) => void;
}

export function useBlockLayers(deps: BlockLayersDeps) {
  const { clientRef, viewportRef, registry, cellTops, reportFailure, setNotice, selectedId, select } = deps;
  // Block-layer editing (the tools in the Inspector and the Scene view's block tools).
  const [blockEditor, setBlockEditor] = useState<BlockEditor | null>(null);
  const [blockRows, setBlockRows] = useState<readonly BlockLayerRow[]>([]);
  const [blockTypes, setBlockTypes] = useState<readonly BlockType[]>([]);
  const [cellFields, setCellFields] = useState<readonly CellField[]>([]);
  const [blockStamps, setBlockStamps] = useState<readonly BlockStamp[]>([]);
  const [blockLayerId, setBlockLayerId] = useState<string | null>(null);
  const blockLayerIdRef = useRef<string | null>(null);
  blockLayerIdRef.current = blockLayerId;
  const blockHandlersRef = useRef<BlockPanelHandlers | null>(null);
  /** Each layer's cells as a grid (props snap to them and footprints read them), by the client's block revision. */
  const propGridsRef = useRef<{ revision: number; grids: Map<string, BlockGrid> }>({ revision: -1, grids: new Map() });
  /** The block layers props sit on (their cells as grids, rebuilt when the client's cells change). */
  /** The scene's hierarchy as the model's world-place helpers read it. */
  const hierarchy = useCallback((c: SessionClient): Map<string, FootprintNode> => {
    const byId = new Map<string, FootprintNode>();
    for (const e of c.projection.listEntities()) {
      const comps = e.components as FootprintNode['components'];
      byId.set(e.id, {
        id: e.id,
        ...(e.parentId !== null ? { parentId: e.parentId } : {}),
        active: e.active,
        components: {
          ...(e.kind !== 'folder' ? { transform: { position: [e.position[0]!, e.position[1]!, e.position[2]!], rotation: [e.rotation[0]!, e.rotation[1]!, e.rotation[2]!, e.rotation[3]!], scale: [e.scale[0]!, e.scale[1]!, e.scale[2]!] } } : {}),
          ...(comps.blockFootprint !== undefined ? { blockFootprint: comps.blockFootprint } : {}),
          ...(comps.blockLayer !== undefined ? { blockLayer: comps.blockLayer } : {}),
        },
      });
    }
    return byId;
  }, []);
  const propLayers = useCallback((only?: string): PropLayer[] => {
    const c = clientRef.current;
    if (!c) return [];
    const byId = hierarchy(c);
    const cache = propGridsRef.current;
    if (cache.revision !== c.getBlockRevision()) propGridsRef.current = { revision: c.getBlockRevision(), grids: new Map() };
    const grids = propGridsRef.current.grids;
    const out: PropLayer[] = [];
    for (const [id, l] of c.getBlockLayers()) {
      if (only !== undefined && id !== only) continue;
      const e = c.projection.getEntity(id);
      if (!e || e.active === false) continue;
      let g = grids.get(id);
      if (g === undefined) grids.set(id, (g = BlockGrid.from(l.component, { entityId: id, chunks: [...l.chunks.values()] })));
      const grid = g;
      // The layer's world origin (a layer under a moved group sits where it is drawn).
      const origin = placeInWorld(byId, e.parentId, e.position, [0, 0, 0, 1]).position;
      out.push({ entityId: id, component: l.component, origin, columnTop: (x, z) => grid.columnTop(x, z) });
    }
    return out;
  }, [clientRef, hierarchy]);
  /**
   * Write a prop's block footprint into the cells beneath it again (one
   * editBlocks per layer), after the cells were edited by hand. Moving,
   * placing and deleting the prop write it in the backend with that command.
   */
  const writeFootprint = useCallback(async (entityId: string) => {
    const c = clientRef.current;
    if (!c) return;
    // The prop's world place, as the backend reads it.
    const at = footprintPlaces(hierarchy(c).values()).props.get(entityId);
    if (at === undefined) return;
    for (const layer of propLayers(at.fp.layer)) {
      const edits = footprintEdits([], footprintCells(layer, at.position, at.rotation, at.fp), at.fp.set);
      if (edits === null) continue;
      const r = await c.command('editBlocks', { entityId: layer.entityId, edits }, c.projection.revision);
      if (!r.ok && (r.response as { code?: string }).code !== 'no_change') reportFailure('Block footprint', r);
    }
  }, [clientRef, hierarchy, propLayers, reportFailure]);
  /**
   * Snap an object at a local position and rotation (under its parent; a dropped object, `entityId` null, at the
   * root) onto the cell tops under its world place, as a local position again (null: over no layer).
   */
  const snapLocal = useCallback((entityId: string | null, position: readonly number[], rotation: readonly number[]): [number, number, number] | null => {
    const c = clientRef.current;
    if (!c) return null;
    if (entityId !== null && c.getBlockLayers().has(entityId)) return null;
    const e = entityId !== null ? c.projection.getEntity(entityId) : undefined;
    const fp = (e?.components as { blockFootprint?: BlockFootprintComponent } | undefined)?.blockFootprint;
    const parentId = e?.parentId ?? null;
    const byId = hierarchy(c);
    const world = placeInWorld(byId, parentId, position, rotation);
    const at = snapToCellTop(propLayers(fp?.layer), world.position, fp?.size, yawQuarterTurns(world.rotation));
    if (at === null) return null;
    if (parentId === null) return at;
    const local = pointInParent(byId, parentId, at);
    return local === null ? null : [round4(local[0]), round4(local[1]), round4(local[2])];
  }, [clientRef, hierarchy, propLayers]);
  // Cell-top snapping: moved and dropped objects land on the block cells under them.
  useEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    v.setCellTopSnap(cellTops ? snapLocal : null);
  }, [cellTops, snapLocal, blockEditor, viewportRef]);
  const blockRun = useCallback(async (what: string, op: string, args: Record<string, unknown>): Promise<boolean> => {
    const c = clientRef.current;
    if (!c) return false;
    const r = await c.command(op, args, c.projection.revision);
    if (!r.ok && (r.response as { code?: string }).code === 'no_change') return false;
    reportFailure(what, r);
    return r.ok;
  }, [clientRef, reportFailure]);
  const blockEdit = useCallback((what: string, entityId: string, edits: BlockEdit[]) => blockRun(what, 'editBlocks', { entityId, edits }), [blockRun]);
  const createBlockLayer = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const value = presetValue(registry, 'blockLayer');
    if (value === null) return setNotice('New block layer failed: the component defaults have not arrived yet');
    const res = await c.command('createEntity', { parentId: null, kind: 'group', name: 'Block layer', transform: { position: [0, 0, 0] } }, c.projection.revision);
    if (!res.ok || res.createdId === undefined) return reportFailure('New block layer', res);
    const id = res.createdId;
    reportFailure('New block layer', await c.command('setComponent', { entityId: id, component: 'blockLayer', value }, c.projection.revision));
    select(id);
  }, [clientRef, registry, reportFailure, setNotice, select]);

  /** The Scene view's block tools edit the chosen layer (none: no layer chosen, or it is gone). */
  const pushLayer = useCallback((c: SessionClient, layers: ReadonlyMap<string, { component: BlockLayerComponent; chunks: BlockLayerView['chunks']; origin: number[] }>, rows: readonly BlockLayerRow[]) => {
    const sel = blockLayerIdRef.current;
    const l = sel !== null ? layers.get(sel) : undefined;
    const row = rows.find((r) => r.entityId === sel);
    viewportRef.current?.blockEditor()?.setLayer(l !== undefined && row !== undefined ? { entityId: sel!, component: l.component, origin: l.origin, chunks: l.chunks, regions: row.regions, locked: row.locked, hidden: !row.active } : null, c.getBlockRevision());
  }, [viewportRef]);
  const rowsRef = useRef<readonly BlockLayerRow[]>([]);
  rowsRef.current = blockRows;
  // Selecting a block layer makes it the one the tools edit (the Inspector shows its tools).
  useEffect(() => {
    const c = clientRef.current;
    if (c === null || selectedId === null || selectedId === blockLayerIdRef.current) return;
    const l = c.getBlockLayers().get(selectedId);
    const e = c.projection.getEntity(selectedId);
    if (l === undefined || e === undefined) return;
    blockLayerIdRef.current = selectedId;
    setBlockLayerId(selectedId);
    pushLayer(c, new Map([[selectedId, { component: l.component, chunks: l.chunks, origin: e.position }]]), rowsRef.current);
  }, [clientRef, selectedId, pushLayer, blockRows]);

  /** The block layers (cells, block types) at their entities' positions, for the tools and the Scene view. */
  const receive = useCallback((c: SessionClient, stable: Stable) => {
    // The block layers (cells, block types) at their entities' positions.
    const blockLayers = c.getBlockLayers();
    if (blockLayers.size > 0 || c.getBlockRevision() > 0) {
      const byId = new Map(c.projection.listEntities().map((e) => [e.id, e]));
      const layers = new Map([...blockLayers].filter(([id]) => byId.has(id)).map(([id, l]) => [id, { component: l.component, chunks: l.chunks, origin: byId.get(id)!.position }]));
      // An inactive layer object is not drawn.
      const flags = effectiveFlagsOf(c.projection.listEntities());
      for (const [id, l] of layers) (l as { hidden?: boolean }).hidden = flags.get(id)?.active === false;
      viewportRef.current?.setBlockLayers(c.getBlockTypes(), layers, c.getBlockRevision());
      // The tools' layer list and the Scene view's chosen layer.
      const rows: BlockLayerRow[] = [...blockLayers]
        .filter(([id]) => byId.has(id))
        .map(([id, l]) => ({ entityId: id, name: byId.get(id)!.name ?? id, component: l.component, regions: l.regions, active: flags.get(id)?.active !== false, locked: flags.get(id)?.locked === true }));
      setBlockRows(stable('blockRows', rows));
      pushLayer(c, layers, rows);
    } else setBlockRows(stable('blockRows', []));
    setBlockTypes(stable('blockTypes', c.getBlockTypes()));
    setCellFields(stable('cellFields', c.getCellFields()));
    setBlockStamps(stable('blockStamps', c.getBlockStamps()));
    viewportRef.current?.blockEditor()?.setContent(c.getBlockTypes(), c.getCellFields(), c.getBlockStamps());
  }, [viewportRef, pushLayer]);

  return {
    blockEditor, setBlockEditor, blockRows, blockTypes, cellFields, blockStamps, blockLayerId, setBlockLayerId, blockLayerIdRef, blockHandlersRef,
    propLayers, writeFootprint, snapLocal, blockRun, blockEdit, createBlockLayer, receive,
  };
}

export type BlockLayers = ReturnType<typeof useBlockLayers>;
