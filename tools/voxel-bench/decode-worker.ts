/**
 * The browser decode bench's module worker: decompresses a corpus of chunk
 * byte strings with one codec, then decodes each chunk's palette codec
 * bytes, and reports the time of each stage (best of the rounds).
 *
 * Built for the browser by decode-cli.ts; a measuring tool, never shipped.
 * The corpus arrives from the bench's own static server, so the worker
 * fetches it (shipped runtime code gets bytes through the content closure).
 */
import { chunkGrid, createChunkImage, decodeMeasuredImage, type ChunkEdge } from '@thirdlight/voxel';
import { decompress as zstdDecompress } from 'fzstd';
import { lz4Block } from './lz4-block';

/** One measurement: a corpus file compressed with one codec. */
export interface DecodeJob {
  /** Corpus file (compressed chunks back to back) and its index (JSON: compressed offsets, raw bytes). */
  file: string;
  codec: 'none' | 'zstd' | 'zstd19' | 'deflate' | 'deflate-parallel' | 'lz4';
  edge: ChunkEdge;
  rounds: number;
}

export interface DecodeResult {
  job: DecodeJob;
  chunks: number;
  compressedBytes: number;
  rawBytes: number;
  /** Best round's milliseconds: decompressing every chunk, then decoding every chunk's palette bytes. */
  decompressMs: number;
  paletteMs: number;
  /** Every round's decompress ms. */
  roundsMs: number[];
  error?: string;
}

interface CorpusIndex {
  offsets: number[];
  rawBytes: number;
}

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([b as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decompresses every chunk in order (deflate-parallel starts every chunk's stream at once). */
async function decompressAll(codec: DecodeJob['codec'], chunks: readonly Uint8Array[]): Promise<Uint8Array[]> {
  if (codec === 'deflate-parallel') return Promise.all(chunks.map(inflate));
  const out: Uint8Array[] = [];
  for (const c of chunks) {
    if (codec === 'none') out.push(c);
    else if (codec === 'zstd' || codec === 'zstd19') out.push(zstdDecompress(c));
    else if (codec === 'lz4') out.push(lz4Block(c));
    else out.push(await inflate(c));
  }
  return out;
}

async function run(job: DecodeJob): Promise<DecodeResult> {
  const index = (await (await fetch(`${job.file}.json`)).json()) as CorpusIndex;
  const data = new Uint8Array(await (await fetch(job.file)).arrayBuffer());
  const chunks: Uint8Array[] = [];
  for (let k = 0; k + 1 < index.offsets.length; k++) chunks.push(data.subarray(index.offsets[k]!, index.offsets[k + 1]!));
  const img = createChunkImage(chunkGrid(job.edge));
  let decompressMs = Infinity;
  let paletteMs = Infinity;
  const roundsMs: number[] = [];
  for (let r = 0; r < job.rounds; r++) {
    const t0 = performance.now();
    const raw = await decompressAll(job.codec, chunks);
    const t1 = performance.now();
    let bytes = 0;
    // The bench decoder reads every candidate's bytes (world and measurement bodies) and checks every chunk's CRC, so a codec that returned wrong bytes fails here.
    for (const b of raw) {
      decodeMeasuredImage(b, img);
      bytes += b.length;
    }
    const t2 = performance.now();
    if (bytes !== index.rawBytes) throw new Error(`${job.file} ${job.codec}: ${bytes} raw bytes, expected ${index.rawBytes}`);
    roundsMs.push(t1 - t0);
    decompressMs = Math.min(decompressMs, t1 - t0);
    paletteMs = Math.min(paletteMs, t2 - t1);
  }
  return { job, chunks: chunks.length, compressedBytes: data.length, rawBytes: index.rawBytes, decompressMs, paletteMs, roundsMs };
}

const scope = self as unknown as { onmessage: ((e: MessageEvent<DecodeJob>) => void) | null; postMessage(m: DecodeResult): void };
scope.onmessage = (e) => {
  run(e.data).then(
    (r) => scope.postMessage(r),
    (err: unknown) => scope.postMessage({ job: e.data, chunks: 0, compressedBytes: 0, rawBytes: 0, decompressMs: NaN, paletteMs: NaN, roundsMs: [], error: String(err) }),
  );
};
