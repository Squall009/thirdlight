/**
 * The decal clipper on hand-made receivers: what lands inside the box, the
 * faces the normal fade leaves out, welding, the attributes, mirrored
 * matrices, bad input, and the same bytes run after run (pinned to the
 * clipper's version). Comparisons with three's DecalGeometry, real
 * generated receivers and the cost are in tests/decal-clip.test.ts.
 */
import { sha256Hex } from '@thirdlight/shared';
import { describe, expect, it } from 'vitest';

import { clipDecal, DECAL_CLIP_LIFT, DECAL_CLIP_VERSION, type DecalClipMesh, type DecalClipReceiver } from './decal-clip';

type M4 = number[];
/** Column-major translation × rotation (quaternion) × scale, three's `compose`. */
function compose(t: readonly number[], q: readonly number[] = [0, 0, 0, 1], s: readonly number[] = [1, 1, 1]): M4 {
  const [x, y, z, w] = q as [number, number, number, number];
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s as [number, number, number];
  return [(1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0, (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0, (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0, t[0]!, t[1]!, t[2]!, 1];
}
/** A quaternion turning by `deg` about a unit axis. */
const quat = (axis: readonly number[], deg: number): number[] => {
  const h = (deg * Math.PI) / 360;
  return [axis[0]! * Math.sin(h), axis[1]! * Math.sin(h), axis[2]! * Math.sin(h), Math.cos(h)];
};
/** A decal lying on the ground, projecting down (its −Z is the world's −Y). */
const DOWN = quat([1, 0, 0], -90);

/** An n × n grid of quads, `side` metres square, in the XZ plane at height 0, facing up; indexed with normals. */
function floor(n: number, side: number, opts: { normals?: boolean; indexed?: boolean } = {}): DecalClipReceiver {
  const pos: number[] = [];
  const nrm: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    pos.push((i / n - 0.5) * side, 0, (j / n - 0.5) * side);
    nrm.push(0, 1, 0);
  }
  const idx: number[] = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i;
    // Counter-clockwise seen from above.
    idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
  }
  if (opts.indexed === false) {
    const p: number[] = [];
    const q: number[] = [];
    for (const v of idx) {
      p.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
      q.push(0, 1, 0);
    }
    return { positions: new Float32Array(p), ...(opts.normals === false ? {} : { normals: new Float32Array(q) }) };
  }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx), ...(opts.normals === false ? {} : { normals: new Float32Array(nrm) }) };
}

/** Total area of a mesh's triangles. */
function area(m: DecalClipMesh): number {
  let a = 0;
  const p = m.positions;
  for (let t = 0; t < m.index.length; t += 3) {
    const [i, j, k] = [m.index[t]! * 3, m.index[t + 1]! * 3, m.index[t + 2]! * 3];
    const e = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!];
    const f = [p[k]! - p[i]!, p[k + 1]! - p[i + 1]!, p[k + 2]! - p[i + 2]!];
    a += 0.5 * Math.hypot(e[1]! * f[2]! - e[2]! * f[1]!, e[2]! * f[0]! - e[0]! * f[2]!, e[0]! * f[1]! - e[1]! * f[0]!);
  }
  return a;
}
/** Each triangle's normal by winding (entity space). */
function windingNormals(m: DecalClipMesh): number[][] {
  const out: number[][] = [];
  const p = m.positions;
  for (let t = 0; t < m.index.length; t += 3) {
    const [i, j, k] = [m.index[t]! * 3, m.index[t + 1]! * 3, m.index[t + 2]! * 3];
    const e = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!];
    const f = [p[k]! - p[i]!, p[k + 1]! - p[i + 1]!, p[k + 2]! - p[i + 2]!];
    const c = [e[1]! * f[2]! - e[2]! * f[1]!, e[2]! * f[0]! - e[0]! * f[2]!, e[0]! * f[1]! - e[1]! * f[0]!];
    const l = Math.hypot(c[0]!, c[1]!, c[2]!);
    out.push(c.map((v) => v / l));
  }
  return out;
}
const bytesOf = (m: DecalClipMesh): Uint8Array => {
  const parts = [m.positions, m.normals, m.uvs, m.tangents, m.fades, m.index];
  const out = new Uint8Array(parts.reduce((s, a) => s + a.byteLength, 0));
  let o = 0;
  for (const a of parts) {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), o);
    o += a.byteLength;
  }
  return out;
};

