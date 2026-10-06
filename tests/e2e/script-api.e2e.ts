/**
 * Script API reads and spawns against a real backend, in Play, on the
 * starter template (a fixed camera looking down −Z at the player).
 *
 * 1. World transforms: a grey parent box carries a script that owns it; at
 *    a step it moves it, turns it 45° in the view's plane and stretches it
 *    (2 × 1.5 × 1). A small green box is its child. The script reads the
 *    child's `ctx.world.worldTransform` and its local `ctx.world.transform`,
 *    projects both with `ctx.camera.worldToScreen` and reports them as
 *    counters. The green pixels' centre on the canvas is where the world
 *    read says, and far from where the local read would put it.
 * 2. `ctx.input.anyPressed()`: a click on the view and a key no action uses
 *    (K) each reach the script with their device and code.
 * 3. `ctx.spawn` with per-copy property values: three copies of a prefab
 *    whose script adds its `amount` property to a counter once — two with
 *    their own amounts (10, 100), one with the prefab's (1) — add up to 111.
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Locator, type Page } from './pw';

import { startBackend, STARTER, type E2EBackend } from './backend';
import { decodePng } from './png';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-script-api' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
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

/** Publish a behavior (its source, owned transforms and declared properties) and attach it to `entityId`. */
async function script(behaviorId: string, text: string, entityId: string, options: { owned?: string[]; properties?: unknown[]; values?: Record<string, unknown> } = {}): Promise<void> {
  const declaration = { properties: options.properties ?? [] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: options.owned ?? [], files: [{ path: 'src/index.ts', text }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: options.values ?? {} });
}

type Obs = { state?: string; counters?: Record<string, number> };

