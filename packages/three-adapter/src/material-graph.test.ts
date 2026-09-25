/**
 * Phase 18.3: the material-graph compiler (no GPU: it builds TSL node trees;
 * the pixels are checked by the material-graph e2e and the shader-parity
 * harness on WebGL 2 and WebGPU).
 */
import * as THREE from 'three';
import * as TSL from 'three/tsl';
import { describe, expect, it } from 'vitest';

import { COMPILER_NODES, compileMaterialGraph, digestOf, materialGraphCanonical, materialGraphProblems, OVERRIDES_KEY, resolveMaterialGraphPorts, type GraphCompileEnv, type MaterialFunctionLike, type MaterialGraphLike } from './material-graph';
import { createMaterialLibrary, MATERIAL_NO_SHADOW_KEY, type MaterialDefLike } from './material-library';

const tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
const env = (fns: MaterialFunctionLike[] = [], extra: Partial<GraphCompileEnv> = {}): GraphCompileEnv => ({
  globals: { time: TSL.uniform(0), windDir: TSL.uniform(new THREE.Vector2(1, 0)), strength: TSL.uniform(1), gust: TSL.uniform(0), gustFreq: TSL.uniform(0), turb: TSL.uniform(0) },
  texture: (id) => (id === 'tex' ? tex : id === 'later' ? 'loading' : null),
  fn: (id) => fns.find((f) => f.graphId === id) ?? null,
  ...extra,
});
const isNode = (n: unknown): boolean => (n as { isNode?: boolean } | null)?.isNode === true;

/** Node types that are outputs, interfaces or need a declaration (tested on their own). */
const SPECIAL = new Set(['pbr', 'unlit', 'vertexOffset', 'functionInput', 'functionOutput', 'call', 'parameter']);
const SAMPLING = new Set(['sampleTexture', 'normalMap', 'triplanar']);

