/**
 * Phase 14.0: the player's collision capsule in the editor, against a real
 * backend. On the engine sample's start ground (the player centred 0.91 m up)
 * a neutral low ceiling is added (its underside 1.2 m up: the default 1.8 m
 * capsule cannot pass). Selecting the player shows the Collision section and
 * the capsule's size handles; the capsule outline is drawn and clicking it
 * selects the player; a child of the player "collides with its parent's
 * capsule"; "Fit to model" sizes it to the player's model and "Default" goes
 * back. Dragging the capsule's top handle down stores a smaller capsule
 * (feet kept on the ground) in one setComponent: one undo restores the
 * default, redo brings it back, and in Play the player walks under the
 * ceiling.
 */
import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('capsule-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

let seq = 0;
async function mutate(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  return be.command({ op, projectId: be.projectId, expectedRevision: q['revision'], requestId: `req-${(0xc0a500 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-capsule' }, args });
}

async function controllerOf(id: string): Promise<{ capsule?: { radius: number; height: number; offset?: number[] } } | undefined> {
  const r = await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } });
  return (r['entity'] as { components: { controller?: { capsule?: { radius: number; height: number; offset?: number[] } } } }).components.controller;
}

async function relay(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/play/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

type Handle = { component: string; handle: 'top' | 'side'; x: number; y: number };
async function handles(page: Page): Promise<Handle[]> {
  return JSON.parse((await page.locator('canvas[data-size-handles]').getAttribute('data-size-handles')) ?? '[]') as Handle[];
}

test('the player capsule: Inspector, outline, top-handle drag with one undo, then Play walks under a low ceiling', async ({ page }) => {
  test.setTimeout(240_000);
  const PLAYER = 'model-0001';
  // A neutral low ceiling over x 4.2..5.0 (underside 1.2 m above the ground) and a child under the player.
  expect((await mutate('createEntity', { parentId: null, kind: 'box', name: 'Low ceiling', transform: { position: [4.6, 1.7, 0] }, box: { size: [0.8, 1, 1], material: { color: '#777777' } }, components: { collider: { shape: { type: 'box', hx: 0.4, hy: 0.5 } } } }))['ok']).toBe(true);
  expect((await mutate('createEntity', { parentId: PLAYER, kind: 'group', name: 'Hat', transform: { position: [0, 1, 0] } }))['ok']).toBe(true);
  expect(await controllerOf(PLAYER)).toEqual({});

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas[data-capsule-outlines]');
  await expect(view).toHaveAttribute('data-capsule-outlines', '1');

  // The child shows its parent's capsule, not an absent collider.
  await page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Hat' }).first().click();
  await expect(page.locator('.tl-inspector__collision[data-capsule="parent"]')).toContainText("Collides with its parent's capsule (Player)");

  // The player: the Collision section with the default capsule, and two handles on the capsule.
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${PLAYER}"]`).click();
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Player');
  const collision = page.locator('.tl-inspector__collision[data-capsule="default"]');
  await expect(collision).toBeVisible();
  await expect(page.getByLabel('controller capsule radius', { exact: true })).toHaveValue('0.3');
  await expect(page.getByLabel('controller capsule height', { exact: true })).toHaveValue('1.8');
  await expect(page.locator('.tl-inspector').getByText('absent')).toHaveCount(0);
  // "Fit to model" sizes the capsule to the player's model (once it is loaded); "Default" goes back.
  await expect
    .poll(async () => {
      if ((await controllerOf(PLAYER))?.capsule === undefined) await page.getByRole('button', { name: 'Fit to model' }).click();
      return (await controllerOf(PLAYER))?.capsule?.height ?? 0;
    }, { timeout: 30_000 })
    .toBeGreaterThan(0.1);
  const fitted = (await controllerOf(PLAYER))!.capsule!;
  expect(fitted.radius).toBeGreaterThanOrEqual(0.05);
  expect(fitted.height).toBeGreaterThanOrEqual(2 * fitted.radius);
  await expect(page.locator('.tl-inspector__collision[data-capsule="own"]')).toBeVisible();
  await expect(page.getByLabel('controller capsule height', { exact: true })).toHaveValue(String(fitted.height));
  await page.getByRole('button', { name: 'Default', exact: true }).click();
  await expect.poll(async () => JSON.stringify(await controllerOf(PLAYER))).toBe('{}');
  await expect(page.locator('.tl-inspector__collision[data-capsule="default"]')).toBeVisible();
  // Focus the player and zoom in (the Scene view orbits around it).
  await page.keyboard.press('f');
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(30);
  }
  await expect.poll(async () => (await handles(page)).filter((h) => h.component === 'controller').length).toBe(2);
  await page.waitForTimeout(300);
  const hs = await handles(page);
  const top = hs.find((h) => h.component === 'controller' && h.handle === 'top')!;
  const side = hs.find((h) => h.component === 'controller' && h.handle === 'side')!;
  // Screen pixels per metre along Y: the top handle is 0.9 m above the side handle.
  const perMetre = (side.y - top.y) / 0.9;
  expect(perMetre).toBeGreaterThan(30);

  // Clicking the capsule outline (away from the handles) selects the player
  // (the far-away beacon is selected first, so its gizmo is not in the way).
  await page.locator(`.tl-hierarchy__list li[data-entity-id="box-0009"]`).click();
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Beacon');
  await page.mouse.click(side.x, side.y - Math.round(0.4 * perMetre));
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Player');

  // Drag the top handle down about 0.85 m: one setComponent on release, the feet stay on the ground.
  const fresh = (await handles(page)).find((h) => h.component === 'controller' && h.handle === 'top')!;
  await page.mouse.move(fresh.x, fresh.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(fresh.x, fresh.y + (i / 8) * 0.85 * perMetre);
  await page.mouse.up();
  await expect.poll(async () => (await controllerOf(PLAYER))?.capsule?.height ?? 0).toBeGreaterThan(0);
  const stored = (await controllerOf(PLAYER))!.capsule!;
  expect(stored.radius).toBe(0.3);
  expect(stored.height).toBeGreaterThanOrEqual(0.6);
  expect(stored.height).toBeLessThan(1.15);
  // Snapped to 5 cm, and the bottom (0.91 − 0.9 = 0.01 m) unchanged.
  expect(Math.abs(stored.height / 0.05 - Math.round(stored.height / 0.05))).toBeLessThan(1e-6);
  expect(0.91 + (stored.offset?.[1] ?? 0) - stored.height / 2).toBeCloseTo(0.01, 6);
  await expect(page.locator('.tl-inspector__collision[data-capsule="own"]')).toBeVisible();
  await expect(page.getByLabel('controller capsule height', { exact: true })).toHaveValue(String(stored.height));

  // One undo restores the default capsule; redo brings the small one back.
  await page.locator('canvas[data-capsule-outlines]').hover();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => JSON.stringify(await controllerOf(PLAYER))).toBe('{}');
  await expect(page.getByLabel('controller capsule height', { exact: true })).toHaveValue('1.8');
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(async () => (await controllerOf(PLAYER))?.capsule?.height).toBe(stored.height);

  // Play: the player walks right under the ceiling (the default capsule would stop at x 3.9).
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<{ state: string; player?: { x: number; y: number } }> => (await relay(`${psid}/observe`, {})).json as never;
  await expect.poll(async () => (await relay(`${psid}/observe`, {})).status, { timeout: 30_000 }).toBe(200);
  expect((await relay(`${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(async () => (await observe()).state).toBe('playing');
  await page.waitForTimeout(400);
  for (let i = 0; i < 40 && ((await observe()).player?.x ?? 0) < 5.3; i++) {
    const r = await relay(`${psid}/input`, { mode: 'exclusive-test', frames: Array.from({ length: 12 }, (_, k) => ({ stepOffset: k, moveX: 1, jump: 'none' })) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }
  const after = await observe();
  expect(after.player!.x).toBeGreaterThan(5.3);
  // Standing on the ground (the origin 0.91 m up, as authored), not squeezed up or down.
  expect(after.player!.y).toBeGreaterThan(0.85);
  expect(after.player!.y).toBeLessThan(0.95);
});

test('area handles: a trigger is resized by its side handle (snapped, centred, one undo)', async ({ page }) => {
  test.setTimeout(120_000);
  expect((await mutate('createEntity', { parentId: null, kind: 'group', name: 'Sensor', transform: { position: [6, 1, 0] }, components: { trigger: { size: [1, 1], signal: 'hello' } } }))['ok']).toBe(true);
  const entities = async (): Promise<{ id: string; name?: string; components: Record<string, unknown> }[]> =>
    (await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } }))['entities'] as never;
  const sensor = (await entities()).find((e) => e.name === 'Sensor')!;
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${sensor.id}"]`).click();
  await expect(page.locator('.tl-inspector__name')).toHaveValue('Sensor');
  await page.keyboard.press('f');
  const view = page.locator('canvas[data-size-handles]');
  const box = (await view.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, -250);
    await page.waitForTimeout(30);
  }
  await expect.poll(async () => (await handles(page)).filter((h) => h.component === 'trigger').length).toBe(2);
  await page.waitForTimeout(300);
  const hs = await handles(page);
  const top = hs.find((h) => h.component === 'trigger' && h.handle === 'top')!;
  const side = hs.find((h) => h.component === 'trigger' && h.handle === 'side')!;
  const perMetre = (side.y - top.y) / 0.5;
  expect(perMetre).toBeGreaterThan(30);
  // The side handle further out: the (centred) trigger grows on both sides.
  await page.mouse.move(side.x, side.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(side.x + (i / 6) * 0.5 * perMetre, side.y);
  await page.mouse.up();
  const sizeOf = async (): Promise<number[]> => ((await entities()).find((e) => e.id === sensor.id)!.components['trigger'] as { size: number[] }).size;
  await expect.poll(async () => (await sizeOf())[0]).toBeGreaterThan(1.5);
  const [w, h] = await sizeOf();
  expect(w).toBeLessThan(4); // the view is oblique: horizontal pixels per metre differ from vertical ones
  expect(Math.abs(w! / 0.05 - Math.round(w! / 0.05))).toBeLessThan(1e-6);
  expect(h).toBe(1);
  await view.hover();
  await page.keyboard.press('Control+z');
  await expect.poll(async () => await sizeOf()).toEqual([1, 1]);
});
