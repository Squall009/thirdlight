/**
 * The material model through the commands: `setMaterial` carrying the
 * physical block, game data and voxel use (canonical, one undo, the
 * cross-list refusals `voxel_id_taken` and `kit_missing` and a missing
 * profile), deleting a kit a material names refused, and the physical
 * profiles' own commands (`setMaterialProfile` / `deleteMaterialProfile`:
 * canonical, one undo each, redo, a profile a material names held).
 */
import { describe, expect, it } from 'vitest';
import type { MaterialDef, MaterialProfile, SceneV4, VoxelKit } from '@thirdlight/project-model';

import { applyMutation, createCommandState } from './index';
import type { CommandState, MutationSuccess, SetMaterialProfileChange } from './index';
import { m2EnvelopeV4 } from './test-fixtures';

const BEFORE = m2EnvelopeV4('contracts/commands/prefab-scenario.before.json');
type State = CommandState<SceneV4>;

let counter = 0;
function run(state: State, op: string, args: Record<string, unknown>): { state: State; result: Record<string, unknown> } {
  counter += 1;
  const out = applyMutation(state, { op, projectId: BEFORE.projectId, expectedRevision: state.scene.revision, requestId: `req-${(0x46d3a0 + counter).toString(16).padStart(32, '0')}`, args });
  return { state: ((out as { state?: State }).state ?? state) as State, result: out.result as unknown as Record<string, unknown> };
}
function ok(state: State, op: string, args: Record<string, unknown>): { state: State; change: unknown } {
  const r = run(state, op, args);
  expect(r.result.ok, JSON.stringify(r.result)).toBe(true);
  return { state: r.state, change: (r.result as unknown as MutationSuccess).change };
}
/** The refusal's code and path (a resulting-state refusal carries the model's error in its details). */
function refused(state: State, op: string, args: Record<string, unknown>): { code: string; path?: string } {
  const r = run(state, op, args);
  expect(r.result.ok).toBe(false);
  expect(r.state).toBe(state);
  const e = r.result['error'] as { code: string; path?: string; details?: { code: string; path: string }[] };
  return e.details?.[0] ?? e;
}
const fresh = (): State => createCommandState(structuredClone(BEFORE.scene), structuredClone(BEFORE.content)) as State;
const materials = (s: State): MaterialDef[] => (s.content as { materials?: MaterialDef[] }).materials ?? [];
const profiles = (s: State): MaterialProfile[] => (s.content as { materialProfiles?: MaterialProfile[] }).materialProfiles ?? [];

const KIT: VoxelKit = { kitFormat: 1, voxelKitId: 'log', name: 'Log', version: 1, materialType: 'wood', slots: {} };
const OAK: MaterialDef = {
  materialId: 'oak',
  name: 'Oak',
  shader: 'standard',
  params: {},
  textures: {},
  voxel: { heightDepth: 0.03, kit: 'log', use: 'construction', id: 12 },
  gameData: { footstep: 'wood' },
  physical: { friction: 0.55, profile: 'wood' },
};

