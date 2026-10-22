/**
 * See-through: what stands between the camera and a subject (the player, a
 * unit) thins to a dither in a soft circle round the subject, so rooms,
 * doorways and paths behind walls stay readable. A camera-level rendering
 * feature on every kind of drawn object; objects opt out with
 * `seeThrough: false`.
 *
 * A pixel fades for a subject when it is inside the subject's circle, nearer
 * the camera than the subject by more than the depth margin, and higher than
 * half the subject's height above its feet: floors and anything low round
 * the subject never fade, on any storey. It fades as the largest over the
 * subjects, never past `maxFade` (a dither, never gone).
 *
 * Pure data: the settings, their defaults and limits, and the fixed number
 * of subjects one view draws.
 */

/**
 * Subjects one view fades round at once: the size of the renderer's subject
 * arrays (a GPU array is a fixed size), not a content cap. Asking for more
 * keeps the nearest to the camera.
 */
export const SEE_THROUGH_SUBJECTS = 4;

/** Seconds a subject's fade takes to ease in or out (a subject appearing, leaving, or the feature turned on). */
export const SEE_THROUGH_FADE_SECONDS = 0.25;

export interface SeeThroughSettings {
  /** Fade round the subjects (off: the materials build without the mask, at no cost). */
  enabled: boolean;
  /** The circle's radius as a share of the view's height (never less than covers the subject's body). */
  radius: number;
  /** The share of the radius over which the circle's edge softens (0: a hard edge). */
  softness: number;
  /** How far a pixel fades at most (0 … below 1: a dither, never fully gone). */
  maxFade: number;
  /** Metres a pixel must be nearer the camera than the subject to fade. */
  depthMargin: number;
  /** Seconds a subject's fade eases in or out. */
  fadeTime: number;
}

/** The settings a project starts with: off; a circle of radius a fifth of the view's height, soft over 40 % of it, thinning to a 75 % dither. */
export const SEE_THROUGH_DEFAULTS: Readonly<SeeThroughSettings> = Object.freeze({
  enabled: false,
  radius: 0.2,
  softness: 0.4,
  maxFade: 0.75,
  depthMargin: 0.25,
  fadeTime: SEE_THROUGH_FADE_SECONDS,
});

/** The range of each number (max fade stays below 1: what is in front never vanishes). */
export const SEE_THROUGH_LIMITS = Object.freeze({
  radius: Object.freeze({ min: 0, max: 1 }),
  softness: Object.freeze({ min: 0, max: 1 }),
  maxFade: Object.freeze({ min: 0, max: 0.95 }),
  depthMargin: Object.freeze({ min: 0, max: 100 }),
  fadeTime: Object.freeze({ min: 0, max: 10 }),
});

/** `base` with the valid fields of `patch` over it (numbers clamped to their limits; anything else ignored). */
export function seeThroughSettingsOf(patch: unknown, base: Readonly<SeeThroughSettings> = SEE_THROUGH_DEFAULTS): SeeThroughSettings {
  const out: SeeThroughSettings = { ...base };
  if (patch === null || typeof patch !== 'object') return out;
  const p = patch as Record<string, unknown>;
  if (typeof p['enabled'] === 'boolean') out.enabled = p['enabled'];
  for (const k of ['radius', 'softness', 'maxFade', 'depthMargin', 'fadeTime'] as const) {
    const v = p[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = Math.min(SEE_THROUGH_LIMITS[k].max, Math.max(SEE_THROUGH_LIMITS[k].min, v));
  }
  return out;
}
