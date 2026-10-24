/**
 * The project format after the engine/game separation, at the
 * HTTP boundary. A schemaVersion 2 project (written by hand in
 * `fixtures/phase24`, not copied from a game) is copied into the backend's
 * data root and opened with POST /api/v1/sessions:
 *
 * - generic data is upgraded (pickups → collectibles with the old counter
 *   names, a spawn facing → a yaw, the session player's health fields and
 *   `content.game: null` dropped) and written back as schemaVersion 4;
 * - game data is refused: the open fails with problems that name each
 *   removed component and tell the user to build it as project scripts —
 *   nothing is dropped silently, and the files stay as they were.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { TRIM_DATA_GLTF_ATTRIBUTE } from '@thirdlight/project-model/trim-sheet';

import { writeGlb } from './glb-images';
import { api, AUTHORING_ORIGIN, exportContentOf, mkRequestId, mkSessionId, PREVIEW_ORIGIN, startBackend, type TestBackend } from './test-helpers';
import { createTestBackend } from './testing';

const FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'phase24');

describe('a schemaVersion 2 project opened over HTTP', () => {
  let tb: TestBackend;
  const projectDir = (id: string): string => join(tb.root, 'data', 'projects', id);
  const readJson = (id: string, rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(projectDir(id), rel), 'utf8')) as Record<string, unknown>;

  beforeAll(async () => {
    tb = await startBackend({ tokens: [] });
    for (const id of ['legacy-v2-upgradable', 'legacy-v2-refused']) cpSync(join(FIXTURES, id), projectDir(id), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('upgrades the generic data and writes the project back as schemaVersion 7', async () => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'legacy-v2-upgradable', sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'format-upgrade' } },
      token: tb.adminToken,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const j = r.json as { revision: number; scene: { entities: Array<{ id: string; components: Record<string, unknown> }> }; content?: Record<string, unknown> };
    // One new revision for the upgrade (the files were at 3).
    expect(j.revision).toBe(4);
    const comps = (id: string): Record<string, unknown> => j.scene.entities.find((e) => e.id === id)!.components;
    expect(comps('spawn-0001')['playerSpawn']).toEqual({ yaw: 90 });
    expect(comps('box-0001')['pickup']).toBeUndefined();
    expect(comps('box-0001')['collectible']).toEqual({ counter: 'coins', size: [0.5, 0.5] });
    expect(comps('box-0002')['collectible']).toEqual({ counter: 'stars', amount: 5 });
    expect(comps('box-0003')['health']).toEqual({ max: 3 });

    // On disk: the manifest says 7 (2 → 3 → 4 → 5 → 6 → 7 in one open), content.json has no game key, the scene file the upgraded components.
    expect(readJson('legacy-v2-upgradable', 'project.json')['schemaVersion']).toBe(7);
    const content = readJson('legacy-v2-upgradable', 'content.json');
    expect(content['revision']).toBe(4);
    expect('game' in (content['content'] as Record<string, unknown>)).toBe(false);
    const scene = readJson('legacy-v2-upgradable', 'scenes/scene-main.json')['scene'] as { entities: Array<{ id: string; components: Record<string, unknown> }> };
    expect(scene.entities.find((e) => e.id === 'box-0001')!.components['collectible']).toEqual({ counter: 'coins', size: [0.5, 0.5] });
    expect(scene.entities.find((e) => e.id === 'spawn-0001')!.components['playerSpawn']).toEqual({ yaw: 90 });
  });

  it('refuses the game data, naming each removed component, and leaves the files untouched', async () => {
    const before = readFileSync(join(projectDir('legacy-v2-refused'), 'scenes', 'scene-main.json'));
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: 'legacy-v2-refused', sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'format-upgrade' } },
      token: tb.adminToken,
    });
    expect(r.status).not.toBe(200);
    const err = (r.json as { error: { code: string; reason: string; details?: Array<{ path: string; message: string; sceneId?: string }>; detailCount?: number } }).error;
    expect(err.code, JSON.stringify(err)).toBe('project_unavailable');
    const details = err.details ?? [];
    expect(details.length, JSON.stringify(err)).toBe(5);
    const byPath = new Map(details.map((d) => [d.path, d.message]));
    expect(byPath.get('/game')).toContain('content.game');
    expect(byPath.get('/entities/0/components/cameraFollow')).toContain('component "cameraFollow"');
    expect(byPath.get('/entities/2/components/enemy')).toContain('component "enemy"');
    expect(byPath.get('/entities/3/components/gameZone')).toContain('component "gameZone"');
    expect(byPath.get('/entities/4/components/pickup')).toContain('a heart healed the player');
    for (const d of details) expect(d.message).toContain('removed from the engine: build it as project scripts');
    // Nothing was written.
    expect(readFileSync(join(projectDir('legacy-v2-refused'), 'scenes', 'scene-main.json')).equals(before)).toBe(true);
    expect(readJson('legacy-v2-refused', 'project.json')['schemaVersion']).toBe(2);

    // The project list says why it does not load.
    const list = await fetch(`${tb.authUrl}/api/v1/projects`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
    const body = (await list.json()) as { projects: Array<{ projectId: string; loadable: boolean; code?: string; note?: string }> };
    const refused = body.projects.find((p) => p.projectId === 'legacy-v2-refused');
    expect(refused).toMatchObject({ loadable: false, code: 'content_invalid' });
    expect(refused?.note).toContain('removed from the engine');
    expect(body.projects.find((p) => p.projectId === 'legacy-v2-upgradable')).toMatchObject({ loadable: true });
  });
});

/**
 * A schemaVersion 3 project with the old four-digit ids
 * (`fixtures/phase25/legacy-v3-ids`, written by hand) opens over HTTP, is
 * written back as schemaVersion 4 with every id and reference unchanged, and
 * new objects get six-digit ids, unique across the project's scenes.
 */
