/**
 * What every part of the block editor reads (its columns, the block type
 * editor, what lies over the Scene view): the layer as the block tools edit
 * it, its remembered editor state (`block-tool-state.ts`), the palette's
 * block types (the layer's kit's, then the other types its cells hold), and
 * the wiring that arms a tool in the Scene view with the column's options.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { BlockLayerComponent, BlockType, KitDef } from '@thirdlight/project-model';

import { brushStore, type BrushStore } from '../../session/brush';
import { type BlockToolId, type PasteSource } from '../../session/block-brush';
import { BLOCK_BRUSH_BOUNDS, BLOCK_DEFAULT_BRUSH, isBlockBrushTool, type BlockBrushTool } from '../../session/block-mode';
import { blockToolStore, type BlockToolState, type BlockToolStore } from '../../session/block-tool-state';
import { parseMetaValue } from '../../session/block-overlay';
import type { ProjectedEntity } from '../../session/projection';
import type { EditModeHost } from '../editmode/modes';
import type { BlockLayerRow, BlockModeHost } from './block-host';

/** A round block brush's shared settings (remembered per tool in this browser). */
export const blockBrushStore = (tool: BlockBrushTool): BrushStore => brushStore('blocks', tool, BLOCK_DEFAULT_BRUSH, BLOCK_BRUSH_BOUNDS);

export interface BlockSetup {
  readonly entity: ProjectedEntity;
  readonly host: EditModeHost;
  readonly blocks: BlockModeHost;
  /** The layer as the Hierarchy flags it (null: not in the open scenes' layers yet). */
  readonly row: BlockLayerRow | null;
  readonly component: BlockLayerComponent;
  readonly locked: boolean;
  readonly store: BlockToolStore;
  readonly state: BlockToolState;
  readonly set: BlockToolStore['set'];
  readonly typeOf: ReadonlyMap<string, BlockType>;
  /** The layer's kit (null: none, or not in the project). */
  readonly kit: KitDef | null;
  /** The palette: the kit's block types, then the other types the layer's cells hold (every type without a kit, or with "all"). */
  readonly palette: readonly BlockType[];
  /** The slice row (the remembered one clamped to the layer; its lowest row before one is chosen). */
  readonly slice: number;
}

/** The block types a layer's cells name (its chunks' palettes). */
function usedTypes(blocks: BlockModeHost, entityId: string): ReadonlySet<string> {
  const out = new Set<string>();
  const layer = blocks.clientRef.current?.getBlockLayers().get(entityId);
  for (const chunk of layer?.chunks.values() ?? []) for (const cell of chunk.palette) if (cell.block !== undefined) out.add(cell.block);
  return out;
}

export function useBlockSetup(entity: ProjectedEntity, host: EditModeHost): BlockSetup {
  const blocks = host.blocks;
  const store = blockToolStore(entity.id);
  const state = useSyncExternalStore(store.subscribe, store.get);
  const row = blocks.rows.find((r) => r.entityId === entity.id) ?? null;
  const component = (row?.component ?? entity.components['blockLayer']) as BlockLayerComponent;
  const types = blocks.types;
  const typeOf = useMemo(() => new Map(types.map((t) => [t.blockId, t])), [types]);
  const kit = component.kitId === undefined ? null : (blocks.kits.find((k) => k.kitId === component.kitId) ?? null);
  const palette = useMemo(() => {
    if (kit === null || state.allTypes) return types;
    const listed = (kit.blockTypes ?? []).map((id) => typeOf.get(id)).filter((t): t is BlockType => t !== undefined);
    const inKit = new Set(listed.map((t) => t.blockId));
    const used = usedTypes(blocks, entity.id);
    return [...listed, ...types.filter((t) => !inKit.has(t.blockId) && used.has(t.blockId))];
    // `row` changes with the layer's cells (the rows are made again after every change).
  }, [kit, state.allTypes, types, typeOf, blocks, entity.id, row]); // eslint-disable-line react-hooks/exhaustive-deps -- `row` stands for the cells `usedTypes` reads
  const b = component.bounds;
  const slice = Math.min(b.max[1] - 1, Math.max(b.min[1], state.slice ?? b.min[1]));
  return { entity, host, blocks, row, component, locked: row?.locked === true, store, state, set: store.set, typeOf, kit, palette, slice };
}

/** The metadata brush's value, parsed by its field's type (null: clear it), or why it cannot paint yet. */
export function metaValueOf(s: BlockSetup): { ok: true; field: string; value: import('@thirdlight/project-model').CellMetaValue | null } | { ok: false; message: string } {
  const m = s.state.meta;
  const field = s.blocks.fields.find((f) => f.key === m.field);
  if (field === undefined) return { ok: false, message: 'Pick a field to paint.' };
  if (m.erase) return { ok: true, field: field.key, value: null };
  const raw = m.raw !== '' ? m.raw : field.type === 'bool' ? 'true' : field.type === 'enum' ? (field.values?.[0] ?? '') : '';
  const v = parseMetaValue(field, raw);
  return v.ok ? { ok: true, field: field.key, value: v.value } : v;
}

/**
 * Arm `tool` in the Scene view on the layer (null: nothing armed — a mode
 * edited through its column only), with the column's options. The options
 * are handed over at every draw; the tool is armed while the column shows.
 */
export function useBlockTool(s: BlockSetup, tool: BlockToolId | null): BrushStore | null {
  const editor = s.blocks.editor;
  const store = tool !== null && isBlockBrushTool(tool) ? blockBrushStore(tool) : null;
  const st = s.state;
  const meta = metaValueOf(s);
  // A moved selection pastes as a move within its layer (the cells leave their place).
  const clip = st.clip;
  const paste: PasteSource | null = clip === null ? null : clip.layerId === s.entity.id ? { kind: 'copy', box: clip.box, ...(clip.move ? { move: true } : {}) } : clip.array;
  useEffect(() => {
    if (tool === null) return;
    editor?.setOptions({
      tool,
      brush: st.brush,
      store,
      invert: false,
      meta: meta.ok ? { field: meta.field, value: meta.value, occupiedOnly: st.meta.occupiedOnly, shape: st.meta.shape } : null,
      region: st.region,
      stamp: st.stamp,
      paste,
      pasteSize: clip === null ? null : [clip.box[3] - clip.box[0], clip.box[4] - clip.box[1], clip.box[5] - clip.box[2]],
    });
  });
  const armed = tool !== null && s.row !== null;
  useEffect(() => {
    editor?.setActive(armed);
    return () => editor?.setActive(false);
  }, [editor, armed]);
  return store;
}

/** One content or scene command of the block editor (true: stored): the op and its arguments, as the editor's runner sends them. */
export function blockCommand(s: Pick<BlockSetup, 'blocks'>, what: string, op: string, args: Record<string, unknown>): Promise<boolean> {
  return s.blocks.run(what, op, args);
}
