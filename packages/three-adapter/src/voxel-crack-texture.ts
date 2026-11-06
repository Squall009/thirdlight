/**
 * The crack overlay's textures: what a cracked voxel's faces (damage stage
 * 1, voxel damage-stages.ts) draw over their material. One texel holds the
 * strength from which a crack shows there: 0 no crack, 255 a crack that
 * shows from the first crack stage, lower values finer cracks that join in
 * as the integrity drops (the overlay strength a face carries, 0 … 1, shows
 * every texel at or above 1 − strength). So one texture grows its cracks as
 * a block weakens, like a block-breaking animation, with no frame per stage.
 *
 * The engine's texture is generated here (no file, the same on every run):
 * a few main cracks wandering from points near the middle of a 0.5 m face
 * to its rim, branches off them, and finer branches off those, each
 * generation dimmer. A kit may replace it with its own image (its red
 * channel read the same way), resampled to {@link CRACK_TEXELS} square.
 * The textures are one array, layer 0 the engine's, a layer a kit with its
 * own; the material table names each material's layer.
 */
import * as THREE from 'three/webgpu';
import { mulberry32 } from '@thirdlight/shared';

/** Texels along a side of a crack layer (one 0.5 m face). */
export const CRACK_TEXELS = 64;

/** The value a crack generation holds (main cracks show first, the finest last). */
const GENERATION_VALUES = [255, 175, 110, 60] as const;

/** The engine's crack layer: {@link CRACK_TEXELS}² bytes, row by row. */
export function engineCrackTexels(): Uint8Array {
  const n = CRACK_TEXELS;
  const out = new Uint8Array(n * n);
  // A fixed seed: the same cracks on every run and renderer.
  const rnd = mulberry32(0x5eed_c4ac);
  const put = (x: number, y: number, v: number): void => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= n || iy >= n) return;
    const o = iy * n + ix;
    if (out[o]! < v) out[o] = v;
  };
  // A crack wanders from (x, y) at `angle` for `length` texels; each generation spawns the next off its path.
  const crack = (x: number, y: number, angle: number, length: number, gen: number): void => {
    const v = GENERATION_VALUES[gen]!;
    let a = angle;
    for (let s = 0; s < length; s++) {
      put(x, y, v);
      // Main cracks are two texels wide, so they read at a distance.
      if (gen === 0) put(x + Math.sin(a), y - Math.cos(a), v);
      a += (rnd() - 0.5) * 0.45;
      x += Math.cos(a);
      y += Math.sin(a);
      if (x < 0 || y < 0 || x >= n || y >= n) return;
      if (gen + 1 < GENERATION_VALUES.length && rnd() < 0.07 - gen * 0.015) crack(x, y, a + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.6), length * (0.35 + rnd() * 0.25), gen + 1);
    }
  };
  const cx = n * (0.4 + rnd() * 0.2);
  const cy = n * (0.4 + rnd() * 0.2);
  const mains = 4;
  for (let k = 0; k < mains; k++) crack(cx, cy, (k / mains) * 2 * Math.PI + rnd() * 0.8, n * (0.45 + rnd() * 0.25), 0);
  return out;
}

/** A crack layer from an image's pixels (RGBA, `width` × `height`): its red channel resampled (nearest) to {@link CRACK_TEXELS}². */
export function crackTexelsFromPixels(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = CRACK_TEXELS;
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / n));
    const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / n));
    out[y * n + x] = rgba[(sy * width + sx) * 4]!;
  }
  return out;
}

/** Turns an image file's bytes into a crack layer (null: not an image this page can decode). */
export type CrackImageDecoder = (bytes: Uint8Array) => Promise<Uint8Array | null>;

/** The browser's decoder (createImageBitmap and an offscreen canvas); null where the page has neither. */
export const browserCrackDecoder: CrackImageDecoder = async (bytes) => {
  const g = globalThis as { createImageBitmap?: (b: Blob) => Promise<ImageBitmap>; OffscreenCanvas?: typeof OffscreenCanvas };
  if (g.createImageBitmap === undefined || g.OffscreenCanvas === undefined) return null;
  try {
    const bmp = await g.createImageBitmap(new Blob([bytes as BlobPart]));
    const canvas = new g.OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    bmp.close();
    return crackTexelsFromPixels(px, canvas.width, canvas.height);
  } catch {
    return null;
  }
};

/** The crack array texture: layer 0 the engine's, then `layers` (each {@link CRACK_TEXELS}² bytes). */
export function crackArrayTexture(layers: readonly Uint8Array[]): THREE.DataArrayTexture {
  const n = CRACK_TEXELS;
  const all = [engineCrackTexels(), ...layers];
  const data = new Uint8Array(n * n * all.length);
  all.forEach((l, k) => data.set(l.subarray(0, n * n), k * n * n));
  const tex = new THREE.DataArrayTexture(data, n, n, all.length);
  tex.format = THREE.RedFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // Nearest: a crack is a hard line (a blurred one reads as a smudge), and the overlay draws only near (level 0).
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}
