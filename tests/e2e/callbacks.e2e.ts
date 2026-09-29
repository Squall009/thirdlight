/**
 * Phase 25.11: behavior callbacks against a real backend — the editor's side
 * and the callbacks running in Play.
 *
 * The starter template with a lamp box, a child box below it and a director
 * box. The director script (an object property naming the lamp) switches the
 * lamp off on the debug command "stage", and on the second one switches it
 * on and sends the message "hello" with the value 5.
 *
 * - Script editor: inside `export default { … }` the typings complete the
 *   callbacks (`onTri` → onTriggerEnter/onTriggerExit), and a callback's event
 *   parameter completes its fields (`m.` in `onMessage(_s, m, ctx)` → `from`).
 * - Graph editor: the node menu's search finds "On enable" (category
 *   Events); a visual script "On enable → Add to counter" is built there,
 *   published and put on the lamp.
 * - Play: a script with callbacks and no step (on the child box) counts its
 *   onEnable, onDisable and onMessage in the run's counters, the visual script
 *   counts its On enable: enabled at the start, the lamp switched off (the
 *   child too), switched on again (enabled again, the message received).
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

interface GNode { id: string; type: string; data?: Record<string, unknown> }
interface GEdge { from: { node: string; port: string }; to: { node: string; port: string } }

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-callbacks' }, args });
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

async function publishScript(behaviorId: string, displayName: string, text: string, declaration: unknown): Promise<void> {
  await cmd('publishBehavior', { behaviorId, displayName, mode: 'declaration-create', declaration });
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: [{ path: 'src/index.ts', text }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
}

const DIRECTOR = [
  'export default {',
  '  instantiate() { return { n: 0 }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const _ of ctx.debug.command('stage')) {",
  '      state.n += 1;',
  '      const lamp = ctx.entity(ctx.properties.lamp);',
  "      if (state.n === 1 && lamp.set('object', { active: false }).ok) ctx.game.add('off', 1);",
  '      if (state.n === 2) {',
  "        if (lamp.set('object', { active: true }).ok) ctx.game.add('on', 1);",
  "        ctx.messages.send('hello', 5);",
  '      }',
  '    }',
  '  },',
  '};',
  '',
].join('\n');

// Callbacks only: no step.
const WATCHER = [
  'export default {',
  "  onEnable(_s: any, ctx: any) { ctx.game.add('w_enable', 1); },",
  "  onDisable(_s: any, ctx: any) { ctx.game.add('w_disable', 1); },",
  '  onMessage(_s: any, m: any, ctx: any) {',
  "    if (m.name === 'hello' && m.from === ctx.properties.director) ctx.game.add('w_msg', Number(m.value));",
  '  },',
  '};',
  '',
].join('\n');

const node = (page: Page, id: string): Locator => page.locator(`[data-node-id="${id}"]`);
const port = (page: Page, id: string, side: 'in' | 'out', name: string): Locator => page.locator(`[data-node="${id}"][data-side="${side}"][data-port="${name}"]`);

async function openEditor(page: Page): Promise<void> {
  await page.goto(be!.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
}

test('callbacks: completion in the script editor, On enable in the node menu, lifecycle and message callbacks in Play', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('callbacks-e2e', 'starter');

  const lampId = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Lamp', transform: { position: [2, 3, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#ffffff' } } }))['createdId']);
  const childId = String((await cmd('createEntity', { parentId: lampId, kind: 'box', name: 'Lamp child', transform: { position: [0, -0.5, 0] }, box: { size: [0.2, 0.2, 0.2], material: { color: '#ffff00' } } }))['createdId']);
  const directorId = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Director', transform: { position: [0, -20, 0] }, box: { size: [0.2, 0.2, 0.2], material: { color: '#808080' } } }))['createdId']);
  await publishScript('director', 'Director', DIRECTOR, { properties: [{ key: 'lamp', label: 'Lamp', type: 'entityRef', default: null }] });
  await publishScript('watcher', 'Watcher', WATCHER, { properties: [{ key: 'director', label: 'Director', type: 'entityRef', default: null }] });
  await cmd('setBehaviorProperties', { entityId: directorId, behaviorId: 'director', values: { lamp: lampId } });
  await cmd('setBehaviorProperties', { entityId: childId, behaviorId: 'watcher', values: { director: directorId } });

  await openEditor(page);

  // Script editor: the callbacks complete inside export default, and the event parameter's fields.
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.locator('.tl-behaviors__list .tl-tile', { hasText: 'Watcher' }).dblclick();
  const script = page.getByRole('tabpanel', { name: 'Script: Watcher' });
  await expect(script.getByLabel('script editor')).toHaveAttribute('data-behavior', 'watcher');
  const completion = page.locator('.cm-tooltip-autocomplete');
  await script.locator('.cm-line', { hasText: 'onDisable' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('onTri');
  await expect(completion).toContainText('onTriggerEnter');
  await expect(completion).toContainText('onTriggerExit');
  await page.keyboard.press('Escape');
  await script.locator('.cm-line', { hasText: 'onMessage(' }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('m.');
  await expect(completion).toContainText('from');
  await expect(completion).toContainText('value');
  await page.keyboard.press('Escape');

  // Graph editor: "On enable" from the node menu, wired to Add to counter "vs_on"; published and put on the lamp.
  await openEditor(page);
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.getByLabel('New visual script name').fill('Lamp lit');
  await page.getByRole('button', { name: '+ Visual script' }).click();
  await expect(page.getByRole('tab', { name: 'Graph: Lamp lit' })).toHaveAttribute('aria-selected', 'true');
  const view = page.getByLabel('visual script', { exact: true });
  await expect(view).toHaveAttribute('data-behavior', 'lamp-lit');
  const stage = page.locator('.tl-graph__stage');
  const inspector = page.locator('.tl-dock--right');
  const nodes = async (): Promise<GNode[]> => (((await query('queryBehaviors', { includeDeclaration: true, behaviorId: 'lamp-lit' }))['behaviors'] as { graph?: { nodes: GNode[] } }[])[0]?.graph?.nodes ?? []);
  const edges = async (): Promise<GEdge[]> => (((await query('queryBehaviors', { includeDeclaration: true, behaviorId: 'lamp-lit' }))['behaviors'] as { graph?: { edges: GEdge[] } }[])[0]?.graph?.edges ?? []);
  const add = async (search: string, label: string, type: string, fx: number, fy: number, group?: string): Promise<string> => {
    const before = new Set((await nodes()).map((n) => n.id));
    const box = (await stage.boundingBox())!;
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy, { button: 'right' });
    const popup = page.getByRole('dialog', { name: 'Add node' });
    await popup.getByLabel('Search nodes').fill(search);
    if (group !== undefined) await expect(popup.getByRole('group', { name: group })).toContainText(label);
    await popup.getByRole('option', { name: label, exact: true }).click();
    await expect.poll(async () => (await nodes()).filter((n) => n.type === type && !before.has(n.id)).length, { timeout: 10_000 }).toBe(1);
    const id = (await nodes()).find((n) => n.type === type && !before.has(n.id))!.id;
    await expect(node(page, id)).toBeVisible();
    return id;
  };
  const enable = await add('enable', 'On enable', 'event.enable', 0.12, 0.6, 'Events');
  const count = await add('counter', 'Add to counter', 'api.game.add', 0.45, 0.6);
  const name = inspector.getByLabel('counter', { exact: true });
  await name.fill('vs_on');
  await name.press('Enter');
  await expect.poll(async () => (await nodes()).find((n) => n.id === count)?.data, { timeout: 10_000 }).toEqual({ name: 'vs_on' });
  await port(page, enable, 'out', 'then').focus();
  await page.keyboard.press('Enter');
  await port(page, count, 'in', 'in').focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await edges()).some((e) => e.from.node === enable && e.to.node === count), { timeout: 10_000 }).toBe(true);
  await expect(view.getByLabel('compile status')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
  await view.getByRole('button', { name: 'Publish', exact: true }).click();
  const trust = view.getByRole('group', { name: 'trust acknowledgment' });
  await expect(trust).toBeVisible();
  await trust.getByRole('button').click();
  await expect(view.getByLabel('publish result')).toContainText('Published', { timeout: 30_000 });
  await cmd('setBehaviorProperties', { entityId: lampId, behaviorId: 'lamp-lit', values: {} });

  // Play: enabled at the start; the lamp (and its child) switched off; on again with the message.
  await openEditor(page);
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number> };
  const counters = async (): Promise<Record<string, number>> => ((await api(`play/${psid}/observe`)).json as Obs).counters ?? {};
  await expect.poll(async () => ((await api(`play/${psid}/observe`)).json as Obs).state, { timeout: 60_000 }).toBe('running');
  await expect.poll(counters, { timeout: 30_000 }).toMatchObject({ w_enable: 1, vs_on: 1 });
  const debug = async (): Promise<void> => {
    const r = await api(`play/${psid}/control`, { command: 'debugCommand', name: 'stage' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  await debug();
  await expect.poll(counters, { timeout: 30_000 }).toMatchObject({ off: 1, w_disable: 1, w_enable: 1, vs_on: 1 });
  await debug();
  await expect.poll(counters, { timeout: 30_000 }).toMatchObject({ on: 1, w_enable: 2, w_msg: 5, vs_on: 2, w_disable: 1 });
  const diag = (await api(`play/${psid}/diagnostics`)).json as { diagnostics?: { runtime?: { errors?: unknown[] } } };
  expect(diag.diagnostics?.runtime?.errors ?? []).toEqual([]);
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
});
