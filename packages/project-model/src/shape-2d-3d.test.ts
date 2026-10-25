/**
 * The 3D form of a 2D collider shape: a box given its depth, a convex
 * polygon one prism, a concave outline split into convex prisms (always the
 * same split, covering exactly the outline), a circle a cylinder along the
 * plane's normal, the 3D shapes kept, and the result valid in a scene.
 */
import { describe, expect, it } from 'vitest';

import { convexPieces, DEFAULT_COLLIDER_DEPTH, shape2DTo3D, type Shape3DChange } from './shape-2d-3d';
import { validateSceneV4 } from './scene-v3';

const area = (poly: readonly (readonly [number, number])[]): number => {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    const q = poly[(i + 1) % poly.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};
const convex = (poly: readonly (readonly [number, number])[]): boolean =>
  poly.every((_, i) => {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const c = poly[(i + 2) % poly.length]!;
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) >= -1e-12;
  });
/** Whether a point lies inside a counter-clockwise convex piece (strictly). */
const inside = (poly: readonly (readonly [number, number])[], p: readonly [number, number]): boolean =>
  poly.every((a, i) => {
    const b = poly[(i + 1) % poly.length]!;
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 1e-12;
  });
/** Even-odd point-in-polygon for the outline itself. */
const inOutline = (poly: readonly (readonly [number, number])[], p: readonly [number, number]): boolean => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
};

const L_SHAPE: [number, number][] = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
const U_SHAPE: [number, number][] = [[0, 0], [5, 0], [5, 3], [4, 3], [4, 1], [1, 1], [1, 3], [0, 3]];
// A comb: a spine with five teeth (20 corners, deeply concave).
const COMB: [number, number][] = (() => {
  const out: [number, number][] = [[0, 0], [10, 0]];
  for (let t = 4; t >= 0; t--) out.push([t * 2 + 2, 1], [t * 2 + 2, 3], [t * 2 + 1, 3], [t * 2 + 1, 1]);
  out.pop();
  out.push([1, 1], [1, 3], [0, 3]);
  return out;
})();

describe('convex pieces of an outline', () => {
  it('a convex outline is one piece (either winding, collinear corners dropped)', () => {
    expect(convexPieces([[0, 0], [2, 0], [2, 1], [0, 1]])).toEqual([[[0, 0], [2, 0], [2, 1], [0, 1]]]);
    const cw = convexPieces([[0, 1], [2, 1], [2, 0], [0, 0]]);
    expect(cw).toHaveLength(1);
    expect(area(cw[0]!)).toBe(2);
    expect(convexPieces([[0, 0], [1, 0], [2, 0], [2, 1], [0, 1]])[0]).toHaveLength(4);
    expect(convexPieces([[0, 0], [1, 0], [2, 0]])).toEqual([]);
  });

  for (const [name, outline, most] of [['an L', L_SHAPE, 2], ['a U', U_SHAPE, 4], ['a comb', COMB, 12]] as const) {
    it(`${name} splits into convex pieces that tile it exactly, the same way every time`, () => {
      const pieces = convexPieces(outline);
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces.length).toBeLessThanOrEqual(most);
      for (const p of pieces) {
        expect(convex(p)).toBe(true);
        expect(area(p)).toBeGreaterThan(0);
      }
      expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(outline), 9);
      // Every sample point inside the outline lies in exactly one piece (none outside it in any).
      for (let x = 0.05; x < 10; x += 0.1) {
        for (let y = 0.05; y < 3; y += 0.1) {
          const n = pieces.filter((p) => inside(p, [x, y])).length;
          if (inOutline(outline, [x, y])) expect(n).toBeLessThanOrEqual(1);
          else expect(n).toBe(0);
        }
      }
      expect(convexPieces(outline)).toEqual(pieces);
      // Reversed winding gives the same pieces.
      expect(convexPieces([...outline].reverse()).reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(outline), 9);
    });
  }

  it('a convex outline with more corners than a hull holds is split into a fan of pieces', () => {
    const circle: [number, number][] = Array.from({ length: 48 }, (_, i) => [Math.cos((i / 48) * 2 * Math.PI), Math.sin((i / 48) * 2 * Math.PI)]);
    const pieces = convexPieces(circle);
    expect(pieces.length).toBe(2);
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(32);
    expect(pieces.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(circle), 9);
  });
});

