/**
 * The project window, against the real backend and Chromium:
 *
 * - a new folder, an asset dragged into it (its file and sidecar move), the
 *   folder renamed, a label, a search with `t:` and `l:`; after a reload the
 *   folder and the asset are there, and everything is so on disk;
 * - several items cut and pasted into another folder in one command; one
 *   undo brings them all back;
 * - a double-click opens each kind's editor (material, timeline, UI
 *   document, dialogue, effect, animator, graph, script, library, scene,
 *   prefab); the kind menu writes the search's `t:`; grid and list;
 * - a move changes no built content: the export before and after holds the
 *   same files with the same bytes but for what names the build (its
 *   revision: the buildId, the capture, and the revision each scene document
 *   is stamped with); no file path is in it.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, STARTER, type E2EBackend } from './backend';
import { menu, projectWindow, expectWindowOpen } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
const OPUS = readFileSync(join(REPO, 'fixtures', 'music', 'chord-opus.ogg'));

let be: E2EBackend;
test.afterEach(async () => {
  await be.stop();
});

const revision = async (): Promise<number> => Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} }))['revision']);
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: await revision(), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-project-window' }, args });
  expect(res['ok'], `${op}: ${JSON.stringify(res).slice(0, 400)}`).toBe(true);
  return res;
}
/** Every file under a folder (relative paths). */
function walk(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(dir, rel === '' ? d.name : `${rel}/${d.name}`) : [rel === '' ? d.name : `${rel}/${d.name}`]));
}
const onDisk = (rel: string): boolean => existsSync(join(be.projectDir, ...rel.split('/')));
const sidecar = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(be.projectDir, ...`${rel}.tlasset`.split('/')), 'utf8')) as Record<string, unknown>;

const list = (page: Page) => page.locator('.tl-assets__list');
const assetTile = (page: Page, id: string) => list(page).locator(`li[data-asset-id="${id}"]`);
const itemTile = (page: Page, id: string) => list(page).locator(`li[data-item-id="${id}"]`);
const folderTile = (page: Page, path: string) => list(page).locator(`li[data-folder="${path}"]`);
const treeNode = (page: Page, path: string) => page.locator(`.tl-project__tree [data-tree-folder="${path}"]`);
const treeFolder = (page: Page, path: string) => page.getByRole('button', { name: path === '' ? 'folder (game folder)' : `folder ${path}`, exact: true });

/** Three voice lines in assets/voice, imported as a folder. */
async function voices(): Promise<void> {
  mkdirSync(join(be.projectDir, 'assets', 'voice'), { recursive: true });
  for (const n of ['line-a', 'line-b', 'line-c']) writeFileSync(join(be.projectDir, 'assets', 'voice', `${n}.ogg`), OPUS);
  await cmd('importAssets', { folder: 'assets/voice' });
}

async function openAssets(page: Page): Promise<void> {
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await projectWindow(page);
}

