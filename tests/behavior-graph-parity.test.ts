/**
 * Phase 19.0/19.1: the editor's copy of the visual-script port context
 * (editor session/behavior-graph.ts) equals project-model's
 * `behaviorGraphContext` — the variable lookup (every variable kind, the
 * script's variables inside a function) and the call targets (the script's
 * functions, the project's shared functions) — and its new-script template
 * is a valid behavior graph whose declaration is the one its variables make.
 */
import { describe, expect, it } from 'vitest';

import { behaviorGraphContext, behaviorGraphDeclaration, BEHAVIOR_GRAPH_KIND, GRAPH_KINDS, repeatedPorts, repeatItems, resolveGraphPorts, TEST_GRAPH_KIND, validateGraphData, type GraphData, type GraphDocument, type GraphKindDef, type ModelErrorV2 } from '@thirdlight/project-model';

import * as editorModel from '../packages/editor/src/graph/model';

import { behaviorPortContext, newBehaviorGraph, parseBehaviorOwnerId } from '../packages/editor/src/session/behavior-graph';
import { parseBehaviorOwnerId as commandsParse } from '../packages/commands/src/graph-ops';

const SCRIPT: GraphData = {
  nodes: [
    { id: 'b', type: 'var.boolean', position: [0, 10], data: { name: 'armed' } },
    { id: 'a', type: 'var.number', position: [0, 10], data: { name: 'armed' } },
    { id: 'c', type: 'var.string', position: [0, -5], data: { name: 'title' } },
    { id: 'd', type: 'var.number', position: [0, 0] },
    { id: 'e', type: 'var.vector', position: [0, 20], data: { name: 'aim' } },
    { id: 'f', type: 'var.entity', position: [0, 30], data: { name: 'door' } },
    { id: 'g', type: 'var.enum', position: [0, 40], data: { name: 'mode', options: 'a, b' } },
    { id: 'h', type: 'var.list', position: [0, 50], data: { name: 'items' } },
    { id: 'i', type: 'var.map', position: [0, 60], data: { name: 'table' } },
    { id: 'j', type: 'var.get', position: [0, 0], data: { variable: 'armed' } },
  ],
  edges: [],
};
const FUNCTION: GraphData = {
  nodes: [
    { id: 'start', type: 'fn.entry', position: [0, 0] },
    { id: 'local', type: 'var.string', position: [0, 10], data: { name: 'title' } },
  ],
  edges: [],
};
const FUNCTIONS = [{ functionId: 'helper', graph: FUNCTION }];
const GRAPHS: GraphDocument[] = [
  { graphId: 'shared', kind: 'behavior-library', name: 'Shared', graph: FUNCTION },
  { graphId: 'mat', kind: 'material-function', name: 'Material function', graph: { nodes: [], edges: [] } },
];
const NAMES = ['armed', 'title', 'aim', 'door', 'mode', 'items', 'table', '', 'ghost'];

