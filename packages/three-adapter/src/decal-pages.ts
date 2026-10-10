/**
 * The decal pages a game page holds: the texture arrays the build made of
 * its decal materials' images (project-model `decal-pages.ts`), each held in
 * the page's resource manager while a loaded decal names a material on it
 * and let go when the last such decal goes (its scene unloaded, the object
 * removed), so pages stream with the scenes that use them. They count
 * against the project's texture budget as every texture that does not
 * stream does (the manager's texture total), and they are uploaded to the
 * GPU as they arrive, before anything samples them, so the frame that first
 * draws a decal does not pay for the upload.
 *
 * A decal's material is held by its entity, not by a mesh: a projected decal
 * has no mesh of its own.
 */
import type * as THREE from 'three';

import type { DecalPageRefLike } from './material-library';
import { textureByteSize } from './resource-bytes';
import type { TextureHolds } from './texture-holds';

const SETS = ['albedo', 'normal', 'orm'] as const;

/** What the page holds (diagnostics `renderer.decals`). */
export interface DecalPagesObservation {
  /** Loaded decals whose material has a place on the pages. */
  readonly decals: number;
  /** Page arrays held and decoded. */
  readonly pages: number;
  /** Their layers (pages) in all. */
  readonly layers: number;
  /** Their GPU bytes (every level of every layer). */
  readonly bytes: number;
  /** Of `pages`, uploaded to the GPU. */
  readonly onGpu: number;
  /** Arrays a decal names that could not be loaded. */
  readonly missing: number;
}

export interface AdapterDecalPages {
  /** A decal entity's material (null: it has no decal any more). */
  set(entityId: string, materialId: string | null): void;
  remove(entityId: string): void;
  /** The materials' places changed (new definitions): every decal takes its material's arrays again. */
  refresh(): void;
  /** Upload the arrays that arrived (before a frame is drawn); true when one was. */
  upload(renderer: { initTexture?(t: THREE.Texture): void } | null): boolean;
  observe(): DecalPagesObservation;
  dispose(): void;
}

export function createDecalPages(o: {
  readonly holds: TextureHolds;
  readonly pageOf: (materialId: string) => DecalPageRefLike | null;
  /** Something that needs a frame changed (an array arrived). */
  readonly onChange?: () => void;
}): AdapterDecalPages {
  /** Each decal entity's material and the arrays it holds. */
  const decals = new Map<string, { material: string; ids: string[] }>();
  /** The decoded arrays by texture id, and how many decals hold each. */
  const arrays = new Map<string, { texture: THREE.Texture | null; users: number; onGpu: boolean }>();
  let missing = 0;
  let pending = false;
  let disposed = false;
  const holderOf = (entityId: string): string => `decal:${entityId}`;

  const drop = (entityId: string): void => {
    const d = decals.get(entityId);
    if (d === undefined) return;
    decals.delete(entityId);
    o.holds.releaseHolder(holderOf(entityId));
    for (const id of d.ids) {
      const a = arrays.get(id);
      if (a !== undefined && --a.users <= 0) arrays.delete(id);
    }
  };

  const api: AdapterDecalPages = {
    set(entityId, materialId) {
      const known = decals.get(entityId);
      if (known !== undefined && known.material === materialId) return;
      drop(entityId);
      if (materialId === null || disposed) return;
      const ref = o.pageOf(materialId);
      const ids = ref === null ? [] : [...new Set(SETS.flatMap((s) => (ref[s] !== undefined ? [ref[s].texture] : [])))];
      decals.set(entityId, { material: materialId, ids });
      for (const id of ids) {
        const a = arrays.get(id);
        if (a !== undefined) {
          a.users += 1;
          void o.holds.get(id, holderOf(entityId));
          continue;
        }
        const entry = { texture: null as THREE.Texture | null, users: 1, onGpu: false };
        arrays.set(id, entry);
        void o.holds.get(id, holderOf(entityId)).then((t) => {
          if (disposed || arrays.get(id) !== entry) return;
          if (t === null) {
            missing += 1;
            return;
          }
          entry.texture = t;
          pending = true;
          o.onChange?.();
        });
      }
    },
    remove(entityId) {
      drop(entityId);
    },
    refresh() {
      for (const [id, d] of [...decals]) {
        drop(id);
        api.set(id, d.material);
      }
    },
    upload(renderer) {
      if (!pending || renderer?.initTexture === undefined) return false;
      pending = false;
      let any = false;
      for (const a of arrays.values()) {
        if (a.texture === null || a.onGpu) continue;
        try {
          renderer.initTexture(a.texture);
          a.onGpu = true;
          any = true;
        } catch {
          // The renderer is not ready yet: the next frame tries again.
          pending = true;
        }
      }
      return any;
    },
    observe() {
      let pages = 0;
      let layers = 0;
      let bytes = 0;
      let onGpu = 0;
      for (const a of arrays.values()) {
        if (a.texture === null) continue;
        pages += 1;
        layers += Math.max(1, (a.texture.image as { depth?: number } | null)?.depth ?? 1);
        bytes += textureByteSize(a.texture);
        if (a.onGpu) onGpu += 1;
      }
      let named = 0;
      for (const d of decals.values()) if (d.ids.length > 0) named += 1;
      return { decals: named, pages, layers, bytes, onGpu, missing };
    },
    dispose() {
      disposed = true;
      for (const id of [...decals.keys()]) drop(id);
    },
  };
  return api;
}
