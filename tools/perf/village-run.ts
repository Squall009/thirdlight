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
 *                                orbiting the editor's opening view; --no-export skips the export
 *   --ablation                   the per-draw ablation on the plain page: + 16 dark point lights, + per-object
 *                                material copies, + the engine's node materials (each alone)
 *   --gate                       the fast gate's check: frames only (no GPU passes, profile or plain page)
 *   --check FILE                 compare the export's frame time with a recorded baseline: exit 1 when worse than
 *                                FRAME_REGRESSION (a fraction) on any renderer
 *   --write-baseline FILE        record this run's frame times as the baseline
 *   --record-ms N --warmup-ms N --gpu-ms N --profile-ms N --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/<village or the project folder's name>-<time>.json
 * (latest-<name>.json too). tools/perf/games.sh runs it on copies of game projects.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename, join, resolve } from 'node:path';

import * as esbuild from 'esbuild';

import { PERF_ROOT, REPO, startPerfBackend } from './backend';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult, type PageStep } from './frame-run';
import { measureSceneView, sceneViewLine, type SceneViewResult } from './scene-view-run';
import { buildVillage, VILLAGE_SEED, VILLAGE_VERSION, type VillageBuild } from './village';

/** A frame time worse than the baseline by more than this fraction fails the check. */
export const FRAME_REGRESSION = 0.1;

/** The plain page's variants: the default, and the ablation's additions one at a time. */
export const BARE_VARIANTS = {
  bare: '',
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
  bare: Partial<Record<BareVariant, Partial<Record<FrameRenderer, FrameRunResult>>>>;
  /** The editor's Scene view on the same content (`--scene-view`). */
  sceneView?: Partial<Record<FrameRenderer, SceneViewResult>>;
  errors: string[];
}

export interface FrameBaseline {
  note: string;
  recordedAt: string;
  commit: string;
  machine: VillageReport['machine'];
  subject: string;
  version: number;
  /** Export frame time (mean interval, ms) per renderer. */
  frameMeanMs: Partial<Record<FrameRenderer, number>>;
}

/** The comparison the gate makes: renderers whose mean frame time is worse than the baseline by more than `tolerance`. */
export function frameRegressions(base: FrameBaseline, report: Pick<VillageReport, 'export'>, tolerance = FRAME_REGRESSION): { renderer: FrameRenderer; baseline: number; value: number; limit: number }[] {
  const out: { renderer: FrameRenderer; baseline: number; value: number; limit: number }[] = [];
  for (const [r, b] of Object.entries(base.frameMeanMs) as [FrameRenderer, number][]) {
    const got = report.export[r]?.frames.mean;
    const limit = Math.round(b * (1 + tolerance) * 1000) / 1000;
    // A renderer the run did not measure (or that drew nothing) is a failure too: the check proves nothing then.
    if (got === undefined || got <= 0 || got > limit) out.push({ renderer: r, baseline: b, value: got ?? -1, limit });
  }
  return out;
}

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

