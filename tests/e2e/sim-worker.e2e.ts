/**
 * Phase 22.0: the game's simulation runs in a worker in Play and in the
 * export by default, and in the page with `?threads=off`.
 *
 * On Beacon Reach (a coin with a pickup sound put just ahead of the player):
 * - Play reports where its simulation runs (worker, transforms by messages —
 *   the editor is not cross-origin isolated by default) and logs it; a held
 *   key moves the player within a few frames; the pickup's sound request
 *   (made in the simulation) reaches the page's audio owner and plays; the
 *   same holds with `?threads=off` (single thread);
 * - with the backend's cross-origin isolation on, Play is isolated and the
 *   worker's transforms go through shared memory;
 * - the export, served by a plain static server, runs in the worker (and in
 *   the page with ?threads=off; with COOP/COEP headers through shared
 *   memory): the run starts from the keyboard and a held key scrolls the view.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

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

/** Beacon Reach, the start ground cleared, a coin that chimes (a Beacon Reach sound) 1.5 m ahead of the player. */
async function setup(isolation: boolean): Promise<void> {
  be = await startBackend('simw-e2e', 'beacon-reach', isolation ? { THIRDLIGHT_CROSS_ORIGIN_ISOLATION: '1' } : {});
  for (const entityId of ['box-0002', 'box-0003']) await cmd('deleteEntity', { entityId });
  const q = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 200, offset: 0 } })) as { entities?: { id: string; sceneId?: string; components: { transform?: { position: number[] } } }[] };
  const player = q.entities!.find((e) => e.id === 'model-0001')!;
  const [px, py] = player.components.transform!.position as [number, number];
  await cmd('createEntity', { ...(player.sceneId !== undefined ? { sceneId: player.sceneId } : {}), kind: 'group', name: 'Chime coin', transform: { position: [px + 1.5, py, 0] }, components: { pickup: { kind: 'coin', value: 1, size: [0.8, 2], cue: 'br-audio-jump' } } });
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

  // A click in the game focuses it and unlocks sound; Enter starts the run.
  await page.locator('iframe.tl-app__preview-frame').click();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await observe()).state).toBe('playing');
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
    // Walk on through the coin: counted in the simulation, its sound played by the page's audio owner.
    await expect.poll(async () => (await observe()).counters?.['coins'] ?? 0, { timeout: 15_000 }).toBe(1);
  } finally {
    await page.keyboard.up('d');
  }
  await expect.poll(async () => (await observe()).sound?.played?.sfx ?? 0, { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  await page.getByTitle('Stop the play preview').click();
  await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0);
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
      // The run starts from the keyboard (the run command goes to wherever the simulation runs) …
      const hud = game.locator('#hud-root');
      await expect(hud).toContainText('Deaths: 0', { timeout: 20_000 });
      const titleText = await hud.innerText();
      await game.mouse.click(20, 400);
      await game.keyboard.press('Enter');
      await expect.poll(() => hud.innerText(), { timeout: 15_000 }).not.toBe(titleText);
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
