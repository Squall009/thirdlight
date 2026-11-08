/**
 * Placeholder texture sets for voxel materials (engine-owned test data, not
 * art): stone, plaster and timber for construction (one 4 × 4 m wall a
 * tile), earth, grass and rock for terrain (2 m a tile). Each is the set a
 * voxel material's surface names (`MaterialVoxel.surfaces`): albedo with
 * its height in A, a tangent-space normal map (OpenGL, green up) made from
 * that height at the material's depth, the height in its A as well (the
 * texture layout's place for it; the material record's map is the albedo's),
 * and ORM (occlusion from the height,
 * roughness, no metal), every map seamless left–right and top–bottom.
 *
 * Construction tiles keep their features on the build grid as the texture
 * layout recommends (courses every 0.5 m, block joints every metre, boards
 * every 0.25 m), the tile's bottom row on the grid's 0 m line. The image's
 * first row is its top.
 *
 * Deterministic: the same name and size give the same bytes on every run, at
 * any size (the features are placed in tile units, the noise on lattices
 * that divide the tile), so a test makes a small one and the bench the
 * authored 4096² (1024 px/m on a 4 m tile).
 */
import { deflateSync } from 'node:zlib';

import { pngBytes } from '@thirdlight/shared';

export const PLACEHOLDER_SETS = ['stone', 'plaster', 'timber', 'earth', 'grass', 'rock'] as const;
export type PlaceholderSet = (typeof PLACEHOLDER_SETS)[number];

/** The maps of a set, as the material record names them. */
export const PLACEHOLDER_MAPS = ['albedoHeight', 'normal', 'orm'] as const;

interface SetLook {
  /** Metres one tile covers (the material's tile). */
  readonly tileMetres: number;
  /** Metres between height 1 and 0 (the normal map's depth; the material's `heightDepth`). */
  readonly depthMetres: number;
  readonly roughness: number;
  /** The height of a point (u, v in [0, 1) of the tile, v up from the tile's foot) and its colour (linear-ish sRGB 0–1). */
  shade(u: number, v: number): { h: number; rgb: [number, number, number] };
}

