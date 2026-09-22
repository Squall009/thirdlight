/**
 * Test-only synthetic GLB builder for the packet-26 loader tests (NOT part of
 * the public surface — not exported from index.ts; imported only by .test.ts
 * files, like `test-scene.ts`).
 *
 * The packet-24 fixture GLBs live in `fixtures/m2/assets/**`; the boundary
 * rules forbid a package test from reading repo files (`node:fs` is not in
 * three-adapter's allowed edges) or importing another package's fixtures, so
 * this helper emits real, self-contained glTF 2.0 GLB bytes instead: header,
 * JSON chunk, BIN chunk, one mesh (with POSITION/TEXCOORD_0/indices), one or
 * two PBR materials, an embedded 1x1 PNG image when requested, and a rotation
 * animation clip. `packages/three-adapter/src/gltf-loader.test.ts` feeds these
 * bytes through the REAL pinned `GLTFLoader` (three@0.186.0), so the loader
 * binding is exercised for real, not mocked.
 */

/** A real 1x1 PNG (67 bytes) used as the embedded image payload. */
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export interface TestGlbOptions {
  /** Number of PBR materials on the single mesh primitive (1 or 2; default 1). */
  readonly materials?: number;
  /** Include a rotation animation clip (default true). */
  readonly clip?: boolean;
  /**
   * Packet 53: the clip names, in stored order (overrides `clip`). Each entry
   * builds one rotation clip on the 'Rotor' node with that name — the
   * packet-53 role tests need a real three-clip GLB (`Idle`/`Run`/`Airborne`)
   * and the reordered-clip variant; an empty array means no clips.
   */
  readonly clipNames?: readonly string[];
  /** Include an embedded 1x1 PNG referenced by material 0 (default false). */
  readonly image?: boolean;
  /** Declared `extensionsUsed`. */
  readonly extensionsUsed?: readonly string[];
  /** Declared `extensionsRequired`. */
  readonly extensionsRequired?: readonly string[];
  /** Override the JSON chunk text (for malformed-JSON cases). */
  readonly rawJson?: string;
}

interface BufferViewRef {
  readonly offset: number;
  readonly length: number;
}

/** A tiny incremental BIN-chunk writer with 4-byte alignment. */
class BinWriter {
  private readonly bytes: number[] = [];

  push(data: readonly number[] | Uint8Array): BufferViewRef {
    const offset = Math.ceil(this.bytes.length / 4) * 4;
    while (this.bytes.length < offset) this.bytes.push(0);
    for (const b of data) this.bytes.push(b & 0xff);
    return { offset, length: data.length };
  }

  byteLength(): number {
    return this.bytes.length;
  }

  padded(): Uint8Array {
    const out = new Uint8Array(Math.ceil(this.bytes.length / 4) * 4);
    out.set(this.bytes, 0);
    return out;
  }
}

function float32(values: readonly number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  values.forEach((v, i) => view.setFloat32(i * 4, v, true));
  return [...new Uint8Array(buffer)];
}

function uint16(values: readonly number[]): number[] {
  const buffer = new ArrayBuffer(values.length * 2);
  const view = new DataView(buffer);
  values.forEach((v, i) => view.setUint16(i * 2, v, true));
  return [...new Uint8Array(buffer)];
}

