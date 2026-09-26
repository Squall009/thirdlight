/**
 * Phase 23.0: a 2D collider takes its entity's rotation about Z. Before 23.0
 * every host read `collider.rotationZ` — a field the collider model never
 * had — so physics always got 0 while the editor drew the collider rotated.
 * `staticColliderOf` is the one place the runtime, Play, the export and the
 * perf harness derive the spec; an unrotated collider keeps exactly its old
 * spec (rotationZ 0).
 */
import { describe, expect, it } from 'vitest';

import { colliderRotationZ, staticColliderOf } from './index';
import { sceneContribution } from './scene-set';

const q = (deg: number): [number, number, number, number] => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];

describe('the collider rotation about Z', () => {
  it('is the quaternion angle about Z, exactly 0 for the identity', () => {
    expect(colliderRotationZ([0, 0, 0, 1])).toBe(0);
    expect(colliderRotationZ([0, 0, 0, -1])).toBe(0);
    expect(colliderRotationZ(undefined)).toBe(0);
    expect(colliderRotationZ(q(30))).toBeCloseTo(Math.PI / 6, 12);
    expect(colliderRotationZ(q(-45))).toBeCloseTo(-Math.PI / 4, 12);
  });

  it('reaches the static collider spec (and a scene load) from the entity transform', () => {
    const components = { transform: { position: [3, 1, 0], rotation: q(20), scale: [1, 1, 1] }, collider: { shape: { type: 'box', hx: 2, hy: 0.1 } } };
    const spec = staticColliderOf('ramp', components);
    expect(spec).toEqual({ entityId: 'ramp', shape: { type: 'box', hx: 2, hy: 0.1 }, position: { x: 3, y: 1 }, rotationZ: expect.closeTo((20 * Math.PI) / 180, 12) });
    const loaded = sceneContribution([{ id: 'ramp', components } as never]);
    expect(loaded.colliders[0]!.rotationZ).toBeCloseTo((20 * Math.PI) / 180, 12);
  });

  it('keeps an unrotated collider exactly as before (kinematic and one-way flags too)', () => {
    const spec = staticColliderOf('lift', { transform: { position: [1, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, collider: { shape: { type: 'box', hx: 1, hy: 0.2 }, oneWay: true }, mover: { waypoints: [[0, 1, 0]] } });
    expect(spec).toEqual({ entityId: 'lift', shape: { type: 'box', hx: 1, hy: 0.2 }, position: { x: 1, y: 2 }, rotationZ: 0, kinematic: true, oneWay: true });
    expect(Object.is(spec!.rotationZ, 0)).toBe(true);
    expect(staticColliderOf('none', { transform: { position: [0, 0, 0] } })).toBeNull();
  });

  it('leaves a box depth out of the 2D-plane shape (phase 23.0: a 2D plane ignores hz)', () => {
    const spec = staticColliderOf('floor', { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, collider: { shape: { type: 'box', hx: 2, hy: 0.5, hz: 3 } } });
    expect(spec!.shape).toEqual({ type: 'box', hx: 2, hy: 0.5 });
  });
});
