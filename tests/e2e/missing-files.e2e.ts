/**
 * Missing asset files, against the real backend and Chromium, on a project
 * generated through the API (two scenes; the later one has its own model and
 * a wall whose unlit material is a solid green texture):
 *
 * - files removed and moved outside the editor are listed at open over HTTP
 *   and in the editor's Problems tab (path, asset, what uses them; the list
 *   pages with "Show more");
 * - Play starts: the missing files are not drawn by the start scene, so each
 *   is stood in for by a placeholder, listed in the start result; when the
 *   later scene loads, its model is drawn as a box and its wall shows the
 *   magenta checker instead of green;
 * - once a file the start scene draws is missing too, Play refuses, naming
 *   every missing file in one refusal, and the Problems log says why.
 */
import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './pw';

import { PERF_ROOT, startPerfBackend, type PerfBackend } from '../../tools/perf/backend';
import { sphereGlb } from '../../tools/perf/assets';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { openWindow } from './ui';

let be: PerfBackend;
let root: string;
test.beforeEach(async () => {
  root = join(PERF_ROOT, 'e2e', `missing-files-${process.pid}-${Date.now()}`);
  be = await startPerfBackend(join(root, 'data'), join(root, 'exports'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(root, { recursive: true, force: true });
});

const ID = 'holes';

function counts(img: Image): { green: number; magenta: number } {
  let green = 0;
  let magenta = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (g > 120 && g > 2 * r && g > 2 * b) green += 1;
      if (r > 120 && b > 120 && g < r / 2 && g < b / 2) magenta += 1;
    }
  }
  return { green, magenta };
}

