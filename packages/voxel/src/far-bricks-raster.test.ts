/**
 * Far bricks as faces to rasterize, from bricks built from real stores (the
 * `faces2` build, cells twice finer than the node's): flat ground gives
 * exactly its top faces covering the node once, a block in the air its six
 * sides, and over rough ground no face ever lies between two solid samples
 * or is missing between a solid and an air one, inside a brick, across
 * brick borders and across the border of two neighbouring nodes, whose
 * shared samples each draw half.
 */
import { describe, expect, it } from 'vitest';
import { chunkGrid } from './coords';
import { DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_INSIDE, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample } from './distance-brick-format';
import type { FarBricks } from './far-bricks';
import { farBricksFromFaces } from './far-bricks-faces';
import { FAR_FACE_CLIP_SHIFT, FAR_FACE_DIRECTION_MASK, FAR_FACE_SHADE_SHIFT, FAR_FACE_SKIRT, farRasterFaces, farRasterRuns, type FarRasterFaces } from './far-bricks-raster';
import { FAR_SKIRT_CELLS } from './far-mesh';
import { createWorldStore, type PaletteStore } from './palette-store';
import { MATERIAL_BITS, SHAPE_FULL, VOXEL_ROLE } from './record';

const grid = chunkGrid(32);
const ROCK = 7;
const GRASS = 9;
const ROOF = 12;
const EDGE = 32;

/** The node's sample at node cell (x, y, z), 0–32 an axis (cells): a stored brick's, else the band with the brick's sign. */
function sampleAt(b: FarBricks, x: number, y: number, z: number): number {
  const C = DISTANCE_BRICK_CELLS;
  const S = DISTANCE_BRICK_SIDE;
  const at = [x, y, z].map((c) => Math.min(b.side - 1, Math.floor(c / C)));
  const k = b.bricks[(at[2]! * b.side + at[1]!) * b.side + at[0]!]!;
  if (k < 0) return k === DISTANCE_BRICK_INSIDE ? -DISTANCE_BRICK_BAND_VOXELS : DISTANCE_BRICK_BAND_VOXELS;
  return distanceOfSample(b.samples[k * DISTANCE_BRICK_SAMPLES + ((z - at[2]! * C) * S + y - at[1]! * C) * S + x - at[0]! * C]!, DISTANCE_BRICK_BAND_VOXELS);
}

interface Face {
  readonly p: [number, number, number];
  readonly dir: number;
  /** The direction it is lit as. */
  readonly shade: number;
  readonly skirt: boolean;
  readonly clip: number;
  readonly material: number;
  /** Its share of a cell's square (clipped sides are half). */
  readonly area: number;
}

function faces(f: FarRasterFaces): Face[] {
  const out: Face[] = [];
  for (let i = 0; i < f.count; i++) {
    const kind = f.cells[i * 4 + 3]!;
    const clip = kind >> FAR_FACE_CLIP_SHIFT;
    const span = (lo: number, hi: number): number => 1 - 0.5 * ((clip >> lo) & 1) - 0.5 * ((clip >> hi) & 1);
    out.push({ p: [f.cells[i * 4]!, f.cells[i * 4 + 1]!, f.cells[i * 4 + 2]!], dir: kind & FAR_FACE_DIRECTION_MASK, shade: f.looks[i]! >>> FAR_FACE_SHADE_SHIFT, skirt: (kind & FAR_FACE_SKIRT) !== 0, clip, material: f.looks[i]! & ((1 << MATERIAL_BITS) - 1), area: span(0, 1) * span(2, 3) });
  }
  return out;
}

