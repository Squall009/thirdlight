/**
 * Phase 21.3: automatic instancing — grouping keys, what stays single, the
 * instance matrices, per-object overrides leaving a group, and restore.
 * Pure three.js scene graph in Node (no renderer): what is drawn is read from
 * the layers and the instanced meshes.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { BATCH_KEY, BATCHED_LAYER, batchingFromUrl, batchKey, batchKeyParts, batchRefusal, createAutoBatcher, instanceCapacity, markBatchable, triangleCount, unitBoxGeometry } from './batching';
import { addBoxLightmapUv } from './lightmaps';
import { OVERRIDES_KEY } from './material-graph';

const camera = (): THREE.PerspectiveCamera => {
  const c = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  c.position.set(0, 0, 20);
  return c;
};

function batchesOf(scene: THREE.Scene): THREE.InstancedMesh[] {
  const out: THREE.InstancedMesh[] = [];
  scene.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh === true && o.userData['tlBatch'] === true) out.push(o as THREE.InstancedMesh);
  });
  return out;
}

const drawnAlone = (m: THREE.Mesh): boolean => m.layers.mask === 1;

describe('batch keys', () => {
  it('group by draw geometry, material and shadow flags', () => {
    const g = new THREE.BoxGeometry();
    const a = new THREE.MeshLambertMaterial();
    const b = new THREE.MeshLambertMaterial();
    const mk = (mat: THREE.Material, cast = true): THREE.Mesh => {
      const m = new THREE.Mesh(g, mat);
      m.castShadow = cast;
      m.userData[BATCH_KEY] = true;
      return m;
    };
    const key = (m: THREE.Mesh): string => batchKey(batchKeyParts(m)!, null, 64);
    expect(key(mk(a))).toBe(key(mk(a)));
    expect(key(mk(a))).not.toBe(key(mk(b)));
    expect(key(mk(a))).not.toBe(key(mk(a, false)));
    // A cell only for detailed geometry, and it separates far objects.
    expect(batchKey(batchKeyParts(mk(a))!, [1, 1, 1], 64)).not.toBe(batchKey(batchKeyParts(mk(a))!, [100, 1, 1], 64));
    expect(batchKey(batchKeyParts(mk(a))!, [1, 1, 1], 64)).toBe(batchKey(batchKeyParts(mk(a))!, [60, 2, 3], 64));
  });

  it('a box hint draws the shared unit box scaled by its size', () => {
    const unit = unitBoxGeometry(addBoxLightmapUv);
    expect(unit.getAttribute('uv1')).toBeDefined();
    const mat = new THREE.MeshLambertMaterial();
    const m1 = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4), mat);
    const m2 = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 5), mat);
    m1.userData[BATCH_KEY] = { geometry: unit, scale: [2, 3, 4] };
    m2.userData[BATCH_KEY] = { geometry: unit, scale: [1, 1, 5] };
    expect(batchKey(batchKeyParts(m1)!, null, 64)).toBe(batchKey(batchKeyParts(m2)!, null, 64));
    expect(batchKeyParts(m1)!.geometry).toBe(unit);
  });

  it('refuses what cannot share one draw', () => {
    const g = new THREE.BoxGeometry();
    const mk = (mat: THREE.Material | THREE.Material[]): THREE.Mesh => {
      const m = new THREE.Mesh(g, mat);
      m.userData[BATCH_KEY] = true;
      return m;
    };
    expect(batchRefusal(new THREE.Mesh(g, new THREE.MeshBasicMaterial()))).toBe('not marked');
    expect(batchRefusal(mk(new THREE.MeshBasicMaterial({ transparent: true })))).toBe('transparent');
    expect(batchRefusal(mk([new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()]))).toBe('several materials');
    const ordered = mk(new THREE.MeshBasicMaterial());
    ordered.renderOrder = 3;
    expect(batchRefusal(ordered)).toBe('render order');
    const hooked = mk(new THREE.MeshBasicMaterial());
    hooked.onBeforeRender = () => undefined;
    expect(batchRefusal(hooked)).toBe('custom onBeforeRender');
    const params = mk(new THREE.MeshBasicMaterial());
    params.userData[OVERRIDES_KEY] = { d: { rough: 1 } };
    expect(batchRefusal(params)).toBe('per-object material parameters');
    const layered = mk(new THREE.MeshBasicMaterial());
    layered.layers.set(2);
    expect(batchRefusal(layered)).toBe('layers');
    const inst = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial(), 2);
    inst.userData[BATCH_KEY] = true;
    expect(batchRefusal(inst)).toBe('already instanced');
    expect(triangleCount(g)).toBe(12);
  });

  it('markBatchable marks plain meshes, not instanced ones', () => {
    const root = new THREE.Group();
    const a = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 3);
    root.add(a, inst);
    markBatchable(root);
    expect(a.userData[BATCH_KEY]).toBe(true);
    expect(inst.userData[BATCH_KEY]).toBeUndefined();
  });
});

describe('auto batcher', () => {
  function scene3(): { scene: THREE.Scene; meshes: THREE.Mesh[]; mat: THREE.MeshLambertMaterial; geo: THREE.BoxGeometry } {
    const scene = new THREE.Scene();
    const geo = new THREE.BoxGeometry();
    const mat = new THREE.MeshLambertMaterial({ color: 0x808080 });
    const meshes = [0, 1, 2].map((i) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(i * 2, 0, 0);
      m.userData[BATCH_KEY] = true;
      scene.add(m);
      return m;
    });
    return { scene, meshes, mat, geo };
  }

  it('draws identical meshes as one instanced mesh with their world matrices', () => {
    const { scene, meshes } = scene3();
    const b = createAutoBatcher(scene, { minGroup: 2 });
    b.update(camera());
    const batches = batchesOf(scene);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.count).toBe(3);
    expect(meshes.every((m) => m.layers.isEnabled(BATCHED_LAYER) && !m.layers.isEnabled(0))).toBe(true);
    const m = new THREE.Matrix4();
    batches[0]!.getMatrixAt(2, m);
    expect(m.elements[12]).toBe(4);
    expect(b.diagnostics()).toEqual({ groups: 1, batched: 3, single: 0 });
    // Moving a member (a gizmo drag, the game's transform sync) moves its instance on the next frame.
    meshes[1]!.position.y = 5;
    b.update(camera());
    batches[0]!.getMatrixAt(1, m);
    expect(m.elements[13]).toBe(5);
    // The same instanced mesh is kept (three compiles per instanced object).
    expect(batchesOf(scene)[0]).toBe(batches[0]);
    // Nothing moved: the matrices are not uploaded again (float32 compare, not float64).
    meshes[0]!.rotation.set(0.3, 0.7, 0.1);
    b.update(camera());
    const version = batches[0]!.instanceMatrix.version;
    b.update(camera());
    b.update(camera());
    expect(batches[0]!.instanceMatrix.version).toBe(version);
  });

  it('children of a hidden object and hidden objects leave the group', () => {
    const { scene, meshes } = scene3();
    const b = createAutoBatcher(scene, { minGroup: 2 });
    b.update(camera());
    meshes[0]!.visible = false;
    b.update(camera());
    expect(batchesOf(scene)[0]!.count).toBe(2);
    expect(drawnAlone(meshes[0]!)).toBe(true);
  });

  it('a per-object material copy (the selection highlight, a glow) takes the mesh out; a lone member draws alone', () => {
    const { scene, meshes, mat } = scene3();
    const b = createAutoBatcher(scene, { minGroup: 2 });
    b.update(camera());
    meshes[2]!.material = mat.clone();
    b.update(camera());
    expect(batchesOf(scene)[0]!.count).toBe(2);
    expect(drawnAlone(meshes[2]!)).toBe(true);
    meshes[1]!.material = mat.clone();
    b.update(camera());
    expect(batchesOf(scene)).toHaveLength(0);
    expect(meshes.every(drawnAlone)).toBe(true);
    expect(b.diagnostics()).toEqual({ groups: 0, batched: 0, single: 3 });
  });

  it('box hints: one draw for boxes of every size, each instance scaled by its size', () => {
    const scene = new THREE.Scene();
    const unit = unitBoxGeometry(addBoxLightmapUv);
    const mat = new THREE.MeshStandardMaterial();
    const sizes = [[1, 2, 3], [4, 1, 1], [0.5, 0.5, 0.5]] as const;
    for (const s of sizes) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(s[0], s[1], s[2]), mat);
      m.userData[BATCH_KEY] = { geometry: unit, scale: s };
      m.scale.set(2, 1, 1);
      scene.add(m);
    }
    createAutoBatcher(scene, { minGroup: 2 }).update(camera());
    const [batch] = batchesOf(scene);
    expect(batch!.geometry).toBe(unit);
    const m = new THREE.Matrix4();
    batch!.getMatrixAt(0, m);
    const s = new THREE.Vector3();
    m.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    expect([s.x, s.y, s.z].map((v) => Number(v.toFixed(5)))).toEqual([2, 2, 3]);
  });

  it('LOD levels: only the level shown is batched', () => {
    const scene = new THREE.Scene();
    const mat = new THREE.MeshBasicMaterial();
    const near = new THREE.BoxGeometry();
    const far = new THREE.BoxGeometry(0.9, 0.9, 0.9);
    const lods: THREE.Mesh[][] = [];
    for (let i = 0; i < 3; i += 1) {
      const lod = new THREE.LOD();
      const a = new THREE.Mesh(near, mat);
      const f = new THREE.Mesh(far, mat);
      a.userData[BATCH_KEY] = true;
      f.userData[BATCH_KEY] = true;
      lod.addLevel(a, 0);
      lod.addLevel(f, 50);
      lod.position.x = i;
      scene.add(lod);
      lods.push([a, f]);
    }
    const cam = camera();
    const b = createAutoBatcher(scene, { minGroup: 2 });
    b.update(cam);
    expect(batchesOf(scene).map((x) => x.geometry)).toEqual([near]);
    cam.position.z = 500;
    b.update(cam);
    expect(batchesOf(scene).map((x) => x.geometry)).toEqual([far]);
    expect(lods.every(([a]) => drawnAlone(a!))).toBe(true);
  });

  it('detailed geometry is split by world cell; cheap geometry is not', () => {
    const scene = new THREE.Scene();
    const detailed = new THREE.SphereGeometry(1, 32, 16);
    const cheap = new THREE.BoxGeometry();
    const mat = new THREE.MeshBasicMaterial();
    for (const x of [0, 1, 200, 201]) {
      for (const g of [detailed, cheap]) {
        const m = new THREE.Mesh(g, mat);
        m.position.x = x;
        m.userData[BATCH_KEY] = true;
        scene.add(m);
      }
    }
    createAutoBatcher(scene, { minGroup: 2 }).update(camera());
    const batches = batchesOf(scene);
    expect(batches.filter((x) => x.geometry === detailed).map((x) => x.count)).toEqual([2, 2]);
    expect(batches.filter((x) => x.geometry === cheap).map((x) => x.count)).toEqual([4]);
  });

  it('disabling or disposing restores every member', () => {
    const { scene, meshes } = scene3();
    const b = createAutoBatcher(scene, { minGroup: 2 });
    b.update(camera());
    b.setEnabled(false);
    expect(meshes.every(drawnAlone)).toBe(true);
    expect(batchesOf(scene)).toHaveLength(0);
    b.setEnabled(true);
    b.update(camera());
    expect(batchesOf(scene)).toHaveLength(1);
    b.dispose();
    expect(meshes.every(drawnAlone)).toBe(true);
    expect(scene.children.some((c) => c.name === 'tl-batches')).toBe(false);
  });

  it('by default a group needs four members; slots above the uniform-buffer limit (one shader program per material)', () => {
    const { scene, meshes, mat, geo } = scene3();
    const b = createAutoBatcher(scene);
    b.update(camera());
    expect(batchesOf(scene)).toHaveLength(0);
    expect(meshes.every(drawnAlone)).toBe(true);
    const fourth = new THREE.Mesh(geo, mat);
    fourth.userData[BATCH_KEY] = true;
    scene.add(fourth);
    b.update(camera());
    const [batch] = batchesOf(scene);
    expect(batch!.count).toBe(4);
    expect(batch!.instanceMatrix.count).toBe(1025);
    expect([1, 100, 1025, 1026, 3000].map(instanceCapacity)).toEqual([1025, 1025, 1025, 2050, 4100]);
  });

  it('the page flag turns batching off', () => {
    expect(batchingFromUrl('')).toBe(true);
    expect(batchingFromUrl('?renderer=webgl2')).toBe(true);
    expect(batchingFromUrl('?batching=off')).toBe(false);
    expect(batchingFromUrl('?x=1&batching=0')).toBe(false);
  });

  it('a raycaster that enables the batched layer still hits members', () => {
    const { scene, meshes } = scene3();
    createAutoBatcher(scene, { minGroup: 2 }).update(camera());
    const rc = new THREE.Raycaster(new THREE.Vector3(4, 0, 10), new THREE.Vector3(0, 0, -1));
    expect(rc.intersectObjects(meshes, false)).toHaveLength(0);
    rc.layers.enable(BATCHED_LAYER);
    const hits = rc.intersectObjects(scene.children, true);
    expect(hits[0]?.object).toBe(meshes[2]);
  });
});
