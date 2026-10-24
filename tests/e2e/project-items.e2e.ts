/**
 * Every kind of item is made, found, shown and deleted from the project
 * window, against the real backend and Chromium:
 *
 * - the Create menu (its button, and a right-click on the list) makes a
 *   material, a graph material from a template, an animator controller from
 *   the chosen model's clips, a graph, an effect, a conversation, a timeline,
 *   a script library, a UI document, a UI theme and a kit, each named where
 *   the menu asks, in the folder the window shows (read back over HTTP), each
 *   with an editor opening in it (a kit in the kit editor, listing its slots,
 *   with no address or labels: kits are never loadable);
 * - a click shows the item in the one Inspector: an asset's facts and
 *   placing it, a shader material's values, a prefab's "place copy", a
 *   resource's name (a rename is one command), its address and labels;
 * - a right-click deletes an item (its editor closes); a refused delete says
 *   why under the item.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from './pw';

import { startBackend, STARTER, type E2EBackend } from './backend';
import { skinnedGlb } from './skinned-glb';
import { chooseItem, closeEditor, closeProjectSettings, createItem, editorTab, expectEditorOpen, inspector, openProjectSettings, projectWindow, settingsWindow } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

const revision = async (): Promise<number> => Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} }))['revision']);
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-project-items' }, args });
  expect(res['ok'], `${op}: ${JSON.stringify(res).slice(0, 400)}`).toBe(true);
  return res;
}
/** An item's index entry over HTTP (undefined: not in the project). */
async function entry(kind: string, id: string): Promise<{ id: string; name: string; path: string | null } | undefined> {
  const r = await be.command({ op: 'queryIndex', projectId: be.projectId, args: { kind, ids: [id], refs: false } });
  return ((r['entries'] as { id: string; name: string; path: string | null }[] | undefined) ?? [])[0];
}

async function open(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
}

/** The skinned test model (it has clips), imported through the project window. */
async function importModel(page: Page): Promise<string> {
  const ids = async (): Promise<string[]> => ((await be.command({ op: 'queryAssets', projectId: be.projectId, args: { limit: 100, offset: 0 } }))['assets'] as { assetId: string }[]).map((a) => a.assetId);
  const before = await ids();
  const dir = mkdtempSync(join(tmpdir(), 'tl-items-'));
  const file = join(dir, 'column.glb');
  writeFileSync(file, skinnedGlb());
  const panel = await projectWindow(page);
  await panel.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = panel.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await expect.poll(async () => (await ids()).length).toBe(before.length + 1);
  return (await ids()).find((id) => !before.includes(id))!;
}

/** Show a folder of the game folder in the project window (made when it is not there). */
async function showFolder(page: Page, folder: string): Promise<void> {
  const panel = await projectWindow(page);
  await panel.getByLabel('search the project').fill('');
  const node = panel.getByRole('button', { name: `folder ${folder}`, exact: true });
  if ((await node.count()) === 0) {
    await panel.getByRole('button', { name: 'folder (game folder)', exact: true }).click();
    await panel.getByRole('button', { name: 'new folder', exact: true }).click();
    await panel.getByLabel('folder name', { exact: true }).fill(folder);
    await panel.getByLabel('folder name', { exact: true }).press('Enter');
  }
  await node.click();
  await expect(panel.locator('.tl-project')).toHaveAttribute('data-folder', folder);
}

