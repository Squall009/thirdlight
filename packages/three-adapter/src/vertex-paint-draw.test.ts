/**
 * Vertex paint drawn: what reads the paint stream, and what a scene without
 * paint still builds — the WGSL three makes (no GPU: the WebGPU backend's
 * node builder runs in Node over a stand-in canvas).
 *
 * The digests below were recorded before paint was drawn: every shader type
 * and plain graph, alone and drawn through instance-matrix columns (an
 * automatic batch, an instance set's chunk), and graphs that read COLOR_0
 * and blend layers by height. A scene without paint keeps these programs. A
 * change of three.js changes the text: re-record them then (the failure
 * prints the new ones).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { INSTANCE_FLOATS } from '@thirdlight/runtime';

import { createAttributeInstancedMesh } from './attribute-instancing';
import { BATCH_KEY, createAutoBatcher } from './batching';
import { buildInstanceSet } from './instancing';
import { digestOf, type MaterialGraphLike } from './material-graph';
import { createMaterialLibrary, type MaterialDefLike } from './material-library';
import { STATIC_KEY } from './static-merge';
import { graphDef, litScene, PLAIN_GRAPHS, settle, SHADER_TYPE_MATERIALS, testTexture, wgslOf, wgslRenderer } from './test-wgsl';
import { paintedGeometry, paintStream, PAINT_MESH_KEY, PAINT_SLOT_ATTRIBUTE, PAINT_STREAM_KEY, type PaintStream } from './vertex-paint-draw';
import { ViewCuller } from './view-cull';
import type { ModelInstance } from './visual';

const n = (id: string, type: string, data?: Record<string, unknown>) => ({ id, type, position: [0, 0] as [number, number], ...(data !== undefined ? { data } : {}) });
const e = (id: string, from: string, fp: string, to: string, tp: string) => ({ id, from: { node: from, port: fp }, to: { node: to, port: tp } });

/** Graphs reading COLOR_0 and blending layers by height (unwired weights): what paint gives a meaning to on painted meshes. */
const COLOUR_GRAPHS: Readonly<Record<string, MaterialGraphLike>> = {
  vertexTint: { nodes: [n('out', 'pbr'), n('v', 'vertexColor')], edges: [e('a', 'v', 'rgb', 'out', 'baseColor')] },
  heightLayers: {
    nodes: [n('out', 'pbr'), n('h', 'heightBlend'), n('s', 'sampleTexture', { texture: 'tex' }), n('w', 'weightedMix')],
    edges: [e('a', 's', 'rgba', 'h', 'heights'), e('b', 'h', 'weights', 'w', 'weights'), e('c', 's', 'rgb', 'w', 'a'), e('d', 'w', 'out', 'out', 'baseColor')],
  },
};

const ALL_DEFS: readonly MaterialDefLike[] = [...SHADER_TYPE_MATERIALS, ...Object.entries({ ...PLAIN_GRAPHS, ...COLOUR_GRAPHS }).map(([id, g]) => graphDef(id, g))];

/** Every material on a sphere drawn alone and on one drawn through instance-matrix columns. */
async function scene(): Promise<{ scene: THREE.Scene; alone: Record<string, THREE.Mesh>; columns: Record<string, THREE.Mesh> }> {
  const tex = testTexture();
  const library = createMaterialLibrary({ loadTexture: async () => tex });
  library.setMaterials(ALL_DEFS);
  const s = litScene();
  const alone: Record<string, THREE.Mesh> = {};
  const columns: Record<string, THREE.Mesh> = {};
  const sphere = new THREE.SphereGeometry(1, 8, 6);
  for (const d of ALL_DEFS) {
    const m = new THREE.Mesh(sphere, new THREE.MeshStandardMaterial());
    s.add(m);
    library.apply(m, { '*': d.materialId });
    alone[d.materialId] = m;
  }
  await settle();
  for (const d of ALL_DEFS) {
    const inst = createAttributeInstancedMesh(sphere, alone[d.materialId]!.material as THREE.Material, 16);
    inst.count = 2;
    inst.markChanged();
    s.add(inst.mesh);
    columns[d.materialId] = inst.mesh;
  }
  return { scene: s, alone, columns };
}

