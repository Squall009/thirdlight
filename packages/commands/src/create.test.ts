/**
 * createEntity — backend-assigned IDs, defaults,
 * placement, limits, reference checks, and result-scene value failures.
 */

import { describe, expect, it } from 'vitest';
import { serializeCanonical } from '@thirdlight/project-model';
import type { EntityV3, SceneV4 } from '@thirdlight/project-model';

import {
  applyMutation,
  type ApplyOutcome,
  type CommandState,
  type MutationSuccess,
} from './index';
import { nextEntityId } from './ops';
import {
  at,
  boxEntity,
  cameraEntity,
  groupEntity,
  req,
  scene,
  snapshot,
  v4State,
} from './test-scene';
import { bytesEqual } from './test-fixtures';

const BASE: SceneV4 = scene(0, [cameraEntity()]);

function sceneBytes(s: unknown): Uint8Array {
  const r = serializeCanonical(s);
  if (!r.ok) throw new Error('canonical serialization failed');
  return r.bytes;
}

/** Apply and unwrap the success result; throw on failure. */
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

describe('createEntity — ID assignment (§8.1 step 2)', () => {
  it('assigns the smallest free <kind>-NNNN; kind prefixes are independent', () => {
    const st0 = v4State(BASE);
    const r1 = applyMutation(st0, at(st0, 'createEntity', { kind: 'box' }));
    expect(ok(r1).createdId).toBe('box-000001');
    const r2 = applyMutation(stateOf(r1), at(stateOf(r1), 'createEntity', { kind: 'box' }));
    expect(ok(r2).createdId).toBe('box-000002');
    const r3 = applyMutation(stateOf(r2), at(stateOf(r2), 'createEntity', { kind: 'group' }));
    expect(ok(r3).createdId).toBe('group-000001');
  });

  it('reassigns deleted IDs on later creations (uniqueness is per-document)', () => {
    let st = step(v4State(BASE), 'createEntity', { kind: 'box' }); // box-000001
    st = step(st, 'createEntity', { kind: 'box' }); // box-000002
    st = step(st, 'deleteEntity', { entityId: 'box-000001' });
    const r = applyMutation(st, at(st, 'createEntity', { kind: 'box' }));
    expect(ok(r).createdId).toBe('box-000001'); // reused
  });

  it('the ID scan picks the smallest FREE number (internal unit check)', () => {
    const s = scene(0, [cameraEntity(), boxEntity('box-000001'), boxEntity('box-000003')]);
    expect(nextEntityId(s, 'box')).toBe('box-000002');
    expect(nextEntityId(s, 'group')).toBe('group-000001');
    // Past 9,999 boxes the six-digit id space goes on.
    const full: EntityV3[] = [cameraEntity()];
    for (let n = 1; n <= 9999; n++) {
      full.push(boxEntity(`box-${String(n).padStart(6, '0')}`));
    }
    const sFull = scene(0, full);
    expect(nextEntityId(sFull, 'box')).toBe('box-010000');
    expect(nextEntityId(sFull, 'group')).toBe('group-000001');
    // Ids are unique across the project: another scene's ids are reserved.
    expect(nextEntityId(s, 'box', new Set(['box-000002']))).toBe('box-000004');
  });

  it('phase 25.7a: old four-digit ids stay and never collide with the six-digit ones', () => {
    const s = scene(0, [cameraEntity(), boxEntity('box-0001'), boxEntity('box-0002')]);
    let st = v4State(s);
    const r = applyMutation(st, at(st, 'createEntity', { kind: 'box' }));
    expect(ok(r).createdId).toBe('box-000001');
    st = stateOf(r);
    expect(st.scene.entities.map((e) => e.id)).toEqual(['cam-main', 'box-0001', 'box-0002', 'box-000001']);
  });
});

