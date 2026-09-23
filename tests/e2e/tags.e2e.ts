/**
 * Phase 12 (b) in a real browser against the real backend: the project tag
 * registry in project settings (add, rename keeps the bit, a used tag cannot
 * be removed), tags on objects in the inspector with folder tags shown as
 * inherited, and a real script that queries objects by tag in Play.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { menu } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

const status = (page: Page) => page.locator('.tl-statusbar');
const row = (page: Page, name: string) => page.locator('.tl-hierarchy__list li').filter({ has: page.locator('.tl-row__name', { hasText: new RegExp(`^${name}$`) }) });

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function revision(): Promise<number> {
  return Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} })).revision);
}

/** One command through the route the MCP adapter uses. */
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: await revision(),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-tags' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

test('tags in project settings and the inspector: add, rename keeps the bit, folder tags inherited, used tags stay', async ({ page }) => {
  be = await startBackend();
  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');

  await menu(page, 'File', 'Project tags');
  const panel = page.getByLabel('project tags');
  for (const name of ['enemy', 'pickup']) {
    await panel.getByLabel('new tag name').fill(name);
    await panel.getByRole('button', { name: 'add tag' }).click();
    await expect(panel.locator(`[data-tag="${name}"]`)).toHaveCount(1);
  }
  // Rename keeps the bit.
  await panel.locator('[data-tag="enemy"]').getByTitle('rename').click();
  await panel.getByLabel('rename tag enemy').fill('foe');
  await panel.getByLabel('rename tag enemy').press('Enter');
  await expect(panel.locator('[data-tag="foe"] .tl-tags__bit')).toHaveText('#0');
  await expect(panel.locator('[data-tag="pickup"] .tl-tags__bit')).toHaveText('#1');

  // A folder tagged "foe" with a box inside.
  const folderId = String((await cmd('createEntity', { kind: 'folder', name: 'Enemies' })).createdId);
  const boxId = String((await cmd('createEntity', { kind: 'box', name: 'grunt', parentId: folderId })).createdId);
  await row(page, 'Enemies').click();
  const foe = page.getByRole('checkbox', { name: 'tag foe' });
  await expect(foe).not.toBeChecked();
  await foe.click();
  await expect(foe).toBeChecked();
  await expect.poll(async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: folderId } })).entity as { tags?: number }).tags).toBe(1);
  // The box shows the folder's tag as inherited (its own box stays unchecked).
  await row(page, 'grunt').click();
  await expect(page.getByRole('checkbox', { name: 'tag foe' })).not.toBeChecked();
  await expect(page.locator('[data-inherited-tag="foe"]')).toHaveText('inherited from a folder');
  const q = await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: boxId } });
  expect(q.tagNames).toEqual({ own: [], effective: ['foe'] });
  await page.screenshot({ path: 'test-results/tags-inspector.png' });

  // A tag in use cannot be removed; an unused one can.
  await expect(panel.locator('[data-tag="foe"] .tl-tags__used')).toHaveText('on 1 object');
  await expect(panel.getByRole('button', { name: 'remove tag foe' })).toBeDisabled();
  await panel.getByRole('button', { name: 'remove tag pickup' }).click();
  await expect(panel.locator('[data-tag="pickup"]')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/tags-panel.png' });
  // Undo brings pickup back on bit 1.
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+z');
  await expect(panel.locator('[data-tag="pickup"] .tl-tags__bit')).toHaveText('#1');
});

test('a script queries objects by tag in Play: folder tags count, inactive objects do not', async ({ page }) => {
  be = await startBackend('tags-e2e', 'beacon-reach');
  const REPO_BOX = { size: [0.3, 0.3, 0.3], material: { color: '#ff00ff' } };
  await cmd('setTags', { tags: [{ name: 'hazard' }, { name: 'pickup' }] });
  const hazards = String((await cmd('createEntity', { kind: 'folder', name: 'Hazards' })).createdId);
  await cmd('updateEntity', { entityId: hazards, tags: ['hazard'] });
  const spike = String((await cmd('createEntity', { kind: 'box', name: 'spike', parentId: hazards, transform: { position: [0, -20, -6] }, box: REPO_BOX })).createdId);
  const lava = String((await cmd('createEntity', { kind: 'box', name: 'lava', transform: { position: [1, -20, -6] }, box: REPO_BOX })).createdId);
  await cmd('updateEntity', { entityId: lava, tags: ['hazard', 'pickup'] });
  const off = String((await cmd('createEntity', { kind: 'folder', name: 'Off' })).createdId);
  const buried = String((await cmd('createEntity', { kind: 'box', name: 'buried', parentId: off, transform: { position: [2, -20, -6] }, box: REPO_BOX })).createdId);
  await cmd('updateEntity', { entityId: buried, tags: ['hazard'] });
  await cmd('updateEntity', { entityId: off, active: false });

  // The script steers the player right only if ctx.tags.query finds exactly
  // the active hazards (spike through its folder, lava by its own tag).
  const expected = JSON.stringify([spike, lava]);
  const source = [
    'export default {',
    '  prepare() { return {}; },',
    '  instantiate(_p: unknown, inst: { tags: { mask(...n: string[]): number; query(m: number): readonly string[] } }) {',
    `    return { ok: JSON.stringify(inst.tags.query(inst.tags.mask('hazard'))) === ${JSON.stringify(expected)} };`,
    '  },',
    '  step(state: { ok: boolean }, ctx: { tags: { query(m: number): readonly string[]; mask(...n: string[]): number }; emit(i: unknown): void }) {',
    `    const again = JSON.stringify(ctx.tags.query(ctx.tags.mask('HAZARD'))) === ${JSON.stringify(expected)};`,
    "    ctx.emit({ kind: 'control_move', value: state.ok && again ? 1 : -1 });",
    '  },',
    '  dispose() {},',
    '};',
    '',
  ].join('\n');
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1, min: 0, max: 10, step: 1 }] };
  await cmd('publishBehavior', { behaviorId: 'behavior-tags', displayName: 'Tag seeker', mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', {
    stageId,
    behaviorId: 'behavior-tags',
    displayName: 'Tag seeker',
    declaration,
    expectedRevision: await revision(),
    requestId: `req-${'d'.repeat(32)}`,
  });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  const game = await be.command({ op: 'queryGameConfig', projectId: be.projectId, args: {} });
  expect(game.tags).toEqual([{ bit: 0, name: 'hazard' }, { bit: 1, name: 'pickup' }]);
  const playerId = String((game.game as { playerId: string }).playerId);
  await cmd('setBehaviorProperties', { entityId: playerId, behaviorId: 'behavior-tags', values: { speed: 1 } });

  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<{ state?: string; player?: { x: number } }> => (await api(`play/${psid}/observe`, {})).json as never;
  await expect.poll(async () => (await observe()).state, { timeout: 15_000 }).toBe('awaitingStart');
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  // Spawn is x = 3: right means the query found exactly [spike, lava].
  await expect.poll(async () => (await observe()).player!.x, { timeout: 5_000 }).toBeGreaterThan(4.5);
});
