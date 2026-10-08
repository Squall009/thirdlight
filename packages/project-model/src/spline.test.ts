import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { canonicalSpline, validateSplineComponent, type SplineComponent } from './spline';
import { SplineCurve } from './spline-curve';

const errorsOf = (v: unknown): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  validateSplineComponent(v, '', e);
  return e;
};

describe('spline component', () => {
  it('accepts points alone and every optional part, and refuses what is wrong', () => {
    expect(errorsOf({ points: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }] })).toEqual([]);
    expect(errorsOf({ points: [{ at: [0, 0, 0] }] }).map((e) => e.path)).toEqual(['/points']);
    expect(errorsOf({ points: [{ at: [0, 0, 0] }, { at: [1, 0, 0] }], closed: true }).map((e) => e.path)).toEqual(['/closed']);
    expect(errorsOf({ points: [{ at: [0, 0, 0] }, { at: [1, 0] }] }).map((e) => e.path)).toEqual(['/points/1/at']);
    expect(errorsOf({ points: [{ at: [0, 0, 0] }, { at: [1, 0, 0], roll: 90 }] }).map((e) => e.path)).toEqual(['/points/1/roll']);
    expect(errorsOf({ points: [{ at: [0, 0, 0] }, { at: [1, 0, 0] }], terrain: { shape: 'dig' } }).map((e) => e.path)).toEqual(['/terrain/shape']);
    expect(errorsOf({ points: [{ at: [0, 0, 0] }, { at: [1, 0, 0] }], terrain: { paint: { layer: 256 } } }).map((e) => e.path)).toEqual(['/terrain/paint/layer']);
    expect(errorsOf({ points: [{ at: [0, 0, 0] }, { at: [1, 0, 0] }], pieces: [{ asset: { assetId: 'm' }, spacing: 0 }] }).map((e) => e.path)).toEqual(['/pieces/0/spacing']);
    expect(errorsOf({ points: [{ at: [0, 0, 0] }, { at: [1, 0, 0] }], data: 'x' }).map((e) => e.path)).toEqual(['/data']);
  });

  it('canonical form orders fields and drops nothing that is set', () => {
    const c = { width: 6, points: [{ width: 3, at: [0, 0, 0] }, { at: [5, 0, 0] }], terrain: { paint: { falloff: 1, layer: 2 }, shape: 'carve' } } as unknown as SplineComponent;
    expect(JSON.stringify(canonicalSpline(c))).toBe('{"points":[{"at":[0,0,0],"width":3},{"at":[5,0,0]}],"width":6,"terrain":{"shape":"carve","paint":{"layer":2,"falloff":1}}}');
  });
});

describe('spline curve', () => {
  it('measures a straight run and frames it level (going +x, right is +z)', () => {
    const c = SplineCurve.of({ points: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }, { at: [20, 0, 0] }] }, [100, 5, 0]);
    expect(c.length).toBeCloseTo(20, 6);
    const f = c.frameAt(5);
    expect([f.x, f.y, f.z]).toEqual([105, 5, 0].map((v) => expect.closeTo(v, 6)));
    expect([f.tx, f.ty, f.tz]).toEqual([1, 0, 0].map((v) => expect.closeTo(v, 6)));
    expect([f.rx, f.ry, f.rz]).toEqual([0, 0, 1].map((v) => expect.closeTo(v, 6)));
    expect([f.ux, f.uy, f.uz]).toEqual([0, 1, 0].map((v) => expect.closeTo(v, 6)));
    expect(f.width).toBe(4);
    // Clamped past the ends.
    expect(c.frameAt(-3).x).toBeCloseTo(100, 6);
    expect(c.frameAt(99).x).toBeCloseTo(120, 6);
  });

  it('interpolates width and roll, and roll lifts the right side', () => {
    const c = SplineCurve.of({ points: [{ at: [0, 0, 0], width: 2, roll: 0 }, { at: [0, 0, 10], width: 6, roll: 30 }] }, [0, 0, 0]);
    const f = c.frameAt(10);
    expect(f.width).toBeCloseTo(6, 6);
    expect(f.roll).toBeCloseTo(30, 6);
    expect(f.ry).toBeCloseTo(Math.sin(Math.PI / 6), 6);
    expect(c.frameAt(5).width).toBeCloseTo(4, 2);
  });

  it('passes through its points with Catmull-Rom tangents and wraps when closed', () => {
    const pts = [{ at: [0, 0, 0] }, { at: [10, 0, 0] }, { at: [10, 0, 10] }, { at: [0, 0, 10] }] as SplineComponent['points'];
    const c = SplineCurve.of({ points: pts, closed: true }, [0, 0, 0]);
    expect(c.segments).toBe(4);
    const near = c.nearest(10, 0, 0);
    expect(near.offset).toBeLessThan(1e-6);
    // A closed curve wraps: one length on is the start again.
    expect(c.frameAt(c.length + 1).x).toBeCloseTo(c.frameAt(1).x, 6);
    const frames = c.frames(1);
    expect(frames[0]!.x).toBeCloseTo(frames[frames.length - 1]!.x, 6);
    expect(frames.length).toBeGreaterThan(40);
  });

  it('finds the nearest place across the ground', () => {
    const c = SplineCurve.of({ points: [{ at: [0, 0, 0] }, { at: [10, 4, 0] }] }, [0, 0, 0]);
    const n = c.nearest(5, 100, 3, true);
    expect(n.offset).toBeCloseTo(3, 1);
    expect(n.distance).toBeGreaterThan(0);
    expect(n.y).toBeGreaterThan(0);
  });
});
