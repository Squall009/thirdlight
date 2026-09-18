/**
 * The WS channel — sessions.md §4.3/§5.2/§6.1/§7/§8.4 (packet 09):
 * upgrade auth (single-use wsToken), `attached`, heartbeat, frame bounds,
 * the protocol-error tolerance (10/60 s), `mutation.applied` delivery,
 * the caller binding (`session_required`), and the duplicate-retry replay.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  api,
  AUTHORING_ORIGIN,
  connectWs,
  establish,
  mkRequestId,
  mkSessionId,
  sleep,
  startBackend,
  upgrade,
  type TestBackend,
} from './test-helpers';

describe('WS upgrade + session channel (sessions.md §4.3/§5.2)', () => {
  let tb: TestBackend;
  const sid = mkSessionId();
  let est: Awaited<ReturnType<typeof establish>>;

  beforeAll(async () => {
    tb = await startBackend({ timeouts: { silentDropSeconds: 3 } });
    est = await establish(tb, sid);
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('a valid wsToken upgrades; the server sends `attached` { connId, revision }', async () => {
    const ws = await upgrade(tb, sid, est.wsToken);
    try {
      const attached = (await ws.waitFor((m) => (m as { type?: string }).type === 'attached')) as Record<string, unknown>;
      expect(attached.connId).toBe(est.connId);
      expect(attached.revision).toBe(0);
    } finally {
      ws.close();
    }
  });

  it('a replayed wsToken ⇒ close 1008 `ws_token_replayed`', async () => {
    // The token from `est` was consumed by the previous test's upgrade; a
    // fresh establish issues a new token, then both upgrades race:
    const e2 = await establish(tb, sid); // re-attach ⇒ new connId + token
    const ws = await upgrade(tb, sid, e2.wsToken);
    const first = ws.waitFor((m) => (m as { type?: string }).type === 'attached');
    await first;
    const second = await upgrade(tb, sid, e2.wsToken);
    const close = await second.closed;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe('ws_token_replayed');
    ws.close();
  });

  it('an expired wsToken ⇒ close 1008 `ws_token_invalid`', async () => {
    const tb2 = await startBackend({ timeouts: { wsTokenTtlSeconds: 1 } });
    try {
      const s2 = mkSessionId();
      const e = await establish(tb2, s2);
      await sleep(1100);
      const ws = await upgrade(tb2, s2, e.wsToken);
      const close = await ws.closed;
      expect(close.code).toBe(1008);
      expect(close.reason).toBe('ws_token_invalid');
    } finally {
      await tb2.teardown();
    }
  });

  it('a wsToken bound to another session ⇒ close 1008 `session_not_found`', async () => {
    // The token is bound to `sid`; presenting it with a *different* query
    // sessionId ⇒ the token's binding does not match the query.
    const e = await establish(tb, sid);
    const other = mkSessionId();
    const ws = await upgrade(tb, other, e.wsToken);
    const close = await ws.closed;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe('session_not_found');
  });

  it('a re-attach closes the still-open old connection (1000 `detached`)', async () => {
    const e1 = await establish(tb, sid);
    const old = await upgrade(tb, sid, e1.wsToken);
    await old.waitFor((m) => (m as { type?: string }).type === 'attached');
    const e2 = await establish(tb, sid); // re-attach over HTTP
    const fresh = await upgrade(tb, sid, e2.wsToken);
    await fresh.waitFor((m) => (m as { type?: string }).type === 'attached');
    const close = await old.closed;
    expect(close.code).toBe(1000);
    expect(close.reason).toBe('detached');
    fresh.close();
  });

  it('an off-list Origin on the upgrade ⇒ close 1008 `bad_origin`', async () => {
    const e = await establish(tb, sid);
    const ws = await upgrade(tb, sid, e.wsToken, 'http://evil.example');
    const close = await ws.closed;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe('bad_origin');
  });

  it('ping ⇒ pong', async () => {
    const e = await establish(tb, sid);
    const ws = await upgrade(tb, sid, e.wsToken);
    try {
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const pong = ws.waitFor((m) => (m as { type?: string }).type === 'pong');
      ws.send({ type: 'ping' });
      await expect(pong).resolves.toMatchObject({ type: 'pong' });
    } finally {
      ws.close();
    }
  });

  it('a connection silent for the silent-drop window is closed (1000 `heartbeat_timeout`)', async () => {
    const e = await establish(tb, sid);
    const ws = await upgrade(tb, sid, e.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
    const close = await ws.closed;
    expect(close.code).toBe(1000);
    expect(close.reason).toBe('heartbeat_timeout');
  }, 15000);

  it('an unknown event type ⇒ `error` `unknown_event`; the connection survives', async () => {
    const e = await establish(tb, sid);
    const ws = await upgrade(tb, sid, e.wsToken);
    try {
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const err = ws.waitFor((m) => (m as { type?: string }).type === 'error');
      ws.send({ type: 'teleport' });
      await expect(err).resolves.toMatchObject({ type: 'error', code: 'unknown_event' });
      // the connection survives: a ping still gets a pong
      const pong = ws.waitFor((m) => (m as { type?: string }).type === 'pong');
      ws.send({ type: 'ping' });
      await expect(pong).resolves.toMatchObject({ type: 'pong' });
    } finally {
      ws.close();
    }
  });

  it('a malformed frame ⇒ `error` `protocol_error`; the connection survives', async () => {
    const e = await establish(tb, sid);
    const ws = await upgrade(tb, sid, e.wsToken);
    try {
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const err = ws.waitFor((m) => (m as { type?: string }).type === 'error');
      ws.ws.send('not json');
      await expect(err).resolves.toMatchObject({ type: 'error', code: 'protocol_error' });
    } finally {
      ws.close();
    }
  });

  it('10 protocol errors within 60 s ⇒ close 1008 `protocol_error`', async () => {
    const e = await establish(tb, sid);
    const ws = await upgrade(tb, sid, e.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
    for (let i = 0; i < 10; i += 1) {
      ws.ws.send('oops');
    }
    const close = await ws.closed;
    expect(close.code).toBe(1008);
    expect(close.reason).toBe('protocol_error');
  }, 15000);

  it('a frame over 64 KiB (non-screenshot.ack) ⇒ close 1009 `frame_too_big`', async () => {
    const e = await establish(tb, sid);
    const ws = await upgrade(tb, sid, e.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
    const big = JSON.stringify({ type: 'ping', pad: 'x'.repeat(64 * 1024) });
    ws.ws.send(big);
    const close = await ws.closed;
    expect(close.code).toBe(1009);
    expect(close.reason).toBe('frame_too_big');
  });

  it('the server log contains no query strings (the wsToken travel rule)', async () => {
    const all = tb.backend._test.startupLog.map((l) => l.message).join('\n');
    expect(all).not.toMatch(/wsToken=/);
    expect(all).not.toMatch(/wst?_[0-9a-f]{8,}/);
    // no token values from this suite may appear
    expect(all).not.toContain(est.wsToken);
  });
});

describe('commands over HTTP + mutation.applied (§6.1/§6.2/§8.4)', () => {
  let tb: TestBackend;
  const sid = mkSessionId();
  let ws: Awaited<ReturnType<typeof connectWs>>;
  let est: Awaited<ReturnType<typeof establish>>;

  beforeAll(async () => {
    tb = await startBackend();
    est = await establish(tb, sid);
    ws = await upgrade(tb, sid, est.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
  });
  afterAll(async () => {
    ws.close();
    await tb.teardown();
  });

  it('an mcp-origin command applies; the registered browser receives mutation.applied', async () => {
    const requestId = mkRequestId();
    const applied = ws.waitFor((m) => (m as { type?: string }).type === 'mutation.applied');
    const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
      body: {
        op: 'createEntity',
        projectId: 'demo-0001',
        requestId,
        expectedRevision: 0,
        args: { kind: 'box', parentId: null, name: 'box1' },
        origin: { kind: 'mcp', clientId: 'harness' },
      },
      token: tb.authToken,
      origin: null, // a non-browser caller
    });
    expect(r.status).toBe(200);
    const j = r.json as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.revision).toBe(1);
    expect(j.duplicated).toBe(false);
    const ev = (await applied) as Record<string, unknown>;
    expect(ev.requestId).toBe(requestId);
    expect(ev.revision).toBe(1);
    expect(ev.origin).toEqual({ kind: 'mcp', clientId: 'harness' });
    expect(typeof ev.change).toBe('object');
  });

  it('a browser-origin command with no registered session ⇒ 403 session_required', async () => {
    // Use a second project (no session established for it) with an
    // authoring token scoped to it.
    const tb2 = await startBackend({
      tokens: [{ token: 'p2-auth', scope: 'authoring:proj-b2' }],
      projectId: 'proj-b2',
    });
    try {
      const r = await api(`${tb2.authUrl}/api/v1/projects/proj-b2/commands`, {
        body: {
          op: 'queryProject',
          projectId: 'proj-b2',
          requestId: mkRequestId(),
          origin: { kind: 'browser', clientId: 'stray' },
        },
        token: 'p2-auth',
        origin: null,
      });
      expect(r.status).toBe(403);
      expect((r.json as { error: { code: string } }).error.code).toBe('session_required');
    } finally {
      await tb2.teardown();
    }
  });

  it('a duplicate requestId replays the recorded result (duplicated: true)', async () => {
    const requestId = mkRequestId();
    const first = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
      body: {
        op: 'createEntity',
        projectId: 'demo-0001',
        requestId,
        expectedRevision: 1,
        args: { kind: 'box', parentId: null, name: 'box2' },
        origin: { kind: 'mcp', clientId: 'harness' },
      },
      token: tb.authToken,
      origin: null,
    });
    expect(first.status).toBe(200);
    expect((first.json as { revision: number }).revision).toBe(2);
    const second = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
      body: {
        op: 'createEntity',
        projectId: 'demo-0001',
        requestId,
        expectedRevision: 1,
        args: { kind: 'box', parentId: null, name: 'box2' },
        origin: { kind: 'mcp', clientId: 'harness' },
      },
      token: tb.authToken,
      origin: null,
    });
    expect(second.status).toBe(200);
    const j = second.json as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.duplicated).toBe(true);
    expect(j.revision).toBe(2); // the envelope advanced exactly once
    // and no second mutation.applied for this requestId was sent
    const q = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
      body: { op: 'queryEntities', projectId: 'demo-0001', args: { limit: 100, offset: 0 } },
      token: tb.authToken,
      origin: null,
    });
    // the §15 default-scene camera + box1 + box2
    expect((q.json as { total: number }).total).toBe(3);
  });

  it('a query op passes the pipeline result through unchanged', async () => {
    const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
      body: { op: 'queryProject', projectId: 'demo-0001' },
      token: tb.authToken,
      origin: null,
    });
    expect(r.status).toBe(200);
    const j = r.json as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.revision).toBe(2);
    expect(j.manifest).toBeDefined();
    expect(j.workspace).toBeDefined();
  });

  it('a stale expectedRevision ⇒ revision_conflict with currentRevision', async () => {
    const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
      body: {
        op: 'setTransform',
        projectId: 'demo-0001',
        requestId: mkRequestId(),
        expectedRevision: 0,
        args: { entityId: 'cam-main', transform: { position: [0, 0, 0] } },
        origin: { kind: 'mcp', clientId: 'harness' },
      },
      token: tb.authToken,
      origin: null,
    });
    expect(r.status).toBe(409);
    const j = r.json as { error: Record<string, unknown> };
    expect(j.error.code).toBe('revision_conflict');
    expect(j.error.currentRevision).toBe(2);
  });

  it('an invalid envelope op ⇒ 400 invalid_request (the pre-check)', async () => {
    const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
      body: { op: 'nukeEverything', projectId: 'demo-0001', requestId: mkRequestId() },
      token: tb.authToken,
      origin: null,
    });
    expect(r.status).toBe(400);
    expect((r.json as { error: { code: string } }).error.code).toBe('invalid_request');
  });

  it('a malformed body (duplicate JSON key) ⇒ 400 invalid_request', async () => {
    const res = await fetch(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tb.authToken}`,
        'content-type': 'application/json',
        origin: AUTHORING_ORIGIN,
      },
      body: '{"op":"queryProject","op":"queryProject","projectId":"demo-0001"}',
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe('invalid_request');
  });
});