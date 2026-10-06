/**
 * World-aligned texture coordinates on block looks: box mapping per flat face
 * normal (tops X/Z, walls facing ±X Z/Y, walls facing ±Z X/Y), in metres from
 * the layer origin, so a texture runs on across cells; vertices split where
 * the projection changes; slopes switch to their wall's projection past 45°;
 * tangents along +u with the handedness that puts −v (the image's up, as glTF) on the bitangent; a model
 * piece without texture coordinates takes world ones; `uv` validated on block
 * types and variants.
 */
import { describe, expect, it } from 'vitest';

import { BlockGrid } from './block-grid';
import { blockVariantUv, canonicalBlockType, validateBlockType, type BlockType } from './block-layers';
import { meshBlockChunk, projectionOf, shapeSource, WORLD_UV_PERIOD_METRES, type BlockLookResolver, type BlockMeshSource, type ChunkMeshPart } from './block-mesh';
import type { ModelErrorV2 } from './errors';

const TYPES: BlockType[] = [
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full' },
  { blockId: 'ramp', name: 'Ramp', variants: [{ color: '#777777' }], shape: 'ramp' },
];
const types = new Map(TYPES.map((t) => [t.blockId, t]));
/** Stand-ins with world texture coordinates and tangents (as the renderer asks for a stand-in with a mapped material). */
const world: BlockLookResolver = { source: (t, v, fm) => ({ key: `${t.blockId}:${v}`, source: shapeSource(t.shape, fm[0], fm[1], fm[2], t.boxes), uv: 'world', tangents: true }) };

interface Vertex {
  p: [number, number, number];
  n: [number, number, number];
  uv: [number, number];
  t: [number, number, number, number] | null;
}

const vertex = (part: ChunkMeshPart, i: number): Vertex => ({
  p: [part.positions[i * 3]!, part.positions[i * 3 + 1]!, part.positions[i * 3 + 2]!],
  n: [part.normals[i * 3]!, part.normals[i * 3 + 1]!, part.normals[i * 3 + 2]!],
  uv: [part.uvs[i * 2]!, part.uvs[i * 2 + 1]!],
  t: part.tangents === undefined ? null : [part.tangents[i * 4]!, part.tangents[i * 4 + 1]!, part.tangents[i * 4 + 2]!, part.tangents[i * 4 + 3]!],
});

function triangles(parts: readonly ChunkMeshPart[]): Vertex[][] {
  const out: Vertex[][] = [];
  for (const p of parts) for (let i = 0; i < p.indices.length; i += 3) out.push([0, 1, 2].map((k) => vertex(p, p.indices[i + k]!)));
  return out;
}

const faceNormal = (t: Vertex[]): [number, number, number] => {
  const [a, b, c] = t as [Vertex, Vertex, Vertex];
  const e = [b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]];
  const f = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
  const n: [number, number, number] = [e[1]! * f[2]! - e[2]! * f[1]!, e[2]! * f[0]! - e[0]! * f[2]!, e[0]! * f[1]! - e[1]! * f[0]!];
  const len = Math.hypot(...n);
  return [n[0] / len, n[1] / len, n[2] / len];
};

/** The surface directions of +u and +v over a triangle (from its positions and uvs). */
function uvDirections(t: Vertex[]): { du: number[]; dv: number[] } {
  const [a, b, c] = t as [Vertex, Vertex, Vertex];
  const e1 = [0, 1, 2].map((k) => b.p[k]! - a.p[k]!);
  const e2 = [0, 1, 2].map((k) => c.p[k]! - a.p[k]!);
  const [u1, v1] = [b.uv[0] - a.uv[0], b.uv[1] - a.uv[1]];
  const [u2, v2] = [c.uv[0] - a.uv[0], c.uv[1] - a.uv[1]];
  const r = 1 / (u1 * v2 - u2 * v1);
  const du = [0, 1, 2].map((k) => (e1[k]! * v2 - e2[k]! * v1) * r);
  const dv = [0, 1, 2].map((k) => (e2[k]! * u1 - e1[k]! * u2) * r);
  const unit = (x: number[]): number[] => x.map((y) => y / Math.hypot(x[0]!, x[1]!, x[2]!));
  return { du: unit(du), dv: unit(dv) };
}

const close = (a: readonly number[], b: readonly number[], eps = 1e-5): boolean => a.every((x, i) => Math.abs(x - b[i]!) < eps);
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): number[] => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

