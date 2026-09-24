/**
 * Phase 9.12: icons and gizmos. The generated icons load; a new point light's
 * hierarchy row shows the point-light icon; a moving platform's row the
 * mover icon; the Scene view draws a 2D outline for every collider (Beacon
 * Reach's grounds and steps) and the Gizmos menu turns the outlines, icons,
 * light ranges and gameplay helpers off and on. TL_GIZMO_SHOTS=<dir> saves
 * the Scene view with every helper on.
 */
import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('gizmos-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

const ICONS = ['light-point', 'light-spot', 'light-hemisphere', 'audio-source', 'pickup', 'enemy', 'mover', 'switch', 'door', 'sensor', 'fog', 'sky'];

test('the new icons load, rows use them, collider outlines are drawn and the Gizmos menu toggles the helpers', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // Every generated icon is served as a PNG that decodes.
  const sizes = await page.evaluate(async (names) => {
    const out: Record<string, number> = {};
    for (const n of names) {
      const img = new Image();
      img.src = `./icons/${n}.png`;
      await img.decode().catch(() => undefined);
      out[n] = img.naturalWidth;
    }
    return out;
  }, ICONS);
  for (const n of ICONS) expect(sizes[n], n).toBe(256);

  // Rows show what an entity is.
  await menu(page, 'GameObject', 'Light', 'Point light');
  const lightRow = page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: /point light/i }).first();
  await expect(lightRow.locator('img.tl-row__icon')).toHaveAttribute('src', /light-point\.png$/);
  await menu(page, 'GameObject', 'Gameplay', 'Trigger');
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Trigger' }).locator('img.tl-row__icon')).toHaveAttribute('src', /sensor\.png$/);
  await menu(page, 'GameObject', 'Gameplay', 'Moving platform');
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Moving platform' })).toHaveCount(1);

  // Collider outlines: Beacon Reach's grounds and steps plus the platform.
  const view = page.locator('canvas[data-collider-outlines]');
  await expect.poll(async () => Number(await view.getAttribute('data-collider-outlines'))).toBeGreaterThanOrEqual(6);
  await expect(view).toHaveAttribute('data-mover-paths', '1');
  await expect(view).toHaveAttribute('data-gizmos', 'icons lights colliders gameplay');
  if (process.env['TL_GIZMO_SHOTS'] !== undefined) await page.screenshot({ path: `${process.env['TL_GIZMO_SHOTS']}/scene-gizmos.png` });

  // The Gizmos menu turns them off and on.
  await menu(page, 'Gizmos', 'Collider outlines: on');
  await expect(view).toHaveAttribute('data-gizmos', 'icons lights gameplay');
  await menu(page, 'Gizmos', 'Icons: on');
  await menu(page, 'Gizmos', 'Light ranges: on');
  await menu(page, 'Gizmos', 'Gameplay paths and areas: on');
  await expect(view).toHaveAttribute('data-gizmos', '');
  await menu(page, 'Gizmos', 'Collider outlines: off');
  await expect(view).toHaveAttribute('data-gizmos', 'colliders');
});
