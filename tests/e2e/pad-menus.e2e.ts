/**
 * Phase 14.5: input and menus. Beacon Reach (the engine sample, neutral
 * fixtures) gets a title background scene far to the right; the Game flow
 * window sets menu sounds (the sample's own cue sounds), level 1's ambience,
 * the title background and a slow camera pan. In Play, with an emulated
 * standard gamepad (navigator.getGamepads replaced in every frame before the
 * page loads): the title camera frames the background scene and pans; the
 * menu sounds reach the audio owner (voices on the ui bus); in the settings
 * jump is rebound to pad button 3 by pressing it; in the level the ambience
 * loops, pad button 0 no longer jumps and button 3 does.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Frame, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('pad-menus-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

async function revision(): Promise<number> {
  return Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: await revision(),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-pad-menus' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** A standard-mapped pad the test holds buttons on (`window.__tlPad`), in every frame of the page. */
const FAKE_PAD = `(() => {
  window.__tlPad = { buttons: new Array(17).fill(false), axes: [0, 0, 0, 0] };
  const snapshot = () => ({
    id: 'e2e emulated pad', index: 0, mapping: 'standard', connected: true, timestamp: performance.now(),
    axes: window.__tlPad.axes.slice(),
    buttons: window.__tlPad.buttons.map((p) => ({ pressed: p, touched: p, value: p ? 1 : 0 })),
    hapticActuators: [], vibrationActuator: null,
  });
  Object.defineProperty(Navigator.prototype, 'getGamepads', { configurable: true, value: function () { return [snapshot(), null, null, null]; } });
})();`;

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

const setButton = (frame: Frame, button: number, pressed: boolean): Promise<void> =>
  frame.evaluate(([b, p]) => {
    (window as unknown as { __tlPad: { buttons: boolean[] } }).__tlPad.buttons[b as number] = p as boolean;
  }, [button, pressed] as const);

/** Pixels of the backdrop wall's magenta (lit or shaded: red and blue over green). */
function magentaPixels(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > g + 40 && b > g + 40) n += 1;
    }
  }
  return n;
}

type Observation = { ok?: boolean; state?: string; player?: { x: number; y: number }; loops?: Record<string, number>; titleView?: { scene: string | null; cameraOffset: number[] }; flow?: { screen: string; menuSounds: { played: number; last: string | null }; ambience: string[]; pad: Record<string, number> } };

