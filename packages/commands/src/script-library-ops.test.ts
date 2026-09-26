/**
 * Phase 23.7: shared script libraries through the commands — setScriptLibrary
 * (create, patch, rename), deleteScriptLibrary (refused while imported), the
 * dependents republished in the same command from prepared facts only (trust
 * per library digest), and undo/redo moving library and dependents together.
 */
import { describe, expect, it } from 'vitest';
import { scriptLibraryDigest, scriptLibrarySetKey, type ScriptLibrary, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, PreparedBehaviorSourceFact, SetScriptLibraryChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;

const facts = new Map<string, PreparedBehaviorSourceFact>();
let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const input = { ...state, behaviorPreparerRegistered: true, preparedBehaviorSources: facts } as State;
  const out = applyMutation(input, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x23700 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change };
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string } {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  return r.result['error'] as { code: string; message: string };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const libraries = (s: State): ScriptLibrary[] => (s.content as { scriptLibraries?: ScriptLibrary[] }).scriptLibraries ?? [];
const behavior = (s: State, id: string) => s.content!.behaviors.find((b) => b.behaviorId === id)!;

const INDEX_V1 = 'export const factor = 2;\n';
const INDEX_V2 = 'export const factor = 3;\n';
const SOURCE = 'a'.repeat(64);

function fact(libraryDigest: string, outputDigest: string): PreparedBehaviorSourceFact {
  return {
    behaviorId: 'user',
    sourceDigest: SOURCE,
    sourceByteLength: 300,
    entryPath: 'src/index.ts',
    fileCount: 1,
    manifestDigest: outputDigest.replace(/./, 'e'),
    outputDigest,
    outputByteLength: 120,
    requiredModules: [],
    ownedTransforms: [],
    declaration: { properties: [] },
    libraries: [{ libraryId: 'rules', sourceDigest: libraryDigest }],
    declarationDigest: 'd'.repeat(64),
    recipeDigest: 'c'.repeat(64),
    compiler: { id: 'thirdlight.behavior-compiler', version: '1', esbuild: '0.28.2', typescript: '5.9.3' },
  };
}

/** A project with library `rules` (v1) and a published script `user` that imports it. */
function withDependent(): State {
  let s = ok(fresh(), 'setScriptLibrary', { libraryId: 'rules', name: 'Rules', files: [{ path: 'src/index.ts', text: INDEX_V1 }] }).state;
  const v1 = scriptLibraryDigest(libraries(s)[0]!);
  s = ok(s, 'publishBehavior', { behaviorId: 'user', displayName: 'User', mode: 'declaration-create', declaration: { properties: [] } }).state;
  s = ok(s, 'acknowledgeBehaviorTrust', { sourceDigest: SOURCE }).state;
  facts.set(SOURCE, fact(v1, '1'.repeat(64)));
  expect(refused(s, 'publishBehavior', { behaviorId: 'user', displayName: 'User', mode: 'source', declaration: { properties: [] }, source: { sourceDigest: SOURCE, sourceByteLength: 300 } }).code).toBe('behavior_trust_unacknowledged');
  s = ok(s, 'acknowledgeBehaviorTrust', { sourceDigest: v1 }).state;
  s = ok(s, 'publishBehavior', { behaviorId: 'user', displayName: 'User', mode: 'source', declaration: { properties: [] }, source: { sourceDigest: SOURCE, sourceByteLength: 300 } }).state;
  return s;
}

describe('script library commands', () => {
  it('creates, patches (add/replace/remove files) and renames, each one undo step', () => {
    const created = ok(fresh(), 'setScriptLibrary', { libraryId: 'util', name: 'Util', files: [{ path: 'src/index.ts', text: INDEX_V1 }, { path: 'src/data.json', text: '{"a":1}' }] });
    expect((created.change as SetScriptLibraryChange).previous).toBeNull();
    expect(libraries(created.state)[0]!.files.map((f) => f.path)).toEqual(['src/data.json', 'src/index.ts']);
    const patched = ok(created.state, 'setScriptLibrary', { libraryId: 'util', files: [{ path: 'src/data.json', text: null }, { path: 'src/more.ts', text: 'export {};\n' }] });
    expect(libraries(patched.state)[0]!.files.map((f) => f.path)).toEqual(['src/index.ts', 'src/more.ts']);
    const renamed = ok(patched.state, 'setScriptLibrary', { libraryId: 'util', name: 'Utilities' });
    expect(libraries(renamed.state)[0]!.name).toBe('Utilities');
    expect(libraries(ok(renamed.state, 'undo', {}).state)[0]!.name).toBe('Util');
    expect(libraries(ok(created.state, 'undo', {}).state)).toEqual([]);
    expect(refused(renamed.state, 'setScriptLibrary', { libraryId: 'util', name: 'Utilities' }).code).toBe('no_change');
  });

  it('refuses a new library without a name or entry, bad paths and removing a missing file', () => {
    const s = fresh();
    expect(refused(s, 'setScriptLibrary', { libraryId: 'x', files: [{ path: 'src/index.ts', text: '' }] }).code).toBe('field_value');
    expect(refused(s, 'setScriptLibrary', { libraryId: 'x', name: 'X', files: [{ path: 'src/other.ts', text: '' }] }).code).toBe('field_missing');
    expect(refused(s, 'setScriptLibrary', { libraryId: 'x', name: 'X', files: [{ path: 'src/index.ts', text: '' }, { path: 'src/a.tsx', text: '' }] }).code).toBe('field_value');
    expect(refused(s, 'setScriptLibrary', { libraryId: 'x', name: 'X', files: [{ path: 'src/index.ts', text: null }] }).code).toBe('field_value');
    expect(refused(s, 'setScriptLibrary', { libraryId: 'Bad', name: 'X' }).code).toBe('field_type');
    expect(refused(s, 'setScriptLibrary', { libraryId: 'x', name: 'X', files: [{ path: 'src/index.ts', text: '' }], extra: 1 }).code).toBe('field_unexpected');
  });

  it('a changed library republishes its dependents in the same command, from prepared facts and trusted digests only', () => {
    const s = withDependent();
    const v1 = scriptLibraryDigest(libraries(s)[0]!);
    expect(behavior(s, 'user').source?.libraries).toEqual([{ libraryId: 'rules', sourceDigest: v1 }]);
    // No prepared fact for the new library set: refused, nothing changes.
    const patch = { libraryId: 'rules', files: [{ path: 'src/index.ts', text: INDEX_V2 }] };
    expect(refused(s, 'setScriptLibrary', patch).code).toBe('behavior_publication_unavailable');
    const next: ScriptLibrary = { libraryId: 'rules', name: 'Rules', files: [{ path: 'src/index.ts', text: INDEX_V2 }] };
    const v2 = scriptLibraryDigest(next);
    facts.set(`${SOURCE}|${scriptLibrarySetKey([next])}`, fact(v2, '2'.repeat(64)));
    expect(refused(s, 'setScriptLibrary', patch).code).toBe('behavior_trust_unacknowledged');
    const acked = ok(s, 'acknowledgeBehaviorTrust', { sourceDigest: v2 }).state;
    const changed = ok(acked, 'setScriptLibrary', patch);
    const change = changed.change as SetScriptLibraryChange;
    expect(change.behaviors.map((b) => b.behaviorId)).toEqual(['user']);
    expect(behavior(changed.state, 'user').source?.outputDigest).toBe('2'.repeat(64));
    expect(behavior(changed.state, 'user').source?.libraries).toEqual([{ libraryId: 'rules', sourceDigest: v2 }]);
    // Undo moves both back; redo forward again.
    const undone = ok(changed.state, 'undo', {}).state;
    expect(libraries(undone)[0]!.files[0]!.text).toBe(INDEX_V1);
    expect(behavior(undone, 'user').source?.outputDigest).toBe('1'.repeat(64));
    const redone = ok(undone, 'redo', {}).state;
    expect(behavior(redone, 'user').source?.libraries).toEqual([{ libraryId: 'rules', sourceDigest: v2 }]);
    // A renamed library keeps its digest: no dependent needs recompiling.
    const renamed = ok(redone, 'setScriptLibrary', { libraryId: 'rules', name: 'Game rules' });
    expect((renamed.change as SetScriptLibraryChange).behaviors).toEqual([]);
  });

  it('refuses deleting an imported library and publishing against a stale library version', () => {
    const s = withDependent();
    expect(refused(s, 'deleteScriptLibrary', { libraryId: 'rules' }).code).toBe('reference_in_use');
    expect(refused(s, 'deleteScriptLibrary', { libraryId: 'nope' }).code).toBe('reference_missing');
    // A fact compiled against another version of the library is refused by the resulting-state check.
    facts.set(SOURCE, fact('f'.repeat(64), '3'.repeat(64)));
    const acked = ok(s, 'acknowledgeBehaviorTrust', { sourceDigest: 'f'.repeat(64) }).state;
    expect(JSON.stringify(refused(acked, 'publishBehavior', { behaviorId: 'user', displayName: 'User', mode: 'source', declaration: { properties: [] }, source: { sourceDigest: SOURCE, sourceByteLength: 300 } }))).toContain('another version of the script library');
  });

  it('deletes an unused library (one undo step)', () => {
    const s = ok(fresh(), 'setScriptLibrary', { libraryId: 'util', name: 'Util', files: [{ path: 'src/index.ts', text: INDEX_V1 }] }).state;
    const deleted = ok(s, 'deleteScriptLibrary', { libraryId: 'util' });
    expect(libraries(deleted.state)).toEqual([]);
    expect(libraries(ok(deleted.state, 'undo', {}).state).map((l) => l.libraryId)).toEqual(['util']);
  });
});
