/**
 * The editor window. A double-click in the project window opens the item in
 * a full window over the editor — its editor on the left, the one Inspector
 * on the right, one splitter whose width is remembered; several open items
 * are tabs of the window (switch, reorder by drag, close, middle-click,
 * Ctrl+Tab), remembered over a reload. Esc or × return to the default view
 * with the selection it had; undo, the change feed and MCP edits reach the
 * open editor. The default view's centre keeps the Scene and Game views only.
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

import { expect, test, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { skinnedGlb } from './skinned-glb';
import { decodePng } from './png';
import { editMode, editModeTab, editorPane, editorTab, editorWindow, inspector, menu, openEditor, projectWindow } from './ui';

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
  test.setTimeout(150_000);
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
});

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

/** A point on the marker's top face (away from its size handle in the middle). */
const MARK: [number, number, number] = [0.5, 2, -0.4];

/** A terrain's edit mode: entered three ways, isolation, Context, the rail, an edit undone, an MCP edit, Play aside and back, Esc. */
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

  // ---- A double-click on its row opens the terrain editor over the work area, the Scene view lent to it.
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
  // Its settings column holds the terrain's tools (Sculpt first), armed in the lent view; the status line says what to do.
  await expect(mode.getByLabel('terrain tools')).toBeVisible();
  await expect(canvas).toHaveAttribute('data-terrain-tool', 'raise');
  await expect(mode.getByLabel('edit mode hints')).toContainText('Drag on the ground to shape it.');

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

  // ---- Esc leaves: the canvas home again, the selection from before (the terrain, clicked by the double-click).
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

test('an editor command right after MCP edits is applied once the change feed brings them, not refused', async ({ page }) => {
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
});
