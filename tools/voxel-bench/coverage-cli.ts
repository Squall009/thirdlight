/**
 * The coverage bench (`node tools/voxel-bench/run.mjs coverage …`): whether a
 * voxel world is kept round a camera travelling at racing speed (the owner's
 * 150 m/s), at whatever quality is streamed in. The pass criterion is
 * coverage, not detail or missed frames: no hole, no missing ground or
 * collision under the camera.
 *
 * Runs Play in the editor on a running backend (staging: `tools/staging.sh
 * start`; the 8 km world of `run.mjs far-world` in project voxel-slice),
 * WebGPU, 1280 × 720, the quality level's own cap (low: 30 Hz). The camera
 * (the project's "Perf far camera" object, given this bench's behaviour)
 * flies a ~9.8 km line over the world: the east lowland, the town, up the
 * massif's cliffs, the west valleys and into the eastern mountains, 30 m over
 * the highest ground near it (`--altitude high`) or 5 m over it (`hug`), looking
 * along its heading 0.08 rad down. The line's ground is read from the world's
 * far cache on disk (level 2). The scene's sky is drawn as a key colour
 * (magenta) for the run and put back after.
 *
 * Every frame the page presents is checked (the browser's screencast, 320 ×
 * 180): a key pixel whose ray falls to the world's lowest ground inside the
 * world's bounds is a hole (the ground is a height field over the whole
 * world, so that ray meets it; a ray leaving the world first may see sky).
 * The camera of each frame is taken from position polls (4 a second).
 * The simulation's far world reports, every update, whether the ground under
 * the camera and a second ahead of it is in its collision (derived chunks from
 * the camera down to the first solid), and whether the camera is inside a
 * drawn far stand-in's solid (`coverage` in its diagnostics). Also recorded:
 * missed frames at the cap, page heap and GPU process memory against the low
 * tier's ceiling, far swaps and what is pending, and full-size pictures at
 * `--shots` seconds into the flight.
 *
 *   --origin URL  --token-file FILE  --data-root DIR (default ~/thirdlight-staging-p45)  --project ID (voxel-slice)
 *   --quality LEVEL (default low)   --speed M/S (default 150)   --altitude high|hug (default high)
 *   --shots LIST  seconds into the flight to save full-size frames (default none)   --shot-dir DIR
 *   --park M      stop the flight M metres along the line   --after LIST  seconds after the flight to save frames at
 *   --return S    after the flight, put the camera back at the line's start and read memory again S seconds on
 *                 (what a flight leaves held once the camera is home: retention, not working set)
 *   --heap-profile  sample the page's heap allocations from the start reading on and write, at each later reading,
 *                 what is still live by allocation site (`<out>.heap-<reading>.json`; whole profile beside it)
 *   --heap-snapshot LIST  readings (start,end,return) a full heap snapshot is also written at (`.heapsnapshot`)
 *   --tag NAME   --out FILE (default ~/.cache/thirdlight-voxel-bench/coverage/<quality>-<speed>-<altitude>-<tag>.json)
 *
 * How to (staging running with the 8 km world, nothing else on the GPU):
 *
 *   sudo -n systemd-run --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 -- sudo -n -u $USER -- \
 *     env HOME=$HOME PATH=$PATH TMPDIR=$HOME/.cache/tmp/coverage node tools/voxel-bench/run.mjs coverage --speed 150
 *
 * Read `holes` (frames with a hole, per km, and where), `ground` (updates without collision under / ahead of the
 * camera), `inStandIn`, `frames`, `memory`, `far`. Not part of `npm test`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { DEFAULT_QUALITY_LEVELS, LOW_MEMORY_CEILING_MIB } from '@thirdlight/project-model';
import { chunkGrid, createDenseChunk, decodeDenseChunk, regionChunkCodecBytes } from '@thirdlight/voxel';
import { FarCacheReader, zstdDecompress } from '@thirdlight/workspace';
import { decodePng } from '../../tests/e2e/png';
import { launchGpuBrowser } from '../perf/frame-run';
import { benchDir } from './bench-dirs';
import { along, coveragePath, distanceAlong, groundMask, isKey, type CoveragePath } from './coverage';
import { frameCap, frameWindow } from './headroom';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}

const ORIGIN = arg('origin', 'http://127.0.0.1:4180');
const DATA_ROOT = arg('data-root', join(homedir(), 'thirdlight-staging-p45'));
const TOKEN = readFileSync(arg('token-file', join(DATA_ROOT, 'owner-token')), 'utf8').trim();
const PROJECT = arg('project', 'voxel-slice');
const WORLD = 'far';
const QUALITY = arg('quality', 'low');
const SPEED = Number(arg('speed', '150'));
const ALTITUDE = arg('altitude', 'high') as 'high' | 'hug';
/** Metres along the line the flight stops at (default its end): a hole seen in flight is looked at again standing there. */
const PARK = Number(arg('park', 'Infinity'));
/** Seconds after the flight a frame is saved at (with `--park`: whether a hole fills once the camera stands). */
const AFTER = arg('after', '').split(',').filter((s) => s !== '').map(Number);
const RETURN_S = Number(arg('return', '0'));
const HEAP_PROFILE = process.argv.includes('--heap-profile');
/** Readings (start, end, return) a full heap snapshot is written at too, with `--heap-profile`. */
const HEAP_SNAPSHOT = arg('heap-snapshot', '').split(',').filter((s) => s !== '');
const SHOTS = arg('shots', '').split(',').filter((s) => s !== '').map(Number);
const SHOT_DIR = arg('shot-dir', benchDir('coverage'));
const TAG = arg('tag', new Date().toISOString().slice(0, 16).replace(/[:T]/g, ''));
const OUT = arg('out', join(benchDir('coverage'), `${QUALITY}-${SPEED}-${ALTITUDE}-${TAG}.json`));
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
const BEHAVIOR = 'coverage-flight';

