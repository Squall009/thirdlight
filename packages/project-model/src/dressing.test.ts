/**
 * The dressing asset and `voxel.dressing`, through the real content
 * validator and canonicalizer (the path every load and command takes):
 * every field of format 1 kept after a canonical round trip, bad values
 * refused, a material naming a dressing and an instance naming another, the
 * rules across the list, the recorded schema step on an old project's
 * documents, and what a build and a cover job are handed.
 */
import { describe, expect, it } from 'vitest';
import { DRESSING_CONDITIONS, SURFACE_DISTANCE_CAP_M } from '@thirdlight/voxel';

import { collectAssetRefsV3 } from './capture';
import { validateContentV4 } from './content';
import { canonicalDressing, DRESSING_CLASSES, DRESSING_FORMAT, DRESSING_LIMITS, dressingModels, dressingSpeciesRule, namedDressings, validateDressing, type DressingDef, type DressingSpecies } from './dressing';
import { RESOURCE_KIND_TABLE } from './loadable';
import { resolveMaterial, type MaterialDef } from './materials';
import { projectWideRoots } from './missing-files';
import { validateScatterRules } from './scatter';
import { pendingSchema8Steps, RECORDED_SCHEMA_8_STEPS, SCHEMA_8_STEPS, upgradeToSchema8, withRecordedSteps } from './upgrade-schema-8';
import { voxelCoverTable } from './voxel-dressing-source';
import { voxelDressingIds } from './voxel-materials';

type Obj = Record<string, unknown>;

