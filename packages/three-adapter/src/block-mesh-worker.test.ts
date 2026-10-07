/**
 * Block chunks meshed off the frame: the block view with mesh workers (the
 * worker core run on message ports, as the browser runs it on a worker's
 * global) draws the very same meshes as the view meshing on the page; a
 * chunk keeps its old meshes until its new ones arrive; a result for a chunk
 * changed since is dropped; an edit within the budget meshes at once; a
 * worker that fails hands its chunks back to the page, and so does one that
 * stops answering; a model the worker did not have is sent to it and the
 * chunk meshed again; a layer dropped leaves nothing behind in the worker.
 */
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { applyBlockEdits, BlockGrid, type BlockLayerComponent, type BlockType } from '@thirdlight/runtime';

import { BlockLayerView, blockLookFromObject, MESH_WORKER_STALL_MS, SYNC_MESH_BUDGET_MS, type BlockLayerViewDeps } from './block-layers';
import type { MeshWorkerPort } from './block-mesh-pool';
import { runBlockMeshWorker } from './block-mesh-worker';

const TYPES: BlockType[] = [
  // A mapped material: its world-mapped stand-in carries tangents.
  { blockId: 'stone', name: 'Stone', variants: [{ color: '#888888' }], shape: 'full', materials: { '*': 'rock' } },
  { blockId: 'grass', name: 'Grass', variants: [{ color: '#55aa55' }, { color: '#66bb66' }], shape: 'full' },
  { blockId: 'crate', name: 'Crate', variants: [{ model: { assetId: 'kit' } }], shape: 'full' },
  // The same model with world texture coordinates (and tangents) on one variant.
  { blockId: 'tile', name: 'Tile', variants: [{ model: { assetId: 'kit' }, uv: 'world' }, { model: { assetId: 'kit' } }], shape: 'full' },
  // Edge pieces: a stand-in wall and a model gate.
  { blockId: 'wall', name: 'Wall', variants: [{ color: '#aa8866' }], shape: 'full', placement: 'edge' },
  { blockId: 'gate', name: 'Gate', variants: [{ model: { assetId: 'kit' } }], shape: 'half', placement: 'edge' },
  // Connected: a cell wall and an edge fence whose pieces follow their neighbours (across the chunk border too).
  { blockId: 'rampart', name: 'Rampart', variants: [{ color: '#101010' }, { color: '#202020' }, { color: '#303030' }], shape: 'custom', boxes: [[0.3, 0, 0, 0.7, 1, 1]], connect: { pieces: { end: { variant: 1 }, straight: { variant: 2 }, corner: { variant: 1, rot: 90 } } } },
  { blockId: 'fence', name: 'Fence', variants: [{ color: '#404040' }, { color: '#505050' }, { color: '#606060' }], shape: 'half', placement: 'edge', connect: { pieces: { end: { variant: 1 }, corner: { variant: 2 } } } },
];
const LAYER: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 24, 32] }, smoothAngle: 40, topSubdivision: 2 } as BlockLayerComponent;
const q = (v: number): number => Math.round(v * 16) / 16;

/** Rolling sloped ground over 2 × 2 chunks with a row of model blocks on it. */
function groundData(): { entityId: string; chunks: ReturnType<BlockGrid['encodeChunk']>[] } {
  const g = new BlockGrid(LAYER);
  const h = (x: number, z: number): number => q(8 + 3 * Math.sin(x / 5) * Math.cos(z / 6));
  for (let x = 0; x < 32; x++) for (let z = 0; z < 32; z++) {
    const c = [h(x, z), h(x + 1, z), h(x + 1, z + 1), h(x, z + 1)];
    const row = Math.floor(Math.min(...c) - 1e-9);
    for (let y = 0; y < row; y++) g.set(x, y, z, { block: 'stone' });
    const corners = c.map((v) => v - row) as [number, number, number, number];
    g.set(x, row, z, { block: 'grass', ...(corners.every((v) => v === 1) ? {} : { corners }) });
  }
  for (let x = 2; x < 30; x += 3) g.set(x, 20, 5, { block: 'crate' });
  for (let x = 0; x < 32; x++) g.set(x, 20, 9, { block: 'tile', variant: x % 2 });
  // A wall along an x line across two chunks, and gates (some turned, some open) along a z line.
  for (let z = 0; z < 32; z++) g.setEdge(16, 20, z, 0, { block: 'wall' });
  for (let x = 0; x < 32; x += 2) g.setEdge(x, 21, 16, 1, { block: 'gate', ...(x % 4 === 0 ? { rot: 180 as const, open: true } : {}) });
  for (let x = 12; x < 20; x++) g.set(x, 22, 12, { block: 'rampart' });
  for (let z = 13; z < 15; z++) g.set(12, 22, z, { block: 'rampart' });
  for (let z = 12; z < 20; z++) g.setEdge(20, 22, z, 0, { block: 'fence' });
  for (let x = 14; x < 20; x++) g.setEdge(x, 22, 20, 1, { block: 'fence' });
  return { entityId: 'ground', chunks: g.chunkKeys().map((k) => g.encodeChunk(k)) };
}

