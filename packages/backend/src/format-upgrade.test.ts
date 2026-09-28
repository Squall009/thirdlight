/**
 * Phase 24.8: the project format after the engine/game separation, at the
 * HTTP boundary. A schemaVersion 2 project (written by hand in
 * `fixtures/phase24`, not copied from a game) is copied into the backend's
 * data root and opened with POST /api/v1/sessions:
 *
 * - generic data is upgraded (pickups → collectibles with the old counter
 *   names, a spawn facing → a yaw, the session player's health fields and
 *   `content.game: null` dropped) and written back as schemaVersion 3;
 * - game data is refused: the open fails with problems that name each
 *   removed component and say "removed in phase 24: build it as project
 *   scripts" — nothing is dropped silently, and the files stay as they were.
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

  it('upgrades the generic data and writes the project back as schemaVersion 3', async () => {
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

    // On disk: the manifest says 3, content.json has no game key, the scene file the upgraded components.
    expect(readJson('legacy-v2-upgradable', 'project.json')['schemaVersion']).toBe(3);
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
