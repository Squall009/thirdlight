/**
 * The far bricks' baked shading against the fine shading the draw made per
 * pixel: bricks built from a real store (rough ground of several
 * materials and wetness, a roof block), every surface point found by
 * marching down through them; the baked samples read as the draw's one
 * filtered read give the fine shading's colour within a few percent, and
 * the far job bakes the same occlusion the bake function makes.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { BRICK_HIT_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES } from './distance-brick-format';
import { FAR_BRICK_BUILD, farBrickCount, farBrickField, type FarBricks } from './far-bricks';
import { brickFarNodeBy, farBricksFromFaces } from './far-bricks-faces';
import { bakeFarBrick, FAR_BRICK_AO_FLOOR, FAR_BRICK_BAKED_BYTES, FAR_PALETTE_WORDS, farBakedAt, farBrickFineShade, farBrickOcclusion, farBrickOcclusionAt } from './far-bricks-shade';
import { farNeighbourIndex } from './far-mesh';
import { createWorldStore } from './palette-store';
import { MATERIAL_BITS, recordValue, SHAPE_FULL, VOXEL_ROLE } from './record';
import type { StoredChunk } from './stream-job';

const grid = chunkGrid(32);
const ROCK = 7;
const GRASS = 9;
const GRAVEL = 11;
const ROOF = 12;

/** A palette of distinct linear colours by word (as the GPU's read-back holds them: bytes). */
function testPalette(): Uint8Array {
  const p = new Uint8Array(FAR_PALETTE_WORDS * 4);
  for (let w = 0; w < FAR_PALETTE_WORDS; w++) {
    const m = w & ((1 << MATERIAL_BITS) - 1);
    const wet = w >> MATERIAL_BITS;
    const dark = 1 - wet * 0.08;
    p.set([Math.round(((m * 67) % 200 + 40) * dark), Math.round(((m * 131) % 180 + 50) * dark), Math.round(((m * 29) % 160 + 30) * dark), 255], w * 4);
  }
  return p;
}

