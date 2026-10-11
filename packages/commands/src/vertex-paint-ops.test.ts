/**
 * `paintVertices` on a generated object's path: the backend reads a dab in
 * the frame the page draws the object in (its own position, nothing else),
 * so the stored stroke is the one the editor's preview drew under the brush,
 * however the object is parented, turned or scaled.
 */
import { describe, expect, it } from 'vitest';

import { paintPathDabs, pathPaintFrame, pathPaintPoint, type PaintVec3, type SplineComponent, type VertexPaintBrush } from '@thirdlight/project-model';

import type { SceneDocument } from './types';
import { planVertexPaint, type VertexPaintReads } from './vertex-paint-ops';

const BRUSH: VertexPaintBrush = { radius: 1.5, strength: 1, channel: 0 };
const SPLINE: SplineComponent = { points: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }] } as SplineComponent;
const turn = (deg: number): number[] => [0, Math.sin((deg * Math.PI) / 360), 0, Math.cos((deg * Math.PI) / 360)];

const blobs = new Map<string, Uint8Array>();
const reads: VertexPaintReads = {
  blob: (d) => ({ ok: true, bytes: blobs.get(d)! }),
  model: () => {
    throw new Error('a path stroke reads no model');
  },
  // Content-addressed by the bytes themselves (the planner only needs equal bytes to name equal blobs).
  hash: (b) => [...b].join('.'),
};

describe('paintVertices on a path', () => {
  it('paints the cell the page drew under the brush for a parented, turned and scaled spline', () => {
    const position = [2, 1, 3];
    const scene = {
      entities: [
        { id: 'group-000001', components: { transform: { position: [10, 0, 5], rotation: turn(90), scale: [1, 1, 1] } } },
        { id: 'spline-000001', parentId: 'group-000001', components: { transform: { position, rotation: turn(45), scale: [2, 2, 2] }, spline: SPLINE } },
      ],
    } as unknown as SceneDocument;
    // Where the pointer met the drawn road: 5 m along it, on its surface (the page draws it at its own position).
    const dab: PaintVec3 = [position[0]! + 5, position[1]!, position[2]!];
    const r = planVertexPaint(scene, undefined, { entityId: 'spline-000001', path: 'spline', side: 'top', dabs: [dab], brush: BRUSH }, reads);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const b of r.blobs) blobs.set(b.digest, b.bytes);
    const stored = (r.prepared.value as { paths: { origin: number[]; size: number[]; paint: string }[] }).paths[0]!;
    // The editor's preview of the same dab (vertex-paint-tool.ts): the same grid, cell for cell.
    const preview = paintPathDabs(null, pathPaintFrame({ spline: SPLINE }, 'spline')!, 'top', [pathPaintPoint(position, dab)], BRUSH).grid!;
    expect(stored.origin).toEqual(preview.origin);
    expect(stored.size).toEqual(preview.size);
    expect([...blobs.get(stored.paint)!]).toEqual([...preview.values]);
  });
});
