/**
 * The game's simulation runs in a worker in Play and in the
 * export by default, and in the page with `?threads=off`.
 *
 * On the starter template (a collectible with an event sound put just ahead
 * of the player):
 * - Play reports where its simulation runs (worker, transforms by messages —
 *   the editor is not cross-origin isolated by default) and logs it; a held
 *   key moves the player within a few frames; the collectible's sound request
 *   (made in the simulation) reaches the page's audio owner and plays; the
 *   same holds with `?threads=off` (single thread);
 * - with the backend's cross-origin isolation on, Play is isolated and the
 *   worker's transforms go through shared memory;
 * - the export, served by a plain static server, runs in the worker (and in
 *   the page with ?threads=off; with COOP/COEP headers through shared
 *   memory): the run starts from the keyboard and a held key scrolls the view;
 * - Play never waits on the worker: with the worker slowed to 40 ms a frame it
 *   still draws every animation frame (nothing between a frame and its draw
 *   waits), and a 240 Hz game at 30 fps keeps real time without dropped steps.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { addTitleShell, publishWav, startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

type Pipeline = { frames: number; blockedMs: number; blockedMaxMs: number; framesWithoutStep: number; framesWithoutWorkerFrame: number; ticksSkipped: number; workerRoundTripMs: { avg: number; max: number }; inputToDrawMs: { avg: number; max: number } };
type Observation = { state: string; player?: { x: number; y: number }; counters?: Record<string, number>; sound?: { unlocked: boolean; played?: { sfx: number; ui: number } }; simulation?: { mode: string; transport: string | null; isolated: boolean } };

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} })).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-simw' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
}

/** The starter with its step and platform removed, a collectible that chimes (a fixture sound through the event cue table) 1.5 m ahead of the player, and a title that waits for the start (the game shell). */
async function setup(isolation: boolean): Promise<void> {
  be = await startBackend('simw-e2e', 'starter', isolation ? { THIRDLIGHT_CROSS_ORIGIN_ISOLATION: '1' } : {});
  const chime = await publishWav(be, 'cue-start.wav', 'audio-chime', 'Chime');
  for (const entityId of ['box-0002', 'box-0003']) await cmd('deleteEntity', { entityId });
  const q = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 200, offset: 0 } })) as { entities?: { id: string; sceneId?: string; components: { transform?: { position: number[] } } }[] };
  const player = q.entities!.find((e) => e.id === 'model-0001')!;
  const [px, py] = player.components.transform!.position as [number, number];
  await cmd('createEntity', { sceneId: 'scene-main', ...(player.sceneId !== undefined ? { sceneId: player.sceneId } : {}), kind: 'group', name: 'Chime item', transform: { position: [px + 1.5, py, 0] }, components: { collectible: { counter: 'items', size: [0.8, 2, 0.8] } } });
  await cmd('setEventCues', { cues: [{ on: 'event', name: 'collected', assetId: chime }] });
  await addTitleShell(be);
}

/** Open the editor (with a page query) and start Play; returns the play session id. */
async function startPlay(page: Page, query = ''): Promise<string> {
  const url = query === '' ? be!.editorUrl : be!.editorUrl.replace('#', `${be!.editorUrl.split('#')[0]!.includes('?') ? '&' : '?'}${query}#`);
  await page.goto(url);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  return psid;
}

