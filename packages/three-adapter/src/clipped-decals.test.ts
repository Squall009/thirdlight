/**
 * Clipped decals in the adapter: which surfaces a box is cut from, when a
 * decal is clipped again and when its key holds, the caches (memory, the
 * store, the workers' held receivers), how the meshes merge and sort, and
 * what the decal material builds with and without the fade stream.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { describe, expect, it, vi } from 'vitest';

import { bakedDecalMaterialName, clipDecal, decalClipGlb } from '@thirdlight/runtime';

import { BATCH_KEY, createAutoBatcher } from './batching';
import { CLIPPED_DECAL_EMPTY_WAIT_MS, CLIPPED_DECAL_KEY, CLIPPED_DECAL_SETTLE_MS, ClippedDecals, CLIPPED_DECAL_STORE_PREFIX, isDecalSurface, type ClippedDecalStore, type ClippedDecalWorkers } from './clipped-decals';
import { answerDecalClipJob, type DecalClipJobRequest, type DecalClipReceiverData } from './decal-clip-worker';
import { DECAL_FADE_ATTRIBUTE } from './decal-material';
import { digestOf } from './material-graph';
import { createMaterialLibrary, type MaterialDefLike } from './material-library';
import { decalRenderOrderFor, installDecalDraw } from './mesh-decals';
import { DECAL_LAYERS_KEY, DECAL_SURFACE_KEY } from './projected-decals';
import { RenderGraph } from './render-graph';
import { STATIC_KEY } from './static-merge';
import { litScene, settle, testTexture, wgslOf, wgslRenderer } from './test-wgsl';

/** A decal material as the library makes one (any material with the decal drawing will do here). */
function decalMaterial(sortOrder = 0): THREE.Material {
  const m = new THREE.MeshStandardMaterial();
  installDecalDraw(m, { blend: 'blend', sortOrder });
  return m;
}

/** A floor `size` m square at height `y` (world), facing up, made of 2 × 2 m quads (a block chunk's top). */
function floor(size: number, y: number, mark: 'surface' | 'batch' = 'surface'): THREE.Mesh {
  const g = new THREE.PlaneGeometry(size, size, size / 2, size / 2);
  g.rotateX(-Math.PI / 2);
  g.translate(0, y, 0);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
  m.userData[mark === 'surface' ? DECAL_SURFACE_KEY : BATCH_KEY] = true;
  m.updateMatrixWorld(true);
  return m;
}

/** Down: the box's −Z along world −Y. */
const DOWN = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2];

interface Rig {
  graph: RenderGraph;
  clipped: ClippedDecals;
  materials: Map<string, THREE.Material>;
  frame(): void;
  decal(id: string, at: number[], decal: Record<string, unknown>, opts?: { rotation?: number[]; parent?: string; scope?: string | null }): void;
}

function rig(opts: { workers?: ClippedDecalWorkers | null; store?: ClippedDecalStore | null; surfacesIn?: () => boolean } = {}): Rig {
  const scene = new THREE.Scene();
  const graph = new RenderGraph(scene, () => false);
  const materials = new Map<string, THREE.Material>([['mark', decalMaterial(2)]]);
  const clipped = new ClippedDecals({
    node: (id) => graph.nodeFor(id) ?? null,
    dress: (mesh, id) => {
      const m = materials.get(id);
      if (m === undefined) return null;
      const before = mesh.material;
      mesh.material = m;
      return () => void (mesh.material = before);
    },
    workers: opts.workers ?? null,
    store: opts.store ?? null,
    changed: () => undefined,
    ...(opts.surfacesIn !== undefined ? { surfacesIn: opts.surfacesIn } : {}),
  });
  graph.onSurfaces(clipped);
  return {
    graph,
    clipped,
    materials,
    frame: () => {
      graph.update();
      clipped.beforeFrame();
    },
    decal: (id, at, decal, o = {}) => {
      graph.addEntity(id, o.parent ?? null);
      graph.world.setLocal(id, at, o.rotation ?? DOWN, [1, 1, 1]);
      graph.update();
      graph.nodeFor(id);
      clipped.set(id, { size: [1, 1, 1], material: 'mark', mode: 'clipped', ...decal } as never, o.scope === undefined ? 'scene-a' : o.scope);
    },
  };
}

const ys = (m: THREE.Mesh): number[] => [...new Set(Array.from({ length: m.geometry.getAttribute('position').count }, (_, i) => Math.round(m.geometry.getAttribute('position').getZ(i) * 1000) / 1000))];

