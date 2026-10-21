/**
 * Play content lasts as long as its play, over real HTTP against a real
 * backend: a scene of the play's content is still served after the content's
 * own lifetime has passed, while the play runs; after the play stops it is
 * served through the grace only; a play that ends because nothing used it
 * takes its content with it; and content that expired before its play ended
 * stays expired. `tl_play_start`'s `playContent.expiresAt` is the play's own.
 *
 * The backend runs in this process, so faking only `Date` gives the test the
 * clock every lifetime is measured on (the content store's TTL, grace and the
 * play's expiry it renews to): each assertion sits at an exact time instead of
 * racing a short timeout under load. Timers stay real: the play's inactivity
 * end still comes from its own timer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeEditor } from './test-editor';
import { api, establish, mkSessionId, startBackend, upgrade } from './test-helpers';

const PID = 'demo-0001';
const CONTENT_TTL_S = 1;
const GRACE_S = 1;
// Real seconds a play waits for activity: the stopped plays finish well inside it, the last one waits it out.
const INACTIVITY_S = 5;

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Wait (on real timers) until `pred` holds. Not `expect.poll`: under fake timers it moves the faked clock
 * forward on every check, and here only the test moves it.
 */
async function until(pred: () => boolean, what: string, timeoutMs: number): Promise<void> {
  const start = performance.now();
  while (!pred()) {
    if (performance.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('play content lifetime', () => {
  it('is readable while its play runs, past its own lifetime; gone a grace after a stop, and with the play at its inactivity end', async () => {
    const tb = await startBackend({
      timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: INACTIVITY_S, playContentTtlSeconds: CONTENT_TTL_S, playContentGraceSeconds: GRACE_S },
    });
    try {
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
      /** Move the shared clock forward to `t` (ms); it never runs on its own. */
      const at = (t: number): void => {
        expect(t).toBeGreaterThanOrEqual(Date.now());
        vi.setSystemTime(t);
      };
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const play = async (): Promise<{ psid: string; scene: string; issuedAt: number; playExpiresAt: number }> => {
        const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        const j = r.json as { playSessionId: string; expiresAt: string; playContent: { path: string; expiresAt: string } };
        expect(j.playContent.expiresAt).toBe(j.expiresAt);
        await until(() => tb.backend._test.plays.get(j.playSessionId)?.state === 'presented', 'the play to be presented', 15_000);
        const set = tb.backend._test.playContent.forPlay(j.playSessionId);
        const rec = tb.backend._test.plays.get(j.playSessionId);
        if (set === undefined || rec === undefined) throw new Error('play without its content');
        return { psid: j.playSessionId, scene: `${tb.prevUrl}${j.playContent.path}scenes/scene-main.json`, issuedAt: set.issuedAtMs, playExpiresAt: rec.expiresAt };
      };
      const status = async (url: string): Promise<{ status: number; code?: string }> => {
        const res = await fetch(url);
        const body = (await res.json()) as { error?: { code?: string } };
        return { status: res.status, ...(body.error?.code !== undefined ? { code: body.error.code } : {}) };
      };
      const stop = async (psid: string): Promise<void> => {
        editor.stoppedEvents.length = 0;
        const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/play/${psid}/stop`, { body: {}, token: tb.authToken });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        await editor.waitForEvent('play.stopped');
      };
      const expired = { status: 503, code: 'play_locator_expired' };

      // Past the content's own lifetime the play still runs: the scene is still served (its play renewed it).
      const first = await play();
      expect((await status(first.scene)).status).toBe(200);
      at(first.issuedAt + CONTENT_TTL_S * 1000 + 500);
      expect(Date.now()).toBeLessThan(first.playExpiresAt);
      expect((await status(first.scene)).status).toBe(200);
      // Stopped: served through the grace, then expired.
      await stop(first.psid);
      const stoppedAt = Date.now();
      at(stoppedAt + GRACE_S * 1000);
      expect((await status(first.scene)).status).toBe(200);
      at(stoppedAt + GRACE_S * 1000 + 1);
      expect(await status(first.scene)).toEqual(expired);

      // Content whose expiry passed before its play ended (the gap before the play's
      // inactivity timer fires) stays expired when the play then stops: no grace revives it.
      const second = await play();
      at(second.playExpiresAt + 1);
      expect(tb.backend._test.plays.get(second.psid)?.state).toBe('presented');
      expect(await status(second.scene)).toEqual(expired);
      await stop(second.psid);
      expect(await status(second.scene)).toEqual(expired);

      // A play nobody uses ends at its inactivity limit and takes its content with it.
      const third = await play();
      at(third.issuedAt + CONTENT_TTL_S * 1000 + 500);
      expect((await status(third.scene)).status).toBe(200);
      at(third.playExpiresAt);
      expect((await status(third.scene)).status).toBe(200);
      await until(() => tb.backend._test.plays.get(third.psid)?.state !== 'presented', 'the inactivity end', INACTIVITY_S * 1000 + 15_000);
      at(third.playExpiresAt + 1);
      expect(await status(third.scene)).toEqual(expired);
      editor.close();
    } finally {
      vi.useRealTimers();
      await tb.teardown();
    }
  }, 60_000);
});
