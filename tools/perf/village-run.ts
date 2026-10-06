/**
 * The village measurement (`node tools/perf/run.mjs village …`): the
 * village class (village.ts) built through a private backend and exported,
 * its export measured on both renderers, and the same content as a plain
 * three.js page (tools/perf/bare/, rebuilt from a dump of the export's
 * drawn scene) measured the same way.
 *
 *   --renderers webgpu,webgl2    (default both)
 *   --project <folder>           measure a copy of a game project instead of the village (never the game's own folder:
 *                                the backend writes into what it registers); --steps '<json>' reaches its view
 *   --no-bare                    skip the plain three.js page
 *   --scene-view                 also measure the editor's Scene view on the same content (scene-view-run.ts),
 *                                orbiting the editor's opening view; --no-export skips the export; --orbit F sizes the
 *                                orbit's pointer circle as a fraction of the view's width (default 0.04: a slow look
 *                                round; 0.4 swings the camera across the level)
 *   --ablation                   the per-draw ablation on the plain page: + 16 dark point lights, + per-object
 *                                material copies, + the engine's node materials (each alone)
 *   --first-bare                 also measure the first plain page (`fair=0`: noise textures, no environment
 *                                lighting or grading, skinned meshes at rest) beside the plain page of the same content
 *   --query 'a=b&c=d'            add to the export's and the Scene view's page query (e.g. merging=off to compare)
 *   --switches 'a=off,b=off&c=d' measure the export again with each of these queries in the same browser after its own
 *                                run (one optimization switched off at a time: each one's share of the frame)
 *   --vsync                      draw at the display's rate (a player's browser) instead of uncapped: frame drops
 *                                show as intervals of two refreshes or more
 *   --busy N                     also trace N ms of each export run for busy time per second: the page's main thread, its
 *                                workers and the GPU process (with --vsync and --switches 'frameRateCap=60,frameRateCap=30':
 *                                what a frame-rate cap saves)
 *   --probes                     bake the class's probes in the editor (WebGPU) before the export: the export then
 *                                draws with probe lighting (its cost against a run without)
 *   --gate                       the fast gate's check: frames only (no GPU passes or profile); the plain page is
 *                                measured too and the class's frame reported against it (`plainPageRows`), not gated
 *   --check FILE                 compare the export's frame time with a recorded baseline: exit 1 when the median (the
 *                                mean, for a baseline without one) is worse than FRAME_REGRESSION or the p95 than
 *                                FRAME_P95_REGRESSION (fractions) on any renderer
 *   --write-baseline FILE        record this run's frame times as the baseline
 *   --record-ms N --warmup-ms N --gpu-ms N --profile-ms N --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/<village or the project folder's name>-<time>.json
 * (latest-<name>.json too). tools/perf/games.sh runs it on copies of game projects.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join, resolve } from 'node:path';

import * as esbuild from 'esbuild';

import { PERF_ROOT, REPO, startPerfBackend } from './backend';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult, type PageStep } from './frame-run';
import { bakeProbesInEditor } from './probe-bake-run';
import { measureSceneView, sceneViewLine, type SceneViewResult } from './scene-view-run';
import { FRAME_HISTOGRAM_EDGES_MS } from './stats';
import { buildVillage, VILLAGE_SEED, VILLAGE_VERSION, type VillageBuild } from './village';

/**
 * A median frame time worse than the baseline by more than this fraction fails the check. The median, not the
 * mean: uncapped on WebGL 2 the GPU process stalls 100–300 ms every ~2 s once the frame is fast (about 2 % of
 * the frames, at the display's rate none), so the mean measures how many stalls fell in the window (WebGL 2:
 * mean 7.0–7.2 ms over a 4.0 ms median, run to run) rather than the frame the code costs.
 */
export const FRAME_REGRESSION = 0.1;
/**
 * A 95th-percentile frame time worse than the baseline by more than this fraction fails the check too: the
 * tail catches hitches the mean hides (a compile, a stall every few frames). Generous because, uncapped, the
 * GPU-bound frames on WebGPU are bimodal (a slow mode of a few % around twice the median, on the plain page
 * too), so the p95 moves more between runs than the mean.
 */
