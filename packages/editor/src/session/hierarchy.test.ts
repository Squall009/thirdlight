/**
 * Phase 12 hierarchy panel logic: visible rows (collapse, filter),
 * multi-selection, drop targets and the projection of `moveEntities` /
 * flag changes.
 */
import { describe, expect, it } from 'vitest';

import { draggedRoots, dropTarget, dropZoneAt, effectiveFlagsOf, nextSelection, visibleRows } from './hierarchy';
import { Projection, type ProjectedEntity } from './projection';

function e(id: string, parentId: string | null, kind: ProjectedEntity['kind'] = 'box', extra: Partial<ProjectedEntity> = {}): ProjectedEntity {
  return { id, name: id, parentId, kind, active: true, locked: false, static: false, tags: 0, position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1], ...extra };
}

// F (folder) > a > a1 ; b ; G (folder, empty)
const tree = (): ProjectedEntity[] => [e('F', null, 'folder'), e('a', 'F'), e('a1', 'a'), e('b', null), e('G', null, 'folder')];

describe('visibleRows', () => {
  it('walks depth-first and hides the children of collapsed rows', () => {
    expect(visibleRows(tree(), new Set()).map((r) => [r.id, r.depth, r.hasChildren])).toEqual([
      ['F', 0, true],
      ['a', 1, true],
      ['a1', 2, false],
      ['b', 0, false],
      ['G', 0, false],
    ]);
    expect(visibleRows(tree(), new Set(['F'])).map((r) => r.id)).toEqual(['F', 'b', 'G']);
  });

  it('a filter shows matches with their ancestors, even under a collapsed row', () => {
    expect(visibleRows(tree(), new Set(['F']), 'a1').map((r) => r.id)).toEqual(['F', 'a', 'a1']);
  });
});

describe('nextSelection', () => {
  const rows = visibleRows(tree(), new Set());
  it('click selects one, ctrl toggles, shift selects the visible range', () => {
    expect(nextSelection([], null, 'a', { toggle: false, range: false }, rows)).toEqual({ ids: ['a'], primary: 'a', anchor: 'a' });
    expect(nextSelection(['a'], 'a', 'b', { toggle: true, range: false }, rows).ids).toEqual(['a', 'b']);
    expect(nextSelection(['a', 'b'], 'b', 'a', { toggle: true, range: false }, rows)).toMatchObject({ ids: ['b'], primary: 'b' });
    expect(nextSelection(['F'], 'F', 'b', { toggle: false, range: true }, rows).ids).toEqual(['F', 'a', 'a1', 'b']);
  });
});

describe('dropTarget', () => {
  it('maps before/into/after to a parent and beforeId', () => {
    expect(dropZoneAt(1, 20)).toBe('before');
    expect(dropZoneAt(10, 20)).toBe('into');
    expect(dropZoneAt(19, 20)).toBe('after');
    expect(dropTarget(tree(), ['b'], 'a', 'into')).toEqual({ parentId: 'a', beforeId: null, zone: 'into' });
    expect(dropTarget(tree(), ['b'], 'F', 'before')).toEqual({ parentId: null, beforeId: 'F', zone: 'before' });
    expect(dropTarget(tree(), ['G'], 'F', 'after')).toEqual({ parentId: null, beforeId: 'b', zone: 'after' });
    expect(dropTarget(tree(), ['F'], 'b', 'after')).toEqual({ parentId: null, beforeId: 'G', zone: 'after' });
    expect(dropTarget(tree(), ['b'], null, 'after')).toEqual({ parentId: null, beforeId: null, zone: 'after' });
  });

  it('refuses a drop into the dragged subtree, and keeps folders out of objects', () => {
    expect(dropTarget(tree(), ['F'], 'a1', 'into')).toBeNull();
    expect(dropTarget(tree(), ['a'], 'a', 'before')).toBeNull();
    // A folder dropped "into" an object falls back to after it; next to a1 (inside a) it cannot go.
    expect(dropTarget(tree(), ['G'], 'b', 'into')).toEqual({ parentId: null, beforeId: null, zone: 'after' });
    expect(dropTarget(tree(), ['G'], 'a1', 'before')).toBeNull();
    expect(dropTarget(tree(), ['G'], 'F', 'into')).toEqual({ parentId: 'F', beforeId: null, zone: 'into' });
  });

  it('dragged roots drop descendants of other selected entities', () => {
    expect(draggedRoots(tree(), ['a1', 'b', 'F'])).toEqual(['F', 'b']);
  });
});

describe('effective flags and the projection', () => {
  it('folder flags reach the whole subtree', () => {
    const ents = tree();
    ents[0] = e('F', null, 'folder', { locked: true, active: false });
    const f = effectiveFlagsOf(ents);
    expect(f.get('a1')).toMatchObject({ active: false, locked: true, inheritedFrom: { active: 'F', locked: 'F' } });
    expect(f.get('b')).toMatchObject({ active: true, locked: false });
  });

  it('applies moveEntities and flag changes from the change data alone', () => {
    const p = new Projection();
    const T = { position: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as { position: [number, number, number]; rotation: [number, number, number, number]; scale: [number, number, number] };
    p.hydrate({
      revision: 1,
      entities: [
        { id: 'folder-0001', components: { folder: {} } },
        { id: 'box-0001', components: { transform: T } },
      ] as never,
    });
    expect(p.getEntity('folder-0001')).toMatchObject({ kind: 'folder', position: [0, 0, 0], active: true });
    p.applyMutationApplied({
      requestId: 'req-1',
      revision: 2,
      change: {
        type: 'moveEntities',
        parentId: 'folder-0001',
        beforeId: null,
        entities: [{ id: 'box-0001', previous: { parentId: null, transform: T }, next: { parentId: 'folder-0001', transform: T } }],
        order: { previous: ['folder-0001', 'box-0001'], next: ['folder-0001', 'box-0001'] },
      },
    });
    expect(p.getEntity('box-0001')?.parentId).toBe('folder-0001');
    const header = { name: null, parentId: null, active: true, locked: false, static: false, tags: 0 };
    p.applyMutationApplied({
      requestId: 'req-2',
      revision: 3,
      change: { type: 'updateEntity', id: 'folder-0001', previous: header, next: { ...header, active: false, static: true }, changedFields: ['active', 'static'], order: null },
    });
    expect(p.getEntity('folder-0001')).toMatchObject({ active: false, static: true, locked: false });
  });
});
