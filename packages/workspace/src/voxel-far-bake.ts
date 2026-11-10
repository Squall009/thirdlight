/**
 * The far cache's baked bricks: every kept node's far bricks built when the
 * cache is built, by the far field's own brick builder from the same cells
 * the far field would send it (@thirdlight/voxel far-bricks-baked.ts), and
 * stored beside the nodes in region files of the cache's format (folder
 * `B<level>/`, a node's encoded bricks zstd-packed as a stored entry). So a
 * page drawing the far field decodes and uploads bricks instead of building
 * them, and the bricks it would have built are those it reads, byte for
 * byte.
 *
 * After an edit the bricks that read a changed node are built again
 * (`farBrickDirty`); each is looked up first by the content of the cells it
 * reads in the cache's rebuilt store (`rebuilt/`, a file a content key), so
 * cells that come back to a content already built (an undo, a redo, the same
 * edit again) cost a file read, not a build.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '@thirdlight/shared';
import {
  brickFarNodeBy,
  chunkGrid,
  createWorldStore,
  encodeFarBricks,
  FAR_BRICK_BUILD,
  FAR_BRICKS_BLOB_VERSION,
  farBrickJobCells,
  type ChunkGrid,
  type MipNode,
  type PaletteStore,
  type RegionEntry,
  type StoredChunk,
} from '@thirdlight/voxel';
import { zstdCompress, zstdDecompress } from './voxel-world-files';
import { writeAtomic } from './write';

/** The folder of a kept level's baked bricks inside a far cache. */
export function farBricksFolder(level: number): string {
  return `B${level}`;
}

/** The far cache's folder of bricks built again after edits, a file per content key. */
export const FAR_REBUILT_FOLDER = 'rebuilt';

/**
 * Bytes the rebuilt store keeps; past it the least recently written go
 * first. A memory of recent edits, not the cache (the level files hold
 * every node's bricks): enough for some thousands of edited nodes.
 */
export const FAR_REBUILT_STORE_BYTES = 64 * 1024 * 1024;

/** A node's entry as the far cache stores it (null: air, not kept). */
export type FarEntryOf = (n: MipNode) => RegionEntry | null;

/** One bake job: a level file's nodes, built from a far cache's level files. */
export interface FarBakeTask {
  readonly cacheDir: string;
  readonly level: number;
  /** Its region file name (stacked layout, the level's node coordinates). */
  readonly region: string;
  readonly nodes: ReadonlyArray<readonly [number, number, number]>;
}

/** A bake job's baked entries (stored, zstd-packed where that is smaller). */
export interface FarBakeResult {
  readonly level: number;
  readonly region: string;
  readonly entries: RegionEntry[];
  readonly ms: number;
}

/** Runs bake jobs (in workers, or here one after another), answers in any order. */
export type FarBakeRunner = (tasks: readonly FarBakeTask[]) => AsyncIterable<FarBakeResult> | Iterable<FarBakeResult>;

function storedOf(e: RegionEntry | null): StoredChunk | null {
  if (e === null) return null;
  return 'uniform' in e ? { uniform: e.uniform } : { stored: e.stored, raw: e.raw };
}

/** A scratch store for brick builds (the far field's workers' kind: the builder reads it as it does there). */
export function farBakeStore(grid: ChunkGrid): PaletteStore {
  return createWorldStore(grid, 'worker');
}

/** Node `n`'s bricks, built by the far field's builder from the cells it would send it, encoded. */
export function bakeFarBricks(grid: ChunkGrid, store: PaletteStore, n: MipNode, minLevel: number, entryOf: FarEntryOf): Uint8Array {
  const input = farBrickJobCells(n, FAR_BRICK_BUILD, minLevel, (m) => storedOf(entryOf(m)));
  return encodeFarBricks(brickFarNodeBy(store, { ...input, node: input.node }, zstdDecompress));
}

/** A baked node's region entry from its encoded bricks. */
export function bakedEntry(n: MipNode, bytes: Uint8Array): RegionEntry {
  const packed = zstdCompress(bytes);
  return packed.length < bytes.length ? { cx: n.nx, cy: n.ny, cz: n.nz, stored: packed, raw: false } : { cx: n.nx, cy: n.ny, cz: n.nz, stored: bytes, raw: true };
}

