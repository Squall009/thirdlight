/**
 * Beacon Reach in the browser: created from its template through the
 * backend, played to the goal in the editor's isolated preview through the
 * play relays (closed loop on the observed player position — what an MCP
 * agent does), driven by the real keyboard, and exported and started from
 * a plain static server with the backend stopped.
 */
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('beacon-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

/** x positions (m) where the player should jump: two steps, hazards, the final step. */
const JUMP_AT = [5.4, 9.5, 14.8, 27.0, 30.5, 35.4];

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

type Observation = { state: string; goalReached: boolean; deathCount: number; checkpointId: string | null; player?: { x: number; y: number } };

async function startPlay(page: Page): Promise<string> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 15_000 }).toBe(200);
  return psid;
}

test('an agent plays Beacon Reach to the goal through the play relays (observe → input → observe …)', async ({ page }) => {
  const psid = await startPlay(page);
  const observe = async (): Promise<Observation> => (await relay(`${psid}/observe`, {})).json as unknown as Observation;
  expect((await observe()).state).toBe('awaitingStart');
  expect((await relay(`${psid}/control`, { command: 'start' })).status).toBe(200);

  const run = (n: number) => Array.from({ length: n }, (_, i) => ({ stepOffset: i, moveX: 1, jump: 'none' }));
  // A jump keeps running right until it has landed (~0.9 s): between relay
  // requests the input is neutral, which would stall the player mid-air.
  const jump = Array.from({ length: 110 }, (_, i) => ({ stepOffset: i, moveX: 1, jump: i === 0 ? 'pressed' : i < 30 ? 'held' : i === 30 ? 'released' : 'none' }));
  const done = new Set<number>();
  let o = await observe();
  let deaths = 0;
  const trace: string[] = [];
  let lastX = -1;
  let stuck = 0;
  for (let i = 0; i < 400 && !o.goalReached; i++) {
    const x = o.player!.x;
    if (o.deathCount !== deaths) {
      deaths = o.deathCount; // respawned behind: re-arm the jumps ahead
      for (const j of [...done]) if (j > x) done.delete(j);
    }
    const w = JUMP_AT.find((j) => !done.has(j) && x >= j && x < j + 1.5);
    if (w !== undefined) done.add(w);
    // Blocked (e.g. a jump did not take against a step): jump again, as a player would.
    stuck = Math.abs(x - lastX) < 0.05 ? stuck + 1 : 0;
    lastX = x;
    const doJump = w !== undefined || stuck >= 2;
    if (doJump) stuck = 0;
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: doJump ? jump : run(12) });
    trace.push(`${i} x=${x.toFixed(2)} y=${o.player!.y.toFixed(2)} ${o.state} d=${o.deathCount}${doJump ? ' JUMP' : ''}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    o = await observe();
  }
  if (process.env.TL_SHOT_DIR) writeFileSync(join(process.env.TL_SHOT_DIR, 'beacon-trace.txt'), trace.join('\n'));
  expect(o.goalReached).toBe(true);
  expect(o.state).toBe('won');
  expect(o.checkpointId).not.toBeNull();

  // The same relays serve screenshots and diagnostics.
  const shot = await relay(`${psid}/screenshot`, {});
  expect(shot.status).toBe(200);
  if (process.env.TL_SHOT_DIR) writeFileSync(join(process.env.TL_SHOT_DIR, 'beacon-won.png'), Buffer.from(String(shot.json.dataUrl).split(',')[1] ?? '', 'base64'));
  expect(String(shot.json.dataUrl)).toMatch(/^data:image\/png;base64,/);
  expect((await relay(`${psid}/diagnostics`, {})).status).toBe(200);
});

test('the keyboard drives the game in the editor preview', async ({ page }) => {
  const psid = await startPlay(page);
  const x = async (): Promise<number> => ((await relay(`${psid}/observe`, {})).json as unknown as Observation).player!.x;
  await page.locator('iframe.tl-app__preview-frame').click(); // focus the game
  await page.keyboard.press('Enter');
  await expect.poll(async () => ((await relay(`${psid}/observe`, {})).json as unknown as Observation).state).toBe('playing');
  const x0 = await x();
  await page.keyboard.down('d');
  await page.waitForTimeout(400);
  await page.keyboard.up('d');
  expect(await x()).toBeGreaterThan(x0 + 0.5);
});

test('the exported Beacon Reach starts and plays from the keyboard with the backend stopped', async ({ page }) => {
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const dir = join(be.exportRoot, String(res.json.outputDir));
  const server = createServer((req, reply) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      reply.statusCode = 404;
      reply.end();
      return;
    }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
    reply.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(reply);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    await page.goto(url);
    const hud = async (): Promise<string> => (await page.locator('#hud-root').textContent()) ?? '';
    await expect.poll(hud, { timeout: 15_000 }).toContain('to start');
    await page.locator('canvas#game').click();
    await page.keyboard.press('Enter');
    await expect.poll(hud).toContain('to jump');
    await page.keyboard.down('d');
    await page.waitForTimeout(500);
    await page.keyboard.press('Space');
    await page.keyboard.up('d');
    await expect(page.getByText(/error/i)).toHaveCount(0);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
