/**
 * The header every binary data blob of the engine carries (block chunks,
 * terrain tiles): four magic bytes naming the kind, the header layout, how the
 * payload is compressed, two bytes the kind uses for itself, and the
 * payload's uncompressed length. One reader takes any compression, so a
 * blob the editor writes and one a build ships read the same way.
 *
 * Pure: no compression here (node:zlib on the backend, the page's
 * DecompressionStream in a game).
 */

/** The header layout (its fifth byte). */
export const BINARY_CONTAINER_VERSION = 1;
/** How a blob's payload is compressed (the header's sixth byte). */
export const BINARY_COMPRESSION = Object.freeze({ none: 0, zstd: 1, gzip: 2 } as const);
export type BinaryCompression = keyof typeof BINARY_COMPRESSION;
/** Magic, version, compression, two bytes of the kind's own, and the payload's uncompressed length (u32 LE). */
export const BINARY_HEADER_BYTES = 12;

/** A blob: the header and the (compressed) payload. `extra` fills the kind's two bytes. */
export function wrapBinaryBlob(magic: readonly number[], compression: BinaryCompression, rawLength: number, stored: Uint8Array, extra: readonly [number, number] = [0, 0]): Uint8Array {
  const out = new Uint8Array(BINARY_HEADER_BYTES + stored.length);
  out.set(magic, 0);
  out[4] = BINARY_CONTAINER_VERSION;
  out[5] = BINARY_COMPRESSION[compression];
  out[6] = extra[0];
  out[7] = extra[1];
  new DataView(out.buffer).setUint32(8, rawLength, true);
  out.set(stored, BINARY_HEADER_BYTES);
  return out;
}

/** Whether a blob starts with `magic`. */
export function hasBinaryMagic(blob: Uint8Array, magic: readonly number[]): boolean {
  return blob.length >= BINARY_HEADER_BYTES && magic.every((b, i) => blob[i] === b);
}

/** A blob's header and its stored payload (throws, naming `what`, when it is not one). */
export function readBinaryBlob(blob: Uint8Array, magic: readonly number[], what: string): { compression: BinaryCompression; rawLength: number; stored: Uint8Array; extra: [number, number] } {
  if (!hasBinaryMagic(blob, magic)) throw new Error(`not a binary ${what} file`);
  if (blob[4] !== BINARY_CONTAINER_VERSION) throw new Error(`${what} binary: header version ${blob[4]} is not one this engine reads (${BINARY_CONTAINER_VERSION})`);
  const compression = (Object.keys(BINARY_COMPRESSION) as BinaryCompression[]).find((k) => BINARY_COMPRESSION[k] === blob[5]);
  if (compression === undefined) throw new Error(`${what} binary: unknown compression ${blob[5]}`);
  const rawLength = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(8, true);
  return { compression, rawLength, stored: blob.subarray(BINARY_HEADER_BYTES), extra: [blob[6]!, blob[7]!] };
}