describe('material graph compiler: every node kind', () => {
  for (const type of Object.keys(COMPILER_NODES).filter((t) => !SPECIAL.has(t))) {
    it(`${type} compiles in the fragment and the vertex stage`, () => {
      const spec = COMPILER_NODES[type]!;
      const out = spec.outputs[0]!;
      const graph: MaterialGraphLike = {
        nodes: [
          { id: 'out', type: 'pbr', position: [400, 0] },
          { id: 'vo', type: 'vertexOffset', position: [400, 200] },
          { id: 'x', type, position: [0, 0], ...(SAMPLING.has(type) ? { data: { texture: 'tex' } } : {}) },
        ],
        edges: [
          { id: 'e1', from: { node: 'x', port: out.id }, to: { node: 'out', port: 'emissive' } },
          { id: 'e2', from: { node: 'x', port: out.id }, to: { node: 'vo', port: 'offset' } },
        ],
      };
      const c = compileMaterialGraph({ graph }, env());
      const errors = c.problems.filter((p) => p.severity === 'error');
      expect(errors, JSON.stringify(errors)).toEqual([]);
      expect(c.surface).toBe('pbr');
      expect(isNode(c.slots.emissive)).toBe(true);
      expect(isNode(c.slots.position)).toBe(true);
      expect(isNode(c.slots.color)).toBe(true);
      expect(c.slots.normal).toBeNull();
      // Pixel-only inputs say so in a vertex offset (a warning, with a stand-in value).
      if (['screenUV', 'dither', 'parallax'].includes(type)) expect(c.problems.some((p) => p.nodeId === 'x' && p.severity === 'warning')).toBe(true);
      if (SAMPLING.has(type)) expect(c.textures).toEqual(['tex']);
    });
  }

  it('fills the PBR slots only from what is wired (unwired: three defaults)', () => {
    const c = compileMaterialGraph({ graph: { nodes: [{ id: 'out', type: 'pbr', position: [0, 0], data: { doubleSided: true, transparent: true, castShadows: false } }], edges: [] } }, env());
    expect(isNode(c.slots.color)).toBe(true);
    expect(isNode(c.slots.roughness)).toBe(true);
    expect(isNode(c.slots.metalness)).toBe(true);
    for (const k of ['normal', 'emissive', 'ao', 'opacity', 'alphaTest', 'position'] as const) expect(c.slots[k], k).toBeNull();
    expect(c.flags).toEqual({ doubleSided: true, transparent: true, castShadows: false });
    expect(c.animated).toBe(false);
  });

  it('an unlit output fills colour, opacity and alpha clip only', () => {
    const c = compileMaterialGraph(
      {
        graph: {
          nodes: [
            { id: 'out', type: 'unlit', position: [0, 0] },
            { id: 'a', type: 'float', position: [-200, 0], data: { value: 0.3 } },
          ],
          edges: [{ id: 'e', from: { node: 'a', port: 'value' }, to: { node: 'out', port: 'alphaClip' } }],
        },
      },
      env(),
    );
    expect(c.surface).toBe('unlit');
    expect(c.slots.metalness).toBeNull();
    expect(isNode(c.slots.alphaTest)).toBe(true);
  });

  it('no surface output is a warning (a plain surface)', () => {
    const c = compileMaterialGraph({ graph: { nodes: [], edges: [] } }, env());
    expect(c.surface).toBeNull();
    expect(c.problems.some((p) => p.severity === 'warning' && p.nodeId === undefined)).toBe(true);
  });

  it('time and wind make the material animated', () => {
    for (const type of ['time', 'wind']) {
      const c = compileMaterialGraph({ graph: { nodes: [{ id: 'out', type: 'pbr', position: [0, 0] }, { id: 't', type, position: [0, 0] }], edges: [{ id: 'e', from: { node: 't', port: COMPILER_NODES[type]!.outputs[0]!.id }, to: { node: 'out', port: 'roughness' } }] } }, env());
      expect(c.animated, type).toBe(true);
    }
  });

  it('reports missing textures, parameters and functions on their nodes', () => {
    const graph: MaterialGraphLike = {
      nodes: [
        { id: 'out', type: 'pbr', position: [0, 0] },
        { id: 's', type: 'sampleTexture', position: [0, 0], data: { texture: 'gone' } },
        { id: 'p', type: 'parameter', position: [0, 0], data: { key: 'nope' } },
        { id: 'c', type: 'call', position: [0, 0], data: { function: 'missing' } },
        { id: 'l', type: 'sampleTexture', position: [0, 0], data: { texture: 'later' } },
      ],
      edges: [
        { id: 'e1', from: { node: 's', port: 'rgb' }, to: { node: 'out', port: 'baseColor' } },
        { id: 'e2', from: { node: 'p', port: 'value' }, to: { node: 'out', port: 'roughness' } },
        { id: 'e4', from: { node: 'l', port: 'r' }, to: { node: 'out', port: 'metalness' } },
      ],
    };
    const c = compileMaterialGraph({ graph }, env());
    const at = (id: string): string[] => c.problems.filter((p) => p.nodeId === id).map((p) => p.message);
    expect(at('s').join()).toContain('"gone" is not available');
    expect(at('p').join()).toContain('no parameter "nope"');
    // An unwired call is never compiled (nothing reads it).
    expect(at('c')).toEqual([]);
    expect(c.pending).toEqual(['later']);
    // The editor's variant: known textures are fine, others are problems.
    const probs = materialGraphProblems({ graph }, [], new Set(['later']));
    expect(probs.some((p) => p.nodeId === 's')).toBe(true);
    expect(probs.some((p) => p.nodeId === 'l')).toBe(false);
  });
});

