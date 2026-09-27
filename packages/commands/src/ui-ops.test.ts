/**
 * Phase 23.9a: UI documents and themes through the commands — create,
 * replace, delete (refused while flow.screens, a show action or a document's
 * theme names it), validation errors, no_change, and undo/redo.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4, UiDocument, UiTheme } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, SetUiChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;
let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x239a0 + counter).toString(16).padStart(32, '0')}`, args });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: SetUiChange } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 400)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change as unknown as SetUiChange };
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string; path?: string } {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  return r.result['error'] as { code: string; message: string };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const docs = (s: State): UiDocument[] => (s.content as { uiDocuments?: UiDocument[] }).uiDocuments ?? [];

const THEME: UiTheme = { uiThemeId: 'base', name: 'Base', styles: { btn: { background: '#223344' } } };
const MENU: UiDocument = { uiDocumentId: 'menu', name: 'Menu', modal: true, theme: 'base', root: { type: 'stack', children: [{ id: 'close', type: 'button', text: 'Close', style: 'btn', onClick: { do: 'hide', doc: 'menu' } }] } };
const HUD: UiDocument = { uiDocumentId: 'hud', name: 'HUD', root: { type: 'button', id: 'open', text: 'Menu', onClick: { do: 'show', doc: 'menu' } } };

describe('UI documents and themes through the commands', () => {
  it('creates, replaces and deletes with undo/redo; references hold', () => {
    let s = fresh();
    expect(refused(s, 'setUiDocument', { document: MENU }).code).toBe('reference_missing'); // its theme is missing
    s = ok(s, 'setUiTheme', { theme: THEME }).state;
    const made = ok(s, 'setUiDocument', { document: MENU });
    expect(made.change).toMatchObject({ type: 'setUi', uiKind: 'document', id: 'menu', previous: null });
    s = made.state;
    expect(refused(s, 'setUiDocument', { document: MENU }).code).toBe('no_change');
    s = ok(s, 'setUiDocument', { document: HUD }).state;
    expect(docs(s).map((d) => d.uiDocumentId)).toEqual(['hud', 'menu']);
    // Named by the hud's show action and by its theme user: refused.
    expect(refused(s, 'deleteUiDocument', { uiDocumentId: 'menu' }).code).toBe('reference_missing');
    expect(refused(s, 'deleteUiTheme', { uiThemeId: 'base' }).code).toBe('reference_missing');
    expect(refused(s, 'deleteUiDocument', { uiDocumentId: 'ghost' }).code).toBe('reference_missing');
    const renamed = { ...HUD, name: 'Heads-up' };
    s = ok(s, 'setUiDocument', { document: renamed }).state;
    s = ok(s, 'undo', {}).state;
    expect(docs(s).find((d) => d.uiDocumentId === 'hud')!.name).toBe('HUD');
    s = ok(s, 'redo', {}).state;
    expect(docs(s).find((d) => d.uiDocumentId === 'hud')!.name).toBe('Heads-up');
    s = ok(s, 'deleteUiDocument', { uiDocumentId: 'hud' }).state;
    s = ok(s, 'deleteUiDocument', { uiDocumentId: 'menu' }).state;
    expect(docs(s)).toEqual([]);
    expect((s.content as { uiDocuments?: unknown }).uiDocuments).toBeUndefined();
    s = ok(s, 'undo', {}).state;
    expect(docs(s).map((d) => d.uiDocumentId)).toEqual(['menu']);
  });

  it('refuses a malformed document with the path of the problem, and bad args', () => {
    const s = ok(fresh(), 'setUiTheme', { theme: THEME }).state;
    const e = refused(s, 'setUiDocument', { document: { ...HUD, root: { type: 'button', onClick: { do: 'engine', action: 'fly' } } } });
    expect(e.path).toBe('/args/document/root/onClick/action');
    expect(refused(s, 'setUiDocument', { doc: HUD }).code).toBe('field_unexpected');
    expect(refused(s, 'deleteUiDocument', { uiDocumentId: 3 }).code).toBe('field_type');
  });
});
