/**
 * Phase 21.4: the change record on the WS — no previous side, keyed lists as
 * deltas — and the editor's rebuild of the full list.
 */
import { describe, expect, it } from 'vitest';
import type { ChangeData } from '@thirdlight/commands';

import { fromWireChange, toWireChange } from './wire-change';

const mat = (i: number, roughness = 0.5): Record<string, unknown> => ({ materialId: `mat-${i}`, name: `Material ${i}`, shader: 'standard', params: { color: '#808080', roughness }, textures: {} });
const asChange = (c: unknown): ChangeData => c as ChangeData;

describe('toWireChange / fromWireChange', () => {
  it('drops the previous side of a set-style change', () => {
    const wire = toWireChange(asChange({ type: 'setComponent', id: 'box-0001', component: 'box', previous: { size: [1, 1, 1] }, next: { size: [2, 1, 1] }, changedFields: ['size'] }));
    expect(wire).toEqual({ type: 'setComponent', id: 'box-0001', component: 'box', next: { size: [2, 1, 1] }, changedFields: ['size'] });
    expect(fromWireChange(wire, {})).toBe(wire);
  });

  it('drops the repeated entity order and the per-entity previous of a move', () => {
    const order = Array.from({ length: 1000 }, (_, i) => `box-${i}`);
    const wire = toWireChange(asChange({
      type: 'moveEntities',
      entities: [{ id: 'box-1', previous: { parentId: null, transform: null }, next: { parentId: 'box-2', transform: null } }],
      order: { previous: order, next: [...order].reverse() },
    }));
    expect(wire['order']).toEqual({ next: [...order].reverse() });
    expect(wire['entities']).toEqual([{ id: 'box-1', next: { parentId: 'box-2', transform: null } }]);
    const upd = toWireChange(asChange({ type: 'updateEntity', id: 'a', previous: { name: 'a' }, next: { name: 'b' }, changedFields: ['name'], order: null, transform: { previous: { position: [0, 0, 0] }, next: { position: [1, 0, 0] } } }));
    expect(upd).toEqual({ type: 'updateEntity', id: 'a', next: { name: 'b' }, changedFields: ['name'], order: null, transform: { next: { position: [1, 0, 0] } } });
  });

  it('one edited material of 500 travels as one material, and the editor rebuilds the whole list', () => {
    const before = Array.from({ length: 500 }, (_, i) => mat(i));
    const after = before.map((m, i) => (i === 250 ? mat(250, 0.9) : m));
    const full = asChange({ type: 'setMaterials', previous: before, next: after });
    const wire = toWireChange(full);
    expect(wire['next']).toBeUndefined();
    expect((wire['delta'] as { upsert: unknown[] }).upsert).toEqual([mat(250, 0.9)]);
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(full).length / 20);
    const rebuilt = fromWireChange(wire, { setMaterials: before }) as unknown as { type: string; next: unknown[] };
    expect(rebuilt.type).toBe('setMaterials');
    expect(rebuilt.next).toEqual(after);
  });

  it('adds, removes and reorders through the delta; an unknown id means the copy does not fit', () => {
    const before = [mat(1), mat(2), mat(3)];
    const after = [mat(3), mat(1), mat(4)];
    const wire = toWireChange(asChange({ type: 'setMaterials', previous: before, next: after }));
    expect((wire['delta'] as { upsert: unknown[] }).upsert).toEqual([mat(4)]);
    expect((fromWireChange(wire, { setMaterials: before }) as unknown as { next: unknown[] }).next).toEqual(after);
    // A client without material 3 cannot rebuild: null (it resyncs).
    expect(fromWireChange(wire, { setMaterials: [mat(1)] })).toBeNull();
  });

  it('animators use their controller id', () => {
    const a = (id: string, speed: number) => ({ controllerId: id, name: id, parameters: [], layers: [{ speed }] });
    const wire = toWireChange(asChange({ type: 'setAnimators', previous: [a('x', 1), a('y', 1)], next: [a('x', 1), a('y', 2)] }));
    expect(wire['delta']).toEqual({ key: 'controllerId', order: ['x', 'y'], upsert: [a('y', 2)] });
    expect((fromWireChange(wire, { setAnimators: [a('x', 1), a('y', 1)] }) as unknown as { next: unknown[] }).next).toEqual([a('x', 1), a('y', 2)]);
  });
});
