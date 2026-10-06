import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { validateLightingBake } from './lighting';
import {
  DEFAULT_PROBE_SPACING,
  PROBE_ARTIFACT_ROW_PROBES,
  PROBE_TEXELS,
  PROBE_TILE_INTERVALS,
  placeProbeGrids,
  probeArtifactSize,
  probeCount,
  probeGridGpuBytes,
  probeTilesOver,
  validateProbeVolumeComponent,
} from './probe-grids';
import { MAX_TEXTURE_EDGE } from './content-limits';
import { collectAssetRefsV3 } from './capture';

const spacingOf = (g: { min: number[]; max: number[]; resolution: number[] }, axis: number): number => (g.max[axis]! - g.min[axis]!) / (g.resolution[axis]! - 1);

describe('probe grid placement', () => {
  it('covers the static bounds at the spacing, twice as dense vertically near the ground', () => {
    const grids = placeProbeGrids({ min: [-6, -0.5, -4], max: [6, 2, 4] }, DEFAULT_PROBE_SPACING);
    // 2.5 m of objects (+1 m above the top) fits in the 4 m ground band: one tile of 1 m layers.
    expect(grids).toHaveLength(1);
    const g = grids[0]!;
    expect(g.resolution).toEqual([7, 5, 5]);
    expect(spacingOf(g, 0)).toBeCloseTo(2);
    expect(spacingOf(g, 1)).toBeCloseTo(1);
    expect(spacingOf(g, 2)).toBeCloseTo(2);
    expect(g.min[1]).toBe(-0.5);
    expect(g.min[0]).toBeLessThanOrEqual(-6);
    expect(g.max[0]).toBeGreaterThanOrEqual(6);
  });

  it('stacks a coarser band above the ground band; the two share their boundary plane', () => {
    const grids = probeTilesOver([0, 0, 0], [10, 12, 10], 2);
    expect(grids).toHaveLength(2);
    const [ground, upper] = grids as [(typeof grids)[0], (typeof grids)[0]];
    expect(spacingOf(ground, 1)).toBeCloseTo(1);
    expect(spacingOf(upper, 1)).toBeCloseTo(2);
    expect(ground.max[1]).toBeCloseTo(upper.min[1]);
    expect(upper.max[1]).toBeGreaterThanOrEqual(12);
  });

  it('splits a large area into tiles that share their faces, with no cap on the number', () => {
    const size = 2 * PROBE_TILE_INTERVALS * 2.5; // two and a half tiles at 2 m
    const grids = probeTilesOver([0, 0, 0], [size, 1, size], 2);
    expect(grids).toHaveLength(9);
    for (const g of grids) {
      expect(g.resolution[0]).toBeLessThanOrEqual(PROBE_TILE_INTERVALS + 1);
      expect(spacingOf(g, 0)).toBeCloseTo(2);
      expect(spacingOf(g, 2)).toBeCloseTo(2);
    }
    const xs = [...new Set(grids.map((g) => g.min[0]))].sort((a, b) => a - b);
    const ends = [...new Set(grids.map((g) => g.max[0]))].sort((a, b) => a - b);
    expect(xs.slice(1)).toEqual(ends.slice(0, -1));
  });

  it('uses the volumes when there are any, each at its own spacing', () => {
    const grids = placeProbeGrids({ min: [0, 0, 0], max: [100, 10, 100] }, 2, [{ min: [0, 0, 0], max: [4, 2, 4], spacing: 1 }]);
    expect(grids).toHaveLength(1);
    expect(spacingOf(grids[0]!, 0)).toBeCloseTo(1);
    expect(spacingOf(grids[0]!, 1)).toBeCloseTo(0.5);
    expect(placeProbeGrids(null, 2)).toEqual([]);
  });

  it('a tile fits one artifact image and reports its GPU memory', () => {
    const big = { resolution: [PROBE_TILE_INTERVALS + 1, PROBE_TILE_INTERVALS + 1, PROBE_TILE_INTERVALS + 1] };
    const { width, height } = probeArtifactSize(probeCount(big));
    expect(width).toBe(PROBE_ARTIFACT_ROW_PROBES * PROBE_TEXELS);
    expect(width).toBeLessThanOrEqual(MAX_TEXTURE_EDGE);
    expect(height).toBeLessThanOrEqual(MAX_TEXTURE_EDGE);
    expect(probeGridGpuBytes({ resolution: [2, 3, 4] })).toBe(2 * 3 * 7 * 6 * 8);
  });
});

describe('probe bake records', () => {
  const lightmapFields = { bakeId: 'bake-1', createdAt: '2026-10-06T10:00:00Z', source: 'browser', range: 4, texelsPerMeter: 16, samples: 1, bounces: 0, entries: [], bakedLights: [], lightsHash: '0123456789abcdef', staticsHash: '0123456789abcdef' };
  const probes = { createdAt: '2026-10-06T10:00:00Z', spacing: 2, bounces: 2, grids: [{ min: [0, 0, 0], max: [2, 1, 2], resolution: [2, 2, 2], asset: 'probes-a' }], probes: 8, moved: 0, filled: 1, gpuBytes: 1024, lightsHash: '0123456789abcdef', staticsHash: '0123456789abcdef' };
  const errorsOf = (v: unknown): ModelErrorV2[] => {
    const errors: ModelErrorV2[] = [];
    validateLightingBake(v, '', errors);
    return errors;
  };

  it('a bake with probes may have no lightmaps; one without needs an atlas', () => {
    expect(errorsOf({ ...lightmapFields, atlases: [], probes })).toEqual([]);
    expect(errorsOf({ ...lightmapFields, atlases: [] }).map((e) => e.path)).toEqual(['/atlases']);
  });

  it('refuses malformed tiles', () => {
    const bad = { ...probes, grids: [{ min: [0, 0, 0], max: [0, 1, 2], resolution: [1, 2, 99], asset: '' }] };
    expect(errorsOf({ ...lightmapFields, atlases: [], probes: bad }).map((e) => e.path).sort()).toEqual(['/probes/grids/0/asset', '/probes/grids/0/max', '/probes/grids/0/resolution']);
  });

  it('checks probe volumes', () => {
    const errs: ModelErrorV2[] = [];
    validateProbeVolumeComponent({ size: [4, 0, 4], spacing: 100, extra: 1 }, '/v', errs);
    expect(errs.map((e) => e.path).sort()).toEqual(['/v/extra', '/v/size', '/v/spacing']);
  });
});

describe('probe tiles ship with the build', () => {
  it('a build takes each scene\'s probe files with its lightmaps', () => {
    const content = { assets: [], behaviors: [], prefabs: [], lighting: { main: { atlases: ['lm-1'], probes: { grids: [{ asset: 'probes-1' }, { asset: 'probes-2' }] } }, other: { atlases: [], probes: { grids: [{ asset: 'probes-3' }] } } } };
    const refs = collectAssetRefsV3({ schemaVersion: 3, sceneId: 'main', revision: 1, entities: [] } as never, content as never, []);
    expect(refs.map((r) => r.assetId)).toEqual(['lm-1', 'probes-1', 'probes-2', 'probes-3']);
  });
});
