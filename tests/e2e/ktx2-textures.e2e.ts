/**
 * KTX2 texture assets and KTX2 encoding on import, against a
 * real backend on a blank project.
 *
 * - Editor: the Assets panel's "texture import encoding" set to KTX2 colour;
 *   a red/blue checker PNG imports as a KTX2 (ETC1S, 7 mip levels, from the
 *   PNG — the asset's facts line shows it).
 * - Content route (as MCP): a flat normal-map PNG imported with ktx2 "normal"
 *   (UASTC, linear) and published with its convertedFrom.
 * - Two unlit materials show them on two boxes (the checker's red and blue,
 *   the normal map's blue): the Scene view, Play (the preview's CSP lets the
 *   Basis transcoder run) and the static export with the backend stopped
 *   (the export ships the transcoder next to the page).
 *
 * Runs per renderer variant (renderer-variants.ts): auto, WebGL 2
 * (TL_E2E_ALL_VARIANTS=1 on a GPU), WebGPU in `webgpu`.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

let be: E2EBackend | null = null;
let dir = '';
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-ktx2-'));
});
test.afterEach(async () => {
  await be?.stop();
  be = null;
  rmSync(dir, { recursive: true, force: true });
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-ktx2' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

/** Upload, inspect with `ktx2`, publish with the returned convertedFrom (the MCP path). */
async function importEncoded(bytes: Uint8Array, mode: 'color' | 'normal', assetId: string): Promise<Record<string, unknown>> {
  const headers = { authorization: `Bearer ${be!.token}`, origin: be!.origin };
  const base = `${be!.origin}/api/v1/projects/${be!.projectId}/content/stages`;
  const stage = (await (await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/${stage.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  expect(put.status).toBe(200);
  const inspected = (await (await fetch(`${base}/${stage.stageId}/inspect`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'texture', ktx2: mode }) })).json()) as { proposal?: Record<string, unknown>; convertedFrom?: Record<string, unknown> };
  const p = inspected.proposal!;
  expect(p['status'], JSON.stringify(inspected).slice(0, 300)).toBe('ok');
  await cmd('publishAsset', { mode: 'create', assetId, kind: 'texture', displayName: assetId, sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], convertedFrom: inspected.convertedFrom, importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
  return inspected.convertedFrom!;
}

type Pred = (r: number, g: number, b: number) => boolean;
const red: Pred = (r, g, b) => r > 120 && r > g + 80 && r > b + 80;
const blue: Pred = (r, g, b) => b > 120 && b > r + 50 && b > g + 50;
function count(img: Image, test: Pred, x0 = 0, x1 = img.width): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = x0; x < x1; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (test(r, g, b)) n += 1;
  }
  return n;
}
/** The checker (left half: red and blue texels) and the normal map (right half: blue). Returns a problem or null. */
function checkPicture(img: Image, anywhere = false): string | null {
  const mid = Math.floor(img.width / 2);
  const reds = count(img, red, 0, anywhere ? img.width : mid);
  if (reds < 150) return `the checker's red is missing (${reds} pixels)`;
  const blueLeft = count(img, blue, 0, anywhere ? img.width : mid);
  if (blueLeft < 150) return `the checker's blue is missing (${blueLeft} pixels)`;
  if (anywhere) return null;
  const blueRight = count(img, blue, mid, img.width);
  if (blueRight < 300) return `the normal map's blue is missing (${blueRight} pixels)`;
  if (count(img, red, mid, img.width) > 20) return 'red on the normal-map box';
  return null;
}
const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

