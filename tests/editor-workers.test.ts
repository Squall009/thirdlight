/**
 * The editor worker — its protocol, the page-side client with
 * its inline fallbacks, and identical results on and off the worker.
 *
 * The worker side is the real `createWorkerHost` over the real job table,
 * wired to the page-side client through an in-process channel that
 * structured-clones every message and moves the transferred buffers (as a
 * real worker boundary does), so a job that returned a detached or shared
 * buffer, or a message that cannot be cloned, fails here too. The browser
 * bundle and the PNG encoder are covered by tests/e2e/editor-workers.e2e.ts
 * in Chromium.
 */
import { describe, expect, it } from 'vitest';

import { GRAPH_KINDS, type GraphDocument, type GraphKindDef, type MaterialDef } from '../packages/project-model/src/index';
import { diagnoseGraph, portsResolver } from '../packages/editor/src/graph/model';
import { graphsPortContext, materialPortContext } from '../packages/editor/src/session/material-graph';
import { scatterTransforms, type ScatterOptions } from '../packages/editor/src/session/instances';
import { EditorWorkers, workersRequested, type WorkerLike } from '../packages/editor/src/workers/editor-workers';
import { graphIssuesOf, materialIssuesOf } from '../packages/editor/src/workers/problems';
import type { FromWorker, ToWorker } from '../packages/editor/src/workers/protocol';
import { createWorkerHost } from '../packages/editor/src/workers/worker-host';
import { materialGraphProblems, type MaterialFunctionLike } from '../packages/three-adapter/src/index';

const KINDS = GRAPH_KINDS as unknown as Record<string, GraphKindDef>;

/** A worker made of the real host behind a structured-clone boundary (asynchronous, like postMessage). */
function channelWorker(o: { failLoad?: boolean; dieOnRun?: boolean } = {}): WorkerLike & { terminated: boolean; posted: ToWorker[] } {
  const listeners: { message: ((ev: MessageEvent) => void)[]; error: ((ev: Event) => void)[] } = { message: [], error: [] };
  const toPage = (m: FromWorker, transfer: Transferable[]): void => {
    const copy = structuredClone(m, { transfer: transfer as Transferable[] });
    setTimeout(() => {
      if (!w.terminated) for (const l of listeners.message) l({ data: copy } as MessageEvent);
    }, 0);
  };
  const host = createWorkerHost(toPage);
  const w = {
    terminated: false,
    posted: [] as ToWorker[],
    postMessage(message: ToWorker, transfer: Transferable[]): void {
      w.posted.push(message);
      const copy = structuredClone(message, { transfer });
      if (o.dieOnRun === true && message.type === 'run') {
        setTimeout(() => listeners.error.forEach((l) => l(new Event('error'))), 0);
        return;
      }
      setTimeout(() => host.receive(copy), 0);
    },
    addEventListener(type: 'message' | 'error', l: (ev: never) => void): void {
      (listeners[type] as ((ev: never) => void)[]).push(l);
    },
    terminate(): void {
      w.terminated = true;
    },
  };
  setTimeout(() => {
    if (o.failLoad === true) listeners.error.forEach((l) => l(new Event('error')));
    else toPage({ type: 'ready' }, []);
  }, 0);
  return w as WorkerLike & { terminated: boolean; posted: ToWorker[] };
}

const SCATTER: ScatterOptions = { count: 5000, width: 40, depth: 30, scaleMin: 0.5, scaleMax: 2, randomYaw: true, seed: 11 };

