import { describe, expect, it } from 'vitest';
import type { DecalPageReport, MaterialDef } from '@thirdlight/project-model';

import { decalPageTextureKey, formatBytes, materialsAt, offenderText, parseDecalPageTextureKey, withDecalPageRefs } from './decal-atlas';

const mat = (materialId: string, shader: string): MaterialDef => ({ materialId, name: materialId, shader, params: {}, textures: { map: 't' } }) as unknown as MaterialDef;

describe('the decal atlas in the editor', () => {
  it("hands decal materials their places on the composed pages, arrays as the view's texture keys", () => {
    const mats = [mat('mat-a', 'decal'), mat('mat-b', 'standard'), mat('mat-c', 'decal')];
    expect(withDecalPageRefs(mats, null)).toBe(mats);
    const out = withDecalPageRefs(mats, { 'mat-a': { rect: [0, 0, 0.5, 0.5], mip: 3, albedo: { texture: 'decals-abc', layer: 1 } }, 'mat-b': { rect: [0, 0, 1, 1], mip: 0 } });
    expect(out[0]!.decalPage).toEqual({ rect: [0, 0, 0.5, 0.5], mip: 3, albedo: { texture: 'decalpages:decals-abc', layer: 1 } });
    // Only decal materials take a place; one without stays as it was.
    expect(out[1]).toBe(mats[1]);
    expect(out[2]).toBe(mats[2]);
    expect(parseDecalPageTextureKey(decalPageTextureKey('decals-abc'))).toBe('decals-abc');
    expect(parseDecalPageTextureKey('decals-abc')).toBeNull();
  });

  it('says which image sets the page size and what shrinking it gives; finds the image under a point', () => {
    const report: DecalPageReport = {
      size: 2048,
      pages: [{ page: 0, unused: 0.25, rects: [{ materials: ['mat-poster'], rect: [0, 0, 2048, 1024], source: [2048, 1024] }, { materials: ['mat-a', 'mat-b'], rect: [0, 1024, 512, 512], source: [512, 512] }] }],
      images: 2,
      materials: 3,
      unused: 0.25,
      maps: 1,
      gpuBytes: 5_600_000,
      offender: { materials: ['mat-poster'], source: [2048, 1024], halved: [1024, 512], size: 2048, sizeHalved: 1024, pagesHalved: 2, gpuBytesHalved: 2_800_000 },
      notes: [],
    };
    expect(offenderText(report, (id) => (id === 'mat-poster' ? 'Poster' : id))).toEqual({ title: 'Poster (2048 × 1024) sets every page to 2048².', detail: 'Shrink to 1024 × 512: 2 pages of 1024² instead of 1 page of 2048², 2.8 MB less.' });
    expect(offenderText({ ...report, offender: null }, (id) => id)).toBeNull();
    expect(materialsAt(report, 0, 100, 1100)).toEqual(['mat-a', 'mat-b']);
    expect(materialsAt(report, 0, 1000, 1700)).toEqual([]);
    expect(formatBytes(20_900_000)).toBe('20.9 MB');
  });
});
