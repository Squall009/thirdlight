/**
 * The export memory bench (`node tools/voxel-bench/run.mjs export-memory …`):
 * what a game made with the engine holds, without the editor, against the
 * low tier's memory budget (`LOW_MEMORY_BUDGET_MIB`). The coverage bench
 * reads the same numbers in Play inside the editor, whose own page and
 * Scene view sit in the same browser; this one reads them in the exported
 * game.
 *
 * Two steps, so the backend is stopped between them (an export runs without it):
 *
 * 1. `--export` (staging running, the 8 km world of `run.mjs far-world` in
 *    project voxel-slice): the "Perf far camera" gets a behaviour that orbits
 *    the town square and, on the debug commands `fly60` / `fly150`, flies the
 *    coverage bench's line (30 m over the ground) at that speed, `orbit` back;
 *    the debug console on, the project exported; the camera's behaviour and
 *    the console setting put back. Prints the export's folder.
 * 2. `--dir DIR` (staging stopped): the folder served statically, the game
 *    opened at `--quality` (default low, its own cap: 30 Hz) on WebGPU at
 *    1280 × 720. Readings (page heap, its live part after a collection, the
 *    GPU process's driver-resident memory, the renderer's and the whole
 *    browser's resident and proportional sets, the far field's GPU bytes):
 *    the town orbit once the far field settled and 30 s on; after the 60 m/s
 *    flight; after the 150 m/s flight; back on the town orbit 30 s on.
 *    Frames at the cap during each flight.
 *
 *   --origin URL  --token-file FILE  --data-root DIR (default ~/thirdlight-staging-p45)  --project ID (voxel-slice)
 *   --quality LEVEL (default low)   --hold S (seconds on the orbit before a reading, default 30)
 *   --shot-dir DIR  full-size pictures at each reading   --tag NAME   --out FILE
 *
 * How to:
 *
 *   tools/staging.sh start
 *   <capped> node tools/voxel-bench/run.mjs export-memory --export     # prints the export folder
 *   tools/staging.sh stop
 *   <capped> node tools/voxel-bench/run.mjs export-memory --dir <folder>
 *
 * (`<capped>`: the scope of coverage-cli.ts's how-to.) Not part of `npm test`.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_QUALITY_LEVELS, LOW_MEMORY_BUDGET_MIB } from '@thirdlight/project-model';
import { launchGpuBrowser, serveStatic } from '../perf/frame-run';
import { benchDir } from './bench-dirs';
import { processMemory } from './browser-memory';
import { coveragePath } from './coverage';
import { farGround, flightSource, publishCameraBehaviour } from './flight-camera';
import { FarSettle, frameCap, frameWindow } from './headroom';
import { exportDebug } from './travel-page';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const ORIGIN = arg('origin', 'http://127.0.0.1:4180');
const DATA_ROOT = arg('data-root', join(homedir(), 'thirdlight-staging-p45'));
const PROJECT = arg('project', 'voxel-slice');
const PROJECT_DIR = join(DATA_ROOT, 'projects', PROJECT);
const WORLD = 'far';
const QUALITY = arg('quality', 'low');
const HOLD_S = Number(arg('hold', '30'));
const SHOT_DIR = arg('shot-dir', '');
const TAG = arg('tag', new Date().toISOString().slice(0, 16).replace(/[:T]/g, ''));
const OUT = arg('out', join(benchDir('export-memory'), `${QUALITY}-${TAG}.json`));
const LEVEL = DEFAULT_QUALITY_LEVELS.find((l) => l.id === QUALITY);
const CAP = frameCap(LEVEL?.frameRateCap ?? 60);
const VIEWPORT = { width: 1280, height: 720 };
/** The coverage bench's line (metres x, z): east lowland → town → the massif → the west valleys → the eastern mountains. */
const WAYPOINTS: Array<[number, number]> = [[2400, -400], [0, 0], [-2000, 0], [-2000, 2400], [1000, 2600]];
const PITCH = 0.08;
const FLIGHTS = { fly60: 60, fly150: 150 } as const;
const BEHAVIOR = 'export-memory-flight';

