/**
 * Scenes and settings through the game shell — the starter template gets a second scene far to
 * the right (a spawn and a floor) and a shell with a title (Start), a pause
 * screen (Next scene, Settings, Resume) and a settings screen (music volume
 * down, its value bound to `$flow.shell.volumes.music`, Back). In Play and in the
 * export served statically (backend stopped), from the keyboard and mouse:
 * the title holds the game; Start plays; the pause screen stops the steps;
 * Next scene loads the listed second scene and places the character at its
 * spawn; Settings → music down shows 90 % and is kept for the next page load
 * (the player's settings storage).
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type FrameLocator, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('shell-scenes-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-shell-scenes' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 400)).toBe(true);
  return res;
}

const FULL = { anchor: [0, 0], pivot: [0, 0], stretch: 'both' };
const BUTTON = { color: '#ffffff', background: '#303848', fontSize: 20, padding: 8, radius: 6 };
const button = (id: string, y: number, text: string, onClick: Record<string, unknown>) => ({ type: 'button', id, anchor: [0.5, y], pivot: [0.5, 0.5], size: [240, 44], text, css: BUTTON, onClick });
const DOCS = [
  { uiDocumentId: 'title', name: 'Title', root: { type: 'panel', ...FULL, css: { background: '#203040' }, children: [button('start', 0.5, 'Start', { do: 'engine', action: 'newGame' })] } },
  {
    uiDocumentId: 'paused',
    name: 'Paused',
    root: { type: 'panel', ...FULL, css: { background: '#402030' }, children: [
      button('next', 0.3, 'Next scene', { do: 'engine', action: 'nextScene' }),
      button('settings', 0.5, 'Settings', { do: 'engine', action: 'open', screen: 'settings' }),
      button('resume', 0.7, 'Resume', { do: 'engine', action: 'resume' }),
    ] },
  },
  {
    uiDocumentId: 'settings',
    name: 'Settings',
    root: { type: 'panel', ...FULL, css: { background: '#304020' }, children: [
      { type: 'text', id: 'music', anchor: [0.5, 0.25], pivot: [0.5, 0.5], text: 'Music {$flow.shell.volumes.music}', css: { color: '#ffffff', fontSize: 22 } },
      button('down', 0.45, 'Music −', { do: 'engine', action: 'setSetting', setting: 'music', step: -1 }),
      button('back', 0.65, 'Back', { do: 'engine', action: 'back' }),
    ] },
  },
];

type Obs = { state?: string; player?: { x: number; y: number }; scenes?: { loaded: string[] }; shell?: { screen: string; scene: { index: number; id: string | null } } };

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

/** The shell's screens, driven in one page or frame; `observe` reads the observation. */
async function playThrough(surface: Page | FrameLocator, keys: Page, observe: () => Promise<Obs>): Promise<void> {
  const doc = (id: string) => surface.locator(`[data-tl-ui-doc="${id}"]`);
  await expect(doc('title')).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => (await observe()).state, { timeout: 20_000 }).toBe('paused');
  await doc('title').locator('[data-widget="start"]').click();
  await expect.poll(async () => (await observe()).state, { timeout: 20_000 }).toBe('running');
  await expect.poll(async () => (await observe()).shell?.scene.id ?? null).toBe('scene-main');
  // The pause screen stops the steps.
  await keys.keyboard.press('Escape');
  await expect(doc('paused')).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await observe()).state).toBe('paused');
  // Next scene: the second listed scene loads and the character arrives at its spawn.
  await doc('paused').locator('[data-widget="next"]').click();
  await expect.poll(async () => (await observe()).shell?.scene.id ?? null, { timeout: 30_000 }).toBe('scene-b');
  await expect.poll(async () => (await observe()).scenes?.loaded ?? [], { timeout: 30_000 }).toContain('scene-b');
  await expect.poll(async () => (await observe()).player?.x ?? 0, { timeout: 30_000 }).toBeGreaterThan(199);
  // Settings: the music volume goes down a step (the value the screen binds).
  await keys.keyboard.press('Escape');
  await expect(doc('paused')).toBeVisible({ timeout: 20_000 });
  await doc('paused').locator('[data-widget="settings"]').click();
  await expect(doc('settings')).toBeVisible();
  await expect(doc('settings').locator('[data-widget="music"]')).toContainText('Music 1');
  await doc('settings').locator('[data-widget="down"]').click();
  await expect(doc('settings').locator('[data-widget="music"]')).toContainText('Music 0.9');
  await doc('settings').locator('[data-widget="back"]').click();
  await expect(doc('paused')).toBeVisible();
  await doc('paused').locator('[data-widget="resume"]').click();
  await expect.poll(async () => (await observe()).state).toBe('running');
}

test('the shell\'s scene list and settings in Play and the export: next scene, music volume kept', async ({ page }) => {
  test.setTimeout(300_000);
  // The second scene, far to the right: a floor and the spawn the list names.
  await cmd('createScene', { sceneId: 'scene-b', name: 'Second' });
  await cmd('createEntity', { sceneId: 'scene-b', kind: 'box', name: 'Far floor', transform: { position: [200, -0.2, 0] }, box: { size: [12, 0.4, 1], material: { color: '#6f6f6f' } }, components: { collider: { shape: { type: 'box', hx: 6, hy: 0.2 } } } });
  await cmd('createEntity', { sceneId: 'scene-b', kind: 'group', name: 'Arrival', transform: { position: [200, 0.91, 0] }, components: { playerSpawn: {} } });
  const q = (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 200, offset: 0 } })) as { entities?: { id: string; name?: string }[] };
  const arrival = q.entities!.find((e) => e.name === 'Arrival')!.id;
  for (const d of DOCS) await cmd('setUiDocument', { document: d });
  await cmd('setShell', { shell: { screens: { title: 'title', pause: 'paused', settings: 'settings' }, scenes: [{ scene: 'scene-main', spawn: 'spawn-0001' }, { scene: 'scene-b', spawn: arrival }] } });

  // Play.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observePlay = async (): Promise<Obs> => {
    const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${psid}/observe`, { method: 'POST', headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' }, body: '{}' });
    return (await r.json()) as Obs;
  };
  await expect.poll(async () => (await observePlay()).state, { timeout: 60_000 }).toBeDefined();
  const iframe = page.locator('iframe.tl-app__preview-frame');
  await expect(iframe).toBeVisible({ timeout: 30_000 });
  await iframe.click({ position: { x: 5, y: 5 } });
  await playThrough(iframe.contentFrame(), page, observePlay);
  await page.getByTitle('Stop the play preview').click();

  // The export, served statically with the backend stopped: the same, and the volume is kept across a reload.
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
    const observeExport = async (): Promise<Obs> => game.evaluate(() => (window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? {}) as Promise<Obs>;
    await game.goto(site.url);
    await game.mouse.click(5, 5);
    await playThrough(game, game, observeExport);
    // A new page load keeps the player's settings: the settings screen shows 0.9 from the start.
    await game.reload();
    const doc = (id: string) => game.locator(`[data-tl-ui-doc="${id}"]`);
    await expect(doc('title')).toBeVisible({ timeout: 60_000 });
    await doc('title').locator('[data-widget="start"]').click();
    await expect.poll(async () => (await observeExport()).state, { timeout: 20_000 }).toBe('running');
    await game.keyboard.press('Escape');
    await doc('paused').locator('[data-widget="settings"]').click();
    await expect(doc('settings').locator('[data-widget="music"]')).toContainText('Music 0.9');
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