/** The bottom dock holds the project window, Console and Problems only; the Window menu lists just those; speakers are a project setting (a fresh editor open). */
async function dockAndWindowMenu(page: Page): Promise<void> {

  // The dock's own tab strip: three tabs, in this order.
  const tabs = page.locator('.tl-dock--bottom > [role="tablist"] > [role="tab"]');
  await expect(tabs).toHaveCount(3);
  expect((await tabs.allTextContents()).map((t) => t.replace(/\d+$/, ''))).toEqual(['Project', 'Console', 'Problems']);
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

  // The Window menu lists those three among its windows, and none of the tabs that went.
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Window', exact: true }).click();
  const items = await page.getByRole('menu').getByRole('menuitem').allTextContents();
  await page.keyboard.press('Escape');
  for (const kept of ['Project', 'Console', 'Problems', 'Lighting', 'Environment']) expect(items.some((t) => t.startsWith(kept)), kept).toBe(true);
  for (const gone of ['Assets', 'Materials', 'Animator', 'Prefabs', 'Graphs', 'Effects', 'Dialogue', 'Timelines', 'Libraries', 'UI', 'Behaviors', 'Gameplay', 'Media', 'Blocks']) expect(items.some((t) => t === gone), gone).toBe(false);

  // GameObject → Prefab copy… lists the prefabs in the project window.
  await cmd('createPrefab', { prefabId: 'crate', displayName: 'Crate', sourceEntityId: STARTER.groundId });
  await page.getByRole('menubar').getByRole('menuitem', { name: 'GameObject', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Prefab copy…', exact: true }).click();
  await expect(page.locator('.tl-assets').getByLabel('search the project')).toHaveValue('t:prefab');
  await expect(page.locator('.tl-assets__list li[data-item-id="crate"]')).toBeVisible();

  // Speakers and the dialogue settings: Project Settings → Dialogue (one command each).
  await openProjectSettings(page, 'Dialogue');
  const win = settingsWindow(page);
  await win.getByLabel('speaker name', { exact: true }).fill('Guide');
  await win.getByRole('button', { name: 'save speaker', exact: true }).click();
  await expect.poll(async () => JSON.stringify((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['speakers'] ?? [])).toContain('"speakerId":"guide"');
  await win.getByLabel('text speed', { exact: true }).fill('25');
  await win.getByRole('button', { name: 'apply dialogue settings', exact: true }).click();
  await expect.poll(async () => JSON.stringify((await be.command({ op: 'queryGameConfig', projectId: be.projectId }))['dialogueSettings'] ?? {})).toContain('"textSpeed":25');
  await closeProjectSettings(page);
}

// The dock check first, on the fresh editor; the Create menu part then works in the same project (it makes no prefab or speaker).
test('the bottom dock holds the project window, Console and Problems only; the Window menu lists just those; speakers are a project setting; the Create menu makes every kind in the folder shown and opens it in its editor', async ({ page }) => {
  test.setTimeout(300_000);
  be = await startBackend('project-items-0001', 'starter');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await open(page);
  await test.step('the bottom dock holds the project window, Console and Problems only; the Window menu lists just those; speakers are a project setting', () => dockAndWindowMenu(page));
  const model = await importModel(page);

  // A new animator controller takes the clips of the model chosen in the project window.
  await chooseItem(page, 'model', 'column');
  await showFolder(page, 'made');

  // [menu entry, name typed, project kind, the editor it opens in (null: the Inspector)]
  const made: [string | readonly [string, string], string, string, Parameters<typeof expectEditorOpen>[1] | null][] = [
    ['Material', 'Brick', 'material', null],
    [['Graph material', 'Water'], 'Pond', 'material', 'Material'],
    ['Animator controller', 'Poser', 'animator', 'Animator'],
    [['Graph', 'Test graph'], 'Maths', 'graph', 'Graph'],
    ['Effect', 'Sparks', 'effect', 'Effect'],
    ['Dialogue', 'Greeting', 'dialogue', 'Dialogue'],
    ['Timeline', 'Intro', 'timeline', 'Timeline'],
    ['Script library', 'Scoring', 'library', 'Library'],
    ['UI document', 'Hud', 'ui', 'UI'],
    ['UI theme', 'Neutral', 'uitheme', 'UI theme'],
    ['Kit', 'Town', 'kit', 'Kit'],
  ];
  for (const [what, name, kind, editor] of made) {
    await createItem(page, what, name);
    if (editor !== null) await expectEditorOpen(page, editor, name);
    else await expect(inspector(page).getByLabel(`${kind} inspector`)).toBeVisible();
    // Made in the folder shown, under the id its name gives.
    const id = name.toLowerCase();
    await expect.poll(async () => (await entry(kind, id))?.path ?? '', { message: `${kind} ${name}` }).toMatch(/^made\//);
    expect((await entry(kind, id))?.name).toBe(name);
  }
  // The kit (made last) opens in the kit editor: its empty standard slots, its own tile picture, no address or labels.
  const kitSlots = page.getByLabel('kit slots', { exact: true });
  await expect(kitSlots.locator('[data-slot="door"]')).toContainText('Drop a GLB or a piece');
  await expect(kitSlots.locator('li')).toHaveCount(7);
  await expect(inspector(page).getByLabel('kit inspector')).toBeVisible();
  await expect(inspector(page).getByLabel('address', { exact: true })).toHaveCount(0);
  const kitTile = (await projectWindow(page)).locator('[data-item-kind="kit"][data-item-id="town"] img');
  await expect.poll(() => kitTile.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(96);
  // The controller plays the chosen model's first clip.
  const animator = (await be.command({ op: 'queryIndex', projectId: be.projectId, args: { kind: 'animator', ids: ['poser'], records: true, refs: false } }))['entries'] as { record: { states: { motion: { clip: { assetId: string } } }[] } }[];
  expect(animator[0]!.record.states[0]!.motion.clip.assetId).toBe(model);
  // The Pond material came from the water template (a graph).
  const pond = (await be.command({ op: 'queryIndex', projectId: be.projectId, args: { kind: 'material', ids: ['pond'], records: true, refs: false } }))['entries'] as { record: { graph?: { nodes: unknown[] } } }[];
  expect(pond[0]!.record.graph?.nodes.length ?? 0).toBeGreaterThan(1);

  // A right-click on the list offers the same Create menu; a taken name gets a numbered id.
  await closeEditor(page);
  const panel = await projectWindow(page);
  await panel.locator('.tl-project__list').click({ button: 'right', position: { x: 20, y: 20 } });
  const menu = page.getByRole('menu', { name: 'project window menu', exact: true });
  await menu.getByRole('menuitem', { name: 'Create', exact: true }).click();
  await menu.getByRole('menu', { name: 'Create', exact: true }).getByRole('menuitem', { name: 'Material', exact: true }).click();
  // Material opens the New material dialog (Standard picked): its name field, Enter creates.
  const dialog = page.getByRole('dialog', { name: 'New material' });
  await dialog.getByLabel('new item name', { exact: true }).fill('Brick');
  await dialog.getByLabel('new item name', { exact: true }).press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(inspector(page).getByLabel('material inspector')).toBeVisible();
  await expect.poll(async () => (await entry('material', 'brick-2'))?.path ?? '').toMatch(/^made\//);
  expect(errors).toEqual([]);
});

test('a chosen item shows in the Inspector: assets, shader materials, prefabs and resources; rename and delete from there and the right-click menu', async ({ page }) => {
  test.setTimeout(180_000);
  be = await startBackend('project-items-0002', 'starter');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await cmd('setMaterial', { material: { materialId: 'stone', name: 'Stone', shader: 'standard', params: {}, textures: {} } });
  await cmd('setEffect', { effect: { effectId: 'fx-one', name: 'Effect One', duration: 2, loop: true, seed: 1, bounds: { center: [0, 1, 0], size: [4, 4, 4] }, systems: [] } });
  await cmd('setTimeline', { timeline: { timelineId: 'tl-one', name: 'Timeline One', duration: 5, tracks: [] } });
  await cmd('createPrefab', { prefabId: 'crate', displayName: 'Crate', sourceEntityId: STARTER.groundId });
  await open(page);
  const entities = async (): Promise<number> => Number((await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 1 } }))['total'] ?? 0);

  // A model: its asset Inspector; "place" puts one where the camera looks.
  const firstModel = ((await be.command({ op: 'queryIndex', projectId: be.projectId, args: { kind: 'model', limit: 1, refs: false } }))['entries'] as { name: string }[])[0]!;
  await chooseItem(page, 'model', firstModel.name);
  const asset = inspector(page).locator('[aria-label="model asset inspector"]');
  await expect(asset).toBeVisible();
  await expect(asset.getByRole('combobox', { name: 'vertex colour' })).toBeVisible();
  const before = await entities();
  await asset.getByRole('button', { name: 'place', exact: true }).click();
  await expect.poll(entities).toBe(before + 1);

  // A shader material: its values in the Inspector, each one command.
  await chooseItem(page, 'material', 'Stone');
  await inspector(page).getByRole('combobox', { name: 'shader', exact: true }).selectOption('unlit');
  await expect.poll(async () => ((await be.command({ op: 'queryIndex', projectId: be.projectId, args: { kind: 'material', ids: ['stone'], records: true, refs: false } }))['entries'] as { record: { shader: string } }[])[0]!.record.shader).toBe('unlit');

  // A prefab: place a copy from its Inspector.
  await chooseItem(page, 'prefab', 'Crate');
  // Its id is shown: a script spawns the prefab by it.
  await expect(inspector(page).getByLabel('prefab id', { exact: true })).toContainText('crate');
  const copies = await entities();
  await inspector(page).getByRole('button', { name: 'place copy', exact: true }).click();
  await expect.poll(entities).toBeGreaterThan(copies);
  // Its name field renames it (one command; the contents stay).
  const prefabNow = async (): Promise<{ displayName: string; entities: unknown[] }> => ((await be.command({ op: 'queryPrefabs', projectId: be.projectId, args: { prefabId: 'crate', includeEntities: true } }))['prefabs'] as { displayName: string; entities: unknown[] }[])[0]!;
  const prefabName = inspector(page).getByLabel('prefab name', { exact: true });
  await prefabName.fill('Crate box');
  await prefabName.press('Enter');
  await expect.poll(async () => (await prefabNow()).displayName).toBe('Crate box');
  await cmd('undo', {});
  await expect.poll(async () => (await prefabNow()).displayName).toBe('Crate');

  // Opened on its own (a double-click): only the prefab is shown; a field changed in its Inspector changes the prefab
  // (one command), the placed copy shows it once the editor is back on the scene; Esc leaves.
  const sizeOf = async (): Promise<number | undefined> => ((await be.command({ op: 'queryPrefabs', projectId: be.projectId, args: { prefabId: 'crate', includeEntities: true } }))['prefabs'] as { entities: { components: { box?: { size: number[] } } }[] }[])[0]!.entities[0]!.components.box?.size[0];
  const copyId = ((await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 500 } }))['entities'] as { id: string; components: { prefab?: { prefabId: string } } }[]).find((e) => e.id !== STARTER.groundId && e.components.prefab?.prefabId === 'crate')!.id;
  await chooseItem(page, 'prefab', 'Crate');
  await page.locator('.tl-assets li[data-item-id="crate"]').dblclick();
  const mode = page.locator('section.tl-editmode[data-edit-mode="prefab"]');
  await expect(mode).toBeVisible();
  await expect(page.locator('[data-tl-inspector]')).toHaveCount(0);
  await mode.getByRole('tree', { name: 'prefab objects', exact: true }).getByRole('button').first().click();
  await expect(inspector(page)).toHaveAttribute('data-tl-inspector', 'edit');
  const size = inspector(page).getByLabel('box size w', { exact: true });
  await size.fill('7');
  await size.press('Enter');
  await expect.poll(sizeOf).toBe(7);
  // The GameObject menu makes an object inside the open prefab (under its chosen object), not in the scene.
  await page.getByRole('menuitem', { name: 'GameObject', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Box', exact: true }).click();
  await expect.poll(async () => (await prefabNow()).entities.length).toBe(2);
  await cmd('undo', {});
  await expect.poll(async () => (await prefabNow()).entities.length).toBe(1);
  await page.keyboard.press('Escape');
  await expect(mode).toHaveCount(0);
  const row = page.locator(`.tl-hierarchy__list li.tl-row[data-entity-id="${copyId}"]`);
  await row.click();
  await expect(inspector(page).getByLabel('box size w', { exact: true })).toHaveValue('7');

  // The copy: its Inspector names its prefab, the Hierarchy marks it a prefab part with the prefab's name.
  const copyBox = inspector(page).getByLabel('prefab copy', { exact: true });
  await expect(copyBox.getByLabel('copy prefab', { exact: true })).toHaveText('Crate');
  await expect(row).toHaveClass(/is-prefab-part/);
  await expect(row.locator('.tl-row__prefab')).toHaveText('Crate');
  // A field changed on the copy is its override, marked in the Inspector; its right-click menu reverts it.
  const overrides = async (): Promise<number> => (((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: copyId } }))['prefabCopy'] as { overrides: unknown[] } | undefined)?.overrides ?? []).length;
  const height = inspector(page).getByLabel('box size h', { exact: true });
  const marked = inspector(page).locator('[data-component="box"] [data-overridden="size"] > *');
  await height.fill('3');
  await height.press('Enter');
  await expect.poll(overrides).toBe(1);
  await expect(marked).toHaveCount(1);
  await marked.click({ button: 'right', position: { x: 4, y: 4 } });
  await page.getByRole('menu', { name: 'override menu', exact: true }).getByRole('menuitem', { name: 'Revert', exact: true }).click();
  await expect.poll(overrides).toBe(0);
  await expect(marked).toHaveCount(0);
  // Another, applied to the prefab from the Overrides list: the prefab has it and the copy no longer overrides it.
  const heightOf = async (): Promise<number | undefined> => ((await be.command({ op: 'queryPrefabs', projectId: be.projectId, args: { prefabId: 'crate', includeEntities: true } }))['prefabs'] as { entities: { components: { box?: { size: number[] } } }[] }[])[0]!.entities[0]!.components.box?.size[1];
  await height.fill('4');
  await height.press('Enter');
  await expect.poll(overrides).toBe(1);
  await copyBox.getByText('Overrides (1)', { exact: true }).click();
  await copyBox.getByRole('button', { name: /^apply .*: box size$/ }).click();
  await expect.poll(heightOf).toBe(4);
  await expect.poll(overrides).toBe(0);
  // Unpacked: plain objects that no longer follow the prefab; one undo links the copy again (the delete below needs it).
  await copyBox.getByRole('button', { name: 'Unpack', exact: true }).click();
  await expect(row).not.toHaveClass(/is-prefab-part/);
  await expect(copyBox).toHaveCount(0);
  await cmd('undo', {});
  await expect(row).toHaveClass(/is-prefab-part/);

  // A resource: renamed in the Inspector (one command), its address set.
  await chooseItem(page, 'effect', 'Effect One');
  const name = inspector(page).getByLabel('effect name', { exact: true });
  await name.fill('Fountain');
  await name.press('Enter');
  await expect.poll(async () => (await entry('effect', 'fx-one'))?.name).toBe('Fountain');
  await expect(inspector(page).locator('.tl-panel__title')).toHaveText('Inspector — Fountain');

  // Deleted from the right-click menu: gone from the project, its open editor closed.
  await closeEditor(page);
  const panel = await projectWindow(page);
  await panel.getByLabel('search the project').fill('t:timeline');
  await panel.locator('li[data-item-id="tl-one"]').dblclick();
  await expectEditorOpen(page, 'Timeline', 'Timeline One');
  await projectWindow(page);
  await panel.locator('li[data-item-id="tl-one"]').click({ button: 'right' });
  await page.getByRole('menu', { name: 'project window menu', exact: true }).getByRole('menuitem', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => entry('timeline', 'tl-one')).toBeUndefined();
  await expect(editorTab(page, 'Timeline', 'Timeline One')).toHaveCount(0);

  // A refused delete says why under the item: the prefab has a placed copy.
  await chooseItem(page, 'prefab', 'Crate');
  await inspector(page).getByRole('button', { name: 'delete prefab Crate', exact: true }).click();
  await expect(inspector(page).getByTestId('prefab-delete-error')).toBeVisible();
  expect(await entry('prefab', 'crate')).toBeDefined();
  expect(errors).toEqual([]);
});
