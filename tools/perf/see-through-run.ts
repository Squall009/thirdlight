/**
 * See-through's cost on a measured export (`--see-through N` on `village` and
 * `level`): N objects in the camera's view are named the subjects by a script
 * (`ctx.camera.setSeeThrough({subjects})`, see-through left as the project
 * says: off), so the class's own run is see-through off, and the run again
 * with `?seethrough=on` is the same view with it on from the first frame (the
 * renderer armed before its programs are built). Then the switch: a fresh
 * page, settled with it off, the script turns it on at a key press (`jump`,
 * Space) and the frames round that moment are read: the longest, the missed
 * refreshes, when the renderer was armed and the next frame was drawn, and
 * the programs the page made by then and later (none should be made once it
 * settled). The project measured has see-through's setting off (the
 * mask not built at load: the switch rebuilds every program, the picture
 * held meanwhile); it is exported again with the setting on
 * (`exportPrebuilt`), where the script turns it off at its first step: that
 * page's idle cost and its switch, which rebuilds nothing.
 *
 * Measure it at the display's rate (`--vsync`): see-through's added GPU time
 * comes from three's timestamps (WebGPU), the frames from a capped page as a
 * player's browser draws it.
 */
import { join } from 'node:path';

import type { Browser } from '@playwright/test';

import { installFrameProbe } from './frame-probe';
import { FRAME_VIEWPORT, LONG_FRAME_MS, uncappedUrl, type FrameRenderer, type FrameRunResult } from './frame-run';
import type { BehaviorPlan, EntityValue } from './generate';
import { installPerfInstrumentation } from './instrument';
import { summarize } from './stats';
import { publishBehaviorVia } from './build';
import type { PerfBackend } from './backend';

/** The page query that turns see-through on over the project's setting (three-adapter `SEE_THROUGH_URL_PARAM`). */
export const SEE_THROUGH_ON = 'seethrough=on';

/** A place in the plan an object stands (world), by its name (pasted objects get new ids). */
export interface SubjectCandidate {
  name: string;
  position: readonly [number, number, number];
}

/**
 * The `n` candidates nearest the camera's line of sight (by the angle off it), in front of the camera and
 * within `maxDistance` metres: what a view would fade round.
 */
export function subjectsInView(candidates: readonly SubjectCandidate[], camera: { position: readonly number[]; rotation: readonly number[] }, n: number, maxDistance = 40): string[] {
  const [qx, qy, qz, qw] = camera.rotation as [number, number, number, number];
  // three's −z turned by the camera's rotation.
  const f = [-2 * (qx * qz + qw * qy), -2 * (qy * qz - qw * qx), -(1 - 2 * (qx * qx + qy * qy))];
  const p = camera.position;
  const scored: { name: string; off: number }[] = [];
  for (const c of candidates) {
    const v = [c.position[0] - p[0]!, c.position[1] - p[1]!, c.position[2] - p[2]!];
    const along = v[0]! * f[0]! + v[1]! * f[1]! + v[2]! * f[2]!;
    if (along <= 1 || along > maxDistance) continue;
    const side = Math.hypot(v[0]! - along * f[0]!, v[1]! - along * f[1]!, v[2]! - along * f[2]!);
    scored.push({ name: c.name, off: side / along });
  }
  return scored
    .sort((a, b) => a.off - b.off || a.name.localeCompare(b.name))
    .slice(0, n)
    .map((s) => s.name);
}

/**
 * The subjects' script: names them on its first step (with `maxFade` over the project's when given: 0 runs the
 * mask with nothing thinned, its own cost apart from what the circles reveal behind), and turns see-through on
 * and off at each `jump` press.
 */
export function seeThroughBehavior(subjects: readonly string[], maxFade?: number): BehaviorPlan {
  return {
    behaviorId: 'perf-see-through',
    displayName: 'See-through subjects',
    ownedTransforms: [],
    declaration: { properties: [] },
    source: [
      'export default {',
      '  instantiate() { return { named: false, on: false }; },',
      '  step(state: any, ctx: any) {',
      "    if (ctx.phase !== 'intent') return;",
      '    if (!state.named) {',
      '      state.named = true;',
      // Off at the start whatever the project says: a project with the setting on builds the mask at load and waits.
      `      ctx.camera.setSeeThrough({ enabled: false, subjects: ${JSON.stringify(subjects)}${maxFade !== undefined ? `, maxFade: ${maxFade}` : ''} });`,
      '    }',
      "    if (ctx.input.pressed('jump')) {",
      '      state.on = !state.on;',
      '      ctx.camera.setSeeThrough({ enabled: state.on });',
      '    }',
      '  },',
      '};',
    ].join('\n'),
  };
}

