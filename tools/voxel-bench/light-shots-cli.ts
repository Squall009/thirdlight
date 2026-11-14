/**
 * The lighting pictures (`node tools/voxel-bench/run.mjs light-shots …`): Play in the editor on a running
 * backend (staging: `tools/staging.sh start`; the 8 km world of `run.mjs far-world` in project voxel-slice), on
 * WebGPU at the viewport's size, the quality level's own cap (low: 30 Hz), the render scale pinned to the tier's
 * own (dynamic resolution off, as the headroom meter pins it, so a picture is drawn the same every run). The
 * project's "Perf far camera" goes to each of the five fixed cameras (lighting-cameras.ts) in turn; at each,
 * once streaming has settled (the page's near and far counts still for `--hold` s, the simulation's job queue
 * and far work at zero), it saves `<name>.png`, then a second picture with the voxel draws hidden: a shot whose
 * picture barely changes with them hidden, that drew no voxels, or that never settled is refused (listed in the
 * report's `problems`, exit code 1). With each shot: the frame profile's page and simulation ms a frame and its
 * budget rows (the `lighting` category among them), and its resident-bytes table. After the shots, `--edits`
 * runtime digs in front of the street camera, each timed from the edit to the first frame that draws it
 * (`__tlVoxelPlay.edits()`). With `--gpu`, at each camera after its pictures the page's GPU measurement
 * (game-host gpu-measure.ts: ms per pass category, the Profiler's "Measure GPU") runs and goes into the shot's
 * `gpu`, and a third picture after it (`<name>-after-gpu.png`) is compared with the first: a measurement must
 * leave the scene drawing what it drew (`afterGpuShare`, refused over the street's own run-to-run change).
 *
 * Set-up, each run (what the generated world lacks): the two looks as environment presets (`bench-noon`,
 * `bench-night`; kept in the project), the cave as one `editVoxels` dig stroke (kept in the world: a second
 * run's stroke changes nothing), the street lamps as scene objects and the camera's behaviour (both taken out
 * again after). Auto-exposure is off on the camera (the look's fixed exposure stands), so nothing adapts
 * between runs.
 *
 *   --origin URL  --token-file FILE (default ~/thirdlight-staging-p45/owner-token)  --project ID (voxel-slice)
 *   --world NAME (far)  --quality low|medium|high (default low)  --viewport WxH (default 1280x720)
 *   --only LIST   cameras by name (default all five)   --query Q   more of the editor page's query (Play is
 *                 passed its flags: a later item's lighting arrangement), starting with `&`
 *   --hold S (default 3)  --timeout S a camera (default 180)  --edits N (default 3, 0: none)
 *   --gpu         the GPU measurement at each camera (about two minutes each)   --gpu-repeats N (default 5)
 *   --out DIR     (default ~/.cache/thirdlight-voxel-bench/light-shots/<quality>-<time>)
 *
 * How to (staging running, nothing else on the GPU):
 *
 *   sudo -n systemd-run --scope --quiet -p MemoryMax=10G -p MemorySwapMax=0 -- sudo -n -u $USER -- \
 *     env HOME=$HOME PATH=$PATH TMPDIR=$HOME/.cache/tmp/light-shots node tools/voxel-bench/run.mjs light-shots --quality low --out DIR
 *
 * Not part of `npm test`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_QUALITY_LEVELS } from '@thirdlight/project-model';
import { profileSummary, type ProfileReport } from '@thirdlight/game-host';
import { decodePng } from '../../tests/e2e/png';
import { commandEnvelope } from '../../tests/support/commands';
import { launchGpuBrowser } from '../perf/frame-run';
import { benchDir } from './bench-dirs';
import { benchApi, cameraBehaviour, publishCameraBehaviour } from './flight-camera';
import { BENCH_LAMP_LIGHT, BENCH_LAMPS, caveStroke, changedShare, EDIT_DIGS, LIGHTING_CAMERAS, LIGHTING_PRESETS, lightShotsSource, parseLightShotsArgs, shotProblems } from './lighting-cameras';
import { gpuMeasureOnPage, gpuMeasureSummary, measureGpuOnPage } from './gpu-measure-page';
import { openPlay, type PlayGame } from './travel-page';
import { settleAfter, type CountSample } from './travel';

const O = parseLightShotsArgs(process.argv.slice(2));
const DATA_ROOT = join(homedir(), 'thirdlight-staging-p45');
const PROJECT_DIR = join(DATA_ROOT, 'projects', O.project);
const TOKEN = readFileSync(O.tokenFile ?? join(DATA_ROOT, 'owner-token'), 'utf8').trim();
const OUT = O.out ?? benchDir('light-shots', `${O.quality}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
const LEVEL = DEFAULT_QUALITY_LEVELS.find((l) => l.id === O.quality);
const TIER_SCALE = LEVEL?.renderScale ?? 1;
const BEHAVIOR = 'light-shots-camera';
/** How still the counts must be: near counts within 1 % (or 2), the far field's within 2 % (the coverage bench's rule). */
const NEAR_STILL = { share: 0.01, abs: 2 };
const FAR_STILL = { share: 0.02, abs: 2 };
const COUNTS = ['chunks', 'l0', 'l1', 'l2', 'kits', 'farNodes', 'farBricks'] as const;
/** After the settle: a second for the temporal upscale to converge on the still view. */
const CONVERGE_MS = 1500;
/**
 * The share of a picture that may differ after a GPU measurement from before it: the street's two baseline runs
 * 40 min apart differed by 0.21 % (sky and far shimmer); more means the measurement left something hidden or changed.
 */
