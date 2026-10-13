/**
 * Kits through the commands: `setKit` (create, replace, canonical form),
 * `deleteKit`, one undo step each and redo; refused shapes change nothing;
 * a kit names its parts without holding them (a part a kit names may be
 * deleted, a missing part is a problem, not a refusal); a block layer and an
 * architecture object name their kit; a kit is never loadable.
 */
import { describe, expect, it } from 'vitest';
import { kitProblems, type KitDef, type SceneV4 } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, SetKitChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, {
    op,
    projectId: BEFORE.projectId,
    expectedRevision: state.scene.revision,
    requestId: `req-${(0x36300 + counter).toString(16).padStart(32, '0')}`,
    args,
  });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change };
}
const refused = (state: State, op: string, args: Record<string, unknown>): { code: string; path?: string; message: string } => {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  expect(r.state).toBe(state);
  return r.result['error'] as { code: string; path?: string; message: string };
};
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const kits = (s: State): KitDef[] => (s.content as { kits?: KitDef[] }).kits ?? [];
const MODEL = 'asset-2b11d4a76c9f0e35';

const KIT: KitDef = {
  kitId: 'town',
  name: 'Town',
  blockTypes: ['wall'],
  // Slots out of order and a weight of 1 (the default): canonical form sorts the slots and leaves the weight out.
  pieces: { window: [{ assetId: MODEL, piece: 'Window_A' }], door: [{ assetId: MODEL, piece: 'Door_A', weight: 3 }, { assetId: MODEL, piece: 'Door_B', weight: 1 }], 'shop-sign': [{ assetId: MODEL }] },
};
const WALL = { blockId: 'wall', name: 'Wall', variants: [{ color: '#808080' }], shape: 'full' };

