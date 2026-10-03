/// <reference path="./emscripten-wasm.d.ts" />
/**
 * PNG, JPEG and WebP images decoded to RGBA on the server (texture encoding
 * and tile thumbnails): the format by its signature, then the pinned decoders.
 * WebP is libwebp's own decoder (a WASM build, loaded on first use), so a
 * lossy or lossless WebP decodes exactly as browsers draw it.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

import { imageDimensions } from '@thirdlight/asset-pipeline';
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


/** The WebP decoder, instantiated once per thread from its WASM file in node_modules (the package's own loader fetches a URL, which Node cannot). */
let webpDecoder: Promise<typeof import('@jsquash/webp/decode.js')> | null = null;
function webpLoaded(): Promise<typeof import('@jsquash/webp/decode.js')> {
  webpDecoder ??= (async () => {
    const mod = await import('@jsquash/webp/decode.js');
    const compiled = await WebAssembly.compile(readFileSync(new URL(import.meta.resolve('@jsquash/webp/codec/dec/webp_dec.wasm'))));
    await mod.init({
      instantiateWasm: (imports, done) => {
        const instance = new WebAssembly.Instance(compiled, imports);
        done(instance);
        return instance.exports;
      },
    });
    return mod;
  })();
  return webpDecoder;
}

/**
 * Any image the importer reads except KTX2 (PNG, JPEG, WebP), decoded to
 * RGBA. The declared size is checked against `maxPixels` before decoding.
 */
export async function decodeImage(bytes: Uint8Array, format: 'png' | 'jpeg' | 'webp', maxPixels: number): Promise<DecodedImage> {
  if (format !== 'webp') return decodeSource(bytes, format, maxPixels);
  const dims = imageDimensions(bytes, 'image/webp');
  if (dims === null) throw new Error('the WebP header could not be read');
  if (dims.width * dims.height > maxPixels) throw new Error(`the image is ${dims.width}×${dims.height}, over ${maxPixels} pixels`);
  const decoder = await webpLoaded();
  const img = await decoder.default(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  return { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
}
