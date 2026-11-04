/**
 * Voxel kits through the commands: `setVoxelKit` (create, replace, canonical
 * form, an unchanged kit refused as no change), `deleteVoxelKit`, one undo
 * step each and redo; refused shapes (a newer format, unknown fields) change
 * nothing; the asset a kit's mesh names is not held by it (a delete names
 * only its other uses); a voxel kit has no address or labels.
 */
import { describe, expect, it } from 'vitest';
import type { SceneV4, VoxelKit } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, SetVoxelKitChange } from './index';
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
    requestId: `req-${(0x46c10 + counter).toString(16).padStart(32, '0')}`,
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
const kits = (s: State): VoxelKit[] => (s.content as { voxelKits?: VoxelKit[] }).voxelKits ?? [];
const MODEL = 'asset-2b11d4a76c9f0e35';
const DIGEST = 'c'.repeat(64);

// Cases out of order and a weight of 1: canonical form sorts the cases and leaves the weight out.
const KIT: VoxelKit = {
  kitFormat: 1,
  voxelKitId: 'log',
  name: 'Log',
  version: 1,
  materialType: 'wood',
  materials: [7, 2],
  cases: {
    'wall-banister': { sections: { body: { variants: [{ high: { assetId: MODEL, digest: DIGEST, node: 'Rail' }, weight: 1 }] } }, gameData: { hits: 2 } },
    beam: { sections: { body: { variants: [{ high: { assetId: MODEL, digest: DIGEST, node: 'Beam' } }] } } },
  },
};

describe('voxel kit commands', () => {
  it('creates a kit in canonical form, replaces and deletes it, each one undo step, and redoes', () => {
    const created = ok(fresh(), 'setVoxelKit', { kit: KIT });
    const change = created.change as SetVoxelKitChange;
    expect(change).toMatchObject({ type: 'setVoxelKit', voxelKitId: 'log', previous: null });
    expect(JSON.stringify(kits(created.state))).toBe(
      JSON.stringify([
        {
          kitFormat: 1,
          voxelKitId: 'log',
          name: 'Log',
          version: 1,
          materialType: 'wood',
          materials: [2, 7],
          cases: {
            beam: { sections: { body: { variants: [{ high: { assetId: MODEL, digest: DIGEST, node: 'Beam' } }] } } },
            'wall-banister': { sections: { body: { variants: [{ high: { assetId: MODEL, digest: DIGEST, node: 'Rail' } }] } }, gameData: { hits: 2 } },
          },
        },
      ]),
    );
    expect(change.next).toEqual(kits(created.state)[0]);
    expect(refused(created.state, 'setVoxelKit', { kit: KIT }).code).toBe('no_change');

    const bumped = ok(created.state, 'setVoxelKit', { kit: { ...KIT, version: 2, gameData: { sound: 'wood' } } });
    expect((bumped.change as SetVoxelKitChange).previous?.version).toBe(1);
    expect(kits(bumped.state)[0]).toMatchObject({ version: 2, gameData: { sound: 'wood' } });
    const undone = ok(bumped.state, 'undo', {}).state;
    expect(kits(undone)[0]!.version).toBe(1);
    expect(kits(undone)[0]!.gameData).toBeUndefined();
    expect(kits(ok(undone, 'redo', {}).state)[0]!.version).toBe(2);

    const deleted = ok(bumped.state, 'deleteVoxelKit', { voxelKitId: 'log' });
    expect((deleted.change as SetVoxelKitChange).next).toBeNull();
    expect((deleted.state.content as unknown as Record<string, unknown>)['voxelKits']).toBeUndefined();
    expect(kits(ok(deleted.state, 'undo', {}).state)[0]!.version).toBe(2);
    expect(refused(deleted.state, 'deleteVoxelKit', { voxelKitId: 'log' }).code).toBe('reference_missing');
  });

  it('refuses a newer format, unknown fields and malformed arguments, and changes nothing', () => {
    const s = fresh();
    expect(refused(s, 'setVoxelKit', { kit: { ...KIT, kitFormat: 2 } })).toMatchObject({ code: 'kit_format_unsupported', path: '/args/kit/kitFormat' });
    expect(refused(s, 'setVoxelKit', { kit: { ...KIT, pieces: {} } })).toMatchObject({ code: 'field_unexpected', path: '/args/kit/pieces' });
    expect(refused(s, 'setVoxelKit', { kit: { ...KIT, cases: { beam: { sections: { body: { variants: [] } } } } } }).path).toBe('/args/kit/cases/beam/sections/body/variants');
    expect(refused(s, 'setVoxelKit', { kit: KIT, extra: 1 }).code).toBe('field_unexpected');
    expect(refused(s, 'setVoxelKit', {}).code).toBe('field_missing');
    expect(refused(s, 'deleteVoxelKit', { voxelKitId: 7 }).code).toBe('field_type');
  });

  it("two kits by id; a kit's meshes never hold their asset; a voxel kit has no address or labels", () => {
    const s0 = ok(ok(fresh(), 'setVoxelKit', { kit: { ...KIT, voxelKitId: 'stone', materialType: 'stone' } }).state, 'setVoxelKit', { kit: KIT }).state;
    expect(kits(s0).map((k) => k.voxelKitId)).toEqual(['log', 'stone']);
    // The model is still placed in the scene: that use is named, the kits' meshes are not (the kit check reports a missing asset).
    const inUse = refused(s0, 'deleteAsset', { assetId: MODEL }) as unknown as { code: string; details: { document: string; path: string }[] };
    expect(inUse.code).toBe('reference_in_use');
    expect(inUse.details.map((d) => d.document)).toEqual(['scene']);
    expect(refused(s0, 'setLabels', { items: [{ kind: 'voxelkit', id: 'log' }], add: ['kits'] }).code).toBeDefined();
    expect(refused(s0, 'setAddress', { kind: 'voxelkit', id: 'log', address: 'kits/log' }).code).toBeDefined();
  });
});
