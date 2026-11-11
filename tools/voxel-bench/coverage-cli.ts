/**
 * The coverage bench (`node tools/voxel-bench/run.mjs coverage …`): travel at racing speed (the owner's 150 m/s)
 * over a voxel world, measured the owner's way. In flight: no long hitch (the longest frame, frames over 100 ms,
 * missed frames a minute at the tier's cap), no hole in the picture. Once the camera stops at the line's end: the
 * seconds until the ground under it is solid (a ray down from the camera hits a collider at the ground; the probe
 * character dropped there stands), until full detail stands round it (the near field's level-0 chunks and kit
 * pieces stop changing) and until nothing is pending (every near and far count still; in Play also the
 * simulation's job queue and far work at zero). Throughout: a body dropped onto the ground never falls through it.
 *
 * Where it runs: Play in the editor on a running backend (default), or the exported game served statically with
 * the backend stopped (two steps, as `run.mjs export-memory`): `--export` (backend running) prepares the project
 * and exports it, printing the folder; `--dir DIR` (backend stopped) runs the flight in it. Staging's 8 km world
 * (`run.mjs far-world`, project voxel-slice), WebGPU, 1280 × 720, the quality level's own cap (low: 30 Hz).
 *
 * The camera (the project's "Perf far camera", given the shared flight behaviour, flight-camera.ts) flies a
 * ~9.8 km line: the east lowland, the town, up the massif's cliffs, the west valleys and into the eastern
 * mountains, 30 m over the highest ground near it (`--altitude high`) or 5 m over it (`hug`), looking along its
 * heading 0.08 rad down. The line's ground is read from the world's far cache on disk (level 2, 2 m cells). The
 * scene's sky is a key colour (magenta) for the run, put back after; for the run the project also gets the probe
 * character (a capsule player controller), taken out after.
 *
 * Every frame the page presents is checked (the browser's screencast, 640 × 360, every second pixel): a key pixel
 * whose ray falls to the world's lowest ground inside the world's bounds is a hole; the bottom rows' near-black
 * share is kept a frame (the dark slivers of low's fast frames). With position polls (4 a second, the camera from
 * the flight's distance), rays through the lower half of the view entering a far stand-in's solid at a box face
 * (seen from inside, the grey grid). In the page: every frame's time and the voxel draws' counts, the browser's
 * long animation frames (what ran in them): each gap over 100 ms in flight gets its cause. In Play the
 * simulation's diagnostics twice a second: the ground under the camera as its streamer counts it, the job queue,
 * the far field's pending work, the streaming counters.
 *
 *   --origin URL  --token-file FILE  --data-root DIR (default ~/thirdlight-staging-p45)  --project ID (voxel-slice)
 *   --quality LEVEL (default low)   --speed M/S (default 150)   --altitude high|hug (default high)
 *   --export   prepare and export (backend running): prints the export folder; `--dir DIR` runs in it
 *   --hold S   seconds recorded after the stop (default 30): settle times longer than it read as not settled
 *   --strip LIST  seconds into the flight to keep a screencast frame at (640 × 360, no extra capture); `aN`: N s after the stop
 *   --shots LIST  seconds into the flight to save full-size frames (a screenshot: it costs a frame)   --shot-dir DIR
 *   --park M      stop the flight M metres along the line   --after LIST  seconds after the stop to save full-size frames at
 *   --return S    (Play) after the flight, put the camera back at the line's start and read memory again S seconds on
 *   --heap-profile, --heap-snapshot LIST  (Play) the page's heap by allocation site at each reading (start,end,return)
 *   --query Q    more of the editor page's query (Play) or the export's (`&farFeedback=off`)
 *   --tag NAME   --out FILE (default ~/.cache/thirdlight-voxel-bench/coverage/<where>-<quality>-<speed>-<altitude>-<tag>.json)
 *
 * How to (nothing else on the GPU; `<capped>` = the scope below):
 *
 *   sudo -n systemd-run --scope --quiet -p MemoryMax=10G -p MemorySwapMax=0 -- sudo -n -u $USER -- \
 *     env HOME=$HOME PATH=$PATH TMPDIR=$HOME/.cache/tmp/coverage node tools/voxel-bench/run.mjs coverage --speed 150
 *   (an export: staging running, `<capped> … coverage --export --quality low`; staging stopped, `<capped> … coverage --dir <folder> --quality low --speed 150`)
 *
 * Read `travel` (flight frames, stop settle times, falls), `spikes`, `holes`, `bottomDark`, `viewInStandIn`,
 * `memory*`, `far`. Not part of `npm test`.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import type { Browser, CDPSession, Frame, Page } from '@playwright/test';
import { DEFAULT_QUALITY_LEVELS, LOW_MEMORY_BUDGET_MIB } from '@thirdlight/project-model';
import { decodePng } from '../../tests/e2e/png';
import { launchGpuBrowser, serveStatic } from '../perf/frame-run';
import { benchDir } from './bench-dirs';
import { processMemory } from './browser-memory';
import { along, coveragePath, entersAtFace, groundAlong, groundMask, isKey, viewRayPoints, VIEW_RAYS, type CoveragePath, type FarSample } from './coverage';
import { farGround, flightSource, PROBE_COUNTERS, publishCameraBehaviour, type BenchApi } from './flight-camera';
import { FarSettle, frameCap } from './headroom';
import { addProbeBody, bodySamples, exportDebug, installRecorder, rayAndBody, removeProbeBody, stopWall, takeRecorded, type ObsSample, type Recorded } from './travel-page';
import { bottomDarkShare, dropOutcomes, firstAfter, flightFrames, longGaps, settleAfter, spikeCauses, type CountSample } from './travel';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
const list = (name: string): string[] => arg(name, '').split(',').filter((s) => s !== '');

const ORIGIN = arg('origin', 'http://127.0.0.1:4180');
const DATA_ROOT = arg('data-root', join(homedir(), 'thirdlight-staging-p45'));
const PROJECT = arg('project', 'voxel-slice');
const WORLD = 'far';
const PROJECT_DIR = join(DATA_ROOT, 'projects', PROJECT);
const QUALITY = arg('quality', 'low');
const SPEED = Number(arg('speed', '150'));
const ALTITUDE = arg('altitude', 'high') as 'high' | 'hug';
const EXPORT_DIR = arg('dir', '');
const WHERE = EXPORT_DIR !== '' ? 'export' : 'play';
/** Metres along the line the flight stops at (default its end). */
const PARK = Number(arg('park', 'Infinity'));
const HOLD_S = Number(arg('hold', '30'));
const AFTER = list('after').map(Number);
const RETURN_S = Number(arg('return', '0'));
const HEAP_PROFILE = process.argv.includes('--heap-profile');
const HEAP_SNAPSHOT = list('heap-snapshot');
const SHOTS = list('shots').map(Number);
/** Screencast frames kept: seconds into the flight, `aN` N seconds after the stop. */
const STRIP = list('strip');
const SHOT_DIR = arg('shot-dir', benchDir('coverage'));
const QUERY = arg('query', '');
const TAG = arg('tag', new Date().toISOString().slice(0, 16).replace(/[:T]/g, ''));
const OUT = arg('out', join(benchDir('coverage'), `${WHERE}-${QUALITY}-${SPEED}-${ALTITUDE}-${TAG}.json`));
const LEVEL = DEFAULT_QUALITY_LEVELS.find((l) => l.id === QUALITY);
const CAP = frameCap(LEVEL?.frameRateCap ?? 60);
const VIEWPORT = { width: 1280, height: 720 };
/** The flight's line (metres x, z): east lowland → town → the massif → the west valleys → the eastern mountains. */
const WAYPOINTS: Array<[number, number]> = [[2400, -400], [0, 0], [-2000, 0], [-2000, 2400], [1000, 2600]];
const PITCH = 0.08;
const FOV_Y = Math.PI / 3;
/** The world's lowest ground (metres): a ray falling to it inside the world meets the ground on the way. */
const FLOOR_Y = 0;
/** Key pixels (of the 320 × 180 check) where the ground must show that make a frame a hole: ~8 × 8 px at 720p. */
const HOLE_PIXELS = 4;
/** The screencast's size; the hole check reads every second pixel of it (320 × 180, as before the strip was kept). */
const CAST = { width: 640, height: 360 };
/** The bottom rows (of the screencast) whose near-black share a frame keeps, and the share that counts a frame dark. */
const BOTTOM_ROWS = 9;
const BOTTOM_DARK_FRAME = 0.05;
const BEHAVIOR = 'coverage-flight';
/** The flights' debug commands: an export carries them all, so one export flies either speed. */
const FLIGHTS = { fly60: 60, fly150: 150, [`fly${SPEED}`]: SPEED };
/** The probe: the line's ground every 2 m, a drop every 2 s of flight 2.5 m over it, a ray solid within 3 m of it. */
const PROBE = { step: 2, dropEveryS: 2, dropAboveM: 2.5, rayTolM: 3 };
/** How still the counts must be to count as settled: near counts within 1 % (or 2), the far field's within 2 % as the fill's settle. */
const NEAR_STILL = { share: 0.01, abs: 2 };
const FAR_STILL = { share: 0.02, abs: 2 };
/** Seconds the counts must hold still to be settled. */
const SETTLE_HOLD_S = 3;

