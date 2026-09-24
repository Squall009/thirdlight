/**
 * Phase 16.1: the generic graph model — connection rules, cycles, budgets,
 * op application with exact inverses (copy/paste id remapping and the
 * diagnostics live in the editor: editor/src/graph/model.test.ts).
 */
import { describe, expect, it } from 'vitest';

import {
  applyGraphOps,
  canonicalGraphData,
  portCompatibility,
  validateGraphData,
  validateGraphOps,
  wouldCycle,
  type GraphData,
  type GraphKindDef,
  type GraphOp,
} from './graph';
import { TEST_GRAPH_KIND } from './graph-kinds';
import type { ModelErrorV2 } from './errors';

const K = TEST_GRAPH_KIND;
const errorsOf = (kind: GraphKindDef, g: unknown): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  validateGraphData(kind, g, '', e);
  return e;
};

function base(): GraphData {
  return {
    nodes: [
      { id: 'c1', type: 'constant', position: [0, 0], data: { value: 2 } },
      { id: 'c2', type: 'constant', position: [0, 100] },
      { id: 'add', type: 'add', position: [200, 0] },
      { id: 'vec', type: 'vector', position: [400, 0] },
      { id: 'out', type: 'output', position: [600, 0] },
    ],
    edges: [
      { id: 'e1', from: { node: 'c1', port: 'value' }, to: { node: 'add', port: 'a' } },
      { id: 'e2', from: { node: 'c2', port: 'value' }, to: { node: 'add', port: 'b' } },
      { id: 'e3', from: { node: 'add', port: 'sum' }, to: { node: 'vec', port: 'x' } },
      { id: 'e4', from: { node: 'vec', port: 'vector' }, to: { node: 'out', port: 'value' } },
    ],
  };
}

describe('graph validation (connection rules)', () => {
  it('accepts a well-formed graph ', () => {
    expect(errorsOf(K, base())).toEqual([]);
  });

  it('compatibility: same type, wildcard and the kind’s conversions; nothing else', () => {
    expect(portCompatibility(K, 'number', 'number')).toEqual({ ok: true, conversion: null });
    expect(portCompatibility(K, 'vector', 'any')).toEqual({ ok: true, conversion: null });
    expect(portCompatibility(K, 'number', 'vector')?.conversion?.label).toMatch(/number → vector/);
    expect(portCompatibility(K, 'vector', 'number')).toBeNull();
    expect(portCompatibility(K, 'boolean', 'vector')).toBeNull();
  });

  it('an implicit conversion connects; an incompatible type is refused', () => {
    const g = base();
    g.edges[3] = { id: 'e4', from: { node: 'add', port: 'sum' }, to: { node: 'out', port: 'value' } }; // number → vector
    expect(errorsOf(K, g)).toEqual([]);
    g.nodes.push({ id: 's', type: 'scale', position: [0, 0] });
    g.edges.push({ id: 'bad', from: { node: 'vec', port: 'vector' }, to: { node: 's', port: 'factor' } }); // vector → number
    expect(errorsOf(K, g).map((e) => e.path)).toEqual(['/edges/4/to']);
  });

  it('a single input takes one edge; a multi input takes many; the same pair twice is refused', () => {
    const g = base();
    g.edges.push({ id: 'e5', from: { node: 'c1', port: 'value' }, to: { node: 'add', port: 'b' } });
    expect(errorsOf(K, g).some((e) => /takes one connection/.test(e.message))).toBe(true);
    const m = base();
    m.nodes.push({ id: 'sum', type: 'sum', position: [0, 300] });
    m.edges.push({ id: 's1', from: { node: 'c1', port: 'value' }, to: { node: 'sum', port: 'values' } }, { id: 's2', from: { node: 'c2', port: 'value' }, to: { node: 'sum', port: 'values' } });
    expect(errorsOf(K, m)).toEqual([]);
    m.edges.push({ id: 's3', from: { node: 'c2', port: 'value' }, to: { node: 'sum', port: 'values' } });
    expect(errorsOf(K, m).map((e) => e.code)).toEqual(['id_duplicate']);
  });

  it('unknown node types, ports, fields and bad field values are refused', () => {
    const g = base();
    g.nodes.push({ id: 'x', type: 'nope', position: [0, 0] });
    g.edges.push({ id: 'ex', from: { node: 'c1', port: 'nope' }, to: { node: 'add', port: 'a' } });
    g.nodes[0]!.data = { value: 'two' as unknown as number };
    g.nodes[1]!.data = { colour: 1 };
    const paths = errorsOf(K, g).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['/nodes/0/data/value', '/nodes/1/data/colour', '/nodes/5/type', '/edges/4/from/port']));
  });

  it('ids are unique across nodes, edges, groups and comments', () => {
    const g = { ...base(), groups: [{ id: 'c1', title: 'G', color: '#336699', rect: [0, 0, 10, 10] }] };
    expect(errorsOf(K, g).map((e) => e.code)).toEqual(['id_duplicate']);
  });

  it('cycles are refused in a kind that forbids them and allowed in one that does not', () => {
    const g: GraphData = {
      nodes: [
        { id: 'a', type: 'label', position: [0, 0] },
        { id: 'b', type: 'label', position: [0, 0] },
        { id: 'c', type: 'label', position: [0, 0] },
      ],
      edges: [
        { id: 'ab', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } },
        { id: 'bc', from: { node: 'b', port: 'out' }, to: { node: 'c', port: 'in' } },
      ],
    };
    expect(errorsOf(K, g)).toEqual([]);
    expect(wouldCycle(g, 'c', 'a')).toBe(true);
    expect(wouldCycle(g, 'a', 'c')).toBe(false);
    g.edges.push({ id: 'ca', from: { node: 'c', port: 'out' }, to: { node: 'a', port: 'in' } });
    const e = errorsOf(K, g);
    expect(e.map((x) => x.code)).toEqual(['hierarchy_cycle']);
    expect(e[0]!.message).toMatch(/a → b → c → a|b → c → a → b|c → a → b → c/);
    expect(errorsOf({ ...K, allowCycles: true }, g)).toEqual([]);
  });

  it('the node budget and per-type maximum are enforced', () => {
    const g = base();
    g.nodes.push({ id: 'out2', type: 'output', position: [0, 0] });
    expect(errorsOf(K, g).some((e) => e.code === 'limits_exceeded')).toBe(true);
    const small: GraphKindDef = { ...K, maxNodes: 3 };
    expect(errorsOf(small, base()).some((e) => e.path === '/nodes' && e.code === 'limits_exceeded')).toBe(true);
  });
});

