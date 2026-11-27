/**
 * The Rules rail's answer at a point: made surface fields through the real
 * dressing rules (`dressingWhyNot`, `dressingShare`), each failing condition
 * named with the value read, and the fields' readout.
 */
import type { DressingDef, DressingSpecies, MaterialDef } from '@thirdlight/project-model';
import { DRESSING_CONDITIONS, dressingNoise, dressingRule, dressingShare, dressingWhyNot, surfacePointOut, VOXEL_ROLE, type DressingConditions, type SurfacePoint } from '@thirdlight/voxel';
import { describe, expect, it } from 'vitest';

import { validateMaterialVoxel } from '@thirdlight/project-model/voxel-materials';

import { RULES_TOOLS, STARTER_GROUNDS, starterGround, starterGroundsOffered, WORLD_BRUSH_START, worldBrushArming } from './world-mode';
import { ruleFieldRows, rulesAt } from './world-rules';

const GRASS: MaterialDef = { materialId: 'grass', name: 'Grass', shader: 'standard', params: {}, textures: {}, voxel: { id: 3, use: 'terrain', dressing: 'meadow' } };
const DRY: MaterialDef = { materialId: 'dry', name: 'Dry grass', shader: 'standard', params: {}, textures: {}, instanceOf: 'grass', voxel: { id: 4 } };
const ROAD: MaterialDef = { materialId: 'road', name: 'Road', shader: 'standard', params: {}, textures: {}, voxel: { id: 5, use: 'terrain' } };
const MUD: MaterialDef = { materialId: 'mud', name: 'Mud', shader: 'standard', params: {}, textures: {}, voxel: { id: 6, use: 'terrain', dressing: 'gone' } };
const MATERIALS = [GRASS, DRY, ROAD, MUD];

const cover = (model: string, conditions?: DressingConditions, density = 4): DressingSpecies => ({ model, class: 'cover', density, ...(conditions !== undefined ? { conditions } : {}) });
const meadow = (species: DressingSpecies[]): DressingDef => ({ dressingFormat: 1, dressingId: 'meadow', name: 'Meadow', species });

/** Open, level, dry grass at 2 m, far from any other material or wall. */
function ground(over: Partial<SurfacePoint> = {}): SurfacePoint {
  return { ...surfacePointOut(), row: 3, height: 2, slope: 0, material: 3, role: VOXEL_ROLE.terrain, wetness: 0, sky: 1, waterDepth: 0, materialEdge: 8, construction: 8, ...over };
}

const at = (species: DressingSpecies[], point: SurfacePoint, o: { x?: number; z?: number; clear?: Float32Array } = {}) => rulesAt({ materials: MATERIALS, dressings: [meadow(species)], point, x: o.x ?? 10.25, z: o.z ?? 6.25, ...(o.clear !== undefined ? { clear: o.clear } : {}) });

