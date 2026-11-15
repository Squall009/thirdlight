/**
 * The hand-over between the two lighting stores at its boundaries: the
 * shares each store's read takes (always summing to 1, the volume's rising
 * with the distance, none before the fade and all after it), the rule the
 * volume keeps bricks by (no brick wholly inside the ring kept, every brick
 * a pixel past the fade's start reads kept), and the surface cache's host
 * listing only the chunks within its reach of the eye (their tiles made, the
 * rest left out, the farthest listed within the reach; moving the eye moves
 * what is listed).
 */
import { describe, expect, it } from 'vitest';
import { VOXEL_SIZE_M } from '@thirdlight/voxel';

import { SurfaceCacheHost, type SurfaceVoxelChunk } from './surface-cache-host';
import type { VoxelTileMesh } from './surface-cache-voxels';
import { boxDistanceAcross, handoverCacheReach, handoverCacheShare, handoverKeepsBox, handoverRing, handoverVolumeKeepFrom, handoverVolumeShare, VOXEL_HANDOVER_FADE_SHARE, voxelHandoverFromUrl } from './voxel-light-handover';

describe('the lighting stores hand over by distance', () => {
  it('the two shares sum to 1 at every distance, the volume\'s rising from none before the fade to all past it', () => {
    for (const d of [4, 12, 24, 50]) {
      const ring = handoverRing(d);
      expect(ring.to).toBe(d);
      expect(ring.to - ring.from).toBeCloseTo(d * VOXEL_HANDOVER_FADE_SHARE, 9);
      let last = -1;
      for (let i = 0; i <= 194; i++) {
        const x = (i * d) / 97;
        const v = handoverVolumeShare(ring, x);
        const c = handoverCacheShare(ring, x);
        expect(v + c).toBeCloseTo(1, 12);
        expect(v).toBeGreaterThanOrEqual(last);
        last = v;
        if (x <= ring.from) expect(v).toBe(0);
        if (x >= ring.to) expect(v).toBe(1);
        if (x > ring.from + 1e-6 && x < ring.to - 1e-6) {
          expect(v).toBeGreaterThan(0);
          expect(v).toBeLessThan(1);
        }
      }
      // Half way through the fade each takes half.
      expect(handoverVolumeShare(ring, (ring.from + ring.to) / 2)).toBeCloseTo(0.5, 12);
    }
  });

  it('the volume keeps no brick wholly inside its ring and every brick a pixel with a share of its light lies in', () => {
    const ring = handoverRing(12);
    const step = 2;
    const keepFrom = handoverVolumeKeepFrom(ring, step);
    expect(keepFrom).toBe(ring.from - step);
    const eye = [3.3, -7.1];
    for (const m of [2, 4, 8, 16]) for (let bx = -20; bx <= 20; bx++) for (let bz = -20; bz <= 20; bz++) {
      const [x0, x1, z0, z1] = [bx * m, (bx + 1) * m, bz * m, (bz + 1) * m];
      const kept = handoverKeepsBox(keepFrom, eye[0]!, eye[1]!, x0, x1, z0, z1);
      // Its corners across: wholly inside keepFrom when its farthest corner is.
      const far = Math.max(...[x0, x1].flatMap((x) => [z0, z1].map((z) => Math.hypot(x - eye[0]!, z - eye[1]!))));
      expect(kept).toBe(far > keepFrom);
      // A brick holding a point the volume lights (past the fade's start, from an eye up to a step away) is kept.
      for (const [ox, oz] of [[0, 0], [step, 0], [0, -step], [step * 0.7, step * 0.7]]) {
        const ex = eye[0]! + ox!;
        const ez = eye[1]! + oz!;
        const farFromMoved = Math.max(...[x0, x1].flatMap((x) => [z0, z1].map((z) => Math.hypot(x - ex, z - ez))));
        if (farFromMoved > ring.from + 1e-9) expect(kept, `brick ${bx},${bz} of ${m} m read from an eye moved ${ox},${oz}`).toBe(true);
      }
    }
    // No ring: everything kept.
    expect(handoverKeepsBox(null, 0, 0, 0, 1, 0, 1)).toBe(true);
  });

  it('the page flag sets the distance, and the cache lists one fade past it', () => {
    expect(voxelHandoverFromUrl('?voxelLight=hybrid&voxelLightHandover=24')).toBe(24);
    expect(voxelHandoverFromUrl('?voxelLightHandover=-3')).toBeNull();
    expect(voxelHandoverFromUrl('?voxelLightHandover=x')).toBeNull();
    expect(voxelHandoverFromUrl('')).toBeNull();
    const r = handoverRing(12);
    expect(handoverCacheReach(r)).toBe(15);
    expect(boxDistanceAcross(0, 0, 3, 5, -1, 1)).toBe(3);
    expect(boxDistanceAcross(0, 0, 3, 5, 4, 6)).toBe(5);
    expect(boxDistanceAcross(4, 0, 3, 5, -1, 1)).toBe(0);
  });

  it('the cache\'s host lists only the chunks within its reach of the eye, and follows the eye', () => {
    // A row of chunks 16 m apart across x, flat ground 1 m up in each.
    const EDGE = 32;
    const flat = (): VoxelTileMesh => ({ positions: Float32Array.from([0, 1, 0, 16, 1, 0, 0, 1, 16, 16, 1, 16]), indices: Uint32Array.from([0, 2, 1, 1, 2, 3]) });
    const chunks: SurfaceVoxelChunk[] = Array.from({ length: 8 }, (_, i) => ({ key: `w/${i * EDGE},0,0`, version: 1, cell0: [i * EDGE, 0, 0] as const, edge: EDGE, mesh: flat }));
    let reach: number | null = 15;
    const host = new SurfaceCacheHost({ layers: () => [], terrains: () => [], architecture: () => [], models: () => [], bricks: () => null }, 32 * 1024 * 1024);
    host.voxels.set({ chunks: () => chunks, walk: () => null, relightMs: 6.67, reach: () => reach });
    host.setLive(true);
    let now = performance.now();
    const run = (eye: number[]): void => {
      host.touch();
      for (let f = 0; f < 30; f++) host.update(eye, (now += 300));
    };
    // The eye over the third chunk's middle (x 40 m): chunks whose box lies within 15 m across: x 16–32, 32–48, 48–64.
    run([40, 3, 8]);
    let d = host.voxels.diagnostics();
    expect(d.reachM).toBe(15);
    expect(d.tiles, JSON.stringify(d)).toBe(3);
    expect(d.resident).toBe(3);
    expect(d.beyond).toBe(5);
    expect(d.farthestM).toBeLessThanOrEqual(15);
    const keys = (): string[] => host.savedTiles().map((t) => t.key).sort();
    expect(keys()).toEqual(['w/32,0,0', 'w/64,0,0', 'w/96,0,0']);
    // Moved 48 m along x: the listing follows.
    run([88, 3, 8]);
    d = host.voxels.diagnostics();
    expect(keys()).toEqual(['w/128,0,0', 'w/160,0,0', 'w/192,0,0']);
    expect(d.farthestM).toBeLessThanOrEqual(15);
    // No reach (the cache alone): every chunk drawn.
    reach = null;
    run([88, 3, 8]);
    d = host.voxels.diagnostics();
    expect(d.tiles).toBe(8);
    expect(d.reachM).toBeNull();
    expect(d.farthestM).toBeNull();
    // The chunks' place in metres is their corner cell's (the cells are VOXEL_SIZE_M).
    expect(chunks[2]!.cell0[0] * VOXEL_SIZE_M).toBe(32);
  });
});
