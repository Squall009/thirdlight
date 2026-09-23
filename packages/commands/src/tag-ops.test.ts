/**
 * Phase 12 (b): the tag registry (`setTags`) and entity tags
 * (`updateEntity {tags}`), with undo/redo.
 */

import { describe, expect, it } from 'vitest';
import type { SceneV3 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, ContentDocument, MutationSuccess, UpdateEntityChange } from './index';
import { m3ContractJson } from './test-fixtures';

interface EnvelopeFixture {
  projectId: string;
  scene: SceneV3;
  content: ContentDocument;
}

const BEFORE = m3ContractJson<EnvelopeFixture>('commands/scenario.before.json');
type State = CommandState<SceneV3>;

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x7a900 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: (out as { state?: State }).state ?? state, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; id: string; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return { state: r.state, id: String(r.result.createdId ?? ''), change: (r.result as unknown as MutationSuccess).change };
}
const fresh = (): State =>
  createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content) as unknown as ContentDocument) as unknown as State;
const registry = (s: State) => (s.content as ContentDocument).tags ?? [];
const tagsOf = (s: State, id: string) => (s.scene.entities.find((e) => e.id === id) as { tags?: number }).tags;

describe('setTags', () => {
  it('new names take the lowest free bits; a rename keeps the bit; undo/redo restore the registry', () => {
    let s = ok(fresh(), 'setTags', { tags: [{ name: 'enemy' }, { name: 'pickup' }] }).state;
    expect(registry(s)).toEqual([{ bit: 0, name: 'enemy' }, { bit: 1, name: 'pickup' }]);
    s = ok(s, 'setTags', { tags: [{ bit: 0, name: 'foe' }, { bit: 1, name: 'pickup' }, { name: 'water' }] }).state;
    expect(registry(s)).toEqual([{ bit: 0, name: 'foe' }, { bit: 1, name: 'pickup' }, { bit: 2, name: 'water' }]);
    const undone = ok(s, 'undo', {}).state;
    expect(registry(undone)).toEqual([{ bit: 0, name: 'enemy' }, { bit: 1, name: 'pickup' }]);
    expect(registry(ok(undone, 'redo', {}).state)).toEqual(registry(s));
  });

  it('refuses a duplicate name (ignoring case), a bad name, a bad bit and more than 32 tags', () => {
    const s = fresh();
    expect(run(s, 'setTags', { tags: [{ name: 'Enemy' }, { name: 'enemy' }] }).result.ok).toBe(false);
    expect(run(s, 'setTags', { tags: [{ name: '9lives' }] }).result.ok).toBe(false);
    expect(run(s, 'setTags', { tags: [{ bit: 32, name: 'x' }] }).result.ok).toBe(false);
    expect(run(s, 'setTags', { tags: Array.from({ length: 33 }, (_, i) => ({ name: `t${i}` })) }).result.ok).toBe(false);
    expect(run(s, 'setTags', { tags: Array.from({ length: 32 }, (_, i) => ({ name: `t${i}` })) }).result.ok).toBe(true);
  });

  it('a bit is freed only when no entity carries it', () => {
    let s = ok(fresh(), 'setTags', { tags: [{ name: 'enemy' }, { name: 'pickup' }] }).state;
    const box = ok(s, 'createEntity', { kind: 'box', name: 'crate' });
    s = ok(box.state, 'updateEntity', { entityId: box.id, tags: ['pickup'] }).state;
    const refused = run(s, 'setTags', { tags: [{ bit: 0, name: 'enemy' }] });
    expect(refused.result.ok).toBe(false);
    expect(refused.result.error).toMatchObject({ code: 'reference_in_use', reason: 'tag' });
    // Removing the unused one is fine, and its bit is reused by the next new tag.
    s = ok(s, 'setTags', { tags: [{ bit: 1, name: 'pickup' }] }).state;
    s = ok(s, 'setTags', { tags: [{ bit: 1, name: 'pickup' }, { name: 'water' }] }).state;
    expect(registry(s)).toEqual([{ bit: 0, name: 'water' }, { bit: 1, name: 'pickup' }]);
    expect(tagsOf(s, box.id)).toBe(2);
  });
});

describe('updateEntity tags', () => {
  it('sets an entity’s tags by name (stored as the mask), clears them, and undoes', () => {
    let s = ok(fresh(), 'setTags', { tags: [{ name: 'enemy' }, { name: 'pickup' }, { bit: 5, name: 'boss' }] }).state;
    const folder = ok(s, 'createEntity', { kind: 'folder', name: 'Enemies' });
    const set = ok(folder.state, 'updateEntity', { entityId: folder.id, tags: ['ENEMY', 'boss'] });
    expect((set.change as UpdateEntityChange).changedFields).toEqual(['tags']);
    expect(tagsOf(set.state, folder.id)).toBe(1 | (1 << 5));
    s = ok(set.state, 'updateEntity', { entityId: folder.id, tags: [] }).state;
    expect(tagsOf(s, folder.id)).toBeUndefined();
    expect(tagsOf(ok(s, 'undo', {}).state, folder.id)).toBe(33);
  });

  it('refuses an unknown tag name', () => {
    const s = ok(fresh(), 'setTags', { tags: [{ name: 'enemy' }] }).state;
    const cam = s.scene.entities[0]!.id;
    const r = run(s, 'updateEntity', { entityId: cam, tags: ['ghost'] });
    expect(r.result.ok).toBe(false);
    expect((r.result.error as { path: string }).path).toBe('/args/tags/0');
  });
});
