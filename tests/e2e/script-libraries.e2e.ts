/**
 * Phase 23.7: shared script libraries against a real backend (the engine
 * sample with neutral additions: two plain boxes, each carrying a script).
 *
 * - The Libraries tab creates a library ("Scoring" → `@lib/scoring`); its
 *   tab edits the files: a `.json` data file is added and the entry module
 *   reads it; the backend compiles the draft (idle check) and Save stores it
 *   (one setScriptLibrary command).
 * - Two scripts import it (`import { points } from '@lib/scoring'`) and are
 *   published through the ordinary source route; their records pin the
 *   library's digest.
 * - Play shows the effect: each script adds the library's value to a run
 *   counter (observed).
 * - Editing the library in its tab and saving asks for the new digest's
 *   trust acknowledgment, then recompiles both scripts in the same command;
 *   Play shows the new values. The export builds with the library linked.
 */
import { createHash } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('script-libraries-e2e', 'beacon-reach');
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
    origin: { kind: 'mcp', clientId: 'e2e-script-libraries' },
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

const LIBRARY_INDEX = ["import table from './table.json';", '', '/** The points a counter gets (from the data table). */', "export function points(key: 'alpha' | 'beta'): number {", '  return table[key];', '}', ''].join('\n');

/** A script that adds the library's points for `key` to the run counter of the same name, once. */
function user(key: 'alpha' | 'beta'): string {
  return [
    "import type { BehaviorContext } from '@thirdlight/runtime';",
    "import { points } from '@lib/scoring';",
    '',
    'export default {',
    '  step(_state: unknown, ctx: BehaviorContext) {',
    "    if (ctx.phase !== 'intent') return;",
    `    if (ctx.game?.counter('${key}') === 0) ctx.game.add('${key}', points('${key}'));`,
    '  },',
    '};',
    '',
  ].join('\n');
}

/** Publish `behaviorId` with this source through the stage + source route (trust acknowledged first). */
async function publish(behaviorId: string, source: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration: { properties: [] }, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${createHash('sha256').update(`${behaviorId}${Math.random()}`).digest('hex').slice(0, 32)}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
}

type Pin = { libraryId: string; sourceDigest: string };
async function pins(behaviorId: string): Promise<{ pins: Pin[]; outputDigest: string } | null> {
  const rows = (await query('queryBehaviors', { includeDeclaration: true, behaviorId }))['behaviors'] as { source: { libraries?: Pin[]; outputDigest: string } | null }[];
  const s = rows[0]?.source;
  return s === null || s === undefined ? null : { pins: s.libraries ?? [], outputDigest: s.outputDigest };
}

async function playCounters(page: Page, expected: Record<string, number>): Promise<void> {
  const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  type Obs = { state?: string; counters?: Record<string, number> };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  await expect.poll(async () => (await observe()).state, { timeout: 30_000 }).toBe('awaitingStart');
  expect((await api(`play/${psid}/control`, { command: 'start' })).status).toBe(200);
  for (const [key, value] of Object.entries(expected)) await expect.poll(async () => (await observe()).counters?.[key], { timeout: 30_000 }).toBe(value);
  await page.getByTitle('Stop the play preview').click();
}

