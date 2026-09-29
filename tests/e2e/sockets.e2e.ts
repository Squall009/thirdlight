/**
 * Phase 23.11: sockets and per-instance animation speed against a real
 * backend, with a neutral model built in the test (tests/e2e/socket-glb.ts:
 * a node `arm` that an animator slides 1 m/s along +X, its child `hand`).
 *
 * - Play (the simulation worker): a gem with a Socket component rides on
 *   `hand` (+0.25 m up) and follows the clip — its world position, read
 *   through tl_game_observe, is the table's plus the node's at the clip
 *   time; a script halves the table's playback speed at step 240 (the gem
 *   then moves at half the rate) and detaches the gem at step 760 (nothing
 *   rides on a socket afterwards).
 * - The static export with the backend stopped does the same
 *   (`window.__thirdlightObserve`).
 * - Editor: "+ Add component" → Socket picks the model object as its
 *   target; the Inspector lists the target model's nodes (read from the GLB)
 *   and the pick is stored; the Animator live preview plays at the speed set
 *   in it (its clip time advances at half the rate at ×0.5).
 */
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { socketGlb } from './socket-glb';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

const HZ = 120;
type SocketObs = { entityId: string; target: string; node: string; position: [number, number, number] };
type Observation = { state: string; stepIndex: number; sockets?: SocketObs[] };

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-sockets' }, args });
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

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return api(`play/${path}`, body);
}

async function comp(id: string, name: string): Promise<Record<string, unknown> | undefined> {
  const r = await query('queryEntity', { entityId: id });
  return (r['entity'] as { components: Record<string, Record<string, unknown>> }).components[name];
}

async function importModel(page: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'tl-socket-'));
  const file = join(dir, 'turntable.glb');
  writeFileSync(file, socketGlb());
  await page.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const assets = async (): Promise<{ assetId: string }[]> => ((await query('queryAssets', { limit: 10, offset: 0 }))['assets'] as { assetId: string }[]) ?? [];
  await expect.poll(async () => (await assets()).length, { timeout: 15_000 }).toBe(1);
  return (await assets())[0]!.assetId;
}

async function script(behaviorId: string, source: string, entityId: string, values: Record<string, unknown>): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json['stageId']);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: Object.keys(values).map((key) => ({ key, label: key, type: 'entityRef', default: null })) };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values });
}

/** Halves the table's playback speed at step 240 and lets the gem go at step 760 (keeping its world pose). */
const DIRECTOR = [
  'export default {',
  '  instantiate() { return {}; },',
  '  step(_state: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent' || ctx.sockets === undefined) return;",
  '    const p = ctx.properties;',
  '    if (ctx.stepIndex === 240) ctx.animator(p.table).setSpeed(0.5);',
  '    if (ctx.stepIndex === 760) ctx.sockets.detach(p.gem);',
  '  },',
  '};',
  '',
].join('\n');

const CONTROLLER = (assetId: string) => ({
  controllerId: 'ctl-slide',
  name: 'Slide',
  parameters: [],
  states: [{ id: 'st-slide', name: 'Slide', motion: { kind: 'clip', clip: { assetId, clip: 'slide', duration: 4 } }, speed: 1, loop: true }],
  transitions: [],
  entry: 'st-slide',
  events: [],
});

/** The slide's clip time after `step` steps: 1× until step 240, then 0.5×; the clip loops every 4 s. */
function clipTime(step: number): number {
  const t = step <= 240 ? step / HZ : 240 / HZ + (step - 240) / (2 * HZ);
  return t % 4;
}

