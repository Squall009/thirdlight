/**
 * A model whose image is a Basis KTX2, drawn by the editor worker's
 * thumbnail renderer on a GPU without compressed texture formats, against a
 * real backend and a real browser.
 *
 * The worker's WebGL 2 probe is made to report no compressed format (the
 * extensions hidden in that worker only), so the transcoder writes plain
 * RGBA — what a GPU without BC/ETC/ASTC gets. The KTX2 model's tile still
 * shows the model, and so does the next model's (the renderer goes on), in
 * the product's renderer (and WebGPU in the webgpu project). A first model
 * brings up the thumbnail worker, so its probe is hidden before the KTX2
 * model is read.
 */
import { join, resolve } from 'node:path';

import { expect, test, type Page, type Worker } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { projectWindow } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
const KTX2_GLB = join(REPO, 'fixtures', 'import-ext', 'ktx2-cube.glb');
const PNG_GLB = join(REPO, 'fixtures', 'import-ext', 'base-png.glb');
const NEXT_GLB = join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v1.glb');

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

/** In a worker: hide WebGL 2's compressed texture extensions (counted), as a GPU without them would. */
function hideCompressedFormats(): void {
  const g = globalThis as unknown as { __tlNoCompressed?: boolean; __tlHiddenCompressed?: number; WebGL2RenderingContext?: { prototype: { getExtension(name: string): unknown } } };
  if (g.__tlNoCompressed === true) return;
  g.__tlNoCompressed = true;
  g.__tlHiddenCompressed = 0;
  const proto = g.WebGL2RenderingContext?.prototype;
  if (proto === undefined) return;
  const get = proto.getExtension;
  proto.getExtension = function (this: unknown, name: string): unknown {
    if (/compress/i.test(String(name))) {
      g.__tlHiddenCompressed = (g.__tlHiddenCompressed ?? 0) + 1;
      return null;
    }
    return get.call(this, name);
  };
}

async function importModel(page: Page, file: string, name: string): Promise<void> {
  await projectWindow(page);
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li.tl-tile').filter({ hasText: name })).toHaveCount(1, { timeout: 15_000 });
}

/** The thumbnail PNG of the model tile named `name`, once it shows one. */
async function thumbnailOf(page: Page, name: string): Promise<Buffer> {
  const tile = page.locator('.tl-assets__list li.tl-tile').filter({ hasText: name });
  const img = tile.locator('img.tl-tile__img--thumb');
  await expect(img).toHaveCount(1, { timeout: 60_000 });
  const b64 = await img.evaluate(async (el) => {
    const bytes = new Uint8Array(await (await fetch((el as HTMLImageElement).src)).arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  });
  return Buffer.from(b64, 'base64');
}

function opaqueSamples(png: Buffer): number {
  const img = decodePng(png);
  let opaque = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (img.pixel(x, y)[3] > 200) opaque += 1;
  return opaque;
}

for (const variant of RENDERER_VARIANTS) {
  test(`a KTX2 model transcoded to RGBA draws its thumbnail, and the next model draws too (${variant})`, async ({ page }) => {
    onlyInItsProject(variant);
    test.setTimeout(240_000);
    be = await startBackend(`ktx2-rgba-${variant}`);
    const workers: Worker[] = [];
    // Patched as soon as each worker can run code (a worker just made may not answer yet: tried again).
    const patched: Promise<boolean>[] = [];
    page.on('worker', (w) => {
      workers.push(w);
      patched.push((async () => {
        for (let i = 0; i < 200; i += 1) {
          try {
            await w.evaluate(hideCompressedFormats);
            return true;
          } catch {
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        return false;
      })());
    });
    await page.goto(editorUrlFor(be.editorUrl, variant));
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    await expectRendererBackend(page.locator('canvas.tl-viewport'), variant);

    // The images stay inside the files, so the worker decodes the KTX2 itself.
    await projectWindow(page);
    await page.getByLabel('extract model textures').uncheck();
    // A first model brings up the thumbnail worker (patched as it starts).
    await importModel(page, PNG_GLB, 'base-png');
    const first = await thumbnailOf(page, 'base-png');
    expect(await Promise.all(patched)).not.toContain(false);
    await importModel(page, KTX2_GLB, 'ktx2-cube');
    const ktx2 = await thumbnailOf(page, 'ktx2-cube');
    await importModel(page, NEXT_GLB, 'tiny-v1');
    const next = await thumbnailOf(page, 'tiny-v1');
    // The RGBA path was taken: the worker's probe asked for compressed formats and was told none.
    const hidden = await Promise.all(workers.map((w) => w.evaluate(() => (globalThis as unknown as { __tlHiddenCompressed?: number }).__tlHiddenCompressed ?? 0).catch(() => 0)));
    expect(hidden.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    // Observed in pixels: each thumbnail shows its model on the transparent background.
    const counts = [opaqueSamples(first), opaqueSamples(ktx2), opaqueSamples(next)];
    console.log(`[ktx2-rgba] ${variant}: opaque samples base-png ${counts[0]}, ktx2-cube ${counts[1]}, tiny-v1 ${counts[2]}`);
    expect(counts[1], 'the KTX2 model').toBeGreaterThan(50);
    expect(counts[2], 'the model after it').toBeGreaterThan(50);
  });
}
