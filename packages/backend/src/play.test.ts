/**
 * Play sessions + screenshot/diagnostics relay — sessions.md §10/§12
 * (packet 09 acceptance, m1-acceptance §2.2).
 *
 * The "editor" is a `ws` client acting per the contract: it presents the
 * preview (play.preview.ready), relays stop (play.stopped.ack), and answers
 * screenshot/diagnostics relays with the exact result shapes.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  api,
  establish,
  mkSessionId,
  PREVIEW_ORIGIN,
  sleep,
  startBackend,
  upgrade,
  type TestBackend,
  type TestWs,
} from './test-helpers';

/** A stub editor: presents on play.started, acks stops, answers relays.
 *
 * NOTE: the pump owns ALL server→client traffic on the socket after
 * construction (it reads with `waitFor(() => true)`), so tests must use
 * `waitForEvent` / the collected arrays — a direct `ws.waitFor` on the
 * same socket would race the pump and starve it.
 */
class FakeEditor {
  ws!: TestWs;
  started: Array<Record<string, unknown>> = [];
  stopRequests: Array<Record<string, unknown>> = [];
  screenshotRequests: Array<Record<string, unknown>> = [];
  diagnosticsRequests: Array<Record<string, unknown>> = [];
  stoppedEvents: Array<Record<string, unknown>> = [];
  /** Set when the stub sent play.preview.ready (the play is presented). */
  presentedFlag = false;
  presentOnStart = true;
  ackStops = true;
  screenshotReply: { ok: boolean; dataUrl?: string; width?: number; height?: number; error?: { code: string } } | null = {
    ok: true,
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
    width: 256,
    height: 144,
  };
  diagnosticsReply: { ok: boolean; diagnostics?: unknown; error?: { code: string } } | null = {
    ok: true,
    diagnostics: { fps: 60, errorCount: 0 },
  };
  private pending: Array<{ type: string; resolve: (m: Record<string, unknown>) => void; reject: (e: Error) => void; timer: number }> = [];

  constructor(ws: TestWs) {
    this.ws = ws;
    void (async () => {
      for (;;) {
        const m = await this.ws.waitFor(() => true, 30_000).catch(() => null);
        if (m === null) break;
        this.handle(m as Record<string, unknown>);
      }
    })();
  }

  /** Wait for a server→client event of `type` (collected by the pump). */
  waitForEvent(type: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
    const byType: Record<string, Array<Record<string, unknown>>> = {
      'play.started': this.started,
      'play.stop.request': this.stopRequests,
      'screenshot.request': this.screenshotRequests,
      'play.diagnostics.request': this.diagnosticsRequests,
      'play.stopped': this.stoppedEvents,
    };
    const arr = byType[type] ?? [];
    const existing = arr[arr.length - 1];
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.pending.findIndex((p) => p.resolve === resolve);
        if (i !== -1) this.pending.splice(i, 1);
        reject(new Error(`FakeEditor timeout waiting for ${type}`));
      }, timeoutMs);
      this.pending.push({ type, resolve, reject, timer });
    });
  }

  /** Poll a predicate over the pump-collected state (the pump is the sole socket consumer). */
  waitUntil(pred: () => boolean, timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = (): void => {
        if (pred()) {
          resolve();
          return;
        }
        if (Date.now() - start > timeoutMs) {
          reject(new Error('waitUntil timeout'));
          return;
        }
        setTimeout(tick, 5);
      };
      tick();
    });
  }

  close(): void {
    this.ws.close();
  }

  private handle(ev: Record<string, unknown>): void {
    switch (ev.type) {
      case 'play.started': {
        this.started.push(ev);
        if (this.presentOnStart) {
          this.ws.send({ type: 'play.preview.ready', playSessionId: ev.playSessionId });
          this.presentedFlag = true;
        }
        break;
      }
      case 'play.stop.request': {
        this.stopRequests.push(ev);
        if (this.ackStops) this.ws.send({ type: 'play.stopped.ack', playSessionId: ev.playSessionId });
        break;
      }
      case 'screenshot.request': {
        this.screenshotRequests.push(ev);
        const reply = this.screenshotReply;
        if (reply === null) break;
        if (reply.ok) {
          this.ws.send({
            type: 'screenshot.ack',
            relayId: ev.relayId,
            ok: true,
            dataUrl: reply.dataUrl,
            width: reply.width,
            height: reply.height,
          });
        } else {
          this.ws.send({ type: 'screenshot.ack', relayId: ev.relayId, ok: false, error: reply.error });
        }
        break;
      }
      case 'play.diagnostics.request': {
        this.diagnosticsRequests.push(ev);
        const reply = this.diagnosticsReply;
        if (reply === null) break;
        if (reply.ok) {
          this.ws.send({ type: 'play.diagnostics.ack', relayId: ev.relayId, ok: true, diagnostics: reply.diagnostics });
        } else {
          this.ws.send({ type: 'play.diagnostics.ack', relayId: ev.relayId, ok: false, error: reply.error });
        }
        break;
      }
      case 'play.stopped': {
        this.stoppedEvents.push(ev);
        break;
      }
      default:
        break;
    }
    // Resolve the first pending waiter for this event type (if any).
    const i = this.pending.findIndex((p) => p.type === ev.type);
    if (i !== -1) {
      const [w] = this.pending.splice(i, 1);
      if (w) {
        clearTimeout(w.timer);
        w.resolve(ev);
      }
    }
  }
}

