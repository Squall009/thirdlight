import { describe, expect, it } from 'vitest';

import { DECAL_PAGE_LIMITS, decalPageRefs, decalRectSafeMipLevel, planDecalPages, validateDecalPageRef, type DecalPageLayer, type DecalPageMaterial, type DecalPageSheet } from './decal-pages';
import type { ModelErrorV2 } from './errors';
import { validateMaterials } from './materials';
import type { TrimSheet } from './trim-sheet';

const sizes = (table: Record<string, [number, number]>) => (id: string): [number, number] | null => table[id] ?? null;
const decal = (materialId: string, textures: Record<string, string>): DecalPageMaterial => ({ materialId, shader: 'decal', textures });
const sheet2048: TrimSheet = {
  size: [2048, 2048],
  texelDensity: 512,
  padding: 8,
  rows: [{ slot: 'floor', top: 8, bottom: 520 }],
  cells: [
    { name: 'crack', rect: [8, 1048, 256, 256] },
    { name: 'stain', rect: [280, 1048, 128, 128] },
  ],
};
const sheets = new Map<string, DecalPageSheet>([['trim-a', { trim: sheet2048, textures: { map: 'sheet-a', normalMap: 'sheet-n', ormMap: 'sheet-o' } }]]);

describe('decal pages', () => {
  it('a sheet the page size is a layer as it is: its cells are rectangles on it, nothing copied', () => {
    const plan = planDecalPages(
      [
        { materialId: 'crack', shader: 'decal', textures: {}, decal: { sheet: 'trim-a', cell: 'crack' } },
        { materialId: 'stain', shader: 'decal', textures: {}, decal: { sheet: 'trim-a', cell: 'stain' } },
      ],
      sheets,
      sizes({ 'sheet-a': [2048, 2048], 'sheet-n': [2048, 2048], 'sheet-o': [2048, 2048] }),
    );
    expect(plan.size).toBe(2048);
    expect(plan.pages).toBe(1);
    expect(plan.sets.albedo).toEqual([{ page: 0, layer: { whole: 'sheet-a' } }]);
    expect(plan.sets.normal).toEqual([{ page: 0, layer: { whole: 'sheet-n' } }]);
    expect(plan.sets.orm).toEqual([{ page: 0, layer: { whole: 'sheet-o' } }]);
    expect(plan.entries.get('crack')).toMatchObject({ page: 0, rect: [8, 1048, 256, 256], sets: ['albedo', 'normal', 'orm'] });
    // The two cells are 16 px apart, each with the sheet's 8 px gutter on 16 px alignment: a level-4 texel
    // (16 px) stays inside a cell's box, a level-5 one (32 px) reaches the neighbour.
    expect(plan.entries.get('crack')!.mip).toBe(4);
    expect(plan.entries.get('stain')!.mip).toBe(4);
  });

  it('loose images smaller than the page are copied on shelves with a gutter and an aligned box', () => {
    const plan = planDecalPages(
      [decal('big', { map: 'big-a' }), decal('small', { map: 'small-a', normalMap: 'small-n' }), decal('wide', { map: 'wide-a' })],
      new Map(),
      sizes({ 'big-a': [512, 512], 'small-a': [100, 60], 'small-n': [100, 60], 'wide-a': [300, 20] }),
    );
    expect(plan.size).toBe(512);
    // The 512² image is a page as it is; the other two share a composed page.
    expect(plan.pages).toBe(2);
    expect(plan.sets.albedo[0]).toEqual({ page: 0, layer: { whole: 'big-a' } });
    const composed = plan.sets.albedo[1]!.layer as Extract<DecalPageLayer, { place: unknown }>;
    expect(composed.fill).toEqual([0, 0, 0, 0]);
    // Tallest first: small (60 + 16 → 80) then wide (20 + 16 → 48) beside it on the same shelf.
    expect(composed.place.map((p) => [p.dst, p.pad])).toEqual([
      [[8, 8, 100, 60], [0, 0, 128, 80]],
      [[136, 8, 300, 20], [128, 0, 448, 48]],
    ]);
    expect(composed.place[0]!.src).toEqual([0, 0, 1, 1]);
    // Only the decal with a normal map puts the page in the normal set; its rectangle is the same.
    expect(plan.sets.normal).toHaveLength(1);
    expect((plan.sets.normal[0]!.layer as Extract<DecalPageLayer, { place: unknown }>).place[0]!.dst).toEqual([8, 8, 100, 60]);
    expect(plan.entries.get('small')).toMatchObject({ page: 1, rect: [8, 8, 100, 60], sets: ['albedo', 'normal'] });
    expect(plan.entries.get('big')).toMatchObject({ page: 0, rect: [0, 0, 512, 512], mip: 9, sets: ['albedo'] });
    // Every padded box is inside the page and none overlaps another.
    const boxes = composed.place.map((p) => p.pad);
    for (const b of boxes) expect(b[0] >= 0 && b[1] >= 0 && b[2] <= 512 && b[3] <= 512).toBe(true);
    const p = boxes[0]!;
    const q = boxes[1]!;
    expect(p[2] <= q[0] || p[3] <= q[1]).toBe(true);
  });

  it('the mip cap: the deepest level whose bilinear reads stay in the padded box', () => {
    // A 100 × 60 rectangle 8 px inside a 128 × 80 box from the page corner: at level 4 (16 px texels) the reads at
    // its inset far edges are texels 112-128 and 64-80, inside; at level 5 the bottom edge reads texel 64-96, past 80.
    expect(decalRectSafeMipLevel(512, [8, 8, 100, 60], [0, 0, 128, 80])).toBe(4);
    // Without a gutter, level 1's texel at a rectangle edge straddles the neighbour.
    expect(decalRectSafeMipLevel(512, [9, 9, 100, 60], [9, 9, 109, 69])).toBe(0);
    // A whole page clamps at its edges: every level.
    expect(decalRectSafeMipLevel(256, [0, 0, 256, 256], [0, 0, 256, 256])).toBe(8);
  });

  it('an emissive map is copied into the ORM page as a mask; the factors stand for absent sets', () => {
    const plan = planDecalPages([decal('glow', { map: 'g-a', emissiveMap: 'g-e' })], new Map(), sizes({ 'g-a': [256, 256], 'g-e': [256, 256] }));
    expect(plan.size).toBe(256);
    expect(plan.sets.albedo).toEqual([{ page: 0, layer: { whole: 'g-a' } }]);
    expect(plan.sets.normal).toEqual([]);
    expect(plan.sets.orm).toEqual([
      { page: 0, layer: { fill: [255, 255, 0, 0], place: [{ channels: [{ value: 255 }, { value: 255 }, { value: 255 }, { texture: 'g-e', channel: 'max' }], src: [0, 0, 1, 1], dst: [0, 0, 256, 256], pad: [0, 0, 256, 256] }] } },
    ]);
  });

  it('a sheet of another size has its cells copied; materials drawing the same image share it', () => {
    const plan = planDecalPages(
      [
        { materialId: 'crack', shader: 'decal', textures: {}, decal: { sheet: 'trim-a', cell: 'crack' } },
        { materialId: 'crack-red', shader: 'decal', textures: {}, decal: { sheet: 'trim-a', cell: 'crack' } },
        decal('big', { map: 'big-a' }),
      ],
      sheets,
      // The sheet's textures are 1024² while its table says 2048²: not a layer as it is.
      sizes({ 'sheet-a': [1024, 1024], 'sheet-n': [1024, 1024], 'sheet-o': [1024, 1024], 'big-a': [512, 512] }),
    );
    expect(plan.size).toBe(512);
    expect(plan.pages).toBe(2);
    expect(plan.entries.get('crack')).toBe(plan.entries.get('crack-red'));
    const place = (plan.sets.albedo[1]!.layer as Extract<DecalPageLayer, { place: unknown }>).place;
    expect(place).toHaveLength(1);
    expect(place[0]!.src).toEqual([8 / 2048, 1048 / 2048, 264 / 2048, 1304 / 2048]);
    expect(place[0]!.channels[0]).toEqual({ texture: 'sheet-a', channel: 0 });
  });

  it('an image larger than a composed page is copied at a reduced size, and said so', () => {
    const plan = planDecalPages([decal('huge', { map: 'h-a' }), decal('tiny', { map: 't-a' })], new Map(), sizes({ 'h-a': [4096, 4096], 't-a': [64, 64] }));
    expect(plan.size).toBe(DECAL_PAGE_LIMITS.composeSizeMax);
    expect(plan.entries.get('huge')!.rect).toEqual([0, 0, 2048, 2048]);
    expect(plan.notes).toEqual(['huge: 4096×4096 copied at 2048×2048 onto 2048² decal pages']);
  });

  it('pages: as many as the images need (no cap); deterministic', () => {
    const list = Array.from({ length: 40 }, (_, i) => decal(`d${String(i).padStart(2, '0')}`, { map: `t${i}` }));
    const table = Object.fromEntries(list.map((_, i) => [`t${i}`, [200, 200] as [number, number]]));
    table['t0'] = [256, 256];
    const a = planDecalPages(list, new Map(), sizes(table));
    const b = planDecalPages([...list].reverse(), new Map(), sizes(table));
    expect(a.size).toBe(256);
    // One 256² page as it is, then one 200² image (216 → 224 padded) a page.
    expect(a.pages).toBe(40);
    expect(JSON.stringify([...a.entries])).toBe(JSON.stringify([...b.entries]));
    expect(JSON.stringify(a.sets)).toBe(JSON.stringify(b.sets));
  });

  it('runtime refs: the inset uv rectangle, each set\'s array and layer; validated in a build only', () => {
    const plan = planDecalPages([decal('small', { map: 'small-a' }), decal('big', { map: 'big-a', normalMap: 'big-n' })], new Map(), sizes({ 'small-a': [64, 64], 'big-a': [256, 256], 'big-n': [256, 256] }));
    const refs = decalPageRefs(plan, (set, i) => ({ texture: `decals-${set}`, layer: i }));
    expect(refs.get('big')).toEqual({ rect: [0.5 / 256, 0.5 / 256, 255.5 / 256, 255.5 / 256], mip: 8, albedo: { texture: 'decals-albedo', layer: 0 }, normal: { texture: 'decals-normal', layer: 0 } });
    expect(refs.get('small')).toEqual({ rect: [8.5 / 256, 8.5 / 256, 71.5 / 256, 71.5 / 256], mip: plan.entries.get('small')!.mip, albedo: { texture: 'decals-albedo', layer: 1 } });
    const errors: ModelErrorV2[] = [];
    validateDecalPageRef(refs.get('big'), '/decalPage', errors);
    validateDecalPageRef({ rect: [0, 0, 2, 1], mip: -1, albedo: { texture: 'x' } }, '/p', errors);
    expect(errors.map((e) => e.path)).toEqual(['/p/rect', '/p/mip', '/p/albedo']);
    const material = { materialId: 'big', name: 'Big', shader: 'decal', params: {}, textures: { map: 'big-a' }, decalPage: refs.get('big') };
    const project: ModelErrorV2[] = [];
    validateMaterials([material], '/materials', project);
    expect(project.map((e) => e.path)).toEqual(['/materials/0/decalPage']);
    const build: ModelErrorV2[] = [];
    validateMaterials([material], '/materials', build, undefined, undefined, true);
    expect(build).toEqual([]);
  });
});
