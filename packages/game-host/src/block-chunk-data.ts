/**
 * The page side of a build's binary block chunk data (exporter
 * `block-chunk-data.ts`): a scene document's layer entry names its cells'
 * blob (`chunkData: <digest>`, a `manifest.buffers` row); before the
 * document goes to the runtime each blob is read (digest-verified),
 * gunzipped by the browser's own DecompressionStream and decoded back into
 * the entry's `chunks`. A document with its cells inline (Play's start
 * snapshot) passes through unchanged.
 */
import { BLOCK_CHUNK_DATA_KEY as CHUNK_DATA_KEY, decodeBlockChunks, readBlockChunkData } from '@thirdlight/runtime';

import { gunzip } from './gunzip';

/** A blob's chunks. */
async function chunksOf(blob: ArrayBuffer): Promise<unknown[]> {
  const { compression, rawLength, stored } = readBlockChunkData(new Uint8Array(blob));
  if (compression === 'zstd') throw new Error('block chunk data: zstd is not read in a game (a build ships gzip)');
  return decodeBlockChunks(compression === 'gzip' ? await gunzip(stored, rawLength, 'block chunk data') : stored);
}

/**
 * The document with each layer entry's cells read back from its chunk data
 * (the same object when no entry names any). `read` gives a buffer's
 * verified bytes by digest.
 */
export async function withBlockChunkData(doc: unknown, read: ((digest: string) => Promise<ArrayBuffer>) | undefined): Promise<unknown> {
  const blocks = (doc as { blocks?: unknown } | null)?.blocks;
  if (!Array.isArray(blocks) || !blocks.some((b) => typeof (b as Record<string, unknown> | null)?.[CHUNK_DATA_KEY] === 'string')) return doc;
  if (read === undefined) throw new Error('this scene names block chunk data and the page reads no buffers');
  const entries = await Promise.all(
    blocks.map(async (b: Record<string, unknown>) => {
      const digest = b[CHUNK_DATA_KEY];
      if (typeof digest !== 'string') return b;
      const chunks = await chunksOf(await read(digest));
      // The entry as a scene file holds it: id, cells, regions.
      const out: Record<string, unknown> = { entityId: b['entityId'], chunks };
      for (const [k, v] of Object.entries(b)) if (k !== CHUNK_DATA_KEY && k !== 'entityId') out[k] = v;
      return out;
    }),
  );
  return { ...(doc as Record<string, unknown>), blocks: entries };
}
