/**
 * deleteEntity — commands.md §8.3/§9.1: subtree closure, the camera
 * invariant, deletedIds in pre-deletion array order, and the
 * restoreSubtree inverse that reconstructs the exact pre-deletion array
 * (hierarchy integrity survives deletion/undo).
 */

import { describe, expect, it } from 'vitest';
import { serializeCanonical, validateScene } from '@thirdlight/project-model';
import type { Scene } from '@thirdlight/project-model';

import {
  applyMutation,
  createCommandState,
  type ApplyOutcome,
  type CommandState,
  type DeleteEntityChange,
  type MutationSuccess,
  type RestoreSubtreeChange,
} from './index';
import {
  at,
  boxEntity,
  cameraEntity,
  groupEntity,
  req,
  scene,
  snapshot,
} from './test-scene';
import { bytesEqual } from './test-fixtures';

function sceneBytes(s: Scene): Uint8Array {
  const r = serializeCanonical(s);
  if (!r.ok) throw new Error('canonical serialization failed');
  return r.bytes;
}

function ok(r: ReturnType<typeof applyMutation>): MutationSuccess {
  if (!r.ok) throw new Error(`expected success, got: ${JSON.stringify(r.result)}`);
  return r.result;
}

/** Unwrap the new state of a successful outcome; throw on failure. */
function stateOf(o: ApplyOutcome): CommandState {
  if (!o.ok) throw new Error(`expected success, got: ${JSON.stringify(o.result)}`);
  return o.state;
}

/** Apply (with the state's current revision) and unwrap the new state. */
function step(st: CommandState, op: string, args: object): CommandState {
  return stateOf(applyMutation(st, at(st, op, args)));
}

/** A scene with a nested subtree: cam, A, B(root of subtree), B1, B2, C. */
const NESTED: Scene = scene(0, [
  cameraEntity(),
  boxEntity('box-0001', { name: 'A' }),
  groupEntity('group-0001', { name: 'B' }),
  boxEntity('box-0002', { parentId: 'group-0001', name: 'B1' }),
  boxEntity('box-0003', { parentId: 'group-0001', name: 'B2' }),
  boxEntity('box-0004', { name: 'C' }),
]);

describe('deleteEntity — subtree closure (§8.3)', () => {
  it('removes the entity and its entire subtree; deletedIds in pre-deletion array order', () => {
    const st = createCommandState(NESTED);
    const r = applyMutation(st, req('deleteEntity', { entityId: 'group-0001' }));
    const s = ok(r);
    const ch = s.change as DeleteEntityChange;
    expect(ch.type).toBe('deleteEntity');
    expect(ch.rootId).toBe('group-0001');
    expect(ch.deletedIds).toEqual(['group-0001', 'box-0002', 'box-0003']);
    // Surviving IDs and array order unchanged otherwise.
    expect(r.ok && (r as { state: CommandState }).state.scene.entities.map((e) => e.id)).toEqual([
      'cam-main',
      'box-0001',
      'box-0004',
    ]);
    expect(s.revision).toBe(1);
  });

  it('a leaf deletion deletes exactly itself', () => {
    const s = ok(applyMutation(createCommandState(NESTED), req('deleteEntity', { entityId: 'box-0004' })));
    const ch = s.change as DeleteEntityChange;
    expect(ch.deletedIds).toEqual(['box-0004']);
  });

  it('deep descendants are all removed (three-level subtree)', () => {
    const s3: Scene = scene(0, [
      cameraEntity(),
      groupEntity('group-0001'),
      groupEntity('group-0002', { parentId: 'group-0001' }),
      boxEntity('box-0001', { parentId: 'group-0002' }),
    ]);
    const s = ok(applyMutation(createCommandState(s3), req('deleteEntity', { entityId: 'group-0001' })));
    const ch = s.change as DeleteEntityChange;
    expect(ch.deletedIds).toEqual(['group-0001', 'group-0002', 'box-0001']);
  });
});

describe('deleteEntity — camera invariant (§8.3 step 2)', () => {
  it('deleting the only camera ⇒ camera_count_invalid carrying cameraId', () => {
    const st = createCommandState(NESTED);
    const before = sceneBytes(st.scene);
    const r = applyMutation(st, req('deleteEntity', { entityId: 'cam-main' }));
    if (r.ok) throw new Error('should have failed');
    const e = r.result.ok === false ? r.result.error : ({} as never);
    expect(e.code).toBe('camera_count_invalid');
    expect(e.cls).toBe('validation');
    expect(e.cameraId).toBe('cam-main');
    expect(bytesEqual(sceneBytes(st.scene), before)).toBe(true);
  });

  it('deleting an ANCESTOR of the camera ⇒ camera_count_invalid', () => {
    const withCameraChild: Scene = scene(0, [
      groupEntity('group-0001'),
      cameraEntity('cam-main', { parentId: 'group-0001' }),
    ]);
    const r = applyMutation(createCommandState(withCameraChild), req('deleteEntity', { entityId: 'group-0001' }));
    if (r.ok) throw new Error('should have failed');
    const e = r.result.ok === false ? r.result.error : ({} as never);
    expect(e.code).toBe('camera_count_invalid');
    expect(e.cameraId).toBe('cam-main');
  });

  it('deleting a DESCENDANT of the camera is allowed (the camera survives)', () => {
    const camParent: Scene = scene(0, [
      cameraEntity(),
      groupEntity('group-0001', { parentId: 'cam-main' }),
      boxEntity('box-0001', { parentId: 'group-0001' }),
    ]);
    const s = ok(applyMutation(createCommandState(camParent), req('deleteEntity', { entityId: 'group-0001' })));
    const ch = s.change as DeleteEntityChange;
    expect(ch.deletedIds).toEqual(['group-0001', 'box-0001']);
  });

  it('nonexistent entity ⇒ entity_not_found (pinned shape)', () => {
    const requestId = 'req-cccccccccccccccccccccccccccccccc';
    const r = applyMutation(
      createCommandState(NESTED),
      req('deleteEntity', { entityId: 'ghost-0001' }, { requestId }),
    );
    if (r.ok) throw new Error('should have failed');
    expect(r.result).toEqual({
      ok: false,
      op: 'deleteEntity',
      projectId: 'demo-0001',
      requestId,
      error: {
        code: 'entity_not_found',
        cls: 'validation',
        entityId: 'ghost-0001',
        message: "entity 'ghost-0001' does not exist in the current scene",
        hint: 'query the scene (queryEntities) for current IDs, then re-issue with a fresh requestId',
      },
    });
  });
});

