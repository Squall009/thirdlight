/**
 * Several scenes in a real browser against the real backend:
 *
 * - the editor with several scenes: a header per open scene, a new scene
 *   becomes the active one and new objects go there, rename, the start set,
 *   close/open, deleting an empty scene, and a drag between scenes refused;
 * - Play loads scenes on demand: an exit zone loads a scene and moves the
 *   player to its spawn; MCP's game-control relay unloads it again (a script's
 *   ctx.scenes: keep-loaded.e2e, scene-reload.e2e).
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { createBox } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

const status = (page: Page) => page.locator('.tl-statusbar');
const header = (page: Page, name: string) => page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: new RegExp(`^${name}$`) }) });
const row = (page: Page, name: string) => page.locator('.tl-hierarchy__list li.tl-row').filter({ has: page.locator('.tl-row__name', { hasText: new RegExp(`^${name}$`) }) });

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

async function revision(): Promise<number> {
  return Number((await query('queryProject')).revision);
}

/** One command through the route the MCP adapter uses. */
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: await revision(),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-scenes' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

test('several scenes in the editor: new scene is active, objects go there, rename, start set, drag across, close/open, delete', async ({ page }) => {
  be = await startBackend();
  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');

  // The upgraded project has one scene, "Main": active and a start scene.
  const main = header(page, 'Main');
  await expect(main).toHaveCount(1);
  await expect(main).toHaveClass(/is-active/);
  await expect(main.getByRole('button', { name: 'start scene Main' })).toHaveAttribute('aria-pressed', 'true');

  // A new scene: its own file, and it becomes the active scene.
  await page.getByRole('button', { name: '+ Scene' }).click();
  const second = header(page, 'Scene 2');
  await expect(second).toHaveCount(1);
  await expect(second).toHaveClass(/is-active/);
  await expect(main).not.toHaveClass(/is-active/);
  const scenes = (await query('queryProject')).scenes as { sceneId: string; name: string }[];
  const secondId = scenes.find((s) => s.name === 'Scene 2')!.sceneId;
  expect(existsSync(join(be.projectDir, 'scenes', `${secondId}.json`))).toBe(true);

  // A box created now lands in the active scene (its file, its header).
  const before = await page.locator('.tl-hierarchy__list li.tl-row').count();
  await createBox(page);
  await expect(page.locator('.tl-hierarchy__list li.tl-row')).toHaveCount(before + 1);
  const listed = (await query('queryEntities', { sceneId: secondId })).entities as { id: string; name?: string }[];
  expect(listed).toHaveLength(1);
  const boxId = listed[0]!.id;
  expect(JSON.parse(readFileSync(join(be.projectDir, 'scenes', `${secondId}.json`), 'utf8')).scene.entities.map((e: { id: string }) => e.id)).toEqual([boxId]);
  // The row sits under the Scene 2 header (after it in the list).
  const order = await page.locator('.tl-hierarchy__list > li').evaluateAll((els) => els.map((el) => el.getAttribute('data-scene-id') ?? el.getAttribute('data-entity-id')));
  expect(order.indexOf(boxId)).toBeGreaterThan(order.indexOf(secondId));

  // Rename by double-clicking the header name.
  await second.locator('.tl-scene-header__name').dblclick();
  await page.getByLabel('rename scene').fill('Cave');
  await page.getByLabel('rename scene').press('Enter');
  const cave = header(page, 'Cave');
  await expect(cave).toHaveCount(1);
  expect(((await query('queryProject')).scenes as { name: string }[]).map((s) => s.name)).toEqual(['Main', 'Cave']);

  // The start set: add Cave, then take it out again.
  await cave.getByRole('button', { name: 'start scene Cave' }).click();
  await expect.poll(async () => (await query('queryProject')).startScenes).toEqual(['scene-main', secondId]);
  await expect(cave.getByRole('button', { name: 'start scene Cave' })).toHaveAttribute('aria-pressed', 'true');
  await cave.getByRole('button', { name: 'start scene Cave' }).click();
  await expect.poll(async () => (await query('queryProject')).startScenes).toEqual(['scene-main']);

  // Dragging the box onto the Main header moves it into Main (its id kept, one undo); undo puts it back in Cave.
  const boxRow = page.locator(`.tl-hierarchy__list li[data-entity-id="${boxId}"]`);
  await boxRow.dragTo(main);
  await expect.poll(async () => ((await query('queryEntity', { entityId: boxId })) as { sceneId: string }).sceneId).toBe('scene-main');
  await expect.poll(() => JSON.parse(readFileSync(join(be.projectDir, 'scenes', `${secondId}.json`), 'utf8')).scene.entities.length).toBe(0);
  let rows = await page.locator('.tl-hierarchy__list > li').evaluateAll((els) => els.map((el) => el.getAttribute('data-scene-id') ?? el.getAttribute('data-entity-id')));
  expect(rows.indexOf(boxId)).toBeLessThan(rows.indexOf(secondId));
  await cmd('undo', {});
  await expect.poll(async () => ((await query('queryEntity', { entityId: boxId })) as { sceneId: string }).sceneId).toBe(secondId);
  await expect.poll(async () => {
    rows = await page.locator('.tl-hierarchy__list > li').evaluateAll((els) => els.map((el) => el.getAttribute('data-scene-id') ?? el.getAttribute('data-entity-id')));
    return rows.indexOf(boxId) > rows.indexOf(secondId);
  }).toBe(true);

  await page.screenshot({ path: 'test-results/scenes-hierarchy.png' });

  // Close Cave (this browser only): its header and rows go; "open scene…" brings it back.
  await cave.getByRole('button', { name: 'close scene Cave' }).click();
  await expect(cave).toHaveCount(0);
  await expect(boxRow).toHaveCount(0);
  await expect(main).toHaveClass(/is-active/);
  await page.getByLabel('open scene').selectOption({ label: 'Cave' });
  await expect(cave).toHaveCount(1);
  await expect(boxRow).toHaveCount(1);
  // The open scenes survive a reload.
  await page.reload();
  await expect(status(page)).toContainText('connected');
  await expect(header(page, 'Cave')).toHaveCount(1);

  // An empty scene can be deleted (its file goes); a scene with objects cannot.
  await expect(header(page, 'Cave').getByRole('button', { name: 'delete scene Cave' })).toHaveCount(0);
  await page.getByRole('button', { name: '+ Scene' }).click();
  const third = header(page, 'Scene 3');
  await expect(third).toHaveClass(/is-active/);
  const thirdId = ((await query('queryProject')).scenes as { sceneId: string; name: string }[]).find((s) => s.name === 'Scene 3')!.sceneId;
  await third.getByRole('button', { name: 'delete scene Scene 3' }).click();
  await expect(third).toHaveCount(0);
  expect(existsSync(join(be.projectDir, 'scenes', `${thirdId}.json`))).toBe(false);
});

