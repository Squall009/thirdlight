/**
 * Phase 12 (c): instance sets — one model drawn many times from a transform
 * buffer (10 float32 per copy: position xyz, rotation quaternion xyzw,
 * scale xyz). Each mesh of the model becomes one `THREE.InstancedMesh`
 * sharing the model's geometry and materials; the copy transform is
 * multiplied with the mesh's own offset inside the model. Used by the game
 * adapter and the editor viewport alike.
 *
 * The meshes own only their instance matrices; geometry, materials and
 * textures stay owned by the prepared model resource (released with it).
 */
import * as THREE from 'three';

import type { ModelInstance } from './visual';

/** Floats per copy in an instance buffer. */
export const INSTANCE_BUFFER_FLOATS = 10;

export interface BuiltInstanceSet {
  /** Holds the instanced meshes; attach it under the entity's node. */
  readonly group: THREE.Group;
  readonly meshes: readonly THREE.InstancedMesh[];
  /** Phase 15.2 (editor preview): redraw copy `index` at a transform (position xyz, quaternion xyzw, scale xyz). */
  setCopy(index: number, transform: readonly number[]): void;
  /** Release the instance matrices and detach (the model resource is untouched). */
  dispose(): void;
}

/**
 * Build the instanced meshes of `template` (a model instance that is not
 * attached anywhere; it stays alive while the set is shown) for the first
 * `count` copies of `floats`.
 */
export function buildInstanceSet(template: ModelInstance, floats: Float32Array, count: number, name = 'instances'): BuiltInstanceSet {
  template.glbRoot.updateMatrixWorld(true);
  const rootInverse = new THREE.Matrix4().copy(template.glbRoot.matrixWorld).invert();
  const group = new THREE.Group();
  group.name = name;
  const meshes: THREE.InstancedMesh[] = [];
  const locals: THREE.Matrix4[] = [];
  const n = Math.max(0, Math.min(count, Math.floor(floats.length / INSTANCE_BUFFER_FLOATS)));
  const place = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const rot = new THREE.Quaternion();
  const scl = new THREE.Vector3();
  template.glbRoot.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh !== true) return;
    const local = new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld);
    locals.push(local);
    const inst = new THREE.InstancedMesh(mesh.geometry, mesh.material, n);
    inst.castShadow = true;
    inst.receiveShadow = true;
    for (let i = 0; i < n; i += 1) {
      const o = i * INSTANCE_BUFFER_FLOATS;
      pos.set(floats[o]!, floats[o + 1]!, floats[o + 2]!);
      rot.set(floats[o + 3]!, floats[o + 4]!, floats[o + 5]!, floats[o + 6]!).normalize();
      scl.set(floats[o + 7]!, floats[o + 8]!, floats[o + 9]!);
      place.compose(pos, rot, scl).multiply(local);
      inst.setMatrixAt(i, place);
    }
    inst.instanceMatrix.needsUpdate = true;
    inst.computeBoundingSphere();
    meshes.push(inst);
  });
  for (const m of meshes) group.add(m);
  return {
    group,
    meshes,
    setCopy(index: number, t: readonly number[]): void {
      if (index < 0 || index >= n || t.length < INSTANCE_BUFFER_FLOATS) return;
      pos.set(t[0]!, t[1]!, t[2]!);
      rot.set(t[3]!, t[4]!, t[5]!, t[6]!).normalize();
      scl.set(t[7]!, t[8]!, t[9]!);
      meshes.forEach((m, k) => {
        place.compose(pos, rot, scl).multiply(locals[k]!);
        m.setMatrixAt(index, place);
        m.instanceMatrix.needsUpdate = true;
        m.computeBoundingSphere();
      });
    },
    dispose(): void {
      for (const m of meshes) {
        try {
          m.dispose();
        } catch {
          /* best effort */
        }
      }
      group.removeFromParent();
    },
  };
}
