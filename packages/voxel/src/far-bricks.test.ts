/**
 * Far bricks from a node's cells: the field's distances against the ground
 * they describe, which bricks are stored, the fill level moving the
 * surface, the material each sample carries, the exact transform, and the
 * march the draw runs (the shader is its port) on fixed rays: hits on the
 * ground, misses through air, the skirt past a node face.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { BRICK_HIT_VOXELS, BRICK_MIN_STEP_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_OUTSIDE, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample } from './distance-brick-format';
import { FAR_BRICK_LIP_CELLS, farBrickCount, farBrickField, farBricksOf, marchFarBrick, squaredDistances, type FarBricks } from './far-bricks';
import { FAR_SKIRT_CELLS } from './far-mesh';
import { createWorldStore, type PaletteStore } from './palette-store';
import { MATERIAL_BITS, SHAPE_FULL, VOXEL_ROLE } from './record';

const grid = chunkGrid(32);
const ROCK = 7;
const GRASS = 9;

/** Ground over x, z in [−40, 72): rock below `top`, a grass layer at `top` − 1 (wetness 3), and an optional partial cell layer on top. */
function ground(top: number, partial?: number): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = -40; x < 72; x++) for (let z = -40; z < 72; z++) {
    for (let y = 20; y < top; y++) s.setVoxel(x, y, z, { material: y === top - 1 ? GRASS : ROCK, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: y === top - 1 ? 3 : 0 });
    if (partial !== undefined) s.setVoxel(x, top, z, { material: GRASS, role: VOXEL_ROLE.terrain, shape: partial, wetness: 0 });
  }
  return s;
}

/** The decoded distance of sample (sx, sy, sz) of the brick at (bx, by, bz). */
function sampleAt(b: FarBricks, bx: number, by: number, bz: number, sx: number, sy: number, sz: number): number {
  const blk = b.bricks[(bz * b.side + by) * b.side + bx]!;
  return distanceOfSample(b.samples[blk * DISTANCE_BRICK_SAMPLES + (sz * DISTANCE_BRICK_SIDE + sy) * DISTANCE_BRICK_SIDE + sx]!, DISTANCE_BRICK_BAND_VOXELS);
}

/** The stored block of a brick and its face bits. */
function blockOf(b: FarBricks, bx: number, by: number, bz: number): { block: number; faces: number } {
  const block = b.bricks[(bz * b.side + by) * b.side + bx]!;
  return { block, faces: b.blocks[block * 4 + 3]! };
}

