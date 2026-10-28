/**
 * The look scenes played as a player sees them (`node tools/perf/run.mjs
 * look-accept …`): each look scene (look.ts) with the starter character
 * walking through it and a script that changes the lighting live when a key
 * is pressed, baked in the editor (or not), exported, and played on the
 * host's GPU at 1920×1080 at the display's 60 Hz cap on each renderer.
 *
 * The script (one per scene) walks the character round its marks while
 * `attack` (J) has it walking, and on `interact` (E):
 * - `door`: digs a 2 × 2 m hole in the room's sunlit wall beside the door,
 *   then fills it again;
 * - `sunset`: puts the sun at morning, then runs it to noon and evening over
 *   24 s, then puts it at noon;
 * - `shut-on`: switches the lamp behind the shut door off, then on again.
 *
 * Per scene and renderer, two page loads:
 * 1. measured: after the light settled, frame windows (frame p95, missed
 *    refreshes, main-thread CPU per frame, the GPU's clock) still, after each
 *    key and while walking; each change's re-light time read from the surface
 *    cache's diagnostics (press → marked → direct light settled → probes
 *    settled); a screenshot at each window's end (never inside a window);
 * 2. captured: a webm of the character walking (the sunset's sun running
 *    meanwhile, the door dug halfway) and a strip of six frames from it.
 *
 *   --scenes door,sunset,corridor,sign,shut-on   (default all five)
 *   --renderers webgpu,webgl2                    (default both)
 *   --no-bake                                    the lights realtime, nothing baked
 *   --shots DIR --shot-prefix P --out FILE --keep
 *
 * The report goes to ~/.cache/thirdlight-perf/reports/look-accept-<time>.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';

import jpeg from 'jpeg-js';
import type { Browser, CDPSession, Page } from '@playwright/test';

import { PERF_ROOT, REPO, startPerfBackend, type PerfBackend } from './backend';
import { bakeLightingInEditor } from './bake-run';
import { publishBehaviorVia, publishFileVia, type CommandFn } from './build';
import { installFrameProbe, probeGpuPasses, probeSceneCounts, probeSetGpuTiming } from './frame-probe';
import { FRAME_VIEWPORT, gpuClockSampler, gpuMaxMhz, launchGpuBrowser, LONG_FRAME_MS, serveStatic, type FrameRenderer } from './frame-run';
import { installPerfInstrumentation, readSample, startRecording } from './instrument';
import { buildLook, type LookScene } from './look';
import { summarize } from './stats';

type V3 = [number, number, number];
const ACCEPT_SCENES = ['door', 'sunset', 'corridor', 'sign', 'shut-on'] as const;
type AcceptScene = (typeof ACCEPT_SCENES)[number];

/** The starter template's character (the 3D starter's own file and animation roles). */
const CHARACTER_FILE = join(REPO, 'templates', 'starter-3d', 'assets', 'model', 'character.glb');
const CHARACTER_ROLES = { idle: { clipIndex: 0, clipName: 'Idle' }, run: { clipIndex: 1, clipName: 'Run' }, airborne: { clipIndex: 2, clipName: 'Airborne' } };
/** The character's pivot over its feet (its bounds reach 0.9 m below it). */
const FEET = 0.91;
/** The simulation's fixed steps a second (the script counts time in them). */
const STEPS_PER_S = 120;
/** How long the sun takes from morning to evening (s). */
const SUN_RUN_S = 24;

/** Where the character stands and the marks it walks round, per scene (ground heights: blocks 1 m, the sign's flat 0). */
const WALKS: Readonly<Record<AcceptScene, { park: V3; walk: V3[] }>> = {
  door: { park: [14, 1 + FEET, 13], walk: [[14, 1 + FEET, 13], [10.5, 1 + FEET, 12.5], [12.9, 1 + FEET, 15.2], [12.9, 1 + FEET, 19]] },
  sunset: { park: [27, 1 + FEET, 24], walk: [[27, 1 + FEET, 24], [20, 1 + FEET, 23.5], [24, 1 + FEET, 28]] },
  corridor: { park: [11.5, 1 + FEET, 8], walk: [[11.5, 1 + FEET, 8], [11.5, 1 + FEET, 25], [12.3, 1 + FEET, 16]] },
  sign: { park: [61, FEET, 60.5], walk: [[61, FEET, 60.5], [67, FEET, 60.5], [64, FEET, 59]] },
  // Parked out of the picture (the leak's pixels compare lamp off against on), walking into room R and out.
  'shut-on': { park: [6.5, 1 + FEET, 8.6], walk: [[1.5, 1 + FEET, 6.5], [1.5, 1 + FEET, 5.2], [6.5, 1 + FEET, 8.6]] },
};

