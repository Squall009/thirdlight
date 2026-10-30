/**
 * A texture's tile thumbnail, made on the server: the PNG, JPEG or WebP decoded (a KTX2 transcoded),
 * scaled down to fit `ASSET_THUMBNAIL_EDGE` (each thumbnail pixel the mean of
 * the source pixels it covers) and written as an 8-bit RGBA PNG. The editor
 * draws a texture tile from it, never from the texture's own bytes.
 *
 * Runs in the texture worker thread (ktx2-worker.ts) in the deployment.
 */
import { deflateSync } from 'node:zlib';
import { pngBytes } from '@thirdlight/shared';

import { ASSET_THUMBNAIL_EDGE } from '@thirdlight/project-model/limits';

import { decodeImage, sourceFormat } from './image-decode';
import { decodeTextureRgba, KTX2_SOURCE_PIXELS_MAX } from './texture-encode';

/**
 * The thumbnail of a PNG, JPEG or WebP image, or of a KTX2 imported as is
 * (transcoded: its top level, its first layer) — a trim sheet's maps made
 * outside the editor have no other image (null: not such an image, or it
 * cannot be decoded).
 */
export async function makeImageThumbnail(bytes: Uint8Array, edge = ASSET_THUMBNAIL_EDGE): Promise<Uint8Array | null> {
  const format = sourceFormat(bytes);
  if (format === null) return null;
  let img: { width: number; height: number; data: Uint8Array };
  try {
    if (format === 'ktx2') {
      const d = await decodeTextureRgba(bytes, KTX2_SOURCE_PIXELS_MAX);
      if (!d.ok) return null;
      img = d;
    } else img = await decodeImage(bytes, format, KTX2_SOURCE_PIXELS_MAX);
  } catch {
    return null;
  }
  const scale = Math.min(1, edge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * img.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * img.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / w));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = y0; sy < y1; sy++) {
        let i = (sy * img.width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, i += 4) {
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          a += img.data[i + 3]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return encodeRgbaPng(out, w, h);
}

/** An 8-bit RGBA PNG (no filtering; zlib-compressed rows). */
export function encodeRgbaPng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  return pngBytes({ width, height, bitDepth: 8, colorType: 6, idat: new Uint8Array(deflateSync(raw)) });
}
