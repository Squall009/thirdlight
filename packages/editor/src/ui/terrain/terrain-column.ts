/**
 * What every column of the terrain editor gets, and the wiring each shares:
 * the terrain as the Scene view's terrain tools edit it (`setTarget`), the
 * tool the column arms with its options (`setOptions`, `setActive`), and the
 * editor's remembered state (`terrain-tool-state.ts`).
 *
 * Browser-only (React).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { TerrainComponent } from '@thirdlight/runtime';

import { DEFAULT_BRUSH, brushStore, type BrushStore } from '../../session/brush';
import { TERRAIN_BRUSH_BOUNDS, type TerrainToolId } from '../../session/terrain-brush';
import { terrainToolStore, type TerrainToolState } from '../../session/terrain-tool-state';
import type { TerrainEditor, TerrainToolOptions } from '../../viewport/terrain-editor';
import type { PaletteHost } from '../palette/MaterialLayers';

/**
 * Metres per repeat a terrain's new layered material starts its layers at.
 * The template's 1 m suits a block face; on open ground a texture repeated
 * every metre reads as its average colour from a few metres up and its
 * tiling shows as a grid, so landscape layers are usually tiled every few
 * metres. Existing materials keep what they store.
 */
export const TERRAIN_LAYER_TILING_M = 4;

export interface TerrainColumnProps {
  editor: TerrainEditor | null;
  entityId: string;
  entityName: string;
  component: TerrainComponent;
  /** The terrain object's position (world): its heights are metres above its y. */
  origin: readonly [number, number, number];
  locked: boolean;
  hidden: boolean;
  /** The block layers a conversion may read. */
  blockLayers: readonly { entityId: string; name: string }[];
  /** A command (true: stored). */
  run: (what: string, op: string, args: Record<string, unknown>) => Promise<boolean>;
  /** Stage a file's bytes (its stage id; null: not uploaded). */
  stage: (bytes: Uint8Array) => Promise<string | null>;
  /** The terrain's material mapping (its palette's material). */
  mapping: Readonly<Record<string, string>> | undefined;
  palette: PaletteHost;
}

/** The terrain's remembered editor state and a way to change it. */
export function useTerrainToolState(entityId: string): [TerrainToolState, (patch: Partial<TerrainToolState>) => void] {
  const store = terrainToolStore(entityId);
  const state = useSyncExternalStore(store.subscribe, store.get);
  return [state, store.set];
}

/** A terrain tool's shared brush settings (remembered per tool). */
export const terrainBrushStore = (tool: TerrainToolId): BrushStore => brushStore('terrain', tool, DEFAULT_BRUSH, TERRAIN_BRUSH_BOUNDS);

/**
 * Arm `tool` in the Scene view on this terrain (null: nothing armed — a mode
 * edited through its column only), with the options the column gives it.
 * The options are handed over at every draw (they hold the column's
 * callbacks); the target when the terrain changes.
 */
export function useTerrainTool(p: TerrainColumnProps, tool: TerrainToolId | null, options: Omit<TerrainToolOptions, 'tool' | 'brush' | 'store'> = {}): BrushStore | null {
  const editor = p.editor;
  const [state] = useTerrainToolState(p.entityId);
  const store = tool === null ? null : terrainBrushStore(tool);
  useEffect(() => {
    editor?.setTarget({ entityId: p.entityId, component: p.component, locked: p.locked, hidden: p.hidden });
  }, [editor, p.entityId, p.component, p.locked, p.hidden]);
  useEffect(() => () => editor?.setTarget(null), [editor]);
  useEffect(() => {
    if (tool !== null) editor?.setOptions({ tool, brush: state.brush, store, ...options });
  });
  const armed = tool !== null;
  useEffect(() => {
    editor?.setActive(armed);
    return () => editor?.setActive(false);
  }, [editor, armed]);
  return store;
}
