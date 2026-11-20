/**
 * The path bench's Play part (paths-cli.ts `--play`, staging running): Play on the 8 km world, the project's
 * "Perf far camera" given the bench's script (its own behaviour is given back after). The script stands the camera at
 * the street camera (or the cave camera on `paths-at-cave`); on `paths-run` it asks the fixed queries standing there
 * through `ctx.voxels.findPath`, on `paths-100` a hundred street queries at once; each answer comes back as counters
 * (status, length in cm, points, places searched, steps served, µs). The frame profile gives the simulation's
 * `path finding` span (the `pathfinding` category) and `walk graph stitched` a step, against the budget table.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProfileReport } from '@thirdlight/game-host';
import { FRAME_BUDGET_BY_TIER, frameBudgetMs, type LightingTier } from '@thirdlight/project-model';

import { launchGpuBrowser } from '../perf/frame-run';
import { benchApi, cameraBehaviour, publishCameraBehaviour } from './flight-camera';
import { LIGHTING_CAMERAS } from './lighting-cameras';
import type { PathQuery } from './path-queries';
import { openPlay } from './travel-page';

const BEHAVIOR = 'paths-bench-camera';
const STATUS = ['found', 'partial', 'unreachable', 'unknown'] as const;

/** The bench's camera script: the camera at a place; the queries asked on commands, their answers as counters. */
function benchSource(queries: readonly PathQuery[]): string {
  const street = LIGHTING_CAMERAS.find((c) => c.name === 'street-noon')!;
  const cave = LIGHTING_CAMERAS.find((c) => c.name === 'cave')!;
  const town = queries.filter((q) => q.town).flatMap((q) => [q.from, q.to]);
  return `
const AT: any = { street: { eye: ${JSON.stringify(street.eye)}, yaw: ${street.yaw}, pitch: ${street.pitch} }, cave: { eye: ${JSON.stringify(cave.eye)}, yaw: ${cave.yaw}, pitch: ${cave.pitch} } };
const QS: any[] = ${JSON.stringify(queries.map((q) => ({ from: q.from, to: q.to, at: q.at })))};
const TOWN: any[] = ${JSON.stringify(town)};
const STATUS = ${JSON.stringify(STATUS)};
const quat = (yaw: number, pitch: number) => { const cy = Math.cos(yaw / 2), sy = Math.sin(yaw / 2), cp = Math.cos(-pitch / 2), sp = Math.sin(-pitch / 2); return [cy * sp, sy * cp, -sy * sp, cy * cp]; };
export default {
  prepare() { return {}; },
  instantiate() { return { at: 'street', asked: {}, hundred: {} }; },
  step(s: any, ctx: any) {
    if (ctx.phase === 'intent') {
      const v = ctx.voxels;
      const put = (n: string, x: number) => ctx.game.add(n, x - ctx.game.counter(n));
      for (const _ of ctx.debug.command('paths-at-cave')) s.at = 'cave';
      for (const _ of ctx.debug.command('paths-at-street')) s.at = 'street';
      for (const _ of ctx.debug.command('paths-run')) QS.forEach((q: any, k: number) => { if (q.at === s.at) s.asked[v.findPath(q.from, q.to)] = k; });
      for (const _ of ctx.debug.command('paths-100')) for (let k = 0; k < 100; k++) s.hundred[v.findPath(TOWN[k % TOWN.length], TOWN[(k * 7 + 3) % TOWN.length])] = k;
      for (const a of v.paths) {
        const k = s.asked[a.path];
        if (k !== undefined) {
          put('q' + k + '_status', STATUS.indexOf(a.status) + 1); put('q' + k + '_cm', Math.round(a.length * 100)); put('q' + k + '_points', a.points.length);
          put('q' + k + '_searched', a.searched); put('q' + k + '_steps', a.steps); put('q' + k + '_us', Math.round(a.ms * 1000));
          ctx.game.add('answered', 1);
        }
        if (s.hundred[a.path] !== undefined) {
          ctx.game.add('h_done', 1); ctx.game.add('h_' + a.status, 1);
          if (a.steps > ctx.game.counter('h_steps_max')) put('h_steps_max', a.steps);
          ctx.game.add('h_steps_sum', a.steps);
        }
      }
      return;
    }
    if (ctx.phase !== 'transform') return;
    const at = AT[s.at];
    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: at.eye[0], y: at.eye[1], z: at.eye[2] }, quaternion: quat(at.yaw, at.pitch) });
  },
  dispose() {},
};
`;
}

/** Ms a simulation frame of the named spans, and the most in one frame, over a profile's frames. */
function spansMs(p: ProfileReport, names: readonly string[]): Record<string, { perFrame: number; max: number; frames: number; framesWith: number }> {
  const out: Record<string, { perFrame: number; max: number; frames: number; framesWith: number }> = {};
  for (const name of names) {
    let sum = 0;
    let max = 0;
    let withIt = 0;
    for (const f of p.threads.sim) {
      const ms = f.spans.filter((s) => s.name === name).reduce((n, s) => n + s.ms, 0);
      sum += ms;
      max = Math.max(max, ms);
      if (ms > 0) withIt++;
    }
    out[name] = { perFrame: Number((sum / Math.max(1, p.threads.sim.length)).toFixed(3)), max: Number(max.toFixed(2)), frames: p.threads.sim.length, framesWith: withIt };
  }
  return out;
}

