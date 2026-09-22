/**
 * `updateEntity`: rename and reparent, parent-before-child reordering, and
 * exact undo/redo of both.
 */

import { describe, expect, it } from 'vitest';
import type { SceneV3 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument, MutationSuccess } from './index';
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
    requestId: `req-${counter.toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: ((out as { state?: State }).state ?? state), result: out.result as unknown as Record<string, unknown> };
}

function fresh(): State {
  return createCommandState(
    structuredClone(BEFORE.scene),
    structuredClone(BEFORE.content) as unknown as ContentDocument,
  ) as unknown as State;
}

const ids = (s: State): string[] => s.scene.entities.map((e) => e.id);
const entity = (s: State, id: string) => s.scene.entities.find((e) => e.id === id)!;

/** Two plain boxes appended at the end: a (earlier) and b (later). */
function withTwoBoxes(): { state: State; a: string; b: string } {
  let state = fresh();
  const r1 = run(state, 'createEntity', { kind: 'box', name: 'a' });
  state = r1.state;
  const r2 = run(state, 'createEntity', { kind: 'box', name: 'b' });
  state = r2.state;
  return { state, a: String(r1.result.createdId), b: String(r2.result.createdId) };
}

describe('updateEntity', () => {
  it('renames an entity; undo and redo restore each name', () => {
    const { state, a } = withTwoBoxes();
    const renamed = run(state, 'updateEntity', { entityId: a, name: 'Crate' });
    expect(renamed.result.ok).toBe(true);
    const change = (renamed.result as unknown as MutationSuccess).change as unknown as { changedFields: string[]; order: unknown };
    expect(change.changedFields).toEqual(['name']);
    expect(change.order).toBeNull();
    expect(entity(renamed.state, a).name).toBe('Crate');

    const undone = run(renamed.state, 'undo', {});
    expect(entity(undone.state, a).name).toBe('a');
    const redone = run(undone.state, 'redo', {});
    expect(entity(redone.state, a).name).toBe('Crate');
  });

  it('reparents under a later entity by moving the subtree after it; undo restores the order', () => {
    const { state, a, b } = withTwoBoxes();
    const before = ids(state);
    const moved = run(state, 'updateEntity', { entityId: a, parentId: b });
    expect(moved.result.ok).toBe(true);
    expect(entity(moved.state, a).parentId).toBe(b);
    const after = ids(moved.state);
    expect(after.indexOf(a)).toBe(after.indexOf(b) + 1);

    const undone = run(moved.state, 'undo', {});
    expect(ids(undone.state)).toEqual(before);
    expect(entity(undone.state, a).parentId).toBeUndefined();
    const redone = run(undone.state, 'redo', {});
    expect(ids(redone.state)).toEqual(after);
  });

  it('reparents under an earlier entity without moving anything; null makes it a root again', () => {
    const { state, a, b } = withTwoBoxes();
    const before = ids(state);
    const moved = run(state, 'updateEntity', { entityId: b, parentId: a });
    expect(moved.result.ok).toBe(true);
    expect(ids(moved.state)).toEqual(before);
    const rooted = run(moved.state, 'updateEntity', { entityId: b, parentId: null });
    expect(rooted.result.ok).toBe(true);
    expect(entity(rooted.state, b).parentId).toBeUndefined();
  });

  it('refuses cycles, unknown parents, and empty updates without changing state', () => {
    const { state, a, b } = withTwoBoxes();
    const nested = run(state, 'updateEntity', { entityId: b, parentId: a }).state;
    const cycle = run(nested, 'updateEntity', { entityId: a, parentId: b });
    expect(cycle.result.ok).toBe(false);
    expect(cycle.state.scene).toEqual(nested.scene);
    const self = run(nested, 'updateEntity', { entityId: a, parentId: a });
    expect(self.result.ok).toBe(false);
    const missing = run(nested, 'updateEntity', { entityId: a, parentId: 'box-9999' });
    expect((missing.result as { error: { code: string } }).error.code).toBe('reference_missing');
    const empty = run(nested, 'updateEntity', { entityId: a });
    expect(empty.result.ok).toBe(false);
    const same = run(nested, 'updateEntity', { entityId: a, name: 'a' });
    expect((same.result as { error: { code: string } }).error.code).toBe('no_change');
  });
});
