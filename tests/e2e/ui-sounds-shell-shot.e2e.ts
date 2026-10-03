/**
 * Game UI sounds, a shell screen whose scripts run, and Play screenshots
 * with the UI, against a real backend and a real browser on the starter
 * project.
 *
 * - Sounds: a document's default sounds play on the `ui` bus when the
 *   pointer comes over a button, when a button runs an engine action and
 *   when the keyboard moves the focus — counted as sounds started on the ui
 *   bus in Play diagnostics (the Web Audio graph's state; how they sound is
 *   not checked).
 * - Screenshots: the capture over HTTP holds the UI's magenta panel's
 *   pixels; with `ui: false` it holds the rendered frame alone.
 * - The game shell: a title screen with `simulate: 'scripts'` lets an
 *   ungrouped script step while a grouped one and physics are held (the
 *   player does not walk under a held key); Start plays everything.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { STARTER, type E2EBackend, publishBytes, publishScript, publishWav, startBackend } from './backend';
import { decodePng } from './png';
import { makePng } from './png-make';
import { createItem, openProjectSettings } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('ui-sounds-shell-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomUUID().replace(/-/g, '')}`, origin: { kind: 'mcp', clientId: 'e2e-ui-sounds' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function startPlay(page: Page): Promise<{ psid: string; observe: () => Promise<Record<string, unknown>> }> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Record<string, unknown>> => (await api(`play/${psid}/observe`, {})).json;
  await expect.poll(async () => (await observe())['state'] ?? null, { timeout: 60_000 }).toBe('running');
  return { psid, observe };
}
const centre = async (l: Locator): Promise<{ x: number; y: number }> => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

test('UI sounds on the ui bus (hover, an engine action\'s click, a keyboard focus move); a Play screenshot holds the UI, or not with ui: false', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const click = await publishWav(be, 'cue-goal.wav', 'snd-click', 'Click');
  const hover = await publishWav(be, 'cue-max.wav', 'snd-hover', 'Hover');
  const focus = await publishWav(be, 'cue-min.wav', 'snd-focus', 'Focus');
  // A UI image (drawn from a blob: URL on the page).
  await publishBytes(be, makePng(16, 16, () => [0, 255, 0, 255]), 'texture', 'tex-green');
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'menu', name: 'Menu', focus: true, sounds: { click, hover, focus },
    root: { type: 'panel', stretch: 'both', children: [
      { type: 'stack', anchor: [0, 0], pivot: [0, 0], offset: [12, 12], gap: 8, children: [
        { id: 'a', type: 'button', text: 'A', size: [140, 36], css: { background: '#304050', color: '#ffffff' }, onClick: { do: 'event', name: 'a' } },
        { id: 'b', type: 'button', text: 'Unmute', size: [140, 36], css: { background: '#304050', color: '#ffffff' }, onClick: { do: 'engine', action: 'unmute' } },
      ] },
      { id: 'shot', type: 'panel', anchor: [1, 1], pivot: [1, 1], offset: [-10, -10], size: [160, 90], css: { background: '#ff00ff' } },
      { id: 'pic', type: 'image', image: 'tex-green', anchor: [0, 1], pivot: [0, 1], offset: [10, -10], size: [160, 90] },
    ] },
  } });
  await publishScript(be, 'behavior-ui-sounds', "export default { instantiate() { return { shown: false }; }, step(s: any, ctx: any) { if (ctx.phase === 'intent' && !s.shown) s.shown = ctx.ui.show('menu'); } };\n", STARTER.playerId);
  const { psid } = await startPlay(page);
  const frame = page.locator('iframe.tl-app__preview-frame').contentFrame();
  const menu = frame.locator('[data-tl-ui-doc="menu"]');
  await expect(menu).toHaveCount(1, { timeout: 20_000 });

  // The Play toolbar's renderer label follows the renderer once frames are drawn (it is polled every 2 s).
  await expect(page.locator('.tl-app__preview-renderer')).not.toContainText('pending', { timeout: 10_000 });
  await expect(page.locator('.tl-app__preview-renderer')).toContainText('(ready)');

  type Audio = { unlock: { state: string }; started: Record<string, number>; skipped: Record<string, number> };
  const audio = async (): Promise<Audio | null> => {
    const r = await api(`play/${psid}/diagnostics`, {});
    return r.status === 200 ? ((r.json['diagnostics'] as { audio?: Audio } | undefined)?.audio ?? null) : null;
  };
  const uiStarted = async (): Promise<number> => (await audio())?.started['ui'] ?? -1;
  // The player's first press in the game unlocks sound (on the view, away from the buttons).
  const box = (await page.locator('iframe.tl-app__preview-frame').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await audio())?.unlock.state ?? null, { timeout: 30_000 }).toBe('unlocked');
  const n0 = await uiStarted();
  expect(n0).toBe(0);

  // Hover: the pointer comes over A.
  const a = await centre(menu.locator('[data-widget="a"]'));
  await page.mouse.move(a.x, a.y);
  await expect.poll(uiStarted, { timeout: 10_000 }).toBe(1);
  // An engine action's click (after its own hover).
  const b = await centre(menu.locator('[data-widget="b"]'));
  await page.mouse.move(b.x, b.y);
  await expect.poll(uiStarted, { timeout: 10_000 }).toBe(2);
  await page.mouse.down();
  await page.mouse.up();
  await expect.poll(uiStarted, { timeout: 10_000 }).toBe(3);
  // A keyboard focus move (B → A).
  await page.keyboard.press('ArrowUp');
  await expect(menu).toHaveAttribute('data-focus', 'a', { timeout: 10_000 });
  await expect.poll(uiStarted, { timeout: 10_000 }).toBe(4);
  // None was skipped for a file still loading, none went to the effects bus.
  expect((await audio())!.skipped['not_ready'] ?? 0).toBe(0);
  expect((await audio())!.started['sfx']).toBe(0);

  // ---- screenshots with and without the UI ----
  const shot = async (body: Record<string, unknown>): Promise<ReturnType<typeof decodePng>> => {
    const r = await api(`play/${psid}/screenshot`, body);
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    const png = Buffer.from(String(r.json['dataUrl']).split(',')[1]!, 'base64');
    writeFileSync(`test-results/ui-sounds-shot-${body['ui'] === false ? 'frame' : 'ui'}.png`, png);
    return decodePng(png);
  };
  /** The share of a colour's pixels in a bottom corner: the UI's magenta panel (right), its green image (left). */
  const share = (img: ReturnType<typeof decodePng>, right: boolean, is: (r: number, g: number, b: number) => boolean): number => {
    let n = 0;
    let all = 0;
    for (let y = Math.floor(img.height * 0.75); y < img.height - 2; y += 2) {
      for (let x = right ? Math.floor(img.width * 0.8) : 2; x < (right ? img.width - 2 : Math.floor(img.width * 0.2)); x += 2) {
        const [r, g, bl] = img.pixel(x, y);
        if (is(r, g, bl)) n += 1;
        all += 1;
      }
    }
    return n / all;
  };
  const magenta = (img: ReturnType<typeof decodePng>): number => share(img, true, (r, g, b) => r > 200 && g < 60 && b > 200);
  const green = (img: ReturnType<typeof decodePng>): number => share(img, false, (r, g, b) => g > 200 && r < 60 && b < 60);
  await expect(menu.locator('[data-widget="pic"]')).toHaveCSS('background-image', /blob:/, { timeout: 10_000 });
  const withUi = await shot({ maxWidth: 1024 });
  expect(magenta(withUi)).toBeGreaterThan(0.1);
  expect(green(withUi)).toBeGreaterThan(0.1);
  const frameOnly = await shot({ maxWidth: 1024, ui: false });
  expect(magenta(frameOnly)).toBe(0);
  expect(green(frameOnly)).toBe(0);
  expect([frameOnly.width, frameOnly.height]).toEqual([withUi.width, withUi.height]);
  expect(errors).toEqual([]);
});

