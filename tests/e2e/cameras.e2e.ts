/**
 * Phase 23.4: the camera framework against a real backend, on a neutral 3D
 * scene built by commands on a blank project (a floor, four coloured
 * pillars, a player capsule, a colour sky).
 *
 * - Play (the simulation worker): a follow camera on the player is live from
 *   the start; a script activates an orbit-a-point camera at step 360 with an
 *   eased 1 s blend (observed mid-blend: its progress matches the steps since
 *   the activation); a press of Q turns the orbit camera one snapped 90° step;
 *   a press of R starts a rail camera (letterbox bars drawn over the view),
 *   which the script deactivates at the end of its path — the view blends
 *   back to the orbit camera. The camera pose is read through
 *   tl_game_observe; each change moves pixels in the preview.
 * - The static export (backend stopped) resolves the same cameras
 *   (`window.__thirdlightObserve`).
 * - Editor: "+ Add component" → Virtual camera; its target, distance and rig
 *   in the Inspector; the Scene view previews where the rig puts it; the
 *   orbit point's handle and a camera path's point handle drag, store and
 *   undo.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';

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
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-cameras' }, args });
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

async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await query('queryEntity', { entityId: id });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
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

/**
 * The director: the orbit camera goes live at step 360 with an eased 1 s
 * blend; the rail action starts the rail camera; at the rail's end the
 * script lets it go (the view blends back to the orbit camera).
 */
const DIRECTOR = [
  'export default {',
  '  instantiate() { return { railing: false }; },',
  '  step(state: { railing: boolean }, ctx: any) {',
  "    if (ctx.phase !== 'intent' || ctx.camera === undefined) return;",
  '    const cam = ctx.camera;',
  '    const p = ctx.properties;',
  '    if (ctx.stepIndex === 360) cam.activate(p.orbit, { blend: "eased", time: 1 });',
  "    if (ctx.action.actions?.rail?.p === 'pressed') { cam.activate(p.rail); state.railing = true; }",
  '    const r = cam.get(p.rail);',
  '    if (state.railing && cam.live() === p.rail && !cam.blending() && r !== null && r.progress >= 1) { cam.deactivate(p.rail); state.railing = false; }',
  '  },',
  '};',
].join('\n');

type Cam = { live: string | null; blend: { from: string | null; progress: number; style: string } | null; position: number[]; rotation: number[]; fovY: number; letterbox: number };
type Observation = { state: string; stepIndex: number; camera?: Cam };

/** The neutral 3D scene and its cameras. */
async function buildScene(): Promise<{ follow: string; orbit: string; rail: string; player: string }> {
  await create('Floor', [0, -0.5, 0], { box: { size: [24, 1, 24], material: { color: '#8a8f98' } }, components: { collider: { shape: { type: 'box', hx: 12, hy: 0.5, hz: 12 } } } }, 'box');
  // Pillars (no colliders): each camera sees them from its own side.
  const pillars: [string, number[], string][] = [['Red', [-4, 1.5, 0], '#e23c3c'], ['Blue', [4, 1.5, 0], '#2f6fe0'], ['Green', [0, 1.5, -4], '#2fb04a'], ['Yellow', [0, 1.5, 4], '#f0c419']];
  for (const [name, at, color] of pillars) await create(name, at, { box: { size: [1.2, 3, 1.2], material: { color } } }, 'box');
  const player = await create('Player', [0, 0.91, 0]);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  await cmd('setEnvironment', { environment: { sky: { mode: 'color', color: '#7ec8ff' } } });
  await cmd('setInput', {
    input: {
      actions: [
        { name: 'turnLeft', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyQ' }] },
        { name: 'rail', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyR' }] },
      ],
    },
  });
  const follow = await create('Follow camera', [0, 4, 8]);
  await cmd('setComponent', { entityId: follow, component: 'virtualCamera', value: { rig: 'follow', target: player, distance: 8, pitch: 25 } });
  const orbit = await create('Orbit camera', [0, 0, 0]);
  await cmd('setComponent', { entityId: orbit, component: 'virtualCamera', value: { rig: 'orbitPoint', enabled: false, point: [0, 0, 0], distance: 16, pitch: 45, yawStep: 90, turnTime: 0.25, turnLeftAction: 'turnLeft' } });
  const track = await create('Rail track', [-6, 3, 8]);
  await cmd('setComponent', { entityId: track, component: 'cameraPath', value: { points: [[0, 0, 0], [12, 2, 0]], smooth: false } });
  const rail = await create('Rail camera', [0, 0, 0]);
  await cmd('setComponent', { entityId: rail, component: 'virtualCamera', value: { rig: 'rail', enabled: false, path: track, target: player, railSpeed: 2, letterbox: 0.12, blend: 'eased', blendTime: 0.5 } });
  const director = await create('Director', [0, -3, 0]);
  await script('camera-director', DIRECTOR, director, ['orbit', 'rail'], { orbit, rail });
  return { follow, orbit, rail, player };
}

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return api(`play/${path}`, body);
}

/** Share of sampled pixels that differ clearly between two same-size images. */
function changed(a: Image, b: Image): number {
  let n = 0;
  let d = 0;
  for (let y = 0; y < Math.min(a.height, b.height); y += 4) {
    for (let x = 0; x < Math.min(a.width, b.width); x += 4) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      n += 1;
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 60) d += 1;
    }
  }
  return n === 0 ? 0 : d / n;
}

