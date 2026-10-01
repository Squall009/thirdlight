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

/** The centre workspace's tab strip: the Scene and Game views and one tab per open item. */
const centreTabs = (page: Page): Locator => page.getByRole('tablist', { name: 'centre workspace' });

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A tool window's tab (to read what it shows, e.g. the Problems count); Problems carries its count in its name ("Problems3"). */
export function windowTab(page: Page, name: string): Locator {
  return dockTabs(page).getByRole('tab', { name: name === 'Problems' ? /^Problems\s*\d*$/ : name, exact: true });
}

/** Show a tool window (Lighting, Environment, Console, Problems, Materials, Behaviors, …). */
export async function openWindow(page: Page, name: string): Promise<void> {
  await windowTab(page, name).click();
}

/** Assert that a tool window is the one showing. */
export async function expectWindowOpen(page: Page, name: string): Promise<void> {
  await expect(windowTab(page, name)).toHaveAttribute('aria-selected', 'true');
}

/** Show the project window (folders, search, items) and return the panel that holds it. */
export async function projectWindow(page: Page): Promise<Locator> {
  await windowTab(page, 'Assets').click();
  return page.locator('.tl-assets');
}

/** The project-wide settings, by section. */
export type ProjectSettingsSection = 'Gameplay' | 'Input' | 'Tags' | 'Saves' | 'Game modes' | 'Game shell';

/** Show one section of the project settings. */
export async function openProjectSettings(page: Page, section: ProjectSettingsSection): Promise<void> {
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
  return centreTabs(page).getByRole('tab', typeof full === 'string' ? { name: full, exact: true } : { name: full });
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
 * Show an item's editor: brings it to the front when it is open, otherwise
 * opens the item by double-clicking it in the project window (found by name
 * with the project window's search, so it works however many items there are).
 */
export async function openEditor(page: Page, kind: EditorKind, name: string): Promise<void> {
  const tab = editorTab(page, kind, name);
  if ((await tab.count()) === 0) {
    const panel = await projectWindow(page);
    await panel.getByRole('button', { name: 'folder (game folder)', exact: true }).click();
    const search = panel.getByLabel('search the project');
    const before = await search.inputValue();
    const t = ITEM_KIND_OF[kind];
    await search.fill(t === null ? name : `t:${t} ${name}`);
    const items = panel.locator(t === null ? 'li.tl-project__item' : `li.tl-project__item[data-item-kind="${t}"]`);
    await items.filter({ has: page.locator('.tl-tile__name', { hasText: new RegExp(`^${escapeRe(name)}$`) }) }).first().dblclick();
    await expect(tab).toHaveCount(1);
    await search.fill(before);
  }
  await tab.click();
  await expectEditorOpen(page, kind, name);
}

/**
 * Close an item's editor, or with no item return to the default view (the
 * Scene view, the editors set aside).
 */
export async function closeEditor(page: Page, kind?: EditorKind, name?: string): Promise<void> {
  if (kind !== undefined && name !== undefined) {
    await page.getByRole('button', { name: `Close ${kind}: ${name}`, exact: true }).click();
    return;
  }
  await centreTabs(page).getByRole('tab', { name: 'Scene', exact: true }).click();
}

/** Show the Scene or the Game view (the default view's two views). */
export async function showView(page: Page, view: 'Scene' | 'Game'): Promise<void> {
  await centreTabs(page).getByRole('tab', { name: view, exact: true }).click();
}

/** The Scene or Game view's tab (to assert which one shows). */
export function viewTab(page: Page, view: 'Scene' | 'Game'): Locator {
  return centreTabs(page).getByRole('tab', { name: view, exact: true });
}
