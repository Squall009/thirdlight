/**
 * Relief test heights for the voxel surface's vertex displacement: an
 * engine-owned height set (brick, stone, plank, rock, sand), made by code
 * so no asset is needed before voxel materials carry their own height maps.
 * Each layer is a tileable 0–1 height map (1 the surface, 0 its deepest
 * crevice) over one repeat of its material's texture: a 4 m construction
 * tile (brick, stone, plank: 256 texels a metre at 1024²) or a 2 m terrain
 * repeat (rock, sand: 512 texels a metre). Deterministic: the same bytes on
 * every run, so pictures compare.
 *
 * The material → layer and depth table here is for the benchmark worlds'
 * material ids (`tools/voxel-bench` world kit); real worlds take both from
 * their material records once those carry heights.
 */
import * as THREE from 'three/webgpu';

import { tileHash } from '@thirdlight/shared';

/** The test height layers, in array order. */
export const RELIEF_TEST_LAYERS: readonly string[] = Object.freeze(['brick', 'stone', 'plank', 'rock', 'sand']);

/** Texels along a test height layer's side. */
export const RELIEF_TEST_SIZE = 1024;

/** A material's relief: its height layer and how deep (metres) height 0 lies below the surface. */
export interface VoxelReliefLook {
  readonly layer: number;
  readonly depthMetres: number;
}

/**
 * The benchmark worlds' materials' relief (by id): rock 1, soil 2, grass 3,
 * sand 4, gravel 6, stone 10, timber 11, plaster 12, roof tile 13, plank 14,
 * brick 15. Depths are per material, in metres (sand shallow, rock deep).
 */
const TEST_RELIEF: ReadonlyMap<number, VoxelReliefLook> = new Map([
  [1, { layer: 3, depthMetres: 0.12 }],
  [2, { layer: 4, depthMetres: 0.03 }],
  [3, { layer: 4, depthMetres: 0.02 }],
  [4, { layer: 4, depthMetres: 0.03 }],
  [6, { layer: 3, depthMetres: 0.05 }],
  [10, { layer: 1, depthMetres: 0.06 }],
  [11, { layer: 2, depthMetres: 0.02 }],
  [12, { layer: 1, depthMetres: 0.01 }],
  [13, { layer: 0, depthMetres: 0.04 }],
  [14, { layer: 2, depthMetres: 0.02 }],
  [15, { layer: 0, depthMetres: 0.03 }],
]);

/** A benchmark material's test relief (null: none, it stays flat). */
export function voxelTestRelief(material: number): VoxelReliefLook | null {
  return TEST_RELIEF.get(material) ?? null;
}

/** The deepest relief of {@link voxelTestRelief} (metres): how far any displaced vertex moves. */
export const RELIEF_TEST_MAX_DEPTH_M = Math.max(...[...TEST_RELIEF.values()].map((r) => r.depthMetres));

