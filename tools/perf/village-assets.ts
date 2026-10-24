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
  const attributes: Record<string, number> = { POSITION: POS, NORMAL: NRM, TEXCOORD_0: UV };
  return { name, primitives: [{ attributes, indices: IDX, material }] };
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

/**
 * A 1 × 1 m quad in the XY plane facing +Z (two triangles, UVs over it) and
 * one material named `material`: a flat mark to lay over a surface, the
 * object's +Z on the surface's normal and its scale the mark's size.
 */
export function quadGlb(material: string): Buffer {
  const g = new GlbData();
  const pos = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const POS = g.accessor(pos, FLOAT, 4, 'VEC3', { min: [-0.5, -0.5, 0], max: [0.5, 0.5, 0] }, ARRAY);
  const NRM = g.accessor(nrm, FLOAT, 4, 'VEC3', {}, ARRAY);
  const UV = g.accessor(uv, FLOAT, 4, 'VEC2', {}, ARRAY);
  const IDX = g.accessor(idx, U16, 6, 'SCALAR', {}, ELEMENTS);
  const bin = g.bin();
  return packGlb(
    {
      asset: { version: '2.0', generator: 'thirdlight perf quad' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ name: 'quad', mesh: 0 }],
      meshes: [{ name: 'quad', primitives: [{ attributes: { POSITION: POS, NORMAL: NRM, TEXCOORD_0: UV }, indices: IDX, material: 0 }] }],
      materials: [{ name: material, pbrMetallicRoughness: { baseColorFactor: [0.25, 0.2, 0.16, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
      accessors: g.accessors,
      bufferViews: g.views,
      buffers: [{ byteLength: bin.length }],
    },
    bin,
  );
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

/**
 * Ground cover pieces (one per name): a single low tuft each — one ring of
 * five sides, ten triangles, no levels — as a game's grass and pebbles are,
 * so a few thousand near the camera cost what they would in a game.
 */
export function coverKitGlb(seed: number, names: readonly string[]): Buffer {
  const rnd = prng(seed);
  const g = new GlbData();
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  for (const name of names) {
    const height = 0.15 + rnd() * 0.25;
    const base = 0.08 + rnd() * 0.12;
    meshes.push(latheMesh(g, name, lathe(1, 5, height, (t) => base * (1 - t * 0.9) + 0.01), height, 0));
    nodes.push({ name, mesh: meshes.length - 1 });
  }
  const bin = g.bin();
  return packGlb(
    {
      asset: { version: '2.0', generator: 'thirdlight perf cover kit' },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      nodes,
      meshes,
      materials: [{ name: 'cover', pbrMetallicRoughness: { baseColorFactor: [0.35, 0.55, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.95 } }],
      accessors: g.accessors,
      bufferViews: g.views,
      buffers: [{ byteLength: bin.length }],
    },
    bin,
  );
}

/** A clump's levels: blades and segments per blade (a blade of `s` segments is `2s - 1` triangles). */
export const CLUMP_LEVELS: readonly { blades: number; segments: number }[] = [
  { blades: 12, segments: 3 },
  { blades: 7, segments: 2 },
  { blades: 6, segments: 1 },
];

/** A clump mesh: positions, flat normals, UVs, COLOR_0 (RGBA bytes) and 16-bit indices. */
export interface ClumpMesh {
  pos: Float32Array;
  nrm: Float32Array;
  uv: Float32Array;
  color: Uint8Array;
  idx: Uint16Array;
  height: number;
  radius: number;
}

/**
 * A clump of blades standing on y = 0 within `spread` m of the origin: each a
 * strip tapering to a point, leaning and curving out, `height` m tall at
 * most. COLOR_0 follows the foliage material's convention (R the bend weight,
 * 0 at the root and 1 at the tip; G a phase per blade; B flutter, the tip
 * most; A thinness), so the engine's wind moves it as it would a game's grass.
 */
export function bladeClump(seed: number, blades: number, segments: number, height = 0.8, spread = 0.12): ClumpMesh {
  const rnd = prng(seed);
  const perBlade = 2 * segments + 1;
  const verts = blades * perBlade;
  const pos = new Float32Array(verts * 3);
  const nrm = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  const color = new Uint8Array(verts * 4);
  const idx = new Uint16Array(blades * (2 * segments - 1) * 3);
  let v = 0;
  let i = 0;
  let top = 0;
  let radius = 0;
  for (let b = 0; b < blades; b += 1) {
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * spread;
    const bx = Math.cos(a) * r;
    const bz = Math.sin(a) * r;
    // Blades lean outward from the clump's middle, and face across their lean.
    const lean = 0.15 + rnd() * 0.35;
    const out = rnd() * Math.PI * 2;
    const dx = Math.cos(out);
    const dz = Math.sin(out);
    const h = height * (0.6 + 0.4 * rnd());
    const w = 0.025 + rnd() * 0.02;
    const phase = Math.floor(rnd() * 255);
    const first = v;
    for (let k = 0; k <= segments; k += 1) {
      const t = k / segments;
      // The lean grows with height (a curve), the width shrinks to nothing at the tip.
      const off = lean * h * t * t;
      const cx = bx + dx * off;
      const cz = bz + dz * off;
      const y = h * t * (1 - 0.15 * lean * t);
      const half = (w / 2) * (1 - t);
      const sides = k === segments ? [0] : [-1, 1];
      for (const s of sides) {
        pos.set([cx - dz * half * s, y, cz + dx * half * s], v * 3);
        nrm.set([dx, 0.3, dz], v * 3);
        uv.set([k === segments ? 0.5 : (s + 1) / 2, 1 - t], v * 2);
        color.set([Math.round(255 * t), phase, Math.round(255 * t * t), 140], v * 4);
        radius = Math.max(radius, Math.hypot(cx, cz) + half);
        top = Math.max(top, y);
        v += 1;
      }
    }
    // Quads up the strip (rows of two vertices), the last row a single triangle to the tip.
    for (let k = 0; k < segments; k += 1) {
      const a0 = first + 2 * k;
      if (k < segments - 1) {
        idx.set([a0, a0 + 1, a0 + 2, a0 + 1, a0 + 3, a0 + 2], i);
        i += 6;
      } else {
        idx.set([a0, a0 + 1, a0 + 2], i);
        i += 3;
      }
    }
  }
  // Normals: the lean direction tilted up, unit length.
  for (let k = 0; k < verts; k += 1) {
    const l = Math.hypot(nrm[k * 3]!, nrm[k * 3 + 1]!, nrm[k * 3 + 2]!);
    for (let c = 0; c < 3; c += 1) nrm[k * 3 + c]! /= l;
  }
  return { pos, nrm, uv, color, idx, height: top, radius };
}

/**
 * A stand-in grass kit: one piece `clump` with levels `clump_LOD0..2`
 * ({@link CLUMP_LEVELS}: about 60, 20 and 6 triangles), one material named
 * `grass`. A neutral, generated shape for measuring, not art.
 */
export function clumpKitGlb(seed: number, height = 0.8): Buffer {
  const g = new GlbData();
  const meshes: Record<string, unknown>[] = [];
  const nodes: Record<string, unknown>[] = [];
  CLUMP_LEVELS.forEach((lv, l) => {
    const m = bladeClump(seed, lv.blades, lv.segments, height);
    const n = m.pos.length / 3;
    const POS = g.accessor(m.pos, FLOAT, n, 'VEC3', { min: [-m.radius, 0, -m.radius], max: [m.radius, m.height, m.radius] }, ARRAY);
    const NRM = g.accessor(m.nrm, FLOAT, n, 'VEC3', {}, ARRAY);
    const UV = g.accessor(m.uv, FLOAT, n, 'VEC2', {}, ARRAY);
    const COL = g.accessor(m.color, U8, n, 'VEC4', { normalized: true }, ARRAY);
    const IDX = g.accessor(m.idx, U16, m.idx.length, 'SCALAR', {}, ELEMENTS);
    meshes.push({ name: `clump_LOD${l}`, primitives: [{ attributes: { POSITION: POS, NORMAL: NRM, TEXCOORD_0: UV, COLOR_0: COL }, indices: IDX, material: 0 }] });
    nodes.push({ name: `clump_LOD${l}`, mesh: l });
  });
  const bin = g.bin();
  return packGlb(
    {
      asset: { version: '2.0', generator: 'thirdlight perf grass clump' },
      scene: 0,
      scenes: [{ nodes: nodes.map((_, i) => i) }],
      nodes,
      meshes,
      materials: [{ name: 'grass', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.3, 0.5, 0.18, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
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
