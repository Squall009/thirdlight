/**
 * Texture mip streaming against a real backend in a real browser, per
 * renderer variant (renderer-variants.ts).
 *
 * Two 2048² checkers (8-texel squares: the first four levels show squares,
 * from level 4, the 128² mip tail, on they average to grey) are imported
 * as KTX2 colour, so they stream by default (over 1024 px). Unlit boxes
 * wear them with a quarter tiling, and a project script moves the boxes
 * (a debug command) while Play runs.
 *
 * - Far away a texture holds only its mip tail; brought up to the camera its
 *   resident level rises to 0 (full size), and the picture shows the
 *   checker's squares (high-frequency detail the tail does not have).
 * - The export ships the parts, not the whole file, and the exported game
 *   (served with the backend stopped) streams them: the box that starts
 *   close shows its full-size squares.
 * - Under a tiny texture budget (one full chain and a little) the resident
 *   bytes stay inside it at every observation, and when the second texture
 *   is brought close while the first leaves the view, the first (now the
 *   least needed) drops its full-size level and the second gets it.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';
import { projectWindow } from './ui';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-texture-streaming' }, args });
  expect(res['ok'], JSON.stringify(res).slice(0, 400)).toBe(true);
  return res;
}
async function api(path: string, body: unknown, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, { method, headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** Upload a PNG and publish it encoded to KTX2 colour (the MCP path). */
async function importKtx2(bytes: Uint8Array, assetId: string): Promise<void> {
  const headers = { authorization: `Bearer ${be!.token}`, origin: be!.origin };
  const base = `${be!.origin}/api/v1/projects/${be!.projectId}/content/stages`;
  const stage = (await (await fetch(base, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).json()) as { stageId: string };
  const put = await fetch(`${base}/${stage.stageId}/bytes`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  expect(put.status).toBe(200);
  const inspected = (await (await fetch(`${base}/${stage.stageId}/inspect`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'texture', ktx2: 'color' }) })).json()) as { proposal?: Record<string, unknown>; convertedFrom?: Record<string, unknown> };
  const p = inspected.proposal!;
  expect(p['status'], JSON.stringify(inspected).slice(0, 300)).toBe('ok');
  await cmd('publishAsset', { mode: 'create', assetId, kind: 'texture', displayName: assetId, sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], convertedFrom: inspected.convertedFrom, importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
}

/** A 2048² checker of 8-texel squares in two colours. */
const checker = (a: [number, number, number], b: [number, number, number]): Uint8Array =>
  new Uint8Array(makePng(2048, 2048, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [...a, 255] : [...b, 255])));

/** The project script: `place {id, x, y, z}` moves an object (the texture's box). */
const MOVER = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(_state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    for (const c of ctx.debug.command('place', { description: 'Move an object', args: [{ name: 'id', type: 'string' }, { name: 'x', type: 'number' }, { name: 'y', type: 'number' }, { name: 'z', type: 'number' }] })) {",
  "      ctx.entity(String(c.id))?.set('transform', { position: [Number(c.x), Number(c.y), Number(c.z)] });",
  '    }',
  '  },',
  '};',
].join('\n');

async function installMover(entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: MOVER }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json['stageId']);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, { method: 'PUT', headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) }, body: bytes });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId: 'mover', displayName: 'Mover', mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId: 'mover', displayName: 'Mover', declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json).slice(0, 300)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId: 'mover', values: {} });
}

interface Streamed {
  id: string;
  levels: number;
  tail: number;
  resident: number;
  wanted: number;
  copies: number;
  bytes: number;
}
interface Textures {
  budgetBytes: number;
  residentBytes: number;
  streamedBytes: number;
  over: boolean;
  loading: number;
  textures: Streamed[];
}

/** Luma steps across 3 pixels in the middle half of the picture, per sample: the checker has many, the grey tail none. */
function detail(img: Image): number {
  const lum = (x: number, y: number): number => {
    const [r, g, b] = img.pixel(x, y);
    return 0.3 * r + 0.59 * g + 0.11 * b;
  };
  let steps = 0;
  let samples = 0;
  for (let y = Math.floor(img.height / 4); y < (img.height * 3) / 4; y += 4) {
    for (let x = Math.floor(img.width / 4); x < (img.width * 3) / 4 - 3; x += 2) {
      samples += 1;
      if (Math.abs(lum(x, y) - lum(x + 3, y)) > 90) steps += 1;
    }
  }
  return samples === 0 ? 0 : steps / samples;
}
const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

/**
 * The scene: a dark sky, the camera at z 6 looking along −Z, two unlit boxes (A, B) wearing the checkers; returns
 * their ids. With `withB` false only A is made (and only checker-a need be imported).
 */
