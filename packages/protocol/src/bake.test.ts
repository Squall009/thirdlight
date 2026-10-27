import { describe, expect, it } from 'vitest';

import { bakeHashes, type BakeHashEntity } from './bake';

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

  it('takes generated architecture in whether marked static or not', () => {
    const arch: BakeHashEntity = { id: 'house', components: { transform: T, architecture: { elements: [] } } };
    const base = bakeHashes([...scene(), arch]);
    expect(base.staticsHash).not.toBe(bakeHashes(scene()).staticsHash);
    const moved = { ...arch, components: { ...arch.components, architecture: { elements: [{ id: 'w' }] } } };
    expect(bakeHashes([...scene(), moved]).staticsHash).not.toBe(base.staticsHash);
  });
});
