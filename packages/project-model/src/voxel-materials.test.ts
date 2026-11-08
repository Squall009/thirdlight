/**
 * The material record's physics, game data and voxel use, through the real
 * content validator and canonicalizer (the path every load and command
 * takes): every new field kept after a canonical round trip, refusals at the
 * record and across the list (voxel_id_taken, kit_missing, a missing
 * profile), instance inheritance down the longest chain, the shader family
 * as a derived read, the profiles, and the kit binding the piece table is
 * built from (the voxel package's real table). Logs the record bytes and the
 * load of a project with every voxel id used.
 */
import { describe, expect, it } from 'vitest';
import { NO_KIT, worldPieceTable } from '@thirdlight/voxel';

import { validateContentV4 } from './content';
import { MAX_MATERIAL_INSTANCE_DEPTH, resolveMaterial, type MaterialDef } from './materials';
import { materialProfilesOf, PHYSICAL_DEFAULTS, resolveMaterialPhysical, withResolvedPhysics, type MaterialProfile } from './material-profiles';
import { boundVoxelKits, materialFamilyOf, VOXEL_MATERIAL_LIMITS, voxelSurfaceSet } from './voxel-materials';
import type { VoxelKit } from './voxel-kit';

type Obj = Record<string, unknown>;

const KIT: VoxelKit = { kitFormat: 1, voxelKitId: 'log', name: 'Log', version: 1, materialType: 'wood', slots: {} };
const STONE_KIT: VoxelKit = { kitFormat: 1, voxelKitId: 'stone', name: 'Stone', version: 1, materialType: 'stone', materials: [5, 7], slots: {} };

