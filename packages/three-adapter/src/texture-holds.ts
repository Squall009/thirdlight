/**
 * Decoded textures held in the resource manager by who draws with them.
 *
 * A texture asset is decoded once per page (the manager's `texture` or
 * `environment` entry) and shared: every user that changes how it samples
 * (colour space, wrapping, tiling, a light's cookie) draws with a clone, so
 * the shared texture itself is never changed. A user holds it while it
 * draws with it and lets go when it stops; the texture (its GPU copy and its
 * `ImageBitmap`) is freed when no one holds it.
 */
import type * as THREE from 'three';
import { createResourceManager, type ResourceManager } from '@thirdlight/runtime';

import { freeTexture, textureByteSize } from './resource-bytes';

export interface TextureHolds {
  /** The decoded texture, held for `holder` (null when it is not available). */
  get(assetId: string, holder: string): Promise<THREE.Texture | null>;
  /** Stop holding one texture for `holder`. */
  release(assetId: string, holder: string): void;
  /** Stop holding everything `holder` holds. */
  releaseHolder(holder: string): void;
  /** The manager they are held in. */
  readonly resources: ResourceManager;
}

let holdsSerial = 0;

/**
 * Textures of one user (a material library, the lightmaps, the lights, the
 * environment) in `resources`, decoded by `load`. Holder names are this
 * user's own (several users share one manager).
 */
export function textureHolds(resources: ResourceManager | undefined, load: (assetId: string) => Promise<THREE.Texture | null>, kind: 'texture' | 'environment' = 'texture'): TextureHolds {
  const manager = resources ?? createResourceManager({ schedule: (run) => queueMicrotask(run) });
  holdsSerial += 1;
  const tag = `textures${holdsSerial}/`;
  const decode = (assetId: string) => async () => {
    const t = await load(assetId);
    if (t === null) throw new Error(`texture ${assetId} is not available`);
    return { value: t, bytes: textureByteSize(t), free: freeTexture };
  };
  return {
    get(assetId, holder) {
      return manager.acquire<THREE.Texture>(kind, assetId, tag + holder, decode(assetId)).catch(() => null);
    },
    release(assetId, holder) {
      manager.release(kind, assetId, tag + holder);
    },
    releaseHolder(holder) {
      manager.releaseHolder(tag + holder);
    },
    resources: manager,
  };
}