/** Build one valid glTF 2.0 GLB (single BIN chunk, every buffer/image embedded). */
export function buildGlb(options: TestGlbOptions = {}): Uint8Array {
  const materialCount = options.materials ?? 1;
  const withClip = options.clip ?? true;
  const clipNames = options.clipNames ?? (withClip ? ['Spin'] : []);
  const withImage = options.image ?? false;
  const bin = new BinWriter();

  const positions = bin.push(float32([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  const indices = bin.push(uint16([0, 1, 2]));
  const texcoords = bin.push(float32([0, 0, 1, 0, 0, 1]));
  const times: Array<{ readonly offset: number; readonly length: number }> = [];
  const rotations: Array<{ readonly offset: number; readonly length: number }> = [];
  for (const _name of clipNames) {
    times.push(bin.push(float32([0, 1])));
    rotations.push(bin.push(float32([0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2])));
  }
  const image = withImage ? bin.push(decodeBase64(ONE_PIXEL_PNG_BASE64)) : null;
  const bufferByteLength = bin.byteLength();

  const bufferViews: Record<string, unknown>[] = [
    { buffer: 0, byteOffset: positions.offset, byteLength: positions.length, target: 34962 },
    { buffer: 0, byteOffset: indices.offset, byteLength: indices.length, target: 34963 },
    { buffer: 0, byteOffset: texcoords.offset, byteLength: texcoords.length, target: 34962 },
  ];
  const accessors: Record<string, unknown>[] = [
    {
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: 'VEC3',
      min: [0, 0, 0],
      max: [1, 1, 0],
    },
    { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
  ];

  const attributes: Record<string, number> = { POSITION: 0, TEXCOORD_0: 2 };
  clipNames.forEach((_name, i) => {
    const t = times[i]!;
    const r = rotations[i]!;
    bufferViews.push({ buffer: 0, byteOffset: t.offset, byteLength: t.length });
    bufferViews.push({ buffer: 0, byteOffset: r.offset, byteLength: r.length });
    accessors.push({ bufferView: 3 + 2 * i, componentType: 5126, count: 2, type: 'SCALAR' });
    accessors.push({ bufferView: 4 + 2 * i, componentType: 5126, count: 2, type: 'VEC4' });
  });
  if (image !== null) {
    bufferViews.push({ buffer: 0, byteOffset: image.offset, byteLength: image.length });
  }

  const materials: Record<string, unknown>[] = [];
  for (let i = 0; i < materialCount; i += 1) {
    const pbr: Record<string, unknown> = {
      baseColorFactor: i === 0 ? [0.9, 0.4, 0.3, 1] : [0.3, 0.6, 0.9, 1],
      metallicFactor: 0.2,
      roughnessFactor: 0.7,
    };
    if (withImage && i === 0) pbr.baseColorTexture = { index: 0 };
    materials.push({ name: `Mat${i}`, pbrMetallicRoughness: pbr, doubleSided: i === 0 });
  }

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'thirdlight-three-adapter-test-glb' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes: [
      { name: 'Main', children: [1] },
      { name: 'Rotor', mesh: 0 },
    ],
    meshes: [
      {
        name: 'Tri',
        primitives: [{ attributes, indices: 1, material: 0, mode: 4 }],
      },
    ],
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bufferByteLength }],
  };
  if (clipNames.length > 0) {
    json.animations = clipNames.map((name, i) => ({
      name,
      samplers: [{ input: 3 + 2 * i, output: 4 + 2 * i, interpolation: 'LINEAR' }],
      channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
    }));
  }
  if (withImage) {
    json.images = [{ name: 'px', bufferView: bufferViews.length - 1, mimeType: 'image/png' }];
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
    json.textures = [{ source: 0, sampler: 0 }];
  }
  if (options.extensionsUsed !== undefined) json.extensionsUsed = [...options.extensionsUsed];
  if (options.extensionsRequired !== undefined) json.extensionsRequired = [...options.extensionsRequired];

  return packGlb(options.rawJson ?? JSON.stringify(json), bin.padded());
}

/** Frame a JSON chunk + BIN chunk into a GLB container (the caller owns content validity). */
export function packGlb(jsonText: string, bin: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(jsonText);
  const jsonPadded = new Uint8Array(Math.ceil(jsonBytes.length / 4) * 4);
  jsonPadded.set(jsonBytes, 0);
  jsonPadded.fill(0x20, jsonBytes.length); // JSON chunks pad with spaces
  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true); // JSON
  out.set(jsonPadded, 20);
  const binHeader = 20 + jsonPadded.length;
  view.setUint32(binHeader, bin.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true); // BIN
  out.set(bin, binHeader + 8);
  return out;
}

/** A descriptor for `bytes` (the adapter does not re-verify the digest: the workspace owns that, sessions.md §16.1). */
export function descriptorFor(
  bytes: Uint8Array,
  overrides: Partial<{ assetId: string; version: number; sourceDigest: string; sourceByteLength: number }> = {},
): {
  assetId: string;
  version: number;
  sourceDigest: string;
  sourceByteLength: number;
} {
  return {
    assetId: overrides.assetId ?? 'asset-0000000000000001',
    version: overrides.version ?? 1,
    sourceDigest: overrides.sourceDigest ?? 'ab'.repeat(32),
    sourceByteLength: overrides.sourceByteLength ?? bytes.byteLength,
  };
}
