/**
 * The depth a draw past the camera's far plane writes (a voxel world's far
 * field, voxel-far-common.ts): the camera's own perspective depth of the
 * distance pushed back by {@link FAR_DEPTH_PUSH} up to {@link FAR_DEPTH_SPLIT}
 * of the far plane, and past it the distance's logarithm up to
 * {@link FAR_DEPTH_MAX_M} in what remains of the depth range. So far draws
 * sort among themselves at any distance and behind the near scene where both
 * cover a pixel.
 *
 * Kept apart from the far field's draws because occlusion culling tests far
 * draws' boxes against the depth pyramid (occlusion-instances.ts) in the
 * same mapping their fragments write: the camera's own depth of a box
 * kilometres past its far plane is past the far plane's, and would be hidden
 * by the sky. The TSL and the CPU forms are one rule; the tests hold them
 * together.
 */
import * as TSLTyped from 'three/tsl';

import type { N } from './effects-tsl';

const TSL: N = TSLTyped;
const { clamp, float, log, mix, select } = TSL;

/** How far behind its distance a far fragment's depth is (near the camera): where it meets the near field, the near field is in front. */
export const FAR_DEPTH_PUSH = 1.05;

/** The share of the camera's far plane up to which far depth is the camera's own (past it, logarithmic). */
export const FAR_DEPTH_SPLIT = 0.5;

/** The distance (metres) the far depth range ends at: a far node past it sorts as if there. */
export const FAR_DEPTH_MAX_M = 64_000;

/**
 * The camera's normalized depth (NDC z) of a distance `x` along the view axis from its projection's depth terms
 * (`a` = element [2][2], `b` = [3][2], column-major): standard, reversed and either range alike.
 */
const ndcOf = (a: N, b: N, x: N): N => a.negate().add(b.div(x));

/**
 * The far draws' normalized depth (NDC z) of a point `viewZ` metres along the view axis (negative in front), from
 * the projection's depth terms `a`, `b` and the far plane (TSL).
 */
export function farNdcDepthOf(viewZ: N, a: N, b: N, far: N): N {
  const x = viewZ.negate().mul(FAR_DEPTH_PUSH).max(1e-3).toVar();
  const split = far.mul(FAR_DEPTH_SPLIT);
  const zSplit = ndcOf(a, b, split);
  const zEnd = mix(zSplit, ndcOf(a, b, far), 0.9999);
  const t = clamp(log(x.div(split)).div(log(float(FAR_DEPTH_MAX_M).div(split))), 0, 1);
  return select(x.lessThan(split), ndcOf(a, b, x), mix(zSplit, zEnd, t));
}

/** {@link farNdcDepthOf} on the CPU: `projection` column-major (three's `elements`). */
export function farNdcDepthCpu(viewZ: number, projection: ArrayLike<number>, far: number): number {
  const a = projection[10]!;
  const b = projection[14]!;
  const ndc = (x: number): number => -a + b / x;
  const x = Math.max(-viewZ * FAR_DEPTH_PUSH, 1e-3);
  const split = far * FAR_DEPTH_SPLIT;
  if (x < split) return ndc(x);
  const zSplit = ndc(split);
  const zEnd = zSplit + (ndc(far) - zSplit) * 0.9999;
  const t = Math.min(1, Math.max(0, Math.log(x / split) / Math.log(FAR_DEPTH_MAX_M / split)));
  return zSplit + (zEnd - zSplit) * t;
}
