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
import { cpSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, mkSessionId, startBackend, type TestBackend } from './test-helpers';

const FIXTURES = resolve(import.meta.dirname, '..', '..', '..', 'fixtures', 'phase24');

describe('phase 24.8: a schemaVersion 2 project opened over HTTP', () => {
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

  it('upgrades the generic data and writes the project back as schemaVersion 4 (phase 25.7; 3 in phase 24.8)', async () => {
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

    // On disk: the manifest says 4 (2 → 3 → 4 in one open), content.json has no game key, the scene file the upgraded components.
    expect(readJson('legacy-v2-upgradable', 'project.json')['schemaVersion']).toBe(4);
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
describe('phase 25.7: a schemaVersion 3 project with four-digit ids opened over HTTP', () => {
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

  it('keeps the old ids, writes schemaVersion 4, and gives new objects six-digit ids unique across scenes', async () => {
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

    // On disk: the manifest says 4; the scene files keep their ids (only the revision stamp moved).
    expect(readJson('project.json')['schemaVersion']).toBe(4);
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
