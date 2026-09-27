/**
 * Phase 23.14: rebinding through the built-in settings screen (which lists
 * every action through the bindings API) in Play, on the engine sample with
 * an emulated Xbox-family pad. Jump is rebound from Space to K by pressing
 * K: K jumps and Space no longer does; the rebinding survives a reload of the
 * editor (saved per player profile in the browser); "Reset controls to
 * defaults" brings Space back. The glyph lookup switches from the key cap
 * "K" to the pad's "A" (south face button) when the pad becomes the device
 * used last.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Frame, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('rebind-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

/** A standard-mapped Xbox-family pad the test moves (`window.__tlPad`), in every frame of the page. */
const FAKE_PAD = `(() => {
  window.__tlPad = { buttons: new Array(17).fill(false), axes: [0, 0, 0, 0] };
  const snapshot = () => ({
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', index: 0, mapping: 'standard', connected: true, timestamp: performance.now(),
    axes: window.__tlPad.axes.slice(),
    buttons: window.__tlPad.buttons.map((p) => ({ pressed: p, touched: p, value: p ? 1 : 0 })),
    hapticActuators: [], vibrationActuator: null,
  });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: function () { return [snapshot(), null, null, null]; } });
})();`;

type Bindings = { device: { kind: string; family?: string }; profile: string; changed: string[]; glyphs: Record<string, { label: string; icon: string }> };
type Observation = { ok?: boolean; state?: string; player?: { x: number; y: number }; flow?: { screen: string; rebound: string[] }; inputBindings?: Bindings };

async function playFrame(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(async () => {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        if (await f.locator('.tl-flow').count().catch(() => 0)) {
          found = f;
          return true;
        }
      }
      return false;
    }, { timeout: 30_000 })
    .toBe(true);
  return found!;
}

