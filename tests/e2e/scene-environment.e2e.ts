/**
 * Each scene its own look, against a real backend, in the editor. Two
 * scenes of a blank project get different solid skies (set by MCP-style
 * commands with `sceneId`); the editor opens both:
 *
 * - the Scene view shows the active scene's sky (Unity's rule), and switches
 *   when another scene is made active;
 * - the Environment window names the scene it edits and stores its edits in
 *   that scene only (one command, one undo);
 * - "+ Scene" starts from the engine defaults, or copies the look of the
 *   scene chosen beside it.
 *
 * In Play and the static export (backend stopped) a script loads the second
 * scene and makes it active over 10 s: the sky starts red (the first start
 * scene's), is between red and blue while the reported share is between, and
 * is the other scene's blue once that is active at once; back to red again.
 *
 * Runs per renderer: WebGL 2 in `default`, WebGPU in `webgpu`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, PRODUCT_RENDERER_VARIANTS } from './renderer-variants';
import { openWindow, toolWindowScene } from './ui';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-scene-environment' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
/** Each scene's stored look, by scene id. */
async function looks(): Promise<Record<string, unknown>> {
  const rows = (await query('queryProject', { environments: true }))['scenes'] as { sceneId: string; environment?: unknown }[];
  return Object.fromEntries(rows.map((r) => [r.sceneId, r.environment ?? null]));
}

function avg(img: Image, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = Math.floor(img.height * y0); y < Math.floor(img.height * y1); y += 3) {
    for (let x = Math.floor(img.width * x0); x < Math.floor(img.width * x1); x += 3) {
      const p = img.pixel(x, y);
      r += p[0];
      g += p[1];
      b += p[2];
      n += 1;
    }
  }
  return [r / n, g / n, b / n];
}
/** The sky at the top of a view: [r, g, b]. */
const skyOf = async (t: Locator | Page): Promise<[number, number, number]> => avg(decodePng(await t.screenshot()), 0.05, 0.02, 0.95, 0.12);
const header = (page: Page, name: string): Locator => page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: new RegExp(`^${name}$`) }) });

