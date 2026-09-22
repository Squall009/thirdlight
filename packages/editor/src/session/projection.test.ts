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
// ---------------------------------------------------------------------------
// M3 v3 gameplay components (packet 56) — hydration + change convergence
// ---------------------------------------------------------------------------

function entV3(id: string, components: Record<string, unknown>, pos: [number, number, number] = [0, 0, 0]): Entity {
  return {
    id,
    name: id,
    components: {
      transform: { position: pos, rotation: [0, 0, 0, 1] as Quat, scale: [1, 1, 1] as Vec3 },
      ...components,
    },
  };
}

describe('Projection — v3 gameplay components (gameZone / playerSpawn / cameraFollow)', () => {
  const GOAL = { role: 'goal', size: [2, 2] };
  const CHECKPOINT = { role: 'checkpoint', size: [1.5, 1.5], safeSpawnId: 'spawn-0001', activation: { emissive: '#1bc8ff', emissiveIntensity: 1.2, cueAssetId: null } };
  const FOLLOW = { deadZone: { x: 0.3, y: 0.3 }, smoothing: 0.5, bounds: { minX: -10, maxX: 10, minY: -4, maxY: 8 } };

  it('hydrates the v3 components from the full-state entities', () => {
    const p = new Projection();
    p.hydrate(full(1, [
      entV3('zone-0001', { gameZone: GOAL }, [3, 1, 0]),
      entV3('spawn-0001', { playerSpawn: {} }, [0, 2, 0]),
      entV3('cam-main', { camera: {}, cameraFollow: FOLLOW }, [0, 3, 5]),
    ]));
    expect(p.getEntity('zone-0001')?.gameZone).toEqual(GOAL);
    expect(p.getEntity('spawn-0001')?.playerSpawn).toBe(true);
    expect(p.getEntity('cam-main')?.cameraFollow).toEqual(FOLLOW);
    expect(p.getEntity('spawn-0001')?.gameZone).toBeUndefined();
  });

  it('setComponent(gameZone) add / edit / remove converge (previous/next from the wire)', () => {
    const p = new Projection();
    p.hydrate(full(1, [entV3('zone-0001', {})]));
    p.applyMutationApplied({
      requestId: 'c1', revision: 2,
      change: { type: 'setComponent', id: 'zone-0001', component: 'gameZone', previous: null, next: GOAL, changedFields: ['role', 'size'] },
    });
    expect(p.getEntity('zone-0001')?.gameZone).toEqual(GOAL);
    p.applyMutationApplied({
      requestId: 'c2', revision: 3,
      change: { type: 'setComponent', id: 'zone-0001', component: 'gameZone', previous: GOAL, next: { ...GOAL, size: [3, 3] }, changedFields: ['size'] },
    });
    expect(p.getEntity('zone-0001')?.gameZone).toEqual({ role: 'goal', size: [3, 3] });
    p.applyMutationApplied({
      requestId: 'c3', revision: 4,
      change: { type: 'setComponent', id: 'zone-0001', component: 'gameZone', previous: { ...GOAL, size: [3, 3] }, next: null, changedFields: [] },
    });
    expect(p.getEntity('zone-0001')?.gameZone).toBeUndefined();
  });

  it('checkpoint activation changes converge on the same component key', () => {
    const p = new Projection();
    p.hydrate(full(1, [entV3('zone-cp', { gameZone: CHECKPOINT })]));
    p.applyMutationApplied({
      requestId: 'a1', revision: 2,
      change: {
        type: 'setComponent', id: 'zone-cp', component: 'gameZone', previous: CHECKPOINT,
        next: { ...CHECKPOINT, activation: { emissive: '#ff8800', emissiveIntensity: 2, cueAssetId: 'asset-cue' } },
        changedFields: ['activation'],
      },
    });
    expect(p.getEntity('zone-cp')?.gameZone?.activation).toEqual({ emissive: '#ff8800', emissiveIntensity: 2, cueAssetId: 'asset-cue' });
  });

  it('playerSpawn / cameraFollow add + remove converge', () => {
    const p = new Projection();
    p.hydrate(full(1, [entV3('spawn-0001', {}), entV3('cam-main', { camera: {} })]));
    p.applyMutationApplied({
      requestId: 's1', revision: 2,
      change: { type: 'setComponent', id: 'spawn-0001', component: 'playerSpawn', previous: null, next: {}, changedFields: [] },
    });
    p.applyMutationApplied({
      requestId: 'f1', revision: 3,
      change: { type: 'setComponent', id: 'cam-main', component: 'cameraFollow', previous: null, next: FOLLOW, changedFields: ['deadZone', 'smoothing', 'bounds'] },
    });
    expect(p.getEntity('spawn-0001')?.playerSpawn).toBe(true);
    expect(p.getEntity('cam-main')?.cameraFollow).toEqual(FOLLOW);
    p.applyMutationApplied({
      requestId: 'f2', revision: 4,
      change: { type: 'setComponent', id: 'cam-main', component: 'cameraFollow', previous: FOLLOW, next: null, changedFields: [] },
    });
    p.applyMutationApplied({
      requestId: 's2', revision: 5,
      change: { type: 'setComponent', id: 'spawn-0001', component: 'playerSpawn', previous: {}, next: null, changedFields: [] },
    });
    expect(p.getEntity('cam-main')?.cameraFollow).toBeUndefined();
    expect(p.getEntity('spawn-0001')?.playerSpawn).toBeUndefined();
  });

  it('setGameConfig / applySurfacePreset changes are consumed (revision advances, no gap; the block/map lives on the client — §A8 row 19)', () => {
    const p = new Projection();
    p.hydrate(full(1, [ent('a')]));
    const GAME = { configVersion: 1 as const, title: 'T', objective: 'O', instructions: 'I', playerId: 'a', cameraId: 'c', spawnId: 's', level: { minX: -1, maxX: 1, minY: -1, maxY: 1 }, killY: -2, cues: { start: null, jump: null, checkpoint: null, death: null, goal: null } };
    expect(p.applyMutationApplied({ requestId: 'g1', revision: 2, change: { type: 'setGameConfig', previous: null, next: GAME, changedFields: ['title'] } }).applied).toBe(true);
    expect(p.revision).toBe(2);
    expect(p.stale).toBe(false);
    expect(p.applyMutationApplied({ requestId: 'g2', revision: 3, change: { type: 'setGameConfig', previous: GAME, next: null, changedFields: ['title'] } }).applied).toBe(true);
    expect(p.revision).toBe(3);
    expect(p.applyMutationApplied({ requestId: 's1', revision: 4, change: { type: 'applySurfacePreset', id: 'a', preset: 'matte-ground', previous: null, next: { color: '#888888', roughness: 0.9, metalness: 0, emissive: '#000000', emissiveIntensity: 0 }, changedFields: ['color', 'roughness', 'metalness', 'emissive', 'emissiveIntensity'] } }).applied).toBe(true);
    expect(p.revision).toBe(4);
    expect(p.stale).toBe(false);
  });
});
