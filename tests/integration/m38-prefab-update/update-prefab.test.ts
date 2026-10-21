/**
 * `updatePrefab` on the real filesystem with the real workspace service, and
 * what a script that spawns the prefab by name gets afterwards.
 *
 * A two-part crate becomes a prefab; one copy is placed and edited (a bigger
 * box, a new part, a script property naming the new part); a second copy is
 * placed and left alone. A script library names the prefab, so it cannot be
 * deleted, but applying the edited copy replaces its contents under the same
 * id: the parts it came from keep their local ids, the new part is named by
 * its scene id, the reference names the local id, the untouched copy stays as
 * it was. Undo and redo swap the whole definition. The play content built
 * from the project carries the new contents, and a script's `ctx.spawn` of the
 * prefab id makes a copy of them in the running game.
 */
import { describe, expect, it } from 'vitest';

import { readRuntimeContentSync } from '@thirdlight/project-model';

import { makeBuildEnv, requestId, ORIGIN, type BuildEnv } from '../m2-builds/helpers';
import { behaviorModule, startHarness } from '../m22-worker/harness';
import { DT, SETTINGS, sceneOf, type Any } from '../m23-3d/character-kit';

let n = 0x38600;
const rid = (): string => requestId((n += 1));
const revision = (env: BuildEnv): number => (env.svc.query({ op: 'queryProject', projectId: env.project }) as { revision: number }).revision;
function command(env: BuildEnv, op: string, args: Record<string, unknown>): Any {
  return env.svc.runCommand({ op, projectId: env.project, expectedRevision: revision(env), requestId: rid(), origin: ORIGIN, args });
}
function ok(env: BuildEnv, op: string, args: Record<string, unknown>): Any {
  const r = command(env, op, args);
  expect(r.ok, JSON.stringify(r).slice(0, 600)).toBe(true);
  return r;
}
function refused(env: BuildEnv, op: string, args: Record<string, unknown>): { code: string; message: string } {
  const r = command(env, op, args);
  expect(r.ok, JSON.stringify(r).slice(0, 400)).toBe(false);
  return r.error;
}
const definition = (env: BuildEnv, prefabId: string): Any =>
  (env.svc.query({ op: 'queryPrefabs', projectId: env.project, args: { prefabId, includeEntities: true } }) as Any).prefabs[0];
const entity = (env: BuildEnv, entityId: string): Any => (env.svc.query({ op: 'queryEntity', projectId: env.project, args: { entityId } }) as Any).entity;

const SPAWNER = `export default {
  step(s, ctx) { if (ctx.phase === 'intent' && ctx.stepIndex === 2) ctx.spawn('crate', { position: [0, 4, 0] }); },
};
`;