const RED_SKY = { sky: { mode: 'color', color: '#d02020' } };
const BLUE_SKY = { sky: { mode: 'color', color: '#2040d0' } };

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`each scene's look in the Scene view; the Environment window edits the active scene's (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(180_000);
  be = await startBackend('scene-environment-e2e');
  await cmd('createScene', { sceneId: 'scene-two', name: 'Two' });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: RED_SKY });
  await cmd('setEnvironment', { sceneId: 'scene-two', environment: BLUE_SKY });

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);
  const red = async (): Promise<boolean> => { const [r, , b] = await skyOf(viewport); return r > b + 80; };
  const blue = async (): Promise<boolean> => { const [r, , b] = await skyOf(viewport); return b > r + 80; };

  // Main is the active scene: its red sky.
  await expect(header(page, 'Main')).toHaveClass(/is-active/);
  await expect.poll(red, { timeout: 20_000, message: "the active scene's (Main) red sky" }).toBe(true);
  // Opening Two keeps Main active (and its sky); making Two active shows Two's blue sky.
  await page.getByLabel('open scene').selectOption({ label: 'Two' });
  await expect(header(page, 'Two')).toHaveCount(1);
  await expect.poll(red, { timeout: 10_000 }).toBe(true);
  await header(page, 'Two').click();
  await expect(header(page, 'Two')).toHaveClass(/is-active/);
  await expect.poll(blue, { timeout: 20_000, message: "the active scene's (Two) blue sky" }).toBe(true);

  // The Environment window names the scene it edits; an edit goes to that scene only.
  await openWindow(page, 'Environment');
  const named = toolWindowScene(page, 'Environment');
  await expect(named).toHaveAttribute('data-scene-id', 'scene-two');
  await expect(named.getByRole('combobox')).toHaveValue('scene-two');
  await page.getByRole('combobox', { name: 'sky mode' }).selectOption('gradient');
  await expect.poll(async () => (await looks())['scene-two']).toMatchObject({ sky: { mode: 'gradient' } });
  expect((await looks())['scene-main']).toEqual({ sky: { color: '#d02020', mode: 'color' } });
  // The file of the edited scene holds it.
  expect((JSON.parse(readFileSync(join(be.projectDir, 'scenes', 'scene-two.json'), 'utf8')) as { scene: { environment?: unknown } }).scene.environment).toMatchObject({ sky: { mode: 'gradient' } });
  // The default gradient's pale horizon replaces the solid blue (#2040d0 has almost no red).
  await expect.poll(async () => (await skyOf(viewport))[0], { timeout: 20_000, message: 'the gradient sky' }).toBeGreaterThan(100);
  // One undo puts Two's colour sky back.
  await viewport.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await looks())['scene-two']).toEqual({ sky: { color: '#2040d0', mode: 'color' } });

  // Back to Main: the window follows the active scene.
  await header(page, 'Main').click();
  await expect(named).toHaveAttribute('data-scene-id', 'scene-main');
  await expect(page.getByRole('combobox', { name: 'sky mode' })).toHaveValue('color');
  await expect.poll(red, { timeout: 20_000 }).toBe(true);

  // "+ Scene": the engine defaults, or the look of the scene chosen beside it.
  await page.getByRole('button', { name: '+ Scene' }).click();
  await expect(header(page, 'Scene 3')).toHaveClass(/is-active/);
  await page.getByLabel('new scene look').selectOption({ label: 'look of Two' });
  await page.getByRole('button', { name: '+ Scene' }).click();
  await expect(header(page, 'Scene 4')).toHaveClass(/is-active/);
  const rows = (await query('queryProject', { environments: true }))['scenes'] as { name: string; environment?: unknown }[];
  expect(rows.find((r) => r.name === 'Scene 3')!.environment).toBeUndefined();
  expect(rows.find((r) => r.name === 'Scene 4')!.environment).toEqual({ sky: { color: '#2040d0', mode: 'color' } });
  await expect.poll(blue, { timeout: 20_000, message: "the copied look (Two's blue) on the new active scene" }).toBe(true);
});

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

/** Publish a behavior (no properties) and attach it to `entityId`. */
async function script(behaviorId: string, source: string, entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
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
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, close: () => new Promise((done) => server.close(() => done())) })));
}

/** Keys: 1 loads scene-two and makes it active over 10 s once it is in; 2 makes scene-main active at once; 3 scene-two at once. */
const DIRECTOR = [
  'let want = false;',
  'export default {',
  '  instantiate() { return {}; },',
  '  step(state: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    if (ctx.input.pressed('one')) { want = true; ctx.scenes.load('scene-two'); }",
  "    if (want && ctx.scenes.status('scene-two') === 'loaded') { want = false; ctx.scenes.setActive('scene-two', { blend: 10 }); }",
  "    if (ctx.input.pressed('two')) ctx.scenes.setActive('scene-main');",
  "    if (ctx.input.pressed('three')) ctx.scenes.setActive('scene-two');",
  '  },',
  '};',
].join('\n');

type SceneView = { active: string | null; from: string | null; weight: number } | null;

/**
 * Red, then the 10 s blend caught between (the share read before and after the
 * picture both between 0.35 and 0.65: a 3 s window), then blue at once, red at once.
 */
async function checkScenes(read: () => Promise<SceneView>, target: Locator | Page, press: (key: string) => Promise<void>, label: string): Promise<void> {
  const sky = async (): Promise<[number, number, number]> => skyOf(target);
  await expect.poll(async () => { const [r, , b] = await sky(); return r > b + 80; }, { timeout: 30_000, message: `${label}: the first start scene's red sky` }).toBe(true);
  const red = await sky();
  expect(await read(), `${label}: nothing reported before the active scene changes`).toBeNull();
  await press('Digit1');
  let mid: { share: number; rgb: [number, number, number] } | null = null;
  const until = Date.now() + 60_000;
  while (mid === null && Date.now() < until) {
    const before = await read();
    const rgb = await sky();
    const after = await read();
    if (before?.active === 'scene-two' && before.from === 'scene-main' && after?.from === 'scene-main' && before.weight > 0.35 && after.weight < 0.65) mid = { share: (before.weight + after.weight) / 2, rgb };
  }
  expect(mid, `${label}: the blend to scene-two caught under way`).not.toBeNull();
  await press('Digit3');
  await expect.poll(async () => (await read())?.weight, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => { const [r, , b] = await sky(); return b > r + 80; }, { timeout: 30_000, message: `${label}: scene-two's blue sky` }).toBe(true);
  const blue = await sky();
  console.log(`[scene-environment] ${label}: red ${red.map(Math.round).join(',')} mid(${mid!.share.toFixed(2)}) ${mid!.rgb.map(Math.round).join(',')} blue ${blue.map(Math.round).join(',')}`);
  // Between the two skies (not a switch): less red than red, more blue than red, and the other way round against blue.
  expect(mid!.rgb[0]).toBeLessThan(red[0] - 20);
  expect(mid!.rgb[2]).toBeGreaterThan(red[2] + 20);
  expect(mid!.rgb[0]).toBeGreaterThan(blue[0] + 20);
  expect(mid!.rgb[2]).toBeLessThan(blue[2] - 20);
  await press('Digit2');
  await expect.poll(async () => (await read())?.active, { timeout: 30_000 }).toBe('scene-main');
  await expect.poll(async () => { const [r, , b] = await sky(); return r > b + 80; }, { timeout: 30_000, message: `${label}: back to the red sky` }).toBe(true);
}

