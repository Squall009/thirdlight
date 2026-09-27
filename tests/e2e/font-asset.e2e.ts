/**
 * Phase 23.9a: a font file chosen in the Asset browser imports as a `font`
 * asset (real page, real backend): the TTF fixture (a DejaVu Sans ASCII
 * subset, fixtures/fonts) is staged, inspected and published, and its tile
 * shows the kind with the generic icon. A WOFF2 of the same font imports too.
 */
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

const FONTS = resolve(import.meta.dirname, '..', '..', 'fixtures', 'fonts');

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

async function importFont(page: Page, file: string, tiles: number): Promise<void> {
  await page.locator('.tl-assets__file').first().setInputFiles(join(FONTS, file));
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'neutral-sans' })).toHaveCount(tiles, { timeout: 10_000 });
}

test('a TTF and a WOFF2 import as font assets and show font tiles', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'no renderer involved (the asset list)');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();

  await importFont(page, 'neutral-sans.ttf', 1);
  const tile = page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'neutral-sans' }).first();
  await expect(tile).toContainText('font · v1');
  await expect(tile.locator('img.tl-tile__img')).toHaveAttribute('src', './icons/empty.png');
  // A font is not dragged into the scene.
  await expect(tile).not.toHaveAttribute('draggable', 'true');

  await importFont(page, 'neutral-sans.woff2', 2);
  await expect(page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'font · v1' })).toHaveCount(2, { timeout: 10_000 });

  const listed = await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0, includeVersions: true } });
  const assets = listed['assets'] as Array<{ kind: string; versions?: Array<{ sourceByteLength: number }> }>;
  expect(assets.map((a) => a.kind)).toEqual(['font', 'font']);
  // The published bytes are the two fixture files, unchanged.
  const sizes = assets.map((a) => a.versions?.[0]?.sourceByteLength).sort();
  expect(sizes).toEqual([statSync(join(FONTS, 'neutral-sans.ttf')).size, statSync(join(FONTS, 'neutral-sans.woff2')).size].sort());
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
