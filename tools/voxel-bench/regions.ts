/**
 * Node-side region file tooling for the harness and its tests: loading a
 * test world's tile into the picked store, turning a store's chunks into
 * region files (column or stacked, any footprint), keeping a set of region
 * files current under edits (rewriting only the files an edit touched and
 * re-packing only its chunks), and reading files back by range from disk or
 * from an HTTP server with Range requests.
 */
import { open } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import {
  chunkKey,
  chunkOfKey,
  chunksPerRegionSide,
  createDenseChunk,
  createWorldStore,
  packRegionChunk,
  PaletteStore,
  regionChunkCodecBytes,
  regionFileName,
  REGION_ENTRY_BYTES,
  strokeBounds,
  voxel,
  writeRegion,
  type ChunkCoord,
  type ChunkGrid,
  type RegionByteSource,
  type RegionChunkRead,
  type RegionEntry,
  type RegionFootprint,
  type RegionLayout,
  type RegionTile,
  type VoxelStoreCandidate,
  type VoxelStroke,
} from '@thirdlight/voxel';
import { addressName, addressOf, importRead, pickStore, regionOf, storeEntry, zstdCompress, zstdDecompress, type RegionAddress } from '@thirdlight/workspace';
import { chunkRange, type TestGrid } from './world-kit';

// The region helpers live with the project's voxel worlds in the workspace; the bench uses them from there.
export { addressName, addressOf, importRead, pickStore, regionOf, storeEntry, zstdCompress, zstdDecompress, type RegionAddress };

/** Generates the chunks of a test grid inside cells [x0, x1) × [z0, z1) into `store`; returns how many were present. */
export function loadArea(g: TestGrid, store: PaletteStore, x0: number, z0: number, x1: number, z1: number): number {
  const grid = store.grid;
  const cells = createDenseChunk(grid);
  const [cx0, cx1] = chunkRange(grid, Math.max(x0, g.bounds.min[0]), Math.min(x1, g.bounds.max[0]));
  const [cz0, cz1] = chunkRange(grid, Math.max(z0, g.bounds.min[2]), Math.min(z1, g.bounds.max[2]));
  const [cy0, cy1] = chunkRange(grid, g.bounds.min[1], g.bounds.max[1]);
  let n = 0;
  for (let cx = cx0; cx < cx1; cx++) for (let cz = cz0; cz < cz1; cz++) for (let cy = cy0; cy < cy1; cy++) {
    if (!g.fill(grid, cx, cy, cz, cells)) continue;
    store.importChunk(cx, cy, cz, cells);
    n++;
  }
  return n;
}

/** The highest non-air cell of a column at or below `top`, or null. */
export function surfaceY(store: VoxelStoreCandidate, x: number, z: number, top: number, bottom: number): number | null {
  const v = voxel();
  for (let y = top; y >= bottom; y--) if (store.voxelAt(x, y, z, v).material !== 0) return y;
  return null;
}

/**
 * A world's region files kept current under edits: every chunk's packed
 * entry by region, re-packed only when an edit touched it, and a file
 * rewritten only when one of its chunks changed (what a save does).
 */
export class RegionSet {
  /** Entries by region file name, then by chunk key. */
  private readonly files = new Map<string, { address: RegionAddress; entries: Map<number, RegionEntry> }>();
  private readonly dirty = new Set<string>();
  private readonly touched = new Map<string, Set<number>>();

  constructor(
    readonly store: PaletteStore,
    readonly layout: RegionLayout,
    readonly footprint: RegionFootprint,
    readonly worldId: Uint8Array,
    readonly gridId = 0,
  ) {
    const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
    for (const key of store.chunkKeys()) {
      chunkOfKey(store.grid, key, c);
      const e = storeEntry(store, c);
      if (e !== null) this.fileOf(c).entries.set(key, e);
    }
  }

  private fileOf(c: ChunkCoord): { address: RegionAddress; entries: Map<number, RegionEntry> } {
    const address = addressOf(this.store.grid, this.layout, this.footprint, c);
    const name = addressName(address);
    let f = this.files.get(name);
    if (f === undefined) {
      f = { address, entries: new Map() };
      this.files.set(name, f);
    }
    return f;
  }

  /** Applies a stroke to the store and marks the chunks it can touch. */
  apply(stroke: VoxelStroke): void {
    this.store.applyStroke(stroke);
    this.mark(stroke);
  }

