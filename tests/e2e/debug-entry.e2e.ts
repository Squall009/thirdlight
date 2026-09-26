/**
 * Phase 23.8: test and debug entry points against a real backend and a real
 * browser (the engine sample, a v4 game without levels, plus a neutral second
 * scene, "Cave": a floor far to the right, a player spawn on it and a marker).
 *
 * The player carries a script that adds the injected variable `bonus` (read
 * with `ctx.save` at the start) to a counter, and declares a debug command
 * `grant {amount: number}` that adds to the counter `granted`.
 *
 * - The editor's "Play from…" dialog starts Play at Cave with variables: the
 *   game starts at the cave's spawn with the cave loaded and the bonus counted.
 * - The in-game console (the backquote key in the Play frame) runs `grant`;
 *   so does the §20 control route (`debugCommand`, what `tl_game_control`
 *   sends); both are listed with their steps in the observation.
 * - MCP's `tl_play_start` takes the same scene and variables (and notes a
 *   mode as ignored while the project has no game modes);
 *   `tl_game_control debugCommand` runs the command.
 * - An export without the `debug_console` setting has no console; with it on,
 *   the console opens and runs the command (served statically, backend stopped).
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
// @ts-expect-error — a plain .mjs helper shared with the Playwright config
import { browserLibs } from './browser-env.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend;
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
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-debug-entry' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

const SCRIPT = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return { counted: false }; },',
  '  step(state: { counted: boolean }, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    if (!state.counted) {',
  '      state.counted = true;',
  "      const bonus = ctx.save.get('bonus');",
  "      if (typeof bonus === 'number') ctx.game.add('bonus', bonus);",
  '    }',
  "    ctx.debug.command('grant', { description: 'Add to the granted counter', args: [{ name: 'amount', type: 'number' }] }, (a: any) => ctx.game.add('granted', a.amount));",
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

/** Beacon Reach + the Cave scene + the script on the player. */
async function setUp(projectId: string, env: Record<string, string> = {}): Promise<void> {
  be = await startBackend(projectId, 'beacon-reach', env);
  await cmd('createScene', { sceneId: 'scene-cave', name: 'Cave' });
  await cmd('createEntity', { sceneId: 'scene-cave', kind: 'box', name: 'Cave floor', transform: { position: [65, -0.2, 0] }, box: { size: [10, 0.4, 2], material: { color: '#4a3f5c' } }, components: { collider: { shape: { type: 'box', hx: 5, hy: 0.2 } } } });
  await cmd('createEntity', { sceneId: 'scene-cave', kind: 'box', name: 'Cave marker', transform: { position: [67, 1.2, 0] }, box: { size: [1.4, 1.4, 1.4], material: { color: '#ff00ff' } } });
  await cmd('createEntity', { sceneId: 'scene-cave', kind: 'group', name: 'Cave spawn', transform: { position: [65, 0.91, 0] }, components: { playerSpawn: {} } });
  // An open world: the camera follows without bounds (Beacon Reach clamps it to its level).
  const game = (await query('queryGameConfig')).game as { cameraId: string; playerId: string };
  const camera = (await query('queryEntity', { entityId: game.cameraId })).entity as { components: { cameraFollow: { deadZone: unknown; smoothing: number } } };
  await cmd('setComponent', { entityId: game.cameraId, component: 'cameraFollow', value: { deadZone: camera.components.cameraFollow.deadZone, smoothing: camera.components.cameraFollow.smoothing, bounds: null } });

  const behaviorId = 'behavior-debug-entry';
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
  await cmd('publishBehavior', { behaviorId, displayName: 'Debug entry', mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: 'Debug entry', declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${'d'.repeat(32)}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId: game.playerId, behaviorId, values: {} });
}

type Obs = {
  state?: string;
  player?: { x: number };
  counters?: Record<string, number>;
  scenes?: { loaded: string[] };
  start?: { ok: boolean; applied?: string[]; reason?: string };
  debugCommands?: { registered: { name: string; args: { name: string; type: string }[] }[]; applied: { stepIndex: number; name: string; args: Record<string, unknown> }[] };
};
const observer = (psid: string) => async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;

