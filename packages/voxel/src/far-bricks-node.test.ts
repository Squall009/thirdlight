/**
 * A far node marched as one (its box, a walk over its brick table) against
 * every stored brick marched alone, on bricks built from a real store
 * (rough ground, a roof block, an overhang): the walk never steps over a
 * brick holding the surface, so every ray meets what the nearest brick
 * march meets, at the same distance, and rays through air meet nothing.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { DISTANCE_BRICK_CELLS } from './distance-brick-format';
import { FAR_BRICK_BLOCK_BYTES, farBrickCount, marchBrickBox, type FarBricks } from './far-bricks';
import { farBricksFromFaces } from './far-bricks-faces';
import { farBrickMarchedBox, farNodeMarchedBox, marchFarNode } from './far-bricks-node';
import { createWorldStore } from './palette-store';
import { SHAPE_FULL, VOXEL_ROLE } from './record';

const grid = chunkGrid(32);

/** Rough ground over the node's middle, a roof block and an overhang (a slab held off the ground), in finer cells. */
function scene(): FarBricks {
  const s = createWorldStore(grid);
  for (let x = -24; x < 152; x++) for (let z = -24; z < 152; z++) {
    const h = 80 + Math.round(6 * Math.sin(x / 9) * Math.cos(z / 13) + 2 * Math.sin((x + 2 * z) / 5));
    for (let y = h - 14; y < h; y++) s.setVoxel(x, y, z, { material: 7, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
  }
  for (let x = 40; x < 50; x++) for (let z = 40; z < 52; z++) for (let y = 80; y < 96; y++) s.setVoxel(x, y, z, { material: 12, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
  for (let x = 90; x < 120; x++) for (let z = 20; z < 44; z++) for (let y = 100; y < 104; y++) s.setVoxel(x, y, z, { material: 7, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
  return farBricksFromFaces(grid, s, [0, 1, 0], 2);
}

/** The nearest hit of any stored brick marched alone over its own box (what a box a brick drew). */
function nearestBrickHit(b: FarBricks, o: readonly number[], d: readonly number[]): number | null {
  const C = DISTANCE_BRICK_CELLS;
  let best: number | null = null;
  for (let k = 0; k < farBrickCount(b); k++) {
    const at = [0, 1, 2].map((a) => b.blocks[k * FAR_BRICK_BLOCK_BYTES + a]! * C);
    const box = farBrickMarchedBox(b, k);
    const hit = marchBrickBox(b.samples, k, box.lo, box.hi, [o[0]! - at[0]!, o[1]! - at[1]!, o[2]! - at[2]!], d);
    if (hit !== null && (best === null || hit.t < best)) best = hit.t;
  }
  return best;
}

describe('far node march', () => {
  it('meets every surface the brick-by-brick march meets, at the same distance, walking only the node', () => {
    const b = scene();
    const box = farNodeMarchedBox(b)!;
    expect(farBrickCount(b)).toBeGreaterThan(16);
    // The node's box holds every stored brick's box.
    for (let k = 0; k < farBrickCount(b); k++) {
      const bb = farBrickMarchedBox(b, k);
      for (let a = 0; a < 3; a++) {
        const at = b.blocks[k * FAR_BRICK_BLOCK_BYTES + a]! * DISTANCE_BRICK_CELLS;
        expect(at + bb.lo[a]!).toBeGreaterThanOrEqual(box.lo[a]!);
        expect(at + bb.hi[a]!).toBeLessThanOrEqual(box.hi[a]!);
      }
    }
    let hits = 0;
    let misses = 0;
    let rays = 0;
    let worst = 0;
    let visitedMax = 0;
    // Rays from a sphere round the node at every height and bearing (grazing ones included) toward points in it.
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 6000; i++) {
      const az = rnd() * 2 * Math.PI;
      const el = (rnd() - 0.3) * 1.4;
      const o = [16 + 70 * Math.cos(az) * Math.cos(el), 16 + 70 * Math.sin(el), 16 + 70 * Math.sin(az) * Math.cos(el)];
      const target = [rnd() * 32, rnd() * 32, rnd() * 32];
      const len = Math.hypot(target[0]! - o[0]!, target[1]! - o[1]!, target[2]! - o[2]!);
      const d = [0, 1, 2].map((a) => (target[a]! - o[a]!) / len);
      const want = nearestBrickHit(b, o, d);
      const got = marchFarNode(b, o, d);
      rays++;
      if (want === null) {
        expect(got).toBeNull();
        misses++;
        continue;
      }
      expect(got).not.toBeNull();
      worst = Math.max(worst, Math.abs(got!.t - want));
      visitedMax = Math.max(visitedMax, got!.visited);
      hits++;
    }
    // The same march from the same entry: the same distance (only the lip, half a cell past a node face, can order two
    // bricks' boxes differently along a ray, and no ray here hit there first).
    expect(worst).toBeLessThan(1e-9);
    expect(hits).toBeGreaterThan(1000);
    expect(misses).toBeGreaterThan(500);
    expect(rays).toBe(6000);
    // A walk crosses at most 3 × 4 − 2 bricks of a 4³ node.
    expect(visitedMax).toBeLessThanOrEqual(10);
  });
});
