/**
 * Phase 16.3: the script editor tab against a real backend (the engine
 * sample with neutral additions: a plain box carrying a declared behavior).
 *
 * - Double-click the behavior → its script tab: a code editor with the file
 *   list, a new source template that compiles, and completion from the
 *   behavior API typings (`ctx.ti` → `timers`).
 * - Multi-file: add a file, rename it, add and delete another.
 * - A syntax error: Ctrl+S compiles through the backend compiler; the error is
 *   marked inline (squiggle + gutter) and listed with its line; fixing it
 *   compiles clean after the idle pause.
 * - Publish: the trust acknowledgment for the new digest, then the source
 *   route (one publishBehavior command); the backend stores both files.
 * - Play runs it: the script adds its property to a run counter (observed).
 */
import { createHash } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('script-editor-e2e', 'beacon-reach');
});
test.afterEach(async () => {
  await be.stop();
});

async function api(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be.token}`, 'content-type': 'application/json', origin: be.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const query = (op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => be.command({ op, projectId: be.projectId, args });

async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({
    op,
    projectId: be.projectId,
    expectedRevision: Number((await query('queryProject')).revision),
    requestId: `req-${createHash('sha256').update(`${op}${Math.random()}`).digest('hex').slice(0, 32)}`,
    origin: { kind: 'mcp', clientId: 'e2e-script-editor' },
    args,
  });
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res;
}

/** Replace the open file's text in the code editor. */
async function replaceCode(page: Page, text: string): Promise<void> {
  const content = page.locator('.tl-script .cm-content');
  await content.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

const UTIL = ['/** A number property, or 0. */', 'export function amountOf(value: unknown): number {', "  return typeof value === 'number' ? value : 0;", '}', ''].join('\n');

const BROKEN = [
  "import type { BehaviorContext } from '@thirdlight/runtime';",
  "import { amountOf } from './util';",
  '',
  'export default {',
  '  step(_state: unknown, ctx: BehaviorContext) {',
  "    if (ctx.phase !== 'intent') return;",
  "    if (ctx.game?.counter('ticks') === 0) ctx.game.add('ticks', amountOf(ctx.properties.amount);",
  '  },',
  '};',
  '',
].join('\n');
const FIXED = BROKEN.replace('amountOf(ctx.properties.amount);', 'amountOf(ctx.properties.amount));');

test('script tab: edit, see a compile error inline, fix it, publish, Play runs it', async ({ page }) => {
  test.setTimeout(240_000);
  const made = await cmd('createEntity', { kind: 'box', name: 'Counter box', transform: { position: [6, 1, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#808080' } } });
  const boxId = String(made.createdId);
  await cmd('publishBehavior', { behaviorId: 'counter', displayName: 'Counter', mode: 'declaration-create', declaration: { properties: [{ key: 'amount', label: 'Amount', type: 'number', default: 3 }] } });
  await cmd('setBehaviorProperties', { entityId: boxId, behaviorId: 'counter', values: {} });

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Behaviors' }).click();
  await page.locator('.tl-behaviors__list .tl-tile', { hasText: 'Counter' }).dblclick();
  const view = page.getByRole('tabpanel', { name: 'Script: Counter' });
  const script = view.getByLabel('script editor');
  await expect(script).toHaveAttribute('data-behavior', 'counter');
  // The declaration editor docks beside the code.
  await expect(view.getByLabel('declaration editor')).toHaveAttribute('data-behavior', 'counter');
  const status = view.getByLabel('compile status');
  // No source yet: the new-script template, compiled by the backend after the idle pause.
  await expect(view.locator('.tl-script__file[data-file="src/index.ts"]')).toHaveAttribute('aria-current', 'true');
  await expect(status).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });

  // Completion from the behavior API typings.
  await view.locator('.cm-line', { hasText: "ctx.phase !== 'intent'" }).click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ctx.ti');
  const completion = page.locator('.cm-tooltip-autocomplete');
  await expect(completion).toContainText('timers');
  await page.keyboard.press('Escape');

  // Multi-file: add src/tmp.ts, rename it to src/util.ts; add src/junk.ts and delete it.
  await view.getByRole('button', { name: '+ File' }).click();
  await view.getByLabel('new file name').fill('src/tmp.ts');
  await view.getByLabel('new file name').press('Enter');
  await expect(view.locator('.tl-script__file[data-file="src/tmp.ts"]')).toHaveAttribute('aria-current', 'true');
  await view.getByRole('button', { name: 'Rename', exact: true }).click();
  await view.getByLabel('rename file to').fill('src/util.ts');
  await view.getByLabel('rename file to').press('Enter');
  await expect(view.locator('.tl-script__file[data-file="src/util.ts"]')).toHaveAttribute('aria-current', 'true');
  await expect(view.locator('.tl-script__file[data-file="src/tmp.ts"]')).toHaveCount(0);
  await replaceCode(page, UTIL);
  await view.getByRole('button', { name: '+ File' }).click();
  await view.getByLabel('new file name').fill('src/junk.ts');
  await view.getByLabel('new file name').press('Enter');
  await expect(view.locator('.tl-script__file[data-file="src/junk.ts"]')).toHaveAttribute('aria-current', 'true');
  await view.getByRole('button', { name: 'Delete', exact: true }).click();
  await view.getByRole('button', { name: 'Delete src/junk.ts?' }).click();
  await expect(view.locator('.tl-script__file[data-file="src/junk.ts"]')).toHaveCount(0);
  // Back on the entry file (a delete opens it).
  await expect(view.locator('.tl-script__file[data-file="src/index.ts"]')).toHaveAttribute('aria-current', 'true');

  // A syntax error: Ctrl+S compiles now; the error is marked inline and listed.
  await replaceCode(page, BROKEN);
  await page.keyboard.press('ControlOrMeta+s');
  await expect(status).toHaveAttribute('data-status', 'errors', { timeout: 20_000 });
  await expect(view.locator('.cm-lintRange-error').first()).toBeVisible();
  await expect(view.locator('.cm-lint-marker-error').first()).toBeVisible();
  const problems = view.getByLabel('script problems');
  await expect(problems).toContainText('src/index.ts:7');
  await expect(view.locator('.tl-script__file[data-file="src/index.ts"] .tl-script__badge')).toHaveText('1');
  // Nothing was published by the check.
  const record = async (): Promise<{ source: { sourceDigest: string } | null } | undefined> =>
    ((await query('queryBehaviors', { includeDeclaration: true, behaviorId: 'counter' }))['behaviors'] as { source: { sourceDigest: string } | null }[])[0];
  expect((await record())?.source).toBeNull();

  // Fix it: the idle compile clears the marks.
  await replaceCode(page, FIXED);
  await expect(status).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
  await expect(view.locator('.cm-lintRange-error')).toHaveCount(0);
  await expect(problems).toContainText('No problems.');

  // Publish: acknowledge the new digest, then the source route.
  await view.getByRole('button', { name: 'Publish', exact: true }).click();
  const trust = view.getByRole('group', { name: 'trust acknowledgment' });
  await expect(trust).toBeVisible();
  await trust.getByRole('button').click();
  await expect(view.getByLabel('publish result')).toContainText('Published', { timeout: 20_000 });
  await expect.poll(async () => (await record())?.source?.sourceDigest ?? null).not.toBeNull();
  // The stored source is the edited container: both files, the fixed code.
  const stored = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/behaviors/counter/source`, { headers: { authorization: `Bearer ${be.token}`, origin: be.origin } });
  const storedJson = (await stored.json()) as { source: string };
  expect(typeof storedJson.source, JSON.stringify(storedJson)).toBe('string');
  const container = JSON.parse(storedJson.source) as { requiredModules: string[]; files: { path: string; text: string }[] };
  expect(container.files.map((f) => f.path)).toEqual(['src/index.ts', 'src/util.ts']);
  expect(container.files[0]!.text).toContain("amountOf(ctx.properties.amount));");
  expect(container.requiredModules).toEqual(['@thirdlight/runtime']);
  await expect(view.getByText('unpublished edits')).toHaveCount(0);

  // Play runs it: the script adds its property (3) to the run's "ticks" counter once.
  const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number> };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('awaitingStart');
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  await expect.poll(async () => (await observe()).counters?.['ticks'], { timeout: 30_000 }).toBe(3);
  await page.getByTitle('Stop the play preview').click();

  // A reload keeps the tab; the editor loads the published source from the backend.
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Script: Counter', exact: true }).click();
  await expect(view.locator('.tl-script__file[data-file="src/util.ts"]')).toHaveCount(1);
  await expect(view.locator('.cm-content')).toContainText('amountOf(ctx.properties.amount));');
  await expect(view.getByText('published', { exact: true })).toBeVisible();
  await expect(status).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
});
