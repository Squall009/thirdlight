/**
 * The streaming core against real boundaries: `worker_threads` workers
 * running the bundled worker module (fzstd inside, as in a browser), region
 * files on disk, a test world, and the world store as the oracle.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyEdit,
  applySaveChunk,
  buildApron,
  canonicalEditCommand,
  chunkGrid,
  chunkKey,
  chunkOfKey,
  createDenseChunk,
  createWorldStore,
  DEFAULT_SECTION_EDGE,
  dependentChunks,
  deriveFromStore,
  deriveSectionFromStore,
  DERIVED_PART,
  deriveNow,
  editBounds,
  encodeDerived,
  exportOrAir,
  jobRadius,
  PLACEHOLDER_RULES,
  PLANE_BIT,
  RegionChunkSource,
  RESIDENT_CHUNK_OVERHEAD_BYTES,
  sameDenseChunk,
  saveChunkOf,
  fieldsFeed,
  SHADER_BORDER_CELLS,
  sectionsOfChunk,
  shaderEntryAt,
  voxel,
  VOXEL_ROLE,
  VoxelStreamer,
  WorkerPool,
  type ChunkCoord,
  type JobOutcome,
  type LoadOutput,
  type PaletteStore,
  type SaveChunk,
  type StreamEvent,
  type StreamRing,
  type SwapReport,
  type VoxelEditCommand,
  type VoxelStoreCandidate,
} from '@thirdlight/voxel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanExportFiles } from '../../packages/exporter/src/scan';
import { RegionWorld } from '@thirdlight/workspace';
import { pickStore } from './regions';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, TEST_WORLD_ID, writeWorldRegions } from './stream-node';
import { hillyWorld } from './worlds';

const grid = chunkGrid(32);
/** A 256 m hilly square centred on the origin: four region columns meet at (0, 0), stacks meet at y = 0. */
const HALF = 256;
const world = hillyWorld({ footprint: 2 * HALF });
const g0 = world.grids[0]!;
const RING: StreamRing = { loadRadius: 96, unloadRadius: 128, loadHeight: 96, unloadHeight: 128, nearRadius: 48 };

let dir = '';
let workerFile = '';
let oracle: PaletteStore;
const disks: DiskRegions[] = [];
const pools: WorkerPool[] = [];

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

function pool(size: number, extra: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {}): WorkerPool {
  const p = new WorkerPool({ size, create: () => nodePoolWorker(workerFile), timeoutMs: 10_000, maxQueued: 256, ...extra });
  pools.push(p);
  return p;
}

function streamer(p: WorkerPool, opts: { derive?: boolean; budget?: number; radius?: number; deriveMs?: number } = {}): VoxelStreamer {
  const disk = new DiskRegions(join(dir, 'world'));
  disks.push(disk);
  return new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: p, ring: RING, budgetBytes: opts.budget ?? 256 * 1024 * 1024, dependencyRadius: opts.radius ?? 2, derive: opts.derive ?? false, ...(opts.deriveMs === undefined ? {} : { deriveMsPerUpdate: opts.deriveMs }) });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every resident chunk as the streamer reads it (its overlay over its base) equals the oracle's. */
function expectChunksEqual(s: VoxelStreamer, truth: PaletteStore): number {
  return expectStoreEqual(s, s.overlay, truth);
}

/** Every resident chunk of `store` (the streamer's base, or its overlay over it) equals the oracle's. */
function expectStoreEqual(s: VoxelStreamer, store: VoxelStoreCandidate, truth: PaletteStore): number {
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
function expectDerivedEqual(s: VoxelStreamer, truth: PaletteStore): number {
  let n = 0;
  for (const d of s.derivedChunks()) {
    const want = deriveNow({ edge: 32, chunk: { grid: 0, cx: d.cx, cy: d.cy, cz: d.cz }, payload: truth.chunkPayload(d.cx, d.cy, d.cz, true), radius: s.radius, apron: buildApron(truth, d.cx, d.cy, d.cz, s.radius) });
    if (want.hash !== d.result.hash || want.solid !== d.result.solid || want.exposed !== d.result.exposed) throw new Error(`derived (${d.cx}, ${d.cy}, ${d.cz}) differs from the oracle`);
    n++;
  }
  return n;
}

function copyOracle(): PaletteStore {
  const s = createWorldStore(grid);
  const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
  for (const key of oracle.chunkKeys()) {
    chunkOfKey(grid, key, c);
    s.adoptPayload(c.cx, c.cy, c.cz, oracle.chunkPayload(c.cx, c.cy, c.cz, true));
  }
  return s;
}

function fill(min: [number, number, number], max: [number, number, number], material: number): VoxelEditCommand {
  return canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min, max, mode: 'place', voxel: { material, role: 5, wetness: 0 } });
}

