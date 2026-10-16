/**
 * A drop on a kit slot (its row on the left, or the picked slot's panel): a
 * GLB file is published, a model tile from the project window taken as it
 * is, and the slot then holds it — one undo step.
 *
 * Browser-only (React events).
 */
import type { DragEvent } from 'react';
import type { KitDef } from '@thirdlight/project-model';

import { assignPiece } from '../../session/kit-edits';
import { ASSET_DRAG_TYPE, assetDropOf } from '../../session/placement';
import type { KitEditor } from './useKitEditor';

/** A GLB file or a model tile dropped on a slot: published if it is a file, then the slot holds it (variant `index`, or added). */
export async function dropOnSlot(ev: DragEvent, editor: KitEditor, kit: KitDef, slot: string, index: number | null): Promise<void> {
  const file = ev.dataTransfer.files[0];
  const tile = file === undefined ? assetDropOf(ev, 'model') : null;
  if (file === undefined && tile === null) return;
  ev.preventDefault();
  await editor.grouped(async (ed) => {
    const assetId = file !== undefined ? await ed.importModel(file) : tile!.assetId;
    if (typeof assetId !== 'string') return;
    editor.setPick({ kind: 'slot', slot, index: index ?? (kit.pieces?.[slot]?.length ?? 0) });
    await ed.save(assignPiece(editor.kit ?? kit, slot, index, { assetId, ...(tile?.piece !== undefined ? { piece: tile.piece } : {}) }));
  });
}

/** Whether a drag carries something a slot takes (a file, a model tile). */
export const slotDragOk = (ev: DragEvent): boolean => ev.dataTransfer.types.includes('Files') || ev.dataTransfer.types.includes(ASSET_DRAG_TYPE);