test('a library made in the editor is imported by two scripts; Play shows it; saving it recompiles them', async ({ page }) => {
  test.setTimeout(300_000);
  for (const [i, id] of (['alpha', 'beta'] as const).entries()) {
    const made = await cmd('createEntity', { kind: 'box', name: `Box ${id}`, transform: { position: [6 + i, 1, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#808080' } } });
    await cmd('publishBehavior', { behaviorId: `user-${id}`, displayName: `User ${id}`, mode: 'declaration-create', declaration: { properties: [] } });
    await cmd('setBehaviorProperties', { entityId: String(made.createdId), behaviorId: `user-${id}`, values: {} });
  }

  // The Libraries tab: create "Scoring" (→ @lib/scoring); its tab opens with a starting entry module.
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await page.getByRole('tab', { name: 'Libraries' }).click();
  await page.getByLabel('New library name').fill('Scoring');
  await page.getByRole('button', { name: 'Create library' }).click();
  const view = page.getByRole('tabpanel', { name: 'Library: Scoring' });
  await expect(view.getByLabel('library editor')).toHaveAttribute('data-library', 'scoring');
  const status = view.getByLabel('compile status');
  await expect(status).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });

  // A JSON data file, and the entry module that reads it.
  await view.getByRole('button', { name: '+ File' }).click();
  await view.getByLabel('new file name').fill('src/table.json');
  await view.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(view.locator('.tl-script__file[data-file="src/table.json"]')).toHaveAttribute('aria-current', 'true');
  await replaceCode(page, '{ "alpha": 2, "beta": 3 }\n');
  await view.locator('.tl-script__file[data-file="src/index.ts"]').click();
  await replaceCode(page, LIBRARY_INDEX);
  // A mistake is reported with its file and line; fixed, the draft compiles.
  await page.keyboard.insertText('export const broken = (;\n');
  await page.keyboard.press('ControlOrMeta+s');
  await expect(status).toHaveAttribute('data-status', 'errors', { timeout: 20_000 });
  await expect(view.getByLabel('library problems')).toContainText('src/index.ts:');
  await replaceCode(page, LIBRARY_INDEX);
  await expect(status).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
  await view.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(view.getByLabel('save result')).toContainText('Saved', { timeout: 20_000 });
  const stored = ((await query('queryGameConfig'))['scriptLibraries'] as { libraryId: string; name: string; files: { path: string; text: string }[] }[]).find((l) => l.libraryId === 'scoring');
  expect(stored?.name).toBe('Scoring');
  expect(stored?.files.map((f) => f.path)).toEqual(['src/index.ts', 'src/table.json']);

  // Two scripts import it; publishing links it (the library's digest acknowledged like a source).
  const checked = await api('content/libraries/check', { libraryId: 'scoring', files: stored!.files });
  expect(checked.json['compiled'], JSON.stringify(checked.json)).toBe(true);
  const digestV1 = String(checked.json['sourceDigest']);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: digestV1 });
  await publish('user-alpha', user('alpha'));
  await publish('user-beta', user('beta'));
  expect((await pins('user-alpha'))?.pins).toEqual([{ libraryId: 'scoring', sourceDigest: digestV1 }]);
  expect((await pins('user-beta'))?.pins).toEqual([{ libraryId: 'scoring', sourceDigest: digestV1 }]);
  const before = { alpha: (await pins('user-alpha'))!.outputDigest, beta: (await pins('user-beta'))!.outputDigest };

  // Play shows the library's values.
  await playCounters(page, { alpha: 2, beta: 3 });

  // Edit the data in the library tab; saving asks to acknowledge the new digest, then recompiles both scripts.
  await page.getByRole('tab', { name: 'Library: Scoring', exact: true }).click();
  await expect(view.getByLabel('library dependents')).toContainText('user-alpha, user-beta', { timeout: 20_000 });
  await view.locator('.tl-script__file[data-file="src/table.json"]').click();
  await replaceCode(page, '{ "alpha": 20, "beta": 30 }\n');
  await expect(status).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
  await view.getByRole('button', { name: 'Save', exact: true }).click();
  const trust = view.getByRole('group', { name: 'trust acknowledgment' });
  await expect(trust).toBeVisible({ timeout: 20_000 });
  await trust.getByRole('button').click();
  await expect(view.getByLabel('save result')).toContainText('Recompiled user-alpha, user-beta', { timeout: 30_000 });
  const after = { alpha: await pins('user-alpha'), beta: await pins('user-beta') };
  expect(after.alpha?.pins[0]?.sourceDigest).not.toBe(digestV1);
  expect(after.alpha?.outputDigest).not.toBe(before.alpha);
  expect(after.beta?.outputDigest).not.toBe(before.beta);
  await playCounters(page, { alpha: 20, beta: 30 });

  // A library a published script imports cannot be deleted.
  const del = await be.command({ op: 'deleteScriptLibrary', projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${createHash('sha256').update(`del${Math.random()}`).digest('hex').slice(0, 32)}`, origin: { kind: 'mcp', clientId: 'e2e-script-libraries' }, args: { libraryId: 'scoring' } });
  expect((del as { error?: { code?: string } }).error?.code).toBe('reference_in_use');

  // A change a dependent script no longer compiles against is refused, naming the script (nothing changes).
  const badFiles = [{ path: 'src/index.ts', text: 'export const other = 1;\n' }, { path: 'src/table.json', text: '{}\n' }];
  const badCheck = await api('content/libraries/check', { libraryId: 'scoring', files: badFiles });
  expect(badCheck.json['compiled']).toBe(true);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: String(badCheck.json['sourceDigest']) });
  const bad = (await be.command({ op: 'setScriptLibrary', projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${createHash('sha256').update(`bad${Math.random()}`).digest('hex').slice(0, 32)}`, origin: { kind: 'mcp', clientId: 'e2e-script-libraries' }, args: { libraryId: 'scoring', files: badFiles } })) as { ok: boolean; error?: { code?: string; behaviorId?: string; message?: string } };
  expect(bad.ok).toBe(false);
  expect(bad.error?.behaviorId, JSON.stringify(bad)).toBe('user-alpha');
  expect(bad.error?.message).toContain('does not compile against the changed library @lib/scoring');
  expect((await pins('user-alpha'))?.outputDigest).toBe(after.alpha?.outputDigest);

  // The export builds with the library linked into both scripts.
  const exported = await be.admin(`projects/${be.projectId}/export`);
  expect(exported.status, JSON.stringify(exported.json)).toBe(200);
});
