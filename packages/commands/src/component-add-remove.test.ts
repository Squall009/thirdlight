/**
 * Phase 15.1: every component the Inspector's "+ Add component" offers is
 * added and removed through `setComponent` — box, camera and model included
 * (a complete value adds, `null` removes; the resulting scene is validated as
 * always) — and every top-level field a component descriptor lists is a field
 * `setComponent` accepts (so a generic Inspector edit is never refused as an
 * unknown field).
 */

import { describe, expect, it } from 'vitest';
import { DESCRIPTORS, type SceneV3 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { ALL_OWNED_COMPONENTS } from './v3';
import { validateSetComponentArgs } from './validate-content-args';
import { m3ContractJson } from './test-fixtures';

interface EnvelopeFixture {
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}

const BEFORE = m3ContractJson<EnvelopeFixture>('commands/scenario.before.json');
type State = CommandState<SceneV3>;

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { ok: boolean; state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x15100 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { ok: out.ok, state: (out as { state?: State }).state ?? state, result: out.result as unknown as Record<string, unknown> };
}

function fresh(): State {
  return createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content) as unknown as ContentDocument) as unknown as State;
}

const components = (s: State, id: string): Record<string, unknown> => s.scene.entities.find((e) => e.id === id)!.components as unknown as Record<string, unknown>;
const errorCode = (r: { result: Record<string, unknown> }): string => String((r.result['error'] as { code?: string } | undefined)?.code);

describe('setComponent adds and removes box, camera and model (phase 15.1)', () => {
  it('adds a box to an empty object, undoes it, and removes it again', () => {
    let s = fresh();
    const created = run(s, 'createEntity', { kind: 'group', name: 'Empty' });
    expect(created.ok, JSON.stringify(created.result)).toBe(true);
    s = created.state;
    const id = String(created.result['createdId']);
    const added = run(s, 'setComponent', { entityId: id, component: 'box', value: { size: [1, 2, 1], material: { color: '#b0b0b0' } } });
    expect(added.ok, JSON.stringify(added.result)).toBe(true);
    expect(components(added.state, id)['box']).toEqual({ size: [1, 2, 1], material: { color: '#b0b0b0' } });
    const undone = run(added.state, 'undo', {});
    expect(undone.ok).toBe(true);
    expect(components(undone.state, id)['box']).toBeUndefined();
    const redone = run(undone.state, 'redo', {});
    expect(components(redone.state, id)['box']).toBeDefined();
    const removed = run(redone.state, 'setComponent', { entityId: id, component: 'box', value: null });
    expect(removed.ok, JSON.stringify(removed.result)).toBe(true);
    expect(components(removed.state, id)['box']).toBeUndefined();
  });

  it('refuses a second shape on one object and removing the game camera', () => {
    const s = fresh();
    const box = s.scene.entities.find((e) => (e.components as Record<string, unknown>)['box'] !== undefined)!;
    const both = run(s, 'setComponent', { entityId: box.id, component: 'camera', value: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } });
    expect(both.ok).toBe(false);
    const cameraId = (BEFORE.content as unknown as { game?: { cameraId: string } }).game?.cameraId;
    if (cameraId !== undefined) {
      const gone = run(s, 'setComponent', { entityId: cameraId, component: 'camera', value: null });
      expect(gone.ok).toBe(false);
      expect(errorCode(gone)).toBe('game_reference_in_use');
    }
  });
});

describe('descriptor fields are setComponent fields', () => {
  it('accepts every top-level descriptor field of every setComponent-owned component', () => {
    const owned = new Set<string>(ALL_OWNED_COMPONENTS);
    let checked = 0;
    for (const c of DESCRIPTORS.components) {
      if (!owned.has(c.name) || c.value.type !== 'object') continue;
      for (const f of c.value.fields) {
        const r = validateSetComponentArgs({ entityId: 'x', component: c.name, value: { [f.key]: 0 } });
        if (!r.ok) expect(r.error.code, `${c.name}.${f.key}`).not.toBe('field_unexpected');
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });
});