describe('material model commands', () => {
  it('setMaterial carries the physical block, game data and voxel use in canonical form, one undo step', () => {
    const s0 = ok(fresh(), 'setVoxelKit', { kit: KIT }).state;
    const made = ok(s0, 'setMaterial', { material: OAK });
    const stored = materials(made.state).find((m) => m.materialId === 'oak')!;
    expect(Object.keys(stored)).toEqual(['materialId', 'name', 'shader', 'params', 'textures', 'physical', 'gameData', 'voxel']);
    expect(stored.voxel).toEqual({ id: 12, use: 'construction', kit: 'log', heightDepth: 0.03 });
    expect(Object.keys(stored.physical!)).toEqual(['profile', 'friction']);
    expect((made.change as { next: MaterialDef }).next).toEqual(stored);
    expect(refused(made.state, 'setMaterial', { material: OAK }).code).toBe('no_change');
    const edited = ok(made.state, 'setMaterial', { material: { ...stored, voxel: { ...stored.voxel!, heightDepth: 0.08 } } });
    expect(materials(ok(edited.state, 'undo', {}).state).find((m) => m.materialId === 'oak')!.voxel!.heightDepth).toBe(0.03);
  });

  it('refuses a voxel id another material has (voxel_id_taken), a kit the project lacks (kit_missing), a profile it lacks, and deleting a kit a material names', () => {
    const s0 = ok(ok(fresh(), 'setVoxelKit', { kit: KIT }).state, 'setMaterial', { material: OAK }).state;
    expect(refused(s0, 'setMaterial', { material: { ...OAK, materialId: 'pine', name: 'Pine' } })).toMatchObject({ code: 'voxel_id_taken' });
    expect(refused(s0, 'setMaterial', { material: { ...OAK, materialId: 'pine', name: 'Pine', voxel: { id: 13, use: 'construction', kit: 'brick' } } })).toMatchObject({ code: 'kit_missing' });
    expect(refused(s0, 'setMaterial', { material: { ...OAK, materialId: 'pine', name: 'Pine', voxel: { id: 13, use: 'construction' }, physical: { profile: 'bamboo' } } })).toMatchObject({ code: 'reference_missing' });
    expect(refused(s0, 'setMaterial', { material: { ...OAK, voxel: { id: 12, use: 'construction', shade: 2 } } })).toMatchObject({ code: 'field_unexpected', path: '/args/material/0/voxel/shade' });
    expect(refused(s0, 'deleteVoxelKit', { voxelKitId: 'log' })).toMatchObject({ code: 'kit_missing' });
    // A voxel variant: an instance with its own id.
    const variant = ok(s0, 'setMaterial', { material: { materialId: 'oak-dark', name: 'Dark oak', shader: 'standard', params: {}, textures: {}, instanceOf: 'oak', voxel: { id: 13 } } });
    expect(materials(variant.state).find((m) => m.materialId === 'oak-dark')!.voxel).toEqual({ id: 13 });
  });

  it('sets, replaces and deletes a project profile, one undo each, redo; a project-only profile a material names is held', () => {
    const made = ok(fresh(), 'setMaterialProfile', { profile: { gameData: { footstep: 'creak' }, restitution: 0.1, density: 400, name: 'Bamboo', profileId: 'bamboo' } });
    expect((made.change as SetMaterialProfileChange)).toMatchObject({ type: 'setMaterialProfile', profileId: 'bamboo', previous: null });
    expect(JSON.stringify(profiles(made.state))).toBe(JSON.stringify([{ profileId: 'bamboo', name: 'Bamboo', density: 400, restitution: 0.1, gameData: { footstep: 'creak' } }]));
    expect(refused(made.state, 'setMaterialProfile', { profile: profiles(made.state)[0]! }).code).toBe('no_change');
    const wood = ok(made.state, 'setMaterialProfile', { profile: { profileId: 'wood', name: 'Wood', density: 600 } });
    expect(profiles(wood.state).map((p) => p.profileId)).toEqual(['bamboo', 'wood']);
    const used = ok(wood.state, 'setMaterial', { material: { ...OAK, voxel: undefined, physical: { profile: 'bamboo' } } });
    expect(refused(used.state, 'deleteMaterialProfile', { profileId: 'bamboo' })).toMatchObject({ code: 'reference_missing' });
    // An engine profile's override may go: the engine's wood remains.
    const back = ok(ok(used.state, 'setMaterial', { material: { ...OAK, voxel: undefined, physical: { profile: 'wood' } } }).state, 'deleteMaterialProfile', { profileId: 'wood' });
    expect((back.change as SetMaterialProfileChange).next).toBeNull();
    expect(profiles(back.state).map((p) => p.profileId)).toEqual(['bamboo']);
    const undone = ok(back.state, 'undo', {}).state;
    expect(profiles(undone).map((p) => p.profileId)).toEqual(['bamboo', 'wood']);
    expect(profiles(ok(undone, 'redo', {}).state).map((p) => p.profileId)).toEqual(['bamboo']);
    expect(refused(back.state, 'deleteMaterialProfile', { profileId: 'stone' }).code).toBe('reference_missing');
    expect(refused(fresh(), 'setMaterialProfile', { profile: { profileId: 'x', name: 'X', density: -1 } })).toMatchObject({ code: 'field_value', path: '/args/profile/density' });
    expect(refused(fresh(), 'setMaterialProfile', { profile: { profileId: 'x', name: 'X' }, extra: 1 }).code).toBe('field_unexpected');
    expect(refused(fresh(), 'deleteMaterialProfile', { profileId: 3 }).code).toBe('field_type');
  });
});