describe('clipped decals', () => {
  it('are cut from the surfaces under the box, drawn as a mesh decal under their node, static, in their own sort order', () => {
    const r = rig();
    const ground = floor(8, 0);
    r.graph.listStatic(ground);
    r.decal('d1', [0.3, 0, 0.2], { size: [1, 1, 1], sortOrder: 3 });
    r.frame();
    r.frame();
    const mesh = r.clipped.meshOf('d1')!;
    expect(mesh).not.toBeNull();
    expect(mesh.parent).toBe(r.graph.node('d1'));
    expect(mesh.material).toBe(r.materials.get('mark'));
    expect(mesh.userData[CLIPPED_DECAL_KEY]).toBe('d1');
    expect(mesh.userData[STATIC_KEY]).toBe('scene-a');
    expect(mesh.castShadow).toBe(false);
    // In the decal's space: the floor 1 mm under the box's middle (z is up the projector: toward +Y in the world).
    expect(ys(mesh)).toEqual([0.001]);
    expect(mesh.geometry.getAttribute(DECAL_FADE_ATTRIBUTE).count).toBe(mesh.geometry.getAttribute('position').count);
    expect(mesh.geometry.getAttribute('tangent').itemSize).toBe(4);
    // A clipped mesh is never a surface (no decal clips another).
    expect(isDecalSurface(mesh)).toBe(false);
    const d = r.clipped.diagnostics();
    expect(d).toMatchObject({ decals: 1, drawn: 1, pending: 0, made: { page: 1, worker: 0, memory: 0, store: 0 } });
    expect(d.readyMs).not.toBeNull();
  });

  it('leave out surfaces in none of its layers, see-through ones and those without a mark (terrain)', () => {
    const r = rig();
    const other = floor(8, 0);
    other.userData[DECAL_LAYERS_KEY] = 2;
    const glass = floor(8, 0.2);
    (glass.material as THREE.Material).transparent = true;
    const terrain = floor(8, 0.1);
    delete terrain.userData[DECAL_SURFACE_KEY];
    for (const m of [other, glass, terrain]) r.graph.listStatic(m);
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      r.decal('d1', [0, 0, 0], { layers: 1 });
      r.frame();
      r.frame();
      expect(r.clipped.meshOf('d1')).toBeNull();
      // Nothing under it so soon after it was set: still waiting for the level's surfaces to arrive.
      expect(r.clipped.diagnostics()).toMatchObject({ decals: 1, drawn: 0, empty: 0, pending: 1 });
      vi.advanceTimersByTime(CLIPPED_DECAL_EMPTY_WAIT_MS + 1);
      r.frame();
      expect(r.clipped.diagnostics()).toMatchObject({ decals: 1, drawn: 0, empty: 1, pending: 0 });
    } finally {
      vi.useRealTimers();
    }
    // The decal in layer 2 too: the floor in layer 2 is marked.
    r.decal('d1', [0, 0, 0], { layers: 3 });
    r.frame();
    r.frame();
    expect(r.clipped.meshOf('d1')).not.toBeNull();
  });

  it('a decal told not to wait (the placement preview) takes nothing under it as final at once, and leaves the ready time alone', () => {
    const r = rig();
    r.clipped.waitForSurfaces('preview', false);
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      r.decal('preview', [0, 5, 0], {});
      r.frame();
      r.frame();
      expect(r.clipped.diagnostics()).toMatchObject({ decals: 1, drawn: 0, empty: 1, pending: 0, readyMs: null });
      // Moved over a floor: cut at once.
      r.graph.listStatic(floor(8, 0));
      r.graph.world.setLocal('preview', [0, 0, 0], DOWN, [1, 1, 1]);
      r.clipped.placed('preview');
      r.frame();
      r.frame();
      expect(r.clipped.meshOf('preview')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('hold the start until drawn; nothing under one is final once the surfaces are in and quiet; ready before the first frame counts as before it', () => {
    let surfacesIn = false;
    const r = rig({ surfacesIn: () => surfacesIn });
    // A level without clipped decals never waits.
    expect(r.clipped.holdsStart()).toBe(false);
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      r.graph.listStatic(floor(8, 0));
      r.decal('on', [0, 0, 0], {});
      r.decal('off', [40, 0, 0], {});
      r.frame();
      r.frame();
      expect(r.clipped.meshOf('on')).not.toBeNull();
      // The second has nothing under it: the start waits while the surfaces may still be coming.
      expect(r.clipped.holdsStart()).toBe(true);
      vi.advanceTimersByTime(CLIPPED_DECAL_SETTLE_MS + 1);
      r.frame();
      expect(r.clipped.holdsStart()).toBe(true);
      // The adapter has made every surface and none came for the settle time: final well before the 2 s wait.
      surfacesIn = true;
      r.frame();
      expect(r.clipped.diagnostics()).toMatchObject({ decals: 2, drawn: 1, empty: 1, pending: 0, readyAfterFirstFrameMs: null, firstFrameAtMs: null });
      expect(r.clipped.holdsStart()).toBe(false);
      vi.advanceTimersByTime(100);
      r.clipped.presented();
      const d = r.clipped.diagnostics();
      expect(d.readyAfterFirstFrameMs).toBeLessThanOrEqual(-100);
      expect(d.readyFrames).toBe(0);
      expect(d.readyMs).toBeLessThan(CLIPPED_DECAL_EMPTY_WAIT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a re-meshed surface clips the decal again; an edit that keeps its key finds the mesh in memory', () => {
    const r = rig();
    const before = floor(8, 0);
    r.graph.listStatic(before);
    r.decal('d1', [0, 0.5, 0], { size: [1, 1, 3] });
    r.frame();
    r.frame();
    expect(ys(r.clipped.meshOf('d1')!)).toEqual([-0.499]);
    // The chunk made again a metre higher (a block placed): the old goes, the new comes.
    r.graph.unlistStatic(before);
    r.graph.listStatic(floor(8, 1));
    r.frame();
    r.frame();
    expect(ys(r.clipped.meshOf('d1')!)).toEqual([0.501]);
    expect(r.clipped.diagnostics().made.page).toBe(2);
    // Released and realized again (every edit does that): the same key, from memory.
    r.clipped.remove('d1');
    r.clipped.set('d1', { size: [1, 1, 3], material: 'mark', mode: 'clipped' }, 'scene-a');
    r.frame();
    expect(r.clipped.meshOf('d1')).not.toBeNull();
    expect(r.clipped.diagnostics().made).toMatchObject({ page: 2, memory: 1 });
  });

  it('a decal and the model it marks moving together keep their key; a decal moving over a floor is clipped again', () => {
    const r = rig();
    r.graph.addEntity('cart', null);
    r.graph.world.setLocal('cart', [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    r.graph.update();
    const deck = floor(4, 0, 'batch');
    r.graph.nodeFor('cart')!.add(deck);
    r.decal('d1', [0, 0, 0], {}, { parent: 'cart', scope: null });
    r.frame();
    r.frame();
    expect(r.clipped.meshOf('d1')!.userData[STATIC_KEY]).toBeUndefined();
    for (let i = 1; i <= 5; i++) {
      r.graph.world.setLocal('cart', [i * 0.37, 0.1 * i, 0], [0, Math.sin(i * 0.1), 0, Math.cos(i * 0.1)], [1, 1, 1]);
      r.frame();
    }
    r.frame();
    expect(r.clipped.diagnostics().made.page).toBe(1);
    // Over a floor of the world: its place on the floor changes the mesh.
    const r2 = rig();
    r2.graph.listStatic(floor(8, 0));
    r2.decal('d2', [0, 0, 0], { size: [1.3, 1, 1] }, { rotation: [-0.5, 0.1, 0.1, 0.5] });
    r2.frame();
    r2.frame();
    r2.graph.world.setLocal('d2', [0.5, 0, 0.25], [-0.5, 0.1, 0.1, 0.5], [1, 1, 1]);
    r2.frame();
    r2.frame();
    expect(r2.clipped.diagnostics().made.page).toBe(2);
  });

  it('a surface that keeps moving under a still decal is left out while it moves: a clip or two, no start held, taken in again once still', () => {
    vi.useFakeTimers({ toFake: ['performance'] });
    try {
      const r = rig();
      r.graph.listStatic(floor(8, 0));
      r.graph.addEntity('mover', null);
      r.graph.world.setLocal('mover', [0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
      r.graph.update();
      const plate = floor(2, 0.2, 'batch');
      plate.name = 'plate';
      r.graph.nodeFor('mover')!.add(plate);
      r.decal('d1', [0, 0, 0], {});
      r.frame();
      r.frame();
      expect(r.clipped.diagnostics().made.page).toBe(1);
      // Three seconds of frames with the plate sliding to and fro inside the box.
      for (let f = 1; f <= 180; f++) {
        vi.advanceTimersByTime(1000 / 60);
        r.graph.world.setLocal('mover', [0.2 * Math.sin(f / 5), 0, 0], [0, 0, 0, 1], [1, 1, 1]);
        r.frame();
        if (f === 90) expect(r.clipped.holdsStart()).toBe(false);
      }
      const d = r.clipped.diagnostics();
      expect(d.made.page).toBeLessThanOrEqual(3);
      expect(d.pending).toBe(0);
      expect(d.problems.filter((p) => p.includes('keeps moving'))).toHaveLength(1);
      // The floor alone under the mark while the plate moves.
      expect(ys(r.clipped.meshOf('d1')!)).toEqual([0.001]);
      // It stops: once still a while, the mark is cut from it again.
      for (let f = 0; f < 90; f++) {
        vi.advanceTimersByTime(1000 / 60);
        r.frame();
      }
      expect(ys(r.clipped.meshOf('d1')!).sort((a, b) => a - b)).toEqual([0.001, 0.201]);
      expect(r.clipped.diagnostics().made.page).toBe(d.made.page + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an exported game finds its clips in the store on a second visit', async () => {
    const kept = new Map<string, Uint8Array>();
    const store: ClippedDecalStore = { get: async (k) => kept.get(k) ?? null, put: (k, b) => void kept.set(k, b) };
    const visit = async (): Promise<Rig> => {
      const r = rig({ store });
      r.graph.listStatic(floor(8, 0));
      r.decal('d1', [0.3, 0, 0.2], {});
      r.frame();
      r.frame();
      for (let i = 0; i < 4; i++) {
        await settle();
        r.frame();
      }
      return r;
    };
    const first = await visit();
    expect(first.clipped.diagnostics().made).toMatchObject({ page: 1, store: 0 });
    expect([...kept.keys()].every((k) => k.startsWith(CLIPPED_DECAL_STORE_PREFIX))).toBe(true);
    const second = await visit();
    expect(second.clipped.diagnostics().made).toMatchObject({ page: 0, store: 1 });
    const a = first.clipped.meshOf('d1')!.geometry.getAttribute('position').array;
    const b = second.clipped.meshOf('d1')!.geometry.getAttribute('position').array;
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('on workers, a receiver\'s arrays cross once and the worker forgets them only when told', async () => {
    const sent: DecalClipJobRequest[] = [];
    const held = new Map<string, DecalClipReceiverData>();
    let reply: (worker: number, m: unknown) => void = () => undefined;
    const workers: ClippedDecalWorkers = {
      sideWorker: () => 0,
      postSide: (_w, m) => {
        sent.push(m as DecalClipJobRequest);
        // Structured clone: the worker has copies.
        const copy = structuredClone(m) as DecalClipJobRequest;
        queueMicrotask(() => reply(0, answerDecalClipJob(copy, held)));
      },
      onSideJobs: (r) => void (reply = r),
    };
    const r = rig({ workers });
    r.graph.listStatic(floor(16, 0));
    for (let i = 0; i < 4; i++) r.decal(`d${i}`, [i * 2 - 3, 0, 0], {});
    r.frame();
    r.frame();
    await settle();
    r.frame();
    expect(sent.length).toBe(4);
    expect(sent.filter((m) => m.receivers.some((x) => x.data !== undefined)).length).toBe(1);
    expect(r.clipped.diagnostics()).toMatchObject({ drawn: 4, pending: 0, made: { worker: 4, page: 0 } });
    expect(held.size).toBe(1);
  });

  it('merge by cell, material and decal order: their own sort order is another draw', () => {
    const mesh = (order: number, x: number): THREE.Mesh => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      m.position.set(x, 0, 0);
      m.userData[BATCH_KEY] = true;
      m.userData[STATIC_KEY] = 'scene-a';
      if (order !== 0) m.userData['__tlDecalOrderOffset'] = order;
      m.renderOrder = decalRenderOrderFor(2 + order);
      m.updateMatrixWorld(true);
      return m;
    };
    const mat = decalMaterial(2);
    const meshes = [mesh(0, 0), mesh(0, 1), mesh(5, 2), mesh(5, 3)];
    const scene = new THREE.Scene();
    for (const m of meshes) scene.add(m);
    const b = createAutoBatcher(scene, {});
    for (const m of meshes) b.listed(m);
    b.update(new THREE.PerspectiveCamera(50, 1, 0.1, 1000));
    const cells = scene.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh === true && o.name.startsWith('tl-merged:'));
    expect(cells.map((c) => c.renderOrder).sort((x, y) => x - y)).toEqual([decalRenderOrderFor(2), decalRenderOrderFor(7)]);
  });
});

describe('the decal material and the fade stream', () => {
  /**
   * The WGSL digests of decal materials on a mesh without the fade stream (three r186): `own` as recorded before
   * clipped decals existed; the paged ones since the pages became one array, whose albedo layers the shader decodes
   * from sRGB (the program reads one texture and decodes, where it read three with the albedo's sRGB in its format).
   */
  const MESH_DECAL_WGSL = { stain: 'e5546e3d5b686c27', soot: '17439ef42ca850d4', own: '3d31e6aaff07c784' };

  it('a mesh decal without fades builds the program it built before; with fades it reads them', async () => {
    // A build's pages: every set in one array, a page's sets side by side.
    const page = (layer: number) => ({ rect: [0.1, 0.1, 0.4, 0.4] as [number, number, number, number], mip: 2, albedo: { texture: 'decals-pages', layer: layer * 3 }, normal: { texture: 'decals-pages', layer: layer * 3 + 1 }, orm: { texture: 'decals-pages', layer: layer * 3 + 2 } });
    const array = (layers: number): THREE.DataArrayTexture => {
      const t = new THREE.DataArrayTexture(new Uint8Array(4 * 4 * 4 * layers).fill(128), 4, 4, layers);
      t.needsUpdate = true;
      return t;
    };
    const defs: MaterialDefLike[] = [
      { materialId: 'stain', name: 'stain', shader: 'decal', params: {}, textures: {}, decalPage: page(0) },
      { materialId: 'soot', name: 'soot', shader: 'decal', params: { blend: 'multiply' }, textures: {}, decalPage: page(0) },
      { materialId: 'own', name: 'own', shader: 'decal', params: {}, textures: { map: 'tex' } },
    ];
    const arrays: Record<string, THREE.Texture> = { 'decals-pages': array(6), tex: testTexture() };
    const library = createMaterialLibrary({ loadTexture: async (id) => arrays[id] ?? null });
    library.setMaterials(defs);
    const scene = litScene();
    const renderer = wgslRenderer();
    const plain: Record<string, THREE.Mesh> = {};
    const fading: Record<string, THREE.Mesh> = {};
    for (const d of defs) {
      const a = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial());
      const g = new THREE.PlaneGeometry(1, 1);
      g.setAttribute(DECAL_FADE_ATTRIBUTE, new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(0.5), 1));
      const b = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
      scene.add(a, b);
      library.apply(a, { '*': d.materialId });
      library.apply(b, { '*': d.materialId });
      plain[d.materialId] = a;
      fading[d.materialId] = b;
    }
    await settle();
    const now = Object.fromEntries(Object.entries(plain).map(([k, m]) => [k, digestOf(wgslOf(renderer, scene, m))]));
    expect(now).toEqual(MESH_DECAL_WGSL);
    for (const [k, m] of Object.entries(fading)) {
      const wgsl = wgslOf(renderer, scene, m);
      expect(wgsl, k).toContain(DECAL_FADE_ATTRIBUTE);
      expect(digestOf(wgsl)).not.toBe(now[k]);
    }
  });
});

describe('a clipped decal baked to a model', () => {
  it('is a GLB three reads back whole: the same vertices, its fade where the decal material reads it, its material named a decal', async () => {
    const g = new THREE.PlaneGeometry(4, 4, 4, 4);
    const m = clipDecal({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.3, 0.2, 0, 1], size: [1.5, 1, 1], edgeFade: [0.5, 0.5] }, [{ positions: g.getAttribute('position').array, normals: g.getAttribute('normal').array, index: g.index!.array }]);
    const bytes = decalClipGlb(m, { name: 'Grime 1', materialId: 'mat-grime' });
    const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
    let mesh: THREE.Mesh | null = null;
    gltf.scene.traverse((o) => void ((o as THREE.Mesh).isMesh === true && (mesh = o as THREE.Mesh)));
    const back = mesh! as THREE.Mesh;
    expect((back.material as THREE.Material).name).toBe(bakedDecalMaterialName('mat-grime'));
    expect(bakedDecalMaterialName('mat-grime')).toMatch(/_decal$/);
    const attr = (n: string): number[] => Array.from(back.geometry.getAttribute(n).array as Float32Array);
    expect(attr('position')).toEqual(Array.from(m.positions));
    expect(attr('uv')).toEqual(Array.from(m.uvs));
    expect(attr('tangent')).toEqual(Array.from(m.tangents));
    expect(attr(DECAL_FADE_ATTRIBUTE)).toEqual(Array.from(m.fades));
    expect(Array.from(back.geometry.index!.array)).toEqual(Array.from(m.index));
  });
});