describe('worker pool (real module workers)', () => {
  it('round-trips a load job with transferred buffers, decoding to the oracle chunk', async () => {
    const p = pool(1);
    // A stored surface chunk: read its bytes from the region file through the same source the streamer uses.
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    const src = disk.source(grid, 'stacked', 512);
    let cy = -4;
    while (oracle.chunkForm(0, cy, 0) !== 'stored') cy++;
    const c = { cx: 0, cy, cz: 0 };
    const [read] = await src.read([c]);
    if (read?.kind !== 'stored') throw new Error('expected a stored chunk');
    const bytes = read.bytes.slice();
    const outcome = p.submit<LoadOutput>({ id: 1, kind: 'load', lane: 'near', distance: 0, input: { edge: 32, chunk: { grid: 0, ...c }, bytes: { stored: bytes, raw: read.raw }, hash: true }, transfer: [bytes.buffer] });
    // Sent at once (an idle worker): the buffer moved, nothing was copied.
    expect(bytes.byteLength).toBe(0);
    const o = await outcome;
    if (o.status !== 'done') throw new Error(o.status);
    const store = createWorldStore(grid);
    store.adoptPayload(c.cx, c.cy, c.cz, o.output.payload);
    const a = createDenseChunk(grid);
    const b = createDenseChunk(grid);
    store.exportChunk(c.cx, c.cy, c.cz, a);
    oracle.exportChunk(c.cx, c.cy, c.cz, b);
    expect(sameDenseChunk(a, b)).toBe(true);
    expect(o.output.hash?.length).toBe(16);
    expect(o.output.decodeUs).toBeGreaterThan(0);
    // A buffer moved to a worker and back arrives intact.
    const buf = new Uint8Array(1 << 16).map((_, i) => i * 7);
    const echoed = await p.submit<{ buf: ArrayBuffer }>({ id: 2, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 0, buf: buf.buffer }, transfer: [buf.buffer] });
    expect(buf.byteLength).toBe(0);
    if (echoed.status !== 'done') throw new Error(echoed.status);
    expect(new Uint8Array(echoed.output.buf)[1000]).toBe((1000 * 7) & 0xff);
  });

  it('runs queued jobs edit lane first, then near, then far, nearest first', async () => {
    const p = pool(1);
    const order: number[] = [];
    const blocker = p.submit({ id: 100, kind: 'test-sleep', lane: 'far', distance: 0, input: { ms: 80 }, transfer: [] });
    const jobs: Array<[number, 'edit' | 'near' | 'far', number]> = [
      [101, 'far', 5],
      [102, 'near', 50],
      [103, 'edit', 900],
      [104, 'near', 10],
      [105, 'far', 1],
      [106, 'edit', 3],
    ];
    const done = jobs.map(([id, lane, d]) => p.submit({ id, kind: 'test-sleep', lane, distance: d, input: { ms: 0 }, transfer: [] }).then(() => order.push(id)));
    await Promise.all([blocker, ...done]);
    expect(order).toEqual([106, 103, 104, 102, 105, 101]);
  });

  it('cancels a queued job unsent and a sent one at once (its late reply ignored); back-pressure answers queue_full', async () => {
    const p = pool(1, { maxQueued: 2 });
    const sent = p.submit({ id: 1, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 100 }, transfer: [] });
    const queued = p.submit({ id: 2, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 0 }, transfer: [] });
    const third = p.submit({ id: 3, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 0 }, transfer: [] });
    expect(p.room()).toBe(0);
    expect((await p.submit({ id: 4, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 0 }, transfer: [] })).status).toBe('queue_full');
    expect(p.cancel(2)).toBe(true);
    expect(p.cancel(1)).toBe(true);
    expect((await queued).status).toBe('cancelled');
    expect((await sent).status).toBe('cancelled');
    expect((await third).status).toBe('done');
    expect(p.stats.cancelledQueued).toBe(1);
    expect(p.stats.cancelledSent).toBe(1);
    expect(p.stats.lateReplies).toBe(1);
  });

  it('times out a slow job, ignores its late reply, and replaces a hung or crashed worker', async () => {
    const p = pool(1, { timeoutMs: 60, hangMs: 400 });
    const slow = await p.submit({ id: 1, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 200 }, transfer: [] });
    expect(slow.status).toBe('timeout');
    // The worker is still busy with it: the next job waits, then runs once the late reply is ignored.
    const next = await p.submit({ id: 2, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 0 }, transfer: [] });
    expect(next.status).toBe('done');
    expect(p.stats.lateReplies).toBe(1);
    expect(p.stats.replaced).toBe(0);
    const hung = await p.submit({ id: 3, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 5000 }, transfer: [] });
    expect(hung.status).toBe('timeout');
    await sleep(500);
    expect(p.stats.replaced).toBe(1);
    expect((await p.submit({ id: 4, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 0 }, transfer: [] })).status).toBe('done');
    const crash = p.submit({ id: 5, kind: 'test-crash', lane: 'near', distance: 0, input: null, transfer: [] });
    expect((await crash).status).toBe('done');
    const after: JobOutcome = await p.submit({ id: 6, kind: 'test-sleep', lane: 'near', distance: 0, input: { ms: 20 }, transfer: [] });
    expect(['done', 'worker_lost']).toContain(after.status);
    await sleep(100);
    expect(p.stats.replaced).toBe(2);
    expect((await p.submit({ id: 7, kind: 'load', lane: 'near', distance: 0, input: { edge: 32, chunk: { grid: 0, cx: 0, cy: 0, cz: 0 }, bytes: { stored: new Uint8Array([1, 2, 3]), raw: false }, hash: false }, transfer: [] })).status).toBe('refused');
    expect((await p.submit({ id: 8, kind: 'nope', lane: 'near', distance: 0, input: null, transfer: [] })).status).toBe('unknown_kind');
  });
});

