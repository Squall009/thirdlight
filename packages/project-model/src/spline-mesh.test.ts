import { describe, expect, it } from 'vitest';

import type { SplineComponent } from './spline';
import { SplineCurve } from './spline-curve';
import { decodeSplineMade, encodeSplineMade, makeSpline, splinePieceCopies, sweepSplineMesh, SPLINE_MESH_PIECE_METRES } from './spline-mesh';

const ROAD: SplineComponent = { points: [{ at: [0, 0, 0] }, { at: [100, 0, 0] }, { at: [200, 10, 40] }], width: 8, mesh: { tiling: 8 } };

describe('spline meshes', () => {
  it('a surface: pieces about 64 m long meeting on shared cross-sections, faces up, texture along the curve', () => {
    const pieces = sweepSplineMesh(ROAD);
    const length = SplineCurve.of(ROAD, [0, 0, 0]).length;
    expect(pieces.length).toBe(Math.round(length / SPLINE_MESH_PIECE_METRES));
    for (const p of pieces) {
      expect(p.rowLength).toBe(2);
      expect(p.levels).toHaveLength(1);
      expect(p.flow).toBeNull();
      // Every normal points up-ish (a flat strip on a gentle curve).
      for (let i = 0; i < p.normals.length; i += 3) expect(p.normals[i + 1]!).toBeGreaterThan(0.9);
      // The first triangle's winding faces up (right × along).
      const [a, b, c] = [p.levels[0]!.indices[0]!, p.levels[0]!.indices[1]!, p.levels[0]!.indices[2]!];
      const v = (i: number): number[] => [p.positions[i * 3]!, p.positions[i * 3 + 1]!, p.positions[i * 3 + 2]!];
      const e1 = v(b).map((x, k) => x - v(a)[k]!);
      const e2 = v(c).map((x, k) => x - v(a)[k]!);
      expect(e1[2]! * e2[0]! - e1[0]! * e2[2]!).toBeGreaterThan(0);
    }
    // Pieces meet: the last cross-section of one is the first of the next (world positions).
    for (let k = 0; k + 1 < pieces.length; k++) {
      const a = pieces[k]!;
      const b = pieces[k + 1]!;
      const end = a.positions.length - 6;
      for (let j = 0; j < 6; j++) expect(a.positions[end + j]! + a.center[j % 3]!).toBeCloseTo(b.positions[j]! + b.center[j % 3]!, 4);
    }
    // The texture repeats every 8 m along the curve.
    const last = pieces[pieces.length - 1]!;
    expect(last.uvs[last.uvs.length - 1]!).toBeCloseTo(length / 8, 3);
  });

  it('water carries its flow and its banks\' foam', () => {
    const [p] = sweepSplineMesh({ ...ROAD, mesh: { kind: 'water', flow: 2, foam: 2, tiling: 4 } });
    expect(p!.flow).not.toBeNull();
    expect(p!.flow![1]).toBeCloseTo(0.5, 6);
    // Points across: foam 1 at the banks, none in the middle (half width 4 m, foam reaching 2 m in).
    expect(p!.rowLength).toBe(9);
    expect(p!.foam![0]).toBeCloseTo(1, 6);
    expect(p!.foam![8]).toBeCloseTo(1, 6);
    expect(p!.foam![4]).toBe(0);
    expect(p!.foam![1]).toBeCloseTo(0.5, 6);
  });

  it('pieces stand along the curve every spacing, +X along it, upright', () => {
    const c: SplineComponent = { points: [{ at: [0, 0, 0] }, { at: [0, 0, 20] }], pieces: [{ asset: { assetId: 'post' }, spacing: 5, offset: [2, 0.5] }] };
    const copies = splinePieceCopies(c, c.pieces![0]!);
    expect(copies.length / 10).toBe(5);
    // Going +z, right is -x: the offset puts them at x -2, raised 0.5 m.
    expect([copies[0], copies[1], copies[2]]).toEqual([-2, 0.5, 0].map((v) => expect.closeTo(v, 5)));
    expect(copies[12]).toBeCloseTo(5, 4);
    // The rotation turns +X onto +Z: a quarter turn about up (y component ±√½).
    expect(Math.abs(copies[4]!)).toBeCloseTo(Math.SQRT1_2, 4);
    expect(Math.abs(copies[3]!) + Math.abs(copies[5]!)).toBeLessThan(1e-6);
  });

  it('round-trips through its blob, and refuses one cut short', () => {
    const made = makeSpline({ ...ROAD, mesh: { kind: 'water' }, pieces: [{ asset: { assetId: 'post' }, spacing: 10 }] });
    made.pieces[0]!.levels.push({ error: Math.fround(0.02), indices: made.pieces[0]!.levels[0]!.indices.slice(0, 6) });
    const blob = encodeSplineMade(made);
    const back = decodeSplineMade(blob);
    expect(back).toEqual(made);
    expect(() => decodeSplineMade(blob.subarray(0, blob.length - 8))).toThrow();
  });
});
