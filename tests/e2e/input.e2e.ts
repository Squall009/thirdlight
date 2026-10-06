/**
 * The Input window. Jump is rebound from Space to W by listening
 * for the key; in Play the player jumps with W and no longer with Space.
 *
 * A project map's cursor, set in the Input window, is stored
 * and applies in Play while a game mode activates that map; removing the
 * map drops its setting.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { makePng } from './png-make';
import { openProjectSettings, projectWindow } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('input-e2e', 'starter');
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

  await openProjectSettings(page, 'Input');
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
  // The starter has no game block: the scene plays at once; a click focuses the game.
  await page.locator('iframe.tl-app__preview-frame').click();
  await expect.poll(async () => (await observe()).state).toBe('running');
  /** The player stands still: two readings in a row at the same height (at or below `ceiling`); that height. */
  const standing = async (ceiling = Infinity): Promise<number> => {
    let last = NaN;
    await expect
      .poll(async () => {
        const y = (await observe()).player!.y;
        const still = y === last && y < ceiling;
        last = y;
        return still;
      }, { timeout: 15_000, message: 'the player stands on the ground' })
      .toBe(true);
    return last;
  };
  const ground = await standing();

  const peak = async (key: string): Promise<number> => {
    let top = -Infinity;
    await page.keyboard.down(key);
    for (let i = 0; i < 8; i++) {
      top = Math.max(top, (await observe()).player!.y);
      await page.waitForTimeout(60);
    }
    await page.keyboard.up(key);
    await standing(ground + 0.05); // landed again
    return top;
  };
  expect(await peak('Space')).toBeLessThan(ground + 0.1);
  expect(await peak('w')).toBeGreaterThan(ground + 0.6);
});

test('a hold time on a binding and a project glyph image, edited in the Input window', async ({ page }) => {
  test.setTimeout(120_000);
  // A glyph image: a small texture imported through the Assets window.
  const dir = mkdtempSync(join(tmpdir(), 'tl-glyph-'));
  const file = join(dir, 'glyph.png');
  writeFileSync(file, makePng(32, 32, () => [40, 110, 250, 255]));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await projectWindow(page);
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: 'glyph' })).toHaveCount(1, { timeout: 10_000 });
  rmSync(dir, { recursive: true, force: true });
  const assets = (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['assets'] as { assetId: string; kind: string }[];
  const texture = assets.find((a) => a.kind === 'texture');
  expect(texture, 'the imported texture').toBeDefined();
  await openProjectSettings(page, 'Input');
  const hold = page.getByLabel('hold seconds for Space of jump', { exact: true });
  await hold.fill('0.5');
  await hold.blur();
  const stored = async (): Promise<{ actions: { name: string; bindings: unknown[] }[]; glyphs?: Record<string, string> }> => (await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['input'] as never;
  await expect.poll(async () => (await stored())?.actions.find((a) => a.name === 'jump')?.bindings[0]).toEqual({ kind: 'key', code: 'Space', hold: 0.5 });
  // A gamepad binding names one pad (a co-op player's own); "any pad" clears it.
  await page.getByLabel('pad for Pad 0 of jump', { exact: true }).selectOption('1');
  await expect.poll(async () => (await stored())?.actions.find((a) => a.name === 'jump')?.bindings[1]).toEqual({ kind: 'gamepadButton', button: 0, pad: 1 });
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
  await expect(page.getByLabel('pad for Pad 0 of jump', { exact: true })).toHaveValue('1');
  await page.getByLabel('pad for Pad 0 of jump', { exact: true }).selectOption('');
  await expect.poll(async () => (await stored())?.actions.find((a) => a.name === 'jump')?.bindings[1]).toEqual({ kind: 'gamepadButton', button: 0 });
});

test('a project map\'s cursor, set in the Input window, applies in Play while a game mode activates the map', async ({ page }) => {
  test.setTimeout(120_000);
  const config = async (): Promise<{ input: { maps?: string[]; cursor?: Record<string, string> } | null; modes?: unknown }> => (await be.command({ op: 'queryGameConfig', projectId: be.projectId })) as never;
  const run = async (op: string, args: Record<string, unknown>): Promise<void> => {
    const rev = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} }))['revision']);
    const r = await be.command({ op, projectId: be.projectId, expectedRevision: rev, requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-input-cursor' }, args });
    expect(r['ok'], JSON.stringify(r)).toBe(true);
  };
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await openProjectSettings(page, 'Input');
  await page.getByLabel('new input map name', { exact: true }).fill('tactical');
  await page.getByRole('button', { name: 'Add map', exact: true }).click();
  await expect.poll(async () => (await config()).input?.maps).toEqual(['tactical']);
  // The project map has its own cursor select, not only gameplay and ui.
  await page.getByLabel('cursor while tactical', { exact: true }).selectOption('locked');
  await expect.poll(async () => (await config()).input?.cursor).toEqual({ tactical: 'locked' });

  // Play: the start mode activates only the tactical and ui maps; the cursor is the tactical map's (gameplay's is free).
  await run('setModes', { modes: [{ modeId: 'board', name: 'Board', inputMaps: ['tactical', 'ui'] }] });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; mode?: { current: string }; cursor?: { mode: string } };
  const observe = async (): Promise<Obs> => (await relay(`${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).mode?.current ?? null, { timeout: 30_000 }).toBe('board');
  await expect.poll(async () => (await observe()).cursor?.mode ?? null, { timeout: 15_000 }).toBe('locked');
  await page.getByTitle('Stop the play preview').click();
  await expect(page.locator('iframe.tl-app__preview-frame')).toHaveCount(0, { timeout: 30_000 });

  // Removing the map (once no mode names it) drops its cursor setting in the same edit.
  await run('setModes', { modes: [] });
  await openProjectSettings(page, 'Input');
  await page.getByRole('button', { name: 'remove input map tactical', exact: true }).click();
  await expect.poll(async () => JSON.stringify([(await config()).input?.maps ?? null, (await config()).input?.cursor ?? null])).toBe('[null,null]');
});
