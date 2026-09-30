/**
 * Folder import and upload folders at the HTTP boundary, on a project in the
 * data root (its own folder is its game folder):
 *
 * - `importAssets {folder, labels}` brings every supported file of a folder,
 *   recursively, in as assets named after their files, in one command (one
 *   revision, one undo), with the labels on every record and sidecar; files
 *   no importer takes are reported; two files of one name get two ids;
 * - undo forgets the assets (files stay, sidecars go), redo brings them
 *   back; importing the folder again adds only what is new;
 * - an uploaded file is written into the folder named, never over another
 *   file, never into a hidden folder or the project's own files; a
 *   `publishAsset` of uploaded bytes lands in the folder it names;
 * - a whole folder moved outside the editor (with its sidecars) keeps its
 *   assets: "check files" re-points every one.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, mkRequestId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const OPUS = readFileSync(join(REPO, 'fixtures', 'music', 'chord-opus.ogg'));
const WAV = readFileSync(join(REPO, 'fixtures', 'm3', 'media', 'wav', 'cue-jump.wav'));
const GLB = readFileSync(join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v1.glb'));
const GLB2 = readFileSync(join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v2.glb'));
const PID = 'demo-0001';

/** A mono 16-bit PCM WAV of `seconds` at 48 kHz (longer than the short-sound profile takes). */
function longWav(seconds: number): Uint8Array {
  const samples = 48_000 * seconds;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48_000, 24);
  b.writeUInt32LE(96_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(Math.round(Math.sin(i / 20) * 8000), 44 + i * 2);
  return new Uint8Array(b);
}

type Record_ = { assetId: string; kind: string; displayName: string; labels?: string[]; versions: { sourcePath?: string }[] };

