/**
 * lz4 blocks for chunk bytes (lz4js, block format, pure JS): no Node
 * built-ins, so the browser decode bench bundles the same decoder the
 * Node harness sizes with.
 *
 * Note for anything shipped: lz4js allocates a 5 MB frame buffer when it
 * loads, which the block functions used here never touch.
 */
import * as lz4 from 'lz4js';

export interface BlockCodec {
  readonly name: string;
  compress(bytes: Uint8Array): Uint8Array;
  decompress(bytes: Uint8Array): Uint8Array;
}

const lz4Table = new Uint32Array(1 << 16);
/** Header bit of a block stored uncompressed (lz4js gives up on bytes without matches, as the lz4 frame format does). */
const LZ4_STORED = 0x80000000;

/** lz4 block with a u32 header (little-endian): the raw length, top bit set when the bytes are stored as they are. */
export const LZ4: BlockCodec = {
  name: 'lz4',
  compress: (b) => {
    const block = new Uint8Array(lz4.compressBound(b.length));
    lz4Table.fill(0);
    const n = lz4.compressBlock(b, block, 0, b.length, lz4Table);
    const stored = n === 0 || n >= b.length;
    const out = new Uint8Array(4 + (stored ? b.length : n));
    out.set(stored ? b : block.subarray(0, n), 4);
    new DataView(out.buffer).setUint32(0, (b.length | (stored ? LZ4_STORED : 0)) >>> 0, true);
    return out;
  },
  decompress: (b) => lz4Block(b),
};

/** Decodes {@link LZ4}'s bytes; refuses a block that does not fill its stated length exactly. */
export function lz4Block(b: Uint8Array): Uint8Array {
  const head = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
  const raw = head & ~LZ4_STORED;
  if ((head & LZ4_STORED) !== 0) {
    if (b.length !== 4 + raw) throw new RangeError(`lz4 block: ${b.length - 4} stored bytes for a stated ${raw}`);
    return b.slice(4);
  }
  const out = new Uint8Array(raw);
  const end = lz4.decompressBlock(b, out, 4, b.length - 4, 0);
  if (end !== raw) throw new RangeError(`lz4 block: ${end} bytes for a stated ${raw}`);
  return out;
}

