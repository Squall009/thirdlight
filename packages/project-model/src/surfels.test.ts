import { describe, expect, it } from 'vitest';

import { buildDistanceBrickSet, buildDistanceBricks } from './distance-bricks-build';
import { decodeDistanceBricks, encodeDistanceBricks } from './distance-bricks';
import { buildSurfelSet, surfelCoverage, surfelFacing, type SurfelSource } from './surfels';

type V3 = [number, number, number];

/** An axis box's 12 triangles (outward), with a UV1 per vertex when asked. */
function box(lo: V3, hi: V3, uv1: boolean): SurfelSource {
  const positions: V3[] = [];
  const triangles: number[][] = [];
  const uv: number[] = [];
  for (let axis = 0; axis < 3; axis += 1) {
    for (const side of [0, 1]) {
      const [u, v] = (axis === 0 ? [1, 2] : axis === 1 ? [2, 0] : [0, 1]) as [number, number];
      const at = positions.length;
      for (const [a, b] of [[0, 0], [1, 0], [1, 1], [0, 1]] as const) {
        const p: V3 = [0, 0, 0];
        p[axis] = side === 0 ? lo[axis]! : hi[axis]!;
        p[u] = a === 0 ? lo[u]! : hi[u]!;
        p[v] = b === 0 ? lo[v]! : hi[v]!;
        positions.push(p);
        uv.push((axis * 2 + side + a) / 7, b);
      }
      triangles.push(side === 1 ? [at, at + 1, at + 2] : [at, at + 2, at + 1], side === 1 ? [at, at + 2, at + 3] : [at, at + 3, at + 2]);
    }
  }
  return { positions, triangles, uv1: uv1 ? uv : null };
}

/** Points spread over every triangle (fixed sequence) with each triangle's normal. */
function surfacePoints(parts: readonly SurfelSource[], count: number): { p: V3; n: V3 }[] {
  const out: { p: V3; n: V3 }[] = [];
  let seed = 12345;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (const part of parts) {
    for (const t of part.triangles) {
      const [a, b, c] = t.map((i) => part.positions[i]!) as [readonly number[], readonly number[], readonly number[]];
      const e1 = [0, 1, 2].map((k) => b[k]! - a[k]!);
      const e2 = [0, 1, 2].map((k) => c[k]! - a[k]!);
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const l = Math.hypot(n[0]!, n[1]!, n[2]!);
      for (let i = 0; i < count; i += 1) {
        let s = rnd();
        let r = rnd();
        if (s + r > 1) [s, r] = [1 - s, 1 - r];
        out.push({ p: [0, 1, 2].map((k) => a[k]! + e1[k]! * s + e2[k]! * r) as V3, n: n.map((x) => x / l) as V3 });
      }
    }
  }
  return out;
}

