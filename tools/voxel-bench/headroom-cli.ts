/**
 * The GPU headroom meter (`node tools/voxel-bench/run.mjs headroom …`): how
 * much room a voxel world's frame has on this GPU at its frame-rate cap (the
 * display's 60 Hz, or the quality level's own: low's 30), and what each pass costs, without GPU timestamps (they follow the clock
 * governor at the cap) and never uncapped. The arithmetic and why it holds:
 * headroom.ts; the load: three-adapter gpu-headroom.ts through the game
 * page's `__tlVoxelPlay.meter` (game-host voxel-meter.ts).
 *
 * Runs Play in the editor on a running backend (staging: `tools/staging.sh
 * start`; the 8 km world of `run.mjs far-world` in project voxel-slice),
 * WebGPU, the canvas at the viewport's size, the camera orbiting the town
 * square (the project's "Perf far camera" object; an orbit behaviour is
 * published for it when it has none). After the far field settles, per round:
 *
 * 1. the render scale pinned to the tier's own (dynamic resolution off: it
 *    would draw smaller under the load) and a window with no load;
 * 2. the edge: the ballast copies the frame holds before it misses (doubling,
 *    then halving the gap; the room, in ballast units);
 * 3. the page's GPU measurement (game-host gpu-measure.ts, the same routine
 *    the Profiler tab's "Measure GPU" runs, through `__tlProfiler.gpu`): GPU
 *    ms per pass category (near, far, shadows, lighting, post, effects) past
 *    the cap, each category's median and spread over interleaved repeats, a
 *    category under the routine's resolution reported as such, and the
 *    frame's GPU ms at the busy clock;
 * 4. the copies of each pass in `--copies` the frame holds at no load (how
 *    many times it could be drawn);
 * 5. `--scales`: a window at no load at each render scale.
 *
 * Frames are timed as the page presents them (the meter's record), not by
 * animation frames: under a 30 cap on a 60 Hz display every other callback
 * draws nothing. After the fill the page's heap and the GPU process's memory
 * (the driver's resident count from its DRM fds) are read, and at low against
 * the tier's memory budget (`LOW_MEMORY_BUDGET_MIB`).
 *
 *   --origin URL         the backend (default http://127.0.0.1:4180, staging)
 *   --token-file FILE    its owner token (default ~/thirdlight-staging-p45/owner-token)
 *   --project ID         (default voxel-slice)   --world NAME (default far)
 *   --quality LEVEL      low | medium | high (default medium)   --rounds N (default 1)
 *   --cap FPS            the frame-rate cap measured against (default the level's `frameRateCap`, else 60)
 *   --window S           seconds a window (default 3)   --settle S (default 1)
 *   --copies LIST        passes drawn again (default near,far; `none`)
 *   --repeats N          the GPU measurement's interleaved repeats (default 5)   --gpu-window S (default 1.5)
 *   --scales LIST        render scales at no load (default low 0.833,1; medium 0.75,0.833,0.917,1; high 0.9,0.8,0.667; `none`)
 *   --query Q            more of the editor page's query (`&voxelShadows=off`: page flags Play is passed)
 *   --orbit R,W          the camera R m from the town square at W rad/s (default 12,0.15; e.g. 60,0.25 moves the eye 15 m/s)
 *   --lamps N            the many-lamps scene of N lights (many-lamps.ts: 32, 128 or 512) placed before Play and taken out
 *                        after, its glowing patches painted by the orbit's behaviour where the world is loaded
 *   --particles N        N lit smoke puffs (bench-particles.ts) round the town square 20 m up, in front of the orbit, made
 *                        before Play and deleted after: the `effects` pass's cost with lit particles
 *   --props N            N lit props (bench-props.ts: indoors and in the streets, every fifth cart moving) placed before
 *                        Play and taken out after (the simulation's stamping and walk packing are among `spans.sim`);
 *                        `--props-unlit`: the same objects not marked to affect lighting (what drawing and moving them costs)
 *   --fog                the bench fog (bench-fog.ts: a hollow in the town's empty lot filled with mist) placed before Play
 *                        and taken out after, the camera orbiting the hollow 10 m out and 7 m up, looking down into it
 *                        (the bank in view all the way round); `--query '&voxelGas=off'` is the same run with the
 *                        gas not drawn
 *   --meadow             the camera orbits the town's three empty lots (the bench cover's meadow: 16 m out, 4 m up),
 *                        with or without the cover; `--cover`: the bench cover (bench-cover.ts: a meadow, a painted
 *                        road, a pond's reed shore) placed before Play and taken out after. `--meadow` alone against
 *                        `--meadow --cover` is what the cover costs at one camera
 *   --viewport WxH       (default 1280x720)   --tag NAME   --out FILE (default ~/.cache/thirdlight-voxel-bench/headroom/<quality>-<tag>.json)
 *
 * How to (staging running, the 8 km world in it, nothing else on the GPU):
 *
 *   sudo -n systemd-run --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 -- sudo -n -u $USER -- \
 *     env HOME=$HOME PATH=$PATH TMPDIR=$HOME/.cache/tmp/headroom node tools/voxel-bench/run.mjs headroom --quality medium --rounds 2
 *
 * (`MemoryMax=7G` for `--quality high`). A round takes ~5 min after the fill.
 * Read the JSON's `rounds[].rows` `rounds[].gpu` (the measurement: per category
 * `ms` or below resolution, `resolutionMs`, `frameMs`), `edge` (the room, in
 * ballast copies) and `spread` (rounds).
 * A later item measures before and after its change with the same command
 * in the same hour. Not part of `npm test`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { DEFAULT_QUALITY_LEVELS, LOW_MEMORY_BUDGET_MIB } from '@thirdlight/project-model';
import { profileSummary, type ProfileReport } from '@thirdlight/game-host';
import { launchGpuBrowser, parseViewport } from '../perf/frame-run';
import { benchDir } from './bench-dirs';
import type { GpuMeasurement } from '@thirdlight/game-host';
import { gpuMeasureOnPage, gpuMeasureSummary, measureGpuOnPage } from '../perf/gpu-measure-page';
import { spanMeans, type SpanFrame } from './travel';
import { FarSettle, frameCap, frameWindow, misses, searchLimit, spread, type FrameWindow, type LimitResult } from './headroom';
import { placeBenchCover } from './bench-cover';
import { placeBenchFog } from './bench-fog';
import { BENCH_COVER, BENCH_GLOW_MATERIALS, FOG_HOLLOW } from './lighting-cameras';
import { manyLampsBehaviour, manyLampsCounts, manyLampsScene, parseLampsOption, placeManyLamps } from './many-lamps';
import { benchProps, parsePropsOption, placeBenchProps } from './bench-props';
import { BENCH_SMOKE_EFFECT, particleEntities, placeBenchParticles, smokePlaces } from './bench-particles';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
const list = (v: string): string[] => (v === 'none' ? [] : v.split(',').filter((x) => x !== ''));

const ORIGIN = arg('origin', 'http://127.0.0.1:4180');
const TOKEN = readFileSync(arg('token-file', join(homedir(), 'thirdlight-staging-p45', 'owner-token')), 'utf8').trim();
const PROJECT = arg('project', 'voxel-slice');
const WORLD = arg('world', 'far');
const QUALITY = arg('quality', 'medium');
const ROUNDS = Number(arg('rounds', '1'));
const WINDOW_S = Number(arg('window', '3'));
const SETTLE_S = Number(arg('settle', '1'));
const COPIES = list(arg('copies', 'near,far')) as Array<'near' | 'far'>;
const REPEATS = Number(arg('repeats', '5'));
const GPU_WINDOW_S = Number(arg('gpu-window', '1.5'));
const SCALES = list(arg('scales', QUALITY === 'high' ? '0.9,0.8,0.667' : QUALITY === 'medium' ? '0.75,0.833,0.917,1' : QUALITY === 'low' ? '0.833,1' : 'none')).map(Number);
const VIEWPORT = parseViewport(arg('viewport', '1280x720'));
const QUERY = arg('query', '');
const TAG = arg('tag', new Date().toISOString().slice(0, 16).replace(/[:T]/g, ''));
const OUT = arg('out', join(benchDir('headroom'), `${QUALITY}-${TAG}.json`));
const LEVEL = DEFAULT_QUALITY_LEVELS.find((l) => l.id === QUALITY);
/** The tier's own render scale (the most dynamic resolution draws at). */
const TIER_SCALE = LEVEL?.renderScale ?? 1;
/** The cap the frames are measured against: the level's own, else the display's. */
const CAP = frameCap(Number(arg('cap', String(LEVEL?.frameRateCap ?? 60))));
const BALLAST_LIMIT = 4096;
const COPY_LIMIT = 32;