describe('a schemaVersion 3 project with four-digit ids opened over HTTP', () => {
  const FIXTURES_25 = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'phase25');
  const ID = 'legacy-v3-ids';
  let tb: TestBackend;
  const projectDir = (): string => join(tb.root, 'data', 'projects', ID);
  const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(projectDir(), rel), 'utf8')) as Record<string, unknown>;
  type Ent = { id: string; parentId?: string; components: Record<string, unknown> };

  beforeAll(async () => {
    tb = await startBackend({ tokens: [] });
    cpSync(join(FIXTURES_25, ID), projectDir(), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('keeps the old ids, writes schemaVersion 7, and gives new objects six-digit ids unique across scenes', async () => {
    const before = readJson('scenes/scene-b.json');
    const r = await api(`${tb.authUrl}/api/v1/sessions`, {
      body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'format-upgrade-25' } },
      token: tb.adminToken,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const j = r.json as { revision: number; scene: { entities: Ent[] } };
    // One new revision for the upgrade (the files were at 3).
    expect(j.revision).toBe(4);
    // The session's scene view carries every scene's objects.
    expect(j.scene.entities.map((e) => e.id)).toEqual(['cam-main', 'light-0001', 'light-0002', 'spawn-0001', 'box-0001', 'group-0001', 'box-0002', 'box-0003', 'spawn-0002']);
    expect(j.scene.entities.find((e) => e.id === 'box-0002')!.parentId).toBe('group-0001');

    // On disk: the manifest says 7; the scene files keep their ids.
    expect(readJson('project.json')['schemaVersion']).toBe(7);
    const sceneB = readJson('scenes/scene-b.json')['scene'] as { revision: number; entities: Ent[] };
    expect(sceneB.revision).toBe(4);
    expect(sceneB.entities).toEqual((before['scene'] as { entities: Ent[] }).entities);

    const command = async (revision: number, args: Record<string, unknown>): Promise<{ ok: boolean; revision: number; createdId: string }> => {
      const res = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, {
        body: { op: 'createEntity', projectId: ID, requestId: `req-${String(revision).padStart(32, 'a')}`, expectedRevision: revision, args, origin: { kind: 'mcp', clientId: 'format-upgrade-25' } },
        token: tb.adminToken,
        origin: null,
      });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      return res.json as { ok: boolean; revision: number; createdId: string };
    };
    // New ids: six digits, never colliding with the old ones or with another scene's.
    const a = await command(4, { kind: 'box', name: 'New Crate', parentId: 'group-0001' });
    expect(a.createdId).toBe('box-000001');
    const b = await command(5, { kind: 'box', name: 'Far Crate', sceneId: 'scene-b' });
    expect(b.createdId).toBe('box-000002');
    const c = await command(6, { kind: 'group', name: 'Far Group', sceneId: 'scene-b' });
    expect(c.createdId).toBe('group-000001');
    const main = (readJson('scenes/scene-main.json')['scene'] as { entities: Ent[] }).entities;
    expect(main.find((e) => e.id === 'box-000001')!.parentId).toBe('group-0001');
    const far = (readJson('scenes/scene-b.json')['scene'] as { entities: Ent[] }).entities.map((e) => e.id);
    expect(far).toEqual(['box-0003', 'spawn-0002', 'box-000002', 'group-000001']);
  });
});

/**
 * A schemaVersion 4 project whose assets are stored versions in
 * `sources/sha256/` (`fixtures/phase26/legacy-v4-assets`, written by the
 * engine before the asset-file format) opens over HTTP as schemaVersion 7 (5, 6, then 7 on the same open):
 * each asset's current version becomes a file with its `.tlasset` sidecar
 * (the KTX2 texture's PNG is the file, the KTX2 goes to the import cache),
 * the older version stays in `sources/` and is listed in the report, the
 * recorded retry replays, and the export ships the same asset bytes.
 */
describe('a schemaVersion 4 project with stored asset versions opened over HTTP', () => {
  const FIXTURE = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'phase26', 'legacy-v4-assets');
  const ID = 'legacy-v4-assets';
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (): string => join(tb.root, 'data', 'projects', ID);
  const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(), rel), 'utf8')) as Record<string, unknown>;
  const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
  const REPO = resolve(import.meta.dirname, '..', '..', '..');

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-upgrade-export-'));
    tb = await startBackend({ tokens: [], exportRoot, engineRoot: REPO });
    cpSync(FIXTURE, dir(), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('writes each current version as a file with its sidecar, keeps the older bytes, replays, exports the same bytes', async () => {
    const blobsBefore = new Map(readdirSync(join(FIXTURE, 'sources', 'sha256')).map((n) => [n, readFileSync(join(FIXTURE, 'sources', 'sha256', n))]));
    const before = JSON.parse(readFileSync(join(FIXTURE, 'content.json'), 'utf8')) as { content: { assets: Array<{ assetId: string; currentVersion: number; versions: Array<{ version: number; sourceDigest: string; convertedFrom?: { sourceDigest: string } }> }> } };
    const current = new Map(before.content.assets.map((a) => [a.assetId, a.versions.find((v) => v.version === a.currentVersion)!]));

    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'format-upgrade-26' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json as { revision: number }).revision).toBe(8);
    expect(readJson('project.json')['schemaVersion']).toBe(7);

    // Each asset's current version is a file in the project's own folder with its sidecar.
    const crate = readFileSync(join(dir(), 'assets', 'Crate.glb'));
    expect(sha(crate)).toBe(current.get('crate')!.sourceDigest);
    expect(readFileSync(join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v2.glb')).equals(crate)).toBe(true);
    const png = readFileSync(join(dir(), 'assets', 'Wall-checker.png'));
    expect(sha(png)).toBe(current.get('wall')!.convertedFrom!.sourceDigest);
    expect(sha(readFileSync(join(dir(), 'assets', 'Beep.wav')))).toBe(current.get('beep')!.sourceDigest);
    const sidecar = (f: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(), 'assets', `${f}.tlasset`), 'utf8')) as Record<string, unknown>;
    expect(sidecar('Crate.glb')).toMatchObject({ tlasset: 3, id: 'crate', kind: 'model' });
    expect(sidecar('Wall-checker.png')).toMatchObject({ id: 'wall', kind: 'texture', importSettings: { ktx2: 'color' } });
    expect(sidecar('Beep.wav')).toMatchObject({ id: 'beep', kind: 'audio' });

    // The records keep the current version only, with its path; each is in its sidecar (content.json keeps the project-wide settings).
    type AssetRow = { assetId: string; currentVersion: number; versions: Array<{ version: number; sourcePath?: string; convertedFrom?: { sourcePath?: string } }> };
    expect(readJson('content.json')['content']).toMatchObject({ assets: [] });
    const content = { assets: ['Crate.glb', 'Wall-checker.png', 'Beep.wav'].map((f) => sidecar(f)['record'] as AssetRow) };
    const crateRecord = content.assets.find((a) => a.assetId === 'crate')!;
    expect(crateRecord.currentVersion).toBe(2);
    expect(crateRecord.versions).toMatchObject([{ version: 2, sourcePath: 'assets/Crate.glb' }]);
    expect(content.assets.find((a) => a.assetId === 'wall')!.versions[0]!.convertedFrom?.sourcePath).toBe('assets/Wall-checker.png');

    // The older version stays in sources/ (every blob untouched) and is listed in the report.
    for (const [name, bytes] of blobsBefore) expect(readFileSync(join(dir(), 'sources', 'sha256', name)).equals(bytes), name).toBe(true);
    const report = readJson('upgrade-report.json') as { from: number; to: number; files: unknown[]; olderVersions: unknown[]; notMoved: unknown[] };
    // The upgrade is reported where the user and MCP look: the project's Problems, naming the report.
    const problems = await api(`${tb.authUrl}/api/v1/projects/${ID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    const upgraded = ((problems.json as { problems: { code: string; message: string }[] }).problems).filter((p) => p.code === 'project_upgraded');
    expect(upgraded.map((p) => p.message).join('\n')).toContain('upgrade-report.json');
    expect(upgraded.some((p) => p.message.includes('1 older asset versions'))).toBe(true);
    expect(report).toMatchObject({ from: 4, to: 5, notMoved: [] });
    expect(report.files).toHaveLength(3);
    const v1 = before.content.assets.find((a) => a.assetId === 'crate')!.versions[0]!;
    expect(report.olderVersions).toEqual([{ assetId: 'crate', version: 1, sourceDigest: v1.sourceDigest, stored: `sources/sha256/${v1.sourceDigest}` }]);

    // The KTX2 made from the PNG is in the import cache, and reads back verified.
    const read = async (assetId: string, version: number): Promise<Uint8Array> => {
      const res = await fetch(`${tb.authUrl}/api/v1/projects/${ID}/content/assets/${assetId}/versions/${version}/bytes`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
      expect(res.status, assetId).toBe(200);
      return new Uint8Array(await res.arrayBuffer());
    };
    expect(sha(await read('wall', 1))).toBe(current.get('wall')!.sourceDigest);
    expect(existsSync(join(dir(), 'cache', 'imported', current.get('wall')!.convertedFrom!.sourceDigest))).toBe(true);
    expect(sha(await read('crate', 2))).toBe(current.get('crate')!.sourceDigest);

    // The last recorded command, sent again, replays its recorded result.
    const replay = JSON.parse(readFileSync(join(FIXTURE, 'replay.json'), 'utf8')) as Record<string, unknown>;
    const again = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: replay, token: tb.adminToken, origin: null });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ ok: true, duplicated: true, revision: 7, requestId: replay['requestId'] });

    // The file check finds nothing to do.
    const check = await api(`${tb.authUrl}/api/v1/projects/${ID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
    expect(check.status, JSON.stringify(check.json)).toBe(200);
    expect((check.json as { check: unknown }).check).toEqual({ resources: { followed: [], adopted: [], reloaded: [], removed: [], problems: [], paused: null }, relocated: [], reimported: [], rebuilt: [], failed: [], sidecarProblems: [], checked: { scope: 'all', visited: 3, reason: 'no full check since the watch started' } });

    // The export ships the placed model's current bytes (what the v4 project shipped), not the older version.
    const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    const shipped = readdirSync(join(exportRoot, String((exported.json as { outputDir: string }).outputDir), 'content', 'sha256'));
    expect(shipped).toContain(current.get('crate')!.sourceDigest);
    expect(shipped).not.toContain(v1.sourceDigest);
  }, 120_000);
});

