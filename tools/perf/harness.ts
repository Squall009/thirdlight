/**
 * Phase 21.1: the performance harness. For each benchmark class it generates
 * the project (generate.ts), builds it through the real backend (build.ts),
 * measures Play, the export and the editor Scene view in Chromium for each
 * renderer (browser.ts), editor command round trips, and the headless
 * simulation (sim-run.ts); then writes one JSON report under
 * ~/.cache/thirdlight-perf/reports/ (and `latest.json`).
 *
 * Run it with the runner: `node tools/perf/run.mjs [options]` (see
 * docs/deployment.md "Performance"). Not part of the default test runs.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

import { BENCH_CLASSES, BUDGETS, type BenchClass } from './classes';
import { PERF_ROOT, REPO, startPerfBackend } from './backend';
import { launch, measureCalibration, measureEditor, measureExport, measurePlay, type RendererName, type SurfaceOptions, type SurfaceResult } from './browser';
import { buildBenchmark, type BuildResult } from './build';
import type { EditorOpsResult } from './editor-ops';
import { DEFAULT_SEED, GENERATOR_VERSION, generate } from './generate';
import { runSimChild } from './sim-run';
import type { SimResult } from './sim';
import { cpuCalibration, summarize, type Metric, type Summary } from './stats';

export type Surface = 'play' | 'export' | 'editor' | 'sim';
export const SURFACES: readonly Surface[] = ['play', 'export', 'editor', 'sim'];

export interface HarnessOptions {
  classes: BenchClass[];
  renderers: RendererName[];
  surfaces: Surface[];
  /** Phase 22.0: where Play and the export run their simulation (worker = the default; off = ?threads=off). */
  threads: ('worker' | 'off')[];
  seed: number;
  warmupMs: number;
  recordMs: number;
  commands: number;
  simSteps: number;
  viewport: { width: number; height: number };
  keep: boolean;
  out?: string;
  log: (s: string) => void;
}

export interface BenchReport {
  /** Calibrations taken just before this class (the machine's load moves during a run). */
  cpuMs: number;
  calibration: Record<string, { frameMs: Summary; drawCalls: Summary }>;
  build: BuildResult;
  counts: Record<string, number>;
  exportMs?: number;
  surfaces: SurfaceResult[];
  commandMs?: Summary;
  /** Phase 21.4: the Hierarchy, command costs in the editor and on disk, WebSocket sizes. */
  editorOps?: EditorOpsResult;
  sim?: SimResult | { ok: false; error: string };
  errors: string[];
}

export interface Report {
  reportVersion: 1;
  startedAt: string;
  finishedAt: string;
  machine: { cpu: string; cores: number; memGiB: number; node: string; gpu: string; loadavgStart: number[]; loadavgEnd: number[] };
  commit: string;
  generatorVersion: number;
  options: Omit<HarnessOptions, 'log'>;
  calibration: { cpuMs: number; cpuMsEnd: number; browser: Record<string, { frameMs: Summary; drawCalls: Summary }> };
  benchmarks: Partial<Record<BenchClass, BenchReport>>;
  /** The machine-independent metrics a baseline compares (stats.ts). */
  metrics: Record<string, Metric>;
  /** Budgets exceeded (absolute; frame and load times on this CPU-rendered host are owner look). */
  overBudget: { key: string; value: number; budget: number; note: string }[];
}

export function parseArgs(argv: readonly string[]): Omit<HarnessOptions, 'log'> {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = <T extends string>(name: string, all: readonly T[], dflt: readonly T[]): T[] => {
    const v = get(name);
    if (v === undefined) return [...dflt];
    const items = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const it of items) if (!all.includes(it as T)) throw new Error(`--${name}: unknown ${it} (one of ${all.join(', ')})`);
    return items as T[];
  };
  const quick = argv.includes('--quick');
  const [vw, vh] = (get('viewport') ?? '1280x720').split('x').map(Number);
  return {
    classes: list('classes', BENCH_CLASSES, BENCH_CLASSES),
    renderers: list<RendererName>('renderers', ['legacy', 'webgl2', 'webgpu', 'auto'], ['legacy', 'webgl2']),
    surfaces: list('surfaces', SURFACES, SURFACES),
    threads: list<'worker' | 'off'>('threads', ['worker', 'off'], ['worker']),
    seed: Number(get('seed') ?? DEFAULT_SEED),
    warmupMs: Number(get('warmup-ms') ?? (quick ? 500 : 1500)),
    recordMs: Number(get('record-ms') ?? (quick ? 1500 : 5000)),
    commands: Number(get('commands') ?? (quick ? 10 : 40)),
    simSteps: Number(get('sim-steps') ?? (quick ? 240 : 1200)),
    viewport: { width: vw ?? 1280, height: vh ?? 720 },
    keep: argv.includes('--keep'),
    ...(get('out') !== undefined ? { out: get('out') } : {}),
  };
}

