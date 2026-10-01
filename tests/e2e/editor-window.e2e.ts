/**
 * The editor window. A double-click in the project window opens the item in
 * a full window over the editor — its editor on the left, the one Inspector
 * on the right, one splitter whose width is remembered; several open items
 * are tabs of the window (switch, reorder by drag, close, middle-click,
 * Ctrl+Tab), remembered over a reload. Esc or × return to the default view
 * with the selection it had; undo, the change feed and MCP edits reach the
 * open editor. The default view's centre keeps the Scene and Game views only.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { skinnedGlb } from './skinned-glb';
import { editorPane, editorTab, editorWindow, inspector, menu, openEditor, projectWindow } from './ui';

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
  const crate = String((await cmd('createEntity', { kind: 'box', name: 'Crate', box: { size: [1, 1, 1], material: { color: '#b0b0b0' } }, transform: { position: [0, 0.5, 0] } }))['createdId']);
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
  // The editor has caught up with the MCP edits (its next command is sent at the backend's revision).
  const revision = Number((await query('queryProject'))['revision']);
  await expect(page.locator('.tl-statusbar')).toContainText(`revision ${revision}`);

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

  // A box made from the menu bar while the window shows is selected underneath; closing the window
  // returns to the default view with the selection it had when the window opened.
  await menu(page, 'GameObject', 'Box');
  await expect.poll(async () => page.locator('.tl-hierarchy__list li[data-entity-id]').count()).toBeGreaterThan(1);
  const made = page.locator('.tl-hierarchy__list li[aria-selected="true"]');
  await expect(made).toHaveCount(1);
  await expect(made).not.toHaveAttribute('data-entity-id', crate);
  await page.keyboard.press('Escape');
  await expect(win).toHaveCount(0);
  await expect(row(page, crate)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tl-hierarchy__list li[aria-selected="true"]')).toHaveCount(1);
  await expect(inspector(page)).toHaveAttribute('data-tl-inspector', 'dock');

  // A second item joins the window's tabs (the window's tabs stayed while it was closed).
  await openEditor(page, 'Animator', 'Walker');
  expect(await windowTabs(page)).toEqual(['Script: Mover', 'Animator: Walker']);
  const animView = editorPane(page, 'Animator', /Walker/);
  await expect(animView.getByLabel('animator graph').getByRole('group', { name: 'State Idle node state-01' })).toBeVisible();
  // The Inspector in the window shows the animator's selection.
  await expect(inspector(page).locator('[aria-label="animator inspector"]')).toHaveCount(1);
  // An edit from the window, undone with Ctrl+Z while it shows; an MCP edit reaches the open tab.
  const storedName = async (): Promise<string | undefined> => ((await query('queryGameConfig'))['animators'] as { controllerId: string; name: string }[] | undefined)?.find((c) => c.controllerId === 'animator-01')?.name;
  await animView.getByLabel('controller name').fill('Walker B');
  await animView.getByLabel('controller name').blur();
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

test('"Open" beside an Inspector reference opens the item in the window; Esc returns with the selection', async ({ page }) => {
  test.setTimeout(90_000);
  await cmd('setMaterial', { material: { materialId: 'mat-one', name: 'Mat One', shader: 'standard', params: { roughness: 0.5 }, textures: {}, graph: { nodes: [{ id: 'output', type: 'pbr', position: [400, 0] }], edges: [] } } });
  await cmd('setMaterial', { material: { materialId: 'mat-plain', name: 'Mat Plain', shader: 'standard', params: { roughness: 0.5 }, textures: {} } });
  const crate = String((await cmd('createEntity', { kind: 'box', name: 'Crate', box: { size: [1, 1, 1], material: { color: '#b0b0b0' } }, transform: { position: [0, 0.5, 0] }, components: { materials: { '*': 'mat-one' } } }))['createdId']);
  await open(page);
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
});

test('the default view keeps the Scene and Game views and the maximize toggle', async ({ page }) => {
  test.setTimeout(60_000);
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
});
