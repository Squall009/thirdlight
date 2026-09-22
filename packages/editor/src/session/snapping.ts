/**
 * Local gesture snapping (sessions.md §9, "Snapping (M2, local preview only;
 * normative)"; packet 27).
 *
 * Snapping is a **local preview option**, never a second authority: it is
 * applied to the local preview transform only, it changes no server message,
 * it adds no command, and nothing about it is observable to another client
 * before the single release commit. There is no persistent snapping setting —
 * no project field, no backend configuration, no `localStorage` write
 * (sessions.md §9).
 *
 * The increments/spaces/rounding below are the contract's fixed M2 constants
 * (acceptance A08 and the packet-27 tests reference their exact values):
 *
 *  - translate: `SNAP_TRANSLATE_M = 0.25` independently per **world axis**;
 *    the gesture **delta** is snapped, not the absolute position, so repeated
 *    moves do not accumulate drift;
 *  - rotate: `SNAP_ROTATE_DEG = 15°` about the gizmo axis; the accumulated
 *    gesture angle is snapped and the quaternion is rebuilt from the snapped
 *    angle and re-normalized (project-model §12.2);
 *  - scale: `SNAP_SCALE = 0.25` on the uniform scale factor, clamped to
 *    `[SCALE_MIN 0.01, SCALE_MAX 100]` (never zero/negative/non-finite);
 *  - rounding: `snapped = clamp(round(value / increment) * increment)` with
 *    round-half-away-from-zero, then quantized to `1e-4`;
 *  - no parent-space or local-space snapping in M2.
 *
 * Pure: no DOM, no I/O, no Node builtins.
 */

/** sessions.md §9: the fixed translate increment in metres (world axes). */
export const SNAP_TRANSLATE_M = 0.25;
/** sessions.md §9: the fixed rotate increment in degrees (about the gizmo axis). */
export const SNAP_ROTATE_DEG = 15;
/** sessions.md §9: the fixed uniform scale-factor increment. */
export const SNAP_SCALE = 0.25;
/** project-model §10.1 scale bounds (a snap never produces a zero scale). */
export const SCALE_MIN = 0.01;
export const SCALE_MAX = 100;
/** sessions.md §9: the committed/displayed quantum. */
export const SNAP_QUANTUM = 1e-4;

/** `SNAP_ROTATE_DEG` in radians (three.js/`project-model` quaternion axis-angle). */
export const SNAP_ROTATE_RAD = (SNAP_ROTATE_DEG * Math.PI) / 180;

/** Round half **away from zero** (the contract's rounding rule). */
export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value >= 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
}

/** Quantize to the contract's `1e-4` grid (half away from zero; `-0` → `0`). */
export function quantize(value: number, quantum: number = SNAP_QUANTUM): number {
  if (!Number.isFinite(value) || !Number.isFinite(quantum) || quantum <= 0) return 0;
  const steps = roundHalfAwayFromZero(value / quantum);
  // `Number(x.toPrecision(15))` removes the binary multiplication drift so the
  // committed/displayed value is the canonical grid value (e.g. 0.2618).
  const snapped = Number((steps * quantum).toPrecision(15));
  return snapped === 0 ? 0 : snapped;
}

/**
 * `snapped = quantize(roundHalfAwayFromZero(value / increment) * increment)`.
 * A non-finite value or a non-positive increment yields the quantized input.
 */
export function snapValue(value: number, increment: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(increment) || increment <= 0) return quantize(value);
  return quantize(roundHalfAwayFromZero(value / increment) * increment);
}

/**
 * Translate: snap a **world-axis** gesture delta (metres) independently per
 * axis. Snapping the delta (not the absolute position) is what keeps repeated
 * moves drift-free (sessions.md §9).
 */
export function snapTranslateDelta(delta: readonly number[]): number[] {
  return delta.map((d) => snapValue(d, SNAP_TRANSLATE_M));
}

/** Normalize an axis to unit length; a zero/non-finite axis falls back to +Y. */
export function normalizeAxis(axis: readonly number[]): [number, number, number] {
  const [x = 0, y = 0, z = 0] = axis;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length === 0) return [0, 1, 0];
  return [x / length, y / length, z / length];
}

