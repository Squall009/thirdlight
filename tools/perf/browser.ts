/**
 * The browser side of the harness — one benchmark project loaded
 * in Play (the editor's preview iframe), in its standalone export (served
 * statically) and in the editor's Scene view while orbiting, in the pinned
 * Playwright Chromium. Frame times, draw calls, resources and GPU memory come
 * from the API instrumentation (instrument.ts); heap from performance.memory
 * after a forced collection; Play also reports three's own renderer counts
 * from the play diagnostics. A raw-WebGL calibration page gives the machine's
 * speed for relative numbers.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { chromium, type Browser, type Frame, type Page } from '@playwright/test';

import { browserLaunchEnv, GPU_ARGS } from '../../tests/e2e/browser-env.mjs';
import type { FrameWatch, SceneLoadTiming, StartTimingsReport } from '../../packages/game-host/src/start-timings';
import type { PerfBackend } from './backend';
import { installPerfInstrumentation, readSample, startRecording, type PageSample } from './instrument';
import { measureEditorOps, type EditorOpsResult } from './editor-ops';
import { summarize, type Summary } from './stats';
import { uncappedUrl } from './frame-run';

export type RendererName = 'legacy' | 'webgl2' | 'webgpu' | 'auto';

/** WebGL 2 through ANGLE on SwiftShader, headless WebGPU on SwiftShader (as playwright.config.mts). */
const GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader'];
/** Exact heap numbers and `gc()` in every page. */
const MEASURE_ARGS = ['--enable-precise-memory-info', '--js-flags=--expose-gc'];

export interface SurfaceOptions {
  /** Warm-up after the first frame before recording (ms). */
  warmupMs: number;
  /** Recording window (ms). */
  recordMs: number;
  viewport: { width: number; height: number };
}

export interface SurfaceResult {
  surface: 'play' | 'export' | 'editor';
  renderer: RendererName;
  /** What drew (the canvas's data-tl-renderer attributes). */
  rendererChoice: PageSample['renderer'];
  apis: string[];
  load: Record<string, number>;
  frameMs: Summary;
  drawCalls: Summary;
  triangles: Summary;
  live: PageSample['live'];
  gpuMiBEstimate: number;
  heapMiB: number | null;
  heapSource: string;
  uasm: string;
  /** Play only: three's renderer.info counts from the play diagnostics. */
  three?: { geometries: number; textures: number; programs: number };
  state?: string;
  /**
   * Editor only: the Scene view left alone after it settled —
   * frames that drew anything (counted at the graphics API) and draw calls
   * over the window; render on demand means both are 0.
   */
  idle?: { windowMs: number; framesDrawn: number; drawCalls: number; settledMs: number };
  /** Editor only: what the Scene view's last sync did (its `data-sync`) after the command round trips. */
  lastSync?: Record<string, unknown>;
  /** Where Play/the export ran its simulation (the page's ?threads= flag). */
  threads?: 'worker' | 'off';
  /** The page's main-thread task time per rendered frame (ms) and its share of the window. */
  mainThread?: { taskMsPerFrame: number; busyShare: number };
  /** Play: where each Play's start went, the first Play first (a later one runs in the same editor page). */
  starts?: PlayStartSplit[];
  /** Play: a scene loaded during the first Play (a class with scenes that do not start). */
  sceneLoad?: SceneLoadTiming & { sceneId: string };
  notes: string[];
  loadavg: number[];
}

/** `gpu` draws on the host's GPU (ANGLE on Vulkan, a real WebGPU adapter) instead of SwiftShader. */
export async function launch(renderer: RendererName, gpu = false): Promise<Browser> {
  const args = gpu ? [...GPU_ARGS, ...MEASURE_ARGS] : [...GL_ARGS, ...(renderer === 'webgpu' || renderer === 'auto' ? WEBGPU_ARGS : []), ...MEASURE_ARGS];
  return chromium.launch({ env: browserLaunchEnv() as Record<string, string>, args });
}

