/**
 * Phase 9.4: standalone textures. A PNG imports as a `texture` asset whose tile
 * shows the image itself.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { makePng } from './png-make';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-tex-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a PNG imports as a texture asset and its tile shows the image', async ({ page }) => {
  const file = join(dir, 'checker.png');
  writeFileSync(file, makePng(64, 64, (x, y) => ((x >> 3) + (y >> 3)) % 2 === 0 ? [240, 60, 60, 255] : [40, 40, 200, 255]));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'checker' });
  await expect(tile).toHaveCount(1, { timeout: 10_000 });
  await expect(tile).toContainText('texture');
  await expect(tile.locator('img.tl-tile__img--thumb')).toHaveAttribute('src', /^blob:/);
  const listed = await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } });
  expect((listed['assets'] as { kind: string }[])[0]!.kind).toBe('texture');
  // A texture tile drags onto a material's texture slot (not into the scene).
  await expect(tile).toHaveAttribute('draggable', 'true');
});
