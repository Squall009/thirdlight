/**
 * `SessionClient.grouped`: one user action's commands become one undo step,
 * and only that action's — a command the client sends meanwhile through
 * itself (an Inspector edit while a slow model uploads) is left out, since
 * one undo would otherwise take both.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionClient } from './client';

function fakeBackend(refuse: ReadonlySet<string> = new Set()) {
  let revision = 1;
  const stored: string[] = [];
  const groups: { requestIds: string[]; origin: unknown }[] = [];
  /** Every request in the order the backend took it (a command's tag or op, `group`). */
  const log: string[] = [];
  const reply = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchStub = vi.fn(async (url: string, init: { body?: string }) => {
    await new Promise((r) => setTimeout(r, 1));
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    if (url.endsWith('/history/group')) {
      // The join is slower than a command here, as when the backend is busy: an undo sent meanwhile would overtake it.
      await new Promise((r) => setTimeout(r, 20));
      groups.push(body as { requestIds: string[]; origin: unknown });
      log.push('group');
      return reply(200, { ok: true, grouped: (body['requestIds'] as unknown[]).length });
    }
    const env = body as { op: string; requestId: string; expectedRevision: number; args: { value?: { tag?: string } } };
    const tag = env.args.value?.tag ?? env.op;
    if (refuse.has(tag)) return reply(400, { ok: false, error: { code: 'invalid_args', cls: 'validation', message: 'no' } });
    // As the backend: an undo or redo against a revision that is not the latest is refused.
    if ((env.op === 'undo' || env.op === 'redo') && env.expectedRevision !== revision) {
      log.push(`${env.op} refused`);
      return reply(409, { ok: false, error: { code: 'revision_conflict', cls: 'conflict', message: 'stale' } });
    }
    revision += 1;
    stored.push(tag);
    log.push(tag);
    return reply(200, { ok: true, op: env.op, requestId: env.requestId, revision, duplicated: false, change: null });
  });
  /** Another client's command stored now. */
  const foreign = (tag: string): void => {
    revision += 1;
    stored.push(tag);
    log.push(tag);
  };
  return { fetchStub, groups, stored, log, foreign, revision: () => revision };
}

function makeClient(): SessionClient {
  const c = new SessionClient(
    { projectId: 'p', authoringOrigin: 'http://authoring.test', previewOrigin: 'http://preview.test', authoringToken: 't' },
    { onState: () => undefined, onSceneChanged: () => undefined, onPlayStarted: () => undefined, onPlayStopped: () => undefined },
    'sess-' + '0'.repeat(32),
  );
  c.projection.hydrate({ revision: 1, entities: [] });
  return c;
}

const edit = (c: SessionClient, tag: string) => c.setComponent('e', 'tag', { tag }, c.projection.revision);

describe('SessionClient.grouped', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('groups only the commands sent through the scope (methods called on it included), with the caller as origin', async () => {
    const be = fakeBackend();
    vi.stubGlobal('fetch', be.fetchStub);
    const c = makeClient();
    const sentIds: string[] = [];
    const spy = vi.spyOn(SessionClient.prototype, 'command');
    await c.grouped(async (g) => {
      await edit(g, 'a');
      // Someone edits in the Inspector while the action waits (a slow upload).
      await edit(c, 'inspector');
      await g.command('setComponent', { entityId: 'e', component: 'tag', value: { tag: 'b' } }, g.projection.revision);
    });
    for (const call of spy.mock.calls) if (typeof call[3] === 'string') sentIds.push(call[3]);
    spy.mockRestore();
    expect(be.stored).toEqual(['a', 'inspector', 'b']);
    expect(be.groups).toHaveLength(1);
    expect(be.groups[0]!.requestIds).toHaveLength(2);
    expect(be.groups[0]!.origin).toEqual({ kind: 'browser', clientId: 'sess-' + '0'.repeat(32) });
    // The ids are the scoped commands' own, in order (the Inspector's went without one picked by the scope).
    expect(sentIds).toEqual(be.groups[0]!.requestIds);
  });

  it('a nested action joins through the scope; a refused command is not grouped; one stored command needs no group', async () => {
    const be = fakeBackend(new Set(['refused']));
    vi.stubGlobal('fetch', be.fetchStub);
    const c = makeClient();
    await c.grouped(async (g) => {
      await edit(g, 'a');
      await edit(g, 'refused');
      await g.grouped(async (inner) => edit(inner, 'b'));
    });
    expect(be.groups.map((x) => x.requestIds.length)).toEqual([2]);
    await c.grouped(async (g) => edit(g, 'alone'));
    expect(be.groups).toHaveLength(1);
  });

  it('two actions at once are two steps', async () => {
    const be = fakeBackend();
    vi.stubGlobal('fetch', be.fetchStub);
    const c = makeClient();
    await Promise.all([
      c.grouped(async (g) => {
        await edit(g, 'a1');
        await edit(g, 'a2');
      }),
      c.grouped(async (g) => {
        await edit(g, 'b1');
        await edit(g, 'b2');
      }),
    ]);
    expect(be.groups).toHaveLength(2);
    const all = be.groups.flatMap((x) => x.requestIds);
    expect(new Set(all).size).toBe(4);
  });

  it('an undo asked while an action is still being made one step waits for it, so it takes back the whole action', async () => {
    const be = fakeBackend();
    vi.stubGlobal('fetch', be.fetchStub);
    const c = makeClient();
    let lastStored: () => void = () => undefined;
    const stored = new Promise<void>((r) => (lastStored = r));
    const action = c.grouped(async (g) => {
      await edit(g, 'a');
      await edit(g, 'b');
      lastStored();
    });
    // The action's last command is stored; the request joining its commands is not sent yet.
    await stored;
    // Pressed on the view the user sees: the action's stored commands in it.
    const undo = c.command('undo', {}, be.revision());
    await Promise.all([action, undo]);
    expect(be.log).toEqual(['a', 'b', 'group', 'undo']);
  });

  it('that undo is still checked against what the user saw: another client\'s command meanwhile makes it refused, not undone', async () => {
    const be = fakeBackend();
    vi.stubGlobal('fetch', be.fetchStub);
    const c = makeClient();
    let lastStored: () => void = () => undefined;
    const stored = new Promise<void>((r) => (lastStored = r));
    const action = c.grouped(async (g) => {
      await edit(g, 'a');
      await edit(g, 'b');
      lastStored();
    });
    await stored;
    // Pressed on the view the user sees: the action's stored commands in it.
    const undo = c.command('undo', {}, be.revision());
    // An MCP client stores a command while the action is being made one step.
    be.foreign('mcp');
    await action;
    const r = await undo;
    expect(r.ok).toBe(false);
    expect(be.log).toEqual(['a', 'b', 'mcp', 'group', 'undo refused']);
  });
});
