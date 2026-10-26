/**
 * The look-reference scenes measured and photographed (`node tools/perf/run.mjs
 * look …`): each scene of look.ts built through a private backend, its
 * lighting baked in the editor on the host's GPU ("Bake preview" for the
 * lightmaps, then "Bake probes", both timed), exported, and the export
 * measured like the level classes (frame-run.ts: 1920×1080 at DPR 1, the
 * host's GPU, always at the display's 60 Hz cap) with a screenshot per
 * renderer.
 *
 *   --scenes door,sunset,corridor,sign   (default all four; shut-off,shut-on,open-on: the leak check, compared pixel by pixel)
 *   --renderers webgpu,webgl2            (default both)
 *   --no-bake                            the lights realtime, nothing baked (default: the lights baked, then baked)
 *   --cache-view                         draw the surface cache's texels (`?surfaceCacheView=1`): what the live light wrote, with its probes' bounce
 *   --probes-view                        draw the live probes (`?probesView=1`): each lit by its own light
 *   --shots DIR                          where the screenshots go (default the run folder, kept with --keep)
 *   --shot-prefix P                      screenshot names `<P><scene>-<renderer>.jpg` (default none)
 *   --record-ms N --warmup-ms N --gpu-ms N --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/look-<time>.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERF_ROOT, REPO, startPerfBackend } from './backend';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult } from './frame-run';
import jpeg from 'jpeg-js';

import { buildLook, LEAK_SCENES, LOOK_PLANS, LOOK_SCENES, type LookScene } from './look';
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
  for (const s of scenes) if (![...LOOK_SCENES, ...LEAK_SCENES].includes(s)) throw new Error(`look: unknown scene ${s} (${[...LOOK_SCENES, ...LEAK_SCENES].join(', ')})`);
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
          const res = await measurePage(browser, { url: `${site.url}?renderer=${r}${argv.includes('--cache-view') ? '&surfaceCacheView=1' : ''}${argv.includes('--probes-view') ? '&probesView=1' : ''}`, warmupMs, recordMs, gpuMs, profileMs: 0, sourceOf: sourcesOf(site), shot });
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
  // The leak check: the lamp behind the shut door changes nothing in the picture; with the door gone it lights R.
  for (const r of renderers) {
    const shotOf = (scene: LookScene): string | undefined => report.scenes[scene]?.shots[r];
    const [off, on, open] = [shotOf('shut-off'), shotOf('shut-on'), shotOf('open-on')];
    if (off === undefined || on === undefined || open === undefined) continue;
    const lum = (file: string): Float32Array => {
      const img = jpeg.decode(readFileSync(file), { useTArray: true });
      const out = new Float32Array(img.width * img.height);
      for (let i = 0; i < out.length; i += 1) out[i] = (img.data[i * 4]! + img.data[i * 4 + 1]! + img.data[i * 4 + 2]!) / 3;
      return out;
    };
    const [a, b, c] = [lum(off), lum(on), lum(open)];
    const diff = (x: Float32Array, y: Float32Array): { mean: number; brighter: number } => {
      let sum = 0;
      let brighter = 0;
      for (let i = 0; i < x.length; i += 1) {
        sum += y[i]! - x[i]!;
        if (y[i]! - x[i]! > 8) brighter += 1;
      }
      return { mean: sum / x.length, brighter: brighter / x.length };
    };
    const shut = diff(a, b);
    const opened = diff(a, c);
    log(`leak ${r}: lamp on behind the shut door: mean ${shut.mean.toFixed(2)} of 255, ${(shut.brighter * 100).toFixed(2)} % of pixels brighter by > 8; door gone: mean ${opened.mean.toFixed(2)}, ${(opened.brighter * 100).toFixed(2)} % brighter`);
    (report as unknown as Record<string, unknown>)[`leak-${r}`] = { shut, opened };
  }
  const out = get('out') ?? join(PERF_ROOT, 'reports', `look-${stamp}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  log(`report ${out}`);
  if (!argv.includes('--keep')) rmSync(runDir, { recursive: true, force: true });
}
