/**
 * Phase 21.1: the browser side of the harness — one benchmark project loaded
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

import { browserLaunchEnv } from '../../tests/e2e/browser-env.mjs';
import type { PerfBackend } from './backend';
import { installPerfInstrumentation, readSample, startRecording, type PageSample } from './instrument';
import { summarize, type Summary } from './stats';

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
  notes: string[];
  loadavg: number[];
}

export async function launch(renderer: RendererName): Promise<Browser> {
  return chromium.launch({ env: browserLaunchEnv() as Record<string, string>, args: [...GL_ARGS, ...(renderer === 'webgpu' || renderer === 'auto' ? WEBGPU_ARGS : []), ...MEASURE_ARGS] });
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

async function poll<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, what: string): Promise<T> {
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

/** Play: the editor's isolated preview (iframe), started through the play relay. */
export async function measurePlay(browser: Browser, be: PerfBackend, projectId: string, renderer: RendererName, opts: SurfaceOptions): Promise<SurfaceResult> {
  const context = await browser.newContext({ viewport: opts.viewport });
  await context.addInitScript(installPerfInstrumentation);
  const page = await context.newPage();
  const notes: string[] = ['heap: the editor and the preview share one renderer process (same site), so the heap is editor + game'];
  const relay = async (path: string, body: unknown = {}) => be.post(`/api/v1/projects/${projectId}/play/${path}`, body);
  try {
    await page.goto(`${be.origin}/?project=${projectId}&renderer=${renderer}#token=${be.token}`);
    await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 120_000 });
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'), { timeout: 60_000 });
    const t0 = Date.now();
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    // The editor mounts the preview iframe once the backend's play.started message (with the snapshot) arrives.
    const frame = await poll(async () => page.frames().find((f) => f.url().startsWith(be.previewOrigin)), (f) => f !== undefined, 90_000, 'the preview iframe (the play.started message never reached the editor)');
    await poll(async () => (await relay(`${psid}/observe`)).json['state'], (s) => s === 'awaitingStart' || s === 'playing', 180_000, 'the play preview');
    const readyMs = Date.now() - t0;
    await relay(`${psid}/control`, { command: 'start' });
    const firstEpoch = await poll(async () => frame!.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null), (v) => v !== null, 120_000, 'the first Play frame');
    await new Promise((r) => setTimeout(r, opts.warmupMs));
    const sample = await record(frame!, opts);
    const la = await loadavg();
    const diag = (await relay(`${psid}/diagnostics`)).json['diagnostics'] as { renderer?: { gpu?: { geometries: number; textures: number; programs: number } } } | undefined;
    const state = String((await relay(`${psid}/observe`)).json['state']);
    const out = result('play', renderer, sample, { firstFrameMs: firstEpoch! - t0, readyMs }, notes, la);
    if (diag?.renderer?.gpu !== undefined) out.three = diag.renderer.gpu;
    out.state = state;
    await page.getByTitle('Stop the play preview').click().catch(() => undefined);
    return out;
  } finally {
    await context.close();
  }
}

/** The standalone export, served statically (the backend is not involved). */
export async function measureExport(browser: Browser, exportDir: string, renderer: RendererName, opts: SurfaceOptions): Promise<SurfaceResult> {
  const site = await serveDir(exportDir);
  const context = await browser.newContext({ viewport: opts.viewport });
  await context.addInitScript(installPerfInstrumentation);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`${site.url}?renderer=${renderer}`);
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
    const sample = await record(page, opts);
    const la = await loadavg();
    if (errors.length > 0) notes.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
    return result('export', renderer, sample, { firstFrameMs: first!, domContentLoadedMs: sample.nav?.domContentLoaded ?? -1, loadMs: sample.nav?.load ?? -1 }, notes, la);
  } finally {
    await context.close();
    await site.close();
  }
}

/** The editor: load to the Scene view's first frame, orbit it, and time commands while it is open. */
export async function measureEditor(
  browser: Browser,
  be: PerfBackend,
  projectId: string,
  renderer: RendererName,
  opts: SurfaceOptions & { commands: number; entityId: string },
): Promise<{ surface: SurfaceResult; commandMs: Summary; commandSamples: number[] }> {
  const context = await browser.newContext({ viewport: opts.viewport });
  await context.addInitScript(installPerfInstrumentation);
  const page = await context.newPage();
  try {
    const t0 = Date.now();
    await page.goto(`${be.origin}/?project=${projectId}&renderer=${renderer}#token=${be.token}`);
    await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 180_000 });
    const connectedMs = Date.now() - t0;
    const firstEpoch = await poll(async () => page.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null), (v) => v !== null, 120_000, 'the first Scene view frame');
    await new Promise((r) => setTimeout(r, opts.warmupMs));
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

    // Command round trips (the one mutation path) while the editor shows the project.
    const p = be.project(projectId);
    const q = await p.query('queryEntity', { entityId: opts.entityId });
    const pos = ((q['entity'] as { components: { transform: { position: number[] } } } | undefined)?.components.transform.position ?? [0, 0, 0]).slice();
    const samples: number[] = [];
    await p.revision();
    for (let i = 0; i < opts.commands; i += 1) {
      const a = performance.now();
      await p.command('setTransform', { entityId: opts.entityId, transform: { position: [pos[0]! + (i % 2 === 0 ? 0.25 : 0), pos[1]!, pos[2]!] } });
      samples.push(performance.now() - a);
    }
    const surface = result('editor', renderer, sample, { connectedMs, firstFrameMs: firstEpoch! - t0 }, ['heap: the whole editor page (projection, UI, Scene view)'], la);
    return { surface, commandMs: summarize(samples), commandSamples: samples.map((v) => Math.round(v * 100) / 100) };
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
