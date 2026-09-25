/**
 * Own commands (fix after 17.4/21.4): an edit made right after the previous
 * one — before that one's WS `mutation.applied` has been handled (a busy main
 * thread runs input first) — used to be sent with the old revision and args
 * built from the old state, and was refused with `revision_conflict`
 * (Inspector preset after a field edit; Game flow subtitle after lives).
 * The client now sends its own commands in order, applies each HTTP ack's
 * change at once and rebases over its own revisions only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionClient } from './client';
import { OwnCommands, mergeDocumentEdit } from './own-commands';

describe('OwnCommands', () => {
  it('rebases over our own revisions only', () => {
    const o = new OwnCommands();
    o.recordOwnRevision(11);
    o.recordOwnRevision(12);
    expect(o.rebase(10, 12)).toBe(12);
    expect(o.rebase(10, 10)).toBe(10);
    // Revision 13 is someone else's: the backend must decide (conflict).
    expect(o.rebase(10, 13)).toBe(10);
    expect(o.rebase(9, 12)).toBe(9);
  });

  it('runs commands one at a time in the order they were made, also after a failure', async () => {
    const o = new OwnCommands();
    const log: string[] = [];
    let release!: () => void;
    const first = o.enqueue(async () => {
      log.push('a start');
      await new Promise<void>((r) => (release = r));
      log.push('a end');
      throw new Error('a failed');
    });
    const second = o.enqueue(async () => {
      log.push('b');
      return 2;
    });
    await Promise.resolve();
    expect(log).toEqual(['a start']);
    release();
    await expect(first).rejects.toThrow('a failed');
    expect(await second).toBe(2);
    expect(log).toEqual(['a start', 'a end', 'b']);
  });
});

describe('mergeDocumentEdit', () => {
  const base = { lives: { start: 3 }, title: {} as Record<string, string>, hud: { preset: 'classic' } };
  it('re-applies only the parts the edit changed onto the current document', () => {
    const next = { ...base, title: { subtitle: 'Two tiny levels' } };
    const current = { ...base, lives: { start: 2 } };
    expect(mergeDocumentEdit(base, next, current)).toEqual({ lives: { start: 2 }, title: { subtitle: 'Two tiny levels' }, hud: { preset: 'classic' } });
  });
  it('is the edit itself when nothing changed in between, and removes a part the edit removed', () => {
    const next = { ...base, lives: { start: 4 } };
    expect(mergeDocumentEdit(base, next, { ...base })).toBe(next);
    const { hud: _h, ...noHud } = base;
    expect(mergeDocumentEdit(base, noHud as typeof base, { ...base, lives: { start: 2 } })).toEqual({ lives: { start: 2 }, title: {} });
    expect(mergeDocumentEdit(base, null, base)).toBeNull();
  });
});

/**
 * A backend stand-in at the HTTP boundary (fetch). Its WS events are never
 * delivered, like a page whose main thread has not got to them yet.
 */
function fakeBackend() {
  const state = { revision: 1, flow: null as Record<string, unknown> | null, box: { color: '#ffffff' } as Record<string, unknown> };
  const sent: { op: string; expectedRevision: number; args: Record<string, unknown> }[] = [];
  const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchStub = vi.fn(async (_url: string, init: { body?: string }) => {
    await new Promise((r) => setTimeout(r, 1));
    const env = JSON.parse(init.body ?? '{}') as { op: string; requestId?: string; expectedRevision?: number; args: Record<string, unknown> };
    if (env.op.startsWith('query')) return reply(200, { ok: true, history: { undoDepth: 0, redoDepth: 0 } });
    sent.push({ op: env.op, expectedRevision: env.expectedRevision ?? -1, args: env.args });
    if (env.expectedRevision !== state.revision) {
      return reply(409, { ok: false, error: { code: 'revision_conflict', expectedRevision: env.expectedRevision, currentRevision: state.revision } });
    }
    let change: Record<string, unknown>;
    if (env.op === 'setFlow') {
      change = { type: 'setFlow', previous: state.flow, next: env.args['flow'] };
      state.flow = env.args['flow'] as Record<string, unknown> | null;
    } else if (env.op === 'setComponent') {
      const previous = { ...state.box };
      state.box = { ...state.box, ...(env.args['value'] as Record<string, unknown>) };
      change = { type: 'setComponent', id: 'crate', component: 'box', previous, next: { ...state.box }, changedFields: Object.keys(env.args['value'] as object) };
    } else throw new Error(`unexpected op ${env.op}`);
    state.revision += 1;
    return reply(200, { ok: true, op: env.op, requestId: env.requestId, revision: state.revision, duplicated: false, change });
  });
  return { state, sent, fetchStub };
}

