/**
 * Phase 14.0: the Scene-view size handles (pure geometry): which shapes an
 * entity has, where the handles sit, what a drag stores (snapped, clamped),
 * and "Fit to model".
 */
import { describe, expect, it } from 'vitest';

import type { ProjectedEntity } from './projection';
import { capsuleDistance, fitCapsule, handlePoint, handlesOf, outlinePoints, resizeShape, SNAP_SIZE_M, sizeEdit, sizeShapesOf } from './size-handles';

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
  ...over,
});

describe('size handles', () => {
  it('the default capsule sits centred on the player; the top handle keeps the feet', () => {
    const [cap] = sizeShapesOf(entity({ controller: true }));
    expect(cap).toMatchObject({ component: 'controller', kind: 'capsule', center: { x: 2, y: 1 }, half: { x: 0.3, y: 0.9 } });
    expect(handlePoint(cap!, 'top')).toEqual({ x: 2, y: 1.9 });
    expect(handlePoint(cap!, 'side')).toEqual({ x: 2.3, y: 1 });
    // Drag the top down to 1.02 m (the feet stay at 0.1): height 0.92 snaps to 0.9, the offset follows.
    const lower = resizeShape(cap!, 'top', { x: 2.4, y: 1.02 }, true);
    expect(sizeEdit(lower)).toEqual({ component: 'controller', value: { capsule: { radius: 0.3, height: 0.9, offset: [0, -0.45] } } });
    // Unsnapped (Shift): the exact height.
    expect(sizeEdit(resizeShape(cap!, 'top', { x: 2, y: 1.234 }, false)).value).toEqual({ capsule: { radius: 0.3, height: 1.134, offset: [0, -0.333] } });
    // The side handle drags the radius; it never exceeds half the height.
    expect(sizeEdit(resizeShape(cap!, 'side', { x: 2.52, y: 5 }, true)).value).toEqual({ capsule: { radius: 0.5, height: 1.8 } });
    expect(resizeShape(cap!, 'side', { x: 9, y: 1 }, true).half.x).toBe(0.9);
    // The height never drops under two radii.
    expect(resizeShape(cap!, 'top', { x: 2, y: -5 }, true).half.y).toBeCloseTo(0.3, 9);
  });

  it('a stored capsule with an offset keeps its feet and its offset x', () => {
    const [cap] = sizeShapesOf(entity({ controller: true, capsule: { radius: 0.25, height: 1, offset: [0.1, 0.5] } }));
    expect(cap!.center).toEqual({ x: 2.1, y: 1.5 });
    expect(sizeEdit(resizeShape(cap!, 'top', { x: 0, y: 2.51 }, true)).value).toEqual({ capsule: { radius: 0.25, height: 1.5, offset: [0.1, 0.75] } });
  });

  it('centred boxes grow symmetrically; an enemy box keeps its feet; a collider turns with its entity', () => {
    const shapes = sizeShapesOf(
      entity({
        blocks: { trigger: { size: [2, 2], signal: 's' }, enemy: { size: [0.8, 0.8] } },
        gameZone: { role: 'hazard', size: [1, 1] } as ProjectedEntity['gameZone'],
        fogVolume: { size: [4, 2, 3], density: 0.2, color: '#ffffff' },
      }),
    );
    expect(shapes.map((s) => s.component)).toEqual(['gameZone', 'trigger', 'enemy', 'fogVolume']);
    const trigger = shapes[1]!;
    expect(sizeEdit(resizeShape(trigger, 'top', { x: 2, y: 2.62 }, true))).toEqual({ component: 'trigger', value: { size: [2, 3.25] } });
    expect(sizeEdit(resizeShape(trigger, 'side', { x: 0.5, y: 1 }, true))).toEqual({ component: 'trigger', value: { size: [3, 2] } });
    const enemy = shapes[2]!;
    expect(enemy.center).toEqual({ x: 2, y: 1.4 });
    expect(handlePoint(enemy, 'top').y).toBeCloseTo(1.8, 9);
    expect(sizeEdit(resizeShape(enemy, 'top', { x: 2, y: 2.21 }, true))).toEqual({ component: 'enemy', value: { size: [0.8, 1.2] } });
    expect(sizeEdit(resizeShape(shapes[3]!, 'side', { x: 5, y: 1 }, false))).toEqual({ component: 'fogVolume', value: { size: [6, 2, 3] } });
    // A collider turned 90° about Z: its top handle is to the left of its centre.
    const q = [0, 0, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4)];
    const [col] = sizeShapesOf(entity({ rotation: q, collider: { shape: { type: 'box', hx: 1, hy: 0.25 } } }));
    const top = handlePoint(col!, 'top');
    expect(top.x).toBeCloseTo(1.75, 9);
    expect(top.y).toBeCloseTo(1, 9);
    expect(sizeEdit(resizeShape(col!, 'top', { x: 1.5, y: 1 }, true))).toEqual({ component: 'collider', value: { shape: { type: 'box', hx: 1, hy: 0.5 } } });
    // Sizes stay in range.
    expect(sizeEdit(resizeShape(trigger, 'side', { x: 2, y: 1 }, true)).value).toEqual({ size: [0.05, 2] });
    expect(SNAP_SIZE_M).toBe(0.05);
  });

  it('phase 14.2: a circle trigger has one radius handle; the radius snaps, stays in range and is stored alone', () => {
    const [ring] = sizeShapesOf(entity({ blocks: { trigger: { shape: 'circle', radius: 1, signal: 's' } } }));
    expect(ring).toMatchObject({ component: 'trigger', kind: 'circle', center: { x: 2, y: 1 }, half: { x: 1, y: 1 } });
    expect(handlesOf(ring!)).toEqual(['side']);
    expect(handlePoint(ring!, 'side')).toEqual({ x: 3, y: 1 });
    // Any direction measures the radius (the pointer's distance from the centre).
    expect(sizeEdit(resizeShape(ring!, 'side', { x: 2, y: 2.62 }, true))).toEqual({ component: 'trigger', value: { radius: 1.6 } });
    expect(sizeEdit(resizeShape(ring!, 'side', { x: 2.123, y: 1 }, false)).value).toEqual({ radius: 0.123 });
    expect(resizeShape(ring!, 'side', { x: 2, y: 1 }, true).half.x).toBe(0.025);
    expect(resizeShape(ring!, 'side', { x: 900, y: 1 }, true).half.x).toBe(250);
    // The outline is a closed circle.
    const pts = outlinePoints(ring!, 12);
    expect(pts[0]).toEqual(pts[pts.length - 1]);
    for (const p of pts) expect(Math.hypot(p.x - 2, p.y - 1)).toBeCloseTo(1, 9);
    // A box trigger keeps its two handles.
    expect(handlesOf(sizeShapesOf(entity({ blocks: { trigger: { size: [2, 2], signal: 's' } } }))[0]!)).toEqual(['top', 'side']);
  });

  it('fits a capsule to a model bounding box (feet at its lowest point)', () => {
    expect(fitCapsule({ min: [-0.3, 0, -0.2], max: [0.3, 1.1, 0.25] })).toEqual({ radius: 0.225, height: 1.1, offset: [0, 0.55] });
    // A model hanging below the origin (origin at the hips) and a very wide one.
    expect(fitCapsule({ min: [-2, -0.5, -2], max: [2, 0.5, 2] })).toEqual({ radius: 0.5, height: 1, offset: [0, 0] });
    expect(fitCapsule({ min: [0, 0, 0], max: [0, 1, 1] })).toBeNull();
  });

  it('measures the distance to a capsule outline', () => {
    const [cap] = sizeShapesOf(entity({ controller: true }));
    expect(capsuleDistance(cap!, { x: 2, y: 1 })).toBeCloseTo(-0.3, 9);
    expect(capsuleDistance(cap!, { x: 2.3, y: 1.2 })).toBeCloseTo(0, 9);
    expect(capsuleDistance(cap!, { x: 2, y: 2.4 })).toBeCloseTo(0.5, 9);
  });
});
