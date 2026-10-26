/**
 * Materials reading the surface cache, at three's own node builder (the
 * WGSL a real build makes, no GPU): a reading variant's program walks the
 * lookup and samples the cache in place of the lights the cache holds, and
 * the same material drawn without live light builds the program it built
 * before.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createAttributeInstancedMesh } from './attribute-instancing';
import { localLightVariant } from './local-lights';
import { registerProbeLighting } from './probe-lighting';
import { SURFACE_READ } from './surface-cache-lookup';
import { SURFACE_READ_KEY, SURFACE_READ_LIVE_KEY, SURFACE_SLOT_ATTRIBUTE, SurfaceCacheTextures, surfaceReadOf } from './surface-cache-read';
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
    const tex = new SurfaceCacheTextures(4, 7);
    for (const kind of [SURFACE_READ.blocks, SURFACE_READ.terrain, SURFACE_READ.arch, SURFACE_READ.model]) {
      const w = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), localLightVariant(mat, 'pixel', { kind, textures: tex })));
      expect(w).toContain('tlSurfaceReadFound');
      // One filtered sample of the cache's texture, at an explicit level (the lookup branches).
      expect(w.match(/textureSampleLevel\(/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
      // Its own colour into the texel it read, for the probes' bounce: only a capture frame's program writes.
      expect(w).not.toMatch(/atomicStore\(/);
      expect(wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), localLightVariant(mat, 'pixel', { kind, textures: tex, capture: true })))).toMatch(/atomicStore\(/);
    }
    expect(wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), mat))).toBe(plain);
  });

  it('a static model reads by its copy\'s slot: an object\'s own, a merged cell\'s vertices, an instanced draw\'s column; a UV1 model at its UV1', () => {
    const { r, scene } = lit();
    const mat = new THREE.MeshStandardMaterial();
    const tex = new SurfaceCacheTextures(4, 7);
    const read = localLightVariant(mat, 'pixel', { kind: SURFACE_READ.model, textures: tex });
    // The slot's record is read per vertex: the point and normal in the model's root reach the pixel as varyings.
    const alone = wgslOf(r, scene, new THREE.Mesh(new THREE.BoxGeometry(), read));
    expect(alone).toContain('tlSurfaceRootPosition');
    expect(alone).toContain('tlSurfaceCopySlot');
    const merged = new THREE.BoxGeometry();
    merged.setAttribute(SURFACE_SLOT_ATTRIBUTE, new THREE.BufferAttribute(new Float32Array(merged.getAttribute('position').count), 1));
    const cell = wgslOf(r, scene, new THREE.Mesh(merged, read));
    expect(cell).toContain(SURFACE_SLOT_ATTRIBUTE);
    expect(alone).not.toContain(SURFACE_SLOT_ATTRIBUTE);
    const batch = createAttributeInstancedMesh(new THREE.BoxGeometry(), read, 4, { surfaceSlots: true });
    const drawn = wgslOf(r, scene, batch.mesh);
    expect(drawn).toContain('tlInstanceMatrix2');
    expect(drawn).not.toContain(SURFACE_SLOT_ATTRIBUTE);
    // A geometry with UV1 reads a UV1 piece's square at it; one without never does.
    const withUv1 = new THREE.BoxGeometry();
    withUv1.setAttribute('uv1', withUv1.getAttribute('uv').clone());
    expect(wgslOf(r, scene, new THREE.Mesh(withUv1, read)).length).toBeGreaterThan(alone.length);
  });

  it('variants are per kind and per page textures, and only a live scene reads', () => {
    const mat = new THREE.MeshLambertMaterial();
    const a = new SurfaceCacheTextures(4, 7);
    const b = new SurfaceCacheTextures(4, 7);
    const va = localLightVariant(mat, 'pixel', { kind: SURFACE_READ.blocks, textures: a });
    expect(localLightVariant(mat, 'pixel', { kind: SURFACE_READ.blocks, textures: a })).toBe(va);
    expect(localLightVariant(mat, 'pixel', { kind: SURFACE_READ.arch, textures: a })).not.toBe(va);
    expect((localLightVariant(mat, 'pixel', { kind: SURFACE_READ.blocks, textures: b }) as unknown as { customProgramCacheKey(): string }).customProgramCacheKey()).not.toBe((va as unknown as { customProgramCacheKey(): string }).customProgramCacheKey());
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), mat);
    mesh.userData[SURFACE_READ_KEY] = SURFACE_READ.blocks;
    expect(surfaceReadOf(mesh, scene)).toBeNull();
    scene.userData[SURFACE_READ_LIVE_KEY] = a;
    expect(surfaceReadOf(mesh, scene)).toEqual({ kind: SURFACE_READ.blocks, textures: a, capture: false });
    expect(surfaceReadOf(new THREE.Mesh(), scene)).toBeNull();
  });
});
