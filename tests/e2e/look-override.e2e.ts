/**
 * A per-object look override set from a script (`ctx.look`),
 * rendered on both renderers, against a real backend on the starter template
 * (a scene without any game session).
 *
 * A grey block in front of the camera; a project script on it sets a strong
 * red glow and a red tint (`ctx.look.set`) for two seconds out of every four
 * and clears it (`ctx.look.clear`) for the other two. The Play picture is
 * observed in pixels: the block turns red, then grey again — the same object,
 * the same material, no other change — and the play observation reports the
 * running scene throughout.
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Locator } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { decodePng, type Image } from './png';
import { editorUrlFor, expectRendererBackend, onlyInItsProject, type RendererVariant } from './renderer-variants';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-look' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
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

/** Glow red for 240 steps (2 s at 120 Hz), then the object's own look for 240. */
const BLINK = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return {}; },',
  '  step(_state: unknown, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const on = Math.floor(ctx.stepIndex / 240) % 2 === 1;',
  "    if (on && ctx.look.get(ctx.entityId) === null) ctx.look.set(ctx.entityId, { emissive: '#ff0000', emissiveIntensity: 4, tint: '#ff2020' });",
  '    if (!on && ctx.look.get(ctx.entityId) !== null) ctx.look.clear(ctx.entityId);',
  "    ctx.game.add('lit', (on ? 1 : 0) - ctx.game.counter('lit'));",
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

const shot = async (t: Locator): Promise<Image> => decodePng(await t.screenshot());
/** Strongly red pixels (the glowing block), sampled every 2 px. */
function reds(img: Image): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) {
    for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 170 && g < 90 && b < 90) n += 1;
    }
  }
  return n;
}

const VARIANTS: readonly RendererVariant[] = ['auto', 'webgl2', 'webgpu'];

for (const variant of VARIANTS) test(`a script's look override glows an object red and clears it, seen in Play pixels (${variant})`, async ({ page }) => {
  onlyInItsProject(variant);
  test.setTimeout(240_000);
  be = await startBackend('look-override-e2e', 'starter');
  // A grey block in the middle of the starter camera's view (the camera at [4, 3, 12] looks along −Z).
  const block = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Lamp', transform: { position: [4, 3, 0] }, box: { size: [3, 2, 1], material: { color: '#808080' } } }))['createdId']);
  await script('blink', BLINK, block);

  await page.goto(editorUrlFor(be.editorUrl, variant));
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const frame = page.locator('iframe.tl-app__preview-frame');
  await expect(frame).toBeVisible();
  await expectRendererBackend(page.frameLocator('iframe.tl-app__preview-frame').locator('canvas').first(), variant);
  type Obs = { state?: string; counters?: Record<string, number> };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('running');

  // Its own look first (the override is off for the first two seconds), then red, then its own look again.
  await expect.poll(async () => (await observe()).counters?.['lit'] ?? -1, { timeout: 20_000 }).toBe(0);
  const plain = reds(await shot(frame));
  let lit = 0;
  let sawLit = false;
  // The counter is read beside each picture (the 2 s window may end between a picture and a later read on a loaded host).
  await expect.poll(async () => {
    lit = reds(await shot(frame));
    if ((await observe()).counters?.['lit'] === 1) sawLit = true;
    return lit;
  }, { timeout: 20_000, message: 'the block glows red' }).toBeGreaterThan(plain + 2000);
  expect(sawLit).toBe(true);
  await expect.poll(async () => reds(await shot(frame)), { timeout: 20_000, message: 'the block has its own look again' }).toBeLessThan(plain + 200);
  console.log(`[look-override] ${variant}: red pixels ${plain} → ${lit} → back`);
  await expect(page.locator('.tl-notice')).toHaveCount(0);
  expect((await observe()).state).toBe('running');
});