const AFTER_GPU_SHARE = 0.005;

interface WorldStats {
  chunks: number;
  levels: number[];
  kitInstances: number;
  far: { nodes: number; bricks: number };
}
interface Hook {
  stats(): { worlds: Record<string, WorldStats> };
  edits(): Array<{ world: string; visibleMs: number; swapMs: number; hopMs: number; applyMs: number; frames: number; chunks: number; sections: number }>;
  meter: { set(s: { renderScale?: number; dynamicResolution?: boolean; hide?: { near?: boolean; far?: boolean } }): boolean };
}

const host = () => ({ at: new Date().toISOString(), uptimeDays: Number((uptime() / 86400).toFixed(2)), load: loadavg().map((x) => Number(x.toFixed(2))) });

function sceneEntities(): Array<{ id: string; name: string }> {
  return JSON.parse(readFileSync(join(PROJECT_DIR, 'scenes', 'scene-main.json'), 'utf8')).scene.entities as Array<{ id: string; name: string }>;
}

async function counts(game: PlayGame): Promise<Record<(typeof COUNTS)[number], number> | null> {
  const w = await game.frame.evaluate((world) => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.stats().worlds[world] ?? null, O.world).catch(() => null);
  if (w === null) return null;
  return { chunks: w.chunks, l0: w.levels[0] ?? 0, l1: w.levels[1] ?? 0, l2: w.levels[2] ?? 0, kits: w.kitInstances, farNodes: w.far.nodes, farBricks: w.far.bricks };
}

/** Waits until the counts hold still for `holdS` and the simulation has nothing pending; how long it took, or null by the timeout. */
async function settle(game: PlayGame): Promise<{ settledS: number | null; counts: Record<string, number> | null; pending: number[] }> {
  const t0 = Date.now();
  const series: CountSample[] = [];
  let last: Record<(typeof COUNTS)[number], number> | null = null;
  let pending: number[] = [];
  for (;;) {
    const t = (Date.now() - t0) / 1000;
    last = await counts(game);
    const sim = await game.sim().catch(() => null);
    pending = [Number(sim?.['pool']?.queued ?? 0), Number(sim?.['pool']?.inFlight ?? 0), Number(sim?.['far']?.pending ?? 0), Number(sim?.['far']?.jobs ?? 0)];
    if (last !== null) series.push({ t, v: COUNTS.map((k) => last![k]) });
    const still = settleAfter(series, 0, COUNTS.map((k) => (k.startsWith('far') ? FAR_STILL : NEAR_STILL)), O.holdS);
    if (still !== null && sim !== null && pending.every((x) => x === 0)) return { settledS: Number(t.toFixed(1)), counts: last, pending };
    if (t > O.timeoutS) return { settledS: null, counts: last, pending };
    await game.page.waitForTimeout(250);
  }
}

async function meterSet(game: PlayGame, hide: { near?: boolean; far?: boolean }): Promise<void> {
  const ok = await game.frame.evaluate((s) => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.meter.set(s) ?? false, { renderScale: TIER_SCALE, dynamicResolution: false, hide });
  if (!ok) throw new Error('the page has no meter (WebGPU and a voxel world needed)');
}

