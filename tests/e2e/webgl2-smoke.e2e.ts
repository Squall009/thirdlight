/**
 * The WebGL 2 fallback's one smoke test. WebGPU is the renderer the product
 * is built and tested on; WebGL 2 serves drivers where WebGPU fails, keeps
 * what it draws today and gets no new features and no parity checks. This
 * file is all of its coverage: forced with `?renderer=webgl2`, the editor
 * opens a project whose scene holds a box and a voxel world and the Scene
 * view draws, Play runs and draws the voxel world, the voxel world page
 * draws it, and the export, served statically with the backend stopped,
 * streams and draws it; no page logs a console error.
 *
 * "Draws" is read in pixels: a picture with the scene in it differs from the
 * picture of nothing (the clear colour, or the sky alone) over a real share
 * of its pixels, and a voxel world's chunks are counted drawn by its page.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect as baseExpect, test, type Locator, type Page } from './pw';

import { serveDir, startBackend, type E2EBackend } from './backend';
import { consoleErrors } from './console-errors';
import { decodePng, type Image } from './png';
import { menu } from './ui';
import { writeSliceWorld } from '../../tools/voxel-bench/slice-world';

/**
 * The least share of a drawn picture off its most common colour (see `drawnShare`): any scene (the Scene view's
 * sky, ground and box measured 35 %), and a voxel world filling the view (ground, wall and pad measured 66–85 %).
 */
const DRAWN_SHARE = 0.2;
const WORLD_SHARE = 0.5;

// A forced backend on a loaded host starts slowly: poll generously.
const expect = baseExpect.configure({ timeout: 30_000 });

let be: E2EBackend;
test.afterEach(async () => {
  await be?.stop();
});

/**
 * The share of pixels (every other row and column) that differ by more than `delta` in a channel from the
 * picture's most common colour. A canvas that drew nothing (its clear colour), or one flat colour, has none;
 * a scene (sky, ground, objects, shading) has a real share.
 */
function drawnShare(img: Image, delta = 24): number {
  const seen = new Map<number, number>();
  const px: [number, number, number][] = [];
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      px.push([r!, g!, b!]);
      const k = (r! << 16) | (g! << 8) | b!;
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
  }
  let top = 0;
  let most = 0;
  for (const [k, n] of seen) if (n > most) [top, most] = [k, n];
  const c = [(top >> 16) & 255, (top >> 8) & 255, top & 255];
  return px.filter((p) => Math.max(Math.abs(p[0] - c[0]!), Math.abs(p[1] - c[1]!), Math.abs(p[2] - c[2]!)) > delta).length / px.length;
}

/** The canvas reports WebGL 2, ready (no silent fallback), and draws a scene: a real share of the picture is not one flat colour. */
async function expectWebGl2(canvas: Locator, shoot: () => Promise<Buffer>, what: string): Promise<void> {
  await expect.poll(() => canvas.evaluate((c) => `${c.getAttribute('data-tl-renderer')}/${c.getAttribute('data-tl-renderer-state')}`)).toBe('webgl2/ready');
  let share = 0;
  await expect.poll(async () => (share = drawnShare(decodePng(await shoot()))), { message: `${what}: a scene is drawn` }).toBeGreaterThan(DRAWN_SHARE);
  console.log(`[webgl2-smoke] ${what}: ${(share * 100).toFixed(0)} % of the picture off its most common colour`);
}

/** A game page's voxel world (Play's frame, or the export) draws chunks and its ground fills the picture's lower half. */
async function expectVoxelWorld(canvas: Locator, shoot: () => Promise<Buffer>, what: string): Promise<void> {
  const chunks = (): Promise<number> => canvas.evaluate(() => (window as unknown as { __tlVoxelPlay?: { stats(): { worlds: Record<string, { chunks: number }> } } }).__tlVoxelPlay?.stats().worlds['slice']?.chunks ?? 0);
  await expect.poll(chunks, { timeout: 60_000, message: `${what}: the voxel world's chunks are drawn` }).toBeGreaterThan(10);
  const png = await shoot();
  writeFileSync(test.info().outputPath(`${what}.png`), png);
  const share = drawnShare(decodePng(png));
  console.log(`[webgl2-smoke] ${what}: ${await chunks()} chunks drawn, ${(share * 100).toFixed(0)} % of the picture off its most common colour`);
  expect(share, `${what}: the world drawn`).toBeGreaterThan(WORLD_SHARE);
}

const voxelHook = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => (window as unknown as { __tlVoxelWorld: Record<string, (...x: unknown[]) => unknown> }).__tlVoxelWorld[f as string]!(...(a as unknown[])) as T, [fn, args] as const);

async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-webgl2-smoke' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

test('WebGL 2 forced: the Scene view, Play, a voxel world and the export served with the backend stopped all draw, with no console error', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('webgl2-smoke');
  // A small voxel world in the project (128 m square), in the scene with a camera looking down at its wall scene:
  // Play and the export stream and draw it.
  const scene = writeSliceWorld(be.projectDir, 'slice', 256).scene;
  const at = scene.map((c) => c * 0.5);
  const pitch = (35 * Math.PI) / 180;
  await command('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'World', transform: { position: [0, 0, 0] }, components: { voxelWorld: { world: 'slice' } } });
  await command('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'World camera', transform: { position: [at[0]!, at[1]! + 5, at[2]! + 7], rotation: [-Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] }, components: { virtualCamera: { rig: 'fixed', priority: 30, blend: 'cut', fovY: 60, near: 0.1, far: 300 } } });
  const errors = consoleErrors(page);

  await page.goto(be.editorUrl.replace('#', '&renderer=webgl2#'));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await menu(page, 'GameObject', 'Box');
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'box' })).toHaveCount(1);
  const view = page.locator('canvas.tl-viewport');
  await expectWebGl2(view, () => view.screenshot(), 'Scene view');

  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  const playCanvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  await expectWebGl2(playCanvas, () => frame.screenshot(), 'Play');
  await expectVoxelWorld(playCanvas, () => frame.screenshot(), 'Play');
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
  expect((await voxelHook<{ drawn: number }>(page, 'state')).drawn).toBeGreaterThan(10);
  const pagePng = await page.screenshot();
  writeFileSync(test.info().outputPath('voxel-page.png'), pagePng);
  const pageShare = drawnShare(decodePng(pagePng));
  console.log(`[webgl2-smoke] voxel page: ${(pageShare * 100).toFixed(0)} % of the picture off its most common colour`);
  expect(pageShare, 'the voxel world page draws the world').toBeGreaterThan(WORLD_SHARE);
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
    const canvas = game.locator('canvas').first();
    await expectWebGl2(canvas, () => game.screenshot(), 'export');
    await expectVoxelWorld(canvas, () => game.screenshot(), 'export');
    expect(gameErrors).toEqual([]);
  } finally {
    await site.close();
  }
});