/**
 * One audio kind. A schemaVersion 5 project written before it
 * (`fixtures/phase26/legacy-v5-music`, made by that engine's folder import:
 * an Ogg Vorbis, an Ogg Opus and a 3 s WAV as `music`, a short WAV of the
 * fixed short-sound profile as `audio`, an object whose audio source plays
 * the long WAV) opens over HTTP with every record `audio`, ids and files
 * kept; the sidecars are written back with their load settings, the audio
 * source still plays its file, the recorded command replays, and Play's
 * manifest carries each file's load settings. The v4 fixture's short-sound
 * record comes through the same upgrade.
 */
describe('a project with music and short-sound records opened over HTTP', () => {
  const REPO = resolve(import.meta.dirname, '..', '..', '..');
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (id: string): string => join(tb.root, 'data', 'projects', id);
  const sidecar = (id: string, f: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(id), 'assets', ...f.split('/')) + '.tlasset', 'utf8')) as Record<string, unknown>;
  type Rec = { assetId: string; kind: string; versions: { sourcePath?: string; importRecipe: { profile: string }; metrics: Record<string, unknown> }[] };

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-audio-upgrade-export-'));
    tb = await startBackend({ tokens: [], exportRoot, engineRoot: REPO });
    for (const id of ['legacy-v5-music', 'legacy-v4-assets']) cpSync(join(REPO, 'fixtures', 'phase26', id), dir(id), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('makes every music and short-sound record audio, ids and files kept, and replays', async () => {
    const ID = 'legacy-v5-music';
    const before = new Map(['audio/Theme.ogg', 'audio/Voice.ogg', 'audio/Rain.wav', 'audio/Hit.wav'].map((f) => [f, readFileSync(join(dir(ID), 'assets', ...f.split('/')))]));
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'audio-upgrade' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // One new revision for the upgrade (the files were at 3).
    expect((r.json as { revision: number }).revision).toBe(4);

    const expected: Record<string, [string, Record<string, unknown>, Record<string, unknown>]> = {
      'audio/Theme.ogg': ['theme', { format: 'ogg-vorbis', channels: 2, sampleRate: 44100, durationMs: 3000 }, { loadType: 'decode-on-load', preload: true }],
      'audio/Voice.ogg': ['voice', { format: 'ogg-opus', channels: 2, sampleRate: 48000, durationMs: 1000 }, { loadType: 'decode-on-load', preload: true }],
      'audio/Rain.wav': ['rain', { format: 'wav', channels: 1, sampleRate: 48000, bitsPerSample: 16, durationMs: 3000 }, { loadType: 'decode-on-load', preload: true }],
      'audio/Hit.wav': ['hit', { format: 'wav', channels: 1, sampleRate: 48000, bitsPerSample: 16, durationMs: 100 }, { loadType: 'decode-on-load', preload: true }],
    };
    for (const [file, [id, metrics, settings]] of Object.entries(expected)) {
      const doc = sidecar(ID, file);
      expect(doc, file).toMatchObject({ tlasset: 3, id, kind: 'audio', importSettings: settings });
      const rec = doc['record'] as Rec;
      expect(rec, file).toMatchObject({ assetId: id, kind: 'audio', versions: [{ sourcePath: `assets/${file}`, importRecipe: { profile: 'audio' } }] });
      expect(rec.versions[0]!.metrics, file).toEqual(metrics);
      // The file itself is untouched.
      expect(readFileSync(join(dir(ID), 'assets', ...file.split('/'))).equals(before.get(file)!)).toBe(true);
    }
    // The audio source still plays its file; the upgrade is reported where the user and MCP look.
    const scene = JSON.parse(readFileSync(join(dir(ID), 'scenes', 'scene-main.json'), 'utf8')) as { scene: { entities: { components: Record<string, unknown> }[] } };
    expect(scene.scene.entities.some((e) => (e.components['audioSource'] as { assetId?: string } | undefined)?.assetId === 'rain')).toBe(true);
    const problems = await api(`${tb.authUrl}/api/v1/projects/${ID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    const upgraded = (problems.json as { problems: { code: string; message: string }[] }).problems.filter((p) => p.code === 'project_upgraded');
    expect(upgraded.map((p) => p.message).join('\n')).toContain('4 audio asset records took the one audio kind');

    // The last recorded command, sent again, replays its recorded result.
    const replay = JSON.parse(readFileSync(join(REPO, 'fixtures', 'phase26', ID, 'replay.json'), 'utf8')) as Record<string, unknown>;
    const again = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: replay, token: tb.adminToken, origin: null });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ ok: true, duplicated: true, revision: 3, requestId: replay['requestId'] });

    // The file check finds nothing to do; a second open changes nothing.
    const check = await api(`${tb.authUrl}/api/v1/projects/${ID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
    expect(check.status, JSON.stringify(check.json)).toBe(200);
    expect((check.json as { check: { reimported: unknown[]; failed: unknown[]; sidecarProblems: unknown[] } }).check).toMatchObject({ reimported: [], failed: [], sidecarProblems: [] });

    // The export's manifest carries each audio file's load settings for the runtime's audio loading.
    const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    const out = join(exportRoot, String((exported.json as { outputDir: string }).outputDir));
    const manifest = exportContentOf(out);
    expect(manifest.assets.find((a) => a['assetId'] === 'rain')).toMatchObject({ kind: 'audio', loadType: 'decode-on-load', preload: true, durationMs: 3000 });
  }, 120_000);

  it("turns the v4 project's short-sound record into audio on the same open that writes its files", async () => {
    const ID = 'legacy-v4-assets';
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'audio-upgrade-v4' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const doc = sidecar(ID, 'Beep.wav');
    expect(doc).toMatchObject({ id: 'beep', kind: 'audio', importSettings: { loadType: 'decode-on-load', preload: true } });
    expect((doc['record'] as Rec).versions[0]!.metrics).toEqual({ format: 'wav', channels: 1, sampleRate: 48000, bitsPerSample: 16, durationMs: 100 });
  }, 60_000);
});

/**
 * Each scene its own look. A schemaVersion 5 project with one project-wide
 * environment (`fixtures/phase27/legacy-v5-environment`, written by that
 * engine through its own backend: two scenes, a gradient sky, linear fog, post,
 * wind, quality medium and a preset) opens over HTTP as schemaVersion 7: the
 * sky, fog, post and wind are copied into both scene files, the content keeps
 * the quality and the preset, the upgrade is reported, the recorded command
 * replays from its record, and the export ships each scene with its look.
 */
describe('a schemaVersion 5 project with one project-wide environment opened over HTTP', () => {
  const REPO = resolve(import.meta.dirname, '..', '..', '..');
  const FIXTURE = join(REPO, 'fixtures', 'phase27', 'legacy-v5-environment');
  const ID = 'legacy-v5-environment';
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (): string => join(tb.root, 'data', 'projects', ID);
  const readJson = (rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(), rel), 'utf8')) as Record<string, unknown>;
  const LOOK = {
    wind: { direction: [0, 1], strength: 1.5, gust: 0.5, gustFrequency: 0.4, turbulence: 0.2 },
    sky: { bottomColor: '#404040', environmentIntensity: 0.8, horizonColor: '#c0d8f0', mode: 'gradient', topColor: '#204080' },
    fog: { color: '#b0c4de', far: 140, mode: 'linear', near: 20 },
    post: { bloom: { enabled: true, strength: 0.4 }, exposure: 1.2, toneMapping: 'aces' },
  };

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-env-upgrade-export-'));
    tb = await startBackend({ tokens: [], exportRoot, engineRoot: REPO });
    cpSync(FIXTURE, dir(), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('copies the look into every scene, keeps quality and presets, replays, and exports each scene with its look', async () => {
    const before = JSON.parse(readFileSync(join(FIXTURE, 'content.json'), 'utf8')) as { content: { environment: Record<string, unknown> } };
    // The fixture is the old format: the look is the project's.
    expect(Object.keys(before.content.environment)).toEqual(['wind', 'sky', 'fog', 'post', 'quality', 'presets']);
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'env-upgrade' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    // One new revision for the upgrade (the files were at 4).
    expect((r.json as { revision: number }).revision).toBe(5);
    expect(readJson('project.json')['schemaVersion']).toBe(7);

    // The content keeps the quality and the preset's id (the preset is its own file, untouched).
    expect((readJson('content.json')['content'] as { environment: unknown }).environment).toEqual({ quality: 'medium', presets: ['dusk'] });
    expect(readFileSync(join(dir(), 'assets', 'environment', 'dusk.envpreset.json')).equals(readFileSync(join(FIXTURE, 'assets', 'environment', 'dusk.envpreset.json')))).toBe(true);
    // Every scene file carries the old look, the objects as they were.
    for (const sceneId of ['scene-main', 'scene-two']) {
      const scene = readJson(`scenes/${sceneId}.json`)['scene'] as { revision: number; environment?: unknown; entities: unknown[] };
      const old = (JSON.parse(readFileSync(join(FIXTURE, 'scenes', `${sceneId}.json`), 'utf8')) as { scene: { entities: unknown[] } }).scene;
      expect(scene.environment, sceneId).toEqual(LOOK);
      // The objects as they were, the scene camera the shot the same open made of it (5 → 6 → 7).
      const asShot = (e: unknown): unknown => {
        const o = e as { id: string; components: Record<string, unknown> };
        if (o.components['camera'] === undefined) return e;
        const { camera: _camera, ...rest } = o.components;
        return { ...o, keepLoaded: true, components: { ...rest, virtualCamera: { rig: 'fixed', priority: -1000 } } };
      };
      expect(scene.entities, sceneId).toEqual(old.entities.map(asShot));
      expect(scene.revision, sceneId).toBe(5);
    }
    // The upgrade is reported where the user and MCP look.
    const problems = await api(`${tb.authUrl}/api/v1/projects/${ID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    const upgraded = (problems.json as { problems: { code: string; message: string }[] }).problems.filter((p) => p.code === 'project_upgraded');
    expect(upgraded.map((p) => p.message).join('\n')).toContain('copied into 2 scenes');

    // The queries: the project part, and each scene's look on request.
    const q = async (op: string, args?: Record<string, unknown>): Promise<Record<string, unknown>> => (await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op, projectId: ID, ...(args !== undefined ? { args } : {}) }, token: tb.adminToken, origin: null })).json as Record<string, unknown>;
    expect((await q('queryGameConfig'))['environment']).toMatchObject({ quality: 'medium', presets: [{ presetId: 'dusk', name: 'Dusk' }] });
    const rows = (await q('queryProject', { environments: true }))['scenes'] as { sceneId: string; environment?: unknown }[];
    expect(rows.map((x) => [x.sceneId, x.environment])).toEqual([['scene-main', LOOK], ['scene-two', LOOK]]);
    expect(((await q('queryProject'))['scenes'] as Record<string, unknown>[]).some((x) => 'environment' in x)).toBe(false);

    // The last recorded command (the old project-wide setEnvironment), sent again, replays its recorded result.
    const replay = JSON.parse(readFileSync(join(FIXTURE, 'replay.json'), 'utf8')) as Record<string, unknown>;
    const again = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: replay, token: tb.adminToken, origin: null });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ ok: true, duplicated: true, revision: 4, requestId: replay['requestId'] });

    // The file check finds nothing to do; the files stay as the upgrade wrote them.
    const files = ['project.json', 'content.json', 'scenes/scene-main.json', 'scenes/scene-two.json'].map((f) => readFileSync(join(dir(), f)));
    const check = await api(`${tb.authUrl}/api/v1/projects/${ID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
    expect(check.status, JSON.stringify(check.json)).toBe(200);
    expect((check.json as { check: { reimported: unknown[]; failed: unknown[]; sidecarProblems: unknown[] } }).check).toMatchObject({ reimported: [], failed: [], sidecarProblems: [] });
    ['project.json', 'content.json', 'scenes/scene-main.json', 'scenes/scene-two.json'].forEach((f, i) => expect(readFileSync(join(dir(), f)).equals(files[i]!), f).toBe(true));

    // The export: the project part in the manifest, each scene's look in its scene file.
    const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    const out = join(exportRoot, String((exported.json as { outputDir: string }).outputDir));
    const manifest = exportContentOf(out) as unknown as { environment?: unknown; scenes?: unknown[] };
    expect(manifest.environment).toMatchObject({ quality: 'medium', presets: [{ presetId: 'dusk' }] });
    expect(manifest.environment).not.toHaveProperty('sky');
    for (const row of (manifest.scenes ?? []) as { sceneId: string; path: string }[]) {
      const doc = JSON.parse(readFileSync(join(out, row.path), 'utf8')) as { environment?: unknown };
      expect(doc.environment, row.sceneId).toEqual(LOOK);
    }
    expect(((manifest.scenes ?? []) as unknown[]).length).toBe(2);
  }, 120_000);

  it('a new scene copies a look or starts from the engine defaults; an undone delete gets its look back', async () => {
    const send = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const rev = Number(((await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op: 'queryProject', projectId: ID }, token: tb.adminToken, origin: null })).json as { revision: number }).revision);
      const res = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op, projectId: ID, requestId: mkRequestId(), expectedRevision: rev, args, origin: { kind: 'mcp', clientId: 'env-scenes' } }, token: tb.adminToken, origin: null });
      return res.json as Record<string, unknown>;
    };
    const lookOf = (sceneId: string): unknown => (readJson(`scenes/${sceneId}.json`)['scene'] as { environment?: unknown }).environment;
    expect((await send('createScene', { sceneId: 'scene-copy', name: 'Copy', environmentFrom: 'scene-two' }))['ok']).toBe(true);
    expect(lookOf('scene-copy')).toEqual(LOOK);
    expect((await send('createScene', { sceneId: 'scene-plain', name: 'Plain' }))['ok']).toBe(true);
    expect(lookOf('scene-plain')).toBeUndefined();
    // A scene's own look: only that scene's file changes.
    const mainBefore = readFileSync(join(dir(), 'scenes', 'scene-main.json'));
    const set = await send('setEnvironment', { sceneId: 'scene-copy', environment: { sky: { mode: 'color', color: '#FF8000' } } });
    expect(set, JSON.stringify(set)).toMatchObject({ ok: true, sceneId: 'scene-copy', change: { type: 'setEnvironment', sceneId: 'scene-copy' } });
    expect(lookOf('scene-copy')).toEqual({ sky: { color: '#ff8000', mode: 'color' } });
    expect(readFileSync(join(dir(), 'scenes', 'scene-main.json')).equals(mainBefore)).toBe(true);
    // Refused: a look without a sceneId, an unknown scene.
    const noScene = await send('setEnvironment', { environment: { sky: { mode: 'color', color: '#000000' } } });
    expect(noScene['ok']).toBe(false);
    expect(JSON.stringify(noScene)).toContain('sceneId');
    expect((await send('setEnvironment', { sceneId: 'nope', environment: {} }))['ok']).toBe(false);
    // Delete the copied scene, undo: it comes back with its look; redo removes it again.
    expect((await send('deleteScene', { sceneId: 'scene-copy' }))['ok']).toBe(true);
    expect(existsSync(join(dir(), 'scenes', 'scene-copy.json'))).toBe(false);
    expect((await send('undo', {}))['ok']).toBe(true);
    expect(lookOf('scene-copy')).toEqual({ sky: { color: '#ff8000', mode: 'color' } });
    expect((await send('redo', {}))['ok']).toBe(true);
    expect(existsSync(join(dir(), 'scenes', 'scene-copy.json'))).toBe(false);
    // Undo, then undo the look: the copied look again.
    expect((await send('undo', {}))['ok']).toBe(true);
    expect((await send('undo', {}))['ok']).toBe(true);
    expect(lookOf('scene-copy')).toEqual(LOOK);
  }, 60_000);
});