describe('folder import and upload folders over HTTP (a project in the data root)', () => {
  let tb: TestBackend;
  const dir = (): string => join(tb.root, 'data', 'projects', PID);
  const put = (rel: string, bytes: Uint8Array): void => {
    mkdirSync(join(dir(), ...rel.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir(), ...rel.split('/')), bytes);
  };
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Record<string, unknown>) =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'folder-import-test' }, args }, token: tb.adminToken, origin: null });
  // Each asset's record is in its sidecar (a data-root project is its own game folder).
  const assets = (): Record_[] => {
    const out: Record_[] = [];
    const walk = (abs: string): void => {
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(abs, e.name));
        else if (e.name.endsWith('.tlasset')) {
          const doc = JSON.parse(readFileSync(join(abs, e.name), 'utf8')) as { record?: Record_ };
          if (doc.record !== undefined) out.push(doc.record);
        }
      }
    };
    walk(join(dir(), 'assets'));
    return out;
  };
  const sidecar = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(), ...`${rel}.tlasset`.split('/')), 'utf8')) as Record<string, unknown>;
  const upload = async (bytes: Uint8Array): Promise<string> => {
    const created = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages`, { body: {}, token: tb.adminToken, origin: null });
    const stageId = (created.json as { stageId: string }).stageId;
    const res = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stageId}/bytes`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(bytes.length) },
      body: new Uint8Array(bytes),
    });
    expect(res.status).toBe(200);
    return stageId;
  };
  const fileStage = async (stageId: string, path: string) => api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stageId}/file`, { body: { path }, token: tb.adminToken, origin: null });

  beforeAll(async () => {
    tb = await startBackend();
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('imports a folder recursively in one command with labels; undo, redo, a second import adds only new files', async () => {
    put('assets/audio/voice/line-001.ogg', OPUS);
    put('assets/audio/voice/Line 002.ogg', OPUS);
    put('assets/audio/voice/act2/line-001.ogg', OPUS);
    put('assets/audio/hit.wav', WAV);
    put('assets/audio/long take.wav', longWav(3));
    put('assets/audio/notes.txt', new TextEncoder().encode('not an asset'));
    put('assets/audio/.hidden.ogg', OPUS);
    // A file copied from another project keeps the id its sidecar names.
    put('assets/audio/sting.ogg', OPUS);
    writeFileSync(join(dir(), 'assets', 'audio', 'sting.ogg.tlasset'), JSON.stringify({ tlasset: 1, id: 'sting-from-elsewhere', kind: 'music', importSettings: {}, labels: ['music'], address: null }));
    const before = revision();

    const r = await command('importAssets', { folder: 'assets/audio', labels: ['voice', 'act-1'] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const body = r.json as { revision: number; change: { type: string; added: Record_[] }; folderImport: { prepared: number; skipped: unknown[]; unsupported: { path: string }[]; rejected: unknown[] } };
    expect(body.revision).toBe(before + 1);
    expect(body.change.type).toBe('importAssets');
    expect(body.folderImport.prepared).toBe(6);
    expect(body.folderImport.rejected).toEqual([]);
    expect(body.folderImport.unsupported.map((u) => u.path)).toEqual(['assets/audio/notes.txt']);

    const byPath = new Map(assets().map((a) => [a.versions[0]!.sourcePath, a]));
    expect([...byPath.keys()].sort()).toEqual([
      'assets/audio/hit.wav',
      'assets/audio/long take.wav',
      'assets/audio/sting.ogg',
      'assets/audio/voice/Line 002.ogg',
      'assets/audio/voice/act2/line-001.ogg',
      'assets/audio/voice/line-001.ogg',
    ]);
    // Named after the file; one name in two folders is two ids.
    expect(byPath.get('assets/audio/voice/line-001.ogg')).toMatchObject({ displayName: 'line-001', kind: 'music' });
    expect(byPath.get('assets/audio/voice/act2/line-001.ogg')).toMatchObject({ displayName: 'line-001' });
    expect(byPath.get('assets/audio/voice/line-001.ogg')!.assetId).toBe('line-001');
    expect(byPath.get('assets/audio/voice/act2/line-001.ogg')!.assetId).toBe('line-001-2');
    expect(byPath.get('assets/audio/voice/Line 002.ogg')).toMatchObject({ assetId: 'line-002', displayName: 'Line 002' });
    // A short WAV is a sound; a longer one the kind that takes any length.
    expect(byPath.get('assets/audio/hit.wav')).toMatchObject({ assetId: 'hit', kind: 'audio' });
    expect(byPath.get('assets/audio/long take.wav')).toMatchObject({ assetId: 'long-take', kind: 'music' });
    expect(byPath.get('assets/audio/sting.ogg')).toMatchObject({ assetId: 'sting-from-elsewhere', labels: ['act-1', 'music', 'voice'] });
    for (const a of byPath.values()) expect(a.labels).toEqual(expect.arrayContaining(['act-1', 'voice']));
    // The labels are in the sidecars and readable through the asset query.
    expect(sidecar('assets/audio/voice/line-001.ogg')).toMatchObject({ id: 'line-001', kind: 'music', labels: ['act-1', 'voice'] });
    const q = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryAssets', projectId: PID, args: { assetId: 'hit' } }, token: tb.adminToken, origin: null });
    expect(JSON.stringify(q.json)).toContain('"labels":["act-1","voice"]');

    // One undo forgets them all: the files stay, the sidecars go.
    const undo = await command('undo', {});
    expect(undo.status, JSON.stringify(undo.json)).toBe(200);
    expect(assets()).toEqual([]);
    expect(existsSync(join(dir(), 'assets', 'audio', 'voice', 'line-001.ogg'))).toBe(true);
    expect(existsSync(join(dir(), 'assets', 'audio', 'voice', 'line-001.ogg.tlasset'))).toBe(false);
    const redo = await command('redo', {});
    expect(redo.status, JSON.stringify(redo.json)).toBe(200);
    expect(assets()).toHaveLength(6);
    expect(sidecar('assets/audio/hit.wav')).toMatchObject({ id: 'hit', labels: ['act-1', 'voice'] });

    // Again: nothing new is refused (no change), and what is there is listed as skipped.
    const again = await command('importAssets', { folder: 'assets/audio' });
    expect(again.status).toBe(400);
    expect(again.json).toMatchObject({ ok: false, error: { code: 'no_change' }, folderImport: { prepared: 0 } });
    expect((again.json as { folderImport: { skipped: unknown[] } }).folderImport.skipped).toHaveLength(6);
    // A new file in the folder: only it comes in.
    put('assets/audio/voice/line-003.ogg', OPUS);
    const more = await command('importAssets', { folder: 'assets/audio/voice', labels: ['voice'] });
    expect(more.status, JSON.stringify(more.json)).toBe(200);
    expect((more.json as { change: { added: Record_[] } }).change.added.map((a) => a.assetId)).toEqual(['line-003']);

    // The recorded import survives a reopen (its retry record is valid), and undo still works after it.
    expect(tb.backend._test.service.releaseWorkspace(PID).ok).toBe(true);
    expect(revision()).toBe((more.json as { revision: number }).revision);
    expect(assets()).toHaveLength(7);
  }, 60_000);

  it('refuses folders outside the game folder, hidden or the project\'s own', async () => {
    for (const folder of ['../elsewhere', '.thirdlight', 'scenes', 'cache/imported', '', 'assets/../..', 'missing-folder']) {
      const r = await command('importAssets', { folder });
      expect(r.status, folder).toBe(400);
      expect((r.json as { ok: boolean }).ok).toBe(false);
    }
  });

  it('writes an uploaded file into the folder named; never over another file, never into hidden or own folders', async () => {
    const s1 = await upload(GLB);
    const w = await fileStage(s1, 'assets/dropped/props/crate.glb');
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    expect(readFileSync(join(dir(), 'assets', 'dropped', 'props', 'crate.glb')).equals(GLB)).toBe(true);
    const s2 = await upload(GLB2);
    expect((await fileStage(s2, 'assets/dropped/props/crate.glb')).status).toBe(400);
    for (const path of ['.thirdlight/x.glb', 'project.json', 'scenes/x.glb', 'content.json', '../x.glb', 'x.glb', 'assets/.git/x.glb']) {
      const r = await fileStage(s2, path);
      expect(r.status, path).toBe(400);
    }
    expect(readFileSync(join(dir(), 'project.json'), 'utf8')).toContain('"schemaVersion"');
    // The dropped folder is imported like any other.
    const r = await command('importAssets', { folder: 'assets/dropped', labels: ['props'] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(assets().find((a) => a.assetId === 'crate')).toMatchObject({ kind: 'model', labels: ['props'], versions: [{ sourcePath: 'assets/dropped/props/crate.glb' }] });
  });

  it('files an uploaded publish into the folder it names', async () => {
    const stageId = await upload(GLB2);
    const inspected = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stageId}/inspect`, { body: {}, token: tb.adminToken, origin: null });
    expect(inspected.status, JSON.stringify(inspected.json)).toBe(200);
    const p = (inspected.json as { proposal: { sourceDigest: string; sourceByteLength: number; importRecipe: unknown; metrics: unknown } }).proposal;
    const facts = { mode: 'create', assetId: 'barrel', kind: 'model', displayName: 'Barrel', sourceDigest: p.sourceDigest, sourceByteLength: p.sourceByteLength, importRecipe: p.importRecipe, metrics: p.metrics, importedAt: '2026-09-29T00:00:00Z' };
    expect((await command('publishAsset', { ...facts, folder: '.thirdlight' })).status).toBe(400);
    expect((await command('publishAsset', { ...facts, folder: 'sources' })).status).toBe(400);
    const r = await command('publishAsset', { ...facts, folder: 'assets/props/barrels' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const file = join(dir(), 'assets', 'props', 'barrels', 'Barrel.glb');
    expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(p.sourceDigest);
    expect(sidecar('assets/props/barrels/Barrel.glb')).toMatchObject({ id: 'barrel', kind: 'model' });
  });

  it('keeps every asset of a folder moved outside the editor with its sidecars', async () => {
    const ids = assets().filter((a) => a.versions[0]!.sourcePath!.startsWith('assets/audio/')).map((a) => a.assetId).sort();
    expect(ids.length).toBe(7);
    renameSync(join(dir(), 'assets', 'audio'), join(dir(), 'assets', 'sound'));
    const check = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
    expect(check.status, JSON.stringify(check.json)).toBe(200);
    const relocated = (check.json as { check: { relocated: { assetId: string; to: string }[]; failed: unknown[] } }).check;
    expect(relocated.failed).toEqual([]);
    expect(relocated.relocated.map((r) => r.assetId).sort()).toEqual(ids);
    for (const a of assets().filter((x) => ids.includes(x.assetId))) expect(a.versions[0]!.sourcePath!.startsWith('assets/sound/')).toBe(true);
    expect(assets().find((a) => a.assetId === 'line-001-2')!.versions[0]!.sourcePath).toBe('assets/sound/voice/act2/line-001.ogg');
    // The labels stay with the assets.
    expect(sidecar('assets/sound/voice/act2/line-001.ogg')).toMatchObject({ id: 'line-001-2', labels: ['act-1', 'voice'] });
  });
});

