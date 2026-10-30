/**
 * The scene model at the HTTP boundary: a new object needs a scene (no
 * default one; the editor sends the scene it has active), the rules a game
 * needs to start are checked when it starts (two players: every edit goes
 * through, the export is refused naming the rule), and `moveEntities` with a
 * `sceneId` moves objects into another scene keeping their ids and what names
 * them, as one undoable edit of both scene files. A kept object cannot become
 * two: a scene file added outside the editor that repeats its id is taken in
 * with new ids. `createEntity` takes what `setComponent` adds. An edit that
 * changes nothing is refused as no_change. A project whose recent commands
 * include scene edits and a scene transition to a spawn loads again in a new
 * backend over the same data root. A scene has no object count (its memory
 * is its bound): a template project grows past 1,024 objects and a
 * storage-v3 project holding more than that opens.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, AUTHORING_ORIGIN, mkRequestId, mkSessionId, PREVIEW_ORIGIN, startBackend, type TestBackend } from './test-helpers';
import { createTestBackend, testTempBase } from './testing';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
/** A test that exports builds the game (minified and tree-shaken): seconds alone, more on a loaded host, as in the export tests. */
const EXPORT_TIMEOUT_MS = 60_000;
const ID = 'scene-model';

describe('the scene model over HTTP', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const send = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const q = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op: 'queryProject', projectId: ID }, token: tb.adminToken, origin: null });
    const rev = Number((q.json as { revision: number }).revision);
    const r = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op, projectId: ID, requestId: mkRequestId(), expectedRevision: rev, args, origin: { kind: 'mcp', clientId: 'scene-model' } }, token: tb.adminToken, origin: null });
    return r.json as Record<string, unknown>;
  };
  type Ent = { id: string; name?: string; parentId?: string; keepLoaded?: boolean; components: Record<string, unknown> };
  const sceneFile = (sceneId: string): Ent[] => (JSON.parse(readFileSync(join(tb.root, 'data', 'projects', ID, 'scenes', `${sceneId}.json`), 'utf8')) as { scene: { entities: Ent[] } }).scene.entities;

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(testTempBase(), 'tl-scene-model-export-'));
    tb = await startBackend({ tokens: [], exportRoot, engineRoot: REPO });
    const c = await api(`${tb.authUrl}/api/v1/admin/projects`, { body: { projectId: ID, name: 'Scene model' }, token: tb.adminToken, origin: null });
    expect(c.status).toBe(201);
    const s = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: ID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'scene-model' } }, token: tb.adminToken });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    expect((await send('createScene', { sceneId: 'level', name: 'Level' }))['ok']).toBe(true);
  });
  afterAll(async () => {
    await tb.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('a new project\'s camera is a kept shot; a create without a scene or a parent is refused, with one it lands there', async () => {
    const cam = sceneFile('scene-main').find((e) => e.id === 'cam-main')!;
    expect(cam.components['virtualCamera']).toEqual({ rig: 'fixed', priority: -1000 });
    expect(cam.keepLoaded).toBe(true);
    const bare = await send('createEntity', { kind: 'box', name: 'Nowhere' });
    expect(bare['ok']).toBe(false);
    expect(bare['error']).toMatchObject({ code: 'field_missing', path: '/args/sceneId' });
    const many = await send('createEntities', { entities: [{ kind: 'box', name: 'Nowhere' }] });
    expect(many['ok']).toBe(false);
    const made = await send('createEntity', { kind: 'box', name: 'Crate', sceneId: 'level' });
    expect(made).toMatchObject({ ok: true, sceneId: 'level' });
    expect(sceneFile('level').map((e) => e.name)).toContain('Crate');
    // Under a parent, the parent's scene.
    const child = await send('createEntity', { kind: 'group', name: 'Lid', parentId: made['createdId'] });
    expect(child).toMatchObject({ ok: true, sceneId: 'level' });
  });

  it('two players share the view: both edits go through and the game starts; a player in a later scene exports without a warning', async () => {
    const a = await send('createEntity', { kind: 'box', name: 'Player A', sceneId: 'scene-main', components: { controller: {} } });
    const b = await send('createEntity', { kind: 'box', name: 'Player B', sceneId: 'scene-main', components: { controller: {} } });
    expect(a['ok'], JSON.stringify(a)).toBe(true);
    expect(b['ok'], JSON.stringify(b)).toBe(true);
    const both = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(both.status, JSON.stringify(both.json)).toBe(200);
    expect((both.json as { warnings?: { code: string }[] }).warnings ?? []).toEqual([]);
    // One player, in a scene the game does not start with: it arrives when that scene loads.
    expect((await send('deleteEntity', { entityId: String(b['createdId']) }))['ok']).toBe(true);
    expect((await send('moveEntities', { entityIds: [String(a['createdId'])], parentId: null, sceneId: 'level' }))['ok']).toBe(true);
    const later = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(later.status, JSON.stringify(later.json)).toBe(200);
    expect((later.json as { warnings?: { code: string }[] }).warnings ?? []).toEqual([]);
    expect((await send('deleteEntity', { entityId: String(a['createdId']) }))['ok']).toBe(true);
  }, EXPORT_TIMEOUT_MS);

  it('moveEntities with a sceneId moves objects (with their children) into another scene, ids and references kept, one undo', async () => {
    const crate = sceneFile('level').find((e) => e.name === 'Crate')!;
    const lid = sceneFile('level').find((e) => e.name === 'Lid')!;
    // A camera in the main scene aims at the crate: the reference holds across the move.
    const aim = await send('createEntity', { kind: 'group', name: 'Aim', sceneId: 'scene-main', components: { virtualCamera: { rig: 'fixed', target: crate.id } } });
    expect(aim['ok'], JSON.stringify(aim)).toBe(true);
    const moved = await send('moveEntities', { entityIds: [crate.id], parentId: null, sceneId: 'scene-main' });
    expect(moved, JSON.stringify(moved)).toMatchObject({ ok: true, change: { type: 'moveEntitiesScene', fromSceneId: 'level', toSceneId: 'scene-main' } });
    expect(sceneFile('level').map((e) => e.id)).not.toContain(crate.id);
    const main = sceneFile('scene-main');
    expect(main.find((e) => e.id === crate.id)?.components['box']).toEqual(crate.components['box']);
    expect(main.find((e) => e.id === lid.id)?.parentId).toBe(crate.id);
    expect(main.find((e) => e.id === String(aim['createdId']))?.components['virtualCamera']).toMatchObject({ target: crate.id });
    // One undo puts both back where they were; redo moves them again.
    expect((await send('undo', {}))['ok']).toBe(true);
    expect(sceneFile('level').map((e) => e.id)).toEqual(expect.arrayContaining([crate.id, lid.id]));
    expect(sceneFile('scene-main').map((e) => e.id)).not.toContain(crate.id);
    expect((await send('redo', {}))['ok']).toBe(true);
    expect(sceneFile('scene-main').map((e) => e.id)).toEqual(expect.arrayContaining([crate.id, lid.id]));
    // Into the scene they are in: an ordinary move.
    expect((await send('moveEntities', { entityIds: [lid.id], parentId: null, sceneId: 'scene-main' }))).toMatchObject({ ok: true, change: { type: 'moveEntities' } });
    // An unknown scene is refused.
    expect((await send('moveEntities', { entityIds: [lid.id], parentId: null, sceneId: 'nope' }))['ok']).toBe(false);
  });

  it('a scene file added beside the project that repeats a kept object\'s id is taken in with new ids: a kept object stays one object, the start goes through', async () => {
    // Written outside the editor: a scene holding a copy of the kept camera under its own id.
    const dir = join(tb.root, 'data', 'projects', ID);
    const level = JSON.parse(readFileSync(join(dir, 'scenes', 'level.json'), 'utf8')) as { scene: { sceneId: string; entities: Ent[] } };
    const cam = sceneFile('scene-main').find((e) => e.id === 'cam-main')!;
    expect(cam.keepLoaded).toBe(true);
    mkdirSync(join(dir, 'extra'), { recursive: true });
    writeFileSync(join(dir, 'extra', 'kept-copy.scene.json'), JSON.stringify({ ...level, scene: { ...level.scene, sceneId: 'kept-copy', entities: [cam] } }));
    const check = await api(`${tb.authUrl}/api/v1/projects/${ID}/content/files/check`, { body: {}, token: tb.adminToken, origin: null });
    expect(check.status, JSON.stringify(check.json)).toBe(200);
    expect((check.json as { check: { resources: { adopted: unknown[] } } }).check.resources.adopted).toEqual([{ kind: 'scene', id: 'kept-copy', path: 'extra/kept-copy.scene.json' }]);
    const q = await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op: 'queryEntities', projectId: ID, args: { sceneId: 'kept-copy', limit: 10, offset: 0 } }, token: tb.adminToken, origin: null });
    const copy = (q.json as { entities: Ent[] }).entities;
    expect(copy).toHaveLength(1);
    expect(copy[0]!.id).not.toBe('cam-main');
    expect(copy[0]!.keepLoaded).toBe(true);
    // Two kept objects now, each one object: the export is not refused for a kept id in two scenes.
    const exported = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(exported.status, JSON.stringify(exported.json)).toBe(200);
    expect(JSON.stringify(exported.json)).not.toContain('kept_twice');
  }, EXPORT_TIMEOUT_MS);

  it('createEntity over HTTP takes a component only setComponent used to add, stored as setComponent stores it', async () => {
    const path = { points: [[0, 0, 0], [4, 0, 0]] };
    const made = await send('createEntity', { kind: 'group', name: 'Rail', sceneId: 'level', components: { cameraPath: path } });
    expect(made['ok'], JSON.stringify(made)).toBe(true);
    const bare = await send('createEntity', { kind: 'group', name: 'Rail 2', sceneId: 'level' });
    expect((await send('setComponent', { entityId: String(bare['createdId']), component: 'cameraPath', value: path }))['ok']).toBe(true);
    const stored = (id: unknown): unknown => sceneFile('level').find((e) => e.id === String(id))!.components['cameraPath'];
    expect(stored(made['createdId'])).toEqual(stored(bare['createdId']));
    expect(stored(made['createdId'])).toBeDefined();
  });

  it('an edit that changes nothing is refused as no_change and moves no revision', async () => {
    expect((await send('setTransform', { entityId: 'cam-main', transform: { position: [1, 2, 9] } }))['ok']).toBe(true);
    const revision = async (): Promise<number> => Number(((await api(`${tb.authUrl}/api/v1/projects/${ID}/commands`, { body: { op: 'queryProject', projectId: ID }, token: tb.adminToken, origin: null })).json as { revision: number }).revision);
    const rev = await revision();
    const again = await send('setTransform', { entityId: 'cam-main', transform: { position: [1, 2, 9] } });
    expect(again['ok']).toBe(false);
    expect((again['error'] as { code?: string }).code).toBe('no_change');
    expect(await revision()).toBe(rev);
  });
});

