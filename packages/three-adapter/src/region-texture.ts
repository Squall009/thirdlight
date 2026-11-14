/**
 * Writing part of a texture three owns, and growing one by copy, in one place
 * for every store that keeps a texture on the GPU and changes it a region at a
 * time (the voxel grids and far bricks, probe tiles, spot cookies, the light
 * clusters' rows). three has no public call that writes a sub-box of a texture
 * from CPU bytes without re-uploading the whole image, so the private hooks it
 * takes are here alone (docs/three-upgrade-checklist.md names this module):
 * on WebGPU `backend.device.queue.writeTexture` into `backend.get(texture).texture`,
 * on WebGL 2 `backend.copyTextureToTexture` from a staging texture three never
 * uploaded, which its WebGL texture utils write with `texSubImage2D/3D` of the
 * staging image's data. A grow makes the larger texture on the GPU and copies
 * the old one's texels in there (`renderer.copyTextureToTexture`), so nothing
 * is sent from the CPU again.
 */
import * as THREE from 'three/webgpu';

/** What a region upload calls on three's renderer (either backend). */
export interface RegionUploadRenderer {
  readonly backend: {
    readonly isWebGLBackend?: boolean;
    readonly device?: unknown;
    get(object: object): { texture?: unknown };
    copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture, region: null, at: THREE.Vector3): void;
  };
  initTexture(texture: THREE.Texture): void;
}

/** What a grow by copy calls as well. */
export interface RegionTextureRenderer extends RegionUploadRenderer {
  copyTextureToTexture(src: THREE.Texture, dst: THREE.Texture, region: THREE.Box3 | null, at: THREE.Vector3 | null): void;
}

/** A box of texels: its first texel and its size (a 2D texture's is one deep at z 0). */
export interface TexelBox {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
}

type GpuQueue = {
  writeTexture(dst: { texture: unknown; origin: { x: number; y: number; z: number } }, data: ArrayBufferView, layout: { bytesPerRow: number; rowsPerImage: number }, size: { width: number; height: number; depthOrArrayLayers: number }): void;
};

/**
 * Each texture made through {@link freshTexture} gets a version no earlier one
 * had: three's WebGL 2 backend rebinds a texture node's new texture only when
 * its version differs from the old one's (two fresh textures both at 1 keep
 * the old, deleted one bound). It starts far above the versions textures made
 * elsewhere reach by their own updates.
 */
let textureVersion = 1_000_000;

/** `tex` marked for upload with a version no texture made here had before. */
export function freshTexture<T extends THREE.Texture>(tex: T): T {
  tex.needsUpdate = true;
  tex.version = Math.max(tex.version, ++textureVersion);
  return tex;
}

/**
 * The staging textures of WebGL 2 uploads (a 2D and a 3D one: three picks the
 * copy by the source's kind). Never given to the GPU, so three's copy writes
 * their image straight into the destination; the image is swapped per upload.
 */
let staging2d: THREE.DataTexture | null = null;
let staging3d: THREE.Data3DTexture | null = null;

function stagingFor(texture: THREE.Texture, data: ArrayBufferView, box: TexelBox): THREE.Texture {
  const deep = (texture as { isData3DTexture?: boolean }).isData3DTexture === true || (texture as { isDataArrayTexture?: boolean }).isDataArrayTexture === true;
  const t: THREE.Texture = deep ? (staging3d ??= new THREE.Data3DTexture(null, 1, 1, 1)) : (staging2d ??= new THREE.DataTexture(null, 1, 1));
  t.image = { data, width: box.width, height: box.height, depth: box.depth } as unknown as typeof t.image;
  return t;
}

/**
 * Writes `data` (the box's texels in row order, `bytesPerTexel` each, rows and
 * layers packed with no padding; a longer array is read from its start) into
 * `texture` at `box`. Returns the bytes the box holds.
 */
export function uploadTextureRegion(renderer: RegionUploadRenderer, texture: THREE.Texture, data: ArrayBufferView, box: TexelBox, bytesPerTexel: number): number {
  renderer.initTexture(texture);
  if (renderer.backend.isWebGLBackend === true) {
    renderer.backend.copyTextureToTexture(stagingFor(texture, data, box), texture, null, new THREE.Vector3(box.x, box.y, box.z));
  } else {
    const device = renderer.backend.device as { queue: GpuQueue } | undefined;
    const gpu = renderer.backend.get(texture).texture;
    if (device === undefined || gpu === undefined) throw new Error(`texture ${texture.name || texture.uuid} is not on the GPU`);
    device.queue.writeTexture(
      { texture: gpu, origin: { x: box.x, y: box.y, z: box.z } },
      data,
      { bytesPerRow: box.width * bytesPerTexel, rowsPerImage: box.height },
      { width: box.width, height: box.height, depthOrArrayLayers: box.depth },
    );
  }
  return box.width * box.height * box.depth * bytesPerTexel;
}

/**
 * Makes `next` on the GPU and copies the texels of `from` inside `keep`
 * (texels from the origin, an empty box copying nothing) to the same places
 * in it: a texture grown, or shrunk to a part that holds everything in use.
 */
export function copyTextureInto(renderer: RegionTextureRenderer, from: THREE.Texture, next: THREE.Texture, keep: { readonly width: number; readonly height: number; readonly depth: number }): void {
  renderer.initTexture(next);
  if (keep.width <= 0 || keep.height <= 0 || keep.depth <= 0) return;
  renderer.copyTextureToTexture(from, next, new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(keep.width, keep.height, keep.depth)), new THREE.Vector3(0, 0, 0));
}
