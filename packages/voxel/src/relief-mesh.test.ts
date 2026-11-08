import { describe, expect, it } from 'vitest';
import { POSITION_STEPS_PER_CELL, SURFACE_VERTEX_BYTES, type SurfaceBuffer } from './derived-mesh';
import { sectionLocalOrigin } from './derive-assembly';
import { sectionRelief } from './stream-handlers';
import { RELIEF_FREE, RELIEF_SUBDIVISIONS, reliefNeighbourBit, subdivideSurface, type CreaseRule, type ReliefSurface } from './relief-mesh';

const S = POSITION_STEPS_PER_CELL;

/** A surface from vertices (cells from one cell below the unit's corner, and a normal) and triangles. */
function surface(points: ReadonlyArray<readonly [number, number, number]>, normal: readonly [number, number, number], tris: readonly number[]): SurfaceBuffer {
  const vertices = new Uint8Array(points.length * SURFACE_VERTEX_BYTES);
  const view = new DataView(vertices.buffer);
  points.forEach((p, v) => {
    for (let k = 0; k < 3; k++) {
      view.setUint16(v * SURFACE_VERTEX_BYTES + 2 * k, Math.round(p[k]! * S), true);
      view.setInt8(v * SURFACE_VERTEX_BYTES + 8 + k, normal[k]! * 127);
    }
  });
  return { vertexCount: points.length, vertices, indices: new Uint16Array(tris) };
}

const smooth: CreaseRule = { vertex: () => false, edge: () => false, sharedReachSteps: 0 };

function positions(r: ReliefSurface): number[][] {
  const view = new DataView(r.vertices.buffer, r.vertices.byteOffset, r.vertices.byteLength);
  return Array.from({ length: r.vertexCount }, (_, v) => [0, 1, 2].map((k) => view.getUint16(v * SURFACE_VERTEX_BYTES + 2 * k, true)));
}

