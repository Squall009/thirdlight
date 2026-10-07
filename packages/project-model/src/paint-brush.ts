/**
 * The paint brush — radius, strength, falloff and the target
 * channel — as its own module, so every paint target uses the same brush: a
 * block layer's paint and wetness today (`block-paint.ts`), mesh vertex
 * colours later.
 *
 * A target is a set of points, each holding `channels` bytes (0–255). The
 * first `weights` channels are layer weights that always sum to 255 (painting
 * one moves weight from the others onto it; erasing one gives its weight back
 * to the others); any further channel stands alone (wetness: painting raises
 * it toward 255, erasing lowers it toward 0). A dab changes every point
 * within the radius by `strength × falloff(distance)` of the way to its
 * target.
 *
 * Squared distances only, no trigonometry, results rounded to bytes: the
 * same dabs give the same bytes in every JavaScript engine (the editor's
 * preview and the backend's edit agree).
 */

export type BrushFalloff = 'smooth' | 'linear' | 'constant';
export const BRUSH_FALLOFFS: readonly BrushFalloff[] = ['smooth', 'linear', 'constant'];

/** The brush's size (in the target's units, e.g. cells) and strength (the blend per dab at the centre, 0–1). */
export const PAINT_BRUSH_LIMITS = Object.freeze({ radiusMin: 0.25, radiusMax: 64, strengthMax: 1 });

export interface PaintBrush {
  /** In the target's units (a block layer: cells). */
  radius: number;
  /** How far toward the target one dab goes at the centre (0–1]. */
  strength: number;
  /** smooth: (1 − d²/r²)², linear: 1 − d/r, constant: 1 inside the radius. */
  falloff: BrushFalloff;
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

/**
 * The falloff at squared distance `d2` from the centre of a brush of radius
 * `r` (0 outside). `linear` needs the distance itself (a square root, exact
 * in IEEE arithmetic, so still engine-independent).
 */
export function brushFalloff(d2: number, r: number, falloff: BrushFalloff): number {
  const r2 = r * r;
  if (!(d2 <= r2) || r <= 0) return 0;
  if (falloff === 'constant') return 1;
  if (falloff === 'linear') return 1 - Math.sqrt(d2) / r;
  const k = 1 - d2 / r2;
  return k * k;
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
