/**
 * The level-building measurement (`node tools/perf/run.mjs level …`): the
 * level classes (level.ts) built through a private backend, exported, and
 * each export measured like the village (frame-run.ts: 1920×1080 at DPR 1,
 * uncapped, the host's GPU, frame p50/p95/p99, draws, main-thread time, GPU
 * time per render pass, a CPU profile split by package), on both renderers.
 * The log ends with each class against the soft frame target and what the
 * landscape's far part adds to the area.
 *
 *   --classes area,landscape     (default both)
 *   --renderers webgpu,webgl2    (default both)
 *   --query 'a=b&c=d'            add to the export's page query
 *   --switches 'a=off,b=off'     measure each export again with each query added (one switch at a time)
 *   --record-ms N --warmup-ms N --gpu-ms N --profile-ms N --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/level-<time>.json (latest-level.json too).
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';

import { PERF_ROOT, REPO, startPerfBackend } from './backend';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult } from './frame-run';
import { buildLevel, levelPlan, LEVEL_KINDS, LEVEL_SEED, LEVEL_VERSION, type LevelBuild, type LevelKind } from './level';
import { frameLine } from './village-run';

/** The soft whole-frame target (ms): 60 fps, on the frame interval's p95, the GPU's time and the main thread's. */
export const LEVEL_FRAME_TARGET_MS = 16.7;

export interface LevelReport {
  reportVersion: 1;
  startedAt: string;
  commit: string;
  machine: { cpu: string; cores: number };
  version: number;
  seed: number;
  query: string;
  builds: Partial<Record<LevelKind, LevelBuild & { exportMs: number }>>;
  classes: Partial<Record<LevelKind, Partial<Record<FrameRenderer, FrameRunResult>>>>;
  switches?: Partial<Record<LevelKind, Record<string, Partial<Record<FrameRenderer, FrameRunResult>>>>>;
  errors: string[];
}

export interface LevelTargetRow {
  kind: LevelKind;
  renderer: FrameRenderer;
  p50: number;
  p95: number;
  p99: number;
  /** GPU time per frame over the render passes (null: the renderer gave no timestamps). */
  gpuMs: number | null;
  mainThreadMs: number;
  draws: number;
  /** Each measure within the target (a null GPU time counts as not shown, not as a miss). */
  within: { p95: boolean; gpu: boolean | null; mainThread: boolean };
}

/** Each measured class and renderer against the whole-frame target. */
export function levelTargetRows(report: Pick<LevelReport, 'classes'>, target = LEVEL_FRAME_TARGET_MS): LevelTargetRow[] {
  const rows: LevelTargetRow[] = [];
  for (const kind of LEVEL_KINDS) {
    for (const [renderer, r] of Object.entries(report.classes[kind] ?? {}) as [FrameRenderer, FrameRunResult][]) {
      const gpuMs = r.gpu?.available === true ? r.gpu.msPerFrame : null;
      rows.push({ kind, renderer, p50: r.frames.p50, p95: r.frames.p95, p99: r.frames.p99, gpuMs, mainThreadMs: r.mainThread.taskMsPerFrame, draws: r.draws.p50, within: { p95: r.frames.p95 <= target, gpu: gpuMs === null ? null : gpuMs <= target, mainThread: r.mainThread.taskMsPerFrame <= target } });
    }
  }
  return rows;
}

export interface FarCostRow {
  renderer: FrameRenderer;
  p50Ms: number;
  p95Ms: number;
  gpuMs: number | null;
  mainThreadMs: number;
  draws: number;
}

/** What the landscape adds to the area (landscape minus area), per renderer measured in both. */
export function farCostRows(report: Pick<LevelReport, 'classes'>): FarCostRow[] {
  const out: FarCostRow[] = [];
  const d = (a: number, b: number): number => Math.round((a - b) * 100) / 100;
  for (const [renderer, l] of Object.entries(report.classes.landscape ?? {}) as [FrameRenderer, FrameRunResult][]) {
    const a = report.classes.area?.[renderer];
    if (a === undefined) continue;
    const gl = l.gpu?.available === true ? l.gpu.msPerFrame : null;
    const ga = a.gpu?.available === true ? a.gpu.msPerFrame : null;
    out.push({ renderer, p50Ms: d(l.frames.p50, a.frames.p50), p95Ms: d(l.frames.p95, a.frames.p95), gpuMs: gl === null || ga === null ? null : d(gl, ga), mainThreadMs: d(l.mainThread.taskMsPerFrame, a.mainThread.taskMsPerFrame), draws: l.draws.p50 - a.draws.p50 });
  }
  return out;
}

