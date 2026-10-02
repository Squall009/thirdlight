/**
 * The game shell against a real backend and a real browser, on
 * the starter template (a scene without any game session). Three UI
 * documents (a title with a Start button, a pause screen with Resume, Save
 * and Load, and a HUD text bound to the named counter `items`), a project
 * save schema and two collectibles are made by commands; the shell itself is
 * configured in the editor's Game shell tab (descriptor form, one setShell
 * per edit).
 *
 * In Play (observations over the relay, the preview's pixels and DOM): the
 * title shows first and the game waits behind it; Start enters the scene and
 * the HUD shows; walking into a collectible raises the HUD's counter; Escape
 * opens the pause screen (the steps stop); Save writes project save slot 1;
 * after a second collectible, Load brings the first save back (one item, the
 * second collectible uncollected, the character back where it
 * stood when it was saved).
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { openProjectSettings } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('shell-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

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
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-shell' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function create(name: string, position: number[], components: Record<string, unknown>): Promise<string> {
  return String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name, transform: { position }, components }))['createdId']);
}

const FULL = { anchor: [0, 0], pivot: [0, 0], stretch: 'both' };
const BUTTON = { color: '#ffffff', background: '#303848', fontSize: 22, padding: 10, radius: 8 };
const DOCS = [
  {
    uiDocumentId: 'title',
    name: 'Title',
    root: {
      type: 'panel',
      ...FULL,
      css: { background: '#c02070' },
      children: [
        { type: 'text', anchor: [0.5, 0.25], pivot: [0.5, 0.5], text: 'A game', css: { color: '#ffffff', fontSize: 40 } },
        { type: 'button', id: 'start', anchor: [0.5, 0.8], pivot: [0.5, 0.5], size: [220, 56], text: 'Start', css: BUTTON, onClick: { do: 'engine', action: 'newGame' } },
      ],
    },
  },
  {
    uiDocumentId: 'paused',
    name: 'Paused',
    root: {
      type: 'panel',
      ...FULL,
      css: { background: '#2050c0' },
      children: [
        {
          type: 'stack',
          direction: 'column',
          gap: 8,
          anchor: [0.5, 0.8],
          pivot: [0.5, 0.5],
          children: [
            { type: 'button', id: 'resume', size: [200, 44], text: 'Resume', css: BUTTON, onClick: { do: 'engine', action: 'resume' } },
            { type: 'button', id: 'save', size: [200, 44], text: 'Save', css: BUTTON, onClick: { do: 'engine', action: 'save', slot: '1' } },
            { type: 'button', id: 'load', size: [200, 44], text: 'Load', css: BUTTON, onClick: { do: 'engine', action: 'load', slot: '1' } },
          ],
        },
        { type: 'text', id: 'note', anchor: [0.5, 0.2], pivot: [0.5, 0.5], text: '{$flow.shell.note}', css: { color: '#ffffff', fontSize: 20 } },
      ],
    },
  },
  {
    uiDocumentId: 'hud',
    name: 'HUD',
    root: { type: 'panel', anchor: [0, 0], pivot: [0, 0], offset: [12, 12], size: [240, 64], css: { background: '#20c040', padding: 8 }, children: [{ type: 'text', id: 'count', text: 'Items {$flow.counters.items}', css: { color: '#000000', fontSize: 24 } }] },
  },
];

interface Obs {
  state?: string;
  stepIndex: number;
  paused?: boolean;
  player?: { x: number };
  counters?: Record<string, number>;
  hidden?: string[];
  shell?: { screen: string; hud: string[]; note: string };
  ui?: { screen: string | null; hud?: string[] };
  saves?: { slots: { slot: number }[] };
}

/** The mean colour of a small square of the view (x, y: 0–1 of its size). */
function colourAt(img: Image, fx: number, fy: number): [number, number, number] {
  const cx = Math.round(img.width * fx);
  const cy = Math.round(img.height * fy);
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = cy - 3; y <= cy + 3; y += 1) {
    for (let x = cx - 3; x <= cx + 3; x += 1) {
      const p = img.pixel(x, y);
      sum[0] += p[0];
      sum[1] += p[1];
      sum[2] += p[2];
      n += 1;
    }
  }
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}
const near = (c: number[], hex: string, tol = 30): boolean => {
  const want = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return c.every((v, i) => Math.abs(v - want[i]!) <= tol);
};