/** The door scene's hole: the room's +z wall (z = 16) beside the doorway (x 12–13), two cells wide and high. */
const DIG_CELLS: V3[] = [[10, 1, 16], [11, 1, 16], [10, 2, 16], [11, 2, 16]];
/** The sun at three times of day (where its light travels); evening is the sunset scene's own. */
const SUN_TIMES: Readonly<Record<'morning' | 'noon' | 'evening', V3>> = { morning: [0.55, -0.25, 0.8], noon: [0.1, -0.95, 0.3], evening: [-0.55, -0.17, 0.82] };

/** One scene's script: the walk on J, the scene's change on E. */
function driverSource(scene: AcceptScene, ids: { layer?: string; lamp?: string }): string {
  const w = WALKS[scene];
  const press: Record<AcceptScene, string> = {
    door: `for (const p of ${JSON.stringify(DIG_CELLS)}) { if (state.presses % 2 === 1) ctx.grid.clear(${JSON.stringify(ids.layer)}, p[0], p[1], p[2]); else ctx.grid.set(${JSON.stringify(ids.layer)}, p[0], p[1], p[2], { block: 'rock' }); }`,
    sunset: 'state.t0 = ctx.stepIndex;',
    corridor: '',
    sign: '',
    'shut-on': `ctx.entity(${JSON.stringify(ids.lamp)})?.set('light', { intensity: state.presses % 2 === 1 ? 0 : 30 });`,
  };
  const every = scene !== 'sunset'
    ? ''
    : [
        "    const env = ctx.environment;",
        "    if (state.presses === 1) env.blend('acc-morning', 'acc-noon', 0);",
        `    else if (state.presses === 2) { const t = Math.min(1, (ctx.stepIndex - state.t0) / ${STEPS_PER_S * SUN_RUN_S}); if (t < 0.5) env.blend('acc-morning', 'acc-noon', t * 2); else env.blend('acc-noon', 'acc-evening', (t - 0.5) * 2); }`,
        "    else if (state.presses >= 3) env.blend('acc-noon', 'acc-evening', 0);",
      ].join('\n');
  return [
    `const WALK = ${JSON.stringify(w.walk)};`,
    `const PARK = ${JSON.stringify(w.park)};`,
    'export default {',
    '  instantiate() { return { walking: false, handle: -1, wp: 0, presses: 0, t0: 0 }; },',
    '  step(state: any, ctx: any) {',
    "    if (ctx.phase !== 'intent') return;",
    '    const c = ctx.character;',
    "    if (ctx.input.pressed('attack')) {",
    '      state.walking = !state.walking;',
    '      if (!state.walking && c) { c.stop(); c.place(PARK, 0); state.handle = -1; }',
    '    }',
    '    if (state.walking && c) {',
    "      const st = state.handle < 0 ? 'arrived' : c.walkState(state.handle);",
    "      if (st !== 'walking') { state.wp = (state.wp + 1) % WALK.length; state.handle = c.walkTo(WALK[state.wp], { arrive: 0.3 }); }",
    '    }',
    `    if (ctx.input.pressed('interact')) { state.presses += 1; ${press[scene]} }`,
    every,
    '  },',
    '};',
  ].join('\n');
}

