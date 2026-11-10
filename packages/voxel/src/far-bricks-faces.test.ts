/**
 * Far bricks from the faces of finer cells: a one-cell body keeps more of
 * its height than from the node's own cells (which keep about a third, as
 * the first build's corner-averaged field did), a
 * surface between the node's cells sits where the finer cells put it, a
 * partial top cell moves it, the bounds hold the cells the surface
 * crosses, a sample's look is its neighbourhood's, and a job carrying its
 * finer cells (as the far field sends them) makes the same bricks.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample } from './distance-brick-format';
import { FAR_BRICK_BOUNDS_BYTES, FAR_BRICK_BUILD, type FarBricks } from './far-bricks';
import { brickFarNodeBy, farBricksFromFaces } from './far-bricks-faces';
import { farNeighbourIndex } from './far-mesh';
import { createWorldStore, type PaletteStore } from './palette-store';
import { MATERIAL_BITS, recordValue, SHAPE_FULL, VOXEL_ROLE } from './record';
import type { StoredChunk } from './stream-job';

const grid = chunkGrid(32);
const ROCK = 7;
const GRASS = 9;
const ROOF = 12;

/** The field at a point of the node (node cells), as the draw reads it: a stored brick's trilinear sample, else the band. */
function fieldAt(b: FarBricks, p: readonly number[]): number {
  const C = DISTANCE_BRICK_CELLS;
  const bi = p.map((c) => Math.min(b.side - 1, Math.max(0, Math.floor(c / C))));
  const blk = b.bricks[(bi[2]! * b.side + bi[1]!) * b.side + bi[0]!]!;
  if (blk < 0) return blk === -1 ? DISTANCE_BRICK_BAND_VOXELS : -DISTANCE_BRICK_BAND_VOXELS;
  const q = p.map((c, a) => Math.min(C, Math.max(0, c - bi[a]! * C)));
  const i = q.map((c) => Math.min(C - 1, Math.floor(c)));
  const f = q.map((c, a) => c - i[a]!);
  const S = DISTANCE_BRICK_SIDE;
  let sum = 0;
  for (let k = 0; k < 8; k++) {
    const dx = k & 1, dy = (k >> 1) & 1, dz = (k >> 2) & 1;
    sum += (dx ? f[0]! : 1 - f[0]!) * (dy ? f[1]! : 1 - f[1]!) * (dz ? f[2]! : 1 - f[2]!) * b.samples[blk * DISTANCE_BRICK_SAMPLES + ((i[2]! + dz) * S + i[1]! + dy) * S + i[0]! + dx]!;
  }
  return distanceOfSample(sum, DISTANCE_BRICK_BAND_VOXELS);
}

/** Where a ray straight down at (x, z) first meets the surface (node cells; NaN: nowhere). */
function surfaceBelow(b: FarBricks, x: number, z: number): number {
  for (let y = 32; y >= 0; y -= 0.01) if (fieldAt(b, [x, y, z]) < 0.05) return y;
  return NaN;
}