  /** Marks the chunks a stroke already applied to the store can have touched (several sets can share one store). */
  mark(stroke: VoxelStroke): void {
    const b = strokeBounds(stroke);
    const s = this.store.grid.shift;
    for (let cx = b.minX >> s; cx <= b.maxX >> s; cx++) for (let cz = b.minZ >> s; cz <= b.maxZ >> s; cz++) for (let cy = b.minY >> s; cy <= b.maxY >> s; cy++) {
      const c = { cx, cy, cz };
      const name = addressName(addressOf(this.store.grid, this.layout, this.footprint, c));
      let t = this.touched.get(name);
      if (t === undefined) {
        t = new Set();
        this.touched.set(name, t);
      }
      t.add(chunkKey(this.store.grid, c.cx, c.cy, c.cz));
    }
  }

  /** Re-packs touched chunks; returns the chunks whose stored entry changed and the bytes of their new entries. */
  repack(): { chunks: number; entryBytes: number } {
    let chunks = 0;
    let entryBytes = 0;
    const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
    for (const [name, keys] of this.touched) {
      for (const key of keys) {
        chunkOfKey(this.store.grid, key, c);
        const f = this.fileOf(c);
        const before = f.entries.get(key);
        const after = storeEntry(this.store, c);
        if (sameEntry(before, after)) continue;
        if (after === null) f.entries.delete(key);
        else f.entries.set(key, after);
        this.dirty.add(name);
        chunks++;
        entryBytes += after === null ? 0 : 'stored' in after ? after.stored.length + REGION_ENTRY_BYTES : REGION_ENTRY_BYTES;
      }
    }
    this.touched.clear();
    return { chunks, entryBytes };
  }

  /** The bytes of every region file whose content changed since the last call (all of them the first time, with `all`). */
  takeChanged(all = false): Map<string, Uint8Array | null> {
    this.repack();
    const out = new Map<string, Uint8Array | null>();
    for (const [name, f] of this.files) {
      if (!all && !this.dirty.has(name)) continue;
      out.set(name, f.entries.size === 0 ? null : this.write(f.address, f.entries.values()));
    }
    this.dirty.clear();
    return out;
  }

  write(a: RegionAddress, entries: Iterable<RegionEntry>): Uint8Array {
    const tile: RegionTile = { worldId: this.worldId, gridId: this.gridId, layout: a.layout, grid: this.store.grid, footprint: a.footprint, rx: a.rx, ry: a.ry, rz: a.rz, compressor: 'zstd' };
    return writeRegion(tile, entries);
  }

  /** Every region file's current bytes, by name. */
  allFiles(): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const [name, b] of this.takeChanged(true)) if (b !== null) out.set(name, b);
    return out;
  }
}

function sameEntry(a: RegionEntry | undefined | null, b: RegionEntry | null): boolean {
  if (a === undefined || a === null || b === null) return (a ?? null) === b;
  if ('uniform' in a || 'uniform' in b) return 'uniform' in a && 'uniform' in b && a.uniform === b.uniform;
  return a.raw === b.raw && Buffer.compare(a.stored, b.stored) === 0;
}

/** A region file on disk read by offset (one open handle; reads are counted). */
export class FileSource implements RegionByteSource {
  requests = 0;
  fetched = 0;
  private constructor(private readonly handle: Awaited<ReturnType<typeof open>>) {}
  static async open(path: string): Promise<FileSource> {
    return new FileSource(await open(path, 'r'));
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.requests++;
    const buf = Buffer.alloc(length);
    const { bytesRead } = await this.handle.read(buf, 0, length, offset);
    this.fetched += bytesRead;
    return buf.subarray(0, bytesRead);
  }
  close(): Promise<void> {
    return this.handle.close();
  }
}

/** A region file on an HTTP server, read with single-range requests (counted). */
export class HttpSource implements RegionByteSource {
  requests = 0;
  fetched = 0;
  constructor(private readonly url: string) {}
  async read(offset: number, length: number): Promise<Uint8Array> {
    this.requests++;
    const res = await fetch(this.url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (res.status !== 206 && res.status !== 200) throw new Error(`range read ${this.url}: HTTP ${res.status}`);
    const body = new Uint8Array(await res.arrayBuffer());
    this.fetched += body.length;
    // A server that ignores Range sends the whole file.
    return res.status === 200 ? body.subarray(offset, offset + length) : body;
  }
}

/**
 * A minimal static file server for `root` with single-range requests
 * (what a static host or CDN does for an exported game's region files).
 */
export function startRangeServer(root: string, port = 0): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const path = normalize(join(root, decodeURIComponent((req.url ?? '/').split('?')[0]!)));
    if (!path.startsWith(normalize(root))) {
      res.writeHead(403).end();
      return;
    }
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (m === null) {
      res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      createReadStream(path).pipe(res);
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(size - 1, m[2] === '' ? size - 1 : Number(m[2]));
    if (start >= size || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' });
    createReadStream(path, { start, end }).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port })));
}
