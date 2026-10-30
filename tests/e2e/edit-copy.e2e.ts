/**
 * Duplicate a multi-selection with its children in one undo, and
 * Copy/Paste between scenes; a selection larger than any per-command count
 * the engine once had moves and pastes as one command, one undo each.
 */
import { expect, test, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { createBox, menu } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

const rows = (page: Page) => page.locator('.tl-hierarchy__list li.tl-row');
const header = (page: Page, name: string) => page.locator('.tl-scene-header').filter({ has: page.locator('.tl-scene-header__name', { hasText: new RegExp(`^${name}$`) }) });
async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args: op === 'queryEntities' ? { limit: 200, offset: 0, ...args } : args });
}

test('Duplicate (Ctrl+D) copies the whole selection with children, one undo; Copy/Paste works across scenes', async ({ page }) => {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const base = await rows(page).count();

  // Two boxes and a folder holding a third.
  await createBox(page);
  await createBox(page);
  await menu(page, 'GameObject', 'Folder');
  await expect(rows(page)).toHaveCount(base + 3);
  const folderRow = rows(page).filter({ hasText: 'folder' }).last();
  const folderId = (await folderRow.getAttribute('data-entity-id'))!;
  await createBox(page);
  await expect(rows(page)).toHaveCount(base + 4);
  const third = rows(page).last();
  const thirdId = (await third.getAttribute('data-entity-id'))!;
  expect((await be.command({ op: 'moveEntities', projectId: be.projectId, expectedRevision: (await query('queryEntities')).revision, requestId: `req-${'e'.repeat(31)}1`, args: { entityIds: [thirdId], parentId: folderId } })).ok).toBe(true);

  // Select the two loose boxes and the folder (Ctrl+click), then Ctrl+D.
  const boxes = rows(page).filter({ hasText: /^.*box.*$/ });
  const firstBox = boxes.nth(0);
  const secondBox = boxes.nth(1);
  await firstBox.click();
  await secondBox.click({ modifiers: ['Control'] });
  await page.locator(`.tl-hierarchy__list li[data-entity-id="${folderId}"]`).click({ modifiers: ['Control'] });
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+d');
  // 2 boxes + folder + its box = 4 new rows, in one command.
  await expect(rows(page)).toHaveCount(base + 8);
  const all = (await query('queryEntities')).entities as { id: string; parentId?: string; components: { folder?: object; transform?: { position: number[] } } }[];
  const folders = all.filter((e) => e.components.folder !== undefined);
  expect(folders).toHaveLength(2);
  const copyFolder = folders.find((f) => f.id !== folderId)!;
  expect(all.filter((e) => e.parentId === copyFolder.id)).toHaveLength(1);
  // Copies sit 0.5 m to the right of their originals.
  const orig = all.find((e) => e.id === (thirdId))!;
  const copyOfThird = all.find((e) => e.parentId === copyFolder.id)!;
  expect(copyOfThird.components.transform!.position[0]! - orig.components.transform!.position[0]!).toBeCloseTo(0.5, 5);
  await page.keyboard.press('Control+z');
  await expect(rows(page)).toHaveCount(base + 4);

  // Copy the two boxes, make a second scene, paste: the copies land there.
  await firstBox.click();
  await secondBox.click({ modifiers: ['Control'] });
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+c');
  await expect(page.locator('.tl-notice, [role="status"]').filter({ hasText: 'Copied 2 objects' }).first()).toBeVisible();
  await page.getByRole('button', { name: '+ Scene' }).click();
  await expect(header(page, 'Scene 2')).toHaveClass(/is-active/);
  const scenes = (await query('queryProject')).scenes as { sceneId: string; name: string }[];
  const secondId = scenes.find((s) => s.name === 'Scene 2')!.sceneId;
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+v');
  await expect(rows(page)).toHaveCount(base + 6);
  const inSecond = (await query('queryEntities', { sceneId: secondId })).entities as { id: string }[];
  expect(inSecond).toHaveLength(2);
  // The Edit menu offers the same.
  await page.getByRole('menuitem', { name: 'Edit' }).click();
  await expect(page.getByRole('menuitem', { name: /Paste/ })).toBeEnabled();
  await page.keyboard.press('Escape');

  await test.step('a selection of 270 (over the old 64 per move and 256 per paste) moves and pastes in one undo each', () => largeSelection(page, secondId));
});

/** The objects of a scene (every page of the query). */
async function countIn(sceneId: string): Promise<number> {
  let n = 0;
  for (let offset = 0; ; offset += 200) {
    const page = (await query('queryEntities', { sceneId, offset })).entities as unknown[];
    n += page.length;
    if (page.length < 200) return n;
  }
}

async function largeSelection(page: Page, sceneId: string): Promise<void> {
  const N = 270;
  const made = await be.command({
    op: 'createEntities',
    projectId: be.projectId,
    expectedRevision: (await query('queryProject')).revision,
    requestId: `req-${'e'.repeat(31)}2`,
    args: { sceneId, entities: [{ ref: 'target', kind: 'folder', name: 'Target' }, { ref: 'many', kind: 'folder', name: 'Many' }, ...Array.from({ length: N }, (_, i) => ({ kind: 'group', name: `g${i}`, parentId: 'many' }))] },
  });
  expect(made.ok, JSON.stringify(made).slice(0, 300)).toBe(true);
  const named = (name: string) => rows(page).filter({ has: page.locator('.tl-row__name', { hasText: new RegExp(`^${name}$`) }) });
  await expect(named(`g${N - 1}`)).toHaveCount(1);
  const id = async (name: string): Promise<string> => (await named(name).getAttribute('data-entity-id'))!;
  const [targetId, manyId, first, last] = [await id('Target'), await id('Many'), await id('g0'), await id(`g${N - 1}`)];
  const parentOf = async (entityId: string): Promise<string | undefined> => ((await be.command({ op: 'queryEntity', projectId: be.projectId, args: { entityId } })) as unknown as { parentChain: string[] }).parentChain[0];

  // Shift+click selects the whole range.
  await named('g0').click();
  await named(`g${N - 1}`).click({ modifiers: ['Shift'] });
  await expect(page.locator('.tl-hierarchy__list li.tl-row.is-selected')).toHaveCount(N);
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+c');
  await expect(page.locator('.tl-notice, [role="status"]').filter({ hasText: `Copied ${N} objects` }).first()).toBeVisible();

  // Drag the selection into Target: one moveEntities; one undo puts every one back.
  const revBefore = (await query('queryProject')).revision as number;
  const box = (await named('Target').boundingBox())!;
  await named('g0').dragTo(named('Target'), { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await expect.poll(() => parentOf(last)).toBe(targetId);
  expect(await parentOf(first)).toBe(targetId);
  expect((await query('queryProject')).revision).toBe(revBefore + 1);
  await page.locator('canvas.tl-viewport').hover();
  await page.keyboard.press('Control+z');
  await expect.poll(() => parentOf(last)).toBe(manyId);
  expect(await parentOf(first)).toBe(manyId);

  // Paste: every copy in one pasteEntities; one undo takes them all away.
  const before = await countIn(sceneId);
  const pasteRev = (await query('queryProject')).revision as number;
  await page.keyboard.press('Control+v');
  await expect.poll(() => countIn(sceneId)).toBe(before + N);
  expect((await query('queryProject')).revision).toBe(pasteRev + 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => countIn(sceneId)).toBe(before);
}