describe('far bricks', () => {
  it('stores the bricks the ground crosses, with distances to it within a quantization step', () => {
    // Node (0, 1, 0) spans cells y 32–63; the ground's top face lies at y = 40, inside its second brick row.
    const b = farBricksOf(grid, ground(40), [0, 1, 0]);
    expect(b.side).toBe(4);
    for (let bz = 0; bz < 4; bz++) for (let bx = 0; bx < 4; bx++) {
      expect(b.bricks[(bz * 4 + 0) * 4 + bx]).toBe(DISTANCE_BRICK_INSIDE);
      expect(b.bricks[(bz * 4 + 1) * 4 + bx]).toBeGreaterThanOrEqual(0);
      expect(b.bricks[(bz * 4 + 2) * 4 + bx]).toBe(DISTANCE_BRICK_OUTSIDE);
      expect(b.bricks[(bz * 4 + 3) * 4 + bx]).toBe(DISTANCE_BRICK_OUTSIDE);
    }
    expect(farBrickCount(b)).toBe(16);
    const step = (2 * DISTANCE_BRICK_BAND_VOXELS) / 255;
    // Brick row 1 spans y 40–48: its corner sy lies sy cells over the ground, clamped to the band.
    for (let sy = 0; sy < DISTANCE_BRICK_SIDE; sy++) {
      expect(Math.abs(sampleAt(b, 1, 1, 2, 3, sy, 5) - Math.min(DISTANCE_BRICK_BAND_VOXELS, sy)), `sy ${sy}`).toBeLessThanOrEqual(step);
    }
    // Samples carry the ground's look: grass (wet 3) where the surface is.
    const blk = b.bricks[(0 * 4 + 1) * 4 + 0]!;
    const w = b.looks[blk * DISTANCE_BRICK_SAMPLES + (4 * DISTANCE_BRICK_SIDE + 0) * DISTANCE_BRICK_SIDE + 4]!;
    expect(w & ((1 << MATERIAL_BITS) - 1)).toBe(GRASS);
    expect(w >> MATERIAL_BITS).toBe(3);
  });

  it('moves the surface by a partial top cell’s fill level, and is deterministic', () => {
    const full = farBricksOf(grid, ground(40), [0, 1, 0]);
    const partial = farBricksOf(grid, ground(40, Math.round(SHAPE_FULL * 0.8)), [0, 1, 0]);
    // At corner y = 41 the plain ground is 1 cell above the surface; with a cell 80 % full on top, ~0.1.
    expect(sampleAt(full, 1, 1, 1, 4, 1, 4)).toBeCloseTo(1, 1);
    expect(sampleAt(partial, 1, 1, 1, 4, 1, 4)).toBeCloseTo(0.1, 1);
    const again = farBricksOf(grid, ground(40, Math.round(SHAPE_FULL * 0.8)), [0, 1, 0]);
    expect([...again.samples]).toEqual([...partial.samples]);
    expect([...again.looks]).toEqual([...partial.looks]);
  });

  it('gives the exact squared distance to the nearest cell of a kind', () => {
    const n = 9;
    const mask = new Uint8Array(n ** 3);
    let seed = 7;
    for (let i = 0; i < mask.length; i++) mask[i] = (seed = (seed * 1103515245 + 12345) % 2 ** 31) % 11 === 0 ? 1 : 0;
    const d = squaredDistances(mask, n, 1);
    for (let i = 0; i < mask.length; i += 13) {
      const [x, y, z] = [i % n, Math.floor(i / n) % n, Math.floor(i / n / n)];
      let best = Infinity;
      for (let j = 0; j < mask.length; j++) if (mask[j] === 1) best = Math.min(best, (j % n - x) ** 2 + (Math.floor(j / n) % n - y) ** 2 + (Math.floor(j / n / n) - z) ** 2);
      expect(d[i]).toBe(best);
    }
  });

  it('marches fixed rays to the ground, through air to nothing, and onto the skirt past a node face', () => {
    const b = farBricksOf(grid, ground(40), [0, 1, 0]);
    const { block, faces } = blockOf(b, 1, 1, 1);
    // Brick (1, 1, 1) spans y 40–48, so the ground's face is its bottom (brick y 0): straight down from brick y 7.5.
    const down = marchFarBrick(b.samples, block, faces, [4, 7.5, 4], [0, -1, 0]);
    expect(down).not.toBeNull();
    expect(Math.abs(7.5 - down!.t)).toBeLessThanOrEqual(BRICK_HIT_VOXELS + 0.02);
    // A slanted ray from above hits where its height reaches the ground.
    const dir = [0.6, -0.64, 0.48];
    const len = Math.hypot(...dir);
    const slant = marchFarBrick(b.samples, block, faces, [1, 6, 1], dir.map((c) => c / len));
    expect(slant).not.toBeNull();
    expect(6 + (dir[1]! / len) * slant!.t).toBeCloseTo(0, 1);
    // Level through the air above the ground: no hit.
    expect(marchFarBrick(b.samples, block, faces, [-1, 5, 4], [1, 0, 0])).toBeNull();
    // The ground at y = 44 (brick y 4): the brick at the node's −x face hangs a skirt past it. Just past the face the field
    // is negative a cell under the surface; at the lip's end it reaches FAR_SKIRT_CELLS deep.
    const mid = farBricksOf(grid, ground(44), [0, 1, 0]);
    const edge = blockOf(mid, 0, 1, 1);
    expect(edge.faces & 1).toBe(1);
    expect(farBrickField(mid.samples, edge.block, [-FAR_BRICK_LIP_CELLS / 4, 3, 4])).toBeLessThan(0);
    expect(farBrickField(mid.samples, edge.block, [-FAR_BRICK_LIP_CELLS, 4 - FAR_SKIRT_CELLS + 0.1, 4])).toBeLessThan(0.15);
    expect(farBrickField(mid.samples, edge.block, [-FAR_BRICK_LIP_CELLS, 4.5, 4])).toBeGreaterThan(0);
    // Into the lip from the −x side under the surface: it hits the skirt within a shortest step of the face; above the
    // surface it passes.
    const into = marchFarBrick(mid.samples, edge.block, edge.faces, [-1, 3.6, 4], [1, 0, 0]);
    expect(into).not.toBeNull();
    expect(-1 + into!.t).toBeLessThan(BRICK_MIN_STEP_VOXELS);
    expect(marchFarBrick(mid.samples, edge.block, edge.faces, [-1, 6, 4], [1, 0, 0])).toBeNull();
    // An inner brick has no lip: past its −x side nothing is marched.
    const inner = blockOf(mid, 1, 1, 1);
    expect(inner.faces & 1).toBe(0);
  });
});