describe('behavior graph parity (editor ↔ project-model)', () => {
  it('the variable lookup gives the same types (the script, and a function with the script around it)', () => {
    for (const [g, script] of [
      [{ nodes: [], edges: [] }, undefined],
      [SCRIPT, undefined],
      [FUNCTION, SCRIPT],
    ] as [GraphData, GraphData | undefined][]) {
      const a = behaviorGraphContext(g, { functions: FUNCTIONS, graphs: GRAPHS, ...(script !== undefined ? { script } : {}) });
      const b = behaviorPortContext(g, { functions: FUNCTIONS, graphs: GRAPHS, kinds: GRAPH_KINDS, ...(script !== undefined ? { script } : {}) });
      for (const name of NAMES) {
        for (const lookup of ['variable', 'parameter']) expect(b.lookup!(lookup, name), `${lookup} ${name}`).toBe(a.lookup!(lookup, name));
      }
    }
  });

  it('call targets resolve alike: the script functions and the shared functions (other kinds and ids: none)', () => {
    const a = behaviorGraphContext(SCRIPT, { functions: FUNCTIONS, graphs: GRAPHS });
    const b = behaviorPortContext(SCRIPT, { functions: FUNCTIONS, graphs: GRAPHS, kinds: GRAPH_KINDS });
    for (const [kind, id] of [
      ['behavior-function', 'helper'],
      ['behavior-function', 'shared'],
      ['behavior-library', 'shared'],
      ['behavior-library', 'helper'],
      ['material-function', 'mat'],
    ]) {
      const x = a.graph!(kind!, id!);
      const y = b.graph!(kind!, id!);
      expect(y === null, `${kind} ${id}`).toBe(x === null);
      if (x !== null && y !== null) {
        expect(y.kind.kind).toBe(x.kind.kind);
        expect(y.graph.nodes.map((n) => n.id)).toEqual(x.graph.nodes.map((n) => n.id));
      }
    }
  });

  it('owner ids of script functions parse alike', () => {
    for (const id of ['door', 'door#open', 'door#', '#x']) expect(parseBehaviorOwnerId(id)).toEqual(commandsParse(id));
  });

  it('phase 19.2: repeated ports (a port count from a node field) resolve alike, and wires to them validate', () => {
    // The Switch: one exec output per listed case (text list), ids case1..caseN, the item as the label.
    const g: GraphData = {
      nodes: [
        { id: 'ev', type: 'event.start', position: [0, 0] },
        { id: 'sw', type: 'flow.switch', position: [200, 0], data: { cases: 'red, , blue' } },
        { id: 'sd', type: 'flow.switch', position: [200, 200] },
        { id: 'se', type: 'flow.switch', position: [200, 400], data: { cases: '' } },
        { id: 'log', type: 'debug.log', position: [400, 0] },
      ],
      edges: [
        { id: 'e1', from: { node: 'ev', port: 'then' }, to: { node: 'sw', port: 'in' } },
        { id: 'e2', from: { node: 'sw', port: 'case3' }, to: { node: 'log', port: 'in' } },
      ],
    };
    const ctx = behaviorGraphContext(g);
    const backend = resolveGraphPorts(BEHAVIOR_GRAPH_KIND, g, ctx);
    const ed = editorModel.resolvePorts(BEHAVIOR_GRAPH_KIND, g, behaviorPortContext(g));
    for (const [id, ports] of backend) expect(ed.get(id), id).toEqual(ports);
    expect(backend.get('sw')!.outputs.map((p) => `${p.id}:${p.label}:${p.type}`)).toEqual(['case1:red:exec', 'case2:case 2:exec', 'case3:blue:exec', 'default:default:exec']);
    expect(backend.get('sd')!.outputs.map((p) => p.id)).toEqual(['case1', 'case2', 'case3', 'default']);
    expect(backend.get('se')!.outputs.map((p) => p.id)).toEqual(['default']);
    const errors: ModelErrorV2[] = [];
    validateGraphData(BEHAVIOR_GRAPH_KIND, g, '', errors, ctx);
    expect(errors).toEqual([]);
    // Fewer cases strand the wire on case3: refused (a later case's wire needs its port).
    const fewer: GraphData = { ...g, nodes: g.nodes.map((n) => (n.id === 'sw' ? { ...n, data: { cases: 'red' } } : n)) };
    const refused: ModelErrorV2[] = [];
    validateGraphData(BEHAVIOR_GRAPH_KIND, fewer, '', refused, behaviorGraphContext(fewer));
    expect(refused.length).toBeGreaterThan(0);

    // A number field is a count (clamped to 0..max), in both copies.
    const kind: GraphKindDef = {
      ...TEST_GRAPH_KIND,
      kind: 'repeat-test',
      nodes: [{ type: 'mix', label: 'Mix', category: 'Test', inputs: [{ id: 'in', label: 'in', type: TEST_GRAPH_KIND.portTypes[0]!.id, repeat: { field: 'count', max: 4 } }], outputs: [], fields: [{ key: 'count', label: 'Count', type: 'number', default: 2 }] }],
    };
    for (const count of [undefined, 0, 3, 9, -2, 2.7]) {
      const n = { id: 'm', type: 'mix', position: [0, 0] as [number, number], ...(count !== undefined ? { data: { count } } : {}) };
      const def = kind.nodes[0]!;
      expect(editorModel.repeatedPorts(def, n, def.inputs[0]!), String(count)).toEqual(repeatedPorts(def, n, def.inputs[0]!));
      expect(editorModel.resolvePorts(kind, { nodes: [n], edges: [] }).get('m')).toEqual(resolveGraphPorts(kind, { nodes: [n], edges: [] }).get('m'));
    }
    expect(resolveGraphPorts(kind, { nodes: [{ id: 'm', type: 'mix', position: [0, 0], data: { count: 9 } }], edges: [] }).get('m')!.inputs.map((p) => p.id)).toEqual(['in1', 'in2', 'in3', 'in4']);
    for (const v of ['', ' a ', 'a,b', ',', 'a,,b ']) expect(editorModel.repeatItems(v)).toEqual(repeatItems(v));
  });

  it('the new-script template is valid and declares what its variables make', () => {
    const t = newBehaviorGraph();
    const errors: ModelErrorV2[] = [];
    validateGraphData(BEHAVIOR_GRAPH_KIND, t.graph, '', errors, behaviorGraphContext(t.graph));
    expect(errors).toEqual([]);
    expect(t.declaration).toEqual(behaviorGraphDeclaration(t.graph));
  });
});
