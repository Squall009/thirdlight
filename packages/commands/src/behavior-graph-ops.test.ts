/**
 * Phase 19.0: visual scripts through the commands — a behavior created with
 * a graph (publishBehavior declaration-create + graph), edited with the
 * generic graphEdit on owner kind `behavior` (one revision, one undo step),
 * the exec/data wiring rules refused by the kind, and the declaration of a
 * visual script coming only from its graph.
 */
import { describe, expect, it } from 'vitest';
import type { BehaviorRecord, GraphData, SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, GraphEditChange, MutationSuccess } from './index';
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
    requestId: `req-${(0x19000 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change };
}
const refusal = (state: State, op: string, args: Record<string, unknown>): { code: string; reason?: string; message: string } => {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  return r.result.error as { code: string; reason?: string; message: string };
};
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const record = (s: State, id = 'vs'): BehaviorRecord | undefined => (s.content as unknown as { behaviors: BehaviorRecord[] }).behaviors.find((b) => b.behaviorId === id);
const owner = { kind: 'behavior', id: 'vs' };
const START: GraphData = { nodes: [{ id: 'start', type: 'event.start', position: [0, 0] }, { id: 'var', type: 'var.number', position: [0, -140], data: { name: 'value' } }], edges: [] };
const DECL = { properties: [{ key: 'value', label: 'Value', type: 'number', default: 0 }] };

function withScript(): State {
  return ok(fresh(), 'publishBehavior', { behaviorId: 'vs', displayName: 'Visual', mode: 'declaration-create', declaration: DECL, graph: START }).state;
}

describe('a visual-script behavior', () => {
  it('is created with its graph (canonical), undone and redone', () => {
    let s = withScript();
    expect(record(s)?.graph).toEqual({ nodes: [START.nodes[0], START.nodes[1]], edges: [] });
    expect(record(s)?.source).toBeNull();
    s = ok(s, 'undo', {}).state;
    expect(record(s)).toBeUndefined();
    s = ok(s, 'redo', {}).state;
    expect(record(s)?.graph?.nodes).toHaveLength(2);
  });

  it('graphEdit on owner "behavior": one revision, one undo step, the change carries the ops', () => {
    const s0 = withScript();
    const r = ok(s0, 'graphEdit', {
      owner,
      ops: [
        { op: 'addNodes', nodes: [{ id: 'add', type: 'api.game.add', position: [240, 0], data: { name: 'coins' } }] },
        { op: 'connect', edges: [{ id: 'w1', from: { node: 'start', port: 'then' }, to: { node: 'add', port: 'in' } }] },
      ],
    });
    expect(r.state.scene.revision).toBe(s0.scene.revision + 1);
    const change = r.change as GraphEditChange;
    expect(change.type).toBe('graphEdit');
    expect(change.owner).toEqual(owner);
    expect(change.ops).toHaveLength(2);
    expect(record(r.state)?.graph?.edges.map((e) => e.id)).toEqual(['w1']);
    const undone = ok(r.state, 'undo', {});
    expect(record(undone.state)?.graph).toEqual(record(s0)?.graph);
    const redone = ok(undone.state, 'redo', {});
    expect(record(redone.state)?.graph).toEqual(record(r.state)?.graph);
  });

  it('refuses wiring that breaks the exec/data rules, and cycles; nothing changes', () => {
    const s0 = ok(withScript(), 'graphEdit', {
      owner,
      ops: [
        {
          op: 'addNodes',
          nodes: [
            { id: 'a', type: 'debug.log', position: [240, 0] },
            { id: 'b', type: 'debug.log', position: [480, 0] },
            { id: 'seq', type: 'flow.sequence', position: [240, 200] },
            { id: 'add', type: 'math.add', position: [0, 300] },
            { id: 'mul', type: 'math.multiply', position: [200, 300] },
          ],
        },
      ],
    }).state;
    const edit = (edges: { id: string; from: [string, string]; to: [string, string] }[]) => ({
      owner,
      ops: [{ op: 'connect', edges: edges.map((e) => ({ id: e.id, from: { node: e.from[0], port: e.from[1] }, to: { node: e.to[0], port: e.to[1] } })) }],
    });
    // Exec into data and data into exec: incompatible port types.
    expect(refusal(s0, 'graphEdit', edit([{ id: 'x', from: ['start', 'then'], to: ['a', 'message'] }])).message).toMatch(/exec output cannot feed a text input/);
    expect(refusal(s0, 'graphEdit', edit([{ id: 'x', from: ['add', 'result'], to: ['a', 'in'] }])).message).toMatch(/cannot feed a exec input/);
    // One wire out of an exec output...
    expect(refusal(s0, 'graphEdit', edit([{ id: 'x', from: ['start', 'then'], to: ['a', 'in'] }, { id: 'y', from: ['start', 'then'], to: ['b', 'in'] }])).message).toMatch(/takes one connection/);
    // ...unless it is a Sequence's outputs (one each), and many wires into an exec input are fine.
    ok(s0, 'graphEdit', edit([{ id: 'x', from: ['start', 'then'], to: ['seq', 'in'] }, { id: 'y', from: ['seq', 'then1'], to: ['a', 'in'] }, { id: 'z', from: ['seq', 'then2'], to: ['b', 'in'] }, { id: 'q', from: ['a', 'then'], to: ['b', 'in'] }]));
    // A data cycle and an exec loop are refused (repetition only inside a For node).
    expect(refusal(s0, 'graphEdit', edit([{ id: 'x', from: ['add', 'result'], to: ['mul', 'a'] }, { id: 'y', from: ['mul', 'result'], to: ['add', 'a'] }])).code).toBe('hierarchy_cycle');
    expect(refusal(s0, 'graphEdit', edit([{ id: 'x', from: ['a', 'then'], to: ['b', 'in'] }, { id: 'y', from: ['b', 'then'], to: ['a', 'in'] }])).code).toBe('hierarchy_cycle');
    // The implicit conversions: number → text is allowed.
    ok(s0, 'graphEdit', edit([{ id: 'x', from: ['add', 'result'], to: ['a', 'message'] }]));
  });

  it('one edit may declare a variable and wire its Get by type (the edit validates against its own result)', () => {
    const s0 = withScript();
    const add = (varType: string) => ({
      owner,
      ops: [
        { op: 'addNodes', nodes: [{ id: 'v2', type: varType, position: [0, -280], data: { name: 'armed' } }, { id: 'get', type: 'var.get', position: [0, 200], data: { variable: 'armed' } }, { id: 'br', type: 'flow.branch', position: [240, 200] }] },
        { op: 'connect', edges: [{ id: 'w', from: { node: 'get', port: 'value' }, to: { node: 'br', port: 'condition' } }] },
      ],
    });
    ok(s0, 'graphEdit', add('var.boolean'));
    expect(refusal(s0, 'graphEdit', add('var.string')).message).toMatch(/text output cannot feed a boolean input/);
  });

  it('a behavior without a graph has no behavior graph; a graph is only accepted at creation', () => {
    const s = ok(fresh(), 'publishBehavior', { behaviorId: 'plain', displayName: 'Plain', mode: 'declaration-create', declaration: DECL }).state;
    expect(refusal(s, 'graphEdit', { owner: { kind: 'behavior', id: 'plain' }, ops: [{ op: 'moveNodes', moves: [{ id: 'start', position: [0, 0] }] }] }).code).toBe('reference_missing');
    expect(refusal(s, 'publishBehavior', { behaviorId: 'plain', displayName: 'Plain', mode: 'declaration-update', declaration: DECL, graph: START }).code).toBe('field_unexpected');
    expect(refusal(fresh(), 'publishBehavior', { behaviorId: 'bad', displayName: 'Bad', mode: 'declaration-create', declaration: DECL, graph: { nodes: [{ id: 'n', type: 'nope', position: [0, 0] }], edges: [] } }).code).toBe('reference_missing');
  });

  it("a visual script's declaration is its variables: a changed declaration is refused, a rename keeps the graph", () => {
    const s = withScript();
    const e = refusal(s, 'publishBehavior', { behaviorId: 'vs', displayName: 'Visual', mode: 'declaration-update', declaration: { properties: [{ key: 'other', label: 'Other', type: 'number', default: 1 }] } });
    expect(e.code).toBe('behavior_declaration_mismatch');
    expect(e.reason).toBe('declared_in_graph');
    const renamed = ok(s, 'publishBehavior', { behaviorId: 'vs', displayName: 'Renamed', mode: 'declaration-update', declaration: DECL }).state;
    expect(record(renamed)?.displayName).toBe('Renamed');
    expect(record(renamed)?.graph).toEqual(record(s)?.graph);
  });
});
