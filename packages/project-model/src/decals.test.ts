/**
 * Decal data: the `decal` component, decal layers on drawn objects, decal
 * materials and the trim sheet cells they draw — validated, kept in
 * canonical form (a saved project reads back the same), shipped with the
 * game, and absent everywhere a project does not use them (the old bytes).
 */
import { describe, expect, it } from 'vitest';

import { canonicalDecal, DECAL_LAYERS_ALL, decalLayersOf, decalSheetsOf, validateDecalComponent, type DecalComponent } from './decals';
import { materialsInUse } from './material-use';
import { canonicalMaterials, resolveMaterialInstances, type MaterialDef } from './materials';
import { validateProjectV4 } from './project-v4';
import { validateSceneV4 } from './scene-v3';
import type { ModelErrorV2 } from './errors';

const T = (position: number[] = [0, 0, 0]) => ({ position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const MANIFEST = { schemaVersion: 7, engineVersion: '0.1.0', id: 'p', name: 'P', createdAt: '2026-10-10T00:00:00Z' };
const CAMERA = { id: 'cam-main', components: { transform: T([0, 2, 10]), virtualCamera: { rig: 'fixed' } } };
const SHEET = { size: [512, 512], texelDensity: 256, padding: 8, rows: [{ slot: 'floor', top: 8, bottom: 248 }], cells: [{ name: 'crack', rect: [8, 264, 128, 128] }, { name: 'stain', rect: [144, 264, 64, 64] }] };
const MATERIALS: MaterialDef[] = [
  { materialId: 'mat-sheet', name: 'Sheet', shader: 'trim', params: {}, textures: {}, trim: SHEET as MaterialDef['trim'] },
  { materialId: 'mat-crack', name: 'Crack', shader: 'decal', params: { blend: 'multiply', opacity: 0.8 }, textures: {}, decal: { sheet: 'mat-sheet', cell: 'crack' } },
  { materialId: 'mat-crack-2', name: 'Crack, lighter', shader: 'decal', params: { opacity: 0.4 }, textures: {}, instanceOf: 'mat-crack' },
  { materialId: 'mat-own', name: 'Own textures', shader: 'decal', params: { color: '#402010' }, textures: {} },
  { materialId: 'mat-plain', name: 'Plain', shader: 'standard', params: {}, textures: {} },
];
const content = (materials: unknown[] = MATERIALS) => ({
  assets: [],
  prefabs: [],
  behaviors: [],
  settings: {},
  behaviorTrust: { entries: [] },
  scenes: [{ sceneId: 'scene-main', name: 'Main' }],
  startScenes: ['scene-main'],
  materials,
});
const scene = (entities: unknown[]) => ({ schemaVersion: 4, sceneId: 'scene-main', revision: 1, entities: [CAMERA, ...entities] });
const DECAL: DecalComponent = { size: [2, 1, 0.5], material: 'mat-crack', opacity: { roughness: 0, albedo: 0.5 }, edgeFade: [0.1, 0.2], sortOrder: 2, layers: 3 };
const decalEntity = (decal: unknown = DECAL) => ({ id: 'decal-000001', components: { transform: T([0, 0, 1]), decal } });
const RECEIVERS = [
  { id: 'box-000001', components: { transform: T(), box: { size: [4, 0.2, 4], material: { color: '#808080' }, decalLayers: 1 } } },
  { id: 'arch-000001', components: { transform: T(), architecture: { elements: [{ id: 'wall', kind: 'sweep', path: { points: [[0, 0, 0], [6, 0, 0]] }, profile: 'wall' }], profiles: { wall: { points: [[0, 0], [0, 3]], slots: ['lower_wall'] } }, decalLayers: 2 } } },
  { id: 'spline-000001', components: { transform: T(), spline: { points: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }], decalLayers: 0 } } },
];

function problems(c: unknown, entities: unknown[]): string[] {
  const r = validateProjectV4(MANIFEST, c, [scene(entities)]);
  return r.ok ? [] : r.errors.map((e) => `${e.code} ${e.path}`);
}
function errorsOf(v: unknown): string[] {
  const errors: ModelErrorV2[] = [];
  validateDecalComponent(v, '', errors);
  return errors.map((e) => `${e.code} ${e.path}`);
}

describe('the decal component', () => {
  it('is a projector box and a decal material; every other field optional, absent fields absent', () => {
    expect(errorsOf({ size: [1, 1, 1], material: 'mat-a' })).toEqual([]);
    expect(errorsOf(DECAL)).toEqual([]);
    expect(errorsOf({ material: 'mat-a' })).toEqual(['field_missing /size']);
    expect(errorsOf({ size: [1, 1, 1] })).toEqual(['field_missing /material']);
    expect(errorsOf({ size: [1, 0, 1], material: 'mat-a', mode: 'stamped', opacity: { gloss: 1, normal: 2 }, normalFade: 0, edgeFade: [0, 1.5], fadeDistance: 0, sortOrder: 1.5, layers: 0, colour: '#fff' })).toEqual([
      'field_unexpected /colour',
      'field_value /size',
      'field_value /mode',
      'field_unexpected /opacity/gloss',
      'field_value /opacity/normal',
      'field_value /normalFade',
      'field_value /edgeFade',
      'field_value /fadeDistance',
      'field_value /sortOrder',
      'field_value /layers',
    ]);
    // Canonical: fields in order, channels in channel order, nothing added.
    const c = canonicalDecal({ layers: 3, sortOrder: 2, edgeFade: [0.1, 0.2], opacity: { roughness: 0, albedo: 0.5 }, material: 'mat-crack', size: [2, 1, 0.5] } as DecalComponent);
    expect(JSON.stringify(c)).toBe('{"size":[2,1,0.5],"material":"mat-crack","opacity":{"albedo":0.5,"roughness":0},"edgeFade":[0.1,0.2],"sortOrder":2,"layers":3}');
    expect(canonicalDecal({ size: [1, 1, 1], material: 'm' })).toEqual({ size: [1, 1, 1], material: 'm' });
  });

  it('decal layers: absent is every layer on a receiver, none on a skinned model', () => {
    expect(decalLayersOf(undefined)).toBe(DECAL_LAYERS_ALL);
    expect(decalLayersOf(undefined, true)).toBe(0);
    expect(decalLayersOf(DECAL_LAYERS_ALL, true)).toBe(DECAL_LAYERS_ALL);
    expect(decalLayersOf(5, true)).toBe(5);
    expect(decalLayersOf(256)).toBe(DECAL_LAYERS_ALL);
  });
});