/**
 * The engine owns the view. Two schemaVersion 6 projects written by that
 * engine (`fixtures/phase28`), shaped like each of the two game projects': a
 * camera entity in a start scene with its own lens next to a level scene with
 * a virtual camera, and a title scene holding the camera and the player
 * (the README names the games). Opened over HTTP each becomes schemaVersion 7 in one new revision:
 * the scene camera is a fixed virtual camera at the lowest priority, its lens
 * the project's camera settings, the camera and the player keep loaded, the
 * recorded command replays and the export ships the shots and the lens.
 */
describe('a schemaVersion 6 project with a scene camera opened over HTTP', () => {
  const REPO = resolve(import.meta.dirname, '..', '..', '..');
  type Ent = { id: string; keepLoaded?: boolean; components: Record<string, unknown> };
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (id: string): string => join(tb.root, 'data', 'projects', id);
  const readJson = (id: string, rel: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(id), rel), 'utf8')) as Record<string, unknown>;
  const entitiesOf = (id: string, sceneId: string): Ent[] => (readJson(id, `scenes/${sceneId}.json`)['scene'] as { entities: Ent[] }).entities;
  const fixtureEntities = (id: string, sceneId: string): Ent[] => (JSON.parse(readFileSync(join(REPO, 'fixtures', 'phase28', id, 'scenes', `${sceneId}.json`), 'utf8')) as { scene: { entities: Ent[] } }).scene.entities;
  const open = async (id: string): Promise<number> => {
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: id, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'view-upgrade' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return (r.json as { revision: number }).revision;
  };
  const replay = async (id: string): Promise<void> => {
    const body = JSON.parse(readFileSync(join(REPO, 'fixtures', 'phase28', id, 'replay.json'), 'utf8')) as Record<string, unknown>;
    const again = await api(`${tb.authUrl}/api/v1/projects/${id}/commands`, { body, token: tb.adminToken, origin: null });
    expect(again.status, JSON.stringify(again.json)).toBe(200);
    expect(again.json).toMatchObject({ ok: true, duplicated: true, requestId: body['requestId'] });
  };
  const upgradeNotes = async (id: string): Promise<string> => {
    const problems = await api(`${tb.authUrl}/api/v1/projects/${id}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    return (problems.json as { problems: { code: string; message: string }[] }).problems.filter((p) => p.code === 'project_upgraded').map((p) => p.message).join('\n');
  };

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-view-upgrade-export-'));
    tb = await startBackend({ tokens: [], exportRoot, engineRoot: REPO });
    for (const id of ['legacy-v6-start-camera', 'legacy-v6-title-player']) cpSync(join(REPO, 'fixtures', 'phase28', id), dir(id), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('a camera entity in a start scene becomes the lowest-priority shot, its lens the project\'s; the level camera is untouched; replays and exports', async () => {
    const ID = 'legacy-v6-start-camera';
    // The files were at 6: one new revision for the upgrade.
    expect(await open(ID)).toBe(7);
    expect(readJson(ID, 'project.json')['schemaVersion']).toBe(7);
    const cam = entitiesOf(ID, 'scene-main').find((e) => e.id === 'cam-main')!;
    const old = fixtureEntities(ID, 'scene-main').find((e) => e.id === 'cam-main')!;
    expect(cam.components['camera']).toBeUndefined();
    expect(cam.components['virtualCamera']).toEqual({ rig: 'fixed', priority: -1000 });
    expect(cam.components['transform']).toEqual(old.components['transform']);
    expect(cam.keepLoaded).toBe(true);
    // The lens is the project's now (every camera without its own uses it).
    expect((readJson(ID, 'content.json')['content'] as { settings: unknown }).settings).toEqual({ physics_dimension: 3, camera_fov_deg: 50, camera_near_m: 0.3, camera_far_m: 400 });
    // The level scene's own virtual camera and tile are as they were (only the revision stamp moved).
    expect(entitiesOf(ID, 'battle')).toEqual(fixtureEntities(ID, 'battle'));
    // The lights are untouched.
    expect(entitiesOf(ID, 'scene-main').filter((e) => e.id !== 'cam-main')).toEqual(fixtureEntities(ID, 'scene-main').filter((e) => e.id !== 'cam-main'));
    const notes = await upgradeNotes(ID);
    expect(notes).toContain('project schemaVersion 6 → 7');
    expect(notes).toContain('"cam-main" (scene "scene-main") became a fixed virtual camera');
    expect(notes).toContain('field of view 50°, near 0.3 m, far 400 m');
    // The last recorded command (it set the scene camera's lens) replays its recorded result.
    await replay(ID);
    // The export ships the lens settings and the shots.
    const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    const out = join(exportRoot, String((exported.json as { outputDir: string }).outputDir));
    const manifest = exportContentOf(out) as unknown as { settings: Record<string, unknown>; scenes: { sceneId: string; path: string }[] };
    expect(manifest.settings).toMatchObject({ camera_fov_deg: 50, camera_near_m: 0.3, camera_far_m: 400 });
    const shipped = (sceneId: string): Ent[] => (JSON.parse(readFileSync(join(out, manifest.scenes.find((s) => s.sceneId === sceneId)!.path), 'utf8')) as { entities: Ent[] }).entities;
    expect(shipped('scene-main').find((e) => e.id === 'cam-main')?.components['virtualCamera']).toEqual({ rig: 'fixed', priority: -1000 });
    expect(shipped('battle').find((e) => e.id === 'group-000001')?.components['virtualCamera']).toEqual({ rig: 'orbitPoint', distance: 15, pitch: 45 });
    // A start with a camera live: the export warns about nothing.
    expect((exported.json as { warnings?: unknown[] }).warnings).toBeUndefined();
  }, 120_000);

  it('a title scene holding the camera and the player: both keep loaded, the default lens stays the default', async () => {
    const ID = 'legacy-v6-title-player';
    expect(await open(ID)).toBe(6);
    expect(readJson(ID, 'project.json')['schemaVersion']).toBe(7);
    const title = entitiesOf(ID, 'scene-main');
    const cam = title.find((e) => e.id === 'cam-main')!;
    expect(cam.components['virtualCamera']).toEqual({ rig: 'fixed', priority: -1000 });
    expect(cam.keepLoaded).toBe(true);
    const player = title.find((e) => e.id === 'box-000001')!;
    expect(player.components['controller']).toBeDefined();
    expect(player.keepLoaded).toBe(true);
    // Nothing else is kept: the spawn and the lights go with their scene.
    expect(title.filter((e) => e.keepLoaded === true).map((e) => e.id).sort()).toEqual(['box-000001', 'cam-main']);
    // The default lens is the engine default: no settings written.
    expect((readJson(ID, 'content.json')['content'] as { settings: unknown }).settings).toEqual({});
    expect(entitiesOf(ID, 'meadow')).toEqual(fixtureEntities(ID, 'meadow'));
    const notes = await upgradeNotes(ID);
    expect(notes).toContain('"cam-main", "box-000001" keep loaded when their scene unloads');
    expect(notes).not.toContain('camera settings');
    await replay(ID);
  }, 120_000);
});

/**
 * Per-vertex local lighting is gone: a project whose scene still stores an
 * object's `localLights: "vertex"` and a light's `importance` opens with
 * them shaded per pixel, written back once, and one Problems line counting
 * them.
 */
describe('a project with per-vertex local-light settings opened over HTTP', () => {
  const REPO = resolve(import.meta.dirname, '..', '..', '..');
  let tb: TestBackend;
  // A small project from before; its scene gets the old settings written into it.
  const ID = 'legacy-v5-music';
  const sceneFile = (): string => join(tb.root, 'data', 'projects', ID, 'scenes', 'scene-main.json');

  beforeAll(async () => {
    tb = await startBackend({ tokens: [] });
    cpSync(join(REPO, 'fixtures', 'phase26', ID), join(tb.root, 'data', 'projects', ID), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('turns them per pixel, drops the importance, writes the scene back and says so once', async () => {
    const file = JSON.parse(readFileSync(sceneFile(), 'utf8')) as { scene: { entities: { id: string; components: Record<string, Record<string, unknown>> }[] } };
    const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    file.scene.entities.push(
      { id: 'vbox-000001', components: { transform: T, box: { size: [1, 1, 1], localLights: 'vertex' } } },
      { id: 'vlamp-000001', components: { transform: T, light: { type: 'point', color: '#ffffff', intensity: 5, importance: 'vertex' } } },
      { id: 'vlamp-000002', components: { transform: T, light: { type: 'point', color: '#ffffff', intensity: 5, importance: 'pixel' } } },
    );
    writeFileSync(sceneFile(), JSON.stringify(file));
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'vertex-lights-upgrade' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const written = JSON.parse(readFileSync(sceneFile(), 'utf8')) as typeof file;
    const byId = new Map(written.scene.entities.map((e) => [e.id, e.components]));
    expect(byId.get('vbox-000001')!['box']!['localLights']).toBe('pixel');
    expect(byId.get('vlamp-000001')!['light']).not.toHaveProperty('importance');
    expect(byId.get('vlamp-000002')!['light']).not.toHaveProperty('importance');
    const problems = await api(`${tb.authUrl}/api/v1/projects/${ID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    const lines = (problems.json as { problems: { code: string; message: string }[] }).problems.filter((p) => p.code === 'project_upgraded' && p.message.includes('per vertex'));
    expect(lines.map((p) => p.message)).toEqual([expect.stringContaining('2 local-light settings (objects, materials, lights) shaded per vertex now shade per pixel')]);
  }, 60_000);
});