const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', origin: ORIGIN };
async function api(path: string, body: unknown = {}, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/${path}`, { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
async function revision(): Promise<number> {
  return Number((await api('commands', { op: 'queryProject', projectId: PROJECT, args: {} })).json['revision']);
}
async function command(op: string, args: unknown): Promise<void> {
  const r = await api('commands', { op, projectId: PROJECT, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'voxel-bench-headroom' }, args });
  const error = r.json['error'] as { code?: string } | undefined;
  if (r.json['ok'] !== true && error?.code !== 'no_change') throw new Error(`${op}: ${JSON.stringify(r.json).slice(0, 400)}`);
}

/**
 * The orbit round the town square the far-field measurements use (0.15 rad/s at the 120 Hz step, 12 m out, 20 m up),
 * or `--orbit R,W`: R m out at W rad/s, so the eye moves (R × W m/s) and the fine far bricks build while it is
 * measured (e.g. 60,0.25: 15 m/s).
 */
const [ORBIT_R, ORBIT_W] = arg('orbit', '12,0.15').split(',').map(Number) as [number, number];
const LAMPS = parseLampsOption(process.argv);
const SCENE = LAMPS === 0 ? null : manyLampsScene(LAMPS);
const ML = SCENE === null ? null : manyLampsBehaviour(SCENE);
const PROPS = parsePropsOption(process.argv);
const PARTICLES = Number(arg('particles', '0'));
/** `--fog`: the bench fog placed, and the orbit round its hollow. */
const FOG = process.argv.includes('--fog');
/** `--meadow`: the orbit over the bench cover's meadow; `--cover`: the bench cover placed. */
const MEADOW = process.argv.includes('--meadow');
const COVER = process.argv.includes('--cover');
const ORBIT_ID = `${ORBIT_R === 12 && ORBIT_W === 0.15 ? 'headroom-orbit' : `headroom-orbit-${ORBIT_R}-${String(ORBIT_W).replace('.', 'p')}`}${LAMPS === 0 ? '' : `-lamps${LAMPS}`}${FOG ? '-fog' : ''}${MEADOW ? '-meadow' : ''}`;
/** The orbit's middle (x, z), its eye's height at no pitch, its pitch and its distance: the town square's, or round the fog's hollow. */
const ORBIT_AT = FOG ? { x: FOG_HOLLOW.seed[0], z: FOG_HOLLOW.seed[2], y: 7 - Math.sin(0.64) * 12.5, pitch: 0.64, d: 12.5 } : MEADOW ? { x: (BENCH_COVER.road.x0 + BENCH_COVER.road.x1) / 2, z: -4, y: 4 - Math.sin(0.25) * 16, pitch: 0.25, d: 16 } : { x: 0, z: 0, y: 20, pitch: 0.03, d: ORBIT_R };
const ORBIT = `
${ML?.head ?? ''}
const quat = (yaw: number, pitch: number) => { const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };
export default {
  prepare() { return {}; },
  instantiate() { return { yaw: 0.4636 }; },
  step(s: any, ctx: any) {
    ${ML === null ? '' : `if (ctx.phase === 'intent') { const v = ctx.voxels; const put = (n: string, x: number) => ctx.game.add(n, x - ctx.game.counter(n)); void put; ${ML.intent} return; }`}
    if (ctx.phase !== 'transform') return;
    s.yaw += ${ORBIT_W} / 120;
    const pitch = ${ORBIT_AT.pitch}, d = ${ORBIT_AT.d}, c = Math.cos(pitch);
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: ${ORBIT_AT.x} + Math.sin(s.yaw) * c * d, y: ${ORBIT_AT.y} + Math.sin(pitch) * d, z: ${ORBIT_AT.z} + Math.cos(s.yaw) * c * d }, quaternion: quat(s.yaw, pitch) });
  },
  dispose() {},
};
`;
/** Behaviours that orbit the town square from the start (the far-field runs' camera, or this bench's). */
const ORBITS = new Set(ORBIT_ID === 'headroom-orbit' ? ['farcam5', ORBIT_ID] : [ORBIT_ID]);

async function orbitCamera(): Promise<void> {
  const scene = (await api('scenes/scene-main', {}, 'GET')).json as { scene?: { entities?: Array<{ id: string; name: string; components: Record<string, { behaviorId?: string }> }> } };
  const entities = scene.scene?.entities ?? JSON.parse(readFileSync(join(homedir(), 'thirdlight-staging-p45', 'projects', PROJECT, 'scenes', 'scene-main.json'), 'utf8')).scene.entities;
  const cam = entities.find((e: { name: string }) => e.name === 'Perf far camera');
  if (cam === undefined) throw new Error('no "Perf far camera" object in the project (the far-field runs make it)');
  if (ORBITS.has(cam.components.behavior?.behaviorId ?? '')) return;
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: ['@self'], files: [{ path: 'src/index.ts', text: ORBIT }] }, null, 2)}\n`);
  const stageId = String((await api('content/stages')).json['stageId']);
  const put = await fetch(`${ORIGIN}/api/v1/projects/${PROJECT}/content/stages/${stageId}/bytes`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, origin: ORIGIN, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  if (put.status !== 200) throw new Error(`stage ${put.status}`);
  const declaration = { properties: [] };
  // The orbit's record may be there already (another bench gave the camera its own behaviour since).
  await command('publishBehavior', { behaviorId: ORBIT_ID, displayName: ORBIT_ID, mode: 'declaration-create', declaration }).catch((e: unknown) => {
    if (!String(e).includes('behavior_id_duplicate')) throw e;
  });
  await command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const pub = await api('content/behaviors/source', { stageId, behaviorId: ORBIT_ID, displayName: ORBIT_ID, declaration, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}` });
  if (pub.status !== 200) throw new Error(`publish ${JSON.stringify(pub.json).slice(0, 300)}`);
  await command('setBehaviorProperties', { entityId: cam.id, behaviorId: ORBIT_ID, values: {} });
}

interface MeterSettings {
  ballast?: number;
  copies?: number;
  copy?: 'near' | 'far';
  renderScale?: number;
  dynamicResolution?: boolean;
}
interface Hook {
  meter: { set(s: MeterSettings): boolean; state(): { copyCpuMs: number; lightsHidden: number; frames: number; size: number[]; completions?: unknown } | null; record(seconds: number, clock?: 'presented' | 'gpu'): Promise<number[]> };
  stats(): { worlds: Record<string, { far: { nodes: number; bricks: number } ; chunks: number; gas?: { triangles: number; program: boolean; eyeInside: boolean } }> };
}

async function openPlay(page: Page): Promise<{ canvas: Locator; psid: string; control: (body: unknown) => Promise<void> }> {
  await page.goto(`${ORIGIN}/?project=${PROJECT}&renderer=webgpu${QUERY}#token=${TOKEN}`);
  await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 60_000 });
  // The preview at the viewport's size, over the editor (the editor draws nothing under it).
  await page.addStyleTag({ content: `iframe.tl-app__preview-frame { position: fixed !important; left: 0 !important; top: 0 !important; width: ${VIEWPORT.width}px !important; height: ${VIEWPORT.height}px !important; z-index: 2147483647 !important; }` });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'), { timeout: 60_000 });
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  const canvas = frame.locator('canvas').first();
  await canvas.waitFor({ timeout: 60_000 });
  const control = async (body: unknown): Promise<void> => {
    for (let i = 0; ; i++) {
      const r = await api(`play/${psid}/control`, body);
      if (r.status === 200) return;
      if ((r.json['error'] as { reason?: string } | undefined)?.reason !== 'not_presented' || i > 240) throw new Error(JSON.stringify(r.json));
      await page.waitForTimeout(250);
    }
  };
  return { canvas, psid, control };
}