/** Rough ground (a two-octave height, grass over rock, gravel in the hollows, wet low ground) and a roof block, in finer cells. */
function roughStore(): ReturnType<typeof createWorldStore> {
  const s = createWorldStore(grid);
  for (let x = -24; x < 152; x++) for (let z = -24; z < 152; z++) {
    const h = 80 + Math.round(5 * Math.sin(x / 9) * Math.cos(z / 11) + 2 * Math.sin((x + 2 * z) / 4));
    for (let y = h - 14; y < h; y++) {
      const top = y === h - 1;
      const material = top ? (h < 77 ? GRAVEL : GRASS) : ROCK;
      s.setVoxel(x, y, z, { material, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: h < 78 ? 3 : 0 });
    }
  }
  for (let x = 40; x < 48; x++) for (let z = 40; z < 50; z++) for (let y = 80; y < 92; y++) s.setVoxel(x, y, z, { material: ROOF, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
  return s;
}

/** Surface points of every stored block: straight down columns on a 0.37-cell lattice, the first point the field is within a hit. */
function surfacePoints(b: FarBricks): Array<{ block: number; p: [number, number, number] }> {
  const out: Array<{ block: number; p: [number, number, number] }> = [];
  for (let k = 0; k < farBrickCount(b); k++) for (let x = 0.1; x < DISTANCE_BRICK_CELLS; x += 0.37) for (let z = 0.1; z < DISTANCE_BRICK_CELLS; z += 0.37) {
    for (let y = DISTANCE_BRICK_CELLS; y >= 0; y -= 0.02) {
      if (farBrickField(b.samples, k, [x, y, z]) < BRICK_HIT_VOXELS) {
        out.push({ block: k, p: [x, y, z] });
        break;
      }
    }
  }
  return out;
}

describe('far bricks baked shading', () => {
  it('gives the fine shading per pixel within a few percent from one filtered read of baked samples', () => {
    const b0 = farBricksFromFaces(grid, roughStore(), [0, 1, 0], 2);
    const b: FarBricks = { ...b0, occlusion: farBrickOcclusion(b0) };
    const palette = testPalette();
    const colourOf = (w: number): [number, number, number] => [palette[w * 4]! / 255, palette[w * 4 + 1]! / 255, palette[w * 4 + 2]! / 255];
    const points = surfacePoints(b);
    expect(points.length).toBeGreaterThan(2000);
    const baked = new Uint8Array(DISTANCE_BRICK_SAMPLES * FAR_BRICK_BAKED_BYTES);
    let bakedBlock = -1;
    const err: number[] = [];
    let blendErr = 0;
    let aoSpread = 0;
    for (const { block, p } of points) {
      if (block !== bakedBlock) {
        bakeFarBrick(b, block, palette, baked);
        bakedBlock = block;
      }
      const want = farBrickFineShade(b, block, p, colourOf);
      const got = farBakedAt(baked, p);
      const ao = FAR_BRICK_AO_FLOOR + (1 - FAR_BRICK_AO_FLOOR) * got.occlusion;
      aoSpread = Math.max(aoSpread, 1 - ao);
      err.push(Math.max(...[0, 1, 2].map((c) => Math.abs(got.colour[c]! * ao - want[c]!))));
      // The colour blend alone (the occlusion at the point divided out): the same blend of the same bytes.
      const atPoint = FAR_BRICK_AO_FLOOR + (1 - FAR_BRICK_AO_FLOOR) * farBrickOcclusionAt(b.samples, block, p);
      blendErr = Math.max(blendErr, ...[0, 1, 2].map((c) => Math.abs(got.colour[c]! - want[c]! / atPoint)));
    }
    err.sort((x, y) => x - y);
    const mean = err.reduce((s, e) => s + e, 0) / err.length;
    // The colour blend is the same trilinear blend of the palette's bytes (float rounding only); what differs is the
    // occlusion, taken at the samples and blended instead of at the point: about a percent of the colour on average
    // (measured 1.2 %, median 0.8 %, p90 3.3 %), a few percent at nearly all points (p99 5.7 %).
    expect(blendErr).toBeLessThan(1e-6);
    expect(mean).toBeLessThan(0.015);
    expect(err[Math.floor(err.length * 0.9)]!).toBeLessThan(0.04);
    expect(err[Math.floor(err.length * 0.99)]!).toBeLessThan(0.07);
    // The scene has occlusion to bake (hollows and the block's foot), so the comparison is not of open ground only.
    expect(aoSpread).toBeGreaterThan(0.1);
  });

  it('bakes the occlusion in the far job when the build asks for it', () => {
    const rock = recordValue(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
    // The node's children (a 4³ block round it, y fastest): rock below the node's top, air above.
    const cells: Array<StoredChunk | null> = [];
    for (let dx = -1; dx <= 2; dx++) for (let dz = -1; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) cells.push(dy < 2 ? { uniform: rock } : null);
    const own: Array<StoredChunk | null> = new Array<StoredChunk | null>(27).fill(null);
    own[farNeighbourIndex(0, 0, 0)] = { uniform: rock };
    const decompress = (): Uint8Array => {
      throw new Error('no stored entries here');
    };
    const input = { level: 3, node: [0, -1, 0] as [number, number, number], cells: own, fine: { level: 2, scale: 2, cells } };
    const plain = brickFarNodeBy(createWorldStore(grid), { ...input, build: { ...FAR_BRICK_BUILD, occlusion: false } }, decompress);
    const job = brickFarNodeBy(createWorldStore(grid), { ...input, build: FAR_BRICK_BUILD }, decompress);
    expect(plain.occlusion).toBeUndefined();
    expect(farBrickCount(job)).toBeGreaterThan(0);
    expect([...job.samples]).toEqual([...plain.samples]);
    expect([...job.occlusion!]).toEqual([...farBrickOcclusion(plain)]);
    // Open flat ground: the surface's samples (the top sample row of the top bricks) are fully open.
    const top = job.occlusion!.filter((_, i) => Math.floor((i % DISTANCE_BRICK_SAMPLES) / 9) % 9 === 8);
    expect(Math.min(...top)).toBeGreaterThan(250);
  });
});
