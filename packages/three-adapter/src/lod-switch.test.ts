import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { pickLodLevel } from './lod-switch';

describe('pickLodLevel', () => {
  it("picks the level three's LOD.update shows, with its hysteresis, along a walk out and back", () => {
    const lod = new THREE.LOD();
    lod.addLevel(new THREE.Object3D(), 0);
    lod.addLevel(new THREE.Object3D(), 10, 0.1);
    lod.addLevel(new THREE.Object3D(), 25, 0.2);
    lod.addLevel(new THREE.Object3D(), 60);
    const camera = new THREE.PerspectiveCamera();
    let ours = -1;
    const steps = [...Array.from({ length: 160 }, (_, i) => i * 0.5), ...Array.from({ length: 160 }, (_, i) => 80 - i * 0.5)];
    for (const d of steps) {
      camera.position.set(0, 0, d);
      camera.updateMatrixWorld();
      lod.update(camera);
      ours = pickLodLevel(lod.levels, d, ours);
      expect(ours, `at ${d} m`).toBe(lod.getCurrentLevel());
    }
  });

  it('draws the only level of a LOD with one', () => {
    expect(pickLodLevel([{ distance: 0, hysteresis: 0 }], 1000, -1)).toBe(0);
  });
});
