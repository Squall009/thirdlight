/**
 * Phase 25.19: a PNG decoder (RGBA, 8 bits per channel) for KTX2 encoding on
 * import. Every PNG the spec allows: greyscale, RGB, palette, grey + alpha,
 * RGBA at 1–16 bits, a tRNS transparent colour, Adam7 interlacing. The
 * compressed stream is inflated by Node's zlib; nothing else is used.
 * Refuses (throws) what it cannot read, with the reason.
 */
import { inflateSync } from 'node:zlib';

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** width × height × 4 bytes, rows top to bottom. */
  readonly data: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Adam7 passes: x start, y start, x step, y step. */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array, maxPixels = 4096 * 4096): DecodedImage {
  if (bytes.length < 8 || !SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    const body = bytes.subarray(off + 8, off + 8 + len);
    if (body.length !== len) throw new Error(`the PNG chunk ${type} is truncated`);
    if (type === 'IHDR') {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      depth = bytes[off + 16]!;
      colorType = bytes[off + 17]!;
      if (bytes[off + 18] !== 0 || bytes[off + 19] !== 0) throw new Error('the PNG uses an unknown compression or filter method');
      interlace = bytes[off + 20]!;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (width < 1 || height < 1 || channels === 0) throw new Error('the PNG header is missing or unknown');
  if (width * height > maxPixels) throw new Error(`the PNG is larger than ${maxPixels} pixels`);
  if (![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && colorType !== 0 && colorType !== 3) || (depth === 16 && colorType === 3)) throw new Error(`the PNG bit depth ${depth} is not valid for its colour type`);
  if (colorType === 3 && palette === null) throw new Error('the palette PNG has no palette');
  if (idat.length === 0) throw new Error('the PNG has no image data');
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (channels * depth) >> 3);
  const out = new Uint8Array(width * height * 4);
  const maxSample = (1 << Math.min(depth, 8)) - 1;
  // tRNS for greyscale / RGB: the one transparent sample value(s), at the file's depth.
  const trnsKey = trns !== null && (colorType === 0 || colorType === 2) ? Array.from({ length: colorType === 0 ? 1 : 3 }, (_, i) => (trns![i * 2]! << 8) | trns![i * 2 + 1]!) : null;
  let pos = 0;
  const pass = (x0: number, y0: number, dx: number, dy: number): void => {
    const w = Math.ceil((width - x0) / dx);
    const h = Math.ceil((height - y0) / dy);
    if (w <= 0 || h <= 0) return;
    const stride = Math.ceil((w * channels * depth) / 8);
    let prev = new Uint8Array(stride);
    for (let row = 0; row < h; row++) {
      if (pos + 1 + stride > raw.length) throw new Error('the PNG image data is truncated');
      const filter = raw[pos]!;
      const line = new Uint8Array(raw.subarray(pos + 1, pos + 1 + stride));
      pos += 1 + stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        const x = line[i]!;
        line[i] = filter === 0 ? x : filter === 1 ? x + a : filter === 2 ? x + b : filter === 3 ? x + ((a + b) >> 1) : filter === 4 ? x + paeth(a, b, c) : -1;
        if (filter > 4) throw new Error(`the PNG uses an unknown row filter ${filter}`);
      }
      const sample = (i: number): number => {
        if (depth === 8) return line[i]!;
        if (depth === 16) return (line[i * 2]! << 8) | line[i * 2 + 1]!;
        const bit = i * depth;
        return (line[bit >> 3]! >> (8 - depth - (bit & 7))) & maxSample;
      };
      const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / maxSample));
      for (let col = 0; col < w; col++) {
        const o = ((y0 + row * dy) * width + (x0 + col * dx)) * 4;
        const s = col * channels;
        if (colorType === 3) {
          const idx = sample(s);
          if (idx * 3 + 2 >= palette!.length) throw new Error('a PNG palette index is out of range');
          out[o] = palette![idx * 3]!;
          out[o + 1] = palette![idx * 3 + 1]!;
          out[o + 2] = palette![idx * 3 + 2]!;
          out[o + 3] = trns !== null && idx < trns.length ? trns[idx]! : 255;
        } else if (colorType === 0 || colorType === 4) {
          const g = sample(s);
          out[o] = out[o + 1] = out[o + 2] = to8(g);
          out[o + 3] = colorType === 4 ? to8(sample(s + 1)) : trnsKey !== null && g === trnsKey[0] ? 0 : 255;
        } else {
          const r = sample(s);
          const g = sample(s + 1);
          const b = sample(s + 2);
          out[o] = to8(r);
          out[o + 1] = to8(g);
          out[o + 2] = to8(b);
          out[o + 3] = colorType === 6 ? to8(sample(s + 3)) : trnsKey !== null && r === trnsKey[0] && g === trnsKey[1] && b === trnsKey[2] ? 0 : 255;
        }
      }
      prev = line;
    }
  };
  if (interlace === 1) for (const [x0, y0, dx, dy] of ADAM7) pass(x0, y0, dx, dy);
  else if (interlace === 0) pass(0, 0, 1, 1);
  else throw new Error('the PNG uses an unknown interlace method');
  return { width, height, data: out };
}
