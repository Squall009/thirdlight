/**
 * Node-side plumbing for the streaming core's tests and benchmark: the
 * worker bundle, `worker_threads` workers as pool workers, region files on
 * disk as a chunk source, and test worlds written to region files tile by
 * tile (so a 2 km world is never held in memory at once).
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import * as esbuild from 'esbuild';
import { chunkOfKey, RegionChunkSource, WORLD_GRID_ID, type ChunkGrid, type PaletteStore, type PoolWorker, type RegionByteSource, type RegionFootprint, type RegionLayout } from '@thirdlight/voxel';
import { loadArea, pickStore, RegionSet } from './regions';
import { TEST_WORLD_ID } from './test-world-id';
import type { TestGrid } from './world-kit';

// Two levels up from tools/voxel-bench, and from dist/voxel-bench when the benchmark runs bundled.
export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCES = join(REPO, 'tools', 'voxel-bench');

/** Bundles a worker entry of this folder for Node or the browser; returns the file written. */
export async function bundleWorker(entry: 'stream-worker-node' | 'stream-worker-browser' | 'far-worker-node', outFile: string): Promise<string> {
  mkdirSync(dirname(outFile), { recursive: true });
  await esbuild.build({
    entryPoints: [join(SOURCES, `${entry}.ts`)],
    bundle: true,
    platform: entry === 'stream-worker-browser' ? 'browser' : 'node',
    format: 'esm',
    target: entry === 'stream-worker-browser' ? 'es2022' : 'node22',
    // The browser build is minified like an export, so the export scan sees what a game would ship.
    minify: entry === 'stream-worker-browser',
    outfile: outFile,
    logLevel: 'warning',
  });
  return outFile;
}

/** A `worker_threads` Worker running a bundled worker file, as a pool worker. */
export function nodePoolWorker(file: string): PoolWorker {
  const w = new Worker(file);
  return {
    post: (m, t) => w.postMessage(m, t),
    listen: (onMessage, onError) => {
      w.on('message', onMessage);
      w.on('error', onError);
    },
    terminate: () => void w.terminate(),
  };
}

/** Region files in a folder, read by range through cached file handles. */
export class DiskRegions {
  private readonly handles = new Map<string, Promise<FileHandle>>();
  requests = 0;
  bytes = 0;
  constructor(readonly dir: string) {}

  /** The byte source of a region file, or null when it does not exist. */
  open(name: string): RegionByteSource | null {
    const path = join(this.dir, name);
    if (!existsSync(path)) return null;
    return {
      read: async (offset, length) => {
        let h = this.handles.get(name);
        if (h === undefined) this.handles.set(name, (h = open(path, 'r')));
        const buf = Buffer.alloc(length);
        const { bytesRead } = await (await h).read(buf, 0, length, offset);
        this.requests++;
        this.bytes += bytesRead;
        return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      },
    };
  }

  source(grid: ChunkGrid, layout: RegionLayout, footprint: RegionFootprint, maxOpen = 64): RegionChunkSource {
    return new RegionChunkSource({ worldId: TEST_WORLD_ID, gridId: WORLD_GRID_ID, grid, layout, footprint, open: (n) => this.open(n), maxOpen });
  }

  async close(): Promise<void> {
    for (const h of this.handles.values()) await (await h).close();
    this.handles.clear();
  }
}

export { TEST_WORLD_ID };

/**
 * Writes a test grid's cells [x0, x1) × [z0, z1) (all heights) as region
 * files into `dir`, one region column of `footprint` cells at a time;
 * returns the files and bytes written and the chunks present. `into`, when
 * given, also receives every generated chunk (an oracle for small areas).
 */
export function writeWorldRegions(g: TestGrid, grid: ChunkGrid, dir: string, layout: RegionLayout, footprint: RegionFootprint, x0: number, z0: number, x1: number, z1: number, into?: PaletteStore): { files: number; bytes: number; chunks: number } {
  mkdirSync(dir, { recursive: true });
  let files = 0;
  let bytes = 0;
  let chunks = 0;
  for (let rx = Math.floor(x0 / footprint); rx * footprint < x1; rx++) {
    for (let rz = Math.floor(z0 / footprint); rz * footprint < z1; rz++) {
      const store = pickStore(grid);
      chunks += loadArea(g, store, Math.max(x0, rx * footprint), Math.max(z0, rz * footprint), Math.min(x1, (rx + 1) * footprint), Math.min(z1, (rz + 1) * footprint));
      if (into !== undefined) for (const c of keysOf(grid, store.chunkKeys())) into.adoptPayload(c.cx, c.cy, c.cz, store.chunkPayload(c.cx, c.cy, c.cz, true));
      const set = new RegionSet(store, layout, footprint, TEST_WORLD_ID);
      for (const [name, b] of set.allFiles()) {
        writeFileSync(join(dir, name), b);
        files++;
        bytes += b.length;
      }
    }
  }
  return { files, bytes, chunks };
}

/** Every chunk key of a store, as coordinates. */
export function keysOf(grid: ChunkGrid, keys: Iterable<number>): Array<{ cx: number; cy: number; cz: number }> {
  return [...keys].map((k) => chunkOfKey(grid, k));
}
