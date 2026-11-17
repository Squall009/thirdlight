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
 * (`__tlVoxelPlay.edits()`) and to the first frame whose key-light shadow map was drawn again after it (edit →
 * light, `editShadowTiming`). With `--gpu`, at each camera after its pictures the page's GPU measurement
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
 *   --only LIST   cameras by name (default all five; also far-lamp-a, far-lamp-b, far-view-1m, street-noon-1m, street-noon-2m, room-window-2m)   --query Q   more of the editor page's query (Play is
 *                 passed its flags: a later item's lighting arrangement), starting with `&`
 *   --hold S (default 3)  --timeout S a camera (default 180)  --edits N (default 3, 0: none)
 *   --gpu         the GPU measurement at each camera (about two minutes each)   --gpu-repeats N (default 5)
 *   --gpu-only LIST  only these categories (near,far,shadows,lighting,post,effects)
 *   --gpu-stale   a second GPU measurement at each camera while the light volume has work (every brick marked
 *                 stale every half second meanwhile: its update at its budget)
 *   --cache-edits the lighting store's edit → light times: a window dug through the room camera's wall, then a wall
 *                 built between a lamp and the house fronts at night and dug again (from the command to the change
 *                 reaching the volume, its first cell faces written, settled; a picture after each)
 *   --arrival-shots  pictures 2 s and 10 s after each camera's move (`<name>-arrive-2s.png`, `-10s`), before it settles
 *   --light-out   the light volume's light taken out of the scene's lights before each GPU measurement (and left out)
 *   --texture-units STORE  the texture-unit guard's record on (the device's limit, each program's sampled fragment
 *                 textures by name, admitted or refused), then the store (`off` or `volume`) set on the page (run
 *                 with `--query &voxelLight=off`); each shot keeps the record (`textureUnits`); with `volume`, after the
 *                 shots the store goes off again and the page's walk is read before and after (`walkRelease`)
 *   --extra-lamps N  N more point lamps scattered over the night camera's window (bench data, taken out after; no
 *                 shadows): the light volume's cost with many lamps
 *   --light-types a spot aimed down at a house front and a rect area light on another front at the night camera
 *                 (bench data, taken out after; no shadow maps): the light volume's bounce of the other light types
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
import { BENCH_EXTRA_LAMP_LIGHT, BENCH_LAMP_LIGHT, BENCH_LAMPS, BENCH_LIGHT_TYPES, benchExtraLamps, cacheEditTiming, caveStroke, LAMP_WALL_COMMANDS, type CacheWatchFrame, FAR_CHECK_LAMP, FAR_CHECK_LAMP_LIGHT, LIGHT_CHECK_CAMERAS, changedShare, EDIT_DIGS, editShadowTiming, LIGHTING_CAMERAS, LIGHTING_PRESETS, lightShotsSource, parseLightShotsArgs, shotProblems, type WatchFrame } from './lighting-cameras';
import { gpuMeasureOnPage, gpuMeasureSummary, measureGpuOnPage } from '../perf/gpu-measure-page';
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
/** The second picture after a GPU measurement, this long after the first. */
const AFTER_GPU_LATER_MS = 10_000;

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
  /** The key light's cached static map draws so far (null: no cached shadow). */
  shadowDraws(): number | null;
  /** The sun heights the key light's march reads (null: none on the page). */
  sun?(): unknown;
  /** The lighting store: which, the light volume's state and how far its light has caught up. */
  light?: { store(): string; volume?(): VolumeStats | null; progress(): { texelsWritten: number; staleUnits: number; waiting: number; probesSettled: boolean; probesStale: number; settled?: boolean } | null; relightAll(): void };
}
/** The light volume's diagnostics as the page gives them. */
type VolumeStats = Record<string, unknown>;

/**
 * Waits until the light volume has settled (every block looked at, every kept brick updated to its settle count, cell
 * faces written), held a second; how long it took and its diagnostics then.
 */
