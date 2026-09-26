/**
 * Phase 23.1: 3D colliders from a model's `_COL` node, a 3D trigger, a
 * mover carrying the player, and the Scene handle of a new 3D shape — in a
 * real browser against a real backend, then in the static export with the
 * backend stopped.
 *
 * A neutral single-piece GLB (a 2 × 0.5 × 2 m pad with its `_COL` box) is
 * imported and dragged into a 3D project's Scene view: the drop gives the
 * model a triangle-mesh collider from the `_COL` node. "Convex hull from
 * model" in the Inspector turns it into a convex hull (a mover may not carry
 * a mesh), and the pad becomes a mover waiting for the signal "landed". A
 * thin box trigger just above the pad's top sends "landed" as the player's
 * capsule lands on it; the pad then slides 3 m along +x carrying the player.
 * In Play (the simulation worker) and in the export the observed player
 * ends 3 m further on, resting on the pad's top — which only happens when
 * the capsule lands on the `_COL` hull, the trigger fires in 3D and the
 * mover carries it. A separate object gets "Collider: Sphere" from the
 * Inspector's add menu (a 3D preset) and its radius is dragged in the Scene
 * view (snapped, one command).
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';

let be: E2EBackend | null = null;
let dir: string;
test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tl-e2e-p3d-'));
});
test.afterEach(async () => {
  await be?.stop();
  be = null;
  rmSync(dir, { recursive: true, force: true });
});

type Observation = { state: string; stepIndex?: number; player?: { x: number; y: number; z: number } };
type Ent = { id: string; name?: string; components: Record<string, Record<string, unknown> | undefined> };

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} })).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-physics3d-colliders' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
async function entities(): Promise<Ent[]> {
  return (await be!.command({ op: 'queryEntities', projectId: be!.projectId, args: { limit: 200, offset: 0 } }))['entities'] as Ent[];
}
async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await be!.command({ op: 'queryEntity', projectId: be!.projectId, args: { entityId: id } });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
}
async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/play/${path}`, { method: 'POST', headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

// ---- Scene-view handles (the handles e2e's helpers) ----
type Grip = { component: string; kind: string; handle: string; role: string; x: number; y: number };
const view = (page: Page) => page.locator('canvas[data-size-handles]');
async function grip(page: Page, component: string, kind: string, handle: string): Promise<Grip> {
  const find = async (): Promise<Grip | undefined> => (JSON.parse((await view(page).getAttribute('data-size-handles')) ?? '[]') as Grip[]).find((g) => g.component === component && g.kind === kind && g.handle === handle);
  await expect.poll(async () => (await find()) !== undefined, { message: `${component} ${kind} ${handle}` }).toBe(true);
  let last = '';
  await expect
    .poll(
      async () => {
        const g = await find();
        const now = g === undefined ? '' : `${Math.round(g.x)},${Math.round(g.y)}`;
        const same = now !== '' && now === last;
        last = now;
        return same;
      },
      { message: `${component} ${kind} ${handle} settled`, intervals: [200] },
    )
    .toBe(true);
  return (await find())!;
}
async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + (dx * i) / 8, from.y + (dy * i) / 8);
  await page.mouse.up();
}
async function selectAndFocus(page: Page, id: string): Promise<void> {
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', id);
  await page.keyboard.press('f');
  const box = (await view(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(30);
  }
}
const snapped = (v: number, step = 0.05): boolean => Math.abs(v / step - Math.round(v / step)) < 1e-6;

function serveDir(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary' };
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
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/**
 * The player rides the pad 3 m along +x from x = 1 and rests on its top (y = 0.5): origin 0.9 m up
 * (half the 1.8 m capsule), plus the skin. The trigger may see the capsule a step or two before it
 * touches down (the pad has then moved up to 2 cm under it), so x ends within 3 cm short of 4.
 */
async function expectCarried(read: () => Promise<Observation | null>, what: string): Promise<void> {
  // At rest: the same x at two reads whose step indexes differ (the simulation ran on in between).
  let last: Observation | null = null;
  await expect
    .poll(
      async () => {
        const o = await read();
        const x = o?.player?.x ?? null;
        const still = x !== null && x > 3.9 && last?.player?.x === x && (o!.stepIndex ?? 0) > (last.stepIndex ?? 0);
        last = o;
        return still ? x : null;
      },
      { timeout: 60_000, intervals: [250], message: `${what}: the pad carried the player 3 m and stopped` },
    )
    .not.toBeNull();
  const o = (await read())!;
  expect(o.state, what).toBe('scene');
  expect(o.player!.x, what).toBeGreaterThan(3.97);
  expect(o.player!.x, what).toBeLessThan(4.001);
  expect(Math.abs(o.player!.z), what).toBeLessThan(1e-3);
  expect(o.player!.y, `${what}: resting on the pad's top`).toBeGreaterThan(1.4 - 1e-3);
  expect(o.player!.y, `${what}: resting on the pad's top`).toBeLessThan(1.42);
}