test('the editor plays from a scene with variables; the in-game console and the control route run a debug command', async ({ page }) => {
  test.setTimeout(180_000);
  await setUp('debug-entry-e2e');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // "Play from…": the Cave scene, a bonus variable.
  await page.getByTitle('Play from a scene, with script variables or from a save slot').click();
  const dialog = page.locator('.tl-dialog').filter({ hasText: 'Play from' });
  await dialog.getByLabel('play from scene').selectOption({ label: 'Cave' });
  // A bad variables text is refused in the dialog.
  await dialog.getByLabel('play from variables').fill('[1, 2]');
  await dialog.getByRole('button', { name: '▶ Play' }).click();
  await expect(dialog.getByRole('alert')).toContainText('JSON object');
  await dialog.getByLabel('play from variables').fill('{"bonus": 7}');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await dialog.getByRole('button', { name: '▶ Play' }).click();
  const startedBody = (await (await started).json()) as { playSessionId: string; start?: Record<string, unknown> };
  expect(startedBody.start).toMatchObject({ sceneId: 'scene-cave', scenes: ['scene-main', 'scene-cave'], variables: { bonus: 7 } });
  await expect(dialog).toHaveCount(0);
  const observe = observer(startedBody.playSessionId);

  // The game started at the cave's spawn (no title, no Start press), the cave loaded, the bonus counted.
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('playing');
  await expect.poll(async () => (await observe()).scenes?.loaded, { timeout: 10_000 }).toEqual(['scene-main', 'scene-cave']);
  await expect.poll(async () => (await observe()).player?.x ?? 0, { timeout: 10_000 }).toBeCloseTo(65, 0);
  await expect.poll(async () => (await observe()).counters?.['bonus']).toBe(7);
  expect((await observe()).start).toMatchObject({ ok: true });
  expect((await observe()).debugCommands?.registered).toEqual([{ name: 'grant', description: 'Add to the granted counter', args: [{ name: 'amount', type: 'number' }] }]);
  await page.screenshot({ path: 'test-results/debug-entry-play-from.png' });

  // The in-game console: the backquote key in the Play frame, a typed line.
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  await frame.locator('canvas').click();
  await page.keyboard.press('Backquote');
  const consoleRoot = frame.locator('.tl-console');
  await expect(consoleRoot).toHaveAttribute('data-open', 'true');
  await expect(consoleRoot).toContainText('grant <amount:number> — Add to the granted counter');
  await frame.getByLabel('debug console command').fill('grant 5');
  await frame.getByLabel('debug console command').press('Enter');
  await expect.poll(async () => (await observe()).counters?.['granted'], { timeout: 10_000 }).toBe(5);
  await expect(consoleRoot).toContainText(/ran grant amount=5 at step \d+/);
  await frame.getByLabel('debug console command').fill('grant lots');
  await frame.getByLabel('debug console command').press('Enter');
  await expect(consoleRoot).toContainText('amount must be a number');
  await page.screenshot({ path: 'test-results/debug-entry-console.png' });
  await page.keyboard.press('Backquote');
  await expect(consoleRoot).toHaveAttribute('data-open', 'false');

  // The §20 control route (tl_game_control's): the same command, recorded with its step.
  const ran = await api(`play/${startedBody.playSessionId}/control`, { command: 'debugCommand', name: 'grant', args: { amount: 2 } });
  expect(ran.status, JSON.stringify(ran.json)).toBe(200);
  await expect.poll(async () => (await observe()).counters?.['granted'], { timeout: 10_000 }).toBe(7);
  const applied = (await observe()).debugCommands!.applied;
  expect(applied.map((a) => [a.name, a.args])).toEqual([['grant', { amount: 5 }], ['grant', { amount: 2 }]]);
  expect(applied[1]!.stepIndex).toBeGreaterThan(applied[0]!.stepIndex);
  const refused = await api(`play/${startedBody.playSessionId}/control`, { command: 'debugCommand', name: 'grant', args: { amount: 'x' } });
  expect(refused.status).not.toBe(200);
  const unknown = await api(`play/${startedBody.playSessionId}/control`, { command: 'debugCommand', name: 'nothere' });
  expect(unknown.status).not.toBe(200);

  // A start the backend refuses: an unknown scene.
  await page.getByTitle('Stop the play preview').click();
  const bad = await api('play', { options: { demo: false, sceneId: 'scene-none' } });
  expect(bad.status).toBe(400);
});

async function mcpClient(): Promise<{ mcp: Client; call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; body: Record<string, unknown> }> }> {
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: be.projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
  };
  return { mcp, call };
}

test('with no editor open (the headless editor), tl_play_start takes a scene and variables and a debug command runs', async () => {
  test.setTimeout(180_000);
  const libs = browserLibs() as string | undefined;
  await setUp('debug-entry-headless', { THIRDLIGHT_HEADLESS: 'on', ...(libs !== undefined ? { THIRDLIGHT_BROWSER_LIBS: libs } : {}) });
  const { mcp, call } = await mcpClient();
  try {
    const started = await call('tl_play_start', { demo: false, sceneId: 'scene-cave', variables: { bonus: 2 } });
    expect(started.isError, JSON.stringify(started.body)).toBe(false);
    const playSessionId = String(started.body.playSessionId);
    const observe = async (): Promise<Obs> => (await call('tl_game_observe', { playSessionId })).body as Obs;
    await expect.poll(async () => (await observe()).state, { timeout: 45_000 }).toBe('playing');
    await expect.poll(async () => (await observe()).player?.x ?? 0, { timeout: 10_000 }).toBeCloseTo(65, 0);
    await expect.poll(async () => (await observe()).counters?.['bonus']).toBe(2);
    expect((await call('tl_game_control', { playSessionId, command: 'debugCommand', name: 'grant', args: { amount: 6 } })).isError).toBe(false);
    await expect.poll(async () => (await observe()).counters?.['granted'], { timeout: 10_000 }).toBe(6);
    expect((await call('tl_play_stop', { playSessionId })).isError).toBe(false);
  } finally {
    await mcp.close();
  }
});