async function hold(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

test('the game shell from the editor: title, HUD bound to a counter, pause, save and load in Play', async ({ page }) => {
  test.setTimeout(300_000);
  for (const d of DOCS) await cmd('setUiDocument', { document: d });
  await cmd('setSaveSchema', { schema: { version: 1, slots: 3, sections: ['components'] } });
  // Two collectibles on the ground: one to the right of the character's start (x 3), one to its left.
  const tokenA = await create('Token A', [4.3, 0.91, 0], { collectible: { counter: 'items' } });
  const tokenB = await create('Token B', [1.5, 0.91, 0], { collectible: { counter: 'items' } });

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The Game shell tab: add the shell, its title and pause screens and the HUD (one setShell each).
  await openProjectSettings(page, 'Game shell');
  const panel = page.getByLabel('game shell', { exact: true });
  const shell = async (): Promise<unknown> => (await query('queryGameConfig'))['shell'];
  await panel.getByRole('button', { name: 'add game shell' }).click();
  await expect.poll(shell).toEqual({});
  await panel.getByLabel('add shell screens', { exact: true }).click();
  await panel.getByLabel('shell screens title', { exact: true }).selectOption('title');
  await expect.poll(shell).toEqual({ screens: { title: 'title' } });
  await panel.getByLabel('shell screens pause', { exact: true }).selectOption('paused');
  await expect.poll(shell).toEqual({ screens: { title: 'title', pause: 'paused' } });
  await panel.getByLabel('add shell hud', { exact: true }).click();
  await panel.getByLabel('shell hud 1', { exact: true }).selectOption('hud');
  await expect.poll(shell).toEqual({ screens: { title: 'title', pause: 'paused' }, hud: ['hud'] });
  // The scene list: its first entry starts at the project's first scene (New game begins there).
  const firstScene = ((await query('queryGameConfig'))['scenes'] as { sceneId: string }[] | undefined)?.[0]?.sceneId ?? 'scene-main';
  await panel.getByLabel('add shell scenes', { exact: true }).click();
  await expect.poll(shell).toEqual({ screens: { title: 'title', pause: 'paused' }, hud: ['hud'], scenes: [{ scene: firstScene }] });
  await page.screenshot({ path: 'test-results/shell-panel.png' });

  // Play.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Obs | null> => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Obs) : null;
  };
  const iframe = page.locator('iframe.tl-app__preview-frame');
  const frame = iframe.contentFrame();
  const shot = async (name: string): Promise<Image> => decodePng(await iframe.screenshot({ path: `test-results/shell-${name}.png` }));

  // The title first (its document drawn over the view); the game waits behind it.
  await expect.poll(async () => (await observe())?.shell?.screen ?? null, { timeout: 60_000 }).toBe('title');
  const t0 = (await observe())!;
  expect(t0.state).toBe('paused'); // the menu holds the engine pause
  expect(t0.paused).toBe(true);
  expect(t0.ui?.screen).toBe('title');
  await expect(frame.locator('[data-tl-ui-doc="title"][data-tl-ui-source="screen"]')).toHaveCount(1);
  await page.waitForTimeout(400);
  expect((await observe())!.stepIndex).toBe(t0.stepIndex);
  const titleShot = await shot('title');
  expect(near(colourAt(titleShot, 0.5, 0.45), '#c02070'), `title colour ${colourAt(titleShot, 0.5, 0.45).join(',')}`).toBe(true);

  // Start: the scene plays, the HUD shows (no item yet).
  await frame.locator('[data-tl-ui-doc="title"] [data-widget="start"]').click();
  await expect.poll(async () => (await observe())?.shell?.screen ?? null, { timeout: 15_000 }).toBe('playing');
  await expect.poll(async () => (await observe())!.stepIndex, { timeout: 10_000 }).toBeGreaterThan(t0.stepIndex + 30);
  expect((await observe())!.paused).toBe(false);
  expect((await observe())!.state).toBe('running');
  expect((await observe())!.shell?.hud).toEqual(['hud']);
  const hud = frame.locator('[data-tl-ui-doc="hud"][data-tl-ui-source="hud"]');
  await expect(hud).toHaveCount(1);
  await expect(frame.locator('[data-tl-ui-doc="title"]')).toHaveCount(0, { timeout: 10_000 });
  await expect(hud).not.toContainText('Items 1');
  await page.waitForTimeout(300);
  const playShot = await shot('playing');
  expect(near(colourAt(playShot, 0.5, 0.45), '#c02070'), 'the title is gone from the view').toBe(false);
  const hudBox = (await hud.boundingBox())!;
  const frameBox = (await iframe.boundingBox())!;
  expect(near(colourAt(playShot, (hudBox.x - frameBox.x + 200) / frameBox.width, (hudBox.y - frameBox.y + 50) / frameBox.height), '#20c040'), 'the HUD panel is drawn').toBe(true);

  // Walk right into the first collectible: the counter rises and the HUD shows it.
  await page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height * 0.8);
  await hold(page, 'd', 700);
  await expect.poll(async () => (await observe())?.counters?.['items'] ?? 0, { timeout: 15_000 }).toBe(1);
  await expect(hud).toContainText('Items 1');
  expect((await observe())!.hidden).toContain(tokenA);

  // Escape: the pause screen, the steps stop; Save writes slot 1.
  await hold(page, 'Escape', 100);
  await expect.poll(async () => (await observe())?.shell?.screen ?? null, { timeout: 10_000 }).toBe('pause');
  const p0 = (await observe())!;
  expect(p0.paused).toBe(true);
  expect(p0.shell?.hud).toEqual([]);
  await expect(frame.locator('[data-tl-ui-doc="paused"][data-tl-ui-source="screen"]')).toHaveCount(1);
  await expect(hud).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(400);
  expect((await observe())!.stepIndex).toBe(p0.stepIndex);
  const pauseShot = await shot('paused');
  expect(near(colourAt(pauseShot, 0.5, 0.45), '#2050c0'), `pause colour ${colourAt(pauseShot, 0.5, 0.45).join(',')}`).toBe(true);
  await frame.locator('[data-tl-ui-doc="paused"] [data-widget="save"]').click();
  await expect.poll(async () => ((await observe())?.saves?.slots ?? []).map((s) => s.slot), { timeout: 15_000 }).toContain(1);
  await expect(frame.locator('[data-tl-ui-doc="paused"] [data-widget="note"]')).toContainText('Saved to slot 1');

  // Resume, walk left over the second collectible and on: two items.
  await frame.locator('[data-tl-ui-doc="paused"] [data-widget="resume"]').click();
  await expect.poll(async () => (await observe())?.shell?.screen ?? null, { timeout: 10_000 }).toBe('playing');
  await page.mouse.click(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height * 0.8);
  // Held until the character is past the second one (a fixed hold was too short on a loaded host).
  await page.keyboard.down('a');
  try {
    await expect.poll(async () => (await observe())?.player?.x ?? 99, { timeout: 15_000 }).toBeLessThan(0.6);
  } finally {
    await page.keyboard.up('a');
  }
  await expect.poll(async () => (await observe())?.counters?.['items'] ?? 0, { timeout: 15_000 }).toBe(2);
  await expect(hud).toContainText('Items 2');
  expect((await observe())!.hidden).toEqual(expect.arrayContaining([tokenA, tokenB]));

  // Escape, Load: the save comes back — one item, the second collectible back in place; the game plays on.
  await hold(page, 'Escape', 100);
  await expect.poll(async () => (await observe())?.shell?.screen ?? null, { timeout: 10_000 }).toBe('pause');
  await frame.locator('[data-tl-ui-doc="paused"] [data-widget="load"]').click();
  await expect.poll(async () => (await observe())?.counters?.['items'] ?? 0, { timeout: 15_000 }).toBe(1);
  const l0 = (await observe())!;
  expect(l0.shell?.screen).toBe('playing');
  // The save carries where the character stood — the load puts it back there (it had walked left past 0.6 since).
  await expect.poll(async () => Math.abs(((await observe())?.player?.x ?? -99) - p0.player!.x), { timeout: 10_000 }).toBeLessThan(0.5);
  expect(l0.paused).toBe(false);
  expect(l0.hidden ?? []).toContain(tokenA);
  expect(l0.hidden ?? []).not.toContain(tokenB);
  await expect(hud).toContainText('Items 1');
  await page.waitForTimeout(500);
  expect((await observe())!.counters?.['items']).toBe(1);
  await shot('loaded');
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});