/**
 * The built-in grime is gone: a project whose material files still store a
 * trim material's grime params and a layered graph reading the Layer weights
 * node's grime output opens with both taken out (the graph's grime mix folded
 * away, its parameters dropped), the files written back once, and one
 * Problems line naming the materials whose grime was set.
 */
describe('a project with built-in grime opened over HTTP', () => {
  const REPO = resolve(import.meta.dirname, '..', '..', '..');
  let tb: TestBackend;
  const ID = 'legacy-v5-music';
  const materialFile = (id: string): string => join(tb.root, 'data', 'projects', ID, 'assets', 'materials', `${id}.material.json`);
  const write = (data: Record<string, unknown>): void => writeFileSync(materialFile(String(data['materialId'])), JSON.stringify({ tlresource: 1, kind: 'material', id: data['materialId'], data }));
  const edge = (id: string, from: string, fromPort: string, to: string, toPort: string): Record<string, unknown> => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });

  beforeAll(async () => {
    tb = await startBackend({ tokens: [] });
    cpSync(join(REPO, 'fixtures', 'phase26', ID), join(tb.root, 'data', 'projects', ID), { recursive: true });
    mkdirSync(join(tb.root, 'data', 'projects', ID, 'assets', 'materials'), { recursive: true });
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('drops the grime params and graph nodes, writes the materials back and names them once', async () => {
    const trim = { size: [256, 256], texelDensity: 128, padding: 4, rows: [{ slot: 'floor', top: 4, bottom: 124 }] };
    write({ materialId: 'mat-sheet', name: 'Sheet', shader: 'trim', params: { grime: 0.8, grimeColor: '#302010', roughness: 0.6 }, textures: {}, trim });
    write({ materialId: 'mat-clean', name: 'Clean', shader: 'trim', params: { roughness: 0.6 }, textures: {}, trim });
    // A layered graph as stored before: the colour mixed toward grimeColor by the Layer weights node's grime × grime.
    write({
      materialId: 'mat-walls',
      name: 'Walls',
      shader: 'standard',
      params: {},
      textures: {},
      parameters: [{ key: 'tint', type: 'color', default: '#808080' }, { key: 'grime', type: 'float', default: 1 }, { key: 'grimeColor', type: 'color', default: '#3b3328' }],
      graph: {
        nodes: [
          { id: 'output', type: 'pbr', position: [0, 0] },
          { id: 'layerWeights', type: 'layerWeights', position: [0, 0] },
          { id: 'tint', type: 'parameter', position: [0, 0], data: { key: 'tint' } },
          { id: 'grime', type: 'parameter', position: [0, 0], data: { key: 'grime' } },
          { id: 'grimeColor', type: 'parameter', position: [0, 0], data: { key: 'grimeColor' } },
          { id: 'grimeScaled', type: 'multiply', position: [0, 0] },
          { id: 'grimeColourMix', type: 'lerp', position: [0, 0] },
        ],
        edges: [
          edge('e1', 'layerWeights', 'grime', 'grimeScaled', 'a'),
          edge('e2', 'grime', 'value', 'grimeScaled', 'b'),
          edge('e3', 'tint', 'value', 'grimeColourMix', 'a'),
          edge('e4', 'grimeColor', 'value', 'grimeColourMix', 'b'),
          edge('e5', 'grimeScaled', 'out', 'grimeColourMix', 't'),
          edge('e6', 'grimeColourMix', 'out', 'output', 'baseColor'),
          edge('e7', 'layerWeights', 'wetness', 'output', 'roughness'),
        ],
      },
    });
    const clean = readFileSync(materialFile('mat-clean'), 'utf8');
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'grime-upgrade' } }, token: tb.adminToken });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const read = (id: string): Record<string, unknown> => (JSON.parse(readFileSync(materialFile(id), 'utf8')) as { data: Record<string, unknown> }).data;
    expect(read('mat-sheet')['params']).toEqual({ roughness: 0.6 });
    // A material without grime keeps what it stored.
    expect(read('mat-clean')).toEqual((JSON.parse(clean) as { data: unknown }).data);
    const walls = read('mat-walls') as { parameters: { key: string }[]; graph: { nodes: { id: string }[]; edges: { from: { node: string; port: string }; to: { node: string; port: string } }[] } };
    expect(walls.parameters.map((p) => p.key)).toEqual(['tint']);
    expect(walls.graph.nodes.map((n) => n.id).sort()).toEqual(['layerWeights', 'output', 'tint']);
    expect(walls.graph.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}.${e.to.port}`).sort()).toEqual(['layerWeights.wetness>output.roughness', 'tint.value>output.baseColor']);
    const problems = await api(`${tb.authUrl}/api/v1/projects/${ID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
    const lines = (problems.json as { problems: { code: string; message: string }[] }).problems.filter((p) => p.code === 'project_upgraded' && p.message.includes('grime'));
    expect(lines.map((p) => p.message)).toEqual([expect.stringContaining('built-in grime was removed (dirt is a layer of a layered surface, painted like any other): 2 materials had grime set and draw without it now — "Sheet" (mat-sheet), "Walls" (mat-walls)')]);
    // The materials as the backend holds them: valid, and the trim material refuses grime now.
    const q = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op: 'queryProject', projectId: ID, args: {} }, token: tb.adminToken, origin: null });
    const set = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, {
      body: { op: 'setMaterial', projectId: ID, requestId: mkRequestId(), expectedRevision: Number((q.json as { revision: number }).revision), args: { material: { materialId: 'mat-sheet', name: 'Sheet', shader: 'trim', params: { grime: 1 }, textures: {}, trim } }, origin: { kind: 'mcp', clientId: 'grime-upgrade' } },
      token: tb.adminToken,
      origin: null,
    });
    const text = JSON.stringify(set.json);
    expect(text, text).toContain('shader \\"trim\\" has no parameter \\"grime\\"');
  }, 60_000);
});

