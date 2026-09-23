/**
 * Phase 12 hierarchy commands: folders (`createEntity kind: folder`), the
 * hierarchy flags on `updateEntity`, world-keeping reparents and
 * `moveEntities` (sibling reorder, filing into a folder or object, moving a
 * multi-selection), each with exact undo/redo.
 */

import { describe, expect, it } from 'vitest';
import type { SceneV3, TransformComponent } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument, MoveEntitiesChange, MutationSuccess, UpdateEntityChange } from './index';
import { m3ContractJson } from './test-fixtures';

interface EnvelopeFixture {
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}

const BEFORE = m3ContractJson<EnvelopeFixture>('commands/scenario.before.json');
type State = CommandState<SceneV3>;

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x12000 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: (out as { state?: State }).state ?? state, result: out.result as unknown as Record<string, unknown> };
}

function ok(state: State, op: string, args: Record<string, unknown>): { state: State; id: string; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return { state: r.state, id: String(r.result.createdId ?? ''), change: (r.result as unknown as MutationSuccess).change };
}

function fresh(): State {
  return createCommandState(
    structuredClone(BEFORE.scene),
    structuredClone(BEFORE.content) as unknown as ContentDocument,
  ) as unknown as State;
}

const ids = (s: State): string[] => s.scene.entities.map((e) => e.id);
const entity = (s: State, id: string) => s.scene.entities.find((e) => e.id === id)!;
const transformOf = (s: State, id: string): TransformComponent => entity(s, id).components.transform as TransformComponent;
const childrenOf = (s: State, parentId: string | undefined): string[] =>
  s.scene.entities.filter((e) => e.parentId === parentId).map((e) => e.id);

/** World position of `id` through its parent chain (translation + rotation + scale). */
function worldPosition(s: State, id: string): number[] {
  let p = [0, 0, 0];
  let cur: string | undefined = id;
  while (cur !== undefined) {
    const e = entity(s, cur);
    const t = e.components.transform;
    if (t !== undefined) {
      const [qx, qy, qz, qw] = t.rotation;
      const v = [p[0]! * t.scale[0], p[1]! * t.scale[1], p[2]! * t.scale[2]];
      // rotate v by q
      const ix = qw * v[0]! + qy * v[2]! - qz * v[1]!;
      const iy = qw * v[1]! + qz * v[0]! - qx * v[2]!;
      const iz = qw * v[2]! + qx * v[1]! - qy * v[0]!;
      const iw = -qx * v[0]! - qy * v[1]! - qz * v[2]!;
      p = [
        ix * qw + iw * -qx + iy * -qz - iz * -qy + t.position[0],
        iy * qw + iw * -qy + iz * -qx - ix * -qz + t.position[1],
        iz * qw + iw * -qz + ix * -qy - iy * -qx + t.position[2],
      ];
    }
    cur = e.parentId;
  }
  return p;
}

const near = (a: number[], b: number[]): void => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));
};

describe('folders', () => {
  it('createEntity kind folder makes a transform-less folder; undo removes it', () => {
    const made = ok(fresh(), 'createEntity', { kind: 'folder', name: 'Enemies' });
    expect(made.id).toMatch(/^folder-\d{4}$/);
    expect(entity(made.state, made.id)).toEqual({ id: made.id, name: 'Enemies', components: { folder: {} } });
    const undone = ok(made.state, 'undo', {});
    expect(ids(undone.state)).not.toContain(made.id);
  });

  it('a folder refuses a transform or components, and cannot sit under an object', () => {
    const s = fresh();
    expect(run(s, 'createEntity', { kind: 'folder', transform: { position: [1, 0, 0] } }).result.ok).toBe(false);
    expect(run(s, 'createEntity', { kind: 'folder', components: { light: {} } }).result.ok).toBe(false);
    const box = ok(s, 'createEntity', { kind: 'box' });
    const r = run(box.state, 'createEntity', { kind: 'folder', parentId: box.id });
    expect(r.result.ok).toBe(false);
    expect((r.result.error as { path: string }).path).toBe('/args/parentId');
    // setTransform on a folder is refused with a clear error.
    const f = ok(s, 'createEntity', { kind: 'folder' });
    const t = run(f.state, 'setTransform', { entityId: f.id, transform: { position: [1, 2, 3] } });
    expect(t.result.ok).toBe(false);
  });

  it('folders nest; zones and physics bodies may live in folders', () => {
    let s = ok(fresh(), 'createEntity', { kind: 'folder', name: 'Level' }).state;
    const level = ids(s).at(-1)!;
    const inner = ok(s, 'createEntity', { kind: 'folder', name: 'Hazards', parentId: level });
    s = inner.state;
    const zone = ok(s, 'createEntity', {
      kind: 'group',
      parentId: inner.id,
      transform: { position: [3, 1, 0] },
      components: { gameZone: { role: 'hazard', size: [1, 1] } },
    });
    expect(entity(zone.state, zone.id).parentId).toBe(inner.id);
    const body = ok(zone.state, 'createEntity', { kind: 'box', parentId: inner.id, components: { collider: { shape: { type: 'box', hx: 0.5, hy: 0.5 } } } });
    expect(entity(body.state, body.id).parentId).toBe(inner.id);
  });
});