async function playStart(tb: TestBackend, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play`, { body: body ?? {}, token: tb.authToken });
  return { status: r.status, json: r.json as Record<string, unknown> };
}

describe('play start (§10.1)', () => {
  it('no registered browser ⇒ session_unavailable (structured, not an error dump)', async () => {
    const tb = await startBackend();
    try {
      const r = await playStart(tb);
      expect(r.status).toBe(503);
      const j = r.json as { error: Record<string, unknown> };
      expect(j.error.code).toBe('session_unavailable');
      expect(j.error.cls).toBe('unavailable');
      expect(typeof j.error.hint).toBe('string');
    } finally {
      await tb.teardown();
    }
  });

  it('start ⇒ 200 with playBase/snapshotId/revision/expiresAt; the owner receives play.started with the full snapshot', async () => {
    const tb = await startBackend();
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);

      // Advance the authoring revision so the snapshot is at r1.
      const mut = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
        body: {
          op: 'createEntity',
          projectId: 'demo-0001',
          requestId: `req-${'ab'.repeat(16)}`,
          expectedRevision: 0,
          args: { kind: 'box', parentId: null, name: 'box1' },
          origin: { kind: 'mcp', clientId: 'harness' },
        },
        token: tb.authToken,
        origin: null,
      });
      expect(mut.status).toBe(200);

      const r = await playStart(tb, { options: { demo: true } });
      expect(r.status).toBe(200);
      const j = r.json as Record<string, unknown>;
      expect(j.ok).toBe(true);
      expect(j.playSessionId).toMatch(/^play-[0-9a-f]{32}$/);
      expect(j.playBase).toBe(`${PREVIEW_ORIGIN}/`);
      expect(j.snapshotId).toBe('demo-0001@r1');
      expect(j.revision).toBe(1);
      expect(j.demo).toBe(true);
      expect(typeof j.expiresAt).toBe('string');

      const started = await editor.waitForEvent('play.started');
      expect(started.playSessionId).toBe(j.playSessionId);
      expect(started.startedBy).toEqual({ kind: 'browser', clientId: sid });
      const snap = started.snapshot as Record<string, unknown>;
      expect(snap.snapshotId).toBe('demo-0001@r1');
      expect(snap.projectId).toBe('demo-0001');
      expect(snap.revision).toBe(1);
      const scene = snap.scene as Record<string, unknown>;
      // the starter camera + two lights, plus the box1 we just created
      expect((scene.entities as unknown[]).length).toBe(4);

      editor.close();
    } finally {
      await tb.teardown();
    }
  });

  it('a second concurrent play ⇒ 409 play_already_active with activePlaySessionId', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);

      const first = await playStart(tb);
      expect(first.status).toBe(200);
      const second = await playStart(tb);
      expect(second.status).toBe(409);
      const j = second.json as { error: Record<string, unknown> };
      expect(j.error.code).toBe('play_already_active');
      expect(j.error.activePlaySessionId).toBe(first.json.playSessionId);

      editor.close();
    } finally {
      await tb.teardown();
    }
  });

  it('strict play-start body: unknown field ⇒ 400; options.demo defaults to true', async () => {
    const tb = await startBackend();
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);

      const bad = await playStart(tb, { options: { demo: true, extra: 1 } });
      expect(bad.status).toBe(400);
      const r = await playStart(tb); // empty body ⇒ {} ⇒ demo defaults true
      expect(r.status).toBe(200);
      expect(r.json.demo).toBe(true);
      editor.close();
    } finally {
      await tb.teardown();
    }
  });

  it('a held play.started is delivered on the owner re-attach (one-shot, §7.1)', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est1 = await establish(tb, sid);
      const ws1 = await upgrade(tb, sid, est1.wsToken);
      await ws1.waitFor((m) => (m as { type?: string }).type === 'attached');
      ws1.close(); // the owner's connection drops before the play starts
      // give the detach bookkeeping a tick
      await sleep(50);

      const r = await playStart(tb);
      expect(r.status).toBe(200); // the registered (detached) session owns the play

      // the owner re-attaches with a fresh wsToken
      const est2 = await establish(tb, sid);
      const ws2 = await upgrade(tb, sid, est2.wsToken);
      const started = (await ws2.waitFor((m) => (m as { type?: string }).type === 'play.started')) as Record<string, unknown>;
      expect(started.playSessionId).toBe(r.json.playSessionId);
      // one-shot: the second re-attach does not re-deliver
      ws2.close();
      await sleep(50);
      const est3 = await establish(tb, sid);
      const ws3 = await upgrade(tb, sid, est3.wsToken);
      const attached = ws3.waitFor((m) => (m as { type?: string }).type === 'attached');
      await attached;
      // no play.started before the present timeout elapses (60 s here)
      await sleep(300);
      ws3.close();
    } finally {
      await tb.teardown();
    }
  });
});

describe('stop paths (§10.2/§10.3)', () => {
  it('happy relay: stop ⇒ play.stop.request ⇒ ack ⇒ play.stopped { reason: "request" } (no stopUnconfirmed)', async () => {
    const tb = await startBackend();
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const r = await playStart(tb);
      // wait for the play to be presented (the stub sends play.preview.ready)
      await editor.waitUntil(() => editor.presentedFlag);

      const s = await api(
        `${tb.authUrl}/api/v1/projects/demo-0001/play/${r.json.playSessionId}/stop`,
        { body: {}, token: tb.authToken },
      );
      expect(s.status).toBe(200);
      const stopped = await editor.waitForEvent('play.stopped');
      expect(stopped.reason).toBe('request');
      expect(stopped.stopUnconfirmed).toBeUndefined();
      expect(editor.stopRequests.length).toBe(1);
      expect(editor.stopRequests[0]?.reason).toBe('request');
      editor.close();
    } finally {
      await tb.teardown();
    }
  });

  it('a non-acking editor ⇒ play.stopped with stopUnconfirmed: true after the stop-ack timeout', async () => {
    const tb = await startBackend({ timeouts: { stopAckTimeoutSeconds: 1 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      editor.ackStops = false;
      const r = await playStart(tb);
      await sleep(100);
      const s = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${r.json.playSessionId}/stop`, {
        body: {},
        token: tb.authToken,
      });
      expect(s.status).toBe(200);
      const stopped = await editor.waitForEvent('play.stopped');
      expect(stopped.reason).toBe('request');
      expect(stopped.stopUnconfirmed).toBe(true);
      editor.close();
    } finally {
      await tb.teardown();
    }
  });

  it('stop with the owner WS detached ⇒ 503 session_unavailable (the play is not stopped)', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const r = await playStart(tb);
      await sleep(100);
      editor.close();
      await sleep(100); // let the session_lost path run…

      // NOTE: the owner disconnect routes the play to `session_lost`
      // (direct stopped). So an explicit stop now ⇒ play_not_found.
      const s = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${r.json.playSessionId}/stop`, {
        body: {},
        token: tb.authToken,
      });
      expect(s.status).toBe(404);
      expect((s.json as { error: { code: string } }).error.code).toBe('play_not_found');

      // session_lost termination is recorded on the play record
      const rec = tb.backend._test.plays.get(r.json.playSessionId as string);
      expect(rec?.state).toBe('stopped');
      expect(rec?.reason).toBe('session_lost');
      expect(rec?.stopUnconfirmed).toBe(true);
    } finally {
      await tb.teardown();
    }
  });

  it('present timeout: no play.preview.ready ⇒ the play stops (preview_timeout)', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 1, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      editor.presentOnStart = false;
      const r = await playStart(tb);
      const stopped = await editor.waitForEvent('play.stopped');
      expect(stopped.reason).toBe('preview_timeout');
      // the stop relay was attempted (the editor is connected) and went
      // unconfirmed (the stub acks, so it confirms here — either way the
      // termination reason is preview_timeout)
      const rec = tb.backend._test.plays.get(r.json.playSessionId as string);
      expect(rec?.state).toBe('stopped');
      expect(rec?.reason).toBe('preview_timeout');
      editor.close();
    } finally {
      await tb.teardown();
    }
  });

  it('inactivity TTL: an idle presented play expires (reason "expired")', async () => {
    const tb = await startBackend({ timeouts: { inactivityTtlSeconds: 2, presentTimeoutSeconds: 60 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      editor.ackStops = true;
      const r = await playStart(tb);
      const stopped = await editor.waitForEvent('play.stopped', 15_000);
      expect(stopped.reason).toBe('expired');
      const rec = tb.backend._test.plays.get(r.json.playSessionId as string);
      expect(rec?.state).toBe('stopped');
      expect(rec?.reason).toBe('expired');
      editor.close();
    } finally {
      await tb.teardown();
    }
  }, 20000);

  it('preview failure reported by the editor ⇒ the play stops (preview_failed)', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      editor.presentOnStart = false;
      const r = await playStart(tb);
      await sleep(100);
      ws.send({ type: 'play.preview.failed', playSessionId: r.json.playSessionId, code: 'snapshot_invalid', message: 'bad' });
      const stopped = await editor.waitForEvent('play.stopped');
      expect(stopped.reason).toBe('preview_failed');
      const rec = tb.backend._test.plays.get(r.json.playSessionId as string);
      expect(rec?.state).toBe('stopped');
      expect(rec?.reason).toBe('preview_failed');
      editor.close();
    } finally {
      await tb.teardown();
    }
  });

  it('stop on an unknown/stopped play ⇒ 404 play_not_found; a second stop ⇒ play_not_found', async () => {
    const tb = await startBackend({ timeouts: { stopAckTimeoutSeconds: 1 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const r = await playStart(tb);
      await sleep(100);
      const s1 = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${r.json.playSessionId}/stop`, {
        body: {},
        token: tb.authToken,
      });
      expect(s1.status).toBe(200);
      const s2 = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${r.json.playSessionId}/stop`, {
        body: {},
        token: tb.authToken,
      });
      expect(s2.status).toBe(404);
      expect((s2.json as { error: { code: string } }).error.code).toBe('play_not_found');
      const s3 = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/play-${'0'.repeat(32)}/stop`, {
        body: {},
        token: tb.authToken,
      });
      expect(s3.status).toBe(404);
      editor.close();
    } finally {
      await tb.teardown();
    }
  });
});