describe('decal clipper', () => {
  it('cuts a floor to the box: area, positions in the entity space, lifted along the normal, UVs and fades', () => {
    const m = clipDecal({ matrix: compose([0.3, 0, -0.2], DOWN), size: [1, 0.5, 2] }, [floor(10, 4)]);
    expect(area(m)).toBeCloseTo(0.5, 9);
    expect(m.positions.length / 3).toBe(m.normals.length / 3);
    for (let v = 0; v < m.positions.length / 3; v++) {
      const [x, y, z] = [m.positions[v * 3]!, m.positions[v * 3 + 1]!, m.positions[v * 3 + 2]!];
      // The floor at world y = 0 is the entity's z = 0, lifted toward the projector (+Z).
      expect(z).toBeCloseTo(DECAL_CLIP_LIFT, 6);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.25 + 1e-6);
      expect(m.normals[v * 3 + 2]!).toBeCloseTo(1, 6);
      // u follows +X, v runs down the image (+Y up).
      expect(m.uvs[v * 2]!).toBeCloseTo(x + 0.5, 6);
      expect(m.uvs[v * 2 + 1]!).toBeCloseTo(0.5 - y / 0.5, 6);
      expect(m.tangents[v * 4]!).toBeCloseTo(1, 6);
      expect(m.tangents[v * 4 + 3]).toBe(1);
      // In the middle of the box's depth: no edge fade, facing the projector.
      expect(m.fades[v]).toBe(1);
    }
    // Every triangle faces the projector (+Z): front faces stay front faces.
    for (const n of windingNormals(m)) expect(n[2]!).toBeGreaterThan(0.999);
    expect(m.index).toBeInstanceOf(Uint16Array);
  });

  it('puts UVs into the page rectangle', () => {
    const m = clipDecal({ matrix: compose([0, 0, 0], DOWN), size: [1, 1, 1], rect: [0.25, 0.5, 0.5, 0.625] }, [floor(4, 4)]);
    let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (let v = 0; v < m.uvs.length / 2; v++) {
      lo = [Math.min(lo[0]!, m.uvs[v * 2]!), Math.min(lo[1]!, m.uvs[v * 2 + 1]!)];
      hi = [Math.max(hi[0]!, m.uvs[v * 2]!), Math.max(hi[1]!, m.uvs[v * 2 + 1]!)];
    }
    expect(lo[0]).toBeCloseTo(0.25, 6);
    expect(hi[0]).toBeCloseTo(0.5, 6);
    expect(lo[1]).toBeCloseTo(0.5, 6);
    expect(hi[1]).toBeCloseTo(0.625, 6);
  });

  it('welds: an indexed and an unindexed floor give the same mesh, shared corners once', () => {
    const box = { matrix: compose([0.13, 0, 0.07], mul(quat([0, 1, 0], 30), DOWN)), size: [1.3, 1.1, 1] };
    const a = clipDecal(box, [floor(8, 4)]);
    const b = clipDecal(box, [floor(8, 4, { indexed: false })]);
    expect(bytesOf(b)).toEqual(bytesOf(a));
    // A connected flat patch: Euler's V − E + F = 1, so its vertices are about half its triangles (none split).
    const tris = a.index.length / 3;
    const edges = new Set<string>();
    for (let t = 0; t < a.index.length; t += 3) for (let k = 0; k < 3; k++) {
      const [i, j] = [a.index[t + k]!, a.index[t + ((k + 1) % 3)]!];
      edges.add(i < j ? `${i},${j}` : `${j},${i}`);
    }
    expect(a.positions.length / 3 - edges.size + tris).toBe(1);
  });

  it('flat faces without normals: each triangle its own normal; same area as with them', () => {
    const p = { matrix: compose([0, 0, 0], DOWN), size: [1, 1, 1] };
    const a = clipDecal(p, [floor(6, 3)]);
    const b = clipDecal(p, [floor(6, 3, { normals: false })]);
    expect(area(b)).toBeCloseTo(area(a), 9);
    expect(b.normals[2]!).toBeCloseTo(1, 6);
  });

  it('a box over a corner marks both faces when the fade allows, only the facing one when it does not', () => {
    // An L: a floor (y = 0, x < 0) and a wall at x = 0 facing −X, the box across the corner, projecting 45° down toward +X.
    const floorL: DecalClipReceiver = { positions: new Float32Array([-2, 0, -2, -2, 0, 2, 0, 0, 2, 0, 0, -2]), index: new Uint16Array([0, 1, 2, 0, 2, 3]) };
    const wall: DecalClipReceiver = { positions: new Float32Array([0, 0, -2, 0, 0, 2, 0, 2, 2, 0, 2, -2]), index: new Uint16Array([0, 1, 2, 0, 2, 3]) };
    // −Z of the box points down and toward +X: the down-facing box turned 45° about Z, so −Z = (1, −1, 0)/√2.
    const q45 = mul(quat([0, 0, 1], 45), DOWN);
    const at = compose([0, 0, 0], q45);
    const both = clipDecal({ matrix: at, size: [1, 1, 1] }, [floorL, wall]);
    const faces = windingNormals(both);
    const up = faces.filter((n) => worldOf(at, n)[1]! > 0.99).length;
    const side = faces.filter((n) => worldOf(at, n)[0]! < -0.99).length;
    expect(up).toBeGreaterThan(0);
    expect(side).toBeGreaterThan(0);
    // Each face is met at 45°: inside a 60° fade both stay; inside 40° neither does (both 45° off the projector).
    expect(area(clipDecal({ matrix: at, size: [1, 1, 1], normalFade: 60 }, [floorL, wall]))).toBeCloseTo(area(both), 9);
    const none = clipDecal({ matrix: at, size: [1, 1, 1], normalFade: 40 }, [floorL, wall]);
    expect(none.index.length).toBe(0);
    expect(none.stats.faded).toBe(4);
    // The fade ramps over its last fifth: 45° of a 50° fade (ramp 40–50°) is partly faded.
    const ramp = clipDecal({ matrix: at, size: [1, 1, 1], normalFade: 50, edgeFade: [0, 0] }, [floorL, wall]);
    for (const f of ramp.fades) expect(f).toBeLessThan(1);
    expect(Math.max(...ramp.fades)).toBeGreaterThan(0.3);
  });

  it('leaves out back faces and grazing faces past the fade; 180° keeps them all', () => {
    const p = compose([0, 0, 0], DOWN);
    const back: DecalClipReceiver = { positions: new Float32Array([-1, 0, -1, 1, 0, -1, -1, 0, 1]) }; // clockwise from above: faces down
    const grazing: DecalClipReceiver = { positions: new Float32Array([-1, -0.4, 0, 1, -0.4, 0, 0, 0.4, 0.001]) }; // nearly vertical
    const m = clipDecal({ matrix: p, size: [1, 1, 1] }, [back, grazing]);
    expect(m.index.length).toBe(0);
    expect(m.stats.faded).toBe(2);
    const all = clipDecal({ matrix: p, size: [1, 1, 1], normalFade: 180 }, [back, grazing]);
    expect(all.index.length).toBeGreaterThan(0);
    expect(all.stats.faded).toBe(0);
  });

  it('fades toward the box ends, as projected decals do', () => {
    // A ramp from the box's front to its back: the fade climbs from 0 at the front over 30 % and falls over the last 30 %.
    const ramp: DecalClipReceiver = { positions: new Float32Array([-0.5, 0.5, -0.4, 0.5, 0.5, -0.4, 0.5, -0.5, 0.4, -0.5, -0.5, 0.4]), index: new Uint8Array([0, 2, 1, 0, 3, 2]) };
    const m = clipDecal({ matrix: compose([0, 0, 0], DOWN), size: [0.8, 0.8, 0.8], normalFade: 180, lift: 0 }, [ramp]);
    for (let v = 0; v < m.fades.length; v++) {
      const depth = 0.5 - m.positions[v * 3 + 2]! / 0.8;
      const want = Math.min(1, Math.max(0, depth / 0.3)) * Math.min(1, Math.max(0, (1 - depth) / 0.3));
      expect(m.fades[v]!).toBeCloseTo(want, 5);
    }
  });

  it('degenerate triangles, out-of-range indices and empty receivers add nothing', () => {
    const r: DecalClipReceiver = {
      positions: new Float32Array([0, 0, 0, 0.1, 0, 0, 0.2, 0, 0, 0, 0, 0.1]),
      index: new Uint32Array([0, 1, 2, /* collinear */ 0, 0, 3, /* repeated */ 0, 3, 9 /* out of range */]),
    };
    const m = clipDecal({ matrix: compose([0, 0, 0], DOWN), size: [1, 1, 1] }, [r, { positions: new Float32Array(0) }, { positions: new Float32Array(9), matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1] }]);
    expect(m.index.length).toBe(0);
    expect(m.stats.degenerate).toBe(2);
    // A decal with a singular matrix marks nothing.
    expect(clipDecal({ matrix: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], size: [1, 1, 1] }, [floor(2, 2)]).index.length).toBe(0);
  });

  it('a mirrored receiver or decal keeps its triangles facing the projector', () => {
    const at = compose([0, 0, 0], DOWN);
    const mirrored = { ...floor(4, 4), matrix: compose([0, 0, 0], [0, 0, 0, 1], [-1, 1, 1]) };
    for (const n of windingNormals(clipDecal({ matrix: at, size: [1, 1, 1] }, [mirrored]))) expect(n[2]!).toBeGreaterThan(0.999);
    // A decal mirrored in X: its mesh is front-facing in its own space (three turns the side of a mirrored object).
    const flipped = compose([0, 0, 0], DOWN, [-1, 1, 1]);
    const m = clipDecal({ matrix: flipped, size: [1, 1, 1] }, [floor(4, 4)]);
    expect(area(m)).toBeCloseTo(1, 9);
    for (const n of windingNormals(m)) expect(n[2]!).toBeGreaterThan(0.999);
  });

  it('scaled and rotated receivers and decals: the box is the entity size × its scale', () => {
    const r = { ...floor(5, 1), matrix: compose([1, 2, 3], quat([0, 1, 0], 17), [4, 4, 4]) };
    const m = clipDecal({ matrix: compose([1, 2, 3], mul(quat([0, 1, 0], -40), DOWN), [2, 2, 2]), size: [0.5, 0.25, 1] }, [r]);
    // Entity space is unscaled box units: 0.5 × 0.25, worth 1 × 0.5 m in the world.
    expect(area(m)).toBeCloseTo(0.125, 7);
    for (let v = 0; v < m.positions.length / 3; v++) expect(m.positions[v * 3 + 2]!).toBeCloseTo(DECAL_CLIP_LIFT / 2, 6);
  });

  it('tangents: unit, along +u on the surface, handedness toward the image up', () => {
    const sphere = uvSphere(24, 16, 1);
    const m = clipDecal({ matrix: compose([0, 0, 1.2], [0, 0, 0, 1]), size: [1.2, 1.2, 1.2], normalFade: 89 }, [sphere]);
    expect(m.index.length).toBeGreaterThan(0);
    for (let v = 0; v < m.positions.length / 3; v++) {
      const t = m.tangents.subarray(v * 4, v * 4 + 3);
      const n = m.normals.subarray(v * 3, v * 3 + 3);
      expect(Math.hypot(t[0]!, t[1]!, t[2]!)).toBeCloseTo(1, 5);
      expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 5);
      expect(t[0]! * n[0]! + t[1]! * n[1]! + t[2]! * n[2]!).toBeCloseTo(0, 5);
      expect(t[0]!).toBeGreaterThan(0);
      // On the sphere's front (facing the projector), the bitangent n × t points up (+Y).
      expect(m.tangents[v * 4 + 3]).toBe(1);
    }
  });

  it('many receivers: the same as their triangles in one receiver, in the given order', () => {
    const pieces: DecalClipReceiver[] = [];
    for (let i = 0; i < 64; i++) pieces.push({ ...floor(2, 0.5), matrix: compose([((i % 8) - 3.5) * 0.5, 0, (Math.floor(i / 8) - 3.5) * 0.5]) });
    const p = { matrix: compose([0.1, 0, 0.1], DOWN), size: [2.2, 1.7, 1] };
    const m = clipDecal(p, pieces);
    expect(area(m)).toBeCloseTo(2.2 * 1.7, 6);
    expect(m.stats.triangles).toBeLessThan(64 * 8);
    expect(bytesOf(clipDecal(p, pieces))).toEqual(bytesOf(m));
  });

  it('the same bytes run after run, pinned to the clipper version', () => {
    const run = (): DecalClipMesh =>
      clipDecal({ matrix: compose([0.31, 0.2, -0.17], mul(quat([0.6, 0, 0.8], 23), DOWN), [1.5, 1.5, 1.5]), size: [0.9, 0.7, 1.1], normalFade: 75, edgeFade: [0.2, 0.4], rect: [0.1, 0.2, 0.3, 0.4] }, [
        uvSphere(20, 12, 0.6),
        { ...floor(9, 3, { normals: false }), matrix: compose([0, -0.3, 0], quat([1, 0, 0], 8)) },
      ]);
    const a = bytesOf(run());
    expect(bytesOf(run())).toEqual(a);
    // A change of this digest is a change of the output: bump DECAL_CLIP_VERSION with it (caches are keyed by it).
    expect({ version: DECAL_CLIP_VERSION, digest: sha256Hex(a) }).toEqual({ version: 1, digest: PINNED });
  });
});