const TOKEN_FILE = arg('token-file', join(DATA_ROOT, 'owner-token'));
const bench = (): BenchApi => {
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: ORIGIN };
  const api = async (path: string, body: unknown = {}, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> => {
    const r = await fetch(`${ORIGIN}/api/v1/${path.startsWith('admin/') ? path : `projects/${PROJECT}/${path}`}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const revision = async (): Promise<number> => Number((await api('commands', { op: 'queryProject', projectId: PROJECT, args: {} })).json['revision']);
  const command = async (op: string, args: unknown): Promise<void> => {
    const r = await api('commands', { op, projectId: PROJECT, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'voxel-bench-coverage' }, args });
    const error = r.json['error'] as { code?: string } | undefined;
    if (r.json['ok'] !== true && error?.code !== 'no_change') throw new Error(`${op}: ${JSON.stringify(r.json).slice(0, 400)}`);
  };
  return { origin: ORIGIN, token, project: PROJECT, api, command, revision };
};

/** The world's extent in x and z (metres) from its region files' names (`r.<x>.<y>.<z>.vxr`, `footprint` cells a side). */
function worldBounds(): { min: number; max: number } {
  const m = JSON.parse(readFileSync(join(PROJECT_DIR, 'voxels', WORLD, 'world.json'), 'utf8')) as { footprint: number; regions: string[] };
  let lo = Infinity, hi = -Infinity;
  for (const r of m.regions) {
    const p = /^r\.(-?\d+)\.(-?\d+)\.(-?\d+)\.vxr$/.exec(r);
    if (p === null) continue;
    for (const v of [Number(p[1]), Number(p[3])]) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v + 1);
    }
  }
  return { min: (lo * m.footprint) / 2, max: (hi * m.footprint) / 2 };
}

interface SamplingNode { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: SamplingNode[] }

/** What a sampling heap profile holds live, by allocation site: the innermost frame and the first frame of engine code. */
function heapSites(head: SamplingNode): { totalMiB: number; byFrame: Array<[string, number]>; byEngineFrame: Array<[string, number]> } {
  const byFrame = new Map<string, number>();
  const byEngine = new Map<string, number>();
  let total = 0;
  const name = (f: SamplingNode['callFrame']) => `${f.functionName || '(anon)'} ${f.url.replace(/^.*\//, '')}:${f.lineNumber + 1}`;
  const walk = (n: SamplingNode, stack: SamplingNode['callFrame'][]) => {
    const here = [...stack, n.callFrame];
    if (n.selfSize > 0) {
      total += n.selfSize;
      const top = name(n.callFrame);
      byFrame.set(top, (byFrame.get(top) ?? 0) + n.selfSize);
      const engine = [...here].reverse().find((f) => /\/(game|play|assets|engine)[^/]*\.js|\.mjs|chunk-|voxel|three-adapter|game-host/.test(f.url) && !/three\.(webgpu|module|core)/.test(f.url));
      const e = engine === undefined ? `(no engine frame) ${top}` : `${name(engine)} <- ${top}`;
      byEngine.set(e, (byEngine.get(e) ?? 0) + n.selfSize);
    }
    for (const c of n.children) walk(c, here);
  };
  walk(head, []);
  const mib = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => [k, Number((v / 2 ** 20).toFixed(1))] as [string, number]);
  return { totalMiB: Number((total / 2 ** 20).toFixed(1)), byFrame: mib(byFrame), byEngineFrame: mib(byEngine) };
}

interface Hook {
  meter: { record(seconds: number): Promise<number[]> };
  farSolidAt(world: string, x: number, y: number, z: number): { level: number; inside: boolean } | null;
  stats(): { worlds: Record<string, { chunks: number; levels: number[]; far: { nodes: number; bricks: number; gpuBytes: number } }> };
}

/** The game the flight runs in: Play inside the editor, or an exported game. */
interface Game {
  /** The frame the game's page runs in (Play: the preview iframe). */
  readonly frame: Frame;
  /** The page whose screencast shows the game (Play: the editor's, the preview pinned over it). */
  readonly page: Page;
  debug(name: string): Promise<void>;
  /** The play's observation now (Play: the observe relay; an export: its own). */
  observe(): Promise<{ stepIndex?: number; counters?: Record<string, number> } | null>;
  /** The simulation's voxel world diagnostics (Play only: an export has no relay). */
  sim(): Promise<Record<string, any> | null>;
  screenshot(file: string): Promise<void>;
  stop(): Promise<void>;
}

async function openPlay(b: BenchApi, page: Page): Promise<Game> {
  await page.goto(`${ORIGIN}/?project=${PROJECT}&renderer=webgpu${QUERY}#token=${b.token}`);
  await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 60_000 });
  await page.addStyleTag({ content: `iframe.tl-app__preview-frame { position: fixed !important; left: 0 !important; top: 0 !important; width: ${VIEWPORT.width}px !important; height: ${VIEWPORT.height}px !important; z-index: 2147483647 !important; }` });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'), { timeout: 60_000 });
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const iframe = page.locator('iframe.tl-app__preview-frame');
  await page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first().waitFor({ timeout: 60_000 });
  const frame = (await (await iframe.elementHandle())!.contentFrame())!;
  const control = async (body: unknown): Promise<void> => {
    for (let i = 0; ; i++) {
      const r = await b.api(`play/${psid}/control`, body);
      if (r.status === 200) return;
      if ((r.json['error'] as { reason?: string } | undefined)?.reason !== 'not_presented' || i > 240) throw new Error(JSON.stringify(r.json));
      await page.waitForTimeout(250);
    }
  };
  await control({ command: 'setQuality', level: QUALITY });
  return {
    frame,
    page,
    debug: (name) => control({ command: 'debugCommand', name }),
    observe: async () => (await b.api(`play/${psid}/observe`, {})).json as { stepIndex?: number; counters?: Record<string, number> },
    sim: async () => ((((await b.api(`play/${psid}/diagnostics`, {})).json['diagnostics'] as { runtime?: { voxelWorlds?: Array<Record<string, unknown>> } } | undefined)?.runtime?.voxelWorlds ?? []).find((w) => w['world'] === WORLD) ?? null) as Record<string, any> | null,
    screenshot: async (file) => void (await iframe.screenshot({ path: file })),
    stop: () => control({ command: 'stop' }).catch(() => undefined),
  };
}

async function openExport(page: Page, url: string): Promise<Game> {
  await page.goto(`${url}/?renderer=webgpu&quality=${QUALITY}${QUERY}`);
  const canvas = page.locator('canvas#game');
  await canvas.waitFor({ timeout: 60_000 });
  return {
    frame: page.mainFrame(),
    page,
    debug: (name) => exportDebug(page, name),
    observe: () => page.evaluate(() => ((globalThis as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as { stepIndex?: number; counters?: Record<string, number> } | null),
    sim: async () => null,
    screenshot: async (file) => void (await page.screenshot({ path: file })),
    stop: async () => undefined,
  };
}

/** A screencast frame's checks: its key pixels at 320 × 180, its bottom rows' near-black share, the frame itself while a strip wants it. */
interface FrameCheck {
  /** Seconds since the flight started (the screencast's timestamp). */
  t: number;
  width: number;
  height: number;
  key: Uint8Array;
  dark: number;
  holes?: number;
}

/** The raw record of one flight: what the bench and the page saw, before the measures are worked out. */
interface FlightRecord {
  flyAt: number;
  flightS: number;
  intervals: number[];
  checks: FrameCheck[];
  polls: Array<{ t: number; m: number; far: { level: number; inside: boolean } | null; faceRays: number }>;
  obs: ObsSample[];
  sims: Array<{ w: number; s: Record<string, any> | null }>;
  recorded: Recorded | null;
  strip: Array<{ at: string; file: string }>;
  shots: Array<{ s: number; file: string; stats: unknown }>;
}

/** The camera at `m` metres along the line (the flight behaviour's own place for it). */
function cameraAt(path: CoveragePath, m: number): { x: number; y: number; z: number; yaw: number; pitch: number } {
  const p = along(path.waypoints, m);
  const f = Math.max(0, Math.min(path[ALTITUDE].length - 1.001, m / path.step));
  const k = Math.floor(f);
  const y = path[ALTITUDE][k]! + (path[ALTITUDE][k + 1]! - path[ALTITUDE][k]!) * (f - k);
  return { x: p.x, y, z: p.z, yaw: Math.atan2(-p.dx, -p.dz), pitch: PITCH };
}

async function fly(game: Game, cdp: CDPSession, path: CoveragePath, stopAt: number): Promise<FlightRecord> {
  const flightS = stopAt / SPEED;
  const rec: FlightRecord = { flyAt: Number.POSITIVE_INFINITY, flightS, intervals: [], checks: [], polls: [], obs: [], sims: [], recorded: null, strip: [], shots: [] };
  const strip = new Map(STRIP.map((s) => [s, s.startsWith('a') ? flightS + Number(s.slice(1)) : Number(s)] as const));
  const castName = (at: string) => join(SHOT_DIR, `${WHERE}-${QUALITY}-${SPEED}-${ALTITUDE}-${TAG}-strip-${at.startsWith('a') ? `after${at.slice(1)}` : `t${at}`}.png`);
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
    void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    const t = (f.metadata.timestamp ?? Date.now() / 1000) - rec.flyAt / 1000;
    if (t < 0) return;
    const bytes = Buffer.from(f.data, 'base64');
    const img = decodePng(bytes);
    const w = Math.floor(img.width / 2), h = Math.floor(img.height / 2);
    const key = new Uint8Array(Math.ceil((w * h) / 8));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = img.pixel(x * 2, y * 2);
      if (isKey(p[0], p[1], p[2])) key[(y * w + x) >> 3]! |= 1 << ((y * w + x) & 7);
    }
    rec.checks.push({ t, width: w, height: h, key, dark: bottomDarkShare(img.width, img.height, (x, y) => img.pixel(x, y), BOTTOM_ROWS) });
    for (const [at, s] of strip) if (t >= s) {
      const file = castName(at);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, bytes);
      rec.strip.push({ at, file });
      strip.delete(at);
    }
  });
  let polling = true;
  // The camera's place from the flight's distance (the probe's counter), and the view's rays against the far stand-ins.
  const poll = (async () => {
    while (polling) {
      const o = await game.observe().catch(() => null);
      if (o !== null && Number.isFinite(rec.flyAt)) {
        const w = Date.now();
        const c = Object.fromEntries(Object.entries(o.counters ?? {}).filter(([k]) => k.startsWith('probe_')));
        if (WHERE === 'play') rec.obs.push({ w, step: o.stepIndex ?? 0, c });
        const m = Math.min(stopAt, (c[PROBE_COUNTERS.m] ?? 0) / 100);
        const cam = cameraAt(path, m);
        const rays = viewRayPoints(cam, FOV_Y, VIEWPORT.width / VIEWPORT.height);
        const sampled = await game.frame
          .evaluate((a) => {
            const hook = (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay;
            const at = (x: number, y: number, z: number) => {
              const f = hook.farSolidAt(a.w, x, y, z);
              if (f === null) return null;
              const span = 16 * 2 ** f.level;
              return { level: f.level, node: `${f.level}:${Math.floor(x / span)},${Math.floor(y / span)},${Math.floor(z / span)}`, inside: f.inside };
            };
            return { eye: at(a.x, a.y, a.z), rays: a.rays.map((r) => Array.from({ length: r.length / 3 }, (_, k) => at(r[k * 3]!, r[k * 3 + 1]!, r[k * 3 + 2]!))) };
          }, { w: WORLD, x: cam.x, y: cam.y, z: cam.z, rays })
          .catch(() => null);
        const eye = sampled?.eye ?? null;
        const faceRays = sampled === null ? 0 : sampled.rays.filter((r) => entersAtFace(eye as FarSample, r as FarSample[])).length;
        rec.polls.push({ t: (w - rec.flyAt) / 1000, m, far: eye === null ? null : { level: eye.level, inside: eye.inside }, faceRays });
      }
      await game.page.waitForTimeout(250);
    }
  })();
  const simPoll = (async () => {
    while (polling) {
      if (Number.isFinite(rec.flyAt)) rec.sims.push({ w: Date.now(), s: await game.sim().catch(() => null) });
      await game.page.waitForTimeout(500);
    }
  })();
  await cdp.send('Page.startScreencast', { format: 'png', maxWidth: CAST.width, maxHeight: CAST.height, everyNthFrame: 1 });
  await game.frame.evaluate(installRecorder, { world: WORLD, observe: WHERE === 'export', keepMs: 50 });
  await game.page.waitForTimeout(500);
  const recording = game.frame.evaluate((s) => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.record(s), flightS);
  rec.flyAt = Date.now();
  await game.debug(`fly${SPEED}`);
  for (const s of SHOTS) {
    const wait = rec.flyAt + s * 1000 - Date.now();
    if (wait > 0) await game.page.waitForTimeout(wait);
    const file = join(SHOT_DIR, `${WHERE}-${QUALITY}-${SPEED}-${ALTITUDE}-${TAG}-t${s}.png`);
    mkdirSync(dirname(file), { recursive: true });
    await game.screenshot(file);
    rec.shots.push({ s, file, stats: null });
  }
  rec.intervals = await recording;
  for (const s of AFTER) {
    const wait = rec.flyAt + (flightS + s) * 1000 - Date.now();
    if (wait > 0) await game.page.waitForTimeout(wait);
    const file = join(SHOT_DIR, `${WHERE}-${QUALITY}-${SPEED}-${ALTITUDE}-${TAG}-after${s}.png`);
    mkdirSync(dirname(file), { recursive: true });
    await game.screenshot(file);
    rec.shots.push({ s: flightS + s, file, stats: null });
  }
  const rest = rec.flyAt + (flightS + HOLD_S) * 1000 - Date.now();
  if (rest > 0) await game.page.waitForTimeout(rest);
  await cdp.send('Page.stopScreencast');
  polling = false;
  await Promise.all([poll, simPoll]);
  rec.recorded = (await game.frame.evaluate(takeRecorded)) as Recorded | null;
  if (WHERE === 'export') rec.obs = rec.recorded?.obs ?? [];
  return rec;
}

