/**
 * setTransform — commands.md §8.2/§6.5: whole-field replacement (no
 * component-wise merge), full previous/next change data, the no_change
 * check (including -0 canonicalization), quaternion tolerance, and input
 * invariance on failure.
 */

import { describe, expect, it } from 'vitest';
import { serializeCanonical } from '@thirdlight/project-model';
import type { Entity, Scene, TransformComponent } from '@thirdlight/project-model';

import {
  applyMutation,
  createCommandState,
  type CommandState,
  type MutationSuccess,
  type SetTransformChange,
} from './index';
import { boxEntity, cameraEntity, req, scene, snapshot, at } from './test-scene';
import { bytesEqual } from './test-fixtures';

const BASE: Scene = scene(
  0,
  [
    cameraEntity(),
    boxEntity('box-0001', { position: [1.5, 0.25, 0], rotation: [0.7, 0, 0, 0.714142842854285] }),
  ],
);

function sceneBytes(s: Scene): Uint8Array {
  const r = serializeCanonical(s);
  if (!r.ok) throw new Error('canonical serialization failed');
  return r.bytes;
}

function ok(r: ReturnType<typeof applyMutation>): MutationSuccess {
  if (!r.ok) throw new Error(`expected success, got: ${JSON.stringify(r.result)}`);
  return r.result;
}

