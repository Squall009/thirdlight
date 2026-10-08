/**
 * Instance sets in chunks — the grid, every copy drawn at the level its own
 * distance asks for and thinned with distance, picking a copy back from a
 * chunk's instance, bounds and the editor's per-copy preview.
 */
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

import { INSTANCE_MATRIX_ATTRIBUTE, withEmptyInstanceDraws, type AttributeInstancedMesh } from './attribute-instancing';
import { ChunkLodPicker, REPICK_MOVE_FRACTION, TAN_HALF_REFERENCE } from './instance-lod';
import { hemiOctDecode, hemiOctEncode } from './impostor';
import { LOD_CULL_LEVEL_KEY, LodTuning } from './lod-switch';
import { CullView, STATIC_SHADOW_CAMERA_KEY, VIEW_CULL_KEY, ViewCuller } from './view-cull';
import { buildInstanceSet, chunkCopies, instanceSetPlan, INSTANCE_BUFFER_FLOATS, INSTANCE_CHUNK_COPIES, INSTANCE_MAX_CHUNKS, INSTANCE_MAX_SPATIAL_CHUNKS } from './instancing';
import { prepareInstanceSet } from './instance-prepare';
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
    const set = buildInstanceSet(template, copies(5000, 2), 5000, 'lod', { tuning, density: null, lodPerCopy: true });
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
    // A cached static shadow map (drawn rarely, kept) draws every copy of a set that casts at the detailed level
    // whatever the view; a draw with no copy in any pass leaves three's walks. A set that casts nothing never
    // writes (nor uploads) the copies the view does not draw.
    const staticCam = new THREE.OrthographicCamera();
    staticCam.userData[STATIC_SHADOW_CAMERA_KEY] = true;
    {
      const m = set.meshes.find((x) => draws(x, near) && (x.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).included > 0)!;
      m.onBeforeRender(null as never, null as never, staticCam, m.geometry, m.material as THREE.Material, null as never);
      expect(countOf(m)).toBe(0);
    }
    for (const m of set.meshes) m.castShadow = true;
    view(set, eye, [100, 0, 50.5]);
    staticCam.userData[STATIC_SHADOW_CAMERA_KEY] = true;
    const countFor = (m: THREE.Mesh, c: THREE.Camera): number => {
      m.onBeforeRender(null as never, null as never, c, m.geometry, m.material as THREE.Material, null as never);
      return countOf(m);
    };
    expect(set.meshes.filter((m) => draws(m, near)).reduce((a, m) => a + countFor(m, staticCam), 0)).toBe(5000);
    expect(set.meshes.filter((m) => draws(m, far)).reduce((a, m) => a + countFor(m, staticCam), 0)).toBe(0);
    expect(set.meshes.filter((m) => draws(m, far) && (m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).included === 0).every((m) => !m.visible)).toBe(true);
    // Detailed-level draws holding no copy in the view's passes are hidden too, and shown while the static map is drawn.
    const nearMeshes = set.meshes.filter((m) => draws(m, near));
    const emptyNear = nearMeshes.filter((m) => (m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).included === 0);
    expect(emptyNear.length).toBeGreaterThan(0);
    expect(nearMeshes.every((m) => m.visible === !emptyNear.includes(m))).toBe(true);
    let shownWhileStatic = false;
    withEmptyInstanceDraws(() => (shownWhileStatic = set.meshes.every((m) => m.visible)));
    expect(shownWhileStatic).toBe(true);
    expect(emptyNear.every((m) => !m.visible)).toBe(true);
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

  it('by default a chunk draws one level for all its copies, picked at its centre for their mean size', () => {
    const { template, near, far } = lodTemplate();
    // 20 copies in a 2 m row (x 0..1.9) across the 30 m switch: the centre's side of it decides for all of them.
    const levelsFrom = (eyeX: number, lodPerCopy: boolean): number[] => {
      const set = buildInstanceSet(template, copies(20, 0.1), 20, 'chunked', { density: null, lodPerCopy });
      set.group.updateMatrixWorld(true);
      view(set, [eyeX, 0, 0], [10, 0, 0]);
      const levels = [near, far].map((g) => set.meshes.filter((m) => draws(m, g)).reduce((a, m) => a + (m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).included, 0));
      set.dispose();
      return levels;
    };
    expect(levelsFrom(-29.2, false)).toEqual([0, 20]);
    expect(levelsFrom(-28.5, false)).toEqual([20, 0]);
    // Per copy the same set splits across the switch (a draw per level).
    const split = levelsFrom(-29, true);
    expect(split[0]).toBeGreaterThan(0);
    expect(split[1]).toBeGreaterThan(0);
  });

  it('picks are made again only when the eye moved past a share of its distance, not when the view turned', () => {
    const { template, far } = lodTemplate(400);
    const set = buildInstanceSet(template, copies(5000, 2), 5000, 'repick', { density: null });
    const scene = new THREE.Scene();
    scene.add(set.group);
    scene.updateMatrixWorld(true);
    const pick = vi.spyOn(ChunkLodPicker.prototype as unknown as { pick: () => boolean }, 'pick');
    // From 100 m off the set's edge every chunk's nearest copy is ≥ 100 m away: picks hold within 1 m.
    view(set, [-100, 10, 50], [100, 0, 50]);
    expect(pick.mock.calls.length).toBe(set.chunks);
    const farDrawn = set.meshes.filter((m) => draws(m, far)).flatMap(drawnPositions).length;
    expect(farDrawn).toBeGreaterThan(0);
    pick.mockClear();
    view(set, [-100, 10, 50], [100, 0, 0]);
    view(set, [-100 + 100 * REPICK_MOVE_FRACTION * 0.5, 10, 50], [100, 0, 50]);
    expect(pick.mock.calls.length).toBe(0);
    view(set, [-100 + 100 * REPICK_MOVE_FRACTION * 3, 10, 50], [100, 0, 50]);
    expect(pick.mock.calls.length).toBe(set.chunks);
    pick.mockRestore();
    set.dispose();
  });

  it('a chunk\'s draws listed one by one (as the render graph lists drawables) are culled through their chunk, once a frame', () => {
    const { template, far } = lodTemplate();
    const set = buildInstanceSet(template, copies(500, 1), 500, 'listed', { density: null });
    set.group.updateMatrixWorld(true);
    const culler = new ViewCuller();
    for (const m of set.meshes) culler.listed(m);
    expect(culler.diagnostics().draws).toBe(set.chunks);
    const cam = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);
    cam.position.set(-40, 10, 2);
    cam.lookAt(50, 0, 2);
    cam.updateMatrixWorld();
    culler.update(cam);
    expect(set.meshes.filter((m) => draws(m, far)).flatMap(drawnPositions).length).toBeGreaterThan(0);
    // A still view and chunk: nothing is culled again; a moved copy culls its chunk again.
    const cull = vi.spyOn(set.meshes[0]!.userData[VIEW_CULL_KEY] as AttributeInstancedMesh, 'cull');
    culler.update(cam);
    expect(cull).not.toHaveBeenCalled();
    set.setCopy(0, [-38, 0, 2, 0, 0, 0, 1, 1, 1, 1]);
    culler.update(cam);
    expect(cull).toHaveBeenCalledTimes(1);
    // The chunk stays while any of its draws is listed.
    for (const m of set.meshes.slice(1)) culler.unlisted(m);
    expect(culler.diagnostics().draws).toBe(set.chunks);
    culler.unlisted(set.meshes[0]!);
    expect(culler.diagnostics().draws).toBe(0);
    set.dispose();
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

  it('setCopy moves one copy in every level of its chunk that draws it', () => {
    const { template } = lodTemplate();
    const set = buildInstanceSet(template, copies(10, 2), 10);
    set.setCopy(3, [50, 5, 0, 0, 0, 0, 1, 1, 1, 1]);
    set.group.updateMatrixWorld(true);
    const box = set.copyBox(3)!;
    expect(box.containsPoint(new THREE.Vector3(50, 5, 0))).toBe(true);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let found = 0;
    for (const mesh of set.meshes) {
      const slot = [...Array((mesh.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).included).keys()].find((s) => set.copyOf(mesh, s) === 3);
      if (slot === undefined) continue;
      found += 1;
      matrixAt(mesh, slot, m);
      p.setFromMatrixPosition(m.premultiply(mesh.matrixWorld));
      expect([p.x, p.y].map((v) => Math.round(v))).toEqual([50, 5]);
    }
    expect(found).toBeGreaterThan(0);
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

describe('instance set arithmetic (the worker\'s and the page\'s)', () => {
  it('equals three\'s compose × offset per copy, and three\'s sphere union per draw', () => {
    // Turned, scaled copies of a model whose mesh sits off its origin, turned itself.
    const root = new THREE.Group();
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.5, 2, 7), new THREE.MeshBasicMaterial());
    mesh.position.set(0.25, 1, -0.5);
    mesh.quaternion.setFromEuler(new THREE.Euler(0.2, 0.7, -0.1));
    root.add(mesh);
    const n = 300;
    const f = new Float32Array(n * INSTANCE_BUFFER_FLOATS);
    for (let i = 0; i < n; i += 1) {
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(i * 0.01, i * 0.37, 0));
      // Not quite unit: the build normalizes as three does.
      f.set([i * 3.7, Math.sin(i) * 4, (i % 17) * 5.1, q.x * 1.001, q.y * 1.001, q.z * 1.001, q.w * 1.001, 1 + (i % 5) * 0.3, 1 + (i % 5) * 0.3, 1 + (i % 5) * 0.3], i * INSTANCE_BUFFER_FLOATS);
    }
    const template = { glbRoot: root } as unknown as ModelInstance;
    const plan = instanceSetPlan(template, { chunkSize: 200 });
    const prepared = prepareInstanceSet(f, n, plan.prepareParts, plan.prepareOptions);
    expect(prepared.chunks.length).toBeGreaterThan(1);
    root.updateMatrixWorld(true);
    const local = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld);
    const expected = new Float32Array(16);
    for (const chunk of prepared.chunks) {
      const center = new THREE.Vector3();
      for (const i of chunk.copies) center.add(new THREE.Vector3(f[i * 10]!, f[i * 10 + 1]!, f[i * 10 + 2]!));
      center.divideScalar(chunk.copies.length);
      expect([...chunk.center]).toEqual([center.x, center.y, center.z]);
      const sphere = new THREE.Sphere();
      sphere.makeEmpty();
      chunk.copies.forEach((i, slot) => {
        const o = i * 10;
        const place = new THREE.Matrix4().compose(new THREE.Vector3(f[o]! - center.x, f[o + 1]! - center.y, f[o + 2]! - center.z), new THREE.Quaternion(f[o + 3]!, f[o + 4]!, f[o + 5]!, f[o + 6]!).normalize(), new THREE.Vector3(f[o + 7]!, f[o + 8]!, f[o + 9]!));
        new THREE.Matrix4().multiplyMatrices(place, local).toArray(expected);
        expect([...chunk.matrices[0]!.subarray(slot * 16, slot * 16 + 16)]).toEqual([...expected]);
        sphere.union(mesh.geometry.boundingSphere!.clone().applyMatrix4(new THREE.Matrix4().fromArray(chunk.matrices[0]!, slot * 16)));
      });
      expect([...chunk.bounds]).toEqual([sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius]);
    }
    // A set built from the prepared arithmetic draws the same matrices as one built on the page.
    const a = buildInstanceSet(template, f, n, 'a', { chunkSize: 200 });
    const b = buildInstanceSet(template, f, n, 'b', { chunkSize: 200, prepared: prepareInstanceSet(f, n, plan.prepareParts, plan.prepareOptions) });
    expect(a.meshes.map((m) => [...(m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).array])).toEqual(b.meshes.map((m) => [...(m.userData[VIEW_CULL_KEY] as AttributeInstancedMesh).array]));
    a.dispose();
    b.dispose();
  });
});

