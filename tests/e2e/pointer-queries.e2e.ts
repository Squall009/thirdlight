/**
 * Pointer input and 3D queries against a real backend, on a
 * neutral 3D scene built by commands on a blank project — three coloured
 * boxes (colliders in the collision layer "pickable") in front of the scene
 * camera, a small lamp above each, no player. A script lights the lamp of
 * the box under the pointer (`ctx.physics.pickAtPointer` filtered by the
 * layer; hover edges from its own state) and hides a box when it is clicked
 * (`ctx.input.pointerPressed`) — both observed through tl_game_observe
 * (`hidden`) and in the preview's pixels.
 *
 * - Play (the simulation worker): the real mouse hovers the red box, then
 *   clicks it.
 * - Play again: the same hover and click replayed through the input relay
 *   (tl_input_exercise's route, pointer samples in the frames) give the same
 *   result.
 * - The static export (backend stopped): the mouse hovers and clicks there.
 * - Editor: "+ pointer" adds a mouse binding in the Input window, a map's
 *   cursor is set to locked, and a collision layer is added and removed in
 *   the Tags window (one command each, stored in the project).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { menu, openProjectSettings } from './ui';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-pointer' }, args });
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
async function create(name: string, position: number[], extra: Record<string, unknown> = {}, kind = 'group'): Promise<string> {
  return String((await cmd('createEntity', { parentId: null, kind, name, transform: { position }, ...extra }))['createdId']);
}

/** Publish a behavior with entityRef properties and attach it to `entityId` with `values`. */
async function script(behaviorId: string, source: string, entityId: string, props: string[], values: Record<string, unknown>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: props.map((key) => ({ key, label: key, type: 'entityRef', default: null })) };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values });
}

/** The picker: the lamp of the box under the pointer is lit; a click hides the box. */
const PICKER = [
  'export default {',
  '  instantiate() { return { hover: null as string | null }; },',
  '  step(state: { hover: string | null }, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const p = ctx.properties;',
  '    const lampOf: Record<string, string> = { [p.red]: p.red_lamp, [p.green]: p.green_lamp, [p.blue]: p.blue_lamp };',
  '    if (ctx.stepIndex === 0) for (const id of Object.values(lampOf)) ctx.game.setVisible(id, false);',
  "    const hit = ctx.physics.pickAtPointer(undefined, { layers: ['pickable'] });",
  '    const id = hit === null ? null : hit.entityId;',
  '    if (id !== state.hover) {',
  '      if (state.hover !== null) ctx.game.setVisible(lampOf[state.hover], false);',
  '      if (id !== null) ctx.game.setVisible(lampOf[id], true);',
  "      if (id !== null) ctx.log('info', 'hover ' + id);",
  '      state.hover = id;',
  '    }',
  "    if (id !== null && ctx.input.pointerPressed('left')) ctx.game.setVisible(id, false);",
  '  },',
  '};',
].join('\n');

type Obs = { state: string; stepIndex: number; hidden?: string[]; pointer?: { x: number; y: number; buttons: number; over: boolean } };
type Scene = { red: string; green: string; blue: string; redLamp: string; greenLamp: string; blueLamp: string };

async function buildScene(): Promise<Scene> {
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('setCollisionLayers', { layers: ['pickable'] });
  await cmd('setEnvironment', { environment: { sky: { mode: 'color', color: '#202428' } } });
  // The scene camera 12 m in front of the boxes, looking down −Z at their height.
  const ents = (await query('queryEntities', { limit: 200, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[];
  const camera = ents.find((e) => e.components['camera'] !== undefined)!;
  await cmd('setTransform', { entityId: camera.id, transform: { position: [0, 1, 12], rotation: [0, 0, 0, 1] } });
  const pickable = (hx: number) => ({ collider: { shape: { type: 'box', hx, hy: hx, hz: hx }, layers: ['pickable'] } });
  const red = await create('Red', [-3, 1, 0], { box: { size: [1.6, 1.6, 1.6], material: { color: '#e23c3c' } }, components: pickable(0.8) }, 'box');
  const green = await create('Green', [0, 1, 0], { box: { size: [1.6, 1.6, 1.6], material: { color: '#2fb04a' } }, components: pickable(0.8) }, 'box');
  const blue = await create('Blue', [3, 1, 0], { box: { size: [1.6, 1.6, 1.6], material: { color: '#2f6fe0' } }, components: pickable(0.8) }, 'box');
  const lamp = (name: string, x: number) => create(name, [x, 2.6, 0], { box: { size: [0.5, 0.5, 0.5], material: { color: '#fff3a0' } } }, 'box');
  const redLamp = await lamp('Red lamp', -3);
  const greenLamp = await lamp('Green lamp', 0);
  const blueLamp = await lamp('Blue lamp', 3);
  const picker = await create('Picker', [0, -20, 0]);
  const s = { red, green, blue, redLamp, greenLamp, blueLamp };
  const values = { red, green, blue, red_lamp: redLamp, green_lamp: greenLamp, blue_lamp: blueLamp };
  await script('pointer-picker', PICKER, picker, Object.keys(values), values);
  return s;
}

/** The centroid of the red pixels of an image (fractions of its size), and how many there are. */
function redBlob(img: Image): { x: number; y: number; n: number } {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 90 && r > g * 2 && r > b * 2) {
        sx += x;
        sy += y;
        n += 1;
      }
    }
  }
  return n === 0 ? { x: 0, y: 0, n } : { x: sx / n / img.width, y: sy / n / img.height, n };
}

