/**
 * Collider shapes: a center and a rotation on every primitive, compounds of
 * primitives, the model's `_COL` parts, colliders on child objects, and the
 * rules that follow the project's physics dimension.
 */
import { describe, expect, it } from 'vitest';

import { canonicalShape, colliderShapePoints, validateColliderShape } from './collider-shapes';
import type { ModelErrorV2, ModelErrorV3 } from './errors';
import { physicsDimensionErrors } from './project-v4';
import { validateSceneV4 } from './scene-v3';

const errorsOf = (shape: unknown): ModelErrorV2[] => {
  const errors: ModelErrorV2[] = [];
  validateColliderShape(shape, '/shape', errors);
  return errors;
};
const Q90Z = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const scene = (entities: unknown[]): unknown => ({ schemaVersion: 4, sceneId: 'main', revision: 1, entities });
const dimensionErrors = (comps: Record<string, unknown>, dimension: 2 | 3): ModelErrorV3[] => {
  const errors: ModelErrorV3[] = [];
  physicsDimensionErrors(comps, '/entities/0', dimension, errors);
  return errors;
};

describe('collider shapes', () => {
  it('places any primitive by a center and a rotation', () => {
    expect(errorsOf({ type: 'box', hx: 1, hy: 1, hz: 1, center: [0, 1, 0], rotation: Q90Z })).toEqual([]);
    expect(errorsOf({ type: 'sphere', radius: 0.5, center: [0, 1, 0] })).toEqual([]);
    expect(errorsOf({ type: 'polygon', vertices: [[-1, -1], [1, -1], [0, 1]], rotation: Q90Z })).toEqual([]);
    expect(errorsOf({ type: 'box', hx: 1, hy: 1, center: [0, 1] }).map((e) => e.path)).toEqual(['/shape/center']);
    expect(errorsOf({ type: 'box', hx: 1, hy: 1, center: [0, 65, 0] }).map((e) => e.path)).toEqual(['/shape/center']);
    expect(errorsOf({ type: 'box', hx: 1, hy: 1, rotation: [0, 0, 1, 1] }).map((e) => e.path)).toEqual(['/shape/rotation']);
  });

  it('takes a compound of primitives (none nested) and the model shape', () => {
    const compound = { type: 'compound', shapes: [{ type: 'box', hx: 1, hy: 1, hz: 1 }, { type: 'convex', points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], center: [2, 0, 0] }] };
    expect(errorsOf(compound)).toEqual([]);
    expect(colliderShapePoints(compound)).toBe(4);
    expect(errorsOf({ type: 'compound', shapes: [] }).map((e) => e.path)).toEqual(['/shape/shapes']);
    expect(errorsOf({ type: 'compound', shapes: [compound] }).map((e) => e.path)).toEqual(['/shape/shapes/0/type']);
    expect(errorsOf({ type: 'compound', shapes: [{ type: 'model' }] }).map((e) => e.path)).toEqual(['/shape/shapes/0/type']);
    expect(errorsOf({ type: 'compound', shapes: [{ type: 'box', hx: -1, hy: 1 }] }).map((e) => e.path)).toEqual(['/shape/shapes/0/hx']);
    expect(errorsOf({ type: 'model' })).toEqual([]);
    expect(errorsOf({ type: 'model', piece: 'x' }).map((e) => e.path)).toEqual(['/shape/piece']);
    // The canonical form keeps the poses (−0 as 0).
    expect(canonicalShape({ type: 'compound', shapes: [{ type: 'box', hx: 1, hy: 1, center: [-0, 1, 0] }] })).toEqual({ type: 'compound', shapes: [{ type: 'box', hx: 1, hy: 1, center: [0, 1, 0] }] });
  });

  it('a model shape needs the object\'s own model; a collider may sit on a child, the controller may not', () => {
    const codes = (entities: unknown[]): string[] => {
      const r = validateSceneV4(scene(entities));
      return r.ok ? [] : r.errors.map((e) => e.code);
    };
    expect(codes([{ id: 'prop-0001', components: { transform: T, collider: { shape: { type: 'model' } } } }])).toContain('component_missing');
    expect(codes([{ id: 'prop-0001', components: { transform: T, model: { asset: { assetId: 'model-a' } }, collider: { shape: { type: 'model' } } } }])).toEqual([]);
    const parent = { id: 'cart-0001', components: { transform: T } };
    expect(codes([parent, { id: 'wheel-0001', parentId: 'cart-0001', components: { transform: { ...T, scale: [2, 2, 2] }, collider: { shape: { type: 'sphere', radius: 0.5 } } } }])).toEqual([]);
    expect(codes([parent, { id: 'hero-0001', parentId: 'cart-0001', components: { transform: T, controller: {} } }])).toContain('physics_transform_unsupported');
    expect(codes([parent, { id: 'lift-0001', parentId: 'cart-0001', components: { transform: T, collider: { shape: { type: 'box', hx: 1, hy: 1 } }, mover: { waypoints: [[0, 1, 0]], speed: 1 } } }])).toContain('physics_transform_unsupported');
  });

  it('checks each shape of a compound against the project\'s dimension', () => {
    const compound = (shapes: unknown[]): Record<string, unknown> => ({ transform: T, collider: { shape: { type: 'compound', shapes } } });
    // 3D: a box needs its depth, a polygon is the plane's.
    expect(dimensionErrors(compound([{ type: 'box', hx: 1, hy: 1, hz: 1 }, { type: 'box', hx: 1, hy: 1 }]), 3).map((e) => e.path)).toEqual(['/entities/0/components/collider/shape/shapes/1/hz']);
    expect(dimensionErrors(compound([{ type: 'polygon', vertices: [[0, 0], [1, 0], [0, 1]] }]), 3).map((e) => e.path)).toEqual(['/entities/0/components/collider/shape/shapes/0/type']);
    // The plane: no 3D shapes, and a turn about Z only.
    expect(dimensionErrors(compound([{ type: 'sphere', radius: 1 }]), 2).map((e) => e.path)).toEqual(['/entities/0/components/collider/shape/shapes/0/type']);
    expect(dimensionErrors(compound([{ type: 'box', hx: 1, hy: 1, rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }]), 2).map((e) => e.path)).toEqual(['/entities/0/components/collider/shape/shapes/0/rotation']);
    expect(dimensionErrors(compound([{ type: 'box', hx: 1, hy: 1, rotation: Q90Z, center: [1, 0, 0] }]), 2)).toEqual([]);
    // A compound holding a sphere scales uniformly.
    expect(dimensionErrors({ ...compound([{ type: 'sphere', radius: 1 }]), transform: { ...T, scale: [1, 2, 1] } }, 3).map((e) => e.reason)).toEqual(['scale']);
  });
});
