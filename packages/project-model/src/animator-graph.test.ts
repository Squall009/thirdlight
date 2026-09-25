/**
 * Phase 16.2: an animator controller's layers and blend trees as graphs —
 * read (auto-layout, pairs as one wire, fixed nodes), write (states, entry,
 * transitions kept in order, layout) and their round trip.
 */
import { describe, expect, it } from 'vitest';

import { animatorGraphOf, animatorTransitionPairs, applyAnimatorGraph, parseAnimatorOwnerId } from './animator-graph';
import { canonicalAnimatorController, validateAnimatorController, type AnimatorController } from './animator';
import { applyGraphOps, validateGraphData, type GraphData, type GraphOp } from './graph';
import { GRAPH_KINDS } from './graph-kinds';
import type { ModelErrorV2 } from './errors';

const clip = (name: string) => ({ assetId: 'model-a', clip: name, duration: 1.5 });

function controller(): AnimatorController {
  return canonicalAnimatorController({
    controllerId: 'ctl',
    name: 'Walker',
    parameters: [
      { name: 'speed', type: 'float', default: 0 },
      { name: 'jump', type: 'trigger' },
    ],
    states: [
      { id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: clip('idle') }, speed: 1, loop: true },
      { id: 'run', name: 'Run', motion: { kind: 'clip', clip: clip('run') }, speed: 1.2, loop: true },
      { id: 'move', name: 'Move', motion: { kind: 'blend1d', parameter: 'speed', children: [{ threshold: 0, clip: clip('idle') }, { threshold: 4, clip: clip('run') }] }, speed: 1, loop: true },
      { id: 'hop', name: 'Hop', motion: { kind: 'clip', clip: clip('hop') }, speed: 1, loop: false },
    ],
    transitions: [
      { from: 'idle', to: 'run', conditions: [{ parameter: 'speed', op: 'greater', value: 0.2 }], duration: 0.1 },
      { from: 'run', to: 'idle', conditions: [{ parameter: 'speed', op: 'less', value: 0.2 }], duration: 0.1 },
      { from: 'idle', to: 'run', conditions: [{ parameter: 'jump', op: 'trigger' }], duration: 0 },
      { from: '*', to: 'hop', conditions: [{ parameter: 'jump', op: 'trigger' }], duration: 0.05 },
    ],
    entry: 'idle',
    events: [],
  });
}

const layer0 = { controllerId: 'ctl', layer: 0 };
function graph(c: AnimatorController, target: Parameters<typeof animatorGraphOf>[1] = layer0): { kindId: string; graph: GraphData } {
  const r = animatorGraphOf(c, target);
  expect(r).not.toBeNull();
  return r!;
}
function edit(c: AnimatorController, target: Parameters<typeof animatorGraphOf>[1], ops: GraphOp[]): ReturnType<typeof applyAnimatorGraph> {
  const g = graph(c, target);
  const applied = applyGraphOps(g.graph, ops);
  if (!applied.ok) throw new Error(applied.error.message);
  const errors: ModelErrorV2[] = [];
  validateGraphData(GRAPH_KINDS[g.kindId]!, applied.graph, '', errors);
  if (errors.length > 0) return { ok: false, message: errors[0]!.message };
  return applyAnimatorGraph(c, target, applied.graph);
}
function okEdit(c: AnimatorController, target: Parameters<typeof animatorGraphOf>[1], ops: GraphOp[]): AnimatorController {
  const r = edit(c, target, ops);
  if (!r.ok) throw new Error(r.message);
  return r.controller;
}

describe('owner ids', () => {
  it('parses the base layer, an override layer and a blend tree', () => {
    expect(parseAnimatorOwnerId('ctl')).toEqual({ controllerId: 'ctl', layer: 0 });
    expect(parseAnimatorOwnerId('ctl@2')).toEqual({ controllerId: 'ctl', layer: 2 });
    expect(parseAnimatorOwnerId('ctl#move')).toEqual({ controllerId: 'ctl', blendState: 'move' });
    expect(parseAnimatorOwnerId('Bad')).toBeNull();
    expect(parseAnimatorOwnerId('ctl@0')).toBeNull();
  });
});

