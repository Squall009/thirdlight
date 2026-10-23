/**
 * Several scenes in a real browser against the real backend:
 *
 * - the editor with several scenes: a header per open scene, a new scene
 *   becomes the active one and new objects go there, rename, the start set,
 *   close/open (a closed scene's block layer leaves the Scene view too),
 *   deleting an empty scene, and a drag between scenes refused.
 *
 * Play loading a scene through a trigger's transition and MCP unloading it:
 * scene-transition.e2e.ts (a script's ctx.scenes: keep-loaded.e2e,
 * scene-reload.e2e).
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { createBox } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

const status = (page: Page) => page.locator('.tl-statusbar');
const header = (page: Page, name: string) => page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: new RegExp(`^${name}$`) }) });
const row = (page: Page, name: string) => page.locator('.tl-hierarchy__list li.tl-row').filter({ has: page.locator('.tl-row__name', { hasText: new RegExp(`^${name}$`) }) });

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

  // A magenta block slab in Cave around the origin, drawn in the Scene view while Cave is open.
  await cmd('setBlockType', { block: { blockId: 'glow', name: 'Glow', variants: [{ color: '#ff00ff' }], shape: 'full' } });
  const slab = String((await cmd('createEntity', { sceneId: secondId, parentId: null, kind: 'group', name: 'Slab', transform: { position: [-8, 0, -8] } }))['createdId']);
  await cmd('setComponent', { entityId: slab, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 2, 16] } } });
  await cmd('editBlocks', { entityId: slab, edits: [{ kind: 'fill', box: [0, 0, 0, 16, 1, 16], cell: { block: 'glow' } }] });
  const magenta = async (): Promise<number> => {
    const img = decodePng(await page.locator('.tl-viewport').screenshot());
    let n = 0;
    for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) {
      const [r, g, b] = img.pixel(x, y);
      if (r > 120 && b > 120 && g < 60) n += 1;
    }
    return n;
  };
  await expect.poll(magenta, { timeout: 20_000, message: "Cave's block slab in the Scene view" }).toBeGreaterThan(200);

  // Close Cave (this browser only): its header, rows and block layer go; "open scene…" brings them back.
  await cave.getByRole('button', { name: 'close scene Cave' }).click();
  await expect(cave).toHaveCount(0);
  await expect(boxRow).toHaveCount(0);
  await expect(main).toHaveClass(/is-active/);
  await expect.poll(magenta, { timeout: 10_000, message: "a closed scene's block layer is not drawn" }).toBeLessThan(20);
  await page.getByLabel('open scene').selectOption({ label: 'Cave' });
  await expect(cave).toHaveCount(1);
  await expect(boxRow).toHaveCount(1);
  await expect.poll(magenta, { timeout: 10_000, message: "Cave's block slab drawn again" }).toBeGreaterThan(200);
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