/** The character, the presets and the script added to a built look scene. */
async function addExtras(be: PerfBackend, projectId: string, scene: AcceptScene): Promise<void> {
  const p = be.project(projectId);
  const cmd: CommandFn = (op, args) => p.command(op, args);
  await publishFileVia(be, projectId, cmd, { assetId: 'starter-character', kind: 'model', displayName: 'Character', bytes: new Uint8Array(readFileSync(CHARACTER_FILE)) });
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'model', name: 'Player', transform: { position: WALKS[scene].park }, model: { asset: { assetId: 'starter-character' } }, components: { controller: {}, modelAnimation: { assetId: 'starter-character', version: 1, roles: CHARACTER_ROLES } } });
  const listed = (await p.query('queryEntities', { limit: 200, offset: 0 }))['entities'] as { id: string; name?: string; components: Record<string, unknown> }[];
  const ids: { layer?: string; lamp?: string } = {};
  const layer = listed.find((e) => e.components['blockLayer'] !== undefined)?.id;
  const lamp = listed.find((e) => e.name === 'Lamp in C')?.id;
  if (layer !== undefined) ids.layer = layer;
  if (lamp !== undefined) ids.lamp = lamp;
  if (scene === 'sunset') {
    const preset = (presetId: string, direction: V3): Record<string, unknown> => ({ presetId, name: presetId, lights: [{ type: 'directional', direction }] });
    await cmd('setEnvironment', { environment: { presets: [preset('acc-morning', SUN_TIMES.morning), preset('acc-noon', SUN_TIMES.noon), preset('acc-evening', SUN_TIMES.evening)] } });
  }
  const behavior = { behaviorId: `accept-${scene}`, displayName: `Acceptance ${scene}`, ownedTransforms: [], declaration: { properties: [] }, source: driverSource(scene, ids) };
  await publishBehaviorVia(be, p, cmd, behavior);
  const driver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Acceptance driver', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setBehaviorProperties', { entityId: driver, behaviorId: behavior.behaviorId, values: {} });
}

/** In the page: the surface cache's re-light and probe state (null: no surface cache drawn). */
function probeLight(): { live: boolean; settled: boolean; stale: number; marks: number; lastSettleMs: number | null; lastSettleFrames: number | null; probesSettled: boolean; probesLastSettleMs: number | null } | null {
  const P = (window as unknown as { __tlProbe?: { lastScenes: Map<unknown, unknown> } }).__tlProbe;
  if (P === undefined) return null;
  for (const s of P.lastScenes.keys()) {
    const sc = (s as { userData?: Record<string, unknown> } | null)?.userData?.['tlSurfaceCache'] as { diagnostics?: () => Record<string, unknown> } | undefined;
    if (typeof sc?.diagnostics !== 'function') continue;
    const d = sc.diagnostics();
    const r = d['relight'] as { live: boolean; settled: boolean; staleTexels: number; marks: number; lastSettleMs: number | null; lastSettleFrames: number | null } | undefined;
    const pr = d['probes'] as { settled?: boolean; lastSettleMs?: number | null } | undefined;
    if (r === undefined) return null;
    return { live: r.live, settled: r.settled, stale: r.staleTexels, marks: r.marks, lastSettleMs: r.lastSettleMs, lastSettleFrames: r.lastSettleFrames, probesSettled: pr?.settled !== false, probesLastSettleMs: pr?.lastSettleMs ?? null };
  }
  return null;
}

interface WindowResult {
  label: string;
  frames: { n: number; p50: number; p95: number; max: number; missed: number; missedAt: number[] };
  mainCpuMsPerFrame: number | null;
  gpuMhz: number | null;
  relight?: { markedMs: number | null; directMs: number | null; probesMs: number | null; lastSettleMs: number | null; lastSettleFrames: number | null; probesLastSettleMs: number | null; staleMax: number };
  shot?: string;
}

/** A frame window of `ms` after `key` (if any), the light polled for a change's settle; a screenshot after it. */
async function frameWindow(page: Page, cdp: CDPSession, label: string, ms: number, key: string | null, shot: string | null): Promise<WindowResult> {
  const cpu = async (): Promise<number | undefined> => ((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.find((m) => m.name === 'ThreadTime')?.value;
  const before = await page.evaluate(probeLight);
  const a = await cpu();
  await page.evaluate(startRecording);
  const clock = gpuClockSampler();
  const t0 = Date.now();
  if (key !== null) await page.keyboard.press(key);
  let marked: number | null = null;
  let direct: number | null = null;
  let probes: number | null = null;
  let staleMax = 0;
  let last = before;
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 100));
    if (key === null || before === null || !before.live) continue;
    last = await page.evaluate(probeLight);
    if (last === null) continue;
    const t = Date.now() - t0;
    staleMax = Math.max(staleMax, last.stale);
    if (marked === null && last.marks > before.marks) marked = t;
    if (marked !== null && direct === null && last.settled) direct = t;
    if (marked !== null && direct !== null && probes === null && last.probesSettled) probes = t;
  }
  const mhz = clock?.stop() ?? null;
  const sample = await page.evaluate(readSample, true);
  const b = await cpu();
  const s = summarize(sample.frames);
  const missed = sample.frames.filter((f) => f > LONG_FRAME_MS * 1.5).length;
  const out: WindowResult = {
    label,
    frames: { n: s.n, p50: s.p50, p95: s.p95, max: s.max, missed, missedAt: sample.missedAt.slice(0, 20) },
    mainCpuMsPerFrame: a !== undefined && b !== undefined ? Math.round((((b - a) * 1000) / Math.max(1, s.n)) * 100) / 100 : null,
    gpuMhz: mhz,
  };
  if (key !== null && before !== null && before.live) {
    out.relight = { markedMs: marked, directMs: direct, probesMs: probes, lastSettleMs: last?.lastSettleMs ?? null, lastSettleFrames: last?.lastSettleFrames ?? null, probesLastSettleMs: last?.probesLastSettleMs ?? null, staleMax };
  }
  if (shot !== null) {
    await page.screenshot({ path: shot, type: 'jpeg', quality: 88 });
    out.shot = shot;
  }
  return out;
}