test('a new folder, an asset dragged into it, the folder renamed, t: and l: search, a reload — all on disk', async ({ page }) => {
  test.setTimeout(120_000);
  be = await startBackend('project-window-0001');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await voices();
  await cmd('setMaterial', { material: { materialId: 'stone', name: 'Stone', shader: 'standard', params: { roughness: 0.5 }, textures: {} } });
  await openAssets(page);
  // All assets: every asset file, wherever it is (the material is not an asset file).
  await expect(list(page).locator('li[data-asset-id]')).toHaveCount(3, { timeout: 10_000 });
  await expect(itemTile(page, 'stone')).toHaveCount(0);

  // The game folder: its folders; make one.
  await treeFolder(page, '').click();
  await expect(folderTile(page, 'assets')).toBeVisible();
  await page.getByRole('button', { name: 'new folder' }).click();
  await page.getByLabel('folder name').fill('props');
  await page.getByLabel('folder name').press('Enter');
  await expect(folderTile(page, 'props')).toBeVisible();
  expect(onDisk('props')).toBe(true);

  // Into assets/voice (double-clicks), then drag a line onto the new folder in the tree.
  await folderTile(page, 'assets').dblclick();
  await folderTile(page, 'assets/voice').dblclick();
  await expect(page.locator('.tl-project__crumb.is-current')).toHaveText('voice');
  await expect(assetTile(page, 'line-a')).toBeVisible();
  const before = await revision();
  await assetTile(page, 'line-a').dragTo(treeNode(page, 'props'));
  await expect.poll(() => onDisk('props/line-a.ogg')).toBe(true);
  expect(onDisk('props/line-a.ogg.tlasset')).toBe(true);
  expect(onDisk('assets/voice/line-a.ogg')).toBe(false);
  expect(onDisk('assets/voice/line-a.ogg.tlasset')).toBe(false);
  expect(await revision()).toBe(before + 1);
  await expect(assetTile(page, 'line-a')).toHaveCount(0);

  // Rename the folder (chosen in the tree, nothing chosen in it): its files go with it.
  await treeFolder(page, 'props').click();
  await expect(assetTile(page, 'line-a')).toBeVisible();
  await page.getByRole('button', { name: 'rename folder' }).click();
  await page.getByLabel('folder name').fill('sounds');
  await page.getByLabel('folder name').press('Enter');
  await expect(page.locator('.tl-project__crumb.is-current')).toHaveText('sounds');
  await expect.poll(() => onDisk('sounds/line-a.ogg')).toBe(true);
  expect(onDisk('props')).toBe(false);
  expect((sidecar('sounds/line-a.ogg')['record'] as { versions: { sourcePath?: string }[] }).versions.at(-1)?.sourcePath).toBe('sounds/line-a.ogg');

  // A label on line-b (its inspector), then Unity's search in All assets.
  await page.getByRole('button', { name: 'all assets' }).click();
  await assetTile(page, 'line-b').click();
  await page.getByLabel('add label').fill('voice');
  await page.getByLabel('add label').press('Enter');
  await expect.poll(() => sidecar('assets/voice/line-b.ogg')['labels']).toEqual(['voice']);
  const search = page.getByLabel('search the project');
  await search.fill('t:audio l:voice');
  await expect(list(page).locator('li[data-asset-id]')).toHaveCount(1);
  await expect(assetTile(page, 'line-b')).toBeVisible();
  await search.fill('t:audio');
  await expect(list(page).locator('li[data-asset-id]')).toHaveCount(3);
  await search.fill('t:material');
  await expect(itemTile(page, 'stone')).toBeVisible();
  await expect(list(page).locator('li[data-asset-id]')).toHaveCount(0);
  // In a folder the search covers it and its subfolders.
  await search.fill('');
  await treeFolder(page, 'sounds').click();
  await search.fill('line');
  await expect(list(page).locator('li[data-asset-id]')).toHaveCount(1);
  await search.fill('');

  // A reload: the folder and the moved asset are there.
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await projectWindow(page);
  await treeFolder(page, '').click();
  await expect(folderTile(page, 'sounds')).toBeVisible();
  await folderTile(page, 'sounds').dblclick();
  await expect(assetTile(page, 'line-a')).toBeVisible();
  const entry = (await be.command({ op: 'queryIndex', projectId: be.projectId, args: { kind: 'audio', id: 'line-a' } }))['entries'] as { path: string }[];
  expect(entry[0]?.path).toBe('sounds/line-a.ogg');
  expect(errors).toEqual([]);
});

