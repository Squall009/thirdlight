/**
 * Phase 12 (a) in a real browser against the real backend: folders, drag to
 * reorder / file (keeping world positions), multi-select and dragging a
 * selection, collapse state kept per browser, folder flags passed down
 * (inspector shows inherited values), locked = not pickable, inactive =
 * hidden in the Scene view and left out of Play. Every edit is a command
 * with undo.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import * as THREE from 'three';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

const status = (page: Page) => page.locator('.tl-statusbar');
const row = (page: Page, name: string): Locator => page.locator('.tl-hierarchy__list li.tl-row').filter({ has: page.locator('.tl-row__name', { hasText: new RegExp(`^${name}$`) }) });

async function openEditor(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');
}

let seq = 0;
/** One command through the backend's command route (the route the MCP adapter uses). */
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: q.revision,
    requestId: `req-${(0xe2e00 + seq).toString(16).padStart(32, '0')}`,
    origin: { kind: 'mcp', clientId: 'e2e-hierarchy' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

async function entity(id: string): Promise<{ entity: Record<string, unknown>; parentChain: string[] }> {
  const q = await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } });
  expect(q.ok, JSON.stringify(q)).toBe(true);
  return q as unknown as { entity: Record<string, unknown>; parentChain: string[] };
}

async function order(): Promise<string[]> {
  const q = await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } });
  return (q.entities as { id: string }[]).map((e) => e.id);
}

/** Drag a row onto another row: the top edge (before), the middle (into) or the bottom edge (after). */
async function drag(page: Page, source: Locator, target: Locator, where: 'before' | 'into' | 'after'): Promise<void> {
  const box = (await target.boundingBox())!;
  const y = where === 'before' ? 2 : where === 'after' ? box.height - 2 : box.height / 2;
  await source.dragTo(target, { targetPosition: { x: box.width / 2, y } });
}

/** Click an inspector flag checkbox; it follows the backend's answer (a command round trip). */
async function toggleFlag(page: Page, name: string, checked: boolean): Promise<void> {
  const box = page.getByRole('checkbox', { name });
  await expect(box).toBeChecked({ checked: !checked });
  await box.click();
  await expect(box).toBeChecked({ checked });
}

/** Pixels that are clearly the red test box. */
function redPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 80 && r > 3 * (g + b + 1)) n++;
    }
  }
  return n;
}

/** Pixels that are clearly the green reference box. */
function greenPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (g > 80 && g > 3 * (r + b + 1)) n++;
    }
  }
  return n;
}

/** Where a world point is on screen in the editor viewport's default camera. */
async function screenPoint(page: Page, world: [number, number, number]): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas.tl-viewport').boundingBox())!;
  const camera = new THREE.PerspectiveCamera(50, box.width / box.height, 0.1, 1000);
  camera.position.set(6, 5, 6);
  camera.lookAt(0, 0.5, 0);
  camera.updateMatrixWorld();
  const p = new THREE.Vector3(...world).project(camera);
  return { x: box.x + ((p.x + 1) / 2) * box.width, y: box.y + ((1 - p.y) / 2) * box.height };
}

test('folders: drag to file and reorder keeps world positions, a selection moves in one undo step, collapse is per browser', async ({ page }) => {
  await openEditor(page);
  await menu(page, 'GameObject', 'Folder');
  await expect(row(page, 'Folder')).toHaveCount(1);
  await expect(row(page, 'Folder').locator('.tl-row__kind')).toHaveText('folder');
  const folderId = (await row(page, 'Folder').getAttribute('data-entity-id'))!;
  // A folder has no transform: the inspector shows no position fields for it.
  await expect(page.getByLabel('position x')).toHaveCount(0);

  const alpha = String((await cmd('createEntity', { kind: 'box', name: 'alpha', transform: { position: [2, 0, 0] } })).createdId);
  const beta = String((await cmd('createEntity', { kind: 'box', name: 'beta', transform: { position: [-2, 0, 1] } })).createdId);
  const gamma = String((await cmd('createEntity', { kind: 'box', name: 'gamma', transform: { position: [0, 3, 0] } })).createdId);
  await expect(row(page, 'gamma')).toHaveCount(1);

  // Drop alpha into the folder: filed, same world position.
  await drag(page, row(page, 'alpha'), row(page, 'Folder'), 'into');
  await expect.poll(async () => (await entity(alpha)).parentChain).toEqual([folderId]);
  expect(((await entity(alpha)).entity.components as { transform: { position: number[] } }).transform.position).toEqual([2, 0, 0]);
  // The tree shows it indented under the folder.
  const indent = async (name: string) => Number.parseFloat(await row(page, name).evaluate((el) => (el as HTMLElement).style.paddingLeft));
  expect(await indent('alpha')).toBeGreaterThan(await indent('Folder'));

  // Reorder: beta onto the folder's top edge = before it, at the root.
  await drag(page, row(page, 'beta'), row(page, 'Folder'), 'before');
  await expect.poll(async () => { const o = await order(); return o.indexOf(beta) < o.indexOf(folderId); }).toBe(true);
  expect((await entity(beta)).parentChain).toEqual([]);

  // Multi-select beta + gamma (Ctrl+click) and drag the selection into the folder.
  await row(page, 'beta').click();
  await row(page, 'gamma').click({ modifiers: ['Control'] });
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toHaveCount(2);
  await drag(page, row(page, 'gamma'), row(page, 'Folder'), 'into');
  await expect.poll(async () => (await entity(gamma)).parentChain).toEqual([folderId]);
  expect((await entity(beta)).parentChain).toEqual([folderId]);
  expect(((await entity(beta)).entity.components as { transform: { position: number[] } }).transform.position).toEqual([-2, 0, 1]);
  // One undo puts both back.
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await entity(gamma)).parentChain).toEqual([]);
  expect((await entity(beta)).parentChain).toEqual([]);

  // Shift+click selects the visible range.
  await row(page, 'Folder').click();
  await row(page, 'gamma').click({ modifiers: ['Shift'] });
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toHaveCount(3); // Folder, alpha, gamma (beta is above)

  // Collapse the folder: alpha hides; the state survives a reload but is not project data.
  const revBefore = (await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision;
  await page.getByRole('button', { name: 'collapse Folder' }).click();
  await expect(row(page, 'alpha')).toHaveCount(0);
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await expect(row(page, 'Folder')).toHaveCount(1);
  await expect(row(page, 'alpha')).toHaveCount(0);
  expect((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision).toBe(revBefore);
  expect(await page.evaluate((id) => localStorage.getItem(`thirdlight.hierarchy.collapsed.${id}`), be.projectId)).toContain(folderId);
  await page.getByRole('button', { name: 'expand Folder' }).click();
  await expect(row(page, 'alpha')).toHaveCount(1);

  // Dragging out onto the empty list area files at the root, at the end.
  await row(page, 'alpha').dragTo(page.locator('.tl-hierarchy__list'), { targetPosition: { x: 60, y: (await page.locator('.tl-hierarchy__list').boundingBox())!.height - 10 } });
  await expect.poll(async () => (await order()).at(-1)).toBe(alpha);
  expect((await entity(alpha)).parentChain).toEqual([]);
});