describe('surfels', () => {
  const crate = box([0, 0, 0], [1.2, 0.8, 0.6], true);
  // A wall one centimetre thick: thinner than a cell, so its two sides share every cell.
  const wall = box([2, 0, 0], [2.01, 1, 1], false);

  it('nest coarse to fine and cover every point of the surface at each level', () => {
    const s = buildSurfelSet([crate, wall], 0.1)!;
    expect(s.levels[0]).toBe(s.positions.length / 3);
    for (let k = 1; k < s.levels.length; k += 1) expect(s.levels[k]!).toBeLessThan(s.levels[k - 1]!);
    expect(s.levels[s.levels.length - 1]!).toBeLessThanOrEqual(48);
    // Area: the crate's 4.32 m² and the wall's 2.04 m².
    expect(s.area).toBeCloseTo(2 * (1.2 * 0.8 + 1.2 * 0.6 + 0.8 * 0.6) + 2 * (0.01 + 0.01 + 1), 5);
    const pts = surfacePoints([crate, wall], 40);
    for (let k = 0; k < s.levels.length; k += 1) {
      const n = s.levels[k]!;
      const bound = surfelCoverage(0.1, k);
      let worst = 0;
      for (const { p, n: normal } of pts) {
        const facing = surfelFacing(normal);
        let best = Infinity;
        for (let i = 0; i < n; i += 1) {
          if (surfelFacing([s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!]) !== facing) continue;
          best = Math.min(best, Math.hypot(s.positions[i * 3]! - p[0], s.positions[i * 3 + 1]! - p[1], s.positions[i * 3 + 2]! - p[2]));
        }
        worst = Math.max(worst, best);
      }
      expect(worst, `level ${k}`).toBeLessThanOrEqual(bound);
    }
  });

  it('keep both sides of a wall thinner than a cell apart', () => {
    const s = buildSurfelSet([wall], 0.1)!;
    const facings = new Set<number>();
    for (let i = 0; i < s.levels[0]!; i += 1) facings.add(surfelFacing([s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!]));
    expect(facings).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    // About one surfel per 10 cm cell on each 1 m² side.
    const big = Array.from({ length: s.levels[0]! }, (_, i) => surfelFacing([s.normals[i * 3]!, s.normals[i * 3 + 1]!, s.normals[i * 3 + 2]!]));
    expect(big.filter((f) => f === 0).length).toBeGreaterThanOrEqual(100);
    expect(big.filter((f) => f === 1).length).toBeGreaterThanOrEqual(100);
  });

  it('carry UV1 only when every triangle has it, and are the same for the same triangles', () => {
    expect(buildSurfelSet([crate], 0.1)!.uv1).not.toBeNull();
    expect(buildSurfelSet([crate, wall], 0.1)!.uv1).toBeNull();
    const a = buildSurfelSet([crate], 0.1)!;
    const b = buildSurfelSet([crate], 0.1)!;
    expect(a.positions).toEqual(b.positions);
    // Each surfel's UV1 is its point's: the crate's +x face holds u in [2/7, 3/7].
    for (let i = 0; i < a.levels[0]!; i += 1) {
      if (a.normals[i * 3]! > 0.99) {
        expect(a.uv1![i * 2]!).toBeGreaterThanOrEqual(1 / 7 - 1e-6);
        expect(a.uv1![i * 2]!).toBeLessThanOrEqual(3 / 7 + 1e-6);
      }
    }
  });

  it('travel in the distance-brick blob with the field, made at its voxel', () => {
    const set = buildDistanceBrickSet('', [crate])!;
    expect(set.surfels).not.toBeNull();
    expect(set.surfels!.spacing).toBe(set.voxel);
    const back = decodeDistanceBricks(encodeDistanceBricks({ sets: [set, { ...set, piece: 'b', surfels: null }] }))!;
    expect(back.sets).toHaveLength(2);
    const s = back.sets[0]!.surfels!;
    expect(s.levels).toEqual(set.surfels!.levels);
    expect(s.area).toBeCloseTo(set.surfels!.area, 4);
    for (let i = 0; i < s.positions.length; i += 1) expect(Math.abs(s.positions[i]! - set.surfels!.positions[i]!)).toBeLessThan(1.2 / 65535 + 1e-6);
    for (let i = 0; i < s.uv1!.length; i += 1) expect(Math.abs(s.uv1![i]! - set.surfels!.uv1![i]!)).toBeLessThan(1e-4);
    for (let i = 0; i < s.levels[0]!; i += 1) {
      const d = s.normals[i * 3]! * set.surfels!.normals[i * 3]! + s.normals[i * 3 + 1]! * set.surfels!.normals[i * 3 + 1]! + s.normals[i * 3 + 2]! * set.surfels!.normals[i * 3 + 2]!;
      expect(d).toBeGreaterThan(0.999);
    }
    expect(back.sets[1]!.surfels).toBeNull();
    // A model read with its UV1: each piece's set carries it.
    const g = { primitives: [{ piece: 'crate', collision: false, higherLod: false, pieceCollision: false, occluder: false, positions: crate.positions as V3[], triangles: crate.triangles as V3[], node: 'crate', primitive: 0, local: [], uv1: crate.uv1 }], skipped: [] };
    expect(buildDistanceBricks(g).sets[0]!.surfels!.uv1).not.toBeNull();
  });
});