test('several items cut and pasted in one command, one undo brings them back; the export is the same', async ({ page }) => {
  test.setTimeout(150_000);
  be = await startBackend('project-window-0002', 'starter');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await voices();
  await cmd('setMaterial', { material: { materialId: 'stone', name: 'Stone', shader: 'standard', params: { roughness: 0.5 }, textures: {} } });
  await cmd('createFolder', { folder: 'moved' });
  // The export before the move: every file of it, with what names the build (the revision each
  // scene document is stamped with, the catalog root and manifest fields that follow from it) masked.
  const exported = async (): Promise<Map<string, string>> => {
    const res = await be.admin(`projects/${be.projectId}/export`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const out = join(be.exportRoot, String(res.json.outputDir));
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    const rootDigest = (manifest['catalog'] as { digest: string }).digest;
    const files = new Map<string, string>();
    for (const rel of walk(out)) {
      // The export's own record of when and at which revision it was made.
      if (rel === 'meta.json') continue;
      let text = readFileSync(join(out, rel)).toString('latin1');
      if (rel === 'manifest.json') text = JSON.stringify({ ...manifest, revision: 0, snapshotId: '', capturedAt: '', buildId: '', sceneDigest: '', catalog: null });
      else if (rel === `content/sha256/${rootDigest}`) text = JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), scenes: ((JSON.parse(text) as { scenes: { digest: string }[] }).scenes).map((sc) => ({ ...sc, digest: '' })) });
      else if (rel.startsWith('scenes/') || rel === 'scene.json') text = text.replace(/"revision": \d+/, '"revision": 0');
      files.set(rel === `content/sha256/${rootDigest}` ? 'catalog-root' : rel, text);
    }
    return files;
  };
  const first = await exported();

  await openAssets(page);
  await treeFolder(page, '').click();
  await folderTile(page, 'assets').dblclick();
  await folderTile(page, 'assets/voice').dblclick();
  await assetTile(page, 'line-a').click();
  await assetTile(page, 'line-b').click({ modifiers: ['Control'] });
  await assetTile(page, 'line-c').click({ modifiers: ['Control'] });
  await expect(page.getByTestId('project-chosen')).toHaveText('3 chosen');
  await page.keyboard.press('Control+x');
  await expect(list(page).locator('li.is-cut')).toHaveCount(3);
  await treeFolder(page, 'moved').click();
  await expect(page.getByRole('button', { name: 'paste (3)' })).toBeEnabled();
  const before = await revision();
  await page.locator('.tl-project__main').focus();
  await page.keyboard.press('Control+v');
  await expect(list(page).locator('li[data-asset-id]')).toHaveCount(3);
  for (const n of ['line-a', 'line-b', 'line-c']) {
    expect(onDisk(`moved/${n}.ogg`), n).toBe(true);
    expect(onDisk(`moved/${n}.ogg.tlasset`), n).toBe(true);
    expect(onDisk(`assets/voice/${n}.ogg`), n).toBe(false);
  }
  expect(await revision()).toBe(before + 1);

  // Nothing built changed: the same files with the same bytes, but for the revision the build names.
  const second = await exported();
  expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
  for (const [rel, text] of first) expect(second.get(rel), rel).toBe(text);
  expect([...first.values()].some((t) => t.includes('assets/voice'))).toBe(false);

  // One undo: all three back.
  await menu(page, 'Edit', 'Undo');
  await expect.poll(() => onDisk('assets/voice/line-c.ogg')).toBe(true);
  for (const n of ['line-a', 'line-b', 'line-c']) {
    expect(onDisk(`assets/voice/${n}.ogg.tlasset`), n).toBe(true);
    expect(onDisk(`moved/${n}.ogg`), n).toBe(false);
  }
  await expect(list(page).locator('li[data-asset-id]')).toHaveCount(0);
  expect(await revision()).toBe(before + 2);
  expect(errors).toEqual([]);
});

