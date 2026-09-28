/**
 * Phase 24.9 acceptance: a new project from the Starter template is built into
 * a small game in the editor, using only engine primitives and a project
 * script, and played in a real browser against a real backend.
 *
 * - Editor ("+ Add component" and the Inspector): a collectible (counter
 *   `items`), a patroller on waypoints with a damaging hitbox, health on the
 *   character, a trigger whose scene transition leads to a second scene; the
 *   Game shell tab sets a title screen and a HUD. The UI documents, the
 *   second scene and the project script are made by the same editing
 *   commands the editor and MCP use.
 * - The game's rules live only in the project script `rules` on the
 *   character: when the character's health reaches 0 (`died`) it counts a
 *   death, respawns the character (`ctx.lifecycle.respawn`) and heals it. The
 *   engine has no rule for what a death means.
 * - Play, driven by the input exercise relay (tl_input_exercise's route):
 *   the title holds the game until Start; walking left collects the item
 *   (the HUD shows it), walking on into the patroller takes the character's
 *   only health point and the script respawns it at the spawn; walking right
 *   enters the door and the second scene loads with the character at its
 *   spawn.
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { controls, STARTER, startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('starter-game-e2e', 'starter');
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
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-starter-game' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function create(name: string, position: number[], extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> {
  return String((await cmd('createEntity', { parentId: null, kind, name, transform: { position }, ...extra }))['createdId']);
}
async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await query('queryEntity', { entityId: id });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
}

/** Publish a project script and attach it to `entityId`. */
async function script(behaviorId: string, source: string, entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
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

/**
 * The game's rules (the project's own script, on the character): a hit is
 * counted; reaching 0 health is a death, which is counted, respawns the
 * character at the active spawn and gives its health back.
 */
const RULES = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return {}; },',
  '  step(_state: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    for (const e of ctx.events) {',
  '      if (e.entity !== ctx.entityId) continue;',
  "      if (e.type === 'damaged') ctx.game.add('hits', 1);",
  "      if (e.type === 'died') {",
  "        ctx.game.add('deaths', 1);",
  '        ctx.lifecycle.respawn();',
  '        const hp = ctx.health.get(ctx.entityId);',
  '        if (hp !== null) ctx.health.heal(ctx.entityId, hp.max);',
  '      }',
  '    }',
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

const FULL = { anchor: [0, 0], pivot: [0, 0], stretch: 'both' };
const TITLE = {
  uiDocumentId: 'title',
  name: 'Title',
  root: {
    type: 'panel',
    ...FULL,
    css: { background: '#1d3557' },
    children: [
      { type: 'text', id: 'name', anchor: [0.5, 0.3], pivot: [0.5, 0.5], text: 'Little Walk', css: { color: '#ffffff', fontSize: 40 } },
      { type: 'button', id: 'start', anchor: [0.5, 0.7], pivot: [0.5, 0.5], size: [220, 56], text: 'Start', css: { color: '#ffffff', background: '#457b9d', fontSize: 22 }, onClick: { do: 'engine', action: 'newGame' } },
    ],
  },
};
const HUD = {
  uiDocumentId: 'hud',
  name: 'HUD',
  root: { type: 'panel', anchor: [0, 0], pivot: [0, 0], offset: [12, 12], size: [320, 44], css: { background: '#203040', padding: 8 }, children: [{ type: 'text', id: 'line', text: 'Items {$flow.counters.items} / Deaths {$flow.counters.deaths}', css: { color: '#ffffff', fontSize: 20 } }] },
};

interface Obs {
  state?: string;
  stepIndex?: number;
  paused?: boolean;
  player?: { x: number; y: number };
  counters?: Record<string, number>;
  health?: Record<string, { current: number; max: number }>;
  hidden?: string[];
  scenes?: { loaded: string[] };
  shell?: { screen: string; hud: string[] };
}

async function select(page: Page, id: string): Promise<void> {
  await page.getByRole('tab', { name: 'Scene', exact: true }).click().catch(() => undefined);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
}
async function field(page: Page, label: string, value: string): Promise<void> {
  const f = page.locator('.tl-inspector').getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
}

