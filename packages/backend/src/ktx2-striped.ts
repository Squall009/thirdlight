/**
 * A UASTC KTX2 of an image larger than one encode takes, made from several
 * encodes and assembled here.
 *
 * The pinned encoder (Basis Universal 2.5) refuses more than
 * `KTX2_SOURCE_PIXELS_MAX` pixels a job, and an authored 4 × 4 m
 * construction tile at 1024 px/m is 4096² (16.8 Mpix). UASTC LDR 4×4 blocks
 * are encoded each on its own (no codebook across the image, unlike ETC1S),
 * and a level's blocks are stored row by row, so:
 *
 * - **the top level** is encoded in stripes of the image's whole width (a
 *   height a multiple of four, so no block straddles two stripes), each
 *   without mips, and the stripes' blocks are laid one after another: the
 *   level the encoder would have made of the whole image, block for block;
 * - **the levels below** are the image halved here (a 2×2 box: colour
 *   averaged in linear light, a normal map's vectors renormalized, data as
 *   stored) and encoded the same way again, until one encode takes the rest
 *   with its own mip chain;
 * - the container is the smaller encode's (its data format descriptor and
 *   key/value data) with the full size and every level, the top levels
 *   compressed again with Zstandard at the encoder's own level.
 *
 * No texel is encoded twice and the encoder version stays the pinned one.
 * The levels the encoder made itself are filtered by its own mip filter,
 * the levels halved here by the box above, so a chain's filter changes once
 * where the encodes meet (a 4096² image: level 1 by box, 2 and below by the
 * encoder).
 */
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib';

import { KTX2_ZSTD_LEVEL, ktx2LevelData, readKtx2, writeKtx2, type Ktx2Container } from './ktx2-container';

/** One encode the stripes are made with: RGBA pixels in, a UASTC KTX2 (with its mip chain when `mips`) out. */
export type UastcEncode = (rgba: Uint8Array, width: number, height: number, mips: boolean) => Promise<{ ok: true; ktx2: Uint8Array } | { ok: false; message: string }>;

/** How the levels below the top are filtered: colour in linear light, normals renormalized, data as stored. */
export type HalveMode = 'color' | 'normal' | 'data';

/** UASTC's DFD channel id of RGBA (an opaque encode says RGB: its blocks still decode alpha 255). */
const UASTC_CHANNEL_RGBA = 3;
/** Where the first sample's channel id sits in the DFD (bytes from its start; low nibble). */
const DFD_CHANNEL_BYTE = 31;
/** `supercompressionScheme` Zstandard. */
const SUPERCOMPRESSION_ZSTD = 2;

/** The rows a stripe of `width` holds within `pixelsMax` (a multiple of four, at least four). */
export function stripeRows(width: number, pixelsMax: number): number {
  return Math.max(4, Math.floor(pixelsMax / Math.max(1, width) / 4) * 4);
}

const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const linearToSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};

/**
 * The image's next mip level (sides halved, rounded down, at least 1): a 2×2 box (one texel at an odd edge). Colour
 * averages R, G, B in linear light (alpha as stored); a normal map averages its vectors and renormalizes them (alpha
 * as stored: a height); data averages each channel as stored.
 */
export function halveRgba(src: Uint8Array, width: number, height: number, mode: HalveMode): { data: Uint8Array; width: number; height: number } {
  const w = Math.max(1, width >> 1);
  const h = Math.max(1, height >> 1);
  const out = new Uint8Array(w * h * 4);
  const fx = width > 1 ? 2 : 1;
  const fy = height > 1 ? 2 : 1;
  const n = fx * fy;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < fy; dy++) {
        for (let dx = 0; dx < fx; dx++) {
          const o = ((y * fy + dy) * width + x * fx + dx) * 4;
          if (mode === 'color') {
            r += SRGB_TO_LINEAR[src[o]!]!;
            g += SRGB_TO_LINEAR[src[o + 1]!]!;
            b += SRGB_TO_LINEAR[src[o + 2]!]!;
          } else if (mode === 'normal') {
            r += src[o]! / 127.5 - 1;
            g += src[o + 1]! / 127.5 - 1;
            b += src[o + 2]! / 127.5 - 1;
          } else {
            r += src[o]!;
            g += src[o + 1]!;
            b += src[o + 2]!;
          }
          a += src[o + 3]!;
        }
      }
      const t = (y * w + x) * 4;
      if (mode === 'color') {
        out[t] = linearToSrgb(r / n);
        out[t + 1] = linearToSrgb(g / n);
        out[t + 2] = linearToSrgb(b / n);
      } else if (mode === 'normal') {
        const len = Math.hypot(r, g, b);
        // Opposed vectors cancel: the flat normal stands in.
        const [nx, ny, nz] = len > 1e-6 ? [r / len, g / len, b / len] : [0, 0, 1];
        out[t] = Math.round((nx + 1) * 127.5);
        out[t + 1] = Math.round((ny + 1) * 127.5);
        out[t + 2] = Math.round((nz + 1) * 127.5);
      } else {
        out[t] = Math.round(r / n);
        out[t + 1] = Math.round(g / n);
        out[t + 2] = Math.round(b / n);
      }
      out[t + 3] = Math.round(a / n);
    }
  }
  return { data: out, width: w, height: h };
}

