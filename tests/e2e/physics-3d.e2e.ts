/**
 * Phase 23.0: a 3D project (physics_dimension 3) on the Rapier 3D backend,
 * against a real backend. A neutral scene built through the backend's
 * commands on a blank project — a floor box with a depth (`hz`) and a player
 * capsule 3 m above it, off the origin in x and z — is switched to 3D in the
 * project settings form. In Play (the simulation worker, and the page's main
 * thread with ?threads=off) the capsule falls and rests on the box, observed
 * through tl_game_observe's relay (state "scene": no game block); the static
 * export, served with the backend stopped, ships the separate 3D backend
 * script (the 2D worker does not carry it) and lands the capsule the same way,
 * read through the export's observation (`window.__thirdlightObserve`).
 * A 2D scene-mode play would leave the capsule where it was placed.
 */
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

const START: [number, number, number] = [0.5, 3, -1.5];
/** Resting on the floor's top (y = 0): the default capsule's origin 0.9 m up (half of 1.8 m), plus the controller's 1 cm skin at most. */
const REST = { min: 0.899, max: 0.92 };

type Observation = { state: string; stepIndex?: number; player?: { x: number; y: number; z: number }; simulation?: { mode: string } };

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} })).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-physics3d' }, args });
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

/** The neutral 3D scene: a 10 × 1 × 10 m floor box with depth, a player capsule above it. */
async function buildScene(): Promise<{ floor: string; player: string }> {
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Floor', transform: { position: [0, -0.5, 0] }, box: { size: [10, 1, 10], material: { color: '#8a8f98' } }, components: { collider: { shape: { type: 'box', hx: 5, hy: 0.5, hz: 5 } } } });
  await cmd('createEntity', { parentId: null, kind: 'group', name: 'Player', transform: { position: START } });
  const q = (await be!.command({ op: 'queryEntities', projectId: be!.projectId, args: { limit: 100, offset: 0 } })) as { entities: { id: string; name?: string }[] };
  const floor = q.entities.find((e) => e.name === 'Floor')!.id;
  const player = q.entities.find((e) => e.name === 'Player')!.id;
  await cmd('setComponent', { entityId: player, component: 'controller', value: {} });
  return { floor, player };
}

async function startPlay(page: Page, query = ''): Promise<string> {
  const url = query === '' ? be!.editorUrl : be!.editorUrl.replace('#', `${be!.editorUrl.split('#')[0]!.includes('?') ? '&' : '?'}${query}#`);
  await page.goto(url);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  return psid;
}

/** Poll an observation until the player rests (two reads apart unchanged, on the floor). */
async function expectLanded(read: () => Promise<Observation | null>, what: string): Promise<Observation> {
  let last: Observation | null = null;
  await expect
    .poll(
      async () => {
        const o = await read();
        const settled = o?.player !== undefined && last?.player !== undefined && o.player.y === last.player.y && (o.stepIndex ?? 0) > (last.stepIndex ?? 0);
        last = o;
        return settled ? o!.player!.y : null;
      },
      { timeout: 60_000, intervals: [250], message: `${what}: the capsule comes to rest` },
    )
    .not.toBeNull();
  const o = last!;
  expect(o.state, what).toBe('scene');
  expect(o.player!.y, `${what}: resting on the floor's top`).toBeGreaterThan(REST.min);
  expect(o.player!.y, `${what}: resting on the floor's top`).toBeLessThan(REST.max);
  // It fell straight down: x and z kept (within Rapier's f32 rounding).
  expect(Math.abs(o.player!.x - START[0]), what).toBeLessThan(1e-4);
  expect(Math.abs(o.player!.z - START[2]), what).toBeLessThan(1e-4);
  return o;
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

test('a 3D project: the capsule lands on the box in Play (worker and main thread) and in the static export', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('physics3d-e2e');
  const { floor } = await buildScene();

  // The box's depth is an Inspector field; the dimension is a project setting in the settings form.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${floor}"]`).click();
  await expect(page.getByLabel('collider shape hz', { exact: true })).toHaveValue('5');
  await page.getByRole('tab', { name: 'Gameplay' }).click();
  await page.locator('.tl-gameplay__tabs').getByRole('button', { name: 'settings', exact: true }).click();
  const field = page.getByLabel('gameplay settings').getByLabel('settings physics_dimension', { exact: true });
  await expect(field).toHaveValue('2');
  await expect(field.locator('option')).toHaveText(['2D plane', '3D']);
  // Stored as the project's setting (one setSettings through the backend, written to content.json).
  const stored = (): unknown => (JSON.parse(readFileSync(join(be!.projectDir, 'content.json'), 'utf8')) as { content: { settings: Record<string, unknown> } }).content.settings['physics_dimension'];
  expect(stored()).toBeUndefined();
  await field.selectOption('3');
  await expect.poll(stored).toBe(3);
  await expect(field).toHaveValue('3');

  // Play in the simulation worker (the default), then on the page's main thread.
  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  for (const [query, mode] of [['', 'worker'], ['threads=off', 'single']] as const) {
    const psid = await startPlay(page, query);
    const read = async (): Promise<Observation | null> => {
      const r = await relay(`${psid}/observe`, {});
      return r.status === 200 ? (r.json as unknown as Observation) : null;
    };
    const o = await expectLanded(read, `Play (${mode})`);
    expect(o.simulation?.mode).toBe(mode);
  }
  expect(logs.filter((l) => /physics init failed|could not be loaded/.test(l))).toEqual([]);

  // The static export with the backend stopped: the 3D backend ships as its own script, the 2D worker does not carry it.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const dir = join(be.exportRoot, String(res.json.outputDir));
  expect(existsSync(join(dir, 'js', 'physics-3d.js'))).toBe(true);
  expect(readFileSync(join(dir, 'js', 'sim-worker.js'), 'utf8').includes('rapier3d-compat')).toBe(false);
  expect(readFileSync(join(dir, 'js', 'main.js'), 'utf8').includes('rapier3d-compat')).toBe(false);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { licenses: { id: string; version: string }[]; dependencies: { runtime: { modules: string[] } } };
  expect(meta.licenses).toContainEqual(expect.objectContaining({ id: '@dimforge/rapier3d-compat', version: '0.20.0' }));
  expect(meta.dependencies.runtime.modules).toContain('thirdlight.physics-rapier:3d');
  const site = await serveDir(dir);
  try {
    for (const [query, mode] of [['', 'worker'], ['?threads=off', 'single']] as const) {
      const game = await page.context().newPage();
      const errors: string[] = [];
      game.on('pageerror', (e) => errors.push(e.message));
      const requests: string[] = [];
      game.on('request', (r) => requests.push(r.url()));
      try {
        await game.goto(`${site.url}${query}`);
        await expect.poll(() => game.evaluate(() => ((window as unknown as { __thirdlightThreading?: { mode: string } }).__thirdlightThreading ?? null)?.mode ?? null), { timeout: 30_000 }).toBe(mode);
        await expectLanded(() => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null), `export (${mode})`);
        expect(errors).toEqual([]);
        expect(requests.every((u) => u.startsWith(site.url))).toBe(true);
        expect(requests.some((u) => u.endsWith('/js/physics-3d.js'))).toBe(true);
      } finally {
        await game.close();
      }
    }
  } finally {
    await site.close();
  }
});
