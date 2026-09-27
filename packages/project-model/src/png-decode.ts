/**
 * Phase 23.5: a small pure PNG decoder (zlib inflate included) for the
 * heightmap import edit — the command layer is pure (no Node zlib, no
 * browser image APIs), and an import must give the same cells everywhere.
 *
 * Non-interlaced PNGs of every colour type (grey, RGB, palette, grey+alpha,
 * RGBA) at bit depths 1-16 decode to 8-bit RGBA. An interlaced image, a bad
 * CRC-free structure or a stream that does not inflate is refused with a
 * message (never a throw to the caller).
 */

export interface DecodedPng {
  width: number;
  height: number;
  /** 8-bit RGBA, row by row (top row first). */
  rgba: Uint8Array;
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

/** Decode a PNG to 8-bit RGBA (or a reason it cannot be read). */
export function decodePngRgba(bytes: Uint8Array): { ok: true; png: DecodedPng } | { ok: false; message: string } {
  try {
    for (let i = 0; i < 8; i++) if (bytes[i] !== SIGNATURE[i]) return { ok: false, message: 'not a PNG file' };
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 8;
    let width = 0;
    let height = 0;
    let depth = 0;
    let colorType = -1;
    let palette: Uint8Array | null = null;
    let trns: Uint8Array | null = null;
    const idat: Uint8Array[] = [];
    while (pos + 8 <= bytes.length) {
      const len = view.getUint32(pos);
      const type = String.fromCharCode(bytes[pos + 4]!, bytes[pos + 5]!, bytes[pos + 6]!, bytes[pos + 7]!);
      const body = bytes.subarray(pos + 8, pos + 8 + len);
      if (body.length !== len) return { ok: false, message: 'the PNG ends early' };
      pos += 12 + len;
      if (type === 'IHDR') {
        width = view.getUint32(pos - 12 - len + 8);
        height = view.getUint32(pos - 12 - len + 12);
        depth = body[8]!;
        colorType = body[9]!;
        if (body[12] !== 0) return { ok: false, message: 'interlaced PNGs are not supported (save it without interlacing)' };
      } else if (type === 'PLTE') palette = body;
      else if (type === 'tRNS') trns = body;
      else if (type === 'IDAT') idat.push(body);
      else if (type === 'IEND') break;
    }
    if (width < 1 || height < 1) return { ok: false, message: 'the PNG has no IHDR size' };
    if (width * height > PNG_DECODE_MAX_PIXELS) return { ok: false, message: `the image is larger than ${PNG_DECODE_MAX_PIXELS} pixels` };
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
    if (channels === 0) return { ok: false, message: `unknown PNG colour type ${colorType}` };
    if (![1, 2, 4, 8, 16].includes(depth) || (colorType !== 0 && colorType !== 3 && depth < 8) || (colorType === 3 && depth > 8)) return { ok: false, message: `unsupported bit depth ${depth} for colour type ${colorType}` };
    if (colorType === 3 && palette === null) return { ok: false, message: 'a palette PNG without a palette' };
    const total = idat.reduce((n, c) => n + c.length, 0);
    const z = new Uint8Array(total);
    let zo = 0;
    for (const c of idat) {
      z.set(c, zo);
      zo += c.length;
    }
    const bpp = Math.max(1, (channels * depth) >> 3);
    const stride = Math.ceil((width * channels * depth) / 8);
    const raw = inflateZlib(z, (stride + 1) * height);
    if (raw.length < (stride + 1) * height) return { ok: false, message: 'the PNG image data is short' };
    // Unfilter in place (row by row).
    const cur = new Uint8Array(stride);
    const prev = new Uint8Array(stride);
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)]!;
      const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? cur[i - bpp]! : 0;
        const b = prev[i]!;
        const c = i >= bpp ? prev[i - bpp]! : 0;
        let v = row[i]!;
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
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const sample = (ch: number): number => {
          if (depth === 8) return cur[x * channels + ch]!;
          if (depth === 16) return cur[(x * channels + ch) * 2]!;
          const bitPos = (x * channels + ch) * depth;
          const v = (cur[bitPos >> 3]! >> (8 - depth - (bitPos & 7))) & ((1 << depth) - 1);
          return colorType === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
        };
        if (colorType === 0 || colorType === 4) {
          const g = sample(0);
          rgba[o] = g;
          rgba[o + 1] = g;
          rgba[o + 2] = g;
          rgba[o + 3] = colorType === 4 ? sample(1) : 255;
        } else if (colorType === 2 || colorType === 6) {
          rgba[o] = sample(0);
          rgba[o + 1] = sample(1);
          rgba[o + 2] = sample(2);
          rgba[o + 3] = colorType === 6 ? sample(3) : 255;
        } else {
          const idx = sample(0);
          const pl = palette as Uint8Array;
          if (idx * 3 + 2 >= pl.length) return { ok: false, message: 'a palette index outside the palette' };
          rgba[o] = pl[idx * 3]!;
          rgba[o + 1] = pl[idx * 3 + 1]!;
          rgba[o + 2] = pl[idx * 3 + 2]!;
          rgba[o + 3] = trns !== null && idx < trns.length ? trns[idx]! : 255;
        }
      }
      prev.set(cur);
    }
    return { ok: true, png: { width, height, rgba } };
  } catch (e) {
    return { ok: false, message: e instanceof InflateError ? `the PNG data does not inflate (${e.message})` : 'the PNG could not be read' };
  }
}
