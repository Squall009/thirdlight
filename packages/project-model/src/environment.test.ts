/**
 * A scene's look (sky, fog, post, wind), the project's part of the
 * environment (quality, presets), fog volumes and the upgrade that gives
 * every scene the project's old look.
 */
import { describe, expect, it } from 'vitest';

import { canonicalEnvironment, canonicalSceneEnvironment, environmentTextureRefs, validateEnvironment, validateSceneEnvironment, type SceneEnvironment } from './materials';
import { validateSceneV4 } from './scene-v3';
import { upgradeSceneEnvironments } from './upgrade-scene-environment';

const check = (value: unknown): string[] => {
  const errors: { path: string }[] = [];
  validateSceneEnvironment(value, '/environment', errors as never);
  return errors.map((e) => e.path);
};
const checkProject = (value: unknown): { path: string; message: string }[] => {
  const errors: { path: string; message: string }[] = [];
  validateEnvironment(value, '/environment', errors as never);
  return errors;
};

describe('environment sky, fog and post', () => {
  it('accepts every sky mode, fog and a full post stack', () => {
    expect(check({ sky: { mode: 'procedural', turbidity: 8, sunFromLight: true } })).toEqual([]);
    expect(check({ sky: { mode: 'gradient', topColor: '#3A6FB0', horizonColor: '#dfe7ef', bottomColor: '#404040' } })).toEqual([]);
    expect(check({ sky: { mode: 'texture', texture: 'asset-0001' } })).toEqual([]);
    expect(check({ sky: { mode: 'texture', cube: ['asset-0001', 'asset-0002', 'asset-0003', 'asset-0004', 'asset-0005', 'asset-0006'] } })).toEqual([]);
    expect(check({ sky: { mode: 'color', color: '#7ec8ff' }, fog: { mode: 'exp2', color: '#ffffff', density: 0.02 } })).toEqual([]);
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
    expect(checkProject({ quality: 'ultra' }).map((e) => e.path)).toEqual(['/environment/quality']);
  });

  it("keeps the look per scene and the quality and presets the project's, each refusal naming where the field goes", () => {
    expect(checkProject({ quality: 'high', presets: [] })).toEqual([]);
    const wrong = checkProject({ sky: { mode: 'color', color: '#000000' }, wind: { direction: [1, 0], strength: 1, gust: 0, gustFrequency: 0, turbulence: 0 } });
    expect(wrong.map((e) => e.path)).toEqual(['/environment/sky', '/environment/wind']);
    expect(wrong[0]!.message).toContain('sceneId');
    expect(check({ quality: 'low', presets: [] })).toEqual(['/environment/quality', '/environment/presets']);
  });

  it('canonicalizes: fixed section order, sorted keys inside, lowercase colours', () => {
    const c = canonicalSceneEnvironment({ post: { vignette: { enabled: true, darkness: 0.4 }, bloom: { enabled: true } }, sky: { mode: 'color', color: '#AABBCC' } } as SceneEnvironment);
    expect(JSON.stringify(c)).toBe('{"sky":{"color":"#aabbcc","mode":"color"},"post":{"bloom":{"enabled":true},"vignette":{"darkness":0.4,"enabled":true}}}');
    expect(JSON.stringify(canonicalEnvironment({ presets: [], quality: 'low' }))).toBe('{"quality":"low"}');
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

describe('grading lift/gamma/gain, fog volume height falloff, scene looks', () => {
  it('accepts lift/gamma/gain in range and refuses them out of range', () => {
    expect(check({ post: { grading: { lift: 0.1, gamma: 1.4, gain: 0.9 } } })).toEqual([]);
    expect(check({ post: { grading: { lift: 0.6 } } })).toEqual(['/environment/post/grading/lift']);
    expect(check({ post: { grading: { gamma: 0.1 } } })).toEqual(['/environment/post/grading/gamma']);
    expect(check({ post: { grading: { gain: -1 } } })).toEqual(['/environment/post/grading/gain']);
  });

  it('a scene carries its look in canonical form; quality is not a scene\'s', () => {
    const scene = (environment: unknown) => ({ schemaVersion: 4, sceneId: 'scene-a', revision: 1, environment, entities: [] });
    const r = validateSceneV4(scene({ post: { exposure: 2 }, sky: { mode: 'color', color: '#AABBCC' }, wind: { direction: [0, 1], strength: 2, gust: 0, gustFrequency: 0, turbulence: 0 } }));
    expect(r.ok, JSON.stringify(r.ok ? null : r.errors)).toBe(true);
    if (r.ok) {
      expect(JSON.stringify(r.normalized.environment)).toBe('{"wind":{"direction":[0,1],"strength":2,"gust":0,"gustFrequency":0,"turbulence":0},"sky":{"color":"#aabbcc","mode":"color"},"post":{"exposure":2}}');
      // The look sits before the objects in the file.
      expect(Object.keys(r.normalized)).toEqual(['schemaVersion', 'sceneId', 'revision', 'environment', 'entities']);
    }
    // An empty look is no look (the engine defaults).
    const empty = validateSceneV4(scene({}));
    expect(empty.ok && 'environment' in empty.normalized).toBe(false);
    expect(validateSceneV4(scene({ quality: 'low' })).ok).toBe(false);
    expect(validateSceneV4(scene({ wind: { direction: [0, 0], strength: 1, gust: 0, gustFrequency: 0, turbulence: 0 } })).ok).toBe(false);
    expect(validateSceneV4(scene({ sky: { mode: 'texture' } })).ok).toBe(false);
    expect(environmentTextureRefs({ sky: { mode: 'texture', texture: 'asset-0001' }, post: { grading: { lut: 'asset-0002' } } })).toEqual(['asset-0001', 'asset-0002']);
  });

  it('the schemaVersion 5 upgrade copies the project look into every scene and keeps quality and presets', () => {
    const look = { sky: { mode: 'color', color: '#112233' }, fog: { mode: 'linear', color: '#ffffff', near: 1, far: 50 } };
    const preset = { presetId: 'dusk', name: 'Dusk', sky: { mode: 'color', color: '#000000' } };
    const content = { scenes: [], environment: { ...look, quality: 'high', presets: [preset] } };
    const scenes = [{ sceneId: 'a', entities: [] }, { sceneId: 'b', entities: [], environment: { sky: { mode: 'color', color: '#ffffff' } } }];
    const u = upgradeSceneEnvironments(content, scenes);
    expect(u.content).toEqual({ scenes: [], environment: { quality: 'high', presets: [preset] } });
    expect((u.scenes[0] as { environment?: unknown }).environment).toEqual(look);
    // A scene with its own look keeps it.
    expect((u.scenes[1] as { environment?: unknown }).environment).toEqual({ sky: { mode: 'color', color: '#ffffff' } });
    expect(u.notes[0]).toContain('copied into 1 scene');
    // The inputs are untouched; a project without a look changes nothing.
    expect(content.environment).toHaveProperty('sky');
    expect(upgradeSceneEnvironments({ environment: { quality: 'low' } }, [{ sceneId: 'a' }])).toEqual({ content: { environment: { quality: 'low' } }, scenes: [{ sceneId: 'a' }], notes: [] });
    // The look alone: the content keeps no environment block.
    expect(upgradeSceneEnvironments({ environment: look }, [{ sceneId: 'a' }]).content).toEqual({});
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