/** The WGSL digests without paint, recorded before paint was drawn (three r186). */
const BEFORE: Readonly<Record<string, string>> = {
  blended: '4df9b83631a1f83c',
  'blended@columns': '26fe17611b75e43d',
  customLit: 'b565c0183be022b0',
  'customLit@columns': 'f1005d7f1eeae4e8',
  everySlot: '8d625f13e5af0475',
  'everySlot@columns': '27e3f3b10f31b74b',
  foliage: 'dfe914434fcf0d21',
  'foliage@columns': '2daf63ef303c9c5b',
  heightLayers: '478ffe725085fd6b',
  'heightLayers@columns': '8eb39048cf2d553b',
  kit: '83a0897a5b6be10d',
  'kit@columns': 'ee9277e6df1549d8',
  plain: 'c4870c84c910e8e4',
  'plain@columns': '7eeef0bdc3a69661',
  standard: '2cc544a08f2da47b',
  'standard@columns': '29e472b9b775397e',
  textured: '39c822174bd5badf',
  'textured@columns': 'bf50b0413bab20ec',
  tinted: '2a9c50218bd57d29',
  'tinted@columns': '08b843b05c8ac840',
  // The trim material as the layered surface it draws as (test-wgsl.ts).
  trim: '63a2a74010221a5a',
  'trim@columns': '52f2cc696d92c5ef',
  unlit: 'c2f4be09abc549e7',
  'unlit@columns': 'f911970bc22982aa',
  vertexTint: '206d520177dbc150',
  'vertexTint@columns': '11d474b2a0dfd5c1',
  water: '588fd2ffeda77232',
  'water@columns': 'cbad2dc5487a1ae0',
};

describe('a scene without paint keeps its programs', () => {
  it('every shader type and graph, alone and through instance columns, builds the WGSL it did', async () => {
    const { scene: s, alone, columns } = await scene();
    const renderer = wgslRenderer();
    const now: Record<string, string> = {};
    for (const [id, m] of Object.entries(alone)) now[id] = digestOf(wgslOf(renderer, s, m));
    for (const [id, m] of Object.entries(columns)) now[`${id}@columns`] = digestOf(wgslOf(renderer, s, m));
    expect(now).toEqual(BEFORE);
  });
});

const sphere = (): THREE.SphereGeometry => new THREE.SphereGeometry(1, 8, 6);
/** A paint of `g`'s vertices, every vertex `rgba`. */
const paintOf = (g: THREE.BufferGeometry, rgba: readonly number[]): Uint8Array => {
  const out = new Uint8Array(g.getAttribute('position').count * 4);
  for (let i = 0; i < out.length; i += 1) out[i] = rgba[i % 4]!;
  return out;
};

describe('what reads paint', () => {
  const READERS: readonly MaterialDefLike[] = [
    { materialId: 'tinted', name: 'tinted', shader: 'standard', params: { paintTint: true }, textures: {} },
    { materialId: 'trim', name: 'trim', shader: 'trim', params: {}, textures: {}, trim: { size: [256, 256], texelDensity: 256, padding: 8, rows: [{ slot: 'a', top: 8, bottom: 120 }] } },
    graphDef('graphPaint', { nodes: [n('out', 'pbr'), n('v', 'vertexColor', { set: 'paint' })], edges: [e('a', 'v', 'rgb', 'out', 'baseColor')] }),
    graphDef('heightLayers', COLOUR_GRAPHS['heightLayers']!),
  ];

  it('a painted mesh drawn alone reads its tlPaint attribute; drawn unpainted, the same material reads none', async () => {
    const library = createMaterialLibrary({ loadTexture: async () => testTexture() });
    library.setMaterials(READERS);
    const s = litScene();
    const renderer = wgslRenderer();
    const base = sphere();
    const painted = paintedGeometry(base, paintOf(base, [255, 0, 0, 255]));
    for (const d of READERS) {
      const plain = new THREE.Mesh(base, new THREE.MeshStandardMaterial());
      const withPaintMesh = new THREE.Mesh(painted, new THREE.MeshStandardMaterial());
      s.add(plain, withPaintMesh);
      library.apply(plain, { '*': d.materialId });
      library.apply(withPaintMesh, { '*': d.materialId });
      await settle();
      expect(wgslOf(renderer, s, withPaintMesh), d.materialId).toMatch(/tlPaint/);
      expect(wgslOf(renderer, s, plain), d.materialId).not.toMatch(/tlPaint|vertex_index/);
    }
  });

  it('a painted instanced draw reads its stream by slot and vertex index; an unpainted one reads nothing', async () => {
    const library = createMaterialLibrary({ loadTexture: async () => testTexture() });
    library.setMaterials(READERS);
    const s = litScene();
    const renderer = wgslRenderer();
    const holder = new THREE.Mesh(sphere(), new THREE.MeshStandardMaterial());
    library.apply(holder, { '*': 'graphPaint' });
    await settle();
    const painted = createAttributeInstancedMesh(sphere(), holder.material as THREE.Material, 16, { painted: true });
    const plain = createAttributeInstancedMesh(sphere(), holder.material as THREE.Material, 16);
    for (const i of [painted, plain]) {
      i.count = 2;
      i.markChanged();
      s.add(i.mesh);
    }
    const w = wgslOf(renderer, s, painted.mesh);
    expect(w).toMatch(/vertex_index/);
    expect(w).toMatch(/textureLoad/);
    expect(w).toMatch(/vTlPaintStream/);
    expect(wgslOf(renderer, s, plain.mesh)).not.toMatch(/vertex_index|vTlPaintStream/);
  });
});

