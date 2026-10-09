/**
 * Levels of detail: a model's LOD group settings, the project's LOD bias and
 * hysteresis, and how instance sets thin out with distance (Unity's LOD
 * Group and quality LOD bias, Unreal's foliage cull distances).
 *
 * Sizes are screen sizes: the fraction of the screen height LOD0's bounding
 * sphere covers, measured in a view of {@link LOD_REFERENCE_FOV_DEG}° (so a
 * model switches at the same distance whatever lens a camera has, as before
 * these settings existed). A model's levels are its `<piece>_LOD<n>` nodes.
 *
 * - `lod.screenSizes` (on the model asset's record, its import settings):
 *   below `screenSizes[i]` level i+1 takes over. Absent entries use
 *   {@link LOD_SCREEN_SIZES_DEFAULT}, the engine's sizes before.
 * - `lod.cullSize`: below it the model is not drawn at all (absent: always
 *   drawn, as before). Block layers never cull a model (a chunk is many).
 * - `lod_bias` (project setting, a quality setting): every switch point and
 *   cull size is divided by it, so 2 keeps each level to half the size
 *   (twice the distance).
 * - `lod_hysteresis` (project setting): a level switches back to the finer
 *   one only that fraction closer than where it switched, so a model standing
 *   at a switch point does not flicker between levels.
 * - Instance sets draw fewer copies where they are small on screen: from
 *   `densityStart` down to `densityEnd` (screen sizes) the share drawn falls
 *   to `densityMin`, linearly with distance; each copy keeps its own place in
 *   the order, so thinning never swaps which copies show.
 */

import type { ModelErrorV2 } from './errors';
import { fieldType, fieldValue, isPlainObject, unexpectedField } from './validate';

/**
 * The screen sizes where levels 1, 2, 3, 4 take over (8 %, 3 %, 1.2 %,
 * 0.5 % of the screen height); a model with more levels switches its later
 * ones at the last. They were the engine-wide switch points before models
 * had their own.
 */
export const LOD_SCREEN_SIZES_DEFAULT: readonly number[] = [0.08, 0.03, 0.012, 0.005];
/**
 * The triangle shares of the levels 1, 2, 3 the "generate LODs" import
 * setting makes for a model without authored levels: each half the one
 * before, as the default screen sizes roughly halve from level to level.
 */
export const MESH_LOD_RATIOS_DEFAULT: readonly number[] = [0.5, 0.25, 0.125];
/** The vertical field of view screen sizes are measured in (degrees). */
export const LOD_REFERENCE_FOV_DEG = 50;
/** Most switch points a model's settings may list (levels beyond use the last). */
export const LOD_SCREEN_SIZES_MAX = 8;
/** No culling: a model is drawn however small it is (the default). */
export const LOD_CULL_SIZE_DEFAULT = 0;

/** The project's LOD bias: 1 = the models' own switch points. */
export const LOD_BIAS_DEFAULT = 1;
export const LOD_BIAS_MIN = 0.25;
export const LOD_BIAS_MAX = 4;
/**
 * The project's LOD hysteresis: a tenth. A model standing still at a switch
 * point does not flicker with the camera's sway, and a level shown one step
 * coarser for 10 % of the switch distance is not noticed.
 */
export const LOD_HYSTERESIS_DEFAULT = 0.1;
export const LOD_HYSTERESIS_MAX = 0.5;

/**
 * Instance-set density falloff: full density down to 2 % of the screen
 * height, a quarter of the copies at 0.5 % and smaller. A 0.5 m grass tuft
 * starts thinning at ~27 m and reaches a quarter at ~107 m; a 6 m tree at
 * ~320 m — so near and mid ground look the same and only what is a few
 * pixels across thins. A set that does not set `densityMin` draws every copy
 * (sets made before thinning existed keep their look); new sets are made
 * with {@link INSTANCE_DENSITY_MIN_NEW} written out.
 */
export const INSTANCE_DENSITY_START_DEFAULT = 0.02;
export const INSTANCE_DENSITY_END_DEFAULT = 0.005;
/** The share kept where copies are smallest when a set does not set it: all (no thinning). */
export const INSTANCE_DENSITY_MIN_DEFAULT = 1;
/** The share new instance sets are made with (the scatter dialog writes it into the component). */
export const INSTANCE_DENSITY_MIN_NEW = 0.25;
/** The smallest screen size a density falloff may name (a hundredth of a percent: below a pixel on any screen). */
export const INSTANCE_DENSITY_SIZE_MIN = 0.0001;

/** The largest instance-set chunk size (m). */
export const MAX_INSTANCE_CHUNK_SIZE = 4096;
/**
 * The engine default chunk size (m) of an instance set (the project's
 * `instance_chunk_m`, overridable per set). 32 m: a few seconds' walk for
 * the default 1.8 m character and small next to a typical view distance, so
 * a chunk out of view is culled.
 */
export const INSTANCE_CHUNK_METERS = 32;

/** A model's LOD group settings (its import settings). */
export interface ModelLodSettings {
  /** Below `screenSizes[i]` level i+1 takes over (decreasing, each in (0, 1]). */
  screenSizes?: number[];
  /** Below this screen size the model is not drawn (0: always drawn). */
  cullSize?: number;
}

/** The project's LOD tuning (quality settings). */
export interface LodTuningSettings {
  readonly bias: number;
  readonly hysteresis: number;
}

/** An instance set's density falloff, resolved. */
export interface InstanceDensity {
  readonly start: number;
  readonly end: number;
  readonly min: number;
}

