import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { canonicalEnvironment, validateEnvironment, type PostConfig } from './materials';
import { DEFAULT_QUALITY_LEVELS, levelPost, qualityLevelOf, qualityLevelsOf, type QualityLevelConfig } from './quality-levels';
import { validateQualityBindings } from './save-schema';

const errorsOf = (v: unknown): ModelErrorV2[] => {
  const errors: ModelErrorV2[] = [];
  validateEnvironment(v, '', errors);
  return errors;
};

const LOOK: PostConfig = {
  toneMapping: 'agx',
  exposure: 1.2,
  antialias: 'smaa',
  bloom: { enabled: true, strength: 0.8, radius: 0.5, threshold: 0.9 },
  ssao: { enabled: true, radius: 0.6, intensity: 1.5 },
  grading: { contrast: 0.1 },
};

describe('quality levels', () => {
  it('a project without levels has the engine\'s low, medium and high; an unknown or absent level is the highest', () => {
    expect(qualityLevelsOf(undefined)).toBe(DEFAULT_QUALITY_LEVELS);
    expect(qualityLevelsOf({ qualityLevels: [] })).toBe(DEFAULT_QUALITY_LEVELS);
    expect(DEFAULT_QUALITY_LEVELS.map((l) => l.id)).toEqual(['low', 'medium', 'high']);
    expect(qualityLevelOf(DEFAULT_QUALITY_LEVELS, undefined).id).toBe('high');
    expect(qualityLevelOf(DEFAULT_QUALITY_LEVELS, 'gone').id).toBe('high');
    expect(qualityLevelOf(DEFAULT_QUALITY_LEVELS, 'low').id).toBe('low');
    const own: QualityLevelConfig[] = [{ id: 'potato' }, { id: 'ultra' }];
    expect(qualityLevelsOf({ qualityLevels: own })).toBe(own);
    expect(qualityLevelOf(own, 'low').id).toBe('ultra');
  });

  it('the engine\'s levels draw as the fixed profile did: low no bloom/AO/DOF/AA, medium no AO/DOF, high the look', () => {
    const [low, medium, high] = DEFAULT_QUALITY_LEVELS;
    const atLow = levelPost(LOOK, low!.post)!;
    expect(atLow.bloom?.enabled).toBe(false);
    expect(atLow.ssao?.enabled).toBe(false);
    expect(atLow.antialias).toBe('none');
    expect(low!.msaa).toBe(0);
    const atMedium = levelPost(LOOK, medium!.post)!;
    expect(atMedium.bloom).toEqual(LOOK.bloom);
    expect(atMedium.ssao?.enabled).toBe(false);
    expect(atMedium.antialias).toBe('smaa');
    expect(medium!.msaa).toBeUndefined();
    // High changes nothing: the look's own object.
    expect(levelPost(LOOK, high!.post)).toBe(LOOK);
  });

  it('a level lays its effect fields over the look\'s where the look has the effect on, and never turns one on', () => {
    const level: QualityLevelConfig = { id: 'mid', post: { ssao: { radius: 0.2 }, bloom: { strength: 0.3 }, dof: { enabled: true, focus: 3 }, antialias: 'fxaa' } };
    const out = levelPost(LOOK, level.post)!;
    // Field by field: the look's intensity stays, the level's radius wins.
    expect(out.ssao).toEqual({ enabled: true, radius: 0.2, intensity: 1.5 });
    expect(out.bloom).toEqual({ enabled: true, strength: 0.3, radius: 0.5, threshold: 0.9 });
    // The look has no depth of field: the level does not add one.
    expect(out.dof).toBeUndefined();
    expect(out.antialias).toBe('fxaa');
    // Tone, exposure and grading are the look's.
    expect(out.toneMapping).toBe('agx');
    expect(out.exposure).toBe(1.2);
    expect(out.grading).toBe(LOOK.grading);
    // An effect the look has off stays off; a look without anti-aliasing gets none.
    const plain: PostConfig = { bloom: { enabled: false, strength: 1 }, antialias: 'none' };
    expect(levelPost(plain, { bloom: { enabled: true }, antialias: 'smaa' })).toBe(plain);
    // No post at all: nothing to change.
    expect(levelPost(undefined, level.post)).toBeUndefined();
    // The look is never changed in place.
    expect(LOOK.ssao).toEqual({ enabled: true, radius: 0.6, intensity: 1.5 });
  });

  it('validates the levels and the starting level against them', () => {
    expect(errorsOf({ qualityLevels: [{ id: 'low', msaa: 0, post: { ssao: { radius: 0.2 } } }, { id: 'ultra', pixelRatio: 2, shadowMapSize: 4096, localLights: 16, lodBias: 2, renderScale: 1, ambientOcclusion: 'gtao', dynamicResolution: false }], quality: 'ultra' })).toEqual([]);
    const paths = (v: unknown): string[] => errorsOf(v).map((e) => e.path ?? '');
    expect(paths({ quality: 'ultra' })).toEqual(['/quality']);
    expect(paths({ qualityLevels: [{ id: 'a' }], quality: 'low' })).toEqual(['/quality']);
    expect(paths({ qualityLevels: [] })).toEqual(['/qualityLevels']);
    expect(paths({ qualityLevels: [{ id: 'a' }, { id: 'a' }] })).toEqual(['/qualityLevels/1/id']);
    expect(paths({ qualityLevels: [{ id: 'Bad Id' }] })).toEqual(['/qualityLevels/0/id']);
    expect(paths({ qualityLevels: [{ id: 'a', msaa: 2 }] })).toEqual(['/qualityLevels/0/msaa']);
    expect(paths({ qualityLevels: [{ id: 'a', shadowMapSize: 1000 }] })).toEqual(['/qualityLevels/0/shadowMapSize']);
    expect(paths({ qualityLevels: [{ id: 'a', localLights: 17 }] })).toEqual(['/qualityLevels/0/localLights']);
    expect(paths({ qualityLevels: [{ id: 'a', renderScale: 0.25 }] })).toEqual(['/qualityLevels/0/renderScale']);
    expect(paths({ qualityLevels: [{ id: 'a', pixelRatio: 3 }] })).toEqual(['/qualityLevels/0/pixelRatio']);
    // A level changes the costly effects and the anti-aliasing, not the look's tone or grading.
    expect(paths({ qualityLevels: [{ id: 'a', post: { exposure: 2 } }] })).toContain('/qualityLevels/0/post/exposure');
    expect(paths({ qualityLevels: [{ id: 'a', post: { ssao: { radius: 99 } } }] })).toEqual(['/qualityLevels/0/post/ssao/radius']);
    expect(paths({ qualityLevels: [{ id: 'a', fps: 60 }] })).toEqual(['/qualityLevels/0/fps']);
  });

  it('stores a level\'s fields in a fixed order and keeps the levels\' order; a settings field bound to the quality names the project\'s levels', () => {
    const env = canonicalEnvironment({ qualityLevels: [{ renderScale: 0.5, id: 'b' } as QualityLevelConfig, { id: 'a' }] });
    expect(JSON.stringify(env)).toBe('{"qualityLevels":[{"id":"b","renderScale":0.5},{"id":"a"}]}');
    const schema = { version: 1, slots: 3, settings: [{ key: 'q', type: 'enum', default: 'b', values: ['a', 'b', 'c'], engine: 'quality' }] };
    const errors: ModelErrorV2[] = [];
    validateQualityBindings(schema, ['a', 'b'], '/saveSchema', errors);
    expect(errors.map((e) => e.path)).toEqual(['/saveSchema/settings/0/values']);
  });
});