describe('createEntity — defaults and placement (§8.1 step 3/4)', () => {
  it('stores the full canonical entity with defaults filled; change carries it', () => {
    const s = ok(applyMutation(v4State(BASE), req('createEntity', { kind: 'box' })));
    expect(s.createdId).toBe('box-000001');
    expect(s.change).toEqual({
      type: 'createEntity',
      id: 'box-000001',
      entity: {
        id: 'box-000001',
        components: {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          box: { size: [1, 1, 1], material: { color: '#b0b0b0' } },
        },
      },
    });
    // Canonical key order (durable record): id, components;
    // transform → position, rotation, scale; box → size, material.
    const ent = (s.change as { entity: EntityV3 }).entity;
    expect(Object.keys(ent)).toEqual(['id', 'components']);
    expect(Object.keys(ent.components)).toEqual(['transform', 'box']);
    expect(Object.keys(ent.components.transform)).toEqual(['position', 'rotation', 'scale']);
    expect(Object.keys(ent.components.box!)).toEqual(['size', 'material']);
    // Revision advanced by exactly 1.
    expect(s.revision).toBe(1);
    expect(s.duplicated).toBe(false);
    expect(s.history).toEqual({ undoDepth: 1, redoDepth: 0 });
  });

  it('appends at the END of the entities array (document order = sibling order)', () => {
    let st = step(v4State(BASE), 'createEntity', { kind: 'box', name: 'A' });
    st = step(st, 'createEntity', { kind: 'group', name: 'G' });
    expect(st.scene.entities.map((e) => e.id)).toEqual([
      'cam-main',
      'box-000001',
      'group-000001',
    ]);
  });

  it('partial transform defaults per field (a provided field replaces that field only)', () => {
    const s = ok(
      applyMutation(
        v4State(BASE),
        req('createEntity', {
          kind: 'box',
          transform: { position: [1, 2, 3] },
          box: { size: [2, 3, 4] },
        }),
      ),
    );
    const ent = (s.change as { entity: EntityV3 }).entity;
    expect(ent.components.transform).toEqual({
      position: [1, 2, 3],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1],
    });
    expect(ent.components.box).toEqual({ size: [2, 3, 4], material: { color: '#b0b0b0' } });
  });

  it('parentId places the entity under an existing parent; null omits the key', () => {
    const st = v4State(scene(0, [cameraEntity(), boxEntity('box-000001')]));
    const s = ok(applyMutation(st, req('createEntity', { kind: 'box', parentId: 'box-000001' })));
    expect((s.change as { entity: EntityV3 }).entity.parentId).toBe('box-000001');
    const s2 = ok(
      applyMutation(v4State(BASE), req('createEntity', { kind: 'box', parentId: null })),
    );
    expect((s2.change as { entity: EntityV3 }).entity.parentId).toBeUndefined();
  });

  it('a box under a group keeps the parent-before-child invariant (result re-validated)', () => {
    const st = v4State(scene(0, [cameraEntity(), groupEntity('group-000001')]));
    const r = applyMutation(st, req('createEntity', { kind: 'box', parentId: 'group-000001' }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.scene.entities.map((e) => e.id)).toEqual([
        'cam-main',
        'group-000001',
        'box-000001',
      ]);
    }
  });
});