test('missing files are listed at open and in Problems; Play stands placeholders in outside the start and refuses naming all of them', async ({ page }) => {
  test.setTimeout(300_000);
  const created = await be.post('/api/v1/admin/projects', { projectId: ID, name: 'Missing files' });
  expect([200, 201]).toContain(created.status);
  const p = be.project(ID);
  const dir = join(root, 'data', 'projects', ID);
  const put = (rel: string, bytes: Uint8Array): void => {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), bytes);
  };
  put('assets/start/model-start.glb', sphereGlb(1, 16, 32));
  put('assets/later/model-later.glb', sphereGlb(2, 16, 32));
  put('assets/later/tex-green.png', makePng(32, 32, () => [30, 220, 40, 255]));
  // Many small textures nothing uses: the Problems list pages.
  const bulk = 60;
  for (let i = 0; i < bulk; i += 1) put(`assets/bulk/bulk-${String(i).padStart(3, '0')}.png`, makePng(4, 4, () => [i, 10, 10, 255]));
  // The models keep their images inside (extract textures off): each is one file the spec takes away.
  await p.command('importAssets', { folder: 'assets/start', extractTextures: false });
  await p.command('importAssets', { folder: 'assets/later', extractTextures: false });
  await p.command('importAssets', { folder: 'assets/bulk', extractTextures: false });
  await p.command('setMaterial', { material: { materialId: 'mat-green', name: 'Green', shader: 'unlit', params: {}, textures: { map: 'tex-green' } } });
  await p.command('createScene', { sceneId: 'scene-later', name: 'Later' });
  await p.command('setTransform', { entityId: 'cam-main', transform: { position: [0, 0, 10] } });
  await p.command('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Start prop', transform: { position: [40, 0, 0] }, model: { asset: { assetId: 'model-start' } } });
  await p.command('createEntity', { sceneId: 'scene-later', kind: 'model', name: 'Later prop', transform: { position: [-3, 0, 2] }, model: { asset: { assetId: 'model-later' } } });
  await p.command('createEntity', { sceneId: 'scene-later', kind: 'box', name: 'Green wall', transform: { position: [0, 0, 0] }, box: { size: [40, 40, 1], material: { color: '#ffffff' } }, components: { materials: { '*': 'mat-green' } } });

  // Outside the editor: the later scene's model deleted, its texture moved without its .tlasset file, the bulk files deleted.
  unlinkSync(join(dir, 'assets', 'later', 'model-later.glb'));
  mkdirSync(join(dir, 'moved'), { recursive: true });
  renameSync(join(dir, 'assets', 'later', 'tex-green.png'), join(dir, 'moved', 'tex-green.png'));
  rmSync(join(dir, 'assets', 'bulk'), { recursive: true, force: true });

  // At open, over HTTP: every missing file, with what uses it.
  type Missing = { assetId: string; path: string; usedBy: { kind: string; id: string }[] };
  const listed = await be.get(`/api/v1/projects/${ID}/problems`);
  expect(listed.status).toBe(200);
  const atOpen = (JSON.parse(listed.body.toString('utf8')) as { missingFiles: { total: number; files: Missing[] } }).missingFiles;
  expect(atOpen.total).toBe(bulk + 2);
  expect(atOpen.files).toHaveLength(50);
  // Every page, read with the missing-files route.
  const all: Missing[] = [];
  while (all.length < atOpen.total) {
    const page = await be.get(`/api/v1/projects/${ID}/problems/missing-files?offset=${all.length}&limit=20`);
    expect(page.status).toBe(200);
    const files = (JSON.parse(page.body.toString('utf8')) as { files: Missing[] }).files;
    expect(files.length).toBeGreaterThan(0);
    all.push(...files);
  }
  expect(new Set(all.map((f) => f.assetId)).size).toBe(bulk + 2);
  expect(all.find((f) => f.assetId === 'model-later')).toMatchObject({ path: 'assets/later/model-later.glb', usedBy: [{ kind: 'scene', id: 'scene-later' }] });
  expect(all.find((f) => f.assetId === 'tex-green')).toMatchObject({ path: 'assets/later/tex-green.png', usedBy: [{ kind: 'scene', id: 'scene-later' }, { kind: 'material', id: 'mat-green' }] });

  // The editor's Problems tab: the same list, a page at a time.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${e.message} ${e.stack ?? ''}`.slice(0, 400)));
  await page.goto(`${be.origin}/?project=${ID}#token=${be.token}`);
  await expect(page.locator('.tl-statusbar')).toContainText('connected', { timeout: 60_000 });
  await openWindow(page, 'Problems');
  const missing = page.getByRole('list', { name: 'Missing files' });
  await expect(missing).toContainText(`${bulk + 2} asset files are missing`, { timeout: 30_000 });
  const row = (assetId: string) => missing.locator(`li[data-asset="${assetId}"]`);
  // The first page (by path: the bulk files first), then the rest on request.
  await expect(missing.locator('li[data-asset]')).toHaveCount(50);
  await expect(row('model-later')).toHaveCount(0);
  await missing.getByRole('button', { name: /Show more \(12 more\)/ }).click();
  await expect(missing.locator('li[data-asset]')).toHaveCount(bulk + 2);
  await expect(missing.getByRole('button', { name: /Show more/ })).toHaveCount(0);
  await expect(row('model-later')).toContainText('assets/later/model-later.glb');
  await expect(row('model-later')).toContainText('used by scene scene-later');
  await expect(row('tex-green')).toContainText('used by scene scene-later, material mat-green');
  await expect(row('bulk-000')).toContainText('nothing uses it');
  await page.locator('.tl-panel.tl-problems').screenshot({ path: join('test-results', 'missing-files', '1-problems.png') });

  // Play: nothing the start scene draws is missing; it starts, a placeholder for each missing file it ships
  // (the bulk files are not in the build: nothing uses them).
  const startPlay = async () => {
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    return started;
  };
  const response = await startPlay();
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { playSessionId: string; placeholders: { assetId: string; inStart: boolean }[] };
  expect(body.placeholders.map((f) => [f.assetId, f.inStart])).toEqual([
    ['model-later', false],
    ['tex-green', false],
  ]);
  const psid = body.playSessionId;
  const relay = (path: string, payload: unknown = {}) => be.post(`/api/v1/projects/${ID}/play/${path}`, payload);
  type Diag = { diagnostics?: { renderer?: { models?: { instances: number; failed?: number } } } };
  const diag = async (): Promise<NonNullable<Diag['diagnostics']>> => ((await relay(`${psid}/diagnostics`)).json as Diag).diagnostics ?? {};
  await expect.poll(async () => (await diag()).renderer?.models?.instances, { timeout: 60_000 }).toBe(1);
  const shot = async (): Promise<Image> => {
    const r = await relay(`${psid}/screenshot`, { maxWidth: 256 });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    return decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  };
  expect(counts(await shot()).magenta).toBe(0);

  // The later scene loads: its missing model is a box, its wall the magenta checker, never green.
  const asked = await relay(`${psid}/control`, { command: 'loadScene', sceneId: 'scene-later' });
  expect(asked.status, JSON.stringify(asked.json)).toBe(200);
  await expect.poll(async () => (await diag()).renderer?.models?.instances, { timeout: 60_000 }).toBe(2);
  await expect.poll(async () => counts(await shot()).magenta, { timeout: 30_000 }).toBeGreaterThan(500);
  const after = await shot();
  writeFileSync(join('test-results', 'missing-files', '2-play-later-scene.png'), Buffer.from(String((await relay(`${psid}/screenshot`, { maxWidth: 512 })).json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  expect(counts(after).green).toBe(0);
  expect((await diag()).renderer?.models?.failed ?? 0).toBe(0);
  await page.getByTitle('Stop the play preview').click();
  await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0, { timeout: 30_000 });

  // The start scene's model goes missing too: "check files" lists it, and Play refuses naming every missing file.
  unlinkSync(join(dir, 'assets', 'start', 'model-start.glb'));
  await page.getByRole('button', { name: 'check files' }).click();
  await expect(missing).toContainText(`${bulk + 3} asset files are missing`, { timeout: 30_000 });
  await missing.getByRole('button', { name: /Show more \(13 more\)/ }).click();
  await expect(row('model-start')).toContainText('used by scene scene-main');
  expect(errors).toEqual([]);
  const refused = await startPlay();
  expect(refused.status()).toBeGreaterThanOrEqual(400);
  const err = ((await refused.json()) as { error: { code: string; message: string; missingFiles: { assetId: string; inStart: boolean }[] } }).error;
  expect(err.code).toBe('asset_source_missing');
  expect(err.message).toContain('3 asset files are missing (1 drawn by the start scenes)');
  expect(err.missingFiles.map((f) => [f.assetId, f.inStart])).toEqual([
    ['model-later', false],
    ['model-start', true],
    ['tex-green', false],
  ]);
  // The editor says why, and the Problems log keeps it.
  await expect(page.getByText('Play refused: 3 asset files are missing (1 drawn by the start scenes)')).toBeVisible();
  await expect(page.locator('.tl-problems')).toContainText('Play build failed: 3 asset files are missing', { timeout: 15_000 });
  expect(errors).toEqual([]);
});
