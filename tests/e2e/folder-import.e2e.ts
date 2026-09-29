/**
 * Folders in the Assets tab, against the real backend and Chromium, on a
 * project in the data root (its own folder is its game folder):
 *
 * - a file uploaded with "upload to" set lands in that folder;
 * - a folder picked on the computer is uploaded into the upload folder under
 *   its own name and imported with the labels typed: every supported file,
 *   subfolders included, is an asset named after its file; what no importer
 *   takes is reported;
 * - a folder already in the game folder is imported the same way;
 * - after a reload the assets are listed with their labels and files.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

const REPO = resolve(import.meta.dirname, '..', '..');
const GLB = join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v1.glb');
const OPUS = readFileSync(join(REPO, 'fixtures', 'music', 'chord-opus.ogg'));
const WAV = readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav'));

let be: E2EBackend;
let local: string;
test.beforeEach(async () => {
  be = await startBackend();
  local = mkdtempSync(join(tmpdir(), 'tl-e2e-pick-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(local, { recursive: true, force: true });
});

const tile = (page: Page, name: string) => page.locator('.tl-assets__list li.tl-tile').filter({ has: page.locator('.tl-tile__name', { hasText: new RegExp(`^${name}$`) }) });

test('uploads land in the folder named; a picked folder and a game-folder folder import with labels; a reload shows them', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();

  // One file, uploaded into the folder the tab names.
  await page.getByLabel('upload folder').fill('assets/props');
  await page.locator('.tl-assets__file').first().setInputFiles(GLB);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(tile(page, 'tiny-v1')).toHaveCount(1, { timeout: 10_000 });
  expect(readFileSync(join(be.projectDir, 'assets', 'props', 'tiny-v1.glb')).equals(readFileSync(GLB))).toBe(true);

  // A folder from this computer: uploaded into assets/props/voice/, imported with its labels.
  const voice = join(local, 'voice');
  mkdirSync(join(voice, 'act2'), { recursive: true });
  writeFileSync(join(voice, 'line-001.ogg'), OPUS);
  writeFileSync(join(voice, 'line-002.ogg'), OPUS);
  writeFileSync(join(voice, 'act2', 'line-001.ogg'), OPUS);
  writeFileSync(join(voice, 'notes.txt'), 'script notes');
  await page.getByRole('button', { name: 'import folder…' }).click();
  await page.getByLabel('labels').fill('voice, act-1');
  await page.locator('.tl-assets__folder-input').setInputFiles(voice);
  const result = page.getByTestId('folder-import-result');
  await expect(result).toContainText('imported 3 assets', { timeout: 30_000 });
  await expect(result).toContainText('notes.txt');
  expect(readFileSync(join(be.projectDir, 'assets', 'props', 'voice', 'act2', 'line-001.ogg')).equals(OPUS)).toBe(true);
  expect(JSON.parse(readFileSync(join(be.projectDir, 'assets', 'props', 'voice', 'line-002.ogg.tlasset'), 'utf8'))).toMatchObject({ id: 'line-002', labels: ['act-1', 'voice'] });

  // A folder already in the game folder.
  mkdirSync(join(be.projectDir, 'assets', 'sfx'), { recursive: true });
  writeFileSync(join(be.projectDir, 'assets', 'sfx', 'jump.wav'), WAV);
  await page.getByLabel('folder to import').fill('assets/sfx');
  await page.getByLabel('labels').fill('sfx');
  await page.getByRole('group', { name: 'Folder import' }).getByRole('button', { name: 'import', exact: true }).click();
  await expect(result).toContainText('imported 1 asset', { timeout: 15_000 });

  // After a reload: the assets, their files and labels.
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await expect(tile(page, 'line-001')).toHaveCount(2, { timeout: 10_000 });
  await expect(tile(page, 'line-002')).toHaveCount(1);
  await tile(page, 'line-002').click();
  await expect(page.getByTestId('asset-labels')).toHaveText('labels: act-1, voice');
  await expect(page.locator('.tl-assets__source').first()).toHaveText('file: assets/props/voice/line-002.ogg');
  await tile(page, 'jump').click();
  await expect(page.getByTestId('asset-labels')).toHaveText('labels: sfx');
  await tile(page, 'tiny-v1').click();
  await expect(page.getByTestId('asset-labels')).toHaveCount(0);
  expect(errors).toEqual([]);
});
