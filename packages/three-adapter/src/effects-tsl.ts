/**
 * Phase 20.2: TSL twins of the effect reference maths (`@thirdlight/effects`)
 * for the WebGPU compute executor — each function mirrors its CPU
 * counterpart operation by operation so the GPU draws the same random
 * numbers and follows the same formulas:
 *
 * - `hash32` (murmur3-style mixing) and the mulberry32 `Rng` on u32 — bit
 *   exact (WGSL u32 arithmetic wraps like `Math.imul`); a float draw is the
 *   top 24 bits (the CPU divides all 32 bits by 2^32: they differ below
 *   2^-24);
 * - quaternion rotation and the effect-origin transforms of `math.ts`;
 * - curves and gradients (keys and stops are node data: unrolled);
 * - the seeded improved Perlin noise and its curl (the permutation table is
 *   a small storage buffer per effect seed).
 *
 * Pure node construction: needs no GPU (unit-tested in Node).
 */
import * as TSLTyped from 'three/tsl';

import { srgbToLinear } from '@thirdlight/effects';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type N = any;
/** TSL untyped: node types here follow the effect graph's port types, which the checker cannot see. */
const TSL: N = TSLTyped;

const { uint, float, vec3, vec4, If, select } = TSL;

/** One murmur3 mixing round of `h` with the 32-bit value `v` (h is a u32 var). */
function mixInto(h: N, v: N): void {
  const k = uint(v).toVar();
  k.assign(k.mul(uint(0xcc9e2d51)));
  k.assign(k.shiftLeft(uint(15)).bitOr(k.shiftRight(uint(17))));
  k.assign(k.mul(uint(0x1b873593)));
  h.assign(h.bitXor(k));
  h.assign(h.shiftLeft(uint(13)).bitOr(h.shiftRight(uint(19))));
  h.assign(h.mul(uint(5)).add(uint(0xe6546b64)));
}

/** `hash32(...values)` of the reference (values are u32 nodes or numbers). */
export function hash32(...values: N[]): N {
  const h = uint(0x9e3779b9).toVar();
  for (const v of values) mixInto(h, typeof v === 'number' ? uint(v >>> 0) : v);
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  h.assign(h.mul(uint(0x85ebca6b)));
  h.assign(h.bitXor(h.shiftRight(uint(13))));
  h.assign(h.mul(uint(0xc2b2ae35)));
  h.assign(h.bitXor(h.shiftRight(uint(16))));
  return h;
}

/** A u32 → [0, 1) (the top 24 bits: exact in f32). */
export function unitFloat(h: N): N {
  return float(uint(h).shiftRight(uint(8))).mul(1 / 16777216);
}

/** `hashFloat(...values)`. */
export function hashFloat(...values: N[]): N {
  return unitFloat(hash32(...values));
}

/** The reference's mulberry32 generator on a u32 state var: `next()` in [0, 1), `range(a, b)`. */
export class TslRng {
  private readonly state: N;
  constructor(seed: N) {
    this.state = uint(seed).toVar();
  }
  next(): N {
    this.state.assign(this.state.add(uint(0x6d2b79f5)));
    const t = this.state.toVar();
    t.assign(t.bitXor(t.shiftRight(uint(15))).mul(t.bitOr(uint(1))));
    t.assign(t.bitXor(t.add(t.bitXor(t.shiftRight(uint(7))).mul(t.bitOr(uint(61))))));
    // A var: every later use reads this draw (the node tree would otherwise re-evaluate it).
    return unitFloat(t.bitXor(t.shiftRight(uint(14)))).toVar();
  }
  range(a: N, b: N): N {
    const x = this.next();
    return float(a).add(float(b).sub(a).mul(x));
  }
}

// ---- vectors and the effect origin -------------------------------------------------------

