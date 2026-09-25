/**
 * Phase 9.4: materials, textures and wind in the browser. A foliage material
 * (COLOR_0 as wind data) set as an asset's default makes its pieces move in
 * the Scene view, in Play and in the export; a standard material with a
 * texture shows the texture on a box.
 *
 * Phase 17.2/17.4: runs once per renderer variant (renderer-variants.ts):
 * node materials on WebGPURenderer — auto (the default) and forced WebGL 2 in
 * the default project, WebGPU in the webgpu project.
 */
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { KIT_PIECES, multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { menu } from './ui';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-mat-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Pixels that differ between two images (a coarse motion measure). */
function changed(a: Image, b: Image): number {
  let n = 0;
  for (let y = 0; y < Math.min(a.height, b.height); y += 2) {
    for (let x = 0; x < Math.min(a.width, b.width); x += 2) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 40) n += 1;
    }
  }
  return n;
}
function bluePixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (b > 90 && b > 2 * r && b > 2 * g) n += 1;
  }
  return n;
}
async function motion(target: Locator | Page): Promise<number> {
  const a = decodePng(await target.screenshot());
  await new Promise((r) => setTimeout(r, 700));
  const b = decodePng(await target.screenshot());
  return changed(a, b);
}
async function importFile(page: Page, file: string): Promise<void> {
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__status')).toContainText('committed', { timeout: 10_000 });
}
function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

for (const variant of RENDERER_VARIANTS) test(`a foliage material moves in the wind (editor, Play, export); a texture shows on a box (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(240_000);
  const kit = join(dir, 'kit.glb');
  writeFileSync(kit, multiPieceGlb(KIT_PIECES));
  const checker = join(dir, 'checker.png');
  writeFileSync(checker, makePng(64, 64, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [30, 60, 230, 255] : [240, 240, 240, 255])));
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  await importFile(page, kit);
  await importFile(page, checker);
  const kitTile = page.locator('.tl-assets__list li[data-asset-id]:not([data-piece])').filter({ hasText: 'kit' });
  await kitTile.dragTo(page.locator('canvas.tl-viewport'));
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'flower' })).toHaveCount(1, { timeout: 10_000 });
  await page.locator('canvas.tl-viewport').click({ position: { x: 5, y: 5 } });
  const viewport = page.locator('canvas.tl-viewport');
  // Without a wind material nothing moves.
  expect(await motion(viewport)).toBeLessThan(20);

  // A foliage material, strong bend.
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.getByRole('button', { name: '+ new material' }).click();
  await expect(page.locator('.tl-materials li[data-material-id]')).toHaveCount(1);
  await page.getByRole('combobox', { name: 'shader' }).selectOption('foliage');
  await expect(page.locator('.tl-materials li[data-material-id]')).toContainText('foliage');
  // One step up, not the maximum: the fixture's pieces bend as a whole (full weight), and at
  // windBend 4 with wind strength 10 they swing ~5 m, out of the frame for ~2 s of every
  // ~3.7 s sway — two screenshots that both land there read "no motion" (the load-only flake).
  await page.getByRole('slider', { name: 'windBend slider' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tl-param[data-param="windBend"]')).toHaveClass(/is-set/);

  // Strong wind.
  await page.getByRole('tab', { name: 'Environment' }).click();
  await page.getByRole('slider', { name: 'wind strength' }).focus();
  await page.keyboard.press('End');
  await expect.poll(async () => JSON.stringify((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['environment'])).toContain('"strength":10');

  // The kit's default material: every placement bends in the wind.
  await page.getByRole('tab', { name: 'Assets' }).click();
  await kitTile.click();
  await page.getByRole('combobox', { name: 'material for all' }).selectOption({ label: 'Material 1' });
  // Generous waits: the first frames with a new node material compile its pipeline (slow on the CPU renderer here).
  await expect.poll(() => motion(viewport), { timeout: 30_000 }).toBeGreaterThan(50);

  // A textured standard material on a box.
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.getByRole('button', { name: '+ new material' }).click();
  await expect(page.locator('.tl-materials li[data-material-id]')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'texture map' }).selectOption({ label: 'checker' });
  await menu(page, 'GameObject', 'Box');
  const boxRow = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  await expect(boxRow).toContainText('box');
  const beforeBlue = bluePixels(decodePng(await viewport.screenshot()));
  await page.getByRole('combobox', { name: 'material for all' }).selectOption({ label: 'Material 2' });
  await expect.poll(async () => bluePixels(decodePng(await viewport.screenshot())), { timeout: 10_000 }).toBeGreaterThan(beforeBlue + 100);

  // Play: the wind moves the pieces there too, and the box shows its texture.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(() => motion(frame), { timeout: 45_000 }).toBeGreaterThan(30);
  await expect.poll(async () => bluePixels(decodePng(await frame.screenshot())), { timeout: 20_000 }).toBeGreaterThan(100);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // Export: the same, served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    await expect.poll(() => motion(exported), { timeout: 20_000 }).toBeGreaterThan(30);
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
