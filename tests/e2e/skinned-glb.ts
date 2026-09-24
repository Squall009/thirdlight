/**
 * A small skinned GLB built in the test: an orange column (0.4 × 2 × 0.4 m,
 * ring vertices every 0.5 m) on a two-joint skin — `root` at the base and
 * `upper` at 1 m — with two clips: `idle` (straight) and `bend` (the upper
 * half bent 80° about Z). A pose change is easy to see from the front.
 */

function quatZ(deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 360;
  return [0, 0, Math.sin(h), Math.cos(h)];
}

export function skinnedGlb(): Buffer {
  const rings = [0, 0.5, 1, 1.5, 2];
  const half = 0.2;
  const corners: [number, number][] = [
    [-half, -half],
    [half, -half],
    [half, half],
    [-half, half],
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const indices: number[] = [];
  // Four sides, each a strip of quads up the rings (own vertices per side for flat normals).
  const sideNormals: [number, number, number][] = [
    [0, 0, -1],
    [1, 0, 0],
    [0, 0, 1],
    [-1, 0, 0],
  ];
  for (let side = 0; side < 4; side++) {
    const a = corners[side]!;
    const b = corners[(side + 1) % 4]!;
    const base = positions.length / 3;
    for (const y of rings) {
      for (const c of [a, b]) {
        positions.push(c[0], y, c[1]);
        normals.push(...sideNormals[side]!);
        joints.push(0, 1, 0, 0);
        const w = y < 1 ? 1 : y > 1 ? 0 : 0.5;
        weights.push(w, 1 - w, 0, 0);
      }
    }
    for (let r = 0; r + 1 < rings.length; r++) {
      const i = base + r * 2;
      indices.push(i, i + 2, i + 1, i + 1, i + 2, i + 3);
    }
  }

  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const view = (data: Buffer, target?: number): number => {
    const pad = (4 - (data.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target !== undefined ? { target } : {}) });
    chunks.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
    return bufferViews.length - 1;
  };
  const acc = (data: Buffer, componentType: number, count: number, type: string, extra: Record<string, unknown> = {}, target?: number): number => {
    accessors.push({ bufferView: view(data, target), componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const n = positions.length / 3;
  const ys = positions.filter((_, i) => i % 3 === 1);
  const POS = acc(Buffer.from(new Float32Array(positions).buffer), 5126, n, 'VEC3', { min: [-half, Math.min(...ys), -half], max: [half, Math.max(...ys), half] }, 34962);
  const NRM = acc(Buffer.from(new Float32Array(normals).buffer), 5126, n, 'VEC3', {}, 34962);
  const JNT = acc(Buffer.from(new Uint8Array(joints).buffer), 5121, n, 'VEC4', {}, 34962);
  const WGT = acc(Buffer.from(new Float32Array(weights).buffer), 5126, n, 'VEC4', {}, 34962);
  const IDX = acc(Buffer.from(new Uint16Array(indices).buffer), 5123, indices.length, 'SCALAR', {}, 34963);
  // Inverse bind matrices (column-major): root at the origin, upper at y = 1.
  const ibm = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1]);
  const IBM = acc(Buffer.from(ibm.buffer), 5126, 2, 'MAT4');
  // Clips: two keys each (0 s and 1 s) on the upper joint's rotation.
  const TIMES = acc(Buffer.from(new Float32Array([0, 1]).buffer), 5126, 2, 'SCALAR', { min: [0], max: [1] });
  const STRAIGHT = acc(Buffer.from(new Float32Array([...quatZ(0), ...quatZ(0)]).buffer), 5126, 2, 'VEC4');
  const BENT = acc(Buffer.from(new Float32Array([...quatZ(80), ...quatZ(80)]).buffer), 5126, 2, 'VEC4');

  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'thirdlight e2e skinned fixture' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0, 1] }],
    nodes: [
      { name: 'column', mesh: 0, skin: 0 },
      { name: 'root', children: [2] },
      { name: 'upper', translation: [0, 1, 0] },
    ],
    skins: [{ joints: [1, 2], inverseBindMatrices: IBM, skeleton: 1 }],
    meshes: [{ name: 'column', primitives: [{ attributes: { POSITION: POS, NORMAL: NRM, JOINTS_0: JNT, WEIGHTS_0: WGT }, indices: IDX, material: 0 }] }],
    materials: [{ name: 'orange', pbrMetallicRoughness: { baseColorFactor: [1, 0.45, 0.05, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    animations: [
      { name: 'idle', samplers: [{ input: TIMES, output: STRAIGHT, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }] },
      { name: 'bend', samplers: [{ input: TIMES, output: BENT, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }] },
    ],
    accessors,
    bufferViews,
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
