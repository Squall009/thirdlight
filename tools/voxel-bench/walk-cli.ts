/**
 * Rays a millisecond of the occupancy walk (`node tools/voxel-bench/run.mjs walk …`).
 *
 * - **CPU, in Node** (always): the town (town.ts, the town at the 8 km world's centre) derived in this process
 *   over a box of chunks round its middle (walk-world.ts, far nodes of 2 m cells over it), the bench's three ray
 *   kinds (`@thirdlight/voxel` walk-bench.ts: short 8 m, medium 64 m, long 2 km toward the horizon, from points
 *   round an eye in a street), each walked with and without skipping empty blocks and bricks, timed over repeats of
 *   the whole batch (at least `--min-ms` each): rays a millisecond, hits, steps a ray.
 * - **In the browser** (`--play`, staging running): Play on the 8 km world at `--quality` (WebGPU, the viewport's
 *   size, the level's cap), the project's "Perf far camera" standing at the street camera (lighting-cameras.ts).
 *   The simulation worker: a script walks `--sim-rays` rays of a kind every step (`ctx.voxels.raycast`, from points
 *   round the camera), for `--sim-s` seconds a kind; the frame profile's `scripts` ms a simulation frame against
 *   the same seconds without rays gives its ms a ray. The GPU: the page's walk checked against its CPU walk over the
 *   same blocks (`__tlVoxelPlay.walk.check`, every kind, `--check` rays each), then each kind's bench pass walking
 *   `--gpu-rays` rays every frame read by the page's GPU measurement (`lighting` only, game-host gpu-measure.ts):
 *   ms a frame for that batch, so rays a millisecond.
 *
 *   --play  --origin URL  --token-file FILE  --project ID (voxel-slice)  --world NAME (far)  --quality (low)
 *   --viewport WxH (1280x720)  --sim-rays N (200)  --sim-s S (6)  --check N (400)  --gpu-rays N (8192)
 *   --kinds LIST (short,medium,long)  --min-ms MS (300)  --out FILE (~/.cache/thirdlight-voxel-bench/walk/<time>.json)
 *
 * How to (alone on the machine; staging running for `--play`):
 *
 *   sudo -n systemd-run --scope --quiet -p MemoryMax=10G -p MemorySwapMax=0 -- sudo -n -u $USER -- \
 *     env HOME=$HOME PATH=$PATH TMPDIR=$HOME/.cache/tmp/walk node tools/voxel-bench/run.mjs walk --play
 *
 * Not part of `npm test`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, loadavg, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { walkBenchRays, walkRay, walkVoxels, WALK_BENCH_KINDS, type WalkBenchKind } from '@thirdlight/voxel';
import type { ProfileReport } from '@thirdlight/game-host';
import { launchGpuBrowser } from '../perf/frame-run';
import { gpuMeasureOnPage, gpuMeasureSummary, measureGpuOnPage } from '../perf/gpu-measure-page';
import { benchDir } from './bench-dirs';
import { benchApi, cameraBehaviour, publishCameraBehaviour } from './flight-camera';
import { LIGHTING_CAMERAS } from './lighting-cameras';
import { openPlay } from './travel-page';
import { walkWorld } from './walk-world';
import { townWorld } from './worlds';

const args = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1]! : d;
};
const KINDS = opt('kinds', 'short,medium,long').split(',').filter((k): k is WalkBenchKind => k in WALK_BENCH_KINDS);
const MIN_MS = Number(opt('min-ms', '300'));
const OUT = opt('out', join(benchDir('walk'), `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`));
const host = () => ({ at: new Date().toISOString(), uptimeDays: Number((uptime() / 86400).toFixed(2)), load: loadavg().map((x) => Number(x.toFixed(2))) });
/** The street camera: where the browser's rays start (the 8 km world's metres). */
const STREET = LIGHTING_CAMERAS[0]!;
/** The bench's script on the camera object. */
const BEHAVIOR = 'walk-bench-camera';