describe('kit commands', () => {
  it('creates a kit in canonical form, replaces and deletes it, each one undo step, and redoes', () => {
    const s0 = ok(fresh(), 'setBlockType', { block: WALL }).state;
    const created = ok(s0, 'setKit', { kit: KIT });
    const change = created.change as SetKitChange;
    expect(change.type).toBe('setKit');
    expect(change.previous).toBeNull();
    expect(kits(created.state)).toEqual([
      {
        kitId: 'town',
        name: 'Town',
        blockTypes: ['wall'],
        pieces: { door: [{ assetId: MODEL, piece: 'Door_A', weight: 3 }, { assetId: MODEL, piece: 'Door_B' }], 'shop-sign': [{ assetId: MODEL }], window: [{ assetId: MODEL, piece: 'Window_A' }] },
      },
    ]);
    expect(Object.keys(kits(created.state)[0]!.pieces!)).toEqual(['door', 'shop-sign', 'window']);
    expect(refused(created.state, 'setKit', { kit: KIT }).code).toBe('no_change');

    const renamed = ok(created.state, 'setKit', { kit: { ...KIT, name: 'Old town', description: 'Cobbles and plaster' } });
    expect((renamed.change as SetKitChange).previous?.name).toBe('Town');
    expect(kits(renamed.state)[0]).toMatchObject({ name: 'Old town', description: 'Cobbles and plaster' });
    const undone = ok(renamed.state, 'undo', {}).state;
    expect(kits(undone)[0]!.name).toBe('Town');
    expect(kits(ok(undone, 'redo', {}).state)[0]!.name).toBe('Old town');

    const deleted = ok(renamed.state, 'deleteKit', { kitId: 'town' });
    expect((deleted.change as SetKitChange).next).toBeNull();
    expect(kits(deleted.state)).toEqual([]);
    expect((deleted.state.content as unknown as Record<string, unknown>)['kits']).toBeUndefined();
    expect(kits(ok(deleted.state, 'undo', {}).state)[0]!.name).toBe('Old town');
    expect(refused(deleted.state, 'deleteKit', { kitId: 'town' }).code).toBe('reference_missing');
  });

  it('refuses a malformed kit or argument and changes nothing', () => {
    const s = fresh();
    expect(refused(s, 'setKit', { kit: { ...KIT, colour: 'red' } }).code).toBe('field_unexpected');
    expect(refused(s, 'setKit', { kit: { ...KIT, kitId: 'Town!' } }).code).toBe('id_invalid');
    expect(refused(s, 'setKit', { kit: { ...KIT, name: '' } }).code).toBe('field_value');
    expect(refused(s, 'setKit', { kit: { ...KIT, pieces: { 'Front Door': [{ assetId: MODEL }] } } }).path).toBe('/args/kit/pieces/Front Door');
    expect(refused(s, 'setKit', { kit: { ...KIT, pieces: { door: [] } } }).code).toBe('field_value');
    expect(refused(s, 'setKit', { kit: { ...KIT, pieces: { door: Array.from({ length: 9 }, () => ({ assetId: MODEL })) } } }).code).toBe('field_value');
    expect(refused(s, 'setKit', { kit: { ...KIT, pieces: { door: [{ assetId: MODEL, weight: 0 }] } } }).code).toBe('field_value');
    expect(refused(s, 'setKit', { kit: { ...KIT, presets: ['a', 'a'] } }).code).toBe('id_duplicate');
    expect(refused(s, 'setKit', { kit: KIT, extra: 1 }).code).toBe('field_unexpected');
    expect(refused(s, 'setKit', {}).code).toBe('field_missing');
    expect(refused(s, 'deleteKit', { kitId: 7 }).code).toBe('field_type');
  });

  it('names its parts without holding them: a part it names may be deleted, and is then a problem', () => {
    const s0 = ok(fresh(), 'setBlockType', { block: WALL }).state;
    // A kit may name parts the project does not have yet (a trim material, a preset): stored, reported.
    const s1 = ok(s0, 'setKit', { kit: { ...KIT, trimMaterial: 'stone-trim', presets: ['town-house'] } }).state;
    expect(kitProblems(s1.content as never)[0]!.problems).toEqual(['its trim material "stone-trim" is not in the project', 'preset "town-house" is not in the project']);
    const after = ok(s1, 'deleteBlockType', { blockId: 'wall' }).state;
    expect(kits(after)[0]!.blockTypes).toEqual(['wall']);
    const rows = kitProblems(after.content as never);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.problems).toEqual(expect.arrayContaining(['its trim material "stone-trim" is not in the project', 'preset "town-house" is not in the project', 'block type "wall" is not in the project']));
  });

  it('a block layer and an architecture object may name their kit; a kit has no address or labels', () => {
    const s0 = ok(fresh(), 'setKit', { kit: { kitId: 'town', name: 'Town' } }).state;
    const layer = { cellSize: [1, 1, 1], bounds: { min: [0, 0, 0], max: [8, 4, 8] }, kitId: 'town' };
    const s1 = ok(s0, 'setComponent', { entityId: 'group-0000', component: 'blockLayer', value: layer }).state;
    expect((s1.scene.entities.find((e) => e.id === 'group-0000')!.components as unknown as Record<string, { kitId?: string }>)['blockLayer']!.kitId).toBe('town');
    expect(refused(s0, 'setComponent', { entityId: 'group-0000', component: 'blockLayer', value: { ...layer, kitId: 'Town Kit' } }).code).toBe('id_invalid');
    const s2 = ok(s0, 'setComponent', { entityId: 'group-0000', component: 'architecture', value: { elements: [], kitId: 'town' } }).state;
    expect((s2.scene.entities.find((e) => e.id === 'group-0000')!.components as unknown as Record<string, { kitId?: string }>)['architecture']!.kitId).toBe('town');
    expect(refused(s0, 'setLabels', { items: [{ kind: 'kit', id: 'town' }], add: ['styles'] }).code).toBeDefined();
    expect(refused(s0, 'setAddress', { kind: 'kit', id: 'town', address: 'kits/town' }).code).toBeDefined();
  });
});