/**
 * Trim data left in its old places moves at the open, the way a real project
 * held it: a kit model authored with trim data in COLOR_0 (R occlusion,
 * B wetness) on its trim-sheet surface, painted with the old trim meaning
 * (G grime, B wetness) there and with layers on its other surface. Built by
 * one backend through the commands, opened by a new one.
 */
describe('a project with trim data in COLOR_0 and old trim paint opened over HTTP', () => {
  const PID = 'demo-0001';
  /** Two surfaces of four vertices each: `sheet` (mapped to a trim material) and `stone`, both with COLOR_0. */
  const kitPiece = (): Uint8Array => {
    const quad = (z: number): number[] => [-1, 0, z, 1, 0, z, 1, 2, z, -1, 2, z];
    const positions = new Float32Array([...quad(0), ...quad(-0.5)]);
    // COLOR_0 as authored for a trim sheet: R occlusion 0.5, G grime 1, B wetness 0.25.
    const colours = new Float32Array(Array.from({ length: 8 }, () => [0.5, 1, 0.25, 1]).flat());
    const index = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const bin = new Uint8Array(positions.byteLength + colours.byteLength + index.byteLength * 2);
    bin.set(new Uint8Array(positions.buffer), 0);
    bin.set(new Uint8Array(colours.buffer), positions.byteLength);
    bin.set(new Uint8Array(index.buffer), positions.byteLength + colours.byteLength);
    bin.set(new Uint8Array(index.buffer), positions.byteLength + colours.byteLength + index.byteLength);
    const P = positions.byteLength, C = colours.byteLength, I = index.byteLength;
    return writeGlb(
      {
        asset: { version: '2.0' },
        buffers: [{ byteLength: bin.byteLength }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: P / 2 },
          { buffer: 0, byteOffset: P / 2, byteLength: P / 2 },
          { buffer: 0, byteOffset: P, byteLength: C },
          { buffer: 0, byteOffset: P + C, byteLength: I },
        ],
        accessors: [
          { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-1, 0, 0], max: [1, 2, 0] },
          { bufferView: 1, componentType: 5126, count: 4, type: 'VEC3', min: [-1, 0, -0.5], max: [1, 2, -0.5] },
          { bufferView: 2, componentType: 5126, count: 8, type: 'VEC4' },
          { bufferView: 3, componentType: 5123, count: 6, type: 'SCALAR' },
        ],
        materials: [{ name: 'sheet' }, { name: 'stone' }],
        meshes: [{ name: 'piece', primitives: [{ attributes: { POSITION: 0, COLOR_0: 2 }, indices: 3, material: 0 }, { attributes: { POSITION: 1, COLOR_0: 2 }, indices: 3, material: 1 }] }],
        nodes: [{ name: 'piece', mesh: 0 }],
        scenes: [{ nodes: [0] }],
        scene: 0,
      },
      bin,
    );
  };
  // The second primitive's COLOR_0 reads the same accessor from the start: its vertices are the first four colours.

  it('reads the model\'s COLOR_0 as trim data and moves the trim paint\'s wetness from B to A; the other surface\'s paint stays', async () => {
    const tb = await startBackend({ tokens: [] });
    let closed = false;
    try {
      const revision = (): number => {
        const r = tb.backend._test.service.readCapturedV3(PID);
        if (!r.ok) throw new Error(r.error.code);
        return r.read.revision;
      };
      const ok = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'trim-data-upgrade' }, args }, token: tb.adminToken, origin: null });
        expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
        return r.json as Record<string, unknown>;
      };
      const glb = kitPiece();
      const stage = (await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages`, { body: {}, token: tb.adminToken, origin: null })).json as { stageId: string };
      const put = await fetch(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stage.stageId}/bytes`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${tb.adminToken}`, 'content-type': 'application/octet-stream', 'x-thirdlight-offset': '0', 'x-thirdlight-total': String(glb.length) },
        body: new Uint8Array(glb),
      });
      expect(put.status).toBe(200);
      const inspected = await api(`${tb.authUrl}/api/v1/projects/${PID}/content/stages/${stage.stageId}/inspect`, { body: {}, token: tb.adminToken, origin: null });
      expect(inspected.status, JSON.stringify(inspected.json).slice(0, 400)).toBe(200);
      const p = (inspected.json as { proposal: Record<string, unknown> }).proposal;
      await ok('publishAsset', { mode: 'create', assetId: 'kit-piece', kind: 'model', displayName: 'Kit piece', sourceDigest: p['sourceDigest'], sourceByteLength: p['sourceByteLength'], importRecipe: p['importRecipe'], metrics: p['metrics'], importedAt: '2026-10-01T00:00:00Z' });
      const trim = { size: [256, 256], texelDensity: 128, padding: 4, rows: [{ slot: 'floor', top: 4, bottom: 124 }] };
      await ok('setMaterial', { material: { materialId: 'mat-sheet', name: 'Sheet', shader: 'trim', params: {}, textures: {}, trim } });
      await ok('setMaterial', { material: { materialId: 'mat-stone', name: 'Stone', shader: 'standard', params: {}, textures: {} } });
      await ok('setAssetOptions', { assetId: 'kit-piece', materials: { sheet: 'mat-sheet', stone: 'mat-stone' } });
      const id = String((await ok('createEntity', { sceneId: 'scene-main', kind: 'model', name: 'Infirmary wall', model: { asset: { assetId: 'kit-piece' } } }))['createdId']);
      // Paint as the old trim tiles did: G (grime) at half, B (wetness) full; on both surfaces (one stroke reaches every mesh).
      await ok('paintVertices', { entityId: id, dabs: [[0, 1, 0]], brush: { radius: 4, strength: 1, channel: 2 } });
      await ok('paintVertices', { entityId: id, dabs: [[0, 1, 0]], brush: { radius: 4, strength: 0.5, channel: 1 } });
      const paintOf = (): { mesh: string; paint: string }[] => {
        const r = tb.backend._test.service.readCapturedV3(PID);
        if (!r.ok) throw new Error(r.error.code);
        const e = (r.read.scene as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((x) => x.id === id)!;
        return (e.components['vertexPaint'] as { meshes: { mesh: string; paint: string }[] }).meshes;
      };
      const before = paintOf();
      expect(before.map((m) => m.mesh)).toEqual(['piece#0', 'piece#1']);
      const blob = (digest: string): number[] => [...readFileSync(join(tb.root, 'data', 'projects', PID, 'sources', 'sha256', digest))];
      const old = blob(before[0]!.paint);
      for (let v = 0; v < 4; v++) expect(old[v * 4 + 1]! > 0 && old[v * 4 + 2]! > 0 && old[v * 4 + 3] === 0, String(old.slice(v * 4, v * 4 + 4))).toBe(true);

      // The same data root, a new backend: its first read of the project opens (and upgrades) it.
      await tb.backend.close();
      closed = true;
      const second = await createTestBackend({ authoringOrigin: AUTHORING_ORIGIN, previewOrigin: PREVIEW_ORIGIN, authoringOrigins: [AUTHORING_ORIGIN], tokens: [{ token: tb.adminToken, scope: 'admin' }], dataRoot: join(tb.root, 'data') });
      try {
        const url = `http://127.0.0.1:${second.backend.portAuthoring}`;
        const s = await api(`${url}/api/v1/sessions`, { body: { projectId: PID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'trim-data-upgrade' } }, token: tb.adminToken });
        expect(s.status, JSON.stringify(s.json).slice(0, 400)).toBe(200);
        const r = second.backend._test.service.readCapturedV3(PID);
        if (!r.ok) throw new Error(r.error.code);
        const asset = (r.read.content as { assets: { assetId: string; vertexColors?: string }[] }).assets.find((a) => a.assetId === 'kit-piece')!;
        expect(asset.vertexColors).toBe('trim');
        const e = (r.read.scene as { entities: { id: string; components: Record<string, unknown> }[] }).entities.find((x) => x.id === id)!;
        const after = (e.components['vertexPaint'] as { meshes: { mesh: string; paint: string }[] }).meshes;
        // The trim surface: wetness on A, nothing on G or B. The stone surface keeps its layers as painted.
        expect(after[0]!.paint).not.toBe(before[0]!.paint);
        const sheet = blob(after[0]!.paint);
        for (let v = 0; v < 4; v++) expect(sheet.slice(v * 4, v * 4 + 4)).toEqual([old[v * 4]!, 0, 0, old[v * 4 + 2]!]);
        expect(after[1]!.paint).toBe(before[1]!.paint);
        // The model file is the game's and stays as it was (the renderer moves its COLOR_0 as it loads).
        const file = readdirSync(join(tb.root, 'data', 'projects', PID), { recursive: true }).map(String).find((f) => f.endsWith('.glb'));
        if (file !== undefined) expect(readFileSync(join(tb.root, 'data', 'projects', PID, file)).includes(Buffer.from(TRIM_DATA_GLTF_ATTRIBUTE))).toBe(false);
        const problems = await api(`${url}/api/v1/projects/${PID}/problems`, { method: 'GET', token: tb.adminToken, origin: null });
        const lines = (problems.json as { problems: { code: string; message: string }[] }).problems.filter((x) => x.code === 'project_upgraded').map((x) => x.message);
        expect(lines).toEqual(expect.arrayContaining([
          expect.stringContaining('1 model mapped to a trim material read its COLOR_0 as trim data now'),
          expect.stringContaining('1 painted trim surface had its wetness moved from B to A'),
        ]));
      } finally {
        await second.teardown();
      }
    } finally {
      if (closed) rmSync(tb.root, { recursive: true, force: true });
      else await tb.teardown();
    }
  }, 120_000);
});
