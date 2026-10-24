/**
 * A schemaVersion 7 project with plain prefab copies, opened over HTTP by
 * this engine (schema 8: copies are linked).
 *
 * The project is made through the commands, as the games made theirs: placed
 * props with parts under a group (doors), single-object enemies with per-copy
 * changes, a prop whose prefab file was lost, a copy with a part removed and an
 * object added under a part. Its files are then marked schemaVersion 7 (the
 * files a 7 engine wrote are exactly these: plain copies) and the project is
 * opened again. The editor's view and the export hold the same objects as
 * before, the shipped prefabs (which spawned enemies and live blocks use) are
 * the same, a run of the exported game (a script spawning an enemy, a live
 * block spawning its door) steps to the same digests, the Problems list says
 * once, per prefab, which copies came out with overrides and which objects
 * stay plain, and opening it again changes nothing.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BlockGrid, applyBlockEdits, isPrefabLink } from '@thirdlight/project-model';
import { physics3DConfigOf } from '@thirdlight/runtime';

import { api, exportContentOf, mkRequestId, mkSessionId, startBackend, type TestBackend } from '../../../packages/backend/src/test-helpers';
import { behaviorModule, startHarness } from '../m22-worker/harness';
import { DT, SETTINGS, type Any } from '../m23-3d/character-kit';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const PID = 'demo-0001';
const STEPS = 40;
const SPAWNER = `export default {
  step(s, ctx) { if (ctx.phase === 'intent' && ctx.stepIndex === 3) ctx.spawn('enemy', { position: [2, 1, 2] }); },
};
`;
const LAYER = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [4, 2, 4] } };
const BLOCK_TYPES = [{ blockId: 'door', name: 'Door', variants: [{ prefab: 'door' }], shape: 'none', live: true }];

describe('a schemaVersion 7 project with plain prefab copies opened over HTTP', () => {
  let tb: TestBackend;
  let exportRoot: string;
  const dir = (): string => join(tb.root, 'data', 'projects', PID);
  const readJson = (path: string): Any => JSON.parse(readFileSync(path, 'utf8'));
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = async (op: string, args: Record<string, unknown>): Promise<Any> => {
    const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'prefab-migration' }, args }, token: tb.adminToken, origin: null });
    expect(r.status, `${op}: ${JSON.stringify(r.json).slice(0, 600)}`).toBe(200);
    return r.json;
  };
  const open = async (): Promise<number> => {
    // A released project is re-claimed by the next read on the command path (a query never re-opens one).
    revision();
    const r = await api(`${tb.authUrl}/api/v1/sessions`, { body: { projectId: PID, sessionId: mkSessionId(), clientInfo: { kind: 'browser', label: 'prefab-migration' } }, token: tb.authToken });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    return (r.json as Any).revision as number;
  };
  /** A prefab made through the commands: a box root with box children (name → x), the source objects deleted. */
  const makePrefab = async (prefabId: string, root: string, children: Record<string, number>): Promise<void> => {
    const rootId = (await command('createEntity', { kind: 'box', name: root, sceneId: 'scene-main' })).createdId as string;
    const names = Object.keys(children);
    if (names.length > 0) await command('createEntities', { entities: names.map((n) => ({ kind: 'box', name: n, parentId: rootId, transform: { position: [children[n], 0, 0] } })) });
    await command('createPrefab', { prefabId, displayName: root, sourceEntityId: rootId });
    await command('deleteEntity', { entityId: rootId });
  };
  const place = async (prefabId: string, x: number, parentId?: string): Promise<{ rootId: string; part: (localIndex: number) => string }> => {
    const r = await command('instantiatePrefab', { sceneId: 'scene-main', prefabId, transform: { position: [x, 0, 0] }, ...(parentId !== undefined ? { parentId } : {}) });
    const mapping = r.change.mapping as { entityId: string }[];
    return { rootId: r.change.rootId as string, part: (i) => mapping[i]!.entityId };
  };
  const queryEntities = async (): Promise<Any[]> => ((await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op: 'queryEntities', projectId: PID, args: { limit: 16_384 } }, token: tb.adminToken, origin: null })).json as Any).entities;
  const exported = async (): Promise<{ entities: Any[]; prefabs: Any[] }> => {
    const r = await api(`${tb.authUrl}/api/v1/admin/projects/${PID}/export`, { body: {}, token: tb.adminToken, origin: null });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    const out = join(exportRoot, String((r.json as Any).outputDir));
    const content = exportContentOf(out);
    const row = (content.scenes as Any[]).find((s) => s.sceneId === 'scene-main');
    return { entities: readJson(join(out, row.path)).entities, prefabs: content.prefabs as Any[] };
  };
  /** The exported game's scene with a spawning script and a layer of live door blocks, run for STEPS steps. */
  const digests = async (game: { entities: Any[]; prefabs: Any[] }): Promise<string[]> => {
    const g = new BlockGrid(LAYER as Any);
    applyBlockEdits(g, [{ kind: 'fill', box: [1, 0, 1, 3, 1, 2], cell: { block: 'door' } }] as Any, { types: new Map(BLOCK_TYPES.map((t) => [t.blockId, t as Any])), stamps: new Map() });
    const blocks = g.toData('blocks-1', null, g.takeDirty().chunks)!;
    const entities = [
      ...game.entities,
      { id: 'blocks-1', components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, blockLayer: LAYER } },
      { id: 'spawner-1', components: { transform: { position: [0, -5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, behavior: { behaviorId: 'spawner', values: {} } } },
    ];
    const snapshot = { snapshotId: `${PID}@r1`, projectId: PID, revision: 1, scene: { schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities, blocks: [blocks] }, blockTypes: BLOCK_TYPES, prefabs: game.prefabs };
    const h = await startHarness('single', { snapshot, settings: SETTINGS, physics: physics3DConfigOf(entities, SETTINGS), behaviors: [behaviorModule('spawner', SPAWNER), behaviorModule('linker', 'export default { step() {} };\n', { properties: [{ key: 'target', label: 'Target', type: 'entityRef', default: null }] })], digestSteps: true, host: { buildId: 'b' } });
    try {
      for (let i = 1; i <= STEPS; i += 1) await h.tick(i * DT);
      const errors = (h.rt.getDiagnostics() as Any).diagnostics?.errors ?? [];
      expect(errors).toEqual([]);
      // The enemy and both live doors (each with its two parts) were spawned.
      expect((h.rt.sceneSet().spawned as Any[]).length).toBe(1 + 2 * 3);
      return [...h.digests];
    } finally {
      await h.dispose();
    }
  };
  const upgradeNotes = async (): Promise<string[]> => ((await api(`${tb.authUrl}/api/v1/projects/${PID}/problems`, { method: 'GET', token: tb.adminToken, origin: null })).json as Any).problems.filter((p: Any) => p.code === 'project_upgraded').map((p: Any) => p.message as string);
  const prefabFile = (prefabId: string): string => {
    const folder = join(dir(), 'assets', 'prefabs');
    const f = readdirSync(folder).find((n) => readJson(join(folder, n)).id === prefabId);
    if (f === undefined) throw new Error(`no prefab file for ${prefabId}`);
    return join(folder, f);
  };
  /** The before objects as the upgrade leaves them: the lost crate's objects no longer name its prefab. */
  const withoutCrate = (entities: readonly Any[]): Any[] => entities.map((e) => {
    if (e.components?.prefab?.prefabId !== 'crate') return e;
    const { prefab: _crate, ...components } = e.components;
    void _crate;
    return { ...e, components };
  });
  /** The revision the files on disk state (the open starts from it). */
  const diskRevision = (): number => Math.max(readJson(join(dir(), 'content.json')).revision, ...readdirSync(join(dir(), 'scenes')).map((f) => readJson(join(dir(), 'scenes', f)).scene.revision as number));
  const projectFiles = (): Map<string, string> => {
    const out = new Map<string, string>();
    for (const rel of ['project.json', 'content.json', ...readdirSync(join(dir(), 'scenes')).map((f) => `scenes/${f}`)]) out.set(rel, readFileSync(join(dir(), rel), 'utf8'));
    return out;
  };

  const before: { view: Any[]; game: { entities: Any[]; prefabs: Any[] }; digests: string[] } = { view: [], game: { entities: [], prefabs: [] }, digests: [] };
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    exportRoot = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'tl-prefab-migration-export-'));
    tb = await startBackend({ exportRoot, engineRoot: REPO });
    await makePrefab('door', 'Door', { Panel: 0.4, Sensor: -0.4 });
    await makePrefab('enemy', 'Enemy', {});
    await makePrefab('crate', 'Crate', { Lid: 0 });
    const group = (await command('createEntity', { kind: 'group', name: 'Doors', sceneId: 'scene-main' })).createdId as string;
    // Doors under a group: one as placed, one recoloured, one without its sensor and renamed, with a lamp under its panel.
    const d1 = await place('door', 0, group);
    const d2 = await place('door', 3, group);
    const d3 = await place('door', 6, group);
    await command('setComponent', { entityId: d2.part(1), component: 'box', value: { size: [1, 1, 1], material: { color: '#22aa22' } } });
    await command('deleteEntity', { entityId: d3.part(2) });
    await command('updateEntity', { entityId: d3.rootId, name: 'Back door' });
    const lamp = (await command('createEntity', { kind: 'group', name: 'Lamp', parentId: d3.part(1), sceneId: 'scene-main' })).createdId as string;
    // Enemies placed in the level, one moved further (the root's own placement) and one retagged.
    const e1 = await place('enemy', 10);
    const e2 = await place('enemy', 12);
    await command('updateEntity', { entityId: e2.rootId, keepLoaded: true });
    // A crate whose prefab file is lost while the project is closed (below).
    const c1 = await place('crate', 20);
    // Objects outside the copies that name a copy's part: a lever whose target is a door's panel, and a scene
    // transition whose spawn is a placed spawn-point prefab (the copy's root, whose playerSpawn is the prefab's).
    await command('publishBehavior', { behaviorId: 'linker', displayName: 'Linker', mode: 'declaration-create', declaration: { properties: [{ key: 'target', label: 'Target', type: 'entityRef', default: null }] } });
    const lever = (await command('createEntity', { kind: 'box', name: 'Lever', sceneId: 'scene-main', transform: { position: [-4, 0, 0] } })).createdId as string;
    await command('setBehaviorProperties', { entityId: lever, behaviorId: 'linker', values: { target: d1.part(1) } });
    const padRoot = (await command('createEntity', { kind: 'group', name: 'Pad', sceneId: 'scene-main', components: { playerSpawn: {} } })).createdId as string;
    await command('createEntity', { kind: 'box', name: 'Marker', parentId: padRoot, sceneId: 'scene-main' });
    await command('createPrefab', { prefabId: 'pad', displayName: 'Pad', sourceEntityId: padRoot });
    await command('deleteEntity', { entityId: padRoot });
    const pad = await place('pad', -8);
    const exit = (await command('createEntity', { kind: 'group', name: 'Exit', sceneId: 'scene-main', transform: { position: [-12, 1, 0] }, components: { trigger: { size: [1, 2, 2], signal: 'exit', sceneTransition: { scene: 'scene-main', spawn: pad.rootId } } } })).createdId as string;
    Object.assign(ids, { group, d1: d1.rootId, d1Panel: d1.part(1), d2: d2.rootId, d2Panel: d2.part(1), d3: d3.rootId, d3Panel: d3.part(1), lamp, e1: e1.rootId, e2: e2.rootId, c1: c1.rootId, c1Lid: c1.part(1), lever, pad: pad.rootId, exit });

    before.view = await queryEntities();
    before.game = await exported();
    before.digests = await digests(before.game);
    expect(before.digests.length).toBeGreaterThan(STEPS / 2);
    // The same files as a schemaVersion 7 engine wrote them: plain copies, each part naming its prefab part —
    // which is what the copies the commands placed (linked) assemble into.
    const captured = (tb.backend._test.service.readCapturedV3(PID) as Any).read.scenes as Any;
    const plain = (Array.isArray(captured) ? captured.find((x: Any) => x.sceneId === 'scene-main') : captured.get('scene-main')).entities as Any[];
    expect(tb.backend._test.service.releaseWorkspace(PID).ok).toBe(true);
    const manifest = readJson(join(dir(), 'project.json'));
    writeFileSync(join(dir(), 'project.json'), `${JSON.stringify({ ...manifest, schemaVersion: 7 }, null, 2)}\n`);
    const sceneFile = join(dir(), 'scenes', 'scene-main.json');
    writeFileSync(sceneFile, `${JSON.stringify({ ...readJson(sceneFile), scene: { ...readJson(sceneFile).scene, entities: plain } }, null, 2)}\n`);
    rmSync(prefabFile('crate'));
    const stored = readJson(join(dir(), 'scenes', 'scene-main.json')).scene.entities as Any[];
    expect(stored.find((e) => e.id === ids['d1Panel']).components.prefab).toMatchObject({ prefabId: 'door' });
  }, 180_000);
  afterAll(async () => {
    await tb?.teardown();
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it('opens as schemaVersion 8 with linked copies; the editor, the export and a run of the game see what they saw before', async () => {
    const r0 = diskRevision();
    // One new revision: the upgraded scene is written back.
    expect(await open()).toBe(r0 + 1);
    expect(readJson(join(dir(), 'project.json')).schemaVersion).toBe(8);
    const stored = new Map((readJson(join(dir(), 'scenes', 'scene-main.json')).scene.entities as Any[]).map((e) => [e.id, e]));
    for (const id of [ids['d1'], ids['d2'], ids['d3'], ids['e1'], ids['e2']]) expect(isPrefabLink(stored.get(id!).components.prefab), id).toBe(true);
    // The parts are made from the prefab now; they keep their ids.
    expect(stored.has(ids['d1Panel']!)).toBe(false);
    expect(stored.get(ids['d1']!).components.prefab).toEqual({ prefabId: 'door', partIds: expect.objectContaining({}) });
    expect(Object.values(stored.get(ids['d2']!).components.prefab.partIds)).toContain(ids['d2Panel']);
    expect(stored.get(ids['d2']!).components.prefab.overrides).toEqual([expect.objectContaining({ path: 'components/box/material/color', value: '#22aa22' })]);
    expect(stored.get(ids['d3']!)).toMatchObject({ name: 'Back door', components: { prefab: { overrides: [expect.objectContaining({ remove: true })] } } });
    expect(stored.get(ids['lamp']!)).toMatchObject({ parentId: ids['d3'], parentPart: expect.any(String) });
    expect(stored.get(ids['e2']!)).toMatchObject({ keepLoaded: true, components: { prefab: { prefabId: 'enemy' } } });
    expect(stored.get(ids['e2']!).components.prefab.overrides).toBeUndefined();
    // The crate's prefab is gone: its objects stay plain, no longer naming it.
    expect(stored.get(ids['c1']!).components.prefab).toBeUndefined();
    expect(stored.has(ids['c1Lid']!)).toBe(true);
    // The references to copies' parts still name them, though the parts are no stored objects now.
    // The spawn point is a copy's root: stored, it is only its link (its playerSpawn comes from the prefab).
    expect(stored.get(ids['pad']!).components).toEqual({ transform: expect.any(Object), prefab: { prefabId: 'pad', partIds: expect.any(Object) } });
    expect(stored.has(ids['d1Panel']!)).toBe(false);
    expect(stored.get(ids['lever']!).components.behavior.values).toEqual({ target: ids['d1Panel'] });
    expect(stored.get(ids['exit']!).components.trigger.sceneTransition.spawn).toBe(ids['pad']);

    expect(await queryEntities()).toEqual(withoutCrate(before.view));
    const after = await exported();
    expect(after.entities).toEqual(withoutCrate(before.game.entities));
    expect(after.prefabs).toEqual(before.game.prefabs.filter((p) => p.prefabId !== 'crate'));
    expect(await digests(after)).toEqual(before.digests);
  }, 120_000);

  it('says once, per prefab, which copies keep overrides and which objects stay plain; reopening changes nothing', async () => {
    const notes = await upgradeNotes();
    expect(notes).toContain('project schemaVersion 7 → 8');
    const door = notes.filter((n) => n.startsWith('Prefab "door"'));
    expect(door).toEqual([`Prefab "door": 2 copies keep their differences from the prefab as overrides — "${ids['d2']}" (scene "scene-main"), "${ids['d3']}" (scene "scene-main")`]);
    expect(notes.filter((n) => n.startsWith('Prefab "enemy"'))).toEqual([]);
    expect(notes.filter((n) => n.startsWith('Prefab "crate"'))).toEqual([`Prefab "crate" is gone: 2 objects stay plain, no longer naming it — "${ids['c1']}" (scene "scene-main"), "${ids['c1Lid']}" (scene "scene-main")`]);

    const files = projectFiles();
    expect(tb.backend._test.service.releaseWorkspace(PID).ok).toBe(true);
    const r = diskRevision();
    expect(await open()).toBe(r);
    expect(projectFiles()).toEqual(files);
    expect(await upgradeNotes()).toEqual(notes);
    expect(await queryEntities()).toEqual(withoutCrate(before.view));
  }, 120_000);
});
