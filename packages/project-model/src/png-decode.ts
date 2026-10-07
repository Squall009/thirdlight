/**
 * The one PNG decoder: pure (a zlib inflate included), so the command layer
 * reads a heightmap to the same cells everywhere, and the backend decodes
 * texture sources with the same code (optionally with Node's faster inflate).
 *
 * Every colour type at bit depths 1-16, tRNS, Adam7, decoded to 8-bit RGBA.
 * The caller chooses the pixel limit; the inflated stream is capped at the
 * exact size the header implies. What cannot be read is refused with a
 * message (never a throw to the caller).
 */

export interface DecodedPng {
  width: number;
  height: number;
  /** 8-bit RGBA, row by row (top row first). */
  rgba: Uint8Array;
  /** The samples as stored, for a 16-bit RGBA image decoded with `keep16` (data images: baked probes). */
  rgba16?: Uint16Array;
  /** With `channel16`: each pixel's first channel at 16 bits (8-bit depths scaled up), and `rgba` empty (data images: heightmaps). */
  channel16?: Uint16Array;
}

/** At most this many pixels (a 1024 × 1024 map): an engine limit. */
export const PNG_DECODE_MAX_PIXELS = 1024 * 1024;

// ---- base64 --------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Standard base64 (padding optional) → bytes; null when malformed. */
export function decodeBase64(s: string): Uint8Array | null {
  const clean = s.replace(/=+$/, '');
  if (clean.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64_INDEX[c]! : -1;
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, o);
}

/** Bytes → standard base64 (padded). */
export function encodeBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (i + 1 < b.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < b.length ? B64[n & 63]! : '=');
  }
  return s;
}

// ---- inflate (RFC 1950/1951) ---------------------------------------------------------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huffman {
  counts: Uint16Array;
  symbols: Uint16Array;
}

function huffman(lengths: ArrayLike<number>, n: number): Huffman {
  const counts = new Uint16Array(16);
  for (let i = 0; i < n; i++) counts[lengths[i]!]!++;
  counts[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1]! + counts[i - 1]!;
  const symbols = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i] !== 0) symbols[offs[lengths[i]!]!++] = i;
  return { counts, symbols };
}

class InflateError extends Error {}

/** Inflate a zlib stream (2-byte header, deflate blocks, Adler-32 ignored). */
export function inflateZlib(data: Uint8Array, maxOut: number): Uint8Array {
  if (data.length < 2 || (data[0]! & 0x0f) !== 8 || ((data[0]! << 8) | data[1]!) % 31 !== 0) throw new InflateError('not a zlib stream');
  if ((data[1]! & 0x20) !== 0) throw new InflateError('a preset dictionary is not supported');
  let pos = 2;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.min(maxOut, Math.max(1024, data.length * 4)));
  let o = 0;
  const need = (n: number): void => {
    if (o + n <= out.length) return;
    if (o + n > maxOut) throw new InflateError('the image data is larger than expected');
    const next = new Uint8Array(Math.min(maxOut, Math.max(out.length * 2, o + n)));
    next.set(out.subarray(0, o));
    out = next;
  };
  const bits = (n: number): number => {
    while (bitCnt < n) {
      if (pos >= data.length) throw new InflateError('the stream ends early');
      bitBuf |= data[pos++]! << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.counts[len]!;
      if (code - count < first) return h.symbols[index + (code - first)]!;
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError('a bad Huffman code');
  };
  let fixedLit: Huffman | null = null;
  let fixedDist: Huffman | null = null;
  for (;;) {
    const last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      if (pos + 4 > data.length) throw new InflateError('the stream ends early');
      const len = data[pos]! | (data[pos + 1]! << 8);
      pos += 4;
      if (pos + len > data.length) throw new InflateError('the stream ends early');
      need(len);
      out.set(data.subarray(pos, pos + len), o);
      o += len;
      pos += len;
    } else if (type === 1 || type === 2) {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        if (fixedLit === null) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 144; i++) l[i] = 8;
          for (let i = 144; i < 256; i++) l[i] = 9;
          for (let i = 256; i < 280; i++) l[i] = 7;
          for (let i = 280; i < 288; i++) l[i] = 8;
          fixedLit = huffman(l, 288);
          fixedDist = huffman(new Uint8Array(30).fill(5), 30);
        }
        lit = fixedLit;
        dist = fixedDist as Huffman;
      } else {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]!] = bits(3);
        const clh = huffman(cl, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist; ) {
          const sym = decode(clh);
          if (sym < 16) lens[i++] = sym;
          else {
            let rep = 0;
            let val = 0;
            if (sym === 16) {
              if (i === 0) throw new InflateError('a bad length repeat');
              val = lens[i - 1]!;
              rep = 3 + bits(2);
            } else if (sym === 17) rep = 3 + bits(3);
            else rep = 11 + bits(7);
            if (i + rep > hlit + hdist) throw new InflateError('too many code lengths');
            while (rep-- > 0) lens[i++] = val;
          }
        }
        lit = huffman(lens.subarray(0, hlit), hlit);
        dist = huffman(lens.subarray(hlit), hdist);
      }
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          need(1);
          out[o++] = sym;
        } else if (sym === 256) break;
        else {
          const li = sym - 257;
          if (li >= 29) throw new InflateError('a bad length code');
          const len = LEN_BASE[li]! + bits(LEN_EXTRA[li]!);
          const di = decode(dist);
          if (di >= 30) throw new InflateError('a bad distance code');
          const d = DIST_BASE[di]! + bits(DIST_EXTRA[di]!);
          if (d > o) throw new InflateError('a distance before the start');
          need(len);
          for (let k = 0; k < len; k++, o++) out[o] = out[o - d]!;
        }
      }
    } else throw new InflateError('a bad block type');
    if (last === 1) break;
  }
  return out.subarray(0, o);
}