for (const variant of PRODUCT_RENDERER_VARIANTS) test(`two scenes in Play and the export: the active scene's sky, blended over setActive's blend (${variant})`, async ({ page }) => {
  onlyInItsProject(variant, PRODUCT_RENDERER_VARIANTS);
  test.setTimeout(300_000);
  be = await startBackend('scene-environment-play-e2e');
  await cmd('createScene', { sceneId: 'scene-two', name: 'Two' });
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Far box', sceneId: 'scene-two', transform: { position: [0, -3, -20] } });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: RED_SKY });
  await cmd('setEnvironment', { sceneId: 'scene-two', environment: BLUE_SKY });
  const director = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Director', sceneId: 'scene-main', transform: { position: [0, -20, 0] } }))['createdId']);
  await cmd('setInput', { input: { actions: ['one', 'two', 'three'].map((name, i) => ({ name, type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: `Digit${i + 1}` }] })) } });
  await script('scene-director', DIRECTOR, director);

  page.on('pageerror', (e) => console.log(`[page pageerror] ${e.message}`));
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  const readPlay = async (): Promise<SceneView> => {
    const r = await api(`play/${psid}/observe`, {});
    return r.status === 200 ? ((r.json as { environment?: { scene?: SceneView } }).environment?.scene ?? null) : null;
  };
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const pressPlay = async (key: string): Promise<void> => {
    await page.keyboard.down(key);
    await page.waitForTimeout(250);
    await page.keyboard.up(key);
  };
  await checkScenes(readPlay, frame, pressPlay, `${variant} play`);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => errors.push(e.message));
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    const readExport = (): Promise<SceneView> =>
      exported.evaluate(() => {
        const o = (window as unknown as { __thirdlightObserve?: () => { environment?: { scene?: unknown } } | null }).__thirdlightObserve?.();
        return (o?.environment?.scene ?? null) as SceneView;
      });
    const vp = exported.viewportSize()!;
    await exported.mouse.click(vp.width / 2, vp.height / 2);
    const pressExport = async (key: string): Promise<void> => {
      await exported.keyboard.down(key);
      await exported.waitForTimeout(250);
      await exported.keyboard.up(key);
    };
    await checkScenes(readExport, exported, pressExport, `${variant} export`);
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