describe('read', () => {
  it('a layer: fixed Entry/Any State, one node per state, one wire per state pair, a valid graph of its kind', () => {
    const { kindId, graph: g } = graph(controller());
    expect(kindId).toBe('animator');
    expect(g.nodes.map((n) => `${n.id}:${n.type}`).sort()).toEqual(['ANY:any', 'ENTRY:entry', 'hop:state', 'idle:state', 'move:blend', 'run:state']);
    // idle→run has two transitions: one wire.
    const wires = g.edges.map((e) => `${e.from.node}>${e.to.node}`).sort();
    expect(wires).toEqual(['ANY>hop', 'ENTRY>idle', 'idle>run', 'run>idle']);
    expect(animatorTransitionPairs(controller().transitions).find((p) => p.from === 'idle' && p.to === 'run')!.indices).toEqual([0, 2]);
    const errors: ModelErrorV2[] = [];
    validateGraphData(GRAPH_KINDS[kindId]!, g, '', errors);
    expect(errors).toEqual([]);
    // Node fields mirror the state (defaults are not stored).
    expect(g.nodes.find((n) => n.id === 'run')!.data).toEqual({ name: 'Run', speed: 1.2, clip: 'run', asset: 'model-a', duration: 1.5 });
    expect(g.nodes.find((n) => n.id === 'move')!.data).toEqual({ name: 'Move', parameter: 'speed' });
  });

  it('auto-layout without positions: columns by distance from the entry state, no two states on one spot', () => {
    const g = graph(controller()).graph;
    const pos = Object.fromEntries(g.nodes.map((n) => [n.id, n.position]));
    expect(pos['idle']![0]).toBeLessThan(pos['run']![0]!);
    expect(new Set(g.nodes.map((n) => pos[n.id]!.join(','))).size).toBe(g.nodes.length);
    expect(pos['ENTRY']![0]).toBeLessThan(pos['idle']![0]!);
  });

  it('a blend tree: one clip node per child wired into the fixed Blend node', () => {
    const { kindId, graph: g } = graph(controller(), { controllerId: 'ctl', blendState: 'move' });
    expect(kindId).toBe('animator-blend');
    expect(g.nodes.map((n) => n.id)).toEqual(['C0', 'C1', 'OUT']);
    expect(g.edges).toHaveLength(2);
    expect(g.nodes[1]!.data).toEqual({ threshold: 4, clip: 'run', asset: 'model-a', duration: 1.5 });
    expect(animatorGraphOf(controller(), { controllerId: 'ctl', blendState: 'idle' })).toBeNull();
  });
});

