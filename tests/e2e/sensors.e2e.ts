/**
 * Phase 14.2: timers and sensors against a real backend, on the engine
 * sample (Beacon Reach) with neutral additions:
 *
 * - Editor: GameObject → Gameplay → Trigger; the Inspector turns it into a
 *   circle (one edit converts the size to a radius), sets `mode: stay`; the
 *   Scene view shows one radius handle, a drag stores a snapped radius and
 *   one undo restores it.
 * - Play: the circle sits on the player's start (radius 0.5, stay, signal
 *   "here"); a magenta door beside the player carries a script whose
 *   entityRef property names the trigger. On the trigger's `enter` event
 *   (ctx.events) it starts a 1 s timer that hides the door, which comes back
 *   4 s later (ctx.timers.after/fired); an `every` timer counts ticks and the
 *   stay signal counts every step inside. Observed through the game counters
 *   and as magenta pixels (door shown, gone, shown again).
 */
import { createHash } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('sensors-e2e', 'beacon-reach');
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
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-sensors' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

type Entity = { id: string; name?: string; components: Record<string, unknown> };
const entities = async (): Promise<Entity[]> => (await query('queryEntities', { limit: 200, offset: 0 }))['entities'] as Entity[];

type Handle = { component: string; handle: 'top' | 'side'; x: number; y: number };
async function handles(page: Page): Promise<Handle[]> {
  return JSON.parse((await page.locator('canvas[data-size-handles]').getAttribute('data-size-handles')) ?? '[]') as Handle[];
}

async function field(page: Page, label: string, value: string): Promise<void> {
  const f = page.locator('.tl-inspector').getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
  await expect(f).toHaveValue(value);
}

/** Publish a behavior (one entityRef property, "sensor") and attach it to `entityId` with `values`. */
async function script(behaviorId: string, source: string, entityId: string, values: Record<string, unknown>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [{ key: 'sensor', label: 'Sensor trigger', type: 'entityRef', default: null }] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${createHash('sha256').update(behaviorId).digest('hex').slice(0, 32)}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values });
}

/**
 * The timed door: the step after the player enters its sensor it waits one
 * second, hides itself, and shows itself again four seconds later.
 */
const DOOR = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return {}; },',
  '  step(_state: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    if (ctx.signals.on('here')) ctx.game.add('stayed', 1);",
  "    ctx.timers.every('tick', 0.5);",
  "    if (ctx.timers.fired('tick')) ctx.game.add('ticks', 1);",
  '    for (const e of ctx.events) {',
  "      if (e.type === 'enter' && e.trigger === ctx.properties.sensor) { ctx.game.add('entered', 1); ctx.timers.after('open', 1); }",
  '    }',
  "    if (ctx.timers.fired('open')) { ctx.game.setVisible(ctx.entityId, false); ctx.game.add('opened', 1); ctx.timers.after('close', 4); }",
  "    if (ctx.timers.fired('close')) { ctx.game.setVisible(ctx.entityId, true); ctx.game.add('closed', 1); }",
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

/** Clearly magenta pixels (the door colour; nothing else in the sample is). */
async function magenta(target: Page | Locator): Promise<number> {
  const img = decodePng(await target.screenshot());
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 110 && b > 100 && g < 50) n += 1;
    }
  }
  return n;
}