/** Ground over x, z in [lo, hi) up to `top` (exclusive, rock under a grass layer), with an optional partial layer on top. */
function ground(s: PaletteStore, lo: number, hi: number, top: number, partial?: number): PaletteStore {
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    for (let y = top - 12; y < top; y++) s.setVoxel(x, y, z, { material: y === top - 1 ? GRASS : ROCK, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
    if (partial !== undefined) s.setVoxel(x, top, z, { material: GRASS, role: VOXEL_ROLE.terrain, shape: partial, wetness: 0 });
  }
  return s;
}

describe('far bricks from faces', () => {
  it('keeps more of a one-cell body from the finer cells than from the node\'s own, which average it away', () => {
    // Node (0, 1, 0): cells y 32–63, ground top at y 40 (node y 8); a one-cell block on it at node (12, 8, 12). The faces
    // build reads the same scene from cells twice finer (a node cell is 2³ of them), as it reads a node's children.
    const s = ground(createWorldStore(grid), -40, 72, 40);
    s.setVoxel(12, 40, 12, { material: ROOF, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
    const f = ground(createWorldStore(grid), -40, 140, 80);
    for (let x = 24; x < 26; x++) for (let y = 80; y < 82; y++) for (let z = 24; z < 26; z++) f.setVoxel(x, y, z, { material: ROOF, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
    const own = farBricksFromFaces(grid, s, [0, 1, 0], 1);
    const faces = farBricksFromFaces(grid, f, [0, 1, 0], 2);
    const ownTop = surfaceBelow(own, 12.5, 12.5);
    const facesTop = surfaceBelow(faces, 12.5, 12.5);
    // The block's top is node y 9: from the node's own cells the faces field keeps about a third of it, as the first
    // build (corners the mean of 8 cell-centre distances, 8.30) did; from the finer cells, as the far field builds,
    // more (its convex corners still round off between the node's samples).
    expect(ownTop).toBeLessThan(8.35);
    expect(facesTop).toBeGreaterThan(8.4);
    // The flat ground away from it is where it is in both.
    expect(surfaceBelow(own, 4.5, 4.5)).toBeCloseTo(8, 1);
    expect(surfaceBelow(faces, 4.5, 4.5)).toBeCloseTo(8, 1);
    // The roof block's samples show the roof (most of the shown cells round its top corners), the ground's grass.
    const T = DISTANCE_BRICK_SIDE;
    // The look of sample (sx, sy, sz) of brick (bx, by, bz).
    const look = (b: FarBricks, [bx, by, bz]: readonly number[], [sx, sy, sz]: readonly number[]): number => {
      const blk = b.bricks[(bz! * 4 + by!) * 4 + bx!]!;
      expect(blk).toBeGreaterThanOrEqual(0);
      return b.looks[blk * DISTANCE_BRICK_SAMPLES + (sz! * T + sy!) * T + sx!]! & ((1 << MATERIAL_BITS) - 1);
    };
    // The ground's surface (node y 8) is the top face of brick row 0, which draws it (the solid side).
    expect(look(faces, [0, 0, 0], [4, 8, 4])).toBe(GRASS);
    expect(look(faces, [1, 1, 1], [4, 1, 4])).toBe(ROOF);
  });

  it('puts a surface between the node’s cells where twice finer cells have it, and a partial top cell moves it', () => {
    // Fine cells (a level below): ground top at fine y 81, so the node's (coarse) surface lies at 40.5 − 32 = 8.5.
    const fine = ground(createWorldStore(grid), -40, 140, 81);
    const b = farBricksFromFaces(grid, fine, [0, 1, 0], 2);
    for (const [x, z] of [[3.3, 4.1], [20.7, 9.2], [30.1, 30.9]] as const) expect(surfaceBelow(b, x, z)).toBeCloseTo(8.5, 1);
    // A fine layer 3/4 full on top lifts it by 3/8 of a node cell (the corner rule puts it within a tenth of that).
    const partial = ground(createWorldStore(grid), -40, 140, 81, Math.round(SHAPE_FULL * 0.75));
    expect(Math.abs(surfaceBelow(farBricksFromFaces(grid, partial, [0, 1, 0], 2), 10.5, 10.5) - (8.5 + 0.375))).toBeLessThan(0.12);
    // The ground's bricks are the second brick row; their bounds hold only the cells the surface crosses (y 0–1).
    const blk = b.bricks[(0 * 4 + 1) * 4 + 1]!;
    expect(blk).toBeGreaterThanOrEqual(0);
    const o = blk * FAR_BRICK_BOUNDS_BYTES;
    expect([...b.bounds.subarray(o, o + 6)]).toEqual([0, 0, 0, 8, 1, 8]);
  });

  it('makes the same bricks from a job carrying its finer cells as the far field sends them', () => {
    // The node (0, 0, 0) at level L; its children's level below: solid rock under y 0 and air above, as uniform entries.
    const rock = recordValue(ROCK, VOXEL_ROLE.terrain, SHAPE_FULL, 0);
    const cells: Array<StoredChunk | null> = [];
    for (let dx = -1; dx <= 2; dx++) for (let dz = -1; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) cells.push(dy < 0 ? { uniform: rock } : null);
    // The node's own level, only for the job's shape (a faces build of scale 2 reads the finer cells).
    const own: Array<StoredChunk | null> = new Array<StoredChunk | null>(27).fill(null);
    own[farNeighbourIndex(0, 0, 0)] = { uniform: rock };
    const decompress = (): Uint8Array => {
      throw new Error('no stored entries here');
    };
    // Children at y < 0 are rock, so the node at y 0 holds nothing of its own; one level lower (ny −1) holds the surface.
    const low = cells.map((_, k) => {
      const dy = (k % 4) - 1;
      return dy < 2 ? { uniform: rock } : null;
    });
    const job = brickFarNodeBy(createWorldStore(grid), { level: 3, node: [0, -1, 0], cells: own, build: FAR_BRICK_BUILD, fine: { level: 2, scale: 2, cells: low } }, decompress);
    const direct = createWorldStore(grid);
    for (let x = -32; x < 96; x++) for (let z = -32; z < 96; z++) for (let y = -100; y < 0; y++) direct.setVoxel(x, y, z, { material: ROCK, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
    const want = farBricksFromFaces(grid, direct, [0, -1, 0], 2);
    expect(job.bricks).toEqual(want.bricks);
    expect([...job.samples]).toEqual([...want.samples]);
    expect([...job.looks]).toEqual([...want.looks]);
    // The ground's surface is the node's top face: drawn by its own top brick row (the solid side), the node above
    // being air and not kept.
    expect(job.bricks.filter((k) => k >= 0).length).toBe(16);
    expect(surfaceBelow(job, 7.5, 7.5)).toBeCloseTo(32, 1);
    // A job with no finer cells of its own: nothing drawn.
    const empty = brickFarNodeBy(createWorldStore(grid), { level: 3, node: [0, 0, 0], cells: own, build: FAR_BRICK_BUILD, fine: { level: 2, scale: 2, cells } }, decompress);
    expect(empty.samples.length).toBe(0);
  });
});