describe('a project with decals', () => {
  it('validates, and its scene reads back byte-identical after a save', () => {
    expect(problems(content(), [decalEntity(), ...RECEIVERS])).toEqual([]);
    const once = validateSceneV4(scene([decalEntity(), ...RECEIVERS]));
    expect(once.ok).toBe(true);
    if (!once.ok) return;
    const text = JSON.stringify(once.normalized);
    const twice = validateSceneV4(JSON.parse(text));
    expect(twice.ok && JSON.stringify(twice.normalized)).toBe(text);
    const saved = once.normalized.entities.find((e) => e.id === 'decal-000001')!.components.decal;
    expect(saved).toEqual(DECAL);
    expect(once.normalized.entities.find((e) => e.id === 'box-000001')!.components.box!.decalLayers).toBe(1);
    // The materials too (a decal material's sheet cell, a trim sheet's cells).
    const mats = canonicalMaterials(MATERIALS);
    expect(canonicalMaterials(JSON.parse(JSON.stringify(mats)) as MaterialDef[])).toEqual(mats);
    expect(mats.find((m) => m.materialId === 'mat-crack')!.decal).toEqual({ sheet: 'mat-sheet', cell: 'crack' });
  });

  it('a decal names a decal material; a decal material a trim sheet cell or its own textures, not both', () => {
    expect(problems(content(), [decalEntity({ ...DECAL, material: 'mat-plain' })])).toEqual(['field_value /entities/1/components/decal/material']);
    expect(problems(content(), [decalEntity({ ...DECAL, material: 'mat-none' })])).toEqual(['reference_missing /entities/1/components/decal/material']);
    // An instance of a decal material is a decal material.
    expect(problems(content(), [decalEntity({ ...DECAL, material: 'mat-crack-2' })])).toEqual([]);
    const withCrack = (patch: Partial<MaterialDef>) => MATERIALS.map((m) => (m.materialId === 'mat-crack' ? { ...m, ...patch } : m));
    expect(problems(content(withCrack({ decal: { sheet: 'mat-sheet', cell: 'scorch' } })), [])).toEqual(['reference_missing /materials/1/decal/cell']);
    expect(problems(content(withCrack({ decal: { sheet: 'mat-plain', cell: 'crack' } })), [])).toEqual(['field_value /materials/1/decal/sheet']);
    expect(problems(content(withCrack({ decal: { sheet: 'mat-gone', cell: 'crack' } })), [])).toEqual(['reference_missing /materials/1/decal/sheet']);
    expect(problems(content(withCrack({ textures: { map: 'tex-a' } })), [])).toContain('field_value /materials/1/textures');
    expect(problems(content(withCrack({ shader: 'standard' })), [])).toEqual(['field_unexpected /materials/1/decal', 'field_unexpected /materials/1/params/blend', 'field_value /materials/2/shader']);
    // An instance takes its root's cell; a cell of its own is refused.
    expect(problems(content(MATERIALS.map((m) => (m.materialId === 'mat-crack-2' ? { ...m, decal: { sheet: 'mat-sheet', cell: 'stain' } } : m))), [])).toEqual(['field_unexpected /materials/2/decal']);
    // A receiver's decal layers: 0 (none) to every layer.
    expect(problems(content(), [{ id: 'box-000002', components: { transform: T(), box: { size: [1, 1, 1], material: { color: '#808080' }, decalLayers: 256 } } }])).toEqual(['field_value /entities/1/components/box/decalLayers']);
  });

  it('ships the decal material, resolved, and the trim sheet whose cell it draws', () => {
    const used = materialsInUse({ entities: [decalEntity({ ...DECAL, material: 'mat-crack-2' }), ...RECEIVERS] });
    expect([...used]).toEqual(['mat-crack-2']);
    const resolved = resolveMaterialInstances(MATERIALS);
    expect(resolved.find((m) => m.materialId === 'mat-crack-2')).toMatchObject({ shader: 'decal', params: { blend: 'multiply', opacity: 0.4 }, decal: { sheet: 'mat-sheet', cell: 'crack' } });
    expect(decalSheetsOf(resolved, used)).toEqual(['mat-sheet']);
    expect(decalSheetsOf(resolved, new Set(['mat-own']))).toEqual([]);
  });
});

describe('a project without decals', () => {
  it('keeps its bytes: no decal layers, cells or decal fields appear', () => {
    const plain = scene([{ id: 'box-000001', components: { transform: T(), box: { size: [1, 1, 1], material: { color: '#808080' } } } }]);
    const r = validateSceneV4(plain);
    expect(r.ok && JSON.stringify(r.normalized)).toBe(JSON.stringify(plain));
    const mats = [MATERIALS[0]!, MATERIALS[4]!].map((m) => (m.trim !== undefined ? { ...m, trim: { ...m.trim, cells: undefined } } : m)) as MaterialDef[];
    expect(JSON.stringify(canonicalMaterials(mats))).not.toMatch(/cells|decal/);
  });
});
