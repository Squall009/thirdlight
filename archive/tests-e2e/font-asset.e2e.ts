/**
 * A font file chosen in the Asset browser imports as a `font`
 * asset (real page, real backend): the TTF fixture (a DejaVu Sans ASCII
 * subset, fixtures/fonts) is staged, inspected and published, and its tile
 * shows the kind with the generic icon. A WOFF2 of the same font imports too.
 * A font tile dropped on the Scene view places nothing (only models and
 * textures place), but it still moves into a folder like any project item.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { projectWindow } from './ui';

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
  await projectWindow(page);

  await importFont(page, 'neutral-sans.ttf', 1);
  const tile = page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'neutral-sans' }).first();
  await expect(tile).toContainText('font · v1');
  await expect(tile.locator('img.tl-tile__img')).toHaveAttribute('src', './icons/kinds/font.webp');
  // A font dropped on the Scene view places nothing: no entity, no command.
  const entityCount = async (): Promise<number> => Number((await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 1, offset: 0 } }))['total']);
  const revision = async (): Promise<number> => Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} }))['revision']);
  const entitiesBefore = await entityCount();
  const revisionBefore = await revision();
  await tile.dragTo(page.locator('canvas.tl-viewport'));
  await page.waitForTimeout(500);
  expect(await entityCount()).toBe(entitiesBefore);
  expect(await revision()).toBe(revisionBefore);
  // It still moves into a folder (its file and sidecar go with it).
  const made = await be.command({ op: 'createFolder', projectId: be.projectId, expectedRevision: revisionBefore, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-font-asset' }, args: { folder: 'fonts' } });
  expect(made['ok'], JSON.stringify(made).slice(0, 300)).toBe(true);
  const fontsNode = page.locator('.tl-project__tree [data-tree-folder="fonts"]');
  await expect(fontsNode).toBeVisible({ timeout: 10_000 });
  await tile.dragTo(fontsNode);
  await expect.poll(() => existsSync(join(be.projectDir, 'fonts', 'neutral-sans.ttf'))).toBe(true);
  expect(existsSync(join(be.projectDir, 'fonts', 'neutral-sans.ttf.tlasset'))).toBe(true);

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
