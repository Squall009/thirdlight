/**
 * Linked prefab copies through the real service and filesystem: a project
 * whose scene holds linked copies (an object naming its prefab and the
 * overrides it keeps) and whose prefabs nest copies of other prefabs and
 * have a variant opens, and its scene assembles into plain objects the
 * runtime's own merged-scene validator accepts — parts with ids derived from
 * the copy and the part's local-id path (the same after the prefab changes),
 * overrides kept, the prefab's edits reaching the parts nobody overrides,
 * nested copies and variants expanded, objects added to a copy kept under
 * their part. A prefab that contains itself through nested copies is refused.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { assembleSceneEntities, createPrefabAssembler, prefabPartId, validateMergedSceneV4, type AssemblyEntity, type AssemblyPrefab } from '@thirdlight/project-model';

import { openWorkspaceService } from './service';
import type { WorkspaceService } from './index';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const PID = 'demo';
let seq = 0;
function revision(service: WorkspaceService): number {
  return (service.query({ op: 'queryProject', projectId: PID }) as unknown as { revision: number }).revision;
}
function ok(service: WorkspaceService, op: string, args: Record<string, unknown>): { createdId?: string; createdIds?: string[] } {
  seq += 1;
  const r = service.runCommand({ op, projectId: PID, expectedRevision: revision(service), requestId: `req-${(0xe000 + seq).toString(16).padStart(32, '0')}`, args });
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r as unknown as { createdId?: string; createdIds?: string[] };
}
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

function project(tag: string): { dir: string; open: () => WorkspaceService } {
  const root = join(tmpdir(), `tl-prefab-links-${tag}-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const open = (): WorkspaceService => openWorkspaceService({ root });
  const s = open();
  expect(s.createProject(PID, 'Demo').ok).toBe(true);
  s.close();
  return { dir: join(root, 'projects', PID), open };
}

/** A prefab made through the commands: a box root with box children (name → offset). */
function makePrefab(s: WorkspaceService, prefabId: string, root: string, children: Record<string, number>): void {
  const made = ok(s, 'createEntity', { kind: 'box', name: root, sceneId: 'scene-main' });
  const rootId = made.createdId as string;
  const names = Object.keys(children);
  if (names.length > 0) ok(s, 'createEntities', { entities: names.map((n) => ({ kind: 'box', name: n, parentId: rootId, transform: { position: [children[n], 0, 0] } })) });
  ok(s, 'createPrefab', { prefabId, displayName: root, sourceEntityId: rootId });
  ok(s, 'deleteEntity', { entityId: rootId });
}

/** The prefab resource file of a prefab id (its file is named after the display name). */
function prefabFile(dir: string, prefabId: string): string {
  const folder = join(dir, 'assets', 'prefabs');
  for (const f of readdirSync(folder)) {
    const doc = readJson(join(folder, f));
    if (doc['id'] === prefabId) return join(folder, f);
  }
  throw new Error(`no prefab file for ${prefabId}`);
}

type Def = { prefabId: string; entities: { localId: string; name?: string; parentLocalId?: string; components: Record<string, unknown> }[]; entityCount: number; depth: number };
function editPrefab(dir: string, prefabId: string, edit: (d: Def) => void): void {
  const file = prefabFile(dir, prefabId);
  const doc = readJson(file) as { data: Def };
  edit(doc.data);
  doc.data.entityCount = doc.data.entities.length;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}
