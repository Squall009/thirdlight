/**
 * Game modes against a real backend and a real browser, on a
 * neutral 3D project built by commands on a blank project (a floor, four
 * coloured pillars, a player capsule, physics_dimension 3) with two modes:
 *
 * - "explore": the gameplay and ui input maps, a follow camera, a HUD
 *   document, the "field" behavior group ticking, the engine pause allowed
 *   (a pause document of the project's own);
 * - "tactical": a project input map "tactical" and ui, a top-down camera
 *   (eased blend in), a board document with a Back button (a mode action),
 *   the "board" group ticking, the pause not allowed, physics held.
 *
 * Checked in Play (observations over the relay, the preview's pixels, the
 * Play toolbar): one press of T (a script's ctx.modes.switch) changes the
 * input map (D no longer moves the player; E — a tactical action — counts),
 * the live camera (a blend; the view's pixels change), the UI document and
 * the ticking groups together, with no scene load; the Back button switches
 * back; Escape pauses in explore (the project's pause document, the steps
 * stop, Enter resumes) and does nothing in tactical. MCP's tl_play_start with
 * mode "tactical" starts there. The same in the static export (backend
 * stopped). The Game modes panel lists the modes (the first is the start
 * mode) and edits one through its descriptor form (one setModes, undoable).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Frame, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { openProjectSettings } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-game-modes' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function create(name: string, position: number[], extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> {
  return String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind, name, transform: { position }, ...extra }))['createdId']);
}

/** Publish a behavior and attach it to an object. */
async function script(behaviorId: string, source: string, entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

/** The director (ungrouped: ticks in every mode): T switches, E counts, the events are logged for observers. */
const DIRECTOR = [
  'export default {',
  '  instantiate() { return { selects: 0 }; },',
  '  step(state: { selects: number }, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const modes = ctx.modes;',
  "    for (const e of modes.events()) ctx.ui.set('log.' + e.kind, e.mode);",
  "    if (ctx.input.pressed('toggle')) modes.switch(modes.is('explore') ? 'tactical' : 'explore');",
  "    if (ctx.input.pressed('select')) { state.selects += 1; ctx.ui.set('selects', state.selects); }",
  '  },',
  '};',
].join('\n');
/** A counter per group: it runs only while its group ticks. */
const COUNTER = (key: string): string => [
  'export default {',
  '  instantiate() { return { n: 0 }; },',
  '  step(state: { n: number }, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    state.n += 1;',
  `    ctx.ui.set('${key}', state.n);`,
  '  },',
  '};',
].join('\n');

interface Ids {
  player: string;
  follow: string;
  top: string;
}

async function buildProject(): Promise<Ids> {
  await create('Floor', [0, -0.5, 0], { box: { size: [40, 1, 40], material: { color: '#8a8f98' } }, components: { collider: { shape: { type: 'box', hx: 20, hy: 0.5, hz: 20 } } } }, 'box');
  const pillars: [string, number[], string][] = [['Red', [-4, 1.5, 0], '#e23c3c'], ['Blue', [4, 1.5, 0], '#2f6fe0'], ['Green', [0, 1.5, -4], '#2fb04a'], ['Yellow', [0, 1.5, 4], '#f0c419']];
  for (const [name, at, color] of pillars) await create(name, at, { box: { size: [1.2, 3, 1.2], material: { color } } }, 'box');
  const player = await create('Player', [0, 0.91, 0]);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#7ec8ff' } } });
  // The input: a project map "tactical" (its select action), the gameplay move, the ui actions and the mode toggle.
  await cmd('setInput', {
    input: {
      maps: ['tactical'],
      actions: [
        { name: 'move', type: 'axis2d', map: 'gameplay', bindings: [{ kind: 'keys2d', up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' }] },
        { name: 'select', type: 'button', map: 'tactical', bindings: [{ kind: 'key', code: 'KeyE' }] },
        { name: 'toggle', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'KeyT' }] },
        { name: 'pause', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'Escape' }] },
        { name: 'submit', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'Enter' }] },
        { name: 'cancel', type: 'button', map: 'ui', bindings: [{ kind: 'key', code: 'Backspace' }] },
        { name: 'navigate', type: 'axis2d', map: 'ui', bindings: [{ kind: 'keys2d', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }] },
      ],
    },
  });
  const follow = await create('Follow camera', [0, 4, 8]);
  await cmd('setComponent', { entityId: follow, component: 'virtualCamera', value: { rig: 'follow', target: player, distance: 8, pitch: 25 } });
  const top = await create('Top camera', [0, 0, 0]);
  await cmd('setComponent', { entityId: top, component: 'virtualCamera', value: { rig: 'topDown', target: player, distance: 20, priority: -10 } });
  // Behavior groups; the director is ungrouped.
  await cmd('setBehaviorGroups', { groups: ['field', 'board'] });
  const director = await create('Director', [0, -3, 0]);
  await script('mode-director', DIRECTOR, director);
  const field = await create('Field counter', [2, -3, 0]);
  await script('field-counter', COUNTER('field'), field);
  await cmd('setComponent', { entityId: field, component: 'behaviorGroup', value: { group: 'field' } });
  const board = await create('Board counter', [4, -3, 0]);
  await script('board-counter', COUNTER('board'), board);
  await cmd('setComponent', { entityId: board, component: 'behaviorGroup', value: { group: 'board' } });
  // The documents.
  await cmd('setUiDocument', { document: { uiDocumentId: 'hud', name: 'HUD', root: { type: 'text', id: 'count', anchor: [0, 0], offset: [16, 16], text: 'Explore {field}' } } });
  // The board without its Back button first: the button names a mode, and the modes name the board.
  await cmd('setUiDocument', { document: { uiDocumentId: 'board', name: 'Board', root: { type: 'text', text: 'board' } } });
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'pause', name: 'Pause',
    root: { type: 'stack', anchor: [0.5, 0.5], direction: 'column', gap: 8, children: [
      { id: 'heading', type: 'text', text: 'Paused' },
      { id: 'resume', type: 'button', text: 'Resume', onClick: { do: 'engine', action: 'resume' } },
    ] },
  } });
  await cmd('setModes', { modes: [
    { modeId: 'explore', name: 'Explore', inputMaps: ['gameplay', 'ui'], camera: follow, ui: ['hud'], groups: ['field'], pauseScreen: 'pause' },
    { modeId: 'tactical', name: 'Tactical', inputMaps: ['tactical', 'ui'], camera: top, ui: ['board'], groups: ['board'], pause: false, physics: 'hold', enter: { blend: 'eased', blendTime: 0.5 } },
  ] });
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'board', name: 'Board',
    root: { type: 'stack', anchor: [0, 0], offset: [16, 16], direction: 'column', gap: 6, children: [
      { id: 'count', type: 'text', text: 'Tactical {board} · selects {selects}' },
      { id: 'back', type: 'button', text: 'Back', onClick: { do: 'mode', mode: 'explore' } },
    ] },
  } });
  return { player, follow, top };
}