describe('paint slots in the instance buffer', () => {
  it('ride with their instances when the view reorders them, in the matrix\'s unused fourth row', () => {
    const inst = createAttributeInstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 8, { painted: true });
    // Slots: far ahead, behind the camera, near ahead; the near one and the far one painted.
    const at = (x: number, z: number): THREE.Matrix4 => new THREE.Matrix4().makeTranslation(x, 0, z);
    [at(0, -50), at(0, 30), at(0, -5)].forEach((m, i) => m.toArray(inst.array, i * 16));
    inst.paintSlots!.set([2, 0, 1]);
    inst.count = 3;
    inst.markChanged();
    expect(inst.mesh.geometry.getAttribute(PAINT_SLOT_ATTRIBUTE)).toBeDefined();
    const drawn = (inst.mesh.geometry.getAttribute('tlInstanceMatrix0') as THREE.InterleavedBufferAttribute).data.array as Float32Array;
    expect([drawn[3], drawn[16 + 3], drawn[32 + 3]]).toEqual([2, 0, 1]);
    inst.mesh.updateMatrixWorld();
    const culler = new ViewCuller();
    culler.add(inst);
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    cam.updateMatrixWorld();
    culler.update(cam);
    // Nearest first (z −5, then −50), then the one behind: each slot's paint went with it.
    expect([drawn[14], drawn[16 + 14], drawn[32 + 14]]).toEqual([-5, -50, 30]);
    expect([drawn[3], drawn[16 + 3], drawn[32 + 3]]).toEqual([1, 2, 0]);
    // The matrices the page reads (picking, bounds) keep an affine fourth row.
    expect([inst.array[3], inst.array[16 + 3], inst.array[32 + 3]]).toEqual([0, 0, 0]);
  });

  it('an unpainted draw has no marker and its buffer is as before', () => {
    const inst = createAttributeInstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 4);
    expect(inst.paintSlots).toBeNull();
    expect(inst.mesh.geometry.getAttribute(PAINT_SLOT_ATTRIBUTE)).toBeUndefined();
    expect((inst.mesh.geometry.getAttribute('tlInstanceMatrix0') as THREE.InterleavedBufferAttribute).data.stride).toBe(16);
  });
});