function addPrefabFile(dir: string, def: Omit<Def, 'entityCount'> & { displayName: string }): void {
  const data = { createdRevision: 0, ...def, entityCount: def.entities.length };
  writeFileSync(join(dir, 'assets', 'prefabs', `${def.prefabId}.prefab.json`), `${JSON.stringify({ tlresource: 1, kind: 'prefab', id: def.prefabId, data }, null, 2)}\n`);
}
function editScene(dir: string, edit: (entities: Record<string, unknown>[]) => void): void {
  const file = join(dir, 'scenes', 'scene-main.json');
  const doc = readJson(file) as { scene: { entities: Record<string, unknown>[] } };
  edit(doc.scene.entities);
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

/** The project's start scene with its linked copies assembled, checked by the runtime's merged-scene validator. */
function assembled(s: WorkspaceService): { entities: AssemblyEntity[]; problems: ReturnType<typeof assembleSceneEntities>['problems'] } {
  const read = s.readCapturedV3(PID);
  if (!read.ok) throw new Error(read.error.code);
  const content = read.read.content as { prefabs: AssemblyPrefab[] };
  const scene = read.read.scene as { schemaVersion: 4; sceneId: string; revision: number; entities: AssemblyEntity[] };
  const out = assembleSceneEntities(scene.entities, createPrefabAssembler(content.prefabs));
  const checked = validateMergedSceneV4({ ...scene, entities: out.entities });
  expect(checked.ok, JSON.stringify(checked).slice(0, 800)).toBe(true);
  return out;
}
const byName = (entities: readonly AssemblyEntity[], name: string): AssemblyEntity[] => entities.filter((e) => e.name === name);
const posOf = (e: AssemblyEntity | undefined): unknown => (e?.components as { transform?: { position?: unknown } } | undefined)?.transform?.position;

describe('linked prefab copies', () => {
  it('assemble from the prefab with stable part ids, keep overrides, and follow prefab edits', () => {
    const { dir, open } = project('copies');
    const s = open();
    makePrefab(s, 'door', 'Door', { Handle: 0.4, Hinge: -0.5 });
    s.close();
    const door = readJson(prefabFile(dir, 'door')) as { data: Def };
    const [root, handle, hinge] = door.data.entities.map((e) => e.localId) as [string, string, string];

    editScene(dir, (entities) => {
      entities.push(
        { id: 'door-a', name: 'Front door', components: { transform: { position: [5, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, prefab: { prefabId: 'door' } } },
        {
          id: 'door-b',
          components: {
            transform: { position: [9, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            prefab: {
              prefabId: 'door',
              overrides: [
                // The colour of the handle, a moved hinge, and a removed part.
                { part: handle, path: 'components/box/size', value: [0.2, 0.2, 0.2] },
                { part: hinge, path: 'components/transform/position', value: [-0.7, 1, 0] },
                { part: root, path: 'name', value: 'Back door' },
              ],
            },
          },
        },
        // An object added to a copy: an ordinary object under one of its parts.
        { id: 'knocker', name: 'Knocker', parentId: 'door-b', parentPart: handle, components: { transform: { position: [0, 0.1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } },
      );
    });

    const s2 = open();
    let out = assembled(s2);
    expect(out.problems).toEqual([]);
    const front = out.entities.find((e) => e.id === 'door-a')!;
    expect(front.name).toBe('Front door');
    expect(posOf(front)).toEqual([5, 0, 0]);
    // Each part says which prefab part it is; its id is derived from the copy and the part.
    const frontHandle = out.entities.find((e) => e.id === prefabPartId('door-a', handle))!;
    expect(frontHandle).toMatchObject({ name: 'Handle', parentId: 'door-a', components: { prefab: { prefabId: 'door', localId: handle } } });
    expect(posOf(frontHandle)).toEqual([0.4, 0, 0]);
    const back = out.entities.find((e) => e.id === 'door-b')!;
    expect(back.name).toBe('Back door');
    expect((out.entities.find((e) => e.id === prefabPartId('door-b', handle))!.components as { box: { size: unknown } }).box.size).toEqual([0.2, 0.2, 0.2]);
    expect(posOf(out.entities.find((e) => e.id === prefabPartId('door-b', hinge)))).toEqual([-0.7, 1, 0]);
    expect(out.entities.find((e) => e.id === 'knocker')!.parentId).toBe(prefabPartId('door-b', handle));
    // Parents come before children (the validator checks it; the part ids are distinct).
    expect(new Set(out.entities.map((e) => e.id)).size).toBe(out.entities.length);
    s2.close();

    // The prefab changes: its handle moves and grows, a lock part is added. Every copy follows except what it overrides.
    editPrefab(dir, 'door', (d) => {
      const h = d.entities.find((e) => e.localId === handle)!;
      (h.components['transform'] as { position: number[] }).position = [0.45, 0, 0];
      (h.components['box'] as { size: number[] }).size = [0.3, 0.3, 0.3];
      d.entities.push({ localId: 'lock-1', name: 'Lock', parentLocalId: root, components: { transform: { position: [0.45, -0.2, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, box: { size: [0.1, 0.1, 0.1] } } });
    });
    const s3 = open();
    out = assembled(s3);
    expect(out.problems).toEqual([]);
    expect(posOf(out.entities.find((e) => e.id === prefabPartId('door-a', handle)))).toEqual([0.45, 0, 0]);
    expect((out.entities.find((e) => e.id === prefabPartId('door-a', handle))!.components as { box: { size: unknown } }).box.size).toEqual([0.3, 0.3, 0.3]);
    // The overridden size stays; the handle's move (not overridden) reaches the copy.
    expect((out.entities.find((e) => e.id === prefabPartId('door-b', handle))!.components as { box: { size: unknown } }).box.size).toEqual([0.2, 0.2, 0.2]);
    expect(posOf(out.entities.find((e) => e.id === prefabPartId('door-b', handle)))).toEqual([0.45, 0, 0]);
    expect(byName(out.entities, 'Lock').map((e) => e.id).sort()).toEqual([prefabPartId('door-a', 'lock-1'), prefabPartId('door-b', 'lock-1')].sort());
    // The ids of the parts that were there are the same as before the edit.
    expect(out.entities.find((e) => e.id === prefabPartId('door-b', hinge))).toBeDefined();
    s3.close();

    // A part the prefab drops leaves the override naming it stale (skipped and reported), nothing else.
    editPrefab(dir, 'door', (d) => {
      d.entities = d.entities.filter((e) => e.localId !== hinge);
    });
    const s4 = open();
    out = assembled(s4);
    expect(out.problems).toMatchObject([{ code: 'override_stale', entityId: 'door-b', part: hinge }]);
    expect(out.entities.find((e) => e.id === prefabPartId('door-a', hinge))).toBeUndefined();
    s4.close();
  });

  it('expand nested copies and variants; a removed nested part goes with its children; parts of either have their own ids', () => {
    const { dir, open } = project('nesting');
    const s = open();
    makePrefab(s, 'handle', 'Handle', { Grip: 0.1 });
    makePrefab(s, 'door', 'Door', {});
    s.close();
    const handle = (readJson(prefabFile(dir, 'handle')) as { data: Def }).data;
    const [handleRoot, grip] = handle.entities.map((e) => e.localId) as [string, string];
    const doorRoot = (readJson(prefabFile(dir, 'door')) as { data: Def }).data.entities[0]!.localId;
    const T = (x: number): Record<string, unknown> => ({ position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
    // The door nests a handle copy, and puts a sticker on the handle's grip (a part inside the nested copy).
    editPrefab(dir, 'door', (d) => {
      d.entities.push(
        { localId: 'nest-1', parentLocalId: doorRoot, components: { transform: T(0.4), prefab: { prefabId: 'handle', overrides: [{ part: grip, path: 'name', value: 'Door grip' }] } } },
        { localId: 'sticker-1', name: 'Sticker', parentLocalId: `nest-1/${grip}`, components: { transform: T(0.01), box: { size: [0.05, 0.05, 0.01] } } },
      );
      d.depth = 3;
    });
    // A locked door: a variant (its root a copy of the door) with a padlock of its own and the handle's grip overridden.
    addPrefabFile(dir, {
      prefabId: 'locked-door',
      displayName: 'Locked door',
      depth: 2,
      entities: [
        { localId: 'base-1', name: 'Locked door', components: { transform: T(0), prefab: { prefabId: 'door', overrides: [{ part: `nest-1/${grip}`, path: 'components/box/size', value: [0.4, 0.4, 0.4] }] } } },
        { localId: 'padlock-1', name: 'Padlock', parentLocalId: 'base-1', components: { transform: T(0.2), box: { size: [0.1, 0.1, 0.1] } } },
      ],
    });
    editScene(dir, (entities) => {
      entities.push(
        { id: 'door-1', components: { transform: T(1), prefab: { prefabId: 'door' } } },
        { id: 'locked-1', components: { transform: T(2), prefab: { prefabId: 'locked-door', overrides: [{ part: 'base-1/nest-1', path: 'components/transform/position', value: [0.5, 0, 0] }, { part: 'padlock-1', path: 'name', value: 'Big padlock' }] } } },
        { id: 'locked-2', components: { transform: T(3), prefab: { prefabId: 'locked-door', overrides: [{ part: 'base-1/nest-1', remove: true }] } } },
      );
    });
    const s2 = open();
    const out = assembled(s2);
    expect(out.problems).toEqual([]);
    // The door: its root, the nested handle (its root is the nested copy, `nest-1`), the grip inside it, and the sticker on the grip.
    const nestedHandle = out.entities.find((e) => e.id === prefabPartId('door-1', 'nest-1'))!;
    expect(nestedHandle).toMatchObject({ name: 'Handle', parentId: 'door-1', components: { prefab: { prefabId: 'handle', localId: handleRoot } } });
    expect(posOf(nestedHandle)).toEqual([0.4, 0, 0]);
    const doorGrip = out.entities.find((e) => e.id === prefabPartId('door-1', `nest-1/${grip}`))!;
    expect(doorGrip).toMatchObject({ name: 'Door grip', parentId: nestedHandle.id });
    expect(out.entities.find((e) => e.id === prefabPartId('door-1', 'sticker-1'))!.parentId).toBe(doorGrip.id);
    // The variant: the base's parts under `base-1`, its own padlock, the base's overrides and its own.
    const locked = out.entities.find((e) => e.id === 'locked-1')!;
    expect(locked).toMatchObject({ name: 'Locked door', components: { prefab: { prefabId: 'door', localId: doorRoot } } });
    expect(posOf(locked)).toEqual([2, 0, 0]);
    const lockedHandle = out.entities.find((e) => e.id === prefabPartId('locked-1', 'base-1/nest-1'))!;
    expect(posOf(lockedHandle)).toEqual([0.5, 0, 0]);
    const lockedGrip = out.entities.find((e) => e.id === prefabPartId('locked-1', `base-1/nest-1/${grip}`))!;
    expect(lockedGrip).toMatchObject({ name: 'Door grip', parentId: lockedHandle.id });
    expect((lockedGrip.components as { box: { size: unknown } }).box.size).toEqual([0.4, 0.4, 0.4]);
    expect(out.entities.find((e) => e.id === prefabPartId('locked-1', 'padlock-1'))).toMatchObject({ name: 'Big padlock', parentId: 'locked-1' });
    // The second locked door dropped its handle: the grip and the sticker on it go too.
    const second = out.entities.filter((e) => e.id === 'locked-2' || e.id.startsWith('locked-2-'));
    expect(second.map((e) => e.name).sort()).toEqual(['Locked door', 'Padlock']);
    s2.close();
  });

  it('refuse a prefab that contains itself through nested copies', () => {
    const { dir, open } = project('cycle');
    const s = open();
    makePrefab(s, 'a', 'A', {});
    makePrefab(s, 'b', 'B', {});
    s.close();
    const rootOf = (id: string): string => (readJson(prefabFile(dir, id)) as { data: Def }).data.entities[0]!.localId;
    const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    for (const [id, other] of [['a', 'b'], ['b', 'a']] as const) {
      editPrefab(dir, id, (d) => {
        d.entities.push({ localId: 'nest-1', parentLocalId: rootOf(id), components: { transform: T, prefab: { prefabId: other } } });
        d.depth = 2;
      });
    }
    const s2 = open();
    try {
      // The project does not open as it is: the prefab files name the cycle.
      const read = s2.readCapturedV3(PID);
      const problems = JSON.stringify(read.ok ? s2.query({ op: 'queryProject', projectId: PID }) : read.error);
      expect(read.ok ? problems : JSON.stringify(read.error)).toContain('prefab_cycle');
    } finally {
      s2.close();
    }
    // Assembly refuses the cycle too (a copy of it is left an empty object, with a problem).
    const assembler = createPrefabAssembler([
      { prefabId: 'a', entities: [{ localId: 'r', components: { transform: T } }, { localId: 'n', parentLocalId: 'r', components: { transform: T, prefab: { prefabId: 'b' } } }] },
      { prefabId: 'b', entities: [{ localId: 'r', components: { transform: T } }, { localId: 'n', parentLocalId: 'r', components: { transform: T, prefab: { prefabId: 'a' } } }] },
    ]);
    const made = assembler.assembleCopy({ id: 'copy-1', components: { transform: T, prefab: { prefabId: 'a' } } });
    expect(made.entities).toEqual([{ id: 'copy-1', components: { transform: T } }]);
    expect(made.problems).toMatchObject([{ code: 'prefab_cycle', entityId: 'copy-1' }]);
  });
});
