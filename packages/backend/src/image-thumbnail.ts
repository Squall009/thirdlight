/**
 * A texture's tile thumbnail, made on the server: the PNG, JPEG or WebP decoded,
 * scaled down to fit `ASSET_THUMBNAIL_EDGE` (each thumbnail pixel the mean of
 * the source pixels it covers) and written as an 8-bit RGBA PNG. The editor
 * draws a texture tile from it, never from the texture's own bytes.
 *
 * Runs in the texture worker thread (ktx2-worker.ts) in the deployment.
 */
import { crc32, deflateSync } from 'node:zlib';

import { ASSET_THUMBNAIL_EDGE } from '@thirdlight/project-model/limits';

import { decodeImage, sourceFormat } from './image-decode';
import { KTX2_SOURCE_PIXELS_MAX } from './texture-encode';

/** The thumbnail of a PNG, JPEG or WebP image (null: not such an image, or it cannot be decoded). */
export async function makeImageThumbnail(bytes: Uint8Array, edge = ASSET_THUMBNAIL_EDGE): Promise<Uint8Array | null> {
  const format = sourceFormat(bytes);
  if (format === null || format === 'ktx2') return null;
  let img;
  try {
    img = await decodeImage(bytes, format, KTX2_SOURCE_PIXELS_MAX);
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
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const chunks = [chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const png = new Uint8Array(total);
  png.set(signature, 0);
  let at = 8;
  for (const c of chunks) {
    png.set(c, at);
    at += c.length;
  }
  return png;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
