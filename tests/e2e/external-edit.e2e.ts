/**
 * Editing the project files outside the editor (e.g. by the coding harness)
 * pauses writes and asks the user which version to keep.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { createBox, openWindow, closeEditor, windowTab } from './ui';


let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

const envelope = (): string => join(be.projectDir, 'scenes', 'scene-main.json');

// Both edits run on one backend and page: the corrupt edit comes after the valid one was loaded, as a user would meet them.
test('a valid edit on disk is announced and can be loaded; a corrupt edit cannot be loaded, keeping the editor version resumes editing', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  const doc = JSON.parse(readFileSync(envelope(), 'utf8'));
  doc.scene.entities[0].name = 'Edited on disk';
  writeFileSync(envelope(), JSON.stringify(doc, null, 2) + '\n');

  const banner = page.locator('.tl-notice--external');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await banner.getByRole('button', { name: 'load disk version' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('.tl-hierarchy__list li.tl-row').filter({ hasText: 'Edited on disk' })).toHaveCount(1);

  // A corrupt edit after it.
  writeFileSync(envelope(), '{ not json');
  await expect(banner).toBeVisible({ timeout: 10_000 });
  await expect(banner).toContainText('invalid');
  await expect(banner.getByRole('button', { name: 'load disk version' })).toBeDisabled();

  await openWindow(page, 'Problems');
  await expect(page.locator('.tl-problem').first()).toContainText('changed on disk');
  await closeEditor(page);

  await banner.getByRole('button', { name: 'keep editor version' }).click();
  await expect(banner).toHaveCount(0);
  const before = await page.locator('.tl-hierarchy__list li.tl-row').count();
  await createBox(page);
  await expect(page.locator('.tl-hierarchy__list li.tl-row')).toHaveCount(before + 1);
});

test('a failed command from any client shows up in Problems live', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const res = await be.command({
    op: 'updateEntity',
    projectId: be.projectId,
    expectedRevision: q.revision,
    requestId: `req-${'b'.repeat(32)}`,
    origin: { kind: 'mcp', clientId: 'e2e' },
    args: { entityId: 'cam-main', parentId: 'no-such-entity' },
  });
  expect(res.ok).toBe(false);
  await expect(windowTab(page, 'Problems')).toContainText('1');
  await openWindow(page, 'Problems');
  await expect(page.locator('.tl-problem').first()).toContainText('updateEntity');
});
