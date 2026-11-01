/**
 * Auto-exposure's maths: a camera's look and its defaults, the blend with
 * the camera blend (in the brain too), the range against the fixed
 * exposure, metering weights, the target, and adaptation — the speeds each
 * way, the bounds and compensation, frame-rate independence.
 */
import { VIRTUAL_CAMERA_DEFAULTS as VCD } from '@thirdlight/project-model';
import { describe, expect, it } from 'vitest';

import { adaptExposure, blendExposureLook, cameraExposureLook, EXPOSURE_KEY, exposureRange, meteredLogLuminance, meterWeight, targetExposure, type ExposureLook } from './auto-exposure';
import { CameraBrain, type CameraWorld } from './camera-brain';

const look = (over: Partial<ExposureLook> = {}): ExposureLook => ({ ...cameraExposureLook({ autoExposure: true })!, ...over });

/** Steps adaptation for `seconds` at `hz` frames a second; the exposure at the end. */
function adaptFor(seconds: number, hz: number, from: number, target: number, l: ExposureLook, lo = l.min, hi = l.max): number {
  let e = from;
  for (let i = 0; i < Math.round(seconds * hz); i += 1) e = adaptExposure(e, target, lo, hi, l.brighten, l.darken, 1 / hz);
  return e;
}
/** The share of the gap in stops still open. */
const left = (e: number, from: number, to: number): number => Math.log2(e / to) / Math.log2(from / to);

describe('auto-exposure look', () => {
  it('off is null; on takes the engine defaults, metering and its own fields', () => {
    expect(cameraExposureLook({})).toBeNull();
    expect(cameraExposureLook({ autoExposure: false, exposureMin: 0.5 })).toBeNull();
    expect(cameraExposureLook({ autoExposure: true })).toEqual({ auto: 1, min: VCD.exposureMin, max: VCD.exposureMax, brighten: VCD.exposureBrightenSpeed, darken: VCD.exposureDarkenSpeed, center: 1, compensation: VCD.exposureCompensation });
    expect(cameraExposureLook({ autoExposure: true, exposureMin: 0.5, exposureMax: 0.25, exposureMetering: 'average', exposureCompensation: -1, exposureBrightenSpeed: 2, exposureDarkenSpeed: 0 })).toEqual({ auto: 1, min: 0.5, max: 0.5, brighten: 2, darken: 0, center: 0, compensation: -1 });
  });

  it('blends: the ends are the sides; to or from a camera without it the weight ramps and the settings are the adapting side\'s', () => {
    const a = look({ min: 0.25, max: 4, brighten: 1, darken: 4, center: 1, compensation: 0 });
    const b = look({ min: 1, max: 1, brighten: 3, darken: 2, center: 0, compensation: 2 });
    expect(blendExposureLook(a, b, 0)).toBe(a);
    expect(blendExposureLook(a, b, 1)).toBe(b);
    expect(blendExposureLook(null, null, 0.5)).toBeNull();
    const mid = blendExposureLook(a, b, 0.5)!;
    expect(mid.auto).toBe(1);
    // Bounds in stops: halfway between −2 and 0 stops is −1, between 2 and 0 is 1.
    expect(mid.min).toBeCloseTo(0.5, 12);
    expect(mid.max).toBeCloseTo(2, 12);
    expect(mid.brighten).toBeCloseTo(2, 12);
    expect(mid.center).toBeCloseTo(0.5, 12);
    expect(mid.compensation).toBeCloseTo(1, 12);
    const fromOff = blendExposureLook(null, b, 0.25)!;
    expect(fromOff.auto).toBeCloseTo(0.25, 12);
    expect({ ...fromOff, auto: 1 }).toEqual(b);
    const toOff = blendExposureLook(a, null, 0.75)!;
    expect(toOff.auto).toBeCloseTo(0.25, 12);
    expect({ ...toOff, auto: 1 }).toEqual(a);
  });

  it('the range is the fixed exposure without a look and the look\'s bounds at full weight, moving between them in stops', () => {
    expect(exposureRange(null, 0.8)).toEqual([0.8, 0.8]);
    const l = look({ min: 0.25, max: 4 });
    expect(exposureRange(l, 1)).toEqual([0.25, 4]);
    const [lo, hi] = exposureRange({ ...l, auto: 0.5 }, 1);
    expect(lo).toBeCloseTo(0.5, 12);
    expect(hi).toBeCloseTo(2, 12);
    expect(exposureRange({ ...l, auto: 0 }, 1)).toEqual([1, 1]);
  });
});

