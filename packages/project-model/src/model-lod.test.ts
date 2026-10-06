/**
 * Levels of detail as data: a model's switch points with the defaults
 * filling what it leaves out, the project's tuning, an instance set's
 * density falloff and the record's validation.
 */
import { describe, expect, it } from 'vitest';

import { canonicalModelLod, instanceDensityOf, LOD_SCREEN_SIZES_DEFAULT, lodCullSizeOf, lodScreenSizesFor, lodTuningOf, modelLodProblems } from './model-lod';

describe('model LOD settings', () => {
  it('the defaults are the engine-wide sizes; levels past the list keep the last', () => {
    expect(lodScreenSizesFor(undefined, 3)).toEqual([0.08, 0.03]);
    expect(lodScreenSizesFor(undefined, 7)).toEqual([...LOD_SCREEN_SIZES_DEFAULT, 0.005, 0.005]);
    expect(lodScreenSizesFor(undefined, 1)).toEqual([]);
  });

  it("a model's own sizes come first; past them the defaults, kept below its last", () => {
    expect(lodScreenSizesFor({ screenSizes: [0.2] }, 3)).toEqual([0.2, 0.03]);
    expect(lodScreenSizesFor({ screenSizes: [0.02] }, 4)).toEqual([0.02, 0.01, 0.005]);
    expect(lodCullSizeOf({ cullSize: 0.004 })).toBe(0.004);
    expect(lodCullSizeOf(undefined)).toBe(0);
  });

  it('validates sizes, cull and keys; an empty value is not stored', () => {
    expect(modelLodProblems({ screenSizes: [0.1, 0.05], cullSize: 0.01 }, '/lod')).toEqual([]);
    expect(modelLodProblems({ screenSizes: [0.1, 0.1] }, '/lod').map((e) => e.path)).toEqual(['/lod/screenSizes/1']);
    expect(modelLodProblems({ screenSizes: [0] }, '/lod')).toHaveLength(1);
    expect(modelLodProblems({ cullSize: 1 }, '/lod')).toHaveLength(1);
    expect(modelLodProblems({ other: 1, cullSize: 0.1 }, '/lod').map((e) => e.code)).toEqual(['field_unexpected']);
    expect(modelLodProblems({}, '/lod')).toHaveLength(1);
    expect(canonicalModelLod({ cullSize: 0 })).toBeUndefined();
  });

  it('the project tuning clamps to its ranges; an instance set fills its falloff from the defaults', () => {
    expect(lodTuningOf({})).toEqual({ bias: 1, hysteresis: 0.1 });
    expect(lodTuningOf({ lod_bias: 10, lod_hysteresis: 0 })).toEqual({ bias: 4, hysteresis: 0 });
    expect(instanceDensityOf(undefined)).toEqual({ start: 0.02, end: 0.005, min: 0.25 });
    expect(instanceDensityOf({ densityMin: 1, densityEnd: 0.5 })).toEqual({ start: 0.02, end: 0.02, min: 1 });
  });
});