export async function pathsPlay(opt: (name: string, d: string) => string, queries: readonly PathQuery[]): Promise<Record<string, unknown>> {
  const DATA_ROOT = join(homedir(), 'thirdlight-staging-p45');
  const project = opt('project', 'voxel-slice');
  const world = opt('world', 'far');
  const quality = opt('quality', 'low');
  const [vw, vh] = opt('viewport', '1280x720').split('x').map(Number);
  const viewport = { width: vw!, height: vh! };
  const PROJECT_DIR = join(DATA_ROOT, 'projects', project);
  const token = readFileSync(opt('token-file', join(DATA_ROOT, 'owner-token')), 'utf8').trim();
  const b = benchApi({ origin: opt('origin', 'http://127.0.0.1:4180'), token, project, clientId: 'voxel-bench-paths' });
  const before = cameraBehaviour(PROJECT_DIR);
  await publishCameraBehaviour(b, PROJECT_DIR, BEHAVIOR, benchSource(queries));
  const tier = (quality === 'medium' || quality === 'high' ? quality : 'low') as LightingTier;
  const out: Record<string, unknown> = { quality, viewport, budgetMs: Number(frameBudgetMs(FRAME_BUDGET_BY_TIER[tier], 'sim', 'pathfinding').toFixed(2)) };
  const SPANS = ['path finding', 'walk graph stitched', 'open regions stitched', 'voxel streaming'];
  const browser = await launchGpuBrowser({ vsync: true });
  try {
    const page = await (await browser.newContext({ viewport, deviceScaleFactor: 1 })).newPage();
    const game = await openPlay(b, page, { viewport, query: '', quality, world });
    const profile = async (): Promise<ProfileReport> => (await game.frame.evaluate(() => (window as unknown as { __tlProfiler: { read(): unknown } }).__tlProfiler.read())) as ProfileReport;
    const counters = async (): Promise<Record<string, number>> => (await game.observe())?.counters ?? {};
    /** Streaming still: the world's chunk count and its walk graph the same for 6 s. */
    const settle = async (): Promise<Record<string, unknown> | null> => {
      let last = '';
      let sim: Record<string, unknown> | null = null;
      for (let i = 0, still = 0; i < 240 && still < 12; i++) {
        await page.waitForTimeout(500);
        sim = await game.sim();
        const now = JSON.stringify([sim?.['resident'], (sim?.['walk'] as { chunks?: number } | undefined)?.chunks]);
        still = now === last ? still + 1 : 0;
        last = now;
      }
      return sim;
    };
    const t0 = Date.now();
    const loaded = await profile();
    let sim = await settle();
    out['arrival'] = { seconds: (Date.now() - t0) / 1000, walk: sim?.['walk'] ?? null, spans: spansMs(loaded, SPANS) };
    const ask = async (at: 'street' | 'cave'): Promise<Record<string, unknown>[]> => {
      const want = queries.map((q, k) => [q, k] as const).filter(([q]) => q.at === at);
      const c0 = (await counters())['answered'] ?? 0;
      await profile();
      await game.debug('paths-run');
      for (let i = 0; i < 240 && ((await counters())['answered'] ?? 0) < c0 + want.length; i++) await page.waitForTimeout(250);
      const p = await profile();
      const c = await counters();
      return want.map(([q, k]) => ({ name: q.name, status: STATUS[(c[`q${k}_status`] ?? 0) - 1] ?? null, lengthM: (c[`q${k}_cm`] ?? 0) / 100, points: c[`q${k}_points`] ?? 0, searched: c[`q${k}_searched`] ?? 0, steps: c[`q${k}_steps`] ?? 0, ms: (c[`q${k}_us`] ?? 0) / 1000, spans: spansMs(p, SPANS) }));
    };
    out['street'] = await ask('street');
    console.log(`play street: ${JSON.stringify(out['street'])}`);
    // A hundred at once.
    await profile();
    await game.debug('paths-100');
    for (let i = 0; i < 480 && ((await counters())['h_done'] ?? 0) < 100; i++) await page.waitForTimeout(250);
    const hp = await profile();
    const hc = await counters();
    out['hundred'] = { done: hc['h_done'] ?? 0, found: hc['h_found'] ?? 0, unknown: hc['h_unknown'] ?? 0, unreachable: hc['h_unreachable'] ?? 0, stepsMax: hc['h_steps_max'] ?? 0, stepsMean: (hc['h_steps_sum'] ?? 0) / Math.max(1, hc['h_done'] ?? 0), spans: spansMs(hp, SPANS) };
    console.log(`play hundred: ${JSON.stringify(out['hundred'])}`);
    // The cave: the camera moved there, streaming settled again.
    await game.debug('paths-at-cave');
    sim = await settle();
    out['cave'] = { walk: sim?.['walk'] ?? null, answers: await ask('cave') };
    console.log(`play cave: ${JSON.stringify(out['cave'])}`);
    await game.stop();
  } finally {
    await browser.close().catch(() => undefined);
    const cam = (JSON.parse(readFileSync(join(PROJECT_DIR, 'scenes', 'scene-main.json'), 'utf8')).scene.entities as Array<{ id: string; name: string }>).find((e) => e.name === 'Perf far camera');
    if (before !== null && before !== BEHAVIOR && cam !== undefined) await b.command('setBehaviorProperties', { entityId: cam.id, behaviorId: before, values: {} }).catch(() => undefined);
  }
  return out;
}
