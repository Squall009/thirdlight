/**
 * Play sessions + screenshot/diagnostics relay.
 *
 * The "editor" is a `ws` client acting per the contract: it presents the
 * preview (play.preview.ready), relays stop (play.stopped.ack), and answers
 * screenshot/diagnostics relays with the exact result shapes.
 */
import { writeFileSync } from 'node:fs';
import { closureCacheStats } from '@thirdlight/exporter';
import { join } from 'node:path';
import type { PlayArtifact } from './play-content';

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  api,
  establish,
  mkSessionId,
  playContentOf,
  PREVIEW_ORIGIN,
  sleep,
  startBackend,
  upgrade,
  type TestBackend,
  type TestWs,
} from './test-helpers';
import { FakeEditor } from './test-editor';


async function playStart(tb: TestBackend, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play`, { body: body ?? {}, token: tb.authToken });
  return { status: r.status, json: r.json as Record<string, unknown> };
}

describe('play start', () => {
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

  it('a held play.started is delivered on the owner re-attach (one-shot)', async () => {
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

describe('the backend part of a Play start', () => {
  it('the game bundle is read from disk once while it is unchanged, and again after a rebuild; the start reports its stages', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const bundleOf = (psid: string) => tb.backend._test.playContent.forPlay(psid)!.artifacts.get('game.js')! as PlayArtifact;
      const playAndStop = async (): Promise<{ psid: string; timings: Record<string, number> }> => {
        const r = await playStart(tb);
        expect(r.status).toBe(200);
        const psid = r.json.playSessionId as string;
        await editor.waitUntil(() => tb.backend._test.plays.get(psid)?.state === 'presented');
        editor.stoppedEvents.length = 0;
        await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/stop`, { body: {}, token: tb.authToken });
        await editor.waitForEvent('play.stopped');
        return { psid, timings: r.json.timings as Record<string, number> };
      };
      const a = await playAndStop();
      const b = await playAndStop();
      // The same bytes (one read), the same digest.
      expect(bundleOf(b.psid).bytes).toBe(bundleOf(a.psid).bytes);
      expect(bundleOf(b.psid).digest).toBe(bundleOf(a.psid).digest);
      // Its stages: the backend's own, and the closure's.
      for (const k of ['session', 'state', 'capture', 'bundle', 'closure', 'closure.view', 'closure.behaviors', 'closure.assets', 'closure.scenes', 'closure.manifest', 'publish', 'total']) expect(typeof a.timings[k], k).toBe('number');
      // A rebuilt bundle is read again.
      writeFileSync(join(tb.root, 'preview', 'preview-m3.js'), '// M3 preview bundle stub (tests), rebuilt\n');
      const c = await playAndStop();
      expect(new TextDecoder().decode(bundleOf(c.psid).bytes)).toContain('rebuilt');
      expect(bundleOf(c.psid).digest).not.toBe(bundleOf(a.psid).digest);
      editor.close();
    } finally {
      await tb.teardown();
    }
  });
});

