/**
 * Viewport placeholders: cameras, lights, spawns and empty entities are icon
 * billboards that render on screen and are pickable by a click.
 */
import * as THREE from 'three';
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { colorCount, decodePng } from './png';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('icons-0001');
});
test.afterEach(async () => {
  await be.stop();
});

/** The viewport's default camera, to find where a world point is on screen. */
async function screenPoint(page: Page, world: [number, number, number]): Promise<{ x: number; y: number }> {
  const box = (await page.locator('canvas.tl-viewport').boundingBox())!;
  const camera = new THREE.PerspectiveCamera(50, box.width / box.height, 0.1, 1000);
  camera.position.set(6, 5, 6);
  camera.lookAt(0, 0.5, 0);
  camera.updateMatrixWorld();
  const p = new THREE.Vector3(...world).project(camera);
  return { x: box.x + ((p.x + 1) / 2) * box.width, y: box.y + ((1 - p.y) / 2) * box.height };
}

test('lights, spawns and empties show as icons that can be clicked to select', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  // Put a spawn and an empty at known spots (the menu creates at the focus point; move them by the inspector).
  await menu(page, 'GameObject', 'Player spawn');
  const rows = page.locator('.tl-hierarchy__list li');
  await expect(rows.filter({ hasText: 'Player spawn' })).toHaveCount(1);
  await page.getByLabel('position x').fill('2');
  await page.getByLabel('position x').press('Enter');
  await page.getByLabel('position y').fill('0.5');
  await page.getByLabel('position y').press('Enter');
  await page.getByLabel('position z').fill('0');
  await page.getByLabel('position z').press('Enter');
  await page.keyboard.press('Escape'); // clear the selection
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveCount(0);

  // The icon is drawn there: the pixels around the point are not the background.
  const at = await screenPoint(page, [2, 0.5, 0]);
  await page.waitForTimeout(400);
  const shot = await page.screenshot({ clip: { x: at.x - 16, y: at.y - 16, width: 32, height: 32 } });
  expect(colorCount(decodePng(shot))).toBeGreaterThan(3);

  // Clicking the icon selects the spawn.
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toContainText('Player spawn');

  // Lights are icons too: the ambient light of the starter scene is pickable at its position.
  const q = await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 64, offset: 0 } });
  const ambient = (q.entities as Array<{ id: string; name: string; components: { transform: { position: number[] }; light?: { type: string } } }>).find((e) => e.components.light?.type === 'ambient');
  expect(ambient).toBeDefined();
  const pos = ambient!.components.transform.position as [number, number, number];
  const lp = await screenPoint(page, pos);
  await page.mouse.click(lp.x, lp.y);
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toContainText(ambient!.name);
});
