/**
 * Phase 18.0/18.1: the editor's material-graph code (the editor may import
 * project-model types only) against project-model:
 *
 * - data-dependent ports: the editor's `resolvePorts` equals project-model's
 *   `resolveGraphPorts` (auto widths, swizzle masks, parameter types,
 *   sub-graph calls) and its connection check agrees with the validator;
 * - the port contexts (functions, parameters) resolve the same;
 * - "New graph material" and "Convert to graph" produce graphs the backend
 *   accepts (every shader value and texture slot of the standard and unlit
 *   shaders wired in).
 */
import { describe, expect, it } from 'vitest';

import { canonicalMaterials, graphDocumentsContext, GRAPH_KINDS, materialGraphContext, MATERIAL_GRAPH_KIND, resolveGraphPorts, validateMaterials, type GraphData, type GraphDocument, type MaterialDef, type MaterialParameter, type ModelErrorV2 } from '../packages/project-model/src/index';
import * as editor from '../packages/editor/src/graph/model';
import { convertToGraph, graphsPortContext, materialPortContext, newMaterialGraph } from '../packages/editor/src/session/material-graph';

const FUNCTIONS: GraphDocument[] = [
  {
    graphId: 'scale-color',
    kind: 'material-function',
    name: 'Scale colour',
    graph: {
      nodes: [
        { id: 'inAmount', type: 'functionInput', position: [0, 100], data: { name: 'amount' } },
        { id: 'inColor', type: 'functionInput', position: [0, 0], data: { name: 'color', type: 'vec3' } },
        { id: 'inTex', type: 'functionInput', position: [0, 200], data: { name: 'map', type: 'texture' } },
        { id: 'result', type: 'functionOutput', position: [400, 0], data: { name: 'result', type: 'vec3' } },
      ],
      edges: [],
    },
  },
];
const PARAMS: MaterialParameter[] = [
  { key: 'tint', type: 'color', default: '#ffffff' },
  { key: 'albedo', type: 'texture', default: '' },
  { key: 'offset', type: 'vec2', default: [0, 0] },
];
const GRAPH: GraphData = {
  nodes: [
    { id: 'out', type: 'pbr', position: [600, 0] },
    { id: 'c', type: 'color', position: [0, 0] },
    { id: 'f', type: 'float', position: [0, 100] },
    { id: 'm', type: 'multiply', position: [200, 0] },
    { id: 'n', type: 'lerp', position: [400, 0] },
    { id: 'fixed', type: 'add', position: [200, 200], data: { type: 'vec4' } },
    { id: 'sw', type: 'swizzle', position: [200, 300], data: { mask: 'x' } },
    { id: 'p', type: 'parameter', position: [0, 300], data: { key: 'tint' } },
    { id: 'q', type: 'parameter', position: [0, 400], data: { key: 'albedo' } },
    { id: 'r', type: 'parameter', position: [0, 500], data: { key: 'offset' } },
    { id: 'call', type: 'call', position: [300, 400], data: { function: 'scale-color' } },
    { id: 'ghost', type: 'call', position: [300, 600], data: { function: 'nope' } },
  ],
  edges: [
    { id: 'e1', from: { node: 'c', port: 'rgb' }, to: { node: 'm', port: 'a' } },
    { id: 'e2', from: { node: 'f', port: 'value' }, to: { node: 'm', port: 'b' } },
    { id: 'e3', from: { node: 'm', port: 'out' }, to: { node: 'n', port: 'a' } },
    { id: 'e4', from: { node: 'r', port: 'value' }, to: { node: 'n', port: 't' } },
    { id: 'e5', from: { node: 'n', port: 'out' }, to: { node: 'out', port: 'baseColor' } },
    { id: 'e6', from: { node: 'q', port: 'value' }, to: { node: 'call', port: 'inTex' } },
  ],
};