/** Name the objects called `names` the view's subjects (a script on an object of its own); returns their ids. */
export async function addSeeThroughSubjects(be: PerfBackend, projectId: string, names: readonly string[], maxFade?: number): Promise<string[]> {
  const p = be.project(projectId);
  const cmd = (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => p.command(op, args);
  const ids: string[] = [];
  const byName = new Map<string, string>();
  for (let offset = 0; ; offset += 1000) {
    const page = (await p.query('queryEntities', { limit: 1000, offset }))['entities'] as { id: string; name?: string }[];
    for (const e of page) if (e.name !== undefined && !byName.has(e.name)) byName.set(e.name, e.id);
    if (page.length < 1000) break;
  }
  for (const n of names) {
    const id = byName.get(n);
    if (id === undefined) throw new Error(`see-through: no object named ${n}`);
    ids.push(id);
  }
  const b = seeThroughBehavior(ids, maxFade);
  await publishBehaviorVia(be, p, cmd, b);
  const driver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'See-through subjects', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setBehaviorProperties', { entityId: driver, behaviorId: b.behaviorId, values: {} });
  return ids;
}

/** A window of drawn frames (intervals between frames that drew, ms). */
export interface DrawnWindow {
  frames: number;
  p50: number;
  p95: number;
  longest: number;
  /** Intervals that missed a 60 Hz refresh (half a frame late, as the frame runs count them). */
  missed: number;
}

export interface SwitchRun {
  url: string;
  /** Page ms from the key press to the renderer armed (negative: armed ahead, at load) and to the first frame drawn after both it and the press (null: never). */
  armedAfterMs: number | null;
  firstDrawAfterMs: number | null;
  /** Page ms from the press to a subject's first fade (null: none faded), and the subjects in the view's slots at the end. */
  fadeAfterMs: number | null;
  subjects: number;
  /** The drawn frames before the press, from it over the next `SWITCH_HITCH_MS`, and after that. */
  before: DrawnWindow;
  hitch: DrawnWindow;
  after: DrawnWindow;
  /** Programs (WebGL 2) or pipelines (WebGPU) made: before the press, once it settled, at the end of the run. */
  programs: { before: number; settled: number; end: number };
  errors: string[];
}

/** The frames after the press that count as the switch's (the rebuild and its precompile), then the settled window. */
export const SWITCH_HITCH_MS = 3000;
const SWITCH_AFTER_MS = 5000;
const SWITCH_BEFORE_MS = 3000;

/**
 * In the page: every drawn frame's time, when a see-through view first armed the renderer and when a subject
 * first faded (the view arms through `renderer.contextNode`, three-adapter `see-through.ts`, and is read there).
 */
function installSwitchClock(): void {
  type View = { diagnostics(): { subjects: { fade: number }[] } };
  const w = window as unknown as { __tlDrawn: number[]; __tlArmedAt: number | null; __tlFadeAt: number | null; __tlPerf?: { draws: number }; __tlProbe?: { renderers: { contextNode?: { value?: Record<string, unknown> } }[] } };
  w.__tlDrawn = [];
  w.__tlArmedAt = null;
  w.__tlFadeAt = null;
  let last = -1;
  const loop = (t: number): void => {
    const d = w.__tlPerf?.draws ?? 0;
    if (d !== last) {
      last = d;
      w.__tlDrawn.push(t);
    }
    const view = (w.__tlProbe?.renderers ?? []).map((r) => r.contextNode?.value?.['tlSeeThrough'] as View | undefined).find((v) => v !== undefined);
    if (w.__tlArmedAt === null && view !== undefined) w.__tlArmedAt = t;
    if (w.__tlFadeAt === null && view !== undefined && view.diagnostics().subjects.some((sl) => sl.fade > 0)) w.__tlFadeAt = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

const drawnWindow = (times: readonly number[], from: number, to: number): DrawnWindow => {
  const iv: number[] = [];
  for (let i = 1; i < times.length; i++) if (times[i]! > from && times[i]! <= to) iv.push(times[i]! - times[i - 1]!);
  const s = summarize(iv);
  return { frames: s.n, p50: s.p50, p95: s.p95, longest: s.max, missed: iv.filter((v) => v > LONG_FRAME_MS * 1.5).length };
};

/** The switch measured on one page: see-through turned on by the subjects' script mid-run. */
export async function measureSwitch(browser: Browser, url: string, settleMs = 15_000): Promise<SwitchRun> {
  const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
  await context.addInitScript(installPerfInstrumentation);
  await context.addInitScript(installFrameProbe, { timestamps: false });
  await context.addInitScript(installSwitchClock);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`.slice(0, 300)));
  const programs = (): Promise<number> => page.evaluate(() => {
    const P = (window as unknown as { __tlPerf?: { live: { programs: number; pipelines: number } } }).__tlPerf;
    return (P?.live.programs ?? 0) + (P?.live.pipelines ?? 0);
  });
  try {
    await page.goto(uncappedUrl(url));
    await page.waitForFunction(() => (window as unknown as { __tlPerf?: { firstDrawAt: number | null } }).__tlPerf?.firstDrawAt ?? null, null, { timeout: 180_000 });
    await new Promise((r) => setTimeout(r, settleMs));
    const before = await programs();
    const pressAt = await page.evaluate(() => performance.now());
    await page.keyboard.press('Space');
    await new Promise((r) => setTimeout(r, SWITCH_HITCH_MS));
    const settled = await programs();
    await new Promise((r) => setTimeout(r, SWITCH_AFTER_MS));
    const end = await programs();
    const { drawn, armedAt, fadeAt, subjects } = await page.evaluate(() => {
      type View = { diagnostics(): { subjects: unknown[] } };
      const w = window as unknown as { __tlDrawn: number[]; __tlArmedAt: number | null; __tlFadeAt: number | null; __tlProbe?: { renderers: { contextNode?: { value?: Record<string, unknown> } }[] } };
      const view = (w.__tlProbe?.renderers ?? []).map((r) => r.contextNode?.value?.['tlSeeThrough'] as View | undefined).find((v) => v !== undefined);
      return { drawn: w.__tlDrawn.slice(), armedAt: w.__tlArmedAt, fadeAt: w.__tlFadeAt, subjects: view?.diagnostics().subjects.length ?? 0 };
    });
    const firstDraw = armedAt === null ? undefined : drawn.find((t) => t > Math.max(armedAt, pressAt));
    if (armedAt === null) errors.push('see-through never armed the renderer (did the key reach the game?)');
    return {
      url,
      armedAfterMs: armedAt === null ? null : Math.round(armedAt - pressAt),
      firstDrawAfterMs: firstDraw === undefined ? null : Math.round(firstDraw - pressAt),
      fadeAfterMs: fadeAt === null ? null : Math.round(fadeAt - pressAt),
      subjects,
      before: drawnWindow(drawn, pressAt - SWITCH_BEFORE_MS, pressAt),
      hitch: drawnWindow(drawn, pressAt, pressAt + SWITCH_HITCH_MS),
      after: drawnWindow(drawn, pressAt + SWITCH_HITCH_MS, pressAt + SWITCH_HITCH_MS + SWITCH_AFTER_MS),
      programs: { before, settled, end },
      errors,
    };
  } finally {
    await context.close();
  }
}

const win = (w: DrawnWindow): string => `p50/p95 ${w.p50}/${w.p95} ms, longest ${w.longest} ms, ${w.missed} missed (${w.frames} frames)`;

export function switchLine(what: string, s: SwitchRun): string {
  const armed = s.armedAfterMs === null ? 'never armed' : s.armedAfterMs < 0 ? `armed ahead (${-s.armedAfterMs} ms before the press)` : `armed ${s.armedAfterMs} ms after the press`;
  return `${what}: ${armed}, next frame drawn at ${s.firstDrawAfterMs ?? '-'} ms, first fade at ${s.fadeAfterMs ?? '-'} ms, ${s.subjects} subjects in the view; before ${win(s.before)}; the ${SWITCH_HITCH_MS / 1000} s after the press ${win(s.hitch)}; then ${win(s.after)}; programs/pipelines made ${s.programs.before} → ${s.programs.settled} (settled) → ${s.programs.end} (end)${s.errors.length > 0 ? `; errors ${s.errors.join(' | ')}` : ''}`;
}

/** Off against on in one line: GPU ms (timestamps), draws, programs/pipelines made, the frames at the cap. */
export function seeThroughLine(what: string, off: FrameRunResult, on: FrameRunResult): string {
  const gpu = (r: FrameRunResult): number | null => (r.gpu?.available === true ? r.gpu.msPerFrame : null);
  const made = (r: FrameRunResult): number => r.live.programs + r.live.pipelines;
  const d = (a: number | null, b: number | null): string => (a === null || b === null ? '-' : `${b - a >= 0 ? '+' : ''}${Math.round((b - a) * 1000) / 1000}`);
  const g0 = gpu(off);
  const g1 = gpu(on);
  const busy = off.busy !== undefined && on.busy !== undefined ? `, GPU process ${Math.round((off.busy.gpuProcessMsPerS / Math.max(1, off.busy.fps)) * 100) / 100} → ${Math.round((on.busy.gpuProcessMsPerS / Math.max(1, on.busy.fps)) * 100) / 100} ms a frame` : '';
  return `${what}: gpu ${g0 ?? '-'} → ${g1 ?? '-'} ms (${d(g0, g1)})${busy}, draws p50 ${off.draws.p50} → ${on.draws.p50} (${d(off.draws.p50, on.draws.p50)}), programs ${made(off)} → ${made(on)}, frame p50/p95 ${off.frames.p50}/${off.frames.p95} → ${on.frames.p50}/${on.frames.p95} ms, missed ${off.frames.missed ?? '-'} → ${on.frames.missed ?? '-'}, longest ${off.frames.max ?? '-'} → ${on.frames.max ?? '-'} ms`;
}

/** A plan's objects as candidates (their transform's position: objects at the scene's root or under folders at the origin). */
export function candidatesOf(entities: readonly EntityValue[], take: (e: EntityValue) => boolean): SubjectCandidate[] {
  const out: SubjectCandidate[] = [];
  for (const e of entities) {
    const at = (e.components['transform'] as { position?: number[] } | undefined)?.position;
    if (at !== undefined && take(e)) out.push({ name: e.name, position: [at[0]!, at[1]!, at[2]!] });
  }
  return out;
}

/**
 * What a see-through measurement adds to a report: the subjects named, and per renderer the run with it on, the
 * switch with the setting off (a rebuild), and with the setting on: the page idle (built, off) and its switch.
 */
export interface SeeThroughReport {
  subjects: string[];
  byRenderer: Partial<Record<FrameRenderer, { on: FrameRunResult; switch: SwitchRun; prebuiltIdle?: FrameRunResult; prebuiltSwitch?: SwitchRun }>>;
}

/** The project exported again with see-through's setting on (the mask built at load); returns the export's folder. */
export async function exportPrebuilt(be: PerfBackend, projectId: string): Promise<string> {
  await be.project(projectId).command('setSettings', { settings: { see_through: 1 } });
  const res = await be.post(`/api/v1/admin/projects/${projectId}/export`, {});
  if (res.status !== 200) throw new Error(`see-through export failed: ${JSON.stringify(res.json).slice(0, 400)}`);
  // Back off: later exports of the run (a view's) are the class as built.
  await be.project(projectId).command('setSettings', { settings: { see_through: 0 } });
  return join(be.exportRoot, String(res.json['outputDir']));
}

/** The measurements on one renderer: `site` the export as built (setting off), `prebuilt` the one with it on. */
export async function seeThroughRuns(browser: Browser, siteUrl: string, prebuiltUrl: string, base: FrameRunResult, page: (url: string) => Promise<FrameRunResult>, what: string, log: (s: string) => void): Promise<NonNullable<SeeThroughReport['byRenderer'][FrameRenderer]>> {
  const on = await page(`${siteUrl}&${SEE_THROUGH_ON}`);
  log(seeThroughLine(`${what} off → on`, base, on));
  const sw = await measureSwitch(browser, siteUrl);
  log(switchLine(`${what} switched on, setting off (rebuilt)`, sw));
  const prebuiltIdle = await page(prebuiltUrl);
  log(seeThroughLine(`${what} off → setting on, idle`, base, prebuiltIdle));
  log(seeThroughLine(`${what} setting on, idle → on`, prebuiltIdle, on));
  const prebuiltSwitch = await measureSwitch(browser, prebuiltUrl);
  log(switchLine(`${what} switched on, setting on`, prebuiltSwitch));
  return { on, switch: sw, prebuiltIdle, prebuiltSwitch };
}
