/**
 * The generic primitives added through the editor and observed
 * in Play, on the starter template (a 2D-plane scene without any game
 * session), against a real backend:
 *
 * - Editor: "+ Add component" → Collectible on a marker at the character's
 *   start, its respawn time set in the Inspector; → Patrol (edge to edge) and
 *   → Hitbox (box) on a block, its start direction and damage set in the
 *   Inspector; → Health on the character. Each stored value is read back
 *   through the command API.
 * - Play: the collectible's counter rises (collected, back half a second
 *   later, collected again: the character stands on it); the patroller walks
 *   left, turns at the crate (a wall), walks back into the character: the
 *   contact takes 1 health (3 → 2). A project script on the character turns
 *   the events it owns (its health, its contacts, the patroller named in an
 *   object property) into counters, which the play observation relay
 *   reports — the game's own reading of the events, not engine rules.
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { STARTER, startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('primitives-e2e', 'starter');
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
    requestId: `req-${randomBytes(16).toString('hex')}`,
    origin: { kind: 'mcp', clientId: 'e2e-primitives' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

async function create(name: string, position: number[], extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> {
  return String((await cmd('createEntity', { parentId: null, kind, name, transform: { position }, ...extra }))['createdId']);
}

async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await query('queryEntity', { entityId: id });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
}

/** Publish a behavior with entityRef properties and attach it to `entityId` with `values`. */
async function script(behaviorId: string, source: string, entityId: string, props: string[], values: Record<string, unknown>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: props.map((key) => ({ key, label: key, type: 'entityRef', default: null })) };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values });
}

/**
 * The game's reading of the events: turns at a wall, contacts from the left
 * (the normal points from the character toward the other side), and the
 * character's health mirrored into a counter.
 */
const WATCH = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return {}; },',
  '  step(_state: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    for (const e of ctx.events) {',
  "      if (e.type === 'turned' && e.reason === 'wall') ctx.game.add('wallTurns', 1);",
  "      if (e.type === 'contact' && e.entity === ctx.entityId && e.other === ctx.properties.walker && e.normal[0] < 0) ctx.game.add('hitFromLeft', 1);",
  "      if (e.type === 'damaged' && e.entity === ctx.entityId) ctx.game.add('damage', e.amount);",
  '    }',
  '    const hp = ctx.health.get(ctx.entityId);',
  "    if (hp !== null) ctx.game.add('hp', hp.current - ctx.game.counter('hp'));",
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
}

async function field(page: Page, label: string, value: string): Promise<void> {
  const f = page.locator('.tl-inspector').getByLabel(label, { exact: true });
  await f.fill(value);
  await f.press('Enter');
}

test('collectible, patrol, hitbox and health from "+ Add component"; in Play a counter rises, the patroller turns at a wall and its contact takes health', async ({ page }) => {
  test.setTimeout(240_000);
  // A marker on the character's start (x = 3), and a block left of it, 2 m short of the crate (x = -2).
  const token = await create('Token', [3, 0.9, 0], { box: { size: [0.4, 0.4, 0.1], material: { color: '#44aaff' } } }, 'box');
  const walker = await create('Walker', [0.5, 0.5, 0], { box: { size: [1, 1, 1], material: { color: '#cc4444' } } }, 'box');
  await script('watch', WATCH, STARTER.playerId, ['walker'], { walker });

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const inspector = page.locator('.tl-inspector');
  const add = inspector.getByLabel('add component', { exact: true });

  // Collectible: the neutral add value, then a respawn time.
  await select(page, token);
  await add.selectOption({ label: 'Collectible' });
  await expect.poll(async () => comp(token, 'collectible')).toEqual({ counter: 'items' });
  await expect(inspector.getByLabel('collectible component')).toBeVisible();
  await field(page, 'collectible respawn', '0.5');
  await expect.poll(async () => comp(token, 'collectible')).toEqual({ counter: 'items', respawn: 0.5 });

  // Patrol (edge to edge) walking left, and a damaging hitbox.
  await select(page, walker);
  await add.selectOption({ label: 'Patrol: Edge to edge' });
  await expect.poll(async () => comp(walker, 'patrol')).toEqual({ mode: 'edges', speed: 1.5 });
  await field(page, 'patrol direction x', '-1');
  await expect.poll(async () => (await comp(walker, 'patrol'))?.['direction']).toEqual([-1, 0, 0]);
  await add.selectOption({ label: 'Hitbox: Box' });
  await expect.poll(async () => comp(walker, 'hitbox')).toEqual({ size: [1, 1] });
  await field(page, 'hitbox damage', '1');
  await expect.poll(async () => (await comp(walker, 'hitbox'))?.['damage']).toBe(1);
  // A collider cannot join a patroller (it moves itself): offered, but disabled with the reason.
  await expect(add.locator('option', { hasText: /^Collider/ }).first()).toBeDisabled();

  // Health on the character.
  await select(page, STARTER.playerId);
  await add.selectOption({ label: 'Health' });
  await expect.poll(async () => comp(STARTER.playerId, 'health')).toEqual({ max: 3 });

  // Play (a scene: no game session). Nothing is sent as input.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number>; hidden?: string[] };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 15_000 }).toBe('running');
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  const counter = async (name: string): Promise<number> => (await observe()).counters?.[name] ?? 0;
  // The character stands on the collectible: collected, back after 0.5 s, collected again.
  await expect.poll(() => counter('items'), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  const first = await counter('items');
  await expect.poll(() => counter('items'), { timeout: 10_000 }).toBeGreaterThan(first);
  // Full health mirrored by the script, then the patroller turns at the crate and walks into the character from the left.
  await expect.poll(() => counter('hp'), { timeout: 10_000 }).toBe(3);
  await expect.poll(() => counter('wallTurns'), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await expect.poll(() => counter('hitFromLeft'), { timeout: 15_000 }).toBe(1);
  await expect.poll(() => counter('hp'), { timeout: 10_000 }).toBe(2);
  expect(await counter('damage')).toBe(1);
  // Nothing else happened to the character (no engine rule on health): the scene plays on.
  expect((await observe()).state).toBe('running');
});
