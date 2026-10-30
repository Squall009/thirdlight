/**
 * The terrain editor's edit mode on a large level (`level --edit-mode`, the
 * landscape class): how long entering and leaving takes to the first frame,
 * whether the renderer built programs for it, what a frame of the isolated
 * terrain costs against the same view with everything drawn, and the round
 * trip of a masked paint and sculpt dab on its 257² tiles.
 *
 * The Scene view draws on demand, so frames are asked for by an orbit (one
 * pointer move per animation frame, as `scene-view-run.ts` does) in the
 * default view, in the mode (Material rules: no brush is armed, a plain drag
 * orbits) and with Context on. The enter and leave times run from the input
 * event (a double-click on the terrain's Hierarchy row, Esc) to the Scene
 * view's next drawn frame (its `data-frames` count changing with the canvas
 * lent to the mode, or home again).
 *
 * The orbit frames are timed uncapped (vsync off), the enter and leave times
 * in a second browser with vsync on, as a user's browser draws. The
 * landscape's view animates (its ground cover sways), so it draws every
 * frame; uncapped, its WebGL frames queue up in the GPU process ahead of the
 * GPU (about 0.8 s of them on this host), and moving the canvas resizes its
 * drawing buffer, which waits for that whole queue (a GPU trace showed it:
 * `setSize` → `GetGLError` → `Finish`). That queue never builds with vsync,
 * so an uncapped leave measured the harness, not the editor.
 */
import type { Browser, Page } from '@playwright/test';

import type { PerfBackend } from './backend';
import { FRAME_VIEWPORT, launchGpuBrowser, type FrameRenderer } from './frame-run';
import { installPerfInstrumentation, readSample } from './instrument';
import { summarize } from './stats';

/** Enter and leave rounds per renderer. */
const ROUNDS = 3;
/** Each orbit's warm-up and recorded time (ms). */
const ORBIT_WARMUP_MS = 1500;
const ORBIT_RECORD_MS = 5000;
/** Masked dabs sent per kind for the round trip. */
const DABS = 20;

export interface EditModeRun {
  enterMs: number[];
  leaveMs: number[];
  /** The first leave's main thread: the functions with the most self time (ms). */
  leaveTop: string[];
  /** The renderer's programs before entering, in the mode and after leaving (one round). */
  programs: [number, number, number];
  /** Orbit frame time p50 / p95 (ms) and draws: the default view, the isolated terrain, the mode with Context on. */
  frames: Record<'full' | 'isolated' | 'context', { p50: number; p95: number; n: number; draws: number }>;
}

export interface DabRun {
  paintMs: { p50: number; p95: number; max: number };
  sculptMs: { p50: number; p95: number; max: number };
  /** The same paint strokes without the mask (the control). */
  plainPaintMs: { p50: number; p95: number; max: number };
}

interface CpuProfile {
  nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
  samples: number[];
  timeDeltas: number[];
}

/** A profile's functions with the most self time (name, file:line, ms). */
function topSelf(p: CpuProfile, n: number): string[] {
  const byId = new Map(p.nodes.map((x) => [x.id, x]));
  const ms = new Map<string, number>();
  p.samples.forEach((id, i) => {
    const f = byId.get(id)?.callFrame;
    if (f === undefined) return;
    const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop() ?? ''}:${f.lineNumber}`;
    ms.set(key, (ms.get(key) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000);
  });
  return [...ms].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v.toFixed(1)}`);
}

/** Programs the renderer holds (the Scene view's `data-memory`). */
async function programs(page: Page): Promise<number> {
  const raw = await page.evaluate(() => document.querySelector('canvas.tl-viewport')?.getAttribute('data-memory') ?? '{}');
  const m = JSON.parse(raw) as { programs?: number };
  return m.programs ?? -1;
}