/**
 * The screen size where each level after the first takes over (`levels - 1`
 * entries): the model's own, else the default for that level, kept below
 * the one before it (a model's own list may end above the defaults).
 */
export function lodScreenSizesFor(lod: ModelLodSettings | undefined, levels: number): number[] {
  const out: number[] = [];
  const own = lod?.screenSizes ?? [];
  const defaults = LOD_SCREEN_SIZES_DEFAULT;
  for (let i = 0; i + 1 < levels; i += 1) {
    if (i < own.length) {
      out.push(own[i]!);
      continue;
    }
    const d = defaults[Math.min(i, defaults.length - 1)]!;
    const prev = out[i - 1];
    // Past the model's own list: the default, unless the list already ended below it (then half its last).
    out.push(own.length > 0 && prev !== undefined && prev <= d ? prev / 2 : d);
  }
  return out;
}

/** A model's cull size (0: never culled). */
export function lodCullSizeOf(lod: ModelLodSettings | undefined): number {
  const c = lod?.cullSize;
  return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : LOD_CULL_SIZE_DEFAULT;
}

/** The project's LOD bias and hysteresis (the defaults where unset or out of range). */
export function lodTuningOf(settings: unknown): LodTuningSettings {
  const s = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>) : {};
  const b = s['lod_bias'];
  const h = s['lod_hysteresis'];
  return {
    bias: typeof b === 'number' && Number.isFinite(b) ? Math.min(LOD_BIAS_MAX, Math.max(LOD_BIAS_MIN, b)) : LOD_BIAS_DEFAULT,
    hysteresis: typeof h === 'number' && Number.isFinite(h) ? Math.min(LOD_HYSTERESIS_MAX, Math.max(0, h)) : LOD_HYSTERESIS_DEFAULT,
  };
}

/** An instance set's density falloff from its component (the defaults for what it leaves out). */
export function instanceDensityOf(c: { densityStart?: unknown; densityEnd?: unknown; densityMin?: unknown } | undefined): InstanceDensity {
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const start = num(c?.densityStart, INSTANCE_DENSITY_START_DEFAULT);
  const end = Math.min(start, num(c?.densityEnd, INSTANCE_DENSITY_END_DEFAULT));
  return { start, end, min: Math.min(1, Math.max(0, num(c?.densityMin, INSTANCE_DENSITY_MIN_DEFAULT))) };
}

/** A copy of `lod` without unset parts, or undefined when nothing is set (stored as absence). */
export function canonicalModelLod(lod: ModelLodSettings | undefined): ModelLodSettings | undefined {
  if (lod === undefined) return undefined;
  const out: ModelLodSettings = {};
  if (lod.screenSizes !== undefined && lod.screenSizes.length > 0) out.screenSizes = [...lod.screenSizes];
  if (lod.cullSize !== undefined && lod.cullSize > 0) out.cullSize = lod.cullSize;
  return out.screenSizes === undefined && out.cullSize === undefined ? undefined : out;
}

/** Problems with a `lod` value (empty: valid). `path` is its JSON pointer. */
export function modelLodProblems(v: unknown, path: string): ModelErrorV2[] {
  const errors: ModelErrorV2[] = [];
  if (!isPlainObject(v)) {
    errors.push(fieldType(path, v, 'object {screenSizes?, cullSize?}'));
    return errors;
  }
  for (const k of Object.keys(v)) if (k !== 'screenSizes' && k !== 'cullSize') errors.push(unexpectedField(`${path}/${k}`, k, 'screenSizes, cullSize'));
  const sizes = v['screenSizes'];
  if (sizes !== undefined) {
    if (!Array.isArray(sizes) || sizes.length < 1 || sizes.length > LOD_SCREEN_SIZES_MAX) {
      errors.push(fieldValue(`${path}/screenSizes`, sizes, `an array of 1-${LOD_SCREEN_SIZES_MAX} screen sizes`, 'screenSizes lists where each level after LOD0 takes over'));
    } else {
      sizes.forEach((s, i) => {
        if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0 || s > 1) errors.push(fieldValue(`${path}/screenSizes/${i}`, s, 'a number in (0, 1]', 'a screen size is the fraction of the screen height LOD0 covers'));
        else if (i > 0 && typeof sizes[i - 1] === 'number' && s >= (sizes[i - 1] as number)) errors.push(fieldValue(`${path}/screenSizes/${i}`, s, `less than ${String(sizes[i - 1])}`, 'each level takes over at a smaller size than the one before'));
      });
    }
  }
  const cull = v['cullSize'];
  if (cull !== undefined && (typeof cull !== 'number' || !Number.isFinite(cull) || cull <= 0 || cull >= 1)) {
    errors.push(fieldValue(`${path}/cullSize`, cull, 'a number in (0, 1)', 'cullSize is the screen size below which the model is not drawn (absent: always drawn)'));
  }
  if (sizes === undefined && cull === undefined) errors.push(fieldValue(path, v, 'screenSizes and/or cullSize', 'an empty lod is stored as absence'));
  return errors;
}

/** The record-level `lod` setting: models only. */
export function validateModelLodField(a: Record<string, unknown>, path: string, errors: ModelErrorV2[], isModel: boolean): void {
  const v = a['lod'];
  if (v === undefined) return;
  if (!isModel) {
    errors.push(unexpectedField(`${path}/lod`, 'lod', 'only a model asset has LOD settings'));
    return;
  }
  errors.push(...modelLodProblems(v, `${path}/lod`));
}
