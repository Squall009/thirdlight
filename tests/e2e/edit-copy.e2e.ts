/**
 * Phase-3 leftovers (2026-09-24): Duplicate a multi-selection with its
 * children in one undo, and Copy/Paste between scenes.
 */
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { createBox, menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

const rows = (page: Page) => page.locator('.tl-hierarchy__list li.tl-row');
const header = (page: Page, name: string) => page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: new RegExp(`^${name}$`) }) });
async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args: op === 'queryEntities' ? { limit: 200, offset: 0, ...args } : args });
}

test('Duplicate (Ctrl+D) copies the whole selection with children, one undo; Copy/Paste works across scenes', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const base = await rows(page).count();

  // Two boxes and a folder holding a third.
  await createBox(page);
  await createBox(page);
  await menu(page, 'GameObject', 'Folder');
  await expect(rows(page)).toHaveCount(base + 3);
  const folderRow = rows(page).filter({ hasText: 'folder' }).last();
  const folderId = (await folderRow.getAttribute('data-entity-id'))!;
  await createBox(page);
  await expect(rows(page)).toHaveCount(base + 4);
  const third = rows(page).last();
  const thirdId = (await third.getAttribute('data-entity-id'))!;
  expect((await be.command({ op: 'moveEntities', projectId: be.projectId, expectedRevision: (await query('queryEntities')).revision, requestId: `req-${'e'.repeat(31)}1`, args: { entityIds: [thirdId], parentId: folderId } })).ok).toBe(true);

  // Select the two loose boxes and the folder (Ctrl+click), then Ctrl+D.
  const boxes = rows(page).filter({ hasText: /^.*box.*$/ });
  const firstBox = boxes.nth(0);
  const secondBox = boxes.nth(1);
  await firstBox.click();
  await secondBox.click({ modifiers: ['Control'] });
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${folderId}"]`).click({ modifiers: ['Control'] });
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+d');
  // 2 boxes + folder + its box = 4 new rows, in one command.
  await expect(rows(page)).toHaveCount(base + 8);
  const all = (await query('queryEntities')).entities as { id: string; parentId?: string; components: { folder?: object; transform?: { position: number[] } } }[];
  const folders = all.filter((e) => e.components.folder !== undefined);
  expect(folders).toHaveLength(2);
  const copyFolder = folders.find((f) => f.id !== folderId)!;
  expect(all.filter((e) => e.parentId === copyFolder.id)).toHaveLength(1);
  // Copies sit 0.5 m to the right of their originals.
  const orig = all.find((e) => e.id === (thirdId))!;
  const copyOfThird = all.find((e) => e.parentId === copyFolder.id)!;
  expect(copyOfThird.components.transform!.position[0]! - orig.components.transform!.position[0]!).toBeCloseTo(0.5, 5);
  await page.keyboard.press('Control+z');
  await expect(rows(page)).toHaveCount(base + 4);

  // Copy the two boxes, make a second scene, paste: the copies land there.
  await firstBox.click();
  await secondBox.click({ modifiers: ['Control'] });
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+c');
  await expect(page.locator('.tl-notice, [role="status"]').filter({ hasText: 'Copied 2 objects' }).first()).toBeVisible();
  await page.getByRole('button', { name: '+ Scene' }).click();
  await expect(header(page, 'Scene 2')).toHaveClass(/is-active/);
  const scenes = (await query('queryProject')).scenes as { sceneId: string; name: string }[];
  const secondId = scenes.find((s) => s.name === 'Scene 2')!.sceneId;
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+v');
  await expect(rows(page)).toHaveCount(base + 6);
  const inSecond = (await query('queryEntities', { sceneId: secondId })).entities as { id: string }[];
  expect(inSecond).toHaveLength(2);
  // The Edit menu offers the same.
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('menuitem', { name: /Paste/ })).toBeEnabled();
});