const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', origin: ORIGIN };
async function api(path: string, body: unknown = {}, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/${path}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const revision = async (): Promise<number> => Number((await api('commands', { op: 'queryProject', projectId: PROJECT, args: {} })).json['revision']);
async function command(op: string, args: unknown): Promise<void> {
  const r = await api('commands', { op, projectId: PROJECT, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'voxel-bench-coverage' }, args });
  const error = r.json['error'] as { code?: string } | undefined;
  if (r.json['ok'] !== true && error?.code !== 'no_change') throw new Error(`${op}: ${JSON.stringify(r.json).slice(0, 400)}`);
}

/** The ground (metres) at (x, z): the top solid cell of the far cache's level-2 nodes (2 m cells). */
function farGround(): (x: number, z: number) => number {
  const cache = new FarCacheReader(join(DATA_ROOT, 'projects', PROJECT, 'cache', 'voxel-far', WORLD));
  const g = chunkGrid(32);
  const L = 2, span = 32 << L;
  const d = createDenseChunk(g);
  return (xm, zm) => {
    const xc = xm * 2, zc = zm * 2;
    const nx = Math.floor(xc / span), nz = Math.floor(zc / span);
    const ix = Math.floor((xc - nx * span) / (1 << L)), iz = Math.floor((zc - nz * span) / (1 << L));
    for (let ny = 30; ny >= -2; ny--) {
      const e = cache.entry({ level: L, nx, ny, nz }) as { uniform?: unknown; stored?: Uint8Array; raw?: number } | null;
      if (e === null) continue;
      if ('uniform' in e) return ((ny + 1) * span) / 2;
      const codec = regionChunkCodecBytes(g, { cx: 0, cy: 0, cz: 0, kind: 'stored', bytes: e.stored!, raw: e.raw! } as never, zstdDecompress);
      if (codec === null) continue;
      decodeDenseChunk(g, codec, d);
      for (let y = 31; y >= 0; y--) {
        const li = (ix << 10) | (iz << 5) | y;
        if (d.material[li] !== 0) return (ny * span + (y + d.shape[li]! / 15) * (1 << L)) / 2;
      }
    }
    return 0;
  };
}