/** The GPU process's memory as its driver counts it (MiB per DRM key summed over its fds; an integrated GPU's buffers are system memory). */
function drmMemoryMiB(pid: number): Record<string, number> {
  const kib: Record<string, number> = {};
  for (const fd of readdirSync(`/proc/${pid}/fdinfo`)) {
    let text = '';
    try {
      text = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('drm-driver')) continue;
    for (const line of text.split('\n')) {
      const m = /^(drm-(?:total|resident)-[\w-]+):\s+(\d+)\s*(KiB|MiB)?/.exec(line);
      if (m !== null) kib[m[1]!] = (kib[m[1]!] ?? 0) + Number(m[2]) * (m[3] === 'MiB' ? 1024 : 1);
    }
  }
  return Object.fromEntries(Object.entries(kib).map(([k, v]) => [k, Math.round(v / 1024)]));
}

/** The scene's objects now (the bench's lamps are found by name). */
function sceneEntities(): Array<{ id: string; name: string }> {
  return JSON.parse(readFileSync(join(homedir(), 'thirdlight-staging-p45', 'projects', PROJECT, 'scenes', 'scene-main.json'), 'utf8')).scene.entities as Array<{ id: string; name: string }>;
}

async function main(): Promise<void> {
  await command('setEnvironment', { environment: { quality: QUALITY, qualityLevels: DEFAULT_QUALITY_LEVELS } });
  // The many lamps (bench data): their glow materials and lamps in the project for the run, taken out after.
  if (SCENE !== null) for (const m of BENCH_GLOW_MATERIALS) await command('setMaterial', { material: m });
  const unplace = SCENE === null ? null : await placeManyLamps(SCENE, command, sceneEntities);
  const unprop = PROPS === 0 ? null : await placeBenchProps(benchProps(PROPS), join(homedir(), 'thirdlight-staging-p45', 'projects', PROJECT), command as (op: string, args: Record<string, unknown>) => Promise<void>, sceneEntities, !process.argv.includes('--props-unlit'));
  const unparticle = PARTICLES > 0 ? await placeBenchParticles(particleEntities(BENCH_SMOKE_EFFECT, smokePlaces(PARTICLES), 'smoke'), command as (op: string, args: Record<string, unknown>) => Promise<void>, sceneEntities) : null;
  await orbitCamera();
  const raw = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => (await api('commands', { op, projectId: PROJECT, ...(op === 'editVoxels' ? {} : { expectedRevision: await revision() }), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'voxel-bench-headroom' }, args })).json;
  // The bench cover: its strokes are the project's newest undo steps but the fog's.
  // After a bench's undo the far cache is read once, so the backend builds what the undo left before it is stopped.
  const settleFar = (): Promise<unknown> => api(`voxels/${WORLD}/far`, {}, 'GET');
  const cover = !COVER ? null : await placeBenchCover({ command: command as (op: string, args: Record<string, unknown>) => Promise<void>, raw, settleFar, assets: async () => ((await api('commands', { op: 'queryAssets', projectId: PROJECT, args: { limit: 100 } })).json['assets'] ?? []) as Array<{ assetId: string; sourcePath?: string }>, projectDir: join(homedir(), 'thirdlight-staging-p45', 'projects', PROJECT) }, WORLD);
  // The bench fog, placed last and taken out first (its strokes are then the project's newest undo steps).
  const fog = !FOG ? null : await placeBenchFog({ command: command as (op: string, args: Record<string, unknown>) => Promise<void>, raw, settleFar }, WORLD);
  const host = () => ({ at: new Date().toISOString(), uptimeDays: Number((uptime() / 86400).toFixed(2)), load: loadavg().map((x) => Number(x.toFixed(2))) });
  const out: Record<string, unknown> = { bench: 'headroom', lamps: SCENE === null ? 0 : { size: LAMPS, counts: manyLampsCounts(SCENE) }, props: PROPS, propsUnlit: process.argv.includes('--props-unlit'), particles: PARTICLES, fog: fog?.facts ?? null, meadow: MEADOW, cover: cover?.facts ?? null, quality: QUALITY, renderer: 'webgpu', viewport: VIEWPORT, tierScale: TIER_SCALE, cap: CAP, window: WINDOW_S, world: WORLD, start: host(), rounds: [] as unknown[] };
  const browser = await launchGpuBrowser({ vsync: true });
  const T0 = Date.now();
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text().slice(0, 200))));
    const { canvas, psid, control } = await openPlay(page);
    await control({ command: 'setQuality', level: QUALITY });
    const stats = () => canvas.evaluate((_c, w) => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.stats().worlds[w] ?? null, WORLD);
    // The fill: until the far field drawn stays within 2 % for 5 s (FarSettle).
    // With visibility feedback an orbiting camera keeps changing a few hundred nodes (what comes into view refines,
    // what left it coarsens): the fill ends at the first time the far field has made everything its selection wanted
    // (nothing pending, no job) with nodes drawn, then 5 s on; without feedback that is the drawn set settling.
    const settle = new FarSettle();
    const trace: unknown[] = [];
    out['fillTrace'] = trace;
    let madeAt: number | null = null;
    for (;;) {
      const s = await stats();
      const sim = (((await api(`play/${psid}/diagnostics`, {})).json['diagnostics'] as { runtime?: { voxelWorlds?: Array<{ world?: string; far?: { pending?: number; jobs?: number; drawn?: number } }> } } | undefined)?.runtime?.voxelWorlds ?? []).find((w) => w.world === WORLD)?.far;
      if (trace.length < 200 && (Date.now() - T0) / 5000 >= trace.length) trace.push({ s: Math.round((Date.now() - T0) / 1000), far: s?.far ?? null, sim: sim ?? null });
      if (madeAt === null && sim !== undefined && (sim.drawn ?? 0) > 0 && sim.pending === 0 && sim.jobs === 0 && (s?.far.nodes ?? 0) > 0) madeAt = Date.now();
      if (settle.step(s?.far, Date.now()) || (madeAt !== null && Date.now() - madeAt > 5000)) break;
      // Name what it stopped on: a far field that selects nothing (none drawn, nothing pending) is not one still moving.
      if (Date.now() - T0 > 420_000) throw new Error(`the far field did not settle in 7 min (last: ${JSON.stringify({ selected: (sim as { selected?: number } | undefined)?.selected ?? null, drawn: sim?.drawn ?? null, pending: sim?.pending ?? null, jobs: sim?.jobs ?? null, nodes: s?.far.nodes ?? null })})`);
      await page.waitForTimeout(250);
    }
    out['fillS'] = Number(((Math.min(settle.since, madeAt ?? Infinity) - T0) / 1000).toFixed(1));
    out['fill'] = await stats();
    // Structure grids (a `?voxelGrids=` query): their draws summed over every grid's draw name, and the host's grid
    // stats (streamed chunks and bytes, bodies, collider parts, body builds), its walk graph's (the grids' own and
    // their links within it), once filled.
    out['grids'] = {
      draws: await canvas.evaluate((_c, w) => {
        const all = (window as unknown as { __tlVoxelPlay?: { stats(): { worlds: Record<string, Record<string, number>> } } }).__tlVoxelPlay?.stats().worlds ?? {};
        const sum: Record<string, number> = { worlds: 0 };
        for (const [name, v] of Object.entries(all)) {
          if (!name.startsWith(`${w}#`)) continue;
          sum['worlds']!++;
          for (const k of ['chunks', 'triangles', 'kitInstances', 'pieceDraws', 'piecesInView', 'meshBuilds']) sum[k] = (sum[k] ?? 0) + (Number(v[k]) || 0);
        }
        return sum;
      }, WORLD),
      // The frame's draw calls and triangles as the profiler counts them (the last frame's stats).
      frame: await canvas.evaluate(() => {
        const st = (window as unknown as { __tlProfiler?: { read(): { counters?: { stats?: { drawCalls?: number; triangles?: number } | null } } } }).__tlProfiler?.read().counters?.stats ?? null;
        return st === null ? null : { drawCalls: st.drawCalls ?? null, triangles: st.triangles ?? null };
      }),
      host: (((await api(`play/${psid}/diagnostics`, {})).json['diagnostics'] as { runtime?: { voxelWorlds?: Array<{ world?: string; grids?: Record<string, unknown>; bodies?: number; resident?: number; bytes?: number; pool?: unknown; propChannelBytes?: number; gridStamps?: unknown; regions?: unknown; walk?: unknown }> } } | undefined)?.runtime?.voxelWorlds ?? [])
        .filter((v) => v.world === WORLD)
        .map((v) => ({ grids: v.grids ?? null, worldBodies: v.bodies, worldResident: v.resident, worldBytes: v.bytes, pool: v.pool ?? null, propChannelBytes: v.propChannelBytes ?? null, gridStamps: v.gridStamps ?? null, regions: v.regions ?? null, walk: v.walk ?? null }))[0] ?? null,
    };
    // Memory at the town once filled: the page's heap and the GPU process's (the editor's page included: Play runs in it).
    const cdp = await browser.newBrowserCDPSession();
    const info = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo: Array<{ type: string; id: number }> };
    const gpuPid = info.processInfo.find((p) => p.type === 'GPU')?.id ?? null;
    const drm = gpuPid === null ? {} : drmMemoryMiB(gpuPid);
    const pageHeapMiB = await canvas.evaluate(() => Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 2 ** 20));
    const gpuMiB = Object.entries(drm).filter(([k]) => k.startsWith('drm-resident-')).reduce((n, [, v]) => n + v, 0);
    out['memory'] = { pageHeapMiB, gpuMiB, drm, ...(QUALITY === 'low' ? { budget: LOW_MEMORY_BUDGET_MIB, over: { pageHeap: pageHeapMiB > LOW_MEMORY_BUDGET_MIB.pageHeap, gpu: gpuMiB > LOW_MEMORY_BUDGET_MIB.gpu } } : {}) };
    console.log(`memory at the town: page heap ${pageHeapMiB} MiB, GPU ${gpuMiB} MiB${QUALITY === 'low' ? ` (low's budget ${LOW_MEMORY_BUDGET_MIB.pageHeap} / ${LOW_MEMORY_BUDGET_MIB.gpu} MiB${pageHeapMiB > LOW_MEMORY_BUDGET_MIB.pageHeap || gpuMiB > LOW_MEMORY_BUDGET_MIB.gpu ? ': OVER' : ': under'})` : ''}`);

    let current: MeterSettings = {};
    const set = async (s: MeterSettings): Promise<void> => {
      const was = current;
      current = s;
      const ok = await canvas.evaluate((_c, v) => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.set(v), { renderScale: TIER_SCALE, dynamicResolution: false, ...s });
      if (!ok) throw new Error('the page has no GPU load (adapter without gpuLoad)');
      await page.waitForTimeout(SETTLE_S * 1000);
      // A new scale or copy builds its programs again: wait for a second without a stall (≤ 12 s).
      if (was.renderScale !== s.renderScale || (was.copy !== s.copy && s.copy !== undefined)) {
        for (let i = 0; i < 12; i++) if ((await frames(1)).stalls === 0) break;
      }
    };
    // The frames the page presents (a capped page skips animation frames).
    // What the page did over each window, kept with it (a round that stops low stops on one window's misses): the
    // profiler's spikes taken in during it (longest first, each thread's top spans) and the sun field's work left.
    let spikeCursor: unknown = null;
    const pageState = async (): Promise<Record<string, unknown>> => {
      const r = await canvas.evaluate((_c, after) => {
        const p = (window as unknown as { __tlProfiler?: { read(after?: unknown): { seq: unknown; spikes: Array<{ reason: string; ms: number; threads: Record<string, Array<{ spans: Array<{ name: string; selfMs: number }> }>> }> } } }).__tlProfiler;
        const sun = (window as unknown as { __tlVoxelPlay?: { sun?(): { waiting: number[]; marching: number; farHeld?: number } | null } }).__tlVoxelPlay?.sun?.() ?? null;
        if (p === undefined) return { seq: null, spikes: [], sun };
        const got = after === null ? p.read() : p.read(after);
        const top = (frames: Array<{ spans: Array<{ name: string; selfMs: number }> }>) => {
          const by = new Map<string, number>();
          for (const f of frames) for (const x of f.spans) by.set(x.name, (by.get(x.name) ?? 0) + x.selfMs);
          return [...by].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => [k, Math.round(v * 10) / 10]);
        };
        return { seq: got.seq, spikes: got.spikes.map((x) => ({ reason: x.reason, ms: Math.round(x.ms * 10) / 10, page: top(x.threads['page'] ?? []), sim: top(x.threads['sim'] ?? []) })).sort((a, b) => b.ms - a.ms).slice(0, 4), sun };
      }, spikeCursor);
      spikeCursor = r.seq;
      return { spikes: r.spikes, sun: r.sun };
    };
    await pageState();
    const frames = async (seconds: number): Promise<FrameWindow> => {
      const w = frameWindow(await canvas.evaluate((_c, s) => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.record(s), seconds), CAP);
      return { ...w, page: await pageState() } as FrameWindow;
    };
    const probe = async (s: MeterSettings): Promise<FrameWindow> => {
      await set(s);
      return frames(WINDOW_S);
    };
    const cpuMs = async (): Promise<number | null> => (await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.state()))?.copyCpuMs ?? null;
    // Programs built once for every kind of load before anything is timed.
    for (const s of [{ ballast: 1 }, ...COPIES.map((p) => ({ copies: 1, copy: p }))] as MeterSettings[]) await probe(s);

    // The world's gas as drawn after the fill (with `--fog`: the bank's hull; none with the gas not drawn).
    out['gas'] = (await stats())?.gas ?? null;
    for (let round = 0; round < ROUNDS; round++) {
      const r: Record<string, unknown> = { round, start: host() };
      r['noLoad'] = await probe({});
      // The clustered lights' and the shadow atlas's counts (written on the canvas) and the light volume's state (its lamp lists, bytes).
      r['lights'] = await canvas.evaluate((c) => ({ clusters: c.getAttribute('data-tl-clusters'), atlas: c.getAttribute('data-tl-shadow-atlas') }));
      r['volume'] = await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay?: { light?: { volume?(): unknown } } }).__tlVoxelPlay?.light?.volume?.() ?? null);
      // The frame profile over the window just recorded (the last frames each thread keeps): each thread's CPU a frame.
      const profile = await canvas.evaluate(() => (window as unknown as { __tlProfiler?: { read(): unknown } }).__tlProfiler?.read() ?? null);
      // The ground cover as the page's cover path holds it, and what the view drew of it (the profiler's own count: three's counters do not count indirect draws).
      r['cover'] = await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay?: { cover?(): unknown } }).__tlVoxelPlay?.cover?.() ?? null);
      r['coverRows'] = (profile as { counters?: { coverRows?: unknown } } | null)?.counters?.coverRows ?? null;
      if (profile !== null) {
        r['profile'] = profileSummary(profile as ProfileReport);
        // Each span's own ms a frame over the same window (what a category's ms is made of).
        const th = (profile as ProfileReport).threads;
        const compact = (fs: ProfileReport['threads']['page']): SpanFrame[] => fs.map((f) => [f.start, f.ms, f.spans.map((x) => [`${x.category} / ${x.name}`, x.selfMs] as const)] as const);
        r['spans'] = { page: spanMeans(compact(th.page), 30), sim: spanMeans(compact(th.sim), 15) };
      }
      // The edge: the ballast the frame holds at the cap.
      const edge: LimitResult = await searchLimit((n) => probe({ ballast: n }), { max: BALLAST_LIMIT, start: 4, precision: 0.1, cap: CAP });
      r['edge'] = edge;
      const room = Math.max(0, edge.held);
      // GPU ms per pass category: the page's own measurement (its load and hides; the meter's load set back first).
      await set({});
      // The GPU's completion times at no load (the clock the measurement reads), beside the page's presented ones.
      r['noLoadGpuClock'] = frameWindow(await canvas.evaluate((_c, s) => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.record(s, 'gpu'), WINDOW_S), CAP);
      r['completions'] = (await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.state()))?.completions ?? null;
      console.log(`  GPU clock at no load: ${JSON.stringify(r['noLoadGpuClock'])}; completions ${JSON.stringify(r['completions'])}`);
      const gameFrame = await (await canvas.elementHandle())!.ownerFrame();
      if (gameFrame === null) throw new Error('the canvas has no frame');
      r['gpu'] = await measureGpuOnPage((call, options) => gameFrame.evaluate(gpuMeasureOnPage, { call, ...(options !== undefined ? { options } : {}) }), (ms) => page.waitForTimeout(ms), { repeats: REPEATS, windowS: GPU_WINDOW_S });
      // The copies the frame holds at no load (how many times each pass could be drawn).
      const copies: Record<string, LimitResult> = {};
      for (const pass of COPIES) {
        copies[pass] = await searchLimit((n) => probe({ copies: n, copy: pass }), { max: COPY_LIMIT, start: 1, precision: 0.25, cap: CAP });
        r[`copyCpuMs ${pass}`] = await cpuMs();
      }
      r['copies'] = copies;
      const scales: Record<string, FrameWindow> = {};
      for (const s of SCALES) scales[String(s)] = await probe({ renderScale: s });
      r['scales'] = scales;
      await set({});
      r['end'] = host();
      (out['rounds'] as unknown[]).push(r);
      console.log(summary(r));
    }
    const rounds = out['rounds'] as Array<Record<string, unknown>>;
    const gpuOf = (r: Record<string, unknown>): GpuMeasurement | null => (r['gpu'] as GpuMeasurement | null) ?? null;
    out['spread'] = {
      edgeHeld: spread(rounds.map((r) => (r['edge'] as LimitResult).held)),
      ballastMs: spread(rounds.map((r) => gpuOf(r)?.ballast.msPerUnit ?? Number.NaN)),
      frameGpu: spread(rounds.map((r) => gpuOf(r)?.frameMs ?? Number.NaN)),
      resolution: spread(rounds.map((r) => gpuOf(r)?.resolutionMs ?? Number.NaN)),
      ...Object.fromEntries(['near', 'far', 'shadows', 'lighting', 'post', 'effects'].map((c) => [`median ${c}`, spread(rounds.map((r) => gpuOf(r)?.categories.find((x) => x.category === c)?.medianMs ?? Number.NaN))])),
    };
    out['errors'] = errors.slice(0, 5);
    await control({ command: 'stop' }).catch(() => undefined);
  } catch (e) {
    out['error'] = String(e).slice(0, 600);
    console.error(out['error']);
  } finally {
    await browser.close().catch(() => undefined);
    await fog?.undo().catch((e: unknown) => console.error(`bench fog not taken out: ${String(e)}`));
    await cover?.undo().catch((e: unknown) => console.error(`bench cover not taken out: ${String(e)}`));
    await unplace?.().catch((e: unknown) => console.error(`many lamps not taken out: ${String(e)}`));
    await unprop?.().catch((e: unknown) => console.error(`bench props not taken out: ${String(e)}`));
    await unparticle?.().catch((e: unknown) => console.error(`bench particles not taken out: ${String(e)}`));
    if (SCENE !== null) for (const m of BENCH_GLOW_MATERIALS) await command('deleteMaterial', { materialId: m.materialId }).catch((e: unknown) => console.error(`${m.materialId} not deleted: ${String(e)}`));
  }
  out['end'] = host();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(out, null, 1)}\n`);
  console.log(`headroom: ${OUT}`);
  process.exit(out['error'] === undefined ? 0 : 1);
}

function summary(r: Record<string, unknown>): string {
  const w = r['noLoad'] as FrameWindow;
  const e = r['edge'] as LimitResult;
  const g = r['gpu'] as GpuMeasurement | null;
  const lines = [
    ...(r['profile'] !== undefined ? [`  profile at no load: ${JSON.stringify((r['profile'] as { msPerFrame: unknown }).msPerFrame)} ms a frame, busy ${JSON.stringify((r['profile'] as { busy: unknown }).busy)}`] : []),
    `round ${String(r['round'])} at ${CAP.fps} Hz: no load ${w.missed}/${w.frames} missed, ${w.stalls} stalls (mean ${w.meanMs} ms, ${misses(w, CAP) ? 'misses' : 'holds'}); ballast held ${e.held}, missed at ${String(e.missedAt)}`,
    `  ${g === null ? 'GPU measurement: none' : gpuMeasureSummary(g)}`,
    ...Object.entries(r['copies'] as Record<string, LimitResult>).map(([k, v]) => `  ${k} copies at no load: held ${v.held}, missed at ${String(v.missedAt)} (CPU a frame ${String(r[`copyCpuMs ${k}`])} ms for one)`),
    ...Object.entries(r['scales'] as Record<string, FrameWindow>).map(([k, v]) => `  scale ${k}: ${v.missed}/${v.frames} missed, ${v.stalls} stalls, mean ${v.meanMs}`),
  ];
  return lines.join('\n');
}

await main();
