/**
 * Vertex paint is stored per model mesh by name (node path and primitive) and
 * tied to the mesh's vertex count and position hash, as the backend reads
 * the file (project-model `readModelGeometry`, `paintableMeshes`). The page
 * draws paint only where its loaded mesh carries the same name and the same
 * hash (three-adapter `gltf-loader.ts`, `vertex-paint-models.ts`): this
 * checks both sides agree on a file with nested, same-named and unnamed
 * nodes, several primitives, and a normalized 16-bit (quantized) POSITION.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { paintableMeshes } from '../packages/project-model/src/vertex-paint';
import { readModelGeometry } from '../packages/project-model/src/model-collision';
import { createGltfLoaderPort } from '../packages/three-adapter/src/gltf-loader';
import { packGlb, descriptorFor } from '../packages/three-adapter/src/test-glb';
import { geometryPaintHash } from '../packages/three-adapter/src/vertex-paint-models';
import { PAINT_MESH_KEY } from '../packages/three-adapter/src/vertex-paint-draw';

/** A GLB: Body { Hull (2 primitives), Hull (quantized), (unnamed) } and a root Rock. */
function glb(): Uint8Array {
  const bin: number[] = [];
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const push = (bytes: Uint8Array): number => {
    while (bin.length % 4 !== 0) bin.push(0);
    views.push({ buffer: 0, byteOffset: bin.length, byteLength: bytes.length });
    for (const b of bytes) bin.push(b);
    return views.length - 1;
  };
  const f32 = (v: number[]): Uint8Array => new Uint8Array(new Float32Array(v).buffer);
  const i16 = (v: number[]): Uint8Array => {
    // VEC3 of int16, padded to 4-byte elements (stride 8).
    const out = new Int16Array(v.length / 3 * 4);
    for (let i = 0; i < v.length / 3; i += 1) out.set(v.slice(i * 3, i * 3 + 3), i * 4);
    return new Uint8Array(out.buffer);
  };
  const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const quad = [0, 0, 0, 0.5, 0, 0, 0.5, 0.25, 0, 0, 0.25, 0.125];
  const accessors: Record<string, unknown>[] = [];
  const acc = (view: number, count: number, extra: Record<string, unknown> = {}): number => accessors.push({ bufferView: view, componentType: 5126, count, type: 'VEC3', ...extra }) - 1;
  const a0 = acc(push(f32(tri)), 3, { min: [0, 0, 0], max: [1, 1, 0] });
  const a1 = acc(push(f32(quad)), 4, { min: [0, 0, 0], max: [0.5, 0.25, 0.125] });
  const qView = push(i16([0, 0, 0, 32767, 0, 0, 0, 16384, -12000]));
  views[qView] = { ...views[qView]!, byteStride: 8 } as never;
  const a2 = acc(qView, 3, { componentType: 5122, normalized: true, min: [0, -0.367, 0], max: [1, 0.5, 0] });
  const a3 = acc(push(f32([2, 0, 0, 3, 0, 0, 2, 1, 1])), 3, { min: [2, 0, 0], max: [3, 1, 1] });
  const json = {
    asset: { version: '2.0' },
    extensionsUsed: ['KHR_mesh_quantization'],
    extensionsRequired: ['KHR_mesh_quantization'],
    scene: 0,
    scenes: [{ nodes: [0, 4] }],
    nodes: [
      { name: 'Body', children: [1, 2, 3] },
      { name: 'Hull', mesh: 0 },
      { name: 'Hull', mesh: 1, translation: [0, 2, 0] },
      { mesh: 2 },
      { name: 'Rock', mesh: 2, scale: [2, 2, 2] },
    ],
    meshes: [
      { primitives: [{ attributes: { POSITION: a0 } }, { attributes: { POSITION: a1 } }] },
      { primitives: [{ attributes: { POSITION: a2 } }] },
      { primitives: [{ attributes: { POSITION: a3 } }] },
    ],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: Math.ceil(bin.length / 4) * 4 }],
  };
  const padded = new Uint8Array(Math.ceil(bin.length / 4) * 4);
  padded.set(bin);
  return packGlb(JSON.stringify(json), padded);
}

describe('model meshes as vertex paint names and checks them', () => {
  it('the page names each mesh and hashes its positions as the backend does', async () => {
    const bytes = glb();
    const read = readModelGeometry(bytes);
    if (!read.ok) throw new Error(read.message);
    const backend = new Map(paintableMeshes(read.geometry).map((m) => [m.mesh, { vertices: m.vertices, positions: m.positions }]));
    expect([...backend.keys()].sort()).toEqual(['Body/Hull#0', 'Body/Hull#1', 'Body/Hull~1#0', 'Body/node3#0', 'Rock#0']);

    const port = createGltfLoaderPort();
    const loaded = await port.load(bytes, { signal: new AbortController().signal, descriptor: descriptorFor(bytes) });
    const page = new Map<string, { vertices: number; positions: string | null }>();
    loaded.root.traverse((o) => {
      const key = o.userData[PAINT_MESH_KEY] as string | undefined;
      if ((o as THREE.Mesh).isMesh !== true || key === undefined) return;
      const g = (o as THREE.Mesh).geometry;
      page.set(key, { vertices: g.getAttribute('position').count, positions: geometryPaintHash(g) });
    });
    expect(Object.fromEntries(page)).toEqual(Object.fromEntries(backend));
    // A copy of the model keeps the names (what every placement draws).
    const names: string[] = [];
    loaded.createInstance().traverse((o) => {
      if (o.userData[PAINT_MESH_KEY] !== undefined) names.push(o.userData[PAINT_MESH_KEY] as string);
    });
    expect(names.sort()).toEqual([...backend.keys()].sort());
    loaded.dispose();
  });
});
