/**
 * Phase 9.5: the Environment window. A solid sky colour fills the Scene view's
 * background, the physical sky draws a sky, a vignette darkens the corners,
 * bloom brightens the view, a fog volume fills its box with fog (14.4: and thins
 * with height) — and Play and
 * the export render the same environment.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

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

/** Average colour of a rectangle given as fractions of the image. */
function avg(img: Image, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.floor(img.height * y0); y < Math.floor(img.height * y1); y += 3) {
    for (let x = Math.floor(img.width * x0); x < Math.floor(img.width * x1); x += 3) {
      const p = img.pixel(x, y);
      r += p[0];
      g += p[1];
      b += p[2];
      n += 1;
    }
  }
  return [r / n, g / n, b / n];
}
interface Look {
  top: [number, number, number];
  middle: [number, number, number];
  corner: [number, number, number];
  ok: boolean;
}
function look(img: Image): Look {
  const top = avg(img, 0.3, 0.02, 0.7, 0.1);
  const middle = avg(img, 0.35, 0.45, 0.65, 0.7);
  const corner = avg(img, 0, 0, 0.06, 0.08);
  const ok = top[2] - top[0] > 15 && bright(middle) > 160 && Math.abs(middle[2] - middle[0]) < 15 && bright(corner) < bright(middle) - 50;
  return { top, middle, corner, ok };
}
const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());
const bright = (c: [number, number, number]): number => (c[0] + c[1] + c[2]) / 3;
function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

test('sky, vignette, bloom and a fog volume in the Scene view, in Play and in the export', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await menu(page, 'GameObject', 'Box');
  const viewport = page.locator('canvas.tl-viewport');
  await viewport.click({ position: { x: 5, y: 5 } });
  const before = avg(await shot(viewport), 0.05, 0.02, 0.95, 0.15);

  // A solid sky colour: the top of the Scene view turns light blue (#7ec8ff).
  await page.getByRole('tab', { name: 'Environment' }).click();
  await page.getByRole('combobox', { name: 'sky mode' }).selectOption('color');
  await expect.poll(async () => avg(await shot(viewport), 0.05, 0.02, 0.95, 0.15)[2], { timeout: 10_000 }).toBeGreaterThan(before[2] + 80);
  // The physical sky: still a bright sky, now with a gradient.
  await page.getByRole('combobox', { name: 'sky mode' }).selectOption('procedural');
  await expect.poll(async () => bright(avg(await shot(viewport), 0.05, 0.02, 0.95, 0.12)), { timeout: 10_000 }).toBeGreaterThan(bright(before) + 40);
  await page.getByRole('combobox', { name: 'sky mode' }).selectOption('color');

  // A vignette darkens the corners against the bright sky.
  const corners = bright(avg(await shot(viewport), 0, 0, 0.06, 0.08));
  await page.getByRole('checkbox', { name: 'vignette' }).check();
  await expect.poll(async () => bright(avg(await shot(viewport), 0, 0, 0.06, 0.08)), { timeout: 10_000 }).toBeLessThan(corners - 30);

  // Bloom with threshold 0 and full strength: the box glows, the view brightens.
  const box = bright(avg(await shot(viewport), 0.4, 0.4, 0.6, 0.6));
  await page.getByRole('checkbox', { name: 'bloom', exact: true }).check();
  await page.getByRole('slider', { name: 'bloom threshold' }).focus();
  await page.keyboard.press('Home');
  await page.getByRole('slider', { name: 'bloom strength' }).focus();
  await page.keyboard.press('End');
  await expect.poll(async () => bright(avg(await shot(viewport), 0.4, 0.4, 0.6, 0.6)), { timeout: 10_000 }).toBeGreaterThan(box + 25);
  expect(((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['environment'] as { post: unknown }).post).toMatchObject({ bloom: { enabled: true, threshold: 0, strength: 3 } });
  await page.getByRole('checkbox', { name: 'bloom', exact: true }).uncheck();

  // A fog volume in front of the camera: the middle of the view gets foggy (#dfe7ef).
  const middle = bright(avg(await shot(viewport), 0.35, 0.45, 0.65, 0.7));
  await menu(page, 'GameObject', 'Light', 'Fog volume');
  await expect(page.locator('[aria-label="fog volume"]')).toBeVisible();
  await page.getByRole('slider', { name: 'fog density' }).focus();
  await page.keyboard.press('End');
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => bright(avg(await shot(viewport), 0.35, 0.45, 0.65, 0.7)), { timeout: 10_000 }).toBeGreaterThan(middle + 40);
  // Phase 14.4: the fog thins with height — at the fastest falloff almost none is left above the box bottom.
  const foggy = bright(avg(await shot(viewport), 0.35, 0.45, 0.65, 0.7));
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Fog volume' }).click();
  await page.getByRole('slider', { name: 'fog height falloff' }).focus();
  await page.keyboard.press('End');
  await expect.poll(async () => ((await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } }))['entities'] as { components: { fogVolume?: { heightFalloff?: number } } }[]).find((e) => e.components.fogVolume !== undefined)?.components.fogVolume?.heightFalloff).toBe(10);
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => bright(avg(await shot(viewport), 0.35, 0.45, 0.65, 0.7)), { timeout: 10_000 }).toBeLessThan(foggy - 30);
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Fog volume' }).click();
  await page.getByRole('slider', { name: 'fog height falloff' }).focus();
  await page.keyboard.press('Home');
  await viewport.click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => bright(avg(await shot(viewport), 0.35, 0.45, 0.65, 0.7)), { timeout: 10_000 }).toBeGreaterThan(foggy - 10);
  const env = (await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['environment'] as Record<string, unknown>;
  expect(env).toMatchObject({ sky: { mode: 'color' }, post: { vignette: { enabled: true } } });

  // Play: the sky colour and the fog volume are there.
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  // The camera stands just outside the dense volume: the middle is fog-grey,
  // the top still shows the blue sky through less fog, the corners are darker.
  let play: Look | null = null;
  await expect.poll(async () => (play = look(await shot(frame))).ok, { timeout: 20_000 }).toBe(true);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // Export, served statically.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(site.url);
    let out: Look | null = null;
    await expect.poll(async () => (out = look(await shot(exported))).ok, { timeout: 20_000 }).toBe(true);
    // The export renders what Play rendered.
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(out!.top[i]! - play!.top[i]!)).toBeLessThan(12);
      expect(Math.abs(out!.middle[i]! - play!.middle[i]!)).toBeLessThan(12);
    }
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
