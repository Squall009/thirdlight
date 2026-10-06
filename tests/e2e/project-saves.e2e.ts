/**
 * Project-defined save documents against a real backend,
 * on a neutral fixture built by commands on a blank project.
 *
 * - Editor: the Saves bottom tab adds a save schema, sets 5 slots, opts into
 *   the block-cell and script-storage sections and adds a settings field
 *   ("hints", default on) — one `setSaveSchema` per Apply.
 * - Play (first session): with no slot 2 yet, the script changes a cell of
 *   the block layer, keeps a value (ctx.save), writes its document, turns the
 *   "hints" setting off and saves to slot 2 with a title, chapter, location
 *   and a thumbnail; a second later it changes the cell and the value again.
 *   tl_game_observe lists slot 2 with its metadata and picture facts; the
 *   picture is a real JPEG of the view.
 * - Play again (a reload of the game page): the slot list comes back from
 *   the browser's storage (IndexedDB) with the metadata and the picture; the
 *   script loads slot 2 and checks the restored state — the cell, the value,
 *   the document and the settings document (kept across the reload) — and
 *   writes what it found into slot 3's title, which the test reads.
 * - The static export (backend stopped): the same two sessions by reloading
 *   the page.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Frame, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { onlyInItsProject } from './renderer-variants';
import { openProjectSettings } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-project-saves' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** Publish a behavior with one entityRef property (the block layer) and attach it. */
async function script(behaviorId: string, source: string, entityId: string, layer: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [{ key: 'layer', label: 'layer', type: 'entityRef', default: null }] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: { layer } });
}

/**
 * First session (no slot 2): change a cell, keep a value, write the document, turn "hints" off, save to
 * slot 2 (with a picture); a second later change the cell and the value again (the counter `changed` says
 * so). A later session (slot 2 listed): load it, then write what the restored state holds into slot 3's title.
 */
const SAVER = [
  'export default {',
  "  instantiate() { return { phase: 'wait', at: 0, checked: false }; },",
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent' || ctx.saves === undefined) return;",
  '    const s = ctx.saves;',
  '    const L = ctx.properties.layer;',
  "    for (const r of s.results()) if (r.op === 'load' && r.ok) state.phase = 'loaded';",
  '    if (!s.ready()) return;',
  "    if (state.phase === 'wait') {",
  '      if (s.slots().some((x: any) => x.slot === 2)) {',
  '        s.load(2);',
  "        state.phase = 'loading';",
  '      } else {',
  "        state.phase = 'first';",
  '        state.at = ctx.stepIndex;',
  "        ctx.grid.set(L, 1, 1, 1, { block: 'wood' });",
  "        ctx.save.set('coins', 7);",
  "        s.write({ chapter: 2, flags: ['door'] });",
  "        s.setSetting('hints', false);",
  "        s.save(2, { title: 'Before the bridge', chapter: 'Two', location: 'Mill', thumbnail: true });",
  '      }',
  '      return;',
  '    }',
  "    if (state.phase === 'first' && ctx.stepIndex === state.at + 120) {",
  "      ctx.grid.set(L, 1, 1, 1, { block: 'stone' });",
  "      ctx.save.set('coins', 99);",
  '      s.write({ chapter: 3 });',
  "      ctx.game.add('changed', 1);",
  "      state.phase = 'changed';",
  '    }',
  "    if (state.phase === 'loaded' && !state.checked) {",
  '      state.checked = true;',
  '      const cell = ctx.grid.get(L, 1, 1, 1);',
  "      const title = 'check ' + (cell ? cell.block : 'none') + ' coins=' + ctx.save.get('coins') + ' hints=' + s.setting('hints') + ' doc=' + JSON.stringify(s.read());",
  '      s.save(3, { title: title.slice(0, 128) });',
  '    }',
  '  },',
  '};',
].join('\n');

const EXPECTED_CHECK = 'check wood coins=7 hints=false doc={"chapter":2,"flags":["door"]}';

interface SlotObs { slot: number; title: string; chapter: string; location: string; playSeconds: number; savedAt: string; version: number; bytes: number; thumbnail?: { type: string; width: number; height: number; bytes: number } }
interface SavesObs { slotCount: number; storage: string; slots: SlotObs[]; settings: Record<string, unknown> }

function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/** A slot's picture as the page decodes it: its type and pixel size (a real image, not just bytes). */
async function thumbnailOf(target: Page | Frame, slot: number): Promise<{ type: string; width: number; height: number; bytes: number } | null> {
  return target.evaluate(async (n) => {
    const get = (window as unknown as { __thirdlightSaveThumbnail?: (slot: number) => Promise<string | null> }).__thirdlightSaveThumbnail;
    const url = get === undefined ? null : await get(n);
    if (url === null) return null;
    const img = new Image();
    img.src = url;
    await img.decode();
    return { type: url.slice(5, url.indexOf(';')), width: img.naturalWidth, height: img.naturalHeight, bytes: url.length };
  }, slot);
}

function expectSlot2(saves: SavesObs | undefined): void {
  expect(saves?.slotCount).toBe(5);
  const s2 = saves!.slots.find((x) => x.slot === 2)!;
  expect(s2).toMatchObject({ slot: 2, title: 'Before the bridge', chapter: 'Two', location: 'Mill', version: 1 });
  expect(s2.playSeconds).toBeGreaterThan(0);
  expect(Date.parse(s2.savedAt)).toBeGreaterThan(Date.parse('2026-01-01'));
  expect(s2.thumbnail).toMatchObject({ type: 'image/jpeg', width: 256, height: 144 });
  expect(s2.thumbnail!.bytes).toBeLessThanOrEqual(65_536);
}

