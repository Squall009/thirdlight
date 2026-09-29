/**
 * Run-time material values in the renderer — no GPU here
 * (the per-object uniform and the per-object data texture are driven by hand
 * the way three drives them per drawn object; the pixels and the shared
 * program are checked by `tests/e2e/material-runtime.e2e.ts` on WebGL 2 and
 * WebGPU).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';

import { batchRefusal } from './batching';
import { compileMaterialGraph, MATERIAL_IDS_KEY, OVERRIDES_KEY, RUNTIME_VALUES_KEY, type GraphCompileEnv, type MaterialGraphLike } from './material-graph';
import { createMaterialLibrary, type MaterialDefLike } from './material-library';
import { RuntimeMaterialView } from './runtime-materials';

const env = (extra: Partial<GraphCompileEnv> = {}): GraphCompileEnv => ({
  globals: { time: TSL.uniform(0), windDir: TSL.uniform(new THREE.Vector2(1, 0)), strength: TSL.uniform(1), gust: TSL.uniform(0), gustFreq: TSL.uniform(0), turb: TSL.uniform(0) },
  texture: () => null,
  fn: () => null,
  ...extra,
});

/** An unlit overlay: colour = mix(tint, cell.rgb, cell.a) with the cell read at the UV. */
const OVERLAY: MaterialGraphLike = {
  nodes: [
    { id: 'out', type: 'unlit', position: [600, 0] },
    { id: 'tint', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
    { id: 'cells', type: 'parameter', position: [0, 100], data: { key: 'cells' } },
    { id: 'read', type: 'sampleData', position: [200, 100] },
    { id: 'mix', type: 'lerp', position: [400, 0] },
  ],
  edges: [
    { id: 'e1', from: { node: 'cells', port: 'value' }, to: { node: 'read', port: 'data' } },
    { id: 'e2', from: { node: 'tint', port: 'value' }, to: { node: 'mix', port: 'a' } },
    { id: 'e3', from: { node: 'read', port: 'rgb' }, to: { node: 'mix', port: 'b' } },
    { id: 'e4', from: { node: 'read', port: 'a' }, to: { node: 'mix', port: 't' } },
    { id: 'e5', from: { node: 'mix', port: 'out' }, to: { node: 'out', port: 'color' } },
  ],
};
const PARAMS: NonNullable<MaterialDefLike['parameters']> = [
  { key: 'tint', type: 'color', default: '#00ff00' },
  { key: 'cells', type: 'data', default: [0, 0, 0, 0], size: [4, 4] },
  { key: 'skin', type: 'texture', default: '' },
];
const def = (materialId: string): MaterialDefLike => ({ materialId, name: materialId, shader: 'standard', params: {}, textures: {}, graph: OVERLAY, parameters: PARAMS });

/** Every node under `root` (a TSL tree), once. */
function nodesOf(root: unknown): unknown[] {
  const out = new Set<unknown>();
  const walk = (n: unknown, depth: number): void => {
    if (n === null || typeof n !== 'object' || out.has(n) || depth > 60) return;
    if ((n as { isNode?: boolean }).isNode !== true) return;
    out.add(n);
    for (const v of Object.values(n as Record<string, unknown>)) {
      if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
      else walk(v, depth + 1);
    }
  };
  walk(root, 0);
  return [...out];
}

describe('the data parameter in the compiler', () => {
  it('Sample data loads a texel of the data parameter; a public one swaps in each drawn object\'s own grid', () => {
    const c = compileMaterialGraph({ graph: OVERLAY, parameters: PARAMS }, env({ overrideKey: 'dg' }));
    expect(c.problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(c.ownedTextures.length).toBe(1);
    const placeholder = c.ownedTextures[0] as THREE.DataTexture;
    expect([placeholder.image.width, placeholder.image.height]).toEqual([4, 4]);
    const tn = nodesOf(c.slots.color).find((n) => (n as { isTextureNode?: boolean }).isTextureNode === true) as { value: THREE.Texture; sampler: boolean; updateType: string; update: (f: unknown) => void };
    expect(tn).toBeDefined();
    // An exact texel load, updated per object.
    expect(tn.sampler).toBe(false);
    expect(tn.updateType).toBe('object');
    tn.updateType = 'none';
    expect(tn.updateType).toBe('object');
    const own = new THREE.DataTexture(new Uint8Array(64), 4, 4);
    const obj = new THREE.Mesh();
    obj.userData[MATERIAL_IDS_KEY] = { dg: 'overlay' };
    obj.userData[RUNTIME_VALUES_KEY] = { values: {}, data: { overlay: { cells: own } } };
    tn.update({ object: obj });
    expect(tn.value).toBe(own);
    tn.update({ object: new THREE.Mesh() });
    expect(tn.value).toBe(placeholder);
  });

  it('cell addressing compiles in both stages; an unwired Sample data warns and reads 0', () => {
    const graph: MaterialGraphLike = {
      nodes: [...OVERLAY.nodes.map((n) => (n.id === 'read' ? { ...n, data: { address: 'cell' } } : n)), { id: 'vo', type: 'vertexOffset', position: [600, 200] }, { id: 'lone', type: 'sampleData', position: [0, 300] }],
      edges: [...OVERLAY.edges, { id: 'e6', from: { node: 'read', port: 'rgb' }, to: { node: 'vo', port: 'offset' } }, { id: 'e7', from: { node: 'lone', port: 'a' }, to: { node: 'out', port: 'opacity' } }],
    };
    const c = compileMaterialGraph({ graph, parameters: PARAMS }, env());
    expect(c.problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(c.problems.some((p) => p.nodeId === 'lone' && /no data/.test(p.message))).toBe(true);
    expect(c.slots.position).not.toBeNull();
  });

  it('a public parameter reads a value a script set before the object\'s authored override', () => {
    const graph: MaterialGraphLike = { nodes: [{ id: 'out', type: 'pbr', position: [0, 0] }, { id: 'r', type: 'parameter', position: [0, 0], data: { key: 'rough' } }], edges: [{ id: 'e', from: { node: 'r', port: 'value' }, to: { node: 'out', port: 'roughness' } }] };
    const c = compileMaterialGraph({ graph, parameters: [{ key: 'rough', type: 'float', default: 0.25 }] }, env({ overrideKey: 'd1' }));
    const u = c.slots.roughness as { value: number; update: (frame: { object: THREE.Object3D | null }) => void };
    const obj = new THREE.Mesh();
    obj.userData[OVERRIDES_KEY] = { d1: { rough: 0.9 } };
    obj.userData[MATERIAL_IDS_KEY] = { d1: 'mat' };
    u.update({ object: obj });
    expect(u.value).toBe(0.9);
    obj.userData[RUNTIME_VALUES_KEY] = { values: { mat: { rough: 0.4 } }, data: {} };
    u.update({ object: obj });
    expect(u.value).toBe(0.4);
  });
});

describe('run-time values through the library and the view', () => {
  const setup = (): { lib: ReturnType<typeof createMaterialLibrary>; a: THREE.Mesh; b: THREE.Mesh; view: RuntimeMaterialView } => {
    const lib = createMaterialLibrary({ loadTexture: async () => new THREE.DataTexture(new Uint8Array(4), 1, 1) });
    lib.setMaterials([def('overlay')]);
    const a = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    const b = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    lib.apply(a, { '*': 'overlay' });
    lib.apply(b, { '*': 'overlay' });
    const view = new RuntimeMaterialView(lib, (id) => (id === 'a' ? [a] : id === 'b' ? [b] : []));
    return { lib, a, b, view };
  };

  it('a colour on one object stays on that object: the material stays shared, nothing recompiles', () => {
    const { lib, a, b, view } = setup();
    const shared = a.material;
    expect(b.material).toBe(shared);
    expect(lib.graphMaterialCount()).toBe(1);
    view.apply([{ op: 'set', entityId: 'a', materialId: 'overlay', key: 'tint', value: '#ff0000' }]);
    expect(a.material).toBe(shared);
    expect(b.material).toBe(shared);
    expect(lib.graphMaterialCount()).toBe(1);
    // Kept linear for the uniform; b carries nothing; a leaves automatic instancing.
    expect((a.userData[RUNTIME_VALUES_KEY] as { values: Record<string, Record<string, unknown>> }).values['overlay']!['tint']).toEqual([1, 0, 0]);
    expect(b.userData[RUNTIME_VALUES_KEY]).toBeUndefined();
    a.userData['__tlBatch'] = true;
    b.userData['__tlBatch'] = true;
    expect(batchRefusal(a)).toBe('run-time material parameters');
    expect(batchRefusal(b)).toBeNull();
    view.apply([{ op: 'clear', entityId: 'a', materialId: 'overlay', key: 'tint' }]);
    expect(a.userData[RUNTIME_VALUES_KEY]).toBeUndefined();
    expect(view.diagnostics()).toEqual({ objects: 0, dataTextures: 0 });
  });

  it('a data grid is the object\'s own texture, updated in place; a texture value chooses a variant', () => {
    const { lib, a, b, view } = setup();
    const bytes = new Uint8Array(64);
    bytes.set([255, 0, 0, 255], 0);
    view.apply([{ op: 'data', entityId: 'a', materialId: 'overlay', key: 'cells', size: [4, 4], bytes }]);
    const rt = a.userData[RUNTIME_VALUES_KEY] as { data: Record<string, Record<string, THREE.DataTexture>> };
    const tex = rt.data['overlay']!['cells']!;
    expect([...(tex.image.data as Uint8Array).slice(0, 4)]).toEqual([255, 0, 0, 255]);
    // Its version is past a fresh placeholder's, so the first swap always rebinds.
    expect(tex.version).toBeGreaterThan(1);
    const v = tex.version;
    const next = new Uint8Array(64);
    next.set([0, 0, 255, 255], 60);
    view.apply([{ op: 'data', entityId: 'a', materialId: 'overlay', key: 'cells', size: [4, 4], bytes: next }]);
    expect(rt.data['overlay']!['cells']).toBe(tex);
    expect(tex.version).toBe(v + 1);
    expect([...(tex.image.data as Uint8Array).slice(60, 64)]).toEqual([0, 0, 255, 255]);
    expect(a.material).toBe(b.material);
    expect(lib.graphMaterialCount()).toBe(1);
    // A texture parameter set at run time compiles a variant (as a texture override does); cleared, the shared one again.
    view.apply([{ op: 'set', entityId: 'b', materialId: 'overlay', key: 'skin', value: 'tex-a' }]);
    expect(b.material).not.toBe(a.material);
    view.apply([{ op: 'clear', entityId: 'b', materialId: 'overlay', key: 'skin' }]);
    expect(b.material).toBe(a.material);
    // Released with its object.
    let disposed = false;
    tex.addEventListener('dispose', () => (disposed = true));
    view.release('a');
    expect(disposed).toBe(true);
  });

  it('values that arrived before a model\'s meshes are put on them when it attaches', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => null });
    lib.setMaterials([def('overlay')]);
    const meshes: THREE.Mesh[] = [];
    const view = new RuntimeMaterialView(lib, () => meshes);
    view.apply([{ op: 'set', entityId: 'm', materialId: 'overlay', key: 'tint', value: '#0000ff' }]);
    const late = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    lib.apply(late, { '*': 'overlay' });
    meshes.push(late);
    view.reapply('m');
    expect((late.userData[RUNTIME_VALUES_KEY] as { values: Record<string, Record<string, unknown>> }).values['overlay']!['tint']).toEqual([0, 0, 1]);
    expect(Object.values(late.userData[MATERIAL_IDS_KEY] as Record<string, string>)).toEqual(['overlay']);
  });
});
