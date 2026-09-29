/**
 * `setSaveSchema` — the project save schema, with undo/redo and
 * the no-change and validation refusals.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x5a1e0 + counter).toString(16).padStart(32, '0')}`, args });
  return { state: (out as { state?: State }).state ?? state, result: out.result as unknown as Record<string, unknown> };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content) as unknown as ContentDocument) as unknown as State;
const codeOf = (r: Record<string, unknown>): unknown => (r['error'] as { code?: string } | undefined)?.code ?? r['code'];
const schemaOf = (s: State): unknown => (s.content as { saveSchema?: unknown }).saveSchema;

describe('setSaveSchema', () => {
  it('sets, replaces and removes the schema (canonical order); undo/redo restore it', () => {
    let s = fresh();
    const a = run(s, 'setSaveSchema', { schema: { slots: 3, version: 1, sections: ['storage', 'grid'] } });
    expect(a.result.ok, JSON.stringify(a.result)).toBe(true);
    expect(a.result['change']).toEqual({ type: 'setSaveSchema', previous: null, next: { version: 1, slots: 3, sections: ['grid', 'storage'] } });
    s = a.state;
    expect(Object.keys(schemaOf(s) as object)).toEqual(['version', 'slots', 'sections']);
    s = run(s, 'setSaveSchema', { schema: { version: 2, slots: 3, migrations: [{ from: 1, name: 'v1to2' }] } }).state;
    expect(schemaOf(s)).toEqual({ version: 2, slots: 3, migrations: [{ from: 1, name: 'v1to2' }] });
    const undone = run(s, 'undo', {}).state;
    expect(schemaOf(undone)).toEqual({ version: 1, slots: 3, sections: ['grid', 'storage'] });
    expect(schemaOf(run(undone, 'redo', {}).state)).toEqual(schemaOf(s));
    const removed = run(s, 'setSaveSchema', { schema: null }).state;
    expect(schemaOf(removed)).toBeUndefined();
    expect(schemaOf(run(removed, 'undo', {}).state)).toEqual(schemaOf(s));
  });

  it('refuses a bad schema, a missing argument and a change that changes nothing', () => {
    const s = run(fresh(), 'setSaveSchema', { schema: { version: 1, slots: 3 } }).state;
    expect(codeOf(run(s, 'setSaveSchema', { schema: { version: 1, slots: 100 } }).result)).toBe('field_value');
    expect(run(s, 'setSaveSchema', {}).result.ok).toBe(false);
    expect(codeOf(run(s, 'setSaveSchema', { schema: { version: 1, slots: 3 } }).result)).toBe('no_change');
  });
});
