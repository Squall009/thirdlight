/**
 * The kit editor's edits: slots listed standard-first, pieces assigned,
 * replaced, weighted and removed (an emptied slot leaves the kit), custom
 * slot names, and slot states from a check report.
 */
import type { BlockType, GraphDocument, KitCheckReport, KitDef } from '@thirdlight/project-model';
import { KIT_LIMITS } from '@thirdlight/project-model/limits';
import { describe, expect, it } from 'vitest';

import { assignPiece, customSlotName, kitSheetSwap, kitSlots, kitTally, removePiece, setPieceNode, setPieceWeight, slotState, withId } from './kit-edits';

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

  it("swapping the kit's trim sheet re-points only its parts that wore the old one", () => {
    const preset = (graphId: string, sheet: string): GraphDocument => ({ graphId, kind: 'architecture-preset', name: graphId, graph: { nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style: '', base: 'starter-room', sheet } }], edges: [] } }) as GraphDocument;
    const graphs = [preset('room', 'old'), preset('hall', ''), preset('other', 'old')];
    const types = [{ blockId: 'wall', name: 'Wall', materials: { '*': 'old', top: 'grass' } }, { blockId: 'slab', name: 'Slab', materials: { '*': 'stone' } }, { blockId: 'loose', name: 'Loose', materials: { '*': 'old' } }] as unknown as BlockType[];
    const kit: KitDef = { kitId: 'k', name: 'K', trimMaterial: 'old', presets: ['room', 'hall'], blockTypes: ['wall', 'slab'], pieces: { door: [{ assetId: 'door', piece: 'door' }], window: [{ assetId: 'window' }, { assetId: 'door', piece: 'leaf' }] } };
    const mappings: Record<string, Record<string, string>> = { door: { trim: 'old', glass: 'glass' }, window: { trim: 'mine' }, crate: { trim: 'old' } };
    const swap = kitSheetSwap(kit, 'old', 'new', graphs, types, (id) => mappings[id]);
    // The room names the old sheet: re-pointed; the hall follows its base; "other" is not the kit's.
    expect(swap.presets).toEqual([{ graphId: 'room', ops: [{ op: 'setNodeData', id: 'preset', data: { style: '', base: 'starter-room', sheet: 'new' } }] }]);
    // The wall's "*" slot wore it (its top keeps grass); the slab wears stone; "loose" is not the kit's.
    expect(swap.blockTypes).toEqual([{ blockId: 'wall', name: 'Wall', materials: { '*': 'new', top: 'grass' } }]);
    // The door's trim material was mapped to the old sheet (once, though two slots name the file); the window's to another; the crate is not the kit's.
    expect(swap.assets).toEqual([{ assetId: 'door', materials: { trim: 'new', glass: 'glass' } }]);
    expect(kitSheetSwap(kit, 'old', 'old', graphs, types)).toEqual({ presets: [], blockTypes: [], assets: [] });
  });
});
