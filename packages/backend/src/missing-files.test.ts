/**
 * Missing asset files at the HTTP boundary (a project in the data root,
 * files removed and moved outside the editor):
 *
 * - the problems query lists every missing file (path, asset, what uses it)
 *   at the first read and again after each file check, in pages, and the
 *   Problems log gets one line when the list changes;
 * - a Play whose missing files no start scene draws starts, a placeholder
 *   served for each and listed in its result;
 * - a Play whose start draws a missing file refuses, naming every missing
 *   file in one refusal; an export refuses the same way.
 */
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { FakeEditor } from './test-editor';
import { api, establish, mkRequestId, mkSessionId, playContentOf, startBackend, upgrade, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const WAV = new Uint8Array(readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav')));
const PID = 'demo-0001';
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
/** The fixture with one sample changed (still a valid WAV, other bytes). */
const variant = (n: number): Uint8Array => {
  const b = new Uint8Array(WAV);
  const i = b.length - 1 - n;
  b[i] = (b[i] ?? 0) ^ (n + 1);
  return b;
};

interface MissingFile {
  assetId: string;
  path: string;
  usedBy: { kind: string; id: string }[];
}
interface PlayFile {
  assetId: string;
  kind: string;
  path: string | null;
  inStart: boolean;
  code: string;
}

describe('missing asset files', () => {
  it('are listed at open and after each check, stood in for in a Play outside the start, and named all at once in a refusal', async () => {
    const exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-missing-export-'));
    const tb: TestBackend = await startBackend({ exportRoot, engineRoot: REPO, timeouts: { presentTimeoutSeconds: 60, inactivityTtlSeconds: 300 } });
    const dir = join(tb.root, 'data', 'projects', PID);
    const revision = (): number => {
      const r = tb.backend._test.service.readCapturedV3(PID);
      if (!r.ok) throw new Error(r.error.code);
      return r.read.revision;
    };
    const command = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'missing-files-test' }, args }, token: tb.adminToken, origin: null });
      expect(r.status, `${op}: ${JSON.stringify(r.json)}`).toBe(200);
      return r.json as Record<string, unknown>;
    };
    const get = async (path: string): Promise<{ status: number; json: Record<string, unknown> }> => {
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}${path}`, { method: 'GET', token: tb.adminToken, origin: null });
      return { status: r.status, json: r.json as Record<string, unknown> };
    };
    const problems = async (): Promise<{ missingFiles: { total: number; files: MissingFile[] }; problems: { code: string; message: string }[] }> =>
      (await get('/problems')).json as never;
    const checkFiles = async (): Promise<void> => {
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    };
    try {
      // Four sounds in the game folder; every one can be loaded by its label, so every one ships.
      mkdirSync(join(dir, 'assets', 'sfx'), { recursive: true });
      for (const [i, name] of ['a-start', 'b-later', 'c-loose', 'd-moved'].entries()) {
        const p = join(dir, 'assets', 'sfx', `${name}.wav`);
        writeFileSync(p, variant(i));
        utimesSync(p, (Date.now() - 60_000) / 1000, (Date.now() - 60_000) / 1000);
      }
      await command('importAssets', { folder: 'assets/sfx', labels: ['sfx'] });
      const project = (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryProject', projectId: PID, args: {} }, token: tb.adminToken, origin: null })).json as { workspace?: { startScenes?: string[] }; scenes?: { sceneId: string }[] };
      const main = project.workspace?.startScenes?.[0] ?? project.scenes?.[0]?.sceneId ?? 'scene-main';
      await command('createScene', { sceneId: 'scene-later', name: 'Later' });
      // The start scene plays a-start; the later scene b-later and d-moved; nothing names c-loose (only its label).
      await command('createEntity', { sceneId: main, kind: 'group', name: 'Start sound', components: { audioSource: { assetId: 'a-start', volume: 1, range: 10 } } });
      await command('createEntity', { sceneId: 'scene-later', kind: 'group', name: 'Later sound', components: { audioSource: { assetId: 'b-later', volume: 1, range: 10 } } });
      await command('createEntity', { sceneId: 'scene-later', kind: 'group', name: 'Moved sound', components: { audioSource: { assetId: 'd-moved', volume: 1, range: 10 } } });

      // Nothing is missing yet.
      expect((await problems()).missingFiles).toMatchObject({ total: 0, files: [] });

      // Outside the editor: one file deleted, one moved without its .tlasset file, one deleted that nothing names.
      unlinkSync(join(dir, 'assets', 'sfx', 'b-later.wav'));
      unlinkSync(join(dir, 'assets', 'sfx', 'c-loose.wav'));
      mkdirSync(join(dir, 'elsewhere'), { recursive: true });
      renameSync(join(dir, 'assets', 'sfx', 'd-moved.wav'), join(dir, 'elsewhere', 'd-moved.wav'));
      await checkFiles();
      const listed = await problems();
      expect(listed.missingFiles.total).toBe(3);
      expect(listed.missingFiles.files.map((f) => f.path)).toEqual(['assets/sfx/b-later.wav', 'assets/sfx/c-loose.wav', 'assets/sfx/d-moved.wav']);
      expect(listed.missingFiles.files.find((f) => f.assetId === 'b-later')?.usedBy).toEqual([{ kind: 'scene', id: 'scene-later' }]);
      expect(listed.missingFiles.files.find((f) => f.assetId === 'c-loose')?.usedBy).toEqual([]);
      // One Problems line names the count and the first files.
      const line = listed.problems.filter((p) => p.code === 'asset_files_missing');
      expect(line).toHaveLength(1);
      expect(line[0]!.message).toContain('3 asset files are missing');
      expect(line[0]!.message).toContain('assets/sfx/b-later.wav');
      // The list pages.
      const second = await get('/problems/missing-files?offset=1&limit=1');
      expect(second.status).toBe(200);
      expect(second.json).toMatchObject({ total: 3, offset: 1, files: [{ assetId: 'c-loose' }] });
      expect((await get('/problems/missing-files?limit=0')).status).toBe(400);
      // A second check of the same state adds no line.
      await checkFiles();
      expect((await problems()).problems.filter((p) => p.code === 'asset_files_missing')).toHaveLength(1);

      // Play: none of the three is drawn by the start scene; it starts with placeholders for them.
      const sid = mkSessionId();
      const est = await establish(tb, sid);
      const ws = await upgrade(tb, sid, est.wsToken);
      await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
      const editor = new FakeEditor(ws);
      const play = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
      expect(play.status, JSON.stringify(play.json)).toBe(200);
      const started = play.json as { playSessionId: string; placeholders: PlayFile[]; playContent: { path: string } };
      expect(started.placeholders.map((p) => [p.assetId, p.path, p.inStart])).toEqual([
        ['b-later', 'assets/sfx/b-later.wav', false],
        ['c-loose', 'assets/sfx/c-loose.wav', false],
        ['d-moved', 'assets/sfx/d-moved.wav', false],
      ]);
      // Each ships as a placeholder (a short silent WAV under its own digest); the present file ships as itself.
      const rows = playContentOf(tb, started.playSessionId).assets as { assetId: string; sourceDigest: string }[];
      expect(rows.find((r) => r.assetId === 'a-start')?.sourceDigest).toBe(sha(variant(0)));
      const standIn = rows.find((r) => r.assetId === 'b-later')!;
      expect(standIn.sourceDigest).not.toBe(sha(variant(1)));
      const served = await fetch(`${tb.prevUrl}${started.playContent.path}content/sha256/${standIn.sourceDigest}`);
      expect(served.status).toBe(200);
      const bytes = new Uint8Array(await served.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('RIFF');
      expect(sha(bytes)).toBe(standIn.sourceDigest);
      expect((await problems()).problems.some((p) => p.code === 'play_placeholders' && p.message.includes('3 missing files'))).toBe(true);
      await editor.waitUntil(() => tb.backend._test.plays.get(started.playSessionId)?.state === 'presented');
      await api(`${tb.authUrl}/api/v1/projects/${PID}/play/${started.playSessionId}/stop`, { body: {}, token: tb.authToken });
      await editor.waitForEvent('play.stopped');

      // The start scene's own sound goes missing too: the Play refuses, naming all four at once.
      unlinkSync(join(dir, 'assets', 'sfx', 'a-start.wav'));
      await checkFiles();
      expect((await problems()).missingFiles.total).toBe(4);
      const refused = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      const err = (refused.json as { error: { code: string; message: string; missingFiles: PlayFile[] } }).error;
      expect(err.code).toBe('asset_source_missing');
      expect(err.message).toContain('4 asset files are missing (1 drawn by the start scenes)');
      expect(err.missingFiles.map((f) => [f.assetId, f.inStart])).toEqual([
        ['a-start', true],
        ['b-later', false],
        ['c-loose', false],
        ['d-moved', false],
      ]);

      // An export refuses any missing file, naming them all.
      const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
      expect(exported.status).toBeGreaterThanOrEqual(400);
      expect(((exported.json as { error: { missingFiles?: PlayFile[] } }).error.missingFiles ?? []).map((f) => f.assetId)).toEqual(['a-start', 'b-later', 'c-loose', 'd-moved']);

      // The files come back (the moved one returns to its place): the list empties and the log says so.
      writeFileSync(join(dir, 'assets', 'sfx', 'a-start.wav'), variant(0));
      writeFileSync(join(dir, 'assets', 'sfx', 'b-later.wav'), variant(1));
      writeFileSync(join(dir, 'assets', 'sfx', 'c-loose.wav'), variant(2));
      renameSync(join(dir, 'elsewhere', 'd-moved.wav'), join(dir, 'assets', 'sfx', 'd-moved.wav'));
      await checkFiles();
      const back = await problems();
      expect(back.missingFiles.total).toBe(0);
      expect(back.problems.at(-1)?.code).toBe('asset_files_found');
      editor.close();
    } finally {
      await tb.teardown();
      rmSync(exportRoot, { recursive: true, force: true });
    }
  }, 180_000);

  it('are walked again after an asset-record change, and after a material edit only while some are listed', async () => {
    const tb: TestBackend = await startBackend({ engineRoot: REPO });
    const dir = join(tb.root, 'data', 'projects', PID);
    const revision = (): number => {
      const r = tb.backend._test.service.readCapturedV3(PID);
      if (!r.ok) throw new Error(r.error.code);
      return r.read.revision;
    };
    const command = async (op: string, args: Record<string, unknown>): Promise<void> => {
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'missing-files-test' }, args }, token: tb.adminToken, origin: null });
      expect(r.status, `${op}: ${JSON.stringify(r.json)}`).toBe(200);
    };
    const problems = async (): Promise<{ missingFiles: { total: number } }> =>
      (await api(`${tb.authUrl}/api/v1/projects/${PID}/problems`, { method: 'GET', token: tb.adminToken, origin: null })).json as never;
    const walks = vi.spyOn(tb.backend._test.service, 'missingAssetFiles');
    // The scheduled walk runs 25 ms after a change; an absent walk is waited for well past it.
    const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 200));
    const material = (n: number) => ({ material: { materialId: 'mat-walk', name: `Walk ${n}`, shader: 'unlit', params: {}, textures: {} } });
    try {
      mkdirSync(join(dir, 'assets', 'walk'), { recursive: true });
      writeFileSync(join(dir, 'assets', 'walk', 'one.wav'), variant(0));
      expect((await problems()).missingFiles.total).toBe(0);
      await command('importAssets', { folder: 'assets/walk' });
      await settle();
      const afterImport = walks.mock.calls.length;
      expect(afterImport).toBeGreaterThanOrEqual(2);
      // Nothing listed: material edits read no files.
      for (let i = 0; i < 5; i++) await command('setMaterial', material(i));
      await settle();
      expect(walks.mock.calls.length).toBe(afterImport);
      // A file goes missing: a material edit now walks again, so the listed files' uses stay current.
      unlinkSync(join(dir, 'assets', 'walk', 'one.wav'));
      const check = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
      expect(check.status).toBe(200);
      expect((await problems()).missingFiles.total).toBe(1);
      const listed = walks.mock.calls.length;
      await command('setMaterial', material(9));
      await expect.poll(() => walks.mock.calls.length).toBe(listed + 1);
    } finally {
      walks.mockRestore();
      await tb.teardown();
    }
  }, 120_000);
});
