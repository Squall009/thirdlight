/**
 * Where streamed chunks come from: region files read by range.
 *
 * A {@link RegionChunkSource} finds each chunk's region file, opens its
 * header and table once (one request for most files) and keeps a bounded
 * number of tables, then reads a batch of chunks with one coalesced range
 * request per run of nearby stored chunks. Absent chunks are air and
 * uniform ones come from the table, both without reading chunk bytes. The
 * byte source is passed in (a file on disk, `fetch` with Range headers, an
 * exported game's content closure), so this module does no I/O of its own.
 */
import { chunksPerRegionSide, type ChunkCoord, type ChunkGrid, type RegionFootprint } from './coords';
import { openRegion, readRegionChunks, regionFileName, type RegionByteSource, type RegionChunkRead, type RegionIndex, type RegionLayout } from './region-file';

/** Anything that reads chunks by coordinate. */
export interface ChunkSource {
  /** One result per chunk, in the order asked; a damaged chunk is reported, never read as air. */
  read(chunks: readonly ChunkCoord[]): Promise<RegionChunkRead[]>;
  /** Bytes the source holds in memory (open tables), counted in the streaming budget. */
  memoryBytes(): number;
  /** Forgets what it holds about these chunks' files (they were replaced): the next read sees the new files. */
  invalidate?(chunks: readonly ChunkCoord[]): void;
}

export interface RegionChunkSourceOptions {
  readonly grid: ChunkGrid;
  readonly layout: RegionLayout;
  readonly footprint: RegionFootprint;
  /** The byte source of a region file by its name ({@link regionFileName}), or null when the file does not exist (all air). */
  open(name: string): RegionByteSource | null;
  /** Region tables kept open (least recently used dropped first). */
  readonly maxOpen: number;
  /** Gap between stored chunks read in one request (bytes). */
  readonly maxGap?: number;
}

interface OpenRegion {
  readonly source: RegionByteSource | null;
  index: Promise<RegionIndex | null>;
  /** Bytes the parsed table holds (known once open). */
  bytes: number;
  /** Why the file could not be opened (its chunks are then reported damaged). */
  error: string | null;
}

export class RegionChunkSource implements ChunkSource {
  private readonly regions = new Map<string, OpenRegion>();
  private readonly side: number;
  /** Requests and bytes fetched, opening tables included. */
  requests = 0;
  fetchedBytes = 0;
  /** Reads done again with the region's table read again, after damage. */
  retries = 0;

  constructor(private readonly opts: RegionChunkSourceOptions) {
    this.side = chunksPerRegionSide(opts.grid, opts.footprint);
  }

  private nameOf(c: ChunkCoord): string {
    const rx = Math.floor(c.cx / this.side);
    const rz = Math.floor(c.cz / this.side);
    const ry = this.opts.layout === 'stacked' ? Math.floor(c.cy / this.side) : 0;
    return regionFileName(this.opts.layout, rx, ry, rz);
  }

  private region(name: string): OpenRegion {
    const known = this.regions.get(name);
    if (known !== undefined) {
      // Most recently used last: the map's order is the eviction order.
      this.regions.delete(name);
      this.regions.set(name, known);
      return known;
    }
    const raw = this.opts.open(name);
    const source: RegionByteSource | null =
      raw === null
        ? null
        : {
            read: async (offset, length) => {
              this.requests++;
              const b = await raw.read(offset, length);
              this.fetchedBytes += b.length;
              return b;
            },
          };
    const r: OpenRegion = { source, index: Promise.resolve(null), bytes: 0, error: null };
    if (source !== null) {
      r.index = openRegion(source).then(
        (index) => {
          r.bytes = index.bytes();
          return index;
        },
        (e: unknown) => {
          r.error = `region ${name}: ${e instanceof Error ? e.message : String(e)}`;
          return null;
        },
      );
    }
    this.regions.set(name, r);
    while (this.regions.size > this.opts.maxOpen) this.regions.delete(this.regions.keys().next().value!);
    return r;
  }

  async read(chunks: readonly ChunkCoord[]): Promise<RegionChunkRead[]> {
    const groups = new Map<string, number[]>();
    chunks.forEach((c, i) => {
      const name = this.nameOf(c);
      let g = groups.get(name);
      if (g === undefined) groups.set(name, (g = []));
      g.push(i);
    });
    const out: RegionChunkRead[] = new Array<RegionChunkRead>(chunks.length);
    await Promise.all(
      [...groups].map(async ([name, idx]) => {
        const asked = idx.map((i) => chunks[i]!);
        let reads = await this.readGroup(name, asked);
        // A file replaced since its table was read (an edit saved by its writer) gives bytes that fail their
        // checksum or a refused range: the table is read again once, and only damage that stays is reported.
        if (reads.some((r) => r.kind === 'damaged')) {
          this.retries++;
          this.regions.delete(name);
          reads = await this.readGroup(name, asked);
        }
        idx.forEach((i, k) => (out[i] = reads[k]!));
      }),
    );
    return out;
  }

  private async readGroup(name: string, asked: readonly ChunkCoord[]): Promise<RegionChunkRead[]> {
    const r = this.region(name);
    const index = await r.index;
    if (r.error !== null) return asked.map((c) => ({ cx: c.cx, cy: c.cy, cz: c.cz, kind: 'damaged', reason: r.error! }));
    if (index === null || r.source === null) return asked.map((c) => ({ cx: c.cx, cy: c.cy, cz: c.cz, kind: 'air' }));
    try {
      return await readRegionChunks(r.source, index, asked, this.opts.maxGap);
    } catch (e) {
      // A failed range read is not air: report the chunks so they are retried or repaired.
      const reason = `region ${name}: ${e instanceof Error ? e.message : String(e)}`;
      return asked.map((c) => ({ cx: c.cx, cy: c.cy, cz: c.cz, kind: 'damaged', reason }));
    }
  }

  /** Forgets the tables of the regions holding these chunks: their files were replaced, so they are opened again. */
  invalidate(chunks: readonly ChunkCoord[]): void {
    for (const c of chunks) this.regions.delete(this.nameOf(c));
  }

  memoryBytes(): number {
    let n = 0;
    for (const r of this.regions.values()) n += r.bytes;
    return n;
  }
}