/** The world's extent in x and z (metres) from its region files' names (`r.<x>.<y>.<z>.vxr`, `footprint` cells a side). */
function worldBounds(): { min: number; max: number } {
  const m = JSON.parse(readFileSync(join(DATA_ROOT, 'projects', PROJECT, 'voxels', WORLD, 'world.json'), 'utf8')) as { footprint: number; regions: string[] };
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

/** The flight behaviour: holds the line's start until `fly`, then `speed` m/s along it (the 120 Hz step), then holds its end. */
function flightSource(path: CoveragePath): string {
  return `
const WP = ${JSON.stringify(path.waypoints)};
const ALT = ${JSON.stringify(path[ALTITUDE])};
const STEP = ${path.step}, TOTAL = ${Math.min(path.total, PARK)}, SPEED = ${SPEED}, PITCH = ${PITCH};
const quat = (yaw: number, pitch: number) => { const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };
const along = (m: number) => { let r = Math.max(0, m); for (let i = 1; i < WP.length; i++) { const a = WP[i - 1]!, b = WP[i]!; const len = Math.hypot(b[0] - a[0], b[1] - a[1]); const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len; if (r <= len || i === WP.length - 1) { const t = Math.min(r, len); return { x: a[0] + dx * t, z: a[1] + dz * t, dx, dz }; } r -= len; } return { x: WP[0][0], z: WP[0][1], dx: 1, dz: 0 }; };
const altAt = (m: number) => { const f = Math.max(0, Math.min(ALT.length - 1.001, m / STEP)); const i = Math.floor(f); return ALT[i]! + (ALT[i + 1]! - ALT[i]!) * (f - i); };
export default {
  prepare() { return {}; },
  instantiate() { return { m: 0, flying: false }; },
  step(s: any, ctx: any) {
    if (ctx.phase === 'intent') {
      for (const _ of ctx.debug.command('fly')) { s.m = 0; s.flying = true; }
      for (const _ of ctx.debug.command('start')) { s.m = 0; s.flying = false; }
      return;
    }
    if (ctx.phase !== 'transform') return;
    if (s.flying) s.m = Math.min(TOTAL, s.m + SPEED / 120);
    const p = along(s.m);
    const yaw = Math.atan2(-p.dx, -p.dz);
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: p.x, y: altAt(s.m), z: p.z }, quaternion: quat(yaw, PITCH) });
  },
  dispose() {},
};
`;
}

async function flightCamera(source: string): Promise<void> {
  const entities = JSON.parse(readFileSync(join(DATA_ROOT, 'projects', PROJECT, 'scenes', 'scene-main.json'), 'utf8')).scene.entities as Array<{ id: string; name: string }>;
  const cam = entities.find((e) => e.name === 'Perf far camera');
  if (cam === undefined) throw new Error('no "Perf far camera" object in the project (the far-field runs make it)');
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: ['@self'], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stageId = String((await api('content/stages')).json['stageId']);
  const put = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/content/stages/${stageId}/bytes`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  if (put.status !== 200) throw new Error(`stage ${put.status}`);
  const declaration = { properties: [] };
  await command('publishBehavior', { behaviorId: BEHAVIOR, displayName: BEHAVIOR, mode: 'declaration-create', declaration }).catch((e: unknown) => {
    if (!String(e).includes('behavior_id_duplicate')) throw e;
  });
  await command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const pub = await api('content/behaviors/source', { stageId, behaviorId: BEHAVIOR, displayName: BEHAVIOR, declaration, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}` });
  if (pub.status !== 200) throw new Error(`publish ${JSON.stringify(pub.json).slice(0, 300)}`);
  await command('setBehaviorProperties', { entityId: cam.id, behaviorId: BEHAVIOR, values: {} });
}

/** The GPU process's resident memory as its driver counts it (MiB, summed over its DRM fds). */
function gpuResidentMiB(pid: number): number {
  let kib = 0;
  for (const fd of readdirSync(`/proc/${pid}/fdinfo`)) {
    let text = '';
    try {
      text = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('drm-driver')) continue;
    for (const line of text.split('\n')) {
      const m = /^drm-resident-[\w-]+:\s+(\d+)\s*(KiB|MiB)?/.exec(line);
      if (m !== null) kib += Number(m[1]) * (m[2] === 'MiB' ? 1024 : 1);
    }
  }
  return Math.round(kib / 1024);
}

