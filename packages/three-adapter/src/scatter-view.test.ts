/**
 * The scatter view: a block layer's chunks and a terrain's tile blobs come
 * in as the block and terrain views get them; each rule's copies are drawn
 * per group as one instance set, built again only where a cell changed, the
 * copies where the stored data put them.
 */
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bakeScatterCell, decodeChunkScatter, encodeChunkScatter, scatterBlobOf, type BlockChunk, type BlockLayerComponent, type ScatterGround, type ScatterRule, type ScatterSurface, type TerrainComponent } from '@thirdlight/runtime';

import type { AttributeInstancedMesh } from './attribute-instancing';
import { CUTAWAY_LAYER } from './block-cutaway-view';
import type { MeshWorkerPort } from './block-mesh-pool';
import { runScatterWorker } from './scatter-worker';
import { ScatterView } from './scatter-view';
import { SHADOW_RING_METRES } from './scatter-shadows';
import { CullView, VIEW_CULL_KEY } from './view-cull';
import type { ModelInstance } from './visual';

// The page's time per frame is a budget: a clock that stands still lets every update make all it can, as a fast
// machine would, so a loaded test run never splits a set over frames the assertions do not expect.
beforeEach(() => void vi.spyOn(performance, 'now').mockReturnValue(0));
afterEach(() => void vi.restoreAllMocks());

/** Until the worker answered every job sent (its answers come on later tasks). */
async function answered(view: ScatterView): Promise<void> {
  for (let i = 0; i < 1000 && view.diagnostics().preparing > 0; i++) await new Promise((r) => setTimeout(r, 0));
}

const RULE: ScatterRule = { id: 'trees', asset: { assetId: 'tree' }, density: 0.25, castShadow: true };

/** Flat ground at y = 1. */
const FLAT: ScatterSurface = {
  at(x, z) {
    return { x, y: 1, z, slope: 0, wall: false, nx: 0, ny: 1, nz: 0, cavity: () => 0, layer: () => 1 } as ScatterGround;
  },
};

function template(): ModelInstance {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 4, 1), new THREE.MeshBasicMaterial()));
  return { glbRoot: root } as unknown as ModelInstance;
}

function host(read?: (digest: string) => Promise<ArrayBuffer>) {
  const listed = new Set<THREE.Object3D>();
  let shapes = 0;
  const t = template();
  const view = new ScatterView({
    template: () => t,
    read: read ?? null,
    place: (root, shown) => void (shown ? listed.add(root) : listed.delete(root)),
    shapeChanged: () => void (shapes += 1),
  });
  return { view, listed, shapes: () => shapes };
}

const chunk = (cx: number, cz: number, size: number): BlockChunk => {
  const cell = bakeScatterCell([RULE], FLAT, null, [cx * size, cz * size, (cx + 1) * size, (cz + 1) * size], null, [0, 0, 0]).cell;
  return { cx, cz, palette: [], columns: [], scatter: encodeChunkScatter(cell)! };
};

