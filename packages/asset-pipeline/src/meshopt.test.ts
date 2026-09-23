/**
 * The importer's EXT_meshopt_compression decoder against vectors encoded and
 * decoded by meshoptimizer 1.2.0 itself (fixtures/import-ext/meshopt-vectors.json):
 * every vertex filter, partial groups, several blocks, 16/32-bit triangle
 * streams and an index sequence. Malformed streams fail, never read out of range.
 */
import { describe, expect, it } from 'vitest';

import { decodeMeshopt, MeshoptError, type MeshoptFilter, type MeshoptMode } from './meshopt';
import { base64ToBytes } from './test-fixtures';

const RAW = import.meta.glob('../../../fixtures/import-ext/meshopt-vectors.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;
const doc = JSON.parse(Object.values(RAW)[0] as string) as {
  vectors: { name: string; count: number; stride: number; mode: MeshoptMode; filter: MeshoptFilter; encoded: string; decoded: string }[];
};

describe('EXT_meshopt_compression decoder (TS port) matches meshoptimizer', () => {
  it('has the vectors', () => expect(doc.vectors.length).toBeGreaterThanOrEqual(9));
  for (const v of doc.vectors) {
    it(`${v.name} (${v.mode}, ${v.filter}, ${v.count}×${v.stride})`, () => {
      const out = decodeMeshopt(base64ToBytes(v.encoded), v.count, v.stride, v.mode, v.filter);
      expect(Array.from(out)).toEqual(Array.from(base64ToBytes(v.decoded)));
    });
  }
});

describe('malformed streams are refused, never read out of range', () => {
  const v = doc.vectors.find((x) => x.name === 'positions-f32x3')!;
  const t = doc.vectors.find((x) => x.name === 'grid-triangles-u16')!;
  const enc = base64ToBytes(v.encoded);
  const tri = base64ToBytes(t.encoded);
  it('truncated vertex stream', () => {
    expect(() => decodeMeshopt(enc.subarray(0, enc.length - 40), v.count, v.stride, 'ATTRIBUTES')).toThrow(MeshoptError);
  });
  it('wrong header / wrong version', () => {
    const bad = enc.slice();
    bad[0] = 0xa1;
    expect(() => decodeMeshopt(bad, v.count, v.stride, 'ATTRIBUTES')).toThrow(/version 0/);
    expect(() => decodeMeshopt(tri, t.count, 2, 'ATTRIBUTES')).toThrow(MeshoptError);
  });
  it('a count that does not match the stream', () => {
    expect(() => decodeMeshopt(enc, v.count + 50, v.stride, 'ATTRIBUTES')).toThrow(MeshoptError);
  });
  it('truncated triangle stream', () => {
    expect(() => decodeMeshopt(tri.subarray(0, 40), t.count, 2, 'TRIANGLES')).toThrow(MeshoptError);
  });
  it('filters only on attributes; strides the extension allows', () => {
    expect(() => decodeMeshopt(tri, t.count, 2, 'TRIANGLES', 'OCTAHEDRAL')).toThrow(MeshoptError);
    expect(() => decodeMeshopt(tri, t.count, 3, 'TRIANGLES')).toThrow(MeshoptError);
    expect(() => decodeMeshopt(enc, v.count, 6, 'ATTRIBUTES')).toThrow(MeshoptError);
  });
});
