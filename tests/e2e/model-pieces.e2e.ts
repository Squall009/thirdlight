/**
 * Multi-piece model files in the browser: a GLB whose top-level nodes are
 * `<piece>_LOD<n>` / `<piece>_COL` (the kit naming rule) imports as one asset
 * with a rendered tile preview, expands into one tile per piece, and drags
 * into the Scene view (a folder with every piece laid out in a row, `_COL`
 * boxes as 2D colliders, one undo) or into a hierarchy folder (one piece).
 * COLOR_0 is shader data by default and a tint only when the asset says so.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { KIT_PIECES, multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-kit-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

interface Ent {
  id: string;
  name?: string;
  parentId?: string;
  components: {
    transform?: { position: number[] };
    folder?: object;
    model?: { asset: { assetId: string }; piece?: string };
    collider?: { shape: { type: string; vertices?: number[][] } };
  };
}

async function entities(): Promise<Ent[]> {
  const q = await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 200, offset: 0 } });
  return q['entities'] as Ent[];
}

/** Pixels that read as the fixture's red vertex colour. */
function redPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 70 && r > 2.5 * g && r > 2.5 * b) n += 1;
    }
  }
  return n;
}

async function importKit(page: Page): Promise<void> {
  const file = join(dir, 'kit.glb');
  writeFileSync(file, multiPieceGlb(KIT_PIECES));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li[data-asset-id]').first()).toBeVisible({ timeout: 10_000 });
}

