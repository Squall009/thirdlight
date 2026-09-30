/**
 * The project window at scale, driven in a real browser against the bench
 * project: a folder made, 1,000 voice files chosen in their folder (a click
 * and a Shift-click 1,000 tiles down), labelled in one command, cut and
 * pasted into the new folder in one command, then both undone so the steps
 * after this one see the project as generated.
 *
 * Used by the scale bench's `editor` step (scale.ts) and its end-to-end test
 * (tests/e2e/editor-scale.e2e.ts). Only the page's public DOM is driven.
 */
import type { Page } from '@playwright/test';

export interface ProjectWindowScaleReport {
  /** The files chosen, labelled and moved. */
  files: number;
  /** The folder they were in and the one they went to. */
  from: string;
  to: string;
  /** Shift-click → every file chosen (the range is read from the index past the tiles on screen). */
  chooseMs: number;
  /** "add labels" → the backend has the label on every one (one command). */
  labelMs: number;
  /** Ctrl+V → the backend lists every one in the new folder (one command: the files and sidecars moved). */
  moveMs: number;
  /** Ctrl+V → the window lists them in the new folder. */
  moveShownMs: number;
  /** Edit → Undo of the move → every file back in its folder; of the label → the label gone. */
  undoMoveMs: number;
  undoLabelMs: number;
  /** The revisions the label and the move took (1 each: one command, one undo). */
  revisions: { label: number; move: number };
}

export interface ProjectWindowScaleOptions {
  query: (op: string, args?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** How many files to choose, label and move. */
  files: number;
  /** The folder they are in (a folder of the bench's game folder holding at least `files` assets). */
  folder: string;
  log?: (s: string) => void;
  /** Called once the files are moved, before the undo (a test checks the files on disk). */
  onMoved?: (to: string) => Promise<void>;
}

/** The label the step gives the chosen files. */
export const PROJECT_BATCH_LABEL = 'window-batch';

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 300_000): Promise<void> {
  const t = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - t > timeoutMs) throw new Error(`${what}: not within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export async function measureProjectWindowAtScale(page: Page, o: ProjectWindowScaleOptions): Promise<ProjectWindowScaleReport> {
  const log = o.log ?? (() => undefined);
  const revision = async (): Promise<number> => Number((await o.query('queryProject'))['revision']);
  const count = async (args: Record<string, unknown>): Promise<number> => Number((await o.query('queryIndex', { refs: false, limit: 1, ...args }))['total'] ?? 0);
  const list = page.locator('.tl-assets__list');
  const parent = o.folder.includes('/') ? o.folder.slice(0, o.folder.lastIndexOf('/')) : '';
  const name = `${o.folder.slice(o.folder.lastIndexOf('/') + 1)}-moved`;
  const to = parent === '' ? name : `${parent}/${name}`;
  await page.getByRole('tab', { name: 'Assets', exact: true }).click();

  // A new folder beside the voices.
  await page.getByRole('button', { name: parent === '' ? 'folder (game folder)' : `folder ${parent}`, exact: true }).click();
  await page.getByRole('button', { name: 'new folder', exact: true }).click();
  await page.getByLabel('folder name', { exact: true }).fill(name);
  await page.getByLabel('folder name', { exact: true }).press('Enter');
  await list.locator(`li[data-folder="${to}"]`).waitFor({ timeout: 60_000 });

  // Into the voices' folder: the first tile, then a Shift-click on the one `files` down.
  await list.locator(`li[data-folder="${o.folder}"]`).dblclick();
  await page.locator('.tl-project__crumb.is-current').filter({ hasText: o.folder.slice(o.folder.lastIndexOf('/') + 1) }).waitFor();
  const firstPage = await o.query('queryIndex', { folder: o.folder, refs: false, limit: 1, offset: 0 });
  const lastPage = await o.query('queryIndex', { folder: o.folder, refs: false, limit: 1, offset: o.files - 1 });
  const firstId = ((firstPage['entries'] as { id: string }[]) ?? [])[0]?.id;
  const lastId = ((lastPage['entries'] as { id: string }[]) ?? [])[0]?.id;
  if (firstId === undefined || lastId === undefined) throw new Error(`${o.folder} holds fewer than ${o.files} files`);
  await list.locator(`li[data-asset-id="${firstId}"]`).click();
  await page.evaluate(
    async ({ position }) => {
      const el = document.querySelector('.tl-assets__list') as HTMLElement;
      const n = Number(el.dataset['virtualCount']);
      el.scrollTop = (position / Math.max(1, n)) * el.scrollHeight - el.clientHeight / 2;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    { position: o.files - 1 },
  );
  const last = list.locator(`li[data-asset-id="${lastId}"]`);
  for (let i = 0; i < 100 && (await last.count()) === 0; i++) {
    await page.evaluate(() => {
      (document.querySelector('.tl-assets__list') as HTMLElement).scrollTop += 40;
    });
    await page.waitForTimeout(30);
  }
  const t0 = Date.now();
  await last.click({ modifiers: ['Shift'] });
  await page.getByTestId('project-chosen').filter({ hasText: `${o.files} chosen` }).waitFor({ timeout: 120_000 });
  const chooseMs = Date.now() - t0;
  log(`project window: ${o.files} files chosen in ${chooseMs} ms`);

  // Labelled in one command.
  const r0 = await revision();
  const bar = page.getByTestId('labels-bar');
  await page.getByLabel('label the chosen assets').fill(PROJECT_BATCH_LABEL);
  const t1 = Date.now();
  await bar.getByRole('button', { name: 'add labels', exact: true }).click();
  await waitFor('the label on every chosen file', async () => (await count({ label: PROJECT_BATCH_LABEL })) >= o.files);
  const labelMs = Date.now() - t1;
  const r1 = await revision();
  log(`project window: ${o.files} files labelled in ${labelMs} ms (${r1 - r0} revision)`);

  // Cut, and pasted into the new folder: one command.
  await page.locator('.tl-project__main').focus();
  await page.keyboard.press('Control+x');
  await page.getByRole('button', { name: 'folder ' + to, exact: true }).click();
  await page.locator('.tl-project__main').focus();
  const t2 = Date.now();
  await page.keyboard.press('Control+v');
  await waitFor('every chosen file in the new folder', async () => (await count({ folder: to })) >= o.files);
  const moveMs = Date.now() - t2;
  await page.locator(`.tl-assets__paging[data-total="${o.files}"]`).waitFor({ timeout: 120_000 });
  const moveShownMs = Date.now() - t2;
  const r2 = await revision();
  log(`project window: ${o.files} files moved in ${moveMs} ms (shown ${moveShownMs} ms, ${r2 - r1} revision)`);
  await o.onMoved?.(to);

  // Both undone (the bench's later steps see the project as generated).
  const t3 = Date.now();
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Undo', exact: true }).click();
  await waitFor('every file back in its folder', async () => (await count({ folder: to })) === 0);
  const undoMoveMs = Date.now() - t3;
  const t4 = Date.now();
  await page.getByRole('menubar').getByRole('menuitem', { name: 'Edit', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Undo', exact: true }).click();
  await waitFor('the label gone', async () => (await count({ label: PROJECT_BATCH_LABEL })) === 0);
  const undoLabelMs = Date.now() - t4;
  log(`project window: the move undone in ${undoMoveMs} ms; the label undone in ${undoLabelMs} ms`);
  return { files: o.files, from: o.folder, to, chooseMs, labelMs, moveMs, moveShownMs, undoMoveMs, undoLabelMs, revisions: { label: r1 - r0, move: r2 - r1 } };
}
