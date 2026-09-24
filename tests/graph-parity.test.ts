/**
 * Phase 16.1: the editor's graph model (editor/src/graph/model.ts — the
 * editor may import project-model types only) against project-model:
 *
 * - the editor's projection applies a change's ops exactly as the backend
 *   does (`applyGraphOps`), for forward edits and for the undo's inverse ops;
 * - its compatibility and cycle checks agree with the backend validator;
 * - copy/paste remaps ids so the pasted piece is valid in the backend;
 * - its diagnostics read the registered kind's rules.
 */
import { describe, expect, it } from 'vitest';

import { applyGraphOps, canonicalGraphData, portCompatibility, validateGraphData, type GraphData, type GraphOp, type ModelErrorV2 } from '../packages/project-model/src/index';
import { TEST_GRAPH_KIND as K } from '../packages/project-model/src/graph-kinds';
import * as editor from '../packages/editor/src/graph/model';

function base(): GraphData {
  return canonicalGraphData({
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
    groups: [{ id: 'g1', title: 'Maths', color: '#335577', rect: [-20, -40, 300, 200] }],
    comments: [{ id: 'k1', text: 'hello', position: [0, -80] }],
  });
}
const valid = (g: GraphData): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  validateGraphData(K, g, '', e);
  return e;
};

const EDITS: GraphOp[][] = [
  [{ op: 'addNodes', nodes: [{ id: 'm', type: 'multiply', position: [10, 10], collapsed: true }] }, { op: 'connect', edges: [{ id: 'em', from: { node: 'c1', port: 'value' }, to: { node: 'm', port: 'a' }, reroutes: [[50, 50]] }] }],
  [{ op: 'moveNodes', moves: [{ id: 'add', position: [220, 20] }, { id: 'k1', position: [5, 5] }, { id: 'g1', position: [0, 0] }] }],
  [{ op: 'setNodeData', id: 'c2', data: { value: 7 } }, { op: 'setNodeData', id: 'c1', data: {} }],
  [{ op: 'setCollapsed', ids: ['vec', 'add'], collapsed: true }],
  [{ op: 'setReroutes', id: 'e3', reroutes: [[300, 50], [320, 60]] }],
  [{ op: 'setGroups', groups: [{ id: 'g1', title: 'Renamed', color: '#aa0000', rect: [0, 0, 10, 10] }, { id: 'g2', title: 'New', color: '#00aa00', rect: [1, 1, 5, 5] }] }],
  [{ op: 'setComments', comments: [{ id: 'k2', text: 'more', position: [1, 1], size: [100, 40] }] }, { op: 'removeComments', ids: ['k1'] }],
  [{ op: 'removeGroups', ids: ['g1'] }, { op: 'disconnect', ids: ['e2'] }],
  [{ op: 'removeNodes', ids: ['c1', 'vec'] }],
];

