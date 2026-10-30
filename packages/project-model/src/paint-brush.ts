/**
 * The paint brush — radius, strength, falloff and the target
 * channel — as its own module, so every paint target uses the same brush: a
 * block layer's paint and wetness (`block-paint.ts`, `block-wall-paint.ts`),
 * mesh vertex colours (`vertex-paint-stroke.ts`) and a terrain's hand paint
 * (`terrain-edit.ts`).
 *
 * A target is a set of points, each holding `channels` bytes (0–255). The
 * first `weights` channels are layer weights that always sum to 255 (painting
 * one moves weight from the others onto it; erasing one gives its weight back
 * to the others); any further channel stands alone (wetness: painting raises
 * it toward 255, erasing lowers it toward 0). A dab changes every point
 * within the radius by `strength × falloff(distance)` of the way to its
 * target — times the noise mask there, when the stroke has one.
 *
 * A stroke may carry an opacity: the most of the way to the target one
 * stroke takes a point, however many dabs cross it (strength is the flow of
 * one dab). The stroke keeps, per point, how far its dabs have taken it
 * (`StrokeCoverage`) and shortens each dab so that never passes the opacity;
 * a point's value after the stroke is its value before blended toward the
 * target by that coverage, as one dab of that amount would.
 *
 * Squared distances only, no trigonometry, results rounded to bytes: the
 * same dabs give the same bytes in every JavaScript engine (the editor's
 * preview and the backend's edit agree).
 */
import { fractalNoise01 } from '@thirdlight/shared';

export type BrushFalloff = 'smooth' | 'linear' | 'constant' | 'curve';
export const BRUSH_FALLOFFS: readonly BrushFalloff[] = ['smooth', 'linear', 'constant', 'curve'];

/** The brush's size (in the target's units, e.g. cells) and strength (the blend per dab at the centre, 0–1). */
export const PAINT_BRUSH_LIMITS = Object.freeze({ radiusMin: 0.25, radiusMax: 64, strengthMax: 1 });

export interface PaintBrush {
  /** In the target's units (a block layer: cells). */
  radius: number;
  /** How far toward the target one dab goes at the centre (0–1]. */
  strength: number;
  /** smooth: (1 − d²/r²)², linear: 1 − d/r, constant: 1 inside the radius, curve: full to `hardness`, then smooth. */
  falloff: BrushFalloff;
  /** curve: the share of the radius at full strength (absent: `BRUSH_HARDNESS_DEFAULT`). */
  hardness?: number;
  /** The channel painted (a weight channel or a standalone one). */
  channel: number;
  /** Take the channel away instead of adding it. */
  erase?: boolean;
}

/** How a target's point bytes are laid out: `channels` per point, the first `weights` of them summing to 255. */
export interface PaintLayout {
  channels: number;
  weights: number;
  /** The weight channel an unpainted point is all of: erasing the only weight gives it back there (absent: the first). */
  rest?: number;
}

/** A curve falloff's hardness when none is given. */
export const BRUSH_HARDNESS_DEFAULT = 0.5;

/**
 * The falloff at squared distance `d2` from the centre of a brush of radius
 * `r` (0 outside). `linear` and `curve` need the distance itself (a square
 * root, exact in IEEE arithmetic, so still engine-independent). `curve` is
 * full strength out to `hardness` of the radius, then the smooth falloff
 * over the rest.
 */
export function brushFalloff(d2: number, r: number, falloff: BrushFalloff, hardness: number = BRUSH_HARDNESS_DEFAULT): number {
  const r2 = r * r;
  if (!(d2 <= r2) || r <= 0) return 0;
  if (falloff === 'constant') return 1;
  if (falloff === 'linear') return 1 - Math.sqrt(d2) / r;
  if (falloff === 'curve') {
    const d = Math.sqrt(d2) / r;
    if (d <= hardness) return 1;
    const t = (d - hardness) / (1 - hardness);
    const k = 1 - t * t;
    return k * k;
  }
  const k = 1 - d2 / r2;
  return k * k;
}

/** The share of the radius at which a falloff drops to half strength (the brush cursor's inner ring). */
export function brushHalfRadius(falloff: BrushFalloff, hardness: number = BRUSH_HARDNESS_DEFAULT): number {
  // (1 − t²)² = ½ at t² = 1 − √½.
  const smooth = Math.sqrt(1 - Math.SQRT1_2);
  if (falloff === 'constant') return 1;
  if (falloff === 'linear') return 0.5;
  if (falloff === 'curve') return hardness + (1 - hardness) * smooth;
  return smooth;
}

/**
 * A stroke's noise mask: world-anchored fractal value noise (`value-noise.ts`)
 * a dab's weight is multiplied by at each point. Anchored to the target's
 * frame, not to the brush, so tiles, chunks and repeated strokes meet without
 * a seam.
 */