const flagOf = (argv: readonly string[]) => (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

export async function runLevelCli(argv: readonly string[]): Promise<void> {
  const get = flagOf(argv);
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const log = (s: string): void => console.log(s);
  const kinds = (get('classes') ?? LEVEL_KINDS.join(',')).split(',') as LevelKind[];
  for (const k of kinds) if (!LEVEL_KINDS.includes(k)) throw new Error(`--classes: ${LEVEL_KINDS.join(' or ')}, not ${k}`);
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  for (const r of renderers) if (r !== 'webgpu' && r !== 'webgl2') throw new Error(`--renderers: webgpu or webgl2, not ${r}`);
  const recordMs = Number(get('record-ms') ?? 10000);
  const warmupMs = Number(get('warmup-ms') ?? 3000);
  const gpuMs = Number(get('gpu-ms') ?? 3000);
  const profileMs = Number(get('profile-ms') ?? 5000);
  const query = get('query') !== undefined ? `&${get('query')}` : '';
  const switches = (get('switches') ?? '').split(',').filter((x) => x !== '');

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `level-${stamp}`);
  const reportsDir = join(PERF_ROOT, 'reports');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const report: LevelReport = { reportVersion: 1, startedAt, commit, machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length }, version: LEVEL_VERSION, seed: LEVEL_SEED, query, builds: {}, classes: {}, errors: [] };

  // Every class built and exported by one backend, then measured with it stopped (one backend or one browser at a time).
  const exportDirs: Partial<Record<LevelKind, string>> = {};
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  try {
    for (const kind of kinds) {
      const b = await buildLevel(be, `level-${kind}`, levelPlan(kind), log);
      const t = performance.now();
      const res = await be.post(`/api/v1/admin/projects/${b.projectId}/export`, {});
      if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
      report.builds[kind] = { ...b, exportMs: Math.round(performance.now() - t) };
      exportDirs[kind] = join(be.exportRoot, String(res.json['outputDir']));
      log(`level ${kind}: built in ${b.ms} ms (${b.commands} commands), exported in ${report.builds[kind]!.exportMs} ms`);
    }
  } finally {
    await be.stop();
  }

  const browser = await launchGpuBrowser();
  try {
    for (const kind of kinds) {
      const site = await serveStatic(exportDirs[kind]!);
      try {
        for (const r of renderers) {
          const res = await measurePage(browser, { url: `${site.url}?renderer=${r}${query}`, warmupMs, recordMs, gpuMs, profileMs, sourceOf: sourcesOf(site), shot: join(runDir, `${kind}-${r}.png`) });
          (report.classes[kind] ??= {})[r] = res;
          log(frameLine(`level ${kind} ${r}`, res));
          for (const sw of switches) {
            const off = await measurePage(browser, { url: `${site.url}?renderer=${r}${query}&${sw}`, warmupMs, recordMs, gpuMs, profileMs: 0, sourceOf: sourcesOf(site) });
            (((report.switches ??= {})[kind] ??= {})[sw] ??= {})[r] = off;
            log(frameLine(`level ${kind} ${r} ${sw}`, off));
          }
        }
      } finally {
        await site.close();
      }
    }
  } finally {
    await browser.close();
  }

  const out = get('out') ?? join(reportsDir, `level-${stamp}.json`);
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  copyFileSync(out, join(reportsDir, 'latest-level.json'));
  log(`level: report ${out}${has('keep') ? `, run folder ${runDir}` : ''}`);
  if (!has('keep')) rmSync(runDir, { recursive: true, force: true });

  const ok = (b: boolean | null): string => (b === null ? 'not shown' : b ? 'within' : 'over');
  for (const row of levelTargetRows(report)) {
    log(`level ${row.kind} ${row.renderer}: frame p50/p95/p99 ${row.p50}/${row.p95}/${row.p99} ms (p95 ${ok(row.within.p95)} ${LEVEL_FRAME_TARGET_MS} ms), gpu ${row.gpuMs ?? '-'} ms (${ok(row.within.gpu)}), main thread ${row.mainThreadMs} ms (${ok(row.within.mainThread)}), ${row.draws} draws`);
  }
  for (const row of farCostRows(report)) log(`level far part ${row.renderer} (landscape − area): p50 ${row.p50Ms} ms, p95 ${row.p95Ms} ms, gpu ${row.gpuMs ?? '-'} ms, main thread ${row.mainThreadMs} ms, ${row.draws} draws`);
  for (const e of report.errors) log(`level: error: ${e}`);
  for (const [kind, byR] of Object.entries(report.classes)) for (const [r, res] of Object.entries(byR ?? {})) for (const e of res?.errors.slice(0, 3) ?? []) log(`level ${kind} ${r}: page error: ${e}`);
}
