/**
 * The screens before a project is open: the owner token is entered once,
 * the picker lists the backend's projects, and a new project is created
 * from a template (or empty) and opened in the editor.
 */
import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('picker-0001');
});
test.afterEach(async () => {
  await be.stop();
});

const status = (page: import('@playwright/test').Page) => page.locator('.tl-statusbar');
const rows = (page: import('@playwright/test').Page) => page.locator('.tl-hierarchy__list li.tl-row');

test('token once, then pick a project or create one from a template', async ({ page }) => {
  // No token yet: the token form, not the picker.
  await page.goto(`${be.origin}/`);
  await expect(page.getByLabel('Access token')).toBeVisible();
  await page.getByLabel('Access token').fill(be.token);
  await page.getByRole('button', { name: 'Open' }).click();

  // The picker lists the existing project.
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  const existing = page.locator('.tl-projects__row').filter({ hasText: 'picker-0001' });
  await expect(existing).toHaveCount(1);
  await expect(existing).toContainText('E2E Project');

  // Create a Beacon Reach project from the template and land in the editor.
  await page.getByLabel('Project id').fill('reach-copy');
  await page.getByLabel('Name').fill('Reach copy');
  await page.getByLabel('Template').selectOption('beacon-reach');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page).filter({ hasText: 'Player' })).toHaveCount(1);
  expect(new URL(page.url()).searchParams.get('project')).toBe('reach-copy');

  // Back to the picker from the toolbar: both projects, then an empty one.
  await page.getByTitle('All projects').click();
  await expect(page.locator('.tl-projects__row')).toHaveCount(2);
  await expect(page.locator('.tl-projects__row').filter({ hasText: 'Reach copy' })).toHaveCount(1);
  await page.getByLabel('Project id').fill('blank');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(status(page)).toContainText('connected');
  await expect(rows(page).filter({ hasText: 'Player' })).toHaveCount(0);
  await expect(rows(page)).not.toHaveCount(0);

  // A duplicate id is refused with a message; the picker stays.
  await page.getByTitle('All projects').click();
  await page.getByLabel('Project id').fill('blank');
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(page.getByText('already exists')).toBeVisible();

  // Opening an existing project from the list works, and the stored token
  // is reused (no form).
  await page.locator('.tl-projects__open').filter({ hasText: 'picker-0001' }).click();
  await expect(status(page)).toContainText('connected');
});

test('a wrong token is rejected by the picker and asked for again', async ({ page }) => {
  await page.goto(`${be.origin}/#token=not-the-owner-token-at-all`);
  await expect(page.getByText('rejected the access token')).toBeVisible();
  await expect(page.getByLabel('Access token')).toBeVisible();
});