const la = (): number[] => loadavg().map((v) => Math.round(v * 100) / 100);
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

/** The metrics a baseline stores for one run (see stats.ts for the kinds). */
export function metricsOf(report: Pick<Report, 'benchmarks' | 'calibration'>): Record<string, Metric> {
  const m: Record<string, Metric> = {};
  for (const [cls, b] of Object.entries(report.benchmarks)) {
    if (b === undefined) continue;
    const cpu = b.cpuMs > 0 ? b.cpuMs : report.calibration.cpuMs;
    m[`${cls}.entities`] = { value: b.build.entities, kind: 'count' };
    m[`${cls}.build.msPerCommand/cpu`] = { value: r3(b.build.ms / Math.max(1, b.build.commands) / cpu), kind: 'ratio' };
    for (const s of b.surfaces) {
      // The mean interval: SwiftShader's GPU process runs behind the page, so rendered frames come in
      // bursts (short intervals, then a long wait) and the median understates the frame time.
      const cal = (b.calibration[s.renderer] ?? report.calibration.browser[s.renderer])?.frameMs.mean;
      const k = `${cls}.${s.surface}.${s.renderer}${s.threads === 'off' ? '.threads-off' : ''}`;
      if (s.frameMs.n > 0 && cal !== undefined && cal > 0) {
        m[`${k}.frameMean/cal`] = { value: r3(s.frameMs.mean / cal), kind: 'ratio' };
        m[`${k}.frameP95/cal`] = { value: r3(s.frameMs.p95 / cal), kind: 'ratio' };
      }
      if (s.load['firstFrameMs'] !== undefined) m[`${k}.firstFrame/cpu`] = { value: r3(s.load['firstFrameMs'] / cpu), kind: 'ratio' };
      if (s.surface !== 'editor') m[`${k}.drawCalls`] = { value: s.drawCalls.p50, kind: 'count' };
      m[`${k}.programs`] = { value: s.live.programs + s.live.pipelines, kind: 'count' };
      m[`${k}.textures`] = { value: s.live.textures, kind: 'count' };
      m[`${k}.buffers`] = { value: s.live.buffers, kind: 'count' };
      m[`${k}.gpuMiB`] = { value: s.gpuMiBEstimate, kind: 'memory' };
      if (s.heapMiB !== null) m[`${k}.heapMiB`] = { value: s.heapMiB, kind: 'memory' };
    }
    if (b.commandMs !== undefined && b.commandMs.n > 0) m[`${cls}.command.p95/cpu`] = { value: r3(b.commandMs.p95 / cpu), kind: 'ratio' };
    const ops = b.editorOps;
    if (ops !== undefined) {
      m[`${cls}.hierarchy.domRows`] = { value: ops.hierarchy.domRows, kind: 'count' };
      if (ops.hierarchy.selectMs.n > 0) m[`${cls}.hierarchy.selectP50/cpu`] = { value: r3(ops.hierarchy.selectMs.p50 / cpu), kind: 'ratio' };
      if (ops.hierarchy.renameMs.n > 0) m[`${cls}.hierarchy.renameP50/cpu`] = { value: r3(ops.hierarchy.renameMs.p50 / cpu), kind: 'ratio' };
      if (ops.hierarchy.scrollStepMs.n > 0) m[`${cls}.hierarchy.scrollStepP50/cpu`] = { value: r3(ops.hierarchy.scrollStepMs.p50 / cpu), kind: 'ratio' };
      if (ops.command.applyFrameMs.n > 0) m[`${cls}.command.applyFrameP50/cpu`] = { value: r3(ops.command.applyFrameMs.p50 / cpu), kind: 'ratio' };
      m[`${cls}.command.wsKiB`] = { value: r3(ops.command.wsBytesPerCommand / 1024), kind: 'count' };
      m[`${cls}.command.writtenKiB`] = { value: r3(ops.command.bytesWrittenPerCommand / 1024), kind: 'count' };
      m[`${cls}.command.filesWritten`] = { value: ops.command.filesWrittenPerCommand, kind: 'count' };
      if (ops.material !== null) m[`${cls}.material.wsKiB`] = { value: r3(ops.material.wsBytes / 1024), kind: 'count' };
    }
    if (b.sim !== undefined && b.sim.ok) {
      const s = b.sim;
      m[`${cls}.sim.stepP50/cpu`] = { value: r3(s.stepMs.p50 / s.calibrationMs), kind: 'ratio' };
      m[`${cls}.sim.stepP95/cpu`] = { value: r3(s.stepMs.p95 / s.calibrationMs), kind: 'ratio' };
      m[`${cls}.sim.KiBPerStep`] = { value: r3(s.bytesPerStep.median / 1024), kind: 'memory' };
      m[`${cls}.sim.heapMiB`] = { value: s.heapUsedMiB, kind: 'memory' };
    }
  }
  return m;
}

