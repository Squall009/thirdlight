/**
 * Phase 18.0/18.1: graph materials — the node catalogue as data (typed ports,
 * implicit conversions, every input defaulted), the material rules
 * (catalogue, port types, cycles, the node budget, one surface output,
 * declared parameters), exposed parameters, canonical form, data-dependent
 * ports (auto widths, swizzle masks, parameter types), material functions
 * (sub-graph calls, call cycles, interface changes) and per-object overrides.
 */
import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { graphDocumentsContext, resolveGraphPorts, validateGraphDocuments, type GraphContext, type GraphData, type GraphDocument, type GraphNode } from './graph';
import { GRAPH_KINDS } from './graph-kinds';
import { MATERIAL_BUILTIN_SOURCES, MATERIAL_FUNCTION_GRAPH_KIND, MATERIAL_GRAPH_KIND, MATERIAL_VALUE_TYPES } from './material-graph-kinds';
import { canonicalMaterials, materialGraphContext, materialFunctionsForRuntime, materialOverrideErrors, materialsForRuntime, materialTextureRefs, validateMaterials, type MaterialDef, type MaterialParameter } from './materials';

const errorsOf = (f: (e: ModelErrorV2[]) => void): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  f(e);
  return e;
};
const OUT: GraphNode = { id: 'out', type: 'pbr', position: [400, 0] };
function mat(graph: GraphData, parameters?: MaterialParameter[]): MaterialDef {
  return { materialId: 'mat-a', name: 'A', shader: 'standard', params: {}, textures: {}, ...(parameters !== undefined ? { parameters } : {}), graph };
}
const check = (m: MaterialDef, graphs: GraphContext | undefined = undefined): ModelErrorV2[] => errorsOf((e) => validateMaterials([m], '', e, graphs));

