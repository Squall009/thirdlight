/**
 * The editor window. A double-click in the project window opens the item in
 * a full window over the editor — its editor on the left, the one Inspector
 * on the right, one splitter whose width is remembered; several open items
 * are tabs of the window (switch, reorder by drag, close, middle-click,
 * Ctrl+Tab), remembered over a reload. Esc or × return to the default view
 * with the selection it had; undo, the change feed and MCP edits reach the
 * open editor. The default view's centre keeps the Scene and Game views only.
 * A kit opens in the kit editor: a GLB dropped on a slot is imported and its
 * piece checks fail or pass in the slot's panel; the Preview panel shows the
 * piece; the Inspector links to the panels.
 *
 * An object's edit mode (a terrain's) takes the same place: a double-click
 * (Hierarchy, Scene view) or the Inspector's Edit opens it over the work area
 * with the live Scene view lent to it with input; only the object is drawn
 * (Context shows the rest, not pickable); its rail, edits, undo, MCP edits,
 * Play setting it aside and Esc work there.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { multiPieceGlb } from './multi-piece-glb';
import { skinnedGlb } from './skinned-glb';
import { decodePng } from './png';
import { makePng } from './png-make';
import { publishTexture } from './painted-layers';
import { editMode, editModeTab, editorPane, editorTab, editorWindow, editPanel, inspector, menu, openEditor, openPanel, projectWindow } from './ui';

let be: E2EBackend;
let seq = 0;
test.beforeEach(async () => {
  be = await startBackend('editor-window-0001');
});
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0x16a000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-editor-window' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}
const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });

const windowTabs = (page: Page): Promise<string[]> => editorWindow(page).getByRole('tablist', { name: 'open items' }).getByRole('tab').allTextContents();
const centreTabs = (page: Page): Promise<string[]> => page.locator('.tl-tabs--center [role="tab"]').allTextContents();
const row = (page: Page, id: string) => page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`);
const box = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;

async function open(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
}

/** Double-click an item of the project window, found by its search. */
async function doubleClickItem(page: Page, kind: string, id: string): Promise<void> {
  const panel = await projectWindow(page);
  await panel.getByRole('button', { name: 'folder (game folder)', exact: true }).click();
  await panel.getByLabel('search the project').fill(`t:${kind} ${id}`);
  await panel.locator(`li.tl-project__item[data-item-id="${id}"]`).dblclick();
}