describe('material graphs: editor vs project-model', () => {
  it('resolves every node\'s ports the same (auto widths, masks, parameters, calls)', () => {
    const backend = resolveGraphPorts(MATERIAL_GRAPH_KIND, GRAPH, materialGraphContext(PARAMS, graphDocumentsContext(GRAPH_KINDS, FUNCTIONS)));
    const ed = editor.resolvePorts(MATERIAL_GRAPH_KIND, GRAPH, materialPortContext(PARAMS, FUNCTIONS, GRAPH_KINDS));
    expect([...ed.keys()].sort()).toEqual([...backend.keys()].sort());
    for (const [id, ports] of backend) expect(ed.get(id), id).toEqual(ports);
    // Spot checks: a vec3 wire widens the multiply and the lerp; a call has its function's ports.
    expect(ed.get('n')!.outputs[0]!.type).toBe('vec3');
    expect(ed.get('sw')!.outputs[0]!.type).toBe('float');
    expect(ed.get('call')!.inputs.map((p) => p.id)).toEqual(['inColor', 'inAmount', 'inTex']);
    expect(ed.get('ghost')!.inputs).toEqual([]);
    // The function context alone (a function graph calling another) resolves the same too.
    const g2: GraphData = { nodes: [{ id: 'call', type: 'call', position: [0, 0], data: { function: 'scale-color' } }], edges: [] };
    expect(editor.resolvePorts(GRAPH_KINDS['material-function']!, g2, graphsPortContext(FUNCTIONS, GRAPH_KINDS))).toEqual(resolveGraphPorts(GRAPH_KINDS['material-function']!, g2, graphDocumentsContext(GRAPH_KINDS, FUNCTIONS)));
  });

  it('the editor\'s connection check agrees with the validator', () => {
    const ctx = materialPortContext(PARAMS, FUNCTIONS, GRAPH_KINDS);
    const base: GraphData = { nodes: GRAPH.nodes.filter((n) => n.id !== 'ghost'), edges: GRAPH.edges };
    const portsOf = editor.portsResolver(MATERIAL_GRAPH_KIND, base, ctx);
    const cases: [editor.PortEnd, editor.PortEnd][] = [
      [{ node: 'f', port: 'value', side: 'out' }, { node: 'call', port: 'inTex', side: 'in' }], // value → texture: refused
      [{ node: 'q', port: 'value', side: 'out' }, { node: 'fixed', port: 'a', side: 'in' }], // texture → value: refused
      [{ node: 'c', port: 'rgb', side: 'out' }, { node: 'call', port: 'inColor', side: 'in' }], // fine
      [{ node: 'sw', port: 'out', side: 'out' }, { node: 'fixed', port: 'b', side: 'in' }], // float → vec4: a conversion
      [{ node: 'out', port: 'baseColor', side: 'in' }, { node: 'm', port: 'a', side: 'in' }], // two inputs
    ];
    for (const [a, b] of cases) {
      const plan = editor.planConnection(MATERIAL_GRAPH_KIND, base, a, b, portsOf);
      let accepted = false;
      if (plan.ok) {
        const g: GraphData = { nodes: base.nodes, edges: [...base.edges.filter((e) => !plan.replaces.includes(e.id)), { id: 'new', from: plan.from, to: plan.to }] };
        const errors: ModelErrorV2[] = [];
        validateMaterials([{ materialId: 'mat-a', name: 'A', shader: 'standard', params: {}, textures: {}, parameters: PARAMS, graph: g }], '', errors, graphDocumentsContext(GRAPH_KINDS, FUNCTIONS));
        accepted = errors.length === 0;
        expect(accepted, `${a.node}.${a.port} → ${b.node}.${b.port}: ${JSON.stringify(errors[0])}`).toBe(true);
      }
      const expected = !(a.side === b.side || (a.node === 'f' && b.port === 'inTex') || (a.node === 'q' && b.node === 'fixed'));
      expect(plan.ok, `${a.node}.${a.port} → ${b.node}.${b.port}`).toBe(expected);
    }
  });

  it('a new graph material and converted materials of every shader type validate in the backend', () => {
    const check = (m: MaterialDef): ModelErrorV2[] => {
      const errors: ModelErrorV2[] = [];
      validateMaterials([m], '', errors);
      return errors;
    };
    expect(check({ materialId: 'mat-n', name: 'N', shader: 'standard', params: {}, textures: {}, graph: newMaterialGraph() })).toEqual([]);
    const standard: MaterialDef = {
      materialId: 'mat-s',
      name: 'S',
      shader: 'standard',
      params: { color: '#336699', roughness: 0.4, metalness: 0.7, emissive: '#ff0000', emissiveIntensity: 2, alphaMode: 'cutout', alphaCutoff: 0.3, opacity: 0.9, doubleSided: true, tiling: [2, 3], offset: [0.5, 0], normalScale: 1.5, aoIntensity: 0.5 },
      textures: { map: 'tex-a', normalMap: 'tex-n', ormMap: 'tex-o', emissiveMap: 'tex-e' },
    };
    const unlit: MaterialDef = { materialId: 'mat-u', name: 'U', shader: 'unlit', params: { color: '#ffcc00', alphaMode: 'blend', opacity: 0.5, vertexTint: true }, textures: { map: 'tex-a' } };
    const plain: MaterialDef = { materialId: 'mat-p', name: 'P', shader: 'standard', params: {}, textures: {} };
    for (const m of [standard, unlit, plain]) {
      const r = convertToGraph(m);
      expect(r.ok, m.materialId).toBe(true);
      if (!r.ok) continue;
      expect(check(r.material), m.materialId).toEqual([]);
      // The shader part stays (the fallback render until 18.3); canonical form is stable.
      expect(r.material.shader).toBe(m.shader);
      expect(canonicalMaterials(canonicalMaterials([r.material]))).toEqual(canonicalMaterials([r.material]));
    }
    const s = convertToGraph(standard);
    if (s.ok) {
      const types = s.material.graph!.nodes.map((n) => n.type);
      for (const t of ['pbr', 'sampleTexture', 'normalMap', 'lerp', 'uv']) expect(types, t).toContain(t);
      const into = (port: string): boolean => s.material.graph!.edges.some((e) => e.to.node === 'output' && e.to.port === port);
      for (const port of ['baseColor', 'roughness', 'metalness', 'normal', 'emissive', 'ao', 'opacity', 'alphaClip']) expect(into(port), port).toBe(true);
      expect(s.material.graph!.nodes.find((n) => n.id === 'output')!.data).toEqual({ doubleSided: true });
    }
    // Phase 18.2: every shader type converts (the built-in templates), with and without textures, and validates.
    const textures = { map: 'tex-a', normalMap: 'tex-n', ormMap: 'tex-o', emissiveMap: 'tex-e' };
    const variants: MaterialDef[] = [
      { ...plain, materialId: 'mat-f', shader: 'foliage', params: { windBend: 2, subsurface: 0.5, color: '#44aa33' }, textures },
      { ...plain, materialId: 'mat-f0', shader: 'foliage' },
      { ...plain, materialId: 'mat-k', shader: 'kit', params: { uvPeriod: 2, macroNormalScale: 1.5, tiling: [2, 1] }, textures: { ...textures, macroNormalMap: 'tex-m' } },
      { ...plain, materialId: 'mat-k0', shader: 'kit', textures: { map: 'tex-a' } },
      { ...plain, materialId: 'mat-w', shader: 'water', params: { flow: [0.1, 0], waveScale: 3, fresnel: 2, doubleSided: true }, textures: { normalMap: 'tex-n' } },
      { ...plain, materialId: 'mat-w0', shader: 'water' },
    ];
    for (const m of variants) {
      const r = convertToGraph(m);
      expect(r.ok, m.materialId).toBe(true);
      if (!r.ok) continue;
      expect(check(r.material), `${m.materialId}: ${JSON.stringify(check(r.material)[0])}`).toEqual([]);
      expect(r.material.shader).toBe(m.shader);
    }
    const f = convertToGraph(variants[0]!);
    if (f.ok) {
      // Wind values are public parameters; the wind is a world-space vertex offset reading COLOR_0 as data.
      expect(f.material.parameters!.map((x) => x.key)).toEqual(['subsurface', 'windBend', 'flutterFrequency', 'windFlutter']);
      expect(f.material.parameters!.find((x) => x.key === 'windBend')!.default).toBe(2);
      expect(f.material.graph!.nodes.find((n) => n.type === 'vertexOffset')!.data).toEqual({ space: 'world' });
      expect(f.material.graph!.nodes.find((n) => n.type === 'vertexColor')!.data).toEqual({ absent: 'zero' });
      expect(f.material.graph!.nodes.find((n) => n.id === 'output')!.data).toEqual({ doubleSided: true });
    }
    const k = convertToGraph(variants[2]!);
    if (k.ok) expect(k.material.graph!.nodes.some((n) => n.type === 'objectPosition')).toBe(true);
    const w = convertToGraph(variants[4]!);
    if (w.ok) expect(w.material.graph!.nodes.find((n) => n.id === 'output')!.data).toEqual({ doubleSided: true, transparent: true });
    // A material that already declares a template's key keeps it; the template uses a constant there.
    const clash = convertToGraph({ ...variants[1]!, parameters: [{ key: 'windBend', type: 'color', default: '#ffffff' }] });
    expect(clash.ok && check(clash.material)).toEqual([]);
  });
});