/** The game view (the canvas) in page coordinates, and a screenshot of just it. */
async function view(page: Page, canvasSelector: string, inFrame: boolean): Promise<{ box: { x: number; y: number; width: number; height: number }; img: Image }> {
  const canvas = inFrame ? page.locator('iframe.tl-app__preview-frame').contentFrame().locator(canvasSelector).first() : page.locator(canvasSelector).first();
  const box = (await canvas.boundingBox())!;
  const img = decodePng(await page.screenshot({ clip: box }));
  return { box, img };
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
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

const lampsOff = (s: Scene): string[] => [s.redLamp, s.greenLamp, s.blueLamp].sort();

test('pointer: hover lights a box\'s lamp and a click hides it — the mouse in Play, the same through the input relay, and in the export', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('pointer-e2e');
  const s = await buildScene();
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  const startPlay = async (): Promise<(() => Promise<Obs | null>)> => {
    const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
    await page.getByTitle('Start an isolated play preview').click();
    const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
    const observe = async (): Promise<Obs | null> => {
      const r = await api(`play/${psid}/observe`, {});
      return r.status === 200 ? (r.json as unknown as Obs) : null;
    };
    (observe as unknown as { psid: string }).psid = psid;
    // The script has run: every lamp is off.
    await expect.poll(async () => (await observe())?.hidden?.slice().sort().join(',') ?? '', { timeout: 60_000 }).toBe(lampsOff(s).join(','));
    return observe;
  };

  // ---- Play: the real mouse ----
  const observe = await startPlay();
  expect((await observe())!.state).toBe('running');
  await page.waitForTimeout(500);
  const before = await view(page, 'canvas', true);
  const red = redBlob(before.img);
  expect(red.n, 'the red box is in view').toBeGreaterThan(50);
  const at = { x: before.box.x + red.x * before.box.width, y: before.box.y + red.y * before.box.height };
  await page.mouse.move(at.x - 40, at.y - 120);
  await page.mouse.move(at.x, at.y, { steps: 5 });
  // Hover: the red lamp is lit (no longer hidden); the pointer the simulation read is over the view.
  await expect.poll(async () => (await observe())?.hidden?.includes(s.redLamp), { timeout: 30_000, message: 'the red lamp lights on hover' }).toBe(false);
  const o = (await observe())!;
  expect(o.hidden!.slice().sort()).toEqual([s.greenLamp, s.blueLamp].sort());
  expect(o.pointer!.over).toBe(true);
  expect(Math.abs(o.pointer!.x - red.x)).toBeLessThan(0.02);
  // Click: the red box is hidden — in the observation and in the pixels.
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  await expect.poll(async () => (await observe())?.hidden?.includes(s.red), { timeout: 30_000, message: 'the click hides the red box' }).toBe(true);
  await expect.poll(async () => redBlob((await view(page, 'canvas', true)).img).n, { timeout: 30_000, message: 'no red pixels once hidden' }).toBeLessThan(red.n / 10);
  const physical = (await observe())!.hidden!.slice().sort();
  await page.getByTitle('Stop the play preview').click();

  // ---- Play again: the same hover and click through the input relay (tl_input_exercise's route) ----
  await page.mouse.move(5, 5); // keep the real mouse off the view
  const observe2 = await startPlay();
  const psid = (observe2 as unknown as { psid: string }).psid;
  const p = { x: Math.round(red.x * 1e4) / 1e4, y: Math.round(red.y * 1e4) / 1e4 };
  const frames = [
    { stepOffset: 0, pointer: { x: 0.5, y: 0.05 } },
    { stepOffset: 20, pointer: { x: p.x, y: p.y } },
    { stepOffset: 40, pointer: { x: p.x, y: p.y, buttons: 1 } },
    { stepOffset: 52, pointer: { x: p.x, y: p.y } },
    { stepOffset: 60 },
  ];
  const relayed = await api(`play/${psid}/input`, { mode: 'exclusive-test', frames });
  expect(relayed.status, JSON.stringify(relayed.json)).toBe(200);
  await expect.poll(async () => (await observe2())?.hidden?.slice().sort().join(','), { timeout: 30_000, message: 'the relayed click gives the same result' }).toBe(physical.join(','));
  await page.getByTitle('Stop the play preview').click();

  // ---- The static export, backend stopped: hover and click with the mouse ----
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    const read = (): Promise<Obs | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Obs | null);
    await expect.poll(async () => (await read())?.hidden?.slice().sort().join(',') ?? '', { timeout: 60_000 }).toBe(lampsOff(s).join(','));
    await game.waitForTimeout(500);
    const v = await view(game, 'canvas', false);
    const r2 = redBlob(v.img);
    expect(r2.n).toBeGreaterThan(50);
    // Under the export's fixed menu overlay: move and click by coordinates.
    await game.mouse.move(v.box.x + r2.x * v.box.width, v.box.y + r2.y * v.box.height, { steps: 5 });
    await expect.poll(async () => (await read())?.hidden?.includes(s.redLamp), { timeout: 30_000 }).toBe(false);
    await game.mouse.down();
    await game.waitForTimeout(100);
    await game.mouse.up();
    await expect.poll(async () => (await read())?.hidden?.slice().sort().join(','), { timeout: 30_000 }).toBe(physical.join(','));
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});

