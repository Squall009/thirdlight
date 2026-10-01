/** Shared helpers for driving the editor's menus in browser tests. */
import { expect, type Locator, type Page } from '@playwright/test';

/** Open a top-level menu and return the item locator (still open). */
export async function menuItem(page: Page, menu: string, item: string): Promise<Locator> {
  await page.getByRole('menubar').getByRole('menuitem', { name: menu, exact: true }).click();
  const it = page.getByRole('menu').getByRole('menuitem', { name: item, exact: true });
  await expect(it).toBeVisible();
  return it;
}

/** Close whichever menu is open. */
export async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
}

/** Click a menu item (optionally in a submenu). */
export async function menu(page: Page, top: string, item: string, sub?: string): Promise<void> {
  const it = await menuItem(page, top, item);
  if (sub === undefined) {
    await it.click();
    return;
  }
  await it.hover();
  await it.getByRole('menuitem', { name: sub, exact: true }).click();
}

/** GameObject → Box. */
export async function createBox(page: Page): Promise<void> {
  await menu(page, 'GameObject', 'Box');
}

// Where the editor's windows, editors and settings are. Specs open them
// through these helpers, never by clicking a dock or centre tab by name, so a
// change of layout (full-window editors, a Project Settings window, Window
// menu tools) changes these functions instead of every spec.

/** The bottom dock's own tab strip (panels inside it carry tab strips of their own). */
const dockTabs = (page: Page): Locator => page.locator('.tl-dock--bottom > [role="tablist"]');

/** The default view's centre tab strip: the Scene and Game views. */
const centreTabs = (page: Page): Locator => page.getByRole('tablist', { name: 'centre workspace' });

/** The editor window over the editor (an opened item's editor beside the Inspector), while it shows. */
export function editorWindow(page: Page): Locator {
  return page.getByRole('region', { name: 'editor window', exact: true });
}

/** The editor window's one preview pane (above the Inspector), shown while the front editor previews. */
export function previewPane(page: Page): Locator {
  return editorWindow(page).getByRole('region', { name: 'preview pane', exact: true });
}

/** The preview pane's canvas (its renderer's frames, subject and live resource counts are its data attributes). */
export function previewCanvas(page: Page): Locator {
  return previewPane(page).getByLabel('preview canvas', { exact: true });
}

/** The editor window's tab strip: one tab per open item. */
const windowTabs = (page: Page): Locator => editorWindow(page).getByRole('tablist', { name: 'open items' });

/** The one Inspector, wherever it stands (the right dock, or the editor window's right side). */
export function inspector(page: Page): Locator {
  return page.locator('[data-tl-inspector]');
}

/** The Project Settings window (over the editor and the editor window), while it shows. */
export function settingsWindow(page: Page): Locator {
  return page.getByRole('region', { name: 'project settings', exact: true });
}

/** Close the Project Settings window when it shows (× in its corner). */
export async function closeProjectSettings(page: Page): Promise<void> {
  const win = settingsWindow(page);
  if ((await win.count()) === 0) return;
  await win.getByRole('button', { name: 'Close project settings', exact: true }).click();
  await expect(win).toHaveCount(0);
}

/**
 * Back to the default view when a full window shows: Project Settings
 * closes, then the editor window (its tabs stay for the next item opened).
 */
