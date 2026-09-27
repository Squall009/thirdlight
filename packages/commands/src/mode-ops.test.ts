/**
 * Phase 23.10: game modes and behavior groups through the commands —
 * setModes / setBehaviorGroups (whole lists), the references the result is
 * checked for (UI documents, input maps, groups; a group an object carries;
 * a mode a UI action names), no_change, bad args, and undo/redo; the
 * behaviorGroup component through setComponent; input.maps through setInput.
 */
import { describe, expect, it } from 'vitest';
import type { GameMode, SceneV4, UiDocument } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, SetModesChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x2310a0 + counter).toString(16).padStart(32, '0')}`, args });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 400)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change };
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string; path?: string } {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  return r.result['error'] as { code: string; message: string; path?: string };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const modesOf = (s: State): GameMode[] => (s.content as { modes?: GameMode[] }).modes ?? [];

const HUD: UiDocument = { uiDocumentId: 'hud', name: 'HUD', root: { type: 'text', text: 'hud' } };
const BOARD: UiDocument = { uiDocumentId: 'board', name: 'Board', actionMap: 'tactical', root: { type: 'button', id: 'back', text: 'Back', onClick: { do: 'mode', mode: 'explore' } } };
const EXPLORE: GameMode = { modeId: 'explore', name: 'Explore', inputMaps: ['gameplay', 'ui'], ui: ['hud'], groups: ['field'] };
const TACTICAL: GameMode = { modeId: 'tactical', name: 'Tactical', inputMaps: ['tactical', 'ui'], camera: 'cam-top', ui: ['board'], groups: ['board'], pause: false, timeScale: 0.5, physics: 'hold', enter: { blend: 'eased', blendTime: 0.4 } };

describe('game modes and behavior groups through the commands', () => {
  it('sets the whole list with its references checked; undo/redo; the first mode is the start mode', () => {
    let s = fresh();
    expect(refused(s, 'setModes', { modes: [EXPLORE] }).code).toBe('reference_missing'); // no hud document, no field group
    s = ok(s, 'setUiDocument', { document: HUD }).state;
    s = ok(s, 'setBehaviorGroups', { groups: ['field', 'board'] }).state;
    const made = ok(s, 'setModes', { modes: [EXPLORE] });
    expect(made.change as SetModesChange).toMatchObject({ type: 'setModes', previous: [], next: [EXPLORE] });
    s = made.state;
    expect(refused(s, 'setModes', { modes: [EXPLORE] }).code).toBe('no_change');
    // A project input map, then a document activating it with a mode action, then the tactical mode.
    expect(refused(s, 'setModes', { modes: [EXPLORE, TACTICAL] }).code).toBe('reference_missing'); // no board document, no tactical map
    s = ok(s, 'setInput', { input: { actions: [{ name: 'select', type: 'button', map: 'tactical', bindings: [{ kind: 'key', code: 'Enter' }] }], maps: ['tactical'] } }).state;
    expect(refused(s, 'setUiDocument', { document: { ...BOARD, root: { type: 'button', id: 'back', text: 'Back', onClick: { do: 'mode', mode: 'ghost' } } } }).code).toBe('reference_missing');
    s = ok(s, 'setUiDocument', { document: BOARD }).state;
    s = ok(s, 'setModes', { modes: [EXPLORE, TACTICAL] }).state;
    expect(modesOf(s).map((m) => m.modeId)).toEqual(['explore', 'tactical']);
    // Order is data: tactical first makes it the start mode.
    s = ok(s, 'setModes', { modes: [TACTICAL, EXPLORE] }).state;
    expect(modesOf(s)[0]!.modeId).toBe('tactical');
    s = ok(s, 'undo', {}).state;
    expect(modesOf(s)[0]!.modeId).toBe('explore');
    s = ok(s, 'redo', {}).state;
    expect(modesOf(s)[0]!.modeId).toBe('tactical');
    // Removing what a mode names is refused: its document, its group, its map; a mode a UI action names.
    expect(refused(s, 'deleteUiDocument', { uiDocumentId: 'hud' }).code).toBe('reference_missing');
    expect(refused(s, 'setBehaviorGroups', { groups: ['board'] }).code).toBe('reference_missing');
    expect(refused(s, 'setModes', { modes: [TACTICAL] }).code).toBe('reference_missing'); // the board's back button names explore
    // An empty list removes the field (the content bytes as before modes existed).
    s = ok(s, 'setUiDocument', { document: { ...BOARD, root: { type: 'text', text: 'board' } } }).state;
    s = ok(s, 'setModes', { modes: [] }).state;
    expect((s.content as { modes?: unknown }).modes).toBeUndefined();
    s = ok(s, 'undo', {}).state;
    expect(modesOf(s)).toHaveLength(2);
  });

  it('an object joins a behavior group with setComponent; a group in use cannot be removed', () => {
    let s = fresh();
    { const e0 = refused(s, 'setComponent', { entityId: 'box-0001', component: 'behaviorGroup', value: { group: 'field' } }); expect(e0.code, JSON.stringify(e0)).toBe('reference_missing'); }
    s = ok(s, 'setBehaviorGroups', { groups: ['field'] }).state;
    s = ok(s, 'setComponent', { entityId: 'box-0001', component: 'behaviorGroup', value: { group: 'field' } }).state;
    const e = s.scene.entities.find((x) => x.id === 'box-0001')!;
    expect((e.components as { behaviorGroup?: unknown }).behaviorGroup).toEqual({ group: 'field' });
    expect(refused(s, 'setBehaviorGroups', { groups: [] }).code).toBe('reference_missing');
    expect(refused(s, 'setComponent', { entityId: 'box-0001', component: 'behaviorGroup', value: { group: '9 bad' } }).code).toBe('field_value');
    s = ok(s, 'undo', {}).state;
    expect((s.scene.entities.find((x) => x.id === 'box-0001')!.components as { behaviorGroup?: unknown }).behaviorGroup).toBeUndefined();
  });

  it('refuses malformed lists and bad args with the path of the problem', () => {
    const s = fresh();
    expect(refused(s, 'setModes', { modes: [{ modeId: 'Bad Id', name: 'x' }] }).path).toBe('/args/modes/0/modeId');
    expect(refused(s, 'setModes', { modes: [{ modeId: 'a', name: 'A', timeScale: 9 }] }).path).toBe('/args/modes/0/timeScale');
    expect(refused(s, 'setModes', { modes: [{ modeId: 'a', name: 'A' }, { modeId: 'a', name: 'B' }] }).code).toBe('id_duplicate');
    expect(refused(s, 'setModes', { mode: [] }).code).toBe('field_unexpected');
    expect(refused(s, 'setModes', { modes: {} }).code).toBe('field_type');
    expect(refused(s, 'setBehaviorGroups', { groups: ['a', 'a'] }).code).toBe('field_value');
    expect(refused(s, 'setInput', { input: { actions: [], maps: ['ui'] } }).code).toBe('field_value');
  });
});
