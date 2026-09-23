/**
 * Minimal PNG decoder for screenshot assertions (8-bit RGB/RGBA,
 * non-interlaced — what Chromium screenshots produce). Node zlib only.
 */
import { inflateSync } from 'node:zlib';

export interface Image {
  width: number;
  height: number;
  /** RGBA, row-major. */
  pixel(x: number, y: number): [number, number, number, number];
}

export function decodePng(buf: Buffer): Image {
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG (need 8-bit, non-interlaced)');
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      idat.push(data);
    }
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bpp === 0) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return {
    width,
    height,
    pixel(x, y) {
      const i = y * stride + x * bpp;
      return [out[i]!, out[i + 1]!, out[i + 2]!, bpp === 4 ? out[i + 3]! : 255];
    },
  };
}

/** How many distinct (coarsely quantized) colors the central region
 * (`frac` of each dimension) contains. */
export function colorCount(img: Image, frac = 0.5): number {
  const seen = new Set<number>();
  const x0 = Math.floor((img.width * (1 - frac)) / 2);
  const y0 = Math.floor((img.height * (1 - frac)) / 2);
  for (let y = y0; y < img.height - y0; y += 4) {
    for (let x = x0; x < img.width - x0; x += 4) {
      const [r, g, b] = img.pixel(x, y);
      seen.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
    }
  }
  return seen.size;
}

/** How many of `bands` equal vertical slices of the central region (`frac`
 * of each dimension) contain a lit pixel (any channel above `threshold`). */
export function litBands(img: Image, bands = 3, frac = 0.5, threshold = 40): number {
  const x0 = Math.floor((img.width * (1 - frac)) / 2);
  const y0 = Math.floor((img.height * (1 - frac)) / 2);
  const w = img.width - 2 * x0;
  let lit = 0;
  for (let b = 0; b < bands; b++) {
    let found = false;
    for (let x = x0 + Math.floor((b * w) / bands); x < x0 + Math.floor(((b + 1) * w) / bands) && !found; x += 2) {
      for (let y = y0; y < img.height - y0 && !found; y += 2) {
        const [r, g, bl] = img.pixel(x, y);
        if (Math.max(r, g, bl) > threshold) found = true;
      }
    }
    if (found) lit += 1;
  }
  return lit;
}