describe('editor worker protocol and fallbacks', () => {
  it('a scatter in the worker is the inline scatter, bit for bit (the buffer comes back transferred)', async () => {
    const workers = new EditorWorkers({ enabled: true, create: () => channelWorker() });
    const out = await workers.run('scatter', () => ({ input: SCATTER }), { inline: () => scatterTransforms(SCATTER) });
    expect(workers.lastMode.get('scatter')).toBe('worker');
    const inline = scatterTransforms(SCATTER);
    expect(out).toBeInstanceOf(Float32Array);
    expect(Buffer.from(out.buffer).equals(Buffer.from(inline.buffer))).toBe(true);
    workers.dispose();
  });

  it('runs inline when workers are off, cannot be created, or the script does not load', async () => {
    let created = 0;
    const off = new EditorWorkers({ enabled: false, create: () => (created++, channelWorker()) });
    expect(await off.run('scatter', () => ({ input: SCATTER }), { inline: () => scatterTransforms(SCATTER) })).toEqual(scatterTransforms(SCATTER));
    expect(off.lastMode.get('scatter')).toBe('inline');
    expect(created).toBe(0);

    const throwing = new EditorWorkers({ enabled: true, create: () => { throw new Error('no Worker here'); } });
    expect(await throwing.run('scatter', () => ({ input: SCATTER }), { inline: () => scatterTransforms(SCATTER) })).toEqual(scatterTransforms(SCATTER));
    expect(throwing.lastMode.get('scatter')).toBe('inline');

    let made = 0;
    const failing = new EditorWorkers({ enabled: true, create: () => (made++, channelWorker({ failLoad: true })) });
    expect(await failing.run('scatter', () => ({ input: SCATTER }), { inline: () => scatterTransforms(SCATTER) })).toEqual(scatterTransforms(SCATTER));
    expect(failing.lastMode.get('scatter')).toBe('inline');
    // A worker that never loaded is not tried again: later jobs run inline at once.
    await failing.run('scatter', () => ({ input: SCATTER }), { inline: () => scatterTransforms(SCATTER) });
    expect(made).toBe(1);
    expect(failing.lastMode.get('scatter')).toBe('inline');
  });

  it('a worker that dies during a job: the job runs inline (its message was a copy)', async () => {
    const workers = new EditorWorkers({ enabled: true, create: () => channelWorker({ dieOnRun: true }) });
    const out = await workers.run('scatter', () => ({ input: SCATTER }), { inline: () => scatterTransforms(SCATTER) });
    expect(out).toEqual(scatterTransforms(SCATTER));
    expect(workers.lastMode.get('scatter')).toBe('inline');
  });

  it('a job that fails in the worker rejects with its message (no silent inline rerun)', async () => {
    const workers = new EditorWorkers({ enabled: true, create: () => channelWorker() });
    const bad = { ...SCATTER, count: 0 };
    await expect(workers.run('scatter', () => ({ input: bad }), { inline: () => scatterTransforms(bad) })).rejects.toThrow(/count must be/);
    workers.dispose();
  });

  it('progress reaches the caller and an abort sends a cancel for the job', async () => {
    const listeners: ((ev: MessageEvent) => void)[] = [];
    const posted: ToWorker[] = [];
    const fake: WorkerLike = {
      postMessage(m) {
        posted.push(m);
        if (m.type === 'run') {
          setTimeout(() => listeners.forEach((l) => l({ data: { type: 'progress', id: m.id, done: 1, total: 4 } } as MessageEvent)), 0);
          setTimeout(() => listeners.forEach((l) => l({ data: { type: 'done', id: m.id, output: new Float32Array(10) } } as MessageEvent)), 5);
        }
      },
      addEventListener(type: string, l: (ev: never) => void) {
        if (type === 'message') listeners.push(l as (ev: MessageEvent) => void);
      },
      terminate() {},
    };
    setTimeout(() => listeners.forEach((l) => l({ data: { type: 'ready' } } as MessageEvent)), 0);
    const workers = new EditorWorkers({ enabled: true, create: () => fake });
    const abort = new AbortController();
    const progress: string[] = [];
    const done = workers.run('scatter', () => ({ input: SCATTER }), {
      inline: () => scatterTransforms(SCATTER),
      signal: abort.signal,
      onProgress: (d, t) => {
        progress.push(`${d}/${t}`);
        abort.abort();
      },
    });
    await done;
    expect(progress).toEqual(['1/4']);
    expect(posted.map((m) => m.type)).toEqual(['run', 'cancel']);
  });

  it('the ?workers=off flag', () => {
    expect(workersRequested('')).toBe(true);
    expect(workersRequested('?project=a&renderer=webgl2')).toBe(true);
    expect(workersRequested('?workers=off')).toBe(false);
    expect(workersRequested('?project=a&workers=off')).toBe(false);
  });
});

// ---- the Problems tab's diagnostics ------------------------------------------------------

/** The straightforward main-thread computation (an App.tsx useMemo), kept here as the reference. */
function graphIssuesBefore(graphs: readonly GraphDocument[], kinds: Record<string, GraphKindDef>): unknown[] {
  const ctx = graphsPortContext(graphs, kinds);
  return graphs.flatMap((g) => {
    const k = kinds[g.kind];
    if (k === undefined) return [];
    return diagnoseGraph(k, g.graph, portsResolver(k, g.graph, ctx)).map((p, i) => {
      const node = p.nodeId !== undefined ? g.graph.nodes.find((n) => n.id === p.nodeId) : undefined;
      return { key: `${g.graphId}:${i}`, graphId: g.graphId, graphName: g.name, ...(p.nodeId !== undefined ? { nodeId: p.nodeId } : {}), nodeLabel: node !== undefined ? (k.nodes.find((d) => d.type === node.type)?.label ?? node.type) : null, severity: p.severity, message: p.message };
    });
  });
}