async function playChecks(page: Page, psid: string, expectMode: { mode: string; transport: string | null; isolated: boolean }, logs: string[]): Promise<{ frames: number }> {
  const observe = async (): Promise<Observation> => (await relay(`${psid}/observe`, {})).json as unknown as Observation;
  expect((await observe()).simulation).toEqual(expectMode);
  await expect.poll(() => logs.find((l) => l.startsWith('[thirdlight] simulation:')) ?? '').toContain(expectMode.mode === 'worker' ? 'simulation: worker' : 'simulation: single thread');

  // A click in the game focuses it and unlocks sound; Enter starts the game (the title's Start).
  await page.locator('iframe.tl-app__preview-frame').click({ position: { x: 400, y: 300 } });
  await expect.poll(async () => (await observe()).state).toBe('paused');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await observe()).state).toBe('running');
  await expect.poll(async () => (await observe()).sound?.unlocked).toBe(true);
  await page.waitForTimeout(300);

  // Input latency: frames from before the key goes down until the player has moved.
  const frameCount = async (): Promise<number> => ((await relay(`${psid}/diagnostics`, {})).json['diagnostics'] as { runtime: { frameCount: number } }).runtime.frameCount;
  const x0 = (await observe()).player!.x;
  const f0 = await frameCount();
  await page.keyboard.down('d');
  let frames = -1;
  try {
    await expect
      .poll(async () => {
        const o = await observe();
        if (o.player!.x > x0 + 0.02 && frames < 0) frames = (await frameCount()) - f0;
        return o.player!.x > x0 + 0.02;
      }, { timeout: 15_000 })
      .toBe(true);
    // Walk on through the item: counted in the simulation, its sound played by the page's audio owner.
    await expect.poll(async () => (await observe()).counters?.['items'] ?? 0, { timeout: 15_000 }).toBe(1);
  } finally {
    await page.keyboard.up('d');
  }
  await expect.poll(async () => (await observe()).sound?.played?.sfx ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  // The worker's pipeline as Play reports it: a draw never waits, and input reaches the screen about a frame later.
  const pipeline = ((await relay(`${psid}/diagnostics`, {})).json['diagnostics'] as { simulation: { pipeline: Pipeline | null } }).simulation.pipeline;
  if (expectMode.mode === 'worker') {
    process.stderr.write(`sim-worker e2e: pipeline (${expectMode.transport}): ${JSON.stringify(pipeline)}\n`);
    expect(pipeline!.blockedMaxMs).toBeLessThan(5);
  } else expect(pipeline).toBeNull();
  await page.getByTitle('Stop the play preview').click();
  // Stop is a backend round trip plus the preview's teardown: seconds on a loaded CPU-rendered host.
  await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0, { timeout: 30_000 });
  return { frames };
}

test('Play: the simulation worker by default and a single thread with ?threads=off — key to motion within a few frames, sounds reach the page', async ({ page }) => {
  test.setTimeout(240_000);
  await setup(false);
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  const worker = await playChecks(page, await startPlay(page), { mode: 'worker', transport: 'message', isolated: false }, logs);
  logs.length = 0;
  const single = await playChecks(page, await startPlay(page, 'threads=off'), { mode: 'single', transport: null, isolated: false }, logs);
  // Upper bounds (the relays' own round trips are included): a few frames, and no worse than the page by more than a couple.
  process.stderr.write(`sim-worker e2e: frames from key down to motion (upper bound): worker ${worker.frames}, single ${single.frames}\n`);
  expect(worker.frames).toBeGreaterThanOrEqual(0);
  expect(worker.frames).toBeLessThanOrEqual(12);
  expect(single.frames).toBeLessThanOrEqual(12);
});

test('Play with cross-origin isolation: the worker shares memory with the page', async ({ page }) => {
  test.setTimeout(180_000);
  await setup(true);
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  const psid = await startPlay(page);
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await playChecks(page, psid, { mode: 'worker', transport: 'shared', isolated: true }, logs);
  expect(logs.some((l) => l.includes('transforms by shared memory'))).toBe(true);
});

type Diagnostics = { runtime: { stepIndex: number; droppedSteps: number }; simulation: { mode: string; pipeline: Pipeline | null } };

/** Start the title's game in a started Play (a click focuses it, Enter starts it). */
async function startGame(page: Page, psid: string): Promise<void> {
  const state = async (): Promise<string> => ((await relay(`${psid}/observe`, {})).json as unknown as Observation).state;
  await page.locator('iframe.tl-app__preview-frame').click({ position: { x: 400, y: 300 } });
  await expect.poll(state).toBe('paused');
  await page.keyboard.press('Enter');
  await expect.poll(state).toBe('running');
}

