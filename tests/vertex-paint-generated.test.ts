/**
 * Path paint drawn on generated meshes: a spline's made data drawn by the
 * renderer's spline view with the object's path paint sampled onto its
 * pieces' vertices (`tlPaint`), where the stroke painted it.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { encodeSplineMade, makeSpline } from '../packages/project-model/src/spline-mesh';
import type { SplineComponent } from '../packages/project-model/src/spline';
import { paintPathDabs, pathPaintFrame } from '../packages/project-model/src/vertex-paint-paths';
import { SplineView } from '../packages/three-adapter/src/spline-view';

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('path paint on a spline', () => {
  it('is sampled onto the strip where it was painted, in the object\'s frame', async () => {
    const spline: SplineComponent = { points: [{ at: [-3, 0, 0] }, { at: [3, 0, 0] }], width: 1.2, mesh: { step: 0.5, offset: 0.05 } } as SplineComponent;
    const made = encodeSplineMade(makeSpline(spline));
    const grid = paintPathDabs(null, pathPaintFrame({ spline }, 'spline')!, 'top', [[-0.5, 0.05, 0]], { radius: 1, strength: 1, channel: 0, falloff: 'constant' }).grid!;
    const blobs = new Map<string, Uint8Array>([['made', made], ['grid', grid.values]]);
    const placed: THREE.Object3D[] = [];
    const view = new SplineView({
      cover: () => undefined,
      read: async (d) => blobs.get(d)!.slice().buffer,
      template: () => null,
      dress: () => null,
      materials: () => null,
      place: (root, shown) => (shown ? placed.push(root) : undefined),
      shapeChanged: () => undefined,
      changed: () => undefined,
    });
    view.set('kerb', { ...spline, data: 'made' }, [-2, 2, -3.4], [{ path: 'spline', side: 'top', origin: grid.origin, size: grid.size, paint: 'grid' }]);
    await settle();
    expect(placed.length).toBe(1);
    const painted: number[] = [];
    placed[0]!.traverse((o) => {
      const m = o as THREE.Mesh;
      const a = m.isMesh === true ? (m.geometry.getAttribute('tlPaint') as THREE.BufferAttribute | undefined) : undefined;
      if (a === undefined) return;
      const pos = m.geometry.getAttribute('position');
      const c = m.parent!.position;
      for (let i = 0; i < a.count; i++) if (a.getX(i) > 0.5) painted.push(Math.round((pos.getX(i) + c.x) * 100) / 100);
    });
    expect(painted.length).toBeGreaterThan(0);
    expect(painted.every((x) => x > -1.6 && x < 0.6)).toBe(true);
    view.dispose();
  });
});
