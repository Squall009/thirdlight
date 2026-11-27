/**
 * The Dressing card's edits: what each control sends, checked as the
 * backend reads it (the dressing through the project model's validator and
 * canonical form, the material's voxel part through its own).
 */
import type { DressingDef, MaterialDef } from '@thirdlight/project-model';
import { canonicalDressing, validateDressing } from '@thirdlight/project-model/dressing';
import { validateMaterialVoxel } from '@thirdlight/project-model/voxel-materials';
import { DRESSING_CONDITIONS } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';

import { CONDITION_RANGE_ROWS, conditionCount, dressingUsers, materialWithDressing, newDressing, noiseWith, NOISE_SCALE_START, rangeWith, scaleWith, setWith, withCondition, withName, withSpecies, withSpeciesAdded, withSpeciesMoved, withSpeciesRemoved } from './dressing-edits';

/** The dressing as `setDressing` stores it; fails on anything the validator refuses. */
function stored(d: DressingDef | null): DressingDef {
  expect(d).not.toBeNull();
  const errors: { path: string; message: string }[] = [];
  validateDressing(d, '/dressing', errors as never);
  expect(errors).toEqual([]);
  return canonicalDressing(d!);
}

const MEADOW = withSpeciesAdded(withSpeciesAdded(withSpeciesAdded(newDressing('meadow', 'Meadow'), 'grass'), 'flower'), 'reed');

describe('the dressing card: the dressing', () => {
  it('starts empty, takes a name, and adds a species as one cover plant a square metre with no condition', () => {
    expect(stored(newDressing('meadow', 'Meadow'))).toEqual({ dressingFormat: 1, dressingId: 'meadow', name: 'Meadow', species: [] });
    expect(stored(withName(MEADOW, 'Wild meadow')).name).toBe('Wild meadow');
    expect(stored(MEADOW).species).toEqual([
      { model: 'grass', class: 'cover', density: 1 },
      { model: 'flower', class: 'cover', density: 1 },
      { model: 'reed', class: 'cover', density: 1 },
    ]);
  });

  it('removes and reorders species, leaving the others as they were', () => {
    expect(stored(withSpeciesRemoved(MEADOW, 1)).species.map((s) => s.model)).toEqual(['grass', 'reed']);
    expect(stored(withSpeciesMoved(MEADOW, 2, 0)).species.map((s) => s.model)).toEqual(['reed', 'grass', 'flower']);
    expect(stored(withSpeciesMoved(MEADOW, 0, 1)).species.map((s) => s.model)).toEqual(['flower', 'grass', 'reed']);
    // No such move: nothing is sent.
    expect(withSpeciesMoved(MEADOW, 0, -1)).toBeNull();
    expect(withSpeciesMoved(MEADOW, 2, 3)).toBeNull();
    expect(withSpeciesMoved(MEADOW, 1, 1)).toBeNull();
    // A move carries the entry's own fields with it.
    const dense = withSpecies(MEADOW, 2, { density: 6, seed: 4 });
    expect(stored(withSpeciesMoved(dense, 2, 0)).species[0]).toEqual({ model: 'reed', class: 'cover', density: 6, seed: 4 });
  });

  it('patches one species: each placement field set, and an emptied field back to the format\'s default', () => {
    let d = withSpecies(MEADOW, 1, { model: 'daisy', class: 'large', density: 0.5, spacing: 12, scale: [0.8, 1.4], yaw: 90, align: 0.5, seed: 3 });
    expect(stored(d).species[1]).toEqual({ model: 'daisy', class: 'large', density: 0.5, spacing: 12, scale: [0.8, 1.4], yaw: 90, align: 0.5, seed: 3 });
    expect(stored(d).species[0]).toEqual({ model: 'grass', class: 'cover', density: 1 });
    // Back to cover: a spacing past the cover job's reach would be refused, so it is brought inside.
    d = withSpecies(d, 1, { class: 'cover' });
    expect(stored(d).species[1]!.spacing).toBe(8);
    d = withSpecies(d, 1, { spacing: undefined, scale: undefined, yaw: undefined, align: undefined, seed: undefined });
    expect(stored(d).species[1]).toEqual({ model: 'daisy', class: 'cover', density: 0.5 });
  });

  it('gives a scale range whose ends give way to each other', () => {
    expect(scaleWith(undefined, 0, 0.5)).toEqual([0.5, 1]);
    expect(scaleWith(undefined, 1, 2)).toEqual([1, 2]);
    expect(scaleWith(undefined, 0, 3)).toEqual([3, 3]);
    expect(scaleWith([0.8, 1.2], 1, 0.5)).toEqual([0.5, 0.5]);
    expect(scaleWith([0.8, 1.2], 0, undefined)).toEqual([1, 1.2]);
    expect(scaleWith([0.8, 1], 0, undefined)).toBeUndefined();
  });
});

