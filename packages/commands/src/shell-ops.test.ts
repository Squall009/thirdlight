/**
 * Phase 24.4j through the commands: `setShell` (the whole game shell; its
 * documents must exist; undo/redo; null removes the field). Its listed
 * scenes and spawns are the cross-scene project rule (project-v4.test).
 */
import { describe, expect, it } from 'vitest';
import type { GameShell, SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, SetShellChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x244f0 + counter).toString(16).padStart(32, '0')}`, args });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown; id: string } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 400)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change, id: String(r.result['createdId'] ?? '') };
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string; path?: string } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 400)).toBe(false);
  return r.result['error'] as { code: string; message: string; path?: string };
}
const shellOf = (s: State): GameShell | undefined => (s.content as { shell?: GameShell }).shell;
const doc = (id: string): Record<string, unknown> => ({ uiDocumentId: id, name: id, root: { type: 'panel' } });

describe('setShell', () => {
  it('sets the whole shell (canonical), checks its documents, undoes and redoes; null removes it', () => {
    let s = createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
    // A document that does not exist is refused by the resulting-state gate.
    expect(refused(s, 'setShell', { shell: { screens: { title: 'title' } } }).code).toBe('reference_missing');
    s = ok(s, 'setUiDocument', { document: doc('title') }).state;
    s = ok(s, 'setUiDocument', { document: doc('hud') }).state;
    // The shape: an unknown screen, a bad field.
    expect(refused(s, 'setShell', { shell: { screens: { levelComplete: 'title' } } }).code).toBe('field_unexpected');
    expect(refused(s, 'setShell', { shell: { pause: 'yes' } }).code).toBe('field_type');
    expect(refused(s, 'setShell', { shell: 'title' }).code).toBe('field_type');
    const spawn = ok(s, 'createEntity', { parentId: null, kind: 'group', name: 'Start', transform: { position: [0, 1, 0] }, components: { playerSpawn: {} } });
    s = spawn.state;
    // Keys in any order come out canonical.
    const set = ok(s, 'setShell', { shell: { status: true, scenes: [{ spawn: spawn.id, scene: 'scene-main' }], hud: ['hud'], screens: { pause: 'hud', title: 'title' } } });
    s = set.state;
    expect(JSON.stringify(shellOf(s))).toBe(JSON.stringify({ screens: { title: 'title', pause: 'hud' }, hud: ['hud'], scenes: [{ scene: 'scene-main', spawn: spawn.id }], status: true }));
    const change = set.change as SetShellChange;
    expect(change.type).toBe('setShell');
    expect(change.previous).toBeNull();
    // A document the shell uses cannot be deleted.
    expect(refused(s, 'deleteUiDocument', { uiDocumentId: 'hud' }).code).toBe('reference_missing');
    const undone = ok(s, 'undo', {}).state;
    expect(shellOf(undone)).toBeUndefined();
    const redone = ok(undone, 'redo', {}).state;
    expect(shellOf(redone)?.hud).toEqual(['hud']);
    const cleared = ok(redone, 'setShell', { shell: null });
    expect(shellOf(cleared.state)).toBeUndefined();
    expect((cleared.change as SetShellChange).next).toBeNull();
  });
});