/** The owner's measures from a flight's record. */
function travelMeasures(rec: FlightRecord): Record<string, unknown> {
  const frames = rec.recorded?.frames ?? [];
  const stopW = stopWall(rec.obs);
  const t0 = stopW ?? rec.flyAt + rec.flightS * 1000;
  // The page's counts after the stop, in seconds since it.
  const counts = (keys: readonly string[]): CountSample[] => frames.map((f) => ({ t: (f.t - t0) / 1000, v: keys.map((k) => f.counts[k] ?? 0) }));
  const NEAR = ['l0', 'kits'];
  const ALL = ['chunks', 'l0', 'l1', 'l2', 'kits', 'farNodes', 'farBricks'];
  const detailS = settleAfter(counts(NEAR), 0, NEAR_STILL, SETTLE_HOLD_S);
  const viewS = settleAfter(counts(ALL), 0, ALL.map((k) => (k.startsWith('far') ? FAR_STILL : NEAR_STILL)), SETTLE_HOLD_S);
  // Play: the simulation's own pending work (the job queue, far work) at zero and staying there.
  const simPending: CountSample[] = rec.sims.filter((s) => s.s !== null).map((s) => ({ t: (s.w - t0) / 1000, v: [Number(s.s!['pool']?.queued ?? 0), Number(s.s!['pool']?.inFlight ?? 0), Number(s.s!['far']?.pending ?? 0)] }));
  const lastPending = simPending.at(-1)?.v ?? [];
  const simIdleS = simPending.length === 0 ? null : lastPending.every((x) => x === 0) ? settleAfter(simPending, 0, { share: 0, abs: 0 }, SETTLE_HOLD_S) : null;
  const probe = rayAndBody(rec.obs.at(-1));
  const body = bodySamples(rec.obs, rec.flyAt);
  const falls = dropOutcomes(body);
  // The stop's drop: when the engine let the body move (not suspended), and its readings every half second.
  const stopT = (t0 - rec.flyAt) / 1000;
  const lastDrop = body.at(-1)?.drop ?? 0;
  const atStop = body.filter((x) => x.drop === lastDrop && x.t >= stopT);
  const bodyFreeS = firstAfter(atStop, stopT, (x) => !x.suspended);
  const trace = atStop.filter((x, i) => i === 0 || Math.floor((x.t - stopT) * 2) !== Math.floor((atStop[i - 1]!.t - stopT) * 2)).map((x) => ({ t: Number((x.t - stopT).toFixed(2)), y: x.y, g: x.grounded ? 1 : 0, s: x.suspended ? 1 : 0 }));
  const end = rec.obs.at(-1)?.c ?? {};
  return {
    flight: flightFrames(rec.intervals, CAP, rec.flightS),
    stopAtS: stopW === null ? null : Number(((stopW - rec.flyAt) / 1000).toFixed(2)),
    afterStop: { groundSolidS: probe.raySolidAfterStopS, bodyStandsS: probe.bodyStandsAfterStopS, bodyFreeS, detailS, nothingPendingS: viewS, simIdleS, holdS: HOLD_S, settleHoldS: SETTLE_HOLD_S },
    groundRay: { steps: probe.raySteps, solid: probe.solidShare, noHit: probe.noneShare, deep: probe.deepShare },
    falls: { ...falls, events: falls.events.slice(0, 20), stopTrace: trace.slice(0, 80), bodyEnd: { y: (end[PROBE_COUNTERS.bodyY] ?? 0) / 100, grounded: end[PROBE_COUNTERS.grounded] === 1, suspended: end[PROBE_COUNTERS.suspended] === 1 } },
  };
}