describe('the material node catalogue (data)', () => {
  for (const kind of [MATERIAL_GRAPH_KIND, MATERIAL_FUNCTION_GRAPH_KIND]) {
    it(`${kind.kind}: every port has a known type, every input a default, every node a category`, () => {
      const types = new Set(kind.portTypes.map((t) => t.id));
      for (const d of kind.nodes) {
        expect(kind.categories, d.type).toContain(d.category);
        for (const p of [...d.inputs, ...d.outputs]) {
          expect(types.has(p.type), `${d.type}.${p.id}: ${p.type}`).toBe(true);
          if (p.typeFrom !== undefined) {
            const f = d.fields?.find((x) => x.key === p.typeFrom!.field);
            expect(f, `${d.type}.${p.id} typeFrom field`).toBeDefined();
          }
        }
        for (const p of d.inputs) {
          // "every output connected or defaulted": an unconnected input always has a value (a texture input falls back to the node's texture field).
          if (p.type === 'texture') continue;
          expect(p.default, `${d.type}.${p.id} has a default`).toBeDefined();
          if (typeof p.default === 'string') expect(MATERIAL_BUILTIN_SOURCES as readonly string[]).toContain(p.default);
        }
        // Field defaults are valid values of their fields.
        for (const f of d.fields ?? []) {
          if (f.type === 'enum') expect(f.options, `${d.type}.${f.key}`).toContain(f.default);
          if (f.type === 'number') expect(typeof f.default).toBe('number');
          if (f.type === 'vector') expect((f.default as number[]).length).toBe(f.size);
          if (f.type === 'color') expect(f.default).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
      expect(new Set(kind.nodes.map((d) => d.type)).size).toBe(kind.nodes.length);
    });
  }

  it('has the plan\'s generic nodes', () => {
    const types = new Set(MATERIAL_GRAPH_KIND.nodes.map((d) => d.type));
    const expected = [
      // inputs
      'float', 'vec2', 'vec3', 'vec4', 'color', 'parameter', 'time', 'uv', 'vertexColor', 'position', 'normal', 'viewDirection', 'cameraDistance', 'screenUV', 'instanceIndex', 'wind', 'objectPosition',
      // maths
      'add', 'subtract', 'multiply', 'divide', 'dot', 'cross', 'normalize', 'length', 'lerp', 'clamp', 'saturate', 'smoothstep', 'step', 'min', 'max', 'abs', 'floor', 'fract', 'sin', 'cos', 'power', 'remap', 'split', 'combine', 'swizzle', 'oneMinus',
      // textures
      'sampleTexture', 'normalMap', 'triplanar', 'flipbook', 'noise', 'gradient', 'colorRamp',
      // utility
      'fresnel', 'rim', 'posterize', 'dither', 'worldUV', 'parallax', 'displace', 'alphaClip',
      // outputs, sub-graphs
      'pbr', 'unlit', 'vertexOffset', 'call',
    ];
    for (const t of expected) expect(types.has(t), t).toBe(true);
    const pbr = MATERIAL_GRAPH_KIND.nodes.find((d) => d.type === 'pbr')!;
    expect(pbr.inputs.map((p) => p.id)).toEqual(['baseColor', 'metalness', 'roughness', 'normal', 'emissive', 'ao', 'opacity', 'alphaClip']);
    expect(pbr.fields!.map((f) => f.key)).toEqual(['doubleSided', 'transparent', 'castShadows']);
    // A function has interface nodes instead of parameters and outputs.
    const fn = new Set(MATERIAL_FUNCTION_GRAPH_KIND.nodes.map((d) => d.type));
    for (const t of ['functionInput', 'functionOutput', 'call', 'multiply']) expect(fn.has(t), t).toBe(true);
    for (const t of ['parameter', 'pbr', 'unlit', 'vertexOffset']) expect(fn.has(t), t).toBe(false);
    expect(GRAPH_KINDS['material']).toBe(MATERIAL_GRAPH_KIND);
    expect(GRAPH_KINDS['material-function']).toBe(MATERIAL_FUNCTION_GRAPH_KIND);
  });

  it('converts every value width to every other implicitly, never a texture', () => {
    const conv = MATERIAL_GRAPH_KIND.conversions;
    for (const a of MATERIAL_VALUE_TYPES) for (const b of MATERIAL_VALUE_TYPES) if (a !== b) expect(conv.some((c) => c.from === a && c.to === b), `${a} → ${b}`).toBe(true);
    expect(conv.some((c) => c.from === 'texture' || c.to === 'texture')).toBe(false);
    expect(conv.find((c) => c.from === 'float' && c.to === 'vec3')!.label).toMatch(/every component/);
    expect(conv.find((c) => c.from === 'vec2' && c.to === 'vec4')!.label).toMatch(/z = 0, w = 1/);
  });
});

describe('material graph validation', () => {
  it('accepts a new graph material (one PBR output) and texture × tint into base colour', () => {
    expect(check(mat({ nodes: [OUT], edges: [] }))).toEqual([]);
    const g: GraphData = {
      nodes: [OUT, { id: 'tex', type: 'sampleTexture', position: [0, 0] }, { id: 'tint', type: 'color', position: [0, 200], data: { color: '#ff8800' } }, { id: 'mul', type: 'multiply', position: [200, 0] }],
      edges: [
        { id: 'e1', from: { node: 'tex', port: 'rgb' }, to: { node: 'mul', port: 'a' } },
        { id: 'e2', from: { node: 'tint', port: 'rgb' }, to: { node: 'mul', port: 'b' } },
        { id: 'e3', from: { node: 'mul', port: 'out' }, to: { node: 'out', port: 'baseColor' } },
      ],
    };
    expect(check(mat(g))).toEqual([]);
  });

  it('refuses unknown node types, unknown fields and bad field values', () => {
    expect(check(mat({ nodes: [OUT, { id: 'x', type: 'teapot', position: [0, 0] }], edges: [] }))[0]!.code).toBe('reference_missing');
    expect(check(mat({ nodes: [OUT, { id: 'x', type: 'float', position: [0, 0], data: { colour: 1 } }], edges: [] }))[0]!.code).toBe('field_unexpected');
    expect(check(mat({ nodes: [OUT, { id: 'x', type: 'swizzle', position: [0, 0], data: { mask: 'xq' } }], edges: [] }))[0]!.code).toBe('field_value');
    expect(check(mat({ nodes: [OUT, { id: 'x', type: 'color', position: [0, 0], data: { color: 'red' } }], edges: [] }))[0]!.code).toBe('field_value');
  });

  it('refuses a wire between incompatible port types (a value into a texture input)', () => {
    const g: GraphData = { nodes: [OUT, { id: 'f', type: 'float', position: [0, 0] }, { id: 't', type: 'sampleTexture', position: [200, 0] }], edges: [{ id: 'e', from: { node: 'f', port: 'value' }, to: { node: 't', port: 'tex' } }] };
    const e = check(mat(g));
    expect(e[0]!.code).toBe('field_value');
    expect(e[0]!.message).toMatch(/float output cannot feed a texture input/);
  });

  it('refuses a cycle', () => {
    const g: GraphData = {
      nodes: [OUT, { id: 'a', type: 'add', position: [0, 0] }, { id: 'b', type: 'add', position: [200, 0] }],
      edges: [
        { id: 'e1', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'a' } },
        { id: 'e2', from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'a' } },
      ],
    };
    expect(check(mat(g)).some((e) => e.code === 'hierarchy_cycle')).toBe(true);
  });

  it('refuses more than 512 nodes', () => {
    const nodes: GraphNode[] = [OUT, ...Array.from({ length: 512 }, (_, i) => ({ id: `f${i}`, type: 'float', position: [0, i * 10] as [number, number] }))];
    expect(check(mat({ nodes, edges: [] })).some((e) => e.code === 'limits_exceeded')).toBe(true);
    expect(check(mat({ nodes: nodes.slice(0, 512), edges: [] }))).toEqual([]);
  });

  it('refuses two surface outputs and two vertex offsets', () => {
    expect(check(mat({ nodes: [OUT, { id: 'u', type: 'unlit', position: [0, 0] }], edges: [] }))[0]!.message).toMatch(/at most one of "PBR output", "Unlit output"/);
    expect(check(mat({ nodes: [{ id: 'u', type: 'unlit', position: [0, 0] }], edges: [] }))).toEqual([]);
    expect(check(mat({ nodes: [OUT, { id: 'v1', type: 'vertexOffset', position: [0, 0] }, { id: 'v2', type: 'vertexOffset', position: [0, 100] }], edges: [] }))[0]!.code).toBe('limits_exceeded');
  });

  it('a Parameter node names a declared parameter and takes its type', () => {
    const tint: MaterialParameter = { key: 'tint', type: 'color', default: '#ffffff' };
    const albedo: MaterialParameter = { key: 'albedo', type: 'texture', default: '' };
    const g: GraphData = {
      nodes: [OUT, { id: 'p', type: 'parameter', position: [0, 0], data: { key: 'tint' } }, { id: 'q', type: 'parameter', position: [0, 100], data: { key: 'albedo' } }, { id: 's', type: 'sampleTexture', position: [200, 100] }],
      edges: [
        { id: 'e1', from: { node: 'p', port: 'value' }, to: { node: 'out', port: 'baseColor' } },
        { id: 'e2', from: { node: 'q', port: 'value' }, to: { node: 's', port: 'tex' } },
      ],
    };
    expect(check(mat(g, [tint, albedo]))).toEqual([]);
    const ports = resolveGraphPorts(MATERIAL_GRAPH_KIND, g, materialGraphContext([tint, albedo], undefined));
    expect(ports.get('p')!.outputs[0]!.type).toBe('vec3');
    expect(ports.get('q')!.outputs[0]!.type).toBe('texture');
    // A float parameter cannot feed a texture input; an undeclared key is refused.
    expect(check(mat(g, [tint, { ...albedo, type: 'float', default: 0 }]))[0]!.message).toMatch(/cannot feed a texture input/);
    expect(check(mat(g, [albedo])).some((e) => e.code === 'reference_missing' && e.path.endsWith('/data/key'))).toBe(true);
  });

  it('auto widths follow the widest wire in; a fixed type field overrides; a swizzle has its mask\'s width', () => {
    const g: GraphData = {
      nodes: [OUT, { id: 'c', type: 'color', position: [0, 0] }, { id: 'f', type: 'float', position: [0, 100] }, { id: 'm', type: 'multiply', position: [200, 0] }, { id: 'n', type: 'multiply', position: [200, 100] }, { id: 'fixed', type: 'add', position: [200, 200], data: { type: 'vec2' } }, { id: 'sw', type: 'swizzle', position: [200, 300], data: { mask: 'xy' } }],
      edges: [
        { id: 'e1', from: { node: 'c', port: 'rgb' }, to: { node: 'm', port: 'a' } },
        { id: 'e2', from: { node: 'f', port: 'value' }, to: { node: 'm', port: 'b' } },
        { id: 'e3', from: { node: 'm', port: 'out' }, to: { node: 'n', port: 'a' } },
      ],
    };
    const ports = resolveGraphPorts(MATERIAL_GRAPH_KIND, g);
    expect(ports.get('m')!.outputs[0]!.type).toBe('vec3');
    expect(ports.get('m')!.inputs.map((p) => p.type)).toEqual(['vec3', 'vec3']);
    expect(ports.get('n')!.outputs[0]!.type).toBe('vec3'); // through another auto node
    expect(ports.get('fixed')!.outputs[0]!.type).toBe('vec2');
    expect(ports.get('sw')!.outputs[0]!.type).toBe('vec2');
    expect(resolveGraphPorts(MATERIAL_GRAPH_KIND, { nodes: [{ id: 'lone', type: 'add', position: [0, 0] }], edges: [] }).get('lone')!.outputs[0]!.type).toBe('float');
  });
});