describe('the Rules rail: what grows at the cursor', () => {
  it('lists every species of the material\'s dressing in order, growing at its full density where no condition fails', () => {
    const a = at([cover('grass'), cover('flower', { sky: true, slope: { max: 35 }, waterDepth: { max: 0 } }, 0.5)], ground());
    expect(a.material).toEqual({ voxelId: 3, materialId: 'grass', name: 'Grass' });
    expect(a.dressing).toEqual({ dressingId: 'meadow', name: 'Meadow' });
    expect(a.note).toBeNull();
    expect(a.species.map((s) => [s.index, s.model, s.grows, s.share, s.why])).toEqual([[0, 'grass', true, 1, null], [1, 'flower', true, 1, null]]);
    expect(a.species[0]!.text).toBe('grows at its full density (4 /m²)');
    expect(a.species[1]!.text).toBe('grows at its full density (0.5 /m²)');
  });

  it('answers a variant by its parent\'s dressing', () => {
    expect(at([cover('grass')], ground({ material: 4 })).dressing).toEqual({ dressingId: 'meadow', name: 'Meadow' });
    expect(at([cover('grass')], ground({ material: 4 })).material.name).toBe('Dry grass');
  });

  // Each of the ten conditions alone: the surface that fails it, the reason named, and the value read in the sentence.
  const NOISE = { min: 0.999, scale: 8, seed: 2 };
  const CASES: readonly [name: (typeof DRESSING_CONDITIONS)[number], c: DressingConditions, p: Partial<SurfacePoint>, says: string][] = [
    ['material', { material: [4, 5] }, {}, 'does not grow: the material here is Grass (3); it grows on Dry grass (4), Road (5)'],
    ['role', { role: ['floor', 'roof'] }, {}, 'does not grow: the surface here is terrain; it grows on floor, roof'],
    ['slope', { slope: { max: 35, fade: 5 } }, { slope: 41.26 }, 'does not grow: the slope here is 41.26°; it grows where it is at most 35°, fading over 5°'],
    ['height', { height: { min: 10, max: 40 } }, { height: 2 }, 'does not grow: the height here is 2 m; it grows where it is 10–40 m'],
    ['sky', { sky: true }, { sky: 0 }, 'does not grow: it is under cover here; it grows under open sky only'],
    ['wetness', { wetness: { min: 3 } }, { wetness: 1 }, 'does not grow: the wetness here is 1; it grows where it is at least 3'],
    ['waterDepth', { waterDepth: { max: 0 } }, { waterDepth: 0.75 }, 'does not grow: the water depth here is 0.75 m; it grows where it is at most 0 m'],
    ['materialEdge', { materialEdge: { max: 1.5 } }, { materialEdge: 8 }, 'does not grow: the distance to another material here is 8 m or more (none within 8 m); it grows where it is at most 1.5 m'],
    ['construction', { construction: { min: 3 } }, { construction: 1.12 }, 'does not grow: the distance to construction here is 1.12 m; it grows where it is at least 3 m'],
    ['noise', { noise: NOISE }, {}, `does not grow: the noise here is ${dressingNoise(NOISE, 10.25, 6.25).toFixed(2).replace(/\.?0+$/, '')}; it grows where it is at least 1 (bumps 8 m apart, seed 2)`],
  ];
  it.each(CASES)('names a failing %s condition with the value read against what it asks', (name, c, p, says) => {
    const point = ground(p);
    const a = at([cover('grass'), cover('picky', c)], point);
    // The reason is the rules' own: this test only checks it is the one shown.
    expect(dressingWhyNot(dressingRule(c), point, 10.25, 6.25)).toBe(name);
    expect(a.species[1]).toMatchObject({ grows: false, share: 0, why: name, text: says });
    // The species beside it, with no condition, still grows.
    expect(a.species[0]!.grows).toBe(true);
  });

  it('covers all ten conditions', () => {
    expect(CASES.map((c) => c[0])).toEqual([...DRESSING_CONDITIONS]);
  });

  it('says the other sky sentence under open sky, and the first failing condition when two fail', () => {
    expect(at([cover('moss', { sky: false })], ground()).species[0]!.text).toBe('does not grow: it is under open sky here; it grows under cover only');
    const two = at([cover('reed', { slope: { max: 10 }, waterDepth: { min: 0.1 } })], ground({ slope: 30 }));
    expect(two.species[0]!.why).toBe('slope');
  });

  it('gives the share where a condition fades, as the rules give it', () => {
    const c: DressingConditions = { slope: { max: 30, fade: 10 } };
    const point = ground({ slope: 35 });
    const share = dressingShare(dressingRule(c), point, 10.25, 6.25);
    expect(share).toBeGreaterThan(0);
    expect(share).toBeLessThan(1);
    const s = at([cover('grass', c, 4)], point).species[0]!;
    expect(s).toMatchObject({ grows: true, share, why: null });
    expect(s.text).toBe(`grows at ${Math.round(share * 100)} % of its density (${(4 * share).toFixed(2).replace(/\.?0+$/, '')} of 4 /m²): a condition is fading here (slope)`);
    // Only the conditions that thin it here are named: a faded range the surface sits well inside is not one.
    const two: DressingConditions = { slope: { max: 30, fade: 10 }, height: { max: 50, fade: 10 }, noise: { min: 0, fade: 0.2, scale: 8 } };
    expect(at([cover('grass', two, 4)], point).species[0]!.text).toContain('a condition is fading here (slope)');
  });

  it('reads the noise where the cursor is: the same species grows at one place and not at another', () => {
    const c: DressingConditions = { noise: { min: 0.5, scale: 4 } };
    const places = Array.from({ length: 40 }, (_, i) => [i * 1.7 + 0.25, i * 0.9 + 0.25] as const);
    const grown = places.map(([x, z]) => at([cover('clover', c)], ground(), { x, z }).species[0]!.grows);
    expect(grown).toContain(true);
    expect(grown).toContain(false);
    places.forEach(([x, z], i) => expect(grown[i]).toBe(dressingNoise(c.noise!, x, z) >= 0.5));
  });

  it('says a static prop keeps the point clear, after the conditions', () => {
    const clear = new Float32Array([9, 2, 5, 11, 4, 7]);
    const a = at([cover('grass'), cover('reed', { waterDepth: { min: 0.1 } })], ground(), { clear });
    expect(a.species[0]).toMatchObject({ grows: false, why: 'prop', text: 'does not grow: a static prop stands here (rule plants keep clear of its box)' });
    expect(a.species[1]!.why).toBe('waterDepth');
    // Beside the box it grows.
    expect(at([cover('grass')], ground(), { x: 20.25, clear }).species[0]!.grows).toBe(true);
  });

  it('says a large species is stored and not placed, whatever its conditions', () => {
    const s = at([{ model: 'oak', class: 'large', density: 0.01, conditions: { sky: false } }], ground()).species[0]!;
    expect(s).toMatchObject({ grows: false, share: 0, why: null, text: 'a large species: stored with the dressing, placed in a later phase' });
  });

  it('says why nothing is listed: no dressing named, one the project lacks, one with no species', () => {
    const none = at([cover('grass')], ground({ material: 5 }));
    expect(none).toMatchObject({ dressing: null, species: [] });
    expect(none.note).toContain('Road names no dressing');
    expect(at([cover('grass')], ground({ material: 6 })).note).toContain('"gone", which the project does not hold');
    expect(at([], ground()).note).toBe('Meadow has no species yet: nothing grows.');
    // A voxel id no material has is still read.
    expect(at([cover('grass')], ground({ material: 77 })).material).toEqual({ voxelId: 77, materialId: null, name: 'voxel material 77' });
    // The fields are listed whatever grows.
    expect(none.fields.length).toBe(9);
  });

  it('lists the fields a condition is checked against, as numbers a designer can type', () => {
    const rows = ruleFieldRows(ground({ slope: 12.34, height: -1.5, wetness: 2, sky: 0, waterDepth: 0.4, materialEdge: 2.25, construction: 8 }), (id) => (id === 3 ? 'Grass' : '?'));
    expect(Object.fromEntries(rows.map((r) => [r.name, r.value]))).toEqual({
      material: 'Grass · 3',
      role: 'terrain',
      slope: '12.3°',
      height: '-1.5 m',
      sky: 'under cover',
      wetness: '2',
      waterDepth: '0.4 m',
      materialEdge: '2.25 m',
      construction: '8 m or more (none within 8 m)',
    });
    expect(ruleFieldRows(ground(), () => 'Grass').find((r) => r.name === 'waterDepth')!.value).toBe('0 m (dry)');
  });
});

