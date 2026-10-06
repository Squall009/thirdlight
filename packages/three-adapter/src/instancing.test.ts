/**
 * Instance sets in chunks — the grid, every copy drawn at the level its own
 * distance asks for and thinned with distance, picking a copy back from a
 * chunk's instance, bounds and the editor's per-copy preview.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { INSTANCE_MATRIX_ATTRIBUTE, type AttributeInstancedMesh } from './attribute-instancing';
import { LOD_CULL_LEVEL_KEY, LodTuning } from './lod-switch';
import { CullView, STATIC_SHADOW_CAMERA_KEY, VIEW_CULL_KEY } from './view-cull';
import { buildInstanceSet, chunkCopies, INSTANCE_BUFFER_FLOATS, INSTANCE_CHUNK_COPIES, INSTANCE_MAX_CHUNKS, INSTANCE_MAX_SPATIAL_CHUNKS } from './instancing';
import type { ModelInstance } from './visual';

function copies(n: number, spread: number): Float32Array {
  const f = new Float32Array(n * INSTANCE_BUFFER_FLOATS);
  for (let i = 0; i < n; i += 1) {
    const o = i * INSTANCE_BUFFER_FLOATS;
    f[o] = (i % 100) * spread;
    f[o + 1] = 0;
    f[o + 2] = Math.floor(i / 100) * spread;
    f[o + 6] = 1;
    f[o + 7] = 1;
    f[o + 8] = 1;
    f[o + 9] = 1;
  }
  return f;
}

function lodTemplate(cullAt?: number): { template: ModelInstance; near: THREE.BufferGeometry; far: THREE.BufferGeometry } {
  const root = new THREE.Group();
  const near = new THREE.BoxGeometry(1, 1, 1);
  const far = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  const mat = new THREE.MeshBasicMaterial();
  const lod = new THREE.LOD();
  lod.addLevel(new THREE.Mesh(near, mat), 0);
  lod.addLevel(new THREE.Mesh(far, mat), 30);
  if (cullAt !== undefined) {
    const none = new THREE.Group();
    none.userData[LOD_CULL_LEVEL_KEY] = true;
    lod.addLevel(none, cullAt);
  }
  root.add(lod);
  return { template: { glbRoot: root } as unknown as ModelInstance, near, far };
}

/** Cull every chunk mesh of `set` for a camera at `eye` looking at `at` (what the adapter's view culler does each frame). */
function view(set: { meshes: readonly THREE.Mesh[] }, eye: [number, number, number], at: [number, number, number]): CullView {
  const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
  cam.position.set(...eye);
  cam.lookAt(...at);
  cam.updateMatrixWorld();
  const v = new CullView();
  v.set(cam);
  for (const m of set.meshes) (m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).cull(v);
  return v;
}

/** The copies a chunk mesh draws in any pass (the leading `included` of its drawn buffer), as their x z positions. */
function drawnPositions(m: THREE.Mesh): [number, number][] {
  const inst = m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh;
  const out: [number, number][] = [];
  const t = new THREE.Matrix4();
  const p = new THREE.Vector3();
  for (let i = 0; i < inst.included; i += 1) {
    p.setFromMatrixPosition(matrixAt(m, i, t).premultiply(m.matrixWorld));
    out.push([Math.round(p.x), Math.round(p.z)]);
  }
  return out;
}

/** A chunk mesh draws instance-matrix columns of its own geometry (the model's attributes, shared). */
const columnsOf = (m: THREE.Mesh): THREE.InterleavedBufferAttribute | undefined => m.geometry.getAttribute(`${INSTANCE_MATRIX_ATTRIBUTE}0`) as THREE.InterleavedBufferAttribute | undefined;
const countOf = (m: THREE.Mesh): number => (m.geometry as THREE.InstancedBufferGeometry).instanceCount;
const draws = (m: THREE.Mesh, g: THREE.BufferGeometry): boolean => m.geometry.getAttribute('position') === g.getAttribute('position');
const matrixAt = (m: THREE.Mesh, i: number, out: THREE.Matrix4): THREE.Matrix4 => out.fromArray(columnsOf(m)!.data.array as Float32Array, i * 16);
const instancedUnder = (o: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh === true && columnsOf(c as THREE.Mesh) !== undefined) out.push(c as THREE.Mesh);
  });
  return out;
};