const COUNTER = (path: string): string => `export default { instantiate() { return { n: 0 }; }, step(s: any, ctx: any) { if (ctx.phase !== 'intent') return; s.n += 1; ctx.ui.set('${path}', s.n); } };\n`;

test('a shell title with simulate: scripts lets the scripts outside groups step while physics and grouped scripts hold; Start plays them all', async ({ page }) => {
  test.setTimeout(240_000);
  const create = async (name: string): Promise<string> => String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name, transform: { position: [0, -3, 0] } }))['createdId']);
  await cmd('setBehaviorGroups', { groups: ['world'] });
  const free = await create('Free counter');
  await publishScript(be, 'free-counter', COUNTER('probe.free'), free);
  const grouped = await create('World counter');
  await publishScript(be, 'world-counter', COUNTER('probe.grouped'), grouped);
  await cmd('setComponent', { entityId: grouped, component: 'behaviorGroup', value: { group: 'world' } });
  await cmd('setUiDocument', { document: { uiDocumentId: 'title', name: 'Title', root: { type: 'panel', anchor: [0, 0], pivot: [0, 0], offset: [12, 12], size: [180, 56], css: { background: '#203040' }, children: [
    { id: 'start', type: 'button', size: [160, 40], text: 'Start', css: { color: '#ffffff', background: '#406080' }, onClick: { do: 'engine', action: 'resume' } },
  ] } } });
  await cmd('setShell', { shell: { screens: { title: 'title' }, simulate: { title: 'scripts' } } });

  const { observe } = await startPlay(page);
  type Obs = { shell?: { screen: string }; player?: { x: number }; ui?: { values?: { probe?: { free?: number; grouped?: number } } } };
  const obs = async (): Promise<Obs> => (await observe()) as Obs;
  await expect.poll(async () => (await obs()).shell?.screen ?? null, { timeout: 20_000 }).toBe('title');
  // The ungrouped script steps under the title; the grouped one stands where the page's first steps left it.
  await expect.poll(async () => (await obs()).ui?.values?.probe?.free ?? 0, { timeout: 20_000 }).toBeGreaterThan(30);
  const g0 = (await obs()).ui?.values?.probe?.grouped ?? 0;
  const free0 = (await obs()).ui!.values!.probe!.free!;
  await expect.poll(async () => (await obs()).ui?.values?.probe?.free ?? 0, { timeout: 20_000 }).toBeGreaterThan(free0 + 60);
  expect((await obs()).ui?.values?.probe?.grouped ?? 0).toBe(g0);
  // Physics is held: the player does not walk under a held key.
  await page.locator('iframe.tl-app__preview-frame').click({ position: { x: 400, y: 300 } });
  const x0 = (await obs()).player!.x;
  await page.keyboard.down('d');
  const f0 = (await obs()).ui!.values!.probe!.free!;
  await expect.poll(async () => (await obs()).ui?.values?.probe?.free ?? 0, { timeout: 10_000 }).toBeGreaterThan(f0 + 60);
  expect(Math.abs((await obs()).player!.x - x0)).toBeLessThan(0.01);
  await page.keyboard.up('d');

  // Start: play — the grouped script steps and the player walks.
  const frame = page.locator('iframe.tl-app__preview-frame').contentFrame();
  await frame.locator('[data-tl-ui-doc="title"] [data-widget="start"]').click();
  await expect.poll(async () => (await obs()).shell?.screen ?? null, { timeout: 10_000 }).toBe('playing');
  await expect.poll(async () => (await obs()).ui?.values?.probe?.grouped ?? 0, { timeout: 10_000 }).toBeGreaterThan(g0 + 30);
  await page.keyboard.down('d');
  await expect.poll(async () => (await obs()).player!.x - x0, { timeout: 10_000 }).toBeGreaterThan(0.3);
  await page.keyboard.up('d');
});

