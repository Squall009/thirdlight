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
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, mkSessionId, startBackend, type TestBackend } from './test-helpers';

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

  it('upgrades the generic data and writes the project back as schemaVersion 5', async () => {
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

    // On disk: the manifest says 5 (2 → 3 → 4 → 5 in one open), content.json has no game key, the scene file the upgraded components.
    expect(readJson('legacy-v2-upgradable', 'project.json')['schemaVersion']).toBe(5);
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
    for (const d of details) expect(d.message).toContain('removed in phase 24: build it as project scripts');
    // Nothing was written.
    expect(readFileSync(join(projectDir('legacy-v2-refused'), 'scenes', 'scene-main.json')).equals(before)).toBe(true);
    expect(readJson('legacy-v2-refused', 'project.json')['schemaVersion']).toBe(2);

    // The project list says why it does not load.
    const list = await fetch(`${tb.authUrl}/api/v1/projects`, { headers: { authorization: `Bearer ${tb.adminToken}` } });
    const body = (await list.json()) as { projects: Array<{ projectId: string; loadable: boolean; code?: string; note?: string }> };
    const refused = body.projects.find((p) => p.projectId === 'legacy-v2-refused');
    expect(refused).toMatchObject({ loadable: false, code: 'content_invalid' });
    expect(refused?.note).toContain('removed in phase 24');
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

  it('keeps the old ids, writes schemaVersion 5, and gives new objects six-digit ids unique across scenes', async () => {
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

    // On disk: the manifest says 5; the scene files keep their ids (only the revision stamp moved).
    expect(readJson('project.json')['schemaVersion']).toBe(5);
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
 * engine before the asset-file format) opens over HTTP as schemaVersion 5:
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
    expect(readJson('project.json')['schemaVersion']).toBe(5);

    // Each asset's current version is a file in the project's own folder with its sidecar.
    const crate = readFileSync(join(dir(), 'assets', 'Crate.glb'));
    expect(sha(crate)).toBe(current.get('crate')!.sourceDigest);
    expect(readFileSync(join(REPO, 'fixtures', 'm2', 'assets', 'tiny-v2.glb')).equals(crate)).toBe(true);
    const png = readFileSync(join(dir(), 'assets', 'Wall-checker.png'));
    expect(sha(png)).toBe(current.get('wall')!.convertedFrom!.sourceDigest);
    expect(sha(readFileSync(join(dir(), 'assets', 'Beep.wav')))).toBe(current.get('beep')!.sourceDigest);
    const sidecar = (f: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir(), 'assets', `${f}.tlasset`), 'utf8')) as Record<string, unknown>;
    expect(sidecar('Crate.glb')).toMatchObject({ tlasset: 1, id: 'crate', kind: 'model' });
    expect(sidecar('Wall-checker.png')).toMatchObject({ id: 'wall', kind: 'texture', importSettings: { ktx2: 'color' } });
    expect(sidecar('Beep.wav')).toMatchObject({ id: 'beep', kind: 'audio' });

    // The records keep the current version only, with its path.
    const content = readJson('content.json')['content'] as { assets: Array<{ assetId: string; currentVersion: number; versions: Array<{ version: number; sourcePath?: string; convertedFrom?: { sourcePath?: string } }> }> };
    const crateRecord = content.assets.find((a) => a.assetId === 'crate')!;
    expect(crateRecord.currentVersion).toBe(2);
    expect(crateRecord.versions).toMatchObject([{ version: 2, sourcePath: 'assets/Crate.glb' }]);
    expect(content.assets.find((a) => a.assetId === 'wall')!.versions[0]!.convertedFrom?.sourcePath).toBe('assets/Wall-checker.png');

    // The older version stays in sources/ (every blob untouched) and is listed in the report.
    for (const [name, bytes] of blobsBefore) expect(readFileSync(join(dir(), 'sources', 'sha256', name)).equals(bytes), name).toBe(true);
    const report = readJson('upgrade-report.json') as { from: number; to: number; files: unknown[]; olderVersions: unknown[]; notMoved: unknown[] };
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
    expect((check.json as { check: unknown }).check).toEqual({ relocated: [], reimported: [], rebuilt: [], failed: [], sidecarProblems: [] });

    // The export ships the placed model's current bytes (what the v4 project shipped), not the older version.
    const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    const shipped = readdirSync(join(exportRoot, String((exported.json as { outputDir: string }).outputDir), 'content', 'sha256'));
    expect(shipped).toContain(current.get('crate')!.sourceDigest);
    expect(shipped).not.toContain(v1.sourceDigest);
  }, 120_000);
});
