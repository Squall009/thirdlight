/** The part of lz4js (no bundled types) the voxel bench uses: the raw block format. */
declare module 'lz4js' {
  /** Largest block `n` input bytes can compress to. */
  export function compressBound(n: number): number;
  /** Compresses src[sIndex, sIndex + sLength) into dst from 0; returns the block's length. `hashTable` is 2^16 zeroed words. */
  export function compressBlock(src: Uint8Array, dst: Uint8Array, sIndex: number, sLength: number, hashTable: Uint32Array): number;
  /** Decompresses src[sIndex, sIndex + sLength) into dst from dIndex; returns the index after the last byte written. */
  export function decompressBlock(src: Uint8Array, dst: Uint8Array, sIndex: number, sLength: number, dIndex: number): number;
}
