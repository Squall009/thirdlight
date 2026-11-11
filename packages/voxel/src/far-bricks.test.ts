/**
 * Far bricks from a node's cells (the faces build from the node's own
 * cells, as the far field builds its lowest kept level): the field's
 * distances against the ground they describe, which bricks are stored, the
 * material each sample carries, the exact transform, and one brick's march
 * the draw runs (the shader is its port) on fixed rays over the brick's
 * marched box: hits on the ground, misses through air, the skirt past a
 * node face. Partial cells moving the surface: far-bricks-faces.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { BRICK_HIT_VOXELS, BRICK_MIN_STEP_VOXELS, DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_OUTSIDE, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample } from './distance-brick-format';
import { FAR_BRICK_LIP_CELLS, farBrickCount, farBrickField, farBricksInside, marchBrickBox, squaredDistances, type FarBricks } from './far-bricks';
import { farBricksFromFaces } from './far-bricks-faces';
import { farBrickMarchedBox } from './far-bricks-node';
import { FAR_SKIRT_CELLS } from './far-mesh';
import { createWorldStore, type PaletteStore } from './palette-store';
import { MATERIAL_BITS, SHAPE_FULL, VOXEL_ROLE } from './record';

const grid = chunkGrid(32);
const ROCK = 7;
const GRASS = 9;

/** Ground over x, z in [−40, 72): rock below `top`, a grass layer at `top` − 1 (wetness 3). */
function ground(top: number): PaletteStore {
  const s = createWorldStore(grid);
  for (let x = -40; x < 72; x++) for (let z = -40; z < 72; z++) {
    for (let y = 20; y < top; y++) s.setVoxel(x, y, z, { material: y === top - 1 ? GRASS : ROCK, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: y === top - 1 ? 3 : 0 });
  }
  return s;
}

/** The node's bricks as the far field builds a node with no finer cells kept: faces from its own cells. */
const bricksOf = (s: PaletteStore, node: readonly [number, number, number]): FarBricks => farBricksFromFaces(grid, s, node, 1);

/** One brick's march as the draw runs it: over the block's marched box (its bounds, the lip on node faces). */
const march = (b: FarBricks, block: number, o: readonly number[], d: readonly number[]) => {
  const box = farBrickMarchedBox(b, block);
  return marchBrickBox(b.samples, block, box.lo, box.hi, o, d);
};

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

/** Node (0, 1, 0) spans cells y 32–63; the ground's top face lies at y = 44, brick y 4 of its second brick row. */
const TOP = 44;

