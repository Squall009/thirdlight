/**
 * A model's collision geometry read from GLB bytes: the `_COL` parts in the
 * model's root space (node transforms applied), one hull per primitive, the
 * shapes the conversion makes from them, Draco parts reported, meshopt
 * decoded, and the 2D plane's polygons.
 */
import { describe, expect, it } from 'vitest';

import { collisionPartPolygons, modelColliderShape, modelCollisionParts, readModelGeometry, sceneColliderPoints } from './model-collision';

const RAW = import.meta.glob('../../../fixtures/import-ext/bytes.base64.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

/** A GLB from a JSON document and one binary buffer. */
function glb(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  let j = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, ...json, buffers: [{ byteLength: bin.length }] }));
  if (j.length % 4 !== 0) {
    const p = new Uint8Array(j.length + (4 - (j.length % 4))).fill(0x20);
    p.set(j);
    j = p;
  }
  const bpad = (4 - (bin.length % 4)) % 4;
  const out = new Uint8Array(20 + j.length + 8 + bin.length + bpad);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, bin.length + bpad, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}

/** A kit file: `crate_LOD0` (a 1 m cube from y 0 to 1), `crate_COL` holding two box parts (one moved and one turned by their nodes), and a Draco part. */
function kit(): Uint8Array {
  const corners: number[] = [];
  for (const x of [-0.5, 0.5]) for (const y of [0, 1]) for (const z of [-0.5, 0.5]) corners.push(x, y, z);
  const pos = new Float32Array(corners);
  const idx = new Uint16Array([0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3]);
  const bin = new Uint8Array(pos.byteLength + idx.byteLength);
  bin.set(new Uint8Array(pos.buffer), 0);
  bin.set(new Uint8Array(idx.buffer), pos.byteLength);
  const prim = { attributes: { POSITION: 0 }, indices: 1 };
  return glb({
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [
      { name: 'crate_LOD0', mesh: 0 },
      { name: 'crate_COL', children: [2, 3, 4] },
      { name: 'part a', mesh: 0 },
      { name: 'part b', mesh: 0, translation: [2, 0, 0], scale: [0.5, 0.5, 0.5], rotation: [0, 0.7071067811865476, 0, 0.7071067811865476] },
      { name: 'part c', mesh: 1 },
    ],
    meshes: [{ primitives: [prim] }, { primitives: [{ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: { bufferView: 0, attributes: { POSITION: 0 } } } }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: idx.byteLength }],
  }, bin);
}

const boundsOf = (points: readonly (readonly number[])[]): { min: number[]; max: number[] } => ({
  min: [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k]!))),
  max: [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k]!))),
});

describe('model collision geometry', () => {
  it('reads each _COL primitive as a convex part in root space, with Draco parts reported', () => {
    const read = readModelGeometry(kit());
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const { parts, skipped } = modelCollisionParts(read.geometry, 'crate');
    expect(parts).toHaveLength(2);
    expect(boundsOf(parts[0]!.points)).toEqual({ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] });
    // Half size, turned 90° about Y (a cube stays a cube), moved 2 m along X.
    expect(boundsOf(parts[1]!.points)).toEqual({ min: [1.75, 0, -0.25], max: [2.25, 0.5, 0.25] });
    expect(skipped.some((s) => s.includes('Draco'))).toBe(true);
    // A file read as a whole (no piece) takes every _COL node.
    expect(modelCollisionParts(read.geometry, null).parts).toHaveLength(2);
    expect(modelCollisionParts(read.geometry, 'barrel').parts).toHaveLength(0);
  });

  it('makes the conversion shapes: a centred box, a hull and a mesh of the _COL node, a compound of its parts', () => {
    const read = readModelGeometry(kit());
    if (!read.ok) throw new Error(read.message);
    const g = read.geometry;
    const box = modelColliderShape(g, 'crate', 'box');
    expect(box).toMatchObject({ ok: true, shape: { type: 'box', hx: 0.5, hy: 0.5, hz: 0.5, center: [0, 0.5, 0] }, source: 'geometry' });
    const hull = modelColliderShape(g, 'crate', 'convex');
    expect(hull.ok && hull.source).toBe('collision');
    expect(hull.ok && boundsOf((hull.shape as { points: number[][] }).points)).toEqual({ min: [-0.5, 0, -0.5], max: [2.25, 1, 0.5] });
    const mesh = modelColliderShape(g, 'crate', 'mesh');
    expect(mesh.ok && (mesh.shape as { triangles: unknown[] }).triangles.length).toBe(24);
    const compound = modelColliderShape(g, 'crate', 'compound');
    expect(compound.ok && compound.shape['type']).toBe('compound');
    expect(compound.ok && (compound.shape as { shapes: { type: string }[] }).shapes.map((s) => s.type)).toEqual(['convex', 'convex']);
  });

  it('gives each part its 2D polygon on the play plane', () => {
    const read = readModelGeometry(kit());
    if (!read.ok) throw new Error(read.message);
    const polys = collisionPartPolygons(modelCollisionParts(read.geometry, 'crate').parts);
    expect(polys).toEqual([[[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]], [[1.75, 0], [2.25, 0], [2.25, 0.5], [1.75, 0.5]]]);
  });

  it('decodes EXT_meshopt_compression geometry', () => {
    const sidecar = JSON.parse(Object.values(RAW)[0]!) as Record<string, string>;
    const text = sidecar['meshopt-cube.glb']!;
    const bytes = Uint8Array.from(atob(text.replace(/\s/g, '')), (c) => c.charCodeAt(0));
    const read = readModelGeometry(bytes);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const all = read.geometry.primitives.flatMap((p) => p.positions);
    expect(all.length).toBeGreaterThan(0);
    // The quantized int16 positions (min -32767 … max 32767), dequantized by the node's scale, make the 1 m cube.
    const b = boundsOf(all);
    for (let k = 0; k < 3; k += 1) {
      expect(b.min[k]).toBeCloseTo(-0.5, 4);
      expect(b.max[k]).toBeCloseTo(0.5, 4);
    }
  });
});

describe('a scene\'s collider point count', () => {
  it('counts written hulls and meshes, and each model collider\'s resolved parts per object', () => {
    const cube = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
    const table = { 'model-a': { '': [cube, cube.slice(0, 4)], door: [cube] } };
    const ent = (components: Record<string, unknown>) => ({ id: 'e', components });
    const entities = [
      ent({ collider: { shape: { type: 'convex', points: cube } } }),
      ent({ collider: { shape: { type: 'box', hx: 1, hy: 1, hz: 1 } } }),
      ent({ model: { asset: { assetId: 'model-a' } }, collider: { shape: { type: 'model' } } }),
      ent({ model: { asset: { assetId: 'model-a' } }, collider: { shape: { type: 'model' } } }),
      ent({ model: { asset: { assetId: 'model-a' }, piece: 'door' }, collider: { shape: { type: 'model' } } }),
      ent({ model: { asset: { assetId: 'model-missing' } }, collider: { shape: { type: 'model' } } }),
    ];
    expect(sceneColliderPoints(entities, table)).toBe(8 + 12 + 12 + 8);
    expect(sceneColliderPoints(entities, undefined)).toBe(8);
  });
});