/**
 * One Play start split into its stages, every time in ms from
 * the click on Play: the request to the backend (its own stages in
 * `backend`), the editor handing the play to a new preview page, and the
 * preview's stages (bundle, manifest, assets, worker, mount, models, ready),
 * then the first frame and the slow frames after it.
 */
export interface PlayStartSplit {
  /** Click → the play-start response. */
  responseMs: number;
  /** The backend's stages (ms each: session, state, capture, bundle, closure.*, publish, total). */
  backend: Record<string, number> | null;
  /** Click → the preview page's time origin (its navigation start). */
  pageMs: number | null;
  /** The preview's stages, from the click. */
  stages: { name: string; startMs: number; endMs: number | null; note?: string }[];
  readyMs: number | null;
  firstFrameMs: number | null;
  /** Frames in the 10 s after the first frame (over 50/100/250 ms, the worst). */
  afterFirstFrame: FrameWatch | null;
  counts: Record<string, number>;
}

export function splitOf(clickEpoch: number, responseEpoch: number, backend: Record<string, number> | null, t: StartTimingsReport | undefined): PlayStartSplit {
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  if (t === undefined) return { responseMs: responseEpoch - clickEpoch, backend, pageMs: null, stages: [], readyMs: null, firstFrameMs: null, afterFirstFrame: null, counts: {} };
  const off = t.epochMs - clickEpoch;
  const at = (v: number | null): number | null => (v === null ? null : r1(v + off));
  const ready = t.stages.find((s) => s.name === 'ready')?.endMs ?? null;
  return {
    responseMs: responseEpoch - clickEpoch,
    backend,
    pageMs: r1(off),
    stages: t.stages.map((s) => ({ name: s.name, startMs: r1(s.startMs + off), endMs: at(s.endMs), ...(s.note !== undefined ? { note: s.note } : {}) })),
    readyMs: at(ready),
    firstFrameMs: at(t.firstFrameMs),
    afterFirstFrame: t.afterFirstFrame,
    counts: { ...t.counts },
  };
}

/** The split in one line for the log. */
export function splitLine(s: PlayStartSplit): string {
  const d = (x: { startMs: number; endMs: number | null }): string => (x.endMs === null ? `${x.startMs}…` : `${Math.round(x.endMs - x.startMs)}`);
  const stages = s.stages.map((x) => `${x.name} ${d(x)}${x.endMs !== null ? `@${Math.round(x.endMs)}` : ''}`).join(', ');
  const f = s.afterFirstFrame;
  return `response ${s.responseMs} (backend ${s.backend === null ? '-' : Object.entries(s.backend).map(([k, v]) => `${k} ${v}`).join(', ')}), page ${s.pageMs ?? '-'}, ${stages}; ready ${s.readyMs ?? '-'}, first frame ${s.firstFrameMs ?? '-'}; after it ${f === null ? '-' : `${f.frames} frames, ${f.over50} > 50 ms, ${f.over250} > 250 ms, worst ${f.worst.map((w) => w.ms).join('/')}`}`;
}

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.bin': 'application/octet-stream' };

/** A plain static file server: the exported game gets nothing else. */
export function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
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
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

export async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined as T);
    if (v !== undefined && ok(v)) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const loadavg = async (): Promise<number[]> => (await import('node:os')).loadavg().map((v) => Math.round(v * 100) / 100);
const MiB = (b: number): number => Math.round((b / 1048576) * 100) / 100;

function result(surface: SurfaceResult['surface'], renderer: RendererName, s: PageSample, load: Record<string, number>, notes: string[], la: number[]): SurfaceResult {
  return {
    surface,
    renderer,
    rendererChoice: s.renderer,
    apis: s.apis,
    load,
    frameMs: summarize(s.frames),
    drawCalls: summarize(s.frameDraws),
    triangles: summarize(s.frameTris),
    live: s.live,
    gpuMiBEstimate: MiB(s.bytes.buffers + s.bytes.textures),
    heapMiB: s.heap !== null ? Math.round(s.heap.usedMiB * 100) / 100 : null,
    heapSource: s.heap?.source ?? 'unavailable',
    uasm: s.uasm,
    notes,
    loadavg: la,
  };
}