test('a double-click opens each kind of item in its editor; the kind menu writes t:; grid and list', async ({ page }) => {
  test.setTimeout(150_000);
  be = await startBackend('project-window-0003', 'starter');
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const model = ((await be.command({ op: 'queryIndex', projectId: be.projectId, args: { kind: 'model', limit: 1 } }))['entries'] as { id: string }[])[0]!.id;
  await cmd('setMaterial', { material: { materialId: 'mat-one', name: 'Mat One', shader: 'standard', params: { roughness: 0.5 }, textures: {} } });
  await cmd('setTimeline', { timeline: { timelineId: 'tl-one', name: 'Timeline One', duration: 5, tracks: [] } });
  await cmd('setUiDocument', { document: { uiDocumentId: 'ui-one', name: 'Hud One', root: { type: 'panel', stretch: 'both' } } });
  await cmd('setDialogue', { dialogue: { dialogueId: 'talk-one', name: 'Talk One', graph: { nodes: [{ id: 'start', type: 'start', position: [0, 0] }], edges: [] } } });
  await cmd('setEffect', { effect: { effectId: 'fx-one', name: 'Effect One', duration: 2, loop: true, seed: 1, bounds: { center: [0, 1, 0], size: [4, 4, 4] }, systems: [] } });
  await cmd('setGraph', { graph: { graphId: 'fn-one', kind: 'material-function', name: 'Function One', graph: { nodes: [], edges: [] } } });
  await cmd('setAnimator', { controller: { controllerId: 'anim-one', name: 'Animator One', parameters: [], states: [{ id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: { assetId: model, clip: 'idle', duration: 1 } }, speed: 1, loop: true }], transitions: [], entry: 'idle', events: [] } });
  await cmd('publishBehavior', { behaviorId: 'script-one', displayName: 'Script One', mode: 'declaration-create', declaration: { properties: [] } });
  await cmd('setScriptLibrary', { libraryId: 'lib-one', name: 'Library One', files: [{ path: 'src/index.ts', text: 'export const one = 1;\n' }] });
  await cmd('createScene', { name: 'Scene Two', sceneId: 'scene-two', folder: 'levels' });
  await cmd('createPrefab', { prefabId: 'prefab-one', displayName: 'Prefab One', sourceEntityId: STARTER.groundId });
  await openAssets(page);
  await treeFolder(page, '').click();
  const search = page.getByLabel('search the project');
  const centreTabs = page.locator('.tl-tabs--center [role="tab"]');
  const opens = async (id: string, kind: string, title: string): Promise<void> => {
    await search.fill(`t:${kind} ${id}`);
    await itemTile(page, id).dblclick();
    await expect(centreTabs.filter({ hasText: title }), `${kind} ${id}`).toHaveCount(1);
  };
  await opens('mat-one', 'material', 'Mat One');
  await opens('tl-one', 'timeline', 'Timeline One');
  await opens('ui-one', 'ui', 'Hud One');
  await opens('talk-one', 'dialogue', 'Talk One');
  await opens('fx-one', 'effect', 'Effect One');
  await opens('fn-one', 'graph', 'Function One');
  await opens('anim-one', 'animator', 'Animator One');
  await opens('script-one', 'behavior', 'Script One');
  await opens('lib-one', 'library', 'Library One');
  // A scene opens in the Scene view (its header in the Hierarchy), a prefab in the Prefabs panel.
  await search.fill('t:scene scene-two');
  await itemTile(page, 'scene-two').dblclick();
  await expect(page.locator('.tl-scene-header', { hasText: 'Scene Two' })).toBeVisible();
  await projectWindow(page);
  await search.fill('t:prefab');
  await itemTile(page, 'prefab-one').dblclick();
  await expectWindowOpen(page, 'Prefabs');

  // The kind menu writes the t: of the search; list view draws rows.
  await projectWindow(page);
  await search.fill('One');
  await page.getByLabel('filter by kind').selectOption('timeline');
  await expect(search).toHaveValue('t:timeline One');
  await expect(itemTile(page, 'tl-one')).toBeVisible();
  await page.getByRole('button', { name: 'list', exact: true }).click();
  await expect(list(page).locator('li.tl-project__row[data-item-id="tl-one"]')).toBeVisible();
  await page.getByRole('button', { name: 'grid', exact: true }).click();
  await page.getByLabel('tile size').evaluate((el: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, '160');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(itemTile(page, 'tl-one')).toHaveCSS('height', '160px');
  expect(errors).toEqual([]);
});
