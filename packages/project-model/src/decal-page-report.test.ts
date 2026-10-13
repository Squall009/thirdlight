import { describe, expect, it } from 'vitest';

import { decalPageGpuBytes, decalPageReport } from './decal-page-report';
import { planDecalPages, type DecalPageMaterial } from './decal-pages';

const loose = (materialId: string, map: string): DecalPageMaterial => ({ materialId, shader: 'decal', textures: { map } });

describe('decal page report', () => {
  const sizes: Record<string, [number, number]> = { big: [1024, 1024], small: [64, 64], wide: [128, 32] };
  const sizeOf = (id: string): [number, number] | null => sizes[id] ?? null;
  const materials = [loose('mat-big', 'big'), loose('mat-small', 'small'), loose('mat-small-2', 'small'), loose('mat-wide', 'wide')];

  it("reads the plan's pages: each image's rectangle once with every material drawing it, the unused share, the GPU memory", () => {
    const plan = planDecalPages(materials, new Map(), sizeOf);
    const r = decalPageReport(materials, new Map(), sizeOf);
    expect([r.size, r.pages.length]).toEqual([plan.size, plan.pages]);
    expect([r.images, r.materials]).toEqual([3, 4]);
    // The large image is a page of its own; the two small ones share one.
    const rects = r.pages.flatMap((p) => p.rects.map((x) => ({ page: p.page, materials: x.materials, rect: x.rect })));
    for (const x of rects) for (const id of x.materials) expect([x.page, x.rect]).toEqual([plan.entries.get(id)!.page, plan.entries.get(id)!.rect]);
    expect(rects.find((x) => x.materials.includes('mat-small'))!.materials).toEqual(['mat-small', 'mat-small-2']);
    const bigPage = r.pages.find((p) => p.rects.some((x) => x.materials.includes('mat-big')))!;
    expect(bigPage.unused).toBe(0);
    const other = r.pages.find((p) => p !== bigPage)!;
    expect(other.unused).toBeCloseTo(1 - (64 * 64 + 128 * 32) / (1024 * 1024), 9);
    expect(r.unused).toBeCloseTo((other.unused + 0) / 2, 9);
    expect(r.maps).toBe(1);
    expect(r.gpuBytes).toBe(decalPageGpuBytes(1024, 2));
    // A 4 × 4 block a 16 bytes, levels down to 1 × 1.
    expect(decalPageGpuBytes(4, 1)).toBe(16 + 16 + 16);
  });

  it('names the image that sets every page to its size, and what halving it gives', () => {
    const r = decalPageReport(materials, new Map(), sizeOf);
    expect(r.offender).toEqual({ materials: ['mat-big'], source: [1024, 1024], halved: [512, 512], size: 1024, sizeHalved: 512, pagesHalved: 2, gpuBytesHalved: decalPageGpuBytes(512, 2) });
    // Small images only: the smallest page, nothing to name.
    const small = [loose('mat-small', 'small'), loose('mat-wide', 'wide')];
    expect(decalPageReport(small, new Map(), sizeOf).offender).toBeNull();
    expect(decalPageReport([], new Map(), sizeOf)).toMatchObject({ pages: [], images: 0, unused: 0, gpuBytes: 0, offender: null });
  });
});