test('pad rebinding, menu sounds, ambience and the title background in Play', async ({ page }) => {
  test.setTimeout(240_000);
  // The title background: a magenta wall far to the right (no camera, player or lights: it loads like a level scene).
  await cmd('createScene', { sceneId: 'scene-title', name: 'Title backdrop' });
  await cmd('createEntity', { sceneId: 'scene-title', kind: 'box', name: 'Backdrop marker', transform: { position: [500, 1, -4] }, box: { size: [60, 30, 1], material: { color: '#ff00ff' } } });
  await cmd('createEntity', { sceneId: 'scene-title', kind: 'group', name: 'Backdrop view', transform: { position: [500, 0.91, 0] }, components: { playerSpawn: {} } });
  const assets = (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['assets'] as { assetId: string; kind: string; displayName: string }[];
  const sounds = assets.filter((a) => a.kind === 'audio');
  expect(sounds.length).toBeGreaterThanOrEqual(4);
  const [move, confirm, back, hum] = sounds;

  // The references are checked: an unknown title scene, a menu sound or ambience that is not a sound.
  const model = assets.find((a) => a.kind === 'model')!.assetId;
  const level = { id: 'level-1', name: 'Level 1', scenes: ['scene-main'], spawnId: String(((await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} }))['game'] as { spawnId: string }).spawnId) };
  for (const [bad, where] of [[{ levels: [level], title: { scene: 'scene-nope' } }, '/flow/title/scene'], [{ levels: [level], sounds: { move: model } }, '/flow/sounds'], [{ levels: [{ ...level, ambience: [model] }] }, '/flow/levels/0/ambience']] as const) {
    const res = await be.command({ op: 'setFlow', projectId: be.projectId, expectedRevision: await revision(), requestId: `req-${createHash('sha256').update(JSON.stringify(bad) + Math.random()).digest('hex').slice(0, 32)}`, origin: { kind: 'mcp', clientId: 'e2e-pad-menus' }, args: { flow: bad } });
    expect(res.ok, JSON.stringify(bad)).toBe(false);
    expect(JSON.stringify(res)).toContain(where);
  }

  await page.addInitScript(FAKE_PAD);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The Game flow window.
  await page.getByRole('tab', { name: 'Game flow', exact: true }).click();
  await page.getByRole('button', { name: 'Set up levels and menus' }).click();
  await page.getByLabel('menu sound move', { exact: true }).selectOption(move!.assetId);
  await page.getByLabel('menu sound confirm', { exact: true }).selectOption(confirm!.assetId);
  await page.getByLabel('menu sound back', { exact: true }).selectOption(back!.assetId);
  await page.getByLabel('level 1 add ambience', { exact: true }).selectOption(hum!.assetId);
  await expect(page.getByLabel(`level 1 stop ambience ${hum!.displayName}`, { exact: true })).toBeVisible();
  await page.getByLabel('title background scene', { exact: true }).selectOption({ label: 'Title backdrop' });
  await page.getByLabel('title camera pan', { exact: true }).click();
  const storedFlow = async (): Promise<Record<string, unknown>> => (await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} }))['flow'] as Record<string, unknown>;
  await expect.poll(async () => (await storedFlow())['title']).toEqual({ scene: 'scene-title', pan: { distance: 4, seconds: 20 } });
  const flowDoc = await storedFlow();
  expect(flowDoc['sounds']).toEqual({ move: move!.assetId, confirm: confirm!.assetId, back: back!.assetId });
  expect((flowDoc['levels'] as { ambience?: string[] }[])[0]!.ambience).toEqual([hum!.assetId]);

  // Play.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Observation> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/observe`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' }, body: '{}' });
    return (await r.json()) as Observation;
  };
  await expect.poll(async () => (await observe()).ok, { timeout: 30_000 }).toBe(true);
  const frame = await playFrame(page);
  const flow = frame.locator('.tl-flow');
  await expect(flow).toHaveAttribute('data-screen', 'title', { timeout: 20_000 });

  // The title camera frames the backdrop (500 m right of the player's start) and pans slowly.
  await expect.poll(async () => (await observe()).titleView?.scene ?? null, { timeout: 15_000 }).toBe('scene-title');
  const player = (await observe()).player!;
  const first = (await observe()).titleView!.cameraOffset;
  expect(first[0]! + player.x).toBeGreaterThan(499);
  expect(first[0]! + player.x).toBeLessThan(505);
  await page.waitForTimeout(1500);
  expect((await observe()).titleView!.cameraOffset[0]).toBeGreaterThan(first[0]!);
  // Seen, not only computed: the magenta wall fills the title view around the menu.
  const iframe = page.locator('iframe.tl-app__preview-frame');
  await expect.poll(async () => magentaPixels(decodePng(await iframe.screenshot())), { timeout: 10_000 }).toBeGreaterThan(500);

  // Menu sounds reach the audio owner (the first key unlocks sound; the cues decode).
  await page.locator('iframe.tl-app__preview-frame').click();
  await expect
    .poll(async () => {
      await page.keyboard.press('ArrowDown');
      return Number(await flow.getAttribute('data-menu-sounds'));
    }, { timeout: 20_000 })
    .toBeGreaterThan(0);
  expect((await observe()).flow!.menuSounds.last).toBe('move');

  // Settings → "Jump (pad)": press pad button 3.
  const items = flow.locator('.tl-flow__item');
  const selectItem = async (prefix: string): Promise<void> => {
    await expect
      .poll(async () => {
        const labels = await items.allTextContents();
        const want = labels.findIndex((l) => l.startsWith(prefix));
        const at = await items.evaluateAll((els) => els.findIndex((e) => e.classList.contains('is-selected')));
        if (want < 0 || want === at) return want >= 0;
        await page.keyboard.press(want > at ? 'ArrowDown' : 'ArrowUp');
        return false;
      }, { timeout: 10_000 })
      .toBe(true);
  };
  await selectItem('Settings');
  const before = (await observe()).flow!.menuSounds.played;
  await page.keyboard.press('Enter');
  await expect(flow).toHaveAttribute('data-screen', 'settings');
  await expect.poll(async () => (await observe()).flow!.menuSounds).toEqual({ played: before + 1, last: 'confirm' });
  await expect(items.filter({ hasText: 'Jump (pad): button 0' })).toHaveCount(1);
  await expect(items.filter({ hasText: 'Menu sounds volume: 100%' })).toHaveCount(1);
  await selectItem('Jump (pad)');
  await page.keyboard.press('Enter');
  await expect(flow).toContainText('Press a pad button for Jump');
  await setButton(frame, 3, true);
  await expect(items.filter({ hasText: 'Jump (pad): button 3' })).toHaveCount(1);
  await setButton(frame, 3, false);
  expect((await observe()).flow!.pad).toEqual({ jump: 3 });
  await page.keyboard.press('Escape');
  await expect(flow).toHaveAttribute('data-screen', 'title');
  await expect.poll(async () => (await observe()).flow!.menuSounds.last).toBe('back');

  // A new game: the title camera lets go, the level's ambience loops.
  await selectItem('New game');
  await page.keyboard.press('Enter');
  await expect(flow).toHaveAttribute('data-screen', 'playing');
  await expect.poll(async () => (await observe()).titleView ?? null).toBeNull();
  await expect.poll(async () => magentaPixels(decodePng(await iframe.screenshot())), { timeout: 10_000 }).toBeLessThan(50);
  await expect.poll(async () => (await observe()).flow!.ambience).toEqual([hum!.assetId]);
  await expect.poll(async () => Object.keys((await observe()).loops ?? {}), { timeout: 10_000 }).toContain('ambience:0');
  await page.waitForTimeout(700); // settle on the ground
  const ground = (await observe()).player!.y;

  const peak = async (button: number): Promise<number> => {
    let top = -Infinity;
    await setButton(frame, button, true);
    for (let i = 0; i < 8; i++) {
      top = Math.max(top, (await observe()).player!.y);
      await page.waitForTimeout(60);
    }
    await setButton(frame, button, false);
    await page.waitForTimeout(1200); // land again
    return top;
  };
  expect(await peak(0)).toBeLessThan(ground + 0.1); // the standard A no longer jumps
  expect(await peak(3)).toBeGreaterThan(ground + 0.6); // the rebound button does
});
