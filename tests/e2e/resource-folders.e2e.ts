/**
 * Scenes and resources as files in the folders the user chooses, against the
 * real backend and Chromium:
 *
 * - with "new items in" set in the Assets tab, a new scene and a new material
 *   are written into that folder of the game folder;
 * - a scene file and a material file added outside the editor while it is
 *   open come in when the window gets focus back (the file check), as one
 *   command: the scene is offered to open with its objects, the material is
 *   listed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

const status = (page: Page) => page.locator('.tl-statusbar');
const header = (page: Page, name: string) => page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: new RegExp(`^${name}$`) }) });
const row = (page: Page, name: string) => page.locator('.tl-hierarchy__list li.tl-row').filter({ has: page.locator('.tl-row__name', { hasText: new RegExp(`^${name}$`) }) });

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}

test('new scenes and materials go into the folder named; files added outside the editor appear on window focus', async ({ page }) => {
  test.setTimeout(90_000);
  be = await startBackend();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');

  // The folder new items go into.
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.getByLabel('new item folder').fill('world/levels');

  // A new scene: written into that folder, found by its id.
  await page.getByRole('tab', { name: 'Scene' }).click();
  await page.getByRole('button', { name: '+ Scene' }).click();
  await expect(header(page, 'Scene 2')).toHaveCount(1);
  const scenes = (await query('queryProject')).scenes as { sceneId: string; name: string }[];
  const sceneId = scenes.find((s) => s.name === 'Scene 2')!.sceneId;
  expect(JSON.parse(readFileSync(join(be.projectDir, 'world', 'levels', `${sceneId}.scene.json`), 'utf8'))).toMatchObject({ type: 'scene', scene: { sceneId } });
  expect(existsSync(join(be.projectDir, 'scenes', `${sceneId}.json`))).toBe(false);

  // A new material: the same folder.
  await page.getByRole('tab', { name: 'Materials' }).click();
  await page.getByRole('button', { name: '+ new material' }).click();
  await expect(page.locator('.tl-materials li[data-material-id]')).toHaveCount(1);
  await expect.poll(() => readdirSync(join(be.projectDir, 'world', 'levels')).filter((n) => n.endsWith('.material.json')).length).toBe(1);

  // Outside the editor: a scene with one object, and a material, dropped into a folder.
  mkdirSync(join(be.projectDir, 'imported'), { recursive: true });
  const template = JSON.parse(readFileSync(join(be.projectDir, 'world', 'levels', `${sceneId}.scene.json`), 'utf8')) as Record<string, unknown>;
  const barrel = { id: 'barrel-900001', name: 'Barrel', components: { transform: { position: [0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [1, 1, 1], material: { color: '#aa5522' } } } };
  writeFileSync(join(be.projectDir, 'imported', 'Arena.scene.json'), JSON.stringify({ ...template, scene: { schemaVersion: 4, sceneId: 'arena', revision: 0, entities: [barrel] }, retry: { records: [] } }));
  writeFileSync(join(be.projectDir, 'imported', 'sand.material.json'), JSON.stringify({ tlresource: 1, kind: 'material', id: 'sand', data: { materialId: 'sand', name: 'Sand', shader: 'standard', params: { color: '#c2b280' }, textures: {} } }));

  // The window gets focus back: the file check takes both in.
  await page.getByRole('tab', { name: 'Scene' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const open = page.getByLabel('open scene');
  await expect(open.locator('option', { hasText: 'Arena' })).toHaveCount(1, { timeout: 15_000 });
  await open.selectOption({ label: 'Arena' });
  await expect(header(page, 'Arena')).toHaveCount(1);
  await expect(row(page, 'Barrel')).toHaveCount(1);
  await page.getByRole('tab', { name: 'Materials' }).click();
  await expect(page.locator('.tl-materials li[data-material-id="sand"]')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/resource-folders.png' });

  // It stays where it was put.
  const index = (await query('queryIndex', { kind: 'scene', id: 'arena' })) as { entries: { path: string }[] };
  expect(index.entries[0]?.path).toBe('imported/Arena.scene.json');
  expect(errors).toEqual([]);
});