export const FRAME_P95_REGRESSION = 0.5;

/** The plain page's variants: the default, and the ablation's additions one at a time. */
export const BARE_VARIANTS = {
  bare: '',
  first: 'fair=0',
  'dark-lights': 'lights=16',
  'material-copies': 'copies=1',
  'node-materials': 'nodemat=1',
} as const;
export type BareVariant = keyof typeof BARE_VARIANTS;

export interface VillageReport {
  reportVersion: 1;
  kind: 'village' | 'project';
  startedAt: string;
  commit: string;
  machine: { cpu: string; cores: number; gpu: string };
  subject: { name: string; version?: number; seed?: number; build?: VillageBuild; exportMs?: number };
  export: Partial<Record<FrameRenderer, FrameRunResult>>;
  /** `--probes`: the probe bake before the export. */
  probes?: Record<string, unknown>;
  bare: Partial<Record<BareVariant, Partial<Record<FrameRenderer, FrameRunResult>>>>;
  /** The editor's Scene view on the same content (`--scene-view`). */
  sceneView?: Partial<Record<FrameRenderer, SceneViewResult>>;
  /** The export with each `--switches` query added, per query. */
  switches?: Record<string, Partial<Record<FrameRenderer, FrameRunResult>>>;
  errors: string[];
}

export interface FrameBaseline {
  note: string;
  recordedAt: string;
  commit: string;
  machine: VillageReport['machine'];
  subject: string;
  version: number;
  /** Export frame time (mean interval, ms) per renderer: checked only when the baseline has no median. */
  frameMeanMs: Partial<Record<FrameRenderer, number>>;
  /** Export median frame time (ms) per renderer (absent in older baselines: the mean is checked). */
  frameP50Ms?: Partial<Record<FrameRenderer, number>>;
  /** Export 95th-percentile frame time (ms) per renderer (absent in older baselines: not checked). */
  frameP95Ms?: Partial<Record<FrameRenderer, number>>;
}

export interface FrameRegression {
  renderer: FrameRenderer;
  metric: 'mean' | 'p50' | 'p95';
  baseline: number;
  value: number;
  limit: number;
}

/** The comparison the gate makes: renderers whose mean (or p95) frame time is worse than the baseline by more than the tolerance. */
export function frameRegressions(base: FrameBaseline, report: Pick<VillageReport, 'export'>, tolerance = FRAME_REGRESSION, p95Tolerance = FRAME_P95_REGRESSION): FrameRegression[] {
  const out: FrameRegression[] = [];
  const check = (metric: FrameRegression['metric'], values: FrameBaseline['frameMeanMs'], tol: number): void => {
    for (const [r, b] of Object.entries(values) as [FrameRenderer, number][]) {
      const got = report.export[r]?.frames[metric];
      const limit = frameLimit(b, tol);
      // A renderer the run did not measure (or that drew nothing) is a failure too: the check proves nothing then.
      if (got === undefined || got <= 0 || got > limit) out.push({ renderer: r, metric, baseline: b, value: got ?? -1, limit });
    }
  };
  if (base.frameP50Ms !== undefined) check('p50', base.frameP50Ms, tolerance);
  else check('mean', base.frameMeanMs, tolerance);
  if (base.frameP95Ms !== undefined) check('p95', base.frameP95Ms, p95Tolerance);
  return out;
}

const frameLimit = (baseline: number, tolerance: number): number => Math.round(baseline * (1 + tolerance) * 1000) / 1000;

export interface AblationRow {
  renderer: FrameRenderer;
  variant: BareVariant;
  frameMs: number;
  /** Against the plain page without the addition (same renderer). */
  deltaMs: number;
  gpuMs: number | null;
  draws: number;
  /** The added frame time spread over the plain page's draws (µs). */
  usPerDraw: number;
}

