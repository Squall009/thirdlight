/**
 * `setLightLayers` — the light layer names, with undo/redo and the
 * refusals (too many names, too long a name, not a list, no change).
 */
import { describe, expect, it } from 'vitest';
import { LIGHT_LAYER_COUNT, MAX_LIGHT_LAYER_NAME, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x11a0 + counter).toString(16).padStart(32, '0')}`, args });
  return { state: (out as { state?: State }).state ?? state, result: out.result as unknown as Record<string, unknown> };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content) as unknown as ContentDocument) as unknown as State;
const codeOf = (r: Record<string, unknown>): unknown => (r['error'] as { code?: string } | undefined)?.code ?? r['code'];
const namesOf = (s: State): string[] | undefined => (s.content as { lightLayers?: string[] }).lightLayers;

describe('setLightLayers', () => {
  it('names layers (gaps and duplicates allowed), undoes and redoes; an empty list removes the field', () => {
    let s = fresh();
    expect(namesOf(s)).toBeUndefined();
    const a = run(s, 'setLightLayers', { layers: ['world', '', 'world'] });
    expect(a.result.ok, JSON.stringify(a.result)).toBe(true);
    expect(a.result['change']).toEqual({ type: 'setLightLayers', previous: [], next: ['world', '', 'world'] });
    s = a.state;
    expect(namesOf(s)).toEqual(['world', '', 'world']);
    s = run(s, 'setLightLayers', { layers: ['world', 'characters'] }).state;
    const undone = run(s, 'undo', {}).state;
    expect(namesOf(undone)).toEqual(['world', '', 'world']);
    expect(namesOf(run(undone, 'redo', {}).state)).toEqual(['world', 'characters']);
    const cleared = run(s, 'setLightLayers', { layers: [] }).state;
    expect(namesOf(cleared)).toBeUndefined();
    expect(namesOf(run(cleared, 'undo', {}).state)).toEqual(['world', 'characters']);
  });

  it('refuses more names than layers, a long name, a non-list and a change that changes nothing', () => {
    const s = run(fresh(), 'setLightLayers', { layers: ['world'] }).state;
    const tooMany = run(s, 'setLightLayers', { layers: Array.from({ length: LIGHT_LAYER_COUNT + 1 }, (_, i) => `l${i}`) });
    expect(tooMany.result.ok).toBe(false);
    expect(codeOf(tooMany.result)).toBe('field_value');
    expect(run(s, 'setLightLayers', { layers: Array.from({ length: LIGHT_LAYER_COUNT }, (_, i) => `l${i}`) }).result.ok).toBe(true);
    const long = run(s, 'setLightLayers', { layers: ['x'.repeat(MAX_LIGHT_LAYER_NAME + 1)] });
    expect(long.result.ok).toBe(false);
    expect((long.result['error'] as { path?: string }).path).toBe('/args/layers/0');
    expect(run(s, 'setLightLayers', { layers: [7] }).result.ok).toBe(false);
    expect(run(s, 'setLightLayers', { layers: 'world' }).result.ok).toBe(false);
    expect(run(s, 'setLightLayers', {}).result.ok).toBe(false);
    expect(codeOf(run(s, 'setLightLayers', { layers: ['world'] }).result)).toBe('no_change');
    expect(namesOf(s)).toEqual(['world']);
  });
});