// A real project's model record (the starter fixture's), so the species' models are assets the content holds.
const SAMPLE = JSON.parse(
  Object.values(import.meta.glob('../../../fixtures/upgrade/starter-v3.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>)[0] as string,
) as { content: { assets: Obj[] } };
const MODEL_ASSET = SAMPLE.content.assets.find((a) => a['kind'] === 'model')!;
const MODELS = ['grass-tuft', 'reed', 'oak-tree'].map((assetId) => ({ ...MODEL_ASSET, assetId, displayName: assetId }));

/** A species entry with every field of format 1 set to something its canonical form keeps, in canonical order. */
const FULL: DressingSpecies = {
  model: 'grass-tuft',
  class: 'cover',
  density: 6,
  spacing: 0.25,
  scale: [0.8, 1.3],
  yaw: 180,
  align: 0.5,
  seed: 7,
  conditions: {
    material: [3, 9],
    role: ['terrain', 'floor'],
    slope: { max: 35, fade: 10 },
    height: { min: -4, max: 120 },
    sky: true,
    wetness: { min: 1, max: 6 },
    waterDepth: { max: 0 },
    materialEdge: { min: 0.5 },
    construction: { min: 1, fade: 0.5 },
    noise: { min: 0.4, scale: 12, fade: 0.1, seed: 5 },
  },
};
const TREE: DressingSpecies = { model: 'oak-tree', class: 'large', density: 0.01, spacing: 9, scale: [0.9, 1.4], conditions: { slope: { max: 25 }, sky: true } };
const MEADOW: DressingDef = { dressingFormat: 1, dressingId: 'meadow', name: 'Meadow', species: [FULL, TREE] };
const SPARSE: DressingDef = { dressingFormat: 1, dressingId: 'meadow-sparse', name: 'Sparse meadow', species: [{ model: 'grass-tuft', class: 'cover', density: 1.5 }] };
const SPARE: DressingDef = { dressingFormat: 1, dressingId: 'spare', name: 'Nothing names me', species: [{ model: 'reed', class: 'cover', density: 2 }] };

const GRASS: MaterialDef = { materialId: 'grass', name: 'Grass', shader: 'standard', params: {}, textures: {}, voxel: { id: 3, use: 'terrain', dressing: 'meadow' } };
const DRY: MaterialDef = { materialId: 'grass-dry', name: 'Dry grass', shader: 'standard', params: {}, textures: {}, instanceOf: 'grass', voxel: { id: 4, dressing: 'meadow-sparse' } } as MaterialDef;
const LUSH: MaterialDef = { materialId: 'grass-lush', name: 'Lush grass', shader: 'standard', params: {}, textures: {}, instanceOf: 'grass', voxel: { id: 5 } } as MaterialDef;
const ROAD: MaterialDef = { materialId: 'road', name: 'Road', shader: 'standard', params: {}, textures: {}, voxel: { id: 6, use: 'terrain' } };

function content(extra: Obj = {}): Obj {
  return { assets: MODELS, prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, scenes: [{ sceneId: 'main', name: 'Main' }], startScenes: ['main'], ...extra };
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
  expect(r.ok, JSON.stringify(extra).slice(0, 200)).toBe(false);
  return (r as { errors: Array<{ code: string; path: string }> }).errors[0]!;
}
const one = (species: Obj): Obj => ({ dressings: [{ ...MEADOW, species: [species] }] });

describe('the dressing asset (format 1)', () => {
  it('keeps every field through the canonical round trip, in a fixed order, the species in the order given', () => {
    // Given with every level's keys reversed and the sets out of order.
    const reverse = (v: unknown): unknown => (Array.isArray(v) ? v : typeof v === 'object' && v !== null ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverse(x)])) : v);
    const shuffled = reverse({ ...MEADOW, species: [{ ...FULL, conditions: { ...FULL.conditions, material: [9, 3], role: ['floor', 'terrain'] } }, TREE] });
    const c = loaded({ dressings: [SPARSE, shuffled], materials: [GRASS] });
    const [meadow, sparse] = c['dressings'] as DressingDef[];
    expect(meadow).toEqual(MEADOW);
    expect(JSON.stringify(meadow)).toBe(JSON.stringify(MEADOW));
    expect(Object.keys(meadow!)).toEqual(['dressingFormat', 'dressingId', 'name', 'species']);
    // Every field the format has is in the record that came back: the list a field added later must join.
    expect(Object.keys(meadow!.species[0]!)).toEqual(['model', 'class', 'density', 'spacing', 'scale', 'yaw', 'align', 'seed', 'conditions']);
    expect(Object.keys(meadow!.species[0]!.conditions!)).toEqual([...DRESSING_CONDITIONS]);
    expect(Object.keys(meadow!.species[0]!.conditions!.noise!)).toEqual(['min', 'scale', 'fade', 'seed']);
    // The list by id; the species never reordered (the large one stays second, stored as given).
    expect(sparse!.dressingId).toBe('meadow-sparse');
    expect(meadow!.species.map((s) => s.class)).toEqual(['cover', 'large']);
    expect(meadow!.species[1]).toEqual(TREE);
    // The canonical block loads to itself, and through JSON text as a file holds it.
    expect(JSON.stringify(loaded({ dressings: JSON.parse(JSON.stringify(c['dressings'])), materials: [GRASS] })['dressings'])).toBe(JSON.stringify(c['dressings']));
    console.log(`[dressing] two species, every field: ${JSON.stringify(MEADOW).length} bytes compact`);
  });

  it('leaves defaults and empty conditions out, and an empty species list is a dressing', () => {
    const d = canonicalDressing({ ...MEADOW, species: [{ model: 'reed', class: 'cover', density: 2, spacing: 0, scale: [1, 1], yaw: 360, align: 0, seed: 0, conditions: { slope: {}, noise: { scale: 4, seed: 0, fade: 0 } } }, { model: 'reed', class: 'cover', density: 1, conditions: {} }] });
    expect(d.species[0]).toEqual({ model: 'reed', class: 'cover', density: 2, conditions: { noise: { scale: 4 } } });
    expect(d.species[1]).toEqual({ model: 'reed', class: 'cover', density: 1 });
    expect(load({ dressings: [{ ...MEADOW, species: [] }] }).ok).toBe(true);
    expect([...DRESSING_CLASSES]).toEqual(['cover', 'large']);
  });

  it('refuses bad values: the format, unknown fields at every level, each field out of form, a condition the vocabulary lacks', () => {
    const errorsOf = (v: unknown): Array<{ code: string; path?: string }> => {
      const errors: Array<{ code: string; path?: string }> = [];
      validateDressing(v, '', errors as never);
      return errors;
    };
    expect(errorsOf({ ...MEADOW, dressingFormat: 2 })[0]).toMatchObject({ code: 'dressing_format_unsupported', path: '/dressingFormat' });
    expect(errorsOf({ ...MEADOW, dressingFormat: 0 })[0]).toMatchObject({ code: 'field_value', path: '/dressingFormat' });
    expect(errorsOf({ dressingId: 'x', name: 'X', species: [] })[0]).toMatchObject({ code: 'field_missing', path: '/dressingFormat' });
    expect(refused({ dressings: [{ ...MEADOW, biome: 'forest' }] })).toMatchObject({ code: 'field_unexpected', path: '/dressings/0/biome' });
    expect(refused({ dressings: [{ ...MEADOW, dressingId: 'Not An Id' }] })).toMatchObject({ code: 'id_invalid', path: '/dressings/0/dressingId' });
    expect(refused({ dressings: [{ ...MEADOW, name: '' }] })).toMatchObject({ code: 'field_value', path: '/dressings/0/name' });
    expect(refused({ dressings: [{ dressingFormat: 1, dressingId: 'x', name: 'X' }] })).toMatchObject({ code: 'field_missing', path: '/dressings/0/species' });
    expect(refused({ dressings: [MEADOW, { ...SPARSE, dressingId: 'meadow' }] })).toMatchObject({ code: 'id_duplicate', path: '/dressings/1/dressingId' });
    const S = '/dressings/0/species/0';
    const bad: Array<[Obj, string, string]> = [
      [{ ...FULL, sink: 0.1 }, 'field_unexpected', `${S}/sink`],
      [{ ...FULL, exceptions: [[1, 2]] }, 'field_unexpected', `${S}/exceptions`],
      [{ ...FULL, model: 12 }, 'id_invalid', `${S}/model`],
      [{ ...FULL, class: 'tree' }, 'field_value', `${S}/class`],
      [{ model: 'reed', density: 1 }, 'field_missing', `${S}/class`],
      [{ model: 'reed', class: 'cover' }, 'field_missing', `${S}/density`],
      [{ ...FULL, density: 0 }, 'field_value', `${S}/density`],
      [{ ...FULL, density: DRESSING_LIMITS.density.max + 1 }, 'field_value', `${S}/density`],
      [{ ...FULL, spacing: -1 }, 'field_value', `${S}/spacing`],
      // A cover species' neighbours are read from the chunks beside: its spacing ends at the fields' reach.
      [{ ...FULL, spacing: DRESSING_LIMITS.coverSpacingMax + 0.5 }, 'field_value', `${S}/spacing`],
      [{ ...TREE, spacing: DRESSING_LIMITS.spacingMax + 1 }, 'field_value', `${S}/spacing`],
      [{ ...FULL, scale: [2, 1] }, 'field_value', `${S}/scale`],
      [{ ...FULL, scale: 1 }, 'field_value', `${S}/scale`],
      [{ ...FULL, yaw: 400 }, 'field_value', `${S}/yaw`],
      [{ ...FULL, yaw: [0, 90] }, 'field_value', `${S}/yaw`],
      [{ ...FULL, align: 1.5 }, 'field_value', `${S}/align`],
      [{ ...FULL, seed: 1.5 }, 'field_value', `${S}/seed`],
      [{ ...FULL, conditions: [] }, 'field_type', `${S}/conditions`],
      // The ten conditions are the vocabulary: an eleventh is refused, never kept.
      [{ ...FULL, conditions: { cavity: { min: 1 } } }, 'field_unexpected', `${S}/conditions/cavity`],
      [{ ...FULL, conditions: { splineDistance: { max: 2 } } }, 'field_unexpected', `${S}/conditions/splineDistance`],
      [{ ...FULL, conditions: { material: [] } }, 'field_type', `${S}/conditions/material`],
      [{ ...FULL, conditions: { material: [0] } }, 'field_value', `${S}/conditions/material/0`],
      [{ ...FULL, conditions: { material: [3, 3] } }, 'id_duplicate', `${S}/conditions/material/1`],
      [{ ...FULL, conditions: { role: ['liquid'] } }, 'field_value', `${S}/conditions/role/0`],
      [{ ...FULL, conditions: { role: 'terrain' } }, 'field_type', `${S}/conditions/role`],
      [{ ...FULL, conditions: { slope: { max: 120 } } }, 'field_value', `${S}/conditions/slope/max`],
      [{ ...FULL, conditions: { slope: { min: 40, max: 20 } } }, 'field_value', `${S}/conditions/slope`],
      [{ ...FULL, conditions: { slope: { max: 20, ease: 2 } } }, 'field_unexpected', `${S}/conditions/slope/ease`],
      [{ ...FULL, conditions: { height: { min: 'low' } } }, 'field_value', `${S}/conditions/height/min`],
      [{ ...FULL, conditions: { sky: 1 } }, 'field_type', `${S}/conditions/sky`],
      [{ ...FULL, conditions: { wetness: { min: 8 } } }, 'field_value', `${S}/conditions/wetness/min`],
      [{ ...FULL, conditions: { waterDepth: { min: -1 } } }, 'field_value', `${S}/conditions/waterDepth/min`],
      // A bound past the fields' search could never hold.
      [{ ...FULL, conditions: { materialEdge: { min: SURFACE_DISTANCE_CAP_M + 1 } } }, 'field_value', `${S}/conditions/materialEdge/min`],
      [{ ...FULL, conditions: { construction: { max: SURFACE_DISTANCE_CAP_M + 1 } } }, 'field_value', `${S}/conditions/construction/max`],
      [{ ...FULL, conditions: { noise: { min: 0.5 } } }, 'field_value', `${S}/conditions/noise/scale`],
      [{ ...FULL, conditions: { noise: { min: 1.5, scale: 4 } } }, 'field_value', `${S}/conditions/noise/min`],
      [{ ...FULL, conditions: { noise: { scale: 4, seed: 0.5 } } }, 'field_value', `${S}/conditions/noise/seed`],
      [{ ...FULL, conditions: { noise: { scale: 4, octaves: 3 } } }, 'field_unexpected', `${S}/conditions/noise/octaves`],
    ];
    for (const [species, code, path] of bad) expect(refused(one(species)), path).toMatchObject({ code, path });
    // The bounds themselves are values.
    expect(load(one({ ...FULL, spacing: DRESSING_LIMITS.coverSpacingMax, conditions: { materialEdge: { max: SURFACE_DISTANCE_CAP_M }, wetness: { min: 0, max: 7 }, slope: { min: 0, max: 90 } } })).ok).toBe(true);
    expect(load(one({ ...TREE, spacing: 40 })).ok).toBe(true);
  });

  it('is a resource kind of its own file, shipped as a block, never loaded by address', () => {
    expect(RESOURCE_KIND_TABLE.find((k) => k.kind === 'dressing')).toEqual({ kind: 'dressing', list: 'dressings', idKey: 'dressingId', folder: 'dressings', unaddressed: 'block' });
    expect(DRESSING_FORMAT).toBe(1);
  });

  it('gives the scatter core each species as a ground cover rule it takes: its placement fields are the rule\'s own', () => {
    const rule = dressingSpeciesRule(FULL, 3);
    expect(rule).toEqual({ id: 's3', asset: { assetId: 'grass-tuft' }, density: 6, spacing: 0.25, scale: [0.8, 1.3], yaw: 180, align: 0.5, seed: 7, cover: true });
    const errors: unknown[] = [];
    validateScatterRules([rule, dressingSpeciesRule(TREE, 0)], '/rules', errors as never, false);
    expect(errors).toEqual([]);
    expect(dressingModels(MEADOW)).toEqual(['grass-tuft', 'oak-tree']);
  });
});