/** The class against the plain page of the same content, per renderer (median frame time; lower is faster). */
export interface PlainPageRow {
  readonly renderer: FrameRenderer;
  readonly classP50Ms: number;
  readonly plainP50Ms: number;
  readonly classFps: number;
  readonly plainFps: number;
  /** Percent the class's median frame is shorter than the plain page's (negative: the plain page is faster). */
  readonly aheadPercent: number;
}

/**
 * The done-bar of the performance phase as a number: the class's export
 * against the plain three.js page drawing the same content, measured the
 * same way. Reported by the fast gate's perf check, never failing it
 * (whether it should is the owner's call).
 */
export function plainPageRows(report: Pick<VillageReport, 'export' | 'bare'>): PlainPageRow[] {
  const out: PlainPageRow[] = [];
  for (const [renderer, c] of Object.entries(report.export) as [FrameRenderer, FrameRunResult | undefined][]) {
    const p = report.bare.bare?.[renderer];
    if (c === undefined || p === undefined) continue;
    out.push({ renderer, classP50Ms: c.frames.p50, plainP50Ms: p.frames.p50, classFps: c.frames.fps, plainFps: p.frames.fps, aheadPercent: Math.round(((p.frames.p50 - c.frames.p50) / p.frames.p50) * 1000) / 10 });
  }
  return out;
}

/** Each ablation step's cost against the plain page: frame time added, and per draw. */
export function ablationRows(report: Pick<VillageReport, 'bare'>): AblationRow[] {
  const rows: AblationRow[] = [];
  for (const [variant, byRenderer] of Object.entries(report.bare) as [BareVariant, Partial<Record<FrameRenderer, FrameRunResult>>][]) {
    for (const [renderer, r] of Object.entries(byRenderer) as [FrameRenderer, FrameRunResult][]) {
      const base = report.bare.bare?.[renderer];
      if (base === undefined) continue;
      const delta = r.frames.mean - base.frames.mean;
      const draws = base.draws.p50;
      rows.push({ renderer, variant, frameMs: r.frames.mean, deltaMs: Math.round(delta * 1000) / 1000, gpuMs: r.gpu?.available === true ? r.gpu.msPerFrame : null, draws: r.draws.p50, usPerDraw: draws > 0 ? Math.round((delta * 1000 * 100) / draws) / 100 : 0 });
    }
  }
  return rows;
}

