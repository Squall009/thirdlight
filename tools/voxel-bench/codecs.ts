/**
 * The general-purpose compressors the harness measures chunk bytes with,
 * all from Node's own zlib (no new dependency):
 *
 * - zstd (level 3, its default): the plan's codec. Browsers have no native
 *   zstd, so in a worker it needs a JS/WASM decoder whose cost the candidates
 *   measure separately.
 * - deflate (level 6, raw): what a browser decodes natively
 *   (DecompressionStream 'deflate-raw'), the no-dependency fallback.
 *
 * lz4 is not in Node or the browser; measuring it needs a new dependency,
 * which the candidates decide on.
 */
import { constants, deflateRawSync, inflateRawSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

export interface Codec {
  readonly name: 'zstd' | 'deflate';
  compress(bytes: Uint8Array): Uint8Array;
  decompress(bytes: Uint8Array): Uint8Array;
}

export const ZSTD: Codec = {
  name: 'zstd',
  compress: (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: 3 } }),
  decompress: (b) => zstdDecompressSync(b),
};

export const DEFLATE: Codec = {
  name: 'deflate',
  compress: (b) => deflateRawSync(b, { level: 6 }),
  decompress: (b) => inflateRawSync(b),
};

export const CODECS: readonly Codec[] = Object.freeze([ZSTD, DEFLATE]);