describe('scatter view', () => {
  it('draws a block layer\'s copies, one set per rule and group, rebuilt only where a chunk changed', () => {
    const { view, listed, shapes } = host();
    const comp = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [64, 8, 64] }, scatter: [RULE] } as unknown as BlockLayerComponent;
    view.setBlockLayer('layer', comp, [10, 0, 0], [chunk(0, 0, 16), chunk(1, 0, 16)]);
    expect(view.update()).toBe(true);
    const d = view.diagnostics();
    expect(d.sets).toBe(1);
    expect(d.copies).toBeGreaterThan(100);
    expect(listed.size).toBe(1);
    expect(shapes()).toBe(1);
    // The group sits at the layer's origin: a copy's world x is the stored x plus 10.
    const mesh = view.meshes()[0]!;
    mesh.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    expect(p.x).toBeGreaterThan(10);
    // Nothing changed: nothing built.
    expect(view.update()).toBe(false);
    // A chunk's scatter gone: the group is built again with fewer copies.
    view.replaceBlockChunks('layer', [{ cx: 1, cz: 0, chunk: { cx: 1, cz: 0, palette: [], columns: [] } }]);
    expect(view.update()).toBe(true);
    expect(view.diagnostics().copies).toBeLessThan(d.copies);
    view.setHidden('layer', true);
    expect(listed.size).toBe(0);
    view.remove('layer');
    expect(view.ids()).toEqual([]);
  });

  it('reads a terrain\'s tile blobs and draws them once read', async () => {
    const blobs = new Map<string, Uint8Array>();
    const tiles = [0, 1].map((x) => {
      const cell = bakeScatterCell([RULE], FLAT, null, [x * 64, 0, x * 64 + 64, 64], null, [0, 0, 0]).cell;
      const digest = String(x).repeat(64);
      blobs.set(digest, scatterBlobOf(cell)!);
      return { x, z: 0, scatter: digest };
    });
    const { view } = host(async (d) => blobs.get(d)!.slice().buffer);
    const comp = { tileSamples: 33, spacing: 2, heightRange: [0, 10], tiles, scatter: [RULE] } as TerrainComponent;
    view.setTerrain('ground', comp, [0, 0, 0]);
    // Not read yet: nothing to build.
    expect(view.update()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(view.update()).toBe(true);
    // Both tiles (64 m each) fall in one group: one set.
    expect(view.diagnostics()).toMatchObject({ sources: 1, cells: 2, groups: 1, sets: 1 });
    // A terrain without rules draws nothing.
    view.setTerrain('ground', { ...comp, scatter: [] }, [0, 0, 0]);
    expect(view.update()).toBe(true);
    expect(view.diagnostics().sets).toBe(0);
  });

  it('the foliage policy: near copies cast from shadow-only squares around the eye, blobs under every copy', () => {
    const near: ScatterRule = { ...RULE, castShadow: true, shadowDistance: 40, blobShadow: 0.5 };
    const { view, listed } = host();
    const comp = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [512, 8, 512] }, scatter: [near] } as unknown as BlockLayerComponent;
    const chunks: BlockChunk[] = [];
    for (let cz = 0; cz < 16; cz++) for (let cx = 0; cx < 16; cx++) chunks.push(chunk(cx, cz, 16));
    view.setBlockLayer('layer', comp, [0, 0, 0], chunks);
    const eyeAt = (x: number, z: number): CullView => {
      const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
      cam.position.set(x, 2, z);
      cam.updateMatrixWorld();
      const v = new CullView();
      v.set(cam);
      return v;
    };
    for (let i = 0; i < 20; i++) view.update(eyeAt(100, 100));
    const all = view.meshes();
    // The copies' own draws cast nothing; the blobs (a disc each) neither cast nor take shadows.
    expect(all.filter((m) => m.castShadow).length).toBe(0);
    expect(view.diagnostics().sets).toBe(2);
    // Shadow-only squares: in the shadow cameras' layer, within the distance of the eye (and their copies only near it).
    const roots = [...listed].filter((r) => r.name.startsWith('scatter-shadow:'));
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) {
      const [ix, iz] = r.name.split(':').pop()!.split(',').map(Number) as [number, number];
      const dx = Math.max(ix * SHADOW_RING_METRES - 100, 0, 100 - (ix + 1) * SHADOW_RING_METRES);
      const dz = Math.max(iz * SHADOW_RING_METRES - 100, 0, 100 - (iz + 1) * SHADOW_RING_METRES);
      expect(Math.hypot(dx, dz)).toBeLessThanOrEqual(40);
      r.traverse((o) => {
        if ((o as THREE.Mesh).isMesh !== true) return;
        expect(o.layers.isEnabled(CUTAWAY_LAYER) && !o.layers.isEnabled(0)).toBe(true);
        expect((o as THREE.Mesh).castShadow).toBe(true);
      });
    }
    // The eye moves: the squares it left go (past the distance and half a square), others come.
    const before = new Set(roots.map((r) => r.name));
    for (let i = 0; i < 20; i++) view.update(eyeAt(220, 220));
    const after = [...listed].filter((r) => r.name.startsWith('scatter-shadow:')).map((r) => r.name);
    expect(after.some((n) => !before.has(n))).toBe(true);
    expect([...before].some((n) => !after.includes(n))).toBe(true);
  });
});

