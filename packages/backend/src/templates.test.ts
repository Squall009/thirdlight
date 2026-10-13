/**
 * Templates declare their dependencies; creation refuses a template whose
 * declared modules this engine does not provide. The 3D starter gets the
 * Basic Kit and its setup's commands at creation, and starts with nothing
 * to undo.
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
    // Two templates from the neutral starter's capture: one declares a module
    // nobody provides, one declares only what the engine has; plus the real
    // starter template as it ships.
    for (const [id, requiredModules] of [
      ['needs-terrain', ['thirdlight.terrain:heightmap']],
      ['plain', ['thirdlight.character:controller']],
    ] as const) {
      const dir = join(engineRoot, 'templates', id);
      mkdirSync(join(dir, 'captured'), { recursive: true });
      copyTree(join(REPO_ROOT, 'templates', 'starter', 'captured', 'project.json'), join(dir, 'captured', 'project.json'));
      copyTree(join(REPO_ROOT, 'templates', 'starter', 'assets'), join(dir, 'assets'));
      writeFileSync(join(dir, 'template.json'), JSON.stringify({ name: id, description: 'test', requiredModules }));
    }
    copyTree(join(REPO_ROOT, 'templates', 'starter'), join(engineRoot, 'templates', 'starter'));
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

  it('the starter template is listed and creates a project', async () => {
    const res = await fetch(`${base}/api/v1/templates`, { headers: { authorization: `Bearer ${ADMIN}` } });
    const body = (await res.json()) as { templates: Array<{ id: string; name: string; requiredModules: string[] }> };
    expect(body.templates.find((t) => t.id === 'starter')).toMatchObject({ name: '2D starter', requiredModules: [] });
    expect((await create('t3', 'starter')).status).toBe(201);
    const q = await fetch(`${base}/api/v1/projects/t3/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', origin: AUTHORING_ORIGIN },
      body: JSON.stringify({ op: 'queryGameConfig', projectId: 't3' }),
    });
    // There is no game block; the query reports the tag registry only.
    const game = (await q.json()) as { ok: boolean; tags: unknown };
    expect(game.ok, JSON.stringify(game).slice(0, 300)).toBe(true);
    expect(Array.isArray(game.tags)).toBe(true);
    expect('game' in game).toBe(false);
    // A new project is current: its character plays through an animator, and nothing was upgraded at its first open.
    const player = (await (await fetch(`${base}/api/v1/projects/t3/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', origin: AUTHORING_ORIGIN },
      body: JSON.stringify({ op: 'queryEntities', projectId: 't3', args: { limit: 100 } }),
    })).json()) as { entities: { name: string; components: Record<string, unknown> }[] };
    const character = player.entities.find((e) => e.name === 'Player');
    expect(character?.components['animator']).toEqual({ controller: 'idle-run-airborne-01' });
    expect(character?.components['modelAnimation']).toBeUndefined();
    const problems = await fetch(`${base}/api/v1/projects/t3/problems`, { headers: { authorization: `Bearer ${ADMIN}`, origin: AUTHORING_ORIGIN } });
    expect(((await problems.json()) as { problems: unknown[] }).problems).toEqual([]);
  });
});

describe('the 3D starter', () => {
  let backend: Backend;
  let teardown: () => Promise<void>;
  let base: string;
  beforeAll(async () => {
    // The engine's own folders: the template, its setup and the Basic Kit pack as they ship.
    const t = await createTestBackend({ authoringOrigin: AUTHORING_ORIGIN, previewOrigin: PREVIEW_ORIGIN, authoringOrigins: [AUTHORING_ORIGIN], engineRoot: REPO_ROOT, tokens: [{ token: ADMIN, scope: 'admin' }] });
    backend = t.backend;
    teardown = t.teardown;
    base = `http://127.0.0.1:${backend.portAuthoring}`;
  }, 60000);
  afterAll(async () => {
    await teardown();
  });
  const call = async (op: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Record<string, any>> =>
    (await (await fetch(`${base}/api/v1/projects/w3/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', origin: AUTHORING_ORIGIN },
      body: JSON.stringify({ op, projectId: 'w3', args, ...extra }),
    })).json()) as Record<string, any>;

  it('is listed with its picture beside the 2D starter, and a project made from it is a 3D level on the Basic Kit with nothing to undo', async () => {
    const res = await fetch(`${base}/api/v1/templates`, { headers: { authorization: `Bearer ${ADMIN}` } });
    const list = ((await res.json()) as { templates: Array<{ id: string; name: string; packs: string[]; picture?: string }> }).templates;
    expect(list.map((t) => t.id)).toEqual(expect.arrayContaining(['starter', 'starter-3d']));
    const t3 = list.find((t) => t.id === 'starter-3d')!;
    expect(t3).toMatchObject({ name: '3D starter', packs: ['basic-kit'] });
    expect(t3.picture).toMatch(/^data:image\/webp;base64,/);
    const made = await fetch(`${base}/api/v1/admin/projects`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'w3', name: 'World', template: 'starter-3d' }) });
    expect(made.status, (await made.clone().text()).slice(0, 600)).toBe(201);
    const read = backend._test.service.readCapturedV3('w3');
    if (!read.ok) throw new Error('no project');
    const content = read.read.content as unknown as Record<string, any>;
    expect(content['settings']['physics_dimension']).toBe(3);
    expect(content['kits'].map((k: { kitId: string }) => k.kitId)).toEqual(['basic-kit']);
    expect(content['materials'].map((m: { materialId: string }) => m.materialId)).toEqual(expect.arrayContaining(['basic-trim', 'starter-ground']));
    const entities = (read.read.scene as { entities: unknown }).entities as { id: string; name: string; components: Record<string, any> }[];
    const named = (n: string): { id: string; components: Record<string, any> } => entities.find((e) => e.name === n)!;
    expect(named('Ground blocks').components['blockLayer'].kitId).toBe('basic-kit');
    expect(named('Terrain').components['materials']).toEqual({ '*': 'starter-ground' });
    expect(named('Follow camera').components['virtualCamera']).toMatchObject({ rig: 'follow', target: named('Player').id });
    expect(named('Player').components['animator']).toBeDefined();
    expect(named('Spawn').components['playerSpawn']).toBeDefined();
    // The scene's look: a gradient sky (never black above the horizon).
    expect((read.read.scenes?.[0] as { environment?: { sky?: { mode: string } } } | undefined)?.environment?.sky?.mode).toBe('gradient');
    // The ground blocks hold cells.
    const blocks = (read.read.scene as unknown as { blocks?: { entityId: string; chunks?: unknown[] }[] }).blocks ?? [];
    expect(blocks.find((b) => b.entityId === named('Ground blocks').id)?.chunks?.length ?? 0).toBeGreaterThan(0);
    const problems = await fetch(`${base}/api/v1/projects/w3/problems`, { headers: { authorization: `Bearer ${ADMIN}`, origin: AUTHORING_ORIGIN } });
    expect(((await problems.json()) as { problems: unknown[] }).problems).toEqual([]);
    // The template is where the project starts: undo has nothing to take.
    const q = await call('queryProject');
    const undo = await call('undo', {}, { expectedRevision: q['revision'], requestId: `req-${'c'.repeat(32)}` });
    expect(undo['error']?.code ?? undo['code']).toBe('history_empty');
  }, 120000);
});