describe('instance chunks', () => {
  it('a small set is one chunk; a large one is a grid over its two widest axes, bounded', () => {
    const small = copies(500, 1);
    const pos = (f: Float32Array, n: number): Float32Array => {
      const p = new Float32Array(n * 3);
      for (let i = 0; i < n; i += 1) p.set([f[i * 10]!, f[i * 10 + 1]!, f[i * 10 + 2]!], i * 3);
      return p;
    };
    expect(new Set(chunkCopies(pos(small, 500), 500))).toEqual(new Set([0]));
    const big = copies(20_000, 0.5);
    const chunks = chunkCopies(pos(big, 20_000), 20_000);
    const used = new Set(chunks);
    expect(used.size).toBeGreaterThanOrEqual(5);
    expect(used.size).toBeLessThanOrEqual(64);
    // Neighbours share a chunk; far copies do not.
    expect(chunks[0]).toBe(chunks[1]);
    expect(chunks[0]).not.toBe(chunks[19_999]);
  });

  it('with a chunk size, no chunk is wider than it (a few copies over a wide area still split); the cells grow past the cap', () => {
    const pos = (f: Float32Array, n: number): Float32Array => {
      const p = new Float32Array(n * 3);
      for (let i = 0; i < n; i += 1) p.set([f[i * 10]!, f[i * 10 + 1]!, f[i * 10 + 2]!], i * 3);
      return p;
    };
    // 500 copies over 99 × 8 m (spread 1: x 0..99, z 0..4): by count one chunk, by a 10 m extent 10 × 1 cells.
    const few = pos(copies(500, 1), 500);
    expect(new Set(chunkCopies(few, 500)).size).toBe(1);
    const spatial = chunkCopies(few, 500, INSTANCE_CHUNK_COPIES, INSTANCE_MAX_CHUNKS, 10);
    expect(new Set(spatial).size).toBe(10);
    // Each chunk spans at most 10 m along x, and chunk numbers are dense.
    const span = new Map<number, [number, number]>();
    for (let i = 0; i < 500; i += 1) {
      const c = spatial[i]!;
      const x = few[i * 3]!;
      const s = span.get(c) ?? [Infinity, -Infinity];
      span.set(c, [Math.min(s[0], x), Math.max(s[1], x)]);
    }
    for (const [lo, hi] of span.values()) expect(hi - lo).toBeLessThanOrEqual(10);
    expect([...span.keys()].sort((a, b) => a - b)).toEqual([...Array(10).keys()]);
    // A huge set with a tiny chunk size stays within the cap.
    const huge = pos(copies(20_000, 5), 20_000);
    expect(new Set(chunkCopies(huge, 20_000, INSTANCE_CHUNK_COPIES, INSTANCE_MAX_CHUNKS, 1)).size).toBeLessThanOrEqual(INSTANCE_MAX_SPATIAL_CHUNKS);
    // buildInstanceSet reports its chunks and places each chunk at its own centre (no LOD node: copies pick levels).
    const { template } = lodTemplate();
    const set = buildInstanceSet(template, copies(500, 1), 500, 'spatial', { chunkSize: 10 });
    expect(set.chunks).toBe(10);
    expect(buildInstanceSet(lodTemplate().template, copies(500, 1), 500).chunks).toBe(1);
    const nodes: THREE.Object3D[] = [];
    set.group.traverse((o) => {
      expect((o as THREE.LOD).isLOD).not.toBe(true);
      if (o.name === 'spatial:chunk') nodes.push(o);
    });
    expect(nodes.length).toBe(10);
    expect(nodes.map((n) => Math.round(n.position.x / 10))).toEqual([...Array(10).keys()]);
    set.dispose();
  });

  it('each copy draws the level its own distance asks for, once; bias, hysteresis and the cull level apply per copy; the copy is found again from any level', () => {
    const { template, near, far } = lodTemplate(60);
    const tuning = new LodTuning();
    tuning.set({ hysteresis: 0.1 });
    // 5000 copies 2 m apart: x 0..198, z 0..98, in several chunks.
    const set = buildInstanceSet(template, copies(5000, 2), 5000, 'lod', { tuning, density: null });
    expect(set.count).toBe(5000);
    expect(set.chunks).toBeGreaterThan(1);
    const scene = new THREE.Scene();
    scene.add(set.group);
    scene.updateMatrixWorld(true);
    expect(set.meshes.every((m) => !(m instanceof THREE.InstancedMesh))).toBe(true);
    // Before any view every copy is drawn at its most detailed level only.
    const byGeo = (g: THREE.BufferGeometry): number => set.meshes.filter((m) => draws(m, g)).reduce((a, m) => a + (m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).included, 0);
    expect(byGeo(near)).toBe(5000);
    expect(byGeo(far)).toBe(0);
    // A camera above the corner (0, 0): copies nearer than 30 m near, 30–60 m far, past 60 m culled.
    const eye: [number, number, number] = [0, 10, 0];
    view(set, eye, [100, 0, 50]);
    const distance = ([x, z]: [number, number]): number => Math.hypot(x - eye[0], eye[1], z - eye[2]);
    const nearCopies = set.meshes.filter((m) => draws(m, near)).flatMap(drawnPositions);
    const farCopies = set.meshes.filter((m) => draws(m, far)).flatMap(drawnPositions);
    expect(nearCopies.length).toBeGreaterThan(50);
    expect(farCopies.length).toBeGreaterThan(nearCopies.length);
    expect(nearCopies.every((c) => distance(c) < 30)).toBe(true);
    expect(farCopies.every((c) => distance(c) >= 30 && distance(c) < 60)).toBe(true);
    let expectNear = 0;
    let expectFar = 0;
    const f = copies(5000, 2);
    for (let i = 0; i < 5000; i += 1) {
      const d = distance([f[i * 10]!, f[i * 10 + 2]!]);
      if (d < 30) expectNear += 1;
      else if (d < 60) expectFar += 1;
    }
    expect([nearCopies.length, farCopies.length]).toEqual([expectNear, expectFar]);
    const stats = set.stats();
    expect(stats.byLevel.slice(0, 2)).toEqual([expectNear, expectFar]);
    expect(stats.culled).toBe(5000 - expectNear - expectFar);
    // The first picks are no switches (nothing was drawn at another level yet).
    expect(tuning.copySwitches).toBe(0);
    // A cached static shadow map (drawn rarely, kept) draws every copy at the detailed level whatever the view; a
    // draw with no copy in any pass leaves three's walks.
    const staticCam = new THREE.OrthographicCamera();
    staticCam.userData[STATIC_SHADOW_CAMERA_KEY] = true;
    const countFor = (m: THREE.Mesh, c: THREE.Camera): number => {
      m.onBeforeRender(null as never, null as never, c, m.geometry, m.material as THREE.Material, null as never);
      return countOf(m);
    };
    expect(set.meshes.filter((m) => draws(m, near)).reduce((a, m) => a + countFor(m, staticCam), 0)).toBe(5000);
    expect(set.meshes.filter((m) => draws(m, far)).reduce((a, m) => a + countFor(m, staticCam), 0)).toBe(0);
    expect(set.meshes.filter((m) => draws(m, far) && (m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).included === 0).every((m) => !m.visible)).toBe(true);
    expect(set.meshes.filter((m) => draws(m, near)).every((m) => m.visible)).toBe(true);
    // Hysteresis: 1 m closer, the copies just past 30 m stay far (they switch back only inside 27 m); bias 2 doubles every distance.
    tuning.copySwitches = 0;
    view(set, [1, 10, 1], [101, 0, 51]);
    const stay = set.meshes.filter((m) => draws(m, far)).flatMap(drawnPositions).filter((c) => Math.hypot(c[0] - 1, 10, c[1] - 1) < 30);
    expect(stay.length).toBeGreaterThan(0);
    expect(stay.every((c) => Math.hypot(c[0] - 1, 10, c[1] - 1) >= 27)).toBe(true);
    // (Coming closer, nothing switched: the cull level too switches back only 10 % closer.)
    expect(tuning.copySwitches).toBe(0);
    tuning.set({ bias: 2 });
    view(set, eye, [100, 0, 50]);
    expect(tuning.copySwitches).toBeGreaterThan(1000);
    expect(set.meshes.filter((m) => draws(m, near)).flatMap(drawnPositions).length).toBeGreaterThan(nearCopies.length * 3);
    expect(set.stats().culled).toBeLessThan(stats.culled);
    // copyOf: slot → copy, for both levels; copyBox covers the copy.
    for (const mesh of set.meshes.slice(0, 4)) {
      const copy = set.copyOf(mesh, 0)!;
      expect(copy).toBeGreaterThanOrEqual(0);
      const box = set.copyBox(copy)!;
      expect(box.containsPoint(new THREE.Vector3(f[copy * 10]!, f[copy * 10 + 1]!, f[copy * 10 + 2]!))).toBe(true);
    }
    expect(set.copyOf(new THREE.Object3D(), 0)).toBeNull();
  });

  it('copies thin out with distance down to the set\'s minimum share, each keeping its place in the order', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
    const set = buildInstanceSet({ glbRoot: root } as unknown as ModelInstance, copies(5000, 2), 5000, 'thin', { density: { start: 0.02, end: 0.005, min: 0.25 } });
    const scene = new THREE.Scene();
    scene.add(set.group);
    scene.updateMatrixWorld(true);
    // The box's sphere (r 0.87) covers 2 % of the screen at ~93 m and 0.5 % at ~371 m.
    // From the middle, only the corners past ~93 m thin (a little).
    view(set, [100, 10, 50], [100, 0, 60]);
    expect(set.stats().thinned).toBeLessThan(50);
    view(set, [-600, 10, 50], [0, 0, 50]);
    const far = set.stats();
    expect(far.thinned / 5000).toBeGreaterThan(0.7);
    expect(far.thinned / 5000).toBeLessThan(0.8);
    const kept = new Set(set.meshes.flatMap(drawnPositions).map((c) => c.join()));
    expect(kept.size).toBe(5000 - far.thinned);
    // Halfway along the falloff more are drawn, among them every copy drawn from farther away.
    view(set, [-150, 10, 50], [0, 0, 50]);
    const mid = new Set(set.meshes.flatMap(drawnPositions).map((c) => c.join()));
    expect(mid.size).toBeGreaterThan(kept.size);
    expect([...kept].every((c) => mid.has(c))).toBe(true);
  });

  it('setCopy moves one copy in every level of its chunk', () => {
    const { template } = lodTemplate();
    const set = buildInstanceSet(template, copies(10, 2), 10);
    set.setCopy(3, [50, 5, 0, 0, 0, 0, 1, 1, 1, 1]);
    set.group.updateMatrixWorld(true);
    const box = set.copyBox(3)!;
    expect(box.containsPoint(new THREE.Vector3(50, 5, 0))).toBe(true);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    for (const mesh of set.meshes) {
      const slot = [...Array(countOf(mesh)).keys()].find((s) => set.copyOf(mesh, s) === 3)!;
      matrixAt(mesh, slot, m);
      p.setFromMatrixPosition(m.premultiply(mesh.matrixWorld));
      expect([p.x, p.y].map((v) => Math.round(v))).toEqual([50, 5]);
    }
  });

  it('a model without LODs keeps one instanced mesh per mesh per chunk', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    const set = buildInstanceSet({ glbRoot: root } as unknown as ModelInstance, copies(5, 1), 5);
    expect(set.meshes).toHaveLength(1);
    expect(countOf(set.meshes[0]!)).toBe(5);
    expect([0, 1, 2, 3, 4].map((i) => set.copyOf(set.meshes[0]!, i))).toEqual([0, 1, 2, 3, 4]);
  });

  it('a ray picks one copy of a chunk mesh (its slot as instanceId); dispose frees the chunk geometry, never the model\'s', () => {
    const root = new THREE.Group();
    const geometry = new THREE.BoxGeometry();
    let modelGeometryDisposed = 0;
    geometry.addEventListener('dispose', () => void (modelGeometryDisposed += 1));
    root.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
    // Copies along x at 0, 2, 4, 6, 8.
    const set = buildInstanceSet({ glbRoot: root } as unknown as ModelInstance, copies(5, 2), 5);
    const scene = new THREE.Scene();
    scene.add(set.group);
    scene.updateMatrixWorld(true);
    const rc = new THREE.Raycaster(new THREE.Vector3(6, 0, 10), new THREE.Vector3(0, 0, -1));
    const hits = rc.intersectObjects([...set.meshes], false);
    expect(hits.length).toBeGreaterThan(0);
    expect(set.copyOf(hits[0]!.object, hits[0]!.instanceId!)).toBe(3);
    expect(new THREE.Raycaster(new THREE.Vector3(5, 0, 10), new THREE.Vector3(0, 0, -1)).intersectObjects([...set.meshes], false)).toHaveLength(0);
    const chunkGeometry = set.meshes[0]!.geometry;
    let chunkDisposed = 0;
    chunkGeometry.addEventListener('dispose', () => void (chunkDisposed += 1));
    set.dispose();
    expect(chunkDisposed).toBe(1);
    expect(modelGeometryDisposed).toBe(0);
  });
});
