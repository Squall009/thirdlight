/**
 * Phase 9.10: the game flow block — shape, bounds, canonical form and the
 * assets it names.
 */
import { describe, expect, it } from 'vitest';

import { canonicalFlow, flowAssetRefs, validateFlow, type GameFlow } from './flow';
import type { ModelErrorV2 } from './errors';

const FLOW: GameFlow = {
  levels: [
    { id: 'meadow-1', name: 'Meadow 1', scenes: ['scene-main', 'scene-m1'], spawnId: 'spawn-1', music: 'music-a' },
    { id: 'meadow-2', name: 'Meadow 2', scenes: ['scene-main', 'scene-m2'], spawnId: 'spawn-2' },
  ],
  lives: { start: 3, max: 5 },
  title: { subtitle: 'A tiny adventure', music: 'music-t' },
  hud: { preset: 'corners', timer: true },
  ui: { font: 'rounded', accent: '#ffcc00', panel: '#223344', text: '#ffffff', logo: 'logo-tex' },
  texts: { credits: 'Thanks for playing' },
  volumes: { music: 0.7, sfx: 1 },
};

const errorsOf = (v: unknown): ModelErrorV2[] => {
  const errors: ModelErrorV2[] = [];
  validateFlow(v, '/flow', errors);
  return errors;
};