test('folder flags pass down: inherited values in the inspector, locked is not pickable, inactive is hidden and left out of Play', async ({ page }) => {
  const folderId = String((await cmd('createEntity', { kind: 'folder', name: 'Hazards' })).createdId);
  const redId = String(
    (await cmd('createEntity', { kind: 'box', name: 'red', parentId: folderId, transform: { position: [0, 0.5, 0] }, box: { size: [1.5, 1.5, 1.5], material: { color: '#ff0000' } } })).createdId,
  );
  // A green box outside the folder proves a frame has been drawn before "no red" is believed.
  await cmd('createEntity', { kind: 'box', name: 'green', transform: { position: [-1.8, 0.5, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#00ff00' } } });
  await openEditor(page);
  const viewport = page.locator('canvas.tl-viewport');
  await expect.poll(async () => redPixels(decodePng(await viewport.screenshot()))).toBeGreaterThan(50);
  await page.screenshot({ path: 'test-results/hierarchy-active.png' });

  // Folder inactive: the box is hidden in the Scene view, its row is dimmed,
  // and its inspector shows the inherited value.
  await row(page, 'Hazards').click();
  await toggleFlag(page, 'Active', false);
  await expect.poll(async () => (await entity(folderId)).entity.active).toBe(false);
  await expect(row(page, 'red')).toHaveClass(/is-inactive/);
  await expect.poll(async () => redPixels(decodePng(await viewport.screenshot()))).toBe(0);
  expect(greenPixels(decodePng(await viewport.screenshot()))).toBeGreaterThan(10);
  await page.screenshot({ path: 'test-results/hierarchy-inactive.png' });
  await row(page, 'red').click();
  await expect(page.getByRole('checkbox', { name: 'Active' })).toBeChecked(); // its own value
  await expect(page.locator('.tl-flag__inherited[data-flag="active"]')).toHaveText('inactive — inherited from Hazards');

  // Play leaves the inactive subtree out.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expect.poll(async () => greenPixels(decodePng(await frame.screenshot())), { timeout: 15_000 }).toBeGreaterThan(10);
  expect(redPixels(decodePng(await frame.screenshot()))).toBe(0);
  await page.screenshot({ path: 'test-results/hierarchy-play-inactive.png' });
  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0);

  // Active again + locked: visible, but clicking it in the viewport does not pick it.
  await row(page, 'Hazards').click();
  await toggleFlag(page, 'Active', true);
  await toggleFlag(page, 'Locked', true);
  await expect.poll(async () => (await entity(folderId)).entity.locked).toBe(true);
  await expect(row(page, 'red').getByRole('img', { name: 'locked' })).toHaveCount(1);
  await expect.poll(async () => redPixels(decodePng(await viewport.screenshot()))).toBeGreaterThan(50);
  await page.keyboard.press('Escape');
  const at = await screenPoint(page, [0, 0.5, 0]);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toHaveCount(0);
  await row(page, 'red').click();
  await expect(page.locator('.tl-flag__inherited[data-flag="locked"]')).toHaveText('locked — inherited from Hazards');

  // Play shows it now.
  await page.getByTitle('Start an isolated play preview').click();
  await expect(frame).toBeVisible();
  await expect.poll(async () => redPixels(decodePng(await frame.screenshot())), { timeout: 15_000 }).toBeGreaterThan(50);
  await page.screenshot({ path: 'test-results/hierarchy-play-active.png' });
  await page.getByTitle('Stop the play preview').click();

  // Unlocked: the click picks it. Undo restores the lock.
  await row(page, 'Hazards').click();
  await toggleFlag(page, 'Locked', false);
  await expect.poll(async () => (await entity(folderId)).entity.locked).toBeUndefined();
  await page.keyboard.press('Escape');
  await page.mouse.click(at.x, at.y);
  await expect(row(page, 'red')).toHaveClass(/is-selected/);
  await viewport.hover();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await entity(folderId)).entity.locked).toBe(true);
  void redId;
});
