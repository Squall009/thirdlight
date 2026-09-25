/**
 * Phase 19.0/19.1: the editor's copy of the visual-script port context
 * (editor session/behavior-graph.ts) equals project-model's
 * `behaviorGraphContext` — the variable lookup (every variable kind, the
 * script's variables inside a function) and the call targets (the script's
 * functions, the project's shared functions) — and its new-script template
 * is a valid behavior graph whose declaration is the one its variables make.
 */
import { describe, expect, it } from 'vitest';

import { behaviorGraphContext, behaviorGraphDeclaration, BEHAVIOR_GRAPH_KIND, GRAPH_KINDS, validateGraphData, type GraphData, type GraphDocument, type ModelErrorV2 } from '@thirdlight/project-model';

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

  it('the new-script template is valid and declares what its variables make', () => {
    const t = newBehaviorGraph();
    const errors: ModelErrorV2[] = [];
    validateGraphData(BEHAVIOR_GRAPH_KIND, t.graph, '', errors, behaviorGraphContext(t.graph));
    expect(errors).toEqual([]);
    expect(t.declaration).toEqual(behaviorGraphDeclaration(t.graph));
  });
});