describe('far bricks', () => {
  it('stores the bricks the ground crosses, with distances to it within a quantization step', () => {
    const b = bricksOf(ground(TOP), [0, 1, 0]);
    expect(b.side).toBe(4);
    for (let bz = 0; bz < 4; bz++) for (let bx = 0; bx < 4; bx++) {
      expect(b.bricks[(bz * 4 + 0) * 4 + bx]).toBe(DISTANCE_BRICK_INSIDE);
      expect(b.bricks[(bz * 4 + 1) * 4 + bx]).toBeGreaterThanOrEqual(0);
      expect(b.bricks[(bz * 4 + 2) * 4 + bx]).toBe(DISTANCE_BRICK_OUTSIDE);
      expect(b.bricks[(bz * 4 + 3) * 4 + bx]).toBe(DISTANCE_BRICK_OUTSIDE);
    }
    expect(farBrickCount(b)).toBe(16);
    const step = (2 * DISTANCE_BRICK_BAND_VOXELS) / 255;
    // Brick row 1 spans y 40–48: its corner sy lies sy − 4 cells over the ground, clamped to the band.
    for (let sy = 0; sy < DISTANCE_BRICK_SIDE; sy++) {
      const want = Math.max(-DISTANCE_BRICK_BAND_VOXELS, Math.min(DISTANCE_BRICK_BAND_VOXELS, sy - 4));
      expect(Math.abs(sampleAt(b, 1, 1, 2, 3, sy, 5) - want), `sy ${sy}`).toBeLessThanOrEqual(step);
    }
    // Samples carry the ground's look: grass (wet 3) where the surface is.
    const blk = b.bricks[(0 * 4 + 1) * 4 + 0]!;
    const w = b.looks[blk * DISTANCE_BRICK_SAMPLES + (4 * DISTANCE_BRICK_SIDE + 4) * DISTANCE_BRICK_SIDE + 4]!;
    expect(w & ((1 << MATERIAL_BITS) - 1)).toBe(GRASS);
    expect(w >> MATERIAL_BITS).toBe(3);
    // Deterministic.
    const again = bricksOf(ground(TOP), [0, 1, 0]);
    expect([...again.samples]).toEqual([...b.samples]);
    expect([...again.looks]).toEqual([...b.looks]);
  });

  it('tells a point inside the drawn solid from one over it: a wholly inside brick, a stored one below its surface', () => {
    const b = bricksOf(ground(TOP), [0, 1, 0]);
    // The ground's top lies at node cell 12 (y 44 of the node at 32).
    for (const [x, z] of [[3, 5], [20.5, 30.25], [31.9, 0]] as const) {
      expect(farBricksInside(b, [x, 2, z]), 'brick row 0, wholly inside').toBe(true);
      expect(farBricksInside(b, [x, 11.5, z]), 'half a cell under the top').toBe(true);
      expect(farBricksInside(b, [x, 12.5, z]), 'half a cell over it').toBe(false);
      expect(farBricksInside(b, [x, 28, z]), 'an outside brick').toBe(false);
    }
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
    const b = bricksOf(ground(TOP), [0, 1, 0]);
    const { block } = blockOf(b, 1, 1, 1);
    // Brick (1, 1, 1) spans y 40–48, the ground's face at its y 4: straight down from brick y 7.5.
    const down = march(b, block, [4, 7.5, 4], [0, -1, 0]);
    expect(down).not.toBeNull();
    expect(Math.abs(3.5 - down!.t)).toBeLessThanOrEqual(BRICK_HIT_VOXELS + 0.02);
    // A slanted ray from above hits where its height reaches the ground.
    const dir = [0.6, -0.64, 0.48];
    const len = Math.hypot(...dir);
    const slant = march(b, block, [1, 7, 1], dir.map((c) => c / len));
    expect(slant).not.toBeNull();
    expect(7 + (dir[1]! / len) * slant!.t).toBeCloseTo(4, 1);
    // Level through the air above the ground: no hit.
    expect(march(b, block, [-1, 4.8, 4], [1, 0, 0])).toBeNull();
    // The brick at the node's −x face hangs a skirt past it. Just past the face the field is negative a cell under the
    // surface; at the lip's end it reaches FAR_SKIRT_CELLS deep.
    const edge = blockOf(b, 0, 1, 1);
    expect(edge.faces & 1).toBe(1);
    expect(farBrickMarchedBox(b, edge.block).lo[0]).toBe(-FAR_BRICK_LIP_CELLS);
    expect(farBrickField(b.samples, edge.block, [-FAR_BRICK_LIP_CELLS / 4, 3, 4])).toBeLessThan(0);
    expect(farBrickField(b.samples, edge.block, [-FAR_BRICK_LIP_CELLS, 4 - FAR_SKIRT_CELLS + 0.1, 4])).toBeLessThan(0.15);
    expect(farBrickField(b.samples, edge.block, [-FAR_BRICK_LIP_CELLS, 4.5, 4])).toBeGreaterThan(0);
    // Into the lip from the −x side under the surface: it hits the skirt within a shortest step of the face.
    const into = march(b, edge.block, [-1, 3.6, 4], [1, 0, 0]);
    expect(into).not.toBeNull();
    expect(-1 + into!.t).toBeLessThan(BRICK_MIN_STEP_VOXELS);
    // An inner brick has no lip: its box starts at its −x side.
    const inner = blockOf(b, 1, 1, 1);
    expect(inner.faces & 1).toBe(0);
    expect(farBrickMarchedBox(b, inner.block).lo[0]).toBe(0);
  });
});
