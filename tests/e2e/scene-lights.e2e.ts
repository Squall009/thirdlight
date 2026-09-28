/**
 * Phase 25.8: lights belong to scenes — checked in pixels in Play, against a
 * real backend, under each renderer variant (the forced WebGL 2 one with
 * TL_E2E_ALL_VARIANTS=1).
 *
 * The starter template (its sun turned red and aimed at the camera's view,
 * its ambient light dimmed) plus a white wall behind the character, and two
 * scenes that do not start:
 *
 * - "Dusk": only a blue directional light;
 * - "Level": its own wall in front of the start scene's, a directional light
 *   at intensity 0 (night) and a dim ambient light, 12 green point lights in
 *   a row just in front of the wall (short range: each lights its own patch)
 *   and a white spot light with a striped cookie above them.
 *
 * In Play the relay loads and unloads them (as a script's `ctx.scenes`):
 * the start picture is red; Dusk loaded, blue; Dusk unloaded, red again;
 * Level loaded, the row across the middle shows 12 separate green patches
 * (every one of its 12 point lights lights it) and the spot's patch is
 * striped (the cookie, three's `SpotLight.map`); Dusk loaded over Level,
 * blue; Dusk unloaded, Level's night comes back (not the start scene's red
 * sun); Level unloaded, red. The renderer diagnostics name the directional
 * light that is on at each point and count the local lights and cookies.
 * Then the export (Level a second start scene, so its night sun wins over
 * the start scene's), served statically with the backend stopped: night, 12
 * lamps and the cookie in its own pixels.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test } from '@playwright/test';

import { publishBytes, startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { makePng } from './png-make';
import { editorUrlFor, exportQueryFor, expectRendererBackend, onlyInItsProject, RENDERER_VARIANTS } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-scene-lights' }, args });
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

function share(img: Image, test: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  let all = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      all += 1;
      if (test(r, g, b)) n += 1;
    }
  }
  return n / all;
}
const red = (r: number, g: number, b: number): boolean => r > 60 && r > 2 * g && r > 2 * b;
const blue = (r: number, g: number, b: number): boolean => b > 60 && b > 2 * r && b > 2 * g;
const green = (r: number, g: number, b: number): boolean => g > 40 && g > 1.6 * r && g > 1.6 * b;
const bright = (r: number, g: number, b: number): boolean => r + g + b > 240;

/** Separate runs of pixels passing `test` along row y (runs shorter than `minRun` ignored). */
function runs(img: Image, y: number, test: (r: number, g: number, b: number) => boolean, minRun = 2): number {
  let n = 0;
  let len = 0;
  for (let x = 0; x <= img.width; x += 1) {
    const on = x < img.width && test(...img.pixel(x, y));
    if (on) len += 1;
    else {
      if (len >= minRun) n += 1;
      len = 0;
    }
  }
  return n;
}
/** The most runs any row between the fractions `from`–`to` of the height shows. */
function mostRuns(img: Image, from: number, to: number, test: (r: number, g: number, b: number) => boolean): number {
  let best = 0;
  for (let y = Math.floor(img.height * from); y < Math.floor(img.height * to); y += 1) best = Math.max(best, runs(img, y, test));
  return best;
}

/** A plain static file server: the exported game gets nothing else. */
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

