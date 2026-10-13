/**
 * The kit editor's edits: slots listed standard-first, pieces assigned,
 * replaced, weighted and removed (an emptied slot leaves the kit), custom
 * slot names, and slot states from a check report.
 */
import type { KitCheckReport, KitDef } from '@thirdlight/project-model';
import { KIT_LIMITS } from '@thirdlight/project-model/limits';
import { describe, expect, it } from 'vitest';

import { assignPiece, customSlotName, kitSlots, kitTally, removePiece, setPieceNode, setPieceWeight, slotState, withId } from './kit-edits';

const KIT: KitDef = { kitId: 'k', name: 'K', pieces: { door: [{ assetId: 'd1' }], 'shop-sign': [{ assetId: 's', piece: 'sign' }] } };

describe('kit edits', () => {
  it('lists the standard slots, then its own', () => {
    const slots = kitSlots(KIT);
    expect(slots.map((s) => s.slot)).toEqual(['door', 'window', 'wall-override', 'corner', 'stairs', 'railing', 'roof-edge', 'shop-sign']);
    expect(slots[0]).toMatchObject({ label: 'Door', standard: true, placement: { kind: 'opening', sill: 0 } });
    expect(slots.at(-1)).toMatchObject({ label: 'shop-sign', standard: false, placement: { kind: 'free' } });
  });

  it('assigns, replaces (keeping the weight), weighs, picks a node and removes; an emptied slot is not stored', () => {
    let k = assignPiece(KIT, 'window', null, { assetId: 'w', piece: 'window' });
    expect(k.pieces!['window']).toEqual([{ assetId: 'w', piece: 'window' }]);
    k = setPieceWeight(assignPiece(k, 'door', null, { assetId: 'd2' }), 'door', 0, 3);
    k = assignPiece(k, 'door', 0, { assetId: 'd3', piece: 'a' });
    expect(k.pieces!['door']).toEqual([{ assetId: 'd3', piece: 'a', weight: 3 }, { assetId: 'd2' }]);
    expect(setPieceWeight(k, 'door', 0, 1).pieces!['door']![0]).toEqual({ assetId: 'd3', piece: 'a' });
    expect(setPieceNode(k, 'door', 0, '').pieces!['door']![0]).toEqual({ assetId: 'd3', weight: 3 });
    k = removePiece(removePiece(k, 'door', 1), 'door', 0);
    expect(k.pieces!['door']).toBeUndefined();
    expect(removePiece(removePiece(k, 'window', 0), 'shop-sign', 0)).toEqual({ kitId: 'k', name: 'K' });
  });

  it('a full slot replaces its last variant', () => {
    let k: KitDef = { kitId: 'k', name: 'K' };
    for (let i = 0; i < KIT_LIMITS.piecesPerSlot + 2; i++) k = assignPiece(k, 'door', null, { assetId: `d${i}` });
    expect(k.pieces!['door']!.length).toBe(KIT_LIMITS.piecesPerSlot);
    expect(k.pieces!['door']!.at(-1)!.assetId).toBe(`d${KIT_LIMITS.piecesPerSlot + 1}`);
  });

  it('custom slot names: made from words, unique', () => {
    expect(customSlotName(KIT, 'Market Stall')).toEqual({ ok: true, slot: 'market-stall' });
    expect(customSlotName(KIT, 'Shop sign').ok).toBe(false);
    expect(customSlotName(KIT, 'door').ok).toBe(false);
    expect(customSlotName(KIT, '  ').ok).toBe(false);
  });

  it('slot states and the kit tally from a report', () => {
    const report: KitCheckReport = {
      ok: true,
      kitId: 'k',
      sheet: null,
      pieces: [{ slot: 'door', index: 0, assetId: 'd1', present: true, pieces: ['door'], triangles: [12], lods: [], collider: false, checks: [{ id: 'origin', state: 'err', title: '', detail: '' }, { id: 'lods', state: 'warn', title: '', detail: '' }] }],
    };
    expect(slotState(report, 'door', KIT.pieces!['door']!)).toBe('err');
    expect(slotState(report, 'window', [])).toBeNull();
    expect(slotState(null, 'door', KIT.pieces!['door']!)).toBeNull();
    expect(kitTally(report)).toEqual({ errors: 1, warnings: 1 });
    expect(withId(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(withId(['a', 'b'], 'a', false)).toEqual(['b']);
  });
});
