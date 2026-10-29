/**
 * The many-lights class measured (`node tools/perf/run.mjs lights …`): each
 * count of lights.ts built through a private backend, exported, and the
 * export measured like the level classes (frame-run.ts: 1920×1080 at DPR 1,
 * the host's GPU, always at the display's 60 Hz cap).
 *
 *   --counts 64,256,1000        (default all three)
 *   --renderers webgpu,webgl2   (default both)
 *   --range M                   each local light's reach (default LIGHTS_SPEC.range)
 *   --shadowed N                local lights casting a shadow (default LIGHTS_SPEC.shadowed)
 *   --walkers N                 skinned figures walking a loop under the shadowed lamps (default none): the
 *                               shadow atlas redrawn under motion
 *   --tiers low,medium          each export measured once per quality level named (`?quality=<level>`; the
 *                               engine's levels are its lighting tiers; default the project's own level)
 *   --shots DIR                 a screenshot per count and renderer (`lights-<count>-<renderer>.jpg`; default none)
 *   --query Q                   more page flags (`clusterView=1`: the light clusters' heat map)
 *   --profile-ms N              a main-thread CPU profile of N ms after the record, split by package (default none)
 *   --record-ms N --warmup-ms N --gpu-ms N --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/lights-<time>.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PERF_ROOT, REPO, startPerfBackend, type PerfBackend } from './backend';
import { launchGpuBrowser, measurePage, serveStatic, sourcesOf, type FrameRenderer, type FrameRunResult } from './frame-run';
import { publishBehaviorVia, publishFileVia } from './build';
import { PASTE_MAX } from './generate';
import { STARTER_REMOVED } from './level';
import { DEFAULT_LIGHTS_OPTIONS, LIGHTS_COUNTS, LIGHTS_ENVIRONMENT, LIGHTS_SUN, lightsCamera, lightsPlan, meanLightsReaching, WALKER_ASSET, WALKER_CONTROLLER, type LightsOptions, type LightsPlan } from './lights';
import { figureController, figureGlb } from './village-assets';
import { frameLine } from './village-run';

interface LightsReport {
  startedAt: string;
  commit: string;
  options: LightsOptions;
  tiers: string[];
  /** Runs by renderer, or by `<renderer>@<level>` with `--tiers`. */
  counts: Record<string, { plan: LightsPlan['counts'] & { scenes: number; meanLightsReaching: number }; build: { ms: number; commands: number }; exportMs: number; runs: Record<string, FrameRunResult> }>;
}

/** Build one count's plan into a new project through the backend's commands. */
export async function buildLights(be: PerfBackend, projectId: string, plan: LightsPlan): Promise<{ ms: number; commands: number }> {
  const t0 = performance.now();
  const created = await be.post('/api/v1/admin/projects', { projectId, name: `Lights ${plan.count}` });
  if (created.status !== 201 && created.status !== 200) throw new Error(`project create failed: ${created.status} ${JSON.stringify(created.json)}`);
  const p = be.project(projectId);
  let commands = 0;
  const cmd = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    commands += 1;
    return p.command(op, args);
  };
  for (const id of STARTER_REMOVED) await cmd('deleteEntity', { entityId: id }).catch(() => undefined);
  if (plan.walker !== null) {
    await publishFileVia(be, projectId, cmd, { assetId: WALKER_ASSET, kind: 'model', displayName: 'Walker', bytes: figureGlb(43) });
    await cmd('setAnimator', { controller: figureController(WALKER_ASSET, WALKER_CONTROLLER) });
    await publishBehaviorVia(be, p, cmd, plan.walker);
  }
  for (const scene of plan.scenes.slice(1)) await cmd('createScene', { sceneId: scene.sceneId, name: scene.name });
  if (plan.scenes.length > 1) await cmd('setStartScenes', { sceneIds: plan.scenes.map((s) => s.sceneId) });
  for (const scene of plan.scenes) {
    for (let i = 0; i < scene.entities.length; i += PASTE_MAX) await cmd('pasteEntities', { sceneId: scene.sceneId, entities: scene.entities.slice(i, i + PASTE_MAX) });
  }
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: LIGHTS_SUN });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: LIGHTS_ENVIRONMENT });
  await cmd('setTransform', { entityId: 'cam-main', transform: lightsCamera(plan) });
  return { ms: Math.round(performance.now() - t0), commands };
}

function wholeNumber(flag: string, v: string | undefined, fallback: number, min: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || (flag !== 'range' && !Number.isInteger(n))) throw new Error(`lights: --${flag} ${v} is not a number ≥ ${min}`);
  return n;
}

