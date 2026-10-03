/**
 * Saves against a real backend, in Play, on a neutral 3D scene built by
 * commands on a blank project (a floor and a character; a save schema of
 * three slots).
 *
 * - `character_place` with a facing turns the character (read back through
 *   `ctx.physics.characterState().facing`); a save keeps the facing in its
 *   `world.character`, and loading it turns the character back after a
 *   script turned it elsewhere.
 * - A slot's own `meta` fields (`ctx.saves.save(slot, {meta})`) come back
 *   from `ctx.saves.slots()` and are kept in the browser's storage: twenty
 *   short fields fit; a record over the byte budget (counted in UTF-8) is
 *   refused.
 * - A UI image widget with `saveSlot` shows that slot's picture: its
 *   background is the stored thumbnail, drawn on screen.
 * - Editor: the image widget's Save slot field is edited in the UI document
 *   editor (one setUiDocument).
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { openEditor } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-save-slots' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
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

async function script(behaviorId: string, text: string, entityId: string): Promise<void> {
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
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
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

/**
 * Places the character facing 90°, saves slot 1 (meta, picture), shows the
 * slots document, turns the character to −45°, loads slot 1; counts what it
 * read at each stage (facing in whole degrees).
 */
const DIRECTOR = [
  'export default {',
  '  instantiate() { return { phase: 0, at: 0 }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const s = ctx.saves;',
  '    const st = ctx.physics.characterState();',
  '    if (st === undefined) return;',
  '    if (state.phase === 0 && ctx.stepIndex > 60) {',
  "      ctx.emit({ kind: 'character_place', position: [0, 1.2, 0], facing: 90 });",
  '      state.phase = 1; state.at = ctx.stepIndex;',
  '    } else if (state.phase === 1 && ctx.stepIndex > state.at + 30 && s.ready()) {',
  "      ctx.game.add('facing_placed', Math.round(st.facing));",
  "      const meta: any = { leader: 'odessa', chapter_no: '3' };",
  "      for (let i = 0; i < 18; i += 1) meta['extra_' + i] = 'v' + i;",
  "      if (!s.save(2, { meta: { motto: '\\u20ac'.repeat(1400) } })) ctx.game.add('meta_over_refused', 1);",
  "      s.save(1, { title: 'Mill', meta, thumbnail: true });",
  '      state.phase = 2;',
  '    } else if (state.phase === 2) {',
  "      for (const r of s.results()) if (r.op === 'save' && r.ok) { state.phase = 3; state.at = ctx.stepIndex; ctx.game.add('saved', 1); }",
  '    } else if (state.phase === 3 && ctx.stepIndex > state.at + 10) {',
  '      const slot = s.slots().find((x: any) => x.slot === 1);',
  "      if (slot !== undefined && slot.meta.leader === 'odessa' && slot.meta.chapter_no === '3' && slot.meta.extra_17 === 'v17' && Object.keys(slot.meta).length === 20 && slot.title === 'Mill') ctx.game.add('meta_ok', 1);",
  "      ctx.ui.show('slots');",
  "      ctx.emit({ kind: 'character_place', position: [1, 1.2, 0], facing: -45 });",
  '      state.phase = 4; state.at = ctx.stepIndex;',
  '    } else if (state.phase === 4 && ctx.stepIndex > state.at + 30) {',
  "      ctx.game.add('facing_moved', Math.round(st.facing));",
  '      s.load(1);',
  '      state.phase = 5;',
  '    } else if (state.phase === 5) {',
  "      for (const r of s.results()) if (r.op === 'load' && r.ok) { state.phase = 6; state.at = ctx.stepIndex; }",
  '    } else if (state.phase === 6 && ctx.stepIndex > state.at + 30) {',
  "      ctx.game.add('facing_loaded', Math.round(st.facing));",
  "      ctx.game.add('x_loaded', Math.round(st.position.x * 10));",
  '      state.phase = 7;',
  '    }',
  '  },',
  '};',
  '',
].join('\n');

