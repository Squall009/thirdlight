/**
 * The per-body heap estimate against the real Rapier heap: bodies of each
 * kind added to one world, the heap's growth over each batch compared with
 * the estimates' sum. Batches are large (8 MB) so the 64 KiB page steps
 * and any free space left by earlier tests are small against them; the
 * meshes, whose building leaves the most freed scratch, go last.
 */
import { describe, expect, it } from 'vitest';

import { createPhysicsPort3D, estimateStaticBodyBytes3D, physicsMemoryBytes3D, type ColliderShape3D } from './index';

const I = { x: 0, y: 0, z: 0, w: 1 };
const AT = { x: 0, y: 0, z: 0 };

/** A bumpy ground of n × n cells (2n² triangles), wound to face up. */
function ground(n: number): ColliderShape3D {
  const vertices: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) vertices.push(i * 0.5, Math.sin(i * 0.7) * 0.3 + Math.cos(j * 0.4) * 0.2, j * 0.5);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = i * (n + 1) + j;
    indices.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
  }
  return { type: 'compound', parts: [{ shape: { type: 'mesh', vertices, indices, oriented: true }, position: AT, rotation: I }] };
}

const shapes: Record<string, ColliderShape3D> = {
  'heightfield 32 × 32': { type: 'compound', parts: [{ shape: { type: 'heightfield', cellsX: 32, cellsZ: 32, cellX: 0.5, cellZ: 0.5, heights: new Float32Array(33 * 33) }, position: AT, rotation: I }] },
  'compound of 100 boxes': { type: 'compound', parts: Array.from({ length: 100 }, (_, i) => ({ shape: { type: 'box' as const, hx: 0.25, hy: 0.25, hz: 0.25 }, position: { x: i, y: 0, z: 0 }, rotation: I })) },
  'convex hull of 64 points': { type: 'convex', points: Array.from({ length: 64 }, (_, i) => { const y = 1 - (2 * i + 1) / 64; const r = Math.sqrt(1 - y * y); return [Math.cos(i * 2.399) * r, y, Math.sin(i * 2.399) * r]; }).flat() },
  'mesh 512 triangles': ground(16),
  'mesh 1,922 triangles (the vertex limit)': ground(31),
};

describe('estimateStaticBodyBytes3D', () => {
  it('is within 0.8–1.25× of the heap a batch of bodies grows it by; removing and adding them again stops growing it', async () => {
    const r = await createPhysicsPort3D({ character: { position: AT, radius: 0.3, halfHeight: 0.5, offset: { x: 0, y: 0.8, z: 0 } }, noCharacter: true, statics: [], solver: { hz: 60, gravityY: -9.81 }, controller: { offsetSkin: 0.01, groundSnap: 0.1, maxSlopeClimbRad: 0.8, minSlopeSlideRad: 0.9, autostep: false } });
    if (!r.ok) throw new Error(r.error.message);
    const port = r.port;
    const place = (ids: string[], shape: ColliderShape3D, dx: number): void => port.addStaticColliders(ids.map((id, k) => ({ entityId: id, shape, position: { x: (k % 40) * 20 + dx, y: 0, z: Math.floor(k / 40) * 20 }, rotation: I })));
    let n = 0;
    const batches: Array<{ what: string; shape: ColliderShape3D; ids: string[] }> = [];
    // Every batch first, nothing removed in between: a removal's freed bytes would be reused by the next batch.
    for (const [what, shape] of Object.entries(shapes)) {
      const each = estimateStaticBodyBytes3D(shape);
      const ids = Array.from({ length: Math.max(100, Math.ceil((8 * 2 ** 20) / each)) }, () => `b${n++}`);
      const h0 = physicsMemoryBytes3D()!;
      place(ids, shape, 0);
      port.step();
      const grown = physicsMemoryBytes3D()! - h0;
      const ratio = (each * ids.length) / grown;
      const why = `${what}: ${each} B estimated, ${(grown / ids.length).toFixed(0)} B measured a body`;
      expect(ratio, why).toBeGreaterThan(0.8);
      expect(ratio, why).toBeLessThan(1.25);
      batches.push({ what, shape, ids });
    }
    // Churn: each batch removed and added again six times. The first round may grow the heap once (the broad phase
    // and the collider arena keep their larger capacity); after that the same bodies fit in what was freed.
    for (const b of batches) {
      const heaps: number[] = [];
      for (let round = 0; round < 6; round++) {
        port.removeStaticColliders(b.ids);
        port.step();
        place(b.ids, b.shape, round + 1);
        port.step();
        heaps.push(physicsMemoryBytes3D()!);
      }
      expect(heaps[5], b.what).toBe(heaps[1]);
    }
    port.dispose();
  });
});
