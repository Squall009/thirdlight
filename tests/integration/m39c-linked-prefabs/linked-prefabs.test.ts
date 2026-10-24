/**
 * Linked prefab copies through the real backend over HTTP and WebSocket.
 *
 * A project holds linked copies of a door prefab (one with an override, one
 * with an override the prefab has no part for) and of a "locked door"
 * variant (the door plus a nested handle prefab). The editor's full state,
 * the Play build and the export all carry them as plain assembled objects
 * with ids derived from the copy and the part (and none of them a link);
 * the stale override is a Problems line. Editing the door prefab reaches
 * every copy, the variant's included, through the change feed: the frames
 * the editor receives, applied to the editor's own projection, leave it as a
 * fresh read of the project; deleting a copy takes its parts out of it.
 * A script's `ctx.spawn` of the variant (from the Play build's prefabs, in
 * the real runtime) makes the assembled variant.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prefabPartId } from '@thirdlight/project-model';

import { Projection } from '../../../packages/editor/src/session/projection';
import { FakeEditor } from '../../../packages/backend/src/test-editor';
import { api, connectWs, exportContentOf, mkRequestId, mkSessionId, startBackend, type TestBackend, type TestWs } from '../../../packages/backend/src/test-helpers';
import { behaviorModule, startHarness } from '../m22-worker/harness';
import { DT, SETTINGS, sceneOf, type Any } from '../m23-3d/character-kit';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
const T = (x: number): Any => ({ position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const SPAWNER = `export default {
  step(s, ctx) { if (ctx.phase === 'intent' && ctx.stepIndex === 2) ctx.spawn('locked-door', { position: [0, 4, 0] }); },
};
`;

describe('linked prefab copies at the backend', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (): string => join(tb.root, 'data', 'projects', PID);
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = async (op: string, args: Record<string, unknown>): Promise<Any> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'linked-prefabs' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
    return r.json;
  };
  const readJson = (path: string): Any => JSON.parse(readFileSync(path, 'utf8'));
  const prefabFile = (prefabId: string): string => {
    const folder = join(dir(), 'assets', 'prefabs');
    const f = readdirSync(folder).find((n) => readJson(join(folder, n)).id === prefabId);
    if (f === undefined) throw new Error(`no prefab file for ${prefabId}`);
    return join(folder, f);
  };
  /** A prefab made through the commands: a box root and box children (name → x). */
  const makePrefab = async (prefabId: string, root: string, children: Record<string, number>): Promise<string[]> => {
    const rootId = (await command('createEntity', { kind: 'box', name: root, sceneId: 'scene-main' })).createdId as string;
    const names = Object.keys(children);
    if (names.length > 0) await command('createEntities', { entities: names.map((n) => ({ kind: 'box', name: n, parentId: rootId, transform: { position: [children[n], 0, 0] } })) });
    await command('createPrefab', { prefabId, displayName: root, sourceEntityId: rootId });
    await command('deleteEntity', { entityId: rootId });
    return (readJson(prefabFile(prefabId)).data.entities as { localId: string }[]).map((e) => e.localId);
  };

  let doorRoot = '';
  let panel = '';
  let handleRoot = '';
  /** Part ids every build must agree on. */
  const ids = (): Record<string, string> => ({
    aPanel: prefabPartId('door-a', panel),
    bPanel: prefabPartId('door-b', panel),
    lockedPanel: prefabPartId('locked-a', `base-1/${panel}`),
    lockedHandle: prefabPartId('locked-a', 'lock-1'),
  });

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-linked-export-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    [handleRoot] = (await makePrefab('handle', 'Handle', {})) as [string];
    [doorRoot, panel] = (await makePrefab('door', 'Door', { Panel: 0.4 })) as [string, string];
    // Linked copies only exist in files until the commands write them: written while the project is closed.
    expect(tb.backend._test.service.releaseWorkspace(PID).ok).toBe(true);
    const variant = {
      prefabId: 'locked-door',
      displayName: 'Locked door',
      createdRevision: 0,
      entities: [
        { localId: 'base-1', name: 'Locked door', components: { transform: T(0), prefab: { prefabId: 'door', overrides: [{ part: panel, path: 'components/box/material/color', value: '#aa2222' }] } } },
        { localId: 'lock-1', parentLocalId: 'base-1', components: { transform: T(0.3), prefab: { prefabId: 'handle' } } },
      ],
      entityCount: 2,
      depth: 2,
    };
    mkdirSync(join(dir(), 'assets', 'prefabs'), { recursive: true });
    writeFileSync(join(dir(), 'assets', 'prefabs', 'locked-door.prefab.json'), `${JSON.stringify({ tlresource: 1, kind: 'prefab', id: 'locked-door', data: variant }, null, 2)}\n`);
    const sceneFile = join(dir(), 'scenes', 'scene-main.json');
    const doc = readJson(sceneFile);
    doc.scene.entities.push(
      { id: 'door-a', name: 'Front door', components: { transform: T(5), prefab: { prefabId: 'door', overrides: [{ part: 'gone-1', path: 'name', value: 'Lost' }] } } },
      { id: 'door-b', components: { transform: T(9), prefab: { prefabId: 'door', overrides: [{ part: panel, path: 'components/box/material/color', value: '#22aa22' }] } } },
      { id: 'locked-a', components: { transform: T(13), prefab: { prefabId: 'locked-door' } } },
    );
    writeFileSync(sceneFile, `${JSON.stringify(doc, null, 2)}\n`);
  }, 120_000);
  afterAll(async () => {
    await tb?.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  /** The assembled objects every build must hold, checked on a list of scene objects. */
  const expectAssembled = (entities: readonly Any[], what: string): void => {
    const byId = new Map(entities.map((e) => [e.id, e]));
    const { aPanel, bPanel, lockedPanel, lockedHandle } = ids();
    for (const id of ['door-a', 'door-b', 'locked-a', aPanel, bPanel, lockedPanel, lockedHandle]) expect(byId.has(id), `${what}: ${id}`).toBe(true);
    // No object is a link any more; each part says which prefab part it is.
    for (const e of entities) if (e.components.prefab !== undefined) expect(e.components.prefab.localId, `${what}: ${e.id}`).toBeTypeOf('string');
    expect(byId.get('door-a').name).toBe('Front door');
    expect(byId.get('door-a').components.prefab).toEqual({ prefabId: 'door', localId: doorRoot });
    expect(byId.get(aPanel)).toMatchObject({ name: 'Panel', parentId: 'door-a', components: { prefab: { prefabId: 'door', localId: panel } } });
    expect(byId.get(bPanel).components.box.material.color).toBe('#22aa22');
    expect(byId.get(aPanel).components.box.material?.color).not.toBe('#22aa22');
    // The variant: the door's parts under the copy's root (which names the variant), its own colour, the nested handle under the root.
    expect(byId.get('locked-a')).toMatchObject({ name: 'Locked door', components: { prefab: { prefabId: 'locked-door', localId: 'base-1' }, transform: T(13) } });
    expect(byId.get(lockedPanel)).toMatchObject({ parentId: 'locked-a', components: { box: { material: { color: '#aa2222' } } } });
    expect(byId.get(lockedHandle)).toMatchObject({ name: 'Handle', parentId: 'locked-a', components: { prefab: { prefabId: 'handle', localId: handleRoot }, transform: T(0.3) } });
  };

  let ws: TestWs;
  let projection: Projection;
  const frames: Any[] = [];

  it('the editor view, Play and the export carry the assembled objects; a stale override is a Problem', async () => {
    // The project was released to write its files: the next read on the command path re-claims it (a query never re-opens one).
    revision();
    const sessionId = mkSessionId();
    const est = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: PID, sessionId, clientInfo: { kind: 'browser', label: 'linked-prefabs' } }, token: tb.authToken });
    expect(est.status, JSON.stringify(est.json).slice(0, 400)).toBe(200);
    const full = est.json as Any;
    expectAssembled(full.scene.entities, 'editor full state');
    projection = new Projection();
    projection.hydrate({ revision: full.revision, entities: full.scene.entities, entitySceneIds: full.scene.entitySceneIds, scenes: full.scene.scenes, startScenes: full.scene.startScenes });
    ws = await connectWs(`${tb.authUrl.replace(/^http/, 'ws')}/api/v1/ws?${new URLSearchParams({ sessionId, wsToken: full.wsToken }).toString()}`, { Origin: 'http://127.0.0.1:8501' });
    await ws.waitFor((m) => (m as Any).type === 'attached', 30_000);

    await expect
      .poll(async () => JSON.stringify(((await api(`${tb.authUrl}/api/v1/projects/${PID}/problems`, { method: 'GET', token: tb.adminToken, origin: null })).json as Any).problems.filter((p: Any) => p.code === 'prefab_override_stale')), { timeout: 10_000 })
      .toContain('door-a');

    const out = join(exportRoot, String(((await api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null })).json as Any).outputDir));
    const exported = exportContentOf(out);
    const row = (exported.scenes as Any[]).find((s) => s.sceneId === 'scene-main');
    expectAssembled(readJson(join(out, row.path)).entities, 'export');
    // The variant ships flattened: what a spawn copies has no link in it.
    const shipped = (exported.prefabs as Any[]).find((p) => p.prefabId === 'locked-door');
    expect(JSON.stringify(shipped)).not.toContain('overrides');
    expect(shipped.entities.map((e: Any) => e.localId)).toEqual(['base-1', prefabPartId('base-1', `base-1/${panel}`), prefabPartId('base-1', 'lock-1')]);
  }, 120_000);

  it('a prefab edit reaches every copy through the change feed; a deleted copy takes its parts', async () => {
    const collect = async (requestId: string): Promise<Any> => {
      const m = (await ws.waitFor((x) => (x as Any).type === 'mutation.applied' && (x as Any).requestId === requestId, 30_000)) as Any;
      frames.push(m);
      expect(projection.applyMutationApplied(m)).toEqual({ deduped: false, gap: false, applied: true });
      return m;
    };
    const send = async (op: string, args: Record<string, unknown>): Promise<Any> => {
      const requestId = mkRequestId();
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId, origin: { kind: 'mcp', clientId: 'linked-prefabs' }, args }, token: tb.adminToken, origin: null });
      expect(r.status, JSON.stringify(r.json).slice(0, 600)).toBe(200);
      return { result: r.json, frame: await collect(requestId) };
    };
    // A plain copy edited (a taller panel) and applied to the prefab.
    const placed = (await send('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'door' })).result;
    const copyPanel = (placed.change.mapping as Any[]).find((m) => m.localId === panel).entityId as string;
    await send('setComponent', { entityId: copyPanel, component: 'box', value: { size: [0.3, 2, 0.3] } });
    const { result, frame } = await send('updatePrefab', { prefabId: 'door', fromEntity: placed.change.rootId });

    const { aPanel, bPanel, lockedPanel, lockedHandle } = ids();
    const upserted = new Map<string, Any>((frame.change.assembled.upsert as Any[]).flatMap((g) => g.entities.map((e: Any) => [e.id, e])));
    // Every copy of the door, the variant's too, comes with its new panel; the handle did not change.
    for (const id of [aPanel, bPanel, lockedPanel]) expect(upserted.get(id)?.components.box.size, id).toEqual([0.3, 2, 0.3]);
    expect(upserted.has(lockedHandle)).toBe(false);
    // Overrides hold: door B stays green, the locked door red; the HTTP answer carries the same objects.
    expect(upserted.get(bPanel).components.box.material.color).toBe('#22aa22');
    expect(upserted.get(lockedPanel).components.box.material.color).toBe('#aa2222');
    expect(result.change.assembled).toEqual(frame.change.assembled);

    // The projection the frames advanced is what a fresh read of the project is.
    const fresh = (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryEntities', projectId: PID, args: { limit: 16_384 } }, token: tb.adminToken, origin: null })).json as Any;
    expectAssembled(fresh.entities, 'queryEntities after the edit');
    const comps = (es: readonly Any[]): Record<string, unknown> => Object.fromEntries(es.map((e) => [e.id, e.components]));
    expect(comps(projection.listEntities())).toEqual(comps(fresh.entities));

    // Deleting a copy takes its parts out of the editor's view.
    const deleted = await send('deleteEntity', { entityId: 'door-b' });
    expect(deleted.frame.change.assembled.removedIds).toContain(bPanel);
    expect(projection.getEntity(bPanel)).toBeUndefined();
    expect(projection.getEntity(aPanel)).toBeDefined();
  }, 120_000);

  it('Play builds the assembled scene, and a script spawns the assembled variant', async () => {
    const editor = new FakeEditor(ws);
    const p = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
    expect(p.status, JSON.stringify(p.json).slice(0, 400)).toBe(200);
    const playSessionId = (p.json as Any).playSessionId as string;
    const set = tb.backend._test.playContent.forPlay(playSessionId)!;
    const sceneBytes = set.artifacts.get('scenes/scene-main.json') as { bytes: Uint8Array };
    const scene = JSON.parse(new TextDecoder().decode(sceneBytes.bytes));
    const { aPanel, lockedPanel, lockedHandle } = ids();
    const byId = new Map((scene.entities as Any[]).map((e) => [e.id, e]));
    for (const id of ['door-a', aPanel, 'locked-a', lockedPanel, lockedHandle]) expect(byId.has(id), id).toBe(true);
    expect(byId.get(lockedPanel).components.box).toMatchObject({ size: [0.3, 2, 0.3], material: { color: '#aa2222' } });
    expect(byId.has('door-b')).toBe(false);
    await editor.waitUntil(() => tb.backend._test.plays.get(playSessionId)?.state === 'presented', 30_000);
    await api(`${tb.authUrl}/api/v1/projects/${PID}/play/${playSessionId}/stop`, { body: {}, token: tb.authToken });
    await editor.waitForEvent('play.stopped');
    ws.close();

    // The Play build's variant, spawned by a script in the running game.
    const { readRuntimeContentSync } = await import('@thirdlight/project-model');
    const content = readRuntimeContentSync(JSON.parse(new TextDecoder().decode(set.manifestBytes)), (path) => (set.artifacts.get(path) as { bytes?: Uint8Array } | undefined)?.bytes ?? null);
    const shipped = (content.prefabs as Any[]).find((x) => x.prefabId === 'locked-door');
    const spawner = { id: 'spawner-1', components: { transform: { position: [0, -5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, behavior: { behaviorId: 'spawner', values: {} } } };
    const game = sceneOf({}, [0, 1, 0], [spawner], 'linked-spawn');
    const h = await startHarness('single', { snapshot: { ...game.snapshot, prefabs: [shipped] }, settings: SETTINGS, physics: game.physics, behaviors: [behaviorModule('spawner', SPAWNER)] });
    try {
      for (let i = 1; i <= 6; i += 1) await h.tick(i * DT);
      const spawned = h.rt.sceneSet().spawned as Any[];
      expect(spawned).toHaveLength(3);
      const [root, part, handle] = spawned;
      expect(root).toMatchObject({ name: 'Locked door', components: { transform: { position: [0, 4, 0] } } });
      expect(part).toMatchObject({ name: 'Panel', parentId: root.id, components: { box: { size: [0.3, 2, 0.3], material: { color: '#aa2222' } } } });
      expect(handle).toMatchObject({ name: 'Handle', parentId: root.id, components: { box: {}, transform: T(0.3) } });
    } finally {
      await h.dispose();
    }
  }, 120_000);
});
