/**
 * Phase 18.3: the graph compiler's copy of the material catalogue
 * (three-adapter does not import project-model) against the catalogue:
 * every node type of both material graph kinds is compiled, with the same
 * port ids, types (`dyn` = the node's Type field), defaults and field
 * defaults; and its port resolution equals project-model's
 * `resolveGraphPorts` (auto widths, swizzles, parameters, function calls).
 */
import { describe, expect, it } from 'vitest';

import { graphDocumentsContext, GRAPH_KINDS, materialGraphContext, MATERIAL_FUNCTION_GRAPH_KIND, MATERIAL_GRAPH_KIND, resolveGraphPorts, type GraphData, type GraphDocument, type GraphKindDef, type MaterialParameter } from '../packages/project-model/src/index';
import { COMPILER_FIELD_DEFAULTS, COMPILER_NODES, resolveMaterialGraphPorts } from '../packages/three-adapter/src/material-graph';

const DATA_PORTS = new Set(['parameter', 'swizzle', 'call', 'functionInput', 'functionOutput']);

describe('material graph compiler parity with the catalogue', () => {
  for (const kind of [MATERIAL_GRAPH_KIND, MATERIAL_FUNCTION_GRAPH_KIND] as GraphKindDef[]) {
    it(`${kind.kind}: every node type has the catalogue's ports and field defaults`, () => {
      for (const def of kind.nodes) {
        const spec = COMPILER_NODES[def.type];
        expect(spec, def.type).toBeDefined();
        if (DATA_PORTS.has(def.type)) continue;
        const side = (ports: typeof def.inputs): unknown[] => ports.map((p) => ({ id: p.id, t: p.typeFrom?.field === 'type' ? 'dyn' : p.type, ...(p.default !== undefined ? { d: p.default } : {}) }));
        expect(spec!.inputs, `${def.type} inputs`).toEqual(side(def.inputs));
        expect(spec!.outputs, `${def.type} outputs`).toEqual(side(def.outputs));
        const fields = Object.fromEntries((def.fields ?? []).filter((f) => f.key !== 'type').map((f) => [f.key, f.default]));
        if (Object.keys(fields).length > 0) expect(COMPILER_FIELD_DEFAULTS[def.type], `${def.type} fields`).toEqual(fields);
      }
    });
  }

  it('the compiler knows no node type the catalogue lacks', () => {
    const all = new Set([...MATERIAL_GRAPH_KIND.nodes, ...MATERIAL_FUNCTION_GRAPH_KIND.nodes].map((d) => d.type));
    expect(Object.keys(COMPILER_NODES).filter((t) => !all.has(t))).toEqual([]);
  });

  it('resolves port types like project-model', () => {
    const fns: GraphDocument[] = [
      {
        graphId: 'fx',
        kind: 'material-function',
        name: 'Fx',
        graph: {
          nodes: [
            { id: 'b', type: 'functionInput', position: [0, 100], data: { name: 'k', type: 'float' } },
            { id: 'a', type: 'functionInput', position: [0, 0], data: { name: 'c', type: 'vec3' } },
            { id: 't', type: 'functionInput', position: [0, 200], data: { name: 'map', type: 'texture' } },
            { id: 'o', type: 'functionOutput', position: [300, 0], data: { name: 'out', type: 'vec2' } },
          ],
          edges: [],
        },
      },
    ];
    const params: MaterialParameter[] = [
      { key: 'tint', type: 'color', default: '#ffffff' },
      { key: 'map', type: 'texture', default: '' },
      { key: 'off', type: 'vec2', default: [0, 0] },
    ];
    const graph: GraphData = {
      nodes: [
        { id: 'out', type: 'pbr', position: [0, 0] },
        { id: 'c', type: 'color', position: [0, 0] },
        { id: 'f', type: 'float', position: [0, 0] },
        { id: 'm', type: 'multiply', position: [0, 0] },
        { id: 'l', type: 'lerp', position: [0, 0] },
        { id: 'chain', type: 'add', position: [0, 0] },
        { id: 'fixed', type: 'clamp', position: [0, 0], data: { type: 'vec2' } },
        { id: 'sw', type: 'swizzle', position: [0, 0], data: { mask: 'rg' } },
        { id: 'p', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
        { id: 'q', type: 'parameter', position: [0, 0], data: { key: 'map' } },
        { id: 'r', type: 'parameter', position: [0, 0], data: { key: 'off' } },
        { id: 'call', type: 'call', position: [0, 0], data: { function: 'fx' } },
        { id: 'len', type: 'length', position: [0, 0] },
        { id: 'dot', type: 'dot', position: [0, 0] },
      ],
      edges: [
        { id: 'e1', from: { node: 'c', port: 'rgb' }, to: { node: 'm', port: 'a' } },
        { id: 'e2', from: { node: 'f', port: 'value' }, to: { node: 'm', port: 'b' } },
        { id: 'e3', from: { node: 'r', port: 'value' }, to: { node: 'l', port: 't' } },
        { id: 'e4', from: { node: 'm', port: 'out' }, to: { node: 'chain', port: 'a' } },
        { id: 'e5', from: { node: 'c', port: 'rgba' }, to: { node: 'len', port: 'in' } },
        { id: 'e6', from: { node: 'r', port: 'value' }, to: { node: 'dot', port: 'b' } },
      ],
    };
    const ctx = materialGraphContext(params, graphDocumentsContext(GRAPH_KINDS, fns));
    const want = resolveGraphPorts(MATERIAL_GRAPH_KIND, graph, ctx);
    const got = resolveMaterialGraphPorts(graph, params, (id) => fns.find((g) => g.graphId === id) ?? null);
    for (const n of graph.nodes) {
      const w = want.get(n.id)!;
      const g = got.get(n.id)!;
      expect(g.inputs.map((p) => [p.id, p.t]), `${n.id} inputs`).toEqual(w.inputs.map((p) => [p.id, p.type]));
      expect(g.outputs.map((p) => [p.id, p.t]), `${n.id} outputs`).toEqual(w.outputs.map((p) => [p.id, p.type]));
    }
  });
});
