/**
 * Phase 14.1: a script spawns prefab copies into the running game, against a
 * real backend. On the engine sample (Beacon Reach) a neutral "Projectile"
 * prefab is made by command from a small magenta box carrying its own script
 * (it owns "@self", flies right and counts "flown" 3 m out), and a script on
 * the player spawns one every second
 * beside the player, keeps the last three and destroys the older ones. In
 * Play the observation lists the live spawned entities (`spawn-<n>`), the
 * shot counter climbs while at most four are alive, and the projectiles are
 * seen as magenta pixels; the project never gains them. The export, served
 * statically with the backend stopped, spawns them too.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('spawn-e2e', 'beacon-reach');
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
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-spawn' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** Publish a behavior with this source and attach it to `entityId` (default: the player). */
async function script(behaviorId: string, source: string, ownedTransforms: string[] = [], entityId?: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms, files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [{ key: 'every', label: 'Seconds between shots', type: 'number', default: 1, min: 0.1, max: 10, step: 0.1 }] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${createHash('sha256').update(behaviorId).digest('hex').slice(0, 32)}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  const game = await query('queryGameConfig');
  await cmd('setBehaviorProperties', { entityId: entityId ?? String((game.game as { playerId: string }).playerId), behaviorId, values: { every: 1 } });
}

/** One projectile every `every` seconds (120 steps per second) beside the player; the last three stay. */
const SHOOTER = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return { shots: [] as string[] }; },',
  '  step(state: { shots: string[] }, ctx: any) {',
  '    const period = Math.max(1, Math.round(ctx.properties.every * 120));',
  '    if (ctx.stepIndex % period !== 0) return;',
  '    const me = ctx.world.transform(ctx.entityId);',
  '    if (me === undefined) return;',
  "    const id = ctx.spawn('projectile', { position: [me.position[0] + 1, me.position[1] + 0.8] });",
  '    if (id === null) return;',
  "    ctx.game.add('shots', 1);",
  '    state.shots.push(id);',
  '    if (state.shots.length > 3) ctx.destroy(state.shots.shift());',
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

/**
 * The projectile's own script: it owns its own transform ("@self") and flies
 * right at 4 m/s; once 3 m from where it appeared it counts "flown" (once).
 */
const BOLT = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return { x0: null as number | null, done: false }; },',
  '  step(state: { x0: number | null; done: boolean }, ctx: any) {',
  "    if (ctx.phase !== 'transform') return;",
  '    const me = ctx.world.transform(ctx.entityId);',
  '    if (me === undefined) return;',
  '    if (state.x0 === null) state.x0 = me.position[0];',
  "    ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: me.position[0] + 4 / 120 } });",
  "    if (!state.done && me.position[0] - state.x0 > 3) { state.done = true; ctx.game.add('flown', 1); }",
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

/** Pixels that are clearly magenta, lit or not (the projectile colour; nothing else in the sample is). */
async function magenta(target: Page | Locator): Promise<number> {
  const img = decodePng(await target.screenshot());
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 110 && b > 100 && g < 50) n += 1;
    }
  }
  return n;
}

test('a script spawns a projectile every second in Play (and in the export); old ones are destroyed', async ({ page }) => {
  test.setTimeout(300_000);
  // The prefab: a small magenta box whose own script flies it to the right (made far below the level).
  const made = await cmd('createEntity', { kind: 'box', name: 'Projectile', transform: { position: [0, -40, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#ff00ff' } } });
  const sourceId = String(made.createdId);
  await script('behavior-bolt', BOLT, ['@self'], sourceId);
  await cmd('createPrefab', { prefabId: 'projectile', displayName: 'Projectile', sourceEntityId: sourceId });
  const def = (await query('queryPrefabs', { prefabId: 'projectile', includeEntities: true })) as { prefabs?: { entities: { components: Record<string, unknown> }[] }[] };
  expect(def.prefabs?.[0]?.entities[0]?.components['behavior']).toMatchObject({ behaviorId: 'behavior-bolt' });
  await cmd('deleteEntity', { entityId: sourceId });
  await script('behavior-shooter', SHOOTER);
  const entitiesBefore = ((await query('queryEntities', { limit: 500, offset: 0 })).entities as unknown[]).length;

  // Play.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number>; spawned?: { count: number; ids: string[] } };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('awaitingStart');
  const frame = page.locator('iframe.tl-app__preview-frame');
  const before = await magenta(frame);
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(async () => (await observe()).state).toBe('playing');

  // The shots come once a (simulated) second; at most three stay, plus one on its way out.
  await expect.poll(async () => (await observe()).counters?.['shots'] ?? 0, { timeout: 90_000 }).toBeGreaterThanOrEqual(5);
  // Each projectile moved itself: its own script counted it 3 m away from where it appeared.
  expect((await observe()).counters?.['flown'] ?? 0).toBeGreaterThanOrEqual(3);
  const o = await observe();
  expect(o.spawned!.count).toBeGreaterThanOrEqual(3);
  expect(o.spawned!.count).toBeLessThanOrEqual(4);
  for (const id of o.spawned!.ids) expect(id).toMatch(/^spawn-\d+$/);
  // The oldest ones went: the live ids are the newest.
  const numbers = o.spawned!.ids.map((id) => Number(id.slice('spawn-'.length)));
  expect(Math.min(...numbers)).toBeGreaterThanOrEqual((o.counters!['shots'] ?? 0) - 4);
  // Seen: magenta projectiles beside the player.
  await expect.poll(async () => magenta(frame), { timeout: 20_000 }).toBeGreaterThan(before + 20);
  await page.screenshot({ path: 'test-results/spawn-play.png' });
  // The project never gains them.
  expect(((await query('queryEntities', { limit: 500, offset: 0 })).entities as unknown[]).length).toBe(entitiesBefore);
  await page.getByTitle('Stop the play preview').click();

  // The export spawns them too, served statically with the backend stopped.
  const exported = await be.admin(`projects/${be.projectId}/export`);
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
  const dir = join(be.exportRoot, String(exported.json.outputDir));
  await be.halt();
  const server = createServer((req, reply) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      reply.statusCode = 404;
      reply.end();
      return;
    }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
    reply.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(reply);
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const errors: string[] = [];
  const game = await page.context().newPage();
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(url);
    await expect(game.locator('#hud-root')).toContainText('to start', { timeout: 30_000 });
    await game.locator('canvas#game').click();
    await game.keyboard.press('Enter');
    await expect(game.locator('#hud-root')).toContainText('to jump', { timeout: 30_000 });
    // Once the run is live the shots come; one is always beside the player.
    let seen = 0;
    await expect.poll(async () => (seen = await magenta(game)), { timeout: 60_000 }).toBeGreaterThan(20);
    await game.screenshot({ path: 'test-results/spawn-export.png' });
    console.log(`export magenta pixels: ${seen}`);
    expect(errors).toEqual([]);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