async function startPlay(page: Page): Promise<{ frame: Frame; observe: () => Promise<Observation> }> {
  // A reload: stop the running play first (the editor page is loaded again after it).
  const stop = page.getByTitle('Stop the play preview');
  if (await stop.isVisible().catch(() => false)) {
    await stop.click();
    // Stop is a backend round trip plus the preview's teardown: seconds on a loaded CPU-rendered host.
    await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
  }
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Observation> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/observe`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' }, body: '{}' });
    return (await r.json()) as Observation;
  };
  await expect.poll(async () => (await observe()).ok, { timeout: 30_000 }).toBe(true);
  const frame = await playFrame(page);
  await expect(frame.locator('.tl-flow')).toHaveAttribute('data-screen', 'title', { timeout: 20_000 });
  await page.locator('iframe.tl-app__preview-frame').click();
  return { frame, observe };
}

/** Move the menu selection to the item whose label starts with `prefix` (acting only on a selection seen twice in a row). */
async function selectItem(page: Page, frame: Frame, prefix: string): Promise<void> {
  const items = frame.locator('.tl-flow__item');
  let seen = -2;
  await expect
    .poll(async () => {
      const labels = await items.allTextContents();
      const want = labels.findIndex((l) => l.startsWith(prefix));
      const at = await items.evaluateAll((els) => els.findIndex((e) => e.classList.contains('is-selected')));
      if (at !== seen) {
        seen = at;
        return false;
      }
      if (want < 0 || want === at) return want >= 0;
      await page.keyboard.press(want > at ? 'ArrowDown' : 'ArrowUp');
      seen = -2;
      return false;
    }, { timeout: 60_000, intervals: [300] })
    .toBe(true);
}

async function openSettings(page: Page, frame: Frame): Promise<void> {
  await selectItem(page, frame, 'Settings');
  await page.keyboard.press('Enter');
  await expect(frame.locator('.tl-flow')).toHaveAttribute('data-screen', 'settings');
}

async function peak(page: Page, observe: () => Promise<Observation>, key: string): Promise<number> {
  let top = -Infinity;
  await page.keyboard.down(key);
  for (let i = 0; i < 8; i++) {
    top = Math.max(top, (await observe()).player!.y);
    await page.waitForTimeout(60);
  }
  await page.keyboard.up(key);
  await page.waitForTimeout(1200); // land again
  return top;
}

test('rebind jump to K in the settings: K jumps, it survives a reload, reset restores Space; the glyph follows the pad', async ({ page }) => {
  test.setTimeout(300_000);
  // The game flow (title, settings) with the sample's one level.
  const revision = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  const spawnId = String(((await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} }))['game'] as { spawnId: string }).spawnId);
  const res = await be.command({ op: 'setFlow', projectId: be.projectId, expectedRevision: revision, requestId: `req-${createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 32)}`, origin: { kind: 'mcp', clientId: 'e2e-rebind' }, args: { flow: { levels: [{ id: 'level-1', name: 'Level 1', scenes: ['scene-main'], spawnId }] } } });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  await page.addInitScript(FAKE_PAD);
  let { frame, observe } = await startPlay(page);
  const items = frame.locator('.tl-flow__item');

  // Every action is listed (keys and pad), not only jump/attack/interact.
  await openSettings(page, frame);
  for (const label of ['Jump (keys): Space', 'Jump (pad): A', 'Pause (keys): Esc', 'Submit (keys): Enter', 'Navigate up (keys): Up', 'Move − (keys): A', 'Reset controls to defaults']) await expect(items.filter({ hasText: label }), label).toHaveCount(1);
  await expect.poll(async () => (await observe()).inputBindings?.glyphs['jump']).toEqual({ label: 'Space', icon: 'key' });

  // Listen for jump's key and press K.
  await selectItem(page, frame, 'Jump (keys)');
  await page.keyboard.press('Enter');
  await expect(frame.locator('.tl-flow')).toContainText('Press a key for Jump');
  await page.keyboard.press('k');
  await expect(items.filter({ hasText: 'Jump (keys): K' })).toHaveCount(1);
  await expect.poll(async () => (await observe()).inputBindings?.changed).toEqual(['jump']);
  expect((await observe()).inputBindings!.glyphs['jump']).toEqual({ label: 'K', icon: 'key' });

  // The glyph switches when the pad becomes the device used last (the right stick moves: nothing is bound to it).
  await frame.evaluate(() => void ((window as unknown as { __tlPad: { axes: number[] } }).__tlPad.axes[3] = 0.9));
  await expect.poll(async () => (await observe()).inputBindings?.device).toEqual({ kind: 'gamepad', id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'.slice(0, 64), family: 'xbox' });
  expect((await observe()).inputBindings!.glyphs['jump']).toEqual({ label: 'A', icon: 'pad-south' });
  await frame.evaluate(() => void ((window as unknown as { __tlPad: { axes: number[] } }).__tlPad.axes[3] = 0));
  // A key makes the keyboard the device used last again.
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => (await observe()).inputBindings?.glyphs['jump']).toEqual({ label: 'K', icon: 'key' });

  // Back to the title and a new game: K jumps, Space does not.
  await page.keyboard.press('Escape');
  await expect(frame.locator('.tl-flow')).toHaveAttribute('data-screen', 'title');
  await selectItem(page, frame, 'New game');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await observe()).state, { timeout: 20_000 }).toBe('playing');
  await page.waitForTimeout(700); // settle on the ground
  const ground = (await observe()).player!.y;
  expect(await peak(page, observe, 'Space')).toBeLessThan(ground + 0.1);
  expect(await peak(page, observe, 'k')).toBeGreaterThan(ground + 0.6);

  // A reload: the saved rebinding holds from the start.
  ({ frame, observe } = await startPlay(page));
  const again = frame.locator('.tl-flow__item');
  await expect.poll(async () => (await observe()).inputBindings?.changed).toEqual(['jump']);
  await openSettings(page, frame);
  await expect(again.filter({ hasText: 'Jump (keys): K' })).toHaveCount(1);

  // Reset restores the project's bindings (and saves that).
  await selectItem(page, frame, 'Reset controls');
  await page.keyboard.press('Enter');
  await expect(again.filter({ hasText: 'Jump (keys): Space' })).toHaveCount(1);
  await expect.poll(async () => (await observe()).inputBindings?.changed).toEqual([]);
  ({ frame, observe } = await startPlay(page));
  await expect.poll(async () => (await observe()).inputBindings?.glyphs['jump']).toEqual({ label: 'Space', icon: 'key' });
  expect((await observe()).inputBindings!.changed).toEqual([]);
});
