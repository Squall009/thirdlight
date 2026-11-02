/**
 * The general-purpose compressors the harness measures chunk bytes with.
 *
 * - zstd at levels 1, 3 (its default, named plain `zstd`), 9 and 19, from
 *   Node's own zlib. Browsers have no native zstd, so a worker needs a
 *   JS/WASM decoder (tools/voxel-bench/browser measures fzstd).
 * - zstd level 3 with a raw-content dictionary (`zstd-dict`): chunk bytes of
 *   the test worlds at other seeds, so the dictionary never saw the chunks
 *   it compresses. Decoders without dictionary support (fzstd) cannot read it.
 * - deflate (level 6, raw): what a browser decodes natively
 *   (DecompressionStream 'deflate-raw'), the no-dependency fallback.
 *
 * lz4 (lz4js) was measured too and lost on every world (size and browser
 * decode); it is in the repository's history, not here.
 */
import { constants, deflateRawSync, inflateRawSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

/** A compressor of whole chunk byte strings. */
export interface Codec {
  readonly name: string;
  compress(bytes: Uint8Array): Uint8Array;
  decompress(bytes: Uint8Array): Uint8Array;
}

const zstdAt = (name: string, level: number, dictionary?: Uint8Array): Codec => {
  const dict = dictionary === undefined ? {} : { dictionary: Buffer.from(dictionary.buffer, dictionary.byteOffset, dictionary.byteLength) };
  return {
    name,
    compress: (b) => zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: level }, ...dict }),
    decompress: (b) => zstdDecompressSync(b, dict),
  };
};

export const ZSTD: Codec = zstdAt('zstd', 3);

export const DEFLATE: Codec = {
  name: 'deflate',
  compress: (b) => deflateRawSync(b, { level: 6 }),
  decompress: (b) => inflateRawSync(b),
};

/** Every codec a run can name with --codecs (the dictionary codec is made per run, see {@link zstdDict}). */
export const NAMED_CODECS: Readonly<Record<string, Codec>> = Object.freeze({
  zstd1: zstdAt('zstd1', 1),
  zstd: ZSTD,
  zstd9: zstdAt('zstd9', 9),
  zstd19: zstdAt('zstd19', 19),
  deflate: DEFLATE,
});

/** The default set (what every earlier run measured). */
export const CODECS: readonly Codec[] = Object.freeze([ZSTD, DEFLATE]);

/** zstd level 3 with a raw-content dictionary. */
export function zstdDict(dictionary: Uint8Array): Codec {
  return zstdAt('zstd-dict', 3, dictionary);
}