export async function runLightsCli(argv: readonly string[]): Promise<void> {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const counts = (get('counts') ?? LIGHTS_COUNTS.join(',')).split(',').map((c) => wholeNumber('counts', c, 0, 1));
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  const options: LightsOptions = { range: wholeNumber('range', get('range'), DEFAULT_LIGHTS_OPTIONS.range, 0.1), shadowed: wholeNumber('shadowed', get('shadowed'), DEFAULT_LIGHTS_OPTIONS.shadowed, 0), walkers: wholeNumber('walkers', get('walkers'), DEFAULT_LIGHTS_OPTIONS.walkers, 0) };
  const tiers = (get('tiers') ?? '').split(',').filter((t) => t !== '');
  const recordMs = Number(get('record-ms') ?? 10000);
  const profileMs = Number(get('profile-ms') ?? 0);
  const warmupMs = Number(get('warmup-ms') ?? 3000);
  const gpuMs = Number(get('gpu-ms') ?? 3000);
  const shots = get('shots');
  const query = get('query');
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `lights-${stamp}`);
  mkdirSync(runDir, { recursive: true });
  if (shots !== undefined) mkdirSync(shots, { recursive: true });
  const log = (s: string): void => console.log(`lights: ${s}`);
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const report: LightsReport = { startedAt, commit, options, tiers, counts: {} };
  const exportDirs = new Map<number, string>();

  // Built and exported with the backend running, then measured with it stopped (one backend or one browser at a time).
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  try {
    for (const n of counts) {
      const plan = lightsPlan(n, options);
      const build = await buildLights(be, `lights-${n}`, plan);
      const reach = meanLightsReaching(plan);
      log(`${n}: built in ${build.ms} ms (${build.commands} commands); ${plan.counts.point} point, ${plan.counts.spot} spot, ${plan.counts.area} area, shadowed ${plan.counts.shadowedPoint} point + ${plan.counts.shadowedSpot} spot, ${plan.counts.walkers} walkers, over ${plan.scenes.length} scenes; ${reach} lights reach a floor point on average`);
      const t = performance.now();
      const res = await be.post(`/api/v1/admin/projects/lights-${n}/export`, {});
      if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
      exportDirs.set(n, join(be.exportRoot, String(res.json['outputDir'])));
      report.counts[String(n)] = { plan: { ...plan.counts, scenes: plan.scenes.length, meanLightsReaching: reach }, build, exportMs: Math.round(performance.now() - t), runs: {} };
    }
  } finally {
    await be.stop();
  }

  const browser = await launchGpuBrowser({ vsync: true });
  try {
    for (const n of counts) {
      const site = await serveStatic(exportDirs.get(n)!);
      try {
        for (const r of renderers) {
          for (const tier of tiers.length > 0 ? tiers : [null]) {
            const key = tier === null ? r : `${r}@${tier}`;
            const shot = shots !== undefined ? join(shots, `lights-${n}-${key.replace('@', '-')}.jpg`) : undefined;
            const flags = [...(tier !== null ? [`quality=${tier}`] : []), ...(query !== undefined ? [query] : [])].map((f) => `&${f}`).join('');
            const res = await measurePage(browser, { url: `${site.url}?renderer=${r}${flags}`, warmupMs, recordMs, gpuMs, profileMs, sourceOf: sourcesOf(site), ...(shot !== undefined ? { shot } : {}) });
            report.counts[String(n)]!.runs[key] = res;
            log(`${frameLine(`${n} lights ${key}`, res)}, missed ${res.frames.missed ?? '-'} of ${res.frames.n}; clusters ${res.rendererChoice?.clusters ?? '-'}; shadow atlas ${res.rendererChoice?.atlas ?? '-'}; texture units ${JSON.stringify(res.textureUnits ?? null)}`);
            if (res.gpu?.available === true) log(`${n} lights ${key} passes (ms in the frames it ran / frames of ${res.gpu.frames}): ${res.gpu.passes.map((q) => `${q.label} ${q.msPerFrame}/${q.frames}`).join(', ')}`);
          }
        }
      } finally {
        await site.close();
      }
    }
  } finally {
    await browser.close();
  }
  const out = get('out') ?? join(PERF_ROOT, 'reports', `lights-${stamp}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  log(`report ${out}`);
  if (!argv.includes('--keep')) rmSync(runDir, { recursive: true, force: true });
}
