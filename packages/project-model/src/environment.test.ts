/**
 * Phase 9.5b: the environment's sky, fog and post settings, and fog volumes.
 */
import { describe, expect, it } from 'vitest';

import { canonicalEnvironment, canonicalLevelEnvironment, environmentTextureRefs, validateEnvironment, validateLevelEnvironment, type EnvironmentConfig } from './materials';
import { validateSceneV4 } from './scene-v3';

const check = (value: unknown): string[] => {
  const errors: { path: string }[] = [];
  validateEnvironment(value, '/environment', errors as never);
  return errors.map((e) => e.path);
};

describe('environment sky, fog and post', () => {
  it('accepts every sky mode, fog and a full post stack', () => {
    expect(check({ sky: { mode: 'procedural', turbidity: 8, sunFromLight: true } })).toEqual([]);
    expect(check({ sky: { mode: 'gradient', topColor: '#3A6FB0', horizonColor: '#dfe7ef', bottomColor: '#404040' } })).toEqual([]);
    expect(check({ sky: { mode: 'texture', texture: 'asset-0001' } })).toEqual([]);
    expect(check({ sky: { mode: 'texture', cube: ['asset-0001', 'asset-0002', 'asset-0003', 'asset-0004', 'asset-0005', 'asset-0006'] } })).toEqual([]);
    expect(check({ sky: { mode: 'color', color: '#7ec8ff' }, fog: { mode: 'exp2', color: '#ffffff', density: 0.02 }, quality: 'high' })).toEqual([]);
    expect(
      check({
        post: {
          toneMapping: 'agx',
          exposure: 1.2,
          antialias: 'smaa',
          bloom: { enabled: true, strength: 0.8 },
          grading: { contrast: 0.1, tint: '#FFEEDD', lut: 'asset-0003' },
          vignette: { enabled: true, darkness: 0.5 },
          ssao: { enabled: true },
          dof: { enabled: false, focus: 10 },
        },
      }),
    ).toEqual([]);
  });

  it('rejects unknown fields at every level, bad ranges and incomplete skies', () => {
    expect(check({ sky: { mode: 'procedural', extra: {} } })).toEqual(['/environment/sky/extra']);
    expect(check({ sky: { mode: 'procedural', turbidity: 99 } })).toEqual(['/environment/sky/turbidity']);
    expect(check({ sky: { mode: 'texture' } })).toEqual(['/environment/sky/texture']);
    expect(check({ sky: { mode: 'texture', cube: ['asset-0001'] } })).toEqual(['/environment/sky/cube']);
    expect(check({ fog: { mode: 'linear' } })).toEqual(['/environment/fog/color']);
    expect(check({ post: { bloom: { strength: 1 } } })).toEqual(['/environment/post/bloom/enabled']);
    expect(check({ post: { glow: { enabled: true } } })).toEqual(['/environment/post/glow']);
    expect(check({ post: { vignette: { enabled: true, x: 1 } } })).toEqual(['/environment/post/vignette/x']);
    expect(check({ quality: 'ultra' })).toEqual(['/environment/quality']);
  });

  it('canonicalizes: fixed section order, sorted keys inside, lowercase colours', () => {
    const c = canonicalEnvironment({ post: { vignette: { enabled: true, darkness: 0.4 }, bloom: { enabled: true } }, sky: { mode: 'color', color: '#AABBCC' } } as EnvironmentConfig);
    expect(JSON.stringify(c)).toBe('{"sky":{"color":"#aabbcc","mode":"color"},"post":{"bloom":{"enabled":true},"vignette":{"darkness":0.4,"enabled":true}}}');
  });
});