describe('deleteEntity — the inverse restores the exact pre-deletion array (§9.1)', () => {
  it('delete → undo reconstructs the byte-identical scene (masked revision)', () => {
    const st0 = createCommandState(NESTED);
    const r1 = applyMutation(st0, at(st0, 'deleteEntity', { entityId: 'group-0001' }));
    if (!r1.ok) throw new Error('delete should have succeeded');
    // The inverse stores entries at pre-deletion indices, root first.
    const ch1 = r1.result.change as DeleteEntityChange;
    expect(ch1.deletedIds).toEqual(['group-0001', 'box-0002', 'box-0003']);

    const r2 = applyMutation(r1.ok ? r1.state : (null as never), at(r1.ok ? r1.state : (null as never), 'undo', {}));
    if (!r2.ok) throw new Error('undo should have succeeded');
    const ch2 = r2.result.change as RestoreSubtreeChange;
    expect(ch2.type).toBe('restoreSubtree');
    expect(ch2.rootId).toBe('group-0001');
    expect(ch2.entities.map((e) => e.id)).toEqual(['group-0001', 'box-0002', 'box-0003']);
    // root first; internal links intact.
    expect(ch2.entities[0]!.name).toBe('B');
    expect(ch2.entities[1]!.parentId).toBe('group-0001');

    // Byte-identity (revision masked): the inverse restored the intended
    // values EXACTLY, at the exact array indices.
    const a = serializeCanonical({ ...st0.scene, revision: 0 });
    const b = serializeCanonical({ ...r2.state.scene, revision: 0 });
    expect(a.ok && b.ok && bytesEqual(a.bytes, b.bytes)).toBe(true);

    // Hierarchy integrity after deletion/undo: the restored scene is a
    // valid scene (parent-before-child, unique IDs, exactly one camera).
    const v = validateScene(r2.state.scene);
    expect(v.ok).toBe(true);

    // appliedOf / originOfApplied trace to the original command.
    expect(r2.result.appliedOf).toBe(r1.result.requestId);
    expect(r2.result.originOfApplied ?? null).toEqual(r1.result.originOfApplied ?? null);
    // History depths after delete (1,0) → undo (0,1).
    expect(r2.result.history).toEqual({ undoDepth: 0, redoDepth: 1 });
  });

  it('undo of a delete with siblings around the subtree lands at the exact slots', () => {
    const st0 = createCommandState(NESTED);
    const r1 = applyMutation(st0, at(st0, 'deleteEntity', { entityId: 'group-0001' }));
    const r2 = applyMutation(stateOf(r1), at(stateOf(r1), 'undo', {}));
    if (!r1.ok || !r2.ok) throw new Error('delete/undo should have succeeded');
    expect(r2.state.scene.entities.map((e) => e.id)).toEqual([
      'cam-main',
      'box-0001',
      'group-0001',
      'box-0002',
      'box-0003',
      'box-0004',
    ]);
  });

  it('redo re-applies the recorded deletion (deletedIds removed again)', () => {
    const st0 = createCommandState(NESTED);
    const r1 = applyMutation(st0, at(st0, 'deleteEntity', { entityId: 'group-0001' }));
    const r2 = applyMutation(stateOf(r1), at(stateOf(r1), 'undo', {}));
    const r3 = applyMutation(stateOf(r2), at(stateOf(r2), 'redo', {}));
    if (!r3.ok) throw new Error('redo should have succeeded');
    const ch3 = r3.result.change as DeleteEntityChange;
    expect(ch3.type).toBe('deleteEntity');
    expect(ch3.deletedIds).toEqual(['group-0001', 'box-0002', 'box-0003']);
    expect(r3.state.scene.entities.map((e) => e.id)).toEqual([
      'cam-main',
      'box-0001',
      'box-0004',
    ]);
  });

  it('invalid edits leave the input unmutated (purity on camera_count_invalid)', () => {
    const st = createCommandState(NESTED);
    const snap = snapshot(st);
    const r = applyMutation(st, req('deleteEntity', { entityId: 'cam-main' }));
    if (r.ok) throw new Error('should have failed');
    expect(JSON.parse(JSON.stringify(st))).toEqual(snap);
  });
});