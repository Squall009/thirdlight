/**
 * Play mode must not leak GPU resources frame over frame. With post effects
 * on (bloom, vignette, anti-aliasing), the preview's renderer holds a fixed
 * set of textures, geometries and programs while the game runs; before the
 * fix the post stack was rebuilt every frame and the counts grew until the
 * browser ran out of memory.
 */
import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('play-memory-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

type Gpu = { geometries: number; textures: number; programs: number };

test('the play preview holds a fixed set of GPU resources while the game runs with post effects', async ({ page }) => {
  test.setTimeout(120_000);
  const rev = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  const set = await be.command({
    op: 'setEnvironment',
    projectId: be.projectId,
    expectedRevision: rev,
    requestId: `req-${'7'.repeat(32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-play-memory' },
    args: { environment: { quality: 'high', post: { bloom: { enabled: true }, vignette: { enabled: true }, antialias: 'fxaa' } } },
  });
  expect(set['ok'], JSON.stringify(set)).toBe(true);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 15_000 }).toBe(200);
  expect((await relay(`${psid}/control`, { command: 'start' })).status).toBe(200);

  const gpu = async (): Promise<Gpu | undefined> => {
    const d = await relay(`${psid}/diagnostics`, {});
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    return ((d.json['diagnostics'] as { renderer?: { gpu?: Gpu } } | undefined)?.renderer?.gpu);
  };
  // Warm-up: the first frames build the post stack and upload the scene.
  await expect.poll(async () => (await gpu())?.textures ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1_000);
  const first = (await gpu())!;
  // Several hundred frames later (fewer under SwiftShader): the same counts.
  await page.waitForTimeout(5_000);
  const later = (await gpu())!;
  expect(later, `GPU resources grew while playing: ${JSON.stringify(first)} → ${JSON.stringify(later)}`).toEqual(first);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();
});