/** Wait until the Scene view stopped drawing for a few seconds (every tile, set and mesh in). */
async function settle(page: Page): Promise<void> {
  let last = '';
  for (let same = 0, t0 = Date.now(); same < 3 && Date.now() - t0 < 180_000; ) {
    const now = await page.evaluate(() => document.querySelector('canvas.tl-viewport')?.getAttribute('data-frames') ?? '');
    same = now === last && now !== '' ? same + 1 : 0;
    last = now;
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** Orbit the view for `ms` (one pointer move per animation frame); recorded: the page's frame intervals and draws. */
async function orbit(page: Page, ms: number, record: boolean): Promise<void> {
  const box = (await page.locator('canvas.tl-viewport').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.evaluate(
    async ({ cx, cy, rx, ry, ms, record }) => {
      const w = window as unknown as { __tlPerf?: { frames: number[]; frameDraws: number[]; frameTris: number[]; frameIndirectDraws: number[]; recording: boolean } };
      const P = w.__tlPerf!;
      if (record) {
        P.frames = [];
        P.frameDraws = [];
        P.frameTris = [];
        P.frameIndirectDraws = [];
        P.recording = true;
      }
      const target = document.elementFromPoint(cx, cy) ?? document.body;
      await new Promise<void>((done) => {
        const start = performance.now();
        let i = 0;
        const step = (): void => {
          const a = (i++ / 240) * Math.PI * 2;
          target.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', isPrimary: true, clientX: cx + Math.cos(a) * rx, clientY: cy + Math.sin(a) * ry, button: -1, buttons: 1, bubbles: true, cancelable: true, composed: true }));
          if (performance.now() - start < ms) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
    },
    { cx, cy, rx: box.width * 0.04, ry: box.height * 0.03, ms, record },
  );
  await page.mouse.up();
}

async function orbitFrames(page: Page): Promise<{ p50: number; p95: number; n: number; draws: number }> {
  await orbit(page, ORBIT_WARMUP_MS, false);
  await orbit(page, ORBIT_RECORD_MS, true);
  const sample = await page.evaluate(readSample, true);
  const s = summarize(sample.frames);
  return { p50: s.p50, p95: s.p95, n: s.n, draws: summarize(sample.frameDraws).p50 };
}

/**
 * Milliseconds from the next `trigger` event (captured on the document) to the Scene view's next drawn frame with
 * its canvas lent (`lent`: true) or home (false).
 */
async function timeToFrame(page: Page, trigger: 'dblclick' | 'keydown', lent: boolean, act: () => Promise<void>): Promise<number> {
  await page.evaluate(
    ({ trigger, lent }) => {
      const w = window as unknown as { __tlEnter?: Promise<number> };
      w.__tlEnter = new Promise<number>((resolve) => {
        let t0 = -1;
        document.addEventListener(trigger, () => (t0 = performance.now()), { capture: true, once: true });
        const canvas = document.querySelector('canvas.tl-viewport')!;
        const obs = new MutationObserver(() => {
          if (t0 < 0) return;
          const isLent = canvas.getAttribute('data-lent') === 'edit';
          if (isLent !== lent) return;
          obs.disconnect();
          resolve(performance.now() - t0);
        });
        obs.observe(canvas, { attributes: true, attributeFilter: ['data-frames'] });
      });
    },
    { trigger, lent },
  );
  await act();
  return Math.round((await page.evaluate(() => (window as unknown as { __tlEnter: Promise<number> }).__tlEnter)) * 10) / 10;
}

/** The editor on the landscape in a new page of `browser`, its terrain's Hierarchy row filtered in. */
async function openLandscape(browser: Browser, be: PerfBackend, projectId: string, terrainName: string, renderer: FrameRenderer): Promise<{ page: Page; close: () => Promise<void>; newCdp: () => Promise<import('@playwright/test').CDPSession> }> {
  const context = await browser.newContext({ viewport: { ...FRAME_VIEWPORT }, deviceScaleFactor: 1 });
  await context.addInitScript(installPerfInstrumentation);
  const page = await context.newPage();
  await page.goto(`${be.origin}/?project=${projectId}&renderer=${renderer}#token=${be.token}`);
  await page.locator('.tl-statusbar').filter({ hasText: 'connected' }).waitFor({ timeout: 180_000 });
  await settle(page);
  await page.getByPlaceholder('filter…').fill(terrainName);
  return { page, close: () => context.close(), newCdp: () => context.newCDPSession(page) };
}

/** `framesBrowser`: uncapped (the orbit frames); `timesBrowser`: vsync on (the enter and leave times). */
async function measure(framesBrowser: Browser, timesBrowser: Browser, be: PerfBackend, projectId: string, terrainName: string, renderer: FrameRenderer): Promise<EditModeRun> {
  const rowOf = (page: Page) => page.locator('.tl-hierarchy__list li[data-entity-id]').filter({ hasText: terrainName }).first();
  // The orbit frames: the default view, the isolated terrain (Material rules: no brush armed, so a plain drag orbits
  // the lent view) and Context.
  const a = await openLandscape(framesBrowser, be, projectId, terrainName, renderer);
  let frames: EditModeRun['frames'];
  try {
    const full = await orbitFrames(a.page);
    await rowOf(a.page).dblclick();
    await a.page.locator('.tl-editmode').waitFor();
    await settle(a.page);
    await a.page.keyboard.press('Shift+Digit4');
    await a.page.mouse.move(5, 500);
    const isolated = await orbitFrames(a.page);
    await a.page.keyboard.press('c');
    const context = await orbitFrames(a.page);
    frames = { full, isolated, context };
  } finally {
    await a.close();
  }
  // The enter and leave rounds (the mode opens in Material rules, the last one shown, after the first round).
  const b = await openLandscape(timesBrowser, be, projectId, terrainName, renderer);
  try {
    const page = b.page;
    const row = rowOf(page);
    await row.waitFor();
    const mode = page.locator('.tl-editmode');
    const enterMs: number[] = [];
    const leaveMs: number[] = [];
    let progs: [number, number, number] = [0, 0, 0];
    let leaveTop: string[] = [];
    for (let k = 0; k < ROUNDS; k++) {
      const before = await programs(page);
      enterMs.push(await timeToFrame(page, 'dblclick', true, () => row.dblclick()));
      await mode.waitFor();
      await settle(page);
      const inMode = await programs(page);
      if (k === 0) {
        await page.keyboard.press('Shift+Digit4');
        await page.mouse.move(5, 500);
        await settle(page);
      }
      // The first leave's main thread by function (self time), to say where the time goes.
      const cdp = k === 0 ? await b.newCdp() : null;
      if (cdp !== null) {
        await cdp.send('Profiler.enable');
        await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
        await cdp.send('Profiler.start');
      }
      leaveMs.push(await timeToFrame(page, 'keydown', false, () => page.keyboard.press('Escape')));
      if (cdp !== null) {
        const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: CpuProfile };
        leaveTop = topSelf(profile, 12);
        await cdp.detach().catch(() => undefined);
      }
      await mode.waitFor({ state: 'detached' });
      await settle(page);
      if (k === 0) progs = [before, inMode, await programs(page)];
    }
    return { enterMs, leaveMs, leaveTop, programs: progs, frames };
  } finally {
    await b.close();
  }
}

/** The landscape's edit mode measured on each renderer (an uncapped browser and a vsync one; the backend stays up for the pages). */
export async function editModeRuns(be: PerfBackend, projectId: string, renderers: readonly FrameRenderer[], log: (s: string) => void): Promise<Partial<Record<FrameRenderer, EditModeRun>>> {
  const p = be.project(projectId);
  const listed = ((await p.query('queryEntities', { limit: 4000, offset: 0 }))['entities'] as { id: string; name?: string; components: Record<string, unknown> }[]) ?? [];
  const terrain = listed.find((e) => e.components['terrain'] !== undefined);
  if (terrain === undefined || terrain.name === undefined) throw new Error('edit mode: no terrain');
  const out: Partial<Record<FrameRenderer, EditModeRun>> = {};
  const browser = await launchGpuBrowser({ vsync: false });
  const vsynced = await launchGpuBrowser({ vsync: true });
  try {
    for (const r of renderers) {
      const run = await measure(browser, vsynced, be, projectId, terrain.name, r);
      out[r] = run;
      const f = (x: EditModeRun['frames']['full']): string => `p50/p95 ${x.p50}/${x.p95} ms, ${x.draws} draws (${x.n} frames)`;
      log(`level landscape ${r} edit mode: first leave's main thread by function (self ms): ${run.leaveTop.join('; ')}`);
      log(`level landscape ${r} edit mode: enter ${run.enterMs.join(', ')} ms, leave ${run.leaveMs.join(', ')} ms to the first frame (vsync); programs ${run.programs.join(' → ')}; orbit frames full view ${f(run.frames.full)}, isolated ${f(run.frames.isolated)}, Context ${f(run.frames.context)}`);
    }
  } finally {
    await browser.close();
    await vsynced.close();
  }
  return out;
}

/** The round trip of masked paint and sculpt dabs (one `editTerrain` each) on the landscape's terrain, near the camera. */
export async function maskedDabRuns(be: PerfBackend, projectId: string, log: (s: string) => void): Promise<DabRun> {
  const p = be.project(projectId);
  const listed = ((await p.query('queryEntities', { limit: 4000, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[]) ?? [];
  const terrain = listed.find((e) => e.components['terrain'] !== undefined);
  if (terrain === undefined) throw new Error('masked dabs: no terrain');
  const mask = { scale: 4, contrast: 1.6, threshold: 0.45, octaves: 4, seed: 1207 };
  const time = async (args: (k: number) => Record<string, unknown>): Promise<{ p50: number; p95: number; max: number }> => {
    const ms: number[] = [];
    for (let k = 0; k < DABS; k++) {
      const t = performance.now();
      await p.command('editTerrain', { entityId: terrain.id, ...args(k) });
      ms.push(performance.now() - t);
    }
    const s = summarize(ms);
    return { p50: Math.round(s.p50), p95: Math.round(s.p95), max: Math.round(s.max) };
  };
  // A short stroke of four dabs 8 m across, beside the area (the flat ground round it), a little further each time.
  const stroke = (k: number): [number, number][] => [0, 1, 2, 3].map((i) => [-120 + k * 6 + i, -60]);
  const plainPaintMs = await time((k) => ({ kind: 'paint', dabs: stroke(k), radius: 4, strength: 0.6, layer: 1, opacity: 0.8 }));
  const paintMs = await time((k) => ({ kind: 'paint', dabs: stroke(k), radius: 4, strength: 0.6, layer: 2, opacity: 0.8, mask }));
  const sculptMs = await time((k) => ({ kind: k % 2 === 0 ? 'raise' : 'lower', dabs: stroke(k), radius: 4, strength: 0.5, mask }));
  log(`level landscape masked dabs (${DABS} commands of 4 dabs, 8 m brush): paint p50/p95/max ${paintMs.p50}/${paintMs.p95}/${paintMs.max} ms, sculpt ${sculptMs.p50}/${sculptMs.p95}/${sculptMs.max} ms; without the mask: paint ${plainPaintMs.p50}/${plainPaintMs.p95}/${plainPaintMs.max} ms`);
  return { paintMs, sculptMs, plainPaintMs };
}