describe('voxel.dressing on the material record', () => {
  it('is kept canonical, last in the voxel block, and names a dressing the project has (dressing_missing)', () => {
    const c = loaded({ dressings: [MEADOW], materials: [{ ...GRASS, voxel: { dressing: 'meadow', use: 'terrain', id: 3 } }] });
    const voxel = (c['materials'] as MaterialDef[])[0]!.voxel!;
    expect(voxel).toEqual({ id: 3, use: 'terrain', dressing: 'meadow' });
    expect(Object.keys(voxel)).toEqual(['id', 'use', 'dressing']);
    expect(refused({ dressings: [SPARSE], materials: [GRASS] })).toMatchObject({ code: 'dressing_missing', path: '/materials/0/voxel/dressing' });
    expect(refused({ materials: [GRASS] })).toMatchObject({ code: 'dressing_missing', path: '/materials/0/voxel/dressing' });
    expect(refused({ dressings: [MEADOW], materials: [{ ...GRASS, voxel: { id: 3, use: 'terrain', dressing: 'Not An Id' } }] })).toMatchObject({ code: 'id_invalid', path: '/materials/0/voxel/dressing' });
    // A liquid and a gas have no surface for plants to stand on.
    for (const use of ['liquid', 'gas']) expect(refused({ dressings: [MEADOW], materials: [{ ...GRASS, voxel: { id: 3, use, dressing: 'meadow' } }] })).toMatchObject({ code: 'field_value', path: '/materials/0/voxel/dressing' });
    // A construction material may grow something too (moss on a roof).
    expect(load({ dressings: [MEADOW], materials: [{ ...GRASS, voxel: { id: 3, use: 'construction', dressing: 'meadow' } }] }).ok).toBe(true);
  });

  it('resolves through material instances as every voxel field does: a variant grows its parent\'s dressing, or the one it names', () => {
    const materials = [GRASS, DRY, LUSH, ROAD];
    const c = loaded({ dressings: [MEADOW, SPARSE, SPARE], materials });
    const list = c['materials'] as MaterialDef[];
    const resolved = (id: string): MaterialDef => resolveMaterial(list, id)!;
    // The variant that names its own dressing keeps the rest of its parent's voxel block.
    expect(resolved('grass-dry').voxel).toEqual({ id: 4, use: 'terrain', dressing: 'meadow-sparse' });
    // The variant that names none grows its parent's.
    expect(resolved('grass-lush').voxel).toEqual({ id: 5, use: 'terrain', dressing: 'meadow' });
    expect(resolved('road').voxel).toEqual({ id: 6, use: 'terrain' });
    expect([...voxelDressingIds(list)].sort((a, b) => a[0] - b[0])).toEqual([[3, 'meadow'], [4, 'meadow-sparse'], [5, 'meadow']]);
    // What a cover job is handed: the dressings something names, and each voxel id's.
    expect(namedDressings({ materials: list, dressings: c['dressings'] as DressingDef[] }).map((d) => d.dressingId)).toEqual(['meadow', 'meadow-sparse']);
    const table = voxelCoverTable({ materials: list, dressings: c['dressings'] as DressingDef[] });
    expect(table.dressings.map((d) => d.dressingId)).toEqual(['meadow', 'meadow-sparse']);
    expect(table.materials).toEqual([[3, 0], [4, 1], [5, 0]]);
    expect(JSON.parse(JSON.stringify(table))).toEqual(table);
    // A variant naming a dressing the project lacks is refused at the variant.
    expect(refused({ dressings: [MEADOW], materials: [GRASS, DRY] })).toMatchObject({ code: 'dressing_missing', path: '/materials/1/voxel/dressing' });
  });

  it('ships the models of the dressings a material names, the large species\' too, and not a dressing\'s nothing names', () => {
    const c = loaded({ dressings: [MEADOW, SPARE], materials: [GRASS] });
    const scene = { sceneId: 'main', entities: [] } as never;
    const refs = collectAssetRefsV3(scene, c as never).map((r) => r.assetId);
    expect(refs).toContain('grass-tuft');
    expect(refs).toContain('oak-tree');
    expect(refs).not.toContain('reed');
    // A model the project lacks ships nothing and refuses nothing.
    const missing = loaded({ dressings: [{ ...MEADOW, species: [{ model: 'no-such-model', class: 'cover', density: 1 }] }], materials: [GRASS] });
    expect(collectAssetRefsV3(scene, missing as never).map((r) => r.assetId)).toEqual([]);
    // The dressings are one of the blocks every scene shares.
    expect(projectWideRoots(c).some((r) => r === c['dressings'])).toBe(true);
  });
});

describe('the recorded schema step', () => {
  it('runs once on a project written before dressings, changes no document, and is named in its upgrades list after', () => {
    expect(RECORDED_SCHEMA_8_STEPS).toContain('dressing');
    const old = ['bloom-exposure', 'interactor', 'light-counts', 'planes'];
    const pending = pendingSchema8Steps(old);
    expect(pending.map((s) => s.name)).toEqual(['dressing']);
    const contentDoc = Object.freeze(content({ materials: [ROAD] }));
    const scenes = [Object.freeze({ sceneId: 'main', entities: [] })];
    const r = upgradeToSchema8(contentDoc, scenes, pending);
    expect(r.changed).toBe(false);
    expect(r.applied).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.content).toBe(contentDoc);
    expect(r.scenes).toEqual(scenes);
    expect(r.scenes[0]).toBe(scenes[0]);
    expect(withRecordedSteps(old)).toEqual(['bloom-exposure', 'dressing', 'interactor', 'light-counts', 'planes']);
    expect(pendingSchema8Steps(withRecordedSteps(old))).toEqual([]);
    // A 7 runs it with the others, last.
    expect(SCHEMA_8_STEPS[SCHEMA_8_STEPS.length - 1]!.name).toBe('dressing');
  });
});
