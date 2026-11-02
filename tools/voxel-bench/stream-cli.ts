/**
 * The streaming benchmark: a simulated flight over the hilly 2 × 2 km test
 * world, streamed from region files on disk through real worker_threads
 * workers (the browser's worker module with fzstd), with no rendering. It
 * is the CPU-side reference the browser streaming page is compared with.
 *
 * Runs (each in real time, ticking at 60 Hz):
 * - `cold`: from nothing to a settled ring at the start point;
 * - `fly`: 40 m/s along a square loop, derive on, the low tier's budget;
 * - `fast`: 80 m/s, derive off;
 * - `tight`: 40 m/s with a 4 MiB budget (half of what the ring holds: eviction all the time);
 * - `jitter`: the focus swinging ±12 m across a chunk edge (hysteresis).
 *
 *   node tools/voxel-bench/run.mjs stream [--workers N] [--seconds S] [--out DIR] [--world DIR]
 *
 * The world's region files are written once into --world (kept for the
 * browser streaming page) and reused when their manifest matches.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg } from 'node:os';
import { join } from 'node:path';
import {
  apronCellCount,
  chunkGrid,
  createWorldStore,
  DEFAULT_STREAM_RING,
  ringChunks,
  VOXEL_STREAM_BUDGET_BYTES,
  VoxelStreamer,
  WorkerPool,
  type SampleRing,
  type StreamRing,
} from '@thirdlight/voxel';
import { bundleWorker, DiskRegions, nodePoolWorker, REPO, writeWorldRegions } from './stream-node';
import { hillyWorld } from './worlds';

const grid = chunkGrid(32);
const WORK = join(homedir(), '.cache', 'thirdlight-phase45', 'work', '45.5a');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const WORKERS = Number(arg('workers', '4'));
const SECONDS = Number(arg('seconds', '60'));
const OUT = arg('out', join(WORK, 'results'));
const WORLD_DIR = arg('world', join(WORK, 'world-hilly'));
const HALF = 2000;

interface Manifest {
  world: string;
  footprint: number;
  layout: string;
  region: number;
  files: number;
  bytes: number;
  chunks: number;
  writeMs: number;
}

function ensureWorld(): Manifest {
  const path = join(WORLD_DIR, 'manifest.json');
  const want = { world: 'hilly seed 23', footprint: 2 * HALF, layout: 'stacked', region: 512 };
  if (existsSync(path)) {
    const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    if (m.world === want.world && m.footprint === want.footprint && m.layout === want.layout && m.region === want.region) return m;
  }
  const t0 = performance.now();
  const g = hillyWorld({ footprint: 2 * HALF }).grids[0]!;
  console.log('writing the hilly 2 × 2 km world as stacked 256 m region files …');
  const r = writeWorldRegions(g, grid, WORLD_DIR, 'stacked', 512, -HALF, -HALF, HALF, HALF);
  const m: Manifest = { ...want, ...r, writeMs: performance.now() - t0 };
  writeFileSync(path, JSON.stringify(m, null, 2));
  return m;
}

/** A point on the square loop at ±750 m (metres → cells), `d` metres along it. */
function loopAt(d: number): [number, number] {
  const side = 1500;
  const s = ((d % (4 * side)) + 4 * side) % (4 * side);
  const k = Math.floor(s / side);
  const t = s - k * side;
  const m: [number, number] = k === 0 ? [-750 + t, -750] : k === 1 ? [750, -750 + t] : k === 2 ? [750 - t, 750] : [-750, 750 - t];
  return [m[0] * 2, m[1] * 2];
}

const ALTITUDE_CELLS = 120;

function q(r: SampleRing, p: number, scale = 1): number {
  return Number((r.quantile(p) * scale).toFixed(3));
}

function quantiles(xs: number[]): { p50: number; p95: number; max: number } {
  const s = [...xs].sort((a, b) => a - b);
  const at = (p: number): number => (s.length === 0 ? NaN : s[Math.min(s.length - 1, Math.floor(p * s.length))]!);
  return { p50: Number(at(0.5).toFixed(3)), p95: Number(at(0.95).toFixed(3)), max: Number((s[s.length - 1] ?? NaN).toFixed(3)) };
}

