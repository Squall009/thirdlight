/**
 * SPIKE 22.2 (archived): measure the render worker against the current mode
 * with the phase 21 harness pieces (tools/perf: generator, builder, backend,
 * instrumentation, browser launch, static server, stats).
 *
 *   npm run build
 *   node archive/spike-22-render-worker/run.mjs [--classes medium,large] [--renderers webgl2,webgpu]
 *        [--repeats 2] [--record-ms 5000] [--warmup-ms 2000] [--trials 6] [--viewport 1280x720]
 *        [--modes product,main,worker,worker-raf] [--shots] [--keep]
 *
 * For each class it builds the benchmark project, exports it, makes the spike
 * variant of the export (build.mjs) and stops the backend. Then, per renderer,
 * it loads, in a rotating order per repeat:
 *   product — the untouched export (simulation worker, the page renders),
 *   main    — the spike page with ?render=main (the same, plus the probes),
 *   worker-co  — the spike page with ?render=worker&renderPace=coalesce (the render worker drawing the
 *                newest simulation frame; also what plain ?render=worker does now),
 *   worker-raf — ?render=worker&renderPace=raf (drawing on the worker's animation frame),
 *   worker-msg — ?render=worker&renderPace=message (drawing every frame as it arrives; run 1 measured it
 *                as "worker" when it was the default).
 * and records, while the run is playing: frame intervals (the harness's API
 * instrumentation, in the page or in the render worker), the page's
 * main-thread task time (CDP TaskDuration: the page's main thread only, not
 * its workers) per drawn frame, the audio request latency (the simulation
 * posting a frame → the page's host taking its audio requests), the
 * simulation frame posted → drawn delay, and an
 * input-to-photon proxy: a key goes down (its event time stamp) → the first
 * drawn frame whose player x moved, in ms and in drawn frames.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';

import type { Browser, Page, Worker } from '@playwright/test';

import { PERF_ROOT, REPO, startPerfBackend } from '../../tools/perf/backend';
import { launch, serveDir, type RendererName } from '../../tools/perf/browser';
import { buildBenchmark } from '../../tools/perf/build';
import { DEFAULT_SEED, generate } from '../../tools/perf/generate';
import { installPerfInstrumentation, readSample, startRecording } from '../../tools/perf/instrument';
import { summarize, type Summary } from '../../tools/perf/stats';
import type { BenchClass } from '../../tools/perf/classes';

type Mode = 'product' | 'main' | 'worker' | 'worker-co' | 'worker-raf' | 'worker-msg';
const inWorker = (m: Mode): boolean => m.startsWith('worker');

const argv = process.argv.slice(2);
const flag = (name: string, dflt: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : dflt;
};
const classes = flag('classes', 'medium,large').split(',') as BenchClass[];
const renderers = flag('renderers', 'webgl2').split(',') as RendererName[];
const repeats = Number(flag('repeats', '2'));
const recordMs = Number(flag('record-ms', '5000'));
const warmupMs = Number(flag('warmup-ms', '2000'));
const trials = Number(flag('trials', '6'));
const [vw, vh] = flag('viewport', '1280x720').split('x').map(Number) as [number, number];
const modes = flag('modes', 'product,main,worker-co,worker-raf').split(',') as Mode[];
const shotsDir = argv.includes('--shots') ? join(PERF_ROOT, 'spike222-shots') : null;
if (shotsDir !== null) mkdirSync(shotsDir, { recursive: true });
const la = (): number[] => loadavg().map((v) => Math.round(v * 100) / 100);
const log = (s: string): void => console.log(s);

interface WorkerSample {
  frames: number[];
  frameDraws: number[];
  frameTris: number[];
  apis: string[];
  firstDrawEpoch: number | null;
}

interface Measured {
  cls: string;
  renderer: RendererName;
  mode: Mode;
  repeat: number;
  firstFrameMs: number | null;
  frameMs: Summary;
  framesDrawn: number;
  drawCalls: Summary;
  mainThread: { taskMs: number; taskMsPerFrame: number; busyShare: number };
  audioLatencyMs: Summary | null;
  renderLagMs: Summary | null;
  /** Intervals between the adapter's renderFrame calls in the window (the probes). */
  adapterFrameMs: Summary | null;
  input: { latencyMs: Summary; frames: Summary; missed: number } | null;
  apis: string[];
  threading: unknown;
  notes: string[];
  loadavg: number[];
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