export interface BrushMask {
  /** Metres one lattice cell of the first octave spans. */
  scale: number;
  /** How sharply the noise turns from 0 to 1 around the threshold (1: as it is). */
  contrast: number;
  /** The noise value (0–1) that maps to half weight: higher leaves more unpainted. */
  threshold: number;
  /** Layers of detail (1–5). */
  octaves: number;
  /** Another seed, another pattern (a whole number). */
  seed: number;
}

export const BRUSH_MASK_LIMITS = Object.freeze({ scaleMin: 0.05, scaleMax: 10_000, contrastMax: 16, octavesMax: 5, seedMax: 2_147_483_647 });

/** The mask's weight (0–1) at (x, z) — and height y on a target that is not flat — in the target's metres. */
export function brushMask(m: BrushMask, x: number, z: number, y = 0): number {
  const v = fractalNoise01(x / m.scale, z / m.scale, m.octaves, m.seed, y / m.scale);
  return Math.max(0, Math.min(1, (v - m.threshold) * m.contrast + 0.5));
}

/**
 * How far one stroke has taken each point toward its target, capped at the
 * stroke's opacity. `take` turns a dab's weight at a point into the amount
 * to blend now: the coverage grows as repeated blends compound
 * (c' = c + (1 − c)·a), never past the opacity, and the blend applied is the
 * share of what is left that reaches c' ((c' − c) / (1 − c)).
 */
export class StrokeCoverage {
  private readonly covered = new Map<number | string, number>();

  constructor(readonly opacity: number) {}

  take(key: number | string, weight: number): number {
    if (!(weight > 0)) return 0;
    const c = this.covered.get(key) ?? 0;
    if (c >= this.opacity) return 0;
    const next = Math.min(this.opacity, c + (1 - c) * Math.min(1, weight));
    this.covered.set(key, next);
    return next >= 1 ? 1 : (next - c) / (1 - c);
  }
}

/** A point of a whole-number lattice (a terrain's samples, a block layer's vertices) as a coverage key (coordinates within ±2²⁵). */
export const latticeKey = (x: number, z: number): number => (x + 0x2000000) * 0x4000000 + (z + 0x2000000);

/**
 * What one stroke brings to each of its dabs besides the brush: the mask
 * and the coverage holding its opacity (one per target the stroke paints).
 */
export interface DabStroke {
  mask?: BrushMask;
  coverage: StrokeCoverage | null;
}

/** A stroke's coverage for `opacity` (null without a ceiling: absent or 1, every dab blends in full). */
export function strokeCoverage(opacity: number | undefined): StrokeCoverage | null {
  return opacity === undefined || opacity >= 1 ? null : new StrokeCoverage(opacity);
}

/**
 * The amount one dab blends at a point: its weight (strength × falloff),
 * times the mask at (x, z) — and y on a target that is not flat — then held
 * under the stroke's opacity by `coverage` (`key`: the point's id in it).
 * Without a mask or a ceiling it is the weight itself.
 */
export function strokeAmount(weight: number, mask: BrushMask | undefined, coverage: StrokeCoverage | null, key: number | string, x: number, z: number, y = 0): number {
  let a = weight;
  if (mask !== undefined && a > 0) a *= brushMask(mask, x, z, y);
  return coverage === null ? a : coverage.take(key, a);
}

/** What a stroke adds to its brush: the opacity ceiling, the noise mask and a curve falloff's hardness (each optional). */
export interface BrushStrokeOptions {
  /** The most of the way to the target one stroke takes a point (0, 1]; absent: no ceiling. */
  opacity?: number;
  mask?: BrushMask;
  hardness?: number;
}

/** The keys of `BrushStrokeOptions` (a command's arguments add them). */
export const BRUSH_STROKE_KEYS: readonly string[] = ['opacity', 'mask', 'hardness'];

const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Whether a stroke's options are within the limits (a message naming the field, or null). Absent fields are fine. */
export function brushStrokeError(b: { opacity?: unknown; mask?: unknown; hardness?: unknown }): { field: string; message: string } | null {
  const o = b.opacity;
  if (o !== undefined && (!finiteNum(o) || o <= 0 || o > 1)) return { field: 'opacity', message: 'opacity is in (0, 1] (the most of the way to the target one stroke takes a point)' };
  const h = b.hardness;
  if (h !== undefined && (!finiteNum(h) || h < 0 || h > 0.95)) return { field: 'hardness', message: 'hardness is 0-0.95 (the share of the radius a curve falloff keeps at full strength)' };
  const m = b.mask;
  if (m === undefined) return null;
  const L = BRUSH_MASK_LIMITS;
  const shape = 'mask is {scale, contrast, threshold, octaves, seed}';
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return { field: 'mask', message: shape };
  const r = m as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['scale', 'contrast', 'threshold', 'octaves', 'seed'].includes(k)) return { field: `mask/${k}`, message: `unknown mask field "${k}" (${shape})` };
  if (!finiteNum(r['scale']) || r['scale'] < L.scaleMin || r['scale'] > L.scaleMax) return { field: 'mask/scale', message: `scale is ${L.scaleMin}-${L.scaleMax} m (the size of the noise's first octave)` };
  if (!finiteNum(r['contrast']) || r['contrast'] < 0 || r['contrast'] > L.contrastMax) return { field: 'mask/contrast', message: `contrast is 0-${L.contrastMax}` };
  if (!finiteNum(r['threshold']) || r['threshold'] < 0 || r['threshold'] > 1) return { field: 'mask/threshold', message: 'threshold is 0-1' };
  if (!Number.isInteger(r['octaves']) || (r['octaves'] as number) < 1 || (r['octaves'] as number) > L.octavesMax) return { field: 'mask/octaves', message: `octaves is 1-${L.octavesMax}` };
  if (!Number.isInteger(r['seed']) || Math.abs(r['seed'] as number) > L.seedMax) return { field: 'mask/seed', message: 'seed is a whole number' };
  return null;
}

