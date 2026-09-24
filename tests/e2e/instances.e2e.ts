/**
 * Phase 12 (c) instance sets in a real browser against the real backend: the
 * scatter dialog publishes a buffer and creates one entity that draws many
 * copies of a model (editor viewport and Play), the buffer route refuses bad
 * buffers, and a set loaded with its scene is drawn in Play.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { menu } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

const status = (page: Page) => page.locator('.tl-statusbar');

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-instances' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

test('the scatter dialog makes one entity that draws many copies; the buffer route refuses bad buffers', async ({ page }) => {
  be = await startBackend('inst-e2e', 'beacon-reach');
  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');

  await menu(page, 'GameObject', 'Instance set…');
  const dialog = page.getByRole('dialog', { name: 'Instance set' });
  await dialog.getByLabel('instance model').selectOption({ label: 'Beacon pillar' });
  await dialog.getByLabel('Copies').fill('60');
  await dialog.getByLabel('Width (X, m)').fill('24');
  await dialog.getByLabel('Depth (Z, m)').fill('10');
  await dialog.getByRole('button', { name: 'Create instance set' }).click();
  await expect(dialog).toHaveCount(0);

  const row = page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Beacon pillar ×60' });
  await expect(row).toHaveCount(1);
  const id = String(await row.getAttribute('data-entity-id'));
  const entity = (await query('queryEntity', { entityId: id })).entity as { components: { instances: { asset: { assetId: string }; buffer: string; count: number } } };
  expect(entity.components.instances.count).toBe(60);
  // The buffer is stored by its digest, 40 bytes per copy.
  const bytes = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/buffers/${entity.components.instances.buffer}`, { headers: { authorization: `Bearer ${be.token}` } });
  expect(bytes.status).toBe(200);
  const buf = Buffer.from(await bytes.arrayBuffer());
  expect(buf.length).toBe(60 * 40);
  expect(createHash('sha256').update(buf).digest('hex')).toBe(entity.components.instances.buffer);
  await row.click();
  await expect(page.locator('[data-instances="60"]')).toContainText('60 copies');
  await page.waitForTimeout(800);
  await page.screenshot({ path: 'test-results/instances-editor.png' });

  // Refused: a count that is not whole copies, a non-finite value, an unknown buffer.
  expect((await api('content/buffers', { transforms: [1, 2, 3] })).status).toBe(400);
  expect((await api('content/buffers', { transforms: [0, 0, 0, 0, 0, 0, 1, 1, 1, 'x'] })).status).toBe(400);
  const ghost = await be.command({
    op: 'setComponent',
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${'f'.repeat(32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-instances' },
    args: { entityId: id, component: 'instances', value: { buffer: 'a'.repeat(64), count: 60 } },
  });
  expect(ghost.ok).toBe(false);

  // In Play the set is drawn too (the camera starts near the pillars).
  await page.getByTitle('Start an isolated play preview').click();
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.waitForTimeout(3000);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/instances-play.png' });
});

test('an instance set in a scene loaded during Play is drawn once the scene loads', async ({ page }) => {
  be = await startBackend('inst-load', 'beacon-reach');
  // A row of pillars along the start ground (x 2..14), published through the route MCP uses.
  const transforms: number[] = [];
  for (let i = 0; i < 25; i += 1) transforms.push(2 + i * 0.5, 0, -2 - (i % 3), 0, 0, 0, 1, 0.3, 0.3, 0.3);
  const published = await api('content/buffers', { transforms });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  expect(published.json.count).toBe(25);
  const assets = (await query('queryAssets', { limit: 50, offset: 0 })).assets as { assetId: string; displayName: string }[];
  const pillar = assets.find((a) => a.displayName === 'Beacon pillar')!.assetId;
  await cmd('createScene', { sceneId: 'scene-grove', name: 'Grove' });
  await cmd('createEntity', { sceneId: 'scene-grove', kind: 'group', name: 'Grove', components: { instances: { asset: { assetId: pillar }, buffer: published.json.digest, count: 25 } } });

  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async () => (await api(`play/${psid}/observe`, {})).json as { state?: string; scenes?: { loaded: string[] } };
  await expect.poll(async () => (await observe()).state, { timeout: 15_000 }).toBe('awaitingStart');
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/instances-before-load.png' });
  expect((await api(`play/${psid}/control`, { command: 'loadScene', sceneId: 'scene-grove' })).status).toBe(200);
  await expect.poll(async () => (await observe()).scenes?.loaded, { timeout: 10_000 }).toEqual(['scene-main', 'scene-grove']);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/instances-after-load.png' });
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
