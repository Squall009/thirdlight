/**
 * Transform-mapping tests (pure; runtime.md §6).
 *
 * Unit-level: exercises the adapter's sync helper against real three.js
 * Object3Ds WITHOUT a WebGL context — it proves the mapping math
 * (position/quaternion/scale copy, three.js [x,y,z,w] quaternion order),
 * not rendering (mocks alone do not establish integration success —
 * the browser step is recorded separately in docs/handoffs/08.md).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { applyTransformToObject3D } from './sync';

describe('transform sync mapping (three-adapter/sync)', () => {
  it('copies position, quaternion and scale into the Object3D', () => {
    const obj = new THREE.Group();
    applyTransformToObject3D(obj, [1, 2, 3], [0, 0, 0, 1], [2, 3, 4]);
    expect(obj.position.x).toBe(1);
    expect(obj.position.y).toBe(2);
    expect(obj.position.z).toBe(3);
    expect(obj.quaternion.x).toBe(0);
    expect(obj.quaternion.y).toBe(0);
    expect(obj.quaternion.z).toBe(0);
    expect(obj.quaternion.w).toBe(1);
    expect(obj.scale.x).toBe(2);
    expect(obj.scale.y).toBe(3);
    expect(obj.scale.z).toBe(4);
  });

  it('quaternion order is three.js [x, y, z, w]: [0, √½, 0, √½] is a 90° rotation about Y', () => {
    const obj = new THREE.Group();
    const h = Math.SQRT1_2;
    applyTransformToObject3D(obj, [0, 0, 0], [0, h, 0, h], [1, 1, 1]);
    // Right-handed +90° about +Y maps +X → −Z; verify via matrix.
    const m = new THREE.Matrix4().makeRotationFromQuaternion(obj.quaternion);
    const v = new THREE.Vector3(1, 0, 0).applyMatrix4(m);
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(0, 12);
    expect(v.z).toBeCloseTo(-1, 12);
    // The equivalent Euler angles corroborate the mapping.
    const euler = new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ');
    expect(euler.y).toBeCloseTo(Math.PI / 2, 12);
  });

  it('overwrites previous values (idempotent per-frame sync)', () => {
    const obj = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    applyTransformToObject3D(obj, [1, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
    applyTransformToObject3D(obj, [0.2, 0.3, 0.4], [0, 0, 0.6, 0.8], [0.5, 0.5, 0.5]);
    expect(obj.position.x).toBe(0.2);
    expect(obj.position.z).toBe(0.4);
    expect(obj.quaternion.z).toBeCloseTo(0.6, 12);
    expect(obj.scale.x).toBe(0.5);
    obj.geometry.dispose();
    (obj.material as THREE.Material).dispose();
  });

  it('inputs are read-only (the tuples are never mutated)', () => {
    const obj = new THREE.Group();
    const position: readonly [number, number, number] = [1, 2, 3];
    const rotation: readonly [number, number, number, number] = [0, 0, 0, 1];
    const scale: readonly [number, number, number] = [1, 1, 1];
    const pJson = JSON.stringify(position);
    const rJson = JSON.stringify(rotation);
    const sJson = JSON.stringify(scale);
    applyTransformToObject3D(obj, position, rotation, scale);
    expect(JSON.stringify(position)).toBe(pJson);
    expect(JSON.stringify(rotation)).toBe(rJson);
    expect(JSON.stringify(scale)).toBe(sJson);
  });
});