/** Build the scene: the table (model + animator) at [−2, 0, 0], a gem on its `hand`, the director. */
async function buildScene(page: Page): Promise<{ table: string; gem: string }> {
  const assetId = await importModel(page);
  await cmd('setAnimator', { controller: CONTROLLER(assetId) });
  const table = String((await cmd('createEntity', { parentId: null, kind: 'model', name: 'Table', model: { asset: { assetId } }, transform: { position: [-2, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: table, component: 'animator', value: { controller: 'ctl-slide' } });
  const gem = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Gem', transform: { position: [4, 4, 4] }, box: { size: [0.2, 0.2, 0.2], material: { color: '#3366ff' } } }))['createdId']);
  await cmd('setComponent', { entityId: gem, component: 'socketAttach', value: { target: table, node: 'hand', position: [0, 0.25, 0] } });
  const director = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Director', transform: { position: [0, -5, 0] } }))['createdId']);
  await script('director', DIRECTOR, director, { table, gem });
  return { table, gem };
}

/** Samples of the gem's socket position with the step they were observed at, until `until` steps. */
async function sample(read: () => Promise<Observation | null>, gem: string, until: number): Promise<{ step: number; p: [number, number, number] | null }[]> {
  const out: { step: number; p: [number, number, number] | null }[] = [];
  const deadline = Date.now() + 180_000;
  let lastStep = -1;
  while (Date.now() < deadline) {
    const o = await read();
    if (o !== null && typeof o.stepIndex === 'number' && o.stepIndex > 0) {
      const g = o.sockets?.find((s) => s.entityId === gem);
      out.push({ step: o.stepIndex, p: g?.position ?? null });
      lastStep = o.stepIndex;
      if (o.stepIndex >= until) return out;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`the game did not reach step ${until} (last observed ${lastStep})`);
}

/** The gem follows the clip (x = −2 + clip time, y 0.75, z 0.5) at 1 m/s, then 0.5 m/s, and is let go after step 760. */
function checkSamples(samples: { step: number; p: [number, number, number] | null }[], what: string): void {
  let near = 0;
  for (const s of samples) {
    if (s.step < 20 || s.step > 755) continue;
    const t = clipTime(s.step);
    // Skip samples near the loop's wrap (the observed step and the drawn frame may straddle it).
    if (t < 0.05 || t > 3.95) continue;
    expect(s.p, `${what}: the gem rides at step ${s.step}`).not.toBeNull();
    // The observation's position is the drawn (interpolated) one: up to a step or two from the observed step.
    expect(Math.abs(s.p![0] - (-2 + t)), `${what}: x at step ${s.step}`).toBeLessThan(0.035);
    expect(s.p![1]).toBeCloseTo(0.75, 6);
    expect(s.p![2]).toBeCloseTo(0.5, 6);
    near += 1;
  }
  expect(near, `${what}: samples compared`).toBeGreaterThan(10);
  // The rate: two samples in one loop before the speed change and two after (dx per step: 1/120, then 1/240).
  const within = (a: number, b: number) => samples.filter((s) => s.p !== null && s.step >= a && s.step <= b);
  const rate = (list: { step: number; p: [number, number, number] | null }[]): number => {
    const first = list[0]!;
    const last = list[list.length - 1]!;
    return ((last.p![0] - first.p![0]) / (last.step - first.step)) * HZ;
  };
  const early = within(30, 230); // clip time 0.25–1.9 s
  const late = within(260, 700); // clip time 2.1–3.9 s, at half speed
  expect(early.length).toBeGreaterThan(3);
  expect(late.length).toBeGreaterThan(3);
  expect(Math.abs(rate(early) - 1), `${what}: 1 m/s before the speed change`).toBeLessThan(0.05);
  expect(Math.abs(rate(late) - 0.5), `${what}: 0.5 m/s after it`).toBeLessThan(0.03);
  // Detached at step 760: no socket reported afterwards.
  const after = samples.filter((s) => s.step > 765);
  expect(after.length).toBeGreaterThan(0);
  for (const s of after) expect(s.p, `${what}: let go at step ${s.step}`).toBeNull();
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

test('a socket follows an animated node in Play and the export; a script halves the clip rate and detaches it', async ({ page }) => {
  test.setTimeout(360_000);
  be = await startBackend('sockets-e2e');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const { table, gem } = await buildScene(page);

  // Play (the simulation worker by default).
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  const read = async (): Promise<Observation | null> => {
    const r = await relay(`${psid}/observe`, {});
    return r.status === 200 ? (r.json as unknown as Observation) : null;
  };
  const first = await read();
  expect(first?.sockets?.[0], JSON.stringify(first)).toMatchObject({ entityId: gem, target: table, node: 'hand' });
  checkSamples(await sample(read, gem, 820), 'Play');
  await page.getByTitle('Stop the play preview').click();

  // The static export with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  await be.halt();
  const site = await serveDir(join(be.exportRoot, String(res.json['outputDir'])));
  const game = await page.context().newPage();
  const errors: string[] = [];
  game.on('pageerror', (e) => errors.push(e.message));
  try {
    await game.goto(site.url);
    const observe = (): Promise<Observation | null> => game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? null) as Observation | null);
    await expect.poll(async () => (await observe())?.stepIndex ?? 0, { timeout: 60_000 }).toBeGreaterThan(0);
    checkSamples(await sample(observe, gem, 820), 'export');
    expect(errors).toEqual([]);
  } finally {
    await game.close();
    await site.close();
  }
});

test('editor: "+ Add component" → Socket, the Inspector node list from the model, and the Animator preview speed', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('sockets-editor-e2e');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const assetId = await importModel(page);
  await cmd('setAnimator', { controller: CONTROLLER(assetId) });
  const table = String((await cmd('createEntity', { parentId: null, kind: 'model', name: 'Table', model: { asset: { assetId } }, transform: { position: [0, 0, 0] } }))['createdId']);
  const lamp = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Lamp', transform: { position: [2, 1, 0] }, box: { size: [0.3, 0.3, 0.3], material: { color: '#ffcc00' } } }))['createdId']);
  const inspector = page.locator('.tl-inspector');

  // "+ Add component" → Socket: the target is the model object; the node starts as a placeholder.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${lamp}"]`).click();
  await expect(page.locator('.tl-hierarchy__list li.is-selected')).toHaveAttribute('data-entity-id', lamp);
  await inspector.getByLabel('add component', { exact: true }).selectOption({ label: 'Socket' });
  await inspector.getByLabel('socketAttach target', { exact: true }).selectOption(table);
  await inspector.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(async () => (await comp(lamp, 'socketAttach'))?.['target']).toBe(table);
  await expect(inspector.getByLabel('socketAttach component')).toBeVisible();

  // The node field lists the target model's nodes (read from the GLB); picking one stores it.
  const node = inspector.getByLabel('socketAttach node', { exact: true });
  await expect(node.locator('option')).toContainText(['base', 'arm', 'hand'], { timeout: 20_000 });
  await node.selectOption('hand');
  await expect.poll(async () => (await comp(lamp, 'socketAttach'))?.['node']).toBe('hand');
  await expect(node).toHaveValue('hand');
  // The offset is an ordinary Inspector field.
  const offsetY = inspector.getByLabel('socketAttach position y', { exact: true });
  await offsetY.fill('0.3');
  await offsetY.press('Enter');
  await expect.poll(async () => (await comp(lamp, 'socketAttach'))?.['position']).toEqual([0, 0.3, 0]);

  // The Animator's live preview at ×1 and ×0.5: the clip time advances at half the rate.
  await page.getByRole('tab', { name: 'Animator', exact: true }).click();
  await page.getByLabel('animator controllers').getByRole('button', { name: 'Slide' }).dblclick();
  const doc = page.getByRole('tabpanel', { name: 'Animator: Slide' });
  await doc.getByRole('button', { name: 'Preview', exact: true }).click();
  const preview = doc.getByLabel('animator preview', { exact: true });
  await expect(preview).toHaveAttribute('data-state', 'Slide', { timeout: 20_000 });
  const rateOf = async (): Promise<number> => {
    // Clip time over the preview's own stepped time (frame-rate independent), within one loop of the 4 s clip.
    const read = async (): Promise<[number, number]> => {
      // One snapshot of both attributes (they update together).
      const [c, e] = await preview.evaluate((el) => [Number(el.getAttribute('data-clip-time')), Number(el.getAttribute('data-elapsed'))]);
      return [c!, e!];
    };
    // The attributes are sampled every 100 ms, so the ones on the page when the
    // speed changes may predate it: start from a sample taken after it.
    const fresh = async (): Promise<[number, number]> => {
      const [, stale] = await read();
      await expect.poll(async () => (await read())[1], { timeout: 5_000 }).not.toBe(stale);
      return read();
    };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const [t0, e0] = await fresh();
      await page.waitForTimeout(800);
      const [t1, e1] = await read();
      if (t1 > t0 && e1 > e0 + 0.2) return (t1 - t0) / (e1 - e0);
    }
    throw new Error('the preview clip time did not advance');
  };
  const full = await rateOf();
  await doc.getByLabel('preview speed', { exact: true }).fill('0.5');
  await expect(doc.getByLabel('preview speed value')).toHaveText('×0.50');
  const half = await rateOf();
  expect(Math.abs(full - 1), `×1: ${full.toFixed(3)}`).toBeLessThan(0.02);
  expect(Math.abs(half - 0.5), `×0.5: ${half.toFixed(3)}`).toBeLessThan(0.02);
});