/** Ground over x, z in [lo, hi) (fine cells) up to `top(x, z)` (exclusive), `depth` thick: rock under a grass layer. */
function ground(s: PaletteStore, lo: number, hi: number, top: (x: number, z: number) => number, depth = 14): PaletteStore {
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const t = top(x, z);
    for (let y = t - depth; y < t; y++) s.setVoxel(x, y, z, { material: y === t - 1 ? GRASS : ROCK, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
  }
  return s;
}

describe('far bricks as faces to rasterize', () => {
  it('gives flat ground exactly its top faces, covering the node once, and skirts only on its box sides', () => {
    // Fine ground top at fine y 81: the node (0, 1, 0)'s surface at node y 8.5, between its samples 8 (solid) and 9; its
    // bottom under the node.
    const b = farBricksFromFaces(grid, ground(createWorldStore(grid), -40, 140, () => 81, 40), [0, 1, 0], 2);
    const all = faces(farRasterFaces(b));
    const top = all.filter((f) => !f.skirt);
    // A face for every sample column (0–32 each way), all up, on the solid sample under the surface, grass.
    expect(top.length).toBe(33 * 33);
    expect(top.every((f) => f.dir === 3 && f.shade === 3 && f.p[1] === 8 && f.material === GRASS)).toBe(true);
    expect(new Set(top.map((f) => `${f.p[0]},${f.p[2]}`)).size).toBe(33 * 33);
    // Clipped to the node's box, the faces cover its 32 × 32 cells exactly once.
    expect(top.reduce((a, f) => a + f.area, 0)).toBe(EDGE * EDGE);
    // Skirts: the box's four sides, on the solid samples within the skirt's depth of the surface that stored bricks
    // hold (the row under the surface; the rows below it lie in a brick wholly inside), facing out.
    const skirts = all.filter((f) => f.skirt);
    expect(skirts.length).toBe(4 * 33);
    for (const s of skirts) {
      expect(s.p[1]).toBe(8);
      // Lit as the ground they hang from, not as the side they face.
      expect(s.shade).toBe(3);
      expect(sampleAt(b, ...s.p)).toBeGreaterThan(-FAR_SKIRT_CELLS);
      const axis = s.dir >> 1;
      expect(axis).not.toBe(1);
      expect(s.p[axis]).toBe(s.dir & 1 ? EDGE : 0);
    }
  });

  it('gives a block in the air its six sides, a square of faces each', () => {
    // A fine block of 8³ cells: node cells 10–14 an axis, its samples 11–13 inside (10 and 14 lie on its faces).
    const s = createWorldStore(grid);
    for (let x = 20; x < 28; x++) for (let y = 84; y < 92; y++) for (let z = 20; z < 28; z++) s.setVoxel(x, y, z, { material: ROOF, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
    const all = faces(farRasterFaces(farBricksFromFaces(grid, s, [0, 1, 0], 2)));
    expect(all.some((f) => f.skirt)).toBe(false);
    expect(all.length).toBe(6 * 9);
    for (let dir = 0; dir < 6; dir++) {
      const side = all.filter((f) => f.dir === dir);
      expect(side.length).toBe(9);
      const axis = dir >> 1;
      // Each side on the cube's outer samples (11 or 13 along its axis), its cells 11–13 the other ways.
      expect(side.every((f) => f.p[axis] === (dir & 1 ? 13 : 11) && f.p.every((c) => c >= 11 && c <= 13) && f.material === ROOF && f.area === 1)).toBe(true);
    }
  });

  it('never puts a face between two solid samples nor leaves one out between solid and air, across bricks and across two nodes', () => {
    // Rough ground crossing brick rows and columns, over two neighbouring nodes (0, 1, 0) and (1, 1, 0).
    const s = ground(createWorldStore(grid), -24, 216, (x, z) => 80 + Math.round(6 * Math.sin(x / 9) * Math.cos(z / 13) + 2 * Math.sin((x + 2 * z) / 5)));
    for (let x = 60; x < 70; x++) for (let z = 40; z < 52; z++) for (let y = 80; y < 96; y++) s.setVoxel(x, y, z, { material: ROOF, role: VOXEL_ROLE.wall, shape: SHAPE_FULL, wetness: 0 });
    const a = farBricksFromFaces(grid, s, [0, 1, 0], 2);
    const b = farBricksFromFaces(grid, s, [1, 1, 0], 2);
    const sideOf = (n: FarBricks): Face[] => faces(farRasterFaces(n));
    for (const n of [a, b]) {
      const all = sideOf(n);
      const seen = new Set<string>();
      for (const f of all) {
        const axis = f.dir >> 1;
        const out = [...f.p] as [number, number, number];
        out[axis] = out[axis]! + (f.dir & 1 ? 1 : -1);
        // Its cube is solid; a face between samples has air on its other side, a skirt lies on the box face.
        expect(sampleAt(n, ...f.p)).toBeLessThan(0);
        if (f.skirt) {
          expect(f.p[axis]).toBe(f.dir & 1 ? EDGE : 0);
          expect(sampleAt(n, ...f.p)).toBeGreaterThan(-FAR_SKIRT_CELLS);
        } else {
          expect(sampleAt(n, ...out)).toBeGreaterThanOrEqual(0);
          const key = `${f.p.join(',')},${f.dir}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
      // Every pair of opposite signs in the node has its face.
      let pairs = 0;
      for (let z = 0; z <= EDGE; z++) for (let y = 0; y <= EDGE; y++) for (let x = 0; x <= EDGE; x++) {
        const d = sampleAt(n, x, y, z);
        for (let axis = 0; axis < 3; axis++) {
          const q = [x, y, z] as [number, number, number];
          if (q[axis] === EDGE) continue;
          q[axis] = q[axis]! + 1;
          const d1 = sampleAt(n, ...q);
          if (d < 0 === d1 < 0) continue;
          pairs++;
          const cube = d < 0 ? [x, y, z] : q;
          expect(seen.has(`${cube.join(',')},${axis * 2 + (d < 0 ? 1 : 0)}`)).toBe(true);
        }
      }
      expect(pairs).toBe(seen.size);
      expect(pairs).toBeGreaterThan(1000);
    }
    // The two nodes share their samples on x = 32 / x = 0 exactly: each draws its half of every face there, and no face
    // between samples lies on the shared box face.
    for (let y = 0; y <= EDGE; y++) for (let z = 0; z <= EDGE; z++) expect(sampleAt(a, EDGE, y, z)).toBe(sampleAt(b, 0, y, z));
    const onSeam = (fs: Face[], x: number): Map<string, Face> => new Map(fs.filter((f) => !f.skirt && f.p[0] === x && f.dir >> 1 !== 0).map((f) => [`${f.p[1]},${f.p[2]},${f.dir}`, f]));
    const seamA = onSeam(sideOf(a), EDGE);
    const seamB = onSeam(sideOf(b), 0);
    expect(seamA.size).toBeGreaterThan(20);
    expect([...seamA.keys()].sort()).toEqual([...seamB.keys()].sort());
    for (const [k, f] of seamA) {
      const g = seamB.get(k)!;
      expect(f.area + g.area).toBe(f.dir >> 1 === 1 ? (f.p[2] === 0 || f.p[2] === EDGE ? 0.5 : 1) : f.p[1] === 0 || f.p[1] === EDGE ? 0.5 : 1);
      expect(g.material).toBe(f.material);
    }
    // Runs along a face's first tangent are fewer instances than faces (what merging would save).
    const fa = farRasterFaces(a);
    expect(farRasterRuns(fa)).toBeLessThan(fa.count);
  });
});