async function prepare(b: ReturnType<typeof benchApi>): Promise<() => Promise<void>> {
  // The project's content lists its presets by id; setting the list replaces it, so a project with presets of its own is refused.
  const content = JSON.parse(readFileSync(join(PROJECT_DIR, 'content.json'), 'utf8')) as { content: { environment?: { presets?: unknown[] } } };
  const others = (content.content.environment?.presets ?? []).filter((p) => !LIGHTING_PRESETS.some((q) => q.presetId === (typeof p === 'string' ? p : (p as { presetId?: string }).presetId)));
  if (others.length > 0) throw new Error(`the project has environment presets of its own (${JSON.stringify(others).slice(0, 200)}): the bench would replace them`);
  await b.command('setEnvironment', { environment: { quality: O.quality, qualityLevels: DEFAULT_QUALITY_LEVELS, presets: LIGHTING_PRESETS } });
  // The cave: refused with no_change once it is there. A voxel op's expected revision is the world's own: sent without one.
  const dug = await b.api('commands', commandEnvelope('editVoxels', O.project, undefined, { world: O.world, command: caveStroke() }, 'voxel-bench-light-shots'));
  if (dug.json['ok'] !== true && (dug.json['error'] as { code?: string } | undefined)?.code !== 'no_change') throw new Error(`the cave: ${JSON.stringify(dug.json).slice(0, 400)}`);
  console.log(`the cave: ${dug.json['ok'] === true ? `dug, ${String(dug.json['cells'] ?? '?')} cells` : 'there already'}`);
  for (const lamp of BENCH_LAMPS) {
    const had = sceneEntities().find((e) => e.name === lamp.name);
    if (had !== undefined) await b.command('deleteEntity', { entityId: had.id });
    await b.command('createEntity', { sceneId: 'scene-main', kind: 'group', name: lamp.name, transform: { position: [...lamp.position] }, components: { light: { ...BENCH_LAMP_LIGHT } } });
  }
  const before = cameraBehaviour(PROJECT_DIR);
  await publishCameraBehaviour(b, PROJECT_DIR, BEHAVIOR, lightShotsSource());
  return async () => {
    for (const lamp of BENCH_LAMPS) {
      const e = sceneEntities().find((x) => x.name === lamp.name);
      if (e !== undefined) await b.command('deleteEntity', { entityId: e.id }).catch((err: unknown) => console.error(`lamp not taken out: ${String(err)}`));
    }
    const cam = sceneEntities().find((e) => e.name === 'Perf far camera');
    if (before !== null && before !== BEHAVIOR && cam !== undefined) await b.command('setBehaviorProperties', { entityId: cam.id, behaviorId: before, values: {} }).catch(() => undefined);
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const b = benchApi({ origin: O.origin, token: TOKEN, project: O.project, clientId: 'voxel-bench-light-shots' });
  const out: Record<string, unknown> = { bench: 'light-shots', quality: O.quality, renderer: 'webgpu', viewport: O.viewport, tierScale: TIER_SCALE, cap: LEVEL?.frameRateCap ?? null, query: O.query, world: O.world, start: host(), shots: [] as unknown[], problems: [] as string[] };
  const problems = out['problems'] as string[];
  const restore = await prepare(b);
  const browser = await launchGpuBrowser({ vsync: true });
  try {
    const context = await browser.newContext({ viewport: O.viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text().slice(0, 200))));
    const game = await openPlay(b, page, { viewport: O.viewport, query: O.query, quality: O.quality, world: O.world });
    out['renderer'] = await game.frame.evaluate(() => { const c = document.querySelector('canvas[data-tl-renderer]'); return `${c?.getAttribute('data-tl-renderer')}/${c?.getAttribute('data-tl-renderer-state')}`; });
    // The meter exists once the page draws its voxel world.
    for (let i = 0; i < 240 && (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: unknown }).__tlVoxelPlay !== undefined)) === false; i++) await page.waitForTimeout(250);
    await meterSet(game, {});
    for (const cam of LIGHTING_CAMERAS.filter((c) => O.only.includes(c.name))) {
      await game.debug(cam.command);
      const s = await settle(game);
      await page.waitForTimeout(CONVERGE_MS);
      const file = join(OUT, `${cam.name}.png`);
      const shown = decodePng(await game.screenshot(file));
      const profile = await game.frame.evaluate(() => (window as unknown as { __tlProfiler?: { read(): unknown } }).__tlProfiler?.read() ?? null);
      // The same view with the voxel draws hidden: what changes is what the voxels drew.
      await meterSet(game, { near: true, far: true });
      await page.waitForTimeout(CONVERGE_MS);
      const hiddenFile = join(OUT, `${cam.name}-voxels-hidden.png`);
      const hidden = decodePng(await game.screenshot(hiddenFile));
      await meterSet(game, {});
      const voxelShare = changedShare(shown, hidden);
      let gpu: unknown = null;
      let afterGpuShare: number | null = null;
      if (O.gpu) {
        try {
          const g = await measureGpuOnPage((call, options) => game.frame.evaluate(gpuMeasureOnPage, { call, ...(options !== undefined ? { options } : {}) }), (ms) => page.waitForTimeout(ms), { repeats: O.gpuRepeats });
          gpu = g;
          console.log(`${cam.name}: ${gpuMeasureSummary(g)}`);
          // The meter's pin again (the measurement let go of its own hold), then the same view once more.
          await meterSet(game, {});
          await page.waitForTimeout(CONVERGE_MS);
          afterGpuShare = changedShare(shown, decodePng(await game.screenshot(join(OUT, `${cam.name}-after-gpu.png`))));
          if (afterGpuShare > AFTER_GPU_SHARE) problems.push(`${cam.name}: the picture after the GPU measurement differs from before it in ${(afterGpuShare * 100).toFixed(2)} % of its pixels`);
        } catch (e) {
          problems.push(`${cam.name}: GPU measurement: ${String(e).slice(0, 200)}`);
        }
      }
      const c = s.counts ?? {};
      const shotProblemsFound = shotProblems({ settled: s.settledS !== null, chunks: c['chunks'] ?? 0, l0: c['l0'] ?? 0, farBricks: c['farBricks'] ?? 0, voxelShare, near: cam.near });
      for (const p of shotProblemsFound) problems.push(`${cam.name}: ${p}`);
      const report = profile === null ? null : (profile as ProfileReport);
      (out['shots'] as unknown[]).push({
        name: cam.name,
        file,
        hiddenFile,
        eye: cam.eye,
        yaw: cam.yaw,
        pitch: cam.pitch,
        preset: cam.preset,
        shows: cam.shows,
        settledS: s.settledS,
        pending: s.pending,
        counts: s.counts,
        voxelShare: Number(voxelShare.toFixed(3)),
        problems: shotProblemsFound,
        profile: report === null ? null : profileSummary(report),
        memory: report?.counters.memory ?? null,
        ...(O.gpu ? { gpu, afterGpuShare: afterGpuShare === null ? null : Number(afterGpuShare.toFixed(4)) } : {}),
        at: host(),
      });
      console.log(`${cam.name}: settled ${s.settledS ?? 'never'} s, ${JSON.stringify(s.counts)}, voxels change ${(voxelShare * 100).toFixed(1)} % of the picture${shotProblemsFound.length > 0 ? `; REFUSED: ${shotProblemsFound.join('; ')}` : ''}; profile ${JSON.stringify(report === null ? null : profileSummary(report).msPerFrame)}`);
    }
    if (O.edits > 0) {
      // Edit → screen: digs in front of the street camera, one at a time, each read from the page's edit record.
      await game.debug(LIGHTING_CAMERAS[0]!.command);
      await settle(game);
      const edits: unknown[] = [];
      for (const d of EDIT_DIGS.slice(0, O.edits)) {
        const n = (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.edits().length ?? 0)) as number;
        await game.debug(d.command);
        let got: unknown = null;
        for (let i = 0; i < 80 && got === null; i++) {
          await page.waitForTimeout(250);
          const list = (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.edits() ?? [])) as unknown[];
          if (list.length > n) got = list[list.length - 1];
        }
        edits.push({ command: d.command, center: d.center, edit: got });
        if (got === null) problems.push(`${d.command}: no edit reached the screen in 20 s`);
        await page.waitForTimeout(1000);
      }
      const obs = await game.observe().catch(() => null);
      out['edits'] = { digs: edits, refused: obs?.counters?.['light_dig_refused'] ?? 0, issued: obs?.counters?.['light_digs'] ?? 0 };
      console.log(`edits: ${JSON.stringify(edits.map((e) => (e as { edit: { visibleMs?: number; frames?: number } | null }).edit === null ? null : { visibleMs: (e as { edit: { visibleMs: number } }).edit.visibleMs, frames: (e as { edit: { frames: number } }).edit.frames }))}`);
    }
    out['errors'] = errors.slice(0, 5);
    await game.stop();
  } catch (e) {
    out['error'] = String(e).slice(0, 600);
    console.error(out['error']);
  } finally {
    await browser.close().catch(() => undefined);
    await restore();
  }
  out['end'] = host();
  const file = join(OUT, 'light-shots.json');
  writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  for (const p of problems) console.error(`light-shots: ${p}`);
  console.log(`light-shots: ${file}`);
  process.exit(out['error'] === undefined && problems.length === 0 ? 0 : 1);
}

await main();
