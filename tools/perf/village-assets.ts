/**
 * The village class's files, generated from a seed: synthetic shapes with
 * the structure of a kit-built game's assets, not art.
 *
 * - A prop: a root node holding one to three parts, each part three render
 *   levels (`<part>_LOD0..2`, a lathe of decreasing resolution), one
 *   material per file (some with an embedded noise texture). Placed whole,
 *   it is the "model hierarchy with LOD levels" a game's buildings and props
 *   arrive as.
 * - A scatter kit: top-level pieces with LOD levels for instance sets.
 * - A figure: a skinned column on a chain of joints with a looping `idle`
 *   clip that sways every joint, for animated characters.
 */
import { noisePng, packGlb } from './assets';
import { prng } from './generate';

/** Accessors and buffer views of one GLB under construction. */
class GlbData {
  readonly views: Record<string, unknown>[] = [];
  readonly accessors: Record<string, unknown>[] = [];
  private readonly parts: Buffer[] = [];
  private offset = 0;

  view(data: Buffer, target?: number): number {
    const pad = (4 - (data.length % 4)) % 4;
    this.views.push({ buffer: 0, byteOffset: this.offset, byteLength: data.length, ...(target !== undefined ? { target } : {}) });
    this.parts.push(data, Buffer.alloc(pad));
    this.offset += data.length + pad;
    return this.views.length - 1;
  }

  accessor(a: ArrayBufferView, componentType: number, count: number, type: string, extra: Record<string, unknown> = {}, target?: number): number {
    this.accessors.push({ bufferView: this.view(Buffer.from(a.buffer, a.byteOffset, a.byteLength), target), componentType, count, type, ...extra });
    return this.accessors.length - 1;
  }

  bin(): Buffer {
    return Buffer.concat(this.parts);
  }
}

const FLOAT = 5126;
const U16 = 5123;
const U8 = 5121;
const ARRAY = 34962;
const ELEMENTS = 34963;

/**
 * A closed lathe (a profile turned about Y) of `rings` × `sides` quads:
 * radius `profile(t)` at height `t × height`, t in 0..1. Positions, normals,
 * UVs and 16-bit indices; the mesh rests on y = 0.
 */
function lathe(rings: number, sides: number, height: number, profile: (t: number) => number): { pos: Float32Array; nrm: Float32Array; uv: Float32Array; idx: Uint16Array; max: number } {
  const verts = (rings + 1) * (sides + 1);
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  let k = 0;
  let max = 0;
  for (let r = 0; r <= rings; r += 1) {
    const t = r / rings;
    const rad = profile(t);
    // The profile's slope tilts the normal (finite difference).
    const dr = (profile(Math.min(1, t + 1e-3)) - profile(Math.max(0, t - 1e-3))) / (2e-3 * height);
    max = Math.max(max, rad);
    for (let c = 0; c <= sides; c += 1) {
      const a = (c / sides) * Math.PI * 2;
      const x = Math.cos(a);
      const z = Math.sin(a);
      pos.set([x * rad, t * height, z * rad], k * 3);
      const l = Math.hypot(1, dr);
      nrm.set([x / l, -dr / l, z / l], k * 3);
      uv.set([c / sides, t], k * 2);
      k += 1;
    }
  }
  const idx = new Uint16Array(rings * sides * 6);
  let i = 0;
  for (let r = 0; r < rings; r += 1) {
    for (let c = 0; c < sides; c += 1) {
      const a = r * (sides + 1) + c;
      const b = a + sides + 1;
      idx.set([a, b, a + 1, b, b + 1, a + 1], i);
      i += 6;
    }
  }
  return { pos, nrm, uv, idx, max };
}

/** One lathe mesh into `g`; returns the glTF mesh. */
function latheMesh(g: GlbData, name: string, m: ReturnType<typeof lathe>, height: number, material: number): Record<string, unknown> {
  const n = m.pos.length / 3;
  const POS = g.accessor(m.pos, FLOAT, n, 'VEC3', { min: [-m.max, 0, -m.max], max: [m.max, height, m.max] }, ARRAY);
  const NRM = g.accessor(m.nrm, FLOAT, n, 'VEC3', {}, ARRAY);
  const UV = g.accessor(m.uv, FLOAT, n, 'VEC2', {}, ARRAY);
  const IDX = g.accessor(m.idx, U16, m.idx.length, 'SCALAR', {}, ELEMENTS);
  return { name, primitives: [{ attributes: { POSITION: POS, NORMAL: NRM, TEXCOORD_0: UV }, indices: IDX, material }] };
}

/** Render levels: rings × sides of LOD0, halved per level. */
const LOD_LEVELS = 3;