/** A process's resident set (MiB): the renderer's counts its workers (the simulation, the voxel jobs) beside the page. */
function rssMiB(pid: number): number {
  try {
    const m = /^VmRSS:\s+(\d+) kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m === null ? 0 : Math.round(Number(m[1]) / 1024);
  } catch {
    return 0;
  }
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

async function openPlay(page: Page): Promise<{ canvas: Locator; frame: Locator; psid: string; control: (body: unknown) => Promise<void> }> {
  await page.goto(`${ORIGIN}/?project=${PROJECT}&renderer=webgpu#token=${TOKEN}`);
  await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 60_000 });
  await page.addStyleTag({ content: `iframe.tl-app__preview-frame { position: fixed !important; left: 0 !important; top: 0 !important; width: ${VIEWPORT.width}px !important; height: ${VIEWPORT.height}px !important; z-index: 2147483647 !important; }` });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'), { timeout: 60_000 });
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  await canvas.waitFor({ timeout: 60_000 });
  const control = async (body: unknown): Promise<void> => {
    for (let i = 0; ; i++) {
      const r = await api(`play/${psid}/control`, body);
      if (r.status === 200) return;
      if ((r.json['error'] as { reason?: string } | undefined)?.reason !== 'not_presented' || i > 240) throw new Error(JSON.stringify(r.json));
      await page.waitForTimeout(250);
    }
  };
  return { canvas, frame, psid, control };
}

interface FrameCheck {
  /** Seconds since the flight started (the screencast's timestamp). */
  t: number;
  width: number;
  height: number;
  /** Its key pixels, a bit each, row-major. */
  key: Uint8Array;
  /** Key pixels where the ground must show (filled in after the flight, from the camera's place then). */
  holes?: number;
}