async function record(target: Page | Frame, opts: SurfaceOptions): Promise<PageSample> {
  await target.evaluate(startRecording);
  await new Promise((r) => setTimeout(r, opts.recordMs));
  return target.evaluate(readSample, true);
}

/**
 * The page's main-thread work while recording — the renderer
 * process's `TaskDuration` (CDP Performance metrics: every task on its main
 * thread, not its workers) per rendered frame and as a share of the window.
 * A cross-origin iframe in its own process is measured there; one sharing the
 * editor's process (same site) includes the (idle) editor's tasks.
 */
async function recordWithMainThread(page: Page, target: Page | Frame, opts: SurfaceOptions): Promise<{ sample: PageSample; mainThread: SurfaceResult['mainThread'] }> {
  let cdp;
  try {
    cdp = target === page ? await page.context().newCDPSession(page) : await page.context().newCDPSession(target as Frame);
  } catch {
    cdp = await page.context().newCDPSession(page);
  }
  await cdp.send('Performance.enable');
  const metrics = async (): Promise<Record<string, number>> => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
  const a = await metrics();
  const t0 = performance.now();
  const sample = await record(target, opts);
  const b = await metrics();
  const wall = performance.now() - t0;
  const taskMs = ((b['TaskDuration'] ?? 0) - (a['TaskDuration'] ?? 0)) * 1000;
  await cdp.detach().catch(() => undefined);
  const frames = Math.max(1, sample.frames.length);
  return { sample, mainThread: { taskMsPerFrame: Math.round((taskMs / frames) * 100) / 100, busyShare: Math.round((taskMs / Math.max(1, wall)) * 1000) / 1000 } };
}

/**
 * Play: the editor's isolated preview (iframe), started through the play relay.
 * `plays` Plays in the same editor page (each one's start split
 * in `starts`), and `sceneLoad`: a scene loaded during the first one.
 */