test('a script saves to slot 2 with metadata and a thumbnail; a reload lists it and loading restores a cell, a value and the settings document (Play and export)', async ({ page }) => {
  onlyInItsProject('webgl2');
  test.setTimeout(360_000);
  be = await startBackend('project-saves-e2e');

  // The fixture: a 3D project (it plays as a scene) with a block layer of stone and wood, the camera looking at it.
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('setBlockType', { block: { blockId: 'stone', name: 'Stone', variants: [{ color: '#6b7280' }], shape: 'full' } });
  await cmd('setBlockType', { block: { blockId: 'wood', name: 'Wood', variants: [{ color: '#a0602a' }], shape: 'full' } });
  const cam = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  const pitch = (-30 * Math.PI) / 180;
  await cmd('setTransform', { entityId: cam, transform: { position: [2, 5, 9], rotation: [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)] } });
  const layer = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Ground', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [4, 3, 4] } } });
  await cmd('editBlocks', { entityId: layer, edits: [{ kind: 'fill', box: [0, 0, 0, 4, 1, 4], cell: { block: 'stone' } }] });
  const saver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Saver', transform: { position: [0, 0, 0] } }))['createdId']);
  await script('saver', SAVER, saver, layer);

  // Editor: the Saves tab — add a schema, 5 slots, the cell and storage sections, a "hints" setting (default on).
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await openProjectSettings(page, 'Saves');
  const panel = page.getByLabel('project saves');
  await panel.getByRole('button', { name: 'add save schema' }).click();
  const schemaNow = async (): Promise<unknown> => (await query('queryGameConfig'))['saveSchema'];
  await expect.poll(schemaNow).toEqual({ version: 1, slots: 3, legacyWorld: false });
  await panel.getByLabel('save slots').fill('5');
  await panel.getByLabel('save section grid').check();
  await panel.getByLabel('save section storage').check();
  await panel.getByRole('button', { name: 'add setting' }).click();
  await panel.getByLabel('setting 0 key').fill('hints');
  await panel.getByLabel('setting 0 default').check();
  await panel.getByRole('button', { name: 'apply save schema' }).click();
  await expect.poll(schemaNow).toEqual({ version: 1, slots: 5, sections: ['grid', 'storage'], legacyWorld: false, settings: [{ key: 'hints', type: 'bool', default: true }] });

  // Play, first session: the script saves to slot 2; tl_game_observe lists it with its metadata and picture.
  const startPlay = async (): Promise<{ psid: string; frame: Frame }> => {
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    await expect.poll(async () => (await api(`play/${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
    const frame = (await (await page.locator('iframe.tl-app__preview-frame').elementHandle())!.contentFrame())!;
    return { psid, frame };
  };
  const savesOf = async (psid: string): Promise<SavesObs | undefined> => ((await api(`play/${psid}/observe`, {})).json as { saves?: SavesObs }).saves;
  const first = await startPlay();
  await expect.poll(async () => (await savesOf(first.psid))?.slots.some((s) => s.slot === 2) ?? false, { timeout: 60_000, message: 'slot 2 saved in Play' }).toBe(true);
  expectSlot2(await savesOf(first.psid));
  expect((await savesOf(first.psid))!.storage).toBe('indexeddb');
  expect((await savesOf(first.psid))!.settings).toEqual({ hints: false });
  expect(await thumbnailOf(first.frame, 2)).toMatchObject({ type: 'image/jpeg', width: 256, height: 144 });
  // Past the second change (120 steps later).
  await expect.poll(async () => ((await api(`play/${first.psid}/observe`, {})).json as { counters?: Record<string, number> }).counters?.['changed'], { timeout: 30_000 }).toBe(1);
  await page.getByTitle('Stop the play preview').click();

  // Play again (the game page loads anew): slot 2 listed from storage with its picture; the load restores the state.
  const second = await startPlay();
  await expect.poll(async () => (await savesOf(second.psid))?.slots.find((s) => s.slot === 3)?.title, { timeout: 60_000, message: 'slot 3 written after the load in Play' }).toBe(EXPECTED_CHECK);
  expectSlot2(await savesOf(second.psid));
  expect((await savesOf(second.psid))!.settings).toEqual({ hints: false });
  expect(await thumbnailOf(second.frame, 2)).toMatchObject({ type: 'image/jpeg', width: 256, height: 144 });
  await page.getByTitle('Stop the play preview').click();

  // The static export, served with the backend stopped: the same two sessions (a reload of the page).
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  const observe = async (): Promise<SavesObs | undefined> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => { saves?: unknown } | null }).__thirdlightObserve?.()?.saves ?? undefined) as SavesObs | undefined);
  try {
    await game.goto(site.url);
    await expect.poll(async () => (await observe())?.slots.some((s) => s.slot === 2) ?? false, { timeout: 60_000, message: 'slot 2 saved in the export' }).toBe(true);
    expectSlot2(await observe());
    expect(await thumbnailOf(game, 2)).toMatchObject({ type: 'image/jpeg', width: 256, height: 144 });
    await expect.poll(async () => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => { counters?: Record<string, number> } | null }).__thirdlightObserve?.()?.counters?.['changed'] ?? null)), { timeout: 30_000 }).toBe(1);
    await game.reload();
    await expect.poll(async () => (await observe())?.slots.find((s) => s.slot === 3)?.title, { timeout: 60_000, message: 'slot 3 written after the load in the export' }).toBe(EXPECTED_CHECK);
    expectSlot2(await observe());
    expect((await observe())!.settings).toEqual({ hints: false });
    expect(await thumbnailOf(game, 2)).toMatchObject({ type: 'image/jpeg', width: 256, height: 144 });
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
