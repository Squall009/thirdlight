/**
 * Backend reads at scale, at the HTTP boundary (a project in the data root):
 *
 * - Play serves the project's files from disk at their digest URLs: a file
 *   changed on disk gets a new digest and a new URL at the next Play, and its
 *   old URL never serves the new bytes (refused, and the files checked again);
 * - a restart reads the stamps the last run kept and hashes no unchanged file;
 * - the asset, index and integrity queries page.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { isFileArtifact } from './play-content';
import { FakeEditor } from './test-editor';
import { AUTHORING_ORIGIN, PREVIEW_ORIGIN, api, establish, mkRequestId, mkSessionId, playContentOf, startBackend, upgrade, type TestBackend } from './test-helpers';
import { createTestBackend } from './testing';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const WAV = new Uint8Array(readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav')));
const PID = 'demo-0001';
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
/** The fixture with one sample changed (still a valid WAV, other bytes). */
const variant = (n: number): Uint8Array => {
  const b = new Uint8Array(WAV);
  const i = b.length - 1 - (n % 64);
  b[i] = (b[i] ?? 0) ^ ((n % 255) + 1);
  return b;
};

function helpers(tb: () => TestBackend) {
  const dir = (): string => join(tb().root, 'data', 'projects', PID);
  const put = (rel: string, bytes: Uint8Array, old = true): void => {
    const p = join(dir(), ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, bytes);
    // Written well before it is first hashed (a hash in the same moment as a write is made again later).
    if (old) utimesSync(p, (Date.now() - 60_000) / 1000, (Date.now() - 60_000) / 1000);
  };
  const revision = (): number => {
    const r = tb().backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Record<string, unknown>) =>
    api(`${tb().authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'play-files-test' }, args }, token: tb().adminToken, origin: null });
  const query = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
    (await api(`${tb().authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, args }, token: tb().adminToken, origin: null })).json as Record<string, unknown>;
  const digestOf = async (assetId: string): Promise<string> => {
    const q = (await query('queryAssets', { assetId, includeVersions: true })) as { assets: { currentVersion: number; versions: { version: number; sourceDigest: string }[] }[] };
    const a = q.assets[0]!;
    return a.versions.find((v) => v.version === a.currentVersion)!.sourceDigest;
  };
  return { dir, put, command, query, digestOf };
}