const PINNED = 'a45e1e29120fe06a8e6ae7ebaa8e0c554855c48b84eab8f836401860394a78d6';

function mul(a: readonly number[], b: readonly number[]): number[] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}
/** An entity-space direction in the world (the matrix's linear part, renormalised). */
function worldOf(m: M4, d: readonly number[]): number[] {
  const v = [0, 1, 2].map((r) => m[r]! * d[0]! + m[4 + r]! * d[1]! + m[8 + r]! * d[2]!);
  const l = Math.hypot(v[0]!, v[1]!, v[2]!);
  return v.map((x) => x / l);
}
/** A UV sphere (three's layout: rows from the top, poles with degenerate triangles), indexed, with normals. */
function uvSphere(w: number, h: number, radius: number): DecalClipReceiver {
  const pos: number[] = [];
  const nrm: number[] = [];
  for (let y = 0; y <= h; y++) for (let x = 0; x <= w; x++) {
    const u = x / w, v = y / h;
    const px = -Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI), py = Math.cos(v * Math.PI), pz = Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
    pos.push(px * radius, py * radius, pz * radius);
    nrm.push(px, py, pz);
  }
  const idx: number[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = y * (w + 1) + x + 1, b = y * (w + 1) + x, c = (y + 1) * (w + 1) + x, d = (y + 1) * (w + 1) + x + 1;
    idx.push(a, b, d, b, c, d);
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nrm), index: new Uint32Array(idx) };
}