/** A model with two levels (a cube, then a slab past 20 m). */
function kitLook(): ReturnType<typeof blockLookFromObject> {
  const material = new THREE.MeshLambertMaterial();
  const lod = new THREE.LOD();
  lod.addLevel(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), material), 0);
  lod.addLevel(new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 1).translate(0, 0.1, 0), material), 20);
  const root = new THREE.Group();
  root.add(lod);
  return blockLookFromObject(root);
}

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

/** A mesh worker on message ports: the worker core as a browser worker runs it. */
function portWorker(onCreate?: (w: { fail(message: string): void; port: MessagePort }) => void): MeshWorkerPort {
  const ch = new MessageChannel();
  const listenOn = (port: MessagePort, cb: (m: unknown) => void): void => {
    port.addEventListener('message', (e) => cb((e as MessageEvent).data));
    port.start();
  };
  const core = runBlockMeshWorker({ post: (m, t) => ch.port2.postMessage(m, [...(t ?? [])]), listen: (cb) => listenOn(ch.port2, cb) });
  let onError: ((message: string) => void) | null = null;
  const stop = (): void => {
    core.stop();
    ch.port1.close();
    ch.port2.close();
  };
  stops.push(stop);
  onCreate?.({ fail: (message) => onError?.(message), port: ch.port1 });
  return {
    post: (m, t) => ch.port1.postMessage(m, [...(t ?? [])]),
    listen: (cb) => listenOn(ch.port1, cb),
    onError: (h) => void (onError = h),
    terminate: stop,
  };
}

function makeView(extra: Partial<BlockLayerViewDeps> = {}): BlockLayerView {
  const look = kitLook();
  return new BlockLayerView({ modelLook: () => look, lightmapped: () => true, cores: 4, ...extra });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

/** Update until no chunk waits for a worker. */
async function settle(v: BlockLayerView): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    v.update();
    if (v.diagnostics().meshing.queued === 0) return;
    await tick();
  }
  throw new Error('the mesh workers never answered');
}

/** A digest of an array's bytes (FNV-1a). */
function bytesDigest(a: ArrayBufferView): string {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
  return `${b.length}:${h.toString(16)}`;
}

/** Every chunk mesh's name and arrays, in order (what the GPU would draw). */
function drawn(v: BlockLayerView): string[] {
  const out: string[] = [];
  v.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh !== true) return;
    const g = m.geometry as THREE.BufferGeometry;
    const arrays = ['position', 'normal', 'uv', 'tangent', 'uv1', 'color', 'color_1'].map((n) => g.getAttribute(n)?.array as Float32Array | undefined);
    out.push(`${m.parent?.name}/${m.name}:${arrays.map((a) => (a === undefined ? '-' : bytesDigest(a))).join('|')}|${bytesDigest(g.getIndex()!.array as Uint32Array)}`);
  });
  return out.sort();
}