/** One line per measured page for the log. */
export function frameLine(what: string, r: FrameRunResult): string {
  const gpu = r.gpu === null ? '' : r.gpu.available ? `, gpu ${r.gpu.msPerFrame} ms (${r.gpu.passes.slice(0, 4).map((p) => `${p.label} ${p.msPerFrame}`).join(', ')})` : `, gpu not measured (${r.gpu.note ?? 'no timestamp queries'})`;
  const pk = r.profile === null ? '' : `, main thread: ${r.profile.packages.slice(0, 5).map((p) => `${p.name} ${p.share}%`).join(', ')}`;
  return `${what}: ${r.frames.fps} fps, frame p50/p95/p99 ${r.frames.p50}/${r.frames.p95}/${r.frames.p99} ms, ${r.draws.p50} draws, ${Math.round(r.tris.p50 / 1000)}k tris, ${r.scene.objects} Object3Ds (${r.scene.groups} groups, ${r.scene.lods} LOD, ${r.scene.meshes} meshes of which ${r.scene.hiddenMeshes} hidden, ${r.scene.bones} bones, ${r.scene.pointLights} point lights), ${r.live.uniformBuffers} uniform buffers, main thread ${r.mainThread.taskMsPerFrame} ms/frame (${Math.round(r.mainThread.busyShare * 100)}%)${gpu}${pk}${r.errors.length > 0 ? `; ${r.errors.length} page errors: ${r.errors[0]}` : ''}`;
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
  const bare = !gate && exporting && !has('no-bare');
  const ablation = !gate && has('ablation');

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
    if (sceneView) {
      const browser = await launchGpuBrowser();
      try {
        for (const r of renderers) {
          const res = await measureSceneView(browser, be, projectId, r, { warmupMs, recordMs, shot: join(runDir, `scene-view-${r}.png`) });
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

  const browser = await launchGpuBrowser();
  const dumpDir = join(runDir, 'dump');
  try {
    report.machine.gpu = await gpuName(browser);
    const site = exportDir === null ? null : await serveStatic(exportDir, {}, dumpDir);
    try {
      for (const [i, r] of (site === null ? [] : renderers).entries()) {
        const res = await measurePage(browser, { url: `${site!.url}?renderer=${r}`, warmupMs, recordMs, gpuMs, profileMs, steps, sourceOf: sourcesOf(site!), dump: bare && i === 0, shot: join(runDir, `export-${r}.png`) });
        report.export[r] = res;
        log(frameLine(`export ${r}`, res));
      }
    } finally {
      await site?.close();
    }
    if (bare) {
      const dumped = report.export[renderers[0]!]?.dump;
      if (typeof dumped === 'string' || dumped === undefined || !existsSync(join(dumpDir, 'scene.json'))) report.errors.push(`no scene dump: ${String(dumped)}`);
      else {
        log(`dump: ${dumped.items} drawn items (${dumped.instanced} instanced), ${dumped.geos} geometries, ${dumped.mats} materials, ${Math.round(dumped.bytes / 1048576)} MiB`);
        const engineDir = join(runDir, 'engine');
        if (ablation) await bundleEngineMaterials(join(engineDir, 'materials.js'));
        const page = await serveStatic(join(REPO, 'tools', 'perf', 'bare'), { 'three/': join(REPO, 'node_modules', 'three'), 'scene/': dumpDir, 'engine/': engineDir });
        try {
          const variants = (ablation ? Object.keys(BARE_VARIANTS) : ['bare']) as BareVariant[];
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
    for (const r of renderers) if (report.export[r] !== undefined) frameMeanMs[r] = report.export[r]!.frames.mean;
    const base: FrameBaseline = { note: 'export frame time of the village class (tools/perf/village.ts) on this host\'s GPU: re-record with tools/perf/run.mjs village --gate --write-baseline <this file>', recordedAt: new Date().toISOString(), commit, machine: report.machine, subject: report.subject.name, version: VILLAGE_VERSION, frameMeanMs };
    writeFileSync(write, `${JSON.stringify(base, null, 1)}\n`);
    log(`village: baseline written to ${write}`);
  }
  const check = get('check');
  if (check !== undefined) {
    const base = JSON.parse(readFileSync(check, 'utf8')) as FrameBaseline;
    if (base.version !== VILLAGE_VERSION) log(`village: the baseline is for village version ${base.version}, this is ${VILLAGE_VERSION}: re-record it`);
    if (base.machine.gpu !== report.machine.gpu) log(`village: the baseline was recorded on ${base.machine.gpu}, this host has ${report.machine.gpu}`);
    const bad = frameRegressions(base, report);
    for (const b of bad) log(`village: REGRESSION ${b.renderer} frame ${b.value} ms > ${b.limit} ms (baseline ${b.baseline} ms + ${FRAME_REGRESSION * 100} %)`);
    for (const r of renderers) if (!bad.some((b) => b.renderer === r) && base.frameMeanMs[r] !== undefined) log(`village: ${r} frame ${report.export[r]?.frames.mean} ms (baseline ${base.frameMeanMs[r]} ms, limit ${Math.round(base.frameMeanMs[r]! * (1 + FRAME_REGRESSION) * 1000) / 1000} ms)`);
    if (bad.length > 0 || base.version !== VILLAGE_VERSION) process.exitCode = 1;
  }
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

/** The engine's node materials for the plain page (bare-engine-materials.ts), three left to the page's import map. */
async function bundleEngineMaterials(out: string): Promise<void> {
  await esbuild.build({ entryPoints: [join(REPO, 'tools', 'perf', 'bare-engine-materials.ts')], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: out, external: ['three', 'three/*'], logLevel: 'warning' });
}
