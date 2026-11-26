import { createResourceManager } from '@thirdlight/runtime';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { textureHolds } from './texture-holds';

/** A 4×4 RGBA texture (64 bytes resident, no mipmaps). */
function texture(): THREE.Texture {
  const t = new THREE.DataTexture(new Uint8Array(4 * 4 * 4), 4, 4);
  t.generateMipmaps = false;
  return t;
}

describe('texture holds shared by the page\'s users', () => {
  it('a texture both the sky and a material name is decoded once; it stays while either holds it and is freed after the last', async () => {
    const resources = createResourceManager({ schedule: (run) => queueMicrotask(run) });
    const decodes: string[] = [];
    // Each user brings its own loader, as the environment and the material library do; both decode the same file.
    const load = async (id: string): Promise<THREE.Texture> => {
      decodes.push(id);
      return texture();
    };
    const sky = textureHolds(resources, load);
    const materials = textureHolds(resources, load);
    const fromSky = await sky.get('tex-sky', 'sky');
    const fromMaterial = await materials.get('tex-sky', 'mat-box');
    expect(decodes).toEqual(['tex-sky']);
    expect(fromMaterial).toBe(fromSky);
    expect(resources.observe().resident.texture).toEqual({ count: 1, bytes: 64 });
    // The scene with the box goes: the sky still holds it.
    materials.releaseHolder('mat-box');
    resources.settle();
    expect(resources.observe().resident.texture?.count).toBe(1);
    expect(resources.observe().frees.texture ?? 0).toBe(0);
    // The sky changes too: nobody holds it, it is freed.
    sky.release('tex-sky', 'sky');
    resources.settle();
    expect(resources.observe().resident.texture).toBeUndefined();
    expect(resources.observe().frees.texture).toBe(1);
  });

  it('a texture that is not available is null for every user and not kept', async () => {
    const resources = createResourceManager({ schedule: (run) => queueMicrotask(run) });
    const holds = textureHolds(resources, async () => null);
    expect(await holds.get('tex-missing', 'sky')).toBeNull();
    expect(resources.observe().resident.texture).toBeUndefined();
  });
});