/** Open the export, wait for the first frame, the scene to stop changing and the light to settle. */
async function openGame(page: Page, url: string, log: (s: string) => void): Promise<{ firstMs: number; lightSettledMs: number | null }> {
  await page.goto(url);
  const firstMs = await page.waitForFunction(() => (window as unknown as { __tlPerf?: { firstDrawAt: number | null } }).__tlPerf?.firstDrawAt ?? null, null, { timeout: 180_000 }).then((h) => h.jsonValue() as Promise<number>);
  let last = -1;
  let same = 0;
  for (let i = 0; i < 90 && same < 3; i++) {
    const c = await page.evaluate(probeSceneCounts);
    const k = c.meshes * 100_000 + c.objects;
    same = k === last && k > 0 ? same + 1 : 0;
    last = k;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const t0 = Date.now();
  let lightSettledMs: number | null = null;
  while (Date.now() - t0 < 60_000) {
    const l = await page.evaluate(probeLight);
    if (l === null || !l.live) break;
    if (l.settled && l.probesSettled) {
      lightSettledMs = Date.now() - t0;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (lightSettledMs === null) log('light: not live or not settled within 60 s');
  await new Promise((r) => setTimeout(r, 2000));
  return { firstMs: Math.round(firstMs), lightSettledMs };
}

/** The scene's measured windows: still, its changes, the walk; then the GPU's passes. */
async function measured(browser: Browser, url: string, scene: AcceptScene, shotOf: (label: string) => string, log: (s: string) => void): Promise<Record<string, unknown>> {
  const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
  await context.addInitScript(installPerfInstrumentation);
  await context.addInitScript(installFrameProbe, { timestamps: true });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  try {
    const opened = await openGame(page, url, log);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const windows: WindowResult[] = [];
    const run = async (label: string, ms: number, key: string | null, shot = true): Promise<void> => {
      const w = await frameWindow(page, cdp, label, ms, key, shot ? shotOf(label) : null);
      windows.push(w);
      const rl = w.relight;
      log(`${label}: p95 ${w.frames.p95} ms, missed ${w.frames.missed} of ${w.frames.n}, main ${w.mainCpuMsPerFrame ?? '-'} ms, GPU ${w.gpuMhz ?? '-'} MHz${rl !== undefined ? `; re-light marked ${rl.markedMs ?? '-'} / direct ${rl.directMs ?? 'NOT'} / probes ${rl.probesMs ?? 'NOT'} ms after the key (polled 100 ms; the cache's own: ${rl.lastSettleMs?.toFixed(0) ?? '-'} ms in ${rl.lastSettleFrames ?? '-'} frames, probes ${rl.probesLastSettleMs?.toFixed(0) ?? '-'} ms), stale texels max ${rl.staleMax}` : ''}`);
    };
    await run('still', 8000, null);
    if (scene === 'door') {
      await run('dug', 8000, 'KeyE');
      await run('filled', 8000, 'KeyE');
    } else if (scene === 'sunset') {
      await run('morning', 8000, 'KeyE');
      await run('sun-running', (SUN_RUN_S + 2) * 1000, 'KeyE', false);
      await run('evening', 6000, null);
      await run('noon', 8000, 'KeyE');
    } else if (scene === 'shut-on') {
      await run('lamp-off', 8000, 'KeyE');
      await run('lamp-on', 8000, 'KeyE');
    }
    await run('walking', 10_000, 'KeyJ', false);
    await page.keyboard.press('KeyJ');
    const on = await page.evaluate(probeSetGpuTiming, true);
    const clock = gpuClockSampler();
    const gpu = on ? await page.evaluate(probeGpuPasses, 3000) : null;
    const gpuMhz = clock?.stop() ?? null;
    await page.evaluate(probeSetGpuTiming, false);
    const sample = await page.evaluate(readSample, false);
    await cdp.detach().catch(() => undefined);
    return { ...opened, renderer: sample.renderer, windows, gpu: gpu === null ? null : { msPerFrame: gpu.msPerFrame, gpuMhz, passes: gpu.passes.slice(0, 8) }, errors };
  } finally {
    await context.close();
  }
}

/** Six 1920×1080 jpgs as one 1920×720 strip (3 × 2 at a third of their size). */
function stripOf(shots: Buffer[]): Buffer {
  const [cw, ch] = [640, 360];
  const out = Buffer.alloc(cw * 3 * ch * 2 * 4);
  shots.slice(0, 6).forEach((b, i) => {
    const img = jpeg.decode(b, { useTArray: true });
    const [ox, oy] = [(i % 3) * cw, Math.floor(i / 3) * ch];
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const s = (Math.floor((y * img.height) / ch) * img.width + Math.floor((x * img.width) / cw)) * 4;
        const d = ((oy + y) * cw * 3 + ox + x) * 4;
        out[d] = img.data[s]!;
        out[d + 1] = img.data[s + 1]!;
        out[d + 2] = img.data[s + 2]!;
        out[d + 3] = 255;
      }
    }
  });
  return Buffer.from(jpeg.encode({ data: out, width: cw * 3, height: ch * 2 }, 85).data);
}

/** The walk recorded as a webm and a strip of six frames (the sunset's sun running, the door dug halfway). */
async function captured(browser: Browser, url: string, scene: AcceptScene, dir: string, name: string, log: (s: string) => void): Promise<string[]> {
  const videoDir = join(dir, `.video-${name}`);
  const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1, recordVideo: { dir: videoDir, size: { width: 960, height: 540 } } });
  await context.addInitScript(installPerfInstrumentation);
  await context.addInitScript(installFrameProbe, { timestamps: false });
  const page = await context.newPage();
  const files: string[] = [];
  try {
    await openGame(page, url, log);
    await page.keyboard.press('KeyJ');
    const frames: Buffer[] = [];
    const take = async (label?: string): Promise<void> => {
      const b = await page.screenshot({ type: 'jpeg', quality: 85 });
      frames.push(b);
      if (label !== undefined) {
        const f = join(dir, `${name}-${label}.jpg`);
        writeFileSync(f, b);
        files.push(f);
      }
    };
    if (scene === 'sunset') {
      await page.keyboard.press('KeyE');
      await new Promise((r) => setTimeout(r, 1500));
      await page.keyboard.press('KeyE');
      // Six frames of the running sun, three of them kept: just after morning, about noon, near evening.
      const t0 = Date.now();
      for (const [at, label] of [[500, 'run-morning'], [4000], [8000], [12000, 'run-noon'], [17000], [23000, 'run-evening']] as const) {
        await new Promise((r) => setTimeout(r, Math.max(0, at - (Date.now() - t0))));
        await take(label);
      }
    } else {
      for (let i = 0; i < 6; i++) {
        if (scene === 'door' && i === 3) await page.keyboard.press('KeyE');
        await take();
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
    const strip = join(dir, `${name}-strip.jpg`);
    writeFileSync(strip, stripOf(frames));
    files.push(strip);
  } finally {
    await context.close();
  }
  const video = await page.video()?.path();
  if (video !== undefined) {
    const f = join(dir, `${name}.webm`);
    renameSync(video, f);
    files.push(f);
  }
  rmSync(videoDir, { recursive: true, force: true });
  return files;
}

export async function runLookAcceptCli(argv: readonly string[]): Promise<void> {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scenes = (get('scenes') ?? ACCEPT_SCENES.join(',')).split(',') as AcceptScene[];
  for (const s of scenes) if (!ACCEPT_SCENES.includes(s)) throw new Error(`look-accept: unknown scene ${s} (${ACCEPT_SCENES.join(', ')})`);
  const renderers = (get('renderers') ?? 'webgpu,webgl2').split(',') as FrameRenderer[];
  const bake = !argv.includes('--no-bake');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = join(PERF_ROOT, 'runs', `look-accept-${stamp}`);
  const shots = get('shots') ?? runDir;
  const prefix = get('shot-prefix') ?? '';
  mkdirSync(runDir, { recursive: true });
  mkdirSync(shots, { recursive: true });
  const log = (s: string): void => console.log(`look-accept: ${s}`);
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout */
  }
  const report: Record<string, unknown> = { startedAt: new Date().toISOString(), commit, bake, gpuMaxMhz: gpuMaxMhz(), scenes: {} };
  const exportDirs: Partial<Record<AcceptScene, string>> = {};
  const be = await startPerfBackend(join(runDir, 'data'), join(runDir, 'exports'));
  try {
    for (const scene of scenes) {
      const projectId = `accept-${scene}`;
      await buildLook(be, projectId, scene as LookScene, bake ? 'baked' : 'realtime');
      await addExtras(be, projectId, scene);
      const baked = bake ? await bakeLightingInEditor(be, projectId, (s) => log(`${scene}: ${s}`)) : undefined;
      const res = await be.post(`/api/v1/admin/projects/${projectId}/export`, {});
      if (res.status !== 200) throw new Error(`export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
      exportDirs[scene] = join(be.exportRoot, String(res.json['outputDir']));
      (report['scenes'] as Record<string, unknown>)[scene] = { bake: baked ?? null, runs: {} };
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
          const name = `${prefix}${scene}-${r}`;
          const url = `${site.url}?renderer=${r}`;
          log(`${name}: up ${(uptime() / 86400).toFixed(1)} d, load ${readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ')}`);
          const m = await measured(browser, url, scene, (label) => join(shots, `${name}-${label}.jpg`), (s) => log(`${name} ${s}`));
          const files = await captured(browser, url, scene, shots, `${prefix}walk-${scene}-${r}`, (s) => log(`${name} capture ${s}`));
          log(`${name}: captured ${files.map((f) => f.split('/').pop()).join(', ')}`);
          ((report['scenes'] as Record<string, { runs: Record<string, unknown> }>)[scene]!.runs)[r] = { ...m, captured: files };
        }
      } finally {
        await site.close();
      }
    }
  } finally {
    await browser.close();
  }
  // The leak: the lamp behind the shut door switched off against on, pixel by pixel (the character parked out of the picture).
  for (const r of renderers) {
    const shot = (label: string): string => join(shots, `${prefix}shut-on-${r}-${label}.jpg`);
    if (!scenes.includes('shut-on')) continue;
    const lum = (file: string): Float32Array => {
      const img = jpeg.decode(readFileSync(file), { useTArray: true });
      const out = new Float32Array(img.width * img.height);
      for (let i = 0; i < out.length; i += 1) out[i] = (img.data[i * 4]! + img.data[i * 4 + 1]! + img.data[i * 4 + 2]!) / 3;
      return out;
    };
    const [off, on, still] = [lum(shot('lamp-off')), lum(shot('lamp-on')), lum(shot('still'))];
    const diff = (x: Float32Array, y: Float32Array): { mean: number; brighter: number } => {
      let sum = 0;
      let brighter = 0;
      for (let i = 0; i < x.length; i += 1) {
        sum += y[i]! - x[i]!;
        if (y[i]! - x[i]! > 8) brighter += 1;
      }
      return { mean: Math.round((sum / x.length) * 1000) / 1000, brighter: Math.round((brighter / x.length) * 1e6) / 1e4 };
    };
    const leak = { switchedOn: diff(off, on), firstOn: diff(off, still) };
    log(`leak ${r}: lamp switched on behind the shut door against off: mean ${leak.switchedOn.mean} of 255, ${leak.switchedOn.brighter} % of pixels brighter by > 8 (as loaded: ${leak.firstOn.mean}, ${leak.firstOn.brighter} %)`);
    report[`leak-${r}`] = leak;
  }
  const out = get('out') ?? join(PERF_ROOT, 'reports', `look-accept-${stamp}.json`);
  mkdirSync(join(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
  log(`report ${out}`);
  if (!argv.includes('--keep')) rmSync(runDir, { recursive: true, force: true });
}