const flagOf = (argv: readonly string[]) => (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** The frame histogram for the log: share of frames per bucket, in percent. */
const hist = (h: readonly number[] | undefined): string => {
  if (h === undefined) return '';
  const e = FRAME_HISTOGRAM_EDGES_MS;
  const names = h.map((_, i) => (i === 0 ? `<${e[0]}` : i === e.length ? `≥${e[e.length - 1]}` : `${e[i - 1]}–${e[i]}`));
  return ` (${h.map((v, i) => `${names[i]}: ${Math.round(v * 1000) / 10}%`).join(', ')})`;
};

/** One line per measured page for the log. */
export function frameLine(what: string, r: FrameRunResult): string {
  const gpu = r.gpu === null ? '' : r.gpu.available ? `, gpu ${r.gpu.msPerFrame} ms (${r.gpu.passes.slice(0, 4).map((p) => `${p.label} ${p.msPerFrame}`).join(', ')})` : `, gpu not measured (${r.gpu.note ?? 'no timestamp queries'})`;
  const pk = r.profile === null ? '' : `, main thread: ${r.profile.packages.slice(0, 5).map((p) => `${p.name} ${p.share}%`).join(', ')}`;
  return `${what}: ${r.frames.fps} fps, frame p50/p95/p99/max ${r.frames.p50}/${r.frames.p95}/${r.frames.p99}/${r.frames.max ?? '-'} ms${hist(r.frames.histogram)}, ${r.draws.p50} draws (scene ${r.scene.passDraws?.scene ?? '-'}, shadow ${r.scene.passDraws?.shadow ?? '-'}, post ${r.scene.passDraws?.post ?? '-'}; shadow per frame mean/p95/max ${r.scene.shadowDraws?.mean ?? '-'}/${r.scene.shadowDraws?.p95 ?? '-'}/${r.scene.shadowDraws?.max ?? '-'}), ${Math.round(r.tris.p50 / 1000)}k tris, ${r.scene.objects} Object3Ds (${r.scene.groups} groups, ${r.scene.lods} LOD, ${r.scene.meshes} meshes of which ${r.scene.hiddenMeshes} hidden, ${r.scene.bones} bones, ${r.scene.pointLights} point lights)${r.scene.merged !== undefined && r.scene.merged.meshes > 0 ? `, ${r.scene.merged.shown}/${r.scene.merged.meshes} merged cells drawn (${Math.round((r.scene.merged.vertexBytes + r.scene.merged.indexBytes) / 1024)} KiB)` : ''}${r.scene.lod !== undefined ? `, ${r.scene.lod.copiesInView} instance copies drawn, LOD switches ${r.scene.lod.switches} models/${r.scene.lod.copySwitches} copies last frame` : ''}, ${r.live.uniformBuffers} uniform buffers${r.gpuCalls ? `, per frame ${r.gpuCalls.renderPasses} render/${r.gpuCalls.computePasses} compute passes, ${r.gpuCalls.setPipeline} pipeline and ${r.gpuCalls.setBindGroup} bind-group sets, ${r.gpuCalls.createBindGroup} bind groups made, ${r.gpuCalls.writeBuffer} buffer writes (${Math.round(r.gpuCalls.writeBufferBytes / 1024)} KiB), ${r.gpuCalls.textureUploads} texture uploads, ${r.gpuCalls.submits} submits` : ''}${r.shaders ? `, ${r.shaders.distinct} shader modules (${Math.round(r.shaders.totalChars / 1024)} KiB WGSL, largest ${Math.round(r.shaders.maxChars / 1024)} KiB)` : ''}, ${r.live.pipelines} pipelines, main thread ${r.mainThread.taskMsPerFrame} ms/frame (${Math.round(r.mainThread.busyShare * 100)}%)${gpu}${pk}${r.errors.length > 0 ? `; ${r.errors.length} page errors: ${r.errors[0]}` : ''}`;
}

/** Busy time per second (`--busy`): drawn frames, the page's main thread (untraced, and traced), workers, GPU process. */
export function busyLine(what: string, r: FrameRunResult): string {
  const b = r.busy!;
  const main = Math.round(r.mainThread.busyShare * 1000);
  return `${what}: ${b.fps} drawn fps, main thread ${main} ms/s untraced (${b.mainMsPerS} traced), workers ${b.workerMsPerS} ms/s, GPU process ${b.gpuProcessMsPerS} ms/s (${b.seconds} s traced)`;
}

export async function runVillageCli(argv: readonly string[]): Promise<void> {
  const get = flagOf(argv);
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const log = (s: string): void => console.log(s);
  const gate = has('gate');
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  for (const r of renderers) if (r !== 'webgpu' && r !== 'webgl2') throw new Error(`--renderers: webgpu or webgl2, not ${r}`);
  const recordMs = Number(get('record-ms') ?? (gate ? 6000 : 10000));
  const warmupMs = Number(get('warmup-ms') ?? (gate ? 2000 : 3000));
  const gpuMs = gate ? 0 : Number(get('gpu-ms') ?? 3000);
  const profileMs = gate ? 0 : Number(get('profile-ms') ?? 5000);
  const projectFolder = get('project');
  const steps = JSON.parse(get('steps') ?? '[]') as PageStep[];
  const sceneView = !gate && has('scene-view');
  const exporting = !has('no-export');
  const bare = exporting && !has('no-bare');
  const ablation = !gate && has('ablation');
  const query = get('query') !== undefined ? `&${get('query')}` : '';
  const switches = gate ? [] : (get('switches') ?? '').split(',').filter((x) => x !== '');
  const busyMs = gate ? 0 : Number(get('busy') ?? 0);

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `village-${stamp}`);
  const reportsDir = join(PERF_ROOT, 'reports');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const report: VillageReport = {
    reportVersion: 1,
    kind: projectFolder === undefined ? 'village' : 'project',
    startedAt,
    commit,
    machine: { cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, gpu: 'unknown' },
    subject: projectFolder === undefined ? { name: 'village', version: VILLAGE_VERSION, seed: VILLAGE_SEED } : { name: basename(resolve(projectFolder)) },
    export: {},
    bare: {},
    errors: [],
  };

  // ---- the export -------------------------------------------------------------------
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  let exportDir: string | null = null;
  try {
    let projectId = 'village';
    if (projectFolder === undefined) {
      report.subject.build = await buildVillage(be, projectId, undefined, log);
      log(`village: built in ${report.subject.build.ms} ms (${report.subject.build.commands} commands)`);
    } else {
      const reg = await be.post('/api/v1/admin/projects/register', { folder: resolve(projectFolder) });
      if (typeof reg.json['projectId'] !== 'string') throw new Error(`register failed: ${JSON.stringify(reg.json).slice(0, 400)}`);
      projectId = reg.json['projectId'];
    }
    if (has('probes')) report.probes = await bakeProbesInEditor(be, projectId, log);
    if (sceneView) {
      const browser = await launchGpuBrowser({ vsync: has('vsync') });
      try {
        for (const r of renderers) {
          const res = await measureSceneView(browser, be, projectId, r, { warmupMs, recordMs, query, shot: join(runDir, `scene-view-${r}.png`), ...(get('orbit') !== undefined ? { orbit: Number(get('orbit')) } : {}) });
          (report.sceneView ??= {})[r] = res;
          log(sceneViewLine(`scene view ${r}`, res));
        }
      } finally {
        await browser.close();
      }
    }
    if (exporting) {
      const t = performance.now();
      const res = await be.post(`/api/v1/admin/projects/${projectId}/export`, {});
      if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
      report.subject.exportMs = Math.round(performance.now() - t);
      exportDir = join(be.exportRoot, String(res.json['outputDir']));
    }
  } finally {
    await be.stop();
  }

  const browser = await launchGpuBrowser({ vsync: has('vsync') });
  const dumpDir = join(runDir, 'dump');
  try {
    report.machine.gpu = await gpuName(browser);
    const site = exportDir === null ? null : await serveStatic(exportDir, {}, dumpDir);
    try {
      for (const [i, r] of (site === null ? [] : renderers).entries()) {
        const res = await measurePage(browser, { url: `${site!.url}?renderer=${r}${query}`, warmupMs, recordMs, gpuMs, profileMs, steps, sourceOf: sourcesOf(site!), dump: bare && i === 0, shot: join(runDir, `export-${r}.png`), busyMs });
        report.export[r] = res;
        log(frameLine(`export ${r}`, res));
        if (res.busy !== undefined) log(busyLine(`busy ${r}`, res));
        for (const sw of switches) {
          const off = await measurePage(browser, { url: `${site!.url}?renderer=${r}${query}&${sw}`, warmupMs, recordMs, gpuMs, profileMs: 0, steps, sourceOf: sourcesOf(site!), shot: join(runDir, `export-${r}-${sw.replace(/[^a-z0-9]+/gi, '_')}.png`), busyMs });
          ((report.switches ??= {})[sw] ??= {})[r] = off;
          log(frameLine(`export ${r} ${sw}`, off));
          if (off.busy !== undefined) log(busyLine(`busy ${r} ${sw}`, off));
          log(`switch ${r} ${sw}: ${off.frames.fps} fps (on ${res.frames.fps}), p50 ${off.frames.p50} ms (on ${res.frames.p50}), main thread ${off.mainThread.taskMsPerFrame} ms (on ${res.mainThread.taskMsPerFrame}), draws ${off.draws.p50} (on ${res.draws.p50})`);
        }
      }
    } finally {
      await site?.close();
    }
    if (bare) {
      const dumped = report.export[renderers[0]!]?.dump;
      if (typeof dumped === 'string' || dumped === undefined || !existsSync(join(dumpDir, 'scene.json'))) report.errors.push(`no scene dump: ${String(dumped)}`);
      else {
        log(`dump: ${dumped.items} drawn items (${dumped.instanced} instanced), ${dumped.geos} geometries, ${dumped.mats} materials, ${Math.round(dumped.bytes / 1048576)} MiB`);
        const post = postSettingsOf(exportDir!);
        if (post !== null) writeFileSync(join(dumpDir, 'post.json'), JSON.stringify(post));
        log(`dump: ${dumped.textures} textures, ${dumped.skeletons} skeletons, environment ${dumped.environment ? 'yes' : 'no'}, post ${post === null ? 'none' : JSON.stringify(post)}`);
        const engineDir = join(runDir, 'engine');
        if (ablation) await bundleEngineMaterials(join(engineDir, 'materials.js'));
        const page = await serveStatic(join(REPO, 'tools', 'perf', 'bare'), { 'three/': join(REPO, 'node_modules', 'three'), 'scene/': dumpDir, 'engine/': engineDir });
        try {
          const variants = (ablation ? Object.keys(BARE_VARIANTS).filter((v) => v !== 'first') : ['bare']) as BareVariant[];
          if (has('first-bare')) variants.push('first');
          for (const v of variants) {
            for (const r of renderers) {
              const q = [`renderer=${r}`, BARE_VARIANTS[v]].filter((x) => x !== '').join('&');
              const res = await measurePage(browser, { url: `${page.url}?${q}`, warmupMs, recordMs, gpuMs, profileMs: v === 'bare' ? profileMs : 0, sourceOf: sourcesOf(page), shot: join(runDir, `bare-${v}-${r}.png`) });
              (report.bare[v] ??= {})[r] = res;
              log(frameLine(`plain three.js ${v} ${r}`, res));
            }
          }
        } finally {
          await page.close();
        }
        if (ablation) for (const row of ablationRows(report)) log(`ablation ${row.renderer} ${row.variant}: frame ${row.frameMs} ms (${row.deltaMs >= 0 ? '+' : ''}${row.deltaMs} ms), gpu ${row.gpuMs ?? '-'} ms, ${row.draws} draws: ${row.usPerDraw >= 0 ? '+' : ''}${row.usPerDraw} µs per draw`);
      }
    }
  } finally {
    await browser.close();
  }

  const out = get('out') ?? join(reportsDir, `${report.subject.name}-${stamp}.json`);
  writeFileSync(out, `${JSON.stringify(report, null, 1)}\n`);
  copyFileSync(out, join(reportsDir, `latest-${report.subject.name}.json`));
  log(`village: report ${out}${has('keep') ? `, run folder ${runDir}` : ''}`);
  if (!has('keep')) rmSync(runDir, { recursive: true, force: true });

  const write = get('write-baseline');
  if (write !== undefined) {
    const frameMeanMs: FrameBaseline['frameMeanMs'] = {};
    const frameP50Ms: NonNullable<FrameBaseline['frameP50Ms']> = {};
    const frameP95Ms: NonNullable<FrameBaseline['frameP95Ms']> = {};
    for (const r of renderers) {
      if (report.export[r] === undefined) continue;
      frameMeanMs[r] = report.export[r]!.frames.mean;
      frameP50Ms[r] = report.export[r]!.frames.p50;
      frameP95Ms[r] = report.export[r]!.frames.p95;
    }
    const base: FrameBaseline = { note: 'export frame time of the village class (tools/perf/village.ts) on this host\'s GPU: re-record with tools/perf/run.mjs village --gate --write-baseline <this file>', recordedAt: new Date().toISOString(), commit, machine: report.machine, subject: report.subject.name, version: VILLAGE_VERSION, frameMeanMs, frameP50Ms, frameP95Ms };
    writeFileSync(write, `${JSON.stringify(base, null, 1)}\n`);
    log(`village: baseline written to ${write}`);
  }
  const check = get('check');
  if (check !== undefined) {
    const base = JSON.parse(readFileSync(check, 'utf8')) as FrameBaseline;
    if (base.version !== VILLAGE_VERSION) log(`village: the baseline is for village version ${base.version}, this is ${VILLAGE_VERSION}: re-record it`);
    if (base.machine.gpu !== report.machine.gpu) log(`village: the baseline was recorded on ${base.machine.gpu}, this host has ${report.machine.gpu}`);
    const bad = frameRegressions(base, report);
    for (const b of bad) log(`village: REGRESSION ${b.renderer} frame ${b.metric} ${b.value} ms > ${b.limit} ms (baseline ${b.baseline} ms + ${(b.metric === 'p95' ? FRAME_P95_REGRESSION : FRAME_REGRESSION) * 100} %)`);
    const median = base.frameP50Ms !== undefined;
    for (const r of renderers) {
      const b = median ? base.frameP50Ms![r] : base.frameMeanMs[r];
      if (bad.some((x) => x.renderer === r) || b === undefined) continue;
      const p95 = base.frameP95Ms?.[r];
      const f = report.export[r]?.frames;
      log(`village: ${r} frame ${median ? 'p50' : 'mean'} ${median ? f?.p50 : f?.mean} ms (baseline ${b} ms, limit ${frameLimit(b, FRAME_REGRESSION)} ms; mean ${f?.mean} ms)${p95 !== undefined ? `, p95 ${f?.p95} ms (baseline ${p95} ms, limit ${frameLimit(p95, FRAME_P95_REGRESSION)} ms)` : ''}`);
    }
    if (bad.length > 0 || base.version !== VILLAGE_VERSION) process.exitCode = 1;
  }
  for (const row of plainPageRows(report)) log(`village: plain page ${row.renderer}: class p50 ${row.classP50Ms} ms (${row.classFps} fps) vs plain three.js ${row.plainP50Ms} ms (${row.plainFps} fps): class ${row.aheadPercent >= 0 ? `${row.aheadPercent} % ahead` : `${-row.aheadPercent} % behind`} (reported, not gated)`);
  for (const e of report.errors) log(`village: error: ${e}`);
}