/** The long gaps in flight and what landed in them. */
function spikes(rec: FlightRecord): Record<string, unknown> {
  const end = rec.flyAt + rec.flightS * 1000;
  const frames = (rec.recorded?.frames ?? []).filter((f) => f.t >= rec.flyAt && f.t <= end);
  const long = rec.recorded?.long ?? [];
  const gaps = longGaps(frames, long);
  // A page that reported no long frame at all (Play's preview frame reports none) gives no cause: its gaps are unattributed, not off the thread.
  const causes = spikeCauses(gaps).map((c) => (long.length === 0 && c.cause === 'off-thread' ? { ...c, cause: 'unattributed (no long-frame timing)' } : c));
  return {
    pageFrames: frames.length,
    longFrames: (rec.recorded?.long ?? []).filter((f) => f.t >= rec.flyAt && f.t <= end).length,
    causes,
    worst: [...gaps].sort((a, b) => b.ms - a.ms).slice(0, 12).map((g) => ({ t: Number(((g.t - rec.flyAt) / 1000).toFixed(2)), ms: g.ms, frame: g.frame, delta: g.delta })),
  };
}

/** Holes in flight (frames with key pixels below the ground row, per km and as events), the camera in a stand-in, the bottom rows' dark share. */
function pictureChecks(rec: FlightRecord, path: CoveragePath, stopAt: number): Record<string, unknown> {
  const mAtTime = (t: number): number => {
    const i = rec.polls.findIndex((p) => p.t >= t);
    if (i <= 0) return rec.polls[0]?.m ?? 0;
    const a = rec.polls[i - 1]!, b = rec.polls[i]!;
    return a.m + ((b.m - a.m) * (t - a.t)) / Math.max(1e-3, b.t - a.t);
  };
  const bounds = worldBounds();
  for (const c of rec.checks) {
    const mask = groundMask(c.width, c.height, cameraAt(path, Math.min(stopAt, mAtTime(c.t))), FOV_Y, bounds, FLOOR_Y);
    let n = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i] === 1 && (c.key[i >> 3]! & (1 << (i & 7))) !== 0) n++;
    c.holes = n;
  }
  const inFlight = rec.checks.filter((c) => c.t <= rec.flightS);
  const holes = inFlight.filter((c) => (c.holes ?? 0) >= HOLE_PIXELS);
  const events: Array<{ t: number; m: number; frames: number; worstKey: number }> = [];
  for (const h of holes) {
    const e = events.at(-1);
    if (e !== undefined && h.t - (e.t + e.frames / CAP.fps) < 0.25) {
      e.frames++;
      e.worstKey = Math.max(e.worstKey, h.holes ?? 0);
    } else events.push({ t: Number(h.t.toFixed(2)), m: Math.round(mAtTime(h.t)), frames: 1, worstKey: h.holes ?? 0 });
  }
  const km = stopAt / 1000;
  const polls = rec.polls.filter((p) => p.t <= rec.flightS);
  const inside = polls.filter((p) => p.far?.inside === true);
  const facing = polls.filter((p) => p.faceRays > 0);
  const after = rec.checks.filter((c) => c.t > rec.flightS);
  const darkOf = (cs: FrameCheck[]) => ({ frames: cs.length, dark: cs.filter((c) => c.dark > BOTTOM_DARK_FRAME).length, max: Number(Math.max(0, ...cs.map((c) => c.dark)).toFixed(3)), where: cs.filter((c) => c.dark > BOTTOM_DARK_FRAME).slice(0, 20).map((c) => ({ t: Number(c.t.toFixed(2)), share: Number(c.dark.toFixed(3)) })) });
  return {
    holes: { checked: inFlight.length, holeFrames: holes.length, perKm: Number((holes.length / km).toFixed(2)), events: events.length, eventsPerKm: Number((events.length / km).toFixed(2)), where: events.slice(0, 60), worstKey: Math.max(0, ...inFlight.map((c) => c.holes ?? 0)), afterStop: after.filter((c) => (c.holes ?? 0) >= HOLE_PIXELS).length },
    bottomDark: { rows: BOTTOM_ROWS, of: CAST.height, frameShare: BOTTOM_DARK_FRAME, flight: darkOf(inFlight), afterStop: darkOf(after) },
    viewInStandIn: { samples: polls.length, rays: VIEW_RAYS.cols * VIEW_RAYS.rows, withRays: facing.length, faceRays: facing.reduce((n, p) => n + p.faceRays, 0), where: facing.slice(0, 30).map((p) => ({ t: Number(p.t.toFixed(2)), m: Math.round(p.m), rays: p.faceRays })) },
    inStandIn: { samples: polls.length, inside: inside.length, where: inside.slice(0, 30).map((p) => ({ t: Number(p.t.toFixed(2)), m: Math.round(p.m), level: p.far!.level })), farLevelAtEye: Object.fromEntries([...new Set(polls.map((p) => String(p.far?.level ?? 'none')))].map((k) => [k, polls.filter((p) => String(p.far?.level ?? 'none') === k).length])) },
  };
}