export interface PropSpec {
  /** Parts under the root (1–3). */
  parts: number;
  /** LOD0 resolution: rings and sides of each part's lathe. */
  rings: number;
  sides: number;
  /** An embedded base-colour texture of this edge (0: none, a plain colour). */
  textureSize: number;
}

/** A prop file: root `prop` → parts `partN` (each `partN_LOD0..2`), one material. */
export function propGlb(seed: number, spec: PropSpec): Buffer {
  const rnd = prng(seed);
  const g = new GlbData();
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [{ name: 'prop', children: [] as number[] }];
  for (let p = 0; p < spec.parts; p += 1) {
    const height = 0.8 + rnd() * 2.2;
    const base = 0.3 + rnd() * 0.9;
    const bulge = rnd() * 0.6;
    const taper = 0.2 + rnd() * 0.8;
    const profile = (t: number): number => base * (1 + bulge * Math.sin(t * Math.PI)) * (1 - t * (1 - taper)) + 0.02;
    const levels: number[] = [];
    for (let l = 0; l < LOD_LEVELS; l += 1) {
      const rings = Math.max(2, Math.round(spec.rings / 2 ** l));
      const sides = Math.max(4, Math.round(spec.sides / 2 ** l));
      meshes.push(latheMesh(g, `part${p}_LOD${l}`, lathe(rings, sides, height, profile), height, 0));
      nodes.push({ name: `part${p}_LOD${l}`, mesh: meshes.length - 1 });
      levels.push(nodes.length - 1);
    }
    // Each part is a group of its levels, offset from the root (a building's wing, a roof, a chimney).
    nodes.push({ name: `part${p}`, children: levels, translation: [p === 0 ? 0 : (rnd() - 0.5) * 2.4, p === 0 ? 0 : rnd() * 1.5, p === 0 ? 0 : (rnd() - 0.5) * 2.4] });
    (nodes[0]!['children'] as number[]).push(nodes.length - 1);
  }
  const color = [0.35 + rnd() * 0.6, 0.3 + rnd() * 0.5, 0.25 + rnd() * 0.5, 1];
  const textured = spec.textureSize > 0;
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'thirdlight perf village prop' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes,
    materials: [{ name: 'prop', pbrMetallicRoughness: { baseColorFactor: color, ...(textured ? { baseColorTexture: { index: 0 } } : {}), metallicFactor: 0, roughnessFactor: 0.6 + rnd() * 0.4 } }],
    accessors: g.accessors,
    bufferViews: g.views,
  };
  if (textured) {
    const img = g.view(noisePng(seed ^ 0x5bd1e995, spec.textureSize));
    json['images'] = [{ bufferView: img, mimeType: 'image/png' }];
    json['samplers'] = [{ magFilter: 9729, minFilter: 9987 }];
    json['textures'] = [{ source: 0, sampler: 0 }];
  }
  const bin = g.bin();
  json['buffers'] = [{ byteLength: bin.length }];
  return packGlb(json, bin);
}

