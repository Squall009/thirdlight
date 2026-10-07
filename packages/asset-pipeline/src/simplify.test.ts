/**
 * The mesh simplifier: triangle reduction against the share asked for, the
 * error it reports (checked against the measured distance of the original
 * vertices from the simplified surface), the level chain and its stop, the
 * locked border, and meshes without an index list.
 */
import { describe, expect, it } from 'vitest';

import { MESH_LOD_RATIOS_DEFAULT } from '@thirdlight/project-model/limits';

import { MESH_LOD_KEEP_SHARE, MESH_SIMPLIFY_ERROR_DEFAULT, loadMeshSimplifier } from './simplify';

/** A welded UV sphere of radius r: `seg` around, `rings` from pole to pole, one vertex at each pole. */
function sphere(r: number, seg: number, rings: number): { positions: Float32Array; indices: Uint32Array } {
  const p: number[] = [0, r, 0];
  for (let j = 1; j < rings; j++) {
    const v = (j / rings) * Math.PI;
    for (let i = 0; i < seg; i++) {
      const u = (i / seg) * Math.PI * 2;
      p.push(r * Math.sin(v) * Math.cos(u), r * Math.cos(v), r * Math.sin(v) * Math.sin(u));
    }
  }
  p.push(0, -r, 0);
  const bottom = p.length / 3 - 1;
  const at = (j: number, i: number): number => 1 + (j - 1) * seg + (i % seg);
  const idx: number[] = [];
  for (let i = 0; i < seg; i++) idx.push(0, at(1, i + 1), at(1, i));
  for (let j = 1; j < rings - 1; j++) {
    for (let i = 0; i < seg; i++) idx.push(at(j, i), at(j, i + 1), at(j + 1, i), at(j, i + 1), at(j + 1, i + 1), at(j + 1, i));
  }
  for (let i = 0; i < seg; i++) idx.push(bottom, at(rings - 1, i), at(rings - 1, i + 1));
  return { positions: new Float32Array(p), indices: new Uint32Array(idx) };
}

/** A flat n × n grid of quads, 1 m each, in XZ. */
function plane(n: number): { positions: Float32Array; indices: Uint32Array } {
  const p: number[] = [];
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) p.push(x, 0, z);
  const idx: number[] = [];
  for (let z = 0; z < n; z++) {
    for (let x = 0; x < n; x++) {
      const a = z * (n + 1) + x;
      idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
    }
  }
  return { positions: new Float32Array(p), indices: new Uint32Array(idx) };
}

/** The distance from point p to triangle abc (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangle(p: number[], a: number[], b: number[], c: number[]): number {
  const sub = (x: number[], y: number[]): number[] => [x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!];
  const dot = (x: number[], y: number[]): number => x[0]! * y[0]! + x[1]! * y[1]! + x[2]! * y[2]!;
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);
  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  const at = (q: number[]): number => Math.hypot(...sub(p, q));
  const on = (s: number, t: number): number[] => [a[0]! + ab[0]! * s + ac[0]! * t, a[1]! + ab[1]! * s + ac[1]! * t, a[2]! + ab[2]! * s + ac[2]! * t];
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(on(d1 / (d1 - d3), 0));
  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(on(0, d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at([b[0]! + (c[0]! - b[0]!) * w, b[1]! + (c[1]! - b[1]!) * w, b[2]! + (c[2]! - b[2]!) * w]);
  }
  const denom = 1 / (va + vb + vc);
  return at(on(vb * denom, vc * denom));
}

/** The farthest any original vertex lies from the simplified surface. */
function deviation(positions: Float32Array, indices: Uint32Array): number {
  const v = (i: number): number[] => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  let worst = 0;
  for (let i = 0; i < positions.length / 3; i++) {
    let best = Infinity;
    for (let t = 0; t < indices.length && best > 0; t += 3) best = Math.min(best, pointTriangle(v(i), v(indices[t]!), v(indices[t + 1]!), v(indices[t + 2]!)));
    worst = Math.max(worst, best);
  }
  return worst;
}

