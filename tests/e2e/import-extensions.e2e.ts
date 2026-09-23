/**
 * glTF extensions beyond the core profile, end to end with the real backend
 * and Chromium: GLBs from fixtures/import-ext (a Blender WebP export, every
 * no-decoder material extension, unlit + quantized) are imported from the
 * game folder (the first through the picker UI, the rest through the same
 * routes), placed side by side, rendered in Play and in the export served with
 * the backend stopped. Screenshots land in test-results/import-extensions/.
 */
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { colorCount, decodePng, litBands } from './png';

const REPO = resolve(import.meta.dirname, '..', '..');
const FIXTURES = join(REPO, 'fixtures', 'import-ext');
const SHOTS = join(REPO, 'test-results', 'import-extensions');

let be: E2EBackend;
let games: string;
test.beforeEach(async () => {
  be = await startBackend('home-0001');
  games = mkdtempSync(join(tmpdir(), 'tl-e2e-games-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(games, { recursive: true, force: true });
});

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

let seq = 0;
async function api(path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${be.origin}/api/v1/projects/game${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return (await r.json()) as Record<string, unknown>;
}
async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await api('/commands', { op: 'queryEntities', projectId: 'game', args: { limit: 1, offset: 0 } });
  seq += 1;
  return api('/commands', { op, projectId: 'game', expectedRevision: q.revision, requestId: `req-${seq.toString(16).padStart(32, '0')}`, args });
}
/** The import-from-project-folder routes, then publishAsset (what the picker does). */
async function importFromFolder(path: string, assetId: string): Promise<void> {
  const inspected = await api('/content/project-files/inspect', { path, kind: 'model' });
  expect(inspected.ok, JSON.stringify(inspected)).toBe(true);
  const p = inspected.proposal as Record<string, unknown>;
  const res = await command('publishAsset', {
    mode: 'create',
    assetId,
    kind: 'model',
    displayName: assetId,
    sourceDigest: p.sourceDigest,
    sourceByteLength: p.sourceByteLength,
    sourcePath: inspected.sourcePath,
    importRecipe: p.importRecipe,
    metrics: p.metrics,
    importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
}
async function place(assetId: string, x: number, name = assetId): Promise<void> {
  const res = await command('createEntity', { kind: 'model', name, model: { asset: { assetId } }, transform: { position: [x, 0, 0] } });
  expect(res.ok, JSON.stringify(res)).toBe(true);
}

const status = (page: Page) => page.locator('.tl-statusbar');

test('WebP, material extensions, unlit and quantized GLBs import, render in Play and in the export', async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const game = join(games, 'game');
  const made = await be.admin('projects', { projectId: 'game', name: 'Extensions', folder: game });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  mkdirSync(join(game, 'assets'), { recursive: true });
  for (const f of ['webp-cube.glb', 'materials-all.glb', 'unlit-quantized.glb']) copyFileSync(join(FIXTURES, f), join(game, 'assets', f));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });

  // The WebP export (what the Blender pipeline writes) through the picker UI.
  await page.goto(`${be.origin}/?project=game#token=${be.token}`);
  await expect(status(page)).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.getByRole('button', { name: 'from project folder…' }).click();
  const picker = page.getByRole('dialog', { name: 'Import from project folder' });
  await picker.getByRole('button', { name: /^webp-cube\.glb/ }).click();
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li').filter({ hasText: 'webp-cube' })).toHaveCount(1, { timeout: 10_000 });
  const listed = (await api('/commands', { op: 'queryAssets', projectId: 'game', args: { limit: 10, offset: 0 } })) as { assets: Array<{ assetId: string }> };
  const webpId = listed.assets[0]!.assetId;

  await importFromFolder('assets/materials-all.glb', 'materials-all');
  await importFromFolder('assets/unlit-quantized.glb', 'unlit-quantized');
  await place(webpId, -1.5, 'webp-cube');
  await place('materials-all', 0);
  await place('unlit-quantized', 1.5);
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await expect(page.locator('.tl-hierarchy__list li').filter({ hasText: /webp-cube|materials-all|unlit-quantized/ })).toHaveCount(3);
  await page.waitForTimeout(1500);
  await page.locator('.tl-app__stage').screenshot({ path: join(SHOTS, '1-editor.png') });

  // The editor viewport realized all three (no visual load failure).
  await page.getByRole('tab', { name: /Problems/ }).click();
  await expect(page.getByRole('list', { name: 'Scene view' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Scene' }).click();

  // Play.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expect.poll(async () => litBands(decodePng(await frame.screenshot())), { timeout: 15_000 }).toBe(3);
  expect(colorCount(decodePng(await frame.screenshot()))).toBeGreaterThan(8);
  await page.waitForTimeout(1000);
  await frame.screenshot({ path: join(SHOTS, '2-play.png') });
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // Export, then run it with the backend stopped.
  const res = await be.admin('projects/game/export');
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  expect(readdirSync(join(out, 'content', 'sha256'))).toHaveLength(3);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const exportErrors: string[] = [];
  exported.on('pageerror', (e) => exportErrors.push(e.message));
  try {
    await exported.goto(site.url);
    await expect.poll(async () => litBands(decodePng(await exported.screenshot())), { timeout: 15_000 }).toBe(3);
    await exported.waitForTimeout(1000);
    await exported.screenshot({ path: join(SHOTS, '3-export.png') });
    expect(exportErrors).toEqual([]);
  } finally {
    await site.close();
  }
  expect(errors).toEqual([]);
  // No blocked texture fetch or loader error in the editor or the Play frame.
  expect(consoleErrors).toEqual([]);
});

test('Draco (Blender), meshopt (animated) and KTX2/Basis GLBs render in the editor, Play and the export', async ({ page }) => {
  test.setTimeout(180_000);
  mkdirSync(SHOTS, { recursive: true });
  const game = join(games, 'game');
  const made = await be.admin('projects', { projectId: 'game', name: 'Compressed', folder: game });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  mkdirSync(join(game, 'assets'), { recursive: true });
  const cubes = ['draco-cube', 'meshopt-cube', 'ktx2-cube'];
  for (const c of cubes) copyFileSync(join(FIXTURES, `${c}.glb`), join(game, 'assets', `${c}.glb`));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });

  for (const [i, c] of cubes.entries()) {
    await importFromFolder(`assets/${c}.glb`, c);
    await place(c, (i - 1) * 1.5);
  }
  await page.goto(`${be.origin}/?project=game#token=${be.token}`);
  await expect(status(page)).toContainText('connected');
  await expect(page.locator('.tl-hierarchy__list li').filter({ hasText: /-cube/ })).toHaveCount(3);
  await page.waitForTimeout(2000);
  await page.locator('.tl-app__stage').screenshot({ path: join(SHOTS, '4-compressed-editor.png') });
  await page.getByRole('tab', { name: /Problems/ }).click();
  await expect(page.getByRole('list', { name: 'Scene view' })).toHaveCount(0);

  // Play: the decoders come from the preview origin's /decoders/.
  const decoderHits: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/decoders/') && r.status() === 200) decoderHits.push(r.url());
  });
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  // All three cubes (left, centre, right) are drawn.
  await expect.poll(async () => litBands(decodePng(await frame.screenshot())), { timeout: 20_000 }).toBe(3);
  await page.waitForTimeout(1500);
  await frame.screenshot({ path: join(SHOTS, '5-compressed-play.png') });
  expect(decoderHits.some((u) => u.includes('/decoders/draco/'))).toBe(true);
  expect(decoderHits.some((u) => u.includes('/decoders/basis/'))).toBe(true);
  await page.getByTitle('Stop the play preview').click();

  // Export ships exactly the decoders its models need, then runs alone.
  const res = await be.admin('projects/game/export');
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  expect(readdirSync(join(out, 'decoders')).sort()).toEqual(['basis', 'draco']);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const exportErrors: string[] = [];
  exported.on('pageerror', (e) => exportErrors.push(e.message));
  exported.on('console', (m) => {
    if (m.type() === 'error') exportErrors.push(m.text().slice(0, 300));
  });
  try {
    await exported.goto(site.url);
    await expect.poll(async () => litBands(decodePng(await exported.screenshot())), { timeout: 20_000 }).toBe(3);
    await exported.waitForTimeout(1500);
    await exported.screenshot({ path: join(SHOTS, '6-compressed-export.png') });
    expect(exportErrors).toEqual([]);
  } finally {
    await site.close();
  }
  expect(errors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
