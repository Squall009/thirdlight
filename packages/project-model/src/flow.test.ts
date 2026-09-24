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
    expect(flowAssetRefs(FLOW)).toEqual({ music: ['music-a', 'music-t'], textures: ['logo-tex'] });
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
});
