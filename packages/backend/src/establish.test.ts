/**
 * POST /sessions + session listing/log + admin operations —
 * sessions.md §5.1/§6.3/§11.4 (packet 09 acceptance, m1-acceptance §2.2).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, AUTHORING_ORIGIN, establish, mkSessionId, sleep, startBackend, upgrade, type TestBackend, type TestWs } from './test-helpers';

describe('establish / re-attach (sessions.md §5.1)', () => {
  let tb: TestBackend;
  const sid1 = mkSessionId();
  const sid2 = mkSessionId();
  let connId1 = '';
  let wsToken1 = '';
  let established: Record<string, unknown> | undefined;
  let liveWs: TestWs | undefined;

  beforeAll(async () => {
    tb = await startBackend();
  });
  afterAll(async () => {
    liveWs?.close();
    await tb.teardown();
  });

  it('admin createProject ⇒ 201; second create ⇒ 200 created:false', async () => {
    const r1 = await api(`${tb.authUrl}/api/v1/admin/projects`, {
      body: { projectId: 'demo-0002', name: 'Second' },
      token: tb.adminToken,
      origin: null,
    });
    expect(r1.status).toBe(201);
    expect((r1.json as { ok: boolean; created: boolean }).ok).toBe(true);
    const r2 = await api(`${tb.authUrl}/api/v1/admin/projects`, {
      body: { projectId: 'demo-0002', name: 'Second' },
      token: tb.adminToken,
      origin: null,
    });
    expect(r2.status).toBe(200);
    expect((r2.json as { created: boolean }).created).toBe(false);
  });

  it('admin routes reject non-admin tokens (401)', async () => {
    const r = await api(`${tb.authUrl}/api/v1/admin/projects`, {
      body: { projectId: 'demo-0003', name: 'X' },
      token: tb.authToken,
      origin: null,
    });
    expect(r.status).toBe(401);
    expect((r.json as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('new session ⇒ 200 with full state (revision 0, the §15 default scene)', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'demo-0001', sessionId: sid1, clientInfo: { kind: 'browser', label: 't1' } },
      token: tb.authToken,
    });
    expect(r.status).toBe(200);
    const j = r.json as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.sessionId).toBe(sid1);
    expect(j.connId).toMatch(/^conn-[0-9a-f]{32}$/);
    expect(j.wsToken).toMatch(/^[0-9a-f]{64}$/);
    expect(j.revision).toBe(0);
    const scene = j.scene as Record<string, unknown>;
    // C35-5 / CC-48-3 (promoted at Gate L): the scene projection reports the
    // scene document's schemaVersion (1 for the M1 default scene).
    expect(scene.schemaVersion).toBe(1);
    // A fresh project is the project-model §15 default scene: one camera entity.
    const ents = scene.entities as Array<Record<string, unknown>>;
    expect(ents.length).toBe(1);
    expect(ents[0]?.id).toBe('cam-main');
    expect(scene.revision).toBe(0);
    expect((j.workspace as Record<string, unknown>).writePaused).toBe(false);
    connId1 = j.connId as string;
    wsToken1 = j.wsToken as string;
    established = j;
  });

  it('re-attach (same sessionId) ⇒ 200 with a fresh connId + wsToken', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'demo-0001', sessionId: sid1 },
      token: tb.authToken,
    });
    expect(r.status).toBe(200);
    const j = r.json as Record<string, unknown>;
    expect(j.sessionId).toBe(sid1);
    expect(j.connId).not.toBe(connId1);
    expect(j.wsToken).not.toBe(wsToken1);
    connId1 = j.connId as string;
    wsToken1 = j.wsToken as string;
  });

  it('a different sessionId while the session is connected ⇒ 409 session_conflict', async () => {
    liveWs = await upgrade(tb, sid1, wsToken1);
    await liveWs.waitFor((m) => (m as { type?: string }).type === 'attached');
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'demo-0001', sessionId: sid2 },
      token: tb.authToken,
    });
    expect(r.status).toBe(409);
    const j = r.json as { error: Record<string, unknown> };
    expect(j.error.code).toBe('session_conflict');
    expect(j.error.cls).toBe('conflict');
    expect(j.error.activeSessionId).toBe(sid1);
    expect(typeof j.error.lastActivityAt).toBe('number');
  });

  it('project missing ⇒ 404 project_not_found', async () => {
    // An authoring token scoped to a project that was never created.
    const tb2 = await startBackend({
      tokens: [{ token: 'ghost-auth', scope: 'authoring:ghost-9999' }],
    });
    try {
      const r = await api(`${tb2.authUrl}/api/v1/sessions`, {
        body: { projectId: 'ghost-9999', sessionId: mkSessionId() },
        token: 'ghost-auth',
      });
      expect(r.status).toBe(404);
      expect((r.json as { error: { code: string } }).error.code).toBe('project_not_found');
    } finally {
      await tb2.teardown();
    }
  });

  it('no token ⇒ 401 unauthorized', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'demo-0001', sessionId: mkSessionId() },
      token: undefined,
      origin: null,
    });
    expect(r.status).toBe(401);
    expect((r.json as { error: { code: string } }).error.code).toBe('unauthorized');
  });

  it('admin token cannot establish a session', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'demo-0001', sessionId: mkSessionId() },
      token: tb.adminToken,
      origin: null,
    });
    expect(r.status).toBe(401);
  });

  it('strict body: unknown field ⇒ 400', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'demo-0001', sessionId: mkSessionId(), bogus: true },
      token: tb.authToken,
    });
    expect(r.status).toBe(400);
    const j = r.json as { error: Record<string, unknown> };
    expect(j.error.code).toBe('field_unexpected');
  });

  it('invalid sessionId syntax ⇒ 400', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'demo-0001', sessionId: 'nope' },
      token: tb.authToken,
    });
    expect(r.status).toBe(400);
  });

  it('Origin allowlist: an off-list Origin ⇒ 403 bad_origin with `found`', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'demo-0001', sessionId: mkSessionId() },
      token: tb.authToken,
      origin: 'http://evil.example',
    });
    expect(r.status).toBe(403);
    const j = r.json as { error: Record<string, unknown> };
    expect(j.error.code).toBe('bad_origin');
    expect(j.error.found).toBe('http://evil.example');
  });

  it('GET /sessions?projectId ⇒ the session (bounded listing)', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions?projectId=demo-0001`, {
      method: 'GET',
      token: tb.authToken,
    });
    expect(r.status).toBe(200);
    const j = r.json as { ok: boolean; sessions: Array<Record<string, unknown>> };
    expect(j.ok).toBe(true);
    expect(j.sessions.length).toBe(1);
    expect(j.sessions[0]?.sessionId).toBe(sid1);
    expect(j.sessions[0]?.connId).toBe(connId1);
    expect(j.sessions[0]?.connected).toBe(true); // the WS attached above
  });

  it('GET /sessions/:sid/log ⇒ entries (default limit 32; bounds enforced)', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions/${sid1}/log`, { method: 'GET', token: tb.authToken });
    expect(r.status).toBe(200);
    const j = r.json as { ok: boolean; total: number; entries: unknown[] };
    expect(j.ok).toBe(true);
    expect(j.entries.length).toBeGreaterThan(0);
    expect(j.entries.length).toBeLessThanOrEqual(32);
    const bad = await api(`${tb.authUrl}/api/v1/sessions/${sid1}/log?limit=999`, { method: 'GET', token: tb.authToken });
    expect(bad.status).toBe(400);
    const missing = await api(`${tb.authUrl}/api/v1/sessions/${sid2}/log`, { method: 'GET', token: tb.authToken });
    expect(missing.status).toBe(404);
    expect((missing.json as { error: { code: string } }).error.code).toBe('session_not_found');
  });
});

describe('session lifecycle bookkeeping (§5.1/§11.1)', () => {
  it('the session log ring is bounded (128) and records registered/detached', async () => {
    const tb = await startBackend();
    try {
      const sid = mkSessionId();
      const r = await api(`${tb.authUrl}/api/v1/sessions`, {
        body: { projectId: 'demo-0001', sessionId: sid },
        token: tb.authToken,
      });
      expect(r.status).toBe(200);
      const log = await api(`${tb.authUrl}/api/v1/sessions/${sid}/log?limit=128`, { method: 'GET', token: tb.authToken });
      const j = log.json as { entries: Array<{ kind: string }> };
      const kinds = j.entries.map((e) => e.kind);
      expect(kinds).toContain('registered');
      // ring bound
      const rec = tb.backend._test.sessions.sessionForSessionId(sid)!;
      for (let i = 0; i < 200; i += 1) {
        tb.backend._test.sessions.record(rec, 'command', `req-${i}`, undefined, Date.now());
      }
      expect(rec.log.length).toBe(128);
    } finally {
      await tb.teardown();
    }
  });
});
describe('admin operator operations (sessions.md §6.3; workspace.md §11)', () => {
  let tb: TestBackend;
  beforeAll(async () => {
    tb = await startBackend();
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('accept-external / discard-external with no pending change ⇒ 400 no_pending_change (structured)', async () => {
    const a = await api(`${tb.authUrl}/api/v1/admin/projects/demo-0001/accept-external`, {
      body: {},
      token: tb.adminToken,
    });
    expect(a.status).toBe(400);
    expect((a.json as { error: { code: string } }).error.code).toBe('no_pending_change');
    const d = await api(`${tb.authUrl}/api/v1/admin/projects/demo-0001/discard-external`, {
      body: {},
      token: tb.adminToken,
    });
    expect(d.status).toBe(400);
    expect((d.json as { error: { code: string } }).error.code).toBe('no_pending_change');
  });

  it('accept-external on an unknown project ⇒ 404 project_not_found', async () => {
    const a = await api(`${tb.authUrl}/api/v1/admin/projects/ghost-0001/accept-external`, {
      body: {},
      token: tb.adminToken,
    });
    expect(a.status).toBe(404);
    expect((a.json as { error: { code: string } }).error.code).toBe('project_not_found');
  });

  it('release then takeover on a fresh project ⇒ structured ok results', async () => {
    // A fresh project so the release/takeover cycle does not disturb demo-0001.
    const created = await api(`${tb.authUrl}/api/v1/admin/projects`, {
      body: { projectId: 'op-proj', name: 'Op' },
      token: tb.adminToken,
    });
    expect(created.status).toBe(201);
    const rel = await api(`${tb.authUrl}/api/v1/admin/projects/op-proj/release`, {
      body: {},
      token: tb.adminToken,
    });
    expect(rel.status).toBe(200);
    const relJ = rel.json as { ok: boolean; revision: number; retryCleared: boolean };
    expect(relJ.ok).toBe(true);
    expect(relJ.retryCleared).toBe(true);
    // After release the project is workspace_closed: a second release ⇒ 503.
    const rel2 = await api(`${tb.authUrl}/api/v1/admin/projects/op-proj/release`, {
      body: {},
      token: tb.adminToken,
    });
    expect(rel2.status).toBe(503);
    const rel2J = rel2.json as { error: { code: string; reason?: string } };
    expect(rel2J.error.code).toBe('project_unavailable');
    expect(rel2J.error.reason).toBe('workspace_closed');
    const take = await api(`${tb.authUrl}/api/v1/admin/projects/op-proj/takeover`, {
      body: {},
      token: tb.adminToken,
    });
    expect(take.status).toBe(200);
    const takeJ = take.json as { ok: boolean; lockEpoch: number; pid: number };
    expect(takeJ.ok).toBe(true);
    expect(typeof takeJ.lockEpoch).toBe('number');
    expect(typeof takeJ.pid).toBe('number');
  });

  it('a non-admin token on an operator op ⇒ 401 (admin scope enforced)', async () => {
    const r = await api(`${tb.authUrl}/api/v1/admin/projects/demo-0001/release`, {
      body: {},
      token: tb.authToken, // authoring scope, not admin
    });
    expect(r.status).toBe(401);
  });
});

describe('a closed tab does not lock the project (sessions supersede when disconnected)', () => {
  let tb: TestBackend;
  beforeAll(async () => {
    tb = await startBackend();
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('a new sessionId supersedes a disconnected session', async () => {
    const a = await establish(tb, mkSessionId());
    const ws = await upgrade(tb, a.sessionId, a.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
    ws.close();
    await ws.closed;
    await sleep(50);

    const b = await establish(tb, mkSessionId());
    expect(b.status).toBe(200);
    expect(b.sessionId).not.toBe(a.sessionId);

    const listed = await api(`${tb.authUrl}/api/v1/sessions?projectId=demo-0001`, { method: 'GET', token: tb.authToken });
    const sessions = (listed.json as { sessions?: Array<{ sessionId: string }> }).sessions ?? [];
    expect(sessions.map((s) => s.sessionId)).toEqual([b.sessionId]);
  });
});