describe('block looks: world texture coordinates', () => {
  it('picks a projection per flat face normal; a slope stays on the top up to 45° and takes its wall past it', () => {
    expect(projectionOf(0, 1, 0)).toBe(2);
    expect(projectionOf(0, -1, 0)).toBe(3);
    expect(projectionOf(1, 0, 0)).toBe(0);
    expect(projectionOf(-1, 0, 0)).toBe(1);
    expect(projectionOf(0, 0, 1)).toBe(4);
    expect(projectionOf(0, 0, -1)).toBe(5);
    // 45° exactly (as floats round it) is still a top; a hair steeper is the wall's.
    const r = Math.SQRT1_2;
    expect(projectionOf(r, Math.fround(r) * (1 - 1e-8), 0)).toBe(2);
    expect(projectionOf(0, Math.cos((46 * Math.PI) / 180), -Math.sin((46 * Math.PI) / 180))).toBe(5);
    expect(projectionOf(0, Math.cos((44 * Math.PI) / 180), -Math.sin((44 * Math.PI) / 180))).toBe(2);
  });

  it('a row of cells reads one texture on across their edges, in metres, upright and unmirrored on every wall', () => {
    // 2 m cells, 0.5 m tall: a top's u is x in metres, a wall's v runs down from y in metres.
    const g = new BlockGrid({ cellSize: [2, 0.5, 2], bounds: { min: [0, 0, 0], max: [4, 2, 1] } });
    for (let x = 0; x < 4; x++) g.set(x, 0, 0, { block: 'stone' });
    const tris = triangles(meshBlockChunk(g, 0, 0, types, world));
    const tops = tris.filter((t) => t.every((v) => v.n[1] > 0.99));
    expect(tops).toHaveLength(8);
    for (const v of tops.flat()) expect(v.uv).toEqual([v.p[0], v.p[2]]);
    // The top's u covers the whole row, 0..8 m: no cell starts over at 0.
    expect(Math.max(...tops.flat().map((v) => v.uv[0]))).toBe(8);
    // Each wall seen from outside: u runs to the viewer's right, v down the wall.
    const wall = (n: [number, number, number]): Vertex[] => tris.filter((t) => t.every((v) => close(v.n, n))).flat();
    for (const v of wall([0, 0, 1])) expect(v.uv).toEqual([v.p[0], -v.p[1]]);
    for (const v of wall([0, 0, -1])) expect(v.uv).toEqual([-v.p[0], -v.p[1]]);
    for (const v of wall([1, 0, 0])) expect(v.uv).toEqual([-v.p[2], -v.p[1]]);
    for (const v of wall([-1, 0, 0])) expect(v.uv).toEqual([v.p[2], -v.p[1]]);
    expect(wall([0, 0, 1])).toHaveLength(24);
    // Two neighbouring cells give the vertices on their shared edge the same uv (no seam).
    const at = new Map<string, string>();
    for (const v of tops.flat()) {
      const k = v.p.join(',');
      const uv = v.uv.join(',');
      expect(at.get(k) ?? uv).toBe(uv);
      at.set(k, uv);
    }
  });

  it('a turned cell keeps the world mapping (the texture does not turn with the cell)', () => {
    const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [3, 2, 3] } });
    g.set(1, 0, 1, { block: 'ramp', rot: 90 });
    g.set(2, 0, 1, { block: 'ramp', rot: 270 });
    for (const t of triangles(meshBlockChunk(g, 0, 0, types, world))) {
      const n = faceNormal(t);
      const proj = projectionOf(...n);
      for (const v of t) {
        const expected = [[-v.p[2], -v.p[1]], [v.p[2], -v.p[1]], [v.p[0], v.p[2]], [v.p[0], -v.p[2]], [v.p[0], -v.p[1]], [-v.p[0], -v.p[1]]][proj]!;
        expect(close(v.uv, expected)).toBe(true);
      }
    }
  });

  it('a ramp at 45° maps its slope like a top; a steeper one like the wall it faces', () => {
    const slopeOf = (h: number): Vertex[] => {
      const g = new BlockGrid({ cellSize: [1, h, 1], bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
      g.set(0, 0, 0, { block: 'ramp' });
      // The slope faces up and toward −Z.
      return triangles(meshBlockChunk(g, 0, 0, types, world)).filter((t) => t.every((v) => v.n[1] > 0.01 && v.n[2] < -0.01)).flat();
    };
    const gentle = slopeOf(1);
    expect(gentle.length).toBeGreaterThan(0);
    for (const v of gentle) expect(v.uv).toEqual([v.p[0], v.p[2]]);
    const steep = slopeOf(2);
    expect(steep.length).toBeGreaterThan(0);
    for (const v of steep) expect(v.uv).toEqual([-v.p[0], -v.p[1]]);
  });

  it('splits a vertex shared by faces of two projections, and keeps it whole with the look’s own coordinates', () => {
    // A roof of two quads sharing its ridge (vertices 4, 5): one side at 30° (a top), the other at 60° (a wall facing +Z).
    const ridge = 0.6 + Math.tan((30 * Math.PI) / 180) * 0.5;
    const low = ridge - Math.tan((60 * Math.PI) / 180) * 0.5;
    const n30 = [0, Math.cos((30 * Math.PI) / 180), -Math.sin((30 * Math.PI) / 180)];
    const n60 = [0, Math.cos((60 * Math.PI) / 180), Math.sin((60 * Math.PI) / 180)];
    // The ridge's normals are the sides' average, as a smooth model's would be.
    const mid = [0, n30[1]! + n60[1]!, n30[2]! + n60[2]!];
    const avg = mid.map((x) => x / Math.hypot(...mid));
    const positions = new Float32Array([-0.5, 0.6, -0.5, 0.5, 0.6, -0.5, -0.5, low, 0.5, 0.5, low, 0.5, -0.5, ridge, 0, 0.5, ridge, 0]);
    const normals = new Float32Array([...n30, ...n30, ...n60, ...n60, ...avg, ...avg]);
    const indices = new Uint32Array([0, 4, 5, 0, 5, 1, 4, 2, 3, 4, 3, 5]);
    const roof = (uvs?: Float32Array): BlockMeshSource => ({ positions, normals, ...(uvs !== undefined ? { uvs } : {}), indices, groups: [{ start: 0, count: 12, material: 0 }] });
    const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
    g.set(0, 0, 0, { block: 'stone' });
    const mesh = (src: BlockMeshSource, uv?: 'world'): ChunkMeshPart => meshBlockChunk(g, 0, 0, types, { source: () => ({ key: 'roof', source: src, ...(uv !== undefined ? { uv } : {}) }) })[0]!;
    const own = new Float32Array(12).map((_, i) => i / 12);
    // Its own coordinates: one vertex per source vertex.
    expect(mesh(roof(own)).positions.length / 3).toBe(6);
    expect(new Set(mesh(roof(own)).uvs)).toEqual(new Set(own));
    // World ones: the ridge's two vertices split (one per projection), so no triangle mixes two.
    const w = mesh(roof(own), 'world');
    expect(w.positions.length / 3).toBe(8);
    for (const t of triangles([w])) {
      const proj = projectionOf(...faceNormal(t));
      expect([2, 4]).toContain(proj);
      for (const v of t) expect(close(v.uv, proj === 2 ? [v.p[0], v.p[2]] : [v.p[0], -v.p[1]])).toBe(true);
    }
  });

  it('a model piece without texture coordinates takes world ones; the rest keep their own', () => {
    const src = shapeSource('full', 1, 1, 1);
    // The first face's vertices have none (NaN), as a merged model gives a piece without UVs.
    const uvs = new Float32Array((src.positions.length / 3) * 2).fill(0.25);
    for (let i = 0; i < 8; i++) uvs[i] = NaN;
    const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [3, 1, 1] } });
    g.set(2, 0, 0, { block: 'stone' });
    const [part] = meshBlockChunk(g, 0, 0, types, { source: () => ({ key: 'piece', source: { ...src, uvs } }) });
    const vs = triangles([part!]).flat();
    // The +X face (the source's first quad) at x = 3: world uvs (−z, −y); every other face its own 0.25.
    for (const v of vs) {
      if (close(v.n, [1, 0, 0])) expect(v.uv).toEqual([-v.p[2], -v.p[1]]);
      else expect(v.uv).toEqual([0.25, 0.25]);
    }
    expect(vs.some((v) => close(v.n, [1, 0, 0]))).toBe(true);
    expect(part!.tangents).toBeUndefined();
  });

  it('tangents run along +u over the surface, and cross(normal, tangent) × w along −v (glTF: up the image), on flat and sloped faces and smoothed tops', () => {
    const q = (v: number): number => Math.round(v * 16) / 16;
    const g = new BlockGrid({ cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [16, 24, 16] } });
    const h = (x: number, z: number): number => q(8 + 3 * Math.sin(x / 3) * Math.cos(z / 4));
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      const c = [h(x, z), h(x + 1, z), h(x + 1, z + 1), h(x, z + 1)];
      const row = Math.floor(Math.min(...c) - 1e-9);
      for (let y = 0; y < row; y++) g.set(x, y, z, { block: 'stone' });
      const corners = c.map((v) => v - row) as [number, number, number, number];
      g.set(x, row, z, { block: 'stone', ...(corners.every((v) => v === 1) ? {} : { corners }) });
    }
    g.set(3, 20, 3, { block: 'ramp', rot: 180 });
    for (const options of [{}, { smoothAngle: 40, topSubdivision: 2 }]) {
      const parts = meshBlockChunk(g, 0, 0, types, world, options);
      expect(parts.every((p) => p.tangents !== undefined && p.tangents.length === (p.positions.length / 3) * 4)).toBe(true);
      let checked = 0;
      for (const t of triangles(parts)) {
        const { du, dv } = uvDirections(t);
        for (const v of t) {
          const tan = v.t!;
          expect(Math.abs(Math.hypot(tan[0], tan[1], tan[2]) - 1)).toBeLessThan(1e-5);
          expect(Math.abs(tan[3])).toBe(1);
          // Perpendicular to the vertex normal, the same way as +u, and its bitangent the same way as −v.
          expect(Math.abs(dot(tan, v.n))).toBeLessThan(1e-4);
          expect(dot(tan, du)).toBeGreaterThan(0.5);
          expect(dot(cross(v.n, tan).map((x) => x * tan[3]), dv)).toBeLessThan(-0.5);
          // On a flat-shaded face it is exactly the face's own +u.
          if (close(v.n, faceNormal(t), 1e-6)) expect(close(tan.slice(0, 3), du, 1e-4)).toBe(true);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(1000);
    }
  });
});

