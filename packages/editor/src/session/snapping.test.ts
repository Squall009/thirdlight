import { describe, it, expect } from 'vitest';
import {
  SNAP_INCREMENTS,
  SNAP_QUANTUM,
  SNAP_ROTATE_DEG,
  SNAP_ROTATE_RAD,
  SNAP_SCALE,
  SNAP_TRANSLATE_M,
  SCALE_MAX,
  SCALE_MIN,
  clampScale,
  normalizeAxis,
  quantize,
  roundHalfAwayFromZero,
  snapActive,
  snapGesture,
  snapRotationAngle,
  snapScaleFactor,
  snapScaleFromBase,
  snapTranslateDelta,
  snapValue,
} from './snapping';

/**
 * Packet 27 — sessions.md §9 snapping constants and math. The increment table
 * is asserted mechanically against the contract's fixed values (acceptance A08
 * and the packet-27 tests reference their exact values).
 */
describe('snapping — the contract increment table (sessions.md §9)', () => {
  it('fixes the exact approved constants', () => {
    expect(SNAP_TRANSLATE_M).toBe(0.25);
    expect(SNAP_ROTATE_DEG).toBe(15);
    expect(SNAP_SCALE).toBe(0.25);
    expect(SCALE_MIN).toBe(0.01);
    expect(SCALE_MAX).toBe(100);
    expect(SNAP_QUANTUM).toBe(1e-4);
    expect(SNAP_ROTATE_RAD).toBeCloseTo((15 * Math.PI) / 180, 15);
    expect(SNAP_INCREMENTS).toEqual({
      translateM: 0.25,
      rotateDeg: 15,
      rotateRad: (15 * Math.PI) / 180,
      scale: 0.25,
      scaleMin: 0.01,
      scaleMax: 100,
      quantum: 1e-4,
    });
  });
});

describe('snapping — round-half-away-from-zero and 1e-4 quantization', () => {
  it('rounds half away from zero in both directions', () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(1.4999)).toBe(1);
    expect(roundHalfAwayFromZero(0)).toBe(0);
  });

  it('quantizes to the 1e-4 grid and normalizes negative zero', () => {
    expect(quantize(0.00005)).toBeCloseTo(1e-4, 12);
    expect(quantize(0.000049)).toBe(0);
    expect(quantize(-0.00005)).toBeCloseTo(-1e-4, 12);
    expect(quantize(1.0000499999)).toBeCloseTo(1, 12);
    expect(Object.is(quantize(-0.00001), 0)).toBe(true);
    expect(Object.is(quantize(0), 0)).toBe(true);
  });

  it('snapValue snaps on the grid with half-away-from-zero', () => {
    expect(snapValue(0.125, 0.25)).toBe(0.25);
    expect(snapValue(-0.125, 0.25)).toBe(-0.25);
    expect(snapValue(0.375, 0.25)).toBe(0.5);
    expect(snapValue(-0.375, 0.25)).toBe(-0.5);
    expect(snapValue(0.1249, 0.25)).toBe(0);
    expect(snapValue(1.1, 0.25)).toBe(1);
    expect(snapValue(Number.NaN, 0.25)).toBe(0);
    expect(snapValue(Number.POSITIVE_INFINITY, 0.25)).toBe(0);
  });
});

