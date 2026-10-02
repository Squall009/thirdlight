/**
 * The scene model at the HTTP boundary: a new object needs a scene (no
 * default one; the editor sends the scene it has active), the rules a game
 * needs to start are checked when it starts (two players: every edit goes
 * through, the export is refused naming the rule), and `moveEntities` with a
 * `sceneId` moves objects into another scene keeping their ids and what names
 * them, as one undoable edit of both scene files.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { api, mkRequestId, mkSessionId, startBackend, type TestBackend } from './test-helpers';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
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
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-scene-model-export-'));
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

  it('two players: each edit goes through, the start is refused naming the rule; a player in a later scene is a warning', async () => {
    const a = await send('createEntity', { kind: 'box', name: 'Player A', sceneId: 'scene-main', components: { controller: {} } });
    const b = await send('createEntity', { kind: 'box', name: 'Player B', sceneId: 'scene-main', components: { controller: {} } });
    expect(a['ok'], JSON.stringify(a)).toBe(true);
    expect(b['ok'], JSON.stringify(b)).toBe(true);
    const refused = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(refused.status).not.toBe(200);
    expect(JSON.stringify(refused.json)).toContain('one player controller per view');
    // One player, in a scene the game does not start with: the export goes through with a warning.
    expect((await send('deleteEntity', { entityId: String(b['createdId']) }))['ok']).toBe(true);
    expect((await send('moveEntities', { entityIds: [String(a['createdId'])], parentId: null, sceneId: 'level' }))['ok']).toBe(true);
    const warned = await api(`${tb.authUrl}/api/v1/admin/projects/${ID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(warned.status, JSON.stringify(warned.json)).toBe(200);
    expect((warned.json as { warnings?: { code: string }[] }).warnings?.map((w) => w.code)).toEqual(['player_scene']);
    expect((await send('deleteEntity', { entityId: String(a['createdId']) }))['ok']).toBe(true);
  });

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
});
