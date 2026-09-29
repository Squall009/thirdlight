/**
 * Rebinding in Play, on the starter with an emulated Xbox-family
 * pad. Through a project's own controls screen (a UI document in
 * the game shell with the engine's `rebind` and `resetBindings` actions).
 * Jump is rebound from
 * Space to K by pressing K: K jumps and Space no longer does; the rebinding
 * survives a reload of the editor (saved per player profile in the browser);
 * "Reset controls" brings Space back. The glyph lookup switches from the key
 * cap "K" to the pad's "A" (south face button) when the pad becomes the
 * device used last. A pad button is rebound the same way, on the
 * shell's controls screen.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Frame, type Page } from '@playwright/test';

import { type E2EBackend, startBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('rebind-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const revision = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-rebind' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 400)).toBe(true);
}

const FULL = { anchor: [0, 0], pivot: [0, 0], stretch: 'both' };
const BUTTON = { color: '#ffffff', background: '#303848', fontSize: 20, padding: 8, radius: 6 };
/** The title (Start, Controls) and the controls screen (rebind jump's key, reset) as project UI documents. */
const DOCS = [
  {
    uiDocumentId: 'title',
    name: 'Title',
    root: { type: 'panel', ...FULL, css: { background: '#203040' }, children: [
      { type: 'button', id: 'start', anchor: [0.5, 0.4], pivot: [0.5, 0.5], size: [220, 48], text: 'Start', css: BUTTON, onClick: { do: 'engine', action: 'newGame' } },
      { type: 'button', id: 'controls', anchor: [0.5, 0.6], pivot: [0.5, 0.5], size: [220, 48], text: 'Controls', css: BUTTON, onClick: { do: 'engine', action: 'open', screen: 'controls' } },
    ] },
  },
  {
    uiDocumentId: 'controls',
    name: 'Controls',
    root: { type: 'panel', ...FULL, css: { background: '#304020' }, children: [
      { type: 'button', id: 'rebind', anchor: [0.5, 0.3], pivot: [0.5, 0.5], size: [260, 48], text: 'Jump (keys)', css: BUTTON, onClick: { do: 'engine', action: 'rebind', input: 'jump', device: 'keyboardMouse' } },
      { type: 'button', id: 'reset', anchor: [0.5, 0.5], pivot: [0.5, 0.5], size: [260, 48], text: 'Reset controls', css: BUTTON, onClick: { do: 'engine', action: 'resetBindings' } },
      { type: 'button', id: 'back', anchor: [0.5, 0.7], pivot: [0.5, 0.5], size: [260, 48], text: 'Back', css: BUTTON, onClick: { do: 'engine', action: 'back' } },
    ] },
  },
];

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

type Bindings = { device: { kind: string; family?: string }; profile: string; listening?: unknown; changed: string[]; glyphs: Record<string, { label: string; icon: string }> };
type Observation = { ok?: boolean; state?: string; player?: { x: number; y: number }; shell?: { screen: string }; inputBindings?: Bindings };