test('items open in a window over the editor: editor left, the one Inspector right; tabs; Esc returns with the selection', async ({ page }) => {
  test.setTimeout(180_000);
  // Neutral fixtures: two declared behaviors, an object to select and (below) a one-state animator controller.
  await cmd('publishBehavior', { behaviorId: 'mover', displayName: 'Mover', mode: 'declaration-create', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 2 }] } });
  await cmd('publishBehavior', { behaviorId: 'door', displayName: 'Door', mode: 'declaration-create', declaration: { properties: [{ key: 'open', label: 'Open', type: 'boolean', default: false }] } });
  const crate = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Crate', box: { size: [1, 1, 1], material: { color: '#b0b0b0' } }, transform: { position: [0, 0.5, 0] } }))['createdId']);
  await open(page);
  const dir = mkdtempSync(join(tmpdir(), 'tl-ewin-'));
  writeFileSync(join(dir, 'column.glb'), skinnedGlb());
  await page.locator('.tl-assets__file').first().setInputFiles(join(dir, 'column.glb'));
  rmSync(dir, { recursive: true, force: true });
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const listAssets = async (): Promise<{ assetId: string }[]> => (await query('queryAssets', { limit: 10, offset: 0 }))['assets'] as { assetId: string }[];
  await expect.poll(async () => (await listAssets()).length).toBe(1);
  const asset = (await listAssets())[0]!.assetId;
  const controller = (name: string): Record<string, unknown> => ({
    controllerId: 'animator-01',
    name,
    parameters: [{ name: 'speed', type: 'float', default: 0 }],
    states: [{ id: 'state-01', name: 'Idle', motion: { kind: 'clip', clip: { assetId: asset, clip: 'idle', duration: 1 } }, speed: 1, loop: true, position: [180, 40] }],
    transitions: [],
    entry: 'state-01',
    events: [],
  });
  await cmd('setAnimator', { controller: controller('Walker') });

  // The default view: the centre has the Scene and Game views only, no window, the Inspector on the right dock.
  expect(await centreTabs(page)).toEqual(['Scene', 'Game']);
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(inspector(page)).toHaveAttribute('data-tl-inspector', 'dock');
  await row(page, crate).click();
  await expect(row(page, crate)).toHaveAttribute('aria-selected', 'true');

  // A double-click in the project window opens the script in the window, over the whole editor.
  await doubleClickItem(page, 'behavior', 'mover');
  const win = editorWindow(page);
  await expect(win).toBeVisible();
  expect(await windowTabs(page)).toEqual(['Script: Mover']);
  await expect(editorTab(page, 'Script', 'Mover')).toHaveAttribute('aria-selected', 'true');
  const scriptView = editorPane(page, 'Script', 'Mover');
  await expect(scriptView.getByLabel('declaration editor')).toHaveAttribute('data-behavior', 'mover');
  // Over the editor: it covers the Hierarchy and the bottom dock, which take no input underneath.
  const w = (await win.boundingBox())!;
  const hier = await box(page, '.tl-dock--left');
  const dock = await box(page, '.tl-dock--bottom');
  expect(w.x).toBeLessThanOrEqual(hier.x + 1);
  expect(w.y + w.height).toBeGreaterThanOrEqual(dock.y + dock.height - 1);
  const area = await box(page, '.tl-app__workarea');
  expect(Math.abs(w.width - area.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(w.height - area.height)).toBeLessThanOrEqual(1);
  await expect(page.locator('.tl-app__body')).toHaveAttribute('inert', '');
  // Editor left, the one Inspector right (moved into the window, not a second copy).
  await expect(inspector(page)).toHaveCount(1);
  const insp = inspector(page);
  await expect(insp).toHaveAttribute('data-tl-inspector', 'window');
  const pane = (await scriptView.boundingBox())!;
  const ib = (await insp.boundingBox())!;
  expect(pane.x + pane.width).toBeLessThanOrEqual(ib.x + 1);
  expect(ib.x + ib.width).toBeGreaterThanOrEqual(w.x + w.width - 1);
  expect(await win.locator('[data-tl-inspector]').count()).toBe(1);
  // The centre under the window still has only Scene and Game.
  expect(await centreTabs(page)).toEqual(['Scene', 'Game']);
  // A real editor: the edit reaches the backend.
  await scriptView.getByLabel('property 1 default', { exact: true }).fill('5');
  await scriptView.getByRole('button', { name: 'Save declaration' }).click();
  await expect
    .poll(async () => ((await query('queryBehaviors', { includeDeclaration: true, limit: 50, offset: 0 }))['behaviors'] as { behaviorId: string; declaration?: { properties: { default: unknown }[] } }[]).find((b) => b.behaviorId === 'mover')?.declaration?.properties[0]?.default)
    .toBe(5);

  // A box made from the menu bar while the window shows, and Esc before the box's command answered (its
  // answer is held back): closing the window returns to the default view with the selection it had when
  // the window opened, and the late answer does not replace it.
  let created!: () => void;
  const answered = new Promise<void>((r) => { created = r; });
  await page.route(/\/commands$/, async (route) => {
    if (!(route.request().postData() ?? '').includes('"createEntity"')) return route.fallback();
    const res = await route.fetch();
    await new Promise((r) => setTimeout(r, 800));
    await route.fulfill({ response: res });
    created();
  });
  await menu(page, 'GameObject', 'Box');
  await page.keyboard.press('Escape');
  await expect(win).toHaveCount(0);
  await answered;
  await expect.poll(async () => page.locator('.tl-hierarchy__list li[data-entity-id]').count()).toBeGreaterThan(1);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await expect(row(page, crate)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tl-hierarchy__list li[aria-selected="true"]')).toHaveCount(1);
  await expect(inspector(page)).toHaveAttribute('data-tl-inspector', 'dock');
  await page.unroute(/\/commands$/);

  // A second item joins the window's tabs (the window's tabs stayed while it was closed).
  await openEditor(page, 'Animator', 'Walker');
  expect(await windowTabs(page)).toEqual(['Script: Mover', 'Animator: Walker']);
  const animView = editorPane(page, 'Animator', /Walker/);
  await expect(animView.getByLabel('animator graph').getByRole('group', { name: 'State Idle node state-01' })).toBeVisible();
  // The Inspector in the window shows the animator's selection.
  await expect(inspector(page).locator('[aria-label="animator inspector"]')).toHaveCount(1);
  // An edit from the window, undone with Ctrl+Z while it shows; an MCP edit reaches the open tab.
  const storedName = async (): Promise<string | undefined> => ((await query('queryGameConfig'))['animators'] as { controllerId: string; name: string }[] | undefined)?.find((c) => c.controllerId === 'animator-01')?.name;
  await animView.getByLabel('animator name').fill('Walker B');
  await animView.getByLabel('animator name').blur();
  await expect(editorTab(page, 'Animator', 'Walker B')).toBeVisible();
  await expect.poll(storedName).toBe('Walker B');
  await page.keyboard.press('Control+z');
  await expect.poll(storedName).toBe('Walker');
  await expect(editorTab(page, 'Animator', 'Walker')).toBeVisible();
  await cmd('setAnimator', { controller: controller('Walker C') });
  await expect(editorTab(page, 'Animator', 'Walker C')).toHaveAttribute('aria-selected', 'true');

  // Opening an open item brings its tab to the front (no second tab).
  await openEditor(page, 'Script', 'Mover');
  expect(await windowTabs(page)).toEqual(['Script: Mover', 'Animator: Walker C']);

  // Reorder by drag; a third tab closed with its × hands over to its left neighbour.
  await editorTab(page, 'Animator', 'Walker C').dragTo(editorTab(page, 'Script', 'Mover'));
  await expect.poll(() => windowTabs(page)).toEqual(['Animator: Walker C', 'Script: Mover']);
  await doubleClickItem(page, 'behavior', 'door');
  await expect(editorTab(page, 'Script', 'Door')).toHaveAttribute('aria-selected', 'true');
  await win.getByRole('button', { name: 'Close Script: Door', exact: true }).click();
  await expect(editorTab(page, 'Script', 'Door')).toHaveCount(0);
  await expect(editorTab(page, 'Script', 'Mover')).toHaveAttribute('aria-selected', 'true');

  // Ctrl+Tab cycles the window's tabs (wrapping), Ctrl+Shift+Tab goes back.
  await page.keyboard.press('Control+Tab');
  await expect(editorTab(page, 'Animator', 'Walker C')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Tab');
  await expect(editorTab(page, 'Script', 'Mover')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Shift+Tab');
  await expect(editorTab(page, 'Animator', 'Walker C')).toHaveAttribute('aria-selected', 'true');

  // The one split: dragging it widens the Inspector, and the width is remembered.
  const split = win.getByRole('separator', { name: "Resize the editor window's inspector" });
  const before = (await inspector(page).boundingBox())!.width;
  const s = (await split.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 - 60, s.y + s.height / 2, { steps: 4 });
  await page.mouse.move(s.x + s.width / 2 - 120, s.y + s.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await inspector(page).boundingBox())!.width).toBeGreaterThan(before + 110);
  const widened = (await inspector(page).boundingBox())!.width;

  // A reload keeps the window, its tabs, their order, the one in front and the split.
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(() => windowTabs(page)).toEqual(['Animator: Walker C', 'Script: Mover']);
  await expect(editorTab(page, 'Animator', 'Walker C')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => Math.round((await inspector(page).boundingBox())!.width)).toBe(Math.round(widened));

  // × closes the window; Window → Editor window brings it back with its tabs.
  await win.getByRole('button', { name: 'Close the editor window', exact: true }).click();
  await expect(win).toHaveCount(0);
  await expect(page.locator('.tl-app__body')).not.toHaveAttribute('inert', '');
  await menu(page, 'Window', 'Editor window');
  await expect.poll(() => windowTabs(page)).toEqual(['Animator: Walker C', 'Script: Mover']);

  // Middle-click closes a tab; closing the last one closes the window, also after a reload.
  await editorTab(page, 'Animator', 'Walker C').click({ button: 'middle' });
  await expect(editorTab(page, 'Animator', 'Walker C')).toHaveCount(0);
  await win.getByRole('button', { name: 'Close Script: Mover', exact: true }).click();
  await expect(win).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect(editorWindow(page)).toHaveCount(0);
  expect(await centreTabs(page)).toEqual(['Scene', 'Game']);

  // ---- The kit editor: a kit opens in the window; a GLB dropped on its Door slot is imported and checked
  // (its pivot at the base's corner: the origin check fails), a fixed file dropped in its place passes; the
  // preview pane shows the piece in the sample wall.
  await cmd('setKit', { kit: { kitId: 'town', name: 'Town' } });
  await doubleClickItem(page, 'kit', 'town');
  await expect(editorTab(page, 'Kit', 'Town')).toHaveAttribute('aria-selected', 'true');
  const kitView = editorPane(page, 'Kit', 'Town');
  const doorSlot = kitView.getByLabel('kit slots', { exact: true }).locator('[data-slot="door"]');
  await expect(doorSlot).toContainText('Drop a GLB or a piece');
  const door = (centred: boolean): Buffer => multiPieceGlb([{ name: 'door', lods: [[1, 2, 0.1], [1, 2, 0.1], [1, 2, 0.1]], col: [1, 2, 0.1] }], { centred });
  await dropFile(page, doorSlot, 'door-corner.glb', door(false));
  // The picked slot's piece, checks and placement are a panel over the kit document; the preview pane is its Preview panel.
  const slotPanel = kitView.locator('[data-panel="kit-pick"]');
  await expect(slotPanel.locator('.tl-dpanel__title')).toHaveText('Door slot');
  const origin = slotPanel.getByLabel('piece checks').locator('[data-check="origin"]');
  await expect(origin).toHaveAttribute('data-state', 'err', { timeout: 30_000 });
  await expect(origin).toContainText('0.50 m right (+X)');
  await expect(doorSlot).toHaveAttribute('data-state', 'err');
  await expect(kitView.getByLabel('kit problems')).toHaveAttribute('data-errors', '1');
  await expect(kitView.locator('[data-panel="preview"]').getByLabel('preview canvas')).toHaveAttribute('data-subject', /^kit-piece:town:door/);
  // The global Inspector keeps only a link: collapsed, the slot's panel opens from it.
  await slotPanel.locator('.tl-dpanel__head').click();
  await expect(slotPanel).toHaveAttribute('data-open', 'false');
  await inspector(page).getByRole('button', { name: 'show the kit panels' }).click();
  await expect(slotPanel).toHaveAttribute('data-open', 'true');
  await expect(inspector(page).getByLabel('piece checks')).toHaveCount(0);
  type KitRow = { kitId: string; trimMaterial?: string; pieces?: Record<string, { assetId: string }[]> };
  const town = async (): Promise<KitRow | undefined> => ((await query('queryGameConfig'))['kits'] as KitRow[]).find((k) => k.kitId === 'town');
  const cornerDoor = (await town())?.pieces?.['door']?.[0]?.assetId;
  await dropFile(page, doorSlot, 'door.glb', door(true));
  await expect(origin).toHaveAttribute('data-state', 'ok', { timeout: 30_000 });
  await expect(doorSlot).toHaveAttribute('data-state', 'ok');
  expect((await town())?.pieces?.['door']?.length).toBe(1);
  // The drop published the file and put it in the slot: one undo takes both back.
  const centredDoor = (await town())?.pieces?.['door']?.[0]?.assetId;
  expect(centredDoor).not.toBe(cornerDoor);
  await cmd('undo', {});
  await expect.poll(async () => (await town())?.pieces?.['door']?.[0]?.assetId).toBe(cornerDoor);
  expect((await listAssets()).map((a) => a.assetId)).not.toContain(centredDoor);

  // Swapping the kit's trim sheet re-points the kit's block types that wore the old one, in one undo step.
  const trim = { size: [256, 256], texelDensity: 64, padding: 8, rows: [{ slot: 'floor', top: 8, bottom: 72, tileV: true }] };
  for (const id of ['trim-a', 'trim-b']) await cmd('setMaterial', { material: { materialId: id, name: id === 'trim-a' ? 'Trim A' : 'Trim B', shader: 'trim', params: {}, textures: {}, trim } });
  await cmd('setBlockType', { block: { blockId: 'town-wall', name: 'Town wall', variants: [{ color: '#ffffff' }], shape: 'full', materials: { '*': 'trim-a' } } });
  await cmd('setKit', { kit: { ...(await town())!, trimMaterial: 'trim-a', blockTypes: ['town-wall'] } });
  const wallMaterial = async (): Promise<string | undefined> => ((await query('queryGameConfig'))['blockTypes'] as { blockId: string; materials?: Record<string, string> }[]).find((t) => t.blockId === 'town-wall')?.materials?.['*'];
  // The swap's commands are grouped once they are all stored: the undo goes after that request, not just after the last change.
  const grouped = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/history/group'));
  await kitView.getByLabel('kit trim sheet').selectOption('trim-b');
  expect((await grouped).status()).toBe(200);
  await expect.poll(wallMaterial).toBe('trim-b');
  expect((await town())?.trimMaterial).toBe('trim-b');
  await cmd('undo', {});
  await expect.poll(wallMaterial).toBe('trim-a');
  expect((await town())?.trimMaterial).toBe('trim-a');
});

/** Drop a file from the computer on an element (what dragging a file from the desktop does). */
async function dropFile(page: Page, target: Locator, name: string, bytes: Buffer): Promise<void> {
  const dataTransfer = await page.evaluateHandle(({ name, b64 }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'model/gltf-binary' }));
    return dt;
  }, { name, b64: bytes.toString('base64') });
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
}

