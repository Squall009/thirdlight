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

/** The editor window's tab strip: one tab per open item. */
const windowTabs = (page: Page): Locator => editorWindow(page).getByRole('tablist', { name: 'open items' });

/** The one Inspector, wherever it stands (the right dock, or the editor window's right side). */
export function inspector(page: Page): Locator {
  return page.locator('[data-tl-inspector]');
}

/** Back to the default view when the editor window shows (its tabs stay for the next item opened). */
async function leaveEditorWindow(page: Page): Promise<void> {
  const win = editorWindow(page);
  if ((await win.count()) === 0) return;
  await win.getByRole('button', { name: 'Close the editor window', exact: true }).click();
  await expect(win).toHaveCount(0);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A tool window's tab (to read what it shows, e.g. the Problems count); Problems carries its count in its name ("Problems3"). */
export function windowTab(page: Page, name: string): Locator {
  return dockTabs(page).getByRole('tab', { name: name === 'Problems' ? /^Problems\s*\d*$/ : name, exact: true });
}

/** Show a tool window (Lighting, Environment, Console, Problems, Materials, Behaviors, …). */
export async function openWindow(page: Page, name: string): Promise<void> {
  await leaveEditorWindow(page);
  await windowTab(page, name).click();
  if (name === 'Assets') await restoreSearch(page);
}

/** Assert that a tool window is the one showing. */
export async function expectWindowOpen(page: Page, name: string): Promise<void> {
  await expect(windowTab(page, name)).toHaveAttribute('aria-selected', 'true');
}

/**
 * The project window's search as it was before openEditor searched it. The
 * editor window covers the project window once the item opens, so the search
 * is put back the next time the project window shows (a fill on the covered
 * field would type into the editor in front).
 */
const searchBefore = new WeakMap<Page, string>();

/** Show the project window (folders, search, items) and return the panel that holds it. */
export async function projectWindow(page: Page): Promise<Locator> {
  await leaveEditorWindow(page);
  await windowTab(page, 'Assets').click();
  await restoreSearch(page);
  return page.locator('.tl-assets');
}

/** Put back a search openEditor typed, once the project window shows again. */
async function restoreSearch(page: Page): Promise<void> {
  const search = searchBefore.get(page);
  if (search === undefined) return;
  searchBefore.delete(page);
  await page.locator('.tl-assets').getByLabel('search the project').fill(search);
}


/** The project-wide settings, by section. */
export type ProjectSettingsSection = 'Gameplay' | 'Input' | 'Tags' | 'Saves' | 'Game modes' | 'Game shell';

/** Show one section of the project settings. */
export async function openProjectSettings(page: Page, section: ProjectSettingsSection): Promise<void> {
  await leaveEditorWindow(page);
  await windowTab(page, section).click();
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
  const tab = editorTab(page, kind, name);
  if ((await tab.count()) === 0) {
    const panel = await projectWindow(page);
    await panel.getByRole('button', { name: 'folder (game folder)', exact: true }).click();
    const search = panel.getByLabel('search the project');
    const before = await search.inputValue();
    const t = ITEM_KIND_OF[kind];
    if (!searchBefore.has(page)) searchBefore.set(page, before);
    await search.fill(t === null ? name : `t:${t} ${name}`);
    const items = panel.locator(t === null ? 'li.tl-project__item' : `li.tl-project__item[data-item-kind="${t}"]`);
    await items.filter({ has: page.locator('.tl-tile__name', { hasText: new RegExp(`^${escapeRe(name)}$`) }) }).first().dblclick();
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
