/**
 * Play's script log against a real backend and a real browser.
 *
 * 1. Refused script calls and a long run's log: a script on the starter
 *    template commits an intent the runtime refuses and adds to a counter
 *    whose name a save could not keep, every step. The run goes on (the
 *    calls answer false), and the Console shows each refusal once. Then a
 *    debug command starts a flood of long log lines: the diagnostics still
 *    arrive (trimmed to the relay's bound, oldest entries first, with the
 *    count of what was left out), and the Console says how many it lost.
 * 2. A conversation drawn by a project's own dialogue document (its own id,
 *    the engine document's widget ids): at a choice the keyboard focus moves
 *    to the first option, so Enter picks it, and back to the box after.
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';
import { openWindow } from './ui';

let be: E2EBackend | null = null;
test.afterEach(async () => {
  await be?.stop();
  be = null;
});

async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be!.command({ op, projectId: be!.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be!.command({ op, projectId: be!.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-play-logs' }, args });
  expect(res.ok, JSON.stringify(res).slice(0, 600)).toBe(true);
  return res;
}
async function api(path: string, body: unknown = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${be!.token}`, 'content-type': 'application/json', origin: be!.origin },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function publishScript(behaviorId: string, text: string): Promise<void> {
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: [], ownedTransforms: [], files: [{ path: 'src/index.ts', text }] }, null, 2)}\n`);
  const stage = await api('content/stages', {});
  const stageId = String(stage.json.stageId);
  const put = await fetch(`${be!.origin}/api/v1/projects/${be!.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be!.token}`, origin: be!.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
}

/** Start Play from the editor; the play session id. */
async function play(page: Page): Promise<string> {
  await page.goto(be!.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(async () => (await api(`play/${psid}/observe`)).json['state'], { timeout: 60_000 }).toBe('running');
  return psid;
}

const REFUSER = [
  'export default {',
  '  instantiate() { return { flood: false }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  "    ctx.game.add('ticks', 1);",
  "    if (ctx.emit({ kind: 'control_move', value: 42 }) === false) ctx.game.add('refused_emit', 1);",
  "    if (ctx.game.add('bad-name', 1) === false) ctx.game.add('refused_add', 1);",
  "    for (const _ of ctx.debug.command('flood')) state.flood = true;",
  "    if (state.flood) for (let i = 0; i < 4; i += 1) ctx.log('info', 'flood ' + ctx.stepIndex + ' ' + i + ' ' + '\\u2014'.repeat(240));",
  '  },',
  '};',
  '',
].join('\n');

test('refused script calls answer false and are logged once; a long run\'s diagnostics are trimmed, not refused', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('play-logs-refusals', 'starter');
  const holder = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Refuser' }))['createdId']);
  await publishScript('refuser', REFUSER);
  await cmd('setBehaviorProperties', { entityId: holder, behaviorId: 'refuser', values: {} });
  const psid = await play(page);
  type Obs = { state?: string; counters?: Record<string, number> };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`)).json as Obs;
  // The run goes on: every step's calls were refused and answered false.
  await expect.poll(async () => (await observe()).counters?.['ticks'] ?? 0, { timeout: 30_000 }).toBeGreaterThan(120);
  const c = (await observe()).counters!;
  expect(c['refused_emit']).toBeGreaterThan(100);
  expect(c['refused_add']).toBeGreaterThan(100);
  expect(c['bad-name']).toBeUndefined();
  expect((await observe()).state).toBe('running');

  // The Console shows each refusal once (warnings, at the script's line).
  await openWindow(page, 'Console');
  const consolePanel = page.getByLabel('console', { exact: true });
  const emitLine = consolePanel.locator('li[data-level="warn"]').filter({ hasText: 'ctx.emit refused (behavior_intent_invalid, value)' });
  const addLine = consolePanel.locator('li[data-level="warn"]').filter({ hasText: 'ctx.game.add: counter "bad-name" refused' });
  await expect(emitLine).toHaveCount(1, { timeout: 30_000 });
  await expect(addLine).toHaveCount(1);
  await expect(emitLine.getByLabel('source location')).toHaveText(/^refuser · src\/index\.ts:6:\d+$/);

  // A flood of long lines: the diagnostics come back trimmed (oldest first), with the count of what went.
  const flood = await api(`play/${psid}/control`, { command: 'debugCommand', name: 'flood' });
  expect(flood.status, JSON.stringify(flood.json)).toBe(200);
  type Diag = { status: number; json: { diagnostics?: { runtime?: { errors?: { message: string }[]; state?: string }; trimmed?: { logEntries: number } } } };
  let last: Diag | null = null;
  await expect
    .poll(async () => {
      last = (await api(`play/${psid}/diagnostics`)) as Diag;
      return last.json.diagnostics?.trimmed?.logEntries ?? 0;
    }, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const d = (last as Diag | null)!;
  expect(d.status).toBe(200);
  const errors = d.json.diagnostics!.runtime!.errors!;
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.at(-1)!.message).toMatch(/^flood \d+ 3 /);
  expect(d.json.diagnostics!.runtime!.state).toBe('running');
  await expect(consolePanel.getByTestId('console-dropped')).toContainText(/\d+ older entr(y|ies) left out to fit the report/, { timeout: 30_000 });
  await expect(consolePanel.locator('li[data-level="info"]').filter({ hasText: /^.*flood \d+ \d/ }).first()).toBeVisible();
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
});

const TALKER = [
  'export default {',
  '  step(_s: any, ctx: any) {',
  "    if (ctx.phase === 'intent' && ctx.stepIndex === 30) ctx.dialogue.start('talk');",
  '  },',
  '};',
  '',
].join('\n');

test('a project dialogue document of its own id gets the runner\'s focus: the first option at a choice (Enter picks it), the box after', async ({ page }) => {
  test.setTimeout(240_000);
  be = await startBackend('play-logs-dialogue', 'starter');
  const node = (id: string, type: string, y: number, data?: Record<string, unknown>) => ({ id, type, position: [0, y], ...(data !== undefined ? { data } : {}) });
  const wire = (id: string, from: string, port: string, to: string) => ({ id, from: { node: from, port }, to: { node: to, port: 'in' } });
  await cmd('setDialogue', {
    dialogue: {
      dialogueId: 'talk',
      name: 'Talk',
      graph: {
        nodes: [
          node('start', 'start', 0),
          node('ask', 'line', 100, { text: 'Tea or coffee?' }),
          node('c', 'choice', 200),
          node('tea', 'option', 300, { text: 'Tea' }),
          node('coffee', 'option', 400, { text: 'Coffee' }),
          node('after', 'line', 500, { text: 'Coming up.' }),
        ],
        edges: [wire('w1', 'start', 'next', 'ask'), wire('w2', 'ask', 'next', 'c'), wire('w3', 'c', 'options', 'tea'), wire('w4', 'c', 'options', 'coffee'), wire('w5', 'tea', 'next', 'after'), wire('w6', 'coffee', 'next', 'after')],
      },
    },
  });
  // The project's own box: the engine document's widget ids under another document id, with a
  // focusable button ahead of the options (so a focus the runner did not move would not land on them).
  const ADV = { do: 'dialogue', input: 'advance' };
  await cmd('setUiDocument', {
    document: {
      uiDocumentId: 'talk-box',
      name: 'Talk box',
      layer: 50,
      focus: true,
      actionMap: 'ui',
      initialFocus: 'box',
      root: {
        type: 'panel',
        stretch: 'both',
        children: [
          { id: 'help', type: 'button', anchor: [0, 0], pivot: [0, 0], offset: [10, 10], size: [80, 30], text: 'Help' },
          { id: 'box', type: 'button', anchor: [0.5, 1], pivot: [0.5, 1], offset: [0, -24], size: [800, 120], visible: { bind: 'dialogue.showLine' }, onClick: ADV, children: [{ id: 'text', type: 'text', content: { bind: 'dialogue.line.text' }, reveal: { bind: 'dialogue.line.reveal' } }] },
          { id: 'choices', type: 'list', anchor: [0.5, 1], pivot: [0.5, 1], offset: [0, -160], direction: 'column', gap: 8, visible: { bind: 'dialogue.showChoices' }, items: { bind: 'dialogue.choices' }, template: { id: 'choice', type: 'button', size: [400, null], text: '{$item.text}', onClick: { do: 'dialogue', input: 'choose' } } },
        ],
      },
    },
  });
  await cmd('setDialogueSettings', { settings: { document: 'talk-box', textSpeed: 1000 } });
  const holder = String((await cmd('createEntity', { sceneId: 'scene-main', parentId: null, kind: 'group', name: 'Talker' }))['createdId']);
  await publishScript('talker', TALKER);
  await cmd('setBehaviorProperties', { entityId: holder, behaviorId: 'talker', values: {} });

  const psid = await play(page);
  type Obs = { dialogue?: { running: boolean; kind: string; line: { id: string } | null; choices: string[] } };
  const observe = async (): Promise<Obs> => (await api(`play/${psid}/observe`)).json as Obs;
  const frame = page.frameLocator('iframe.tl-app__preview-frame');
  const doc = frame.locator('[data-tl-ui-doc="talk-box"]');
  await expect(doc).toHaveCount(1, { timeout: 30_000 });
  await page.locator('iframe.tl-app__preview-frame').click({ position: { x: 5, y: 5 } });
  await expect.poll(async () => (await observe()).dialogue?.line?.id ?? null, { timeout: 30_000 }).toBe('ask');
  await expect(doc).toHaveAttribute('data-focus', 'box');
  // Enter advances the line (the box has the focus) to the choice; the focus moves to the first option.
  await expect
    .poll(async () => {
      if ((await observe()).dialogue?.kind !== 'choice') await page.keyboard.press('Enter');
      return (await observe()).dialogue?.kind ?? null;
    }, { timeout: 30_000, intervals: [500] })
    .toBe('choice');
  await expect(doc).toHaveAttribute('data-focus', 'choice', { timeout: 10_000 });
  await expect(doc.locator('[data-widget="choice"].is-focused')).toHaveText('Tea');
  // Enter picks it; the focus goes back to the box for the next line.
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await observe()).dialogue?.line?.id ?? null, { timeout: 30_000 }).toBe('after');
  await expect(doc).toHaveAttribute('data-focus', 'box');
  await page.getByTitle('Stop the play preview').click().catch(() => undefined);
});
