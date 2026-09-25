/**
 * Phase 20.1: deterministic random numbers for effects.
 *
 * Everything random in an effect derives from the effect seed through
 * integer hashing, so the same seed, graph and step sequence give the same
 * particles on every run (the CPU reference; the GPU executor uses the same
 * hash in 20.2). No Math.random, no clock.
 */

/** A 32-bit integer hash of several 32-bit values (murmur3-style mixing). */
export function hash32(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const v of values) {
    let k = v >>> 0;
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A number in [0, 1) from a hash of the values. */
export function hashFloat(...values: number[]): number {
  return hash32(...values) / 4294967296;
}

/** FNV-1a of a string (node ids → stable 32-bit keys). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A sequential generator (mulberry32): the draws of one particle's Initialize chain. */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  /** A number in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** A number in [a, b]. */
  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
}