async function exportProject(): Promise<void> {
  const token = readFileSync(arg('token-file', join(DATA_ROOT, 'owner-token')), 'utf8').trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: ORIGIN };
  const api = async (path: string, body: unknown = {}, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${ORIGIN}/api/v1/${path.startsWith('admin/') ? path : `projects/${PROJECT}/${path}`}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const revision = async (): Promise<number> => Number((await api('commands', { op: 'queryProject', projectId: PROJECT, args: {} })).json['revision']);
  const command = async (op: string, args: unknown): Promise<void> => {
    const r = await api('commands', { op, projectId: PROJECT, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'voxel-bench-export-memory' }, args });
    const error = r.json['error'] as { code?: string } | undefined;
    if (r.json['ok'] !== true && error?.code !== 'no_change') throw new Error(`${op}: ${JSON.stringify(r.json).slice(0, 400)}`);
  };
  const scene = JSON.parse(readFileSync(join(PROJECT_DIR, 'scenes', 'scene-main.json'), 'utf8')).scene as { entities: Array<{ id: string; name: string; components: Record<string, { behaviorId?: string }> }> };
  const cam = scene.entities.find((e) => e.name === 'Perf far camera');
  const before = cam?.components['behavior']?.behaviorId ?? null;
  const settings = (JSON.parse(readFileSync(join(PROJECT_DIR, 'content.json'), 'utf8')) as { content: { settings?: Record<string, unknown> } }).content.settings ?? {};
  const path = coveragePath(WAYPOINTS, farGround(PROJECT_DIR, WORLD));
  await command('setEnvironment', { environment: { quality: QUALITY, qualityLevels: DEFAULT_QUALITY_LEVELS } });
  await publishCameraBehaviour({ origin: ORIGIN, token, project: PROJECT, api, command, revision }, PROJECT_DIR, BEHAVIOR, flightSource({ path, altitude: 'high', total: path.total, pitch: PITCH, flights: FLIGHTS, orbit: true }));
  await command('setSettings', { settings: { debug_console: 1 } });
  try {
    const t0 = Date.now();
    const exported = await api(`admin/projects/${PROJECT}/export`);
    if (exported.status !== 200) throw new Error(`export ${exported.status}: ${JSON.stringify(exported.json).slice(0, 400)}`);
    const dir = join(DATA_ROOT, 'exports', String(exported.json['outputDir']));
    console.log(`export-memory: exported in ${((Date.now() - t0) / 1000).toFixed(1)} s, line ${(path.total / 1000).toFixed(2)} km`);
    console.log(`export-memory: ${dir}`);
  } finally {
    await command('setSettings', { settings: { debug_console: settings['debug_console'] ?? 0 } }).catch((e: unknown) => console.error(`console setting not put back: ${String(e)}`));
    if (before !== null && cam !== undefined) await command('setBehaviorProperties', { entityId: cam.id, behaviorId: before, values: {} }).catch((e: unknown) => console.error(`camera behaviour not put back: ${String(e)}`));
  }
}

interface Hook {
  meter: { record(seconds: number): Promise<number[]> };
  stats(): { worlds: Record<string, { chunks: number; far: { nodes: number; bricks: number; gpuBytes: number } }> };
}

