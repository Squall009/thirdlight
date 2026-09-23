/**
 * Plain http on a LAN address is not a secure context: `crypto.subtle` is
 * undefined there. Play in the editor and the exported game must still
 * work (the artifact digests fall back to the pure SHA-256).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('lan-0001', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

/** A static server on a non-loopback address (a real insecure context), or null if the host has none. */
function serveOnLan(dir: string): Promise<{ url: string; close: () => Promise<void> } | null> {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
  if (lan === undefined) return Promise.resolve(null);
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
    server.listen(0, lan.address, () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://${lan.address}:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('Play works in a page without WebCrypto (editor + preview frames)', async ({ context, page }) => {
  // Every frame of this context loses crypto.subtle, as on http://<lan-ip>.
  await context.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
  });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  expect(await page.evaluate(() => crypto.subtle === undefined)).toBe(true);
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect
    .poll(
      async () => {
        const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/observe`, {
          method: 'POST',
          headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
          body: '{}',
        });
        return ((await r.json()) as { state?: string }).state ?? null;
      },
      { timeout: 15_000 },
    )
    .toBe('awaitingStart');
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  const problems = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/problems`, { headers: { authorization: `Bearer ${be.token}` } });
  expect(((await problems.json()) as { problems: unknown[] }).problems).toEqual([]);
});

test('the exported game runs when served over plain http on a LAN address', async ({ page }) => {
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveOnLan(join(be.exportRoot, String(res.json.outputDir)));
  test.skip(site === null, 'this host has no non-loopback IPv4 address');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(site!.url);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    await expect(page.getByText('Press Enter or Space')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/export error/i)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await site!.close();
  }
});
