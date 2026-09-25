/**
 * Phase 19.2: Play runs a visual script as a debug build, an export never
 * does (real backend, real compiler, real filesystem).
 *
 * - A published visual script: the Play build's behavior artifact (served on
 *   the preview origin's play-content locator) is the debug build — it
 *   records the trace, wire values and locals and answers `debug(state)`.
 * - The export of the same project carries the ordinary module: byte for
 *   byte the published output (its recorded outputDigest), with none of the
 *   debug hooks.
 * - After an unpublished graph edit Play runs the ordinary published module
 *   (the stored graph no longer generates the published source, so its nodes
 *   would not be the ones running).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, establish, mkRequestId, mkSessionId, startBackend, upgrade, type TestBackend, type TestWs } from './test-helpers';

const REPO_ROOT = new URL('.', import.meta.url).pathname.slice(0, new URL('.', import.meta.url).pathname.lastIndexOf('/packages/'));
const P = 'demo-0001';
/** Text only a Play debug build contains (its helpers and its debug export). */
const DEBUG_MARKS = ['DBG_TRACE', 'dropped: s.db.x'];

let tb: TestBackend;
let exportRoot: string;
let ws: TestWs;
beforeAll(async () => {
  exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-vs-debug-'));
  tb = await startBackend({ exportRoot, engineRoot: REPO_ROOT });
  // Play needs a connected browser session (it presents the preview).
  const sid = mkSessionId();
  const est = await establish(tb, sid);
  ws = await upgrade(tb, sid, est.wsToken);
  await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
}, 60_000);
afterAll(async () => {
  ws?.close();
  await tb?.teardown();
  if (exportRoot !== undefined) rmSync(exportRoot, { recursive: true, force: true });
}, 60_000);

async function revision(): Promise<number> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, { body: { op: 'queryProject', projectId: P, args: {} }, token: tb.authToken, origin: null });
  return Number((r.json as { revision: number }).revision);
}
async function command(op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, {
    body: { op, projectId: P, requestId: mkRequestId(), expectedRevision: await revision(), args, origin: { kind: 'mcp', clientId: 'vs-debug-test' } },
    token: tb.authToken,
    origin: null,
  });
  expect((r.json as { ok?: boolean }).ok, JSON.stringify(r.json)).toBe(true);
  return r.json as Record<string, unknown>;
}
async function source(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/content/behaviors/source`, { body, token: tb.authToken, origin: null });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json as Record<string, unknown>;
}
async function record(id: string): Promise<{ source: { sourceDigest: string; outputDigest: string } }> {
  const r = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, { body: { op: 'queryBehaviors', projectId: P, args: { behaviorId: id, includeDeclaration: true } }, token: tb.authToken, origin: null });
  return ((r.json as { behaviors: unknown[] }).behaviors[0] as never);
}

/** Start a Play; the behavior artifacts its manifest declares (behaviorId → module text, output digest). */
async function playBehaviors(): Promise<Map<string, { text: string; outputDigest: string }>> {
  const start = await api(`${tb.authUrl}/api/v1/projects/${P}/play`, { body: {}, token: tb.authToken });
  expect(start.status, JSON.stringify(start.json)).toBe(200);
  const j = start.json as { playSessionId: string; playContent: { path: string } };
  const base = `${tb.prevUrl}${j.playContent.path}`;
  const manifest = (await (await fetch(`${base}manifest.json`)).json()) as { behaviors: { behaviorId: string; path: string; outputDigest: string }[] };
  const out = new Map<string, { text: string; outputDigest: string }>();
  for (const b of manifest.behaviors) {
    const res = await fetch(`${base}${b.path}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(createHash('sha256').update(text).digest('hex')).toBe(b.outputDigest);
    out.set(b.behaviorId, { text, outputDigest: b.outputDigest });
  }
  const stop = await api(`${tb.authUrl}/api/v1/projects/${P}/play/${j.playSessionId}/stop`, { body: {}, token: tb.authToken });
  expect(stop.status).toBeLessThan(600);
  return out;
}

const GRAPH = {
  nodes: [
    { id: 'tick', type: 'event.step', position: [0, 0] },
    { id: 'add', type: 'api.game.add', position: [240, 0], data: { name: 'ticks' } },
  ],
  edges: [{ id: 'w1', from: { node: 'tick', port: 'then' }, to: { node: 'add', port: 'in' } }],
};

describe('phase 19.2: Play debug builds of visual scripts, never in exports', () => {
  it('Play serves the debug build; the export carries the published module without debug hooks; unpublished edits play the published module', async () => {
    await command('publishBehavior', { behaviorId: 'ticker', displayName: 'Ticker', mode: 'declaration-create', declaration: { properties: [] }, graph: GRAPH });
    const box = await command('createEntity', { kind: 'box', name: 'Ticker box' });
    await command('setBehaviorProperties', { entityId: String(box['createdId']), behaviorId: 'ticker', values: {} });
    const checked = await source({ check: true, graph: true, behaviorId: 'ticker' });
    const digest = String(checked['sourceDigest']);
    await command('acknowledgeBehaviorTrust', { sourceDigest: digest });
    await source({ graph: true, behaviorId: 'ticker', displayName: 'Ticker', expectedRevision: await revision(), requestId: mkRequestId() });
    const published = (await record('ticker')).source;
    expect(published.sourceDigest).toBe(digest);

    // Play: the debug build (a different module from the same trusted source).
    const play = (await playBehaviors()).get('ticker')!;
    for (const mark of DEBUG_MARKS) expect(play.text, mark).toContain(mark);
    expect(play.outputDigest).not.toBe(published.outputDigest);

    // Export: the ordinary module, byte for byte the published output.
    const res = await fetch(`${tb.authUrl}/api/v1/admin/projects/${P}/export`, { method: 'POST', headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { outputDir: string };
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const full = join(d, e);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(join(exportRoot, out.outputDir));
    const behaviorFiles = files.filter((f) => /behaviors[\\/][0-9a-f]{64}\.js$/.test(f));
    expect(behaviorFiles.map((f) => f.slice(-67, -3))).toEqual([published.outputDigest]);
    // No debug hook anywhere in the exported game (its behaviors, its bundle, its manifest).
    for (const f of files.filter((x) => /\.(js|json|html)$/.test(x))) {
      const text = readFileSync(f, 'utf8');
      for (const mark of DEBUG_MARKS) expect(text.includes(mark), `${f} contains ${mark}`).toBe(false);
    }

    // An unpublished edit: Play runs the published module as it is (no debug build of a graph that is not what runs).
    await command('graphEdit', { owner: { kind: 'behavior', id: 'ticker' }, ops: [{ op: 'setNodeData', id: 'add', data: { name: 'ticks2' } }] });
    const edited = (await playBehaviors()).get('ticker')!;
    expect(edited.outputDigest).toBe(published.outputDigest);
    for (const mark of DEBUG_MARKS) expect(edited.text.includes(mark)).toBe(false);
  }, 240_000);
});
