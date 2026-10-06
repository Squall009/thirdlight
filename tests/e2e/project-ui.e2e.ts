/**
 * Project UI documents against a real backend and a real
 * browser — Play and the static export (backend stopped).
 *
 * The engine sample gets neutral project content, all made with plain
 * commands (the same JSON MCP sends): a font asset (the DejaVu subset
 * fixture) and a 9-slice frame texture through the Asset browser, a theme,
 * three UI documents — a HUD (a bar bound to a script value, a counter text
 * in the project font, an "Add" button, a "Menu" button that shows the menu,
 * a label anchored to a marker in the world), a modal menu (three buttons,
 * keyboard/gamepad focus, the `ui` action map) and a pause document that
 * replaces the built-in pause screen — and a script that publishes the
 * values and reacts to the UI events.
 *
 * Checked: the bar follows the script's value; a click changes the script's
 * state (Play and export); the project font loads; arrow keys and a gamepad
 * D-pad move the focus, Enter picks, Backspace closes; the gameplay map is
 * off while the menu has focus; the world label moves on screen as the
 * camera follows the player past the marker; Escape shows the project's
 * pause document instead of the built-in panel and its Resume button (an
 * engine action) resumes.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

import { expect, test, type Frame, type Page } from './pw';

import { STARTER, type E2EBackend, startBackend } from './backend';
import { makePng } from './png-make';
import { projectWindow } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
const FONTS = join(REPO, 'fixtures', 'fonts');

let be: E2EBackend;
let dir: string;
test.beforeEach(async () => {
  be = await startBackend('project-ui-e2e', 'starter');
  dir = mkdtempSync(join(tmpdir(), 'tl-ui-e2e-'));
});
test.afterEach(async () => {
  await be.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-project-ui' },
    args,
  });
  expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}

const SCRIPT = [
  'export default {',
  '  instantiate() { return { shown: false, count: 0, ticks: 0 }; },',
  '  step(state: { shown: boolean; count: number; ticks: number }, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const ui = ctx.ui;',
  "    if (!state.shown) { state.shown = ui.show('hud'); }",
  '    state.ticks += 1;',
  "    ui.set('hud.meter', (state.ticks % 240) / 240);",
  '    for (const e of ui.events()) {',
  "      if (e.kind === 'click' && e.name === 'add') state.count += Number(e.value);",
  "      if (e.kind === 'click' && e.name === 'choose') ui.set('menu.chosen', e.value);",
  "      if (e.kind === 'focus') ui.set('menu.focused', e.widget);",
  '    }',
  "    ui.set('hud.count', state.count);",
  '  },',
  '};',
  '',
].join('\n');

async function publishScript(entityId: string): Promise<void> {
  const behaviorId = 'behavior-project-ui';
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: SCRIPT }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: 'Project UI', mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: 'Project UI', declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${'e'.repeat(32)}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

async function importFile(page: Page, file: string, label: string): Promise<string> {
  await projectWindow(page);
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect(page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: label })).toHaveCount(1, { timeout: 10_000 });
  const assets = (await query('queryAssets', { limit: 20, offset: 0 }))['assets'] as { assetId: string; displayName?: string }[];
  return assets.find((a) => (a.displayName ?? a.assetId).includes(label) || a.assetId.includes(label))!.assetId;
}

/** Everything the tests share: assets, the marker, the script, the theme, the documents and the game shell. */
async function setUp(page: Page): Promise<{ fontId: string }> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const fontId = await importFile(page, join(FONTS, 'neutral-sans.ttf'), 'neutral-sans');
  const framePng = join(dir, 'ui-frame.png');
  writeFileSync(framePng, makePng(12, 12, (x, y) => (x < 3 || y < 3 || x > 8 || y > 8 ? [240, 200, 80, 255] : [20, 30, 40, 220])));
  const frameId = await importFile(page, framePng, 'ui-frame');

  await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'UI marker', transform: { position: [3, 0.6, 0] }, box: { size: [0.4, 0.4, 0.4], material: { color: '#ff00ff' } } });
  const entities = (await query('queryEntities', { limit: 200, offset: 0 }))['entities'] as { id: string; name?: string }[];
  const markerId = entities.find((e) => e.name === 'UI marker')!.id;
  await publishScript(STARTER.playerId);
  // The camera follows the character (a track rig; the world label then moves across the view as it walks).
  const cam = ((await query('queryEntity', { entityId: STARTER.cameraId }))['entity'] as { components: { transform: { position: number[]; rotation?: number[] } } }).components.transform;
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Follow shot', transform: { position: cam.position, ...(cam.rotation !== undefined ? { rotation: cam.rotation } : {}) }, components: { virtualCamera: { rig: 'track', target: STARTER.playerId } } });

  await cmd('setUiTheme', { theme: { uiThemeId: 'neutral', name: 'Neutral', styles: {
    label: { font: fontId, fontSize: 20, color: '#ffffff', textShadow: '#000000' },
    btn: { background: '#304050', color: '#ffffff', padding: [4, 10, 4, 10], radius: 4, focus: { background: '#e0a030', color: '#000000' }, hover: { borderColor: '#ffffff' } },
    framed: { backgroundImage: frameId, slice: [3, 3, 3, 3], padding: 8 },
  } } });
  // The menu first: the HUD's show action names it.
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'menu', name: 'Menu', theme: 'neutral', modal: true, actionMap: 'ui', onCancel: { do: 'hide', doc: 'menu' },
    tweens: { in: { kind: 'fade', duration: 0.15 } }, showTween: 'in',
    root: { type: 'stack', anchor: [0.5, 0.5], direction: 'column', gap: 8, style: 'framed', children: [
      { id: 'one', type: 'button', style: 'btn', text: 'One', onClick: { do: 'event', name: 'choose', value: 1 } },
      { id: 'two', type: 'button', style: 'btn', text: 'Two', onClick: { do: 'event', name: 'choose', value: 2 } },
      { id: 'three', type: 'button', style: 'btn', text: 'Three', onClick: { do: 'event', name: 'choose', value: 3 } },
      { id: 'chosen', type: 'text', style: 'label', text: 'Chosen {menu.chosen}' },
    ] },
  } });
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'hud', name: 'HUD', theme: 'neutral', tweens: { pop: { kind: 'stamp', duration: 0.2 } },
    root: { type: 'panel', stretch: 'both', children: [
      { id: 'frame', type: 'stack', style: 'framed', anchor: [0, 0], offset: [16, 16], gap: 6, children: [
        { id: 'meter', type: 'bar', size: [220, 14], value: { bind: 'hud.meter' }, fillColor: '#40c040', css: { background: '#202020' } },
        { id: 'count', type: 'text', style: 'label', text: 'Count [b]{hud.count}[/b]' },
      ] },
      { id: 'add', type: 'button', style: 'btn', anchor: [1, 0], pivot: [1, 0], offset: [-16, 16], text: 'Add', onClick: [{ do: 'event', name: 'add', value: 10 }, { do: 'play', tween: 'pop', widget: 'count' }] },
      { id: 'open', type: 'button', style: 'btn', anchor: [1, 0], pivot: [1, 0], offset: [-16, 64], text: 'Menu', onClick: { do: 'show', doc: 'menu' } },
      { id: 'tag', type: 'text', style: 'label', text: 'Marker', worldAnchor: { entity: markerId, offset: [0, 0.6, 0], clamp: true, margin: 12 } },
    ] },
  } });
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'pause', name: 'Pause', theme: 'neutral',
    root: { type: 'stack', anchor: [0.5, 0.5], direction: 'column', gap: 8, style: 'framed', children: [
      { id: 'heading', type: 'text', style: 'label', text: 'Paused — {$flow.shell.screen}' },
      { id: 'resume', type: 'button', style: 'btn', text: 'Resume', onClick: { do: 'engine', action: 'resume' } },
      { id: 'quit', type: 'button', style: 'btn', text: 'Quit to title', onClick: { do: 'engine', action: 'quitToTitle' } },
    ] },
  } });
  // The game shell's pause screen (the level flow is gone).
  await cmd('setShell', { shell: { screens: { pause: 'pause' } } });
  // MCP reads them back.
  const cfg = await query('queryGameConfig');
  expect((cfg['uiDocuments'] as { uiDocumentId: string }[]).map((d) => d.uiDocumentId)).toEqual(['hud', 'menu', 'pause']);
  expect((cfg['uiThemes'] as unknown[]).length).toBe(1);
  return { fontId };
}

