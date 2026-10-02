/**
 * The Window menu's tools and the tools that follow the selection, in the
 * editor against a real backend:
 *
 * - Lighting and Environment open from the Window menu as floating windows
 *   over the Scene view (no dock tabs any more); each names the scene it
 *   edits, and its scene picker makes another scene the one both edit (the
 *   active scene, whose sky the Scene view shows). Two scenes: each window
 *   names and edits its own scene, the Scene view's pixels follow. A window
 *   is moved by its title bar and resized by its corner; where it stands and
 *   whether it is open are remembered over a reload; the Game view sets them
 *   aside, the Scene view brings them back.
 * - A block layer's tools show in the Inspector while a block layer is
 *   selected (GameObject → Block layer makes one), and nowhere else.
 * - GameObject → Create prefab from selection and the Hierarchy's context
 *   menu make a prefab from the selection.
 * - An audio asset chosen in the project window shows in the Inspector with
 *   its load type, preload and listening; Project Settings → Audio holds the
 *   event sounds.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { publishWav, startBackend, type E2EBackend } from './backend';
import { decodePng } from './png';
import { inspector, menu, menuItem, openProjectSettings, projectWindow, settingsTab, settingsWindow, showView, toolWindow, toolWindowScene, windowTab } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const revision = Number((await query('queryProject')).revision);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-window-tools' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
async function looks(): Promise<Record<string, Record<string, unknown> | null>> {
  const rows = (await query('queryProject', { environments: true }))['scenes'] as { sceneId: string; environment?: Record<string, unknown> }[];
  return Object.fromEntries(rows.map((r) => [r.sceneId, r.environment ?? null]));
}

/** The Scene view's sky, left of where the tool windows open: [r, g, b]. */
async function skyLeft(view: Locator): Promise<[number, number, number]> {
  const img = decodePng(await view.screenshot());
  let [r, g, b, n] = [0, 0, 0, 0];
  for (let y = Math.floor(img.height * 0.02); y < Math.floor(img.height * 0.1); y += 3) {
    for (let x = Math.floor(img.width * 0.03); x < Math.floor(img.width * 0.3); x += 3) {
      const p = img.pixel(x, y);
      r += p[0];
      g += p[1];
      b += p[2];
      n += 1;
    }
  }
  return [r / n, g / n, b / n];
}
const header = (page: Page, name: string): Locator => page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: new RegExp(`^${name}$`) }) });
const row = (page: Page, name: string): Locator => page.locator('.tl-hierarchy__list li.tl-row').filter({ has: page.locator('.tl-row__name', { hasText: new RegExp(`^${name}$`) }) });
const boxOf = async (l: Locator): Promise<{ x: number; y: number; width: number; height: number }> => {
  const b = await l.boundingBox();
  if (b === null) throw new Error('no box');
  return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
};

