/**
 * The asset-heavy benchmark's files — many distinct model files
 * and textures, deterministic from a seed. A model is a UV sphere of `segments`
 * × `segments` quads (position, normal, UV, 16-bit indices) with its base
 * colour an embedded noise PNG; a texture is a noise PNG. Noise keeps the
 * PNGs near their raw size, the way photographic textures are. Synthetic load
 * for timing, not art.
 */
import { makePng } from '../../tests/e2e/png-make';
import { prng } from './generate';

/** An RGBA noise PNG (`size` × `size`), tinted by the seed. */
export function noisePng(seed: number, size: number): Buffer {
  const rnd = prng(seed);
  const tint = [rnd(), rnd(), rnd()];
  return makePng(size, size, () => {
    const n = rnd();
    return [Math.floor(64 + 191 * n * tint[0]!), Math.floor(64 + 191 * n * tint[1]!), Math.floor(64 + 191 * n * tint[2]!), 255];
  });
}

/** A textured UV sphere GLB (radius 0.5, resting on y = 0); `fill` makes its texture one solid colour instead of noise. */
export function sphereGlb(seed: number, segments: number, textureSize: number, fill?: readonly [number, number, number]): Buffer {
  const rows = segments;
  const cols = segments;
  const verts = (rows + 1) * (cols + 1);
  if (verts > 65535) throw new Error('sphereGlb: too many vertices for 16-bit indices');
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  let k = 0;
  for (let r = 0; r <= rows; r += 1) {
    const v = r / rows;
    const phi = v * Math.PI;
    for (let c = 0; c <= cols; c += 1) {
      const u = c / cols;
      const theta = u * Math.PI * 2;
      const x = Math.sin(phi) * Math.cos(theta);
      const y = Math.cos(phi);
      const z = Math.sin(phi) * Math.sin(theta);
      nrm.set([x, y, z], k * 3);
      pos.set([x * 0.5, y * 0.5 + 0.5, z * 0.5], k * 3);
      uv.set([u, v], k * 2);
      k += 1;
    }
  }
  const idx = new Uint16Array(rows * cols * 6);
  let i = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const a = r * (cols + 1) + c;
      const b = a + cols + 1;
      idx.set([a, b, a + 1, b, b + 1, a + 1], i);
      i += 6;
    }
  }
  const png = fill !== undefined ? makePng(textureSize, textureSize, () => [fill[0], fill[1], fill[2], 255]) : noisePng(seed, textureSize);
  const parts: Buffer[] = [];
  const views: Record<string, unknown>[] = [];
  let offset = 0;
  const view = (data: Buffer, target?: number): number => {
    const pad = (4 - (data.length % 4)) % 4;
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target !== undefined ? { target } : {}) });
    parts.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
    return views.length - 1;
  };
  const b = (a: ArrayBufferView): Buffer => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
  const vPos = view(b(pos), 34962);
  const vNrm = view(b(nrm), 34962);
  const vUv = view(b(uv), 34962);
  const vIdx = view(b(idx), 34963);
  const vImg = view(png);
  const bin = Buffer.concat(parts);
  const json = {
    asset: { version: '2.0', generator: 'thirdlight perf asset-heavy fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'body', mesh: 0 }],
    meshes: [{ name: 'body', primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'body', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.7 } }],
    images: [{ bufferView: vImg, mimeType: 'image/png' }],
    samplers: [{ magFilter: 9729, minFilter: 9987 }],
    textures: [{ source: 0, sampler: 0 }],
    accessors: [
      { bufferView: vPos, componentType: 5126, count: verts, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
      { bufferView: vNrm, componentType: 5126, count: verts, type: 'VEC3' },
      { bufferView: vUv, componentType: 5126, count: verts, type: 'VEC2' },
      { bufferView: vIdx, componentType: 5123, count: idx.length, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}
