/**
 * Phase 12 (c): the scatter tool's pure part — placements for an instance set
 * (one model drawn many times). Copies are spread over a rectangle on the
 * ground plane (XZ) around the entity origin, with an optional random turn
 * about Y and a uniform random scale. The same seed gives the same layout.
 *
 * The result is the instance buffer layout: 10 float32 per copy (position
 * xyz, rotation quaternion xyzw, scale xyz), in the entity's local space.
 */

export const SCATTER_MAX = 65_536;

export interface ScatterOptions {
  count: number;
  /** Extent along X and Z (metres). */
  width: number;
  depth: number;
  scaleMin: number;
  scaleMax: number;
  /** Turn each copy by a random angle about Y. */
  randomYaw: boolean;
  seed: number;
}

/** Why the options cannot scatter (null: they can). */
export function scatterProblem(o: ScatterOptions): string | null {
  if (!Number.isInteger(o.count) || o.count < 1 || o.count > SCATTER_MAX) return `count must be a whole number 1–${SCATTER_MAX}`;
  for (const [k, v] of [['width', o.width], ['depth', o.depth]] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 10_000) return `${k} must be 0–10000 m`;
  }
  if (!Number.isFinite(o.scaleMin) || !Number.isFinite(o.scaleMax) || o.scaleMin <= 0 || o.scaleMax < o.scaleMin || o.scaleMax > 1000) {
    return 'scale must satisfy 0 < min ≤ max ≤ 1000';
  }
  if (!Number.isInteger(o.seed)) return 'seed must be a whole number';
  return null;
}

/** mulberry32: a small deterministic PRNG in [0, 1). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The instance buffer for the options (throws on invalid options; check `scatterProblem` first). */
export function scatterTransforms(o: ScatterOptions): Float32Array {
  const problem = scatterProblem(o);
  if (problem !== null) throw new Error(problem);
  const rand = prng(o.seed);
  const out = new Float32Array(o.count * 10);
  for (let i = 0; i < o.count; i += 1) {
    const x = (rand() - 0.5) * o.width;
    const z = (rand() - 0.5) * o.depth;
    const yaw = o.randomYaw ? rand() * Math.PI * 2 : 0;
    const s = o.scaleMin + rand() * (o.scaleMax - o.scaleMin);
    const b = i * 10;
    out[b] = x;
    out[b + 1] = 0;
    out[b + 2] = z;
    out[b + 3] = 0;
    out[b + 4] = Math.sin(yaw / 2);
    out[b + 5] = 0;
    out[b + 6] = Math.cos(yaw / 2);
    out[b + 7] = s;
    out[b + 8] = s;
    out[b + 9] = s;
  }
  return out;
}