describe('graph parity: editor projection vs project-model', () => {
  it('forward ops and the undo’s inverse ops give the same graph in both', () => {
    for (const ops of EDITS) {
      const backend = applyGraphOps(base(), ops);
      expect(backend.ok).toBe(true);
      if (!backend.ok) continue;
      expect(editor.applyGraphOpsLocal(base(), ops)).toEqual(backend.graph);
      const undone = applyGraphOps(backend.graph, backend.inverse);
      expect(undone.ok).toBe(true);
      if (undone.ok) expect(editor.applyGraphOpsLocal(backend.graph, backend.inverse)).toEqual(undone.graph);
    }
  });

  it('an op that does not fit the copy makes the projection re-read (null)', () => {
    expect(editor.applyGraphOpsLocal(base(), [{ op: 'removeNodes', ids: ['ghost'] }])).toBeNull();
    expect(editor.applyGraphOpsLocal(base(), [{ op: 'addNodes', nodes: [{ id: 'e1', type: 'constant', position: [0, 0] }] }])).toBeNull();
  });

  it('compatibility agrees with the backend for every pair of port types', () => {
    for (const a of K.portTypes) {
      for (const b of K.portTypes) {
        const be = portCompatibility(K, a.id, b.id);
        const ed = editor.compatibility(K, a.id, b.id);
        expect(ed === null, `${a.id} → ${b.id}`).toBe(be === null);
        if (be !== null && ed !== null) expect(ed.conversion).toEqual(be.conversion);
      }
    }
  });

  it('a connection the editor plans is accepted by the backend; one it refuses is refused', () => {
    const g = base();
    const tries: [editor.PortEnd, editor.PortEnd][] = [
      [{ node: 'c2', port: 'value', side: 'out' }, { node: 'vec', port: 'y', side: 'in' }], // ok
      [{ node: 'c2', port: 'value', side: 'out' }, { node: 'add', port: 'a', side: 'in' }], // replaces e1
      [{ node: 'add', port: 'sum', side: 'out' }, { node: 'out', port: 'value', side: 'in' }], // number → vector conversion, replaces e4
      [{ node: 'vec', port: 'vector', side: 'out' }, { node: 'add', port: 'b', side: 'in' }], // vector → number: refused
      [{ node: 'add', port: 'sum', side: 'out' }, { node: 'add', port: 'b', side: 'in' }], // cycle: refused
    ];
    const outcomes = tries.map(([a, b]) => {
      const plan = editor.planConnection(K, g, a, b);
      if (!plan.ok) return { planned: false, reason: plan.reason };
      const ops: GraphOp[] = [...(plan.replaces.length > 0 ? [{ op: 'disconnect' as const, ids: plan.replaces }] : []), { op: 'connect', edges: [{ id: 'new', from: plan.from, to: plan.to }] }];
      const r = applyGraphOps(g, ops);
      return { planned: true, valid: r.ok && valid(r.graph).length === 0, conversion: plan.conversion?.label ?? null };
    });
    expect(outcomes).toEqual([
      { planned: true, valid: true, conversion: null },
      { planned: true, valid: true, conversion: null },
      { planned: true, valid: true, conversion: 'number → vector (all components)' },
      { planned: false, reason: 'a vector output cannot feed a number input' },
      { planned: false, reason: 'this would make a cycle' },
    ]);
    // …and the backend agrees the refused ones are invalid.
    for (const [a, b] of tries.slice(3)) {
      const r = applyGraphOps(g, [{ op: 'connect', edges: [{ id: 'x', from: { node: a.node, port: a.port }, to: { node: b.node, port: b.port } }] }]);
      expect(r.ok && valid(r.graph).length === 0).toBe(false);
    }
  });

  it('copy/paste: fresh ids, edges remapped inside the piece, valid in the backend', () => {
    const g = base();
    const clip = editor.copyItems('test', g, new Set(['c1', 'add', 'vec', 'k1']));
    expect(clip.nodes.map((n) => n.id)).toEqual(['add', 'c1', 'vec']);
    expect(clip.edges.map((e) => e.id)).toEqual(['e1', 'e3']); // e2 (from c2) and e4 (to out) leave the piece
    const { ops, ids } = editor.pasteItems(clip, editor.makeIdFactory(g, 'p'), { offset: [20, 20] });
    const r = applyGraphOps(g, ops);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(valid(r.graph)).toEqual([]);
    const pasted = r.graph.nodes.filter((x) => ids.includes(x.id));
    expect(pasted.map((x) => [x.type, x.position]).sort()).toEqual([['add', [220, 20]], ['constant', [20, 20]], ['vector', [420, 20]]]);
    const fresh = r.graph.edges.filter((e) => !g.edges.some((o) => o.id === e.id));
    expect(fresh).toHaveLength(2);
    for (const e of fresh) expect(ids).toEqual(expect.arrayContaining([e.from.node, e.to.node]));
    expect(pasted.find((x) => x.type === 'constant')!.data).toEqual({ value: 2 });
    expect(r.graph.comments!.filter((c) => ids.includes(c.id)).map((c) => c.position)).toEqual([[20, -60]]);
    // Pasting again (e.g. in another tab of the same kind) never reuses an id.
    const again = editor.pasteItems(clip, editor.makeIdFactory(r.graph, 'p'), { at: [1000, 500] });
    const r2 = applyGraphOps(r.graph, again.ops);
    expect(r2.ok && valid(r2.graph).length === 0).toBe(true);
    const added = again.ops[0]!;
    expect(added.op === 'addNodes' ? Math.min(...added.nodes.map((n) => n.position[0])) : 0).toBe(1000);
  });

  it('diagnostics read the kind: unconnected required inputs, a missing required node, results that reach no sink', () => {
    expect(editor.diagnoseGraph(K, base())).toEqual([]);
    const g = base();
    g.edges = g.edges.filter((e) => e.id !== 'e2' && e.id !== 'e4');
    g.nodes = g.nodes.filter((n) => n.id !== 'out');
    const p = editor.diagnoseGraph(K, g);
    expect(p).toContainEqual({ severity: 'error', nodeId: 'add', message: 'Add: input "b" is not connected' });
    expect(p).toContainEqual({ severity: 'error', message: 'the graph needs a "Output" node' });
    expect(p.filter((x) => x.severity === 'warning').map((x) => x.nodeId).sort()).toEqual(['add', 'c1', 'c2', 'vec']);
  });

  it('delete, align and group builders produce edits the backend accepts', () => {
    const g = base();
    const r = applyGraphOps(g, editor.deleteOps(g, new Set(['add', 'e4', 'g1', 'k1'])));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.graph.edges).toEqual([]);
      expect(r.graph.groups).toBeUndefined();
    }
    const align = editor.alignOps(K, g, new Set(['c1', 'c2', 'add']), 'top', true)!;
    const ra = applyGraphOps(g, [align]);
    expect(ra.ok && ra.graph.nodes.filter((n) => ['c1', 'c2', 'add'].includes(n.id)).every((n) => n.position[1] === 0)).toBe(true);
    const grp = editor.groupAround(K, g, new Set(['c1', 'c2']), 'g9', '#446688')!;
    const rg = applyGraphOps(g, [{ op: 'setGroups', groups: [grp] }]);
    expect(rg.ok && valid(rg.graph).length === 0).toBe(true);
    expect(editor.itemsInGroup(K, g, grp).sort()).toEqual(['c1', 'c2']);
  });
});
