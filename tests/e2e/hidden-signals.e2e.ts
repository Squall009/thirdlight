/**
 * Authored hidden objects, signals from tools and dialogue glyphs, against a
 * real backend and a real browser (the starter template).
 *
 * A magenta wall behind everything, and three timelines: `reveal` (on the
 * signal `reveal`) shows the wall with an activation key, `conceal` (on the
 * signal `conceal`) hides it, `talk` (on the signal `talk`) runs a one-line
 * conversation whose text names an input action's glyph.
 *
 * - Editor: the Inspector's "Visible" checkbox stores `visible: false` on the
 *   wall (one `updateEntity`), the Hierarchy marks the row, a reload keeps it;
 *   the Scene view still draws the wall.
 * - Play: the wall is loaded but not drawn (no magenta in the picture; the
 *   observation lists it hidden). MCP `tl_game_control {signal: 'reveal'}`
 *   through the stdio adapter shows it (magenta in the picture) and is listed
 *   as the engine's `signal` call; a value is refused. The in-game console's
 *   `signal conceal` hides it again. `{signal: 'talk'}` starts the
 *   conversation and its line shows the key's glyph.
 * - Export (served statically, backend stopped, the debug console on): the
 *   wall starts hidden and the console's `signal reveal` shows it, in pixels.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-hidden-signals' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}
async function api(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

function share(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  let all = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      all += 1;
      if (test(r, g, b)) n += 1;
    }
  }
  return n / all;
}
const magenta = (r: number, g: number, b: number): boolean => r > 60 && b > 60 && g < 0.65 * Math.min(r, b);

async function entityOf(entityId: string): Promise<Record<string, unknown> | undefined> {
  const list = (await query('queryEntities', { limit: 500, offset: 0 }))['entities'] as Record<string, unknown>[];
  return list.find((e) => e['id'] === entityId);
}

/** The wall, the timelines, the conversation and an input action with a key. */
async function setUp(projectId: string): Promise<string> {
  be = await startBackend(projectId, 'starter');
  const wallId = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Secret wall', transform: { position: [4, 3, -4] }, box: { size: [60, 40, 1], material: { color: '#ff00ff' } } }))['createdId']);
  const activation = (timelineId: string, active: boolean) => ({
    timelineId,
    name: timelineId,
    duration: 0.2,
    playOnSignal: timelineId,
    slots: [{ name: 'wall', entity: wallId }],
    tracks: [{ trackId: 'show', type: 'activation', target: 'wall', keys: [{ time: 0, active }] }],
  });
  await cmd('setTimeline', { timeline: activation('reveal', true) });
  await cmd('setTimeline', { timeline: activation('conceal', false) });
  await cmd('setInput', { input: { actions: [{ name: 'wave', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyG' }] }] } });
  const node = (id: string, type: string, y: number, data?: Record<string, unknown>) => ({ id, type, position: [0, y], ...(data !== undefined ? { data } : {}) });
  await cmd('setDialogue', {
    dialogue: {
      dialogueId: 'hint',
      name: 'Hint',
      graph: {
        nodes: [node('start', 'start', 0), node('say', 'line', 100, { text: 'Press {action:wave} to wave.' })],
        edges: [{ id: 'w1', from: { node: 'start', port: 'next' }, to: { node: 'say', port: 'in' } }],
      },
    },
  });
  await cmd('setDialogueSettings', { settings: { textSpeed: 200 } });
  await cmd('setTimeline', { timeline: { timelineId: 'talk', name: 'talk', duration: 0.2, playOnSignal: 'talk', tracks: [{ trackId: 'line', type: 'dialogue', keys: [{ time: 0, dialogue: 'hint' }] }] } });
  return wallId;
}

async function mcpClient(): Promise<{ mcp: Client; call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; body: Record<string, unknown>; text: string }> }> {
  const mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be!.origin, THIRDLIGHT_PROJECT_ID: be!.projectId, THIRDLIGHT_MCP_TOKEN: be!.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown>; text: string }> => {
    const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
    const text = res.content[0]!.text;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { text };
    }
    return { isError: res.isError === true, body, text };
  };
  return { mcp, call };
}

test('Visible off in the Inspector: hidden in Play until a tool signal shows it; the console signal hides it; a dialogue line shows a glyph', async ({ page }) => {
  test.setTimeout(300_000);
  const wallId = await setUp('hidden-signals-e2e');
  await page.goto(be!.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The Inspector's Visible checkbox: stored as visible: false, marked in the Hierarchy, kept after a reload.
  const row = page.locator(`.tl-hierarchy__list li[data-entity-id="${wallId}"]`);
  await row.click();
  const visible = page.locator('.tl-inspector__flags').getByLabel('Visible', { exact: true });
  await expect(visible).toBeChecked();
  await expect(row.locator('[data-flag="hidden"]')).toHaveCount(0);
  await visible.click();
  await expect.poll(async () => (await entityOf(wallId))?.['visible']).toBe(false);
  await expect(visible).not.toBeChecked();
  await expect(row.locator('[data-flag="hidden"]')).toHaveCount(1);
  // The Scene view still draws it (an editing view): magenta in the viewport.
  const viewShot = async (): Promise<Image> => decodePng(await page.locator('canvas.tl-viewport').screenshot());
  await expect.poll(async () => share(await viewShot(), magenta), { timeout: 20_000 }).toBeGreaterThan(0.1);
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${wallId}"]`).click();
  await expect(page.locator('.tl-inspector__flags').getByLabel('Visible', { exact: true })).not.toBeChecked();

  // Play: loaded but not drawn.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const playSessionId = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; hidden?: string[]; debugCommands?: { applied: { name: string; args: Record<string, unknown> }[] }; dialogue?: { running: boolean; line: { reveal: number; total: number } | null } };
  const observe = async (): Promise<Obs> => (await api(`play/${playSessionId}/observe`)).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  const shot = async (): Promise<Image> => {
    const r = await api(`play/${playSessionId}/screenshot`, { maxWidth: 512 });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    return decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  };
  // A running simulation may precede the first drawn frame; the preview says so (503) until then.
  await expect.poll(async () => (await api(`play/${playSessionId}/screenshot`, { maxWidth: 512 })).status, { timeout: 60_000 }).toBe(200);
  expect((await observe()).hidden).toContain(wallId);
  const before = share(await shot(), magenta);
  console.log(`play start: magenta ${before.toFixed(3)}`);
  expect(before).toBeLessThan(0.01);

  const { mcp, call } = await mcpClient();
  try {
    const tools = (await mcp.listTools()).tools;
    expect(tools.find((t) => t.name === 'tl_game_control')!.description).toContain('{signal: name}');
    // A value is refused (signals carry none); nothing is sent.
    const withValue = await call('tl_game_control', { playSessionId, signal: 'reveal', value: 3 });
    expect(withValue.isError).toBe(true);
    expect(withValue.text).toContain('no value');
    const shown = await call('tl_game_control', { playSessionId, signal: 'reveal' });
    expect(shown.isError, shown.text).toBe(false);
    await expect.poll(async () => share(await shot(), magenta), { timeout: 20_000 }).toBeGreaterThan(0.2);
    console.log(`after tl_game_control signal reveal: magenta ${share(await shot(), magenta).toFixed(3)}`);
    expect((await observe()).hidden ?? []).not.toContain(wallId);
    expect((await observe()).debugCommands?.applied.map((a) => [a.name, a.args])).toEqual([['signal', { name: 'reveal' }]]);

    // The in-game console: `signal conceal` hides it again.
    const frame = page.frameLocator('iframe.tl-app__preview-frame');
    await frame.locator('canvas').first().click();
    await page.keyboard.press('Backquote');
    const consoleRoot = frame.locator('.tl-console');
    await expect(consoleRoot).toHaveAttribute('data-open', 'true');
    await expect(consoleRoot).toContainText('signal <name:string>');
    await frame.getByLabel('debug console command').fill('signal conceal');
    await frame.getByLabel('debug console command').press('Enter');
    await expect(consoleRoot).toContainText(/ran signal name="conceal" at step \d+/);
    await expect.poll(async () => share(await shot(), magenta), { timeout: 20_000 }).toBeLessThan(0.01);
    expect((await observe()).hidden).toContain(wallId);
    await page.keyboard.press('Backquote');
    await expect(consoleRoot).toHaveAttribute('data-open', 'false');

    // Dialogue glyphs: the line's {action:wave} is the key's glyph (the keyboard was used last).
    expect((await call('tl_game_control', { playSessionId, signal: 'talk' })).isError).toBe(false);
    await expect.poll(async () => (await observe()).dialogue?.running, { timeout: 20_000 }).toBe(true);
    // (The line box and the backlog each show it.)
    const glyph = frame.locator('.tl-ui-glyph[data-action="wave"]').first();
    await expect(glyph).toHaveAttribute('data-glyph', 'G', { timeout: 20_000 });
    await expect(glyph).toBeVisible();
    // One visible character: the reveal of the whole line counts the glyph as one.
    await expect.poll(async () => (await observe()).dialogue?.line?.total).toBe('Press # to wave.'.length);
    await page.screenshot({ path: 'test-results/hidden-signals-dialogue-glyph.png' });
  } finally {
    await mcp.close();
  }
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
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

async function exportShot(game: Page): Promise<Image> {
  return decodePng(await game.locator('canvas#game').screenshot());
}

test('an export starts the authored-hidden wall hidden and the console signal shows it, in pixels', async ({ page }) => {
  test.setTimeout(240_000);
  const wallId = await setUp('hidden-signals-export');
  await cmd('updateEntity', { entityId: wallId, visible: false });
  await cmd('setSettings', { settings: { debug_console: 1 } });
  const exported = await be!.admin(`projects/${be!.projectId}/export`);
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
  await be!.halt();
  const served = await serve(join(be!.exportRoot, String(exported.json.outputDir)));
  const errors: string[] = [];
  try {
    const game = await page.context().newPage();
    game.on('pageerror', (e) => errors.push(e.message));
    await game.goto(served.url);
    const observe = (): Promise<{ state?: string; hidden?: string[] } | null> => game.evaluate(() => (window as unknown as { __thirdlightObserve?: () => { state?: string; hidden?: string[] } | null }).__thirdlightObserve?.() ?? null);
    await expect.poll(async () => (await observe())?.state, { timeout: 30_000 }).toBe('running');
    await game.waitForTimeout(500);
    const start = share(await exportShot(game), magenta);
    console.log(`export start: magenta ${start.toFixed(3)}`);
    expect(start).toBeLessThan(0.01);
    await game.locator('canvas#game').click();
    await game.keyboard.press('Backquote');
    await expect(game.locator('.tl-console')).toHaveAttribute('data-open', 'true');
    await game.getByLabel('debug console command').fill('signal reveal');
    await game.getByLabel('debug console command').press('Enter');
    await expect(game.locator('.tl-console')).toContainText(/ran signal name="reveal" at step \d+/);
    await game.keyboard.press('Backquote');
    await expect.poll(async () => share(await exportShot(game), magenta), { timeout: 20_000 }).toBeGreaterThan(0.2);
    console.log(`export after signal reveal: magenta ${share(await exportShot(game), magenta).toFixed(3)}`);
    expect(errors).toEqual([]);
  } finally {
    served.server.close();
  }
});
