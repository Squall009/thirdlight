/**
 * Phase 22.1: the editor worker — its protocol, the page-side client with
 * its inline fallbacks, and identical results on and off the worker.
 *
 * The worker side is the real `createWorkerHost` over the real job table,
 * wired to the page-side client through an in-process channel that
 * structured-clones every message and moves the transferred buffers (as a
 * real worker boundary does), so a job that returned a detached or shared
 * buffer, or a message that cannot be cloned, fails here too. The browser
 * bundle, the OffscreenCanvas bake and the PNG encoder are covered by
 * tests/e2e/editor-workers.e2e.ts in Chromium.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { GRAPH_KINDS, type GraphDocument, type GraphKindDef, type MaterialDef } from '../packages/project-model/src/index';
import { diagnoseGraph, portsResolver } from '../packages/editor/src/graph/model';
import { graphsPortContext, materialPortContext } from '../packages/editor/src/session/material-graph';
import { scatterTransforms, type ScatterOptions } from '../packages/editor/src/session/instances';
import { packBakeInput, unpackBakeInput } from '../packages/editor/src/workers/bake-transfer';
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

  it('the gpu lane uses a worker per job and ends it afterwards; the cpu lane keeps one', async () => {
    const made: ReturnType<typeof channelWorker>[] = [];
    const workers = new EditorWorkers({ enabled: true, create: () => { const w = channelWorker(); made.push(w); return w; } });
    await workers.run('scatter', () => ({ input: SCATTER }), { lane: 'gpu', inline: () => scatterTransforms(SCATTER) });
    expect(made).toHaveLength(1);
    expect(made[0]!.terminated).toBe(true);
    await workers.run('scatter', () => ({ input: SCATTER }), { inline: () => scatterTransforms(SCATTER) });
    await workers.run('scatter', () => ({ input: SCATTER }), { inline: () => scatterTransforms(SCATTER) });
    expect(made).toHaveLength(2);
    expect(made[1]!.terminated).toBe(false);
    workers.dispose();
    expect(made[1]!.terminated).toBe(true);
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

/** The editor's pre-22.1 computation (App.tsx useMemo), kept here as the reference. */
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
  it('standalone graphs: worker = inline = the pre-22.1 computation (2000-node graph)', async () => {
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

  it('graph materials (rules and the compiler): worker = inline = the pre-22.1 computation', async () => {
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

// ---- the bake input across the boundary --------------------------------------------------

describe('bake input transfer', () => {
  it('geometries go once, keep their arrays, types, normalized flags and draw range; matrices exact; the source is not detached', () => {
    const box = new THREE.BoxGeometry(1, 2, 3);
    box.setAttribute('uv1', box.getAttribute('uv')!.clone());
    // An interleaved, normalized UV1 on a second geometry (a quantized GLB).
    const plane = new THREE.PlaneGeometry(4, 4);
    const count = plane.getAttribute('position').count;
    const inter = new THREE.InterleavedBuffer(new Int16Array(count * 4), 4);
    for (let i = 0; i < count; i++) inter.array.set([i * 100, -i * 50, 7, 9], i * 4);
    plane.setAttribute('uv1', new THREE.InterleavedBufferAttribute(inter, 2, 0, true));
    plane.setDrawRange(0, 3);
    const m1 = new THREE.Matrix4().makeRotationY(0.3).setPosition(1.25, -2, 3.5);
    const m2 = new THREE.Matrix4().makeScale(2, 1, 0.5);
    const input = {
      atlases: [{ width: 256, height: 128 }],
      targets: [
        { entityId: 'a', atlas: 0, scaleOffset: [0.5, 0.5, 0, 0] as [number, number, number, number], meshes: [{ geometry: box, matrixWorld: m1 }, { geometry: box, matrixWorld: m2 }] },
        { entityId: 'b', atlas: 0, scaleOffset: [0.25, 0.5, 0.5, 0] as [number, number, number, number], meshes: [{ geometry: plane, matrixWorld: m2 }] },
      ],
      occluders: [{ geometry: box, matrixWorld: m2 }],
      lights: [{ type: 'directional' as const, color: '#ffffff', intensity: 1.2, direction: [0.4, -1, -0.3] as [number, number, number] }],
      samples: 16,
      range: 4,
      padding: 2,
      renderer: 'webgl2' as const,
    };
    const { input: packed, transfer } = packBakeInput(input);
    expect(packed.geometries).toHaveLength(2);
    const moved = structuredClone(packed, { transfer });
    // The Scene view's arrays are still whole after the copies moved.
    expect(box.getAttribute('position').array.length).toBe(box.getAttribute('position').count * 3);
    expect(inter.array.length).toBe(count * 4);
    const back = unpackBakeInput(moved);
    const [ga, gb] = [back.targets[0]!.meshes[0]!.geometry, back.targets[1]!.meshes[0]!.geometry];
    expect(back.targets[0]!.meshes[1]!.geometry).toBe(ga);
    expect(back.occluders[0]!.geometry).toBe(ga);
    for (const name of ['position', 'normal', 'uv1']) {
      expect(Array.from(ga.getAttribute(name)!.array)).toEqual(Array.from(box.getAttribute(name)!.array));
    }
    expect(Array.from(ga.getIndex()!.array)).toEqual(Array.from(box.getIndex()!.array));
    const uv = gb.getAttribute('uv1') as THREE.BufferAttribute;
    expect(uv.array).toBeInstanceOf(Int16Array);
    expect(uv.normalized).toBe(true);
    const src = plane.getAttribute('uv1');
    for (let i = 0; i < count; i++) {
      expect(uv.getX(i)).toBe(src.getX(i));
      expect(uv.getY(i)).toBe(src.getY(i));
    }
    expect([gb.drawRange.start, gb.drawRange.count]).toEqual([0, 3]);
    expect(back.targets[0]!.meshes[0]!.matrixWorld.elements).toEqual(m1.elements);
    expect(back.targets[1]!.meshes[0]!.matrixWorld.elements).toEqual(m2.elements);
    expect(back.lights).toEqual(input.lights);
    expect({ ...back, targets: undefined, occluders: undefined }).toEqual({ atlases: input.atlases, lights: input.lights, samples: 16, range: 4, padding: 2, renderer: 'webgl2', targets: undefined, occluders: undefined });
  });
});
