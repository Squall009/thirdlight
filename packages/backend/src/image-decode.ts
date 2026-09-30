/**
 * PNG and JPEG images decoded to RGBA on the server (texture encoding and
 * tile thumbnails): the format by its signature, then the pinned decoders.
 */
import { inflateSync } from 'node:zlib';

import { decodePngRgba } from '@thirdlight/project-model/png';
import jpeg from 'jpeg-js';

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** width × height × 4 bytes, rows top to bottom. */
  readonly data: Uint8Array;
}

/** Node's inflate, refusing to produce more than the PNG header implies. */
const nodeInflate = (data: Uint8Array, maxOut: number): Uint8Array => inflateSync(data, { maxOutputLength: maxOut });

export function sourceFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'ktx2' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  if (bytes.length >= 12 && bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58) return 'ktx2';
  return null;
}

export function decodeSource(bytes: Uint8Array, format: 'png' | 'jpeg', maxPixels: number): DecodedImage {
  if (format === 'png') {
    const r = decodePngRgba(bytes, { maxPixels, inflate: nodeInflate });
    if (!r.ok) throw new Error(r.message);
    return { width: r.png.width, height: r.png.height, data: r.png.rgba };
  }
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: maxPixels / (1024 * 1024), maxMemoryUsageInMB: 512 });
  return { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
}