export async function measurePlay(browser: Browser, be: PerfBackend, projectId: string, renderer: RendererName, opts: SurfaceOptions, threads: 'worker' | 'off' = 'worker', extra: { plays?: number; sceneLoad?: string } = {}): Promise<SurfaceResult> {
  const context = await browser.newContext({ viewport: opts.viewport });
  await context.addInitScript(installPerfInstrumentation);
  const page = await context.newPage();
  const notes: string[] = ['heap: the editor and the preview share one renderer process (same site), so the heap is editor + game'];
  const relay = async (path: string, body: unknown = {}) => be.post(`/api/v1/projects/${projectId}/play/${path}`, body);
  try {
    await page.goto(uncappedUrl(`${be.origin}/?project=${projectId}&renderer=${renderer}${threads === 'off' ? '&threads=off' : ''}#token=${be.token}`));
    await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 120_000 });
    type Diag = { diagnostics?: { renderer?: { gpu?: { geometries: number; textures: number; programs: number } }; startTimings?: StartTimingsReport }; buildTimings?: Record<string, number> };
    /** Start a Play and wait for its first frame (the preview frame, its id, when it was clicked and answered). */
    const startPlay = async (): Promise<{ frame: Frame; psid: string; t0: number; responseEpoch: number; readyMs: number; firstEpoch: number }> => {
      const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'), { timeout: 120_000 });
      const before = new Set(page.frames());
      const t0 = Date.now();
      await page.getByTitle('Start an isolated play preview').click();
      const response = await started;
      const responseEpoch = Date.now();
      const psid = String(((await response.json()) as { playSessionId: string }).playSessionId);
      // The editor mounts the preview iframe once the backend's play.started message (with the snapshot) arrives.
      const frame = await poll(async () => page.frames().find((f) => !before.has(f) && f.url().startsWith(be.previewOrigin)), (f) => f !== undefined, 90_000, 'the preview iframe (the play.started message never reached the editor)');
      await poll(async () => (await relay(`${psid}/observe`)).json['state'], (s) => s === 'running', 180_000, 'the play preview');
      const readyMs = Date.now() - t0;
      const firstEpoch = await poll(async () => frame!.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null), (v) => v !== null, 120_000, 'the first Play frame');
      return { frame: frame!, psid, t0, responseEpoch, readyMs, firstEpoch: firstEpoch! };
    };
    /** The start split, once the 10 s frame watch after the first frame is over. */
    const splitFor = async (p: { psid: string; t0: number; responseEpoch: number; firstEpoch: number }): Promise<{ split: PlayStartSplit; diag: Diag }> => {
      const wait = p.firstEpoch + 10_500 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const diag = (await relay(`${p.psid}/diagnostics`)).json as Diag;
      return { split: splitOf(p.t0, p.responseEpoch, diag.buildTimings ?? null, diag.diagnostics?.startTimings), diag };
    };
    const stopPlay = async (psid: string): Promise<void> => {
      await page.getByTitle('Stop the play preview').click().catch(() => undefined);
      await poll(async () => (await relay(`${psid}/observe`)).status, (st) => st === 404, 30_000, 'the play to stop').catch(() => undefined);
    };

    const first = await startPlay();
    await new Promise((r) => setTimeout(r, opts.warmupMs));
    const { sample, mainThread } = await recordWithMainThread(page, first.frame, opts);
    const la = await loadavg();
    const { split, diag: firstDiag } = await splitFor(first);
    // The benchmark plays as a scene (the play state: running).
    const observed = (await relay(`${first.psid}/observe`)).json as { state?: string };
    const state = String(observed.state);
    const out = result('play', renderer, sample, { firstFrameMs: first.firstEpoch - first.t0, readyMs: first.readyMs }, notes, la);
    const diag = firstDiag.diagnostics;
    if (diag?.renderer?.gpu !== undefined) out.three = diag.renderer.gpu;
    out.state = state;
    out.threads = threads;
    if (mainThread !== undefined) out.mainThread = mainThread;
    out.starts = [split];
    if (extra.sceneLoad !== undefined) {
      // A scene that does not start, loaded like a script's ctx.scenes.load.
      const sceneId = extra.sceneLoad;
      const asked = await relay(`${first.psid}/control`, { command: 'loadScene', sceneId });
      if (asked.status !== 200) notes.push(`loadScene ${sceneId} refused: ${JSON.stringify(asked.json).slice(0, 200)}`);
      else {
        await poll(async () => ((await relay(`${first.psid}/observe`)).json as { scenes?: { loaded?: string[] } }).scenes?.loaded ?? [], (l) => l.includes(sceneId), 120_000, `scene ${sceneId} to load`).catch((e: Error) => notes.push(e.message));
        await new Promise((r) => setTimeout(r, 6_000));
        const d = (await relay(`${first.psid}/diagnostics`)).json as Diag;
        const load = d.diagnostics?.startTimings?.sceneLoads.find((l) => l.sceneId === sceneId);
        if (load !== undefined) {
          // From the request (ms), like the start split.
          const rel = (v: number | null): number | null => (v === null ? null : Math.round((v - load.requestedMs) * 10) / 10);
          out.sceneLoad = { ...load, readMs: rel(load.readMs), attachedMs: rel(load.attachedMs), after: load.after };
        }
      }
    }
    await stopPlay(first.psid);
    for (let n = 1; n < (extra.plays ?? 1); n += 1) {
      const again = await startPlay();
      out.starts.push((await splitFor(again)).split);
      await stopPlay(again.psid);
    }
    return out;
  } finally {
    await context.close();
  }
}

