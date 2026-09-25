/**
 * Phase 19.0: visual scripts in the model — the `behavior` graph kind's
 * wiring rules (generic validator over the kind's data), the record's
 * `graph` and `source.kind` (validation and canonical form: the
 * canonicalizer must keep both), and the compile checks and declaration a
 * graph's variables make.
 */
import { describe, expect, it } from 'vitest';

import { behaviorGraphContext, behaviorGraphDeclaration, BEHAVIOR_GRAPH_KIND, checkBehaviorGraph } from './behavior-graph';
import { canonicalContentV3, validateContentV3, validateContentV4 } from './content';
import { GRAPH_KINDS } from './graph-kinds';
import { resolveGraphPorts, validateGraphData, type GraphData, type GraphNode } from './graph';
import type { ModelErrorV2 } from './errors';

const n = (id: string, type: string, data?: GraphNode['data'], position: [number, number] = [0, 0]): GraphNode => ({ id, type, position, ...(data !== undefined ? { data } : {}) });
const w = (id: string, a: string, ap: string, b: string, bp: string) => ({ id, from: { node: a, port: ap }, to: { node: b, port: bp } });
function errors(g: GraphData): ModelErrorV2[] {
  const out: ModelErrorV2[] = [];
  validateGraphData(BEHAVIOR_GRAPH_KIND, g, '', out);
  return out;
}

