/**
 * Plain http on a LAN address is not a secure context: `crypto.subtle` is
 * undefined there. Play in the editor and the exported game must still
 * work (the artifact digests fall back to the pure SHA-256).
 */
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { serveDir } from '../support/serve-dir';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('lan-0001', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

/** A static server on a non-loopback address (a real insecure context), or null if the host has none. */
function serveOnLan(dir: string): Promise<{ url: string; close: () => Promise<void> } | null> {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
  if (lan === undefined) return Promise.resolve(null);
  return serveDir(dir, { host: lan.address });
}

// One backend for both: the export is made from the project Play just ran, then served with the backend stopped.
test('Play works in a page without WebCrypto (editor + preview frames); the exported game runs when served over plain http on a LAN address', async ({ context, page }) => {
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
    .toBe('running');
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  const problems = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/problems`, { headers: { authorization: `Bearer ${be.token}` } });
  expect(((await problems.json()) as { problems: unknown[] }).problems).toEqual([]);

  // The export over plain http on a LAN address (this context also has no crypto.subtle, as there).
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveOnLan(join(be.exportRoot, String(res.json.outputDir)));
  if (site === null) {
    test.info().annotations.push({ type: 'skipped part', description: 'export over LAN: this host has no non-loopback IPv4 address' });
    return;
  }
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(site.url);
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    // The starter plays as a scene: the export's own observation says it runs.
    await expect.poll(() => page.evaluate(() => (window as unknown as { __thirdlightObserve?: () => { state?: string } | null }).__thirdlightObserve?.()?.state ?? null), { timeout: 15_000 }).toBe('running');
    await expect(page.getByText(/export error/i)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
