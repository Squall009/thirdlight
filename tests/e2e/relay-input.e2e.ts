/**
 * Phase 25.15: the input exercise relay (tl_input_exercise through the real
 * MCP stdio adapter, the backend's HTTP relay and the owner's editor page),
 * in both threading modes (the simulation worker and a single thread), on
 * the starter project with neutral content made by commands: a HUD with an
 * "Add" button and a "Menu" button, a modal menu with two choices, a pause
 * document as the game shell's pause screen, and a script that counts what
 * it sees (UI clicks and choices, the attack action, pointer presses the game
 * saw, steps with the pointer over the UI) into the UI view model, which
 * tl_game_observe returns.
 *
 * Checked in each mode: a run-length frame applies its steps and walks the
 * character; tl_game_observe lists the widgets' rectangles;
 * a pointer click at a button's rectangle clicks it (the game reads overUi
 * and never sees the press) while a click on the game view reaches the
 * game; UI edges move the menu's focus and pick; a virtual gamepad's button
 * drives a bound action once per press, its D-pad and A drive the menu and
 * its stick walks the character; pause shows the shell's pause screen (the
 * game holds) and submit resumes it — frames of the paused game still drive
 * its menu. The real mouse over the Add button reads overUi too (the page's
 * UI hit test), over the view it does not.
 */
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from '@playwright/test';

import { STARTER, type E2EBackend, startBackend } from './backend';

const REPO = resolve(import.meta.dirname, '..', '..');

let be: E2EBackend;
let mcp: Client;
test.beforeEach(async () => {
  be = await startBackend('relay-input-e2e', 'starter');
  mcp = new Client({ name: 'thirdlight-e2e', version: '0.0.0' });
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO, 'dist', 'mcp-adapter', 'mcp.mjs')],
      env: { ...process.env, THIRDLIGHT_AUTHORING_ORIGIN: be.origin, THIRDLIGHT_PROJECT_ID: be.projectId, THIRDLIGHT_MCP_TOKEN: be.token } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
});
test.afterEach(async () => {
  await mcp.close();
  await be.stop();
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const res = (await mcp.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text: string }> };
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text) as Record<string, unknown> };
}
const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });
async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-relay-input' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const SCRIPT = [
  'export default {',
  '  instantiate() { return { shown: false, clicks: 0, chosen: 0, attack: 0, gamePress: 0, overUi: 0 }; },',
  '  step(s: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const ui = ctx.ui;',
  "    if (!s.shown) s.shown = ui.show('hud');",
  '    for (const e of ui.events()) {',
  "      if (e.kind === 'click' && e.name === 'add') s.clicks += 1;",
  "      if (e.kind === 'click' && e.name === 'choose') { s.chosen = Number(e.value); ui.hide('menu'); }",
  '    }',
  "    if (ctx.input.pressed('attack')) s.attack += 1;",
  '    if (ctx.input.pointerPressed()) s.gamePress += 1;',
  '    const p = ctx.input.pointer();',
  '    if (p !== null && p.overUi) s.overUi += 1;',
  "    ui.set('t.clicks', s.clicks);",
  "    ui.set('t.chosen', s.chosen);",
  "    ui.set('t.attack', s.attack);",
  "    ui.set('t.gamePress', s.gamePress);",
  "    ui.set('t.overUi', s.overUi);",
  '  },',
  '};',
  '',
].join('\n');

async function setUp(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const behaviorId = 'behavior-relay-probe';
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
  await cmd('publishBehavior', { behaviorId, displayName: 'Relay probe', mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: 'Relay probe', declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId: STARTER.playerId, behaviorId, values: {} });

  const btn = { css: { background: '#304050', color: '#ffffff', padding: 6 } };
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'menu', name: 'Menu', modal: true, actionMap: 'ui',
    root: { type: 'stack', anchor: [0.5, 0.5], direction: 'column', gap: 8, children: [
      { id: 'one', type: 'button', ...btn, size: [140, 36], text: 'One', onClick: { do: 'event', name: 'choose', value: 1 } },
      { id: 'two', type: 'button', ...btn, size: [140, 36], text: 'Two', onClick: { do: 'event', name: 'choose', value: 2 } },
    ] },
  } });
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'hud', name: 'HUD',
    root: { type: 'panel', stretch: 'both', children: [
      { id: 'add', type: 'button', ...btn, size: [120, 40], anchor: [1, 0], pivot: [1, 0], offset: [-16, 16], text: 'Add', onClick: { do: 'event', name: 'add', value: 1 } },
      { id: 'open', type: 'button', ...btn, size: [120, 40], anchor: [1, 0], pivot: [1, 0], offset: [-16, 72], text: 'Menu', onClick: { do: 'show', doc: 'menu' } },
    ] },
  } });
  await cmd('setUiDocument', { document: {
    uiDocumentId: 'pause', name: 'Pause',
    root: { type: 'stack', anchor: [0.5, 0.5], direction: 'column', children: [
      { id: 'resume', type: 'button', ...btn, size: [140, 36], text: 'Resume', onClick: { do: 'engine', action: 'resume' } },
    ] },
  } });
  await cmd('setShell', { shell: { screens: { pause: 'pause' } } });
}

