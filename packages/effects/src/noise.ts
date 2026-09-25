/**
 * Phase 20.1: seeded gradient noise and curl noise (the Turbulence block).
 *
 * Perlin's improved 3D gradient noise over a permutation table shuffled by
 * the effect seed; curl noise is the curl of three decorrelated noise
 * potentials (central differences), which gives a divergence-free swirl
 * field: particles circulate instead of bunching up or thinning out.
 */
import { Rng } from './rng';
import type { Vec3 } from './math';

export class GradientNoise {
  private readonly perm = new Uint8Array(512);
  constructor(seed: number) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const rng = new Rng(seed ^ 0x5bd1e995);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i]!;
      p[i] = p[j]!;
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]!;
  }

  /** Noise at a point, about −1…1. */
  noise(x: number, y: number, z: number): number {
    const P = this.perm;
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    x -= Math.floor(x);
    y -= Math.floor(y);
    z -= Math.floor(z);
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = P[X]! + Y;
    const AA = P[A]! + Z;
    const AB = P[A + 1]! + Z;
    const B = P[X + 1]! + Y;
    const BA = P[B]! + Z;
    const BB = P[B + 1]! + Z;
    return lerp(
      w,
      lerp(v, lerp(u, grad(P[AA]!, x, y, z), grad(P[BA]!, x - 1, y, z)), lerp(u, grad(P[AB]!, x, y - 1, z), grad(P[BB]!, x - 1, y - 1, z))),
      lerp(v, lerp(u, grad(P[AA + 1]!, x, y, z - 1), grad(P[BA + 1]!, x - 1, y, z - 1)), lerp(u, grad(P[AB + 1]!, x, y - 1, z - 1), grad(P[BB + 1]!, x - 1, y - 1, z - 1))),
    );
  }

  /** Octaves of noise: each doubles the frequency and halves the amplitude. */
  fbm(x: number, y: number, z: number, octaves: number): number {
    let sum = 0;
    let amp = 1;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise(x * f, y * f, z * f);
      amp *= 0.5;
      f *= 2;
    }
    return sum;
  }

  /**
   * The curl of the potential (fbm(p), fbm(p + o1), fbm(p + o2)) at p (in
   * noise units): a divergence-free vector field.
   */
  curl(p: Vec3, octaves = 1): Vec3 {
    const e = 1e-3;
    const O1: Vec3 = [31.416, 47.853, 12.679];
    const O2: Vec3 = [-19.37, 71.19, -53.11];
    const psi = (i: 0 | 1 | 2, x: number, y: number, z: number): number => {
      const o = i === 0 ? [0, 0, 0] : i === 1 ? O1 : O2;
      return this.fbm(x + o[0]!, y + o[1]!, z + o[2]!, octaves);
    };
    const d = (i: 0 | 1 | 2, axis: 0 | 1 | 2): number => {
      const a: Vec3 = [p[0], p[1], p[2]];
      const b: Vec3 = [p[0], p[1], p[2]];
      a[axis] += e;
      b[axis] -= e;
      return (psi(i, a[0], a[1], a[2]) - psi(i, b[0], b[1], b[2])) / (2 * e);
    };
    return [d(2, 1) - d(1, 2), d(0, 2) - d(2, 0), d(1, 0) - d(0, 1)];
  }
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t: number, a: number, b: number): number => a + t * (b - a);
function grad(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}
