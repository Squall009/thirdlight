/**
 * What the far field shows on terrain whose top cells are thin: a gentle
 * slope of soil under a grass skin filled under half (the mesher and the
 * brick fields put the surface under such a cell, in the soil), built at a
 * coarse level through the far jobs' own inputs (encoded entries, as the far
 * cache serves them). Every upward vertex of the far mesh and every upward
 * surface sample of the far bricks must show the grass, never the soil
 * (else the slope reads as rings, one at each height step); a real rock face
 * beside it keeps its rock.
 */
import { describe, expect, it } from 'vitest';
import { rulesRef } from './assembly';
import { encodeDenseChunk } from './cell-delta';
import { chunkGrid } from './coords';
import { createDenseChunk } from './dense-chunk';
import { DISTANCE_BRICK_BAND_VOXELS, DISTANCE_BRICK_CELLS, DISTANCE_BRICK_SAMPLES, DISTANCE_BRICK_SIDE, distanceOfSample } from './distance-brick-format';
import { FAR_BRICK_BUILD, type FarBricks } from './far-bricks';
import { brickFarNodeBy, farBricksFromFaces } from './far-bricks-faces';
import { FAR_POSITION_ORIGIN_CELLS, FAR_VERTEX_BYTES, farNeighbourIndex, farVertexLook, meshFarNode } from './far-mesh';
import { POSITION_STEPS_PER_CELL } from './derived-mesh';
import { createWorldStore, type PaletteStore } from './palette-store';
import { MATERIAL_BITS, SHAPE_FULL, VOXEL_ROLE } from './record';
import { WORLD_RULES } from './rule-registry';
import type { StoredChunk } from './stream-job';

const grid = chunkGrid(32);
const SOIL = 5;
const ROCK = 7;
const GRASS = 9;
/** The level the jobs build at (a coarse one: 4 m cells). */
const LEVEL = 3;
/** The cliff's face: the rock stands from here up in x (node cells). */
const CLIFF_X = 20;
/** The cliff's top (cells of the scene's scale). */
const CLIFF_TOP = 60;

/**
 * The scene at `k` cells a node cell (1: the level's own cells, 2: its children's): a slope rising a node cell every
 * 4 in x, soil under one grass cell 3/16–7/16 full; from {@link CLIFF_X} on a rock cliff to {@link CLIFF_TOP}, a
 * thin grass skin on it too.
 */
function scene(k: number): PaletteStore {
  const s = createWorldStore(grid);
  const lo = -40 * k;
  const hi = 72 * k;
  for (let x = lo; x < hi; x++) for (let z = lo; z < hi; z++) {
    const cliff = x >= CLIFF_X * k;
    const h = cliff ? CLIFF_TOP * k : (44 + x / k / 4) * k;
    const top = Math.floor(h);
    for (let y = 20 * k; y < top; y++) s.setVoxel(x, y, z, { material: cliff ? ROCK : SOIL, role: VOXEL_ROLE.terrain, shape: SHAPE_FULL, wetness: 0 });
    const fill = Math.round(SHAPE_FULL * (0.1875 + 0.25 * (h - top)));
    s.setVoxel(x, top, z, { material: GRASS, role: VOXEL_ROLE.terrain, shape: fill, wetness: 0 });
  }
  return s;
}

/** A chunk of `s` as the far cache serves it (null: air). */
function entry(s: PaletteStore, cx: number, cy: number, cz: number): StoredChunk | null {
  const cells = createDenseChunk(grid);
  if (!s.exportChunk(cx, cy, cz, cells)) return null;
  const bytes = encodeDenseChunk(grid, cells);
  return bytes === null ? null : { stored: bytes, raw: true };
}

/** The node and its 26 neighbours' entries. */
function neighbourhood(s: PaletteStore, node: readonly [number, number, number]): Array<StoredChunk | null> {
  const cells: Array<StoredChunk | null> = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) cells[farNeighbourIndex(dx, dy, dz)] = entry(s, node[0] + dx, node[1] + dy, node[2] + dz);
  return cells;
}

const decompress = (): Uint8Array => {
  throw new Error('entries here are raw');
};

const NODE = [0, 1, 0] as const;

/** The node's bricks as a dense corner field and looks (33³ corners, NaN where no brick is stored). */
function corners(b: FarBricks): { d: (x: number, y: number, z: number) => number; look: (x: number, y: number, z: number) => number } {
  const M = 33;
  const C = DISTANCE_BRICK_CELLS;
  const T = DISTANCE_BRICK_SIDE;
  const dist = new Float32Array(M ** 3).fill(NaN);
  const look = new Uint16Array(M ** 3);
  for (let bi = 0; bi < b.blocks.length / 4; bi++) {
    const [bx, by, bz] = [b.blocks[bi * 4]!, b.blocks[bi * 4 + 1]!, b.blocks[bi * 4 + 2]!];
    for (let sz = 0; sz < T; sz++) for (let sy = 0; sy < T; sy++) for (let sx = 0; sx < T; sx++) {
      const k = (sz * T + sy) * T + sx;
      const ci = ((bz * C + sz) * M + by * C + sy) * M + bx * C + sx;
      dist[ci] = distanceOfSample(b.samples[bi * DISTANCE_BRICK_SAMPLES + k]!, DISTANCE_BRICK_BAND_VOXELS);
      look[ci] = b.looks[bi * DISTANCE_BRICK_SAMPLES + k]! & ((1 << MATERIAL_BITS) - 1);
    }
  }
  return { d: (x, y, z) => dist[(z * M + y) * M + x]!, look: (x, y, z) => look[(z * M + y) * M + x]! };
}

