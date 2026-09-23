/**
 * FBX import end to end: the real backend converts with headless Blender.
 * An FBX in the game folder (texture next to it) is imported through the
 * picker, placed, played and exported (the export runs with the backend
 * stopped); the FBX is rebuilt, Problems offers re-import, the new version
 * plays. An uploaded FBX (embedded texture) goes through MCP. Screenshots:
 * test-results/import-fbx/.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, litBands, type Image } from './png';

const REPO = resolve(import.meta.dirname, '..', '..');
const FBX = join(REPO, 'fixtures', 'import-ext', 'fbx');
const SHOTS = join(REPO, 'test-results', 'import-fbx');
const haveBlender = spawnSync(process.env.THIRDLIGHT_BLENDER ?? 'blender', ['--version']).status === 0;

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

/** Mean colour of the lit pixels in the central region: red cube vs blue cube. */
function dominant(img: Image): 'red' | 'blue' | 'none' {
  let r = 0;
  let b = 0;
  for (let y = Math.floor(img.height / 4); y < (img.height * 3) / 4; y += 3) {
    for (let x = Math.floor(img.width / 4); x < (img.width * 3) / 4; x += 3) {
      const [pr, , pb] = img.pixel(x, y);
      if (pr > pb + 30) r += 1;
      else if (pb > pr + 30) b += 1;
    }
  }
  return r === 0 && b === 0 ? 'none' : r > b ? 'red' : 'blue';
}

const status = (page: Page) => page.locator('.tl-statusbar');

test.skip(!haveBlender, 'needs Blender on the backend host (THIRDLIGHT_BLENDER)');

