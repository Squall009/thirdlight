/**
 * Addresses and labels in the editor, against the real backend and Chromium:
 *
 * - three assets chosen at once in the Assets tab (Ctrl-click, Shift-click)
 *   get labels in one command (one revision);
 * - the asset inspector (the tab's side panel) sets an address; Edit → Undo
 *   takes it back, and the sidecar follows;
 * - after a reload the labels are there and the address is not;
 * - a script library naming an asset that is not loadable shows in Problems;
 *   labelling that asset makes it loadable.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { menu, projectWindow, openWindow } from './ui';

const REPO = resolve(import.meta.dirname, '..', '..');
const OPUS = readFileSync(join(REPO, 'fixtures', 'music', 'chord-opus.ogg'));
const WAV = readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav'));

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend();
});
test.afterEach(async () => {
  await be.stop();
});

const tile = (page: Page, name: string) => page.locator('.tl-assets__list li.tl-tile').filter({ has: page.locator('.tl-tile__name', { hasText: new RegExp(`^${name}$`) }) });
const sidecar = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(be.projectDir, ...`${rel}.tlasset`.split('/')), 'utf8')) as Record<string, unknown>;
const revision = async (): Promise<number> => Number((await be.command({ op: 'queryProject', projectId: be.projectId, args: {} }))['revision']);

test('labels on several assets at once, an address in the inspector, undo, reload; a script naming a non-loadable asset is a Problem', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Four sound files in the game folder, imported as a folder (no labels yet).
  mkdirSync(join(be.projectDir, 'assets', 'voice'), { recursive: true });
  for (const n of ['line-a', 'line-b', 'line-c']) writeFileSync(join(be.projectDir, 'assets', 'voice', `${n}.ogg`), OPUS);
  writeFileSync(join(be.projectDir, 'assets', 'voice', 'thud.wav'), WAV);
  const imported = await be.command({ op: 'importAssets', projectId: be.projectId, expectedRevision: await revision(), requestId: `req-${'1'.repeat(32)}`, origin: { kind: 'mcp', clientId: 'e2e' }, args: { folder: 'assets/voice' } });
  expect(imported['ok'], JSON.stringify(imported)).toBe(true);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await projectWindow(page);
  await expect(tile(page, 'line-a')).toHaveCount(1, { timeout: 10_000 });

  // Choose three: a click, a Ctrl-click, a Shift-click; label them in one command.
  await tile(page, 'line-a').click();
  await tile(page, 'line-c').click({ modifiers: ['Control'] });
  await tile(page, 'line-b').click({ modifiers: ['Shift'] });
  const bar = page.getByTestId('labels-bar');
  await expect(bar).toContainText('3 chosen');
  const before = await revision();
  await page.getByLabel('label the chosen assets').fill('voice, act-1');
  await bar.getByRole('button', { name: 'add labels' }).click();
  await expect.poll(() => sidecar('assets/voice/line-b.ogg')['labels']).toEqual(['act-1', 'voice']);
  expect(sidecar('assets/voice/line-a.ogg')['labels']).toEqual(['act-1', 'voice']);
  expect(sidecar('assets/voice/line-c.ogg')['labels']).toEqual(['act-1', 'voice']);
  expect(sidecar('assets/voice/thud.wav')['labels']).toEqual([]);
  expect(await revision()).toBe(before + 1);

  // One asset: its inspector shows the labels; set an address, then undo it.
  await tile(page, 'line-b').click();
  const fields = page.getByTestId('loadable-fields');
  await expect(fields).toContainText('loadable');
  await expect(page.getByTestId('loadable-labels').locator('.tl-chip')).toHaveText(['act-1×', 'voice×']);
  await page.getByLabel('address').fill('voice/act-1/line-b');
  await page.getByLabel('address').press('Enter');
  await expect.poll(() => sidecar('assets/voice/line-b.ogg')['address']).toBe('voice/act-1/line-b');
  expect((sidecar('assets/voice/line-b.ogg')['record'] as { address?: string }).address).toBe('voice/act-1/line-b');
  // An address is unique project-wide: the inspector says why another asset cannot have it.
  await tile(page, 'line-c').click();
  await page.getByLabel('address').fill('voice/act-1/line-b');
  await page.getByLabel('address').press('Enter');
  await expect(page.getByTestId('loadable-error')).toContainText('unique project-wide');
  await page.getByLabel('address').press('Escape');
  await tile(page, 'line-b').click();
  await menu(page, 'Edit', 'Undo');
  await expect.poll(() => sidecar('assets/voice/line-b.ogg')['address']).toBeNull();
  await expect(page.getByLabel('address')).toHaveValue('');

  // After a reload: the labels stayed, the address is gone.
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await projectWindow(page);
  await tile(page, 'line-a').click();
  await expect(page.getByTestId('asset-labels')).toHaveText('labels: act-1, voice');
  await expect(page.getByLabel('address')).toHaveValue('');
  await tile(page, 'thud').click();
  await expect(page.getByTestId('loadable-fields')).toContainText('not loadable');

  // A script library that names "thud" by id: it is not loadable, so Problems says so.
  const lib = await be.command({ op: 'setScriptLibrary', projectId: be.projectId, expectedRevision: await revision(), requestId: `req-${'2'.repeat(32)}`, origin: { kind: 'mcp', clientId: 'e2e' }, args: { libraryId: 'sounds', name: 'Sounds', files: [{ path: 'src/index.ts', text: 'export const THUD = "thud";\nexport const LINE = "line-a";\n' }] } });
  expect(lib['ok'], JSON.stringify(lib)).toBe(true);
  await openWindow(page, 'Problems');
  const problem = page.locator('.tl-problem').filter({ hasText: 'isn\'t loadable' });
  await expect(problem).toContainText('"thud" (library sounds (src/index.ts))', { timeout: 10_000 });
  await expect(problem).not.toContainText('"line-a"');

  // Labelled, it is loadable (its inspector says so).
  await projectWindow(page);
  await tile(page, 'thud').click();
  await page.getByLabel('add label').fill('sfx');
  await page.getByLabel('add label').press('Enter');
  await expect(page.getByTestId('loadable-fields')).toContainText('· loadable');
  await expect.poll(() => sidecar('assets/voice/thud.wav')['labels']).toEqual(['sfx']);
  expect(errors).toEqual([]);
});