const renderWorkerOf = (page: Page): Worker | undefined => page.workers().find((w) => w.url().includes('render-worker'));

/** In the render worker: the harness's recording window (instrument.ts's startRecording, on `self`). */
function workerStartRecording(): void {
  const P = (self as unknown as { __tlPerf?: { frames: number[]; frameDraws: number[]; frameTris: number[]; recording: boolean } }).__tlPerf;
  if (P === undefined) return;
  P.frames = [];
  P.frameDraws = [];
  P.frameTris = [];
  P.recording = true;
}
function workerReadSample(): WorkerSample | null {
  const P = (self as unknown as { __tlPerf?: WorkerSample & { recording: boolean } }).__tlPerf;
  if (P === undefined) return null;
  P.recording = false;
  return { frames: P.frames.slice(), frameDraws: P.frameDraws.slice(), frameTris: P.frameTris.slice(), apis: P.apis.slice(), firstDrawEpoch: P.firstDrawEpoch };
}

type DrawnFrame = { t: number; x: number | null; simT?: number };

async function drawnFrames(page: Page, mode: Mode): Promise<DrawnFrame[]> {
  if (inWorker(mode)) {
    const w = renderWorkerOf(page);
    return w === undefined ? [] : w.evaluate(() => (self as unknown as { __spikeFrames: DrawnFrame[] }).__spikeFrames.slice(-600));
  }
  return page.evaluate(() => (window as unknown as { __spike: { frames: DrawnFrame[] } }).__spike.frames.slice(-600));
}

async function inputTrials(page: Page, mode: Mode): Promise<Measured['input']> {
  const lat: number[] = [];
  const nFrames: number[] = [];
  let missed = 0;
  for (let i = 0; i < trials; i += 1) {
    const code = i % 2 === 0 ? 'ArrowRight' : 'ArrowLeft';
    const k0 = await page.evaluate(() => (window as unknown as { __spike: { keys: unknown[] } }).__spike.keys.length);
    await page.keyboard.down(code);
    let found: { ms: number; frames: number } | null = null;
    const until = Date.now() + 4000;
    while (found === null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 60));
      const keys = await page.evaluate(() => (window as unknown as { __spike: { keys: { code: string; t: number }[] } }).__spike.keys.slice());
      const key = keys.slice(k0).find((k) => k.code === code);
      if (key === undefined) continue;
      const frames = await drawnFrames(page, mode);
      const before = frames.filter((f) => f.t <= key.t && f.x !== null).at(-1);
      if (before === undefined) continue;
      const after = frames.filter((f) => f.t > key.t);
      const idx = after.findIndex((f) => f.x !== null && Math.abs(f.x - before.x!) > 1e-3);
      if (idx >= 0) found = { ms: after[idx]!.t - key.t, frames: idx + 1 };
    }
    await page.keyboard.up(code);
    if (found === null) missed += 1;
    else {
      lat.push(Math.round(found.ms * 10) / 10);
      nFrames.push(found.frames);
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  return { latencyMs: summarize(lat), frames: summarize(nFrames), missed };
}