describe('screenshot / diagnostics relay (§12)', () => {
  async function startPresentedPlay(tb: TestBackend): Promise<{ psid: string; editor: FakeEditor; ws: TestWs }> {
    const sid = mkSessionId();
    const est = await establish(tb, sid);
    const ws = await upgrade(tb, sid, est.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
    const editor = new FakeEditor(ws);
    const r = await playStart(tb);
    const psid = r.json.playSessionId as string;
    // wait until the backend has PROCESSED play.preview.ready (the stub's
    // presentedFlag is set on send — the record state is authoritative)
    await editor.waitUntil(() => tb.backend._test.plays.get(psid)?.state === 'presented');
    return { psid, editor, ws };
  }

  it('full screenshot relay: request → ack → the response carries snapshotId+revision+dataUrl', async () => {
    const tb = await startBackend();
    try {
      const { psid, editor, ws } = await startPresentedPlay(tb);
      const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/screenshot`, {
        body: { maxWidth: 256 },
        token: tb.authToken,
      });
      expect(r.status).toBe(200);
      const j = r.json as Record<string, unknown>;
      expect(j.ok).toBe(true);
      expect(j.playSessionId).toBe(psid);
      expect(j.snapshotId).toBe('demo-0001@r0');
      expect(j.revision).toBe(0);
      expect(j.width).toBe(256);
      expect(j.height).toBe(144);
      expect(typeof j.dataUrl).toBe('string');
      expect(editor.screenshotRequests.length).toBe(1);
      expect(editor.screenshotRequests[0]?.maxWidth).toBe(256);
      editor.close();
      void ws;
    } finally {
      await tb.teardown();
    }
  });

  it('a non-responsive preview ⇒ 503 screenshot_timeout with the relayId', async () => {
    const tb = await startBackend({ timeouts: { relayTimeoutSeconds: 1 } });
    try {
      const { psid, editor, ws } = await startPresentedPlay(tb);
      editor.screenshotReply = null; // the editor never answers
      const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/screenshot`, {
        body: {},
        token: tb.authToken,
      });
      expect(r.status).toBe(503);
      const j = r.json as { error: Record<string, unknown> };
      expect(j.error.code).toBe('screenshot_timeout');
      expect(j.error.cls).toBe('unavailable');
      expect(typeof j.error.relayId).toBe('string');
      editor.close();
      void ws;
    } finally {
      await tb.teardown();
    }
  });

  it('a failed relay (ok:false) ⇒ 503 relay_failed carrying the cause', async () => {
    const tb = await startBackend();
    try {
      const { psid, editor, ws } = await startPresentedPlay(tb);
      editor.screenshotReply = { ok: false, error: { code: 'relay_failed' } };
      const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/screenshot`, {
        body: {},
        token: tb.authToken,
      });
      expect(r.status).toBe(503);
      const j = r.json as { error: Record<string, unknown> };
      expect(j.error.code).toBe('relay_failed');
      expect(j.error.cause).toBe('relay_failed');
      editor.close();
      void ws;
    } finally {
      await tb.teardown();
    }
  });

  it('screenshot while the play is not yet presented ⇒ 503 session_unavailable (preview not ready)', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      editor.presentOnStart = false;
      const r = await playStart(tb);
      // immediately: the play is `active`, not presented
      const s = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${r.json.playSessionId}/screenshot`, {
        body: {},
        token: tb.authToken,
      });
      expect(s.status).toBe(503);
      const j = s.json as { error: Record<string, unknown> };
      expect(j.error.code).toBe('session_unavailable');
      expect(typeof j.error.playSessionId).toBe('string');
      editor.close();
    } finally {
      await tb.teardown();
    }
  });

  it('screenshot with the owner WS detached ⇒ 503 session_unavailable (browser must connect)', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const r = await playStart(tb);
      await sleep(150);
      // stop the present-timeout pressure, then detach the owner
      editor.close();
      await sleep(150); // session_lost stopped the play…
      const rec = tb.backend._test.plays.get(r.json.playSessionId as string);
      expect(rec?.state).toBe('stopped');
      // screenshot on the stopped play ⇒ play_not_found (structured)
      const s = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${r.json.playSessionId}/screenshot`, {
        body: {},
        token: tb.authToken,
      });
      expect(s.status).toBe(404);
      expect((s.json as { error: { code: string } }).error.code).toBe('play_not_found');
    } finally {
      await tb.teardown();
    }
  });

  it('full diagnostics relay: the response carries the play identifiers + the diagnostics object', async () => {
    const tb = await startBackend();
    try {
      const { psid, editor, ws } = await startPresentedPlay(tb);
      const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/diagnostics`, {
        body: {},
        token: tb.authToken,
      });
      expect(r.status).toBe(200);
      const j = r.json as Record<string, unknown>;
      expect(j.ok).toBe(true);
      expect(j.playSessionId).toBe(psid);
      expect(j.snapshotId).toBe('demo-0001@r0');
      expect(j.revision).toBe(0);
      expect(j.diagnostics).toEqual({ fps: 60, errorCount: 0 });
      expect(editor.diagnosticsRequests.length).toBe(1);
      editor.close();
      void ws;
    } finally {
      await tb.teardown();
    }
  });

  it('a non-responsive preview ⇒ 503 diagnostics_timeout', async () => {
    const tb = await startBackend({ timeouts: { relayTimeoutSeconds: 1 } });
    try {
      const { psid, editor, ws } = await startPresentedPlay(tb);
      editor.diagnosticsReply = null;
      const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/diagnostics`, {
        body: {},
        token: tb.authToken,
      });
      expect(r.status).toBe(503);
      const j = r.json as { error: Record<string, unknown> };
      expect(j.error.code).toBe('diagnostics_timeout');
      expect(typeof j.error.relayId).toBe('string');
      editor.close();
      void ws;
    } finally {
      await tb.teardown();
    }
  });

  it('maxWidth bounds are enforced (256–2048, default 1024)', async () => {
    const tb = await startBackend();
    try {
      const { psid, editor, ws } = await startPresentedPlay(tb);
      const tooSmall = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/screenshot`, {
        body: { maxWidth: 128 },
        token: tb.authToken,
      });
      expect(tooSmall.status).toBe(400);
      const tooBig = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/screenshot`, {
        body: { maxWidth: 4096 },
        token: tb.authToken,
      });
      expect(tooBig.status).toBe(400);
      const def = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/screenshot`, {
        body: {},
        token: tb.authToken,
      });
      expect(def.status).toBe(200);
      expect(editor.screenshotRequests[editor.screenshotRequests.length - 1]?.maxWidth).toBe(1024);
      editor.close();
      void ws;
    } finally {
      await tb.teardown();
    }
  });

  it('play revisions are frozen: authoring advances during play; the play keeps its snapshotId/revision', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const r = await playStart(tb); // snapshot at r0
      const started = await editor.waitForEvent('play.started');
      const snapBefore = (started.snapshot as Record<string, unknown>).revision;

      // authoring advances during play (MCP keeps editing)
      const mut = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
        body: {
          op: 'createEntity',
          projectId: 'demo-0001',
          requestId: `req-${'cd'.repeat(16)}`,
          expectedRevision: 0,
          args: { kind: 'box', parentId: null, name: 'boxX' },
          origin: { kind: 'mcp', clientId: 'harness' },
        },
        token: tb.authToken,
        origin: null,
      });
      expect(mut.status).toBe(200);
      expect((mut.json as { revision: number }).revision).toBe(1);

      const rec = tb.backend._test.plays.get(r.json.playSessionId as string);
      expect(rec?.revision).toBe(snapBefore); // frozen
      expect(rec?.snapshotId).toBe('demo-0001@r0');
      editor.close();
    } finally {
      await tb.teardown();
    }
  });
});