/** Start Play from the editor; the observation reader. */
async function play(page: Page): Promise<() => Promise<Obs>> {
  await page.goto(be!.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`)).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  return observe;
}

/**
 * The parent's own script: at step 60 (transform phase) it moves, turns and
 * stretches its object; from step 90 it reports where the child "Probe" is
 * on screen by its world read (wx, wy) and by its local read (lx, ly), in
 * ten-thousandths of the view, and counts `ready` once.
 */
const PARENT = [
  'export default {',
  '  instantiate() { return { wx: 0, wy: 0, lx: 0, ly: 0, ready: false }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase === 'transform') {",
  '      if (ctx.stepIndex !== 60) return;',
  "      ctx.emit({ kind: 'transform', entityId: ctx.entityId, position: { x: 5, y: 2, z: 1 }, quaternion: [0, 0, 0.3826834, 0.9238795] });",
  "      ctx.emit({ kind: 'pose', entityId: ctx.entityId, scale: [2, 1.5, 1] });",
  '      return;',
  '    }',
  '    if (ctx.stepIndex < 90) return;',
  "    const probe = ctx.world.find('Probe');",
  '    const w = ctx.world.worldTransform(probe);',
  "    const viaOption = ctx.world.transform(probe, { space: 'world' });",
  '    const l = ctx.world.transform(probe);',
  '    if (w === undefined || l === undefined || viaOption.position[0] !== w.position[0]) return;',
  '    const sw = ctx.camera.worldToScreen(w.position);',
  '    const sl = ctx.camera.worldToScreen(l.position);',
  '    const put = (k: string, v: number) => { const n = Math.round(v * 10000); if (n !== state[k]) { ctx.game.add(k, n - state[k]); state[k] = n; } };',
  "    put('wx', sw.x); put('wy', sw.y); put('lx', sl.x); put('ly', sl.y);",
  "    if (!state.ready) { state.ready = true; ctx.game.add('ready', 1); }",
  '  },',
  '};',
  '',
].join('\n');

/** The centre of the clearly green pixels of the canvas (fractions of its size) and their count. */
async function greenCentre(canvas: Locator): Promise<{ x: number; y: number; n: number }> {
  const img = decodePng(await canvas.screenshot());
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      const [r, g, b] = img.pixel(x, y);
      if (g > 70 && g > 2 * r && g > 2 * b) {
        sx += x + 0.5;
        sy += y + 0.5;
        n += 1;
      }
    }
  }
  return n === 0 ? { x: -1, y: -1, n } : { x: sx / n / img.width, y: sy / n / img.height, n };
}

/** Counts what `anyPressed` saw by device and code. */
const PRESSES = [
  'export default {',
  '  step(_s: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const p = ctx.input.anyPressed();',
  "    if (p !== null) ctx.game.add('press_' + p.device + '_' + p.code, 1);",
  '  },',
  '};',
  '',
].join('\n');

/** The copy's own script: its `amount` property is added to `tally` once. */
const TALLY = [
  'export default {',
  '  instantiate() { return { done: false }; },',
  '  step(state: { done: boolean }, ctx: any) {',
  "    if (ctx.phase !== 'intent' || state.done) return;",
  '    state.done = true;',
  "    ctx.game.add('tally', ctx.properties.amount);",
  '  },',
  '};',
  '',
].join('\n');

/** Spawns three copies once the game plays: two with their own amounts, one with the prefab's. */
const SPAWNER = [
  'export default {',
  '  instantiate() { return { done: false }; },',
  '  step(state: { done: boolean }, ctx: any) {',
  "    if (ctx.phase !== 'intent' || state.done || ctx.stepIndex < 30) return;",
  '    state.done = true;',
  "    ctx.spawn('token', { position: [0, -30, 0], properties: { amount: 10 } });",
  "    ctx.spawn('token', { position: [1, -30, 0], properties: { amount: 100 } });",
  "    ctx.spawn('token', { position: [2, -30, 0] });",
  "    ctx.game.add('spawned', 3);",
  '  },',
  '};',
  '',
].join('\n');

// One Play runs both checks: the parent and its child, the spawner, the copies and the press counter use distinct objects and counters.
test('a child of a moved, turned and stretched parent: the world read is where it is drawn; anyPressed sees a click and a key no action uses; spawned copies take their own property values', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('script-api-world', 'starter');
  const parent = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Holder', transform: { position: [2, 2, 0] }, box: { size: [0.2, 0.2, 0.2], material: { color: '#7d7d7d' } } })).createdId);
  await cmd('createEntity', { sceneId: 'scene-main', parentId: parent, kind: 'box', name: 'Probe', transform: { position: [1, 0.5, 0] }, box: { size: [0.25, 0.25, 0.25], material: { color: '#00ff00' } } });
  await script('holder', PARENT, parent, { owned: ['@self'] });

  // The prefab: a box whose script adds its amount (default 1) to a counter.
  const source = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Token', transform: { position: [0, -40, 0] }, box: { size: [0.3, 0.3, 0.3], material: { color: '#ffffff' } } })).createdId);
  await script('tally', TALLY, source, { properties: [{ key: 'amount', label: 'Amount', type: 'number', default: 1, min: 0, max: 1000, step: 1 }], values: { amount: 1 } });
  await cmd('createPrefab', { prefabId: 'token', displayName: 'Token', sourceEntityId: source });
  await cmd('deleteEntity', { entityId: source });
  const director = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Director', transform: { position: [0, -20, 0] } })).createdId);
  await script('spawner', SPAWNER, director);
  await script('presses', PRESSES, STARTER.playerId);

  const observe = await play(page);
  await expect.poll(async () => (await observe()).counters?.['ready'] ?? 0, { timeout: 60_000 }).toBe(1);
  const canvas = page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first();
  // The picture has caught up with the move (two reads in a row agree).
  let seen = await greenCentre(canvas);
  await expect.poll(async () => {
    const next = await greenCentre(canvas);
    const still = Math.abs(next.x - seen.x) < 0.002 && Math.abs(next.y - seen.y) < 0.002;
    seen = next;
    return still && next.n > 30;
  }, { timeout: 30_000, message: 'the green child is drawn and still' }).toBe(true);
  const c = (await observe()).counters!;
  const world = { x: c['wx']! / 10000, y: c['wy']! / 10000 };
  const local = { x: c['lx']! / 10000, y: c['ly']! / 10000 };
  await page.screenshot({ path: 'test-results/script-api-world.png' });
  // Drawn where the world read says (within 1 % of the view) …
  expect(Math.abs(seen.x - world.x), JSON.stringify({ seen, world })).toBeLessThan(0.01);
  expect(Math.abs(seen.y - world.y), JSON.stringify({ seen, world })).toBeLessThan(0.01);
  // … and the local read would put it elsewhere (the test tells the two apart).
  expect(Math.hypot(seen.x - local.x, seen.y - local.y)).toBeGreaterThan(0.08);

  // anyPressed and the spawned copies, in the same run.
  await expect.poll(async () => (await observe()).counters?.['spawned'] ?? 0, { timeout: 60_000 }).toBe(3);
  await expect.poll(async () => (await observe()).counters?.['tally'] ?? 0, { timeout: 30_000 }).toBe(111);

  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.3);
  await expect.poll(async () => (await observe()).counters?.['press_mouse_left'] ?? 0, { timeout: 30_000, message: 'the click is a press' }).toBeGreaterThanOrEqual(1);
  // The click focused the view: a key no action is bound to.
  await page.keyboard.press('KeyK');
  await expect.poll(async () => (await observe()).counters?.['press_keyboard_KeyK'] ?? 0, { timeout: 30_000, message: 'K is a press' }).toBe(1);
  // One press, one step: K was seen once, not on every step it was held.
  await page.waitForTimeout(500);
  expect((await observe()).counters?.['press_keyboard_KeyK']).toBe(1);
  expect((await observe()).state).toBe('running');
});
