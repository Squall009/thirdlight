import { createResourceManager } from '@thirdlight/runtime';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { createDecalPages } from './decal-pages';
import type { DecalPageRefLike } from './material-library';
import { textureHolds } from './texture-holds';

/** A 64² two-layer array of 1 byte a texel per level (what a transcoded UASTC array is on the GPU). */
function pageArray(): THREE.Texture {
  const mipmaps = [64, 32, 16, 8, 4, 2, 1].map((s) => ({ data: new Uint8Array(s * s * 2), width: s, height: s }));
  return new THREE.CompressedArrayTexture(mipmaps as never, 64, 64, 2, THREE.RGBA_BPTC_Format);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('decal pages on a page', () => {
  it('held while a loaded decal names them, counted against the texture total, uploaded once, let go with the last decal', async () => {
    const resources = createResourceManager({ schedule: (run) => queueMicrotask(run) });
    const loads: string[] = [];
    const holds = textureHolds(resources, async (id) => {
      loads.push(id);
      return pageArray();
    });
    const refs: Record<string, DecalPageRefLike> = {
      'mat-a': { rect: [0, 0, 0.5, 0.5], mip: 3, albedo: { texture: 'decals-a', layer: 0 }, orm: { texture: 'decals-o', layer: 0 } },
      'mat-b': { rect: [0.5, 0, 1, 0.5], mip: 3, albedo: { texture: 'decals-a', layer: 1 } },
    };
    const pages = createDecalPages({ holds, pageOf: (id) => refs[id] ?? null });
    pages.set('d1', 'mat-a');
    pages.set('d2', 'mat-b');
    pages.set('d3', 'mat-none');
    await flush();
    // One decode per array, shared by the decals on it.
    expect(loads.sort()).toEqual(['decals-a', 'decals-o']);
    const bytes = 2 * (64 * 64 + 32 * 32 + 16 * 16 + 64 + 16 + 4 + 1) * 2;
    expect(pages.observe()).toEqual({ decals: 2, pages: 2, layers: 4, bytes, onGpu: 0, missing: 0 });
    expect(resources.observe().resident.texture).toEqual({ count: 2, bytes });
    const uploaded: THREE.Texture[] = [];
    const renderer = { initTexture: (t: THREE.Texture) => void uploaded.push(t) };
    expect(pages.upload(renderer)).toBe(true);
    expect(pages.upload(renderer)).toBe(false);
    expect(uploaded).toHaveLength(2);
    expect(pages.observe().onGpu).toBe(2);
    // The ORM array goes with the only decal on it; the albedo array stays for the other.
    pages.remove('d1');
    resources.settle();
    expect(resources.observe().resident.texture?.count).toBe(1);
    expect(pages.observe()).toMatchObject({ decals: 1, pages: 1 });
    pages.remove('d2');
    resources.settle();
    expect(resources.observe().resident.texture).toBeUndefined();
    expect(pages.observe()).toMatchObject({ decals: 0, pages: 0, bytes: 0 });
  });
});