/** Value noise in [0, 1] that repeats every `period` lattice steps (smoothstep between lattice points). */
function tiledNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = (i: number): number => ((i % period) + period) % period;
  const h = (a: number, b: number): number => tileHash(w(a), w(b), seed) / 4294967296;
  const top = h(ix, iy) + (h(ix + 1, iy) - h(ix, iy)) * sx;
  const bottom = h(ix, iy + 1) + (h(ix + 1, iy + 1) - h(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** Fractal {@link tiledNoise}: octave o at period · 2^o, half the weight of the one before. */
function tiledFractal(u: number, v: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let p = period;
  for (let o = 0; o < octaves; o++) {
    sum += amp * tiledNoise(u * p, v * p, p, seed + o);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

const ramp = (e0: number, e1: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Running-bond blocks: `rows` × `cols` a tile, every other row half a block along, a joint `joint` tile units wide. */
function blocks(u: number, v: number, rows: number, cols: number, joint: number, seed: number): number {
  const row = Math.floor(v * rows);
  const uu = u * cols + (row & 1) * 0.5;
  const col = Math.floor(uu);
  const du = Math.min(uu - col, 1 - (uu - col)) / cols;
  const dv = Math.min(v * rows - row, 1 - (v * rows - row)) / rows;
  const edge = Math.min(du, dv);
  const face = 0.82 + 0.12 * (tileHash(((col % cols) + cols) % cols, row % rows, seed) / 4294967296) + 0.06 * tiledFractal(u, v, 32, 3, seed + 7);
  return ramp(joint * 0.5, joint * 1.6, edge) * face + 0.06;
}

/** Cobbles: a Voronoi cell a stone (`cells` across the tile), domed toward its middle, joints between. */
function cobbles(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells;
  const y = v * cells;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = Infinity;
  let f2 = Infinity;
  let id = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = ix + dx;
    const cy = iy + dy;
    const wx = ((cx % cells) + cells) % cells;
    const wy = ((cy % cells) + cells) % cells;
    const px = cx + 0.15 + 0.7 * (tileHash(wx, wy, seed) / 4294967296);
    const py = cy + 0.15 + 0.7 * (tileHash(wx, wy, seed + 1) / 4294967296);
    const d = Math.hypot(px - x, py - y);
    if (d < f1) {
      f2 = f1;
      f1 = d;
      id = wx * 131 + wy;
    } else if (d < f2) f2 = d;
  }
  const gap = f2 - f1;
  const dome = ramp(0.02, 0.35, gap);
  return 0.08 + dome * (0.78 + 0.14 * ((id * 2654435761) % 997) / 997) + 0.04 * tiledFractal(u, v, 64, 2, seed + 3);
}

/** Boards along U: `rows` a tile, a groove between, grain stretched along the board, butt joints at random places. */
function planks(u: number, v: number, rows: number, seed: number): number {
  const row = Math.floor(v * rows);
  const dv = Math.min(v * rows - row, 1 - (v * rows - row)) / rows;
  const shift = tileHash(row % rows, 0, seed) / 4294967296;
  const uu = (u + shift) % 1;
  const du = Math.min(uu * 2 - Math.floor(uu * 2), 1 - (uu * 2 - Math.floor(uu * 2))) / 2;
  const groove = ramp(0.0015, 0.004, Math.min(dv, du));
  const grain = tiledNoise(u * 8, v * 256, 8, seed + 5) * 0.5 + tiledNoise(u * 16, v * 512, 16, seed + 6) * 0.5;
  return 0.1 + groove * (0.8 + 0.1 * grain);
}

/** Rock: ridged fractal noise (sharp crests, deep cracks). */
function rock(u: number, v: number, seed: number): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let p = 4;
  for (let o = 0; o < 5; o++) {
    const n = tiledNoise(u * p, v * p, p, seed + o);
    sum += amp * (1 - Math.abs(n * 2 - 1));
    norm += amp;
    amp *= 0.55;
    p *= 2;
  }
  return Math.max(0, Math.min(1, (sum / norm - 0.25) / 0.65));
}

/** Sand: wind ripples bent by a slow noise, a little grain. */
function sand(u: number, v: number, seed: number): number {
  const bend = tiledFractal(u, v, 4, 3, seed);
  const ripple = 0.5 + 0.5 * Math.sin(2 * Math.PI * (12 * v + 2 * bend));
  return 0.25 + 0.6 * ripple * ripple + 0.15 * tiledNoise(u * 128, v * 128, 128, seed + 9);
}

/** The test height layers (in {@link RELIEF_TEST_LAYERS} order), `size`² bytes each, tileable. */
export function reliefTestHeights(size = RELIEF_TEST_SIZE): Uint8Array[] {
  const fns: Array<(u: number, v: number) => number> = [
    (u, v) => blocks(u, v, 16, 8, 0.006, 11),
    (u, v) => cobbles(u, v, 10, 21),
    (u, v) => planks(u, v, 16, 31),
    (u, v) => rock(u, v, 41),
    (u, v) => sand(u, v, 51),
  ];
  return fns.map((f) => {
    const out = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) out[y * size + x] = Math.round(Math.max(0, Math.min(1, f((x + 0.5) / size, (y + 0.5) / size))) * 255);
    return out;
  });
}

/** The heights as one single-channel array texture, mipmapped and repeating (a layer each). */
export function reliefHeightTexture(layers: readonly Uint8Array[], size: number): THREE.DataArrayTexture {
  const data = new Uint8Array(size * size * layers.length);
  layers.forEach((l, k) => {
    if (l.length !== size * size) throw new RangeError(`relief heights: layer ${k} holds ${l.length} bytes, not ${size}²`);
    data.set(l, k * size * size);
  });
  const tex = new THREE.DataArrayTexture(data, size, size, layers.length);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