test('a circle trigger in the Inspector and the Scene view; a timed door script opens and closes in Play', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // A trigger from the menu, turned into a circle on the player's start with stay mode.
  await menu(page, 'GameObject', 'Gameplay', 'Trigger');
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Trigger');
  await field(page, 'position x', '3');
  await field(page, 'position y', '0.91');
  await field(page, 'position z', '0');
  const trigger = (await entities()).find((e) => e.name === 'Trigger')!;
  const triggerValue = async (): Promise<Record<string, unknown>> => (await entities()).find((e) => e.id === trigger.id)!.components['trigger'] as Record<string, unknown>;
  expect(await triggerValue()).toEqual({ size: [2, 2], signal: 'trigger' });
  await page.getByLabel('trigger shape').selectOption('circle');
  await expect.poll(triggerValue).toEqual({ signal: 'trigger', shape: 'circle', radius: 1 });
  await expect(page.locator('.tl-inspector').getByLabel('trigger radius', { exact: true })).toHaveValue('1');
  await expect(page.locator('.tl-inspector').getByLabel('trigger size', { exact: true })).toHaveCount(0);
  await page.getByLabel('trigger mode').selectOption('stay');
  await field(page, 'trigger signal', 'here');
  await expect.poll(triggerValue).toEqual({ signal: 'here', shape: 'circle', radius: 1, mode: 'stay' });

  // The Scene view: one radius handle; a drag outward stores a larger, snapped radius; one undo restores it.
  await page.keyboard.press('f');
  const view = page.locator('canvas[data-size-handles]');
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(30);
  }
  await expect.poll(async () => (await handles(page)).filter((h) => h.component === 'trigger').map((h) => h.handle)).toEqual(['side']);
  await page.waitForTimeout(300);
  const side = (await handles(page)).find((h) => h.component === 'trigger')!;
  await page.mouse.move(side.x, side.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(side.x + i * 10, side.y);
  await page.mouse.up();
  await expect.poll(async () => (await triggerValue())['radius'] as number).toBeGreaterThan(1.04);
  const r = (await triggerValue())['radius'] as number;
  expect(Math.abs(r / 0.05 - Math.round(r / 0.05))).toBeLessThan(1e-6);
  expect(await triggerValue()).toMatchObject({ signal: 'here', shape: 'circle', mode: 'stay' });
  await view.hover();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await triggerValue())['radius']).toBe(1);
  // A small circle on the start: the player stands inside it when the run begins.
  await field(page, 'trigger radius', '0.5');
  await expect.poll(triggerValue).toEqual({ signal: 'here', shape: 'circle', radius: 0.5, mode: 'stay' });

  // The door: a magenta slab right of the player, with the timed script naming the trigger.
  const made = await cmd('createEntity', { kind: 'box', name: 'Timed door', transform: { position: [5, 1.3, 0] }, box: { size: [0.5, 2.6, 1], material: { color: '#ff00ff' } } });
  const doorId = String(made.createdId);
  await script('behavior-timed-door', DOOR, doorId, { sensor: trigger.id });

  // Play.
  const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number> };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  const counter = async (name: string): Promise<number> => (await observe()).counters?.[name] ?? 0;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('awaitingStart');
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect.poll(async () => magenta(frame), { timeout: 20_000 }).toBeGreaterThan(40);
  const shut = await magenta(frame);
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(async () => (await observe()).state).toBe('playing');

  // The player starts inside the circle: one enter event, the stay signal every step.
  await expect.poll(async () => counter('entered'), { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => counter('stayed'), { timeout: 30_000 }).toBeGreaterThan(30);
  // One second later the door opens (hidden: no magenta), four seconds after that it closes again.
  await expect.poll(async () => counter('opened'), { timeout: 30_000 }).toBe(1);
  expect(await counter('closed')).toBe(0);
  await expect.poll(async () => magenta(frame), { timeout: 10_000 }).toBeLessThan(shut / 10);
  await page.screenshot({ path: 'test-results/sensors-open.png' });
  await expect.poll(async () => counter('closed'), { timeout: 60_000 }).toBe(1);
  await expect.poll(async () => magenta(frame), { timeout: 20_000 }).toBeGreaterThan(shut / 2);
  // The every-0.5 s timer ticked all along; the enter event came once (the player never left).
  const o = await observe();
  expect(o.counters?.['ticks'] ?? 0).toBeGreaterThanOrEqual(10);
  expect(o.counters?.['entered']).toBe(1);
  expect(o.counters?.['opened']).toBe(1);
  await page.getByTitle('Stop the play preview').click();
});