/** Shared checks of a running game (Play frame or the export page). */
async function checkHud(root: Page | Frame, fontId: string): Promise<void> {
  const hud = root.locator('[data-tl-ui-doc="hud"]');
  await expect(hud).toHaveCount(1, { timeout: 20_000 });
  // The bar follows the script's value.
  const meter = hud.locator('[data-widget="meter"]');
  const first = Number(await meter.getAttribute('data-value'));
  await expect.poll(async () => Number(await meter.getAttribute('data-value')), { timeout: 10_000 }).not.toBe(first);
  const fillWidth = await meter.locator('.tl-ui-bar__fill').evaluate((el) => (el as HTMLElement).style.width);
  expect(fillWidth).toMatch(/%$/);
  // The project font is loaded (FontFace from the asset's bytes) and used.
  await expect.poll(async () => (await root.locator('[data-tl-ui]').getAttribute('data-fonts')) ?? '', { timeout: 15_000 }).toContain(fontId);
  const family = await hud.locator('[data-widget="count"]').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(family).toContain(`tl-font-${fontId}`);
  // A click raises a UI event: the script's count changes.
  await expect(hud.locator('[data-widget="count"]')).toHaveText('Count 0');
  await hud.locator('[data-widget="add"]').click();
  await expect(hud.locator('[data-widget="count"]')).toHaveText('Count 10', { timeout: 10_000 });
  await hud.locator('[data-widget="add"]').click();
  await expect(hud.locator('[data-widget="count"]')).toHaveText('Count 20', { timeout: 10_000 });
  // The 9-slice frame draws its texture.
  const border = await hud.locator('[data-widget="frame"]').evaluate((el) => getComputedStyle(el).borderImageSource);
  expect(border).toContain('blob:');
}