describe('exposed parameters and the canonical form', () => {
  it('validates keys, types, defaults, ranges and visibility', () => {
    const bad = (p: unknown): string => {
      const e = check(mat({ nodes: [OUT], edges: [] }, [p as MaterialParameter]));
      return `${e[0]?.code} ${e[0]?.path}`;
    };
    expect(bad({ key: '1x', type: 'float', default: 0 })).toBe('field_value /0/parameters/0/key');
    expect(bad({ key: 'x', type: 'matrix', default: 0 })).toBe('field_value /0/parameters/0/type');
    expect(bad({ key: 'x', type: 'float', default: 5, min: 0, max: 1 })).toBe('field_value /0/parameters/0/default');
    expect(bad({ key: 'x', type: 'float', default: 0, min: 2, max: 1 })).toBe('field_value /0/parameters/0/max');
    expect(bad({ key: 'x', type: 'vec3', default: [0, 0] })).toBe('field_value /0/parameters/0/default');
    expect(bad({ key: 'x', type: 'color', default: '#FFF' })).toBe('field_value /0/parameters/0/default');
    expect(bad({ key: 'x', type: 'color', default: '#ffffff', min: 0 })).toBe('field_unexpected /0/parameters/0/min');
    expect(bad({ key: 'x', type: 'float', default: 0, visibility: 'secret' })).toBe('field_value /0/parameters/0/visibility');
    expect(bad({ key: 'x', type: 'float' })).toBe('field_missing /0/parameters/0/default');
    const dup = check(mat({ nodes: [OUT], edges: [] }, [{ key: 'x', type: 'float', default: 0 }, { key: 'x', type: 'float', default: 1 }]));
    expect(dup[0]!.code).toBe('id_duplicate');
  });

  it('keeps a shader material byte-identical and orders a graph material\'s new fields last', () => {
    const shader: MaterialDef = { materialId: 'mat-s', name: 'S', shader: 'standard', params: { roughness: 0.5 }, textures: {} };
    expect(JSON.stringify(canonicalMaterials([shader])[0])).toBe(JSON.stringify(shader));
    const g = mat(
      { nodes: [{ id: 'z', type: 'float', position: [0, 0], data: { value: 1 } }, OUT], edges: [], comments: [] },
      [
        { key: 'b', type: 'float', default: 1, visibility: 'public' },
        { key: 'a', type: 'color', default: '#AABBCC', visibility: 'private', tooltip: 'Tint' },
      ],
    );
    const c = canonicalMaterials([g])[0]!;
    expect(Object.keys(c)).toEqual(['materialId', 'name', 'shader', 'params', 'textures', 'parameters', 'graph']);
    // List order kept (it is the Inspector's order), public dropped, colour lower-cased; graph nodes sorted by id, empty lists dropped.
    expect(c.parameters).toEqual([{ key: 'b', type: 'float', default: 1 }, { key: 'a', type: 'color', default: '#aabbcc', visibility: 'private', tooltip: 'Tint' }]);
    expect(c.graph!.nodes.map((n) => n.id)).toEqual(['out', 'z']);
    expect(c.graph!.comments).toBeUndefined();
    expect(canonicalMaterials(canonicalMaterials([g]))).toEqual(canonicalMaterials([g]));
  });

  it('the runtime view keeps the graph (18.3 compiles it) and the parameters, without editor-only text', () => {
    const g = mat(
      { nodes: [{ ...OUT, collapsed: true }], edges: [], comments: [{ id: 'k', text: 'see https://example.invalid', position: [0, 0] }], groups: [{ id: 'g', title: 'Look', color: '#336699', rect: [0, 0, 10, 10] }] },
      [{ key: 'x', type: 'float', default: 0 }],
    );
    const [r] = materialsForRuntime([g]);
    expect(r!.parameters).toEqual([{ key: 'x', type: 'float', default: 0 }]);
    expect(r!.graph).toEqual({ nodes: [{ id: OUT.id, type: OUT.type, position: OUT.position }], edges: [] });
    expect(JSON.stringify(r)).not.toContain('example.invalid');
  });

  it('the runtime gets the material functions the graphs reach (through other functions too), and their textures count', () => {
    const call = (id: string, fn: string): GraphData['nodes'][number] => ({ id, type: 'call', position: [0, 0], data: { function: fn } });
    const graphs: GraphDocument[] = [
      { graphId: 'f-a', kind: 'material-function', name: 'A', graph: { nodes: [call('c', 'f-b')], edges: [], comments: [{ id: 'k', text: 'note', position: [0, 0] }] } },
      { graphId: 'f-b', kind: 'material-function', name: 'B', graph: { nodes: [{ id: 's', type: 'sampleTexture', position: [0, 0], data: { texture: 'tex-fn' } }], edges: [] } },
      { graphId: 'f-unused', kind: 'material-function', name: 'C', graph: { nodes: [], edges: [] } },
    ];
    const m = mat({ nodes: [OUT, call('c1', 'f-a'), { id: 's', type: 'sampleTexture', position: [0, 0], data: { texture: 'tex-graph' } }], edges: [] }, [{ key: 'map', type: 'texture', default: 'tex-param' }]);
    const fns = materialFunctionsForRuntime([m], graphs);
    expect(fns.map((f) => f.graphId)).toEqual(['f-a', 'f-b']);
    expect(fns[0]!.graph.comments).toBeUndefined();
    expect(materialTextureRefs(m)).toEqual(['tex-graph', 'tex-param']);
  });
});

