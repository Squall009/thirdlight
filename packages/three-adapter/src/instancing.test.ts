/**
 * Phase 21.3: instance sets in chunks — the grid, one THREE.LOD per chunk
 * drawing only the level its distance asks for, picking a copy back from a
 * chunk's instance, bounds and the editor's per-copy preview.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { buildInstanceSet, chunkCopies, INSTANCE_BUFFER_FLOATS } from './instancing';
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

function lodTemplate(): { template: ModelInstance; near: THREE.BufferGeometry; far: THREE.BufferGeometry } {
  const root = new THREE.Group();
  const near = new THREE.BoxGeometry(1, 1, 1);
  const far = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  const mat = new THREE.MeshBasicMaterial();
  const lod = new THREE.LOD();
  lod.addLevel(new THREE.Mesh(near, mat), 0);
  lod.addLevel(new THREE.Mesh(far, mat), 30);
  root.add(lod);
  return { template: { glbRoot: root } as unknown as ModelInstance, near, far };
}

const instancedUnder = (o: THREE.Object3D): THREE.InstancedMesh[] => {
  const out: THREE.InstancedMesh[] = [];
  o.traverse((c) => {
    if ((c as THREE.InstancedMesh).isInstancedMesh === true) out.push(c as THREE.InstancedMesh);
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

  it('each chunk is a LOD with the template levels; the copy is found again from any level', () => {
    const { template, near, far } = lodTemplate();
    const set = buildInstanceSet(template, copies(5000, 2), 5000);
    expect(set.count).toBe(5000);
    const lods: THREE.LOD[] = [];
    set.group.traverse((o) => {
      if ((o as THREE.LOD).isLOD === true) lods.push(o as THREE.LOD);
    });
    expect(lods.length).toBeGreaterThan(1);
    expect(lods[0]!.levels.map((l) => l.distance)).toEqual([0, 30]);
    // Every copy is drawn once per level.
    const byGeo = (g: THREE.BufferGeometry): number => set.meshes.filter((m) => m.geometry === g).reduce((a, m) => a + m.count, 0);
    expect(byGeo(near)).toBe(5000);
    expect(byGeo(far)).toBe(5000);
    // A far camera shows the far level of a chunk only.
    const scene = new THREE.Scene();
    scene.add(set.group);
    scene.updateMatrixWorld(true);
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 1000, 0);
    cam.updateMatrixWorld();
    lods[0]!.update(cam);
    expect(instancedUnder(lods[0]!).filter((m) => m.parent!.visible).map((m) => m.geometry)).toEqual([far]);
    // copyOf: slot → copy, for both levels; copyBox covers the copy.
    for (const mesh of set.meshes.slice(0, 4)) {
      const copy = set.copyOf(mesh, 0)!;
      expect(copy).toBeGreaterThanOrEqual(0);
      const box = set.copyBox(copy)!;
      const f = copies(5000, 2);
      expect(box.containsPoint(new THREE.Vector3(f[copy * 10]!, f[copy * 10 + 1]!, f[copy * 10 + 2]!))).toBe(true);
    }
    expect(set.copyOf(new THREE.Object3D(), 0)).toBeNull();
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
      const slot = [...Array(mesh.count).keys()].find((s) => set.copyOf(mesh, s) === 3)!;
      mesh.getMatrixAt(slot, m);
      p.setFromMatrixPosition(m.premultiply(mesh.matrixWorld));
      expect([p.x, p.y].map((v) => Math.round(v))).toEqual([50, 5]);
    }
  });

  it('a model without LODs keeps one instanced mesh per mesh per chunk', () => {
    const root = new THREE.Group();
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
    const set = buildInstanceSet({ glbRoot: root } as unknown as ModelInstance, copies(5, 1), 5);
    expect(set.meshes).toHaveLength(1);
    expect(set.meshes[0]!.count).toBe(5);
    expect([0, 1, 2, 3, 4].map((i) => set.copyOf(set.meshes[0]!, i))).toEqual([0, 1, 2, 3, 4]);
  });
});