/** The standalone export, served statically (the backend is not involved). */
export async function measureExport(browser: Browser, exportDir: string, renderer: RendererName, opts: SurfaceOptions, threads: 'worker' | 'off' = 'worker'): Promise<SurfaceResult> {
  const site = await serveDir(exportDir);
  const context = await browser.newContext({ viewport: opts.viewport });
  await context.addInitScript(installPerfInstrumentation);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(uncappedUrl(`${site.url}?renderer=${renderer}${threads === 'off' ? '&threads=off' : ''}`));
    const first = await poll(async () => page.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawAt: number | null } }).__tlPerf?.firstDrawAt ?? null), (v) => v !== null, 180_000, 'the first export frame');
    // Start the run like a player (the fixed menu overlay: click by coordinates).
    const notes: string[] = [];
    try {
      await page.locator('#hud-root').filter({ hasText: 'to start' }).waitFor({ timeout: 60_000 });
      await page.mouse.click(opts.viewport.width / 2, opts.viewport.height / 2);
      await page.keyboard.press('Enter');
      await page.locator('#hud-root').filter({ hasText: 'to jump' }).waitFor({ timeout: 60_000 });
    } catch {
      notes.push('the run did not start; measured the title screen');
    }
    await new Promise((r) => setTimeout(r, opts.warmupMs));
    const { sample, mainThread } = await recordWithMainThread(page, page, opts);
    const la = await loadavg();
    if (errors.length > 0) notes.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
    const out = result('export', renderer, sample, { firstFrameMs: first!, domContentLoadedMs: sample.nav?.domContentLoaded ?? -1, loadMs: sample.nav?.load ?? -1 }, notes, la);
    out.threads = threads;
    if (mainThread !== undefined) out.mainThread = mainThread;
    return out;
  } finally {
    await context.close();
    await site.close();
  }
}

/** How long the settled Scene view is watched for frames (ms). */
const IDLE_WINDOW_MS = 3000;

