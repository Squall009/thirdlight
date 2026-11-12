/**
 * The travel measures' browser side (coverage-cli.ts), the same in Play in the editor and in an exported game: a
 * recorder installed in the game's page (every frame's time and the voxel draws' counts; the browser's long
 * animation frames with the scripts that ran in them; in an export, the play's observation every 50 ms), the probe
 * character added to the project for a run, and the recorded observations turned into the probe's readings.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { BodySample, FrameSample, LongFrame } from './travel';
import { PROBE_BODY, PROBE_COUNTERS, type BenchApi } from './flight-camera';

/** What the recorder kept (wall-clock ms, `Date.now()`, so the bench's own polls line up with it). */
export interface Recorded {
  readonly frames: FrameSample[];
  readonly long: LongFrame[];
  readonly obs: ObsSample[];
}

/** A reading of the play's observation: wall ms, its step, the probe's counters. */
export interface ObsSample {
  readonly w: number;
  readonly step: number;
  readonly c: Readonly<Record<string, number>>;
}

/** Long animation frames shorter than this are not kept (the measures look at frames over 100 ms; 50 ms shows what leads to them). */
export const LONG_FRAME_KEEP_MS = 50;

/**
 * Runs in the game's page: starts the recorder for `world` (`observe`: also poll the export's own observation).
 * Every animation frame reads the draws' stats (a small cost of its own: the chunk view's counts, ~1,000 chunks).
 */
export function installRecorder(a: { world: string; observe: boolean; keepMs: number }): boolean {
  type Fine = { built: number; pending: number; held: number; drawn: number[] };
  type Stats = { applied: number; replaced: number; waiting: number; worlds: Record<string, { chunks: number; levels: number[]; kitInstances: number; meshBuilds: number; far: { nodes: number; bricks: number; trims: number; fine?: Fine | null } }> };
  const g = globalThis as unknown as { __tlVoxelPlay?: { stats(): Stats }; __thirdlightObserve?: () => { stepIndex?: number; counters?: Record<string, number> } | null; __tlTravel?: unknown };
  const rec = { frames: [] as Array<{ t: number; counts: Record<string, number> }>, long: [] as unknown[], obs: [] as Array<{ w: number; step: number; c: Record<string, number> }>, on: true };
  g.__tlTravel = rec;
  const counts = (): Record<string, number> => {
    const s = g.__tlVoxelPlay?.stats();
    const w = s?.worlds[a.world];
    if (s === undefined || w === undefined) return {};
    const f = w.far.fine;
    // Fine far bricks' builds: started and waiting, far changes held for them, built, drawn by level.
    const fine: Record<string, number> = f == null ? {} : { fineBuilt: f.built, finePending: f.pending, fineHeld: f.held, fineL0: f.drawn[0] ?? 0, fineL1: f.drawn[1] ?? 0 };
    return { applied: s.applied, replaced: s.replaced, waiting: s.waiting, chunks: w.chunks, l0: w.levels[0] ?? 0, l1: w.levels[1] ?? 0, l2: w.levels[2] ?? 0, kits: w.kitInstances, meshBuilds: w.meshBuilds, farNodes: w.far.nodes, farBricks: w.far.bricks, farTrims: w.far.trims, ...fine };
  };
  const frame = (): void => {
    if (!rec.on) return;
    rec.frames.push({ t: Date.now(), counts: counts() });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // Page-clock times of the long frames, moved to wall-clock ms like the frames'.
  const toWall = Date.now() - performance.now();
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as Array<{ startTime: number; duration: number; renderStart: number; blockingDuration: number; scripts: Array<{ invoker: string; sourceFunctionName: string; duration: number }> }>) {
        if (!rec.on || e.duration < a.keepMs) continue;
        const scripts = [...e.scripts].sort((x, y) => y.duration - x.duration).slice(0, 4).map((s) => ({ invoker: String(s.invoker).slice(0, 80), fn: String(s.sourceFunctionName ?? '').slice(0, 40), ms: Math.round(s.duration) }));
        rec.long.push({ t: Math.round(e.startTime + toWall), ms: Math.round(e.duration), renderMs: e.renderStart > 0 ? Math.round(e.startTime + e.duration - e.renderStart) : 0, blockingMs: Math.round(e.blockingDuration ?? 0), scripts });
      }
    }).observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    // A browser without the Long Animation Frames timing: the gaps are still found, their causes are not.
  }
  if (a.observe) {
    const timer = setInterval(() => {
      if (!rec.on) {
        clearInterval(timer);
        return;
      }
      const o = g.__thirdlightObserve?.();
      if (o != null) rec.obs.push({ w: Date.now(), step: o.stepIndex ?? 0, c: Object.fromEntries(Object.entries(o.counters ?? {}).filter(([k]) => k.startsWith('probe_'))) });
    }, 50);
  }
  return true;
}

