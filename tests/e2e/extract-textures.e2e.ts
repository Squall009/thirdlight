/**
 * "Extract textures": a model's images become texture assets it draws with,
 * against a real backend in a real browser, per renderer variant
 * (renderer-variants.ts).
 *
 * A quad model drawn unlit carries a 2048² PNG of four coloured quarters
 * (red top left, green top right, blue bottom left, yellow bottom right).
 * It is imported in the Assets tab with the panel's "extract model textures"
 * on (the default): the image becomes a KTX2 texture asset in the project
 * window and the model names it. A twin of the same file imported with the
 * setting off keeps the image inside.
 *
 * - Pixels: the Scene view, Play and the export draw both quads with the
 *   four colours in place (not the stand-in, not flipped), the extracted one
 *   like its twin.
 * - Counts: the twin's image is the only one inside a model file (the Scene
 *   view's `data-resources`, Play's `textures.embedded`); the extracted one is
 *   a streamed texture of the budget.
 * - Streaming: the extracted texture reaches the level its size on screen
 *   asks for; under a 1 MiB budget it stays at a smaller level, inside the
 *   budget, with nothing embedded.
 */
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { texturedQuadGlb } from '../../tools/perf/assets';
import { publishBytes, startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, exportQueryFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { textureStreamerSettled } from './texture-settle';
import { projectWindow, closeEditor } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-extract-textures' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 400)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

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

/** The four quarters' colours (top left, top right, bottom left, bottom right). */
const QUARTERS: readonly (readonly [number, number, number])[] = [
  [220, 40, 40],
  [40, 200, 60],
  [40, 80, 220],
  [230, 210, 40],
];
const SIZE = 2048;
const image = (): Buffer => makePng(SIZE, SIZE, (x, y) => [...QUARTERS[(y < SIZE / 2 ? 0 : 2) + (x < SIZE / 2 ? 0 : 1)]!, 255]);

/**
 * Which quarter's colour a pixel shows, by its dominant channels (the views
 * shade and tone-map differently; a stand-in's white or a wrong image is none).
 */
function quarterOf(r: number, g: number, b: number): number {
  if (r > 100 && g > 100 && b < Math.min(r, g) - 50) return 3;
  if (r > g + 50 && r > b + 50) return 0;
  if (g > r + 50 && g > b + 50) return 1;
  if (b > r + 50 && b > g + 50) return 2;
  return -1;
}

/**
 * Where each quarter's colour is drawn, per half of the picture (the
 * extracted quad left of centre, its twin right): its pixel count and centre.
 */
function quartersOf(img: Image): { left: { n: number; x: number; y: number }[]; right: { n: number; x: number; y: number }[] } {
  const acc = (): { n: number; x: number; y: number }[] => QUARTERS.map(() => ({ n: 0, x: 0, y: 0 }));
  const left = acc();
  const right = acc();
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      const q = quarterOf(r, g, b);
      if (q < 0) continue;
      const side = x < img.width / 2 ? left : right;
      side[q]!.n += 1;
      side[q]!.x += x;
      side[q]!.y += y;
    }
  }
  for (const s of [left, right]) for (const q of s) if (q.n > 0) [q.x, q.y] = [q.x / q.n, q.y / q.n];
  return { left, right };
}

/** Both quads show all four quarters in place (seen from straight ahead: at about the same size). */
function expectBothQuads(img: Image, where: string, ahead = true): void {
  const { left, right } = quartersOf(img);
  for (const [name, side] of [['extracted (left)', left], ['embedded (right)', right]] as const) {
    for (let q = 0; q < 4; q++) expect(side[q]!.n, `${where}: ${name} quarter ${q}`).toBeGreaterThan(40);
    // Red above blue, red left of green: the image is neither flipped nor mirrored.
    expect(side[0]!.y, `${where}: ${name} red above blue`).toBeLessThan(side[2]!.y);
    expect(side[0]!.x, `${where}: ${name} red left of green`).toBeLessThan(side[1]!.x);
  }
  for (let q = 0; q < 4 && ahead; q++) {
    const ratio = left[q]!.n / right[q]!.n;
    expect(ratio, `${where}: quarter ${q} drawn alike`).toBeGreaterThan(0.6);
    expect(ratio, `${where}: quarter ${q} drawn alike`).toBeLessThan(1.6);
  }
}

interface Textures {
  loading?: number;
  budgetBytes: number;
  residentBytes: number;
  over: boolean;
  textures: { id: string; resident: number; wanted: number; tail: number; bytes: number }[];
  embedded?: { count: number; bytes: number; largest: { key: string }[] };
}
interface Resources {
  resident: Record<string, { count: number; bytes: number; textures?: { count: number; bytes: number } }>;
  textures?: Textures;
}

