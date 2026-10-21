/**
 * Play content lasts as long as its play, over real HTTP with short timeouts
 * (the test seam): a scene of the play's content is still served after the
 * content's own lifetime has passed, while the play runs; after the play
 * stops it is served through the grace only; a play that ends because nothing
 * used it takes its content with it. `tl_play_start`'s `playContent.expiresAt`
 * is the play's own.
 */
import { describe, expect, it } from 'vitest';

import { FakeEditor } from './test-editor';
import { api, establish, mkSessionId, startBackend, upgrade } from './test-helpers';

const PID = 'demo-0001';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('play content lifetime', () => {
  it('is readable while its play runs, past its own lifetime; gone a grace after the play ends', async () => {
    // Content: 1 s on its own, 1 s of grace; a play ends after 3 s without activity.
    const tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 3, playContentTtlSeconds: 1, playContentGraceSeconds: 1 } });
    try {
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const play = async (): Promise<{ psid: string; scene: string; expiresAt: string; contentExpiresAt: string }> => {
        const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        const j = r.json as { playSessionId: string; expiresAt: string; playContent: { path: string; expiresAt: string } };
        await editor.waitUntil(() => tb.backend._test.plays.get(j.playSessionId)?.state === 'presented');
        return { psid: j.playSessionId, scene: `${tb.prevUrl}${j.playContent.path}scenes/scene-main.json`, expiresAt: j.expiresAt, contentExpiresAt: j.playContent.expiresAt };
      };
      const status = async (url: string): Promise<{ status: number; code?: string }> => {
        const res = await fetch(url);
        const body = (await res.json()) as { error?: { code?: string } };
        return { status: res.status, ...(body.error?.code !== undefined ? { code: body.error.code } : {}) };
      };

      const first = await play();
      expect(first.contentExpiresAt).toBe(first.expiresAt);
      expect((await status(first.scene)).status).toBe(200);
      // Past the content's own second, the play still runs: the scene is still served.
      await sleep(1_500);
      expect(tb.backend._test.plays.get(first.psid)?.state).toBe('presented');
      expect((await status(first.scene)).status).toBe(200);
      // Stopped: served through the grace, then expired.
      await api(`${tb.authUrl}/api/v1/projects/${PID}/play/${first.psid}/stop`, { body: {}, token: tb.authToken });
      await editor.waitForEvent('play.stopped');
      expect((await status(first.scene)).status).toBe(200);
      await sleep(1_300);
      expect(await status(first.scene)).toEqual({ status: 503, code: 'play_locator_expired' });

      // A play nobody uses ends at its inactivity limit; its content a grace later.
      editor.stoppedEvents.length = 0;
      const second = await play();
      await sleep(2_000);
      expect((await status(second.scene)).status).toBe(200);
      await expect.poll(() => tb.backend._test.plays.get(second.psid)?.state ?? 'gone', { timeout: 8_000 }).not.toBe('presented');
      await sleep(1_300);
      expect(await status(second.scene)).toEqual({ status: 503, code: 'play_locator_expired' });
      editor.close();
    } finally {
      await tb.teardown();
    }
  }, 60_000);
});
