/**
 * Auto-exposure (eye adaptation) — the maths both halves share.
 *
 * The camera brain turns each virtual camera's settings into an
 * `ExposureLook` and blends the look on screen with the camera blend
 * (`blendExposureLook`); the view carries it. The renderer meters the frame
 * (a log-average of the scene's luminance on a small grid, read back a frame
 * or two later) and steps the exposure toward the target each drawn frame
 * (`meteredLogLuminance`, `targetExposure`, `adaptExposure`).
 *
 * A camera without auto-exposure is a look of weight 0: its range is the
 * environment's fixed exposure alone (`exposureRange`), so a blend from or to
 * it narrows or widens the range smoothly and a cut to it shows the fixed
 * exposure at once. Everything is in stops (log2) where it blends or moves,
 * as exposure is perceived.
 *
 * Pure: no three.js, no clock.
 */
import { VIRTUAL_CAMERA_DEFAULTS as VCD, type CameraExposureMetering } from '@thirdlight/project-model';

/**
 * The scene luminance the metered average is exposed to: middle grey
 * (18 %), the photographic key every engine's auto-exposure aims the
 * average at before compensation.
 */
export const EXPOSURE_KEY = 0.18;

/** Luminance below this meters as this (a black pixel would pull a log-average to −∞). */
export const METER_MIN_LUMINANCE = 1e-4;

/**
 * Centre-weighted metering: a texel's weight falls off as a Gaussian of its
 * distance from the middle of the frame (in half-heights and half-widths,
 * −1…1), with this sigma — the middle third counts most, the corners about a
 * fiftieth as much.
 */
export const CENTER_WEIGHT_SIGMA = 0.5;

/** A camera's auto-exposure as the renderer applies it (blended over camera blends). */
export interface ExposureLook {
  /** How much of the view adapts (1: fully; between: a blend from or to a camera without auto-exposure). */
  readonly auto: number;
  /** Exposure bounds (multipliers). */
  readonly min: number;
  readonly max: number;
  /** Rates per second of the remaining gap in stops: rising (into the dark) and falling (into the light). */
  readonly brighten: number;
  readonly darken: number;
  /** Centre weighting (1: centre-weighted, 0: the frame's average). */
  readonly center: number;
  /** Stops over (positive) or under middle grey. */
  readonly compensation: number;
}

/** The camera fields that make its look (project-model `VirtualCameraComponent`). */
export interface ExposureFields {
  readonly autoExposure?: boolean;
  readonly exposureMin?: number;
  readonly exposureMax?: number;
  readonly exposureBrightenSpeed?: number;
  readonly exposureDarkenSpeed?: number;
  readonly exposureMetering?: CameraExposureMetering;
  readonly exposureCompensation?: number;
}

const finite = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
/** Exposure multipliers are kept off 0 (their stops are logs). */
const POSITIVE = 1e-6;

/** A camera's look (null: auto-exposure off). */
export function cameraExposureLook(c: ExposureFields): ExposureLook | null {
  if (c.autoExposure !== true) return null;
  const min = Math.max(POSITIVE, finite(c.exposureMin, VCD.exposureMin));
  const max = Math.max(min, finite(c.exposureMax, VCD.exposureMax));
  return {
    auto: 1,
    min,
    max,
    brighten: Math.max(0, finite(c.exposureBrightenSpeed, VCD.exposureBrightenSpeed)),
    darken: Math.max(0, finite(c.exposureDarkenSpeed, VCD.exposureDarkenSpeed)),
    center: (c.exposureMetering ?? VCD.exposureMetering) === 'average' ? 0 : 1,
    compensation: finite(c.exposureCompensation, VCD.exposureCompensation),
  };
}

/**
 * The look `w` (0–1) of the way from `a` to `b` (null: auto-exposure off).
 * `auto` blends linearly; every other setting is the auto-weighted mix of
 * the sides that adapt (a side without auto-exposure has none to give), the
 * bounds in stops. Null when neither side adapts.
 */