describe('painted models in batches and merged cells', () => {
  const camera = (): THREE.PerspectiveCamera => {
    const c = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    c.updateMatrixWorld();
    return c;
  };

  it('copies of one mesh painted differently stay one batch: its stream holds their paint, each copy its slot', () => {
    const scene = new THREE.Scene();
    const base = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial();
    const red = paintOf(base, [255, 0, 0, 255]);
    const blue = paintOf(base, [0, 0, 255, 255]);
    const meshes = [red, null, blue, null].map((p, i) => {
      const m = new THREE.Mesh(p === null ? base : paintedGeometry(base, p), material);
      m.position.set(i * 3, 0, -10);
      m.userData[BATCH_KEY] = true;
      scene.add(m);
      return m;
    });
    const batcher = createAutoBatcher(scene, { merging: 'off' });
    for (const m of meshes) batcher.listed(m);
    batcher.update(camera());
    const batches = scene.children.filter((o) => o.name.startsWith('tl-batch:')) as THREE.Mesh[];
    expect(batches.length).toBe(1);
    const batch = batches[0]!;
    expect(batch.geometry.getAttribute(PAINT_SLOT_ATTRIBUTE)).toBeDefined();
    const stream = batch.userData[PAINT_STREAM_KEY] as PaintStream;
    expect([stream.vertices, stream.slots]).toEqual([24, 2]);
    const data = stream.texture.image.data as Uint8Array;
    expect([...data.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...data.subarray(24 * 4, 24 * 4 + 4)]).toEqual([0, 0, 255, 255]);
    const drawn = (batch.geometry.getAttribute('tlInstanceMatrix0') as THREE.InterleavedBufferAttribute).data.array as Float32Array;
    // Members in slot order: red, plain, blue, plain.
    expect([0, 1, 2, 3].map((k) => drawn[k * 16 + 3])).toEqual([1, 0, 2, 0]);
    expect(batcher.diagnostics().groups).toBe(1);
    // Unpainted again: the batch is made plain (its program), the stream let go.
    meshes[0]!.geometry = base;
    meshes[2]!.geometry = base;
    batcher.touch(meshes[0]!);
    batcher.touch(meshes[2]!);
    batcher.update(camera());
    const after = scene.children.filter((o) => o.name.startsWith('tl-batch:')) as THREE.Mesh[];
    expect(after.length).toBe(1);
    expect(after[0]!.geometry.getAttribute(PAINT_SLOT_ATTRIBUTE)).toBeUndefined();
    expect(after[0]!.userData[PAINT_STREAM_KEY]).toBeUndefined();
  });

  it('a static cell copies its painted members\' paint into its vertices, its unpainted members\' 0', () => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial();
    const a = new THREE.BoxGeometry();
    const b = new THREE.BoxGeometry(2, 1, 1);
    const painted = new THREE.Mesh(paintedGeometry(a, paintOf(a, [10, 20, 30, 40])), material);
    const plain = new THREE.Mesh(b, material);
    for (const m of [painted, plain]) {
      m.userData[BATCH_KEY] = true;
      m.userData[STATIC_KEY] = 'scene';
      scene.add(m);
    }
    plain.position.x = 3;
    const batcher = createAutoBatcher(scene, { merging: 'load' });
    batcher.listed(painted);
    batcher.listed(plain);
    batcher.update(camera());
    const cells = scene.children.filter((o) => o.name.startsWith('tl-merged:')) as THREE.Mesh[];
    expect(cells.length).toBe(1);
    const paint = cells[0]!.geometry.getAttribute('tlPaint') as THREE.BufferAttribute;
    expect(paint.normalized).toBe(true);
    const bytes = paint.array as Uint8Array;
    expect(bytes.length).toBe(48 * 4);
    const slots = [bytes.subarray(0, 24 * 4), bytes.subarray(24 * 4)];
    // One member's run is the paint, the other's zero (the order is the cell's).
    const runs = slots.map((r) => [...r.subarray(0, 4)].join(','));
    expect(runs.sort()).toEqual(['0,0,0,0', '10,20,30,40']);
  });

  it('a static cell of unpainted members has no paint attribute', () => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshStandardMaterial();
    const meshes = [new THREE.BoxGeometry(), new THREE.BoxGeometry(2, 1, 1)].map((g, i) => {
      const m = new THREE.Mesh(g, material);
      m.position.x = i * 3;
      m.userData[BATCH_KEY] = true;
      m.userData[STATIC_KEY] = 'scene';
      scene.add(m);
      return m;
    });
    const batcher = createAutoBatcher(scene, { merging: 'load' });
    for (const m of meshes) batcher.listed(m);
    batcher.update(camera());
    const cells = scene.children.filter((o) => o.name.startsWith('tl-merged:')) as THREE.Mesh[];
    expect(cells.length).toBe(1);
    expect(cells[0]!.geometry.getAttribute('tlPaint')).toBeUndefined();
  });
});

describe('painted instance copies', () => {
  it('each chunk draw of a painted mesh reads its pool by copy slot; chunks without a painted copy stay plain', () => {
    const root = new THREE.Group();
    const geometry = new THREE.BoxGeometry();
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.userData[PAINT_MESH_KEY] = 'Box#0';
    root.add(mesh);
    const template = { glbRoot: root, root } as unknown as ModelInstance;
    // 2 copies far apart (two chunks), only the second painted, in pool slot 3.
    const floats = new Float32Array(2 * INSTANCE_FLOATS);
    for (const [i, x] of [[0, 0], [1, 5000]] as const) {
      floats[i * INSTANCE_FLOATS] = x;
      floats.set([0, 0, 0, 1, 1, 1, 1], i * INSTANCE_FLOATS + 3);
    }
    const stream = paintStream(new Uint8Array(4 * 24 * 4), 24, 4)!;
    const set = buildInstanceSet(template, floats, 2, 'test', { chunkSize: 64, paint: { slotOf: (c) => (c === 1 ? 3 : -1), stream: (k) => (k === 'Box#0' ? stream : undefined) } });
    expect(set.chunks).toBe(2);
    const painted = set.meshes.filter((m) => m.geometry.getAttribute(PAINT_SLOT_ATTRIBUTE) !== undefined);
    expect(painted.length).toBe(1);
    expect(painted[0]!.userData[PAINT_STREAM_KEY]).toBe(stream);
    const drawn = (painted[0]!.geometry.getAttribute('tlInstanceMatrix0') as THREE.InterleavedBufferAttribute).data.array as Float32Array;
    expect(drawn[3]).toBe(4);
    set.dispose();
    stream.dispose();
  });

  it('a stream past the largest texture is not made (the draw goes unpainted)', () => {
    expect(paintStream(new Uint8Array(4), 1, 1)).not.toBeNull();
    expect(paintStream(new Uint8Array(0), 1_000_000, 100)).toBeNull();
  });
});
