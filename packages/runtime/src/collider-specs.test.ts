/**
 * Collider specs: each shape at its center and rotation (scaled with its
 * object; a turned shape under an uneven scale moved into the body's frame
 * as points), compounds, `model` shapes from the build's table, and colliders
 * on children placed where their parents put them.
 */
import { describe, expect, it } from 'vitest';

import { colliderShape2DOf, colliderShape3DOf, colliderSpecs2D, colliderSpecs3D, shapeAabb3 } from './collider-specs';

const T = (position: number[] = [0, 0, 0], rotation: number[] = [0, 0, 0, 1], scale: number[] = [1, 1, 1]) => ({ position, rotation, scale });
const Q90Y = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
const close = (a: readonly number[], b: readonly number[]): void => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 9));

describe('collider specs', () => {
  it('keeps an unplaced primitive as it was; places one with a center and rotation as a compound of one', () => {
    expect(colliderShape3DOf({ type: 'box', hx: 1, hy: 2, hz: 3 }, [2, 1, 1])).toEqual({ type: 'box', hx: 2, hy: 2, hz: 3 });
    const placed = colliderShape3DOf({ type: 'box', hx: 1, hy: 2, hz: 3, center: [0, 1, 0], rotation: Q90Y }, [2, 2, 2]);
    expect(placed).toMatchObject({ type: 'compound', parts: [{ shape: { type: 'box', hx: 2, hy: 4, hz: 6 }, position: { x: 0, y: 2, z: 0 } }] });
  });

  it('moves a turned shape under an uneven scale into the body frame as points', () => {
    const s = colliderShape3DOf({ type: 'box', hx: 1, hy: 1, hz: 1, center: [1, 0, 0], rotation: Q90Y }, [2, 1, 1]);
    expect(s?.type).toBe('compound');
    const part = (s as unknown as { parts: { shape: { type: string; points: number[] }; position: unknown }[] }).parts[0]!;
    expect(part.shape.type).toBe('convex');
    expect(part.position).toEqual({ x: 0, y: 0, z: 0 });
    const xs = part.shape.points.filter((_, i) => i % 3 === 0);
    // The cube's x after the turn spans 0..2 around its center 1, then doubled: 0..4.
    expect(Math.min(...xs)).toBeCloseTo(0, 9);
    expect(Math.max(...xs)).toBeCloseTo(4, 9);
  });

  it('makes a compound of the model table\'s parts; none without them', () => {
    const table = { 'model-a': { crate: [[[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], [[2, 0, 0], [3, 0, 0], [2, 1, 0], [2, 0, 1]]] } };
    const comps = { model: { asset: { assetId: 'model-a' }, piece: 'crate' } };
    const s = colliderShape3DOf({ type: 'model' }, [1, 2, 1], comps, { modelColliders: table });
    expect(s).toMatchObject({ type: 'compound', parts: [{ shape: { type: 'convex', points: [0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 1] } }, { shape: { type: 'convex' } }] });
    expect(colliderShape3DOf({ type: 'model' }, [1, 1, 1], comps)).toBeNull();
    // On the plane each part is its XY hull.
    expect(colliderShape2DOf({ type: 'model' }, comps, { modelColliders: table })).toEqual({ type: 'compound', parts: [
      { shape: { type: 'polygon', vertices: [[0, 0], [1, 0], [0, 1]] }, x: 0, y: 0, angle: 0 },
      { shape: { type: 'polygon', vertices: [[2, 0], [3, 0], [2, 1]] }, x: 0, y: 0, angle: 0 },
    ] });
  });

  it('places a collider on a child where its parents put it (3D and the plane)', () => {
    const entities = [
      { id: 'cart', components: { transform: T([10, 0, 0], Q90Y, [2, 2, 2]) } },
      { id: 'wheel', parentId: 'cart', components: { transform: T([1, 0, 0]), collider: { shape: { type: 'sphere', radius: 0.5 } } } },
    ];
    const [spec] = colliderSpecs3D(entities);
    // The parent turned 90° about Y takes the child's +X to −Z, doubled.
    close([spec!.position.x, spec!.position.y, spec!.position.z], [10, 0, -2]);
    expect((spec!.shape as { radius: number }).radius).toBeCloseTo(1, 9);
    const flat = [
      { id: 'arm', components: { transform: T([5, 1, 0], [0, 0, Math.SQRT1_2, Math.SQRT1_2]) } },
      { id: 'hand', parentId: 'arm', components: { transform: T([2, 0, 0]), collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } },
    ];
    const [s2] = colliderSpecs2D(flat);
    close([s2!.position.x, s2!.position.y], [5, 3]);
    expect(s2!.rotationZ).toBeCloseTo(Math.PI / 2, 9);
    // A parent already in the game (outside the list) places a newly loaded child too.
    const [late] = colliderSpecs3D([entities[1]!], { outside: { transform: (id) => (id === 'cart' ? (T([0, 5, 0]) as never) : undefined), parentOf: () => null } });
    close([late!.position.x, late!.position.y, late!.position.z], [1, 5, 0]);
  });

  it('measures a compound\'s box over its placed parts', () => {
    const box = shapeAabb3({ type: 'compound', parts: [{ shape: { type: 'box', hx: 1, hy: 1, hz: 1 }, position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }, { shape: { type: 'sphere', radius: 0.5 }, position: { x: -1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } }] }, [0, 0, 0, 1]);
    expect(box).toEqual({ min: [-1.5, -1, -1], max: [4, 1, 1] });
  });
});
