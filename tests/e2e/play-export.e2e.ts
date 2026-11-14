/**
 * Play and standalone export of a fresh project, observed as pixels.
 */
import { join } from 'node:path';

import { expect, test, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { menu } from './ui';

import { colorCount, decodePng } from './png';
import { serveDir } from '../support/serve-dir';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

async function createBox(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await menu(page, 'GameObject', 'Box');
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'box' })).toHaveCount(1);
}

// One backend and box for both: the export is made from the project Play just ran.
test('Play renders a fresh project scene in the isolated preview, which fills the centre view and does not scroll; the exported game runs from a plain static server with the backend stopped', async ({ page }) => {
  await createBox(page);
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  // The box is drawn over the clear color: more than one color appears.
  await expect.poll(async () => colorCount(decodePng(await frame.screenshot())), { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  const stage = (await page.locator('.tl-app__stage').boundingBox())!;
  const full = (await frame.boundingBox())!;
  expect(full.width).toBeGreaterThan(stage.width * 0.95);
  expect(full.height).toBeGreaterThan(stage.height * 0.85);
  // The game page inside the frame fits it exactly: nothing to scroll.
  await expect
    .poll(() => page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').evaluate((c) => {
      const d = c.ownerDocument.documentElement;
      return { scrollable: d.scrollHeight > d.clientHeight || d.scrollWidth > d.clientWidth };
    }))
    .toMatchObject({ scrollable: false });

  await page.getByTitle('Stop the play preview').click();
  // Stop is a backend round trip plus the preview's teardown: seconds on a loaded CPU-rendered host.
  await expect(frame).toHaveCount(0, { timeout: 30_000 });

  // The export of the same project.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await page.close();
  await be.halt();

  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const requests: string[] = [];
  game.on('request', (r) => requests.push(r.url()));
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    await expect.poll(async () => colorCount(decodePng(await game.screenshot())), { timeout: 15_000 }).toBeGreaterThan(1);
    expect(errors).toEqual([]);
    expect(await game.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight)).toBe(false);
    await expect(game.getByText(/error/i)).toHaveCount(0);
    // A release game (no debug console) keeps no build line over its own HUD once it runs.
    await expect.poll(() => game.evaluate(() => typeof (window as { __thirdlightObserve?: unknown }).__thirdlightObserve)).toBe('function');
    await expect(game.locator('#hud')).toHaveText('');
    expect(requests.every((u) => u.startsWith(site.url))).toBe(true);
  } finally {
    await site.close();
  }
});