describe('the dressing card: conditions', () => {
  it('sets each of the ten and keeps them in the format\'s order whatever order they were set in', () => {
    let d = MEADOW;
    d = withCondition(d, 0, 'noise', noiseWith(undefined, { min: 0.6 }));
    d = withCondition(d, 0, 'construction', rangeWith(undefined, { min: 3 }));
    d = withCondition(d, 0, 'materialEdge', rangeWith(undefined, { max: 1.5, fade: 0.5 }));
    d = withCondition(d, 0, 'waterDepth', rangeWith(undefined, { max: 0 }));
    d = withCondition(d, 0, 'wetness', rangeWith(undefined, { min: 2 }));
    d = withCondition(d, 0, 'sky', true);
    d = withCondition(d, 0, 'height', rangeWith(undefined, { min: -10, max: 80 }));
    d = withCondition(d, 0, 'slope', rangeWith(undefined, { max: 35, fade: 10 }));
    d = withCondition(d, 0, 'role', setWith(undefined, 'terrain', true));
    d = withCondition(d, 0, 'material', setWith(setWith(undefined, 9, true), 3, true));
    const s = stored(d).species[0]!;
    expect(Object.keys(s.conditions!)).toEqual([...DRESSING_CONDITIONS]);
    expect(s.conditions).toEqual({
      material: [3, 9],
      role: ['terrain'],
      slope: { max: 35, fade: 10 },
      height: { min: -10, max: 80 },
      sky: true,
      wetness: { min: 2 },
      waterDepth: { max: 0 },
      materialEdge: { max: 1.5, fade: 0.5 },
      construction: { min: 3 },
      noise: { min: 0.6, scale: NOISE_SCALE_START },
    });
    expect(conditionCount(d.species[0]!)).toBe(10);
    // The other species were not touched.
    expect(stored(d).species[1]).toEqual({ model: 'flower', class: 'cover', density: 1 });
  });

  it('takes a condition off when its fields are emptied, and the block with the last one', () => {
    let d = withCondition(MEADOW, 0, 'slope', rangeWith(undefined, { max: 35, fade: 10 }));
    d = withCondition(d, 0, 'sky', false);
    // An end emptied leaves the other; a fade alone bounds nothing.
    expect(rangeWith({ min: 1, max: 5, fade: 2 }, { min: undefined })).toEqual({ max: 5, fade: 2 });
    expect(rangeWith({ max: 5, fade: 2 }, { max: undefined })).toBeUndefined();
    expect(rangeWith({ max: 5, fade: 2 }, { fade: undefined })).toEqual({ max: 5 });
    d = withCondition(d, 0, 'slope', rangeWith(d.species[0]!.conditions!.slope, { max: undefined }));
    expect(stored(d).species[0]!.conditions).toEqual({ sky: false });
    d = withCondition(d, 0, 'sky', undefined);
    expect(stored(d).species[0]).toEqual({ model: 'grass', class: 'cover', density: 1 });
    expect(conditionCount(d.species[0]!)).toBe(0);
  });

  it('edits the noise: its range, scale and seed, gone with its last end', () => {
    const n = noiseWith(undefined, { min: 0.5 })!;
    expect(n).toEqual({ min: 0.5, scale: NOISE_SCALE_START });
    expect(noiseWith(n, { scale: 20 })).toEqual({ min: 0.5, scale: 20 });
    expect(noiseWith(noiseWith(n, { scale: 20 }), { seed: 7 })).toEqual({ min: 0.5, scale: 20, seed: 7 });
    expect(noiseWith({ min: 0.5, scale: 20, seed: 7 }, { max: 0.9, fade: 0.1 })).toEqual({ min: 0.5, max: 0.9, fade: 0.1, scale: 20, seed: 7 });
    expect(noiseWith({ min: 0.5, scale: 20, seed: 7 }, { seed: undefined })).toEqual({ min: 0.5, scale: 20 });
    expect(noiseWith({ min: 0.5, scale: 20 }, { min: undefined })).toBeUndefined();
    expect(stored(withCondition(MEADOW, 1, 'noise', noiseWith(undefined, { min: 0.5, fade: 0.1 }))).species[1]!.conditions).toEqual({ noise: { min: 0.5, fade: 0.1, scale: NOISE_SCALE_START } });
  });

  it('ticks a set\'s members in and out; none ticked is any', () => {
    expect(setWith(undefined, 'floor', true)).toEqual(['floor']);
    expect(setWith(['floor'], 'floor', true)).toEqual(['floor']);
    expect(setWith(['floor', 'roof'], 'floor', false)).toEqual(['roof']);
    expect(setWith(['roof'], 'roof', false)).toBeUndefined();
  });

  it('offers a row for each of the seven range conditions, every bound one the format takes', () => {
    expect(CONDITION_RANGE_ROWS.map((r) => r.name)).toEqual(DRESSING_CONDITIONS.filter((c) => c !== 'material' && c !== 'role' && c !== 'sky'));
    for (const row of CONDITION_RANGE_ROWS) {
      const range = { min: row.min, max: row.max };
      const value = row.name === 'noise' ? noiseWith(undefined, range) : range;
      stored(withCondition(MEADOW, 0, row.name, value as never));
    }
  });
});

