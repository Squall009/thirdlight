/**
 * Phase 9.13 fix: a texture sky is upright. An equirect that is blue above
 * the horizon and green below, imported as a texture and set as the sky,
 * shows blue at the top of Play's view and green at the bottom (it used to
 * show the ground overhead: the sky was uploaded unflipped). The Scene
 * view's camera looks down below the horizon, so its top shows ground.
 *
 * Phase 17.3: runs once per renderer variant (renderer-variants.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-sky-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

for (const variant of RENDERER_VARIANTS) test(`a texture sky is upright: sky above, ground below (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(120_000);
  const file = join(dir, 'sky.png');
  writeFileSync(file, makePng(256, 128, (_x, y) => (y < 64 ? [40, 110, 250, 255] : [40, 170, 40, 255])));
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'sky' })).toHaveCount(1, { timeout: 10_000 });
  const assets = (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } }))['assets'] as { assetId: string }[];
  const rev = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  const res = await be.command({ op: 'setEnvironment', projectId: be.projectId, expectedRevision: rev, requestId: `req-${'5'.repeat(32)}`, origin: { kind: 'mcp', clientId: 'e2e-sky' }, args: { environment: { sky: { mode: 'texture', texture: assets[0]!.assetId } } } });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  const viewport = page.locator('canvas.tl-viewport');
  const band = async (el: typeof viewport, from: number, to: number): Promise<[number, number, number]> => {
    const img = decodePng(await el.screenshot());
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = Math.floor(img.height * from); y < img.height * to; y += 3) {
      for (let x = Math.floor(img.width * 0.3); x < img.width * 0.7; x += 5) {
        const p = img.pixel(x, y);
        r += p[0];
        g += p[1];
        b += p[2];
        n += 1;
      }
    }
    return [r / n, g / n, b / n];
  };
  const blueness = async (el: typeof viewport, from: number, to: number): Promise<number> => {
    const c = await band(el, from, to);
    return c[2] - c[1];
  };
  // The Scene view's default camera looks down past the grid's far edge,
  // below the horizon: the top of that view is the sky's ground half.
  await expect.poll(() => blueness(viewport, 0.02, 0.12), { timeout: 20_000 }).toBeLessThan(-40);
  // Play looks level: sky above the horizon, ground below.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(() => blueness(frame, 0.02, 0.12), { timeout: 30_000 }).toBeGreaterThan(40);
  expect(await blueness(frame, 0.88, 0.98)).toBeLessThan(-40);
});
