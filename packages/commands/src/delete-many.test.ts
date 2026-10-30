/**
 * `deleteEntity` with `entityIds`: several objects and their subtrees in one
 * transaction — one revision, one history entry; one undo puts every object
 * back at its index, one redo takes them again. A child named with its
 * parent goes with it; a refusal on any object deletes nothing.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
type Entity = { id: string; parentId?: string; components: Record<string, unknown> };

const T = { position: [0, 0, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

function state(): State {
  const scene = structuredClone(BEFORE.scene) as unknown as { entities: Entity[] };
  scene.entities.push({ id: 'decal-000001', components: { transform: T, decal: { size: [2, 1, 0.5], material: 'mat-crack' } } });
  scene.entities.push({ id: 'group-000001', components: { transform: T } });
  scene.entities.push({ id: 'decal-000002', parentId: 'group-000001', components: { transform: T, decal: { size: [1, 1, 1], material: 'mat-crack' } } });
  scene.entities.push({ id: 'decal-000003', components: { transform: T, decal: { size: [3, 3, 1], material: 'mat-crack' } } });
  const content = { ...structuredClone(BEFORE.content), materials: [{ materialId: 'mat-crack', name: 'Crack', shader: 'decal', params: {}, textures: {} }] };
  return createCommandState(scene as unknown as SceneV4, content as unknown as ContentDocument) as unknown as State;
}

let counter = 0;
function run(s: State, op: string, args: Record<string, unknown>): { ok: boolean; state: State; result: Record<string, unknown>; code: string } {
  counter += 1;
  const out = applyMutation(s, { op, projectId: BEFORE.projectId, expectedRevision: s.scene.revision, requestId: `req-${(0xde0000 + counter).toString(16).padStart(32, '0')}`, args });
  const result = out.result as unknown as Record<string, unknown> & { ok: boolean; error?: { code: string } };
  return { ok: result.ok, state: ((out as { state?: State }).state ?? s) as State, result, code: result.error?.code ?? '' };
}

const ids = (s: State): string[] => (s.scene.entities as unknown as Entity[]).map((e) => e.id);

describe('deleteEntity on several objects', () => {
  it('deletes them and their subtrees in one revision and one history entry; one undo and one redo take all of them', () => {
    const s0 = state();
    const r = run(s0, 'deleteEntity', { entityId: 'decal-000003', entityIds: ['group-000001', 'decal-000001'] });
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    expect(ids(r.state).filter((id) => /^(decal|group)-000001$|^decal-00000[23]$/.test(id))).toEqual([]);
    expect(r.result['revision']).toBe(s0.scene.revision + 1);
    expect(r.state.history.entries.length).toBe(s0.history.entries.length + 1);
    // The change lists every deleted object in the scene's order (clients remove them all).
    const change = r.result['change'] as { type: string; rootId: string; deletedIds: string[] };
    expect(change).toEqual({ type: 'deleteEntity', rootId: 'decal-000003', deletedIds: ['decal-000001', 'group-000001', 'decal-000002', 'decal-000003'] });

    const u = run(r.state, 'undo', {});
    expect(u.ok, JSON.stringify(u.result)).toBe(true);
    // Back where they were: the same order, the child under its parent again.
    expect(ids(u.state)).toEqual(ids(s0));
    expect((u.state.scene.entities as unknown as Entity[]).find((e) => e.id === 'decal-000002')!.parentId).toBe('group-000001');
    const back = run(u.state, 'redo', {});
    expect(back.ok, JSON.stringify(back.result)).toBe(true);
    expect(ids(back.state)).toEqual(ids(r.state));
  });

  it('takes a child named with its parent along once; refuses an object named twice, or a missing one, deleting nothing', () => {
    const s0 = state();
    const r = run(s0, 'deleteEntity', { entityId: 'group-000001', entityIds: ['decal-000002'] });
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    expect((r.result['change'] as { deletedIds: string[] }).deletedIds).toEqual(['group-000001', 'decal-000002']);
    expect(run(s0, 'deleteEntity', { entityId: 'decal-000001', entityIds: ['decal-000003', 'decal-000003'] }).code).toBe('field_value');
    expect(run(s0, 'deleteEntity', { entityId: 'decal-000001', entityIds: ['decal-000001'] }).code).toBe('field_value');
    expect(run(s0, 'deleteEntity', { entityId: 'decal-000001', entityIds: [] }).code).toBe('field_value');
    const missing = run(s0, 'deleteEntity', { entityId: 'decal-000001', entityIds: ['nope-000009'] });
    expect(missing.code).toBe('entity_not_found');
    expect(missing.state).toBe(s0);
  });
});
