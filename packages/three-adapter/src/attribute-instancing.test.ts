/**
 * Picking a draw through instance-matrix columns: a hit names the instance
 * and carries the surface normal in the draw's space, the instance's turn
 * applied (pickers place their rings and brushes by it).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createAttributeInstancedMesh } from './attribute-instancing';

describe('attribute-instanced picking', () => {
  it('turns a hit normal by the instance matrix', () => {
    // A plane facing +Z, its one copy turned a quarter about Y (facing +X) and 5 m ahead.
    const inst = createAttributeInstancedMesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }), 4, { raycast: true });
    new THREE.Matrix4().makeRotationY(Math.PI / 2).setPosition(0, 0, -5).toArray(inst.array, 0);
    inst.count = 1;
    inst.markChanged();
    inst.mesh.updateMatrixWorld();
    const ray = new THREE.Raycaster(new THREE.Vector3(5, 0, -5), new THREE.Vector3(-1, 0, 0));
    const hits = ray.intersectObject(inst.mesh);
    expect(hits).toHaveLength(1);
    const h = hits[0]!;
    expect(h.instanceId).toBe(0);
    expect(h.point.x).toBeCloseTo(0, 5);
    expect(h.face!.normal.x).toBeCloseTo(1, 5);
    expect(h.face!.normal.z).toBeCloseTo(0, 5);
  });
});
