/**
 * The collider system: a collider on a child stays static where its parents
 * put it until one of them is moved — by a script that owns it, a timeline,
 * a mover — and is then re-added as a kinematic body and posed from its
 * world transform every step; a mesh collider stays static (one warning).
 */
import { describe, expect, it } from 'vitest';

import { ColliderSystem } from './collider-system';
import type { PhysicsPort3D, StaticColliderSpec3D } from './ports';
import type { TransformState } from './types-simulation';

type Ent = { id: string; parentId?: string; components: Record<string, unknown> };
const T = (position: number[]): { position: number[]; rotation: number[]; scale: number[] } => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });

function world(entities: Ent[]) {
  const curr = new Map<string, TransformState>(entities.map((e) => [e.id, structuredClone(e.components['transform']) as TransformState]));
  const added: StaticColliderSpec3D[] = [];
  const removed: string[] = [];
  const warnings: string[] = [];
  let owned: string[] = [];
  const port = {
    dimension: 3,
    addStaticColliders: (specs: readonly StaticColliderSpec3D[]) => void added.push(...specs),
    removeStaticColliders: (ids: readonly string[]) => void removed.push(...ids),
    setKinematicPoses: () => undefined,
  } as unknown as PhysicsPort3D;
  const byId = new Map(entities.map((e) => [e.id, e]));
  const system = new ColliderSystem({
    physics3d: port,
    curr: () => curr,
    parentOf: (id) => (byId.has(id) ? (byId.get(id)!.parentId ?? null) : undefined),
    inactive: () => new Set(),
    ownedIds: () => owned,
    componentsOf: (id) => byId.get(id)?.components,
    warn: (m) => void warnings.push(m),
  });
  system.track(entities);
  return { system, curr, added, removed, warnings, own: (ids: string[]) => void (owned = ids) };
}

const box = { shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5 } };

describe('the collider system', () => {
  it('a child collider follows a parent a script moves: kinematic, posed where the parent took it', () => {
    const w = world([
      { id: 'cart', components: { transform: T([0, 0, 0]) } },
      { id: 'side', parentId: 'cart', components: { transform: T([1, 0, 0]), collider: box } },
      { id: 'rock', components: { transform: T([5, 0, 0]), collider: box } },
    ]);
    expect(w.system.sync()).toBeNull();
    expect(w.added).toEqual([]);
    w.own(['cart']);
    w.system.markDirty();
    expect(w.system.sync()).toBeNull();
    expect(w.removed).toEqual(['side']);
    expect(w.added.map((s) => [s.entityId, s.kinematic, s.position])).toEqual([['side', true, { x: 1, y: 0, z: 0 }]]);
    w.curr.get('cart')!.position[0] = 3;
    expect(w.system.poses().map((p) => [p.entityId, p.position])).toEqual([['side', [4, 0, 0]]]);
    expect(w.system.poses()[0]!.aabb).toEqual({ min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] });
  });

  it('a timeline\'s move and a mover parent make it follow too; a mesh stays static with one warning', () => {
    const mesh = { shape: { type: 'mesh', vertices: [[0, 0, 0], [1, 0, 0], [0, 0, 1]], triangles: [[0, 2, 1]] } };
    const w = world([
      { id: 'door', components: { transform: T([0, 0, 0]) } },
      { id: 'panel', parentId: 'door', components: { transform: T([0, 1, 0]), collider: box } },
      { id: 'lift', components: { transform: T([0, 0, 9]), mover: { waypoints: [[0, 3, 0]], speed: 1 }, collider: box } },
      { id: 'rail', parentId: 'lift', components: { transform: T([1, 0, 0]), collider: box } },
      { id: 'ramp', parentId: 'door', components: { transform: T([0, 0, 1]), collider: mesh } },
    ]);
    w.system.timelineMove('door');
    expect(w.system.needsSync).toBe(true);
    expect(w.system.sync()).toBeNull();
    // The mover's own collider is the mover's; its child's and the door's child's follow; the mesh does not.
    expect(w.added.map((s) => s.entityId).sort()).toEqual(['panel', 'rail']);
    expect(w.warnings).toHaveLength(1);
    w.system.markDirty();
    w.system.sync();
    expect(w.warnings).toHaveLength(1);
  });
});