for (const variant of RENDERER_VARIANTS) test(`KTX2 textures encoded on import (colour and normal map) show in the Scene view, Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  be = await startBackend(`ktx2-e2e-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);

  // Editor: import the checker as a KTX2 (colour).
  const checker = join(dir, 'checker.png');
  writeFileSync(checker, makePng(64, 64, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [240, 60, 60, 255] : [40, 40, 220, 255])));
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.getByRole('combobox', { name: 'texture import encoding' }).selectOption('color');
  await page.locator('.tl-assets__file').first().setInputFiles(checker);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 60_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'checker' });
  await expect(tile).toHaveCount(1, { timeout: 10_000 });
  await tile.click();
  await expect(page.getByTestId('texture-facts')).toContainText('KTX2 · ETC1S · 7 mip levels · 64×64');
  await expect(page.locator('.tl-assets__source').filter({ hasText: 'from PNG' })).toContainText('from PNG (colour) (uploaded)');
  const assets = (await query('queryAssets', { limit: 10, offset: 0, includeVersions: true }))['assets'] as { assetId: string; displayName: string; image?: unknown; convertedFrom?: unknown }[];
  const checkerAsset = assets.find((a) => a.displayName === 'checker')!;
  expect(checkerAsset.image).toEqual({ format: 'ktx2', width: 64, height: 64, codec: 'etc1s', levels: 7 });
  expect(checkerAsset.convertedFrom).toEqual({ format: 'png', encoding: 'color' });

  // The content route (as MCP): a flat normal map as UASTC.
  const normal = await importEncoded(new Uint8Array(makePng(32, 32, () => [128, 128, 255, 255])), 'normal', 'flat-normal');
  expect(normal).toMatchObject({ format: 'png', encoding: 'normal', converter: { name: 'ktx2-encoder', version: '0.6.0' } });
  const normalAsset = ((await query('queryAssets', { limit: 10, offset: 0 }))['assets'] as { assetId: string; image?: unknown }[]).find((a) => a.assetId === 'flat-normal')!;
  expect(normalAsset.image).toEqual({ format: 'ktx2', width: 32, height: 32, codec: 'uastc', levels: 6 });

  // The scene: a dark sky, the camera looking along −Z at two boxes wearing unlit KTX2-textured materials.
  await cmd('setMaterial', { material: { materialId: 'mat-checker', name: 'Checker', shader: 'unlit', params: {}, textures: { map: checkerAsset.assetId } } });
  await cmd('setMaterial', { material: { materialId: 'mat-normal', name: 'Normal', shader: 'unlit', params: {}, textures: { map: 'flat-normal' } } });
  await cmd('setEnvironment', { environment: { sky: { mode: 'color', color: '#303030' } } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  const cam = ents.find((e) => e.components['camera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [0, 0, 6], rotation: [0, 0, 0, 1] } });
  for (const e of ents) if (e.components['box'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -50, 0] } });
  for (const [name, x, mat] of [['Checker box', -1.4, 'mat-checker'], ['Normal box', 1.4, 'mat-normal']] as const) {
    const id = String((await cmd('createEntity', { parentId: null, kind: 'box', name, transform: { position: [x, 0, 0] }, box: { size: [2, 2, 0.05], material: { color: '#ffffff' } } }))['createdId']);
    await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': mat } });
  }

  // Scene view.
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  await page.keyboard.press('Escape');
  let problem: string | null = 'not checked';
  await expect.poll(async () => (problem = checkPicture(await shot(viewport), true)), { timeout: 30_000, message: 'Scene view picture' }).toBeNull();

  // Play.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => (problem = checkPicture(await shot(frame))), { timeout: 60_000, message: 'Play picture' }).toBeNull();
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();
  expect(errors).toEqual([]);

  // The static export, served with the backend stopped: it ships the transcoder.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  expect(existsSync(join(out, 'decoders', 'basis', 'basis_transcoder.wasm'))).toBe(true);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const exportErrors: string[] = [];
  exported.on('pageerror', (e) => exportErrors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    await expect.poll(async () => (problem = checkPicture(await shot(exported))), { timeout: 60_000, message: 'export picture' }).toBeNull();
    expect(exportErrors).toEqual([]);
  } finally {
    await site.close();
  }
});