test('Play never waits on the simulation: it draws at the display rate with a slowed worker, and a 240 Hz game keeps real time at 30 fps', async ({ browser }) => {
  test.setTimeout(240_000);
  await setup(false);
  await cmd('setSettings', { settings: { fixed_step_hz: 240 } });
  const diagnostics = async (psid: string): Promise<Diagnostics> => (await relay(`${psid}/diagnostics`, {})).json['diagnostics'] as Diagnostics;

  // A worker slowed to 40 ms a frame (?simDelayMs=40): the page still draws every animation frame.
  {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    // Count the play page's animation frames (the display's rate as the browser runs it).
    await context.addInitScript(() => {
      const w = window as unknown as { __rafs: number };
      w.__rafs = 0;
      const count = (): void => {
        w.__rafs += 1;
        requestAnimationFrame(count);
      };
      requestAnimationFrame(count);
    });
    const page = await context.newPage();
    const psid = await startPlay(page, 'simDelayMs=40');
    await startGame(page, psid);
    const frame = page.frameLocator('iframe.tl-app__preview-frame');
    const rafs = async (): Promise<number> => frame.locator('body').evaluate(() => (window as unknown as { __rafs: number }).__rafs);
    await page.waitForTimeout(500);
    const d0 = await diagnostics(psid);
    const r0 = await rafs();
    const t0 = Date.now();
    await page.waitForTimeout(3000);
    const d1 = await diagnostics(psid);
    const r1 = await rafs();
    const seconds = (Date.now() - t0) / 1000;
    const p0 = d0.simulation.pipeline!;
    const p1 = d1.simulation.pipeline!;
    expect(d1.simulation.mode).toBe('worker');
    const drawn = (p1.frames - p0.frames) / seconds;
    const display = (r1 - r0) / seconds;
    const workerFrames = (p1.frames - p1.framesWithoutWorkerFrame - (p0.frames - p0.framesWithoutWorkerFrame)) / seconds;
    process.stderr.write(`sim-worker e2e: slowed worker (40 ms): drawn ${drawn.toFixed(1)} fps, display ${display.toFixed(1)} fps, worker frames ${workerFrames.toFixed(1)}/s, blocked max ${p1.blockedMaxMs} ms, round trip ${JSON.stringify(p1.workerRoundTripMs)}, input to draw ${JSON.stringify(p1.inputToDrawMs)}\n`);
    // Every animation frame draws, though the worker answers at most every 40 ms.
    expect(drawn).toBeGreaterThan(0.85 * display);
    expect(workerFrames).toBeLessThan(26);
    expect(drawn).toBeGreaterThan(1.5 * workerFrames);
    expect(p1.ticksSkipped).toBeGreaterThan(p0.ticksSkipped);
    // Nothing between an animation frame and its draw waits for the worker.
    expect(p1.blockedMaxMs).toBeLessThan(5);
    expect(p1.workerRoundTripMs.avg).toBeGreaterThanOrEqual(40);
    await context.close();
  }

  // The display at 30 fps (every animation frame held to 33 ms): a 240 Hz game runs 8 steps a frame and keeps real time.
  {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    await context.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window);
      let last = 0;
      window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
        raf(function held(t: number): void {
          if (t - last >= 1000 / 30 - 1) {
            last = t;
            cb(t);
          } else raf(held);
        });
    });
    const page = await context.newPage();
    const psid = await startPlay(page);
    await startGame(page, psid);
    await page.waitForTimeout(500);
    const d0 = await diagnostics(psid);
    const t0 = Date.now();
    await page.waitForTimeout(4000);
    const d1 = await diagnostics(psid);
    const seconds = (Date.now() - t0) / 1000;
    const p0 = d0.simulation.pipeline!;
    const p1 = d1.simulation.pipeline!;
    const fps = (p1.frames - p0.frames) / seconds;
    const stepsPerSecond = (d1.runtime.stepIndex - d0.runtime.stepIndex) / seconds;
    process.stderr.write(`sim-worker e2e: 240 Hz at ${fps.toFixed(1)} fps: ${stepsPerSecond.toFixed(1)} steps/s, dropped ${d1.runtime.droppedSteps - d0.runtime.droppedSteps}\n`);
    expect(fps).toBeLessThan(33);
    expect(stepsPerSecond).toBeGreaterThan(240 * 0.93);
    expect(stepsPerSecond).toBeLessThan(240 * 1.07);
    expect(d1.runtime.droppedSteps - d0.runtime.droppedSteps).toBe(0);
    await context.close();
  }
});