/**
 * Saves outside the editor — the exported game (served statically, backend stopped) saves to a project save
 * slot and a new page load continues from it with the collectible still
 * collected; in Play, the editor's "Clear Play save" (Saves tab) forgets the
 * Play page's slots.
 */
test('the export saves to a slot and a new page continues from it; Clear Play save forgets Play\'s slots', async ({ page }) => {
  test.setTimeout(300_000);
  const titleDoc = {
    uiDocumentId: 'title',
    name: 'Title',
    root: { type: 'panel', ...FULL, css: { background: '#c02070' }, children: [
      { type: 'button', id: 'start', anchor: [0.5, 0.6], pivot: [0.5, 0.5], size: [220, 56], text: 'Start', css: BUTTON, onClick: { do: 'engine', action: 'newGame' } },
      { type: 'button', id: 'continue', anchor: [0.5, 0.8], pivot: [0.5, 0.5], size: [220, 56], text: 'Continue', css: BUTTON, onClick: { do: 'engine', action: 'continue' } },
    ] },
  };
  for (const d of [titleDoc, DOCS[1]!, DOCS[2]!]) await cmd('setUiDocument', { document: d });
  await cmd('setSaveSchema', { schema: { version: 1, slots: 3, sections: ['components'] } });
  await cmd('setShell', { shell: { screens: { title: 'title', pause: 'paused' }, hud: ['hud'] } });
  const tokenA = await create('Token A', [4.3, 0.91, 0], { collectible: { counter: 'items' } });

  // Play: save to slot 1, then Clear Play save; a new Play has no slot left.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const startPlay = async (): Promise<{ observe: () => Promise<Obs | null>; frame: ReturnType<Page['frameLocator']> }> => {
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    const observe = async (): Promise<Obs | null> => {
      const r = await api(`play/${psid}/observe`, {});
      return r.status === 200 ? (r.json as unknown as Obs) : null;
    };
    await expect.poll(async () => (await observe())?.shell?.screen ?? null, { timeout: 60_000 }).toBe('title');
    return { observe, frame: page.frameLocator('iframe.tl-app__preview-frame') };
  };
  let play = await startPlay();
  await play.frame.locator('[data-tl-ui-doc="title"] [data-widget="start"]').click();
  await expect.poll(async () => (await play.observe())?.shell?.screen ?? null, { timeout: 15_000 }).toBe('playing');
  const iframe = page.locator('iframe.tl-app__preview-frame');
  const box = (await iframe.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await hold(page, 'Escape', 100);
  await expect.poll(async () => (await play.observe())?.shell?.screen ?? null, { timeout: 10_000 }).toBe('pause');
  await play.frame.locator('[data-tl-ui-doc="paused"] [data-widget="save"]').click();
  await expect.poll(async () => ((await play.observe())?.saves?.slots ?? []).map((s) => s.slot), { timeout: 15_000 }).toContain(1);
  await openProjectSettings(page, 'Saves');
  await page.getByRole('button', { name: 'Clear Play save' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'cleared' })).toBeVisible({ timeout: 15_000 });
  await page.getByTitle('Stop the play preview').click();
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
  play = await startPlay();
  await expect.poll(async () => ((await play.observe())?.saves?.slots ?? []).length, { timeout: 15_000 }).toBe(0);
  await page.getByTitle('Stop the play preview').click();

  // The export, served statically with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    const observe = async (): Promise<Obs> => game.evaluate(() => (window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? {}) as Promise<Obs>;
    await game.goto(site.url);
    const doc = (id: string) => game.locator(`[data-tl-ui-doc="${id}"]`);
    await expect(doc('title')).toBeVisible({ timeout: 60_000 });
    await doc('title').locator('[data-widget="start"]').click();
    await expect.poll(async () => (await observe()).shell?.screen ?? null, { timeout: 15_000 }).toBe('playing');
    await game.mouse.click(400, 400);
    await game.keyboard.down('d');
    try {
      await expect.poll(async () => (await observe()).counters?.['items'] ?? 0, { timeout: 20_000 }).toBe(1);
    } finally {
      await game.keyboard.up('d');
    }
    await game.keyboard.press('Escape');
    await expect(doc('paused')).toBeVisible({ timeout: 10_000 });
    await doc('paused').locator('[data-widget="save"]').click();
    await expect(doc('paused').locator('[data-widget="note"]')).toContainText('Saved to slot 1', { timeout: 15_000 });
    // A new page load: Continue loads the newest slot — the item is still collected and counted.
    await game.reload();
    await expect(doc('title')).toBeVisible({ timeout: 60_000 });
    await doc('title').locator('[data-widget="continue"]').click();
    await expect.poll(async () => (await observe()).counters?.['items'] ?? 0, { timeout: 20_000 }).toBe(1);
    expect((await observe()).hidden ?? []).toContain(tokenA);
    expect((await observe()).shell?.screen).toBe('playing');
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});

function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}
