/**
 * A small neutral GLB with an animated node hierarchy, built in
 * the test (no binary fixture in the repo):
 *
 *   base  (a grey slab 1 × 0.2 × 1 m at the origin)
 *   └ arm  (rest translation [0, 0.5, 0])
 *     └ hand (translation [0, 0, 0.5], an orange 0.2 m cube marker)
 *
 * Clips:
 * - `slide`: the arm moves along +X, [0, 0.5, 0] → [4, 0.5, 0] over 4 s
 *   (linear), so a node on it moves 1 m/s — easy to read a clip rate from;
 * - `spin`: the arm turns about +Y, 0° → 90° → 180° over 2 s.
 *
 * A socket on `hand` sits at `targetWorld + [t, 0.5, 0.5]` while `slide`
 * plays at clip time t.
 */

function box(sx: number, sy: number, sz: number): { positions: number[]; normals: number[]; indices: number[] } {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const p = [0, 1, 2].map((k) => (n[k]! + a * u[k]! + b * v[k]!) * 0.5 * [sx, sy, sz][k]!);
      positions.push(...p);
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

function quatY(deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

/** The GLB bytes (a Uint8Array; Node's Buffer is one). */
export function socketGlb(): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const view = (data: ArrayBufferView, target?: number): number => {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const pad = (4 - (bytes.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target !== undefined ? { target } : {}) });
    chunks.push(bytes, new Uint8Array(pad));
    offset += bytes.length + pad;
    return bufferViews.length - 1;
  };
  const acc = (data: ArrayBufferView, componentType: number, count: number, type: string, extra: Record<string, unknown> = {}, target?: number): number => {
    accessors.push({ bufferView: view(data, target), componentType, count, type, ...extra });
    return accessors.length - 1;
  };
  const mesh = (b: ReturnType<typeof box>): Record<string, number> => {
    const n = b.positions.length / 3;
    const xs = [0, 1, 2].map((k) => b.positions.filter((_, i) => i % 3 === k));
    return {
      POSITION: acc(new Float32Array(b.positions), 5126, n, 'VEC3', { min: xs.map((a) => Math.min(...a)), max: xs.map((a) => Math.max(...a)) }, 34962),
      NORMAL: acc(new Float32Array(b.normals), 5126, n, 'VEC3', {}, 34962),
      indices: acc(new Uint16Array(b.indices), 5123, b.indices.length, 'SCALAR', {}, 34963),
    };
  };
  const slab = mesh(box(1, 0.2, 1));
  const marker = mesh(box(0.2, 0.2, 0.2));
  const SLIDE_T = acc(new Float32Array([0, 4]), 5126, 2, 'SCALAR', { min: [0], max: [4] });
  const SLIDE_V = acc(new Float32Array([0, 0.5, 0, 4, 0.5, 0]), 5126, 2, 'VEC3');
  const SPIN_T = acc(new Float32Array([0, 1, 2]), 5126, 3, 'SCALAR', { min: [0], max: [2] });
  const SPIN_V = acc(new Float32Array([...quatY(0), ...quatY(90), ...quatY(180)]), 5126, 3, 'VEC4');
  const bin = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) {
    bin.set(c, o);
    o += c.length;
  }
  const prim = (m: Record<string, number>, material: number) => ({ attributes: { POSITION: m['POSITION'], NORMAL: m['NORMAL'] }, indices: m['indices'], material });
  const json = {
    asset: { version: '2.0', generator: 'thirdlight socket fixture' },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [0] }],
    nodes: [
      { name: 'base', mesh: 0, children: [1] },
      { name: 'arm', translation: [0, 0.5, 0], children: [2] },
      { name: 'hand', translation: [0, 0, 0.5], mesh: 1 },
    ],
    meshes: [
      { name: 'slab', primitives: [prim(slab, 0)] },
      { name: 'marker', primitives: [prim(marker, 1)] },
    ],
    materials: [
      { name: 'grey', pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
      { name: 'orange', pbrMetallicRoughness: { baseColorFactor: [1, 0.45, 0.05, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
    ],
    animations: [
      { name: 'slide', samplers: [{ input: SLIDE_T, output: SLIDE_V, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }] },
      { name: 'spin', samplers: [{ input: SPIN_T, output: SPIN_V, interpolation: 'LINEAR' }], channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }] },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (jsonBytes.length % 4)) % 4;
  if (jpad > 0) {
    const padded = new Uint8Array(jsonBytes.length + jpad).fill(0x20);
    padded.set(jsonBytes);
    jsonBytes = padded;
  }
  const out = new Uint8Array(12 + 8 + jsonBytes.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jsonBytes.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  const b = 20 + jsonBytes.length;
  dv.setUint32(b, bin.length, true);
  dv.setUint32(b + 4, 0x004e4942, true);
  out.set(bin, b + 8);
  return out;
}

/** The clip durations the controller refers to. */
export const SOCKET_GLB_CLIPS = { slide: 4, spin: 2 } as const;