describe('material functions (sub-graphs)', () => {
  const fnGraph: GraphData = {
    nodes: [
      { id: 'inColor', type: 'functionInput', position: [0, 0], data: { name: 'color', type: 'vec3' } },
      { id: 'inAmount', type: 'functionInput', position: [0, 100], data: { name: 'amount' } },
      { id: 'mul', type: 'multiply', position: [200, 0] },
      { id: 'result', type: 'functionOutput', position: [400, 0], data: { name: 'result', type: 'vec3' } },
    ],
    edges: [
      { id: 'e1', from: { node: 'inColor', port: 'value' }, to: { node: 'mul', port: 'a' } },
      { id: 'e2', from: { node: 'inAmount', port: 'value' }, to: { node: 'mul', port: 'b' } },
      { id: 'e3', from: { node: 'mul', port: 'out' }, to: { node: 'result', port: 'value' } },
    ],
  };
  const fn = (graph: GraphData = fnGraph, graphId = 'scale-color'): GraphDocument => ({ graphId, kind: 'material-function', name: 'Scale colour', graph });
  const caller: GraphData = {
    nodes: [OUT, { id: 'call', type: 'call', position: [200, 0], data: { function: 'scale-color' } }, { id: 'c', type: 'color', position: [0, 0] }],
    edges: [
      { id: 'w1', from: { node: 'c', port: 'rgb' }, to: { node: 'call', port: 'inColor' } },
      { id: 'w2', from: { node: 'call', port: 'result' }, to: { node: 'out', port: 'baseColor' } },
    ],
  };

  it('a call\'s ports are the function\'s inputs and outputs (ids = the interface nodes, ordered by position)', () => {
    const docs = [fn()];
    expect(errorsOf((e) => validateGraphDocuments(GRAPH_KINDS, docs, '', e))).toEqual([]);
    const ctx = graphDocumentsContext(GRAPH_KINDS, docs);
    expect(check(mat(caller), ctx)).toEqual([]);
    const ports = resolveGraphPorts(MATERIAL_GRAPH_KIND, caller, ctx).get('call')!;
    expect(ports.inputs.map((p) => `${p.id}:${p.label}:${p.type}`)).toEqual(['inColor:color:vec3', 'inAmount:amount:float']);
    expect(ports.outputs.map((p) => `${p.id}:${p.label}:${p.type}`)).toEqual(['result:result:vec3']);
  });

  it('refuses a call to a missing function and a wire to a port the function does not have', () => {
    expect(check(mat(caller), graphDocumentsContext(GRAPH_KINDS, [])).some((e) => e.code === 'reference_missing' && e.path.endsWith('/data/function'))).toBe(true);
    // The function lost its input "inColor": the caller's wire names no port.
    const without: GraphData = { nodes: fnGraph.nodes.filter((n) => n.id !== 'inColor'), edges: fnGraph.edges.filter((e) => e.id !== 'e1') };
    expect(check(mat(caller), graphDocumentsContext(GRAPH_KINDS, [fn(without)])).some((e) => e.code === 'reference_missing' && /has no input "inColor"/.test(e.message))).toBe(true);
  });

  it('refuses functions that call each other in a cycle (and a function calling itself)', () => {
    const callOther = (id: string, other: string): GraphDocument => fn({ nodes: [{ id: 'c', type: 'call', position: [0, 0], data: { function: other } }, { id: 'o', type: 'functionOutput', position: [200, 0] }], edges: [] }, id);
    expect(errorsOf((e) => validateGraphDocuments(GRAPH_KINDS, [callOther('a', 'b'), callOther('b', 'a')], '', e)).some((e) => e.code === 'hierarchy_cycle')).toBe(true);
    expect(errorsOf((e) => validateGraphDocuments(GRAPH_KINDS, [callOther('a', 'a')], '', e)).some((e) => e.code === 'hierarchy_cycle')).toBe(true);
    expect(errorsOf((e) => validateGraphDocuments(GRAPH_KINDS, [callOther('a', 'scale-color'), fn()], '', e))).toEqual([]);
  });

  it('a material graph kind is owned by its material (not a standalone graph)', () => {
    const e = errorsOf((x) => validateGraphDocuments(GRAPH_KINDS, [{ graphId: 'g', kind: 'material', name: 'M', graph: { nodes: [OUT], edges: [] } }], '', x));
    expect(e[0]!.message).toMatch(/belongs to its material/);
  });
});

