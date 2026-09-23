/**
 * Templates declare their dependencies; creation refuses a template whose
 * declared modules this engine does not provide (D17).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Backend } from './backend';
import { createTestBackend } from './testing';
import { AUTHORING_ORIGIN, PREVIEW_ORIGIN } from './test-helpers';

const REPO_ROOT = new URL('.', import.meta.url).pathname.slice(0, new URL('.', import.meta.url).pathname.lastIndexOf('/packages/'));

/** Copy a file or directory tree (the backend's ambient Node types have no cpSync). */
function copyTree(from: string, to: string): void {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
  } else {
    writeFileSync(to, readFileSync(from));
  }
}
const ADMIN = 'admin-templates-test';

describe('template dependencies at creation', () => {
  let engineRoot: string;
  let backend: Backend;
  let teardown: () => Promise<void>;
  let base: string;
  beforeAll(async () => {
    engineRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-templates-'));
    // Two templates from the Beacon Reach capture: one declares a module
    // nobody provides, one declares only what the engine has.
    for (const [id, requiredModules] of [
      ['needs-terrain', ['thirdlight.terrain:heightmap']],
      ['plain', ['thirdlight.platformer:controller']],
    ] as const) {
      const dir = join(engineRoot, 'templates', id);
      mkdirSync(join(dir, 'captured'), { recursive: true });
      copyTree(join(REPO_ROOT, 'samples', 'beacon-reach', 'captured', 'project.json'), join(dir, 'captured', 'project.json'));
      copyTree(join(REPO_ROOT, 'samples', 'beacon-reach', 'assets'), join(dir, 'assets'));
      writeFileSync(join(dir, 'template.json'), JSON.stringify({ name: id, description: 'test', requiredModules }));
    }
    const t = await createTestBackend({
      authoringOrigin: AUTHORING_ORIGIN,
      previewOrigin: PREVIEW_ORIGIN,
      authoringOrigins: [AUTHORING_ORIGIN],
      engineRoot,
      tokens: [{ token: ADMIN, scope: 'admin' }],
    });
    backend = t.backend;
    teardown = t.teardown;
    base = `http://127.0.0.1:${backend.portAuthoring}`;
  }, 60000);
  afterAll(async () => {
    await teardown();
    rmSync(engineRoot, { recursive: true, force: true });
  });

  const create = (projectId: string, template: string) =>
    fetch(`${base}/api/v1/admin/projects`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, name: projectId, template }),
    });

  it('the template list carries the declared modules', async () => {
    const res = await fetch(`${base}/api/v1/templates`, { headers: { authorization: `Bearer ${ADMIN}` } });
    const body = (await res.json()) as { templates: Array<{ id: string; requiredModules: string[] }> };
    expect(body.templates.find((t) => t.id === 'needs-terrain')?.requiredModules).toEqual(['thirdlight.terrain:heightmap']);
  });

  it('an unresolved declared module refuses creation with module_unresolved; nothing is created', async () => {
    const res = await create('t1', 'needs-terrain');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: boolean; error: { code: string; message: string } };
    expect(body.error.code).toBe('module_unresolved');
    expect(body.error.message).toContain('thirdlight.terrain:heightmap (required by declared)');
    const list = await fetch(`${base}/api/v1/projects`, { headers: { authorization: `Bearer ${ADMIN}` } });
    expect(((await list.json()) as { projects: unknown[] }).projects).toEqual([]);
  });

  it('a template whose dependencies resolve is created', async () => {
    const res = await create('t2', 'plain');
    expect(res.status).toBe(201);
  });
});
