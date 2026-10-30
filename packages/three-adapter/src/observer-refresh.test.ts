/**
 * The one observer hook on three's real `NodeMaterial.setupObserver`: rules
 * compose in their fixed order whichever feature adds its rule first, and a
 * build no rule is about keeps three's own `needsRefresh`.
 */
import * as THREE from 'three';
import { NodeMaterial, type NodeBuilder } from 'three/webgpu';
import { describe, expect, it } from 'vitest';

import { addRefreshRule, type RefreshRule } from './observer-refresh';

describe('observer refresh rules', () => {
  it('wrap needsRefresh innermost first (culled copies, GPU copies, see-through), whatever order they were added in', () => {
    const asked: string[] = [];
    const rule =
      (name: string, inner: boolean): RefreshRule =>
      (needs, builder) =>
        (builder as unknown as { object: THREE.Object3D }).object.userData['ruled'] === true
          ? (renderObject, frame) => {
              asked.push(name);
              return inner ? 0 : needs(renderObject, frame);
            }
          : null;
    // Added outermost first: the order of the answers must not follow it.
    expect(addRefreshRule('see-through', rule('see-through', false))).toBe(true);
    expect(addRefreshRule('gpu-copies', rule('gpu-copies', false))).toBe(true);
    expect(addRefreshRule('culled-copies', rule('culled-copies', true))).toBe(true);

    const material = new NodeMaterial();
    const build = (object: THREE.Object3D) => material.setupObserver({ object, material, context: {} } as unknown as NodeBuilder) as unknown as { needsRefresh(renderObject: unknown, frame: unknown): number };
    const ruled = new THREE.Mesh();
    ruled.userData['ruled'] = true;
    const camera = new THREE.PerspectiveCamera();
    expect(build(ruled).needsRefresh({ object: ruled, camera }, null)).toBe(0);
    expect(asked).toEqual(['see-through', 'gpu-copies', 'culled-copies']);

    const plain = build(new THREE.Mesh());
    expect(Object.hasOwn(plain, 'needsRefresh')).toBe(false);
  });
});