describe('fog volumes (v4)', () => {
  const T = { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const scene = (fogVolume: unknown, count = 1) => ({
    schemaVersion: 4,
    sceneId: 'scene-a',
    revision: 1,
    entities: Array.from({ length: count }, (_, i) => ({ id: `fog-${String(i + 1).padStart(4, '0')}`, components: { transform: T, fogVolume } })),
  });

  it('accepts a fog volume and keeps its fields', () => {
    const r = validateSceneV4(scene({ size: [6, 3, 4], density: 0.25, color: '#DFE7EF', falloff: 0.5 }));
    expect(r.ok, JSON.stringify(r.ok ? null : r.errors)).toBe(true);
    if (r.ok) expect((r.normalized.entities[0]!.components as { fogVolume?: unknown }).fogVolume).toEqual({ size: [6, 3, 4], density: 0.25, color: '#dfe7ef', falloff: 0.5 });
  });

  it('rejects bad sizes, unknown fields and more than 16 volumes', () => {
    for (const bad of [{ size: [0, 1, 1], density: 0.2, color: '#ffffff' }, { size: [1, 1], density: 0.2, color: '#ffffff' }, { size: [1, 1, 1], density: 2, color: '#ffffff' }, { size: [1, 1, 1], density: 0.2, color: '#ffffff', glow: 1 }]) {
      expect(validateSceneV4(scene(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(validateSceneV4(scene({ size: [1, 1, 1], density: 0.2, color: '#ffffff' }, 17)).ok).toBe(false);
  });
});

describe('phase 14.4: grading lift/gamma/gain, fog volume height falloff, level looks', () => {
  it('accepts lift/gamma/gain in range and refuses them out of range', () => {
    expect(check({ post: { grading: { lift: 0.1, gamma: 1.4, gain: 0.9 } } })).toEqual([]);
    expect(check({ post: { grading: { lift: 0.6 } } })).toEqual(['/environment/post/grading/lift']);
    expect(check({ post: { grading: { gamma: 0.1 } } })).toEqual(['/environment/post/grading/gamma']);
    expect(check({ post: { grading: { gain: -1 } } })).toEqual(['/environment/post/grading/gain']);
  });

  it('a level look takes sky, fog, post and wind (not quality) and keeps them in canonical form', () => {
    const lv = (v: unknown): string[] => {
      const errors: { path: string }[] = [];
      validateLevelEnvironment(v, '/flow/levels/1/environment', errors as never);
      return errors.map((e) => e.path);
    };
    expect(lv({ sky: { mode: 'color', color: '#FF0000' }, fog: { mode: 'exp2', color: '#ffffff', density: 0.02 }, post: { bloom: { enabled: true } }, wind: { direction: [0, 1], strength: 2, gust: 0, gustFrequency: 0, turbulence: 0 } })).toEqual([]);
    expect(lv({ quality: 'low' })).toEqual(['/flow/levels/1/environment/quality']);
    expect(lv({ wind: { direction: [0, 0], strength: 1, gust: 0, gustFrequency: 0, turbulence: 0 } })).toEqual(['/flow/levels/1/environment/wind/direction']);
    expect(lv({ sky: { mode: 'texture' } })).toEqual(['/flow/levels/1/environment/sky/texture']);
    expect(lv([])).toEqual(['/flow/levels/1/environment']);
    expect(JSON.stringify(canonicalLevelEnvironment({ post: { exposure: 2 }, sky: { mode: 'color', color: '#AABBCC' } }))).toBe('{"sky":{"color":"#aabbcc","mode":"color"},"post":{"exposure":2}}');
    expect(environmentTextureRefs({ sky: { mode: 'texture', texture: 'asset-0001' }, post: { grading: { lut: 'asset-0002' } } })).toEqual(['asset-0001', 'asset-0002']);
  });

  it('a fog volume keeps heightFalloff (0–10 per metre)', () => {
    const T = { position: [0, 1, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
    const scene = (fogVolume: unknown) => ({ schemaVersion: 4, sceneId: 'scene-a', revision: 1, entities: [{ id: 'fog-0001', components: { transform: T, fogVolume } }] });
    const r = validateSceneV4(scene({ size: [6, 3, 4], density: 0.25, color: '#dfe7ef', heightFalloff: 1.5 }));
    expect(r.ok, JSON.stringify(r.ok ? null : r.errors)).toBe(true);
    if (r.ok) expect((r.normalized.entities[0]!.components as { fogVolume?: unknown }).fogVolume).toEqual({ size: [6, 3, 4], density: 0.25, color: '#dfe7ef', heightFalloff: 1.5 });
    expect(validateSceneV4(scene({ size: [6, 3, 4], density: 0.25, color: '#dfe7ef', heightFalloff: 11 })).ok).toBe(false);
  });
});