async function run(dir: string): Promise<void> {
  const host = () => ({ at: new Date().toISOString(), uptimeDays: Number((uptime() / 86400).toFixed(2)), load: loadavg().map((x) => Number(x.toFixed(2))) });
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`no export at "${dir}" (--dir: the folder --export printed)`);
  // The line's length decides the flights' durations (the same line the behaviour flies).
  const lineM = WAYPOINTS.slice(1).reduce((n, b, i) => n + Math.hypot(b[0] - WAYPOINTS[i]![0], b[1] - WAYPOINTS[i]![1]), 0);
  const out: Record<string, unknown> = { bench: 'export-memory', quality: QUALITY, renderer: 'webgpu', viewport: VIEWPORT, cap: CAP.fps, lineKm: lineM / 1000, export: dir, budget: LOW_MEMORY_BUDGET_MIB, start: host() };
  const site = await serveStatic(dir);
  const browser = await launchGpuBrowser({ vsync: true });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text().slice(0, 200))));
    const outside: string[] = [];
    page.on('request', (r) => void (!r.url().startsWith(site.url) && !/^(about|data|blob):/.test(r.url()) && outside.push(r.url())));
    const T0 = Date.now();
    await page.goto(`${site.url}/?renderer=webgpu&quality=${QUALITY}`);
    const canvas = page.locator('canvas#game');
    await canvas.waitFor({ timeout: 60_000 });
    const stats = () => page.evaluate((w) => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.stats().worlds[w] ?? null, WORLD);
    const cdpBrowser = await browser.newBrowserCDPSession();
    const heap = (collect: boolean) => page.evaluate((c) => {
      if (c) (globalThis as unknown as { gc?: () => void }).gc?.();
      return Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20);
    }, collect);
    const reading = async (label: string) => {
      const pageHeapMiB = await heap(false);
      const pageHeapLiveMiB = await heap(true);
      const p = await processMemory(cdpBrowser);
      const s = await stats();
      const r = { label, t: Number(((Date.now() - T0) / 1000).toFixed(1)), pageHeapMiB, pageHeapLiveMiB, ...p, farGpuMiB: Math.round((s?.far.gpuBytes ?? 0) / 2 ** 20), chunks: s?.chunks ?? 0, farNodes: s?.far.nodes ?? 0, farBricks: s?.far.bricks ?? 0 };
      console.log(`export-memory ${label}: ${JSON.stringify(r)}`);
      if (SHOT_DIR !== '') {
        mkdirSync(SHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(SHOT_DIR, `export-${QUALITY}-${label}.png`) });
      }
      return r;
    };
    const settle = async (limitMs: number): Promise<number> => {
      const t0 = Date.now();
      const s = new FarSettle();
      for (;;) {
        if (s.step((await stats())?.far, Date.now())) return Number(((s.since - t0) / 1000).toFixed(1));
        if (Date.now() - t0 > limitMs) return -1;
        await page.waitForTimeout(250);
      }
    };
    const debug = (name: string): Promise<void> => exportDebug(page, name);
    out['fillS'] = await settle(420_000);
    // The backend the game draws with, once it draws (WebGPU expected; a fallback would measure another renderer).
    out['renderer'] = await canvas.evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`);
    await page.waitForTimeout(HOLD_S * 1000);
    const readings = [await reading('town')];
    const flights: Record<string, unknown> = {};
    for (const [name, speed] of Object.entries(FLIGHTS)) {
      const flightS = lineM / speed;
      const record = page.evaluate((s) => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.record(s), flightS);
      await debug(name);
      const intervals = await record;
      await page.waitForTimeout(2000);
      flights[name] = { speed, flightS: Number(flightS.toFixed(1)), frames: frameWindow(intervals, CAP) };
      readings.push(await reading(`after-${speed}`));
    }
    await debug('orbit');
    await page.waitForTimeout(HOLD_S * 1000);
    out['homeSettleS'] = await settle(120_000);
    readings.push(await reading('home'));
    out['readings'] = readings;
    out['flights'] = flights;
    out['errors'] = errors.slice(0, 5);
    out['outsideRequests'] = outside.slice(0, 5);
  } catch (e) {
    out['error'] = String(e).slice(0, 600);
    console.error(out['error']);
  } finally {
    await browser.close().catch(() => undefined);
    await site.close();
  }
  out['end'] = host();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`export-memory: ${OUT}`);
  process.exit(out['error'] === undefined ? 0 : 1);
}

if (process.argv.includes('--export')) await exportProject();
else await run(arg('dir', ''));