describe('setTransform — replacement semantics (§8.2)', () => {
  it('replaces the whole provided field; absent fields are unchanged', () => {
    const r = applyMutation(
      createCommandState(BASE),
      req('setTransform', {
        entityId: 'box-0001',
        transform: { position: [0.5, 0, 0] },
      }),
    );
    const s = ok(r);
    const ch = s.change as SetTransformChange;
    expect(ch.type).toBe('setTransform');
    expect(ch.id).toBe('box-0001');
    expect(ch.previous).toEqual({
      position: [1.5, 0.25, 0],
      rotation: [0.7, 0, 0, 0.714142842854285],
      scale: [1, 1, 1],
    });
    expect(ch.next).toEqual({
      position: [0.5, 0, 0],
      rotation: [0.7, 0, 0, 0.714142842854285],
      scale: [1, 1, 1],
    });
    expect(ch.changedFields).toEqual(['position']);
    expect(s.revision).toBe(1);
    expect(s.history).toEqual({ undoDepth: 1, redoDepth: 0 });
    // The stored scene carries the replacement.
    const st = r.ok ? r.state : (null as never);
    const ent = st.scene.entities.find((e) => e.id === 'box-0001') as Entity;
    expect(ent.components.transform.position).toEqual([0.5, 0, 0]);
    expect(ent.components.transform.rotation).toEqual([0.7, 0, 0, 0.714142842854285]);
  });

  it('changedFields lists replaced fields in canonical order (position, rotation, scale) regardless of request order', () => {
    const r = applyMutation(
      createCommandState(BASE),
      req('setTransform', {
        entityId: 'box-0001',
        transform: {
          scale: [2, 2, 2],
          position: [0, 0, 1],
        },
      }),
    );
    const ch = ok(r).change as SetTransformChange;
    expect(ch.changedFields).toEqual(['position', 'scale']);
  });

  it('all three fields ⇒ all three in changedFields', () => {
    const r = applyMutation(
      createCommandState(BASE),
      req('setTransform', {
        entityId: 'box-0001',
        transform: { position: [1, 1, 1], rotation: [0, 0, 0, 1], scale: [3, 3, 3] },
      }),
    );
    const ch = ok(r).change as SetTransformChange;
    expect(ch.changedFields).toEqual(['position', 'rotation', 'scale']);
  });

  it('quaternion values are preserved exactly (never renormalized at the command layer)', () => {
    const q: TransformComponent['rotation'] = [0.7071067811865476, 0, 0, 0.7071067811865476];
    const r = applyMutation(
      createCommandState(BASE),
      req('setTransform', { entityId: 'box-0001', transform: { rotation: q } }),
    );
    const ch = ok(r).change as SetTransformChange;
    expect(ch.next.rotation).toEqual(q);
  });

  it('quaternion within the 1e-4 norm tolerance is accepted', () => {
    const r = applyMutation(
      createCommandState(BASE),
      req('setTransform', { entityId: 'box-0001', transform: { rotation: [0.99999, 0, 0, 0] } }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('setTransform — no_change (§6.5)', () => {
  it('setting the current values ⇒ no_change (pinned payload), no revision, no record', () => {
    const st = createCommandState(BASE);
    const before = sceneBytes(st.scene);
    const beforeHistory = JSON.stringify(st.history);
    const r = applyMutation(
      st,
      req('setTransform', {
        entityId: 'box-0001',
        transform: { position: [1.5, 0.25, 0] }, // already these values
      }),
    );
    if (r.ok) throw new Error('should have failed with no_change');
    expect(r.result).toEqual({
      ok: false,
      op: 'setTransform',
      projectId: 'demo-0001',
      requestId: r.result.ok === false ? r.result.requestId : '',
      error: {
        code: 'no_change',
        cls: 'validation',
        message: 'request would not change the scene',
        hint: 'the scene already matches the requested values; nothing was recorded',
      },
    });
    expect(bytesEqual(sceneBytes(st.scene), before)).toBe(true);
    expect(st.scene.revision).toBe(0); // no revision consumed
    expect(JSON.stringify(st.history)).toBe(beforeHistory);
  });

  it('negative zero is normalized by canonical serialization ⇒ no_change', () => {
    // box-0001 sits at [0, 0, 0]; setting position to [-0, 0, 0] produces
    // the same canonical bytes (the model normalizes -0 to 0) ⇒ no_change.
    const st = createCommandState(scene(0, [cameraEntity(), boxEntity('box-0001')]));
    const before = sceneBytes(st.scene);
    const r = applyMutation(
      st,
      req('setTransform', { entityId: 'box-0001', transform: { position: [-0, 0, 0] } }),
    );
    if (r.ok) throw new Error('-0 == 0 under canonical serialization ⇒ no_change');
    if (r.result.ok === false) expect(r.result.error.code).toBe('no_change');
    expect(bytesEqual(sceneBytes(st.scene), before)).toBe(true);
  });
});

describe('setTransform — failures leave inputs unchanged', () => {
  it('result-scene quaternion failure ⇒ structured details; scene bytes and history untouched', () => {
    const st = createCommandState(BASE);
    const before = sceneBytes(st.scene);
    const beforeHistory = JSON.stringify(st.history);
    const r = applyMutation(
      st,
      req('setTransform', { entityId: 'box-0001', transform: { rotation: [0.9998, 0, 0, 0] } }),
    );
    if (r.ok) throw new Error('should have failed');
    const e = r.result.ok === false ? r.result.error : ({} as never);
    expect(e.code).toBe('quaternion_invalid');
    expect(e.cls).toBe('validation');
    expect(e.detailDocument).toBe('result-scene');
    expect(e.details?.[0]?.code).toBe('quaternion_invalid');
    expect(e.detailCount).toBeGreaterThanOrEqual(1);
    expect(bytesEqual(sceneBytes(st.scene), before)).toBe(true);
    expect(JSON.stringify(st.history)).toBe(beforeHistory);
  });

  it('nonexistent entity ⇒ entity_not_found (pinned shape); input unmutated', () => {
    const st = createCommandState(BASE);
    const snap = snapshot(st);
    const requestId = 'req-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const r = applyMutation(
      st,
      req('setTransform', { entityId: 'ghost-0001', transform: { position: [1, 0, 0] } }, { requestId }),
    );
    if (r.ok) throw new Error('should have failed');
    expect(r.result).toEqual({
      ok: false,
      op: 'setTransform',
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
    expect(JSON.parse(JSON.stringify(st))).toEqual(snap);
  });

  it('empty transform object ⇒ field_value (pinned in §3.1)', () => {
    const r = applyMutation(
      createCommandState(BASE),
      req('setTransform', { entityId: 'box-0001', transform: {} }),
    );
    if (r.ok) throw new Error('should have failed');
    const e = r.result.ok === false ? r.result.error : ({} as never);
    expect(e.code).toBe('field_value');
    expect(e.path).toBe('/args/transform');
    expect(e.expected).toBe('non-empty object: at least one of position, rotation, scale');
  });
});

describe('setTransform — the resulting scene re-validation is the uniform pipeline', () => {
  it('out-of-range position ⇒ number_out_of_range detail at the entity path', () => {
    const r = applyMutation(
      createCommandState(BASE),
      req('setTransform', { entityId: 'box-0001', transform: { position: [2000000, 0, 0] } }),
    );
    if (r.ok) throw new Error('should have failed');
    const e = r.result.ok === false ? r.result.error : ({} as never);
    expect(e.code).toBe('number_out_of_range');
    expect(e.details?.[0]?.path).toBe('/entities/1/components/transform/position/0');
  });

  it('a successful edit followed by undo restores the exact pre-edit bytes (inverse value)', () => {
    const st0 = createCommandState(BASE);
    const r1 = applyMutation(
      st0,
      req('setTransform', { entityId: 'box-0001', transform: { position: [9, 9, 9] } }),
    );
    if (!r1.ok) throw new Error('setTransform should have succeeded');
    const r2 = applyMutation(r1.state, at(r1.state, 'undo', {}));
    if (!r2.ok) throw new Error('undo should have succeeded');
    // Masked-revision byte identity: the inverse restored the intended values.
    const a = serializeCanonical({ ...st0.scene, revision: 0 });
    const b = serializeCanonical({ ...r2.state.scene, revision: 0 });
    expect(a.ok && b.ok && bytesEqual(a.bytes, b.bytes)).toBe(true);
    // undo's change data: previous/next swapped, changedFields = all three
    // (the inverse restores the FULL previous transform, §9.1).
    const ch = r2.result.change as SetTransformChange;
    expect(ch.type).toBe('setTransform');
    expect(ch.previous.position).toEqual([9, 9, 9]);
    expect(ch.next.position).toEqual([1.5, 0.25, 0]);
    expect(ch.changedFields).toEqual(['position', 'rotation', 'scale']);
  });
});