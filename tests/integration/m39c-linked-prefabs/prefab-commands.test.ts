/**
 * The linked-copy commands through the real backend over HTTP and WebSocket.
 *
 * A door prefab (a frame with a panel) and a handle prefab, made through the
 * commands. Copies are placed linked; the ordinary commands on a copy's part
 * store overrides; overrides are reverted (a field, a part) and applied to
 * the prefab (a field, then everything, an added object becoming a part);
 * a variant follows its base; a handle copy applied into the door nests it
 * in every door; a prefab that would contain itself is refused; a copy is
 * unpacked. Every command is one undo step, undone and redone. After every
 * command the editor's projection, advanced only by the `mutation.applied`
 * frames, equals a fresh read of the project.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prefabPartId, prefabStageId } from '@thirdlight/project-model';

import { pasteValuesOf, type SelectionRead } from '../../../packages/editor/src/session/copy-values';
import { Projection } from '../../../packages/editor/src/session/projection';
import { api, connectWs, mkRequestId, mkSessionId, startBackend, type TestBackend, type TestWs } from '../../../packages/backend/src/test-helpers';
import type { Any } from '../m23-3d/character-kit';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';

describe('linked-copy commands at the backend', () => {
  let tb: TestBackend;
  let exportRoot: string;
  let ws: TestWs;
  let projection: Projection;
  const dir = (): string => join(tb.root, 'data', 'projects', PID);
  const readJson = (path: string): Any => JSON.parse(readFileSync(path, 'utf8'));
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const post = async (op: string, args: Record<string, unknown>, requestId = mkRequestId()): Promise<Any> =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId, origin: { kind: 'mcp', clientId: 'prefab-commands' }, args }, token: tb.adminToken, origin: null });
  /** A fresh read of what the editor shows: every object, assembled. */
  const fresh = async (): Promise<Any[]> => ((await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryEntities', projectId: PID, args: { limit: 16_384 } }, token: tb.adminToken, origin: null })).json as Any).entities;
  const shape = (es: readonly Any[]): Record<string, unknown> => Object.fromEntries(es.map((e) => [e.id, { parentId: e.parentId ?? null, name: e.name ?? null, components: e.components }]));
  /** One command, its frame applied to the projection, the projection checked against a fresh read. */
  const send = async (op: string, args: Record<string, unknown>): Promise<Any> => {
    const requestId = mkRequestId();
    const r = await post(op, args, requestId);
    expect(r.status, `${op} ${JSON.stringify(r.json).slice(0, 600)}`).toBe(200);
    const frame = (await ws.waitFor((x) => (x as Any).type === 'mutation.applied' && (x as Any).requestId === requestId, 30_000)) as Any;
    expect(projection.applyMutationApplied(frame)).toEqual({ deduped: false, gap: false, applied: true });
    expect(shape(projection.listEntities()), `${op}: the projection is a fresh read`).toEqual(shape(await fresh()));
    return r.json;
  };
  const refused = async (op: string, args: Record<string, unknown>): Promise<Any> => {
    const r = await post(op, args);
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).not.toBe(200);
    return (r.json as Any).error;
  };
  const prefab = (prefabId: string): Any => {
    const folder = join(dir(), 'assets', 'prefabs');
    const f = readdirSync(folder).find((n) => readJson(join(folder, n)).id === prefabId);
    if (f === undefined) throw new Error(`no prefab file for ${prefabId}`);
    return readJson(join(folder, f)).data;
  };
  const stored = (id: string): Any => (readJson(join(dir(), 'scenes', 'scene-main.json')).scene.entities as Any[]).find((e) => e.id === id);
  const view = async (id: string): Promise<Any> => (await fresh()).find((e) => e.id === id);

  let doorRoot = '';
  let panel = '';
  let handleRoot = '';

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-prefab-commands-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    const make = async (prefabId: string, name: string, child?: string): Promise<string[]> => {
      const root = (await post('createEntity', { kind: 'box', name, sceneId: 'scene-main' })).json.createdId as string;
      if (child !== undefined) await post('createEntity', { kind: 'box', name: child, parentId: root, transform: { position: [0.4, 0, 0] } });
      expect((await post('createPrefab', { prefabId, displayName: name, sourceEntityId: root })).status).toBe(200);
      await post('deleteEntity', { entityId: root });
      return (prefab(prefabId).entities as Any[]).map((e) => e.localId as string);
    };
    [doorRoot, panel] = (await make('door', 'Door', 'Panel')) as [string, string];
    [handleRoot] = (await make('handle', 'Handle')) as [string];
    const sessionId = mkSessionId();
    const est = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: PID, sessionId, clientInfo: { kind: 'browser', label: 'prefab-commands' } }, token: tb.authToken });
    expect(est.status, JSON.stringify(est.json).slice(0, 400)).toBe(200);
    const full = est.json as Any;
    projection = new Projection();
    projection.hydrate({ revision: full.revision, entities: full.scene.entities, entitySceneIds: full.scene.entitySceneIds, scenes: full.scene.scenes, startScenes: full.scene.startScenes });
    ws = await connectWs(`${tb.authUrl.replace(/^http/, 'ws')}/api/v1/ws?${new URLSearchParams({ sessionId, wsToken: full.wsToken }).toString()}`, { Origin: 'http://127.0.0.1:8501' });
    await ws.waitFor((m) => (m as Any).type === 'attached', 30_000);
  }, 120_000);
  afterAll(async () => {
    ws?.close();
    await tb?.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  let a = '';
  let b = '';
  const panelOf = (copy: string): string => prefabPartId(copy, panel);

  it('places linked copies; a part edited is an override; overrides revert by field and by part; each is one undo step', async () => {
    a = (await send('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'door', transform: { position: [2, 0, 0] } })).change.rootId;
    b = (await send('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'door', transform: { position: [5, 0, 0] } })).change.rootId;
    // One stored object per copy; its parts come assembled with ids derived from the copy's.
    expect(stored(a).components).toEqual({ transform: { position: [2, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, prefab: { prefabId: 'door' } });
    expect(stored(panelOf(a))).toBeUndefined();
    expect(await view(panelOf(a))).toMatchObject({ parentId: a, name: 'Panel', components: { prefab: { prefabId: 'door', localId: panel } } });

    const depth = (r: Any): number => r.history.undoDepth;
    const colour = await send('setComponent', { entityId: panelOf(a), component: 'box', value: { material: { color: '#cc2222' } } });
    expect(colour.change).toMatchObject({ type: 'prefabLinkEdit', copyIds: [a] });
    const moved = await send('setTransform', { entityId: panelOf(a), transform: { position: [0.6, 0.1, 0] } });
    expect(depth(moved)).toBe(depth(colour) + 1);
    expect(stored(a).components.prefab.overrides).toEqual([
      { part: panel, path: 'components/box/material/color', value: '#cc2222' },
      { part: panel, path: 'components/transform/position', value: [0.6, 0.1, 0] },
    ]);
    expect((await view(panelOf(b))).components.box.material?.color).not.toBe('#cc2222');
    // A part cannot leave its place in the copy.
    expect((await refused('moveEntities', { entityIds: [panelOf(a)], parentId: null })).code).toBe('prefab_override_unsupported');

    // A field reverted; undo brings it back, redo reverts it again.
    await send('revertPrefabOverrides', { entityId: panelOf(a), path: 'components/transform' });
    expect(stored(a).components.prefab.overrides).toEqual([{ part: panel, path: 'components/box/material/color', value: '#cc2222' }]);
    await send('undo', {});
    expect(stored(a).components.prefab.overrides).toHaveLength(2);
    await send('redo', {});
    expect(stored(a).components.prefab.overrides).toHaveLength(1);

    // A part deleted is a removal; the part reverted (by its path, as a removed part has no object) comes back.
    await send('deleteEntity', { entityId: panelOf(a) });
    expect(stored(a).components.prefab.overrides).toContainEqual({ part: panel, remove: true });
    expect(await view(panelOf(a))).toBeUndefined();
    await send('revertPrefabOverrides', { entityId: a, part: panel });
    expect(stored(a).components.prefab.overrides).toBeUndefined();
    expect((await view(panelOf(a))).components.box.material?.color).not.toBe('#cc2222');
    // Nothing left to revert.
    expect((await refused('revertPrefabOverrides', { entityId: a, all: true })).code).toBe('no_change');
    expect((await refused('revertPrefabOverrides', { entityId: 'box-999999' })).code).toBe('entity_not_found');
  }, 120_000);

  it('applies a field, then everything (an added object becomes a part); the other copy follows; undo and redo swap prefab and copy', async () => {
    await send('setComponent', { entityId: panelOf(a), component: 'box', value: { material: { color: '#2222cc' } } });
    await send('setComponent', { entityId: panelOf(a), component: 'box', value: { size: [0.2, 2, 0.2] } });
    const knob = (await send('createEntity', { kind: 'box', name: 'Knob', parentId: panelOf(a) })).createdId as string;
    expect(stored(knob)).toMatchObject({ parentId: a, parentPart: panel });
    expect(await view(knob)).toMatchObject({ parentId: panelOf(a) });

    // One field into the prefab: every door is blue, copy A keeps its size override.
    await send('applyPrefabOverrides', { entityId: panelOf(a), path: 'components/box/material/color' });
    expect(prefab('door').entities[1].components.box.material.color).toBe('#2222cc');
    expect((await view(panelOf(b))).components.box.material.color).toBe('#2222cc');
    expect(stored(a).components.prefab.overrides).toEqual([{ part: panel, path: 'components/box/size', value: [0.2, 2, 0.2] }]);

    // Everything: the size, and the knob as a new part of the prefab (copy A keeps the knob's id).
    const before = prefab('door');
    const all = await send('applyPrefabOverrides', { entityId: a, all: true });
    const after = prefab('door');
    const knobLocal = after.entities[2].localId as string;
    expect(after.entities.map((e: Any) => [e.name, e.parentLocalId ?? null])).toEqual([['Door', null], ['Panel', doorRoot], ['Knob', panel]]);
    expect(stored(a).components.prefab).toEqual({ prefabId: 'door', partIds: { [knobLocal]: knob } });
    expect(stored(knob)).toBeUndefined();
    expect(await view(knob)).toMatchObject({ parentId: panelOf(a), components: { prefab: { prefabId: 'door', localId: knobLocal } } });
    expect(await view(prefabPartId(b, knobLocal))).toMatchObject({ name: 'Knob', parentId: panelOf(b) });
    expect((await view(panelOf(b))).components.box.size).toEqual([0.2, 2, 0.2]);
    expect(all.change.prefabs).toEqual([{ prefabId: 'door', previous: before, next: after }]);

    await send('undo', {});
    expect(prefab('door')).toEqual(before);
    expect(stored(knob)).toMatchObject({ parentId: a, parentPart: panel });
    expect(await view(prefabPartId(b, knobLocal))).toBeUndefined();
    await send('redo', {});
    expect(prefab('door')).toEqual(after);

    // updatePrefab from a linked copy is the same apply: B's edit reaches A.
    await send('setComponent', { entityId: panelOf(b), component: 'box', value: { material: { color: '#22cc22' } } });
    const alias = await send('updatePrefab', { prefabId: 'door', fromEntity: b });
    expect(alias.change).toMatchObject({ type: 'prefabLinkEdit', copyIds: [b] });
    expect((await view(panelOf(a))).components.box.material.color).toBe('#22cc22');
    expect(stored(b).components.prefab.overrides).toBeUndefined();
  }, 120_000);

  it('Duplicate and Copy/Paste of a linked copy make a linked copy with the same overrides; a part alone pastes as a plain object', async () => {
    await send('setComponent', { entityId: panelOf(b), component: 'box', value: { material: { color: '#123456' } } });
    const tag = (await send('createEntity', { kind: 'group', name: 'Tag', parentId: panelOf(b) })).createdId as string;
    // What the editor's Duplicate sends: the subtree read entity by entity (parents first), as values to paste.
    const all = await fresh();
    const inside = new Set([b]);
    for (const e of all) if (e.parentId !== undefined && inside.has(e.parentId)) inside.add(e.id);
    const read = async (id: string): Promise<SelectionRead> => (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryEntity', projectId: PID, args: { entityId: id } }, token: tb.adminToken, origin: null })).json as SelectionRead;
    const reads = await Promise.all(all.filter((e) => inside.has(e.id)).map((e) => read(e.id)));
    const dup = (await send('pasteEntities', { entities: pasteValuesOf(reads), offset: [0.5, 0, 0], sceneId: 'scene-main' })).createdId as string;
    expect(stored(dup).components.prefab).toEqual({ prefabId: 'door', overrides: stored(b).components.prefab.overrides });
    expect(stored(dup).components.transform.position).toEqual([5.5, 0, 0]);
    expect(stored(prefabPartId(dup, panel))).toBeUndefined();
    expect((await view(prefabPartId(dup, panel))).components.box.material.color).toBe('#123456');
    const tagCopy = (readJson(join(dir(), 'scenes', 'scene-main.json')).scene.entities as Any[]).find((e) => e.name === 'Tag' && e.id !== tag);
    expect(tagCopy).toMatchObject({ parentId: dup, parentPart: panel });
    // The copy follows its prefab: an edit of the prefab reaches the duplicate too.
    await send('setComponent', { entityId: panelOf(a), component: 'box', value: { size: [0.3, 2, 0.3] } });
    await send('applyPrefabOverrides', { entityId: panelOf(a), path: 'components/box/size' });
    expect((await view(prefabPartId(dup, panel))).components.box.size).toEqual([0.3, 2, 0.3]);
    // A part on its own: an ordinary object beside it, no longer naming the prefab part.
    const lone = (await send('pasteEntities', { entities: pasteValuesOf([await read(panelOf(b))]), offset: [0.5, 0, 0], sceneId: 'scene-main' })).createdId as string;
    expect(stored(lone)).toMatchObject({ parentId: b, name: 'Panel' });
    expect(stored(lone).components.prefab).toBeUndefined();
    for (let i = 0; i < 6; i++) await send('undo', {});
    expect(stored(dup)).toBeUndefined();
    expect(stored(b).components.prefab.overrides).toBeUndefined();
  }, 120_000);

  it('a variant follows its base; a nested handle reaches every door; a prefab that would contain itself is refused; a copy unpacks', async () => {
    await send('createPrefabVariant', { basePrefabId: 'door', prefabId: 'red-door', displayName: 'Red door' });
    const v = (await send('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'red-door' })).change;
    const vPanel = (v.mapping as Any[]).find((m) => m.localId === `${doorRoot}/${panel}`).entityId as string;
    await send('setComponent', { entityId: vPanel, component: 'box', value: { material: { color: '#ff0000' } } });
    // A reader (the Inspector) learns the copy as stored: the variant it links (its root says so too), the part and its overrides.
    const read = (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryEntity', projectId: PID, args: { entityId: vPanel } }, token: tb.adminToken, origin: null })).json as Any;
    expect(read.prefabCopy).toMatchObject({ copyId: v.rootId, prefabId: 'red-door', part: `${doorRoot}/${panel}`, root: false, overrides: [{ part: `${doorRoot}/${panel}`, path: 'components/box/material/color', value: '#ff0000' }] });
    expect(read.prefabCopy.partIds[`${doorRoot}/${panel}`]).toBe(vPanel);
    expect((await view(v.rootId)).components.prefab).toEqual({ prefabId: 'red-door', localId: doorRoot });
    await send('applyPrefabOverrides', { entityId: v.rootId, all: true });
    // The variant keeps the colour as its nested copy's override; the doors stay green.
    expect(prefab('red-door').entities[0].components.prefab).toEqual({ prefabId: 'door', overrides: [{ part: panel, path: 'components/box/material/color', value: '#ff0000' }] });
    expect((await view(panelOf(a))).components.box.material.color).toBe('#22cc22');
    // An edit of the base reaches the variant's copies, except what the variant overrides.
    await send('setComponent', { entityId: panelOf(a), component: 'box', value: { size: [0.3, 2.2, 0.3] } });
    await send('applyPrefabOverrides', { entityId: panelOf(a), path: 'components/box/size' });
    expect((await view(vPanel)).components.box).toMatchObject({ size: [0.3, 2.2, 0.3], material: { color: '#ff0000' } });

    // A handle copy placed on door A and applied: every door (the variant's copies too) gets a handle.
    const h = (await send('instantiatePrefab', { sceneId: 'scene-main', prefabId: 'handle', parentId: a, transform: { position: [0.3, 1, 0] } })).change.rootId as string;
    await send('applyPrefabOverrides', { entityId: h });
    const nested = (prefab('door').entities as Any[]).find((e) => e.components.prefab?.prefabId === 'handle');
    expect(nested).toMatchObject({ parentLocalId: doorRoot, components: { prefab: { prefabId: 'handle' } } });
    expect(await view(h)).toMatchObject({ parentId: a, components: { prefab: { prefabId: 'handle', localId: handleRoot } } });
    expect(await view(prefabPartId(b, nested.localId))).toMatchObject({ name: 'Handle', parentId: b });
    expect(await view(prefabPartId(v.rootId, `${doorRoot}/${nested.localId}`))).toMatchObject({ name: 'Handle' });

    // The handle may not take a door: the door holds handles.
    const group = (await send('createEntity', { kind: 'group', name: 'Rig', sceneId: 'scene-main' })).createdId as string;
    await send('instantiatePrefab', { prefabId: 'door', parentId: group });
    expect(await refused('updatePrefab', { prefabId: 'handle', fromEntity: group })).toMatchObject({ code: 'prefab_cycle', prefabId: 'handle' });
    expect(await refused('createPrefabVariant', { basePrefabId: 'door', prefabId: 'red-door', displayName: 'Again' })).toMatchObject({ code: 'prefab_id_duplicate' });

    // Unpacked: plain objects with the same ids, no longer following the prefab; undo links it again.
    const ids = (await fresh()).filter((e) => e.id === b || e.parentId === b || e.id.startsWith(`${b}-`)).map((e) => e.id).sort();
    await send('unpackPrefab', { entityId: b });
    const plain = (readJson(join(dir(), 'scenes', 'scene-main.json')).scene.entities as Any[]).filter((e) => ids.includes(e.id));
    expect(plain.map((e) => e.id).sort()).toEqual(ids);
    for (const e of plain) expect(e.components.prefab, e.id).toBeUndefined();
    expect((await refused('applyPrefabOverrides', { entityId: b, all: true })).code).toBe('prefab_copy_required');
    await send('undo', {});
    expect(stored(b).components.prefab).toEqual({ prefabId: 'door' });
  }, 120_000);

  it('a prefab opened on its own: the ordinary commands on its stage change the prefab, every copy follows, one undo step each', async () => {
    const stage = async (prefabId: string): Promise<Any> => (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryPrefabs', projectId: PID, args: { prefabId, stage: true } }, token: tb.adminToken, origin: null })).json.stage;
    const door = await stage('door');
    expect(door.rootId).toBe(prefabStageId('door'));
    const named = (st: Any, name: string): Any => (st.entities as Any[]).find((e) => e.name === name);
    const stagePanel = named(door, 'Panel').id as string;
    const copies = (await fresh()).filter((e) => e.components.prefab?.prefabId === 'door' && e.components.prefab.localId === panel).map((e) => e.id as string);
    expect(copies.length).toBeGreaterThan(1);
    // A field of a part: the prefab changes, no scene object is stored differently, every copy shows it.
    const scene = JSON.stringify(readJson(join(dir(), 'scenes', 'scene-main.json')).scene.entities);
    const before = (await send('setComponent', { entityId: stagePanel, component: 'box', value: { size: [0.6, 2.4, 0.2] } })).history.undoDepth as number;
    expect((prefab('door').entities as Any[]).find((e) => e.localId === panel).components.box.size).toEqual([0.6, 2.4, 0.2]);
    expect(JSON.stringify(readJson(join(dir(), 'scenes', 'scene-main.json')).scene.entities)).toBe(scene);
    for (const id of copies) expect((await view(id)).components.box.size, id).toEqual([0.6, 2.4, 0.2]);
    expect(named(await stage('door'), 'Panel').components.box.size).toEqual([0.6, 2.4, 0.2]);
    expect((await send('undo', {})).history.undoDepth).toBe(before - 1);
    for (const id of copies) expect((await view(id)).components.box.size, id).not.toEqual([0.6, 2.4, 0.2]);
    await send('redo', {});
    // The nested handle is a copy in the prefab: its edit is an override on that nested copy.
    const stageHandle = named(door, 'Handle').id as string;
    await send('setComponent', { entityId: stageHandle, component: 'box', value: { material: { color: '#3355ff' } } });
    const nested = (prefab('door').entities as Any[]).find((e) => e.components.prefab?.prefabId === 'handle');
    expect(nested.components.prefab.overrides).toEqual([expect.objectContaining({ path: 'components/box/material/color', value: '#3355ff' })]);
    expect(prefab('handle').entities[0].components.box.material?.color).not.toBe('#3355ff');
    // A new object under a part becomes a part of the prefab, named by its stage id.
    const made = (await send('createEntity', { kind: 'box', name: 'Hinge', parentId: stagePanel })).createdId as string;
    expect(named(await stage('door'), 'Hinge')).toMatchObject({ id: made, parentId: stagePanel });
    expect((prefab('door').entities as Any[]).some((e) => e.name === 'Hinge')).toBe(true);
    // What each copy keeps as its own (the root's place) is not the prefab's; a stage edit names only its prefab.
    expect((await refused('setTransform', { entityId: door.rootId, transform: { position: [5, 0, 0] } })).code).toBe('prefab_override_unsupported');
    expect((await refused('deleteEntity', { entityId: made, entityIds: [copies[0]] })).code).toBe('prefab_override_unsupported');
  }, 120_000);
});
