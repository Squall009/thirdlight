/**
 * Play and standalone export of a fresh project, observed as pixels.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { menu } from './ui';

import { colorCount, decodePng } from './png';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

/** A plain static file server: the exported game gets nothing else. */
function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

async function createBox(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await menu(page, 'GameObject', 'Box');
  await expect(page.locator('.tl-hierarchy__list li').filter({ hasText: 'box' })).toHaveCount(1);
}

test('Play renders a fresh project scene in the isolated preview', async ({ page }) => {
  await createBox(page);
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  // The box is drawn over the clear color: more than one color appears.
  await expect.poll(async () => colorCount(decodePng(await frame.screenshot())), { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.locator('.tl-notice')).toHaveCount(0);

  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0);
});

test('the play preview fills the centre view and its page is not scrollable', async ({ page }) => {
  await createBox(page);
  await page.getByTitle('Start an isolated play preview').click();
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  const stage = (await page.locator('.tl-app__stage').boundingBox())!;
  const full = (await frame.boundingBox())!;
  expect(full.width).toBeGreaterThan(stage.width * 0.95);
  expect(full.height).toBeGreaterThan(stage.height * 0.85);
  // The game page inside the frame fits it exactly: nothing to scroll.
  await expect
    .poll(() => page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').evaluate((c) => {
      const d = c.ownerDocument.documentElement;
      return { scrollable: d.scrollHeight > d.clientHeight || d.scrollWidth > d.clientWidth };
    }))
    .toMatchObject({ scrollable: false });
  await page.getByTitle('Stop the play preview').click();
});

test('the exported game runs from a plain static server with the backend stopped', async ({ page }) => {
  await createBox(page);
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await page.close();
  await be.halt();

  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const requests: string[] = [];
  game.on('request', (r) => requests.push(r.url()));
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    await expect.poll(async () => colorCount(decodePng(await game.screenshot())), { timeout: 15_000 }).toBeGreaterThan(1);
    expect(errors).toEqual([]);
    expect(await game.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight)).toBe(false);
    await expect(game.getByText(/error/i)).toHaveCount(0);
    expect(requests.every((u) => u.startsWith(site.url))).toBe(true);
  } finally {
    await site.close();
  }
});
