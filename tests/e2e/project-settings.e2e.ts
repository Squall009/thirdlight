/**
 * The Project Settings window in a real browser against the real backend:
 * File → Project Settings… opens one full window over the editor; each
 * sub-tab (Gameplay, Input, Tags, Collision layers, Quality, Saves, Game
 * modes, Game shell, Scripts) shows its panel and an edit in it reaches the
 * backend (read back over HTTP); the search filters the sub-tabs; Esc and ×
 * return to the editor; the bottom dock no longer lists the settings; opening
 * a script from Scripts brings the editor window to the front.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { type E2EBackend, startBackend } from './backend';
import { closeProjectSettings, editorWindow, menu, openProjectSettings, settingsTab, settingsWindow, windowTab, type ProjectSettingsSection } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

const gameConfig = async (): Promise<Record<string, unknown>> => be.command({ op: 'queryGameConfig', projectId: be.projectId });
/** The project's content file as the backend wrote it. */
const content = (): Record<string, unknown> => (JSON.parse(readFileSync(join(be.projectDir, 'content.json'), 'utf8')) as { content: Record<string, unknown> }).content;
const settings = async (): Promise<Record<string, unknown>> => (content()['settings'] ?? {}) as Record<string, unknown>;

/** The sub-tabs the window lists, in order. */
async function listed(page: Page): Promise<string[]> {
  return settingsWindow(page).getByRole('tablist', { name: 'project settings sections' }).getByRole('tab').allTextContents();
}