async function playFrame(page: Page): Promise<Frame> {
  let found: Frame | undefined;
  await expect
    .poll(async () => {
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        if (await f.locator('[data-tl-ui-doc="title"]').count().catch(() => 0)) {
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
  await expect.poll(async () => (await observe()).shell?.screen, { timeout: 20_000 }).toBe('title');
  return { frame, observe };
}

/** Open the controls screen from the title. */
async function openControls(frame: Frame, observe: () => Promise<Observation>): Promise<void> {
  await frame.locator('[data-tl-ui-doc="title"] [data-widget="controls"]').click();
  await expect.poll(async () => (await observe()).shell?.screen).toBe('controls');
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

test('rebind jump to K on a controls screen: K jumps, it survives a reload, reset restores Space; the glyph follows the pad', async ({ page }) => {
  test.setTimeout(300_000);
  // The game shell: a title and a controls screen (project UI documents).
  for (const d of DOCS) await cmd('setUiDocument', { document: d });
  await cmd('setShell', { shell: { screens: { title: 'title', controls: 'controls' } } });
  await page.addInitScript(FAKE_PAD);
  let { frame, observe } = await startPlay(page);
  const controls = frame.locator('[data-tl-ui-doc="controls"]');

  // Every action has its glyph (keys and pad), not only jump.
  await expect.poll(async () => (await observe()).inputBindings?.glyphs['jump']).toEqual({ label: 'Space', icon: 'key' });
  await openControls(frame, observe);

  // Listen for jump's key and press K.
  await controls.locator('[data-widget="rebind"]').click();
  await expect.poll(async () => (await observe()).inputBindings?.listening ?? null).not.toBeNull();
  await page.keyboard.press('k');
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
  await controls.locator('[data-widget="back"]').click();
  await expect.poll(async () => (await observe()).shell?.screen).toBe('title');
  await frame.locator('[data-tl-ui-doc="title"] [data-widget="start"]').click();
  await expect.poll(async () => (await observe()).shell?.screen, { timeout: 20_000 }).toBe('playing');
  expect((await observe()).state).toBe('running');
  await page.locator('iframe.tl-app__preview-frame').click();
  await page.waitForTimeout(700); // settle on the ground
  const ground = (await observe()).player!.y;
  expect(await peak(page, observe, 'Space')).toBeLessThan(ground + 0.1);
  expect(await peak(page, observe, 'k')).toBeGreaterThan(ground + 0.6);

  // A reload: the saved rebinding holds from the start.
  ({ frame, observe } = await startPlay(page));
  await expect.poll(async () => (await observe()).inputBindings?.changed).toEqual(['jump']);
  await openControls(frame, observe);

  // Reset restores the project's bindings (and saves that).
  await frame.locator('[data-tl-ui-doc="controls"] [data-widget="reset"]').click();
  await expect.poll(async () => (await observe()).inputBindings?.changed).toEqual([]);
  ({ frame, observe } = await startPlay(page));
  await expect.poll(async () => (await observe()).inputBindings?.glyphs['jump']).toEqual({ label: 'Space', icon: 'key' });
  expect((await observe()).inputBindings!.changed).toEqual([]);
});

test('rebind jump to a pad button on a controls screen: the pad button jumps, A no longer does (from the level flow\'s pad menus)', async ({ page }) => {
  test.setTimeout(240_000);
  const padDocs = [
    DOCS[0]!,
    {
      uiDocumentId: 'controls',
      name: 'Controls',
      root: { type: 'panel', ...FULL, css: { background: '#304020' }, children: [
        { type: 'button', id: 'rebind-pad', anchor: [0.5, 0.3], pivot: [0.5, 0.5], size: [260, 48], text: 'Jump (pad)', css: BUTTON, onClick: { do: 'engine', action: 'rebind', input: 'jump', device: 'gamepad' } },
        { type: 'button', id: 'back', anchor: [0.5, 0.7], pivot: [0.5, 0.5], size: [260, 48], text: 'Back', css: BUTTON, onClick: { do: 'engine', action: 'back' } },
      ] },
    },
  ];
  for (const d of padDocs) await cmd('setUiDocument', { document: d });
  await cmd('setShell', { shell: { screens: { title: 'title', controls: 'controls' } } });
  await page.addInitScript(FAKE_PAD);
  const { frame, observe } = await startPlay(page);
  const setButton = (button: number, pressed: boolean): Promise<void> =>
    frame.evaluate(([b, p]) => void ((window as unknown as { __tlPad: { buttons: boolean[] } }).__tlPad.buttons[b as number] = p as boolean), [button, pressed] as const);
  await openControls(frame, observe);

  // Listen for jump's pad button and press button 3 (Y); it was interact's, so the two swap.
  await frame.locator('[data-tl-ui-doc="controls"] [data-widget="rebind-pad"]').click();
  await expect.poll(async () => (await observe()).inputBindings?.listening ?? null).not.toBeNull();
  await setButton(3, true);
  await expect.poll(async () => [...((await observe()).inputBindings?.changed ?? [])].sort()).toEqual(['interact', 'jump']);
  await setButton(3, false);

  // A new game: pad A (button 0) no longer jumps, button 3 does.
  await frame.locator('[data-tl-ui-doc="controls"] [data-widget="back"]').click();
  await expect.poll(async () => (await observe()).shell?.screen).toBe('title');
  await frame.locator('[data-tl-ui-doc="title"] [data-widget="start"]').click();
  await expect.poll(async () => (await observe()).shell?.screen, { timeout: 20_000 }).toBe('playing');
  await page.waitForTimeout(700); // settle on the ground
  const ground = (await observe()).player!.y;
  const padPeak = async (button: number): Promise<number> => {
    let top = -Infinity;
    await setButton(button, true);
    for (let i = 0; i < 8; i++) {
      top = Math.max(top, (await observe()).player!.y);
      await page.waitForTimeout(60);
    }
    await setButton(button, false);
    await page.waitForTimeout(1200); // land again
    return top;
  };
  expect(await padPeak(0)).toBeLessThan(ground + 0.1);
  expect(await padPeak(3)).toBeGreaterThan(ground + 0.6);
});