/** A hash in [0, 1) of integer lattice coordinates (the same on every run). */
function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise in [0, 1] over a lattice of `period` cells a tile (seamless across the tile). */
function noise(u: number, v: number, period: number, seed: number): number {
  const x = u * period;
  const y = v * period;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const w = (a: number): number => ((a % period) + period) % period;
  const a = hash(w(ix), w(iy), seed);
  const b = hash(w(ix + 1), w(iy), seed);
  const c = hash(w(ix), w(iy + 1), seed);
  const d = hash(w(ix + 1), w(iy + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Octaves of {@link noise} from `period` up, each twice as fine and half as strong (0–1). */
function fbm(u: number, v: number, period: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(u, v, period << o, seed + o * 17);
    norm += amp;
    amp *= 0.5;
  }
  return sum / norm;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix3 = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t, a[2]! + (b[2]! - a[2]!) * t];

const LOOKS: Record<PlaceholderSet, SetLook> = {
  // Ashlar: 0.5 m courses of 1 m blocks, every other course shifted half a block, 2 cm joints.
  stone: {
    tileMetres: 4,
    depthMetres: 0.04,
    roughness: 0.85,
    shade(u, v) {
      const ym = v * 4;
      const row = Math.floor(ym / 0.5);
      const xm = u * 4 + (row & 1) * 0.5;
      const bx = Math.floor(xm);
      const dx = Math.min(xm - bx, bx + 1 - xm);
      const dy = Math.min(ym - row * 0.5, (row + 1) * 0.5 - ym);
      const edge = Math.min(dx, dy);
      const joint = 1 - smooth(0.01, 0.035, edge);
      const block = hash(((bx % 4) + 4) % 4, row % 8, 3);
      const grain = fbm(u, v, 16, 5, 11);
      const h = clamp01((1 - joint) * (0.78 + 0.22 * grain - 0.1 * (1 - smooth(0.03, 0.09, edge))) + joint * 0.12);
      const base = mix3([0.55, 0.52, 0.47], [0.66, 0.62, 0.55], block);
      const rgb = mix3(mix3(base, [0.42, 0.4, 0.37], 0.5 - grain * 0.6), [0.72, 0.7, 0.66], joint);
      return { h, rgb };
    },
  },
  // Lime plaster: a soft trowelled surface, faint stains.
  plaster: {
    tileMetres: 4,
    depthMetres: 0.008,
    roughness: 0.92,
    shade(u, v) {
      const n = fbm(u, v, 8, 6, 21);
      const fine = fbm(u, v, 128, 2, 23);
      const stain = smooth(0.55, 0.8, fbm(u, v, 4, 3, 29));
      const h = clamp01(0.55 + 0.35 * n + 0.1 * fine);
      return { h, rgb: mix3(mix3([0.86, 0.83, 0.76], [0.8, 0.76, 0.68], n), [0.7, 0.66, 0.58], stain * 0.5) };
    },
  },
  // Horizontal planks, 0.25 m wide, 1 cm gaps, butt joints every 2 m staggered, grain along the board.
  timber: {
    tileMetres: 4,
    depthMetres: 0.015,
    roughness: 0.78,
    shade(u, v) {
      const ym = v * 4;
      const board = Math.floor(ym / 0.25);
      const xm = u * 4 + (board % 4) * 0.5;
      const seg = Math.floor(xm / 2);
      const dy = Math.min(ym - board * 0.25, (board + 1) * 0.25 - ym);
      const dx = Math.min(xm - seg * 2, (seg + 1) * 2 - xm);
      const gap = 1 - smooth(0.004, 0.012, Math.min(dy, dx));
      const tint = hash(board % 16, ((seg % 2) + 2) % 2, 41);
      const grain = 0.5 + 0.5 * Math.sin((ym * 40 + 6 * fbm(u, v, 4, 3, 43) + tint * 9) * Math.PI);
      const knots = smooth(0.82, 0.9, fbm(u, v, 16, 2, 47));
      const h = clamp01((1 - gap) * (0.85 + 0.1 * grain - 0.15 * knots) + gap * 0.05);
      const wood = mix3([0.52, 0.36, 0.22], [0.64, 0.47, 0.3], tint);
      return { h, rgb: mix3(mix3(wood, [0.42, 0.28, 0.17], grain * 0.35 + knots * 0.4), [0.12, 0.09, 0.07], gap) };
    },
  },
  // Bare earth: clods and small stones.
  earth: {
    tileMetres: 2,
    depthMetres: 0.03,
    roughness: 0.95,
    shade(u, v) {
      const n = fbm(u, v, 8, 6, 61);
      const pebble = smooth(0.7, 0.78, noise(u, v, 64, 67));
      const h = clamp01(0.35 + 0.45 * n + 0.25 * pebble);
      return { h, rgb: mix3(mix3([0.33, 0.24, 0.16], [0.45, 0.34, 0.23], n), [0.55, 0.52, 0.48], pebble) };
    },
  },
  // Short grass: fine streaks, green to straw.
  grass: {
    tileMetres: 2,
    depthMetres: 0.02,
    roughness: 0.9,
    shade(u, v) {
      const blades = fbm(u * 1, v, 128, 2, 71) * 0.6 + fbm(u, v, 256, 1, 73) * 0.4;
      const patch = fbm(u, v, 4, 4, 79);
      const h = clamp01(0.3 + 0.7 * blades);
      return { h, rgb: mix3(mix3([0.2, 0.33, 0.12], [0.34, 0.45, 0.17], patch), [0.48, 0.47, 0.25], smooth(0.6, 0.9, patch) * 0.6) };
    },
  },
  // Weathered rock: ridged layers and cracks, a little lichen.
  rock: {
    tileMetres: 2,
    depthMetres: 0.1,
    roughness: 0.82,
    shade(u, v) {
      let r = 0;
      let amp = 0.5;
      for (let o = 0; o < 5; o++) {
        r += amp * (1 - Math.abs(2 * noise(u, v, 4 << o, 81 + o) - 1));
        amp *= 0.5;
      }
      const h = clamp01(r * 1.1 - 0.05);
      const lichen = smooth(0.62, 0.75, fbm(u, v, 8, 3, 89)) * smooth(0.5, 0.8, h);
      return { h, rgb: mix3(mix3([0.36, 0.35, 0.34], [0.55, 0.53, 0.5], h), [0.45, 0.5, 0.3], lichen * 0.6) };
    },
  },
};

/** What a set is for: metres a tile and the height depth its normal map was made with (the material's fields). */
export function placeholderLook(name: PlaceholderSet): { tileMetres: number; depthMetres: number } {
  const l = LOOKS[name];
  return { tileMetres: l.tileMetres, depthMetres: l.depthMetres };
}

/** A set's three maps at `size`² (RGBA 8-bit, first row the tile's top). */
export function placeholderSet(name: PlaceholderSet, size: number): Record<(typeof PLACEHOLDER_MAPS)[number], Uint8Array> {
  const look = LOOKS[name];
  const n = size * size;
  const height = new Float32Array(n);
  const albedoHeight = new Uint8Array(n * 4);
  const byte = (x: number): number => Math.round(clamp01(x) * 255);
  for (let y = 0; y < size; y++) {
    // Row 0 is the top: v (up from the tile's foot) of the pixel's centre.
    const v = 1 - (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const { h, rgb } = look.shade((x + 0.5) / size, v);
      const i = y * size + x;
      height[i] = h;
      albedoHeight.set([byte(rgb[0]), byte(rgb[1]), byte(rgb[2]), byte(h)], i * 4);
    }
  }
  const normal = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  // Slope in metres a metre: the height step times the depth over two pixels' width.
  const k = (look.depthMetres * size) / (2 * look.tileMetres);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const at = (xx: number, yy: number): number => height[(((yy + size) % size) * size + ((xx + size) % size))]!;
    const dx = (at(x + 1, y) - at(x - 1, y)) * k;
    // Up is towards row 0.
    const dy = (at(x, y - 1) - at(x, y + 1)) * k;
    const l = Math.hypot(dx, dy, 1);
    const i = y * size + x;
    normal.set([byte(0.5 - (dx / l) * 0.5), byte(0.5 - (dy / l) * 0.5), byte(0.5 + 0.5 / l), byte(height[i]!)], i * 4);
    const h = height[i]!;
    orm.set([byte(0.55 + 0.45 * h), byte(look.roughness - 0.1 * h), 0, 255], i * 4);
  }
  return { albedoHeight, normal, orm };
}

/** An 8-bit RGBA image as a PNG (no row filter; the placeholder images' file form). */
export function placeholderPng(rgba: Uint8Array, size: number): Uint8Array {
  const row = size * 4 + 1;
  const raw = new Uint8Array(size * row);
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * row + 1);
  return pngBytes({ width: size, height: size, bitDepth: 8, colorType: 6, idat: new Uint8Array(deflateSync(raw, { level: 6 })) });
}