describe('block view: meshing in workers', () => {
  it('draws byte for byte what the page meshes, levels of detail and lightmap UVs included, and keeps the frame free of bulk meshing', async () => {
    const page = makeView();
    page.setTypes(TYPES);
    page.setLayer('ground', LAYER, [0, 0, 0], groundData() as never);
    page.update();
    const worker = makeView({ meshWorkers: () => portWorker() });
    worker.setTypes(TYPES);
    worker.setLayer('ground', LAYER, [0, 0, 0], groundData() as never);
    worker.update();
    // Loading a layer is bulk: nothing meshed on the page, every chunk waits for the workers.
    expect(worker.diagnostics().meshing).toMatchObject({ workers: 2, queued: 4, meshedHere: 0 });
    await settle(worker);
    const d = worker.diagnostics();
    expect(d.meshing.meshedHere).toBe(0);
    expect(d.chunks).toBe(4);
    expect(d.lods?.chunks).toBeGreaterThan(0);
    expect(drawn(worker)).toEqual(drawn(page));
    // The edge pieces are drawn in their chunks: the wall's stand-in and the gate's model part.
    expect(drawn(page).some((m) => m.includes('block:c:wall'))).toBe(true);
    expect(drawn(page).some((m) => m.includes(':gate#'))).toBe(true);
    // The connected pieces: each look of the wall and the fence is drawn (ends, straight runs, corners).
    for (const k of ['rampart:1', 'rampart:2', 'fence:0', 'fence:1', 'fence:2']) expect(drawn(page).some((m) => m.includes(k)), k).toBe(true);
    // World-mapped looks (the stone stand-ins, the tile's first variant) carry tangents; model-mapped ones none.
    const tangents = drawn(page).filter((m) => m.split('|')[3] !== '-');
    expect(tangents.some((m) => m.includes('block:c:stone'))).toBe(true);
    expect(tangents.some((m) => m.includes(':tile:w#'))).toBe(true);
    expect(tangents.some((m) => m.includes(':crate#') || m.includes(':tile#'))).toBe(false);
    worker.dispose();
    page.dispose();
  });

  it('a layer with wall paint, painted on tops and walls: the workers draw its cut walls and paint colours byte for byte as the page does', async () => {
    const layer = { ...LAYER, wallPaint: true } as BlockLayerComponent;
    const g = BlockGrid.from(layer, groundData() as never);
    const r = applyBlockEdits(g, [
      { kind: 'paint', at: [10, 10], radius: 4, strength: 0.6, channel: 2 },
      { kind: 'paint', at: [16, 12], y: 21, target: 'both', radius: 3, strength: 0.8, channel: 3 },
      { kind: 'paint', at: [15.5, 20], y: 18, target: 'walls', radius: 6, strength: 0.5, channel: 4 },
    ], { types: new Map(TYPES.map((t) => [t.blockId, t])), stamps: new Map() });
    expect(r.ok).toBe(true);
    const data = { entityId: 'ground', chunks: g.chunkKeys().map((k) => g.encodeChunk(k)) };
    expect(data.chunks.some((c) => c?.wallPaint !== undefined)).toBe(true);
    const page = makeView();
    page.setTypes(TYPES);
    page.setLayer('ground', layer, [0, 0, 0], data as never);
    page.update();
    const worker = makeView({ meshWorkers: () => portWorker() });
    worker.setTypes(TYPES);
    worker.setLayer('ground', layer, [0, 0, 0], data as never);
    await settle(worker);
    expect(drawn(worker)).toEqual(drawn(page));
    // Every chunk mesh carries the paint (the stone stand-ins too).
    expect(drawn(page).filter((m) => m.includes('block:c:stone')).every((m) => m.split('|')[5] !== '-')).toBe(true);
    worker.dispose();
    page.dispose();
  });

  it('a chunk keeps its old meshes until the new ones arrive; a result for a chunk changed since is dropped', async () => {
    const v = makeView({ meshWorkers: () => portWorker() });
    v.setTypes(TYPES);
    const data = groundData();
    v.setLayer('ground', LAYER, [0, 0, 0], data as never);
    await settle(v);
    const before = new Set<THREE.Object3D>(v.root.children[0]!.children);
    // A block type change re-meshes everything in the workers: the old chunks are drawn meanwhile.
    v.setTypes(TYPES.map((t) => (t.blockId === 'grass' ? { ...t, variants: [{ color: '#77cc77' }] } : t)));
    v.update();
    expect(v.diagnostics().meshing.queued).toBe(4);
    expect(new Set(v.root.children[0]!.children)).toEqual(before);
    // The layer replaced while they mesh: their results are for the old cells and are dropped.
    v.setLayer('ground', LAYER, [0, 0, 0], data as never);
    await settle(v);
    const d = v.diagnostics();
    expect(d.chunks).toBe(4);
    // 4 chunks at load, then 4 for the replaced layer: the 4 for the type change were dropped.
    expect(d.meshing.meshedInWorkers).toBe(8);
    expect(v.root.children[0]!.children.some((c) => before.has(c))).toBe(false);
    v.dispose();
  });

  it('an edit within the budget meshes on the page in the same update; beyond it, it goes to the workers', async () => {
    const v = makeView({ meshWorkers: () => portWorker() });
    v.setTypes(TYPES);
    const g = BlockGrid.from(LAYER, groundData() as never);
    v.setLayer('ground', LAYER, [0, 0, 0], groundData() as never);
    await settle(v);
    const edit = (x: number, z: number): void => {
      g.set(x, 22, z, { block: 'stone' });
      const ks = g.takeDirty().chunks;
      v.replaceChunks('ground', ks.map((k) => {
        const [cx, cz] = k.split(',').map(Number) as [number, number];
        return { cx, cz, chunk: g.encodeChunk(k) };
      }));
    };
    const estimate = v.diagnostics().meshing.chunkMs;
    expect(estimate).toBeGreaterThan(0);
    edit(4, 4);
    v.update();
    const m = v.diagnostics().meshing;
    if (estimate <= SYNC_MESH_BUDGET_MS) {
      expect(m.lastUpdate.here).toBeGreaterThan(0);
      expect(m.meshedHere).toBeGreaterThan(0);
    } else expect(m.queued).toBeGreaterThan(0);
    // Every chunk at once (more than the budget holds): the rest waits for the workers.
    for (const [x, z] of [[20, 4], [4, 20], [20, 20]] as const) edit(x, z);
    v.update();
    expect(v.diagnostics().meshing.lastUpdate.ms).toBeLessThan(SYNC_MESH_BUDGET_MS + Math.max(estimate, 1) * 2 + 20);
    await settle(v);
    expect(v.diagnostics().chunks).toBe(4);
    v.dispose();
  });

  it('a worker that fails hands its chunks back to the page', async () => {
    const fails: ((m: string) => void)[] = [];
    const v = makeView({ meshWorkers: () => portWorker((w) => fails.push(w.fail)) });
    v.setTypes(TYPES);
    v.setLayer('ground', LAYER, [0, 0, 0], groundData() as never);
    v.update();
    expect(v.diagnostics().meshing.queued).toBe(4);
    fails[0]!('the mesh worker script could not be loaded');
    v.update();
    const d = v.diagnostics();
    expect(d.meshing).toMatchObject({ workers: 0, queued: 0, meshedHere: 4 });
    expect(d.chunks).toBe(4);
    v.dispose();
  });

  it("an edit made while a worker meshes the old cells: that answer is dropped (the old meshes stay until the edit's own)", async () => {
    // The workers' answers are held back until released: the first round is in flight when the edit lands.
    const held: { deliver: (m: unknown) => void; m: unknown }[] = [];
    let holding = true;
    const v = makeView({
      meshWorkers: () => {
        const w = portWorker();
        return {
          ...w,
          listen: (cb) =>
            w.listen((m) => {
              if (holding) held.push({ deliver: cb, m });
              else cb(m);
            }),
        };
      },
    });
    v.setTypes(TYPES);
    const g = BlockGrid.from(LAYER, groundData() as never);
    v.setLayer('ground', LAYER, [0, 0, 0], groundData() as never);
    v.update();
    for (let i = 0; i < 2000 && held.length < 4; i++) await tick();
    expect(held.length).toBe(4);
    // Every chunk edited: what the workers meshed is for the cells before.
    for (const [x, z] of [[4, 4], [20, 4], [4, 20], [20, 20]] as const) g.set(x, 22, z, { block: 'stone' });
    v.replaceChunks('ground', g.takeDirty().chunks.map((k) => {
      const [cx, cz] = k.split(',').map(Number) as [number, number];
      return { cx, cz, chunk: g.encodeChunk(k) };
    }));
    holding = false;
    for (const h of held.splice(0)) h.deliver(h.m);
    v.update();
    expect(v.diagnostics().meshing.meshedInWorkers, 'answers for the old cells dropped').toBe(0);
    await settle(v);
    const page = makeView();
    page.setTypes(TYPES);
    page.setLayer('ground', LAYER, [0, 0, 0], { entityId: 'ground', chunks: g.chunkKeys().map((k) => g.encodeChunk(k)) } as never);
    page.update();
    expect(drawn(v)).toEqual(drawn(page));
    v.dispose();
    page.dispose();
  });

  it('workers that stop answering hand their chunks back to the page; a flush tells them to drop theirs', async () => {
    let clock = 0;
    const silent = (): MeshWorkerPort => ({ post: () => undefined, listen: () => undefined, onError: () => undefined, terminate: () => undefined });
    const v = makeView({ meshWorkers: silent, now: () => clock });
    v.setTypes(TYPES);
    v.setLayer('ground', LAYER, [0, 0, 0], groundData() as never);
    v.update();
    expect(v.diagnostics().meshing).toMatchObject({ workers: 2, queued: 4 });
    clock += MESH_WORKER_STALL_MS - 1;
    v.update();
    expect(v.diagnostics().meshing.queued).toBe(4);
    clock += 2;
    v.update();
    expect(v.diagnostics().meshing).toMatchObject({ workers: 0, queued: 0, meshedHere: 4 });
    expect(v.diagnostics().chunks).toBe(4);
    v.dispose();

    // A flush (a bake) meshes on the page and cancels what the workers were asked for.
    const sent: { t: string }[] = [];
    const listening = (): MeshWorkerPort => ({ post: (m) => void sent.push(m as { t: string }), listen: () => undefined, onError: () => undefined, terminate: () => undefined });
    const f = makeView({ meshWorkers: listening, cores: 3 });
    f.setTypes(TYPES);
    f.setLayer('ground', LAYER, [0, 0, 0], groundData() as never);
    f.update();
    f.flush();
    expect(f.diagnostics().meshing).toMatchObject({ queued: 0, meshedHere: 4 });
    expect(sent.filter((m) => m.t === 'cancel').length).toBe(4);
    f.dispose();
  });

  it('a layer dropped leaves no chunk generations or requests behind in the worker', async () => {
    const ch = new MessageChannel();
    const core = runBlockMeshWorker({ post: () => undefined, listen: (cb) => ((ch.port2.onmessage = (e) => cb(e.data)), undefined) });
    stops.push(() => {
      core.stop();
      ch.port1.close();
      ch.port2.close();
    });
    for (let i = 0; i < 50; i++) ch.port1.postMessage({ t: 'mesh', entityId: 'gone', serial: 1, cx: i, cz: 0, gen: 1, uv: false });
    ch.port1.postMessage({ t: 'cancel', entityId: 'gone', cx: 99, cz: 0, gen: 3 });
    for (let i = 0; i < 50 && core.tracked() < 51; i++) await tick();
    expect(core.tracked()).toBe(51);
    ch.port1.postMessage({ t: 'drop', entityId: 'gone' });
    for (let i = 0; i < 50 && core.tracked() > 0; i++) await tick();
    expect(core.tracked()).toBe(0);
  });

  it('a model still loading is meshed in when it arrives: the worker gets its geometry and the chunk is asked again', async () => {
    let ready: (() => void) | null = null;
    let loaded = false;
    const look = kitLook();
    const v = makeView({
      meshWorkers: () => portWorker(),
      modelLook: (_a, _p, onReady) => {
        ready = onReady;
        return loaded ? look : null;
      },
    });
    v.setTypes(TYPES);
    v.setLayer('ground', LAYER, [0, 0, 0], groundData() as never);
    await settle(v);
    expect(v.diagnostics().lods).toBeUndefined();
    loaded = true;
    ready!();
    await settle(v);
    expect(v.diagnostics().lods?.chunks).toBeGreaterThan(0);
    v.dispose();
  });
});