/** Rotate v by the unit quaternion q (vec4 x, y, z, w) — `math.ts rotate`. */
export function rotate(q: N, v: N): N {
  const t = TSL.cross(q.xyz, v).mul(2);
  return v.add(t.mul(q.w)).add(TSL.cross(q.xyz, t));
}
export const conjugate = (q: N): N => vec4(q.xyz.negate(), q.w);
/** Component-wise a / b with 0 where b is 0 (`div3`). */
export function div3(a: N, b: N): N {
  const safe = (x: N, y: N): N => select(y.equal(0), float(0), x.div(y));
  return vec3(safe(a.x, b.x), safe(a.y, b.y), safe(a.z, b.z));
}
/** `normalize` with 0 for a (near) zero vector. */
export function normalize0(v: N): N {
  const l = TSL.length(v);
  return select(l.greaterThan(1e-12), v.div(l), vec3(0));
}

/** The effect origin: position, rotation (quaternion), scale — as uniforms. */
export interface OriginNodes {
  position: N;
  rotation: N;
  scale: N;
}
export const toWorldPoint = (o: OriginNodes, p: N): N => rotate(o.rotation, o.scale.mul(p)).add(o.position);
export const toWorldVector = (o: OriginNodes, v: N): N => rotate(o.rotation, o.scale.mul(v));
export const toWorldDirection = (o: OriginNodes, d: N): N => normalize0(rotate(o.rotation, div3(d, o.scale)));
export const toLocalPoint = (o: OriginNodes, p: N): N => div3(rotate(conjugate(o.rotation), p.sub(o.position)), o.scale);
export const toLocalVector = (o: OriginNodes, v: N): N => div3(rotate(conjugate(o.rotation), v), o.scale);

// ---- curves and gradients ------------------------------------------------------------------

/** `evalCurve(keys, t)`: linear between keys, clamped outside (keys are data). */
export function curveNode(keys: readonly number[], t: N): N {
  const n = keys.length >> 1;
  if (n === 0) return float(0);
  const out = float(keys[n * 2 - 1]!).toVar();
  // Walk the segments backwards: the first segment whose end is ≥ t wins (as the reference's loop).
  for (let i = n - 1; i >= 1; i--) {
    const t0 = keys[i * 2 - 2]!;
    const v0 = keys[i * 2 - 1]!;
    const t1 = keys[i * 2]!;
    const v1 = keys[i * 2 + 1]!;
    const seg = t1 > t0 ? float(v0).add(float(v1 - v0).mul(t.sub(t0)).div(t1 - t0)) : float(v1);
    If(t.lessThanEqual(t1), () => {
      out.assign(seg);
    });
  }
  If(t.lessThanEqual(keys[0]!), () => {
    out.assign(float(keys[1]!));
  });
  return out;
}

const srgbChannel = (c: N): N => select(c.lessThanEqual(0.04045), c.div(12.92), TSL.pow(c.add(0.055).div(1.055), 2.4));

/** `evalGradient(stops, t)`: sRGB interpolation, then linear RGB with alpha (stops are data). */
export function gradientNode(stops: readonly number[], t: N): N {
  const n = Math.floor(stops.length / 5);
  if (n === 0) return vec4(1, 1, 1, 1);
  const at = (i: number): N => vec4(stops[i * 5 + 1]!, stops[i * 5 + 2]!, stops[i * 5 + 3]!, stops[i * 5 + 4]!);
  const out = at(n - 1).toVar();
  for (let i = n - 1; i >= 1; i--) {
    const t0 = stops[(i - 1) * 5]!;
    const t1 = stops[i * 5]!;
    const f = t1 > t0 ? t.sub(t0).div(t1 - t0) : float(1);
    const seg = TSL.mix(at(i - 1), at(i), f);
    If(t.lessThanEqual(t1), () => {
      out.assign(seg);
    });
  }
  If(t.lessThanEqual(stops[0]!), () => {
    out.assign(at(0));
  });
  return vec4(srgbChannel(out.x), srgbChannel(out.y), srgbChannel(out.z), out.w);
}

/** A colour constant "#rrggbb" + alpha as linear RGBA numbers (the reference's `hexToLinear`). */
export function hexLinear(hex: string, alpha = 1): [number, number, number, number] {
  const n = /^#[0-9a-fA-F]{6}$/.test(hex) ? parseInt(hex.slice(1), 16) : 0xffffff;
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255), alpha];
}

