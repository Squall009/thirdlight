/**
 * Test-only synthetic GLB builder (NOT public surface; imported only by
 * `*.test.ts` files).
 *
 * The committed fixtures are exercised exactly through `test-fixtures.ts`; this
 * helper exists for adversarial cases that cannot be committed (a >32 MiB
 * source, a 2 000 001-vertex model, a bare chunk-framing mutation) and for
 * mutations of a valid fixture that must still be real GLB containers. It
 * builds (and splits) the container with the same framing rules the profile
 * checks, so a "valid" synthetic input differs from a committed fixture only in
 * the field under test.
 */

import type { AssetMetrics } from './types';

export interface SplitGlb {
  readonly json: Record<string, unknown>;
  readonly jsonText: string;
  readonly bin: Uint8Array;
}

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Parse a GLB container into its JSON text/value and its BIN chunk (with padding). */
export function splitGlb(bytes: Uint8Array): SplitGlb {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = dv.getUint32(12, true);
  const jsonStart = 20;
  const jsonBytes = bytes.subarray(jsonStart, jsonStart + jsonLength);
  const binHeader = jsonStart + jsonLength;
  const binLength = dv.getUint32(binHeader, true);
  const binStart = binHeader + 8;
  const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(jsonBytes);
  return {
    json: JSON.parse(jsonText) as Record<string, unknown>,
    jsonText,
    bin: bytes.subarray(binStart, binStart + binLength),
  };
}

function pad4(length: number): number {
  return (4 - (length % 4)) % 4;
}

/** Build a GLB container from raw JSON chunk text and a BIN chunk. */
export function buildGlbFromJsonText(jsonText: string, bin: Uint8Array): Uint8Array {
  const jsonBytes = new TextEncoder().encode(jsonText);
  const jsonLength = jsonBytes.length + pad4(jsonBytes.length);
  const binLength = bin.length + pad4(bin.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLength, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  for (let i = 20 + jsonBytes.length; i < 20 + jsonLength; i++) out[i] = 0x20;
  const binHeader = 20 + jsonLength;
  dv.setUint32(binHeader, binLength, true);
  dv.setUint32(binHeader + 4, CHUNK_BIN, true);
  out.set(bin, binHeader + 8);
  return out;
}

/** Build a GLB container from a JSON value and a BIN chunk. */
export function buildGlb(json: unknown, bin: Uint8Array): Uint8Array {
  return buildGlbFromJsonText(JSON.stringify(json), bin);
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
  const split = splitGlb(bytes);
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

/** The §18.6 metric shape with every cap satisfied (the accepted-model baseline). */
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
