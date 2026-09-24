import { describe, expect, it } from 'vitest';

import { bakeHashes, packLightmaps, type BakeHashEntity, type LightmapPacking } from './bake';

const packed = (r: ReturnType<typeof packLightmaps>): LightmapPacking => {
  if ('error' in r) throw new Error(r.error);
  return r;
};
const overlaps = (p: LightmapPacking, pad: number): boolean =>
  p.placements.some((a, i) =>
    p.placements.some(
      (b, j) =>
        i < j &&
        a.atlas === b.atlas &&
        a.x - pad < b.x + b.width + pad &&
        b.x - pad < a.x + a.width + pad &&
        a.y - pad < b.y + b.height + pad &&
        b.y - pad < a.y + a.height + pad,
    ),
  );

describe('lightmap atlas packing', () => {
  it('fits everything in the smallest power-of-two atlas, padded, without overlaps', () => {
    const items = Array.from({ length: 20 }, (_, i) => ({ id: `e-${String(i).padStart(2, '0')}`, width: 16 + i * 3, height: 16 + ((i * 7) % 20) }));
    const p = packed(packLightmaps(items, { padding: 2 }));
    expect(p.atlases).toEqual([{ width: 256, height: 256 }]);
    expect(p.placements).toHaveLength(20);
    expect(overlaps(p, 2)).toBe(false);
    for (const pl of p.placements) {
      expect(pl.x).toBeGreaterThanOrEqual(2);
      expect(pl.x + pl.width + 2).toBeLessThanOrEqual(256);
      expect(pl.scaleOffset).toEqual([pl.width / 256, pl.height / 256, pl.x / 256, pl.y / 256]);
    }
  });

  it('never places an item wider than its atlas', () => {
    const p = packed(packLightmaps([{ id: 'g', width: 576, height: 384 }, { id: 'c', width: 96, height: 64 }], { padding: 2 }));
    expect(p.atlases).toEqual([{ width: 1024, height: 1024 }]);
    for (const pl of p.placements) for (const v of pl.scaleOffset) expect(v).toBeLessThanOrEqual(1);
  });

  it('does not depend on input order', () => {
    const items = [
      { id: 'b', width: 40, height: 10 },
      { id: 'a', width: 10, height: 40 },
      { id: 'c', width: 40, height: 40 },
    ];
    expect(packLightmaps(items)).toEqual(packLightmaps([...items].reverse()));
  });

  it('spills into more atlases at the maximum size and refuses more than 16', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ id: `big-${i}`, width: 500, height: 500 }));
    const p = packed(packLightmaps(items, { maxSize: 1024, padding: 2 }));
    expect(p.atlases.length).toBeGreaterThan(1);
    expect(p.atlases.every((a) => a.width === 1024)).toBe(true);
    expect(overlaps(p, 2)).toBe(false);
    const huge = Array.from({ length: 80 }, (_, i) => ({ id: `h-${i}`, width: 1000, height: 1000 }));
    expect(packLightmaps(huge, { maxSize: 1024 })).toHaveProperty('error');
  });

  it('clamps oversized and tiny items', () => {
    const p = packed(packLightmaps([{ id: 'x', width: 9000, height: 1 }], { maxSize: 512, padding: 2 }));
    expect(p.placements[0]).toMatchObject({ width: 508, height: 4 });
  });
});

describe('bake hashes', () => {
  const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const scene = (): BakeHashEntity[] => [
    { id: 'ground', static: true, components: { transform: T, box: { size: [10, 1, 4], material: { color: '#808080' } } } },
    { id: 'crate', components: { transform: T, box: { size: [1, 1, 1], material: { color: '#808080' } } } },
    { id: 'sun', components: { transform: T, light: { type: 'directional', color: '#ffffff', intensity: 1, direction: [0, -1, 0], mode: 'baked' } } },
    { id: 'lamp', components: { transform: T, light: { type: 'point', color: '#ffffff', intensity: 10 } } },
  ];

  it('changes with static objects and baked lights, not with dynamic ones or realtime lights', () => {
    const base = bakeHashes(scene());
    const moveStatic = scene();
    moveStatic[0]!.components['transform'] = { ...T, position: [0, 1, 0] };
    expect(bakeHashes(moveStatic).staticsHash).not.toBe(base.staticsHash);
    const moveDynamic = scene();
    moveDynamic[1]!.components['transform'] = { ...T, position: [3, 0, 0] };
    expect(bakeHashes(moveDynamic)).toEqual(base);
    const dimSun = scene();
    (dimSun[2]!.components['light'] as { intensity: number }).intensity = 0.5;
    expect(bakeHashes(dimSun).lightsHash).not.toBe(base.lightsHash);
    const realtimeLamp = scene();
    (realtimeLamp[3]!.components['light'] as { intensity: number }).intensity = 50;
    expect(bakeHashes(realtimeLamp)).toEqual(base);
    expect(bakeHashes([...scene()].reverse())).toEqual(base);
    expect(base.staticsHash).toMatch(/^[0-9a-f]{16}$/);
  });
});
