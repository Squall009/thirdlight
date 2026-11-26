/**
 * What occlusion culling does at the connectivity views, read in Play (`node tools/voxel-bench/run.mjs cull-page …`):
 * staging's 8 km world on WebGPU at the tier's cap and render scale, the "Perf far camera" moved to each view of
 * cull-views.ts in turn. At each, once streaming has settled:
 *
 * - **H** (as shipped: the depth pyramid's path, `auto` with a far field): the occlusion diagnostics and, per draw of
 *   the voxel world, its kind (a level-0 chunk's surface, a level 1–2 node's, a seam, a kit piece draw), triangles,
 *   whether the frustum holds its box and whether the pyramid's last answer kept it (whole draws), and each kit
 *   piece copy's sphere;
 * - the **truth**: culling pinned off, then the occlusion oracle (an id picture of the view, three-adapter
 *   occlusion-oracle.ts) marks every draw no pixel shows;
 * - **I** (the pyramid's path with every one of those draws left out before it runs: what a perfect pre-filter of the
 *   table's rows could save at best) and **C** (only the level-0 chunks' surfaces among them: the most a chunk-level
 *   pre-filter, the connectivity flood's, could save), against **H** and **O** (culling off): the page's `render` ms
 *   and its whole frame, in `--rounds` rounds H O I C; with `--gpu-at LIST` also `measureGpu` (near, far) A B A B
 *   (H, C) there.
 *
 * Writes `views.json` (the per-view chunk lists connectivity-cli.ts joins with the flood) and `cull-page.json`.
 *
 *   --origin URL (default http://127.0.0.1:4180)  --project ID (voxel-slice)  --world NAME (far)  --quality low|medium|high (low)
 *   --only LIST   views by name (default: every far view of cull-views.ts)   --rounds N (default 2)   --window S (default 5)
 *   --gpu-at LIST  views with the measureGpu A B A B   --out DIR
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_QUALITY_LEVELS } from '@thirdlight/project-model';
import { profileSummary, type ProfileReport } from '@thirdlight/game-host';
import { commandEnvelope } from '../../tests/support/commands';
import { launchGpuBrowser } from '../perf/frame-run';
import { gpuMeasureOnPage, measureGpuOnPage } from '../perf/gpu-measure-page';
import { benchDir } from './bench-dirs';
import { CULL_VIEWS } from './cull-views';
import { benchApi, cameraBehaviour, publishCameraBehaviour } from './flight-camera';
import { caveStroke, lightShotsSource, shotCall, type LightingCamera } from './lighting-cameras';
import { openPlay, type PlayGame } from './travel-page';

/**
 * In a page, before its scripts (`addInitScript`): keep the scenes three
 * makes (its devtools channel announces each), so the bench reaches the game
 * scene's occlusion switch (`scene.userData.tlOcclusion`).
 */
function keepThreeScenes(): void {
  const w = window as unknown as { __tlScenes?: object[]; __THREE_DEVTOOLS__?: EventTarget };
  if (w.__tlScenes !== undefined) return;
  const scenes: object[] = [];
  w.__tlScenes = scenes;
  const hub = w.__THREE_DEVTOOLS__ ?? new EventTarget();
  w.__THREE_DEVTOOLS__ = hub;
  hub.addEventListener('observe', (ev) => {
    const d = (ev as CustomEvent).detail as { isScene?: boolean } | null;
    if (d?.isScene === true) scenes.push(d);
  });
}

