import { describe, expect, it } from 'vitest';
import { MATERIAL_BITS, SHADER_CONSTRUCTION_BIT, shaderGridSide, WETNESS_MAX } from '@thirdlight/voxel';

import { LIGHTING_TIERS, LIGHTING_TIER_SETTINGS } from '@thirdlight/project-model';
import { AXIS_PROJECTION_LEVEL, LightStoreChoice, voxelDrawPath, voxelLightStoreFor, voxelLightStoreFromUrl, voxelPathsFromUrl } from './voxel-surface-path';

const side = shaderGridSide(32);
const grid = (fill: (i: number) => number): Uint16Array => Uint16Array.from({ length: side ** 3 }, (_, i) => fill(i));
const wet = (mat: number, w: number): number => mat + w * 2 ** MATERIAL_BITS;

describe('a voxel draw\'s path', () => {
  it('reads one set where the grid holds one solid material (air and wetness aside), two where it holds more', () => {
    expect(voxelDrawPath(grid((i) => (i % 3 === 0 ? 0 : wet(5, i % (WETNESS_MAX + 1)))), -1, 0)).toEqual({ materials: 1, projection: 'blend' });
    expect(voxelDrawPath(grid((i) => (i === side ** 3 - 1 ? 6 : 5)), -1, 0).materials).toBe(2);
    // The same id as ground and as construction blend apart: two materials.
    expect(voxelDrawPath(grid((i) => (i % 2 === 0 ? 5 : 5 + SHADER_CONSTRUCTION_BIT)), -1, 0).materials).toBe(2);
    // One solid entry for the whole draw (no grid).
    expect(voxelDrawPath(null, 7, 0)).toEqual({ materials: 1, projection: 'blend' });
  });

  it('reads one projection on construction alone at level 0, and on everything from the first coarse level', () => {
    const built = grid((i) => (i % 2 === 0 ? 3 + SHADER_CONSTRUCTION_BIT : 4 + SHADER_CONSTRUCTION_BIT));
    expect(voxelDrawPath(built, -1, 0)).toEqual({ materials: 2, projection: 'axis' });
    expect(voxelDrawPath(null, 3 + SHADER_CONSTRUCTION_BIT, 0)).toEqual({ materials: 1, projection: 'axis' });
    const mixed = grid((i) => (i % 2 === 0 ? 3 + SHADER_CONSTRUCTION_BIT : 4));
    expect(voxelDrawPath(mixed, -1, 0).projection).toBe('blend');
    expect(voxelDrawPath(mixed, -1, AXIS_PROJECTION_LEVEL).projection).toBe('axis');
    expect(voxelDrawPath(null, 4, 2).projection).toBe('axis');
  });

  it('is on unless the page asks for the full program', () => {
    expect(voxelPathsFromUrl('')).toBe(true);
    expect(voxelPathsFromUrl('?voxelPaths=full')).toBe(false);
  });

  it("lights voxel worlds as the tier says on WebGPU, never by the volume on WebGL 2, and the query's store over both", () => {
    expect(voxelLightStoreFromUrl('')).toBe(null);
    expect(voxelLightStoreFromUrl('?voxelLight=volume')).toBe('volume');
    expect(voxelLightStoreFromUrl('?voxelLight=off')).toBe('off');
    for (const v of ['cache', 'hybrid', 'Volume', '']) expect(voxelLightStoreFromUrl(`?voxelLight=${v}`)).toBe(null);
    for (const tier of LIGHTING_TIERS) {
      const on = LIGHTING_TIER_SETTINGS[tier].voxelLightVolume.enabled;
      expect(voxelLightStoreFor(null, on, true)).toBe(on ? 'volume' : 'off');
      expect(voxelLightStoreFor(null, on, false)).toBe('off');
      expect(voxelLightStoreFor('off', on, true)).toBe('off');
      expect(voxelLightStoreFor('volume', on, true)).toBe('volume');
    }
  });

  it("follows the tier each frame until a bench sets a store; the query's store stays", () => {
    const tier = new LightStoreChoice(null);
    expect(tier.next({ tierOn: true, webgpu: true })).toBe('volume');
    expect(tier.next({ tierOn: false, webgpu: true })).toBe('off');
    expect(tier.next({ tierOn: true, webgpu: false })).toBe('off');
    expect(tier.next('volume')).toBe('volume');
    expect(tier.next({ tierOn: false, webgpu: true })).toBe(null);
    const query = new LightStoreChoice('off');
    expect(query.next({ tierOn: true, webgpu: true })).toBe('off');
  });
});
