/**
 * The Animator on a rigged character: a generated skinned GLB (skinned-glb.ts)
 * with idle, run, jump, fall and land clips rides on the starter template's player; a
 * "Character locomotion" controller built from its clips in the Animator window gets
 * the player's speed, grounding and vertical velocity automatically. Driven
 * through the play relays, the observed animator state goes idle → run →
 * airborne. TL_ANIM_SHOTS saves the Play frames for a look.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from './pw';

import { STARTER, startBackend, type E2EBackend, controls } from './backend';
import { LOCOMOTION_CLIPS, skinnedGlb } from './skinned-glb';
import { chooseItem, createItem, closeEditor, editorPane } from './ui';

const shots = process.env['TL_ANIM_SHOTS'];

let be: E2EBackend;
let seq = 0;
test.afterEach(async () => {
  await be?.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0x5a0a00 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-skinned-anim' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function shot(page: Page, name: string): Promise<void> {
  if (shots === undefined) return;
  writeFileSync(join(shots, `skinned-anim-${name}.png`), await page.locator('iframe.tl-app__preview-frame').screenshot());
}

test("a rigged character's clips play on the starter's player: idle, run, airborne", async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('skinned-anim', 'starter');
  const glb = join(mkdtempSync(join(tmpdir(), 'tl-skin-')), 'char_rigged.glb');
  writeFileSync(glb, skinnedGlb(LOCOMOTION_CLIPS));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  await page.locator('.tl-assets__file').first().setInputFiles(glb);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 60_000 });
  await publish.click();
  const assets = async () => (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['assets'] as { assetId: string; displayName: string }[];
  await expect.poll(async () => (await assets()).some((a) => a.displayName.includes('char_rigged'))).toBe(true);
  const character = (await assets()).find((a) => a.displayName.includes('char_rigged'))!.assetId;
  const model = String((await cmd('createEntity', { kind: 'model', name: 'Character', parentId: STARTER.playerId, model: { asset: { assetId: character } }, transform: { position: [0, 0, 0] } })).createdId);

  await chooseItem(page, 'model', character);
  await createItem(page, 'Animator controller: character locomotion', 'Character locomotion');
  // The new controller opens in the editor window (its state graph).
  const graph = editorPane(page, 'Animator', 'Character locomotion').getByLabel('animator graph');
  for (const s of ['Idle', 'Run', 'Jump', 'Fall', 'Land']) await expect(graph.getByRole('group', { name: new RegExp(`^State ${s} node `) })).toBeVisible();
  await closeEditor(page);
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${model}"]`).click();
  // The Inspector's animator section (added from "+ Add component" when absent).
  const inspector = page.locator('.tl-inspector');
  if ((await inspector.locator('[data-component="animator"]').count()) === 0) {
    await inspector.getByLabel('add component', { exact: true }).selectOption({ label: 'Animator' });
    await inspector.getByLabel('animator controller', { exact: true }).selectOption({ label: 'Character locomotion' });
    await inspector.getByRole('button', { name: 'Add', exact: true }).click();
  } else {
    await inspector.getByLabel('animator controller', { exact: true }).selectOption({ label: 'Character locomotion' });
  }
  await expect.poll(async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: model } }))['entity'] as { components: { animator?: unknown } }).components.animator).toBeTruthy();

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  const animState = async (): Promise<string | undefined> => ((await relay(`${psid}/observe`, {})).json as { animators?: Record<string, string> }).animators?.[model];
  await expect.poll(animState, { timeout: 10_000 }).toBe('Idle');
  await shot(page, 'idle');

  // One relay (it answers when its last frame has run): run right for a second, then jump while
  // running; the animator states are observed while the frames play.
  const frames = Array.from({ length: 100 }, (_, i) => ({ stepOffset: i, ...controls(1, i < 60 ? 'none' : i === 60 ? 'pressed' : 'held') }));
  const done = relay(`${psid}/input`, { mode: 'exclusive-test', frames });
  await expect.poll(animState, { timeout: 3_000, intervals: [30] }).toBe('Run');
  await shot(page, 'run');
  await expect.poll(async () => ['Jump', 'Fall'].includes((await animState()) ?? ''), { timeout: 3_000, intervals: [30] }).toBe(true);
  expect((await done).status).toBe(200);
  await shot(page, 'air');
});
