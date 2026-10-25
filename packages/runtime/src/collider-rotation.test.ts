/**
 * A collider takes its entity's rotation, as the editor draws it.
 * `staticColliderOf3D` is the one place the runtime, Play, the export and the
 * perf harness derive the spec; an unrotated collider gets the identity, and
 * a flat box is made solid with the collider's depth.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_COLLIDER_DEPTH } from '@thirdlight/project-model';

import { colliderSpecs3D, staticColliderOf3D } from './index';

const q = (deg: number): [number, number, number, number] => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];

describe('the collider rotation', () => {
  it('reaches the static collider spec (and a scene load) from the entity transform', () => {
    const components = { transform: { position: [3, 1, 0], rotation: q(20), scale: [1, 1, 1] }, collider: { shape: { type: 'box', hx: 2, hy: 0.1, hz: 1 } } };
    const spec = staticColliderOf3D('ramp', components);
    const [x, y, z, w] = q(20);
    expect(spec).toEqual({ entityId: 'ramp', shape: { type: 'box', hx: 2, hy: 0.1, hz: 1 }, position: { x: 3, y: 1, z: 0 }, rotation: { x, y, z, w } });
    const loaded = colliderSpecs3D([{ id: 'ramp', components }]);
    expect(loaded[0]!.rotation).toEqual({ x, y, z, w });
  });

  it('keeps an unrotated collider at the identity (kinematic and one-way flags too)', () => {
    const spec = staticColliderOf3D('lift', { transform: { position: [1, 2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, collider: { shape: { type: 'box', hx: 1, hy: 0.2, hz: 1 }, oneWay: true }, mover: { waypoints: [[0, 1, 0]] } });
    expect(spec).toEqual({ entityId: 'lift', shape: { type: 'box', hx: 1, hy: 0.2, hz: 1 }, position: { x: 1, y: 2, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, kinematic: true, oneWay: true });
    expect(staticColliderOf3D('none', { transform: { position: [0, 0, 0] } })).toBeNull();
  });

  it('makes a flat box solid with the collider\'s depth (the default without one)', () => {
    const flat = staticColliderOf3D('floor', { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, collider: { shape: { type: 'box', hx: 2, hy: 0.5 } } });
    expect(flat!.shape).toEqual({ type: 'box', hx: 2, hy: 0.5, hz: DEFAULT_COLLIDER_DEPTH / 2 });
    const deep = staticColliderOf3D('floor', { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, collider: { shape: { type: 'box', hx: 2, hy: 0.5 }, depth: 6 } });
    expect(deep!.shape).toEqual({ type: 'box', hx: 2, hy: 0.5, hz: 3 });
  });
});
