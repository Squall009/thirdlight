/**
 * The 3D kinematic character controller in a real browser
 * against a real backend. A neutral 3D scene built through the backend's
 * commands on a blank project — a floor, a 0.3 m riser to the right of the
 * player, a wall to its left — played without its own input actions (the 3D
 * defaults: W/A/S/D and the arrows move, Shift runs):
 *
 * - Play (the simulation worker): holding D walks the character right up onto
 *   the riser (the default 0.3 m step-up), holding A walks it back down and
 *   into the wall, which stops it; a `tl_input_exercise` relay with the move
 *   vector's forward axis (the move action's y) walks it along −Z (world axes: no camera
 *   rig yet) — positions read through tl_game_observe;
 * - the static export, with the backend stopped: D walks it up the riser too
 *   (read through `window.__thirdlightObserve`);
 * - Inspector and Scene handles: in a 3D project the controller shows its 3D
 *   settings (the 2D plane's autostep hidden), the step-up height is edited
 *   in the Inspector and dragged with its handle above the capsule's feet,
 *   one undo each; a 2D project shows neither.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend, controls } from './backend';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

/** The capsule origin standing on the floor's top (y = 0): half the 1.8 m capsule. */
const STAND = 0.9;
type Observation = { state: string; stepIndex?: number; player?: { x: number; y: number; z: number } };

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} })).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-character3d' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function block(name: string, center: number[], half: number[]): Promise<void> {
  await cmd('createEntity', { parentId: null, kind: 'box', name, transform: { position: center }, box: { size: half.map((h) => h * 2), material: { color: '#8a8f98' } }, components: { collider: { shape: { type: 'box', hx: half[0], hy: half[1], hz: half[2] } } } });
}

async function player(): Promise<string> {
  await cmd('createEntity', { parentId: null, kind: 'group', name: 'Player', transform: { position: [0, STAND + 0.01, 0] } });
  const q = (await be!.command({ op: 'queryEntities', projectId: be!.projectId, args: { limit: 100, offset: 0 } })) as { entities: { id: string; name?: string }[] };
  const id = q.entities.find((e) => e.name === 'Player')!.id;
  await cmd('setComponent', { entityId: id, component: 'controller', value: {} });
  return id;
}

/** Floor, a 0.3 m riser from x = 2, a wall whose face is at x = −3; the player at the origin; 3D. */
async function buildScene(): Promise<void> {
  await block('Floor', [0, -0.5, 0], [10, 0.5, 10]);
  await block('Riser', [3, 0.15, 0], [1, 0.15, 4]);
  await block('Wall', [-3.25, 1, 0], [0.25, 1, 4]);
  await player();
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
}