async function volumeLit(game: PlayGame): Promise<{ litS: number | null; state: VolumeStats | null }> {
  const t0 = Date.now();
  let calm = 0;
  for (;;) {
    const p = await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.light?.progress() ?? null).catch(() => null);
    calm = p !== null && p.settled === true && p.texelsWritten > 0 && p.waiting === 0 ? calm + 1 : 0;
    const done = calm >= 4 || Date.now() - t0 > LIT_TIMEOUT_MS;
    if (done) {
      const v = (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.light?.volume?.() ?? null).catch(() => null)) as VolumeStats | null;
      return { litS: calm >= 4 ? Number(((Date.now() - t0) / 1000).toFixed(1)) : null, state: v };
    }
    await game.page.waitForTimeout(250);
  }
}

/**
 * In the page: the light volume's cells in a box round `eye` (±4 m across, ±2 m up, every 0.5 m) read back from the GPU,
 * summed up: cells the CPU's rule says hold light, those the GPU holds light in (a face not the word 0), those that
 * differ among bricks updated, the mean light of the faces facing up and down, and a few cells.
 */
async function volumeCellsRound(eye: number[]): Promise<unknown> {
  type Cell = { cell: number[]; kept: boolean; slot: number; updates: number; holds: boolean; faces: (number[] | null)[] };
  const l = (window as unknown as { __tlVoxelPlay?: { light?: { volumeCells?(p: number[][]): Promise<Cell[] | null> } } }).__tlVoxelPlay?.light;
  const pts: number[][] = [];
  for (let dx = -4; dx <= 4; dx += 0.5) for (let dy = -2; dy <= 2; dy += 0.5) for (let dz = -4; dz <= 4; dz += 0.5) pts.push([eye[0]! + dx + 0.25, eye[1]! + dy + 0.25, eye[2]! + dz + 0.25]);
  const cells = (await l?.volumeCells?.(pts)) ?? null;
  if (cells === null) return null;
  let holds = 0;
  let gpu = 0;
  let differ = 0;
  let kept = 0;
  const up = [0, 0, 0];
  const down = [0, 0, 0];
  const examples: unknown[] = [];
  for (const c of cells) {
    const valid = c.faces.some((f) => f !== null);
    if (c.kept) kept++;
    if (c.holds) holds++;
    if (valid) {
      gpu++;
      for (let k = 0; k < 3; k++) {
        up[k]! += c.faces[2]?.[k] ?? 0;
        down[k]! += c.faces[3]?.[k] ?? 0;
      }
    }
    if (c.updates > 0 && c.holds !== valid) {
      differ++;
      if (examples.length < 4) examples.push(c);
    }
  }
  const mean = (v: number[]): number[] => v.map((x) => Number((x / Math.max(gpu, 1)).toFixed(4)));
  return { cells: cells.length, kept, holds, gpu, differ, up: mean(up), down: mean(down), examples, some: cells.filter((c) => c.faces.some((f) => f !== null)).slice(0, 3) };
}

/** Waits for the page's lighting store to light what it holds (`off`: nothing to wait for). */
async function storeLit(game: PlayGame, store: string): Promise<{ litS: number | null; state: VolumeStats | null }> {
  return store === 'volume' ? volumeLit(game) : { litS: null, state: null };
}