// One backend for both: the default view's checks run on the same fresh editor before "Open" is used.
test('the default view keeps the Scene and Game views and the maximize toggle; "Open" beside an Inspector reference opens the item in the window; Esc returns with the selection; a terrain\'s edit mode', async ({ page }) => {
  test.setTimeout(180_000);
  await cmd('setMaterial', { material: { materialId: 'mat-one', name: 'Mat One', shader: 'standard', params: { roughness: 0.5 }, textures: {}, graph: { nodes: [{ id: 'output', type: 'pbr', position: [400, 0] }], edges: [] } } });
  await cmd('setMaterial', { material: { materialId: 'mat-plain', name: 'Mat Plain', shader: 'standard', params: { roughness: 0.5 }, textures: {} } });
  const crate = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Crate', box: { size: [1, 1, 1], material: { color: '#b0b0b0' } }, transform: { position: [0, 0.5, 0] }, components: { materials: { '*': 'mat-one' } } }))['createdId']);
  await open(page);
  expect(await centreTabs(page)).toEqual(['Scene', 'Game']);
  // Ctrl+Tab with no window swaps the Scene and Game views.
  await page.keyboard.press('Control+Tab');
  await expect(page.locator('.tl-tabs--center [role="tab"]', { hasText: 'Game' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Tab');
  await expect(page.locator('.tl-tabs--center [role="tab"]', { hasText: 'Scene' })).toHaveAttribute('aria-selected', 'true');
  // Maximize hides the docks and the centre grows; restoring brings them back.
  const stageBefore = await box(page, '.tl-app__stage');
  const maximize = page.getByRole('button', { name: 'Maximize the centre area' });
  await maximize.click();
  await expect(maximize).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tl-dock--left')).toBeHidden();
  await expect(page.locator('.tl-dock--right')).toBeHidden();
  await expect(page.locator('.tl-dock--bottom')).toBeHidden();
  await expect.poll(async () => (await box(page, '.tl-app__stage')).width).toBeGreaterThan(stageBefore.width + 300);
  await expect.poll(async () => (await box(page, '.tl-app__stage')).height).toBeGreaterThan(stageBefore.height + 100);
  await maximize.click();
  await expect(maximize).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.tl-dock--left')).toBeVisible();
  await expect(page.locator('.tl-dock--bottom')).toBeVisible();
  await row(page, crate).click();
  const openRef = inspector(page).getByRole('button', { name: 'Open material for all', exact: true });
  await expect(openRef).toBeVisible();
  // An asset reference (a texture, a model) has no editor: no "Open" beside it.
  await expect(inspector(page).getByRole('button', { name: /^Open .*asset/ })).toHaveCount(0);
  await openRef.click();
  await expect(editorWindow(page)).toBeVisible();
  await expect(editorTab(page, 'Material', 'Mat One')).toHaveAttribute('aria-selected', 'true');
  await expect(inspector(page)).toHaveAttribute('data-tl-inspector', 'window');
  await page.keyboard.press('Escape');
  await expect(editorWindow(page)).toHaveCount(0);
  await expect(row(page, crate)).toHaveAttribute('aria-selected', 'true');
  await expect(inspector(page).getByRole('button', { name: 'Open material for all', exact: true })).toBeVisible();
  // A shader material has no editor: "Open" shows it in the Inspector, as a double-click in the project window does.
  await cmd('setComponent', { entityId: crate, component: 'materials', value: { '*': 'mat-plain' } });
  await inspector(page).getByRole('button', { name: 'Open material for all', exact: true }).click();
  await expect(inspector(page).getByLabel('material inspector')).toBeVisible();
  await expect(inspector(page).getByRole('combobox', { name: 'shader', exact: true })).toHaveValue('standard');
  await expect(editorWindow(page)).toHaveCount(0);
  await editModeChecks(page);
});

/** A screen point of a world point in the Scene view (its view-projection, published while a terrain is drawn). */
async function screenOf(page: Page, p: readonly [number, number, number]): Promise<{ x: number; y: number }> {
  const canvas = page.locator('canvas.tl-viewport');
  const m = JSON.parse((await canvas.getAttribute('data-view-proj'))!) as number[];
  const b = (await canvas.boundingBox())!;
  const [x, y, z] = p;
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w;
  const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
  return { x: b.x + ((nx + 1) / 2) * b.width, y: b.y + ((1 - ny) / 2) * b.height };
}

/** The share of red pixels in a square of the page around a world point. */
async function redNear(page: Page, p: readonly [number, number, number], size = 12): Promise<number> {
  const s = await screenOf(page, p);
  const img = decodePng(await page.screenshot({ clip: { x: s.x - size / 2, y: s.y - size / 2, width: size, height: size } }));
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (r > 60 && r > 2.2 * g && r > 2.2 * b) n += 1;
  }
  return n / (img.width * img.height);
}

/** The share of the terrain's green (its first default layer, lit) in a square of the page around a world point. */
async function greenNear(page: Page, p: readonly [number, number, number], size = 12): Promise<number> {
  const s = await screenOf(page, p);
  const img = decodePng(await page.screenshot({ clip: { x: s.x - size / 2, y: s.y - size / 2, width: size, height: size } }));
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, b] = img.pixel(x, y);
    if (g > 40 && g > 1.1 * r && g > 1.3 * b) n += 1;
  }
  return n / (img.width * img.height);
}

/** The share of the Scene view's lower three quarters (the ground, below the sky) in the grid's ground-square grey. */
async function groundSquareShare(page: Page): Promise<number> {
  const b = (await page.locator('canvas.tl-viewport').boundingBox())!;
  const img = decodePng(await page.screenshot({ clip: { x: b.x, y: b.y + b.height * 0.25, width: b.width, height: b.height * 0.75 } }));
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const [r, g, bl] = img.pixel(x, y);
    // 0x1c1f27 lit and shaded: a dark, slightly blue grey (the terrain's shade is green, the marker red).
    if (Math.max(r, g, bl) < 50 && bl >= g && g >= r - 2) n += 1;
  }
  return n / (img.width * img.height);
}

/** The view camera's pose (position, forward unit vector) as the canvas reports it. */
async function viewCamera(page: Page): Promise<{ position: number[]; forward: number[]; fovY: number }> {
  const c = JSON.parse((await page.locator('canvas.tl-viewport').getAttribute('data-view-camera'))!) as { position: number[]; rotation: number[]; fovY: number };
  const [x, y, z, w] = c.rotation as [number, number, number, number];
  // The quaternion applied to (0, 0, -1).
  const forward = [-(2 * (x * z + w * y)), -(2 * (y * z - w * x)), -(1 - 2 * (x * x + y * y))];
  return { position: c.position, forward, fovY: c.fovY };
}

