/**
 * GET /api/v1/projects — the project list behind the editor's picker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startBackend, type TestBackend } from './test-helpers';

describe('GET /api/v1/projects', () => {
  let tb: TestBackend;
  beforeAll(async () => {
    tb = await startBackend();
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

  it('a project-scoped token can list too (the picker needs only a valid token)', async () => {
    const res = await fetch(`${tb.authUrl}/api/v1/projects`, { headers: { authorization: `Bearer ${tb.authToken}` } });
    expect(res.status).toBe(200);
  });
});