describe('streamer (workers, region files on disk)', () => {
  it('streams the ring around a region corner, every chunk and derive result equal to the oracle', async () => {
    const s = streamer(pool(2), { derive: true });
    const events: StreamEvent['type'][] = [];
    s.on((e) => events.push(e.type));
    s.setFocus(0, 40, 0);
    await s.settle();
    const m = s.metrics();
    expect(m.resident).toBeGreaterThan(150);
    expect(m.residentStored).toBeGreaterThan(30);
    expect(expectChunksEqual(s, oracle)).toBeGreaterThan(30);
    expect(expectDerivedEqual(s, oracle)).toBeGreaterThan(30);
    // The derived chunks around the origin straddle four region columns and two stacks.
    expect(s.derivedOf(-1, -1, -1)).not.toBeNull();
    expect(s.derivedOf(0, 0, 0)).not.toBeNull();
    expect(m.bytes.chunks).toBe(m.storeBytes + RESIDENT_CHUNK_OVERHEAD_BYTES * m.resident);
    expect(m.bytes.total).toBeLessThan(m.bytes.budget);
    expect(m.counters.damaged).toBe(0);
    expect(events.filter((e) => e === 'loaded').length).toBe(m.counters.loads);
  });

  it('reads the ring in whole columns: fewer requests than stored columns, bytes within 2x of the stored bytes, every chunk equal to the oracle', async () => {
    // A pool queue far smaller than the ring's stored chunks: read chunks wait for room instead of being read again.
    const s = streamer(pool(2, { maxQueued: 4 }));
    const disk = disks.at(-1)!;
    s.setFocus(0, 40, 0);
    await s.settle();
    const m = s.metrics();
    expect(expectChunksEqual(s, oracle)).toBeGreaterThan(m.residentStored);
    expect(m.counters.retried).toBe(0);
    expect(m.counters.damaged).toBe(0);
    // The oracle: the same chunks read one request a stored chunk (no joining) from the same files.
    const exact = new DiskRegions(join(dir, 'world'));
    disks.push(exact);
    const one = new RegionChunkSource({ worldId: TEST_WORLD_ID, gridId: 0, grid, layout: 'stacked', footprint: 512, open: (n) => exact.open(n), maxOpen: 64, maxGap: -1 });
    const ring: ChunkCoord[] = [];
    const c: ChunkCoord = { cx: 0, cy: 0, cz: 0 };
    for (const key of s.store.chunkKeys()) ring.push({ ...chunkOfKey(grid, key, c) });
    const reads = await one.read(ring);
    const stored = reads.filter((r) => r.kind === 'stored');
    // Columns per region file (a stacked region splits a column at its floor).
    const columns = new Set(stored.map((r) => `${r.cx},${Math.floor(r.cy / 16)},${r.cz}`));
    const tableRequests = exact.requests - stored.length;
    const storedBytes = exact.bytes;
    expect(stored.length).toBe(m.residentStored);
    expect(columns.size).toBeLessThan(stored.length);
    expect(disk.requests - tableRequests).toBeLessThanOrEqual(columns.size);
    expect(disk.bytes).toBeGreaterThanOrEqual(storedBytes);
    expect(disk.bytes).toBeLessThanOrEqual(2 * storedBytes);
    console.log(`ring reads: ${stored.length} stored chunks in ${columns.size} columns; ${disk.requests - tableRequests} chunk requests (one a chunk: ${stored.length}); ${disk.bytes} bytes fetched of ${storedBytes} (tables ${tableRequests} requests)`);
  });

  it('looks at a chunk waiting for neighbours again only when one lands, and derives it then', async () => {
    const s = streamer(pool(2), { derive: true });
    s.setFocus(0, 40, 0);
    await s.settle();
    // Settled: chunks at the ring's edge wait for neighbours that are never loaded; updates do not look at them again.
    const checks = s.counters.deriveChecks;
    for (let i = 0; i < 20; i++) s.update();
    expect(s.counters.deriveChecks).toBe(checks);
    // One chunk east: the new edge loads, and every chunk whose neighbours are now all known is derived, as the oracle derives it.
    s.setFocus(32, 40, 0);
    await s.settle();
    expect(s.counters.deriveChecks).toBeGreaterThan(checks);
    const resident = (cx: number, cy: number, cz: number): boolean => s.isResident(cx, cy, cz);
    let complete = 0;
    for (const key of s.store.chunkKeys()) {
      const c = chunkOfKey(grid, key);
      let known = true;
      for (let dx = -1; dx <= 1 && known; dx++) for (let dy = -1; dy <= 1 && known; dy++) for (let dz = -1; dz <= 1 && known; dz++) known = resident(c.cx + dx, c.cy + dy, c.cz + dz);
      if (!known) continue;
      expect(s.derivedOf(c.cx, c.cy, c.cz), `chunk (${c.cx}, ${c.cy}, ${c.cz})`).not.toBeNull();
      complete++;
    }
    expect(complete).toBeGreaterThan(30);
    expect(expectDerivedEqual(s, oracle)).toBeGreaterThanOrEqual(complete);
  });

  it('rebuilds every derived result within R of an edit at a chunk corner, across chunk and region boundaries; refuses stale results', async () => {
    // No time cap on aprons: every rebuild is sent in the one update, so the second edit finds them all in flight.
    const s = streamer(pool(2), { derive: true, deriveMs: 10_000 });
    const truth = copyOracle();
    s.setFocus(0, 40, 0);
    await s.settle();
    const before = new Map([...s.derivedChunks()].map((d) => [chunkKey(grid, d.cx, d.cy, d.cz), d.result.hash]));
    // A 3-cell box at the corner where 8 chunks meet (and four regions, and two stacks): R = 2 reaches all 8.
    const corner = fill([-1, -1, -1], [1, 1, 1], 40);
    s.edit(corner);
    applyEdit({ store: () => truth }, corner);
    const rebuilt = new Set<string>();
    s.on((e) => {
      if (e.type === 'derived') rebuilt.add(`${e.cx},${e.cy},${e.cz}`);
    });
    // Start the rebuilds, then edit again next to the corner before they finish: their results come back stale.
    s.update();
    expect(s.metrics().deriving).toBeGreaterThan(0);
    const again = fill([2, -3, 2], [3, -2, 3], 41);
    s.edit(again);
    applyEdit({ store: () => truth }, again);
    for (let i = 0; i < 500 && s.metrics().deriving > 0; i++) await sleep(10);
    await s.settle();
    expect(s.counters.staleRefused).toBeGreaterThan(0);
    for (const dx of [-1, 0]) for (const dy of [-1, 0]) for (const dz of [-1, 0]) expect(rebuilt.has(`${dx},${dy},${dz}`)).toBe(true);
    expect(expectChunksEqual(s, truth)).toBeGreaterThan(30);
    expect(expectDerivedEqual(s, truth)).toBeGreaterThan(30);
    // Chunks far from the edits kept their results.
    const after = new Map([...s.derivedChunks()].map((d) => [chunkKey(grid, d.cx, d.cy, d.cz), d.result.hash]));
    expect(after.get(chunkKey(grid, 2, 1, 2))).toBe(before.get(chunkKey(grid, 2, 1, 2)));
    // The edits are in the overlay: the base still holds the files' content, so no chunk is dirty.
    expect(expectStoreEqual(s, s.store, oracle)).toBeGreaterThan(30);
    expect(s.tracker.isDirty({ grid: 0, key: chunkKey(grid, -1, -1, -1) })).toBe(false);
  });

  it('derives with assembly rules in real workers, equal to the in-thread derive; an edit at a chunk corner rebuilds what depends on it', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: pool(2), ring: RING, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(PLACEHOLDER_RULES), derive: true, rules: PLACEHOLDER_RULES, deriveMsPerUpdate: 10_000, sectionEdge: 32 });
    const truth = copyOracle();
    const expectAssemblyEqual = (): number => {
      let n = 0;
      for (const d of s.derivedChunks()) {
        if (d.result.assembly === null) continue;
        const want = encodeDerived(deriveFromStore(truth, d.cx, d.cy, d.cz, PLACEHOLDER_RULES));
        if (Buffer.compare(Buffer.from(encodeDerived(d.result.assembly)), Buffer.from(want)) !== 0) throw new Error(`derived (${d.cx}, ${d.cy}, ${d.cz}) differs from the in-thread derive`);
        n++;
      }
      return n;
    };
    s.setFocus(0, 40, 0);
    await s.settle();
    expect(expectAssemblyEqual()).toBeGreaterThan(30);
    const m = s.metrics();
    expect(m.bytes.derived).toBeGreaterThan(0);
    const before = new Map([...s.derivedChunks()].map((d) => [chunkKey(grid, d.cx, d.cy, d.cz), d.result.hash]));
    const rebuilt = new Set<string>();
    s.on((e) => {
      if (e.type === 'derived') rebuilt.add(`${e.cx},${e.cy},${e.cz}`);
    });
    const corner = fill([-1, -1, -1], [0, 0, 0], 40);
    s.edit(corner);
    applyEdit({ store: () => truth }, corner);
    await s.settle();
    for (const dx of [-1, 0]) for (const dy of [-1, 0]) for (const dz of [-1, 0]) expect(rebuilt.has(`${dx},${dy},${dz}`)).toBe(true);
    expect(rebuilt.size).toBe(8);
    expect(expectAssemblyEqual()).toBeGreaterThan(30);
    const after = new Map([...s.derivedChunks()].map((d) => [chunkKey(grid, d.cx, d.cy, d.cz), d.result.hash]));
    expect(after.get(chunkKey(grid, 2, 1, 2))).toBe(before.get(chunkKey(grid, 2, 1, 2)));
  });

  it('derives 16³ and 8³ sections in real workers equal to the in-thread section derive; a blast re-derives only the sections within R and swaps them in one go', async () => {
    for (const edge of [16, 8] as const) {
      const disk = new DiskRegions(join(dir, 'world'));
      disks.push(disk);
      const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: pool(4), ring: RING, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(PLACEHOLDER_RULES), derive: true, rules: PLACEHOLDER_RULES, sectionEdge: edge });
      const sections = s.sections;
      expect(sections.edge).toBe(edge);
      const truth = copyOracle();
      // What a renderer shows: the newest result each section's events delivered.
      const shown = new Map<number, number>();
      const swaps: SwapReport[] = [];
      s.on((e) => {
        if (e.type === 'swap') swaps.push(e.report);
        else if (e.type === 'derived') shown.set(chunkKey(sections, e.cx, e.cy, e.cz), s.derivedOf(e.cx, e.cy, e.cz)!.hash);
      });
      s.setFocus(0, 40, 0);
      await s.settle();
      // Every section near the region corner equals the section derived in this thread cell by cell from the oracle.
      const sameAsFresh = (store: PaletteStore): number => {
        let n = 0;
        for (const d of s.derivedChunks()) {
          if (d.result.assembly === null || Math.abs(d.cx * edge) > 64 || Math.abs(d.cz * edge) > 64 || Math.abs(d.cy * edge - 40) > 64) continue;
          const want = encodeDerived(deriveSectionFromStore(store, sections, d.cx, d.cy, d.cz, PLACEHOLDER_RULES));
          if (Buffer.compare(Buffer.from(encodeDerived(d.result.assembly)), Buffer.from(want)) !== 0) throw new Error(`section ${edge}³ (${d.cx}, ${d.cy}, ${d.cz}) differs from the in-thread derive`);
          n++;
        }
        return n;
      };
      expect(sameAsFresh(truth)).toBeGreaterThan(40);
      // Every section of a chunk whose neighbours are all resident has its result (none left waiting).
      let complete = 0;
      for (const key of s.store.chunkKeys()) {
        const c = chunkOfKey(grid, key);
        let known = true;
        for (let dx = -1; dx <= 1 && known; dx++) for (let dy = -1; dy <= 1 && known; dy++) for (let dz = -1; dz <= 1 && known; dz++) known = s.isResident(c.cx + dx, c.cy + dy, c.cz + dz);
        if (!known) continue;
        for (const sec of sectionsOfChunk(grid, sections, c.cx, c.cy, c.cz)) expect(s.derivedOf(sec.sx, sec.sy, sec.sz), `section (${sec.sx}, ${sec.sy}, ${sec.sz})`).not.toBeNull();
        complete++;
      }
      expect(complete).toBeGreaterThan(30);
      expect([...s.derivedChunks()].every((d) => d.result.assembly === null || d.result.assembly.edge === edge)).toBe(true);

      // A 2 m blast where 4 chunks meet (x and z faces): only the sections within R of the cells it can change are derived again.
      const blast = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [4, 4, 4], points: [0, 40, 0], mode: 'place', voxel: { material: 40, role: 5, wetness: 0 }, smooth: false });
      const box = editBounds(grid, blast);
      const want = dependentChunks(sections, box, s.radius).map((c) => chunkKey(sections, c.cx, c.cy, c.cz));
      const before = new Map(want.map((k) => [k, shown.get(k)]));
      const derived0 = s.counters.derives;
      const out = s.edit(blast);
      applyEdit({ store: () => truth }, blast);
      // Reads see the blast at once, before anything is rebuilt.
      expect(s.voxelAt(0, 40, 0, voxel()).material).toBe(40);
      expect(swaps).toHaveLength(0);
      // Sampled at every task boundary until the swap: either none of the sections shows its new result, or all do.
      const changed = (): number => want.filter((k) => shown.get(k) !== before.get(k)).length;
      let partial = 0;
      let samples = 0;
      while (swaps.length === 0) {
        const n = changed();
        if (n !== 0) partial++;
        samples++;
        await new Promise((r) => setImmediate(r));
      }
      expect(samples).toBeGreaterThan(1);
      expect(partial).toBe(0);
      expect(swaps[0]!.groups).toEqual([out.group]);
      expect(swaps[0]!.sections).toBe(want.length);
      expect(s.counters.derives - derived0).toBe(want.length);
      expect(swaps[0]!.meshUs).toHaveLength(want.length);
      // The blast's jobs went out per chunk (at least one each of the 4), spread over the workers.
      expect(swaps[0]!.jobs).toBeGreaterThanOrEqual(4);
      await s.settle();
      expect(sameAsFresh(truth)).toBeGreaterThan(40);
      // Fewer cells than the 4 whole chunks a whole-chunk derive rebuilds (4 · (32 / edge)³ sections).
      expect(want.length).toBeLessThan(4 * (32 / edge) ** 3);

      // Two blasts in a row, the second before the first is shown: they merge and swap as one.
      const b1 = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [20, 40, 20], mode: 'place', voxel: { material: 41, role: 5, wetness: 0 }, smooth: false });
      const b2 = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [2, 2, 2], points: [22, 40, 20], mode: 'place', voxel: { material: 42, role: 5, wetness: 0 }, smooth: false });
      swaps.length = 0;
      const g1 = s.edit(b1).group;
      const g2 = s.edit(b2).group;
      applyEdit({ store: () => truth }, b1);
      applyEdit({ store: () => truth }, b2);
      await s.settle();
      expect(swaps).toHaveLength(1);
      expect([...swaps[0]!.groups].sort()).toEqual([g1, g2].sort());
      expect(sameAsFresh(truth)).toBeGreaterThan(40);
    }
  });

  it('reads through the runtime overlay: the base never written, every derive a fresh derive of the merged view, digs kept over unload and reload, paints rebuild shader data only, saves keep the saved fields', async () => {
    const disk = new DiskRegions(join(dir, 'world'));
    disks.push(disk);
    // The engine default: 16-cell sections with assembly rules.
    const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512), pool: pool(4), ring: RING, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(PLACEHOLDER_RULES), derive: true, rules: PLACEHOLDER_RULES });
    const sections = s.sections;
    expect(sections.edge).toBe(DEFAULT_SECTION_EDGE);
    const truth = copyOracle();
    const swaps: SwapReport[] = [];
    s.on((e) => {
      if (e.type === 'swap') swaps.push(e.report);
    });
    const surface = (x: number, z: number): number => {
      const v = voxel();
      for (let y = 160; y > -160; y--) if (s.voxelAt(x, y, z, v).material !== 0) return y;
      throw new Error(`no ground at ${x}, ${z}`);
    };
    // Centred on the ground at the origin, so every section near the edits has its neighbours resident.
    s.setFocus(0, 40, 0);
    await s.settle();
    const y0 = surface(0, 0);
    s.setFocus(0, y0, 0);
    await s.settle();
    /** Sections near the edits: each equals a fresh in-thread derive of `store` (the streamer's own merged view, or the oracle). */
    const sameAsFresh = (store: VoxelStoreCandidate): number => {
      let n = 0;
      for (const d of s.derivedChunks()) {
        if (d.result.assembly === null || Math.abs(d.cx * 16) > 64 || Math.abs(d.cz * 16) > 64 || Math.abs(d.cy * 16 - y0) > 64) continue;
        const want = encodeDerived(deriveSectionFromStore(store, sections, d.cx, d.cy, d.cz, PLACEHOLDER_RULES));
        if (Buffer.compare(Buffer.from(encodeDerived(d.result.assembly)), Buffer.from(want)) !== 0) throw new Error(`section (${d.cx}, ${d.cy}, ${d.cz}) differs from a fresh derive`);
        n++;
      }
      return n;
    };
    const kinds: Record<string, unknown> = {};
    /** Applies an edit to the streamer and the oracle; waits for its swap; what it derived. */
    const run = async (what: string, cmd: VoxelEditCommand): Promise<{ derives: number; shaderDerives: number; fields: number }> => {
      const d0 = s.counters.derives;
      const sh0 = s.counters.shaderDerives;
      swaps.length = 0;
      const out = s.edit(cmd);
      applyEdit({ store: () => truth }, cmd);
      await s.settle();
      const r = { derives: s.counters.derives - d0, shaderDerives: s.counters.shaderDerives - sh0, fields: out.fields };
      kinds[what] = { cells: out.cells, chunks: out.chunks.length, ...r, swaps: swaps.length, swapMs: swaps[0]?.ms ?? null, sections: swaps[0]?.sections ?? 0, overlayCells: s.overlay.changedCells, overlayChunks: s.overlay.changedChunks().length, overlayBytes: s.overlay.memoryBytes() };
      return r;
    };

    // A 1.5 m dig where four chunks meet: every section within R of it derived again, nothing else.
    const dig = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [3, 3, 3], points: [0, y0, 0], mode: 'dig', smooth: false });
    const digged = await run('dig 1.5 m', dig);
    expect(digged.derives).toBe(dependentChunks(sections, editBounds(grid, dig), s.radius).length);
    expect(s.voxelAt(0, y0, 0, voxel()).material).toBe(0);
    // A 4 m dig beside it.
    const big = canonicalEditCommand({ v: 2, grid: 0, kind: 'brush', shape: 'sphere', size: [8, 8, 8], points: [24, surface(24, 8), 8], mode: 'dig', smooth: false });
    await run('dig 4 m', big);
    // The base still holds the files' content; reads and derives see the edits.
    expect(expectStoreEqual(s, s.store, oracle)).toBeGreaterThan(30);
    expect(expectChunksEqual(s, truth)).toBeGreaterThan(30);
    expect(sameAsFresh(s.overlay)).toBeGreaterThan(40);
    expect(sameAsFresh(truth)).toBeGreaterThan(40);

    // A material paint, then a wetness paint of the same cells: shader data only, no mesh, collision, nav or light.
    // Kept well inside the ring: a section derives only once every chunk around its chunk is resident.
    const px = 12;
    const pz = -20;
    const py = surface(px, pz);
    const paintBox = { min: [px - 3, py - 2, pz - 3] as [number, number, number], max: [px + 3, py, pz + 3] as [number, number, number] };
    const material = await run('material paint', canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', ...paintBox, mode: 'paint', voxel: { material: 77, role: VOXEL_ROLE.terrain, wetness: 0 } }));
    expect(material.fields & PLANE_BIT.material).not.toBe(0);
    expect(fieldsFeed(material.fields)).toBe(DERIVED_PART.shader);
    expect(material.derives).toBe(0);
    expect(material.shaderDerives).toBeGreaterThan(0);
    const wetCmd = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', ...paintBox, mode: 'paint', voxel: { material: 77, role: VOXEL_ROLE.terrain, wetness: 6 } });
    const wet = await run('wetness paint', wetCmd);
    expect(wet.fields).toBe(PLANE_BIT.wetness);
    expect(wet.derives).toBe(0);
    expect(wet.shaderDerives).toBe(dependentChunks(sections, editBounds(grid, wetCmd), SHADER_BORDER_CELLS).length);
    // Rain alone, on a chunk nothing else changed: one cell wetted with its own material and role.
    const rx = -20;
    const rz = 40;
    const ry = surface(rx, rz);
    const rv = s.voxelAt(rx, ry, rz, voxel());
    const rain = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [rx, ry, rz], max: [rx, ry, rz], mode: 'paint', voxel: { material: rv.material, role: rv.role, wetness: 7 } });
    const rained = await run('rain (one cell)', rain);
    expect(rained.fields).toBe(PLANE_BIT.wetness);
    expect(rained.derives).toBe(0);
    expect(sameAsFresh(s.overlay)).toBeGreaterThan(40);
    expect(sameAsFresh(truth)).toBeGreaterThan(40);
    expect(expectStoreEqual(s, s.store, oracle)).toBeGreaterThan(30);
    const m = s.metrics();
    expect(m.bytes.overlay).toBe(s.overlay.memoryBytes());
    expect(m.bytes.total).toBe(m.bytes.chunks + m.bytes.derived + m.bytes.overlay + m.bytes.tables);

    /** What a save of the edits restores onto the shipped world: the saved fields of the edits, the base's wetness. */
    const expectSaved = (entries: readonly SaveChunk[]): void => {
      const restored = copyOracle();
      for (const e of entries) applySaveChunk(restored, e, true);
      const a = createDenseChunk(grid);
      const b = createDenseChunk(grid);
      const w = createDenseChunk(grid);
      for (const c of s.overlay.changedChunks()) {
        exportOrAir(restored, c.cx, c.cy, c.cz, a);
        exportOrAir(truth, c.cx, c.cy, c.cz, b);
        exportOrAir(oracle, c.cx, c.cy, c.cz, w);
        for (let i = 0; i < grid.cellsPerChunk; i++) {
          if (a.material[i] !== b.material[i] || a.role[i] !== b.role[i] || a.shape[i] !== b.shape[i]) throw new Error(`saved chunk (${c.cx}, ${c.cy}, ${c.cz}) lost an edit at cell ${i}`);
          // Air is whole (a dug cell keeps no wetness); every other cell keeps the base's wetness.
          if (a.wetness[i] !== (a.material[i] === 0 ? 0 : w.material[i] === 0 ? b.wetness[i] : w.wetness[i])) throw new Error(`saved chunk (${c.cx}, ${c.cy}, ${c.cz}) kept wetness at cell ${i}`);
        }
      }
    };
    const rainChunk = chunkKey(grid, rx >> 5, ry >> 5, rz >> 5);
    const saved = await s.saveChunks();
    expectSaved(saved);
    // The chunk only rain touched gives no entry; a save keeping wetness too has it.
    expect(saved.some((e) => chunkKey(grid, e.cx, e.cy, e.cz) === rainChunk)).toBe(false);
    expect((await s.saveChunks(PLANE_BIT.material | PLANE_BIT.role | PLANE_BIT.shape | PLANE_BIT.wetness)).some((e) => chunkKey(grid, e.cx, e.cy, e.cz) === rainChunk)).toBe(true);

    // Away: every edited chunk unloads, the overlay stays (counted), and a save reads their bases from the files again.
    const overlayBytes = s.overlay.memoryBytes();
    const changedCells = s.overlay.changedCells;
    s.setFocus(0, y0, 600);
    await s.settle();
    for (const c of s.overlay.changedChunks()) expect(s.isResident(c.cx, c.cy, c.cz)).toBe(false);
    expect(s.overlay.changedCells).toBe(changedCells);
    expect(s.metrics().bytes.overlay).toBe(overlayBytes);
    const away = await s.saveChunks();
    expect(away).toEqual(saved);
    // Back: the dig is still there, and every section derives as the edited world does.
    s.setFocus(0, y0, 0);
    await s.settle();
    expect(s.voxelAt(0, y0, 0, voxel()).material).toBe(0);
    expect(expectChunksEqual(s, truth)).toBeGreaterThan(30);
    expect(expectStoreEqual(s, s.store, oracle)).toBeGreaterThan(30);
    expect(sameAsFresh(truth)).toBeGreaterThan(40);
    expect(await s.saveChunks()).toEqual(saved);

    // Quit: the overlay goes, the edited sections derive as the shipped world again, in one swap.
    swaps.length = 0;
    const group = s.clearOverlay();
    expect(s.voxelAt(0, y0, 0, voxel()).material).not.toBe(0);
    await s.settle();
    expect(swaps.map((w) => w.groups)).toEqual([[group]]);
    expect(s.metrics().bytes.overlay).toBe(0);
    expect(sameAsFresh(oracle)).toBeGreaterThan(40);
    expect(await s.saveChunks()).toEqual([]);
    console.log(`overlay measure ${JSON.stringify({ perCell: Number((overlayBytes / changedCells).toFixed(2)), cells: changedCells, kinds })}`);
    // One scenario in order (edits, a trip away and back, a quit): about 4 s alone, more under a gate's load.
  }, 30_000);

  it('refreshes chunks another writer changed and saved: tables read again, content swapped, everything within R rebuilt', async () => {
    // The writer is the backend's world folder; the reader opens each file per read, as an HTTP range request does.
    const wdir = join(dir, 'written');
    const writer = RegionWorld.create(wdir, { grid, worldId: TEST_WORLD_ID, layout: 'stacked', footprint: 512 }, copyOracle());
    const reader = (): RegionChunkSource =>
      new RegionChunkSource({
        worldId: TEST_WORLD_ID,
        gridId: 0,
        grid,
        layout: 'stacked',
        footprint: 512,
        maxOpen: 64,
        open: (name) =>
          writer.files.get(name)?.hash == null
            ? null
            : {
                read: async (offset, length) => {
                  const h = await openFile(join(wdir, name), 'r');
                  try {
                    const buf = Buffer.alloc(length);
                    const { bytesRead } = await h.read(buf, 0, length, offset);
                    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
                  } finally {
                    await h.close();
                  }
                },
              },
      });
    const source = reader();
    const s = new VoxelStreamer({ store: createWorldStore(grid), source, pool: pool(2), ring: RING, budgetBytes: 256 * 1024 * 1024, dependencyRadius: jobRadius(PLACEHOLDER_RULES), derive: true, rules: PLACEHOLDER_RULES, deriveMsPerUpdate: 10_000, sectionEdge: 32 });
    s.setFocus(0, 40, 0);
    await s.settle();
    // A stale reader (tables opened before the write) of every stored chunk of the files the edit rewrites.
    const stale = reader();
    const storedNear: ChunkCoord[] = [];
    for (const key of writer.store.chunkKeys()) {
      const c = chunkOfKey(grid, key);
      if (Math.abs(c.cx) <= 2 && Math.abs(c.cz) <= 2 && writer.store.chunkForm(c.cx, c.cy, c.cz) === 'stored') storedNear.push(c);
    }
    await stale.read(storedNear);

    const out = writer.edit(fill([-1, -1, -1], [0, 0, 0], 40));
    expect(writer.save().files).toBeGreaterThan(0);
    const changed = out.chunks.map((u) => ({ cx: u.cx, cy: u.cy, cz: u.cz }));
    expect(changed.length).toBe(8);

    // Read through the stale tables: the replaced files' chunks fail their checks, the tables are read again once, and the bytes are the new ones.
    const reads = await stale.read(storedNear);
    expect(stale.retries).toBeGreaterThan(0);
    expect(reads.every((r) => r.kind !== 'damaged')).toBe(true);

    const rebuilt = new Set<string>();
    s.on((e) => {
      if (e.type === 'derived') rebuilt.add(`${e.cx},${e.cy},${e.cz}`);
    });
    s.refresh(changed);
    await s.settle();
    expect(s.counters.refreshed).toBe(8);
    expect(s.counters.refreshDropped).toBe(0);
    for (const c of changed) expect(rebuilt.has(`${c.cx},${c.cy},${c.cz}`)).toBe(true);
    expect(expectChunksEqual(s, writer.store)).toBeGreaterThan(30);
    let n = 0;
    for (const d of s.derivedChunks()) {
      if (d.result.assembly === null) continue;
      const want = encodeDerived(deriveFromStore(writer.store, d.cx, d.cy, d.cz, PLACEHOLDER_RULES));
      expect(Buffer.compare(Buffer.from(encodeDerived(d.result.assembly)), Buffer.from(want))).toBe(0);
      n++;
    }
    expect(n).toBeGreaterThan(30);
    // Refreshed chunks are not dirty here: the writer saved them, nothing holds them past the ring.
    expect(s.tracker.dirty().length).toBe(0);

    // Given the edit's cell box, a refresh rebuilds only the chunks within R of the cells it can change (a cell on
    // the x and z chunk faces: 4 chunks, not the 27 around the changed chunk), and none is left stale.
    const one = canonicalEditCommand({ v: 2, grid: 0, kind: 'set', cells: [0, 40, 0], voxel: { material: 41, role: 3, wetness: 0, shape: 15 } });
    const out2 = writer.edit(one);
    writer.save();
    rebuilt.clear();
    const box = editBounds(grid, one);
    s.refresh(out2.chunks.map((u) => ({ cx: u.cx, cy: u.cy, cz: u.cz })), box);
    await s.settle();
    const want = dependentChunks(grid, box, jobRadius(PLACEHOLDER_RULES)).map((c) => `${c.cx},${c.cy},${c.cz}`);
    expect(want).toHaveLength(4);
    expect([...rebuilt].sort()).toEqual(want.sort());
    for (const d of s.derivedChunks()) {
      if (d.result.assembly === null) continue;
      const fresh = encodeDerived(deriveFromStore(writer.store, d.cx, d.cy, d.cz, PLACEHOLDER_RULES));
      expect(Buffer.compare(Buffer.from(encodeDerived(d.result.assembly)), Buffer.from(fresh))).toBe(0);
    }

    // A wetness-only change (rain on the wall cell and its neighbours, across the x and z chunk faces) feeds only the
    // shader data: the shader data of the chunks within its border of the change is derived again and nothing else,
    // and every result still equals a fresh full derive.
    const wet = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-1, 38, -1], max: [0, 40, 0], mode: 'paint', voxel: { material: 41, role: 3, wetness: 5 } });
    const out3 = writer.edit(canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [-1, 38, -1], max: [0, 40, 0], mode: 'place', voxel: { material: 41, role: 3, wetness: 0 } }));
    writer.save();
    s.refresh(out3.chunks.map((u) => ({ cx: u.cx, cy: u.cy, cz: u.cz })), editBounds(grid, wet), fieldsFeed(out3.fields));
    await s.settle();
    const wetOut = writer.edit(wet);
    expect(wetOut.fields).toBe(PLANE_BIT.wetness);
    expect(fieldsFeed(wetOut.fields)).toBe(DERIVED_PART.shader);
    writer.save();
    rebuilt.clear();
    const derivesBefore = s.counters.derives;
    const shaderBefore = s.counters.shaderDerives;
    const shaderOnly = new Set<string>();
    s.on((e) => {
      if (e.type === 'shader') shaderOnly.add(`${e.cx},${e.cy},${e.cz}`);
    });
    const wetChunks = wetOut.chunks.map((u) => ({ cx: u.cx, cy: u.cy, cz: u.cz }));
    expect(wetChunks.length).toBe(4);
    s.refresh(wetChunks, editBounds(grid, wet), fieldsFeed(wetOut.fields));
    await s.settle();
    expect([...rebuilt]).toEqual([]);
    expect(s.counters.derives).toBe(derivesBefore);
    expect(s.counters.shaderDerives - shaderBefore).toBe(4);
    expect([...shaderOnly].sort()).toEqual(wetChunks.map((c) => `${c.cx},${c.cy},${c.cz}`).sort());
    for (const d of s.derivedChunks()) {
      if (d.result.assembly === null) continue;
      const fresh = encodeDerived(deriveFromStore(writer.store, d.cx, d.cy, d.cz, PLACEHOLDER_RULES));
      expect(Buffer.compare(Buffer.from(encodeDerived(d.result.assembly)), Buffer.from(fresh))).toBe(0);
    }
    expect(s.derivedOf(-1, 1, -1)?.assembly?.shader.palette).toContain(41 | (5 << 12));

    // A material-only change of one cell on a chunk face (x 0, z 0: chunk 0,1,0 alone holds it) re-derives the
    // shader data of the four chunks whose border reaches it, three of them with no changed cell, and no mesh,
    // collision, navigation or light: those outputs carry no material.
    const paint = canonicalEditCommand({ v: 2, grid: 0, kind: 'fill', min: [0, 40, 0], max: [0, 40, 0], mode: 'paint', voxel: { material: 42, role: 3, wetness: 5 } });
    const paintOut = writer.edit(paint);
    expect(paintOut.fields).toBe(PLANE_BIT.material);
    expect(fieldsFeed(paintOut.fields)).toBe(DERIVED_PART.shader);
    expect(paintOut.chunks.map((u) => `${u.cx},${u.cy},${u.cz}`)).toEqual(['0,1,0']);
    writer.save();
    shaderOnly.clear();
    const derives2 = s.counters.derives;
    const shader2 = s.counters.shaderDerives;
    s.refresh([{ cx: 0, cy: 1, cz: 0 }], editBounds(grid, paint), fieldsFeed(paintOut.fields));
    await s.settle();
    expect([...rebuilt]).toEqual([]);
    expect(s.counters.derives).toBe(derives2);
    expect(s.counters.shaderDerives - shader2).toBe(4);
    expect([...shaderOnly].sort()).toEqual(dependentChunks(grid, editBounds(grid, paint), SHADER_BORDER_CELLS).map((c) => `${c.cx},${c.cy},${c.cz}`).sort());
    for (const d of s.derivedChunks()) {
      if (d.result.assembly === null) continue;
      const fresh = encodeDerived(deriveFromStore(writer.store, d.cx, d.cy, d.cz, PLACEHOLDER_RULES));
      expect(Buffer.compare(Buffer.from(encodeDerived(d.result.assembly)), Buffer.from(fresh))).toBe(0);
    }
    // The neighbour across both faces holds the painted cell in its border (grid cell 32 + 1 on x and z).
    const nb = s.derivedOf(-1, 1, -1)!.assembly!.shader;
    expect(shaderEntryAt(nb, ((33 * nb.side + 33) * nb.side) + (40 - 32 + 1))).toBe(42 | (5 << 12));
  });

  it('cancels loads the focus left before they landed, and adopts nothing from them', async () => {
    const s = streamer(pool(1));
    s.setFocus(-160, 40, -160);
    s.update();
    s.setFocus(200, 40, 200);
    s.update();
    await s.settle();
    expect(s.counters.cancelledLoads).toBeGreaterThan(0);
    for (const key of s.store.chunkKeys()) {
      const c = chunkOfKey(grid, key);
      expect(c.cx).toBeGreaterThanOrEqual(Math.floor((200 - RING.unloadRadius) / 32) - 1);
    }
    expect(expectChunksEqual(s, oracle)).toBeGreaterThan(10);
  });

  it('refuses a worker edit whose chunks changed while it ran; the main edit stands, the retry lands', async () => {
    const s = streamer(pool(1));
    const truth = copyOracle();
    s.setFocus(0, 40, 0);
    await s.settle();
    const big = fill([-8, 0, -8], [8, 8, 8], 50);
    const pending = s.editInWorker(big);
    const dab = fill([0, 4, 0], [0, 4, 0], 51);
    s.edit(dab);
    const first = await pending;
    expect(first.status).toBe('superseded');
    applyEdit({ store: () => truth }, dab);
    expectChunksEqual(s, truth);
    const retry = await s.editInWorker(big);
    if (retry.status !== 'done') throw new Error(retry.status);
    applyEdit({ store: () => truth }, big);
    expect(retry.cells).toBeGreaterThan(1000);
    expect(retry.undo.length).toBeGreaterThan(0);
    expectChunksEqual(s, truth);
    // A worker edit lands in the overlay too: the base is the files'.
    expectStoreEqual(s, s.store, oracle);
    // The dab's cell lies in the fill and was filled over: every changed cell is one override.
    expect(s.overlay.changedCells).toBe(retry.cells);
  });

  it('evicts the farthest clean chunks to stay in budget, never a dirty one before it is saved, and never the overlay', async () => {
    const s = streamer(pool(2));
    s.setFocus(0, 40, 0);
    await s.settle();
    const full = s.metrics().bytes.total;
    const dab = fill([5, 30, 5], [6, 31, 6], 60);
    s.edit(dab);
    const edited = { grid: 0, key: chunkKey(grid, 0, 0, 0) };
    // A runtime edit is in the overlay, not the chunk: the chunk stays clean.
    expect(s.tracker.isDirty(edited)).toBe(false);
    const overlay = s.metrics().bytes.overlay;
    expect(overlay).toBe(s.overlay.memoryBytes());
    expect(overlay).toBeGreaterThan(0);
    // A writer sharing the tracker (a save of the base in progress) holds another chunk dirty.
    const dirty = { grid: 0, key: chunkKey(grid, 1, 0, 1) };
    s.tracker.edited(dirty);
    // A third of the bytes: evictions start with the farthest chunks.
    s.budgetBytes = Math.floor(full / 3);
    s.update();
    await s.settle();
    const m = s.metrics();
    expect(m.counters.evictions).toBeGreaterThan(0);
    expect(m.bytes.total).toBeLessThanOrEqual(s.budgetBytes);
    expect(m.bytes.overlay).toBe(overlay);
    // Move away: the dirty chunk is past the unload bounds but stays; the edited one unloads, its edit kept.
    s.budgetBytes = 1024 * 1024 * 1024;
    s.setFocus(200, 40, 200);
    await s.settle();
    expect(s.isResident(1, 0, 1)).toBe(true);
    expect(s.isResident(0, 0, 0)).toBe(false);
    expect(s.counters.heldDirty).toBeGreaterThan(0);
    expect(s.metrics().bytes.overlay).toBe(overlay);
    const v = { material: 0, role: 0, shape: 0, wetness: 0 };
    expect(s.voxelAt(5, 30, 5, v).material).toBe(60);
    // Saved (the writer's save job commits), it unloads on the next update.
    const job = s.tracker.beginSave('save', [dirty])!;
    expect(s.tracker.commitSave(job.id, () => true)).toEqual({ ok: true });
    s.update();
    expect(s.isResident(1, 0, 1)).toBe(false);
  });

  it('applies save entries as chunks load, and reports a base mismatch when asked', async () => {
    const s = streamer(pool(1));
    let cy = -4;
    while (oracle.chunkForm(0, cy, 0) !== 'stored') cy++;
    const c = { cx: 0, cy, cz: 0 };
    const base = oracle.encodeChunk(c.cx, c.cy, c.cz);
    const now = createDenseChunk(grid);
    exportOrAir(oracle, c.cx, c.cy, c.cz, now);
    now.material[100] = 77;
    now.role[100] = 5;
    now.shape[100] = 15;
    const entry = saveChunkOf(grid, 0, c.cx, c.cy, c.cz, base, now)!;
    s.setSave([entry]);
    s.setFocus(0, 40, 0);
    await s.settle();
    const got = createDenseChunk(grid);
    s.store.exportChunk(c.cx, c.cy, c.cz, got);
    expect(sameDenseChunk(got, now)).toBe(true);
    // A save made against another base: reported, the shipped chunk kept.
    const s2 = streamer(pool(1));
    const mismatched = { ...entry, base: new Uint8Array(16).fill(9) };
    const seen: StreamEvent[] = [];
    s2.on((e) => seen.push(e));
    s2.setSave([mismatched], 'report');
    s2.setFocus(0, 40, 0);
    await s2.settle();
    expect(seen.some((e) => e.type === 'mismatch' && e.cx === 0 && e.cy === cy && e.cz === 0 && !e.applied)).toBe(true);
    s2.store.exportChunk(c.cx, c.cy, c.cz, got);
    const shipped = createDenseChunk(grid);
    oracle.exportChunk(c.cx, c.cy, c.cz, shipped);
    expect(sameDenseChunk(got, shipped)).toBe(true);
  });

  it('builds the worker module for browsers with no Node built-ins, passing the export scan', async () => {
    const out = join(dir, 'browser-worker.mjs');
    await expect(bundleWorker('stream-worker-browser', out)).resolves.toBe(out);
    const scan = scanExportFiles([{ name: 'voxel-stream-worker.js', bytes: new Uint8Array(readFileSync(out)) }], { authoringOrigin: '', previewOrigin: '', tokenValues: [] }, 'js/main.js', { version: '', integrity: null }, null);
    expect(scan.hits).toEqual([]);
    expect(scan.ok).toBe(true);
  });
});
