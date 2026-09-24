/**
 * History edge behavior — commands.md §8.4/§9: redo re-application with
 * recorded values, the defensive `history_invalid` path (§9.4), mixed
 * origins with absent origin, `revision_exhausted`, and deep
 * undo/redo round-trips.
 */

import { describe, expect, it } from 'vitest';
import { serializeCanonical } from '@thirdlight/project-model';
import type { EntityV3, SceneV4 } from '@thirdlight/project-model';

import {
  applyMutation,
  MAX_REVISION,
  type ApplyOutcome,
  type CommandState,
  type HistoryEntry,
  type MutationSuccess,
  type SetTransformChange,
} from './index';
import {
  at,
  boxEntity,
  cameraEntity,
  req,
  scene,
  snapshot,
  v4Content,
  v4State,
} from './test-scene';
import { bytesEqual } from './test-fixtures';

function sceneBytes(s: unknown): Uint8Array {
  const r = serializeCanonical(s);
  if (!r.ok) throw new Error('canonical serialization failed');
  return r.bytes;
}

/** Unwrap a successful outcome; throw with the payload on failure. */
function ok(r: ApplyOutcome): { state: CommandState; result: MutationSuccess } {
  if (!r.ok) throw new Error(`expected success, got: ${JSON.stringify(r.result)}`);
  return { state: r.state, result: r.result };
}

const BASE: SceneV4 = scene(0, [cameraEntity()]);

describe('redo — recorded values, not re-scans (§8.4)', () => {
  it('redo of a create re-inserts the recorded entity at the end with its original ID', () => {
    const st0 = v4State(BASE);
    const o1 = applyMutation(st0, at(st0, 'createEntity', { kind: 'box', name: 'First' }));
    const o2 = applyMutation(ok(o1).state, at(ok(o1).state, 'createEntity', { kind: 'box', name: 'Second' }));
    // Undo the second create...
    const u1 = applyMutation(ok(o2).state, at(ok(o2).state, 'undo', {}));
    expect(ok(u1).result.change.type).toBe('deleteEntity');
    // ...and redo it: the SAME entity value (name 'Second', ID box-0002)
    // at the end of the array — no ID re-scan.
    const red = applyMutation(ok(u1).state, at(ok(u1).state, 'redo', {}));
    const s = ok(red).result;
    const ch = s.change as { type: string; id: string; entity: EntityV3 };
    expect(ch.type).toBe('createEntity');
    expect(ch.id).toBe('box-0002');
    expect(ch.entity.name).toBe('Second');
    expect(s.appliedOf).toBe(o2.result.requestId);
    // Byte-identical to the post-create state (masked revision).
    const a = serializeCanonical({ ...ok(o2).state.scene, revision: 0 });
    const b = serializeCanonical({ ...ok(red).state.scene, revision: 0 });
    expect(a.ok && b.ok && bytesEqual(a.bytes, b.bytes)).toBe(true);
  });

  it('redo of a setTransform replaces the recorded fields with the recorded next values', () => {
    const st0 = v4State(BASE);
    const c = applyMutation(st0, at(st0, 'createEntity', { kind: 'box' }));
    const t = applyMutation(ok(c).state, at(ok(c).state, 'setTransform', {
      entityId: 'box-0001',
      transform: { position: [7, 8, 9] },
    }));
    const u = applyMutation(ok(t).state, at(ok(t).state, 'undo', {}));
    const red = applyMutation(ok(u).state, at(ok(u).state, 'redo', {}));
    const ch = ok(red).result.change as SetTransformChange;
    expect(ch.type).toBe('setTransform');
    expect(ch.previous.position).toEqual([0, 0, 0]);
    expect(ch.next.position).toEqual([7, 8, 9]);
    expect(ch.changedFields).toEqual(['position']);
  });

  it('deep round-trip: three edits undone and redone restore byte-identical states', () => {
    const st0 = v4State(BASE);
    const st1 = ok(applyMutation(st0, at(st0, 'createEntity', { kind: 'box', name: 'A' }))).state;
    const st2 = ok(applyMutation(st1, at(st1, 'setTransform', {
      entityId: 'box-0001',
      transform: { position: [1, 0, 0] },
    }))).state;
    const st3 = ok(applyMutation(st2, at(st2, 'createEntity', { kind: 'group', name: 'G' }))).state;
    // Undo all three.
    let u = applyMutation(st3, at(st3, 'undo', {}));
    u = applyMutation(ok(u).state, at(ok(u).state, 'undo', {}));
    u = applyMutation(ok(u).state, at(ok(u).state, 'undo', {}));
    const afterUndo = ok(u).state;
    // Back to the initial bytes (masked revision).
    const a0 = serializeCanonical({ ...st0.scene, revision: 0 });
    const aU = serializeCanonical({ ...afterUndo.scene, revision: 0 });
    expect(a0.ok && aU.ok && bytesEqual(a0.bytes, aU.bytes)).toBe(true);
    expect(afterUndo.history.cursor).toBe(0);
    expect(afterUndo.history.entries.length).toBe(3);
    // Redo all three.
    let red = applyMutation(afterUndo, at(afterUndo, 'redo', {}));
    red = applyMutation(ok(red).state, at(ok(red).state, 'redo', {}));
    red = applyMutation(ok(red).state, at(ok(red).state, 'redo', {}));
    const afterRedo = ok(red).state;
    const b3 = serializeCanonical({ ...st3.scene, revision: 0 });
    const bR = serializeCanonical({ ...afterRedo.scene, revision: 0 });
    expect(b3.ok && bR.ok && bytesEqual(b3.bytes, bR.bytes)).toBe(true);
    expect(afterRedo.history.cursor).toBe(3);
    expect(afterRedo.history.entries.length).toBe(3);
  });
});