describe('the behavior graph kind', () => {
  it('is registered, owned by behaviors, with exec ports distinct from data ports', () => {
    expect(GRAPH_KINDS['behavior']).toBe(BEHAVIOR_GRAPH_KIND);
    expect(BEHAVIOR_GRAPH_KIND.owner).toBe('behavior');
    expect(BEHAVIOR_GRAPH_KIND.allowCycles).toBe(false);
    expect(BEHAVIOR_GRAPH_KIND.conversions.some((c) => c.from === 'exec' || c.to === 'exec')).toBe(false);
    // Every exec output takes one wire; every exec input takes many.
    for (const d of BEHAVIOR_GRAPH_KIND.nodes) {
      for (const p of d.outputs) if (p.type === 'exec') expect(p.single, `${d.type}.${p.id}`).toBe(true);
      for (const p of d.inputs) if (p.type === 'exec') expect(p.multi, `${d.type}.${p.id}`).toBe(true);
    }
  });

  it('validation: types, one exec wire per output (a Sequence has several outputs), no data cycles, no exec loops', () => {
    const base = [n('s', 'event.start'), n('a', 'debug.log'), n('b', 'debug.log'), n('q', 'flow.sequence'), n('x', 'math.add'), n('y', 'math.multiply'), n('f', 'flow.for')];
    expect(errors({ nodes: base, edges: [w('1', 's', 'then', 'q', 'in'), w('2', 'q', 'then1', 'a', 'in'), w('3', 'q', 'then2', 'b', 'in'), w('4', 'a', 'then', 'b', 'in')] })).toEqual([]);
    const codes = (edges: ReturnType<typeof w>[]): string[] => errors({ nodes: base, edges }).map((e) => e.code);
    expect(codes([w('1', 's', 'then', 'a', 'message')])).toEqual(['field_value']);
    expect(codes([w('1', 'x', 'result', 'a', 'in')])).toEqual(['field_value']);
    expect(codes([w('1', 's', 'then', 'a', 'in'), w('2', 's', 'then', 'b', 'in')])).toEqual(['field_value']);
    expect(codes([w('1', 'x', 'result', 'y', 'a'), w('2', 'y', 'result', 'x', 'a')])).toEqual(['hierarchy_cycle']);
    expect(codes([w('1', 'a', 'then', 'b', 'in'), w('2', 'b', 'then', 'a', 'in')])).toEqual(['hierarchy_cycle']);
    // A For loop repeats its body without a wire back into itself.
    expect(codes([w('1', 's', 'then', 'f', 'in'), w('2', 'f', 'body', 'a', 'in'), w('3', 'f', 'index', 'a', 'message'), w('4', 'f', 'completed', 'b', 'in')])).toEqual([]);
    expect(codes([w('1', 'f', 'body', 'a', 'in'), w('2', 'a', 'then', 'f', 'in')])).toEqual(['hierarchy_cycle']);
    // Unknown node kinds and fields are refused.
    expect(errors({ nodes: [n('z', 'no.such')], edges: [] }).map((e) => e.code)).toEqual(['reference_missing']);
    expect(errors({ nodes: [n('z', 'math.compare', { op: '~' })], edges: [] }).map((e) => e.code)).toEqual(['field_value']);
  });

  it('compile checks: variable names and uniqueness, Get/Set naming a variable, Set values, required names; unreached flow is a warning', () => {
    const v = n('v', 'var.number', { name: 'count' });
    // Phase 19.1: a script without variables is fine (a behavior may declare no property).
    expect(checkBehaviorGraph({ nodes: [n('s', 'event.start')], edges: [] })).toEqual([]);
    const p = checkBehaviorGraph({
      nodes: [v, n('v2', 'var.boolean', { name: 'count' }), n('v3', 'var.string', { name: 'Bad Name' }), n('g', 'var.get'), n('g2', 'var.get', { variable: 'ghost' }), n('g3', 'var.set', { variable: 'count', value: 'lots' }), n('e', 'api.signals.emit')],
      edges: [],
    });
    expect(p.filter((x) => x.severity === 'error').map((x) => x.nodeId)).toEqual(['v2', 'v3', 'g', 'g2', 'g3', 'e']);
    expect(p.find((x) => x.nodeId === 'g3')?.message).toContain('"lots" is not a number');
    expect(p.filter((x) => x.severity === 'warning').map((x) => x.nodeId)).toEqual(['g3', 'e']);
    // A wired name is fine even when the inline one is empty; a Set with a number text is fine.
    expect(checkBehaviorGraph({ nodes: [v, n('s', 'event.start'), n('e', 'api.signals.emit'), n('gs', 'var.get', { variable: 'count' }), n('set', 'var.set', { variable: 'count', value: '2.5' })], edges: [w('1', 's', 'then', 'e', 'in'), w('2', 'gs', 'value', 'e', 'name'), w('3', 'e', 'then', 'set', 'in')] })).toEqual([]);
  });

  it("Get/Set variable ports take the variable's type (data-dependent ports through the graph's own context)", () => {
    const vars = [n('vn', 'var.number', { name: 'count' }), n('vb', 'var.boolean', { name: 'armed' })];
    const valid = (g: GraphData): string[] => {
      const out: ModelErrorV2[] = [];
      validateGraphData(BEHAVIOR_GRAPH_KIND, g, '', out, behaviorGraphContext(g));
      return out.map((e) => e.code);
    };
    const ports = resolveGraphPorts(BEHAVIOR_GRAPH_KIND, { nodes: [...vars, n('g', 'var.get', { variable: 'armed' }), n('s', 'var.set', { variable: 'count' }), n('x', 'var.get', { variable: 'ghost' })], edges: [] }, behaviorGraphContext({ nodes: vars }));
    expect(ports.get('g')?.outputs[0]?.type).toBe('boolean');
    expect(ports.get('s')?.inputs.map((p) => p.type)).toEqual(['exec', 'number']);
    expect(ports.get('x')?.outputs[0]?.type).toBe('any');
    // A boolean variable feeds a Branch condition; a number one cannot (no number → boolean conversion).
    const branch = n('b', 'flow.branch');
    expect(valid({ nodes: [...vars, branch, n('g', 'var.get', { variable: 'armed' })], edges: [w('1', 'g', 'value', 'b', 'condition')] })).toEqual([]);
    expect(valid({ nodes: [...vars, branch, n('g', 'var.get', { variable: 'count' })], edges: [w('1', 'g', 'value', 'b', 'condition')] })).toEqual(['field_value']);
    // A Get naming no variable is "any": its wires survive a rename or a delete (the compile check reports it).
    expect(valid({ nodes: [vars[1]!, branch, n('g', 'var.get', { variable: 'count' })], edges: [w('1', 'g', 'value', 'b', 'condition')] })).toEqual([]);
    expect(checkBehaviorGraph({ nodes: [vars[1]!, branch, n('g', 'var.get', { variable: 'count' })], edges: [w('1', 'g', 'value', 'b', 'condition')] }).filter((x) => x.severity === 'error').map((x) => x.nodeId)).toEqual(['g']);
  });

  it('the declaration: one property per variable, top to bottom; private and texts carried over', () => {
    const d = behaviorGraphDeclaration({
      nodes: [n('b', 'var.string', { name: 'title', default: 'Hi', tooltip: 'Shown' }, [0, 50]), n('a', 'var.number', { name: 'jump_height', default: 2, group: 'Moves' }, [0, 10]), n('c', 'var.boolean', { name: 'armed', visibility: 'private', label: 'Is armed' }, [0, 90])],
      edges: [],
    });
    expect(d.properties).toEqual([
      { key: 'jump_height', label: 'Jump height', type: 'number', default: 2, group: 'Moves' },
      { key: 'title', label: 'Title', type: 'string', default: 'Hi', tooltip: 'Shown' },
      { key: 'armed', label: 'Is armed', type: 'boolean', default: false, visibility: 'private' },
    ]);
  });
});

