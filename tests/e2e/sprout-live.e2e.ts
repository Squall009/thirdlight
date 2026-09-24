/**
 * Phase 9.13 (opt-in): the Sprout demo on the LIVE Thirdlight service — the
 * editor shows Meadow 2, Play (the backend's headless editor, over the
 * relay) starts at the title screen and plays Meadow 1,
 * and the exported game (served statically) does the same. Screenshots go to
 * TL_SPROUT_SHOTS for a look. Runs only with TL_SPROUT_LIVE=<editor origin>
 * (e.g. https://thirdlight.turnkeydata.net) and the owner token file
 * (TL_TOKEN_FILE, default ~/thirdlight/owner-token); the token stays in the
 * page URL fragment and the Authorization header, never in the output.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { expect, test } from '@playwright/test';

const LIVE = process.env['TL_SPROUT_LIVE'];
const SHOTS = process.env['TL_SPROUT_SHOTS'] ?? join(homedir(), '.cache', 'thirdlight-sprout-shots');
const TOKEN_FILE = process.env['TL_TOKEN_FILE'] ?? join(homedir(), 'thirdlight', 'owner-token');
const EXPORTS = process.env['TL_EXPORT_ROOT'] ?? join(homedir(), 'thirdlight', 'exports');

test('Sprout on the live service: the editor, Play and the export', async ({ page }) => {
  test.skip(LIVE === undefined || !existsSync(TOKEN_FILE), 'needs TL_SPROUT_LIVE and the owner token');
  test.setTimeout(300_000);
  mkdirSync(SHOTS, { recursive: true });
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (process.env['TL_SPROUT_CONSOLE'] !== undefined) page.on('console', (m) => process.stderr.write(`console ${m.type()}: ${m.text().slice(0, 300)}\n`));

  // The editor, with Meadow 2 open and framed.
  await page.goto(`${LIVE}/?project=sprout#token=${token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 30_000 });
  const open = page.getByLabel('open scene', { exact: true });
  if ((await open.count()) > 0 && (await open.locator('option', { hasText: 'Meadow 2' }).count()) > 0) await open.selectOption({ label: 'Meadow 2' });
  await page.waitForTimeout(4000); // models load
  await shot('editor');

  // Play in the backend's headless editor (the active session), over the relay: the title, then Meadow 1.
  const api = async (path: string, body: unknown = {}): Promise<Record<string, unknown>> => {
    const r = await fetch(`${LIVE}/api/v1/projects/sprout/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()) as Record<string, unknown>;
  };
  const play = await api('play', {});
  expect(play['ok'], JSON.stringify(play).slice(0, 300)).toBe(true);
  const psid = String(play['playSessionId']);
  const observe = (): Promise<Record<string, unknown>> => api(`play/${psid}/observe`);
  try {
    await expect.poll(async () => ((await observe())['flow'] as { screen?: string } | undefined)?.screen, { timeout: 90_000 }).toBe('title');
    expect((await api(`play/${psid}/control`, { command: 'start' }))['ok']).toBe(true);
    await expect.poll(async () => ((await observe())['flow'] as { screen?: string }).screen, { timeout: 30_000 }).toBe('playing');
    // The headless editor renders on the CPU here (a few frames per second), so
    // it only has to run Meadow 1 without failing; the export below is looked at.
    await new Promise((r) => setTimeout(r, 8000));
    const obs = await observe();
    expect(obs['failed']).toBe(false);
    expect(((obs['flow'] as { levelId?: string }).levelId)).toBe('meadow-1');
  } finally {
    await api(`play/${psid}/stop`);
  }

  // The export, served statically.
  const res = await fetch(`${LIVE}/api/v1/admin/projects/sprout/export`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  const json = (await res.json()) as Record<string, unknown>;
  expect(res.status, JSON.stringify(json).slice(0, 300)).toBe(200);
  const dir = join(EXPORTS, String(json['outputDir']));
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
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
    const exported = page.locator('.tl-flow');
    await expect(exported).toHaveAttribute('data-screen', 'title', { timeout: 60_000 });
    await page.waitForTimeout(3000);
    await shot('export-title');
    await page.mouse.click(20, 1000);
    await page.keyboard.press('Enter');
    await expect(exported).toHaveAttribute('data-screen', 'playing', { timeout: 15_000 });
    await page.waitForTimeout(2500);
    await shot('export-meadow1-start');
    await page.keyboard.down('d');
    await page.waitForTimeout(2500);
    await shot('export-meadow1-running');
    await page.keyboard.up('d');
    await page.waitForTimeout(800);
    await shot('export-meadow1-stopped');
    await expect(page.getByText(/export error/i)).toHaveCount(0);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
  expect(errors).toEqual([]);
});

/**
 * Opt-in (TL_SPROUT_BAKE=1 as well): the final Blender bake of both Sprout
 * levels on the live service's bake host, from the Lighting window with each
 * level open. It writes lightmaps into the project (new undo steps).
 */
test('Sprout on the live service: final Blender bake of both levels', async ({ page }) => {
  test.skip(LIVE === undefined || process.env['TL_SPROUT_BAKE'] === undefined || !existsSync(TOKEN_FILE), 'needs TL_SPROUT_LIVE, TL_SPROUT_BAKE and the owner token');
  test.setTimeout(3_600_000);
  mkdirSync(SHOTS, { recursive: true });
  const token = readFileSync(TOKEN_FILE, 'utf8').trim();
  await page.goto(`${LIVE}/?project=sprout#token=${token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 30_000 });
  for (const level of ['Meadow 1', 'Meadow 2']) {
    const head = page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: new RegExp(`^${level}$`) }) });
    if ((await head.count()) === 0) await page.getByLabel('open scene', { exact: true }).selectOption({ label: level });
    await head.locator('.tl-scene-header__name').click();
    await expect(head).toContainText('ACTIVE', { ignoreCase: true, timeout: 10_000 });
    await page.waitForTimeout(4000); // models load: the bake package is built from them
    await page.getByRole('tab', { name: 'Lighting' }).click();
    await expect(page.locator('.tl-lighting .tl-panel__title')).toContainText(level);
    const bake = page.getByRole('button', { name: 'Bake final (Blender)' });
    await expect(bake).toBeEnabled();
    const started = Date.now();
    await bake.click();
    const status = page.locator('[aria-label="bake status"]');
    for (let i = 0; !((await status.textContent()) ?? '').includes('Final (Blender) bake'); i++) {
      if (i > 340) throw new Error(`bake did not finish: ${await page.locator('.tl-lighting').textContent()}`);
      if (i % 6 === 0) process.stderr.write(`[bake ${level}] ${Math.round((Date.now() - started) / 1000)} s: ${((await page.locator('.tl-lighting').textContent()) ?? '').slice(-200)} | ${((await page.getByRole('status').first().textContent()) ?? '').slice(0, 200)}\n`);
      await page.waitForTimeout(5000);
    }
    await expect(bake).toBeEnabled({ timeout: 60_000 });
    process.stderr.write(`Sprout bake ${level}: ${((Date.now() - started) / 1000).toFixed(1)} s — ${await page.locator('[aria-label="bake status"]').textContent()} — ${await page.getByRole('status').first().textContent()}\n`);
    await page.screenshot({ path: join(SHOTS, `bake-${level.replace(' ', '-').toLowerCase()}.png`) });
  }
});