/** The editor: load to the Scene view's first frame, orbit it, and time commands while it is open. */
export async function measureEditor(
  browser: Browser,
  be: PerfBackend,
  projectId: string,
  renderer: RendererName,
  opts: SurfaceOptions & { commands: number; entityId: string },
): Promise<{ surface: SurfaceResult; commandMs: Summary; commandSamples: number[]; ops?: EditorOpsResult }> {
  const context = await browser.newContext({ viewport: opts.viewport });
  await context.addInitScript(installPerfInstrumentation);
  const page = await context.newPage();
  try {
    const t0 = Date.now();
    await page.goto(uncappedUrl(`${be.origin}/?project=${projectId}&renderer=${renderer}#token=${be.token}`));
    await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 180_000 });
    const connectedMs = Date.now() - t0;
    const firstEpoch = await poll(async () => page.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null), (v) => v !== null, 120_000, 'the first Scene view frame');
    await new Promise((r) => setTimeout(r, opts.warmupMs));
    // Render on demand — once the view stops drawing (models, thumbnails and the
    // environment have arrived), nothing draws while nothing changes.
    const settleStart = Date.now();
    let lastFrames = '';
    for (;;) {
      const now = await page.evaluate(() => document.querySelector('canvas.tl-viewport')?.getAttribute('data-frames') ?? '');
      if (now === lastFrames || Date.now() - settleStart > 60_000) break;
      lastFrames = now;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const settledMs = Date.now() - settleStart;
    const idleSample = await record(page, { ...opts, recordMs: IDLE_WINDOW_MS });
    const idle = { windowMs: IDLE_WINDOW_MS, framesDrawn: idleSample.frameDraws.length, drawCalls: idleSample.frameDraws.reduce((a, b) => a + b, 0), settledMs };
    // The Scene view: the largest renderer canvas.
    const box = await page.evaluate(() => {
      const c = [...document.querySelectorAll('canvas[data-tl-renderer]')].sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
      const r = c?.getBoundingClientRect();
      return r === undefined ? null : { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (box === null) throw new Error('no Scene view canvas');
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Orbit: a real press on the Scene view (the orbit controls capture that pointer), then one
    // pointer move per animation frame in the page, so input never starves the renderer.
    await page.evaluate(() => {
      const w = window as unknown as { __tlPointer?: number };
      document.addEventListener('pointerdown', (e) => (w.__tlPointer = e.pointerId), { capture: true, once: true });
    });
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    const sample = await page.evaluate(
      async ({ cx, cy, rx, ry, ms }) => {
        const w = window as unknown as { __tlPointer?: number; __tlPerf?: { frames: number[]; frameDraws: number[]; frameTris: number[]; recording: boolean } };
        const P = w.__tlPerf!;
        P.frames = [];
        P.frameDraws = [];
        P.frameTris = [];
        P.recording = true;
        const target = document.elementFromPoint(cx, cy) ?? document.body;
        const id = w.__tlPointer ?? 1;
        await new Promise<void>((done) => {
          const t0 = performance.now();
          let i = 0;
          const step = (): void => {
            const a = (i++ / 60) * Math.PI * 2;
            const x = cx + Math.cos(a) * rx;
            const y = cy + Math.sin(a) * ry;
            target.dispatchEvent(new PointerEvent('pointermove', { pointerId: id, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: -1, buttons: 1, bubbles: true, cancelable: true, composed: true }));
            if (performance.now() - t0 < ms) requestAnimationFrame(step);
            else done();
          };
          requestAnimationFrame(step);
        });
        return true;
      },
      { cx, cy, rx: box.width * 0.15, ry: box.height * 0.1, ms: opts.recordMs },
    ).then(() => page.evaluate(readSample, true));
    await page.mouse.up();
    const la = await loadavg();

    const surface = result('editor', renderer, sample, { connectedMs, firstFrameMs: firstEpoch! - t0 }, ['heap: the whole editor page (projection, UI, Scene view)'], la);
    surface.idle = idle;
    if (opts.commands <= 0) return { surface, commandMs: summarize([]), commandSamples: [] };
    // The Hierarchy, command round trips (the one mutation path) while the editor shows
    // the project, what each costs the editor and the disk, and one material edit.
    const ops = await measureEditorOps(page, be, be.project(projectId), { commands: opts.commands, entityId: opts.entityId, projectDir: join(be.dataRoot, 'projects', projectId), scrollMs: 1500 });
    const sync = await page.evaluate(() => document.querySelector('canvas.tl-viewport')?.getAttribute('data-sync') ?? null);
    if (sync !== null) surface.lastSync = JSON.parse(sync) as Record<string, unknown>;
    return { surface, commandMs: ops.command.httpMs, commandSamples: [], ops };
  } finally {
    await context.close();
  }
}

/** A fixed raw-WebGL 2 workload (no Thirdlight code): the machine's frame time for relative numbers. */
export async function measureCalibration(browser: Browser, opts: SurfaceOptions): Promise<{ frameMs: Summary; drawCalls: Summary }> {
  const context = await browser.newContext({ viewport: opts.viewport });
  await context.addInitScript(installPerfInstrumentation);
  const page = await context.newPage();
  try {
    await page.setContent(`<!doctype html><html><body style="margin:0;overflow:hidden"><canvas id="c" width="${opts.viewport.width}" height="${opts.viewport.height}"></canvas><script>
const gl = document.getElementById('c').getContext('webgl2');
const vs = '#version 300 es\\nin vec2 p; uniform float t; uniform vec2 o; void main(){ float c=cos(t), s=sin(t); gl_Position = vec4(mat2(c,-s,s,c)*p*0.04 + o, 0.0, 1.0); }';
const fs = '#version 300 es\\nprecision highp float; out vec4 f; uniform vec2 o; void main(){ f = vec4(0.5+0.5*o, 0.6, 1.0); }';
const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); return x; };
const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr); gl.useProgram(pr);
const N = 1000, v = new Float32Array(N * 6);
for (let i = 0; i < N; i++) { const a = i / N * 6.2832, b = (i + 1) / N * 6.2832; v.set([0, 0, Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b)], i * 6); }
const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
const ut = gl.getUniformLocation(pr, 't'), uo = gl.getUniformLocation(pr, 'o');
const frame = (t) => { gl.clearColor(0.1, 0.1, 0.12, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  for (let i = 0; i < 100; i++) { gl.uniform1f(ut, t / 1000 + i); gl.uniform2f(uo, (i % 10) / 5 - 0.9, Math.floor(i / 10) / 5 - 0.9); gl.drawArrays(gl.TRIANGLES, 0, N * 3); }
  requestAnimationFrame(frame); };
requestAnimationFrame(frame);
</script></body></html>`);
    await new Promise((r) => setTimeout(r, opts.warmupMs));
    const s = await record(page, opts);
    return { frameMs: summarize(s.frames), drawCalls: summarize(s.frameDraws) };
  } finally {
    await context.close();
  }
}
