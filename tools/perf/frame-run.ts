/**
 * One page measured the same way whatever draws it — a Thirdlight export or
 * the plain three.js page (tools/perf/bare/): 1920×1080 at device pixel
 * ratio 1, uncapped (no vsync, no frame-rate limit), on the host's GPU.
 *
 * In order, once the scene has settled:
 * 1. frames (rendered-frame intervals, draws, triangles, counted at the
 *    graphics API by instrument.ts) and the renderer process's main-thread
 *    task time per frame (CDP), with nothing else switched on;
 * 2. the scene three walks and the live GPU objects, uniform buffers among them;
 * 3. GPU time per render pass (three's timestamp queries, frame-probe.ts);
 * 4. a CPU profile split by package (profile.ts);
 * 5. optionally a dump of the drawn scene (scene-dump.ts) and a screenshot.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { chromium, type Browser } from '@playwright/test';

import { FRAME_RATE_CAP_URL_PARAM } from '@thirdlight/runtime';

import { browserLaunchEnv, GPU_ARGS } from '../../tests/e2e/browser-env.mjs';
import { installFrameProbe, probeGpuPasses, probeSceneCounts, probeSetGpuTiming, type GpuTimings, type SceneCounts } from './frame-probe';
import { installPerfInstrumentation, readSample, startRecording, type PageSample } from './instrument';
import { profileSplit, type ProfileSplit } from './profile';
import { dumpScene, type DumpSummary } from './scene-dump';
import { histogram, summarize, type Summary } from './stats';

export const FRAME_VIEWPORT = { width: 1920, height: 1080 } as const;
/** No vsync and no frame-rate cap: the frame costs what it costs. */
export const UNCAPPED_ARGS = ['--disable-gpu-vsync', '--disable-frame-rate-limit'];

/**
 * A measured page's URL with the game's own frame-rate cap pinned off
 * (`?frameRateCap=none`; Play takes it from the editor's URL): the browser
 * flags above lift the browser's cap, this one a game's. Pages without a
 * game ignore it.
 */
export function uncappedUrl(url: string): string {
  const hash = url.indexOf('#');
  const [base, frag] = hash < 0 ? [url, ''] : [url.slice(0, hash), url.slice(hash)];
  return `${base}${base.includes('?') ? '&' : '?'}${FRAME_RATE_CAP_URL_PARAM}=none${frag}`;
}

export type FrameRenderer = 'webgpu' | 'webgl2';

/** A step before measuring (a game copy reaches its view this way). */
export type PageStep = { wait: number } | { key: string } | { click: [number, number] };

export interface FrameRunOptions {
  /** Page URL (query included). */
  url: string;
  warmupMs: number;
  recordMs: number;
  /** 0 skips the GPU pass timings. */
  gpuMs: number;
  /** 0 skips the CPU profile. */
  profileMs: number;
  steps?: readonly PageStep[];
  /** Read a script's text for the profile's attribution (null: by file name). */
  sourceOf?: (url: string) => string | null;
  /** Dump the drawn scene through the page's origin (the server writes it). */
  dump?: boolean;
  shot?: string;
  /** Trace this long (ms) for each thread's busy time (0 or absent: no trace). */
  busyMs?: number;
}

/**
 * Busy time per second of wall clock, from a Chrome trace's top-level tasks: the page's main thread, its
 * workers (the simulation, mesh workers) and the GPU process's threads (the work the page's draws hand it), and
 * frames drawn per second. Tracing adds its own cost to every thread, so compare runs with each other, not with
 * the untraced main-thread time. The GPU's own busy time is not here: three's pass timestamps include the waits
 * between passes and grow with idle time at a capped rate, so they do not measure it.
 */
export interface ThreadBusy {
  readonly seconds: number;
  readonly fps: number;
  readonly mainMsPerS: number;
  readonly workerMsPerS: number;
  readonly gpuProcessMsPerS: number;
}

export interface FrameRunResult {
  url: string;
  rendererChoice: PageSample['renderer'];
  apis: string[];
  firstFrameMs: number | null;
  settledMs: number;
  frames: { n: number; fps: number; p50: number; p95: number; p99: number; mean: number; max?: number; /** Share of frames per `FRAME_HISTOGRAM_EDGES_MS` bucket. */ histogram?: number[] };
  draws: Summary;
  tris: Summary;
  mainThread: { taskMsPerFrame: number; busyShare: number };
  scene: SceneCounts;
  live: PageSample['live'];
  /** WebGPU calls per frame (passes, pipeline and bind-group switches, buffer writes, texture uploads, submits). */
  gpuCalls?: PageSample['gpuCallsPerFrame'];
  /** The WebGPU shader modules the page made (distinct programs and their sizes). */
  shaders?: PageSample['shaderModules'];
  gpu: GpuTimings | null;
  profile: ProfileSplit | null;
  busy?: ThreadBusy;
  dump?: DumpSummary | string;
  /** The engine's user-timing marks (`tl:…`) seen by the end of the run. */
  marks?: PageSample['marks'];
  errors: string[];
}