describe('a project reopened by a new backend', () => {
  it('loads again when its recent commands include scene edits, a scene transition to a spawn and more than 1,024 objects; a storage-v3 project with more opens', async () => {
    const P = 'scene-reopen';
    const tb = await startBackend({ tokens: [], engineRoot: REPO });
    let closed = false;
    try {
      expect((await api(`${tb.authUrl}/api/v1/admin/projects`, { body: { projectId: P, name: 'Reopen', template: 'starter' }, token: tb.adminToken, origin: null })).status).toBe(201);
      const send = async (op: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
        const q = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, { body: { op: 'queryProject', projectId: P }, token: tb.adminToken, origin: null });
        const r = await api(`${tb.authUrl}/api/v1/projects/${P}/commands`, { body: { op, projectId: P, requestId: mkRequestId(), expectedRevision: Number((q.json as { revision: number }).revision), args, origin: { kind: 'mcp', clientId: 'scene-reopen' } }, token: tb.adminToken, origin: null });
        expect((r.json as { ok?: boolean }).ok, JSON.stringify(r.json)).toBe(true);
        return r.json as Record<string, unknown>;
      };
      await send('createScene', { sceneId: 'scene-extra', name: 'Extra' });
      await send('renameScene', { sceneId: 'scene-extra', name: 'Extra room' });
      await send('setStartScenes', { sceneIds: ['scene-main', 'scene-extra'] });
      // A scene transition names a spawn: its recorded creation must load without the spawn beside it.
      const spawn = String((await send('createEntity', { sceneId: 'scene-extra', kind: 'group', name: 'Arrival', transform: { position: [70, 1, 0] }, components: { playerSpawn: {} } }))['createdId']);
      await send('createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Door', transform: { position: [69, 1, 0] }, components: { trigger: { size: [1, 2], signal: 'door', sceneTransition: { scene: 'scene-extra', spawn } } } });
      // No object count per scene: two batches take the scene past the 1,024 older scenes were capped at.
      const boxes = (from: number): Record<string, unknown>[] => Array.from({ length: 550 }, (_, i) => ({ kind: 'box', name: `Crate ${from + i}`, transform: { position: [from + i, 0, 0] } }));
      await send('createEntities', { sceneId: 'scene-main', entities: boxes(0) });
      await send('createEntities', { sceneId: 'scene-main', entities: boxes(550) });
      const mainFile = (dir: string): number => (JSON.parse(readFileSync(join(tb.root, 'data', 'projects', dir, 'scenes', 'scene-main.json'), 'utf8')) as { scene: { entities: unknown[] } }).scene.entities.length;
      expect(mainFile(P)).toBeGreaterThan(1_100);
      // A storage-v3 project (one scenes/main.json envelope, upgraded on open) holding more than 1,024 objects.
      const V3 = 'demo-0003';
      const v3Dir = join(tb.root, 'data', 'projects', V3);
      cpSync(join(REPO, 'fixtures', 'm3', 'storage', 'project-v3-demo-0003'), v3Dir, { recursive: true });
      const envelope = JSON.parse(readFileSync(join(v3Dir, 'scenes', 'main.json'), 'utf8')) as { scene: { entities: Record<string, unknown>[] } };
      const crate = envelope.scene.entities.find((e) => e['id'] === 'box-0001')!;
      for (let n = 1000; n < 2100; n++) envelope.scene.entities.push({ ...crate, id: `box-${n}`, name: `Crate ${n}` });
      writeFileSync(join(v3Dir, 'scenes', 'main.json'), JSON.stringify(envelope, null, 2));
      // The same data root, a new backend (the first one closed): its first read of the project loads it.
      await tb.backend.close();
      closed = true;
      const second = await createTestBackend({ authoringOrigin: AUTHORING_ORIGIN, previewOrigin: PREVIEW_ORIGIN, authoringOrigins: [AUTHORING_ORIGIN], tokens: [{ token: tb.adminToken, scope: 'admin' }], dataRoot: join(tb.root, 'data'), engineRoot: REPO });
      try {
        const q = await api(`http://127.0.0.1:${second.backend.portAuthoring}/api/v1/projects/${P}/commands`, { body: { op: 'queryProject', projectId: P }, token: tb.adminToken, origin: null });
        expect((q.json as { ok?: boolean }).ok, JSON.stringify(q.json).slice(0, 300)).toBe(true);
        expect((q.json as { scenes: { name: string }[] }).scenes.map((s) => s.name)).toContain('Extra room');
        expect(mainFile(P)).toBeGreaterThan(1_100);
        const v3 = await api(`http://127.0.0.1:${second.backend.portAuthoring}/api/v1/projects/${V3}/commands`, { body: { op: 'queryProject', projectId: V3 }, token: tb.adminToken, origin: null });
        expect((v3.json as { ok?: boolean }).ok, JSON.stringify(v3.json).slice(0, 300)).toBe(true);
        expect(mainFile(V3)).toBe(9 + 1_100);
      } finally {
        await second.teardown();
      }
    } finally {
      if (closed) rmSync(tb.root, { recursive: true, force: true });
      else await tb.teardown();
    }
  });
});
