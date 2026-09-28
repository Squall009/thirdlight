/**
 * Phase 25.5 (TL-17, E26), against a real backend and the real Play page on
 * the Starter template:
 *
 * - A script sees a timeline's `ended` event in Play (the simulation worker):
 *   a timeline that plays when the run starts, one the script plays and one it
 *   skips; the script counts `ctx.timeline.ended(handle)`, the `ended` events
 *   by reason and `state(handle) === 'ended'`; the counters are read through
 *   the play's observe route.
 * - A play that ends before it is presented records why: the preview's
 *   content is held back, so it never presents, and the editor page reloads.
 *   Observe and diagnostics on that play answer `play_not_found` with
 *   `ended {reason: session_lost, presented: false}` and a message saying the
 *   editor page closed, reloaded or lost its connection; the project's
 *   problems list it too.
 */
import { createHash, randomBytes } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { startBackend, type E2EBackend } from './backend';

let be: E2EBackend;
test.beforeEach(async () => {
  be = await startBackend('play-end-e2e', 'starter');
});
test.afterEach(async () => {
  await be.stop();
});

async function api(path: string, body: unknown, method = 'POST'): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/${path}`, {
    method,
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}
async function query(op: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return be.command({ op, projectId: be.projectId, args });
}
async function cmd(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await be.command({ op, projectId: be.projectId, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}`, origin: { kind: 'mcp', clientId: 'e2e-play-end' }, args });
  expect(res.ok, `${op}: ${JSON.stringify(res)}`).toBe(true);
  return res;
}
async function script(behaviorId: string, source: string, entityId: string): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify({ graphVersion: 1, entryPath: 'src/index.ts', requiredModules: ['@thirdlight/runtime'], ownedTransforms: [], files: [{ path: 'src/index.ts', text: source }] }, null, 2)}\n`);
  const stageId = String((await api('content/stages', {})).json.stageId);
  const put = await fetch(`${be.origin}/api/v1/projects/${be.projectId}/content/stages/${stageId}/bytes`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${be.token}`, origin: be.origin, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
    body: bytes,
  });
  expect(put.status).toBe(200);
  const declaration = { properties: [] };
  await cmd('publishBehavior', { behaviorId, displayName: behaviorId, mode: 'declaration-create', declaration });
  await cmd('acknowledgeBehaviorTrust', { sourceDigest: createHash('sha256').update(bytes).digest('hex') });
  const published = await api('content/behaviors/source', { stageId, behaviorId, displayName: behaviorId, declaration, expectedRevision: Number((await query('queryProject')).revision), requestId: `req-${randomBytes(16).toString('hex')}` });
  expect(published.status, JSON.stringify(published.json)).toBe(200);
  await cmd('setBehaviorProperties', { entityId, behaviorId, values: {} });
}

const WATCHER = [
  'export default {',
  '  prepare() { return {}; },',
  '  instantiate() { return { h: 0, k: 0, seen: 0 }; },',
  '  step(state: any, ctx: any) {',
  "    if (ctx.phase !== 'intent') return;",
  '    const tl = ctx.timeline;',
  "    if (ctx.stepIndex === 60) state.h = tl.play('cut');",
  "    if (ctx.stepIndex === 200) state.k = tl.play('cut');",
  '    if (ctx.stepIndex === 210) tl.skip(state.k);',
  "    if (state.h > 0 && tl.ended(state.h)) ctx.game.add('cutEnded', 1);",
  "    if (state.k > 0 && tl.ended(state.k)) ctx.game.add('skipEnded', 1);",
  "    if (state.h > 0 && state.seen === 0 && tl.state(state.h) === 'ended') { state.seen = 1; ctx.game.add('cutState', 1); }",
  "    for (const e of tl.events()) if (e.kind === 'ended') ctx.game.add(e.timeline + '_' + e.reason, 1);",
  '  },',
  '  dispose() {},',
  '};',
  '',
].join('\n');

test('a script sees a timeline ended event in Play (the simulation worker)', async ({ page }) => {
  test.setTimeout(180_000);
  await cmd('setTimeline', { timeline: { timelineId: 'intro', name: 'Intro', duration: 0.5, playOnStart: true, tracks: [{ trackId: 'bars', type: 'letterbox', keys: [{ time: 0, value: 0.1 }] }] } });
  await cmd('setTimeline', { timeline: { timelineId: 'cut', name: 'Cut', duration: 0.5, tracks: [{ trackId: 'bars', type: 'letterbox', keys: [{ time: 0, value: 0.2 }] }] } });
  const holder = String((await cmd('createEntity', { parentId: null, kind: 'group', name: 'Watcher', transform: { position: [0, -5, 0] } }))['createdId']);
  await script('watcher', WATCHER, holder);

  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  const observe = async (): Promise<{ state?: string; stepIndex?: number; counters?: Record<string, number>; simulation?: { mode?: string } }> => (await api(`play/${psid}/observe`, {})).json as never;
  await expect.poll(async () => (await observe()).state, { timeout: 60_000 }).toBe('running');
  await expect.poll(async () => (await observe()).stepIndex ?? 0, { timeout: 30_000 }).toBeGreaterThan(400);
  const o = await observe();
  expect(o.simulation?.mode).toBe('worker');
  expect(o.counters).toMatchObject({ intro_finished: 1, cut_finished: 1, cut_skipped: 1, cutEnded: 1, skipEnded: 1, cutState: 1 });
  await page.getByTitle('Stop the play preview').click();
});

test('a play that ends before it is presented says why in observe, diagnostics and the problems', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(be.editorUrl);
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  // The preview's content is held back: the play is never presented.
  let held = 0;
  await page.route('**/play-content/**', async () => {
    held += 1;
    await new Promise(() => undefined);
  });
  const started = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/play'));
  await page.getByTitle('Start an isolated play preview').click();
  const psid = String(((await (await started).json()) as { playSessionId: string }).playSessionId);
  await expect.poll(() => held, { timeout: 30_000 }).toBeGreaterThan(0);
  const before = await api(`play/${psid}/observe`, {});
  expect(before.status, JSON.stringify(before.json)).toBe(503); // live, not yet presented
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.reload();
  await expect(page.locator('.tl-statusbar')).toContainText('connected');
  for (const route of ['observe', 'diagnostics']) {
    const res = await api(`play/${psid}/${route}`, {});
    expect(res.status, route).toBe(404);
    const error = res.json.error as { code: string; message: string; ended?: { reason: string; presented: boolean; at: string } };
    expect(error.code).toBe('play_not_found');
    expect(error.ended).toMatchObject({ reason: 'session_lost', presented: false });
    expect(error.message).toContain('the play ended before it was presented');
    expect(error.message).toContain('the editor page that ran it closed, reloaded or lost its connection');
  }
  const problems = (await api('problems', undefined, 'GET')).json.problems as Array<{ source: string; code: string; message: string }>;
  expect(problems.some((p) => p.source === 'play' && p.code === 'play_session_lost' && p.message.includes(psid))).toBe(true);
});