/** Pixels of a pillar colour in the lower middle of the view (where the nearest pillar stands). */
function colour(img: Image, which: 'blue' | 'yellow'): number {
  let n = 0;
  for (let y = Math.floor(img.height * 0.5); y < Math.floor(img.height * 0.95); y += 2) {
    for (let x = Math.floor(img.width * 0.35); x < Math.floor(img.width * 0.65); x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (which === 'blue' ? b > 70 && b > r * 2 && b > g * 1.4 : r > 50 && g > 40 && b < r * 0.5) n += 1;
    }
  }
  return n;
}

/** Share of near-black pixels in a horizontal band (fractions of the height). */
function dark(img: Image, from: number, to: number): number {
  let n = 0;
  let d = 0;
  for (let y = Math.floor(img.height * from); y < Math.floor(img.height * to); y += 2) {
    for (let x = 0; x < img.width; x += 4) {
      const [r, g, b] = img.pixel(x, y);
      n += 1;
      if (r < 16 && g < 16 && b < 16) d += 1;
    }
  }
  return n === 0 ? 0 : d / n;
}

async function shot(target: Locator | Page, path?: string): Promise<Image> {
  return decodePng(await target.screenshot(path !== undefined ? { path } : {}));
}

const near = (a: number, b: number, eps = 0.02): boolean => Math.abs(a - b) <= eps;

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

