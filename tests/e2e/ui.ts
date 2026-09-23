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