describe('the dressing card: the material', () => {
  const voxelOk = (m: MaterialDef, instance: boolean): void => {
    const errors: unknown[] = [];
    validateMaterialVoxel(m.voxel, '/voxel', errors as never, instance);
    expect(errors).toEqual([]);
  };
  const GRASS: MaterialDef = { materialId: 'grass', name: 'Grass', shader: 'standard', params: {}, textures: {}, voxel: { id: 3, use: 'terrain', tileMetres: 2 } };
  const DRY: MaterialDef = { materialId: 'dry', name: 'Dry grass', shader: 'standard', params: {}, textures: {}, instanceOf: 'grass', voxel: { id: 4 } };
  const ROAD: MaterialDef = { materialId: 'road', name: 'Road', shader: 'standard', params: {}, textures: {}, voxel: { id: 5, use: 'terrain' } };

  it('names, changes and clears a material\'s dressing, keeping the rest of its voxel part', () => {
    const named = materialWithDressing(GRASS, 'meadow');
    expect(named.voxel).toEqual({ id: 3, use: 'terrain', tileMetres: 2, dressing: 'meadow' });
    voxelOk(named, false);
    expect(materialWithDressing(named, 'heath').voxel).toEqual({ id: 3, use: 'terrain', tileMetres: 2, dressing: 'heath' });
    const cleared = materialWithDressing(named, undefined);
    expect(cleared.voxel).toEqual({ id: 3, use: 'terrain', tileMetres: 2 });
    expect('dressing' in cleared.voxel!).toBe(false);
    // A material that is not a voxel material has no dressing to name.
    const mesh: MaterialDef = { materialId: 'm', name: 'M', shader: 'standard', params: {}, textures: {} };
    expect(materialWithDressing(mesh, 'meadow')).toBe(mesh);
  });

  it('gives a variant its own dressing (an override), and clearing it grows the parent\'s again', () => {
    const own = materialWithDressing(DRY, 'sparse');
    expect(own.voxel).toEqual({ id: 4, dressing: 'sparse' });
    expect(own.instanceOf).toBe('grass');
    voxelOk(own, true);
    expect(materialWithDressing(own, undefined).voxel).toEqual({ id: 4 });
  });

  it('lists who grows by a dressing: the materials naming it and the variants that take it from their parent', () => {
    const grass = materialWithDressing(GRASS, 'meadow');
    expect(dressingUsers([ROAD, DRY, grass], 'meadow')).toEqual([
      { materialId: 'grass', name: 'Grass', voxelId: 3, inherited: false },
      { materialId: 'dry', name: 'Dry grass', voxelId: 4, inherited: true },
    ]);
    // A variant naming its own no longer grows the parent's.
    const dry = materialWithDressing(DRY, 'sparse');
    expect(dressingUsers([ROAD, dry, grass], 'meadow').map((u) => u.materialId)).toEqual(['grass']);
    expect(dressingUsers([ROAD, dry, grass], 'sparse')).toEqual([{ materialId: 'dry', name: 'Dry grass', voxelId: 4, inherited: false }]);
    expect(dressingUsers([ROAD, dry, grass], 'heath')).toEqual([]);
  });
});