test('editor: a widget\'s click sound in the UI document editor; a shell screen whose scripts run in the Game shell settings', async ({ page }) => {
  test.setTimeout(180_000);
  const click = await publishWav(be, 'cue-goal.wav', 'snd-click', 'Click');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await createItem(page, 'UI document', 'UI document 1');
  const editor = page.locator('[data-ui-document="ui-document-1"]');
  await expect(editor).toBeVisible();
  await page.getByLabel('new widget type').selectOption('button');
  await page.getByRole('button', { name: 'add widget', exact: true }).click();
  type W = { id?: string; children?: W[]; sounds?: unknown };
  const stored = async (): Promise<W | undefined> => {
    const docs = (await query('queryGameConfig'))['uiDocuments'] as { uiDocumentId: string; root: W }[];
    return docs.find((d) => d.uiDocumentId === 'ui-document-1')?.root.children?.find((w) => w.id === 'button');
  };
  await expect.poll(async () => (await stored())?.id).toBe('button');
  await editor.getByLabel('add widget sounds', { exact: true }).click();
  await editor.getByLabel('widget sounds click', { exact: true }).selectOption(click);
  await expect.poll(async () => (await stored())?.sounds).toEqual({ click });

  await openProjectSettings(page, 'Game shell');
  const shellPanel = page.getByLabel('game shell', { exact: true });
  const shell = async (): Promise<{ simulate?: Record<string, string> } | null> => ((await query('queryGameConfig'))['shell'] as { simulate?: Record<string, string> } | undefined) ?? null;
  await shellPanel.getByRole('button', { name: 'add game shell' }).click();
  await expect.poll(shell).toEqual({});
  await shellPanel.getByLabel('add shell simulate', { exact: true }).click();
  await shellPanel.getByLabel('shell simulate title', { exact: true }).selectOption('scripts');
  await expect.poll(async () => (await shell())?.simulate?.['title']).toBe('scripts');
});