describe('updateEntity flags', () => {
  it('sets active/locked/static, stores only non-default values, and undo/redo restore them', () => {
    const f = ok(fresh(), 'createEntity', { kind: 'folder' });
    const set = ok(f.state, 'updateEntity', { entityId: f.id, active: false, locked: true, static: true });
    const change = set.change as UpdateEntityChange;
    expect(change.changedFields).toEqual(['active', 'locked', 'static']);
    expect(entity(set.state, f.id)).toMatchObject({ active: false, locked: true, static: true });
    const back = ok(set.state, 'updateEntity', { entityId: f.id, active: true, locked: false });
    expect('active' in entity(back.state, f.id)).toBe(false);
    expect('locked' in entity(back.state, f.id)).toBe(false);
    const undone = ok(back.state, 'undo', {});
    expect(entity(undone.state, f.id)).toMatchObject({ active: false, locked: true });
    const redone = ok(undone.state, 'redo', {});
    expect('active' in entity(redone.state, f.id)).toBe(false);
  });

  it('refuses a non-boolean flag and making the camera inactive', () => {
    const s = fresh();
    const cam = s.scene.entities.find((e) => e.components.camera !== undefined)!.id;
    expect(run(s, 'updateEntity', { entityId: cam, active: 'no' }).result.ok).toBe(false);
    const r = run(s, 'updateEntity', { entityId: cam, active: false });
    expect(r.result.ok).toBe(false);
    expect((r.result.error as { code: string }).code).toBe('camera_count_invalid');
  });

  it('a reparent keeps the world position (and undo restores the local transform)', () => {
    let s = ok(fresh(), 'createEntity', {
      kind: 'group',
      name: 'parent',
      transform: { position: [10, 0, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 2, 2] },
    }).state;
    const parent = ids(s).at(-1)!;
    const box = ok(s, 'createEntity', { kind: 'box', transform: { position: [1, 2, 3] } });
    s = box.state;
    const moved = ok(s, 'updateEntity', { entityId: box.id, parentId: parent });
    near(worldPosition(moved.state, box.id), [1, 2, 3]);
    expect((moved.change as UpdateEntityChange).transform?.previous.position).toEqual([1, 2, 3]);
    const undone = ok(moved.state, 'undo', {});
    expect(transformOf(undone.state, box.id).position).toEqual([1, 2, 3]);
    expect(entity(undone.state, box.id).parentId).toBeUndefined();
    const redone = ok(undone.state, 'redo', {});
    near(worldPosition(redone.state, box.id), [1, 2, 3]);
  });
});

