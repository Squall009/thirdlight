/**
 * Seeded random numbers. Particles, scatter tools, perf scenes and tests
 * draw from seeds that are saved or compared, so every engine and every run
 * must give the same sequence: integer arithmetic (`Math.imul`, shifts) only.
 */

/** mulberry32: a small 32-bit generator; each call gives the next number in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
