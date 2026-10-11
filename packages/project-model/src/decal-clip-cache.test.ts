import { describe, expect, it } from 'vitest';

import { clipDecal, DECAL_CLIP_VERSION } from './decal-clip';
import { decalClipGeometryHash, decalClipKey, decodeDecalClipMesh, encodeDecalClipMesh, sortDecalClipReceivers } from './decal-clip-cache';

const ID = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const at = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/** A floor of n × n quads 1 m apart round the origin, facing +Z (the decal projects along −Z onto it). */
function floor(n: number): { positions: Float32Array; normals: Float32Array; index: Uint16Array | Uint32Array } {
  const positions: number[] = [];
  const normals: number[] = [];
  const index: number[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push(i - n / 2, j - n / 2, 0), normals.push(0, 0, 1);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i;
    index.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1);
  }
  const vc = positions.length / 3;
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), index: vc > 0xffff ? new Uint32Array(index) : new Uint16Array(index) };
}

describe('clipped decal cache', () => {
  it('a mesh survives its bytes, 16- and 32-bit indices alike', () => {
    const small = clipDecal({ matrix: ID, size: [3.6, 3.6, 1] }, [floor(4)]);
    // Past 65,536 vertices the index is 32-bit (made up: a clip that large takes seconds).
    const vc = 70_000;
    const fill = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => (i % 97) / 7);
    const wide = { positions: fill(vc * 3), normals: fill(vc * 3), uvs: fill(vc * 2), tangents: fill(vc * 4), fades: fill(vc), index: Uint32Array.from({ length: 3000 }, (_, i) => (i * 23) % vc), stats: { triangles: 0, faded: 0, degenerate: 0 } };
    for (const m of [small, wide]) {
      expect(m.index.length).toBeGreaterThan(0);
      const back = decodeDecalClipMesh(encodeDecalClipMesh(m))!;
      expect(back).not.toBeNull();
      expect(back.index.constructor).toBe(m.index.constructor);
      const same = (a: ArrayBufferView, b: ArrayBufferView): boolean => {
        const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
        const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
        return x.length === y.length && x.every((v, i) => v === y[i]);
      };
      for (const k of ['positions', 'normals', 'uvs', 'tangents', 'fades', 'index'] as const) expect(same(back[k], m[k]), k).toBe(true);
    }
  });

  it('an empty mesh survives too; other bytes and another version are refused', () => {
    const empty = clipDecal({ matrix: at(0, 0, 50), size: [1, 1, 1] }, [floor(2)]);
    expect(empty.index.length).toBe(0);
    expect(decodeDecalClipMesh(encodeDecalClipMesh(empty))!.positions.length).toBe(0);
    expect(decodeDecalClipMesh(new Uint8Array(40))).toBeNull();
    const bytes = encodeDecalClipMesh(empty);
    new DataView(bytes.buffer).setUint32(4, DECAL_CLIP_VERSION + 1, true);
    expect(decodeDecalClipMesh(bytes)).toBeNull();
  });

  it('geometry hashes follow the values, not the arrays', () => {
    const a = floor(3);
    const b = floor(3);
    expect(decalClipGeometryHash(a.positions, a.normals, a.index)).toBe(decalClipGeometryHash(b.positions, b.normals, b.index));
    b.positions[4] = b.positions[4]! + 1e-6;
    expect(decalClipGeometryHash(a.positions, a.normals, a.index)).not.toBe(decalClipGeometryHash(b.positions, b.normals, b.index));
    expect(decalClipGeometryHash(a.positions, null, a.index)).not.toBe(decalClipGeometryHash(a.positions, a.normals, a.index));
    expect(decalClipGeometryHash(a.positions, a.normals, null)).not.toBe(decalClipGeometryHash(a.positions, a.normals, a.index));
  });

  it('keys name every input and not the order receivers were found in', () => {
    const p = { matrix: ID, size: [1, 1, 1] };
    const r1 = { geometry: 'aaaa', matrix: at(0, 0, 0) };
    const r2 = { geometry: 'bbbb', matrix: at(1, 0, 0) };
    const key = decalClipKey(p, sortDecalClipReceivers([r1, r2]));
    expect(key.startsWith(`${DECAL_CLIP_VERSION}-`)).toBe(true);
    expect(decalClipKey(p, sortDecalClipReceivers([r2, r1]))).toBe(key);
    expect(decalClipKey({ ...p, size: [1, 1, 2] }, [r1, r2])).not.toBe(key);
    expect(decalClipKey({ ...p, normalFade: 60 }, [r1, r2])).not.toBe(key);
    expect(decalClipKey({ ...p, edgeFade: [0.1, 0.3] }, [r1, r2])).not.toBe(key);
    expect(decalClipKey({ ...p, matrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, [r1, r2])).not.toBe(key);
    expect(decalClipKey(p, [r1, { ...r2, matrix: at(1, 0, 1e-4) }])).not.toBe(key);
    expect(decalClipKey(p, [r1, { ...r2, geometry: 'cccc' }])).not.toBe(key);
    expect(decalClipKey(p, [r1])).not.toBe(key);
    // The same key run to run.
    expect(decalClipKey(p, [r1, r2])).toBe(key);
  });
});
