/**
 * PNG container writing: chunks with their CRC, and a whole file from an
 * already compressed image stream. The leaf has no zlib, so callers deflate
 * the filtered scanlines themselves (node:zlib, CompressionStream).
 */

import { crc32 } from './crc32';
import { PNG_SIGNATURE } from './image-signatures';

/** One PNG chunk: length, four-letter type, body and the CRC-32 of type and body. */
export function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** What {@link pngBytes} writes: the header fields and the zlib-compressed scanlines. */
export interface PngParts {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  /** 0 grey, 2 RGB, 3 palette, 4 grey + alpha, 6 RGBA. */
  readonly colorType: number;
  readonly interlace?: number;
  /** The IDAT stream: filtered scanlines, zlib-compressed. */
  readonly idat: Uint8Array;
  /** Chunks written between IHDR and IDAT (each already framed by {@link pngChunk}). */
  readonly extra?: readonly Uint8Array[];
}

/** A whole PNG file: signature, IHDR, any extra chunks, one IDAT and IEND. */
export function pngBytes(p: PngParts): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, p.width);
  v.setUint32(4, p.height);
  ihdr[8] = p.bitDepth;
  ihdr[9] = p.colorType;
  ihdr[12] = p.interlace ?? 0;
  const parts = [PNG_SIGNATURE, pngChunk('IHDR', ihdr), ...(p.extra ?? []), pngChunk('IDAT', p.idat), pngChunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of parts) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}
