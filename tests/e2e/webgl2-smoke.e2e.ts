/**
 * The WebGL 2 fallback's one smoke test. WebGPU is the renderer the product
 * is built and tested on; WebGL 2 serves drivers where WebGPU fails, keeps
 * what it draws today and gets no new features and no parity checks. This
 * file is all of its coverage: forced with `?renderer=webgl2`, the editor
 * opens a project and the Scene view draws, Play runs and draws, a voxel
 * world draws on its page, and the export, served statically with the
 * backend stopped, draws; no page logs a console error.
 */
import { join } from 'node:path';

import { expect as baseExpect, test, type Locator, type Page } from './pw';

import { serveDir, startBackend, type E2EBackend } from './backend';
import { consoleErrors } from './console-errors';
import { decodePng, type Image } from './png';
import { menu } from './ui';
import { writeSliceWorld } from '../../tools/voxel-bench/slice-world';

// A forced backend on a loaded host starts slowly: poll generously.
const expect = baseExpect.configure({ timeout: 30_000 });

let be: E2EBackend;
test.afterEach(async () => {
  await be?.stop();
});

/** Pixels brighter than the black clear colour in any channel (every other pixel of the picture). */
function brightPixels(img: Image, threshold = 40): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (Math.max(r, g, b) > threshold) n += 1;
    }
  }
  return n;
}

/** The canvas reports WebGL 2, ready (no silent fallback), and draws more than the clear colour. */
async function expectWebGl2(canvas: Locator, shoot: () => Promise<Buffer>): Promise<void> {
  await expect.poll(() => canvas.evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`)).toBe('webgl2/ready');
  await expect.poll(async () => brightPixels(decodePng(await shoot()))).toBeGreaterThan(20);
}

const voxelHook = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { __tlVoxelWorld: Record<string, (...x: unknown[]) => unknown> }).__tlVoxelWorld[f as string]!(...(a as unknown[])) as T, [fn, args] as const);

test('WebGL 2 forced: the Scene view, Play, a voxel world and the export served with the backend stopped all draw, with no console error', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('webgl2-smoke');
  // A small voxel world in the project (128 m square): the page streams and draws it.
  const scene = writeSliceWorld(be.projectDir, 'slice', 256).scene;
  const errors = consoleErrors(page);

  await page.goto(be.editorUrl.replace('#', '&renderer=webgl2#'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await menu(page, 'GameObject', 'Box');
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'box' })).toHaveCount(1);
  const view = page.locator('canvas.tl-viewport');
  await expectWebGl2(view, () => view.screenshot());

  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectWebGl2(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), () => frame.screenshot());
  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0);

  await page.goto(`${be.origin}/voxel-world.html?project=${be.projectId}&world=slice&at=${scene.join(',')}&renderer=webgl2&hud=0#token=${be.token}`);
  await page.waitForFunction(() => {
    const h = (window as unknown as { __tlVoxelWorld?: { ready?: boolean; failed?: string } }).__tlVoxelWorld;
    return h !== undefined && (h.ready === true || h.failed !== undefined);
  }, undefined, { timeout: 120_000 });
  expect(await page.evaluate(() => (window as unknown as { __tlVoxelWorld: { failed?: string } }).__tlVoxelWorld.failed ?? null)).toBeNull();
  expect(await page.evaluate(() => (window as unknown as { __tlVoxelWorld: { backend: string } }).__tlVoxelWorld.backend)).toBe('webgl2');
  await voxelHook(page, 'look', scene[0], scene[1] + 3, scene[2] + 2, -0.75, 0.42, 16);
  await voxelHook(page, 'settle');
  expect((await voxelHook<{ drawn: number }>(page, 'state')).drawn).toBeGreaterThan(0);
  await expect.poll(async () => brightPixels(decodePng(await page.screenshot()))).toBeGreaterThan(1000);
  expect(errors).toEqual([]);

  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await page.close();
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const gameErrors = consoleErrors(game);
  game.on('pageerror', (e) => gameErrors.push(e.message));
  try {
    await game.goto(`${site.url}?renderer=webgl2`);
    await expectWebGl2(game.locator('canvas').first(), () => game.screenshot());
    expect(gameErrors).toEqual([]);
  } finally {
    await site.close();
  }
});