describe('createEntity — preconditions and limits (§8.1 step 1)', () => {
  it('parentId that does not resolve ⇒ reference_missing (pinned shape)', () => {
    const requestId = 'req-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const r = applyMutation(
      v4State(BASE),
      req('createEntity', { kind: 'box', parentId: 'ghost-0001' }, { requestId }),
    );
    if (r.ok) throw new Error('should have failed');
    expect(r.result).toEqual({
      ok: false,
      op: 'createEntity',
      projectId: 'demo-0001',
      requestId,
      error: {
        code: 'reference_missing',
        cls: 'validation',
        found: 'ghost-0001',
        expected: 'existing entity ID or null',
        message: 'parentId does not resolve to an existing entity',
      },
    });
  });

  const boxId = (n: number): string => `box-${String(n).padStart(6, '0')}`;
  const groupId = (n: number): string => `group-${String(n).padStart(6, '0')}`;

  it('16385th entity in a v4 scene ⇒ limits_exceeded { entities, 16385, 16384 }; the 16384th is allowed', () => {
    // A v4 scene holds up to 16384 entities: the
    // camera, box-000001..box-009999 and group-000001..group-006384.
    const ents: EntityV3[] = [cameraEntity()];
    for (let n = 1; n <= 9999; n++) ents.push(boxEntity(boxId(n)));
    for (let n = 1; n <= 6384; n++) ents.push(groupEntity(groupId(n)));
    expect(ents.length).toBe(16384);
    const st = v4State(scene(0, ents));
    const before = sceneBytes(st.scene);
    const r = applyMutation(st, req('createEntity', { kind: 'group' }));
    if (r.ok) throw new Error('should have failed');
    expect(r.result.error).toEqual({
      code: 'limits_exceeded',
      cls: 'validation',
      limit: 'entities',
      current: 16385,
      max: 16384,
      message: 'creation would exceed the M1 entities limit (16385 > 16384)',
    });
    expect(bytesEqual(sceneBytes(st.scene), before)).toBe(true);
    // One below the limit: the 16384th entity is created (group-006384).
    const st2 = v4State(scene(0, ents.slice(0, -1)));
    const r2 = applyMutation(st2, req('createEntity', { kind: 'group' }));
    expect(ok(r2).createdId).toBe('group-006384');
    expect(r2.ok && r2.state.scene.entities.length).toBe(16384);
  });

  it('phase 25.7a: a v4 scene holding 9,999 old four-digit boxes still creates boxes (no id_exhaustion below the entity limit)', () => {
    const ents: EntityV3[] = [cameraEntity()];
    for (let n = 1; n <= 9999; n++) ents.push(boxEntity(`box-${String(n).padStart(4, '0')}`));
    const st = v4State(scene(0, ents));
    expect(ok(applyMutation(st, req('createEntity', { kind: 'box' }))).createdId).toBe('box-000001');
    expect(ok(applyMutation(st, req('createEntity', { kind: 'group' }))).createdId).toBe('group-000001');
  });

  it('depth 33 ⇒ limits_exceeded { depth, 33, 32 }; depth 32 is allowed', () => {
    const makeChain = (depth: number): EntityV3[] => {
      const ents: EntityV3[] = [];
      let prev: string | undefined;
      for (let d = 1; d <= depth; d++) {
        const id = `g-${String(d).padStart(6, '0')}`;
        ents.push(groupEntity(id, { parentId: prev }));
        prev = id;
      }
      return ents;
    };
    const chain32 = makeChain(32);
    const st = v4State(scene(0, [cameraEntity(), ...chain32]));
    const r = applyMutation(st, req('createEntity', { kind: 'box', parentId: chain32[31]!.id }));
    if (r.ok) throw new Error('depth 33 should have failed');
    expect(r.result.error).toMatchObject({
      code: 'limits_exceeded',
      cls: 'validation',
      limit: 'depth',
      current: 33,
      max: 32,
    });
    // Under a depth-31 parent the new entity is at depth 32 — allowed.
    const chain31 = makeChain(31);
    const st2 = v4State(scene(0, [cameraEntity(), ...chain31]));
    const r2 = applyMutation(st2, req('createEntity', { kind: 'box', parentId: chain31[30]!.id }));
    expect(r2.ok).toBe(true);
  });
});

describe('createEntity — value failures via result-scene validation (§5.2)', () => {
  it.each([
    ['position out of range', { kind: 'box', transform: { position: [1000001, 0, 0] } }],
    ['scale zero', { kind: 'box', transform: { scale: [0, 1, 1] } }],
    ['box size zero', { kind: 'box', box: { size: [1, 0, 1] } }],
    ['quaternion norm off', { kind: 'box', transform: { rotation: [0, 0, 0, 0] } }],
    ['non-finite position element', { kind: 'box', transform: { position: [NaN, 0, 0] } }],
    ['bad color', { kind: 'box', box: { material: { color: 'red' } } }],
    ['short position vector', { kind: 'box', transform: { position: [1, 2] } }],
  ])('result-scene error, no state change: %s', (_label, args) => {
    const st = v4State(BASE);
    const before = sceneBytes(st.scene);
    const beforeHistory = JSON.stringify(st.history);
    const r = applyMutation(st, req('createEntity', args as Record<string, unknown>));
    if (r.ok) throw new Error('should have failed');
    const e = r.result.ok === false ? r.result.error : ({} as never);
    expect(e.cls).toBe('validation');
    expect(e.detailDocument).toBe('result-scene');
    expect(e.details?.length).toBeGreaterThan(0);
    expect(e.detailCount).toBe(e.details?.length);
    expect(e.code).toBe(e.details?.[0]?.code);
    expect(e.message).toBe('resulting scene failed validation; state unchanged');
    expect(bytesEqual(sceneBytes(st.scene), before)).toBe(true);
    expect(JSON.stringify(st.history)).toBe(beforeHistory);
  });

  it('invalid edits leave the input scene object unmutated (purity on failure)', () => {
    const st = v4State(BASE);
    const snap = snapshot(st);
    const r = applyMutation(st, req('createEntity', { kind: 'box', transform: { position: [9e6, 0, 0] } }));
    if (r.ok) throw new Error('should have failed');
    expect(JSON.parse(JSON.stringify(st))).toEqual(snap);
  });
});