test('virtual cameras in Play: follow → eased orbit (script), a 90° snap on input, a rail with letterbox that blends back; and in the export', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('cameras-e2e');
  const { follow, orbit, rail } = await buildScene();

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Observation | null> => {
    const r = await relay(`${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  const frame = page.locator('iframe.tl-app__preview-frame');

  // Follow: live from the start, 8 m behind and 25° above the player (resting at y 0.91).
  await expect.poll(async () => (await observe())?.camera?.live ?? null, { timeout: 60_000 }).toBe(follow);
  const f = (await observe())!.camera!;
  expect(f.position[0]).toBeCloseTo(0, 3);
  expect(f.position[1]).toBeCloseTo(0.91 + 8 * Math.sin((25 * Math.PI) / 180), 1);
  expect(f.position[2]).toBeCloseTo(8 * Math.cos((25 * Math.PI) / 180), 1);
  expect((await observe())!.state).toBe('scene');
  await page.waitForTimeout(500);
  const followShot = await shot(frame, 'test-results/cameras-follow.png');

  // The script's eased 1 s blend to the orbit camera (activated at step 360): caught under way.
  const seen: Observation[] = [];
  await expect
    .poll(
      async () => {
        const o = await observe();
        if (o?.camera !== undefined) seen.push(o);
        return o?.camera?.live === orbit && o.camera.blend === null;
      },
      { timeout: 120_000, intervals: [60] },
    )
    .toBe(true);
  const mid = seen.filter((o) => o.camera!.live === orbit && o.camera!.blend !== null);
  expect(mid.length, 'observed during the blend').toBeGreaterThan(0);
  for (const o of mid) {
    expect(o.camera!.blend).toMatchObject({ from: follow, style: 'eased' });
    // 1 s at 120 Hz: the progress is the steps since the activation (step 360) over 120.
    expect(Math.abs(o.camera!.blend!.progress - (o.stepIndex - 360) / 120)).toBeLessThan(3 / 120);
  }
  const d = 16 * Math.cos((45 * Math.PI) / 180);
  const o0 = (await observe())!.camera!;
  expect(near(o0.position[0], 0) && near(o0.position[1], d) && near(o0.position[2], d), JSON.stringify(o0.position)).toBe(true);
  const orbitShot = await shot(frame, 'test-results/cameras-orbit.png');
  expect(changed(followShot, orbitShot), 'the orbit view differs from the follow view').toBeGreaterThan(0.05);

  // A press of Q: one snapped quarter turn (yaw 90: the camera on +X).
  const box = (await frame.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('q');
  await page.waitForTimeout(250);
  await page.keyboard.up('q');
  await expect
    .poll(async () => {
      const c = (await observe())?.camera;
      return c !== undefined && c.live === orbit && near(c.position[0], d) && near(c.position[2], 0);
    }, { timeout: 60_000, message: 'the orbit camera turned 90° to +X' })
    .toBe(true);
  const turnedShot = await shot(frame, 'test-results/cameras-turned.png');
  expect(changed(orbitShot, turnedShot), 'the turned view differs').toBeGreaterThan(0.02);
  // Before the turn the yellow pillar (+Z) stands nearest, in the lower middle; after it the blue one (+X).
  expect(colour(orbitShot, 'yellow'), 'yellow in front before the turn').toBeGreaterThan(colour(orbitShot, 'blue') * 1.5);
  expect(colour(turnedShot, 'blue'), 'blue in front after the turn').toBeGreaterThan(colour(turnedShot, 'yellow') * 1.5);
  // Exactly one step: the next reading is still at yaw 90.
  await page.waitForTimeout(500);
  const still = (await observe())!.camera!;
  expect(near(still.position[0], d) && near(still.position[2], 0)).toBe(true);

  // R: the rail camera (letterbox bars over the view), let go at its end → back to the orbit camera.
  expect(dark(turnedShot, 0, 0.08), 'no bars before the rail').toBeLessThan(0.5);
  await page.keyboard.down('r');
  await page.waitForTimeout(250);
  await page.keyboard.up('r');
  await expect.poll(async () => (await observe())?.camera?.live ?? null, { timeout: 60_000 }).toBe(rail);
  await expect.poll(async () => (await observe())?.camera?.letterbox ?? 0, { timeout: 30_000 }).toBeGreaterThan(0.1);
  // The host draws the bars over the view (12% of the height each), seen in the preview's pixels.
  await expect(frame.contentFrame().locator('[data-tl-letterbox="top"]')).toHaveCSS('height', /px$/, { timeout: 30_000 });
  await expect.poll(async () => frame.contentFrame().locator('[data-tl-letterbox="top"]').evaluate((e) => Math.round((e.getBoundingClientRect().height / window.innerHeight) * 100)), { timeout: 30_000 }).toBe(12);
  await expect.poll(async () => dark(await shot(frame), 0, 0.08), { timeout: 30_000, message: 'the top letterbox bar' }).toBeGreaterThan(0.95);
  expect(dark(await shot(frame, 'test-results/cameras-rail.png'), 0.92, 1), 'the bottom letterbox bar').toBeGreaterThan(0.95);
  await expect
    .poll(async () => {
      const c = (await observe())?.camera;
      return c !== undefined && c.live === orbit && c.blend === null && near(c.position[0], d) && c.letterbox === 0;
    }, { timeout: 90_000, message: 'the view blended back to the orbit camera' })
    .toBe(true);
  await expect.poll(async () => dark(await shot(frame), 0, 0.08), { timeout: 30_000 }).toBeLessThan(0.5);
  await page.getByTitle('Stop the play preview').click();

  // The static export with the backend stopped: the same cameras, resolved in the export's simulation.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    const read = (): Promise<Cam | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => { camera?: unknown } | null }).__thirdlightObserve?.()?.camera ?? null) as Cam | null);
    await expect.poll(async () => (await read())?.live ?? null, { timeout: 60_000 }).toBe(follow);
    await expect.poll(async () => { const c = await read(); return c?.live === orbit && c.blend === null; }, { timeout: 120_000 }).toBe(true);
    const c = (await read())!;
    expect(near(c.position[1], d) && near(c.position[2], d), JSON.stringify(c.position)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});

// ---- editor --------------------------------------------------------------------------

type Grip = { component: string; kind: string; handle: string; x: number; y: number };
const view = (page: Page): Locator => page.locator('canvas[data-size-handles]');
async function grip(page: Page, component: string, kind: string, handle: string): Promise<Grip> {
  const find = async (): Promise<Grip | undefined> => (JSON.parse((await view(page).getAttribute('data-size-handles')) ?? '[]') as Grip[]).find((g) => g.component === component && g.kind === kind && g.handle === handle);
  await expect.poll(async () => (await find()) !== undefined, { message: `${component} ${kind} ${handle}` }).toBe(true);
  let last = '';
  await expect
    .poll(async () => {
      const g = await find();
      const now = g === undefined ? '' : `${Math.round(g.x)},${Math.round(g.y)}`;
      const same = now !== '' && now === last;
      last = now;
      return same;
    }, { intervals: [200] })
    .toBe(true);
  return (await find())!;
}
async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await page.mouse.up();
}
async function undo(page: Page): Promise<void> {
  await view(page).hover();
  await page.keyboard.press('Control+z');
}
async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
  await page.keyboard.press('f');
}

test('editor: a virtual camera from "+ Add component", its Inspector fields, its Scene preview, and the orbit point and camera path handles', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('cameras-editor-e2e');
  const target = await create('Target', [2, 0.5, -3], { box: { size: [1, 1, 1], material: { color: '#cc4444' } } }, 'box');
  const shotId = await create('Shot', [0, 3, 8]);
  const track = await create('Track', [-3, 2, 0]);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const inspector = page.locator('.tl-inspector');

  // "+ Add component" → Virtual camera (follow): the add value is stored.
  await select(page, shotId);
  await inspector.getByLabel('add component', { exact: true }).selectOption({ label: 'Virtual camera: Follow / orbit' });
  await expect.poll(async () => comp(shotId, 'virtualCamera')).toEqual({ rig: 'follow' });
  await expect(inspector.getByLabel('virtualCamera component')).toBeVisible();

  // Target and distance in the Inspector.
  await inspector.getByLabel('virtualCamera target', { exact: true }).selectOption(target);
  await expect.poll(async () => (await comp(shotId, 'virtualCamera'))?.['target']).toBe(target);
  const distance = inspector.getByLabel('virtualCamera distance', { exact: true });
  await distance.fill('10');
  await distance.press('Enter');
  await expect.poll(async () => (await comp(shotId, 'virtualCamera'))?.['distance']).toBe(10);

  // The Scene view previews the pose the rig gives (the runtime's own maths): 10 m from the target, 20° above.
  const preview = async (): Promise<{ id: string; position: number[] } | null> => {
    const raw = await view(page).getAttribute('data-virtual-camera');
    return raw === null || raw === '' ? null : (JSON.parse(raw) as { id: string; position: number[] });
  };
  await expect
    .poll(async () => {
      const p = await preview();
      return p !== null && p.id === shotId && near(p.position[0], 2, 1e-6) && near(p.position[1], 0.5 + 10 * Math.sin((20 * Math.PI) / 180), 1e-6) && near(p.position[2], -3 + 10 * Math.cos((20 * Math.PI) / 180), 1e-6);
    }, { message: 'the follow preview' })
    .toBe(true);

  // Orbit a point: the rig in the Inspector, then a point; its handle drags (snapped) and one undo restores it.
  await inspector.getByLabel('virtualCamera rig', { exact: true }).selectOption({ label: 'Orbit a point' });
  await expect.poll(async () => (await comp(shotId, 'virtualCamera'))?.['rig']).toBe('orbitPoint');
  await cmd('setComponent', { entityId: shotId, component: 'virtualCamera', value: { point: [0, 0, 0] } });
  await expect.poll(async () => (await preview())?.position[1] ?? null).toBeCloseTo(10 * Math.sin((20 * Math.PI) / 180), 6);
  await drag(page, await grip(page, 'virtualCamera', 'point', 'point'), 60, 0);
  await expect.poll(async () => ((await comp(shotId, 'virtualCamera'))?.['point'] as number[] | undefined)?.[0] ?? 0).toBeGreaterThan(0.2);
  const moved = (await comp(shotId, 'virtualCamera'))!['point'] as number[];
  expect(Math.abs(moved[0]! / 0.25 - Math.round(moved[0]! / 0.25))).toBeLessThan(1e-6);
  // The preview follows the point.
  await expect.poll(async () => (await preview())?.position[0] ?? null).toBeCloseTo(moved[0]!, 6);
  await undo(page);
  await expect.poll(async () => (await comp(shotId, 'virtualCamera'))?.['point']).toEqual([0, 0, 0]);

  // A camera path: "+ Add component" → Camera path; its last point drags and one undo restores it.
  await select(page, track);
  await inspector.getByLabel('add component', { exact: true }).selectOption({ label: 'Camera path' });
  await expect.poll(async () => comp(track, 'cameraPath')).toEqual({ points: [[0, 0, 0], [6, 0, 0]] });
  // (A shorter path keeps its end point in the framed view.)
  await cmd('setComponent', { entityId: track, component: 'cameraPath', value: { points: [[0, 0, 0], [2, 0, 0]] } });
  await drag(page, await grip(page, 'cameraPath', 'path', 'p1'), 0, -60);
  await expect.poll(async () => (((await comp(track, 'cameraPath'))?.['points'] as number[][] | undefined)?.[1]?.[1] ?? 0)).toBeGreaterThan(0.2);
  await undo(page);
  await expect.poll(async () => (await comp(track, 'cameraPath'))?.['points']).toEqual([[0, 0, 0], [2, 0, 0]]);
  // A rail camera picks the path by the objects that carry one.
  await select(page, shotId);
  await inspector.getByLabel('virtualCamera rig', { exact: true }).selectOption({ label: 'Rail (path)' });
  const pathPick = inspector.getByLabel('virtualCamera path', { exact: true });
  await expect(pathPick.locator('option', { hasText: 'Track' })).toHaveCount(1);
  await expect(pathPick.locator('option', { hasText: 'Target' })).toHaveCount(0);
  await pathPick.selectOption(track);
  await expect.poll(async () => (await comp(shotId, 'virtualCamera'))?.['path']).toBe(track);
});
