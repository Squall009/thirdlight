/**
 * Phase 9.8: the Input window. Jump is rebound from Space to W by listening
 * for the key; in Play the player jumps with W and no longer with Space.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { makePng } from './png-make';

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

test('phase 23.14: a hold time on a binding and a project glyph image, edited in the Input window', async ({ page }) => {
  test.setTimeout(120_000);
  // A glyph image: a small texture imported through the Assets window.
  const dir = mkdtempSync(join(tmpdir(), 'tl-glyph-'));
  const file = join(dir, 'glyph.png');
  writeFileSync(file, makePng(32, 32, () => [40, 110, 250, 255]));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'glyph' })).toHaveCount(1, { timeout: 10_000 });
  rmSync(dir, { recursive: true, force: true });
  const assets = (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['assets'] as { assetId: string; kind: string }[];
  const texture = assets.find((a) => a.kind === 'texture');
  expect(texture, 'the imported texture').toBeDefined();
  await page.getByRole('tab', { name: 'Input' }).click();
  const hold = page.getByLabel('hold seconds for Space of jump', { exact: true });
  await hold.fill('0.5');
  await hold.blur();
  const stored = async (): Promise<{ actions: { name: string; bindings: unknown[] }[]; glyphs?: Record<string, string> }> => (await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['input'] as never;
  await expect.poll(async () => (await stored())?.actions.find((a) => a.name === 'jump')?.bindings[0]).toEqual({ kind: 'key', code: 'Space', hold: 0.5 });
  await page.getByLabel('new glyph key', { exact: true }).fill('xbox:pad-south');
  await page.getByLabel('new glyph texture', { exact: true }).selectOption(texture!.assetId);
  await page.getByRole('button', { name: 'Add glyph' }).click();
  await expect.poll(async () => (await stored())?.glyphs).toEqual({ 'xbox:pad-south': texture!.assetId });
  await expect(page.getByLabel('glyph xbox:pad-south', { exact: true })).toBeVisible();
  // The hold stays on the binding through the glyph edit; clearing it makes the binding a tap again.
  await expect(page.getByLabel('hold seconds for Space of jump', { exact: true })).toHaveValue('0.5');
  await page.getByLabel('hold seconds for Space of jump', { exact: true }).fill('');
  await page.getByLabel('hold seconds for Space of jump', { exact: true }).blur();
  await expect.poll(async () => (await stored())?.actions.find((a) => a.name === 'jump')?.bindings[0]).toEqual({ kind: 'key', code: 'Space' });
});
