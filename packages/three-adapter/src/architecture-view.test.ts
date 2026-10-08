/**
 * Generated architecture on the page: the generator workers answer byte for
 * byte what the page makes, the view draws one mesh per chunk per material
 * with its far level, and an edit keeps the old meshes until the new ones
 * are in, re-making only the chunks it touched.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { architectureChunkInput, architectureChunkKeys, encodeArchitectureChunks, generateArchitectureChunk, type ArchitectureComponent } from '@thirdlight/runtime';

import { answerArchitectureJob, runArchitectureWorker, type ArchitectureJobReply } from './architecture-worker';
import { ArchitectureView, type ArchitectureViewDeps } from './architecture-view';
import type { MeshWorkerPort } from './block-mesh-pool';

// A neutral test style: two rooms' walls 40 m apart (two chunks each side), a crown moulding (detail) and a floor.
const STYLE: ArchitectureComponent = {
  chunkSize: 16,
  profiles: {
    wall: { points: [[0.1, 0], [0.1, 3], [-0.1, 3], [-0.1, 0]], slots: ['lower_wall', 'bevel', 'upper_wall'] },
    crown: { points: [[0, 2.7], [0.06, 2.8], [0.08, 3]], slots: ['crown', 'crown'], smooth: true },
  },
  elements: [
    { id: 'a', kind: 'sweep', path: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]], closed: true }, profile: 'wall', openings: [{ id: 'door', at: 4, width: 1.2, bottom: 0, top: 2.2 }] },
    { id: 'a-crown', kind: 'sweep', path: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]], closed: true, offset: 0.1 }, profile: 'crown', detail: true },
    { id: 'a-floor', kind: 'fill', path: { points: [[0, 0, 0], [8, 0, 0], [8, 0, 6], [0, 0, 6]], closed: true }, shape: 'flat', slot: 'floor' },
    { id: 'b', kind: 'sweep', path: { points: [[40, 0, 0], [48, 0, 0], [48, 0, 6], [40, 0, 6]], closed: true }, profile: 'wall' },
  ],
};

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** A generator worker on message ports: the worker core as a browser worker runs it. */
function portWorker(): MeshWorkerPort {
  const ch = new MessageChannel();
  const listenOn = (port: MessagePort, cb: (m: unknown) => void): void => {
    port.addEventListener('message', (e) => cb((e as MessageEvent).data));
    port.start();
  };
  runArchitectureWorker({ post: (m, t) => ch.port2.postMessage(m, [...(t ?? [])]), listen: (cb) => listenOn(ch.port2, cb) });
  const stop = (): void => {
    ch.port1.close();
    ch.port2.close();
  };
  stops.push(stop);
  return { post: (m, t) => ch.port1.postMessage(m, [...(t ?? [])]), listen: (cb) => listenOn(ch.port1, cb), onError: () => undefined, terminate: stop };
}

function makeView(extra: Partial<ArchitectureViewDeps> = {}): { view: ArchitectureView; root: THREE.Group } {
  const root = new THREE.Group();
  const view = new ArchitectureView({
    sheets: () => ({}),
    materials: () => null,
    template: () => null,
    dress: () => null,
    read: null,
    place: (r, shown) => (shown ? root.add(r) : root.remove(r)),
    shapeChanged: () => undefined,
    changed: () => undefined,
    ...extra,
  });
  return { view, root };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));
async function settle(v: ArchitectureView): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    v.update([0, 0, 0]);
    const d = v.diagnostics();
    if (d.queued === 0 && d.inFlight === 0 && d.arriving === 0) {
      v.update([0, 0, 0]);
      return;
    }
    await tick();
  }
  throw new Error('the generator never answered');
}

function digest(a: ArrayBufferView): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
  return `${b.length}:${h.toString(16)}`;
}
function drawn(root: THREE.Object3D): string[] {
  const out: string[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh !== true) return;
    const g = m.geometry;
    out.push(`${m.name}:${['position', 'normal', 'uv', 'color'].map((n) => digest(g.getAttribute(n)!.array as ArrayBufferView)).join('|')}|${digest(g.getIndex()!.array as Uint32Array)}`);
  });
  return out.sort();
}

