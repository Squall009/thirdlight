/**
 * Screenshots of every editor for the owner to judge the look by eye: the
 * default view, the project window listing every kind, Project Settings, and
 * each item editor in the editor window, new (its empty state) and with
 * content. The same views at two commits make a before / after pair.
 *
 * Not a check: it runs only when TL_LOOK_DIR names the folder the PNGs go to.
 * The project is the neutral Starter template with items made here.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { skinnedGlb } from './skinned-glb';
import { chooseItem, closeEditor, createItem, editorWindow, menu, openEditor, openProjectSettings, projectWindow, settingsWindow, closeProjectSettings, type EditorKind } from './ui';

const OUT = process.env['TL_LOOK_DIR'];

let be: E2EBackend | undefined;
test.afterEach(async () => {
  await be?.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const revision = Number((await be!.command({ op: 'queryProject', projectId: be!.projectId, args: {} }))['revision']);
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-editor-look' }, args });
  expect(res['ok'], `${op}: ${JSON.stringify(res).slice(0, 300)}`).toBe(true);
}

async function shot(page: Page, name: string): Promise<void> {
  // Let previews and thumbnails settle (a look, not a measurement).
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT!, `${name}.png`) });
}

/** Show a folder of the game folder in the project window (made when it is not there). */
async function showFolder(page: Page, folder: string): Promise<void> {
  const panel = await projectWindow(page);
  await panel.getByLabel('search the project').fill('');
  const node = panel.getByRole('button', { name: `folder ${folder}`, exact: true });
  if ((await node.count()) === 0) {
    await panel.getByRole('button', { name: 'folder (game folder)', exact: true }).click();
    await panel.getByRole('button', { name: 'new folder', exact: true }).click();
    await panel.getByLabel('folder name', { exact: true }).fill(folder);
    await panel.getByLabel('folder name', { exact: true }).press('Enter');
  }
  await node.click();
  await expect(panel.locator('.tl-project')).toHaveAttribute('data-folder', folder);
}

test('screenshots of every editor for the owner', async ({ page }) => {
  test.skip(OUT === undefined, 'set TL_LOOK_DIR to take the look screenshots');
  test.setTimeout(420_000);
  mkdirSync(OUT!, { recursive: true });
  await page.setViewportSize({ width: 1600, height: 960 });
  be = await startBackend('editor-look-0001', 'starter');
  // A code script without source yet, made over HTTP.
  await cmd('publishBehavior', { behaviorId: 'drift', displayName: 'Drift', mode: 'declaration-create', declaration: { properties: [] } });
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await shot(page, '01-default-view');

  // The skinned test model (an animator controller needs its clips).
  const dir = mkdtempSync(join(tmpdir(), 'tl-look-'));
  const file = join(dir, 'column.glb');
  writeFileSync(file, skinnedGlb());
  let panel = await projectWindow(page);
  await panel.locator('.tl-assets__file').first().setInputFiles(file);
  const publish = panel.getByRole('button', { name: 'publish' });
  await expect(publish).toBeEnabled({ timeout: 15_000 });
  await publish.click();
  await chooseItem(page, 'model', 'column');
  await showFolder(page, 'made');

  // One of every kind the Create menu makes; the ones with an editor open in it.
  const made: [string | readonly [string, string], string, EditorKind | null][] = [
    ['Material', 'Brick', null],
    [['Graph material', 'Empty (PBR output)'], 'Blank', 'Material'],
    [['Graph material', 'Water'], 'Pond', 'Material'],
    ['Animator controller', 'Poser', 'Animator'],
    [['Graph', 'Test graph'], 'Maths', 'Graph'],
    ['Effect', 'Sparks', 'Effect'],
    ['Dialogue', 'Greeting', 'Dialogue'],
    ['Timeline', 'Intro', 'Timeline'],
    ['Script library', 'Scoring', 'Library'],
    ['UI document', 'Hud', 'UI'],
    ['UI theme', 'Neutral', 'UI theme'],
  ];
  for (const [what, name] of made) await createItem(page, what, name);
  await openProjectSettings(page, 'Scripts');
  await settingsWindow(page).getByLabel('New visual script name').fill('Lamp');
  await settingsWindow(page).getByRole('button', { name: '+ Visual script' }).click();
  await expect(editorWindow(page)).toBeVisible();
  await closeProjectSettings(page);
  await closeEditor(page);

  await showFolder(page, 'made');
  await shot(page, '02-project-window');
  await chooseItem(page, 'material', 'Brick');
  await shot(page, '03-inspector-shader-material');

  await menu(page, 'File', 'Project Settings…');
  await expect(settingsWindow(page)).toBeVisible();
  await shot(page, '04-project-settings');
  await closeProjectSettings(page);

  const editors: [EditorKind, string, string][] = [
    ['Material', 'Blank', '10-material-empty'],
    ['Material', 'Pond', '11-material-water'],
    ['Graph', 'Maths', '12-graph'],
    ['Graph', 'Lamp', '13-visual-script'],
    ['Animator', 'Poser', '14-animator'],
    ['Effect', 'Sparks', '15-effect'],
    ['Dialogue', 'Greeting', '16-dialogue'],
    ['Timeline', 'Intro', '17-timeline'],
    ['Script', 'Drift', '18-script'],
    ['Library', 'Scoring', '19-library'],
    ['UI', 'Hud', '20-ui-document'],
    ['UI theme', 'Neutral', '21-ui-theme'],
  ];
  for (const [kind, name, file] of editors) {
    await openEditor(page, kind, name);
    await shot(page, file);
  }
  await closeEditor(page);
});