describe('Play serves the project files from disk', () => {
  it('a changed file gets a new digest and a new URL; its old URL never serves the new bytes', async () => {
    let tb!: TestBackend;
    tb = await startBackend({ timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    const h = helpers(() => tb);
    try {
      h.put('assets/sfx/tone.wav', WAV);
      // A label makes it loadable: it ships though no scene uses it.
      const imported = await h.command('importAssets', { folder: 'assets/sfx', labels: ['sfx'] });
      expect(imported.status, JSON.stringify(imported.json)).toBe(200);
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const get = async (path: string): Promise<{ status: number; bytes: Uint8Array; json: () => Record<string, unknown> }> => {
        const res = await fetch(`${tb.prevUrl}${path}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, bytes, json: () => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> };
      };
      const play = async (): Promise<{ psid: string; cache: string; digest: string }> => {
        const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
        expect(r.status, JSON.stringify(r.json)).toBe(200);
        const j = r.json as { playSessionId: string; playContent: { contentId: string; path: string } };
        const shell = new TextDecoder().decode((await get(`/play/${j.playSessionId}?content=${j.playContent.contentId}`)).bytes);
        const cache = /__thirdlightCacheRoot = "(\/play-content\/[A-Za-z0-9_-]{43}\/)"/.exec(shell)![1]!;
        expect((await get(`${j.playContent.path}manifest.json`)).status).toBe(200);
        const row = (playContentOf(tb, j.playSessionId).assets as { assetId: string; sourceDigest: string }[]).find((a) => a.assetId === 'tone');
        expect(row).toBeDefined();
        return { psid: j.playSessionId, cache, digest: row!.sourceDigest };
      };
      const stop = async (psid: string): Promise<void> => {
        await editor.waitUntil(() => tb.backend._test.plays.get(psid)?.state === 'presented');
        editor.stoppedEvents.length = 0;
        await api(`${tb.authUrl}/api/v1/projects/${PID}/play/${psid}/stop`, { body: {}, token: tb.authToken });
        await editor.waitForEvent('play.stopped');
      };

      const first = await play();
      expect(first.digest).toBe(sha(WAV));
      const served = await get(`${first.cache}content/sha256/${first.digest}`);
      expect(served.status).toBe(200);
      expect(sha(served.bytes)).toBe(first.digest);
      // The backend names the file; it does not hold its bytes.
      const set = tb.backend._test.playContent.forPlay(first.psid)!;
      expect(isFileArtifact(set.artifacts.get(`content/sha256/${first.digest}`)!)).toBe(true);

      // The file changes on disk while the play runs: its URL is refused, never answered with the new bytes,
      // and the refusal has the files checked again (the file is imported again: a new digest).
      const second = variant(1);
      h.put('assets/sfx/tone.wav', second, false);
      const stale = await get(`${first.cache}content/sha256/${first.digest}`);
      expect(stale.status).toBe(409);
      expect((stale.json() as { error: { code: string } }).error.code).toBe('asset_source_changed');
      await expect.poll(() => h.digestOf('tone'), { timeout: 15_000 }).toBe(sha(second));
      await stop(first.psid);

      // The next Play: the new digest at a new URL, the new bytes there; the old URL still serves nothing.
      const next = await play();
      expect(next.digest).toBe(sha(second));
      expect(next.cache).toBe(first.cache);
      const fresh = await get(`${next.cache}content/sha256/${next.digest}`);
      expect(fresh.status).toBe(200);
      expect(sha(fresh.bytes)).toBe(sha(second));
      expect((await get(`${next.cache}content/sha256/${first.digest}`)).status).not.toBe(200);
      await stop(next.psid);

      // Changed again with nobody asking for it: the Play start takes the file in first (as Unity refreshes before Play mode).
      const third = variant(2);
      h.put('assets/sfx/tone.wav', third, false);
      const again = await play();
      expect(again.digest).toBe(sha(third));
      const thirdServed = await get(`${again.cache}content/sha256/${again.digest}`);
      expect(sha(thirdServed.bytes)).toBe(sha(third));
      await stop(again.psid);
      editor.close();
    } finally {
      await tb.teardown();
    }
  }, 120_000);

  it('a restart reads the kept stamps: no unchanged file is hashed again, a changed one is', async () => {
    let tb = await startBackend();
    const h = helpers(() => tb);
    const adminToken = tb.adminToken;
    const check = async (): Promise<number> => {
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return (r.json as { summary: { ok: number } }).summary.ok;
    };
    const root = tb.root;
    try {
      for (let i = 0; i < 6; i += 1) h.put(`assets/many/v${i}.wav`, variant(10 + i));
      expect((await h.command('importAssets', { folder: 'assets/many' })).status).toBe(200);
      expect(await check()).toBe(6);
      const before = tb.backend._test.service.fileStampStats(PID)!;
      expect(before.files).toBeGreaterThanOrEqual(6);
      // A second check in the same run hashes nothing.
      await check();
      expect(tb.backend._test.service.fileStampStats(PID)!.hashes).toBe(before.hashes);
      // Restart over the same data root.
      await tb.backend.close();
      const t2 = await createTestBackend({
        dataRoot: join(root, 'data'),
        authoringOrigin: AUTHORING_ORIGIN,
        previewOrigin: PREVIEW_ORIGIN,
        authoringOrigins: [AUTHORING_ORIGIN],
        tokens: [{ token: adminToken, scope: 'admin' }],
      });
      tb = { ...tb, backend: t2.backend, authUrl: `http://127.0.0.1:${t2.backend.portAuthoring}`, prevUrl: `http://127.0.0.1:${t2.backend.portPreview}`, teardown: async () => { await t2.teardown(); } };
      expect(await check()).toBe(6);
      expect(tb.backend._test.service.fileStampStats(PID)!.hashes).toBe(0);
      // One file changes: only it is hashed (and imported again).
      h.put('assets/many/v3.wav', variant(99));
      await check();
      const after = tb.backend._test.service.fileStampStats(PID)!;
      expect(after.hashes).toBeGreaterThanOrEqual(1);
      expect(after.hashes).toBeLessThanOrEqual(2);
      expect(await h.digestOf('v3')).toBe(sha(variant(99)));
    } finally {
      await tb.teardown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('queries page', () => {
  it('assets, the index and the integrity report page in id order; a new list is paged in its new order', async () => {
    const tb = await startBackend();
    const h = helpers(() => tb);
    try {
      for (const n of ['e', 'b', 'd', 'a', 'c']) h.put(`assets/page/${n}.wav`, variant(n.charCodeAt(0)));
      expect((await h.command('importAssets', { folder: 'assets/page' })).status).toBe(200);
      const pageIds = async (op: string, key: string, args: Record<string, unknown>): Promise<{ ids: string[]; total: number }> => {
        const ids: string[] = [];
        let total = 0;
        for (let offset = 0; ; offset += 2) {
          const q = await h.query(op, { ...args, limit: 2, offset });
          const rows = q[key] as Record<string, unknown>[];
          total = q['total'] as number;
          ids.push(...rows.map((r) => String(r['assetId'] ?? r['id'])));
          if (rows.length < 2) break;
        }
        return { ids, total };
      };
      expect(await pageIds('queryAssets', 'assets', {})).toEqual({ ids: ['a', 'b', 'c', 'd', 'e'], total: 5 });
      expect(await pageIds('queryIndex', 'entries', { kind: 'audio' })).toEqual({ ids: ['a', 'b', 'c', 'd', 'e'], total: 5 });
      // One more asset: a new list, paged in its new order.
      h.put('assets/page2/aa.wav', variant(7));
      expect((await h.command('importAssets', { folder: 'assets/page2' })).status).toBe(200);
      expect((await pageIds('queryAssets', 'assets', {})).ids).toEqual(['a', 'aa', 'b', 'c', 'd', 'e']);
      expect((await pageIds('queryIndex', 'entries', { kind: 'audio' })).ids).toEqual(['a', 'aa', 'b', 'c', 'd', 'e']);
      const one = await h.query('queryAssets', { assetId: 'c' });
      expect((one['assets'] as { assetId: string }[]).map((a) => a.assetId)).toEqual(['c']);
      expect((await h.query('queryAssets', { assetId: 'zz' }))['ok']).toBe(false);

      // The integrity report: pages with a cursor; `problems` keeps only what needs attention.
      const integrity = async (qs: string): Promise<{ entries: { assetId: string; status: string }[]; total?: number; nextCursor?: string | null }> =>
        (await api(`${tb.authUrl}/api/v1/projects/${PID}/content/integrity${qs}`, { method: 'GET', token: tb.adminToken, origin: null })).json as never;
      const firstPage = await integrity('?limit=2&offset=0');
      expect(firstPage.entries).toHaveLength(2);
      expect(firstPage.total).toBe(6);
      expect(firstPage.nextCursor).toBe('2');
      expect((await integrity('?limit=2&offset=4')).nextCursor).toBeNull();
      expect((await integrity('')).entries).toHaveLength(6);
      unlinkSync(join(h.dir(), 'assets', 'page', 'd.wav'));
      const problems = await integrity('?problems=true');
      expect(problems.entries.map((e) => `${e.assetId}:${e.status}`)).toEqual(['d:missing']);
      expect(problems.total).toBe(1);
      const checked = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/files/check`, { body: { problems: true }, token: tb.adminToken, origin: null });
      expect((checked.json as { entries: { assetId: string }[] }).entries.map((e) => e.assetId)).toEqual(['d']);
      expect((await api(`${tb.authUrl}/api/v1/projects/${PID}/content/integrity?limit=0`, { method: 'GET', token: tb.adminToken, origin: null })).status).toBe(400);
    } finally {
      await tb.teardown();
    }
  }, 120_000);
});
