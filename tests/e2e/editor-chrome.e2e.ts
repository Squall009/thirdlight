/**
 * Every item editor is built the same way, against the real backend and
 * Chromium:
 *
 * - a header with the item's picture (from the icon registry, loaded), its
 *   name, its kind and the folder its file is in; the name is renamed there
 *   (one command, read back over HTTP);
 * - a toolbar whose actions carry their pictures (loaded);
 * - while the item has nothing in it, an empty state naming what is missing
 *   with its first action, which works (the item is no longer empty);
 * - graph nodes carry their category's family, and the canvas paints a node's
 *   header in that family's colour from the stylesheet;
 * - the project window shows each kind's picture.
 */
import { randomBytes } from 'node:crypto';

import { expect, test, type Locator, type Page } from './pw';

import { startBackend, type E2EBackend } from './backend';
import { createItem, editorPane, editorWindow, openEditor, openProjectSettings, projectWindow, settingsWindow, closeProjectSettings, type EditorKind } from './ui';

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

async function cmd(op: string, args: Record<string, unknown>): Promise<void> {
  const revision = Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} }))['revision']);
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: revision, requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-editor-chrome' }, args });
  expect(res['ok'], `${op}: ${JSON.stringify(res).slice(0, 300)}`).toBe(true);
}
async function record(kind: string, id: string): Promise<Record<string, unknown> | undefined> {
  const r = await be.command({ op: 'queryIndex', projectId: be.projectId, args: { kind, ids: [id], records: true, refs: false } });
  return ((r['entries'] as { record: Record<string, unknown> }[] | undefined) ?? [])[0]?.record;
}

/** Every picture in a locator has loaded (a missing file has no natural width). */
async function picturesLoaded(scope: Locator): Promise<number> {
  return scope.locator('img').evaluateAll((imgs) => {
    const bad = imgs.filter((i) => !(i as HTMLImageElement).complete || (i as HTMLImageElement).naturalWidth === 0);
    if (bad.length > 0) throw new Error(`not loaded: ${bad.map((i) => (i as HTMLImageElement).getAttribute('src')).join(', ')}`);
    return imgs.length;
  });
}

async function showFolder(page: Page, folder: string): Promise<void> {
  const panel = await projectWindow(page);
  await panel.getByLabel('search the project').fill('');
  await panel.getByRole('button', { name: 'folder (game folder)', exact: true }).click();
  await panel.getByRole('button', { name: 'new folder', exact: true }).click();
  await panel.getByLabel('folder name', { exact: true }).fill(folder);
  await panel.getByLabel('folder name', { exact: true }).press('Enter');
  await panel.getByRole('button', { name: `folder ${folder}`, exact: true }).click();
  await expect(panel.locator('.tl-project')).toHaveAttribute('data-folder', folder);
}

/** The header, toolbar and pictures of the editor in front. */
async function expectChrome(page: Page, kind: EditorKind, name: string, itemKind: string, folder: string): Promise<Locator> {
  const pane = editorPane(page, kind, name);
  const header = pane.locator('header.tl-editor-header');
  // One header: the item in front's (switching items replaces it).
  await expect(editorWindow(page).locator('header.tl-editor-header')).toHaveCount(1);
  await expect(header).toHaveAttribute('data-item-kind', itemKind);
  await expect(header.locator('img.tl-editor-header__icon')).toHaveAttribute('src', new RegExp(`/icons/kinds/${itemKind === 'behavior' && kind === 'Graph' ? 'visual-script' : itemKind}\\.webp$`));
  // A field where the kind is renamed here, else the name as text.
  await expect.poll(() => header.locator('.tl-editor-header__name').evaluate((el) => (el instanceof HTMLInputElement ? el.value : el.textContent))).toBe(name);
  await expect(header.locator('.tl-editor-header__kind')).toHaveText(kind);
  await expect(header.locator('.tl-editor-header__folder')).toHaveText(folder);
  expect(await picturesLoaded(header)).toBe(1);
  const toolbars = pane.getByRole('toolbar');
  await expect(toolbars.first()).toBeVisible();
  // Each action shows its picture, and every picture loaded.
  const actions = pane.locator('.tl-tool-button');
  await expect(actions.first()).toBeVisible();
  const withPicture = await actions.evaluateAll((bs) => bs.filter((b) => b.querySelector('img.tl-tool-button__icon') !== null).length);
  expect(withPicture).toBe(await actions.count());
  await picturesLoaded(pane.locator('.tl-tool-button'));
  return pane;
}