/** Looks of the surface samples (within a cell of it) of the slope facing up, and of the cliff's face facing −x. */
function brickLooks(b: FarBricks): { up: Map<number, number>; face: Map<number, number> } {
  const { d, look } = corners(b);
  const up = new Map<number, number>();
  const face = new Map<number, number>();
  const count = (m: Map<number, number>, k: number): void => void m.set(k, (m.get(k) ?? 0) + 1);
  for (let x = 1; x < 32; x++) for (let y = 1; y < 32; y++) for (let z = 1; z < 32; z++) {
    if (!(Math.abs(d(x, y, z)) <= 1)) continue;
    const gx = d(x + 1, y, z) - d(x - 1, y, z);
    const gy = d(x, y + 1, z) - d(x, y - 1, z);
    if (x <= CLIFF_X - 3 && gy > Math.abs(gx)) count(up, look(x, y, z));
    // The face away from the slope's foot and the cliff's top edge.
    if (x === CLIFF_X && y >= 21 && y <= 26 && -gx > Math.abs(gy)) count(face, look(x, y, z));
  }
  return { up, face };
}

describe('far looks over thin top cells', () => {
  it('the far mesh shows the grass on every upward vertex of the slope, the rock on the cliff face', () => {
    const s = scene(1);
    const m = meshFarNode(createWorldStore(grid), { edge: 32, level: LEVEL, node: NODE, cells: neighbourhood(s, NODE), rules: rulesRef(WORLD_RULES) }, decompress);
    const view = new DataView(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength);
    const up = new Map<number, number>();
    const face = new Map<number, number>();
    for (let v = 0; v < m.vertexCount; v++) {
      const o = v * FAR_VERTEX_BYTES;
      const p = [0, 2, 4].map((a) => view.getUint16(o + a, true) / POSITION_STEPS_PER_CELL - FAR_POSITION_ORIGIN_CELLS);
      const [nx, ny] = [view.getInt8(o + 8) / 127, view.getInt8(o + 9) / 127];
      const mat = farVertexLook(view.getUint16(o + 6, true)).material;
      if (p[0]! < 0 || p[0]! > 32 || p[2]! < 0 || p[2]! > 32 || p[1]! < 0 || p[1]! > 32) continue;
      if (p[0]! <= CLIFF_X - 3 && ny > 0.7) up.set(mat, (up.get(mat) ?? 0) + 1);
      if (p[0]! >= CLIFF_X - 0.5 && p[0]! <= CLIFF_X + 0.5 && p[1]! >= 21 && p[1]! <= 26 && nx < -0.7) face.set(mat, (face.get(mat) ?? 0) + 1);
    }
    expect(up.get(GRASS) ?? 0).toBeGreaterThan(100);
    expect([...up.keys()]).toEqual([GRASS]);
    expect(face.get(ROCK) ?? 0).toBeGreaterThan(10);
    expect([...face.keys()]).toEqual([ROCK]);
  });

  it('the bricks from the children’s faces show the grass on every upward surface sample, the rock on the cliff face, and the job decoding its entries equals the build from a store', () => {
    // The job's finer cells: the scene at twice the resolution, the node's children and one of theirs round them.
    const fine = scene(2);
    const S = 2;
    const cells: Array<StoredChunk | null> = [];
    for (let dx = -1; dx <= S; dx++) for (let dz = -1; dz <= S; dz++) for (let dy = -1; dy <= S; dy++) cells.push(entry(fine, NODE[0] * S + dx, NODE[1] * S + dy, NODE[2] * S + dz));
    const own = neighbourhood(scene(1), NODE);
    const b = brickFarNodeBy(createWorldStore(grid), { level: LEVEL, node: NODE, cells: own, build: FAR_BRICK_BUILD, fine: { level: LEVEL - 1, scale: S, cells } }, decompress);
    const { up, face } = brickLooks(b);
    expect(up.get(GRASS) ?? 0).toBeGreaterThan(100);
    expect([...up.keys()]).toEqual([GRASS]);
    expect(face.get(ROCK) ?? 0).toBeGreaterThan(10);
    expect([...face.keys()]).toEqual([ROCK]);
    const want = farBricksFromFaces(grid, fine, NODE, S);
    expect(b.bricks).toEqual(want.bricks);
    expect(b.samples).toEqual(want.samples);
    expect(b.looks).toEqual(want.looks);
    expect([...b.bounds]).toEqual([...want.bounds]);
  });
});
