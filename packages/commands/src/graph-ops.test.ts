/**
 * Phase 16.1: graph commands — setGraph/deleteGraph and the generic
 * graphEdit (atomic op lists, one undo step, refusals change nothing).
 */
import { describe, expect, it } from 'vitest';
import type { GraphDocument, SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, GraphEditChange, MutationSuccess, SetGraphChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x16100 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const graphs = (s: State): GraphDocument[] => (s.content as { graphs?: GraphDocument[] }).graphs ?? [];
const graphOf = (s: State, id = 'g1') => graphs(s).find((g) => g.graphId === id)!.graph;
const owner = { kind: 'graph', id: 'g1' };

function withGraph(): State {
  return ok(fresh(), 'setGraph', { graph: { graphId: 'g1', kind: 'test', name: 'Maths', graph: { nodes: [], edges: [] } } }).state;
}

describe('setGraph / deleteGraph', () => {
  it('creates, renames and deletes a standalone graph with undo/redo', () => {
    let s = withGraph();
    expect(graphs(s).map((g) => g.name)).toEqual(['Maths']);
    const renamed = ok(s, 'setGraph', { graph: { ...graphs(s)[0]!, name: 'Sums' } });
    expect((renamed.change as SetGraphChange).previous?.name).toBe('Maths');
    s = ok(renamed.state, 'deleteGraph', { graphId: 'g1' }).state;
    expect(graphs(s)).toEqual([]);
    expect((s.content as unknown as Record<string, unknown>)['graphs']).toBeUndefined();
    s = ok(s, 'undo', {}).state;
    expect(graphs(s).map((g) => g.name)).toEqual(['Sums']);
    s = ok(s, 'redo', {}).state;
    expect(graphs(s)).toEqual([]);
  });

  it('refuses an unknown kind, a kind change and deleting a missing graph', () => {
    const s = withGraph();
    expect(run(s, 'setGraph', { graph: { graphId: 'g2', kind: 'nope', name: 'X', graph: { nodes: [], edges: [] } } }).result.ok).toBe(false);
    expect(run(s, 'setGraph', { graph: { graphId: 'g1', kind: 'other', name: 'X', graph: { nodes: [], edges: [] } } }).result.ok).toBe(false);
    expect((run(s, 'deleteGraph', { graphId: 'ghost' }).result.error as { code: string }).code).toBe('reference_missing');
  });
});

describe('graphEdit', () => {
  it('applies an op list atomically as one revision and one undo step', () => {
    const s0 = withGraph();
    const r = ok(s0, 'graphEdit', {
      owner,
      ops: [
        { op: 'addNodes', nodes: [{ id: 'c', type: 'constant', position: [0, 0], data: { value: 3 } }, { id: 'v', type: 'vector', position: [200, 0] }, { id: 'o', type: 'output', position: [400, 0] }] },
        { op: 'connect', edges: [{ id: 'e1', from: { node: 'c', port: 'value' }, to: { node: 'v', port: 'x' } }, { id: 'e2', from: { node: 'v', port: 'vector' }, to: { node: 'o', port: 'value' } }] },
        { op: 'setComments', comments: [{ id: 'k', text: 'note', position: [0, -60] }] },
      ],
    });
    expect(r.state.scene.revision).toBe(s0.scene.revision + 1);
    expect((r.change as GraphEditChange).ops).toHaveLength(3);
    expect(graphOf(r.state).nodes.map((n) => n.id)).toEqual(['c', 'o', 'v']);
    expect(graphOf(r.state).edges).toHaveLength(2);
    const undone = ok(r.state, 'undo', {});
    expect(graphOf(undone.state)).toEqual({ nodes: [], edges: [] });
    // The undo's change carries the inverse ops, so a client advances from it alone.
    expect((undone.change as GraphEditChange).ops.map((o) => o.op)).toEqual(['removeComments', 'disconnect', 'removeNodes']);
    const redone = ok(undone.state, 'redo', {});
    expect(graphOf(redone.state)).toEqual(graphOf(r.state));
  });

  it('a drag is one moveNodes: one undo restores every moved position', () => {
    let s = ok(withGraph(), 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'a', type: 'constant', position: [0, 0] }, { id: 'b', type: 'constant', position: [0, 100] }] }] }).state;
    s = ok(s, 'graphEdit', { owner, ops: [{ op: 'moveNodes', moves: [{ id: 'a', position: [40, 20] }, { id: 'b', position: [40, 120] }] }] }).state;
    expect(graphOf(s).nodes.map((n) => n.position)).toEqual([[40, 20], [40, 120]]);
    s = ok(s, 'undo', {}).state;
    expect(graphOf(s).nodes.map((n) => n.position)).toEqual([[0, 0], [0, 100]]);
  });

  it('refuses a rule-breaking edit and changes nothing (incompatible types, a cycle, a second edge into a single input)', () => {
    const s = ok(withGraph(), 'graphEdit', {
      owner,
      ops: [{ op: 'addNodes', nodes: [{ id: 'a', type: 'label', position: [0, 0] }, { id: 'b', type: 'label', position: [0, 0] }, { id: 't', type: 'toggle', position: [0, 0] }, { id: 'v', type: 'vector', position: [0, 0] }] }, { op: 'connect', edges: [{ id: 'ab', from: { node: 'a', port: 'out' }, to: { node: 'b', port: 'in' } }] }],
    }).state;
    const cases = [
      [{ op: 'connect', edges: [{ id: 'ba', from: { node: 'b', port: 'out' }, to: { node: 'a', port: 'in' } }] }],
      [{ op: 'connect', edges: [{ id: 'tv', from: { node: 't', port: 'value' }, to: { node: 'v', port: 'x' } }] }], // boolean → number converts: fine alone…
      [{ op: 'connect', edges: [{ id: 'vt', from: { node: 'v', port: 'vector' }, to: { node: 'v', port: 'y' } }] }],
      [{ op: 'connect', edges: [{ id: 'x1', from: { node: 't', port: 'value' }, to: { node: 'b', port: 'in' } }] }],
      [{ op: 'addNodes', nodes: [{ id: 'z', type: 'nope', position: [0, 0] }] }],
      [{ op: 'removeNodes', ids: ['ghost'] }],
    ];
    const outcomes = cases.map((ops) => run(s, 'graphEdit', { owner, ops }).result);
    expect(outcomes.map((o) => o.ok)).toEqual([false, true, false, false, false, false]);
    expect((outcomes[0]!.error as { message: string }).message).toMatch(/cycle/);
    expect((outcomes[2]!.error as { message: string }).message).toMatch(/cannot feed|feed itself/);
    expect((outcomes[3]!.error as { message: string }).message).toMatch(/takes one connection/);
    expect((outcomes[5]!.error as { path: string }).path).toBe('/args/ops/0/ids');
    expect(graphOf(s).edges.map((e) => e.id)).toEqual(['ab']);
  });

  it('refuses a malformed request and an unknown owner', () => {
    const s = withGraph();
    expect((run(s, 'graphEdit', { owner, ops: [] }).result.error as { code: string }).code).toBe('field_value');
    expect((run(s, 'graphEdit', { owner: { kind: 'graph' }, ops: [{ op: 'removeNodes', ids: ['a'] }] }).result.error as { code: string }).code).toBe('field_type');
    expect((run(s, 'graphEdit', { owner: { kind: 'castle', id: 'g1' }, ops: [{ op: 'removeNodes', ids: ['a'] }] }).result.error as { path: string }).path).toBe('/args/owner/kind');
    expect((run(s, 'graphEdit', { owner: { kind: 'graph', id: 'nope' }, ops: [{ op: 'removeNodes', ids: ['a'] }] }).result.error as { code: string }).code).toBe('reference_missing');
  });

  it('an edit that changes nothing is refused with no_change', () => {
    const s = ok(withGraph(), 'graphEdit', { owner, ops: [{ op: 'addNodes', nodes: [{ id: 'a', type: 'constant', position: [0, 0] }] }] }).state;
    expect((run(s, 'graphEdit', { owner, ops: [{ op: 'moveNodes', moves: [{ id: 'a', position: [0, 0] }] }] }).result.error as { code: string }).code).toBe('no_change');
  });
});