test('a multi-piece GLB: tile preview, piece tiles, drag into the scene and a folder, vertex colours as data', async ({ page }) => {
  // A thumbnail cache miss is expected, not an error (204, nothing in the console).
  const thumbnailFailures: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/content/thumbnails/') && r.status() >= 400) thumbnailFailures.push(`${r.request().method()} ${r.status()}`);
  });
  await importKit(page);
  const tile = page.locator('.tl-assets__list li[data-asset-id]:not([data-piece])').first();
  const assetId = (await tile.getAttribute('data-asset-id'))!;

  // The tile shows a rendered preview, and the backend cached it.
  await expect(tile.locator('img.tl-tile__img--thumb')).toBeVisible({ timeout: 20_000 });
  const asset = await (await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/assets/${assetId}`, { headers: { authorization: `Bearer ${be.token}` } })).json() as { asset?: { versions: { sourceDigest: string }[] }; versions?: { sourceDigest: string }[] };
  const digest = (asset.asset?.versions ?? asset.versions ?? [])[0]!.sourceDigest;
  const thumb = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/thumbnails/${digest}`, { headers: { authorization: `Bearer ${be.token}` } });
  expect(thumb.status).toBe(200);
  // Phase 21.4: revalidation — the cached thumbnail's ETag answers 304 without the bytes.
  const etag = thumb.headers.get('etag');
  expect(etag).toMatch(/^"t-/);
  const again = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/thumbnails/${digest}`, { headers: { authorization: `Bearer ${be.token}`, 'if-none-match': etag! } });
  expect(again.status).toBe(304);
  expect((await again.arrayBuffer()).byteLength).toBe(0);
  const png = decodePng(Buffer.from(await thumb.arrayBuffer()));
  expect(png.width).toBe(128);
  // Transparent corners, an opaque model in the middle.
  expect(png.pixel(0, 0)[3]).toBe(0);
  expect(png.pixel(64, 64)[3]).toBeGreaterThan(200);
  // Vertex colours are data: the preview is not red.
  expect(redPixels(png)).toBe(0);
  // The route needs the project token and takes only PNG images.
  expect((await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/thumbnails/${digest}`)).status).toBe(401);
  const junk = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/thumbnails/${digest}?piece=rock`, { method: 'PUT', headers: { authorization: `Bearer ${be.token}`, origin: be.origin }, body: 'not a png' });
  expect(junk.status).toBe(400);

  // Three pieces (LOD and COL nodes grouped by name), each with its own tile.
  await tile.getByRole('button', { name: /show the 3 pieces/ }).click();
  const pieceTiles = page.locator('.tl-tile--piece');
  await expect(pieceTiles).toHaveCount(3);
  await expect(pieceTiles.nth(0)).toHaveAttribute('data-piece', 'rock');
  await expect(pieceTiles.locator('img.tl-tile__img--thumb')).toHaveCount(3, { timeout: 20_000 });

  // Drag the whole file into the Scene view: one folder, a child per piece in a row.
  const rowsBefore = await page.locator('.tl-hierarchy__list li.tl-row').count();
  const viewport = page.locator('canvas.tl-viewport');
  await tile.dragTo(viewport);
  await expect(page.locator('.tl-hierarchy__list li.tl-row')).toHaveCount(rowsBefore + 4, { timeout: 10_000 });
  let all = await entities();
  const folder = all.find((e) => e.components.folder !== undefined && e.name === 'kit')!;
  expect(folder).toBeDefined();
  const kids = all.filter((e) => e.parentId === folder.id);
  expect(kids.map((k) => k.components.model?.piece)).toEqual(['rock', 'bush', 'flower']);
  const xs = kids.map((k) => k.components.transform!.position[0]!);
  // rock is 1 m wide, bush 2 m, with a 0.5 m gap: nothing overlaps.
  expect(xs[1]! - xs[0]!).toBeCloseTo(1.5, 3);
  expect(xs[2]! - xs[1]!).toBeCloseTo(2.5, 3);
  // `_COL` boxes became 2D colliders (convex hull on the play plane); the flower has none.
  expect(kids[0]!.components.collider?.shape).toEqual({ type: 'polygon', vertices: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  expect(kids[1]!.components.collider?.shape).toEqual({ type: 'polygon', vertices: [[0, 0], [2, 0], [2, 0.5], [0, 0.5]] });
  expect(kids[2]!.components.collider).toBeUndefined();

  // One undo removes the whole drop, redo brings back the same objects.
  await page.locator('canvas.tl-viewport').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.tl-hierarchy__list li.tl-row')).toHaveCount(rowsBefore);
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.tl-hierarchy__list li.tl-row')).toHaveCount(rowsBefore + 4);
  all = await entities();
  expect(all.filter((e) => e.parentId === folder.id).map((e) => e.id)).toEqual(kids.map((k) => k.id));

  // Drag one piece onto the folder row in the hierarchy: it is filed inside.
  await pieceTiles.nth(1).dragTo(page.locator(`.tl-hierarchy__list li[data-entity-id="${folder.id}"]`));
  await expect(page.locator('.tl-hierarchy__list li.tl-row')).toHaveCount(rowsBefore + 5, { timeout: 10_000 });
  all = await entities();
  const inFolder = all.filter((e) => e.parentId === folder.id);
  expect(inFolder).toHaveLength(4);
  expect(inFolder[3]!.components.model?.piece).toBe('bush');

  // The scene view: white pieces (vertex colour as data) — no red pixels.
  // Deselect (a click on empty sky) so the gizmo's red axis is not counted.
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toHaveCount(0);
  await page.waitForTimeout(300);
  const dataRed = redPixels(decodePng(await viewport.screenshot()));
  // Switch the asset to "tint": the same pieces turn red.
  await tile.click();
  await page.getByRole('combobox', { name: 'vertex colour' }).selectOption('tint');
  await expect.poll(async () => redPixels(decodePng(await viewport.screenshot())), { timeout: 10_000 }).toBeGreaterThan(dataRed + 200);
  expect(dataRed).toBeLessThan(50);
  all = await entities();
  const content = await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } });
  expect(JSON.stringify(content)).toContain('"vertexColors":"tint"');

  expect(thumbnailFailures).toEqual([]);

  // Everything survives a backend restart (the recorded changes reload).
  await be.restart();
  // The reopened editor reclaims the project while the backend loads it: wait until it answers.
  let last: Record<string, unknown> = {};
  await expect
    .poll(async () => {
      last = await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 200, offset: 0 } });
      return Array.isArray(last['entities']);
    }, { timeout: 15_000, message: 'queryEntities after the restart' })
    .toBe(true);
  const after = last['entities'] as Ent[];
  expect(after.filter((e) => e.parentId === folder.id).map((e) => e.components.model?.piece)).toEqual(['rock', 'bush', 'flower', 'bush']);
  expect(JSON.stringify(await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))).toContain('"vertexColors":"tint"');
});

test('Play draws the pieces with the asset vertex-colour mode', async ({ page }) => {
  await importKit(page);
  const tile = page.locator('.tl-assets__list li[data-asset-id]:not([data-piece])').first();
  await tile.dragTo(page.locator('canvas.tl-viewport'));
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'flower' })).toHaveCount(1, { timeout: 10_000 });
  await tile.click();
  await page.getByRole('combobox', { name: 'vertex colour' }).selectOption('tint');
  await page.waitForTimeout(300);
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expect.poll(async () => redPixels(decodePng(await frame.screenshot())), { timeout: 20_000 }).toBeGreaterThan(100);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