describe('per-object overrides (materialParams)', () => {
  const g = mat({ nodes: [OUT], edges: [] }, [
    { key: 'tint', type: 'color', default: '#ffffff' },
    { key: 'speed', type: 'float', default: 1, min: 0, max: 10 },
    { key: 'secret', type: 'float', default: 1, visibility: 'private' },
  ]);
  const shader: MaterialDef = { materialId: 'mat-s', name: 'S', shader: 'standard', params: {}, textures: {} };
  it('accepts public parameters with fitting values', () => {
    expect(materialOverrideErrors({ 'mat-a': { tint: '#102030', speed: 3 } }, [g, shader])).toEqual([]);
  });
  it('refuses private, unknown and out-of-range parameters, missing and shader materials', () => {
    const codes = (o: Record<string, Record<string, number | number[] | string>>): string[] => materialOverrideErrors(o, [g, shader]).map((x) => `${x.code} ${x.path}`);
    expect(codes({ 'mat-a': { secret: 2 } })).toEqual(['field_value /mat-a/secret']);
    expect(materialOverrideErrors({ 'mat-a': { secret: 2 } }, [g])[0]!.message).toMatch(/private/);
    expect(codes({ 'mat-a': { nope: 2 } })).toEqual(['reference_missing /mat-a/nope']);
    expect(codes({ 'mat-a': { speed: 11 } })).toEqual(['field_value /mat-a/speed']);
    expect(codes({ 'mat-a': { tint: 5 } })).toEqual(['field_value /mat-a/tint']);
    expect(codes({ ghost: { x: 1 } })).toEqual(['reference_missing /ghost']);
    expect(codes({ 'mat-s': { x: 1 } })).toEqual(['field_value /mat-s']);
  });
});