async function buildScene(withB = true): Promise<{ a: string; b: string | null }> {
  await cmd('setMaterial', { material: { materialId: 'mat-a', name: 'A', shader: 'unlit', params: { tiling: [0.25, 0.25] }, textures: { map: 'checker-a' } } });
  if (withB) await cmd('setMaterial', { material: { materialId: 'mat-b', name: 'B', shader: 'unlit', params: { tiling: [0.25, 0.25] }, textures: { map: 'checker-b' } } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#303030' } } });
  const ents = ((await query('queryEntities', { limit: 100, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities;
  const cam = ents.find((e) => e.components['virtualCamera'] !== undefined)!.id;
  await cmd('setTransform', { entityId: cam, transform: { position: [0, 0, 6], rotation: [0, 0, 0, 1] } });
  for (const e of ents) if (e.components['box'] !== undefined) await cmd('setTransform', { entityId: e.id, transform: { position: [0, -50, 0] } });
  const ids: string[] = [];
  for (const [name, mat, x] of ([['Box A', 'mat-a', 0], ['Box B', 'mat-b', 0]] as const).slice(0, withB ? 2 : 1)) {
    const id = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'box', name, transform: { position: [x, 0, -60] }, box: { size: [2, 2, 0.05], material: { color: '#ffffff' } } }))['createdId']);
    await cmd('setComponent', { entityId: id, component: 'materials', value: { '*': mat } });
    ids.push(id);
  }
  const driver = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Driver', transform: { position: [0, -10, 0] } }))['createdId']);
  await installMover(driver);
  return { a: ids[0]!, b: ids[1] ?? null };
}

async function startPlay(page: Page): Promise<{ psid: string; frame: Locator; observe: () => Promise<Textures | null>; place: (id: string, at: [number, number, number]) => Promise<void> }> {
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  const observe = async (): Promise<Textures | null> => {
    const r = await api(`play/${psid}/observe`, {});
    if (r.status !== 200) return null;
    return ((r.json['resources'] as { textures?: Textures } | undefined)?.textures ?? null) as Textures | null;
  };
  await expect.poll(async () => (await api(`play/${psid}/observe`, {})).json['state'], { timeout: 60_000 }).toBe('running');
  const place = async (id: string, at: [number, number, number]): Promise<void> => {
    const r = await api(`play/${psid}/control`, { command: 'debugCommand', name: 'place', args: { id, x: at[0], y: at[1], z: at[2] } });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
  };
  return { psid, frame, observe, place };
}

function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(root, rel);
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((d) => server.close(() => d())) })));
}

const texOf = (t: Textures | null, id: string): Streamed | undefined => t?.textures.find((x) => x.id === id);

