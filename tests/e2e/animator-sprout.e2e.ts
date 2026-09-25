/**
 * Phase 9.7 with the real game: Sprout's character (a skinned GLB with idle,
 * run, jump, fall and land clips) rides on Beacon Reach's player; a
 * "Platformer" controller built from its clips in the Animator window gets
 * the player's speed, grounding and vertical velocity automatically. Driven
 * through the play relays, the observed animator state goes idle → run →
 * airborne. Runs only where the Sprout game folder is (TL_SPROUT_CHAR);
 * TL_ANIM_SHOTS saves the Play frames for a look.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

const glb = process.env['TL_SPROUT_CHAR'] ?? join(homedir(), 'projects', 'sprout', 'assets', 'characters', 'sprout', 'char_sprout.glb');
const shots = process.env['TL_ANIM_SHOTS'];

let be: E2EBackend;
let seq = 0;
test.afterEach(async () => {
  await be?.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0x5a0a00 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-sprout-anim' }, args });
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
  writeFileSync(join(shots, `sprout-anim-${name}.png`), await page.locator('iframe.tl-app__preview-frame').screenshot());
}

test("Sprout's clips play on Beacon Reach's player: idle, run, airborne", async ({ page }) => {
  test.skip(!existsSync(glb), 'needs the Sprout game folder');
  test.setTimeout(240_000);
  be = await startBackend('sprout-anim', 'beacon-reach');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  await page.locator('.tl-assets__file').first().setInputFiles(glb);
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 60_000 });
  await publish.click();
  const assets = async () => (await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 50, offset: 0 } }))['assets'] as { assetId: string; displayName: string }[];
  await expect.poll(async () => (await assets()).some((a) => a.displayName.includes('char_sprout'))).toBe(true);
  const sprout = (await assets()).find((a) => a.displayName.includes('char_sprout'))!.assetId;
  const game = (await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['game'] as { playerId: string };
  const model = String((await cmd('createEntity', { kind: 'model', name: 'Sprout', parentId: game.playerId, model: { asset: { assetId: sprout } }, transform: { position: [0, 0, 0] } })).createdId);

  await page.getByRole('tab', { name: 'Animator', exact: true }).click();
  await page.getByLabel('animator model').selectOption(sprout);
  await page.getByRole('button', { name: 'New from clips: Platformer' }).click();
  // Phase 16.2: the new controller opens as a centre tab (its state graph).
  const graph = page.getByRole('tabpanel', { name: 'Animator: Platformer' }).getByLabel('animator graph');
  for (const s of ['Idle', 'Run', 'Jump', 'Fall', 'Land']) await expect(graph.getByRole('group', { name: new RegExp(`^State ${s} node `) })).toBeVisible();
  await page.getByRole('tab', { name: 'Scene', exact: true }).click();
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${model}"]`).click();
  // Phase 15.1: the Inspector's animator section (added from "+ Add component" when absent).
  const inspector = page.locator('.tl-inspector');
  if ((await inspector.locator('[data-component="animator"]').count()) === 0) {
    await inspector.getByLabel('add component', { exact: true }).selectOption({ label: 'Animator' });
    await inspector.getByLabel('animator controller', { exact: true }).selectOption({ label: 'Platformer' });
    await inspector.getByRole('button', { name: 'Add', exact: true }).click();
  } else {
    await inspector.getByLabel('animator controller', { exact: true }).selectOption({ label: 'Platformer' });
  }
  await expect.poll(async () => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: model } }))['entity'] as { components: { animator?: unknown } }).components.animator).toBeTruthy();

  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  const animState = async (): Promise<string | undefined> => ((await relay(`${psid}/observe`, {})).json as { animators?: Record<string, string> }).animators?.[model];
  expect((await relay(`${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(animState, { timeout: 10_000 }).toBe('Idle');
  await shot(page, 'idle');

  // One relay (it answers when its last frame has run): run right for a second, then jump while
  // running; the animator states are observed while the frames play.
  const frames = Array.from({ length: 100 }, (_, i) => ({ stepOffset: i, moveX: 1, jump: i < 60 ? 'none' : i === 60 ? 'pressed' : 'held' }));
  const done = relay(`${psid}/input`, { mode: 'exclusive-test', frames });
  await expect.poll(animState, { timeout: 3_000, intervals: [30] }).toBe('Run');
  await shot(page, 'run');
  await expect.poll(async () => ['Jump', 'Fall'].includes((await animState()) ?? ''), { timeout: 3_000, intervals: [30] }).toBe(true);
  expect((await done).status).toBe(200);
  await shot(page, 'air');
});
