/**
 * Phase 25.19: KTX2 encoding on import (decision 0006).
 *
 * A PNG or JPEG texture imported with `ktx2: "color"` or `"normal"` is
 * encoded to a Basis Universal KTX2 with a full mip chain, and the KTX2 is
 * the asset version's stored bytes (the source is recorded as its original,
 * `convertedFrom`, like an FBX converted to GLB):
 *
 * - `color` (albedo, emissive, UI-free colour art): ETC1S, sRGB transfer
 *   function, perceptual, mipmaps filtered in sRGB — small files;
 * - `normal` (tangent-space normal maps): UASTC LDR 4×4 with Zstandard
 *   supercompression, linear, the encoder's normal-map preset (mipmaps
 *   renormalized) — keeps the precision normals need.
 *
 * The encoder is `ktx2-encoder` (pinned; its bundled Basis Universal WASM
 * build, non-threaded), run off the backend's event loop in a worker thread
 * (`ktx2-worker.ts`) in the deployment, in-process in tests. WebP sources are
 * refused (no WebP decoder on the server: export the source as PNG).
 */
import { Worker } from 'node:worker_threads';

import jpeg from 'jpeg-js';
import { encodeToKTX2 } from 'ktx2-encoder';

import { decodePng, type DecodedImage } from './png-decode';

export type Ktx2Mode = 'color' | 'normal';
export const KTX2_MODES: readonly Ktx2Mode[] = ['color', 'normal'];
/** The encoder package and its pinned version (recorded with every encoded version). */
export const KTX2_ENCODER = { name: 'ktx2-encoder', version: '0.6.0' } as const;
/** The encoder's source limit (Basis Universal 2.5: 12 Mpix across the slices). */
export const KTX2_SOURCE_PIXELS_MAX = 12 * 1024 * 1024;

export type Ktx2EncodeResult =
  | { ok: true; ktx2: Uint8Array; source: { format: 'png' | 'jpeg'; width: number; height: number } }
  | { ok: false; code: 'texture_encode_unsupported' | 'texture_encode_failed'; message: string };

export interface TextureEncoder {
  encode(bytes: Uint8Array, mode: Ktx2Mode): Promise<Ktx2EncodeResult>;
  dispose?(): void;
}

function sourceFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | 'ktx2' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  if (bytes.length >= 12 && bytes[0] === 0xab && bytes[1] === 0x4b && bytes[2] === 0x54 && bytes[3] === 0x58) return 'ktx2';
  return null;
}

function decodeSource(bytes: Uint8Array, format: 'png' | 'jpeg'): DecodedImage {
  if (format === 'png') return decodePng(bytes, KTX2_SOURCE_PIXELS_MAX);
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: KTX2_SOURCE_PIXELS_MAX / (1024 * 1024), maxMemoryUsageInMB: 512 });
  return { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
}

/** Encode one PNG/JPEG to KTX2 in this thread (the worker runs this too). */
export async function encodeKtx2(bytes: Uint8Array, mode: Ktx2Mode): Promise<Ktx2EncodeResult> {
  const format = sourceFormat(bytes);
  if (format === 'ktx2') return { ok: false, code: 'texture_encode_unsupported', message: 'the texture is already KTX2 (import it without ktx2 encoding)' };
  if (format === 'webp') return { ok: false, code: 'texture_encode_unsupported', message: 'KTX2 encoding reads PNG or JPEG sources; export the WebP as PNG first (or import it as is)' };
  if (format === null) return { ok: false, code: 'texture_encode_unsupported', message: 'not a PNG or JPEG image' };
  let img: DecodedImage;
  try {
    img = decodeSource(bytes, format);
  } catch (e) {
    return { ok: false, code: 'texture_encode_failed', message: `the ${format.toUpperCase()} could not be decoded: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (img.width * img.height > KTX2_SOURCE_PIXELS_MAX) {
    return { ok: false, code: 'texture_encode_unsupported', message: `KTX2 encoding takes at most ${KTX2_SOURCE_PIXELS_MAX} pixels (${img.width}×${img.height} is larger; 2048×4096 fits)` };
  }
  try {
    const colour = mode === 'color';
    const ktx2 = await encodeToKTX2(bytes, {
      imageDecoder: async () => ({ width: img.width, height: img.height, data: img.data }),
      isUASTC: !colour,
      generateMipmap: true,
      isKTX2File: true,
      isNormalMap: !colour,
      isPerceptual: colour,
      isSetKTX2SRGBTransferFunc: colour,
      // ETC1S: the encoder's quality scale (1-255); UASTC: Zstandard supercompression.
      ...(colour ? { qualityLevel: 128 } : { needSupercompression: true }),
      enableDebug: false,
    });
    return { ok: true, ktx2, source: { format, width: img.width, height: img.height } };
  } catch (e) {
    return { ok: false, code: 'texture_encode_failed', message: `KTX2 encoding failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** In this thread (tests; a busy encode holds the event loop). */
export function createInlineTextureEncoder(): TextureEncoder {
  return { encode: encodeKtx2 };
}

/**
 * The deployment's encoder: one worker thread (the script built next to the
 * backend bundle), one encode at a time in order, started on first use and
 * kept; a crashed worker fails its job and is started again for the next.
 */
export function createWorkerTextureEncoder(workerUrl: URL): TextureEncoder {
  let worker: Worker | null = null;
  let next = 1;
  const pending = new Map<number, (r: Ktx2EncodeResult) => void>();
  const failAll = (message: string): void => {
    for (const done of pending.values()) done({ ok: false, code: 'texture_encode_failed', message });
    pending.clear();
  };
  const start = (): Worker => {
    if (worker !== null) return worker;
    const w = new Worker(workerUrl);
    w.unref();
    w.on('message', (m: { id: number; result: Ktx2EncodeResult }) => {
      const done = pending.get(m.id);
      pending.delete(m.id);
      done?.(m.result);
    });
    w.on('error', (e) => failAll(`the KTX2 encoder stopped: ${e.message}`));
    w.on('exit', () => {
      worker = null;
      failAll('the KTX2 encoder stopped');
    });
    worker = w;
    return w;
  };
  return {
    encode(bytes, mode) {
      const w = start();
      const id = next++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        const copy = bytes.slice();
        w.postMessage({ id, bytes: copy, mode }, [copy.buffer]);
      });
    },
    dispose() {
      void worker?.terminate();
      worker = null;
    },
  };
}