/** Rays a millisecond over repeats of the whole batch, at least `MIN_MS` of walking. */
function timeBatch(walk: () => { hits: number; steps: number }, n: number): { raysPerMs: number; hits: number; stepsPerRay: number; repeats: number } {
  let r = walk();
  let ms = 0;
  let repeats = 0;
  while (ms < MIN_MS) {
    const t0 = performance.now();
    r = walk();
    ms += performance.now() - t0;
    repeats++;
  }
  return { raysPerMs: Number(((n * repeats) / ms).toFixed(1)), hits: r.hits, stepsPerRay: Number((r.steps / n).toFixed(1)), repeats };
}

function nodePart(): unknown {
  const t0 = performance.now();
  // The town's 16 × 16 chunks moved so its middle is the origin; level 0 over 12 × 12 of them (192 m), far nodes over them.
  const world = walkWorld(townWorld({ footprint: 512 }), [-6, -1, -6], [5, 2, 5], [8, 0, 8], 2);
  const src = world.source({ far: true });
  const buildS = (performance.now() - t0) / 1000;
  // An eye 1.7 m over the ground of a street near the middle.
  const down = walkVoxels(src, walkRay([2, 20, -3], [0, -1, 0])!, 40).hit!;
  const eye: [number, number, number] = [2, 20 - down.t + 1.7, -3];
  const rows: unknown[] = [];
  for (const kind of KINDS) {
    const rays = walkBenchRays(kind, 2000, eye);
    for (const skip of [true, false]) {
      const run = (): { hits: number; steps: number } => {
        let hits = 0;
        let steps = 0;
        for (const r of rays) {
          const w = walkVoxels(src, r.ray, r.maxT, { stop: r.stop, skip });
          if (w.hit !== null) hits++;
          steps += w.steps;
        }
        return { hits, steps };
      };
      const t = timeBatch(run, rays.length);
      rows.push({ kind, skip, rays: rays.length, ...t });
      console.log(`node ${kind} ${skip ? 'skipping' : 'cell by cell'}: ${t.raysPerMs} rays/ms, ${t.hits}/${rays.length} hit, ${t.stepsPerRay} steps a ray`);
    }
  }
  return { world: 'town (town.ts), level 0 over 192 m, far nodes of 2 m cells', eye, buildS: Number(buildS.toFixed(1)), rows };
}

/** The bench's camera script: the street camera's place; on `walk-<kind>` it walks `n` rays of that kind every step, `walk-off` stops. */
function benchSource(n: number): string {
  const kinds = Object.fromEntries(KINDS.map((k) => [k, WALK_BENCH_KINDS[k]]));
  return `
const EYE = ${JSON.stringify(STREET.eye)};
const KINDS: any = ${JSON.stringify(kinds)};
const N = ${n};
const quat = (yaw: number, pitch: number) => { const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };
export default {
  prepare() { return {}; },
  instantiate() { return { kind: null, seed: 1 }; },
  step(s: any, ctx: any) {
    if (ctx.phase === 'intent') {
      for (const k of Object.keys(KINDS)) for (const _ of ctx.debug.command('walk-' + k)) s.kind = k;
      for (const _ of ctx.debug.command('walk-off')) s.kind = null;
      if (s.kind === null || ctx.voxels === undefined) return;
      const k = KINDS[s.kind];
      let hits = 0;
      for (let i = 0; i < N; i++) {
        s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
        const r = (): number => { s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0; return s.seed / 4294967296; };
        const o = [EYE[0] + (r() * 2 - 1) * 2, EYE[1] + (r() - 0.5) * 2, EYE[2] + (r() * 2 - 1) * 2];
        const yaw = r() * 2 * Math.PI;
        const up = k.elevation === undefined ? r() * 2 - 1 : Math.sin(((k.elevation[0] + r() * (k.elevation[1] - k.elevation[0])) * Math.PI) / 180);
        const c = Math.sqrt(1 - up * up);
        if (ctx.voxels.raycast(o, [c * Math.cos(yaw), up, c * Math.sin(yaw)], k.maxT, { stop: 'light' }) !== null) hits++;
      }
      ctx.game.add('walk_rays', N);
      ctx.game.add('walk_hits', hits);
      return;
    }
    if (ctx.phase !== 'transform') return;
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: EYE[0], y: EYE[1], z: EYE[2] }, quaternion: quat(${STREET.yaw}, ${STREET.pitch}) });
  },
  dispose() {},
};
`;
}