function arg(name: string, fallback: string | null): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
const ORIGIN = arg('origin', 'http://127.0.0.1:4180')!;
const PROJECT = arg('project', 'voxel-slice')!;
const WORLD = arg('world', 'far')!;
const QUALITY = arg('quality', 'low')!;
const ROUNDS = Number(arg('rounds', '2'));
const WINDOW_S = Number(arg('window', '5'));
const ONLY = arg('only', null)?.split(',') ?? null;
const GPU_AT = arg('gpu-at', '')!.split(',').filter((s) => s !== '');
const DATA_ROOT = join(homedir(), 'thirdlight-staging-p45');
const PROJECT_DIR = join(DATA_ROOT, 'projects', PROJECT);
const TOKEN = readFileSync(join(DATA_ROOT, 'owner-token'), 'utf8').trim();
const OUT = arg('out', null) ?? benchDir('cull-page', `${QUALITY}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
const LEVEL = DEFAULT_QUALITY_LEVELS.find((l) => l.id === QUALITY);
const VIEWPORT = { width: 1280, height: 720 };
/** The behaviour id light-shots publishes for the same camera: reused, so the bench adds nothing to the project. */
const BEHAVIOR = 'light-shots-camera';

const VIEWS = CULL_VIEWS.filter((v) => v.world === 'far' && (ONLY === null || ONLY.includes(v.name)));
const CAMERAS: LightingCamera[] = VIEWS.map((v, i) => ({ name: v.name as LightingCamera['name'], command: `cull${i + 1}`, eye: v.eye, yaw: v.yaw, pitch: v.pitch, preset: 'bench-noon', near: true, shows: v.shows }));

/** In the page: the scene with the occlusion switch, its culler's view camera and renderer. */
function cullerOf(): { scene: any; sw: any; camera: any; renderer: any } {
  const scenes = (window as unknown as { __tlScenes?: any[] }).__tlScenes ?? [];
  const scene = scenes.find((s) => s.userData?.['tlOcclusion'] !== undefined);
  if (scene === undefined) throw new Error('no scene with an occlusion switch');
  const sw = scene.userData['tlOcclusion'];
  return { scene, sw, camera: sw.deps.view?.camera ?? null, renderer: sw.deps.gpu?.() ?? null };
}

/** In the page: the voxel world's draws now (see the module comment). */
function readDraws(): unknown {
  const { scene, sw, camera } = (window as unknown as { __tlCullerOf: typeof cullerOf }).__tlCullerOf();
  camera.updateMatrixWorld();
  // The view's side planes from its projection × view (row-major access of three's column-major elements).
  const p = camera.projectionMatrix.elements as number[];
  const v = camera.matrixWorldInverse.elements as number[];
  const m = new Array<number>(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) m[c * 4 + r]! += p[k * 4 + r]! * v[c * 4 + k]!;
  const row = (r: number): number[] => [m[r]!, m[4 + r]!, m[8 + r]!, m[12 + r]!];
  const w = row(3);
  const planes = [0, 1].flatMap((r) => [row(r).map((x, i) => w[i]! + x), row(r).map((x, i) => w[i]! - x)]);
  const inView = (min: number[], max: number[]): boolean => planes.every((pl) => pl[0]! * (pl[0]! >= 0 ? max[0]! : min[0]!) + pl[1]! * (pl[1]! >= 0 ? max[1]! : min[1]!) + pl[2]! * (pl[2]! >= 0 ? max[2]! : min[2]!) + pl[3]! >= 0);
  const wholes: Map<unknown, { row: number; seen: number }> | undefined = sw.frame?.wholes?.entries;
  const out: any[] = [];
  const pieces: any[] = [];
  scene.traverse((o: any) => {
    if (o.isMesh !== true) return;
    const g = o.geometry;
    const copies = o.userData['__tlCullableCopies'];
    const parent = o.parent?.name ?? '';
    const isChunk = o.userData['voxelChunk'] !== undefined;
    const isSeam = typeof o.name === 'string' && o.name.startsWith('voxel-seam');
    const isPiece = copies !== undefined && copies.world instanceof Float32Array && copies.drawn instanceof Float32Array;
    if (!isChunk && !isSeam && !isPiece) return;
    if (g.boundingBox === null) g.computeBoundingBox();
    const bb = g.boundingBox;
    o.updateMatrixWorld();
    const e = o.matrixWorld.elements as number[];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? bb.max.x : bb.min.x;
      const y = i & 2 ? bb.max.y : bb.min.y;
      const z = i & 4 ? bb.max.z : bb.min.z;
      const q = [e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!];
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a]!, q[a]!);
        max[a] = Math.max(max[a]!, q[a]!);
      }
    }
    const shown = o.visible === true && o.layers.test(camera.layers) && (o.parent === null || o.parent.visible !== false);
    const triangles = Math.floor((g.index !== null ? g.index.count : g.getAttribute('position').count) / 3);
    const hidden = ((o.userData['__tlHiddenBy'] ?? 0) & 8) !== 0;
    if (isPiece) {
      const n = Number.isFinite(g.instanceCount) ? g.instanceCount : 0;
      const s = copies.world as Float32Array;
      pieces.push({ name: g.name, copies: n, triangles, shown, hidden, spheres: Array.from(s.subarray(0, n * 4), (x) => Math.round(x * 100) / 100) });
      return;
    }
    const wh = wholes?.get(o);
    out.push({ name: isSeam ? o.name : parent, level: o.userData['voxelLevel'] ?? (isSeam ? 1 : 0), triangles, shown, hidden, frustum: shown && inView(min, max), listed: wh !== undefined && wh.row >= 0, pyramidSeen: wh === undefined ? null : wh.seen });
  });
  return { draws: out, pieces, diagnostics: sw.diagnostics() };
}

/** In the page: the oracle (culling pinned off by it at the end), the draws it found wholly hidden kept hidden. */
async function runTruth(): Promise<unknown> {
  const { scene, camera, renderer } = (window as unknown as { __tlCullerOf: typeof cullerOf }).__tlCullerOf();
  const r = await scene.userData['tlOcclusionOracle'](renderer, camera, { hideHidden: true });
  const hidden: any[] = [];
  scene.traverse((o: any) => {
    if (((o.userData?.['__tlHiddenBy'] ?? 0) & 8) !== 0) hidden.push(o);
  });
  (window as unknown as { __tlCullHidden: unknown[] }).__tlCullHidden = hidden;
  // The level-0 chunks' surfaces alone: the most a chunk-level pre-filter (the connectivity flood's) could leave out.
  (window as unknown as { __tlCullHidden0: unknown[] }).__tlCullHidden0 = hidden.filter((o) => o.userData['voxelChunk'] !== undefined && (o.userData['voxelLevel'] ?? 0) === 0);
  const { pictures: _p, ...rest } = r;
  return { ...rest, hiddenMarked: hidden.length };
}

/** In the page: the oracle's hidden draws shown again (`none`), every one hidden again (`all`) or only the level-0 chunks' (`l0`), as view-hidden.ts marks them. */
function markHidden(which: 'none' | 'all' | 'l0'): number {
  const w = window as unknown as { __tlCullHidden?: any[]; __tlCullHidden0?: any[] };
  const all = w.__tlCullHidden ?? [];
  const l0 = new Set(w.__tlCullHidden0 ?? []);
  for (const o of all) {
    const on = which === 'all' || (which === 'l0' && l0.has(o));
    const was = o.userData['__tlHiddenBy'] ?? 0;
    const now = on ? was | 8 : was & ~8;
    if (now === 0) delete o.userData['__tlHiddenBy'];
    else o.userData['__tlHiddenBy'] = now;
    if (now === 0) {
      o.layers.enable(0);
      o.layers.disable(31);
    } else {
      o.layers.disable(0);
      o.layers.enable(31);
    }
  }
  return which === 'none' ? 0 : which === 'all' ? all.length : l0.size;
}

function pin(path: string | null): void {
  (window as unknown as { __tlCullerOf: typeof cullerOf }).__tlCullerOf().sw.pin(path);
}

async function settle(game: PlayGame): Promise<number | null> {
  const t0 = Date.now();
  let last = '';
  let stillSince = Date.now();
  for (;;) {
    const w = await game.frame.evaluate((world) => (window as unknown as { __tlVoxelPlay?: { stats(): { worlds: Record<string, any> } } }).__tlVoxelPlay?.stats().worlds[world] ?? null, WORLD).catch(() => null);
    const sim = await game.sim().catch(() => null);
    const pending = [Number(sim?.['pool']?.queued ?? 0), Number(sim?.['pool']?.inFlight ?? 0), Number(sim?.['far']?.pending ?? 0), Number(sim?.['far']?.jobs ?? 0)];
    const now = w === null ? '' : JSON.stringify([w.chunks, w.levels, w.kitInstances]);
    if (now !== last || pending.some((x) => x !== 0)) {
      last = now;
      stillSince = Date.now();
    }
    if (w !== null && Date.now() - stillSince > 3000) return Number(((Date.now() - t0) / 1000).toFixed(1));
    if (Date.now() - t0 > 150_000) return null;
    await game.page.waitForTimeout(250);
  }
}

async function profileWindow(game: PlayGame): Promise<Record<string, unknown>> {
  await game.page.waitForTimeout(WINDOW_S * 1000);
  const r = (await game.frame.evaluate(() => (window as unknown as { __tlProfiler?: { read(): unknown } }).__tlProfiler?.read() ?? null)) as ProfileReport | null;
  if (r === null) return { none: true };
  const s = profileSummary(r);
  const render = s.rows.find((x) => x.thread === 'page' && x.category === 'render');
  const frames = r.counters.frames;
  return { pageMs: s.msPerFrame.page, simMs: s.msPerFrame.sim, renderMs: render?.meanMs ?? null, renderWorst: render?.worstMs ?? null, frames: s.frames.page, drawCalls: frames.length === 0 ? null : frames[frames.length - 1]!.drawCalls };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const b = benchApi({ origin: ORIGIN, token: TOKEN, project: PROJECT, clientId: 'voxel-bench-cull-page' });
  // The cave the town's cave views stand in: refused with no_change once it is there.
  const dug = await b.api('commands', commandEnvelope('editVoxels', PROJECT, undefined, { world: WORLD, command: caveStroke() }, 'voxel-bench-cull-page'));
  if (dug.json['ok'] !== true && (dug.json['error'] as { code?: string } | undefined)?.code !== 'no_change') throw new Error(`the cave: ${JSON.stringify(dug.json).slice(0, 300)}`);
  const before = cameraBehaviour(PROJECT_DIR);
  await publishCameraBehaviour(b, PROJECT_DIR, BEHAVIOR, lightShotsSource(CAMERAS));
  const record: Record<string, unknown> = { bench: 'cull-page', quality: QUALITY, cap: LEVEL?.frameRateCap ?? null, renderScale: LEVEL?.renderScale ?? 1, viewport: VIEWPORT, start: { uptimeS: Math.round(uptime()), load: loadavg().map((l) => Number(l.toFixed(2))), at: new Date().toISOString() }, views: [] as unknown[] };
  const pages: unknown[] = [];
  const browser = await launchGpuBrowser({ vsync: true });
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await context.addInitScript(keepThreeScenes);
    await context.addInitScript(`window.__tlCullerOf = ${cullerOf.toString()};`);
    const page = await context.newPage();
    const game = await openPlay(b, page, { viewport: VIEWPORT, query: '', quality: QUALITY, world: WORLD });
    for (let i = 0; i < 240 && (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: unknown }).__tlVoxelPlay !== undefined)) === false; i++) await page.waitForTimeout(250);
    await game.frame.evaluate((s) => (window as unknown as { __tlVoxelPlay: { meter: { set(x: unknown): boolean } } }).__tlVoxelPlay.meter.set(s), { renderScale: LEVEL?.renderScale ?? 1, dynamicResolution: false, hide: {} });
    for (const cam of CAMERAS) {
      await game.debug(...shotCall(cam));
      const settledS = await settle(game);
      await page.waitForTimeout(1500);
      const rec: Record<string, unknown> = { name: cam.name, settledS };
      await game.screenshot(join(OUT, `${cam.name}.png`));
      rec['H'] = await game.frame.evaluate(readDraws);
      rec['truth'] = await game.frame.evaluate(() => {
        (window as unknown as { __tlCullerOf: typeof cullerOf }).__tlCullerOf().sw.pin('off');
      }).then(() => page.waitForTimeout(1500)).then(() => game.frame.evaluate(runTruth));
      // Hidden draws marked: the lists again (their `hidden` flags are the truth), then shown again.
      rec['marked'] = await game.frame.evaluate(readDraws);
      await game.frame.evaluate(markHidden, 'none' as const);
      await game.frame.evaluate(pin, null);
      await page.waitForTimeout(1500);
      const rounds: Record<string, unknown>[] = [];
      for (let k = 0; k < ROUNDS; k++) {
        for (const state of ['H', 'O', 'I', 'C'] as const) {
          await game.frame.evaluate(pin, state === 'O' ? 'off' : null);
          await game.frame.evaluate(markHidden, (state === 'I' ? 'all' : state === 'C' ? 'l0' : 'none') as 'none' | 'all' | 'l0');
          await page.waitForTimeout(1000);
          rounds.push({ state, ...(await profileWindow(game)) });
        }
      }
      if (GPU_AT.includes(cam.name)) {
        const gpu: Record<string, unknown>[] = [];
        for (const state of ['H', 'C', 'H', 'C'] as const) {
          await game.frame.evaluate(pin, null);
          await game.frame.evaluate(markHidden, (state === 'C' ? 'l0' : 'none') as 'none' | 'all' | 'l0');
          await page.waitForTimeout(1000);
          const g = await measureGpuOnPage((call, options) => game.frame.evaluate(gpuMeasureOnPage, { call, ...(options !== undefined ? { options } : {}) }), (ms) => page.waitForTimeout(ms), { repeats: 3, only: ['near', 'far'] });
          gpu.push({ state, categories: g.categories.map((c) => ({ category: c.category, ms: c.ms, median: c.medianMs, spread: c.spreadMs })), resolutionMs: g.resolutionMs, seconds: g.seconds });
          console.log(`${cam.name} gpu ${state}: ${JSON.stringify(gpu[gpu.length - 1])}`);
        }
        rec['gpu'] = gpu;
      }
      await game.frame.evaluate(markHidden, 'none' as const);
      await game.frame.evaluate(pin, null);
      await game.frame.evaluate(() => void ((window as unknown as { __tlCullHidden?: unknown[]; __tlCullHidden0?: unknown[] }).__tlCullHidden = (window as unknown as { __tlCullHidden0?: unknown[] }).__tlCullHidden0 = []));
      rec['rounds'] = rounds;
      (record['views'] as unknown[]).push(rec);
      // The level-0 chunks for the flood's join: by chunk ("voxel-chunk cx,cy,cz").
      const H = rec['H'] as { draws: Array<{ name: string; level: number; triangles: number; frustum: boolean; pyramidSeen: number | null }> };
      const marked = rec['marked'] as { draws: Array<{ name: string; level: number; hidden: boolean }> };
      const hiddenByName = new Map(marked.draws.map((d) => [`${d.level}|${d.name}`, d.hidden]));
      pages.push({
        name: cam.name,
        level0: H.draws.filter((d) => d.level === 0 && d.name.startsWith('voxel-chunk ')).map((d) => ({ chunk: d.name.slice('voxel-chunk '.length), triangles: d.triangles, frustum: d.frustum, pyramid: d.pyramidSeen === null ? null : d.pyramidSeen !== 0, seen: hiddenByName.has(`0|${d.name}`) ? !hiddenByName.get(`0|${d.name}`) : null })),
      });
      const sum = (pred: (d: (typeof H.draws)[number]) => boolean): string => {
        const s = H.draws.filter((d) => d.frustum && pred(d));
        return `${s.length}/${s.reduce((n, d) => n + d.triangles, 0)}`;
      };
      console.log(`${cam.name}: settled ${String(settledS)} s; frustum ${sum(() => true)}, pyramid kept ${sum((d) => d.pyramidSeen !== 0)}, seen ${sum((d) => hiddenByName.get(`${d.level}|${d.name}`) === false)}; rounds ${JSON.stringify(rounds.map((r) => [r['state'], r['renderMs'], r['pageMs']]))}`);
      writeFileSync(join(OUT, 'views.json'), JSON.stringify(pages));
      writeFileSync(join(OUT, 'cull-page.json'), JSON.stringify(record));
    }
    record['end'] = { uptimeS: Math.round(uptime()), load: loadavg().map((l) => Number(l.toFixed(2))), at: new Date().toISOString() };
    writeFileSync(join(OUT, 'cull-page.json'), JSON.stringify(record));
    await game.stop();
  } finally {
    await browser.close();
    const cam = (JSON.parse(readFileSync(join(PROJECT_DIR, 'scenes', 'scene-main.json'), 'utf8')).scene.entities as Array<{ id: string; name: string }>).find((e) => e.name === 'Perf far camera');
    if (before !== null && before !== BEHAVIOR && cam !== undefined) await b.command('setBehaviorProperties', { entityId: cam.id, behaviorId: before, values: {} }).catch(() => undefined);
  }
  console.log(`cull-page → ${OUT}`);
}

await main();
