/**
 * One project with the optional manifest keys that
 * travel together (modes, timelines, event cues, the shell, dialogue, a save
 * schema, tags, collision layers, input and UI documents), built by the real
 * backend, verified by the pages that load it, played and exported:
 *
 * - Play: the preview re-derives the manifest's buildId (MANIFEST_KEYS_V2
 *   order) before anything loads; the manifest it read carries every one of
 *   those keys, in that order. In the running game the mode is current, the
 *   shell's HUD and the mode's document are shown, the start timeline's
 *   letterbox holds and the metronome's signal plays its event sound.
 * - Export: the same with the backend stopped, from a plain static server
 *   (the exported page re-derives the buildId the same way).
 *
 * Manifest version 4: the materials (only the used ones), the
 * UI documents, the dialogue data and the instance buffer table are content
 * files listed in `contentFiles`, not manifest keys. Play reads them from the
 * play's cache root and the export from its own tree (the files are there,
 * the exported page fetches them, the unused material is in neither).
 *
 * The every-key-at-once check of the pure builder (all optional keys, the
 * strict reader) is `packages/project-model/src/manifest-v2.test.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type FrameLocator, type Page } from '@playwright/test';

import { MANIFEST_KEYS_V2 } from '@thirdlight/project-model';

import { publishWav, startBackend, STARTER, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('manifest-keys-e2e', 'starter');
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
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-manifest-keys' }, args });
  expect(res.ok, `${op}: ${JSON.stringify(res)}`).toBe(true);
  return res;
}
async function script(behaviorId: string, source: string, entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stageId = String((await api('content/stages', {})).json.stageId);
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

/** The signal "tick" twice a second. */
const METRONOME = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return {}; },',
  '  step(_state: unknown, ctx: any) {',
  "    if (ctx.phase === 'intent' && ctx.stepIndex > 0 && ctx.stepIndex % 60 === 0) ctx.signals.emit('tick');",
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

/** The keys this project authors (beyond the ones every manifest has). */
const AUTHORED = ['tags', 'input', 'collisionLayers', 'saveSchema', 'modes', 'timelines', 'eventCues', 'shell', 'contentFiles'] as const;
/** The content files this project has, in their order. */
const CONTENT_FILES = ['materials', 'uiDocuments', 'dialogue', 'buffers'] as const;
/** The instance set's buffer (published in buildProject). */
let bufferDigest = '';

