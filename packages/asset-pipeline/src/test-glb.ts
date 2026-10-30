/**
 * Test-only synthetic GLB builder (NOT public surface; imported only by
 * `*.test.ts` files).
 *
 * The committed fixtures are exercised exactly through `test-fixtures.ts`; this
 * helper exists for adversarial cases that cannot be committed (a >32 MiB
 * source, a 2 000 001-vertex model, a bare chunk-framing mutation) and for
 * mutations of a valid fixture that must still be real GLB containers. It
 * builds (and reads) the container with the same framing rules the profile
 * checks, so a "valid" synthetic input differs from a committed fixture only in
 * the field under test.
 */

import { glbBytes, readGlb } from '@thirdlight/shared';
import type { AssetMetrics } from './types';

/** A GLB's JSON and BIN chunk (empty when it has none); throws on a file that is not a GLB. */
export function glbParts(bytes: Uint8Array): { json: Record<string, unknown>; bin: Uint8Array } {
  const parts = readGlb(bytes);
  if (typeof parts === 'string') throw new Error(parts);
  return { json: parts.json, bin: parts.bin ?? new Uint8Array(0) };
}

/** Build a GLB container from a JSON value and a BIN chunk. */
export function buildGlb(json: unknown, bin: Uint8Array): Uint8Array {
  return glbBytes(JSON.stringify(json), bin);
}

/** Deep JSON clone (the caller mutates the clone's plain data). */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Rebuild a valid fixture with an in-place JSON mutation and an optionally
 * replaced/extended BIN chunk. `buffers[0].byteLength` is kept truthful.
 */
export function mutateFixture(
  bytes: Uint8Array,
  mutate: (json: Record<string, unknown>) => void,
  bin?: Uint8Array,
): Uint8Array {
  const split = glbParts(bytes);
  const json = cloneJson(split.json);
  const nextBin = bin ?? split.bin;
  const buffers = json['buffers'];
  if (Array.isArray(buffers) && buffers.length === 1 && typeof buffers[0] === 'object') {
    (buffers[0] as Record<string, unknown>)['byteLength'] = nextBin.length;
  }
  mutate(json);
  return buildGlb(json, nextBin);
}

/** A float32 little-endian buffer. */
export function float32(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setFloat32(i * 4, v, true));
  return out;
}

/** A uint32 little-endian buffer. */
export function uint32(values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const dv = new DataView(out.buffer);
  values.forEach((v, i) => dv.setUint32(i * 4, v, true));
  return out;
}

/** The metric shape with every cap satisfied (the accepted-model baseline). */
export function metricBaseline(overrides: Partial<AssetMetrics>): AssetMetrics {
  return {
    nodes: 1,
    meshes: 1,
    primitives: 1,
    materials: 0,
    images: 0,
    textures: 0,
    vertices: 3,
    triangles: 1,
    animations: 0,
    animationChannels: 0,
    clipDurationMs: 0,
    decodedGeometryBytes: 36,
    decodedImageBytes: 0,
    ...overrides,
  };
}
