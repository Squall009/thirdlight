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
 * 3. past the edge, where the GPU sets the interval: a load doubled from 4
 *    times the edge until the mean interval is ~30 ms, and windows at half and
 *    three quarters of it; the line through their mean intervals gives a ballast
 *    copy's ms (slope) and the frame's GPU ms (intercept), checked against the
 *    budget less the room (they agree when the interval is the GPU's time);
 * 4. at that load, each pass in `--hide` (near, far, shadows, post)
 *    hidden and each in `--copies` (near, far) drawn once more: the interval
 *    it moves is its ms, over the slope its units, and 1 + room / units how
 *    many times it could be drawn (headroom ×);
 * 5. the copies of each pass the frame holds at no load (a direct check), and
 *    at no load each pass hidden: whether the frame then holds and its stalls
 *    (frames over 100 ms) go;
 * 6. `--scales`: a window at no load at each render scale.
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
 *   --hide LIST          passes hidden (default near,far,shadows,post; `none`)
 *   --scales LIST        render scales at no load (default low 0.833,1; medium 0.75,0.833,0.917,1; high 0.9,0.8,0.667; `none`)
 *   --query Q            more of the editor page's query (`&voxelShadows=static`: page flags Play is passed)
 *   --viewport WxH       (default 1280x720)   --tag NAME   --out FILE (default ~/.cache/thirdlight-voxel-bench/headroom/<quality>-<tag>.json)
 *
 * How to (staging running, the 8 km world in it, nothing else on the GPU):
 *
 *   sudo -n systemd-run --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 -- sudo -n -u $USER -- \
 *     env HOME=$HOME PATH=$PATH TMPDIR=$HOME/.cache/tmp/headroom node tools/voxel-bench/run.mjs headroom --quality medium --rounds 2
 *
 * (`MemoryMax=7G` for `--quality high`). A round takes ~5 min after the fill.
 * Read the JSON's `rounds[].rows` (ms a pass, past the edge), `edge` (the
 * room, in ballast copies), `frameGpu` (whether the line and the edge agree:
 * if not, quote units and ms past the edge only) and `spread` (rounds).
 * A later item measures before and after its change with the same command
 * in the same hour. Not part of `npm test`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { DEFAULT_QUALITY_LEVELS, LOW_MEMORY_BUDGET_MIB } from '@thirdlight/project-model';
import { launchGpuBrowser, parseViewport } from '../perf/frame-run';
import { benchDir } from './bench-dirs';
import { FarSettle, fitLine, frameCap, frameGpu, frameWindow, misses, passShare, searchLimit, spread, type FrameWindow, type LimitResult, type LineFit, type PassRow } from './headroom';

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
const HIDE = list(arg('hide', 'near,far,shadows,post')) as Array<'near' | 'far' | 'shadows' | 'post'>;
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

/** The orbit round the town square the far-field measurements use (0.15 rad/s at the 120 Hz step, 12 m out, 20 m up). */
const ORBIT = `
const quat = (yaw: number, pitch: number) => { const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };
export default {
  prepare() { return {}; },
  instantiate() { return { yaw: 0.4636 }; },
  step(s: any, ctx: any) {
    if (ctx.phase !== 'transform') return;
    s.yaw += 0.15 / 120;
    const pitch = 0.03, d = 12, c = Math.cos(pitch);
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: Math.sin(s.yaw) * c * d, y: 20 + Math.sin(pitch) * d, z: Math.cos(s.yaw) * c * d }, quaternion: quat(s.yaw, pitch) });
  },
  dispose() {},
};
`;
/** Behaviours that orbit the town square from the start (the far-field runs' camera, or this bench's). */
const ORBITS = new Set(['farcam5', 'headroom-orbit']);

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
  await command('publishBehavior', { behaviorId: 'headroom-orbit', displayName: 'headroom-orbit', mode: 'declaration-create', declaration }).catch((e: unknown) => {
    if (!String(e).includes('behavior_id_duplicate')) throw e;
  });
  await command('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const pub = await api('content/behaviors/source', { stageId, behaviorId: 'headroom-orbit', displayName: 'headroom-orbit', declaration, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}` });
  if (pub.status !== 200) throw new Error(`publish ${JSON.stringify(pub.json).slice(0, 300)}`);
  await command('setBehaviorProperties', { entityId: cam.id, behaviorId: 'headroom-orbit', values: {} });
}

