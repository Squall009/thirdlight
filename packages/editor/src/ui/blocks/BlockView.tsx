/**
 * What the block editor lays over the Scene view while it shows, in every
 * rail mode, and the wiring that lasts as long as the editor does (each
 * mode's column comes and goes with the rail):
 *
 * - the layer handed to the Scene view's block tools, with the slice, the
 *   overlays, the region outlines, the selection and the walls of the rooms
 *   drawn on it (wall paint reaches their faces);
 * - what the tools report back: a picked cell becomes the brush, a dragged
 *   box the selection, a block clicked with no tool its cell the selection
 *   and its block type the one the block type editor shows, the cell under
 *   the pointer the status line's readout;
 * - the selection, which the editor's Esc clears before it drops the tool;
 * - the editor's own keys: PageUp / PageDown move the slice, T turns the
 *   brush, Ctrl+C / Ctrl+X copy or move the selection (Paste picks itself),
 *   Ctrl+V picks Paste, Delete empties the selection, and in Build X
 *   switches to Erase and back;
 * - the slice chip over the view (the row the tools work on, its keys).
 *
 * Browser-only (React).
 */
import { useEffect, useRef, type JSX } from 'react';

import { arrayFromCells, movedBox, nextRotation, pickBrush, sliceKey, type Cell3 } from '../../session/block-brush';
import { blockModeOf } from '../../session/block-mode';
import { isTyping } from '../workspace/EditorWindow';
import { useRoomsBinding } from '../architecture/useRoomsBinding';
import { useEditSelection } from '../editmode/edit-tool';
import { Glyph } from '../editmode/glyphs';
import { Kbd } from '../editmode/Kbd';
import type { EditModeView } from '../editmode/modes';
import { useBlockSetup, type BlockSetup } from './block-column';

/** Copy (or cut, to move) the selection: the cells as they are now, with Paste picked to place them. */
export function copySelection(s: BlockSetup, move: boolean): void {
  const sel = s.state.selection;
  const editor = s.blocks.editor;
  if (sel === null || editor === null) return;
  s.set((st) => ({ clip: { layerId: s.entity.id, box: sel, array: arrayFromCells(sel, (x, y, z) => editor.cellAt(x, y, z), editor.edgesIn(sel)), move }, tiles: { ...st.tiles, build: 'paste' } }));
}

/** Empty the selection's cells (one `editBlocks`); the selection goes with them. */
export async function deleteSelection(s: BlockSetup): Promise<void> {
  const sel = s.state.selection;
  if (sel === null) return;
  if (await s.blocks.edit('Delete cells', s.entity.id, [{ kind: 'fill', box: [...sel], cell: null }])) s.set({ selection: null });
}

/** The slice chip's words and keys. */
function SliceChip({ s }: { s: BlockSetup }): JSX.Element {
  const step = (d: number): void => s.set({ slice: s.slice + d });
  const b = s.component.bounds;
  return (
    <span className="tl-vp-slice" role="group" aria-label="slice" title="The row the tools work on where no block is under the pointer (PageUp / PageDown)">
      <Glyph name="block-slice" size={14} />
      <span>
        Slice · level <b data-slice={s.slice}>{s.slice}</b>
      </span>
      <button type="button" className="tl-vp-slice__btn" aria-label="slice up" disabled={s.slice >= b.max[1] - 1} onClick={() => step(1)}>
        <Kbd k="PgUp" />
      </button>
      <button type="button" className="tl-vp-slice__btn" aria-label="slice down" disabled={s.slice <= b.min[1]} onClick={() => step(-1)}>
        <Kbd k="PgDn" />
      </button>
    </span>
  );
}

