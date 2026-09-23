/**
 * The menu bar: everything the backend offers is reachable by mouse —
 * creating lights/cameras/spawns/empties, duplicating, adding and removing
 * components, exporting the game and downloading it, switching windows.
 */
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { closeMenu, menu, menuItem } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('menu-0001');
});
test.afterEach(async () => {
  await be.stop();
});

const rows = (page: Page) => page.locator('.tl-hierarchy__list li.tl-row:not(.tl-row--empty)');
async function open(page: Page): Promise<number> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  return rows(page).count();
}

test('GameObject menu creates lights, spawns, empties; one camera and one light of each type per scene', async ({ page }) => {
  const base = await open(page);
  // The starter scene already has its camera and both lights: the items say so.
  await expect(await menuItem(page, 'GameObject', 'Camera')).toBeDisabled();
  await closeMenu(page);
  const dir = await menuItem(page, 'GameObject', 'Light');
  await dir.hover();
  await expect(dir.getByRole('menuitem', { name: 'Directional light', exact: true })).toBeDisabled();
  await expect(dir.getByRole('menuitem', { name: 'Ambient light', exact: true })).toBeDisabled();
  await closeMenu(page);
  // Delete the starter lights, then create both kinds from the menu.
  const lightRows = rows(page).filter({ has: page.locator('.tl-row__kind', { hasText: /^light$/ }) });
  await expect(lightRows).toHaveCount(2);
  for (let i = 0; i < 2; i += 1) {
    await lightRows.first().click();
    await menu(page, 'Edit', 'Delete');
  }
  await expect(rows(page)).toHaveCount(base - 2);
  await menu(page, 'GameObject', 'Light', 'Directional light');
  await expect(rows(page).filter({ hasText: 'Directional light' })).toHaveCount(1);
  await menu(page, 'GameObject', 'Light', 'Ambient light');
  await menu(page, 'GameObject', 'Player spawn');
  await menu(page, 'GameObject', 'Create empty');
  await expect(rows(page)).toHaveCount(base + 2);
  // The new light is selected and the inspector shows it.
  await rows(page).filter({ hasText: 'Directional light' }).click();
  await expect(page.locator('input.tl-inspector__name')).toHaveValue('Directional light');
});

test('Edit → Duplicate copies the selection with its components; Component menu adds and removes', async ({ page }) => {
  const base = await open(page);
  await menu(page, 'GameObject', 'Box');
  await expect(rows(page)).toHaveCount(base + 1);
  // Component → Collider on the new (selected) box, then Duplicate: the copy carries the collider.
  await menu(page, 'Component', 'Collider (box)');
  await expect(page.locator('.tl-inspector')).toContainText('hx');
  const collider = await menuItem(page, 'Component', 'Collider (box)');
  await expect(collider).toBeDisabled();
  await closeMenu(page);
  await menu(page, 'Edit', 'Duplicate');
  await expect(rows(page)).toHaveCount(base + 2);
  await expect(rows(page).filter({ hasText: 'copy' })).toHaveCount(1);
  const copyCollider = await menuItem(page, 'Component', 'Collider (box)');
  await expect(copyCollider).toBeDisabled(); // the copy has it too
  await closeMenu(page);
  await menu(page, 'Component', 'Remove', 'collider');
  await expect(await menuItem(page, 'Component', 'Collider (box)')).toBeEnabled();
  await closeMenu(page);
  await menu(page, 'Edit', 'Delete');
  await expect(rows(page)).toHaveCount(base + 1);
  // Nothing selected: the item explains itself.
  await expect(await menuItem(page, 'Edit', 'Duplicate')).toBeDisabled();
  await closeMenu(page);
});

test('File → Export game… exports and downloads a zip holding the standalone game', async ({ page }) => {
  await open(page);
  await menu(page, 'File', 'Export game…');
  const dialog = page.getByRole('dialog', { name: 'Export game' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Export now' }).click();
  await expect(dialog).toContainText('Exported revision', { timeout: 60_000 });
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download zip' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^menu-0001-r\d+\.zip$/);
  const path = await download.path();
  const bytes = (await import('node:fs')).readFileSync(path!);
  expect(bytes.subarray(0, 4).toString('hex')).toBe('504b0304');
  const names = zipNames(bytes);
  expect(names).toContain('index.html');
  expect(names).toContain('manifest.json');
  expect(names.some((n) => n.startsWith('js/'))).toBe(true);
  // The export is listed for the project.
  const list = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/exports`, { headers: { authorization: `Bearer ${be.token}` } });
  expect(((await list.json()) as { exports: Array<{ dir: string }> }).exports.map((e) => e.dir)).toEqual(['menu-0001@r0']);
});

test('Window and Help menus: panels, views, shortcuts dialog', async ({ page }) => {
  await open(page);
  await menu(page, 'Window', 'Problems');
  await expect(page.getByRole('tab', { name: /Problems/ })).toHaveAttribute('aria-selected', 'true');
  await menu(page, 'Window', 'Game');
  await expect(page.getByRole('tab', { name: 'Game', exact: true })).toHaveAttribute('aria-selected', 'true');
  await menu(page, 'Help', 'Keyboard shortcuts');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('Undo / redo');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/** File names from a stored zip's local headers. */
function zipNames(b: Buffer): string[] {
  const names: string[] = [];
  let i = 0;
  while (i + 30 <= b.length && b.readUInt32LE(i) === 0x04034b50) {
    const size = b.readUInt32LE(i + 18);
    const n = b.readUInt16LE(i + 26);
    const x = b.readUInt16LE(i + 28);
    names.push(b.subarray(i + 30, i + 30 + n).toString('utf8'));
    i += 30 + n + x + size;
  }
  return names;
}

test('the full-screen button in the menu bar toggles the whole editor in and out of full screen', async ({ page }) => {
  await open(page);
  const btn = page.getByRole('button', { name: 'Full screen', exact: true });
  await expect(btn).toBeVisible();
  // Top right of the menu bar.
  const bar = (await page.getByRole('menubar').boundingBox())!;
  const b = (await btn.boundingBox())!;
  expect(b.x + b.width).toBeGreaterThan(bar.x + bar.width - 40);
  await btn.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement)).toBe(true);
  await expect(page.getByRole('button', { name: 'Exit full screen' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Exit full screen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});
