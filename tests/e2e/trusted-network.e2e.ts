/**
 * Trusted networks (THIRDLIGHT_TRUSTED_NETWORKS): a browser on a trusted
 * network opens the editor and the picker without being asked for the token;
 * anything else still needs it. Behind a listed proxy only the forwarded
 * client address counts, and the Origin allowlist still refuses other sites.
 */
import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { createBox } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

const status = (page: import('@playwright/test').Page) => page.locator('.tl-statusbar');

test('a browser on a trusted network is never asked for the token', async ({ page }) => {
  be = await startBackend('home-0001', undefined, { THIRDLIGHT_TRUSTED_NETWORKS: '127.0.0.0/8' });
  // No #token, nothing stored (a fresh browser context).
  await page.goto(`${be.origin}/`);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByLabel('Access token')).toHaveCount(0);
  await page.goto(`${be.origin}/?project=home-0001`);
  await expect(status(page)).toContainText('connected');
  const before = await page.locator('.tl-hierarchy__list li.tl-row').count();
  await createBox(page);
  await expect(page.locator('.tl-hierarchy__list li.tl-row')).toHaveCount(before + 1);
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await expect(page.getByLabel('Access token')).toHaveCount(0);

  // Another site cannot drive the API from a trusted browser.
  const cross = await fetch(`${be.origin}/api/v1/projects`, { headers: { origin: 'http://evil.example' } });
  expect(cross.status).toBe(403);
  expect(JSON.stringify(await cross.json())).toContain('bad_origin');
});

test('behind a trusted proxy the forwarded client decides; without it the token is required', async ({ page }) => {
  // The test client connects from 127.0.0.1, which is here the "proxy".
  be = await startBackend('home-0001', undefined, { THIRDLIGHT_TRUSTED_NETWORKS: '10.0.0.0/16', THIRDLIGHT_TRUSTED_PROXIES: '127.0.0.1' });
  const list = (xff?: string) => fetch(`${be!.origin}/api/v1/projects`, { headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });
  expect((await list('10.0.10.145')).status).toBe(200);
  expect((await list('203.0.113.9')).status).toBe(401);
  expect((await list()).status).toBe(401); // the proxy's own address does not count
  expect((await list('10.0.10.145, 203.0.113.9')).status).toBe(401); // a client cannot vouch for itself

  // A browser that is not (known to be) on the trusted network still gets the token form.
  await page.goto(`${be.origin}/?project=home-0001`);
  await expect(page.getByLabel('Access token')).toBeVisible();
  await page.getByLabel('Access token').fill(be.token);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(status(page)).toContainText('connected');
});