/** The WebGPU adapter's description (vendor and architecture), for the report and the baseline. */
async function gpuName(browser: import('@playwright/test').Browser): Promise<string> {
  const site = await serveStatic(join(REPO, 'tools', 'perf', 'bare'));
  const page = await browser.newPage();
  try {
    await page.goto(`${site.url}gpu.html`).catch(() => undefined);
    return await page.evaluate(async () => {
      const a = await (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu?.requestAdapter();
      const i = a?.info;
      return i === undefined ? 'no WebGPU adapter' : [i.vendor, i.architecture, i.description].filter((x) => x !== undefined && x !== '').join(' ');
    });
  } finally {
    await page.close();
    await site.close();
  }
}

/**
 * The post settings the plain page draws with: the exported scene's environment (`environment.post`). The scene
 * with the most entities is the one measured (a game's title scene is small), which holds for the village and
 * the game copies' default views.
 */
function postSettingsOf(exportDir: string): Record<string, unknown> | null {
  const dir = join(exportDir, 'scenes');
  if (!existsSync(dir)) return null;
  let best: { n: number; post: Record<string, unknown> | null } = { n: -1, post: null };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(join(dir, f), 'utf8')) as { entities?: unknown[]; environment?: { post?: Record<string, unknown> } };
    const n = doc.entities?.length ?? 0;
    if (n > best.n) best = { n, post: doc.environment?.post ?? null };
  }
  return best.post;
}

/** The engine's node materials for the plain page (bare-engine-materials.ts), three left to the page's import map. */
async function bundleEngineMaterials(out: string): Promise<void> {
  await esbuild.build({ entryPoints: [join(REPO, 'tools', 'perf', 'bare-engine-materials.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: out, external: ['three', 'three/*'], logLevel: 'warning' });
}