/** The longest a shot waits for the light volume to settle. */
const LIT_TIMEOUT_MS = 120_000;

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
  const lamps = [...BENCH_LAMPS.map((l) => ({ ...l, light: BENCH_LAMP_LIGHT })), ...(O.only.some((n) => n.startsWith('far-lamp')) ? [{ ...FAR_CHECK_LAMP, light: FAR_CHECK_LAMP_LIGHT }] : []), ...benchExtraLamps(O.extraLamps).map((l) => ({ ...l, light: BENCH_EXTRA_LAMP_LIGHT })), ...(O.lightTypes ? BENCH_LIGHT_TYPES : [])];
  for (const lamp of lamps) {
    const had = sceneEntities().find((e) => e.name === lamp.name);
    if (had !== undefined) await b.command('deleteEntity', { entityId: had.id });
    const turn = 'rotation' in lamp && lamp.rotation !== undefined ? { rotation: [...lamp.rotation] } : {};
    await b.command('createEntity', { sceneId: 'scene-main', kind: 'group', name: lamp.name, transform: { position: [...lamp.position], ...turn }, components: { light: { ...lamp.light } } });
  }
  const before = cameraBehaviour(PROJECT_DIR);
  await publishCameraBehaviour(b, PROJECT_DIR, BEHAVIOR, lightShotsSource());
  return async () => {
    for (const lamp of lamps) {
      const e = sceneEntities().find((x) => x.name === lamp.name);
      if (e !== undefined) await b.command('deleteEntity', { entityId: e.id }).catch((err: unknown) => console.error(`lamp not taken out: ${String(err)}`));
    }
    const cam = sceneEntities().find((e) => e.name === 'Perf far camera');
    if (before !== null && before !== BEHAVIOR && cam !== undefined) await b.command('setBehaviorProperties', { entityId: cam.id, behaviorId: before, values: {} }).catch(() => undefined);
  };
}

/** Spans the open regions are measured by, with the job's whole derive beside them: own ms a frame on each thread. */
const REGION_SPANS = ['open regions stitched', 'open regions', 'job derive', 'voxel streaming'];
function regionSpans(r: ProfileReport | null): Record<string, number> | null {
  if (r === null) return null;
  const out: Record<string, number> = {};
  for (const thread of ['sim', 'jobs'] as const) {
    const frames = r.threads[thread];
    if (frames.length === 0) continue;
    for (const f of frames) for (const sp of f.spans) if (REGION_SPANS.includes(sp.name)) out[`${thread}/${sp.name}`] = (out[`${thread}/${sp.name}`] ?? 0) + sp.selfMs;
    for (const k of Object.keys(out)) if (k.startsWith(`${thread}/`)) out[k] = Number((out[k]! / frames.length).toFixed(3));
  }
  return out;
}