describe('material graph compiler: types', () => {
  it('resolves auto widths from the wires, swizzle widths and parameter types', () => {
    const graph: MaterialGraphLike = {
      nodes: [
        { id: 'c', type: 'color', position: [0, 0] },
        { id: 'f', type: 'float', position: [0, 0] },
        { id: 'm', type: 'multiply', position: [0, 0] },
        { id: 'n', type: 'add', position: [0, 0] },
        { id: 'fixed', type: 'add', position: [0, 0], data: { type: 'vec4' } },
        { id: 'sw', type: 'swizzle', position: [0, 0], data: { mask: 'xy' } },
        { id: 'p', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
      ],
      edges: [
        { id: 'e1', from: { node: 'c', port: 'rgb' }, to: { node: 'm', port: 'a' } },
        { id: 'e2', from: { node: 'f', port: 'value' }, to: { node: 'm', port: 'b' } },
      ],
    };
    const ports = resolveMaterialGraphPorts(graph, [{ key: 'tint', type: 'color', default: '#ffffff' }], () => null);
    expect(ports.get('m')!.outputs[0]!.t).toBe('vec3');
    expect(ports.get('n')!.outputs[0]!.t).toBe('float');
    expect(ports.get('fixed')!.inputs.map((p) => p.t)).toEqual(['vec4', 'vec4']);
    expect(ports.get('sw')!.outputs[0]!.t).toBe('vec2');
    expect(ports.get('p')!.outputs[0]!.t).toBe('vec3');
  });
});

describe('material graph compiler: functions and parameters', () => {
  const FN: MaterialFunctionLike = {
    graphId: 'brighten',
    kind: 'material-function',
    graph: {
      nodes: [
        { id: 'inC', type: 'functionInput', position: [0, 0], data: { name: 'color', type: 'vec3', default: [0.5, 0.5, 0.5, 0] } },
        { id: 'inK', type: 'functionInput', position: [0, 100], data: { name: 'k', type: 'float', default: [2, 0, 0, 0] } },
        { id: 'mul', type: 'multiply', position: [200, 0] },
        { id: 'res', type: 'functionOutput', position: [400, 0], data: { name: 'result', type: 'vec3' } },
      ],
      edges: [
        { id: 'a', from: { node: 'inC', port: 'value' }, to: { node: 'mul', port: 'a' } },
        { id: 'b', from: { node: 'inK', port: 'value' }, to: { node: 'mul', port: 'b' } },
        { id: 'c', from: { node: 'mul', port: 'out' }, to: { node: 'res', port: 'value' } },
      ],
    },
  };
  const GRAPH: MaterialGraphLike = {
    nodes: [
      { id: 'out', type: 'pbr', position: [0, 0] },
      { id: 'call', type: 'call', position: [0, 0], data: { function: 'brighten' } },
      { id: 'tint', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
    ],
    edges: [
      { id: 'e1', from: { node: 'tint', port: 'value' }, to: { node: 'call', port: 'inC' } },
      { id: 'e2', from: { node: 'call', port: 'res' }, to: { node: 'out', port: 'baseColor' } },
    ],
  };

  it('inlines a function call (its ports are the interface nodes)', () => {
    const c = compileMaterialGraph({ graph: GRAPH, parameters: [{ key: 'tint', type: 'color', default: '#ff0000' }] }, env([FN]));
    expect(c.problems).toEqual([]);
    expect(isNode(c.slots.color)).toBe(true);
    // The function body compiled once per call: 3 material nodes' worth + the body.
    expect(c.nodeCount).toBeGreaterThanOrEqual(4);
  });

  it('a public parameter reads an object\'s override per drawn object', () => {
    const c = compileMaterialGraph(
      {
        graph: { nodes: [{ id: 'out', type: 'pbr', position: [0, 0] }, { id: 'r', type: 'parameter', position: [0, 0], data: { key: 'rough' } }], edges: [{ id: 'e', from: { node: 'r', port: 'value' }, to: { node: 'out', port: 'roughness' } }] },
        parameters: [{ key: 'rough', type: 'float', default: 0.25 }],
      },
      env([], { overrideKey: 'digest-1' }),
    );
    const u = c.slots.roughness as { value: number; update: (frame: { object: THREE.Object3D | null }) => void };
    expect(u.value).toBe(0.25);
    const obj = new THREE.Mesh();
    obj.userData[OVERRIDES_KEY] = { 'digest-1': { rough: 0.9 } };
    u.update({ object: obj });
    expect(u.value).toBe(0.9);
    u.update({ object: new THREE.Mesh() });
    expect(u.value).toBe(0.25);
  });

  it('digests ignore positions but not data, wires, parameters or called functions', () => {
    const fn = (id: string): MaterialFunctionLike | null => (id === 'brighten' ? FN : null);
    const d = (g: MaterialGraphLike, p = [{ key: 'tint', type: 'color', default: '#ff0000' }], f = fn): string => digestOf(materialGraphCanonical({ graph: g, parameters: p }, f));
    const base = d(GRAPH);
    const moved = { ...GRAPH, nodes: GRAPH.nodes.map((n) => ({ ...n, position: [n.position![0]! + 50, 9] as [number, number] })) };
    expect(d(moved)).toBe(base);
    expect(d(GRAPH, [{ key: 'tint', type: 'color', default: '#00ff00' }])).not.toBe(base);
    expect(d({ ...GRAPH, edges: GRAPH.edges.slice(1) })).not.toBe(base);
    const changedFn: MaterialFunctionLike = { ...FN, graph: { ...FN.graph, nodes: FN.graph.nodes.map((n) => (n.id === 'inK' ? { ...n, data: { ...n.data, default: [3, 0, 0, 0] } } : n)) } };
    expect(d(GRAPH, undefined, (id) => (id === 'brighten' ? changedFn : null))).not.toBe(base);
  });
});

describe('material library: graph materials', () => {
  const graphDef = (materialId: string, graph: MaterialGraphLike, parameters: MaterialDefLike['parameters'] = []): MaterialDefLike => ({ materialId, name: materialId, shader: 'standard', params: {}, textures: {}, graph, parameters });
  const TINT: MaterialGraphLike = {
    nodes: [
      { id: 'out', type: 'pbr', position: [0, 0], data: { castShadows: false } },
      { id: 'p', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
      { id: 't', type: 'parameter', position: [0, 0], data: { key: 'map' } },
      { id: 's', type: 'sampleTexture', position: [0, 0] },
    ],
    edges: [
      { id: 'e', from: { node: 'p', port: 'value' }, to: { node: 'out', port: 'baseColor' } },
      { id: 'e2', from: { node: 't', port: 'value' }, to: { node: 's', port: 'tex' } },
      { id: 'e3', from: { node: 's', port: 'r' }, to: { node: 'out', port: 'roughness' } },
    ],
  };
  const PARAMS: MaterialDefLike['parameters'] = [
    { key: 'tint', type: 'color', default: '#ff0000' },
    { key: 'map', type: 'texture', default: 'a' },
  ];

  it('shares one compiled material per digest; value overrides stay on the object; a texture override is a variant', () => {
    const lib = createMaterialLibrary({ loadTexture: async () => new THREE.Texture() });
    lib.setMaterials([graphDef('g1', TINT, PARAMS), graphDef('g2', TINT, PARAMS)]);
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const b = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    const c = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    a.castShadow = true;
    const undoA = lib.apply(a, { '*': 'g1' }, { g1: { tint: '#00ff00' } });
    lib.apply(b, { '*': 'g2' });
    lib.apply(c, { '*': 'g1' }, { g1: { map: 'b' } });
    expect(a.material).toBe(b.material);
    expect((a.material as THREE.Material).type).toBe('MeshStandardNodeMaterial');
    // The value override is the object's (per-object uniform), not the material's.
    const values = a.userData[OVERRIDES_KEY] as Record<string, Record<string, unknown>>;
    expect(Object.values(values)).toEqual([{ tint: '#00ff00' }]);
    expect(b.userData[OVERRIDES_KEY]).toBeUndefined();
    // A texture override needs its own material.
    expect(c.material).not.toBe(a.material);
    // "Casts shadows" off: the mesh casts none while it wears the material, and gets its flag back after.
    expect(a.castShadow).toBe(false);
    expect(a.userData[MATERIAL_NO_SHADOW_KEY]).toBe(true);
    undoA();
    expect(a.castShadow).toBe(true);
    expect((a.material as THREE.Material).type).toBe('MeshStandardMaterial');
    expect(lib.graphProblems('g2')).toEqual([]);
    expect(lib.graphProblems('nope')).toBeNull();
  });

  it('recompiles when a texture arrives, and when the graph changes (not when a node moves)', async () => {
    const lib = createMaterialLibrary({ loadTexture: async () => new THREE.Texture() });
    const g = graphDef('g', TINT, PARAMS);
    lib.setMaterials([g]);
    const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    lib.apply(m, { '*': 'g' });
    const first = m.material as THREE.Material & { roughnessNode: unknown };
    const placeholder = first.roughnessNode;
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
    expect(m.material).toBe(first);
    expect(first.roughnessNode).not.toBe(placeholder);
    lib.setMaterials([graphDef('g', { ...TINT, nodes: TINT.nodes.map((n) => ({ ...n, position: [5, 5] as [number, number] })) }, PARAMS)]);
    expect(m.material).toBe(first);
    lib.setMaterials([graphDef('g', TINT, [{ key: 'tint', type: 'color', default: '#0000ff' }, PARAMS[1]!])]);
    expect(m.material).not.toBe(first);
  });
});