async function buildScene(): Promise<void> {
  await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Floor', transform: { position: [0, -0.5, 0] }, box: { size: [20, 1, 20], material: { color: '#6f7f8f' } }, components: { collider: { shape: { type: 'box', hx: 10, hy: 0.5, hz: 10 } } } });
  const player = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name: 'Player', transform: { position: [0, 1, 0] }, box: { size: [0.6, 1.8, 0.6], material: { color: '#cc8844' } } })).createdId);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  const shot = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Shot', transform: { position: [0, 3, 8] } })).createdId);
  await cmd('setComponent', { entityId: shot, component: 'virtualCamera', value: { rig: 'fixed', target: player } });
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('setSaveSchema', { schema: { version: 1, slots: 3 } });
  await cmd('setUiDocument', { document: { uiDocumentId: 'slots', name: 'Slots', root: { type: 'panel', stretch: 'both', children: [{ type: 'image', id: 'pic', anchor: [0, 0], offset: [24, 24], size: [256, 144], saveSlot: 1 }] } } });
  const director = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Director', transform: { position: [0, -10, 0] } })).createdId);
  await script('director', DIRECTOR, director);
}

test('character_place faces; a save keeps the facing and the slot meta; a UI image shows the slot picture', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('save-slots-e2e');
  await buildScene();
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number> };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`)).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  await expect.poll(async () => (await observe()).counters?.['facing_loaded'] ?? null, { timeout: 60_000, message: 'the script reached the end' }).not.toBeNull();
  const c = (await observe()).counters!;
  expect(c).toMatchObject({ facing_placed: 90, saved: 1, meta_ok: 1, meta_over_refused: 1, facing_moved: -45, facing_loaded: 90, x_loaded: 0 });

  // The slot's picture is the image widget's background, drawn on screen.
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  const pic = frame.locator('[data-widget="pic"]');
  await expect(pic).toBeVisible();
  await expect.poll(async () => pic.evaluate((el) => getComputedStyle(el).backgroundImage), { timeout: 30_000 }).toContain('data:image/');
  const shown = await pic.evaluate((el) => getComputedStyle(el).backgroundImage);
  const stored = await page.locator('iframe.tl-app__preview-frame').contentFrame().locator('body').evaluate(() => (window as unknown as { __thirdlightSaveThumbnail?: (slot: number) => Promise<string | null> }).__thirdlightSaveThumbnail?.(1) ?? null);
  expect(stored).not.toBeNull();
  expect(shown).toBe(`url("${stored!}")`);
  // Not a blank box: the picture of the view has the floor and the sky/background in it.
  const img = decodePng(await pic.screenshot());
  const seen = new Set<string>();
  for (let y = 4; y < img.height - 4; y += 6) for (let x = 4; x < img.width - 4; x += 6) {
    const [r, g, b] = img.pixel(x, y);
    seen.add(`${r >> 5},${g >> 5},${b >> 5}`);
  }
  expect(seen.size, 'the picture has more than one colour').toBeGreaterThan(2);
  await page.screenshot({ path: 'test-results/save-slots-play.png' });
  await page.getByTitle('Stop the play preview').click();

  // Editor: the image widget's Save slot field.
  await openEditor(page, 'UI', 'Slots');
  const editor = page.locator('[data-ui-document="slots"]');
  await expect(editor).toBeVisible();
  await page.locator('.tl-uidoc__node[data-path="r.0"]').click();
  const field = editor.getByLabel('widget saveSlot', { exact: true });
  await expect(field).toHaveValue('1');
  await field.click();
  await field.fill('2');
  await field.press('Enter');
  await expect.poll(async () => (((await query('queryGameConfig'))['uiDocuments'] as { uiDocumentId: string; root: { children: { saveSlot?: unknown }[] } }[]).find((d) => d.uiDocumentId === 'slots')?.root.children[0]?.saveSlot)).toBe(2);
});
