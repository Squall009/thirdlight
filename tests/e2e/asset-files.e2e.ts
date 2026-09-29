/**
 * The asset database on disk, against the real backend and Chromium: a GLB
 * imported in the editor is written into the project's folder
 * (`assets/<name>.glb`) with a `.tlasset` sidecar naming its id; the file and
 * its sidecar are renamed outside the editor; "check files" finds the asset
 * by its sidecar, the Assets tab shows the new path, and the placed object
 * still renders in the Scene view after a reload and in Play (its bytes
 * delivered from the new file).
 */
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { colorCount, decodePng } from './png';

const REPO = resolve(import.meta.dirname, '..', '..');
const GLB = join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v1.glb');
const SHOTS = join(REPO, 'test-results', 'asset-files');
const DIGEST = createHash('sha256').update(readFileSync(GLB)).digest('hex');

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

const rows = (page: Page) => page.locator('.tl-hierarchy__list li.tl-row');

test('an imported file has a sidecar; renamed outside the editor with it, "check files" keeps the asset and its uses', async ({ page }) => {
  test.setTimeout(120_000);
  mkdirSync(SHOTS, { recursive: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const before = await rows(page).count();

  // Import in the editor: the upload is written into the project's folder with its sidecar.
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(GLB);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li').filter({ hasText: 'tiny-v1' });
  await expect(tile).toHaveCount(1, { timeout: 10_000 });
  await tile.click();
  await expect(page.locator('.tl-assets__source')).toHaveText('file: assets/tiny-v1.glb');
  const file = join(be.projectDir, 'assets', 'tiny-v1.glb');
  expect(readFileSync(file)).toEqual(readFileSync(GLB));
  const sidecar = JSON.parse(readFileSync(`${file}.tlasset`, 'utf8')) as { tlasset: number; id: string; kind: string };
  expect(sidecar).toMatchObject({ tlasset: 1, kind: 'model' });
  const content = JSON.parse(readFileSync(join(be.projectDir, 'content.json'), 'utf8')) as { content: { assets: { assetId: string }[] } };
  expect(content.content.assets.map((a) => a.assetId)).toEqual([sidecar.id]);

  // Place it.
  await page.getByRole('button', { name: 'place' }).click();
  await page.getByRole('tab', { name: 'Scene' }).click();
  await expect(rows(page)).toHaveCount(before + 1);

  // Rename the file and its sidecar outside the editor (a file manager, git mv).
  mkdirSync(join(be.projectDir, 'assets', 'props'), { recursive: true });
  const moved = join(be.projectDir, 'assets', 'props', 'crate.glb');
  renameSync(file, moved);
  renameSync(`${file}.tlasset`, `${moved}.tlasset`);

  // "check files": the asset is found by its sidecar and keeps its id.
  await page.getByRole('tab', { name: /Problems/ }).click();
  await page.getByRole('button', { name: 'check files' }).click();
  await expect(page.getByRole('button', { name: 'check files' })).toBeEnabled();
  await expect(page.getByRole('list', { name: 'Asset files' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Assets' }).click();
  await tile.click();
  await expect(page.locator('.tl-assets__source')).toHaveText('file: assets/props/crate.glb');
  expect(JSON.parse(readFileSync(`${moved}.tlasset`, 'utf8'))).toMatchObject({ id: sidecar.id });

  // The placed object still resolves: after a reload it is drawn in the Scene view …
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect(rows(page)).toHaveCount(before + 1);
  await page.waitForTimeout(800);
  await page.locator('.tl-app__stage').screenshot({ path: join(SHOTS, '1-scene-after-rename.png') });

  // … and Play reads its bytes from the renamed file.
  const delivered: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes(DIGEST) && r.status() === 200) delivered.push(r.url());
  });
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expect.poll(() => delivered.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(async () => colorCount(decodePng(await frame.screenshot()), 1), { timeout: 15_000 }).toBeGreaterThan(1);
  await frame.screenshot({ path: join(SHOTS, '2-play-after-rename.png') });
  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0, { timeout: 30_000 });
  expect(errors).toEqual([]);
});