/** A plain static file server (optionally with COOP/COEP headers). */
function serveDir(dir: string, isolated: boolean): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    if (isolated) {
      res.setHeader('cross-origin-opener-policy', 'same-origin');
      res.setHeader('cross-origin-embedder-policy', 'require-corp');
    }
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('the export: the worker by default (messages; shared memory under COOP/COEP) and the page with ?threads=off — the keyboard plays it', async ({ page }) => {
  test.setTimeout(240_000);
  await setup(false);
  const res = await be!.admin(`projects/${be!.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be!.halt();
  const dir = join(be!.exportRoot, String(res.json.outputDir));
  expect(existsSync(join(dir, 'js', 'sim-worker.js'))).toBe(true);
  const cases: { isolated: boolean; query: string; want: { mode: string; transport: string | null; isolated: boolean } }[] = [
    { isolated: false, query: '', want: { mode: 'worker', transport: 'message', isolated: false } },
    { isolated: false, query: '?threads=off', want: { mode: 'single', transport: null, isolated: false } },
    { isolated: true, query: '', want: { mode: 'worker', transport: 'shared', isolated: true } },
  ];
  for (const c of cases) {
    const site = await serveDir(dir, c.isolated);
    const game = await page.context().newPage();
    const errors: string[] = [];
    game.on('pageerror', (e) => errors.push(e.message));
    const requests: string[] = [];
    game.on('request', (r) => requests.push(r.url()));
    try {
      await game.goto(`${site.url}${c.query}`);
      await expect.poll(() => game.evaluate(() => (window as unknown as { __thirdlightThreading?: unknown }).__thirdlightThreading ?? null), { timeout: 30_000 }).toMatchObject(c.want);
      // The game starts from the keyboard (the title's Start; the restart goes to wherever the simulation runs) …
      const observed = async (): Promise<string | null> => game.evaluate(() => (window as unknown as { __thirdlightObserve?: () => { state?: string } | null }).__thirdlightObserve?.()?.state ?? null);
      await expect(game.locator('[data-tl-ui-doc="start-title"]')).toBeVisible({ timeout: 20_000 });
      await expect.poll(observed, { timeout: 20_000 }).toBe('paused');
      await game.mouse.click(400, 400);
      await game.keyboard.press('Enter');
      await expect.poll(observed, { timeout: 15_000 }).toBe('running');
      // … and a held key moves the player: the view changes much more than while standing still.
      const diff = (p: Buffer, q: Buffer): number => {
        const a = decodePng(p);
        const b = decodePng(q);
        let changed = 0;
        for (let y = 0; y < a.height; y += 4) {
          for (let x = 0; x < a.width; x += 4) {
            const u = a.pixel(x, y);
            const v = b.pixel(x, y);
            if (Math.abs(u[0] - v[0]) + Math.abs(u[1] - v[1]) + Math.abs(u[2] - v[2]) > 24) changed += 1;
          }
        }
        return changed;
      };
      await game.waitForTimeout(500);
      const still0 = await game.screenshot();
      await game.waitForTimeout(1500);
      const still1 = await game.screenshot();
      await game.keyboard.down('d');
      await game.waitForTimeout(1500);
      await game.keyboard.up('d');
      const moved = await game.screenshot();
      const idle = diff(still0, still1);
      const moving = diff(still1, moved);
      expect(moving, `${c.query || 'default'}${c.isolated ? ' (isolated)' : ''}: pixels changed while moving (${moving}) vs standing (${idle})`).toBeGreaterThan(Math.max(3 * idle, 100));
      expect(errors).toEqual([]);
      expect(requests.every((u) => u.startsWith(site.url))).toBe(true);
    } finally {
      await game.close();
      await site.close();
    }
  }
});
