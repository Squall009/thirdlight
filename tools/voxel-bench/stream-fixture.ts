/**
 * The streaming tests' shared world and helpers (stream.test.ts, stream-levels.test.ts): a hilly test world
 * written as region files on disk, the bundled worker module, pools and streamers over them, and the checks
 * against the world store as the oracle. `useStreamWorld()` registers the hooks that write and remove them; the
 * `let` bindings are live, so a test reads them once the hook has run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildApron,
  canonicalEditCommand,
  chunkGrid,
  chunkOfKey,
  createDenseChunk,
  createWorldStore,
  deriveNow,
  exportOrAir,
  sameDenseChunk,
  VoxelStreamer,
  WorkerPool,
  type ChunkCoord,
  type PaletteStore,
  type StreamRing,
  type VoxelEditCommand,
  type VoxelStoreCandidate,
} from '@thirdlight/voxel';
import { afterAll, beforeAll } from 'vitest';
import { pickStore } from './regions';
import {
  bundleWorker,
  DiskRegions,
  nodePoolWorker,
  REPO,
  writeWorldRegions,
} from './stream-node';
import { hillyWorld } from './worlds';

export const grid = chunkGrid(32);
/** A 256 m hilly square centred on the origin: four region columns meet at (0, 0), stacks meet at y = 0. */
export const HALF = 256;
export const world = hillyWorld({ footprint: 2 * HALF });
export const g0 = world.grids[0]!;
export const RING: StreamRing = { loadRadius: 96, unloadRadius: 128, loadHeight: 96, unloadHeight: 128, nearRadius: 48 };

export let dir = '';
export let workerFile = '';
export let oracle: PaletteStore;
export const disks: DiskRegions[] = [];
export const pools: WorkerPool[] = [];

/** Writes the test world and bundles the worker before a file's tests; closes and removes them after. */
export function useStreamWorld(): void {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tl-voxel-stream-'));
    workerFile = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', `stream-worker-test-${process.pid}.mjs`));
    oracle = pickStore(grid);
    writeWorldRegions(g0, grid, join(dir, 'world'), 'stacked', 512, -HALF, -HALF, HALF, HALF, oracle);
  }, 120_000);

  afterAll(async () => {
    for (const p of pools) p.close();
    for (const d of disks) await d.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(workerFile, { force: true });
  });
}

export function pool(size: number, extra: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}): WorkerPool {
  const p = new WorkerPool({ size, create: () => nodePoolWorker(workerFile), timeoutMs: 10_000, maxQueued: 256, ...extra });
  pools.push(p);
  return p;
}

export function streamer(p: WorkerPool, opts: { derive?: boolean; budget?: number; radius?: number; deriveMs?: number } = {}): VoxelStreamer {
  const disk = new DiskRegions(join(dir, 'world'));
  disks.push(disk);
  return new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: p, ring: RING, budgetBytes: opts.budget ?? 256 * 1024 * 1024, dependencyRadius: opts.radius ?? 2, derive: opts.derive ?? false, ...(opts.deriveMs === undefined ? {} : { deriveMsPerUpdate: opts.deriveMs }) });
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every resident chunk as the streamer reads it (its overlay over its base) equals the oracle's. */
export function expectChunksEqual(s: VoxelStreamer, truth: PaletteStore): number {
  return expectStoreEqual(s, s.overlay, truth);
}

/** Every resident chunk of `store` (the streamer's base, or its overlay over it) equals the oracle's. */
export function expectStoreEqual(s: VoxelStreamer, store: VoxelStoreCandidate, truth: PaletteStore): number {
  const a = createDenseChunk(grid);
  const b = createDenseChunk(grid);
  const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
  let n = 0;
  for (const key of s.store.chunkKeys()) {
    chunkOfKey(grid, key, c);
    exportOrAir(store, c.cx, c.cy, c.cz, a);
    exportOrAir(truth, c.cx, c.cy, c.cz, b);
    if (!sameDenseChunk(a, b)) throw new Error(`chunk (${c.cx}, ${c.cy}, ${c.cz}) differs from the oracle`);
    n++;
  }
  return n;
}

/** Every current derive result equals the derive computed on the oracle (with its whole neighbourhood). */
export function expectDerivedEqual(s: VoxelStreamer, truth: PaletteStore): number {
  let n = 0;
  for (const d of s.derivedChunks()) {
    const want = deriveNow({ edge: 32, chunk: { grid: 0, cx: d.cx, cy: d.cy, cz: d.cz }, payload: truth.chunkPayload(d.cx, d.cy, d.cz, true), radius: s.radius, apron: buildApron(truth, d.cx, d.cy, d.cz, s.radius) });
    if (want.hash !== d.result.hash || want.solid !== d.result.solid || want.exposed !== d.result.exposed) throw new Error(`derived (${d.cx}, ${d.cy}, ${d.cz}) differs from the oracle`);
    n++;
  }
  return n;
}

export function copyOracle(): PaletteStore {
  const s = createWorldStore(grid);
  const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
  for (const key of oracle.chunkKeys()) {
    chunkOfKey(grid, key, c);
    s.adoptPayload(c.cx, c.cy, c.cz, oracle.chunkPayload(c.cx, c.cy, c.cz, true));
  }
  return s;
}

export function fill(min: [number, number, number], max: [number, number, number], material: number): VoxelEditCommand {
  return canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min, max, mode: 'place', voxel: { material, role: 5, wetness: 0 } });
}