/** The simulation's streaming in flight and after the stop (Play): queue depths, far work, the counters' growth. */
function simSummary(rec: FlightRecord): Record<string, unknown> | null {
  const s = rec.sims.filter((x) => x.s !== null);
  if (s.length === 0) return null;
  const end = rec.flyAt + rec.flightS * 1000;
  const flight = s.filter((x) => x.w <= end);
  const stat = (xs: number[]) => (xs.length === 0 ? null : { mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length), max: Math.max(...xs) });
  const counters = (x: (typeof s)[number] | undefined) => (x?.s?.['stream']?.['counters'] ?? null) as Record<string, number> | null;
  const grow = (a: Record<string, number> | null, b: Record<string, number> | null) => (a === null || b === null ? null : Object.fromEntries(Object.keys(b).filter((k) => typeof b[k] === 'number').map((k) => [k, b[k]! - (a[k] ?? 0)])));
  return {
    flightQueued: stat(flight.map((x) => Number(x.s!['pool']?.queued ?? 0))),
    flightInFlight: stat(flight.map((x) => Number(x.s!['pool']?.inFlight ?? 0))),
    flightFarPending: stat(flight.map((x) => Number(x.s!['far']?.pending ?? 0))),
    flightCounters: grow(counters(flight[0]), counters(flight.at(-1))),
    afterCounters: grow(counters(flight.at(-1)), counters(s.at(-1))),
    afterPending: s.filter((x) => x.w > end).map((x) => ({ t: Number(((x.w - end) / 1000).toFixed(1)), queued: x.s!['pool']?.queued, inFlight: x.s!['pool']?.inFlight, farPending: x.s!['far']?.pending })).filter((_, i) => i % 2 === 0),
    coverageEnd: s.at(-1)!.s!['coverage'] ?? null,
    pool: s.at(-1)!.s!['pool'] ?? null,
  };
}