test('acceptance: a small game from the Starter template with primitives and a project script — title, HUD counter, damage and respawn, scene transition', async ({ page }) => {
  test.setTimeout(300_000);
  // The second scene: a floor far to the right and a spawn on it.
  await cmd('createScene', { name: 'Second', sceneId: 'scene-two' });
  await create('Second floor', [40, -0.2, 0], { sceneId: 'scene-two', box: { size: [12, 0.4, 1], material: { color: '#5a7a8a' } }, components: { collider: { shape: { type: 'box', hx: 6, hy: 0.2 } } } }, 'box');
  const arrival = await create('Arrival', [40, 0.91, 0], { sceneId: 'scene-two', components: { playerSpawn: {} } });
  // In the first scene: an item left of the character's start (x 3), a walker between it and the crate (x −2), a door right of it.
  const item = await create('Item', [1.8, 0.91, 0], { box: { size: [0.4, 0.4, 0.1], material: { color: '#ffd166' } } }, 'box');
  const walker = await create('Walker', [-1, 0.5, 0], { box: { size: [1, 1, 1], material: { color: '#c0392b' } } }, 'box');
  const door = await create('Door', [6.2, 1, 0]);
  for (const d of [TITLE, HUD]) await cmd('setUiDocument', { document: d });
  await script('rules', RULES, STARTER.playerId);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const inspector = page.locator('.tl-inspector');
  const add = inspector.getByLabel('add component', { exact: true });

  // The collectible.
  await select(page, item);
  await add.selectOption({ label: 'Collectible' });
  await expect.poll(async () => comp(item, 'collectible')).toEqual({ counter: 'items' });

  // The patroller: waypoints (0.8 m to the right and back) and a hitbox that takes 1 health.
  await select(page, walker);
  await add.selectOption({ label: 'Patrol: Waypoints' });
  await expect.poll(async () => (await comp(walker, 'patrol'))?.['mode']).toBe('waypoints');
  await field(page, 'patrol waypoints 1 x', '0.8');
  await expect.poll(async () => (await comp(walker, 'patrol'))?.['waypoints']).toEqual([[0.8, 0, 0]]);
  await add.selectOption({ label: 'Hitbox: Box' });
  await expect.poll(async () => comp(walker, 'hitbox')).toEqual({ size: [1, 1] });
  await field(page, 'hitbox damage', '1');
  await expect.poll(async () => (await comp(walker, 'hitbox'))?.['damage']).toBe(1);

  // Health on the character: one point.
  await select(page, STARTER.playerId);
  await add.selectOption({ label: 'Health' });
  await expect.poll(async () => comp(STARTER.playerId, 'health')).toEqual({ max: 3 });
  await field(page, 'health max', '1');
  await expect.poll(async () => comp(STARTER.playerId, 'health')).toEqual({ max: 1 });

  // The door: a trigger whose scene transition leads to the second scene's spawn.
  await select(page, door);
  await add.selectOption({ label: 'Trigger' });
  await expect.poll(async () => comp(door, 'trigger')).toEqual({ size: [2, 2], signal: 'trigger' });
  await inspector.getByLabel('add trigger sceneTransition', { exact: true }).click();
  await expect.poll(async () => (await comp(door, 'trigger'))?.['sceneTransition']).toEqual({ scene: 'scene-two' });
  await inspector.getByLabel('trigger sceneTransition spawn', { exact: true }).selectOption(arrival);
  await expect.poll(async () => (await comp(door, 'trigger'))?.['sceneTransition']).toEqual({ scene: 'scene-two', spawn: arrival });

  // The game shell: the title screen and the HUD.
  await page.getByRole('tab', { name: 'Game shell' }).click();
  const panel = page.getByLabel('game shell', { exact: true });
  const shell = async (): Promise<unknown> => (await query('queryGameConfig'))['shell'];
  await panel.getByRole('button', { name: 'add game shell' }).click();
  await expect.poll(shell).toEqual({});
  await panel.getByLabel('add shell screens', { exact: true }).click();
  await panel.getByLabel('shell screens title', { exact: true }).selectOption('title');
  await panel.getByLabel('add shell hud', { exact: true }).click();
  await panel.getByLabel('shell hud 1', { exact: true }).selectOption('hud');
  await expect.poll(shell).toEqual({ screens: { title: 'title' }, hud: ['hud'] });

  // Play.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Obs> => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? (r.json as Obs) : {};
  };
  const counter = async (name: string): Promise<number> => (await observe()).counters?.[name] ?? 0;
  const frame = page.locator('iframe.tl-app__preview-frame').contentFrame();

  // The title first: the game waits behind it.
  await expect.poll(async () => (await observe()).shell?.screen ?? null, { timeout: 60_000 }).toBe('title');
  expect((await observe()).state).toBe('paused');
  await expect(frame.locator('[data-tl-ui-doc="title"] [data-widget="name"]')).toHaveText('Little Walk');
  await frame.locator('[data-tl-ui-doc="title"] [data-widget="start"]').click();
  await expect.poll(async () => (await observe()).shell?.screen ?? null, { timeout: 15_000 }).toBe('playing');
  expect((await observe()).state).toBe('running');
  const hud = frame.locator('[data-tl-ui-doc="hud"] [data-widget="line"]');
  await expect(hud).toBeVisible();
  await expect(hud).not.toContainText('Items 1');
  await expect.poll(async () => (await observe()).health?.[STARTER.playerId], { timeout: 10_000 }).toEqual({ current: 1, max: 1 });

  /** The input exercise: short runs of the move action until `done` holds (the relay answers once its frames are applied). */
  const drive = async (moveX: number, done: (o: Obs) => boolean, what: string): Promise<void> => {
    for (let i = 0; i < 80; i += 1) {
      if (done(await observe())) return;
      const frames = Array.from({ length: 10 }, (_, k) => ({ stepOffset: k, ...controls(moveX) }));
      const r = await api(`play/${psid}/input`, { mode: 'exclusive-test', frames });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    expect(done(await observe()), what).toBe(true);
  };

  // Left over the item: the counter rises and the HUD shows it.
  await drive(-1, (o) => (o.counters?.['items'] ?? 0) >= 1, 'the item is collected');
  expect(await counter('items')).toBe(1);
  expect((await observe()).hidden ?? []).toContain(item);
  await expect(hud).toContainText('Items 1');
  expect(await counter('deaths')).toBe(0);

  // On into the patroller: its hitbox takes the only health point; the project script counts the death, respawns and heals.
  await drive(-1, (o) => (o.counters?.['deaths'] ?? 0) >= 1, 'the patroller hits the character');
  // Back at the spawn (x 3; the hit needs x < 0.6). The relay's run that was under way when it died may carry it a little left again.
  await expect.poll(async () => (await observe()).player?.x ?? -99, { timeout: 10_000 }).toBeGreaterThan(2);
  const back = (await observe()).player!;
  expect(back.x).toBeLessThan(3.2);
  expect(await counter('hits')).toBe(1);
  expect(await counter('deaths')).toBe(1);
  await expect.poll(async () => (await observe()).health?.[STARTER.playerId], { timeout: 10_000 }).toEqual({ current: 1, max: 1 });
  await expect(hud).toContainText('Deaths 1');
  expect((await observe()).state).toBe('running');

  // Right into the door: the second scene loads and the character stands at its spawn.
  await drive(1, (o) => (o.scenes?.loaded ?? []).includes('scene-two') && (o.player?.x ?? 0) > 39, 'the door leads to the second scene');
  const there = (await observe()).player!;
  expect(there.x).toBeLessThan(41);
  expect(await counter('items')).toBe(1);
  expect(await counter('deaths')).toBe(1);
  await expect(hud).toContainText('Items 1');
  await page.screenshot({ path: 'test-results/starter-game.png' });
  await expect(page.locator('.tl-notice')).toHaveCount(0);
});
