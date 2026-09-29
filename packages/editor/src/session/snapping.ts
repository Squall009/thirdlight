/**
 * Local gesture snapping (local preview only).
 *
 * Snapping is a **local preview option**, never a second authority: it is
 * applied to the local preview transform only, it changes no server message,
 * it adds no command, and nothing about it is observable to another client
 * before the single release commit.
 *
 * The increments are editor settings (Edit → Snapping
 * settings…), remembered per project in this browser (`localStorage`); they
 * are editor preferences, not project data, so they never reach the game,
 * its build id or other users. The defaults are the contract's constants
 * below, and `getSnapSettings()` is what the gizmo, drops, handles and the
 * gesture maths read.
 *
 * The default increments/spaces/rounding (the tests pin their exact values):
 *
 *  - translate: `SNAP_TRANSLATE_M = 0.25` independently per **world axis**;
 *    the gesture **delta** is snapped, not the absolute position, so repeated
 *    moves do not accumulate drift;
 *  - rotate: `SNAP_ROTATE_DEG = 15°` about the gizmo axis; the accumulated
 *    gesture angle is snapped and the quaternion is rebuilt from the snapped
 *    angle and re-normalized;
 *  - scale: `SNAP_SCALE = 0.25` on the uniform scale factor, clamped to
 *    `[SCALE_MIN 0.01, SCALE_MAX 100]` (never zero/negative/non-finite);
 *  - rounding: `snapped = clamp(round(value / increment) * increment)` with
 *    round-half-away-from-zero, then quantized to `1e-4`;
 *  - no parent-space or local-space snapping.
 *
 * Pure: no DOM, no I/O, no Node builtins.
 */

/** The fixed translate increment in metres (world axes). */
export const SNAP_TRANSLATE_M = 0.25;
/** The fixed rotate increment in degrees (about the gizmo axis). */
export const SNAP_ROTATE_DEG = 15;
/** The fixed uniform scale-factor increment. */
export const SNAP_SCALE = 0.25;
/** The project model's scale bounds (a snap never produces a zero scale). */
export const SCALE_MIN = 0.01;
export const SCALE_MAX = 100;
/** The committed/displayed quantum. */
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
 * moves drift-free.
 */
export function snapTranslateDelta(delta: readonly number[]): number[] {
  return delta.map((d) => snapValue(d, current.translateM));
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
 * the quaternion from the snapped angle and re-normalize it.
 * The snapped angle is quantized to `1e-4` (radians) so the committed value is
 * the displayed value.
 */
export function snapRotationAngle(angleRad: number, axis: readonly number[]): SnappedRotation {
  const snappedAngle = snapValue(angleRad, (current.rotateDeg * Math.PI) / 180);
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
  return clampScale(snapValue(factor, current.scale));
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
 * the tests can verify it mechanically.
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

// ---- The snapping settings ----------------------------------------------------

/** The editor's snapping settings (per project, in this browser). */
export interface SnapSettings {
  /** Translate step in metres (world axes). */
  translateM: number;
  /** Rotate step in degrees. */
  rotateDeg: number;
  /** Uniform scale-factor step. */
  scale: number;
  /** Moved and dropped objects land on the top of the block-layer cells under them. */
  cellTops: boolean;
}

/** The defaults: the contract's constants; cell-top snapping off (an object keeps the height it is moved to). */
export const DEFAULT_SNAP_SETTINGS: Readonly<SnapSettings> = Object.freeze({ translateM: SNAP_TRANSLATE_M, rotateDeg: SNAP_ROTATE_DEG, scale: SNAP_SCALE, cellTops: false });

/** The accepted ranges (a millimetre to 100 m, a tenth of a degree to 180°, 0.001 to 10). */
export const SNAP_SETTING_RANGES = Object.freeze({ translateM: [0.001, 100], rotateDeg: [0.1, 180], scale: [0.001, 10] } as const);

/** A reason the value is refused (null: fine). */
export function snapSettingError(key: 'translateM' | 'rotateDeg' | 'scale', value: number): string | null {
  const [lo, hi] = SNAP_SETTING_RANGES[key];
  if (!Number.isFinite(value) || value < lo || value > hi) return `${key === 'translateM' ? 'Move step' : key === 'rotateDeg' ? 'Rotate step' : 'Scale step'} is ${lo}–${hi}`;
  return null;
}

/** Settings read back from storage (anything malformed falls back to its default). */
export function sanitizeSnapSettings(v: unknown): SnapSettings {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const num = (k: 'translateM' | 'rotateDeg' | 'scale'): number => (typeof o[k] === 'number' && snapSettingError(k, o[k] as number) === null ? (o[k] as number) : DEFAULT_SNAP_SETTINGS[k]);
  return { translateM: num('translateM'), rotateDeg: num('rotateDeg'), scale: num('scale'), cellTops: o['cellTops'] === true };
}

let current: SnapSettings = { ...DEFAULT_SNAP_SETTINGS };

/** The settings in force (the gizmo, drops, handles and gesture maths read them). */
export function getSnapSettings(): Readonly<SnapSettings> {
  return current;
}

export function setSnapSettings(s: SnapSettings): void {
  current = sanitizeSnapSettings(s);
}

export function snapStorageKey(projectId: string): string {
  return `thirdlight.snapping.${projectId}`;
}

/** Load a project's settings from storage into force (none stored: the defaults). */
export function loadSnapSettings(storage: Pick<Storage, 'getItem'> | null, projectId: string): SnapSettings {
  let raw: unknown = null;
  try {
    const text = storage?.getItem(snapStorageKey(projectId)) ?? null;
    raw = text !== null ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  setSnapSettings(sanitizeSnapSettings(raw));
  return { ...current };
}

/** Put settings in force and remember them for the project. */
export function saveSnapSettings(storage: Pick<Storage, 'setItem'> | null, projectId: string, s: SnapSettings): SnapSettings {
  setSnapSettings(s);
  try {
    storage?.setItem(snapStorageKey(projectId), JSON.stringify(current));
  } catch {
    // no storage: the settings last for this page
  }
  return { ...current };
}
