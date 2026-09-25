/**
 * Phase 19.0: the visual-script front end — graph → TypeScript → the one
 * behavior compiler. Execution of the compiled modules is tested in
 * tests/visual-script (it needs a module evaluator); here: generation,
 * refusals with node ids, determinism of the bytes, the code declaration
 * and the `sourceKind: 'graph'` mark, and that every starter node compiles.
 */
import { describe, expect, it } from 'vitest';

import type { GraphData, GraphNode } from '@thirdlight/project-model';

import { compileBehavior } from './compile';
import { compileBehaviorGraph, generateGraphSource } from './graph';
import { createBehaviorCompiler } from './compile';
import { M2_PINNED_MODULES } from './limits';

const VAR: GraphNode = { id: 'v', type: 'var.number', position: [0, -200], data: { name: 'amount', default: 2 } };

function graph(nodes: GraphNode[], edges: [string, string, string, string][] = []): GraphData {
  return { nodes: [VAR, ...nodes], edges: edges.map(([a, ap, b, bp], i) => ({ id: `w${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })) };
}

describe('generateGraphSource', () => {
  it('writes one src/index.ts with the banner, a code declaration from the variables and no engine imports', () => {
    const g = graph(
      [
        { id: 'start', type: 'event.start', position: [0, 0] },
        { id: 'add', type: 'api.game.add', position: [200, 0], data: { name: 'coins' } },
        { id: 'get', type: 'var.get', position: [0, 100], data: { variable: 'amount' } },
        { id: 'secret', type: 'var.boolean', position: [0, -100], data: { name: 'armed', visibility: 'private', default: true, group: 'Rules', tooltip: 'Starts armed' } },
      ],
      [
        ['start', 'then', 'add', 'in'],
        ['get', 'value', 'add', 'amount'],
      ],
    );
    const r = generateGraphSource(g);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.container.files.map((f) => f.path)).toEqual(['src/index.ts']);
    expect(r.container.requiredModules).toEqual([]);
    expect(r.container.ownedTransforms).toEqual([]);
    const text = r.container.files[0]!.text;
    expect(text.startsWith('// Thirdlight visual script v1')).toBe(true);
    expect(text).toContain('amount: property.number(2, { label: "Amount" })');
    expect(text).toContain('armed: property.private.boolean(true, { label: "Armed", group: "Rules", tooltip: "Starts armed" })');
    expect(r.declaration.properties).toEqual([
      { key: 'amount', label: 'Amount', type: 'number', default: 2 },
      { key: 'armed', label: 'Armed', type: 'boolean', default: true, visibility: 'private', group: 'Rules', tooltip: 'Starts armed' },
    ]);
    // Every line of a node's function maps back to the node.
    const lines = text.split('\n');
    const addCall = lines.findIndex((l) => l.includes('c.game?.add('));
    expect(r.lineNodes[addCall]).toBe('add');
    // Deterministic bytes: the same graph (in any order) gives the same container.
    const again = generateGraphSource({ nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() });
    expect(again.ok && Array.from(again.containerBytes)).toEqual(Array.from(r.containerBytes));
  });

  it('refuses a graph the kind refuses, and semantic errors, naming the nodes', () => {
    const bad = generateGraphSource(graph([{ id: 'x', type: 'no.such', position: [0, 0] }]));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems[0]).toMatchObject({ severity: 'error', nodeId: 'x' });
    const unnamed = generateGraphSource(graph([{ id: 'start', type: 'event.start', position: [0, 0] }, { id: 'emit', type: 'api.signals.emit', position: [200, 0] }], [['start', 'then', 'emit', 'in']]));
    expect(unnamed.ok).toBe(false);
    if (!unnamed.ok) expect(unnamed.problems).toEqual([expect.objectContaining({ nodeId: 'emit', message: expect.stringContaining('signal') })]);
    const noVar = generateGraphSource({ nodes: [{ id: 'start', type: 'event.start', position: [0, 0] }], edges: [] });
    // Phase 19.1: no variable is fine — the script declares no property.
    expect(noVar.ok && noVar.declaration).toEqual({ properties: [] });
  });
});

describe('compileBehaviorGraph (the same compiler as TypeScript sources)', () => {
  const compiler = createBehaviorCompiler();

  it('compiles the 19.0 starter nodes in one graph; the manifest says sourceKind graph and the declaration comes from the code', async () => {
    // One graph using every 19.0 starter node type, wired validly (the whole
    // 19.1 catalogue, one script per node type: tests/visual-script/catalogue.test.ts).
    const nodes: GraphNode[] = [
      { id: 'start', type: 'event.start', position: [0, 0] },
      { id: 'step', type: 'event.step', position: [0, 300] },
      { id: 'seq', type: 'flow.sequence', position: [200, 0] },
      { id: 'branch', type: 'flow.branch', position: [400, 0] },
      { id: 'loop', type: 'flow.for', position: [400, 200], data: { first: 1, last: 3 } },
      { id: 'setn', type: 'var.set', position: [600, 200], data: { variable: 'amount' } },
      { id: 'getn', type: 'var.get', position: [200, 400], data: { variable: 'amount' } },
      { id: 'vb', type: 'var.boolean', position: [0, -100], data: { name: 'flag' } },
      { id: 'getb', type: 'var.get', position: [200, 500], data: { variable: 'flag' } },
      { id: 'setb', type: 'var.set', position: [600, 0], data: { variable: 'flag' } },
      { id: 'vs', type: 'var.string', position: [0, -50], data: { name: 'label', default: 'hi' } },
      { id: 'gets', type: 'var.get', position: [200, 600], data: { variable: 'label' } },
      { id: 'sets', type: 'var.set', position: [800, 0], data: { variable: 'label' } },
      { id: 'add', type: 'math.add', position: [300, 400] },
      { id: 'sub', type: 'math.subtract', position: [300, 450] },
      { id: 'mul', type: 'math.multiply', position: [300, 500] },
      { id: 'div', type: 'math.divide', position: [300, 550] },
      { id: 'cmp', type: 'math.compare', position: [300, 600], data: { op: '>=' } },
      { id: 'and', type: 'logic.and', position: [300, 650] },
      { id: 'or', type: 'logic.or', position: [300, 700] },
      { id: 'not', type: 'logic.not', position: [300, 750] },
      { id: 'log', type: 'debug.log', position: [800, 200], data: { level: 'warn' } },
      { id: 'gadd', type: 'api.game.add', position: [800, 300], data: { name: 'score' } },
      { id: 'gget', type: 'api.game.counter', position: [300, 800], data: { name: 'score' } },
      { id: 'emit', type: 'api.signals.emit', position: [1000, 0], data: { name: 'ping' } },
      { id: 'on', type: 'api.signals.on', position: [300, 850], data: { name: 'ping' } },
    ];
    const edges: [string, string, string, string][] = [
      ['start', 'then', 'seq', 'in'],
      ['seq', 'then1', 'branch', 'in'],
      ['seq', 'then2', 'loop', 'in'],
      ['branch', 'true', 'setb', 'in'],
      ['setb', 'then', 'sets', 'in'],
      ['sets', 'then', 'emit', 'in'],
      ['loop', 'body', 'setn', 'in'],
      ['loop', 'completed', 'log', 'in'],
      ['loop', 'index', 'add', 'a'],
      ['getn', 'value', 'add', 'b'],
      ['add', 'result', 'setn', 'value'],
      ['getn', 'value', 'sub', 'a'],
      ['sub', 'result', 'mul', 'a'],
      ['mul', 'result', 'div', 'a'],
      ['div', 'result', 'cmp', 'a'],
      ['gget', 'value', 'cmp', 'b'],
      ['cmp', 'result', 'and', 'a'],
      ['on', 'value', 'and', 'b'],
      ['and', 'result', 'or', 'a'],
      ['getb', 'value', 'or', 'b'],
      ['or', 'result', 'not', 'value'],
      ['not', 'result', 'branch', 'condition'],
      ['gets', 'value', 'log', 'message'],
      ['step', 'then', 'gadd', 'in'],
      ['step', 'step', 'gadd', 'amount'],
      ['getb', 'value', 'setb', 'value'],
      ['cmp', 'result', 'sets', 'value'],
    ];
    const g = graph(nodes, edges);
    const r = await compileBehaviorGraph(compiler, { behaviorId: 'all-nodes', graph: g, limits: { timeoutMs: 30_000 } });
    expect(r.ok, JSON.stringify(r.ok ? null : r.failure)).toBe(true);
    if (!r.ok) return;
    expect(r.result.manifest.sourceKind).toBe('graph');
    expect(r.result.manifest.declaredInCode).toBe(true);
    expect(r.result.manifest.declaration.properties.map((p) => p.key)).toEqual(['amount', 'flag', 'label']);
    const out = new TextDecoder().decode(r.result.outputBytes);
    expect(out).toContain('c.game?.add(');
    expect(out).toContain('c.signals?.on(');
    expect(out).not.toContain('property.');
  });

  it("an unwired Set variable writes its Value text read as the variable's type", async () => {
    const g = graph([{ id: 'start', type: 'event.start', position: [0, 0] }, { id: 'set', type: 'var.set', position: [200, 0], data: { variable: 'amount', value: '7.5' } }], [['start', 'then', 'set', 'in']]);
    const r = generateGraphSource(g);
    expect(r.ok && r.container.files[0]!.text).toContain('const a0 = 7.5;');
    const bad = generateGraphSource(graph([{ id: 'start', type: 'event.start', position: [0, 0] }, { id: 'set', type: 'var.set', position: [200, 0], data: { variable: 'amount', value: 'seven' } }], [['start', 'then', 'set', 'in']]));
    expect(!bad.ok && bad.problems[0]).toMatchObject({ nodeId: 'set', message: expect.stringContaining('not a number') });
  });

  it('a TypeScript source that is not generated has no sourceKind', async () => {
    const text = 'export default { step() {} };\n';
    const bytes = new TextEncoder().encode(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: [{ path: 'src/index.ts', text }] }, null, 2)}\n`);
    const r = await compileBehavior({ behaviorId: 'ts', declaration: { properties: [{ key: 'a', label: 'A', type: 'number', default: 0 }] }, containerBytes: bytes, pinnedModules: M2_PINNED_MODULES });
    expect(r.ok && r.manifest.sourceKind).toBe(undefined);
  });

  it('text that trips the output scan is refused like in TypeScript (a log message with a URL)', async () => {
    const g = graph([{ id: 'start', type: 'event.start', position: [0, 0] }, { id: 'log', type: 'debug.log', position: [200, 0], data: { message: 'see https://example.org' } }], [['start', 'then', 'log', 'in']]);
    const r = await compileBehaviorGraph(compiler, { behaviorId: 'scan', graph: g });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.code).toBe('behavior_output_forbidden_content');
  });
});