describe('history_invalid — defensive failure (§9.4, unreachable via LIFO state)', () => {
  function cameraScene(rev: number): SceneV4 {
    return scene(rev, [cameraEntity()]);
  }

  it('undo with an inapplicable inverse (delete of a missing ID) ⇒ history_invalid carrying the entry requestId; state and stacks untouched', () => {
    const sc = cameraScene(1);
    const entity: EntityV3 = {
      id: 'box-0001',
      components: {
        transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        box: { size: [1, 1, 1], material: { color: '#b0b0b0' } },
      },
    };
    const entry: HistoryEntry = {
      seq: 1,
      requestId: 'req-dededededededededededededededede',
      op: 'createEntity',
      origin: { kind: 'mcp', clientId: 'harness' },
      appliedRevision: 1,
      change: { type: 'createEntity', id: 'box-0001', entity },
      // Corruption: the inverse names an ID that is not in the scene.
      inverse: { kind: 'delete', rootId: 'ghost-0001' },
    };
    const st: CommandState = { scene: sc, content: v4Content(), history: { entries: [entry], cursor: 1, seq: 2 } };
    const snap = snapshot(st);
    const r = applyMutation(st, req('undo', {}, { expectedRevision: 1 }));
    if (r.ok) throw new Error('should have failed');
    const e = r.result.ok === false ? r.result.error : ({} as never);
    expect(e.code).toBe('history_invalid');
    expect(e.cls).toBe('internal');
    expect(e.requestId).toBe('req-dededededededededededededededede');
    expect(JSON.parse(JSON.stringify(st))).toEqual(snap);
  });

  it('undo of a restoreSubtree with an out-of-range index ⇒ history_invalid', () => {
    const entry: HistoryEntry = {
      seq: 1,
      requestId: 'req-e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0',
      op: 'deleteEntity',
      origin: null,
      appliedRevision: 1,
      change: { type: 'deleteEntity', rootId: 'box-0001', deletedIds: ['box-0001'] },
      inverse: {
        kind: 'restoreSubtree',
        entries: [{ index: 99, entity: boxEntity('box-0001') }],
        restoredParentId: null,
      },
    };
    const st: CommandState = {
      scene: cameraScene(1),
      content: v4Content(),
      history: { entries: [entry], cursor: 1, seq: 2 },
    };
    const r = applyMutation(st, req('undo', {}, { expectedRevision: 1 }));
    if (r.ok) throw new Error('should have failed');
    if (r.result.ok === false) {
      expect(r.result.error.code).toBe('history_invalid');
      expect(r.result.error.requestId).toBe(entry.requestId);
    }
  });

  it('undo of a restoreSubtree whose root parentId disagrees with restoredParentId ⇒ history_invalid', () => {
    const entry: HistoryEntry = {
      seq: 1,
      requestId: 'req-f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1',
      op: 'deleteEntity',
      origin: null,
      appliedRevision: 1,
      change: { type: 'deleteEntity', rootId: 'box-0001', deletedIds: ['box-0001'] },
      inverse: {
        kind: 'restoreSubtree',
        entries: [{ index: 1, entity: boxEntity('box-0001', { parentId: 'group-0001' }) }],
        restoredParentId: null, // disagrees with the entity's own parentId
      },
    };
    const st: CommandState = {
      scene: cameraScene(1),
      content: v4Content(),
      history: { entries: [entry], cursor: 1, seq: 2 },
    };
    const r = applyMutation(st, req('undo', {}, { expectedRevision: 1 }));
    if (r.ok) throw new Error('should have failed');
    if (r.result.ok === false) expect(r.result.error.code).toBe('history_invalid');
  });

  it('redo of a create whose ID already exists ⇒ history_invalid', () => {
    const sc = scene(1, [cameraEntity(), boxEntity('box-0001')]);
    const entity = sc.entities.find((e) => e.id === 'box-0001') as EntityV3;
    const entry: HistoryEntry = {
      seq: 1,
      requestId: 'req-0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f',
      op: 'createEntity',
      origin: null,
      appliedRevision: 1,
      change: { type: 'createEntity', id: 'box-0001', entity: { ...entity } },
      inverse: { kind: 'delete', rootId: 'box-0001' },
    };
    const st: CommandState = { scene: sc, content: v4Content(), history: { entries: [entry], cursor: 0, seq: 2 } };
    const r = applyMutation(st, req('redo', {}, { expectedRevision: 1 }));
    if (r.ok) throw new Error('should have failed');
    if (r.result.ok === false) expect(r.result.error.code).toBe('history_invalid');
  });
});

describe('origin transparency and revision bounds', () => {
  it('absent origin ⇒ originOfApplied is null (present key) in the undo result', () => {
    const st0 = v4State(BASE);
    const c = applyMutation(st0, req('createEntity', { kind: 'box' }, { origin: null }));
    const u = applyMutation(ok(c).state, at(ok(c).state, 'undo', {}, { origin: null }));
    const s = ok(u).result;
    expect('originOfApplied' in s).toBe(true);
    expect(s.originOfApplied ?? null).toBeNull();
    expect(s.appliedOf).toBe(c.ok ? c.result.requestId : null);
  });

  it('revision at 2^53-1 ⇒ revision_exhausted (defined for completeness)', () => {
    const sc: SceneV4 = scene(MAX_REVISION, [cameraEntity()]);
    const st = v4State(sc);
    const r = applyMutation(st, req('createEntity', { kind: 'box' }, { expectedRevision: MAX_REVISION }));
    if (r.ok) throw new Error('should have failed');
    const e = r.result.ok === false ? r.result.error : ({} as never);
    expect(e.code).toBe('revision_exhausted');
    expect(e.cls).toBe('internal');
    expect(e.currentRevision).toBe(MAX_REVISION);
  });
});