function content(behavior: Record<string, unknown>): Record<string, unknown> {
  return {
    assets: [],
    prefabs: [],
    behaviors: [{ behaviorId: 'vs', displayName: 'Visual', declaration: { properties: [{ key: 'value', label: 'Value', type: 'number', default: 0 }] }, source: null, publishedRevision: 1, ...behavior }],
    settings: {},
    behaviorTrust: { entries: [] },
    game: null,
    scenes: [{ sceneId: 'main', name: 'Main' }],
    startScenes: ['main'],
  };
}
const GRAPH = { nodes: [{ position: [0, 0], type: 'event.start', id: 'start' }, { id: 'a', type: 'var.number', position: [0, -100], data: { name: 'value' } }], edges: [] };
const SOURCE = { sourceDigest: 'a'.repeat(64), sourceByteLength: 10, entryPath: 'src/index.ts', fileCount: 1, manifestDigest: 'b'.repeat(64), outputDigest: 'c'.repeat(64), outputByteLength: 10, requiredModules: [], publishedRevision: 1 };

describe('the behavior record: graph and source.kind', () => {
  it('a v4 record keeps its graph and source kind through the canonical form (canonical field order)', () => {
    const r = validateContentV4(content({ graph: GRAPH, source: { ...SOURCE, declaredInCode: true, kind: 'graph' } }));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const b = canonicalContentV3(r.normalized as never).behaviors[0]!;
    expect(b.graph).toEqual({ nodes: [{ id: 'a', type: 'var.number', position: [0, -100], data: { name: 'value' } }, { id: 'start', type: 'event.start', position: [0, 0] }], edges: [] });
    expect(Object.keys(b.graph!.nodes[1]!)).toEqual(['id', 'type', 'position']);
    expect(b.source?.kind).toBe('graph');
    // A record without them stays as it was (no new keys).
    const plain = validateContentV4(content({}));
    if (!plain.ok) throw new Error('plain');
    expect(Object.keys(canonicalContentV3(plain.normalized as never).behaviors[0]!)).toEqual(['behaviorId', 'displayName', 'declaration', 'source', 'publishedRevision']);
  });

  it('refuses a graph the kind refuses, a bad source kind, and a graph in a v3 project', () => {
    const paths = (c: Record<string, unknown>, v: 3 | 4 = 4): string[] => {
      const r = v === 4 ? validateContentV4(c) : validateContentV3(Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'scenes' && k !== 'startScenes')));
      return r.ok ? [] : r.errors.map((e) => e.path ?? '');
    };
    expect(paths(content({ graph: { nodes: [{ id: 'x', type: 'nope', position: [0, 0] }], edges: [] } }))).toEqual(['/behaviors/0/graph/nodes/0/type']);
    expect(paths(content({ source: { ...SOURCE, kind: 'typescript' } }))).toEqual(['/behaviors/0/source/kind']);
    expect(paths(content({ graph: GRAPH }), 3)).toEqual(['/behaviors/0/graph']);
  });
});
