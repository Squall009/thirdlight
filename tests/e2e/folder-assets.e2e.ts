/**
 * Assets referenced in place in a game folder (phase 10, option B), against
 * the real backend and Chromium, with the game folder outside the data root:
 * import a .glb from the project folder in the picker, place it, reload,
 * restart, Play, export and run the export with the backend stopped; then
 * rebuild the file, see it in Problems, re-import, and Play/export use the new
 * bytes. The MCP server does the same import from inside the game folder.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { colorCount, decodePng } from './png';

const REPO = resolve(import.meta.dirname, '..', '..');
const GLB_V1 = join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v1.glb');
const GLB_V2 = join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v2.glb');
const SHOTS = join(REPO, 'test-results', 'folder-assets');
const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const D1 = sha(GLB_V1);
const D2 = sha(GLB_V2);

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

/** A plain static file server: the exported game gets nothing else. */
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

const status = (page: Page) => page.locator('.tl-statusbar');
const rows = (page: Page) => page.locator('.tl-hierarchy__list li');

/** Start Play, check the asset bytes with this digest were delivered, and that something renders. */
async function playShows(page: Page, digest: string, shot: string): Promise<void> {
  const delivered: string[] = [];
  const onResponse = (r: { url: () => string; status: () => number }): void => {
    if (r.url().includes(digest) && r.status() === 200) delivered.push(r.url());
  };
  page.on('response', onResponse);
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expect.poll(() => delivered.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(async () => colorCount(decodePng(await frame.screenshot())), { timeout: 15_000 }).toBeGreaterThan(1);
  await page.waitForTimeout(500);
  await frame.screenshot({ path: join(SHOTS, shot) });
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  page.off('response', onResponse);
  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0);
}

/** Export through the admin route; the export must carry exactly these asset digests. */
async function exportWith(digest: string, absent: string): Promise<string> {
  const res = await be.admin('projects/meadow/export');
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  const content = readdirSync(join(out, 'content', 'sha256'));
  expect(content).toContain(digest);
  expect(content).not.toContain(absent);
  return out;
}

async function runExport(page: Page, out: string, shot: string): Promise<void> {
  const site = await serveDir(out);
  const game = await page.context().newPage();
  const requests: string[] = [];
  game.on('request', (r) => requests.push(r.url()));
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    await expect.poll(async () => colorCount(decodePng(await game.screenshot())), { timeout: 15_000 }).toBeGreaterThan(1);
    await game.waitForTimeout(500);
    await game.screenshot({ path: join(SHOTS, shot) });
    expect(errors).toEqual([]);
    expect(requests.every((u) => u.startsWith(site.url))).toBe(true);
  } finally {
    await game.close();
    await site.close();
  }
}

test('import a .glb from the project folder, place, reload, restart, Play, export; rebuild → Problems → re-import', async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(SHOTS, { recursive: true });
  const meadow = join(games, 'meadow');
  const made = await be.admin('projects', { projectId: 'meadow', name: 'Meadow', folder: meadow });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  const file = join(meadow, 'assets', 'props', 'crate.glb');
  mkdirSync(join(meadow, 'assets', 'props'), { recursive: true });
  copyFileSync(GLB_V1, file);
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(`${be.origin}/?project=meadow#token=${be.token}`);
  await expect(status(page)).toContainText('connected');
  const before = await rows(page).count();

  // Import from the project folder: browse assets/props, pick crate.glb.
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.getByRole('button', { name: 'from project folder…' }).click();
  const picker = page.getByRole('dialog', { name: 'Import from project folder' });
  await expect(picker).toBeVisible();
  await picker.getByRole('button', { name: 'props/' }).click();
  await picker.getByRole('button', { name: /^crate\.glb/ }).click();
  await expect(picker).toHaveCount(0);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li').filter({ hasText: 'crate' });
  await expect(tile).toHaveCount(1, { timeout: 10_000 });
  await expect(tile).toContainText('v1');
  await tile.click();
  await expect(page.locator('.tl-assets__source')).toHaveText('file: assets/props/crate.glb');
  // Referenced in place: recorded with its path, nothing copied into the project.
  const envelope = (): string => readFileSync(join(meadow, 'thirdlight', 'scenes', 'main.json'), 'utf8');
  await expect.poll(envelope).toContain('"sourcePath": "assets/props/crate.glb"');
  const blobs = join(meadow, 'thirdlight', 'sources', 'sha256');
  expect(existsSync(blobs) ? readdirSync(blobs) : []).toEqual([]);

  // Place it; it survives a reload and a backend restart.
  await tile.click();
  await page.getByRole('button', { name: 'place' }).click();
  await page.getByRole('tab', { name: 'Scene' }).click();
  await expect(rows(page)).toHaveCount(before + 1);
  await expect(rows(page).filter({ hasText: 'crate' })).toHaveCount(1);
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page).filter({ hasText: 'crate' })).toHaveCount(1);
  await be.restart();
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page).filter({ hasText: 'crate' })).toHaveCount(1);
  await page.getByRole('tab', { name: 'Assets' }).click();
  await tile.click();
  await expect(page.locator('.tl-assets__source')).toBeVisible();
  await expect(page.locator('.tl-assets__source')).toHaveText('file: assets/props/crate.glb');
  await page.screenshot({ path: join(SHOTS, '1-editor-v1.png') });
  await page.getByRole('tab', { name: 'Scene' }).click();

  // Play renders it from the game-folder bytes.
  await playShows(page, D1, '2-play-v1.png');

  // Export, then run the export with the backend stopped.
  const out1 = await exportWith(D1, D2);
  await be.halt();
  await runExport(page, out1, '3-export-v1.png');
  await be.restart();
  await page.reload();
  await expect(status(page)).toContainText('connected');

  // Rebuild the file (other bytes at the same path).
  copyFileSync(GLB_V2, file);
  // Export and Play refuse the changed file and name it.
  const refused = await be.admin('projects/meadow/export');
  expect(refused.status).not.toBe(200);
  expect(JSON.stringify(refused.json)).toContain('assets/props/crate.glb');
  expect(refused.json.error).toMatchObject({ reason: 'asset_source_changed' });

  // Problems shows it: the check runs when the editor opens (a reload here,
  // with the model's bytes now unreadable, must not break the page) …
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page).filter({ hasText: 'crate' })).toHaveCount(1);
  await page.getByRole('tab', { name: /Problems/ }).click();
  const files = page.getByRole('list', { name: 'Asset files' });
  await expect(files).toContainText('crate: assets/props/crate.glb has changed since v1 was imported');
  // … and again on demand.
  await page.getByRole('button', { name: 'check files' }).click();
  await expect(page.getByRole('button', { name: 'check files' })).toBeEnabled();
  await expect(files).toContainText('has changed since v1 was imported');
  await page.screenshot({ path: join(SHOTS, '4-problems-changed.png') });

  // Re-import: a new version with the new digest (undoable), old version flagged.
  await files.getByRole('button', { name: 'Re-import' }).click();
  await expect(files).toContainText('older version v1 can no longer be read');
  await expect(files).not.toContainText('has changed since');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await expect(tile).toContainText('v2');
  await page.getByRole('tab', { name: 'Scene' }).click();

  // Play and export now use the new bytes.
  await playShows(page, D2, '5-play-v2.png');
  const out2 = await exportWith(D2, D1);
  await page.goto('about:blank');
  await be.halt();
  await runExport(page, out2, '6-export-v2.png');
  expect(pageErrors).toEqual([]);
});