test('3D: a `_COL` node becomes a mesh then a convex collider; a 3D trigger starts a mover that carries the player (Play and export); a sphere collider\'s Scene handle', async ({ page }) => {
  test.setTimeout(360_000);
  be = await startBackend('physics3d-colliders-e2e');
  await cmd('setSettings', { settings: { physics_dimension: 3 } });

  // Import the pad (one piece with its `_COL` box) and drag it into the Scene view.
  const file = join(dir, 'pad.glb');
  writeFileSync(file, multiPieceGlb([{ name: 'pad', lods: [[2, 0.5, 2]], col: [2, 0.5, 2] }]));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Assets' }).click();
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const tile = page.locator('.tl-assets__list li[data-asset-id]:not([data-piece])').first();
  await expect(tile).toBeVisible({ timeout: 10_000 });
  await tile.dragTo(page.locator('canvas.tl-viewport'));
  await expect.poll(async () => (await entities()).filter((e) => e.components['model'] !== undefined).length, { timeout: 10_000 }).toBe(1);
  const pad = (await entities()).find((e) => e.components['model'] !== undefined)!;
  // The drop in a 3D project: the `_COL` box as a triangle mesh (8 corners, 12 triangles; the pad's pivot at its base's left edge).
  const mesh = pad.components['collider']!['shape'] as { type: string; vertices: number[][]; triangles: number[][] };
  expect(mesh.type).toBe('mesh');
  expect(mesh.vertices).toHaveLength(8);
  expect(mesh.triangles).toHaveLength(12);
  expect(mesh.vertices).toContainEqual([2, 0.5, 1]);
  const at = (pad.components['transform'] as { position: number[] }).position;
  if (at.some((v) => v !== 0)) await cmd('setTransform', { entityId: pad.id, transform: { position: [0, 0, 0] } });

  // "Convex hull from model" (the Inspector): the same box as a hull of its 8 corners.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${pad.id}"]`).click();
  await page.getByRole('button', { name: 'Convex hull from model', exact: true }).click();
  await expect.poll(async () => ((await comp(pad.id, 'collider'))?.['shape'] as { type?: string } | undefined)?.type).toBe('convex');
  expect(((await comp(pad.id, 'collider'))!['shape'] as { points: number[][] }).points).toHaveLength(8);

  // The pad waits for "landed", then slides 3 m along +x; the trigger sits just above its top; the player 2.5 m over it.
  await cmd('setComponent', { entityId: pad.id, component: 'mover', value: { waypoints: [[3, 0, 0]], speed: 1, mode: 'once', startOn: 'landed' } });
  await cmd('createEntity', { parentId: null, kind: 'group', name: 'Landing', transform: { position: [1, 0.53, 0] }, components: { trigger: { size: [1, 0.06, 1], signal: 'landed', once: true } } });
  const player = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Player', transform: { position: [1, 3, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });

  // A new 3D shape's Scene handle: "Collider: Sphere" from the add menu, then drag its radius.
  const ball = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Ball', transform: { position: [-4, 3, 0] } }))['createdId']);
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await selectAndFocus(page, ball);
  const add = page.locator('.tl-inspector').getByLabel('add component', { exact: true });
  await expect(add.locator('option', { hasText: 'Collider: Polygon' })).toHaveCount(0);
  await add.selectOption({ label: 'Collider: Sphere' });
  await expect.poll(async () => (await comp(ball, 'collider'))?.['shape']).toEqual({ type: 'sphere', radius: 0.5 });
  await drag(page, await grip(page, 'collider', 'radius', 'side'), 60, 0);
  await expect.poll(async () => ((await comp(ball, 'collider'))!['shape'] as { radius: number }).radius).toBeGreaterThan(0.55);
  expect(snapped(((await comp(ball, 'collider'))!['shape'] as { radius: number }).radius)).toBe(true);

  // Play (the simulation worker): the player lands on the hull, "landed" fires, the pad carries it.
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  await expectCarried(async () => {
    const r = await relay(`${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  }, 'Play');

  // The static export with the backend stopped: the same ride.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json.outputDir)));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    await expectCarried(() => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null), 'export');
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});