describe('block looks: world tangents on smooth models, and UVs far out', () => {
  it('a smooth bevel\'s tangent is its face\'s +u made perpendicular to the vertex normal, never tipped toward the projected-away axis', () => {
    // One quad at 60° facing +Z (a wall's projection: u along x), its vertex normals leaning far toward ±X as a rounded bevel's are.
    const c60 = Math.cos((60 * Math.PI) / 180);
    const s60 = Math.sin((60 * Math.PI) / 180);
    const lean = (sx: number): number[] => {
      const n = [sx * 0.7, 0.7, 0.05];
      const l = Math.hypot(...n);
      return n.map((x) => x / l);
    };
    const positions = new Float32Array([-0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, c60 * 0.5 / s60 + 0.2, 0.2, -0.5, c60 * 0.5 / s60 + 0.2, 0.2]);
    // The last vertex's normal runs along +x itself (the face's +u): the tangent falls back to cross(normal, +v).
    const normals = new Float32Array([...lean(-1), ...lean(1), ...lean(1), 1, 0, 0]);
    const src: BlockMeshSource = { positions, normals, indices: new Uint32Array([0, 1, 2, 0, 2, 3]), groups: [{ start: 0, count: 6, material: 0 }] };
    const g = new BlockGrid({ cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [1, 1, 1] } });
    g.set(0, 0, 0, { block: 'stone' });
    const [part] = meshBlockChunk(g, 0, 0, types, { source: () => ({ key: 'bevel', source: src, uv: 'world', tangents: true }) });
    const tris = triangles([part!]);
    expect(tris.length).toBe(2);
    let fallback = 0;
    for (const t of tris) {
      expect(projectionOf(...faceNormal(t))).toBe(4);
      const { du, dv } = uvDirections(t);
      for (const v of t) {
        const tan = v.t!;
        expect(tan.every(Number.isFinite)).toBe(true);
        expect(Math.abs(Math.hypot(tan[0], tan[1], tan[2]) - 1)).toBeLessThan(1e-5);
        expect(Math.abs(dot(tan, v.n))).toBeLessThan(1e-5);
        expect(Math.abs(tan[3])).toBe(1);
        // Along +u there is no +u on the surface: any unit tangent perpendicular to the normal (checked above).
        if (Math.abs(dot(v.n, du)) > 0.999) {
          fallback++;
          continue;
        }
        // Gram-Schmidt of the face's +u against the vertex normal.
        const k = dot(du, v.n);
        const gs = du.map((x, i) => x - v.n[i]! * k);
        const l = Math.hypot(...gs);
        expect(close(tan.slice(0, 3), gs.map((x) => x / l), 1e-4)).toBe(true);
        // Solving +u from the vertex normal alone tipped this one nearly onto z (|t.z| ≈ 0.99); along the face it stays mostly x.
        expect(Math.abs(tan[0])).toBeGreaterThan(0.5);
        // Its bitangent (cross(normal, tangent) × w) runs up the image (−v), as everywhere else.
        expect(dot(cross(v.n, tan).map((x) => x * tan[3]), dv)).toBeLessThan(0);
      }
    }
    expect(fallback).toBeGreaterThan(0);
  });

  it('wraps world UVs per chunk by whole periods: small far from the origin, continuous across chunks, unchanged near it', () => {
    // 4 m cells: chunk 11 starts at 704 m (period 0), chunk 12 at 768 m (period 1, less 720 m).
    const g = new BlockGrid({ cellSize: [4, 1, 4], bounds: { min: [170, 0, 0], max: [194, 1, 1] } });
    for (let x = 170; x < 194; x++) g.set(x, 0, 0, { block: 'stone' });
    const tops = (cx: number): Vertex[] => triangles(meshBlockChunk(g, cx, 0, types, world)).filter((t) => t.every((v) => v.n[1] > 0.99)).flat();
    const near = tops(11);
    const far = tops(12);
    expect(near.length).toBeGreaterThan(0);
    expect(far.length).toBeGreaterThan(0);
    for (const v of near) expect(v.uv).toEqual([v.p[0], v.p[2]]);
    for (const v of far) expect(v.uv).toEqual([Math.fround(v.p[0] - WORLD_UV_PERIOD_METRES), v.p[2]]);
    // The shared edge at 768 m: u = 768 on one side, 48 on the other — a whole period apart, so any repeat dividing 720 m meets itself.
    const edge = (vs: Vertex[]): number[] => [...new Set(vs.filter((v) => v.p[0] === 768).map((v) => v.uv[0]))];
    expect(edge(near)).toEqual([768]);
    expect(edge(far)).toEqual([48]);
    expect((768 - 48) % WORLD_UV_PERIOD_METRES).toBe(0);
    for (const tiling of [1, 2, 3, 4, 5, 8, 16, 0.5, 0.25, 1.5]) expect(Number.isInteger(WORLD_UV_PERIOD_METRES / tiling)).toBe(true);
    // 40 km out (float32 steps 4 mm there), a chunk's UVs stay under a period plus a chunk.
    const big = new BlockGrid({ cellSize: [4, 1, 4], bounds: { min: [10000, 0, 10000], max: [10016, 1, 10016] } });
    big.set(10003, 0, 10005, { block: 'stone' });
    const bt = triangles(meshBlockChunk(big, 625, 625, types, world)).flat();
    expect(bt.length).toBeGreaterThan(0);
    for (const v of bt) {
      expect(Math.abs(v.uv[0])).toBeLessThan(WORLD_UV_PERIOD_METRES + 64);
      expect(Math.abs(v.uv[1])).toBeLessThan(WORLD_UV_PERIOD_METRES + 64);
    }
  });
});