async function leaveEditorWindow(page: Page): Promise<void> {
  await closeProjectSettings(page);
  const win = editorWindow(page);
  if ((await win.count()) === 0) return;
  await win.getByRole('button', { name: 'Close the editor window', exact: true }).click();
  await expect(win).toHaveCount(0);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The dock tab a name stands for: the project window's tab is "Project" (specs may still say "Assets"). */
const DOCK_TAB_NAME: Readonly<Record<string, string>> = { Assets: 'Project' };

/** A tool window's tab (to read what it shows, e.g. the Problems count); Problems carries its count in its name ("Problems3"). */
export function windowTab(page: Page, name: string): Locator {
  return dockTabs(page).getByRole('tab', { name: name === 'Problems' ? /^Problems\s*\d*$/ : (DOCK_TAB_NAME[name] ?? name), exact: true });
}

/** Tools whose panel moved into Project Settings, and the sub-tab that holds it (Media's event sounds are Audio). */
const IN_PROJECT_SETTINGS: Readonly<Record<string, ProjectSettingsSection>> = { Behaviors: 'Scripts', Media: 'Audio' };

/** The Window menu's floating tool windows (scene settings over the Scene view). */
const FLOATING = new Set(['Lighting', 'Environment']);

/** A floating tool window (Lighting, Environment), while it shows. */
export function toolWindow(page: Page, name: string): Locator {
  return page.getByRole('region', { name: `${name} window`, exact: true });
}

/** A floating tool window's scene bar: the scene it edits (`data-scene-id`) and its picker. */
export function toolWindowScene(page: Page, name: string): Locator {
  return toolWindow(page, name).locator('.tl-tool-window__scene');
}

/**
 * Open a floating tool window from the Window menu and move it out of the
 * Scene view by its title bar, over the right end of the bottom dock (below
 * its tab strip), sized to fit there: specs read the Scene view's pixels with
 * the window open, and a person moves such a window out of the way as well.
 */
async function openToolWindow(page: Page, name: string): Promise<void> {
  await leaveEditorWindow(page);
  await menu(page, 'Window', name);
  const win = toolWindow(page, name);
  await expect(win).toBeVisible();
  const dock = await page.locator('.tl-dock--bottom').boundingBox();
  const tabs = await dockTabs(page).boundingBox();
  const box = await win.boundingBox();
  if (dock === null || tabs === null || box === null) throw new Error(`the ${name} window or the bottom dock has no box`);
  const top = tabs.y + tabs.height + 4;
  const room = { width: 420, height: dock.y + dock.height - top - 4 };
  // Resize first (the corner), then move (the title bar): each drag is a real pointer drag.
  const corner = win.getByLabel(`Resize the ${name} window`, { exact: true });
  const c = (await corner.boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + room.width - c.width / 2, box.y + room.height - c.height / 2, { steps: 4 });
  await page.mouse.up();
  const title = win.getByLabel(`Move the ${name} window`, { exact: true });
  const t = (await title.boundingBox())!;
  const grab = { x: t.x + 60, y: t.y + t.height / 2 };
  const to = { x: dock.x + dock.width - room.width - 4, y: top };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(to.x + 60, to.y + t.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs(((await win.boundingBox())?.y ?? 0) - to.y)).toBeLessThan(2);
}

/**
 * Show a block layer's tools: they are in the Inspector while a block layer
 * is selected, so the first block layer in the Hierarchy is selected.
 */
async function openBlockTools(page: Page): Promise<void> {
  await leaveEditorWindow(page);
  const panel = page.getByLabel('blocks panel', { exact: true });
  if (await panel.isVisible()) return;
  await page.locator('.tl-hierarchy__list li[data-block-layer]').first().click();
  await expect(panel).toBeVisible();
}

/**
 * Put a block layer's tools away by deselecting the layer (Ctrl+click its
 * row): they were a dock tab that showing another tab closed, and specs that
 * read the Scene view's pixels after that expect them disarmed.
 */
async function leaveBlockTools(page: Page): Promise<void> {
  if (!(await page.getByLabel('blocks panel', { exact: true }).isVisible())) return;
  await page.locator('.tl-hierarchy__list li.tl-row.is-selected[data-block-layer]').first().click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByLabel('blocks panel', { exact: true })).toHaveCount(0);
}

/** Show a tool window (Lighting, Environment, Blocks, Console, Problems, Materials, Behaviors, …). */
export async function openWindow(page: Page, name: string): Promise<void> {
  const section = IN_PROJECT_SETTINGS[name];
  if (section !== undefined) return openProjectSettings(page, section);
  if (FLOATING.has(name)) return openToolWindow(page, name);
  if (name === 'Blocks') return openBlockTools(page);
  await leaveEditorWindow(page);
  await leaveBlockTools(page);
  await windowTab(page, name).click();
  if (name === 'Assets') await restoreSearch(page);
}

/** Assert that a tool window is the one showing (a floating one: that it shows). */
export async function expectWindowOpen(page: Page, name: string): Promise<void> {
  if (FLOATING.has(name)) return expect(toolWindow(page, name)).toBeVisible();
  await expect(windowTab(page, name)).toHaveAttribute('aria-selected', 'true');
}

/**
 * The project window's search as it was before openEditor searched it. The
 * editor window covers the project window once the item opens, so the search
 * is put back the next time the project window shows (a fill on the covered
 * field would type into the editor in front).
 */
const searchBefore = new WeakMap<Page, { search: string; view: 'all' | string }>();

/** What the project window shows: All assets, or a folder (`''`: the game folder). */
async function projectView(panel: Locator): Promise<'all' | string> {
  if ((await panel.locator('.tl-project__crumbs .tl-project__crumb.is-current').textContent()) === 'All assets') return 'all';
  return (await panel.locator('.tl-project').getAttribute('data-folder')) ?? '';
}

