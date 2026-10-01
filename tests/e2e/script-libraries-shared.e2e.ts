/**
 * Shared script libraries, staged library edits and
 * source-mapped script errors, against a real backend (the Starter template
 * with neutral additions: plain boxes carrying scripts).
 *
 * 1. Shared modules: a library (`@lib/tally`, a counter and a check that gives
 *    up at a step) imported by two scripts. Each library is its own module
 *    (`libraries/<digest>.js`) the scripts import, so both count on one
 *    counter (a = 1, b = 2; bundled copies would give 1 and 1) — in Play with
 *    the simulation in the worker and on the page, and in the export served
 *    by a plain static server with the backend stopped (both modes).
 * 2. Source-mapped errors: the Console lists the Play's script log and the
 *    library's error at the project's own files and lines (the library's
 *    `src/index.ts:15`, the script's `src/index.ts:7`, the calling frame);
 *    a location opens the Library or Script tab with the cursor on that line.
 * 3. Staged edits: "Save all" in the Libraries panel commits two edited
 *    libraries in one commit (one undo), recompiling the script that imports
 *    both once; a library file larger than one request is saved from its tab
 *    in several patches, one commit.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { exportedContent, type E2EBackend, startBackend } from './backend';
import { openWindow, editorPane, openEditor } from './ui';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('script-libraries-shared-e2e', 'starter');
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
const rid = (s: string): string => `req-${createHash('sha256').update(`${s}${Math.random()}`).digest('hex').slice(0, 32)}`;
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: rid(op), origin: { kind: 'mcp', clientId: 'e2e-libraries-shared' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
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
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration: { properties: [] }, expectedRevision: Number((await query('queryProject')).revision), requestId: rid(behaviorId) });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
}

/** A box carrying a (declared) script. */
async function scripted(behaviorId: string, x: number): Promise<void> {
  const made = await cmd('createEntity', { kind: 'box', name: `Box ${behaviorId}`, transform: { position: [x, 1, 0] }, box: { size: [0.5, 0.5, 0.5], material: { color: '#808080' } } });
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration: { properties: [] } });
  await cmd('setBehaviorProperties', { entityId: String(made.createdId), behaviorId, values: {} });
}

async function library(libraryId: string, name: string, files: { path: string; text: string }[]): Promise<void> {
  await cmd('setScriptLibrary', { libraryId, name, files });
  const checked = await api('content/libraries/check', { libraryId, files });
  expect(checked.json['compiled'], JSON.stringify(checked.json)).toBe(true);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: String(checked.json['sourceDigest']) });
}

/** Replace the text of the open file in a document's code editor. */
async function replaceCode(page: Page, scope: ReturnType<Page['getByRole']>, text: string): Promise<void> {
  await scope.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.insertText(text);
}

type Obs = { state?: string; counters?: Record<string, number> };

/** A plain static file server: the exported game gets nothing else. It records the paths it served. */
function serveDir(dir: string, served: string[] = []): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    served.push(rel);
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

const TALLY = [
  'let calls = 0;',
  '',
  '/** The next number of one counter every importer shares. */',
  'export function next(): number {',
  '  calls += 1;',
  '  return calls;',
  '}',
  '',
  '/** Only here to be shaken out of the module. */',
  'function unused(): string {',
  "  return 'never shipped';",
  '}',
  '',
  'export function check(step: number): number {',
  '  if (step >= 480) throw new Error(`the tally gave up at step ${step}`);',
  '  return step;',
  '}',
  '',
].join('\n');
const TALLY_THROW_LINE = 15;

/** A script that adds the shared counter's next number to its run counter once (at `atStep`), logs it, and checks every step. */
function user(key: string, atStep: number, checks: boolean): string {
  return [
    "import type { BehaviorContext } from '@thirdlight/runtime';",
    "import { check, next } from '@lib/tally';",
    '',
    'export default {',
    '  step(_state: unknown, ctx: BehaviorContext): void {',
    "    if (ctx.phase !== 'intent') return;",
    `    if (ctx.stepIndex === ${atStep} && ctx.game?.counter('${key}') === 0) { const n = next(); ctx.game.add('${key}', n); ctx.log('info', \`tally ${key} \${n}\`); }`,
    `    if (${checks ? 'true' : 'false'}) check(ctx.stepIndex);`,
    '  },',
    '};',
    '',
  ].join('\n');
}
const LOG_LINE = 7;
const CHECK_LINE = 8;

