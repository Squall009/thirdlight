/**
 * Materials reading the surface cache, at three's own node builder (the
 * WGSL a real build makes, no GPU): a reading variant's program walks the
 * lookup and samples the cache in place of the lights the cache holds, and
 * the same material drawn without live light builds the program it built
 * before.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { localLightVariant } from './local-lights';
import { registerProbeLighting } from './probe-lighting';
import { SURFACE_READ } from './surface-cache-lookup';
import { SURFACE_READ_KEY, SURFACE_READ_LIVE_KEY, SurfaceCacheTextures, surfaceReadOf } from './surface-cache-read';
import { litScene, wgslOf, wgslRenderer } from './test-wgsl';

function lit(): { r: ReturnType<typeof wgslRenderer>; scene: THREE.Scene } {
  const r = wgslRenderer();
  registerProbeLighting(r as never);
  const scene = litScene();
  scene.add(new THREE.PointLight('#ffffff', 2));
  return { r, scene };
}

describe('materials reading the surface cache', () => {
  it('a reading build looks its texel up and samples the cache; the same material not reading keeps its program', () => {
    const { r, scene } = lit();
    const mat = new THREE.MeshStandardMaterial();
    const plain = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), mat));
    expect(plain).not.toContain('tlSurfaceReadFound');
    const tex = new SurfaceCacheTextures();
    for (const kind of [SURFACE_READ.blocks, SURFACE_READ.terrain, SURFACE_READ.arch]) {
      const w = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), localLightVariant(mat, 'pixel', { kind, textures: tex })));
      expect(w).toContain('tlSurfaceReadFound');
      // One filtered sample of the cache's texture, at an explicit level (the lookup branches).
      expect(w.match(/textureSampleLevel\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    }
    expect(wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), mat))).toBe(plain);
  });

  it('variants are per kind and per page textures, and only a live scene reads', () => {
    const mat = new THREE.MeshLambertMaterial();
    const a = new SurfaceCacheTextures();
    const b = new SurfaceCacheTextures();
    const va = localLightVariant(mat, 'pixel', { kind: SURFACE_READ.blocks, textures: a });
    expect(localLightVariant(mat, 'pixel', { kind: SURFACE_READ.blocks, textures: a })).toBe(va);
    expect(localLightVariant(mat, 'pixel', { kind: SURFACE_READ.arch, textures: a })).not.toBe(va);
    expect((localLightVariant(mat, 'pixel', { kind: SURFACE_READ.blocks, textures: b }) as unknown as { customProgramCacheKey(): string }).customProgramCacheKey()).not.toBe((va as unknown as { customProgramCacheKey(): string }).customProgramCacheKey());
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    mesh.userData[SURFACE_READ_KEY] = SURFACE_READ.blocks;
    expect(surfaceReadOf(mesh, scene)).toBeNull();
    scene.userData[SURFACE_READ_LIVE_KEY] = a;
    expect(surfaceReadOf(mesh, scene)).toEqual({ kind: SURFACE_READ.blocks, textures: a });
    expect(surfaceReadOf(new THREE.Mesh(), scene)).toBeNull();
  });
});