for (const variant of RENDERER_VARIANTS) test(`lights belong to scenes: the most recently loaded scene's sun is on, 12 point lights of a loaded level light it, a spot cookie shows (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(300_000);
  be = await startBackend('scene-lights-e2e', 'starter');

  // The start scene: a red sun shining at the camera's view (-z), a dim fill, a white wall behind everything.
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: '#ff0000', intensity: 3, direction: [0, -0.2, -1], castShadow: false } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: '#ffffff', intensity: 0.05 } });
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Back wall', transform: { position: [4, 3, -4] }, box: { size: [60, 40, 1], material: { color: '#ffffff' } } });

  // Dusk: a blue sun only.
  await cmd('createScene', { sceneId: 'scene-dusk', name: 'Dusk' });
  const dusk = String((await cmd('createEntity', { sceneId: 'scene-dusk', parentId: null, kind: 'group', name: 'Dusk sun', transform: { position: [0, 0, 0] }, components: { light: { type: 'directional', color: '#0000ff', intensity: 3, direction: [0, -0.2, -1] } } }))['createdId']);

  // Level: its wall, a night sun, a dim fill, 12 green lamps in a row and a striped spot.
  await publishBytes(be, makePng(64, 64, (x) => (Math.floor(x / 8) % 2 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255])), 'texture', 'tex-stripes');
  await cmd('createScene', { sceneId: 'scene-level', name: 'Level' });
  const level = (entities: Record<string, unknown>[]) => cmd('createEntities', { sceneId: 'scene-level', entities });
  const lamps = Array.from({ length: 12 }, (_, i) => ({ parentId: null, kind: 'group', name: `Lamp ${i + 1}`, transform: { position: [4 + (i - 5.5) * 1.8, 3, -2.7] }, components: { light: { type: 'point', color: '#00ff00', intensity: 3, range: 1.2, decay: 2 } } }));
  await level([
    { parentId: null, kind: 'box', name: 'Level wall', transform: { position: [4, 3, -3.5] }, box: { size: [60, 40, 1], material: { color: '#ffffff' } } },
    { parentId: null, kind: 'group', name: 'Night fill', transform: { position: [0, 0, 0] }, components: { light: { type: 'ambient', color: '#ffffff', intensity: 0.02 } } },
    ...lamps,
    { parentId: null, kind: 'group', name: 'Stripe spot', transform: { position: [4, 7.5, 4] }, components: { light: { type: 'spot', color: '#ffffff', intensity: 400, range: 0, decay: 2, angle: 22, penumbra: 0, direction: [0, 0, -1], cookie: 'tex-stripes' } } },
  ]);
  const nightSun = String((await cmd('createEntity', { sceneId: 'scene-level', parentId: null, kind: 'group', name: 'Night sun', transform: { position: [0, 0, 0] }, components: { light: { type: 'directional', color: '#ffffff', intensity: 0, direction: [0, -0.2, -1] } } }))['createdId']);

  page.on('pageerror', (e) => console.log(`[page pageerror] ${e.message}`));
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  type Obs = { state?: string; scenes?: { loaded: string[] } };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`)).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  type Lights = { directional: string | null; ambient: string | null; hemisphere: string | null; local: number; localOn: number; cookies: number };
  const lights = async (): Promise<Lights | null> => {
    const r = await api(`play/${psid}/diagnostics`);
    return ((r.json as { diagnostics?: { renderer?: { lights?: Lights } } }).diagnostics?.renderer?.lights) ?? null;
  };
  const shot = async (): Promise<Image> => {
    const r = await api(`play/${psid}/screenshot`, { maxWidth: 512 });
    expect(r.status, JSON.stringify(r.json).slice(0, 200)).toBe(200);
    return decodePng(Buffer.from(String(r.json['dataUrl']).replace(/^data:image\/png;base64,/, ''), 'base64'));
  };
  const control = async (command: string, sceneId: string): Promise<void> => {
    const r = await api(`play/${psid}/control`, { command, sceneId });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  };
  const loaded = async (ids: string[]): Promise<void> => {
    await expect.poll(async () => (await observe()).scenes?.loaded ?? [], { timeout: 30_000 }).toEqual(ids);
  };
  const log = async (what: string): Promise<Image> => {
    const img = await shot();
    console.log(`${what} (${variant}): red ${share(img, red).toFixed(3)} blue ${share(img, blue).toFixed(3)} green ${share(img, green).toFixed(3)} lights ${JSON.stringify(await lights())}`);
    return img;
  };

  // The start scene's red sun.
  await expect.poll(async () => (await lights())?.directional, { timeout: 30_000 }).toBe('light-0001');
  await expect.poll(async () => share(await shot(), red), { timeout: 20_000 }).toBeGreaterThan(0.3);
  expect(share(await log('start'), blue)).toBeLessThan(0.01);

  // Dusk loaded: its blue sun is on, the red one off.
  await control('loadScene', 'scene-dusk');
  await loaded(['scene-main', 'scene-dusk']);
  await expect.poll(async () => (await lights())?.directional, { timeout: 30_000 }).toBe(dusk);
  await expect.poll(async () => share(await shot(), blue), { timeout: 20_000 }).toBeGreaterThan(0.3);
  expect(share(await log('dusk'), red)).toBeLessThan(0.01);
  expect((await lights())?.ambient).toBe('light-0002'); // Dusk holds no ambient light: the start scene's stays on

  // Dusk unloaded: the start scene's sun comes back.
  await control('unloadScene', 'scene-dusk');
  await loaded(['scene-main']);
  await expect.poll(async () => (await lights())?.directional, { timeout: 30_000 }).toBe('light-0001');
  await expect.poll(async () => share(await shot(), red), { timeout: 20_000 }).toBeGreaterThan(0.3);
  expect(share(await log('dusk unloaded'), blue)).toBeLessThan(0.01);

  // Level loaded: night, its 12 lamps light its wall (12 separate green patches across the middle), the spot's cookie stripes.
  await control('loadScene', 'scene-level');
  await loaded(['scene-main', 'scene-level']);
  await expect.poll(async () => await lights(), { timeout: 30_000 }).toEqual({ directional: nightSun, ambient: expect.any(String), hemisphere: null, local: 13, localOn: 13, cookies: 1 });
  await expect.poll(async () => mostRuns(await shot(), 0.35, 0.65, green), { timeout: 20_000 }).toBe(12);
  const night = await log('level');

  expect(share(night, red)).toBeLessThan(0.01);
  // The striped cookie: the spot's patch (upper part of the view) shows its stripes as separate bright runs (a plain spot: one).
  const stripes = mostRuns(night, 0.02, 0.4, bright);
  console.log(`cookie stripes (${variant}): ${stripes}`);
  expect(stripes).toBeGreaterThanOrEqual(3);

  // Dusk over Level: blue; Dusk unloaded: Level's night again (not the start scene's red sun).
  await control('loadScene', 'scene-dusk');
  await loaded(['scene-main', 'scene-level', 'scene-dusk']);
  await expect.poll(async () => (await lights())?.directional, { timeout: 30_000 }).toBe(dusk);
  await expect.poll(async () => share(await shot(), blue), { timeout: 20_000 }).toBeGreaterThan(0.3);
  await control('unloadScene', 'scene-dusk');
  await loaded(['scene-main', 'scene-level']);
  await expect.poll(async () => (await lights())?.directional, { timeout: 30_000 }).toBe(nightSun);
  await expect.poll(async () => share(await shot(), blue), { timeout: 20_000 }).toBeLessThan(0.01);
  expect(share(await log('dusk over level unloaded'), red)).toBeLessThan(0.01);

  // Level unloaded: the start scene's red sun and fill; its lamps and cookie are gone.
  await control('unloadScene', 'scene-level');
  await loaded(['scene-main']);
  await expect.poll(async () => await lights(), { timeout: 30_000 }).toEqual({ directional: 'light-0001', ambient: 'light-0002', hemisphere: null, local: 0, localOn: 0, cookies: 0 });
  await expect.poll(async () => share(await shot(), red), { timeout: 20_000 }).toBeGreaterThan(0.3);
  expect(share(await log('level unloaded'), green)).toBeLessThan(0.01);
  await expect(page.locator('.tl-notice')).toHaveCount(0);

  // The export, with Level a start scene too (the later start scene's sun is on): night, 12 lamps, the cookie —
  // from a static server with the backend stopped.
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
  await cmd('setStartScenes', { sceneIds: ['scene-main', 'scene-level'] });
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(`${site.url}${exportQueryFor(variant)}`);
    const canvas = game.locator('canvas').first();
    await expectRendererBackend(canvas, variant);
    const exportShot = async (): Promise<Image> => decodePng(await canvas.screenshot());
    await expect.poll(async () => mostRuns(await exportShot(), 0.35, 0.65, green), { timeout: 30_000 }).toBe(12);
    const img = await exportShot();
    console.log(`export (${variant}): red ${share(img, red).toFixed(3)} green ${share(img, green).toFixed(3)} stripes ${mostRuns(img, 0.02, 0.45, bright)}`);
    expect(share(img, red)).toBeLessThan(0.01);
    expect(mostRuns(img, 0.02, 0.45, bright)).toBeGreaterThanOrEqual(3);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
