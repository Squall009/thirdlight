/**
 * Phase 15.3: a fading entity's meshes draw with transparent copies of their
 * materials at the runtime's opacity; a shared material is never changed; the
 * originals come back when the fade ends (or a new run shows the entity).
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createFadeTracker } from './fade';

describe('the fade tracker (a defeated enemy fading out)', () => {
  it('fades copies, never the shared material, and restores the originals', () => {
    const shared = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    shared.opacity = 0.8;
    const enemy = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
    const parts = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [shared, new THREE.MeshBasicMaterial()]);
    enemy.add(body, parts);
    const other = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared); // another entity using the same material
    const objects = new Map<string, THREE.Object3D>([['enemy-0001', enemy], ['rock-0001', other]]);
    const fades = createFadeTracker();

    fades.apply(objects, new Map([['enemy-0001', 0.5]]));
    expect(fades.faded()).toEqual(['enemy-0001']);
    const bodyMat = body.material as THREE.Material;
    expect(bodyMat).not.toBe(shared);
    expect(bodyMat.transparent).toBe(true);
    expect(bodyMat.opacity).toBeCloseTo(0.4, 9); // 0.8 × 0.5
    const [a, b] = parts.material as THREE.Material[];
    expect(a!.opacity).toBeCloseTo(0.4, 9);
    expect(b!.opacity).toBeCloseTo(0.5, 9);
    expect(shared.opacity).toBe(0.8);
    expect(shared.transparent).toBe(false);
    expect(other.material).toBe(shared);

    // the next frame lowers the same copies
    fades.apply(objects, new Map([['enemy-0001', 0.1]]));
    expect(body.material).toBe(bodyMat);
    expect(bodyMat.opacity).toBeCloseTo(0.08, 9);

    // the fade ended (the runtime hides it; no opacity row): the originals are back
    fades.apply(objects, new Map());
    expect(body.material).toBe(shared);
    expect((parts.material as THREE.Material[])[0]).toBe(shared);
    expect(fades.faded()).toEqual([]);
  });

  it('a runtime without opacities (every older one) changes nothing', () => {
    const mat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    const fades = createFadeTracker();
    fades.apply(new Map([['x', mesh]]), undefined);
    expect(mesh.material).toBe(mat);
    fades.apply(new Map([['x', mesh]]), new Map([['x', 0.3]]));
    fades.dispose();
    expect(mesh.material).toBe(mat);
  });
});
