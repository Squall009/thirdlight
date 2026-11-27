/**
 * A range with soft ends, as rule conditions read a value: 1 inside it,
 * fading to 0 past each end. Material rules, rule scatter and the voxel
 * dressing rules share this one definition, so a condition written as a
 * range means the same wherever it is read.
 */

/** A condition's range: 1 within [min, max] (an absent end is open), fading to 0 over `fade` beyond each end. */
export interface FadeRange {
  min?: number;
  max?: number;
  /** How far past an end the condition fades out (the range's unit; absent or 0: a hard edge). */
  fade?: number;
}

/** `t` eased (smoothstep), clamped to [0, 1]. */
function ease(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

/** How much `v` meets a range (0 … 1, see {@link FadeRange}). */
export function fadeRangeAt(r: FadeRange, v: number): number {
  const fade = r.fade ?? 0;
  let k = 1;
  if (r.min !== undefined && v < r.min) k = fade > 0 ? ease(1 - (r.min - v) / fade) : 0;
  if (r.max !== undefined && v > r.max) k *= fade > 0 ? ease(1 - (v - r.max) / fade) : 0;
  return k;
}