/** A container's UASTC level 0 decompressed (16 bytes a 4×4 block, row by row). */
function topBlocks(c: Ktx2Container): Uint8Array {
  return ktx2LevelData(c, 0);
}

/**
 * The image's top level, encoded in stripes of its whole width (no mips), as decompressed UASTC blocks; the
 * stripes' containers too (their DFDs say whether a stripe held alpha).
 */
async function stripedTop(rgba: Uint8Array, width: number, height: number, pixelsMax: number, encode: UastcEncode): Promise<{ ok: true; blocks: Uint8Array; heads: Ktx2Container[] } | { ok: false; message: string }> {
  const rows = stripeRows(width, pixelsMax);
  const parts: Uint8Array[] = [];
  const heads: Ktx2Container[] = [];
  for (let y0 = 0; y0 < height; y0 += rows) {
    const h = Math.min(rows, height - y0);
    const enc = await encode(rgba.subarray(y0 * width * 4, (y0 + h) * width * 4), width, h, false);
    if (!enc.ok) return { ok: false, message: `stripe at row ${y0}: ${enc.message}` };
    const head = readKtx2(enc.ktx2);
    if (head === null) return { ok: false, message: `stripe at row ${y0}: the encoder wrote no readable KTX2` };
    parts.push(topBlocks(head));
    heads.push(head);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const expected = Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
  if (total !== expected) return { ok: false, message: `the stripes hold ${total} bytes of blocks, not the ${expected} of ${width}×${height}` };
  const blocks = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    blocks.set(p, at);
    at += p.length;
  }
  return { ok: true, blocks, heads };
}

/**
 * A UASTC KTX2 with a full mip chain of an image of any size: one encode when it fits `pixelsMax`, else its top
 * levels striped and the rest one encode (above). Every encode is `encode`'s (the caller's settings: colour space,
 * normal preset, effort, Zstandard); `mode` only decides how the levels halved here are filtered.
 */
export async function encodeUastcStriped(rgba: Uint8Array, width: number, height: number, mode: HalveMode, pixelsMax: number, encode: UastcEncode): Promise<{ ok: true; ktx2: Uint8Array; encodes: number } | { ok: false; message: string }> {
  if (width * height <= pixelsMax) {
    const one = await encode(rgba, width, height, true);
    return one.ok ? { ...one, encodes: 1 } : one;
  }
  // Top levels striped, from the largest down, until the rest fits one encode.
  const tops: { blocks: Uint8Array; heads: Ktx2Container[] }[] = [];
  let img = { data: rgba, width, height };
  let encodes = 0;
  while (img.width * img.height > pixelsMax) {
    const top = await stripedTop(img.data, img.width, img.height, pixelsMax, encode);
    if (!top.ok) return top;
    encodes += top.heads.length;
    tops.push(top);
    img = halveRgba(img.data, img.width, img.height, mode);
  }
  const rest = await encode(img.data, img.width, img.height, true);
  if (!rest.ok) return rest;
  encodes++;
  const tail = readKtx2(rest.ktx2);
  if (tail === null) return { ok: false, message: 'the encoder wrote no readable KTX2 for the lower levels' };
  if (tops.some((t) => t.heads.some((h) => h.supercompression !== tail.supercompression))) return { ok: false, message: 'the encodes stored their levels with different supercompression' };
  const full = Math.floor(Math.log2(Math.max(width, height))) + 1;
  if (tops.length + tail.levels.length !== full) return { ok: false, message: `the encodes made ${tops.length + tail.levels.length} mip levels, not the ${full} of ${width}×${height}` };
  // Any part holding alpha makes the whole RGBA (an opaque part's blocks decode alpha 255 either way).
  const alpha = tops.some((t) => t.heads.some((h) => h.channelId === UASTC_CHANNEL_RGBA));
  let dfd = tail.dfd;
  if (alpha && tail.channelId !== UASTC_CHANNEL_RGBA) {
    dfd = new Uint8Array(tail.dfd);
    dfd[DFD_CHANNEL_BYTE] = (dfd[DFD_CHANNEL_BYTE]! & 0xf0) | UASTC_CHANNEL_RGBA;
  }
  // The top levels stored as the encoder stores the rest (Zstandard, or plain when it wrote them plain).
  const zstd = tail.supercompression === SUPERCOMPRESSION_ZSTD;
  const levels = [
    ...tops.map((t) => ({ data: zstd ? new Uint8Array(zstdCompressSync(t.blocks, { params: { [zlibConstants.ZSTD_c_compressionLevel]: KTX2_ZSTD_LEVEL } })) : t.blocks, uncompressed: t.blocks.length })),
    ...tail.levels.map((l) => ({ data: l.stored, uncompressed: l.uncompressedByteLength })),
  ];
  return { ok: true, ktx2: writeKtx2({ ...tail, dfd, width, height }, levels), encodes };
}