describe('game flow', () => {
  it('accepts a full flow; canonical form is stable; the assets it names', () => {
    expect(errorsOf(FLOW)).toEqual([]);
    expect(canonicalFlow(JSON.parse(JSON.stringify(FLOW)) as GameFlow)).toEqual(FLOW);
    expect(flowAssetRefs(FLOW)).toEqual({ music: ['music-a', 'music-t'], textures: ['logo-tex'], menuSounds: [], ambience: [] });
    expect(errorsOf({ levels: [{ id: 'l1', name: 'One', scenes: ['s'], spawnId: 'sp' }] })).toEqual([]);
  });

  it('refuses bad shapes', () => {
    const codes = (v: unknown): string[] => errorsOf(v).map((e) => `${e.code} ${e.path}`);
    expect(codes({ levels: [] })).toEqual(['field_value /flow/levels']);
    expect(codes({ ...FLOW, levels: [FLOW.levels[0], FLOW.levels[0]] })).toEqual(['id_duplicate /flow/levels/1/id']);
    expect(codes({ ...FLOW, lives: { start: 4, max: 2 } })).toEqual(['field_value /flow/lives/max']);
    expect(codes({ ...FLOW, hud: { preset: 'fancy' } })).toEqual(['field_value /flow/hud/preset']);
    expect(codes({ ...FLOW, ui: { ...FLOW.ui, accent: 'yellow' } })).toEqual(['field_value /flow/ui/accent']);
    expect(codes({ ...FLOW, volumes: { music: 2, sfx: 1 } })).toEqual(['field_value /flow/volumes/music']);
    expect(codes({ ...FLOW, extra: 1 })).toEqual(['field_unexpected /flow/extra']);
    expect(codes({ levels: [{ id: 'l1', name: 'One', scenes: ['s', 's'], spawnId: 'sp' }] })).toEqual(['field_value /flow/levels/0/scenes']);
  });

  it('phase 14.4: a level look — shape checked, canonical, its images counted as flow textures', () => {
    const withLook = { ...FLOW, levels: [FLOW.levels[0]!, { ...FLOW.levels[1]!, environment: { sky: { mode: 'texture', texture: 'sky-tex' }, post: { grading: { lut: 'lut-tex', gamma: 1.2 } } } }] } as GameFlow;
    expect(errorsOf(withLook)).toEqual([]);
    expect(canonicalFlow(JSON.parse(JSON.stringify(withLook)) as GameFlow)).toEqual(withLook);
    expect(flowAssetRefs(withLook).textures).toEqual(['logo-tex', 'sky-tex', 'lut-tex']);
    const bad = { ...FLOW, levels: [{ ...FLOW.levels[0]!, environment: { sky: { mode: 'color', color: 'red' }, quality: 'low' } }] };
    expect(errorsOf(bad).map((e) => e.path)).toEqual(['/flow/levels/0/environment/quality', '/flow/levels/0/environment/sky/color']);
  });

  it('phase 14.3: score rules — shape, bounds, counters in name order in the canonical form', () => {
    const score = { points: { gems: 50, coins: 10, defeated: 100, hits: -5 }, timeBonus: { targetSeconds: 90, perSecond: 2.5 } };
    expect(errorsOf({ ...FLOW, score })).toEqual([]);
    const canon = canonicalFlow(JSON.parse(JSON.stringify({ ...FLOW, score })) as GameFlow);
    expect(Object.keys(canon.score!.points!)).toEqual(['coins', 'defeated', 'gems', 'hits']);
    expect(canon.score).toEqual(score);
    // Absent: no score key at all (existing projects stay byte-identical).
    expect('score' in canonicalFlow(FLOW)).toBe(false);
    expect(canonicalFlow({ ...FLOW, score: {} }).score).toEqual({});
    const codes = (v: unknown): string[] => errorsOf({ ...FLOW, score: v }).map((e) => `${e.code} ${e.path}`);
    expect(codes(5)).toEqual(['field_type /flow/score']);
    expect(codes({ extra: 1 })).toEqual(['field_unexpected /flow/score/extra']);
    expect(codes({ points: { coins: 1.5 } })).toEqual(['field_value /flow/score/points/coins']);
    expect(codes({ points: { '9lives': 1 } })).toEqual(['field_value /flow/score/points/9lives']);
    expect(codes({ points: { 'a/b': 1 } })).toEqual(['field_value /flow/score/points/a~1b']);
    expect(codes({ points: { coins: 2_000_000 } })).toEqual(['field_value /flow/score/points/coins']);
    expect(codes({ points: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, 1])) })).toEqual(['field_value /flow/score/points']);
    expect(codes({ timeBonus: { targetSeconds: 0, perSecond: 1 } })).toEqual(['field_value /flow/score/timeBonus/targetSeconds']);
    expect(codes({ timeBonus: { targetSeconds: 60, perSecond: -1 } })).toEqual(['field_value /flow/score/timeBonus/perSecond']);
    expect(codes({ timeBonus: { targetSeconds: 60 } })).toEqual(['field_value /flow/score/timeBonus/perSecond']);
  });

  it('phase 14.5: title background scene and pan, menu sounds, ui volume, level ambience', () => {
    const f = {
      ...FLOW,
      levels: [{ ...FLOW.levels[0]!, ambience: ['wind', 'birds'] }, { ...FLOW.levels[1]!, ambience: ['wind'] }],
      title: { ...FLOW.title, scene: 'scene-title', pan: { distance: -6, seconds: 25 } },
      volumes: { music: 0.7, sfx: 1, ui: 0.5 },
      sounds: { back: 'snd-back', move: 'snd-move' },
    } as GameFlow;
    expect(errorsOf(f)).toEqual([]);
    const canon = canonicalFlow(JSON.parse(JSON.stringify(f)) as GameFlow);
    expect(canon).toEqual(f);
    expect(Object.keys(canon.sounds!)).toEqual(['move', 'back']);
    expect(flowAssetRefs(f)).toMatchObject({ menuSounds: ['snd-move', 'snd-back'], ambience: ['wind', 'birds'] });
    // Absent: none of the new keys (existing projects stay byte-identical).
    const plain = canonicalFlow(FLOW);
    expect('sounds' in plain || 'ui' in plain.volumes! || 'scene' in plain.title! || 'ambience' in plain.levels[0]!).toBe(false);
    const codes = (v: Partial<GameFlow> | Record<string, unknown>): string[] => errorsOf({ ...FLOW, ...v }).map((e) => `${e.code} ${e.path}`);
    expect(codes({ title: { pan: { distance: 0, seconds: 10 } } })).toEqual(['field_value /flow/title/pan/distance']);
    expect(codes({ title: { pan: { distance: 500, seconds: 10 } } })).toEqual(['field_value /flow/title/pan/distance']);
    expect(codes({ title: { pan: { distance: 3, seconds: 1 } } })).toEqual(['field_value /flow/title/pan/seconds']);
    expect(codes({ title: { scene: '' } })).toEqual(['field_value /flow/title/scene']);
    expect(codes({ volumes: { music: 1, sfx: 1, ui: 3 } })).toEqual(['field_value /flow/volumes/ui']);
    expect(codes({ sounds: { beep: 'x' } })).toEqual(['field_unexpected /flow/sounds/beep']);
    expect(codes({ sounds: { move: '' } })).toEqual(['field_value /flow/sounds/move']);
    expect(codes({ levels: [{ ...FLOW.levels[0]!, ambience: [] }] })).toEqual(['field_value /flow/levels/0/ambience']);
    expect(codes({ levels: [{ ...FLOW.levels[0]!, ambience: ['a', 'a'] }] })).toEqual(['field_value /flow/levels/0/ambience']);
    expect(codes({ levels: [{ ...FLOW.levels[0]!, ambience: ['a', 'b', 'c', 'd', 'e'] }] })).toEqual(['field_value /flow/levels/0/ambience']);
  });
});