describe('write', () => {
  it('a move stores positions (layout persists); nothing else changes', () => {
    const c = okEdit(controller(), layer0, [{ op: 'moveNodes', moves: [{ id: 'run', position: [900, 40] }, { id: 'ENTRY', position: [-300, 0] }] }]);
    expect(c.states.find((s) => s.id === 'run')!.position).toEqual([900, 40]);
    expect(c.layout?.entry).toEqual([-300, 0]);
    expect(c.transitions).toEqual(controller().transitions);
    // Read back: the same positions.
    const g = graph(c).graph;
    expect(g.nodes.find((n) => n.id === 'run')!.position).toEqual([900, 40]);
    expect(g.nodes.find((n) => n.id === 'ENTRY')!.position).toEqual([-300, 0]);
  });

  it('connect adds one default transition; disconnect removes every transition of the pair; order is kept', () => {
    let c = okEdit(controller(), layer0, [{ op: 'connect', edges: [{ id: 'e1', from: { node: 'run', port: 'out' }, to: { node: 'hop', port: 'in' } }] }]);
    expect(c.transitions.at(-1)).toEqual({ from: 'run', to: 'hop', conditions: [], duration: 0.1, exitTime: 1 });
    const pair = graph(c).graph.edges.find((e) => e.from.node === 'idle' && e.to.node === 'run')!;
    c = okEdit(c, layer0, [{ op: 'disconnect', ids: [pair.id] }]);
    expect(c.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['run>idle', '*>hop', 'run>hop']);
  });

  it('the entry wire: rewiring changes the entry state; deleting the entry state falls back; removing the wire alone is refused', () => {
    let c = okEdit(controller(), layer0, [
      { op: 'disconnect', ids: ['ENTRY-WIRE'] },
      { op: 'connect', edges: [{ id: 'e2', from: { node: 'ENTRY', port: 'out' }, to: { node: 'run', port: 'in' } }] },
    ]);
    expect(c.entry).toBe('run');
    c = okEdit(c, layer0, [{ op: 'removeNodes', ids: ['run'] }]);
    expect(c.entry).toBe('idle');
    expect(c.transitions.some((t) => t.from === 'run' || t.to === 'run')).toBe(false);
    const r = edit(controller(), layer0, [{ op: 'disconnect', ids: ['ENTRY-WIRE'] }]);
    expect(r.ok).toBe(false);
    // A second Entry wire is refused by the kind (single output).
    const two = edit(controller(), layer0, [{ op: 'connect', edges: [{ id: 'e3', from: { node: 'ENTRY', port: 'out' }, to: { node: 'run', port: 'in' } }] }]);
    expect(two.ok).toBe(false);
    // The fixed nodes cannot be removed.
    expect(edit(controller(), layer0, [{ op: 'removeNodes', ids: ['ANY'] }]).ok).toBe(false);
  });

  it('adds states from nodes (new ids are state ids; a clip state without a clip plays the first clip), edits fields', () => {
    const c = okEdit(controller(), layer0, [
      { op: 'addNodes', nodes: [{ id: 'fall', type: 'state', position: [100, 400], data: { name: 'Fall', clip: 'fall', asset: 'model-a', duration: 0.8, loop: false } }, { id: 'extra', type: 'state', position: [400, 400] }] },
      { op: 'setNodeData', id: 'idle', data: { name: 'Stand', speed: 0.5, clip: 'idle', asset: 'model-a', duration: 1.5 } },
    ]);
    expect(c.states.find((s) => s.id === 'fall')).toMatchObject({ name: 'Fall', loop: false, motion: { kind: 'clip', clip: { clip: 'fall', duration: 0.8 } } });
    expect(c.states.find((s) => s.id === 'extra')).toMatchObject({ name: 'idle', motion: { kind: 'clip', clip: clip('idle') } });
    expect(c.states.find((s) => s.id === 'idle')).toMatchObject({ name: 'Stand', speed: 0.5 });
    // Upper-case ids cannot be state ids.
    expect(edit(controller(), layer0, [{ op: 'addNodes', nodes: [{ id: 'Bad', type: 'state', position: [0, 0] }] }]).ok).toBe(false);
    // An empty state belongs to override layers only.
    expect(edit(controller(), layer0, [{ op: 'addNodes', nodes: [{ id: 'nothing', type: 'empty', position: [0, 0] }] }]).ok).toBe(false);
  });

  it('groups, comments and collapsed nodes are stored in the layout and read back; reroutes are refused', () => {
    const c = okEdit(controller(), layer0, [
      { op: 'setGroups', groups: [{ id: 'g1', title: 'Ground', color: '#335577', rect: [0, 0, 400, 300] }] },
      { op: 'setComments', comments: [{ id: 'k1', text: 'see the run cycle', position: [0, -80] }] },
      { op: 'setCollapsed', ids: ['hop', 'ANY'], collapsed: true },
    ]);
    expect(c.layout).toMatchObject({ groups: [{ id: 'g1' }], comments: [{ id: 'k1' }], collapsed: ['ANY', 'hop'] });
    const g = graph(c).graph;
    expect(g.groups).toEqual([{ id: 'g1', title: 'Ground', color: '#335577', rect: [0, 0, 400, 300] }]);
    expect(g.nodes.filter((n) => n.collapsed === true).map((n) => n.id).sort()).toEqual(['ANY', 'hop']);
    const pair = g.edges.find((e) => e.from.node === 'run')!;
    expect(edit(c, layer0, [{ op: 'setReroutes', id: pair.id, reroutes: [[10, 10]] }]).ok).toBe(false);
  });

  it('an override layer: empty states allowed; the base layer untouched', () => {
    const base = controller();
    const withLayer = canonicalAnimatorController({ ...base, layers: [{ name: 'Upper', mask: [], weight: 1, states: [{ id: 'none', name: 'Empty', motion: { kind: 'empty' }, speed: 1, loop: true }], transitions: [], entry: 'none' }] });
    const t = { controllerId: 'ctl', layer: 1 };
    expect(graph(withLayer, t).kindId).toBe('animator-layer');
    const c = okEdit(withLayer, t, [
      { op: 'addNodes', nodes: [{ id: 'wave', type: 'state', position: [300, 0], data: { name: 'Wave', clip: 'wave', asset: 'model-a', duration: 1 } }] },
      { op: 'connect', edges: [{ id: 'e1', from: { node: 'none', port: 'out' }, to: { node: 'wave', port: 'in' } }] },
    ]);
    expect(c.layers![0]!.states.map((s) => s.id)).toEqual(['none', 'wave']);
    expect(c.layers![0]!.transitions).toHaveLength(1);
    expect(c.states).toEqual(withLayer.states);
  });

  it('a blend tree: clips re-sorted by threshold, a new clip node, at least two clips', () => {
    const t = { controllerId: 'ctl', blendState: 'move' };
    const c = okEdit(controller(), t, [
      { op: 'addNodes', nodes: [{ id: 'nc', type: 'clip', position: [0, 300], data: { threshold: 2, clip: 'walk', asset: 'model-a', duration: 1 } }] },
      { op: 'setNodeData', id: 'C1', data: { threshold: 6, clip: 'run', asset: 'model-a', duration: 1.5 } },
    ]);
    const m = c.states.find((s) => s.id === 'move')!.motion;
    expect(m.kind === 'blend1d' && m.children.map((k) => [k.threshold, k.clip.clip])).toEqual([[0, 'idle'], [2, 'walk'], [6, 'run']]);
    expect(edit(controller(), t, [{ op: 'removeNodes', ids: ['C0'] }]).ok).toBe(false);
  });

  it('the written controller is valid and a read → write without ops only adds the layout', () => {
    const c0 = controller();
    const r = applyAnimatorGraph(c0, layer0, graph(c0).graph);
    expect(r.ok).toBe(true);
    const c = (r as { controller: AnimatorController }).controller;
    const errors: ModelErrorV2[] = [];
    validateAnimatorController(c, '', errors);
    expect(errors).toEqual([]);
    expect(c.transitions).toEqual(c0.transitions);
    expect(c.states.map(({ position: _p, ...s }) => s)).toEqual(c0.states.map(({ position: _p, ...s }) => s));
    expect(graph(c).graph).toEqual(graph(c0).graph);
  });
});