async function pauseAndResume(page: Page, root: Page | Frame): Promise<void> {
  await page.keyboard.press('Escape');
  // The engine pause panel stays away; the project's pause document shows, with a host value ($flow.shell).
  const pause = root.locator('[data-tl-ui-doc="pause"][data-tl-ui-source="screen"]');
  await expect(pause).toHaveCount(1);
  await expect(root.locator('[data-tl-pause-panel]')).toHaveCount(0);
  await expect(pause.locator('[data-widget="heading"]')).toHaveText('Paused — pause');
  await expect(pause).toHaveAttribute('data-focus', 'resume');
  await page.keyboard.press('Enter'); // Resume (an engine action)
  await expect(root.locator('[data-tl-ui-doc="pause"]')).toHaveCount(0);
}

function serve(root: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, reply) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      reply.statusCode = 404;
      reply.end();
      return;
    }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
    reply.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(reply);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` })));
}

// Play and the export share one set-up: the export is made from the project Play just ran.
test('project UI in Play: bound bar, click to script, keyboard and gamepad focus, world label, a replaced pause screen; the same in the static export', async ({ page, context }) => {
  test.setTimeout(300_000);
  // A controllable standard gamepad in every frame (the Play frame polls navigator.getGamepads).
  await context.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
    const pad = { id: 'e2e pad', index: 0, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons, timestamp: 0 };
    (window as unknown as { __tlPad: (b: number, down: boolean) => void }).__tlPad = (b, down) => {
      buttons[b] = { pressed: down, touched: down, value: down ? 1 : 0 };
      pad.timestamp += 1;
    };
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null], configurable: true });
  });
  const { fontId } = await setUp(page);

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Record<string, unknown>> => (await api(`play/${psid}/observe`, {})).json;
  await expect.poll(async () => (await observe())['ok'], { timeout: 30_000 }).toBe(true);
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  // The scene plays at once (the shell has no title here).
  await expect.poll(async () => (await observe())['state'], { timeout: 20_000 }).toBe('running');
  await page.locator('iframe.tl-app__preview-frame').click();
  const playFrame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes('/play'))!;
  expect(playFrame).toBeDefined();

  await checkHud(playFrame, fontId);
  const ui = async (): Promise<{ shown: string[]; focus: { widget: string } | null; actionMap: string | null; values?: { hud?: { count?: number } } }> => (await observe())['ui'] as never;
  await expect.poll(async () => (await ui()).values?.hud?.count).toBe(20);
  await page.screenshot({ path: 'test-results/project-ui-hud.png' });

  // The world label follows the marker through the camera: on screen, then it moves left as the player walks right.
  const tag = frame.locator('[data-widget="tag"]');
  await expect(tag).toHaveAttribute('data-anchor', 'on', { timeout: 10_000 });
  const x0 = await tag.evaluate((el) => el.getBoundingClientRect().left);
  await page.keyboard.down('d');
  await expect.poll(async () => x0 - (await tag.evaluate((el) => el.getBoundingClientRect().left)), { timeout: 10_000 }).toBeGreaterThan(40);
  await page.keyboard.up('d');

  // The menu: shown by a HUD button (a show entry on the next input frame); modal, focused, the ui action map.
  await frame.locator('[data-widget="open"]').click();
  const menu = frame.locator('[data-tl-ui-doc="menu"]');
  await expect(menu).toHaveCount(1, { timeout: 10_000 });
  await expect(menu).toHaveAttribute('data-focus', 'one');
  await expect.poll(async () => (await ui()).actionMap).toBe('ui');
  // Keyboard: down, down, up → Two; Enter picks it (the script shows its choice).
  await page.keyboard.press('ArrowDown');
  await expect(menu).toHaveAttribute('data-focus', 'two');
  await page.keyboard.press('ArrowDown');
  await expect(menu).toHaveAttribute('data-focus', 'three');
  await page.keyboard.press('ArrowUp');
  await expect(menu).toHaveAttribute('data-focus', 'two');
  await expect(menu.locator('[data-widget="two"]')).toHaveClass(/is-focused/);
  await expect.poll(async () => ((await ui()).values as { menu?: { focused?: string } } | undefined)?.menu?.focused).toBe('two');
  // While the menu has the focus the gameplay map is off: holding D does not move the player.
  const px = async (): Promise<number> => ((await observe())['player'] as { x: number }).x;
  const before = await px();
  await page.keyboard.down('d');
  await page.waitForTimeout(400);
  await page.keyboard.up('d');
  expect(Math.abs((await px()) - before)).toBeLessThan(0.05);
  await page.keyboard.press('Enter');
  await expect(menu.locator('[data-widget="chosen"]')).toHaveText('Chosen 2', { timeout: 10_000 });
  // Gamepad: D-pad down moves the focus, A picks.
  const pad = (b: number, down: boolean): Promise<void> => playFrame.evaluate(([bb, dd]) => (window as unknown as { __tlPad: (b: number, d: boolean) => void }).__tlPad(bb as number, dd as boolean), [b, down] as const);
  await pad(13, true);
  await expect(menu).toHaveAttribute('data-focus', 'three', { timeout: 5_000 });
  await pad(13, false);
  await pad(0, true);
  await expect(menu.locator('[data-widget="chosen"]')).toHaveText('Chosen 3', { timeout: 10_000 });
  await pad(0, false);
  await page.screenshot({ path: 'test-results/project-ui-menu.png' });
  // Backspace (cancel) runs the menu's onCancel: hidden; every map active again.
  await page.keyboard.press('Backspace');
  await expect(menu).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(async () => (await ui()).actionMap).toBeNull();
  await expect.poll(async () => (await ui()).shown).toEqual(['hud']);

  // Escape: the project's pause document replaces the built-in pause panel; Resume resumes.
  await pauseAndResume(page, playFrame);

  // The same project in the static export: bound bar, click to script, the project font, a replaced pause screen.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await page.goto('about:blank');
  await be.halt();
  const s = await serve(join(be.exportRoot, String(res.json.outputDir)));
  const errors: string[] = [];
  try {
    const game = await page.context().newPage();
    game.on('pageerror', (e) => errors.push(e.message));
    await game.goto(s.url);
    await game.mouse.click(20, 700); // the canvas, away from the HUD
    await checkHud(game, fontId);
    await expect(game.locator('[data-widget="tag"]')).toHaveAttribute('data-anchor', 'on', { timeout: 10_000 });
    await game.screenshot({ path: 'test-results/project-ui-export.png' });
    await game.mouse.click(20, 700);
    await pauseAndResume(game, game);
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>((ok) => s.server.close(() => ok()));
  }
});
