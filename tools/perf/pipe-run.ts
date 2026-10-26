/**
 * The pipe test (`node tools/perf/run.mjs pipe …`): the pipe scene (pipe.ts) built on the 3D starter through a
 * private backend, exported, and played in a real browser at the display's 60 Hz cap with real keyboard input on
 * each renderer: the player walks into the entry pipe (the game locks it and the stretch to the plane and blends
 * to the side camera), crosses the pit on the moving platform, jumps up through the one-way platforms onto the
 * wall, walks out of the exit pipe (freed, the follow camera back) and walks off along Z in the yard.
 *
 * Read per run: every drawn frame's time (rAF, counted where the page drew), the frames in the window round each
 * switch (from `SWITCH_BEFORE_MS` before the step the camera changed to `SWITCH_AFTER_MS` after it: the lock or
 * unlock, the blend, the first frames on the plane), their longest interval and the refreshes missed; the heavy
 * GPU calls (program builds, uploads) of any frame in a window; the programs/pipelines made before the walk and at
 * its end; and what the walk did (the player held on the plane, free again after).
 *
 *   --renderers webgpu,webgl2   (default both)
 *   --runs N                    measured runs per renderer (default 3)
 *   --shots DIR                 one more run per renderer (not measured) with screenshots: 3D before, the stretch, 3D after
 *   --keep                      keep the project and the export under ~/.cache/thirdlight-perf/runs/
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/pipe-<time>.json (latest-pipe.json too). Exit code 1 when a
 * run fails its walk or a frame in a switch window missed its refresh.
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Browser, Page } from '@playwright/test';

import { PERF_ROOT, startPerfBackend } from './backend';
import { FRAME_VIEWPORT, LONG_FRAME_MS, launchGpuBrowser, serveStatic, uncappedUrl, type FrameRenderer } from './frame-run';
import { installFrameCallCounts, installPerfInstrumentation, readSample, startRecording, type FrameEvent } from './instrument';
import { buildPipeScene, PIPE_LAYOUT, PIPE_PLANE, SIDE_BLEND_S, type PipeScene } from './pipe';
import { summarize } from './stats';

const flagOf = (argv: readonly string[]) => (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** The window round a switch: from this long before the step the live camera changed to this long after it (the blend inside). */
const SWITCH_BEFORE_MS = 1000;
const SWITCH_AFTER_MS = 1000 + SIDE_BLEND_S * 1000;
/** The driver reads the game this often (ms): its own cost on the page is part of what is measured. */
const POLL_MS = 40;
/** A drawn interval this many refreshes long missed one (as the frame runs count them). */
const MISSED_FACTOR = 1.5;
/** The calls that build something (programs, pipelines, textures) — a frame's routine uniform uploads are not listed. */
const HEAVY = /^(compileShader|linkProgram|createShaderModule|createRenderPipeline|createComputePipeline|texImage|texStorage|createTexture)/;

interface Obs {
  t: number;
  x: number;
  y: number;
  z: number;
  live: string | null;
}

export interface SwitchWindow {
  /** Page ms the driver saw the live camera change (the switch's step is at most one poll earlier). */
  at: number;
  frames: number;
  p50: number;
  p95: number;
  longest: number;
  /**
   * Intervals that missed a refresh (over 1.5 of them). At the cap every drawn interval is a whole number of
   * refreshes give or take the clock's jitter (16.6–16.8 ms measured), so one over `LONG_FRAME_MS` by more than
   * that jitter is a frame that missed its refresh.
   */
  missed: number;
  /** The heavy calls of the window's frames that made any (program builds, uploads), with when and how long. */
  heavy: FrameEvent[];
}

export interface PipeRun {
  renderer: FrameRenderer;
  enter: SwitchWindow | null;
  exit: SwitchWindow | null;
  /** The whole walk's drawn intervals. */
  walk: { frames: number; p50: number; p95: number; longest: number; missed: number };
  /** The furthest the player was off the plane between the switches (m), and how far it walked along Z after the exit. */
  offPlane: number;
  zAfter: number;
  programs: { before: number; end: number };
  errors: string[];
}

