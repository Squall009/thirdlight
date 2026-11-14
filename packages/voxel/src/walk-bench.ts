/**
 * The rays the occupancy walk is measured with (`run.mjs walk`, the page's
 * GPU walk bench and its check against the CPU): three kinds a lighting
 * pass walks — short (8 m, a light volume's cell to its neighbours), medium
 * (64 m, sun and sky visibility near the ground) and long (2 km toward the
 * horizon, into the far field) — from points round an eye in the open, so
 * the CPU and the GPU are measured on the same kind of rays. Seeded: a run
 * walks the same rays as the run before it.
 */
import type { WalkStop } from './occupancy-walk';
import { walkRay, type WalkRay } from './walk-steps';

/** A ray of a batch: the walk's ray, how far, and what stops it. */
export interface WalkBatchRay {
  readonly ray: WalkRay;
  readonly maxT: number;
  readonly stop: WalkStop;
}

/** The kinds: how far, and the directions' elevation (degrees; absent: every direction). */
export const WALK_BENCH_KINDS = Object.freeze({
  short: { maxT: 8 },
  medium: { maxT: 64 },
  long: { maxT: 2000, elevation: [0, 30] as const },
} as const);
export type WalkBenchKind = keyof typeof WALK_BENCH_KINDS;

/** A seeded generator in [0, 1). */
export function walkBenchRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** `n` rays of a kind from points within `jitter` metres of `eye` (half that up and down), stopped by what blocks light. */
export function walkBenchRays(kind: WalkBenchKind, n: number, eye: readonly [number, number, number], jitter = 2, seed = 1): WalkBatchRay[] {
  const k: { readonly maxT: number; readonly elevation?: readonly [number, number] } = WALK_BENCH_KINDS[kind];
  const r = walkBenchRandom(seed);
  const out: WalkBatchRay[] = [];
  if (!eye.slice(0, 3).every(Number.isFinite) || !(jitter >= 0)) return out;
  while (out.length < n) {
    const o = [eye[0] + (r() * 2 - 1) * jitter, eye[1] + (r() - 0.5) * jitter, eye[2] + (r() * 2 - 1) * jitter];
    const yaw = r() * 2 * Math.PI;
    const up = k.elevation === undefined ? r() * 2 - 1 : Math.sin(((k.elevation[0] + r() * (k.elevation[1] - k.elevation[0])) * Math.PI) / 180);
    const s = Math.sqrt(1 - up * up);
    const ray = walkRay(o, [s * Math.cos(yaw), up, s * Math.sin(yaw)]);
    if (ray !== null) out.push({ ray, maxT: k.maxT, stop: 'light' });
  }
  return out;
}