describe('updatePrefab', () => {
  it('replaces a prefab in use under the same id, leaves placed copies alone, undoes, and a script spawns the new contents', async () => {
    const env = makeBuildEnv('m38-prefab-update');
    ok(env, 'publishBehavior', { behaviorId: 'linker', displayName: 'Linker', mode: 'declaration-create', declaration: { properties: [{ key: 'target', label: 'Target', type: 'entityRef', default: null }] } });
    const root = ok(env, 'createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Crate' }).createdId as string;
    const lid = ok(env, 'createEntity', { kind: 'box', name: 'Lid', parentId: root }).createdId as string;
    ok(env, 'createPrefab', { prefabId: 'crate', displayName: 'Crate', sourceEntityId: root });
    const before = definition(env, 'crate');
    expect(before.entities.map((e: Any) => e.localId)).toEqual([root, lid]);
    expect(before.updatedRevision).toBeUndefined();

    // Two copies: one to edit and apply, one left alone.
    const placed = ok(env, 'instantiatePrefab', { sceneId: 'scene-main', prefabId: 'crate' });
    const copyRoot = placed.change.rootId as string;
    const copyLid = (placed.change.mapping as { localId: string; entityId: string }[]).find((m) => m.localId === lid)!.entityId;
    const other = ok(env, 'instantiatePrefab', { sceneId: 'scene-main', prefabId: 'crate' });
    const otherLid = (other.change.mapping as { localId: string; entityId: string }[]).find((m) => m.localId === lid)!.entityId;
    const otherBefore = entity(env, otherLid);

    // A script library names the prefab: it cannot be deleted, it can be updated.
    ok(env, 'setScriptLibrary', { libraryId: 'drops', name: 'Drops', files: [{ path: 'src/index.ts', text: "export const drop = (ctx: { spawn(id: string, o: unknown): unknown }) => ctx.spawn('crate', { position: [0, 0, 0] });\n" }] });
    expect(refused(env, 'deletePrefab', { prefabId: 'crate' }).code).toBe('reference_in_use');

    // The edited copy: a bigger lid, a new handle, the root's script naming the handle.
    ok(env, 'setComponent', { entityId: copyLid, component: 'box', value: { size: [2, 0.5, 2] } });
    const handle = ok(env, 'createEntity', { kind: 'box', name: 'Handle', parentId: copyRoot }).createdId as string;
    ok(env, 'setBehaviorProperties', { entityId: copyRoot, behaviorId: 'linker', values: { target: handle } });

    // Refusals: no such prefab, no such object, a copy of another prefab inside, an unknown argument.
    ok(env, 'createPrefab', { prefabId: 'barrel', displayName: 'Barrel', sourceEntityId: lid });
    const barrel = ok(env, 'instantiatePrefab', { sceneId: 'scene-main', prefabId: 'barrel', parentId: root }).change.rootId as string;
    expect(refused(env, 'updatePrefab', { prefabId: 'nope', fromEntity: copyRoot }).code).toBe('prefab_not_found');
    expect(refused(env, 'updatePrefab', { prefabId: 'crate', fromEntity: 'box-999999' }).code).toBe('entity_not_found');
    expect(refused(env, 'updatePrefab', { prefabId: 'crate', fromEntity: root }).code).toBe('prefab_nested_forbidden');
    expect(refused(env, 'updatePrefab', { prefabId: 'crate', fromEntity: copyRoot, extra: 1 }).code).toBe('field_unexpected');
    ok(env, 'deleteEntity', { entityId: barrel });

    const rev = revision(env);
    const applied = ok(env, 'updatePrefab', { prefabId: 'crate', fromEntity: copyRoot });
    expect(applied.revision).toBe(rev + 1);
    expect(applied.change.type).toBe('updatePrefab');
    expect(applied.change.previous).toEqual(before);
    const after = definition(env, 'crate');
    expect(applied.change.next).toEqual(after);
    expect(after).toMatchObject({ prefabId: 'crate', displayName: 'Crate', createdRevision: before.createdRevision, updatedRevision: rev + 1, entityCount: 3, depth: 2 });
    // The parts keep their local ids; the new one is named by its scene id; the reference names the local id.
    expect(after.entities.map((e: Any) => [e.localId, e.parentLocalId ?? null, e.name])).toEqual([[root, null, 'Crate'], [lid, root, 'Lid'], [handle, root, 'Handle']]);
    expect(after.entities[1].components.box.size).toEqual([2, 0.5, 2]);
    expect(after.entities[0].components.behavior).toEqual({ behaviorId: 'linker', values: { target: handle } });
    // The untouched copy keeps what it has (copies are independent); its provenance still resolves.
    expect(entity(env, otherLid)).toEqual(otherBefore);
    // Applying the same contents again changes nothing.
    expect(refused(env, 'updatePrefab', { prefabId: 'crate', fromEntity: copyRoot }).code).toBe('no_change');
    // A new name is taken when given.
    ok(env, 'updatePrefab', { prefabId: 'crate', fromEntity: copyRoot, displayName: 'Big crate' });
    expect(definition(env, 'crate').displayName).toBe('Big crate');
    ok(env, 'undo', {});

    // Undo puts the old contents back; redo the new ones.
    const undone = ok(env, 'undo', {});
    expect(undone.change).toMatchObject({ type: 'updatePrefab', prefabId: 'crate' });
    expect(definition(env, 'crate')).toEqual(before);
    ok(env, 'redo', {});
    expect(definition(env, 'crate')).toEqual(after);

    // The play content carries the new contents; a script's spawn by id makes a copy of them.
    ok(env, 'setScriptLibrary', { libraryId: 'drops', files: [{ path: 'src/index.ts', text: 'export const drop = 1;\n' }] });
    const captured = env.svc.readCapturedV3(env.project) as Any;
    expect(captured.ok, JSON.stringify(captured).slice(0, 400)).toBe(true);
    const { buildContentClosureM3 } = await import('@thirdlight/exporter');
    const built = await buildContentClosureM3({
      service: env.svc,
      compiler: env.compiler as never,
      projectId: env.project,
      revision: captured.revision ?? 1,
      capturedAt: '2026-10-21T00:00:00Z',
      scene: captured.read.scene,
      content: captured.read.content,
      ...(captured.read.scenes !== undefined ? { scenes: captured.read.scenes, startScenes: captured.read.startScenes ?? [] } : {}),
    } as Any);
    expect(built.ok, JSON.stringify(built).slice(0, 400)).toBe(true);
    if (!built.ok) return;
    const files = new Map(built.closure.contentFileArtifacts.map((f: Any) => [f.path, f.bytes]));
    const prefabs = readRuntimeContentSync(built.closure.manifest, (p) => (files.get(p) as Uint8Array | undefined) ?? null).prefabs as Any[];
    const shipped = prefabs.find((p) => p.prefabId === 'crate');
    expect(shipped.entities).toEqual(after.entities);

    const spawner = { id: 'spawner-1', components: { transform: { position: [0, -5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, behavior: { behaviorId: 'spawner', values: {} } } };
    const scene = sceneOf({}, [0, 1, 0], [spawner], 'prefab-update');
    const h = await startHarness('single', {
      snapshot: { ...scene.snapshot, prefabs: [shipped] },
      settings: SETTINGS,
      physics: scene.physics,
      behaviors: [behaviorModule('spawner', SPAWNER), behaviorModule('linker', 'export default { step() {} };\n', { properties: [{ key: 'target', label: 'Target', type: 'entityRef', default: null }] })],
    });
    try {
      for (let i = 1; i <= 6; i += 1) await h.tick(i * DT);
      const spawned = h.rt.sceneSet().spawned as Any[];
      expect(spawned.map((e) => e.components.prefab)).toEqual([{ prefabId: 'crate', localId: root }, { prefabId: 'crate', localId: lid }, { prefabId: 'crate', localId: handle }]);
      expect(spawned[1].components.box.size).toEqual([2, 0.5, 2]);
      // The copy's script names the copy's own handle.
      expect(spawned[0].components.behavior.values.target).toBe(spawned[2].id);
    } finally {
      await h.dispose();
      env.svc.dispose();
    }
  });
});