test('Project Settings: every sub-tab shows its panel and its edits round-trip through the backend; the search filters the sub-tabs', async ({ page }) => {
  test.setTimeout(180_000);
  be = await startBackend('project-settings-e2e');
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');

  // The settings are not dock tabs any more; the Window menu does not list them either.
  for (const gone of ['Gameplay', 'Input', 'Tags', 'Saves', 'Game modes', 'Game shell', 'Behaviors', 'Media']) await expect(windowTab(page, gone)).toHaveCount(0);

  // File → Project Settings… opens one full window over the editor, its sub-tabs in order.
  await menu(page, 'File', 'Project Settings…');
  const win = settingsWindow(page);
  await expect(win).toBeVisible();
  expect(await listed(page)).toEqual(['Gameplay', 'Input', 'Tags', 'Collision layers', 'Quality', 'Audio', 'Saves', 'Game modes', 'Game shell', 'Scripts']);
  // It covers the work area (the Hierarchy and the Scene view stay under it, taking no input).
  const area = (await page.locator('.tl-app__workarea').boundingBox())!;
  const box = (await win.boundingBox())!;
  expect([Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]).toEqual([Math.round(area.x), Math.round(area.y), Math.round(area.width), Math.round(area.height)]);
  await expect(page.locator('.tl-app__body')).toHaveAttribute('inert', '');
  const panel = (section: ProjectSettingsSection) => win.getByRole('tabpanel', { name: section, exact: true });

  // Gameplay: the settings without the Rendering group; a number round-trips.
  await openProjectSettings(page, 'Gameplay');
  const gameplay = panel('Gameplay').getByLabel('gameplay settings');
  await expect(gameplay.getByLabel('settings texture_budget_mb', { exact: true })).toHaveCount(0);
  const run = gameplay.getByLabel('settings run_speed', { exact: true });
  await run.fill('5');
  await run.press('Enter');
  await expect.poll(async () => (await settings())['run_speed']).toBe(5);

  // Input: the cursor mode of the gameplay map.
  await openProjectSettings(page, 'Input');
  await panel('Input').getByLabel('cursor while gameplay', { exact: true }).selectOption('locked');
  await expect.poll(async () => JSON.stringify(((await gameConfig())['input'] as { cursor?: unknown } | null)?.cursor)).toBe(JSON.stringify({ gameplay: 'locked' }));

  // Tags: add one.
  await openProjectSettings(page, 'Tags');
  const tags = panel('Tags').getByLabel('project tags');
  await tags.getByLabel('new tag name').fill('enemy');
  await tags.getByRole('button', { name: 'add tag' }).click();
  await expect(tags.locator('[data-tag="enemy"]')).toHaveCount(1);
  await expect.poll(async () => JSON.stringify((await gameConfig())['tags'])).toBe(JSON.stringify([{ bit: 0, name: 'enemy' }]));

  // Collision layers: its own sub-tab now.
  await openProjectSettings(page, 'Collision layers');
  await expect(panel('Collision layers').getByLabel('project tags')).toHaveCount(0);
  const layers = panel('Collision layers').getByLabel('collision layers', { exact: true });
  await layers.getByLabel('new collision layer name', { exact: true }).fill('units');
  await layers.getByRole('button', { name: 'add layer' }).click();
  await expect.poll(async () => JSON.stringify((await gameConfig())['collisionLayers'])).toBe('["units"]');

  // Quality: the project's quality level (the environment's, no scene) and the Rendering group with the texture budget.
  await openProjectSettings(page, 'Quality');
  const level = panel('Quality').getByLabel('environment quality', { exact: true });
  await expect(level).toHaveValue('high');
  await level.selectOption('low');
  await expect.poll(() => (content()['environment'] as { quality?: string } | undefined)?.quality).toBe('low');
  const quality = panel('Quality').getByLabel('quality settings');
  await expect(quality.getByLabel('settings run_speed', { exact: true })).toHaveCount(0);
  await expect(quality.getByLabel('settings render_backend', { exact: true })).toBeVisible();
  const budget = quality.getByLabel('settings texture_budget_mb', { exact: true });
  await budget.fill('96');
  await budget.press('Enter');
  await expect.poll(async () => (await settings())['texture_budget_mb']).toBe(96);

  // Saves: add the schema.
  await openProjectSettings(page, 'Saves');
  await panel('Saves').getByLabel('project saves').getByRole('button', { name: 'add save schema' }).click();
  await expect.poll(async () => (await gameConfig())['saveSchema']).toEqual({ version: 1, slots: 3 });

  // Game modes: add a behavior group.
  await openProjectSettings(page, 'Game modes');
  const groups = panel('Game modes').getByLabel('behavior groups', { exact: true });
  await groups.getByLabel('new behavior group name', { exact: true }).fill('enemies');
  await groups.getByLabel('new behavior group name', { exact: true }).press('Enter');
  await expect.poll(async () => (await gameConfig())['behaviorGroups']).toEqual(['enemies']);

  // Game shell: add the shell.
  await openProjectSettings(page, 'Game shell');
  await panel('Game shell').getByLabel('game shell', { exact: true }).getByRole('button', { name: 'add game shell' }).click();
  await expect.poll(async () => (await gameConfig())['shell']).toEqual({});

  // The search keeps the sub-tabs whose names or settings match; the one in front follows.
  const search = win.getByLabel('Search project settings', { exact: true });
  await search.fill('texture budget');
  expect(await listed(page)).toEqual(['Quality']);
  await expect(settingsTab(page, 'Quality')).toHaveAttribute('aria-selected', 'true');
  await expect(win.getByRole('tabpanel', { name: 'Quality', exact: true })).toBeVisible();
  await search.fill('collision');
  expect(await listed(page)).toEqual(['Collision layers']);
  await search.fill('run speed');
  expect(await listed(page)).toEqual(['Gameplay']);
  await search.fill('zzz-nothing');
  expect(await listed(page)).toEqual([]);
  await expect(win.getByText('No settings match')).toBeVisible();
  await search.fill('');
  expect((await listed(page)).length).toBe(10);
  await page.screenshot({ path: 'test-results/project-settings.png' });

  // Esc (outside a field) closes it; the editor takes input again; it reopens at the sub-tab last shown.
  await win.locator('.tl-settings-window__title').click();
  await page.keyboard.press('Escape');
  await expect(win).toHaveCount(0);
  await expect(page.locator('.tl-app__body')).not.toHaveAttribute('inert', '');
  await menu(page, 'File', 'Project Settings…');
  await expect(settingsTab(page, 'Game shell')).toHaveAttribute('aria-selected', 'true');

  // Scripts: the behaviors with the trust notice; a new visual script opens in the editor window, in front.
  await openProjectSettings(page, 'Scripts');
  await expect(panel('Scripts').getByRole('note', { name: 'trust notice' })).toBeVisible();
  await panel('Scripts').getByLabel('New visual script name').fill('Mover');
  await panel('Scripts').getByRole('button', { name: '+ Visual script' }).click();
  await expect.poll(async () => JSON.stringify(await be.command({ op: 'queryBehaviors', projectId: be.projectId, args: {} }))).toContain('Mover');
  await expect(win).toHaveCount(0);
  await expect(editorWindow(page)).toBeVisible();

  // Over the editor window it closes back to it (×).
  await menu(page, 'File', 'Project Settings…');
  await expect(win).toBeVisible();
  await closeProjectSettings(page);
  await expect(editorWindow(page)).toBeVisible();
});
