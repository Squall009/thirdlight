/**
 * A build's block-layer cells as binary chunk data.
 *
 * Each layer entry of a scene document (`blocks[]`) with chunks ships its
 * chunks as one blob (project-model `block-chunk-binary.ts`, gzip-compressed
 * when the host gives a gzip), a digest-addressed buffer the game reads like
 * an instance set's: `content/sha256/<digest>`, listed in `manifest.buffers`.
 * The entry keeps its regions and names the blob (`chunkData: <digest>`), so
 * the scene files a game parses hold no cells, and a layer named by several
 * documents (a start scene's own file and the merged start scene) ships once.
 *
 * gzip, not zstd: the page decodes gzip with the browser's own
 * DecompressionStream, while three's zstd decoder fetches its WebAssembly
 * from a `data:` URL the Play page's content policy refuses and keeps its
 * grown memory for the page's life.
 */
import { BLOCK_CHUNK_DATA_KEY as CHUNK_DATA_KEY, encodeBlockChunks, readBlockChunkData, wrapBlockChunkData, decodeBlockChunks, type BlockChunk } from '@thirdlight/project-model';

/** The host's gzip (node:zlib on the backend). */
export interface GzipPort {
  gzip(raw: Uint8Array): Uint8Array;
  /** At most `maxLength` bytes out (throws past it). */
  gunzip(stored: Uint8Array, maxLength: number): Uint8Array;
}

/** One layer's chunk data blob. */
export interface BlockDataBlob {
  readonly digest: string;
  readonly bytes: Uint8Array;
}

/**
 * Each frozen layer entry's blob, kept across builds: a build after an edit
 * encodes only the layers that changed (an unchanged entry is the same
 * captured object). Keyed per compression, so a host without gzip never
 * reuses a gzip blob or the other way round.
 */
const packedEntries = { gzip: new WeakMap<object, BlockDataBlob>(), none: new WeakMap<object, BlockDataBlob>() };

/** Packs documents' layer entries; one packer per build collects the blobs its documents name. */
export function blockDataPacker(hash: (bytes: Uint8Array) => string, gzip: GzipPort | undefined): { pack(doc: unknown): unknown; blobs(): BlockDataBlob[] } {
  const known = gzip !== undefined ? packedEntries.gzip : packedEntries.none;
  const blobs = new Map<string, Uint8Array>();
  const blobOf = (entry: { chunks: readonly BlockChunk[] }): BlockDataBlob => {
    const hit = known.get(entry);
    if (hit !== undefined) return hit;
    const raw = encodeBlockChunks(entry.chunks);
    const bytes = gzip !== undefined ? wrapBlockChunkData('gzip', raw.length, gzip.gzip(raw)) : wrapBlockChunkData('none', raw.length, raw);
    const blob = { digest: hash(bytes), bytes };
    if (Object.isFrozen(entry) && Object.isFrozen(entry.chunks)) known.set(entry, blob);
    return blob;
  };
  return {
    pack(doc: unknown): unknown {
      const blocks = (doc as { blocks?: unknown } | null)?.blocks;
      if (!Array.isArray(blocks) || !blocks.some((b) => Array.isArray((b as { chunks?: unknown } | null)?.chunks))) return doc;
      const packed = blocks.map((b: { chunks?: BlockChunk[] } & Record<string, unknown>) => {
        if (!Array.isArray(b.chunks)) return b;
        const blob = blobOf(b as { chunks: BlockChunk[] });
        blobs.set(blob.digest, blob.bytes);
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(b)) if (k !== 'chunks') out[k] = v;
        out[CHUNK_DATA_KEY] = blob.digest;
        return out;
      });
      return { ...(doc as Record<string, unknown>), blocks: packed };
    },
    blobs: () => [...blobs.entries()].map(([digest, bytes]) => ({ digest, bytes })),
  };
}

/**
 * A blob's cells as text, for the export's forbidden-content scan (cell
 * metadata strings are project text like any other in a scene file).
 */
export function blockDataText(bytes: Uint8Array, gzip: GzipPort | undefined): string {
  const { compression, rawLength, stored } = readBlockChunkData(bytes);
  if (compression === 'zstd') throw new Error('an export\'s chunk data is never zstd');
  if (compression === 'gzip' && gzip === undefined) throw new Error('gzip chunk data and no gzip to read it');
  const raw = compression === 'gzip' ? gzip!.gunzip(stored, rawLength) : stored;
  return JSON.stringify(decodeBlockChunks(raw));
}