test('Lighting and Environment float over the Scene view and edit the scene they name; two scenes', async ({ page }) => {
  test.setTimeout(180_000);
  be = await startBackend('window-tools-scenes');
  await cmd('createScene', { sceneId: 'scene-two', name: 'Two' });
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#d02020' } } });
  await cmd('setEnvironment', { sceneId: 'scene-two', environment: { sky: { mode: 'color', color: '#2040d0' } } });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const view = page.locator('canvas.tl-viewport');
  const red = async (): Promise<boolean> => { const [r, , b] = await skyLeft(view); return r > b + 80; };
  const blue = async (): Promise<boolean> => { const [r, , b] = await skyLeft(view); return b > r + 80; };
  await expect.poll(red, { timeout: 20_000, message: "Main's red sky" }).toBe(true);

  // No dock tabs for them (nor for Blocks and Media); the Window menu lists them.
  for (const gone of ['Lighting', 'Environment', 'Blocks', 'Media']) await expect(windowTab(page, gone)).toHaveCount(0);
  await expect(await menuItem(page, 'Window', 'Lighting')).toBeVisible();
  await page.keyboard.press('Escape');

  // Both open over the Scene view and name the active scene.
  await menu(page, 'Window', 'Environment');
  await menu(page, 'Window', 'Lighting');
  const env = toolWindow(page, 'Environment');
  const lit = toolWindow(page, 'Lighting');
  await expect(env).toBeVisible();
  await expect(lit).toBeVisible();
  const stage = await boxOf(page.locator('.tl-app__stage'));
  for (const w of [env, lit]) {
    const b = await boxOf(w);
    expect(b.x >= stage.x && b.x + b.width <= stage.x + stage.width && b.y >= stage.y && b.y < stage.y + stage.height, `${JSON.stringify(b)} inside the Scene view ${JSON.stringify(stage)}`).toBe(true);
  }
  // The last one opened is on top.
  expect(Number(await lit.evaluate((el) => getComputedStyle(el).zIndex))).toBeGreaterThan(Number(await env.evaluate((el) => getComputedStyle(el).zIndex)));
  for (const name of ['Environment', 'Lighting']) {
    await expect(toolWindowScene(page, name)).toHaveAttribute('data-scene-id', 'scene-main');
    await expect(toolWindowScene(page, name).getByRole('combobox')).toHaveValue('scene-main');
    await expect(toolWindowScene(page, name).getByRole('combobox').locator('option')).toHaveText(['Main', 'Two']);
  }
  await expect(lit.getByLabel('bake status')).toContainText('No bake for this scene.');
  await page.screenshot({ path: 'test-results/window-tools.png' });

  // The Environment window's picker: Two (closed until now) opens and becomes active; both windows follow, so does the Scene view.
  await toolWindowScene(page, 'Environment').getByRole('combobox').selectOption('scene-two');
  await expect(header(page, 'Two')).toHaveClass(/is-active/);
  for (const name of ['Environment', 'Lighting']) await expect(toolWindowScene(page, name)).toHaveAttribute('data-scene-id', 'scene-two');
  await expect.poll(blue, { timeout: 20_000, message: "Two's blue sky" }).toBe(true);
  await env.getByRole('combobox', { name: 'fog mode' }).selectOption('exp2');
  await expect.poll(async () => (await looks())['scene-two']).toMatchObject({ fog: { mode: 'exp2' } });
  expect((await looks())['scene-main']).toEqual({ sky: { mode: 'color', color: '#d02020' } });

  // The Lighting window's picker back to Main: its edits go to Main only.
  await toolWindowScene(page, 'Lighting').getByRole('combobox').selectOption('scene-main');
  await expect(header(page, 'Main')).toHaveClass(/is-active/);
  for (const name of ['Environment', 'Lighting']) await expect(toolWindowScene(page, name)).toHaveAttribute('data-scene-id', 'scene-main');
  await expect(env.getByRole('combobox', { name: 'fog mode' })).toHaveValue('none');
  await expect.poll(red, { timeout: 20_000, message: "Main's red sky again" }).toBe(true);
  await env.getByRole('combobox', { name: 'sky mode' }).selectOption('gradient');
  await expect.poll(async () => (await looks())['scene-main']).toMatchObject({ sky: { mode: 'gradient' } });
  expect((await looks())['scene-two']).toMatchObject({ sky: { mode: 'color', color: '#2040d0' }, fog: { mode: 'exp2' } });

  // Moved by the title bar, resized by the corner; both remembered over a reload.
  const before = await boxOf(env);
  const title = await boxOf(env.getByLabel('Move the Environment window'));
  await page.mouse.move(title.x + 40, title.y + title.height / 2);
  await page.mouse.down();
  await page.mouse.move(title.x + 40 - 300, title.y + title.height / 2 + 60, { steps: 6 });
  await page.mouse.up();
  const corner = await boxOf(env.getByLabel('Resize the Environment window'));
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down();
  await page.mouse.move(corner.x + corner.width / 2 + 50, corner.y + corner.height / 2 - 100, { steps: 4 });
  await page.mouse.up();
  const moved = await boxOf(env);
  expect(moved).toEqual({ x: before.x - 300, y: before.y + 60, width: before.width + 50, height: before.height - 100 });
  // Closed with ×: it stays closed over the reload; the moved one comes back where it was.
  await lit.getByRole('button', { name: 'Close the Lighting window' }).click();
  await expect(lit).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect(env).toBeVisible();
  expect(await boxOf(env)).toEqual(moved);
  await expect(lit).toHaveCount(0);

  // The Game view sets them aside; the Scene view brings them back.
  await showView(page, 'Game');
  await expect(env).toHaveCount(0);
  await showView(page, 'Scene');
  await expect(env).toBeVisible();
  // Window → Lighting again: where it was.
  await menu(page, 'Window', 'Lighting');
  await expect(lit).toBeVisible();
  await expect(toolWindowScene(page, 'Lighting')).toHaveAttribute('data-scene-id', 'scene-main');
});