describe('generated architecture on the page', () => {
  it('a worker answers byte for byte what the page makes', async () => {
    const keys = [...architectureChunkKeys(STYLE, {}).values()];
    const w = portWorker();
    const replies = new Map<number, ArchitectureJobReply>();
    w.listen((m) => replies.set((m as ArchitectureJobReply).job, m as ArchitectureJobReply));
    keys.forEach((k, job) => w.post({ t: 'archGenerate', job, component: architectureChunkInput(STYLE, k), sheets: {}, cx: k.cx, cz: k.cz }));
    for (let i = 0; i < 500 && replies.size < keys.length; i++) await tick();
    expect(replies.size).toBe(keys.length);
    keys.forEach((k, job) => {
      const page = answerArchitectureJob({ t: 'archGenerate', job, component: STYLE, sheets: {}, cx: k.cx, cz: k.cz });
      const worker = replies.get(job)!;
      if (!page.ok || !worker.ok) throw new Error('a job failed');
      expect(digest(encodeArchitectureChunks([worker.chunk]))).toBe(digest(encodeArchitectureChunks([page.chunk])));
    });
  });

  it('draws one mesh per chunk per material, near and far levels, the same with workers as on the page', async () => {
    const page = makeView();
    page.view.set('arch', STYLE, [0, 0, 0]);
    await settle(page.view);
    // No arrival time to spare: while the workers start the page makes one chunk a frame, the workers the rest.
    const withWorkers = makeView({ worker: () => portWorker(), arrival: { left: () => 0, spent: () => undefined } });
    withWorkers.view.set('arch', STYLE, [0, 0, 0]);
    await settle(withWorkers.view);
    expect(drawn(withWorkers.root)).toEqual(drawn(page.root));
    const d = withWorkers.view.diagnostics();
    expect(d.made.worker + d.made.page).toBe(architectureChunkKeys(STYLE, {}).size);
    expect(d.made.worker).toBeGreaterThan(0);
    expect(d.made.page).toBeGreaterThan(0);
    // One draw per chunk per material (one material slot here; chunks the elements' bounds reach but own nothing of are empty).
    expect(d.draws).toBe(withWorkers.root.children.filter((g) => g.children.length > 0).length);
    expect(d.draws).toBeGreaterThan(1);
    const lods: THREE.LOD[] = [];
    withWorkers.root.traverse((o) => (o as THREE.LOD).isLOD === true && lods.push(o as THREE.LOD));
    // The chunks with the crown moulding have a far level without it.
    expect(lods.length).toBeGreaterThan(0);
    for (const l of lods) expect(l.levels.map((x) => x.distance)).toEqual([0, 40]);
  });

  it('an edit re-makes only the chunks it touches and keeps the old meshes until the new ones are in', async () => {
    const { view, root } = makeView();
    view.set('arch', STYLE, [0, 0, 0]);
    await settle(view);
    const before = drawn(root);
    const made = view.diagnostics().made.page;
    // Move the far room's wall: its chunks change, the first room's do not.
    const edited: ArchitectureComponent = { ...STYLE, elements: STYLE.elements.map((e) => (e.id === 'b' && e.kind === 'sweep' ? { ...e, path: { ...e.path, points: e.path.points.map((p) => [p[0], p[1], p[2] + 1] as [number, number, number]) } } : e)) };
    view.remove('arch');
    view.set('arch', edited, [0, 0, 0]);
    // Nothing made yet: everything still drawn.
    expect(drawn(root)).toEqual(before);
    await settle(view);
    const after = view.diagnostics();
    const changed = [...architectureChunkKeys(edited, {}).values()].filter((k) => !new Set([...architectureChunkKeys(STYLE, {}).values()].map((x) => x.key)).has(k.key)).length;
    expect(after.made.page - made).toBe(changed);
    expect(drawn(root)).not.toEqual(before);
    // Undo: the old chunks come from memory, nothing is generated.
    view.set('arch', STYLE, [0, 0, 0]);
    await settle(view);
    expect(view.diagnostics().made.page).toBe(after.made.page);
    expect(drawn(root)).toEqual(before);
  });

  it("an export's shipped meshes are drawn as they are: nothing is generated", async () => {
    const page = makeView();
    page.view.set('arch', STYLE, [0, 0, 0]);
    await settle(page.view);
    const chunks = [...architectureChunkKeys(STYLE, {}).values()].map((k) => generateArchitectureChunk(STYLE, {}, k.cx, k.cz));
    const blob = encodeArchitectureChunks(chunks);
    const shipped = makeView({ read: () => Promise.resolve(blob.slice().buffer), worker: () => portWorker() });
    shipped.view.set('arch', { ...STYLE, baked: 'a'.repeat(64) }, [0, 0, 0]);
    for (let i = 0; i < 500 && shipped.view.diagnostics().made.baked === 0; i++) await tick();
    await settle(shipped.view);
    expect(drawn(shipped.root)).toEqual(drawn(page.root));
    const d = shipped.view.diagnostics();
    expect(d.made.baked).toBe(chunks.length);
    expect(d.made.worker + d.made.page).toBe(0);
  });
});