/** The simulation frames' `scripts` ms a frame in a profile, and the frames it covers. */
function scriptsMs(p: ProfileReport): { msPerFrame: number; frames: number; seconds: number } {
  const frames = p.threads.sim;
  let ms = 0;
  for (const f of frames) ms += f.byCategory.scripts ?? 0;
  const seconds = frames.length < 2 ? 0 : (frames.at(-1)!.start + frames.at(-1)!.ms - frames[0]!.start) / 1000;
  return { msPerFrame: ms / Math.max(1, frames.length), frames: frames.length, seconds };
}

async function playPart(): Promise<unknown> {
  const DATA_ROOT = join(homedir(), 'thirdlight-staging-p45');
  const project = opt('project', 'voxel-slice');
  const world = opt('world', 'far');
  const quality = opt('quality', 'low');
  const [vw, vh] = opt('viewport', '1280x720').split('x').map(Number);
  const viewport = { width: vw!, height: vh! };
  const simRays = Number(opt('sim-rays', '200'));
  const simS = Number(opt('sim-s', '6'));
  const PROJECT_DIR = join(DATA_ROOT, 'projects', project);
  const token = readFileSync(opt('token-file', join(DATA_ROOT, 'owner-token')), 'utf8').trim();
  const b = benchApi({ origin: opt('origin', 'http://127.0.0.1:4180'), token, project, clientId: 'voxel-bench-walk' });
  const before = cameraBehaviour(PROJECT_DIR);
  await publishCameraBehaviour(b, PROJECT_DIR, BEHAVIOR, benchSource(simRays));
  const out: Record<string, unknown> = { quality, viewport, eye: STREET.eye, simRays, simS };
  const browser = await launchGpuBrowser({ vsync: true });
  try {
    const page = await (await browser.newContext({ viewport, deviceScaleFactor: 1 })).newPage();
    const game = await openPlay(b, page, { viewport, query: '', quality, world });
    for (let i = 0; i < 240 && (await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay?: unknown }).__tlVoxelPlay !== undefined)) === false; i++) await page.waitForTimeout(250);
    // The batches carry walk blocks only while something on the page reads the GPU walk: this bench does.
    await game.frame.evaluate(() => (window as unknown as { __tlVoxelPlay: { walk: { read(on: boolean): void } } }).__tlVoxelPlay.walk.read(true));
    // Streaming settles first (the near and far counts and the walk's blocks still for a few seconds).
    let last = '';
    for (let i = 0, still = 0; i < 240 && still < 12; i++) {
      await page.waitForTimeout(500);
      const now = JSON.stringify(await game.frame.evaluate((w) => { const h = (window as unknown as { __tlVoxelPlay: { stats(): { worlds: Record<string, { chunks: number; far: { nodes: number } }> }; walk: { stats(w: string): unknown } } }).__tlVoxelPlay; const s = h.stats().worlds[w]; return [s?.chunks, s?.far.nodes, h.walk.stats(w)]; }, world));
      still = now === last ? still + 1 : 0;
      last = now;
    }
    out['walkBlocks'] = JSON.parse(last);
    const profile = async (): Promise<ProfileReport> => (await game.frame.evaluate(() => (window as unknown as { __tlProfiler: { read(): unknown } }).__tlProfiler.read())) as ProfileReport;
    // The simulation worker: scripts ms a frame with no rays, then with each kind's rays.
    const sim: Record<string, unknown> = {};
    await game.debug('walk-off');
    await page.waitForTimeout(simS * 1000);
    const base = scriptsMs(await profile());
    sim['none'] = base;
    for (const kind of KINDS) {
      const o0 = await game.observe();
      const t0 = Date.now();
      await game.debug(`walk-${kind}`);
      await page.waitForTimeout(simS * 1000);
      const p = scriptsMs(await profile());
      const o1 = await game.observe();
      await game.debug('walk-off');
      const rays = (o1?.counters?.['walk_rays'] ?? 0) - (o0?.counters?.['walk_rays'] ?? 0);
      const hits = (o1?.counters?.['walk_hits'] ?? 0) - (o0?.counters?.['walk_hits'] ?? 0);
      const raysPerS = rays / ((Date.now() - t0) / 1000);
      const raysPerFrame = (raysPerS * p.seconds) / Math.max(1, p.frames);
      const msPerRay = (p.msPerFrame - base.msPerFrame) / Math.max(1, raysPerFrame);
      sim[kind] = { ...p, rays, hits, raysPerFrame: Number(raysPerFrame.toFixed(1)), raysPerMs: Number((1 / msPerRay).toFixed(1)) };
      console.log(`simulation worker ${kind}: ${raysPerFrame.toFixed(0)} rays a frame, scripts ${p.msPerFrame.toFixed(2)} ms a frame (${base.msPerFrame.toFixed(2)} without), ${(1 / msPerRay).toFixed(1)} rays/ms, ${hits}/${rays} hit`);
      await page.waitForTimeout(1000);
    }
    out['sim'] = sim;
    // The GPU's walk against the CPU's over the same blocks.
    const check = await game.frame.evaluate(({ w, kinds, n, eye }) => (window as unknown as { __tlVoxelPlay: { walk: { check(w: string, k: string[], n: number, e: number[]): Promise<unknown> } } }).__tlVoxelPlay.walk.check(w, kinds, n, eye), { w: world, kinds: KINDS as string[], n: Number(opt('check', '400')), eye: [...STREET.eye] });
    out['check'] = check;
    console.log(`GPU = CPU: ${JSON.stringify(check).slice(0, 600)}`);
    // Each kind's bench pass under the page's GPU measurement.
    const gpuRays = Number(opt('gpu-rays', '8192'));
    const gpu: Record<string, unknown> = {};
    for (const kind of KINDS) {
      const n = (await game.frame.evaluate(({ w, k, n, eye }) => (window as unknown as { __tlVoxelPlay: { walk: { bench(w: string, k: string, n: number, e: number[]): number } } }).__tlVoxelPlay.walk.bench(w, k, n, eye), { w: world, k: kind, n: gpuRays, eye: [...STREET.eye] })) as number;
      await page.waitForTimeout(1000);
      const g = await measureGpuOnPage((call, options) => game.frame.evaluate(gpuMeasureOnPage, { call, ...(options !== undefined ? { options } : {}) }), (ms) => page.waitForTimeout(ms), { only: ['lighting'] });
      await game.frame.evaluate((w) => (window as unknown as { __tlVoxelPlay: { walk: { bench(w: string, k: null, n: number, e: number[]): number } } }).__tlVoxelPlay.walk.bench(w, null, 0, [0, 0, 0]), world);
      const lighting = g.categories.find((c) => c.category === 'lighting');
      gpu[kind] = { rays: n, ms: lighting?.ms ?? null, medianMs: lighting?.medianMs ?? null, spreadMs: lighting?.spreadMs ?? null, raysPerMs: lighting?.ms != null ? Number((n / lighting.ms).toFixed(0)) : null, resolutionMs: g.resolutionMs, frameMs: g.frameMs, seconds: g.seconds };
      console.log(`GPU ${kind}: ${n} rays a frame\n${gpuMeasureSummary(g)}`);
    }
    out['gpu'] = gpu;
    await game.stop();
  } finally {
    await browser.close().catch(() => undefined);
    const cam = (JSON.parse(readFileSync(join(PROJECT_DIR, 'scenes', 'scene-main.json'), 'utf8')).scene.entities as Array<{ id: string; name: string }>).find((e) => e.name === 'Perf far camera');
    if (before !== null && before !== BEHAVIOR && cam !== undefined) await b.command('setBehaviorProperties', { entityId: cam.id, behaviorId: before, values: {} }).catch(() => undefined);
  }
  return out;
}

const result: Record<string, unknown> = { bench: 'walk', start: host(), node: nodePart() };
if (args.includes('--play')) {
  try {
    result['play'] = await playPart();
  } catch (e) {
    result['error'] = String(e).slice(0, 600);
    console.error(result['error']);
  }
}
result['end'] = host();
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(result, null, 1)}\n`);
console.log(`walk: ${OUT}`);
process.exit(result['error'] === undefined ? 0 : 1);