async function startPlay(page: Page): Promise<() => Promise<Resources | null>> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect(page.locator('iframe.tl-app__preview-frame')).toBeVisible();
  await expect.poll(async () => (await api(`play/${psid}/observe`, {})).json['state'], { timeout: 60_000 }).toBe('running');
  return async () => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? ((r.json['resources'] as Resources | undefined) ?? null) : null;
  };
}

for (const variant of RENDERER_VARIANTS) test(`a model's extracted images are texture assets it draws with, streamed under the budget (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(480_000);
  be = await startBackend(`extract-tex-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const shots = join(homedir(), '.cache', 'thirdlight-e2e-shots');
  mkdirSync(shots, { recursive: true });
  const glb = texturedQuadGlb({ bytes: image(), format: 'png' }, 'crate');
  // The twin keeps its image inside.
  await publishBytes(be, glb, 'model', 'twin', 'twin', {}, { extractTextures: false });

  // ---- The import in the Assets tab, "extract model textures" on by default.
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await projectWindow(page);
  await expect(page.getByLabel('extract model textures')).toBeChecked();
  mkdirSync(join(shots, 'extract-textures'), { recursive: true });
  const file = join(shots, 'extract-textures', 'crate.glb');
  writeFileSync(file, glb);
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 60_000 });
  await publish.click();
  // The texture asset is in the project window next to the model.
  await expect(page.locator('.tl-assets__list li').filter({ hasText: 'crate-albedo' })).toHaveCount(1, { timeout: 60_000 });
  // The model's tile draws its image (from the texture's own tile picture), not the white stand-in.
  const tile = page.locator('.tl-assets__list li').filter({ has: page.getByText('crate', { exact: true }) }).locator('img').first();
  await expect
    .poll(async () => {
      const q = quartersOf(decodePng(await tile.screenshot()));
      return q.left.every((x, i) => x.n + q.right[i]!.n > 3);
    }, { timeout: 60_000 })
    .toBe(true);
  const assets = (await query('queryAssets', { limit: 128, offset: 0 }))['assets'] as { assetId: string; kind: string; displayName: string; extractTextures?: true; textures?: Record<string, string>; convertedFrom?: { format: string }; image?: { format: string; levels?: number }; streaming?: { on: boolean } }[];
  const model = assets.find((a) => a.kind === 'model' && a.displayName === 'crate')!;
  expect(model.extractTextures).toBe(true);
  expect(model.convertedFrom?.format).toBe('glb');
  const textureId = model.textures!['0']!;
  const texture = assets.find((a) => a.assetId === textureId)!;
  expect(texture).toMatchObject({ kind: 'texture', displayName: 'crate-albedo', image: { format: 'ktx2' }, streaming: { on: true } });
  expect(texture.image!.levels).toBe(12);
  expect(assets.find((a) => a.assetId === 'twin')!.textures).toBeUndefined();

  // ---- The scene: the camera close in front, the extracted quad left of centre, the twin right.
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  const cam = ents.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [0, 1.6, 3.6], rotation: [0, 0, 0, 1] } });
  for (const e of ents) if (e.components['box'] !== undefined || e.components['model'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -50, 0] } });
  const extractedId = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'model', name: 'Extracted', model: { asset: { assetId: model.assetId } }, transform: { position: [-1.8, 1.6, 0], scale: [3, 3, 3] } }))['createdId']);
  const twinId = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'model', name: 'Twin', model: { asset: { assetId: 'twin' } }, transform: { position: [1.8, 1.6, 0], scale: [3, 3, 3] } }))['createdId']);
  await closeEditor(page);

  // ---- The Scene view: both drawn alike; only the twin's image is inside a model file.
  const viewResident = async (): Promise<Resources['resident'] | null> => {
    const a = await page.locator('[data-resources]').first().getAttribute('data-resources');
    return a === null ? null : (JSON.parse(a) as Resources['resident']);
  };
  await expect.poll(async () => (await viewResident())?.['model']?.count ?? 0, { timeout: 60_000 }).toBe(2);
  await expect.poll(async () => (await viewResident())?.['texture']?.count ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
  expect((await viewResident())!['model']!.textures!.count).toBe(1);
  const view = page.locator('canvas.tl-viewport');
  await expect.poll(async () => quartersOf(decodePng(await view.screenshot())).left.every((q) => q.n > 40), { timeout: 30_000 }).toBe(true);
  const viewShot = await view.screenshot({ path: join(shots, `extract-textures-scene-${variant}.png`) });
  // The Scene view's own camera sees them from an angle (one nearer than the other).
  expectBothQuads(decodePng(viewShot), 'Scene view', false);

  // ---- Play at the default budget.
  const resources = await startPlay(page);
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  const streamed = (r: Resources | null) => r?.textures?.textures.find((t) => t.id === textureId);
  await expect.poll(async () => { const t = streamed(await resources()); return t !== undefined && t.resident === t.wanted && t.wanted < t.tail; }, { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => (await resources())?.textures?.embedded?.count ?? 0, { timeout: 30_000 }).toBe(1);
  const atDefault = (await resources())!;
  expect(atDefault.textures!.embedded!.largest.map((m) => m.key.split('@')[0])).toEqual(['twin']);
  await expect.poll(async () => quartersOf(decodePng(await frame.screenshot())).left.every((q) => q.n > 40), { timeout: 30_000 }).toBe(true);
  expectBothQuads(decodePng(await frame.screenshot({ path: join(shots, `extract-textures-play-${variant}.png`) })), 'Play');
  await page.getByTitle('Stop the play preview').click();

  // ---- The export (run without the backend at the end).
  const exported = await be.admin(`projects/${be.projectId}/export`);
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
  const out = join(be.exportRoot, String(exported.json['outputDir']));

  // ---- Without the twin, the quad filling the view (it asks for its full size, 2 MiB at least in any GPU format)
  // ---- and a 1 MiB budget: the texture stays at a smaller level, inside the budget.
  await cmd('deleteEntity', { entityId: twinId });
  await cmd('setTransform', { entityId: extractedId, transform: { position: [0, 1.6, 0], scale: [3, 3, 3] } });
  await cmd('setTransform', { entityId: cam, transform: { position: [0, 1.6, 0.75], rotation: [0, 0, 0, 1] } });
  await cmd('setSettings', { settings: { texture_budget_mb: 1 } });
  const pressed = await startPlay(page);
  await expect.poll(async () => streamed(await pressed())?.wanted ?? -1, { timeout: 60_000 }).toBe(0);
  await textureStreamerSettled(async () => (await pressed())?.textures);
  for (let i = 0; i < 4; i++) {
    const r = (await pressed())!;
    const t = streamed(r)!;
    expect(r.textures!.budgetBytes).toBe(1024 * 1024);
    expect(t.resident).toBeGreaterThan(t.wanted);
    expect(t.resident).toBeLessThan(t.tail);
    expect(r.textures!.residentBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(r.textures!.embedded?.count ?? 0).toBe(0);
    await page.waitForTimeout(300);
  }
  await page.getByTitle('Stop the play preview').click();

  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const game = await page.context().newPage();
  const gameErrors: string[] = [];
  game.on('pageerror', (e) => gameErrors.push(e.message));
  try {
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    await expect.poll(async () => quartersOf(decodePng(await game.screenshot())).left.every((q) => q.n > 40), { timeout: 60_000 }).toBe(true);
    expectBothQuads(decodePng(await game.screenshot({ path: join(shots, `extract-textures-export-${variant}.png`) })), 'export');
    expect(gameErrors).toEqual([]);
  } finally {
    await site.close();
  }
  expect(errors).toEqual([]);
});

test('an existing model switches to extracted textures only when re-imported with the setting', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'an editor flow; the default project covers it');
  test.setTimeout(240_000);
  be = await startBackend(`extract-reimport-${randomUUID().slice(0, 8)}`);
  // A model imported with its images inside, as every model imported before the setting existed.
  await publishBytes(be, texturedQuadGlb({ bytes: makePng(256, 256, (x, y) => [...QUARTERS[(y < 128 ? 0 : 2) + (x < 128 ? 0 : 1)]!, 255]), format: 'png' }, 'barrel'), 'model', 'barrel', 'barrel', {}, { extractTextures: false });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await projectWindow(page);
  await page.locator('.tl-assets__list li').filter({ hasText: 'barrel' }).first().click();
  const setting = page.getByLabel('extract textures', { exact: true });
  await expect(setting).not.toBeChecked();
  // Nothing changes until the re-import.
  await setting.check();
  const asset = async () => ((await query('queryAssets', { assetId: 'barrel' }))['assets'] as { extractTextures?: true; textures?: Record<string, string> }[])[0]!;
  expect((await asset()).extractTextures).toBeUndefined();
  await page.getByRole('button', { name: 'reimport', exact: true }).click();
  await expect.poll(async () => (await asset()).textures?.['0'] ?? '', { timeout: 60_000 }).not.toBe('');
  expect((await asset()).extractTextures).toBe(true);
  await expect(page.locator('[aria-label="extracted textures"] li')).toHaveCount(1);
  await expect(page.locator('.tl-assets__list li').filter({ hasText: 'barrel-albedo' })).toHaveCount(1);
});