interface Obs {
  state: string;
  stepIndex: number;
  player: { x: number };
  simulation: { mode: string };
  pointer?: { overUi?: boolean };
  ui: { shown: string[]; screen: string | null; focus: { doc: string; widget: string } | null; values?: { t?: Record<string, number> }; elements: { doc: string; widget: string; type: string; rect: [number, number, number, number]; hit?: true; focused?: true }[] };
}

async function checks(page: Page, simThread: 1 | 2, mode: 'worker' | 'single'): Promise<void> {
  await setUp(page);
  await cmd('setSettings', { settings: { sim_thread: simThread } });
  const started = await call('tl_play_start', { demo: false });
  expect(started.isError, JSON.stringify(started.body)).toBe(false);
  const playSessionId = String(started.body.playSessionId);
  const observe = async (): Promise<Obs> => (await call('tl_game_observe', { playSessionId })).body as unknown as Obs;
  const t = async (k: string): Promise<number> => (await observe()).ui.values?.t?.[k] ?? -1;
  const exercise = async (frames: unknown[]): Promise<Record<string, unknown>> => {
    const r = await call('tl_input_exercise', { playSessionId, frames });
    expect(r.isError, JSON.stringify(r.body)).toBe(false);
    return r.body;
  };
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('running');
  expect((await observe()).simulation.mode).toBe(mode);
  await expect.poll(async () => (await observe()).ui?.shown ?? [], { timeout: 10_000 }).toContain('hud');
  expect((await call('tl_game_control', { playSessionId, command: 'mute' })).isError).toBe(false);

  // ---- run length: one frame held for 90 steps walks the character as the same steps written out ----
  /** The character's x once it stands still. */
  const settled = async (): Promise<number> => {
    let last = Number.NaN;
    await expect.poll(async () => {
      const x = (await observe()).player.x;
      const still = Math.abs(x - last) < 1e-6;
      last = x;
      return still;
    }, { timeout: 10_000 }).toBe(true);
    return last;
  };
  // One frame held for 90 steps walks the character (90 steps applied).
  const x0 = await settled();
  const walked = await exercise([{ stepOffset: 0, steps: 90, actions: { move: { v: 1, p: 'none' } } }]);
  expect(Number(walked.appliedToStep) - Number(walked.appliedFromStep)).toBe(89);
  expect((await settled()) - x0).toBeGreaterThan(2);

  // ---- element rectangles ----
  const els = (await observe()).ui.elements;
  const add = els.find((e) => e.doc === 'hud' && e.widget === 'add')!;
  const open = els.find((e) => e.doc === 'hud' && e.widget === 'open')!;
  expect(add, JSON.stringify(els)).toBeDefined();
  expect(add.hit).toBe(true);
  expect(add.type).toBe('button');
  // The Add button sits at the top right (anchor [1, 0], 16 px in).
  expect(add.rect[0] + add.rect[2]).toBeGreaterThan(0.9);
  expect(add.rect[1]).toBeLessThan(0.2);
  const centre = (r: [number, number, number, number]): { x: number; y: number } => ({ x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 });

  // ---- a pointer click through the UI hit test: the button clicks, the game sees no press but reads overUi ----
  const a = centre(add.rect);
  await exercise([
    { stepOffset: 0, pointer: { x: a.x, y: a.y, buttons: 1 } },
    { stepOffset: 1, steps: 5, pointer: { x: a.x, y: a.y } },
  ]);
  await expect.poll(() => t('clicks'), { timeout: 10_000 }).toBe(1);
  expect(await t('gamePress')).toBe(0);
  expect(await t('overUi')).toBeGreaterThanOrEqual(6);
  expect((await observe()).pointer?.overUi).toBe(true);
  // A click on the game view reaches the game (no UI click).
  await exercise([{ stepOffset: 0, pointer: { x: 0.3, y: 0.6, pressed: 1, released: 1 } }, { stepOffset: 1, pointer: { x: 0.3, y: 0.6 } }]);
  await expect.poll(() => t('gamePress'), { timeout: 10_000 }).toBe(1);
  expect(await t('clicks')).toBe(1);
  expect((await observe()).pointer?.overUi).toBeUndefined();

  // ---- UI edges: open the menu by a click, move its focus down and pick ----
  const o = centre(open.rect);
  await exercise([{ stepOffset: 0, pointer: { x: o.x, y: o.y, pressed: 1, released: 1 } }]);
  await expect.poll(async () => (await observe()).ui.focus, { timeout: 10_000 }).toEqual({ doc: 'menu', widget: 'one' });
  await exercise([{ stepOffset: 0, ui: ['down'] }, { stepOffset: 5, ui: ['submit'] }]);
  await expect.poll(() => t('chosen'), { timeout: 10_000 }).toBe(2);
  await expect.poll(async () => (await observe()).ui.shown, { timeout: 10_000 }).not.toContain('menu');

  // ---- the virtual gamepad: a bound button (attack: button 2) once per press, the D-pad and A drive the menu, the stick walks ----
  await exercise([{ stepOffset: 0, steps: 4, gamepad: { buttons: [0, 0, 1] } }, { stepOffset: 10, steps: 4, gamepad: { buttons: [0, 0, 1] } }]);
  await expect.poll(() => t('attack'), { timeout: 10_000 }).toBe(2);
  await exercise([{ stepOffset: 0, pointer: { x: o.x, y: o.y, pressed: 1, released: 1 } }]);
  await expect.poll(async () => (await observe()).ui.focus, { timeout: 10_000 }).toEqual({ doc: 'menu', widget: 'one' });
  const dpadDown = Array.from({ length: 17 }, (_, i) => (i === 13 ? 1 : 0));
  await exercise([{ stepOffset: 0, steps: 3, gamepad: { buttons: dpadDown } }, { stepOffset: 6, steps: 3, gamepad: { buttons: [1] } }]);
  await expect.poll(async () => (await observe()).ui.shown, { timeout: 10_000 }).not.toContain('menu');
  expect(await t('chosen')).toBe(2);
  const xs = await settled();
  await exercise([{ stepOffset: 0, steps: 90, gamepad: { axes: [-1, 0] } }]);
  expect(xs - (await settled())).toBeGreaterThan(2);

  // ---- pause: the shell's pause screen holds the game; frames of the paused game still drive it; submit resumes ----
  await exercise([{ stepOffset: 0, ui: ['pause'] }, { stepOffset: 30, ui: ['submit'] }]);
  await expect.poll(async () => (await observe()).state, { timeout: 10_000 }).toBe('running');
  expect((await observe()).ui.screen).toBeNull();
  await exercise([{ stepOffset: 0, ui: ['pause'] }]);
  await expect.poll(async () => (await observe()).state, { timeout: 10_000 }).toBe('paused');
  const paused = await observe();
  expect(paused.ui.screen).toBe('pause');
  expect(paused.ui.focus).toEqual({ doc: 'pause', widget: 'resume' });
  // A click on the pause screen's Resume button while paused.
  const resume = centre(paused.ui.elements.find((e) => e.doc === 'pause' && e.widget === 'resume')!.rect);
  await exercise([{ stepOffset: 0, pointer: { x: resume.x, y: resume.y, buttons: 1 } }, { stepOffset: 2, pointer: { x: resume.x, y: resume.y } }]);
  await expect.poll(async () => (await observe()).state, { timeout: 10_000 }).toBe('running');

  // ---- the real mouse: over the Add button the game reads overUi, over the view it does not ----
  const box = (await page.locator('iframe.tl-app__preview-frame').boundingBox())!;
  await page.mouse.move(box.x + 0.3 * box.width, box.y + 0.6 * box.height);
  await page.mouse.move(box.x + a.x * box.width, box.y + a.y * box.height, { steps: 4 });
  await expect.poll(async () => (await observe()).pointer?.overUi, { timeout: 10_000 }).toBe(true);
  const over = (await observe()).pointer as unknown as { x: number; y: number };
  expect(over.x).toBeCloseTo(a.x, 1);
  expect(over.y).toBeCloseTo(a.y, 1);
  await page.mouse.move(box.x + 0.3 * box.width, box.y + 0.6 * box.height, { steps: 4 });
  await expect.poll(async () => (await observe()).pointer?.overUi ?? false, { timeout: 10_000 }).toBe(false);

  expect((await call('tl_play_stop', { playSessionId })).isError).toBe(false);
}

test('tl_input_exercise in the simulation worker: run length, UI hit test and clicks, UI edges, a virtual gamepad, pause', async ({ page }) => {
  test.setTimeout(240_000);
  await checks(page, 1, 'worker');
});

test('tl_input_exercise on a single thread: run length, UI hit test and clicks, UI edges, a virtual gamepad, pause', async ({ page }) => {
  test.setTimeout(240_000);
  await checks(page, 2, 'single');
});