describe('snapping — translate (world-axis delta, drift-free)', () => {
  it('snaps each axis independently and never accumulates drift', () => {
    expect(snapTranslateDelta([0.1, 0.3, -0.6])).toEqual([0, 0.25, -0.5]);
    expect(snapTranslateDelta([0.24, -0.24, 0.26])).toEqual([0.25, -0.25, 0.25]);
    // A vanished delta stays exactly zero (no re-snapping of an absolute
    // position, so repeated moves cannot drift).
    expect(snapTranslateDelta([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('snapping — rotate (15° about the gizmo axis, rebuilt + renormalized)', () => {
  it('snaps the accumulated angle to the 15° grid', () => {
    const at30 = snapRotationAngle((30 * Math.PI) / 180, [0, 1, 0]);
    expect(at30.angleRad).toBeCloseTo(0.5236, 12); // 30° quantized to 1e-4
    // 7.5° is exactly half an increment ⇒ away from zero ⇒ 15°.
    expect(snapRotationAngle((7.5 * Math.PI) / 180, [0, 1, 0]).angleRad).toBeCloseTo(0.2618, 12);
    expect(snapRotationAngle((-7.5 * Math.PI) / 180, [0, 1, 0]).angleRad).toBeCloseTo(-0.2618, 12);
    expect(snapRotationAngle(0.01, [0, 1, 0]).angleRad).toBe(0);
  });

  it('rebuilds a unit quaternion about the axis', () => {
    const { angleRad, quaternion } = snapRotationAngle((45 * Math.PI) / 180, [0, 1, 0]);
    const norm = Math.hypot(...quaternion);
    expect(norm).toBeCloseTo(1, 12);
    // Half of the snapped angle, about +Y.
    const expected = Math.sin(angleRad / 2);
    expect(quaternion[0]).toBeCloseTo(0, 12);
    expect(quaternion[1]).toBeCloseTo(expected, 12);
    expect(quaternion[2]).toBeCloseTo(0, 12);
    expect(quaternion[3]).toBeCloseTo(Math.cos(angleRad / 2), 12);
  });

  it('normalizes the axis (a zero axis falls back to +Y)', () => {
    expect(normalizeAxis([0, 4, 0])).toEqual([0, 1, 0]);
    expect(normalizeAxis([0, 0, 0])).toEqual([0, 1, 0]);
    const q = snapRotationAngle((15 * Math.PI) / 180, [3, 0, 0]).quaternion;
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
  });
});

describe('snapping — scale (0.25 on the uniform factor, clamped [0.01, 100])', () => {
  it('snaps the factor and clamps it into the accepted scale range', () => {
    expect(snapScaleFactor(0.6)).toBe(0.5);
    expect(snapScaleFactor(2)).toBe(2);
    expect(snapScaleFactor(0.13)).toBe(0.25);
    expect(snapScaleFactor(0.124)).toBe(SCALE_MIN);
    expect(snapScaleFactor(0)).toBe(SCALE_MIN);
    expect(snapScaleFactor(-5)).toBe(SCALE_MIN);
    expect(snapScaleFactor(100.3)).toBe(SCALE_MAX);
    expect(snapScaleFactor(1000)).toBe(SCALE_MAX);
    // A snap never produces a non-finite factor.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const f = snapScaleFactor(bad);
      expect(Number.isFinite(f)).toBe(true);
      expect(f).toBeGreaterThanOrEqual(SCALE_MIN);
      expect(f).toBeLessThanOrEqual(SCALE_MAX);
    }
  });

  it('applies the snapped factor to the entity uniform scale and clamps per axis', () => {
    expect(snapScaleFromBase([1, 1, 1], 2)).toEqual([2, 2, 2]);
    expect(snapScaleFromBase([1, 1, 1], 0.13)).toEqual([0.25, 0.25, 0.25]);
    expect(snapScaleFromBase([1, 1, 1], 0.001)).toEqual([SCALE_MIN, SCALE_MIN, SCALE_MIN]);
    expect(snapScaleFromBase([1, 1, 1], 0.6)).toEqual([0.5, 0.5, 0.5]);
    expect(snapScaleFromBase([60, 60, 60], 2)).toEqual([SCALE_MAX, SCALE_MAX, SCALE_MAX]);
    expect(clampScale(Number.NaN)).toBe(SCALE_MIN);
  });
});

describe('snapping — Shift disables snapping for one gesture only', () => {
  it('snapActive is a pure local option, never a persistent setting', () => {
    expect(snapActive(true, false)).toBe(true);
    expect(snapActive(true, true)).toBe(false);
    expect(snapActive(false, false)).toBe(false);
    expect(snapActive(false, true)).toBe(false);
  });

  it('snapGesture returns the snapped delta or null when inactive', () => {
    expect(snapGesture({ kind: 'translate', delta: [0.6, 0, 0] }, true)).toEqual({ kind: 'translate', delta: [0.5, 0, 0] });
    expect(snapGesture({ kind: 'translate', delta: [0.6, 0, 0] }, false)).toBeNull();
    expect(snapGesture({ kind: 'scale', factor: 0.6 }, true)).toEqual({ kind: 'scale', factor: 0.5 });
    const rot = snapGesture({ kind: 'rotate', axis: [0, 1, 0], angleRad: 0.2 }, true);
    expect(rot).toEqual({ kind: 'rotate', axis: [0, 1, 0], angleRad: 0.2618 });
  });
});