// ---- PNG -------------------------------------------------------------------------------

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
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

export interface PngDecodeOptions {
  /** The largest image accepted (width × height); the caller's own limit. Default `PNG_DECODE_MAX_PIXELS`. */
  readonly maxPixels?: number;
  /**
   * The zlib inflate to use; it must refuse (throw) rather than produce more
   * than `maxOut` bytes. Default: the pure `inflateZlib` here. A Node caller
   * may pass `node:zlib` with `maxOutputLength` for speed.
   */
  readonly inflate?: (data: Uint8Array, maxOut: number) => Uint8Array;
  /** Also return a 16-bit RGBA image's samples unchanged (`rgba16`). */
  readonly keep16?: boolean;
  /** Return only each pixel's first channel at 16 bits (`channel16`), not RGBA: a heightmap needs one channel at full depth. */
  readonly channel16?: boolean;
}

/** The scanlines' sizes: per pass, its width, height and row stride (bytes, without the filter byte). */
function passesOf(width: number, height: number, bitsPerPixel: number, interlaced: boolean): { x0: number; y0: number; dx: number; dy: number; w: number; h: number; stride: number }[] {
  const layout = interlaced ? ADAM7 : [[0, 0, 1, 1] as const];
  const out = [];
  for (const [x0, y0, dx, dy] of layout) {
    const w = Math.ceil((width - x0) / dx);
    const h = Math.ceil((height - y0) / dy);
    if (w > 0 && h > 0) out.push({ x0, y0, dx, dy, w, h, stride: Math.ceil((w * bitsPerPixel) / 8) });
  }
  return out;
}

/**
 * Decode a PNG to 8-bit RGBA (or a reason it cannot be read). Every colour
 * type (grey, RGB, palette, grey + alpha, RGBA) at bit depths 1–16, a tRNS
 * transparent colour, Adam7 interlacing. The compressed stream may inflate to
 * exactly the size the header implies and no more: a small file cannot claim
 * a large allocation beyond its own pixel limit.
 */
