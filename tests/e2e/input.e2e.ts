/**
 * Phase 9.8: the Input window. Jump is rebound from Space to W by listening
 * for the key; in Play the player jumps with W and no longer with Space.
 */
import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('input-e2e', 'beacon-reach');
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

type Observation = { state: string; player?: { x: number; y: number } };

test('jump rebound to W in the Input window: W jumps in Play, Space does not', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  await page.getByRole('tab', { name: 'Input' }).click();
  const jump = page.getByLabel('action jump', { exact: true });
  await expect(jump.getByLabel('binding Space', { exact: true })).toBeVisible();
  await expect(page.getByLabel('action attack', { exact: true })).toBeVisible();
  await jump.getByRole('button', { name: 'remove binding Space from jump' }).click();
  await expect(jump.getByLabel('binding Space', { exact: true })).toHaveCount(0);
  await jump.getByRole('button', { name: 'listen for a key for jump' }).click();
  await expect(jump.getByRole('status')).toContainText('press the key');
  await page.keyboard.press('w');
  await expect(jump.getByLabel('binding KeyW', { exact: true })).toBeVisible();
  const input = (await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['input'] as { actions: { name: string; bindings: unknown[] }[] };
  expect(input.actions.find((a) => a.name === 'jump')!.bindings).toEqual([{ kind: 'gamepadButton', button: 0 }, { kind: 'key', code: 'KeyW' }]);

  // Play: W jumps, Space does not.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Observation> => (await relay(`${psid}/observe`, {})).json as unknown as Observation;
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 15_000 }).toBe(200);
  await page.locator('iframe.tl-app__preview-frame').click();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await observe()).state).toBe('playing');
  await page.waitForTimeout(500); // settle on the ground
  const ground = (await observe()).player!.y;

  const peak = async (key: string): Promise<number> => {
    let top = -Infinity;
    await page.keyboard.down(key);
    for (let i = 0; i < 8; i++) {
      top = Math.max(top, (await observe()).player!.y);
      await page.waitForTimeout(60);
    }
    await page.keyboard.up(key);
    await page.waitForTimeout(1200); // land again
    return top;
  };
  expect(await peak('Space')).toBeLessThan(ground + 0.1);
  expect(await peak('w')).toBeGreaterThan(ground + 0.6);
});