/** The page's lighting spans: own ms a frame (mean, worst) of the lighting work. */
const LIGHTING_SPANS = ['surface light', 'lights, shadows and environment', 'voxel sun heights', 'voxel light volume'];
function lightingSpans(r: ProfileReport | null): Record<string, { mean: number; worst: number }> | null {
  if (r === null) return null;
  const frames = r.threads.page;
  if (frames.length === 0) return null;
  const sum: Record<string, number> = {};
  const worst: Record<string, number> = {};
  for (const f of frames) {
    const own: Record<string, number> = {};
    for (const sp of f.spans) if (LIGHTING_SPANS.includes(sp.name)) own[sp.name] = (own[sp.name] ?? 0) + sp.selfMs;
    for (const [k, v] of Object.entries(own)) {
      sum[k] = (sum[k] ?? 0) + v;
      worst[k] = Math.max(worst[k] ?? 0, v);
    }
  }
  return Object.fromEntries(Object.keys(sum).map((k) => [k, { mean: Number((sum[k]! / frames.length).toFixed(3)), worst: Number(worst[k]!.toFixed(2)) }]));
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const b = benchApi({ origin: O.origin, token: TOKEN, project: O.project, clientId: 'voxel-bench-light-shots' });
  const out: Record<string, unknown> = { bench: 'light-shots', extraLamps: O.extraLamps, lightTypes: O.lightTypes, quality: O.quality, renderer: 'webgpu', viewport: O.viewport, tierScale: TIER_SCALE, cap: LEVEL?.frameRateCap ?? null, query: O.query, world: O.world, start: host(), shots: [] as unknown[], problems: [] as string[] };
  const problems = out['problems'] as string[];
  const restore = await prepare(b);
  const browser = await launchGpuBrowser({ vsync: true });
  try {
    const context = await browser.newContext({ viewport: O.viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => void (m.type() === 'error' && errors.push(m.text().slice(0, 200))));
    const game = await openPlay(b, page, { viewport: O.viewport, query: O.query, quality: O.quality, world: O.world });
    const playAt = Date.now();
    out['renderer'] = await game.frame.evaluate(() => { const c = document.querySelector('canvas[data-tl-renderer]'); return `${c?.getAttribute('data-tl-renderer')}/${c?.getAttribute('data-tl-renderer-state')}`; });
    // The meter exists once the page draws its voxel world.
    for (let i = 0; i < 240 && (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: unknown }).__tlVoxelPlay !== undefined)) === false; i++) await page.waitForTimeout(250);
    await meterSet(game, {});
    if (O.textureUnits !== null) {
      // The record first (programs are counted as they are made), then the store linked under it.
      await game.frame.evaluate((store) => {
        const l = (window as unknown as { __tlVoxelPlay: { light: { textureUnits(): unknown; setStore(s: string): void } } }).__tlVoxelPlay.light;
        l.textureUnits();
        l.setStore(store);
      }, O.textureUnits);
    }
    // While the town streams in (the first camera's view, before anything settles): the regions' spans a frame.
    await game.debug(LIGHTING_CAMERAS[0]!.command);
    await page.waitForTimeout(4000);
    out['loadingSpans'] = regionSpans((await game.frame.evaluate(() => (window as unknown as { __tlProfiler?: { read(): unknown } }).__tlProfiler?.read() ?? null)) as ProfileReport | null);
    console.log(`loading: ${JSON.stringify(out['loadingSpans'])}`);
    for (const cam of [...LIGHTING_CAMERAS, ...LIGHT_CHECK_CAMERAS].filter((c) => O.only.includes(c.name))) {
      await game.debug(cam.command);
      const arrived = Date.now();
      const arrival: Record<string, unknown>[] = [];
      if (O.arrivalShots) {
        // What a player sees before the light has caught up: 2 s and 10 s after the move.
        for (const at of [2, 10]) {
          await page.waitForTimeout(Math.max(0, arrived + at * 1000 - Date.now()));
          const f = join(OUT, `${cam.name}-arrive-${at}s.png`);
          await game.screenshot(f);
          arrival.push({ at, file: f, progress: await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.light?.progress() ?? null).catch(() => null) });
        }
      }
      const s = await settle(game);
      // The store's light caught up (the volume only): from the camera's move and from Play's start.
      const store = (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.light?.store() ?? 'off')) as string;
      const lit = await storeLit(game, store);
      const sincePlayS = Number(((Date.now() - playAt) / 1000).toFixed(1));
      if (lit.state !== null) console.log(`${cam.name}: ${store} lit after ${lit.litS ?? 'never'} s (${sincePlayS} s from Play): ${JSON.stringify(lit.state)}`);
      await page.waitForTimeout(CONVERGE_MS);
      const file = join(OUT, `${cam.name}.png`);
      const shown = decodePng(await game.screenshot(file));
      const profile = await game.frame.evaluate(() => (window as unknown as { __tlProfiler?: { read(): unknown } }).__tlProfiler?.read() ?? null);
      // The same view a second later: what changes in a still, settled picture (flicker).
      await page.waitForTimeout(1000);
      const secondShare = changedShare(shown, decodePng(await game.screenshot(join(OUT, `${cam.name}-1s.png`))));
      // The same view with the voxel draws hidden: what changes is what the voxels drew.
      await meterSet(game, { near: true, far: true });
      await page.waitForTimeout(CONVERGE_MS);
      const hiddenFile = join(OUT, `${cam.name}-voxels-hidden.png`);
      const hidden = decodePng(await game.screenshot(hiddenFile));
      await meterSet(game, {});
      const voxelShare = changedShare(shown, hidden);
      const sun = await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.sun?.() ?? null).catch(() => null);
      // The light volume's cells read back round the eye, against the CPU's rule (which cells hold light).
      const volumeCells = store === 'volume' ? await game.frame.evaluate(volumeCellsRound, [...cam.eye]).catch((e: unknown) => String(e)) : null;
      if (volumeCells !== null) console.log(`${cam.name}: volume cells ${JSON.stringify(volumeCells).slice(0, 600)}`);
      let gpu: unknown = null;
      let afterGpuShare: number | null = null;
      let afterGpuLaterShare: number | null = null;
      if (O.gpu && O.lightOut) {
        // The volume's light out of the scene's lights: every lit program built again without its node.
        await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: { light?: { volumeLightShown?(on: boolean): unknown } } }).__tlVoxelPlay?.light?.volumeLightShown?.(false));
        await page.waitForTimeout(5000);
      }
      if (O.gpu) {
        try {
          const g = await measureGpuOnPage((call, options) => game.frame.evaluate(gpuMeasureOnPage, { call, ...(options !== undefined ? { options } : {}) }), (ms) => page.waitForTimeout(ms), { repeats: O.gpuRepeats, ...(O.gpuOnly !== null ? { only: O.gpuOnly } : {}) });
          gpu = g;
          console.log(`${cam.name}: ${gpuMeasureSummary(g)}`);
          // The meter's pin again (the measurement let go of its own hold), then the same view once more.
          await meterSet(game, {});
          await page.waitForTimeout(CONVERGE_MS);
          afterGpuShare = changedShare(shown, decodePng(await game.screenshot(join(OUT, `${cam.name}-after-gpu.png`))));
          // And again later: what a measurement changed that the page gives back by itself (texture residency, history).
          await page.waitForTimeout(AFTER_GPU_LATER_MS);
          afterGpuLaterShare = changedShare(shown, decodePng(await game.screenshot(join(OUT, `${cam.name}-after-gpu-later.png`))));
          if (afterGpuLaterShare > AFTER_GPU_SHARE) problems.push(`${cam.name}: the picture after the GPU measurement differs from before it in ${(afterGpuShare * 100).toFixed(2)} % of its pixels, ${(afterGpuLaterShare * 100).toFixed(2)} % ${AFTER_GPU_LATER_MS / 1000} s later`);
        } catch (e) {
          problems.push(`${cam.name}: GPU measurement: ${String(e).slice(0, 200)}`);
        }
      }
      let gpuStale: unknown = null;
      if (O.gpuStale && lit.state !== null) {
        // The volume kept at work: every brick stale every half second while the measurement runs.
        await game.frame.evaluate(() => {
          const w = window as unknown as { __tlVoxelPlay?: Hook; __tlRelightTick?: number };
          w.__tlVoxelPlay?.light?.relightAll();
          w.__tlRelightTick = setInterval(() => w.__tlVoxelPlay?.light?.relightAll(), 500) as unknown as number;
        });
        try {
          const before = await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.light?.progress() ?? null);
          // The light volume's own reading of its pass (timestamps: ms and bricks timed so far) beside the measurement's.
          const volumeDiag = (): Promise<unknown> => game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.light?.volume?.() ?? null).catch(() => null);
          const volumeBefore = await volumeDiag();
          const g = await measureGpuOnPage((call, options) => game.frame.evaluate(gpuMeasureOnPage, { call, ...(options !== undefined ? { options } : {}) }), (ms) => page.waitForTimeout(ms), { repeats: O.gpuRepeats, ...(O.gpuOnly !== null ? { only: O.gpuOnly } : {}) });
          const after = await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.light?.progress() ?? null);
          const staleProfile = await game.frame.evaluate(() => (window as unknown as { __tlProfiler?: { read(): unknown } }).__tlProfiler?.read() ?? null);
          const volumeAfter = await volumeDiag();
          gpuStale = { measure: g, before, after, volumeBefore, volumeAfter, lightingSpans: lightingSpans(staleProfile as ProfileReport | null), profile: staleProfile === null ? null : profileSummary(staleProfile as ProfileReport) };
          console.log(`${cam.name}: while relighting ${gpuMeasureSummary(g)}; texels written ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
        } catch (e) {
          problems.push(`${cam.name}: GPU measurement while relighting: ${String(e).slice(0, 200)}`);
        } finally {
          await game.frame.evaluate(() => clearInterval((window as unknown as { __tlRelightTick?: number }).__tlRelightTick));
          await meterSet(game, {});
          await storeLit(game, store);
        }
      }
      const c = s.counts ?? {};
      const shotProblemsFound = shotProblems({ settled: s.settledS !== null, chunks: c['chunks'] ?? 0, l0: c['l0'] ?? 0, farBricks: c['farBricks'] ?? 0, voxelShare, near: cam.near });
      for (const p of shotProblemsFound) problems.push(`${cam.name}: ${p}`);
      const report = profile === null ? null : (profile as ProfileReport);
      const counters = (await game.observe().catch(() => null))?.counters ?? {};
      const region = Object.fromEntries(['known', 'enclosed', 'volume', 'sky', 'portals', 'id'].map((k) => [k, counters[`region_${k}`] ?? 0]));
      (out['shots'] as unknown[]).push({
        region,
        spans: regionSpans(report),
        lightingSpans: lightingSpans(report),
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
        secondShare: Number(secondShare.toFixed(4)),
        problems: shotProblemsFound,
        profile: report === null ? null : profileSummary(report),
        memory: report?.counters.memory ?? null,
        sun,
        store,
        storeState: lit.state,
        storeLitS: lit.litS,
        sincePlayS,
        volumeCells,
        ...(O.textureUnits !== null ? { textureUnits: await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay: { light: { textureUnits(): unknown } } }).__tlVoxelPlay.light.textureUnits()) } : {}),
        ...(O.arrivalShots ? { arrival, arrivedToLitS: lit.litS === null ? null : Number(((Date.now() - arrived) / 1000).toFixed(1)) } : {}),
        ...(O.gpuStale ? { gpuStale } : {}),
        ...(O.gpu ? { gpu, afterGpuShare: afterGpuShare === null ? null : Number(afterGpuShare.toFixed(4)), afterGpuLaterShare: afterGpuLaterShare === null ? null : Number(afterGpuLaterShare.toFixed(4)) } : {}),
        at: host(),
      });
      console.log(`${cam.name}: lighting spans ${JSON.stringify(lightingSpans(report))}`);
      console.log(`${cam.name}: settled ${s.settledS ?? 'never'} s, ${JSON.stringify(s.counts)}, voxels change ${(voxelShare * 100).toFixed(1)} % of the picture${shotProblemsFound.length > 0 ? `; REFUSED: ${shotProblemsFound.join('; ')}` : ''}; profile ${JSON.stringify(report === null ? null : profileSummary(report).msPerFrame)}; sun field ${JSON.stringify(sun)}`);
    }
    if (O.edits > 0) {
      // Edit → screen: digs in front of the street camera, one at a time, each read from the page's edit record.
      await game.debug(LIGHTING_CAMERAS[0]!.command);
      await settle(game);
      const edits: unknown[] = [];
      for (const d of EDIT_DIGS.slice(0, O.edits)) {
        const n = (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.edits().length ?? 0)) as number;
        // Every frame from now for 6 s: its time, the edits drawn and the static shadow map's draws (edit → light).
        await game.frame.evaluate(() => {
          const w = window as unknown as { __tlVoxelPlay?: Hook; __tlEditWatch?: WatchFrame[] };
          const h = w.__tlVoxelPlay;
          const rec: WatchFrame[] = [];
          w.__tlEditWatch = rec;
          const t0 = performance.now();
          const tick = (): void => {
            rec.push([performance.now(), h?.edits().length ?? 0, h?.shadowDraws() ?? null]);
            if (performance.now() - t0 < 6000) requestAnimationFrame(tick);
          };
          tick();
        });
        await game.debug(d.command);
        let got: unknown = null;
        for (let i = 0; i < 80 && got === null; i++) {
          await page.waitForTimeout(250);
          const list = (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.edits() ?? [])) as unknown[];
          if (list.length > n) got = list[list.length - 1];
        }
        const watched = (await game.frame.evaluate(() => (window as unknown as { __tlEditWatch?: WatchFrame[] }).__tlEditWatch ?? [])) as WatchFrame[];
        const light = got === null ? { shadowMs: null, shadowFrames: null } : editShadowTiming(watched, (got as { visibleMs: number }).visibleMs);
        edits.push({ command: d.command, center: d.center, edit: got, ...light });
        if (got === null) problems.push(`${d.command}: no edit reached the screen in 20 s`);
        await page.waitForTimeout(1000);
      }
      const obs = await game.observe().catch(() => null);
      out['edits'] = { digs: edits, refused: obs?.counters?.['light_dig_refused'] ?? 0, issued: obs?.counters?.['light_digs'] ?? 0 };
      console.log(`edits: ${JSON.stringify(edits.map((e) => (e as { edit: { visibleMs?: number; frames?: number } | null }).edit === null ? null : { visibleMs: (e as { edit: { visibleMs: number } }).edit.visibleMs, frames: (e as { edit: { frames: number } }).edit.frames, shadowMs: (e as { shadowMs: number | null }).shadowMs, shadowFrames: (e as { shadowFrames: number | null }).shadowFrames }))}`);
    }
    if (O.cacheEdits) {
      // Edit → light in the lighting store: a window dug through the room camera's wall (its light changes), a wall
      // built between a lamp and the fronts at night (the lit texels behind it go dark), dug again (they come back).
      const room = LIGHTING_CAMERAS.find((c) => c.name === 'room-window')!;
      const night = LIGHTING_CAMERAS.find((c) => c.name === LAMP_WALL_COMMANDS.camera)!;
      const runs: Record<string, unknown>[] = [];
      for (const [cam, command, tag] of [[room, 'region_dig', 'window'], [night, LAMP_WALL_COMMANDS.build, 'lamp-wall'], [night, LAMP_WALL_COMMANDS.dig, 'lamp-unwall']] as const) {
        await game.debug(cam.command);
        await settle(game);
        await storeLit(game, (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: Hook }).__tlVoxelPlay?.light?.store() ?? 'off')) as string);
        await page.waitForTimeout(CONVERGE_MS);
        const before = decodePng(await game.screenshot(join(OUT, `edit-${tag}-before.png`)));
        await game.frame.evaluate(() => {
          const w = window as unknown as { __tlVoxelPlay?: Hook; __tlCacheWatch?: CacheWatchFrame[]; __tlCacheWatchOn?: boolean };
          const rec: CacheWatchFrame[] = [];
          w.__tlCacheWatch = rec;
          w.__tlCacheWatchOn = true;
          const tick = (): void => {
            const p = w.__tlVoxelPlay?.light?.progress() ?? null;
            if (p !== null) rec.push([performance.now(), p.texelsWritten, p.staleUnits, p.waiting, p.probesSettled ? 1 : 0, p.probesStale]);
            if (w.__tlCacheWatchOn === true) requestAnimationFrame(tick);
          };
          tick();
        });
        const t0 = (await game.frame.evaluate(() => performance.now())) as number;
        await game.debug(command);
        // Until the store has settled again after the change reached it (or 90 s).
        let timing = cacheEditTiming([], t0);
        // A picture as soon as the first changed light is seen (polled: up to a poll and a screenshot after it).
        let firstShotMs: number | null = null;
        for (let i = 0; i < 360; i++) {
          await page.waitForTimeout(firstShotMs === null ? 50 : 250);
          const frames = (await game.frame.evaluate(() => (window as unknown as { __tlCacheWatch?: CacheWatchFrame[] }).__tlCacheWatch ?? [])) as CacheWatchFrame[];
          timing = cacheEditTiming(frames, t0);
          if (firstShotMs === null && timing.firstLightMs !== null) {
            const at = (await game.frame.evaluate(() => performance.now())) as number;
            await game.screenshot(join(OUT, `edit-${tag}-first.png`));
            firstShotMs = Number((at - t0).toFixed(0));
          }
          if (timing.settledMs !== null) break;
        }
        await game.frame.evaluate(() => void ((window as unknown as { __tlCacheWatchOn?: boolean }).__tlCacheWatchOn = false));
        await page.waitForTimeout(CONVERGE_MS);
        const after = decodePng(await game.screenshot(join(OUT, `edit-${tag}-after.png`)));
        const counters = (await game.observe().catch(() => null))?.counters ?? {};
        runs.push({ tag, camera: cam.name, command, ...timing, firstShotMs, changedShare: Number(changedShare(before, after).toFixed(4)), counters: Object.fromEntries(['lamp_walls', 'lamp_unwalls', 'lamp_wall_refused', 'lamp_wall_nohit', 'region_dug', 'region_dig_refused'].map((k) => [k, counters[k] ?? 0])) });
        console.log(`cache edit ${tag}: ${JSON.stringify(runs[runs.length - 1])}`);
        if (timing.settledMs === null) problems.push(`cache edit ${tag}: the light did not settle within 90 s of the command`);
      }
      out['cacheEdits'] = runs;
    }
    // Open regions where the world runs (counts, bytes, derive µs), then a hole dug through the room camera's wall:
    // wall ms from the command until the room's region answer at its eye changes (polled every 50 ms), and the steps.
    out['regions'] = (await game.sim().catch(() => null))?.['regions'] ?? null;
    const room = LIGHTING_CAMERAS.find((c) => c.name === 'room-window')!;
    if (O.only.includes(room.name)) {
      await game.debug(room.command);
      await settle(game);
      const before = (await game.observe().catch(() => null))?.counters ?? {};
      const t0 = Date.now();
      await game.debug('region_dig');
      let ms: number | null = null;
      for (let i = 0; i < 400 && ms === null; i++) {
        await page.waitForTimeout(50);
        const c = (await game.observe().catch(() => null))?.counters ?? {};
        if ((c['region_edit_steps'] ?? 0) > 0) ms = Date.now() - t0;
      }
      const after = (await game.observe().catch(() => null))?.counters ?? {};
      out['regionEdit'] = { ms, steps: after['region_edit_steps'] ?? null, before: { enclosed: before['region_enclosed'], volume: before['region_volume'] }, after: { enclosed: after['region_enclosed'], volume: after['region_volume'], sky: after['region_sky'] }, refused: after['region_dig_refused'] ?? 0 };
      console.log(`regions: ${JSON.stringify(out['regions'])}; room wall dug → region changed ${JSON.stringify(out['regionEdit'])}`);
    }
    if (O.textureUnits === 'volume') {
      // The store switched at run time and back: the page's walk (its table and GPU buffers, in the voxelStream row of
      // the resident table) held while the volume reads it, released once nothing does.
      const walkNow = async (): Promise<unknown> => game.frame.evaluate((w) => {
        const h = (window as unknown as { __tlVoxelPlay: { walk: { stats(w: string): unknown } }; __tlProfiler?: { read(): { counters: { memory?: { rows: Array<{ id: string; resident: number }> } } } } });
        return { walk: h.__tlVoxelPlay.walk.stats(w), voxelStream: h.__tlProfiler?.read().counters.memory?.rows.find((r) => r.id === 'voxelStream')?.resident ?? null };
      }, O.world);
      const held = await walkNow();
      await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay: { light: { setStore(s: string): void } } }).__tlVoxelPlay.light.setStore('off'));
      await page.waitForTimeout(2000);
      out['walkRelease'] = { volume: held, off: await walkNow() };
      console.log(`walk: ${JSON.stringify(out['walkRelease'])}`);
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
