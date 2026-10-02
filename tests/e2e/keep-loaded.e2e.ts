/**
 * Keep loaded in the editor: the Inspector's "Keep loaded" flag writes the
 * object's `keepLoaded` (one undoable edit) and the hierarchy marks every kept
 * object — its own flag, or kept with the object above (the Inspector says
 * which). A new project's camera and player are kept (the upgrade's shape).
 * Against a real backend; the stored flag is read back over HTTP.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { STARTER, startBackend, type E2EBackend } from './backend';
import { createBox, inspector } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number(q['revision']), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-keep-loaded' }, args });
  expect(res['ok'], JSON.stringify(res)).toBe(true);
  return res;
}
const kept = async (id: string): Promise<boolean> => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId: id } }))['entity'] as { keepLoaded?: boolean } | undefined)?.keepLoaded === true;
const row = (page: Page, id: string) => page.locator(`.tl-hierarchy__list li[data-entity-id="${id}"]`);
const marker = (page: Page, id: string) => row(page, id).locator('[data-flag="kept"]');

test('the Keep loaded flag in the Inspector, kept objects marked in the hierarchy', async ({ page }) => {
  be = await startBackend('keep-loaded-e2e', 'starter');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The starter's camera and player are kept; its spawn and ground are not.
  await expect(marker(page, STARTER.cameraId)).toHaveCount(1);
  await expect(marker(page, STARTER.playerId)).toHaveCount(1);
  await expect(marker(page, STARTER.spawnId)).toHaveCount(0);
  await expect(marker(page, STARTER.groundId)).toHaveCount(0);
  await row(page, STARTER.playerId).click();
  await expect(inspector(page).getByLabel('Keep loaded', { exact: true })).toBeChecked();

  // A new box: not kept; the Inspector flag keeps it.
  const ids = async (): Promise<string[]> => ((await be.command({ op: 'queryEntities', projectId: be.projectId, args: { limit: 100, offset: 0 } }))['entities'] as { id: string }[]).map((e) => e.id);
  const before = await ids();
  await createBox(page);
  await expect.poll(async () => (await ids()).length).toBe(before.length + 1);
  const boxId = (await ids()).find((id) => !before.includes(id))!;
  await row(page, boxId).click();
  const flag = inspector(page).getByLabel('Keep loaded', { exact: true });
  await expect(flag).not.toBeChecked();
  await expect(marker(page, boxId)).toHaveCount(0);
  await flag.click();
  await expect.poll(() => kept(boxId)).toBe(true);
  await expect(marker(page, boxId)).toHaveCount(1);
  await expect(marker(page, boxId)).toHaveAttribute('title', /survives scene changes/);

  // A child of a kept object is kept with it: marked, and the Inspector says from where.
  const child = String((await cmd('createEntity', { parentId: boxId, kind: 'group', name: 'Lid' }))['createdId']);
  await expect(marker(page, child)).toHaveCount(1);
  await expect(marker(page, child)).toHaveAttribute('title', /kept loaded with the object above/);
  await row(page, child).click();
  await expect(inspector(page).locator('[data-flag="keepLoaded"]')).toContainText('kept loaded — inherited from');
  await expect(inspector(page).getByLabel('Keep loaded', { exact: true })).not.toBeChecked();

  // Clear the flag: the box and its child are not kept any more.
  await row(page, boxId).click();
  await inspector(page).getByLabel('Keep loaded', { exact: true }).click();
  await expect.poll(() => kept(boxId)).toBe(false);
  await expect(marker(page, boxId)).toHaveCount(0);
  await expect(marker(page, child)).toHaveCount(0);
});
