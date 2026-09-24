/**
 * Phase 14.0: the player's capsule outline and "Fit to model" (pure
 * geometry). Dragging sizes is the phase 15.2 handle system (`handles.ts`,
 * tested against the real descriptors in `tests/integration/m15-handles`).
 */
import { describe, expect, it } from 'vitest';

import type { ProjectedEntity } from './projection';
import { capsuleDistance, capsuleShapeOf, fitCapsule, outlinePoints, SNAP_SIZE_M } from './size-handles';

const entity = (over: Partial<ProjectedEntity>): ProjectedEntity => ({
  id: 'e-0001',
  name: 'E',
  parentId: null,
  kind: 'entity',
  active: true,
  locked: false,
  static: false,
  tags: 0,
  position: [2, 1, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
  components: {},
  ...over,
});

describe('the capsule outline', () => {
  it('the default capsule sits centred on the player; a stored one follows its offset', () => {
    expect(capsuleShapeOf(entity({}))).toBeNull();
    expect(capsuleShapeOf(entity({ controller: true }))).toMatchObject({ kind: 'capsule', center: { x: 2, y: 1 }, half: { x: 0.3, y: 0.9 } });
    expect(capsuleShapeOf(entity({ controller: true, capsule: { radius: 0.25, height: 1, offset: [0.1, 0.5] } }))!.center).toEqual({ x: 2.1, y: 1.5 });
    expect(SNAP_SIZE_M).toBe(0.05);
  });

  it('a circle outline is closed', () => {
    const pts = outlinePoints({ kind: 'circle', center: { x: 2, y: 1 }, half: { x: 1, y: 1 } }, 12);
    expect(pts[0]).toEqual(pts[pts.length - 1]);
    for (const p of pts) expect(Math.hypot(p.x - 2, p.y - 1)).toBeCloseTo(1, 9);
  });

  it('fits a capsule to a model bounding box (feet at its lowest point)', () => {
    expect(fitCapsule({ min: [-0.3, 0, -0.2], max: [0.3, 1.1, 0.25] })).toEqual({ radius: 0.225, height: 1.1, offset: [0, 0.55] });
    // A model hanging below the origin (origin at the hips) and a very wide one.
    expect(fitCapsule({ min: [-2, -0.5, -2], max: [2, 0.5, 2] })).toEqual({ radius: 0.5, height: 1, offset: [0, 0] });
    expect(fitCapsule({ min: [0, 0, 0], max: [0, 1, 1] })).toBeNull();
  });

  it('measures the distance to a capsule outline', () => {
    const cap = capsuleShapeOf(entity({ controller: true }))!;
    expect(capsuleDistance(cap, { x: 2, y: 1 })).toBeCloseTo(-0.3, 9);
    expect(capsuleDistance(cap, { x: 2.3, y: 1.2 })).toBeCloseTo(0, 9);
    expect(capsuleDistance(cap, { x: 2, y: 2.4 })).toBeCloseTo(0.5, 9);
  });
});