/** Runs in the game's page: stops the recorder and hands back what it kept. */
export function takeRecorded(): Recorded | null {
  const rec = (globalThis as unknown as { __tlTravel?: Recorded & { on: boolean } }).__tlTravel;
  if (rec === undefined) return null;
  rec.on = false;
  return { frames: rec.frames, long: rec.long, obs: rec.obs };
}

/** The probe character's object id in the project (null: none). */
export function probeBodyId(projectDir: string): string | null {
  const entities = JSON.parse(readFileSync(join(projectDir, 'scenes', 'scene-main.json'), 'utf8')).scene.entities as Array<{ id: string; name: string }>;
  return entities.find((e) => e.name === PROBE_BODY)?.id ?? null;
}

/**
 * Adds the probe character (a default capsule player controller) at `at` unless the project has it. It stands where
 * the camera starts so it adds no second place the world streams round before the flight.
 */
export async function addProbeBody(b: BenchApi, projectDir: string, at: readonly [number, number, number]): Promise<string> {
  const had = probeBodyId(projectDir);
  if (had !== null) {
    await b.command('setTransform', { entityId: had, transform: { position: [...at] } });
    return had;
  }
  await b.command('createEntity', { sceneId: 'scene-main', kind: 'group', name: PROBE_BODY, transform: { position: [...at] }, components: { controller: {} } });
  const id = probeBodyId(projectDir);
  if (id === null) throw new Error('the probe character was not created');
  return id;
}

/** Takes the probe character out of the project again (the other benches run without it). */
export async function removeProbeBody(b: BenchApi, projectDir: string): Promise<void> {
  const id = probeBodyId(projectDir);
  if (id !== null) await b.command('deleteEntity', { entityId: id });
}

/** The step rate the flight behaviour moves at (its source assumes it). */
export const FLIGHT_STEP_HZ = 120;

/** When the flight stopped (wall ms): from the first reading that names the stop step, back by the steps since. Null: not in the record. */
export function stopWall(obs: readonly ObsSample[]): number | null {
  const s = obs.find((o) => (o.c[PROBE_COUNTERS.stopStep] ?? 0) > 0);
  if (s === undefined) return null;
  return s.w - ((s.step - s.c[PROBE_COUNTERS.stopStep]!) * 1000) / FLIGHT_STEP_HZ;
}

/** The probe body's readings (seconds since `t0Wall`). */
export function bodySamples(obs: readonly ObsSample[], t0Wall: number): BodySample[] {
  const C = PROBE_COUNTERS;
  return obs
    .filter((o) => (o.c[C.drop] ?? 0) > 0)
    .map((o) => ({
      t: (o.w - t0Wall) / 1000,
      drop: o.c[C.drop]!,
      groundY: (o.c[C.dropGround] ?? 0) / 100,
      y: (o.c[C.bodyY] ?? 0) / 100,
      grounded: o.c[C.grounded] === 1,
      suspended: o.c[C.suspended] === 1,
      onFloor: o.c[C.onFloor] === 1,
      ...(o.c[C.bodyX] !== undefined ? { at: { x: o.c[C.bodyX]! / 100, z: (o.c[C.bodyZ] ?? 0) / 100, belowY: (o.c[C.belowY] ?? 0) / 100, belowKind: o.c[C.belowKind] ?? 0, aboveY: (o.c[C.aboveY] ?? 0) / 100, aboveKind: o.c[C.aboveKind] ?? 0 } } : {}),
    }));
}

/** The ray probe's steps in flight and the seconds (simulation steps) from the stop to the first solid ray and to the body standing. */
export function rayAndBody(last: ObsSample | undefined): { raySteps: number; solidShare: number | null; noneShare: number | null; deepShare: number | null; raySolidAfterStopS: number | null; bodyStandsAfterStopS: number | null; drops: number } {
  const C = PROBE_COUNTERS;
  const c = last?.c ?? {};
  const n = c[C.raySteps] ?? 0;
  const share = (k: string): number | null => (n === 0 ? null : Math.round(((c[k] ?? 0) / n) * 1000) / 1000);
  const stop = c[C.stopStep] ?? 0;
  const after = (k: string): number | null => (stop > 0 && (c[k] ?? 0) > 0 ? Math.round(((c[k]! - stop) / FLIGHT_STEP_HZ) * 100) / 100 : null);
  return { raySteps: n, solidShare: share(C.raySolid), noneShare: share(C.rayNone), deepShare: share(C.rayDeep), raySolidAfterStopS: after(C.rayReadyStep), bodyStandsAfterStopS: after(C.bodyReadyStep), drops: c[C.drop] ?? 0 };
}

/** Runs a debug command in an exported game through its debug console (the export is made with `debug_console` on). */
export async function exportDebug(page: Page, name: string): Promise<void> {
  await page.locator('canvas#game').click();
  await page.keyboard.press('Backquote');
  const input = page.getByLabel('debug console command');
  await input.fill(name);
  await input.press('Enter');
  await page.locator('.tl-console').filter({ hasText: `ran ${name}` }).last().waitFor({ timeout: 10_000 });
  await page.keyboard.press('Backquote');
}