describe('mesh simplifier', () => {
  it('cuts a sphere to the share asked for, within the error it reports', async () => {
    const s = await loadMeshSimplifier();
    const mesh = sphere(1, 64, 32);
    const triangles = mesh.indices.length / 3;
    const out = s.simplify({ ...mesh, indices: mesh.indices }, { ratio: 0.25, maxError: 0.05 });
    expect(out.triangles).toBeLessThanOrEqual(Math.ceil(triangles * 0.25));
    expect(out.triangles).toBeGreaterThan(triangles * 0.15);
    expect(out.error).toBeGreaterThan(0);
    expect(out.error).toBeLessThanOrEqual(0.05);
    // The error is a share of the extent (the sphere's is 2 m), a quadric estimate: the measured distance of the
    // original vertices from the simplified surface stays within twice it (1.5× here).
    expect(out.errorAbsolute).toBeCloseTo(out.error * 2, 5);
    const measured = deviation(mesh.positions, out.indices);
    expect(measured).toBeGreaterThan(0);
    expect(measured).toBeLessThanOrEqual(out.errorAbsolute * 2);
    // Every index is one of the original vertices (levels share the vertex data).
    expect(Math.max(...out.indices)).toBeLessThan(mesh.positions.length / 3);
  });

  it('stops at the error bound before the share when the shape would suffer', async () => {
    const s = await loadMeshSimplifier();
    const mesh = sphere(1, 64, 32);
    const tight = s.simplify(mesh, { ratio: 0.02, maxError: 0.001 });
    const loose = s.simplify(mesh, { ratio: 0.02, maxError: 0.2 });
    expect(tight.error).toBeLessThanOrEqual(0.001);
    expect(tight.triangles).toBeGreaterThan(loose.triangles * 2);
    expect(loose.triangles).toBeLessThanOrEqual(Math.ceil((mesh.indices.length / 3) * 0.02) + 1);
  });

  it('makes a level chain at the default shares, each coarser, and stops where a mesh cannot get simpler', async () => {
    const s = await loadMeshSimplifier();
    const mesh = sphere(1, 64, 32);
    const triangles = mesh.indices.length / 3;
    const levels = s.levels(mesh);
    expect(levels).toHaveLength(MESH_LOD_RATIOS_DEFAULT.length);
    levels.forEach((l, i) => {
      expect(l.triangles).toBeLessThanOrEqual(Math.ceil(triangles * MESH_LOD_RATIOS_DEFAULT[i]!) + 1);
      expect(l.triangles).toBeLessThan((i === 0 ? triangles : levels[i - 1]!.triangles) * MESH_LOD_KEEP_SHARE);
      // Each level within its own bound (the error grows with the coarser level's smaller size on screen).
      expect(l.error).toBeLessThanOrEqual((MESH_SIMPLIFY_ERROR_DEFAULT * 0.5) / MESH_LOD_RATIOS_DEFAULT[i]! + (i > 0 ? levels[i - 1]!.error : 0) + 1e-6);
    });
    // A flat grid reaches every share with no error at all.
    const flat = s.levels(plane(16));
    expect(flat.map((l) => l.triangles)).toEqual([256, 128, 64]);
    for (const l of flat) expect(l.error).toBeLessThan(1e-4);
    // A single quad cannot get simpler: no level.
    expect(s.levels(plane(1))).toEqual([]);
  });

  it('keeps a locked border where it is', async () => {
    const s = await loadMeshSimplifier();
    const n = 16;
    const mesh = plane(n);
    const border = (i: number): boolean => {
      const x = i % (n + 1);
      const z = Math.floor(i / (n + 1));
      return x === 0 || z === 0 || x === n || z === n;
    };
    const free = s.simplify(mesh, { ratio: 0.01, maxError: 0.01 });
    const locked = s.simplify(mesh, { ratio: 0.01, maxError: 0.01, lockBorder: true });
    const used = (ix: Uint32Array): Set<number> => new Set(ix);
    expect([...used(free.indices)].filter(border).length).toBe(4);
    // Every border vertex stays, so the edge still meets a neighbouring piece's.
    expect([...used(locked.indices)].filter(border).length).toBe(4 * n);
    expect(locked.triangles).toBeLessThan(mesh.indices.length / 3);
  });

  it('takes vertices without an index list and refuses a share outside (0, 1]', async () => {
    const s = await loadMeshSimplifier();
    const mesh = sphere(1, 32, 16);
    const unindexed = new Float32Array(mesh.indices.length * 3);
    mesh.indices.forEach((v, i) => unindexed.set(mesh.positions.subarray(v * 3, v * 3 + 3), i * 3));
    const out = s.simplify({ positions: unindexed, indices: null }, { ratio: 0.5 });
    // Unwelded triangles share no edges: nothing collapses, and no triangle is lost either.
    expect(out.triangles).toBeLessThanOrEqual(mesh.indices.length / 3);
    expect(() => s.simplify(mesh, { ratio: 0 })).toThrow(RangeError);
    expect(() => s.simplify(mesh, { ratio: 1.5 })).toThrow(RangeError);
  });
});