interface MeterSettings {
  ballast?: number;
  copies?: number;
  copy?: 'near' | 'far';
  hide?: { near?: boolean; far?: boolean; shadows?: boolean; post?: boolean };
  renderScale?: number;
  dynamicResolution?: boolean;
}
interface Hook {
  meter: { set(s: MeterSettings): boolean; state(): { copyCpuMs: number; lightsHidden: number; frames: number; size: number[] } | null; record(seconds: number): Promise<number[]> };
  stats(): { worlds: Record<string, { far: { nodes: number; bricks: number } ; chunks: number }> };
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

async function main(): Promise<void> {
  await command('setEnvironment', { environment: { quality: QUALITY, qualityLevels: DEFAULT_QUALITY_LEVELS } });
  await orbitCamera();
  const host = () => ({ at: new Date().toISOString(), uptimeDays: Number((uptime() / 86400).toFixed(2)), load: loadavg().map((x) => Number(x.toFixed(2))) });
  const out: Record<string, unknown> = { bench: 'headroom', quality: QUALITY, renderer: 'webgpu', viewport: VIEWPORT, tierScale: TIER_SCALE, cap: CAP, window: WINDOW_S, world: WORLD, start: host(), rounds: [] as unknown[] };
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
      if (Date.now() - T0 > 420_000) throw new Error('the far field did not settle in 7 min');
      await page.waitForTimeout(250);
    }
    out['fillS'] = Number(((Math.min(settle.since, madeAt ?? Infinity) - T0) / 1000).toFixed(1));
    out['fill'] = await stats();
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
      // A pass hidden or shown again builds its programs again: wait for a second without a stall (≤ 12 s).
      if (JSON.stringify(was.hide ?? {}) !== JSON.stringify(s.hide ?? {}) || was.renderScale !== s.renderScale || (was.copy !== s.copy && s.copy !== undefined)) {
        for (let i = 0; i < 12; i++) if ((await frames(1)).stalls === 0) break;
      }
    };
    // The frames the page presents (a capped page skips animation frames).
    const frames = async (seconds: number): Promise<FrameWindow> => frameWindow(await canvas.evaluate((_c, s) => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.record(s), seconds), CAP);
    const probe = async (s: MeterSettings): Promise<FrameWindow> => {
      await set(s);
      return frames(WINDOW_S);
    };
    const meterState = async (key: 'copyCpuMs' | 'lightsHidden'): Promise<number | null> => (await canvas.evaluate(() => (window as unknown as { __tlVoxelPlay: Hook }).__tlVoxelPlay.meter.state()))?.[key] ?? null;
    const cpuMs = (): Promise<number | null> => meterState('copyCpuMs');
    // Programs built once for every kind of load before anything is timed.
    for (const s of [{ ballast: 1 }, ...COPIES.map((p) => ({ copies: 1, copy: p })), ...HIDE.map((p) => ({ hide: { [p]: true } }))] as MeterSettings[]) await probe(s);

    for (let round = 0; round < ROUNDS; round++) {
      const r: Record<string, unknown> = { round, start: host() };
      r['noLoad'] = await probe({});
      // The edge: the ballast the frame holds at the cap.
      const edge: LimitResult = await searchLimit((n) => probe({ ballast: n }), { max: BALLAST_LIMIT, start: 4, precision: 0.1, cap: CAP });
      r['edge'] = edge;
      const room = Math.max(0, edge.held);
      // Past the edge, where the GPU sets the interval: from 4 times the edge, doubling until the mean interval is
      // the cap's deep interval (a pass of several ms hidden must leave the frame past the edge), then the line through the half,
      // three quarters and the whole of that load (longer windows: stalls weigh on a mean).
      const deep = async (s: MeterSettings): Promise<FrameWindow> => {
        await set(s);
        return frames(WINDOW_S * 2);
      };
      let top = Math.min(BALLAST_LIMIT, 4 * Math.max(4, edge.missedAt ?? BALLAST_LIMIT / 4));
      let topWindow = await deep({ ballast: top });
      while (topWindow.meanMs < CAP.deepMs && top < BALLAST_LIMIT) topWindow = await deep({ ballast: (top = Math.min(BALLAST_LIMIT, top * 2)) });
      const past = [];
      for (const n of [Math.round(top / 2), Math.round((top * 3) / 4)]) past.push({ n, window: await deep({ ballast: n }) });
      past.push({ n: top, window: topWindow });
      const line: LineFit | null = fitLine(past.map((p) => ({ n: p.n, ms: p.window.meanMs })));
      r['pastEdge'] = past;
      r['line'] = line;
      if (line !== null) r['frameGpu'] = frameGpu(line, edge.held, edge.missedAt, CAP);
      // Each pass at the top load: hidden, or drawn once more; the frame as it is measured before and after.
      const at = top;
      const base = [topWindow.meanMs];
      const rows: PassRow[] = [];
      const shares: Record<string, FrameWindow> = {};
      for (const pass of HIDE) {
        shares[`hidden ${pass}`] = await deep({ ballast: at, hide: { [pass]: true } });
        if (pass === 'shadows') r['lightsHidden'] = await meterState('lightsHidden');
      }
      for (const pass of COPIES) {
        shares[`copy ${pass}`] = await deep({ ballast: at, copies: 1, copy: pass });
        r[`copyCpuMs ${pass}`] = await cpuMs();
      }
      base.push((await deep({ ballast: at })).meanMs);
      const baseMs = (base[0]! + base[1]!) / 2;
      r['base'] = { ballast: at, meanMs: base };
      if (line !== null) {
        for (const pass of HIDE) rows.push(passShare(pass, 'hidden', baseMs, shares[`hidden ${pass}`]!, line.slope, room, CAP));
        for (const pass of COPIES) rows.push(passShare(pass, 'copy', baseMs, shares[`copy ${pass}`]!, line.slope, room, CAP));
      }
      r['shares'] = shares;
      r['rows'] = rows;
      // The copies the frame holds at no load (a direct check on headroom ×).
      const copies: Record<string, LimitResult> = {};
      for (const pass of COPIES) copies[pass] = await searchLimit((n) => probe({ copies: n, copy: pass }), { max: COPY_LIMIT, start: 1, precision: 0.25, cap: CAP });
      r['copies'] = copies;
      // At no load: does the frame hold the cap with a pass hidden, and do its stalls go?
      const noLoadHidden: Record<string, FrameWindow> = {};
      for (const pass of HIDE) noLoadHidden[pass] = await probe({ hide: { [pass]: true } });
      r['noLoadHidden'] = noLoadHidden;
      const scales: Record<string, FrameWindow> = {};
      for (const s of SCALES) scales[String(s)] = await probe({ renderScale: s });
      r['scales'] = scales;
      await set({});
      r['end'] = host();
      (out['rounds'] as unknown[]).push(r);
      console.log(summary(r));
    }
    const rounds = out['rounds'] as Array<Record<string, unknown>>;
    out['spread'] = {
      edgeHeld: spread(rounds.map((r) => (r['edge'] as LimitResult).held)),
      ballastMs: spread(rounds.map((r) => (r['line'] as LineFit | null)?.slope ?? Number.NaN)),
      frameGpuFromLine: spread(rounds.map((r) => (r['line'] as LineFit | null)?.intercept ?? Number.NaN)),
      ...Object.fromEntries([...HIDE.map((p) => `hidden ${p}`), ...COPIES.map((p) => `copy ${p}`)].map((key) => [key, spread(rounds.map((r) => (r['rows'] as PassRow[]).find((x) => `${x.by} ${x.pass}` === key)?.ms ?? Number.NaN))])),
    };
    out['errors'] = errors.slice(0, 5);
    await control({ command: 'stop' }).catch(() => undefined);
  } catch (e) {
    out['error'] = String(e).slice(0, 600);
    console.error(out['error']);
  } finally {
    await browser.close().catch(() => undefined);
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
  const line = r['line'] as LineFit | null;
  const lines = [
    `round ${String(r['round'])} at ${CAP.fps} Hz: no load ${w.missed}/${w.frames} missed, ${w.stalls} stalls (mean ${w.meanMs} ms, ${misses(w, CAP) ? 'misses' : 'holds'}); ballast held ${e.held}, missed at ${String(e.missedAt)}`,
    `  past the edge: ${JSON.stringify((r['pastEdge'] as { n: number; window: FrameWindow }[]).map((p) => [p.n, p.window.meanMs]))}; a ballast copy ${String(line?.slope)} ms (worst residual ${String(line?.worstResidual)}); frame GPU ${JSON.stringify(r['frameGpu'])}`,
    ...(r['rows'] as PassRow[]).map((p) => `  ${p.by} ${p.pass}: ${p.lowerBound ? '≥ ' : ''}${p.ms} ms = ${p.units} units, headroom ×${p.lowerBound ? '≤ ' : ''}${String(p.headroomX)}`),
    ...Object.entries(r['copies'] as Record<string, LimitResult>).map(([k, v]) => `  ${k} copies at no load: held ${v.held}, missed at ${String(v.missedAt)} (CPU a frame ${String(r[`copyCpuMs ${k}`])} ms for one)`),
    ...Object.entries(r['noLoadHidden'] as Record<string, FrameWindow>).map(([k, v]) => `  ${k} hidden at no load: ${v.missed}/${v.frames} missed, ${v.stalls} stalls, mean ${v.meanMs}`),
    ...Object.entries(r['scales'] as Record<string, FrameWindow>).map(([k, v]) => `  scale ${k}: ${v.missed}/${v.frames} missed, ${v.stalls} stalls, mean ${v.meanMs}`),
  ];
  return lines.join('\n');
}

await main();
