import { describe, expect, it } from 'vitest';

import { deviceGpuClassOf, deviceLightingTier, deviceQualityLevel } from './quality-device';
import { DEFAULT_QUALITY_LEVELS, type QualityLevelConfig } from './quality-levels';

describe('the device\'s lighting tier', () => {
  it('WebGL 2 and software adapters are low; integrated GPUs medium; discrete high; phones low; the rest medium', () => {
    expect(deviceLightingTier({ api: 'webgl2', vendor: 'nvidia' }).tier).toBe('low');
    // This host's Iris Xe as Chrome reports it.
    expect(deviceLightingTier({ api: 'webgpu', vendor: 'intel', architecture: 'gen-12lp' })).toMatchObject({ tier: 'medium', gpu: 'integrated' });
    expect(deviceGpuClassOf({ api: 'webgpu', vendor: 'intel', architecture: 'xe-lpg' })).toBe('integrated');
    expect(deviceGpuClassOf({ api: 'webgpu', vendor: 'intel', architecture: 'xe-hpg' })).toBe('discrete');
    expect(deviceGpuClassOf({ api: 'webgpu', vendor: 'intel', architecture: 'xe2-hpg' })).toBe('discrete');
    expect(deviceLightingTier({ api: 'webgpu', vendor: 'nvidia', architecture: 'ampere' }).tier).toBe('high');
    expect(deviceLightingTier({ api: 'webgpu', vendor: 'apple', architecture: 'common-3' }).tier).toBe('medium');
    expect(deviceGpuClassOf({ api: 'webgpu', vendor: 'amd', architecture: 'rdna-3', description: 'AMD Radeon RX 7800 XT' })).toBe('discrete');
    expect(deviceGpuClassOf({ api: 'webgpu', vendor: 'amd', architecture: 'rdna-2', description: 'AMD Radeon(TM) Graphics' })).toBe('integrated');
    expect(deviceGpuClassOf({ api: 'webgpu', vendor: 'amd', architecture: 'rdna-3' })).toBe('unknown');
    expect(deviceLightingTier({ api: 'webgpu', vendor: 'amd', architecture: 'rdna-3' }).tier).toBe('medium');
    expect(deviceLightingTier({ api: 'webgpu', vendor: 'qualcomm', architecture: 'adreno-7xx' }).tier).toBe('low');
    expect(deviceLightingTier({ api: 'webgpu', vendor: 'arm', architecture: 'valhall' }).tier).toBe('low');
    expect(deviceLightingTier({ api: 'webgpu', vendor: 'google', architecture: 'swiftshader' })).toMatchObject({ tier: 'low', gpu: 'software' });
    expect(deviceLightingTier({ api: 'webgpu', vendor: 'nvidia', isFallbackAdapter: true }).tier).toBe('low');
    expect(deviceLightingTier({ api: 'webgpu' })).toMatchObject({ tier: 'medium', gpu: 'unknown' });
    // The rule's line names what was read.
    expect(deviceLightingTier({ api: 'webgpu', vendor: 'intel', architecture: 'gen-12lp' }).reason).toBe('WebGPU, intel gen-12lp: integrated GPU → medium');
  });

  it('a device starts at the highest level whose tier it fits; a level without a tier counts as the default tier', () => {
    expect(deviceQualityLevel(DEFAULT_QUALITY_LEVELS, 'low')?.id).toBe('low');
    expect(deviceQualityLevel(DEFAULT_QUALITY_LEVELS, 'medium')?.id).toBe('medium');
    expect(deviceQualityLevel(DEFAULT_QUALITY_LEVELS, 'high')?.id).toBe('high');
    const own: QualityLevelConfig[] = [{ id: 'potato', lighting: 'medium' }, { id: 'nice', lighting: 'medium', renderScale: 1 }, { id: 'ultra', lighting: 'high' }];
    expect(deviceQualityLevel(own, 'medium')?.id).toBe('nice');
    // None fits: the lowest.
    expect(deviceQualityLevel(own, 'low')?.id).toBe('potato');
    // Levels that name no tier are the default tier (medium): the highest on a medium or high device, the lowest on a low one.
    expect(deviceQualityLevel([{ id: 'a' }, { id: 'b' }], 'high')?.id).toBe('b');
    expect(deviceQualityLevel([{ id: 'a' }, { id: 'b' }], 'low')?.id).toBe('a');
    expect(deviceQualityLevel([{ id: 'a' }, { id: 'b', lighting: 'high' }], 'medium')?.id).toBe('a');
  });
});