/** Show the project window (folders, search, items) and return the panel that holds it. */
export async function projectWindow(page: Page): Promise<Locator> {
  await leaveEditorWindow(page);
  await leaveBlockTools(page);
  await windowTab(page, 'Project').click();
  await restoreSearch(page);
  return page.locator('.tl-assets');
}

/**
 * The tile of an item in the project window, found by its name (or its id)
 * with the project window's search (`t:<kind>` narrows it), so it works
 * however many items there are. The search is put back the next time the
 * project window shows.
 */
async function findItem(page: Page, kind: string | null, name: string): Promise<Locator> {
  const panel = await projectWindow(page);
  const search = panel.getByLabel('search the project');
  const view = await projectView(panel);
  if (!searchBefore.has(page)) searchBefore.set(page, { search: await search.inputValue(), view });
  // All assets finds any kind a `t:` names; a folder finds only what is inside it: search the whole game folder.
  if (view !== 'all' || kind === null) await panel.getByRole('button', { name: 'folder (game folder)', exact: true }).click();
  await search.fill(kind === null ? name : `t:${kind} ${name}`);
  const items = panel.locator(kind === null ? 'li.tl-project__item' : `li.tl-project__item[data-item-kind="${kind}"], li[data-asset-id][data-kind="${kind}"]`);
  const id = JSON.stringify(name);
  const tile = items.filter({ has: page.locator('.tl-tile__name', { hasText: new RegExp(`^${escapeRe(name)}$`) }) }).or(items.and(panel.locator(`li[data-asset-id=${id}], li[data-item-id=${id}]`))).first();
  await expect(tile).toBeVisible();
  return tile;
}

/**
 * Show an item in the Inspector: one click on it in the project window (an
 * asset, a material, a prefab, a resource, a scene), by name or id. `kind` is
 * the project window's kind (`material`, `prefab`, `model`, `audio`, …).
 */
export async function chooseItem(page: Page, kind: string, name: string): Promise<void> {
  await (await findItem(page, kind, name)).click();
  // A resource's Inspector names it as "<kind> inspector", an asset's as "<kind> asset inspector".
  await expect(inspector(page).locator(`[aria-label="${kind} inspector"], [aria-label="${kind} asset inspector"]`)).toBeVisible();
}

/**
 * Make a new item from the project window's Create menu, in the folder it
 * shows: `what` is the menu entry ("Material", "Effect", "UI theme"), or a
 * submenu and its entry (["Graph material", "Water"], ["Graph", "Test"]); the
 * name is typed where the menu asks for it. Items with an editor open in it.
 */
export async function createItem(page: Page, what: string | readonly [string, string], name: string): Promise<void> {
  const panel = await projectWindow(page);
  await panel.getByRole('button', { name: /^create/ }).click();
  const menu = page.getByRole('menu', { name: 'create menu', exact: true });
  await expect(menu).toBeVisible();
  if (typeof what === 'string') await menu.getByRole('menuitem', { name: what, exact: true }).first().click();
  else {
    await menu.getByRole('menuitem', { name: what[0], exact: true }).click();
    await menu.getByRole('menu', { name: what[0], exact: true }).getByRole('menuitem', { name: what[1], exact: true }).click();
  }
  const field = panel.getByLabel('new item name', { exact: true });
  await field.fill(name);
  await field.press('Enter');
  await expect(field).toHaveCount(0);
}

/** Put back the search (and the folder) a lookup changed, once the project window shows again. */
async function restoreSearch(page: Page): Promise<void> {
  const before = searchBefore.get(page);
  if (before === undefined) return;
  searchBefore.delete(page);
  const panel = page.locator('.tl-assets');
  if ((await projectView(panel)) !== before.view) {
    const node = before.view === 'all' ? panel.getByRole('button', { name: 'all assets', exact: true }) : panel.getByRole('button', { name: `folder ${before.view === '' ? '(game folder)' : before.view}`, exact: true });
    if (await node.isVisible()) await node.click();
  }
  await panel.getByLabel('search the project').fill(before.search);
}


/** The project-wide settings, by section (the Project Settings window's sub-tabs). */
export type ProjectSettingsSection = 'Gameplay' | 'Input' | 'Tags' | 'Collision layers' | 'Quality' | 'Audio' | 'Dialogue' | 'Saves' | 'Game modes' | 'Game shell' | 'Scripts';

/** A sub-tab of the Project Settings window. */
export function settingsTab(page: Page, section: ProjectSettingsSection): Locator {
  return settingsWindow(page).getByRole('tablist', { name: 'project settings sections' }).getByRole('tab', { name: section, exact: true });
}