export function blendExposureLook(a: ExposureLook | null, b: ExposureLook | null, w: number): ExposureLook | null {
  const t = Math.min(1, Math.max(0, w));
  const wa = (a?.auto ?? 0) * (1 - t);
  const wb = (b?.auto ?? 0) * t;
  const sum = wa + wb;
  if (a === null && b === null) return null;
  if (t <= 0) return a;
  if (t >= 1) return b;
  if (!(sum > 0)) return null;
  const ka = wa / sum;
  const kb = wb / sum;
  const mix = (f: (l: ExposureLook) => number): number => (a !== null ? f(a) * ka : 0) + (b !== null ? f(b) * kb : 0);
  return {
    auto: (a?.auto ?? 0) * (1 - t) + (b?.auto ?? 0) * t,
    min: 2 ** mix((l) => Math.log2(l.min)),
    max: 2 ** mix((l) => Math.log2(l.max)),
    brighten: mix((l) => l.brighten),
    darken: mix((l) => l.darken),
    center: mix((l) => l.center),
    compensation: mix((l) => l.compensation),
  };
}

/**
 * The exposures the view may take: the look's bounds, pulled toward the
 * environment's fixed exposure as its `auto` falls (in stops; a look of
 * weight 0, or none, is the fixed exposure alone).
 */
export function exposureRange(look: ExposureLook | null, fixed: number): [number, number] {
  const f = Math.max(POSITIVE, fixed);
  if (look === null || !(look.auto > 0)) return [f, f];
  const a = Math.min(1, look.auto);
  const lf = Math.log2(f);
  const lo = 2 ** (lf + (Math.log2(look.min) - lf) * a);
  const hi = 2 ** (lf + (Math.log2(look.max) - lf) * a);
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

/**
 * A metering texel's weight: 1 everywhere for the frame's average, a
 * Gaussian round the middle for centre-weighted, blended by `center`.
 * `u`, `v`: the texel's centre, 0–1 across and up the frame.
 */
export function meterWeight(u: number, v: number, center: number): number {
  const x = (u - 0.5) * 2;
  const y = (v - 0.5) * 2;
  const g = Math.exp(-(x * x + y * y) / (2 * CENTER_WEIGHT_SIGMA * CENTER_WEIGHT_SIGMA));
  return 1 + (g - 1) * Math.min(1, Math.max(0, center));
}

/**
 * The weighted log2-average luminance of a metered grid: `logs` holds each
 * texel's mean log2 luminance, `stride` floats per texel (the first one
 * read), `width` × `height` texels row by row. Non-finite texels are left
 * out; null when none is left.
 */
export function meteredLogLuminance(logs: ArrayLike<number>, width: number, height: number, center: number, stride = 1): number | null {
  let sum = 0;
  let weights = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const l = logs[(y * width + x) * stride]!;
      if (!Number.isFinite(l)) continue;
      const w = meterWeight((x + 0.5) / width, (y + 0.5) / height, center);
      sum += l * w;
      weights += w;
    }
  }
  return weights > 0 ? sum / weights : null;
}

/** The exposure that puts a metered log2 luminance on middle grey, `compensation` stops over it (not yet bounded). */
export function targetExposure(logLuminance: number, compensation: number): number {
  return EXPOSURE_KEY * 2 ** (compensation - logLuminance);
}

/**
 * The exposure after `dt` seconds of adaptation from `current` toward
 * `target`, both bounded to `[lo, hi]` first: the gap in stops closes by
 * `1 − e^(−rate·dt)`, at `brighten` while the exposure rises and `darken`
 * while it falls — frame-rate independent, and settled to 95 % in about
 * 3 / rate seconds. A range that moved (a blend) holds the result inside it.
 */
export function adaptExposure(current: number, target: number, lo: number, hi: number, brighten: number, darken: number, dt: number): number {
  const clamp = (v: number): number => Math.min(hi, Math.max(lo, v));
  const from = Math.log2(clamp(Math.max(POSITIVE, current)));
  const to = Math.log2(clamp(Math.max(POSITIVE, target)));
  const rate = to > from ? brighten : darken;
  const k = 1 - Math.exp(-Math.max(0, rate) * Math.max(0, dt));
  return clamp(2 ** (from + (to - from) * k));
}
