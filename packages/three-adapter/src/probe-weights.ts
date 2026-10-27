/**
 * How much a probe counts in the interpolation, by validity (baked and live
 * probes alike): a probe moved out of geometry saw its light from up to half
 * a spacing away (maybe the other side of a thin wall), one filled from its
 * neighbours inside geometry is only a fallback where no valid probe is
 * near. Pure.
 */
import { PROBE_FILLED, PROBE_MOVED } from '@thirdlight/runtime';

export const PROBE_WEIGHT_VALID = 1;
export const PROBE_WEIGHT_MOVED = 0.5;
export const PROBE_WEIGHT_FILLED = 1 / 64;

/** A probe's weight from its validity. */
export function probeWeight(validity: number): number {
  return validity === PROBE_FILLED ? PROBE_WEIGHT_FILLED : validity === PROBE_MOVED ? PROBE_WEIGHT_MOVED : PROBE_WEIGHT_VALID;
}