async function main(): Promise<void> {
  const host = () => ({ at: new Date().toISOString(), uptimeDays: Number((uptime() / 86400).toFixed(2)), load: loadavg().map((x) => Number(x.toFixed(2))) });
  const path = coveragePath(WAYPOINTS, farGround());
  const stopAt = Math.min(path.total, PARK);
  const flightS = stopAt / SPEED;
  const out: Record<string, unknown> = { bench: 'coverage', quality: QUALITY, speed: SPEED, altitude: ALTITUDE, renderer: 'webgpu', viewport: VIEWPORT, cap: CAP.fps, km: path.total / 1000, flightS, start: host() };
  console.log(`coverage: ${QUALITY}, ${SPEED} m/s, ${ALTITUDE}: ${(path.total / 1000).toFixed(2)} km in ${flightS.toFixed(1)} s; ground ${Math.min(...path.ground)}–${Math.max(...path.ground)} m`);
  const sceneFile = join(DATA_ROOT, 'projects', PROJECT, 'scenes', 'scene-main.json');
  const look = JSON.parse(readFileSync(sceneFile, 'utf8')).scene.environment as Record<string, unknown> & { sky?: Record<string, unknown> };
  await command('setEnvironment', { environment: { quality: QUALITY, qualityLevels: DEFAULT_QUALITY_LEVELS } });
  await command('setEnvironment', { sceneId: 'scene-main', environment: { ...look, sky: { ...(look.sky ?? {}), mode: 'color', color: '#ff00ff' } } });
  await flightCamera(flightSource(path));
  const browser = await launchGpuBrowser({ vsync: true });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text().slice(0, 200))));
    const { canvas, frame, psid, control } = await openPlay(page);
    await control({ command: 'setQuality', level: QUALITY });
    await control({ command: 'debugCommand', name: 'start' });
    const stats = () => canvas.evaluate((_c, w) => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.stats().worlds[w] ?? null, WORLD);
    const sim = async () => ((((await api(`play/${psid}/diagnostics`, {})).json['diagnostics'] as { runtime?: { voxelWorlds?: Array<Record<string, unknown>> } } | undefined)?.runtime?.voxelWorlds ?? []).find((w) => w['world'] === WORLD) ?? null) as Record<string, any> | null;
    const cdpBrowser = await browser.newBrowserCDPSession();
    const memory = async () => {
      const info = (await cdpBrowser.send('SystemInfo.getProcessInfo')) as { processInfo: Array<{ type: string; id: number }> };
      const pid = info.processInfo.find((p) => p.type === 'GPU')?.id;
      const rendererRssMiB = info.processInfo.filter((p) => p.type === 'renderer').reduce((n, p) => n + rssMiB(p.id), 0);
      const gpuProcessRssMiB = pid === undefined ? null : rssMiB(pid);
      const pageHeapMiB = await canvas.evaluate(() => Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20));
      const gpuMiB = pid === undefined ? null : gpuResidentMiB(pid);
      // What the heap holds once garbage is collected (the page's own heap reading counts garbage not yet collected).
      const pageHeapLiveMiB = await canvas.evaluate(() => {
        (globalThis as unknown as { gc?: () => void }).gc?.();
        return Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20);
      });
      return { pageHeapMiB, pageHeapLiveMiB, gpuMiB, rendererRssMiB, gpuProcessRssMiB, farGpuMiB: Math.round(((await stats())?.far.gpuBytes ?? 0) / 2 ** 20) };
    };
    // The fill at the line's start: until the far field drawn stays the same for 5 s.
    const T0 = Date.now();
    let last = '';
    let since = Date.now();
    for (;;) {
      const s = await stats();
      const key = JSON.stringify(s?.far ?? null);
      if (s !== null && s.far.nodes > 0 && key === last) {
        if (Date.now() - since > 5000) break;
      } else {
        last = key;
        since = Date.now();
      }
      if (Date.now() - T0 > 420_000) throw new Error('the far field did not settle in 7 min');
      await page.waitForTimeout(250);
    }
    out['fillS'] = Number(((since - T0) / 1000).toFixed(1));
    out['memoryStart'] = await memory();
    const heapCdp = HEAP_PROFILE ? await context.newCDPSession(page) : null;
    if (heapCdp !== null) await heapCdp.send('HeapProfiler.startSampling', { samplingInterval: 16384 });
    const heapAt = async (label: string): Promise<void> => {
      if (heapCdp === null) return;
      await canvas.evaluate(() => (globalThis as unknown as { gc?: () => void }).gc?.());
      const { profile } = (await heapCdp.send('HeapProfiler.getSamplingProfile')) as { profile: { head: SamplingNode } };
      const file = OUT.replace(/\.json$/, `.heap-${label}.json`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ label, sites: heapSites(profile.head) }, null, 1));
      if (HEAP_SNAPSHOT.includes(label)) {
        // The whole heap with its retainers (array buffers' backing stores among its native nodes), streamed to disk.
        const snap = file.replace(/\.json$/, '.heapsnapshot');
        const fd = openSync(snap, 'w');
        const onChunk = (e: { chunk: string }) => void writeSync(fd, e.chunk);
        heapCdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
        await heapCdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
        heapCdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
        closeSync(fd);
      }
      writeFileSync(file.replace(/\.json$/, '.profile.json'), JSON.stringify(profile));
      (out['heapProfiles'] as Record<string, string> | undefined) ?? (out['heapProfiles'] = {});
      (out['heapProfiles'] as Record<string, string>)[label] = file;
    };
    await heapAt('start');
    const simStart = await sim();
    out['simStart'] = { far: simStart?.['far'] ?? null, coverage: simStart?.['coverage'] ?? null };

    // Every presented frame, small, through the screencast: key pixels below the ground row.
    const cdp = await context.newCDPSession(page);
    const checks: FrameCheck[] = [];
    let flyAt = Number.POSITIVE_INFINITY;
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
      const t = (f.metadata.timestamp ?? Date.now() / 1000) - flyAt / 1000;
      if (t < 0) return;
      const img = decodePng(Buffer.from(f.data, 'base64'));
      const key = new Uint8Array(Math.ceil((img.width * img.height) / 8));
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const p = img.pixel(x, y);
        if (isKey(p[0], p[1], p[2])) key[(y * img.width + x) >> 3]! |= 1 << ((y * img.width + x) & 7);
      }
      checks.push({ t, width: img.width, height: img.height, key });
    });
    // Where the camera is, for the holes' places (the frame's distance from the nearest poll).
    const polls: Array<{ t: number; m: number; far: { level: number; inside: boolean } | null }> = [];
    const coverageLog: Array<{ t: number; c: unknown }> = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const o = await api(`play/${psid}/observe`, {});
        const at = (o.json['camera'] as { position?: readonly number[] } | undefined)?.position;
        const p = at === undefined ? undefined : { x: at[0]!, y: at[1]!, z: at[2]! };
        if (p !== undefined && Number.isFinite(flyAt)) {
          const far = await canvas.evaluate((_c, a) => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.farSolidAt(a.w, a.x, a.y, a.z), { w: WORLD, x: p.x, y: p.y, z: p.z }).catch(() => null);
          polls.push({ t: (Date.now() - flyAt) / 1000, m: distanceAlong(path, p.x, p.z), far });
        }
        await page.waitForTimeout(250);
      }
    })();
    const simPoll = (async () => {
      while (polling) {
        const s = await sim();
        if (Number.isFinite(flyAt)) coverageLog.push({ t: (Date.now() - flyAt) / 1000, c: { coverage: s?.['coverage'] ?? null, far: { drawn: s?.['far']?.drawn, pending: s?.['far']?.pending } } });
        await page.waitForTimeout(1000);
      }
    })();
    await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 320, maxHeight: 180, everyNthFrame: 1 });
    await page.waitForTimeout(500);
    const recording = canvas.evaluate((_c, s) => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.record(s), flightS + 1);
    flyAt = Date.now();
    await control({ command: 'debugCommand', name: 'fly' });
    const shots: Array<{ s: number; file: string; m: number | null; stats: unknown }> = [];
    for (const s of SHOTS) {
      const wait = flyAt + s * 1000 - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      const file = join(SHOT_DIR, `${QUALITY}-${SPEED}-${ALTITUDE}-${TAG}-t${s}.png`);
      mkdirSync(dirname(file), { recursive: true });
      await frame.screenshot({ path: file });
      shots.push({ s, file, m: polls.at(-1)?.m ?? null, stats: await stats() });
    }
    const intervals = await recording;
    const rest = flyAt + (flightS + 1.5) * 1000 - Date.now();
    if (rest > 0) await page.waitForTimeout(rest);
    // Standing at the flight's end: frames a few seconds on (does what was missing come in?).
    for (const s of AFTER) {
      const wait = flyAt + (flightS + s) * 1000 - Date.now();
      if (wait > 0) await page.waitForTimeout(wait);
      const file = join(SHOT_DIR, `${QUALITY}-${SPEED}-${ALTITUDE}-${TAG}-after${s}.png`);
      mkdirSync(dirname(file), { recursive: true });
      await frame.screenshot({ path: file });
      shots.push({ s: flightS + s, file, m: polls.at(-1)?.m ?? null, stats: await stats() });
    }
    
    await cdp.send('Page.stopScreencast');
    polling = false;
    await Promise.all([poll, simPoll]);
    out['memoryEnd'] = await memory();
    await heapAt('end');
    const simEnd = await sim();
    out['simEnd'] = { far: simEnd?.['far'] ?? null, coverage: simEnd?.['coverage'] ?? null, stream: simEnd?.['stream']?.['lod'] ?? null };
    out['drawnEnd'] = await stats();
    if (RETURN_S > 0) {
      // Home again: what the flight's places still hold once the camera stands where it started.
      await control({ command: 'debugCommand', name: 'start' });
      await page.waitForTimeout(RETURN_S * 1000);
      out['memoryReturn'] = await memory();
      await heapAt('return');
      const simBack = await sim();
      out['simReturn'] = { far: simBack?.['far'] ?? null, stream: simBack?.['stream'] ?? null };
      out['drawnReturn'] = await stats();
    }
    out['frames'] = frameWindow(intervals, CAP);
    // Holes: frames with key pixels below the ground row, per km, as events (runs of such frames), with their places.
    const inFlight = checks.filter((c) => c.t <= flightS);
    const mAt = (t: number): number | null => {
      let best: { t: number; m: number } | null = null;
      for (const p of polls) if (best === null || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      return best === null ? null : Math.round(best.m);
    };
    // Each frame's camera from the position polls (distance along the line, interpolated in time), its ground mask.
    const mAtTime = (t: number): number => {
      const i = polls.findIndex((p) => p.t >= t);
      if (i <= 0) return polls[0]?.m ?? 0;
      const a = polls[i - 1]!, b = polls[i]!;
      return a.m + ((b.m - a.m) * (t - a.t)) / Math.max(1e-3, b.t - a.t);
    };
    const bounds = worldBounds();
    for (const c of checks) {
      const m = Math.min(stopAt, mAtTime(c.t));
      const p = along(path.waypoints, m);
      const f = Math.max(0, Math.min(path[ALTITUDE].length - 1.001, m / path.step));
      const k = Math.floor(f);
      const y = path[ALTITUDE][k]! + (path[ALTITUDE][k + 1]! - path[ALTITUDE][k]!) * (f - k);
      const mask = groundMask(c.width, c.height, { x: p.x, y, z: p.z, yaw: Math.atan2(-p.dx, -p.dz), pitch: PITCH }, FOV_Y, bounds, FLOOR_Y);
      let n = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i] === 1 && (c.key[i >> 3]! & (1 << (i & 7))) !== 0) n++;
      c.holes = n;
    }
    const holes = inFlight.filter((c) => (c.holes ?? 0) >= HOLE_PIXELS);
    const events: Array<{ t: number; m: number | null; frames: number; worstKey: number }> = [];
    for (const h of holes) {
      const e = events.at(-1);
      if (e !== undefined && h.t - (e.t + e.frames / CAP.fps) < 0.25) {
        e.frames++;
        e.worstKey = Math.max(e.worstKey, h.holes ?? 0);
      } else events.push({ t: Number(h.t.toFixed(2)), m: mAt(h.t), frames: 1, worstKey: h.holes ?? 0 });
    }
    const km = stopAt / 1000;
    out['holes'] = { checked: inFlight.length, holeFrames: holes.length, perKm: Number((holes.length / km).toFixed(2)), events: events.length, eventsPerKm: Number((events.length / km).toFixed(2)), where: events.slice(0, 60), worstKey: Math.max(0, ...inFlight.map((c) => c.holes ?? 0)) };
    // The camera inside the solid of the far node drawn round it (sampled with the position polls).
    const inFlightPolls = polls.filter((p) => p.t <= flightS);
    const inside = inFlightPolls.filter((p) => p.far?.inside === true);
    out['inStandIn'] = { samples: inFlightPolls.length, inside: inside.length, where: inside.slice(0, 30).map((p) => ({ t: Number(p.t.toFixed(2)), m: Math.round(p.m), level: p.far!.level })), farLevelAtEye: Object.fromEntries([...new Set(inFlightPolls.map((p) => String(p.far?.level ?? 'none')))].map((k) => [k, inFlightPolls.filter((p) => String(p.far?.level ?? 'none') === k).length])) };
    out['afterChecks'] = checks.filter((c) => c.t > flightS).map((c) => ({ t: Number(c.t.toFixed(2)), holes: c.holes })).filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 40)) === 0);
    out['coverageLog'] = coverageLog;
    out['shots'] = shots;
    out['errors'] = errors.slice(0, 5);
    if (QUALITY === 'low') out['ceiling'] = LOW_MEMORY_CEILING_MIB;
    await control({ command: 'stop' }).catch(() => undefined);
  } catch (e) {
    out['error'] = String(e).slice(0, 600);
    console.error(out['error']);
  } finally {
    await browser.close().catch(() => undefined);
    await command('setEnvironment', { sceneId: 'scene-main', environment: look }).catch((e: unknown) => console.error(`look not put back: ${String(e)}`));
  }
  out['end'] = host();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  const h = out['holes'] as { holeFrames: number; checked: number; perKm: number; events: number; eventsPerKm: number } | undefined;
  const c = (out['simEnd'] as { coverage?: Record<string, number> } | undefined)?.coverage;
  console.log(`holes: ${h?.holeFrames}/${h?.checked} frames (${h?.perKm}/km), ${h?.events} events (${h?.eventsPerKm}/km); coverage ${JSON.stringify(c ?? null)}; frames ${JSON.stringify(out['frames'])}; memory ${JSON.stringify(out['memoryStart'])} → ${JSON.stringify(out['memoryEnd'])}`);
  console.log(`coverage: ${OUT}`);
  process.exit(out['error'] === undefined ? 0 : 1);
}

await main();
