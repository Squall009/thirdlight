/**
 * Phase 9.5: point, spot and hemisphere lights. A red point light next to a
 * box tints it in the Scene view (game lighting) and in Play; the light is
 * edited in the Inspector; the Scene view toggles between the editor rig and
 * the scene's own lights.
 */
import { expect, test } from '@playwright/test';

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

function reddish(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
    const [r, g, b] = img.pixel(x, y);
    if (r > 60 && r > 1.8 * g && r > 1.8 * b) n += 1;
  }
  return n;
}

test('a red point light tints a box in the Scene view and in Play; lights are edited in the Inspector', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  // The new project has a sun and an ambient light: the Scene view uses them.
  await expect(page.getByRole('button', { name: 'light: game' })).toBeVisible();
  await menu(page, 'GameObject', 'Box');
  await menu(page, 'GameObject', 'Light', 'Point light');
  const lightRow = page.locator('.tl-hierarchy__list li.tl-row.is-selected');
  await expect(lightRow).toContainText('Point light');
  const lightId = (await lightRow.getAttribute('data-entity-id'))!;
  // Red, strong, close to the box (the box sits at the view focus; the light 1 m above it).
  await expect(page.locator('[aria-label="light component"]')).toBeVisible();
  const colour = page.getByLabel('light color', { exact: true });
  await colour.focus();
  await colour.evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(el, '#ff0000');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await colour.blur();
  await page.getByRole('slider', { name: 'light intensity' }).focus();
  await page.keyboard.press('End');
  const box = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['entities'] as { id: string; components: { box?: object; transform: { position: number[] } } }[];
  const boxPos = box.find((e) => e.components.box !== undefined)!.components.transform.position;
  const q = await be.command({ op: 'queryProject', projectId: be.projectId });
  const moved = await be.command({ op: 'setTransform', projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${'b'.repeat(31)}1`, args: { entityId: lightId, transform: { position: [boxPos[0]!, boxPos[1]! + 1.2, boxPos[2]! + 1.2] } } });
  expect(moved['ok'], JSON.stringify(moved)).toBe(true);
  const light = (await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: lightId } }))['entity'] as { components: { light: { color: string; intensity: number } } };
  expect(light.components.light).toMatchObject({ color: '#ff0000', intensity: 1000 });

  const viewport = page.locator('canvas.tl-viewport');
  await page.locator('canvas.tl-viewport').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => reddish(decodePng(await viewport.screenshot())), { timeout: 10_000 }).toBeGreaterThan(300);
  // The editor rig ignores the scene's lights.
  await page.getByRole('button', { name: 'light: game' }).click();
  await expect(page.getByRole('button', { name: 'light: editor' })).toBeVisible();
  await expect.poll(async () => reddish(decodePng(await viewport.screenshot()))).toBeLessThan(100);
  await page.getByRole('button', { name: 'light: editor' }).click();

  // Play shows the same light.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expect.poll(async () => reddish(decodePng(await frame.screenshot())), { timeout: 15_000 }).toBeGreaterThan(200);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