/** A stroke's options picked from validated args (absent ones left out). */
export function brushStrokeOptions(args: { opacity?: unknown; mask?: unknown; hardness?: unknown }): BrushStrokeOptions {
  return { ...(args.opacity !== undefined ? { opacity: args.opacity as number } : {}), ...(args.mask !== undefined ? { mask: args.mask as BrushMask } : {}), ...(args.hardness !== undefined ? { hardness: args.hardness as number } : {}) };
}

/**
 * Paint one point (`values[offset …]`) by `amount` (0–1: strength × falloff).
 * Returns whether any byte changed.
 */
export function paintPoint(values: Uint8Array, offset: number, layout: PaintLayout, brush: Pick<PaintBrush, 'channel' | 'erase'>, amount: number): boolean {
  const t = Math.max(0, Math.min(1, amount));
  if (t === 0) return false;
  const c = brush.channel;
  if (c >= layout.weights) {
    const v = values[offset + c]!;
    const next = Math.round(brush.erase === true ? v * (1 - t) : v + (255 - v) * t);
    if (next === v) return false;
    values[offset + c] = next;
    return true;
  }
  const n = layout.weights;
  const before: number[] = [];
  for (let k = 0; k < n; k++) before.push(values[offset + k]!);
  const want: number[] = new Array<number>(n).fill(0);
  if (brush.erase !== true) {
    // Toward all weight on channel c.
    for (let k = 0; k < n; k++) want[k] = before[k]! + ((k === c ? 255 : 0) - before[k]!) * t;
  } else {
    // Channel c gives the part it loses to the others, in proportion to theirs (all zero: to the unpainted one, else the first other).
    const lost = before[c]! * t;
    const others = before.reduce((s, v, k) => (k === c ? s : s + v), 0);
    const rest = layout.rest ?? 0;
    const fallback = c === rest ? (rest === 0 ? 1 : 0) : rest;
    for (let k = 0; k < n; k++) {
      if (k === c) want[k] = before[k]! - lost;
      else want[k] = before[k]! + (others > 0 ? (lost * before[k]!) / others : k === fallback ? lost : 0);
    }
  }
  // Bytes that still sum to 255: rounding's remainder goes to the painted channel (erasing: to the largest other).
  const out = want.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  const rest = 255 - out.reduce((s, v) => s + v, 0);
  if (rest !== 0) {
    let fix = c;
    if (brush.erase === true) {
      fix = c === 0 ? 1 : 0;
      for (let k = 0; k < n; k++) if (k !== c && out[k]! > out[fix]!) fix = k;
    }
    out[fix] = Math.max(0, Math.min(255, out[fix]! + rest));
  }
  let changed = false;
  for (let k = 0; k < n; k++) {
    if (out[k] !== before[k]) changed = true;
    values[offset + k] = out[k]!;
  }
  return changed;
}

/** Whether a brush is within the limits (a message naming the field, or null). */
export function paintBrushError(b: { radius?: unknown; strength?: unknown; falloff?: unknown }): { field: string; message: string } | null {
  const r = b.radius;
  if (typeof r !== 'number' || !Number.isFinite(r) || r < PAINT_BRUSH_LIMITS.radiusMin || r > PAINT_BRUSH_LIMITS.radiusMax) return { field: 'radius', message: `radius is ${PAINT_BRUSH_LIMITS.radiusMin}-${PAINT_BRUSH_LIMITS.radiusMax}` };
  const s = b.strength;
  if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0 || s > PAINT_BRUSH_LIMITS.strengthMax) return { field: 'strength', message: 'strength is in (0, 1] (the blend toward the target per dab at the centre)' };
  if (b.falloff !== undefined && !BRUSH_FALLOFFS.includes(b.falloff as BrushFalloff)) return { field: 'falloff', message: `falloff is ${BRUSH_FALLOFFS.join(', ')}` };
  return null;
}