export function BlockView({ entity, mode, host }: EditModeView): JSX.Element {
  const s = useBlockSetup(entity, host);
  const { blocks, state } = s;
  const editor = blocks.editor;

  // The layer the Scene view's tools edit, while the editor shows.
  useEffect(() => {
    blocks.setLayer(entity.id);
    return () => blocks.setLayer(null);
  }, [blocks.setLayer, entity.id]); // eslint-disable-line react-hooks/exhaustive-deps -- only the layer's id decides which layer the tools edit
  // The slice, overlays, region outlines and selection follow the editor's state (the layer re-set clamps the slice there too).
  useEffect(() => {
    if (editor !== null && s.row !== null) editor.setSlice(s.slice);
  }, [editor, s.slice, s.row]);
  const shownKey = state.shown.join('\u0000');
  useEffect(() => editor?.setShownFields(new Set(state.shown)), [editor, shownKey]); // eslint-disable-line react-hooks/exhaustive-deps -- the key names the shown fields
  useEffect(() => editor?.setShowRegions(state.showRegions), [editor, state.showRegions]);
  useEffect(() => editor?.setSelection(state.selection), [editor, state.selection]);
  // The rooms drawn on the layer: their walls take the wall paint (and the Rooms mode draws them).
  const rooms = useRoomsBinding(entity, host.entities, blocks.graphs, blocks.kits, blocks.clientRef, blocks.viewportRef, blocks.reportFailure);
  useEffect(() => editor?.setRoomWalls(rooms?.walls ?? null), [editor, rooms?.walls]);
  // Cut-away previews end with the editor.
  useEffect(() => () => {
    for (const r of s.store.get().cutPreview) editor?.previewCutaway(entity.id, r, false);
    s.set({ cutPreview: [] });
  }, [editor, entity.id]); // eslint-disable-line react-hooks/exhaustive-deps -- the store is the layer's; read as it is when the editor closes

  // What the Scene view's tools report back.
  const latest = useRef({ s, mode });
  latest.current = { s, mode };
  useEffect(() => {
    blocks.handlers.current = {
      onPick: (cell) => {
        const q = latest.current.s;
        if (cell === null || cell.block === undefined) return q.blocks.notice('Pick: that cell holds no block.');
        q.set((st) => ({ brush: pickBrush(st.brush, cell), typeOpen: null }));
      },
      onSelect: (box) => latest.current.s.set({ selection: box }),
      onPickCell: (at, cell) => {
        const q = latest.current.s;
        // The block's cell becomes the selection and its type the one the block type editor shows (nothing: both go).
        q.set(at === null ? { selection: null } : { selection: [at[0], at[1], at[2], at[0] + 1, at[1] + 1, at[2] + 1], typeOpen: cell?.block ?? null });
      },
      onHover: (at: Cell3 | null, cell) => {
        const q = latest.current.s;
        const t = cell?.block !== undefined ? q.typeOf.get(cell.block) : undefined;
        const text = at === null ? '' : `cell ${at.join(', ')}${cell?.block !== undefined ? ` · ${t?.name ?? cell.block}${cell.rot !== undefined ? ` ${cell.rot}°` : ''}` : cell !== null ? ' · metadata' : ' · empty'}`;
        if (text !== q.state.hover) q.set({ hover: text });
      },
      onCommitted: (_id, edits) => {
        // A moved selection is placed once; the selection follows it.
        const q = latest.current.s;
        const e = edits[0];
        const clip = q.state.clip;
        if (e?.kind === 'copy' && e.move === true && clip !== null) q.set((st) => ({ selection: movedBox(clip.box, e.to as Cell3), clip: null, tiles: { ...st.tiles, build: 'select' } }));
      },
    };
    return () => {
      blocks.handlers.current = null;
    };
  }, [blocks.handlers]);

  // The editor's keys (captured before the shell's, as the tool grid's letters are).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { s: q, mode: m } = latest.current;
      if (e.defaultPrevented || isTyping(e.target) || document.querySelector('[aria-modal="true"]') !== null || q.row === null) return;
      const mod = e.ctrlKey || e.metaKey;
      const st = q.state;
      const take = (): void => {
        e.preventDefault();
        e.stopPropagation();
      };
      const next = !mod && !e.altKey ? sliceKey(e.key === 'PageUp' || e.key === 'PageDown' ? e.key : '', q.slice, q.component.bounds) : null;
      if (next !== null) {
        take();
        q.set({ slice: next });
        return;
      }
      const key = e.key.toLowerCase();
      if (!mod && !e.altKey && !e.shiftKey && e.code === 'KeyT' && (m === 'build' || m === 'shape')) {
        take();
        q.set((x) => ({ brush: { ...x.brush, rot: nextRotation(x.brush.rot, x.brush.block !== null ? q.typeOf.get(x.brush.block) : undefined) } }));
        return;
      }
      if (m === 'build' && !mod && !e.altKey && !e.shiftKey && e.code === 'KeyX') {
        take();
        q.set((x) => (x.tiles.build === 'erase' ? { tiles: { ...x.tiles, build: x.beforeErase ?? 'single' } } : { tiles: { ...x.tiles, build: 'erase' }, beforeErase: x.tiles.build }));
        return;
      }
      if (st.selection !== null && mod && !e.shiftKey && (key === 'c' || key === 'x')) {
        take();
        copySelection(q, key === 'x');
        return;
      }
      if (st.clip !== null && mod && !e.shiftKey && key === 'v') {
        take();
        q.set((x) => ({ tiles: { ...x.tiles, build: 'paste' } }));
        return;
      }
      if (st.selection !== null && !mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        take();
        void deleteSelection(q);
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const sel = state.selection;
  useEditSelection(sel === null ? null : sel[3] - sel[0] === 1 && sel[4] - sel[1] === 1 && sel[5] - sel[2] === 1 ? `Cell ${sel[0]}, ${sel[1]}, ${sel[2]}` : `${(sel[3] - sel[0]) * (sel[4] - sel[1]) * (sel[5] - sel[2])} cells`, () => s.set({ selection: null }));
  return (
    <>
      {blockModeOf(mode).id !== 'rules' && <SliceChip s={s} />}
    </>
  );
}
