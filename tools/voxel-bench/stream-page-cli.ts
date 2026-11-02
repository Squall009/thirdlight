/**
 * The browser streaming bench (`node tools/voxel-bench/run.mjs stream-page`):
 * the streaming page (stream-page.ts) flying the hilly 2 × 2 km world in
 * headless Chrome on the host's GPU, at the display's 60 Hz cap, at 720p.
 *
 * The region files (written by the Node streaming bench) are served by a
 * small static server here with HTTP Range support, cross-origin isolated
 * (so the page may call `performance.measureUserAgentSpecificMemory`);
 * the staging backend has no route that serves arbitrary files by range.
 *
 * Per round, for each renderer (WebGPU, WebGL 2) and speed: a fresh page,
 * the cold fill at the loop's start, then the flight; the renderer
 * process's main-thread task time over the flight comes from CDP. After the
 * rounds, once each: the fastest flight with network latency added to every
 * range response, and a traced flight (Chrome trace: GC and the long
 * updates side by side).
 *
 *   --rounds N        rounds (default 3)
 *   --seconds S       flight seconds (default 60)
 *   --speeds a,b      m/s (default 40,80)
 *   --renderers list  webgpu,webgl2 (default both)
 *   --workers N       pool size (default 4, the Node bench's)
 *   --rebase M        floating-origin re-base distance in metres (default 250: the loop crosses it)
 *   --latency MS      added latency for the latency run (default 40; 0 skips the run)
 *   --gap KB          the latency runs' second setting: coalescing gap (default 64; the source's default is 4)
 *   --reads N         and source reads in flight (default 8; the streamer's default is 4)
 *   --no-trace        skip the traced run
 *   --only NAMES      run only the specs whose names contain one of these (comma-separated)
 *   --viewport WxH    page size (default 1280x720)
 *   --world DIR       region files (default the 45.5a hilly world)
 *   --out DIR         report, site and trace (default ~/.cache/thirdlight-phase45/work/45.5b)
 */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir, loadavg } from 'node:os';
import { extname, join, normalize } from 'node:path';
import * as esbuild from 'esbuild';
import type { Browser, CDPSession } from '@playwright/test';
import { launchGpuBrowser, parseViewport } from '../perf/frame-run';
import { summarize, type Summary } from '../perf/stats';
import type { StreamPageSpec } from './stream-page';
import { bundleWorker, REPO } from './stream-node';

const WORK = join(homedir(), '.cache', 'thirdlight-phase45', 'work');

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const ROUNDS = Number(arg('rounds', '3'));
const SECONDS = Number(arg('seconds', '60'));
const SPEEDS = arg('speeds', '40,80').split(',').map(Number);
const RENDERERS = arg('renderers', 'webgpu,webgl2').split(',') as Array<'webgpu' | 'webgl2'>;
const WORKERS = Number(arg('workers', '4'));
const REBASE_M = Number(arg('rebase', '250'));
const LATENCY_MS = Number(arg('latency', '40'));
const GAP_KB = Number(arg('gap', '64'));
const READS = Number(arg('reads', '8'));
const ONLY = arg('only', '').split(',').filter((x) => x !== '');
const TRACE = !process.argv.includes('--no-trace');
const VIEWPORT = parseViewport(arg('viewport', '1280x720'));
const WORLD = arg('world', join(WORK, '45.5a', 'world-hilly'));
const OUT = arg('out', join(WORK, '45.5b'));
/** A frame that missed a 60 Hz display's next refresh: half a refresh longer than one (vsync jitter is not a miss). */
const MISSED_MS = 25;

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };

/** What the server saw: range requests, bytes sent, and the latency it adds to world files. */
interface RangeServer {
  url: string;
  stats: { requests: number; bytes: number; full: number };
  latencyMs: number;
  close(): Promise<void>;
}

/**
 * Static files from `site`, region files under `/world/` from `world` with
 * single-range `Range` requests answered 206 (416 past the end), and the two
 * headers that make the page cross-origin isolated.
 */