/** The cave scene: a floor far to the right, a spawn on it and a magenta marker box. */
async function buildCave(): Promise<void> {
  await cmd('createScene', { sceneId: 'scene-cave', name: 'Cave' });
  await cmd('createEntity', { sceneId: 'scene-cave', kind: 'box', name: 'Cave floor', transform: { position: [65, -0.2, 0] }, box: { size: [10, 0.4, 2], material: { color: '#4a3f5c' } }, components: { collider: { shape: { type: 'box', hx: 5, hy: 0.2 } } } });
  await cmd('createEntity', { sceneId: 'scene-cave', kind: 'box', name: 'Cave marker', transform: { position: [67, 1.2, 0] }, box: { size: [1.4, 1.4, 1.4], material: { color: '#ff00ff' } } });
  await cmd('createEntity', { sceneId: 'scene-cave', kind: 'group', name: 'Cave spawn', transform: { position: [65, 0.91, 0] }, components: { playerSpawn: {} } });
}

async function startPlay(page: Page, firstState = 'running'): Promise<{ psid: string; observe: () => Promise<{ state?: string; player?: { x: number; y: number }; scenes?: { loaded: string[]; loading: string[] } }> }> {
  await page.goto(be.editorUrl);
  await expect(status(page)).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async () => (await api(`play/${psid}/observe`, {})).json as never;
  await expect.poll(async () => (await observe()).state, { timeout: 15_000 }).toBe(firstState);
  return { psid, observe };
}

test('Play: a scene transition trigger loads its scene and moves the player there; MCP unloads it', async ({ page }) => {
  be = await startBackend('exits-e2e', 'starter');
  await buildCave();
  // A trigger with a scene transition. It sits on the
  // start spawn: the character starts inside it, so the scene plays straight into the transition.
  const caveSpawn = String(((await query('queryEntities', { sceneId: 'scene-cave' })).entities as { id: string; name?: string }[]).find((e) => e.name === 'Cave spawn')!.id);
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'To the cave', transform: { position: [3, 1, 0] }, components: { trigger: { size: [1, 2], signal: 'to-cave', sceneTransition: { scene: 'scene-cave', spawn: caveSpawn } } } });
  const { psid, observe } = await startPlay(page);
  await expect.poll(async () => (await observe()).scenes?.loaded, { timeout: 10_000 }).toEqual(['scene-main', 'scene-cave']);
  await expect.poll(async () => (await observe()).player!.x, { timeout: 5_000 }).toBeCloseTo(65, 0);
  // The frame: the player on the cave floor next to the magenta marker.
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/scenes-exit-cave.png' });

  // MCP's relay unloads it (the same request a script makes).
  const unload = await api(`play/${psid}/control`, { command: 'unloadScene', sceneId: 'scene-cave' });
  expect(unload.status, JSON.stringify(unload.json)).toBe(200);
  await expect.poll(async () => (await observe()).scenes?.loaded, { timeout: 5_000 }).toEqual(['scene-main']);
  // The main scene unloads too: its kept camera and player stay (the starter's are kept loaded).
  const main = await api(`play/${psid}/control`, { command: 'unloadScene', sceneId: 'scene-main' });
  expect(main.status, JSON.stringify(main.json)).toBe(200);
  await expect.poll(async () => (await observe()).scenes?.loaded, { timeout: 5_000 }).toEqual([]);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/scenes-exit-unloaded.png' });
});