describe('the 3D form of a 2D shape', () => {
  it('a box gets its depth (default 1 m), keeping its pose', () => {
    const changes: Shape3DChange[] = [];
    expect(shape2DTo3D({ type: 'box', hx: 2, hy: 0.5 }, {}, changes)).toEqual({ type: 'box', hx: 2, hy: 0.5, hz: DEFAULT_COLLIDER_DEPTH / 2 });
    expect(changes).toEqual([{ from: 'box', to: 'box' }]);
    expect(shape2DTo3D({ type: 'box', hx: 2, hy: 0.5, center: [1, 2, 0] }, { depth: 3 })).toEqual({ type: 'box', hx: 2, hy: 0.5, hz: 1.5, center: [1, 2, 0] });
  });

  it('a 3D shape is kept as it is (the same object)', () => {
    const box = { type: 'box', hx: 1, hy: 1, hz: 1 };
    expect(shape2DTo3D(box)).toBe(box);
    const sphere = { type: 'sphere', radius: 1 };
    expect(shape2DTo3D(sphere)).toBe(sphere);
  });

  it('a convex polygon is one prism; a concave one a compound of prisms', () => {
    const changes: Shape3DChange[] = [];
    const tri = shape2DTo3D({ type: 'polygon', vertices: [[0, 0], [1, 0], [0, 1]] }, { depth: 2 }, changes);
    expect(tri).toEqual({ type: 'convex', points: [[0, 0, -1], [0, 0, 1], [1, 0, -1], [1, 0, 1], [0, 1, -1], [0, 1, 1]] });
    const l = shape2DTo3D({ type: 'polygon', vertices: L_SHAPE }, {}, changes) as { type: string; shapes: { type: string; points: number[][] }[] };
    expect(l.type).toBe('compound');
    expect(l.shapes).toHaveLength(2);
    for (const s of l.shapes) {
      expect(s.type).toBe('convex');
      expect(s.points.every((p) => Math.abs(p[2]!) === 0.5)).toBe(true);
    }
    expect(changes).toEqual([{ from: 'polygon', to: 'prism' }, { from: 'polygon', to: 'prisms', pieces: 2 }]);
  });

  it('a circle is a cylinder along the plane normal: Z by default, X on an X plane', () => {
    const changes: Shape3DChange[] = [];
    const onZ = shape2DTo3D({ type: 'circle', radius: 0.5 }, { depth: 2 }, changes) as { type: string; radius: number; height: number; rotation: number[] };
    expect(onZ.type).toBe('cylinder');
    expect(onZ.height).toBe(2);
    // The cylinder's own axis (local Y) turned by its rotation lies along world Z.
    expect(axisOf(onZ.rotation)).toEqual([0, 0, 1]);
    const onX = shape2DTo3D({ type: 'circle', radius: 0.5 }, { plane: 'x' }) as { rotation: number[] };
    expect(axisOf(onX.rotation).map(Math.abs)).toEqual([1, 0, 0]);
    expect(changes).toEqual([{ from: 'circle', to: 'cylinder' }]);
  });

  it('on an X plane a box stands in Y/Z with its depth along X, its x along −Z', () => {
    const box = shape2DTo3D({ type: 'box', hx: 2, hy: 0.5, center: [1, 0, 0] }, { plane: 'x', depth: 0.4 }) as { hz: number; center: number[]; rotation: number[] };
    expect(box.hz).toBe(0.2);
    expect(box.center).toEqual([0, 0, -1]);
    expect(rotate(box.rotation, [1, 0, 0])).toEqual([0, 0, -1]);
    expect(rotate(box.rotation, [0, 0, 1])).toEqual([1, 0, 0]);
  });

  it('a compound converts each part and keeps its 3D parts; the result validates in a scene', () => {
    const shape = shape2DTo3D({ type: 'compound', shapes: [{ type: 'polygon', vertices: U_SHAPE, center: [0, 1, 0] }, { type: 'sphere', radius: 1 }, { type: 'box', hx: 1, hy: 1 }] });
    const parts = (shape as { shapes: { type: string; center?: number[] }[] }).shapes;
    expect(parts.map((p) => p.type)).toEqual([...parts.slice(0, -2).map(() => 'convex'), 'sphere', 'box']);
    expect(parts[0]!.center).toEqual([0, 1, 0]);
    const v = validateSceneV4({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [{ id: 'body-0001', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, collider: { shape } } }] });
    expect(v.ok, JSON.stringify(!v.ok && v.errors)).toBe(true);
  });
});

function rotate(q: readonly number[], v: readonly number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
  const tx = 2 * (y * v[2]! - z * v[1]!);
  const ty = 2 * (z * v[0]! - x * v[2]!);
  const tz = 2 * (x * v[1]! - y * v[0]!);
  return [v[0]! + w * tx + (y * tz - z * ty), v[1]! + w * ty + (z * tx - x * tz), v[2]! + w * tz + (x * ty - y * tx)].map((n) => Math.round(n * 1e9) / 1e9 + 0);
}
const axisOf = (q: readonly number[]): number[] => rotate(q, [0, 1, 0]);