export interface SnappedRotation {
  /** The snapped accumulated angle in radians (about `axis`). */
  angleRad: number;
  /** The rebuilt, re-normalized unit quaternion `[x, y, z, w]`. */
  quaternion: [number, number, number, number];
}

/**
 * Rotate: snap the accumulated gesture angle about the gizmo axis, then rebuild
 * the quaternion from the snapped angle and re-normalize it (sessions.md §9).
 * The snapped angle is quantized to `1e-4` (radians) so the committed value is
 * the displayed value.
 */
export function snapRotationAngle(angleRad: number, axis: readonly number[]): SnappedRotation {
  const snappedAngle = snapValue(angleRad, SNAP_ROTATE_RAD);
  const [ax, ay, az] = normalizeAxis(axis);
  const half = snappedAngle / 2;
  const s = Math.sin(half);
  const w = Math.cos(half);
  const q: [number, number, number, number] = [ax * s, ay * s, az * s, w];
  const norm = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return {
    angleRad: snappedAngle,
    quaternion: [q[0] / norm, q[1] / norm, q[2] / norm, q[3] / norm],
  };
}

/** Clamp into `[SCALE_MIN, SCALE_MAX]`, mapping a non-finite input to `SCALE_MIN`. */
export function clampScale(value: number): number {
  if (!Number.isFinite(value)) return SCALE_MIN;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, value));
}

/**
 * Scale: snap the **uniform scale factor** to the `0.25` grid, then clamp to
 * `[0.01, 100]` — a snap never produces a zero, negative or non-finite factor.
 */
export function snapScaleFactor(factor: number): number {
  return clampScale(snapValue(factor, SNAP_SCALE));
}

/**
 * Apply a snapped uniform factor to an entity's base scale vector: each axis is
 * the quantized `base * factor`, clamped per axis (the entity's uniform scale,
 * no parent/local-space math).
 */
export function snapScaleFromBase(base: readonly number[], factor: number): number[] {
  const snapped = snapScaleFactor(factor);
  return base.map((b) => clampScale(quantize((Number.isFinite(b) ? b : 1) * snapped)));
}

/**
 * Whether snapping is active for the current gesture: enabled locally, except
 * while `Shift` is held — that disables snapping for **that gesture only**
 * (local UI state; no persistent setting).
 */
export function snapActive(enabled: boolean, shiftKey: boolean): boolean {
  return enabled && !shiftKey;
}

/** The three snapping kinds (mirrors the gizmo modes). */
export type SnapKind = 'translate' | 'rotate' | 'scale';

/**
 * One raw (unsnapped) gesture delta, exactly as the gizmo produces it. The
 * snapping decision is pure: the same input always yields the same preview.
 */
export type RawGesture =
  | { kind: 'translate'; delta: readonly number[] }
  | { kind: 'rotate'; axis: readonly number[]; angleRad: number }
  | { kind: 'scale'; factor: number };

/**
 * The snapped gesture delta for a kind, or `null` when snapping is inactive
 * (the caller then keeps the raw value — the local preview only).
 */
export function snapGesture(raw: RawGesture, active: boolean): RawGesture | null {
  if (!active) return null;
  switch (raw.kind) {
    case 'translate':
      return { kind: 'translate', delta: snapTranslateDelta(raw.delta) };
    case 'rotate':
      return { kind: 'rotate', axis: normalizeAxis(raw.axis), angleRad: snapRotationAngle(raw.angleRad, raw.axis).angleRad };
    case 'scale':
      return { kind: 'scale', factor: snapScaleFactor(raw.factor) };
  }
}

/**
 * The snapping increment table exactly as the contract fixes it — exported so
 * the packet evidence can verify it mechanically against sessions.md §9.
 */
export const SNAP_INCREMENTS = {
  translateM: SNAP_TRANSLATE_M,
  rotateDeg: SNAP_ROTATE_DEG,
  rotateRad: SNAP_ROTATE_RAD,
  scale: SNAP_SCALE,
  scaleMin: SCALE_MIN,
  scaleMax: SCALE_MAX,
  quantum: SNAP_QUANTUM,
} as const;
