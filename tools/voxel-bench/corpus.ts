/**
 * Corpus files: a sample of one world's encoded chunks, written by the
 * harness (--corpus) for the browser decode bench to read.
 */
import { mulberry32 } from '@thirdlight/shared';

/** Chunks a corpus keeps per world. */
const CORPUS_CHUNKS = 2000;

/** A uniform random sample of a world's chunk bytes (reservoir sampling, seeded so runs repeat). */
export class CorpusSample {
  private readonly kept: Uint8Array[] = [];
  private seen = 0;
  private readonly rand = mulberry32(7);
  add(b: Uint8Array): void {
    this.seen++;
    if (this.kept.length < CORPUS_CHUNKS) this.kept.push(b.slice());
    else {
      const k = Math.floor(this.rand() * this.seen);
      if (k < CORPUS_CHUNKS) this.kept[k] = b.slice();
    }
  }
  /** Length-prefixed chunk byte strings: u32 little-endian length, then the bytes. */
  bytes(): Uint8Array {
    const out = Buffer.alloc(this.kept.reduce((s, c) => s + 4 + c.length, 0));
    let at = 0;
    for (const c of this.kept) {
      out.writeUInt32LE(c.length, at);
      out.set(c, at + 4);
      at += 4 + c.length;
    }
    return out;
  }
}

export function corpusSampleOf(map: Map<string, CorpusSample>, world: string): CorpusSample {
  let s = map.get(world);
  if (s === undefined) {
    s = new CorpusSample();
    map.set(world, s);
  }
  return s;
}

/** Chunk byte strings of a corpus file (u32 little-endian length, then the bytes, repeated). */
export function readCorpus(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length; ) {
    const n = view.getUint32(at, true);
    out.push(bytes.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
}
