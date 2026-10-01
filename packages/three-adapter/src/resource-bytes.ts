/**
 * What a loaded resource keeps resident, and how a decoded texture is let go.
 * The resource manager reports resident bytes per kind; for three's objects
 * they are counted from what the GPU and the page hold: vertex and index
 * arrays, and each texture's pixels (the compressed mip data a KTX2 carries,
 * else four bytes a pixel with a third more for mipmaps).
 */
import * as THREE from 'three';

type ImageLike = { width?: number; height?: number; close?: () => void };

/** A texture's resident size (bytes). */
export function textureByteSize(t: THREE.Texture): number {
  const mipmaps = (t as { mipmaps?: readonly { data?: { byteLength?: number } }[] }).mipmaps;
  if (Array.isArray(mipmaps) && mipmaps.length > 0) {
    let n = 0;
    for (const m of mipmaps) n += m.data?.byteLength ?? 0;
    if (n > 0) return n;
  }
  const img = t.image as ImageLike | ImageLike[] | null | undefined;
  const list = Array.isArray(img) ? img : img === null || img === undefined ? [] : [img];
  let n = 0;
  for (const i of list) n += Math.max(0, i.width ?? 0) * Math.max(0, i.height ?? 0) * 4;
  return t.generateMipmaps ? Math.round((n * 4) / 3) : n;
}

/** What an object tree keeps resident: all of it, and of that the textures it carries (each image counted once). */
export interface ObjectResidentBytes {
  readonly bytes: number;
  readonly textures: { readonly count: number; readonly bytes: number };
}

/**
 * Everything under `root` a GPU draws from: geometry arrays and textures,
 * each counted once. Textures are counted per image (`texture.source`): the
 * copies a loader makes of one image (another sampler, a UV transform) share
 * it, as the renderer uploads it once.
 */
export function objectResidentBytes(root: THREE.Object3D): ObjectResidentBytes {
  const geometries = new Set<THREE.BufferGeometry>();
  const textures = new Map<unknown, THREE.Texture>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.geometry !== undefined) geometries.add(mesh.geometry);
    const mats = mesh.material === undefined ? [] : Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      for (const v of Object.values(m as unknown as Record<string, unknown>)) {
        if (v instanceof THREE.Texture && !textures.has(v.source ?? v)) textures.set(v.source ?? v, v);
      }
    }
  });
  let geometry = 0;
  for (const g of geometries) {
    for (const a of Object.values(g.attributes)) geometry += (a as THREE.BufferAttribute).array?.byteLength ?? 0;
    geometry += g.index?.array.byteLength ?? 0;
  }
  let texture = 0;
  for (const t of textures.values()) texture += textureByteSize(t);
  return { bytes: geometry + texture, textures: { count: textures.size, bytes: texture } };
}

/** Let go of a decoded texture: its GPU copy and the image it was made from (an `ImageBitmap` is closed). */
export function freeTexture(t: THREE.Texture): void {
  t.dispose();
  const img = t.image as ImageLike | null | undefined;
  if (img !== null && img !== undefined && typeof img.close === 'function') {
    try {
      img.close();
    } catch {
      /* already closed */
    }
  }
}
