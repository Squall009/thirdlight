/**
 * Environment presets, against a real backend, on a
 * neutral scene built by commands on a blank project — a grey panel near the
 * camera (lit by the sun), a wall far behind the fog's reach (its pixels are
 * the fog colour), a gradient sky above.
 *
 * - Editor: the look and the lights are set to "day" and captured as a preset
 *   in the Environment window ("capture current as preset"), then to "night"
 *   and captured again (each capture is one command: undo/redo). The Scene
 *   view previews the day preset over the night look, and the blend preview
 *   slider shows a mix between them.
 * - Play: a script (keys choose) shows day, blends to night over 2 s, and
 *   holds mixes of 35 % and 70 % night. Pixels, each taken at a steady blend
 *   the game reports: the sky and the lit panel darken progressively (the
 *   mixes differ from both ends, in order) and the fog colour changes; the
 *   2 s blend is seen under way in the reported weights.
 * - The static export (backend stopped) does the same.
 *
 * Runs per renderer: WebGL 2 in `default`, WebGPU in `webgpu`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, exportQueryFor, onlyInItsProject, type RendererVariant } from './renderer-variants';
import { openWindow } from './ui';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-environment-presets' }, args });
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

/** Keys pick the look: 1 day at once, 2 night over 2 s, 3 / 4 a held mix of 35 % / 70 % night. */
const DIRECTOR = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(state: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent' || ctx.environment === undefined) return;",
  "    if (ctx.input.pressed('lookDay')) ctx.environment.set('day');",
  "    if (ctx.input.pressed('lookNight')) ctx.environment.set('night', { blend: 2 });",
  "    if (ctx.input.pressed('mix35')) ctx.environment.blend('day', 'night', 0.35);",
  "    if (ctx.input.pressed('mix70')) ctx.environment.blend('day', 'night', 0.7);",
  '  },',
  '};',
].join('\n');

const DAY_LOOK = {
  sky: { mode: 'gradient', topColor: '#3a7bd5', horizonColor: '#bfe0ff', bottomColor: '#a0b0c0' },
  fog: { mode: 'linear', color: '#e0e8f0', near: 12, far: 50 },
};
const NIGHT_LOOK = {
  sky: { mode: 'gradient', topColor: '#02030a', horizonColor: '#0a1024', bottomColor: '#050508' },
  fog: { mode: 'linear', color: '#502028', near: 12, far: 50 },
};
const DAY_LIGHTS = { sun: { color: '#ffffff', intensity: 2.5 }, ambient: { color: '#8090a8', intensity: 0.5 } };
const NIGHT_LIGHTS = { sun: { color: '#5060c0', intensity: 0.15 }, ambient: { color: '#303848', intensity: 0.05 } };

async function setLights(l: typeof DAY_LIGHTS): Promise<void> {
  await cmd('setComponent', { entityId: 'light-0001', component: 'light', value: { type: 'directional', color: l.sun.color, intensity: l.sun.intensity, direction: [0.2, -0.6, -1], castShadow: false } });
  await cmd('setComponent', { entityId: 'light-0002', component: 'light', value: { type: 'ambient', color: l.ambient.color, intensity: l.ambient.intensity } });
}

