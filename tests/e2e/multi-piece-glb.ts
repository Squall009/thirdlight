/**
 * A small multi-piece GLB built in the test (the naming rule of game kits):
 * each piece is `<name>_LOD0..n` boxes plus an optional `<name>_COL` box (or a
 * `_COL` node holding several box parts), all top-level nodes at the origin, one shared material, and a COLOR_0 on every
 * render mesh. The vertex colour is pure red, so a render shows whether it is
 * used as data (the white material stays white/grey) or as a tint (red).
 * With `{ lightmapUv: true }` every render mesh also gets TEXCOORD_0/1 (UV1)
 * that lays the box's six faces out without overlap, like a kit exported
 * for light baking.
 * With `{ texturePng }` the material's base colour is that PNG,
 * embedded in the GLB (a bufferView image) and mapped through TEXCOORD_0.
 * With `{ centred: true }` a box's pivot is its base centre (a block cell's
 * frame) instead of its base centre-left.
 */

export interface PieceSpec {
  name: string;
  /** Box size per LOD (LOD0 first); one entry = no LOD suffix. */
  lods: [number, number, number][];
  /** Collision box size (absent: no `_COL`). */
  col?: [number, number, number];
  /** Collision parts instead: the `_COL` node holds one child node per box, moved to `at` (each a convex part). */
  colParts?: { size: [number, number, number]; at: [number, number, number] }[];
  /** Per LOD: its own material of this base colour (linear RGB 0-1); absent: the shared material. */
  colors?: [number, number, number][];
  /** The COLOR_0 of its render meshes (RGBA 0-1; absent: pure red). */
  vertexColor?: [number, number, number, number];
}