// A real project's asset record (the starter fixture's model), made a texture.
const SAMPLE = JSON.parse(
  Object.values(import.meta.glob('../../../fixtures/upgrade/starter-v3.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>)[0] as string,
) as { content: { assets: Obj[] } };
const MODEL_ASSET = SAMPLE.content.assets.find((a) => a['kind'] === 'model')!;
const V0 = (MODEL_ASSET['versions'] as Obj[])[0]!;
const TEXTURES = ['tex-a', 'tex-n', 'tex-o', 'tex-f'].map((assetId) => ({ ...MODEL_ASSET, assetId, kind: 'texture', displayName: assetId, versions: [{ ...V0, importRecipe: { profile: 'image', recipeVersion: 1, toolchain: { 'asset-pipeline': '0.1.0' } }, metrics: { format: 'png', width: 64, height: 64, decodedBytes: 16384 } }] }));

/** Every new field of a material record, set. */
const OAK: MaterialDef = {
  materialId: 'oak',
  name: 'Oak',
  shader: 'standard',
  params: {},
  textures: {},
  physical: { profile: 'wood', density: 650, friction: 0.55, restitution: 0.2, flowRate: 0 },
  gameData: { footstep: 'wood', break: { hits: 3 } },
  voxel: { id: 12, use: 'construction', kit: 'log', tileMetres: 4, heightDepth: 0.03, surfaces: { wall: { albedoHeight: 'tex-a', normal: 'tex-n', orm: 'tex-o' }, floor: { albedoHeight: 'tex-f' } } },
};

function content(extra: Obj = {}): Obj {
  return { assets: TEXTURES, prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, scenes: [{ sceneId: 'main', name: 'Main' }], startScenes: ['main'], voxelKits: [KIT, STONE_KIT], ...extra };
}

function load(extra: Obj): { ok: true; content: Obj } | { ok: false; errors: Array<{ code: string; path: string; message: string }> } {
  const r = validateContentV4(content(extra));
  return r.ok ? { ok: true, content: r.normalized as unknown as Obj } : { ok: false, errors: r.errors as never };
}
function loaded(extra: Obj): Obj {
  const r = load(extra);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.content;
}
function refused(extra: Obj): { code: string; path: string } {
  const r = load(extra);
  expect(r.ok).toBe(false);
  return (r as { errors: Array<{ code: string; path: string }> }).errors[0]!;
}

describe('the material record', () => {
  it('keeps every new optional field through the canonical round trip (field order fixed, game data keys sorted), and the profiles', () => {
    // Given out of canonical order, with an empty surface set and an empty physical block on another material.
    const shuffled = { voxel: { surfaces: { floor: { albedoHeight: 'tex-f' }, ceiling: {}, wall: { orm: 'tex-o', normal: 'tex-n', albedoHeight: 'tex-a' } }, heightDepth: 0.03, tileMetres: 4, kit: 'log', use: 'construction', id: 12 }, gameData: { break: { hits: 3 }, footstep: 'wood' }, physical: { flowRate: 0, restitution: 0.2, friction: 0.55, density: 650, profile: 'wood' }, textures: {}, params: {}, shader: 'standard', name: 'Oak', materialId: 'oak' };
    const plain = { materialId: 'plain', name: 'Plain', shader: 'standard', params: {}, textures: {}, physical: {} };
    const profile: MaterialProfile = { profileId: 'oak-wood', name: 'Oak wood', density: 700, friction: 0.6, restitution: 0.2, flowRate: 0, gameData: { z: 1, a: 2 } };
    const c = loaded({ materials: [shuffled, plain], materialProfiles: [{ gameData: { z: 1, a: 2 }, flowRate: 0, restitution: 0.2, friction: 0.6, density: 700, name: 'Oak wood', profileId: 'oak-wood' }] });
    const [oak, kept] = c['materials'] as Obj[];
    expect(Object.keys(oak!)).toEqual(['materialId', 'name', 'shader', 'params', 'textures', 'physical', 'gameData', 'voxel']);
    expect(Object.keys(oak!['physical'] as Obj)).toEqual(['profile', 'density', 'friction', 'restitution', 'flowRate']);
    expect(Object.keys(oak!['gameData'] as Obj)).toEqual(['break', 'footstep']);
    expect(Object.keys(oak!['voxel'] as Obj)).toEqual(['id', 'use', 'kit', 'tileMetres', 'heightDepth', 'surfaces']);
    expect(Object.keys((oak!['voxel'] as Obj)['surfaces'] as Obj)).toEqual(['wall', 'floor']);
    expect(Object.keys(((oak!['voxel'] as Obj)['surfaces'] as Obj)['wall'] as Obj)).toEqual(['albedoHeight', 'normal', 'orm']);
    expect(oak).toEqual(OAK);
    // An empty physical block says nothing: left out.
    expect(kept).toEqual({ materialId: 'plain', name: 'Plain', shader: 'standard', params: {}, textures: {} });
    expect(c['materialProfiles']).toEqual([{ ...profile, gameData: { a: 2, z: 1 } }]);
    expect(Object.keys((c['materialProfiles'] as Obj[])[0]!)).toEqual(['profileId', 'name', 'density', 'friction', 'restitution', 'flowRate', 'gameData']);
    // The canonical block loads to itself.
    expect(JSON.stringify(loaded({ materials: c['materials'], materialProfiles: c['materialProfiles'] })['materials'])).toBe(JSON.stringify(c['materials']));
    console.log(`[material record] all fields: ${JSON.stringify(OAK).length} bytes compact; without the new parts ${JSON.stringify({ ...OAK, physical: undefined, gameData: undefined, voxel: undefined }).length}`);
  });

  it('refuses bad shapes: unknown fields at every level, ids, uses, ranges, a liquid with a kit, a root without a use', () => {
    const m = (patch: Obj): Obj => ({ materials: [{ ...OAK, ...patch }] });
    expect(refused(m({ voxel: { ...OAK.voxel, colour: 1 } }))).toMatchObject({ code: 'field_unexpected', path: '/materials/0/voxel/colour' });
    expect(refused(m({ physical: { mass: 2 } }))).toMatchObject({ code: 'field_unexpected', path: '/materials/0/physical/mass' });
    expect(refused(m({ voxel: { ...OAK.voxel, surfaces: { roof: {} } } }))).toMatchObject({ code: 'field_unexpected', path: '/materials/0/voxel/surfaces/roof' });
    expect(refused(m({ voxel: { ...OAK.voxel, surfaces: { wall: { height: 'tex-a' } } } }))).toMatchObject({ code: 'field_unexpected', path: '/materials/0/voxel/surfaces/wall/height' });
    for (const id of [0, VOXEL_MATERIAL_LIMITS.idMax + 1, 1.5]) expect(refused(m({ voxel: { id, use: 'terrain' } }))).toMatchObject({ code: 'field_value', path: '/materials/0/voxel/id' });
    expect(refused(m({ voxel: { use: 'terrain' } }))).toMatchObject({ code: 'field_missing', path: '/materials/0/voxel/id' });
    expect(refused(m({ voxel: { id: 3 } }))).toMatchObject({ code: 'field_missing', path: '/materials/0/voxel/use' });
    expect(refused(m({ voxel: { id: 3, use: 'lava' } }))).toMatchObject({ code: 'field_value', path: '/materials/0/voxel/use' });
    expect(refused(m({ voxel: { id: 3, use: 'terrain', heightDepth: VOXEL_MATERIAL_LIMITS.heightDepthMax + 0.01 } }))).toMatchObject({ code: 'field_value', path: '/materials/0/voxel/heightDepth' });
    expect(refused(m({ voxel: { id: 3, use: 'terrain', tileMetres: 0.25 } }))).toMatchObject({ code: 'field_value', path: '/materials/0/voxel/tileMetres' });
    expect(refused(m({ voxel: { id: 3, use: 'liquid', kit: 'log' } }))).toMatchObject({ code: 'field_value', path: '/materials/0/voxel/kit' });
    expect(refused(m({ physical: { density: 0 } }))).toMatchObject({ code: 'field_value', path: '/materials/0/physical/density' });
    expect(refused(m({ physical: { restitution: 1.5 } }))).toMatchObject({ code: 'field_value', path: '/materials/0/physical/restitution' });
    expect(refused(m({ gameData: { f: () => 1 } }))).toMatchObject({ code: 'field_value', path: '/materials/0/gameData' });
    // A texture set map names a texture asset of the project.
    expect(refused(m({ voxel: { ...OAK.voxel, surfaces: { wall: { albedoHeight: 'no-such-texture' } } } }))).toMatchObject({ code: 'asset_reference_missing', path: '/materials/0/voxel/surfaces/wall/albedoHeight' });
    expect(refused({ materialProfiles: [{ profileId: 'x', name: 'X', grip: 1 }] })).toMatchObject({ code: 'field_unexpected', path: '/materialProfiles/0/grip' });
    expect(refused({ materialProfiles: [{ profileId: 'x', name: 'X' }, { profileId: 'x', name: 'Y' }] })).toMatchObject({ code: 'id_duplicate', path: '/materialProfiles/1/profileId' });
  });

  it('refuses across the list: a voxel id used twice (voxel_id_taken), a kit the project lacks (kit_missing), a profile it lacks', () => {
    const twin = { ...OAK, materialId: 'pine', name: 'Pine' };
    expect(refused({ materials: [OAK, twin] })).toMatchObject({ code: 'voxel_id_taken', path: '/materials/1/voxel/id' });
    expect(refused({ materials: [{ ...OAK, voxel: { ...OAK.voxel, kit: 'brick' } }] })).toMatchObject({ code: 'kit_missing', path: '/materials/0/voxel/kit' });
    // The kit the material names is gone with the kit list.
    expect(refused({ materials: [OAK], voxelKits: [STONE_KIT] })).toMatchObject({ code: 'kit_missing', path: '/materials/0/voxel/kit' });
    expect(refused({ materials: [{ ...OAK, physical: { profile: 'bamboo' } }] })).toMatchObject({ code: 'reference_missing', path: '/materials/0/physical/profile' });
    // A project profile is a profile; an engine one needs no record.
    expect(load({ materials: [{ ...OAK, physical: { profile: 'bamboo' } }], materialProfiles: [{ profileId: 'bamboo', name: 'Bamboo', density: 400 }] }).ok).toBe(true);
    // A mesh variant (no voxel part of its own) does not take its parent's id; a voxel variant with the same id does.
    const mesh = { materialId: 'oak-prop', name: 'Oak prop', shader: 'standard', params: {}, textures: {}, instanceOf: 'oak' };
    expect(load({ materials: [OAK, mesh] }).ok).toBe(true);
    expect(refused({ materials: [OAK, { ...mesh, voxel: { id: 12 } }] })).toMatchObject({ code: 'voxel_id_taken', path: '/materials/1/voxel/id' });
    expect(load({ materials: [OAK, { ...mesh, voxel: { id: 13 } }] }).ok).toBe(true);
  });

  it('an instance inherits physics, game data and voxel fields down the longest chain and overrides any; a voxel variant has its own id', () => {
    const chain: MaterialDef[] = [OAK];
    for (let i = 1; i <= MAX_MATERIAL_INSTANCE_DEPTH; i++) chain.push({ materialId: `oak-${i}`, name: `Oak ${i}`, shader: 'standard', params: {}, textures: {}, instanceOf: chain[i - 1]!.materialId });
    // The second level changes the friction and adds a game data key; the last is a voxel variant with its own tile and floor albedo.
    chain[2] = { ...chain[2]!, physical: { friction: 0.9 }, gameData: { stain: 'dark' } };
    const last = chain.length - 1;
    chain[last] = { ...chain[last]!, voxel: { id: 40, tileMetres: 2, surfaces: { floor: { albedoHeight: 'tex-a' } } } };
    const c = loaded({ materials: chain });
    const stored = c['materials'] as MaterialDef[];
    const variant = resolveMaterial(stored, `oak-${MAX_MATERIAL_INSTANCE_DEPTH}`)!;
    expect(variant.physical).toEqual({ profile: 'wood', density: 650, friction: 0.9, restitution: 0.2, flowRate: 0 });
    expect(variant.gameData).toEqual({ footstep: 'wood', break: { hits: 3 }, stain: 'dark' });
    expect(variant.voxel).toEqual({ id: 40, use: 'construction', kit: 'log', tileMetres: 2, heightDepth: 0.03, surfaces: { wall: OAK.voxel!.surfaces!.wall, floor: { albedoHeight: 'tex-a' } } });
    // A level between without a voxel part of its own is a mesh variant: no voxel use.
    expect(resolveMaterial(stored, 'oak-3')!.voxel).toBeUndefined();
    expect(voxelSurfaceSet(variant.voxel!, 'ceiling')).toEqual(OAK.voxel!.surfaces!.wall);
    // One more level is past the depth bound.
    expect(refused({ materials: [...chain, { materialId: 'oak-x', name: 'X', shader: 'standard', params: {}, textures: {}, instanceOf: chain[last]!.materialId }] })).toMatchObject({ code: 'limits_exceeded' });
  });

  it('derives the shader family from shader, graph and voxel use (no new shader types)', () => {
    const base = { materialId: 'm', name: 'M', params: {}, textures: {} };
    expect(materialFamilyOf({ ...base, shader: 'standard' })).toBe('standard');
    expect(materialFamilyOf({ ...base, shader: 'foliage' })).toBe('standard');
    expect(materialFamilyOf(OAK)).toBe('projected');
    expect(materialFamilyOf({ ...base, shader: 'standard', voxel: { id: 2, use: 'terrain' } })).toBe('projected');
    expect(materialFamilyOf({ ...base, shader: 'standard', voxel: { id: 2, use: 'liquid' } })).toBe('liquid');
    expect(materialFamilyOf({ ...base, shader: 'water' })).toBe('liquid');
    expect(materialFamilyOf({ ...base, shader: 'decal' })).toBe('decal');
    expect(materialFamilyOf({ ...base, shader: 'standard', graph: { nodes: [], edges: [] }, voxel: { id: 2, use: 'terrain' } })).toBe('graph');
  });

  it('resolves physics: own numbers over the profile over the defaults; a project profile overrides an engine one field by field', () => {
    const engine = materialProfilesOf(undefined);
    expect(resolveMaterialPhysical(undefined, engine)).toEqual(PHYSICAL_DEFAULTS);
    expect(resolveMaterialPhysical({ profile: 'water' }, engine)).toEqual({ profile: 'water', density: 1000, friction: 0, restitution: 0, flowRate: 1 });
    expect(resolveMaterialPhysical({ profile: 'stone', friction: 0.2 }, engine)).toEqual({ profile: 'stone', density: 2500, friction: 0.2, restitution: 0.1 });
    const project = materialProfilesOf([{ profileId: 'wood', name: 'Wood', density: 500, gameData: { footstep: 'creak' } }]);
    expect(resolveMaterialPhysical({ profile: 'wood' }, project)).toEqual({ profile: 'wood', density: 500, friction: 0.6, restitution: 0.2 });
    // A build ships it resolved, the profile's game data under the material's own keys.
    const [shipped] = withResolvedPhysics([{ ...OAK, physical: { profile: 'wood' }, gameData: { break: { hits: 3 } } }], [{ profileId: 'wood', name: 'Wood', gameData: { footstep: 'creak', break: { hits: 1 } } }]);
    expect(shipped!.physical).toEqual({ profile: 'wood', density: 700, friction: 0.6, restitution: 0.2 });
    expect(shipped!.gameData).toEqual({ footstep: 'creak', break: { hits: 3 } });
  });

  it('binds kits from the material records, the kit list only for ids no record names; the piece table reads it', () => {
    const terrain = { materialId: 'granite', name: 'Granite', shader: 'standard' as const, params: {}, textures: {}, voxel: { id: 5, use: 'terrain' as const } };
    const water = { materialId: 'water', name: 'Water', shader: 'water' as const, params: {}, textures: {}, voxel: { id: 9, use: 'liquid' as const } };
    const c = loaded({ materials: [OAK, terrain, water, { ...OAK, materialId: 'oak-v', name: 'Oak variant', instanceOf: 'oak', voxel: { id: 14, kit: 'stone' } }] });
    const kits = boundVoxelKits([KIT, STONE_KIT], c['materials'] as MaterialDef[]);
    // log: oak's 12; stone: the variant's 14 and its own list's 7 (5 is granite's record, which names no kit).
    expect(kits.map((k) => [k.voxelKitId, k.materials])).toEqual([['log', [12]], ['stone', [7, 14]]]);
    const table = worldPieceTable(kits, 0);
    const kitOf = (m: number): string | null => (table.materialKit[m] === NO_KIT ? null : table.kits[table.materialKit[m]!]!.id);
    expect([12, 14, 7, 5, 9, 3].map(kitOf)).toEqual(['log', 'stone', 'stone', null, null, null]);
    // Without material records the kits bind as before (kit format 1's list).
    expect(boundVoxelKits([KIT, STONE_KIT], [])).toEqual([KIT, STONE_KIT]);
  });

  it('loads a project with every voxel id given a material (record bytes and validate + canonical ms logged)', () => {
    const materials = Array.from({ length: VOXEL_MATERIAL_LIMITS.idMax }, (_, i) => ({ ...OAK, materialId: `m-${String(i + 1).padStart(4, '0')}`, name: `Material ${i + 1}`, voxel: { ...OAK.voxel!, id: i + 1, kit: i % 2 === 0 ? 'log' : 'stone' } }));
    const doc = content({ materials });
    const t0 = performance.now();
    const r = validateContentV4(doc);
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    // An edit of one material on the trusted block (what a command does).
    const prev = (r as unknown as { normalized: Obj }).normalized;
    const edited = { ...prev, materials: (prev['materials'] as MaterialDef[]).map((m, i) => (i === 100 ? { ...m, voxel: { ...m.voxel!, heightDepth: 0.05 } } : m)) };
    const t1 = performance.now();
    expect(validateContentV4(edited, prev).ok).toBe(true);
    const editMs = performance.now() - t1;
    const bytes = JSON.stringify((prev['materials'] as Obj[])[0]).length;
    console.log(`[material record] ${materials.length} voxel materials: load (validate + canonical) ${ms.toFixed(0)} ms, one edit ${editMs.toFixed(1)} ms; a record ${bytes} bytes compact, ${((bytes * materials.length) / 1024 / 1024).toFixed(2)} MB the list`);
  });
});
