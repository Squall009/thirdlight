/**
 * Value noise and lattice hashes. A stored world depends on each of them
 * (terrain sculpts, brush masks, rule scatter, brush strokes, ground cover,
 * the wind texture, camera shake), so each keeps its own lanes and output
 * range: they are named variants, not one function, and none may change.
 *
 * Integer multiplies (`Math.imul`), shifts, `Math.floor` and products only:
 * the same point gives the same value in every JavaScript engine.
 */

/**
 * The lattice hash's multipliers: x, z and seed lanes, then two mixing
 * rounds. The GPU copies of the hashes (the editor's preview, ground cover)
 * build their shader nodes from these.
 */
export const NOISE_HASH_LANES: readonly number[] = Object.freeze([0x27d4eb2d, 0x165667b1, 0x9e3779b1, 0x85ebca6b, 0xc2b2ae35]);
const [HX, HZ, HS, HM1, HM2] = NOISE_HASH_LANES as [number, number, number, number, number];
/** The y lane of the value noise's 3D form, folded into the seed lane (y = 0 leaves it as 2D noise). */
const HY = 0x5bd1e995;
/** The y lane of {@link latticeHash4}. */
export const NOISE_HASH_Y_LANE = 0x1b873593;

/** Two mixing rounds over a combined lane value: an unsigned 32-bit hash. */
function mix(h: number, firstShift: number): number {
  h = Math.imul(h ^ (h >>> firstShift), HM1);
  h = Math.imul(h ^ (h >>> 13), HM2);
  return (h ^ (h >>> 16)) >>> 0;
}

/** An unsigned 32-bit hash of a lattice point and a seed (three lanes). */
export function latticeHash(ix: number, iz: number, seed: number): number {
  return mix(Math.imul(ix | 0, HX) ^ Math.imul(iz | 0, HZ) ^ Math.imul(seed | 0, HS), 15);
}

/** {@link latticeHash} with a y lane: an unsigned 32-bit hash of a 3D lattice point and a seed. */
export function latticeHash4(ix: number, iy: number, iz: number, seed: number): number {
  return mix(Math.imul(ix | 0, HX) ^ Math.imul(iy | 0, NOISE_HASH_Y_LANE) ^ Math.imul(iz | 0, HZ) ^ Math.imul(seed | 0, HS), 15);
}

/**
 * An unsigned 32-bit hash of a seed, a cell and a salt: the seed enters
 * unmultiplied and the salt's lane is offset by one, with a wider first
 * mix. Brush strokes and ground cover pick their copies with it, so the
 * same cell draws the same numbers on the CPU and in the shader.
 */
export function seedCellHash(seed: number, ix: number, iz: number, salt: number): number {
  return mix((seed | 0) ^ Math.imul(ix | 0, HX) ^ Math.imul(iz | 0, HZ) ^ Math.imul(salt + 1, HS), 16);
}

/**
 * The tiling hash of the wind texture: {@link latticeHash}'s lanes but the
 * full golden-ratio constant in the seed lane, and no `| 0` on the inputs
 * (the callers pass small integers).
 */
export function tileHash(x: number, y: number, seed: number): number {
  return mix(Math.imul(x, HX) ^ Math.imul(y, HZ) ^ Math.imul(seed, 0x9e3779b9), 15);
}

/** {@link latticeHash} in [0, 1). */
function hash01(ix: number, iz: number, seed: number): number {
  return latticeHash(ix, iz, seed) / 4294967296;
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