interface ModeObs {
  current: string;
  previous: string;
  pause: boolean;
  inputMaps: string[] | null;
}
interface Observation {
  state: string;
  stepIndex: number;
  player?: { x: number; y: number; z: number };
  camera?: { live: string | null; blend: { from: string | null; progress: number } | null };
  ui?: { shown: string[]; screen: string | null; values?: Record<string, unknown> };
  mode?: ModeObs;
  paused?: boolean;
  scenes?: { loaded: string[] };
}

/** Share of sampled pixels that differ clearly between two same-size images. */
function changed(a: Image, b: Image): number {
  let n = 0;
  let d = 0;
  for (let y = 0; y < Math.min(a.height, b.height); y += 4) {
    for (let x = 0; x < Math.min(a.width, b.width); x += 4) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      n += 1;
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 60) d += 1;
    }
  }
  return n === 0 ? 0 : d / n;
}

async function press(page: Page, key: string, ms = 120): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

async function mcpClient(): Promise<{ mcp: Client; call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; body: Record<string, unknown> }> }> {
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be!.origin, THIRDLIGHT_PROJECT_ID: be!.projectId, THIRDLIGHT_MCP_TOKEN: be!.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
  };
  return { mcp, call };
}

test('game modes in Play: one switch changes input map, camera, UI and ticking groups; pause in explore; tl_play_start mode; the Game modes panel', async ({ page }) => {
  test.setTimeout(360_000);
  be = await startBackend('game-modes-e2e');
  const ids = await buildProject();
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(m.text().slice(0, 300)));

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The Game modes panel: the modes (the first is the start mode) and the groups.
  await openProjectSettings(page, 'Game modes');
  const panel = page.getByLabel('game modes', { exact: true });
  await expect(panel.locator('[data-mode="explore"]')).toContainText('start');
  await expect(panel.locator('[data-mode="tactical"]')).toBeVisible();
  await expect(panel.locator('[data-group="field"]')).toContainText('1 object');
  // Edit tactical's name through the descriptor form (one setModes), then undo.
  await panel.getByRole('button', { name: 'select mode tactical' }).click();
  const name = panel.locator('[data-mode-form="tactical"]').getByLabel('mode name', { exact: true });
  await name.fill('Tactical view');
  await name.press('Enter');
  await expect.poll(async () => ((await query('queryGameConfig'))['modes'] as { name: string }[])[1]!.name).toBe('Tactical view');
  await expect(panel.locator('[data-mode="tactical"]')).toContainText('Tactical view');
  await page.keyboard.press('Control+z');
  await expect.poll(async () => ((await query('queryGameConfig'))['modes'] as { name: string }[])[1]!.name, { timeout: 10_000 }).toBe('Tactical');
  await page.screenshot({ path: 'test-results/game-modes-panel.png' });

  // Play.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Observation | null> => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  const iframe = page.locator('iframe.tl-app__preview-frame');
  const frame = iframe.contentFrame();
  await expect.poll(async () => (await observe())?.mode?.current ?? null, { timeout: 60_000 }).toBe('explore');
  await expect.poll(async () => (await observe())?.camera?.live ?? null, { timeout: 30_000 }).toBe(ids.follow);
  await expect(page.locator('[data-play-mode]')).toHaveAttribute('data-play-mode', 'explore', { timeout: 15_000 });
  await expect(page.locator('[data-play-mode]')).toContainText('mode: Explore');
  const o0 = (await observe())!;
  expect(o0.state).toBe('running');
  expect(o0.ui?.shown).toEqual(['hud']);
  expect(o0.mode?.inputMaps).toEqual(['gameplay', 'ui']);
  await expect(frame.locator('[data-tl-ui-doc="hud"]')).toHaveCount(1);

  // Explore: D moves the player (the gameplay map), the field group ticks.
  const box = (await iframe.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  const x0 = (await observe())!.player!.x;
  await press(page, 'd', 400);
  await expect.poll(async () => (await observe())!.player!.x, { timeout: 10_000 }).toBeGreaterThan(x0 + 0.1);
  await page.waitForTimeout(300);
  const exploreShot = decodePng(await iframe.screenshot({ path: 'test-results/game-modes-explore.png' }));
  const values = async (): Promise<Record<string, number | Record<string, string>>> => ((await observe())?.ui?.values ?? {}) as never;
  expect(Number((await values())['field'])).toBeGreaterThan(10);
  expect((await values())['board']).toBeUndefined();
  const scenesBefore = JSON.stringify((await observe())!.scenes ?? null);

  // T: one transition — input map, camera (eased blend), UI document and ticking groups.
  await press(page, 't');
  await expect.poll(async () => (await observe())?.mode?.current ?? null, { timeout: 15_000 }).toBe('tactical');
  const t0 = (await observe())!;
  expect(t0.mode).toMatchObject({ previous: 'explore', pause: false, inputMaps: ['tactical', 'ui'] });
  expect(t0.ui?.shown).toEqual(['board']);
  expect(t0.camera?.live).toBe(ids.top);
  expect(JSON.stringify(t0.scenes ?? null)).toBe(scenesBefore); // no scene load
  expect((await values())['log']).toEqual({ exit: 'explore', enter: 'tactical' });
  await expect(page.locator('[data-play-mode]')).toHaveAttribute('data-play-mode', 'tactical', { timeout: 15_000 });
  await expect(frame.locator('[data-tl-ui-doc="board"]')).toHaveCount(1);
  await expect(frame.locator('[data-tl-ui-doc="hud"]')).toHaveCount(0);
  // The blend ends on the top camera; the view looks down on the scene (other pixels).
  await expect.poll(async () => (await observe())?.camera?.blend ?? null, { timeout: 15_000 }).toBeNull();
  await page.waitForTimeout(300);
  const tacticalShot = decodePng(await iframe.screenshot({ path: 'test-results/game-modes-tactical.png' }));
  expect(changed(exploreShot, tacticalShot), 'the tactical camera shows another view').toBeGreaterThan(0.05);
  // The field group paused, the board group ticks.
  const f1 = Number((await values())['field']);
  await expect.poll(async () => Number((await values())['board'] ?? 0), { timeout: 10_000 }).toBeGreaterThan(20);
  expect(Number((await values())['field'])).toBe(f1);
  // D does not move the player (gameplay map off, physics held); E (the tactical map) counts.
  const px = (await observe())!.player!;
  await press(page, 'd', 400);
  await page.waitForTimeout(200);
  const px2 = (await observe())!.player!;
  expect(Math.abs(px2.x - px.x)).toBeLessThan(0.01);
  await press(page, 'e');
  await expect.poll(async () => (await values())['selects'], { timeout: 10_000 }).toBe(1);
  // Escape does not pause in tactical (the mode does not allow it).
  await press(page, 'Escape');
  await page.waitForTimeout(300);
  expect((await observe())!.paused).toBe(false);

  // The board's Back button: a mode action (through the input frame) back to explore.
  await frame.locator('[data-tl-ui-doc="board"] [data-widget="back"]').click();
  await expect.poll(async () => (await observe())?.mode?.current ?? null, { timeout: 15_000 }).toBe('explore');
  await expect(frame.locator('[data-tl-ui-doc="hud"]')).toHaveCount(1);
  await expect.poll(async () => (await observe())?.camera?.live ?? null).toBe(ids.follow);

  // Escape in explore: paused, the project's pause document; the steps stop; Enter resumes.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.8);
  await press(page, 'Escape');
  await expect.poll(async () => (await observe())?.paused ?? null, { timeout: 10_000 }).toBe(true);
  await expect(frame.locator('[data-tl-ui-doc="pause"][data-tl-ui-source="screen"]')).toHaveCount(1);
  const s1 = (await observe())!.stepIndex;
  await page.waitForTimeout(500);
  expect((await observe())!.stepIndex).toBe(s1);
  await page.screenshot({ path: 'test-results/game-modes-paused.png' });
  await press(page, 'Enter');
  await expect.poll(async () => (await observe())?.paused ?? null, { timeout: 10_000 }).toBe(false);
  await expect.poll(async () => (await observe())!.stepIndex, { timeout: 10_000 }).toBeGreaterThan(s1);
  await expect(frame.locator('[data-tl-ui-doc="pause"]')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();
  await expect(page.getByTitle('Start an isolated play preview')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await api(`play/${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(404);

  // MCP tl_play_start with mode "tactical": the run starts there.
  const { mcp, call } = await mcpClient();
  try {
    const start = await call('tl_play_start', { demo: false, mode: 'tactical' });
    expect(start.isError, JSON.stringify(start.body)).toBe(false);
    expect((start.body.start as { mode?: string }).mode).toBe('tactical');
    const id = String(start.body.playSessionId);
    let last: unknown = null;
    await expect
      .poll(async () => {
        const b = (await call('tl_game_observe', { playSessionId: id })).body;
        last = b;
        return (b as unknown as Observation).mode?.current ?? null;
      }, { timeout: 60_000, message: 'the MCP start mode' })
      .toBe('tactical')
      .catch(async (e: unknown) => {
        const text = (await page.locator('body').innerText()).split('\n').filter((l) => /fail|error|refus/i.test(l)).join(' | ');
        throw new Error(`${String(e)} last observation: ${JSON.stringify(last).slice(0, 1500)} page: ${text.slice(0, 1500)} console: ${consoleLines.slice(-15).join(' || ')}`);
      });
    const obs = (await call('tl_game_observe', { playSessionId: id })).body as Observation & { start?: { applied?: string[] } };
    expect(obs.ui?.shown).toEqual(['board']);
    expect(obs.start?.applied).toContain('mode tactical');
    const bad = await call('tl_play_start', { demo: false, mode: 'nope' });
    expect(bad.isError).toBe(true);
    expect((await call('tl_play_stop', { playSessionId: id })).isError).toBe(false);
  } finally {
    await mcp.close();
  }
});

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('game modes in the static export: the switch, the Back button, pause only in explore', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('game-modes-export-e2e');
  const ids = await buildProject();
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    const read = (): Promise<Observation | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null);
    await expect.poll(async () => (await read())?.mode?.current ?? null, { timeout: 60_000 }).toBe('explore');
    await expect.poll(async () => (await read())?.camera?.live ?? null, { timeout: 30_000 }).toBe(ids.follow);
    const root: Frame | Page = game;
    await expect(root.locator('[data-tl-ui-doc="hud"]')).toHaveCount(1, { timeout: 20_000 });
    await game.mouse.click(20, 700);
    const x0 = (await read())!.player!.x;
    await press(game, 'd', 400);
    await expect.poll(async () => (await read())!.player!.x, { timeout: 10_000 }).toBeGreaterThan(x0 + 0.1);
    // T: tactical — top camera, the board document, the field counter stops.
    await press(game, 't');
    await expect.poll(async () => (await read())?.mode?.current ?? null, { timeout: 15_000 }).toBe('tactical');
    await expect.poll(async () => (await read())?.camera?.live ?? null).toBe(ids.top);
    await expect(root.locator('[data-tl-ui-doc="board"]')).toHaveCount(1);
    const fieldText = async (): Promise<string> => (await root.locator('[data-tl-ui-doc="board"] [data-widget="count"]').textContent()) ?? '';
    await expect.poll(fieldText, { timeout: 10_000 }).toMatch(/Tactical \d+/);
    const px = (await read())!.player!.x;
    await press(game, 'd', 400);
    expect(Math.abs((await read())!.player!.x - px)).toBeLessThan(0.01);
    await press(game, 'Escape');
    await game.waitForTimeout(300);
    expect((await read())!.paused).toBe(false);
    // Back (a mode action), then pause in explore.
    await root.locator('[data-tl-ui-doc="board"] [data-widget="back"]').click();
    await expect.poll(async () => (await read())?.mode?.current ?? null, { timeout: 15_000 }).toBe('explore');
    await game.mouse.click(20, 700);
    await press(game, 'Escape');
    await expect.poll(async () => (await read())?.paused ?? null, { timeout: 10_000 }).toBe(true);
    await expect(root.locator('[data-tl-ui-doc="pause"]')).toHaveCount(1);
    await game.screenshot({ path: 'test-results/game-modes-export-paused.png' });
    await press(game, 'Enter');
    await expect.poll(async () => (await read())?.paused ?? null, { timeout: 10_000 }).toBe(false);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
