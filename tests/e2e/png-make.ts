/** Write small RGBA PNGs for tests (node:zlib). */
import { PNG_SIGNATURE, pngChunk } from '@thirdlight/shared';
import { deflateSync } from 'node:zlib';

/** A w×h RGBA PNG filled by `color(x, y)`. */
export function makePng(w: number, h: number, color: (x: number, y: number) => [number, number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) raw.set(color(x, y), y * (w * 4 + 1) + 1 + x * 4);
  }
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

