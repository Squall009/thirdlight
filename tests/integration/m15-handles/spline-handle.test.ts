/**
 * The spline handle against the real descriptors: grips across the ground,
 * height, width and tangent grips, inserting on the curve, deleting a point
 * or a tangent, and the `setComponent` value a drag stores.
 */
import { describe, expect, it } from 'vitest';
import { DESCRIPTORS } from '@thirdlight/project-model';

import { commitValue, deletePoint, dragGrip, gripsOf, handleShapesOf, insertPoint, linesOf, type HandleShape } from '../../../packages/editor/src/session/handles';
import type { ProjectedEntity } from '../../../packages/editor/src/session/projection';
import { SPLINE_HEIGHT_GRIP_M } from '../../../packages/editor/src/session/spline-handle';

const entity = (spline: unknown): ProjectedEntity => ({
  id: 'road-0001',
  name: 'Road',
  parentId: null,
  kind: 'entity',
  active: true,
  visible: true,
  locked: false,
  static: false,
  keepLoaded: false,
  tags: 0,
  position: [100, 0, 50],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  components: { spline },
});

const shapeOf = (spline: unknown): HandleShape => {
  const s = handleShapesOf(entity(spline), DESCRIPTORS, 3).find((x) => x.component === 'spline');
  if (s === undefined) throw new Error('no spline handle');
  return s;
};

describe('the spline handle', () => {
  const road = { points: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }, { at: [20, 0, 0] }], width: 6 };

  it('reads the points in the object-position frame, with grips for each point and between them', () => {
    const s = shapeOf(road);
    expect(s.frame).toBe('position');
    const ids = gripsOf(s).map((g) => g.id);
    expect(ids).toEqual(['p0', 'h0', 'w0', 't0', 'p1', 'h1', 'w1', 't1', 'p2', 'h2', 'w2', 't2', 'i1', 'i2']);
    const w1 = gripsOf(s).find((g) => g.id === 'w1')!;
    // Going +x the right edge is +z, half the width out.
    expect(w1.at.z).toBeCloseTo(3, 6);
    expect(gripsOf(s).find((g) => g.id === 'p1')!.drag).toBe('level');
    // The outline: the curve, its two edges and a tangent tick per point.
    expect(linesOf(s)).toHaveLength(3 + 3);
  });

  it('drags across the ground, up, wider and pulls a tangent; one setComponent stores the points', () => {
    let s = shapeOf(road);
    s = dragGrip(s, 'p1', { x: 10.04, y: 7, z: 4.02 }, true);
    s = dragGrip(s, 'h1', { x: 0, y: 2 + SPLINE_HEIGHT_GRIP_M, z: 0 }, true);
    s = dragGrip(s, 'w2', { x: 20, y: 0, z: 5 }, true);
    // The pulled tangent keeps the rise the smooth curve had there (point 1 is 2 m up now).
    s = dragGrip(s, 't0', { x: 2, y: 0, z: 1 }, true);
    const c = commitValue(s);
    expect(c).toEqual({ ok: true, component: 'spline', value: { points: [{ at: [0, 0, 0], tangent: [6, 2, 3] }, { at: [10, 2, 4] }, { at: [20, 0, 0], width: 10 }] } });
  });

  it('inserts on the curve and deletes points and tangents', () => {
    const s = shapeOf({ ...road, points: [{ at: [0, 0, 0], tangent: [5, 0, 0] }, { at: [10, 0, 0], width: 2 }, { at: [20, 0, 0] }] });
    const made = insertPoint(s, 'i2')!;
    expect(made.grip).toBe('p2');
    const m = made.shape.model as { pts: { at: { x: number }; width?: number }[] };
    expect(m.pts).toHaveLength(4);
    expect(m.pts[2]!.at.x).toBeCloseTo(15, 1);
    expect(m.pts[2]!.width).toBeCloseTo(4, 1);
    const del = deletePoint(s, 't0');
    expect(del.ok && commitValue(del.shape)).toEqual({ ok: true, component: 'spline', value: { points: [{ at: [0, 0, 0] }, { at: [10, 0, 0], width: 2 }, { at: [20, 0, 0] }] } });
    expect(deletePoint(s, 't1')).toMatchObject({ ok: false });
    const two = shapeOf({ points: [{ at: [0, 0, 0] }, { at: [5, 0, 0] }] });
    expect(deletePoint(two, 'p0')).toMatchObject({ ok: false });
  });
});
