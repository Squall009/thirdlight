/**
 * The crack overlay's textures: what a cracked voxel's faces (damage stage
 * 1, voxel damage-stages.ts) draw over their material. One texel holds the
 * strength from which a crack shows there: 0 no crack, 255 a crack that
 * shows from the first crack stage, lower values finer cracks that join in
 * as the integrity drops (the overlay strength a face carries, 0 … 1, shows
 * every texel at or above 1 − strength). So one texture grows its cracks as
 * a block weakens, like a block-breaking animation, with no frame per stage.
 *
 * A layer is a crack **map** over one construction tile (4 × 4 m by
 * default), laid on the grid like the material's own texture: neighbouring
 * cracked cells show one continuous pattern across the surface, each cell's
 * strength masking where it shows. The engine's map is generated here (no
 * file, the same on every run): every 0.5 m cell of the tile holds a crack
 * origin, from which a few main cracks wander across into the cells round
 * it, with branches off them and finer branches off those, each generation
 * dimmer; the map wraps at its edges, so the tile repeats without a seam. A
 * kit may replace it with its own image (its red channel read the same
 * way, one image a tile), resampled to {@link CRACK_TEXELS} square. The
 * textures are one array, layer 0 the engine's, a layer a kit with its own;
 * the material table names each material's layer.
 */
import * as THREE from 'three/webgpu';
import { CONSTRUCTION_TILE_METRES, VOXEL_SIZE_M } from '@thirdlight/voxel';
import { mulberry32 } from '@thirdlight/shared';

/** Texels along a side of a crack layer (one construction tile: 128 a metre, 64 a 0.5 m cell). */
export const CRACK_TEXELS = 512;

/** The value a crack generation holds (main cracks show first, the finest last). */
const GENERATION_VALUES = [255, 175, 110, 60] as const;

/** The engine's crack layer: {@link CRACK_TEXELS}² bytes, row by row, over one construction tile. */
export function engineCrackTexels(): Uint8Array {
  const n = CRACK_TEXELS;
  const out = new Uint8Array(n * n);
  // A fixed seed: the same cracks on every run and renderer.
  const rnd = mulberry32(0x5eed_c4ac);
  // The map wraps (a texel past an edge is the one across), so cracks run on over the tile's seam.
  const put = (x: number, y: number, v: number): void => {
    const ix = ((Math.round(x) % n) + n) % n;
    const iy = ((Math.round(y) % n) + n) % n;
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
      if (gen + 1 < GENERATION_VALUES.length && rnd() < 0.07 - gen * 0.015) crack(x, y, a + (rnd() < 0.5 ? -1 : 1) * (0.6 + rnd() * 0.6), length * (0.35 + rnd() * 0.25), gen + 1);
    }
  };
  // One origin a cell of the tile, off its middle; its main cracks reach into the cells round it.
  const cell = Math.round((n * VOXEL_SIZE_M) / CONSTRUCTION_TILE_METRES);
  for (let cy = 0; cy < n / cell; cy++) for (let cx = 0; cx < n / cell; cx++) {
    const ox = (cx + 0.3 + rnd() * 0.4) * cell;
    const oy = (cy + 0.3 + rnd() * 0.4) * cell;
    const mains = 2 + Math.floor(rnd() * 2);
    const turn = rnd() * 2 * Math.PI;
    for (let k = 0; k < mains; k++) crack(ox, oy, turn + (k / mains) * 2 * Math.PI + (rnd() - 0.5) * 0.8, cell * (0.6 + rnd() * 0.5), 0);
  }
  return out;
}

/**
 * A crack layer from an image's pixels (RGBA, `width` × `height`, one construction tile): its red channel resampled
 * to {@link CRACK_TEXELS}², each texel the largest value of the source texels it covers (a smaller image: the
 * nearest one). The largest, not a mean or a sample: a kit's map authored at the base tile's 1024 px/m (4096²) draws
 * its cracks a pixel or two wide, which a nearest sample eight texels apart would mostly miss, and a crack shows from
 * the strength its brightest texel names.
 */
export function crackTexelsFromPixels(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): Uint8Array {
  const n = CRACK_TEXELS;
  const out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    const y0 = Math.min(height - 1, Math.floor((y * height) / n));
    const y1 = Math.max(y0 + 1, Math.min(height, Math.floor(((y + 1) * height) / n)));
    for (let x = 0; x < n; x++) {
      const x0 = Math.min(width - 1, Math.floor((x * width) / n));
      const x1 = Math.max(x0 + 1, Math.min(width, Math.floor(((x + 1) * width) / n)));
      let v = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) v = Math.max(v, rgba[(sy * width + sx) * 4]!);
      out[y * n + x] = v;
    }
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
