/**
 * `deleteBehavior` and `revokeBehaviorTrust` through the commands: each is
 * refused while something still needs what it removes (an object or a
 * prefab carrying the script; a published script built from the source or
 * against the library version), removes it otherwise in one undo step, and
 * a revoked source is asked for again at its next publication.
 */
import { describe, expect, it } from 'vitest';
import { scriptLibraryDigest, type ScriptLibrary, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState, queryBehaviors } from './index';
import type { CommandState, MutationSuccess, PreparedBehaviorSourceFact, PublishBehaviorChange, AcknowledgeBehaviorTrustChange } from './index';
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
    requestId: `req-${(0x31100 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result).slice(0, 600)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change };
}
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; message: string; details?: { path?: string; document?: string }[] } {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  return r.result['error'] as { code: string; message: string; details?: { path?: string; document?: string }[] };
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const behaviorIds = (s: State): string[] => s.content!.behaviors.map((b) => b.behaviorId);
const trusted = (s: State): string[] => s.content!.behaviorTrust.entries.map((e) => e.sourceDigest);
const libraries = (s: State): ScriptLibrary[] => (s.content as { scriptLibraries?: ScriptLibrary[] }).scriptLibraries ?? [];

const SOURCE = 'b'.repeat(64);
const SPIN = { behaviorId: 'spinner', displayName: 'Spinner', mode: 'declaration-create', declaration: { properties: [{ key: 'speed', label: 'Speed', type: 'number', default: 1 }] } };

function fact(libraryDigest: string): PreparedBehaviorSourceFact {
  return {
    behaviorId: 'user',
    sourceDigest: SOURCE,
    sourceByteLength: 300,
    entryPath: 'src/index.ts',
    fileCount: 1,
    manifestDigest: 'e'.repeat(64),
    outputDigest: '1'.repeat(64),
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

/** A project whose script `user` is published from SOURCE against library `rules` (both acknowledged). */
function withPublished(): { s: State; library: string } {
  let s = ok(fresh(), 'setScriptLibrary', { libraryId: 'rules', name: 'Rules', files: [{ path: 'src/index.ts', text: 'export const factor = 2;\n' }] }).state;
  const library = scriptLibraryDigest(libraries(s)[0]!);
  s = ok(s, 'publishBehavior', { behaviorId: 'user', displayName: 'User', mode: 'declaration-create', declaration: { properties: [] } }).state;
  s = ok(s, 'acknowledgeBehaviorTrust', { sourceDigest: SOURCE }).state;
  s = ok(s, 'acknowledgeBehaviorTrust', { sourceDigest: library }).state;
  facts.set(SOURCE, fact(library));
  s = ok(s, 'publishBehavior', { behaviorId: 'user', displayName: 'User', mode: 'source', declaration: { properties: [] }, source: { sourceDigest: SOURCE, sourceByteLength: 300 } }).state;
  return { s, library };
}

describe('deleteBehavior', () => {
  it('is refused while an object carries the script, removes it after, one undo step each way', () => {
    let s = ok(fresh(), 'publishBehavior', SPIN).state;
    s = ok(s, 'setBehaviorProperties', { entityId: 'box-0001', behaviorId: 'spinner', values: { speed: 2 } }).state;
    const inUse = refused(s, 'deleteBehavior', { behaviorId: 'spinner' });
    expect(inUse.code).toBe('reference_in_use');
    expect(inUse.message).toContain('behavior "spinner" is still used');
    expect(inUse.details?.some((d) => /\/components\/behavior\/behaviorId$/.test(d.path ?? ''))).toBe(true);
    expect(behaviorIds(s)).toEqual(['spinner']);

    s = ok(s, 'setBehaviorProperties', { entityId: 'box-0001', behaviorId: null }).state;
    const del = ok(s, 'deleteBehavior', { behaviorId: 'spinner' });
    const change = del.change as PublishBehaviorChange;
    expect(change.type).toBe('publishBehavior');
    expect(change.previous?.behaviorId).toBe('spinner');
    expect(change.next).toBeNull();
    expect(behaviorIds(del.state)).toEqual([]);

    const undone = ok(del.state, 'undo', {});
    expect((undone.change as PublishBehaviorChange).next?.declaration.properties[0]?.key).toBe('speed');
    expect(behaviorIds(undone.state)).toEqual(['spinner']);
    expect(behaviorIds(ok(undone.state, 'redo', {}).state)).toEqual([]);
  });

  it('is refused while a prefab object carries the script, and for an unknown id', () => {
    let s = ok(fresh(), 'publishBehavior', SPIN).state;
    s = ok(s, 'setBehaviorProperties', { entityId: 'box-0001', behaviorId: 'spinner', values: {} }).state;
    s = ok(s, 'createPrefab', { prefabId: 'turret', displayName: 'Turret', sourceEntityId: 'box-0001' }).state;
    s = ok(s, 'setBehaviorProperties', { entityId: 'box-0001', behaviorId: null }).state;
    const inPrefab = refused(s, 'deleteBehavior', { behaviorId: 'spinner' });
    expect(inPrefab.code).toBe('reference_in_use');
    expect(inPrefab.details?.some((d) => /^\/prefabs\//.test(d.path ?? ''))).toBe(true);

    expect(refused(s, 'deleteBehavior', { behaviorId: 'nothing' }).code).toBe('field_value');
    expect(refused(s, 'deleteBehavior', { behaviorId: 'spinner', extra: 1 }).code).toBe('field_unexpected');
  });
});

describe('revokeBehaviorTrust', () => {
  it('is refused while a published script uses the source or the library version, revokes after the script is gone', () => {
    const { s, library } = withPublished();
    const source = refused(s, 'revokeBehaviorTrust', { sourceDigest: SOURCE });
    expect(source.code).toBe('reference_in_use');
    expect(source.message).toContain('script user');
    expect(refused(s, 'revokeBehaviorTrust', { sourceDigest: library }).message).toContain('library rules');

    const gone = ok(s, 'deleteBehavior', { behaviorId: 'user' }).state;
    const revoked = ok(gone, 'revokeBehaviorTrust', { sourceDigest: SOURCE });
    const change = revoked.change as AcknowledgeBehaviorTrustChange;
    expect(change.type).toBe('acknowledgeBehaviorTrust');
    expect(change.next.map((e) => e.sourceDigest)).toEqual([library]);
    expect(trusted(revoked.state)).toEqual([library]);
    // Revoked once: the same digest is not acknowledged any more.
    expect(refused(revoked.state, 'revokeBehaviorTrust', { sourceDigest: SOURCE }).code).toBe('field_value');
    // Its next publication asks for it again.
    const again = ok(revoked.state, 'publishBehavior', { behaviorId: 'user', displayName: 'User', mode: 'declaration-create', declaration: { properties: [] } }).state;
    expect(refused(again, 'publishBehavior', { behaviorId: 'user', displayName: 'User', mode: 'source', declaration: { properties: [] }, source: { sourceDigest: SOURCE, sourceByteLength: 300 } }).code).toBe('behavior_trust_unacknowledged');

    // One undo puts the entry back.
    expect(trusted(ok(revoked.state, 'undo', {}).state).sort()).toEqual([SOURCE, library].sort());
  });

  it('queryBehaviors includeTrust lists every acknowledged source', () => {
    const { s, library } = withPublished();
    const q = queryBehaviors(s, { op: 'queryBehaviors', projectId: BEFORE.projectId, args: { includeTrust: true } }) as { ok: true; trust: readonly { sourceDigest: string; acknowledgedRevision: number }[] };
    expect(q.ok).toBe(true);
    expect(q.trust.map((e) => e.sourceDigest).sort()).toEqual([SOURCE, library].sort());
    expect(q.trust.every((e) => Number.isInteger(e.acknowledgedRevision))).toBe(true);
    const plain = queryBehaviors(s, { op: 'queryBehaviors', projectId: BEFORE.projectId, args: {} }) as { trust?: unknown };
    expect(plain.trust).toBeUndefined();
  });
});