async function measure(browser: Browser, dir: string, cls: string, renderer: RendererName, mode: Mode, repeat: number): Promise<Measured> {
  const site = await serveDir(dir);
  const context = await browser.newContext({ viewport: { width: vw, height: vh } });
  await context.addInitScript(installPerfInstrumentation);
  const page = await context.newPage();
  const notes: string[] = [];
  page.on('pageerror', (e) => notes.push(`pageerror: ${e.message.slice(0, 200)}`));
  page.on('console', (m) => {
    if (m.type() === 'error') notes.push(`console: ${m.text().slice(0, 200)}`);
  });
  try {
    const t0 = Date.now();
    await page.goto(`${site.url}?renderer=${renderer}${mode === 'main' ? '&render=main' : mode === 'worker' ? '&render=worker' : mode === 'worker-raf' ? '&render=worker&renderPace=raf' : mode === 'worker-co' ? '&render=worker&renderPace=coalesce' : mode === 'worker-msg' ? '&render=worker&renderPace=message' : ''}`);
    const firstEpoch = await poll(
      async () => {
        if (inWorker(mode)) {
          const w = renderWorkerOf(page);
          return w === undefined ? null : w.evaluate(() => (self as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null);
        }
        return page.evaluate(() => (window as unknown as { __tlPerf?: { firstDrawEpoch: number | null } }).__tlPerf?.firstDrawEpoch ?? null);
      },
      (v) => v !== null,
      240_000,
      'the first frame',
    );
    try {
      await page.locator('#hud-root').filter({ hasText: 'to start' }).waitFor({ timeout: 90_000 });
      await page.mouse.click(vw / 2, vh / 2);
      await page.keyboard.press('Enter');
      await page.locator('#hud-root').filter({ hasText: 'to jump' }).waitFor({ timeout: 90_000 });
    } catch {
      notes.push('the run did not start; measured the title screen');
    }
    await new Promise((r) => setTimeout(r, warmupMs));
    // A look at what each mode draws (the composited page, the OffscreenCanvas's placeholder included).
    if (shotsDir !== null && repeat === 0) await page.screenshot({ path: join(shotsDir, `${cls}-${renderer}-${mode}.png`) }).catch(() => undefined);
    const threading = await page.evaluate(() => (window as unknown as { __thirdlightThreading?: unknown }).__thirdlightThreading ?? null);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async (): Promise<Record<string, number>> => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
    const audio0 = mode === 'product' ? 0 : await page.evaluate(() => (window as unknown as { __spike: { audio: number[] } }).__spike.audio.length);
    const worker = inWorker(mode) ? renderWorkerOf(page) : undefined;
    if (inWorker(mode) && worker === undefined) throw new Error('no render worker');
    const a = await metrics();
    const w0 = performance.now();
    const e0 = await page.evaluate(() => performance.timeOrigin + performance.now());
    if (worker !== undefined) await worker.evaluate(workerStartRecording);
    else await page.evaluate(startRecording);
    await new Promise((r) => setTimeout(r, recordMs));
    let frames: number[];
    let draws: number[];
    let apis: string[];
    if (worker !== undefined) {
      const s = await worker.evaluate(workerReadSample);
      frames = s?.frames ?? [];
      draws = s?.frameDraws ?? [];
      apis = s?.apis ?? [];
    } else {
      const s = await page.evaluate(readSample, true);
      frames = s.frames;
      draws = s.frameDraws;
      apis = s.apis;
    }
    const b = await metrics();
    const wall = performance.now() - w0;
    const e1 = await page.evaluate(() => performance.timeOrigin + performance.now());
    await cdp.detach().catch(() => undefined);
    const taskMs = ((b['TaskDuration'] ?? 0) - (a['TaskDuration'] ?? 0)) * 1000;

    const audio = mode === 'product' ? null : summarize(await page.evaluate((from) => (window as unknown as { __spike: { audio: number[] } }).__spike.audio.slice(from), audio0));
    // Simulation frame posted -> drawn (ms), over the window's drawn frames.
    // The adapter-level record of the window's drawn frames (the probes; every mode but the product).
    const probeFrames = mode === 'product' ? [] : (await drawnFrames(page, mode)).filter((f) => f.t >= e0 && f.t <= e1);
    const renderLag = mode === 'product' ? null : summarize(probeFrames.filter((f) => (f.simT ?? 0) > 0).map((f) => Math.round((f.t - f.simT!) * 10) / 10));
    const probeMs = mode === 'product' ? null : summarize(probeFrames.slice(1).map((f, i) => Math.round((f.t - probeFrames[i]!.t) * 10) / 10));
    // Per drawn frame: the adapter's renders where the probes have them (the instrumentation's rAF-based count merges a worker's draws).
    const drawn = Math.max(1, probeMs !== null ? probeFrames.length : draws.length);
    const input = mode === 'product' ? null : await inputTrials(page, mode);
    return {
      cls,
      renderer,
      mode,
      repeat,
      firstFrameMs: firstEpoch !== null ? firstEpoch - t0 : null,
      frameMs: summarize(frames),
      framesDrawn: draws.length,
      drawCalls: summarize(draws),
      mainThread: { taskMs: Math.round(taskMs), taskMsPerFrame: Math.round((taskMs / drawn) * 100) / 100, busyShare: Math.round((taskMs / Math.max(1, wall)) * 1000) / 1000 },
      audioLatencyMs: audio,
      renderLagMs: renderLag,
      adapterFrameMs: probeMs,
      input,
      apis,
      threading,
      notes: notes.slice(0, 8),
      loadavg: la(),
    };
  } finally {
    await context.close();
    await site.close();
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = join(PERF_ROOT, 'runs', `spike222-${stamp}`);
const reportsDir = join(PERF_ROOT, 'reports');
mkdirSync(runDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });
const results: Measured[] = [];
const out = join(reportsDir, `spike222-${stamp}.json`);
/** Written after every measurement (a stopped run keeps what it measured). */
const writeReport = (): void => writeFileSync(out, `${JSON.stringify({ startedAt: stamp, loadStart, loadEnd: la(), options: { classes, renderers, repeats, recordMs, warmupMs, trials, viewport: [vw, vh], modes }, results, errors }, null, 2)}\n`);
const errors: string[] = [];
const loadStart = la();
log(`spike222: load ${loadStart.join(' ')}; classes ${classes.join(',')}; renderers ${renderers.join(',')}; repeats ${repeats}`);
for (const cls of classes) {
  const be = await startPerfBackend(join(runDir, cls), join(runDir, `${cls}-exports`));
  let exportDir: string;
  try {
    const build = await buildBenchmark(be, generate(cls, DEFAULT_SEED), 'bench', log);
    log(`spike222: ${cls} built in ${build.ms} ms`);
    const res = await be.post('/api/v1/admin/projects/bench/export', {});
    if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 300)}`);
    exportDir = join(be.exportRoot, String(res.json['outputDir']));
  } finally {
    await be.stop();
  }
  const variantDir = `${exportDir}-spike222`;
  execFileSync(process.execPath, [join(REPO, 'archive', 'spike-22-render-worker', 'build.mjs'), exportDir, variantDir], { stdio: 'inherit' });
  for (const r of renderers) {
    const browser = await launch(r);
    try {
      for (let rep = 0; rep < repeats; rep += 1) {
        const order = modes.map((_, i) => modes[(i + rep) % modes.length]!);
        for (const mode of order) {
          try {
            // A hard bound per measurement (a stalled mode must not hold the run up).
            const m = await Promise.race([
              measure(browser, mode === 'product' ? exportDir : variantDir, cls, r, mode, rep),
              new Promise<never>((_, fail) => setTimeout(() => fail(new Error('measurement timed out after 6 min')), 360_000)),
            ]);
            results.push(m);
            writeReport();
            log(`spike222: ${cls} ${r} ${mode} #${rep}: frame mean ${m.frameMs.mean} p95 ${m.frameMs.p95} ms (${m.framesDrawn} drawn; adapter ${m.adapterFrameMs?.mean ?? '-'} ms, ${m.adapterFrameMs !== null ? m.adapterFrameMs.n + 1 : '-'} renders), main thread ${m.mainThread.taskMsPerFrame} ms/frame (busy ${Math.round(m.mainThread.busyShare * 100)}%), audio p50/p95 ${m.audioLatencyMs?.p50 ?? '-'}/${m.audioLatencyMs?.p95 ?? '-'} ms, sim->drawn p50/p95 ${m.renderLagMs?.p50 ?? '-'}/${m.renderLagMs?.p95 ?? '-'} ms, input p50 ${m.input?.latencyMs.p50 ?? '-'} ms / ${m.input?.frames.p50 ?? '-'} frames (max ${m.input?.latencyMs.max ?? '-'} ms / ${m.input?.frames.max ?? '-'}, missed ${m.input?.missed ?? '-'}), first frame ${m.firstFrameMs} ms, load ${m.loadavg[0]}${m.notes.length > 0 ? `; notes: ${m.notes.join(' | ')}` : ''}`);
          } catch (e) {
            const msg = `${cls} ${r} ${mode} #${rep}: ${String((e as Error).message ?? e).slice(0, 300)}`;
            errors.push(msg);
            log(`spike222: FAILED ${msg}`);
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
}
writeReport();
log(`spike222: report ${out}`);
if (!argv.includes('--keep')) execFileSync('rm', ['-rf', runDir]);