describe('an impostor as a set\'s far level', () => {
  const quad = (): THREE.Mesh => new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());

  it('takes over below its screen size: the levels past it go, a cull level past it stays', () => {
    const { template, near } = lodTemplate(400);
    const plain = instanceSetPlan(template);
    expect(plain.groups).toEqual([{ distances: [0, 30, 400], culls: true }]);
    // Its distance: where the model's radius covers the size (as the model's own levels switch).
    const at = (size: number): number => plain.radius / (TAN_HALF_REFERENCE * size);
    const mesh = quad();
    // Past the second level: both levels kept, the impostor third, then the cull.
    const far = instanceSetPlan(template, { impostor: { mesh, size: plain.radius / (TAN_HALF_REFERENCE * 100) } });
    expect(far.groups[0]!.distances.map(Math.round)).toEqual([0, 30, 100, 400]);
    expect(far.parts.map((p) => [p.mesh === mesh ? 'impostor' : p.mesh.geometry === near ? 'near' : 'far', p.level])).toEqual([['near', 0], ['far', 1], ['impostor', 2]]);
    // Before the second level: it goes.
    const early = instanceSetPlan(template, { impostor: { mesh, size: plain.radius / (TAN_HALF_REFERENCE * 20) } });
    expect(early.groups[0]!.distances.map(Math.round)).toEqual([0, 20, 400]);
    expect(early.groups[0]!.culls).toBe(true);
    expect(at(0.05)).toBeCloseTo(plain.radius / (TAN_HALF_REFERENCE * 0.05), 9);
    expect(early.parts.map((p) => [p.mesh === mesh ? 'impostor' : p.mesh.geometry === near ? 'near' : 'far', p.level])).toEqual([['near', 0], ['impostor', 1]]);
    // A model without levels: its meshes near, the impostor far.
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial()));
    const single = instanceSetPlan({ glbRoot: root } as unknown as ModelInstance, { impostor: { mesh, size: 0.05 } });
    expect(single.groups).toEqual([{ distances: [0, single.radius / (TAN_HALF_REFERENCE * 0.05)], culls: false }]);
    expect(single.parts.map((p) => [p.lod, p.level])).toEqual([[0, 0], [0, 1]]);
  });

  it('the bake\'s directions and the draw\'s agree (the hemi-octahedral grid)', () => {
    for (const [u, v] of [[0, 0], [1, 1], [0.3, 0.7], [0.5, 0.1], [1 / 7, 4 / 7]] as const) {
      const d = hemiOctDecode(u, v);
      expect(Math.hypot(...d)).toBeCloseTo(1, 6);
      expect(d[1]).toBeGreaterThanOrEqual(0);
      const [eu, ev] = hemiOctEncode(...d);
      expect(eu).toBeCloseTo(u, 6);
      expect(ev).toBeCloseTo(v, 6);
    }
    // Straight up is the middle; the edges are the horizon.
    expect(hemiOctEncode(0, 1, 0)).toEqual([0.5, 0.5]);
    expect(hemiOctDecode(1, 0.5)[1]).toBeCloseTo(0, 6);
  });
});