test('editor: a pointer binding and a locked cursor in the Input window; a collision layer in the Tags window', async ({ page }) => {
  test.setTimeout(120_000);
  be = await startBackend('pointer-editor-e2e');
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  await openProjectSettings(page, 'Input');
  const attack = page.getByLabel('action attack', { exact: true });
  await attack.getByLabel('add a pointer binding to attack', { exact: true }).selectOption({ label: 'left button' });
  await expect(attack.getByLabel('binding Mouse left', { exact: true })).toBeVisible();
  await page.getByLabel('cursor while gameplay', { exact: true }).selectOption('locked');
  await expect.poll(async () => {
    const input = (await query('queryGameConfig'))['input'] as { actions: { name: string; bindings: unknown[] }[]; cursor?: unknown } | null;
    return JSON.stringify([input?.actions.find((a) => a.name === 'attack')?.bindings.at(-1), input?.cursor]);
  }).toBe(JSON.stringify([{ kind: 'pointerButton', button: 'left' }, { gameplay: 'locked' }]));
  // An edit of the actions keeps the cursor setting.
  await attack.getByRole('button', { name: 'remove binding Mouse left from attack' }).click();
  await expect.poll(async () => JSON.stringify(((await query('queryGameConfig'))['input'] as { cursor?: unknown }).cursor)).toBe(JSON.stringify({ gameplay: 'locked' }));

  await menu(page, 'File', 'Project tags');
  const layers = page.getByLabel('collision layers', { exact: true });
  await layers.getByLabel('new collision layer name', { exact: true }).fill('units');
  await layers.getByRole('button', { name: 'add layer' }).click();
  await expect(layers.locator('[data-layer="units"]')).toBeVisible();
  await expect.poll(async () => JSON.stringify((await query('queryGameConfig'))['collisionLayers'])).toBe('["units"]');
  // "default" cannot be named; removing the unused layer is one command.
  await layers.getByLabel('new collision layer name', { exact: true }).fill('default');
  await expect(layers.getByRole('button', { name: 'add layer' })).toBeDisabled();
  await layers.getByRole('button', { name: 'remove collision layer units' }).click();
  await expect.poll(async () => JSON.stringify((await query('queryGameConfig'))['collisionLayers'])).toBe('[]');
});