/** Every triangle edge by position, counted. */
function edges(r: ReliefSurface): Map<string, number> {
  const p = positions(r);
  const out = new Map<string, number>();
  for (let t = 0; t < r.indices.length; t += 3) for (let k = 0; k < 3; k++) {
    const a = p[r.indices[t + k]!]!.join(',');
    const b = p[r.indices[t + ((k + 1) % 3)]!]!.join(',');
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** A unit cell's top face (y = 1 in the unit, 2 in steps from one cell below), two triangles, counter-clockwise from +y. */
const cellTop = (x: number, z: number): SurfaceBuffer =>
  surface(
    [
      [x + 1, 2, z + 1],
      [x + 1, 2, z + 2],
      [x + 2, 2, z + 2],
      [x + 2, 2, z + 1],
    ],
    [0, 1, 0],
    [0, 1, 2, 0, 2, 3],
  );

describe('relief mesh subdivision', () => {
  it('lays an n × n lattice over a cell face, every vertex on the 1/n lattice', () => {
    for (const n of RELIEF_SUBDIVISIONS) {
      const r = subdivideSurface(cellTop(0, 0), 16, n, 0, smooth);
      expect(r.indices.length / 3, `n ${n}`).toBe(2 * n * n);
      expect(r.vertexCount, `n ${n}`).toBe((n + 1) * (n + 1));
      for (const p of positions(r)) for (const c of p) expect(c % (S / n), `n ${n}`).toBe(0);
      expect([...r.crease].every((w) => w === RELIEF_FREE)).toBe(true);
    }
  });

  it('gives a crease edge and its ends weight 0 and keeps the points inside free', () => {
    const top = cellTop(0, 0);
    // The face's x = 1 edge (vertices 0 and 1) is a crease.
    const rule: CreaseRule = { vertex: (v) => v === 0 || v === 1, edge: (a, b) => (a === 0 && b === 1) || (a === 1 && b === 0), sharedReachSteps: 0 };
    const r = subdivideSurface(top, 16, 4, 0, rule);
    const p = positions(r);
    p.forEach((q, v) => expect(r.crease[v], q.join(',')).toBe(q[0] === S ? 0 : RELIEF_FREE));
  });

  it('splits a shared edge at the same points on both sides, whatever the triangles beside it', () => {
    // Two units (sections) meeting along the x = 1 plane: a unit square on one side, a long thin triangle on the other.
    const a = surface([[1, 2, 1], [1, 2, 3], [2, 2, 3], [2, 2, 1]], [0, 1, 0], [0, 1, 2, 0, 2, 3]);
    const b = surface([[0.25, 2, 2], [1, 2, 3], [1, 2, 1]], [0, 1, 0], [0, 1, 2]);
    for (const n of RELIEF_SUBDIVISIONS) {
      const onPlane = (r: ReliefSurface): string[] => positions(r).filter((q) => q[0] === S).map((q) => q.join(',')).sort();
      expect(onPlane(subdivideSurface(b, 16, n, 0, smooth)), `n ${n}`).toEqual(onPlane(subdivideSurface(a, 16, n, 0, smooth)));
    }
  });

  it('splits every edge to at most 1.5 / n cells and keeps the surface closed inside', () => {
    const sliver = surface([[1, 2, 1], [9, 2, 1.4], [5, 2, 3], [9, 2, 3]], [0, 1, 0], [0, 2, 1, 1, 2, 3]);
    for (const n of RELIEF_SUBDIVISIONS) {
      const r = subdivideSurface(sliver, 16, n, 0, smooth);
      const p = positions(r);
      for (let t = 0; t < r.indices.length; t += 3) for (let k = 0; k < 3; k++) {
        const q = p[r.indices[t + k]!]!;
        const w = p[r.indices[t + ((k + 1) % 3)]!]!;
        expect(Math.max(...[0, 1, 2].map((c) => Math.abs(q[c]! - w[c]!)))).toBeLessThanOrEqual(Math.ceil((1.5 * S) / n));
      }
      // The inside edges each have two triangles; only the outline's have one, and the outline is the source's.
      const open = [...edges(r)].filter(([, c]) => c !== 2);
      expect(open.every(([, c]) => c === 1)).toBe(true);
      const area = (s: { indices: ArrayLike<number> }, pts: number[][]): number => {
        let sum = 0;
        for (let t = 0; t < s.indices.length; t += 3) {
          const [u, v, w] = [0, 1, 2].map((k) => pts[s.indices[t + k]!]!);
          sum += Math.abs((v![0]! - u![0]!) * (w![2]! - u![2]!) - (w![0]! - u![0]!) * (v![2]! - u![2]!)) / 2;
        }
        return sum;
      };
      const src = positions({ ...sliver, crease: new Uint8Array(0) });
      expect(area(r, p) / area(sliver, src)).toBeCloseTo(1, 4);
    }
  });

  it('keeps the edges on a face toward a plain neighbour whole and fixed', () => {
    // The cell's face lies against the unit's x = 0 face (its edge at x = 1 in steps from one cell below).
    const r = subdivideSurface(cellTop(0, 0), 16, 8, reliefNeighbourBit(-1, 0, 0), smooth);
    const p = positions(r);
    const onFace = p.map((q, v) => [q, v] as const).filter(([q]) => q[0] === S);
    expect(onFace.map(([q]) => q[2]).sort()).toEqual([S, 2 * S]);
    for (const [, v] of onFace) expect(r.crease[v]).toBe(0);
    // Away from it: the lattice as before, and free.
    expect(p.filter((q) => q[0] === 2 * S)).toHaveLength(9);
  });

  it('is deterministic: the same surface gives the same bytes', () => {
    const s = surface([[1, 2, 1], [7.3, 2.6, 1.1], [3.9, 4.2, 6.6]], [0, 1, 0], [0, 1, 2]);
    const a = subdivideSurface(s, 16, 8, 0, smooth);
    const b = subdivideSurface(s, 16, 8, 0, smooth);
    expect([...a.vertices]).toEqual([...b.vertices]);
    expect([...a.indices]).toEqual([...b.indices]);
    expect([...a.crease]).toEqual([...b.crease]);
  });

  it('gives a section the plain neighbours of its chunk across the chunk faces it touches, none inside the chunk', () => {
    // A 32³ chunk of 16³ sections whose +x neighbour chunk (and only it) is plain.
    const plainChunks = reliefNeighbourBit(1, 0, 0);
    for (let id = 0; id < 8; id++) {
      const [x, y, z] = sectionLocalOrigin(32, 16, id).map((c) => c / 16) as [number, number, number];
      const o = sectionRelief(32, 16, id, 4, plainChunks);
      // Past the +x face, the neighbours that stay level with the chunk (the others lie in chunks diagonal to it, drawn with relief).
      let expected = 0;
      if (x === 1) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) if (y + dy >= 0 && y + dy < 2 && z + dz >= 0 && z + dz < 2) expected |= reliefNeighbourBit(1, dy, dz);
      expect(o.plainNeighbours, `section ${id}`).toBe(expected);
      expect(o.n).toBe(4);
    }
  });
});