describe('the Rules rail: what it arms', () => {
  it('arms the probe and nothing that writes: no voxel, no brush setting, no fill', () => {
    const palettes = { solid: [], paint: [], gas: [], liquid: [] };
    const a = worldBrushArming('rules', { ...WORLD_BRUSH_START, material: 3 }, palettes, 'scene-main');
    expect(a).toMatchObject({ probe: true, voxel: null, uses: [] });
    expect(a.fill).toBeUndefined();
    // The other rails arm no probe.
    for (const rail of ['sculpt', 'paint', 'fill', 'spline'] as const) expect(worldBrushArming(rail, WORLD_BRUSH_START, palettes).probe).toBeUndefined();
    expect(RULES_TOOLS.map((t) => t.key)).toEqual(['I']);
  });
});

describe('the starter grounds the mode offers to make', () => {
  const KIT = [{ dressingId: 'basic-gravel' }, { dressingId: 'basic-meadow' }, { dressingId: 'basic-shore' }];

  it('are plain terrain materials the project model takes, each naming its Basic Kit dressing when the project holds it', () => {
    expect(STARTER_GROUNDS.map((g) => [g.name, g.dressing])).toEqual([['Grass', 'basic-meadow'], ['Shore', 'basic-shore'], ['Gravel', 'basic-gravel']]);
    for (const g of STARTER_GROUNDS) {
      const m = starterGround(g, `mat-${g.id}`, 12, KIT) as { name: string; shader: string; params: { color: string }; voxel: Record<string, unknown> };
      const errors: unknown[] = [];
      validateMaterialVoxel(m.voxel, '/voxel', errors as never, false);
      expect(errors, g.id).toEqual([]);
      expect(m).toMatchObject({ materialId: `mat-${g.id}`, name: g.name, shader: 'standard', params: { color: g.colour }, voxel: { id: 12, use: 'terrain', dressing: g.dressing } });
      // Without the kit the ground is still made, and names nothing the project lacks (the command would refuse it).
      expect((starterGround(g, 'm', 12, []) as { voxel: Record<string, unknown> }).voxel).toEqual({ id: 12, use: 'terrain' });
    }
  });

  it('are offered until a material names their dressing, and say whether the kit is there', () => {
    const none = starterGroundsOffered([], []);
    expect(none.map((o) => [o.ground.id, o.dressing, o.made])).toEqual([['grass', false, false], ['shore', false, false], ['gravel', false, false]]);
    const grass = starterGround(STARTER_GROUNDS[0], 'grass', 3, KIT) as { voxel: { dressing?: string } };
    expect(starterGroundsOffered([grass, ROAD], KIT).map((o) => [o.ground.id, o.dressing, o.made])).toEqual([['grass', true, true], ['shore', true, false], ['gravel', true, false]]);
    // What the made grass grows is the kit's Meadow: the Rules rail answers from it.
    const meadow: DressingDef = { dressingFormat: 1, dressingId: 'basic-meadow', name: 'Meadow', species: [cover('basic-grass', { sky: true, waterDepth: { max: 0 } }, 7)] };
    const a = rulesAt({ materials: [{ ...(grass as unknown as MaterialDef), name: 'Grass' }], dressings: [meadow], point: ground(), x: 1, z: 1 });
    expect(a.dressing).toEqual({ dressingId: 'basic-meadow', name: 'Meadow' });
    expect(a.species[0]).toMatchObject({ model: 'basic-grass', grows: true, share: 1 });
  });
});
