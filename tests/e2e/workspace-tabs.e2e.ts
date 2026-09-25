/**
 * Phase 16.0: centre workspace tabs. Double-clicking an animator controller
 * or a behavior opens it as a document tab next to Scene and Game; the tabs
 * are real editors (edits reach the backend), can be switched, reordered by
 * drag, closed (not Scene or Game), cycled with Ctrl+Tab, survive a reload,
 * and the centre area can be maximized (docks hidden).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { skinnedGlb } from './skinned-glb';

let be: E2EBackend;
let seq = 0;
test.beforeEach(async () => {
  be = await startBackend('workspace-tabs-0001');
});
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = await be.command({ op: 'queryProject', projectId: be.projectId, args: {} });
  seq += 1;
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: q.revision, requestId: `req-${(0x16a000 + seq).toString(16).padStart(32, '0')}`, origin: { kind: 'mcp', clientId: 'e2e-workspace' }, args });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}
const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const centreTabs = (page: Page): Promise<string[]> => page.locator('.tl-tabs--center [role="tab"]').allTextContents();

async function open(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
}

test('document tabs open, switch, reorder, close, survive a reload; maximize; Ctrl+Tab', async ({ page }) => {
  test.setTimeout(120_000);
  // Neutral fixtures: two declared behaviors and (below) a one-state animator controller.
  await cmd('publishBehavior', { behaviorId: 'mover', displayName: 'Mover', mode: 'declaration-create', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 2 }] } });
  await cmd('publishBehavior', { behaviorId: 'door', displayName: 'Door', mode: 'declaration-create', declaration: { properties: [{ key: 'open', label: 'Open', type: 'boolean', default: false }] } });
  await open(page);
  // A skinned test model (clips idle/bend) for the controller's clip.
  const dir = mkdtempSync(join(tmpdir(), 'tl-wtabs-'));
  writeFileSync(join(dir, 'column.glb'), skinnedGlb());
  await page.locator('.tl-assets__file').first().setInputFiles(join(dir, 'column.glb'));
  rmSync(dir, { recursive: true, force: true });
  const publish = page.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  const listAssets = async (): Promise<{ assetId: string }[]> => (await query('queryAssets', { limit: 10, offset: 0 }))['assets'] as { assetId: string }[];
  await expect.poll(async () => (await listAssets()).length).toBe(1);
  const asset = (await listAssets())[0]!.assetId;
  await cmd('setAnimator', {
    controller: {
      controllerId: 'animator-01',
      name: 'Walker',
      parameters: [{ name: 'speed', type: 'float', default: 0 }],
      states: [{ id: 'state-01', name: 'Idle', motion: { kind: 'clip', clip: { assetId: asset, clip: 'idle', duration: 1 } }, speed: 1, loop: true, position: [180, 40] }],
      transitions: [],
      entry: 'state-01',
      events: [],
    },
  });
  expect(await centreTabs(page)).toEqual(['Scene', 'Game']);

  // Double-click a behavior tile → its script tab, in front, a real editor.
  await page.getByRole('tab', { name: 'Behaviors', exact: true }).click();
  await page.locator('.tl-behaviors__list .tl-tile', { hasText: 'Mover' }).dblclick();
  await expect(tab(page, 'Script: Mover')).toHaveAttribute('aria-selected', 'true');
  const scriptView = page.getByRole('tabpanel', { name: 'Script: Mover' });
  await expect(scriptView.getByLabel('declaration editor')).toHaveAttribute('data-behavior', 'mover');
  await expect(page.locator('canvas.tl-viewport')).toBeVisible(); // laid out underneath
  await scriptView.getByLabel('property 1 default', { exact: true }).fill('5');
  await scriptView.getByRole('button', { name: 'Save declaration' }).click();
  await expect
    .poll(async () => ((await query('queryBehaviors', { includeDeclaration: true, limit: 50, offset: 0 }))['behaviors'] as { behaviorId: string; declaration?: { properties: { default: unknown }[] } }[]).find((b) => b.behaviorId === 'mover')?.declaration?.properties[0]?.default)
    .toBe(5);

  // Double-click a controller in the Animator's list → its tab with the graph.
  await page.getByRole('tab', { name: 'Animator', exact: true }).click();
  await page.getByLabel('animator controllers').getByRole('button', { name: 'Walker' }).dblclick();
  await expect(tab(page, 'Animator: Walker')).toHaveAttribute('aria-selected', 'true');
  const animView = page.getByRole('tabpanel', { name: 'Animator: Walker' });
  await expect(animView.getByLabel('animator graph').getByRole('group', { name: 'State Idle node state-01' })).toBeVisible();
  // The document view has no controller picker (it edits this one controller) and edits reach the backend.
  await expect(animView.getByLabel('animator controller', { exact: true })).toHaveCount(0);
  await animView.getByLabel('controller name').fill('Walker B');
  await animView.getByLabel('controller name').blur();
  await expect(tab(page, 'Animator: Walker B')).toBeVisible();
  await expect.poll(async () => ((await query('queryGameConfig'))['animators'] as { controllerId: string; name: string }[] | undefined)?.find((c) => c.controllerId === 'animator-01')?.name).toBe('Walker B');

  // Opening an open document focuses its tab (no second tab).
  await page.getByRole('tab', { name: 'Behaviors', exact: true }).click();
  await page.locator('.tl-behaviors__list .tl-tile', { hasText: 'Mover' }).dblclick();
  await expect(tab(page, 'Script: Mover')).toHaveAttribute('aria-selected', 'true');
  expect(await centreTabs(page)).toEqual(['Scene', 'Game', 'Script: Mover', 'Animator: Walker B']);

  // Switch: Scene hides the document; the document tab brings it back.
  await tab(page, 'Scene').click();
  await expect(page.getByRole('tabpanel')).toHaveCount(0);
  await tab(page, 'Animator: Walker B').click();
  await expect(animView).toBeVisible();

  // Reorder by drag: the animator tab onto the script tab's place.
  await tab(page, 'Animator: Walker B').dragTo(tab(page, 'Script: Mover'));
  await expect.poll(() => centreTabs(page)).toEqual(['Scene', 'Game', 'Animator: Walker B', 'Script: Mover']);

  // A third tab, closed with its close button; Scene and Game have none.
  await page.locator('.tl-behaviors__list .tl-tile', { hasText: 'Door' }).dblclick();
  await expect(tab(page, 'Script: Door')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: /^Close (Scene|Game)$/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Script: Door', exact: true }).click();
  await expect(tab(page, 'Script: Door')).toHaveCount(0);
  // The closed active tab hands over to its left neighbour.
  await expect(tab(page, 'Script: Mover')).toHaveAttribute('aria-selected', 'true');

  // Ctrl+Tab cycles (wrapping), Ctrl+Shift+Tab goes back.
  await page.keyboard.press('Control+Tab');
  await expect(tab(page, 'Scene')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Tab');
  await expect(tab(page, 'Game')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Tab');
  await expect(tab(page, 'Animator: Walker B')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Shift+Tab');
  await expect(tab(page, 'Game')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Tab');
  await page.keyboard.press('Control+Tab');
  await expect(tab(page, 'Script: Mover')).toHaveAttribute('aria-selected', 'true');

  // A reload keeps the tabs, their order and the active one (per project, layout storage).
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await expect.poll(() => centreTabs(page)).toEqual(['Scene', 'Game', 'Animator: Walker B', 'Script: Mover']);
  await expect(tab(page, 'Script: Mover')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Script: Mover' }).getByLabel('declaration editor')).toHaveAttribute('data-behavior', 'mover');

  // Maximize hides the docks and the centre grows; restoring brings them back.
  const stageBefore = (await page.locator('.tl-app__stage').boundingBox())!;
  const maximize = page.getByRole('button', { name: 'Maximize the centre area' });
  await maximize.click();
  await expect(maximize).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.tl-dock--left')).toBeHidden();
  await expect(page.locator('.tl-dock--right')).toBeHidden();
  await expect(page.locator('.tl-dock--bottom')).toBeHidden();
  await expect.poll(async () => (await page.locator('.tl-app__stage').boundingBox())!.width).toBeGreaterThan(stageBefore.width + 300);
  await expect.poll(async () => (await page.locator('.tl-app__stage').boundingBox())!.height).toBeGreaterThan(stageBefore.height + 100);
  await maximize.click();
  await expect(maximize).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.tl-dock--left')).toBeVisible();
  await expect(page.locator('.tl-dock--bottom')).toBeVisible();

  // Middle-click closes a document tab; closing every document leaves Scene and Game.
  await tab(page, 'Animator: Walker B').click({ button: 'middle' });
  await expect(tab(page, 'Animator: Walker B')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close Script: Mover', exact: true }).click();
  expect(await centreTabs(page)).toEqual(['Scene', 'Game']);
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  expect(await centreTabs(page)).toEqual(['Scene', 'Game']);
  await expect(tab(page, 'Scene')).toHaveAttribute('aria-selected', 'true');
});