test('every item editor has a header, a toolbar with pictures, and an empty state whose first action works', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('editor-chrome-0001', 'starter');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await showFolder(page, 'kit');

  // Graph: a new one is empty; "Add a node" opens the catalogue and a node lands in the graph.
  await createItem(page, ['Graph', 'Test graph'], 'Sums');
  let pane = await expectChrome(page, 'Graph', 'Sums', 'graph', 'kit');
  let empty = pane.getByRole('region', { name: 'empty: No nodes yet' });
  await expect(empty).toBeVisible();
  expect(await picturesLoaded(empty)).toBeGreaterThanOrEqual(2);
  await empty.getByRole('button', { name: 'Add a node' }).click();
  await page.getByRole('dialog', { name: 'Add node' }).getByRole('option', { name: 'Add', exact: true }).click();
  await expect.poll(async () => ((await record('graph', 'sums'))?.['graph'] as { nodes: unknown[] }).nodes.length).toBe(1);
  await expect(empty).toHaveCount(0);
  // The node carries its category's family, and the canvas paints its header in the stylesheet's colour for it.
  const node = pane.locator('.tl-graph__node').first();
  await expect(node).toHaveAttribute('data-node-family', 'math');
  const painted = await pane.locator('canvas.tl-graph__canvas').evaluate((c, el) => {
    const canvas = c as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    const r = (el as HTMLElement).getBoundingClientRect();
    // Above the title text, in the header's middle (the canvas is drawn at the device pixel ratio).
    const sx = canvas.width / box.width;
    const px = canvas.getContext('2d')!.getImageData(Math.round((r.left - box.left + r.width / 2) * sx), Math.round((r.top - box.top + 5) * sx), 1, 1).data;
    const token = getComputedStyle(document.documentElement).getPropertyValue('--node-math').trim();
    return { px: [px[0], px[1], px[2]], token };
  }, await node.elementHandle());
  const hex = painted.token.replace('#', '');
  const want = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  for (let i = 0; i < 3; i++) expect(Math.abs(painted.px[i]! - want[i]!), `channel ${i} of ${JSON.stringify(painted)}`).toBeLessThanOrEqual(3);

  // The header renames the item: one command, read back.
  const nameField = pane.locator('.tl-editor-header__name');
  await nameField.fill('Totals');
  await nameField.press('Enter');
  await expect.poll(async () => (await record('graph', 'sums'))?.['name']).toBe('Totals');
  await expect(page.getByRole('tab', { name: 'Graph: Totals', exact: true })).toBeVisible();

  // Effect: no systems yet; "Add a system" adds one.
  await createItem(page, 'Effect', 'Puff');
  pane = await expectChrome(page, 'Effect', 'Puff', 'effect', 'kit');
  empty = pane.getByRole('region', { name: 'empty: No particle systems yet' });
  await expect(empty).toBeVisible();
  await empty.getByRole('button', { name: 'Add a system' }).click();
  await expect.poll(async () => ((await record('effect', 'puff'))?.['systems'] as unknown[]).length).toBe(1);
  await expect(empty).toHaveCount(0);
  // Its system graph's contexts and blocks are styled by family too.
  await expect(pane.locator('.tl-graph__node[data-node-family="event"]').first()).toBeVisible();

  // Back to the graph's tab: its header replaces the effect's.
  await page.getByRole('tab', { name: 'Graph: Totals', exact: true }).click();
  await expectChrome(page, 'Graph', 'Totals', 'graph', 'kit');

  // Timeline: no tracks yet; its first actions add a slot and a track.
  await createItem(page, 'Timeline', 'Opening');
  pane = await expectChrome(page, 'Timeline', 'Opening', 'timeline', 'kit');
  empty = pane.getByRole('region', { name: 'empty: No tracks yet' });
  await expect(empty).toBeVisible();
  await empty.getByRole('button', { name: 'Add a slot' }).click();
  await expect.poll(async () => ((await record('timeline', 'opening'))?.['slots'] as unknown[] | undefined)?.length ?? 0).toBe(1);
  await pane.getByRole('combobox', { name: 'New track type' }).selectOption({ label: 'Fade' });
  await empty.getByRole('button', { name: /^Add a fade track$/i }).click();
  await expect.poll(async () => ((await record('timeline', 'opening'))?.['tracks'] as unknown[]).length).toBe(1);
  await expect(empty).toHaveCount(0);
  // The timeline fills its window (no see-through gap above it).
  const doc = await pane.locator('.tl-timeline-doc').boundingBox();
  const header = await pane.locator('header.tl-editor-header').boundingBox();
  expect(doc!.y - (header!.y + header!.height)).toBeLessThan(24);

  // UI document: only its root panel; "Text" adds a text widget into it.
  await createItem(page, 'UI document', 'Overlay');
  pane = await expectChrome(page, 'UI', 'Overlay', 'ui', 'kit');
  empty = pane.getByRole('region', { name: 'empty: No widgets yet' });
  await expect(empty).toBeVisible();
  await empty.getByRole('button', { name: 'add a text widget' }).click();
  await expect.poll(async () => ((await record('ui', 'overlay'))?.['root'] as { children?: unknown[] }).children?.length ?? 0).toBe(1);
  await expect(empty).toHaveCount(0);

  // UI theme: one without styles (a new one starts with a label style) says so; "Add a style" adds one.
  await cmd('setUiTheme', { theme: { uiThemeId: 'plain', name: 'Plain', styles: {} } });
  await openEditor(page, 'UI theme', 'Plain');
  pane = await expectChrome(page, 'UI theme', 'Plain', 'uitheme', 'assets/ui');
  empty = pane.getByRole('region', { name: 'empty: No styles yet' });
  await expect(empty).toBeVisible();
  await empty.getByRole('button', { name: 'Add a style' }).click();
  await expect.poll(async () => Object.keys(((await record('uitheme', 'plain'))?.['styles'] as Record<string, unknown>) ?? {}).length).toBe(1);
  await expect(empty).toHaveCount(0);

  // Dialogue and a blank graph material: only their required node; the empty state names it.
  await createItem(page, 'Dialogue', 'Hello');
  pane = await expectChrome(page, 'Dialogue', 'Hello', 'dialogue', 'kit');
  await expect(pane.getByRole('region', { name: 'empty: No nodes yet' })).toBeVisible();
  await createItem(page, ['Graph material', 'Empty (PBR output)'], 'Bare');
  pane = await expectChrome(page, 'Material', 'Bare', 'material', 'kit');
  await expect(pane.getByRole('region', { name: 'empty: No nodes yet' })).toContainText('PBR output');

  // Animator, library, code script and visual script: header and toolbar (never empty: they start with content).
  await createItem(page, 'Script library', 'Helpers');
  await expectChrome(page, 'Library', 'Helpers', 'library', 'kit');
  await cmd('publishBehavior', { behaviorId: 'drift', displayName: 'Drift', mode: 'declaration-create', declaration: { properties: [] } });
  await openEditor(page, 'Script', 'Drift');
  pane = await expectChrome(page, 'Script', 'Drift', 'behavior', 'assets/behaviors');
  // A behavior is renamed elsewhere (its declaration): the header shows its name without a field.
  await expect(pane.locator('.tl-editor-header__name')).toHaveClass(/is-static/);
  await openProjectSettings(page, 'Scripts');
  await settingsWindow(page).getByLabel('New visual script name').fill('Blinker');
  await settingsWindow(page).getByRole('button', { name: '+ Visual script' }).click();
  await expect(editorWindow(page)).toBeVisible();
  await closeProjectSettings(page);
  await expect(editorPane(page, 'Graph', 'Blinker').locator('header.tl-editor-header img')).toHaveAttribute('src', /\/icons\/kinds\/visual-script\.webp$/);
  await expect(editorPane(page, 'Graph', 'Blinker').getByRole('toolbar', { name: 'visual script toolbar' })).toBeVisible();

  // The project window shows each kind's picture (every one loaded).
  const panel = await projectWindow(page);
  await panel.getByRole('button', { name: 'folder kit', exact: true }).click();
  const tiles = panel.locator('li.tl-project__item');
  await expect(tiles).toHaveCount(7);
  for (const kind of ['graph', 'effect', 'timeline', 'ui', 'dialogue', 'material', 'library']) {
    await expect(panel.locator(`li.tl-project__item[data-item-kind="${kind}"] img`)).toHaveAttribute('src', new RegExp(`/icons/kinds/${kind}\\.webp$`));
  }
  expect(await picturesLoaded(panel.locator('.tl-project__list'))).toBeGreaterThanOrEqual(7);
  expect(errors).toEqual([]);
});