describe('scatter view: sets prepared on a worker, copies a game hides', () => {
  const comp = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [64, 8, 64] }, scatter: [{ ...RULE, blobShadow: 0.5 }] } as unknown as BlockLayerComponent;

  /** A worker on the page: the scatter worker's own code behind a message port pair, answering later as a worker does. */
  function pagedWorker(): { factory: () => MeshWorkerPort; jobs: () => number } {
    let jobs = 0;
    const factory = (): MeshWorkerPort => {
      const toPage = new Set<(m: unknown) => void>();
      const toWorker = new Set<(m: unknown) => void>();
      runScatterWorker({ post: (m) => setTimeout(() => toPage.forEach((l) => l(m)), 0), listen: (l) => void toWorker.add(l) });
      return {
        post: (m) => {
          jobs += 1;
          // A worker gets a copy (the page's buffers move): structured clone stands in for the transfer.
          const copy = structuredClone(m);
          setTimeout(() => toWorker.forEach((l) => l(copy)), 0);
        },
        listen: (l) => void toPage.add(l),
        onError: () => undefined,
        terminate: () => undefined,
      };
    };
    return { factory, jobs: () => jobs };
  }

  it('prepares each rule\'s set and its blobs on the worker; the old set stays drawn until the new one replaces it', async () => {
    const listed = new Set<THREE.Object3D>();
    const t = template();
    const w = pagedWorker();
    const view = new ScatterView({ template: () => t, read: null, place: (root, shown) => void (shown ? listed.add(root) : listed.delete(root)), worker: w.factory });
    view.setBlockLayer('layer', comp, [0, 0, 0], [chunk(0, 0, 16), chunk(1, 0, 16)]);
    // Sent, not built: nothing drawn yet.
    expect(view.update()).toBe(false);
    expect(w.jobs()).toBe(2);
    expect(view.diagnostics()).toMatchObject({ preparing: 2, sets: 0 });
    await answered(view);
    expect(view.update()).toBe(true);
    const d = view.diagnostics();
    expect(d).toMatchObject({ sets: 2, preparing: 0, prepared: 0, preparedSets: 2, onWorker: true });
    const before = view.meshes();
    // A chunk changed: prepared again; until the answer the old set is still drawn.
    view.replaceBlockChunks('layer', [{ cx: 1, cz: 0, chunk: { cx: 1, cz: 0, palette: [], columns: [] } }]);
    view.update();
    // The same draws (compared by identity: a deep comparison walks three's objects, whose node materials differ run to run).
    const same = (a: readonly THREE.Mesh[], b: readonly THREE.Mesh[]): boolean => a.length === b.length && a.every((m, i) => m === b[i]);
    expect(same(view.meshes(), before)).toBe(true);
    await answered(view);
    view.update();
    expect(view.meshes().some((m) => before.includes(m))).toBe(false);
    expect(view.diagnostics().copies).toBeLessThan(d.copies);
    view.dispose();
  });

  it('a set of many chunks is made over frames within the frame\'s time, shown once whole; the old one stays drawn until then', () => {
    // A clock that moves 3 ms each time it is read: a frame's 4 ms make a chunk or two.
    let t = 0;
    vi.mocked(performance.now).mockImplementation(() => (t += 3));
    const { view, listed } = host();
    const small = { ...comp, scatter: [{ ...RULE, chunkSize: 8 }] } as unknown as BlockLayerComponent;
    view.setBlockLayer('layer', small, [0, 0, 0], [chunk(0, 0, 16), chunk(1, 0, 16)]);
    let frames = 0;
    while (view.diagnostics().sets === 0 && frames < 100) {
      view.update();
      frames += 1;
      // Nothing shown until the set (and its blobs) is whole.
      if (view.diagnostics().sets === 0) expect(listed.size).toBe(0);
    }
    expect(frames).toBeGreaterThan(2);
    expect(view.diagnostics().pending).toBe(0);
    const before = view.meshes();
    expect(before.length).toBeGreaterThan(4);
    // Made again (its rule's settings changed): the old draws stay until the new set is whole, then all go.
    view.setBlockLayer('layer', { ...comp, scatter: [{ ...RULE, chunkSize: 9 }] } as unknown as BlockLayerComponent, [0, 0, 0], [chunk(0, 0, 16), chunk(1, 0, 16)]);
    let again = 0;
    while (view.diagnostics().pending > 0 && again < 100) {
      expect(view.meshes().every((m, i) => m === before[i])).toBe(true);
      view.update();
      again += 1;
    }
    expect(again).toBeGreaterThan(2);
    expect(view.meshes().some((m) => before.includes(m))).toBe(false);
    expect(listed.size).toBe(1);
    view.dispose();
  });

  it('a hidden or removed copy shrinks to nothing in place (its blob too), a hidden one shows again, a removed one is left out when the set is next made', () => {
    const { view } = host();
    view.setBlockLayer('layer', { ...comp } as BlockLayerComponent, [0, 0, 0], [chunk(0, 0, 16)]);
    view.update();
    const copies = view.diagnostics().copies;
    const cell = decodeChunkScatter(chunk(0, 0, 16).scatter)!.get('trees')!;
    const at: [number, number] = [cell.cells[0]!, cell.cells[1]!];
    const drawnScale = (): number[] =>
      view.meshes().map((m) => {
        const inst = m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh;
        // The copy's slot: the first copy of the only chunk (slot order is the copies' order).
        return new THREE.Vector3().setFromMatrixScale(inst.getMatrixAt(0, new THREE.Matrix4())).length();
      });
    expect(drawnScale().every((s) => s > 0)).toBe(true);
    view.setCopyStates([{ entityId: 'layer', key: '0,0', rule: 'trees', cell: at, state: 'hidden' }]);
    // In place: no set made again, the copy (and its blob) drawn at nothing.
    expect(view.diagnostics()).toMatchObject({ pending: 0, hidden: 1, copies });
    expect(drawnScale()).toEqual([0, 0]);
    view.setCopyStates([{ entityId: 'layer', key: '0,0', rule: 'trees', cell: at, state: 'shown' }]);
    expect(drawnScale().every((s) => s > 0)).toBe(true);
    const drawn = view.meshes();
    view.setCopyStates([{ entityId: 'layer', key: '0,0', rule: 'trees', cell: at, state: 'removed' }]);
    // In place too: the same draws, the copy at nothing, no set made again.
    expect(view.diagnostics()).toMatchObject({ pending: 0, removed: 1, copies });
    expect(view.meshes().every((m, i) => m === drawn[i])).toBe(true);
    expect(drawnScale()).toEqual([0, 0]);
    // The group made again for another reason (its rule's settings changed): the copy and its blob disc are left out.
    view.setBlockLayer('layer', { ...comp, scatter: [{ ...RULE, blobShadow: 0.5, chunkSize: 32 }] } as BlockLayerComponent, [0, 0, 0], [chunk(0, 0, 16)]);
    view.update();
    expect(view.diagnostics()).toMatchObject({ pending: 0, removed: 1, copies: copies - 2 });
    // A new run: shown again (the set made again with it).
    view.setCopyStates([{ entityId: 'layer', key: '0,0', rule: 'trees', cell: at, state: 'shown' }]);
    view.update();
    expect(view.diagnostics()).toMatchObject({ removed: 0, copies });
  });
});