describe('graph ops', () => {
  const run = (g: GraphData, ops: GraphOp[]) => {
    const r = applyGraphOps(g, ops);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r;
  };

  it('every op applies and its inverse restores the graph exactly', () => {
    const g = canonicalGraphData({ ...base(), groups: [{ id: 'g1', title: 'Maths', color: '#335577', rect: [-20, -40, 300, 200] }], comments: [{ id: 'n1', text: 'hello', position: [0, -80] }] });
    const ops: GraphOp[] = [
      { op: 'addNodes', nodes: [{ id: 'm', type: 'multiply', position: [10, 10] }] },
      { op: 'connect', edges: [{ id: 'em', from: { node: 'c1', port: 'value' }, to: { node: 'm', port: 'a' } }] },
      { op: 'moveNodes', moves: [{ id: 'add', position: [220, 20] }, { id: 'n1', position: [5, 5] }, { id: 'g1', position: [0, 0] }] },
      { op: 'setNodeData', id: 'c2', data: { value: 7 } },
      { op: 'setCollapsed', ids: ['vec'], collapsed: true },
      { op: 'setReroutes', id: 'e3', reroutes: [[300, 50]] },
      { op: 'setGroups', groups: [{ id: 'g1', title: 'Renamed', color: '#aa0000', rect: [0, 0, 10, 10] }, { id: 'g2', title: 'New', color: '#00aa00', rect: [1, 1, 5, 5] }] },
      { op: 'setComments', comments: [{ id: 'n2', text: 'more', position: [1, 1], size: [100, 40] }] },
      { op: 'removeComments', ids: ['n1'] },
      { op: 'removeGroups', ids: ['g2'] },
      { op: 'disconnect', ids: ['e2'] },
      { op: 'removeNodes', ids: ['c1'] }, // also cuts e1 and em
    ];
    const r = run(g, ops);
    expect(errorsOf(K, r.graph)).toEqual([]);
    expect(r.graph.nodes.map((n) => n.id)).toEqual(['add', 'c2', 'm', 'out', 'vec']);
    expect(r.graph.edges.map((e) => e.id)).toEqual(['e3', 'e4']);
    expect(r.graph.nodes.find((n) => n.id === 'vec')!.collapsed).toBe(true);
    const back = run(r.graph, r.inverse);
    expect(back.graph).toEqual(g);
    // …and the inverse of the inverse is the forward edit again.
    expect(run(back.graph, back.inverse).graph).toEqual(r.graph);
  });

  it('an op naming a missing item fails with its index; a new id already in use is refused', () => {
    const miss = applyGraphOps(base(), [{ op: 'moveNodes', moves: [{ id: 'c1', position: [1, 1] }] }, { op: 'removeNodes', ids: ['ghost'] }]);
    expect(miss.ok).toBe(false);
    if (!miss.ok) expect(miss.error.path).toBe('/1/ids');
    const dup = applyGraphOps(base(), [{ op: 'connect', edges: [{ id: 'c1', from: { node: 'c1', port: 'value' }, to: { node: 'add', port: 'a' } }] }]);
    expect(dup.ok).toBe(false);
  });

  it('op shapes are checked', () => {
    const bad = (v: unknown): string[] => {
      const e: ModelErrorV2[] = [];
      validateGraphOps(v, '/ops', e);
      return e.map((x) => x.path);
    };
    expect(bad([])).toEqual(['/ops']);
    expect(bad([{ op: 'explode' }])).toEqual(['/ops/0/op']);
    expect(bad([{ op: 'removeNodes', ids: [], extra: 1 }])).toEqual(['/ops/0/extra', '/ops/0/ids']);
    expect(bad([{ op: 'moveNodes', moves: [{ id: 'a', position: [0, Infinity] }] }])).toEqual(['/ops/0/moves']);
    expect(bad([{ op: 'setCollapsed', ids: ['a'], collapsed: true }])).toEqual([]);
  });
});