function makeClient(): SessionClient {
  const c = new SessionClient(
    { projectId: 'p', authoringOrigin: 'http://authoring.test', previewOrigin: 'http://preview.test', authoringToken: 't' },
    { onState: () => undefined, onSceneChanged: () => undefined, onPlayStarted: () => undefined, onPlayStopped: () => undefined },
    'sess-' + '0'.repeat(32),
  );
  c.projection.hydrate({
    revision: 1,
    entities: [{ id: 'crate', name: 'crate', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [1, 1, 1], material: { color: '#ffffff' } } } } as never],
  });
  return c;
}

describe('SessionClient — own commands made before the previous result arrived', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('applies the HTTP ack at once and sends the next edit against the acked revision', async () => {
    const be = fakeBackend();
    vi.stubGlobal('fetch', be.fetchStub);
    const c = makeClient();
    // Two edits in a row, both made while the view is at revision 1 (the first result not yet seen).
    const a = c.command('setComponent', { entityId: 'crate', component: 'box', value: { color: '#ff0000' } }, c.projection.revision);
    const b = c.command('setComponent', { entityId: 'crate', component: 'box', value: { roughness: 0.2 } }, c.projection.revision);
    expect(await a).toMatchObject({ ok: true, revision: 2 });
    expect(await b).toMatchObject({ ok: true, revision: 3 });
    expect(be.sent.map((s) => s.expectedRevision)).toEqual([1, 2]);
    // No WS event was delivered: the projection advanced from the acks.
    expect(c.projection.revision).toBe(3);
    expect(be.state.box).toEqual({ color: '#ff0000', roughness: 0.2 });
  });

  it('a whole-flow edit made on the old flow keeps the edit made just before it', async () => {
    const be = fakeBackend();
    vi.stubGlobal('fetch', be.fetchStub);
    const c = makeClient();
    const f0 = { levels: [{ id: 'level-1' }], lives: { start: 3, max: 9 }, title: {} };
    expect(await c.command('setFlow', { flow: f0 }, c.projection.revision)).toMatchObject({ ok: true });
    expect(c.getFlow()).toEqual(f0);
    // The panel showed f0 for both edits (lives, then subtitle), as the Game flow window does.
    const save = (next: typeof f0) => c.command('setFlow', () => ({ flow: mergeDocumentEdit(f0, next, c.getFlow() as typeof f0 | null) }), c.projection.revision);
    const lives = save({ ...f0, lives: { start: 2, max: 9 } });
    const subtitle = save({ ...f0, title: { subtitle: 'Two tiny levels' } } as typeof f0);
    expect(await lives).toMatchObject({ ok: true });
    expect(await subtitle).toMatchObject({ ok: true });
    expect(be.state.flow).toEqual({ levels: [{ id: 'level-1' }], lives: { start: 2, max: 9 }, title: { subtitle: 'Two tiny levels' } });
  });

  it('does not rebase over someone else\'s revision, nor a whole-document edit built from the old view', async () => {
    const be = fakeBackend();
    vi.stubGlobal('fetch', be.fetchStub);
    const c = makeClient();
    // Someone else (MCP) edited: revision 2 exists, its event has not arrived.
    be.state.revision = 2;
    const r = await c.command('setComponent', { entityId: 'crate', component: 'box', value: { color: '#00ff00' } }, c.projection.revision);
    expect(r).toMatchObject({ ok: false, response: { code: 'revision_conflict' } });

    const be2 = fakeBackend();
    vi.stubGlobal('fetch', be2.fetchStub);
    const c2 = makeClient();
    const first = c2.command('setFlow', { flow: { levels: [], lives: { start: 2, max: 9 } } }, c2.projection.revision);
    // Args fixed at call time (an old view): refused rather than undoing the first edit.
    const stale = c2.command('setFlow', { flow: { levels: [], lives: { start: 3, max: 9 }, title: {} } }, c2.projection.revision);
    expect(await first).toMatchObject({ ok: true });
    expect(await stale).toMatchObject({ ok: false, response: { code: 'revision_conflict' } });
    expect(be2.state.flow).toEqual({ levels: [], lives: { start: 2, max: 9 } });
  });
});