/** `vsync`: draw at the display's rate as a player's browser does (frame drops show as long intervals) instead of uncapped. */
export async function launchGpuBrowser(o: { vsync?: boolean } = {}): Promise<Browser> {
  return chromium.launch({ env: browserLaunchEnv() as Record<string, string>, args: [...GPU_ARGS, '--enable-precise-memory-info', '--js-flags=--expose-gc', '--autoplay-policy=no-user-gesture-required', ...(o.vsync === true ? [] : UNCAPPED_ARGS)] });
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.ktx2': 'image/ktx2', '.glb': 'model/gltf-binary', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg', '.ttf': 'font/ttf', '.bin': 'application/octet-stream' };

export interface StaticSite {
  url: string;
  /** The file a URL path is served from (null: none). */
  fileOf(path: string): string | null;
  close(): Promise<void>;
}

/**
 * A static server over `root`, with extra mounts (`/three/` → node_modules/three)
 * and PUT `/__dump/<name>` writing into `dumpDir`.
 */
export function serveStatic(root: string, mounts: Record<string, string> = {}, dumpDir?: string): Promise<StaticSite> {
  const fileOf = (path: string): string | null => {
    const rel = normalize(decodeURIComponent(path.split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    for (const [prefix, dir] of Object.entries(mounts)) {
      if (rel.startsWith(prefix)) {
        const f = join(dir, rel.slice(prefix.length));
        return f.startsWith(dir) && existsSync(f) && statSync(f).isFile() ? f : null;
      }
    }
    const f = join(root, rel);
    return f.startsWith(root) && existsSync(f) && statSync(f).isFile() ? f : null;
  };
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    if (req.method === 'PUT' && path.startsWith('/__dump/') && dumpDir !== undefined) {
      const name = path.slice('/__dump/'.length).replace(/[^a-z0-9._-]/gi, '');
      const parts: Buffer[] = [];
      req.on('data', (d: Buffer) => parts.push(d));
      req.on('end', () => {
        mkdirSync(dumpDir, { recursive: true });
        writeFileSync(join(dumpDir, name), Buffer.concat(parts));
        res.end('ok');
      });
      return;
    }
    const file = fileOf(path);
    if (file === null) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, fileOf, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/** A site's scripts as text for the profile (by URL path). */
export function sourcesOf(site: StaticSite): (url: string) => string | null {
  const cache = new Map<string, string | null>();
  return (url) => {
    if (!url.startsWith(site.url)) return null;
    if (!cache.has(url)) {
      const f = site.fileOf(`/${url.slice(site.url.length)}`);
      cache.set(url, f === null ? null : readFileSync(f, 'utf8'));
    }
    return cache.get(url)!;
  };
}

/** Wait until the scene stops changing (its mesh count steady for 3 s) or `maxMs` passed. */
async function settle(page: import('@playwright/test').Page, maxMs: number): Promise<number> {
  const t0 = Date.now();
  let last = -1;
  let same = 0;
  while (Date.now() - t0 < maxMs) {
    const c = await page.evaluate(probeSceneCounts);
    const key = c.meshes * 100_000 + c.objects;
    same = key === last && key > 0 ? same + 1 : 0;
    last = key;
    if (same >= 3) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return Date.now() - t0;
}

export async function measurePage(browser: Browser, opts: FrameRunOptions): Promise<FrameRunResult> {
  const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
  await context.addInitScript(installPerfInstrumentation);
  await context.addInitScript(installFrameProbe, { timestamps: opts.gpuMs > 0 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 500)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 300));
  });
  try {
    await page.goto(uncappedUrl(opts.url));
    const first = await page.waitForFunction(() => (window as unknown as { __tlPerf?: { firstDrawAt: number | null } }).__tlPerf?.firstDrawAt ?? null, null, { timeout: 180_000 }).then((h) => h.jsonValue() as Promise<number>);
    for (const st of opts.steps ?? []) {
      if ('wait' in st) await new Promise((r) => setTimeout(r, st.wait));
      if ('key' in st) await page.keyboard.press(st.key);
      if ('click' in st) await page.mouse.click(st.click[0], st.click[1]);
    }
    await page.evaluate(probeSetGpuTiming, false);
    const settledMs = await settle(page, 90_000);
    await new Promise((r) => setTimeout(r, opts.warmupMs));

    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async (): Promise<Record<string, number>> => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
    const a = await metrics();
    const t0 = performance.now();
    await page.evaluate(startRecording);
    await new Promise((r) => setTimeout(r, opts.recordMs));
    const sample = await page.evaluate(readSample, true);
    const b = await metrics();
    const wall = performance.now() - t0;
    const taskMs = ((b['TaskDuration'] ?? 0) - (a['TaskDuration'] ?? 0)) * 1000;
    const nFrames = Math.max(1, sample.frames.length);
    const s = summarize(sample.frames);
    const scene = await page.evaluate(probeSceneCounts);

    let gpu: GpuTimings | null = null;
    if (opts.gpuMs > 0) {
      const on = await page.evaluate(probeSetGpuTiming, true);
      gpu = on ? await page.evaluate(probeGpuPasses, opts.gpuMs) : { available: false, frames: 0, msPerFrame: 0, passes: [] };
      await page.evaluate(probeSetGpuTiming, false);
    }
    const profile = opts.profileMs > 0 ? await profileSplit(cdp, opts.profileMs, opts.sourceOf ?? (() => null)) : null;
    const busy = (opts.busyMs ?? 0) > 0 ? await threadBusy(browser, page, opts.busyMs!) : undefined;
    await cdp.detach().catch(() => undefined);
    const out: FrameRunResult = {
      url: opts.url,
      rendererChoice: sample.renderer,
      apis: sample.apis,
      firstFrameMs: first === null ? null : Math.round(first),
      settledMs,
      frames: { n: s.n, fps: s.mean > 0 ? Math.round((1000 / s.mean) * 10) / 10 : 0, p50: s.p50, p95: s.p95, p99: s.p99, mean: s.mean, max: s.max, histogram: histogram(sample.frames) },
      draws: summarize(sample.frameDraws),
      tris: summarize(sample.frameTris),
      mainThread: { taskMsPerFrame: Math.round((taskMs / nFrames) * 100) / 100, busyShare: Math.round((taskMs / Math.max(1, wall)) * 1000) / 1000 },
      scene,
      live: sample.live,
      gpuCalls: sample.gpuCallsPerFrame,
      shaders: sample.shaderModules,
      gpu,
      profile,
      ...(busy !== undefined ? { busy } : {}),
      ...(sample.marks.length > 0 ? { marks: sample.marks } : {}),
      errors,
    };
    if (opts.dump === true) out.dump = await page.evaluate(dumpScene);
    if (opts.shot !== undefined) await page.screenshot({ path: opts.shot });
    return out;
  } finally {
    await context.close();
  }
}

interface TraceEvent {
  readonly ph: string;
  readonly name: string;
  readonly pid: number;
  readonly tid: number;
  readonly ts: number;
  readonly dur?: number;
  readonly args?: { name?: string };
}

/** Trace `ms` of the page and sum each thread's top-level task time (see {@link ThreadBusy}). */
async function threadBusy(browser: Browser, page: import('@playwright/test').Page, ms: number): Promise<ThreadBusy> {
  await browser.startTracing(page, { categories: ['toplevel', 'disabled-by-default-devtools.timeline'] });
  await page.evaluate(startRecording);
  const w0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  const sample = await page.evaluate(readSample, true);
  const wall = performance.now() - w0;
  const buf = await browser.stopTracing();
  const events = (JSON.parse(buf.toString('utf8')) as { traceEvents: TraceEvent[] }).traceEvents;
  const threadName = new Map<string, string>();
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') threadName.set(`${e.pid}:${e.tid}`, e.args?.name ?? '');
  let t0 = Infinity;
  let t1 = -Infinity;
  const byThread = new Map<string, number>();
  for (const e of events) {
    if (e.ph !== 'X' || (e.name !== 'ThreadControllerImpl::RunTask' && e.name !== 'RunTask') || e.dur === undefined) continue;
    const k = `${e.pid}:${e.tid}`;
    byThread.set(k, (byThread.get(k) ?? 0) + e.dur / 1000);
    t0 = Math.min(t0, e.ts);
    t1 = Math.max(t1, e.ts + e.dur);
  }
  const seconds = Math.max(1e-3, (t1 - t0) / 1e6);
  // The page's renderer main thread is the busiest of the renderers' main threads (another tab or a frame idles).
  let main = 0;
  let worker = 0;
  let gpuProcess = 0;
  for (const [k, msBusy] of byThread) {
    const name = threadName.get(k) ?? '';
    if (name === 'CrRendererMain') main = Math.max(main, msBusy);
    else if (name.startsWith('DedicatedWorker')) worker += msBusy;
    else if (name === 'CrGpuMain' || name === 'VizCompositorThread' || name.startsWith('GpuMemory') || name === 'CrGpuIO') gpuProcess += msBusy;
  }
  const r = (v: number): number => Math.round((v / seconds) * 10) / 10;
  const frames = sample.frames.length;
  return { seconds: Math.round(seconds * 100) / 100, fps: Math.round((frames / (wall / 1000)) * 10) / 10, mainMsPerS: r(main), workerMsPerS: r(worker), gpuProcessMsPerS: r(gpuProcess) };
}