/**
 * The content key of node `n`'s bricks: the build, the encoding's version
 * and every cell entry the build reads (in the order it reads them), so two
 * nodes reading the same cells the same way share a key.
 */
export function farBrickContentKey(n: MipNode, minLevel: number, entryOf: FarEntryOf): string {
  const input = farBrickJobCells(n, FAR_BRICK_BUILD, minLevel, (m) => storedOf(entryOf(m)));
  const parts: Uint8Array[] = [new TextEncoder().encode(JSON.stringify({ v: FAR_BRICKS_BLOB_VERSION, build: FAR_BRICK_BUILD, level: n.level, scale: input.fine?.scale ?? 1 }))];
  for (const c of [...input.cells, ...(input.fine?.cells ?? [])]) {
    if (c === null) parts.push(Uint8Array.of(0));
    else if ('uniform' in c) parts.push(Uint8Array.of(1, c.uniform & 0xff, (c.uniform >>> 8) & 0xff, (c.uniform >>> 16) & 0xff, c.uniform >>> 24));
    else {
      const head = new Uint8Array(6);
      head[0] = 2;
      head[1] = c.raw ? 1 : 0;
      new DataView(head.buffer).setUint32(2, c.stored.length, true);
      parts.push(head, c.stored);
    }
  }
  const all = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return sha256Hex(all);
}

/** A bake job run here: each node's bricks built and packed. */
export function runFarBakeTask(t: FarBakeTask, grid: ChunkGrid, minLevel: number, entryOf: FarEntryOf, store = farBakeStore(grid)): FarBakeResult {
  const t0 = performance.now();
  const entries = t.nodes.map(([nx, ny, nz]) => {
    const n = { level: t.level, nx, ny, nz };
    return bakedEntry(n, bakeFarBricks(grid, store, n, minLevel, entryOf));
  });
  return { level: t.level, region: t.region, entries, ms: performance.now() - t0 };
}

/** What a rebuild's bricks did. */
export interface FarBricksRebuild {
  /** Brick nodes stale after the edit (`farBrickDirty` among the kept nodes, and those gone). */
  readonly dirty: number;
  /** Built again by the builder. */
  readonly built: number;
  /** Taken from the rebuilt store by their content key. */
  readonly reused: number;
  readonly ms: number;
}

/**
 * The rebuilt store of a far cache: encoded bricks by content key, kept to
 * {@link FAR_REBUILT_STORE_BYTES} (the oldest written go first).
 */
export class FarRebuiltStore {
  private readonly dir: string;
  constructor(cacheDir: string) {
    this.dir = join(cacheDir, FAR_REBUILT_FOLDER);
  }

  get(key: string): Uint8Array | null {
    const p = join(this.dir, key);
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
  }

  put(key: string, bytes: Uint8Array): void {
    mkdirSync(this.dir, { recursive: true });
    const out = writeAtomic({ dir: this.dir, target: key, bytes, allowedPreHashes: [], previousHash: null });
    if (!out.ok) throw new Error(`${join(this.dir, key)}: not written`);
    this.trim();
  }

  private trim(): void {
    const files = readdirSync(this.dir)
      .filter((f) => /^[0-9a-f]{64}$/.test(f))
      .map((f) => {
        const s = statSync(join(this.dir, f));
        return { f, bytes: s.size, at: s.mtimeMs };
      })
      .sort((a, b) => a.at - b.at);
    let total = files.reduce((s, x) => s + x.bytes, 0);
    for (const x of files) {
      if (total <= FAR_REBUILT_STORE_BYTES) break;
      rmSync(join(this.dir, x.f), { force: true });
      total -= x.bytes;
    }
  }
}

/** The bake jobs' default runner: here, one after another, from the cache's own level files. */
export function inThreadFarBake(edge: number, minLevel: number, entryOf: FarEntryOf): FarBakeRunner {
  const grid = chunkGrid(edge as 16 | 32);
  const store = farBakeStore(grid);
  return (tasks) => tasks.map((t) => runFarBakeTask(t, grid, minLevel, entryOf, store));
}