/** Prepares the project for a run (the key sky, the camera's flight, the probe character) and gives back what puts it back. */
async function prepare(b: BenchApi, path: CoveragePath, stopAt: number): Promise<() => Promise<void>> {
  const sceneFile = join(PROJECT_DIR, 'scenes', 'scene-main.json');
  const scene = JSON.parse(readFileSync(sceneFile, 'utf8')).scene as { environment: Record<string, unknown> & { sky?: Record<string, unknown> }; entities: Array<{ id: string; name: string; components: Record<string, { behaviorId?: string }> }> };
  const look = scene.environment;
  const cam = scene.entities.find((e) => e.name === 'Perf far camera');
  const behaviourBefore = cam?.components['behavior']?.behaviorId ?? null;
  const ground = groundAlong(path, farGround(PROJECT_DIR, WORLD), PROBE.step);
  await b.command('setEnvironment', { environment: { quality: QUALITY, qualityLevels: DEFAULT_QUALITY_LEVELS } });
  await b.command('setEnvironment', { sceneId: 'scene-main', environment: { ...look, sky: { ...(look.sky ?? {}), mode: 'color', color: '#ff00ff' } } });
  await publishCameraBehaviour(b, PROJECT_DIR, BEHAVIOR, flightSource({ path, altitude: ALTITUDE, total: stopAt, pitch: PITCH, flights: FLIGHTS, probe: { ground, ...PROBE } }));
  // The probe character where the camera starts: the world streams round it there anyway.
  await addProbeBody(b, PROJECT_DIR, [WAYPOINTS[0]![0], ground[0]! + PROBE.dropAboveM, WAYPOINTS[0]![1]]);
  return async () => {
    await b.command('setEnvironment', { sceneId: 'scene-main', environment: look }).catch((e: unknown) => console.error(`look not put back: ${String(e)}`));
    await removeProbeBody(b, PROJECT_DIR).catch((e: unknown) => console.error(`probe character not taken out: ${String(e)}`));
    if (behaviourBefore !== null && behaviourBefore !== BEHAVIOR && cam !== undefined) await b.command('setBehaviorProperties', { entityId: cam.id, behaviorId: behaviourBefore, values: {} }).catch(() => undefined);
  };
}

