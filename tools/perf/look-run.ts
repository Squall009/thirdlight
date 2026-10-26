/**
 * The look-reference scenes measured and photographed (`node tools/perf/run.mjs
 * look …`): each scene of look.ts built through a private backend, its
 * lighting baked in the editor on the host's GPU ("Bake preview" for the
 * lightmaps, then "Bake probes", both timed), exported, and the export
 * measured like the level classes (frame-run.ts: 1920×1080 at DPR 1, the
 * host's GPU, always at the display's 60 Hz cap) with a screenshot per
 * renderer.
 *
 *   --scenes door,sunset,corridor,sign   (default all four)
 *   --renderers webgpu,webgl2            (default both)
 *   --no-bake                            the lights realtime, nothing baked (default: the lights baked, then baked)
 *   --cache-view                         draw the surface cache's texels (`?surfaceCacheView=1`): what the live light wrote
 *   --shots DIR                          where the screenshots go (default the run folder, kept with --keep)
 *   --shot-prefix P                      screenshot names `<P><scene>-<renderer>.jpg` (default none)
 *   --record-ms N --warmup-ms N --gpu-ms N --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/look-<time>.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERF_ROOT, REPO, startPerfBackend } from './backend';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult } from './frame-run';
import { buildLook, LOOK_PLANS, LOOK_SCENES, type LookScene } from './look';
import { bakeProbesInEditor } from './probe-bake-run';
import { frameLine } from './village-run';

interface LookReport {
  startedAt: string;
  commit: string;
  bake: boolean;
  scenes: Partial<Record<LookScene, { build: { ms: number; commands: number }; bake?: Record<string, unknown>; exportMs: number; runs: Partial<Record<FrameRenderer, FrameRunResult>>; shots: Partial<Record<FrameRenderer, string>> }>>;
}

export async function runLookCli(argv: readonly string[]): Promise<void> {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scenes = (get('scenes') ?? LOOK_SCENES.join(',')).split(',') as LookScene[];
  for (const s of scenes) if (!(LOOK_SCENES as readonly string[]).includes(s)) throw new Error(`look: unknown scene ${s} (${LOOK_SCENES.join(', ')})`);
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  const bake = !argv.includes('--no-bake');
  const recordMs = Number(get('record-ms') ?? 10000);
  const warmupMs = Number(get('warmup-ms') ?? 3000);
  const gpuMs = Number(get('gpu-ms') ?? 3000);
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `look-${stamp}`);
  const shots = get('shots') ?? runDir;
  const prefix = get('shot-prefix') ?? '';
  mkdirSync(runDir, { recursive: true });
  mkdirSync(shots, { recursive: true });
  const log = (s: string): void => console.log(`look: ${s}`);
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const report: LookReport = { startedAt, commit, bake, scenes: {} };
  const exportDirs: Partial<Record<LookScene, string>> = {};

  // Built, baked and exported with the backend running, then measured with it stopped (one backend or one browser at a time).
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  try {
    for (const scene of scenes) {
      const projectId = `look-${scene}`;
      const build = await buildLook(be, projectId, scene, bake ? 'baked' : 'realtime');
      log(`${scene}: built in ${build.ms} ms (${build.commands} commands); shows ${LOOK_PLANS[scene].shows}`);
      const baked = bake ? await bakeProbesInEditor(be, projectId, (s) => log(`${scene}: ${s}`), { lightmap: true }) : undefined;
      const t = performance.now();
      const res = await be.post(`/api/v1/admin/projects/${projectId}/export`, {});
      if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
      exportDirs[scene] = join(be.exportRoot, String(res.json['outputDir']));
      report.scenes[scene] = { build, ...(baked !== undefined ? { bake: baked } : {}), exportMs: Math.round(performance.now() - t), runs: {}, shots: {} };
    }
  } finally {
    await be.stop();
  }

  const browser = await launchGpuBrowser({ vsync: true });
  try {
    for (const scene of scenes) {
      const site = await serveStatic(exportDirs[scene]!);
      try {
        for (const r of renderers) {
          const shot = join(shots, `${prefix}${scene}-${r}.jpg`);
          const res = await measurePage(browser, { url: `${site.url}?renderer=${r}${argv.includes('--cache-view') ? '&surfaceCacheView=1' : ''}`, warmupMs, recordMs, gpuMs, profileMs: 0, sourceOf: sourcesOf(site), shot });
          report.scenes[scene]!.runs[r] = res;
          report.scenes[scene]!.shots[r] = shot;
          log(`${frameLine(`${scene} ${r}`, res)}, missed ${res.frames.missed ?? '-'} of ${res.frames.n}`);
        }
      } finally {
        await site.close();
      }
    }
  } finally {
    await browser.close();
  }
  const out = get('out') ?? join(PERF_ROOT, 'reports', `look-${stamp}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  log(`report ${out}`);
  if (!argv.includes('--keep')) rmSync(runDir, { recursive: true, force: true });
}