test('an FBX in the game folder is converted, placed, played, exported; rebuilt → Problems → re-import', async ({ page }) => {
  test.setTimeout(300_000);
  mkdirSync(SHOTS, { recursive: true });
  const game = join(games, 'game');
  expect((await be.admin('projects', { projectId: 'game', name: 'FBX', folder: game })).status).toBe(201);
  const assets = join(game, 'assets', 'props');
  mkdirSync(assets, { recursive: true });
  copyFileSync(join(FBX, 'crate.fbx'), join(assets, 'crate.fbx'));
  copyFileSync(join(FBX, 'crate_checker.png'), join(assets, 'crate_checker.png'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(`${be.origin}/?project=game#token=${be.token}`);
  await expect(status(page)).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.getByRole('button', { name: 'from project folder…' }).click();
  const picker = page.getByRole('dialog', { name: 'Import from project folder' });
  await picker.getByRole('button', { name: 'props/' }).click();
  await expect(picker.getByRole('button', { name: /crate_checker\.png/ })).toHaveCount(0); // only importable files
  await picker.getByRole('button', { name: /^crate\.fbx/ }).click();
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 120_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li').filter({ hasText: 'crate' });
  await expect(tile).toHaveCount(1, { timeout: 10_000 });
  await tile.click();
  await expect(page.locator('.tl-assets__source')).toHaveText('from FBX: assets/props/crate.fbx');
  // The converted GLB is stored with the project; the FBX stays in the folder.
  const blobs = readdirSync(join(game, 'thirdlight', 'sources', 'sha256'));
  expect(blobs).toHaveLength(1);
  expect(readFileSync(join(game, 'thirdlight', 'sources', 'sha256', blobs[0]!)).subarray(0, 4).toString()).toBe('glTF');
  await page.getByRole('button', { name: 'place' }).click();
  await page.getByRole('tab', { name: 'Scene' }).click();
  await expect(page.locator('.tl-hierarchy__list li').filter({ hasText: 'crate' })).toHaveCount(1);
  await page.waitForTimeout(1000);
  await page.locator('.tl-app__stage').screenshot({ path: join(SHOTS, '1-editor.png') });

  const play = async (shot: string): Promise<'red' | 'blue' | 'none'> => {
    await page.getByTitle('Start an isolated play preview').click();
    const frame = page.locator('iframe.tl-app__preview-frame');
    await expect(frame).toBeVisible();
    await expect.poll(async () => litBands(decodePng(await frame.screenshot()), 1), { timeout: 20_000 }).toBe(1);
    await page.waitForTimeout(800);
    const png = await frame.screenshot({ path: join(SHOTS, shot) });
    await page.getByTitle('Stop the play preview').click();
    return dominant(decodePng(png));
  };
  expect(await play('2-play-red.png')).toBe('red');

  const exported = await be.admin('projects/game/export');
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
  const out = join(be.exportRoot, String(exported.json.outputDir));

  // Rebuild the FBX (a blue checker): Problems says so and re-imports it.
  copyFileSync(join(FBX, 'crate-blue.fbx'), join(assets, 'crate.fbx'));
  copyFileSync(join(FBX, 'crate_checker_blue.png'), join(assets, 'crate_checker_blue.png'));
  await page.getByRole('tab', { name: /Problems/ }).click();
  await page.getByRole('button', { name: 'check files' }).click();
  const files = page.getByRole('list', { name: 'Asset files' });
  await expect(files).toContainText('crate: assets/props/crate.fbx has changed since v1 was converted');
  await page.screenshot({ path: join(SHOTS, '3-problems.png') });
  // Until then Play still uses the stored conversion.
  expect(await play('4-play-before-reimport.png')).toBe('red');
  await files.getByRole('button', { name: 'Re-import' }).click();
  await expect(files).toHaveCount(0, { timeout: 120_000 });
  await page.getByRole('tab', { name: 'Assets' }).click();
  await expect(tile).toContainText('v2');
  expect(await play('5-play-blue.png')).toBe('blue');
  expect(errors).toEqual([]);

  // The first export still runs on its own (backend stopped).
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const game2 = await page.context().newPage();
  try {
    await game2.goto(site.url);
    await expect.poll(async () => litBands(decodePng(await game2.screenshot()), 1), { timeout: 20_000 }).toBe(1);
    await game2.waitForTimeout(800);
    expect(dominant(decodePng(await game2.screenshot({ path: join(SHOTS, '6-export-red.png') })))).toBe('red');
  } finally {
    await site.close();
  }
});

test('MCP: an uploaded FBX (embedded texture) and a game-folder FBX import through the same tools', async () => {
  test.setTimeout(300_000);
  const game = join(games, 'game');
  expect((await be.admin('projects', { projectId: 'game', name: 'FBX', folder: game })).status).toBe(201);
  mkdirSync(join(game, 'assets'), { recursive: true });
  copyFileSync(join(FBX, 'crate.fbx'), join(game, 'assets', 'crate.fbx'));
  copyFileSync(join(FBX, 'crate_checker.png'), join(game, 'assets', 'crate_checker.png'));
  const env: Record<string, string> = { ...(process.env as Record<string, string>), THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_MCP_TOKEN: be.token };
  delete env.THIRDLIGHT_PROJECT_ID;
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(new StdioClientTransport({ command: process.execPath, args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')], env, cwd: game, stderr: 'ignore' }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
  };
  const publish = async (up: { body: Record<string, unknown> }, assetId: string) => {
    const p = up.body.proposal as Record<string, unknown>;
    const project = await call('tl_inspect', { target: 'project' });
    return call('tl_command', {
      op: 'publishAsset',
      expectedRevision: project.body.revision,
      args: {
        mode: 'create',
        assetId,
        kind: 'model',
        sourceDigest: p.sourceDigest,
        sourceByteLength: p.sourceByteLength,
        convertedFrom: up.body.convertedFrom,
        importRecipe: p.importRecipe,
        metrics: p.metrics,
        importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      },
    });
  };
  try {
    const uploaded = await call('tl_content_upload', { dataBase64: readFileSync(join(FBX, 'crate-embedded.fbx')).toString('base64'), displayName: 'Uploaded crate' });
    expect(uploaded.isError, JSON.stringify(uploaded.body)).toBe(false);
    expect(uploaded.body.convertedFrom).toMatchObject({ format: 'fbx', converter: { name: 'blender' } });
    expect((uploaded.body.convertedFrom as { sourcePath?: string }).sourcePath).toBeUndefined();
    expect((await publish(uploaded, 'uploaded-crate')).isError).toBe(false);

    const folder = await call('tl_content_upload', { projectPath: 'assets/crate.fbx' });
    expect(folder.isError, JSON.stringify(folder.body)).toBe(false);
    expect(folder.body.convertedFrom).toMatchObject({ format: 'fbx', sourcePath: 'assets/crate.fbx' });
    expect((await publish(folder, 'folder-crate')).isError).toBe(false);

    const integrity = await call('tl_content_query', { target: 'integrity' });
    const entries = integrity.body.entries as Array<{ assetId: string; status: string; convertedFrom?: { sourcePath?: string; status: string } }>;
    expect(entries.map((e) => [e.assetId, e.status, e.convertedFrom?.sourcePath ?? null, e.convertedFrom?.status])).toEqual([
      ['folder-crate', 'ok', 'assets/crate.fbx', 'ok'],
      ['uploaded-crate', 'ok', null, 'ok'],
    ]);
  } finally {
    await mcp.close();
  }
});
