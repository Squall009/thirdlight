/**
 * Standalone textures. A PNG imports as a `texture` asset whose tile
 * shows the image itself.
 *
 * A texture on a material shows on a box in the Scene view and in
 * Play with every renderer variant (renderer-variants.ts): node materials on
 * WebGPURenderer (auto and WebGL 2 / WebGPU).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { menu } from './ui';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-tex-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a PNG imports as a texture asset and its tile shows the image', async ({ page }) => {
  test.skip(test.info().project.name === 'webgpu', 'no renderer involved (an <img> tile)');
  const file = join(dir, 'checker.png');
  writeFileSync(file, makePng(64, 64, (x, y) => ((x >> 3) + (y >> 3)) % 2 === 0 ? [240, 60, 60, 255] : [40, 40, 200, 255]));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'checker' });
  await expect(tile).toHaveCount(1, { timeout: 10_000 });
  await expect(tile).toContainText('texture');
  await expect(tile.locator('img.tl-tile__img--thumb')).toHaveAttribute('src', /^blob:/);
  const listed = await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 10, offset: 0 } });
  expect((listed['assets'] as { kind: string }[])[0]!.kind).toBe('texture');
  // A texture tile drags onto a material's texture slot (not into the scene).
  await expect(tile).toHaveAttribute('draggable', 'true');
});

/** The checker's red texels (240, 60, 60) as they come out lit (dim in Play's front light): clearly red, not the default box blue. */
function redPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 60 && r > 2 * g && r > 2 * b) n += 1;
    }
  }
  return n;
}
const reds = async (target: Locator): Promise<number> => redPixels(decodePng(await target.screenshot()));

async function importTexture(page: Page, file: string): Promise<void> {
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'checker' })).toHaveCount(1, { timeout: 10_000 });
}

for (const variant of RENDERER_VARIANTS) {
  test(`a material's texture shows on a box in the Scene view and Play (${variant})`, async ({ page }) => {
    onlyInItsProject(variant);
    test.setTimeout(150_000);
    const file = join(dir, 'checker.png');
    writeFileSync(file, makePng(64, 64, (x, y) => ((x >> 3) + (y >> 3)) % 2 === 0 ? [240, 60, 60, 255] : [40, 40, 200, 255]));
    await page.goto(editorUrlFor(be.editorUrl, variant));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    const viewport = page.locator('canvas.tl-viewport');
    await expectRendererBackend(viewport, variant);
    await importTexture(page, file);
    await page.getByRole('tab', { name: 'Materials' }).click();
    await page.getByRole('button', { name: '+ new material' }).click();
    await expect(page.locator('.tl-materials li[data-material-id]')).toHaveCount(1);
    await page.getByRole('combobox', { name: 'texture map' }).selectOption({ label: 'checker' });
    await menu(page, 'GameObject', 'Box');
    await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toContainText('box');
    const before = await reds(viewport);
    await page.getByRole('combobox', { name: 'material for all' }).selectOption({ label: 'Material 1' });
    await expect.poll(() => reds(viewport), { timeout: 15_000 }).toBeGreaterThan(before + 100);

    // Play draws the same textured box with the same backend.
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    const frame = page.locator('iframe.tl-app__preview-frame');
    await expect(frame).toBeVisible();
    await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
    await expect.poll(() => reds(frame), { timeout: 20_000 }).toBeGreaterThan(100);
    // The screenshot relay captures the same textured frame with the same backend.
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/screenshot`, {
      method: 'POST',
      headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
      body: JSON.stringify({ maxWidth: 512 }),
    });
    const shot = (await r.json()) as { dataUrl?: string; width?: number; error?: unknown };
    expect(r.status, JSON.stringify(shot).slice(0, 300)).toBe(200);
    const img = decodePng(Buffer.from(String(shot.dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));
    expect(img.width).toBeLessThanOrEqual(512);
    expect(redPixels(img)).toBeGreaterThan(50);
    await expect(page.locator('.tl-notice')).toHaveCount(0);
  });
}