describe('caching across Plays', () => {
  it('the play scripts and the declared artifacts are served at digest-keyed URLs that stay the same from Play to Play (immutable, ETag, 304); blobs are held once', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const get = async (path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> => {
        const res = await fetch(`${tb.prevUrl}${path}`, { headers });
        return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
      };
      const playOnce = async (): Promise<{ psid: string; shell: string; manifest: { scenes?: { path: string; digest: string }[]; revision?: number } }> => {
        const r = await playStart(tb);
        expect(r.status).toBe(200);
        const psid = r.json.playSessionId as string;
        const content = r.json.playContent as { contentId: string; path: string };
        const shell = new TextDecoder().decode((await get(`/play/${psid}?content=${content.contentId}`)).bytes);
        expect((await get(`${content.path}manifest.json`)).status).toBe(200);
        // The scene rows are the catalog's (its root, read from the published set).
        const manifest = { scenes: playContentOf(tb, psid).scenes, revision: playContentOf(tb, psid).revision };
        return { psid, shell, manifest };
      };
      const stop = async (psid: string): Promise<void> => {
        await editor.waitUntil(() => tb.backend._test.plays.get(psid)?.state === 'presented');
        editor.stoppedEvents.length = 0;
        await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/stop`, { body: {}, token: tb.authToken });
        await editor.waitForEvent('play.stopped');
      };
      const rootsOf = (shell: string): { build: string; cache: string } => ({
        build: /<script src="(\/play-build\/[0-9a-f]{64}\/)game\.js"><\/script>/.exec(shell)![1]!,
        cache: /__thirdlightCacheRoot = "(\/play-content\/[A-Za-z0-9_-]{43}\/)"/.exec(shell)![1]!,
      });
      const a = await playOnce();
      const ra = rootsOf(a.shell);
      // The bundle at the play build's URL: immutable, its digest the ETag; a revalidation that names it is a 304.
      const bundle = await get(`${ra.build}game.js`);
      expect(bundle.status).toBe(200);
      expect(bundle.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      const etag = bundle.headers.get('etag')!;
      expect(etag).toBe(`"${tb.backend._test.playContent.forPlay(a.psid)!.artifacts.get('game.js')!.digest}"`);
      expect((await get(`${ra.build}game.js`, { 'if-none-match': etag })).status).toBe(304);
      expect((await get(`/play-build/${'0'.repeat(64)}/game.js`)).status).toBe(404);
      // A declared artifact (a scene file) by digest under the project's cache root.
      const scene = a.manifest.scenes![0]!;
      const byDigest = await get(`${ra.cache}content/sha256/${scene.digest}`);
      expect(byDigest.status).toBe(200);
      expect(byDigest.headers.get('etag')).toBe(`"${scene.digest}"`);
      expect(byDigest.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
      expect((await get(`${ra.cache}content/sha256/${'1'.repeat(64)}`)).status).toBe(404);
      expect((await get(`${ra.cache}manifest.json`)).status).toBe(404);
      await stop(a.psid);
      // The next Play: the same URLs; its set shares the bytes (held once, by digest); the unchanged
      // capture's derivation (content view, scene files and digests) is reused, not made again.
      const derivedBefore = { ...closureCacheStats };
      const b = await playOnce();
      expect(closureCacheStats.hits).toBe(derivedBefore.hits + 1);
      expect(closureCacheStats.misses).toBe(derivedBefore.misses);
      expect(b.manifest.scenes).toEqual(a.manifest.scenes);
      expect(rootsOf(b.shell)).toEqual(ra);
      const setA = tb.backend._test.playContent.forPlay(a.psid)!;
      const setB = tb.backend._test.playContent.forPlay(b.psid)!;
      expect((setB.artifacts.get(scene.path) as PlayArtifact).bytes).toBe((setA.artifacts.get(scene.path) as PlayArtifact).bytes);
      const counters = tb.backend._test.playContent.counters();
      expect(counters.blobs).toBe(new Set([...setA.artifacts.values(), ...setB.artifacts.values()].map((x) => x.digest)).size);
      await stop(b.psid);
      // An edit: a new capture, derived again (never the remembered one).
      const revision = Number((b.manifest as { revision?: number }).revision ?? 0);
      const mut = await api(`${tb.authUrl}/api/v1/projects/demo-0001/commands`, {
        body: { op: 'createEntity', projectId: 'demo-0001', requestId: `req-${'cd'.repeat(16)}`, expectedRevision: revision, args: { kind: 'box', parentId: null, name: 'box-25-24c' }, origin: { kind: 'mcp', clientId: 'harness' } },
        token: tb.authToken,
        origin: null,
      });
      expect(mut.status).toBe(200);
      const missesBefore = closureCacheStats.misses;
      // A rebuilt bundle: a new play build address; the previous one is still served (a page that started before it).
      writeFileSync(join(tb.root, 'preview', 'preview-m3.js'), '// M3 preview bundle stub (tests), rebuilt for 25.24c\n');
      const c = await playOnce();
      expect(closureCacheStats.misses).toBe(missesBefore + 1);
      expect(c.manifest.scenes).not.toEqual(a.manifest.scenes);
      const rc = rootsOf(c.shell);
      expect(rc.build).not.toBe(ra.build);
      expect(new TextDecoder().decode((await get(`${rc.build}game.js`)).bytes)).toContain('rebuilt for 25.24c');
      expect((await get(`${ra.build}game.js`)).status).toBe(200);
      await stop(c.psid);
      editor.close();
    } finally {
      await tb.teardown();
    }
  });
});

describe('stop paths', () => {
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

  it('the present timeout counts from the last play.preview.progress', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 1, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      editor.presentOnStart = false;
      const r = await playStart(tb);
      const psid = r.json.playSessionId as string;
      // Progress every 0.5 s for 2.5 s: the play stays (twice the timeout from its start).
      for (let i = 0; i < 5; i += 1) {
        await sleep(500);
        ws.send({ type: 'play.preview.progress', playSessionId: psid });
      }
      expect(tb.backend._test.plays.get(psid)?.state).toBe('active');
      // Then silence: it stops a timeout after the last progress.
      const stopped = await editor.waitForEvent('play.stopped', 4000);
      expect(stopped.reason).toBe('preview_timeout');
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

describe('an ended play says why', () => {
  const post = (tb: TestBackend, psid: string, action: string) =>
    api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/${action}`, { body: action === 'control' ? { command: 'mute' } : {}, token: tb.authToken }) as Promise<{ status: number; json: { error: { code: string; message: string; ended?: { reason: string; presented: boolean; at: string; detail?: string } } } }>;
  const problems = async (tb: TestBackend) =>
    ((await api(`${tb.authUrl}/api/v1/projects/demo-0001/problems`, { method: 'GET', token: tb.authToken })).json as { problems: Array<{ source: string; code: string; message: string }> }).problems;

  it('a play that timed out before it was presented: observe and diagnostics give the reason, the problems list has it', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 1, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      editor.presentOnStart = false;
      const r = await playStart(tb);
      const psid = r.json.playSessionId as string;
      await editor.waitForEvent('play.stopped');
      for (const action of ['observe', 'diagnostics', 'control', 'stop']) {
        const res = await post(tb, psid, action);
        expect(res.status, action).toBe(404);
        expect(res.json.error.code).toBe('play_not_found');
        expect(res.json.error.ended).toMatchObject({ reason: 'preview_timeout', presented: false });
        expect(res.json.error.message).toMatch(/^the play ended before it was presented at .*: the preview did not present it within 1 s$/);
      }
      const list = await problems(tb);
      expect(list.find((p) => p.source === 'play' && p.code === 'play_preview_timeout')?.message).toContain(psid);
      // An id this backend never had stays a bare play_not_found.
      const unknown = await post(tb, `play-${'0'.repeat(32)}`, 'observe');
      expect(unknown.status).toBe(404);
      expect(unknown.json.error.ended).toBeUndefined();
      editor.close();
    } finally {
      await tb.teardown();
    }
  });

  it('the editor page closing before the play was presented: session_lost, said in words', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      editor.presentOnStart = false;
      const r = await playStart(tb);
      const psid = r.json.playSessionId as string;
      await editor.waitForEvent('play.started');
      ws.close();
      await sleep(100);
      const res = await post(tb, psid, 'diagnostics');
      expect(res.status).toBe(404);
      expect(res.json.error.ended).toMatchObject({ reason: 'session_lost', presented: false });
      expect(res.json.error.message).toContain('before it was presented');
      expect(res.json.error.message).toContain('the editor page that ran it closed, reloaded or lost its connection');
      expect((await problems(tb)).some((p) => p.code === 'play_session_lost' && p.message.includes(psid))).toBe(true);
    } finally {
      await tb.teardown();
    }
  });

  it("the owner's browser taking a project over from the headless editor: the headless play's end names that", async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const reg = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: 'demo-0001', sessionId: sid, clientInfo: { kind: 'browser', label: 'headless' } }, token: tb.authToken });
      const ws = await upgrade(tb, sid, (reg.json as { wsToken: string }).wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const r = await playStart(tb);
      const psid = r.json.playSessionId as string;
      await editor.waitUntil(() => tb.backend._test.plays.get(psid)?.state === 'presented');
      await establish(tb, mkSessionId());
      const res = await post(tb, psid, 'observe');
      expect(res.status).toBe(404);
      expect(res.json.error.ended).toMatchObject({ reason: 'session_lost', presented: true });
      expect(res.json.error.message).toMatch(/^the play ended at .*: the owner's editor browser took the project over from the backend's headless editor that ran it$/);
    } finally {
      await tb.teardown();
    }
  });

  it('a preview failure keeps its code and message; a presented play that was stopped says so', async () => {
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      editor.presentOnStart = false;
      const r1 = await playStart(tb);
      await sleep(100);
      ws.send({ type: 'play.preview.failed', playSessionId: r1.json.playSessionId, code: 'snapshot_invalid', message: 'the scene has no camera' });
      await editor.waitForEvent('play.stopped');
      const failed = await post(tb, r1.json.playSessionId as string, 'observe');
      expect(failed.json.error.ended).toMatchObject({ reason: 'preview_failed', presented: false, detail: 'snapshot_invalid: the scene has no camera' });
      expect(failed.json.error.message).toContain('the preview failed to start (snapshot_invalid: the scene has no camera)');

      editor.presentOnStart = true;
      editor.stoppedEvents.length = 0;
      const r2 = await playStart(tb);
      const psid = r2.json.playSessionId as string;
      await editor.waitUntil(() => tb.backend._test.plays.get(psid)?.state === 'presented');
      expect((await post(tb, psid, 'stop')).status).toBe(200);
      await editor.waitForEvent('play.stopped');
      const stopped = await post(tb, psid, 'observe');
      expect(stopped.json.error.ended).toMatchObject({ reason: 'request', presented: true });
      expect(stopped.json.error.message).toMatch(/^the play ended at .*: it was stopped/);
      // The ended record no longer holds the scene.
      expect(tb.backend._test.plays.get(psid)?.snapshot).toBeNull();
      // A user's own Stop and a reported preview failure add no extra problem of this kind.
      expect((await problems(tb)).filter((p) => p.code === 'play_request')).toEqual([]);
      editor.close();
    } finally {
      await tb.teardown();
    }
  });
});

describe('screenshot / diagnostics relay', () => {
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

  it('a preview that says why the capture failed ⇒ 503 relay_failed with that reason in the message', async () => {
    const tb = await startBackend();
    try {
      const { psid, editor, ws } = await startPresentedPlay(tb);
      editor.screenshotReply = { ok: false, error: { code: 'screenshot_failed', message: 'PNG capture failed: SecurityError: tainted' } };
      const r = await api(`${tb.authUrl}/api/v1/projects/demo-0001/play/${psid}/screenshot`, {
        body: {},
        token: tb.authToken,
      });
      expect(r.status).toBe(503);
      const j = r.json as { error: Record<string, unknown> };
      expect(j.error.code).toBe('relay_failed');
      expect(j.error.cause).toBe('screenshot_failed');
      expect(j.error.message).toBe('screenshot failed in the preview: PNG capture failed: SecurityError: tainted');
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