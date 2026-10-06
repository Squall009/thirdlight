/**
 * What the probe bake of a scene sees, gathered from the Scene view in world
 * space: the static boxes', models' and block layers' meshes with their
 * materials (a model's most detailed level), and the scene's probe volumes
 * as world boxes.
 *
 * Browser-only (three.js).
 */
import * as THREE from 'three';
import type { BlockLayerView, ProbeBakeMesh } from '@thirdlight/three-adapter';
import type { ProbeVolumeBox } from '@thirdlight/runtime';

import type { ProjectedEntity } from '../session/projection';

export interface ProbeBakeHost {
  readonly projected: readonly ProjectedEntity[];
  /** A box's or model's drawn object, null otherwise; its meshes' world matrices are current. */
  rootOf(e: ProjectedEntity): THREE.Object3D | null;
  readonly blockView: BlockLayerView | null;
  /** An entity's world matrix (false: not realized). */
  worldMatrix(entityId: string, out: THREE.Matrix4): boolean;
}

/** The static objects' meshes (`entityIds`: static boxes, models and block layers) and their world bounds (null: none). */
export function gatherProbeMeshes(host: ProbeBakeHost, entityIds: ReadonlySet<string>): { meshes: ProbeBakeMesh[]; bounds: { min: number[]; max: number[] } | null } {
  const meshes: ProbeBakeMesh[] = [];
  const box = new THREE.Box3();
  const add = (mesh: THREE.Mesh): void => {
    meshes.push({ geometry: mesh.geometry, material: mesh.material, matrixWorld: mesh.matrixWorld.clone() });
    if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox !== null) box.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  };
  for (const e of host.projected) {
    if (!entityIds.has(e.id)) continue;
    const root = host.rootOf(e);
    if (root === null) continue;
    const visit = (o: THREE.Object3D): void => {
      const owner = (o as { entityId?: string }).entityId;
      if (o !== root && owner !== undefined && owner !== e.id) return;
      // Only the most detailed level of a LOD takes part.
      if ((o as THREE.LOD).isLOD === true) {
        const first = (o as THREE.LOD).levels[0]?.object;
        if (first !== undefined) visit(first);
        return;
      }
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh === true && (mesh as THREE.SkinnedMesh).isSkinnedMesh !== true && (mesh as THREE.InstancedMesh).isInstancedMesh !== true) add(mesh);
      for (const ch of o.children) visit(ch);
    };
    visit(root);
  }
  const view = host.blockView;
  if (view !== null) {
    view.flush();
    for (const id of view.layerIds()) if (entityIds.has(id)) for (const mesh of view.layerMeshes(id)) add(mesh);
  }
  return { meshes, bounds: box.isEmpty() ? null : { min: box.min.toArray(), max: box.max.toArray() } };
}

/** The scene's probe volumes as world boxes: centred on their entity, sized by their size times the entity's scale (axis-aligned). */
export function probeVolumesOf(host: ProbeBakeHost, sceneEntities: readonly ProjectedEntity[]): ProbeVolumeBox[] {
  const out: ProbeVolumeBox[] = [];
  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  for (const e of sceneEntities) {
    const v = e.components['probeVolume'] as { size?: number[]; spacing?: number } | undefined;
    if (v?.size === undefined || !e.active || !host.worldMatrix(e.id, m)) continue;
    m.decompose(pos, quat, scale);
    const half = new THREE.Vector3(v.size[0]! * Math.abs(scale.x), v.size[1]! * Math.abs(scale.y), v.size[2]! * Math.abs(scale.z)).multiplyScalar(0.5);
    out.push({ min: pos.clone().sub(half).toArray(), max: pos.clone().add(half).toArray(), ...(v.spacing !== undefined ? { spacing: v.spacing } : {}) });
  }
  return out;
}
