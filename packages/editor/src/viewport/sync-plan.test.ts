/**
 * Phase 21.3: the Scene view's incremental sync plan — only the changed
 * entities are looked at, and the flags, the zone overlay and the selection
 * are re-derived only when something they read changed.
 */
import { describe, expect, it } from 'vitest';

import type { ProjectedEntity } from '../session/projection';
import { planSync, removedIds, structureOf, zoneRelevant } from './sync-plan';

function entity(id: string, extra: Partial<ProjectedEntity> = {}): ProjectedEntity {
  return { id, name: id, parentId: null, active: true, locked: false, static: false, tags: 0, kind: 'box', position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], components: {}, ...extra } as ProjectedEntity;
}

describe('sync plan', () => {
  const a = entity('a');
  const b = entity('b');
  const zone = entity('z', { gameZone: { role: 'goal', size: [1, 1] } } as Partial<ProjectedEntity>);
  const synced = new Map([a, b, zone].map((e) => [e.id, e]));

  it('no dirty set (or all): everything', () => {
    const p = planSync([a, b, zone], synced, undefined, null);
    expect(p).toMatchObject({ full: true, structural: true, zones: true, selectionTouched: true });
    expect(p.changed).toHaveLength(3);
    expect(planSync([a, b, zone], synced, { all: true, ids: new Set() }, null).full).toBe(true);
  });

  it('a transform edit: one entity, nothing structural, no overlay, no selection', () => {
    const moved = { ...a, position: [1, 2, 3] };
    const p = planSync([moved, b, zone], synced, { all: false, ids: new Set(['a']) }, 'b');
    expect(p.changed.map((e) => e.id)).toEqual(['a']);
    expect(p).toMatchObject({ full: false, structural: false, zones: false, selectionTouched: false });
  });

  it('an entity whose object changed is looked at even when the dirty set does not name it (a scene opened, another caller)', () => {
    const fresh = { ...b };
    const added = entity('c');
    const p = planSync([a, fresh, zone, added], synced, { all: false, ids: new Set() }, null);
    expect(p.changed.map((e) => e.id)).toEqual(['b', 'c']);
    // A new entity changes the tree (flags and folders are re-derived).
    expect(p.structural).toBe(true);
  });

  it('flags and parents are structural; zones, colliders and the player redraw the overlay; the selected entity is touched', () => {
    const hidden = { ...a, active: false };
    expect(planSync([hidden, b, zone], synced, { all: false, ids: new Set(['a']) }, null).structural).toBe(true);
    const reparented = { ...a, parentId: 'b' };
    expect(planSync([reparented, b, zone], synced, { all: false, ids: new Set(['a']) }, null).structural).toBe(true);
    const zoneMoved = { ...zone, position: [4, 0, 0] };
    expect(planSync([a, b, zoneMoved], synced, { all: false, ids: new Set(['z']) }, null).zones).toBe(true);
    // A component removed: the old object had it, so the overlay still redraws.
    const noCollider = entity('b');
    const withCollider = { ...b, collider: { shape: { type: 'box', hx: 1, hy: 1 } } } as ProjectedEntity;
    expect(planSync([a, noCollider, zone], new Map([['a', a], ['b', withCollider], ['z', zone]]), { all: false, ids: new Set(['b']) }, null).zones).toBe(true);
    expect(planSync([{ ...b, position: [9, 9, 9] }, a, zone], synced, { all: false, ids: new Set(['b']) }, 'b').selectionTouched).toBe(true);
    expect(zoneRelevant(entity('p', { controller: true } as Partial<ProjectedEntity>))).toBe(true);
    expect(zoneRelevant(a)).toBe(false);
    expect(structureOf(a)).toBe(structureOf({ ...a, position: [5, 5, 5] }));
  });

  it('removed nodes: none looked for while the counts match; the gone ones otherwise', () => {
    expect(removedIds([a, b], ['a', 'b'], 2, false)).toEqual([]);
    expect(removedIds([a], ['a', 'b'], 2, false)).toEqual(['b']);
    expect(removedIds([a, b], ['a', 'b', 'x'], 3, true)).toEqual(['x']);
  });
});
