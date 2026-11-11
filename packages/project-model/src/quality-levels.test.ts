import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { canonicalEnvironment, validateEnvironment, type PostConfig } from './materials';
import { TEXTURE_BUDGET_DEFAULT_MB } from './texture-streaming';
import { DEFAULT_QUALITY_LEVELS, LIGHTING_TIER_SETTINGS, levelLighting, levelPost, levelVoxels, LOW_FRAME_RATE_CAP, LOW_MEMORY_BUDGET_MIB, qualityLevelOf, UPSCALED_RENDER_SCALE, qualityLevelsOf, type QualityLevelConfig } from './quality-levels';
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

  it('the engine\'s levels: low no bloom/AO/DOF, medium no AO/DOF, high the look; every level anti-aliases by temporal upscaling', () => {
    const [low, medium, high] = DEFAULT_QUALITY_LEVELS;
    const atLow = levelPost(LOOK, low!.post)!;
    expect(atLow.bloom?.enabled).toBe(false);
    expect(atLow.ssao?.enabled).toBe(false);
    // Low upscales by TAAU too (it draws at two thirds of the screen); a look without anti-aliasing keeps none.
    expect(atLow.antialias).toBe('taau');
    expect(levelPost({ ...LOOK, antialias: 'none' }, low!.post)!.antialias).toBe('none');
    // Like medium, MSAA where no post stack anti-aliases (the upscale wants an anti-aliased input).
    expect(low!.msaa).toBeUndefined();
    const atMedium = levelPost(LOOK, medium!.post)!;
    expect(atMedium.bloom).toEqual(LOOK.bloom);
    expect(atMedium.ssao?.enabled).toBe(false);
    expect(atMedium.antialias).toBe('taau');
    expect(medium!.msaa).toBeUndefined();
    // High draws the look but anti-aliases by temporal upscaling; a look without anti-aliasing keeps none.
    expect(levelPost(LOOK, high!.post)).toEqual({ ...LOOK, antialias: 'taau' });
    expect(levelPost({ ...LOOK, antialias: 'none' }, high!.post)!.antialias).toBe('none');
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
    expect(errorsOf({ qualityLevels: [{ id: 'low', msaa: 0, post: { ssao: { radius: 0.2 } } }, { id: 'ultra', pixelRatio: 2, shadowMapSize: 4096, lodBias: 2, renderScale: 1, ambientOcclusion: 'gtao', dynamicResolution: false }], quality: 'ultra' })).toEqual([]);
    const paths = (v: unknown): string[] => errorsOf(v).map((e) => e.path ?? '');
    expect(paths({ quality: 'ultra' })).toEqual(['/quality']);
    expect(paths({ qualityLevels: [{ id: 'a' }], quality: 'low' })).toEqual(['/quality']);
    expect(paths({ qualityLevels: [] })).toEqual(['/qualityLevels']);
    expect(paths({ qualityLevels: [{ id: 'a' }, { id: 'a' }] })).toEqual(['/qualityLevels/1/id']);
    expect(paths({ qualityLevels: [{ id: 'Bad Id' }] })).toEqual(['/qualityLevels/0/id']);
    expect(paths({ qualityLevels: [{ id: 'a', msaa: 2 }] })).toEqual(['/qualityLevels/0/msaa']);
    expect(paths({ qualityLevels: [{ id: 'a', shadowMapSize: 1000 }] })).toEqual(['/qualityLevels/0/shadowMapSize']);
    // The retired light counts are no level field (the schema-8 step drops them on open).
    expect(paths({ qualityLevels: [{ id: 'a', localLights: 4 }] })).toEqual(['/qualityLevels/0/localLights']);
    expect(paths({ qualityLevels: [{ id: 'a', renderScale: 0.25 }] })).toEqual(['/qualityLevels/0/renderScale']);
    expect(paths({ qualityLevels: [{ id: 'a', pixelRatio: 3 }] })).toEqual(['/qualityLevels/0/pixelRatio']);
    expect(paths({ qualityLevels: [{ id: 'a', occlusionCulling: 'off' }, { id: 'b', occlusionCulling: 'auto' }, { id: 'c', occlusionCulling: 'on' }] })).toEqual([]);
    expect(paths({ qualityLevels: [{ id: 'a', occlusionCulling: 'hiz' }] })).toEqual(['/qualityLevels/0/occlusionCulling']);
    // The surface cache's budget is memory, within its range.
    expect(paths({ qualityLevels: [{ id: 'a', surfaceCacheMiB: 64 }, { id: 'b', surfaceCacheMiB: 2048 }] })).toEqual([]);
    expect(paths({ qualityLevels: [{ id: 'a', surfaceCacheMiB: 8 }] })).toEqual(['/qualityLevels/0/surfaceCacheMiB']);
    expect(DEFAULT_QUALITY_LEVELS.map((l) => levelLighting(l).surfaceCacheMiB)).toEqual([32, 64, 128]);
    // Live surface light is GPU time a frame, 0 (saved light only) to 8 ms.
    expect(paths({ qualityLevels: [{ id: 'a', surfaceLightMs: 0 }, { id: 'b', surfaceLightMs: 8 }] })).toEqual([]);
    expect(paths({ qualityLevels: [{ id: 'a', surfaceLightMs: 9 }] })).toEqual(['/qualityLevels/0/surfaceLightMs']);
    expect(DEFAULT_QUALITY_LEVELS.map((l) => levelLighting(l).surfaceLightMs)).toEqual([0, 1.5, 3]);
    expect(paths({ qualityLevels: [{ id: 'a', contactShadows: false }, { id: 'b', contactShadows: true }] })).toEqual([]);
    expect(paths({ qualityLevels: [{ id: 'a', contactShadows: 1 }] })).toEqual(['/qualityLevels/0/contactShadows']);
    expect(DEFAULT_QUALITY_LEVELS.map((l) => levelLighting(l).contactShadows)).toEqual([false, true, true]);
    expect(paths({ qualityLevels: [{ id: 'a', lighting: 'low' }, { id: 'b', lighting: 'high' }] })).toEqual([]);
    expect(paths({ qualityLevels: [{ id: 'a', lighting: 'ultra' }] })).toEqual(['/qualityLevels/0/lighting']);
    // A level changes the costly effects and the anti-aliasing, not the look's tone or grading.
    expect(paths({ qualityLevels: [{ id: 'a', post: { exposure: 2 } }] })).toContain('/qualityLevels/0/post/exposure');
    expect(paths({ qualityLevels: [{ id: 'a', post: { ssao: { radius: 99 } } }] })).toEqual(['/qualityLevels/0/post/ssao/radius']);
    expect(paths({ qualityLevels: [{ id: 'a', fps: 60 }] })).toEqual(['/qualityLevels/0/fps']);
    // A level's frame-rate cap is one of the caps a game may set.
    expect(paths({ qualityLevels: [{ id: 'a', frameRateCap: 30 }, { id: 'b', frameRateCap: 120 }] })).toEqual([]);
    expect(paths({ qualityLevels: [{ id: 'a', frameRateCap: 45 }] })).toEqual(['/qualityLevels/0/frameRateCap']);
    expect(paths({ qualityLevels: [{ id: 'a', frameRateCap: '30' }] })).toEqual(['/qualityLevels/0/frameRateCap']);
  });

  it('the engine\'s low level is the integrated-GPU target: capped at 30 fps, its budgets inside its memory budget; no tier holds less than low', () => {
    const [low, medium, high] = DEFAULT_QUALITY_LEVELS;
    expect(LOW_FRAME_RATE_CAP).toBe(30);
    expect([low!.frameRateCap, medium!.frameRateCap, high!.frameRateCap]).toEqual([30, undefined, undefined]);
    // Medium and high are not measured on their own hardware: whatever low keeps, they keep at least as much.
    for (const l of [medium!, high!]) {
      expect(levelVoxels(l).farGpuBudget).toBeGreaterThanOrEqual(levelVoxels(low!).farGpuBudget);
      expect(levelVoxels(l).budgetBytes).toBeGreaterThanOrEqual(levelVoxels(low!).budgetBytes);
      expect(levelVoxels(l).texelDensity).toBeGreaterThanOrEqual(levelVoxels(low!).texelDensity);
      expect(levelVoxels(l).farError).toBeLessThanOrEqual(levelVoxels(low!).farError);
      expect(levelLighting(l).surfaceCacheMiB).toBeGreaterThanOrEqual(levelLighting(low!).surfaceCacheMiB);
    }
    expect(levelVoxels(medium!).budgetBytes).toBeLessThanOrEqual(levelVoxels(high!).budgetBytes);
    expect(levelVoxels(medium!).farGpuBudget).toBeLessThanOrEqual(levelVoxels(high!).farGpuBudget);
    expect(low!.shadowMapSize).toBe(2048);
    // The GPU side holds the tier's far field, its voxel meshes (inside the stream budget), its texture budget and
    // saved light, with room left for the frame's own targets.
    const gpuBudgets = (levelVoxels(low!).farGpuBudget + levelVoxels(low!).budgetBytes) / 2 ** 20 + TEXTURE_BUDGET_DEFAULT_MB + levelLighting(low!).surfaceCacheMiB;
    expect(gpuBudgets).toBeLessThan(LOW_MEMORY_BUDGET_MIB.gpu);
    // The cap survives the canonical form a project stores.
    expect(JSON.stringify(canonicalEnvironment({ qualityLevels: [{ id: 'low', frameRateCap: 30 }] }))).toBe('{"qualityLevels":[{"frameRateCap":30,"id":"low"}]}');
  });

  it('the engine\'s levels are one per lighting tier; a tier sets the lighting a level leaves out, a level\'s own value wins', () => {
    expect(DEFAULT_QUALITY_LEVELS.map((l) => l.lighting)).toEqual(['low', 'medium', 'high']);
    const [low, medium, high] = DEFAULT_QUALITY_LEVELS;
    expect(levelLighting(low!)).toEqual({ tier: 'low', ...LIGHTING_TIER_SETTINGS.low });
    expect(levelLighting(low!)).toMatchObject({ surfaceLightMs: 0, contactShadows: false, reflections: 'off' });
    expect(levelLighting(high!)).toMatchObject({ surfaceCacheMiB: 128, surfaceLightMs: 3, reflections: 'high', surfaceRays: 2, surfaceReach: 2 });
    // Low and medium upscale from two thirds of the screen with TAAU and dynamic resolution; high draws at the project's scale.
    expect([medium!.renderScale, medium!.dynamicResolution, medium!.post?.antialias]).toEqual([UPSCALED_RENDER_SCALE, true, 'taau']);
    expect([low!.renderScale, low!.dynamicResolution, low!.post?.antialias]).toEqual([UPSCALED_RENDER_SCALE, true, 'taau']);
    expect([high!.renderScale, high!.dynamicResolution]).toEqual([undefined, undefined]);
    // A level that names no tier is medium; its own values lay over its tier's.
    expect(levelLighting({})).toEqual({ tier: 'medium', ...LIGHTING_TIER_SETTINGS.medium });
    expect(levelLighting({ lighting: 'high', surfaceLightMs: 1, reflections: 'off' })).toMatchObject({ tier: 'high', surfaceCacheMiB: 128, surfaceLightMs: 1, reflections: 'off', surfaceRays: 2 });
  });

  it('stores a level\'s fields in a fixed order and keeps the levels\' order; a settings field bound to the quality names the project\'s levels', () => {
    const env = canonicalEnvironment({ qualityLevels: [{ renderScale: 0.5, id: 'b' } as QualityLevelConfig, { id: 'a' }] });
    expect(JSON.stringify(env)).toBe('{"qualityLevels":[{"id":"b","renderScale":0.5},{"id":"a"}]}');
    expect(JSON.stringify(canonicalEnvironment({ qualityLevels: [{ occlusionCulling: 'off', id: 'low' } as QualityLevelConfig] }))).toBe('{"qualityLevels":[{"id":"low","occlusionCulling":"off"}]}');
    const schema = { version: 1, slots: 3, settings: [{ key: 'q', type: 'enum', default: 'b', values: ['a', 'b', 'c'], engine: 'quality' }] };
    const errors: ModelErrorV2[] = [];
    validateQualityBindings(schema, ['a', 'b'], '/saveSchema', errors);
    expect(errors.map((e) => e.path)).toEqual(['/saveSchema/settings/0/values']);
  });
});