interface RunSpec {
  name: string;
  speed: number;
  seconds: number;
  derive: boolean;
  budget: number;
  path: 'loop' | 'jitter';
  ring?: StreamRing;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function run(spec: RunSpec, workerFile: string): Promise<Record<string, unknown>> {
  const ring = spec.ring ?? DEFAULT_STREAM_RING;
  const pool = new WorkerPool({ size: WORKERS, create: () => nodePoolWorker(workerFile), timeoutMs: 5000, maxQueued: 256 });
  const disk = new DiskRegions(WORLD_DIR);
  const s = new VoxelStreamer({ store: createWorldStore(grid), source: disk.source(grid, 'stacked', 512, 128), pool, ring, budgetBytes: spec.budget, dependencyRadius: 2, derive: spec.derive, readBatch: 64, maxReads: 4 });
  const start = loopAt(0);
  const focusAt = (d: number): [number, number] => (spec.path === 'loop' ? loopAt(d) : [start[0] + 16 + 24 * Math.sin(d / 4), start[1]]);
  // Cold start: settle at the start point.
  const [x0, z0] = focusAt(0);
  s.setFocus(x0, ALTITUDE_CELLS, z0);
  const tc = performance.now();
  await s.settle();
  const coldMs = performance.now() - tc;
  const cold = s.metrics();
  for (const r of [s.planMs, s.adoptMs, s.apronMs, s.decodeUs, s.decompressUs, s.apronBytes, pool.stats.queueMs, pool.stats.runMs, pool.stats.workerUs]) r.clear();
  const c0 = { ...s.counters };
  const stats0 = { ...pool.stats };
  const near: StreamRing = { ...ring, loadRadius: ring.nearRadius, unloadRadius: ring.nearRadius };
  const holes: number[] = [];
  const late: number[] = [];
  const total: number[] = [];
  let peak = 0;
  let peakRss = 0;
  let travelled = 0;
  const t0 = performance.now();
  let prev = t0;
  let tick = 0;
  while (performance.now() - t0 < spec.seconds * 1000) {
    await sleep(16);
    const now = performance.now();
    const dt = (now - prev) / 1000;
    late.push(now - prev - 16.667);
    prev = now;
    // Metres along the path: jitter swings with time, the loop moves at the speed.
    travelled += spec.speed * dt;
    const [x, z] = focusAt(spec.path === 'loop' ? travelled : (now - t0) / 1000);
    s.setFocus(x, ALTITUDE_CELLS, z);
    s.update();
    tick++;
    if (tick % 15 === 0) {
      let missing = 0;
      for (const c of ringChunks(grid, near, { x, y: ALTITUDE_CELLS, z })) if (!s.isResident(c.cx, c.cy, c.cz)) missing++;
      holes.push(missing);
      const m = s.metrics();
      total.push(m.bytes.total);
      peak = Math.max(peak, m.bytes.total);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  }
  const secs = (performance.now() - t0) / 1000;
  const m = s.metrics();
  const c = s.counters;
  const nearCount = ringChunks(grid, near, { x: 0, y: ALTITUDE_CELLS, z: 0 }).length;
  const out = {
    spec: { ...spec, ring, workers: WORKERS, dependencyRadius: 2 },
    coldMs: Number(coldMs.toFixed(0)),
    cold: { resident: cold.resident, stored: cold.residentStored, mb: Number((cold.bytes.total / 1e6).toFixed(1)) },
    seconds: Number(secs.toFixed(1)),
    travelledM: Number(travelled.toFixed(0)),
    loadsPerS: Number(((c.loads - c0.loads) / secs).toFixed(1)),
    storedLoadsPerS: Number(((c.loadsStored - c0.loadsStored) / secs).toFixed(1)),
    derivesPerS: Number(((c.derives - c0.derives) / secs).toFixed(1)),
    decodeUs: { p50: q(s.decodeUs, 0.5), p95: q(s.decodeUs, 0.95) },
    decompressUs: { p50: q(s.decompressUs, 0.5), p95: q(s.decompressUs, 0.95) },
    queueMs: { p50: q(pool.stats.queueMs, 0.5), p95: q(pool.stats.queueMs, 0.95) },
    runMs: { p50: q(pool.stats.runMs, 0.5), p95: q(pool.stats.runMs, 0.95) },
    workerUs: { p50: q(pool.stats.workerUs, 0.5), p95: q(pool.stats.workerUs, 0.95) },
    mainMs: { plan: { p50: q(s.planMs, 0.5), p95: q(s.planMs, 0.95), max: q(s.planMs, 1) }, adopt: { p50: q(s.adoptMs, 0.5), p95: q(s.adoptMs, 0.95) }, apron: { p50: q(s.apronMs, 0.5), p95: q(s.apronMs, 0.95) } },
    apronBytes: { p50: q(s.apronBytes, 0.5), p95: q(s.apronBytes, 0.95), dense: apronCellCount(32, 2) * 5 },
    tickLateMs: quantiles(late),
    nearHoles: { ...quantiles(holes), nearChunks: nearCount },
    memory: { budgetMB: Number((spec.budget / 1e6).toFixed(1)), peakMB: Number((peak / 1e6).toFixed(1)), endMB: Number((m.bytes.total / 1e6).toFixed(1)), chunksMB: Number((m.bytes.chunks / 1e6).toFixed(1)), derivedMB: Number((m.bytes.derived / 1e6).toFixed(1)), tablesMB: Number((m.bytes.tables / 1e6).toFixed(2)), meanMB: Number((total.reduce((a, b) => a + b, 0) / Math.max(1, total.length) / 1e6).toFixed(1)), rssPeakMB: Number((peakRss / 1e6).toFixed(0)) },
    resident: { end: m.resident, stored: m.residentStored },
    churn: {
      loads: c.loads - c0.loads,
      unloads: c.unloads - c0.unloads,
      reloads: c.reloads - c0.reloads,
      evictions: c.evictions - c0.evictions,
      cancelledLoads: c.cancelledLoads - c0.cancelledLoads,
      staleRefused: c.staleRefused - c0.staleRefused,
      retried: c.retried - c0.retried,
      overBudgetTicks: c.overBudgetTicks - c0.overBudgetTicks,
      queueFull: pool.stats.queueFull - stats0.queueFull,
      timeouts: pool.stats.timeouts - stats0.timeouts,
    },
    io: { requests: disk.requests, mb: Number((disk.bytes / 1e6).toFixed(1)) },
  };
  pool.close();
  await disk.close();
  return out;
}

function row(r: Record<string, any>): string {
  const mm = r.memory;
  return `| ${r.spec.name} | ${r.spec.speed} | ${r.coldMs} (${r.cold.resident}/${r.cold.stored}) | ${r.loadsPerS} / ${r.storedLoadsPerS} | ${r.decompressUs.p50}+${r.decodeUs.p50} / ${r.decompressUs.p95}+${r.decodeUs.p95} | ${r.queueMs.p50} / ${r.queueMs.p95} | ${r.mainMs.plan.p50} / ${r.mainMs.plan.p95} / ${r.mainMs.plan.max} | ${r.mainMs.adopt.p95} / ${r.mainMs.apron.p95} | ${r.nearHoles.p50} / ${r.nearHoles.p95} / ${r.nearHoles.max} of ${r.nearHoles.nearChunks} | ${mm.peakMB} / ${mm.budgetMB} (${mm.derivedMB} der, ${mm.tablesMB} tab) | ${r.churn.unloads} / ${r.churn.reloads} / ${r.churn.evictions} / ${r.churn.cancelledLoads} / ${r.churn.staleRefused} |`;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const manifest = ensureWorld();
  const workerFile = await bundleWorker('stream-worker-node', join(REPO, 'dist', 'voxel-bench', 'stream-worker.mjs'));
  const low = VOXEL_STREAM_BUDGET_BYTES.low;
  const specs: RunSpec[] = [
    { name: 'fly', speed: 40, seconds: SECONDS, derive: true, budget: low, path: 'loop' },
    { name: 'fast', speed: 80, seconds: Math.max(10, SECONDS / 2), derive: false, budget: low, path: 'loop' },
    { name: 'tight', speed: 40, seconds: Math.max(10, SECONDS / 2), derive: true, budget: 4 * 1024 * 1024, path: 'loop' },
    { name: 'jitter', speed: 0, seconds: Math.max(10, SECONDS / 6), derive: true, budget: low, path: 'jitter' },
  ];
  const results: Record<string, unknown>[] = [];
  for (const spec of specs) {
    console.log(`run ${spec.name} …`);
    const r = await run(spec, workerFile);
    console.log(JSON.stringify(r));
    results.push(r);
  }
  const report = { started: new Date().toISOString(), node: process.version, loadavg: loadavg(), workers: WORKERS, world: manifest, results };
  writeFileSync(join(OUT, 'stream.json'), JSON.stringify(report, null, 2));
  const md = [
    `# Voxel streaming bench ${report.started}`,
    '',
    `node ${process.version}, ${WORKERS} workers, load ${loadavg().map((l) => l.toFixed(2)).join(' ')}; world: ${manifest.files} files, ${(manifest.bytes / 1e6).toFixed(1)} MB, ${manifest.chunks} chunks`,
    '',
    '| run | m/s | cold ms (resident/stored) | loads/s all / stored | worker µs zstd+decode p50 / p95 | queue ms p50 / p95 | update ms p50 / p95 / max | adopt / apron ms p95 | near holes p50 / p95 / max | peak MB / budget | unloads / reloads / evictions / cancels / stale |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => row(r as Record<string, any>)),
    '',
  ].join('\n');
  writeFileSync(join(OUT, 'stream.md'), md);
  console.log(md);
}

await main();
