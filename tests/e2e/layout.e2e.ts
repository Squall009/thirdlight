/**
 * The Unity-like editor layout: hierarchy left, Scene/Game tabs in the
 * centre, inspector right, a tabbed dock along the bottom, and splitters
 * that resize the docks and are remembered by the browser.
 */
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('layout-0001', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

async function open(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
}
const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;

test('docks sit where Unity puts them and the bottom dock hosts the panels', async ({ page }) => {
  await open(page);
  const hier = await box(page, '.tl-dock--left');
  const stage = await box(page, '.tl-app__stage');
  const insp = await box(page, '.tl-dock--right');
  const bottom = await box(page, '.tl-dock--bottom');
  // Left → centre → right, all in the top row.
  expect(hier.x + hier.width).toBeLessThanOrEqual(stage.x + 1);
  expect(stage.x + stage.width).toBeLessThanOrEqual(insp.x + 1);
  expect(Math.abs(hier.y - stage.y)).toBeLessThan(40);
  // The bottom dock is under the hierarchy and the stage, not under the inspector.
  expect(bottom.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1);
  expect(bottom.x + bottom.width).toBeLessThanOrEqual(insp.x + 1);
  expect(bottom.width).toBeGreaterThan(hier.width + stage.width - 20);
  // The inspector runs the full height (down to the status bar).
  expect(insp.y + insp.height).toBeGreaterThan(bottom.y + bottom.height - 2);
  // The scene view gets most of the width.
  expect(stage.width).toBeGreaterThan(page.viewportSize()!.width * 0.5);

  // Hierarchy is always visible; the panels live in the bottom dock.
  await expect(page.locator('.tl-dock--left .tl-hierarchy__list li')).toHaveCount(18); // 17 + the "Fall zone" the v3→v4 upgrade makes from killY
  await page.getByRole('tab', { name: 'Assets' }).click();
  await expect(page.locator('.tl-dock--bottom .tl-assets__list')).toBeVisible();
  // Tile and hierarchy icons are real image files that load.
  await expect.poll(() => page.locator('.tl-tile__img').first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.tl-row__icon').first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.tl-btn__icon').first().evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await page.getByRole('tab', { name: /Problems/ }).click();
  await expect(page.locator('.tl-dock--bottom .tl-problems, .tl-dock--bottom .tl-panel').first()).toBeVisible();
  await expect(page.locator('.tl-dock--left .tl-hierarchy__list li')).toHaveCount(18);
});

test('Play opens in the Game tab; the Scene tab shows the viewport while the game keeps running', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('tab', { name: 'Scene' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Game', exact: true }).click();
  await expect(page.getByText('Press ▶ play to run the game here.')).toBeVisible();
  await page.getByRole('tab', { name: 'Scene' }).click();

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect(page.getByRole('tab', { name: 'Game', exact: true })).toHaveAttribute('aria-selected', 'true');
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  const stage = await box(page, '.tl-app__stage');
  const f = await box(page, 'iframe.tl-app__preview-frame');
  expect(f.width).toBeGreaterThan(stage.width * 0.95);
  expect(f.height).toBeGreaterThan(stage.height * 0.85);

  const observe = async (): Promise<string | null> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/observe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    return ((await r.json()) as { state?: string }).state ?? null;
  };
  await expect.poll(observe, { timeout: 15_000 }).toBe('awaitingStart');

  // Scene tab: the viewport is back; the game is still there (observable, hidden not unmounted).
  await page.getByRole('tab', { name: 'Scene' }).click();
  await expect(frame).toBeHidden();
  await expect(frame).toHaveCount(1);
  expect(await observe()).toBe('awaitingStart');
  await page.getByRole('tab', { name: 'Game', exact: true }).click();
  await expect(frame).toBeVisible();

  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Scene' })).toHaveAttribute('aria-selected', 'true');
});

test('splitters resize the docks, the viewport follows, and the sizes survive a reload', async ({ page }) => {
  await open(page);
  const before = await box(page, '.tl-dock--left');
  const canvasBefore = await box(page, 'canvas.tl-viewport');
  const handle = await box(page, '[aria-label="Resize the hierarchy"]');
  await page.mouse.move(handle.x + 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x + 122, handle.y + 200, { steps: 6 });
  await page.mouse.up();
  const after = await box(page, '.tl-dock--left');
  expect(Math.round(after.width - before.width)).toBe(120);
  const canvasAfter = await box(page, 'canvas.tl-viewport');
  expect(Math.round(canvasBefore.width - canvasAfter.width)).toBe(120);
  // The canvas backing store followed the element (no stretched pixels).
  const backing = await page.locator('canvas.tl-viewport').evaluate((c) => ({ w: (c as HTMLCanvasElement).width, cw: c.clientWidth, dpr: window.devicePixelRatio }));
  expect(Math.abs(backing.w - backing.cw * backing.dpr)).toBeLessThanOrEqual(2);

  const bottomBefore = await box(page, '.tl-dock--bottom');
  const h = await box(page, '[aria-label="Resize the bottom panel"]');
  await page.mouse.move(h.x + 300, h.y + 2);
  await page.mouse.down();
  await page.mouse.move(h.x + 300, h.y - 78, { steps: 6 });
  await page.mouse.up();
  expect(Math.round((await box(page, '.tl-dock--bottom')).height - bottomBefore.height)).toBe(80);

  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  expect(Math.round((await box(page, '.tl-dock--left')).width)).toBe(Math.round(after.width));
  expect(Math.round((await box(page, '.tl-dock--bottom')).height)).toBe(Math.round(bottomBefore.height + 80));
});
