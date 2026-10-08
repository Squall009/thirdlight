/**
 * The blend maths — weights (simulation) → look values
 * (renderer), and the blend state stepped by the director.
 */
import { describe, expect, it } from 'vitest';

import type { EnvironmentPreset } from '@thirdlight/project-model';

import { blendEnvironment, blendEnvironmentOver, blendLight, colorToLinear, easeEnvironment, linearToColor, mixColors, type EnvironmentBlendView } from './environment-blend';
import { EnvironmentDirector } from './environment-director';

const DAY: EnvironmentPreset = {
  presetId: 'day',
  name: 'Day',
  sky: { mode: 'gradient', topColor: '#4080ff', horizonColor: '#c0e0ff', bottomColor: '#808080' },
  fog: { mode: 'linear', color: '#c0d0e0', near: 10, far: 80 },
  post: { exposure: 1 },
  lights: [{ type: 'directional', color: '#ffffff', intensity: 2, direction: [0, -1, 0] }],
};
const NIGHT: EnvironmentPreset = {
  presetId: 'night',
  name: 'Night',
  sky: { mode: 'gradient', topColor: '#000010', horizonColor: '#101020', bottomColor: '#000000' },
  fog: { mode: 'linear', color: '#101820', near: 5, far: 40 },
  post: { exposure: 0.5, grading: { tint: '#a0b0ff' } },
  lights: [{ type: 'directional', color: '#8090ff', intensity: 0.2, direction: [1, 0, 0] }, { tag: 'lamps', intensity: 30 }],
  lightmap: { intensity: 0.25, tint: '#8090ff' },
};
const PRESETS = new Map([DAY, NIGHT].map((p) => [p.presetId, p]));
const view = (weights: [string, number][], overrides: EnvironmentBlendView['overrides'] = {}): Pick<EnvironmentBlendView, 'weights' | 'overrides'> => ({ weights, overrides });
const lum = (hex: string): number => {
  const [r, g, b] = colorToLinear(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe('environment blend maths', () => {
  it('colours mix in linear light; ends are exact', () => {
    expect(linearToColor(colorToLinear('#4080ff'))).toBe('#4080ff');
    expect(mixColors([['#000000', 1], ['#ffffff', 0]])).toBe('#000000');
    // The midpoint of black and white in linear light is brighter than the sRGB midpoint (#808080).
    expect(mixColors([['#000000', 0.5], ['#ffffff', 0.5]])).toBe('#bcbcbc');
    expect(easeEnvironment('linear', 0.25)).toBe(0.25);
    expect(easeEnvironment('easeInOut', 0.5)).toBe(0.5);
    expect(easeEnvironment('easeIn', 0.5)).toBe(0.25);
    expect(easeEnvironment('easeOut', 0.5)).toBe(0.75);
  });

  it('same-mode skies, fog and exposure blend field by field; mid differs from both ends', () => {
    const at = (t: number) => blendEnvironment({}, PRESETS, view([['day', 1 - t], ['night', t]]));
    const a = at(0);
    const m = at(0.5);
    const b = at(1);
    expect(a.sky).toMatchObject({ mode: 'gradient', topColor: '#4080ff' });
    expect(b.sky).toMatchObject({ mode: 'gradient', topColor: '#000010' });
    expect(a.skyLayers).toBeUndefined();
    const top = [a, m, b].map((x) => lum(x.sky!.topColor!));
    expect(top[0]).toBeGreaterThan(top[1]!);
    expect(top[1]).toBeGreaterThan(top[2]!);
    expect(m.fog).toMatchObject({ mode: 'linear', near: 7.5, far: 60 });
    expect(lum(m.fog!.color)).toBeLessThan(lum(a.fog!.color));
    expect(lum(m.fog!.color)).toBeGreaterThan(lum(b.fog!.color));
    expect(m.post?.exposure).toBeCloseTo(0.75, 12);
    // Grading appears as soon as one contributor has it: neutral on the other side.
    expect(a.post?.grading).toBeUndefined();
    expect(m.post?.grading).toMatchObject({ brightness: 0, contrast: 0, gamma: 1 });
    expect(m.lightmap.intensity).toBeCloseTo(0.625, 12);
  });

  it('different skies cross-fade as layers (the base without a sky is the background)', () => {
    const colour: EnvironmentPreset = { presetId: 'flat', name: 'Flat', sky: { mode: 'color', color: '#ff0000' } };
    const presets = new Map([...PRESETS, ['flat', colour]]);
    const x = blendEnvironment({}, presets, view([['', 0.2], ['day', 0.3], ['flat', 0.5]]));
    expect(x.sky).toBeUndefined();
    expect(x.skyLayers!.map((l) => [l.sky?.mode ?? null, l.weight])).toEqual([[null, 0.2], ['gradient', 0.3], ['color', 0.5]]);
    // A texture sky with another image is another layer; the same image blends its intensity.
    const t1: EnvironmentPreset = { presetId: 't1', name: 'T1', sky: { mode: 'texture', texture: 'img-a', intensity: 2 } };
    const t2: EnvironmentPreset = { presetId: 't2', name: 'T2', sky: { mode: 'texture', texture: 'img-a', intensity: 1 } };
    const t3: EnvironmentPreset = { presetId: 't3', name: 'T3', sky: { mode: 'texture', texture: 'img-b' } };
    const tp = new Map([t1, t2, t3].map((p) => [p.presetId, p]));
    expect(blendEnvironment({}, tp, view([['t1', 0.5], ['t2', 0.5]])).sky).toMatchObject({ mode: 'texture', texture: 'img-a', intensity: 1.5 });
    expect(blendEnvironment({}, tp, view([['t1', 0.5], ['t3', 0.5]])).skyLayers).toHaveLength(2);
    // The same image turned two ways blends its turn the short way round (170° and −150° meet at −170°).
    const r1: EnvironmentPreset = { presetId: 'r1', name: 'R1', sky: { mode: 'texture', texture: 'img-a', rotation: 170 } };
    const r2: EnvironmentPreset = { presetId: 'r2', name: 'R2', sky: { mode: 'texture', texture: 'img-a', rotation: -150 } };
    const rp = new Map([r1, r2, t2].map((p) => [p.presetId, p]));
    expect(blendEnvironment({}, rp, view([['r1', 0.5], ['r2', 0.5]])).sky!.rotation).toBeCloseTo(-170, 6);
    expect(blendEnvironment({}, rp, view([['r1', 0.5], ['t2', 0.5]])).sky!.rotation).toBeCloseTo(85, 6);
    expect(blendEnvironment({}, tp, view([['t1', 0.5], ['t2', 0.5]])).sky!.rotation).toBeUndefined();
  });

  it('fog thins towards a look without fog; linear and exp2 convert', () => {
    const none = blendEnvironment({}, PRESETS, view([['', 0.5], ['day', 0.5]]));
    // Half the fog: the far distance stretches (near + (far − near) / 0.5).
    expect(none.fog).toMatchObject({ mode: 'linear', near: 10, far: 150 });
    const exp: EnvironmentPreset = { presetId: 'haze', name: 'Haze', fog: { mode: 'exp2', color: '#ffffff', density: 0.05 } };
    const f = blendEnvironment({}, new Map([...PRESETS, ['haze', exp]]), view([['day', 0.25], ['haze', 0.75]])).fog!;
    expect(f.mode).toBe('exp2');
    expect(f.density).toBeCloseTo(0.25 * (2 / 80) + 0.75 * 0.05, 12);
  });

  it('height fog blends field by field, thins towards a look without it, its sun glow fades with its share; a patch merges over it', () => {
    const HAZE: EnvironmentPreset = { presetId: 'haze', name: 'Haze', heightFog: { density: 0.04, color: '#ff0000', height: 10, falloff: 0.1, start: 20, inscatterColor: '#ffffff', inscatterExponent: 4 } };
    const CLEAR: EnvironmentPreset = { presetId: 'clear', name: 'Clear', heightFog: { density: 0.02, color: '#0000ff' } };
    const presets = new Map([HAZE, CLEAR, DAY].map((p) => [p.presetId, p]));
    expect(blendEnvironment({}, presets, view([['haze', 1]])).heightFog).toEqual({ density: 0.04, color: '#ff0000', height: 10, falloff: 0.1, start: 20, inscatterColor: '#ffffff', inscatterExponent: 4 });
    const mid = blendEnvironment({}, presets, view([['haze', 0.5], ['clear', 0.5]])).heightFog!;
    expect(mid.density).toBeCloseTo(0.03, 9);
    expect(mid.height).toBeCloseTo(5, 9);
    expect(mid.falloff).toBeCloseTo(0.075, 9);
    expect(mid.start).toBeCloseTo(10, 9);
    expect(mid.color).toBe(mixColors([['#ff0000', 0.5], ['#0000ff', 0.5]]));
    expect(mid.inscatterColor).toBe(mixColors([['#ffffff', 0.5], ['#000000', 0.5]]));
    // Towards a look without one (DAY: none): it thins, then is gone.
    expect(blendEnvironment({}, presets, view([['haze', 0.25], ['day', 0.75]])).heightFog!.density).toBeCloseTo(0.01, 9);
    expect(blendEnvironment({}, presets, view([['day', 1]])).heightFog).toBeUndefined();
    // The base look's height fog is a preset's without one.
    expect(blendEnvironment({ heightFog: { density: 0.01, color: '#00ff00' } }, presets, view([['day', 1]])).heightFog).toMatchObject({ density: 0.01, color: '#00ff00' });
    // A patch merges over the preset's.
    expect(blendEnvironment({}, presets, view([['p', 1]], { p: { preset: 'haze', patch: { heightFog: { density: 0.1 } as never } } })).heightFog).toMatchObject({ density: 0.1, color: '#ff0000', start: 20 });
  });

  it('lights: entries match by entity, tag or type; values blend, directions normalize', () => {
    const tags = new Map([['lamps', 3]]);
    const sun = { color: '#ffeedd', intensity: 1, direction: [0, -1, 0] as [number, number, number] };
    const who = { id: 'sun-1', tags: 0, type: 'directional' };
    const mid = blendLight(sun, who, tags, {}, PRESETS, view([['day', 0.5], ['night', 0.5]]));
    expect(mid.intensity).toBeCloseTo(1.1, 12);
    const d = mid.direction!;
    expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
    expect(d[0]).toBeCloseTo(Math.SQRT1_2, 12);
    // A lamp (tag bit 3) is matched only by the tag entry; the base keeps its authored values.
    const lamp = { color: '#ffaa55', intensity: 5 };
    expect(blendLight(lamp, { id: 'lamp-1', tags: 1 << 3, type: 'point' }, tags, {}, PRESETS, view([['night', 1]]))).toEqual({ color: '#ffaa55', intensity: 30 });
    expect(blendLight(lamp, { id: 'lamp-2', tags: 0, type: 'point' }, tags, {}, PRESETS, view([['night', 1]]))).toEqual(lamp);
    expect(blendLight(lamp, { id: 'lamp-1', tags: 1 << 3, type: 'point' }, tags, {}, PRESETS, view([['', 1]]))).toEqual(lamp);
  });

  it('an override patches its preset one level deep', () => {
    const x = blendEnvironment({}, PRESETS, view([['night~1', 1]], { 'night~1': { preset: 'night', patch: { fog: { color: '#ff0000' } as never, post: { grading: { contrast: 0.5 } } } } }));
    expect(x.fog).toMatchObject({ mode: 'linear', color: '#ff0000', near: 5, far: 40 });
    expect(x.post?.grading).toMatchObject({ contrast: 0.5, tint: '#a0b0ff' });
  });
});

describe('the environment director (simulation state)', () => {
  const make = (): { d: EnvironmentDirector; warnings: string[] } => {
    const warnings: string[] = [];
    return { d: new EnvironmentDirector(60, ['day', 'night'], (m) => warnings.push(m)), warnings };
  };

  it('is inert until used; a blend runs over whole steps from the look now', () => {
    const { d } = make();
    expect(d.view(1)).toBeNull();
    expect(d.digestText()).toBeNull();
    d.step();
    expect(d.api.set('night', { blend: 1 })).toBe(true);
    expect(d.api.state()).toEqual({ target: 'night', progress: 0, blending: true });
    for (let i = 0; i < 30; i += 1) d.step();
    expect(d.api.weight('night')).toBeCloseTo(0.5, 12);
    expect(d.api.weight('')).toBeCloseTo(0.5, 12);
    expect(d.view(1)!.weights).toEqual([['', 0.5], ['night', 0.5]]);
    // Interpolated between the last two steps.
    expect(d.view(0)!.weights[1]![1]).toBeCloseTo(29 / 60, 12);
    // Interrupted: day blends in from the half-way look.
    d.api.set('day', { blend: 0.5, easing: 'easeInOut' });
    for (let i = 0; i < 30; i += 1) d.step();
    expect(d.view(1)!.weights).toEqual([['day', 1]]);
    expect(d.api.state()).toEqual({ target: 'day', progress: 1, blending: false });
    // After the blend ended, a view at the same alpha shows the settled look (not the last blended pair).
    expect(d.view(0)!.weights).not.toEqual([['day', 1]]);
    d.step();
    expect(d.view(0)!.weights).toEqual([['day', 1]]);
  });

  it('holds a mix with blend(a, b, t); refuses unknown presets and bad options', () => {
    const { d, warnings } = make();
    expect(d.api.blend('day', 'night', 0.25)).toBe(true);
    d.step();
    expect(d.view(1)!.weights).toEqual([['day', 0.75], ['night', 0.25]]);
    expect(d.api.set('dusk')).toBe(false);
    expect(d.api.set('day', { blend: -1 })).toBe(false);
    expect(d.api.set('day', { easing: 'bounce' as never })).toBe(false);
    expect(d.api.set('day', { override: { fog: { density: 5 } } })).toBe(false);
    expect(warnings).toHaveLength(4);
    expect(d.api.presets()).toEqual(['day', 'night']);
  });

  it('an override is its own key while it has weight; save and restore reproduce the state', () => {
    const { d } = make();
    d.api.set('night', { blend: 0.5, override: { fog: { color: '#ff0000' } } });
    for (let i = 0; i < 10; i += 1) d.step();
    const v = d.view(1)!;
    expect(v.weights.map(([k]) => k)).toEqual(['', 'night~1']);
    expect(v.overrides['night~1']).toEqual({ preset: 'night', patch: { fog: { color: '#ff0000' } } });
    expect(d.api.weight('night')).toBeCloseTo(10 / 30, 12);
    const saved = JSON.parse(JSON.stringify(d.saveState()));
    const digest = d.digestText();
    const { d: e } = make();
    expect(e.checkState(saved)).toBeNull();
    e.restoreState(saved);
    expect(e.digestText()).toBe(digest);
    for (let i = 0; i < 25; i += 1) {
      d.step();
      e.step();
    }
    expect(e.digestText()).toBe(d.digestText());
    // The base look replaces the patched preset; once gone, its override is forgotten.
    d.api.set('', {});
    d.step();
    expect(d.view(1)!.weights).toEqual([['', 1]]);
    expect(Object.keys(d.view(1)!.overrides)).toEqual([]);
    expect(e.checkState({ weights: 'x' })).not.toBeNull();
    d.reset();
    expect(d.view(1)).toBeNull();
  });
});

describe('blending two scenes\' looks (a change of active scene)', () => {
  const A = { sky: { mode: 'color' as const, color: '#ff0000' }, fog: { mode: 'linear' as const, color: '#ffffff', near: 10, far: 50 } };
  const B = { sky: { mode: 'color' as const, color: '#0000ff' } };
  const base = { weights: [['', 1]] as [string, number][], overrides: {} };
  it('one scene at share 1 is that scene exactly; a part it leaves out is gone', () => {
    const only = blendEnvironmentOver([[A, 0], [B, 1]], new Map(), base);
    expect(only.sky).toEqual({ mode: 'color', color: '#0000ff', intensity: 1, environmentIntensity: 1 });
    expect(only.fog).toBeUndefined();
  });
  it('half way: the colours mix, the fog of the one scene thins, a preset lays over both', () => {
    const half = blendEnvironmentOver([[A, 0.5], [B, 0.5]], new Map(), base);
    expect(half.sky?.color).toBe(mixColors([['#ff0000', 0.5], ['#0000ff', 0.5]]));
    expect(half.fog?.mode).toBe('linear');
    expect(half.fog!.far!).toBeGreaterThan(50);
    const night = new Map([['night', { presetId: 'night', name: 'Night', post: { exposure: 0.5 } }]]) as never;
    const preset = blendEnvironmentOver([[A, 0.5], [B, 0.5]], night, { weights: [['night', 1]], overrides: {} });
    expect(preset.post?.exposure).toBe(0.5);
    expect(preset.sky?.color).toBe(half.sky?.color);
    // One base is blendEnvironment itself.
    expect(blendEnvironmentOver([[A, 1]], new Map(), base)).toEqual(blendEnvironment(A, new Map(), base));
  });
});