test('MCP imports a file from the game folder in place (no THIRDLIGHT_PROJECT_ID)', async () => {
  const reach = join(games, 'reach');
  const made = await be.admin('projects', { projectId: 'reach', name: 'Reach', folder: reach });
  expect(made.status, JSON.stringify(made.json)).toBe(201);
  mkdirSync(join(reach, 'assets', 'props'), { recursive: true });
  mkdirSync(join(reach, 'src'), { recursive: true });
  const file = join(reach, 'assets', 'props', 'crate.glb');
  copyFileSync(GLB_V1, file);

  const env: Record<string, string> = { ...(process.env as Record<string, string>), THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_MCP_TOKEN: be.token };
  delete env.THIRDLIGHT_PROJECT_ID;
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')], env, cwd: join(reach, 'src'), stderr: 'ignore' }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
  };
  const importedAt = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const publish = async (mode: 'create' | 'reimport') => {
    const up = await call('tl_content_upload', { projectPath: 'assets/props/crate.glb', kind: 'model' });
    expect(up.isError, JSON.stringify(up.body)).toBe(false);
    expect(up.body.sourcePath).toBe('assets/props/crate.glb');
    const p = up.body.proposal as Record<string, unknown>;
    const project = await call('tl_inspect', { target: 'project' });
    return call('tl_command', {
      op: 'publishAsset',
      expectedRevision: project.body.revision,
      args: {
        mode,
        assetId: 'crate',
        ...(mode === 'create' ? { kind: 'model', displayName: 'Crate' } : {}),
        sourceDigest: p.sourceDigest,
        sourceByteLength: p.sourceByteLength,
        sourcePath: up.body.sourcePath,
        importRecipe: p.importRecipe,
        metrics: p.metrics,
        importedAt: importedAt(),
      },
    });
  };
  try {
    const listed = await call('tl_content_query', { target: 'projectFiles', dir: 'assets/props' });
    expect(listed.isError, JSON.stringify(listed.body)).toBe(false);
    expect(listed.body.entries).toEqual([{ name: 'crate.glb', path: 'assets/props/crate.glb', kind: 'model', byteLength: statSync(file).size }]);

    const escape = await call('tl_content_upload', { projectPath: '../outside.glb' });
    expect(escape.isError).toBe(true);
    expect(JSON.stringify(escape.body)).toContain('path_rejected');

    const created = await publish('create');
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    const ok = await call('tl_content_query', { target: 'integrity' });
    expect(ok.body.entries).toEqual([{ assetId: 'crate', version: 1, sourceDigest: D1, referenced: true, sourcePath: 'assets/props/crate.glb', status: 'ok' }]);
    const blobs = join(reach, 'thirdlight', 'sources', 'sha256');
    expect(existsSync(blobs) ? readdirSync(blobs) : []).toEqual([]);

    copyFileSync(GLB_V2, file);
    const changed = await call('tl_content_query', { target: 'integrity' });
    expect((changed.body.entries as Array<{ status: string }>)[0]!.status).toBe('changed');
    const re = await publish('reimport');
    expect(re.isError, JSON.stringify(re.body)).toBe(false);
    const after = await call('tl_content_query', { target: 'integrity' });
    expect((after.body.entries as Array<{ version: number; status: string }>).map((e) => [e.version, e.status])).toEqual([
      [1, 'changed'],
      [2, 'ok'],
    ]);
    const asset = await call('tl_content_query', { target: 'asset', assetId: 'crate' });
    expect(JSON.stringify(asset.body)).toContain(D2);
  } finally {
    await mcp.close();
  }
});