function box(size: [number, number, number], centred = false): { positions: number[]; normals: number[]; uv1: number[]; indices: number[] } {
  const [sx, sy, sz] = size;
  // Pivot at the base centre-left like a kit piece: x 0..sx, y 0..sy, z -sz/2..sz/2 (centred: x -sx/2..sx/2).
  const x0 = centred ? -sx / 2 : 0, x1 = centred ? sx / 2 : sx, y0 = 0, y1 = sy, z0 = -sz / 2, z1 = sz / 2;
  const faces: { n: [number, number, number]; v: [number, number, number][] }[] = [
    { n: [0, 0, 1], v: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { n: [0, 0, -1], v: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
    { n: [1, 0, 0], v: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
    { n: [-1, 0, 0], v: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { n: [0, 1, 0], v: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
    { n: [0, -1, 0], v: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const uv1: number[] = [];
  const indices: number[] = [];
  // UV1: a 3 × 2 grid of cells, one face per cell, with a margin between faces.
  const corners: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  faces.forEach((f, i) => {
    const cu = i % 3, cv = Math.floor(i / 3);
    f.v.forEach((v, k) => {
      positions.push(...v);
      normals.push(...f.n);
      uv1.push((cu + 0.05 + corners[k]![0] * 0.9) / 3, (cv + 0.05 + corners[k]![1] * 0.9) / 2);
    });
    const b = i * 4;
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { positions, normals, uv1, indices };
}

export function multiPieceGlb(pieces: readonly PieceSpec[], options: { lightmapUv?: boolean; texturePng?: Buffer; centred?: boolean } = {}): Buffer {
  const chunks: Buffer[] = [];
  let offset = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  const addView = (data: Buffer, target?: number): number => {
    const pad = (4 - (data.length % 4)) % 4;
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target !== undefined ? { target } : {}) });
    chunks.push(data, Buffer.alloc(pad));
    offset += data.length + pad;
    return bufferViews.length - 1;
  };
  const extraMaterials: Record<string, unknown>[] = [];
  const addMesh = (name: string, size: [number, number, number], render: boolean, color?: [number, number, number], vertexColor: [number, number, number, number] = [1, 0, 0, 1]): number => {
    const g = box(size, options.centred === true);
    const count = g.positions.length / 3;
    const pos = addView(Buffer.from(new Float32Array(g.positions).buffer), 34962);
    const xMin = options.centred === true ? -size[0] / 2 : 0;
    accessors.push({ bufferView: pos, componentType: 5126, count, type: 'VEC3', min: [xMin, 0, -size[2] / 2], max: [xMin + size[0], size[1], size[2] / 2] });
    const posA = accessors.length - 1;
    const nrm = addView(Buffer.from(new Float32Array(g.normals).buffer), 34962);
    accessors.push({ bufferView: nrm, componentType: 5126, count, type: 'VEC3' });
    const nrmA = accessors.length - 1;
    const idx = addView(Buffer.from(new Uint16Array(g.indices).buffer), 34963);
    accessors.push({ bufferView: idx, componentType: 5123, count: g.indices.length, type: 'SCALAR' });
    const idxA = accessors.length - 1;
    const attributes: Record<string, number> = { POSITION: posA, NORMAL: nrmA };
    if (render) {
      const colors = new Float32Array(count * 4);
      for (let i = 0; i < count; i += 1) colors.set(vertexColor, i * 4);
      const col = addView(Buffer.from(colors.buffer), 34962);
      accessors.push({ bufferView: col, componentType: 5126, count, type: 'VEC4' });
      attributes['COLOR_0'] = accessors.length - 1;
      if (options.lightmapUv === true || options.texturePng !== undefined) {
        const uv = addView(Buffer.from(new Float32Array(g.uv1).buffer), 34962);
        accessors.push({ bufferView: uv, componentType: 5126, count, type: 'VEC2' });
        // glTF numbers texture coordinate sets from 0, so UV0 is the same layout.
        attributes['TEXCOORD_0'] = accessors.length - 1;
        if (options.lightmapUv === true) attributes['TEXCOORD_1'] = accessors.length - 1;
      }
    }
    let material = 0;
    if (color !== undefined) {
      extraMaterials.push({ name: `mat_${name}`, pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 0.8 } });
      material = extraMaterials.length;
    }
    meshes.push({ name, primitives: [{ attributes, indices: idxA, ...(render ? { material } : {}) }] });
    return meshes.length - 1;
  };
  for (const p of pieces) {
    p.lods.forEach((size, i) => {
      const name = p.lods.length === 1 ? p.name : `${p.name}_LOD${i}`;
      nodes.push({ name, mesh: addMesh(name, size, true, p.colors?.[i], p.vertexColor) });
    });
    if (p.col !== undefined) nodes.push({ name: `${p.name}_COL`, mesh: addMesh(`${p.name}_COL`, p.col, false) });
    if (p.colParts !== undefined) {
      const parts = p.colParts.map((part, i) => {
        nodes.push({ name: `${p.name}_part${i}`, mesh: addMesh(`${p.name}_part${i}`, part.size, false), translation: part.at });
        return nodes.length - 1;
      });
      nodes.push({ name: `${p.name}_COL`, children: parts });
    }
  }
  const image = options.texturePng !== undefined ? addView(options.texturePng) : null;
  const bin = Buffer.concat(chunks);
  const json = {
    asset: { version: '2.0', generator: 'thirdlight e2e multi-piece fixture' },
    scene: 0,
    // The top level: every node no other node holds.
    scenes: [{ name: 'Scene', nodes: nodes.map((_, i) => i).filter((i) => !nodes.some((n) => (n['children'] as number[] | undefined)?.includes(i))) }],
    nodes,
    meshes,
    materials: [{ name: 'mat_kit', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.8, ...(image !== null ? { baseColorTexture: { index: 0 } } : {}) } }, ...extraMaterials],
    ...(image !== null ? { images: [{ bufferView: image, mimeType: 'image/png' }], samplers: [{ magFilter: 9728, minFilter: 9728 }], textures: [{ source: 0, sampler: 0 }] } : {}),
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const header = Buffer.alloc(12);
  const total = 12 + 8 + jsonBuf.length + 8 + bin.length;
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBuf.length, 0);
  jh.writeUInt32LE(0x4e4f534a, 4);
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jh, jsonBuf, bh, bin]);
}

/** The fixture the model-pieces test imports. */
export const KIT_PIECES: readonly PieceSpec[] = [
  { name: 'rock', lods: [[1, 1, 1], [1, 0.9, 1]], col: [1, 1, 1] },
  { name: 'bush', lods: [[2, 0.5, 1], [2, 0.45, 1]], col: [2, 0.5, 1] },
  { name: 'flower', lods: [[0.5, 1.5, 0.5]] },
];
