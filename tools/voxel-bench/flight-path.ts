/**
 * The flight both streaming benchmarks fly (the Node one and the browser
 * page), so their numbers compare: a square loop at ±750 m over the hilly
 * 2 × 2 km test world, its corners turning back over ground left seconds
 * before (the reload case), at a fixed height above y = 0.
 */

/** The focus height in cells (60 m: between the lakes at 12 m and the hilltops at ~125 m). */
export const ALTITUDE_CELLS = 120;

/** Half the side of the loop (metres). */
const LOOP_HALF_M = 750;

/** The point (cells x, z) `d` metres along the loop, starting at its (−750, −750) corner. */
export function loopAt(d: number): [number, number] {
  const side = 2 * LOOP_HALF_M;
  const s = ((d % (4 * side)) + 4 * side) % (4 * side);
  const k = Math.floor(s / side);
  const t = s - k * side;
  const h = LOOP_HALF_M;
  const m: [number, number] = k === 0 ? [-h + t, -h] : k === 1 ? [h, -h + t] : k === 2 ? [h - t, h] : [-h, h - t];
  return [m[0] * 2, m[1] * 2];
}

/** The loop's heading at `d` metres (unit x, z). */
export function loopHeading(d: number): [number, number] {
  const side = 2 * LOOP_HALF_M;
  const k = Math.floor((((d % (4 * side)) + 4 * side) % (4 * side)) / side);
  return k === 0 ? [1, 0] : k === 1 ? [0, 1] : k === 2 ? [-1, 0] : [0, -1];
}