async function buildProject(): Promise<void> {
  await cmd('setTags', { tags: [{ name: 'marker' }] });
  await cmd('setCollisionLayers', { layers: ['world', 'props'] });
  await cmd('setSaveSchema', { schema: { version: 1, slots: 2 } });
  await cmd('setInput', { input: { actions: [{ name: 'use', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyE' }] }] } });
  await cmd('setUiDocument', { document: { uiDocumentId: 'hud', name: 'HUD', root: { type: 'text', id: 'line', anchor: [0, 0], offset: [12, 12], text: 'Shell HUD', css: { color: '#ffffff' } } } });
  await cmd('setUiDocument', { document: { uiDocumentId: 'panel', name: 'Panel', root: { type: 'text', id: 'line', anchor: [1, 0], pivot: [1, 0], offset: [-12, 12], text: 'Mode panel', css: { color: '#ffffff' } } } });
  await cmd('setModes', { modes: [{ modeId: 'main', name: 'Main', inputMaps: ['gameplay', 'ui'], ui: ['panel'] }] });
  await cmd('setTimeline', { timeline: { timelineId: 'intro', name: 'Intro', duration: 1, playOnStart: true, tracks: [{ trackId: 'bars', type: 'letterbox', hold: true, keys: [{ time: 0, value: 0.1 }] }] } });
  const sound = await publishWav(be, 'cue-goal.wav', 'sfx-tick', 'tick');
  await cmd('setEventCues', { cues: [{ on: 'signal', name: 'tick', assetId: sound }] });
  await cmd('setShell', { shell: { hud: ['hud'] } });
  await cmd('setDialogue', { dialogue: { dialogueId: 'talk', name: 'Talk', graph: {
    nodes: [{ id: 'start', type: 'start', position: [0, 0] }, { id: 'hello', type: 'line', position: [0, 100], data: { text: 'Hello.' } }],
    edges: [{ id: 'w1', from: { node: 'start', port: 'next' }, to: { node: 'hello', port: 'in' } }],
  } } });
  const metronome = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Metronome', transform: { position: [0, -5, 0] } }))['createdId']);
  await script('metronome', METRONOME, metronome);
  // A material an object wears, one nothing names, and an instance set (its buffer table).
  await cmd('setMaterial', { material: { materialId: 'mat-used', name: 'Used', shader: 'standard', params: {}, textures: {} } });
  await cmd('setMaterial', { material: { materialId: 'mat-unused', name: 'Unused', shader: 'standard', params: {}, textures: {} } });
  await cmd('setComponent', { entityId: STARTER.groundId, component: 'materials', value: { '*': 'mat-used' } });
  const transforms: number[] = [];
  for (let i = 0; i < 6; i += 1) transforms.push(2 + i, 0, -3, 0, 0, 0, 1, 0.3, 0.3, 0.3);
  const published = await api('content/buffers', { transforms });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  bufferDigest = String(published.json.digest);
  const assets = (await query('queryAssets', { limit: 50, offset: 0 })).assets as { assetId: string; displayName: string }[];
  const pillar = assets.find((a) => a.displayName === 'Pillar')!.assetId;
  await cmd('createEntity', { kind: 'group', name: 'Pillars', components: { instances: { asset: { assetId: pillar }, buffer: bufferDigest, count: 6 } } });
}

/**
 * The content files the manifest lists, read through `read` and
 * checked against their rows; the blocks are not in the document itself, only
 * the used material ships, and the buffer table names the instance set's buffer.
 */
async function expectContentFiles(manifest: Record<string, unknown>, read: (path: string) => Promise<Buffer>): Promise<void> {
  const rows = manifest['contentFiles'] as { key: string; path: string; digest: string; byteLength: number }[];
  expect(rows.map((r) => r.key)).toEqual([...CONTENT_FILES]);
  for (const k of CONTENT_FILES) expect(k in manifest, `the manifest itself carries no ${k}`).toBe(false);
  const blocks: Record<string, unknown> = {};
  for (const r of rows) {
    expect(r.path).toBe(`content/sha256/${r.digest}`);
    const bytes = await read(r.path);
    expect(bytes.length).toBe(r.byteLength);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(r.digest);
    blocks[r.key] = JSON.parse(bytes.toString('utf8'));
  }
  expect((blocks['materials'] as { materialId: string }[]).map((m) => m.materialId)).toEqual(['mat-used']);
  expect((blocks['uiDocuments'] as { uiDocumentId: string }[]).map((d) => d.uiDocumentId).sort()).toEqual(['hud', 'panel']);
  expect(JSON.stringify(blocks['dialogue'])).toContain('Hello.');
  expect(blocks['buffers']).toEqual([{ digest: bufferDigest, byteLength: 6 * 40 }]);
}

/** Every authored key is present and the document's keys follow MANIFEST_KEYS_V2. */
function expectManifestKeys(manifest: Record<string, unknown>): void {
  const keys = Object.keys(manifest);
  for (const k of AUTHORED) expect(keys, `manifest key ${k}`).toContain(k);
  expect(keys).toEqual(MANIFEST_KEYS_V2.filter((k) => keys.includes(k)));
  expect(keys.every((k) => (MANIFEST_KEYS_V2 as readonly string[]).includes(k))).toBe(true);
}

interface Obs {
  state?: string;
  mode?: { current: string };
  ui?: { shown: string[] };
  timeline?: { screen: { letterbox: number } };
  sound?: { unlocked?: boolean; played?: { sfx: number } };
}

/** The checks that each authored block is used by the running game (Play relay or the export's own observation). */
async function expectRunning(root: Page | FrameLocator, observe: () => Promise<Obs>, unlock: () => Promise<void>): Promise<void> {
  await expect.poll(async () => (await observe()).mode?.current ?? null, { timeout: 60_000 }).toBe('main');
  // The mode's document is the simulation's (observed); the shell's HUD is the host's (drawn in the page).
  await expect.poll(async () => (await observe()).ui?.shown ?? [], { timeout: 20_000 }).toContain('panel');
  await expect(root.locator('[data-tl-ui-doc="hud"] [data-widget="line"]')).toHaveText('Shell HUD', { timeout: 20_000 });
  await expect.poll(async () => (await observe()).timeline?.screen.letterbox ?? 0, { timeout: 20_000 }).toBeCloseTo(0.1, 3);
  await unlock();
  await expect.poll(async () => (await observe()).sound?.unlocked ?? false, { timeout: 30_000 }).toBe(true);
  const played = async (): Promise<number> => (await observe()).sound?.played?.sfx ?? 0;
  const first = await played();
  await expect.poll(played, { timeout: 20_000, message: 'the event sound plays on the signal' }).toBeGreaterThan(first);
}

/** A plain static file server: the exported game gets nothing else. It records the paths it served. */
function serveDir(dir: string, served: string[] = []): Promise<{ url: string; close: () => Promise<void> }> {
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
    served.push(rel);
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

test('a manifest with modes, timelines, event cues, the shell, dialogue and the other optional keys builds, verifies, plays and exports', async ({ page }) => {
  test.setTimeout(300_000);
  await buildProject();

  // Play: the manifest the preview read (and verified) carries every authored key, in order.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const manifestRead = page.waitForResponse((r) => r.url().endsWith('/manifest.json') && r.status() === 200);
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  // What the Play page read by digest (content files, the instance buffer).
  const playReads = new Map<string, Buffer>();
  page.on('response', (r) => {
    const m = /\/content\/sha256\/([0-9a-f]{64})$/.exec(r.url());
    if (m !== null && r.status() === 200) void r.body().then((b) => playReads.set(m[1]!, b), () => undefined);
  });
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const playManifest = (await (await manifestRead).json()) as Record<string, unknown>;
  expectManifestKeys(playManifest);
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('running');
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expectRunning(page.frameLocator('iframe.tl-app__preview-frame'), observe, async () => {
    const box = (await frame.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  });
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  // The Play page read every content file (checked here against the rows) and the instance buffer the table names.
  await expect.poll(() => [...(playManifest['contentFiles'] as { digest: string }[]).map((r) => r.digest), bufferDigest].every((d) => playReads.has(d)), { timeout: 20_000 }).toBe(true);
  await expectContentFiles(playManifest, async (path) => playReads.get(path.slice('content/sha256/'.length))!);
  await page.getByTitle('Stop the play preview').click();
  await expect(frame).toHaveCount(0, { timeout: 30_000 });

  // Export: the written manifest, then the game from a static server with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  const served: string[] = [];
  const exported = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  expectManifestKeys(exported);
  // The content files are in the export tree (the same bytes as Play's: one capture of the same project).
  await expectContentFiles(exported, async (path) => readFileSync(join(out, path)));
  expect(exported['contentFiles']).toEqual(playManifest['contentFiles']);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out, served);
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    const read = async (): Promise<Obs> => (await game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? {}) as Obs));
    await expectRunning(game, read, () => game.mouse.click(400, 300));
    expect(errors).toEqual([]);
    // The exported page read every content file and the instance buffer from the static server.
    for (const r of exported['contentFiles'] as { path: string }[]) expect(served, r.path).toContain(r.path);
    expect(served).toContain(`content/sha256/${bufferDigest}`);
  } finally {
    await game.close();
    await site.close();
  }
});
