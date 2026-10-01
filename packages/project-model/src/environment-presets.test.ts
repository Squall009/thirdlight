/**
 * Environment presets as project content — validation (in the
 * environment block), the canonical form, a script's patch, texture refs.
 */
import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { canonicalEnvironment, validateEnvironment } from './materials';
import { environmentPresetTextureRefs, validateEnvironmentPatch, validateEnvironmentPresets, type EnvironmentPreset } from './environment-presets';

const errorsOf = (fn: (errors: ModelErrorV2[]) => void): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  fn(e);
  return e;
};

const DAY: EnvironmentPreset = {
  presetId: 'day',
  name: 'Day',
  sky: { mode: 'gradient', topColor: '#4488ff', horizonColor: '#cce6ff', bottomColor: '#808080' },
  fog: { mode: 'linear', color: '#ccddee', near: 10, far: 80 },
  post: { exposure: 1 },
  lights: [{ type: 'directional', color: '#ffffff', intensity: 2, direction: [0.3, -1, -0.2] }, { tag: 'Lamps', intensity: 0 }],
  lightmap: { intensity: 1 },
};
const NIGHT: EnvironmentPreset = {
  presetId: 'night',
  name: 'Night',
  sky: { mode: 'gradient', topColor: '#050814', horizonColor: '#101830', bottomColor: '#050505' },
  fog: { mode: 'linear', color: '#101820', near: 5, far: 40 },
  post: { exposure: 0.6, grading: { tint: '#b0c0ff' } },
  lights: [{ entity: 'sun-0001', intensity: 0.1, color: '#8899ff' }, { type: 'ambient', intensity: 0.05 }],
  lightmap: { intensity: 0.2, tint: '#8090ff' },
};

describe('environment presets', () => {
  it('accepts presets in the environment block and keeps an environment without presets byte-identical', () => {
    expect(errorsOf((e) => validateEnvironment({ quality: 'high', presets: [DAY, NIGHT] }, '', e))).toEqual([]);
    const plain = { quality: 'high' as const };
    expect(JSON.stringify(canonicalEnvironment(plain))).toBe(JSON.stringify({ quality: 'high' }));
    // Presets come last, in the list's own order, colours lowercased.
    const c = canonicalEnvironment({ ...plain, presets: [NIGHT, { ...DAY, sky: { mode: 'color', color: '#AABBCC' } }] });
    expect(Object.keys(c)).toEqual(['quality', 'presets']);
    expect(c.presets!.map((p) => p.presetId)).toEqual(['night', 'day']);
    expect(c.presets![1]!.sky).toEqual({ color: '#aabbcc', mode: 'color' });
    // An empty list is no list.
    expect(canonicalEnvironment({ ...plain, presets: [] })).not.toHaveProperty('presets');
  });

  it('refuses bad presets with a path', () => {
    const bad = (list: unknown): string[] => errorsOf((e) => validateEnvironmentPresets(list, '/presets', e)).map((x) => `${x.code} ${x.path}`);
    expect(bad([DAY, { ...NIGHT, presetId: 'day' }])).toEqual(['id_duplicate /presets/1/presetId']);
    expect(bad([{ ...DAY, presetId: 'Day!' }])).toEqual(['id_invalid /presets/0/presetId']);
    expect(bad([{ ...DAY, name: '' }])).toEqual(['field_value /presets/0/name']);
    expect(bad([{ ...DAY, extra: 1 }])).toEqual(['field_unexpected /presets/0/extra']);
    expect(bad([{ ...DAY, sky: { mode: 'gradient', topColor: 'blue' } }])).toEqual(['field_value /presets/0/sky/topColor']);
    // A light entry names at most one target.
    expect(bad([{ ...DAY, lights: [{ entity: 'a', tag: 'b', intensity: 1 }] }])).toEqual(['field_value /presets/0/lights/0']);
    expect(bad([{ ...DAY, lights: [{ type: 'sun', intensity: 1 }] }])).toEqual(['field_value /presets/0/lights/0/type']);
    // No target: every light.
    expect(bad([{ ...DAY, lights: [{ intensity: 0.5 }] }])).toEqual([]);
    expect(bad([{ ...DAY, lights: [{ type: 'directional', direction: [0, 0, 0] }] }])).toEqual(['field_value /presets/0/lights/0/direction']);
    expect(bad([{ ...DAY, lightmap: { intensity: 9 } }])).toEqual(['field_value /presets/0/lightmap/intensity']);
    // As many presets as the game needs.
    expect(bad(Array.from({ length: 96 }, (_, i) => ({ presetId: `p${i}`, name: 'P' })))).toEqual([]);
    // Through the environment block too.
    expect(errorsOf((e) => validateEnvironment({ presets: [{ presetId: 'x' }] }, '', e)).map((x) => x.path)).toEqual(['/presets/0/name']);
  });

  it('a patch may give only the fields it changes (sky and fog merge over the preset)', () => {
    expect(errorsOf((e) => validateEnvironmentPatch({ fog: { color: '#ff0000' }, sky: { topColor: '#000000' }, post: { exposure: 0.5 } }, '/o', e))).toEqual([]);
    expect(errorsOf((e) => validateEnvironmentPatch({ fog: { density: 3 } }, '/o', e)).map((x) => x.path)).toEqual(['/o/fog/density']);
    expect(errorsOf((e) => validateEnvironmentPatch({ weather: 'rain' }, '/o', e)).map((x) => x.path)).toEqual(['/o/weather']);
    expect(errorsOf((e) => validateEnvironmentPatch([1], '/o', e)).map((x) => x.code)).toEqual(['field_type']);
  });

  it('lists the texture assets presets name', () => {
    expect(environmentPresetTextureRefs([{ presetId: 'a', name: 'A', sky: { mode: 'texture', texture: 'sky-2' }, post: { grading: { lut: 'lut-1' } } }, { presetId: 'b', name: 'B', sky: { mode: 'texture', cube: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'] } }])).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'lut-1', 'sky-2']);
    expect(environmentPresetTextureRefs(undefined)).toEqual([]);
  });
});