type RGB = [number, number, number];
/** Average colour of a rectangle given as fractions of the image. */
function avg(img: Image, x0: number, y0: number, x1: number, y1: number): RGB {
  let r = 0, g = 0, b = 0, n = 0;
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
const bright = (c: RGB): number => (c[0] + c[1] + c[2]) / 3;
/** The fixture's three regions: the sky band, the lit panel (left), the fogged wall (right). */
interface Look {
  sky: RGB;
  panel: RGB;
  fog: RGB;
}
const lookOf = (img: Image): Look => ({ sky: avg(img, 0.1, 0.02, 0.9, 0.12), panel: avg(img, 0.2, 0.55, 0.4, 0.7), fog: avg(img, 0.6, 0.4, 0.8, 0.6) });
const shot = async (t: Locator | Page): Promise<Image> => decodePng(await t.screenshot());

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

type Env = { target: string | null; progress: number; weights: Record<string, number>; step?: number } | null;

/**
 * Drive the director with keys and check the pictures, each taken while the
 * reported blend weights stay the same before and after it: day, held mixes
 * of 35 % and 70 % night, the 2 s blend to night under way (weights strictly
 * between the ends, target night) and night. Sky and lit panel darken in
 * order day > 35 % > 70 % > night, the fog changes colour. A picture caught
 * during the 2 s blend itself (the host is often too loaded to take one
 * inside 2 s) is checked when it happens.
 */
async function checkBlend(read: () => Promise<Env>, target: Locator | Page, press: (key: string) => Promise<void>, label: string): Promise<void> {
  const night = (e: Env): number | null => (e === null ? null : Object.entries(e.weights).reduce((acc, [k, w]) => acc + (k.startsWith('night') ? w : 0), 0));
  /** A picture at a steady blend (the night share read after it still the same). */
  const steady = async (key: string, share: number): Promise<Look> => {
    if (key !== '') await press(key);
    // A screenshot now and then keeps the headless page drawing frames (without one it may stop sending them).
    await expect.poll(async () => { await shot(target); return night(await read()); }, { timeout: 90_000, message: `${label}: night share ${share} after key ${key}` }).toBeCloseTo(share, 9);
    for (let i = 0; i < 10; i += 1) {
      const img = await shot(target);
      const after = night(await read());
      if (after !== null && Math.abs(after - share) < 1e-9) return lookOf(img);
    }
    throw new Error(`${label}: the blend did not hold at ${share}`);
  };
  const d = await steady('Digit1', 0);
  const m35 = await steady('Digit3', 0.35);
  const m70 = await steady('Digit4', 0.7);
  await steady('Digit1', 0);
  // The 2 s blend: weights between the ends while it runs (and a picture if one lands inside it).
  await press('Digit2');
  const seen: number[] = [];
  let during: { t: number; look: Look } | null = null;
  const until = Date.now() + 60_000;
  for (;;) {
    const e = await read();
    const t = night(e);
    const img = await shot(target);
    if (t !== null && t > 0 && t < 1 && e?.target === 'night' && e.progress < 1) {
      seen.push(t);
      const after = night(await read());
      if (during === null && after !== null && after > 0 && after < 1) during = { t: (t + after) / 2, look: lookOf(img) };
    }
    if (t === 1 || Date.now() > until) break;
  }
  expect(seen.length, `${label}: the blend to night was seen under way`).toBeGreaterThan(0);
  const n = await steady('', 1);
  const fmt = (c: RGB): string => c.map(Math.round).join(',');
  console.log(`[environment-presets] ${label}: day sky ${fmt(d.sky)} panel ${fmt(d.panel)} fog ${fmt(d.fog)}; 35% ${fmt(m35.sky)} / ${fmt(m35.panel)} / ${fmt(m35.fog)}; 70% ${fmt(m70.sky)} / ${fmt(m70.panel)} / ${fmt(m70.fog)}; night sky ${fmt(n.sky)} panel ${fmt(n.panel)} fog ${fmt(n.fog)}; under way ${seen.map((x) => x.toFixed(2)).join(' ')}${during !== null ? `; picture at ${during.t.toFixed(2)}: sky ${fmt(during.look.sky)} panel ${fmt(during.look.panel)}` : ''}`);
  // The ends: night is much darker (sky and the lit panel), the fog changes colour (bluish white to dark red).
  expect(bright(d.sky) - bright(n.sky)).toBeGreaterThan(80);
  expect(bright(d.panel) - bright(n.panel)).toBeGreaterThan(40);
  expect(d.fog[2]).toBeGreaterThan(d.fog[0] - 5);
  expect(n.fog[0]).toBeGreaterThan(n.fog[2] + 10);
  expect(bright(d.fog) - bright(n.fog)).toBeGreaterThan(60);
  // Progressive: each step towards night darker than the one before (not a switch).
  const order = [d, m35, m70, n];
  for (let k = 1; k < order.length; k += 1) {
    expect(bright(order[k]!.sky), `${label}: the sky darkens, step ${k}`).toBeLessThan(bright(order[k - 1]!.sky) - 5);
    expect(bright(order[k]!.panel), `${label}: the panel darkens, step ${k}`).toBeLessThan(bright(order[k - 1]!.panel) - 2);
    expect(bright(order[k]!.fog), `${label}: the fog darkens, step ${k}`).toBeLessThan(bright(order[k - 1]!.fog) - 2);
  }
  if (during !== null) {
    expect(bright(during.look.sky), `${label}: sky mid-blend`).toBeLessThan(bright(d.sky) - 3);
    expect(bright(during.look.sky), `${label}: sky mid-blend`).toBeGreaterThan(bright(n.sky) + 3);
  }
}

const VARIANTS: readonly RendererVariant[] = ['webgl2', 'webgpu'];

for (const variant of VARIANTS) test(`environment presets: capture and preview in the editor; a script blends day to night in Play and the export (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(420_000);
  be = await startBackend('environment-presets-e2e');

  // The fixture: the camera looking along −Z, a grey panel near it, a wall behind the fog's reach.
  await cmd('setTransform', { entityId: 'cam-main', transform: { position: [0, 1, 6], rotation: [0, 0, 0, 1] } });
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Panel', transform: { position: [-2.5, 0.3, 0] }, box: { size: [4, 2, 0.1], material: { color: '#c0c0c0' } } });
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Far wall', transform: { position: [30, 0, -80] }, box: { size: [60, 40, 1], material: { color: '#c0c0c0' } } });
  const director = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Director', transform: { position: [0, -20, 0] } }))['createdId']);
  await cmd('setInput', {
    input: {
      actions: [
        { name: 'lookDay', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Digit1' }] },
        { name: 'lookNight', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Digit2' }] },
        { name: 'mix35', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Digit3' }] },
        { name: 'mix70', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'Digit4' }] },
      ],
    },
  });
  await script('env-director', DIRECTOR, director);
  await cmd('setEnvironment', { environment: DAY_LOOK });
  await setLights(DAY_LIGHTS);

  page.on('pageerror', (e) => console.log(`[page pageerror] ${e.message} ${e.stack?.slice(0, 600)}`));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[page console] ${m.type()} ${m.text().slice(0, 300)}`); });
  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const viewport = page.locator('canvas.tl-viewport');
  await expectRendererBackend(viewport, variant);
  const synced = async (): Promise<void> => {
    const rev = Number((await query('queryProject')).revision);
    await expect(page.locator('.tl-statusbar')).toContainText(new RegExp(`revision ${rev}(?!\\d)`));
  };
  const presetsNow = async (): Promise<{ presetId: string; name: string; sky?: Record<string, unknown>; lights?: Record<string, unknown>[] }[]> => (((await query('queryGameConfig'))['environment'] as { presets?: [] } | undefined)?.presets ?? []) as never;
  await synced();

  // Capture "Day": the look and every scene light as they are now.
  await openWindow(page, 'Environment');
  const panel = page.getByLabel('environment presets');
  await panel.getByLabel('new preset name').fill('Day');
  await panel.getByRole('button', { name: 'capture current as preset' }).click();
  await expect.poll(async () => (await presetsNow()).map((p) => p.presetId)).toEqual(['day']);
  const day = (await presetsNow())[0]!;
  expect(day.sky).toMatchObject({ mode: 'gradient', topColor: '#3a7bd5' });
  expect(day.lights).toEqual([
    { entity: 'light-0001', color: '#ffffff', intensity: 2.5, direction: [0.2, -0.6, -1] },
    { entity: 'light-0002', color: '#8090a8', intensity: 0.5 },
  ]);

  // Night: the look (keeping the presets) and the lights, then capture it too.
  const envNow = (await query('queryGameConfig'))['environment'] as Record<string, unknown>;
  await cmd('setEnvironment', { environment: { ...envNow, ...NIGHT_LOOK } });
  await setLights(NIGHT_LIGHTS);
  await synced();
  await panel.getByLabel('new preset name').fill('Night');
  await panel.getByRole('button', { name: 'capture current as preset' }).click();
  await expect.poll(async () => (await presetsNow()).map((p) => p.presetId)).toEqual(['day', 'night']);
  await expect(panel.locator('li[data-preset-id]')).toHaveCount(2);
  // One command each: undo takes the capture back, redo brings it again.
  await synced();
  await viewport.click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await presetsNow()).map((p) => p.presetId)).toEqual(['day']);
  await synced();
  await page.keyboard.press('Control+y');
  await expect.poll(async () => (await presetsNow()).map((p) => p.presetId)).toEqual(['day', 'night']);
  await synced();

  // Scene view: the night look; previewing "day" brightens the sky, the blend slider sits between.
  const skyOf = async (): Promise<number> => bright(avg(await shot(viewport), 0.05, 0.02, 0.95, 0.15));
  await expect.poll(skyOf, { timeout: 20_000, message: 'the night sky in the Scene view' }).toBeLessThan(60);
  const nightSky = await skyOf();
  await panel.getByRole('button', { name: 'preview preset day' }).click();
  await expect.poll(skyOf, { timeout: 20_000, message: 'the day preset previewed' }).toBeGreaterThan(nightSky + 80);
  const daySky = await skyOf();
  await panel.getByLabel('blend preview from').selectOption('day');
  await panel.getByLabel('blend preview to').selectOption('night');
  await panel.getByRole('slider', { name: 'blend preview' }).fill('0.5');
  await expect.poll(async () => { const v = await skyOf(); return v > nightSky + 15 && v < daySky - 15; }, { timeout: 20_000, message: 'the blend preview between day and night' }).toBe(true);
  await panel.getByRole('button', { name: 'stop preview' }).click();
  await expect.poll(skyOf, { timeout: 20_000 }).toBeLessThan(nightSky + 10);
  // Previewing stored nothing.
  expect((await presetsNow()).length).toBe(2);

  // Play: the script's day → night blend.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  const readPlay = async (): Promise<Env> => {
    const r = await api(`play/${psid}/observe`, {});
    const e = r.status === 200 ? ((r.json as { environment?: Env }).environment ?? null) : null;
    return e === null ? null : { ...e, step: Number(r.json['stepIndex']) };
  };
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const pressPlay = async (key: string): Promise<void> => {
    await page.keyboard.down(key);
    await page.waitForTimeout(250);
    await page.keyboard.up(key);
  };
  await checkBlend(readPlay, frame, pressPlay, `${variant} play`);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  await page.getByTitle('Stop the play preview').click();

  // The static export, served with the backend stopped: the same blend.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  await page.goto('about:blank');
  await be.halt();
  const site = await serveDir(out);
  const exported = await page.context().newPage();
  const errors: string[] = [];
  exported.on('pageerror', (e) => {
    errors.push(e.message);
    console.log(`[export pageerror] ${e.message} ${e.stack?.slice(0, 600)}`);
  });
  exported.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[export console] ${m.type()} ${m.text().slice(0, 300)}`); });
  try {
    await exported.goto(`${site.url}${exportQueryFor(variant)}`);
    await expectRendererBackend(exported.locator('canvas').first(), variant);
    const readExport = (): Promise<Env> =>
      exported.evaluate(() => {
        const o = (window as unknown as { __thirdlightObserve?: () => { environment?: Record<string, unknown>; stepIndex?: number } | null }).__thirdlightObserve?.();
        return (o?.environment !== undefined ? { ...o.environment, step: o.stepIndex } : null) as Env;
      });
    const vp = exported.viewportSize()!;
    await exported.mouse.click(vp.width / 2, vp.height / 2);
    const pressExport = async (key: string): Promise<void> => {
      await exported.keyboard.down(key);
      await exported.waitForTimeout(250);
      await exported.keyboard.up(key);
    };
    await checkBlend(readExport, exported, pressExport, `${variant} export`);
    expect(errors).toEqual([]);
  } finally {
    await site.close();
  }
});