describe('block types: uv', () => {
  const errs = (t: unknown): string[] => {
    const e: ModelErrorV2[] = [];
    validateBlockType(t, '/t', e);
    return e.map((x) => x.path);
  };
  const base = { blockId: 'tile', name: 'Tile', shape: 'full', variants: [{ color: '#808080' }] };

  it('is model or world on a type and on each variant; absent is model and only world is stored on the type', () => {
    expect(errs({ ...base, uv: 'world' })).toEqual([]);
    expect(errs({ ...base, uv: 'model', variants: [{ color: '#808080', uv: 'world' }] })).toEqual([]);
    expect(errs({ ...base, uv: 'planar' })).toEqual(['/t/uv']);
    expect(errs({ ...base, variants: [{ color: '#808080', uv: 1 }] })).toEqual(['/t/variants/0/uv']);
    const t = { ...base, uv: 'model', variants: [{ color: '#808080', uv: 'model' }, { color: '#909090' }] } as BlockType;
    // A variant's own `model` overrides a world type, so it is kept; the type's default is not stored.
    expect(canonicalBlockType(t)).toEqual({ blockId: 'tile', name: 'Tile', shape: 'full', variants: [{ color: '#808080', uv: 'model' }, { color: '#909090' }] });
    expect(canonicalBlockType({ ...t, uv: 'world' }).uv).toBe('world');
    expect(blockVariantUv(t, 0)).toBe('model');
    expect(blockVariantUv({ ...t, uv: 'world' }, 0)).toBe('model');
    expect(blockVariantUv({ ...t, uv: 'world' }, 1)).toBe('world');
    expect(blockVariantUv({ ...t, uv: 'world' }, 7)).toBe('model');
    expect(blockVariantUv(base as BlockType, 0)).toBe('model');
  });
});
