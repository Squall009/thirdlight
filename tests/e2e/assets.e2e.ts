/**
 * The asset workflow in the browser: import a GLB, publish, preview it in the
 * isolated preview canvas, place it in the scene.
 */
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { colorCount, decodePng } from './png';

const GLB = resolve(import.meta.dirname, '..', '..', 'fixtures', 'm2', 'assets', 'tiny-v1.glb');

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

test('import → publish → isolated preview → place', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const entitiesBefore = await page.locator('.tl-hierarchy__list li').count();

  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(join(GLB));
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const asset = page.locator('.tl-assets__list li').first();
  await expect(asset).not.toHaveClass(/tl-row--empty/, { timeout: 10_000 });
  await asset.click();

  // The preview renders in its own canvas; the edited scene is untouched.
  const canvas = page.locator('.tl-assets__preview-canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(300);
  // Before loading, the preview shows only the grid; the model adds its colors.
  const empty = colorCount(decodePng(await canvas.screenshot()), 1);
  await page.getByRole('button', { name: 'load preview' }).click();
  await expect.poll(async () => colorCount(decodePng(await canvas.screenshot()), 1), { timeout: 10_000 }).toBeGreaterThan(empty + 2);

  await page.getByRole('button', { name: 'place' }).click();
  await page.getByRole('tab', { name: 'Scene' }).click();
  await expect(page.locator('.tl-hierarchy__list li')).toHaveCount(entitiesBefore + 1);
  await expect(page.locator('.tl-hierarchy__list li').filter({ hasText: 'tiny-v1' })).toHaveCount(1);
});