export function decodePngRgba(bytes: Uint8Array, options: PngDecodeOptions = {}): { ok: true; png: DecodedPng } | { ok: false; message: string } {
  const maxPixels = options.maxPixels ?? PNG_DECODE_MAX_PIXELS;
  const inflate = options.inflate ?? inflateZlib;
  try {
    if (bytes.length < 8) return { ok: false, message: 'not a PNG file' };
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return { ok: false, message: 'not a PNG file' };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = -1;
    let interlace = 0;
    let palette: Uint8Array | null = null;
    let trns: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    while (pos + 8 <= bytes.length) {
      const len = view.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
      const body = bytes.subarray(pos + 8, pos + 8 + len);
      if (body.length !== len) return { ok: false, message: `the PNG chunk ${type} is truncated` };
      pos += 12 + len;
      if (type === 'IHDR') {
        if (len < 13) return { ok: false, message: 'the PNG header is too short' };
        const h = new DataView(body.buffer, body.byteOffset, body.byteLength);
        width = h.getUint32(0);
        height = h.getUint32(4);
        depth = body[8]!;
        colorType = body[9]!;
        if (body[10] !== 0 || body[11] !== 0) return { ok: false, message: 'the PNG uses an unknown compression or filter method' };
        interlace = body[12]!;
      } else if (type === 'PLTE') palette = body;
      else if (type === 'tRNS') trns = body;
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
    }
    if (width < 1 || height < 1) return { ok: false, message: 'the PNG has no IHDR size' };
    if (width * height > maxPixels) return { ok: false, message: `the image is larger than ${maxPixels} pixels (${width} × ${height})` };
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (channels === 0) return { ok: false, message: `unknown PNG colour type ${colorType}` };
    if (![1, 2, 4, 8, 16].includes(depth) || (colorType !== 0 && colorType !== 3 && depth < 8) || (colorType === 3 && depth > 8)) return { ok: false, message: `unsupported bit depth ${depth} for colour type ${colorType}` };
    if (interlace !== 0 && interlace !== 1) return { ok: false, message: `unknown PNG interlace method ${interlace}` };
    if (colorType === 3 && palette === null) return { ok: false, message: 'a palette PNG without a palette' };
    if (idat.length === 0) return { ok: false, message: 'the PNG has no image data' };
    const passes = passesOf(width, height, channels * depth, interlace === 1);
    // Every pass's rows, each with its filter byte: the exact inflated size.
    const expected = passes.reduce((n, p) => n + p.h * (p.stride + 1), 0);
    const total = idat.reduce((n, c) => n + c.length, 0);
    const z = new Uint8Array(total);
    let zo = 0;
    for (const c of idat) {
      z.set(c, zo);
      zo += c.length;
    }
    const raw = inflate(z, expected);
    if (raw.length < expected) return { ok: false, message: 'the PNG image data is short' };
    const bpp = Math.max(1, (channels * depth) >> 3);
    const maxSample = (1 << Math.min(depth, 8)) - 1;
    // tRNS of a grey or RGB image: the one transparent sample value(s), at the file's depth.
    const trnsKey = trns !== null && (colorType === 0 || colorType === 2) && trns.length >= (colorType === 0 ? 2 : 6) ? Array.from({ length: colorType === 0 ? 1 : 3 }, (_, i) => (trns![i * 2]! << 8) | trns![i * 2 + 1]!) : null;
    const to8 = (v: number): number => (depth === 16 ? v >> 8 : depth === 8 ? v : Math.round((v * 255) / maxSample));
    const one = options.channel16 === true ? new Uint16Array(width * height) : null;
    const rgba = new Uint8Array(one !== null ? 0 : width * height * 4);
    const rgba16 = options.keep16 === true && depth === 16 && colorType === 6 ? new Uint16Array(width * height * 4) : null;
    let at = 0;
    for (const { x0, y0, dx, dy, w, h, stride } of passes) {
      let prev = new Uint8Array(stride);
      let cur = new Uint8Array(stride);
      for (let row = 0; row < h; row++) {
        const f = raw[at]!;
        const line = raw.subarray(at + 1, at + 1 + stride);
        at += 1 + stride;
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp]! : 0;
          const b = prev[i]!;
          const c = i >= bpp ? prev[i - bpp]! : 0;
          let v = line[i]!;
          if (f === 1) v += a;
          else if (f === 2) v += b;
          else if (f === 3) v += (a + b) >> 1;
          else if (f === 4) {
            const p = a + b - c;
            const pa = Math.abs(p - a);
            const pb = Math.abs(p - b);
            const pc = Math.abs(p - c);
            v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          } else if (f !== 0) return { ok: false, message: `unknown PNG filter ${f}` };
          cur[i] = v & 0xff;
        }
        const sample = (i: number): number => {
          if (depth === 8) return cur[i]!;
          if (depth === 16) return (cur[i * 2]! << 8) | cur[i * 2 + 1]!;
          const bit = i * depth;
          return (cur[bit >> 3]! >> (8 - depth - (bit & 7))) & maxSample;
        };
        const y = y0 + row * dy;
        for (let col = 0; col < w; col++) {
          const o = (y * width + x0 + col * dx) * 4;
          const s = col * channels;
          if (one !== null) {
            const v = sample(s);
            one[o >> 2] = colorType === 3 ? (palette as Uint8Array)[v * 3]! * 257 : depth === 16 ? v : to8(v) * 257;
            continue;
          }
          if (colorType === 3) {
            const idx = sample(s);
            const pl = palette as Uint8Array;
            if (idx * 3 + 2 >= pl.length) return { ok: false, message: 'a palette index outside the palette' };
            rgba[o] = pl[idx * 3]!;
            rgba[o + 1] = pl[idx * 3 + 1]!;
            rgba[o + 2] = pl[idx * 3 + 2]!;
            rgba[o + 3] = trns !== null && idx < trns.length ? trns[idx]! : 255;
          } else if (colorType === 0 || colorType === 4) {
            const g = sample(s);
            rgba[o] = rgba[o + 1] = rgba[o + 2] = to8(g);
            rgba[o + 3] = colorType === 4 ? to8(sample(s + 1)) : trnsKey !== null && g === trnsKey[0] ? 0 : 255;
          } else {
            const r = sample(s);
            const g = sample(s + 1);
            const b = sample(s + 2);
            rgba[o] = to8(r);
            rgba[o + 1] = to8(g);
            rgba[o + 2] = to8(b);
            rgba[o + 3] = colorType === 6 ? to8(sample(s + 3)) : trnsKey !== null && r === trnsKey[0] && g === trnsKey[1] && b === trnsKey[2] ? 0 : 255;
            if (rgba16 !== null) {
              rgba16[o] = r;
              rgba16[o + 1] = g;
              rgba16[o + 2] = b;
              rgba16[o + 3] = sample(s + 3);
            }
          }
        }
        const t = prev;
        prev = cur;
        cur = t;
      }
    }
    return { ok: true, png: { width, height, rgba, ...(rgba16 !== null ? { rgba16 } : {}), ...(one !== null ? { channel16: one } : {}) } };
  } catch (e) {
    if (e instanceof InflateError) return { ok: false, message: `the PNG data does not inflate (${e.message})` };
    return { ok: false, message: `the PNG could not be read${e instanceof Error ? ` (${e.message})` : ''}` };
  }
}