async function playAndCount(page: Page, url: string, mode: 'worker' | 'single'): Promise<{ psid: string; libraryRequests: string[] }> {
  const libraryRequests: string[] = [];
  const onRequest = (r: { url(): string }): void => {
    if (/\/libraries\/[0-9a-f]{64}\.js$/.test(r.url())) libraryRequests.push(r.url());
  };
  page.on('request', onRequest);
  await page.goto(url);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((res) => res.request().method() === 'POST' && res.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`, {})).json as Obs;
  // One library module per realm: the two scripts count on the same counter.
  await expect.poll(async () => (await observe()).counters ?? {}, { timeout: 30_000 }).toMatchObject({ a: 1, b: 2 });
  const diag = (await api(`play/${psid}/diagnostics`, {})).json as { diagnostics?: { simulation?: { mode?: string } } };
  expect(diag.diagnostics?.simulation?.mode).toBe(mode);
  page.off('request', onRequest);
  return { psid, libraryRequests };
}

test('libraries are shared modules in Play (worker and page) and the export; the Console shows script errors at their source lines', async ({ page }) => {
  test.setTimeout(420_000);
  await library('tally', 'Tally', [{ path: 'src/index.ts', text: TALLY }]);
  await scripted('user-a', 6);
  await scripted('user-b', 7);
  await publish('user-a', user('a', 5, false));
  await publish('user-b', user('b', 6, true));

  // Play, the simulation in the worker (the default).
  const worker = await playAndCount(page, be.editorUrl, 'worker');
  expect(worker.libraryRequests.length).toBeGreaterThan(0);

  // The Console: the log at the script's line, the library's error at the library's line and the calling frame.
  await openWindow(page, 'Console');
  const consolePanel = page.getByLabel('console', { exact: true });
  const log = consolePanel.locator('li[data-code="behavior_log"]').filter({ hasText: 'tally a 1' });
  await expect(log.getByLabel('source location')).toHaveText(new RegExp(`^user-a · src/index\\.ts:${LOG_LINE}:\\d+$`), { timeout: 30_000 });
  const failure = consolePanel.locator('li[data-level="error"]').filter({ hasText: 'the tally gave up at step 480' });
  await expect(failure.getByLabel('source location')).toHaveText(new RegExp(`^@lib/tally · src/index\\.ts:${TALLY_THROW_LINE}:\\d+$`), { timeout: 30_000 });
  await expect(failure.getByLabel('frame location').first()).toHaveText(new RegExp(`^user-b · src/index\\.ts:${CHECK_LINE}:\\d+$`));
  // The diagnostics MCP reads carry the same mapped source.
  const d = (await api(`play/${worker.psid}/diagnostics`, {})).json as { diagnostics: { runtime: { errors: { code: string; source?: { libraryId?: string; path: string; line: number } }[] } } };
  expect(d.diagnostics.runtime.errors.find((e) => e.code !== 'behavior_log')?.source).toMatchObject({ libraryId: 'tally', path: 'src/index.ts', line: TALLY_THROW_LINE });
  // A location opens the library's file with the cursor on the line.
  await failure.getByLabel('source location').click();
  const libView = editorPane(page, 'Library', 'Tally');
  await expect(libView.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText(String(TALLY_THROW_LINE), { timeout: 20_000 });
  await expect(libView.locator('.cm-activeLine')).toContainText('the tally gave up');
  // And the script's log opens the script's file at its line.
  await openWindow(page, 'Console');
  await log.getByLabel('source location').click();
  const scriptView = editorPane(page, 'Script', 'user-a');
  await expect(scriptView.locator('.cm-lineNumbers .cm-activeLineGutter')).toHaveText(String(LOG_LINE), { timeout: 30_000 });
  await expect(scriptView.locator('.cm-activeLine')).toContainText("ctx.log('info'");
  await page.getByTitle('Stop the play preview').click();

  // Play, the simulation on the page.
  await playAndCount(page, be.editorUrl.replace('#', '&threads=off#'), 'single');
  await page.getByTitle('Stop the play preview').click();

  // The export: the library module ships next to the scripts; the game runs from a static server with the backend stopped.
  const res = await be.admin(`projects/${be.projectId}/export`);
  expect(res.status, JSON.stringify(res.json)).toBe(200);
  const out = join(be.exportRoot, String(res.json.outputDir));
  const manifest = exportedContent(out) as unknown as { libraries?: { libraryId: string; outputDigest: string; path: string }[]; behaviors: { path: string }[] };
  expect(manifest.libraries?.map((l) => l.libraryId)).toEqual(['tally']);
  const libPath = manifest.libraries![0]!.path;
  const libText = readFileSync(join(out, libPath), 'utf8');
  expect(libText).not.toContain('never shipped');
  for (const b of manifest.behaviors) {
    const text = readFileSync(join(out, b.path), 'utf8');
    expect(text).toContain(`../${libPath}`);
    expect(text).not.toContain('gave up');
  }
  // No source maps or sources ship with the export.
  expect(existsSync(join(out, `${libPath}.map`))).toBe(false);
  await page.goto('about:blank');
  await be.halt();
  const served: string[] = [];
  const site = await serveDir(out, served);
  try {
    for (const q of ['', '?threads=off']) {
      const game = await page.context().newPage();
      const errors: string[] = [];
      game.on('pageerror', (e) => errors.push(e.message));
      await game.goto(`${site.url}${q}`);
      const read = async (): Promise<Obs> => (await game.evaluate(() => ((window as unknown as { __thirdlightObserve?: () => unknown }).__thirdlightObserve?.() ?? {}) as Obs));
      await expect.poll(async () => (await read()).counters ?? {}, { timeout: 60_000 }).toMatchObject({ a: 1, b: 2 });
      expect(errors, q).toEqual([]);
      await game.close();
    }
    expect(served).toContain(libPath);
  } finally {
    await site.close();
  }
});

test('staged library edits: Save all commits two libraries in one commit; a large file is saved in several patches', async ({ page }) => {
  test.setTimeout(300_000);
  const ALPHA = "export const alpha = 1;\n";
  const BETA = "export const beta = 2;\n";
  await library('alpha', 'Alpha', [{ path: 'src/index.ts', text: ALPHA }]);
  await library('beta', 'Beta', [{ path: 'src/index.ts', text: BETA }]);
  await scripted('user-ab', 6);
  await publish('user-ab', ["import type { BehaviorContext } from '@thirdlight/runtime';", "import { alpha } from '@lib/alpha';", "import { beta } from '@lib/beta';", '', 'export default {', '  step(_s: unknown, ctx: BehaviorContext): void {', "    if (ctx.phase === 'intent' && ctx.game?.counter('ab') === 0) ctx.game.add('ab', alpha * 10 + beta);", '  },', '};', ''].join('\n'));
  const stored = async (): Promise<Record<string, { path: string; text: string }[]>> =>
    Object.fromEntries(((await query('queryGameConfig'))['scriptLibraries'] as { libraryId: string; files: { path: string; text: string }[] }[]).map((l) => [l.libraryId, l.files]));

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  await openWindow(page, 'Libraries');
  // Edit both libraries in their tabs (unsaved).
  for (const [name, text] of [['Alpha', 'export const alpha = 3;\n'], ['Beta', 'export const beta = 4;\n']] as const) {
    await openWindow(page, 'Libraries');
    await page.getByRole('button', { name: `Open ${name}` }).click();
    const view = editorPane(page, 'Library', name);
    await expect(view.getByLabel('compile status')).toHaveAttribute('data-status', 'ok', { timeout: 20_000 });
    await replaceCode(page, view, text);
    await expect(view.getByText('unsaved edits')).toBeVisible();
  }
  const pending = page.getByLabel('unsaved libraries');
  await expect(pending).toContainText('@lib/alpha, @lib/beta');

  // Save all: both staged, one commit; the new digests are acknowledged first; the script is recompiled once.
  const commits: Record<string, unknown>[] = [];
  page.on('response', (r) => {
    if (r.request().method() === 'POST' && r.url().endsWith('/commands') && (r.request().postData() ?? '').includes('commitScriptLibraryStage')) void r.json().then((j) => commits.push(j as Record<string, unknown>), () => undefined);
  });
  await openWindow(page, 'Libraries');
  await pending.getByRole('button', { name: 'Save all' }).click();
  const trust = page.getByRole('group', { name: 'save all trust acknowledgment' });
  await expect(trust).toBeVisible({ timeout: 20_000 });
  await trust.getByRole('button').click();
  await expect(page.getByLabel('save all result')).toContainText('in 2 patches, one commit. Recompiled user-ab (each once).', { timeout: 30_000 });
  await expect(pending).toContainText('No unsaved library edits.');
  const ok = commits.find((c) => c['ok'] === true) as { revision: number; change: { type: string; libraries: { libraryId: string }[] }; libraryStage: { compiled: number; dependents: { behaviorId: string }[] } };
  expect(ok.change.type).toBe('setScriptLibraries');
  expect(ok.change.libraries.map((l) => l.libraryId)).toEqual(['alpha', 'beta']);
  expect(ok.libraryStage.compiled).toBe(1);
  expect(ok.libraryStage.dependents.map((d) => d.behaviorId)).toEqual(['user-ab']);
  expect((await stored())['alpha']![0]!.text).toBe('export const alpha = 3;\n');
  expect((await stored())['beta']![0]!.text).toBe('export const beta = 4;\n');
  await openEditor(page, 'Library', 'Beta');
  await expect(editorPane(page, 'Library', 'Beta').getByText('saved', { exact: true })).toBeVisible();
  // One undo takes both back.
  await cmd('undo', {});
  expect((await stored())['alpha']![0]!.text).toBe(ALPHA);
  expect((await stored())['beta']![0]!.text).toBe(BETA);
  await cmd('redo', {});

  // Files larger than one command request, saved from their tab: several patches (a file in pieces), one commit.
  await openWindow(page, 'Libraries');
  await page.getByRole('button', { name: 'Open Alpha' }).click();
  const alpha = editorPane(page, 'Library', 'Alpha');
  const table = (from: number): string => `${JSON.stringify({ rows: Array.from({ length: 800 }, (_, i) => ({ id: from + i, label: `row number ${from + i} of a large neutral table` })) })}\n`;
  const bigFiles = [{ path: 'src/big-a.json', text: table(0) }, { path: 'src/big-b.json', text: table(800) }];
  // Each file is within a library's 64 KiB per file; together they are over the 64 KiB command request cap.
  for (const f of bigFiles) expect(f.text.length).toBeLessThan(64 * 1024);
  expect(bigFiles.reduce((n, f) => n + JSON.stringify(f.text).length, 0)).toBeGreaterThan(64 * 1024);
  for (const f of bigFiles) {
    await alpha.getByRole('button', { name: '+ File' }).click();
    await alpha.getByLabel('new file name').fill(f.path);
    await alpha.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(alpha.locator(`.tl-script__file[data-file="${f.path}"]`)).toHaveAttribute('aria-current', 'true');
    await replaceCode(page, alpha, f.text);
  }
  await expect(alpha.getByLabel('compile status')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 });
  await alpha.getByRole('button', { name: 'Save', exact: true }).click();
  // user-ab imports alpha: its new digest is acknowledged first.
  const ack = alpha.getByRole('group', { name: 'trust acknowledgment' });
  await expect(ack).toBeVisible({ timeout: 30_000 });
  await ack.getByRole('button').click();
  await expect(alpha.getByLabel('save result')).toContainText(/Saved \(r\d+\) in ([3-9]|\d\d) patches, one commit\. Recompiled user-ab \(each once\)\./, { timeout: 30_000 });
  for (const f of bigFiles) expect((await stored())['alpha']!.find((x) => x.path === f.path)?.text).toBe(f.text);
});