function materialIssuesBefore(materials: readonly MaterialDef[], graphs: readonly GraphDocument[], kinds: Record<string, GraphKindDef>, textureIds: readonly string[]): unknown[] {
  const kind = kinds['material']!;
  const ids = new Set(textureIds);
  const functions = graphs.filter((g) => g.kind === 'material-function') as unknown as MaterialFunctionLike[];
  return materials.flatMap((m) => {
    if (m.graph === undefined) return [];
    const g = m.graph;
    const rules = diagnoseGraph(kind, g, portsResolver(kind, g, materialPortContext(m.parameters, graphs, kinds)));
    const compiled = materialGraphProblems({ graph: g, ...(m.parameters !== undefined ? { parameters: m.parameters } : {}) }, functions, ids);
    return [...rules, ...compiled].map((p, i) => {
      const node = p.nodeId !== undefined ? g.nodes.find((n) => n.id === p.nodeId) : undefined;
      return { key: `material:${m.materialId}:${i}`, graphId: m.materialId, graphName: m.name, ...(p.nodeId !== undefined ? { nodeId: p.nodeId } : {}), nodeLabel: node !== undefined ? (kind.nodes.find((d) => d.type === node.type)?.label ?? node.type) : null, severity: p.severity, message: p.message, materialId: m.materialId };
    });
  });
}

/** A test-kind graph of `n` label nodes in a chain (every one warned: it reaches no output), plus broken bits. */
function bigGraph(n: number): GraphDocument {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, type: 'label', position: [(i % 50) * 220, Math.floor(i / 50) * 120] as [number, number] }));
  const edges = nodes.slice(1).map((_, i) => ({ id: `e${i + 1}`, from: { node: `n${i}`, port: 'out' }, to: { node: `n${i + 1}`, port: 'in' } }));
  return { graphId: 'big', kind: 'test', name: 'Big', graph: { nodes: [...nodes, { id: 'sum', type: 'add', position: [0, -200] }], edges } };
}

const MATERIALS: MaterialDef[] = [
  {
    materialId: 'mat-graph',
    name: 'Graph material',
    shader: 'standard',
    parameters: [{ key: 'tint', type: 'color', default: '#ffffff' }],
    graph: {
      nodes: [
        { id: 'out', type: 'pbr', position: [600, 0] },
        { id: 'p', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
        { id: 'ghost', type: 'parameter', position: [0, 100], data: { key: 'nope' } },
        { id: 'tex', type: 'sampleTexture', position: [0, 200], data: { texture: 'tex-missing' } },
        { id: 'call', type: 'call', position: [300, 300], data: { function: 'absent' } },
      ],
      edges: [{ id: 'e1', from: { node: 'p', port: 'value' }, to: { node: 'out', port: 'color' } }],
    },
  } as unknown as MaterialDef,
  { materialId: 'mat-plain', name: 'Plain', shader: 'standard' } as unknown as MaterialDef,
];

describe('graph diagnostics on and off the worker', () => {
  it('standalone graphs: worker = inline = the main-thread computation (2000-node graph)', async () => {
    const graphs = [bigGraph(2000), { graphId: 'empty', kind: 'test', name: 'Empty', graph: { nodes: [], edges: [] } } as GraphDocument];
    const before = graphIssuesBefore(graphs, KINDS);
    expect(before.length).toBeGreaterThan(2000);
    const inline = graphIssuesOf(graphs, KINDS);
    expect(inline).toEqual(before);
    const workers = new EditorWorkers({ enabled: true, create: () => channelWorker() });
    const off = await workers.run('graphIssues', () => ({ input: { graphs, kinds: KINDS } }), { inline: () => graphIssuesOf(graphs, KINDS) });
    expect(workers.lastMode.get('graphIssues')).toBe('worker');
    expect(off).toEqual(before);
    workers.dispose();
  });

  it('graph materials (rules and the compiler): worker = inline = the main-thread computation', async () => {
    const graphs: GraphDocument[] = [];
    const textureIds = ['tex-ok'];
    const before = materialIssuesBefore(MATERIALS, graphs, KINDS, textureIds);
    expect(before.length).toBeGreaterThan(0);
    expect(materialIssuesOf(MATERIALS, graphs, KINDS, textureIds)).toEqual(before);
    const workers = new EditorWorkers({ enabled: true, create: () => channelWorker() });
    const off = await workers.run('materialIssues', () => ({ input: { materials: MATERIALS, graphs, kinds: KINDS, textureIds } }), { inline: () => materialIssuesOf(MATERIALS, graphs, KINDS, textureIds) });
    expect(workers.lastMode.get('materialIssues')).toBe('worker');
    expect(off).toEqual(before);
    workers.dispose();
  });
});