/** The mean colour of a square of the page around a world point. */
async function colourNear(page: Page, p: readonly [number, number, number], size = 8): Promise<[number, number, number]> {
  const s = await screenOf(page, p);
  const img = decodePng(await page.screenshot({ clip: { x: s.x - size / 2, y: s.y - size / 2, width: size, height: size } }));
  const sum = [0, 0, 0];
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const px = img.pixel(x, y);
    for (let c = 0; c < 3; c++) sum[c]! += px[c]!;
  }
  const n = img.width * img.height;
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

/** The share of the Scene view's top tenth (the sky above the horizon) within 24 of an sRGB colour. */
async function skyShare(page: Page, rgb: readonly [number, number, number]): Promise<number> {
  const b = (await page.locator('canvas.tl-viewport').boundingBox())!;
  const img = decodePng(await page.screenshot({ clip: { x: b.x + 40, y: b.y + 4, width: b.width - 80, height: b.height * 0.1 } }));
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const px = img.pixel(x, y);
    if (Math.abs(px[0] - rgb[0]) + Math.abs(px[1] - rgb[1]) + Math.abs(px[2] - rgb[2]) < 24) n += 1;
  }
  return n / (img.width * img.height);
}

/** The mean absolute difference of two same-sized pictures per channel (0–255). */
function meanDiffOf(a: ReturnType<typeof decodePng>, b: ReturnType<typeof decodePng>): number {
  let d = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = a.pixel(x, y);
    const q = b.pixel(x, y);
    d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  }
  return d / (a.width * a.height * 3);
}

/** A point on the marker's top face (away from its size handle in the middle). */
const MARK: [number, number, number] = [0.5, 2, -0.4];

/**
 * A terrain's edit mode: entered three ways, isolation, Context, the rail, an edit undone, the brush keys and a stroke through
 * the noise mask, an MCP edit, Play aside and back, Esc.
 */