for (const variant of RENDERER_VARIANTS) test(`a large KTX2 texture streams its mips by on-screen size inside the texture budget (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(420_000);
  be = await startBackend(`tex-stream-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await importKtx2(checker([235, 235, 235], [15, 15, 15]), 'checker-a');
  await importKtx2(checker([240, 220, 40], [20, 20, 120]), 'checker-b');
  // Over 1024 px: streamed by default; the sidecar says so.
  const assets = (await query('queryAssets', { limit: 10, offset: 0 }))['assets'] as { assetId: string; image?: { levels?: number }; streaming?: unknown }[];
  const a0 = assets.find((a) => a.assetId === 'checker-a')!;
  expect(a0.image?.levels).toBe(12);
  expect(a0.streaming).toEqual({ on: true, set: false, possible: true });
  expect(JSON.parse(readFileSync(join(be.projectDir, 'assets', 'checker-a.png.tlasset'), 'utf8'))).toMatchObject({ importSettings: { ktx2: 'color', streaming: true } });
  const scene = await buildScene();
  const a = scene.a;
  const b = scene.b!;

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // ---- Far, then near: the resident level rises and the checker shows.
  const play = await startPlay(page);
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  // Far (66 m): only the tail (levels 4.., 128² and down) is held.
  await expect.poll(async () => texOf(await play.observe(), 'checker-a')?.resident ?? -1, { timeout: 60_000 }).toBe(4);
  const far = texOf(await play.observe(), 'checker-a')!;
  expect(far).toMatchObject({ levels: 12, tail: 4, wanted: 4 });
  // Near (1.2 m, filling the view): level 0 arrives.
  const t0 = Date.now();
  await play.place(a, [0, 0, 4.8]);
  await expect.poll(async () => texOf(await play.observe(), 'checker-a')?.resident ?? -1, { timeout: 30_000 }).toBe(0);
  const upgradeMs = Date.now() - t0;
  const near = texOf(await play.observe(), 'checker-a')!;
  expect(near.wanted).toBe(0);
  expect(near.bytes).toBeGreaterThan(far.bytes * 50);
  let steps = 0;
  await expect.poll(async () => (steps = detail(await shot(play.frame))), { timeout: 30_000, message: 'the checker at full size' }).toBeGreaterThan(0.08);
  // Back far: nothing needs level 0 now, but the budget (512 MiB by default) has room, so it stays.
  await play.place(a, [0, 0, -60]);
  await expect.poll(async () => texOf(await play.observe(), 'checker-a')?.wanted ?? -1, { timeout: 30_000 }).toBe(4);
  expect(texOf(await play.observe(), 'checker-a')!.resident).toBe(0);
  const fullChain = near.bytes;
  await page.getByTitle('Stop the play preview').click();
  test.info().annotations.push({ type: 'streaming', description: JSON.stringify({ variant, upgradeMs, fullChainBytes: fullChain, tailBytes: far.bytes, detail: steps }) });

  // ---- A tiny budget: one full chain and a little.
  const budgetMb = Math.ceil((fullChain * 1.5) / (1024 * 1024));
  await cmd('setSettings', { settings: { texture_budget_mb: budgetMb } });
  const small = await startPlay(page);
  const budget = budgetMb * 1024 * 1024;
  const seen: number[] = [];
  const sample = async (): Promise<Textures | null> => {
    const t = await small.observe();
    if (t !== null) {
      seen.push(t.residentBytes);
      expect(t.budgetBytes).toBe(budget);
    }
    return t;
  };
  // A comes close: it gets level 0.
  await small.place(a, [0, 0, 4.8]);
  await expect.poll(async () => texOf(await sample(), 'checker-a')?.resident ?? -1, { timeout: 30_000 }).toBe(0);
  // A leaves the view and B comes close in one step: A is the least needed, so its full-size level makes room for B's.
  await small.place(a, [0, 60, -10]);
  await small.place(b, [0, 0, 4.8]);
  await expect.poll(async () => texOf(await sample(), 'checker-b')?.resident ?? -1, { timeout: 30_000 }).toBe(0);
  const after = (await sample())!;
  expect(texOf(after, 'checker-a')!.resident).toBeGreaterThan(0);
  expect(texOf(after, 'checker-a')!.wanted).toBe(4);
  for (const n of seen) expect(n).toBeLessThanOrEqual(budget);
  expect(after.over).toBe(false);
  await expect.poll(async () => detail(await shot(small.frame)), { timeout: 30_000, message: 'B at full size' }).toBeGreaterThan(0.08);
  await page.getByTitle('Stop the play preview').click();
  test.info().annotations.push({ type: 'budget', description: JSON.stringify({ variant, budgetBytes: budget, maxResident: Math.max(...seen), samples: seen.length }) });
  expect(errors).toEqual([]);

  // The export ships each streamed texture as its parts (the head with the tail, then levels 3..0), never the whole KTX2,
  // and the exported game streams them: A starts close to the camera there and shows its full-size squares.
  await cmd('setTransform', { entityId: a, transform: { position: [0, 0, 4.8] } });
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json).slice(0, 300)).toBe(200);
  const out = join(be.exportRoot, String(res.json['outputDir']));
  const versions = ((await query('queryAssets', { limit: 10, offset: 0, includeVersions: true }))['assets'] as { assetId: string; versions?: { sourceDigest: string }[] }[]).filter((x) => x.assetId.startsWith('checker-'));
  expect(versions).toHaveLength(2);
  for (const v of versions) expect(existsSync(join(out, 'content', 'sha256', v.versions![0]!.sourceDigest))).toBe(false);
  expect(readdirSync(join(out, 'content', 'sha256')).length).toBeGreaterThanOrEqual(10);
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const exportErrors: string[] = [];
  exported.on('pageerror', (e) => exportErrors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    await expect.poll(async () => detail(await shot(exported)), { timeout: 60_000, message: 'the export: A at full size' }).toBeGreaterThan(0.08);
    expect(exportErrors).toEqual([]);
  } finally {
    await site.close();
  }
});

/** In a page: hide WebGL 2's compressed texture extensions (counted), as a GPU without them would. */
function hideCompressedFormats(): void {
  const g = globalThis as unknown as { __tlHiddenCompressed?: number; WebGL2RenderingContext?: { prototype: { getExtension(name: string): unknown } } };
  const proto = g.WebGL2RenderingContext?.prototype;
  if (proto === undefined || g.__tlHiddenCompressed !== undefined) return;
  g.__tlHiddenCompressed = 0;
  const get = proto.getExtension;
  proto.getExtension = function (this: unknown, name: string): unknown {
    if (/compress/i.test(String(name))) {
      g.__tlHiddenCompressed = (g.__tlHiddenCompressed ?? 0) + 1;
      return null;
    }
    return get.call(this, name);
  };
}