test("a block layer's tools in the Inspector; a prefab from the selection; an audio asset's Inspector; Project Settings → Audio", async ({ page }) => {
  test.setTimeout(180_000);
  be = await startBackend('window-tools-selection');
  const layer = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Ground', transform: { position: [0, 0, 0] } }))['createdId']);
  await cmd('setComponent', { entityId: layer, component: 'blockLayer', value: { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [16, 8, 16] } } });
  const crate = String((await cmd('createEntity', { parentId: null, kind: 'box', name: 'Crate', transform: { position: [3, 0.5, 0] }, box: { size: [1, 1, 1], material: { color: '#a07040' } } }))['createdId']);
  await cmd('createEntity', { parentId: null, kind: 'box', name: 'Barrel', transform: { position: [-3, 0.5, 0] }, box: { size: [1, 1, 1], material: { color: '#4070a0' } } });
  const sound = await publishWav(be, 'cue-goal.wav', 'sfx-ping', 'ping');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const tools = inspector(page).getByLabel('blocks panel', { exact: true });

  // ---- Block tools: shown while a block layer is selected, with that layer.
  await expect(tools).toHaveCount(0);
  await row(page, 'Ground').click();
  await expect(tools).toBeVisible();
  await expect(tools.getByLabel('block layer')).toHaveValue(layer);
  await page.screenshot({ path: 'test-results/window-tools-blocks.png' });
  const canvas = page.locator('canvas.tl-viewport');
  await expect(canvas).toHaveAttribute('data-block-tool', 'single');
  // Armed, the tools own the left button: the layer's move gizmo stands aside; disarmed ("Edit cells" off) it is back.
  await expect(canvas).toHaveAttribute('data-gizmo-grab', 'null');
  await tools.getByLabel('edit cells').uncheck();
  await expect(canvas).toHaveAttribute('data-block-tool', '');
  await expect(canvas).not.toHaveAttribute('data-gizmo-grab', 'null');
  await tools.getByLabel('edit cells').check();
  await expect(canvas).toHaveAttribute('data-gizmo-grab', 'null');
  await row(page, 'Crate').click();
  await expect(tools).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-block-tool', '');
  await expect(canvas).not.toHaveAttribute('data-gizmo-grab', 'null');
  // GameObject → Block layer: a new layer, selected, its tools showing.
  await menu(page, 'GameObject', 'Block layer');
  await expect(tools).toBeVisible();
  const layers = async (): Promise<string[]> => ((await query('queryEntities', { limit: 200, offset: 0 })) as { entities: { id: string; components: Record<string, unknown> }[] }).entities.filter((e) => e.components['blockLayer'] !== undefined).map((e) => e.id);
  await expect.poll(async () => (await layers()).length).toBe(2);
  const made = (await layers()).find((id) => id !== layer)!;
  await expect(tools.getByLabel('block layer')).toHaveValue(made);
  // Choosing the other layer in the tools selects it.
  await tools.getByLabel('block layer').selectOption(layer);
  await expect(page.locator(`.tl-hierarchy__list li[data-entity-id="${layer}"]`)).toHaveAttribute('aria-selected', 'true');

  // ---- A prefab from the selection: the GameObject menu, then the Hierarchy's context menu.
  const prefabs = async (): Promise<{ prefabId: string; displayName: string }[]> => ((await query('queryPrefabs', {}))['prefabs'] as { prefabId: string; displayName: string }[]) ?? [];
  await expect(await menuItem(page, 'GameObject', 'Create prefab from selection')).toBeEnabled();
  await page.keyboard.press('Escape');
  await row(page, 'Crate').click();
  await menu(page, 'GameObject', 'Create prefab from selection');
  await expect.poll(async () => (await prefabs()).map((d) => d.displayName)).toEqual(['Crate']);
  await expect(page.locator('.tl-notice')).toContainText('Prefab “Crate” created');
  // Right-click a row outside the selection: it is selected, and the menu acts on it.
  await row(page, 'Barrel').click({ button: 'right' });
  const context = page.getByRole('menu', { name: 'Hierarchy context menu' });
  await expect(context).toBeVisible();
  await expect(page.locator(`.tl-hierarchy__list li[data-entity-id="${crate}"]`)).toHaveAttribute('aria-selected', 'false');
  await context.getByRole('menuitem', { name: 'Create prefab from selection' }).click();
  await expect(context).toHaveCount(0);
  await expect.poll(async () => (await prefabs()).map((d) => d.displayName).sort()).toEqual(['Barrel', 'Crate']);
  // Escape closes the context menu without acting.
  await row(page, 'Barrel').click({ button: 'right' });
  await expect(context).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(context).toHaveCount(0);
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toHaveCount(1);

  // ---- An audio asset chosen in the project window: its Inspector.
  const panel = await projectWindow(page);
  await panel.getByLabel('search the project').fill('ping');
  await panel.locator('.tl-assets__list li.tl-tile').filter({ has: page.locator('.tl-tile__name', { hasText: /^ping$/ }) }).first().click();
  const audio = inspector(page).getByLabel('audio asset inspector');
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute('data-asset-id', sound);
  await expect(audio.getByTestId('audio-facts')).toContainText('WAV');
  await page.screenshot({ path: 'test-results/window-tools-audio.png' });
  // Its options show once, in the Inspector: one place for an asset's options.
  await expect(page.getByLabel('audio load type')).toHaveCount(1);
  await audio.getByLabel('audio load type').selectOption('stream');
  await expect.poll(async () => ((await query('queryAssets', { assetId: sound }))['assets'] as { audio: { loadType: string; loadTypeSet: boolean } }[])[0]!.audio).toMatchObject({ loadType: 'stream', loadTypeSet: true });
  await audio.getByLabel('audio preload').click();
  await expect.poll(async () => ((await query('queryAssets', { assetId: sound }))['assets'] as { audio: { preload: boolean } }[])[0]!.audio.preload).toBe(false);
  // Listening: nothing plays before the explicit unlock.
  const listen = audio.getByRole('button', { name: 'listen to ping' });
  await expect(listen).toBeDisabled();
  await audio.getByRole('button', { name: 'enable preview sound' }).click();
  await expect(audio.locator('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready');
  await listen.click();
  await expect(audio.locator('.tl-media__diag')).toHaveCount(0);
  // Selecting an object brings the Inspector back to it.
  await row(page, 'Crate').click();
  await expect(audio).toHaveCount(0);
  await expect(inspector(page).locator('input.tl-inspector__name')).toHaveValue('Crate');

  // ---- Project Settings → Audio: the event sounds; the search finds the sub-tab.
  await openProjectSettings(page, 'Audio');
  await expect(settingsWindow(page).getByLabel('event sounds')).toBeVisible();
  await settingsWindow(page).getByLabel('Search project settings').fill('event sounds');
  await expect(settingsTab(page, 'Audio')).toBeVisible();
  await expect(settingsWindow(page).getByRole('tab')).toHaveCount(1);
});