describe('moveEntities', () => {
  /** folder F, boxes a b c at the root (in that order). */
  function setup(): { s: State; f: string; a: string; b: string; c: string } {
    let s = fresh();
    const f = ok(s, 'createEntity', { kind: 'folder', name: 'F' });
    s = f.state;
    const a = ok(s, 'createEntity', { kind: 'box', name: 'a', transform: { position: [1, 0, 0] } });
    s = a.state;
    const b = ok(s, 'createEntity', { kind: 'box', name: 'b', transform: { position: [2, 0, 0] } });
    s = b.state;
    const c = ok(s, 'createEntity', { kind: 'box', name: 'c', transform: { position: [3, 0, 0] } });
    return { s: c.state, f: f.id, a: a.id, b: b.id, c: c.id };
  }

  it('reorders siblings (before a sibling, or to the end); undo restores the order', () => {
    const { s, a, b, c } = setup();
    const before = ids(s);
    const m = ok(s, 'moveEntities', { entityIds: [c], parentId: null, beforeId: a });
    const order = ids(m.state);
    expect(order.indexOf(c)).toBe(order.indexOf(a) - 1);
    expect(transformOf(m.state, c).position).toEqual([3, 0, 0]);
    const change = m.change as MoveEntitiesChange;
    expect(change.type).toBe('moveEntities');
    expect(change.order.previous).toEqual(before);
    const end = ok(m.state, 'moveEntities', { entityIds: [a], parentId: null });
    expect(ids(end.state).at(-1)).toBe(a);
    const u1 = ok(end.state, 'undo', {});
    const u2 = ok(u1.state, 'undo', {});
    expect(ids(u2.state)).toEqual(before);
    void b;
  });

  it('files a multi-selection into a folder in one step, keeping world positions and document order', () => {
    const { s, f, a, c } = setup();
    const m = ok(s, 'moveEntities', { entityIds: [c, a], parentId: f });
    expect(childrenOf(m.state, f)).toEqual([a, c]);
    expect(transformOf(m.state, a).position).toEqual([1, 0, 0]);
    expect(transformOf(m.state, c).position).toEqual([3, 0, 0]);
    const undone = ok(m.state, 'undo', {});
    expect(childrenOf(undone.state, f)).toEqual([]);
    expect(ids(undone.state)).toEqual(ids(s));
    const redone = ok(undone.state, 'redo', {});
    expect(childrenOf(redone.state, f)).toEqual([a, c]);
  });

  it('moving out of a transformed object keeps the world transform', () => {
    let { s, a, b } = setup();
    s = ok(s, 'setTransform', { entityId: b, transform: { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2], scale: [2, 1, 1] } }).state;
    s = ok(s, 'moveEntities', { entityIds: [a], parentId: b }).state;
    near(worldPosition(s, a), [1, 0, 0]);
    s = ok(s, 'moveEntities', { entityIds: [a], parentId: null }).state;
    near(worldPosition(s, a), [1, 0, 0]);
    near(transformOf(s, a).position, [1, 0, 0]);
    near(transformOf(s, a).rotation, [0, 0, 0, 1]);
    near(transformOf(s, a).scale, [1, 1, 1]);
  });

  it('a child named with its ancestor moves with the ancestor only once', () => {
    let { s, f, a, b } = setup();
    s = ok(s, 'moveEntities', { entityIds: [b], parentId: a }).state;
    const m = ok(s, 'moveEntities', { entityIds: [a, b], parentId: f });
    expect(childrenOf(m.state, f)).toEqual([a]);
    expect(entity(m.state, b).parentId).toBe(a);
    expect((m.change as MoveEntitiesChange).entities.map((e) => e.id)).toEqual([a]);
  });

  it('refuses cycles, a folder under an object, a foreign beforeId, and a no-op', () => {
    let { s, f, a, b } = setup();
    s = ok(s, 'moveEntities', { entityIds: [b], parentId: a }).state;
    expect(run(s, 'moveEntities', { entityIds: [a], parentId: b }).result.ok).toBe(false);
    expect(run(s, 'moveEntities', { entityIds: [f], parentId: a }).result.ok).toBe(false);
    expect(run(s, 'moveEntities', { entityIds: [a], parentId: null, beforeId: b }).result.ok).toBe(false);
    const noop = run(s, 'moveEntities', { entityIds: [b], parentId: a });
    expect(noop.result.ok).toBe(false);
    expect((noop.result.error as { code: string }).code).toBe('no_change');
    expect(run(s, 'moveEntities', { entityIds: [], parentId: null }).result.ok).toBe(false);
    expect(run(s, 'moveEntities', { entityIds: [a, a], parentId: null }).result.ok).toBe(false);
  });
});