async function editModeChecks(page: Page): Promise<void> {
  // A flat one-tile terrain round the origin and a red marker standing on it.
  const hill = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Hill', transform: { position: [-16, 0, -16] } }))['createdId']);
  await cmd('setComponent', { entityId: hill, component: 'terrain', value: { tileSamples: 33, spacing: 1, heightRange: [-8, 24], tiles: [{ x: 0, z: 0 }] } });
  await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Marker', box: { size: [2, 2, 2], material: { color: '#ff2020' } }, transform: { position: [0, 1, 0] } });
  const canvas = page.locator('canvas.tl-viewport');
  await expect(canvas).toHaveAttribute('data-view-proj', /\[/);
  await expect.poll(() => redNear(page, MARK), { timeout: 30_000, message: 'the marker drawn' }).toBeGreaterThan(0.6);

  // Selecting the terrain arms nothing: the Inspector offers its editor, no terrain tools.
  await row(page, hill).click();
  await expect(inspector(page).getByLabel('terrain tools')).toHaveCount(0);
  await expect(canvas).not.toHaveAttribute('data-terrain-tool', /\w/);

  // ---- A double-click on its row opens the terrain editor over the work area, the Scene view lent to it. (The view
  // aimed away from the terrain first, at an object beside it: entering frames a working view. A view already aimed
  // at the terrain is kept.)
  const aside = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Away', transform: { position: [70, 0, 70] } }))['createdId']);
  await row(page, aside).click();
  await page.keyboard.press('f');
  await row(page, hill).dblclick();
  const mode = editMode(page);
  await expect(mode).toBeVisible();
  await expect(mode.getByLabel('edited object')).toHaveText('Hill');
  await expect(mode.locator('.tl-emh__meta')).toHaveText('1 tile · 1 × 1 · 32 m each');
  await expect(page.locator('.tl-app__body')).toHaveAttribute('inert', '');
  await expect(page.locator('.tl-editmode__canvas canvas.tl-viewport')).toHaveAttribute('data-lent', 'edit');
  // The layout contract: header 46 px, rail 76 px, settings column 340 px, hints 30 px, the work area filled.
  const area = (await page.locator('.tl-app__workarea').boundingBox())!;
  const m = (await mode.boundingBox())!;
  expect([Math.round(m.width - area.width), Math.round(m.height - area.height)]).toEqual([0, 0]);
  const h = async (sel: string): Promise<{ width: number; height: number }> => (await mode.locator(sel).boundingBox())!;
  expect(Math.round((await h('.tl-emh')).height)).toBe(46);
  expect(Math.round((await h('.tl-rail')).width)).toBe(76);
  expect(Math.round((await h('.tl-editmode__column')).width)).toBe(340);
  expect(Math.round((await h('.tl-hints')).height)).toBe(30);
  const view = await h('.tl-editmode__view');
  const cb = (await canvas.boundingBox())!;
  expect([Math.round(cb.width), Math.round(cb.height)]).toEqual([Math.round(view.width), Math.round(view.height)]);
  // Entering looks at a working part of the terrain: obliquely down at its middle on the ground (the horizon 12 % of the
  // view below its top), near enough that its 32 m fill the view's width.
  await expect.poll(async () => {
    const c = await viewCamera(page);
    const half = Math.tan((c.fovY * Math.PI) / 360);
    const t = -c.position[1]! / c.forward[1]!;
    const hit = [c.position[0]! + c.forward[0]! * t, c.position[2]! + c.forward[2]! * t];
    const pitch = Math.asin(-c.forward[1]!);
    return [Math.abs(Math.round((pitch - Math.atan(0.76 * half)) * 1000)), Math.round(Math.hypot(hit[0]!, hit[1]!)), Math.abs(Math.round(Math.hypot(c.position[0]! - hit[0]!, c.position[1]!, c.position[2]! - hit[1]!) - 16 / half))];
  }, { timeout: 15_000, message: 'the working view: its pitch off the expected (mrad), its aim off the middle (m), its distance off (m)' }).toEqual([0, 0, 0]);
  // Its settings column holds the terrain's tools (Sculpt first). It opens with none armed (Navigate: the tile lit,
  // Done's Esc badge bright: Esc would leave); Q arms Raise in the lent view and the status line says what to do.
  await expect(mode.getByLabel('terrain tools')).toBeVisible();
  await expect(canvas).toHaveAttribute('data-terrain-tool', 'navigate');
  await expect(mode.getByRole('toolbar', { name: 'terrain tool' }).getByRole('button', { name: 'Navigate', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(mode.locator('.tl-done kbd')).toHaveAttribute('data-esc-leaves', 'true');
  await expect(mode.getByLabel('edit mode hints')).toContainText('Navigate');
  await page.keyboard.press('q');
  await expect(canvas).toHaveAttribute('data-terrain-tool', 'raise');
  await expect(mode.locator('.tl-done kbd')).toHaveAttribute('data-esc-leaves', 'false');
  await expect(mode.getByLabel('edit mode hints')).toContainText('Drag on the ground to raise it.');

  // ---- Isolation: only the terrain is drawn (the marker leaves the picture, its shadow stays); Context shows it again.
  await expect(canvas).toHaveAttribute('data-isolation', new RegExp(hill));
  await expect.poll(() => redNear(page, MARK), { timeout: 30_000, message: 'isolated: the marker not drawn' }).toBeLessThan(0.05);
  expect(Number((await canvas.getAttribute('data-isolated-draws'))!.split(' ')[0]), 'drawables hidden').toBeGreaterThan(0);
  await expect(mode.getByRole('status', { name: 'isolation' })).toHaveText('Showing Hill only');
  await page.keyboard.press('c');
  await expect(mode.getByRole('button', { name: 'Context', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(mode.getByRole('status', { name: 'isolation' })).toContainText('Whole scene');
  await expect.poll(() => redNear(page, MARK), { timeout: 30_000, message: 'Context: the marker drawn' }).toBeGreaterThan(0.6);
  await page.keyboard.press('c');
  await expect.poll(() => redNear(page, MARK), { timeout: 30_000, message: 'Context off: isolated again' }).toBeLessThan(0.05);
  // A child added to the terrain while the mode is open is drawn (it is part of the edited object), and hidden again once it goes.
  const child = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: hill, kind: 'box', name: 'Child', box: { size: [2, 2, 2], material: { color: '#ff2020' } }, transform: { position: [16, 1, 16] } }))['createdId']);
  await expect(canvas).toHaveAttribute('data-isolation', /"drawn":2/);
  await expect.poll(() => redNear(page, MARK), { timeout: 30_000, message: 'isolated: a child added while open drawn' }).toBeGreaterThan(0.6);
  await cmd('deleteEntity', { entityId: child });
  await expect(canvas).toHaveAttribute('data-isolation', /"drawn":1/);
  await expect.poll(() => redNear(page, MARK), { timeout: 30_000, message: 'isolated: the child gone' }).toBeLessThan(0.05);
  // The sky is no object: it is drawn in isolation as in the whole scene (a colour sky lighting nothing, so the
  // checks below see the scene's own light).
  await cmd('setEnvironment', { sceneId: 'scene-main', environment: { sky: { mode: 'color', color: '#4a90d9', intensity: 1, environmentIntensity: 0 } } });
  await expect.poll(() => skyShare(page, [0x4a, 0x90, 0xd9]), { timeout: 30_000, message: 'isolated: the sky drawn above the horizon' }).toBeGreaterThan(0.9);
  // The edited object's own icon is not drawn over it: the picture where it stands (the terrain's origin, a corner of
  // its tile) is the same with the Gizmos menu's icons on and off.
  const iconAt = await screenOf(page, [-16, 0, -16]);
  const iconCrop = async (): Promise<ReturnType<typeof decodePng>> => decodePng(await page.screenshot({ clip: { x: iconAt.x - 50, y: iconAt.y - 60, width: 100, height: 100 } }));
  const withIcons = await iconCrop();
  if (process.env['TL_SHOTS'] !== undefined) await page.screenshot({ path: `${process.env['TL_SHOTS']}/edit-icons.png` });
  await menu(page, 'Gizmos', 'Icons: on');
  await page.waitForTimeout(300);
  const noIcons = await iconCrop();
  await menu(page, 'Gizmos', 'Icons: off');
  expect(meanDiffOf(withIcons, noIcons), 'no icon drawn over the edited terrain').toBeLessThan(1);
  // A raised bump is lit as in the whole scene: its slope facing the sun (from -x, +z) brighter than the one facing away,
  // and the lights light the isolated terrain as they do with Context on (they are not objects that isolation hides).
  // (Off to the side: it hides nothing the checks below look at.)
  const bump: [number, number] = [10, -10];
  await cmd('editTerrain', { entityId: hill, kind: 'raise', dabs: [bump], radius: 4, strength: 4 });
  await expect.poll(async () => ((await query('queryTerrain', { entityId: hill, points: [bump] }))['points'] as { height: number }[])[0]!.height, { timeout: 15_000 }).toBeGreaterThan(2);
  const lit: [number, number, number] = [bump[0] - 1.5, 1.2, bump[1] + 1.5];
  const shaded: [number, number, number] = [bump[0] + 1.5, 1.2, bump[1] - 1.5];
  const luma = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  await expect.poll(async () => luma(await colourNear(page, lit)) - luma(await colourNear(page, shaded)), { timeout: 30_000, message: 'isolated: the relief shaded by the sun' }).toBeGreaterThan(12);
  const isoLit = await colourNear(page, lit);
  await page.keyboard.press('c');
  await expect(mode.getByRole('status', { name: 'isolation' })).toContainText('Whole scene');
  await expect.poll(() => skyShare(page, [0x4a, 0x90, 0xd9]), { timeout: 30_000, message: 'Context: the same sky' }).toBeGreaterThan(0.9);
  await expect.poll(async () => Math.max(...(await colourNear(page, lit)).map((v, i) => Math.abs(v - isoLit[i]!))), { timeout: 30_000, message: 'the bump lit the same with Context on' }).toBeLessThan(4);
  await page.keyboard.press('c');
  // Closer in with the wheel, as one works, for the brush checks below (about 10 m from the middle).
  const vb = (await canvas.boundingBox())!;
  await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
  for (let k = 0; k < 6; k++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(80);
  }
  let pose = '';
  await expect.poll(async () => pose !== (pose = (await canvas.getAttribute('data-view-camera')) ?? ''), { timeout: 15_000, message: 'the zoom settled' }).toBe(false);
  // The grid's dark ground square (20 m round the origin at y = 0) is not drawn in isolation either: it fights the
  // terrain lying at y = 0 and shows wherever the ground dips below it — dark shapes on the one object shown. Context
  // shows it again. A dip under the square makes it show for sure.
  const dipAt: [number, number] = [-1, -8];
  await cmd('editTerrain', { entityId: hill, kind: 'lower', dabs: [dipAt], radius: 2.5, strength: 1.5 });
  await expect.poll(async () => ((await query('queryTerrain', { entityId: hill, points: [dipAt] }))['points'] as { height: number }[])[0]!.height, { timeout: 15_000 }).toBeLessThan(-0.5);
  // The view's Panels switch hides the docked panels (the brush's are dark too), and shows them again after.
  const panelsSwitch = mode.getByRole('group', { name: 'panels layout' }).locator('.tl-panelschip__switch');
  await panelsSwitch.click();
  await expect(mode.locator('[data-panel]')).toHaveCount(0);
  await expect.poll(() => groundSquareShare(page), { timeout: 30_000, message: 'isolated: no part of the ground square drawn' }).toBeLessThan(0.002);
  await page.keyboard.press('c');
  // (Seen at the working view's shallow angle: a thin strip, above the isolated bound.)
  await expect.poll(() => groundSquareShare(page), { timeout: 30_000, message: 'Context: the ground square drawn again' }).toBeGreaterThan(0.003);
  await page.keyboard.press('c');
  await expect.poll(() => groundSquareShare(page), { timeout: 30_000, message: 'Context off: the square gone again' }).toBeLessThan(0.002);
  await panelsSwitch.click();
  await expect(mode.locator('[data-panel="brush"]')).toBeVisible();

  // ---- The rail: Shift+number and a click switch modes (Material rules arms no brush).
  await page.keyboard.press('Shift+Digit2');
  await expect(mode.getByRole('tab', { name: 'Paint', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(canvas).toHaveAttribute('data-terrain-tool', 'paint');
  await editModeTab(page, 'Material rules');
  await expect(mode.getByRole('group', { name: 'material rules' })).toBeVisible();
  await expect(canvas).toHaveAttribute('data-terrain-tool', '');
  await editModeTab(page, 'Sculpt');

  // ---- A raise stroke in the lent view: one command, undone with Ctrl+Z.
  const heightAt = async (): Promise<number> => ((await query('queryTerrain', { entityId: hill, points: [[-4, -3]] }))['points'] as { height: number }[])[0]!.height;
  const revision = async (): Promise<number> => Number((await query('queryProject'))['revision']);
  const rev0 = await revision();
  const h0 = await heightAt();
  const a = await screenOf(page, [-4.5, 0, -3]);
  const b = await screenOf(page, [-3.5, 0, -3]);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(revision, { timeout: 30_000, message: 'the stroke stored' }).toBe(rev0 + 1);
  expect(await heightAt(), 'the ground raised').toBeGreaterThan(h0 + 0.05);
  await page.keyboard.press('Control+z');
  await expect.poll(heightAt, { timeout: 30_000, message: 'undone' }).toBe(h0);
  await mode.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(heightAt, { timeout: 30_000, message: 'redone from the header' }).toBeGreaterThan(h0 + 0.05);

  // ---- The brush keys (one map, listed in the status line): [ ] size, Shift+] strength, X invert, F drag-resize (Esc puts it back).
  const hints = mode.getByLabel('edit mode hints');
  await expect(hints).toContainText('Resize in view');
  await expect(hints).toContainText('Strength');
  const sizeField = mode.getByLabel('brush size', { exact: true });
  const cursorInfo = async (): Promise<{ radius: number; state: string; mask: boolean }> => JSON.parse((await canvas.getAttribute('data-terrain-cursor')) ?? '{}') as { radius: number; state: string; mask: boolean };
  const over = await screenOf(page, [-6, 0, -6]);
  await page.mouse.move(over.x, over.y);
  await expect(sizeField).toHaveValue('16');
  await expect.poll(async () => (await cursorInfo()).radius).toBe(8);
  await page.keyboard.press(']');
  await expect(sizeField).toHaveValue('18');
  await expect.poll(async () => (await cursorInfo()).radius, { message: 'the cursor follows the key' }).toBe(9);
  await expect(mode.getByRole('status', { name: 'brush readout' })).toContainText('Size 18 m');
  await page.keyboard.press('[');
  await expect(sizeField).toHaveValue('16');
  await page.keyboard.press('Shift+BracketRight');
  await expect(mode.getByLabel('brush strength', { exact: true })).toHaveValue('55');
  await page.keyboard.press('x');
  await expect(mode.getByLabel('brush invert')).toBeChecked();
  await expect.poll(async () => (await cursorInfo()).state, { message: 'inverting: the cursor turns red' }).toBe('erase');
  await page.keyboard.press('x');
  await expect.poll(async () => (await cursorInfo()).state).toBe('paint');
  // F, then a drag on the ground: the size is twice the distance from where F was pressed; Esc puts it back, a click keeps it.
  await page.keyboard.press('f');
  const away = await screenOf(page, [0, 0, -6]);
  await page.mouse.move(away.x, away.y, { steps: 4 });
  await expect.poll(async () => Number(await sizeField.inputValue()), { message: 'F: resized in the view' }).toBeGreaterThan(10);
  await page.keyboard.press('Escape');
  await expect(sizeField).toHaveValue('16');
  await expect(mode, 'Esc put the size back; it did not leave').toBeVisible();
  await page.mouse.move(over.x, over.y);
  const revBeforeClick = await revision();
  await page.keyboard.press('f');
  await page.mouse.move(away.x, away.y, { steps: 4 });
  await page.mouse.down();
  await page.mouse.up();
  const resized = Number(await sizeField.inputValue());
  expect(resized, 'a click sets the dragged size (about 2 × 6 m)').toBeGreaterThan(10);
  expect(resized).toBeLessThan(14);
  expect(await revision(), 'the click that set the size stored nothing').toBe(revBeforeClick);

  // ---- Paint through noise: the same stroke with the mask on leaves ground unpainted where the unmasked one covers it all; undo.
  await page.keyboard.press('Shift+Digit2');
  await expect(canvas).toHaveAttribute('data-terrain-tool', 'paint');
  // No material yet: the palette shows the stand-in colours, named so, with Set up first; a number key picks a layer.
  const layers = mode.getByRole('radiogroup', { name: 'layers', exact: true });
  await expect(mode.getByRole('button', { name: 'set up material' })).toBeVisible();
  expect(await layers.getByRole('radio').evaluateAll((els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))).toEqual([1, 2, 3, 4].map((n) => `${n} Layer ${n} no material`));
  await expect(hints).toContainText('Layer');
  await page.keyboard.press('2');
  await expect(layers.getByRole('radio', { name: 'layer 2', exact: true })).toHaveAttribute('aria-checked', 'true');
  if (process.env['TL_SHOTS'] !== undefined) await page.screenshot({ path: `${process.env['TL_SHOTS']}/palette-none.png` });
  const fill = async (label: string, v: number): Promise<void> => {
    const f = mode.getByLabel(label, { exact: true });
    await f.fill(String(v));
    await f.blur();
  };
  await fill('brush size', 8);
  await fill('brush strength', 100);
  await mode.getByRole('radiogroup', { name: 'brush falloff' }).getByRole('radio', { name: 'Constant' }).click();
  const paintAt: [number, number, number] = [-9, 0, -5];
  const paintStroke = async (): Promise<void> => {
    const p0 = await screenOf(page, [paintAt[0] - 0.6, 0, paintAt[2]]);
    const p1 = await screenOf(page, [paintAt[0] + 0.6, 0, paintAt[2]]);
    const r0 = await revision();
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move(p1.x, p1.y, { steps: 4 });
    await page.mouse.up();
    await expect.poll(revision, { timeout: 30_000, message: 'the paint stroke stored' }).toBe(r0 + 1);
    // The pointer leaves the view: the cursor goes, the picture is the ground's.
    await mode.locator('.tl-editmode__column-head').hover();
    await expect(canvas).toHaveAttribute('data-terrain-brush', '');
  };
  const patch = async (): Promise<ReturnType<typeof decodePng>> => {
    const c = await screenOf(page, paintAt);
    return decodePng(await page.screenshot({ clip: { x: c.x - 15, y: c.y - 15, width: 30, height: 30 } }));
  };
  const before = await patch();
  await paintStroke();
  await expect.poll(() => greenNear(page, paintAt, 24), { timeout: 30_000, message: 'unmasked: the patch painted over' }).toBeLessThan(0.1);
  const unmasked = await patch();
  await page.keyboard.press('Control+z');
  await expect.poll(() => greenNear(page, paintAt, 24), { timeout: 30_000, message: 'undone: green again' }).toBeGreaterThan(0.6);
  // The noise mask is a docked panel (open in Paint); its title bar says whether it is on.
  const noise = editPanel(page, 'noise-mask');
  await expect(noise).toHaveAttribute('data-open', 'true');
  await noise.getByLabel('paint through noise').check();
  await expect(noise.locator('.tl-dpanel__badge')).toHaveText('on');
  await fill('mask scale', 1.5);
  await fill('mask contrast', 3);
  // The cursor's fill shows the mask.
  const hover = await screenOf(page, paintAt);
  await page.mouse.move(hover.x, hover.y);
  await expect.poll(async () => (await cursorInfo()).mask).toBe(true);
  await paintStroke();
  const masked = await patch();
  await expect.poll(() => greenNear(page, paintAt, 24), { timeout: 30_000, message: 'masked: ground left unpainted through the mask' }).toBeGreaterThan(0.15);
  const meanDiff = (a: ReturnType<typeof decodePng>, b: ReturnType<typeof decodePng>): number => {
    let d = 0;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const p = a.pixel(x, y);
      const q = b.pixel(x, y);
      d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
    }
    return d / (a.width * a.height * 3);
  };
  expect(meanDiff(masked, unmasked), 'the masked stroke differs from the unmasked one').toBeGreaterThan(4);
  expect(meanDiff(masked, before), 'the masked stroke painted something').toBeGreaterThan(4);
  await page.keyboard.press('Control+z');
  await expect.poll(() => greenNear(page, paintAt, 24), { timeout: 30_000, message: 'the masked stroke undone' }).toBeGreaterThan(0.6);
  await noise.getByLabel('paint through noise').uncheck();
  await paletteChecks(page, hill, paintStroke, patch, meanDiff);
  await editModeTab(page, 'Sculpt');

  // ---- MCP edits reach the open mode: a rename in the header, a hole in the lent view.
  const holeAt: [number, number, number] = [-12, 0, -11];
  await expect.poll(() => greenNear(page, holeAt), { timeout: 30_000, message: 'ground where the hole goes' }).toBeGreaterThan(0.6);
  await cmd('updateEntity', { entityId: hill, name: 'Hill B' });
  await cmd('editTerrain', { entityId: hill, kind: 'holes', dabs: [[holeAt[0], holeAt[2]]], radius: 2.5 });
  await expect(mode.getByLabel('edited object')).toHaveText('Hill B');
  await expect.poll(() => greenNear(page, holeAt), { timeout: 30_000, message: 'the MCP hole drawn in the edit mode' }).toBeLessThan(0.2);

  // ---- Play sets the mode aside (the Game view in front, the default view live) and Stop brings it back.
  await page.getByTitle('Start an isolated play preview').click();
  await expect(mode).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('.tl-tabs--center [role="tab"]', { hasText: 'Game' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tl-app__body')).not.toHaveAttribute('inert', '');
  await expect(canvas).toHaveAttribute('data-isolation', '');
  await page.getByTitle('Stop the play preview').click();
  await expect(mode).toBeVisible({ timeout: 30_000 });
  await expect(canvas).toHaveAttribute('data-lent', 'edit');
  await expect(canvas).toHaveAttribute('data-isolation', new RegExp(hill));
  await expect(mode.getByRole('tab', { name: 'Sculpt', exact: true })).toHaveAttribute('aria-selected', 'true');

  // ---- Esc in order: in a field it only leaves the field; then it drops the tool (Space arms it again); with no
  // tool it leaves: the canvas home again, the selection from before (the terrain, clicked by the double-click).
  await expect(canvas).toHaveAttribute('data-terrain-tool', 'raise');
  const sizeBox = mode.getByLabel('brush size', { exact: true });
  await sizeBox.focus();
  await page.keyboard.press('Escape');
  await expect(sizeBox).not.toBeFocused();
  await expect(canvas, 'Esc in a field keeps the tool').toHaveAttribute('data-terrain-tool', 'raise');
  await page.keyboard.press('Escape');
  await expect(canvas).toHaveAttribute('data-terrain-tool', 'navigate');
  await expect(mode).toBeVisible();
  await expect(mode.locator('.tl-done kbd')).toHaveAttribute('data-esc-leaves', 'true');
  await page.keyboard.press('Space');
  await expect(canvas).toHaveAttribute('data-terrain-tool', 'raise');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(mode).toHaveCount(0);
  await expect(page.locator('.tl-viewport-host canvas.tl-viewport')).toHaveCount(1);
  await expect(canvas).not.toHaveAttribute('data-lent', /./);
  await expect(row(page, hill)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => redNear(page, MARK), { timeout: 30_000, message: 'back in the default view: the marker drawn' }).toBeGreaterThan(0.6);

  // ---- The Inspector's button opens it again; Done closes it. A double-click on the terrain in the Scene view opens it too.
  await inspector(page).getByRole('button', { name: 'Edit terrain', exact: true }).click();
  await expect(mode).toBeVisible();
  await mode.getByRole('button', { name: /^Done/ }).click();
  await expect(mode).toHaveCount(0);
  // The ground near the camera, at the bottom of the view (the marker stands in its middle).
  const home = (await canvas.boundingBox())!;
  await page.mouse.dblclick(home.x + home.width * 0.3, home.y + home.height * 0.92);
  await expect(mode).toBeVisible();
  // Deleting the terrain (an MCP edit) closes its editor.
  await cmd('deleteEntity', { entityId: hill });
  await expect(mode).toHaveCount(0, { timeout: 15_000 });
}

/** A texture from a tiled pattern of two colours (its thumbnail shows the pattern). */
function patternPng(a: readonly [number, number, number], b: readonly [number, number, number]): Uint8Array {
  return new Uint8Array(makePng(64, 64, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [a[0], a[1], a[2], 255] : [b[0], b[1], b[2], 255])));
}

/**
 * The layer palette on the terrain without a material: Set up material (one command, one undo for the material and
 * its assignment), a texture dropped into a slot and one picked for an empty slot (their backend thumbnails load,
 * under 64 KB), a layer named and its tiling set in the settings popover (Esc closes the popover, not the mode),
 * then a layer picked by its number key and painted (the stored index, the picture changes).
 */
async function paletteChecks(page: Page, hill: string, paintStroke: () => Promise<void>, patch: () => Promise<ReturnType<typeof decodePng>>, meanDiff: (a: ReturnType<typeof decodePng>, b: ReturnType<typeof decodePng>) => number): Promise<void> {
  const mode = editMode(page);
  const layers = mode.getByRole('radiogroup', { name: 'layers', exact: true });
  const revision = async (): Promise<number> => Number((await query('queryProject'))['revision']);
  const mats = async (): Promise<{ materialId: string; name: string; layerNames?: string[]; parameters?: { key: string; default: unknown }[] }[]> => (await query('queryGameConfig'))['materials'] as never;
  const mapping = async (): Promise<unknown> => (((await query('queryEntities', { limit: 100, offset: 0 }))['entities'] as { id: string; components: Record<string, unknown> }[]).find((e) => e.id === hill)?.components['materials'] ?? null);
  await publishTexture(be, patternPng([70, 150, 50], [40, 110, 30]), 'tex-grass', 'Meadow grass');
  await publishTexture(be, patternPng([140, 95, 55], [105, 70, 40]), 'tex-dirt', 'Forest dirt');

  // ---- Set up material: the template made and given to the terrain in one command; one undo takes both away.
  const rev0 = await revision();
  await mode.getByRole('button', { name: 'set up material' }).click();
  await expect.poll(revision, { timeout: 15_000, message: 'set up stored' }).toBe(rev0 + 1);
  const made = (await mats()).find((m) => m.name === 'Hill B layers' || m.name === 'Hill layers')!;
  expect(made, 'a layered material made').toBeDefined();
  expect(await mapping()).toEqual({ '*': made.materialId });
  await expect(mode.getByRole('button', { name: 'open material' })).toHaveText(made.name);
  expect(await layers.getByRole('radio').locator('.tl-ptile__name').allTextContents()).toEqual(['Layer 1', 'Layer 2', 'Layer 3', 'Layer 4']);
  await page.keyboard.press('Control+z');
  await expect.poll(mapping, { timeout: 15_000, message: 'undo: the assignment gone' }).toBeNull();
  expect((await mats()).some((m) => m.materialId === made.materialId), 'undo: the material gone with it').toBe(false);
  await expect(mode.getByRole('button', { name: 'set up material' })).toBeVisible();
  await mode.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect.poll(mapping, { timeout: 15_000, message: 'redo: both back' }).toEqual({ '*': made.materialId });
  // The page has the material back too (the drop below needs its palette).
  await expect(mode.getByRole('button', { name: 'open material' })).toHaveText(made.name);
  const albedo = async (): Promise<unknown> => (await mats()).find((m) => m.materialId === made.materialId)?.parameters?.find((x) => x.key === 'albedoHeight')?.default;

  // ---- A texture dragged from the project window (the edit mode's Project panel, collapsed on the bottom edge until
  // opened) onto layer 1 goes into its slot; its thumbnail is the backend's.
  const project = await openPanel(page, 'project');
  await project.getByRole('button', { name: 'folder (game folder)', exact: true }).click();
  await project.getByLabel('search the project').fill('t:texture Meadow grass');
  await project.locator('li[data-asset-id="tex-grass"]').dragTo(layers.getByRole('radio', { name: 'layer 1', exact: true }));
  await expect.poll(albedo, { timeout: 15_000, message: 'the dropped texture in slot 1' }).toEqual(['tex-grass', '', '', '']);
  const thumb = layers.getByRole('radio', { name: 'layer 1', exact: true }).locator('.tl-ptile__thumb');
  await expect(thumb).toHaveAttribute('data-thumb', 'ready', { timeout: 30_000 });
  await expect(layers.getByRole('radio', { name: 'layer 1', exact: true }).locator('.tl-ptile__name')).toHaveText('Meadow grass');
  const bytes = await thumb.locator('img').evaluate(async (img: HTMLImageElement) => (img.naturalWidth > 0 ? (await (await fetch(img.src)).blob()).size : 0));
  expect(bytes, 'a thumbnail loaded').toBeGreaterThan(0);
  expect(bytes, 'a thumbnail is at most 64 KB').toBeLessThanOrEqual(64 * 1024);
  // An opaque PNG has no height in its alpha: the backend's check puts a "no height" badge on the tile.
  await expect(layers.getByRole('radio', { name: 'layer 1', exact: true }).getByLabel('no height in alpha')).toHaveText('no height', { timeout: 15_000 });
  await project.locator('.tl-dpanel__head').click();
  await expect(project).toHaveAttribute('data-open', 'false');

  // ---- An empty slot picks its texture in a popover beside the column.
  await layers.getByRole('radio', { name: 'layer 2', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'choose layer texture' });
  // The texture browser in the popover (the project window is under the mode): the picture clicked.
  await chooser.getByRole('group', { name: 'layer 2 texture' }).getByRole('option', { name: 'Forest dirt' }).click();
  await expect.poll(albedo, { timeout: 15_000, message: 'the picked texture in slot 2' }).toEqual(['tex-grass', 'tex-dirt', '', '']);
  await expect(chooser).toHaveCount(0);
  await expect(layers.getByRole('radio', { name: 'layer 2', exact: true }).locator('.tl-ptile__thumb')).toHaveAttribute('data-thumb', 'ready', { timeout: 30_000 });

  // ---- The picked layer's name and settings in the popover (one command once a field rests); Esc closes only it.
  await mode.getByRole('button', { name: 'layer settings' }).click();
  const settings = page.getByRole('dialog', { name: 'layer settings' });
  await settings.getByLabel('layer 2 name').fill('Dirt path');
  await settings.getByLabel('layer 2 name').press('Enter');
  await expect.poll(async () => (await mats()).find((m) => m.materialId === made.materialId)?.layerNames, { timeout: 15_000 }).toEqual(['', 'Dirt path']);
  const tiling = settings.getByLabel('layer 2 tiling (m)', { exact: true });
  await tiling.fill('3');
  await tiling.blur();
  // A terrain's material set up here starts its layers tiled every 4 m (the template's 1 m suits a block face).
  await expect.poll(async () => (await mats()).find((m) => m.materialId === made.materialId)?.parameters?.find((x) => x.key === 'layerTiling')?.default, { timeout: 15_000 }).toEqual([4, 3, 4, 4]);
  if (process.env['TL_SHOTS'] !== undefined) await page.screenshot({ path: `${process.env['TL_SHOTS']}/palette-settings.png` });
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await expect(mode, 'Esc closed the popover, not the mode').toBeVisible();
  await expect(layers.getByRole('radio', { name: 'layer 2', exact: true }).locator('.tl-ptile__name')).toHaveText('Dirt path');
  await expect(layers.getByRole('radio', { name: 'layer 2', exact: true }).locator('.tl-ptile__sub')).toHaveText('tiling 3 m');

  // ---- Paint the material's layer 2 (picked by its key): the stored layer index is 1 and the ground's picture changes.
  await page.keyboard.press('1');
  await expect(layers.getByRole('radio', { name: 'layer 1', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('2');
  await expect(layers.getByRole('radio', { name: 'layer 2', exact: true })).toHaveAttribute('aria-checked', 'true');
  const at: [number, number] = [-9, -5];
  const layersAt = async (): Promise<number[]> => ((await query('queryTerrain', { entityId: hill, points: [at] }))['points'] as { layers: number[] }[])[0]!.layers;
  // The terrain draws the slots' textures (the backend assembles the array); give it a moment to arrive.
  await page.waitForTimeout(1500);
  const before = await patch();
  await paintStroke();
  await expect.poll(layersAt, { timeout: 15_000, message: 'the painted layer stored' }).toContain(1);
  await expect.poll(async () => meanDiff(await patch(), before), { timeout: 30_000, message: 'the painted dirt drawn' }).toBeGreaterThan(4);
  if (process.env['TL_SHOTS'] !== undefined) await page.screenshot({ path: `${process.env['TL_SHOTS']}/palette-paint.png` });

  // ---- Layers without a normal map or ORM map look as a material without them: the whole arrays unset (the reads'
  // own value) and an empty slot beside a filled one (the array's constant layer) draw as a flat normal and a neutral
  // ORM do — not white (tilted normals, fully rough and metal), which looks plainly different.
  const single = (rgba: readonly [number, number, number, number]): Uint8Array => new Uint8Array(makePng(64, 64, () => [rgba[0], rgba[1], rgba[2], rgba[3]]));
  await publishTexture(be, single([128, 128, 255, 255]), 'tex-flat-normal', 'Flat normal');
  await publishTexture(be, single([255, 204, 0, 255]), 'tex-orm-neutral', 'Neutral orm');
  await publishTexture(be, single([255, 255, 255, 255]), 'tex-orm-white', 'White orm');
  const withMaps = async (normals: unknown, orm: unknown): Promise<void> => {
    const def = (await mats()).find((m) => m.materialId === made.materialId)!;
    await cmd('setMaterial', { material: { ...def, parameters: def.parameters!.map((p) => (p.key === 'normals' ? { ...p, default: normals } : p.key === 'orm' ? { ...p, default: orm } : p)) } });
  };
  const unset = await patch();
  await withMaps('', ['tex-orm-white', 'tex-orm-white', '', '']);
  await expect.poll(async () => meanDiff(await patch(), unset), { timeout: 30_000, message: 'a white ORM differs from none' }).toBeGreaterThan(4);
  await withMaps(['tex-flat-normal', '', '', ''], ['tex-orm-neutral', '', '', '']);
  await expect.poll(async () => meanDiff(await patch(), unset), { timeout: 30_000, message: 'a flat normal and a neutral ORM (layer 2: empty slots) look as none' }).toBeLessThan(2);

  // ---- An albedo with its height in A wears no badge; the opaque ones keep theirs.
  await publishTexture(be, new Uint8Array(makePng(64, 64, (x, y) => (x % 16 === 0 || y % 16 === 0 ? [70, 65, 60, 20] : [160, 150, 140, 140 + ((x * 7 + y * 3) % 100)]))), 'tex-stones-h', 'Stones with height');
  const now = (await mats()).find((m) => m.materialId === made.materialId)!;
  await cmd('setMaterial', { material: { ...now, parameters: now.parameters!.map((p) => (p.key === 'albedoHeight' ? { ...p, default: ['tex-grass', 'tex-dirt', 'tex-stones-h', ''] } : p)) } });
  const stonesTile = layers.getByRole('radio', { name: 'layer 3', exact: true });
  await expect(stonesTile.locator('.tl-ptile__thumb')).toHaveAttribute('data-thumb', 'ready', { timeout: 30_000 });
  await expect(stonesTile.locator('.tl-ptile__name')).toHaveText('Stones with height');
  await expect(layers.getByRole('radio', { name: 'layer 2', exact: true }).getByLabel('no height in alpha')).toBeVisible({ timeout: 15_000 });
  await expect(stonesTile.getByLabel('no height in alpha')).toHaveCount(0);
  if (process.env['TL_SHOTS'] !== undefined) await layers.screenshot({ path: `${process.env['TL_SHOTS']}/palette-no-height.png` });
}

test('an editor command right after MCP edits is applied once the change feed brings them, not refused; an undo made on the older view is refused, not resent', async ({ page }) => {
  test.setTimeout(90_000);
  const crate = String((await cmd('createEntity', { sceneId: 'scene-main', kind: 'box', name: 'Crate', box: { size: [1, 1, 1], material: { color: '#b0b0b0' } }, transform: { position: [0, 0.5, 0] } }))['createdId']);
  // The MCP edits' change-feed events reach the page late (held for a while, or until released), as on a busy
  // page or a slow socket; every other message passes straight through.
  let hold: 'none' | 'late' | 'stalled' = 'none';
  const stalled: (() => void)[] = [];
  await page.routeWebSocket(/\/api\/v1\/ws/, (ws) => {
    const server = ws.connectToServer();
    server.onMessage((m) => {
      if (typeof m !== 'string' || !m.includes('e2e-editor-window') || hold === 'none') return ws.send(m);
      if (hold === 'late') setTimeout(() => ws.send(m), 800);
      else stalled.push(() => ws.send(m));
    });
    ws.onMessage((m) => server.send(m));
  });
  await open(page);
  await expect(row(page, crate)).toHaveCount(1);
  const boxes = async (): Promise<number> => Number((await query('queryEntities', { limit: 100, offset: 0 }))['total']);
  const before = await boxes();
  const rows = await page.locator('.tl-hierarchy__list li[data-entity-id]').count();

  // An MCP edit, then at once an editor command made on the view without it.
  hold = 'late';
  await cmd('updateEntity', { entityId: crate, name: 'Crate renamed' });
  await menu(page, 'GameObject', 'Box');
  await expect.poll(boxes).toBe(before + 1);
  await expect(row(page, crate)).toContainText('Crate renamed');
  await expect(page.locator('.tl-statusbar')).not.toContainText('conflict');

  // The feed stalls past the client's wait: the state is read again and the command still goes through.
  hold = 'stalled';
  await cmd('updateEntity', { entityId: crate, name: 'Crate again' });
  await menu(page, 'GameObject', 'Box');
  await expect.poll(boxes, { timeout: 15_000 }).toBe(before + 2);
  await expect(row(page, crate)).toContainText('Crate again');
  await expect(page.locator('.tl-statusbar')).not.toContainText('conflict');
  hold = 'none';
  for (const send of stalled.splice(0)) send();
  await expect(page.locator('.tl-hierarchy__list li[data-entity-id]')).toHaveCount(rows + 2);

  // An undo pressed before the view shows an MCP edit is refused and said so, never sent again (it would take that
  // edit back unseen); pressed again once the view shows it, it undoes the latest step, the MCP edit.
  const crateName = async (): Promise<string> => String(((await query('queryEntity', { entityId: crate }))['entity'] as { name?: string }).name);
  await page.locator('canvas.tl-viewport').hover();
  hold = 'late';
  await cmd('updateEntity', { entityId: crate, name: 'Crate by MCP' });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.tl-statusbar')).toContainText('undo refused', { timeout: 10_000 });
  await expect(row(page, crate)).toContainText('Crate by MCP');
  expect(await crateName()).toBe('Crate by MCP');
  expect(await boxes()).toBe(before + 2);
  hold = 'none';
  await page.keyboard.press('Control+z');
  await expect.poll(crateName).toBe('Crate again');
  await expect(page.locator('.tl-statusbar')).not.toContainText('refused');
  expect(await boxes()).toBe(before + 2);
});
