/**
 * Value noise on an integer lattice: the terrain's noise sculpt brush, the
 * brushes' noise mask (`paint-brush.ts`) and the editor's GPU preview of
 * both hash lattice points alike, so a noise drawn in the preview is the
 * noise the command stores.
 *
 * Integer multiplies (`Math.imul`), shifts, `Math.floor` and products only:
 * the same point gives the same value in every JavaScript engine.
 *
 * Pure.
 */

/** The noise hash's multipliers: x, z and seed lanes, then two mixing rounds (the editor's GPU preview hashes alike). */
export const TERRAIN_NOISE_HASH: readonly number[] = Object.freeze([0x27d4eb2d, 0x165667b1, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35]);
const [HX, HZ, HS, HM1, HM2] = TERRAIN_NOISE_HASH as [number, number, number, number, number];
/** The y lane of 3D noise, folded into the seed lane (y = 0 leaves it as 2D noise). */
const HY = 0x5bd1e995;

/** A deterministic hash of a lattice point to [0, 1). */
function hash01(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix | 0, HX) ^ Math.imul(iz | 0, HZ) ^ Math.imul(seed | 0, HS);
  h = Math.imul(h ^ (h >>> 15), HM1);
  h = Math.imul(h ^ (h >>> 13), HM2);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Value noise in [0, 1] on the lattice layer of seed `seed` (smoothstep between lattice points). */
function layer01(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx);
  const sz = fz * fz * (3 - 2 * fz);
  const a = hash01(ix, iz, seed);
  const b = hash01(ix + 1, iz, seed);
  const c = hash01(ix, iz + 1, seed);
  const d = hash01(ix + 1, iz + 1, seed);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sz;
}

/** Value noise in [-1, 1] at (x, z) in units of its lattice (smoothstep between lattice points). */
export function terrainNoise(x: number, z: number, seed: number): number {
  return layer01(x, z, seed) * 2 - 1;
}

/**
 * Value noise in [0, 1] at (x, y, z) in lattice units: two 2D layers (y's
 * lattice folded into the seed) blended by y. At y = 0 it is exactly the 2D
 * noise, so a mask on a terrain and one on a wall standing on it agree at
 * the ground.
 */
export function valueNoise01(x: number, z: number, seed: number, y = 0): number {
  if (y === 0) return layer01(x, z, seed);
  const iy = Math.floor(y);
  const fy = y - iy;
  const sy = fy * fy * (3 - 2 * fy);
  const lo = layer01(x, z, (seed | 0) ^ Math.imul(iy | 0, HY));
  const hi = layer01(x, z, (seed | 0) ^ Math.imul((iy + 1) | 0, HY));
  return lo + (hi - lo) * sy;
}

/**
 * Fractal value noise in [0, 1]: `octaves` layers, each twice the frequency
 * and half the weight of the one before, octave o on seed `seed + o`.
 */
export function fractalNoise01(x: number, z: number, octaves: number, seed: number, y = 0): number {
  let sum = 0;
  let norm = 0;
  let amp = 1;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise01(x * f, z * f, (seed + o) | 0, y * f);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}