describe('metering', () => {
  it('average weighs every texel alike; centre-weighted counts the middle most', () => {
    expect(meterWeight(0, 0, 0)).toBe(1);
    expect(meterWeight(0.5, 0.5, 1)).toBe(1);
    expect(meterWeight(0.03, 0.06, 1)).toBeLessThan(0.05);
    expect(meterWeight(0.03, 0.06, 0.5)).toBeGreaterThan(0.5);
    // A 4 × 2 grid: a bright middle (log2 2) and dark edges (log2 −6), RGBA stride.
    const grid = new Float32Array(8 * 4);
    for (let y = 0; y < 2; y += 1) for (let x = 0; x < 4; x += 1) grid[(y * 4 + x) * 4] = x === 1 || x === 2 ? 2 : -6;
    expect(meteredLogLuminance(grid, 4, 2, 0, 4)).toBeCloseTo(-2, 6);
    const centred = meteredLogLuminance(grid, 4, 2, 1, 4)!;
    expect(centred).toBeGreaterThan(-1);
    expect(centred).toBeLessThan(2);
    // Non-finite texels are left out; none left: no reading.
    grid[0] = NaN;
    expect(Number.isFinite(meteredLogLuminance(grid, 4, 2, 0, 4))).toBe(true);
    expect(meteredLogLuminance(new Float32Array([NaN, Infinity]), 2, 1, 0)).toBeNull();
  });

  it('the target puts the metered average on middle grey, shifted by the compensation in stops', () => {
    expect(targetExposure(Math.log2(EXPOSURE_KEY), 0)).toBeCloseTo(1, 12);
    expect(targetExposure(Math.log2(0.72), 0)).toBeCloseTo(0.25, 12);
    expect(targetExposure(Math.log2(0.72), 1)).toBeCloseTo(0.5, 12);
    expect(targetExposure(Math.log2(0.0225), -1)).toBeCloseTo(4, 12);
  });
});

describe('adaptation', () => {
  it('brightens at its speed and darkens at the other, settling 95 % in about 3 / speed seconds, the same at any frame rate', () => {
    const l = look({ min: 0.01, max: 64, brighten: 1, darken: 3 });
    // Into the light: 8 → 0.25 (5 stops down) at 3/s.
    expect(left(adaptFor(1, 60, 8, 0.25, l), 8, 0.25)).toBeCloseTo(Math.exp(-3), 6);
    expect(left(adaptFor(1, 144, 8, 0.25, l), 8, 0.25)).toBeCloseTo(Math.exp(-3), 6);
    // Into the dark: 0.25 → 8 at 1/s: after 1 s only 63 % of the way, after 3 s 95 %.
    expect(left(adaptFor(1, 60, 0.25, 8, l), 0.25, 8)).toBeCloseTo(Math.exp(-1), 6);
    expect(left(adaptFor(3, 30, 0.25, 8, l), 0.25, 8)).toBeLessThan(0.05 + 1e-9);
    // No time, no move; a speed of 0 never moves that way.
    expect(adaptExposure(2, 0.5, 0.01, 64, 1, 3, 0)).toBeCloseTo(2, 12);
    expect(adaptExposure(2, 0.5, 0.01, 64, 1, 0, 1)).toBeCloseTo(2, 12);
  });

  it('min and max hold: a dark scene never opens past the max, a bright one never closes past the min; a moving range holds the exposure in it', () => {
    const l = look({ min: 0.125, max: 2, brighten: 5, darken: 5 });
    // A night meters 2^-10: the target is far above the max.
    const night = targetExposure(-10, 0);
    expect(night).toBeGreaterThan(100);
    expect(adaptFor(10, 60, 1, night, l)).toBeCloseTo(2, 9);
    // Noon meters 2^4: below the min.
    expect(adaptFor(10, 60, 1, targetExposure(4, 0), l)).toBeCloseTo(0.125, 9);
    // Compensation moves the target, the bounds still hold.
    expect(adaptFor(10, 60, 1, targetExposure(Math.log2(0.36), 1), l)).toBeCloseTo(1, 6);
    // The range narrows to the fixed exposure (a blend to a camera without it): the exposure follows at once.
    expect(adaptExposure(2, 2, 1, 1, 0, 0, 1 / 60)).toBe(1);
  });
});

describe('the camera brain', () => {
  const W: CameraWorld = { worldOf: () => false };
  const BASE = { position: [0, 2, 10], rotation: [0, 0, 0, 1] };
  const cam = (id: string, data: Record<string, unknown>) => ({ id, components: { transform: {}, virtualCamera: { rig: 'fixed', ...data } } });

  it('the view carries the live camera\'s look, blends it with the camera blend, and says when a loaded camera has one', () => {
    const b = new CameraBrain(120, { fovY: 60, near: 0.1, far: 100 });
    b.add([cam('plain', {}), cam('auto', { autoExposure: true, exposureMin: 0.25, exposureMax: 4, blend: 'linear', blendTime: 1 })]);
    b.step(BASE, { stepIndex: 0, actions: {} }, W);
    expect(b.view().live).toBe('plain');
    expect(b.view().exposure).toBeUndefined();
    expect(b.view().autoExposureLoaded).toBe(true);
    b.activate('auto');
    for (let i = 0; i < 60; i += 1) b.step(BASE, { stepIndex: i + 1, actions: {} }, W);
    // Halfway through a 1 s linear blend from a camera without it: half adapting, the incoming camera's bounds.
    const mid = b.view().exposure!;
    expect(mid.auto).toBeCloseTo(0.5, 9);
    expect([mid.min, mid.max]).toEqual([0.25, 4]);
    for (let i = 0; i < 61; i += 1) b.step(BASE, { stepIndex: i + 61, actions: {} }, W);
    expect(b.view().exposure).toEqual(cameraExposureLook({ autoExposure: true, exposureMin: 0.25, exposureMax: 4 }));
    // Without any camera that adapts the view says nothing of it (every other digest unchanged).
    const none = new CameraBrain(120, { fovY: 60, near: 0.1, far: 100 });
    none.add([cam('plain', {})]);
    none.step(BASE, { stepIndex: 0, actions: {} }, W);
    expect('exposure' in none.view() || 'autoExposureLoaded' in none.view()).toBe(false);
  });
});
