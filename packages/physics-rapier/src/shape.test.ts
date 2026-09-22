/**
 * Packet 31 — collider-shape validation (project-model §10.7/§21.3).
 *
 * The adapter's copy of the accepted vocabulary must accept exactly what the
 * model accepts and reject everything else with a detail string. The valid
 * shapes are checked through the real Rapier collider creation in
 * `init.test.ts`; this suite is the pure vocabulary table.
 */
import { describe, expect, it } from 'vitest';

import { polygonVertexBuffer, validateColliderShape } from './shape';
import {
  CONVEX_TOLERANCE,
  MAX_COLLIDER_HALF_EXTENT,
  MAX_POLYGON_VERTICES,
  MAX_SHAPE_VALUE,
  MIN_POLYGON_AREA,
} from './constants';

const ok = (shape: unknown): boolean => validateColliderShape(shape).ok;

describe('box shapes', () => {
  it('accepts a positive bounded box', () => {
    const r = validateColliderShape({ type: 'box', hx: 1.5, hy: 0.1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.shape).toEqual({ type: 'box', hx: 1.5, hy: 0.1 });
  });

  it(`accepts the exact bounds 0 < v <= ${MAX_SHAPE_VALUE}`, () => {
    expect(ok({ type: 'box', hx: MAX_SHAPE_VALUE, hy: 1 })).toBe(true);
    expect(ok({ type: 'box', hx: Number.MIN_VALUE, hy: 1 })).toBe(true);
  });

  it('rejects zero, negative, non-finite and over-bound extents', () => {
    expect(ok({ type: 'box', hx: 0, hy: 1 })).toBe(false);
    expect(ok({ type: 'box', hx: -1, hy: 1 })).toBe(false);
    expect(ok({ type: 'box', hx: Number.NaN, hy: 1 })).toBe(false);
    expect(ok({ type: 'box', hx: Number.POSITIVE_INFINITY, hy: 1 })).toBe(false);
    expect(ok({ type: 'box', hx: MAX_SHAPE_VALUE + 1, hy: 1 })).toBe(false);
    expect(ok({ type: 'box', hx: '1', hy: 1 })).toBe(false);
    expect(ok({ type: 'box', hy: 1 })).toBe(false);
  });

  it('rejects unexpected fields and non-objects', () => {
    expect(ok({ type: 'box', hx: 1, hy: 1, radius: 1 })).toBe(false);
    expect(ok(null)).toBe(false);
    expect(ok([])).toBe(false);
    expect(ok('box')).toBe(false);
  });
});

describe('polygon shapes', () => {
  const quad = { type: 'polygon', vertices: [[0, 0], [3, 0], [3, 1], [0, 2]] };

  it('accepts a bounded convex counter-clockwise polygon', () => {
    const r = validateColliderShape(quad);
    expect(r.ok).toBe(true);
    if (r.ok && r.shape.type === 'polygon') {
      expect(r.shape.vertices).toEqual([[0, 0], [3, 0], [3, 1], [0, 2]]);
    }
  });

  it(`accepts 3..${MAX_POLYGON_VERTICES} vertices and rejects outside the range`, () => {
    expect(ok({ type: 'polygon', vertices: [[0, 0], [1, 0], [0, 1]] })).toBe(true);
    expect(ok({ type: 'polygon', vertices: [[0, 0], [1, 0]] })).toBe(false);
    const nine: [number, number][] = [];
    for (let i = 0; i < 9; i += 1) {
      const a = (i / 9) * Math.PI * 2;
      nine.push([Math.cos(a), Math.sin(a)]);
    }
    expect(ok({ type: 'polygon', vertices: nine })).toBe(false);
  });

  it('allows collinear triples but rejects real non-convexity', () => {
    expect(ok({ type: 'polygon', vertices: [[0, 0], [1, 0], [2, 0], [2, 1], [0, 1]] })).toBe(true);
    expect(ok({ type: 'polygon', vertices: [[0, 0], [2, 0], [1, 0.5], [2, 2], [0, 2]] })).toBe(false);
  });

  it('uses the contract convexity tolerance and area floor', () => {
    // A concavity smaller than the tolerance is accepted (collinear is allowed).
    const tiny = CONVEX_TOLERANCE / 10;
    expect(ok({ type: 'polygon', vertices: [[0, 0], [1, 0], [1, 1], [0.5, 1 - tiny], [0, 1]] })).toBe(true);
    // Area below the floor is a shape error.
    const side = Math.sqrt(MIN_POLYGON_AREA) * 0.5;
    expect(ok({ type: 'polygon', vertices: [[0, 0], [side, 0], [0, side]] })).toBe(false);
  });

  it('rejects clockwise order, duplicate adjacent vertices and malformed vertices', () => {
    expect(ok({ type: 'polygon', vertices: [[0, 0], [0, 1], [1, 1]] })).toBe(false);
    expect(ok({ type: 'polygon', vertices: [[0, 0], [1, 0], [1, 0], [0, 1]] })).toBe(false);
    expect(ok({ type: 'polygon', vertices: [[0, 0], [1, 0], [0]] })).toBe(false);
    expect(ok({ type: 'polygon', vertices: [[0, 0], [1, 0], [0, Number.POSITIVE_INFINITY]] })).toBe(false);
    expect(ok({ type: 'polygon', vertices: [[0, 0], [1, 0], [0, MAX_SHAPE_VALUE + 1]] })).toBe(false);
    expect(ok({ type: 'polygon', vertices: [[0, 0], [1, 0], [0, 1]], extra: 1 })).toBe(false);
  });

  it(`rejects a bounding half-extent past ${MAX_COLLIDER_HALF_EXTENT} m`, () => {
    expect(ok({ type: 'polygon', vertices: [[0, 0], [MAX_COLLIDER_HALF_EXTENT + 1, 0], [0, 1]] })).toBe(false);
  });

  it('builds a row-major Float32Array hull buffer only for polygons', () => {
    const r = validateColliderShape(quad);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Array.from(polygonVertexBuffer(r.shape) ?? [])).toEqual([0, 0, 3, 0, 3, 1, 0, 2]);
    const box = validateColliderShape({ type: 'box', hx: 1, hy: 1 });
    expect(box.ok).toBe(true);
    if (box.ok) expect(polygonVertexBuffer(box.shape)).toBeNull();
  });

  it('rejects an unknown shape type', () => {
    expect(ok({ type: 'circle', radius: 1 })).toBe(false);
    expect(ok({ shape: 'box' })).toBe(false);
  });
});
