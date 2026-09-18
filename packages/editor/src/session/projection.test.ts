import { describe, it, expect } from 'vitest';
import { Projection, type FullState, type MutationApplied } from './projection';
import type { Entity, Vec3, Quat } from '@thirdlight/project-model';

function ent(id: string, parentId: string | null = null, pos: Vec3 = [0, 0, 0]): Entity {
  return {
    id,
    name: id,
    parentId: parentId ?? undefined,
    components: {
      transform: { position: pos, rotation: [0, 0, 0, 1] as Quat, scale: [1, 1, 1] as Vec3 },
      box: { size: [1, 1, 1] as Vec3, material: { color: '#ffffff' } },
    },
  };
}

function full(revision: number, entities: Entity[]): FullState {
  return { revision, entities };
}

describe('Projection — hydration + document order', () => {
  it('hydrates from full state and lists in document order', () => {
    const p = new Projection();
    p.hydrate(full(2, [ent('a'), ent('b', 'a'), ent('c')]));
    expect(p.revision).toBe(2);
    expect(p.entityOrder).toEqual(['a', 'b', 'c']);
    expect(p.listEntities().map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(p.stale).toBe(false);
  });

  it('re-hydration replaces the prior state (authoritative resync)', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a')]));
    p.hydrate(full(3, [ent('x'), ent('y')]));
    expect(p.revision).toBe(3);
    expect(p.entityOrder).toEqual(['x', 'y']);
  });
});

describe('Projection — applyMutationApplied (dedup + gap rule)', () => {
  it('applies a createEntity change and advances the revision', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a')]));
    const r = p.applyMutationApplied({
      requestId: 'req-1',
      revision: 2,
      change: { type: 'createEntity', id: 'b', entity: ent('b', 'a') },
    } satisfies MutationApplied);
    expect(r).toEqual({ deduped: false, gap: false, applied: true });
    expect(p.entityOrder).toEqual(['a', 'b']);
    expect(p.revision).toBe(2);
  });

  it('dedups a repeated requestId (our own command echoed back)', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a')]));
    p.applyMutationApplied({ requestId: 'req-9', revision: 2, change: { type: 'createEntity', id: 'b', entity: ent('b') } });
    const again = p.applyMutationApplied({ requestId: 'req-9', revision: 2, change: { type: 'createEntity', id: 'b', entity: ent('b') } });
    expect(again.deduped).toBe(true);
    expect(again.applied).toBe(false);
    // no double-apply: b appears once
    expect(p.entityOrder).toEqual(['a', 'b']);
  });

  it('the gap rule: a revision jump past lastSeen+1 flags stale and does NOT apply', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a')]));
    // revision 3 arrives while we are at 1 (we missed revision 2)
    const r = p.applyMutationApplied({ requestId: 'req-x', revision: 3, change: { type: 'createEntity', id: 'z', entity: ent('z') } });
    expect(r.gap).toBe(true);
    expect(r.applied).toBe(false);
    expect(p.stale).toBe(true);
    // the missed change is NOT applied
    expect(p.entityOrder).toEqual(['a']);
    expect(p.revision).toBe(1);
  });

  it('a consecutive revision (lastSeen+1) applies without a gap', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a')]));
    const r = p.applyMutationApplied({ requestId: 'r1', revision: 2, change: { type: 'setTransform', id: 'a', previous: { position: [0,0,0], rotation: [0,0,0,1], scale: [1,1,1] }, next: { position: [1,0,0], rotation: [0,0,0,1], scale: [1,1,1] }, changedFields: ['position'] } });
    expect(r.gap).toBe(false);
    expect(r.applied).toBe(true);
    expect(p.getEntity('a')?.position).toEqual([1, 0, 0]);
    expect(p.stale).toBe(false);
  });

  it('deleteEntity removes the subtree; restoreSubtree re-adds it', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a'), ent('b', 'a')]));
    p.applyMutationApplied({ requestId: 'd1', revision: 2, change: { type: 'deleteEntity', rootId: 'a', deletedIds: ['a', 'b'] } });
    expect(p.entityOrder).toEqual([]);
    p.applyMutationApplied({
      requestId: 'r1',
      revision: 3,
      change: { type: 'restoreSubtree', rootId: 'a', entities: [ent('a'), ent('b', 'a')] },
    });
    expect(p.entityOrder).toContain('a');
    expect(p.entityOrder).toContain('b');
  });
});

describe('Projection — conflict explanation (never silently lost)', () => {
  it('describeConflict carries currentRevision + expectedRevision + message', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a')]));
    const c = p.describeConflict(1, 4, 'expected revision 1, current is 4');
    expect(c.code).toBe('revision_conflict');
    expect(c.currentRevision).toBe(4);
    expect(c.expectedRevision).toBe(1);
    expect(c.message).toBeTruthy();
    // the projection is still valid (not corrupted)
    expect(p.getEntity('a')?.id).toBe('a');
  });
});