/**
 * Show one section of the project settings: File → Project Settings… (over
 * the default view), its search cleared, the section's sub-tab chosen.
 */
export async function openProjectSettings(page: Page, section: ProjectSettingsSection): Promise<void> {
  if ((await settingsWindow(page).count()) === 0) {
    await leaveEditorWindow(page);
    await menu(page, 'File', 'Project Settings…');
    await expect(settingsWindow(page)).toBeVisible();
  }
  const search = settingsWindow(page).getByLabel('Search project settings', { exact: true });
  if ((await search.inputValue()) !== '') await search.fill('');
  await settingsTab(page, section).click();
  await expect(settingsTab(page, section)).toHaveAttribute('aria-selected', 'true');
}

/**
 * The kinds of item that open in an editor, by the name the editor shows them
 * under ("Material: Glow"). "Graph" is a standalone graph or a visual script.
 */
export type EditorKind = 'Animator' | 'Script' | 'Graph' | 'Material' | 'Effect' | 'Library' | 'Dialogue' | 'Timeline' | 'UI' | 'UI theme';

/** The project window's `t:` filter for an editor kind; a visual script is a behavior, so "Graph" has none. */
const ITEM_KIND_OF: Readonly<Record<EditorKind, string | null>> = {
  Animator: 'animator',
  Script: 'behavior',
  Graph: null,
  Material: 'material',
  Effect: 'effect',
  Library: 'library',
  Dialogue: 'dialogue',
  Timeline: 'timeline',
  UI: 'ui',
  'UI theme': 'uitheme',
};

/**
 * The tab of an open item's editor, or with no name every open editor of the
 * kind (for counts). A name may be a pattern.
 */
export function editorTab(page: Page, kind: EditorKind, name?: string | RegExp): Locator {
  const full = name === undefined ? new RegExp(`^${escapeRe(kind)}: `) : typeof name === 'string' ? `${kind}: ${name}` : new RegExp(`^${escapeRe(kind)}: (?:${name.source})`);
  return windowTabs(page).getByRole('tab', typeof full === 'string' ? { name: full, exact: true } : { name: full });
}

/** The editing area of an open item (what its editor draws). A name may be a pattern (an item renamed while open). */
export function editorPane(page: Page, kind: EditorKind, name: string | RegExp): Locator {
  return typeof name === 'string'
    ? page.getByRole('tabpanel', { name: `${kind}: ${name}`, exact: true })
    : page.getByRole('tabpanel', { name: new RegExp(`^${escapeRe(kind)}: (?:${name.source})`) });
}

/** Assert that the item's editor is the one showing. */
export async function expectEditorOpen(page: Page, kind: EditorKind, name: string): Promise<void> {
  await expect(editorTab(page, kind, name)).toHaveAttribute('aria-selected', 'true');
}

/**
 * Show an item's editor in the editor window: brings its tab to the front
 * when the window shows it, otherwise opens the item by double-clicking it in
 * the project window (found by name with the project window's search, so it
 * works however many items there are).
 */
export async function openEditor(page: Page, kind: EditorKind, name: string): Promise<void> {
  await closeProjectSettings(page);
  const tab = editorTab(page, kind, name);
  if ((await tab.count()) === 0) {
    await (await findItem(page, ITEM_KIND_OF[kind], name)).dblclick();
    await expect(tab).toHaveCount(1);
  }
  await tab.click();
  await expectEditorOpen(page, kind, name);
}

/**
 * Close an item's editor (its tab in the editor window), or with no item
 * return to the default view: the editor window closes (Esc, ×) and the
 * Scene view shows.
 */
export async function closeEditor(page: Page, kind?: EditorKind, name?: string): Promise<void> {
  if (kind !== undefined && name !== undefined) {
    await windowTabs(page).getByRole('button', { name: `Close ${kind}: ${name}`, exact: true }).click();
    return;
  }
  await leaveEditorWindow(page);
  await centreTabs(page).getByRole('tab', { name: 'Scene', exact: true }).click();
}

/** Show the Scene or the Game view (the default view's two views). */
export async function showView(page: Page, view: 'Scene' | 'Game'): Promise<void> {
  await leaveEditorWindow(page);
  await centreTabs(page).getByRole('tab', { name: view, exact: true }).click();
}

/** The Scene or Game view's tab (to assert which one shows). */
export function viewTab(page: Page, view: 'Scene' | 'Game'): Locator {
  return centreTabs(page).getByRole('tab', { name: view, exact: true });
}