function overBudget(report: Pick<Report, 'benchmarks'>): Report['overBudget'] {
  const out: Report['overBudget'] = [];
  const cpuNote = 'CPU-rendered host (SwiftShader): owner look on a real GPU';
  for (const [cls, b] of Object.entries(report.benchmarks)) {
    if (b === undefined) continue;
    const budget = BUDGETS[cls as BenchClass];
    const check = (key: string, value: number | undefined, limit: number, note: string): void => {
      if (value !== undefined && value > limit) out.push({ key: `${cls}.${key}`, value: r3(value), budget: limit, note });
    };
    for (const s of b.surfaces) {
      const k = `${s.surface}.${s.renderer}`;
      if (s.surface === 'play') {
        check(`${k}.frameP95Ms`, s.frameMs.p95, budget.playFrameP95Ms, cpuNote);
        check(`${k}.heapMiB`, s.heapMiB ?? undefined, budget.playHeapMiB + budget.editorHeapMiB, 'Play runs inside the editor page: editor + Play budget');
        check(`${k}.drawCalls`, s.drawCalls.p50, budget.playDrawCalls, 'renderer-independent count');
        check(`${k}.gpuMiB`, s.gpuMiBEstimate, budget.gpuMiB, 'estimate from the API calls');
      }
      if (s.surface === 'export') {
        check(`${k}.frameP95Ms`, s.frameMs.p95, budget.playFrameP95Ms, cpuNote);
        check(`${k}.firstFrameMs`, s.load['firstFrameMs'], budget.exportFirstFrameMs, cpuNote);
        check(`${k}.heapMiB`, s.heapMiB ?? undefined, budget.playHeapMiB, 'standalone page');
        check(`${k}.drawCalls`, s.drawCalls.p50, budget.playDrawCalls, 'renderer-independent count');
        check(`${k}.gpuMiB`, s.gpuMiBEstimate, budget.gpuMiB, 'estimate from the API calls');
      }
      if (s.surface === 'editor') {
        check(`${k}.orbitFrameP95Ms`, s.frameMs.p95, budget.editorOrbitFrameP95Ms, cpuNote);
        check(`${k}.firstFrameMs`, s.load['firstFrameMs'], budget.editorFirstFrameMs, cpuNote);
        check(`${k}.heapMiB`, s.heapMiB ?? undefined, budget.editorHeapMiB, 'the whole editor page');
      }
    }
    check('command.p95Ms', b.commandMs?.p95, budget.commandP95Ms, 'shared CPU: see the load average');
    if (b.sim !== undefined && b.sim.ok) {
      check('sim.stepP95Ms', b.sim.stepMs.p95, budget.simStepP95Ms, 'shared CPU: see the load average');
      check('sim.bytesPerStep', b.sim.bytesPerStep.median, budget.simBytesPerStep, 'goal: 0 bytes in the steady step loop');
    }
  }
  return out;
}

