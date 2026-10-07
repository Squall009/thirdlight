/**
 * Block-layer cut-aways as data: the component field's validation and stored
 * form, the zones its regions and planes make, and when a subject cuts one.
 */
import { describe, expect, it } from 'vitest';

import { canonicalBlockLayerComponent, validateBlockLayerComponent, type BlockLayerComponent } from './block-layers';
import { canonicalBlockCutaway, cutawayCuts, cutawayPlaneKey, cutawayZoneKeys, cutawayZones } from './block-cutaway';
import type { ModelErrorV2 } from './errors';

const BASE: BlockLayerComponent = { cellSize: [1, 0.5, 1], bounds: { min: [0, 0, 0], max: [32, 16, 32] } };

const errorsOf = (c: unknown): string[] => {
  const errors: ModelErrorV2[] = [];
  validateBlockLayerComponent(c, 'blockLayer', errors);
  return errors.map((e) => `${e.path}: ${e.code}`);
};

describe('blockLayer.cutaway', () => {
  it('accepts regions (with or without when), planes and a fade; absent is the old component', () => {
    expect(errorsOf({ ...BASE, cutaway: { regions: [{ region: 'house1.roof' }, { region: 'house1.front', when: 'house1.room' }], planes: [8, 16], fade: 0.5 } })).toEqual([]);
    expect(errorsOf(BASE)).toEqual([]);
    expect(canonicalBlockLayerComponent(BASE)).toEqual(BASE);
  });

  it('refuses bad ids, duplicates, unknown keys, rows out of range and fades out of range', () => {
    expect(errorsOf({ ...BASE, cutaway: { regions: [{ region: 'a b' }] } })).toEqual(['blockLayer/cutaway/regions/0/region: id_invalid']);
    expect(errorsOf({ ...BASE, cutaway: { regions: [{ region: 'r' }, { region: 'r' }] } })).toEqual(['blockLayer/cutaway/regions/1/region: id_duplicate']);
    expect(errorsOf({ ...BASE, cutaway: { regions: [{ region: 'r', when: '#4' }] } })).toEqual(['blockLayer/cutaway/regions/0/when: id_invalid']);
    expect(errorsOf({ ...BASE, cutaway: { roofs: [] } })).toEqual(['blockLayer/cutaway/roofs: field_unexpected']);
    expect(errorsOf({ ...BASE, cutaway: { planes: [4, 4] } })).toEqual(['blockLayer/cutaway/planes/1: field_value']);
    expect(errorsOf({ ...BASE, cutaway: { planes: [1.5] } })).toEqual(['blockLayer/cutaway/planes/0: field_value']);
    expect(errorsOf({ ...BASE, cutaway: { fade: -1 } })).toEqual(['blockLayer/cutaway/fade: field_value']);
    expect(errorsOf({ ...BASE, cutaway: [] })).toEqual(['blockLayer/cutaway: field_type']);
  });

  it('stores regions by id and planes ascending, and drops an empty cut-away', () => {
    expect(canonicalBlockCutaway({ regions: [{ region: 'b' }, { region: 'a', when: 'room' }], planes: [9, 3] })).toEqual({ regions: [{ region: 'a', when: 'room' }, { region: 'b' }], planes: [3, 9] });
    expect(canonicalBlockLayerComponent({ ...BASE, cutaway: { regions: [], planes: [] } })).toEqual(BASE);
    expect(canonicalBlockLayerComponent({ ...BASE, cutaway: { fade: 0 } }).cutaway).toEqual({ fade: 0 });
  });

  it('names its zones by region and by `#row`', () => {
    expect(cutawayZoneKeys({ cutaway: { regions: [{ region: 'roof' }], planes: [4] } })).toEqual(['roof', cutawayPlaneKey(4)]);
    expect(cutawayPlaneKey(4)).toBe('#4');
  });
});

describe('cut-away zones', () => {
  const regions = new Map<string, number[][]>([
    ['roof', [[4, 8, 4, 10, 10, 10]]],
    ['room', [[4, 0, 4, 10, 8, 10]]],
    ['front', [[4, 0, 4, 10, 8, 5]]],
  ]);

  it('a region hides while the subject is under it: within its columns, below its lowest row', () => {
    const [roof] = cutawayZones({ cutaway: { regions: [{ region: 'roof' }] } }, regions);
    expect(roof!.key).toBe('roof');
    expect(cutawayCuts(roof!, 7, 2, 7)).toBe(true);
    // Inside it or above it, or beside it: shown.
    expect(cutawayCuts(roof!, 7, 8, 7)).toBe(false);
    expect(cutawayCuts(roof!, 7, 12, 7)).toBe(false);
    expect(cutawayCuts(roof!, 3.9, 2, 7)).toBe(false);
    expect(cutawayCuts(roof!, 10, 2, 7)).toBe(false);
  });

  it('with when, a region hides while the subject is inside the other region', () => {
    const [front] = cutawayZones({ cutaway: { regions: [{ region: 'front', when: 'room' }] } }, regions);
    expect(cutawayCuts(front!, 7, 2, 7)).toBe(true);
    expect(cutawayCuts(front!, 7, 2, 12)).toBe(false);
    expect(cutawayCuts(front!, 7, -1, 7)).toBe(false);
  });

  it('a plane hides every column from its row up while the subject is below it', () => {
    const [plane] = cutawayZones({ cutaway: { planes: [6] } }, regions);
    expect(plane!.key).toBe('#6');
    expect(cutawayCuts(plane!, -500, 5.9, 900)).toBe(true);
    expect(cutawayCuts(plane!, 0, 6, 0)).toBe(false);
  });

  it('a region (or its when) that does not exist makes no zone', () => {
    expect(cutawayZones({ cutaway: { regions: [{ region: 'gone' }, { region: 'roof', when: 'gone' }] } }, regions)).toEqual([]);
  });
});
