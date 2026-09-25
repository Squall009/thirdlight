/**
 * Phase 21.4: the projection updates incrementally — copy-on-write entity
 * objects, a cached entity list, a structure version for the tree's shape,
 * and the changed ids — so the editor's views redraw only what changed.
 */
import { describe, expect, it } from 'vitest';
import type { EntityV3 as Entity, Quat, Vec3 } from '@thirdlight/project-model';

import { Projection, type FullState, type MutationApplied } from './projection';

function ent(id: string, parentId: string | null = null): Entity {
  return {
    id,
    name: id,
    parentId: parentId ?? undefined,
    components: {
      transform: { position: [0, 0, 0] as Vec3, rotation: [0, 0, 0, 1] as Quat, scale: [1, 1, 1] as Vec3 },
      box: { size: [1, 1, 1] as Vec3, material: { color: '#ffffff' } },
    },
  };
}

const full = (revision: number, entities: Entity[]): FullState => ({ revision, entities });
const change = (c: unknown): MutationApplied['change'] => c as MutationApplied['change'];
const T0 = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const move = (id: string, x: number, requestId: string, revision: number): MutationApplied => ({
  requestId,
  revision,
  change: change({ type: 'setTransform', id, previous: T0, next: { ...T0, position: [x, 0, 0] }, changedFields: ['position'] }),
});