async function startPlay(page: Page): Promise<string> {
  await page.goto(be!.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  return psid;
}

/** Poll until the player is at rest (two reads with later steps give the same position). */
async function rest(read: () => Promise<Observation | null>, what: string): Promise<{ x: number; y: number; z: number }> {
  let last: Observation | null = null;
  await expect
    .poll(
      async () => {
        const o = await read();
        const same = o?.player !== undefined && last?.player !== undefined && o.player.x === last.player.x && o.player.y === last.player.y && o.player.z === last.player.z && (o.stepIndex ?? 0) > (last.stepIndex ?? 0);
        last = o;
        return same;
      },
      { timeout: 60_000, intervals: [250], message: `${what}: at rest` },
    )
    .toBe(true);
  return last!.player!;
}

/** Hold a key until the observed player passes `until` (then release and let it stop). */
async function holdUntil(page: Page, key: string, read: () => Promise<Observation | null>, until: (p: { x: number; y: number; z: number }) => boolean, what: string): Promise<void> {
  await page.keyboard.down(key);
  try {
    await expect.poll(async () => {
      const o = await read();
      return o?.player !== undefined && until(o.player);
    }, { timeout: 30_000, intervals: [100], message: what }).toBe(true);
  } finally {
    await page.keyboard.up(key);
  }
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

test('3D character: keyboard walks it up a riser and into a wall in Play, tl_input_exercise walks it forward, the export walks it too', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('character3d-e2e');
  await buildScene();

  const psid = await startPlay(page);
  const read = async (): Promise<Observation | null> => {
    const r = await relay(`${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  const start = await rest(read, 'Play start');
  expect(Math.abs(start.x)).toBeLessThan(1e-3);
  expect(start.y).toBeGreaterThan(STAND - 0.01);
  expect(start.y).toBeLessThan(STAND + 0.03);

  // A click in the game focuses it; D walks right, up the 0.3 m riser (its face at x = 2).
  await page.locator('iframe.tl-app__preview-frame').click();
  await holdUntil(page, 'd', read, (p) => p.x > 2.5, 'D walks onto the riser');
  const up = await rest(read, 'on the riser');
  expect(up.y, 'standing on the riser (0.3 m up)').toBeGreaterThan(0.3 + STAND - 0.01);
  expect(up.y).toBeLessThan(0.3 + STAND + 0.03);
  expect(Math.abs(up.z)).toBeLessThan(0.01);

  // A walks back down and into the wall (its face at x = −3: the capsule's 0.3 m radius off it), which stops it.
  await page.keyboard.down('a');
  try {
    let lastX = Infinity;
    let lastStep = -1;
    await expect.poll(async () => {
      const o = await read();
      const p = o?.player;
      const step = o?.stepIndex ?? -1;
      // Stopped: steps ran since the last read (a loaded host may run none) and x did not change.
      const stopped = p !== undefined && p.x < -2 && step > lastStep + 10 && Math.abs(p.x - lastX) < 1e-4;
      lastX = p?.x ?? Infinity;
      lastStep = step;
      return stopped;
    }, { timeout: 30_000, intervals: [250], message: 'A walks into the wall and stops' }).toBe(true);
  } finally {
    await page.keyboard.up('a');
  }
  const wall = await rest(read, 'at the wall');
  expect(wall.x).toBeGreaterThan(-2.75);
  expect(wall.x).toBeLessThan(-2.6);
  expect(wall.y, 'back on the floor').toBeLessThan(STAND + 0.03);

  // tl_input_exercise: 120 steps of the move vector's forward axis (the move action's y) — along −Z at world axes (1 s at 2 m/s).
  const frames = Array.from({ length: 120 }, (_, k) => ({ stepOffset: k, ...controls(0, 'none', 1) }));
  const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const fwd = await rest(read, 'after the input exercise');
  expect(fwd.z).toBeLessThan(wall.z - 1.6);
  expect(fwd.z).toBeGreaterThan(wall.z - 2.1);
  expect(Math.abs(fwd.x - wall.x)).toBeLessThan(0.02);

  // The static export with the backend stopped: D walks it up the riser.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    const observe = (): Promise<Observation | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null);
    const at = await rest(observe, 'export start');
    expect(Math.abs(at.x)).toBeLessThan(1e-3);
    const vp = game.viewportSize()!;
    await game.mouse.click(vp.width / 2, vp.height / 2);
    await holdUntil(game, 'd', observe, (p) => p.x > 2.5, 'export: D walks onto the riser');
    const top = await rest(observe, 'export: on the riser');
    expect(top.y).toBeGreaterThan(0.3 + STAND - 0.01);
    expect(top.y).toBeLessThan(0.3 + STAND + 0.03);
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});

test('3D character settings: Inspector fields and the step-up height handle (3D only)', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('character3d-inspector-e2e');
  await block('Floor', [0, -0.5, 0], [10, 0.5, 10]);
  const id = await player();
  const controller = async (): Promise<Record<string, unknown>> => {
    const q = await be!.command({ op: 'queryEntity', projectId: be!.projectId, args: { entityId: id } });
    return (q['entity'] as { components: Record<string, Record<string, unknown>> }).components['controller']!;
  };
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Player');
  // A 2D plane: the autostep, no 3D settings.
  await expect(page.getByLabel('controller autostep', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('controller stepHeight', { exact: true })).toHaveCount(0);

  // 3D: the 3D settings with their defaults, the autostep hidden.
  await cmd('setSettings', { settings: { physics_dimension: 3 } });
  const step = page.getByLabel('controller stepHeight', { exact: true });
  await expect(step).toHaveValue('0.3', { timeout: 30_000 });
  await expect(page.getByLabel('controller autostep', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('controller walkSpeed', { exact: true })).toHaveValue('2');
  await expect(page.getByLabel('controller ledgeClimb', { exact: true })).toHaveCount(1);

  // Edit it in the Inspector: stored, one undo.
  await step.fill('0.5');
  await step.press('Enter');
  await expect.poll(async () => (await controller())['stepHeight']).toBe(0.5);
  const view = page.locator('canvas[data-size-handles]');
  await view.hover();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await controller())['stepHeight']).toBeUndefined();
  await expect(step).toHaveValue('0.3');

  // The Scene handle: a grip 0.3 m above the capsule's feet; dragging it up raises the step-up height (snapped to 5 cm).
  await page.keyboard.press('f');
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(30);
  }
  type Grip = { component: string; kind: string; handle: string; x: number; y: number };
  const grips = async (): Promise<Grip[]> => JSON.parse((await view.getAttribute('data-size-handles')) ?? '[]') as Grip[];
  const find = async (kind: string, handle: string): Promise<Grip | undefined> => (await grips()).find((g) => g.component === 'controller' && g.kind === kind && g.handle === handle);
  await expect.poll(async () => (await find('height', 'height')) !== undefined, { message: 'the step-up handle' }).toBe(true);
  await page.waitForTimeout(400);
  const top = (await find('capsule', 'top'))!;
  const grip = (await find('height', 'height'))!;
  // The capsule's top is 1.8 m above its feet, the step-up grip 0.3 m: pixels per metre along Y.
  const side = (await find('capsule', 'side'))!;
  const perMetre = (side.y - top.y) / 0.9;
  expect(perMetre).toBeGreaterThan(20);
  // (perspective: the pixels per metre differ a little along the capsule)
  expect(Math.abs((grip.y - side.y) / perMetre - (0.9 - 0.3))).toBeLessThan(0.2);
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(grip.x, grip.y - (i / 8) * 0.25 * perMetre);
  await page.mouse.up();
  await expect.poll(async () => ((await controller())['stepHeight'] as number | undefined) ?? 0).toBeGreaterThan(0.4);
  const dragged = (await controller())['stepHeight'] as number;
  expect(dragged).toBeLessThan(0.7);
  expect(Math.abs(dragged / 0.05 - Math.round(dragged / 0.05))).toBeLessThan(1e-6);
  await expect(step).toHaveValue(String(dragged));
  await view.hover();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await controller())['stepHeight']).toBeUndefined();
});