/** A scatter kit: top-level pieces `<name>_LOD0..2` (small lathes), one material. */
export function scatterKitGlb(seed: number, names: readonly string[]): Buffer {
  const rnd = prng(seed);
  const g = new GlbData();
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  for (const name of names) {
    const height = 0.2 + rnd() * 0.6;
    const base = 0.1 + rnd() * 0.3;
    const profile = (t: number): number => base * (1 - t * 0.8) + 0.01;
    for (let l = 0; l < LOD_LEVELS; l += 1) {
      meshes.push(latheMesh(g, `${name}_LOD${l}`, lathe(Math.max(2, 6 >> l), Math.max(4, 12 >> l), height, profile), height, 0));
      nodes.push({ name: `${name}_LOD${l}`, mesh: meshes.length - 1 });
    }
  }
  const bin = g.bin();
  return packGlb(
    {
      asset: { version: '2.0', generator: 'thirdlight perf village scatter kit' },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      nodes,
      meshes,
      materials: [{ name: 'scatter', pbrMetallicRoughness: { baseColorFactor: [0.3, 0.5, 0.25, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
      accessors: g.accessors,
      bufferViews: g.views,
      buffers: [{ byteLength: bin.length }],
    },
    bin,
  );
}

/** The figure's clip length (s). */
export const FIGURE_CLIP_SECONDS = 2;

/**
 * A skinned figure: a column of `sides`-sided rings, `joints` joints up a
 * chain (each `segment` m above its parent), every ring weighted to the two
 * joints around it, and an `idle` clip that sways the chain (four keys).
 */
export function figureGlb(seed: number, joints = 22, sides = 10, ringsPerJoint = 3): Buffer {
  const rnd = prng(seed);
  const segment = 1.6 / joints;
  const rings = joints * ringsPerJoint;
  const verts = (rings + 1) * (sides + 1);
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const jnt = new Uint8Array(verts * 4);
  const wgt = new Float32Array(verts * 4);
  let k = 0;
  for (let r = 0; r <= rings; r += 1) {
    const y = (r / rings) * joints * segment;
    const f = y / segment;
    const j0 = Math.min(joints - 1, Math.floor(f));
    const j1 = Math.min(joints - 1, j0 + 1);
    const w1 = Math.min(1, Math.max(0, f - j0));
    const rad = 0.18 + 0.06 * Math.sin((r / rings) * Math.PI * 3);
    for (let c = 0; c <= sides; c += 1) {
      const a = (c / sides) * Math.PI * 2;
      pos.set([Math.cos(a) * rad, y, Math.sin(a) * rad], k * 3);
      nrm.set([Math.cos(a), 0, Math.sin(a)], k * 3);
      jnt.set([j0, j1, 0, 0], k * 4);
      wgt.set([1 - w1, w1, 0, 0], k * 4);
      k += 1;
    }
  }
  const idx = new Uint16Array(rings * sides * 6);
  let i = 0;
  for (let r = 0; r < rings; r += 1) {
    for (let c = 0; c < sides; c += 1) {
      const a = r * (sides + 1) + c;
      const b = a + sides + 1;
      idx.set([a, b, a + 1, b, b + 1, a + 1], i);
      i += 6;
    }
  }
  const g = new GlbData();
  const top = joints * segment;
  const POS = g.accessor(pos, FLOAT, verts, 'VEC3', { min: [-0.25, 0, -0.25], max: [0.25, top, 0.25] }, ARRAY);
  const NRM = g.accessor(nrm, FLOAT, verts, 'VEC3', {}, ARRAY);
  const JNT = g.accessor(jnt, U8, verts, 'VEC4', {}, ARRAY);
  const WGT = g.accessor(wgt, FLOAT, verts, 'VEC4', {}, ARRAY);
  const IDX = g.accessor(idx, U16, idx.length, 'SCALAR', {}, ELEMENTS);
  // Joint j sits at j × segment; its inverse bind matrix moves it back to the origin (column-major).
  const ibm = new Float32Array(joints * 16);
  for (let j = 0; j < joints; j += 1) ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -j * segment, 0, 1], j * 16);
  const IBM = g.accessor(ibm, FLOAT, joints, 'MAT4');
  // Nodes: 0 the mesh, 1.. the joint chain (each a child of the one before).
  const nodes: Record<string, unknown>[] = [{ name: 'figure', mesh: 0, skin: 0 }];
  for (let j = 0; j < joints; j += 1) nodes.push({ name: `joint${j}`, ...(j > 0 ? { translation: [0, segment, 0] } : {}), ...(j + 1 < joints ? { children: [j + 2] } : {}) });
  const keys = [0, 0.5, 1, 1.5, 2].map((t) => (t * FIGURE_CLIP_SECONDS) / 2);
  const TIMES = g.accessor(new Float32Array(keys), FLOAT, keys.length, 'SCALAR', { min: [0], max: [FIGURE_CLIP_SECONDS] });
  const samplers: Record<string, unknown>[] = [];
  const channels: Record<string, unknown>[] = [];
  for (let j = 0; j < joints; j += 1) {
    const amp = (0.04 + rnd() * 0.06) * Math.PI;
    const q = new Float32Array(keys.length * 4);
    keys.forEach((_, n) => {
      const ang = amp * Math.sin((n / (keys.length - 1)) * Math.PI * 2 + j * 0.4);
      q.set([Math.sin(ang / 2), 0, 0, Math.cos(ang / 2)], n * 4);
    });
    samplers.push({ input: TIMES, output: g.accessor(q, FLOAT, keys.length, 'VEC4'), interpolation: 'LINEAR' });
    channels.push({ sampler: j, target: { node: j + 1, path: 'rotation' } });
  }
  const bin = g.bin();
  return packGlb(
    {
      asset: { version: '2.0', generator: 'thirdlight perf village figure' },
      scene: 0,
      scenes: [{ nodes: [0, 1] }],
      nodes,
      skins: [{ joints: Array.from({ length: joints }, (_, j) => j + 1), inverseBindMatrices: IBM, skeleton: 1 }],
      meshes: [{ name: 'figure', primitives: [{ attributes: { POSITION: POS, NORMAL: NRM, JOINTS_0: JNT, WEIGHTS_0: WGT }, indices: IDX, material: 0 }] }],
      materials: [{ name: 'figure', pbrMetallicRoughness: { baseColorFactor: [0.75, 0.45, 0.3, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
      animations: [{ name: 'idle', samplers, channels }],
      accessors: g.accessors,
      bufferViews: g.views,
      buffers: [{ byteLength: bin.length }],
    },
    bin,
  );
}
