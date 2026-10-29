/**
 * GET /api/v1/projects — the project list behind the editor's picker — and
 * GET /api/v1/projects/resolve — the folder lookup of an MCP harness. The
 * owner token sees every project and folder; a project-scoped token sees its
 * own project only and cannot probe other server paths.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBackend, type TestBackend } from './test-helpers';

const GAME_A_TOKEN = 'game-a-token-0123456789';

describe('GET /api/v1/projects', () => {
  let tb: TestBackend;
  beforeAll(async () => {
    tb = await startBackend({ tokens: [{ token: GAME_A_TOKEN, scope: 'authoring:game-a' }] });
  });
  afterAll(async () => {
    await tb.teardown();
  });

  it('requires a token', async () => {
    const res = await fetch(`${tb.authUrl}/api/v1/projects`);
    expect(res.status).toBe(401);
  });

  it('lists every project with its name, and reflects new ones', async () => {
    const headers = { authorization: `Bearer ${tb.adminToken}` };
    let res = await fetch(`${tb.authUrl}/api/v1/projects`, { headers });
    expect(res.status).toBe(200);
    let body = (await res.json()) as { ok: boolean; projects: Array<{ projectId: string; name: string; loadable: boolean; connected: boolean }> };
    expect(body.ok).toBe(true);
    expect(body.projects.map((p) => p.projectId)).toEqual(['demo-0001']);
    expect(body.projects[0]).toMatchObject({ name: 'Demo', loadable: true, connected: false });

    const created = await fetch(`${tb.authUrl}/api/v1/admin/projects`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'second', name: 'Second game' }),
    });
    expect(created.status).toBe(201);
    res = await fetch(`${tb.authUrl}/api/v1/projects`, { headers });
    body = (await res.json()) as typeof body;
    expect(body.projects.map((p) => [p.projectId, p.name])).toEqual([
      ['demo-0001', 'Demo'],
      ['second', 'Second game'],
    ]);
  });

  it('a project-scoped token lists its own project only, and resolves only paths in it', async () => {
    const admin = { authorization: `Bearer ${tb.adminToken}` };
    const folderA = join(tb.root, 'games', 'a');
    const folderB = join(tb.root, 'games', 'b');
    mkdirSync(join(tb.root, 'games'));
    for (const [projectId, folder] of [['game-a', folderA], ['game-b', folderB]] as const) {
      const created = await fetch(`${tb.authUrl}/api/v1/admin/projects`, { method: 'POST', headers: { ...admin, 'content-type': 'application/json' }, body: JSON.stringify({ projectId, name: projectId, folder }) });
      expect(created.status, await created.text()).toBe(201);
    }
    mkdirSync(join(folderA, 'scripts'));
    type List = { projects: Array<{ projectId: string; folder?: string }>; total: number };
    const list = async (token: string): Promise<List> => {
      const res = await fetch(`${tb.authUrl}/api/v1/projects`, { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      return (await res.json()) as List;
    };
    expect((await list(tb.adminToken)).projects.map((p) => p.projectId)).toEqual(['demo-0001', 'game-a', 'game-b', 'second']);
    expect((await list(tb.authToken)).projects.map((p) => p.projectId)).toEqual(['demo-0001']);
    const a = await list(GAME_A_TOKEN);
    expect(a.projects).toEqual([expect.objectContaining({ projectId: 'game-a', folder: folderA })]);
    expect(a.total).toBe(1);

    const resolve = async (token: string, path: string) => {
      const res = await fetch(`${tb.authUrl}/api/v1/projects/resolve?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.text() };
    };
    // The owner resolves any folder, and is told why a path is no project.
    expect(JSON.parse((await resolve(tb.adminToken, folderB)).body)).toMatchObject({ ok: true, projectId: 'game-b', folder: folderB });
    const none = await resolve(tb.adminToken, tb.root);
    expect(none.status).toBe(404);
    expect(JSON.parse(none.body)).toMatchObject({ error: { reason: 'no_marker' } });
    // A project token finds its own folder (an MCP harness started inside it).
    const own = await resolve(GAME_A_TOKEN, join(folderA, 'scripts'));
    expect(own.status, own.body).toBe(200);
    expect(JSON.parse(own.body)).toMatchObject({ ok: true, projectId: 'game-a' });
    // Another project's folder, a folder with no project and any other path are refused alike, naming nothing.
    for (const path of [folderB, tb.root, '/etc']) {
      const r = await resolve(GAME_A_TOKEN, path);
      expect(r.status, path).toBe(401);
      expect(r.body, path).not.toContain(folderB);
      expect(r.body, path).not.toMatch(/reason|no_marker|not_registered/);
    }
    expect((await resolve(tb.authToken, folderA)).status).toBe(401);
  });
});
