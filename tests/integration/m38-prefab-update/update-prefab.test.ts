/**
 * `updatePrefab` on the real filesystem with the real workspace service, and
 * what a script that spawns the prefab by name gets afterwards.
 *
 * A two-part crate becomes a prefab; one linked copy is placed and edited (a
 * bigger box and a script property naming a new object, kept as its
 * overrides, and the new object added to it); a second copy is placed and
 * left alone. A script library names the prefab, so it cannot be deleted,
 * but `updatePrefab` from the edited copy applies all of it: the parts keep
 * their local ids, the added object becomes a part (with a new local id; the
 * copy keeps its scene id), the reference names that local id, and the
 * untouched copy follows the prefab. Undo and redo swap the definition and
 * the copy. The play content built from the project carries the new
 * contents, and a script's `ctx.spawn` of the prefab id makes a copy of them
 * in the running game.
 */
import { describe, expect, it } from 'vitest';

import { readRuntimeContentSync } from '@thirdlight/project-model';

import { makeBuildEnv, requestId, ORIGIN, type BuildEnv } from '../m2-builds/helpers';
import { behaviorModule, startHarness } from '../m22-worker/harness';
import { DT, SETTINGS, sceneOf, type Any } from '../3d/character-kit';

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
  it('applies a linked copy to the prefab in use under the same id, every copy follows, undoes, and a script spawns the new contents', async () => {
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

    // Refusals: no such prefab, no such object, a copy of the prefab inside what would become it, an unknown argument.
    const inner = ok(env, 'instantiatePrefab', { sceneId: 'scene-main', prefabId: 'crate', parentId: root }).change.rootId as string;
    expect(refused(env, 'updatePrefab', { prefabId: 'nope', fromEntity: copyRoot }).code).toBe('prefab_not_found');
    expect(refused(env, 'updatePrefab', { prefabId: 'crate', fromEntity: 'box-999999' }).code).toBe('entity_not_found');
    expect(refused(env, 'updatePrefab', { prefabId: 'crate', fromEntity: root }).code).toBe('prefab_cycle');
    expect(refused(env, 'updatePrefab', { prefabId: 'crate', fromEntity: copyRoot, extra: 1 }).code).toBe('field_unexpected');
    ok(env, 'deleteEntity', { entityId: inner });

    const rev = revision(env);
    const applied = ok(env, 'updatePrefab', { prefabId: 'crate', fromEntity: copyRoot });
    expect(applied.revision).toBe(rev + 1);
    expect(applied.change).toMatchObject({ type: 'prefabLinkEdit', copyIds: [copyRoot], removedIds: [handle] });
    expect(applied.change.prefabs[0].previous).toEqual(before);
    const after = definition(env, 'crate');
    expect(applied.change.prefabs[0].next).toEqual(after);
    expect(after).toMatchObject({ prefabId: 'crate', displayName: 'Crate', createdRevision: before.createdRevision, updatedRevision: rev + 1, entityCount: 3, depth: 2 });
    // The parts keep their local ids; the added object is a new part; the reference names its local id.
    const handleLocal = after.entities[2].localId as string;
    expect(after.entities.map((e: Any) => [e.localId, e.parentLocalId ?? null, e.name])).toEqual([[root, null, 'Crate'], [lid, root, 'Lid'], [handleLocal, root, 'Handle']]);
    expect(after.entities[1].components.box.size).toEqual([2, 0.5, 2]);
    expect(after.entities[0].components.behavior).toEqual({ behaviorId: 'linker', values: { target: handleLocal } });
    // The applying copy keeps no overrides and keeps its handle's id, now a part; the other copy follows the prefab.
    expect(entity(env, handle)).toMatchObject({ name: 'Handle', parentId: copyRoot, components: { prefab: { prefabId: 'crate', localId: handleLocal } } });
    expect(entity(env, copyRoot).components.behavior.values.target).toBe(handle);
    expect(otherBefore.components.box.size).not.toEqual([2, 0.5, 2]);
    expect(entity(env, otherLid).components.box.size).toEqual([2, 0.5, 2]);
    // Applying the same contents again changes nothing.
    expect(refused(env, 'updatePrefab', { prefabId: 'crate', fromEntity: copyRoot }).code).toBe('no_change');
    // A new name is taken when given.
    ok(env, 'updatePrefab', { prefabId: 'crate', fromEntity: copyRoot, displayName: 'Big crate' });
    expect(definition(env, 'crate').displayName).toBe('Big crate');
    ok(env, 'undo', {});

    // Undo puts the old contents back; redo the new ones.
    const undone = ok(env, 'undo', {});
    expect(undone.change).toMatchObject({ type: 'prefabLinkEdit', copyIds: [copyRoot] });
    // The prefab and the copy as they were: the handle an object added to the copy again.
    expect(definition(env, 'crate')).toEqual(before);
    expect(entity(env, otherLid)).toEqual(otherBefore);
    expect(entity(env, handle).components.prefab).toBeUndefined();
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
      expect(spawned.map((e) => e.components.prefab)).toEqual([{ prefabId: 'crate', localId: root }, { prefabId: 'crate', localId: lid }, { prefabId: 'crate', localId: handleLocal }]);
      expect(spawned[1].components.box.size).toEqual([2, 0.5, 2]);
      // The copy's script names the copy's own handle.
      expect(spawned[0].components.behavior.values.target).toBe(spawned[2].id);
    } finally {
      await h.dispose();
      env.svc.dispose();
    }
  });

  it('refuses a prefab that would hold itself, and never gives a dropped part\'s id to a new part', () => {
    const env = makeBuildEnv('m38-prefab-update-ids');
    try {
      const root = ok(env, 'createEntity', { sceneId: 'scene-main', kind: 'group', name: 'Crate' }).createdId as string;
      const lid = ok(env, 'createEntity', { kind: 'box', name: 'Lid', parentId: root }).createdId as string;
      const knob = ok(env, 'createEntity', { kind: 'box', name: 'Knob', parentId: root }).createdId as string;
      ok(env, 'createPrefab', { prefabId: 'crate', displayName: 'Crate', sourceEntityId: root });
      // A copy placed under another copy's part reports its parts with the copy's change (`placed`).
      const mapOf = (r: Any): Map<string, string> => new Map(((r.change.mapping ?? r.change.placed.mapping) as { localId: string; entityId: string }[]).map((m) => [m.localId, m.entityId]));

      // Copy A, and copy B placed under A's lid.
      const a = mapOf(ok(env, 'instantiatePrefab', { sceneId: 'scene-main', prefabId: 'crate' }));
      const b = mapOf(ok(env, 'instantiatePrefab', { sceneId: 'scene-main', prefabId: 'crate', parentId: a.get(lid) }));
      // Applying A would make B (added under A's lid) a nested copy of the prefab in itself.
      const nested = command(env, 'updatePrefab', { prefabId: 'crate', fromEntity: a.get(root) }) as Any;
      expect(nested.ok).toBe(false);
      expect(nested.error).toMatchObject({ code: 'prefab_cycle', prefabId: 'crate' });
      expect(nested.error.message).toContain('would contain itself');

      // B on its own applies; without its knob, the knob part is dropped.
      ok(env, 'deleteEntity', { entityId: b.get(knob) });
      ok(env, 'updatePrefab', { prefabId: 'crate', fromEntity: b.get(root) });
      const dropped = definition(env, 'crate');
      expect(dropped.entities.map((e: Any) => e.localId)).toEqual([root, lid]);
      expect(dropped.nextLocalNumber).toBeGreaterThan(Number(/-(\d+)$/.exec(knob)![1]));

      // A new part whose scene id another part already has gets a fresh id, never the dropped knob's
      // (copy A still names its knob by that id): the original lid moved into a new copy C.
      const c = mapOf(ok(env, 'instantiatePrefab', { sceneId: 'scene-main', prefabId: 'crate' }));
      ok(env, 'moveEntities', { entityIds: [lid], parentId: c.get(root) });
      ok(env, 'updatePrefab', { prefabId: 'crate', fromEntity: c.get(root) });
      const grown = definition(env, 'crate');
      const fresh = grown.entities.map((e: Any) => e.localId)[2] as string;
      expect(grown.entities.map((e: Any) => [e.localId, e.parentLocalId ?? null, e.name])).toEqual([[root, null, 'Crate'], [lid, root, 'Lid'], [fresh, root, 'Lid']]);
      expect([root, lid, knob]).not.toContain(fresh);
      expect(grown.nextLocalNumber).toBeGreaterThan(dropped.nextLocalNumber);
      // Undo puts the two-part contents back.
      ok(env, 'undo', {});
      expect(definition(env, 'crate')).toEqual(dropped);
    } finally {
      env.svc.dispose();
    }
  });
});