// ---- noise -----------------------------------------------------------------------------------

/**
 * Seeded improved Perlin noise over a 512-entry permutation buffer (the
 * reference's `GradientNoise`), fbm and curl. `perm` is a uint storage node.
 */
export class TslNoise {
  constructor(private readonly perm: N) {}

  private P(i: N): N {
    return TSL.int(this.perm.element(i));
  }

  noise(p: N): N {
    const fl = TSL.floor(p);
    const X = TSL.int(fl.x).bitAnd(255);
    const Y = TSL.int(fl.y).bitAnd(255);
    const Z = TSL.int(fl.z).bitAnd(255);
    const x = p.x.sub(fl.x);
    const y = p.y.sub(fl.y);
    const z = p.z.sub(fl.z);
    const fade = (t: N): N => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10));
    const u = fade(x);
    const v = fade(y);
    const w = fade(z);
    const A = this.P(X).add(Y).toVar();
    const AA = this.P(A).add(Z).toVar();
    const AB = this.P(A.add(1)).add(Z).toVar();
    const B = this.P(X.add(1)).add(Y).toVar();
    const BA = this.P(B).add(Z).toVar();
    const BB = this.P(B.add(1)).add(Z).toVar();
    const g = (hash: N, gx: N, gy: N, gz: N): N => {
      const h = hash.bitAnd(15);
      const uu = select(h.lessThan(8), gx, gy);
      const vv = select(h.lessThan(4), gy, select(h.equal(12).or(h.equal(14)), gx, gz));
      return select(h.bitAnd(1).equal(0), uu, uu.negate()).add(select(h.bitAnd(2).equal(0), vv, vv.negate()));
    };
    const lerp = (t: N, a: N, b: N): N => a.add(t.mul(b.sub(a)));
    return lerp(
      w,
      lerp(v, lerp(u, g(this.P(AA), x, y, z), g(this.P(BA), x.sub(1), y, z)), lerp(u, g(this.P(AB), x, y.sub(1), z), g(this.P(BB), x.sub(1), y.sub(1), z))),
      lerp(v, lerp(u, g(this.P(AA.add(1)), x, y, z.sub(1)), g(this.P(BA.add(1)), x.sub(1), y, z.sub(1))), lerp(u, g(this.P(AB.add(1)), x, y.sub(1), z.sub(1)), g(this.P(BB.add(1)), x.sub(1), y.sub(1), z.sub(1)))),
    );
  }

  fbm(p: N, octaves: number): N {
    let sum: N = float(0);
    let amp = 1;
    let f = 1;
    for (let o = 0; o < octaves; o++) {
      sum = sum.add(this.noise(p.mul(f)).mul(amp));
      amp *= 0.5;
      f *= 2;
    }
    return sum;
  }

  /** The curl of (fbm(p), fbm(p + O1), fbm(p + O2)) by central differences (the reference's). */
  curl(p: N, octaves: number): N {
    const e = 1e-3;
    const O = [vec3(0, 0, 0), vec3(31.416, 47.853, 12.679), vec3(-19.37, 71.19, -53.11)];
    const axis = [vec3(e, 0, 0), vec3(0, e, 0), vec3(0, 0, e)];
    const d = (i: number, a: number): N => this.fbm(p.add(axis[a]!).add(O[i]!), octaves).sub(this.fbm(p.sub(axis[a]!).add(O[i]!), octaves)).div(2 * e);
    return vec3(d(2, 1).sub(d(1, 2)), d(0, 2).sub(d(2, 0)), d(1, 0).sub(d(0, 1)));
  }
}

/** The 512-entry permutation table of the reference's `GradientNoise(seed)`. */
export function permutationTable(seed: number, rngNext: (s: number) => () => number): Uint32Array {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  const next = rngNext(seed ^ 0x5bd1e995);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const t = p[i]!;
    p[i] = p[j]!;
    p[j] = t;
  }
  const out = new Uint32Array(512);
  for (let i = 0; i < 512; i++) out[i] = p[i & 255]!;
  return out;
}