/** In the page: the time of every frame that drew (the instrumentation's draw counter moved). */
function installDrawClock(): void {
  const w = window as unknown as { __tlDrawn: number[]; __tlPerf?: { draws: number } };
  w.__tlDrawn = [];
  let last = -1;
  const loop = (t: number): void => {
    const d = w.__tlPerf?.draws ?? 0;
    if (d !== last) {
      last = d;
      w.__tlDrawn.push(t);
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

const observe = (page: Page): Promise<Obs> =>
  page.evaluate(() => {
    const o = (window as unknown as { __thirdlightObserve?: () => { player?: { x: number; y: number; z: number }; camera?: { live?: string | null } } | null }).__thirdlightObserve?.();
    const p = o?.player;
    return { t: performance.now(), x: p?.x ?? Number.NaN, y: p?.y ?? Number.NaN, z: p?.z ?? Number.NaN, live: o?.camera?.live ?? null };
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll the game until `done` holds (every observation goes to `seen`); throws `what` after `timeoutMs`. */
async function until(page: Page, seen: Obs[], what: string, done: (o: Obs) => boolean, timeoutMs = 20_000): Promise<Obs> {
  const t0 = Date.now();
  for (;;) {
    const o = await observe(page);
    seen.push(o);
    if (done(o)) return o;
    if (Date.now() - t0 > timeoutMs) {
      // The path up to the stop, thinned: where the walk went wrong.
      const path = seen.slice(-200).filter((_, i) => i % 5 === 0).map((s) => `${s.x.toFixed(2)},${s.y.toFixed(2)}`).join(' ');
      throw new Error(`pipe: timed out waiting for ${what} (player at ${o.x.toFixed(2)}, ${o.y.toFixed(2)}, ${o.z.toFixed(2)}, camera ${o.live}; path ${path})`);
    }
    await sleep(POLL_MS);
  }
}

/** A held jump (a tap is cut short by the controller's jump release). */
async function jump(page: Page): Promise<void> {
  await page.keyboard.down('Space');
  await sleep(350);
  await page.keyboard.up('Space');
}

function switchWindow(drawn: readonly number[], events: readonly FrameEvent[], at: number): SwitchWindow {
  const from = at - SWITCH_BEFORE_MS;
  const to = at + SWITCH_AFTER_MS;
  const iv: number[] = [];
  for (let i = 1; i < drawn.length; i++) if (drawn[i]! > from && drawn[i]! <= to) iv.push(drawn[i]! - drawn[i - 1]!);
  const s = summarize(iv);
  return { at: Math.round(at), frames: s.n, p50: s.p50, p95: s.p95, longest: s.max, missed: iv.filter((v) => v > LONG_FRAME_MS * MISSED_FACTOR).length, heavy: events.filter((e) => e.at > from && e.at <= to && Object.keys(e.calls).some((k) => HEAVY.test(k))) };
}

/**
 * One walk through the scene on a fresh page. With `shots`, screenshots at the three places (a screenshot stalls
 * the page, so a shot run is not measured).
 */
async function walkOnce(browser: Browser, url: string, renderer: FrameRenderer, scene: PipeScene, shots?: { dir: string }): Promise<PipeRun> {
  const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
  await context.addInitScript(installPerfInstrumentation);
  await context.addInitScript(installFrameCallCounts);
  await context.addInitScript(installDrawClock);
  // TL_PERF_STACKS=1: a program link in a frame also names where it came from (as the frame runs do).
  if (process.env['TL_PERF_STACKS'] === '1') await context.addInitScript(() => { (window as unknown as { __tlStacks?: boolean }).__tlStacks = true; });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 300));
  });
  const programs = (): Promise<number> => page.evaluate(() => {
    const P = (window as unknown as { __tlPerf?: { live: { programs: number; pipelines: number } } }).__tlPerf;
    return (P?.live.programs ?? 0) + (P?.live.pipelines ?? 0);
  });
  const shot = async (name: string): Promise<void> => {
    if (shots !== undefined) await page.screenshot({ path: join(shots.dir, `41.7-${name}-${renderer}.jpg`), type: 'jpeg', quality: 85 });
  };
  const seen: Obs[] = [];
  const L = PIPE_LAYOUT;
  try {
    await page.goto(uncappedUrl(`${url}?renderer=${renderer}`));
    await page.waitForFunction(() => (window as unknown as { __tlPerf?: { firstDrawAt: number | null } }).__tlPerf?.firstDrawAt ?? null, null, { timeout: 180_000 });
    // The level's meshes and programs built and the character standing before the walk starts.
    await sleep(8000);
    await page.mouse.click(FRAME_VIEWPORT.width / 2, FRAME_VIEWPORT.height / 2);
    await sleep(500);
    const start = await until(page, seen, 'the player', (o) => Number.isFinite(o.x));
    if (start.live !== scene.followCamera) errors.push(`the follow camera is not live at the start (${start.live})`);
    const before = await programs();
    await page.evaluate(startRecording);

    // Walk left (−X) into the entry pipe: the game turns the side camera live.
    await page.keyboard.down('KeyA');
    if (shots !== undefined) {
      await until(page, seen, 'the pipe in view', (o) => o.x <= L.entryX + 5);
      await shot('3d-before');
    }
    const enter = await until(page, seen, 'the side camera', (o) => o.live === scene.sideCamera);
    // Onto the pit's platform (it starts when the player steps on), stand while it carries the player across.
    await until(page, seen, 'the platform', (o) => o.x <= L.liftFrom - 0.3);
    await page.keyboard.up('KeyA');
    await until(page, seen, 'the far side of the pit', (o) => o.x <= L.liftTo + 0.3, 10_000);
    await shot('2d-stretch');
    await page.keyboard.down('KeyA');
    // Up through the one-way platforms (each jump starts just before the platform's near edge) onto the wall.
    await until(page, seen, 'the first one-way platform', (o) => o.x <= L.oneWay[0][0] + 0.5);
    await jump(page);
    await until(page, seen, 'the second one-way platform', (o) => o.x <= L.oneWay[1][0] + 1.4 && o.y > L.oneWay[0][2]);
    await jump(page);
    await until(page, seen, 'the wall', (o) => o.x <= L.wall[0] - 0.5 && o.y > L.wall[2]);
    // Down off the wall and out of the exit pipe: the follow camera takes the view back.
    const exit = await until(page, seen, 'the follow camera back', (o) => o.live !== scene.sideCamera);
    await until(page, seen, 'the yard', (o) => o.x <= L.yard.x[1] - 2);
    await page.keyboard.up('KeyA');
    // Free again: forward (away from the camera, −Z) leaves the plane.
    await page.keyboard.down('KeyW');
    await sleep(1500);
    await page.keyboard.up('KeyW');
    await sleep(SWITCH_AFTER_MS);
    const last = await until(page, seen, 'the player', (o) => Number.isFinite(o.z));
    await shot('3d-after');
    const end = await programs();
    const sample = await page.evaluate(readSample, true);
    const drawn = await page.evaluate(() => (window as unknown as { __tlDrawn: number[] }).__tlDrawn.slice());
    const between = seen.filter((o) => o.t > enter.t + 100 && o.t < exit.t - 100);
    const offPlane = between.reduce((m, o) => Math.max(m, Math.abs(o.z - PIPE_PLANE.origin)), 0);
    const walkIv = sample.frames;
    const w = summarize(walkIv);
    return {
      renderer,
      enter: switchWindow(drawn, sample.frameEvents, enter.t),
      exit: switchWindow(drawn, sample.frameEvents, exit.t),
      walk: { frames: w.n, p50: w.p50, p95: w.p95, longest: w.max, missed: walkIv.filter((v) => v > LONG_FRAME_MS * MISSED_FACTOR).length },
      offPlane: Math.round(offPlane * 1e4) / 1e4,
      zAfter: Math.round((last.z - PIPE_PLANE.origin) * 100) / 100,
      programs: { before, end },
      errors,
    };
  } catch (e) {
    errors.push(String(e).slice(0, 3000));
    return { renderer, enter: null, exit: null, walk: { frames: 0, p50: 0, p95: 0, longest: 0, missed: 0 }, offPlane: Number.NaN, zAfter: Number.NaN, programs: { before: 0, end: 0 }, errors };
  } finally {
    await context.close();
  }
}

const winLine = (what: string, w: SwitchWindow | null): string =>
  w === null ? `${what} -` : `${what} longest ${w.longest} ms, p95 ${w.p95}, ${w.missed} missed (${w.frames} frames)${w.heavy.length > 0 ? `; heavy calls ${w.heavy.map((e) => `@${Math.round(e.at - w.at)} ms ${e.dt} ms {${Object.entries(e.calls).filter(([k]) => !k.endsWith(':bytes')).map(([k, v]) => `${k} ${v}`).join(', ')}}`).join('; ')}` : ''}`;

export function pipeLine(i: number, r: PipeRun): string {
  return `pipe ${r.renderer} run ${i + 1}: ${winLine('enter', r.enter)}; ${winLine('exit', r.exit)}; walk p50/p95 ${r.walk.p50}/${r.walk.p95} ms, longest ${r.walk.longest}, ${r.walk.missed} missed (${r.walk.frames}); off the plane ${r.offPlane} m, z after the exit ${r.zAfter} m; programs ${r.programs.before} → ${r.programs.end}${r.errors.length > 0 ? `; errors ${r.errors.join(' | ')}` : ''}`;
}

/** A run that walked the whole scene, held the plane and was free after it. */
const walked = (r: PipeRun): boolean => r.enter !== null && r.exit !== null && r.offPlane < 1e-3 && r.zAfter < -1 && r.errors.length === 0;

export async function runPipeCli(argv: readonly string[]): Promise<void> {
  const get = flagOf(argv);
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const log = (s: string): void => console.log(s);
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  for (const r of renderers) if (r !== 'webgpu' && r !== 'webgl2') throw new Error(`--renderers: webgpu or webgl2, not ${r}`);
  const runs = Number(get('runs') ?? 3);
  const shotsDir = get('shots');
  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `pipe-${stamp}`);
  const reportsDir = join(PERF_ROOT, 'reports');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });

  let exportDir: string;
  let scene: PipeScene;
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  try {
    const t0 = performance.now();
    scene = await buildPipeScene(be, 'pipe');
    const res = await be.post('/api/v1/admin/projects/pipe/export', {});
    if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
    exportDir = join(be.exportRoot, String(res.json['outputDir']));
    log(`pipe: built and exported in ${Math.round(performance.now() - t0)} ms`);
  } finally {
    await be.stop();
  }

  const report: { reportVersion: 1; startedAt: string; runs: PipeRun[] } = { reportVersion: 1, startedAt, runs: [] };
  // Always at the display's rate: the targets are held at the 60 Hz cap, and uncapped runs throttle.
  const browser = await launchGpuBrowser({ vsync: true });
  const site = await serveStatic(exportDir);
  try {
    for (const r of renderers) {
      for (let i = 0; i < runs; i++) {
        const run = await walkOnce(browser, site.url, r, scene);
        report.runs.push(run);
        log(pipeLine(i, run));
        if (!walked(run) || (run.enter?.missed ?? 1) > 0 || (run.exit?.missed ?? 1) > 0) process.exitCode = 1;
      }
      if (shotsDir !== undefined) {
        mkdirSync(shotsDir, { recursive: true });
        const run = await walkOnce(browser, site.url, r, scene, { dir: shotsDir });
        log(`pipe ${r} screenshots in ${shotsDir}${run.errors.length > 0 ? `; errors ${run.errors.join(' | ')}` : ''}`);
      }
    }
  } finally {
    await site.close();
    await browser.close();
  }
  const out = join(reportsDir, `pipe-${stamp}.json`);
  writeFileSync(out, JSON.stringify(report, null, 1));
  copyFileSync(out, join(reportsDir, 'latest-pipe.json'));
  log(`pipe: report ${out}${has('keep') ? `, run folder ${runDir}` : ''}`);
  if (!has('keep')) rmSync(runDir, { recursive: true, force: true });
}