function serveWithRanges(site: string, world: string): Promise<RangeServer> {
  const state: RangeServer = { url: '', stats: { requests: 0, bytes: 0, full: 0 }, latencyMs: 0, close: async () => undefined };
  const server: Server = createServer((req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const inWorld = path.startsWith('world/');
    const root = inWorld ? world : site;
    const file = join(root, inWorld ? path.slice('world/'.length) : path);
    res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.setHeader('cross-origin-embedder-policy', 'require-corp');
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const size = statSync(file).size;
    const send = (): void => {
      res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
      res.setHeader('accept-ranges', 'bytes');
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
      if (m === null) {
        if (inWorld) state.stats.full++;
        res.setHeader('content-length', size);
        createReadStream(file).pipe(res);
        return;
      }
      const start = Number(m[1]);
      const end = Math.min(size - 1, m[2] === '' ? size - 1 : Number(m[2]));
      if (start >= size) {
        res.statusCode = 416;
        res.setHeader('content-range', `bytes */${size}`);
        res.end();
        return;
      }
      state.stats.requests++;
      state.stats.bytes += end - start + 1;
      res.statusCode = 206;
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
      res.setHeader('content-length', end - start + 1);
      createReadStream(file, { start, end }).pipe(res);
    };
    if (inWorld && state.latencyMs > 0) setTimeout(send, state.latencyMs);
    else send();
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
      state.close = () => new Promise((done) => server.close(() => done()));
      ok(state);
    });
  });
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>voxel streaming page</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block}</style></head>
<body><script type="module" src="./stream-page.js"></script></body></html>`;

async function buildSite(site: string): Promise<void> {
  mkdirSync(site, { recursive: true });
  await bundleWorker('stream-worker-browser', join(site, 'stream-worker.js'));
  await esbuild.build({ entryPoints: [join(REPO, 'tools', 'voxel-bench', 'stream-page.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, outfile: join(site, 'stream-page.js'), logLevel: 'warning' });
  writeFileSync(join(site, 'index.html'), PAGE);
}

const r2 = (v: number): number => Math.round(v * 100) / 100;

interface RunSpec {
  name: string;
  renderer: 'webgpu' | 'webgl2';
  speed: number;
  seconds: number;
  latencyMs: number;
  trace: boolean;
  round: number;
  /** Source settings (absent: the streamer's and the source's defaults). */
  maxReads?: number;
  maxGap?: number;
}

/** Main-thread GC and the long updates (user timing) from a Chrome trace: which GC overlapped which update. */
function analyseTrace(events: Array<Record<string, any>>): Record<string, unknown> {
  const main = events.find((e) => e['name'] === 'thread_name' && e['args']?.name === 'CrRendererMain');
  const pid = main?.['pid'];
  const tid = main?.['tid'];
  const onMain = events.filter((e) => e['pid'] === pid && e['tid'] === tid && e['ph'] === 'X' && typeof e['dur'] === 'number');
  const gcs = onMain.filter((e) => /^(MinorGC|MajorGC|V8\.GC_SCAVENGER$|V8\.GC_MARK_COMPACTOR$|V8\.GCScavenger$|V8\.GCFinalizeMC$|V8\.GC_MC_BACKGROUND|BlinkGC\.AtomicPhase)/.test(String(e['name'])));
  const begins = new Map<string, number>();
  const updates: Array<{ ts: number; dur: number }> = [];
  for (const e of events) {
    if (e['name'] !== 'voxel-update') continue;
    const id = String(e['id'] ?? e['id2']?.local ?? '');
    if (e['ph'] === 'b') begins.set(id, e['ts']);
    else if (e['ph'] === 'e' && begins.has(id)) {
      updates.push({ ts: begins.get(id)!, dur: e['ts'] - begins.get(id)! });
      begins.delete(id);
    }
  }
  const overlap = (a: { ts: number; dur: number }, b: { ts: number; dur: number }): number => Math.max(0, Math.min(a.ts + a.dur, b.ts + b.dur) - Math.max(a.ts, b.ts));
  const perUpdate = updates.map((u) => {
    const hit = gcs.filter((g) => overlap(u, { ts: g['ts'], dur: g['dur'] }) > 0);
    return { ms: r2(u.dur / 1000), gcMs: r2(hit.reduce((s, g) => s + overlap(u, { ts: g['ts'], dur: g['dur'] }), 0) / 1000), gc: [...new Set(hit.map((g) => String(g['name'])))] };
  });
  const byName: Record<string, { n: number; ms: number; maxMs: number }> = {};
  for (const g of gcs) {
    const k = String(g['name']);
    const b = (byName[k] ??= { n: 0, ms: 0, maxMs: 0 });
    b.n++;
    b.ms = r2(b.ms + g['dur'] / 1000);
    b.maxMs = Math.max(b.maxMs, r2(g['dur'] / 1000));
  }
  return { mainThreadFound: main !== undefined, gcOnMain: byName, longUpdates: perUpdate.length, withGc: perUpdate.filter((u) => u.gcMs > 0).length, perUpdate: perUpdate.sort((a, b) => b.ms - a.ms).slice(0, 40) };
}

async function runOne(browser: Browser, server: RangeServer, files: string[], spec: RunSpec): Promise<Record<string, unknown>> {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 300));
  });
  let cdp: CDPSession | null = null;
  try {
    await page.goto(`${server.url}index.html?renderer=${spec.renderer}`);
    await page.waitForFunction(() => (window as unknown as { __tlStream?: { ready: boolean } }).__tlStream?.ready === true, null, { timeout: 60_000 });
    const pageSpec: StreamPageSpec = { files, workers: WORKERS, speed: spec.speed, seconds: spec.seconds, rebaseM: REBASE_M, derive: true, nearEvery: 15, maxReads: spec.maxReads ?? 4, maxGap: spec.maxGap ?? null };
    server.latencyMs = spec.latencyMs;
    const s0 = { ...server.stats };
    const cold = await page.evaluate((p) => (window as unknown as { __tlStream: { prepare(p: StreamPageSpec): Promise<Record<string, unknown>> } }).__tlStream.prepare(p), pageSpec);
    cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async (): Promise<Record<string, number>> => Object.fromEntries(((await cdp!.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
    const traceEvents: Array<Record<string, any>> = [];
    if (spec.trace) {
      cdp.on('Tracing.dataCollected', (d: { value: Array<Record<string, any>> }) => {
        for (const e of d.value) traceEvents.push(e);
      });
      await cdp.send('Tracing.start', { traceConfig: { includedCategories: ['devtools.timeline', 'v8', 'v8.gc', 'blink.user_timing', '__metadata', 'disabled-by-default-devtools.timeline'] } } as never);
    }
    const a = await metrics();
    const s1 = { ...server.stats };
    const fly = await page.evaluate(() => (window as unknown as { __tlStream: { fly(): Promise<Record<string, any>> } }).__tlStream.fly());
    const b = await metrics();
    const s2 = { ...server.stats };
    let trace: Record<string, unknown> | undefined;
    if (spec.trace) {
      const done = new Promise<void>((ok) => cdp!.once('Tracing.tracingComplete', () => ok()));
      await cdp.send('Tracing.end');
      await done;
      const file = join(OUT, `trace-${spec.name}.json`);
      writeFileSync(file, JSON.stringify({ traceEvents }));
      trace = { file, events: traceEvents.length, ...analyseTrace(traceEvents) };
    }
    if (spec.round === 1) await page.screenshot({ path: join(OUT, `shot-${spec.name}.jpg`), type: 'jpeg', quality: 85 });
    const memory = await page.evaluate((ms) => (window as unknown as { __tlStream: { measureMemory(ms: number): Promise<Record<string, unknown>> } }).__tlStream.measureMemory(ms), 30_000);
    await page.evaluate(() => (window as unknown as { __tlStream: { close(): void } }).__tlStream.close());
    const frames = fly['intervals'] as number[];
    const taskMs = ((b['TaskDuration'] ?? 0) - (a['TaskDuration'] ?? 0)) * 1000;
    const holes = fly['holes'] as number[];
    const range = fly['range'] as { requests: number; bytes: number; ms: number[] };
    const heap = (fly['heapMB'] as number[]).filter((v) => Number.isFinite(v));
    const out = {
      spec,
      cold: { ...cold, serverRequests: s1.requests - s0.requests },
      seconds: fly['seconds'],
      travelledM: fly['travelledM'],
      frames: { ...summarize(frames), missed: frames.filter((f) => f > MISSED_MS).length, over50: frames.filter((f) => f > 50).length, missedAt: missedAt(frames) },
      mainThreadMsPerFrame: r2(taskMs / Math.max(1, frames.length)),
      update: summarize(fly['updates'] as number[]),
      updateCrossed: summarize(fly['crossedUpdates'] as number[]),
      updateOther: summarize(fly['otherUpdates'] as number[]),
      longUpdates: fly['longUpdates'],
      longTasks: fly['longTasks'],
      longTaskApi: fly['longTaskApi'],
      mainMs: fly['mainMs'],
      nearCheckMs: summarize(fly['nearCheckMs'] as number[]),
      workerUs: fly['workerUs'],
      poolMs: fly['poolMs'],
      range: { requests: range.requests, kb: Math.round(range.bytes / 1e3), ms: summarize(range.ms), server: { requests: s2.requests - s1.requests, kb: Math.round((s2.bytes - s1.bytes) / 1e3), fullFiles: s2.full - s1.full } },
      nearHoles: { ...summarize(holes), nearChunks: fly['nearChunks'], samples: holes.length, withHoles: holes.filter((h) => h > 0).length },
      heapMB: heap.length === 0 ? null : { min: r2(Math.min(...heap)), max: r2(Math.max(...heap)), end: r2(heap[heap.length - 1]!) },
      streamMB: { peak: r2(Math.max(...(fly['budgetMB'] as number[]))), end: r2(fly['streamBytes'].total / 1e6), chunks: r2(fly['streamBytes'].chunks / 1e6), derived: r2(fly['streamBytes'].derived / 1e6), tables: r2(fly['streamBytes'].tables / 1e6) },
      memory,
      resident: fly['resident'],
      rebases: fly['rebases'],
      events: fly['events'],
      churn: fly['churn'],
      pool: { ...fly['pool'], size: fly['workers'], hardwareConcurrency: fly['hardwareConcurrency'] },
      crossOriginIsolated: fly['crossOriginIsolated'],
      ...(trace === undefined ? {} : { trace }),
      errors: errors.slice(0, 20),
      loadavg: loadavg().map(r2),
    };
    return out;
  } finally {
    server.latencyMs = 0;
    await cdp?.detach().catch(() => undefined);
    await context.close();
  }
}

/** When (ms into the flight) each missed frame ended, to set beside the long updates and long tasks. */
function missedAt(intervals: readonly number[]): Array<{ atMs: number; ms: number }> {
  const out: Array<{ atMs: number; ms: number }> = [];
  let t = 0;
  for (const f of intervals) {
    t += f;
    if (f > MISSED_MS) out.push({ atMs: Math.round(t), ms: r2(f) });
  }
  return out.slice(0, 100);
}

function line(r: Record<string, any>): string {
  const f = r.frames as Summary & { missed: number; over50: number };
  const u = r.update as Summary;
  const w = r.workerUs;
  const rebaseMs = (r.rebases as Array<{ ms: number }>).map((x) => x.ms);
  return `| ${r.spec.round} | ${r.spec.renderer} | ${r.spec.speed}${r.spec.latencyMs > 0 ? ` +${r.spec.latencyMs} ms` : ''}${r.spec.maxGap !== undefined ? ` gap ${r.spec.maxGap / 1024} KB, ${r.spec.maxReads} reads` : ''}${r.spec.trace ? ' (traced)' : ''} | ${r.cold.coldMs} (${r.cold.resident}/${r.cold.stored}) | ${f.p50} / ${f.p95} / ${f.max} | ${f.missed} of ${f.n} | ${(r.longTasks as unknown[]).length} | ${r.mainThreadMsPerFrame} | ${u.p50} / ${u.p95} / ${u.max} | ${w.decompress.p50}+${w.decode.p50} / ${w.job.p95} | ${r.poolMs.queue.p50} / ${r.poolMs.queue.p95} | ${r.range.requests} / ${r.range.ms.p50} / ${r.range.ms.p95} / ${r.range.kb} | ${r.nearHoles.p95} / ${r.nearHoles.max} of ${r.nearHoles.nearChunks} | ${r.streamMB.peak} / ${r.heapMB?.max ?? '-'}${r.memory?.totalMB !== undefined ? ` / ${r.memory.totalMB}` : ''} | ${rebaseMs.length} (${rebaseMs.length === 0 ? '-' : Math.max(...rebaseMs)}) |`;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const files = readdirSync(WORLD).filter((f) => f.endsWith('.vxr')).sort();
  if (files.length === 0) throw new Error(`no region files in ${WORLD} (run the Node streaming bench first)`);
  const site = join(OUT, 'site');
  await buildSite(site);
  const server = await serveWithRanges(site, WORLD);
  const browser = await launchGpuBrowser({ vsync: true });
  const results: Record<string, unknown>[] = [];
  const uptimes: string[] = [];
  const started = new Date().toISOString();
  const chrome = browser.version();
  try {
    const specs: RunSpec[] = [];
    for (let round = 1; round <= ROUNDS; round++) for (const renderer of RENDERERS) for (const speed of SPEEDS) specs.push({ name: `r${round}-${renderer}-${speed}`, renderer, speed, seconds: SECONDS, latencyMs: 0, trace: false, round });
    const top = Math.max(...SPEEDS);
    if (LATENCY_MS > 0) {
      specs.push({ name: `latency-${LATENCY_MS}-webgpu-${top}`, renderer: 'webgpu', speed: top, seconds: SECONDS, latencyMs: LATENCY_MS, trace: false, round: 0 });
      specs.push({ name: `latency-${LATENCY_MS}-gap${GAP_KB}k-reads${READS}-webgpu-${top}`, renderer: 'webgpu', speed: top, seconds: SECONDS, latencyMs: LATENCY_MS, trace: false, round: 0, maxReads: READS, maxGap: GAP_KB * 1024 });
    }
    if (TRACE) specs.push({ name: `traced-webgpu-${SPEEDS[0]}`, renderer: 'webgpu', speed: SPEEDS[0]!, seconds: Math.min(30, SECONDS), latencyMs: 0, trace: true, round: 0 });
    let lastRound = -1;
    for (const spec of specs.filter((x) => ONLY.length === 0 || ONLY.some((o) => x.name.includes(o)))) {
      if (spec.round !== lastRound) {
        lastRound = spec.round;
        uptimes.push(`${spec.round === 0 ? 'extras' : `round ${spec.round}`}: ${execFileSync('uptime', { encoding: 'utf8' }).trim()}`);
        console.log(uptimes[uptimes.length - 1]);
      }
      console.log(`run ${spec.name} …`);
      const r = await runOne(browser, server, files, spec);
      results.push(r);
      console.log(line(r as Record<string, any>));
      writeFileSync(join(OUT, 'stream-page.json'), JSON.stringify({ started, uptimes, viewport: VIEWPORT, workers: WORKERS, rebaseM: REBASE_M, chrome, results }, null, 1));
    }
  } finally {
    await browser.close();
    await server.close();
  }
  const md = [
    `# Voxel streaming page ${started}`,
    '',
    `Chrome ${chrome}, ${VIEWPORT.width}×${VIEWPORT.height} at the 60 Hz cap, ${WORKERS} workers, re-base at ${REBASE_M} m; world ${files.length} files.`,
    ...uptimes.map((u) => `- ${u}`),
    '',
    '| round | renderer | m/s | cold ms (resident/stored) | frame ms p50 / p95 / max | missed | long tasks | main ms/frame | update ms p50 / p95 / max | worker µs zstd+decode p50 / job p95 | queue ms p50 / p95 | range req / ms p50 / p95 / KB | near holes p95 / max | stream MB / heap MB max / UA MB | re-bases (max ms) |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...results.map((r) => line(r as Record<string, any>)),
    '',
  ].join('\n');
  writeFileSync(join(OUT, 'stream-page.md'), md);
  console.log(md);
}

await main();
