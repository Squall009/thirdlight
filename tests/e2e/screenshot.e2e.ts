/**
 * Phase 25.2: Play screenshots (the relay behind `tl_screenshot`).
 *
 *  - The capture reads back the frame the renderer drew, on each backend
 *    (renderer-variants.ts): a GLB whose base colour is an embedded PNG is
 *    dragged into the scene, and the relay's PNG shows the texture's colour.
 *    On the webgpu project this is headless WebGPU (Dawn on SwiftShader
 *    without a GPU), so image textures upload there too.
 *  - A capture that fails always answers: the backend's reply carries the
 *    preview's reason instead of a `screenshot_timeout`, and the next
 *    capture works again.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Frame, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS, type RendererVariant } from './renderer-variants';

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-shot-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

/** Pixels that read as the texture's green (the untextured material is white/grey). */
function greenPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (g > 50 && g > 1.8 * r && g > 1.8 * b) n += 1;
    }
  }
  return n;
}

async function screenshot(psid: string, maxWidth: number): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/screenshot`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify({ maxWidth }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const pngOf = (dataUrl: unknown): Image => decodePng(Buffer.from(String(dataUrl).replace(/^data:image\/png;base64,/, ''), 'base64'));

/** Import the textured GLB, drag it into the scene and start Play; the play id. */
async function playTexturedCrate(page: Page, variant: RendererVariant): Promise<string> {
  const texture = makePng(32, 32, (x, y) => (((x >> 2) + (y >> 2)) % 2 === 0 ? [40, 220, 60, 255] : [20, 140, 40, 255]));
  const file = join(dir, 'crate.glb');
  writeFileSync(file, multiPieceGlb([{ name: 'crate', lods: [[2, 2, 2]] }], { texturePng: texture }));
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li[data-asset-id]:not([data-piece])').first();
  await expect(tile).toBeVisible({ timeout: 10_000 });
  await tile.dragTo(page.locator('canvas.tl-viewport'));
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'crate' })).toHaveCount(1, { timeout: 10_000 });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect(page.locator('iframe.tl-app__preview-frame')).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  return psid;
}

function previewFrame(page: Page): Frame {
  const f = page.frames().find((x) => x !== page.mainFrame() && x.parentFrame() === page.mainFrame() && x.url().includes('play'));
  if (f === undefined) throw new Error(`no preview frame among ${page.frames().map((x) => x.url()).join(', ')}`);
  return f;
}

for (const variant of RENDERER_VARIANTS) {
  test(`a Play screenshot shows the frame the renderer drew, image textures included (${variant})`, async ({ page }) => {
    onlyInItsProject(variant);
    test.setTimeout(150_000);
    const psid = await playTexturedCrate(page, variant);
    // The page shows the textured crate…
    await expect.poll(async () => greenPixels(decodePng(await page.locator('iframe.tl-app__preview-frame').screenshot())), { timeout: 20_000 }).toBeGreaterThan(200);
    // …and so does the relay's capture, read back from the renderer (downscaled to maxWidth).
    const shot = await screenshot(psid, 512);
    expect(shot.status, JSON.stringify(shot.json).slice(0, 300)).toBe(200);
    const img = pngOf(shot.json['dataUrl']);
    expect(img.width).toBe(512);
    expect(shot.json['width']).toBe(512);
    expect(greenPixels(img)).toBeGreaterThan(40);
    // Opaque: the WebGPU canvas is not read as transparent.
    expect(img.pixel(2, 2)[3]).toBe(255);
    await expect(page.locator('.tl-notice')).toHaveCount(0);
  });
}

test('a capture that fails answers with the reason, and the next one works', async ({ page }) => {
  test.setTimeout(150_000);
  test.skip(test.info().project.name === 'webgpu', 'renderer-independent (the default project runs it)');
  const psid = await playTexturedCrate(page, 'auto');
  await expect.poll(async () => (await screenshot(psid, 256)).status, { timeout: 20_000 }).toBe(200);

  // The canvas refuses to be read (as a tainted or lost canvas would).
  const frame = previewFrame(page);
  await frame.evaluate(() => {
    const proto = HTMLCanvasElement.prototype as unknown as { toDataURL: unknown; __tlToDataURL?: unknown };
    proto.__tlToDataURL = proto.toDataURL;
    proto.toDataURL = () => {
      throw new DOMException('the e2e refused the read', 'SecurityError');
    };
  });
  const t0 = Date.now();
  const failed = await screenshot(psid, 256);
  expect(failed.status).toBe(503);
  const error = failed.json['error'] as { code: string; cause?: string; message: string };
  expect(error.code).toBe('relay_failed');
  expect(error.cause).toBe('screenshot_failed');
  expect(error.message).toBe('screenshot failed in the preview: PNG capture failed: SecurityError: the e2e refused the read');
  // An answer, not the relay's timeout.
  expect(Date.now() - t0).toBeLessThan(5_000);

  await frame.evaluate(() => {
    const proto = HTMLCanvasElement.prototype as unknown as { toDataURL: unknown; __tlToDataURL?: unknown };
    proto.toDataURL = proto.__tlToDataURL;
  });
  const again = await screenshot(psid, 256);
  expect(again.status, JSON.stringify(again.json).slice(0, 300)).toBe(200);
  expect(greenPixels(pngOf(again.json['dataUrl']))).toBeGreaterThan(10);
});
