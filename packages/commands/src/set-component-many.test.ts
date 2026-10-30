/**
 * `setComponent` with `entityIds`: the same partial value merged into each
 * object's own component in one transaction — one revision, one history
 * entry, one undo and one redo for all of them; the change names the further
 * objects' new values (clients take them). A refusal on any object changes
 * nothing.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
type Entity = { id: string; components: Record<string, unknown> };

const T = { position: [0, 0, 1], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };

function state(): State {
  const scene = structuredClone(BEFORE.scene) as unknown as { entities: Entity[] };
  scene.entities.push({ id: 'decal-000001', components: { transform: T, decal: { size: [2, 1, 0.5], material: 'mat-crack' } } });
  scene.entities.push({ id: 'decal-000002', components: { transform: T, decal: { size: [1, 1, 1], material: 'mat-crack', sortOrder: 3 } } });
  scene.entities.push({ id: 'decal-000003', components: { transform: T, decal: { size: [3, 3, 1], material: 'mat-crack', opacity: { normal: 0.5 } } } });
  const content = { ...structuredClone(BEFORE.content), materials: [{ materialId: 'mat-crack', name: 'Crack', shader: 'decal', params: {}, textures: {} }] };
  return createCommandState(scene as unknown as SceneV4, content as unknown as ContentDocument) as unknown as State;
}

let counter = 0;
function run(s: State, op: string, args: Record<string, unknown>): { ok: boolean; state: State; result: Record<string, unknown>; code: string } {
  counter += 1;
  const out = applyMutation(s, { op, projectId: BEFORE.projectId, expectedRevision: s.scene.revision, requestId: `req-${(0x5c0000 + counter).toString(16).padStart(32, '0')}`, args });
  const result = out.result as unknown as Record<string, unknown> & { ok: boolean; error?: { code: string } };
  return { ok: result.ok, state: ((out as { state?: State }).state ?? s) as State, result, code: result.error?.code ?? '' };
}

const decal = (s: State, id: string): Record<string, unknown> => (s.scene.entities as unknown as Entity[]).find((e) => e.id === id)!.components['decal'] as Record<string, unknown>;

describe('setComponent on several objects', () => {
  it('merges the value into each one, in one revision and one history entry; one undo and one redo take all of them', () => {
    const s0 = state();
    const r = run(s0, 'setComponent', { entityId: 'decal-000001', component: 'decal', value: { opacity: { albedo: 0.25 }, fadeDistance: 40 }, entityIds: ['decal-000002', 'decal-000003'] });
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    // Each keeps its own fields; the value's fields are the same on all.
    expect(decal(r.state, 'decal-000001')).toEqual({ size: [2, 1, 0.5], material: 'mat-crack', opacity: { albedo: 0.25 }, fadeDistance: 40 });
    expect(decal(r.state, 'decal-000002')).toEqual({ size: [1, 1, 1], material: 'mat-crack', opacity: { albedo: 0.25 }, fadeDistance: 40, sortOrder: 3 });
    expect(decal(r.state, 'decal-000003')['size']).toEqual([3, 3, 1]);
    expect(decal(r.state, 'decal-000003')['opacity']).toEqual({ albedo: 0.25 });
    expect(r.result['revision']).toBe(s0.scene.revision + 1);
    expect(r.state.history.entries.length).toBe(s0.history.entries.length + 1);
    const change = r.result['change'] as { type: string; id: string; follows?: { entityId: string; component: string; next: unknown }[] };
    expect(change.type).toBe('setComponent');
    expect(change.id).toBe('decal-000001');
    expect(change.follows?.map((f) => [f.entityId, f.component, (f.next as { fadeDistance?: number }).fadeDistance])).toEqual([
      ['decal-000002', 'decal', 40],
      ['decal-000003', 'decal', 40],
    ]);

    const u = run(r.state, 'undo', {});
    expect(u.ok, JSON.stringify(u.result)).toBe(true);
    for (const id of ['decal-000001', 'decal-000002', 'decal-000003']) expect(decal(u.state, id)).toEqual(decal(s0, id));
    const back = run(u.state, 'redo', {});
    expect(back.ok, JSON.stringify(back.result)).toBe(true);
    for (const id of ['decal-000001', 'decal-000002', 'decal-000003']) expect(decal(back.state, id)).toEqual(decal(r.state, id));
  });

  it('takes each further object\'s own value from values (one width among different sizes), still one undo step', () => {
    const s0 = state();
    const r = run(s0, 'setComponent', { entityId: 'decal-000001', component: 'decal', value: { size: [4, 1, 0.5] }, entityIds: ['decal-000002', 'decal-000003'], values: [{ size: [4, 1, 1] }, { size: [4, 3, 1] }] });
    expect(r.ok, JSON.stringify(r.result)).toBe(true);
    expect([decal(r.state, 'decal-000001')['size'], decal(r.state, 'decal-000002')['size'], decal(r.state, 'decal-000003')['size']]).toEqual([[4, 1, 0.5], [4, 1, 1], [4, 3, 1]]);
    expect(r.state.history.entries.length).toBe(s0.history.entries.length + 1);
    const u = run(r.state, 'undo', {});
    expect(decal(u.state, 'decal-000003')['size']).toEqual([3, 3, 1]);
    expect(run(s0, 'setComponent', { entityId: 'decal-000001', component: 'decal', value: { size: [4, 1, 0.5] }, entityIds: ['decal-000002'], values: [] }).code).toBe('field_type');
    expect(run(s0, 'setComponent', { entityId: 'decal-000001', component: 'decal', value: { size: [4, 1, 0.5] }, entityIds: ['decal-000002'], values: [{ bogus: 1 }] }).code).toBe('field_unexpected');
  });

  it('changes nothing when one object refuses the value, names an object twice, or is not there', () => {
    const s0 = state();
    const bad = run(s0, 'setComponent', { entityId: 'decal-000001', component: 'decal', value: { size: [0, 1, 1] }, entityIds: ['decal-000002'] });
    expect(bad.ok).toBe(false);
    expect(bad.state).toBe(s0);
    expect(run(s0, 'setComponent', { entityId: 'decal-000001', component: 'decal', value: { sortOrder: 1 }, entityIds: ['decal-000002', 'decal-000002'] }).code).toBe('field_value');
    expect(run(s0, 'setComponent', { entityId: 'decal-000001', component: 'decal', value: { sortOrder: 1 }, entityIds: ['decal-000001'] }).code).toBe('field_value');
    expect(run(s0, 'setComponent', { entityId: 'decal-000001', component: 'decal', value: { sortOrder: 1 }, entityIds: [] }).code).toBe('field_value');
    expect(run(s0, 'setComponent', { entityId: 'decal-000001', component: 'decal', value: { sortOrder: 1 }, entityIds: ['nope-000009'] }).code).toBe('entity_not_found');
  });
});