describe('Projection — incremental updates (phase 21.4)', () => {
  it('listEntities hands out the same array until something changes', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a'), ent('b'), ent('c')]));
    const first = p.listEntities();
    expect(p.listEntities()).toBe(first);
    p.applyMutationApplied(move('b', 2, 'm1', 2));
    const second = p.listEntities();
    expect(second).not.toBe(first);
    expect(p.listEntities()).toBe(second);
  });

  it('a change replaces only the entity it touched (copy-on-write): the others keep their objects', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a'), ent('b'), ent('c')]));
    const [a0, b0, c0] = p.listEntities();
    p.applyMutationApplied(move('b', 2, 'm1', 2));
    const [a1, b1, c1] = p.listEntities();
    expect(a1).toBe(a0);
    expect(c1).toBe(c0);
    expect(b1).not.toBe(b0);
    // The old object is left as it was (a memoised view still holding it sees no mutation).
    expect(b0!.position).toEqual([0, 0, 0]);
    expect(b1!.position).toEqual([2, 0, 0]);
    expect((b1!.components['transform'] as { position: number[] }).position).toEqual([2, 0, 0]);
    expect((b0!.components['transform'] as { position: number[] }).position).toEqual([0, 0, 0]);
  });

  it('structureVersion moves with the tree shape, names and kinds, not with a transform or component value', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a'), ent('b', 'a')]));
    const s0 = p.structureVersion;
    const v0 = p.version;
    p.applyMutationApplied(move('b', 3, 'm1', 2));
    expect(p.version).toBe(v0 + 1);
    expect(p.structureVersion).toBe(s0);
    // A component value edit that keeps the kind: no structure change.
    p.applyMutationApplied({ requestId: 'c1', revision: 3, change: change({ type: 'setComponent', id: 'b', component: 'box', previous: { size: [1, 1, 1], material: { color: '#ffffff' } }, next: { size: [2, 1, 1], material: { color: '#ffffff' } }, changedFields: ['size'] }) });
    expect(p.structureVersion).toBe(s0);
    expect(p.getEntity('b')?.box?.size).toEqual([2, 1, 1]);
    // Removing the box changes the kind (the row's icon): structure.
    p.applyMutationApplied({ requestId: 'c2', revision: 4, change: change({ type: 'setComponent', id: 'b', component: 'box', previous: { size: [2, 1, 1] }, next: null, changedFields: [] }) });
    expect(p.getEntity('b')?.kind).toBe('entity');
    expect(p.structureVersion).toBe(s0 + 1);
    // A rename: structure (names show in the tree and the filter).
    p.applyMutationApplied({ requestId: 'u1', revision: 5, change: change({ type: 'updateEntity', id: 'b', previous: { name: 'b', parentId: 'a' }, next: { name: 'bee', parentId: 'a' }, changedFields: ['name'], order: null }) });
    expect(p.getEntity('b')?.name).toBe('bee');
    expect(p.structureVersion).toBe(s0 + 2);
    // Create and delete: structure.
    p.applyMutationApplied({ requestId: 'n1', revision: 6, change: change({ type: 'createEntity', id: 'c', entity: ent('c') }) });
    expect(p.structureVersion).toBe(s0 + 3);
    p.applyMutationApplied({ requestId: 'd1', revision: 7, change: change({ type: 'deleteEntity', rootId: 'c', deletedIds: ['c'] }) });
    expect(p.structureVersion).toBe(s0 + 4);
    expect(p.entityOrder).toEqual(['a', 'b']);
  });

  it('a content-only change advances the revision without touching the entities', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a')]));
    const [a0] = p.listEntities();
    const s0 = p.structureVersion;
    p.takeDirty();
    p.applyMutationApplied({ requestId: 't1', revision: 2, change: change({ type: 'setTags', previous: [], next: [{ bit: 0, name: 'enemy' }] }) });
    expect(p.revision).toBe(2);
    expect(p.structureVersion).toBe(s0);
    expect(p.listEntities()[0]).toBe(a0);
    expect(p.takeDirty().ids.size).toBe(0);
  });

  it('takeDirty reports the ids changed since the last call (all after a hydrate)', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a'), ent('b'), ent('c')]));
    expect(p.takeDirty().all).toBe(true);
    p.applyMutationApplied(move('a', 1, 'm1', 2));
    p.applyMutationApplied(move('c', 1, 'm2', 3));
    const d = p.takeDirty();
    expect(d.all).toBe(false);
    expect([...d.ids].sort()).toEqual(['a', 'c']);
    expect(p.takeDirty().ids.size).toBe(0);
    p.applyMutationApplied({ requestId: 'd1', revision: 4, change: change({ type: 'deleteEntity', rootId: 'b', deletedIds: ['b'] }) });
    expect([...p.takeDirty().ids]).toEqual(['b']);
  });

  it('a gap or a deduped event changes nothing', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a')]));
    p.applyMutationApplied(move('a', 1, 'm1', 2));
    const list = p.listEntities();
    const v = p.version;
    expect(p.applyMutationApplied(move('a', 5, 'm1', 2)).deduped).toBe(true);
    expect(p.applyMutationApplied(move('a', 5, 'm9', 9)).gap).toBe(true);
    expect(p.listEntities()).toBe(list);
    expect(p.version).toBe(v);
    expect(p.getEntity('a')?.position).toEqual([1, 0, 0]);
  });

  it("new entities in a v4 project live in the edited scene (children in their parent's)", () => {
    const p = new Projection();
    p.hydrate({ revision: 1, entities: [ent('a')], entitySceneIds: ['s1'], scenes: [{ sceneId: 's1', name: 'One' }, { sceneId: 's2', name: 'Two' }], startScenes: ['s1'] });
    p.applyMutationApplied({ requestId: 'n1', revision: 2, sceneId: 's2', change: change({ type: 'createEntity', id: 'b', entity: ent('b'), children: [ent('b1', 'b')] }) });
    expect(p.getEntity('b')?.sceneId).toBe('s2');
    expect(p.getEntity('b1')?.sceneId).toBe('s2');
    expect(p.getEntity('a')?.sceneId).toBe('s1');
  });

  it('10 000 entities: a transform edit costs a few entries, not a rebuild', () => {
    const p = new Projection();
    const many = Array.from({ length: 10_000 }, (_, i) => ent(`e${i}`));
    p.hydrate(full(1, many));
    const before = p.listEntities();
    p.takeDirty();
    p.applyMutationApplied(move('e5000', 1, 'm1', 2));
    const after = p.listEntities();
    let changed = 0;
    for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) changed += 1;
    expect(changed).toBe(1);
    expect([...p.takeDirty().ids]).toEqual(['e5000']);
  });
});