export async function runHarness(opts: HarnessOptions): Promise<{ report: Report; path: string }> {
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', stamp);
  const reportsDir = join(PERF_ROOT, 'reports');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  const loadStart = la();
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const cpuMs = cpuCalibration();
  opts.log(`perf: cpu calibration ${cpuMs} ms, load ${loadStart.join(' ')}`);
  const surf: SurfaceOptions = { warmupMs: opts.warmupMs, recordMs: opts.recordMs, viewport: opts.viewport };
  const browsers = new Map<RendererName, Awaited<ReturnType<typeof launch>>>();
  const calibration: Report['calibration'] = { cpuMs, cpuMsEnd: 0, browser: {} };
  const needBrowser = opts.surfaces.some((s) => s !== 'sim');
  try {
    if (needBrowser) {
      for (const r of opts.renderers) {
        const b = await launch(r);
        browsers.set(r, b);
        calibration.browser[r] = await measureCalibration(b, surf);
        opts.log(`perf: browser calibration (${r}) frame mean ${calibration.browser[r]!.frameMs.mean} ms`);
      }
    }
    const benchmarks: Report['benchmarks'] = {};
    for (const cls of opts.classes) {
      const plan = generate(cls, opts.seed);
      const dataRoot = join(runDir, cls);
      const be = await startPerfBackend(dataRoot, join(runDir, `${cls}-exports`));
      const errors: string[] = [];
      let bench: BenchReport;
      try {
        const classCpu = cpuCalibration();
        const build = await buildBenchmark(be, plan, 'bench', opts.log);
        opts.log(`perf: ${cls} built in ${build.ms} ms (${build.commands} commands)`);
        bench = { cpuMs: classCpu, calibration: {}, build, counts: plan.counts, surfaces: [], errors };
        let exportDir: string | null = null;
        if (opts.surfaces.includes('export')) {
          const t = performance.now();
          const res = await be.post('/api/v1/admin/projects/bench/export', {});
          bench.exportMs = Math.round(performance.now() - t);
          if (res.status === 200) exportDir = join(be.exportRoot, String(res.json['outputDir']));
          else errors.push(`export failed: ${JSON.stringify(res.json).slice(0, 300)}`);
        }
        // A block with a transform (never a collider root the player stands on) for the command timing.
        const listed = ((await be.project('bench').query('queryEntities', { limit: 200, offset: 0 }))['entities'] ?? []) as { id: string; components: Record<string, unknown> }[];
        const probe = listed.find((e) => e.components['box'] !== undefined && e.components['collider'] === undefined && e.components['controller'] === undefined)?.id ?? 'light-0001';
        for (const [r, browser] of browsers) {
          bench.calibration[r] = await measureCalibration(browser, surf);
          const attempt = async (what: string, fn: () => Promise<void>): Promise<void> => {
            try {
              await fn();
            } catch (e) {
              errors.push(`${what} (${r}): ${String((e as Error).message ?? e).slice(0, 400)}`);
              opts.log(`perf: ${cls} ${what} (${r}) failed: ${String((e as Error).message ?? e).slice(0, 200)}`);
            }
          };
          const mt = (s: SurfaceResult): string => (s.mainThread !== undefined ? `, main thread ${s.mainThread.taskMsPerFrame} ms/frame (busy ${Math.round(s.mainThread.busyShare * 100)}%)` : '');
          for (const threads of opts.threads) {
            if (opts.surfaces.includes('play')) {
              await attempt(`play threads=${threads}`, async () => {
                const s = await measurePlay(browser, be, 'bench', r, surf, threads);
                bench.surfaces.push(s);
                opts.log(`perf: ${cls} play (${r}, threads=${threads}) frame mean ${s.frameMs.mean} ms p95 ${s.frameMs.p95} ms, ${s.drawCalls.p50} draws${mt(s)}, load ${s.loadavg[0]}`);
              });
            }
            if (opts.surfaces.includes('export') && exportDir !== null) {
              await attempt(`export threads=${threads}`, async () => {
                const s = await measureExport(browser, exportDir!, r, surf, threads);
                bench.surfaces.push(s);
                opts.log(`perf: ${cls} export (${r}, threads=${threads}) first frame ${s.load['firstFrameMs']} ms, frame mean ${s.frameMs.mean} ms${mt(s)}`);
              });
            }
          }
          if (opts.surfaces.includes('editor')) {
            await attempt('editor', async () => {
              // Command round trips once per class (they do not depend on the renderer).
              const commands = bench.commandMs === undefined ? opts.commands : 0;
              const e = await measureEditor(browser, be, 'bench', r, { ...surf, commands, entityId: probe });
              bench.surfaces.push(e.surface);
              if (commands > 0) bench.commandMs = e.commandMs;
              if (e.ops !== undefined) {
                bench.editorOps = e.ops;
                const o = e.ops;
                opts.log(`perf: ${cls} hierarchy ${o.hierarchy.domRows} rows in the DOM (${o.hierarchy.entities} entities), select p50 ${o.hierarchy.selectMs.p50} ms, rename p50 ${o.hierarchy.renameMs.p50} ms, scroll frame mean ${o.hierarchy.scrollFrameMs.mean} ms, scroll step p50 ${o.hierarchy.scrollStepMs.p50} ms`);
                opts.log(`perf: ${cls} command http p50 ${o.command.httpMs.p50} ms, apply→frame p50 ${o.command.applyFrameMs.p50} ms, long tasks ${o.command.longTaskMsPerCommand} ms/cmd, ws ${o.command.wsBytesPerCommand} B/cmd, written ${o.command.bytesWrittenPerCommand} B in ${o.command.filesWrittenPerCommand} files/cmd (wchar ${o.command.wcharPerCommand}), material ws ${o.material?.wsBytes ?? '-'} B${o.notes.length > 0 ? `; notes: ${o.notes.join(' | ')}` : ''}`);
              }
              opts.log(`perf: ${cls} editor (${r}) orbit frame mean ${e.surface.frameMs.mean} ms${commands > 0 ? `, command p95 ${e.commandMs.p95} ms` : ''}`);
            });
          }
        }
      } finally {
        await be.stop();
      }
      if (opts.surfaces.includes('sim')) {
        bench.sim = await runSimChild(join(dataRoot, 'projects', 'bench'), { steps: opts.simSteps });
        if (bench.sim.ok) opts.log(`perf: ${cls} sim step p50 ${bench.sim.stepMs.p50} ms, ${bench.sim.bytesPerStep.median} B/step`);
        else errors.push(`sim: ${bench.sim.error.slice(0, 400)}`);
      }
      benchmarks[cls] = bench;
      if (!opts.keep) {
        rmSync(dataRoot, { recursive: true, force: true });
        rmSync(join(runDir, `${cls}-exports`), { recursive: true, force: true });
      }
    }
    calibration.cpuMsEnd = cpuCalibration();
    const partial = { benchmarks, calibration };
    const { log: _log, ...options } = opts;
    const report: Report = {
      reportVersion: 1,
      startedAt,
      finishedAt: new Date().toISOString(),
      machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30), node: process.version, gpu: 'none: Chromium SwiftShader (CPU) for WebGL 2 and WebGPU', loadavgStart: loadStart, loadavgEnd: la() },
      commit,
      generatorVersion: GENERATOR_VERSION,
      options,
      calibration,
      benchmarks,
      metrics: metricsOf(partial),
      overBudget: overBudget(partial),
    };
    const path = opts.out ?? join(reportsDir, `${stamp}.json`);
    writeFileSync(path, `${JSON.stringify(report, null, 1)}\n`);
    copyFileSync(path, join(reportsDir, 'latest.json'));
    if (!opts.keep) rmSync(runDir, { recursive: true, force: true });
    return { report, path };
  } finally {
    for (const b of browsers.values()) await b.close();
  }
}

/** A baseline: the run's machine-independent metrics and where they came from. */
export function baselineOf(report: Report, note: string): Record<string, unknown> {
  return {
    note,
    recordedAt: report.finishedAt,
    commit: report.commit,
    generatorVersion: report.generatorVersion,
    machine: report.machine,
    classes: report.options.classes,
    renderers: report.options.renderers,
    surfaces: report.options.surfaces,
    metrics: report.metrics,
  };
}

export function readReport(path: string): Report {
  return JSON.parse(readFileSync(path, 'utf8')) as Report;
}

export { summarize };