for (const variant of RENDERER_VARIANTS) test(`a large KTX2 transcoded to RGBA (no compressed format on the GPU) streams its mips and shows (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(240_000);
  be = await startBackend(`tex-stream-rgba-${randomUUID().slice(0, 8)}`);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Every frame (the editor and Play) reports no compressed format: the transcoder writes plain RGBA.
  await page.context().addInitScript(hideCompressedFormats);
  // One texture is enough here (the budget test above moves two): each 2048² KTX2 encode adds to the run.
  await importKtx2(checker([235, 235, 235], [15, 15, 15]), 'checker-a');
  const { a } = await buildScene(false);
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const play = await startPlay(page);
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  await expect.poll(async () => texOf(await play.observe(), 'checker-a')?.resident ?? -1, { timeout: 60_000 }).toBe(4);
  // RGBA levels: four bytes a texel (level 4, 128², is 64 KiB of the tail's bytes).
  expect(texOf(await play.observe(), 'checker-a')!.bytes).toBeGreaterThanOrEqual(128 * 128 * 4);
  await play.place(a, [0, 0, 4.8]);
  await expect.poll(async () => texOf(await play.observe(), 'checker-a')?.resident ?? -1, { timeout: 30_000 }).toBe(0);
  await expect.poll(async () => detail(await shot(play.frame)), { timeout: 30_000, message: 'the RGBA checker at full size' }).toBeGreaterThan(0.08);
  // The RGBA path was taken in Play: its probe asked for compressed formats and was told none.
  const playFrame = page.frames().find((f) => f !== page.mainFrame() && f.url().includes('/play'))!;
  expect(await playFrame.evaluate(() => (globalThis as unknown as { __tlHiddenCompressed?: number }).__tlHiddenCompressed ?? 0)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
  await page.getByTitle('Stop the play preview').click();
});

test('the asset inspector sets a texture\'s mip streaming (one command, in its sidecar)', async ({ page }) => {
  test.setTimeout(180_000);
  be = await startBackend(`tex-stream-ui-${randomUUID().slice(0, 8)}`);
  await importKtx2(new Uint8Array(makePng(1280, 1280, (x, y) => (((x >> 4) + (y >> 4)) % 2 === 0 ? [200, 200, 200, 255] : [30, 30, 30, 255]))), 'big');
  await importKtx2(new Uint8Array(makePng(256, 256, () => [90, 140, 200, 255])), 'small');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await projectWindow(page);
  const pick = async (name: string): Promise<void> => {
    const tile = page.locator('.tl-assets__list li[data-asset-id]').filter({ hasText: name });
    await expect(tile).toHaveCount(1, { timeout: 10_000 });
    await tile.click();
  };
  const select = page.getByRole('combobox', { name: 'texture streaming' });
  const streamingOf = async (id: string): Promise<unknown> => ((await query('queryAssets', { limit: 10, offset: 0 }))['assets'] as { assetId: string; streaming?: unknown }[]).find((x) => x.assetId === id)?.streaming;
  const sidecar = (file: string): Record<string, unknown> => JSON.parse(readFileSync(join(be!.projectDir, 'assets', `${file}.tlasset`), 'utf8')) as Record<string, unknown>;

  // Over 1024 px: on by default.
  await pick('big');
  await expect(select).toHaveValue('default');
  await expect(select.locator('option[value="default"]')).toHaveText('default for its size (on)');
  await select.selectOption('off');
  await expect.poll(() => streamingOf('big')).toEqual({ on: false, set: true, possible: true });
  expect(sidecar('big.png')).toMatchObject({ importSettings: { streaming: false }, record: { streaming: false } });
  await expect(select).toHaveValue('off');
  // Undo puts the default back (the shortcut, from outside the form field).
  await select.evaluate((e) => (e as HTMLElement).blur());
  await page.keyboard.press('Control+z');
  await expect.poll(() => streamingOf('big')).toEqual({ on: true, set: false, possible: true });

  // 256 px: off by default, on when asked.
  await pick('small');
  await expect(select.locator('option[value="default"]')).toHaveText('default for its size (off)');
  await select.selectOption('on');
  await expect.poll(() => streamingOf('small')).toEqual({ on: true, set: true, possible: true });
  await expect(select).toHaveValue('on');
});
