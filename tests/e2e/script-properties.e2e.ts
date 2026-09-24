/**
 * Phase 15.4: script property visibility against a real backend (the engine
 * sample with neutral additions: a plain box carrying a probe script).
 *
 * - Behaviors tab: the declaration editor declares a public number ("speed",
 *   group "Movement", tooltip) and a private number ("secret") and creates
 *   the behavior with one command.
 * - Inspector: the box shows only the public property (in its group); an
 *   edit there overrides it for this object; the private one is refused by
 *   the backend when set per object.
 * - Play: the script reads the override (speed 5) and the private default
 *   (secret 7) — seen in its counters — and the Play debug view shows both
 *   values read-only for the selected box (as does the observe relay).
 */
import { createHash } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('script-props-e2e', 'beacon-reach');
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

async function send(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-script-props' },
    args,
  });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await send(op, args);
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** The probe: counts the values it reads once per run (speed and secret). */
const PROBE = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return {}; },',
  '  step(_state: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    if (ctx.game.counter('speed_read') === 0) ctx.game.add('speed_read', ctx.properties.speed);",
  "    if (ctx.game.counter('secret_read') === 0) ctx.game.add('secret_read', ctx.properties.secret);",
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

/** Stage, trust and publish the probe's source for a behavior with the given declaration. */
async function publishSource(behaviorId: string, declaration: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: [{ path: 'src/index.ts', text: PROBE }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: 'Probe', declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${createHash('sha256').update(behaviorId).digest('hex').slice(0, 32)}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
}

async function fill(page: Page, label: string, value: string): Promise<void> {
  const f = page.getByLabel(label, { exact: true });
  await f.fill(value);
  await expect(f).toHaveValue(value);
}

test('a public and a private script property: Inspector, per-object override and the Play debug view', async ({ page }) => {
  test.setTimeout(240_000);
  const made = await cmd('createEntity', { kind: 'box', name: 'Probe box', transform: { position: [6, 1, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#808080' } } });
  const boxId = String(made.createdId);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // Behaviors tab: declare a public and a private property with the declaration editor.
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.getByRole('button', { name: '+ New behavior' }).click();
  const editor = page.getByLabel('declaration editor');
  await fill(page, 'behavior id', 'probe');
  await fill(page, 'display name', 'Probe');
  await fill(page, 'property 1 key', 'speed');
  await fill(page, 'property 1 label', 'Speed');
  await fill(page, 'property 1 default', '3');
  await fill(page, 'property 1 min', '0');
  await fill(page, 'property 1 group', 'Movement');
  await fill(page, 'property 1 tooltip', 'Metres per second');
  await editor.getByRole('button', { name: '+ Add property' }).click();
  await fill(page, 'property 2 key', 'secret');
  await fill(page, 'property 2 label', 'Secret');
  await fill(page, 'property 2 default', '7');
  await page.getByLabel('property 2 visibility', { exact: true }).selectOption('private');
  await editor.getByRole('button', { name: 'Create behavior' }).click();
  const declared = async (): Promise<unknown> => {
    const r = await query('queryBehaviors', { includeDeclaration: true, limit: 50, offset: 0 });
    const b = (r['behaviors'] as { behaviorId: string; declaration?: unknown }[] | undefined)?.find((x) => x.behaviorId === 'probe');
    return b?.declaration;
  };
  const DECLARATION = {
    properties: [
      { key: 'speed', label: 'Speed', type: 'number', default: 3, min: 0, group: 'Movement', tooltip: 'Metres per second' },
      { key: 'secret', label: 'Secret', type: 'number', default: 7, visibility: 'private' },
    ],
  };
  await expect.poll(declared).toEqual(DECLARATION);

  // The script source (declared by the JSON declaration above) and the box carrying it.
  await publishSource('probe', DECLARATION);
  await cmd('setBehaviorProperties', { entityId: boxId, behaviorId: 'probe', values: {} });
  const stored = async (): Promise<unknown> => {
    const list = (await query('queryEntities', { limit: 200, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
    return list.find((e) => e.id === boxId)?.components['behavior'];
  };
  await expect.poll(stored).toEqual({ behaviorId: 'probe', values: { speed: 3 } });

  // Inspector: only the public property, in its group, with its tooltip.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${boxId}"]`).click();
  const inspector = page.locator('.tl-inspector');
  await expect(inspector.locator('[data-property="speed"]')).toHaveCount(1);
  await expect(inspector.locator('[data-property="secret"]')).toHaveCount(0);
  await expect(inspector.locator('details[data-group="Movement"] [data-property="speed"]')).toHaveAttribute('title', 'Metres per second');
  // Override it for this object.
  const speed = inspector.locator('[data-property="speed"] input');
  await speed.fill('5');
  await speed.press('Enter');
  await expect.poll(stored).toEqual({ behaviorId: 'probe', values: { speed: 5 } });
  // The private property is not settable per object.
  const refused = await send('setBehaviorProperties', { entityId: boxId, behaviorId: 'probe', values: { secret: 9 } });
  expect(refused.ok).toBe(false);
  expect(JSON.stringify(refused)).toContain('property_private');

  // Play: the script reads the override and the private default.
  const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number>; behaviors?: { entityId: string; scripts: { behaviorId: string; properties: { key: string; visibility: string; value: unknown }[] }[] } };
  const observe = async (body: Record<string, unknown> = {}): Promise<Obs> => (await api(`play/${psid}/observe`, body)).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('awaitingStart');
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(async () => (await observe()).counters?.['secret_read'], { timeout: 30_000 }).toBe(7);
  expect((await observe()).counters?.['speed_read']).toBe(5);

  // The Play debug view (the box is still selected): both values, read-only.
  const debug = page.getByLabel('play debug');
  await expect(debug.locator('[data-debug-value="speed"]')).toHaveText('5', { timeout: 15_000 });
  await expect(debug.locator('[data-debug-value="secret"]')).toHaveText('7');
  await expect(debug.locator('[data-debug-key="secret"]')).toHaveAttribute('data-visibility', 'private');
  await expect(debug.locator('input')).toHaveCount(0);
  // The same values through the observe relay (what tl_game_observe {entityId} returns).
  const o = await observe({ entityId: boxId });
  expect(o.behaviors?.entityId).toBe(boxId);
  expect(o.behaviors?.scripts[0]?.properties.map((p) => [p.key, p.visibility, p.value])).toEqual([
    ['speed', 'public', 5],
    ['secret', 'private', 7],
  ]);
  await page.getByTitle('Stop the play preview').click();
  await expect(debug).toHaveCount(0);
});

test('properties declared in the script source: the compiler derives the declaration and the Behaviors tab shows it read-only', async ({ page }) => {
  test.setTimeout(120_000);
  // A record to publish into (its placeholder declaration is replaced by the code's).
  await cmd('publishBehavior', { behaviorId: 'coded', displayName: 'Coded', mode: 'declaration-create', declaration: { properties: [{ key: 'placeholder', label: 'Placeholder', type: 'number', default: 0 }] } });
  const text = [
    'export const properties = {',
    "  speed: property.number(3, { min: 0, group: 'Movement' }),",
    '  secret: property.private.number(7),',
    '};',
    '',
    'export default { step() {} };',
    '',
  ].join('\n');
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: [{ path: 'src/index.ts', text }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  // No declaration sent: the code is the declaration.
  const published = await api('content/behaviors/source', { stageId, behaviorId: 'coded', displayName: 'Coded', expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${'d'.repeat(32)}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  expect(published.json['declaredInCode']).toBe(true);
  const record = ((await query('queryBehaviors', { includeDeclaration: true, behaviorId: 'coded' }))['behaviors'] as { declaration: unknown; source: { declaredInCode?: boolean } }[])[0]!;
  expect(record.declaration).toEqual({
    properties: [
      { key: 'speed', label: 'Speed', type: 'number', default: 3, min: 0, group: 'Movement' },
      { key: 'secret', label: 'Secret', type: 'number', default: 7, visibility: 'private' },
    ],
  });
  expect(record.source.declaredInCode).toBe(true);
  // A JSON declaration update cannot drift from the code.
  const update = await send('publishBehavior', { behaviorId: 'coded', displayName: 'Coded', mode: 'declaration-update', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 4 }] } });
  expect(JSON.stringify(update)).toContain('declared_in_code');

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.locator('.tl-behaviors__list li').filter({ hasText: 'Coded' }).click();
  const editor = page.getByLabel('declaration editor');
  await expect(editor.locator('[data-declared-in-code="true"]')).toBeVisible();
  await expect(page.getByLabel('property 2 visibility', { exact: true })).toHaveValue('private');
  await expect(page.getByLabel('property 2 visibility', { exact: true })).toBeDisabled();
  await expect(editor.getByRole('button', { name: 'Save declaration' })).toHaveCount(0);
});