test('MCP tl_play_start takes a scene and variables; tl_game_control runs a debug command', async ({ page }) => {
  test.setTimeout(180_000);
  await setUp('debug-entry-mcp');
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: be.projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown> }> => {
    const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
  };
  try {
    await page.goto(be.editorUrl);
    await expect(page.locator('.tl-statusbar')).toContainText('connected');
    // The tool text names the new options.
    const tools = (await mcp.listTools()).tools;
    expect(tools.find((t) => t.name === 'tl_play_start')!.description).toContain('variables');
    expect(tools.find((t) => t.name === 'tl_game_control')!.description).toContain('debugCommand');

    const started = await call('tl_play_start', { demo: false, sceneId: 'scene-cave', variables: { bonus: 3 }, mode: 'battle' });
    expect(started.isError, JSON.stringify(started.body)).toBe(false);
    expect(started.body.start).toMatchObject({ sceneId: 'scene-cave', variables: { bonus: 3 }, notes: ['mode "battle" ignored: the project defines no game modes'] });
    const playSessionId = String(started.body.playSessionId);
    const observe = async (): Promise<Obs> => (await call('tl_game_observe', { playSessionId })).body as Obs;
    await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('playing');
    await expect.poll(async () => (await observe()).player?.x ?? 0, { timeout: 10_000 }).toBeCloseTo(65, 0);
    await expect.poll(async () => (await observe()).counters?.['bonus']).toBe(3);

    const ran = await call('tl_game_control', { playSessionId, command: 'debugCommand', name: 'grant', args: { amount: 4 } });
    expect(ran.isError, JSON.stringify(ran.body)).toBe(false);
    await expect.poll(async () => (await observe()).counters?.['granted'], { timeout: 10_000 }).toBe(4);
    expect((await observe()).debugCommands?.applied.map((a) => a.args)).toEqual([{ amount: 4 }]);
    const wrong = await call('tl_game_control', { playSessionId, command: 'debugCommand', name: 'grant', args: { amount: true } });
    expect(wrong.isError).toBe(true);
    expect((await call('tl_play_stop', { playSessionId })).isError).toBe(false);

    // Refused starts: an unknown scene, a save in a game without levels.
    const badScene = await call('tl_play_start', { demo: false, sceneId: 'scene-none' });
    expect(badScene.isError).toBe(true);
    expect(JSON.stringify(badScene.body)).toContain('scene-none');
    const badSave = await call('tl_play_start', { demo: false, saveSlot: '1' });
    expect(badSave.isError).toBe(true);
  } finally {
    await mcp.close();
  }
});

function serve(dir: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, reply) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
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

async function startExport(game: Page, url: string): Promise<void> {
  await game.bringToFront();
  await game.goto(url);
  await expect(game.locator('#hud-root')).toContainText('to start', { timeout: 30_000 });
  await game.locator('canvas#game').click();
  await game.keyboard.press('Enter');
  const state = (): Promise<unknown> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => { state?: string } | null }).__thirdlightObserve?.() ?? null)?.state ?? null);
  await expect.poll(state, { timeout: 30_000 }).toBe('playing');
}

test('an export has no debug console unless the project turns debug_console on', async ({ page }) => {
  test.setTimeout(240_000);
  await setUp('debug-entry-export');
  const plain = await be.admin(`projects/${be.projectId}/export`);
  expect(plain.status, JSON.stringify(plain.json)).toBe(200);
  await cmd('setSettings', { settings: { debug_console: 1 } });
  const withConsole = await be.admin(`projects/${be.projectId}/export`);
  expect(withConsole.status, JSON.stringify(withConsole.json)).toBe(200);
  expect(withConsole.json.outputDir).not.toBe(plain.json.outputDir);
  await be.halt();

  const a = await serve(join(be.exportRoot, String(plain.json.outputDir)));
  const b = await serve(join(be.exportRoot, String(withConsole.json.outputDir)));
  const errors: string[] = [];
  try {
    const game = await page.context().newPage();
    game.on('pageerror', (e) => errors.push(e.message));
    await startExport(game, a.url);
    await game.keyboard.press('Backquote');
    await game.waitForTimeout(300);
    await expect(game.locator('.tl-console')).toHaveCount(0);
    await game.close();

    const game2 = await page.context().newPage();
    game2.on('pageerror', (e) => errors.push(e.message));
    await startExport(game2, b.url);
    await game2.keyboard.press('Backquote');
    await expect(game2.locator('.tl-console')).toHaveAttribute('data-open', 'true');
    await game2.getByLabel('debug console command').fill('grant 9');
    await game2.getByLabel('debug console command').press('Enter');
    await expect(game2.locator('.tl-console')).toContainText(/ran grant amount=9 at step \d+/, { timeout: 10_000 });
    await game2.screenshot({ path: 'test-results/debug-entry-export-console.png' });
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>((ok) => a.server.close(() => ok()));
    await new Promise<void>((ok) => b.server.close(() => ok()));
  }
});