/** `--export`: the project prepared and exported (debug console on), then put back. Prints the export's folder. */
async function exportProject(path: CoveragePath, stopAt: number): Promise<void> {
  const b = bench();
  const settings = (JSON.parse(readFileSync(join(PROJECT_DIR, 'content.json'), 'utf8')) as { content: { settings?: Record<string, unknown> } }).content.settings ?? {};
  const restore = await prepare(b, path, stopAt);
  await b.command('setSettings', { settings: { debug_console: 1 } });
  try {
    const exported = await b.api(`admin/projects/${PROJECT}/export`);
    if (exported.status !== 200) throw new Error(`export ${exported.status}: ${JSON.stringify(exported.json).slice(0, 400)}`);
    console.log(`coverage: exported, ${ALTITUDE}, line ${(path.total / 1000).toFixed(2)} km, stop at ${stopAt} m; flights ${Object.keys(FLIGHTS).join(', ')}`);
    console.log(`coverage: ${join(DATA_ROOT, 'exports', String(exported.json['outputDir']))}`);
  } finally {
    await b.command('setSettings', { settings: { debug_console: settings['debug_console'] ?? 0 } }).catch((e: unknown) => console.error(`console setting not put back: ${String(e)}`));
    await restore();
  }
}

async function run(path: CoveragePath, stopAt: number): Promise<Record<string, unknown>> {
  const host = () => ({ at: new Date().toISOString(), uptimeDays: Number((uptime() / 86400).toFixed(2)), load: loadavg().map((x) => Number(x.toFixed(2))) });
  const out: Record<string, unknown> = { bench: 'coverage', where: WHERE, quality: QUALITY, speed: SPEED, altitude: ALTITUDE, renderer: 'webgpu', viewport: VIEWPORT, cap: CAP.fps, km: path.total / 1000, flightS: stopAt / SPEED, start: host() };
  console.log(`coverage: ${WHERE}, ${QUALITY}, ${SPEED} m/s, ${ALTITUDE}: ${(stopAt / 1000).toFixed(2)} km in ${(stopAt / SPEED).toFixed(1)} s; ground ${Math.min(...path.ground)}–${Math.max(...path.ground)} m`);
  const b = WHERE === 'play' ? bench() : null;
  const restore = b === null ? null : await prepare(b, path, stopAt);
  if (WHERE === 'export' && !existsSync(join(EXPORT_DIR, 'manifest.json'))) throw new Error(`no export at "${EXPORT_DIR}" (--dir: the folder --export printed)`);
  const site = WHERE === 'export' ? await serveStatic(EXPORT_DIR) : null;
  let browser: Browser | null = null;
  try {
    browser = await launchGpuBrowser({ vsync: true });
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)));
    page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text().slice(0, 200))));
    const game = b !== null ? await openPlay(b, page) : await openExport(page, site!.url);
    // Play holds the camera at the line's start on `start`; an export's camera starts there (its console takes commands once the game runs).
    if (WHERE === 'play') await game.debug('start');
    const stats = () => game.frame.evaluate((w) => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.stats().worlds[w] ?? null, WORLD);
    const cdpBrowser = await browser.newBrowserCDPSession();
    const memory = async () => {
      const m = await processMemory(cdpBrowser);
      const heap = (collect: boolean) => game.frame.evaluate((c) => {
        if (c) (globalThis as unknown as { gc?: () => void }).gc?.();
        return Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20);
      }, collect);
      return { pageHeapMiB: await heap(false), pageHeapLiveMiB: await heap(true), ...m, farGpuMiB: Math.round(((await stats())?.far.gpuBytes ?? 0) / 2 ** 20) };
    };
    // The fill at the line's start: until the far field drawn stays within 2 % for 5 s (FarSettle).
    const T0 = Date.now();
    const settle = new FarSettle();
    for (;;) {
      if (settle.step((await stats())?.far, Date.now())) break;
      if (Date.now() - T0 > 420_000) throw new Error('the far field did not settle in 7 min');
      await page.waitForTimeout(250);
    }
    out['fillS'] = Number(((settle.since - T0) / 1000).toFixed(1));
    // The backend the game draws with once it draws (WebGPU expected; a fallback would measure another renderer).
    out['renderer'] = await game.frame.evaluate(() => { const c = document.querySelector('canvas[data-tl-renderer]'); return `${c?.getAttribute('data-tl-renderer')}/${c?.getAttribute('data-tl-renderer-state')}`; });
    out['memoryStart'] = await memory();
    const heapCdp = HEAP_PROFILE ? await context.newCDPSession(page) : null;
    if (heapCdp !== null) await heapCdp.send('HeapProfiler.startSampling', { samplingInterval: 16384 });
    const heapAt = async (label: string): Promise<void> => {
      if (heapCdp === null) return;
      await game.frame.evaluate(() => (globalThis as unknown as { gc?: () => void }).gc?.());
      const { profile } = (await heapCdp.send('HeapProfiler.getSamplingProfile')) as { profile: { head: SamplingNode } };
      const file = OUT.replace(/\.json$/, `.heap-${label}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ label, sites: heapSites(profile.head) }, null, 1));
      if (HEAP_SNAPSHOT.includes(label)) {
        const fd = openSync(file.replace(/\.json$/, '.heapsnapshot'), 'w');
        const onChunk = (e: { chunk: string }) => void writeSync(fd, e.chunk);
        heapCdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
        await heapCdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
        heapCdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
        closeSync(fd);
      }
      writeFileSync(file.replace(/\.json$/, '.profile.json'), JSON.stringify(profile));
      ((out['heapProfiles'] ??= {}) as Record<string, string>)[label] = file;
    };
    await heapAt('start');
    const simStart = await game.sim();
    out['simStart'] = simStart === null ? null : { far: simStart['far'] ?? null, coverage: simStart['coverage'] ?? null, counters: simStart['stream']?.['counters'] ?? null, pool: simStart['pool'] ?? null };
    const rec = await fly(game, await context.newCDPSession(page), path, stopAt);
    out['memoryEnd'] = await memory();
    await heapAt('end');
    out['drawnEnd'] = await stats();
    // How the page made the swaps' draws: batches made over several frames, the most frames one took, the longest commit and step (ms).
    out['staging'] = await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: { stats(): { staging?: unknown } } }).__tlVoxelPlay?.stats().staging ?? null);
    if (RETURN_S > 0) {
      await game.debug('start');
      await page.waitForTimeout(RETURN_S * 1000);
      out['memoryReturn'] = await memory();
      await heapAt('return');
      out['drawnReturn'] = await stats();
    }
    out['travel'] = travelMeasures(rec);
    out['spikes'] = spikes(rec);
    Object.assign(out, pictureChecks(rec, path, stopAt));
    out['sim'] = simSummary(rec);
    out['strip'] = rec.strip;
    out['shots'] = rec.shots;
    out['errors'] = errors.slice(0, 5);
    if (QUALITY === 'low') out['budget'] = LOW_MEMORY_BUDGET_MIB;
    await game.stop();
  } catch (e) {
    out['error'] = String(e).slice(0, 600);
    console.error(out['error']);
  } finally {
    await browser?.close().catch(() => undefined);
    await site?.close();
    await restore?.();
  }
  out['end'] = host();
  return out;
}

async function main(): Promise<void> {
  const path = coveragePath(WAYPOINTS, farGround(PROJECT_DIR, WORLD));
  const stopAt = Math.min(path.total, PARK);
  if (process.argv.includes('--export')) {
    await exportProject(path, stopAt);
    return;
  }
  const out = await run(path, stopAt);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  const t = out['travel'] as { flight?: unknown; afterStop?: unknown; falls?: { drops: number; fellThrough: number } } | undefined;
  const h = out['holes'] as { holeFrames: number; checked: number } | undefined;
  console.log(`flight ${JSON.stringify(t?.flight ?? null)}; after stop ${JSON.stringify(t?.afterStop ?? null)}; falls ${t?.falls?.fellThrough}/${t?.falls?.drops}; holes ${h?.holeFrames}/${h?.checked}`);
  console.log(`coverage: ${OUT}`);
  process.exit(out['error'] === undefined ? 0 : 1);
}

await main();
